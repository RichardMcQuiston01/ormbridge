import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { collectEdges } from '../src/emitters/neo4jEdges.js';
import { buildGraph } from '../src/emitters/neo4jGraph.js';
import { emitSdn } from '../src/emitters/sdn.js';
import type { IrSchema } from '../src/ir.js';
import { normalizeSchema, type NamingMode } from '../src/transforms.js';
import { constructsSchema } from './drizzleFixtures.js';
import { kitchenSinkSchema, stressSchema } from './gormFixtures.js';
import { joinsSchema, keysSchema } from './neo4jFixtures.js';
import { openNeo4jServers, type Neo4jAccess } from './neo4jSupport.js';
import {
  compareMapping,
  isToolError,
  probeSdn,
  runSdnTool,
  writeFiles,
  type SdnMapping,
  type SdnToolOutput,
  type ToolGroup,
} from './sdnSupport.js';
import {
  parseSource,
  titleWithReason,
  VERIFY_SOURCES,
  type VerifySource,
} from './realToolSupport.js';

/**
 * Compiles the Java of `--to sdn` against the real Spring Data Neo4j 7 (every lint warning is an error), builds
 * its `Neo4jMappingContext` and compares the labels, identifiers, graph property names, relationships (type,
 * direction, target, single value or list, relationship properties class) with the graph model. When a Neo4j
 * server is available (`NEO4J_URL` or `NEO4J_DOCKER=1`) it also saves node graphs through `Neo4jTemplate`, reads
 * them back and checks the stored labels, keys, types and relationship properties with Cypher. Needs `SDN_DIR`
 * (see test/tools/setup-verification-tools.sh), Java 17 and Maven; skipped with a reason in the title otherwise.
 */

const probe = probeSdn();
const access: Neo4jAccess = probe.available
  ? await openNeo4jServers()
  : { probe };
const server = access.server;
const directories: string[] = [];

afterAll(() => {
  server?.stop();
  for (const directory of directories) {
    rmSync(directory, { recursive: true, force: true });
  }
});

const NAMING_MODES: readonly NamingMode[] = ['preserve', 'normalize'];

interface SchemaCase {
  label: string;
  load: () => Promise<IrSchema>;
}

const SCHEMAS: readonly SchemaCase[] = [
  ...VERIFY_SOURCES.map((source: VerifySource): SchemaCase => ({
    label: source.label,
    load: () => parseSource(source),
  })),
  { label: 'kitchen-sink', load: () => Promise.resolve(kitchenSinkSchema()) },
  { label: 'stress', load: () => Promise.resolve(stressSchema()) },
  { label: 'constructs', load: () => Promise.resolve(constructsSchema()) },
  { label: 'keys-and-types', load: () => Promise.resolve(keysSchema()) },
  { label: 'joins', load: () => Promise.resolve(joinsSchema()) },
];

function prepare(schema: IrSchema, naming: NamingMode): IrSchema {
  return naming === 'normalize' ? normalizeSchema(schema) : schema;
}

function stageGroup(
  schema: IrSchema,
  naming: NamingMode,
  name: string
): ToolGroup {
  const directory: string = mkdtempSync(join(tmpdir(), 'ormbridge-sdn-src-'));
  directories.push(directory);
  const output = emitSdn(prepare(schema, naming), {
    camelFields: naming === 'normalize',
  });
  writeFiles(directory, output.files);
  return { name, directory };
}

describe('Spring Data Neo4j classes in the real Spring Data Neo4j', () => {
  it.skipIf(!probe.available)(
    titleWithReason(
      'compile with every lint warning as an error and map as the graph model says (both naming modes)',
      probe
    ),
    async () => {
      const groups: ToolGroup[] = [];
      const expectations: Map<string, IrSchema> = new Map<string, IrSchema>();
      for (const schemaCase of SCHEMAS) {
        const schema: IrSchema = await schemaCase.load();
        for (const naming of NAMING_MODES) {
          const name: string = `${schemaCase.label}.${naming}`;
          groups.push(stageGroup(schema, naming, name));
          expectations.set(name, prepare(schema, naming));
        }
      }
      const output: SdnToolOutput = runSdnTool(probe, groups);
      for (const [name, prepared] of expectations) {
        const result: SdnMapping | { __error: string } | undefined =
          output[name];
        expect(result, name).toBeDefined();
        if (result === undefined || isToolError(result)) {
          expect(result, name).toBeUndefined();
          continue;
        }
        const camelFields: boolean = name.endsWith('normalize');
        const graph = buildGraph(prepared, { camelFields }, []);
        const edges = collectEdges(prepared, graph, []);
        expect(compareMapping(graph, edges, result), name).toEqual([]);
      }
    },
    600_000
  );

  it.skipIf(!probe.available || server === undefined)(
    titleWithReason(
      'save node graphs through Neo4jTemplate and read them back (the blog schema and join tables, both naming modes)',
      access.probe
    ),
    async () => {
      const blog: VerifySource | undefined = VERIFY_SOURCES.find(
        (source: VerifySource) => source.label === 'prisma'
      );
      if (blog === undefined) {
        throw new Error('The canonical Prisma source is missing.');
      }
      const groups: ToolGroup[] = [];
      for (const naming of NAMING_MODES) {
        groups.push(
          stageGroup(await parseSource(blog), naming, `blog.${naming}`),
          stageGroup(joinsSchema(), naming, `joins.${naming}`)
        );
      }
      const output: SdnToolOutput = runSdnTool(probe, groups, server);
      for (const group of groups) {
        const result = output[group.name];
        if (result === undefined || isToolError(result)) {
          throw new Error(`${group.name}: ${JSON.stringify(result)}`);
        }
        const checks = result.__live ?? [];
        expect(checks.length, group.name).toBeGreaterThan(5);
        expect(
          checks.filter((item) => !item.ok),
          group.name
        ).toEqual([]);
      }
    },
    600_000
  );
});
