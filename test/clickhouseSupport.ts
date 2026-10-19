import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import type { ToolProbe } from './realToolSupport.js';

/**
 * Helpers for the test that executes the ClickHouse output of the SQL DDL writer in a real server
 * and reads the catalog back. The server is reached over its HTTP interface (port 8123) with
 * `fetch`, so no client has to be installed. `CLICKHOUSE_URL` points at a running server (for
 * example `http://127.0.0.1:8123`); `CLICKHOUSE_DOCKER=1` starts a throwaway
 * `clickhouse/clickhouse-server` container instead and removes it afterwards.
 */

export const CLICKHOUSE_IMAGE: string = 'clickhouse/clickhouse-server:latest';

export interface ClickhouseServer {
  url: string;
  /** Stops a container this process started; does nothing for CLICKHOUSE_URL. */
  stop(): void;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function ping(url: string): Promise<boolean> {
  try {
    const response: Response = await fetch(`${url}/ping`, {
      signal: AbortSignal.timeout(3000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function waitFor(url: string, seconds: number): Promise<boolean> {
  for (let attempt = 0; attempt < seconds; attempt += 1) {
    if (await ping(url)) {
      return true;
    }
    await sleep(1000);
  }
  return false;
}

function docker(args: string[]): SpawnSyncReturns<string> {
  return spawnSync('docker', args, { encoding: 'utf8', timeout: 300_000 });
}

/** Starts a ClickHouse container on a free local port. */
async function startDocker(): Promise<ClickhouseServer | string> {
  const started: SpawnSyncReturns<string> = docker([
    'run',
    '-d',
    '--rm',
    '-p',
    '127.0.0.1::8123',
    '-e',
    'CLICKHOUSE_SKIP_USER_SETUP=1',
    CLICKHOUSE_IMAGE,
  ]);
  if (started.status !== 0) {
    return `docker could not start ${CLICKHOUSE_IMAGE} (${(started.stderr || started.error?.message || '').trim()})`;
  }
  const id: string = started.stdout.trim();
  const stop = (): void => {
    docker(['rm', '-f', id]);
  };
  const port: SpawnSyncReturns<string> = docker(['port', id, '8123/tcp']);
  const match: RegExpExecArray | null = /:(\d+)\s*$/m.exec(port.stdout);
  if (match === null) {
    stop();
    return 'the ClickHouse container published no port';
  }
  const url: string = `http://127.0.0.1:${match[1]}`;
  if (!(await waitFor(url, 90))) {
    stop();
    return 'the ClickHouse container did not answer /ping within 90 seconds';
  }
  return { url, stop };
}

export interface ClickhouseAccess {
  probe: ToolProbe;
  server?: ClickhouseServer;
}

export async function openClickhouseServer(): Promise<ClickhouseAccess> {
  const given: string | undefined = process.env.CLICKHOUSE_URL;
  if (given !== undefined && given !== '') {
    const url: string = given.replace(/\/+$/, '');
    return (await waitFor(url, 30))
      ? {
          probe: { available: true, reason: '' },
          server: { url, stop: (): void => undefined },
        }
      : {
          probe: {
            available: false,
            reason: `CLICKHOUSE_URL (${url}) does not answer /ping`,
          },
        };
  }
  const wantsDocker: string = process.env.CLICKHOUSE_DOCKER ?? '';
  if (wantsDocker === '' || wantsDocker === '0') {
    return {
      probe: {
        available: false,
        reason:
          'set CLICKHOUSE_URL (for example http://127.0.0.1:8123) or CLICKHOUSE_DOCKER=1 to run the output in ClickHouse',
      },
    };
  }
  const started: ClickhouseServer | string = await startDocker();
  return typeof started === 'string'
    ? { probe: { available: false, reason: started } }
    : { probe: { available: true, reason: '' }, server: started };
}

/** Runs one statement; throws with the server's message when it fails. */
export async function clickhouseExecute(
  server: ClickhouseServer,
  sql: string,
  database?: string
): Promise<string> {
  const query: string =
    database === undefined ? '' : `?database=${encodeURIComponent(database)}`;
  const response: Response = await fetch(`${server.url}/${query}`, {
    method: 'POST',
    body: sql,
    signal: AbortSignal.timeout(60_000),
  });
  const text: string = await response.text();
  if (!response.ok) {
    throw new Error(text.trim());
  }
  return text;
}

/** Rows of a query, as objects. */
export async function clickhouseRows(
  server: ClickhouseServer,
  sql: string,
  database?: string
): Promise<Record<string, unknown>[]> {
  const text: string = await clickhouseExecute(
    server,
    `${sql} FORMAT JSONEachRow`,
    database
  );
  return text
    .split('\n')
    .filter((line: string) => line.trim() !== '')
    .map((line: string) => JSON.parse(line) as Record<string, unknown>);
}

/** The statements of a script written by the writer (comment lines are dropped). */
export function splitStatements(script: string): string[] {
  return script
    .split(/;\s*\n(?=\s*(?:CREATE |-- |$))/)
    .map((block: string) =>
      block
        .split('\n')
        .filter((line: string) => !line.startsWith('--'))
        .join('\n')
        .trim()
        .replace(/;$/, '')
    )
    .filter((statement: string) => statement !== '');
}

export interface ChColumnInfo {
  type: string;
  comment: string;
  inSortingKey: boolean;
  inPrimaryKey: boolean;
}

export interface ChTableInfo {
  engine: string;
  sortingKey: string;
  primaryKey: string;
  comment: string;
  columns: Record<string, ChColumnInfo>;
  indexes: { name: string; expression: string; type: string }[];
}

/** Reads the tables of a database from the system tables. */
export async function snapshotClickhouse(
  server: ClickhouseServer,
  database: string
): Promise<Record<string, ChTableInfo>> {
  const quoted: string = `'${database.replace(/'/g, "\\'")}'`;
  const tables: Record<string, ChTableInfo> = {};
  for (const row of await clickhouseRows(
    server,
    `SELECT name, engine, sorting_key, primary_key, comment FROM system.tables WHERE database = ${quoted}`
  )) {
    tables[String(row.name)] = {
      engine: String(row.engine),
      sortingKey: String(row.sorting_key),
      primaryKey: String(row.primary_key),
      comment: String(row.comment),
      columns: {},
      indexes: [],
    };
  }
  for (const row of await clickhouseRows(
    server,
    `SELECT \`table\`, name, type, comment, is_in_sorting_key, is_in_primary_key FROM system.columns WHERE database = ${quoted}`
  )) {
    const table: ChTableInfo | undefined = tables[String(row.table)];
    if (table !== undefined) {
      table.columns[String(row.name)] = {
        type: String(row.type),
        comment: String(row.comment),
        inSortingKey: Number(row.is_in_sorting_key) === 1,
        inPrimaryKey: Number(row.is_in_primary_key) === 1,
      };
    }
  }
  for (const row of await clickhouseRows(
    server,
    `SELECT \`table\`, name, expr, type FROM system.data_skipping_indices WHERE database = ${quoted}`
  )) {
    tables[String(row.table)]?.indexes.push({
      name: String(row.name),
      expression: String(row.expr),
      type: String(row.type),
    });
  }
  return tables;
}
