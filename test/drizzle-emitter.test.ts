import { describe, expect, it } from 'vitest';
import { convertText } from '../src/convert.js';
import {
  DRIZZLE_CONFIG_FILE,
  DRIZZLE_SCHEMA_FILE,
  emitDrizzle,
  type DrizzleEmitOptions,
} from '../src/emitters/drizzle.js';
import type { PrismaProvider } from '../src/emitters/prisma.js';
import {
  describeFormats,
  getFormat,
  listFormats,
  type FormatEmitOutput,
  type MultiFileEmitOutput,
} from '../src/formats.js';
import type { IrField, IrModel, IrSchema } from '../src/ir.js';
import { constructsSchema } from './drizzleFixtures.js';
import { checkDrizzleOutput } from './drizzleCoverage.js';
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
import {
  expectFilesMatchGolden,
  loadCanonicalSources,
  convertCanonical,
} from './harness.js';
import { parseWith } from './conversionMatrix.js';
import { DEFAULT_OPTIONS, expectOk } from './helpers.js';
import { fileURLToPath } from 'node:url';
import { CANONICAL_FIXTURES } from './fixtures/canonical.js';

function emit(
  schema: IrSchema,
  overrides: Partial<DrizzleEmitOptions> = {}
): MultiFileEmitOutput {
  return emitDrizzle(schema, {
    provider: 'postgresql',
    naming: 'preserve',
    ...overrides,
  });
}

/** The text of schema.ts for a single model. */
function schemaFor(
  fields: IrField[],
  provider: PrismaProvider = 'postgresql',
  extra: Partial<IrModel> = {}
): string {
  return emit(schemaOf([model('Thing', { fields, ...extra })]), { provider })
    .files[DRIZZLE_SCHEMA_FILE] as string;
}

/** The declaration of one column of the model "Thing", on one line. */
function column(text: string, key: string): string {
  const pattern: RegExp = new RegExp(`^ +${key}: ([\\s\\S]*?),?$`, 'm');
  const match: RegExpMatchArray | null = pattern.exec(text);
  if (match === null) {
    throw new Error(`No column ${key} in:\n${text}`);
  }
  // Join a chain that was broken over several lines.
  const start: number = text.indexOf(match[0]);
  const rest: string = text.slice(start + match[0].length);
  const continuation: RegExpMatchArray | null = /^((?:\n +\.[^\n]*)+)/.exec(
    rest
  );
  const joined: string = `${match[1] ?? ''}${continuation?.[1] ?? ''}`;
  return joined.replace(/\n +/g, '').replace(/,$/, '');
}

function warningsOf(
  schema: IrSchema,
  overrides: Partial<DrizzleEmitOptions> = {}
): string[] {
  return emit(schema, overrides).warnings;
}

const PROVIDERS: readonly PrismaProvider[] = ['postgresql', 'mysql', 'sqlite'];

describe('drizzle emitter: files and imports', () => {
  it('writes schema.ts and drizzle.config.ts and no single text', () => {
    const output: MultiFileEmitOutput = emit(schemaOf([model('Post')]));
    expect(Object.keys(output.files).sort()).toEqual([
      DRIZZLE_CONFIG_FILE,
      DRIZZLE_SCHEMA_FILE,
    ]);
    expect(output.text).toBeUndefined();
  });

  it.each([
    ['postgresql', 'postgresql', 'drizzle-orm/pg-core', 'pgTable'],
    ['cockroachdb', 'postgresql', 'drizzle-orm/pg-core', 'pgTable'],
    ['mysql', 'mysql', 'drizzle-orm/mysql-core', 'mysqlTable'],
    ['sqlite', 'sqlite', 'drizzle-orm/sqlite-core', 'sqliteTable'],
  ] as const)(
    'provider %s uses the %s dialect',
    (provider, dialect, module, tableFunction) => {
      const output: MultiFileEmitOutput = emit(schemaOf([model('Post')]), {
        provider,
      });
      const text: string = output.files[DRIZZLE_SCHEMA_FILE] ?? '';
      expect(text).toContain(`from '${module}';`);
      expect(text).toContain(`export const post = ${tableFunction}('post', {`);
      expect(output.files[DRIZZLE_CONFIG_FILE]).toBe(
        [
          `import { defineConfig } from 'drizzle-kit';`,
          '',
          'export default defineConfig({',
          `  dialect: '${dialect}',`,
          `  schema: './schema.ts',`,
          `  out: './drizzle',`,
          '});',
          '',
        ].join('\n')
      );
      expect(output.warnings).toEqual([]);
    }
  );

  it.each(['sqlserver', 'mongodb'] as const)(
    'writes PostgreSQL tables for provider %s and says so',
    (provider) => {
      const output: MultiFileEmitOutput = emit(schemaOf([model('Post')]), {
        provider,
      });
      expect(output.files[DRIZZLE_SCHEMA_FILE]).toContain('pgTable(');
      expect(output.warnings).toHaveLength(1);
      expect(output.warnings[0]).toContain(`Provider "${provider}"`);
      expect(output.warnings[0]).toContain('no');
    }
  );

  it('imports only what it uses, sorted, wrapping a long import', () => {
    const text: string = schemaFor([
      idField(),
      field('title', { maxLength: 10 }),
    ]);
    expect(text.split('\n')[0]).toBe(
      "import { pgTable, serial, varchar } from 'drizzle-orm/pg-core';"
    );
    const big: string = emit(kitchenSinkSchema(), { provider: 'sqlite' }).files[
      DRIZZLE_SCHEMA_FILE
    ] as string;
    expect(big).toContain('import {\n  blob,\n  index,');
    expect(big).toContain("} from 'drizzle-orm/sqlite-core';");
  });

  it('writes an empty module for an empty schema', () => {
    const output: MultiFileEmitOutput = emit(schemaOf([]));
    expect(output.files[DRIZZLE_SCHEMA_FILE]).toBe('export {};\n');
  });

  it('exports the inferred row types of every table', () => {
    const text: string = schemaFor([idField()]);
    expect(text).toContain(
      'export type Thing = typeof thing.$inferSelect;\nexport type NewThing = typeof thing.$inferInsert;'
    );
  });
});

