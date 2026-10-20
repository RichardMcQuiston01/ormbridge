import type { IrField, IrIndex, IrModel, IrSchema } from '../ir.js';
import {
  collectEdges,
  defaultReverseName,
  type EdgeCardinality,
  type GraphEdge,
} from './neo4jEdges.js';
import {
  buildGraph,
  primaryKeyNamesOf,
  type Graph,
  type GraphJoin,
  type GraphNode,
  type GraphProperty,
} from './neo4jGraph.js';
import { labelOf, oneLine } from './neo4jNames.js';
import {
  attributeNameOf,
  classNameOf,
  isPythonIdentifier,
  pyString,
  RESERVED_TYPES,
  uniqueAttribute,
  uniqueClassName,
} from './neomodelNames.js';
import {
  callText,
  ModuleImports,
  planProperty,
  type PropertyCall,
  type PropertyContext,
  type PropertyRole,
} from './neomodelProperties.js';
import type { EmitOutput } from './prisma.js';

/**
 * neomodel writer (Python, the object-graph mapper for Neo4j).
 *
 * Writes ONE module. Each node label is a `StructuredNode` class whose columns are neomodel properties
 * (`StringProperty`, `IntegerProperty`, ..., `ArrayProperty`, `JSONProperty`), with `required`,
 * `unique_index`, `index`, `choices` and `default` where neomodel can say them. Every foreign key, one-to-one
 * key, many-to-many relation and pure join table is a `RelationshipTo` on the class that owns it and a
 * `RelationshipFrom` on the target, with a cardinality class, and the extra columns of a join table are a
 * `StructuredRel` class. Labels and relationship types are the ones the Cypher writer uses, so the three
 * Neo4j outputs agree. Foreign key columns stay as plain properties, as they do in the Cypher output.
 */

export interface NeomodelEmitOptions {
  /** Use camelCase graph property keys (the `normalize` naming mode); otherwise the column names are kept. */
  camelFields: boolean;
  /** Write the comment block at the top of the module (default true). */
  header?: boolean;
}

const INDENT: string = '    ';
const MAX_LINE_WIDTH: number = 88;

const CARDINALITY_CLASS: Readonly<Record<EdgeCardinality, string>> = {
  one: 'One',
  zeroOrOne: 'ZeroOrOne',
  zeroOrMore: 'ZeroOrMore',
  oneOrMore: 'OneOrMore',
};

export function emitNeomodel(
  schema: IrSchema,
  options: NeomodelEmitOptions
): EmitOutput {
  const warnings: string[] = schemaWarnings(schema);
  if (schema.models.length === 0) {
    return { text: '', warnings };
  }
  const graph: Graph = buildGraph(
    schema,
    {
      camelFields: options.camelFields,
      omitWarnings: { defaults: true, autoIncrement: true, maxLength: true },
    },
    warnings
  );
  const edges: GraphEdge[] = collectEdges(schema, graph, warnings);
  const imports: ModuleImports = new ModuleImports();
  const context: PropertyContext = {
    schema,
    imports,
    warnings,
  };

  const classNames: Set<string> = new Set<string>(RESERVED_TYPES);
  const nodes: NodePlan[] = graph.nodes.map((node: GraphNode): NodePlan =>
    planNode(node, classNames, warnings)
  );
  const byLabel: Map<string, NodePlan> = new Map<string, NodePlan>(
    nodes.map((plan: NodePlan): [string, NodePlan] => [plan.node.label, plan])
  );
  for (const plan of nodes) {
    addProperties(context, plan);
  }
  const relationClasses: RelationPlan[] = [];
  for (const edge of edges) {
    addEdge(context, edge, byLabel, classNames, relationClasses);
  }

  const blocks: string[] = [
    ...relationClasses.map((plan: RelationPlan) => plan.text),
    ...nodes.map(renderNode),
  ];
  const sections: string[] = [];
  if (options.header !== false) {
    sections.push(headerLines().join('\n'));
  }
  sections.push(importLines(imports).join('\n'));
  const body: string = blocks.join('\n\n\n');
  return {
    text: `${sections.join('\n\n')}\n\n\n${body}\n`,
    warnings: [...new Set(warnings)],
  };
}

