import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { IrModel, IrRelation, IrSchema } from '../src/ir.js';
import { parseEfcore } from '../src/parsers/efcore.js';
import type { ToolProbe } from './realToolSupport.js';
import type {
  DbColumn,
  DbForeignKey,
  DbIndex,
  DbSchema,
  DbTable,
} from './sequelizeSupport.js';

/**
 * What `test/tools/efcore-verify` prints for one DbContext: the tables of the SQLite database that EF Core
 * creates (`EnsureCreated`), straight from the `PRAGMA` statements.
 */
export interface EfcoreColumn {
  name: string;
  type: string;
  notNull: boolean;
  /** Position in the primary key, 0 when the column is not part of it. */
  primaryKey: number;
  /** True for computed columns, which SQLite reports as nullable. */
  generated: boolean;
  default: string | null;
}

export interface EfcoreForeignKey {
  table: string;
  from: string[];
  to: string[];
  onDelete: string;
  onUpdate: string;
}

export interface EfcoreTable {
  columns: EfcoreColumn[];
  indexes: DbIndex[];
  foreignKeys: EfcoreForeignKey[];
}

export type EfcoreDatabase = Record<string, EfcoreTable>;

/** What the tool prints for a context whose model EF Core rejected. */
export interface EfcoreToolError {
  __error: string;
}

/** The tool prints one database per DbContext name it was given. */
export type EfcoreToolOutput = Record<string, EfcoreDatabase | EfcoreToolError>;

export function isToolError(
  value: EfcoreDatabase | EfcoreToolError | undefined
): value is EfcoreToolError {
  return (
    value !== undefined &&
    typeof (value as EfcoreToolError).__error === 'string'
  );
}

/** The key under which `--exercise` puts the rows it wrote next to the tables. */
export const EXERCISE_KEY: string = '__exercise';

/** What the tool saw when it added rows through the entity classes (see `Exercise` in the tool). */
export interface EfcoreExercise {
  /** The row read back with SQL, by table. */
  rows: Record<string, Record<string, unknown> | null>;
  /** The columns EF Core refreshed on update: [before, after] by table and column. */
  updates: Record<string, Record<string, [unknown, unknown]>>;
  errors: string[];
}

/** Splits the exercise result off the tables of a context. */
export function splitExercise(database: EfcoreDatabase): {
  tables: EfcoreDatabase;
  exercise: EfcoreExercise | undefined;
} {
  const { [EXERCISE_KEY]: exercise, ...tables } = database as Record<
    string,
    unknown
  >;
  return {
    tables: tables as EfcoreDatabase,
    exercise: exercise as EfcoreExercise | undefined,
  };
}

/**
 * Turns the tool output into the shape the shared comparison reads. Two things EF Core adds on its own are
 * left out because the model never asked for them: the index on every foreign key column (`IX_<table>_<column>`),
 * unless the IR lists the index, and the null flag of computed columns, which SQLite does not report.
 */
export function toDbSchema(database: EfcoreDatabase, ir: IrSchema): DbSchema {
  const tables: Record<string, DbTable> = {};
  for (const [name, table] of Object.entries(database)) {
    if (name === EXERCISE_KEY) {
      continue;
    }
    const model: IrModel | undefined = ir.models.find(
      (candidate: IrModel) => candidate.tableName === name
    );
    const foreignColumns: Set<string> = new Set(
      table.foreignKeys.map((foreign: EfcoreForeignKey) =>
        [...foreign.from].sort().join(',')
      )
    );
    const declared: Set<string> = new Set(
      (model?.indexes ?? []).map((index) =>
        index.fields
          .map(
            (field: string) =>
              model?.fields.find((candidate) => candidate.name === field)
                ?.columnName ??
              model?.relations.find(
                (candidate: IrRelation) => candidate.name === field
              )?.columnName ??
              field
          )
          .sort()
          .join(',')
      )
    );
    const columns: DbColumn[] = table.columns.map(
      (column: EfcoreColumn): DbColumn => {
        const irField = model?.fields.find(
          (candidate) => candidate.columnName === column.name
        );
        return {
          name: column.name,
          allowNull:
            column.generated && irField !== undefined
              ? irField.isNullable
              : !column.notNull,
        };
      }
    );
    const indexes: DbIndex[] = table.indexes.filter((index: DbIndex) => {
      const key: string = [...index.columns].sort().join(',');
      const isAutomatic: boolean =
        !index.unique &&
        index.name.startsWith('IX_') &&
        foreignColumns.has(key) &&
        !declared.has(key);
      return !isAutomatic;
    });
    const foreignKeys: DbForeignKey[] = table.foreignKeys.map(
      (foreign: EfcoreForeignKey): DbForeignKey => ({
        column: foreign.from.join(','),
        table: foreign.table,
        to: foreign.to.join(','),
        onDelete: foreign.onDelete,
        onUpdate: foreign.onUpdate,
      })
    );
    tables[name] = {
      columns,
      primaryKey: table.columns
        .filter((column: EfcoreColumn) => column.primaryKey > 0)
        .sort(
          (first: EfcoreColumn, second: EfcoreColumn) =>
            first.primaryKey - second.primaryKey
        )
        .map((column: EfcoreColumn) => column.name),
      indexes,
      foreignKeys,
    };
  }
  return { tables };
}

