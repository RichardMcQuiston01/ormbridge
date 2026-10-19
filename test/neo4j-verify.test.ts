import { afterAll, describe, expect, it } from 'vitest';
import { emitNeo4j } from '../src/emitters/neo4j.js';
import {
  buildGraph,
  primaryKeyNamesOf,
  type Graph,
  type GraphNode,
} from '../src/emitters/neo4jGraph.js';
import type { Neo4jStyle } from '../src/emitters/neo4jTypes.js';
import type { IrField, IrModel, IrSchema } from '../src/ir.js';
import { normalizeSchema, type NamingMode } from '../src/transforms.js';
import { constructsSchema } from './drizzleFixtures.js';
import { kitchenSinkSchema, stressSchema } from './gormFixtures.js';
import { joinsSchema, keysSchema } from './neo4jFixtures.js';
import {
  clearSchema,
  cypherExecute,
  cypherRows,
  openNeo4jServers,
  readConstraints,
  readIndexes,
  splitCypher,
  type CatalogConstraint,
  type CatalogIndex,
  type Neo4jAccess,
  type Neo4jServer,
} from './neo4jSupport.js';
import {
  parseSource,
  titleWithReason,
  VERIFY_SOURCES,
  type ToolProbe,
  type VerifySource,
} from './realToolSupport.js';

/**
 * Runs the Cypher output of the Neo4j writer in a real Neo4j server (HTTP transaction endpoint) and
 * compares the constraints and indexes the server reports with the statements and the IR. Every
 * script is applied twice to prove that `IF NOT EXISTS` makes it idempotent, and a second group of
 * tests writes data to check that the constraints reject what they should. Needs `NEO4J_URL` or
 * `NEO4J_DOCKER=1`; the enterprise-style tests also need an Enterprise Edition server (see
 * test/README.md). Skipped with a reason in the title otherwise.
 */

const access: Neo4jAccess = await openNeo4jServers();
const community: Neo4jServer | undefined = access.server;
const enterprise: Neo4jServer | undefined = access.enterprise;
const enterpriseProbe: ToolProbe = enterprise
  ? { available: true, reason: '' }
  : {
      available: false,
      reason:
        'needs a Neo4j Enterprise Edition server: set NEO4J_URL to one, or NEO4J_ENTERPRISE_DOCKER=1 with NEO4J_ACCEPT_LICENSE_AGREEMENT=yes (or eval)',
    };