describe('drizzle emitter: column types', () => {
  interface TypeCase {
    label: string;
    field: Partial<IrField>;
    postgresql: string;
    mysql: string;
    sqlite: string;
  }
  const CASES: TypeCase[] = [
    {
      label: 'string with a length',
      field: { type: 'string', maxLength: 40 },
      postgresql: "varchar('c', { length: 40 }).notNull()",
      mysql: "varchar('c', { length: 40 }).notNull()",
      sqlite: "text('c').notNull()",
    },
    {
      label: 'string without a length',
      field: { type: 'string' },
      postgresql: "text('c').notNull()",
      mysql: "varchar('c', { length: 255 }).notNull()",
      sqlite: "text('c').notNull()",
    },
    {
      label: 'text',
      field: { type: 'text' },
      postgresql: "text('c').notNull()",
      mysql: "text('c').notNull()",
      sqlite: "text('c').notNull()",
    },
    {
      label: 'int',
      field: { type: 'int' },
      postgresql: "integer('c').notNull()",
      mysql: "int('c').notNull()",
      sqlite: "integer('c').notNull()",
    },
    {
      label: 'bigInt',
      field: { type: 'bigInt' },
      postgresql: "bigint('c', { mode: 'number' }).notNull()",
      mysql: "bigint('c', { mode: 'number' }).notNull()",
      sqlite: "integer('c').notNull()",
    },
    {
      label: 'float',
      field: { type: 'float' },
      postgresql: "doublePrecision('c').notNull()",
      mysql: "double('c').notNull()",
      sqlite: "real('c').notNull()",
    },
    {
      label: 'decimal',
      field: { type: 'decimal', maxDigits: 10, decimalPlaces: 2 },
      postgresql: "numeric('c', { precision: 10, scale: 2 }).notNull()",
      mysql: "decimal('c', { precision: 10, scale: 2 }).notNull()",
      sqlite: "numeric('c').notNull()",
    },
    {
      label: 'decimal without precision',
      field: { type: 'decimal' },
      postgresql: "numeric('c').notNull()",
      mysql: "decimal('c').notNull()",
      sqlite: "numeric('c').notNull()",
    },
    {
      label: 'boolean',
      field: { type: 'boolean' },
      postgresql: "boolean('c').notNull()",
      mysql: "boolean('c').notNull()",
      sqlite: "integer('c', { mode: 'boolean' }).notNull()",
    },
    {
      label: 'dateTime',
      field: { type: 'dateTime' },
      postgresql: "timestamp('c', { withTimezone: true }).notNull()",
      mysql: "datetime('c').notNull()",
      sqlite: "integer('c', { mode: 'timestamp' }).notNull()",
    },
    {
      label: 'date',
      field: { type: 'date' },
      postgresql: "date('c', { mode: 'string' }).notNull()",
      mysql: "date('c', { mode: 'string' }).notNull()",
      sqlite: "text('c').notNull()",
    },
    {
      label: 'time',
      field: { type: 'time' },
      postgresql: "time('c').notNull()",
      mysql: "time('c').notNull()",
      sqlite: "text('c').notNull()",
    },
    {
      label: 'uuid',
      field: { type: 'uuid' },
      postgresql: "uuid('c').notNull()",
      mysql: "char('c', { length: 36 }).notNull()",
      sqlite: "text('c').notNull()",
    },
    {
      label: 'json',
      field: { type: 'json' },
      postgresql: "jsonb('c').notNull()",
      mysql: "json('c').notNull()",
      sqlite: "text('c', { mode: 'json' }).notNull()",
    },
    {
      label: 'bytes',
      field: { type: 'bytes' },
      postgresql: "bytea('c').notNull()",
      mysql: "blob('c').notNull()",
      sqlite: "blob('c', { mode: 'buffer' }).notNull()",
    },
    {
      label: 'ipAddress',
      field: { type: 'ipAddress' },
      postgresql: "inet('c').notNull()",
      mysql: "varchar('c', { length: 45 }).notNull()",
      sqlite: "text('c').notNull()",
    },
    {
      label: 'array',
      field: { type: 'int', arrayDepth: 1 },
      postgresql: "integer('c').array().notNull()",
      mysql: "json('c').$type<number[]>().notNull()",
      sqlite: "text('c', { mode: 'json' }).$type<number[]>().notNull()",
    },
    {
      label: 'nested array',
      field: { type: 'string', arrayDepth: 2 },
      postgresql: "text('c').array().array().notNull()",
      mysql: "json('c').$type<string[][]>().notNull()",
      sqlite: "text('c', { mode: 'json' }).$type<string[][]>().notNull()",
    },
    {
      label: 'duration',
      field: { type: 'duration' },
      postgresql: "interval('c').notNull()",
      mysql: "bigint('c', { mode: 'number' }).notNull()",
      sqlite: "integer('c').notNull()",
    },
    {
      label: 'hstore',
      field: { type: 'hstore' },
      postgresql: "hstore('c').notNull()",
      mysql: "json('c').$type<Record<string, string | null>>().notNull()",
      sqlite:
        "text('c', { mode: 'json' }).$type<Record<string, string | null>>().notNull()",
    },
    {
      label: 'range',
      field: { type: 'range', rangeOf: 'dateTime' },
      postgresql: "tstzrange('c').notNull()",
      mysql: "varchar('c', { length: 255 }).notNull()",
      sqlite: "text('c').notNull()",
    },
    {
      label: 'unsupported',
      field: { type: 'unsupported', unsupportedType: 'circle' },
      postgresql: "text('c').notNull()",
      mysql: "varchar('c', { length: 255 }).notNull()",
      sqlite: "text('c').notNull()",
    },
  ];

  describe.each(CASES)('$label', (typeCase: TypeCase) => {
    it.each(PROVIDERS)('is written for %s', (provider) => {
      const text: string = schemaFor([field('c', typeCase.field)], provider);
      expect(column(text, 'c')).toBe(typeCase[provider]);
    });
  });

  it('declares a customType helper for every PostgreSQL type without a builder', () => {
    const text: string = schemaFor([
      field('a', { type: 'bytes' }),
      field('b', { type: 'hstore' }),
      field('d', { type: 'range', rangeOf: 'int' }),
      field('e', { type: 'range', rangeOf: 'bigInt' }),
    ]);
    expect(text.split('\n')[0]).toBe(
      "import { customType, pgTable } from 'drizzle-orm/pg-core';"
    );
    expect(text).toContain(
      "const bytea = customType<{ data: Buffer; driverData: Buffer }>({\n  dataType() {\n    return 'bytea';\n  },\n});"
    );
    expect(text).toContain("return 'hstore';");
    expect(text).toContain("return 'int4range';");
    expect(text).toContain("return 'int8range';");
    expect(text.indexOf('const bytea')).toBeLessThan(
      text.indexOf('export const')
    );
  });

  it('declares the blob helper on MySQL and uses the built-in blob on SQLite', () => {
    const mysql: string = schemaFor([field('a', { type: 'bytes' })], 'mysql');
    expect(mysql).toContain(
      'const blob = customType<{ data: Buffer; driverData: Buffer }>'
    );
    const sqlite: string = schemaFor([field('a', { type: 'bytes' })], 'sqlite');
    expect(sqlite).not.toContain('customType');
  });

  it('writes nullable columns without notNull', () => {
    const text: string = schemaFor([
      field('a', { isNullable: true, type: 'text' }),
    ]);
    expect(column(text, 'a')).toBe("text('a')");
  });

  it('warns about arrays, durations, hstore and ranges outside PostgreSQL', () => {
    const schema: IrSchema = schemaOf([
      model('Thing', {
        fields: [
          field('a', { arrayDepth: 1 }),
          field('d', { type: 'duration' }),
          field('h', { type: 'hstore' }),
          field('r', { type: 'range', rangeOf: 'int' }),
        ],
      }),
    ]);
    expect(warningsOf(schema)).toEqual([]);
    for (const provider of ['mysql', 'sqlite'] as const) {
      const warnings: string[] = warningsOf(schema, { provider });
      expect(warnings).toHaveLength(4);
      expect(warnings.join('\n')).toContain('Thing.a: ');
      expect(warnings.join('\n')).toContain('Thing.d: ');
      expect(warnings.join('\n')).toContain('Thing.h: ');
      expect(warnings.join('\n')).toContain('Thing.r: ');
    }
  });

  it('warns about an unknown field type and writes text', () => {
    const schema: IrSchema = schemaOf([
      model('Thing', {
        fields: [field('x', { type: 'mystery' as IrField['type'] })],
      }),
    ]);
    const output: MultiFileEmitOutput = emit(schema);
    expect(output.warnings).toEqual([
      'Thing.x: unknown field type "mystery"; it was written as text.',
    ]);
    expect(column(output.files[DRIZZLE_SCHEMA_FILE] ?? '', 'x')).toBe(
      "text('x').notNull()"
    );
  });
});

