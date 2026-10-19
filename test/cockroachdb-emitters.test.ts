import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  getFormat,
  type FormatAdapter,
  type FormatEmitOutput,
  type FormatOptions,
} from '../src/formats.js';
import {
  PRISMA_PROVIDERS,
  type PrismaProvider,
} from '../src/emitters/prisma.js';
import type { IrSchema } from '../src/ir.js';
import { cockroachSchema } from './cockroachFixtures.js';
import { expectOk } from './helpers.js';

/**
 * `--provider cockroachdb` across the writers. CockroachDB speaks the PostgreSQL wire protocol, so the
 * writers keep their PostgreSQL column types and change only what would fail or misbehave there; each
 * difference is a warning that starts with `Provider "cockroachdb":` or names the column.
 *
 * The goldens in test/golden-cockroachdb hold the whole output and the warnings for one schema
 * (test/cockroachFixtures.ts); run with UPDATE_GOLDEN=1 to rewrite them and read the diff.
 */

const GOLDEN_DIRECTORY: string = fileURLToPath(
  new URL('./golden-cockroachdb/', import.meta.url)
);

function expectMatchesGolden(name: string, actual: string): void {
  const goldenPath: string = `${GOLDEN_DIRECTORY}${name}`;
  if (process.env.UPDATE_GOLDEN === '1') {
    mkdirSync(dirname(goldenPath), { recursive: true });
    writeFileSync(goldenPath, actual);
    return;
  }
  if (!existsSync(goldenPath)) {
    throw new Error(
      `Golden file test/golden-cockroachdb/${name} does not exist. Run the tests with UPDATE_GOLDEN=1 to create it.`
    );
  }
  expect(actual).toBe(readFileSync(goldenPath, 'utf8'));
}

function optionsFor(provider: PrismaProvider): FormatOptions {
  return {
    naming: 'preserve',
    provider,
    header: true,
    appLabel: 'shop',
    autoField: 'int',
  };
}

interface Written {
  /** Every file, or the single text under the key "output". */
  files: Record<string, string>;
  warnings: string[];
}

function write(
  format: string,
  provider: PrismaProvider,
  schema: IrSchema = cockroachSchema(),
  overrides: Partial<FormatOptions> = {}
): Written {
  const adapter: FormatAdapter = expectOk(getFormat(format));
  if (adapter.emit === undefined) {
    throw new Error(`${format} cannot be written`);
  }
  const output: FormatEmitOutput = expectOk(
    adapter.emit(schema, { ...optionsFor(provider), ...overrides })
  );
  return {
    files: output.text === undefined ? output.files : { output: output.text },
    warnings: output.warnings,
  };
}

function textOf(written: Written, file?: string): string {
  if (file !== undefined) {
    const found: string | undefined = Object.entries(written.files).find(
      ([path]: [string, string]) => path === file || path.endsWith(`/${file}`)
    )?.[1];
    if (found === undefined) {
      throw new Error(
        `no file ${file}; files: ${Object.keys(written.files).join(', ')}`
      );
    }
    return found;
  }
  return Object.values(written.files).join('\n');
}

function render(written: Written): string {
  const single: boolean = Object.keys(written.files).join() === 'output';
  const body: string = single
    ? (written.files['output'] ?? '')
    : Object.entries(written.files)
        .sort(([left]: [string, string], [right]: [string, string]) =>
          left.localeCompare(right)
        )
        .map(([path, text]: [string, string]) => `=== ${path}\n${text}`)
        .join('\n');
  return `${body}\n--- warnings\n${written.warnings.join('\n')}\n`;
}

function cockroachWarnings(written: Written): string[] {
  return written.warnings.filter((warning: string) =>
    warning.startsWith('Provider "cockroachdb":')
  );
}

/** Every writer that reads the provider, with the extra options its goldens need. */
const WRITERS: readonly string[] = [
  'sql',
  'prisma',
  'typeorm',
  'drizzle',
  'sequelize',
  'gorm',
  'jpa',
  'sqlalchemy',
  'doctrine',
  'laravel',
  'efcore',
];