// ---------------------------------------------------------------------------
// Warnings for constructs neomodel has no place for
// ---------------------------------------------------------------------------

function schemaWarnings(schema: IrSchema): string[] {
  const warnings: string[] = [];
  for (const enumDefinition of schema.enums) {
    if (enumDefinition.schema !== undefined) {
      warnings.push(
        `enum ${enumDefinition.name}: the database schema "${enumDefinition.schema}" (@@schema) was ignored.`
      );
    }
  }
  for (const model of schema.models) {
    if (model.isView === true) {
      warnings.push(
        `${model.name}: this is a database view; it was written as a node class like any other model.`
      );
    }
    if (model.schema !== undefined) {
      warnings.push(
        `${model.name}: the database schema "${model.schema}" (@@schema) was ignored.`
      );
    }
  }
  return warnings;
}

// ---------------------------------------------------------------------------
// Classes
// ---------------------------------------------------------------------------

interface NodePlan {
  node: GraphNode;
  className: string;
  /** True when the class name differs from the label, so `__label__` is written. */
  needsLabel: boolean;
  /** Attribute names taken in the class, properties and relationships. */
  used: Set<string>;
  /** Attribute name by property key. */
  attributes: Map<string, string>;
  /** Property lines, then relationship lines. */
  members: string[];
}

interface RelationPlan {
  text: string;
}

function planNode(
  node: GraphNode,
  classNames: Set<string>,
  warnings: string[]
): NodePlan {
  const wanted: string = classNameOf(node.label);
  const safe: string = RESERVED_TYPES.has(wanted) ? `${wanted}Node` : wanted;
  const className: string = uniqueClassName(safe, classNames);
  if (className !== node.label) {
    warnings.push(
      `${node.model.name}: the class is named ${className} because ${
        isPythonIdentifier(node.label)
          ? `${node.label} is a name the module uses or another class has`
          : `${node.label} is not a Python class name`
      }; the label ${node.label} is kept with __label__.`
    );
  }
  return {
    node,
    className,
    needsLabel: className !== node.label,
    used: new Set<string>(),
    attributes: new Map<string, string>(),
    members: [],
  };
}

/** The attribute for a graph property or relationship name, with a warning when it had to change. */
function claimAttribute(
  raw: string,
  used: Set<string>,
  where: string,
  warnings: string[],
  stored: string
): string {
  const wanted: string = attributeNameOf(raw);
  const name: string = uniqueAttribute(wanted, used);
  if (name !== wanted) {
    warnings.push(
      `${where}: "${wanted}" is taken, so the attribute was named "${name}" (stored as ${stored}).`
    );
  }
  return name;
}

// ---------------------------------------------------------------------------
// Indexes and constraints
// ---------------------------------------------------------------------------

interface Roles {
  unique: Set<string>;
  index: Set<string>;
  fulltext: Set<string>;
}

function resolveKeys(node: GraphNode, names: string[]): string[] | undefined {
  const keys: string[] = [];
  for (const name of names) {
    const key: string | undefined = node.keys.get(name);
    if (key === undefined) {
      return undefined;
    }
    keys.push(key);
  }
  return keys;
}

/** Decides which properties are unique, indexed or full-text indexed, as the Cypher writer does. */
function nodeRoles(node: GraphNode, warnings: string[]): Roles {
  const roles: Roles = {
    unique: new Set<string>(),
    index: new Set<string>(),
    fulltext: new Set<string>(),
  };
  const model: IrModel = node.model;
  const keyNames: string[] = primaryKeyNamesOf(model);
  const keys: string[] | undefined = resolveKeys(node, keyNames);
  if (keyNames.length > 0 && keys === undefined) {
    warnings.push(
      `${model.name}: the primary key (${keyNames.join(', ')}) names a column that does not exist, so it was dropped.`
    );
  } else if (keys !== undefined && keys.length === 1) {
    roles.unique.add(keys[0] ?? '');
  } else if (keys !== undefined && keys.length > 1) {
    warnings.push(
      `${model.name}: neomodel has no composite constraint, so the composite primary key (${keys.join(', ')}) was written as an index on each property.`
    );
    keys.forEach((key: string) => roles.index.add(key));
  }
  for (const field of model.fields) {
    const key: string | undefined = node.keys.get(field.name);
    if (field.isUnique && key !== undefined) {
      roles.unique.add(key);
    }
  }
  for (const relation of model.relations) {
    const key: string | undefined = node.keys.get(relation.name);
    if (relation.kind === 'oneToOne' && key !== undefined) {
      roles.unique.add(key);
    }
  }
  for (const index of model.indexes) {
    planIndex(node, index, roles, warnings);
  }
  return roles;
}

