import type {
  IrCompositeForeignKey,
  IrField,
  IrIndex,
  IrModel,
  IrRelation,
  IrSchema,
} from '../ir.js';
import { findModel } from '../ir.js';
import {
  enumValuesOf,
  mapFieldType,
  type Neo4jType,
  type Neo4jTypeMapping,
} from './neo4jTypes.js';
import {
  labelOf,
  NameRegistry,
  oneLine,
  propertyKeyOf,
  relationshipTypeOf,
} from './neo4jNames.js';

/**
 * The graph model derived from the IR: one node per model, except pure join tables, which become a
 * single relationship. The statement and comment writers read this model and never the IR directly.
 */

/** A property of a node (or of a relationship, for the extra columns of a join table). */
export interface GraphProperty {
  /** The property key as written in Cypher (before quoting). */
  key: string;
  /** The IR field name, or the relation name for a foreign key column. */
  irName: string;
  type: Neo4jType;
  required: boolean;
  /** Short remarks shown in the property comment block, for example `primary key`. */
  notes: string[];
}

export interface GraphNode {
  model: IrModel;
  label: string;
  properties: GraphProperty[];
  /** IR field name, relation name and column name to property key. */
  keys: Map<string, string>;
  /** The foreign key properties (a subset of `properties`). */
  foreignKeys: GraphProperty[];
}

/** A join table written as one relationship. */
export interface GraphJoin {
  model: IrModel;
  from: IrRelation;
  to: IrRelation;
  type: string;
  /** The surrogate key column that was dropped, if the table had one. */
  surrogateKey?: IrField;
  /** Columns beyond the two foreign keys; they become relationship properties. */
  extras: GraphProperty[];
  /** Property keys of the two foreign keys on the join table, in `from`, `to` order. */
  pairColumns: [string, string];
  keys: Map<string, string>;
}

export interface Graph {
  nodes: GraphNode[];
  joins: GraphJoin[];
  byModel: Map<string, GraphNode>;
}

export interface GraphOptions {
  camelFields: boolean;
}

/** Everything the builder needs and reports. */
interface BuildContext {
  schema: IrSchema;
  options: GraphOptions;
  warnings: string[];
}

/** IR names (fields and relations) that make up the primary key of a model. */
export function primaryKeyNamesOf(model: IrModel): string[] {
  if (
    model.compositePrimaryKey !== undefined &&
    model.compositePrimaryKey.length > 0
  ) {
    return model.compositePrimaryKey;
  }
  return [
    ...model.fields
      .filter((field: IrField) => field.isPrimaryKey)
      .map((field: IrField) => field.name),
    ...model.relations
      .filter((relation: IrRelation) => relation.isPrimaryKey === true)
      .map((relation: IrRelation) => relation.name),
  ];
}

/** The field a foreign key points at: `toField`, or the single primary key field of the target. */
export function referencedField(
  schema: IrSchema,
  relation: IrRelation
): IrField | undefined {
  const target: IrModel | undefined = findModel(schema, relation.targetModel);
  if (target === undefined) {
    return undefined;
  }
  if (relation.toField !== undefined) {
    return target.fields.find(
      (field: IrField) =>
        field.name === relation.toField || field.columnName === relation.toField
    );
  }
  const keys: IrField[] = target.fields.filter(
    (field: IrField) => field.isPrimaryKey
  );
  return keys.length === 1 ? keys[0] : undefined;
}

function describeDefault(field: IrField): string | undefined {
  const value: IrField['default'] = field.default;
  if (value === undefined) {
    return undefined;
  }
  switch (value.kind) {
    case 'literal':
      return `the default ${JSON.stringify(value.value)}`;
    case 'autoIncrement':
      return undefined;
    case 'now':
      return 'the default of the current time';
    case 'uuid':
      return 'the default of a generated UUID';
    case 'enumValue':
      return `the default "${value.value}"`;
    case 'clientGenerated':
      return `the ${value.generator}() default`;
    case 'dbExpression':
      return `the database default ${oneLine(value.expression)}`;
  }
}

function fieldWarnings(
  context: BuildContext,
  model: IrModel,
  field: IrField,
  mapping: Neo4jTypeMapping
): void {
  const label: string = `${model.name}.${field.name}`;
  if (mapping.warning !== undefined) {
    context.warnings.push(`${label}: ${mapping.warning}`);
  }
  const defaultText: string | undefined = describeDefault(field);
  if (defaultText !== undefined) {
    context.warnings.push(
      `${label}: ${defaultText} has no Neo4j schema representation and was dropped; set the value when you create the node.`
    );
  }
  if (field.default?.kind === 'autoIncrement') {
    context.warnings.push(
      `${label}: auto-increment has no Neo4j equivalent; supply the value yourself (or use randomUUID() and a STRING key).`
    );
  }
  if (field.generated !== undefined) {
    context.warnings.push(
      `${label}: the generated column expression (${oneLine(field.generated.expression)}) is not computed by Neo4j; the property is a plain value.`
    );
  }
  if (field.isAutoUpdated) {
    context.warnings.push(
      `${label}: the value is refreshed on every save in the source; Neo4j has no such feature, so set it in your queries.`
    );
  }
}

