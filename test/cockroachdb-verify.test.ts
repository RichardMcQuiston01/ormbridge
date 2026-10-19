import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { emitSqlDdl } from '../src/emitters/sqlDdl.js';
import { parseSqlDdl } from '../src/parsers/sqlDdl.js';
import { getFormat } from '../src/formats.js';
import type { IrSchema } from '../src/ir.js';
import { expandManyToMany, normalizeSchema } from '../src/transforms.js';
import { cockroachSchema } from './cockroachFixtures.js';
import {
  cockroachVersion,
  openCockroach,
  probeCockroach,
} from './cockroachSupport.js';
import { constructsSchema } from './drizzleFixtures.js';
import { expectOk } from './helpers.js';
import { compareIr, formatDifference } from './irCompare.js';
import {
  field,
  idField,
  kitchenSinkSchema,
  model,
  relation,
  schemaOf,
  stressSchema,
} from './gormFixtures.js';
import {
  parseSource,
  titleWithReason,
  VERIFY_SOURCES,
  type ToolProbe,
  type VerifySource,
} from './realToolSupport.js';
import {
  compareSnapshot,
  SQL_TEST_TIMEOUT_MS,
  type SqlEngine,
} from './sqlDdlSupport.js';

/**
 * Runs the output of the SQL DDL writer for `--provider cockroachdb` in a real CockroachDB and compares
 * what the server reports (tables, columns, nullability, primary keys, foreign keys with their ON DELETE
 * action, unique keys, indexes, enum types, string lengths and decimal precision) with the IR the SQL was
 * written from.
 *
 * Set COCKROACH_URL (needs psql) or COCKROACH_DOCKER (a running cockroachdb/cockroach container) to a
 * single-node insecure server; see test/cockroachSupport.ts and test/README.md. Without one the tests are
 * skipped with that reason in their title, and the CI job `real-tools` starts a server and runs them.
 */

const probe = probeCockroach();
const enabled: boolean = probe.available;

interface SchemaCase {
  label: string;
  load: () => Promise<IrSchema>;
}

const SCHEMAS: readonly SchemaCase[] = [
  ...VERIFY_SOURCES.map((source: VerifySource): SchemaCase => ({
    label: source.label,
    load: () => parseSource(source),
  })),
  { label: 'kitchen-sink', load: () => Promise.resolve(kitchenSinkSchema()) },
  { label: 'stress', load: () => Promise.resolve(stressSchema()) },
  { label: 'constructs', load: () => Promise.resolve(constructsSchema()) },
  { label: 'cockroachdb', load: () => Promise.resolve(cockroachSchema()) },
];

describe.skipIf(!enabled)(
  `CockroachDB ${enabled ? cockroachVersion() : ''}`,
  () => {
    it('is reachable', () => {
      expect(cockroachVersion()).toMatch(/CockroachDB/);
    });
  }
);