describe('drizzle emitter: keys', () => {
  it.each([
    ['postgresql', 'int', "serial('id').primaryKey()"],
    [
      'postgresql',
      'bigInt',
      "bigserial('id', { mode: 'number' }).primaryKey()",
    ],
    ['mysql', 'int', "int('id').primaryKey().autoincrement()"],
    [
      'mysql',
      'bigInt',
      "bigint('id', { mode: 'number' }).primaryKey().autoincrement()",
    ],
    ['sqlite', 'int', "integer('id').primaryKey({ autoIncrement: true })"],
    ['sqlite', 'bigInt', "integer('id').primaryKey({ autoIncrement: true })"],
  ] as const)(
    'writes an auto-increment %s %s key',
    (provider, type, expected) => {
      const text: string = schemaFor([idField({ type })], provider);
      expect(column(text, 'id')).toBe(expected);
    }
  );

  it.each([
    ['postgresql', "uuid('id').primaryKey().defaultRandom()"],
    ['mysql', "char('id', { length: 36 }).primaryKey().default(sql`(UUID())`)"],
    ['sqlite', "text('id').primaryKey().$defaultFn(() => crypto.randomUUID())"],
  ] as const)('writes a UUID key for %s', (provider, expected) => {
    const text: string = schemaFor(
      [
        field('id', {
          type: 'uuid',
          isPrimaryKey: true,
          default: { kind: 'uuid' },
        }),
      ],
      provider
    );
    expect(column(text, 'id')).toBe(expected);
  });

  it('warns that the SQLite UUID default is generated by Drizzle', () => {
    const schema: IrSchema = schemaOf([
      model('Thing', {
        fields: [
          field('id', {
            type: 'uuid',
            isPrimaryKey: true,
            default: { kind: 'uuid' },
          }),
        ],
      }),
    ]);
    expect(warningsOf(schema, { provider: 'sqlite' })).toEqual([
      'Thing.id: SQLite has no database-side UUID default; the UUID is generated by Drizzle ($defaultFn) when a row is inserted through it.',
    ]);
    expect(warningsOf(schema, { provider: 'mysql' })).toEqual([]);
  });

  it('writes a plain primary key without a default', () => {
    const text: string = schemaFor([
      field('code', { maxLength: 8, isPrimaryKey: true }),
    ]);
    expect(column(text, 'code')).toBe(
      "varchar('code', { length: 8 }).primaryKey()"
    );
  });

  it('writes a composite primary key in the table callback, with notNull columns', () => {
    const text: string = schemaFor(
      [field('a', { type: 'int' }), field('b', { type: 'int' })],
      'postgresql',
      { compositePrimaryKey: ['a', 'b'], primaryKeyName: 'thing_pk' }
    );
    expect(column(text, 'a')).toBe("integer('a').notNull()");
    expect(text).toContain(
      "primaryKey({ columns: [table.a, table.b], name: 'thing_pk' })"
    );
    expect(text).toContain('(table) => [');
  });

  it('drops an auto-increment default that is not on a lone integer key', () => {
    const schema: IrSchema = schemaOf([
      model('Thing', {
        fields: [
          idField(),
          field('n', { type: 'int', default: { kind: 'autoIncrement' } }),
        ],
      }),
    ]);
    const output: MultiFileEmitOutput = emit(schema);
    expect(output.warnings).toEqual([
      'Thing.n: an auto-increment default is only supported on a single-column integer primary key; it was dropped.',
    ]);
    expect(column(output.files[DRIZZLE_SCHEMA_FILE] ?? '', 'n')).toBe(
      "integer('n').notNull()"
    );
  });
});

describe('drizzle emitter: constraints and defaults', () => {
  it('writes unique, with the constraint name when there is one', () => {
    const text: string = schemaFor([
      field('a', { isUnique: true, maxLength: 5 }),
      field('b', { isUnique: true, uniqueName: 'b_uq', type: 'text' }),
    ]);
    expect(column(text, 'a')).toBe(
      "varchar('a', { length: 5 }).notNull().unique()"
    );
    expect(column(text, 'b')).toBe("text('b').notNull().unique('b_uq')");
  });

  describe.each(PROVIDERS)('now defaults on %s', (provider) => {
    it('uses the dialect default for date-times, dates and times', () => {
      const text: string = schemaFor(
        [
          field('a', { type: 'dateTime', default: { kind: 'now' } }),
          field('b', { type: 'date', default: { kind: 'now' } }),
          field('c', { type: 'time', default: { kind: 'now' } }),
        ],
        provider
      );
      const expected: Record<PrismaProvider, string[]> = {
        postgresql: [
          '.notNull().defaultNow()',
          '.notNull().default(sql`CURRENT_DATE`)',
          '.notNull().default(sql`CURRENT_TIME`)',
        ],
        mysql: [
          '.notNull().default(sql`CURRENT_TIMESTAMP`)',
          '.notNull().default(sql`(CURRENT_DATE)`)',
          '.notNull().default(sql`(CURRENT_TIME)`)',
        ],
        sqlite: [
          '.notNull().default(sql`(unixepoch())`)',
          '.notNull().default(sql`(CURRENT_DATE)`)',
          '.notNull().default(sql`(CURRENT_TIME)`)',
        ],
        sqlserver: [],
        mongodb: [],
        cockroachdb: [],
      };
      expect(column(text, 'a').endsWith(expected[provider][0] ?? '')).toBe(
        true
      );
      expect(column(text, 'b').endsWith(expected[provider][1] ?? '')).toBe(
        true
      );
      expect(column(text, 'c').endsWith(expected[provider][2] ?? '')).toBe(
        true
      );
      expect(text).toContain("import { sql } from 'drizzle-orm';");
    });
  });

  it('does not import sql when no default needs it', () => {
    const text: string = schemaFor([
      field('a', { type: 'dateTime', default: { kind: 'now' } }),
    ]);
    expect(text).not.toContain("from 'drizzle-orm';");
  });

  it('drops a now default on other types with a warning', () => {
    const schema: IrSchema = schemaOf([
      model('Thing', {
        fields: [field('n', { type: 'int', default: { kind: 'now' } })],
      }),
    ]);
    expect(warningsOf(schema)).toEqual([
      'Thing.n: a "now" default on a int column cannot be written; it was dropped.',
    ]);
  });

  it('drops a UUID default on a column that is not a UUID', () => {
    const schema: IrSchema = schemaOf([
      model('Thing', {
        fields: [field('n', { default: { kind: 'uuid' } })],
      }),
    ]);
    expect(warningsOf(schema)[0]).toContain(
      'a UUID default on a string column cannot be written'
    );
  });

  describe('literal defaults', () => {
    const base = (
      overrides: Partial<IrField>,
      provider: PrismaProvider = 'postgresql'
    ): string => column(schemaFor([field('c', overrides)], provider), 'c');

    it('quotes strings with the right escapes', () => {
      expect(
        base({ type: 'text', default: { kind: 'literal', value: "it's" } })
      ).toBe(`text('c').notNull().default("it's")`);
      expect(
        base({ type: 'text', default: { kind: 'literal', value: 'a\\b' } })
      ).toBe(`text('c').notNull().default('a\\\\b')`);
      expect(
        base({ type: 'text', default: { kind: 'literal', value: '' } })
      ).toBe(`text('c').notNull().default('')`);
    });

    it('writes numbers, booleans and decimals by their TypeScript type', () => {
      expect(
        base({ type: 'int', default: { kind: 'literal', value: 7 } })
      ).toBe("integer('c').notNull().default(7)");
      expect(
        base({ type: 'int', default: { kind: 'literal', value: '8' } })
      ).toBe("integer('c').notNull().default(8)");
      expect(
        base({ type: 'float', default: { kind: 'literal', value: 0.25 } })
      ).toBe("doublePrecision('c').notNull().default(0.25)");
      expect(
        base({ type: 'boolean', default: { kind: 'literal', value: false } })
      ).toBe("boolean('c').notNull().default(false)");
      expect(
        base({ type: 'boolean', default: { kind: 'literal', value: 'true' } })
      ).toBe("boolean('c').notNull().default(true)");
      expect(
        base(
          { type: 'boolean', default: { kind: 'literal', value: 1 } },
          'sqlite'
        )
      ).toBe("integer('c', { mode: 'boolean' }).notNull().default(true)");
      expect(
        base({
          type: 'decimal',
          default: { kind: 'literal', value: 1.5 },
        })
      ).toBe("numeric('c').notNull().default('1.5')");
    });

    it('writes JSON as an object literal and a date-time as a Date', () => {
      expect(
        base({
          type: 'json',
          default: { kind: 'literal', value: '{"a": [1, "x"], "b-c": null}' },
        })
      ).toBe("jsonb('c').notNull().default({ a: [1, 'x'], 'b-c': null })");
      expect(
        base({
          type: 'dateTime',
          default: { kind: 'literal', value: '2020-01-02T03:04:05Z' },
        })
      ).toBe(
        "timestamp('c', { withTimezone: true }).notNull().default(new Date('2020-01-02T03:04:05Z'))"
      );
    });

    it('writes array defaults and an empty hstore', () => {
      expect(
        base({
          type: 'int',
          arrayDepth: 1,
          default: { kind: 'literal', value: '[1, 2]' },
        })
      ).toBe("integer('c').array().notNull().default([1, 2])");
      expect(
        base({
          type: 'hstore',
          default: { kind: 'literal', value: '{}' },
        })
      ).toBe("hstore('c').notNull().default(sql`''`)");
    });

    it('writes an interval default on PostgreSQL as text', () => {
      expect(
        base({
          type: 'duration',
          default: { kind: 'literal', value: '1 day' },
        })
      ).toBe("interval('c').notNull().default('1 day')");
    });

    it.each([
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
        { type: 'range', default: { kind: 'literal', value: 'x' } },
        'range default',
      ],
      [
        { type: 'hstore', default: { kind: 'literal', value: 'a=>1' } },
        'only an empty hstore',
      ],
      [
        {
          type: 'int',
          arrayDepth: 1,
          default: { kind: 'literal', value: 'x' },
        },
        'array default',
      ],
    ] as const)('drops %o with a warning', (overrides, reason) => {
      const schema: IrSchema = schemaOf([
        model('Thing', {
          fields: [field('c', overrides as Partial<IrField>)],
        }),
      ]);
      const warnings: string[] = warningsOf(schema);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('Thing.c: ');
      expect(warnings[0]).toContain(reason);
      expect(
        column(emit(schema).files[DRIZZLE_SCHEMA_FILE] ?? '', 'c')
      ).not.toContain('.default(');
    });
  });

  it('drops client-generated and database-expression defaults with the shared warnings', () => {
    const schema: IrSchema = schemaOf([
      model('Thing', {
        fields: [
          field('a', {
            default: { kind: 'clientGenerated', generator: 'cuid' },
          }),
          field('b', {
            default: { kind: 'dbExpression', expression: 'now()' },
          }),
        ],
      }),
    ]);
    const output: MultiFileEmitOutput = emit(schema);
    expect(output.warnings).toEqual([
      'Thing.a: the cuid() default is generated by Prisma Client and was dropped.',
      'Thing.b: the database default expression now() was dropped.',
    ]);
    expect(output.files[DRIZZLE_SCHEMA_FILE]).not.toContain('.default(');
  });

  describe('auto-updated columns', () => {
    it('writes $onUpdate for date-times and dates', () => {
      const text: string = schemaFor([
        field('a', { type: 'dateTime', isAutoUpdated: true }),
        field('b', { type: 'date', isAutoUpdated: true }),
      ]);
      expect(column(text, 'a')).toBe(
        "timestamp('a', { withTimezone: true }).notNull().$onUpdate(() => new Date())"
      );
      expect(column(text, 'b')).toBe(
        "date('b', { mode: 'string' }).notNull().$onUpdate(() => new Date().toISOString().slice(0, 10))"
      );
    });

    it('warns when the column is neither', () => {
      const schema: IrSchema = schemaOf([
        model('Thing', {
          fields: [field('n', { type: 'int', isAutoUpdated: true })],
        }),
      ]);
      expect(warningsOf(schema)).toEqual([
        'Thing.n: only date and date-time columns can be refreshed on update ($onUpdate); the auto-update flag was dropped.',
      ]);
    });
  });

  it('warns that generated columns are written as regular columns', () => {
    const schema: IrSchema = schemaOf([
      model('Thing', {
        fields: [
          field('g', {
            type: 'int',
            generated: { expression: 'F("a") + 1', isStored: true },
          }),
        ],
      }),
    ]);
    expect(warningsOf(schema)).toEqual([
      'Thing.g: the generated column expression F("a") + 1 is Python, not SQL, and cannot be written for Drizzle; the property was written as a regular column.',
    ]);
  });
});

