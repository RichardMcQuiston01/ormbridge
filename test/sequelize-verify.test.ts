import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { afterAll, describe, expect, it } from 'vitest';
import {
  emitSequelize,
  SEQUELIZE_STYLES,
  type SequelizeStyle,
} from '../src/emitters/sequelize.js';
import type { MultiFileEmitOutput } from '../src/formats.js';
import type {
  IrEnum,
  IrField,
  IrModel,
  IrOnDelete,
  IrSchema,
} from '../src/ir.js';
import { toCamelCase, toPascalCase } from '../src/naming.js';
import { normalizeSchema, type NamingMode } from '../src/transforms.js';
import { kitchenSinkSchema, stressSchema } from './gormFixtures.js';
import {
  SOURCES_WITHOUT_VIEWS,
  parseSource,
  titleWithReason,
  type ToolProbe,
  type VerifySource,
} from './realToolSupport.js';
import {
  compareWithDatabase,
  expectedAssociations,
  expectedSchema,
  forSqlite,
  type DbSchema,
} from './sequelizeSupport.js';

/**
 * Loads the Sequelize models that the emitter writes with the real library. For each schema (the canonical blog
 * schema read from every format, the larger prisma, django and gorm "extras" fixtures and two IR fixtures), both
 * styles and both naming modes, the models are written for SQLite, the TypeScript is transpiled, and
 * `test/tools/validate-sequelize-emitter.mjs` loads them in Node: `initModels(sequelize)` defines and associates
 * them, `sequelize.sync()` creates the tables in an in-memory database, and the script reads them back and
 * inserts sample rows through the models and the associations. The tables, columns, nullability, keys, unique
 * keys, indexes and foreign keys are compared with the IR, the rows with the defaults, the enums, the foreign key
 * actions and the many-to-many associations.
 *
 * Set SEQUELIZE_DIR to a directory where `npm install sequelize@6 sqlite3` has been run (add
 * `typescript @types/node` to also type-check the TypeScript with `tsc --strict`; see test/README.md and
 * test/tools/setup-verification-tools.sh). The tests are skipped when it is not set.
 */

const BASE_PACKAGES: readonly string[] = ['sequelize', 'sqlite3'];
const TYPE_CHECK_PACKAGES: readonly string[] = ['typescript', '@types/node'];

function probeSequelize(): ToolProbe & { directory: string } {
  const directory: string = process.env.SEQUELIZE_DIR ?? '';
  if (directory === '') {
    return {
      available: false,
      reason:
        'set SEQUELIZE_DIR to a directory with sequelize@6 and sqlite3 installed (see test/README.md)',
      directory,
    };
  }
  const missing: string[] = BASE_PACKAGES.filter(
    (name: string) =>
      !existsSync(join(directory, 'node_modules', name, 'package.json'))
  );
  if (missing.length > 0) {
    return {
      available: false,
      reason: `SEQUELIZE_DIR is missing ${missing.join(', ')} (see test/README.md)`,
      directory,
    };
  }
  return { available: true, reason: '', directory };
}

const probe: ReturnType<typeof probeSequelize> = probeSequelize();
const directories: string[] = [];

afterAll(() => {
  for (const directory of directories) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function hasPackages(names: readonly string[]): boolean {
  return names.every((name: string) =>
    existsSync(join(probe.directory, 'node_modules', name, 'package.json'))
  );
}

/** One schema to write: its name and how to build the IR. */
interface Subject {
  label: string;
  build: () => Promise<IrSchema>;
}

const SUBJECTS: readonly Subject[] = [
  ...SOURCES_WITHOUT_VIEWS.map((source: VerifySource): Subject => ({
    label: source.label,
    build: () => parseSource(source),
  })),
  { label: 'kitchen-sink', build: () => Promise.resolve(kitchenSinkSchema()) },
  { label: 'stress', build: () => Promise.resolve(stressSchema()) },
];

/** A scratch project: the generated models, with `sequelize` linked in from SEQUELIZE_DIR. */
function scratchProject(files: Record<string, string>): string {
  const directory: string = mkdtempSync(join(tmpdir(), 'ormbridge-sequelize-'));
  directories.push(directory);
  symlinkSync(
    join(probe.directory, 'node_modules'),
    join(directory, 'node_modules'),
    'dir'
  );
  writeFileSync(
    join(directory, 'package.json'),
    JSON.stringify({ private: true, type: 'commonjs' })
  );
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(directory, path)), { recursive: true });
    writeFileSync(join(directory, path), text);
  }
  return directory;
}

