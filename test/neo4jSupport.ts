import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import type { ToolProbe } from './realToolSupport.js';

/**
 * Helpers for the test that runs the Cypher output of the Neo4j writer in a real Neo4j server and
 * reads the catalog back. The server is reached over its HTTP transaction endpoint (port 7474) with
 * `fetch`, so no driver has to be installed.
 *
 * - `NEO4J_URL` points at a running server: `http://127.0.0.1:7474`, or a `bolt://host:7687` URL,
 *   which is mapped to the HTTP port 7474 of the same host. `NEO4J_USER` (default `neo4j`) and
 *   `NEO4J_PASSWORD` are the credentials.
 * - `NEO4J_DOCKER=1` starts a throwaway `neo4j:5-community` container and removes it afterwards.
 * - `NEO4J_ENTERPRISE_DOCKER=1` starts a `neo4j:5-enterprise` container as well, but only when you
 *   also set `NEO4J_ACCEPT_LICENSE_AGREEMENT` (`yes` or `eval`) yourself: the test never accepts a
 *   license for you.
 *
 * Community Edition tests run against any server; the enterprise-style tests run only against a
 * server whose edition is `enterprise`.
 */

export const NEO4J_COMMUNITY_IMAGE: string = 'neo4j:5-community';
export const NEO4J_ENTERPRISE_IMAGE: string = 'neo4j:5-enterprise';

export interface Neo4jServer {
  /** Base URL of the HTTP interface, without a trailing slash. */
  url: string;
  /** Bolt URL of the same server (drivers and neomodel use it), for example `bolt://127.0.0.1:7687`. */
  boltUrl: string;
  user: string;
  password: string;
  /** `community` or `enterprise`, as `dbms.components()` reports it. */
  edition: string;
  version: string;
  /** Stops a container this process started; does nothing for NEO4J_URL. */
  stop(): void;
}

export interface Neo4jAccess {
  probe: ToolProbe;
  /** The server for the community-style tests (any edition). */
  server?: Neo4jServer;
  /** A server whose edition is enterprise, for the enterprise-style tests. */
  enterprise?: Neo4jServer;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/** Turns NEO4J_URL into the HTTP base URL; a bolt URL maps to port 7474 of the same host. */
export function httpUrlOf(given: string): string {
  const trimmed: string = given.replace(/\/+$/, '');
  const bolt: RegExpExecArray | null =
    /^(?:bolt|neo4j)(?:\+s(?:sc)?)?:\/\/([^/:]+)/.exec(trimmed);
  return bolt === null ? trimmed : `http://${bolt[1]}:7474`;
}

function authorization(user: string, password: string): string {
  return `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;
}

interface TransactionResponse {
  results: { columns: string[]; data: { row: unknown[] }[] }[];
  errors: { code: string; message: string }[];
}

/** Runs one statement and returns its rows as objects; throws with the server's message on failure. */
export async function cypherRows(
  server: Pick<Neo4jServer, 'url' | 'user' | 'password'>,
  statement: string,
  parameters: Record<string, unknown> = {}
): Promise<Record<string, unknown>[]> {
  const response: Response = await fetch(`${server.url}/db/neo4j/tx/commit`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: authorization(server.user, server.password),
    },
    body: JSON.stringify({ statements: [{ statement, parameters }] }),
    signal: AbortSignal.timeout(60_000),
  });
  const body: TransactionResponse =
    (await response.json()) as TransactionResponse;
  const failure: { code: string; message: string } | undefined = body.errors[0];
  if (failure !== undefined) {
    throw new Error(`${failure.code}: ${failure.message}`);
  }
  const result = body.results[0];
  if (result === undefined) {
    return [];
  }
  return result.data.map((entry: { row: unknown[] }) => {
    const row: Record<string, unknown> = {};
    result.columns.forEach((column: string, position: number): void => {
      row[column] = entry.row[position];
    });
    return row;
  });
}

/** Runs one statement and ignores its rows. */
export async function cypherExecute(
  server: Pick<Neo4jServer, 'url' | 'user' | 'password'>,
  statement: string,
  parameters: Record<string, unknown> = {}
): Promise<void> {
  await cypherRows(server, statement, parameters);
}

/** The Bolt URL that goes with a server: NEO4J_BOLT_URL, a bolt URL given as NEO4J_URL, or port 7687 of the HTTP host. */
export function boltUrlOf(given: string, httpUrl: string): string {
  const explicit: string = process.env.NEO4J_BOLT_URL ?? '';
  if (explicit !== '') {
    return explicit.replace(/\/+$/, '');
  }
  const bolt: RegExpExecArray | null =
    /^((?:bolt|neo4j)(?:\+s(?:sc)?)?):\/\/([^/:]+)(?::(\d+))?/.exec(given);
  if (bolt !== null) {
    return `${bolt[1]}://${bolt[2]}:${bolt[3] ?? '7687'}`;
  }
  return `bolt://${new URL(httpUrl).hostname}:7687`;
}