describe('drizzle emitter: enums', () => {
  const schema: IrSchema = schemaOf(
    [
      model('Thing', {
        fields: [
          idField(),
          field('status', {
            enumName: 'Status',
            default: { kind: 'enumValue', value: 'LIVE' },
          }),
          field('other', {
            enumName: 'Status',
            isNullable: true,
            default: { kind: 'literal', value: 'draft' },
          }),
        ],
      }),
    ],
    [STATUS]
  );

  it('writes a pgEnum on PostgreSQL, with the values and a union type', () => {
    const text: string = emit(schema).files[DRIZZLE_SCHEMA_FILE] ?? '';
    expect(text).toContain(
      [
        '// Status: draft = Draft, live',
        "export const statusValues = ['draft', 'live'] as const;",
        'export type Status = (typeof statusValues)[number];',
        "export const statusEnum = pgEnum('Status', statusValues);",
      ].join('\n')
    );
    expect(column(text, 'status')).toBe(
      "statusEnum('status').notNull().default('live')"
    );
    expect(column(text, 'other')).toBe("statusEnum('other').default('draft')");
  });

  it('writes mysqlEnum columns on MySQL', () => {
    const text: string =
      emit(schema, { provider: 'mysql' }).files[DRIZZLE_SCHEMA_FILE] ?? '';
    expect(text).not.toContain('pgEnum');
    expect(column(text, 'status')).toBe(
      "mysqlEnum('status', statusValues).notNull().default('live')"
    );
  });

  it('writes text with an enum list on SQLite', () => {
    const text: string =
      emit(schema, { provider: 'sqlite' }).files[DRIZZLE_SCHEMA_FILE] ?? '';
    expect(column(text, 'status')).toBe(
      "text('status', { enum: statusValues }).notNull().default('live')"
    );
  });

  it('uses the database name of the enum and snake_cases it when normalizing', () => {
    const named: IrSchema = schemaOf(
      [],
      [{ ...STATUS, name: 'PostStatus', dbName: 'PostStatusT' }]
    );
    expect(emit(named).files[DRIZZLE_SCHEMA_FILE]).toContain(
      "pgEnum('PostStatusT', postStatusValues)"
    );
    expect(
      emit(named, { naming: 'normalize' }).files[DRIZZLE_SCHEMA_FILE]
    ).toContain("pgEnum('post_status_t', postStatusValues)");
  });

  it('warns about a missing or empty enum and writes a plain string', () => {
    const broken: IrSchema = schemaOf(
      [
        model('Thing', {
          fields: [
            field('a', { enumName: 'Nope', maxLength: 5 }),
            field('b', { enumName: 'Empty', maxLength: 5 }),
          ],
        }),
      ],
      [{ name: 'Empty', values: [] }]
    );
    const output: MultiFileEmitOutput = emit(broken);
    expect(output.warnings).toEqual([
      'enum Empty: an enum without values cannot be written; fields that use it became plain strings.',
      'Thing.a: enum "Nope" does not exist in the schema; the column was written as a plain string.',
      'Thing.b: enum "Empty" does not exist in the schema; the column was written as a plain string.',
    ]);
    expect(column(output.files[DRIZZLE_SCHEMA_FILE] ?? '', 'a')).toBe(
      "varchar('a', { length: 5 }).notNull()"
    );
  });

  it('warns about an enum default that is not a member and writes it as given', () => {
    const odd: IrSchema = schemaOf(
      [
        model('Thing', {
          fields: [
            field('s', {
              enumName: 'Status',
              default: { kind: 'enumValue', value: 'MISSING' },
            }),
          ],
        }),
      ],
      [STATUS]
    );
    const output: MultiFileEmitOutput = emit(odd);
    expect(output.warnings).toEqual([
      'Thing.s: the enum default "MISSING" does not match a member of the enum; it was written as a string.',
    ]);
    expect(output.files[DRIZZLE_SCHEMA_FILE]).toContain(".default('MISSING')");
  });

  it('keeps enum arrays on PostgreSQL', () => {
    const text: string =
      emit(
        schemaOf(
          [
            model('Thing', {
              fields: [field('s', { enumName: 'Status', arrayDepth: 1 })],
            }),
          ],
          [STATUS]
        )
      ).files[DRIZZLE_SCHEMA_FILE] ?? '';
    expect(column(text, 's')).toBe("statusEnum('s').array().notNull()");
  });
});

