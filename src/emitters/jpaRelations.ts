import type {
  IrCompositeForeignKey,
  IrField,
  IrModel,
  IrOnDelete,
  IrRelation,
  IrSchema,
} from '../ir.js';
import { findModel } from '../ir.js';
import { toSnakeCase } from '../naming.js';
import {
  annotation,
  type AnnotationNode,
  type AnnotationValue,
} from './jpaFormat.js';
import type { KeyInfo, KeyPart } from './jpaKeys.js';
import { attributeNameOf, javaString, uniqueName } from './jpaNames.js';
import {
  Imports,
  type Attribute,
  type JpaKeyMode,
  type JpaStyle,
  type ModelPlan,
} from './jpaTypes.js';

/** Writes the relations of the models: the owning side with its join columns, the inverse side and the join tables. */

/** An inverse side to add to the target of a relation once every owning side is named. */
export interface InverseLink {
  owner: ModelPlan;
  target: ModelPlan;
  kind: 'oneToMany' | 'oneToOne' | 'manyToMany';
  /** The attribute of the owner the inverse side maps. */
  mappedBy: string;
  relatedName: string;
}

export interface RelationContext {
  style: JpaStyle;
  /** How a composite primary key is written; a relationship in one gets `@MapsId` instead of `@Id` when embedded. */
  keyMode: JpaKeyMode;
  schema: IrSchema;
  plans: ReadonlyMap<string, ModelPlan>;
  keys: ReadonlyMap<string, KeyInfo>;
  /** The boxed Java type of the single-column key of each model, with its imports. */
  keyTypes: ReadonlyMap<string, { type: string; imports: Imports }>;
  inverses: InverseLink[];
  warn: (message: string) => void;
}

/** A relation that is part of a primary key: its attribute name and the type of the key it points at. */
export interface KeyRelation {
  attribute: string;
  /** The foreign key column, which the `@Embeddable` key class repeats. */
  column: string;
  type: string;
  imports: Imports;
}

const ON_DELETE: Readonly<Record<IrOnDelete, string | undefined>> = {
  cascade: 'CASCADE',
  setNull: 'SET_NULL',
  setDefault: 'SET_DEFAULT',
  restrict: 'RESTRICT',
  noAction: undefined,
};

function planOf(ctx: RelationContext, name: string): ModelPlan | undefined {
  return ctx.plans.get(name);
}

/** The column and Java type of the single-column key of a model, or undefined when it has none. */
export function singleKey(
  ctx: RelationContext,
  model: IrModel
): { column: string; field?: IrField } | undefined {
  const info: KeyInfo | undefined = ctx.keys.get(model.name);
  const part: KeyPart | undefined =
    info?.parts.length === 1 ? info.parts[0] : undefined;
  if (part === undefined) {
    return undefined;
  }
  return part.kind === 'field'
    ? { column: part.field.columnName, field: part.field }
    : { column: part.relation.columnName };
}

/** The column a foreign key refers to: `toField`, else the single key of the target. */
function referencedColumn(
  ctx: RelationContext,
  target: IrModel,
  toField: string | undefined
): string | undefined {
  if (toField !== undefined) {
    const field: IrField | undefined =
      target.fields.find((item: IrField) => item.name === toField) ??
      target.fields.find((item: IrField) => item.columnName === toField);
    return field?.columnName;
  }
  return singleKey(ctx, target)?.column;
}

function onDeleteNode(
  ctx: RelationContext,
  label: string,
  imports: Imports,
  action: IrOnDelete
): AnnotationNode | undefined {
  const name: string | undefined = ON_DELETE[action];
  if (name === undefined) {
    return undefined;
  }
  if (ctx.style === 'javax' && action !== 'cascade') {
    ctx.warn(
      `${label}: Hibernate 5 knows only ON DELETE CASCADE (@OnDelete); the ${name.replace('_', ' ')} action was dropped and the database default (no action) applies.`
    );
    return undefined;
  }
  const type: string = imports.hibernate('OnDeleteAction');
  return annotation(imports.hibernate('OnDelete'), [
    ['action', `${type}.${name}`],
  ]);
}