/** Turns the TypeScript of the init style into CommonJS, the way `tsc` would. */
function transpile(files: Record<string, string>): Record<string, string> {
  const output: Record<string, string> = {};
  for (const [path, text] of Object.entries(files)) {
    output[path.replace(/\.ts$/, '.js')] = path.endsWith('.ts')
      ? ts.transpileModule(text, {
          compilerOptions: {
            module: ts.ModuleKind.CommonJS,
            target: ts.ScriptTarget.ES2020,
            esModuleInterop: true,
          },
        }).outputText
      : text;
  }
  return output;
}

interface Exercise {
  rows: Record<string, Record<string, unknown>>;
  foreignKeys: {
    table: string;
    column: string;
    enforced: boolean;
    onDelete: string;
  }[];
  unique: { table: string; columns: string[]; rejected: boolean }[];
  enums: { table: string; column: string; rejected: boolean }[];
  associations: { model: string; as: string; type: string; ok: boolean }[];
  errors: string[];
}

interface Run extends DbSchema {
  exercise: Exercise;
}

function runScript(directory: string, entry: string): Run {
  const run: SpawnSyncReturns<string> = spawnSync(
    process.execPath,
    [
      fileURLToPath(
        new URL('./tools/validate-sequelize-emitter.mjs', import.meta.url)
      ),
      probe.directory,
      join(directory, entry),
    ],
    { cwd: directory, encoding: 'utf8', timeout: 240_000 }
  );
  expect(run.status, run.stderr).toBe(0);
  return JSON.parse(run.stdout) as Run;
}

/** The outcome the database shows for an ON DELETE action (SQLite refuses both RESTRICT and NO ACTION). */
const EXPECTED_OUTCOME: Readonly<Partial<Record<IrOnDelete, string>>> = {
  cascade: 'cascade',
  setNull: 'setNull',
  restrict: 'restrict',
  noAction: 'restrict',
};

/** The default a created row must show for a field, or undefined when the field has none to check. */
function expectedDefault(
  schema: IrSchema,
  field: IrField
): { value: unknown } | 'present' | undefined {
  const value: IrField['default'] = field.default;
  if (value === undefined || field.arrayDepth !== undefined) {
    return undefined;
  }
  switch (value.kind) {
    case 'now':
    case 'uuid':
      return 'present';
    case 'enumValue': {
      const enumeration: IrEnum | undefined = schema.enums.find(
        (candidate: IrEnum) => candidate.name === field.enumName
      );
      const member = enumeration?.values.find(
        (candidate) => candidate.name === value.value
      );
      return member === undefined ? undefined : { value: member.dbValue };
    }
    case 'literal':
      return field.type === 'json' ||
        field.type === 'bytes' ||
        field.type === 'hstore'
        ? undefined
        : { value: value.value };
    default:
      return undefined;
  }
}

function sameValue(actual: unknown, expected: unknown): boolean {
  if (typeof expected === 'boolean') {
    return actual === expected || actual === (expected ? 1 : 0);
  }
  return String(actual) === String(expected);
}

