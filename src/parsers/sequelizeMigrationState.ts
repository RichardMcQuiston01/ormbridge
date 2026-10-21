import { underscore } from './sequelizeInflection.js';
import type {
  FileInfo,
  RawAttribute,
  RawIndex,
  RawIndexField,
} from './sequelizeModel.js';

/**
 * The schema that `sequelize-cli` migrations build up, one `queryInterface` call at a time. The state keeps
 * every column as the `RawAttribute` that `sequelize.define` would have given it, so the reader that turns
 * models into the shared schema also turns a replayed table into one. The functions here know nothing about
 * syntax: they apply a change and return the reason when it does not fit the schema built so far.
 */

export type ConstraintKind =
  'unique' | 'primary key' | 'foreign key' | 'check' | 'default';

/** A named constraint added with `addConstraint` (or `uniqueKeys`), kept so `removeConstraint` can find it. */
export interface StateConstraint {
  kind: ConstraintKind;
  name: string;
  columns: string[];
}

/** An index with the name Sequelize gave it, and whether the migration spelled that name out. */
export interface StateIndex {
  name: string;
  isExplicit: boolean;
  index: RawIndex;
}

export interface StateTable {
  name: string;
  schema?: string;
  /** The migration that created the table. */
  file: FileInfo;
  columns: RawAttribute[];
  indexes: StateIndex[];
  constraints: StateConstraint[];
}

export interface ReplayState {
  /** In creation order; the key is `tableKey(name, schema)`. */
  tables: Map<string, StateTable>;
}

export function tableKey(name: string, schema?: string): string {
  return schema === undefined ? name : `${schema}.${name}`;
}

export function newState(): ReplayState {
  return { tables: new Map() };
}

/** A table by the name a migration uses for it; a bare name also finds a table in a schema when unambiguous. */
export function findTable(
  state: ReplayState,
  name: string,
  schema?: string
): StateTable | undefined {
  const exact: StateTable | undefined = state.tables.get(
    tableKey(name, schema)
  );
  if (exact !== undefined || schema !== undefined) {
    return exact;
  }
  const matches: StateTable[] = [...state.tables.values()].filter(
    (table: StateTable) => table.name === name
  );
  return matches.length === 1 ? matches[0] : undefined;
}

export function findColumn(
  table: StateTable,
  name: string
): RawAttribute | undefined {
  return table.columns.find((column: RawAttribute) => column.name === name);
}

/** `Utils.nameIndex`: the name Sequelize gives an index that has none (`users_first_name`). */
export function defaultIndexName(table: string, fields: string[]): string {
  return underscore(`${table}_${fields.join('_')}`);
}

/** The name `addConstraint` gives a constraint that has none (`users_email_uk`). */
export function defaultConstraintName(
  table: string,
  kind: ConstraintKind,
  columns: string[],
  referencedTable?: string
): string {
  const joined: string = columns.join('_');
  switch (kind) {
    case 'unique':
      return `${table}_${joined}_uk`;
    case 'primary key':
      return `${table}_${joined}_pk`;
    case 'foreign key':
      return `${table}_${joined}_${referencedTable ?? ''}_fk`;
    case 'check':
      return `${table}_${joined}_ck`;
    default:
      return `${table}_${joined}_df`;
  }
}

function sameColumns(first: string[], second: string[]): boolean {
  return (
    first.length === second.length &&
    first.every((name: string, at: number) => name === second[at])
  );
}

/** The columns a table's indexes and constraints list, without the ones that are gone. */
function dropColumnFromLists(table: StateTable, column: string): void {
  table.indexes = table.indexes.filter(
    (entry: StateIndex) =>
      !entry.index.fields.some((field: RawIndexField) => field.name === column)
  );
  table.constraints = table.constraints.filter(
    (constraint: StateConstraint) => !constraint.columns.includes(column)
  );
}

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

/** Adds a table; returns the reason when a table of that name exists already. */
export function createTable(
  state: ReplayState,
  table: StateTable
): string | undefined {
  const key: string = tableKey(table.name, table.schema);
  if (state.tables.has(key)) {
    return `a table named "${table.name}" exists already`;
  }
  state.tables.set(key, table);
  return undefined;
}

/**
 * Removes a table. The foreign keys of other tables that pointed at it stay as plain columns (the database
 * either refuses the drop or, with `cascade`, drops them); their columns are returned for the warning.
 */
export function dropTable(
  state: ReplayState,
  name: string,
  schema?: string
): { dropped: StateTable | undefined; dangling: string[] } {
  const table: StateTable | undefined = findTable(state, name, schema);
  if (table === undefined) {
    return { dropped: undefined, dangling: [] };
  }
  state.tables.delete(tableKey(table.name, table.schema));
  const dangling: string[] = [];
  for (const other of state.tables.values()) {
    for (const column of other.columns) {
      if (referencedTableOf(column) === table.name) {
        delete column.references;
        delete column.onDelete;
        delete column.onUpdate;
        other.constraints = other.constraints.filter(
          (constraint: StateConstraint) =>
            !(
              constraint.kind === 'foreign key' &&
              constraint.columns.includes(column.name)
            )
        );
        dangling.push(`${other.name}.${column.name}`);
      }
    }
  }
  return { dropped: table, dangling };
}