async function describeServer(
  url: string,
  user: string,
  password: string,
  seconds: number,
  boltUrl: string = boltUrlOf('', url)
): Promise<Omit<Neo4jServer, 'stop'> | string> {
  let lastError: string = 'no answer';
  for (let attempt = 0; attempt < seconds; attempt += 1) {
    try {
      const rows: Record<string, unknown>[] = await cypherRows(
        { url, user, password },
        "CALL dbms.components() YIELD name, versions, edition WHERE name = 'Neo4j Kernel' RETURN versions[0] AS version, edition"
      );
      const row: Record<string, unknown> | undefined = rows[0];
      return {
        url,
        boltUrl,
        user,
        password,
        edition: String(row?.edition ?? 'community'),
        version: String(row?.version ?? ''),
      };
    } catch (error: unknown) {
      lastError = error instanceof Error ? error.message : String(error);
      if (/Unauthorized|AuthenticationRateLimit/.test(lastError)) {
        return `the server at ${url} rejected the credentials (${lastError})`;
      }
    }
    await sleep(1000);
  }
  return `the server at ${url} did not answer within ${seconds} seconds (${lastError})`;
}

function docker(args: string[]): SpawnSyncReturns<string> {
  return spawnSync('docker', args, { encoding: 'utf8', timeout: 600_000 });
}

/** Starts a Neo4j container on a free local port and waits until it answers queries. */
async function startDocker(
  image: string,
  extraEnvironment: string[]
): Promise<Neo4jServer | string> {
  const password: string = randomBytes(9).toString('hex');
  const started: SpawnSyncReturns<string> = docker([
    'run',
    '-d',
    '--rm',
    '-p',
    '127.0.0.1::7474',
    '-p',
    '127.0.0.1::7687',
    '-e',
    `NEO4J_AUTH=neo4j/${password}`,
    ...extraEnvironment.flatMap((value: string) => ['-e', value]),
    image,
  ]);
  if (started.status !== 0) {
    return `docker could not start ${image} (${(started.stderr || started.error?.message || '').trim()})`;
  }
  const id: string = started.stdout.trim();
  const stop = (): void => {
    docker(['rm', '-f', id]);
  };
  const port: SpawnSyncReturns<string> = docker(['port', id, '7474/tcp']);
  const match: RegExpExecArray | null = /:(\d+)\s*$/m.exec(port.stdout);
  if (match === null) {
    stop();
    return `the ${image} container published no HTTP port`;
  }
  const boltPort: SpawnSyncReturns<string> = docker(['port', id, '7687/tcp']);
  const boltMatch: RegExpExecArray | null = /:(\d+)\s*$/m.exec(boltPort.stdout);
  const described = await describeServer(
    `http://127.0.0.1:${match[1]}`,
    'neo4j',
    password,
    180,
    boltMatch === null
      ? 'bolt://127.0.0.1:7687'
      : `bolt://127.0.0.1:${boltMatch[1]}`
  );
  if (typeof described === 'string') {
    stop();
    return described;
  }
  return { ...described, stop };
}