describe('SQL DDL for --provider cockroachdb in CockroachDB', () => {
  describe.each(SCHEMAS)('$label', (schemaCase) => {
    it.skipIf(!enabled)(
      titleWithReason(
        'creates the tables and matches the schema (both naming modes)',
        probe
      ),
      async () => {
        const schema: IrSchema = await schemaCase.load();
        for (const naming of ['preserve', 'normalize'] as const) {
          const output = emitSqlDdl(schema, {
            provider: 'cockroachdb',
            naming,
          });
          const expanded: IrSchema = expandManyToMany(schema);
          const prepared: IrSchema =
            naming === 'normalize' ? normalizeSchema(expanded) : expanded;
          const database: SqlEngine = openCockroach();
          try {
            try {
              database.execute(output.text);
            } catch (error: unknown) {
              throw new Error(
                `${schemaCase.label} (${naming}) failed in CockroachDB: ${error instanceof Error ? error.message : String(error)}\n${output.text}`,
                { cause: error }
              );
            }
            expect(
              compareSnapshot('postgresql', prepared, database.snapshot()),
              `${schemaCase.label} (${naming}) in CockroachDB`
            ).toEqual([]);
          } finally {
            database.dispose();
          }
        }
      },
      SQL_TEST_TIMEOUT_MS
    );
  });

  describe('behaviour', () => {
    it.skipIf(!enabled)(
      titleWithReason(
        'applies defaults and enforces keys, enums and referential actions',
        probe
      ),
      () => {
        const database: SqlEngine = openCockroach();
        try {
          database.execute(
            emitSqlDdl(behaviourSchema(), {
              provider: 'cockroachdb',
              naming: 'preserve',
            }).text
          );
          database.execute(
            "INSERT INTO parent (name) VALUES ('first'); INSERT INTO parent (name) VALUES ('second');"
          );
          const parents = database.query(
            'SELECT id, name, status, qty, active FROM parent ORDER BY id'
          );
          expect(parents.map((row) => String(row['name']))).toEqual([
            'first',
            'second',
          ]);
          // The identity key counts up from 1 (a SERIAL would be unique_rowid(), a huge unordered number).
          expect(parents.map((row) => Number(row['id']))).toEqual([1, 2]);
          expect(parents.map((row) => String(row['status']))).toEqual([
            'draft',
            'draft',
          ]);
          expect(parents.map((row) => Number(row['qty']))).toEqual([5, 5]);
          const stamped = database.query(
            'SELECT created_at, token FROM parent ORDER BY id'
          );
          expect(stamped.every((row) => row['created_at'] !== null)).toBe(true);
          expect(String(stamped[0]?.['token'] ?? '').length).toBe(36);
          expect(stamped[0]?.['token']).not.toBe(stamped[1]?.['token']);

          // Uniqueness, the enum and the foreign key are enforced.
          expect(() =>
            database.execute("INSERT INTO parent (name) VALUES ('first');")
          ).toThrow();
          expect(() =>
            database.execute(
              "INSERT INTO parent (name, status) VALUES ('third', 'bogus');"
            )
          ).toThrow();
          expect(() =>
            database.execute(
              "INSERT INTO child (parent_id, note) VALUES (99, 'orphan');"
            )
          ).toThrow();

          // ON DELETE CASCADE removes the children, SET NULL keeps the row.
          database.execute(
            "INSERT INTO child (id, parent_id, note) VALUES (1, 1, 'a'); INSERT INTO child (id, parent_id, note) VALUES (2, 1, 'b'); INSERT INTO child (id, parent_id, note) VALUES (3, 2, 'c');"
          );
          database.execute(
            "INSERT INTO child (id, parent_id, note, buddy_id) VALUES (4, 2, 'd', 3);"
          );
          database.execute('DELETE FROM child WHERE id = 3');
          expect(
            database.query('SELECT id, buddy_id FROM child WHERE id = 4')[0]?.[
              'buddy_id'
            ] ?? null
          ).toBeNull();
          database.execute('DELETE FROM parent WHERE id = 1');
          expect(
            database
              .query('SELECT id FROM child ORDER BY id')
              .map((row) => Number(row['id']))
          ).toEqual([4]);
        } finally {
          database.dispose();
        }
      },
      SQL_TEST_TIMEOUT_MS
    );

    it.skipIf(!enabled)(
      titleWithReason(
        'keeps 32-bit integers 32-bit, replaces hstore and ranges, and refreshes ON UPDATE',
        probe
      ),
      () => {
        const database: SqlEngine = openCockroach();
        try {
          database.execute(
            emitSqlDdl(cockroachSchema(), {
              provider: 'cockroachdb',
              naming: 'preserve',
            }).text
          );
          const columns = database.query(
            "SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'accounts' ORDER BY column_name"
          );
          const types: Record<string, string> = Object.fromEntries(
            columns.map((row) => [
              String(row['column_name']),
              String(row['data_type']),
            ])
          );
          // A bare INT would be bigint on CockroachDB.
          expect(types['age']).toBe('integer');
          expect(types['visits']).toBe('bigint');
          expect(types['attributes']).toBe('jsonb');
          expect(types['stock_range']).toBe('text');
          expect(types['grid']).toBe('jsonb');

          database.execute(
            "INSERT INTO tenants (name) VALUES ('t'); INSERT INTO accounts (email, balance, labels, tenant_id, updated_at) SELECT 'a@b.c', 1.50, ARRAY['x'], id, '2020-01-01' FROM tenants;"
          );
          const before = database.query(
            "SELECT updated_at::string AS at FROM accounts WHERE email = 'a@b.c'"
          );
          database.execute(
            "UPDATE accounts SET bio = 'changed' WHERE email = 'a@b.c';"
          );
          const after = database.query(
            "SELECT updated_at::string AS at FROM accounts WHERE email = 'a@b.c'"
          );
          expect(String(before[0]?.['at'])).toContain('2020-01-01');
          expect(String(after[0]?.['at'])).not.toContain('2020-01-01');
        } finally {
          database.dispose();
        }
      },
      SQL_TEST_TIMEOUT_MS
    );
  });
});