// ---------------------------------------------------------------------------
// Running the tool
// ---------------------------------------------------------------------------

const TOOL: string = fileURLToPath(
  new URL('./tools/efcore-verify', import.meta.url)
);

export interface DotnetProbe extends ToolProbe {
  dotnet: string;
  directory: string;
}

/**
 * Looks for the .NET SDK: EFCORE_DIR names a scratch directory (the NuGet cache and the home of the dotnet CLI go
 * there) and DOTNET the dotnet executable when it is not on the PATH.
 */
export function probeDotnet(): DotnetProbe {
  const directory: string = process.env.EFCORE_DIR ?? '';
  const dotnet: string = process.env.DOTNET ?? 'dotnet';
  if (directory === '') {
    return {
      available: false,
      reason:
        'set EFCORE_DIR to a scratch directory and have the .NET 8 SDK installed (DOTNET names the dotnet executable; see test/README.md)',
      dotnet,
      directory,
    };
  }
  const version: SpawnSyncReturns<string> = spawnSync(dotnet, ['--version'], {
    encoding: 'utf8',
  });
  if (version.error !== undefined || version.status !== 0) {
    return {
      available: false,
      reason: `the .NET SDK was not found (${dotnet} --version failed); install .NET 8 or set DOTNET (see test/README.md)`,
      dotnet,
      directory,
    };
  }
  return { available: true, reason: '', dotnet, directory };
}

export interface ToolRun {
  /** The directory that holds the C# files, compiled together (each group in its own namespace). */
  fixturesDir: string;
  /** The names (or full names) of the DbContext types to create. */
  contexts: readonly string[];
  /** Also add a row to every table through the entity classes (`--exercise`, see the tool). */
  exercise?: boolean;
  /** Compile with warnings as errors and without the nullable warning exception the hand-written fixtures need. */
  strict?: boolean;
}

/** Builds `test/tools/efcore-verify` with the .NET SDK and runs it; throws with the compiler output on failure. */
export function runEfcoreTool(
  probe: DotnetProbe,
  run: ToolRun
): EfcoreToolOutput {
  const work: string = mkdtempSync(join(tmpdir(), 'ormbridge-efcore-'));
  try {
    for (const file of ['EfcoreVerify.csproj', 'Program.cs']) {
      copyFileSync(join(TOOL, file), join(work, file));
    }
    mkdirSync(join(probe.directory, 'nuget'), { recursive: true });
    const result: SpawnSyncReturns<string> = spawnSync(
      probe.dotnet,
      [
        'run',
        '--configuration',
        'Release',
        `-p:FixturesDir=${run.fixturesDir}`,
        ...(run.strict === true ? ['-p:Strict=true'] : []),
        '--',
        ...(run.exercise === true ? ['--exercise'] : []),
        ...run.contexts,
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
    return JSON.parse(result.stdout) as EfcoreToolOutput;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Reading the C# fixtures
// ---------------------------------------------------------------------------

const FIXTURES: string = fileURLToPath(new URL('./fixtures', import.meta.url));

/** Every `.cs` file below a directory, sorted. */
export function csharpFiles(directory: string): string[] {
  return readdirSync(directory)
    .sort()
    .flatMap((entry: string): string[] => {
      const path: string = join(directory, entry);
      if (statSync(path).isDirectory()) {
        return csharpFiles(path);
      }
      return path.endsWith('.cs') ? [path] : [];
    });
}

/** The directories of `test/fixtures/efcore-extras` that hold one DbContext each. */
export const EFCORE_EXTRAS: readonly string[] = [
  'shop',
  'library',
  'inheritance',
];

/** Reads one of the `efcore-extras` fixtures into the IR. */
export async function parseEfcoreExtra(name: string): Promise<IrSchema> {
  const result = await parseEfcore(
    csharpFiles(join(FIXTURES, 'efcore-extras', name)).map((path: string) => ({
      path,
      text: readFileSync(path, 'utf8'),
    })),
    { appLabel: 'blog' }
  );
  if (!result.ok) {
    throw new Error(`${result.error.code}: ${result.error.message}`);
  }
  return result.value;
}
