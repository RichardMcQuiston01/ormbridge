import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  IrField,
  IrIndex,
  IrModel,
  IrOnDelete,
  IrRelation,
  IrSchema,
} from '../src/ir.js';
import type { DotnetProbe } from './efcoreSupport.js';

/**
 * Support for `test/efcore-migrations-verify.test.ts`: runs `test/tools/efcore-migrations-verify`, which writes the
 * migrations and the model snapshot the real EF Core 8 generates for a sequence of models, and compares what
 * ormbridge reads from them with EF Core's own description of the final model.
 */

const TOOL: string = fileURLToPath(
  new URL('./tools/efcore-migrations-verify', import.meta.url)
);

/** The models the tool compiles and the manifest that lists the scenarios (versions of a model, in order). */
export const MIGRATION_FIXTURES: string = fileURLToPath(
  new URL('./fixtures/efcore-migrations', import.meta.url)
);

export interface ModelColumn {
  name: string;
  storeType: string;
  /** The type the provider stores, after value converters: `System.Int32`, `System.String`. */
  clrType: string;
  nullable: boolean;
}

export interface ModelIndex {
  name: string;
  unique: boolean;
  columns: string[];
  filter: string | null;
}

export interface ModelForeignKey {
  columns: string[];
  principalSchema: string | null;
  principalTable: string;
  principalColumns: string[];
  onDelete: string;
}

export interface ModelTable {
  schema: string | null;
  name: string;
  columns: ModelColumn[];
  primaryKey: string[];
  uniqueConstraints: string[][];
  indexes: ModelIndex[];
  foreignKeys: ModelForeignKey[];
}

/** One version of a model: the files `dotnet ef migrations add` writes for it and what EF Core says the model is. */
export interface MigrationStep {
  files: Record<string, string>;
  model: { tables: ModelTable[] };
}

export interface MigrationScenarioOutput {
  steps?: MigrationStep[];
  __error?: string;
}

export type MigrationToolOutput = Record<string, MigrationScenarioOutput>;

export interface Scenario {
  name: string;
  provider: 'sqlite' | 'npgsql';
  contexts: string[];
  names?: string[];
}

export function readScenarios(): Scenario[] {
  return JSON.parse(
    readFileSync(join(MIGRATION_FIXTURES, 'scenarios.json'), 'utf8')
  ) as Scenario[];
}

