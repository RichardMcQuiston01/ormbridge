import { afterAll, describe, expect, it } from 'vitest';
import { emitNeomodel } from '../src/emitters/neomodel.js';
import { collectEdges, type GraphEdge } from '../src/emitters/neo4jEdges.js';
import { buildGraph, type Graph } from '../src/emitters/neo4jGraph.js';
import type { IrSchema } from '../src/ir.js';
import { normalizeSchema, type NamingMode } from '../src/transforms.js';
import { constructsSchema } from './drizzleFixtures.js';
import { kitchenSinkSchema, stressSchema } from './gormFixtures.js';
import { joinsSchema, keysSchema } from './neo4jFixtures.js';
import { openNeo4jServers, type Neo4jAccess } from './neo4jSupport.js';
import {
  actualCatalog,
  compareCatalogWithSchema,
  compareProperties,
  compareRelationships,
  expectedCatalog,
  probeNeomodel,
  readScenario,
  readSchemaReport,
  type ScenarioCheck,
  type SchemaReport,
} from './neomodelSupport.js';
import {
  parseSource,
  titleWithReason,
  VERIFY_SOURCES,
  type ToolProbe,
  type VerifySource,
} from './realToolSupport.js';

/**
 * Imports the Python module of `--to neomodel` with the real neomodel, runs `install_labels` against a real
 * Neo4j server and compares what the classes declare, what the server reports and the IR; then saves nodes and
 * relationships, reads them back and checks that unique, required, length, choice and cardinality rules hold.
 * Needs `NEOMODEL_PYTHON` (a Python with neomodel; test/tools/setup-verification-tools.sh installs it) and a
 * server (`NEO4J_URL` or `NEO4J_DOCKER=1`, see test/README.md); skipped with a reason in the title otherwise.
 */

const python: ToolProbe = probeNeomodel();
const access: Neo4jAccess = python.available
  ? await openNeo4jServers()
  : { probe: python };
const probe: ToolProbe = python.available ? access.probe : python;
const server = access.server;

afterAll(() => {
  server?.stop();
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

function moduleFor(schema: IrSchema, naming: NamingMode): string {
  const camelFields: boolean = naming === 'normalize';
  return emitNeomodel(camelFields ? normalizeSchema(schema) : schema, {
    camelFields,
  }).text;
}

describe('neomodel module in a real neomodel and Neo4j', () => {
  describe.each(SCHEMAS)('$label', (schemaCase) => {
    it.skipIf(server === undefined)(
      titleWithReason(
        'installs labels, and the catalog, the classes and the IR agree (both naming modes)',
        probe
      ),
      async () => {
        const schema: IrSchema = await schemaCase.load();
        for (const naming of NAMING_MODES) {
          const camelFields: boolean = naming === 'normalize';
          const prepared: IrSchema = camelFields
            ? normalizeSchema(schema)
            : schema;
          const context: string = `${schemaCase.label} (${naming})`;
          const report: SchemaReport = readSchemaReport(
            moduleFor(schema, naming),
            server as NonNullable<typeof server>
          );
          expect(actualCatalog(report), context).toEqual(
            expectedCatalog(report)
          );
          const graph: Graph = buildGraph(prepared, { camelFields }, []);
          const edges: GraphEdge[] = collectEdges(prepared, graph, []);
          expect(
            [
              ...compareCatalogWithSchema(graph, report),
              ...compareRelationships(graph, edges, report),
              ...compareProperties(graph, report),
            ],
            context
          ).toEqual([]);
        }
      },
      240_000
    );
  });

  describe.each([
    [
      'blog',
      'the canonical blog schema',
      async () => parseSource(canonicalPrisma()),
    ],
    [
      'joins',
      'join tables and many-to-many relations',
      () => Promise.resolve(joinsSchema()),
    ],
    ['types', 'every property type', () => Promise.resolve(keysSchema())],
  ] as const)('%s scenario', (mode, description, load) => {
    it.skipIf(server === undefined)(
      titleWithReason(
        `${description}: nodes and relationships are saved, read back and checked (both naming modes)`,
        probe
      ),
      async () => {
        const schema: IrSchema = await load();
        for (const naming of NAMING_MODES) {
          const checks: ScenarioCheck[] = readScenario(
            mode,
            moduleFor(schema, naming),
            server as NonNullable<typeof server>
          );
          expect(checks.length, naming).toBeGreaterThan(5);
          expect(
            checks.filter((item: ScenarioCheck) => !item.ok),
            naming
          ).toEqual([]);
        }
      },
      240_000
    );
  });
});

function canonicalPrisma(): VerifySource {
  const found: VerifySource | undefined = VERIFY_SOURCES.find(
    (source: VerifySource) => source.label === 'prisma'
  );
  if (found === undefined) {
    throw new Error('The canonical Prisma source is missing.');
  }
  return found;
}
