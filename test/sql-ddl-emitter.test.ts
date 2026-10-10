import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { EXIT_OK, runCli } from '../src/cliRunner.js';
import { convertText } from '../src/convert.js';
import {
  emitSqlDdl,
  quoteIdentifier,
  sqlDialectOf,
  sqlStringLiteral,
  type SqlDdlEmitOptions,
} from '../src/emitters/sqlDdl.js';
import type { PrismaProvider } from '../src/emitters/prisma.js';
import {
  describeFormats,
  getFormat,
  getFormatByExtension,
  listFormats,
} from '../src/formats.js';
import type { EmitOutput } from '../src/emitters/prisma.js';
import type { IrField, IrModel, IrSchema } from '../src/ir.js';
import { constructsSchema } from './drizzleFixtures.js';
import { checkSqlDdlOutput } from './sqlDdlCoverage.js';
import {
  STATUS,
  field,
  idField,
  index,
  kitchenSinkSchema,
  model,
  relation,
  schemaOf,
  stressSchema,
} from './gormFixtures.js';
import { convertCanonical, expectFilesMatchGolden } from './harness.js';
import { BLOG_FIXTURE_PATH, DEFAULT_OPTIONS, expectOk } from './helpers.js';
import { CANONICAL_FIXTURES } from './fixtures/canonical.js';
import { EXTRA_SOURCES, parseSource } from './realToolSupport.js';

const PROVIDERS: readonly PrismaProvider[] = [
  'postgresql',
  'mysql',
  'sqlite',
  'sqlserver',
];

function emit(
  schema: IrSchema,
  provider: PrismaProvider = 'postgresql',
  overrides: Partial<SqlDdlEmitOptions> = {}
): EmitOutput {
  return emitSqlDdl(schema, { provider, naming: 'preserve', ...overrides });
}

/** The SQL text of a schema. */
function sql(
  schema: IrSchema,
  provider: PrismaProvider = 'postgresql',
  overrides: Partial<SqlDdlEmitOptions> = {}
): string {
  return emit(schema, provider, overrides).text;
}

/** The SQL of one model "Thing" with the given fields (no id column unless one is passed). */
function thing(
  fields: IrField[],
  provider: PrismaProvider = 'postgresql',
  extra: Partial<IrModel> = {},
  enums: IrSchema['enums'] = []
): EmitOutput {
  return emit(
    schemaOf([model('Thing', { tableName: 'thing', fields, ...extra })], enums),
    provider
  );
}

/** The text of the first line that starts with the prefix (after trimming), without its comma. */
function lineOf(text: string, prefix: string): string {
  const found: string | undefined = text
    .split('\n')
    .map((line: string) => line.trim())
    .find((line: string) => line.startsWith(prefix));
  if (found === undefined) {
    throw new Error(`No line starts with "${prefix}" in:\n${text}`);
  }
  return found.replace(/,(?= --|$)/, '');
}

/** The column definition of "v" in the model "Thing", without comments. */
function column(
  overrides: Partial<IrField>,
  provider: PrismaProvider = 'postgresql',
  enums: IrSchema['enums'] = []
): string {
  return lineOf(
    thing([idField(), field('v', overrides)], provider, {}, enums).text,
    'v '
  ).replace(/ -- .*$/, '');
}

describe('SQL DDL emitter: the format', () => {
  it('registers the sql format, write only, for .sql files', () => {
    const adapter = expectOk(getFormat('sql'));
    expect(adapter.extensions).toEqual(['.sql']);
    expect(adapter.emit).toBeDefined();
    expect(getFormatByExtension('.sql')?.name).toBe('sql');
    expect(describeFormats(listFormats())).toMatch(
      /sql\s+extensions: \.sql\s+(read \+ )?write\s+SQL DDL/
    );
  });

  it('converts a source to one SQL text with the provider as the dialect', async () => {
    const result = expectOk(
      await convertText(
        [
          {
            path: 'schema.prisma',
            text: 'model Post {\n  id Int @id @default(autoincrement())\n  title String @db.VarChar(80)\n}\n',
          },
        ],
        { ...DEFAULT_OPTIONS, from: 'prisma', to: 'sql', provider: 'mysql' }
      )
    );
    expect(result.files).toBeUndefined();
    expect(result.output).toContain('-- SQL DDL for MySQL');
    expect(result.output).toContain('title VARCHAR(80) NOT NULL');
    expect(result.output).toContain('id INT NOT NULL AUTO_INCREMENT');
  });

  it('maps providers to dialects and warns about the two without SQL of their own', () => {
    expect(PROVIDERS.map((provider) => sqlDialectOf(provider))).toEqual([
      'postgresql',
      'mysql',
      'sqlite',
      'sqlserver',
    ]);
    expect(sqlDialectOf('cockroachdb')).toBe('postgresql');
    expect(sqlDialectOf('mongodb')).toBe('postgresql');
    const schema: IrSchema = schemaOf([model('Post')]);
    expect(emit(schema, 'mongodb').warnings).toEqual([
      'Provider "mongodb": MongoDB has no SQL schema; PostgreSQL DDL was written.',
    ]);
    expect(emit(schema, 'cockroachdb').warnings[0]).toContain('CockroachDB');
    expect(emit(schema, 'cockroachdb').text).toContain(
      '-- SQL DDL for PostgreSQL'
    );
  });

  it('writes only a header for an empty schema', () => {
    expect(sql(schemaOf([]))).toBe(
      '-- SQL DDL for PostgreSQL, generated by ormbridge.\n'
    );
  });
});

describe('SQL DDL emitter: identifiers and literals', () => {
  it.each([
    ['postgresql', 'post', 'post'],
    ['postgresql', 'Post', '"Post"'],
    ['postgresql', 'user', '"user"'],
    ['postgresql', 'a "b" c', '"a ""b"" c"'],
    ['mysql', 'order', '`order`'],
    ['mysql', 'a`b', '`a``b`'],
    ['mysql', 'MixedCase', '`MixedCase`'],
    ['sqlite', 'group', '"group"'],
    ['sqlite', 'first name', '"first name"'],
    ['sqlserver', 'table', '[table]'],
    ['sqlserver', 'a]b', '[a]]b]'],
    ['sqlserver', 'plain_name', 'plain_name'],
    ['postgresql', '1st', '"1st"'],
    ['mysql', 'blob', '`blob`'],
  ] as const)('quotes %s identifier %s as %s', (dialect, name, expected) => {
    expect(quoteIdentifier(dialect, name)).toBe(expected);
  });

  it.each([
    ['postgresql', "it's", "'it''s'"],
    ['sqlite', "it's", "'it''s'"],
    ['mysql', "it's \\ here", "'it''s \\\\ here'"],
    ['sqlserver', "it's", "N'it''s'"],
  ] as const)('escapes %s strings', (dialect, value, expected) => {
    expect(sqlStringLiteral(dialect, value)).toBe(expected);
  });

  it('quotes table and column names that are reserved words or not lower case', () => {
    const text: string = sql(
      schemaOf([
        model('User', {
          tableName: 'user',
          fields: [idField(), field('Order', { columnName: 'Order' })],
        }),
      ])
    );
    expect(text).toContain('CREATE TABLE "user" (');
    expect(text).toContain('"Order" TEXT');
    const mysql: string = sql(
      schemaOf([model('Group', { tableName: 'group' })]),
      'mysql'
    );
    expect(mysql).toContain('CREATE TABLE `group` (');
  });

  it('warns about names longer than the dialect allows', () => {
    const long: string = 'a'.repeat(70);
    const schema: IrSchema = schemaOf([
      model('Thing', {
        tableName: long,
        fields: [idField(), field('v', { columnName: 'b'.repeat(70) })],
      }),
    ]);
    expect(emit(schema, 'postgresql').warnings).toHaveLength(2);
    expect(emit(schema, 'mysql').warnings).toHaveLength(2);
    expect(emit(schema, 'sqlserver').warnings).toEqual([]);
    expect(emit(schema, 'sqlite').warnings).toEqual([]);
    // Generated constraint names are shortened to fit.
    const names: string[] = [
      ...sql(schema, 'postgresql').matchAll(/CONSTRAINT (\S+)/g),
    ].map((match) => match[1] ?? '');
    expect(names.every((name) => name.length <= 63)).toBe(true);
  });
});