function planIndex(
  node: GraphNode,
  index: IrIndex,
  roles: Roles,
  warnings: string[]
): void {
  const label: string = `${node.model.name} index (${index.fields.join(', ')})`;
  const keys: string[] | undefined = resolveKeys(node, index.fields);
  if (keys === undefined || keys.length === 0) {
    warnings.push(
      `${label}: it names a column that does not exist and was dropped.`
    );
    return;
  }
  if (index.method !== undefined && index.method.toLowerCase() !== 'btree') {
    warnings.push(
      `${label}: Neo4j has no ${index.method} index method; the index was dropped.`
    );
    return;
  }
  if (
    index.clustered !== undefined ||
    (index.fieldOptions !== undefined &&
      Object.keys(index.fieldOptions).length > 0)
  ) {
    warnings.push(
      `${label}: clustering, sort order, prefix length and operator class options have no Neo4j equivalent and were dropped.`
    );
  }
  const single: boolean = keys.length === 1;
  if (index.kind === 'fulltext') {
    if (!single) {
      warnings.push(
        `${label}: a neomodel full-text index covers one property, so each property got its own.`
      );
    }
    keys.forEach((key: string) => roles.fulltext.add(key));
  } else if (index.isUnique) {
    if (!single) {
      warnings.push(
        `${label}: neomodel has no composite uniqueness constraint, so each property was written as an index.`
      );
      keys.forEach((key: string) => roles.index.add(key));
    } else {
      roles.unique.add(keys[0] ?? '');
    }
  } else {
    if (!single) {
      warnings.push(
        `${label}: neomodel has no composite index, so each property got its own index.`
      );
    }
    keys.forEach((key: string) => roles.index.add(key));
  }
}

function roleOf(roles: Roles, key: string): PropertyRole {
  const unique: boolean = roles.unique.has(key);
  return {
    unique,
    index: !unique && roles.index.has(key),
    fulltext: roles.fulltext.has(key),
  };
}

// ---------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------

/** True when the node has one UUID key that neomodel can generate (the source generates it too). */
function generatedUuidKey(node: GraphNode): string | undefined {
  const keyNames: string[] = primaryKeyNamesOf(node.model);
  if (keyNames.length !== 1) {
    return undefined;
  }
  const field: IrField | undefined = node.model.fields.find(
    (candidate: IrField) => candidate.name === keyNames[0]
  );
  return field !== undefined &&
    field.type === 'uuid' &&
    field.arrayDepth === undefined &&
    field.default?.kind === 'uuid'
    ? node.keys.get(field.name)
    : undefined;
}

/** Lays out `name = Class(args)`, one argument per line when it does not fit in 88 columns. */
function assignment(name: string, call: PropertyCall, level: number): string[] {
  const pad: string = INDENT.repeat(level);
  const flat: string = `${pad}${name} = ${callText(call)}`;
  if (flat.length <= MAX_LINE_WIDTH || call.args.length === 0) {
    return [flat];
  }
  return [
    `${pad}${name} = ${call.className}(`,
    ...call.args.map((arg: string) => `${pad}${INDENT}${arg},`),
    `${pad})`,
  ];
}

function addProperties(context: PropertyContext, plan: NodePlan): void {
  const node: GraphNode = plan.node;
  const roles: Roles = nodeRoles(node, context.warnings);
  const uuidKey: string | undefined = generatedUuidKey(node);
  for (const property of node.properties) {
    const attribute: string = claimAttribute(
      property.key,
      plan.used,
      `${node.model.name}.${property.irName}`,
      context.warnings,
      pyString(property.key)
    );
    plan.attributes.set(property.key, attribute);
    const field: IrField | undefined = node.model.fields.find(
      (candidate: IrField) =>
        candidate.name === property.irName &&
        node.keys.get(candidate.name) === property.key
    );
    const call: PropertyCall = planProperty(context, {
      label: `${node.model.name}.${property.irName}`,
      property,
      field,
      role: roleOf(roles, property.key),
      attribute,
      uniqueId: uuidKey === property.key,
    });
    plan.members.push(...assignment(attribute, call, 1));
  }
}