/** Renames a table and every foreign key that points at it; returns the reason when it does not fit. */
export function renameTable(
  state: ReplayState,
  from: string,
  to: string,
  schema?: string
): string | undefined {
  const table: StateTable | undefined = findTable(state, from, schema);
  if (table === undefined) {
    return `the table "${from}" does not exist at this point`;
  }
  const key: string = tableKey(to, table.schema);
  if (state.tables.has(key)) {
    return `a table named "${to}" exists already`;
  }
  // Rebuild the map so the renamed table keeps its place in the creation order.
  const entries: [string, StateTable][] = [...state.tables.entries()];
  state.tables.clear();
  for (const [oldKey, entry] of entries) {
    if (entry === table) {
      table.name = to;
      state.tables.set(key, table);
    } else {
      state.tables.set(oldKey, entry);
    }
  }
  for (const other of state.tables.values()) {
    for (const column of other.columns) {
      if (referencedTableOf(column) === from) {
        setReferencedTable(column, to);
      }
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// References
// ---------------------------------------------------------------------------

/** The table a column's `references` names, when it is a plain name. */
export function referencedTableOf(column: RawAttribute): string | undefined {
  const model = column.references?.model;
  return model !== undefined && model.kind === 'string'
    ? model.value
    : undefined;
}

function setReferencedTable(column: RawAttribute, table: string): void {
  column.references = {
    ...(column.references ?? {}),
    model: { kind: 'string', value: table },
  };
}

// ---------------------------------------------------------------------------
// Columns
// ---------------------------------------------------------------------------

/** Adds a column; returns the reason when the table has a column of that name. */
export function addColumn(
  table: StateTable,
  attribute: RawAttribute
): string | undefined {
  if (findColumn(table, attribute.name) !== undefined) {
    return `a column named "${attribute.name}" exists already`;
  }
  table.columns.push(attribute);
  return undefined;
}

/** Drops a column with the indexes and constraints that use it; returns the reason when there is none. */
export function removeColumn(
  table: StateTable,
  name: string
): string | undefined {
  const column: RawAttribute | undefined = findColumn(table, name);
  if (column === undefined) {
    return `the column "${name}" does not exist at this point`;
  }
  table.columns = table.columns.filter(
    (candidate: RawAttribute) => candidate !== column
  );
  dropColumnFromLists(table, name);
  return undefined;
}

/** Renames a column and everything that lists it; returns the reason when it does not fit. */
export function renameColumn(
  state: ReplayState,
  table: StateTable,
  from: string,
  to: string
): string | undefined {
  const column: RawAttribute | undefined = findColumn(table, from);
  if (column === undefined) {
    return `the column "${from}" does not exist at this point`;
  }
  if (findColumn(table, to) !== undefined) {
    return `a column named "${to}" exists already`;
  }
  column.name = to;
  for (const entry of table.indexes) {
    for (const field of entry.index.fields) {
      if (field.name === from) {
        field.name = to;
      }
    }
    // An unnamed index keeps the name Sequelize derives from its columns.
    if (!entry.isExplicit) {
      entry.name = defaultIndexName(
        table.name,
        entry.index.fields.map((field: RawIndexField) => field.name)
      );
    }
  }
  for (const constraint of table.constraints) {
    constraint.columns = constraint.columns.map((name: string) =>
      name === from ? to : name
    );
  }
  for (const other of state.tables.values()) {
    for (const candidate of other.columns) {
      if (
        referencedTableOf(candidate) === table.name &&
        candidate.references?.key === from
      ) {
        candidate.references = { ...candidate.references, key: to };
      }
    }
  }
  return undefined;
}

/**
 * `changeColumn`: the attributes the call names replace those of the column and the rest stay as they were
 * (SQLite rebuilds the table that way; PostgreSQL also drops an unnamed default and MySQL resets what the call
 * does not name). Returns the reason when the table has no such column.
 */
export function changeColumn(
  table: StateTable,
  name: string,
  changes: RawAttribute,
  named: ReadonlySet<string>
): string | undefined {
  const column: RawAttribute | undefined = findColumn(table, name);
  if (column === undefined) {
    return `the column "${name}" does not exist at this point`;
  }
  if (named.has('type')) {
    if (changes.type !== undefined) {
      column.type = changes.type;
    }
    delete column.enumValues;
    if (changes.enumValues !== undefined) {
      column.enumValues = changes.enumValues;
    }
  }
  const keys: (keyof RawAttribute)[] = [
    'allowNull',
    'primaryKey',
    'autoIncrement',
    'defaultValue',
    'references',
    'onDelete',
    'onUpdate',
    'comment',
  ];
  for (const key of keys) {
    if (named.has(key)) {
      const value: unknown = changes[key];
      if (value === undefined) {
        delete column[key];
      } else {
        (column as unknown as Record<string, unknown>)[key] = value;
      }
    }
  }
  if (named.has('unique')) {
    if (changes.unique === undefined) {
      delete column.unique;
    } else {
      column.unique = changes.unique;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Indexes and constraints
// ---------------------------------------------------------------------------

export function addIndex(
  table: StateTable,
  entry: StateIndex
): string | undefined {
  if (
    table.indexes.some((candidate: StateIndex) => candidate.name === entry.name)
  ) {
    return `an index named "${entry.name}" exists already`;
  }
  table.indexes.push(entry);
  return undefined;
}

/** Removes an index by name, or by the list of columns it covers; returns the reason when none matches. */
export function removeIndex(
  table: StateTable,
  nameOrFields: string | string[]
): string | undefined {
  const at: number = table.indexes.findIndex((entry: StateIndex) =>
    typeof nameOrFields === 'string'
      ? entry.name === nameOrFields
      : sameColumns(
          entry.index.fields.map((field: RawIndexField) => field.name),
          nameOrFields
        )
  );
  if (at === -1) {
    return typeof nameOrFields === 'string'
      ? `no index named "${nameOrFields}" exists at this point`
      : `no index on (${nameOrFields.join(', ')}) exists at this point`;
  }
  table.indexes.splice(at, 1);
  return undefined;
}

/** The constraint that a database invents for a column definition (`users_email_key`, `users_pkey`, ...). */
function inlineConstraint(
  table: StateTable,
  name: string
): { kind: ConstraintKind; columns: string[]; isInline: true } | undefined {
  if (name === `${table.name}_pkey`) {
    const columns: string[] = table.columns
      .filter((column: RawAttribute) => column.primaryKey === true)
      .map((column: RawAttribute) => column.name);
    return columns.length === 0
      ? undefined
      : { kind: 'primary key', columns, isInline: true };
  }
  for (const column of table.columns) {
    if (
      name === `${table.name}_${column.name}_fkey` &&
      column.references !== undefined
    ) {
      return { kind: 'foreign key', columns: [column.name], isInline: true };
    }
    if (
      name === `${table.name}_${column.name}_key` &&
      column.unique !== undefined
    ) {
      return { kind: 'unique', columns: [column.name], isInline: true };
    }
  }
  const mysqlForeign: RegExpExecArray | null = new RegExp(
    `^${table.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}_ibfk_(\\d+)$`
  ).exec(name);
  if (mysqlForeign !== null) {
    const referencing: RawAttribute | undefined = table.columns.filter(
      (column: RawAttribute) => column.references !== undefined
    )[Number(mysqlForeign[1]) - 1];
    return referencing === undefined
      ? undefined
      : { kind: 'foreign key', columns: [referencing.name], isInline: true };
  }
  return undefined;
}

/** Adds a constraint to the list; the caller has applied its effect on the columns. */
export function addConstraint(
  table: StateTable,
  constraint: StateConstraint
): string | undefined {
  if (
    table.constraints.some(
      (candidate: StateConstraint) => candidate.name === constraint.name
    ) ||
    table.indexes.some((entry: StateIndex) => entry.name === constraint.name)
  ) {
    return `a constraint or index named "${constraint.name}" exists already`;
  }
  table.constraints.push(constraint);
  return undefined;
}

/** Removes a constraint by name together with what it enforced; returns the reason when none matches. */
export function removeConstraint(
  table: StateTable,
  name: string
): string | undefined {
  const named: StateConstraint | undefined = table.constraints.find(
    (candidate: StateConstraint) => candidate.name === name
  );
  const found:
    { kind: ConstraintKind; columns: string[]; isInline?: true } | undefined =
    named ?? inlineConstraint(table, name);
  if (found === undefined) {
    return `no constraint named "${name}" exists at this point`;
  }
  table.constraints = table.constraints.filter(
    (candidate: StateConstraint) => candidate !== named
  );
  for (const columnName of found.columns) {
    const column: RawAttribute | undefined = findColumn(table, columnName);
    if (column === undefined) {
      continue;
    }
    if (found.kind === 'primary key') {
      delete column.primaryKey;
      delete column.autoIncrement;
    } else if (found.kind === 'foreign key') {
      delete column.references;
      delete column.onDelete;
      delete column.onUpdate;
    } else if (found.kind === 'unique' && found.isInline === true) {
      delete column.unique;
    } else if (found.kind === 'default') {
      delete column.defaultValue;
    }
  }
  return undefined;
}