/** Lists everything in which the rows and associations differ from the IR; empty when they agree. */
function compareExercise(
  schema: IrSchema,
  naming: NamingMode,
  exercise: Exercise
): string[] {
  const problems: string[] = exercise.errors.map(
    (error: string) => `error: ${error}`
  );

  for (const model of schema.models) {
    // Sequelize cannot create a table for a model it could not define; the table comparison reports that.
    const row: Record<string, unknown> | undefined =
      exercise.rows[model.tableName];
    if (row === undefined) {
      problems.push(`${model.tableName}: no sample row could be created`);
      continue;
    }
    for (const field of model.fields) {
      const expected = expectedDefault(schema, field);
      const actual: unknown = row[field.columnName];
      if (expected === 'present' && (actual === null || actual === undefined)) {
        problems.push(
          `${model.tableName}.${field.columnName}: no ${field.default?.kind} default was applied`
        );
      } else if (
        expected !== undefined &&
        expected !== 'present' &&
        !sameValue(actual, expected.value)
      ) {
        problems.push(
          `${model.tableName}.${field.columnName}: default ${String(expected.value)} in the IR, ${String(actual)} in the row`
        );
      }
    }
  }

  for (const model of schema.models) {
    for (const relation of model.relations) {
      if (relation.kind === 'manyToMany') {
        continue;
      }
      const found = exercise.foreignKeys.find(
        (entry) =>
          entry.table === model.tableName &&
          entry.column === relation.columnName
      );
      const expected: string | undefined = EXPECTED_OUTCOME[relation.onDelete];
      if (found === undefined) {
        problems.push(
          `${model.tableName}.${relation.columnName}: the foreign key was not exercised`
        );
        continue;
      }
      if (!found.enforced) {
        problems.push(
          `${model.tableName}.${relation.columnName}: a missing parent was accepted`
        );
      }
      if (expected !== undefined && found.onDelete !== expected) {
        problems.push(
          `${model.tableName}.${relation.columnName}: ON DELETE ${relation.onDelete} gave "${found.onDelete}" instead of "${expected}"`
        );
      }
    }
  }

  for (const entry of exercise.unique) {
    if (!entry.rejected) {
      problems.push(
        `${entry.table}.${entry.columns.join(',')}: a duplicate value was accepted`
      );
    }
  }
  const enumFields: number = schema.models.reduce(
    (total: number, model: IrModel) =>
      total +
      model.fields.filter(
        (field: IrField) =>
          field.enumName !== undefined && field.arrayDepth === undefined
      ).length,
    0
  );
  if (exercise.enums.length !== enumFields) {
    problems.push(
      `${exercise.enums.length} ENUM columns in the models, ${enumFields} enum-backed fields in the IR`
    );
  }
  for (const entry of exercise.enums) {
    if (!entry.rejected) {
      problems.push(
        `${entry.table}.${entry.column}: a value outside the ENUM was accepted`
      );
    }
  }

  const actualNames: string[] = exercise.associations
    .map((entry) => `${entry.model}.${entry.as}`)
    .sort();
  const expectedNames: string[] = expectedAssociations(schema, naming);
  for (const name of expectedNames) {
    if (!actualNames.includes(name)) {
      problems.push(`${name}: the association does not exist`);
    }
  }
  for (const entry of exercise.associations) {
    if (!entry.ok) {
      problems.push(
        `${entry.model}.${entry.as} (${entry.type}): the association did not work`
      );
    }
  }
  return problems;
}

describe(titleWithReason('sequelize emitter: real Sequelize', probe), () => {
  const combos: [string, SequelizeStyle, NamingMode, Subject][] =
    SUBJECTS.flatMap((subject: Subject) =>
      SEQUELIZE_STYLES.flatMap((style: SequelizeStyle) =>
        (['preserve', 'normalize'] as const).map(
          (
            naming: NamingMode
          ): [string, SequelizeStyle, NamingMode, Subject] => [
            subject.label,
            style,
            naming,
            subject,
          ]
        )
      )
    );

  it.skipIf(!probe.available).each(combos)(
    'creates the schema of %s in SQLite and works with rows and associations (%s style, %s naming)',
    async (
      _label: string,
      style: SequelizeStyle,
      naming: NamingMode,
      subject: Subject
    ) => {
      const schema: IrSchema = forSqlite(await subject.build());
      const output: MultiFileEmitOutput = emitSequelize(
        structuredClone(schema),
        {
          provider: 'sqlite',
          naming,
          style,
        }
      );
      const files: Record<string, string> =
        style === 'init' ? transpile(output.files) : output.files;
      const directory: string = scratchProject(files);
      const run: Run = runScript(directory, 'index.js');

      const ir: IrSchema = expectedSchema(schema, naming);
      expect(compareWithDatabase(ir, run)).toEqual([]);
      expect(compareExercise(ir, naming, run.exercise)).toEqual([]);
    },
    300_000
  );

  it.skipIf(!probe.available || !hasPackages(TYPE_CHECK_PACKAGES))(
    'type-checks the init style with tsc --strict',
    () => {
      const subjects: [string, IrSchema][] = [
        ['kitchen-sink', kitchenSinkSchema()],
        ['stress', stressSchema()],
      ];
      for (const [label, schema] of subjects) {
        for (const naming of ['preserve', 'normalize'] as const) {
          const output: MultiFileEmitOutput = emitSequelize(
            structuredClone(schema),
            { provider: 'sqlite', naming, style: 'init' }
          );
          const directory: string = scratchProject(output.files);
          const compiled: SpawnSyncReturns<string> = spawnSync(
            join(probe.directory, 'node_modules', '.bin', 'tsc'),
            [
              ...Object.keys(output.files),
              '--noEmit',
              '--module',
              'node16',
              '--moduleResolution',
              'node16',
              '--target',
              'es2022',
              '--strict',
              '--noUncheckedIndexedAccess',
              '--esModuleInterop',
              '--skipLibCheck',
              '--types',
              'node',
            ],
            { cwd: directory, encoding: 'utf8', timeout: 240_000 }
          );
          expect(compiled.stdout + compiled.stderr, `${label} ${naming}`).toBe(
            ''
          );
          expect(compiled.status).toBe(0);
        }
      }
    },
    300_000
  );
});