afterAll(() => {
  community?.stop();
  if (enterprise !== undefined && enterprise !== community) {
    enterprise.stop();
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

// ---------------------------------------------------------------------------
// What the script says the catalog must hold
// ---------------------------------------------------------------------------

const NAME_PATTERN: RegExp =
  /^CREATE (?:FULLTEXT )?(CONSTRAINT|INDEX) (`(?:[^`]|``)+`|\w+) IF NOT EXISTS/;

function catalogName(quoted: string): string {
  return quoted.startsWith('`')
    ? quoted.slice(1, -1).replace(/``/g, '`')
    : quoted;
}

function expectedConstraintType(statement: string): string {
  const relationship: boolean = statement.includes(')-[r:');
  if (statement.endsWith('IS UNIQUE')) {
    return relationship ? 'RELATIONSHIP_UNIQUENESS' : 'UNIQUENESS';
  }
  if (statement.endsWith('IS NODE KEY')) {
    return 'NODE_KEY';
  }
  if (statement.endsWith('IS NOT NULL')) {
    return relationship
      ? 'RELATIONSHIP_PROPERTY_EXISTENCE'
      : 'NODE_PROPERTY_EXISTENCE';
  }
  return 'NODE_PROPERTY_TYPE';
}

/** Compares the catalog with the statements that were run. */
function compareWithStatements(
  statements: string[],
  constraints: CatalogConstraint[],
  indexes: CatalogIndex[]
): string[] {
  const problems: string[] = [];
  const wantedConstraints: Map<string, string> = new Map<string, string>();
  const wantedIndexes: Set<string> = new Set<string>();
  for (const statement of statements) {
    const match: RegExpExecArray | null = NAME_PATTERN.exec(statement);
    if (match === null) {
      problems.push(`not a CREATE CONSTRAINT or INDEX statement: ${statement}`);
      continue;
    }
    const name: string = catalogName(match[2] ?? '');
    if (match[1] === 'CONSTRAINT') {
      wantedConstraints.set(name, expectedConstraintType(statement));
    } else {
      wantedIndexes.add(name);
    }
  }
  expect(constraints.map((constraint) => constraint.name).sort()).toEqual(
    [...wantedConstraints.keys()].sort()
  );
  expect(indexes.map((index) => index.name).sort()).toEqual(
    [...wantedIndexes].sort()
  );
  for (const constraint of constraints) {
    const wanted: string | undefined = wantedConstraints.get(constraint.name);
    if (
      !constraint.type.startsWith(wanted ?? '') &&
      constraint.type !== wanted
    ) {
      problems.push(
        `${constraint.name}: the server reports ${constraint.type}, the script says ${wanted}`
      );
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------
// What the IR says the catalog must hold
// ---------------------------------------------------------------------------

function hasConstraint(
  constraints: CatalogConstraint[],
  label: string,
  keys: string[],
  types: string[]
): boolean {
  return constraints.some(
    (constraint: CatalogConstraint) =>
      constraint.entityType === 'NODE' &&
      constraint.labelsOrTypes[0] === label &&
      types.includes(constraint.type) &&
      constraint.properties.join('\u0000') === keys.join('\u0000')
  );
}

function hasIndex(
  indexes: CatalogIndex[],
  label: string,
  keys: string[]
): boolean {
  return indexes.some(
    (index: CatalogIndex) =>
      index.entityType === 'NODE' &&
      index.type === 'RANGE' &&
      index.labelsOrTypes[0] === label &&
      index.properties.join('\u0000') === keys.join('\u0000')
  );
}

function compareWithSchema(
  graph: Graph,
  constraints: CatalogConstraint[],
  indexes: CatalogIndex[]
): string[] {
  const problems: string[] = [];
  const unique: string[] = ['UNIQUENESS', 'NODE_KEY'];
  const resolve = (node: GraphNode, names: string[]): string[] | undefined => {
    const keys: string[] = [];
    for (const name of names) {
      const key: string | undefined = node.keys.get(name);
      if (key === undefined) {
        return undefined;
      }
      keys.push(key);
    }
    return keys;
  };
  for (const node of graph.nodes) {
    const model: IrModel = node.model;
    const keyNames: string[] = primaryKeyNamesOf(model);
    const keys: string[] | undefined = resolve(node, keyNames);
    if (keys !== undefined && keys.length > 0) {
      if (!hasConstraint(constraints, node.label, keys, unique)) {
        problems.push(
          `${node.label}: no uniqueness constraint on the primary key (${keys.join(', ')})`
        );
      }
    }
    for (const field of model.fields.filter(
      (candidate: IrField) => candidate.isUnique
    )) {
      const key: string | undefined = node.keys.get(field.name);
      if (
        key !== undefined &&
        !hasConstraint(constraints, node.label, [key], unique)
      ) {
        problems.push(`${node.label}.${key}: no uniqueness constraint`);
      }
    }
    for (const index of model.indexes) {
      const indexKeys: string[] | undefined = resolve(node, index.fields);
      const plain: boolean =
        index.kind === undefined &&
        (index.method === undefined || index.method.toLowerCase() === 'btree');
      if (indexKeys === undefined || !plain) {
        continue;
      }
      const found: boolean = index.isUnique
        ? hasConstraint(constraints, node.label, indexKeys, unique)
        : hasIndex(indexes, node.label, indexKeys) ||
          hasConstraint(constraints, node.label, indexKeys, unique);
      if (!found) {
        problems.push(
          `${node.label}: nothing for the ${index.isUnique ? 'unique ' : ''}index (${indexKeys.join(', ')})`
        );
      }
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Schema tests
// ---------------------------------------------------------------------------

async function applyScript(
  server: Neo4jServer,
  statements: string[],
  context: string
): Promise<void> {
  for (const statement of statements) {
    try {
      await cypherExecute(server, statement);
    } catch (error: unknown) {
      throw new Error(
        `${context} failed in Neo4j ${server.version} ${server.edition}: ${error instanceof Error ? error.message : String(error)}\n${statement}`,
        { cause: error }
      );
    }
  }
}

describe('Neo4j schema in a real server', () => {
  describe.each(SCHEMAS)('$label', (schemaCase) => {
    it.skipIf(community === undefined)(
      titleWithReason(
        'applies the community script twice and matches the schema (both naming modes)',
        access.probe
      ),
      async () => {
        const server: Neo4jServer = community as Neo4jServer;
        const schema: IrSchema = await schemaCase.load();
        for (const naming of NAMING_MODES) {
          const camelFields: boolean = naming === 'normalize';
          const prepared: IrSchema = camelFields
            ? normalizeSchema(schema)
            : schema;
          const output = emitNeo4j(prepared, { camelFields });
          const statements: string[] = splitCypher(output.text);
          const context: string = `${schemaCase.label} (${naming})`;
          await clearSchema(server);
          await applyScript(server, statements, context);
          const constraints: CatalogConstraint[] =
            await readConstraints(server);
          const indexes: CatalogIndex[] = await readIndexes(server);

          // A second run changes nothing.
          await applyScript(server, statements, `${context}, second run`);
          expect(await readConstraints(server), context).toEqual(constraints);
          expect(await readIndexes(server), context).toEqual(indexes);

          const graph: Graph = buildGraph(prepared, { camelFields }, []);
          const problems: string[] = [
            ...compareWithStatements(statements, constraints, indexes),
            ...compareWithSchema(graph, constraints, indexes),
          ];
          expect(problems, context).toEqual([]);
        }
      },
      120_000
    );

    it.skipIf(enterprise === undefined)(
      titleWithReason(
        'applies the enterprise script twice and matches the schema (both naming modes)',
        enterpriseProbe
      ),
      async () => {
        const server: Neo4jServer = enterprise as Neo4jServer;
        const schema: IrSchema = await schemaCase.load();
        for (const naming of NAMING_MODES) {
          const camelFields: boolean = naming === 'normalize';
          const prepared: IrSchema = camelFields
            ? normalizeSchema(schema)
            : schema;
          const style: Neo4jStyle = 'enterprise';
          const output = emitNeo4j(prepared, { camelFields, style });
          const statements: string[] = splitCypher(output.text);
          const context: string = `${schemaCase.label} (${naming}, enterprise)`;
          await clearSchema(server);
          await applyScript(server, statements, context);
          const constraints: CatalogConstraint[] =
            await readConstraints(server);
          const indexes: CatalogIndex[] = await readIndexes(server);
          await applyScript(server, statements, `${context}, second run`);
          expect(await readConstraints(server), context).toEqual(constraints);
          expect(await readIndexes(server), context).toEqual(indexes);
          const graph: Graph = buildGraph(prepared, { camelFields }, []);
          expect(
            [
              ...compareWithStatements(statements, constraints, indexes),
              ...compareWithSchema(graph, constraints, indexes),
            ],
            context
          ).toEqual([]);
        }
      },
      120_000
    );
  });
});

// ---------------------------------------------------------------------------
// Behaviour: the constraints reject what they should
// ---------------------------------------------------------------------------

async function rejects(
  server: Neo4jServer,
  statement: string
): Promise<string> {
  try {
    await cypherExecute(server, statement);
  } catch (error: unknown) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error(
    `Neo4j accepted a statement that a constraint should reject: ${statement}`
  );
}

describe('Neo4j constraints reject bad data', () => {
  it.skipIf(community === undefined)(
    titleWithReason(
      'community: uniqueness constraints on nodes and relationships',
      access.probe
    ),
    async () => {
      const server: Neo4jServer = community as Neo4jServer;
      await clearSchema(server);
      const schema: IrSchema = joinsSchema();
      await applyScript(
        server,
        splitCypher(emitNeo4j(schema, { camelFields: false }).text),
        'joins'
      );

      await cypherExecute(
        server,
        'CREATE (:Student {id: 1}), (:Student {id: 2}), (:Course {id: 1})'
      );
      expect(await rejects(server, 'CREATE (:Student {id: 1})')).toMatch(
        /already exists/
      );

      await cypherExecute(
        server,
        'MATCH (s:Student {id: 1}), (c:Course {id: 1}) CREATE (s)-[:COURSES {ticket: "t1", role: "student"}]->(c)'
      );
      expect(
        await rejects(
          server,
          'MATCH (s:Student {id: 2}), (c:Course {id: 1}) CREATE (s)-[:COURSES {ticket: "t1", role: "student"}]->(c)'
        )
      ).toMatch(/already exists|Constraint/i);
      // The community style leaves existence and type rules out: a missing id is accepted.
      await cypherExecute(server, 'CREATE (:Student {name: "no id"})');
    },
    120_000
  );

  it.skipIf(community === undefined)(
    titleWithReason(
      'community: a composite primary key is a composite uniqueness constraint',
      access.probe
    ),
    async () => {
      const server: Neo4jServer = community as Neo4jServer;
      await clearSchema(server);
      await applyScript(
        server,
        splitCypher(emitNeo4j(keysSchema(), { camelFields: false }).text),
        'keys'
      );
      await cypherExecute(
        server,
        'CREATE (:Ledger {year: 2024, number: 1, code: "a"})'
      );
      await cypherExecute(
        server,
        'CREATE (:Ledger {year: 2024, number: 2, code: "b"})'
      );
      expect(
        await rejects(
          server,
          'CREATE (:Ledger {year: 2024, number: 1, code: "c"})'
        )
      ).toMatch(/already exists/);
      expect(
        await rejects(
          server,
          'CREATE (:Ledger {year: 2025, number: 1, code: "a"})'
        )
      ).toMatch(/already exists/);
      const rows = await cypherRows(
        server,
        'MATCH (n:Ledger) RETURN count(n) AS total'
      );
      expect(rows[0]?.total).toBe(2);
    },
    120_000
  );

  it.skipIf(enterprise === undefined)(
    titleWithReason(
      'enterprise: node keys, required properties and property types',
      enterpriseProbe
    ),
    async () => {
      const server: Neo4jServer = enterprise as Neo4jServer;
      await clearSchema(server);
      const style: Neo4jStyle = 'enterprise';
      await applyScript(
        server,
        splitCypher(
          emitNeo4j(keysSchema(), { camelFields: false, style }).text
        ),
        'keys'
      );
      await cypherExecute(
        server,
        'CREATE (:Ledger {year: 2024, number: 1, code: "a"})'
      );
      // NODE KEY: unique and required.
      expect(
        await rejects(
          server,
          'CREATE (:Ledger {year: 2024, number: 1, code: "b"})'
        )
      ).toMatch(/already exists/);
      expect(
        await rejects(server, 'CREATE (:Ledger {year: 2024, code: "c"})')
      ).toMatch(/ConstraintValidationFailed/);
      // IS NOT NULL on a required property.
      expect(
        await rejects(server, 'CREATE (:Ledger {year: 2030, number: 9})')
      ).toMatch(/ConstraintValidationFailed/);
      // IS :: INTEGER on year.
      expect(
        await rejects(
          server,
          'CREATE (:Ledger {year: "2030", number: 9, code: "d"})'
        )
      ).toMatch(/ConstraintValidationFailed/);
      // An optional property may be missing.
      await cypherExecute(
        server,
        'CREATE (:Ledger {year: 2031, number: 1, code: "e"})'
      );
    },
    120_000
  );
});