function fieldProperty(
  context: BuildContext,
  model: IrModel,
  field: IrField
): GraphProperty {
  const mapping: Neo4jTypeMapping = mapFieldType(field);
  fieldWarnings(context, model, field, mapping);
  const notes: string[] = [];
  if (field.isPrimaryKey) {
    notes.push('primary key');
  } else if (field.isUnique) {
    notes.push('unique');
  }
  const values: string[] = enumValuesOf(field, context.schema.enums);
  if (values.length > 0) {
    notes.push(
      `one of: ${values.map((value: string) => `"${oneLine(value)}"`).join(', ')}`
    );
  }
  if (field.type === 'decimal' && field.maxDigits !== undefined) {
    notes.push(
      `decimal with ${field.maxDigits} digits${
        field.decimalPlaces === undefined
          ? ''
          : `, ${field.decimalPlaces} after the point`
      }`
    );
  }
  return {
    key: propertyKeyOf(field.columnName, context.options.camelFields),
    irName: field.name,
    type: mapping.type,
    required: !field.isNullable,
    notes,
  };
}

/** Maps a foreign key to a property typed like the column it references. */
function foreignKeyProperty(
  context: BuildContext,
  relation: IrRelation,
  targetKey: string | undefined
): GraphProperty {
  const referenced: IrField | undefined = referencedField(
    context.schema,
    relation
  );
  const type: Neo4jType =
    referenced === undefined
      ? { name: 'INTEGER', constrainable: true }
      : mapFieldType({ ...referenced, arrayDepth: undefined }).type;
  const notes: string[] = [
    `foreign key to ${relation.targetModel}${targetKey === undefined ? '' : `.${targetKey}`}`,
  ];
  if (relation.isPrimaryKey === true) {
    notes.unshift('primary key');
  }
  return {
    key: propertyKeyOf(relation.columnName, context.options.camelFields),
    irName: relation.name,
    type,
    required: !relation.isNullable,
    notes,
  };
}

function targetKeyName(
  context: BuildContext,
  relation: IrRelation
): string | undefined {
  const referenced: IrField | undefined = referencedField(
    context.schema,
    relation
  );
  return referenced === undefined
    ? undefined
    : propertyKeyOf(referenced.columnName, context.options.camelFields);
}

/** Properties of a model: its columns, then one property per foreign key column. */
function buildProperties(
  context: BuildContext,
  model: IrModel
): {
  properties: GraphProperty[];
  keys: Map<string, string>;
  foreignKeys: GraphProperty[];
} {
  const properties: GraphProperty[] = [];
  const keys: Map<string, string> = new Map<string, string>();
  const foreignKeys: GraphProperty[] = [];
  const taken: Set<string> = new Set<string>();
  for (const field of model.fields) {
    const property: GraphProperty = fieldProperty(context, model, field);
    keys.set(field.name, property.key);
    keys.set(field.columnName, property.key);
    if (!taken.has(property.key)) {
      taken.add(property.key);
      properties.push(property);
    }
  }
  for (const relation of model.relations) {
    if (relation.kind === 'manyToMany') {
      continue;
    }
    const property: GraphProperty = foreignKeyProperty(
      context,
      relation,
      targetKeyName(context, relation)
    );
    keys.set(relation.name, property.key);
    keys.set(relation.columnName, property.key);
    if (!taken.has(property.key)) {
      taken.add(property.key);
      properties.push(property);
      foreignKeys.push(property);
    }
  }
  return { properties, keys, foreignKeys };
}

function maxLengthWarning(model: IrModel): string | undefined {
  const names: string[] = model.fields
    .filter((field: IrField) => field.maxLength !== undefined)
    .map((field: IrField) => field.name);
  return names.length === 0
    ? undefined
    : `${model.name}: the maximum length of ${names.join(', ')} has no Neo4j schema representation and was dropped.`;
}

function referencedElsewhere(schema: IrSchema, model: IrModel): boolean {
  return schema.models.some(
    (other: IrModel) =>
      other.relations.some(
        (relation: IrRelation) => relation.targetModel === model.name
      ) ||
      (other.compositeForeignKeys ?? []).some(
        (key: IrCompositeForeignKey) => key.targetModel === model.name
      )
  );
}

function relationMatches(relation: IrRelation, name: string): boolean {
  return relation.name === name || relation.columnName === name;
}

function hasUniquePair(model: IrModel, a: IrRelation, b: IrRelation): boolean {
  return model.indexes.some(
    (index: IrIndex) =>
      index.isUnique &&
      index.kind === undefined &&
      index.fields.length === 2 &&
      index.fields.some((name: string) => relationMatches(a, name)) &&
      index.fields.some((name: string) => relationMatches(b, name))
  );
}

interface JoinCandidate {
  model: IrModel;
  from: IrRelation;
  to: IrRelation;
  surrogateKey?: IrField;
}

/**
 * A pure join table has exactly two required foreign keys, nothing else refers to it, and either the
 * two keys together are its primary key or a surrogate key column is paired with a unique pair of
 * the two keys (the table Django and Prisma write for a many-to-many field).
 */
