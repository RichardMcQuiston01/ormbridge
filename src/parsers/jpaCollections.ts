import type { IrEnum, IrField, IrModel, IrRelation } from '../ir.js';
import type { Ann } from './jpaAnnotations.js';
import { buildField, cleanIdentifier, type BuiltField } from './jpaColumns.js';
import type { EntityInfo, Member, Project } from './jpaModel.js';
import type { KeyColumn, Resolver } from './jpaJoins.js';
import { modelOwner } from './jpaJoins.js';
import { decapitalize, elementOf, isMapType } from './jpaTypes.js';

export interface CollectionTable {
  model: IrModel;
  enumDefinition?: IrEnum;
}

function capitalize(name: string): string {
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/**
 * Reads an `@ElementCollection` of basic values (`List<String>`, `Set<Role>`) as the child table Hibernate creates:
 * the owner's key as a foreign key plus the value column. Collections of embeddables and maps are skipped.
 */
export function buildCollection(
  owner: EntityInfo,
  member: Member,
  project: Project,
  resolver: Resolver,
  taken: ReadonlySet<string>
): CollectionTable | undefined {
  const place: string = `${owner.name}.${member.path.join('.')}`;
  const type = member.attr.type;
  const element = elementOf(type);
  if (isMapType(type) || element === undefined) {
    resolver.warn(
      `${place}: an @ElementCollection that is not a List, Set or array of basic values (a Map, for example) is not read; its table was skipped.`
    );
    return undefined;
  }
  const embeddable = project.classes.get(element.name);
  if (
    embeddable !== undefined &&
    embeddable.annotations.some((item) => item.name === 'Embeddable')
  ) {
    resolver.warn(
      `${place}: an @ElementCollection of the embeddable ${element.name} is stored in its own table, which is not read; the attribute was skipped.`
    );
    return undefined;
  }
  const keys: KeyColumn[] = resolver.keyOf(owner);
  const key: KeyColumn | undefined = keys[0];
  if (key === undefined || keys.length > 1) {
    resolver.warn(
      `${place}: the owner ${owner.name} needs a single-column key for the table of the @ElementCollection; the attribute was skipped.`
    );
    return undefined;
  }
  const notes = member.attr.notes;
  const collectionTable: Ann | undefined = notes.get('CollectionTable');
  const joinColumn: Ann | undefined =
    collectionTable?.annotations('joinColumns')[0];
  const attributeName: string = member.attr.name;
  const tableName: string =
    collectionTable?.string('name') || `${owner.entityName}_${attributeName}`;
  const ownerColumn: string =
    joinColumn?.string('name') || `${owner.entityName}_${key.columnName}`;

  // The value column: the @Column of the attribute describes it.
  const valueMember: Member = {
    ...member,
    attr: { ...member.attr, type: element },
    isId: false,
    kind: 'basic',
  };
  const built: BuiltField = buildField(
    valueMember,
    { project, entity: owner, warn: resolver.warn },
    false
  );
  const isSet: boolean = /Set$/.test(type.name);
  const order: Ann | undefined = notes.get('OrderColumn');
  const fields: IrField[] = [
    {
      ...built.field,
      isNullable: built.field.isNullable,
    },
  ];
  const relationName: string = decapitalize(owner.name);
  const onDeleteName: string | undefined = notes
    .get('OnDelete', true)
    ?.member('action');
  const relation: IrRelation = {
    name: relationName,
    kind: 'foreignKey',
    targetModel: modelOwner(owner).name,
    columnName: cleanIdentifier(ownerColumn),
    isNullable: false,
    onDelete: onDeleteName === 'CASCADE' ? 'cascade' : 'noAction',
  };
  let compositePrimaryKey: string[] | undefined;
  if (order !== undefined) {
    const orderField: IrField = {
      name: `${attributeName}Order`,
      columnName: order.string('name') || `${attributeName}_ORDER`,
      type: 'int',
      isPrimaryKey: false,
      isUnique: false,
      isNullable: false,
      isAutoUpdated: false,
    };
    fields.push(orderField);
    compositePrimaryKey = [relationName, orderField.name];
  } else if (isSet && !built.field.isNullable) {
    compositePrimaryKey = [relationName, built.field.name];
  }
  let name: string = `${owner.name}${capitalize(attributeName)}`;
  while (taken.has(name)) {
    name = `${name}Item`;
  }
  resolver.warn(
    `${place}: the @ElementCollection is stored in the child table "${tableName}"; it was read as the model ${name}, with a foreign key to ${owner.name}` +
      (compositePrimaryKey === undefined
        ? ' and no primary key (as in Hibernate: a Set has one only when its column is NOT NULL, a List only with @OrderColumn; other formats expect one).'
        : '.')
  );
  const model: IrModel = {
    name,
    tableName: cleanIdentifier(tableName),
    appLabel: project.appLabel,
    fields,
    relations: [relation],
    indexes: [],
    ...(compositePrimaryKey === undefined ? {} : { compositePrimaryKey }),
  };
  return {
    model,
    ...(built.enumDefinition === undefined
      ? {}
      : { enumDefinition: built.enumDefinition }),
  };
}