describe('drizzle emitter: references', () => {
  it('writes references with referential actions', () => {
    const schema: IrSchema = schemaOf([
      model('Parent'),
      model('Child', {
        relations: [
          relation('cascade', 'Parent', { onDelete: 'cascade' }),
          relation('nullify', 'Parent', {
            onDelete: 'setNull',
            isNullable: true,
            onUpdate: 'restrict',
          }),
          relation('restrict', 'Parent', { onDelete: 'restrict' }),
          relation('plain', 'Parent', { onDelete: 'noAction' }),
          relation('defaulted', 'Parent', {
            onDelete: 'setDefault',
            onUpdate: 'cascade',
          }),
        ],
      }),
    ]);
    const text: string = emit(schema).files[DRIZZLE_SCHEMA_FILE] ?? '';
    expect(column(text, 'cascadeId')).toBe(
      "integer('cascade_id').notNull().references(() => parent.id, { onDelete: 'cascade' })"
    );
    expect(column(text, 'nullifyId')).toBe(
      "integer('nullify_id').references(() => parent.id, { onDelete: 'set null', onUpdate: 'restrict' })"
    );
    expect(column(text, 'restrictId')).toBe(
      "integer('restrict_id').notNull().references(() => parent.id, { onDelete: 'restrict' })"
    );
    expect(column(text, 'plainId')).toBe(
      "integer('plain_id').notNull().references(() => parent.id)"
    );
    expect(column(text, 'defaultedId')).toBe(
      "integer('defaulted_id').notNull().references(() => parent.id, { onDelete: 'set default', onUpdate: 'cascade' })"
    );
  });

  it('leaves out SET DEFAULT on MySQL with a warning', () => {
    const schema: IrSchema = schemaOf([
      model('Parent'),
      model('Child', {
        relations: [
          relation('parent', 'Parent', {
            onDelete: 'setDefault',
            onUpdate: 'setDefault',
          }),
        ],
      }),
    ]);
    const output: MultiFileEmitOutput = emit(schema, { provider: 'mysql' });
    expect(output.warnings).toEqual([
      'Child.parent: MySQL (InnoDB) does not support ON DELETE SET DEFAULT; the action was left at the default (NO ACTION).',
      'Child.parent: MySQL (InnoDB) does not support ON UPDATE SET DEFAULT; the action was left at the default (NO ACTION).',
    ]);
    expect(column(output.files[DRIZZLE_SCHEMA_FILE] ?? '', 'parentId')).toBe(
      "int('parent_id').notNull().references(() => parent.id)"
    );
  });

  it('warns about SET NULL on a required relation', () => {
    const schema: IrSchema = schemaOf([
      model('Parent'),
      model('Child', {
        relations: [relation('parent', 'Parent', { onDelete: 'setNull' })],
      }),
    ]);
    expect(warningsOf(schema)).toEqual([
      'Child.parent: onDelete SET NULL on a required relation will fail at the database level; review the relation.',
    ]);
  });

  it('copies the type of the referenced key (UUID, big integer, sized text)', () => {
    const schema: IrSchema = schemaOf([
      model('Owner', {
        fields: [
          field('id', {
            type: 'uuid',
            isPrimaryKey: true,
            default: { kind: 'uuid' },
          }),
        ],
      }),
      model('Big', { fields: [idField({ type: 'bigInt' })] }),
      model('Coded', {
        fields: [field('code', { maxLength: 6, isPrimaryKey: true })],
      }),
      model('Child', {
        relations: [
          relation('owner', 'Owner'),
          relation('big', 'Big'),
          relation('coded', 'Coded'),
        ],
      }),
    ]);
    const text: string = emit(schema).files[DRIZZLE_SCHEMA_FILE] ?? '';
    expect(column(text, 'ownerId')).toContain("uuid('owner_id')");
    expect(column(text, 'bigId')).toContain(
      "bigint('big_id', { mode: 'number' })"
    );
    expect(column(text, 'codedId')).toContain(
      "varchar('coded_id', { length: 6 })"
    );
    const sqlite: string =
      emit(schema, { provider: 'sqlite' }).files[DRIZZLE_SCHEMA_FILE] ?? '';
    expect(column(sqlite, 'ownerId')).toContain("text('owner_id')");
    expect(column(sqlite, 'bigId')).toContain("integer('big_id')");
  });

  it('references the to_field column instead of the primary key', () => {
    const schema: IrSchema = schemaOf([
      model('Target', {
        fields: [idField(), field('slug', { maxLength: 9, isUnique: true })],
      }),
      model('Child', {
        relations: [relation('target', 'Target', { toField: 'slug' })],
      }),
    ]);
    const text: string = emit(schema).files[DRIZZLE_SCHEMA_FILE] ?? '';
    expect(column(text, 'targetId')).toBe(
      "varchar('target_id', { length: 9 }).notNull().references(() => target.slug, { onDelete: 'cascade' })"
    );
    expect(text).toContain('references: [target.slug]');
  });

  it('writes a one-to-one foreign key as unique', () => {
    const schema: IrSchema = schemaOf([
      model('Parent'),
      model('Extra', {
        relations: [relation('parent', 'Parent', { kind: 'oneToOne' })],
      }),
    ]);
    const text: string = emit(schema).files[DRIZZLE_SCHEMA_FILE] ?? '';
    expect(column(text, 'parentId')).toBe(
      "integer('parent_id').notNull().unique().references(() => parent.id, { onDelete: 'cascade' })"
    );
  });

  it('writes a relation that is the primary key as the primary key, not unique', () => {
    const schema: IrSchema = schemaOf([
      model('Parent'),
      model('Profile', {
        fields: [],
        relations: [
          relation('parent', 'Parent', {
            kind: 'oneToOne',
            isPrimaryKey: true,
          }),
        ],
      }),
    ]);
    const text: string = emit(schema).files[DRIZZLE_SCHEMA_FILE] ?? '';
    expect(column(text, 'parentId')).toBe(
      "integer('parent_id').primaryKey().references(() => parent.id, { onDelete: 'cascade' })"
    );
  });

  it('follows a key relation chain to the real column type', () => {
    const schema: IrSchema = schemaOf([
      model('Base', { fields: [idField({ type: 'bigInt' })] }),
      model('Mid', {
        fields: [],
        relations: [
          relation('base', 'Base', {
            kind: 'oneToOne',
            isPrimaryKey: true,
            columnName: 'base_ptr_id',
          }),
        ],
      }),
      model('Leaf', {
        fields: [],
        relations: [
          relation('mid', 'Mid', { kind: 'oneToOne', isPrimaryKey: true }),
        ],
      }),
    ]);
    const text: string = emit(schema).files[DRIZZLE_SCHEMA_FILE] ?? '';
    expect(text).toContain("midId: bigint('mid_id', { mode: 'number' })");
    expect(text).toContain('.references(() => mid.basePtrId');
  });

  it('puts a relation that is part of a composite key in the key', () => {
    const schema: IrSchema = schemaOf([
      model('A'),
      model('B'),
      model('Link', {
        fields: [],
        relations: [relation('a', 'A'), relation('b', 'B')],
        compositePrimaryKey: ['a', 'b'],
      }),
    ]);
    const text: string = emit(schema).files[DRIZZLE_SCHEMA_FILE] ?? '';
    expect(text).toContain('primaryKey({ columns: [table.aId, table.bId] })');
    expect(column(text, 'aId')).toContain('.notNull()');
    expect(column(text, 'aId')).not.toContain('.primaryKey()');
  });

  it('skips relations to a missing model or to a model without a single-column key', () => {
    const schema: IrSchema = schemaOf([
      model('Keyless', { fields: [field('x', { type: 'int' })] }),
      model('Child', {
        relations: [relation('ghost', 'Ghost'), relation('keyless', 'Keyless')],
      }),
    ]);
    const output: MultiFileEmitOutput = emit(schema);
    expect(output.warnings).toEqual([
      'Child.ghost: target model "Ghost" does not exist in the schema; the relation was skipped.',
      'Child.keyless: target model "Keyless" has no single-column primary key to reference; the relation was skipped.',
    ]);
    const text: string = output.files[DRIZZLE_SCHEMA_FILE] ?? '';
    expect(text).not.toContain('ghostId');
    expect(text).not.toContain('keylessId');
    expect(text).not.toContain('childRelations');
  });
});