describe.each(WRITERS)('--provider cockroachdb: %s', (format) => {
  it('matches the stored output and warnings', () => {
    expectMatchesGolden(`${format}.txt`, render(write(format, 'cockroachdb')));
  });

  it('warns about the CockroachDB differences instead of writing PostgreSQL silently', () => {
    const warnings: string[] = write(format, 'cockroachdb').warnings.filter(
      (warning: string) => /cockroach/i.test(warning)
    );
    expect(warnings.length).toBeGreaterThan(0);
  });

  it('never mentions CockroachDB for the other providers', () => {
    for (const provider of PRISMA_PROVIDERS) {
      if (provider === 'cockroachdb') {
        continue;
      }
      const written: Written = write(format, provider);
      expect(
        `${render(written)}`.toLowerCase(),
        `${format} ${provider}`
      ).not.toContain('cockroach');
    }
  });
});

describe('--provider cockroachdb: SQL DDL', () => {
  const written: Written = write('sql', 'cockroachdb');
  const sql: string = textOf(written);
  const warnings: string = written.warnings.join('\n');

  it('spells 32-bit integers INT4, because a bare INT is 64-bit there', () => {
    expect(sql).toContain('age INT4');
    expect(sql).toContain('grid JSONB');
    expect(sql).toContain('visits BIGINT NOT NULL DEFAULT 0');
    expect(sql).not.toMatch(/\bINTEGER\b/);
  });

  it('writes auto-increment keys as identity columns and says why', () => {
    expect(sql).toContain('id INT4 GENERATED BY DEFAULT AS IDENTITY NOT NULL');
    expect(sql).toContain(
      'id BIGINT GENERATED BY DEFAULT AS IDENTITY NOT NULL'
    );
    expect(warnings).toMatch(
      /Provider "cockroachdb": Account\.id, Event\.id are auto-increment keys: written as GENERATED BY DEFAULT AS IDENTITY.*unique_rowid\(\).*gen_random_uuid\(\)/
    );
  });

  it('keeps the UUID default and the enum type', () => {
    expect(sql).toContain('id UUID NOT NULL DEFAULT gen_random_uuid()');
    expect(sql).toContain(`CREATE TYPE "Status" AS ENUM ('draft', 'live');`);
  });

  it('replaces hstore, ranges and multi-dimensional arrays, with a warning each', () => {
    expect(sql).toContain("attributes JSONB NOT NULL DEFAULT '{}'::jsonb");
    expect(sql).toContain('stock_range TEXT');
    expect(sql).not.toMatch(/HSTORE\b|INT4RANGE/);
    expect(sql).not.toContain('CREATE EXTENSION');
    expect(warnings).toContain(
      'Account.attributes: CockroachDB has no hstore type; the column was written as JSONB.'
    );
    expect(warnings).toContain(
      'Account.stock_range: CockroachDB has no range types (int4range, tstzrange, ...); the column was written as text.'
    );
    expect(warnings).toContain(
      'Account.grid: CockroachDB has no multi-dimensional arrays; the column was written as JSONB.'
    );
  });

  it('uses the column-level ON UPDATE that CockroachDB has', () => {
    expect(sql).toContain(
      'updated_at TIMESTAMPTZ NOT NULL DEFAULT now() ON UPDATE now()'
    );
    expect(warnings).not.toContain('cannot refresh a column on update');
  });

  it('keeps B-tree and GIN indexes and drops the methods CockroachDB lacks', () => {
    expect(sql).toContain(
      'CREATE INDEX accounts_created_at_idx ON accounts (created_at);'
    );
    expect(sql).toContain('USING gin (prefs);');
    expect(sql).toContain('USING gin (labels);');
    expect(sql).not.toMatch(/USING (hash|gist|brin)/i);
    expect(warnings).toContain(
      'has no hash indexes (only B-tree and inverted GIN); an ordinary index was written (CREATE INDEX ... USING HASH is a hash-sharded B-tree there, a different feature).'
    );
    expect(warnings).toContain('has no gist indexes');
    expect(warnings).toContain('has no brin indexes');
    // GIN over a bigint column is rejected by CockroachDB, so an ordinary index is written.
    expect(warnings).toContain(
      'builds an inverted (GIN) index only over JSONB, array, tsvector or spatial columns; "visits" is BIGINT, so an ordinary index was written.'
    );
    expect(warnings).toContain(
      'CockroachDB supports only trigram operator classes on inverted indexes; the operator class of "prefs" was dropped.'
    );
  });

  it('replaces MONEY and XML native types', () => {
    const native: IrSchema = {
      models: [
        {
          ...cockroachSchema().models[0]!,
          fields: [
            ...cockroachSchema().models[0]!.fields,
            field('price', 'Money'),
            field('doc', 'Xml'),
            field('plain', 'Integer'),
            field('raw', 'Json'),
          ],
        },
      ],
      enums: cockroachSchema().enums,
      warnings: [],
    };
    const output: Written = write('sql', 'cockroachdb', native);
    const text: string = textOf(output);
    expect(text).toContain('price NUMERIC(19, 4) NOT NULL');
    expect(text).toContain('doc TEXT NOT NULL');
    expect(text).toContain('plain INT4 NOT NULL');
    expect(text).toContain('raw JSONB NOT NULL');
    expect(output.warnings.join('\n')).toContain(
      'Tenant.price: CockroachDB has no MONEY type; the column was written as NUMERIC(19, 4).'
    );
    expect(output.warnings.join('\n')).toContain(
      'Tenant.raw: CockroachDB stores JSON as JSONB'
    );
  });

  it('warns about PostgreSQL types it cannot create instead of writing them silently', () => {
    const unsupported: IrSchema = {
      models: [
        {
          ...cockroachSchema().models[0]!,
          fields: [
            ...cockroachSchema().models[0]!.fields,
            {
              name: 'area',
              columnName: 'area',
              type: 'unsupported',
              unsupportedType: 'circle',
              isPrimaryKey: false,
              isUnique: false,
              isNullable: true,
              isAutoUpdated: false,
            },
            {
              name: 'place',
              columnName: 'place',
              type: 'unsupported',
              unsupportedType: 'geometry(Point, 4326)',
              isPrimaryKey: false,
              isUnique: false,
              isNullable: true,
              isAutoUpdated: false,
            },
          ],
        },
      ],
      enums: cockroachSchema().enums,
      warnings: [],
    };
    const output: Written = write('sql', 'cockroachdb', unsupported);
    const text: string = output.warnings.join('\n');
    expect(text).toContain(
      'Tenant.area: CockroachDB has no circle type; "circle" was written as it is, so CREATE TABLE fails until the column type is changed.'
    );
    // geometry exists on CockroachDB, so it is only reported as an Unsupported pass-through.
    expect(text).toContain(
      'Tenant.place: the database type "geometry(Point, 4326)" (Prisma Unsupported) was written as it is; check that CockroachDB has it.'
    );
  });

  it('treats the Prisma sequence() default as an auto-increment key', () => {
    const sequence: IrSchema = {
      models: [
        {
          ...cockroachSchema().models[2]!,
          fields: [
            {
              ...cockroachSchema().models[2]!.fields[0]!,
              default: {
                kind: 'dbExpression',
                expression: 'sequence()',
                isFunction: true,
              },
            },
          ],
          relations: [],
        },
      ],
      enums: [],
      warnings: [],
    };
    expect(textOf(write('sql', 'cockroachdb', sequence))).toContain(
      'id BIGINT GENERATED BY DEFAULT AS IDENTITY NOT NULL'
    );
  });
});

