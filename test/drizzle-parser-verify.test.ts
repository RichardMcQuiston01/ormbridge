import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import type {
  IrCompositeForeignKey,
  IrEnum,
  IrField,
  IrIndex,
  IrModel,
  IrOnDelete,
  IrRelation,
  IrSchema,
} from '../src/ir.js';
import { parseDrizzle } from '../src/parsers/drizzle.js';
import { CANONICAL_FIXTURES } from './fixtures/canonical.js';
import { expectOk } from './helpers.js';
import {
  titleWithReason,
  writeProjectFile,
  type ToolProbe,
} from './realToolSupport.js';

/**
 * Loads the Drizzle fixtures with the real tools: `tsc` type-checks them against drizzle-orm, and
 * `drizzle-kit generate` builds Drizzle's own snapshot of the schema (tables, columns, keys, foreign
 * keys, indexes, enums), which is compared with what the parser read. The comparison is one way for
 * constructs the parser deliberately drops (partial and expression indexes, check constraints).
 *
 * Set DRIZZLE_DIR to a directory where `npm install drizzle-orm drizzle-kit typescript @types/node`
 * has been run (see test/README.md and test/tools/setup-verification-tools.sh). The tests are
 * skipped when it is not set.
 */

type KitDialect = 'postgresql' | 'mysql' | 'sqlite';

interface VerifyGroup {
  label: string;
  dialect: KitDialect;
  /** Absolute paths of the files that make the schema. */
  paths: string[];
}

const REQUIRED_PACKAGES: readonly string[] = [
  'drizzle-orm',
  'drizzle-kit',
  'typescript',
  '@types/node',
];

const EXTRAS_DIRECTORY: string = fileURLToPath(
  new URL('./fixtures/drizzle-extras/', import.meta.url)
);

function extrasWith(suffix: string): string[] {
  return readdirSync(EXTRAS_DIRECTORY)
    .filter((name: string) => name.endsWith(suffix))
    .sort()
    .map((name: string) => join(EXTRAS_DIRECTORY, name));
}

const GROUPS: readonly VerifyGroup[] = [
  {
    label: 'canonical blog schema',
    dialect: 'postgresql',
    paths:
      CANONICAL_FIXTURES.find((fixture) => fixture.format === 'drizzle')
        ?.paths ?? [],
  },
  {
    label: 'extras (PostgreSQL)',
    dialect: 'postgresql',
    paths: extrasWith('.pg.ts'),
  },
  { label: 'extras (MySQL)', dialect: 'mysql', paths: extrasWith('.mysql.ts') },
  {
    label: 'extras (SQLite)',
    dialect: 'sqlite',
    paths: extrasWith('.sqlite.ts'),
  },
];

const TSCONFIG: string = JSON.stringify(
  {
    compilerOptions: {
      target: 'ES2022',
      module: 'ESNext',
      moduleResolution: 'Bundler',
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      types: ['node'],
    },
    include: ['schema'],
  },
  null,
  2
);

function probeDrizzle(): ToolProbe & { directory: string } {
  const directory: string = process.env.DRIZZLE_DIR ?? '';
  if (directory === '') {
    return {
      available: false,
      reason:
        'set DRIZZLE_DIR to a directory with drizzle-orm, drizzle-kit and typescript installed (see test/README.md)',
      directory,
    };
  }
  const missing: string[] = REQUIRED_PACKAGES.filter(
    (name: string) =>
      !existsSync(join(directory, 'node_modules', name, 'package.json'))
  );
  if (missing.length > 0) {
    return {
      available: false,
      reason: `DRIZZLE_DIR is missing ${missing.join(', ')} (see test/README.md)`,
      directory,
    };
  }
  return { available: true, reason: '', directory };
}

const probe: ReturnType<typeof probeDrizzle> = probeDrizzle();
const directories: string[] = [];

