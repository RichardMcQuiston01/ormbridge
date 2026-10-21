import type {
  IrCompositeForeignKey,
  IrDefault,
  IrField,
  IrIndex,
  IrIndexFieldOptions,
  IrModel,
  IrRelation,
  IrSchema,
  IrScalarType,
} from '../ir.js';
import {
  singularize,
  toCamelCase,
  toPascalCase,
  toSnakeCase,
} from '../naming.js';
import type { CsValue } from './csharpSyntax.js';
import { INDEX_METHODS } from './efcoreBuild.js';
import {
  conventionalName,
  findColumn,
  tableKey,
  type MigrationColumn,
  type MigrationForeignKey,
  type MigrationIndex,
  type MigrationKey,
  type MigrationSchema,
  type MigrationTable,
} from './efcoreMigrationState.js';
import {
  clrColumn,
  sqlColumn,
  sqlDefault,
  type ColumnShape,
} from './efcoreTypes.js';

/** Store types that SQLite uses for everything: the CLR type says more. */
const GENERIC_STORE_TYPES: ReadonlySet<string> = new Set([
  'text',
  'integer',
  'real',
  'blob',
  'numeric',
]);

function stripKeySuffix(name: string): string {
  const stripped: string = name.replace(/(?:Id|ID|_id)$/, '');
  return stripped === '' ? name : stripped;
}

/** The primary key columns of a table; empty when it has none. */
function keyColumnsOf(table: MigrationTable): string[] {
  return table.primaryKey?.columns ?? [];
}

// ---------------------------------------------------------------------------
// Comparing the replay with the model snapshot
// ---------------------------------------------------------------------------

function describeTable(
  table: MigrationTable,
  schema: MigrationSchema
): Map<string, string> {
  const facts: Map<string, string> = new Map();
  for (const column of table.columns) {
    facts.set(
      `column ${column.name}`,
      column.isNullable ? 'nullable' : 'not null'
    );
  }
  facts.set('primary key', keyColumnsOf(table).join(', ') || 'none');
  for (const key of table.foreignKeys) {
    const principal: MigrationTable | undefined = schema.get(
      tableKey(key.principalSchema, key.principalTable)
    );
    const columns: string =
      key.principalColumns.length > 0
        ? key.principalColumns.join(', ')
        : keyColumnsOf(principal ?? table).join(', ');
    facts.set(
      `foreign key (${key.columns.join(', ')})`,
      `to ${key.principalTable} (${columns}), on delete ${key.onDelete}`
    );
  }
  for (const index of table.indexes) {
    facts.set(
      `${index.isUnique ? 'unique index' : 'index'} (${index.columns.join(', ')})`,
      'present'
    );
  }
  for (const key of table.uniqueKeys) {
    facts.set(`unique key (${key.columns.join(', ')})`, 'present');
  }
  return facts;
}

/**
 * What differs between the schema the migrations build and the one the model snapshot describes, at the level the
 * shared model keeps: tables, columns and whether they allow null, the primary key, foreign keys with their actions
 * and indexes. An empty list means they agree.
 */
export function describeDifferences(
  replayed: MigrationSchema,
  snapshot: MigrationSchema
): string[] {
  const differences: string[] = [];
  const keys: Set<string> = new Set([...replayed.keys(), ...snapshot.keys()]);
  for (const key of keys) {
    const left: MigrationTable | undefined = replayed.get(key);
    const right: MigrationTable | undefined = snapshot.get(key);
    if (left === undefined || right === undefined) {
      differences.push(
        `the table "${key}" is only in the ${left === undefined ? 'model snapshot' : 'migrations'}`
      );
      continue;
    }
    const leftFacts: Map<string, string> = describeTable(left, replayed);
    const rightFacts: Map<string, string> = describeTable(right, snapshot);
    for (const [fact, value] of leftFacts) {
      const other: string | undefined = rightFacts.get(fact);
      if (other === undefined) {
        differences.push(`"${key}": ${fact} is only in the migrations`);
      } else if (other !== value) {
        differences.push(
          `"${key}": ${fact} is ${value} in the migrations and ${other} in the model snapshot`
        );
      }
    }
    for (const fact of rightFacts.keys()) {
      if (!leftFacts.has(fact)) {
        differences.push(`"${key}": ${fact} is only in the model snapshot`);
      }
    }
  }
  return differences;
}