/** What `tools/generate-sequelize-sql.mjs` prints. */
interface DialectSql {
  tables: Record<string, string>;
  errors: string[];
}

const DIALECTS: readonly {
  provider: 'postgresql' | 'mysql' | 'sqlserver';
  dialect: string;
  packages: readonly string[];
  /** Fragments of the CREATE TABLE statements of the kitchen-sink schema. */
  fragments: readonly string[];
}[] = [
  {
    provider: 'postgresql',
    dialect: 'postgres',
    packages: ['pg', 'pg-hstore'],
    fragments: [
      '"id" BIGSERIAL',
      '"email" VARCHAR(255) NOT NULL UNIQUE',
      '"labels" TEXT[] NOT NULL',
      '"payload" JSONB',
      '"ip" INET',
      '"status" "public"."enum_accounts_status" NOT NULL DEFAULT \'draft\'',
      '"created_at" TIMESTAMP WITH TIME ZONE NOT NULL',
      'PRIMARY KEY ("account_id","group_id")',
    ],
  },
  {
    provider: 'mysql',
    dialect: 'mysql',
    packages: ['mysql2'],
    fragments: [
      '`id` BIGINT auto_increment',
      '`labels` JSON NOT NULL',
      '`payload` JSON',
      '`ip` VARCHAR(45)',
      "`status` ENUM('draft', 'live') NOT NULL DEFAULT 'draft'",
      '`created_at` DATETIME NOT NULL',
      'PRIMARY KEY (`account_id`, `group_id`)',
    ],
  },
  {
    provider: 'sqlserver',
    dialect: 'mssql',
    packages: ['tedious'],
    fragments: [
      '[id] BIGINT IDENTITY(1,1)',
      '[labels] NVARCHAR(MAX) NOT NULL',
      '[payload] NVARCHAR(MAX)',
      "[status] NVARCHAR(255) NOT NULL DEFAULT N'draft'",
      '[created_at] DATETIMEOFFSET NOT NULL',
      'PRIMARY KEY ([account_id], [group_id])',
    ],
  },
];

describe(
  titleWithReason('sequelize emitter: SQL for other dialects', probe),
  () => {
    it.skipIf(!probe.available).each(DIALECTS)(
      'builds CREATE TABLE statements for $dialect without a server',
      ({ provider, dialect, packages, fragments }) => {
        if (!hasPackages(packages)) {
          // Not an error: only the base packages are required to run the suite.
          console.warn(
            `Skipped the ${dialect} SQL: SEQUELIZE_DIR is missing ${packages.join(', ')}.`
          );
          return;
        }
        for (const style of SEQUELIZE_STYLES) {
          const output: MultiFileEmitOutput = emitSequelize(
            kitchenSinkSchema(),
            { provider, naming: 'preserve', style }
          );
          const directory: string = scratchProject(
            style === 'init' ? transpile(output.files) : output.files
          );
          const run: SpawnSyncReturns<string> = spawnSync(
            process.execPath,
            [
              fileURLToPath(
                new URL('./tools/generate-sequelize-sql.mjs', import.meta.url)
              ),
              probe.directory,
              dialect,
              join(directory, 'index.js'),
            ],
            { cwd: directory, encoding: 'utf8', timeout: 240_000 }
          );
          expect(run.status, run.stderr).toBe(0);
          const sql: DialectSql = JSON.parse(run.stdout) as DialectSql;
          expect(sql.errors).toEqual([]);
          expect(Object.keys(sql.tables).sort()).toEqual(
            [
              'LEGACY_ORDER',
              'accounts',
              'groups',
              'groups_friends',
              'memberships',
              'profiles',
              'sessions',
            ].sort()
          );
          const text: string = Object.values(sql.tables).join('\n');
          for (const fragment of fragments) {
            expect(text, `${dialect} ${style}`).toContain(fragment);
          }
        }
      },
      300_000
    );
  }
);