describe('SQL DDL emitter: column types', () => {
  // [field, postgresql, mysql, sqlite, sqlserver] (the part after the column name, before NOT NULL)
  const TYPES: [string, Partial<IrField>, string, string, string, string][] = [
    [
      'string(30)',
      { type: 'string', maxLength: 30 },
      'VARCHAR(30)',
      'VARCHAR(30)',
      'VARCHAR(30)',
      'NVARCHAR(30)',
    ],
    [
      'string',
      { type: 'string' },
      'TEXT',
      'VARCHAR(255)',
      'TEXT',
      'NVARCHAR(255)',
    ],
    [
      'string(5000)',
      { type: 'string', maxLength: 5000 },
      'VARCHAR(5000)',
      'VARCHAR(5000)',
      'VARCHAR(5000)',
      'NVARCHAR(MAX)',
    ],
    ['text', { type: 'text' }, 'TEXT', 'LONGTEXT', 'TEXT', 'NVARCHAR(MAX)'],
    ['int', { type: 'int' }, 'INTEGER', 'INT', 'INTEGER', 'INT'],
    ['bigInt', { type: 'bigInt' }, 'BIGINT', 'BIGINT', 'BIGINT', 'BIGINT'],
    ['float', { type: 'float' }, 'DOUBLE PRECISION', 'DOUBLE', 'REAL', 'FLOAT'],
    [
      'decimal(10,2)',
      { type: 'decimal', maxDigits: 10, decimalPlaces: 2 },
      'NUMERIC(10, 2)',
      'DECIMAL(10, 2)',
      'DECIMAL(10, 2)',
      'DECIMAL(10, 2)',
    ],
    [
      'decimal(8)',
      { type: 'decimal', maxDigits: 8 },
      'NUMERIC(8)',
      'DECIMAL(8)',
      'DECIMAL(8)',
      'DECIMAL(8)',
    ],
    [
      'decimal',
      { type: 'decimal' },
      'NUMERIC',
      'DECIMAL(65, 30)',
      'NUMERIC',
      'DECIMAL(32, 16)',
    ],
    ['boolean', { type: 'boolean' }, 'BOOLEAN', 'BOOLEAN', 'BOOLEAN', 'BIT'],
    [
      'dateTime',
      { type: 'dateTime' },
      'TIMESTAMPTZ',
      'DATETIME(6)',
      'DATETIME',
      'DATETIME2',
    ],
    ['date', { type: 'date' }, 'DATE', 'DATE', 'DATE', 'DATE'],
    ['time', { type: 'time' }, 'TIME', 'TIME(6)', 'TIME', 'TIME'],
    [
      'uuid',
      { type: 'uuid' },
      'UUID',
      'CHAR(36)',
      'CHAR(36)',
      'UNIQUEIDENTIFIER',
    ],
    ['json', { type: 'json' }, 'JSONB', 'JSON', 'TEXT', 'NVARCHAR(MAX)'],
    ['bytes', { type: 'bytes' }, 'BYTEA', 'LONGBLOB', 'BLOB', 'VARBINARY(MAX)'],
    [
      'duration',
      { type: 'duration' },
      'INTERVAL',
      'BIGINT',
      'INTEGER',
      'BIGINT',
    ],
    [
      'ipAddress',
      { type: 'ipAddress' },
      'INET',
      'VARCHAR(45)',
      'TEXT',
      'VARCHAR(45)',
    ],
  ];

  it.each(TYPES)(
    '%s',
    (_label, overrides, postgresql, mysql, sqlite, sqlserver) => {
      const expected: Record<string, string> = {
        postgresql,
        mysql,
        sqlite,
        sqlserver,
      };
      for (const provider of PROVIDERS) {
        const written: string = column(overrides, provider);
        expect(
          written.startsWith(`v ${expected[provider]} `),
          `${provider}: ${written}`
        ).toBe(true);
      }
    }
  );

  it('writes the same type for a nullable column and says NULL only on SQL Server', () => {
    expect(column({ isNullable: true })).toBe('v TEXT');
    expect(column({ isNullable: true }, 'sqlserver')).toBe(
      'v NVARCHAR(255) NULL'
    );
    expect(column({})).toBe('v TEXT NOT NULL');
  });

  it('adds the CHECK constraints a dialect needs for JSON', () => {
    const json: IrField[] = [idField(), field('v', { type: 'json' })];
    expect(thing(json, 'sqlite').text).toContain(
      'CONSTRAINT thing_v_check CHECK (json_valid(v))'
    );
    expect(thing(json, 'sqlserver').text).toContain(
      'CONSTRAINT thing_v_check CHECK (ISJSON(v) = 1)'
    );
    expect(thing(json, 'postgresql').text).not.toContain('CHECK');
    expect(thing(json, 'mysql').text).not.toContain('CHECK');
  });

  it('writes arrays as type[] on PostgreSQL and as JSON, with a warning, elsewhere', () => {
    const fields: IrField[] = [
      idField(),
      field('v', { type: 'int', arrayDepth: 2 }),
    ];
    expect(lineOf(thing(fields).text, 'v ')).toBe('v INTEGER[][] NOT NULL');
    for (const provider of ['mysql', 'sqlite', 'sqlserver'] as const) {
      const output: EmitOutput = thing(fields, provider);
      expect(output.warnings).toEqual([
        expect.stringContaining('has no array column type'),
      ]);
    }
    expect(lineOf(thing(fields, 'mysql').text, 'v ')).toContain(
      'v JSON NOT NULL'
    );
  });

  it('writes hstore only on PostgreSQL, with its extension', () => {
    const fields: IrField[] = [idField(), field('v', { type: 'hstore' })];
    const postgres: string = thing(fields).text;
    expect(postgres).toContain('CREATE EXTENSION IF NOT EXISTS hstore;');
    expect(postgres).toContain('v HSTORE NOT NULL');
    const mysql: EmitOutput = thing(fields, 'mysql');
    expect(mysql.text).not.toContain('EXTENSION');
    expect(mysql.text).toContain('v JSON NOT NULL');
    expect(mysql.warnings[0]).toContain('hstore exists only on PostgreSQL');
  });

  it.each([
    ['int', 'INT4RANGE'],
    ['bigInt', 'INT8RANGE'],
    ['decimal', 'NUMRANGE'],
    ['date', 'DATERANGE'],
    ['dateTime', 'TSTZRANGE'],
  ] as const)('writes a %s range as %s on PostgreSQL', (rangeOf, type) => {
    expect(column({ type: 'range', rangeOf })).toBe(`v ${type} NOT NULL`);
    const output: EmitOutput = thing(
      [idField(), field('v', { type: 'range', rangeOf })],
      'sqlite'
    );
    expect(output.warnings[0]).toContain(
      'range columns exist only on PostgreSQL'
    );
  });

  it('writes an unsupported type as it is with a warning, or as text when unknown', () => {
    const known: EmitOutput = thing([
      idField(),
      field('v', { type: 'unsupported', unsupportedType: 'circle' }),
    ]);
    expect(known.text).toContain('v circle NOT NULL');
    expect(known.warnings[0]).toContain('"circle"');
    const unknown: EmitOutput = thing([
      idField(),
      field('v', { type: 'unsupported' }),
    ]);
    expect(unknown.text).toContain('v TEXT NOT NULL');
    expect(unknown.warnings).toHaveLength(1);
  });

  it('uses a Prisma native type when the dialect has one of that name', () => {
    expect(column({ nativeType: { name: 'VarChar', args: ['120'] } })).toBe(
      'v VARCHAR(120) NOT NULL'
    );
    expect(
      column({
        type: 'dateTime',
        nativeType: { name: 'Timestamp', args: ['3'] },
      })
    ).toBe('v TIMESTAMP(3) NOT NULL');
    expect(
      column({ type: 'string', nativeType: { name: 'Uuid', args: [] } })
    ).toBe('v UUID NOT NULL');
    expect(
      column(
        { type: 'int', nativeType: { name: 'UnsignedInt', args: [] } },
        'mysql'
      )
    ).toBe('v INT UNSIGNED NOT NULL');
    expect(
      column(
        { type: 'text', nativeType: { name: 'NVarChar', args: ['Max'] } },
        'sqlserver'
      )
    ).toBe('v NVARCHAR(MAX) NOT NULL');
    // TEXT is deprecated on SQL Server.
    expect(
      column(
        { type: 'text', nativeType: { name: 'Text', args: [] } },
        'sqlserver'
      )
    ).toBe('v NVARCHAR(MAX) NOT NULL');
    // A native type of another database family is ignored.
    expect(
      column(
        {
          type: 'string',
          maxLength: 10,
          nativeType: { name: 'Uuid', args: [] },
        },
        'mysql'
      )
    ).toBe('v VARCHAR(10) NOT NULL');
    expect(
      column({ type: 'int', nativeType: { name: 'Int', args: [] } }, 'sqlite')
    ).toBe('v INTEGER NOT NULL');
  });

  it('clamps decimals that exceed the dialect and warns', () => {
    const fields: IrField[] = [
      idField(),
      field('v', { type: 'decimal', maxDigits: 70, decimalPlaces: 40 }),
    ];
    expect(thing(fields, 'mysql').text).toContain('v DECIMAL(65, 30) NOT NULL');
    expect(thing(fields, 'mysql').warnings).toHaveLength(2);
    expect(thing(fields, 'sqlserver').text).toContain(
      'v DECIMAL(38, 38) NOT NULL'
    );
    expect(thing(fields, 'postgresql').warnings).toEqual([]);
  });

  it('writes a very long MySQL string as LONGTEXT', () => {
    const output: EmitOutput = thing(
      [idField(), field('v', { type: 'string', maxLength: 20000 })],
      'mysql'
    );
    expect(output.text).toContain('v LONGTEXT NOT NULL');
    expect(output.warnings[0]).toContain('does not fit a MySQL row');
  });

  it('warns about a column with an unknown type', () => {
    const output: EmitOutput = thing([
      idField(),
      field('v', { type: 'mystery' as never }),
    ]);
    expect(output.text).toContain('v TEXT NOT NULL');
    expect(output.warnings[0]).toContain('unknown field type "mystery"');
  });

  it('writes a generated column as a regular one with a comment and a warning', () => {
    const output: EmitOutput = thing([
      idField(),
      field('v', {
        type: 'int',
        generated: { expression: 'F("a") + 1', isStored: true },
      }),
    ]);
    expect(output.text).toContain(
      'v INTEGER NOT NULL, -- generated column written as a regular column'
    );
    expect(output.warnings[0]).toContain('is not SQL');
  });
});

