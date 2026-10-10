import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import type {
  IrField,
  IrModel,
  IrOnDelete,
  IrRelation,
  IrSchema,
} from '../src/ir.js';
import type { SqlDialect } from '../src/emitters/sqlDdl.js';
import type { ToolProbe } from './realToolSupport.js';

/**
 * Helpers for the tests that execute the SQL DDL emitter's output in a real database and compare
 * what the database reports with the IR. SQLite is always available (Node's built-in `node:sqlite`,
 * or better-sqlite3 from `SQL_DIR`); PostgreSQL and MySQL/MariaDB run only when `SQL_POSTGRES_URL` /
 * `SQL_MYSQL_URL` point at a server (the `psql` and `mysql` clients must be on the PATH).
 */

/** What every command and query is allowed to take before it is cut off. */
export const SQL_TOOL_TIMEOUT_MS: number = 120_000;
/** A test that runs several commands for several schemas. */
export const SQL_TEST_TIMEOUT_MS: number = 600_000;

// ---------------------------------------------------------------------------
// Snapshot of a database
// ---------------------------------------------------------------------------

export interface DbColumn {
  nullable: boolean;
  /** The type as the database reports it, lower case (`character varying`, `varchar(50)`, ...). */
  type: string;
  length?: number;
  precision?: number;
  scale?: number;
}

export interface DbForeignKey {
  columns: string[];
  refTable: string;
  refColumns: string[];
  onDelete: IrOnDelete;
}

export interface DbTable {
  columns: Record<string, DbColumn>;
  primaryKey: string[];
  foreignKeys: DbForeignKey[];
  /** Unique constraints and unique indexes. */
  uniques: string[][];
  /** Non-unique indexes. */
  indexes: string[][];
}

export interface DbSnapshot {
  tables: Record<string, DbTable>;
  /** PostgreSQL enum types by name. */
  enums: Record<string, string[]>;
}

/** A database the DDL can be run in and read back from. */
export interface SqlEngine {
  dialect: SqlDialect;
  /** Runs a script; throws with the database's message when a statement fails. */
  execute(script: string): void;
  /** Runs one query and returns its rows (column names as keys). */
  query(sql: string): Record<string, unknown>[];
  /** Reads the tables, columns, keys and indexes back. */
  snapshot(): DbSnapshot;
  /** Drops everything and releases the connection. */
  dispose(): void;
}

function sortedUnique(lists: string[][]): string[][] {
  const seen: Set<string> = new Set<string>();
  const result: string[][] = [];
  for (const list of lists) {
    const key: string = list.join('\u0000');
    if (!seen.has(key)) {
      seen.add(key);
      result.push(list);
    }
  }
  return result;
}

function emptyTable(): DbTable {
  return {
    columns: {},
    primaryKey: [],
    foreignKeys: [],
    uniques: [],
    indexes: [],
  };
}

function tableOf(snapshot: DbSnapshot, name: string): DbTable {
  const existing: DbTable | undefined = snapshot.tables[name];
  if (existing !== undefined) {
    return existing;
  }
  const created: DbTable = emptyTable();
  snapshot.tables[name] = created;
  return created;
}

function action(rule: unknown): IrOnDelete {
  const text: string = String(rule).toLowerCase().replace(/[\s_]/g, '');
  switch (text) {
    case 'c':
    case 'cascade':
      return 'cascade';
    case 'n':
    case 'setnull':
      return 'setNull';
    case 'd':
    case 'setdefault':
      return 'setDefault';
    case 'r':
    case 'restrict':
      return 'restrict';
    default:
      return 'noAction';
  }
}

// ---------------------------------------------------------------------------
// SQLite
// ---------------------------------------------------------------------------

interface SqliteStatement {
  all(...parameters: unknown[]): unknown[];
}

interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

type SqliteConstructor = new (path: string) => SqliteDatabase;

function sqliteDirectories(): string[] {
  return [
    process.env.SQL_DIR,
    process.env.TYPEORM_DIR,
    process.env.DRIZZLE_DIR,
  ].filter(
    (directory: string | undefined): directory is string =>
      directory !== undefined && directory !== ''
  );
}

/** Finds a SQLite binding: better-sqlite3 from a tools directory, otherwise Node's `node:sqlite`. */
function loadSqlite(): SqliteConstructor | undefined {
  for (const directory of sqliteDirectories()) {
    try {
      const load: NodeJS.Require = createRequire(
        join(directory, 'package.json')
      );
      return load('better-sqlite3') as SqliteConstructor;
    } catch {
      // Try the next directory.
    }
  }
  try {
    const load: NodeJS.Require = createRequire(import.meta.url);
    const builtin: { DatabaseSync: SqliteConstructor } = load(
      'node:sqlite'
    ) as { DatabaseSync: SqliteConstructor };
    return builtin.DatabaseSync;
  } catch {
    return undefined;
  }
}