describe('drizzle emitter: table order and cycles', () => {
  function order(text: string): string[] {
    return [...text.matchAll(/^export const (\w+) = \w+Table\(/gm)].map(
      (match: RegExpMatchArray) => match[1] ?? ''
    );
  }

  it('declares a table after the tables it references', () => {
    const schema: IrSchema = schemaOf([
      model('Comment', { relations: [relation('post', 'Post')] }),
      model('Post', { relations: [relation('author', 'Author')] }),
      model('Author'),
    ]);
    const text: string = emit(schema).files[DRIZZLE_SCHEMA_FILE] ?? '';
    expect(order(text)).toEqual(['author', 'post', 'comment']);
    expect(text).not.toContain('AnyPgColumn');
  });

  it.each([
    ['postgresql', 'AnyPgColumn'],
    ['mysql', 'AnyMySqlColumn'],
    ['sqlite', 'AnySQLiteColumn'],
  ] as const)(
    'annotates a self reference and a cycle with the dialect column type (%s)',
    (provider, anyColumn) => {
      const schema: IrSchema = schemaOf([
        model('Node', {
          relations: [
            relation('parent', 'Node', {
              isNullable: true,
              onDelete: 'setNull',
            }),
            relation('owner', 'Owner'),
          ],
        }),
        model('Owner', {
          relations: [relation('root', 'Node', { isNullable: true })],
        }),
      ]);
      const text: string =
        emit(schema, { provider }).files[DRIZZLE_SCHEMA_FILE] ?? '';
      expect(text).toContain(`type ${anyColumn},`);
      expect(column(text, 'parentId')).toContain(
        `.references((): ${anyColumn} => node.id`
      );
      // One side of the cycle points back at a table declared later.
      const annotated: number = (
        text.match(new RegExp(`\\(\\): ${anyColumn} =>`, 'g')) ?? []
      ).length;
      expect(annotated).toBe(2);
    }
  );
});

describe('drizzle emitter: relations()', () => {
  it('writes both sides of a foreign key and of a one-to-one', () => {
    const schema: IrSchema = schemaOf([
      model('User'),
      model('Post', {
        relations: [relation('author', 'User', { relatedName: 'written' })],
      }),
      model('Profile', {
        relations: [relation('user', 'User', { kind: 'oneToOne' })],
      }),
    ]);
    const text: string = emit(schema).files[DRIZZLE_SCHEMA_FILE] ?? '';
    expect(text).toContain(
      [
        'export const userRelations = relations(user, ({ one, many }) => ({',
        '  written: many(post),',
        '  profile: one(profile),',
        '}));',
      ].join('\n')
    );
    expect(text).toContain(
      [
        'export const postRelations = relations(post, ({ one }) => ({',
        '  author: one(user, {',
        '    fields: [post.authorId],',
        '    references: [user.id],',
        '  }),',
        '}));',
      ].join('\n')
    );
    expect(text).toContain("import { relations } from 'drizzle-orm';");
  });

  it('names an unnamed reverse relation after the plural of the model', () => {
    const schema: IrSchema = schemaOf([
      model('Category'),
      model('Box'),
      model('Item', {
        relations: [relation('category', 'Category'), relation('box', 'Box')],
      }),
      model('Entry', { relations: [relation('category', 'Category')] }),
      model('Story', { relations: [relation('box', 'Box')] }),
    ]);
    const text: string = emit(schema).files[DRIZZLE_SCHEMA_FILE] ?? '';
    expect(text).toContain('items: many(item),');
    expect(text).toContain('entries: many(entry),');
    expect(text).toContain('stories: many(story),');
    expect(text).toContain('items: many(item),');
  });

  it('adds relationName to both sides when two relations join the same tables', () => {
    const schema: IrSchema = schemaOf([
      model('User'),
      model('Post', {
        relations: [
          relation('author', 'User', { relatedName: 'written' }),
          relation('editor', 'User', { relatedName: 'edited' }),
        ],
      }),
    ]);
    const text: string = emit(schema).files[DRIZZLE_SCHEMA_FILE] ?? '';
    expect(text).toContain(
      "written: many(post, { relationName: 'Post_author' }),"
    );
    expect(text).toContain(
      "edited: many(post, { relationName: 'Post_editor' }),"
    );
    expect(text).toContain("relationName: 'Post_author',");
    expect(text).toContain("relationName: 'Post_editor',");
  });

  it('adds relationName for a self reference', () => {
    const schema: IrSchema = schemaOf([
      model('Node', {
        relations: [
          relation('parent', 'Node', {
            isNullable: true,
            relatedName: 'children',
          }),
        ],
      }),
    ]);
    const text: string = emit(schema).files[DRIZZLE_SCHEMA_FILE] ?? '';
    expect(text).toContain(
      "children: many(node, { relationName: 'Node_parent' }),"
    );
    expect(text).toContain("relationName: 'Node_parent',");
  });

  it('adds relationName when two tables point at each other', () => {
    const schema: IrSchema = schemaOf([
      model('A', { relations: [relation('b', 'B')] }),
      model('B', { relations: [relation('a', 'A')] }),
    ]);
    const text: string = emit(schema).files[DRIZZLE_SCHEMA_FILE] ?? '';
    expect(text).toContain("relationName: 'A_b',");
    expect(text).toContain("relationName: 'B_a',");
  });

  it('does not let a relation shadow a column of the same name', () => {
    const schema: IrSchema = schemaOf([
      model('Parent'),
      model('Child', {
        relations: [relation('parent', 'Parent', { columnName: 'parent' })],
      }),
    ]);
    const text: string = emit(schema).files[DRIZZLE_SCHEMA_FILE] ?? '';
    expect(text).toContain("parent: integer('parent')");
    expect(text).toContain('parent2: one(parent, {');
  });

  it('does not write relations() for tables without relations', () => {
    const text: string =
      emit(schemaOf([model('Solo')])).files[DRIZZLE_SCHEMA_FILE] ?? '';
    expect(text).not.toContain('relations(');
    expect(text).not.toContain("from 'drizzle-orm'");
  });
});

describe('drizzle emitter: many-to-many', () => {
  const schema: IrSchema = schemaOf([
    model('Post', {
      tableName: 'blog_post',
      relations: [
        relation('tags', 'Tag', { kind: 'manyToMany', columnName: 'tags_id' }),
      ],
    }),
    model('Tag', { tableName: 'blog_tag' }),
  ]);

  it('writes the join table Django would create, in both naming modes', () => {
    for (const naming of ['preserve', 'normalize'] as const) {
      const text: string =
        emit(schema, { naming }).files[DRIZZLE_SCHEMA_FILE] ?? '';
      expect(text).toContain('export const postTags = pgTable(');
      expect(text).toMatch(/'blog_post_tags'|'post_tag'/);
      expect(text).toContain('uniqueIndex(');
    }
    const text: string = emit(schema).files[DRIZZLE_SCHEMA_FILE] ?? '';
    expect(text).toContain("'blog_post_tags'");
    expect(column(text, 'postId')).toBe(
      "integer('post_id').notNull().references(() => post.id, { onDelete: 'cascade' })"
    );
    expect(column(text, 'tagId')).toBe(
      "integer('tag_id').notNull().references(() => tag.id, { onDelete: 'cascade' })"
    );
    expect(text).toContain(
      "uniqueIndex('blog_post_tags_post_id_tag_id_key').on(table.postId, table.tagId)"
    );
  });

  it('writes many() to the join table on both sides and one() back', () => {
    const text: string = emit(schema).files[DRIZZLE_SCHEMA_FILE] ?? '';
    expect(text).toContain(
      'export const postRelations = relations(post, ({ many }) => ({\n  postTags: many(postTags),\n}));'
    );
    expect(text).toContain(
      'export const tagRelations = relations(tag, ({ many }) => ({\n  postTags: many(postTags),\n}));'
    );
    expect(text).toContain('post: one(post, {');
    expect(text).toContain('tag: one(tag, {');
  });

  it('tells the two sides of a self-referencing many-to-many apart', () => {
    const selfSchema: IrSchema = schemaOf([
      model('Group', {
        relations: [
          relation('friends', 'Group', {
            kind: 'manyToMany',
            columnName: 'friends_id',
          }),
        ],
      }),
    ]);
    const text: string = emit(selfSchema).files[DRIZZLE_SCHEMA_FILE] ?? '';
    expect(text).toContain("fromGroupId: integer('from_group_id')");
    expect(text).toContain("toGroupId: integer('to_group_id')");
    expect(text).toContain(
      "groupFriendsFromGroup: many(groupFriends, { relationName: 'GroupFriends_from_group' }),"
    );
    expect(text).toContain(
      "groupFriendsToGroup: many(groupFriends, { relationName: 'GroupFriends_to_group' }),"
    );
  });
});

describe('drizzle emitter: indexes', () => {
  it('writes indexes and unique indexes with the name from the source', () => {
    const text: string = schemaFor(
      [idField(), field('a', { maxLength: 4 }), field('b', { type: 'int' })],
      'postgresql',
      {
        indexes: [
          index(['a'], { name: 'thing_a_custom' }),
          index(['a', 'b'], { isUnique: true, name: 'thing_ab_uq' }),
        ],
      }
    );
    expect(text).toContain("index('thing_a_custom').on(table.a),");
    expect(text).toContain("uniqueIndex('thing_ab_uq').on(table.a, table.b),");
    expect(text).toContain('  (table) => [');
  });

  it('names unnamed indexes from the table and column names, avoiding clashes', () => {
    const text: string = schemaFor(
      [idField(), field('a', { columnName: 'col_a' }), field('b')],
      'postgresql',
      {
        tableName: 'things',
        indexes: [
          index(['a']),
          index(['a'], { isUnique: true }),
          index(['a']),
          index(['a', 'b']),
        ],
      }
    );
    expect(text).toContain("index('things_col_a_idx').on(table.a),");
    expect(text).toContain("uniqueIndex('things_col_a_key').on(table.a),");
    expect(text).toContain("index('things_col_a_idx2').on(table.a),");
    expect(text).toContain("index('things_col_a_b_idx').on(table.a, table.b),");
  });

  it('shortens a long generated name to the identifier limit', () => {
    const longName: string = 'a_very_long_column_name_that_keeps_going_on';
    const text: string = schemaFor(
      [
        idField(),
        field('x', { columnName: longName }),
        field('y', { columnName: longName + '_2' }),
      ],
      'postgresql',
      {
        tableName: 'a_table_with_a_long_name_as_well',
        indexes: [index(['x', 'y'])],
      }
    );
    const name: string = /index\('([^']+)'\)/.exec(text)?.[1] ?? '';
    expect(name.length).toBeLessThanOrEqual(63);
    expect(name).toMatch(/_[0-9a-f]{6}$/);
  });

  it('resolves relation and column names inside indexes', () => {
    const schema: IrSchema = schemaOf([
      model('Parent'),
      model('Child', {
        fields: [idField(), field('title', { columnName: 'ttl' })],
        relations: [relation('parent', 'Parent')],
        indexes: [index(['parent', 'ttl'])],
      }),
    ]);
    const text: string = emit(schema).files[DRIZZLE_SCHEMA_FILE] ?? '';
    expect(text).toContain(
      "index('child_parent_id_ttl_idx').on(table.parentId, table.title)"
    );
  });

  it('skips an index on an unknown field with a warning', () => {
    const schema: IrSchema = schemaOf([
      model('Thing', { indexes: [index(['nope'])] }),
    ]);
    const output: MultiFileEmitOutput = emit(schema);
    expect(output.warnings).toEqual([
      'Thing: an index references "nope", which is not a field of the model; the index was skipped.',
    ]);
    expect(output.files[DRIZZLE_SCHEMA_FILE]).not.toContain('(table) =>');
  });

  it('reports Prisma-only index options as dropped', () => {
    const schema: IrSchema = schemaOf([
      model('Thing', {
        fields: [idField(), field('a')],
        indexes: [index(['a'], { method: 'Hash', kind: 'fulltext' })],
      }),
    ]);
    expect(warningsOf(schema).join('\n')).toContain(
      'full-text indexes are not supported here'
    );
    expect(warningsOf(schema).join('\n')).toContain('options were dropped');
  });
});

