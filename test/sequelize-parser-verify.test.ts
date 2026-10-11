import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import type {
  IrField,
  IrIndex,
  IrModel,
  IrOnDelete,
  IrRelation,
  IrSchema,
} from '../src/ir.js';
import { parseSequelize } from '../src/parsers/sequelize.js';
import { CANONICAL_FIXTURES } from './fixtures/canonical.js';
import { expectOk } from './helpers.js';
import { titleWithReason, type ToolProbe } from './realToolSupport.js';

/**
 * Loads the Sequelize fixtures with the real library: the models are defined and associated in Node,
 * `sequelize.sync()` creates their tables in an in-memory SQLite database, and what the database and
 * Sequelize's query interface report (tables, columns, nullability, primary and unique keys, indexes,
 * foreign keys and their actions) is compared with what the parser read from the same source.
 *
 * Set SEQUELIZE_DIR to a directory where `npm install sequelize@6 sqlite3` has been run (add
 * `sequelize-typescript reflect-metadata typescript @types/node` for the TypeScript fixtures; see
 * test/README.md and test/tools/setup-verification-tools.sh). The tests are skipped when it is not set.
 */

interface VerifyGroup {
  label: string;
  /** Packages that must be installed in SEQUELIZE_DIR for this group. */
  requires: readonly string[];
  /** Fixture files to copy, relative to the fixtures directory (their layout is kept). */
  files: readonly string[];
  /** The file that exports the Sequelize instance, relative to the fixtures directory. */
  entry: string;
  /** The files the parser reads (absolute paths). */
  sources: readonly string[];
}

const FIXTURES: string = fileURLToPath(new URL('./fixtures/', import.meta.url));
const BASE_PACKAGES: readonly string[] = ['sequelize', 'sqlite3'];
const TYPESCRIPT_PACKAGES: readonly string[] = [
  ...BASE_PACKAGES,
  'sequelize-typescript',
  'reflect-metadata',
  'typescript',
  '@types/node',
];

const CANONICAL_PATHS: readonly string[] =
  CANONICAL_FIXTURES.find((fixture) => fixture.format === 'sequelize')?.paths ??
  [];

const GROUPS: readonly VerifyGroup[] = [
  {
    label: 'canonical blog schema (sequelize-cli layout)',
    requires: BASE_PACKAGES,
    files: [
      'sequelize/package.json',
      ...CANONICAL_PATHS.map((path: string) => relative(FIXTURES, path)),
    ],
    entry: 'sequelize/models/index.js',
    sources: CANONICAL_PATHS,
  },
  {
    label: 'variants (defaults, underscored, join models, keys, indexes)',
    requires: BASE_PACKAGES,
    files: ['sequelize-extras/package.json', 'sequelize-extras/variants.js'],
    entry: 'sequelize-extras/variants.js',
    sources: [join(FIXTURES, 'sequelize-extras/variants.js')],
  },
  {
    label: 'Model.init classes (TypeScript)',
    requires: TYPESCRIPT_PACKAGES,
    files: ['sequelize-extras/init-class.ts'],
    entry: 'sequelize-extras/init-class.ts',
    sources: [join(FIXTURES, 'sequelize-extras/init-class.ts')],
  },
  {
    label: 'sequelize-typescript decorators',
    requires: TYPESCRIPT_PACKAGES,
    files: ['sequelize-extras/decorators.ts'],
    entry: 'sequelize-extras/decorators.ts',
    sources: [join(FIXTURES, 'sequelize-extras/decorators.ts')],
  },
];

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

function missingPackages(group: VerifyGroup): string[] {
  return group.requires.filter(
    (name: string) =>
      !existsSync(join(probe.directory, 'node_modules', name, 'package.json'))
  );
}

// What validate-sequelize.mjs prints.
interface DbColumn {
  name: string;
  allowNull: boolean;
}

interface DbIndex {
  name: string;
  unique: boolean;
  origin: string;
  columns: string[];
}

interface DbForeignKey {
  column: string;
  table: string;
  to: string;
  onDelete: string;
  onUpdate: string;
}

interface DbTable {
  columns: DbColumn[];
  primaryKey: string[];
  indexes: DbIndex[];
  foreignKeys: DbForeignKey[];
}

interface DbSchema {
  tables: Record<string, DbTable>;
}

const ACTIONS: Readonly<Record<IrOnDelete, string>> = {
  cascade: 'CASCADE',
  setNull: 'SET NULL',
  restrict: 'RESTRICT',
  noAction: 'NO ACTION',
  setDefault: 'SET DEFAULT',
};

function sorted(values: string[]): string[] {
  return [...values].sort();
}

function key(columns: string[]): string {
  return sorted(columns).join(',');
}

/** The column behind a field or relation name of a model. */
function columnOf(model: IrModel, name: string): string {
  return (
    model.fields.find((field: IrField) => field.name === name)?.columnName ??
    model.relations.find((relation: IrRelation) => relation.name === name)
      ?.columnName ??
    name
  );
}

