import type {
  IrCompositeForeignKey,
  IrField,
  IrModel,
  IrOnDelete,
  IrRelation,
  IrSchema,
} from '../ir.js';
import { findModel } from '../ir.js';
import {
  referencedField,
  type Graph,
  type GraphJoin,
  type GraphNode,
  type GraphProperty,
} from './neo4jGraph.js';
import { quoteIdentifier, relationshipTypeOf } from './neo4jNames.js';
import { relationshipTarget, type StatementWriter } from './neo4jStatements.js';

/**
 * Writes the relationship section. Cypher has no relationship schema, so each foreign key, relation
 * and join table becomes a comment block that names the pattern, the cardinality, the referential
 * action and a query that creates the relationships from the foreign key properties. Only a join
 * table with unique columns gets real statements (relationship property constraints).
 */

export interface RelationshipSection {
  /** Comment lines and statements, one entry per line, blank lines included. */
  lines: string[];
}

function pattern(source: string, type: string, target: string): string {
  return `(:${quoteIdentifier(source)})-[:${quoteIdentifier(type)}]->(:${quoteIdentifier(target)})`;
}

function propertyReference(variable: string, key: string): string {
  return `${variable}.${quoteIdentifier(key)}`;
}

function onDeleteText(
  action: IrOnDelete,
  source: string,
  target: string,
  key: string
): string {
  switch (action) {
    case 'cascade':
      return `cascade (delete the ${source} when its ${target} is deleted)`;
    case 'setNull':
      return `set null (set ${key} to null when the ${target} is deleted)`;
    case 'setDefault':
      return `set default (reset ${key} when the ${target} is deleted)`;
    case 'restrict':
    case 'noAction':
      return `${action === 'restrict' ? 'restrict' : 'no action'} (do not delete a ${target} that still has ${source} nodes)`;
  }
}

function comment(lines: string[]): string[] {
  return lines.map((line: string) => (line === '' ? '//' : `// ${line}`));
}

/** The key property of the node a relation points at, or undefined for a composite or unknown key. */
function targetKey(
  schema: IrSchema,
  graph: Graph,
  relation: IrRelation
): string | undefined {
  const referenced: IrField | undefined = referencedField(schema, relation);
  const node: GraphNode | undefined = graph.byModel.get(relation.targetModel);
  return referenced === undefined || node === undefined
    ? undefined
    : node.keys.get(referenced.name);
}

function foreignKeyBlock(
  schema: IrSchema,
  graph: Graph,
  node: GraphNode,
  relation: IrRelation,
  warnings: string[]
): string[] {
  const target: GraphNode | undefined = graph.byModel.get(relation.targetModel);
  if (target === undefined) {
    warnings.push(
      `${node.model.name}.${relation.name}: the target model ${relation.targetModel} is not in the schema, so the relationship was not documented.`
    );
    return [];
  }
  const type: string = relationshipTypeOf(relation.name);
  const key: string = node.keys.get(relation.name) ?? relation.columnName;
  const referencedKey: string | undefined = targetKey(schema, graph, relation);
  const cardinality: string =
    relation.kind === 'oneToOne'
      ? `one ${node.label} to one ${target.label}`
      : `many ${node.label} to one ${target.label}`;
  const lines: string[] = [
    pattern(node.label, type, target.label),
    `  ${cardinality}, ${relation.isNullable ? 'optional' : 'required'}.`,
    `  foreign key property: ${node.label}.${key}${referencedKey === undefined ? '' : ` references ${target.label}.${referencedKey}`}`,
    `  on delete: ${onDeleteText(relation.onDelete, node.label, target.label, key)}; Neo4j does not enforce it.`,
  ];
  if (relation.onUpdate !== undefined) {
    lines.push(`  on update: ${relation.onUpdate}; Neo4j does not enforce it.`);
  }
  if (relation.relatedName !== undefined) {
    lines.push(
      `  reverse accessor in the source: ${target.label}.${relation.relatedName}`
    );
  }
  if (referencedKey !== undefined) {
    lines.push(
      `  create: MATCH (s:${quoteIdentifier(node.label)}), (t:${quoteIdentifier(target.label)}) WHERE ${propertyReference('s', key)} = ${propertyReference('t', referencedKey)} MERGE (s)-[:${quoteIdentifier(type)}]->(t);`
    );
  }
  warnings.push(
    `${node.model.name}.${relation.name}: Neo4j keeps no relationship schema, so the foreign key to ${relation.targetModel} (on delete ${relation.onDelete}) is only documented in a comment; the ${key} property was kept.`
  );
  return comment(lines);
}