/** Copies the names the model snapshot knows (entity, property and navigation names) onto the replayed schema. */
export function applySnapshotNames(
  replayed: MigrationSchema,
  snapshot: MigrationSchema
): void {
  for (const [key, table] of replayed) {
    const known: MigrationTable | undefined = snapshot.get(key);
    if (known === undefined) {
      continue;
    }
    if (known.entityName !== undefined) {
      table.entityName = known.entityName;
    }
    for (const column of table.columns) {
      const match: MigrationColumn | undefined = findColumn(known, column.name);
      if (match?.propertyName !== undefined) {
        column.propertyName = match.propertyName;
      }
    }
    for (const foreignKey of table.foreignKeys) {
      const match: MigrationForeignKey | undefined = known.foreignKeys.find(
        (item: MigrationForeignKey) =>
          item.columns.join(',') === foreignKey.columns.join(',') &&
          item.principalTable === foreignKey.principalTable
      );
      if (match?.navigation !== undefined) {
        foreignKey.navigation = match.navigation;
      }
      if (match?.inverseNavigation !== undefined) {
        foreignKey.inverseNavigation = match.inverseNavigation;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Columns
// ---------------------------------------------------------------------------

/** Maps the CLR type and the database type of a column to a column of the shared model. */
function shapeOf(column: MigrationColumn): ColumnShape | undefined {
  const fromClr: ColumnShape | undefined =
    column.clrType === undefined
      ? undefined
      : clrColumn({ ...column.clrType, nullable: false });
  const fromStore: ColumnShape | undefined =
    column.storeType === undefined ? undefined : sqlColumn(column.storeType);
  if (fromStore === undefined) {
    return fromClr;
  }
  if (fromClr === undefined) {
    return fromStore;
  }
  const storeName: string = (column.storeType ?? '').trim().toLowerCase();
  if (GENERIC_STORE_TYPES.has(storeName)) {
    return fromClr;
  }
  if (fromClr.type === 'text' || fromClr.type === 'string') {
    return fromStore;
  }
  if (
    fromClr.type === 'dateTime' &&
    (fromStore.type === 'date' || fromStore.type === 'time')
  ) {
    return fromStore;
  }
  if (fromClr.type === 'decimal') {
    return { ...fromClr, ...fromStore, type: 'decimal' };
  }
  if (fromClr.type === 'uuid' || fromClr.type === 'boolean') {
    return fromClr;
  }
  return fromClr.arrayDepth === undefined && fromStore.arrayDepth !== undefined
    ? { ...fromClr, arrayDepth: fromStore.arrayDepth }
    : fromClr;
}

const DATE_TIME_CONSTRUCTOR: RegExp =
  /^new\s+DateTime(?:Offset)?\(\s*(\d+),\s*(\d+),\s*(\d+)(?:,\s*(\d+),\s*(\d+),\s*(\d+))?/;
const GUID_CONSTRUCTOR: RegExp = /^new\s+Guid\(\s*"([0-9a-fA-F-]{36})"\s*\)$/;

function twoDigits(value: string | undefined): string {
  return (value ?? '0').padStart(2, '0');
}

/** Maps the default a migration gives a column (`defaultValue:` or `defaultValueSql:`) to a default. */
function defaultOf(
  column: MigrationColumn,
  type: IrScalarType,
  place: string,
  warn: (message: string) => void
): IrDefault | undefined {
  if (column.defaultSql !== undefined) {
    return sqlDefault(column.defaultSql, type);
  }
  const value: CsValue | undefined = column.defaultValue;
  if (value === undefined) {
    return undefined;
  }
  switch (value.kind) {
    case 'string':
    case 'bool':
      return { kind: 'literal', value: value.value };
    case 'number':
      return { kind: 'literal', value: value.value };
    case 'member': {
      const last: string = value.path[value.path.length - 1] ?? '';
      if (/^(?:Now|UtcNow|Today)$/.test(last)) {
        return { kind: 'now' };
      }
      break;
    }
    case 'other': {
      const guid: RegExpExecArray | null = GUID_CONSTRUCTOR.exec(value.text);
      if (guid?.[1] !== undefined) {
        return { kind: 'literal', value: guid[1] };
      }
      const time: RegExpExecArray | null = DATE_TIME_CONSTRUCTOR.exec(
        value.text
      );
      if (time !== null) {
        const date: string = `${time[1]?.padStart(4, '0')}-${twoDigits(time[2])}-${twoDigits(time[3])}`;
        return {
          kind: 'literal',
          value:
            type === 'date'
              ? date
              : `${date}T${twoDigits(time[4])}:${twoDigits(time[5])}:${twoDigits(time[6])}`,
        };
      }
      break;
    }
    default:
      break;
  }
  warn(
    `${place}: the default value "${value.kind === 'other' ? value.text : value.kind}" cannot be evaluated statically and was dropped.`
  );
  return undefined;
}

function isIntegerShape(shape: ColumnShape): boolean {
  return (
    (shape.type === 'int' || shape.type === 'bigInt') &&
    shape.arrayDepth === undefined
  );
}

/** Builds the field of one column. `isKey` is true when the column is part of the primary key. */
function buildField(
  column: MigrationColumn,
  fieldName: string,
  isSoleKey: boolean,
  isKey: boolean,
  place: string,
  warn: (message: string) => void
): IrField {
  let shape: ColumnShape | undefined = shapeOf(column);
  if (shape === undefined) {
    const raw: string = column.storeType ?? column.clrType?.text ?? 'unknown';
    shape = { type: 'unsupported', unsupportedType: raw };
    warn(
      `${place}: the type ${raw} has no column type in the shared model; the column is read as unsupported (${raw}).`
    );
  }
  let type: IrScalarType = shape.type;
  let maxLength: number | undefined = shape.maxLength;
  if (
    column.maxLength !== undefined &&
    (type === 'text' || type === 'string')
  ) {
    type = 'string';
    maxLength = column.maxLength;
  }
  let maxDigits: number | undefined = shape.maxDigits;
  let decimalPlaces: number | undefined = shape.decimalPlaces;
  if (type === 'decimal' && column.precision !== undefined) {
    maxDigits = column.precision;
    decimalPlaces = column.scale ?? 0;
  }
  let generated: IrField['generated'];
  if (column.computedSql !== undefined) {
    generated = {
      expression: column.computedSql,
      isStored: column.isStored === true,
    };
  }
  let defaultValue: IrDefault | undefined;
  if (generated === undefined) {
    defaultValue = defaultOf(column, type, place, warn);
    if (
      defaultValue === undefined &&
      column.isIdentity &&
      isIntegerShape(shape)
    ) {
      defaultValue = { kind: 'autoIncrement' };
    }
  }
  return {
    name: fieldName,
    columnName: column.name,
    type,
    isPrimaryKey: isSoleKey,
    isUnique: false,
    isNullable: isKey ? false : column.isNullable,
    isAutoUpdated: false,
    ...(defaultValue === undefined ? {} : { default: defaultValue }),
    ...(maxLength === undefined || type !== 'string' ? {} : { maxLength }),
    ...(type === 'decimal' && maxDigits !== undefined ? { maxDigits } : {}),
    ...(type === 'decimal' && decimalPlaces !== undefined
      ? { decimalPlaces }
      : {}),
    ...(shape.arrayDepth === undefined ? {} : { arrayDepth: shape.arrayDepth }),
    ...(type === 'unsupported' && shape.unsupportedType !== undefined
      ? { unsupportedType: shape.unsupportedType }
      : {}),
    ...(generated === undefined ? {} : { generated }),
  };
}

// ---------------------------------------------------------------------------
// Tables to models
// ---------------------------------------------------------------------------

/** The next free name: `Name`, then `Name2`, `Name3`. */
function freeName(base: string, taken: Set<string>): string {
  let name: string = base;
  for (let suffix: number = 2; taken.has(name); suffix += 1) {
    name = `${base}${suffix}`;
  }
  taken.add(name);
  return name;
}

function modelNameFor(table: MigrationTable, taken: Set<string>): string {
  let base: string =
    table.entityName ?? toPascalCase(singularize(toSnakeCase(table.name)));
  if (base === '') {
    base = 'Model';
  }
  if (/^\d/.test(base)) {
    base = `T${base}`;
  }
  if (taken.has(base) && table.schema !== undefined) {
    base = `${toPascalCase(table.schema)}${base}`;
  }
  return freeName(base, taken);
}

interface Resolved {
  foreignKey: MigrationForeignKey;
  principal: MigrationTable;
  principalColumns: string[];
}

/** The foreign keys of a table whose principal table exists, with the referenced columns filled in. */
function resolveForeignKeys(
  table: MigrationTable,
  schema: MigrationSchema,
  warn: (message: string) => void
): Resolved[] {
  const resolved: Resolved[] = [];
  for (const foreignKey of table.foreignKeys) {
    const principal: MigrationTable | undefined = schema.get(
      tableKey(foreignKey.principalSchema, foreignKey.principalTable)
    );
    if (principal === undefined) {
      warn(
        `${table.name}: the foreign key ${foreignKey.name === '' ? `(${foreignKey.columns.join(', ')})` : `"${foreignKey.name}"`} refers to the table "${foreignKey.principalTable}", which the migrations do not create; it was skipped.`
      );
      continue;
    }
    const principalColumns: string[] =
      foreignKey.principalColumns.length > 0
        ? foreignKey.principalColumns
        : keyColumnsOf(principal);
    if (principalColumns.length !== foreignKey.columns.length) {
      warn(
        `${table.name}: the foreign key (${foreignKey.columns.join(', ')}) to "${principal.name}" does not reference as many columns as it has, so it was skipped.`
      );
      continue;
    }
    resolved.push({ foreignKey, principal, principalColumns });
  }
  return resolved;
}

function columnLabel(column: MigrationColumn): string {
  return (column.propertyName ?? column.name).replace(/\./g, '_');
}

/** Turns the schema the migrations (or the model snapshot) describe into the shared model. */
export function buildMigrationSchema(
  schema: MigrationSchema,
  options: { appLabel: string },
  warnings: string[]
): IrSchema {
  const warn = (message: string): void => {
    warnings.push(message);
  };
  const taken: Set<string> = new Set();
  const modelNames: Map<MigrationTable, string> = new Map();
  const fieldNames: Map<MigrationTable, Map<string, string>> = new Map();
  for (const table of schema.values()) {
    modelNames.set(table, modelNameFor(table, taken));
    const names: Set<string> = new Set();
    const columns: Map<string, string> = new Map();
    for (const column of table.columns) {
      columns.set(
        column.name,
        freeName(toCamelCase(columnLabel(column)) || 'column', names)
      );
    }
    fieldNames.set(table, columns);
  }

  const models: IrModel[] = [];
  const relationNames: Map<MigrationTable, Map<string, string>> = new Map();
  const pendingReferences: (() => void)[] = [];
  for (const table of schema.values()) {
    const place: string = table.name;
    const names: Map<string, string> = fieldNames.get(table) ?? new Map();
    const key: string[] = keyColumnsOf(table);
    const resolved: Resolved[] = resolveForeignKeys(table, schema, warn);
    const fields: IrField[] = [];
    const fieldOf: Map<string, IrField> = new Map();
    for (const column of table.columns) {
      const field: IrField = buildField(
        column,
        names.get(column.name) ?? column.name,
        key.length === 1 && key[0] === column.name,
        key.includes(column.name),
        `${place}.${column.name}`,
        warn
      );
      fields.push(field);
      fieldOf.set(column.name, field);
      if (column.isRowVersion) {
        warn(
          `${place}.${column.name}: the row version has no equivalent in the shared model; it was read as an ordinary column.`
        );
      }
    }
    const nonUnicode: string[] = table.columns
      .filter((column: MigrationColumn) => column.isUnicode === false)
      .map((column: MigrationColumn) => column.name);
    if (nonUnicode.length > 0) {
      warn(
        `${place}: the columns ${nonUnicode.join(', ')} are not Unicode (varchar instead of nvarchar); the shared model does not tell the two apart.`
      );
    }
    for (const check of table.checkConstraints) {
      warn(
        `${place}: the check constraint "${check}" has no equivalent in the shared model and was dropped.`
      );
    }

    // Foreign keys ---------------------------------------------------------------------------
    const relations: IrRelation[] = [];
    const compositeKeys: IrCompositeForeignKey[] = [];
    const consumed: Set<string> = new Set();
    const relationOf: Map<string, string> = new Map();
    const usedNames: Set<string> = new Set(names.values());
    const uniqueColumns: Set<string> = new Set();
    for (const unique of table.indexes.filter(
      (index: MigrationIndex) => index.isUnique && index.filter === undefined
    )) {
      uniqueColumns.add(unique.columns.join(','));
    }
    for (const unique of table.uniqueKeys) {
      uniqueColumns.add(unique.columns.join(','));
    }
    for (const { foreignKey, principal, principalColumns } of resolved) {
      const members: (MigrationColumn | undefined)[] = foreignKey.columns.map(
        (name: string) => findColumn(table, name)
      );
      const first: MigrationColumn | undefined = members[0];
      if (first === undefined || members.some((item) => item === undefined)) {
        warn(
          `${place}: the foreign key (${foreignKey.columns.join(', ')}) names a column that the table does not have, so it was skipped.`
        );
        continue;
      }
      const baseName: string = toCamelCase(
        foreignKey.navigation ?? stripKeySuffix(columnLabel(first))
      );
      let relationName: string = baseName === '' ? 'ref' : baseName;
      const ownField: string | undefined = names.get(first.name);
      while (
        usedNames.has(relationName) &&
        !(foreignKey.columns.length === 1 && ownField === relationName)
      ) {
        relationName = `${relationName}Ref`;
      }
      const isRequired: boolean = members.every(
        (item) => item !== undefined && !item.isNullable
      );
      const isUnique: boolean =
        uniqueColumns.has(foreignKey.columns.join(',')) ||
        (key.length === foreignKey.columns.length &&
          key.every((name: string) => foreignKey.columns.includes(name)));
      const kind: 'foreignKey' | 'oneToOne' = isUnique
        ? 'oneToOne'
        : 'foreignKey';
      const targetName: string = modelNames.get(principal) ?? principal.name;
      const targetFields: Map<string, string> =
        fieldNames.get(principal) ?? new Map();
      const principalKey: string[] = keyColumnsOf(principal);
      const referencesKey: boolean =
        principalKey.length === principalColumns.length &&
        principalKey.every(
          (name: string, position: number) =>
            principalColumns[position] === name
        );
      const relatedName: string | undefined =
        foreignKey.inverseNavigation === undefined
          ? undefined
          : toCamelCase(foreignKey.inverseNavigation);
      const defaultName: string = conventionalName(
        'FK',
        table.name,
        foreignKey.columns,
        principal.name
      );
      const constraintName: string | undefined =
        foreignKey.name === '' || foreignKey.name === defaultName
          ? undefined
          : foreignKey.name;
      if (foreignKey.columns.length > 1) {
        const composite: IrCompositeForeignKey = {
          name: relationName,
          targetModel: targetName,
          fields: foreignKey.columns.map(
            (name: string) => names.get(name) ?? name
          ),
          references: [],
          kind,
          isNullable: !isRequired,
          onDelete: foreignKey.onDelete,
          ...(foreignKey.onUpdate === 'noAction'
            ? {}
            : { onUpdate: foreignKey.onUpdate }),
          ...(relatedName === undefined ? {} : { relatedName }),
          ...(constraintName === undefined ? {} : { constraintName }),
        };
        // A key column of the principal that is a foreign key there is named by its relation, which is only
        // known once the principal is built.
        pendingReferences.push(() => {
          composite.references = principalColumns.map(
            (name: string) =>
              relationNames.get(principal)?.get(name) ??
              targetFields.get(name) ??
              name
          );
        });
        compositeKeys.push(composite);
        usedNames.add(relationName);
        continue;
      }
      const isKeyColumn: boolean = key.length === 1 && key[0] === first.name;
      relations.push({
        name: relationName,
        kind,
        targetModel: targetName,
        columnName: first.name,
        isNullable: isKeyColumn ? false : !isRequired,
        onDelete: foreignKey.onDelete,
        ...(relatedName === undefined ? {} : { relatedName }),
        ...(referencesKey || principalColumns[0] === undefined
          ? {}
          : { toField: principalColumns[0] }),
        ...(isKeyColumn ? { isPrimaryKey: true } : {}),
        ...(foreignKey.onUpdate === 'noAction'
          ? {}
          : { onUpdate: foreignKey.onUpdate }),
        ...(constraintName === undefined ? {} : { constraintName }),
      });
      usedNames.add(relationName);
      consumed.add(first.name);
      relationOf.set(first.name, relationName);
    }
    relationNames.set(table, relationOf);
    const nameOf = (column: string): string =>
      relationOf.get(column) ?? names.get(column) ?? column;

    // Primary key --------------------------------------------------------------------------------
    let compositePrimaryKey: string[] | undefined;
    if (key.length === 0) {
      warn(
        `${place}: the table has no primary key; other formats expect every model to have one.`
      );
    } else if (key.length > 1) {
      compositePrimaryKey = key.map(nameOf);
      for (const name of key) {
        const field: IrField | undefined = fieldOf.get(name);
        if (field !== undefined) {
          field.isPrimaryKey = false;
        }
      }
    }
    const primaryKeyName: string | undefined =
      table.primaryKey?.name === undefined ||
      table.primaryKey.name === conventionalName('PK', table.name, key)
        ? undefined
        : table.primaryKey.name;

    // Indexes ---------------------------------------------------------------------------------------
    const indexes: IrIndex[] = [];
    const foreignKeyColumns: Set<string> = new Set(
      resolved.map(({ foreignKey }) => foreignKey.columns.join(','))
    );
    const unnamed = (
      kind: 'IX' | 'AK',
      entry: MigrationKey & { name?: string }
    ): boolean =>
      entry.name === undefined ||
      entry.name === conventionalName(kind, table.name, entry.columns);
    const addUnique = (columns: string[], name: string | undefined): void => {
      const only: string | undefined = columns[0];
      if (columns.length === 1 && only !== undefined && name === undefined) {
        if (consumed.has(only)) {
          return;
        }
        const field: IrField | undefined = fieldOf.get(only);
        if (field !== undefined) {
          if (!field.isPrimaryKey) {
            field.isUnique = true;
          }
          return;
        }
      }
      indexes.push({
        fields: columns.map(nameOf),
        isUnique: true,
        ...(name === undefined ? {} : { name }),
      });
    };
    for (const index of table.indexes) {
      const label: string = ` "${index.name}"`;
      const joined: string = index.columns.join(',');
      const isAutomatic: boolean =
        !index.isUnique &&
        unnamed('IX', index) &&
        foreignKeyColumns.has(joined);
      if (isAutomatic) {
        continue;
      }
      if (index.filter !== undefined) {
        warn(
          `${place}: the index${label} has a filter (a partial index), which is not preserved; it was read as a full index.`
        );
      }
      if (index.includes.length > 0) {
        warn(
          `${place}: the index${label} includes extra columns (IncludeColumns), which are not preserved.`
        );
      }
      const method: string | undefined =
        index.method === undefined
          ? undefined
          : INDEX_METHODS[index.method.toLowerCase()];
      if (index.method !== undefined && method === undefined) {
        warn(
          `${place}: the index method "${index.method}" has no equivalent and was ignored.`
        );
      }
      const fieldOptions: Record<string, IrIndexFieldOptions> = {};
      index.descending.forEach((flag: boolean, position: number) => {
        const column: string | undefined = index.columns[position];
        if (flag && column !== undefined) {
          fieldOptions[nameOf(column)] = { sort: 'desc' };
        }
      });
      const plain: boolean =
        method === undefined && Object.keys(fieldOptions).length === 0;
      if (index.isUnique && plain) {
        addUnique(index.columns, unnamed('IX', index) ? undefined : index.name);
        continue;
      }
      indexes.push({
        fields: index.columns.map(nameOf),
        isUnique: index.isUnique,
        ...(unnamed('IX', index) ? {} : { name: index.name }),
        ...(method === undefined ? {} : { method }),
        ...(Object.keys(fieldOptions).length === 0 ? {} : { fieldOptions }),
      });
    }
    for (const unique of table.uniqueKeys) {
      addUnique(
        unique.columns,
        unnamed('AK', unique) ? undefined : unique.name
      );
    }

    models.push({
      name: modelNames.get(table) ?? table.name,
      tableName: table.name,
      appLabel: options.appLabel,
      fields: fields.filter(
        (field: IrField) => !consumed.has(field.columnName)
      ),
      relations,
      indexes,
      ...(compositePrimaryKey === undefined ? {} : { compositePrimaryKey }),
      ...(compositeKeys.length === 0
        ? {}
        : { compositeForeignKeys: compositeKeys }),
      ...(table.schema === undefined ? {} : { schema: table.schema }),
      ...(primaryKeyName === undefined ? {} : { primaryKeyName }),
    });
  }
  for (const resolve of pendingReferences) {
    resolve();
  }
  return { models, enums: [], warnings };
}