function expectedKeyColumn(
  target: IrModel | undefined,
  relation: IrRelation
): string {
  if (target === undefined) {
    return 'id';
  }
  if (relation.toField !== undefined) {
    return columnOf(target, relation.toField);
  }
  const names: string[] = target.compositePrimaryKey ?? [
    ...target.fields
      .filter((field: IrField) => field.isPrimaryKey)
      .map((field: IrField) => field.name),
    ...target.relations
      .filter((candidate: IrRelation) => candidate.isPrimaryKey === true)
      .map((candidate: IrRelation) => candidate.name),
  ];
  const first: string | undefined = names[0];
  return first === undefined ? 'id' : columnOf(target, first);
}

/** Lists everything in which the database differs from the IR; empty when they agree. */
function compareWithDatabase(ir: IrSchema, db: DbSchema): string[] {
  const problems: string[] = [];
  const byTable: Map<string, IrModel> = new Map(
    ir.models.map((model: IrModel): [string, IrModel] => [
      model.tableName,
      model,
    ])
  );
  const byName: Map<string, IrModel> = new Map(
    ir.models.map((model: IrModel): [string, IrModel] => [model.name, model])
  );

  for (const model of ir.models) {
    const table: DbTable | undefined = db.tables[model.tableName];
    if (table === undefined) {
      problems.push(`table ${model.tableName} was not created by Sequelize`);
      continue;
    }
    const label: string = model.tableName;
    const relations: IrRelation[] = model.relations.filter(
      (relation: IrRelation) => relation.kind !== 'manyToMany'
    );

    // Columns and nullability. SQLite reports primary key columns as nullable, so they are skipped.
    const primaryColumns: string[] = (
      model.compositePrimaryKey ?? [
        ...model.fields
          .filter((field: IrField) => field.isPrimaryKey)
          .map((field: IrField) => field.name),
        ...relations
          .filter((relation: IrRelation) => relation.isPrimaryKey === true)
          .map((relation: IrRelation) => relation.name),
      ]
    ).map((name: string) => columnOf(model, name));
    const expected: Map<string, boolean> = new Map([
      ...model.fields.map((field: IrField): [string, boolean] => [
        field.columnName,
        field.isNullable,
      ]),
      ...relations.map((relation: IrRelation): [string, boolean] => [
        relation.columnName,
        relation.isNullable,
      ]),
    ]);
    const actual: Map<string, boolean> = new Map(
      table.columns.map((column: DbColumn): [string, boolean] => [
        column.name,
        column.allowNull,
      ])
    );
    if (key([...expected.keys()]) !== key([...actual.keys()])) {
      problems.push(
        `${label}: columns ${key([...actual.keys()])} in the database, ${key([...expected.keys()])} in the IR`
      );
    }
    for (const [column, nullable] of expected) {
      if (
        actual.has(column) &&
        !primaryColumns.includes(column) &&
        actual.get(column) !== nullable
      ) {
        problems.push(
          `${label}.${column}: ${nullable ? 'nullable' : 'NOT NULL'} in the IR, the opposite in the database`
        );
      }
    }

    // Primary key.
    if (key(table.primaryKey) !== key(primaryColumns)) {
      problems.push(
        `${label}: primary key (${key(table.primaryKey)}) in the database, (${key(primaryColumns)}) in the IR`
      );
    }

    // Unique constraints and indexes.
    const uniques: string[] = [
      ...model.fields
        .filter((field: IrField) => field.isUnique && !field.isPrimaryKey)
        .map((field: IrField) => field.columnName),
      ...relations
        .filter(
          (relation: IrRelation) =>
            relation.kind === 'oneToOne' && relation.isPrimaryKey !== true
        )
        .map((relation: IrRelation) => relation.columnName),
      ...model.indexes
        .filter((index: IrIndex) => index.isUnique)
        .map((index: IrIndex) =>
          index.fields.map((name: string) => columnOf(model, name)).join(',')
        ),
    ].map((columns: string) => key(columns.split(',')));
    const dbUniques: string[] = table.indexes
      .filter((index: DbIndex) => index.unique && index.origin !== 'pk')
      .map((index: DbIndex) => key(index.columns));
    if (key(uniques) !== key(dbUniques)) {
      problems.push(
        `${label}: unique keys [${sorted(dbUniques).join(' ')}] in the database, [${sorted(uniques).join(' ')}] in the IR`
      );
    }
    const plain: string[] = model.indexes
      .filter((index: IrIndex) => !index.isUnique)
      .map((index: IrIndex) =>
        key(index.fields.map((name: string) => columnOf(model, name)))
      );
    const dbPlain: string[] = table.indexes
      .filter((index: DbIndex) => !index.unique)
      .map((index: DbIndex) => key(index.columns));
    if (key(plain) !== key(dbPlain)) {
      problems.push(
        `${label}: indexes [${sorted(dbPlain).join(' ')}] in the database, [${sorted(plain).join(' ')}] in the IR`
      );
    }

    // Foreign keys.
    const keys: string[] = relations.map((relation: IrRelation) => {
      const target: IrModel | undefined = byName.get(relation.targetModel);
      return [
        relation.columnName,
        target?.tableName ?? relation.targetModel,
        expectedKeyColumn(target, relation),
        ACTIONS[relation.onDelete],
        relation.onUpdate === undefined
          ? 'any'
          : (ACTIONS[relation.onUpdate] ?? 'any'),
      ].join('|');
    });
    const dbKeys: string[] = table.foreignKeys.map((foreign: DbForeignKey) => {
      const owner: IrRelation | undefined = relations.find(
        (relation: IrRelation) => relation.columnName === foreign.column
      );
      return [
        foreign.column,
        foreign.table,
        foreign.to,
        foreign.onDelete,
        owner?.onUpdate === undefined ? 'any' : foreign.onUpdate,
      ].join('|');
    });
    if (key(keys) !== key(dbKeys)) {
      problems.push(
        `${label}: foreign keys [${sorted(dbKeys).join(' ')}] in the database, [${sorted(keys).join(' ')}] in the IR`
      );
    }
  }

  // Tables the IR does not list must be the join tables of its many-to-many relations.
  const extra: Set<string> = new Set(
    Object.keys(db.tables).filter((name: string) => !byTable.has(name))
  );
  for (const model of ir.models) {
    for (const relation of model.relations) {
      if (relation.kind !== 'manyToMany') {
        continue;
      }
      const target: IrModel | undefined = byName.get(relation.targetModel);
      const join: string | undefined = [...extra].find((name: string) => {
        const table: DbTable | undefined = db.tables[name];
        const referenced: string[] =
          table?.foreignKeys.map((foreign: DbForeignKey) => foreign.table) ??
          [];
        return (
          key(referenced) === key([model.tableName, target?.tableName ?? ''])
        );
      });
      if (join === undefined) {
        problems.push(
          `${model.tableName}.${relation.name}: no join table between ${model.tableName} and ${target?.tableName ?? relation.targetModel}`
        );
      } else {
        extra.delete(join);
      }
    }
  }
  for (const name of extra) {
    problems.push(`table ${name} exists in the database but not in the IR`);
  }
  return problems;
}