export function probeSqlite(): ToolProbe {
  const constructor: SqliteConstructor | undefined = loadSqlite();
  if (constructor === undefined) {
    return {
      available: false,
      reason:
        'no SQLite binding found; run Node 22.5 or later, or set SQL_DIR to a directory where "npm install better-sqlite3" has been run (see test/README.md)',
    };
  }
  return { available: true, reason: '' };
}

export function openSqlite(): SqlEngine {
  const Database: SqliteConstructor | undefined = loadSqlite();
  if (Database === undefined) {
    throw new Error('No SQLite binding is available.');
  }
  const database: SqliteDatabase = new Database(':memory:');
  const query = (sql: string): Record<string, unknown>[] =>
    database.prepare(sql).all() as Record<string, unknown>[];
  return {
    dialect: 'sqlite',
    execute: (script: string): void => database.exec(script),
    query,
    snapshot: (): DbSnapshot => {
      const snapshot: DbSnapshot = { tables: {}, enums: {} };
      const names: Record<string, unknown>[] = query(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
      );
      for (const row of names) {
        const name: string = String(row['name']);
        const table: DbTable = tableOf(snapshot, name);
        const columns: Record<string, unknown>[] = query(
          `PRAGMA table_info("${name}")`
        );
        const keyed: { name: string; order: number }[] = [];
        for (const column of columns) {
          const columnName: string = String(column['name']);
          const type: string = String(column['type']).toLowerCase();
          const length: RegExpExecArray | null = /\((\d+)(?:,\s*(\d+))?\)/.exec(
            type
          );
          table.columns[columnName] = {
            nullable: Number(column['notnull']) === 0,
            type,
            ...(length === null ? {} : { length: Number(length[1]) }),
            ...(length?.[2] === undefined
              ? {}
              : { precision: Number(length[1]), scale: Number(length[2]) }),
          };
          if (Number(column['pk']) > 0) {
            keyed.push({ name: columnName, order: Number(column['pk']) });
          }
        }
        table.primaryKey = keyed
          .sort((first, second) => first.order - second.order)
          .map((entry) => entry.name);
        const keys: Map<number, DbForeignKey> = new Map<number, DbForeignKey>();
        for (const row2 of query(`PRAGMA foreign_key_list("${name}")`)) {
          const id: number = Number(row2['id']);
          const key: DbForeignKey = keys.get(id) ?? {
            columns: [],
            refTable: String(row2['table']),
            refColumns: [],
            onDelete: action(row2['on_delete']),
          };
          key.columns.push(String(row2['from']));
          key.refColumns.push(String(row2['to']));
          keys.set(id, key);
        }
        table.foreignKeys = [...keys.values()];
        for (const index of query(`PRAGMA index_list("${name}")`)) {
          const columnsOfIndex: string[] = query(
            `PRAGMA index_info("${String(index['name'])}")`
          ).map((entry) => String(entry['name']));
          if (String(index['origin']) === 'pk') {
            continue;
          }
          if (Number(index['unique']) === 1) {
            table.uniques.push(columnsOfIndex);
          } else {
            table.indexes.push(columnsOfIndex);
          }
        }
        table.uniques = sortedUnique(table.uniques);
      }
      return snapshot;
    },
    dispose: (): void => database.close(),
  };
}

// ---------------------------------------------------------------------------
// Command line clients
// ---------------------------------------------------------------------------

