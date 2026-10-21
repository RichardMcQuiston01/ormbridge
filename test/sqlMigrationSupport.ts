import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { IrSchema } from '../src/ir.js';
import { runConversion } from '../src/io.js';
import { parseSqlDdl } from '../src/parsers/sqlDdl.js';
import { openCockroach, probeCockroach } from './cockroachSupport.js';
import { DEFAULT_OPTIONS, expectOk } from './helpers.js';
import type { ToolProbe } from './realToolSupport.js';
import {
  mysqlConnection,
  openSqlite,
  probeCommand,
  probeMysql,
  probePostgres,
  probeSqlite,
  randomName,
  runClient,
  type MysqlConnection,
  type SqlEngine,
} from './sqlDdlSupport.js';

/**
 * Helpers for the tests that replay a set of migration files and compare the result with what a real
 * database holds after running the same files. A scenario is a directory of migrations under
 * `test/fixtures/sql-migrations/<engine>/<scenario>`. The replay is the SQL reader reading the directory
 * (so the file order is the CLI's); the reference is the schema the live server dumps afterwards
 * (`pg_dump --schema-only`, `SHOW CREATE TABLE` or `sqlite_master`), read with the same reader.
 */

export const MIGRATION_FIXTURES: string = fileURLToPath(
  new URL('./fixtures/sql-migrations/', import.meta.url)
);

export type MigrationEngineName =
  'postgresql' | 'mysql' | 'sqlite' | 'cockroachdb';

/** A live database the migrations were run in, and the dump it produced. */
export interface MigrationRun {
  dump: string;
  dispose(): void;
}

export interface MigrationEngine {
  name: MigrationEngineName;
  /** Why the engine cannot run here, or available. */
  probe: ToolProbe;
  /** Runs the files in the given order in a fresh database and dumps the schema. */
  run(files: string[]): MigrationRun;
}

/** The files of a scenario in the order the CLI reads them, and the schema read from them. */
export async function replayDirectory(directory: string): Promise<{
  files: string[];
  schema: IrSchema;
}> {
  const summary = expectOk(
    await runConversion({
      ...DEFAULT_OPTIONS,
      inputs: [directory],
      from: 'sql',
      to: 'prisma',
    })
  );
  const schema: IrSchema = expectOk(
    parseSqlDdl(
      summary.inputFiles.map((path: string) => ({
        path,
        text: readFileSync(path, 'utf8'),
      })),
      { appLabel: 'app' }
    )
  );
  return { files: summary.inputFiles, schema };
}

export function readDump(dump: string): IrSchema {
  return expectOk(
    parseSqlDdl([{ path: 'dump.sql', text: dump }], { appLabel: 'app' })
  );
}

/** The names of the files, for comparing an order. */
export function names(files: readonly string[]): string[] {
  return files.map((file: string) => basename(file));
}

// ---------------------------------------------------------------------------
// Comparing two schemas
// ---------------------------------------------------------------------------

/**
 * The schema as plain data for an exact comparison, minus what the documented differences between a replay
 * and a dump allow: warnings; the names the database invents (`_pkey` and `_fkey` in PostgreSQL, `_ibfk_N` in
 * MySQL; a table keeps them when it is renamed, so they are not derivable from the migrations); and the type
 * cast PostgreSQL appends to a default expression (`'{}'::text[]`). Everything else, down to the order of
 * the columns, has to match.
 */
export function canonicalSchema(schema: IrSchema): unknown {
  const copy: IrSchema = structuredClone(schema);
  const generated: RegExp = /_(?:pkey|fkey|ibfk_\d+)$/;
  const models = [...copy.models].sort((left, right) =>
    left.tableName.localeCompare(right.tableName)
  );
  for (const model of models) {
    if (
      model.primaryKeyName !== undefined &&
      generated.test(model.primaryKeyName)
    ) {
      delete model.primaryKeyName;
    }
    for (const relation of model.relations) {
      if (
        relation.constraintName !== undefined &&
        generated.test(relation.constraintName)
      ) {
        delete relation.constraintName;
      }
    }
    for (const key of model.compositeForeignKeys ?? []) {
      if (
        key.constraintName !== undefined &&
        generated.test(key.constraintName)
      ) {
        delete key.constraintName;
      }
    }
    for (const field of model.fields) {
      if (field.default?.kind === 'dbExpression') {
        field.default = {
          ...field.default,
          expression: field.default.expression.replace(
            /::[a-z_ ]+(?:\[\])?/gi,
            ''
          ),
        };
      }
    }
    model.relations.sort((left, right) => left.name.localeCompare(right.name));
    model.indexes.sort((left, right) =>
      JSON.stringify(left).localeCompare(JSON.stringify(right))
    );
  }
  return {
    models,
    enums: [...copy.enums].sort((left, right) =>
      left.name.localeCompare(right.name)
    ),
  };
}

// ---------------------------------------------------------------------------
// PostgreSQL
// ---------------------------------------------------------------------------

function postgresUrls(database: string): { base: string; scratch: string } {
  const base: string = process.env.SQL_POSTGRES_URL ?? '';
  const scratch: URL = new URL(base);
  scratch.pathname = `/${database}`;
  return { base, scratch: scratch.toString() };
}