describe(titleWithReason('sequelize parser: real Sequelize', probe), () => {
  it.skipIf(!probe.available).each(GROUPS)(
    'agrees with the SQLite database Sequelize creates for the $label',
    async (group: VerifyGroup) => {
      const missing: string[] = missingPackages(group);
      if (missing.length > 0) {
        // Not an error: only the base packages are required to run the suite.
        console.warn(
          `Skipped "${group.label}": SEQUELIZE_DIR is missing ${missing.join(', ')}.`
        );
        return;
      }
      const directory: string = mkdtempSync(
        join(tmpdir(), 'ormbridge-sequelize-')
      );
      directories.push(directory);
      symlinkSync(
        join(probe.directory, 'node_modules'),
        join(directory, 'node_modules'),
        'dir'
      );
      for (const file of group.files) {
        mkdirSync(dirname(join(directory, file)), { recursive: true });
        copyFileSync(join(FIXTURES, file), join(directory, file));
      }

      let entry: string = join(directory, group.entry);
      if (entry.endsWith('.ts')) {
        const outDirectory: string = join(directory, 'out');
        const compiled: SpawnSyncReturns<string> = spawnSync(
          join(probe.directory, 'node_modules', '.bin', 'tsc'),
          [
            group.entry,
            '--outDir',
            outDirectory,
            '--module',
            'commonjs',
            '--target',
            'es2020',
            '--experimentalDecorators',
            '--emitDecoratorMetadata',
            '--useDefineForClassFields',
            'false',
            '--esModuleInterop',
            '--skipLibCheck',
            '--strict',
          ],
          { cwd: directory, encoding: 'utf8', timeout: 240_000 }
        );
        expect(compiled.stdout + compiled.stderr, 'tsc').toBe('');
        expect(compiled.status).toBe(0);
        entry = join(outDirectory, `${basename(group.entry, '.ts')}.js`);
      }

      const run: SpawnSyncReturns<string> = spawnSync(
        process.execPath,
        [
          fileURLToPath(
            new URL('./tools/validate-sequelize.mjs', import.meta.url)
          ),
          probe.directory,
          entry,
        ],
        { cwd: directory, encoding: 'utf8', timeout: 240_000 }
      );
      expect(run.status, run.stderr).toBe(0);
      const database: DbSchema = JSON.parse(run.stdout) as DbSchema;

      const ir: IrSchema = expectOk(
        await parseSequelize(
          group.sources.map((path: string) => ({
            path,
            text: readFileSync(path, 'utf8'),
          })),
          { appLabel: 'blog' }
        )
      );
      expect(compareWithDatabase(ir, database)).toEqual([]);
    },
    300_000
  );
});