export async function openNeo4jServers(): Promise<Neo4jAccess> {
  const given: string = process.env.NEO4J_URL ?? '';
  const wantsDocker: string = process.env.NEO4J_DOCKER ?? '';
  const wantsEnterprise: string = process.env.NEO4J_ENTERPRISE_DOCKER ?? '';
  const access: Neo4jAccess = {
    probe: {
      available: false,
      reason:
        'set NEO4J_URL (with NEO4J_USER and NEO4J_PASSWORD) or NEO4J_DOCKER=1 to run the output in Neo4j',
    },
  };

  if (given !== '') {
    const described = await describeServer(
      httpUrlOf(given),
      process.env.NEO4J_USER ?? 'neo4j',
      process.env.NEO4J_PASSWORD ?? 'neo4j',
      60,
      boltUrlOf(given, httpUrlOf(given))
    );
    if (typeof described === 'string') {
      return { probe: { available: false, reason: described } };
    }
    const server: Neo4jServer = { ...described, stop: (): void => undefined };
    return {
      probe: { available: true, reason: '' },
      server,
      ...(server.edition === 'enterprise' ? { enterprise: server } : {}),
    };
  }

  if (wantsDocker !== '' && wantsDocker !== '0') {
    const started: Neo4jServer | string = await startDocker(
      NEO4J_COMMUNITY_IMAGE,
      []
    );
    if (typeof started === 'string') {
      return { probe: { available: false, reason: started } };
    }
    access.probe = { available: true, reason: '' };
    access.server = started;
  }

  if (wantsEnterprise !== '' && wantsEnterprise !== '0') {
    const license: string = process.env.NEO4J_ACCEPT_LICENSE_AGREEMENT ?? '';
    if (license === '') {
      if (!access.probe.available) {
        access.probe = {
          available: false,
          reason:
            'NEO4J_ENTERPRISE_DOCKER=1 also needs NEO4J_ACCEPT_LICENSE_AGREEMENT (yes or eval): the test does not accept the Neo4j license for you',
        };
      }
      return access;
    }
    const started: Neo4jServer | string = await startDocker(
      NEO4J_ENTERPRISE_IMAGE,
      [`NEO4J_ACCEPT_LICENSE_AGREEMENT=${license}`]
    );
    if (typeof started !== 'string') {
      access.enterprise = started;
      if (!access.probe.available) {
        access.probe = { available: true, reason: '' };
        access.server = started;
      }
    }
  }
  return access;
}

/** The statements of a script written by the writer: comment lines and blank lines are dropped. */
export function splitCypher(script: string): string[] {
  return script
    .split('\n')
    .map((line: string) => line.trim())
    .filter((line: string) => line !== '' && !line.startsWith('//'))
    .map((line: string) => line.replace(/;$/, ''));
}

export interface CatalogConstraint {
  name: string;
  type: string;
  entityType: string;
  labelsOrTypes: string[];
  properties: string[];
}

export interface CatalogIndex {
  name: string;
  type: string;
  entityType: string;
  labelsOrTypes: string[];
  properties: string[];
}

export async function readConstraints(
  server: Neo4jServer
): Promise<CatalogConstraint[]> {
  return (await cypherRows(
    server,
    'SHOW CONSTRAINTS YIELD name, type, entityType, labelsOrTypes, properties RETURN name, type, entityType, labelsOrTypes, properties ORDER BY name'
  )) as unknown as CatalogConstraint[];
}

/** Indexes that are not backed by a constraint and are not the built-in lookup indexes. */
export async function readIndexes(
  server: Neo4jServer
): Promise<CatalogIndex[]> {
  return (await cypherRows(
    server,
    "SHOW INDEXES YIELD name, type, entityType, labelsOrTypes, properties, owningConstraint WHERE type <> 'LOOKUP' AND owningConstraint IS NULL RETURN name, type, entityType, labelsOrTypes, properties ORDER BY name"
  )) as unknown as CatalogIndex[];
}

/** Drops every constraint and index, so the next case starts from an empty schema. */
export async function clearSchema(server: Neo4jServer): Promise<void> {
  await cypherExecute(server, 'MATCH (n) DETACH DELETE n');
  for (const constraint of await readConstraints(server)) {
    await cypherExecute(
      server,
      `DROP CONSTRAINT \`${constraint.name.replace(/`/g, '``')}\` IF EXISTS`
    );
  }
  for (const index of await readIndexes(server)) {
    await cypherExecute(
      server,
      `DROP INDEX \`${index.name.replace(/`/g, '``')}\` IF EXISTS`
    );
  }
}