describe('SQL DDL emitter: defaults', () => {
  const NOW: [string, Partial<IrField>, string, string, string, string][] = [
    [
      'dateTime',
      { type: 'dateTime' },
      'now()',
      'CURRENT_TIMESTAMP(6)',
      'CURRENT_TIMESTAMP',
      'SYSUTCDATETIME()',
    ],
    [
      'date',
      { type: 'date' },
      'CURRENT_DATE',
      '(CURRENT_DATE)',
      'CURRENT_DATE',
      '(CAST(SYSUTCDATETIME() AS DATE))',
    ],
    [
      'time',
      { type: 'time' },
      'CURRENT_TIME',
      '(CURRENT_TIME)',
      'CURRENT_TIME',
      '(CAST(SYSUTCDATETIME() AS TIME))',
    ],
  ];

  it.each(NOW)(
    'writes a now default on a %s column',
    (_label, overrides, postgresql, mysql, sqlite, sqlserver) => {
      const expected: Record<string, string> = {
        postgresql,
        mysql,
        sqlite,
        sqlserver,
      };
      for (const provider of PROVIDERS) {
        expect(
          column({ ...overrides, default: { kind: 'now' } }, provider)
        ).toMatch(
          new RegExp(`DEFAULT ${expected[provider]?.replace(/[()]/g, '\\$&')}$`)
        );
      }
    }
  );

  it('drops a now default on a column that is not a date or time', () => {
    const output: EmitOutput = thing([
      idField(),
      field('v', { type: 'int', default: { kind: 'now' } }),
    ]);
    expect(output.text).toContain('v INTEGER NOT NULL');
    expect(output.warnings).toEqual([
      'Thing.v: a "now" default on a int column cannot be written; the default was dropped.',
    ]);
  });

  it('writes a UUID default per dialect and drops it on other types', () => {
    expect(column({ type: 'uuid', default: { kind: 'uuid' } })).toBe(
      'v UUID NOT NULL DEFAULT gen_random_uuid()'
    );
    expect(column({ type: 'uuid', default: { kind: 'uuid' } }, 'mysql')).toBe(
      'v CHAR(36) NOT NULL DEFAULT (UUID())'
    );
    expect(
      column({ type: 'uuid', default: { kind: 'uuid' } }, 'sqlserver')
    ).toBe('v UNIQUEIDENTIFIER NOT NULL DEFAULT NEWID()');
    expect(
      column({ type: 'uuid', default: { kind: 'uuid' } }, 'sqlite')
    ).toMatch(
      /^v CHAR\(36\) NOT NULL DEFAULT \(lower\(hex\(randomblob\(4\)\).*randomblob\(6\)\)\)\)$/
    );
    const dropped: EmitOutput = thing([
      idField(),
      field('v', { type: 'int', default: { kind: 'uuid' } }),
    ]);
    expect(dropped.warnings[0]).toContain('a UUID default on a int column');
  });

  it('writes literal defaults of every type', () => {
    expect(
      column({ type: 'int', default: { kind: 'literal', value: 7 } })
    ).toBe('v INTEGER NOT NULL DEFAULT 7');
    expect(
      column({ type: 'int', default: { kind: 'literal', value: '-3' } })
    ).toBe('v INTEGER NOT NULL DEFAULT -3');
    expect(
      column({ type: 'float', default: { kind: 'literal', value: 0.5 } })
    ).toContain('DEFAULT 0.5');
    expect(
      column({
        type: 'decimal',
        maxDigits: 5,
        decimalPlaces: 2,
        default: { kind: 'literal', value: '9.99' },
      })
    ).toContain('DEFAULT 9.99');
    expect(
      column({ type: 'string', default: { kind: 'literal', value: "it's" } })
    ).toBe("v TEXT NOT NULL DEFAULT 'it''s'");
    expect(
      column(
        { type: 'string', default: { kind: 'literal', value: 'a\\b' } },
        'mysql'
      )
    ).toContain("DEFAULT 'a\\\\b'");
    expect(
      column(
        { type: 'string', default: { kind: 'literal', value: 'x' } },
        'sqlserver'
      )
    ).toContain("DEFAULT N'x'");
    expect(
      column({ type: 'string', default: { kind: 'literal', value: 12 } })
    ).toContain("DEFAULT '12'");
  });

  it('writes boolean defaults per dialect', () => {
    const on: Partial<IrField> = {
      type: 'boolean',
      default: { kind: 'literal', value: true },
    };
    const off: Partial<IrField> = {
      type: 'boolean',
      default: { kind: 'literal', value: 'false' },
    };
    expect(column(on)).toContain('DEFAULT TRUE');
    expect(column(off)).toContain('DEFAULT FALSE');
    expect(column(on, 'mysql')).toContain('DEFAULT TRUE');
    expect(column(on, 'sqlite')).toContain('DEFAULT 1');
    expect(column(off, 'sqlserver')).toContain('DEFAULT 0');
    expect(
      column(
        { type: 'boolean', default: { kind: 'literal', value: '1' } },
        'sqlite'
      )
    ).toContain('DEFAULT 1');
  });

  it('writes JSON defaults, wrapping them in parentheses where MySQL needs it', () => {
    const json: Partial<IrField> = {
      type: 'json',
      default: { kind: 'literal', value: '{"a": 1}' },
    };
    expect(column(json)).toBe(`v JSONB NOT NULL DEFAULT '{"a":1}'::jsonb`);
    expect(column(json, 'mysql')).toBe(`v JSON NOT NULL DEFAULT ('{"a":1}')`);
    expect(column(json, 'sqlite')).toBe(`v TEXT NOT NULL DEFAULT '{"a":1}'`);
    expect(
      column(
        { type: 'text', default: { kind: 'literal', value: 'hi' } },
        'mysql'
      )
    ).toBe("v LONGTEXT NOT NULL DEFAULT ('hi')");
  });

  it('writes date-time defaults in the form each database accepts', () => {
    const when: Partial<IrField> = {
      type: 'dateTime',
      default: { kind: 'literal', value: '2020-05-06T07:08:09Z' },
    };
    expect(column(when)).toContain("DEFAULT '2020-05-06T07:08:09.000Z'");
    expect(column(when, 'mysql')).toContain("DEFAULT '2020-05-06 07:08:09'");
    expect(column(when, 'sqlite')).toContain("DEFAULT '2020-05-06 07:08:09'");
    expect(column(when, 'sqlserver')).toContain(
      "DEFAULT '2020-05-06T07:08:09.000'"
    );
  });

  it('writes array defaults as PostgreSQL array literals and as JSON elsewhere', () => {
    const tags: Partial<IrField> = {
      type: 'string',
      arrayDepth: 1,
      default: { kind: 'literal', value: '["a","b\\"c"]' },
    };
    expect(column(tags)).toBe(`v TEXT[] NOT NULL DEFAULT '{"a","b\\"c"}'`);
    expect(column(tags, 'sqlite')).toContain(`DEFAULT '["a","b\\"c"]'`);
  });

  it('drops defaults it cannot write and says why', () => {
    const cases: [Partial<IrField>, string][] = [
      [
        { type: 'int', default: { kind: 'literal', value: 'abc' } },
        'is not a number',
      ],
      [
        { type: 'boolean', default: { kind: 'literal', value: 'maybe' } },
        'is not a boolean',
      ],
      [
        { type: 'dateTime', default: { kind: 'literal', value: 'soon' } },
        'is not a date',
      ],
      [
        { type: 'json', default: { kind: 'literal', value: '{oops' } },
        'is not JSON',
      ],
      [
        { type: 'bytes', default: { kind: 'literal', value: 'x' } },
        'binary column',
      ],
      [
        {
          type: 'range',
          rangeOf: 'int',
          default: { kind: 'literal', value: '[1,2)' },
        },
        'range default',
      ],
      [
        {
          type: 'string',
          arrayDepth: 1,
          default: { kind: 'literal', value: 'not json' },
        },
        'array default',
      ],
      [
        {
          type: 'string',
          default: { kind: 'clientGenerated', generator: 'cuid' },
        },
        'cuid() default is generated by the ORM client',
      ],
      [
        {
          type: 'string',
          default: {
            kind: 'dbExpression',
            expression: 'auto()',
            isFunction: true,
          },
        },
        'auto() default function',
      ],
    ];
    for (const [overrides, reason] of cases) {
      const output: EmitOutput = thing([idField(), field('v', overrides)]);
      expect(lineOf(output.text, 'v '), reason).not.toContain('DEFAULT');
      expect(output.warnings, reason).toEqual([
        expect.stringContaining(reason),
      ]);
    }
  });

  it('writes enum defaults by member name or stored value', () => {
    const byName: string = column(
      { enumName: 'Status', default: { kind: 'enumValue', value: 'LIVE' } },
      'postgresql',
      [STATUS]
    );
    expect(byName).toBe(`v "Status" NOT NULL DEFAULT 'live'`);
    expect(
      column(
        { enumName: 'Status', default: { kind: 'literal', value: 'draft' } },
        'mysql',
        [STATUS]
      )
    ).toBe(`v ENUM('draft', 'live') NOT NULL DEFAULT 'draft'`);
    const unknown: EmitOutput = thing(
      [
        idField(),
        field('v', {
          enumName: 'Status',
          default: { kind: 'enumValue', value: 'GONE' },
        }),
      ],
      'postgresql',
      {},
      [STATUS]
    );
    expect(unknown.warnings[0]).toContain('does not match a member');
  });

  it('translates well-known database expressions and writes others as they are', () => {
    const uuid: Partial<IrField> = {
      type: 'uuid',
      default: { kind: 'dbExpression', expression: 'gen_random_uuid()' },
    };
    expect(column(uuid)).toBe('v UUID NOT NULL DEFAULT gen_random_uuid()');
    expect(column(uuid, 'mysql')).toBe('v CHAR(36) NOT NULL DEFAULT (UUID())');
    expect(
      column(
        {
          type: 'dateTime',
          default: { kind: 'dbExpression', expression: 'CURRENT_TIMESTAMP' },
        },
        'sqlserver'
      )
    ).toContain('DEFAULT SYSUTCDATETIME()');
    const custom: EmitOutput = thing([
      idField(),
      field('v', {
        type: 'int',
        default: { kind: 'dbExpression', expression: '1 + 1' },
      }),
    ]);
    expect(custom.text).toContain('v INTEGER NOT NULL DEFAULT (1 + 1)');
    expect(custom.warnings[0]).toContain('was written as it is');
  });

  it('keeps MySQL fractional seconds in step with the column it fills', () => {
    expect(
      column(
        {
          type: 'dateTime',
          default: { kind: 'now' },
          nativeType: { name: 'DateTime', args: ['3'] },
        },
        'mysql'
      )
    ).toBe('v DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)');
    expect(
      column(
        {
          type: 'dateTime',
          default: { kind: 'now' },
          nativeType: { name: 'DateTime', args: [] },
        },
        'mysql'
      )
    ).toBe('v DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP');
  });

  it('handles auto-updated columns: ON UPDATE on MySQL, one warning elsewhere', () => {
    const fields: IrField[] = [
      idField(),
      field('a', { type: 'dateTime', isAutoUpdated: true }),
      field('b', { type: 'dateTime', isAutoUpdated: true }),
    ];
    const mysql: EmitOutput = thing(fields, 'mysql');
    expect(mysql.text).toContain(
      'a DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6)'
    );
    expect(mysql.warnings).toEqual([]);
    for (const provider of ['postgresql', 'sqlite', 'sqlserver'] as const) {
      const output: EmitOutput = thing(fields, provider);
      expect(output.text).not.toContain('ON UPDATE');
      expect(output.warnings).toEqual([
        expect.stringContaining('(Thing.a, Thing.b)'),
      ]);
    }
  });
});