function joinColumn(
  imports: Imports,
  name: string,
  referenced: string,
  extra: [string, AnnotationValue][]
): AnnotationNode {
  return annotation(imports.persistence('JoinColumn'), [
    ['name', javaString(name)],
    ['referencedColumnName', javaString(referenced)],
    ...extra,
  ]);
}

function foreignKeyArgument(
  imports: Imports,
  constraintName: string | undefined
): [string, AnnotationValue][] {
  return constraintName === undefined
    ? []
    : [
        [
          'foreignKey',
          annotation(imports.persistence('ForeignKey'), [
            ['name', javaString(constraintName)],
          ]),
        ],
      ];
}

function sideArguments(
  imports: Imports,
  optional: boolean,
  lazy: boolean
): [string, AnnotationValue][] {
  const args: [string, AnnotationValue][] = [];
  if (!optional) {
    args.push(['optional', 'false']);
  }
  if (lazy) {
    args.push(['fetch', `${imports.persistence('FetchType')}.LAZY`]);
  }
  return args;
}

/** True when the relation is a part of the primary key of its model. */
function isKeyRelation(
  info: KeyInfo | undefined,
  relation: IrRelation
): boolean {
  return (
    info?.parts.some(
      (part: KeyPart) => part.kind === 'relation' && part.relation === relation
    ) ?? false
  );
}

function collectionOf(imports: Imports, kind: 'List' | 'Set'): string {
  imports.use(`java.util.${kind}`);
  imports.use(kind === 'List' ? 'java.util.ArrayList' : 'java.util.HashSet');
  return kind;
}

/** Adds the owning side of every relation of one model; returns the relations that are part of its key. */
export function addOwningRelations(
  ctx: RelationContext,
  plan: ModelPlan
): Map<IrRelation, KeyRelation> {
  const model: IrModel = plan.model;
  const keyRelations: Map<IrRelation, KeyRelation> = new Map();
  const info: KeyInfo | undefined = ctx.keys.get(model.name);
  for (const relation of model.relations) {
    const label: string = `${model.name}.${relation.name}`;
    const target: IrModel | undefined = findModel(
      ctx.schema,
      relation.targetModel
    );
    const targetPlan: ModelPlan | undefined = planOf(ctx, relation.targetModel);
    if (target === undefined || targetPlan === undefined) {
      ctx.warn(
        `${label}: the model ${relation.targetModel} is not in the input, so the relation was skipped${relation.kind === 'manyToMany' ? '' : ' and its column left out'}.`
      );
      continue;
    }
    if (relation.kind === 'manyToMany') {
      addManyToMany(ctx, plan, targetPlan, relation);
      continue;
    }
    const referenced: string | undefined = referencedColumn(
      ctx,
      target,
      relation.toField
    );
    if (referenced === undefined) {
      ctx.warn(
        `${label}: ${relation.targetModel} has no single-column key to reference, so the relation was skipped and its column left out.`
      );
      continue;
    }
    const imports: Imports = new Imports(ctx.style);
    const attributeName: string = uniqueName(
      attributeNameOf(relation.name),
      plan.used
    );
    plan.relationNames.set(relation.name, attributeName);
    const isKey: boolean = isKeyRelation(info, relation);
    const oneToOne: boolean = relation.kind === 'oneToOne';
    const required: boolean = !relation.isNullable || isKey;
    if (relation.onUpdate !== undefined) {
      ctx.warn(
        `${label}: JPA has no setting for the onUpdate action "${relation.onUpdate}", so it was ignored.`
      );
    }
    if (!relation.isNullable && relation.onDelete === 'setNull') {
      ctx.warn(
        `${label}: SET NULL on a required relation; the column is NOT NULL, so deleting a ${relation.targetModel} that is referenced fails.`
      );
    }
    const annotations: AnnotationNode[] = [];
    if (isKey) {
      // In an @EmbeddedId the key class holds the column; the relationship takes its value from it.
      annotations.push(
        ctx.keyMode === 'embedded' && (info?.parts.length ?? 0) > 1
          ? annotation(imports.persistence('MapsId'), [
              [undefined, javaString(attributeName)],
            ])
          : annotation(imports.persistence('Id'))
      );
    }
    annotations.push(
      annotation(
        imports.persistence(oneToOne ? 'OneToOne' : 'ManyToOne'),
        sideArguments(imports, !required, !isKey)
      ),
      joinColumn(imports, relation.columnName, referenced, [
        ...(required ? ([['nullable', 'false']] as [string, string][]) : []),
        ...foreignKeyArgument(imports, relation.constraintName),
      ])
    );
    const action: AnnotationNode | undefined = onDeleteNode(
      ctx,
      label,
      imports,
      relation.onDelete
    );
    if (action !== undefined) {
      annotations.push(action);
    }
    const attribute: Attribute = {
      name: attributeName,
      type: targetPlan.className,
      annotations,
      imports,
    };
    plan.attributes.push(attribute);
    if (isKey) {
      const keyType = ctx.keyTypes.get(target.name);
      keyRelations.set(relation, {
        attribute: attributeName,
        column: relation.columnName,
        type: keyType?.type ?? 'Object',
        imports: keyType?.imports ?? imports,
      });
    }
    if (relation.relatedName !== undefined) {
      ctx.inverses.push({
        owner: plan,
        target: targetPlan,
        kind: oneToOne ? 'oneToOne' : 'oneToMany',
        mappedBy: attributeName,
        relatedName: relation.relatedName,
      });
    }
  }
  for (const key of model.compositeForeignKeys ?? []) {
    addCompositeKey(ctx, plan, key);
  }
  return keyRelations;
}