export function probePostgresMigrations(): ToolProbe {
  const server: ToolProbe = probePostgres();
  if (!server.available) {
    return server;
  }
  if (!probeCommand('pg_dump', ['--version'])) {
    return {
      available: false,
      reason: 'the pg_dump client is not on the PATH',
    };
  }
  try {
    runClient(
      'pg_dump',
      [
        '--schema-only',
        '--schema=public',
        '--no-owner',
        postgresUrls('postgres').base,
      ],
      {}
    );
  } catch (error: unknown) {
    return {
      available: false,
      reason: `pg_dump cannot dump the server (${error instanceof Error ? error.message : String(error)})`,
    };
  }
  return { available: true, reason: '' };
}

function runPostgres(files: string[]): MigrationRun {
  const database: string = randomName('ormbridge_mig').toLowerCase();
  const urls = postgresUrls(database);
  runClient(
    'psql',
    [urls.base, '-X', '-q', '-c', `CREATE DATABASE ${database}`],
    {}
  );
  const dispose = (): void => {
    runClient(
      'psql',
      [
        urls.base,
        '-X',
        '-q',
        '-c',
        `DROP DATABASE IF EXISTS ${database} WITH (FORCE)`,
      ],
      {}
    );
  };
  try {
    for (const file of files) {
      try {
        runClient(
          'psql',
          [urls.scratch, '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-f', file],
          { PGOPTIONS: '-c client_min_messages=warning' }
        );
      } catch (error: unknown) {
        throw new Error(
          `${basename(file)} failed in PostgreSQL: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error }
        );
      }
    }
    const dump: string = runClient(
      'pg_dump',
      ['--schema-only', '--no-owner', '--no-privileges', urls.scratch],
      {}
    );
    return { dump, dispose };
  } catch (error: unknown) {
    dispose();
    throw error;
  }
}

// ---------------------------------------------------------------------------
// MySQL
// ---------------------------------------------------------------------------

function runMysql(files: string[]): MigrationRun {
  const connection: MysqlConnection | undefined = mysqlConnection();
  if (connection === undefined) {
    throw new Error('MySQL is not configured.');
  }
  const database: string = randomName('ormbridge_mig').toLowerCase();
  const run = (args: string[], input?: string): string =>
    runClient(
      connection.client,
      [...connection.args, ...args],
      connection.environment,
      input
    );
  run(['-e', `CREATE DATABASE \`${database}\` DEFAULT CHARACTER SET utf8mb4`]);
  const dispose = (): void => {
    run(['-e', `DROP DATABASE IF EXISTS \`${database}\``]);
  };
  try {
    for (const file of files) {
      try {
        run([database], readFileSync(file, 'utf8'));
      } catch (error: unknown) {
        throw new Error(
          `${basename(file)} failed in MySQL: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error }
        );
      }
    }
    const tables: string[] = run([database, '-e', 'SHOW TABLES'])
      .split('\n')
      .map((line: string) => line.trim())
      .filter((line: string) => line !== '');
    const dump: string = tables
      .map((table: string): string => {
        const row: string = run([
          database,
          '-e',
          `SHOW CREATE TABLE \`${table}\``,
        ]);
        return `${row.slice(row.indexOf('\t') + 1).trim()};`;
      })
      .join('\n');
    return { dump, dispose };
  } catch (error: unknown) {
    dispose();
    throw error;
  }
}

// ---------------------------------------------------------------------------
// SQLite
// ---------------------------------------------------------------------------

function runSqlite(files: string[]): MigrationRun {
  const database: SqlEngine = openSqlite();
  try {
    for (const file of files) {
      try {
        database.execute(readFileSync(file, 'utf8'));
      } catch (error: unknown) {
        throw new Error(
          `${basename(file)} failed in SQLite: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error }
        );
      }
    }
    const dump: string = database
      .query(
        "SELECT sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY rowid"
      )
      .map((row: Record<string, unknown>) => `${String(row['sql'])};`)
      .join('\n');
    return { dump, dispose: (): void => database.dispose() };
  } catch (error: unknown) {
    database.dispose();
    throw error;
  }
}

// ---------------------------------------------------------------------------
// CockroachDB
// ---------------------------------------------------------------------------

function runCockroach(files: string[]): MigrationRun {
  const database: SqlEngine = openCockroach();
  try {
    for (const file of files) {
      try {
        database.execute(readFileSync(file, 'utf8'));
      } catch (error: unknown) {
        throw new Error(
          `${basename(file)} failed in CockroachDB: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error }
        );
      }
    }
    const statements = (what: string): string[] =>
      database
        .query(`SELECT create_statement FROM [SHOW CREATE ALL ${what}]`)
        .map((row: Record<string, unknown>) => String(row['create_statement']));
    const dump: string = [...statements('TYPES'), ...statements('TABLES')].join(
      '\n'
    );
    return { dump, dispose: (): void => database.dispose() };
  } catch (error: unknown) {
    database.dispose();
    throw error;
  }
}

export const MIGRATION_ENGINES: readonly MigrationEngine[] = [
  {
    name: 'postgresql',
    probe: probePostgresMigrations(),
    run: runPostgres,
  },
  { name: 'mysql', probe: probeMysql(), run: runMysql },
  { name: 'sqlite', probe: probeSqlite(), run: runSqlite },
  { name: 'cockroachdb', probe: probeCockroach(), run: runCockroach },
];

export function scenarioDirectory(
  engine: MigrationEngineName,
  scenario: string
): string {
  return join(MIGRATION_FIXTURES, engine, scenario);
}
