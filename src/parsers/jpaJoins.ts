import type { IrOnDelete } from '../ir.js';
import type { Ann } from './jpaAnnotations.js';
import type { BuiltField } from './jpaColumns.js';
import { cleanIdentifier } from './jpaColumns.js';
import type { EntityInfo, Member, Project } from './jpaModel.js';
import { onDeleteAction } from './jpaTypes.js';
import type { IrCompositeForeignKey, IrField, IrRelation } from '../ir.js';

/** A primary key column of an entity: the IR name of its field (or relation) and the database column. */
export interface KeyColumn {
  name: string;
  columnName: string;
}

/** Everything the relationship steps look up. */
export interface Resolver {
  project: Project;
  entities: Map<string, EntityInfo>;
  warn: (message: string) => void;
  /** Built fields of every model, by model name, for the types of foreign key columns. */
  fieldsOf: (model: EntityInfo) => readonly BuiltField[];
  /** The primary key columns of an entity's table. */
  keyOf: (entity: EntityInfo) => KeyColumn[];
}

/** A relationship placed on a model, with the position of its attribute (for ordering). */
export interface PlacedRelation {
  order: number;
  relation: IrRelation;
}

export interface RelationOutput {
  relations: PlacedRelation[];
  composite: IrCompositeForeignKey[];
  /** Local columns that composite foreign keys need and no attribute declares. */
  extraFields: IrField[];
  /** Paths (`a.b`) of scalar members whose column a relationship now carries. */
  consumed: Map<string, string>;
  /** Relationships that belong on another model (a one-to-many with a join column). */
  foreign: { model: EntityInfo; relation: IrRelation }[];
  /** The inverse sides: the owning relationship named `attribute` on `model` gets `relatedName`. */
  inverse: { model: EntityInfo; attribute: string; relatedName: string }[];
}

const RELATION_NAMES: readonly string[] = [
  'ManyToOne',
  'OneToOne',
  'OneToMany',
  'ManyToMany',
];

/** The model a table belongs to: single-table subclasses live in the table of their root. */
export function modelOwner(entity: EntityInfo): EntityInfo {
  return entity.inheritance === 'singleTable' ? entity.root : entity;
}

export function relationAnnotation(member: Member): Ann {
  for (const name of RELATION_NAMES) {
    const found: Ann | undefined = member.attr.notes.get(name);
    if (found !== undefined) {
      return found;
    }
  }
  // Callers only pass members that carry one of the four annotations.
  throw new Error(`${member.attr.name} has no relationship annotation`);
}

/** The entity a relationship points at: `targetEntity`, else the (element) type of the attribute. */
export function targetOf(
  member: Member,
  annotation: Ann,
  resolver: Resolver
): EntityInfo | undefined {
  const type = member.attr.type;
  const named: string | undefined =
    annotation.className('targetEntity') ??
    (type.args.length > 0 ? type.args[type.args.length - 1]?.name : type.name);
  return named === undefined ? undefined : resolver.entities.get(named);
}

/** `@JoinColumn` entries of an attribute: one, several (`@JoinColumns`), or none. */
export function joinColumnsOf(member: Member): Ann[] {
  return member.attr.notes.repeated('JoinColumn', 'JoinColumns');
}

export interface JoinPair {
  /** The column in the table that holds the foreign key. */
  columnName: string;
  /** The key column of the target it points at. */
  target: KeyColumn;
  nullable: boolean | undefined;
  unique: boolean;
  constraint?: Ann;
}

/** The column a join column refers to: a key column, or any other column of the target (a unique one, usually). */
function referencedKey(
  keys: readonly KeyColumn[],
  target: EntityInfo,
  columnName: string,
  resolver: Resolver
): KeyColumn | undefined {
  const wanted: string = columnName.toLowerCase();
  const key: KeyColumn | undefined = keys.find(
    (item: KeyColumn) => item.columnName.toLowerCase() === wanted
  );
  if (key !== undefined) {
    return key;
  }
  const other: BuiltField | undefined = resolver
    .fieldsOf(target)
    .find((item: BuiltField) => item.field.columnName.toLowerCase() === wanted);
  return other === undefined
    ? undefined
    : { name: other.field.name, columnName: other.field.columnName };
}