describe('drizzle emitter: names', () => {
  it('writes camelCase keys and keeps the database names in preserve mode', () => {
    const schema: IrSchema = schemaOf([
      model('BlogPost', {
        tableName: 'Blog_Post',
        fields: [
          field('post_id', {
            columnName: 'PostID',
            type: 'int',
            isPrimaryKey: true,
          }),
          field('HTTPCode', { columnName: 'http-code', type: 'int' }),
        ],
      }),
    ]);
    const text: string = emit(schema).files[DRIZZLE_SCHEMA_FILE] ?? '';
    expect(text).toContain("export const blogPost = pgTable('Blog_Post', {");
    expect(column(text, 'postId')).toBe("integer('PostID').primaryKey()");
    expect(column(text, 'httpCode')).toBe("integer('http-code').notNull()");
    expect(text).toContain(
      'export type BlogPost = typeof blogPost.$inferSelect;'
    );
  });

  it('applies the fresh-schema conventions in normalize mode', () => {
    const schema: IrSchema = schemaOf([
      model('BlogPost', {
        tableName: 'Blog_Posts',
        fields: [idField(), field('Title', { columnName: 'Title' })],
      }),
    ]);
    const text: string =
      emit(schema, { naming: 'normalize' }).files[DRIZZLE_SCHEMA_FILE] ?? '';
    expect(text).toContain("export const blogPost = pgTable('blog_post', {");
    expect(column(text, 'id')).toBe("uuid('id').primaryKey().defaultRandom()");
    expect(column(text, 'title')).toBe("text('title').notNull()");
    expect(column(text, 'createdAt')).toBe(
      "timestamp('created_at', { withTimezone: true }).notNull().defaultNow()"
    );
    expect(column(text, 'updatedAt')).toBe(
      "timestamp('updated_at', { withTimezone: true }).notNull().$onUpdate(() => new Date())"
    );
  });

  it('avoids names that are Drizzle builders, JavaScript words or already taken', () => {
    const schema: IrSchema = schemaOf([
      model('index', { tableName: 'idx' }),
      model('Class', { tableName: 'cls' }),
      model('Sql', { tableName: 'sqlt' }),
      model('Table', { tableName: 'tbl' }),
      model('thing', { tableName: 'thing_a' }),
      model('Thing', { tableName: 'thing_b' }),
    ]);
    const text: string = emit(schema).files[DRIZZLE_SCHEMA_FILE] ?? '';
    const names: string[] = [
      ...text.matchAll(/^export const (\w+) = pgTable/gm),
    ].map((match: RegExpMatchArray) => match[1] ?? '');
    expect(names).toEqual([
      'index2',
      'class2',
      'sql2',
      'table2',
      'thing',
      'thing2',
    ]);
    const types: string[] = [
      ...text.matchAll(/^export type (\w+) = typeof/gm),
    ].map((match: RegExpMatchArray) => match[1] ?? '');
    expect(new Set(types).size).toBe(types.length);
  });

  it('makes duplicate and invalid property names valid and warns', () => {
    const schema: IrSchema = schemaOf([
      model('Thing', {
        fields: [
          idField(),
          field('first_name'),
          field('firstName', { columnName: 'first_name_2' }),
          field('1st', { columnName: 'first' }),
          field('???', { columnName: 'q' }),
        ],
      }),
    ]);
    const output: MultiFileEmitOutput = emit(schema);
    const text: string = output.files[DRIZZLE_SCHEMA_FILE] ?? '';
    expect(text).toContain("firstName: text('first_name').notNull(),");
    expect(text).toContain("firstName2: text('first_name_2').notNull(),");
    expect(text).toContain("_1st: text('first').notNull(),");
    expect(text).toContain("_: text('q').notNull(),");
    expect(output.warnings).toHaveLength(2);
    expect(output.warnings[0]).toContain('Thing.1st');
  });
});

