import type { IrOnDelete } from '../ir.js';
import type { CsType, CsValue } from './csharpSyntax.js';

/**
 * The schema as EF Core migrations leave it: what `migrationBuilder` calls build up (the `Up` methods replayed in
 * order) and what a `*ModelSnapshot.cs` says the model is. Both readers fill the same state, so the two can be
 * compared and either can be turned into the shared model.
 */

export interface MigrationColumn {
  /** The database column name. */
  name: string;
  /** The type argument of `table.Column<T>()` / `AddColumn<T>()` / `Property<T>()`. */
  clrType: CsType | undefined;
  /** The database type as the provider wrote it (`nvarchar(450)`, `INTEGER`, `uuid`). */
  storeType?: string;
  isNullable: boolean;
  maxLength?: number;
  precision?: number;
  scale?: number;
  isUnicode?: boolean;
  isRowVersion: boolean;
  defaultValue?: CsValue;
  defaultSql?: string;
  computedSql?: string;
  isStored?: boolean;
  /** An identity, serial or autoincrement column. */
  isIdentity: boolean;
  /** The property name in the model snapshot (differs from the column name when the column is renamed). */
  propertyName?: string;
}

export interface MigrationKey {
  name?: string;
  columns: string[];
}

export interface MigrationIndex extends MigrationKey {
  name: string;
  isUnique: boolean;
  filter?: string;
  includes: string[];
  descending: boolean[];
  method?: string;
}

export interface MigrationForeignKey {
  name: string;
  columns: string[];
  principalSchema?: string;
  principalTable: string;
  principalColumns: string[];
  onDelete: IrOnDelete;
  onUpdate: IrOnDelete;
  /** The navigation property on the dependent entity (model snapshot only). */
  navigation?: string;
  /** The navigation property on the principal entity (model snapshot only). */
  inverseNavigation?: string;
}

export interface MigrationTable {
  schema?: string;
  name: string;
  columns: MigrationColumn[];
  primaryKey?: MigrationKey;
  uniqueKeys: MigrationKey[];
  indexes: MigrationIndex[];
  foreignKeys: MigrationForeignKey[];
  /** Names of the check constraints, which the shared model cannot hold. */
  checkConstraints: string[];
  /** The entity class name (model snapshot only). */
  entityName?: string;
}

/** The tables of the schema, in creation order. */
export type MigrationSchema = Map<string, MigrationTable>;

/** The key of a table in the schema: `schema.name`, or the name alone. */
export function tableKey(schema: string | undefined, name: string): string {
  return schema === undefined || schema === '' ? name : `${schema}.${name}`;
}

export function findColumn(
  table: MigrationTable,
  name: string
): MigrationColumn | undefined {
  return table.columns.find((column: MigrationColumn) => column.name === name);
}

/** The referential actions `ReferentialAction` has. */
const ACTIONS: Readonly<Record<string, IrOnDelete>> = {
  Cascade: 'cascade',
  SetNull: 'setNull',
  Restrict: 'restrict',
  NoAction: 'noAction',
  SetDefault: 'setDefault',
};

/** Maps a `ReferentialAction` member name to the action; undefined for a name EF Core does not have. */
export function referentialAction(name: string): IrOnDelete | undefined {
  return ACTIONS[name];
}

/** The name EF Core gives a primary key, a foreign key, an index or an alternate key unless told otherwise. */
export function conventionalName(
  kind: 'PK' | 'FK' | 'IX' | 'AK',
  table: string,
  columns: readonly string[],
  principal?: string
): string {
  const parts: string[] = [kind, table];
  if (principal !== undefined) {
    parts.push(principal);
  }
  if (kind !== 'PK') {
    parts.push(columns.join('_'));
  }
  return parts.join('_');
}

function replaceAll(names: string[], from: string, to: string): void {
  for (let at: number = 0; at < names.length; at += 1) {
    if (names[at] === from) {
      names[at] = to;
    }
  }
}

/** Renames a column in the table and in every key, index and foreign key that names it. */
export function renameColumn(
  schema: MigrationSchema,
  table: MigrationTable,
  from: string,
  to: string
): void {
  const column: MigrationColumn | undefined = findColumn(table, from);
  if (column !== undefined) {
    column.name = to;
  }
  const lists: string[][] = [
    ...(table.primaryKey === undefined ? [] : [table.primaryKey.columns]),
    ...table.uniqueKeys.map((key: MigrationKey) => key.columns),
    ...table.indexes.map((index: MigrationIndex) => index.columns),
    ...table.indexes.map((index: MigrationIndex) => index.includes),
    ...table.foreignKeys.map((key: MigrationForeignKey) => key.columns),
  ];
  for (const names of lists) {
    replaceAll(names, from, to);
  }
  for (const other of schema.values()) {
    for (const key of other.foreignKeys) {
      if (
        key.principalTable === table.name &&
        key.principalSchema === table.schema
      ) {
        replaceAll(key.principalColumns, from, to);
      }
    }
  }
}

/** Removes a column and the keys, indexes and foreign keys that used it. */
export function dropColumn(table: MigrationTable, name: string): void {
  table.columns = table.columns.filter(
    (column: MigrationColumn) => column.name !== name
  );
  if (table.primaryKey?.columns.includes(name) === true) {
    delete table.primaryKey;
  }
  table.uniqueKeys = table.uniqueKeys.filter(
    (key: MigrationKey) => !key.columns.includes(name)
  );
  table.indexes = table.indexes.filter(
    (index: MigrationIndex) =>
      !index.columns.includes(name) && !index.includes.includes(name)
  );
  table.foreignKeys = table.foreignKeys.filter(
    (key: MigrationForeignKey) => !key.columns.includes(name)
  );
}

/** Renames a table and points the foreign keys of the other tables at the new name. */
export function renameTable(
  schema: MigrationSchema,
  table: MigrationTable,
  newSchema: string | undefined,
  newName: string
): void {
  const oldKey: string = tableKey(table.schema, table.name);
  const oldName: string = table.name;
  const oldSchema: string | undefined = table.schema;
  const entries: [string, MigrationTable][] = [...schema.entries()];
  schema.clear();
  table.name = newName;
  if (newSchema === undefined) {
    delete table.schema;
  } else {
    table.schema = newSchema;
  }
  for (const [key, value] of entries) {
    schema.set(key === oldKey ? tableKey(table.schema, newName) : key, value);
  }
  for (const other of schema.values()) {
    for (const key of other.foreignKeys) {
      if (key.principalTable === oldName && key.principalSchema === oldSchema) {
        key.principalTable = newName;
        if (newSchema === undefined) {
          delete key.principalSchema;
        } else {
          key.principalSchema = newSchema;
        }
      }
    }
  }
}