/** A required field of one Prisma native type, for the native-type tests. */
function field(
  name: string,
  nativeName: string
): IrSchema['models'][number]['fields'][number] {
  const types: Record<string, 'decimal' | 'string' | 'int' | 'json'> = {
    Money: 'decimal',
    Xml: 'string',
    Integer: 'int',
    Json: 'json',
  };
  return {
    name,
    columnName: name,
    type: types[nativeName] ?? 'string',
    isPrimaryKey: false,
    isUnique: false,
    isNullable: false,
    isAutoUpdated: false,
    nativeType: { name: nativeName, args: [] },
  };
}

describe('--provider cockroachdb: Prisma', () => {
  const written: Written = write('prisma', 'cockroachdb');
  const prisma: string = textOf(written);

  it('writes the cockroachdb datasource and sequence() for an Int key', () => {
    expect(prisma).toContain('provider = "cockroachdb"');
    expect(prisma).toContain('@default(sequence())');
    expect(prisma).toContain('@default(autoincrement())');
    expect(cockroachWarnings(written)).toEqual([]);
    expect(written.warnings.join('\n')).toContain(
      'CockroachDB allows autoincrement() only on BigInt; the Int default was written as sequence().'
    );
  });

  it('turns a PostgreSQL native type into the CockroachDB one', () => {
    const native: IrSchema = {
      models: [
        {
          ...cockroachSchema().models[0]!,
          fields: [
            cockroachSchema().models[0]!.fields[0]!,
            {
              ...field('a', 'Integer'),
              nativeType: { name: 'Integer', args: [] },
            },
            {
              ...field('b', 'Integer'),
              type: 'string',
              nativeType: { name: 'VarChar', args: ['32'] },
            },
            {
              ...field('c', 'Integer'),
              type: 'int',
              nativeType: { name: 'SmallInt', args: [] },
            },
            {
              ...field('d', 'Integer'),
              type: 'bigInt',
              nativeType: { name: 'BigInt', args: [] },
            },
            {
              ...field('e', 'Integer'),
              type: 'float',
              nativeType: { name: 'DoublePrecision', args: [] },
            },
            {
              ...field('f', 'Json'),
              nativeType: { name: 'Json', args: [] },
            },
          ],
          relations: [],
        },
      ],
      enums: [],
      warnings: [],
    };
    const output: Written = write('prisma', 'cockroachdb', native);
    const text: string = textOf(output);
    expect(text).toMatch(/a\s+Int\s+@db\.Int4/);
    expect(text).toMatch(/b\s+String\s+@db\.String\(32\)/);
    expect(text).toMatch(/c\s+Int\s+@db\.Int2/);
    expect(text).toMatch(/d\s+BigInt\s+@db\.Int8/);
    expect(text).toMatch(/e\s+Float\s+@db\.Float8/);
    expect(text).toMatch(/f\s+Json\s+@db\.JsonB/);
    expect(output.warnings.join('\n')).toContain(
      'Tenant.f: CockroachDB stores JSON as JSONB'
    );
    expect(output.warnings.join('\n')).not.toContain('is not available for');
  });

  it('writes a range column as String and warns, because CockroachDB has no range types', () => {
    expect(prisma).toMatch(/stock_range\s+String\?/);
    expect(written.warnings.join('\n')).toContain(
      'Account.stock_range: CockroachDB has no range types (int4range, tstzrange, ...); the field was written as String.'
    );
  });
});

