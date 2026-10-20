import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { GraphEdge } from '../src/emitters/neo4jEdges.js';
import type { Graph, GraphNode } from '../src/emitters/neo4jGraph.js';
import type { Neo4jServer } from './neo4jSupport.js';
import type { ToolProbe } from './realToolSupport.js';

/**
 * Helpers for the tests that compile the Spring Data Neo4j output (`--to sdn`) against the real Spring Data Neo4j
 * 7 and read its mapping: the probe, the Maven build of `test/tools/sdn-verify`, and the comparison of what
 * `Neo4jMappingContext` resolves with the graph model. `SDN_DIR` is a scratch directory for the Maven repository
 * (`test/tools/setup-verification-tools.sh <dir> sdn` fills it); `MVN` and `JAVA` name the executables when they
 * are not on the PATH. With a Neo4j server (`NEO4J_URL` or `NEO4J_DOCKER=1`, see `neo4jSupport.ts`) the tool also
 * saves and reads back node graphs through `Neo4jTemplate`.
 */

const TOOL: string = fileURLToPath(
  new URL('./tools/sdn-verify', import.meta.url)
);

export interface SdnProbe extends ToolProbe {
  mvn: string;
  java: string;
  directory: string;
}

function runs(command: string, args: string[]): boolean {
  const result: SpawnSyncReturns<string> = spawnSync(command, args, {
    encoding: 'utf8',
  });
  return result.error === undefined && result.status === 0;
}

export function probeSdn(): SdnProbe {
  const directory: string = process.env.SDN_DIR ?? '';
  const mvn: string = process.env.MVN ?? 'mvn';
  const java: string = process.env.JAVA ?? 'java';
  const unavailable = (reason: string): SdnProbe => ({
    available: false,
    reason,
    mvn,
    java,
    directory,
  });
  if (directory === '') {
    return unavailable(
      'set SDN_DIR to a scratch directory and have Java 17 and Maven installed (MVN and JAVA name the executables; see test/README.md)'
    );
  }
  if (!runs(java, ['-version'])) {
    return unavailable(
      `Java was not found (${java} -version failed); install JDK 17 or set JAVA (see test/README.md)`
    );
  }
  if (!runs(mvn, ['-version'])) {
    return unavailable(
      `Maven was not found (${mvn} -version failed); install Maven or set MVN (see test/README.md)`
    );
  }
  return { available: true, reason: '', mvn, java, directory };
}

export interface SdnRelationship {
  type: string;
  direction: 'OUTGOING' | 'INCOMING';
  target: string;
  collection: boolean;
  propertiesClass: string | null;
}

export interface SdnNode {
  label: string;
  id: {
    internal: boolean;
    external: boolean;
    assigned: boolean;
    generator: string | null;
    property: string | null;
    field: string | null;
  };
  properties: Record<string, { property: string; javaType: string }>;
  relationships: Record<string, SdnRelationship>;
}

export interface SdnMapping {
  nodes: Record<string, SdnNode>;
  relationshipProperties: Record<
    string,
    { properties: Record<string, string>; idField: string | null }
  >;
  classes: string[];
  __live?: { name: string; ok: boolean; detail: string }[];
}

export interface SdnToolError {
  __error: string;
}

export type SdnToolOutput = Record<string, SdnMapping | SdnToolError>;

export function isToolError(
  value: SdnMapping | SdnToolError | undefined
): value is SdnToolError {
  return (
    value !== undefined && typeof (value as SdnToolError).__error === 'string'
  );
}

export interface ToolGroup {
  name: string;
  /** The directory with the Java files. */
  directory: string;
}

function realJava(java: string): string {
  const located: SpawnSyncReturns<string> = spawnSync(
    'sh',
    ['-c', `readlink -f "$(command -v ${JSON.stringify(java)})"`],
    { encoding: 'utf8' }
  );
  const path: string = located.stdout.trim();
  return path === '' ? java : path;
}

