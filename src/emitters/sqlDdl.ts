import type {
  IrCompositeForeignKey,
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
import { limitIdentifier, toSnakeCase } from '../naming.js';
import {
  expandManyToMany,
  normalizeSchema,
  type NamingMode,
} from '../transforms.js';
import type { EmitOutput, PrismaProvider } from './prisma.js';

/**
 * SQL DDL emitter.
 *
 * Writes ONE script of dialect-specific DDL: the extensions and enum types the dialect needs, one
 * `CREATE TABLE` per model in dependency order (a foreign key that closes a reference cycle is added
 * afterwards with `ALTER TABLE ... ADD CONSTRAINT`), and the `CREATE [UNIQUE] INDEX` statements of
 * each table. `--provider` picks the dialect: `postgresql` (also `cockroachdb`), `mysql`, `sqlite` or
 * `sqlserver`. Many-to-many fields become the join tables the other formats create. The table and
 * column names follow the naming mode like the Drizzle emitter: `preserve` keeps the database names
 * of the source, `normalize` applies the fresh-schema style (singular snake_case tables, UUID keys,
 * created_at / updated_at).
 */

export interface SqlDdlEmitOptions {
  /** Database provider; picks the SQL dialect. */
  provider: PrismaProvider;
  /** "preserve" keeps the database names of the source; "normalize" applies the fresh-schema style. */
  naming: NamingMode;
}

export type SqlDialect = 'postgresql' | 'mysql' | 'sqlite' | 'sqlserver';

/** The dialect a provider is written in. MongoDB has no SQL; CockroachDB speaks PostgreSQL. */
export function sqlDialectOf(provider: PrismaProvider): SqlDialect {
  switch (provider) {
    case 'mysql':
    case 'sqlite':
    case 'sqlserver':
      return provider;
    default:
      return 'postgresql';
  }
}

const DIALECT_LABELS: Readonly<Record<SqlDialect, string>> = {
  postgresql: 'PostgreSQL',
  mysql: 'MySQL',
  sqlite: 'SQLite',
  sqlserver: 'SQL Server',
};

/** Longest identifier each dialect accepts (SQLite has no limit; 128 keeps generated names sensible). */
const MAX_IDENTIFIER: Readonly<Record<SqlDialect, number>> = {
  postgresql: 63,
  mysql: 64,
  sqlite: 128,
  sqlserver: 128,
};

// ---------------------------------------------------------------------------
// Identifiers
// ---------------------------------------------------------------------------

/**
 * Words that cannot be used as a bare identifier in at least one of the four dialects (the union of
 * their reserved lists, plus the common names that are keywords in some of them). Quoting a name that
 * is not reserved is harmless, so one shared list keeps the output portable.
 */
const RESERVED_WORDS: ReadonlySet<string> = new Set(
  [
    // PostgreSQL
    `all analyse analyze and any array as asc asymmetric authorization binary both case cast check
    collate collation column concurrently constraint create cross current_catalog current_date
    current_role current_schema current_time current_timestamp current_user default deferrable desc
    distinct do else end except false fetch for foreign freeze from full grant group having ilike in
    initially inner intersect into is isnull join lateral leading left like limit localtime
    localtimestamp natural not notnull null offset on only or order outer overlaps placing primary
    references returning right select session_user similar some symmetric system_user table
    tablesample then to trailing true union unique user using variadic verbose when where window with`,
    // MySQL and MariaDB
    `accessible add alter asensitive before bigint blob call change char character condition continue
    convert cube cume_dist database databases day_hour day_microsecond day_minute day_second dec
    decimal declare delayed delete dense_rank describe deterministic distinctrow div double dual each
    elseif empty enclosed escaped exists exit explain first_value float float4 float8 force fulltext
    function generated get groups high_priority hour_microsecond hour_minute hour_second if ignore
    index infile inout insensitive insert int int1 int2 int3 int4 int8 integer interval
    io_after_gtids io_before_gtids iterate json_table key keys kill lag last_value lead leave
    linear lines load lock long longblob longtext loop low_priority master_bind
    master_ssl_verify_server_cert match maxvalue mediumblob mediumint mediumtext middleint
    minute_microsecond minute_second mod modifies no_write_to_binlog nth_value ntile numeric
    optimize optimizer_costs option optionally out outfile over partition percent_rank precision
    procedure purge range rank read read_write reads real recursive regexp release rename repeat
    replace require resignal restrict return revoke rlike row row_number rows schema schemas
    second_microsecond sensitive separator set show signal smallint spatial specific sql sqlexception
    sqlstate sqlwarning sql_big_result sql_calc_found_rows sql_small_result ssl starting stored
    straight_join terminated tinyblob tinyint tinytext undo unlock unsigned update usage use
    utc_date utc_time utc_timestamp values varbinary varchar varcharacter varying virtual while write
    xor year_month zerofill`,
    // SQLite
    `abort action after always attach autoincrement begin by cascade commit conflict current
    deferred detach exclude exclusive fail filter first following glob immediate indexed instead
    materialized no nothing nulls others pragma preceding query raise reindex rollback savepoint temp
    temporary ties transaction trigger unbounded vacuum view without`,
    // SQL Server
    `backup break browse bulk checkpoint close clustered coalesce commit compute contains
    containstable dbcc deallocate deny disk distributed dump errlvl exec execute external file
    fillfactor freetext freetexttable goto holdlock identity identity_insert identitycol lineno merge
    national nocheck nonclustered nullif of off offsets opendatasource openquery openrowset openxml
    pivot plan print proc public raiserror readtext reconfigure replication restore revert rowcount
    rowguidcol rule save securityaudit semantickeyphrasetable semanticsimilaritydetailstable
    semanticsimilaritytable setuser shutdown statistics textsize top tran truncate try_convert
    tsequal unpivot updatetext waitfor within writetext`,
    // Type names, which several dialects refuse as a column name
    `bigserial binary bit bool boolean char date datetime datetime2 enum json jsonb money nchar
    ntext nvarchar serial smalldatetime smallmoney text time timestamp timestamptz uuid xml year`,
  ]
    .join(' ')
    .split(/\s+/)
    .filter((word: string) => word !== '')
);

const BARE_IDENTIFIER: RegExp = /^[a-z_][a-z0-9_]*$/;

/** Quotes an identifier the way the dialect requires, and only when it has to be quoted. */
export function quoteIdentifier(dialect: SqlDialect, name: string): string {
  if (BARE_IDENTIFIER.test(name) && !RESERVED_WORDS.has(name)) {
    return name;
  }
  return quoteAlways(dialect, name);
}

function quoteAlways(dialect: SqlDialect, name: string): string {
  switch (dialect) {
    case 'mysql':
      return `\`${name.replace(/`/g, '``')}\``;
    case 'sqlserver':
      return `[${name.replace(/\]/g, ']]')}]`;
    default:
      return `"${name.replace(/"/g, '""')}"`;
  }
}

