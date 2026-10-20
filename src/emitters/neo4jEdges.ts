import type {
  IrCompositeForeignKey,
  IrModel,
  IrOnDelete,
  IrRelation,
  IrSchema,
} from '../ir.js';
import type {
  Graph,
  GraphJoin,
  GraphNode,
  GraphProperty,
} from './neo4jGraph.js';
import { toSnakeCase } from '../naming.js';
import { relationshipTypeOf } from './neo4jNames.js';
import { isMirror } from './neo4jRelationships.js';

/**
 * The relationships of the graph model as data, for the writers that declare them (neomodel, Spring
 * Data Neo4j). The Cypher writer documents the same relationships as comments, so the three agree on
 * the relationship types, the direction and the cardinalities. One edge is one relationship type
 * between two node labels: a foreign key, a one-to-one key, a composite foreign key, a many-to-many
 * relation (written once, from the side that comes first) or a join table that became a relationship.
 */

/** How many nodes one end of a relationship can reach through it. */
export type EdgeCardinality = 'one' | 'zeroOrOne' | 'zeroOrMore' | 'oneOrMore';

export interface GraphEdge {
  kind: 'foreignKey' | 'oneToOne' | 'manyToMany' | 'join';
  /** The relationship type, for example `AUTHOR`. */
  type: string;
  /** The node the relationship starts at: the one that owns the foreign key. */
  source: GraphNode;
  target: GraphNode;
  /** The IR relation name on the source (the key name for a composite key; for a join, the forward name). */
  name: string;
  /** The name of the reverse accessor in the source (`related_name`), when the source has one. */
  reverseName?: string;
  /** How many targets one source node has. */
  outgoing: EdgeCardinality;
  /** How many source nodes one target node has. */
  incoming: EdgeCardinality;
  onDelete?: IrOnDelete;
  /** The IR relation behind a foreign key, one-to-one key or many-to-many relation. */
  relation?: IrRelation;
  composite?: IrCompositeForeignKey;
  /** The join table behind a `join` edge; its extra columns are `properties`. */
  join?: GraphJoin;
  /** Relationship properties (the extra columns of a join table). */
  properties: GraphProperty[];
}

function nodeOf(graph: Graph, model: string): GraphNode | undefined {
  return graph.byModel.get(model);
}

function missingTarget(
  warnings: string[],
  model: IrModel,
  name: string,
  target: string
): void {
  warnings.push(
    `${model.name}.${name}: the target model ${target} is not in the schema, so the relationship was not written.`
  );
}

function foreignKeyEdge(
  node: GraphNode,
  target: GraphNode,
  relation: IrRelation
): GraphEdge {
  return {
    kind: relation.kind === 'oneToOne' ? 'oneToOne' : 'foreignKey',
    type: relationshipTypeOf(relation.name),
    source: node,
    target,
    name: relation.name,
    ...(relation.relatedName === undefined
      ? {}
      : { reverseName: relation.relatedName }),
    outgoing: relation.isNullable ? 'zeroOrOne' : 'one',
    incoming: relation.kind === 'oneToOne' ? 'zeroOrOne' : 'zeroOrMore',
    onDelete: relation.onDelete,
    relation,
    properties: [],
  };
}

function compositeEdge(
  node: GraphNode,
  target: GraphNode,
  key: IrCompositeForeignKey
): GraphEdge {
  return {
    kind: key.kind === 'oneToOne' ? 'oneToOne' : 'foreignKey',
    type: relationshipTypeOf(key.name),
    source: node,
    target,
    name: key.name,
    outgoing: key.isNullable ? 'zeroOrOne' : 'one',
    incoming: key.kind === 'oneToOne' ? 'zeroOrOne' : 'zeroOrMore',
    onDelete: key.onDelete,
    composite: key,
    properties: [],
  };
}

function manyToManyEdge(
  node: GraphNode,
  target: GraphNode,
  relation: IrRelation
): GraphEdge {
  const mirror: IrRelation | undefined = target.model.relations.find(
    (other: IrRelation) =>
      other !== relation &&
      other.kind === 'manyToMany' &&
      other.targetModel === node.model.name &&
      (other.name === relation.relatedName ||
        other.relatedName === relation.name)
  );
  const reverseName: string | undefined = relation.relatedName ?? mirror?.name;
  return {
    kind: 'manyToMany',
    type: relationshipTypeOf(relation.name),
    source: node,
    target,
    name: relation.name,
    ...(reverseName === undefined ? {} : { reverseName }),
    outgoing: 'zeroOrMore',
    incoming: 'zeroOrMore',
    relation,
    properties: [],
  };
}

function joinEdge(graph: Graph, join: GraphJoin): GraphEdge | undefined {
  const source: GraphNode | undefined = nodeOf(graph, join.from.targetModel);
  const target: GraphNode | undefined = nodeOf(graph, join.to.targetModel);
  if (source === undefined || target === undefined) {
    return undefined;
  }
  return {
    kind: 'join',
    type: join.type,
    source,
    target,
    name: join.from.relatedName ?? join.to.name,
    ...(join.to.relatedName === undefined
      ? {}
      : { reverseName: join.to.relatedName }),
    outgoing: 'zeroOrMore',
    incoming: 'zeroOrMore',
    join,
    properties: join.extras,
  };
}

/**
 * Lists the relationships in the order the Cypher writer documents them: per node in model order its
 * foreign keys, one-to-one keys and many-to-many relations (a pair once), then its composite foreign
 * keys; the join tables last. A relationship whose target model is missing is reported in `warnings`.
 */
export function collectEdges(
  schema: IrSchema,
  graph: Graph,
  warnings: string[]
): GraphEdge[] {
  const edges: GraphEdge[] = [];
  const written: Set<IrRelation> = new Set<IrRelation>();
  for (const node of graph.nodes) {
    for (const relation of node.model.relations) {
      const target: GraphNode | undefined = nodeOf(graph, relation.targetModel);
      if (relation.kind === 'manyToMany') {
        if (isMirror(schema, node.model, relation, written)) {
          continue;
        }
        written.add(relation);
        if (target === undefined) {
          missingTarget(
            warnings,
            node.model,
            relation.name,
            relation.targetModel
          );
          continue;
        }
        edges.push(manyToManyEdge(node, target, relation));
      } else if (target === undefined) {
        missingTarget(
          warnings,
          node.model,
          relation.name,
          relation.targetModel
        );
      } else {
        edges.push(foreignKeyEdge(node, target, relation));
      }
    }
    for (const key of node.model.compositeForeignKeys ?? []) {
      const target: GraphNode | undefined = nodeOf(graph, key.targetModel);
      if (target === undefined) {
        missingTarget(warnings, node.model, key.name, key.targetModel);
      } else {
        edges.push(compositeEdge(node, target, key));
      }
    }
  }
  for (const join of graph.joins) {
    const edge: GraphEdge | undefined = joinEdge(graph, join);
    if (edge !== undefined) {
      edges.push(edge);
    }
  }
  return edges;
}

/** The plural of a snake_case word. */
function pluralOf(snake: string): string {
  if (/[^aeiou]y$/.test(snake)) {
    return `${snake.slice(0, -1)}ies`;
  }
  if (/(s|x|z|ch|sh)$/.test(snake)) {
    return `${snake}es`;
  }
  return `${snake}s`;
}

/**
 * The name of the reverse accessor when the source gave none: the plural of the source label in
 * snake_case words (`Post` gives `posts`). A writer makes it unique among the names of the target.
 */
export function defaultReverseName(edge: GraphEdge): string {
  const words: string = toSnakeCase(edge.source.label);
  return pluralOf(words === '' ? 'node' : words);
}