/**
 * One ORM writer, end to end: the Drizzle schema written for `--provider cockroachdb` goes through the real
 * `drizzle-kit generate` (no database needed for that), and the SQL it writes runs in CockroachDB and is
 * compared with the IR. Needs DRIZZLE_DIR (see test/README.md) as well as a server.
 */
function probeDrizzleKit(): ToolProbe {
  const directory: string = process.env.DRIZZLE_DIR ?? '';
  if (directory === '') {
    return {
      available: false,
      reason:
        'set DRIZZLE_DIR to a directory with drizzle-orm and drizzle-kit installed (see test/README.md)',
    };
  }
  if (!existsSync(join(directory, 'node_modules', '.bin', 'drizzle-kit'))) {
    return { available: false, reason: 'DRIZZLE_DIR has no drizzle-kit' };
  }
  return probe;
}

const drizzleProbe: ToolProbe = probeDrizzleKit();
const scratchDirectories: string[] = [];

afterAll(() => {
  for (const directory of scratchDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('Drizzle schema for --provider cockroachdb in CockroachDB', () => {
  it.skipIf(!drizzleProbe.available)(
    titleWithReason(
      'drizzle-kit generate writes SQL that CockroachDB runs and that matches the schema',
      drizzleProbe
    ),
    () => {
      const schema: IrSchema = cockroachSchema();
      const emitted = expectOk(getFormat('drizzle')).emit?.(schema, {
        naming: 'preserve',
        provider: 'cockroachdb',
        header: true,
        autoField: 'int',
      });
      if (emitted === undefined) {
        throw new Error('the drizzle format has no writer');
      }
      const output = expectOk(emitted);
      const files: Record<string, string> =
        output.text === undefined ? output.files : {};
      expect(Object.keys(files).sort()).toEqual([
        'drizzle.config.ts',
        'schema.ts',
      ]);
      const directory: string = mkdtempSync(join(tmpdir(), 'ormbridge-crdb-'));
      scratchDirectories.push(directory);
      for (const [name, text] of Object.entries(files)) {
        writeFileSync(join(directory, name), text);
      }
      symlinkSync(
        join(process.env.DRIZZLE_DIR ?? '', 'node_modules'),
        join(directory, 'node_modules'),
        'dir'
      );
      const generated = spawnSync(
        join(
          process.env.DRIZZLE_DIR ?? '',
          'node_modules',
          '.bin',
          'drizzle-kit'
        ),
        ['generate'],
        { cwd: directory, encoding: 'utf8', timeout: 240_000 }
      );
      expect(
        generated.status,
        `drizzle-kit generate: ${generated.stdout}${generated.stderr}`
      ).toBe(0);
      const migration: string | undefined = readdirSync(
        join(directory, 'drizzle')
      ).find((name: string) => name.endsWith('.sql'));
      expect(migration).toBeDefined();
      const script: string = readFileSync(
        join(directory, 'drizzle', migration ?? ''),
        'utf8'
      ).replaceAll('--> statement-breakpoint', '');
      const database: SqlEngine = openCockroach();
      try {
        try {
          database.execute(script);
        } catch (error: unknown) {
          throw new Error(
            `the drizzle-kit SQL failed in CockroachDB: ${error instanceof Error ? error.message : String(error)}\n${script}`,
            { cause: error }
          );
        }
        // Everything matches except the 32-bit columns: Drizzle's pg-core has no INT4, so integer() is a
        // bare INT, which is 64-bit on CockroachDB (the writer's notice says so).
        expect(
          compareSnapshot(
            'postgresql',
            expandManyToMany(schema),
            database.snapshot()
          ).sort()
        ).toEqual([
          'accounts.age: type bigint does not fit int',
          'accounts.id: type bigint does not fit int',
          'events.kind: type bigint does not fit int',
        ]);
      } finally {
        database.dispose();
      }
    },
    SQL_TEST_TIMEOUT_MS
  );
});

describe('SQL reader on SHOW CREATE ALL TABLES from CockroachDB', () => {
  // The SQL the writer produced, run in CockroachDB, dumped by CockroachDB and read by the SQL reader again.
  describe.each(
    SCHEMAS.filter((schemaCase: SchemaCase) =>
      ['prisma', 'django', 'gorm', 'cockroachdb'].includes(schemaCase.label)
    )
  )('$label', (schemaCase) => {
    it.skipIf(!enabled)(
      titleWithReason(
        'reads back the tables, columns, keys, relations and indexes the writer created',
        probe
      ),
      async () => {
        const schema: IrSchema = expandManyToMany(await schemaCase.load());
        const database: SqlEngine = openCockroach();
        try {
          database.execute(
            emitSqlDdl(schema, { provider: 'cockroachdb', naming: 'preserve' })
              .text
          );
          const dump: string = [
            ...database.query(
              'SELECT create_statement FROM [SHOW CREATE ALL TYPES]'
            ),
            ...database.query(
              'SELECT create_statement FROM [SHOW CREATE ALL TABLES]'
            ),
          ]
            .map((row) => String(row['create_statement']))
            .join('\n');
          const parsed: IrSchema = expectOk(
            parseSqlDdl([{ path: 'show-create.sql', text: dump }], {
              appLabel: 'app',
            })
          );
          expect(parsed.models.map((m) => m.tableName).sort()).toEqual(
            schema.models.map((m) => m.tableName).sort()
          );
          expect(
            compareIr(namedLike(schema, parsed), parsed)
              .filter(
                (difference) =>
                  !COCKROACH_ROUND_TRIP_ALLOWED.test(
                    formatDifference(difference)
                  )
              )
              .map(formatDifference)
          ).toEqual(
            schemaCase.label === 'cockroachdb'
              ? COCKROACH_FIXTURE_DIFFERENCES
              : []
          );
        } finally {
          database.dispose();
        }
      },
      SQL_TEST_TIMEOUT_MS
    );
  });
});

/**
 * What the SQL cannot say, so that reading it back differs from the IR the writer started with: the member
 * labels of an enum, the names of the reverse side of a relation, the join-table flag and the length of an
 * enum column are not in the database, and an auto-updated timestamp reads back as `DEFAULT now() ON UPDATE
 * now()` (the reader keeps the default).
 */
const COCKROACH_ROUND_TRIP_ALLOWED: RegExp =
  /^(enumValueLabel|relationRelatedName|joinTable|fieldMaxLength) |^fieldDefault \w+\.updated_at: \(none\) -> now$/;

/** The replacements the writer makes for what CockroachDB lacks, as the reader sees them. */
const COCKROACH_FIXTURE_DIFFERENCES: string[] = [
  'fieldType Account.labels: string -> text',
  'fieldType Account.grid: int -> json',
  'fieldType Account.attributes: hstore -> json',
  'fieldType Account.stock_range: range -> text',
];

/** The schema with each model named like the model the reader made of the same table. */
function namedLike(schema: IrSchema, parsed: IrSchema): IrSchema {
  const names: Map<string, string> = new Map<string, string>();
  for (const model of schema.models) {
    const read = parsed.models.find(
      (candidate) => candidate.tableName === model.tableName
    );
    names.set(model.name, read?.name ?? model.name);
  }
  return {
    ...schema,
    models: schema.models.map((model) => ({
      ...model,
      name: names.get(model.name) ?? model.name,
      relations: model.relations.map((relation) => ({
        ...relation,
        targetModel: names.get(relation.targetModel) ?? relation.targetModel,
      })),
    })),
  };
}

/** Parent with an identity key, defaults and an enum; child with cascading and SET NULL keys. */
function behaviourSchema(): IrSchema {
  return schemaOf(
    [
      model('Parent', {
        tableName: 'parent',
        fields: [
          idField(),
          field('name', { maxLength: 30, isUnique: true }),
          field('status', {
            enumName: 'Status',
            maxLength: 10,
            default: { kind: 'enumValue', value: 'DRAFT' },
          }),
          field('qty', { type: 'int', default: { kind: 'literal', value: 5 } }),
          field('active', {
            type: 'boolean',
            default: { kind: 'literal', value: true },
          }),
          field('created_at', { type: 'dateTime', default: { kind: 'now' } }),
          field('token', { type: 'uuid', default: { kind: 'uuid' } }),
        ],
      }),
      model('Child', {
        tableName: 'child',
        fields: [idField(), field('note', { maxLength: 20 })],
        relations: [
          relation('parent', 'Parent', { onDelete: 'cascade' }),
          relation('buddy', 'Child', {
            columnName: 'buddy_id',
            isNullable: true,
            onDelete: 'setNull',
          }),
        ],
      }),
    ],
    [
      {
        name: 'Status',
        values: [
          { name: 'DRAFT', dbValue: 'draft' },
          { name: 'LIVE', dbValue: 'live' },
        ],
      },
    ]
  );
}