/** A string literal. MySQL also treats the backslash as an escape character. */
export function sqlStringLiteral(dialect: SqlDialect, value: string): string {
  const body: string =
    dialect === 'mysql'
      ? value.replace(/\\/g, '\\\\').replace(/'/g, "''")
      : value.replace(/'/g, "''");
  return `${dialect === 'sqlserver' ? 'N' : ''}'${body}'`;
}

/** Text that is safe inside a `--` comment (one line). */
function commentText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------------------
// Native column types (Prisma `@db.*`), by dialect
// ---------------------------------------------------------------------------

const NATIVE_TYPES: Readonly<
  Record<SqlDialect, Readonly<Record<string, string>>>
> = {
  postgresql: {
    smallint: 'SMALLINT',
    integer: 'INTEGER',
    bigint: 'BIGINT',
    decimal: 'NUMERIC',
    money: 'MONEY',
    real: 'REAL',
    doubleprecision: 'DOUBLE PRECISION',
    varchar: 'VARCHAR',
    char: 'CHAR',
    text: 'TEXT',
    bytea: 'BYTEA',
    timestamp: 'TIMESTAMP',
    timestamptz: 'TIMESTAMPTZ',
    date: 'DATE',
    time: 'TIME',
    timetz: 'TIMETZ',
    boolean: 'BOOLEAN',
    bit: 'BIT',
    varbit: 'VARBIT',
    uuid: 'UUID',
    xml: 'XML',
    inet: 'INET',
    json: 'JSON',
    jsonb: 'JSONB',
    oid: 'OID',
  },
  mysql: {
    int: 'INT',
    unsignedint: 'INT UNSIGNED',
    smallint: 'SMALLINT',
    unsignedsmallint: 'SMALLINT UNSIGNED',
    tinyint: 'TINYINT',
    unsignedtinyint: 'TINYINT UNSIGNED',
    mediumint: 'MEDIUMINT',
    unsignedmediumint: 'MEDIUMINT UNSIGNED',
    bigint: 'BIGINT',
    unsignedbigint: 'BIGINT UNSIGNED',
    float: 'FLOAT',
    double: 'DOUBLE',
    decimal: 'DECIMAL',
    varchar: 'VARCHAR',
    char: 'CHAR',
    tinytext: 'TINYTEXT',
    text: 'TEXT',
    mediumtext: 'MEDIUMTEXT',
    longtext: 'LONGTEXT',
    bit: 'BIT',
    binary: 'BINARY',
    varbinary: 'VARBINARY',
    tinyblob: 'TINYBLOB',
    blob: 'BLOB',
    mediumblob: 'MEDIUMBLOB',
    longblob: 'LONGBLOB',
    date: 'DATE',
    time: 'TIME',
    datetime: 'DATETIME',
    timestamp: 'TIMESTAMP',
    year: 'YEAR',
    json: 'JSON',
  },
  sqlite: {},
  sqlserver: {
    tinyint: 'TINYINT',
    smallint: 'SMALLINT',
    int: 'INT',
    bigint: 'BIGINT',
    decimal: 'DECIMAL',
    numeric: 'NUMERIC',
    money: 'MONEY',
    smallmoney: 'SMALLMONEY',
    float: 'FLOAT',
    real: 'REAL',
    bit: 'BIT',
    char: 'CHAR',
    nchar: 'NCHAR',
    varchar: 'VARCHAR',
    nvarchar: 'NVARCHAR',
    // TEXT, NTEXT and IMAGE are deprecated in SQL Server and cannot be compared or indexed.
    text: 'NVARCHAR(MAX)',
    ntext: 'NVARCHAR(MAX)',
    xml: 'XML',
    binary: 'BINARY',
    varbinary: 'VARBINARY',
    image: 'VARBINARY(MAX)',
    date: 'DATE',
    time: 'TIME',
    datetime: 'DATETIME',
    datetime2: 'DATETIME2',
    smalldatetime: 'SMALLDATETIME',
    datetimeoffset: 'DATETIMEOFFSET',
    uniqueidentifier: 'UNIQUEIDENTIFIER',
  },
};

const POSTGRES_RANGE_TYPES: Readonly<Record<string, string>> = {
  int: 'INT4RANGE',
  bigInt: 'INT8RANGE',
  decimal: 'NUMRANGE',
  date: 'DATERANGE',
  dateTime: 'TSTZRANGE',
};

// ---------------------------------------------------------------------------
// Working model
// ---------------------------------------------------------------------------

/** What a column holds, for the decisions that depend on it (index prefixes, default quoting). */
type Storage = 'text' | 'blob' | 'json' | 'other';

interface ColumnDef {
  name: string;
  sqlType: string;
  notNull: boolean;
  /** Text after DEFAULT, with the parentheses the dialect needs. */
  defaultSql?: string;
  autoIncrement: boolean;
  /** MySQL `ON UPDATE CURRENT_TIMESTAMP(6)`. */
  onUpdate?: string;
  checks: string[];
  comment?: string;
  storage: Storage;
  /** True when the column is a SQL Server NVARCHAR(MAX) / VARBINARY(MAX), which cannot be indexed. */
  unindexable: boolean;
}

interface ForeignKeyDef {
  name: string;
  columns: string[];
  target: IrModel;
  targetColumns: string[];
  onDelete: IrOnDelete;
  onUpdate: IrOnDelete | undefined;
  label: string;
  /** Set when the key closes a cycle and is added with ALTER TABLE. */
  deferred: boolean;
}

interface UniqueDef {
  name: string;
  columns: string[];
}

interface IndexDef {
  statement: string;
}

interface TableDef {
  model: IrModel;
  columns: ColumnDef[];
  primaryKey: string[];
  primaryKeyName: string;
  /** True when the primary key is written inline (SQLite AUTOINCREMENT). */
  inlinePrimaryKey: boolean;
  uniques: UniqueDef[];
  foreignKeys: ForeignKeyDef[];
  indexes: IndexDef[];
}

interface ColumnType {
  sql: string;
  checks: string[];
  comment?: string;
  storage: Storage;
  unindexable: boolean;
  /** True when the SQL type is textual, so a literal default is a quoted string. */
  textual: boolean;
}

interface ResolvedTarget {
  columnName: string;
  /** The field that describes the referenced column's type. */
  field: IrField;
}

interface EmitContext {
  dialect: SqlDialect;
  schema: IrSchema;
  warnings: string[];
  enums: Map<string, ResolvedEnum>;
  /** Constraint and index names already used (they share one namespace per schema in PostgreSQL). */
  names: Set<string>;
  /** Fields refreshed by the ORM on update that the dialect cannot express. */
  unexpressedAutoUpdates: string[];
  needsHstore: boolean;
}

interface ResolvedEnum {
  definition: IrEnum;
  dbName: string;
}

const NOW_DEFAULTS: Readonly<
  Record<SqlDialect, Readonly<Record<'dateTime' | 'date' | 'time', string>>>
> = {
  postgresql: {
    dateTime: 'now()',
    date: 'CURRENT_DATE',
    time: 'CURRENT_TIME',
  },
  mysql: {
    dateTime: 'CURRENT_TIMESTAMP(6)',
    date: '(CURRENT_DATE)',
    time: '(CURRENT_TIME)',
  },
  sqlite: {
    dateTime: 'CURRENT_TIMESTAMP',
    date: 'CURRENT_DATE',
    time: 'CURRENT_TIME',
  },
  sqlserver: {
    dateTime: 'SYSUTCDATETIME()',
    date: '(CAST(SYSUTCDATETIME() AS DATE))',
    time: '(CAST(SYSUTCDATETIME() AS TIME))',
  },
};

/** A version 4 UUID built from SQLite's random bytes (SQLite has no uuid function). */
const SQLITE_UUID_EXPRESSION: string =
  "(lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || " +
  "substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) || " +
  "substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))))";

/** MySQL wants CURRENT_TIMESTAMP(n) to have the fractional seconds of the column it fills. */
function mysqlCurrentTimestamp(columnType: string): string {
  const precision: RegExpExecArray | null = /\((\d)\)/.exec(columnType);
  return precision === null || precision[1] === '0'
    ? 'CURRENT_TIMESTAMP'
    : `CURRENT_TIMESTAMP(${precision[1] ?? '6'})`;
}

const UUID_DEFAULTS: Readonly<Record<SqlDialect, string>> = {
  postgresql: 'gen_random_uuid()',
  mysql: '(UUID())',
  sqlite: SQLITE_UUID_EXPRESSION,
  sqlserver: 'NEWID()',
};

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function emitSqlDdl(
  schema: IrSchema,
  options: SqlDdlEmitOptions
): EmitOutput {
  // The join table of a many-to-many field is an ordinary table in SQL.
  const expanded: IrSchema = expandManyToMany(schema);
  const prepared: IrSchema =
    options.naming === 'normalize' ? normalizeSchema(expanded) : expanded;
  const dialect: SqlDialect = sqlDialectOf(options.provider);
  const context: EmitContext = {
    dialect,
    schema: prepared,
    warnings: [],
    enums: new Map<string, ResolvedEnum>(),
    names: new Set<string>(),
    unexpressedAutoUpdates: [],
    needsHstore: false,
  };
  warnAboutProvider(context, options.provider);
  warnAboutIgnoredConstructs(context);
  resolveEnums(context, options.naming);

  const tables: TableDef[] = [];
  const views: IrModel[] = [];
  for (const model of prepared.models) {
    if (model.isView === true) {
      views.push(model);
    } else {
      tables.push(buildTable(context, model));
    }
  }
  const ordered: TableDef[] = orderTables(context, tables);
  if (dialect === 'sqlserver') {
    limitCascadePaths(context, ordered);
  }
  for (const table of ordered) {
    buildIndexes(context, table);
  }
  for (const view of views) {
    context.warnings.push(
      `${view.name}: this is a database view; the schema has no SQL definition for it, so only a commented placeholder was written.`
    );
  }
  if (context.unexpressedAutoUpdates.length > 0) {
    context.warnings.push(
      `${DIALECT_LABELS[dialect]} cannot refresh a column on update from the DDL (${context.unexpressedAutoUpdates.join(', ')}); the application or a trigger has to set it.`
    );
  }

  return { text: render(context, ordered, views), warnings: context.warnings };
}

function warnAboutProvider(
  context: EmitContext,
  provider: PrismaProvider
): void {
  if (provider === 'mongodb') {
    context.warnings.push(
      'Provider "mongodb": MongoDB has no SQL schema; PostgreSQL DDL was written.'
    );
  } else if (provider === 'cockroachdb') {
    context.warnings.push(
      'Provider "cockroachdb": PostgreSQL DDL was written, which CockroachDB accepts; check the types it maps differently.'
    );
  }
}

function warnAboutIgnoredConstructs(context: EmitContext): void {
  for (const definition of context.schema.enums) {
    if (definition.schema !== undefined) {
      context.warnings.push(
        `enum ${definition.name}: the database schema "${definition.schema}" (@@schema) was ignored; the type was created in the default schema.`
      );
    }
  }
  for (const model of context.schema.models) {
    if (model.schema !== undefined) {
      context.warnings.push(
        `${model.name}: the database schema "${model.schema}" (@@schema) was ignored; the table was created in the default schema.`
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

function quote(context: EmitContext, name: string): string {
  return quoteIdentifier(context.dialect, name);
}

function quoteList(context: EmitContext, names: string[]): string {
  return names.map((name: string) => quote(context, name)).join(', ');
}

/** Reserves a constraint or index name; a name that is already taken gets a numeric suffix. */
function claimName(context: EmitContext, wanted: string): string {
  const max: number = MAX_IDENTIFIER[context.dialect];
  let candidate: string = wanted;
  let suffix: number = 2;
  while (context.names.has(candidate.toLowerCase())) {
    candidate = `${limitIdentifier(wanted, max - 3)}_${suffix}`;
    suffix += 1;
  }
  context.names.add(candidate.toLowerCase());
  return candidate;
}

function generatedName(
  context: EmitContext,
  table: string,
  columns: string[],
  suffix: string
): string {
  return claimName(
    context,
    limitIdentifier(
      `${table}_${columns.join('_')}_${suffix}`,
      MAX_IDENTIFIER[context.dialect]
    )
  );
}

function checkIdentifierLength(
  context: EmitContext,
  label: string,
  name: string
): void {
  const max: number = MAX_IDENTIFIER[context.dialect];
  if (context.dialect !== 'sqlite' && name.length > max) {
    context.warnings.push(
      `${label}: the name "${name}" is longer than the ${max} characters ${DIALECT_LABELS[context.dialect]} allows in an identifier.`
    );
  }
}

function resolveEnums(context: EmitContext, naming: NamingMode): void {
  for (const definition of context.schema.enums) {
    if (definition.values.length === 0) {
      context.warnings.push(
        `enum ${definition.name}: an enum without values cannot be written; columns that use it became plain strings.`
      );
      continue;
    }
    const dbName: string = definition.dbName ?? definition.name;
    let name: string = naming === 'normalize' ? toSnakeCase(dbName) : dbName;
    if (context.dialect === 'postgresql') {
      // A PostgreSQL type shares its namespace with the tables (every table is also a row type).
      const taken: Set<string> = new Set<string>(
        context.schema.models.map((model: IrModel) => model.tableName)
      );
      for (const other of context.enums.values()) {
        taken.add(other.dbName);
      }
      if (taken.has(name)) {
        const renamed: string = `${name}_enum`;
        context.warnings.push(
          `enum ${definition.name}: the type name "${name}" is already used by a table or another type; the type was named "${renamed}".`
        );
        name = renamed;
      }
    }
    context.enums.set(definition.name, { definition, dbName: name });
  }
}

function enumOf(
  context: EmitContext,
  field: IrField
): ResolvedEnum | undefined {
  return field.enumName === undefined
    ? undefined
    : context.enums.get(field.enumName);
}

// ---------------------------------------------------------------------------
// Column types
// ---------------------------------------------------------------------------

function sizedType(base: string, args: (number | undefined)[]): string {
  const given: number[] = [];
  for (const arg of args) {
    if (arg !== undefined) {
      given.push(arg);
    }
  }
  return given.length === 0 ? base : `${base}(${given.join(', ')})`;
}

/** The SQL type for a Prisma `@db.*` native type, when the dialect has that type. */
function nativeTypeSql(
  dialect: SqlDialect,
  field: IrField
): string | undefined {
  if (field.nativeType === undefined) {
    return undefined;
  }
  const known: string | undefined =
    NATIVE_TYPES[dialect][field.nativeType.name.toLowerCase()];
  if (known === undefined) {
    return undefined;
  }
  const args: string[] = field.nativeType.args.map((arg: string) =>
    /^max$/i.test(arg) ? 'MAX' : arg
  );
  if (args.length === 0) {
    return known;
  }
  // "INT UNSIGNED" style names put the size after the first word.
  const [first, ...rest] = known.split(' ');
  return `${first ?? known}(${args.join(', ')})${rest.length > 0 ? ` ${rest.join(' ')}` : ''}`;
}

function storageOf(type: IrField['type']): Storage {
  switch (type) {
    case 'text':
      return 'text';
    case 'bytes':
      return 'blob';
    case 'json':
    case 'hstore':
      return 'json';
    default:
      return 'other';
  }
}

function plainType(sql: string, field: IrField): ColumnType {
  return {
    sql,
    checks: [],
    storage: storageOf(field.type),
    unindexable: false,
    textual: false,
  };
}

/** The column type of a field, with the CHECK constraints and notes that go with it. */
function columnType(
  context: EmitContext,
  label: string,
  field: IrField,
  columnSql: string
): ColumnType {
  const depth: number = field.arrayDepth ?? 0;
  const element: ColumnType = scalarColumnType(
    context,
    label,
    { ...field, arrayDepth: undefined },
    columnSql,
    depth > 0
  );
  if (depth === 0) {
    return element;
  }
  if (context.dialect === 'postgresql') {
    return {
      ...element,
      sql: `${element.sql}${'[]'.repeat(depth)}`,
      storage: 'other',
    };
  }
  const label2: string = DIALECT_LABELS[context.dialect];
  context.warnings.push(
    `${label}: ${label2} has no array column type; the array was written as a JSON ${context.dialect === 'sqlite' ? 'text ' : ''}column.`
  );
  return jsonColumnType(context, columnSql, 'an array stored as JSON');
}

function jsonColumnType(
  context: EmitContext,
  columnSql: string,
  note?: string
): ColumnType {
  const base: Pick<ColumnType, 'storage' | 'textual'> = {
    storage: 'json',
    textual: true,
  };
  switch (context.dialect) {
    case 'postgresql':
      return {
        ...base,
        sql: 'JSONB',
        checks: [],
        unindexable: false,
        ...(note === undefined ? {} : { comment: note }),
      };
    case 'mysql':
      return {
        ...base,
        sql: 'JSON',
        checks: [],
        // MySQL cannot index a JSON column directly.
        unindexable: true,
        ...(note === undefined ? {} : { comment: note }),
      };
    case 'sqlite':
      return {
        ...base,
        sql: 'TEXT',
        checks: [`json_valid(${columnSql})`],
        unindexable: false,
        ...(note === undefined ? {} : { comment: note }),
      };
    default:
      return {
        ...base,
        sql: 'NVARCHAR(MAX)',
        checks: [`ISJSON(${columnSql}) = 1`],
        unindexable: true,
        ...(note === undefined ? {} : { comment: note }),
      };
  }
}

function scalarColumnType(
  context: EmitContext,
  label: string,
  field: IrField,
  columnSql: string,
  isArrayElement: boolean
): ColumnType {
  const dialect: SqlDialect = context.dialect;
  const enumInfo: ResolvedEnum | undefined = enumOf(context, field);
  if (field.enumName !== undefined && enumInfo === undefined) {
    context.warnings.push(
      `${label}: enum "${field.enumName}" does not exist in the schema; the column was written as a plain string.`
    );
  }
  if (enumInfo !== undefined) {
    return enumColumnType(context, enumInfo, columnSql, isArrayElement);
  }

  const native: string | undefined = nativeTypeSql(dialect, field);
  if (native !== undefined) {
    return {
      ...plainType(native, field),
      textual: /CHAR|TEXT|UUID|UNIQUEIDENTIFIER|JSON|XML/i.test(native),
      unindexable:
        /\(MAX\)$/i.test(native) || /^(TEXT|NTEXT|IMAGE)$/i.test(native),
    };
  }

  switch (field.type) {
    case 'string':
      return stringColumnType(context, label, field);
    case 'text':
      return {
        sql:
          dialect === 'mysql'
            ? 'LONGTEXT'
            : dialect === 'sqlserver'
              ? 'NVARCHAR(MAX)'
              : 'TEXT',
        checks: [],
        storage: 'text',
        unindexable: dialect === 'sqlserver',
        textual: true,
      };
    case 'uuid':
      return {
        sql:
          dialect === 'postgresql'
            ? 'UUID'
            : dialect === 'sqlserver'
              ? 'UNIQUEIDENTIFIER'
              : 'CHAR(36)',
        checks: [],
        storage: 'other',
        unindexable: false,
        textual: true,
      };
    case 'int':
      return plainType(
        dialect === 'mysql' || dialect === 'sqlserver' ? 'INT' : 'INTEGER',
        field
      );
    case 'bigInt':
      return plainType('BIGINT', field);
    case 'float':
      return plainType(
        dialect === 'postgresql'
          ? 'DOUBLE PRECISION'
          : dialect === 'sqlite'
            ? 'REAL'
            : dialect === 'mysql'
              ? 'DOUBLE'
              : 'FLOAT',
        field
      );
    case 'decimal':
      return plainType(decimalType(context, label, field), field);
    case 'boolean':
      return plainType(dialect === 'sqlserver' ? 'BIT' : 'BOOLEAN', field);
    case 'dateTime':
      return plainType(
        dialect === 'postgresql'
          ? 'TIMESTAMPTZ'
          : dialect === 'mysql'
            ? 'DATETIME(6)'
            : dialect === 'sqlite'
              ? 'DATETIME'
              : 'DATETIME2',
        field
      );
    case 'date':
      return plainType('DATE', field);
    case 'time':
      return plainType(dialect === 'mysql' ? 'TIME(6)' : 'TIME', field);
    case 'json':
      return jsonColumnType(context, columnSql);
    case 'bytes':
      return {
        sql:
          dialect === 'postgresql'
            ? 'BYTEA'
            : dialect === 'mysql'
              ? 'LONGBLOB'
              : dialect === 'sqlite'
                ? 'BLOB'
                : 'VARBINARY(MAX)',
        checks: [],
        storage: 'blob',
        unindexable: dialect === 'sqlserver',
        textual: false,
      };
    case 'duration':
      if (dialect === 'postgresql') {
        return plainType('INTERVAL', field);
      }
      context.warnings.push(
        `${label}: ${DIALECT_LABELS[dialect]} has no interval type; the duration was written as an integer (microseconds).`
      );
      return {
        ...plainType(dialect === 'sqlite' ? 'INTEGER' : 'BIGINT', field),
        comment: 'duration in microseconds',
      };
    case 'ipAddress':
      if (dialect === 'postgresql') {
        return plainType('INET', field);
      }
      return {
        sql: dialect === 'sqlite' ? 'TEXT' : 'VARCHAR(45)',
        checks: [],
        storage: 'other',
        unindexable: false,
        textual: true,
      };
    case 'hstore':
      if (dialect === 'postgresql') {
        context.needsHstore = true;
        return { ...plainType('HSTORE', field), textual: true };
      }
      context.warnings.push(
        `${label}: hstore exists only on PostgreSQL; the column was written as JSON.`
      );
      return jsonColumnType(context, columnSql, 'hstore stored as JSON');
    case 'range':
      return rangeColumnType(context, label, field);
    case 'unsupported':
      return unsupportedColumnType(context, label, field);
    default:
      context.warnings.push(
        `${label}: unknown field type "${String(field.type)}"; it was written as text.`
      );
      return { ...plainType('TEXT', field), textual: true };
  }
}

function stringColumnType(
  context: EmitContext,
  label: string,
  field: IrField
): ColumnType {
  const dialect: SqlDialect = context.dialect;
  const length: number | undefined = field.maxLength;
  const textual = (sql: string, storage: Storage = 'other'): ColumnType => ({
    sql,
    checks: [],
    storage,
    unindexable: false,
    textual: true,
  });
  switch (dialect) {
    case 'postgresql':
      return textual(length === undefined ? 'TEXT' : `VARCHAR(${length})`);
    case 'mysql':
      if (length === undefined) {
        // MySQL cannot key an unbounded text column and VARCHAR needs a length.
        return textual('VARCHAR(255)');
      }
      if (length > 16383) {
        context.warnings.push(
          `${label}: VARCHAR(${length}) does not fit a MySQL row; the column was written as LONGTEXT.`
        );
        return textual('LONGTEXT', 'text');
      }
      return textual(`VARCHAR(${length})`);
    case 'sqlite':
      return textual(length === undefined ? 'TEXT' : `VARCHAR(${length})`);
    default: {
      if (length === undefined) {
        return textual('NVARCHAR(255)');
      }
      if (length > 4000) {
        return { ...textual('NVARCHAR(MAX)', 'text'), unindexable: true };
      }
      return textual(`NVARCHAR(${length})`);
    }
  }
}

function decimalType(
  context: EmitContext,
  label: string,
  field: IrField
): string {
  const dialect: SqlDialect = context.dialect;
  let precision: number | undefined = field.maxDigits;
  let scale: number | undefined = field.decimalPlaces;
  if (precision === undefined) {
    scale = undefined;
    if (dialect === 'mysql') {
      precision = 65;
      scale = 30;
    } else if (dialect === 'sqlserver') {
      precision = 32;
      scale = 16;
    }
  }
  const limit: number | undefined =
    dialect === 'mysql' ? 65 : dialect === 'sqlserver' ? 38 : undefined;
  if (precision !== undefined && limit !== undefined && precision > limit) {
    context.warnings.push(
      `${label}: ${DIALECT_LABELS[dialect]} allows at most ${limit} digits in a decimal; ${precision} was reduced to ${limit}.`
    );
    precision = limit;
    if (scale !== undefined && scale > limit) {
      scale = limit;
    }
  }
  if (dialect === 'mysql' && scale !== undefined && scale > 30) {
    context.warnings.push(
      `${label}: MySQL allows at most 30 decimal places; ${scale} was reduced to 30.`
    );
    scale = 30;
  }
  const base: string =
    dialect === 'postgresql'
      ? 'NUMERIC'
      : dialect === 'sqlite'
        ? precision === undefined
          ? 'NUMERIC'
          : 'DECIMAL'
        : 'DECIMAL';
  return sizedType(base, [
    precision,
    precision === undefined ? undefined : scale,
  ]);
}

function rangeColumnType(
  context: EmitContext,
  label: string,
  field: IrField
): ColumnType {
  if (context.dialect === 'postgresql') {
    return {
      ...plainType(
        POSTGRES_RANGE_TYPES[field.rangeOf ?? 'int'] ?? 'INT4RANGE',
        field
      ),
      storage: 'other',
    };
  }
  context.warnings.push(
    `${label}: range columns exist only on PostgreSQL; the column was written as text.`
  );
  return {
    sql:
      context.dialect === 'sqlite'
        ? 'TEXT'
        : context.dialect === 'mysql'
          ? 'VARCHAR(255)'
          : 'NVARCHAR(255)',
    checks: [],
    comment: 'range stored as text',
    storage: 'other',
    unindexable: false,
    textual: true,
  };
}

function unsupportedColumnType(
  context: EmitContext,
  label: string,
  field: IrField
): ColumnType {
  if (field.unsupportedType !== undefined && field.unsupportedType !== '') {
    context.warnings.push(
      `${label}: the database type "${field.unsupportedType}" (Prisma Unsupported) was written as it is; check that ${DIALECT_LABELS[context.dialect]} has it.`
    );
    return {
      ...plainType(field.unsupportedType, field),
      storage: 'other',
      textual: false,
    };
  }
  context.warnings.push(
    `${label}: the column has an unsupported database type that is unknown; it was written as text.`
  );
  return { ...plainType('TEXT', field), textual: true };
}

function enumColumnType(
  context: EmitContext,
  info: ResolvedEnum,
  columnSql: string,
  isArrayElement: boolean
): ColumnType {
  const dialect: SqlDialect = context.dialect;
  const values: string[] = info.definition.values.map((value: IrEnumValue) =>
    sqlStringLiteral(dialect, value.dbValue)
  );
  if (dialect === 'postgresql') {
    return {
      sql: quote(context, info.dbName),
      checks: [],
      storage: 'other',
      unindexable: false,
      textual: true,
    };
  }
  if (dialect === 'mysql') {
    return {
      sql: `ENUM(${values.join(', ')})`,
      checks: [],
      storage: 'other',
      unindexable: false,
      textual: true,
    };
  }
  const longest: number = Math.max(
    ...info.definition.values.map((value: IrEnumValue) => value.dbValue.length)
  );
  const length: number = Math.max(longest, 1);
  return {
    sql:
      dialect === 'sqlite'
        ? `VARCHAR(${length})`
        : `NVARCHAR(${Math.min(Math.max(length, 50), 4000)})`,
    checks: isArrayElement ? [] : [`${columnSql} IN (${values.join(', ')})`],
    storage: 'other',
    unindexable: false,
    textual: true,
  };
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

function booleanLiteral(dialect: SqlDialect, value: boolean): string {
  if (dialect === 'postgresql' || dialect === 'mysql') {
    return value ? 'TRUE' : 'FALSE';
  }
  return value ? '1' : '0';
}

/** MySQL wants an expression default in parentheses for TEXT, BLOB and JSON columns. */
function wrapForColumn(
  context: EmitContext,
  type: ColumnType,
  literal: string
): string {
  if (context.dialect === 'mysql' && type.storage !== 'other') {
    return `(${literal})`;
  }
  return literal;
}

interface ParsedJson {
  ok: boolean;
  value?: unknown;
}

function parseJson(text: string): ParsedJson {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

/** Writes a JSON array as a PostgreSQL array literal body, e.g. {"a","b"}. */
function postgresArray(value: unknown[]): string {
  const items: string[] = value.map((item: unknown): string => {
    if (Array.isArray(item)) {
      return postgresArray(item);
    }
    if (item === null) {
      return 'NULL';
    }
    if (typeof item === 'number' || typeof item === 'boolean') {
      return String(item);
    }
    const text: string = typeof item === 'string' ? item : JSON.stringify(item);
    return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  });
  return `{${items.join(',')}}`;
}

function dateTimeLiteral(
  dialect: SqlDialect,
  value: string
): string | undefined {
  const time: number = Date.parse(value);
  if (Number.isNaN(time)) {
    return undefined;
  }
  const iso: string = new Date(time).toISOString();
  switch (dialect) {
    case 'postgresql':
      return `'${iso}'`;
    case 'sqlserver':
      return `'${iso.replace('Z', '')}'`;
    default:
      return `'${iso
        .replace('T', ' ')
        .replace('Z', '')
        .replace(/\.000$/, '')}'`;
  }
}

function enumStoredValue(info: ResolvedEnum, raw: string): string | undefined {
  const value: IrEnumValue | undefined =
    info.definition.values.find(
      (candidate: IrEnumValue) => candidate.name === raw
    ) ??
    info.definition.values.find(
      (candidate: IrEnumValue) => candidate.dbValue === raw
    );
  return value?.dbValue;
}

const UUID_EXPRESSIONS: ReadonlySet<string> = new Set([
  'gen_random_uuid()',
  'uuid_generate_v4()',
  'uuid()',
  '(uuid())',
  'newid()',
  'newsequentialid()',
]);

const NOW_EXPRESSIONS: ReadonlySet<string> = new Set([
  'now()',
  'current_timestamp',
  'current_timestamp()',
  'getdate()',
  'getutcdate()',
  'sysdatetime()',
  'sysutcdatetime()',
  "datetime('now')",
]);

/** The dialect's own form of a default expression that every database has under some name. */
function knownExpression(
  dialect: SqlDialect,
  field: IrField,
  expression: string,
  type: ColumnType
): string | undefined {
  const normalized: string = expression.replace(/\s+/g, '').toLowerCase();
  if (UUID_EXPRESSIONS.has(normalized) && type.textual) {
    return UUID_DEFAULTS[dialect];
  }
  if (NOW_EXPRESSIONS.has(normalized) && field.type === 'dateTime') {
    return dialect === 'mysql'
      ? mysqlCurrentTimestamp(type.sql)
      : NOW_DEFAULTS[dialect].dateTime;
  }
  return undefined;
}

/** The text after DEFAULT for a field, or undefined when there is none (or it cannot be written). */
function defaultSql(
  context: EmitContext,
  label: string,
  field: IrField,
  type: ColumnType
): string | undefined {
  const value: IrDefault | undefined = field.default;
  if (value === undefined) {
    return undefined;
  }
  const dialect: SqlDialect = context.dialect;
  const dropped = (reason: string): undefined => {
    context.warnings.push(`${label}: ${reason}; the default was dropped.`);
    return undefined;
  };
  switch (value.kind) {
    case 'autoIncrement':
      // Handled with the column itself.
      return undefined;
    case 'now': {
      if (
        field.type !== 'dateTime' &&
        field.type !== 'date' &&
        field.type !== 'time'
      ) {
        return dropped(
          `a "now" default on a ${field.type} column cannot be written`
        );
      }
      return dialect === 'mysql' && field.type === 'dateTime'
        ? mysqlCurrentTimestamp(type.sql)
        : NOW_DEFAULTS[dialect][field.type];
    }
    case 'uuid':
      if (field.type !== 'uuid') {
        return dropped(
          `a UUID default on a ${field.type} column cannot be written`
        );
      }
      return UUID_DEFAULTS[dialect];
    case 'clientGenerated':
      return dropped(
        `the ${value.generator}() default is generated by the ORM client, not the database`
      );
    case 'dbExpression': {
      if (value.isFunction === true) {
        return dropped(
          `the ${value.expression} default function has no SQL equivalent`
        );
      }
      const known: string | undefined = knownExpression(
        dialect,
        field,
        value.expression,
        type
      );
      if (known !== undefined) {
        return known;
      }
      context.warnings.push(
        `${label}: the database default expression ${value.expression} was written as it is; check that ${DIALECT_LABELS[dialect]} accepts it.`
      );
      const expression: string = value.expression.trim();
      return expression.startsWith('(') ? expression : `(${expression})`;
    }
    case 'enumValue': {
      const info: ResolvedEnum | undefined = enumOf(context, field);
      const stored: string | undefined =
        info === undefined ? undefined : enumStoredValue(info, value.value);
      if (stored === undefined) {
        context.warnings.push(
          `${label}: the enum default "${value.value}" does not match a member of the enum; it was written as a string.`
        );
      }
      return sqlStringLiteral(dialect, stored ?? value.value);
    }
    case 'literal':
      return literalDefault(context, label, field, value.value, type);
    default:
      return undefined;
  }
}

function literalDefault(
  context: EmitContext,
  label: string,
  field: IrField,
  value: string | number | boolean,
  type: ColumnType
): string | undefined {
  const dialect: SqlDialect = context.dialect;
  const dropped = (reason: string): undefined => {
    context.warnings.push(`${label}: ${reason}; the default was dropped.`);
    return undefined;
  };
  const text: string = String(value);
  if ((field.arrayDepth ?? 0) > 0) {
    const parsed: ParsedJson =
      typeof value === 'string' ? parseJson(value) : { ok: false };
    if (!parsed.ok || !Array.isArray(parsed.value)) {
      return dropped(`the array default ${text} cannot be written`);
    }
    if (dialect === 'postgresql') {
      return sqlStringLiteral(dialect, postgresArray(parsed.value));
    }
    return wrapForColumn(
      context,
      type,
      sqlStringLiteral(dialect, JSON.stringify(parsed.value))
    );
  }
  const info: ResolvedEnum | undefined = enumOf(context, field);
  if (info !== undefined) {
    return sqlStringLiteral(dialect, enumStoredValue(info, text) ?? text);
  }
  switch (field.type) {
    case 'int':
    case 'bigInt':
    case 'float': {
      const numeric: number = typeof value === 'number' ? value : Number(text);
      return typeof value === 'boolean' || !Number.isFinite(numeric)
        ? dropped(`the value ${text} is not a number`)
        : String(numeric);
    }
    case 'duration': {
      if (dialect === 'postgresql') {
        return sqlStringLiteral(dialect, text);
      }
      const numeric: number = Number(text);
      return typeof value === 'boolean' || !Number.isFinite(numeric)
        ? dropped(`the value ${text} is not a number`)
        : String(numeric);
    }
    case 'decimal':
      return /^-?\d+(\.\d+)?$/.test(text)
        ? text
        : sqlStringLiteral(dialect, text);
    case 'boolean': {
      if (typeof value === 'boolean') {
        return booleanLiteral(dialect, value);
      }
      const lower: string = text.toLowerCase();
      if (lower === 'true' || lower === '1') {
        return booleanLiteral(dialect, true);
      }
      return lower === 'false' || lower === '0'
        ? booleanLiteral(dialect, false)
        : dropped(`the value ${text} is not a boolean`);
    }
    case 'dateTime': {
      const literal: string | undefined = dateTimeLiteral(dialect, text);
      return literal === undefined
        ? dropped(`the value ${text} is not a date`)
        : literal;
    }
    case 'json': {
      const parsed: ParsedJson =
        typeof value === 'string' ? parseJson(text) : { ok: true, value };
      if (!parsed.ok) {
        return dropped(`the value ${text} is not JSON`);
      }
      const json: string = sqlStringLiteral(
        dialect,
        JSON.stringify(parsed.value)
      );
      return wrapForColumn(
        context,
        type,
        dialect === 'postgresql' ? `${json}::jsonb` : json
      );
    }
    case 'bytes':
      return dropped('a literal default on a binary column cannot be written');
    case 'hstore': {
      if (dialect === 'postgresql') {
        return text === '{}'
          ? "''::hstore"
          : dropped('only an empty hstore default can be written');
      }
      const parsed: ParsedJson = parseJson(text);
      return parsed.ok
        ? wrapForColumn(
            context,
            type,
            sqlStringLiteral(dialect, JSON.stringify(parsed.value))
          )
        : dropped(`the value ${text} is not JSON`);
    }
    case 'range':
      return dropped('a range default cannot be written');
    default:
      return wrapForColumn(context, type, sqlStringLiteral(dialect, text));
  }
}

// ---------------------------------------------------------------------------
// Referenced columns
// ---------------------------------------------------------------------------

function isIntegerKey(field: IrField): boolean {
  return field.type === 'int' || field.type === 'bigInt';
}

/** Resolves the column a foreign key points at: `toField`, otherwise the target's single-column key. */
function resolveTarget(
  context: EmitContext,
  target: IrModel,
  toField: string | undefined,
  depth: number = 0
): ResolvedTarget | undefined {
  if (depth > 5) {
    return undefined;
  }
  if (toField !== undefined) {
    const named: IrField | undefined =
      target.fields.find((candidate: IrField) => candidate.name === toField) ??
      target.fields.find(
        (candidate: IrField) => candidate.columnName === toField
      );
    if (named !== undefined) {
      return { columnName: named.columnName, field: named };
    }
    const viaRelation: IrRelation | undefined = target.relations.find(
      (candidate: IrRelation) =>
        candidate.kind !== 'manyToMany' &&
        (candidate.name === toField || candidate.columnName === toField)
    );
    return viaRelation === undefined
      ? undefined
      : resolveRelationColumn(context, target, viaRelation, depth);
  }
  const keyFields: IrField[] = target.fields.filter(
    (candidate: IrField) => candidate.isPrimaryKey
  );
  const keyRelations: IrRelation[] = target.relations.filter(
    (candidate: IrRelation) =>
      candidate.kind !== 'manyToMany' && candidate.isPrimaryKey === true
  );
  const composite: string[] = target.compositePrimaryKey ?? [];
  if (composite.length > 1) {
    return undefined;
  }
  const onlyField: IrField | undefined =
    keyFields.length === 1 && keyRelations.length === 0
      ? keyFields[0]
      : composite.length === 1
        ? target.fields.find(
            (candidate: IrField) => candidate.name === composite[0]
          )
        : undefined;
  if (onlyField !== undefined) {
    return { columnName: onlyField.columnName, field: onlyField };
  }
  const onlyRelation: IrRelation | undefined =
    keyRelations.length === 1 && keyFields.length === 0
      ? keyRelations[0]
      : target.relations.find(
          (candidate: IrRelation) =>
            candidate.kind !== 'manyToMany' && candidate.name === composite[0]
        );
  return onlyRelation === undefined
    ? undefined
    : resolveRelationColumn(context, target, onlyRelation, depth);
}

/** A relation column takes the type of the column it points at. */
function resolveRelationColumn(
  context: EmitContext,
  owner: IrModel,
  relation: IrRelation,
  depth: number
): ResolvedTarget | undefined {
  const next: IrModel | undefined = findModel(
    context.schema,
    relation.targetModel
  );
  if (next === undefined || next === owner) {
    return undefined;
  }
  const inner: ResolvedTarget | undefined = resolveTarget(
    context,
    next,
    relation.toField,
    depth + 1
  );
  return inner === undefined
    ? undefined
    : { columnName: relation.columnName, field: inner.field };
}

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

function columnNameOf(model: IrModel, name: string): string | undefined {
  const relation: IrRelation | undefined =
    model.relations.find(
      (candidate: IrRelation) =>
        candidate.kind !== 'manyToMany' && candidate.name === name
    ) ??
    model.relations.find(
      (candidate: IrRelation) =>
        candidate.kind !== 'manyToMany' && candidate.columnName === name
    );
  const field: IrField | undefined =
    model.fields.find((candidate: IrField) => candidate.name === name) ??
    model.fields.find((candidate: IrField) => candidate.columnName === name);
  // A field wins over a relation of the same name: the field is the column the key is written on.
  return field?.columnName ?? relation?.columnName;
}

function isAutoIncrement(field: IrField): boolean {
  return field.default?.kind === 'autoIncrement';
}

function buildTable(context: EmitContext, model: IrModel): TableDef {
  const dialect: SqlDialect = context.dialect;
  checkIdentifierLength(context, model.name, model.tableName);
  const columns: ColumnDef[] = [];
  const known: Set<string> = new Set<string>();

  // The primary key: the composite key when there is one, otherwise the key fields and relations.
  const composite: string[] = (model.compositePrimaryKey ?? [])
    .map((name: string) => columnNameOf(model, name))
    .filter((name: string | undefined): name is string => name !== undefined);
  const declaredKey: string[] = [
    ...model.fields
      .filter((field: IrField) => field.isPrimaryKey)
      .map((field: IrField) => field.columnName),
    ...model.relations
      .filter(
        (relation: IrRelation) =>
          relation.kind !== 'manyToMany' && relation.isPrimaryKey === true
      )
      .map((relation: IrRelation) => relation.columnName),
  ];
  const primaryKey: string[] = composite.length > 0 ? composite : declaredKey;
  const singleColumnKey: boolean = primaryKey.length === 1;

  for (const field of model.fields) {
    checkIdentifierLength(
      context,
      `${model.name}.${field.name}`,
      field.columnName
    );
    known.add(field.columnName);
    columns.push(
      fieldColumn(context, model, field, primaryKey, singleColumnKey)
    );
  }

  const foreignKeys: ForeignKeyDef[] = [];
  const uniques: UniqueDef[] = [];
  for (const relation of model.relations) {
    if (relation.kind === 'manyToMany') {
      continue;
    }
    const label: string = `${model.name}.${relation.name}`;
    const target: IrModel | undefined = findModel(
      context.schema,
      relation.targetModel
    );
    if (target === undefined) {
      context.warnings.push(
        `${label}: target model "${relation.targetModel}" does not exist in the schema; the relation was skipped.`
      );
      continue;
    }
    if (target.isView === true) {
      context.warnings.push(
        `${label}: target "${target.name}" is a view, which a foreign key cannot reference; the relation was skipped.`
      );
      continue;
    }
    const referenced: ResolvedTarget | undefined = resolveTarget(
      context,
      target,
      relation.toField
    );
    if (referenced === undefined) {
      context.warnings.push(
        `${label}: target model "${target.name}" has no single column to reference (a composite or missing key); the relation was skipped.`
      );
      continue;
    }
    warnAboutUnreferenceable(context, label, target, referenced);
    if (!known.has(relation.columnName)) {
      checkIdentifierLength(context, label, relation.columnName);
      known.add(relation.columnName);
      columns.push(
        relationColumn(
          context,
          model,
          relation,
          referenced,
          primaryKey,
          singleColumnKey
        )
      );
    }
    const keyed: boolean =
      relation.isPrimaryKey === true ||
      primaryKey.includes(relation.columnName);
    if (relation.kind === 'oneToOne' && !keyed) {
      uniques.push({
        name: generatedName(
          context,
          model.tableName,
          [relation.columnName],
          'key'
        ),
        columns: [relation.columnName],
      });
    }
    if (relation.onDelete === 'setNull' && !relation.isNullable) {
      context.warnings.push(
        `${label}: onDelete SET NULL on a required relation will fail at the database level; review the relation.`
      );
    }
    foreignKeys.push({
      name: claimName(
        context,
        relation.constraintName ??
          limitIdentifier(
            `${model.tableName}_${relation.columnName}_fkey`,
            MAX_IDENTIFIER[dialect]
          )
      ),
      columns: [relation.columnName],
      target,
      targetColumns: [referenced.columnName],
      onDelete: relation.onDelete,
      onUpdate: relation.onUpdate,
      label,
      deferred: false,
    });
  }

  for (const key of model.compositeForeignKeys ?? []) {
    const built: ForeignKeyDef | undefined = compositeKey(context, model, key);
    if (built !== undefined) {
      foreignKeys.push(built);
    }
  }

  for (const field of model.fields) {
    if (
      field.isUnique &&
      !field.isPrimaryKey &&
      !primaryKey.includes(field.columnName)
    ) {
      uniques.push({
        name: claimName(
          context,
          field.uniqueName ??
            limitIdentifier(
              `${model.tableName}_${field.columnName}_key`,
              MAX_IDENTIFIER[dialect]
            )
        ),
        columns: [field.columnName],
      });
    }
  }

  const inline: boolean =
    dialect === 'sqlite' &&
    singleColumnKey &&
    columns.some(
      (column: ColumnDef) =>
        column.autoIncrement && column.name === primaryKey[0]
    );
  return {
    model,
    columns,
    primaryKey,
    primaryKeyName: claimName(
      context,
      model.primaryKeyName ??
        limitIdentifier(`${model.tableName}_pkey`, MAX_IDENTIFIER[dialect])
    ),
    inlinePrimaryKey: inline,
    uniques,
    foreignKeys,
    indexes: [],
  };
}

function warnAboutUnreferenceable(
  context: EmitContext,
  label: string,
  target: IrModel,
  referenced: ResolvedTarget
): void {
  const field: IrField = referenced.field;
  const isKey: boolean =
    field.isPrimaryKey ||
    field.isUnique ||
    target.relations.some(
      (candidate: IrRelation) =>
        candidate.isPrimaryKey === true &&
        candidate.columnName === referenced.columnName
    ) ||
    target.indexes.some(
      (index: IrIndex) =>
        index.isUnique &&
        index.fields.length === 1 &&
        columnNameOf(target, index.fields[0] ?? '') === referenced.columnName
    ) ||
    (target.compositePrimaryKey?.length === 1 &&
      columnNameOf(target, target.compositePrimaryKey[0] ?? '') ===
        referenced.columnName);
  if (!isKey) {
    context.warnings.push(
      `${label}: the referenced column ${target.tableName}.${referenced.columnName} is not a primary key or unique; the database may reject the foreign key.`
    );
  }
}

function compositeKey(
  context: EmitContext,
  model: IrModel,
  key: IrCompositeForeignKey
): ForeignKeyDef | undefined {
  const label: string = `${model.name}.${key.name}`;
  const target: IrModel | undefined = findModel(
    context.schema,
    key.targetModel
  );
  if (target === undefined || target.isView === true) {
    context.warnings.push(
      `${label}: target model "${key.targetModel}" is not a table in the schema; the composite foreign key was skipped.`
    );
    return undefined;
  }
  const columns: string[] = key.fields.map(
    (name: string) => columnNameOf(model, name) ?? name
  );
  const targetColumns: string[] = key.references.map(
    (name: string) => columnNameOf(target, name) ?? name
  );
  const missing: string | undefined = [
    ...key.fields.filter(
      (name: string) => columnNameOf(model, name) === undefined
    ),
    ...key.references.filter(
      (name: string) => columnNameOf(target, name) === undefined
    ),
  ][0];
  if (missing !== undefined || columns.length !== targetColumns.length) {
    context.warnings.push(
      `${label}: the composite foreign key refers to "${missing ?? ''}", which is not a field of the model; it was skipped.`
    );
    return undefined;
  }
  return {
    name: claimName(
      context,
      key.constraintName ??
        limitIdentifier(
          `${model.tableName}_${columns.join('_')}_fkey`,
          MAX_IDENTIFIER[context.dialect]
        )
    ),
    columns,
    target,
    targetColumns,
    onDelete: key.onDelete,
    onUpdate: key.onUpdate,
    label,
    deferred: false,
  };
}

/** Builds the definition of a column from a field (or from a field-shaped description of a relation). */
function buildColumn(
  context: EmitContext,
  label: string,
  field: IrField,
  columnName: string,
  inKey: boolean,
  singleColumnKey: boolean
): ColumnDef {
  const dialect: SqlDialect = context.dialect;
  const columnSql: string = quote(context, columnName);
  const type: ColumnType = columnType(context, label, field, columnSql);
  const notes: string[] = type.comment === undefined ? [] : [type.comment];

  if (field.generated !== undefined) {
    context.warnings.push(
      `${label}: the generated column expression ${field.generated.expression} is not SQL; the column was written as a regular column.`
    );
    notes.push('generated column written as a regular column');
  }

  let autoIncrement: boolean = false;
  if (isAutoIncrement(field)) {
    if (!isIntegerKey(field)) {
      context.warnings.push(
        `${label}: an auto-increment default on a ${field.type} column cannot be written; it was dropped.`
      );
    } else if (dialect === 'sqlite' && !(inKey && singleColumnKey)) {
      context.warnings.push(
        `${label}: SQLite can auto-increment only a single-column integer primary key; the auto-increment was dropped.`
      );
    } else if ((field.arrayDepth ?? 0) > 0) {
      context.warnings.push(
        `${label}: an array column cannot auto-increment; it was dropped.`
      );
    } else {
      autoIncrement = true;
    }
  }

  let sqlType: string = type.sql;
  if (autoIncrement && dialect === 'sqlite') {
    // Only INTEGER PRIMARY KEY is the rowid and may AUTOINCREMENT.
    sqlType = 'INTEGER';
  }

  let defaultText: string | undefined = autoIncrement
    ? undefined
    : defaultSql(context, label, field, type);
  let onUpdate: string | undefined;
  if (field.isAutoUpdated) {
    if (dialect === 'mysql' && field.type === 'dateTime') {
      onUpdate = mysqlCurrentTimestamp(type.sql);
      defaultText ??= onUpdate;
    } else {
      context.unexpressedAutoUpdates.push(label);
    }
  }

  const nullable: boolean = field.isNullable && !inKey;
  return {
    name: columnName,
    sqlType,
    notNull: !nullable,
    ...(defaultText === undefined ? {} : { defaultSql: defaultText }),
    autoIncrement,
    ...(onUpdate === undefined ? {} : { onUpdate }),
    checks: type.checks,
    ...(notes.length === 0 ? {} : { comment: notes.join('; ') }),
    storage: type.storage,
    unindexable: type.unindexable,
  };
}

function fieldColumn(
  context: EmitContext,
  model: IrModel,
  field: IrField,
  primaryKey: string[],
  singleColumnKey: boolean
): ColumnDef {
  return buildColumn(
    context,
    `${model.name}.${field.name}`,
    field,
    field.columnName,
    primaryKey.includes(field.columnName),
    singleColumnKey
  );
}

function relationColumn(
  context: EmitContext,
  model: IrModel,
  relation: IrRelation,
  referenced: ResolvedTarget,
  primaryKey: string[],
  singleColumnKey: boolean
): ColumnDef {
  const asField: IrField = {
    ...referenced.field,
    name: relation.name,
    columnName: relation.columnName,
    isPrimaryKey: false,
    isUnique: false,
    isNullable: relation.isNullable,
    isAutoUpdated: false,
    default: undefined,
    generated: undefined,
  };
  return buildColumn(
    context,
    `${model.name}.${relation.name}`,
    asField,
    relation.columnName,
    primaryKey.includes(relation.columnName),
    singleColumnKey
  );
}

// ---------------------------------------------------------------------------
// Ordering
// ---------------------------------------------------------------------------

/**
 * Orders the tables so that a table comes after the tables its foreign keys point at. A key that
 * closes a cycle is marked deferred (written with ALTER TABLE after every table exists); a
 * reference to the table itself stays inside CREATE TABLE.
 */
function orderTables(context: EmitContext, tables: TableDef[]): TableDef[] {
  const byModel: Map<string, TableDef> = new Map<string, TableDef>();
  for (const table of tables) {
    byModel.set(table.model.name, table);
  }
  const ordered: TableDef[] = [];
  const done: Set<string> = new Set<string>();
  const visiting: Set<string> = new Set<string>();

  const visit = (table: TableDef): void => {
    if (done.has(table.model.name)) {
      return;
    }
    visiting.add(table.model.name);
    for (const key of table.foreignKeys) {
      const target: TableDef | undefined = byModel.get(key.target.name);
      if (target === undefined || target === table) {
        continue;
      }
      if (visiting.has(target.model.name)) {
        key.deferred = true;
      } else {
        visit(target);
      }
    }
    visiting.delete(table.model.name);
    done.add(table.model.name);
    ordered.push(table);
  };
  for (const table of tables) {
    visit(table);
  }
  if (
    context.dialect === 'sqlite' &&
    ordered.some((table: TableDef) =>
      table.foreignKeys.some((key: ForeignKeyDef) => key.deferred)
    )
  ) {
    // SQLite cannot add a constraint to an existing table, but accepts a reference to a table that
    // does not exist yet, so the keys stay inside CREATE TABLE.
    for (const table of ordered) {
      for (const key of table.foreignKeys) {
        key.deferred = false;
      }
    }
    context.warnings.push(
      'Some tables reference each other in a cycle; SQLite cannot add a foreign key afterwards, so each key stays in its CREATE TABLE and refers to a table created later (valid in SQLite).'
    );
  }
  return ordered;
}

/**
 * SQL Server rejects a foreign key whose cascading action would create a cycle or a second cascade
 * path to a table. Those keys are written with NO ACTION instead, and the warning names them.
 */
function limitCascadePaths(context: EmitContext, ordered: TableDef[]): void {
  const edges: Map<string, Set<string>> = new Map<string, Set<string>>();
  const reachFrom = (start: string): Set<string> => {
    const seen: Set<string> = new Set<string>();
    const queue: string[] = [start];
    while (queue.length > 0) {
      const current: string | undefined = queue.pop();
      for (const next of edges.get(current ?? '') ?? []) {
        if (!seen.has(next)) {
          seen.add(next);
          queue.push(next);
        }
      }
    }
    return seen;
  };
  const cascades = (action: IrOnDelete | undefined): boolean =>
    action === 'cascade' || action === 'setNull' || action === 'setDefault';
  for (const table of ordered) {
    for (const key of table.foreignKeys) {
      if (!cascades(key.onDelete) && !cascades(key.onUpdate)) {
        continue;
      }
      const parent: string = key.target.name;
      const child: string = table.model.name;
      let conflict: boolean = parent === child || reachFrom(child).has(parent);
      if (!conflict) {
        // A second path: some table that already reaches the parent (or is the parent) reaches the
        // child, or anything below it, another way.
        const below: Set<string> = reachFrom(child);
        below.add(child);
        for (const root of edges.keys()) {
          if (root !== parent && !reachFrom(root).has(parent)) {
            continue;
          }
          const reached: Set<string> = reachFrom(root);
          if ([...below].some((name: string) => reached.has(name))) {
            conflict = true;
            break;
          }
        }
      }
      if (conflict) {
        context.warnings.push(
          `${key.label}: SQL Server rejects cascading actions that form a cycle or a second cascade path; the foreign key was written with NO ACTION.`
        );
        key.onDelete = 'noAction';
        key.onUpdate = undefined;
        continue;
      }
      const children: Set<string> = edges.get(parent) ?? new Set<string>();
      children.add(child);
      edges.set(parent, children);
    }
  }
}

// ---------------------------------------------------------------------------
// Indexes
// ---------------------------------------------------------------------------

function referentialAction(
  context: EmitContext,
  label: string,
  kind: 'ON DELETE' | 'ON UPDATE',
  action: IrOnDelete | undefined
): string | undefined {
  if (action === undefined || action === 'noAction') {
    return undefined;
  }
  if (action === 'setDefault' && context.dialect === 'mysql') {
    context.warnings.push(
      `${label}: MySQL (InnoDB) does not support ${kind} SET DEFAULT; the action was left at the default (NO ACTION).`
    );
    return undefined;
  }
  switch (action) {
    case 'cascade':
      return `${kind} CASCADE`;
    case 'setNull':
      return `${kind} SET NULL`;
    case 'setDefault':
      return `${kind} SET DEFAULT`;
    default:
      // SQL Server has no RESTRICT; NO ACTION behaves the same way there.
      return context.dialect === 'sqlserver' ? undefined : `${kind} RESTRICT`;
  }
}

function indexColumnSql(
  context: EmitContext,
  table: TableDef,
  label: string,
  column: string,
  options: { sort?: 'asc' | 'desc'; length?: number; ops?: string } | undefined
): string | undefined {
  const def: ColumnDef | undefined = table.columns.find(
    (candidate: ColumnDef) => candidate.name === column
  );
  if (def === undefined) {
    return undefined;
  }
  let text: string = quote(context, column);
  if (context.dialect === 'mysql') {
    let prefix: number | undefined = options?.length;
    if (
      prefix === undefined &&
      (def.storage === 'text' || def.storage === 'blob')
    ) {
      prefix = 255;
      context.warnings.push(
        `${label}: MySQL cannot index all of a TEXT or BLOB column; the key covers only its first 255 ${def.storage === 'text' ? 'characters' : 'bytes'}.`
      );
    }
    if (prefix !== undefined) {
      text += `(${prefix})`;
    }
  } else if (options?.length !== undefined) {
    context.warnings.push(
      `${label}: the prefix length of "${column}" is only supported by MySQL and was dropped.`
    );
  }
  if (context.dialect === 'postgresql' && options?.ops !== undefined) {
    const raw: RegExpExecArray | null = /^raw\(\s*["'](.*)["']\s*\)$/.exec(
      options.ops
    );
    text += ` ${raw?.[1] ?? toSnakeCase(options.ops)}`;
  } else if (options?.ops !== undefined) {
    context.warnings.push(
      `${label}: the operator class of "${column}" is only supported by PostgreSQL and was dropped.`
    );
  }
  if (options?.sort === 'desc') {
    text += ' DESC';
  }
  return text;
}

function buildIndexes(context: EmitContext, table: TableDef): void {
  const model: IrModel = table.model;
  const dialect: SqlDialect = context.dialect;
  for (const index of model.indexes) {
    const label: string = `${model.name} index (${index.fields.join(', ')})`;
    const columns: string[] = [];
    let complete: boolean = true;
    for (const name of index.fields) {
      const column: string | undefined = columnNameOf(model, name);
      if (column === undefined) {
        context.warnings.push(
          `${model.name}: an index references "${name}", which is not a field of the model; the index was skipped.`
        );
        complete = false;
        break;
      }
      columns.push(column);
    }
    if (!complete || columns.length === 0) {
      continue;
    }
    const blocked: string | undefined = columns.find(
      (column: string) =>
        table.columns.find((candidate: ColumnDef) => candidate.name === column)
          ?.unindexable === true
    );
    if (blocked !== undefined) {
      context.warnings.push(
        `${label}: ${DIALECT_LABELS[dialect]} cannot index the column "${blocked}" (its type is unbounded or JSON); the index was skipped.`
      );
      continue;
    }
    const name: string = claimName(
      context,
      index.name ??
        limitIdentifier(
          `${model.tableName}_${columns.join('_')}_${index.isUnique ? 'key' : 'idx'}`,
          MAX_IDENTIFIER[dialect]
        )
    );
    const entries: string[] = [];
    for (let position = 0; position < columns.length; position += 1) {
      const column: string = columns[position] ?? '';
      const options =
        index.fieldOptions?.[index.fields[position] ?? ''] ?? undefined;
      const text: string | undefined = indexColumnSql(
        context,
        table,
        label,
        column,
        options
      );
      if (text !== undefined) {
        entries.push(text);
      }
    }
    table.indexes.push({
      statement: indexStatement(
        context,
        table,
        label,
        index,
        name,
        columns,
        entries
      ),
    });
  }

  // A unique key on a column the database cannot index would fail the whole script; leave it out.
  table.uniques = table.uniques.filter((unique: UniqueDef) => {
    const blocked: string | undefined = unique.columns.find(
      (column: string) =>
        table.columns.find((candidate: ColumnDef) => candidate.name === column)
          ?.unindexable === true
    );
    if (blocked !== undefined) {
      context.warnings.push(
        `${model.name}.${blocked}: ${DIALECT_LABELS[dialect]} cannot index the column "${blocked}" (its type is unbounded or JSON); the unique constraint was skipped.`
      );
    }
    return blocked === undefined;
  });

  // A unique column on SQL Server allows only one NULL; a filtered unique index keeps the other
  // dialects' meaning (any number of NULLs).
  if (dialect === 'sqlserver') {
    const remaining: UniqueDef[] = [];
    for (const unique of table.uniques) {
      const nullable: string[] = unique.columns.filter((column: string) =>
        table.columns.some(
          (candidate: ColumnDef) =>
            candidate.name === column && !candidate.notNull
        )
      );
      if (nullable.length === 0) {
        remaining.push(unique);
        continue;
      }
      table.indexes.push({
        statement: `CREATE UNIQUE INDEX ${quote(context, unique.name)} ON ${quote(context, model.tableName)} (${quoteList(context, unique.columns)}) WHERE ${nullable
          .map((column: string) => `${quote(context, column)} IS NOT NULL`)
          .join(' AND ')};`,
      });
    }
    table.uniques = remaining;
  }
}

function indexStatement(
  context: EmitContext,
  table: TableDef,
  label: string,
  index: IrIndex,
  name: string,
  columns: string[],
  entries: string[]
): string {
  const dialect: SqlDialect = context.dialect;
  const tableSql: string = quote(context, table.model.tableName);
  const nameSql: string = quote(context, name);
  const list: string = entries.join(', ');

  if (index.kind === 'fulltext') {
    if (dialect === 'mysql') {
      return `CREATE FULLTEXT INDEX ${nameSql} ON ${tableSql} (${list});`;
    }
    if (dialect === 'postgresql') {
      const vector: string = columns
        .map(
          (column: string) => `coalesce(${quote(context, column)}::text, '')`
        )
        .join(" || ' ' || ");
      return `CREATE INDEX ${nameSql} ON ${tableSql} USING gin (to_tsvector('simple', ${vector}));`;
    }
    context.warnings.push(
      `${label}: ${DIALECT_LABELS[dialect]} full-text search needs a separate mechanism (a virtual table or a catalog); it was written as an ordinary index.`
    );
  }

  const parts: string[] = ['CREATE'];
  if (index.isUnique) {
    parts.push('UNIQUE');
  }
  if (index.clustered !== undefined) {
    if (dialect === 'sqlserver') {
      parts.push(index.clustered ? 'CLUSTERED' : 'NONCLUSTERED');
    } else {
      context.warnings.push(
        `${label}: clustered indexes exist only on SQL Server; the option was dropped.`
      );
    }
  }
  let target: string = tableSql;
  let trailing: string = '';
  if (index.method !== undefined) {
    const method: string = index.method.toUpperCase();
    if (dialect === 'postgresql') {
      target = `${tableSql} USING ${method.toLowerCase()}`;
    } else if (
      dialect === 'mysql' &&
      (method === 'BTREE' || method === 'HASH')
    ) {
      trailing = ` USING ${method}`;
    } else if (method !== 'BTREE') {
      // B-tree is what every database builds anyway.
      context.warnings.push(
        `${label}: the index type ${index.method} is not supported by ${DIALECT_LABELS[dialect]} and was dropped.`
      );
    }
  }
  parts.push('INDEX', nameSql, 'ON', target);
  const nullableColumns: string[] =
    dialect === 'sqlserver' && index.isUnique
      ? columns.filter((column: string) =>
          table.columns.some(
            (candidate: ColumnDef) =>
              candidate.name === column && !candidate.notNull
          )
        )
      : [];
  const filter: string =
    nullableColumns.length === 0
      ? ''
      : ` WHERE ${nullableColumns.map((column: string) => `${quote(context, column)} IS NOT NULL`).join(' AND ')}`;
  return `${parts.join(' ')} (${list})${trailing}${filter};`;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function columnLine(
  context: EmitContext,
  table: TableDef,
  column: ColumnDef
): string {
  const dialect: SqlDialect = context.dialect;
  const parts: string[] = [quote(context, column.name), column.sqlType];
  if (column.autoIncrement) {
    switch (dialect) {
      case 'postgresql':
        parts.push('GENERATED BY DEFAULT AS IDENTITY');
        break;
      case 'sqlserver':
        parts.push('IDENTITY(1,1)');
        break;
      default:
        break;
    }
  }
  if (table.inlinePrimaryKey && column.autoIncrement) {
    parts.push('PRIMARY KEY AUTOINCREMENT');
    return parts.join(' ');
  }
  if (column.notNull) {
    parts.push('NOT NULL');
  } else if (dialect === 'sqlserver') {
    // SQL Server's default nullability depends on session settings, so say it.
    parts.push('NULL');
  }
  if (column.autoIncrement && dialect === 'mysql') {
    parts.push('AUTO_INCREMENT');
  }
  if (column.defaultSql !== undefined) {
    parts.push(`DEFAULT ${column.defaultSql}`);
  }
  if (column.onUpdate !== undefined) {
    parts.push(`ON UPDATE ${column.onUpdate}`);
  }
  return parts.join(' ');
}

function foreignKeyClause(context: EmitContext, key: ForeignKeyDef): string {
  const actions: string[] = [
    referentialAction(context, key.label, 'ON DELETE', key.onDelete),
    referentialAction(context, key.label, 'ON UPDATE', key.onUpdate),
  ].filter(
    (action: string | undefined): action is string => action !== undefined
  );
  return (
    `CONSTRAINT ${quote(context, key.name)} FOREIGN KEY (${quoteList(context, key.columns)}) ` +
    `REFERENCES ${quote(context, key.target.tableName)} (${quoteList(context, key.targetColumns)})` +
    (actions.length === 0 ? '' : ` ${actions.join(' ')}`)
  );
}

interface Item {
  sql: string;
  comment?: string;
}

function renderTable(context: EmitContext, table: TableDef): string {
  const dialect: SqlDialect = context.dialect;
  const items: Item[] = [];
  for (const column of table.columns) {
    items.push({
      sql: columnLine(context, table, column),
      ...(column.comment === undefined ? {} : { comment: column.comment }),
    });
  }
  if (table.primaryKey.length > 0 && !table.inlinePrimaryKey) {
    items.push({
      sql: `CONSTRAINT ${quote(context, table.primaryKeyName)} PRIMARY KEY (${quoteList(context, table.primaryKey)})`,
    });
  }
  for (const unique of table.uniques) {
    const columns: string = unique.columns
      .map((name: string) => {
        const def: ColumnDef | undefined = table.columns.find(
          (candidate: ColumnDef) => candidate.name === name
        );
        const base: string = quote(context, name);
        if (
          dialect === 'mysql' &&
          def !== undefined &&
          (def.storage === 'text' || def.storage === 'blob')
        ) {
          context.warnings.push(
            `${table.model.name}.${name}: MySQL cannot make all of a TEXT or BLOB column unique; the constraint covers only its first 255 ${def.storage === 'text' ? 'characters' : 'bytes'}.`
          );
          return `${base}(255)`;
        }
        return base;
      })
      .join(', ');
    items.push({
      sql: `CONSTRAINT ${quote(context, unique.name)} UNIQUE (${columns})`,
    });
  }
  for (const column of table.columns) {
    for (const check of column.checks) {
      const name: string = claimName(
        context,
        limitIdentifier(
          `${table.model.tableName}_${column.name}_check`,
          MAX_IDENTIFIER[dialect]
        )
      );
      items.push({
        sql: `CONSTRAINT ${quote(context, name)} CHECK (${check})`,
      });
    }
  }
  for (const key of table.foreignKeys) {
    if (!key.deferred) {
      items.push({ sql: foreignKeyClause(context, key) });
    }
  }

  const lines: string[] = [];
  items.forEach((item: Item, position: number) => {
    const comma: string = position === items.length - 1 ? '' : ',';
    lines.push(
      `  ${item.sql}${comma}${item.comment === undefined ? '' : ` -- ${commentText(item.comment)}`}`
    );
  });
  const tail: string =
    dialect === 'mysql' ? ' ENGINE=InnoDB DEFAULT CHARSET=utf8mb4' : '';
  return [
    `CREATE TABLE ${quote(context, table.model.tableName)} (`,
    ...lines,
    `)${tail};`,
  ].join('\n');
}

function renderView(context: EmitContext, view: IrModel): string {
  const columns: string = [
    ...view.fields.map((field: IrField) => field.columnName),
    ...view.relations
      .filter((relation: IrRelation) => relation.kind !== 'manyToMany')
      .map((relation: IrRelation) => relation.columnName),
  ].join(', ');
  return [
    `-- View ${quote(context, view.tableName)}: the schema has no SQL definition for it, so no statement was written.`,
    `-- Columns: ${commentText(columns)}`,
    `-- CREATE VIEW ${quote(context, view.tableName)} AS SELECT ... ;`,
  ].join('\n');
}

function render(
  context: EmitContext,
  ordered: TableDef[],
  views: IrModel[]
): string {
  const dialect: SqlDialect = context.dialect;
  const blocks: string[] = [
    `-- SQL DDL for ${DIALECT_LABELS[dialect]}, generated by ormbridge.`,
  ];
  if (dialect === 'sqlite') {
    blocks.push('PRAGMA foreign_keys = ON;');
  }
  const tableTexts: string[] = ordered.map((table: TableDef) =>
    renderTable(context, table)
  );
  if (dialect === 'postgresql') {
    if (context.needsHstore) {
      blocks.push('CREATE EXTENSION IF NOT EXISTS hstore;');
    }
    for (const info of context.enums.values()) {
      blocks.push(
        `CREATE TYPE ${quote(context, info.dbName)} AS ENUM (${info.definition.values
          .map((value: IrEnumValue) => sqlStringLiteral(dialect, value.dbValue))
          .join(', ')});`
      );
    }
  }
  ordered.forEach((table: TableDef, position: number) => {
    const text: string = tableTexts[position] ?? '';
    const indexes: string =
      table.indexes.length === 0
        ? ''
        : `\n${table.indexes.map((index: IndexDef) => index.statement).join('\n')}`;
    blocks.push(`${text}${indexes}`);
  });
  for (const view of views) {
    blocks.push(renderView(context, view));
  }
  const deferred: string[] = [];
  for (const table of ordered) {
    for (const key of table.foreignKeys) {
      if (key.deferred) {
        deferred.push(
          `ALTER TABLE ${quote(context, table.model.tableName)} ADD ${foreignKeyClause(context, key)};`
        );
      }
    }
  }
  if (deferred.length > 0) {
    blocks.push(
      '-- These foreign keys close a reference cycle, so they are added once every table exists.'
    );
    blocks.push(deferred.join('\n'));
  }
  return `${blocks.join('\n\n')}\n`;
}