/** Builds `test/tools/sdn-verify` with Maven and runs it over the groups; throws with the output on failure. */
export function runSdnTool(
  probe: SdnProbe,
  groups: readonly ToolGroup[],
  server?: Neo4jServer
): SdnToolOutput {
  const work: string = mkdtempSync(join(tmpdir(), 'ormbridge-sdn-'));
  try {
    cpSync(join(TOOL, 'pom.xml'), join(work, 'pom.xml'));
    cpSync(join(TOOL, 'src'), join(work, 'src'), { recursive: true });
    mkdirSync(join(probe.directory, 'm2'), { recursive: true });
    const javaHome: string = dirname(dirname(realJava(probe.java)));
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      JAVA_HOME: javaHome,
      ...(server === undefined
        ? {}
        : {
            SDN_BOLT_URL: server.boltUrl,
            SDN_USER: server.user,
            SDN_PASSWORD: server.password,
          }),
    };
    const build: SpawnSyncReturns<string> = spawnSync(
      probe.mvn,
      [
        '-B',
        '-q',
        `-Dmaven.repo.local=${join(probe.directory, 'm2')}`,
        'package',
        'dependency:build-classpath',
        `-Dmdep.outputFile=${join(work, 'cp.txt')}`,
      ],
      { cwd: work, encoding: 'utf8', timeout: 900_000, env }
    );
    if (build.status !== 0) {
      throw new Error(`mvn package failed:\n${build.stdout}\n${build.stderr}`);
    }
    const classPath: string = `${join(work, 'target', 'classes')}:${readFileSync(join(work, 'cp.txt'), 'utf8').trim()}`;
    const run: SpawnSyncReturns<string> = spawnSync(
      probe.java,
      [
        '-cp',
        classPath,
        'dev.ormbridge.sdnverify.Main',
        ...(server === undefined ? [] : ['--live']),
        ...groups.map((group: ToolGroup) => `${group.name}=${group.directory}`),
      ],
      {
        cwd: work,
        encoding: 'utf8',
        timeout: 600_000,
        maxBuffer: 256 * 1024 * 1024,
        env,
      }
    );
    const lines: string[] = run.stdout
      .split('\n')
      .filter((line: string) => line.startsWith('{'));
    const last: string | undefined = lines[lines.length - 1];
    if (run.status !== 0 || last === undefined) {
      throw new Error(
        `the sdn-verify tool failed (${String(run.status)}):\n${run.stdout}\n${run.stderr}`
      );
    }
    return JSON.parse(last) as SdnToolOutput;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** Writes a file map below a directory. */
export function writeFiles(
  directory: string,
  files: Record<string, string>
): void {
  for (const [path, text] of Object.entries(files)) {
    const target: string = join(directory, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, text);
  }
}

// ---------------------------------------------------------------------------
// The mapping against the graph model
// ---------------------------------------------------------------------------

function nodeOfLabel(
  mapping: SdnMapping,
  label: string
): [string, SdnNode] | undefined {
  return Object.entries(mapping.nodes).find(
    ([, node]: [string, SdnNode]) => node.label === label
  );
}

/** Lists the differences between the labels, properties and relationships of the graph and the mapping. */
export function compareMapping(
  graph: Graph,
  edges: GraphEdge[],
  mapping: SdnMapping
): string[] {
  const problems: string[] = [];
  const labels: string[] = graph.nodes
    .map((node: GraphNode) => node.label)
    .sort();
  const mapped: string[] = Object.values(mapping.nodes)
    .map((node: SdnNode) => node.label)
    .sort();
  if (labels.join('\u0000') !== mapped.join('\u0000')) {
    problems.push(`labels: ${mapped.join(', ')} against ${labels.join(', ')}`);
  }
  for (const graphNode of graph.nodes) {
    const found = nodeOfLabel(mapping, graphNode.label);
    if (found === undefined) {
      continue;
    }
    const node: SdnNode = found[1];
    const keys: string[] = [...new Set(graphNode.properties.map((p) => p.key))];
    const stored: string[] = Object.entries(node.properties)
      .filter(([field]) => !(node.id.internal && field === node.id.field))
      .map(([, info]) => info.property);
    const wanted: string[] = keys.filter(
      (key: string) => !isInternalKey(graphNode, key)
    );
    const extra: string[] = stored.filter(
      (name: string) => !wanted.includes(name)
    );
    const missing: string[] = wanted.filter(
      (name: string) => !stored.includes(name)
    );
    if (extra.length > 0 || missing.length > 0) {
      problems.push(
        `${graphNode.label}: properties differ (missing ${missing.join(', ') || 'none'}, extra ${extra.join(', ') || 'none'})`
      );
    }
    const idCount: number = [
      node.id.internal,
      node.id.external,
      node.id.assigned,
    ].filter(Boolean).length;
    if (idCount !== 1) {
      problems.push(`${graphNode.label}: ${idCount} identifier kinds`);
    }
  }
  let expected: number = 0;
  for (const edge of edges) {
    const source = nodeOfLabel(mapping, edge.source.label);
    const target = nodeOfLabel(mapping, edge.target.label);
    if (source === undefined || target === undefined) {
      problems.push(
        `${edge.type}: no class for ${edge.source.label} or ${edge.target.label}`
      );
      continue;
    }
    expected += 2;
    const hasProperties: boolean = edge.properties.length > 0;
    const find = (
      owner: SdnNode,
      direction: 'OUTGOING' | 'INCOMING',
      other: string,
      many: boolean
    ): SdnRelationship | undefined =>
      Object.values(owner.relationships).find(
        (item: SdnRelationship) =>
          item.type === edge.type &&
          item.direction === direction &&
          item.target === other &&
          item.collection === many &&
          (item.propertiesClass !== null) === hasProperties
      );
    const outMany: boolean =
      edge.outgoing === 'zeroOrMore' || edge.outgoing === 'oneOrMore';
    const inMany: boolean =
      edge.incoming === 'zeroOrMore' || edge.incoming === 'oneOrMore';
    const out = find(source[1], 'OUTGOING', edge.target.label, outMany);
    const incoming = find(target[1], 'INCOMING', edge.source.label, inMany);
    if (out === undefined) {
      problems.push(
        `${edge.source.label}: no OUTGOING ${edge.type} to ${edge.target.label}`
      );
    }
    if (incoming === undefined) {
      problems.push(
        `${edge.target.label}: no INCOMING ${edge.type} from ${edge.source.label}`
      );
    }
    for (const found of [out, incoming]) {
      if (
        found?.propertiesClass !== null &&
        found?.propertiesClass !== undefined
      ) {
        const keys: string[] = Object.values(
          mapping.relationshipProperties[found.propertiesClass]?.properties ??
            {}
        ).sort();
        const wanted: string[] = [
          ...new Set(edge.properties.map((p) => p.key)),
        ].sort();
        const stored: string[] = keys.filter((name: string) => name !== 'id');
        if (stored.join('\u0000') !== wanted.join('\u0000')) {
          problems.push(
            `${edge.type}: relationship properties ${stored.join(', ')} against ${wanted.join(', ')}`
          );
        }
      }
    }
  }
  const declared: number = Object.values(mapping.nodes).reduce(
    (sum: number, node: SdnNode) =>
      sum + Object.keys(node.relationships).length,
    0
  );
  if (declared !== expected) {
    problems.push(
      `${declared} relationships are mapped, the graph has ${expected / 2} (two ends each)`
    );
  }
  return problems;
}

/** True when the key of a node is a generated integer, which Spring Data Neo4j keeps as the internal id. */
function isInternalKey(node: GraphNode, key: string): boolean {
  const field = node.model.fields.find(
    (candidate) => node.keys.get(candidate.name) === key
  );
  return (
    field !== undefined &&
    field.isPrimaryKey &&
    field.default?.kind === 'autoIncrement' &&
    (field.type === 'int' || field.type === 'bigInt')
  );
}