describe('SQL DDL emitter: keys and constraints', () => {
  it('writes an auto-increment key per dialect', () => {
    const key = (type: 'int' | 'bigInt', provider: PrismaProvider): string =>
      lineOf(thing([idField({ type })], provider).text, 'id ');
    expect(key('int', 'postgresql')).toBe(
      'id INTEGER GENERATED BY DEFAULT AS IDENTITY NOT NULL'
    );
    expect(key('bigInt', 'postgresql')).toBe(
      'id BIGINT GENERATED BY DEFAULT AS IDENTITY NOT NULL'
    );
    expect(key('int', 'mysql')).toBe('id INT NOT NULL AUTO_INCREMENT');
    expect(key('bigInt', 'mysql')).toBe('id BIGINT NOT NULL AUTO_INCREMENT');
    expect(key('int', 'sqlserver')).toBe('id INT IDENTITY(1,1) NOT NULL');
    expect(key('bigInt', 'sqlserver')).toBe('id BIGINT IDENTITY(1,1) NOT NULL');
    // SQLite: INTEGER PRIMARY KEY is the only column that may AUTOINCREMENT, even for a bigInt.
    expect(key('int', 'sqlite')).toBe('id INTEGER PRIMARY KEY AUTOINCREMENT');
    expect(key('bigInt', 'sqlite')).toBe(
      'id INTEGER PRIMARY KEY AUTOINCREMENT'
    );
    expect(thing([idField()], 'sqlite').text).not.toContain(
      'CONSTRAINT thing_pkey'
    );
  });

  it('names the primary key and writes a composite key', () => {
    const output: EmitOutput = emit(
      schemaOf([
        model('A', { tableName: 'a', fields: [idField()] }),
        model('Link', {
          tableName: 'link',
          fields: [field('role', { maxLength: 5 })],
          relations: [relation('a', 'A')],
          compositePrimaryKey: ['a', 'role'],
          primaryKeyName: 'link_pk',
        }),
      ])
    );
    expect(output.text).toContain(
      'CONSTRAINT link_pk PRIMARY KEY (a_id, role)'
    );
    expect(output.text).toContain('a_id INTEGER NOT NULL,');
  });

  it('keeps a composite key containing an auto-increment column when SQLite cannot', () => {
    const fields: IrField[] = [idField(), field('b', { type: 'int' })];
    const mysql: EmitOutput = thing(fields, 'mysql', {
      compositePrimaryKey: ['id', 'b'],
    });
    expect(mysql.text).toContain('id INT NOT NULL AUTO_INCREMENT');
    const sqlite: EmitOutput = thing(fields, 'sqlite', {
      compositePrimaryKey: ['id', 'b'],
    });
    expect(sqlite.text).toContain('id INTEGER NOT NULL,');
    expect(sqlite.text).toContain('PRIMARY KEY (id, b)');
    expect(sqlite.warnings[0]).toContain(
      'SQLite can auto-increment only a single-column integer primary key'
    );
  });

  it('drops an auto-increment default on a column that is not an integer', () => {
    const output: EmitOutput = thing([
      field('id', {
        type: 'uuid',
        isPrimaryKey: true,
        default: { kind: 'autoIncrement' },
      }),
    ]);
    expect(output.text).toContain('id UUID NOT NULL,');
    expect(output.warnings[0]).toContain(
      'auto-increment default on a uuid column'
    );
  });

  it('writes UNIQUE constraints named after the table and column (or the source name)', () => {
    const output: EmitOutput = thing([
      idField(),
      field('email', { maxLength: 40, isUnique: true }),
      field('slug', { maxLength: 40, isUnique: true, uniqueName: 'uq_slug' }),
    ]);
    expect(output.text).toContain('CONSTRAINT thing_email_key UNIQUE (email)');
    expect(output.text).toContain('CONSTRAINT uq_slug UNIQUE (slug)');
  });

  it('writes a one-to-one relation as a foreign key with UNIQUE, unless it is the key', () => {
    const output: EmitOutput = emit(
      schemaOf([
        model('User', { tableName: 'user' }),
        model('Profile', {
          tableName: 'profile',
          fields: [],
          relations: [
            relation('user', 'User', { kind: 'oneToOne', isPrimaryKey: true }),
          ],
        }),
        model('Card', {
          tableName: 'card',
          relations: [relation('user', 'User', { kind: 'oneToOne' })],
        }),
      ])
    );
    expect(lineOf(output.text, 'CONSTRAINT profile_pkey')).toBe(
      'CONSTRAINT profile_pkey PRIMARY KEY (user_id)'
    );
    expect(output.text).not.toContain('profile_user_id_key');
    expect(output.text).toContain(
      'CONSTRAINT card_user_id_key UNIQUE (user_id)'
    );
  });

  it('keeps a unique column unique on SQL Server despite NULLs', () => {
    const output: EmitOutput = thing(
      [
        idField(),
        field('code', { maxLength: 10, isUnique: true, isNullable: true }),
      ],
      'sqlserver'
    );
    expect(output.text).not.toContain('UNIQUE (code)');
    expect(output.text).toContain(
      'CREATE UNIQUE INDEX thing_code_key ON thing (code) WHERE code IS NOT NULL;'
    );
    const other: EmitOutput = thing(
      [
        idField(),
        field('code', { maxLength: 10, isUnique: true, isNullable: true }),
      ],
      'postgresql'
    );
    expect(other.text).toContain('CONSTRAINT thing_code_key UNIQUE (code)');
  });

  it('prefixes unique TEXT columns on MySQL and warns', () => {
    const output: EmitOutput = thing(
      [idField(), field('body', { type: 'text', isUnique: true })],
      'mysql'
    );
    expect(output.text).toContain('UNIQUE (body(255))');
    expect(output.warnings[0]).toContain(
      'covers only its first 255 characters'
    );
    const sqlserver: EmitOutput = thing(
      [idField(), field('body', { type: 'text', isUnique: true })],
      'sqlserver'
    );
    expect(sqlserver.text).not.toContain('UNIQUE');
    expect(sqlserver.warnings[0]).toContain(
      'cannot index the column "body" (its type is unbounded or JSON); the unique constraint was skipped'
    );
  });

  it('skips an index on a column the database cannot index', () => {
    const fields: IrField[] = [idField(), field('doc', { type: 'json' })];
    const mysql: EmitOutput = thing(fields, 'mysql', {
      indexes: [index(['doc'])],
    });
    expect(mysql.text).not.toContain('CREATE INDEX');
    expect(mysql.warnings).toEqual([
      expect.stringContaining('cannot index the column "doc"'),
    ]);
    expect(
      thing(fields, 'sqlserver', { indexes: [index(['doc'])] }).text
    ).not.toContain('CREATE INDEX');
    expect(
      thing(fields, 'postgresql', { indexes: [index(['doc'])] }).text
    ).toContain('CREATE INDEX thing_doc_idx ON thing (doc);');
  });

  it('writes a model without a key', () => {
    const output: EmitOutput = thing([field('v', { type: 'int' })]);
    expect(output.text).toContain(
      'CREATE TABLE thing (\n  v INTEGER NOT NULL\n);'
    );
  });
});

