import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { GraphEdge } from '../src/emitters/neo4jEdges.js';
import type { Graph, GraphNode } from '../src/emitters/neo4jGraph.js';
import { primaryKeyNamesOf } from '../src/emitters/neo4jGraph.js';
import type { IrField, IrModel } from '../src/ir.js';
import type { Neo4jServer } from './neo4jSupport.js';
import { probePython, type ToolProbe } from './realToolSupport.js';

/**
 * Helpers for the tests that load the neomodel output with the real neomodel and a real Neo4j server:
 * the Python interpreter, the probe, and the checks that compare what neomodel declares and what the
 * server reports with the IR.
 *
 * - `NEOMODEL_PYTHON` is a Python with `neomodel` installed (`test/tools/setup-verification-tools.sh`
 *   installs the pinned version into a virtual environment and prints the variable).
 * - The server comes from `NEO4J_URL` or `NEO4J_DOCKER=1` (see `neo4jSupport.ts`); neomodel connects over
 *   Bolt, which is port 7687 of the same host unless `NEO4J_BOLT_URL` says otherwise.
 */

export const NEOMODEL_VERSION_PIN: string = '7.0.0';

export function neomodelPython(): string {
  return process.env.NEOMODEL_PYTHON ?? 'python3';
}

export function probeNeomodel(): ToolProbe {
  return probePython(neomodelPython(), ['neomodel'], 'NEOMODEL_PYTHON');
}

const SCRIPT: string = fileURLToPath(
  new URL('./tools/validate-neomodel.py', import.meta.url)
);

export interface DeclaredProperty {
  db: string;
  type: string;
  unique: boolean;
  index: boolean;
  fulltext: boolean;
  required: boolean;
  hasDefault: boolean;
}

export interface DeclaredRelationship {
  type: string;
  direction: 'out' | 'in' | 'either';
  cardinality: string;
  /** The class name the relationship points at. */
  target: string;
  /** The relationship class, when it has one. */
  model: string | null;
}

export interface DeclaredClass {
  label: string;
  properties: Record<string, DeclaredProperty>;
  relationships: Record<string, DeclaredRelationship>;
}

export interface CatalogEntry {
  name: string;
  type: string;
  entityType: string;
  labelsOrTypes: string[];
  properties: string[];
}

export interface SchemaReport {
  classes: Record<string, DeclaredClass>;
  relationshipClasses: Record<string, Record<string, DeclaredProperty>>;
  constraints: CatalogEntry[];
  indexes: CatalogEntry[];
  version: string;
}

export interface ScenarioCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export type NeomodelMode = 'schema' | 'blog' | 'joins' | 'types';