describe('--provider cockroachdb: TypeORM', () => {
  const written: Written = write('typeorm', 'cockroachdb');
  const text: string = textOf(written);

  it('names the cockroachdb driver and spells integers int4 and int8', () => {
    expect(text.split('\n')[0]).toContain(`type: 'cockroachdb'`);
    expect(text).toContain(`type: 'int4'`);
    expect(text).toContain(`type: 'int8'`);
    expect(text).not.toContain(`type: 'int',`);
    expect(text).not.toContain(`type: 'bigint'`);
  });

  it('reads a sequence-backed key as a number and warns about sequential keys', () => {
    expect(text).toMatch(
      /@PrimaryGeneratedColumn\('increment'\)\n {2}id!: number;/
    );
    expect(cockroachWarnings(written).join('\n')).toContain(
      "@PrimaryGeneratedColumn('increment') creates a sequence-backed INT8 column"
    );
  });

  it('writes hstore as jsonb, a range as varchar and a nested array as jsonb', () => {
    expect(text).toMatch(
      /@Column\(\{ type: 'jsonb', default: \(\) => "'\{\}'" \}\)\n {2}attributes!/
    );
    expect(text).toMatch(
      /@Column\(\{ type: 'varchar', nullable: true \}\)\n {2}stock_range!/
    );
    expect(written.warnings.join('\n')).toContain(
      'Account.grid: CockroachDB has no multi-dimensional arrays; the array was written as jsonb.'
    );
  });
});