describe('SQL DDL emitter: indexes', () => {
  const WITH_INDEXES: IrModel['indexes'] = [
    index(['a']),
    index(['a', 'b'], { isUnique: true }),
    index(['b'], { name: 'named_idx' }),
  ];

  function indexed(
    provider: PrismaProvider,
    indexes: IrModel['indexes']
  ): EmitOutput {
    return thing(
      [idField(), field('a', { maxLength: 10 }), field('b', { maxLength: 10 })],
      provider,
      { indexes }
    );
  }

  it('writes CREATE [UNIQUE] INDEX statements right after the table', () => {
    const text: string = indexed('postgresql', WITH_INDEXES).text;
    expect(text).toContain(
      ');\nCREATE INDEX thing_a_idx ON thing (a);\nCREATE UNIQUE INDEX thing_a_b_key ON thing (a, b);\nCREATE INDEX named_idx ON thing (b);\n'
    );
  });

  it('writes sort order, a PostgreSQL access method and operator class', () => {
    const text: string = indexed('postgresql', [
      index(['a', 'b'], {
        method: 'Gin',
        fieldOptions: {
          a: { sort: 'desc' },
          b: { ops: 'raw("gin_trgm_ops")' },
        },
      }),
      index(['a'], { fieldOptions: { a: { ops: 'JsonbPathOps' } } }),
    ]).text;
    expect(text).toContain('USING gin (a DESC, b gin_trgm_ops)');
    expect(text).toContain('ON thing (a jsonb_path_ops)');
  });

  it('writes MySQL prefix lengths, USING and FULLTEXT', () => {
    const text: string = indexed('mysql', [
      index(['a'], { fieldOptions: { a: { length: 5 } }, method: 'Hash' }),
      index(['a', 'b'], { kind: 'fulltext' }),
    ]).text;
    expect(text).toContain(
      'CREATE INDEX thing_a_idx ON thing (a(5)) USING HASH;'
    );
    expect(text).toContain(
      'CREATE FULLTEXT INDEX thing_a_b_idx ON thing (a, b);'
    );
  });

  it('writes a PostgreSQL full-text index over the columns and warns elsewhere', () => {
    const fulltext = [index(['a', 'b'], { kind: 'fulltext' })];
    expect(indexed('postgresql', fulltext).text).toContain(
      "CREATE INDEX thing_a_b_idx ON thing USING gin (to_tsvector('simple', coalesce(a::text, '') || ' ' || coalesce(b::text, '')));"
    );
    const sqlite: EmitOutput = indexed('sqlite', fulltext);
    expect(sqlite.text).toContain(
      'CREATE INDEX thing_a_b_idx ON thing (a, b);'
    );
    expect(sqlite.warnings[0]).toContain(
      'full-text search needs a separate mechanism'
    );
  });

  it('writes SQL Server clustered indexes and drops options a dialect lacks', () => {
    expect(
      indexed('sqlserver', [index(['a'], { clustered: false })]).text
    ).toContain('CREATE NONCLUSTERED INDEX thing_a_idx ON thing (a);');
    expect(
      indexed('sqlserver', [index(['a'], { clustered: true, isUnique: true })])
        .text
    ).toContain('CREATE UNIQUE CLUSTERED INDEX');
    const dropped: EmitOutput = indexed('sqlite', [
      index(['a'], {
        clustered: true,
        method: 'Hash',
        fieldOptions: { a: { length: 3, ops: 'Foo' } },
      }),
    ]);
    expect(dropped.warnings).toHaveLength(4);
    expect(dropped.text).toContain('CREATE INDEX thing_a_idx ON thing (a);');
  });

  it('does not warn about a B-tree index, which every database builds anyway', () => {
    expect(
      indexed('sqlserver', [index(['a'], { method: 'BTree' })]).warnings
    ).toEqual([]);
    expect(
      indexed('postgresql', [index(['a'], { method: 'BTree' })]).text
    ).toContain('ON thing USING btree (a);');
  });

  it('skips an index on a column the model does not have', () => {
    const output: EmitOutput = indexed('postgresql', [index(['gone'])]);
    expect(output.text).not.toContain('CREATE INDEX');
    expect(output.warnings[0]).toContain('"gone", which is not a field');
  });

  it('keeps index names unique across tables', () => {
    const output: EmitOutput = emit(
      schemaOf([
        model('A', {
          tableName: 'a',
          fields: [idField(), field('x')],
          indexes: [index(['x'], { name: 'same' })],
        }),
        model('B', {
          tableName: 'b',
          fields: [idField(), field('x')],
          indexes: [index(['x'], { name: 'same' })],
        }),
      ])
    );
    expect(output.text).toContain('CREATE INDEX same ON a (x);');
    expect(output.text).toContain('CREATE INDEX same_2 ON b (x);');
  });

  it('indexes the column of a relation by the relation name', () => {
    const output: EmitOutput = emit(
      schemaOf([
        model('A', { tableName: 'a' }),
        model('B', {
          tableName: 'b',
          relations: [relation('a', 'A')],
          indexes: [index(['a'])],
        }),
      ])
    );
    expect(output.text).toContain('CREATE INDEX b_a_id_idx ON b (a_id);');
  });
});

