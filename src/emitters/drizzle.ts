import type {
  IrDefault,
  IrEnum,
  IrEnumValue,
  IrField,
  IrIndex,
  IrModel,
  IrOnDelete,
  IrRelation,
  IrSchema,
} from '../ir.js';
import { findModel } from '../ir.js';
import {
  limitIdentifier,
  toCamelCase,
  toPascalCase,
  toSnakeCase,
} from '../naming.js';
import { prismaOnlyWarnings } from '../prismaOnlyConstructs.js';
import {
  expandManyToMany,
  normalizeSchema,
  type NamingMode,
} from '../transforms.js';
import type { MultiFileEmitOutput } from '../formats.js';
import type { PrismaProvider } from './prisma.js';

export interface DrizzleEmitOptions {
  /** Database provider; picks the Drizzle dialect (`pg-core`, `mysql-core` or `sqlite-core`). */
  provider: PrismaProvider;
  /**
   * "preserve" keeps the database names of the source as the string argument of every builder;
   * "normalize" applies the fresh-schema style of the other emitters. TypeScript keys are camelCase
   * in both modes.
   */
  naming: NamingMode;
}

/** The generated Drizzle schema file. */
export const DRIZZLE_SCHEMA_FILE: string = 'schema.ts';
/** The generated drizzle-kit configuration, so `npx drizzle-kit generate` works next to the schema. */
export const DRIZZLE_CONFIG_FILE: string = 'drizzle.config.ts';

type Dialect = 'pg' | 'mysql' | 'sqlite';

interface DialectInfo {
  /** Module the column builders come from. */
  module: string;
  tableFunction: string;
  /** Type of a column, used to annotate references that point at a table declared later. */
  anyColumnType: string;
  /** The `dialect` value of drizzle.config.ts. */
  kitDialect: string;
}

const DIALECTS: Readonly<Record<Dialect, DialectInfo>> = {
  pg: {
    module: 'drizzle-orm/pg-core',
    tableFunction: 'pgTable',
    anyColumnType: 'AnyPgColumn',
    kitDialect: 'postgresql',
  },
  mysql: {
    module: 'drizzle-orm/mysql-core',
    tableFunction: 'mysqlTable',
    anyColumnType: 'AnyMySqlColumn',
    kitDialect: 'mysql',
  },
  sqlite: {
    module: 'drizzle-orm/sqlite-core',
    tableFunction: 'sqliteTable',
    anyColumnType: 'AnySQLiteColumn',
    kitDialect: 'sqlite',
  },
};

/** Per-table naming decisions, made before anything is written so that relations can point anywhere. */
interface TableInfo {
  model: IrModel;
  /** TypeScript variable that holds the table. */
  variable: string;
  /** Variable that holds the `relations()` object. */
  relationsVariable: string;
  typeName: string;
  insertTypeName: string;
  /** Field name -> property key of the column. */
  fieldKeys: Map<string, string>;
  /** Relation name -> property key of its foreign-key column (not for many-to-many). */
  columnKeys: Map<string, string>;
  /** Relation name -> key of the relation in `relations()`. */
  relationKeys: Map<string, string>;
  /** Every property key in use (columns and relations share the namespace of query results). */
  used: Set<string>;
  /** Position in the output; references to a later (or the same) table need a type annotation. */
  position: number;
}

interface EnumInfo {
  definition: IrEnum;
  /** `as const` array of the stored values. */
  valuesName: string;
  /** PostgreSQL only: the `pgEnum` constant. */
  enumName: string;
  typeName: string;
  /** Database type name (PostgreSQL). */
  dbName: string;
}

interface RelationEntry {
  /** Key inside the relations object. */
  key: string;
  /** `one` / `many` call text without the key. */
  text: string[];
  helper: 'one' | 'many';
}

/** A column that a foreign key points at. */
interface ColumnReference {
  table: TableInfo;
  key: string;
  field: IrField;
}

interface EmitContext {
  schema: IrSchema;
  options: DrizzleEmitOptions;
  dialect: Dialect;
  warnings: string[];
  /** Names imported from the dialect module. */
  imports: Set<string>;
  /** Names imported with `type`. */
  typeImports: Set<string>;
  /** Names imported from `drizzle-orm`. */
  coreImports: Set<string>;
  /** Helper `customType` declarations the output needs, by helper name. */
  helpers: Set<string>;
  tables: Map<string, TableInfo>;
  enums: Map<string, EnumInfo>;
  /** Top-level identifiers already taken. */
  reserved: Set<string>;
  /** Index names already used (they share one namespace per schema). */
  indexNames: Set<string>;
  /** Unordered model pairs joined by more than one relation (those need `relationName`). */
  ambiguousPairs: Set<string>;
  /** "Model.relation" -> key of the inverse side on the target table. */
  inverseKeys: Map<string, string>;
}

const IDENTIFIER_PATTERN: RegExp = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const MAX_LINE_WIDTH: number = 80;
const MAX_INDEX_NAME_LENGTH: number = 63;

/** Names the generated file declares or imports, plus words that cannot be variable names. */
const RESERVED_NAMES: readonly string[] = [
  'AnyMySqlColumn',
  'AnyPgColumn',
  'AnySQLiteColumn',
  'Buffer',
  'Date',
  'JSON',
  'Object',
  'String',
  'bigint',
  'bigserial',
  'blob',
  'boolean',
  'bytea',
  'char',
  'cidr',
  'crypto',
  'customType',
  'date',
  'datetime',
  'decimal',
  'defineConfig',
  'double',
  'doublePrecision',
  'hstore',
  'inet',
  'index',
  'int',
  'int4range',
  'int8range',
  'integer',
  'interval',
  'json',
  'jsonb',
  'many',
  'mysqlEnum',
  'mysqlTable',
  'numeric',
  'numrange',
  'one',
  'pgEnum',
  'pgTable',
  'primaryKey',
  'real',
  'relations',
  'serial',
  'sql',
  'sqliteTable',
  'table',
  'text',
  'time',
  'timestamp',
  'tstzrange',
  'daterange',
  'unique',
  'uniqueIndex',
  'uuid',
  'varchar',
  // JavaScript reserved words.
  'await',
  'break',
  'case',
  'catch',
  'class',
  'const',
  'continue',
  'debugger',
  'default',
  'delete',
  'do',
  'else',
  'enum',
  'export',
  'extends',
  'false',
  'finally',
  'for',
  'function',
  'if',
  'implements',
  'import',
  'in',
  'instanceof',
  'interface',
  'let',
  'new',
  'null',
  'package',
  'private',
  'protected',
  'public',
  'return',
  'static',
  'super',
  'switch',
  'this',
  'throw',
  'true',
  'try',
  'typeof',
  'var',
  'void',
  'while',
  'with',
  'yield',
];

const REFERENTIAL_ACTIONS: Readonly<Record<IrOnDelete, string | undefined>> = {
  cascade: 'cascade',
  setNull: 'set null',
  restrict: 'restrict',
  // The database default; Drizzle only needs the option for the other actions.
  noAction: undefined,
  setDefault: 'set default',
};