describe('drizzle emitter: warnings from the shared checks', () => {
  it('writes views as tables and warns', () => {
    const schema: IrSchema = schemaOf([
      model('Summary', { isView: true, tableName: 'summary' }),
    ]);
    const output: MultiFileEmitOutput = emit(schema);
    expect(output.warnings).toEqual([
      'Summary: this is a database view; it was written like a regular table model, so migrations would try to create a table.',
    ]);
    expect(output.files[DRIZZLE_SCHEMA_FILE]).toContain("pgTable('summary'");
  });

  it('does not warn about onUpdate, which Drizzle writes', () => {
    const schema: IrSchema = schemaOf([
      model('Parent'),
      model('Child', {
        relations: [relation('parent', 'Parent', { onUpdate: 'cascade' })],
      }),
    ]);
    expect(warningsOf(schema)).toEqual([]);
  });

  it('warns about composite foreign keys and database schemas', () => {
    const schema: IrSchema = schemaOf([
      model('Thing', {
        schema: 'audit',
        compositeForeignKeys: [
          {
            name: 'order',
            targetModel: 'Thing',
            fields: ['a', 'b'],
            references: ['x', 'y'],
            kind: 'foreignKey',
            isNullable: false,
            onDelete: 'cascade',
          },
        ],
      }),
    ]);
    const warnings: string[] = warningsOf(schema);
    expect(warnings).toHaveLength(2);
    expect(warnings.join('\n')).toContain('composite foreign key');
    expect(warnings.join('\n')).toContain('"audit"');
  });
});

describe('drizzle emitter: the format adapter', () => {
  it('is registered as a write-only format that claims no extension', () => {
    const adapter = expectOk(getFormat('drizzle'));
    expect(adapter.parse).toBeUndefined();
    expect(adapter.emit).toBeDefined();
    expect(adapter.extensions).toEqual([]);
    expect(describeFormats(listFormats())).toMatch(
      /drizzle\s+extensions: \(none\) {2}write {2}Drizzle ORM schema/
    );
  });

  it('converts a canonical schema through convertText into two files', async () => {
    const sources = loadCanonicalSources('django');
    const result = expectOk(
      await convertText(sources, {
        ...DEFAULT_OPTIONS,
        to: 'drizzle',
        provider: 'sqlite',
      })
    );
    expect(Object.keys(result.files ?? {}).sort()).toEqual([
      DRIZZLE_CONFIG_FILE,
      DRIZZLE_SCHEMA_FILE,
    ]);
    expect(result.files?.[DRIZZLE_SCHEMA_FILE]).toContain('sqliteTable(');
    expect(result.output).toBe('');
  });

  it('passes the naming mode and provider options through', async () => {
    const adapter = expectOk(getFormat('drizzle'));
    const emitted: FormatEmitOutput = expectOk(
      adapter.emit?.(schemaOf([model('Post')]), {
        ...DEFAULT_OPTIONS,
        provider: 'mysql',
        naming: 'normalize',
      }) ?? { ok: false, error: { code: 'EMIT_FAILED', message: 'no emit' } }
    );
    expect(emitted.text).toBeUndefined();
    expect(emitted.files?.[DRIZZLE_SCHEMA_FILE]).toContain("mysqlTable('post'");
    expect(emitted.files?.[DRIZZLE_SCHEMA_FILE]).toContain('char(');
  });
});

describe('drizzle emitter: structural check', () => {
  it.each(CANONICAL_FIXTURES.map((fixture) => fixture.format))(
    'finds nothing missing for the canonical schema read from %s',
    async (format) => {
      const adapter = expectOk(getFormat(format));
      const schema: IrSchema = await parseWith(
        adapter,
        loadCanonicalSources(format)
      );
      const output: MultiFileEmitOutput = emit(schema);
      expect(checkDrizzleOutput(schema, output.files)).toEqual([]);
    }
  );

  it('lists what is missing from an incomplete output', () => {
    const schema: IrSchema = schemaOf(
      [
        model('Parent'),
        model('Child', { relations: [relation('parent', 'Parent')] }),
      ],
      [STATUS]
    );
    const text: string = emit(schema).files[DRIZZLE_SCHEMA_FILE] ?? '';
    const stripped: string = text
      .replace(/parentId: integer\('parent_id'\)[\s\S]*?\),\n/, '')
      .replace(/\.references\(/g, '.noop(')
      .replace(/export const statusValues[\s\S]*?\n/, '');
    expect(
      checkDrizzleOutput(schema, {
        [DRIZZLE_SCHEMA_FILE]: stripped,
      })
    ).toEqual([
      'no drizzle.config.ts file',
      'Child.parent: no column parent_id',
      'enum Status: no value list',
    ]);
    expect(checkDrizzleOutput(schema, {})).toEqual(['no schema.ts file']);
    expect(
      checkDrizzleOutput(schema, {
        [DRIZZLE_SCHEMA_FILE]: '',
        [DRIZZLE_CONFIG_FILE]: '',
      })
    ).toContain('Parent: no table parent');
  });
});

describe('drizzle emitter: golden files', () => {
  const goldenRoot: string = fileURLToPath(
    new URL('./golden-extras/', import.meta.url)
  );

  describe.each(['mysql', 'sqlite'] as const)('%s', (provider) => {
    describe.each(CANONICAL_FIXTURES.map((fixture) => fixture.format))(
      '%s source',
      (format) => {
        it.each(['preserve', 'normalize'] as const)(
          'matches the golden output (%s naming)',
          async (naming) => {
            const result = await convertCanonical(format, 'drizzle', {
              naming,
              provider,
            });
            expectFilesMatchGolden(
              `drizzle-${provider}/${format}-to-drizzle.${naming}`,
              result.files ?? {},
              goldenRoot
            );
          }
        );
      }
    );
  });

  describe.each([
    ['kitchen-sink', kitchenSinkSchema],
    ['stress', stressSchema],
    ['constructs', constructsSchema],
  ] as const)('%s fixture', (label, make) => {
    describe.each(PROVIDERS)('%s', (provider) => {
      it.each(['preserve', 'normalize'] as const)(
        'matches the golden output (%s naming)',
        (naming) => {
          const output: MultiFileEmitOutput = emit(make(), {
            provider,
            naming,
          });
          expectFilesMatchGolden(
            `drizzle-fixtures/${label}-${provider}.${naming}`,
            {
              ...output.files,
              'warnings.txt': `${output.warnings.join('\n')}\n`,
            },
            goldenRoot
          );
        }
      );
    });
  });
});
