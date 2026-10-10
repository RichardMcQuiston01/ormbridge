import { describe, expect, it } from 'vitest';
import { emitSqlDdl, type SqlDialect } from '../src/emitters/sqlDdl.js';
import type { PrismaProvider } from '../src/emitters/prisma.js';
import type { IrSchema } from '../src/ir.js';
import {
  expandManyToMany,
  normalizeSchema,
  type NamingMode,
} from '../src/transforms.js';
import { constructsSchema } from './drizzleFixtures.js';
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
  openMysql,
  openPostgres,
  openSqlite,
  probeMysql,
  probePostgres,
  probeSqlite,
  SQL_TEST_TIMEOUT_MS,
  type SqlEngine,
} from './sqlDdlSupport.js';

/**
 * Runs the output of the SQL DDL emitter in real databases and compares what the database reports
 * (tables, columns, nullability, primary keys, foreign keys with their `ON DELETE` action, unique
 * keys, indexes, enum types, string lengths and decimal precision) with the IR the SQL was written
 * from. SQLite always runs (Node's built-in `node:sqlite`, or better-sqlite3 from `SQL_DIR`);
 * PostgreSQL runs when `SQL_POSTGRES_URL` is set and MySQL or MariaDB when `SQL_MYSQL_URL` is set
 * (the `psql` and `mysql` clients must be on the PATH); see test/README.md. SQL Server has no
 * server to run here, so its output is covered by the golden files and the unit tests only.
 */

interface EngineCase {
  name: string;
  provider: PrismaProvider;
  dialect: SqlDialect;
  probe: ToolProbe;
  open: () => SqlEngine;
}

const ENGINES: readonly EngineCase[] = [
  {
    name: 'sqlite',
    provider: 'sqlite',
    dialect: 'sqlite',
    probe: probeSqlite(),
    open: openSqlite,
  },
  {
    name: 'postgresql',
    provider: 'postgresql',
    dialect: 'postgresql',
    probe: probePostgres(),
    open: openPostgres,
  },
  {
    name: 'mysql',
    provider: 'mysql',
    dialect: 'mysql',
    probe: probeMysql(),
    open: openMysql,
  },
];

const NAMING_MODES: readonly NamingMode[] = ['preserve', 'normalize'];

/** The schemas written to SQL: every readable fixture plus IR fixtures with the awkward constructs. */
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
];

describe.each(ENGINES)('SQL DDL in $name', (engine) => {
  const enabled: boolean = engine.probe.available;

  describe.each(SCHEMAS)('$label', (schemaCase) => {
    it.skipIf(!enabled)(
      titleWithReason(
        'creates the tables and matches the schema (both naming modes)',
        engine.probe
      ),
      async () => {
        const schema: IrSchema = await schemaCase.load();
        for (const naming of NAMING_MODES) {
          const output = emitSqlDdl(schema, {
            provider: engine.provider,
            naming,
          });
          const expanded: IrSchema = expandManyToMany(schema);
          const prepared: IrSchema =
            naming === 'normalize' ? normalizeSchema(expanded) : expanded;
          const database: SqlEngine = engine.open();
          try {
            try {
              database.execute(output.text);
            } catch (error: unknown) {
              throw new Error(
                `${schemaCase.label} (${naming}) failed in ${engine.name}: ${error instanceof Error ? error.message : String(error)}\n${output.text}`,
                { cause: error }
              );
            }
            expect(
              compareSnapshot(engine.dialect, prepared, database.snapshot()),
              `${schemaCase.label} (${naming}) in ${engine.name}`
            ).toEqual([]);
          } finally {
            database.dispose();
          }
        }
      },
      SQL_TEST_TIMEOUT_MS
    );
  });

  // A small schema whose rows exercise what the DDL promises: defaults, identity, enums, uniqueness,
  // referential actions and the self reference.
  describe('behaviour', () => {
    it.skipIf(!enabled)(
      titleWithReason(
        'applies defaults and enforces keys, enums and referential actions',
        engine.probe
      ),
      () => {
        const database: SqlEngine = engine.open();
        try {
          database.execute(
            emitSqlDdl(behaviourSchema(), {
              provider: engine.provider,
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
          // The identity key counts up and the defaults are applied.
          expect(parents.map((row) => Number(row['id']))).toEqual([1, 2]);
          expect(parents.map((row) => String(row['status']))).toEqual([
            'draft',
            'draft',
          ]);
          expect(parents.map((row) => Number(row['qty']))).toEqual([5, 5]);
          expect(
            parents.map((row) =>
              [true, 1, '1', 't'].includes(row['active'] as never)
            )
          ).toEqual([true, true]);
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
  });
});

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
          field('created_at', {
            type: 'dateTime',
            default: { kind: 'now' },
          }),
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
