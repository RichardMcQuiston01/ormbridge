import type { IrField, IrOnDelete, IrRelation } from '../ir.js';
import { toCamelCase } from '../naming.js';
import type { Ann } from './jpaAnnotations.js';
import type { BuiltField } from './jpaColumns.js';
import type { EntityInfo } from './jpaModel.js';
import type { KeyColumn, Resolver } from './jpaJoins.js';
import { decapitalize, onDeleteAction } from './jpaTypes.js';

/** What the inheritance of an entity adds to its model. */
export interface InheritanceParts {
  leadingFields: IrField[];
  trailingFields: IrField[];
  relations: IrRelation[];
  /** Set when the primary key is the foreign key to the parent table (joined inheritance). */
  primaryKeyRelation?: IrRelation;
}

function descendants(entity: EntityInfo): EntityInfo[] {
  return entity.children.flatMap((child: EntityInfo): EntityInfo[] => [
    child,
    ...descendants(child),
  ]);
}

/** The discriminator value of an entity: `@DiscriminatorValue`, else the entity name. */
function discriminatorValue(entity: EntityInfo): string {
  return (
    entity.notes.get('DiscriminatorValue')?.string('value') ?? entity.entityName
  );
}

/**
 * Reads the inheritance strategy. Single-table subclasses are merged into the root (the discriminator column is
 * added), joined subclasses get the foreign key to their parent as primary key, and table-per-class entities
 * are independent tables; each case warns, because the shared model has no inheritance.
 */
export function inheritanceNotes(
  entity: EntityInfo,
  fields: readonly IrField[],
  resolver: Resolver
): InheritanceParts {
  const parts: InheritanceParts = {
    leadingFields: [],
    trailingFields: [],
    relations: [],
  };
  const warn = resolver.warn;
  if (
    entity.inheritance === 'singleTable' &&
    entity.root === entity &&
    entity.children.length > 0
  ) {
    const column: Ann | undefined = entity.notes.get('DiscriminatorColumn');
    const columnName: string = column?.string('name') || 'DTYPE';
    const kind: string = column?.member('discriminatorType') ?? 'STRING';
    const all: EntityInfo[] = descendants(entity);
    if (entity.notes.has('DiscriminatorFormula', true)) {
      warn(
        `${entity.name}: @DiscriminatorFormula is computed in SQL and has no equivalent; a plain discriminator column was assumed.`
      );
    }
    if (!fields.some((field: IrField) => field.columnName === columnName)) {
      parts.trailingFields.push({
        name: toCamelCase(columnName),
        columnName,
        type: kind === 'INTEGER' ? 'int' : 'string',
        isPrimaryKey: false,
        isUnique: false,
        isNullable: false,
        isAutoUpdated: false,
        ...(kind === 'INTEGER'
          ? {}
          : {
              maxLength: kind === 'CHAR' ? 1 : (column?.number('length') ?? 31),
            }),
      });
    }
    warn(
      `${entity.name}: ${all.map((child: EntityInfo) => child.name).join(', ')} extend${all.length === 1 ? 's' : ''} ${entity.name} in one table (single table inheritance). ` +
        `The hierarchy was read as a single model with the columns of every class and the discriminator column "${columnName}" (values: ${[entity, ...all].map((item: EntityInfo) => `${discriminatorValue(item)} = ${item.name}`).join(', ')}); the subclasses are not separate models. A column that a subclass declares NOT NULL stays NOT NULL, as in the DDL Hibernate writes.`
    );
  }
  if (entity.inheritance === 'joined' && entity.parent !== undefined) {
    const parent: EntityInfo = entity.parent;
    const keys: KeyColumn[] = resolver.keyOf(entity);
    const only: KeyColumn | undefined = keys[0];
    if (only === undefined || keys.length > 1) {
      warn(
        `${entity.name}: the parent ${parent.name} has a composite key; the join to the parent table was not read.`
      );
    } else {
      const name: string = decapitalize(parent.name);
      const action: string | undefined = entity.notes
        .get('OnDelete', true)
        ?.member('action');
      const onDelete: IrOnDelete =
        (action === undefined ? undefined : onDeleteAction(action)) ??
        'noAction';
      const relation: IrRelation = {
        name,
        kind: 'oneToOne',
        targetModel: parent.name,
        columnName: only.columnName,
        isNullable: false,
        onDelete,
        isPrimaryKey: true,
      };
      parts.relations.push(relation);
      parts.primaryKeyRelation = relation;
    }
    warn(
      `${entity.name}: extends ${parent.name} with joined table inheritance. It was read as a model of its own whose primary key is also a foreign key to ${parent.name} (a one-to-one primary key relation); the attributes inherited from ${parent.name} stay on ${parent.name}.`
    );
  }
  if (entity.inheritance === 'joined' && entity.root === entity) {
    const column: Ann | undefined = entity.notes.get('DiscriminatorColumn');
    if (column !== undefined) {
      const columnName: string = column.string('name') || 'DTYPE';
      parts.trailingFields.push({
        name: toCamelCase(columnName),
        columnName,
        type:
          column.member('discriminatorType') === 'INTEGER' ? 'int' : 'string',
        isPrimaryKey: false,
        isUnique: false,
        isNullable: false,
        isAutoUpdated: false,
        maxLength: column.number('length') ?? 31,
      });
    }
  }
  if (entity.inheritance === 'tablePerClass') {
    warn(
      `${entity.name}: table per class inheritance (${entity.parent === undefined ? 'root' : `extends ${entity.parent.name}`}). ${entity.name} was read as an independent table with all inherited columns; the shared model does not link it to the other classes of the hierarchy.`
    );
  }
  return parts;
}

/** Warns about table-level settings that have no place in the shared model. */
export function tableNotes(
  entity: EntityInfo,
  built: readonly BuiltField[],
  warn: (message: string) => void
): void {
  const notes = entity.notes;
  const place: string = entity.name;
  if (notes.has('SecondaryTable') || notes.has('SecondaryTables')) {
    warn(
      `${place}: @SecondaryTable stores some attributes in a second table; all attributes were read into the primary table.`
    );
  }
  if (notes.has('Check', true) || notes.has('Checks', true)) {
    warn(
      `${place}: the @Check constraint has no equivalent in the shared model and was dropped.`
    );
  }
  const comments: string[] = built
    .filter((item: BuiltField) => item.member.attr.notes.has('Comment', true))
    .map((item: BuiltField) => item.member.attr.name);
  if (notes.has('Comment', true) || notes.get('Table', true)?.has('comment')) {
    comments.unshift('the table');
  }
  if (comments.length > 0) {
    warn(`${place}: comments (${comments.join(', ')}) are not preserved.`);
  }
  const checks: string[] = built
    .filter((item: BuiltField) => item.member.attr.notes.has('Check', true))
    .map((item: BuiltField) => item.member.attr.name);
  if (checks.length > 0) {
    warn(
      `${place}: the @Check constraints on ${checks.join(', ')} have no equivalent in the shared model and were dropped.`
    );
  }
  if (notes.has('SqlResultSetMapping') || notes.has('SqlResultSetMappings')) {
    warn(
      `${place}: @SqlResultSetMapping maps query results, not tables, and was ignored.`
    );
  }
  if (notes.has('Audited', true) || notes.has('Audited')) {
    warn(
      `${place}: @Audited (Hibernate Envers) also creates an audit table and a revision table, which are not read.`
    );
  }
  if (
    built.some((item: BuiltField) =>
      item.member.attr.notes.has('TenantId', true)
    )
  ) {
    warn(
      `${place}: a @TenantId column is part of the table; it was read as an ordinary column of the attribute's type.`
    );
  }
}