function compositeKeyBlock(
  graph: Graph,
  node: GraphNode,
  key: IrCompositeForeignKey,
  warnings: string[]
): string[] {
  const target: GraphNode | undefined = graph.byModel.get(key.targetModel);
  if (target === undefined) {
    warnings.push(
      `${node.model.name}.${key.name}: the target model ${key.targetModel} is not in the schema, so the relationship was not documented.`
    );
    return [];
  }
  const local: string[] = key.fields.map(
    (name: string) => node.keys.get(name) ?? name
  );
  const remote: string[] = key.references.map(
    (name: string) => target.keys.get(name) ?? name
  );
  const type: string = relationshipTypeOf(key.name);
  const where: string = local
    .map(
      (name: string, position: number) =>
        `${propertyReference('s', name)} = ${propertyReference('t', remote[position] ?? '')}`
    )
    .join(' AND ');
  const lines: string[] = [
    pattern(node.label, type, target.label),
    `  ${key.kind === 'oneToOne' ? 'one' : 'many'} ${node.label} to one ${target.label}, ${key.isNullable ? 'optional' : 'required'}.`,
    `  foreign key properties: ${local.map((name: string) => `${node.label}.${name}`).join(', ')} reference ${remote.map((name: string) => `${target.label}.${name}`).join(', ')}`,
    `  on delete: ${onDeleteText(key.onDelete, node.label, target.label, local.join(', '))}; Neo4j does not enforce it.`,
    `  create: MATCH (s:${quoteIdentifier(node.label)}), (t:${quoteIdentifier(target.label)}) WHERE ${where} MERGE (s)-[:${quoteIdentifier(type)}]->(t);`,
  ];
  warnings.push(
    `${node.model.name}.${key.name}: Neo4j keeps no relationship schema, so the composite foreign key to ${key.targetModel} is only documented in a comment; its properties were kept.`
  );
  return comment(lines);
}

/** True when `relation` is the same many-to-many pair as one already written from the other model. */
function isMirror(
  schema: IrSchema,
  model: IrModel,
  relation: IrRelation,
  written: Set<IrRelation>
): boolean {
  const target: IrModel | undefined = findModel(schema, relation.targetModel);
  if (target === undefined || relation.relatedName === undefined) {
    return false;
  }
  return target.relations.some(
    (other: IrRelation) =>
      written.has(other) &&
      other.kind === 'manyToMany' &&
      other.targetModel === model.name &&
      other.name === relation.relatedName
  );
}

function manyToManyBlock(
  node: GraphNode,
  graph: Graph,
  relation: IrRelation,
  warnings: string[]
): string[] {
  const target: GraphNode | undefined = graph.byModel.get(relation.targetModel);
  if (target === undefined) {
    warnings.push(
      `${node.model.name}.${relation.name}: the target model ${relation.targetModel} is not in the schema, so the relationship was not documented.`
    );
    return [];
  }
  const type: string = relationshipTypeOf(relation.name);
  const lines: string[] = [
    pattern(node.label, type, target.label),
    `  many ${node.label} to many ${target.label}.`,
    '  The source keeps a join table for this pair; in Neo4j the relationship itself replaces it.',
  ];
  if (relation.relatedName !== undefined) {
    lines.push(
      `  reverse accessor in the source: ${target.label}.${relation.relatedName}`
    );
  }
  lines.push(
    `  create: MERGE (s)-[:${quoteIdentifier(type)}]->(t) for each pair of ${node.label} (s) and ${target.label} (t) nodes you want to connect.`
  );
  warnings.push(
    `${node.model.name}.${relation.name}: the many-to-many relation to ${relation.targetModel} is documented as the relationship ${pattern(node.label, type, target.label)}; no join node is created.`
  );
  return comment(lines);
}

function describeProperty(property: GraphProperty): string {
  return `${property.key} ${property.type.name} (${property.required ? 'required' : 'optional'})`;
}