/** Pairs each join column with the target key column it refers to, applying the JPA default names. */
export function joinPairs(
  member: Member,
  target: EntityInfo,
  resolver: Resolver,
  place: string
): JoinPair[] | undefined {
  const keys: KeyColumn[] = resolver.keyOf(target);
  const columns: Ann[] = joinColumnsOf(member);
  if (keys.length === 0) {
    resolver.warn(
      `${place}: the target ${target.name} has no primary key, so the foreign key cannot be placed.`
    );
    return undefined;
  }
  if (columns.length === 0) {
    return keys.map((key: KeyColumn): JoinPair => ({
      columnName: `${member.attr.name}_${key.columnName}`,
      target: key,
      nullable: undefined,
      unique: false,
    }));
  }
  const pairs: JoinPair[] = [];
  columns.forEach((column: Ann, position: number) => {
    const referenced: string | undefined = column.string(
      'referencedColumnName'
    );
    const key: KeyColumn | undefined =
      referenced === undefined || referenced === ''
        ? (keys[position] ?? keys[0])
        : referencedKey(keys, target, cleanIdentifier(referenced), resolver);
    const named: string | undefined = column.string('name');
    if (key === undefined) {
      resolver.warn(
        `${place}: the join column refers to "${referenced ?? ''}", which is not a key column of ${target.name}; the relationship was skipped.`
      );
      return;
    }
    const constraint: Ann | undefined = column.annotation('foreignKey');
    pairs.push({
      columnName:
        named === undefined || named === ''
          ? `${member.attr.name}_${key.columnName}`
          : cleanIdentifier(named),
      target: key,
      nullable: column.boolean('nullable'),
      unique: column.boolean('unique') ?? false,
      ...(constraint === undefined ? {} : { constraint }),
    });
  });
  return pairs.length === columns.length ? pairs : undefined;
}

/** The referential action of a relationship: `@OnDelete` or, for none, the database default. */
export function onDeleteOf(
  member: Member,
  place: string,
  resolver: Resolver
): IrOnDelete {
  const action: Ann | undefined = member.attr.notes.get('OnDelete', true);
  const name: string | undefined = action?.member('action');
  if (name === undefined) {
    return 'noAction';
  }
  const mapped: IrOnDelete | undefined = onDeleteAction(name);
  if (mapped === undefined) {
    resolver.warn(
      `${place}: the @OnDelete action ${name} is not known; the database default (no action) was used.`
    );
    return 'noAction';
  }
  return mapped;
}

export function cascadeNote(
  member: Member,
  annotation: Ann,
  place: string,
  resolver: Resolver
): void {
  const cascade: string[] = annotation.members('cascade');
  const removes: boolean = cascade.some(
    (name: string) => name === 'REMOVE' || name === 'ALL'
  );
  const orphan: boolean = annotation.boolean('orphanRemoval') === true;
  if (!removes && !orphan) {
    return;
  }
  const cascadesInDatabase: boolean =
    member.attr.notes.get('OnDelete', true)?.member('action') === 'CASCADE';
  if (!cascadesInDatabase) {
    resolver.warn(
      `${place}: ${removes ? `cascade ${cascade.includes('ALL') ? 'ALL' : 'REMOVE'}` : 'orphanRemoval'} deletes children through the ORM only; it adds no ON DELETE CASCADE to the foreign key, which is written as read (add @OnDelete(action = OnDeleteAction.CASCADE) on the owning side for that).`
    );
  }
}

export function constraintName(
  pair: JoinPair | undefined,
  member: Member,
  place: string,
  resolver: Resolver
): string | undefined {
  const own: Ann | undefined =
    pair?.constraint ??
    member.attr.notes.get('JoinColumn')?.annotation('foreignKey');
  const legacy: Ann | undefined = member.attr.notes.get('ForeignKey', true);
  if (own?.member('value') === 'NO_CONSTRAINT') {
    resolver.warn(
      `${place}: ConstraintMode.NO_CONSTRAINT means Hibernate creates no foreign key constraint; it was read as a foreign key.`
    );
  }
  const name: string | undefined =
    own?.string('name') ?? legacy?.string('name');
  return name === undefined || name === '' ? undefined : name;
}

/** The table name of an entity: `@Table(name)`, else the entity name. */
export function tableNameOf(entity: EntityInfo): string {
  const given: string | undefined = entity.notes.get('Table')?.string('name');
  return given === undefined || given === ''
    ? entity.entityName
    : cleanIdentifier(given);
}
