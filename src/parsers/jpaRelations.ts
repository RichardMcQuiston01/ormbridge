import type { IrOnDelete, IrRelation } from '../ir.js';
import { toCamelCase, toSnakeCase } from '../naming.js';
import type { Ann } from './jpaAnnotations.js';
import type { BuiltField } from './jpaColumns.js';
import { cleanIdentifier, columnNameOf, irFieldName } from './jpaColumns.js';
import {
  cascadeNote,
  constraintName,
  joinColumnsOf,
  joinPairs,
  modelOwner,
  onDeleteOf,
  relationAnnotation,
  tableNameOf,
  targetOf,
  type JoinPair,
  type KeyColumn,
  type RelationOutput,
  type Resolver,
} from './jpaJoins.js';
import type { EntityInfo, Member } from './jpaModel.js';
import { decapitalize } from './jpaTypes.js';

/** Resolves the relationship attributes of one model. */
export function resolveRelations(
  model: EntityInfo,
  members: readonly Member[],
  resolver: Resolver
): RelationOutput {
  const output: RelationOutput = {
    relations: [],
    composite: [],
    extraFields: [],
    consumed: new Map(),
    foreign: [],
    inverse: [],
  };
  members.forEach((member: Member, order: number) => {
    if (member.kind !== 'relation') {
      return;
    }
    const annotation: Ann = relationAnnotation(member);
    const place: string = `${model.name}.${member.path.join('.')}`;
    const target: EntityInfo | undefined = targetOf(
      member,
      annotation,
      resolver
    );
    if (target === undefined) {
      resolver.warn(
        `${place}: the target type ${member.attr.type.args[0]?.name ?? member.attr.type.name} of @${annotation.name} is not an entity in the input; the relationship was skipped.`
      );
      return;
    }
    cascadeNote(member, annotation, place, resolver);
    const mappedBy: string | undefined = annotation.string('mappedBy');
    if (mappedBy !== undefined && mappedBy !== '') {
      output.inverse.push({
        model: modelOwner(target),
        attribute: mappedBy.split('.').pop() ?? mappedBy,
        relatedName: member.attr.name,
      });
      return;
    }
    if (annotation.name === 'ManyToMany') {
      manyToMany(model, member, target, order, output, resolver, place);
    } else if (annotation.name === 'OneToMany') {
      oneToMany(model, member, target, order, output, resolver, place);
    } else {
      toOne(model, member, annotation, target, order, output, resolver, place);
    }
  });
  return output;
}