const POSTGRES_RANGE_TYPES: Readonly<Record<string, string>> = {
  int: 'int4range',
  bigInt: 'int8range',
  decimal: 'numrange',
  date: 'daterange',
  dateTime: 'tstzrange',
};

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function emitDrizzle(
  schema: IrSchema,
  options: DrizzleEmitOptions
): MultiFileEmitOutput {
  // Drizzle has no many-to-many field: the join table is an ordinary table.
  const expanded: IrSchema = expandManyToMany(schema);
  const prepared: IrSchema =
    options.naming === 'normalize' ? normalizeSchema(expanded) : expanded;
  const dialect: Dialect = dialectOf(options.provider);
  const context: EmitContext = {
    schema: prepared,
    options,
    dialect,
    // Drizzle writes referential actions on update, so that Prisma-only note does not apply.
    warnings: prismaOnlyWarnings(prepared).filter(
      (warning: string) => !warning.includes('the onUpdate action')
    ),
    imports: new Set<string>(),
    typeImports: new Set<string>(),
    coreImports: new Set<string>(),
    helpers: new Set<string>(),
    tables: new Map<string, TableInfo>(),
    enums: new Map<string, EnumInfo>(),
    reserved: new Set<string>(RESERVED_NAMES),
    indexNames: new Set<string>(),
    ambiguousPairs: new Set<string>(),
    inverseKeys: new Map<string, string>(),
  };
  warnAboutProvider(context);

  allocateEnums(context);
  allocateTables(context);
  allocateRelationKeys(context);
  const ordered: TableInfo[] = orderTables(context);

  const blocks: string[] = [];
  for (const info of context.enums.values()) {
    blocks.push(renderEnum(context, info));
  }
  for (const info of ordered) {
    blocks.push(renderTable(context, info));
  }
  // Relations come last, after every table has settled which of its relations could be written.
  for (const info of ordered) {
    const relationsBlock: string | undefined = renderRelations(context, info);
    if (relationsBlock !== undefined) {
      blocks.push(relationsBlock);
    }
  }

  const helperBlocks: string[] = [...context.helpers]
    .sort()
    .map((name: string) => helperDeclaration(name));
  const importLines: string[] = buildImports(context);
  const body: string[] = [...helperBlocks, ...blocks];
  const text: string =
    body.length === 0
      ? 'export {};\n'
      : `${[importLines.join('\n'), ...body].join('\n\n')}\n`;

  return {
    files: {
      [DRIZZLE_SCHEMA_FILE]: text,
      [DRIZZLE_CONFIG_FILE]: renderConfig(dialect),
    },
    warnings: context.warnings,
  };
}

function dialectOf(provider: PrismaProvider): Dialect {
  switch (provider) {
    case 'mysql':
      return 'mysql';
    case 'sqlite':
      return 'sqlite';
    default:
      // CockroachDB speaks the PostgreSQL wire protocol and uses the same drizzle-kit dialect.
      return 'pg';
  }
}