describe('--provider cockroachdb: Drizzle', () => {
  const written: Written = write('drizzle', 'cockroachdb');
  const text: string = textOf(written, 'schema.ts');

  it('uses pg-core with identity keys instead of serial', () => {
    expect(text).toContain("from 'drizzle-orm/pg-core'");
    expect(text).toContain(
      "id: integer('id').primaryKey().generatedByDefaultAsIdentity()"
    );
    expect(text.replace(/\s+/g, ' ')).toContain(
      "id: bigint('id', { mode: 'number' }) .primaryKey() .generatedByDefaultAsIdentity()"
    );
    expect(text).not.toMatch(/serial/i);
    expect(textOf(written, 'drizzle.config.ts')).toContain(
      "dialect: 'postgresql'"
    );
  });

  it('writes hstore as jsonb and a range as text, with warnings', () => {
    expect(text).toContain("attributes: jsonb('attributes')");
    expect(text).not.toContain('hstore');
    expect(written.warnings.join('\n')).toContain(
      'Account.attributes: CockroachDB has no hstore type; the field was written as jsonb.'
    );
  });

  it('mentions cockroach-core in the notice', () => {
    expect(cockroachWarnings(written)[0]).toContain(
      'drizzle-orm/cockroach-core'
    );
  });
});

describe('--provider cockroachdb: Sequelize', () => {
  const written: Written = write('sequelize', 'cockroachdb');

  it('writes JSONB for hstore, TEXT for a range, and points at sequelize-cockroachdb', () => {
    const account: string = textOf(written, 'account.ts');
    expect(account).toMatch(/attributes: \{\s+type: DataTypes\.JSONB/);
    expect(account).toContain('stock_range: DataTypes.TEXT');
    expect(account).not.toContain('HSTORE');
    expect(textOf(written, 'index.ts')).toContain(
      "import { Sequelize } from 'sequelize-cockroachdb';"
    );
    expect(cockroachWarnings(written)[0]).toContain('sequelize-cockroachdb');
  });

  it('drops the index methods CockroachDB lacks', () => {
    const account: string = textOf(written, 'account.ts');
    expect(account).toContain(`using: 'GIN'`);
    expect(account).not.toMatch(/using: '(HASH|GIST|BRIN)'/);
    // The operator class (jsonb_path_ops) does not exist on CockroachDB, and bigint cannot be inverted.
    expect(account).not.toContain('operator');
    expect(written.warnings.join('\n')).toContain(
      'CockroachDB supports only trigram operator classes on inverted indexes; the operator class of "prefs" was dropped.'
    );
    expect(written.warnings.join('\n')).toContain(
      'Account index (visits): CockroachDB builds an inverted (GIN) index only over JSON, array or spatial columns, so USING GIN was dropped.'
    );
    expect(written.warnings.join('\n')).toContain(
      'CockroachDB has no HASH indexes (only B-tree and inverted GIN); USING HASH was dropped.'
    );
  });
});

describe('--provider cockroachdb: GORM', () => {
  const written: Written = write('gorm', 'cockroachdb');
  const text: string = textOf(written);

  it('writes 64-bit auto-increment keys and the foreign keys that point at them', () => {
    expect(text).toMatch(/ID\s+int64\s+`gorm:"primaryKey;autoIncrement"`/);
    expect(text).toMatch(/AccountID\s+\*int64/);
    // A column that is not a key stays a 32-bit Go integer.
    expect(text).toMatch(/Age\s+\*int32/);
    expect(text).toMatch(/default:gen_random_uuid\(\)/);
  });

  it('says how to open it and why the keys are int64', () => {
    const notices: string = cockroachWarnings(written).join('\n');
    expect(notices).toContain('gorm.Open(postgres.Open(dsn))');
    expect(notices).toContain('overflow an int32');
  });
});

describe('--provider cockroachdb: JPA', () => {
  const written: Written = write('jpa', 'cockroachdb');

  it('writes a Long identity key, a JSON column for hstore and text for a range', () => {
    const account: string = textOf(written, 'Account.java');
    expect(account).toContain('private Long id;');
    expect(account).toContain('private Map<String, Object> attributes;');
    expect(account).toContain(
      '@Column(name = "stock_range", columnDefinition = "text")'
    );
    expect(account).not.toContain('hstore');
  });

  it('names the Hibernate dialect for both styles', () => {
    expect(cockroachWarnings(written)[0]).toContain(
      'org.hibernate.dialect.CockroachDialect (Hibernate 6)'
    );
    expect(
      cockroachWarnings(
        write('jpa', 'cockroachdb', cockroachSchema(), { style: 'javax' })
      )[0]
    ).toContain('org.hibernate.dialect.CockroachDB201Dialect (Hibernate 5)');
  });
});

describe('--provider cockroachdb: SQLAlchemy', () => {
  const written: Written = write('sqlalchemy', 'cockroachdb');
  const text: string = textOf(written);

  it('writes JSON for hstore and nested arrays and Text for a range, without the PostgreSQL-only imports', () => {
    expect(text).toContain(
      'attributes: Mapped[dict[str, str]] = mapped_column(JSON, default=dict)'
    );
    expect(text).toContain(
      'grid: Mapped[Optional[list[list[int]]]] = mapped_column(JSON)'
    );
    expect(text).toContain(
      'stock_range: Mapped[Optional[str]] = mapped_column(Text)'
    );
    expect(text).not.toMatch(/HSTORE|INT4RANGE/);
  });

  it('names the dialect and the URL', () => {
    expect(cockroachWarnings(written)[0]).toContain('sqlalchemy-cockroachdb');
    expect(cockroachWarnings(written)[0]).toContain('cockroachdb://');
  });

  it('writes the same for SQLModel and leaves the other providers alone', () => {
    const model: Written = write(
      'sqlalchemy',
      'cockroachdb',
      cockroachSchema(),
      { style: 'sqlmodel' }
    );
    expect(textOf(model)).not.toMatch(/HSTORE|INT4RANGE/);
    expect(cockroachWarnings(model).length).toBeGreaterThan(0);
    expect(textOf(write('sqlalchemy', 'postgresql'))).toContain('HSTORE');
  });
});

describe('--provider cockroachdb: Doctrine, Laravel and EF Core', () => {
  it('warns that Doctrine and Laravel have no CockroachDB platform or driver', () => {
    expect(cockroachWarnings(write('doctrine', 'cockroachdb'))[0]).toContain(
      'Doctrine DBAL has no CockroachDB platform'
    );
    expect(cockroachWarnings(write('laravel', 'cockroachdb'))[0]).toContain(
      'Laravel has no CockroachDB driver'
    );
  });

  it('writes the same Doctrine and Laravel files as PostgreSQL, plus the warnings', () => {
    for (const format of ['doctrine', 'laravel']) {
      expect(write(format, 'cockroachdb').files).toEqual(
        write(format, 'postgresql').files
      );
    }
  });

  it('writes hstore as a jsonb string and drops the index methods CockroachDB lacks in EF Core', () => {
    const written: Written = write('efcore', 'cockroachdb');
    const account: string = textOf(written, 'Account.cs');
    expect(account).toContain('[Column("attributes", TypeName = "jsonb")]');
    expect(account).not.toContain('NpgsqlRange');
    const context: string = textOf(written, 'AppDbContext.cs');
    expect(context).not.toMatch(/HasMethod\("(hash|gist|brin)"\)/);
    // The gin indexes over the JSON and array columns stay; the one over the bigint column goes.
    expect(context.match(/HasMethod\("gin"\)/g)).toHaveLength(2);
    expect(written.warnings.join('\n')).toContain(
      'CockroachDB builds an inverted (GIN) index only over JSON, array or spatial columns, so the gin method was dropped.'
    );
    expect(cockroachWarnings(written)[0]).toContain('Npgsql');
  });
});