function toOne(
  model: EntityInfo,
  member: Member,
  annotation: Ann,
  target: EntityInfo,
  order: number,
  output: RelationOutput,
  resolver: Resolver,
  place: string
): void {
  const pairs: JoinPair[] | undefined = joinPairs(
    member,
    target,
    resolver,
    place
  );
  if (pairs === undefined) {
    return;
  }
  const targetModel: EntityInfo = modelOwner(target);
  const isOneToOne: boolean = annotation.name === 'OneToOne';
  const optional: boolean = annotation.boolean('optional') !== false;
  const mapsId: Ann | undefined = member.attr.notes.get('MapsId');
  const declaredNotNull: boolean = member.attr.notes.has('NotNull');
  const nullable: boolean =
    optional &&
    !declaredNotNull &&
    pairs.every((pair: JoinPair) => pair.nullable !== false) &&
    !member.isId &&
    mapsId === undefined;
  const name: string = irFieldName(member);
  const onDelete: IrOnDelete = onDeleteOf(member, place, resolver);
  const unique: boolean =
    isOneToOne || pairs.some((pair: JoinPair) => pair.unique);
  const kind: 'foreignKey' | 'oneToOne' = unique ? 'oneToOne' : 'foreignKey';
  const constraint: string | undefined = constraintName(
    pairs[0],
    member,
    place,
    resolver
  );
  const first: JoinPair | undefined = pairs[0];
  if (first === undefined) {
    return;
  }

  // A shared key: @MapsId makes the foreign key the primary key (or a part of the embedded id).
  const columnName: string = first.columnName;
  let isKey: boolean = member.isId;
  if (mapsId !== undefined) {
    const part: string | undefined = mapsId.string('value');
    const idMembers: Member[] = model.members.filter(
      (item: Member) => item.isId
    );
    const mapped: Member | undefined =
      part === undefined || part === ''
        ? idMembers[0]
        : idMembers.find(
            (item: Member) => item.path[item.path.length - 1] === part
          );
    if (mapped !== undefined) {
      output.consumed.set(mapped.path.join('.'), name);
      isKey = true;
    } else {
      resolver.warn(
        `${place}: @MapsId names "${part ?? ''}", which is not an id attribute of ${model.name}.`
      );
    }
  }

  if (pairs.length > 1) {
    compositeKey(
      model,
      member,
      pairs,
      targetModel,
      kind,
      nullable,
      onDelete,
      output,
      resolver
    );
    return;
  }
  const referencedKey: KeyColumn[] = resolver.keyOf(target);
  const isPrimaryReference: boolean =
    referencedKey.length === 1 &&
    referencedKey[0]?.columnName === first.target.columnName;
  const relation: IrRelation = {
    name,
    kind,
    targetModel: targetModel.name,
    columnName,
    isNullable: isKey ? false : nullable,
    onDelete,
    ...(isPrimaryReference ? {} : { toField: first.target.name }),
    ...(isKey ? { isPrimaryKey: true } : {}),
    ...(constraint === undefined ? {} : { constraintName: constraint }),
  };
  output.relations.push({ order, relation });
  const mirror: string | undefined = scalarOnColumn(model, columnName);
  if (mirror !== undefined) {
    output.consumed.set(mirror, name);
  }
}

/** The path of a scalar member of the model that maps the same column (a read-only copy of the key). */
function scalarOnColumn(
  model: EntityInfo,
  columnName: string
): string | undefined {
  const found: Member | undefined = model.members.find(
    (member: Member) =>
      member.kind === 'basic' &&
      !member.isId &&
      columnNameOf(member).toLowerCase() === columnName.toLowerCase()
  );
  return found?.path.join('.');
}

function compositeKey(
  model: EntityInfo,
  member: Member,
  pairs: JoinPair[],
  target: EntityInfo,
  kind: 'foreignKey' | 'oneToOne',
  nullable: boolean,
  onDelete: IrOnDelete,
  output: RelationOutput,
  resolver: Resolver
): void {
  const targetFields: readonly BuiltField[] = resolver.fieldsOf(target);
  const local: string[] = [];
  for (const pair of pairs) {
    const existing: Member | undefined = model.members.find(
      (item: Member) =>
        item.kind === 'basic' &&
        columnNameOf(item).toLowerCase() === pair.columnName.toLowerCase()
    );
    if (existing !== undefined) {
      local.push(irFieldName(existing));
      output.consumed.delete(existing.path.join('.'));
      continue;
    }
    const referenced: BuiltField | undefined = targetFields.find(
      (item: BuiltField) => item.field.name === pair.target.name
    );
    const name: string = toCamelCase(pair.columnName);
    output.extraFields.push({
      name,
      columnName: pair.columnName,
      type: referenced?.field.type ?? 'unsupported',
      isPrimaryKey: false,
      isUnique: false,
      isNullable: nullable,
      isAutoUpdated: false,
      ...(referenced?.field.maxLength === undefined
        ? {}
        : { maxLength: referenced.field.maxLength }),
      ...(referenced?.field.maxDigits === undefined
        ? {}
        : { maxDigits: referenced.field.maxDigits }),
      ...(referenced?.field.decimalPlaces === undefined
        ? {}
        : { decimalPlaces: referenced.field.decimalPlaces }),
    });
    local.push(name);
  }
  output.composite.push({
    name: irFieldName(member),
    targetModel: target.name,
    fields: local,
    references: pairs.map((pair: JoinPair) => pair.target.name),
    kind,
    isNullable: nullable,
    onDelete,
  });
}