describe('SQL DDL emitter: foreign keys', () => {
  function pair(overrides: Parameters<typeof relation>[2] = {}): IrSchema {
    return schemaOf([
      model('Parent', { tableName: 'parent' }),
      model('Child', {
        tableName: 'child',
        relations: [relation('parent', 'Parent', overrides)],
      }),
    ]);
  }

  it.each([
    ['cascade', ' ON DELETE CASCADE'],
    ['setNull', ' ON DELETE SET NULL'],
    ['restrict', ' ON DELETE RESTRICT'],
    ['noAction', ''],
    ['setDefault', ' ON DELETE SET DEFAULT'],
  ] as const)(
    'writes onDelete %s on PostgreSQL as "%s"',
    (onDelete, clause) => {
      expect(
        sql(pair({ onDelete, isNullable: onDelete === 'setNull' }))
      ).toContain(`REFERENCES parent (id)${clause}\n`);
    }
  );

  it('writes ON UPDATE, and leaves NO ACTION out', () => {
    expect(sql(pair({ onUpdate: 'cascade' }))).toContain(
      'REFERENCES parent (id) ON DELETE CASCADE ON UPDATE CASCADE'
    );
    expect(sql(pair({ onUpdate: 'noAction' }))).not.toContain('ON UPDATE');
  });

  it('writes RESTRICT as NO ACTION on SQL Server, which has no RESTRICT', () => {
    expect(sql(pair({ onDelete: 'restrict' }), 'sqlserver')).toContain(
      'REFERENCES parent (id)\n'
    );
  });

  it('leaves SET DEFAULT out on MySQL and warns', () => {
    const output: EmitOutput = emit(pair({ onDelete: 'setDefault' }), 'mysql');
    expect(output.text).toContain('REFERENCES parent (id)\n');
    expect(output.warnings).toEqual([
      'Child.parent: MySQL (InnoDB) does not support ON DELETE SET DEFAULT; the action was left at the default (NO ACTION).',
    ]);
  });

  it('warns about SET NULL on a required relation', () => {
    expect(emit(pair({ onDelete: 'setNull' })).warnings[0]).toContain(
      'onDelete SET NULL on a required relation'
    );
  });

  it('names the key after the constraint of the source', () => {
    expect(sql(pair({ constraintName: 'fk_custom' }))).toContain(
      'CONSTRAINT fk_custom FOREIGN KEY'
    );
  });

  it('copies the type of the referenced column, including a UUID or string key', () => {
    const output: EmitOutput = emit(
      schemaOf([
        model('Parent', {
          tableName: 'parent',
          fields: [field('code', { maxLength: 8, isPrimaryKey: true })],
        }),
        model('Child', {
          tableName: 'child',
          relations: [
            relation('parent', 'Parent', { columnName: 'parent_code' }),
          ],
        }),
        model('Other', {
          tableName: 'other',
          fields: [
            field('id', {
              type: 'uuid',
              isPrimaryKey: true,
              default: { kind: 'uuid' },
            }),
          ],
        }),
        model('Third', {
          tableName: 'third',
          relations: [relation('other', 'Other')],
        }),
      ])
    );
    expect(output.text).toContain('parent_code VARCHAR(8) NOT NULL');
    expect(output.text).toContain('other_id UUID NOT NULL,');
  });

  it('points at a column named by toField', () => {
    const output: EmitOutput = emit(
      schemaOf([
        model('Parent', {
          tableName: 'parent',
          fields: [idField(), field('slug', { maxLength: 12, isUnique: true })],
        }),
        model('Child', {
          tableName: 'child',
          relations: [
            relation('parent', 'Parent', {
              toField: 'slug',
              columnName: 'parent_slug',
            }),
          ],
        }),
      ])
    );
    expect(output.text).toContain('parent_slug VARCHAR(12) NOT NULL');
    expect(output.text).toContain('REFERENCES parent (slug)');
    expect(output.warnings).toEqual([]);
  });

  it('warns when the referenced column is not unique', () => {
    const output: EmitOutput = emit(
      schemaOf([
        model('Parent', {
          tableName: 'parent',
          fields: [idField(), field('slug', { maxLength: 12 })],
        }),
        model('Child', {
          tableName: 'child',
          relations: [
            relation('parent', 'Parent', {
              toField: 'slug',
              columnName: 'parent_slug',
            }),
          ],
        }),
      ])
    );
    expect(output.warnings).toEqual([
      expect.stringContaining('is not a primary key or unique'),
    ]);
  });

  it('follows a chain of keys that are relations (multi-table inheritance)', () => {
    const output: EmitOutput = emit(
      schemaOf([
        model('Base', {
          tableName: 'base',
          fields: [idField({ type: 'bigInt' })],
        }),
        model('Mid', {
          tableName: 'mid',
          fields: [],
          relations: [
            relation('base', 'Base', { kind: 'oneToOne', isPrimaryKey: true }),
          ],
        }),
        model('Leaf', {
          tableName: 'leaf',
          relations: [relation('mid', 'Mid')],
        }),
      ])
    );
    expect(output.text).toContain('base_id BIGINT NOT NULL,');
    expect(output.text).toContain('mid_id BIGINT NOT NULL,');
    expect(output.text).toContain(
      'FOREIGN KEY (mid_id) REFERENCES mid (base_id)'
    );
  });

  it('skips a relation to a model that does not exist, a view, or a composite key', () => {
    const output: EmitOutput = emit(
      schemaOf([
        model('V', { tableName: 'v', isView: true }),
        model('Composite', {
          tableName: 'composite',
          fields: [field('a', { type: 'int' }), field('b', { type: 'int' })],
          compositePrimaryKey: ['a', 'b'],
        }),
        model('Child', {
          tableName: 'child',
          relations: [
            relation('ghost', 'Ghost'),
            relation('view', 'V'),
            relation('pair', 'Composite'),
          ],
        }),
      ])
    );
    expect(output.text).not.toContain('FOREIGN KEY');
    expect(output.text).not.toContain('ghost_id');
    expect(output.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining('target model "Ghost" does not exist'),
        expect.stringContaining('"V" is a view'),
        expect.stringContaining('no single column to reference'),
      ])
    );
  });

  it('writes a multi-column foreign key', () => {
    const output: EmitOutput = emit(
      schemaOf([
        model('Order', {
          tableName: 'orders',
          fields: [
            field('region', { maxLength: 4 }),
            field('number', { type: 'int' }),
          ],
          compositePrimaryKey: ['region', 'number'],
        }),
        model('Line', {
          tableName: 'lines',
          fields: [
            idField(),
            field('orderRegion', { columnName: 'order_region', maxLength: 4 }),
            field('orderNumber', { columnName: 'order_number', type: 'int' }),
          ],
          compositeForeignKeys: [
            {
              name: 'order',
              targetModel: 'Order',
              fields: ['orderRegion', 'orderNumber'],
              references: ['region', 'number'],
              kind: 'foreignKey',
              isNullable: false,
              onDelete: 'cascade',
              onUpdate: 'restrict',
              constraintName: 'fk_line_order',
            },
          ],
        }),
      ])
    );
    expect(output.text).toContain(
      'CONSTRAINT fk_line_order FOREIGN KEY (order_region, order_number) REFERENCES orders (region, number) ON DELETE CASCADE ON UPDATE RESTRICT'
    );
    expect(output.warnings).toEqual([]);
  });

  it('skips a multi-column foreign key whose columns do not exist', () => {
    const output: EmitOutput = emit(
      schemaOf([
        model('Order', { tableName: 'orders' }),
        model('Line', {
          tableName: 'lines',
          compositeForeignKeys: [
            {
              name: 'order',
              targetModel: 'Order',
              fields: ['nope'],
              references: ['id'],
              kind: 'foreignKey',
              isNullable: false,
              onDelete: 'cascade',
            },
          ],
        }),
      ])
    );
    expect(output.text).not.toContain('FOREIGN KEY');
    expect(output.warnings[0]).toContain('"nope", which is not a field');
  });

  it('uses the field of the same column instead of a second column for a relation', () => {
    const output: EmitOutput = emit(
      schemaOf([
        model('Parent', { tableName: 'parent' }),
        model('Child', {
          tableName: 'child',
          fields: [idField(), field('parent_id', { type: 'int' })],
          relations: [relation('parent', 'Parent')],
        }),
      ])
    );
    expect(output.text.match(/parent_id INTEGER/g)).toHaveLength(1);
    expect(output.text).toContain(
      'FOREIGN KEY (parent_id) REFERENCES parent (id)'
    );
  });
});