/** Builds `test/tools/efcore-migrations-verify` with the .NET SDK and runs it; throws with the output on failure. */
export function runMigrationsTool(probe: DotnetProbe): MigrationToolOutput {
  const work: string = mkdtempSync(join(tmpdir(), 'ormbridge-efmig-'));
  try {
    for (const file of ['EfcoreMigrationsVerify.csproj', 'Program.cs']) {
      copyFileSync(join(TOOL, file), join(work, file));
    }
    mkdirSync(join(probe.directory, 'nuget'), { recursive: true });
    const result: SpawnSyncReturns<string> = spawnSync(
      probe.dotnet,
      [
        'run',
        '--configuration',
        'Release',
        `-p:FixturesDir=${join(MIGRATION_FIXTURES, 'models')}`,
        '--',
        join(MIGRATION_FIXTURES, 'scenarios.json'),
      ],
      {
        cwd: work,
        encoding: 'utf8',
        timeout: 900_000,
        maxBuffer: 256 * 1024 * 1024,
        env: {
          ...process.env,
          NUGET_PACKAGES: join(probe.directory, 'nuget'),
          DOTNET_CLI_HOME: join(probe.directory, 'home'),
          DOTNET_CLI_TELEMETRY_OPTOUT: '1',
          DOTNET_NOLOGO: '1',
          DOTNET_SKIP_FIRST_TIME_EXPERIENCE: '1',
        },
      }
    );
    if (result.status !== 0) {
      throw new Error(
        `dotnet run failed (${result.status}):\n${result.stdout}\n${result.stderr}`
      );
    }
    return JSON.parse(result.stdout) as MigrationToolOutput;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** The files of the first `count` versions: every migration, and the model snapshot of the last one. */
export function filesUpTo(
  steps: readonly MigrationStep[],
  count: number,
  withSnapshot: boolean
): { path: string; text: string }[] {
  const files: { path: string; text: string }[] = [];
  steps.slice(0, count).forEach((step: MigrationStep, index: number) => {
    for (const [path, text] of Object.entries(step.files)) {
      const isSnapshot: boolean = path.endsWith('ModelSnapshot.cs');
      if (isSnapshot && !(withSnapshot && index === count - 1)) {
        continue;
      }
      files.push({ path, text });
    }
  });
  return files;
}

// ---------------------------------------------------------------------------
// Comparing the replay with EF Core's description of the model
// ---------------------------------------------------------------------------

function tableKey(schema: string | null | undefined, name: string): string {
  return schema === null || schema === undefined || schema === ''
    ? name
    : `${schema}.${name}`;
}

const ACTIONS: Readonly<Record<string, IrOnDelete>> = {
  Cascade: 'cascade',
  SetNull: 'setNull',
  Restrict: 'restrict',
  NoAction: 'noAction',
  ClientSetNull: 'noAction',
  ClientCascade: 'noAction',
  ClientNoAction: 'noAction',
};

/** The IR types a provider type may be read as (a string without a length is `text`, with one `string`). */
function expectedTypes(column: ModelColumn): string[] {
  const store: string = column.storeType.toLowerCase();
  if (store.includes('json')) {
    return ['json'];
  }
  switch (column.clrType) {
    case 'System.Int32':
    case 'System.Int16':
    case 'System.Byte':
    case 'System.SByte':
    case 'System.UInt16':
    case 'System.UInt32':
      return ['int'];
    case 'System.Int64':
    case 'System.UInt64':
      return ['bigInt'];
    case 'System.String':
      return ['string', 'text'];
    case 'System.Boolean':
      return ['boolean'];
    case 'System.Decimal':
      return ['decimal'];
    case 'System.Double':
    case 'System.Single':
      return ['float'];
    case 'System.DateTime':
    case 'System.DateTimeOffset':
      return store === 'date' ? ['date'] : ['dateTime'];
    case 'System.DateOnly':
      return ['date'];
    case 'System.TimeOnly':
      return ['time'];
    case 'System.TimeSpan':
      return ['duration'];
    case 'System.Guid':
      return ['uuid'];
    case 'System.Byte[]':
      return ['bytes'];
    case 'System.Net.IPAddress':
      return ['ipAddress'];
    default:
      return column.clrType.startsWith('System.Collections.Generic.List')
        ? ['int', 'text', 'string', 'bigInt']
        : [];
  }
}

interface IrColumn {
  nullable: boolean;
  type: string | undefined;
  isUnique: boolean;
}

function irColumns(model: IrModel): Map<string, IrColumn> {
  const columns: Map<string, IrColumn> = new Map();
  for (const field of model.fields) {
    columns.set(field.columnName, {
      nullable: field.isNullable,
      type: field.type,
      isUnique: field.isUnique,
    });
  }
  for (const relation of model.relations) {
    columns.set(relation.columnName, {
      nullable: relation.isNullable,
      type: undefined,
      isUnique: relation.kind === 'oneToOne',
    });
  }
  return columns;
}

/** Maps an IR field or relation name to the column it stores. */
function columnOfName(model: IrModel, name: string): string | undefined {
  return (
    model.fields.find((field: IrField) => field.name === name)?.columnName ??
    model.relations.find((relation: IrRelation) => relation.name === name)
      ?.columnName
  );
}

function sorted(items: readonly string[]): string {
  return [...items].sort().join(',');
}

/**
 * Compares the schema ormbridge read from the migrations with the description of the final model that EF Core
 * itself gives: the tables, columns with their nullability and type, the primary key, the unique keys, the
 * indexes and the foreign keys with their actions. Returns the differences; an empty list means they agree.
 */
export function compareWithModel(
  schema: IrSchema,
  tables: readonly ModelTable[]
): string[] {
  const differences: string[] = [];
  const byTable: Map<string, IrModel> = new Map(
    schema.models.map((model: IrModel): [string, IrModel] => [
      tableKey(model.schema, model.tableName),
      model,
    ])
  );
  const expected: Set<string> = new Set(
    tables.map((table: ModelTable) => tableKey(table.schema, table.name))
  );
  for (const key of byTable.keys()) {
    if (!expected.has(key)) {
      differences.push(`table ${key}: read, but EF Core has no such table`);
    }
  }
  for (const table of tables) {
    const key: string = tableKey(table.schema, table.name);
    const model: IrModel | undefined = byTable.get(key);
    if (model === undefined) {
      differences.push(`table ${key}: EF Core has it, but it was not read`);
      continue;
    }
    const columns: Map<string, IrColumn> = irColumns(model);
    const names: Set<string> = new Set(
      table.columns.map((column: ModelColumn) => column.name)
    );
    for (const name of columns.keys()) {
      if (!names.has(name)) {
        differences.push(
          `${key}.${name}: read, but EF Core has no such column`
        );
      }
    }
    for (const column of table.columns) {
      const read: IrColumn | undefined = columns.get(column.name);
      if (read === undefined) {
        differences.push(
          `${key}.${column.name}: EF Core has it, but it was not read`
        );
        continue;
      }
      if (read.nullable !== column.nullable) {
        differences.push(
          `${key}.${column.name}: nullable is ${String(read.nullable)}, EF Core says ${String(column.nullable)}`
        );
      }
      const types: string[] = expectedTypes(column);
      if (
        read.type !== undefined &&
        types.length > 0 &&
        !types.includes(read.type)
      ) {
        differences.push(
          `${key}.${column.name}: type is ${read.type}, EF Core stores ${column.clrType} (${column.storeType})`
        );
      }
    }
    differences.push(...comparePrimaryKey(key, model, table));
    differences.push(...compareForeignKeys(key, model, table, tables, schema));
    differences.push(...compareIndexes(key, model, table));
  }
  return differences;
}

function comparePrimaryKey(
  key: string,
  model: IrModel,
  table: ModelTable
): string[] {
  const read: string[] =
    model.compositePrimaryKey !== undefined
      ? model.compositePrimaryKey.map(
          (name: string) => columnOfName(model, name) ?? name
        )
      : [
          ...model.fields
            .filter((field: IrField) => field.isPrimaryKey)
            .map((field: IrField) => field.columnName),
          ...model.relations
            .filter((relation: IrRelation) => relation.isPrimaryKey === true)
            .map((relation: IrRelation) => relation.columnName),
        ];
  return sorted(read) === sorted(table.primaryKey)
    ? []
    : [
        `${key}: primary key is (${sorted(read)}), EF Core says (${sorted(table.primaryKey)})`,
      ];
}

function compareForeignKeys(
  key: string,
  model: IrModel,
  table: ModelTable,
  tables: readonly ModelTable[],
  schema: IrSchema
): string[] {
  const modelOf = (name: string): IrModel | undefined =>
    schema.models.find((candidate: IrModel) => candidate.name === name);
  const read: Set<string> = new Set();
  for (const relation of model.relations) {
    const target: IrModel | undefined = modelOf(relation.targetModel);
    read.add(
      `${relation.columnName}->${tableKey(target?.schema, target?.tableName ?? relation.targetModel)}:${relation.onDelete}`
    );
  }
  for (const composite of model.compositeForeignKeys ?? []) {
    const target: IrModel | undefined = modelOf(composite.targetModel);
    read.add(
      `${sorted(
        composite.fields.map(
          (name: string) => columnOfName(model, name) ?? name
        )
      )}->${tableKey(target?.schema, target?.tableName ?? composite.targetModel)}:${composite.onDelete}`
    );
  }
  const expected: Set<string> = new Set(
    table.foreignKeys.map((foreignKey: ModelForeignKey) => {
      const target: ModelTable | undefined = tables.find(
        (candidate: ModelTable) =>
          candidate.name === foreignKey.principalTable &&
          (candidate.schema ?? null) === foreignKey.principalSchema
      );
      return `${sorted(foreignKey.columns)}->${tableKey(target?.schema, foreignKey.principalTable)}:${ACTIONS[foreignKey.onDelete] ?? foreignKey.onDelete}`;
    })
  );
  const differences: string[] = [];
  for (const item of read) {
    if (!expected.has(item)) {
      differences.push(
        `${key}: foreign key ${item} was read, EF Core has none`
      );
    }
  }
  for (const item of expected) {
    if (!read.has(item)) {
      differences.push(
        `${key}: foreign key ${item} is in EF Core, but was not read`
      );
    }
  }
  return differences;
}

function compareIndexes(
  key: string,
  model: IrModel,
  table: ModelTable
): string[] {
  const differences: string[] = [];
  const foreignKeyColumns: Set<string> = new Set(
    table.foreignKeys.map((foreignKey: ModelForeignKey) =>
      sorted(foreignKey.columns)
    )
  );
  // What EF Core says is unique: unique indexes and alternate keys; the primary key is compared on its own.
  const uniqueSets: Set<string> = new Set([
    ...table.indexes
      .filter((index: ModelIndex) => index.unique)
      .map((index: ModelIndex) => sorted(index.columns)),
    ...table.uniqueConstraints.map((columns: string[]) => sorted(columns)),
  ]);
  const readUnique: Set<string> = new Set();
  for (const field of model.fields) {
    if (field.isUnique) {
      readUnique.add(field.columnName);
    }
  }
  for (const relation of model.relations) {
    if (relation.kind === 'oneToOne') {
      readUnique.add(relation.columnName);
    }
  }
  for (const composite of model.compositeForeignKeys ?? []) {
    if (composite.kind === 'oneToOne') {
      readUnique.add(
        sorted(
          composite.fields.map(
            (name: string) => columnOfName(model, name) ?? name
          )
        )
      );
    }
  }
  const readIndexes: Set<string> = new Set();
  for (const index of model.indexes as IrIndex[]) {
    const columns: string = sorted(
      index.fields.map((name: string) => columnOfName(model, name) ?? name)
    );
    (index.isUnique ? readUnique : readIndexes).add(columns);
  }
  const primaryKey: string = sorted(table.primaryKey);
  for (const item of readUnique) {
    // A foreign key that is the whole primary key is unique because of the key.
    if (!uniqueSets.has(item) && item !== primaryKey) {
      differences.push(
        `${key}: (${item}) was read as unique, EF Core does not say so`
      );
    }
  }
  for (const item of uniqueSets) {
    if (!readUnique.has(item) && item !== primaryKey) {
      differences.push(
        `${key}: unique (${item}) is in EF Core, but was not read`
      );
    }
  }
  const plain: Set<string> = new Set(
    table.indexes
      .filter((index: ModelIndex) => !index.unique)
      .map((index: ModelIndex) => sorted(index.columns))
  );
  for (const item of readIndexes) {
    if (!plain.has(item)) {
      differences.push(`${key}: index (${item}) was read, EF Core has none`);
    }
  }
  for (const item of plain) {
    // EF Core adds an index for every foreign key on its own; the reader leaves those out.
    if (!readIndexes.has(item) && !foreignKeyColumns.has(item)) {
      differences.push(
        `${key}: index (${item}) is in EF Core, but was not read`
      );
    }
  }
  return differences;
}
