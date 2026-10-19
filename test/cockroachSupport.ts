import {
  POSTGRES_SNAPSHOT,
  postgresSnapshotFromJson,
  probeCommand,
  randomName,
  runClient,
  type DbSnapshot,
  type SqlEngine,
} from './sqlDdlSupport.js';
import type { ToolProbe } from './realToolSupport.js';

/**
 * Helpers for the tests that run the output of the writers in a real CockroachDB. A single-node
 * insecure server is enough:
 *
 *   docker run -d --name crdb -p 26257:26257 cockroachdb/cockroach:latest start-single-node --insecure
 *
 * and then either
 *
 *   COCKROACH_URL=postgresql://root@127.0.0.1:26257/defaultdb?sslmode=disable   (needs the psql client)
 *   COCKROACH_DOCKER=crdb                                                      (needs only docker)
 *
 * `COCKROACH_URL` talks the PostgreSQL protocol through `psql`; `COCKROACH_DOCKER` names a running
 * container and runs `cockroach sql --insecure` inside it. Every engine works in a database of its
 * own that is dropped afterwards.
 */

/** How statements reach the server. */
interface Transport {
  /** Runs a script (several statements) in a database; throws with the server's message on an error. */
  execute(database: string | undefined, script: string): void;
  /** Runs one statement that returns one text cell (a JSON document) and returns that text. */
  scalar(database: string | undefined, sql: string): string;
}

function psqlTransport(url: string): Transport {
  const urlFor = (database: string | undefined): string => {
    if (database === undefined) {
      return url;
    }
    const parsed: URL = new URL(url);
    parsed.pathname = `/${database}`;
    return parsed.toString();
  };
  return {
    execute: (database: string | undefined, script: string): void => {
      runClient(
        'psql',
        [urlFor(database), '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-f', '-'],
        { PGOPTIONS: '-c client_min_messages=warning' },
        script
      );
    },
    scalar: (database: string | undefined, sql: string): string =>
      runClient(
        'psql',
        [
          urlFor(database),
          '-X',
          '-A',
          '-t',
          '-v',
          'ON_ERROR_STOP=1',
          '-c',
          sql,
        ],
        {}
      ).trim(),
  };
}

/** Reads the one cell of `cockroach sql --format=csv` output (a header line, then the quoted cell). */
function csvCell(output: string): string {
  const firstBreak: number = output.indexOf('\n');
  const cell: string = output.slice(firstBreak + 1).trim();
  if (cell.startsWith('"') && cell.endsWith('"')) {
    return cell.slice(1, -1).replace(/""/g, '"');
  }
  return cell;
}

function dockerTransport(container: string): Transport {
  const base = (database: string | undefined): string[] => [
    'exec',
    '-i',
    container,
    './cockroach',
    'sql',
    '--insecure',
    ...(database === undefined ? [] : ['-d', database]),
  ];
  return {
    execute: (database: string | undefined, script: string): void => {
      // `cockroach sql` refuses a last statement that has no semicolon.
      runClient(
        'docker',
        base(database),
        {},
        script.trimEnd().endsWith(';') ? script : `${script.trimEnd()};`
      );
    },
    scalar: (database: string | undefined, sql: string): string =>
      csvCell(
        runClient('docker', [...base(database), '--format=csv'], {}, `${sql};`)
      ),
  };
}

function transportFromEnvironment(): Transport | undefined {
  const url: string | undefined = process.env.COCKROACH_URL;
  if (url !== undefined && url !== '') {
    return psqlTransport(url);
  }
  const container: string | undefined = process.env.COCKROACH_DOCKER;
  if (container !== undefined && container !== '') {
    return dockerTransport(container);
  }
  return undefined;
}