/** The column of a field of the model, by name or column name. */
function columnOfField(model: IrModel, name: string): string | undefined {
  return (
    model.fields.find((item: IrField) => item.name === name)?.columnName ??
    model.fields.find((item: IrField) => item.columnName === name)?.columnName
  );
}

function addCompositeKey(
  ctx: RelationContext,
  plan: ModelPlan,
  key: IrCompositeForeignKey
): void {
  const model: IrModel = plan.model;
  const label: string = `${model.name}.${key.name}`;
  const target: IrModel | undefined = findModel(ctx.schema, key.targetModel);
  const targetPlan: ModelPlan | undefined = planOf(ctx, key.targetModel);
  const locals: (string | undefined)[] = key.fields.map((name: string) =>
    columnOfField(model, name)
  );
  const referenced: (string | undefined)[] = key.references.map(
    (name: string) =>
      target === undefined ? undefined : columnOfField(target, name)
  );
  if (
    target === undefined ||
    targetPlan === undefined ||
    locals.some((column) => column === undefined) ||
    referenced.some((column) => column === undefined)
  ) {
    ctx.warn(
      `${label}: a column of the composite foreign key to ${key.targetModel} is not a field of the models, so the relation was skipped.`
    );
    return;
  }
  if (key.onUpdate !== undefined) {
    ctx.warn(
      `${label}: JPA has no setting for the onUpdate action "${key.onUpdate}", so it was ignored.`
    );
  }
  if (!key.isNullable && key.onDelete === 'setNull') {
    ctx.warn(
      `${label}: SET NULL on a required relation; the columns are NOT NULL, so deleting a ${key.targetModel} that is referenced fails.`
    );
  }
  const imports: Imports = new Imports(ctx.style);
  const attributeName: string = uniqueName(
    attributeNameOf(key.name),
    plan.used
  );
  plan.relationNames.set(`composite:${key.name}`, attributeName);
  const oneToOne: boolean = key.kind === 'oneToOne';
  const columns: AnnotationNode[] = locals.map(
    (column: string | undefined, position: number) =>
      joinColumn(imports, column ?? '', referenced[position] ?? '', [
        ['insertable', 'false'],
        ['updatable', 'false'],
      ])
  );
  const annotations: AnnotationNode[] = [
    annotation(
      imports.persistence(oneToOne ? 'OneToOne' : 'ManyToOne'),
      sideArguments(imports, key.isNullable, true)
    ),
    annotation(imports.persistence('JoinColumns'), [
      [key.constraintName === undefined ? undefined : 'value', columns],
      ...foreignKeyArgument(imports, key.constraintName),
    ]),
  ];
  const action: AnnotationNode | undefined = onDeleteNode(
    ctx,
    label,
    imports,
    key.onDelete
  );
  if (action !== undefined) {
    annotations.push(action);
  }
  plan.attributes.push({
    name: attributeName,
    type: targetPlan.className,
    annotations,
    imports,
  });
  if (key.relatedName !== undefined) {
    ctx.inverses.push({
      owner: plan,
      target: targetPlan,
      kind: oneToOne ? 'oneToOne' : 'oneToMany',
      mappedBy: attributeName,
      relatedName: key.relatedName,
    });
  }
}