// ---------------------------------------------------------------------------
// Relationships
// ---------------------------------------------------------------------------

function pattern(edge: GraphEdge): string {
  return `(:${edge.source.label})-[:${edge.type}]->(:${edge.target.label})`;
}

/** The unique and indexed extra columns of a join table, as the Cypher writer finds them. */
function joinRoles(join: GraphJoin, warnings: string[]): Roles {
  const roles: Roles = {
    unique: new Set<string>(),
    index: new Set<string>(),
    fulltext: new Set<string>(),
  };
  const model: IrModel = join.model;
  for (const field of model.fields) {
    const property: GraphProperty | undefined = join.extras.find(
      (extra: GraphProperty) => extra.irName === field.name
    );
    if (property !== undefined && field.isUnique) {
      roles.unique.add(property.key);
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
    const known: boolean = index.fields.every((name: string) =>
      join.extras.some((extra: GraphProperty) => extra.irName === name)
    );
    const keys: string[] = index.fields.map(
      (name: string) => join.keys.get(name) ?? name
    );
    if (
      index.isUnique &&
      index.kind === undefined &&
      known &&
      keys.length === 1
    ) {
      roles.unique.add(keys[0] ?? '');
    } else {
      warnings.push(
        `${model.name} index (${index.fields.join(', ')}): the join table became a relationship, so this index was dropped.`
      );
    }
  }
  return roles;
}

function relationClassFor(
  context: PropertyContext,
  join: GraphJoin,
  classNames: Set<string>,
  relationClasses: RelationPlan[]
): string | undefined {
  if (join.extras.length === 0) {
    return undefined;
  }
  const className: string = uniqueClassName(
    `${classNameOf(labelOf(join.model.name))}Rel`,
    classNames
  );
  const used: Set<string> = new Set<string>();
  const roles: Roles = joinRoles(join, context.warnings);
  const lines: string[] = [
    `class ${className}(${context.imports.use('StructuredRel')}):`,
    `${INDENT}"""Properties of the ${oneLine(join.model.name).replace(/["\\]/g, '')} relationship."""`,
    '',
  ];
  for (const property of join.extras) {
    const attribute: string = claimAttribute(
      property.key,
      used,
      `${join.model.name}.${property.irName}`,
      context.warnings,
      pyString(property.key)
    );
    const field: IrField | undefined = join.model.fields.find(
      (candidate: IrField) => candidate.name === property.irName
    );
    const call: PropertyCall = planProperty(context, {
      label: `${join.model.name}.${property.irName}`,
      property,
      field,
      role: roleOf(roles, property.key),
      attribute,
      uniqueId: false,
    });
    lines.push(...assignment(attribute, call, 1));
  }
  relationClasses.push({ text: lines.join('\n') });
  return className;
}

function relationshipCall(
  context: PropertyContext,
  direction: 'RelationshipTo' | 'RelationshipFrom',
  targetClass: string,
  edge: GraphEdge,
  cardinality: EdgeCardinality,
  relationClass: string | undefined
): PropertyCall {
  const cardinalityClass: string = context.imports.use(
    CARDINALITY_CLASS[cardinality]
  );
  return {
    className: context.imports.use(direction),
    args: [
      pyString(targetClass),
      pyString(edge.type),
      `cardinality=${cardinalityClass}`,
      ...(relationClass === undefined ? [] : [`model=${relationClass}`]),
    ],
  };
}

function edgeWarning(edge: GraphEdge): string {
  const where: string = `${edge.source.model.name}.${edge.name}`;
  switch (edge.kind) {
    case 'manyToMany':
      return `${where}: the many-to-many relation to ${edge.target.model.name} became the relationship ${pattern(edge)}; no join node is created.`;
    case 'join':
      return `${edge.join?.model.name ?? where}: the join table became the relationship ${pattern(edge)} instead of a node class.`;
    default: {
      const keys: string = (
        edge.composite?.fields ?? [edge.relation?.name ?? edge.name]
      )
        .map((name: string) => edge.source.keys.get(name) ?? name)
        .join(', ');
      const many: boolean = keys.includes(',');
      return `${where}: the foreign key to ${edge.target.model.name} became the relationship ${pattern(edge)}; neomodel does not enforce the on delete action (${edge.onDelete ?? 'noAction'}), and ${keys} ${many ? 'were kept as plain properties' : 'was kept as a plain property'} that nothing ties to the relationship.`;
    }
  }
}

function addEdge(
  context: PropertyContext,
  edge: GraphEdge,
  byLabel: Map<string, NodePlan>,
  classNames: Set<string>,
  relationClasses: RelationPlan[]
): void {
  const source: NodePlan | undefined = byLabel.get(edge.source.label);
  const target: NodePlan | undefined = byLabel.get(edge.target.label);
  if (source === undefined || target === undefined) {
    return;
  }
  context.warnings.push(edgeWarning(edge));
  const relationClass: string | undefined =
    edge.join === undefined
      ? undefined
      : relationClassFor(context, edge.join, classNames, relationClasses);
  const outgoing: string = claimAttribute(
    edge.name,
    source.used,
    `${source.node.model.name}.${edge.name}`,
    context.warnings,
    pyString(edge.type)
  );
  source.members.push(
    ...assignment(
      outgoing,
      relationshipCall(
        context,
        'RelationshipTo',
        target.className,
        edge,
        edge.outgoing,
        relationClass
      ),
      1
    )
  );
  const reverseName: string = edge.reverseName ?? defaultReverseName(edge);
  const incoming: string = claimAttribute(
    reverseName,
    target.used,
    `${target.node.model.name}.${reverseName}`,
    context.warnings,
    pyString(edge.type)
  );
  target.members.push(
    ...assignment(
      incoming,
      relationshipCall(
        context,
        'RelationshipFrom',
        source.className,
        edge,
        edge.incoming,
        relationClass
      ),
      1
    )
  );
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

function renderNode(plan: NodePlan): string {
  const model: IrModel = plan.node.model;
  const description: string =
    `Model ${model.name} (table ${model.tableName}).`.replace(
      /["\\\r\n]/g,
      ' '
    );
  const lines: string[] = [
    `class ${plan.className}(StructuredNode):`,
    `${INDENT}"""${description}"""`,
  ];
  if (plan.needsLabel) {
    lines.push('', `${INDENT}__label__ = ${pyString(plan.node.label)}`);
  }
  if (plan.members.length > 0) {
    lines.push('', ...plan.members);
  }
  return lines.join('\n');
}

function headerLines(): string[] {
  return [
    '# Generated by ormbridge. Review the output before creating constraints or data.',
    '#',
    '# neomodel classes for Neo4j 5: one StructuredNode per node label, RelationshipTo and',
    '# RelationshipFrom for the relationships. Create the constraints and indexes with',
    '# neomodel_install_labels <this file> --db bolt://user:password@host:7687',
    '# (or db.install_labels(Class) in your code). Foreign key columns stay as plain properties.',
  ];
}

function importLines(imports: ModuleImports): string[] {
  const names: string[] = ['StructuredNode', ...imports.neomodel];
  const unique: string[] = [...new Set(names)].sort();
  const standard: string[] = [];
  const dates: string[] = [
    ...(imports.usesDate ? ['date'] : []),
    ...imports.datetime,
  ].sort();
  if (dates.length > 0) {
    standard.push(`from datetime import ${[...new Set(dates)].join(', ')}`);
  }
  if (imports.usesUuid) {
    standard.push('from uuid import uuid4');
  }
  const flat: string = `from neomodel import ${unique.join(', ')}`;
  const block: string[] =
    flat.length <= MAX_LINE_WIDTH
      ? [flat]
      : [
          'from neomodel import (',
          ...unique.map((name: string) => `${INDENT}${name},`),
          ')',
        ];
  return standard.length > 0 ? [...standard, '', ...block] : block;
}