function warnAboutProvider(context: EmitContext): void {
  const provider: PrismaProvider = context.options.provider;
  if (provider === 'sqlserver') {
    context.warnings.push(
      'Provider "sqlserver": Drizzle ORM has no SQL Server dialect; PostgreSQL tables (pg-core) were written.'
    );
  } else if (provider === 'mongodb') {
    context.warnings.push(
      'Provider "mongodb": Drizzle ORM is relational (it has no MongoDB dialect); PostgreSQL tables (pg-core) were written.'
    );
  }
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function quote(value: string): string {
  const escaped: string = value
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r');
  if (value.includes("'") && !value.includes('"')) {
    return `"${escaped}"`;
  }
  return `'${escaped.replace(/'/g, "\\'")}'`;
}

/** Writes a JSON value as a JavaScript literal with single-quoted strings. */
function literalOf(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  if (typeof value === 'string') {
    return quote(value);
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item: unknown) => literalOf(item)).join(', ')}]`;
  }
  if (typeof value === 'object') {
    const entries: string[] = Object.entries(
      value as Record<string, unknown>
    ).map(
      ([key, item]: [string, unknown]) =>
        `${IDENTIFIER_PATTERN.test(key) ? key : quote(key)}: ${literalOf(item)}`
    );
    return entries.length === 0 ? '{}' : `{ ${entries.join(', ')} }`;
  }
  return 'undefined';
}

function uniqueName(baseName: string, used: Set<string>): string {
  let candidate: string = baseName;
  let suffix: number = 2;
  while (used.has(candidate)) {
    candidate = `${baseName}${suffix}`;
    suffix += 1;
  }
  used.add(candidate);
  return candidate;
}

/** camelCase key for a name of the source; invalid TypeScript identifiers are repaired with a warning. */
function keyOf(context: EmitContext, owner: string, raw: string): string {
  const camel: string = toCamelCase(raw);
  if (IDENTIFIER_PATTERN.test(camel)) {
    return camel;
  }
  const replaced: string = camel.replace(/[^A-Za-z0-9_$]/g, '_');
  const safe: string = /^[0-9]/.test(replaced) ? `_${replaced}` : replaced;
  const result: string = safe === '' ? '_' : safe;
  context.warnings.push(
    `${owner}: "${raw}" cannot be turned into a valid TypeScript identifier; it was written as "${result}".`
  );
  return result;
}

function use(context: EmitContext, name: string): string {
  context.imports.add(name);
  return name;
}

function useCore(context: EmitContext, name: string): string {
  context.coreImports.add(name);
  return name;
}

function pluralize(word: string): string {
  if (/(s|x|z|ch|sh)$/i.test(word)) {
    return `${word}es`;
  }
  if (/[^aeiou]y$/i.test(word)) {
    return `${word.slice(0, -1)}ies`;
  }
  return `${word}s`;
}

function compareText(first: string, second: string): number {
  return first.localeCompare(second);
}

function isManyToMany(relation: IrRelation): boolean {
  return relation.kind === 'manyToMany';
}

function isKeyedRelation(model: IrModel, relation: IrRelation): boolean {
  return (
    relation.isPrimaryKey === true ||
    (model.compositePrimaryKey?.includes(relation.name) ?? false)
  );
}

function pairKey(first: string, second: string): string {
  return first <= second
    ? `${first}\u0000${second}`
    : `${second}\u0000${first}`;
}

function tableOf(
  context: EmitContext,
  modelName: string
): TableInfo | undefined {
  return context.tables.get(modelName);
}

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

function allocateEnums(context: EmitContext): void {
  for (const definition of context.schema.enums) {
    if (definition.values.length === 0) {
      context.warnings.push(
        `enum ${definition.name}: an enum without values cannot be written; fields that use it became plain strings.`
      );
      continue;
    }
    const base: string = keyOf(
      context,
      `enum ${definition.name}`,
      definition.name
    );
    const dbName: string = definition.dbName ?? definition.name;
    context.enums.set(definition.name, {
      definition,
      valuesName: uniqueName(`${base}Values`, context.reserved),
      enumName: uniqueName(`${base}Enum`, context.reserved),
      typeName: uniqueName(
        toPascalCase(definition.name) || 'Enum',
        context.reserved
      ),
      dbName:
        context.options.naming === 'normalize' ? toSnakeCase(dbName) : dbName,
    });
  }
}

function allocateTables(context: EmitContext): void {
  for (const model of context.schema.models) {
    const base: string = keyOf(context, model.name, model.name);
    const variable: string = uniqueName(base, context.reserved);
    const typeName: string = uniqueName(
      toPascalCase(model.name) || 'Model',
      context.reserved
    );
    const info: TableInfo = {
      model,
      variable,
      relationsVariable: uniqueName(`${variable}Relations`, context.reserved),
      typeName,
      insertTypeName: uniqueName(`New${typeName}`, context.reserved),
      fieldKeys: new Map<string, string>(),
      columnKeys: new Map<string, string>(),
      relationKeys: new Map<string, string>(),
      used: new Set<string>(),
      position: 0,
    };
    for (const field of model.fields) {
      info.fieldKeys.set(
        field.name,
        uniqueName(
          keyOf(context, `${model.name}.${field.name}`, field.name),
          info.used
        )
      );
    }
    for (const relation of model.relations) {
      if (isManyToMany(relation)) {
        continue;
      }
      info.columnKeys.set(
        relation.name,
        uniqueName(
          keyOf(context, `${model.name}.${relation.name}`, relation.columnName),
          info.used
        )
      );
    }
    context.tables.set(model.name, info);
  }
}

function defaultInverseName(model: IrModel, relation: IrRelation): string {
  const owner: string = toCamelCase(model.name);
  if (model.isJoinTable === true) {
    // The join table's own name says what the rows are; the relation names only tell the sides apart.
    const sameTarget: number = model.relations.filter(
      (candidate: IrRelation) => candidate.targetModel === relation.targetModel
    ).length;
    return sameTarget > 1 ? `${owner}${toPascalCase(relation.name)}` : owner;
  }
  if (relation.relatedName !== undefined) {
    return toCamelCase(relation.relatedName);
  }
  return relation.kind === 'oneToOne' ? owner : pluralize(owner);
}

/** Allocates the keys of forward relations and of the inverse side on the target table. */
function allocateRelationKeys(context: EmitContext): void {
  const counts: Map<string, number> = new Map<string, number>();
  for (const model of context.schema.models) {
    for (const relation of model.relations) {
      if (isManyToMany(relation)) {
        continue;
      }
      const key: string = pairKey(model.name, relation.targetModel);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  for (const [key, count] of counts) {
    const [first, second] = key.split('\u0000');
    if (count > 1 || first === second) {
      context.ambiguousPairs.add(key);
    }
  }

  for (const model of context.schema.models) {
    const info: TableInfo | undefined = tableOf(context, model.name);
    if (info === undefined) {
      continue;
    }
    for (const relation of model.relations) {
      if (isManyToMany(relation)) {
        continue;
      }
      info.relationKeys.set(
        relation.name,
        uniqueName(
          keyOf(context, `${model.name}.${relation.name}`, relation.name),
          info.used
        )
      );
    }
  }
}

/** Key of the inverse side of a relation on its target table (allocated lazily, once). */
function inverseKeyOf(
  context: EmitContext,
  inverseKeys: Map<string, string>,
  model: IrModel,
  relation: IrRelation,
  target: TableInfo
): string {
  const cacheKey: string = `${model.name}.${relation.name}`;
  const cached: string | undefined = inverseKeys.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }
  const raw: string = defaultInverseName(model, relation);
  const safe: string = IDENTIFIER_PATTERN.test(raw)
    ? raw
    : keyOf(context, cacheKey, raw);
  const allocated: string = uniqueName(safe, target.used);
  inverseKeys.set(cacheKey, allocated);
  return allocated;
}

// ---------------------------------------------------------------------------
// Ordering
// ---------------------------------------------------------------------------

/**
 * Orders the tables so that a table comes after the tables its foreign keys point at. A cycle (or a
 * self reference) cannot be ordered; those references are annotated with `AnyPgColumn` and friends,
 * which keeps TypeScript from reporting an implicitly typed circular initializer.
 */
function orderTables(context: EmitContext): TableInfo[] {
  const ordered: TableInfo[] = [];
  const done: Set<string> = new Set<string>();
  const visiting: Set<string> = new Set<string>();

  const visit = (model: IrModel): void => {
    if (done.has(model.name) || visiting.has(model.name)) {
      return;
    }
    visiting.add(model.name);
    for (const relation of model.relations) {
      if (isManyToMany(relation)) {
        continue;
      }
      const target: IrModel | undefined = findModel(
        context.schema,
        relation.targetModel
      );
      if (target !== undefined) {
        visit(target);
      }
    }
    visiting.delete(model.name);
    done.add(model.name);
    const info: TableInfo | undefined = tableOf(context, model.name);
    if (info !== undefined) {
      info.position = ordered.length;
      ordered.push(info);
    }
  };
  for (const model of context.schema.models) {
    visit(model);
  }
  return ordered;
}

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

function enumOf(context: EmitContext, field: IrField): EnumInfo | undefined {
  return field.enumName === undefined
    ? undefined
    : context.enums.get(field.enumName);
}

function renderEnum(context: EmitContext, info: EnumInfo): string {
  const values: string = info.definition.values
    .map((value: IrEnumValue) => quote(value.dbValue))
    .join(', ');
  const lines: string[] = [];
  const labelled: IrEnumValue[] = info.definition.values.filter(
    (value: IrEnumValue) => value.label !== undefined
  );
  if (labelled.length > 0) {
    lines.push(
      `// ${info.definition.name}: ${info.definition.values
        .map(
          (value: IrEnumValue) =>
            `${value.dbValue}${value.label === undefined ? '' : ` = ${value.label}`}`
        )
        .join(', ')}`
    );
  }
  const declaration: string = `export const ${info.valuesName} = [${values}] as const;`;
  lines.push(
    declaration.length <= MAX_LINE_WIDTH
      ? declaration
      : [
          `export const ${info.valuesName} = [`,
          ...info.definition.values.map(
            (value: IrEnumValue) => `  ${quote(value.dbValue)},`
          ),
          '] as const;',
        ].join('\n'),
    `export type ${info.typeName} = (typeof ${info.valuesName})[number];`
  );
  if (context.dialect === 'pg') {
    lines.push(
      `export const ${info.enumName} = ${use(context, 'pgEnum')}(${quote(info.dbName)}, ${info.valuesName});`
    );
  }
  return lines.join('\n');
}

/** The stored value an enum default refers to, by member name or stored value. */
function enumDefaultValue(info: EnumInfo, raw: string): string | undefined {
  const value: IrEnumValue | undefined =
    info.definition.values.find((candidate) => candidate.name === raw) ??
    info.definition.values.find((candidate) => candidate.dbValue === raw);
  return value?.dbValue;
}

// ---------------------------------------------------------------------------
// Column builders
// ---------------------------------------------------------------------------

function call(name: string, args: string[]): string {
  return `${name}(${args.join(', ')})`;
}

function configObject(entries: string[]): string | undefined {
  return entries.length === 0 ? undefined : `{ ${entries.join(', ')} }`;
}

function builderCall(
  context: EmitContext,
  name: string,
  columnName: string,
  entries: string[] = []
): string {
  const config: string | undefined = configObject(entries);
  return call(
    use(context, name),
    config === undefined ? [quote(columnName)] : [quote(columnName), config]
  );
}

/** Registers a `customType` helper and returns its name. */
function helperType(context: EmitContext, name: string): string {
  use(context, 'customType');
  context.helpers.add(name);
  return name;
}

function helperDeclaration(name: string): string {
  switch (name) {
    case 'bytea':
      return [
        `const bytea = customType<{ data: Buffer; driverData: Buffer }>({`,
        `  dataType() {`,
        `    return 'bytea';`,
        `  },`,
        `});`,
      ].join('\n');
    case 'blob':
      return [
        `const blob = customType<{ data: Buffer; driverData: Buffer }>({`,
        `  dataType() {`,
        `    return 'blob';`,
        `  },`,
        `});`,
      ].join('\n');
    case 'hstore':
      return [
        `const hstore = customType<{ data: string; driverData: string }>({`,
        `  dataType() {`,
        `    return 'hstore';`,
        `  },`,
        `});`,
      ].join('\n');
    default:
      return [
        `const ${name} = customType<{ data: string; driverData: string }>({`,
        `  dataType() {`,
        `    return '${name}';`,
        `  },`,
        `});`,
      ].join('\n');
  }
}

/** The element type of a field as TypeScript sees it, for `.$type<...>()` on JSON-backed arrays. */
function tsTypeOf(context: EmitContext, field: IrField): string {
  const enumInfo: EnumInfo | undefined = enumOf(context, field);
  if (enumInfo !== undefined) {
    return enumInfo.typeName;
  }
  switch (field.type) {
    case 'int':
    case 'bigInt':
    case 'float':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'dateTime':
      return 'Date';
    case 'json':
      return 'unknown';
    default:
      return 'string';
  }
}

interface BuiltColumn {
  /** The builder call, including `.array()` / `.$type<>()` when the column is an array. */
  builder: string;
}

/** The builder call of a column's type (no constraints or defaults). */
function columnBuilder(
  context: EmitContext,
  label: string,
  field: IrField,
  columnName: string
): BuiltColumn {
  const depth: number = field.arrayDepth ?? 0;
  const base: string = scalarBuilder(
    context,
    label,
    { ...field, arrayDepth: undefined },
    columnName
  );
  if (depth === 0) {
    return { builder: base };
  }
  if (context.dialect === 'pg') {
    return { builder: `${base}${'.array()'.repeat(depth)}` };
  }
  const jsonType: string = context.dialect === 'mysql' ? 'json' : 'text';
  context.warnings.push(
    `${label}: ${context.dialect === 'mysql' ? 'MySQL' : 'SQLite'} has no array column type; the array was written as ${jsonType === 'json' ? 'json' : 'a JSON text column'}.`
  );
  const element: string = tsTypeOf(context, field);
  const typeText: string = `${/[\s|]/.test(element) ? `(${element})` : element}${'[]'.repeat(depth)}`;
  return {
    builder: `${
      jsonType === 'json'
        ? builderCall(context, 'json', columnName)
        : builderCall(context, 'text', columnName, [`mode: 'json'`])
    }.$type<${typeText}>()`,
  };
}

function scalarBuilder(
  context: EmitContext,
  label: string,
  field: IrField,
  columnName: string
): string {
  const dialect: Dialect = context.dialect;
  const enumInfo: EnumInfo | undefined = enumOf(context, field);
  if (field.enumName !== undefined && enumInfo === undefined) {
    context.warnings.push(
      `${label}: enum "${field.enumName}" does not exist in the schema; the column was written as a plain string.`
    );
  }
  if (enumInfo !== undefined) {
    if (dialect === 'pg') {
      return call(enumInfo.enumName, [quote(columnName)]);
    }
    if (dialect === 'mysql') {
      return call(use(context, 'mysqlEnum'), [
        quote(columnName),
        enumInfo.valuesName,
      ]);
    }
    return builderCall(context, 'text', columnName, [
      `enum: ${enumInfo.valuesName}`,
    ]);
  }

  switch (field.type) {
    case 'string':
    case 'unsupported': {
      if (dialect === 'sqlite') {
        return builderCall(context, 'text', columnName);
      }
      if (field.maxLength !== undefined) {
        return builderCall(context, 'varchar', columnName, [
          `length: ${field.maxLength}`,
        ]);
      }
      // MySQL cannot index or key an unbounded text column and varchar requires a length.
      return dialect === 'mysql'
        ? builderCall(context, 'varchar', columnName, ['length: 255'])
        : builderCall(context, 'text', columnName);
    }
    case 'text':
      return builderCall(context, 'text', columnName);
    case 'uuid':
      if (dialect === 'pg') {
        return builderCall(context, 'uuid', columnName);
      }
      return dialect === 'mysql'
        ? builderCall(context, 'char', columnName, ['length: 36'])
        : builderCall(context, 'text', columnName);
    case 'int':
      return dialect === 'mysql'
        ? builderCall(context, 'int', columnName)
        : builderCall(context, 'integer', columnName);
    case 'bigInt':
      return dialect === 'sqlite'
        ? builderCall(context, 'integer', columnName)
        : builderCall(context, 'bigint', columnName, [`mode: 'number'`]);
    case 'float':
      if (dialect === 'pg') {
        return builderCall(context, 'doublePrecision', columnName);
      }
      return dialect === 'mysql'
        ? builderCall(context, 'double', columnName)
        : builderCall(context, 'real', columnName);
    case 'decimal': {
      const entries: string[] = [];
      if (field.maxDigits !== undefined) {
        entries.push(`precision: ${field.maxDigits}`);
      }
      if (field.decimalPlaces !== undefined) {
        entries.push(`scale: ${field.decimalPlaces}`);
      }
      if (dialect === 'sqlite') {
        return builderCall(context, 'numeric', columnName);
      }
      return builderCall(
        context,
        dialect === 'pg' ? 'numeric' : 'decimal',
        columnName,
        entries
      );
    }
    case 'boolean':
      return dialect === 'sqlite'
        ? builderCall(context, 'integer', columnName, [`mode: 'boolean'`])
        : builderCall(context, 'boolean', columnName);
    case 'dateTime':
      if (dialect === 'pg') {
        return builderCall(context, 'timestamp', columnName, [
          'withTimezone: true',
        ]);
      }
      return dialect === 'mysql'
        ? builderCall(context, 'datetime', columnName)
        : builderCall(context, 'integer', columnName, [`mode: 'timestamp'`]);
    case 'date':
      return dialect === 'sqlite'
        ? builderCall(context, 'text', columnName)
        : builderCall(context, 'date', columnName, [`mode: 'string'`]);
    case 'time':
      return dialect === 'sqlite'
        ? builderCall(context, 'text', columnName)
        : builderCall(context, 'time', columnName);
    case 'json':
      if (dialect === 'pg') {
        return builderCall(context, 'jsonb', columnName);
      }
      return dialect === 'mysql'
        ? builderCall(context, 'json', columnName)
        : builderCall(context, 'text', columnName, [`mode: 'json'`]);
    case 'bytes':
      if (dialect === 'pg') {
        return call(helperType(context, 'bytea'), [quote(columnName)]);
      }
      return dialect === 'mysql'
        ? call(helperType(context, 'blob'), [quote(columnName)])
        : builderCall(context, 'blob', columnName, [`mode: 'buffer'`]);
    case 'duration':
      if (dialect === 'pg') {
        return builderCall(context, 'interval', columnName);
      }
      context.warnings.push(
        `${label}: ${dialect === 'mysql' ? 'MySQL' : 'SQLite'} has no interval type; the duration was written as an integer (microseconds).`
      );
      return dialect === 'mysql'
        ? builderCall(context, 'bigint', columnName, [`mode: 'number'`])
        : builderCall(context, 'integer', columnName);
    case 'ipAddress':
      if (dialect === 'pg') {
        return builderCall(context, 'inet', columnName);
      }
      return dialect === 'mysql'
        ? builderCall(context, 'varchar', columnName, ['length: 45'])
        : builderCall(context, 'text', columnName);
    case 'hstore':
      if (dialect === 'pg') {
        return call(helperType(context, 'hstore'), [quote(columnName)]);
      }
      context.warnings.push(
        `${label}: hstore exists only on PostgreSQL; the field was written as JSON.`
      );
      return `${
        dialect === 'mysql'
          ? builderCall(context, 'json', columnName)
          : builderCall(context, 'text', columnName, [`mode: 'json'`])
      }.$type<Record<string, string | null>>()`;
    case 'range':
      if (dialect === 'pg') {
        const rangeType: string =
          POSTGRES_RANGE_TYPES[field.rangeOf ?? 'int'] ?? 'int4range';
        return call(helperType(context, rangeType), [quote(columnName)]);
      }
      context.warnings.push(
        `${label}: range columns exist only on PostgreSQL; the field was written as text.`
      );
      return dialect === 'mysql'
        ? builderCall(context, 'varchar', columnName, ['length: 255'])
        : builderCall(context, 'text', columnName);
    default:
      context.warnings.push(
        `${label}: unknown field type "${String(field.type)}"; it was written as text.`
      );
      return builderCall(context, 'text', columnName);
  }
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

function sqlTemplate(context: EmitContext, expression: string): string {
  useCore(context, 'sql');
  return `sql\`${expression.replace(/\\/g, '\\\\').replace(/`/g, '\\`')}\``;
}