function addManyToMany(
  ctx: RelationContext,
  plan: ModelPlan,
  targetPlan: ModelPlan,
  relation: IrRelation
): void {
  const model: IrModel = plan.model;
  const label: string = `${model.name}.${relation.name}`;
  const ownerKey = singleKey(ctx, model);
  const targetKey = singleKey(ctx, targetPlan.model);
  if (ownerKey === undefined || targetKey === undefined) {
    ctx.warn(
      `${label}: a many-to-many relation needs a single-column key on both models; the relation was skipped.`
    );
    return;
  }
  const imports: Imports = new Imports(ctx.style);
  const attributeName: string = uniqueName(
    attributeNameOf(relation.name),
    plan.used
  );
  plan.relationNames.set(relation.name, attributeName);
  const isSelf: boolean = model.name === relation.targetModel;
  const ownerColumn: string = `${isSelf ? 'from_' : ''}${toSnakeCase(model.name)}_id`;
  const targetColumn: string = `${isSelf ? 'to_' : ''}${toSnakeCase(relation.targetModel)}_id`;
  const table: AnnotationNode = annotation(imports.persistence('JoinTable'), [
    ['name', javaString(`${model.tableName}_${relation.name}`)],
    ...(model.schema === undefined
      ? []
      : ([['schema', javaString(model.schema)]] as [string, string][])),
    ['joinColumns', joinColumn(imports, ownerColumn, ownerKey.column, [])],
    [
      'inverseJoinColumns',
      joinColumn(imports, targetColumn, targetKey.column, []),
    ],
  ]);
  const kind: string = collectionOf(imports, 'Set');
  plan.attributes.push({
    name: attributeName,
    type: `${kind}<${targetPlan.className}>`,
    annotations: [annotation(imports.persistence('ManyToMany')), table],
    initializer: 'new HashSet<>()',
    imports,
  });
  if (relation.relatedName !== undefined) {
    ctx.inverses.push({
      owner: plan,
      target: targetPlan,
      kind: 'manyToMany',
      mappedBy: attributeName,
      relatedName: relation.relatedName,
    });
  }
}

/** Adds the inverse side (`mappedBy`) of every relation that names one. */
export function addInverseRelations(ctx: RelationContext): void {
  for (const link of ctx.inverses) {
    const imports: Imports = new Imports(ctx.style);
    const name: string = uniqueName(
      attributeNameOf(link.relatedName),
      link.target.used
    );
    const mapped: [string, AnnotationValue][] = [
      ['mappedBy', javaString(link.mappedBy)],
    ];
    const owner: string = link.owner.className;
    let node: AnnotationNode;
    let type: string;
    let initializer: string | undefined;
    switch (link.kind) {
      case 'oneToOne':
        node = annotation(imports.persistence('OneToOne'), mapped);
        type = owner;
        break;
      case 'oneToMany':
        node = annotation(imports.persistence('OneToMany'), mapped);
        type = `${collectionOf(imports, 'List')}<${owner}>`;
        initializer = 'new ArrayList<>()';
        break;
      default:
        node = annotation(imports.persistence('ManyToMany'), mapped);
        type = `${collectionOf(imports, 'Set')}<${owner}>`;
        initializer = 'new HashSet<>()';
    }
    link.target.attributes.push({
      name,
      type,
      annotations: [node],
      imports,
      ...(initializer === undefined ? {} : { initializer }),
    });
  }
}