function joinBlock(
  schema: IrSchema,
  graph: Graph,
  join: GraphJoin,
  writer: StatementWriter,
  warnings: string[]
): string[] {
  const source: GraphNode | undefined = graph.byModel.get(
    join.from.targetModel
  );
  const target: GraphNode | undefined = graph.byModel.get(join.to.targetModel);
  if (source === undefined || target === undefined) {
    return [];
  }
  const model: IrModel = join.model;
  const lines: string[] = [
    pattern(source.label, join.type, target.label),
    `  many ${source.label} to many ${target.label}, from the join table ${model.tableName} (model ${model.name}).`,
  ];
  if (join.extras.length > 0) {
    lines.push(
      `  relationship properties: ${join.extras.map(describeProperty).join(', ')}`
    );
  }
  lines.push(
    `  the pair (${join.pairColumns.join(', ')}) identifies a relationship; Neo4j cannot enforce that for relationships, so create them with MERGE.`
  );
  const fromKey: string | undefined = targetKey(schema, graph, join.from);
  const toKey: string | undefined = targetKey(schema, graph, join.to);
  if (fromKey !== undefined && toKey !== undefined) {
    const assignments: string =
      join.extras.length === 0
        ? ''
        : ` SET ${join.extras.map((property: GraphProperty) => `${propertyReference('r', property.key)} = ${propertyReference('row', property.key)}`).join(', ')}`;
    lines.push(
      `  create (for each row of the join table, for example UNWIND $rows AS row): MATCH (s:${quoteIdentifier(source.label)} {${quoteIdentifier(fromKey)}: ${propertyReference('row', join.pairColumns[0])}}), (t:${quoteIdentifier(target.label)} {${quoteIdentifier(toKey)}: ${propertyReference('row', join.pairColumns[1])}}) MERGE (s)-[r:${quoteIdentifier(join.type)}]->(t)${assignments};`
    );
  }
  warnings.push(
    `${model.name}: the join table is documented as the relationship ${pattern(source.label, join.type, target.label)} instead of a node label.`
  );
  return [...comment(lines), ...joinStatements(join, writer, warnings)];
}

/**
 * Relationship property constraints, written only for a join table that has unique columns:
 * uniqueness for each unique extra column or unique index, and (Enterprise) existence for the
 * required extra columns. Other indexes of the join table have no relationship counterpart here.
 */
function joinStatements(
  join: GraphJoin,
  writer: StatementWriter,
  warnings: string[]
): string[] {
  const target = relationshipTarget(join.type);
  const model: IrModel = join.model;
  const uniqueKeys: string[][] = [];
  for (const field of model.fields) {
    const property: GraphProperty | undefined = join.extras.find(
      (extra: GraphProperty) => extra.irName === field.name
    );
    if (property !== undefined && field.isUnique) {
      uniqueKeys.push([property.key]);
    }
  }
  const pairNames: Set<string> = new Set<string>([
    join.from.name,
    join.from.columnName,
    join.to.name,
    join.to.columnName,
  ]);
  for (const index of model.indexes) {
    if (index.fields.every((name: string) => pairNames.has(name))) {
      continue;
    }
    const keys: string[] = index.fields.map(
      (name: string) => join.keys.get(name) ?? name
    );
    const known: boolean = index.fields.every((name: string) =>
      join.extras.some((extra: GraphProperty) => extra.irName === name)
    );
    if (index.isUnique && index.kind === undefined && known) {
      uniqueKeys.push(keys);
    } else {
      warnings.push(
        `${model.name} index (${index.fields.join(', ')}): the join table became a relationship, so this index was dropped.`
      );
    }
  }
  if (uniqueKeys.length === 0) {
    return [];
  }
  const statements: string[] = [];
  for (const keys of uniqueKeys) {
    const statement: string | undefined = writer.unique(target, keys);
    if (statement !== undefined) {
      statements.push(statement);
    }
  }
  if (writer.style === 'enterprise') {
    for (const property of join.extras) {
      if (!property.required) {
        continue;
      }
      const statement: string | undefined = writer.required(
        target,
        property.key
      );
      if (statement !== undefined) {
        statements.push(statement);
      }
    }
  }
  return statements;
}

/** Writes every relationship block, then the join table constraint statements that follow their block. */
export function writeRelationships(
  schema: IrSchema,
  graph: Graph,
  writer: StatementWriter,
  warnings: string[]
): RelationshipSection {
  const blocks: string[][] = [];
  const written: Set<IrRelation> = new Set<IrRelation>();
  for (const node of graph.nodes) {
    for (const relation of node.model.relations) {
      if (relation.kind === 'manyToMany') {
        if (isMirror(schema, node.model, relation, written)) {
          continue;
        }
        written.add(relation);
        blocks.push(manyToManyBlock(node, graph, relation, warnings));
      } else {
        blocks.push(foreignKeyBlock(schema, graph, node, relation, warnings));
      }
    }
    for (const key of node.model.compositeForeignKeys ?? []) {
      blocks.push(compositeKeyBlock(graph, node, key, warnings));
    }
  }
  for (const join of graph.joins) {
    blocks.push(joinBlock(schema, graph, join, writer, warnings));
  }
  const filled: string[][] = blocks.filter(
    (block: string[]) => block.length > 0
  );
  if (filled.length === 0) {
    return { lines: [] };
  }
  const lines: string[] = [];
  filled.forEach((block: string[], position: number): void => {
    if (position > 0) {
      lines.push('');
    }
    lines.push(...block);
  });
  return { lines };
}