afterAll(() => {
  for (const directory of directories) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function run(
  directory: string,
  command: string,
  args: string[]
): SpawnSyncReturns<string> {
  return spawnSync(command, args, {
    cwd: directory,
    encoding: 'utf8',
    timeout: 240_000,
  });
}

// The parts of drizzle-kit's snapshot (versions 5 to 7) this test reads.
interface SnapshotColumn {
  name: string;
  notNull: boolean;
  primaryKey: boolean;
}

interface SnapshotForeignKey {
  tableTo: string;
  schemaTo?: string;
  columnsFrom: string[];
  columnsTo: string[];
  onDelete?: string;
  onUpdate?: string;
}

interface SnapshotIndex {
  name: string;
  columns: (string | { expression?: string; isExpression?: boolean })[];
  isUnique: boolean;
}

interface SnapshotTable {
  name: string;
  schema?: string;
  columns: Record<string, SnapshotColumn>;
  indexes: Record<string, SnapshotIndex>;
  foreignKeys: Record<string, SnapshotForeignKey>;
  compositePrimaryKeys?: Record<string, { columns: string[] }>;
  uniqueConstraints?: Record<string, { columns: string[] }>;
}

interface Snapshot {
  tables: Record<string, SnapshotTable>;
  enums?: Record<string, { name: string; schema?: string; values: string[] }>;
}

const ACTIONS: Readonly<Record<IrOnDelete, string>> = {
  cascade: 'cascade',
  setNull: 'set null',
  restrict: 'restrict',
  noAction: 'no action',
  setDefault: 'set default',
};

function tableKey(schema: string | undefined, name: string): string {
  return schema === undefined || schema === 'public' || schema === ''
    ? name
    : `${schema}.${name}`;
}

/** Lists everything the snapshot disagrees with the IR about; empty when they match. */
function compareWithSnapshot(ir: IrSchema, snapshot: Snapshot): string[] {
  const problems: string[] = [];
  const tables: Map<string, SnapshotTable> = new Map(
    Object.values(snapshot.tables).map((table: SnapshotTable) => [
      tableKey(table.schema, table.name),
      table,
    ])
  );
  const modelKeys: Set<string> = new Set(
    ir.models.map((model: IrModel) => tableKey(model.schema, model.tableName))
  );
  for (const key of tables.keys()) {
    if (!modelKeys.has(key)) {
      problems.push(`drizzle-kit has the table ${key}, the parser does not`);
    }
  }
  const columnOf = (model: IrModel, name: string): string => {
    const found: IrField | IrRelation | undefined =
      model.fields.find((item: IrField) => item.name === name) ??
      model.relations.find((item: IrRelation) => item.name === name);
    return found?.columnName ?? name;
  };

  for (const model of ir.models) {
    const key: string = tableKey(model.schema, model.tableName);
    const table: SnapshotTable | undefined = tables.get(key);
    if (table === undefined) {
      problems.push(`the parser has the table ${key}, drizzle-kit does not`);
      continue;
    }
    const expectedColumns: Map<
      string,
      { nullable: boolean; primary: boolean }
    > = new Map();
    for (const field of model.fields) {
      expectedColumns.set(field.columnName, {
        nullable: field.isNullable,
        primary: field.isPrimaryKey,
      });
    }
    for (const relation of model.relations) {
      expectedColumns.set(relation.columnName, {
        nullable: relation.isNullable,
        primary: relation.isPrimaryKey === true,
      });
    }
    const actualNames: string[] = Object.values(table.columns).map(
      (column: SnapshotColumn) => column.name
    );
    expect([...expectedColumns.keys()].sort(), `${key} columns`).toEqual(
      actualNames.sort()
    );
    for (const column of Object.values(table.columns)) {
      const expected = expectedColumns.get(column.name);
      if (expected === undefined) {
        continue;
      }
      if (column.notNull === expected.nullable) {
        problems.push(
          `${key}.${column.name}: notNull is ${String(column.notNull)} in drizzle-kit`
        );
      }
      const isKeyColumn: boolean =
        column.primaryKey ||
        // MySQL lists even a single-column primary key as a (composite) constraint.
        Object.values(table.compositePrimaryKeys ?? {}).some(
          (entry) => entry.columns.join(',') === column.name
        );
      if (expected.primary && !isKeyColumn) {
        problems.push(
          `${key}.${column.name}: is not a primary key in drizzle-kit`
        );
      }
    }
    if (model.compositePrimaryKey !== undefined) {
      const expected: string = model.compositePrimaryKey
        .map((name: string) => columnOf(model, name))
        .join(',');
      const found: boolean = Object.values(
        table.compositePrimaryKeys ?? {}
      ).some((entry) => entry.columns.join(',') === expected);
      if (!found) {
        problems.push(`${key}: composite primary key (${expected}) not found`);
      }
    }

    const foreignKeys: SnapshotForeignKey[] = Object.values(table.foreignKeys);
    const targetKey = (name: string): string => {
      const target: IrModel | undefined = ir.models.find(
        (item: IrModel) => item.name === name
      );
      return target === undefined
        ? name
        : tableKey(target.schema, target.tableName);
    };
    const snapshotTarget = (foreignKey: SnapshotForeignKey): string =>
      tableKey(foreignKey.schemaTo, foreignKey.tableTo);
    for (const relation of model.relations) {
      const found: SnapshotForeignKey | undefined = foreignKeys.find(
        (candidate: SnapshotForeignKey) =>
          candidate.columnsFrom.join(',') === relation.columnName &&
          snapshotTarget(candidate) === targetKey(relation.targetModel)
      );
      if (found === undefined) {
        problems.push(`${key}.${relation.columnName}: foreign key not found`);
      } else if (
        (found.onDelete ?? 'no action') !== ACTIONS[relation.onDelete] ||
        (found.onUpdate ?? 'no action') !==
          ACTIONS[relation.onUpdate ?? 'noAction']
      ) {
        problems.push(
          `${key}.${relation.columnName}: actions are ${String(found.onDelete)}/${String(found.onUpdate)} in drizzle-kit`
        );
      }
    }
    for (const composite of model.compositeForeignKeys ??
      ([] as IrCompositeForeignKey[])) {
      const columns: string = composite.fields
        .map((name: string) => columnOf(model, name))
        .join(',');
      if (
        !foreignKeys.some(
          (candidate: SnapshotForeignKey) =>
            candidate.columnsFrom.join(',') === columns &&
            snapshotTarget(candidate) === targetKey(composite.targetModel)
        )
      ) {
        problems.push(`${key}: composite foreign key (${columns}) not found`);
      }
    }

    const snapshotIndexes: { columns: string; isUnique: boolean }[] = [
      ...Object.values(table.indexes).map((index: SnapshotIndex) => ({
        columns: index.columns
          .map((column) =>
            typeof column === 'string' ? column : (column.expression ?? '?')
          )
          .join(','),
        isUnique: index.isUnique,
      })),
      ...Object.values(table.uniqueConstraints ?? {}).map((entry) => ({
        columns: entry.columns.join(','),
        isUnique: true,
      })),
    ];
    const expectedIndexes: { columns: string; isUnique: boolean }[] = [
      ...model.indexes.map((index: IrIndex) => ({
        columns: index.fields
          .map((name: string) => columnOf(model, name))
          .join(','),
        isUnique: index.isUnique,
      })),
      ...model.fields
        .filter((field: IrField) => field.isUnique)
        .map((field: IrField) => ({
          columns: field.columnName,
          isUnique: true,
        })),
    ];
    for (const index of expectedIndexes) {
      if (
        !snapshotIndexes.some(
          (candidate) =>
            candidate.columns === index.columns &&
            candidate.isUnique === index.isUnique
        )
      ) {
        problems.push(
          `${key}: ${index.isUnique ? 'unique ' : ''}index on (${index.columns}) not found`
        );
      }
    }
  }

  for (const enumeration of ir.enums.filter(
    (item: IrEnum) => item.dbName !== undefined || item.schema !== undefined
  )) {
    const key: string = tableKey(
      enumeration.schema,
      enumeration.dbName ?? enumeration.name
    );
    const found = Object.values(snapshot.enums ?? {}).find(
      (candidate) => tableKey(candidate.schema, candidate.name) === key
    );
    if (found === undefined) {
      problems.push(`enum ${key} not found in drizzle-kit`);
    } else if (
      found.values.join(',') !==
      enumeration.values.map((value) => value.dbValue).join(',')
    ) {
      problems.push(`enum ${key} has other values in drizzle-kit`);
    }
  }
  return problems;
}

describe(titleWithReason('drizzle parser: real Drizzle', probe), () => {
  it.skipIf(!probe.available).each(GROUPS)(
    'type-checks the $label with tsc and agrees with drizzle-kit',
    async (group: VerifyGroup) => {
      const toolBin: string = join(probe.directory, 'node_modules', '.bin');
      const directory: string = mkdtempSync(
        join(tmpdir(), 'ormbridge-drizzle-')
      );
      directories.push(directory);
      symlinkSync(
        join(probe.directory, 'node_modules'),
        join(directory, 'node_modules'),
        'dir'
      );
      mkdirSync(join(directory, 'schema'));
      for (const path of group.paths) {
        copyFileSync(path, join(directory, 'schema', basename(path)));
      }
      writeProjectFile(directory, 'tsconfig.json', TSCONFIG);
      writeProjectFile(
        directory,
        'drizzle.config.ts',
        `export default { dialect: '${group.dialect}', schema: './schema', out: './out' };\n`
      );

      const compiled: SpawnSyncReturns<string> = run(
        directory,
        join(toolBin, 'tsc'),
        ['-p', 'tsconfig.json']
      );
      expect(compiled.stdout + compiled.stderr, 'tsc').toBe('');
      expect(compiled.status).toBe(0);

      const generated: SpawnSyncReturns<string> = run(
        directory,
        join(toolBin, 'drizzle-kit'),
        ['generate', '--config', 'drizzle.config.ts']
      );
      expect(generated.stderr, generated.stdout).toBe('');
      expect(generated.status).toBe(0);

      const snapshot: Snapshot = JSON.parse(
        readFileSync(
          join(directory, 'out', 'meta', '0000_snapshot.json'),
          'utf8'
        )
      ) as Snapshot;
      const ir: IrSchema = expectOk(
        await parseDrizzle(
          group.paths.map((path: string) => ({
            path,
            text: readFileSync(path, 'utf8'),
          })),
          { appLabel: 'blog' }
        )
      );
      expect(compareWithSnapshot(ir, snapshot)).toEqual([]);
    },
    300_000
  );
});