type ParsedJson = { ok: true; value: unknown } | { ok: false };

function parseJson(text: string): ParsedJson {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

/** The `.default(...)` / `.defaultNow()` call for a field, or undefined when there is none. */
function defaultSegment(
  context: EmitContext,
  label: string,
  field: IrField
): string | undefined {
  const value: IrDefault | undefined = field.default;
  if (value === undefined) {
    return undefined;
  }
  const dialect: Dialect = context.dialect;
  const enumInfo: EnumInfo | undefined = enumOf(context, field);

  switch (value.kind) {
    case 'autoIncrement':
      context.warnings.push(
        `${label}: an auto-increment default is only supported on a single-column integer primary key; it was dropped.`
      );
      return undefined;
    case 'now':
      return nowDefault(context, label, field);
    case 'uuid':
      if (field.type !== 'uuid') {
        context.warnings.push(
          `${label}: a UUID default on a ${field.type} column cannot be written; it was dropped.`
        );
        return undefined;
      }
      if (dialect === 'pg') {
        return '.defaultRandom()';
      }
      if (dialect === 'mysql') {
        return `.default(${sqlTemplate(context, '(UUID())')})`;
      }
      context.warnings.push(
        `${label}: SQLite has no database-side UUID default; the UUID is generated by Drizzle ($defaultFn) when a row is inserted through it.`
      );
      return '.$defaultFn(() => crypto.randomUUID())';
    case 'enumValue': {
      const stored: string | undefined =
        enumInfo === undefined
          ? undefined
          : enumDefaultValue(enumInfo, value.value);
      if (stored === undefined) {
        context.warnings.push(
          `${label}: the enum default "${value.value}" does not match a member of the enum; it was written as a string.`
        );
      }
      return `.default(${quote(stored ?? value.value)})`;
    }
    case 'literal':
      return literalDefault(context, label, field, value.value, enumInfo);
    default:
      // clientGenerated and dbExpression defaults are reported by prismaOnlyWarnings.
      return undefined;
  }
}

function nowDefault(
  context: EmitContext,
  label: string,
  field: IrField
): string | undefined {
  const dialect: Dialect = context.dialect;
  switch (field.type) {
    case 'dateTime':
      if (dialect === 'sqlite') {
        return `.default(${sqlTemplate(context, '(unixepoch())')})`;
      }
      // MySQL's datetime builder has no defaultNow().
      return dialect === 'mysql'
        ? `.default(${sqlTemplate(context, 'CURRENT_TIMESTAMP')})`
        : '.defaultNow()';
    case 'date':
      return `.default(${sqlTemplate(context, dialect === 'pg' ? 'CURRENT_DATE' : '(CURRENT_DATE)')})`;
    case 'time':
      return `.default(${sqlTemplate(context, dialect === 'pg' ? 'CURRENT_TIME' : '(CURRENT_TIME)')})`;
    default:
      context.warnings.push(
        `${label}: a "now" default on a ${field.type} column cannot be written; it was dropped.`
      );
      return undefined;
  }
}

function literalDefault(
  context: EmitContext,
  label: string,
  field: IrField,
  value: string | number | boolean,
  enumInfo: EnumInfo | undefined
): string | undefined {
  if ((field.arrayDepth ?? 0) > 0) {
    const parsed: ParsedJson =
      typeof value === 'string' ? parseJson(value) : { ok: false };
    if (parsed.ok && Array.isArray(parsed.value)) {
      return `.default(${literalOf(parsed.value)})`;
    }
    context.warnings.push(
      `${label}: the array default ${String(value)} cannot be written; it was dropped.`
    );
    return undefined;
  }
  if (enumInfo !== undefined) {
    const stored: string | undefined = enumDefaultValue(
      enumInfo,
      String(value)
    );
    return `.default(${quote(stored ?? String(value))})`;
  }
  const dropped = (reason: string): undefined => {
    context.warnings.push(`${label}: ${reason}; the default was dropped.`);
    return undefined;
  };
  switch (field.type) {
    case 'int':
    case 'bigInt':
    case 'float':
    case 'duration': {
      if (field.type === 'duration' && context.dialect === 'pg') {
        return `.default(${quote(String(value))})`;
      }
      const numeric: number = typeof value === 'number' ? value : Number(value);
      return typeof value === 'boolean' || Number.isNaN(numeric)
        ? dropped(`the value ${String(value)} is not a number`)
        : `.default(${numeric})`;
    }
    case 'decimal':
      return `.default(${quote(String(value))})`;
    case 'boolean': {
      if (typeof value === 'boolean') {
        return `.default(${value})`;
      }
      const text: string = String(value).toLowerCase();
      if (text === 'true' || text === '1') {
        return '.default(true)';
      }
      return text === 'false' || text === '0'
        ? '.default(false)'
        : dropped(`the value ${String(value)} is not a boolean`);
    }
    case 'dateTime': {
      const time: number = Date.parse(String(value));
      return Number.isNaN(time)
        ? dropped(`the value ${String(value)} is not a date`)
        : `.default(new Date(${quote(String(value))}))`;
    }
    case 'json': {
      if (typeof value !== 'string') {
        return `.default(${literalOf(value)})`;
      }
      const parsed: ParsedJson = parseJson(value);
      return parsed.ok
        ? `.default(${literalOf(parsed.value)})`
        : dropped(`the value ${value} is not JSON`);
    }
    case 'bytes':
      return dropped(
        'a literal default on a binary column cannot be represented'
      );
    case 'hstore':
      if (context.dialect === 'pg' && value === '{}') {
        return `.default(${sqlTemplate(context, "''")})`;
      }
      if (context.dialect !== 'pg') {
        const parsed: ParsedJson = parseJson(String(value));
        return parsed.ok
          ? `.default(${literalOf(parsed.value)})`
          : dropped(`the value ${String(value)} is not JSON`);
      }
      return dropped('only an empty hstore default can be written');
    case 'range':
      return dropped('a range default cannot be represented');
    default:
      return `.default(${quote(String(value))})`;
  }
}

// ---------------------------------------------------------------------------
// References
// ---------------------------------------------------------------------------

/** Resolves the column a relation points at: `toField`, otherwise the target's primary key. */
function referencedColumn(
  context: EmitContext,
  target: IrModel,
  toField: string | undefined,
  depth: number = 0
): ColumnReference | undefined {
  const info: TableInfo | undefined = tableOf(context, target.name);
  if (info === undefined || depth > 5) {
    return undefined;
  }
  const explicit: IrField | undefined =
    toField === undefined
      ? undefined
      : target.fields.find((candidate: IrField) => candidate.name === toField);
  const column: IrField | undefined =
    explicit ??
    target.fields.find((candidate: IrField) => candidate.isPrimaryKey);
  if (column !== undefined) {
    const key: string | undefined = info.fieldKeys.get(column.name);
    return key === undefined ? undefined : { table: info, key, field: column };
  }
  const primaryRelation: IrRelation | undefined = target.relations.find(
    (relation: IrRelation) => relation.isPrimaryKey === true
  );
  if (primaryRelation === undefined) {
    return undefined;
  }
  const chained: IrModel | undefined = findModel(
    context.schema,
    primaryRelation.targetModel
  );
  const chainedColumn: ColumnReference | undefined =
    chained === undefined
      ? undefined
      : referencedColumn(context, chained, primaryRelation.toField, depth + 1);
  const key: string | undefined = info.columnKeys.get(primaryRelation.name);
  return chainedColumn === undefined || key === undefined
    ? undefined
    : { table: info, key, field: chainedColumn.field };
}

function actionOf(
  context: EmitContext,
  label: string,
  kind: 'onDelete' | 'onUpdate',
  action: IrOnDelete
): string | undefined {
  if (action === 'setDefault' && context.dialect === 'mysql') {
    context.warnings.push(
      `${label}: MySQL (InnoDB) does not support ${kind === 'onDelete' ? 'ON DELETE' : 'ON UPDATE'} SET DEFAULT; the action was left at the default (NO ACTION).`
    );
    return undefined;
  }
  return REFERENTIAL_ACTIONS[action];
}

function referencesSegment(
  context: EmitContext,
  label: string,
  from: TableInfo,
  relation: IrRelation,
  column: ColumnReference
): string {
  const entries: string[] = [];
  const onDelete: string | undefined = actionOf(
    context,
    label,
    'onDelete',
    relation.onDelete
  );
  if (onDelete !== undefined) {
    entries.push(`onDelete: ${quote(onDelete)}`);
  }
  if (relation.onUpdate !== undefined) {
    const onUpdate: string | undefined = actionOf(
      context,
      label,
      'onUpdate',
      relation.onUpdate
    );
    if (onUpdate !== undefined) {
      entries.push(`onUpdate: ${quote(onUpdate)}`);
    }
  }
  const later: boolean = column.table.position >= from.position;
  const annotation: string = later
    ? `(): ${typeImport(context, DIALECTS[context.dialect].anyColumnType)} =>`
    : '() =>';
  const target: string = `${column.table.variable}.${column.key}`;
  const config: string | undefined = configObject(entries);
  return `.references(${annotation} ${target}${config === undefined ? '' : `, ${config}`})`;
}

function typeImport(context: EmitContext, name: string): string {
  context.typeImports.add(name);
  return name;
}

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

/** Writes `key: chain,` on one line, or with the chain broken after the builder when it is too wide. */
function formatMember(
  key: string,
  chain: string[],
  indent: string = '  '
): string[] {
  const inline: string = `${indent}${key}: ${chain.join('')},`;
  if (inline.length <= MAX_LINE_WIDTH || chain.length <= 1) {
    return [inline];
  }
  const rest: string[] = chain.slice(1);
  return [
    `${indent}${key}: ${chain[0] ?? ''}`,
    ...rest.map(
      (segment: string, position: number) =>
        `${indent}  ${segment}${position === rest.length - 1 ? ',' : ''}`
    ),
  ];
}

function isIntegerKey(field: IrField): boolean {
  return field.type === 'int' || field.type === 'bigInt';
}

function fieldChain(
  context: EmitContext,
  model: IrModel,
  field: IrField
): string[] {
  const label: string = `${model.name}.${field.name}`;
  const inCompositeKey: boolean =
    model.compositePrimaryKey?.includes(field.name) ?? false;

  if (field.generated !== undefined) {
    context.warnings.push(
      `${label}: the generated column expression ${field.generated.expression} is Python, not SQL, and cannot be written for Drizzle; the property was written as a regular column.`
    );
  }

  const isAutoKey: boolean =
    field.isPrimaryKey &&
    !inCompositeKey &&
    field.default?.kind === 'autoIncrement' &&
    isIntegerKey(field);
  if (isAutoKey) {
    return autoIncrementChain(context, field);
  }

  const chain: string[] = [
    columnBuilder(context, label, field, field.columnName).builder,
  ];
  if (field.isPrimaryKey && !inCompositeKey) {
    chain.push('.primaryKey()');
  } else if (!field.isNullable || inCompositeKey) {
    chain.push('.notNull()');
  }
  if (field.isUnique && !field.isPrimaryKey) {
    chain.push(
      field.uniqueName === undefined
        ? '.unique()'
        : `.unique(${quote(field.uniqueName)})`
    );
  }
  const defaultText: string | undefined = defaultSegment(context, label, field);
  if (defaultText !== undefined) {
    chain.push(defaultText);
  }
  if (field.isAutoUpdated) {
    const updater: string | undefined = onUpdateSegment(context, label, field);
    if (updater !== undefined) {
      chain.push(updater);
    }
  }
  return chain;
}

function onUpdateSegment(
  context: EmitContext,
  label: string,
  field: IrField
): string | undefined {
  if (field.type === 'dateTime') {
    return '.$onUpdate(() => new Date())';
  }
  if (field.type === 'date') {
    return '.$onUpdate(() => new Date().toISOString().slice(0, 10))';
  }
  context.warnings.push(
    `${label}: only date and date-time columns can be refreshed on update ($onUpdate); the auto-update flag was dropped.`
  );
  return undefined;
}

function autoIncrementChain(context: EmitContext, field: IrField): string[] {
  const name: string = field.columnName;
  switch (context.dialect) {
    case 'pg':
      return [
        field.type === 'bigInt'
          ? builderCall(context, 'bigserial', name, [`mode: 'number'`])
          : builderCall(context, 'serial', name),
        '.primaryKey()',
      ];
    case 'mysql':
      return [
        field.type === 'bigInt'
          ? builderCall(context, 'bigint', name, [`mode: 'number'`])
          : builderCall(context, 'int', name),
        '.primaryKey()',
        '.autoincrement()',
      ];
    default:
      // SQLite's INTEGER PRIMARY KEY is already 64 bits wide.
      return [
        builderCall(context, 'integer', name),
        `.primaryKey({ autoIncrement: true })`,
      ];
  }
}

function relationColumnChain(
  context: EmitContext,
  from: TableInfo,
  relation: IrRelation,
  column: ColumnReference
): string[] {
  const model: IrModel = from.model;
  const label: string = `${model.name}.${relation.name}`;
  const keyed: boolean = isKeyedRelation(model, relation);
  const inCompositeKey: boolean =
    model.compositePrimaryKey?.includes(relation.name) ?? false;
  const asField: IrField = {
    ...column.field,
    name: relation.name,
    columnName: relation.columnName,
    isPrimaryKey: false,
    isUnique: false,
    isNullable: relation.isNullable,
    isAutoUpdated: false,
    default: undefined,
    generated: undefined,
  };
  const chain: string[] = [
    columnBuilder(context, label, asField, relation.columnName).builder,
  ];
  if (keyed && !inCompositeKey) {
    chain.push('.primaryKey()');
  } else if (!relation.isNullable || inCompositeKey) {
    chain.push('.notNull()');
  }
  if (relation.kind === 'oneToOne' && !keyed) {
    chain.push('.unique()');
  }
  if (relation.onDelete === 'setNull' && !relation.isNullable) {
    context.warnings.push(
      `${label}: onDelete SET NULL on a required relation will fail at the database level; review the relation.`
    );
  }
  chain.push(referencesSegment(context, label, from, relation, column));
  return chain;
}

/** Resolves an index or key entry (a field or relation name of the IR) to a column key. */
function columnKeyOf(info: TableInfo, name: string): string | undefined {
  const model: IrModel = info.model;
  const relation: IrRelation | undefined =
    model.relations.find(
      (candidate: IrRelation) =>
        !isManyToMany(candidate) && candidate.name === name
    ) ??
    model.relations.find(
      (candidate: IrRelation) =>
        !isManyToMany(candidate) && candidate.columnName === name
    );
  if (relation !== undefined) {
    return info.columnKeys.get(relation.name);
  }
  const field: IrField | undefined =
    model.fields.find((candidate: IrField) => candidate.name === name) ??
    model.fields.find((candidate: IrField) => candidate.columnName === name);
  return field === undefined ? undefined : info.fieldKeys.get(field.name);
}

function indexName(
  context: EmitContext,
  model: IrModel,
  index: IrIndex,
  columns: string[]
): string {
  if (index.name !== undefined) {
    context.indexNames.add(index.name);
    return index.name;
  }
  const suffix: string = index.isUnique ? 'key' : 'idx';
  const base: string = limitIdentifier(
    `${model.tableName}_${columns.join('_')}_${suffix}`,
    MAX_INDEX_NAME_LENGTH
  );
  return uniqueName(base, context.indexNames);
}

function extraEntries(context: EmitContext, info: TableInfo): string[] {
  const model: IrModel = info.model;
  const entries: string[] = [];
  const composite: string[] | undefined = model.compositePrimaryKey;
  if (composite !== undefined && composite.length > 0) {
    const columns: string[] = [];
    for (const name of composite) {
      const key: string | undefined = columnKeyOf(info, name);
      if (key === undefined) {
        context.warnings.push(
          `${model.name}: the composite primary key refers to "${name}", which is not a field of the model; it was left out of the key.`
        );
      } else {
        columns.push(`table.${key}`);
      }
    }
    if (columns.length > 0) {
      const nameEntry: string =
        model.primaryKeyName === undefined
          ? ''
          : `, name: ${quote(model.primaryKeyName)}`;
      entries.push(
        `${use(context, 'primaryKey')}({ columns: [${columns.join(', ')}]${nameEntry} })`
      );
    }
  }
  for (const index of model.indexes) {
    const keys: string[] = [];
    let complete: boolean = true;
    for (const name of index.fields) {
      const key: string | undefined = columnKeyOf(info, name);
      if (key === undefined) {
        complete = false;
        context.warnings.push(
          `${model.name}: an index references "${name}", which is not a field of the model; the index was skipped.`
        );
        break;
      }
      keys.push(key);
    }
    if (!complete || keys.length === 0) {
      continue;
    }
    const columnNames: string[] = index.fields.map((name: string) => {
      const field: IrField | undefined = model.fields.find(
        (candidate: IrField) => candidate.name === name
      );
      const relation: IrRelation | undefined = model.relations.find(
        (candidate: IrRelation) => candidate.name === name
      );
      return field?.columnName ?? relation?.columnName ?? name;
    });
    const name: string = indexName(context, model, index, columnNames);
    entries.push(
      `${use(context, index.isUnique ? 'uniqueIndex' : 'index')}(${quote(name)}).on(${keys
        .map((key: string) => `table.${key}`)
        .join(', ')})`
    );
  }
  return entries;
}

function renderTable(context: EmitContext, info: TableInfo): string {
  const model: IrModel = info.model;
  const members: string[] = [];
  for (const field of model.fields) {
    members.push(
      ...formatMember(
        info.fieldKeys.get(field.name) ?? field.name,
        fieldChain(context, model, field)
      )
    );
  }
  for (const relation of model.relations) {
    if (isManyToMany(relation)) {
      continue;
    }
    const target: IrModel | undefined = findModel(
      context.schema,
      relation.targetModel
    );
    if (target === undefined) {
      context.warnings.push(
        `${model.name}.${relation.name}: target model "${relation.targetModel}" does not exist in the schema; the relation was skipped.`
      );
      info.columnKeys.delete(relation.name);
      info.relationKeys.delete(relation.name);
      continue;
    }
    const column: ColumnReference | undefined = referencedColumn(
      context,
      target,
      relation.toField
    );
    if (column === undefined) {
      context.warnings.push(
        `${model.name}.${relation.name}: target model "${target.name}" has no single-column primary key to reference; the relation was skipped.`
      );
      info.columnKeys.delete(relation.name);
      info.relationKeys.delete(relation.name);
      continue;
    }
    members.push(
      ...formatMember(
        info.columnKeys.get(relation.name) ?? relation.columnName,
        relationColumnChain(context, info, relation, column)
      )
    );
  }
  const extras: string[] = extraEntries(context, info);
  const tableFunction: string = use(
    context,
    DIALECTS[context.dialect].tableFunction
  );
  const lines: string[] = [];
  if (extras.length === 0) {
    lines.push(
      `export const ${info.variable} = ${tableFunction}(${quote(model.tableName)}, {`,
      ...members,
      '});'
    );
  } else {
    // The three-argument call is laid out the way Prettier would.
    lines.push(
      `export const ${info.variable} = ${tableFunction}(`,
      `  ${quote(model.tableName)},`,
      '  {',
      ...members.map((line: string) => `  ${line}`),
      '  },',
      '  (table) => [',
      ...extras.map((entry: string) => `    ${entry},`),
      '  ]',
      ');'
    );
  }
  lines.push(
    '',
    `export type ${info.typeName} = typeof ${info.variable}.$inferSelect;`,
    `export type ${info.insertTypeName} = typeof ${info.variable}.$inferInsert;`
  );
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Relations
// ---------------------------------------------------------------------------

function relationNameOf(model: IrModel, relation: IrRelation): string {
  return `${model.name}_${relation.name}`;
}

function isAmbiguous(
  context: EmitContext,
  model: IrModel,
  relation: IrRelation
): boolean {
  return context.ambiguousPairs.has(pairKey(model.name, relation.targetModel));
}

function renderRelations(
  context: EmitContext,
  info: TableInfo
): string | undefined {
  const entries: RelationEntry[] = [];
  // Allocate in a stable order: this table's forward relations first, then inverse sides.
  for (const model of context.schema.models) {
    for (const relation of model.relations) {
      if (isManyToMany(relation)) {
        continue;
      }
      if (model.name === info.model.name) {
        const forward: RelationEntry | undefined = forwardEntry(
          context,
          info,
          relation
        );
        if (forward !== undefined) {
          entries.push(forward);
        }
      }
    }
  }
  for (const model of context.schema.models) {
    for (const relation of model.relations) {
      if (isManyToMany(relation) || relation.targetModel !== info.model.name) {
        continue;
      }
      const owner: TableInfo | undefined = tableOf(context, model.name);
      if (owner === undefined || !owner.relationKeys.has(relation.name)) {
        continue;
      }
      entries.push(inverseEntry(context, info, owner, relation));
    }
  }
  if (entries.length === 0) {
    return undefined;
  }
  const helpers: string[] = (['one', 'many'] as const).filter((helper) =>
    entries.some((entry: RelationEntry) => entry.helper === helper)
  );
  const lines: string[] = [
    `export const ${info.relationsVariable} = ${useCore(context, 'relations')}(${info.variable}, ({ ${helpers.join(', ')} }) => ({`,
  ];
  for (const entry of entries) {
    const [first, ...rest] = entry.text;
    lines.push(`  ${entry.key}: ${first ?? ''}`);
    lines.push(...rest);
    lines[lines.length - 1] = `${lines[lines.length - 1] ?? ''},`;
  }
  lines.push('}));');
  return lines.join('\n');
}

function forwardEntry(
  context: EmitContext,
  info: TableInfo,
  relation: IrRelation
): RelationEntry | undefined {
  const key: string | undefined = info.relationKeys.get(relation.name);
  const columnKey: string | undefined = info.columnKeys.get(relation.name);
  const target: IrModel | undefined = findModel(
    context.schema,
    relation.targetModel
  );
  const targetTable: TableInfo | undefined = tableOf(
    context,
    relation.targetModel
  );
  if (
    key === undefined ||
    columnKey === undefined ||
    target === undefined ||
    targetTable === undefined
  ) {
    return undefined;
  }
  const column: ColumnReference | undefined = referencedColumn(
    context,
    target,
    relation.toField
  );
  if (column === undefined) {
    return undefined;
  }
  const lines: string[] = [
    `one(${targetTable.variable}, {`,
    `    fields: [${info.variable}.${columnKey}],`,
    `    references: [${column.table.variable}.${column.key}],`,
  ];
  if (isAmbiguous(context, info.model, relation)) {
    lines.push(
      `    relationName: ${quote(relationNameOf(info.model, relation))},`
    );
  }
  lines.push('  })');
  return { key, helper: 'one', text: lines };
}

function inverseEntry(
  context: EmitContext,
  target: TableInfo,
  owner: TableInfo,
  relation: IrRelation
): RelationEntry {
  const key: string = inverseKeyOf(
    context,
    context.inverseKeys,
    owner.model,
    relation,
    target
  );
  const helper: 'one' | 'many' = relation.kind === 'oneToOne' ? 'one' : 'many';
  const name: string | undefined = isAmbiguous(context, owner.model, relation)
    ? relationNameOf(owner.model, relation)
    : undefined;
  return {
    key,
    helper,
    text: [
      name === undefined
        ? `${helper}(${owner.variable})`
        : `${helper}(${owner.variable}, { relationName: ${quote(name)} })`,
    ],
  };
}

// ---------------------------------------------------------------------------
// Imports and configuration
// ---------------------------------------------------------------------------

function importLine(specifiers: string[], module: string): string {
  const inline: string = `import { ${specifiers.join(', ')} } from '${module}';`;
  return inline.length <= MAX_LINE_WIDTH
    ? inline
    : [
        'import {',
        ...specifiers.map((name: string) => `  ${name},`),
        `} from '${module}';`,
      ].join('\n');
}

function buildImports(context: EmitContext): string[] {
  const lines: string[] = [];
  if (context.coreImports.size > 0) {
    lines.push(
      importLine([...context.coreImports].sort(compareText), 'drizzle-orm')
    );
  }
  const specifiers: string[] = [
    ...[...context.imports],
    ...[...context.typeImports].map((name: string) => `type ${name}`),
  ].sort((first: string, second: string) =>
    compareText(first.replace(/^type /, ''), second.replace(/^type /, ''))
  );
  if (specifiers.length > 0) {
    lines.push(importLine(specifiers, DIALECTS[context.dialect].module));
  }
  return lines;
}

function renderConfig(dialect: Dialect): string {
  return [
    `import { defineConfig } from 'drizzle-kit';`,
    '',
    'export default defineConfig({',
    `  dialect: '${DIALECTS[dialect].kitDialect}',`,
    `  schema: './${DRIZZLE_SCHEMA_FILE}',`,
    `  out: './drizzle',`,
    '});',
    '',
  ].join('\n');
}