function joinCandidate(
  schema: IrSchema,
  model: IrModel
): JoinCandidate | undefined {
  if (
    model.isView === true ||
    (model.compositeForeignKeys ?? []).length > 0 ||
    model.relations.length !== 2 ||
    referencedElsewhere(schema, model)
  ) {
    return undefined;
  }
  const [from, to]: (IrRelation | undefined)[] = model.relations;
  if (
    from === undefined ||
    to === undefined ||
    from.kind !== 'foreignKey' ||
    to.kind !== 'foreignKey' ||
    from.isNullable ||
    to.isNullable
  ) {
    return undefined;
  }
  const keyNames: string[] = primaryKeyNamesOf(model);
  const keyIsPair: boolean =
    keyNames.length === 2 &&
    keyNames.every(
      (name: string) => relationMatches(from, name) || relationMatches(to, name)
    );
  if (keyIsPair) {
    return { model, from, to };
  }
  const surrogate: IrField | undefined =
    keyNames.length === 1
      ? model.fields.find((field: IrField) => field.name === keyNames[0])
      : undefined;
  if (
    surrogate !== undefined &&
    (model.isJoinTable === true || hasUniquePair(model, from, to))
  ) {
    return { model, from, to, surrogateKey: surrogate };
  }
  return undefined;
}

function joinType(join: JoinCandidate): string {
  return relationshipTypeOf(join.from.relatedName ?? join.to.name);
}

/**
 * Derives the graph model. Warnings for dropped or approximated details are added to `warnings`
 * in model order.
 */
export function buildGraph(
  schema: IrSchema,
  options: GraphOptions,
  warnings: string[]
): Graph {
  const context: BuildContext = { schema, options, warnings };
  const candidates: Map<string, JoinCandidate> = new Map<
    string,
    JoinCandidate
  >();
  for (const model of schema.models) {
    const candidate: JoinCandidate | undefined = joinCandidate(schema, model);
    if (candidate !== undefined) {
      candidates.set(model.name, candidate);
    }
  }
  // A join table that points at another join table stays an ordinary node, so both ends exist.
  for (const [name, candidate] of [...candidates]) {
    if (
      candidates.has(candidate.from.targetModel) ||
      candidates.has(candidate.to.targetModel) ||
      findModel(schema, candidate.from.targetModel) === undefined ||
      findModel(schema, candidate.to.targetModel) === undefined
    ) {
      candidates.delete(name);
    }
  }

  const labels: NameRegistry = new NameRegistry();
  const nodes: GraphNode[] = [];
  const joins: GraphJoin[] = [];
  const byModel: Map<string, GraphNode> = new Map<string, GraphNode>();
  for (const model of schema.models) {
    const candidate: JoinCandidate | undefined = candidates.get(model.name);
    if (candidate !== undefined) {
      continue;
    }
    const wanted: string = labelOf(model.name);
    const label: string = labels.claim(wanted);
    if (label !== wanted) {
      warnings.push(
        `${model.name}: the label ${wanted} is already used by another model; this model uses ${label}.`
      );
    }
    const built = buildProperties(context, model);
    const node: GraphNode = {
      model,
      label,
      properties: built.properties,
      keys: built.keys,
      foreignKeys: built.foreignKeys,
    };
    nodes.push(node);
    byModel.set(model.name, node);
    const lengths: string | undefined = maxLengthWarning(model);
    if (lengths !== undefined) {
      warnings.push(lengths);
    }
  }
  for (const model of schema.models) {
    const candidate: JoinCandidate | undefined = candidates.get(model.name);
    if (candidate === undefined) {
      continue;
    }
    joins.push(buildJoin(context, candidate));
  }
  return { nodes, joins, byModel };
}

function buildJoin(context: BuildContext, candidate: JoinCandidate): GraphJoin {
  const { model, from, to, surrogateKey } = candidate;
  const extras: GraphProperty[] = model.fields
    .filter((field: IrField) => field !== surrogateKey)
    .map((field: IrField) => fieldProperty(context, model, field));
  const keys: Map<string, string> = new Map<string, string>();
  for (const field of model.fields) {
    keys.set(
      field.name,
      propertyKeyOf(field.columnName, context.options.camelFields)
    );
  }
  if (surrogateKey !== undefined) {
    context.warnings.push(
      `${model.name}: the join table became a relationship, so its surrogate key ${surrogateKey.name} was dropped.`
    );
  }
  const lengths: string | undefined = maxLengthWarning(model);
  if (lengths !== undefined) {
    context.warnings.push(lengths);
  }
  const pairColumns: [string, string] = [
    propertyKeyOf(from.columnName, context.options.camelFields),
    propertyKeyOf(to.columnName, context.options.camelFields),
  ];
  keys.set(from.name, pairColumns[0]);
  keys.set(from.columnName, pairColumns[0]);
  keys.set(to.name, pairColumns[1]);
  keys.set(to.columnName, pairColumns[1]);
  return {
    model,
    from,
    to,
    type: joinType(candidate),
    ...(surrogateKey === undefined ? {} : { surrogateKey }),
    extras,
    pairColumns,
    keys,
  };
}