describe('SQL DDL emitter: table order and reference cycles', () => {
  const cycle: IrSchema = schemaOf([
    model('A', {
      tableName: 'a',
      relations: [
        relation('b', 'B', { isNullable: true, onDelete: 'setNull' }),
      ],
    }),
    model('B', {
      tableName: 'b',
      relations: [
        relation('a', 'A', { isNullable: true, onDelete: 'setNull' }),
      ],
    }),
  ]);

  it('creates a table after the tables it references', () => {
    const output: EmitOutput = emit(
      schemaOf([
        model('Gamma', {
          tableName: 'gamma',
          relations: [relation('beta', 'Beta')],
        }),
        model('Beta', {
          tableName: 'beta',
          relations: [relation('alpha', 'Alpha')],
        }),
        model('Alpha', { tableName: 'alpha' }),
      ])
    );
    const order: string[] = [
      ...output.text.matchAll(/CREATE TABLE (\w+)/g),
    ].map((match) => match[1] ?? '');
    expect(order).toEqual(['alpha', 'beta', 'gamma']);
  });

  it('adds the key that closes a cycle with ALTER TABLE', () => {
    const text: string = sql(cycle);
    expect(text).toContain(
      'CREATE TABLE b (\n  id INTEGER GENERATED BY DEFAULT AS IDENTITY NOT NULL,\n  a_id INTEGER,\n  CONSTRAINT b_pkey PRIMARY KEY (id)\n);'
    );
    expect(text).toContain(
      'CONSTRAINT a_b_id_fkey FOREIGN KEY (b_id) REFERENCES b (id)'
    );
    expect(text).toContain('-- These foreign keys close a reference cycle');
    expect(text).toContain(
      'ALTER TABLE b ADD CONSTRAINT b_a_id_fkey FOREIGN KEY (a_id) REFERENCES a (id) ON DELETE SET NULL;'
    );
    expect(text.indexOf('CREATE TABLE a')).toBeLessThan(
      text.indexOf('ALTER TABLE')
    );
  });

  it('keeps a self reference inside CREATE TABLE', () => {
    const text: string = sql(
      schemaOf([
        model('Node', {
          tableName: 'node',
          relations: [
            relation('parent', 'Node', {
              isNullable: true,
              onDelete: 'setNull',
            }),
          ],
        }),
      ])
    );
    expect(text).not.toContain('ALTER TABLE');
    expect(text).toContain('REFERENCES node (id) ON DELETE SET NULL');
  });

  it('keeps the keys of a cycle in CREATE TABLE on SQLite, which cannot add a constraint later', () => {
    const output: EmitOutput = emit(cycle, 'sqlite');
    expect(output.text).not.toContain('ALTER TABLE');
    expect(output.text).toContain('REFERENCES b (id)');
    expect(output.warnings).toEqual([
      expect.stringContaining('SQLite cannot add a foreign key afterwards'),
    ]);
  });

  it('orders a larger cycle and still creates every table once', () => {
    const output: EmitOutput = emit(constructsSchema());
    const names: string[] = [
      ...output.text.matchAll(/CREATE TABLE (\S+) \(/g),
    ].map((match) => match[1] ?? '');
    expect(new Set(names).size).toBe(names.length);
    expect(output.text).toContain('ALTER TABLE books ADD CONSTRAINT');
  });
});

describe('SQL DDL emitter: SQL Server cascade paths', () => {
  it('downgrades cascading actions that would form a cycle or a second path', () => {
    const output: EmitOutput = emit(
      schemaOf([
        model('Account', { tableName: 'account' }),
        model('Post', {
          tableName: 'post',
          relations: [
            relation('author', 'Account', { onDelete: 'cascade' }),
            relation('editor', 'Account', {
              onDelete: 'setNull',
              isNullable: true,
            }),
            relation('parent', 'Post', {
              onDelete: 'cascade',
              isNullable: true,
            }),
          ],
        }),
      ]),
      'sqlserver'
    );
    expect(output.text).toContain(
      'FOREIGN KEY (author_id) REFERENCES account (id) ON DELETE CASCADE'
    );
    expect(output.text).toMatch(
      /FOREIGN KEY \(editor_id\) REFERENCES account \(id\)[,\n]/
    );
    expect(output.text).toMatch(
      /FOREIGN KEY \(parent_id\) REFERENCES post \(id\)[,\n]/
    );
    expect(output.warnings).toEqual([
      expect.stringContaining(
        'Post.editor: SQL Server rejects cascading actions'
      ),
      expect.stringContaining(
        'Post.parent: SQL Server rejects cascading actions'
      ),
    ]);
  });

  it('allows a chain of cascades and does not touch the other dialects', () => {
    const chain: IrSchema = schemaOf([
      model('A', { tableName: 'a' }),
      model('B', { tableName: 'b', relations: [relation('a', 'A')] }),
      model('C', { tableName: 'c', relations: [relation('b', 'B')] }),
    ]);
    expect(emit(chain, 'sqlserver').warnings).toEqual([]);
    const second: IrSchema = schemaOf([
      model('A', { tableName: 'a' }),
      model('B', { tableName: 'b', relations: [relation('a', 'A')] }),
      model('C', {
        tableName: 'c',
        relations: [relation('b', 'B'), relation('a', 'A')],
      }),
    ]);
    expect(emit(second, 'sqlserver').warnings).toHaveLength(1);
    expect(emit(second, 'postgresql').warnings).toEqual([]);
  });
});

describe('SQL DDL emitter: enums', () => {
  const fields: IrField[] = [
    idField(),
    field('v', {
      enumName: 'Status',
      default: { kind: 'enumValue', value: 'DRAFT' },
    }),
  ];

  it('creates an enum type on PostgreSQL before the tables', () => {
    const text: string = thing(fields, 'postgresql', {}, [STATUS]).text;
    expect(text).toContain(`CREATE TYPE "Status" AS ENUM ('draft', 'live');`);
    expect(text).toContain(`v "Status" NOT NULL DEFAULT 'draft'`);
    expect(text.indexOf('CREATE TYPE')).toBeLessThan(
      text.indexOf('CREATE TABLE')
    );
  });

  it('writes the enum inline on MySQL', () => {
    const text: string = thing(fields, 'mysql', {}, [STATUS]).text;
    expect(text).toContain(`v ENUM('draft', 'live') NOT NULL DEFAULT 'draft'`);
    expect(text).not.toContain('CREATE TYPE');
  });

  it('writes a CHECK constraint on SQLite and SQL Server', () => {
    const sqlite: string = thing(fields, 'sqlite', {}, [STATUS]).text;
    expect(sqlite).toContain(`v VARCHAR(5) NOT NULL DEFAULT 'draft'`);
    expect(sqlite).toContain(
      `CONSTRAINT thing_v_check CHECK (v IN ('draft', 'live'))`
    );
    const sqlserver: string = thing(fields, 'sqlserver', {}, [STATUS]).text;
    expect(sqlserver).toContain(`v NVARCHAR(50) NOT NULL DEFAULT N'draft'`);
    expect(sqlserver).toContain(`CHECK (v IN (N'draft', N'live'))`);
  });

  it('uses the database name of the enum, snake_case in normalize mode', () => {
    const named = { ...STATUS, name: 'PostStatus', dbName: 'PostStatusType' };
    const schema: IrSchema = schemaOf(
      [
        model('Thing', {
          tableName: 'thing',
          fields: [idField(), field('v', { enumName: 'PostStatus' })],
        }),
      ],
      [named]
    );
    expect(sql(schema)).toContain('CREATE TYPE "PostStatusType" AS ENUM');
    expect(sql(schema, 'postgresql', { naming: 'normalize' })).toContain(
      'CREATE TYPE post_status_type AS ENUM'
    );
  });

  it('renames an enum type that has the name of a table on PostgreSQL', () => {
    const output: EmitOutput = emit(
      schemaOf(
        [
          model('Status', { tableName: 'status' }),
          model('Thing', {
            tableName: 'thing',
            fields: [idField(), field('v', { enumName: 'status' })],
          }),
        ],
        [{ name: 'status', values: [{ name: 'A', dbValue: 'a' }] }]
      )
    );
    expect(output.text).toContain('CREATE TYPE status_enum AS ENUM');
    expect(output.text).toContain('v status_enum NOT NULL');
    expect(output.warnings[0]).toContain('named "status_enum"');
  });

  it('escapes quotes in stored values', () => {
    const output: EmitOutput = thing(
      [idField(), field('v', { enumName: 'Q' })],
      'postgresql',
      {},
      [{ name: 'Q', values: [{ name: 'A', dbValue: "it's" }] }]
    );
    expect(output.text).toContain(`ENUM ('it''s')`);
  });

  it('writes a column of an unknown or empty enum as a plain string, with a warning', () => {
    const unknown: EmitOutput = thing([
      idField(),
      field('v', { enumName: 'Gone' }),
    ]);
    expect(unknown.text).toContain('v TEXT NOT NULL');
    expect(unknown.warnings[0]).toContain('enum "Gone" does not exist');
    const empty: EmitOutput = thing(
      [idField(), field('v', { enumName: 'Empty' })],
      'postgresql',
      {},
      [{ name: 'Empty', values: [] }]
    );
    expect(empty.text).not.toContain('CREATE TYPE');
    expect(empty.warnings[0]).toContain('without values');
  });

  it('writes enum arrays on PostgreSQL', () => {
    const text: string = thing(
      [idField(), field('v', { enumName: 'Status', arrayDepth: 1 })],
      'postgresql',
      {},
      [STATUS]
    ).text;
    expect(text).toContain('v "Status"[] NOT NULL');
  });
});

describe('SQL DDL emitter: many-to-many, views, naming and ignored constructs', () => {
  it('writes a join table for a many-to-many field', () => {
    const output: EmitOutput = emit(
      schemaOf([
        model('Post', {
          tableName: 'post',
          relations: [
            relation('tags', 'Tag', {
              kind: 'manyToMany',
              columnName: 'tags_id',
            }),
          ],
        }),
        model('Tag', { tableName: 'tag' }),
      ])
    );
    expect(output.text).toContain('CREATE TABLE post_tags (');
    expect(output.text).toContain(
      'FOREIGN KEY (post_id) REFERENCES post (id) ON DELETE CASCADE'
    );
    expect(output.text).toContain(
      'FOREIGN KEY (tag_id) REFERENCES tag (id) ON DELETE CASCADE'
    );
    expect(output.text).toContain(
      'CREATE UNIQUE INDEX post_tags_post_id_tag_id_key ON post_tags (post_id, tag_id);'
    );
    expect(output.text.indexOf('CREATE TABLE post_tags')).toBeGreaterThan(
      output.text.indexOf('CREATE TABLE tag')
    );
  });

  it('writes a view as a commented placeholder with a warning', () => {
    const output: EmitOutput = emit(
      schemaOf([
        model('Report', {
          tableName: 'report',
          isView: true,
          fields: [field('title'), field('total', { type: 'int' })],
        }),
      ])
    );
    expect(output.text).not.toContain('CREATE TABLE');
    expect(output.text).toContain(
      '-- View report: the schema has no SQL definition for it'
    );
    expect(output.text).toContain('-- Columns: title, total');
    expect(output.text).toContain('-- CREATE VIEW report AS SELECT ... ;');
    expect(output.warnings).toEqual([
      expect.stringContaining('Report: this is a database view'),
    ]);
  });

  it('applies the fresh-schema style in normalize mode', () => {
    const output: EmitOutput = emit(
      schemaOf([
        model('BlogPost', {
          tableName: 'blog_posts',
          fields: [idField(), field('Title', { columnName: 'Title' })],
        }),
      ]),
      'postgresql',
      { naming: 'normalize' }
    );
    expect(output.text).toContain('CREATE TABLE blog_post (');
    expect(output.text).toContain('id UUID NOT NULL DEFAULT gen_random_uuid()');
    expect(output.text).toContain('title TEXT NOT NULL');
    expect(output.text).toContain(
      'created_at TIMESTAMPTZ NOT NULL DEFAULT now()'
    );
    expect(output.text).toContain('updated_at TIMESTAMPTZ NOT NULL');
    const preserved: string = sql(
      schemaOf([
        model('BlogPost', {
          tableName: 'blog_posts',
          fields: [idField(), field('Title', { columnName: 'Title' })],
        }),
      ])
    );
    expect(preserved).toContain('CREATE TABLE blog_posts (');
    expect(preserved).toContain('"Title" TEXT NOT NULL');
  });

  it('ignores database schemas with a warning', () => {
    const output: EmitOutput = emit(
      schemaOf(
        [model('Thing', { tableName: 'thing', schema: 'audit' })],
        [{ name: 'E', values: [{ name: 'A', dbValue: 'a' }], schema: 'audit' }]
      )
    );
    expect(output.warnings).toEqual([
      expect.stringContaining('enum E: the database schema "audit"'),
      expect.stringContaining('Thing: the database schema "audit"'),
    ]);
    expect(output.text).not.toContain('audit');
  });

  it('is deterministic', () => {
    expect(sql(kitchenSinkSchema(), 'mysql')).toBe(
      sql(kitchenSinkSchema(), 'mysql')
    );
  });
});

describe('SQL DDL emitter: structural coverage check', () => {
  const schema: IrSchema = schemaOf(
    [
      model('Parent', {
        tableName: 'parent',
        fields: [idField(), field('slug', { isUnique: true, maxLength: 5 })],
      }),
      model('Child', {
        tableName: 'child',
        fields: [
          idField(),
          field('status', { enumName: 'Status', maxLength: 5 }),
        ],
        relations: [relation('parent', 'Parent')],
        indexes: [index(['status'])],
      }),
    ],
    [STATUS]
  );

  it('finds nothing missing in the emitted output of every dialect', () => {
    for (const provider of PROVIDERS) {
      expect(
        checkSqlDdlOutput(schema, { sql: sql(schema, provider) }),
        provider
      ).toEqual([]);
    }
  });

  it('names what is missing', () => {
    const text: string = sql(schema)
      .replace(/ {2}slug .*\n/, '')
      .replace(/ {2}CONSTRAINT child_parent_id_fkey .*\n/, '')
      .replace('CREATE INDEX child_status_idx ON child (status);\n', '')
      .replace("'live'", "'x'");
    expect(checkSqlDdlOutput(schema, { sql: text })).toEqual([
      'Parent: no column slug',
      'Child.parent: no foreign key reference',
      'Child: no index on (status)',
      'enum Status: not all values are written',
    ]);
    expect(checkSqlDdlOutput(schema, {})).toEqual(['no sql file']);
    expect(checkSqlDdlOutput(schema, { sql: '' })).toContain(
      'Parent: no table parent'
    );
  });
});

describe('SQL DDL emitter: command line', () => {
  async function run(
    args: string[]
  ): Promise<{ code: number; stderr: string }> {
    const directory: string = await mkdtemp(join(tmpdir(), 'ormbridge-sql-'));
    try {
      // A package.json keeps config discovery from walking above the temp directory.
      await writeFile(join(directory, 'package.json'), '{}');
      let stderr: string = '';
      const code: number = await runCli(args, {
        cwd: directory,
        stdout: (): void => undefined,
        stderr: (text: string): void => {
          stderr += text;
        },
      });
      const written: string | undefined = await readFile(
        join(directory, 'out', 'schema.sql'),
        'utf8'
      ).catch(() => undefined);
      return { code, stderr: `${stderr}\n=====\n${written ?? ''}` };
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  it('infers the sql format from the .sql output path and uses --provider as the dialect', async () => {
    const postgres = await run([
      'convert',
      '-i',
      BLOG_FIXTURE_PATH,
      '-o',
      'out/schema.sql',
    ]);
    expect(postgres.code).toBe(EXIT_OK);
    expect(postgres.stderr).toContain('-- SQL DDL for PostgreSQL');
    expect(postgres.stderr).toContain('GENERATED BY DEFAULT AS IDENTITY');
    const sqlserver = await run([
      'convert',
      '-i',
      BLOG_FIXTURE_PATH,
      '-o',
      'out/schema.sql',
      '--provider',
      'sqlserver',
      '--naming',
      'normalize',
    ]);
    expect(sqlserver.code).toBe(EXIT_OK);
    expect(sqlserver.stderr).toContain('-- SQL DDL for SQL Server');
    expect(sqlserver.stderr).toContain(
      'id UNIQUEIDENTIFIER NOT NULL DEFAULT NEWID()'
    );
  });

  it('lists sql among the formats and mentions the SQL dialects in the --provider help', async () => {
    let help: string = '';
    await runCli(['convert', '--help'], {
      cwd: process.cwd(),
      stdout: (text: string): void => {
        help += text;
      },
      stderr: (): void => undefined,
    });
    const flat: string = help.replace(/\s+/g, ' ');
    expect(flat).toContain('sqlserver');
    expect(flat).toContain('SQL dialect');
    expect(flat).toMatch(/target format \([^)]*\bsql\b/);
  });
});

// ---------------------------------------------------------------------------
// Golden files
// ---------------------------------------------------------------------------

const GOLDEN_ROOT: string = fileURLToPath(
  new URL('./golden-extras/', import.meta.url)
);
const NAMING_MODES = ['preserve', 'normalize'] as const;

describe('SQL DDL emitter: golden files', () => {
  // The PostgreSQL output of every readable format is a golden of conversion.test.ts
  // (test/golden/<format>-to-sql.<naming>.txt). The other dialects live here.
  describe.each(['mysql', 'sqlite', 'sqlserver'] as const)('%s', (provider) => {
    // The converter rejects same-format conversion, so the sql fixtures are not sources here.
    describe.each(
      CANONICAL_FIXTURES.map((fixture) => fixture.format).filter(
        (format: string) => format !== 'sql'
      )
    )('%s source', (format) => {
      it('matches the golden output (both naming modes)', async () => {
        const files: Record<string, string> = {};
        for (const naming of NAMING_MODES) {
          const result = await convertCanonical(format, 'sql', {
            naming,
            provider,
          });
          files[`${naming}.sql`] = result.output;
          files[`${naming}.warnings.txt`] = `${result.warnings.join('\n')}\n`;
        }
        expectFilesMatchGolden(
          `sql-${provider}/${format}-to-sql`,
          files,
          GOLDEN_ROOT
        );
      });
    });
  });

  describe.each(EXTRA_SOURCES)('$label', (source) => {
    it.each(PROVIDERS)(
      'matches the golden output for %s (both naming modes)',
      async (provider) => {
        const ir: IrSchema = await parseSource(source);
        const files: Record<string, string> = {};
        for (const naming of NAMING_MODES) {
          const output: EmitOutput = emitSqlDdl(ir, { provider, naming });
          files[`${naming}.sql`] = output.text;
          files[`${naming}.warnings.txt`] = `${output.warnings.join('\n')}\n`;
        }
        expectFilesMatchGolden(
          `sql-extras/${source.label}-${provider}`,
          files,
          GOLDEN_ROOT
        );
      }
    );
  });

  describe.each([
    ['kitchen-sink', kitchenSinkSchema],
    ['stress', stressSchema],
    ['constructs', constructsSchema],
  ] as const)('%s fixture', (label, make) => {
    it.each(PROVIDERS)(
      'matches the golden output for %s (both naming modes)',
      (provider) => {
        const files: Record<string, string> = {};
        for (const naming of NAMING_MODES) {
          const output: EmitOutput = emitSqlDdl(make(), { provider, naming });
          files[`${naming}.sql`] = output.text;
          files[`${naming}.warnings.txt`] = `${output.warnings.join('\n')}\n`;
        }
        expectFilesMatchGolden(
          `sql-fixtures/${label}-${provider}`,
          files,
          GOLDEN_ROOT
        );
      }
    );
  });

  it('writes the same text through the format registry as through emitSqlDdl', () => {
    const adapter = expectOk(getFormat('sql'));
    const direct: EmitOutput = emitSqlDdl(kitchenSinkSchema(), {
      provider: 'sqlite',
      naming: 'preserve',
    });
    if (adapter.emit === undefined) {
      throw new Error('The sql format has no emit.');
    }
    const viaRegistry = expectOk(
      adapter.emit(kitchenSinkSchema(), {
        ...DEFAULT_OPTIONS,
        provider: 'sqlite',
      })
    );
    expect(viaRegistry.text).toBe(direct.text);
  });
});