export function probeCockroach(): ToolProbe {
  const url: string | undefined = process.env.COCKROACH_URL;
  const container: string | undefined = process.env.COCKROACH_DOCKER;
  const hasUrl: boolean = url !== undefined && url !== '';
  const hasContainer: boolean = container !== undefined && container !== '';
  if (!hasUrl && !hasContainer) {
    return {
      available: false,
      reason:
        'set COCKROACH_URL (a single-node insecure CockroachDB, for example postgresql://root@127.0.0.1:26257/defaultdb?sslmode=disable) or COCKROACH_DOCKER (the name of a running cockroachdb/cockroach container) to run the output in CockroachDB',
    };
  }
  if (hasUrl && !probeCommand('psql', ['--version'])) {
    return { available: false, reason: 'the psql client is not on the PATH' };
  }
  if (!hasUrl && !probeCommand('docker', ['--version'])) {
    return { available: false, reason: 'docker is not on the PATH' };
  }
  const transport: Transport | undefined = transportFromEnvironment();
  try {
    transport?.scalar(
      undefined,
      "SELECT json_build_object('ok', true)::string"
    );
  } catch (error: unknown) {
    return {
      available: false,
      reason: `CockroachDB does not accept connections (${error instanceof Error ? error.message : String(error)})`,
    };
  }
  return { available: true, reason: '' };
}

/** The version of the server, for the test titles and the log. */
export function cockroachVersion(): string {
  const transport: Transport | undefined = transportFromEnvironment();
  if (transport === undefined) {
    return 'unknown';
  }
  try {
    return transport.scalar(undefined, 'SELECT version()');
  } catch {
    return 'unknown';
  }
}

/**
 * The PostgreSQL snapshot query, minus what CockroachDB adds that the schema does not hold: the hidden
 * `rowid` column of a table without a primary key (`is_hidden` tells it apart), and the sequences behind
 * identity columns, which show up in `information_schema.columns` and in `pg_constraint` / `pg_index`
 * (`relkind` tells tables from sequences).
 */
function cockroachSnapshotQuery(): string {
  const replacements: [string, string][] = [
    [
      'WHERE c.table_schema = current_schema())',
      "WHERE c.table_schema = current_schema() AND c.is_hidden = 'NO' AND c.table_name IN (SELECT t.table_name FROM information_schema.tables t WHERE t.table_schema = current_schema() AND t.table_type = 'BASE TABLE'))",
    ],
    [
      "WHERE n.nspname = current_schema() AND con.contype IN ('p', 'u', 'f')",
      "WHERE n.nspname = current_schema() AND cl.relkind = 'r' AND con.contype IN ('p', 'u', 'f')",
    ],
    [
      "WHERE n.nspname = current_schema()),\n  'enums'",
      "WHERE n.nspname = current_schema() AND t.relkind = 'r'),\n  'enums'",
    ],
  ];
  let query: string = POSTGRES_SNAPSHOT;
  for (const [from, to] of replacements) {
    if (!query.includes(from)) {
      throw new Error(`the snapshot query changed: ${from}`);
    }
    query = query.replace(from, to);
  }
  return query.trim();
}

export function openCockroach(): SqlEngine {
  const transport: Transport | undefined = transportFromEnvironment();
  if (transport === undefined) {
    throw new Error('Neither COCKROACH_URL nor COCKROACH_DOCKER is set.');
  }
  const database: string = randomName('ormbridge');
  transport.execute(undefined, `CREATE DATABASE ${database};`);
  return {
    dialect: 'postgresql',
    execute: (script: string): void => {
      transport.execute(database, script);
    },
    query: (sql: string): Record<string, unknown>[] =>
      JSON.parse(
        transport.scalar(
          database,
          `SELECT coalesce(json_agg(q), '[]'::json) FROM (${sql}) q`
        )
      ) as Record<string, unknown>[],
    snapshot: (): DbSnapshot =>
      postgresSnapshotFromJson(
        transport.scalar(database, cockroachSnapshotQuery())
      ),
    dispose: (): void => {
      transport.execute(
        undefined,
        `DROP DATABASE IF EXISTS ${database} CASCADE;`
      );
    },
  };
}