function oneToMany(
  model: EntityInfo,
  member: Member,
  target: EntityInfo,
  order: number,
  output: RelationOutput,
  resolver: Resolver,
  place: string
): void {
  const targetModel: EntityInfo = modelOwner(target);
  if (joinColumnsOf(member).length === 0) {
    // Without a join column Hibernate stores the link in a join table, like a many-to-many with a unique target.
    resolver.warn(
      `${place}: a unidirectional @OneToMany without @JoinColumn uses a join table; it was read as a many-to-many relation (that each ${target.name} belongs to one ${model.name} is not represented).`
    );
    manyToMany(model, member, target, order, output, resolver, place);
    return;
  }
  // @OneToMany with @JoinColumn: the foreign key is a column of the target's table.
  const ownerKeys: KeyColumn[] = resolver.keyOf(model);
  const columns: Ann[] = joinColumnsOf(member);
  const first: Ann | undefined = columns[0];
  const key: KeyColumn | undefined = ownerKeys[0];
  if (first === undefined || key === undefined || columns.length > 1) {
    resolver.warn(
      `${place}: a @OneToMany with several join columns (or an owner without a key) is not supported; the relationship was skipped.`
    );
    return;
  }
  const given: string | undefined = first.string('name');
  const columnName: string =
    given === undefined || given === ''
      ? `${member.attr.name}_${key.columnName}`
      : cleanIdentifier(given);
  const name: string = decapitalize(model.name);
  output.foreign.push({
    model: targetModel,
    relation: {
      name,
      kind: 'foreignKey',
      targetModel: modelOwner(model).name,
      columnName,
      isNullable: first.boolean('nullable') !== false,
      onDelete: onDeleteOf(member, place, resolver),
      relatedName: member.attr.name,
    },
  });
}

function manyToMany(
  model: EntityInfo,
  member: Member,
  target: EntityInfo,
  order: number,
  output: RelationOutput,
  resolver: Resolver,
  place: string
): void {
  const name: string = irFieldName(member);
  const relation: IrRelation = {
    name,
    kind: 'manyToMany',
    targetModel: modelOwner(target).name,
    columnName: `${toSnakeCase(name)}_id`,
    isNullable: false,
    onDelete: 'cascade',
  };
  output.relations.push({ order, relation });
  joinTableNote(model, member, target, relation, resolver, place);
}

/** Warns when the join table or its columns differ from the names the other formats will derive. */
function joinTableNote(
  model: EntityInfo,
  member: Member,
  target: EntityInfo,
  relation: IrRelation,
  resolver: Resolver,
  place: string
): void {
  const join: Ann | undefined = member.attr.notes.get('JoinTable');
  const ownerKey: KeyColumn | undefined = resolver.keyOf(model)[0];
  const targetKey: KeyColumn | undefined = resolver.keyOf(target)[0];
  const ownerTable: string = tableNameOf(modelOwner(model));
  const targetTable: string = tableNameOf(modelOwner(target));
  const actualTable: string =
    join?.string('name') || `${ownerTable}_${targetTable}`;
  const left: Ann | undefined = join?.annotations('joinColumns')[0];
  const right: Ann | undefined = join?.annotations('inverseJoinColumns')[0];
  const actualLeft: string =
    left?.string('name') ||
    `${model.entityName}_${ownerKey?.columnName ?? 'id'}`;
  const actualRight: string =
    right?.string('name') ||
    `${member.attr.name}_${targetKey?.columnName ?? 'id'}`;
  const isSelf: boolean = model.name === target.name;
  const expectedTable: string = `${ownerTable}_${relation.name}`;
  const expectedLeft: string = `${isSelf ? 'from_' : ''}${toSnakeCase(model.name)}_id`;
  const expectedRight: string = `${isSelf ? 'to_' : ''}${toSnakeCase(target.name)}_id`;
  if (
    actualTable !== expectedTable ||
    actualLeft !== expectedLeft ||
    actualRight !== expectedRight
  ) {
    resolver.warn(
      `${place}: the join table "${actualTable}" (columns ${actualLeft}, ${actualRight}) is not preserved by name; ` +
        `formats that derive join tables will use "${expectedTable}" (columns ${expectedLeft}, ${expectedRight}).`
    );
  }
}