function runClient(
  command: string,
  args: string[],
  environment: NodeJS.ProcessEnv,
  input?: string
): string {
  const result: SpawnSyncReturns<string> = spawnSync(command, args, {
    encoding: 'utf8',
    env: { ...process.env, ...environment },
    timeout: SQL_TOOL_TIMEOUT_MS,
    ...(input === undefined ? {} : { input }),
  });
  if (result.error !== undefined) {
    throw new Error(`${command}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(
      `${command} exited with ${String(result.status)}: ${result.stderr.trim() || result.stdout.trim()}`
    );
  }
  return result.stdout;
}

function probeCommand(command: string, args: string[]): boolean {
  const result: SpawnSyncReturns<string> = spawnSync(command, args, {
    encoding: 'utf8',
    timeout: 30_000,
  });
  return result.error === undefined && result.status === 0;
}

function randomName(prefix: string): string {
  return `${prefix}_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
}

// ---------------------------------------------------------------------------
// PostgreSQL
// ---------------------------------------------------------------------------

export function probePostgres(): ToolProbe {
  const url: string | undefined = process.env.SQL_POSTGRES_URL;
  if (url === undefined || url === '') {
    return {
      available: false,
      reason:
        'set SQL_POSTGRES_URL (for example postgresql://postgres@localhost:5432/postgres) to run the output in PostgreSQL',
    };
  }
  if (!probeCommand('psql', ['--version'])) {
    return {
      available: false,
      reason: 'the psql client is not on the PATH',
    };
  }
  try {
    runClient('psql', [url, '-X', '-A', '-t', '-c', 'SELECT 1'], {});
  } catch (error: unknown) {
    return {
      available: false,
      reason: `SQL_POSTGRES_URL does not accept connections (${error instanceof Error ? error.message : String(error)})`,
    };
  }
  return { available: true, reason: '' };
}

const POSTGRES_SNAPSHOT: string = `
SELECT json_build_object(
  'columns', (SELECT coalesce(json_agg(json_build_object(
      'table', c.table_name, 'column', c.column_name, 'nullable', c.is_nullable = 'YES',
      'type', c.data_type, 'udt', c.udt_name, 'length', c.character_maximum_length,
      'precision', c.numeric_precision, 'scale', c.numeric_scale)), '[]'::json)
    FROM information_schema.columns c
    WHERE c.table_schema = current_schema()),
  'constraints', (SELECT coalesce(json_agg(json_build_object(
      'table', cl.relname, 'type', con.contype::text,
      'columns', (SELECT json_agg(a.attname ORDER BY k.ord) FROM unnest(con.conkey) WITH ORDINALITY k(attnum, ord)
                  JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum),
      'refTable', rcl.relname,
      'refColumns', (SELECT json_agg(a.attname ORDER BY k.ord) FROM unnest(con.confkey) WITH ORDINALITY k(attnum, ord)
                     JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.attnum),
      'onDelete', con.confdeltype::text)), '[]'::json)
    FROM pg_constraint con
    JOIN pg_class cl ON cl.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = cl.relnamespace
    LEFT JOIN pg_class rcl ON rcl.oid = con.confrelid
    WHERE n.nspname = current_schema() AND con.contype IN ('p', 'u', 'f')),
  'indexes', (SELECT coalesce(json_agg(json_build_object(
      'table', t.relname, 'unique', x.indisunique, 'primary', x.indisprimary,
      'columns', (SELECT json_agg(a.attname ORDER BY k.ord) FROM unnest(x.indkey::int2[]) WITH ORDINALITY k(attnum, ord)
                  JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum))), '[]'::json)
    FROM pg_index x
    JOIN pg_class t ON t.oid = x.indrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = current_schema()),
  'enums', (SELECT coalesce(json_agg(json_build_object(
      'name', t.typname,
      'values', (SELECT json_agg(e.enumlabel ORDER BY e.enumsortorder) FROM pg_enum e WHERE e.enumtypid = t.oid))), '[]'::json)
    FROM pg_type t
    WHERE t.typtype = 'e' AND t.typnamespace = (SELECT oid FROM pg_namespace WHERE nspname = current_schema())))
`;

interface JsonColumn {
  table: string;
  column: string;
  nullable: boolean;
  type: string;
  udt: string;
  length: number | null;
  precision: number | null;
  scale: number | null;
}

interface JsonConstraint {
  table: string;
  type: string;
  columns: string[] | null;
  refTable: string | null;
  refColumns: string[] | null;
  onDelete: string;
}

interface JsonIndex {
  table: string;
  unique: boolean;
  primary: boolean;
  columns: string[] | null;
}

export function openPostgres(): SqlEngine {
  const url: string = process.env.SQL_POSTGRES_URL ?? '';
  const schema: string = randomName('ormbridge_sql');
  const environment: NodeJS.ProcessEnv = {
    // The extension types (hstore) live in public, which stays on the path behind the scratch schema.
    PGOPTIONS: `-c search_path=${schema},public -c client_min_messages=warning`,
  };
  runClient(
    'psql',
    [
      url,
      '-X',
      '-q',
      '-v',
      'ON_ERROR_STOP=1',
      '-c',
      `CREATE EXTENSION IF NOT EXISTS hstore SCHEMA public; CREATE SCHEMA ${schema}`,
    ],
    {}
  );
  const query = (sql: string): Record<string, unknown>[] => {
    const output: string = runClient(
      'psql',
      [
        url,
        '-X',
        '-A',
        '-t',
        '-v',
        'ON_ERROR_STOP=1',
        '-c',
        `SELECT coalesce(json_agg(q), '[]'::json) FROM (${sql}) q`,
      ],
      environment
    );
    return JSON.parse(output.trim()) as Record<string, unknown>[];
  };
  return {
    dialect: 'postgresql',
    execute: (script: string): void => {
      runClient(
        'psql',
        [url, '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-f', '-'],
        environment,
        script
      );
    },
    query,
    snapshot: (): DbSnapshot => {
      const output: string = runClient(
        'psql',
        [
          url,
          '-X',
          '-A',
          '-t',
          '-v',
          'ON_ERROR_STOP=1',
          '-c',
          POSTGRES_SNAPSHOT,
        ],
        environment
      );
      const parsed: {
        columns: JsonColumn[];
        constraints: JsonConstraint[];
        indexes: JsonIndex[];
        enums: { name: string; values: string[] }[];
      } = JSON.parse(output.trim()) as never;
      const snapshot: DbSnapshot = { tables: {}, enums: {} };
      for (const column of parsed.columns) {
        tableOf(snapshot, column.table).columns[column.column] = {
          nullable: column.nullable,
          type: column.type.toLowerCase(),
          ...(column.length === null ? {} : { length: column.length }),
          ...(column.precision === null || column.type !== 'numeric'
            ? {}
            : { precision: column.precision }),
          ...(column.scale === null || column.type !== 'numeric'
            ? {}
            : { scale: column.scale }),
        };
      }
      for (const constraint of parsed.constraints) {
        const table: DbTable = tableOf(snapshot, constraint.table);
        const columns: string[] = constraint.columns ?? [];
        if (constraint.type === 'p') {
          table.primaryKey = columns;
        } else if (constraint.type === 'f') {
          table.foreignKeys.push({
            columns,
            refTable: constraint.refTable ?? '',
            refColumns: constraint.refColumns ?? [],
            onDelete: action(constraint.onDelete),
          });
        }
      }
      for (const index of parsed.indexes) {
        if (index.primary) {
          continue;
        }
        const table: DbTable = tableOf(snapshot, index.table);
        if (index.unique) {
          table.uniques.push(index.columns ?? []);
        } else {
          table.indexes.push(index.columns ?? []);
        }
      }
      for (const table of Object.values(snapshot.tables)) {
        table.uniques = sortedUnique(table.uniques);
      }
      for (const definition of parsed.enums) {
        snapshot.enums[definition.name] = definition.values;
      }
      return snapshot;
    },
    dispose: (): void => {
      runClient(
        'psql',
        [url, '-X', '-q', '-c', `DROP SCHEMA IF EXISTS ${schema} CASCADE`],
        {}
      );
    },
  };
}

// ---------------------------------------------------------------------------
// MySQL / MariaDB
// ---------------------------------------------------------------------------

function mysqlClient(): string | undefined {
  for (const candidate of ['mysql', 'mariadb']) {
    if (probeCommand(candidate, ['--version'])) {
      return candidate;
    }
  }
  return undefined;
}

interface MysqlConnection {
  client: string;
  args: string[];
  environment: NodeJS.ProcessEnv;
}

function mysqlConnection(): MysqlConnection | undefined {
  const url: string | undefined = process.env.SQL_MYSQL_URL;
  const client: string | undefined = mysqlClient();
  if (url === undefined || url === '' || client === undefined) {
    return undefined;
  }
  const parsed: URL = new URL(url);
  return {
    client,
    args: [
      '--protocol=tcp',
      `--host=${parsed.hostname}`,
      `--port=${parsed.port === '' ? '3306' : parsed.port}`,
      `--user=${decodeURIComponent(parsed.username === '' ? 'root' : parsed.username)}`,
      '--batch',
      '--skip-column-names',
      '--raw',
    ],
    environment:
      parsed.password === ''
        ? {}
        : { MYSQL_PWD: decodeURIComponent(parsed.password) },
  };
}

export function probeMysql(): ToolProbe {
  const url: string | undefined = process.env.SQL_MYSQL_URL;
  if (url === undefined || url === '') {
    return {
      available: false,
      reason:
        'set SQL_MYSQL_URL (for example mysql://root:secret@127.0.0.1:3306) to run the output in MySQL or MariaDB',
    };
  }
  const connection: MysqlConnection | undefined = mysqlConnection();
  if (connection === undefined) {
    return {
      available: false,
      reason: 'neither the mysql nor the mariadb client is on the PATH',
    };
  }
  try {
    runClient(
      connection.client,
      [...connection.args, '-e', 'SELECT 1'],
      connection.environment
    );
  } catch (error: unknown) {
    return {
      available: false,
      reason: `SQL_MYSQL_URL does not accept connections (${error instanceof Error ? error.message : String(error)})`,
    };
  }
  return { available: true, reason: '' };
}

const MYSQL_COLUMNS: string = `
SELECT JSON_OBJECT('table', TABLE_NAME, 'column', COLUMN_NAME, 'nullable', IS_NULLABLE = 'YES',
  'type', DATA_TYPE, 'columnType', COLUMN_TYPE, 'length', CHARACTER_MAXIMUM_LENGTH,
  'precision', NUMERIC_PRECISION, 'scale', NUMERIC_SCALE)
FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE()`;

const MYSQL_KEYS: string = `
SELECT JSON_OBJECT('table', k.TABLE_NAME, 'constraint', k.CONSTRAINT_NAME, 'type', t.CONSTRAINT_TYPE,
  'column', k.COLUMN_NAME, 'position', k.ORDINAL_POSITION, 'refTable', k.REFERENCED_TABLE_NAME,
  'refColumn', k.REFERENCED_COLUMN_NAME, 'onDelete', r.DELETE_RULE)
FROM information_schema.KEY_COLUMN_USAGE k
JOIN information_schema.TABLE_CONSTRAINTS t ON t.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA
  AND t.TABLE_NAME = k.TABLE_NAME AND t.CONSTRAINT_NAME = k.CONSTRAINT_NAME
LEFT JOIN information_schema.REFERENTIAL_CONSTRAINTS r ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA
  AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME AND r.TABLE_NAME = k.TABLE_NAME
WHERE k.TABLE_SCHEMA = DATABASE()`;

const MYSQL_INDEXES: string = `
SELECT JSON_OBJECT('table', TABLE_NAME, 'index', INDEX_NAME, 'unique', NON_UNIQUE = 0,
  'column', COLUMN_NAME, 'position', SEQ_IN_INDEX)
FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND INDEX_NAME <> 'PRIMARY'`;

export function openMysql(): SqlEngine {
  const connection: MysqlConnection | undefined = mysqlConnection();
  if (connection === undefined) {
    throw new Error('MySQL is not configured.');
  }
  const database: string = randomName('ormbridge_sql');
  const base: string[] = connection.args;
  const run = (args: string[], input?: string): string =>
    runClient(
      connection.client,
      [...base, ...args],
      connection.environment,
      input
    );
  run(['-e', `CREATE DATABASE \`${database}\` DEFAULT CHARACTER SET utf8mb4`]);
  const rows = (sql: string): Record<string, unknown>[] =>
    run([database, '-e', sql])
      .split('\n')
      .filter((line: string) => line.trim() !== '')
      .map((line: string) => JSON.parse(line) as Record<string, unknown>);
  return {
    dialect: 'mysql',
    execute: (script: string): void => {
      run(
        [
          "--init-command=SET sql_mode=CONCAT(@@sql_mode, ',STRICT_ALL_TABLES')",
          database,
        ],
        script
      );
    },
    query: (sql: string): Record<string, unknown>[] => {
      // Batch mode prints a header line, then tab-separated cells; NULL is the text "NULL".
      const lines: string[] = run([database, '--column-names', '-e', sql])
        .split('\n')
        .filter((line: string) => line.trim() !== '');
      const header: string[] = (lines[0] ?? '').split('\t');
      return lines
        .slice(1)
        .map((line: string): Record<string, unknown> =>
          Object.fromEntries(
            line
              .split('\t')
              .map((cell: string, position: number) => [
                header[position] ?? String(position),
                cell === 'NULL' ? null : cell,
              ])
          )
        );
    },
    snapshot: (): DbSnapshot => {
      const snapshot: DbSnapshot = { tables: {}, enums: {} };
      for (const row of rows(MYSQL_COLUMNS)) {
        const columnType: string = String(row['columnType']).toLowerCase();
        tableOf(snapshot, String(row['table'])).columns[String(row['column'])] =
          {
            nullable: row['nullable'] === true || row['nullable'] === 1,
            type: columnType,
            ...(row['length'] === null || row['length'] === undefined
              ? {}
              : { length: Number(row['length']) }),
            ...(String(row['type']) === 'decimal'
              ? {
                  precision: Number(row['precision']),
                  scale: Number(row['scale']),
                }
              : {}),
          };
      }
      const keys: Map<
        string,
        {
          entry: Record<string, unknown>;
          columns: { position: number; column: string; refColumn: string }[];
        }
      > = new Map();
      for (const row of rows(MYSQL_KEYS)) {
        const id: string = `${String(row['table'])}\u0000${String(row['constraint'])}\u0000${String(row['type'])}`;
        const group = keys.get(id) ?? { entry: row, columns: [] };
        group.columns.push({
          position: Number(row['position']),
          column: String(row['column']),
          refColumn: String(row['refColumn']),
        });
        keys.set(id, group);
      }
      for (const { entry, columns } of keys.values()) {
        const ordered = columns.sort(
          (first, second) => first.position - second.position
        );
        const table: DbTable = tableOf(snapshot, String(entry['table']));
        const type: string = String(entry['type']);
        if (type === 'PRIMARY KEY') {
          table.primaryKey = ordered.map((column) => column.column);
        } else if (type === 'FOREIGN KEY') {
          table.foreignKeys.push({
            columns: ordered.map((column) => column.column),
            refTable: String(entry['refTable']),
            refColumns: ordered.map((column) => column.refColumn),
            onDelete: action(entry['onDelete']),
          });
        }
      }
      const indexes: Map<
        string,
        {
          entry: Record<string, unknown>;
          columns: { position: number; column: string }[];
        }
      > = new Map();
      for (const row of rows(MYSQL_INDEXES)) {
        const id: string = `${String(row['table'])}\u0000${String(row['index'])}`;
        const group = indexes.get(id) ?? { entry: row, columns: [] };
        group.columns.push({
          position: Number(row['position']),
          column: String(row['column']),
        });
        indexes.set(id, group);
      }
      for (const { entry, columns } of indexes.values()) {
        const names: string[] = columns
          .sort((first, second) => first.position - second.position)
          .map((column) => column.column);
        const table: DbTable = tableOf(snapshot, String(entry['table']));
        if (entry['unique'] === true || entry['unique'] === 1) {
          table.uniques.push(names);
        } else {
          table.indexes.push(names);
        }
      }
      for (const table of Object.values(snapshot.tables)) {
        table.uniques = sortedUnique(table.uniques);
      }
      return snapshot;
    },
    dispose: (): void => {
      run(['-e', `DROP DATABASE IF EXISTS \`${database}\``]);
    },
  };
}

// ---------------------------------------------------------------------------
// Expectations derived from the IR
// ---------------------------------------------------------------------------

export interface ExpectedForeignKey {
  columns: string[];
  refTable: string;
  onDelete: IrOnDelete;
}

export interface ExpectedColumn {
  nullable: boolean;
  field?: IrField;
}

export interface ExpectedTable {
  columns: Record<string, ExpectedColumn>;
  primaryKey: string[];
  foreignKeys: ExpectedForeignKey[];
  uniques: string[][];
  indexes: string[][];
}

function columnNameOf(model: IrModel, name: string): string {
  const field: IrField | undefined =
    model.fields.find((candidate: IrField) => candidate.name === name) ??
    model.fields.find((candidate: IrField) => candidate.columnName === name);
  if (field !== undefined) {
    return field.columnName;
  }
  const relation: IrRelation | undefined =
    model.relations.find((candidate: IrRelation) => candidate.name === name) ??
    model.relations.find(
      (candidate: IrRelation) => candidate.columnName === name
    );
  return relation?.columnName ?? name;
}

/** Whether the emitter can write a foreign key for the relation (the target is a table with one key column). */
function hasSingleColumnKey(target: IrModel): boolean {
  const keys: number =
    target.fields.filter((field: IrField) => field.isPrimaryKey).length +
    target.relations.filter(
      (relation: IrRelation) => relation.isPrimaryKey === true
    ).length;
  const composite: number = target.compositePrimaryKey?.length ?? 0;
  return composite > 1 ? false : keys + composite > 0;
}

/** What the database has to contain for the IR of the schema (after many-to-many expansion and naming). */
export function expectedTables(
  schema: IrSchema,
  dialect: SqlDialect
): Record<string, ExpectedTable> {
  const expected: Record<string, ExpectedTable> = {};
  const byName: Map<string, IrModel> = new Map(
    schema.models.map((model: IrModel): [string, IrModel] => [
      model.name,
      model,
    ])
  );
  for (const model of schema.models) {
    if (model.isView === true) {
      continue;
    }
    const columns: Record<string, ExpectedColumn> = {};
    const foreignKeys: ExpectedForeignKey[] = [];
    const uniques: string[][] = [];
    const composite: string[] = (model.compositePrimaryKey ?? []).map(
      (name: string) => columnNameOf(model, name)
    );
    const keyed: string[] = [
      ...model.fields
        .filter((field: IrField) => field.isPrimaryKey)
        .map((field: IrField) => field.columnName),
      ...model.relations
        .filter((relation: IrRelation) => relation.isPrimaryKey === true)
        .map((relation: IrRelation) => relation.columnName),
    ];
    const primaryKey: string[] = composite.length > 0 ? composite : keyed;
    for (const field of model.fields) {
      columns[field.columnName] = {
        nullable: field.isNullable && !primaryKey.includes(field.columnName),
        field,
      };
      if (field.isUnique && !primaryKey.includes(field.columnName)) {
        uniques.push([field.columnName]);
      }
    }
    for (const relation of model.relations) {
      if (relation.kind === 'manyToMany') {
        continue;
      }
      const target: IrModel | undefined = byName.get(relation.targetModel);
      if (
        target === undefined ||
        target.isView === true ||
        (relation.toField === undefined && !hasSingleColumnKey(target))
      ) {
        continue;
      }
      if (columns[relation.columnName] === undefined) {
        columns[relation.columnName] = {
          nullable:
            relation.isNullable && !primaryKey.includes(relation.columnName),
        };
      }
      foreignKeys.push({
        columns: [relation.columnName],
        refTable: target.tableName,
        onDelete: relation.onDelete,
      });
      if (
        relation.kind === 'oneToOne' &&
        relation.isPrimaryKey !== true &&
        !primaryKey.includes(relation.columnName)
      ) {
        uniques.push([relation.columnName]);
      }
    }
    for (const key of model.compositeForeignKeys ?? []) {
      const target: IrModel | undefined = byName.get(key.targetModel);
      if (target !== undefined && target.isView !== true) {
        foreignKeys.push({
          columns: key.fields.map((name: string) => columnNameOf(model, name)),
          refTable: target.tableName,
          onDelete: key.onDelete,
        });
      }
    }
    const indexes: string[][] = [];
    // MySQL cannot index a JSON column, so the emitter leaves such an index out (with a warning).
    const unindexable = (names: string[]): boolean =>
      dialect === 'mysql' &&
      names.some((name: string) => {
        const found: IrField | undefined = model.fields.find(
          (candidate: IrField) => candidate.columnName === name
        );
        return (
          found !== undefined &&
          (found.type === 'json' ||
            found.type === 'hstore' ||
            (found.arrayDepth ?? 0) > 0)
        );
      });
    for (const index of model.indexes) {
      const names: string[] = index.fields.map((name: string) =>
        columnNameOf(model, name)
      );
      if (unindexable(names)) {
        continue;
      }
      if (index.isUnique) {
        uniques.push(names);
      } else if (index.kind !== 'fulltext' || dialect !== 'postgresql') {
        // PostgreSQL writes a full-text index over an expression, which has no plain column list.
        indexes.push(names);
      }
    }
    expected[model.tableName] = {
      columns,
      primaryKey,
      foreignKeys,
      uniques,
      indexes,
    };
  }
  return expected;
}

// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------

/** The type class a database type belongs to, for the IR types whose mapping is stable. */
function typeMatches(
  dialect: SqlDialect,
  field: IrField,
  column: DbColumn
): boolean {
  const type: string = column.type.toLowerCase();
  const is = (...patterns: RegExp[]): boolean =>
    patterns.some((pattern: RegExp) => pattern.test(type));
  switch (field.type) {
    case 'int':
      return is(/^(int|integer)\b/);
    case 'bigInt':
      return dialect === 'sqlite' ? is(/^(bigint|integer)\b/) : is(/^bigint\b/);
    case 'boolean':
      return dialect === 'mysql'
        ? is(/^tinyint\(1\)/)
        : is(/^(boolean|bool)\b/);
    case 'uuid':
      return dialect === 'postgresql'
        ? is(/^uuid\b/)
        : is(/^char\(36\)/, /^uniqueidentifier/);
    case 'float':
      return is(/^(double|real)/);
    case 'decimal':
      return is(/^(decimal|numeric)/);
    case 'dateTime':
      return is(/^(timestamp|datetime)/);
    case 'date':
      return is(/^date\b/);
    case 'json':
      return dialect === 'mysql'
        ? is(/^(json|longtext)/)
        : dialect === 'sqlite'
          ? is(/^text/)
          : is(/^jsonb?/);
    case 'text':
      return is(/^(text|longtext)/);
    case 'string':
      return is(/^(varchar|text|character varying|longtext)/);
    default:
      return true;
  }
}

/** Compares the database with the IR; returns one message per difference (empty when they agree). */
export function compareSnapshot(
  dialect: SqlDialect,
  schema: IrSchema,
  snapshot: DbSnapshot
): string[] {
  const problems: string[] = [];
  const expected: Record<string, ExpectedTable> = expectedTables(
    schema,
    dialect
  );
  const lowerTables: Map<string, string> = new Map(
    Object.keys(snapshot.tables).map((name: string): [string, string] => [
      name.toLowerCase(),
      name,
    ])
  );
  for (const [tableName, table] of Object.entries(expected)) {
    const actualName: string | undefined = lowerTables.get(
      tableName.toLowerCase()
    );
    const actual: DbTable | undefined =
      actualName === undefined ? undefined : snapshot.tables[actualName];
    if (actual === undefined) {
      problems.push(`${tableName}: the table does not exist`);
      continue;
    }
    const actualColumns: Map<string, string> = new Map(
      Object.keys(actual.columns).map((name: string): [string, string] => [
        name.toLowerCase(),
        name,
      ])
    );
    const lookup = (name: string): DbColumn | undefined => {
      const key: string | undefined = actualColumns.get(name.toLowerCase());
      return key === undefined ? undefined : actual.columns[key];
    };
    for (const [columnName, column] of Object.entries(table.columns)) {
      const found: DbColumn | undefined = lookup(columnName);
      if (found === undefined) {
        problems.push(`${tableName}.${columnName}: the column does not exist`);
        continue;
      }
      const isKey: boolean = table.primaryKey.includes(columnName);
      // SQLite reports a key column as nullable unless NOT NULL was written (an integer key is a rowid alias).
      if (
        !(dialect === 'sqlite' && isKey) &&
        found.nullable !== column.nullable
      ) {
        problems.push(
          `${tableName}.${columnName}: nullable is ${String(found.nullable)}, expected ${String(column.nullable)}`
        );
      }
      const field: IrField | undefined = column.field;
      if (field === undefined || field.nativeType !== undefined) {
        continue;
      }
      if (
        field.arrayDepth === undefined &&
        field.enumName === undefined &&
        field.generated === undefined &&
        !typeMatches(dialect, field, found)
      ) {
        problems.push(
          `${tableName}.${columnName}: type ${found.type} does not fit ${field.type}`
        );
      }
      if (
        field.type === 'string' &&
        field.maxLength !== undefined &&
        field.arrayDepth === undefined &&
        field.enumName === undefined &&
        found.length !== undefined &&
        found.length !== field.maxLength
      ) {
        problems.push(
          `${tableName}.${columnName}: length ${found.length}, expected ${field.maxLength}`
        );
      }
      if (
        field.type === 'decimal' &&
        field.maxDigits !== undefined &&
        field.arrayDepth === undefined &&
        found.precision !== undefined &&
        (found.precision !== field.maxDigits ||
          (field.decimalPlaces !== undefined &&
            found.scale !== field.decimalPlaces))
      ) {
        problems.push(
          `${tableName}.${columnName}: decimal(${String(found.precision)}, ${String(found.scale)}), expected (${field.maxDigits}, ${String(field.decimalPlaces)})`
        );
      }
    }
    for (const name of actualColumns.values()) {
      if (
        !Object.keys(table.columns).some(
          (candidate: string) => candidate.toLowerCase() === name.toLowerCase()
        )
      ) {
        problems.push(`${tableName}.${name}: the column is not in the schema`);
      }
    }
    if (
      actual.primaryKey.map((name: string) => name.toLowerCase()).join(',') !==
      table.primaryKey.map((name: string) => name.toLowerCase()).join(',')
    ) {
      problems.push(
        `${tableName}: primary key (${actual.primaryKey.join(', ')}), expected (${table.primaryKey.join(', ')})`
      );
    }
    for (const key of table.foreignKeys) {
      const match: DbForeignKey | undefined = actual.foreignKeys.find(
        (candidate: DbForeignKey) =>
          candidate.columns.join(',').toLowerCase() ===
            key.columns.join(',').toLowerCase() &&
          candidate.refTable.toLowerCase() === key.refTable.toLowerCase()
      );
      if (match === undefined) {
        problems.push(
          `${tableName}: no foreign key (${key.columns.join(', ')}) to ${key.refTable}`
        );
        continue;
      }
      const wanted: IrOnDelete = expectedAction(dialect, key.onDelete);
      const found: IrOnDelete = expectedAction(dialect, match.onDelete);
      if (found !== wanted) {
        problems.push(
          `${tableName}: foreign key (${key.columns.join(', ')}) ON DELETE ${match.onDelete}, expected ${key.onDelete}`
        );
      }
    }
    for (const unique of table.uniques) {
      if (!actual.uniques.some((candidate) => sameColumns(candidate, unique))) {
        problems.push(`${tableName}: no unique key on (${unique.join(', ')})`);
      }
    }
    for (const index of table.indexes) {
      if (
        !actual.indexes.some((candidate) => sameColumns(candidate, index)) &&
        !actual.uniques.some((candidate) => sameColumns(candidate, index))
      ) {
        problems.push(`${tableName}: no index on (${index.join(', ')})`);
      }
    }
  }
  for (const name of Object.keys(snapshot.tables)) {
    if (
      !Object.keys(expected).some(
        (candidate: string) => candidate.toLowerCase() === name.toLowerCase()
      )
    ) {
      problems.push(`${name}: the table is not in the schema`);
    }
  }
  for (const definition of schema.enums) {
    if (dialect === 'postgresql') {
      // The type may be renamed (snake_case, or suffixed when a table has its name), so find it by its values.
      const wanted: string = definition.values
        .map((value) => value.dbValue)
        .join('|');
      if (
        !Object.values(snapshot.enums).some(
          (values) => values.join('|') === wanted
        )
      ) {
        problems.push(
          `enum ${definition.name}: no enum type has the values ${wanted}`
        );
      }
    }
  }
  return problems;
}

function sameColumns(first: string[], second: string[]): boolean {
  return (
    first.map((name: string) => name.toLowerCase()).join(',') ===
    second.map((name: string) => name.toLowerCase()).join(',')
  );
}

/** The action a database reports for what the IR asked: MySQL cannot do SET DEFAULT and treats NO ACTION as RESTRICT. */
function expectedAction(dialect: SqlDialect, wanted: IrOnDelete): IrOnDelete {
  if (dialect === 'mysql') {
    return wanted === 'noAction' || wanted === 'setDefault'
      ? 'restrict'
      : wanted;
  }
  return wanted;
}