/** Runs the Python script on a module text; the module is written to a throwaway directory. */
export function runNeomodel(
  mode: NeomodelMode,
  moduleText: string,
  server: Neo4jServer
): { stdout: string; stderr: string; status: number | null } {
  const directory: string = mkdtempSync(join(tmpdir(), 'ormbridge-neomodel-'));
  try {
    const file: string = join(directory, 'models.py');
    writeFileSync(file, moduleText);
    const run: SpawnSyncReturns<string> = spawnSync(
      neomodelPython(),
      [SCRIPT, mode, file],
      {
        encoding: 'utf8',
        timeout: 240_000,
        env: {
          ...process.env,
          NEOMODEL_BOLT_URL: server.boltUrl,
          NEOMODEL_USER: server.user,
          NEOMODEL_PASSWORD: server.password,
        },
      }
    );
    return {
      stdout: run.stdout,
      stderr: `${run.stderr}${run.error === undefined ? '' : String(run.error)}`,
      status: run.status,
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

export function readSchemaReport(
  moduleText: string,
  server: Neo4jServer
): SchemaReport {
  const run = runNeomodel('schema', moduleText, server);
  if (run.status !== 0) {
    throw new Error(
      `validate-neomodel.py failed (exit ${String(run.status)}):\n${run.stderr}\n${run.stdout}`
    );
  }
  return JSON.parse(run.stdout) as SchemaReport;
}

export function readScenario(
  mode: Exclude<NeomodelMode, 'schema'>,
  moduleText: string,
  server: Neo4jServer
): ScenarioCheck[] {
  const run = runNeomodel(mode, moduleText, server);
  if (run.status !== 0) {
    throw new Error(
      `validate-neomodel.py ${mode} failed (exit ${String(run.status)}):\n${run.stderr}\n${run.stdout}`
    );
  }
  return JSON.parse(
    run.stdout.trim().split('\n').pop() ?? '[]'
  ) as ScenarioCheck[];
}

// ---------------------------------------------------------------------------
// Declared properties against the server catalog
// ---------------------------------------------------------------------------

function entry(
  kind: string,
  entity: string,
  target: string,
  properties: string[]
): string {
  return `${kind} ${entity} ${target} (${properties.join(', ')})`;
}

/** What `install_labels` has to create for the classes, from what the classes declare. */
export function expectedCatalog(report: SchemaReport): {
  constraints: string[];
  indexes: string[];
} {
  const constraints: Set<string> = new Set<string>();
  const indexes: Set<string> = new Set<string>();
  const add = (
    properties: Record<string, DeclaredProperty>,
    entity: 'NODE' | 'RELATIONSHIP',
    target: string
  ): void => {
    const prefix: string = entity === 'NODE' ? '' : 'RELATIONSHIP_';
    for (const property of Object.values(properties)) {
      if (property.unique) {
        constraints.add(
          entry(`${prefix}UNIQUENESS`, entity, target, [property.db])
        );
      } else if (property.index) {
        indexes.add(entry('RANGE', entity, target, [property.db]));
      }
      if (property.fulltext) {
        indexes.add(entry('FULLTEXT', entity, target, [property.db]));
      }
    }
  };
  for (const declared of Object.values(report.classes)) {
    add(declared.properties, 'NODE', declared.label);
    for (const relationship of Object.values(declared.relationships)) {
      if (relationship.model !== null) {
        add(
          report.relationshipClasses[relationship.model] ?? {},
          'RELATIONSHIP',
          relationship.type
        );
      }
    }
  }
  return { constraints: [...constraints].sort(), indexes: [...indexes].sort() };
}

/** What the server reports, in the same notation as `expectedCatalog`. */
export function actualCatalog(report: SchemaReport): {
  constraints: string[];
  indexes: string[];
} {
  const describe = (item: CatalogEntry): string =>
    entry(
      item.type,
      item.entityType,
      item.labelsOrTypes.join(':'),
      item.properties
    );
  return {
    constraints: report.constraints.map(describe).sort(),
    indexes: report.indexes.map(describe).sort(),
  };
}

// ---------------------------------------------------------------------------
// The IR against the declared classes
// ---------------------------------------------------------------------------

function hasEntry(
  report: SchemaReport,
  label: string,
  keys: string[],
  kinds: string[]
): boolean {
  const wanted: string = keys.join('\u0000');
  return [...report.constraints, ...report.indexes].some(
    (item: CatalogEntry) =>
      item.entityType === 'NODE' &&
      item.labelsOrTypes[0] === label &&
      kinds.includes(item.type) &&
      item.properties.join('\u0000') === wanted
  );
}

/** Lists what the server catalog lacks for the keys, unique columns and indexes of the IR. */
export function compareCatalogWithSchema(
  graph: Graph,
  report: SchemaReport
): string[] {
  const problems: string[] = [];
  const unique: string[] = ['UNIQUENESS'];
  const indexed: string[] = ['UNIQUENESS', 'RANGE'];
  for (const node of graph.nodes) {
    const model: IrModel = node.model;
    const resolve = (names: string[]): string[] | undefined => {
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
    const keys: string[] | undefined = resolve(primaryKeyNamesOf(model));
    if (keys !== undefined && keys.length === 1) {
      if (!hasEntry(report, node.label, keys, unique)) {
        problems.push(
          `${node.label}: no uniqueness constraint on ${keys[0] ?? ''}`
        );
      }
    } else if (keys !== undefined && keys.length > 1) {
      for (const key of keys) {
        if (!hasEntry(report, node.label, [key], indexed)) {
          problems.push(
            `${node.label}.${key}: a part of the composite key has no index`
          );
        }
      }
    }
    for (const field of model.fields.filter((item: IrField) => item.isUnique)) {
      const key: string | undefined = node.keys.get(field.name);
      if (key !== undefined && !hasEntry(report, node.label, [key], unique)) {
        problems.push(`${node.label}.${key}: no uniqueness constraint`);
      }
    }
    for (const relation of model.relations.filter(
      (item) => item.kind === 'oneToOne'
    )) {
      const key: string | undefined = node.keys.get(relation.name);
      if (key !== undefined && !hasEntry(report, node.label, [key], unique)) {
        problems.push(
          `${node.label}.${key}: no uniqueness constraint for the one-to-one key`
        );
      }
    }
    for (const index of model.indexes) {
      const indexKeys: string[] | undefined = resolve(index.fields);
      const plain: boolean =
        index.method === undefined || index.method.toLowerCase() === 'btree';
      if (indexKeys === undefined || !plain) {
        continue;
      }
      if (index.kind === 'fulltext') {
        for (const key of indexKeys) {
          const declared = Object.values(
            Object.values(report.classes).find(
              (item) => item.label === node.label
            )?.properties ?? {}
          ).find((property) => property.db === key);
          if (
            declared?.type === 'StringProperty' &&
            !hasEntry(report, node.label, [key], ['FULLTEXT'])
          ) {
            problems.push(`${node.label}.${key}: no full-text index`);
          }
        }
      } else if (index.isUnique && indexKeys.length === 1) {
        if (!hasEntry(report, node.label, indexKeys, unique)) {
          problems.push(
            `${node.label}.${indexKeys[0] ?? ''}: no uniqueness constraint for the unique index`
          );
        }
      } else {
        for (const key of indexKeys) {
          if (!hasEntry(report, node.label, [key], indexed)) {
            problems.push(
              `${node.label}.${key}: no index for (${indexKeys.join(', ')})`
            );
          }
        }
      }
    }
  }
  return problems;
}

const CARDINALITY_CLASS: Readonly<Record<GraphEdge['outgoing'], string>> = {
  one: 'One',
  zeroOrOne: 'ZeroOrOne',
  zeroOrMore: 'ZeroOrMore',
  oneOrMore: 'OneOrMore',
};

/** Lists the differences between the edges of the graph and the relationships the classes declare. */
export function compareRelationships(
  graph: Graph,
  edges: GraphEdge[],
  report: SchemaReport
): string[] {
  const problems: string[] = [];
  const classOf = (label: string): [string, DeclaredClass] | undefined =>
    Object.entries(report.classes).find(
      ([, declared]) => declared.label === label
    );
  let expected: number = 0;
  for (const edge of edges) {
    const source = classOf(edge.source.label);
    const target = classOf(edge.target.label);
    if (source === undefined || target === undefined) {
      problems.push(
        `${edge.type}: no class for ${edge.source.label} or ${edge.target.label}`
      );
      continue;
    }
    expected += 2;
    const find = (
      owner: DeclaredClass,
      direction: 'out' | 'in',
      other: string,
      cardinality: string
    ): boolean =>
      Object.values(owner.relationships).some(
        (item) =>
          item.type === edge.type &&
          item.direction === direction &&
          item.target === other &&
          item.cardinality === cardinality &&
          (item.model !== null) === edge.properties.length > 0
      );
    if (!find(source[1], 'out', target[0], CARDINALITY_CLASS[edge.outgoing])) {
      problems.push(
        `${edge.source.label}: no ${CARDINALITY_CLASS[edge.outgoing]} relationship ${edge.type} to ${edge.target.label}`
      );
    }
    if (!find(target[1], 'in', source[0], CARDINALITY_CLASS[edge.incoming])) {
      problems.push(
        `${edge.target.label}: no ${CARDINALITY_CLASS[edge.incoming]} reverse relationship ${edge.type} from ${edge.source.label}`
      );
    }
  }
  const declared: number = Object.values(report.classes).reduce(
    (sum: number, item: DeclaredClass) =>
      sum + Object.keys(item.relationships).length,
    0
  );
  if (declared !== expected) {
    problems.push(
      `the classes declare ${declared} relationships, the graph has ${expected / 2} (two ends each)`
    );
  }
  // Every node has a class, and every class a node.
  const labels: string[] = graph.nodes
    .map((node: GraphNode) => node.label)
    .sort();
  const declaredLabels: string[] = Object.values(report.classes)
    .map((item: DeclaredClass) => item.label)
    .sort();
  if (labels.join('\u0000') !== declaredLabels.join('\u0000')) {
    problems.push(
      `labels differ: ${labels.join(', ')} against ${declaredLabels.join(', ')}`
    );
  }
  return problems;
}

/** Lists the properties of the graph that a class lacks (by database name), or that it has too many. */
export function compareProperties(
  graph: Graph,
  report: SchemaReport
): string[] {
  const problems: string[] = [];
  for (const node of graph.nodes) {
    const declared: DeclaredClass | undefined = Object.values(
      report.classes
    ).find((item: DeclaredClass) => item.label === node.label);
    if (declared === undefined) {
      continue;
    }
    const wanted: string[] = [
      ...new Set(node.properties.map((property) => property.key)),
    ].sort();
    const actual: string[] = Object.values(declared.properties)
      .map((property: DeclaredProperty) => property.db)
      .sort();
    if (wanted.join('\u0000') !== actual.join('\u0000')) {
      problems.push(
        `${node.label}: properties ${actual.join(', ')} against ${wanted.join(', ')}`
      );
    }
  }
  return problems;
}
