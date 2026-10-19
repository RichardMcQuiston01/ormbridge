import type { IrDefault, IrEnum, IrEnumValue, IrField } from '../ir.js';

/**
 * Column types and defaults of the ClickHouse dialect of the SQL DDL writer (see sqlClickhouse.ts).
 *
 * ClickHouse columns are non-nullable unless the type is wrapped in `Nullable(...)`, and `Nullable`
 * cannot wrap an `Array` or a `Map`. Strings carry no length limit, integers are signed unless a
 * Prisma `@db.Unsigned*` native type says otherwise, and a few IR types (time of day, ranges, JSON)
 * have no faithful ClickHouse type and are written as `String` with a column comment.
 */

export interface ChTypeContext {
  warnings: string[];
  enums: Map<string, IrEnum>;
}

/** What a ClickHouse type is, for the decisions that depend on it (nullability, index type, defaults). */
export type ChKind =
  | 'string'
  | 'integer'
  | 'float'
  | 'decimal'
  | 'bool'
  | 'date'
  | 'dateTime'
  | 'uuid'
  | 'ip'
  | 'enum'
  | 'array'
  | 'map'
  | 'other';

export interface ChType {
  /** The type without `Nullable(...)`. */
  sql: string;
  kind: ChKind;
  /** False for Array and Map, which ClickHouse does not allow inside Nullable. */
  nullable: boolean;
  /** True when a literal default is written as a quoted string. */
  textual: boolean;
  comment?: string;
}

/** A string literal: the backslash is an escape character in ClickHouse, a quote is doubled. */
export function chString(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "''")}'`;
}

function simple(
  sql: string,
  kind: ChKind,
  textual: boolean,
  comment?: string
): ChType {
  return {
    sql,
    kind,
    nullable: true,
    textual,
    ...(comment === undefined ? {} : { comment }),
  };
}

// ---------------------------------------------------------------------------
// Native types (Prisma `@db.*`)
// ---------------------------------------------------------------------------

const INTEGER_NATIVE: Readonly<Record<string, string>> = {
  tinyint: 'Int8',
  unsignedtinyint: 'UInt8',
  smallint: 'Int16',
  unsignedsmallint: 'UInt16',
  mediumint: 'Int32',
  unsignedmediumint: 'UInt32',
  int: 'Int32',
  integer: 'Int32',
  unsignedint: 'UInt32',
  oid: 'UInt32',
  bigint: 'Int64',
  unsignedbigint: 'UInt64',
  year: 'UInt16',
};

const FLOAT_NATIVE: Readonly<Record<string, string>> = {
  real: 'Float32',
  float: 'Float32',
  double: 'Float64',
  doubleprecision: 'Float64',
};

function nativeType(field: IrField): ChType | undefined {
  const native = field.nativeType;
  if (native === undefined) {
    return undefined;
  }
  const name: string = native.name.toLowerCase();
  const first: number = Number.parseInt(native.args[0] ?? '', 10);
  switch (field.type) {
    case 'int':
    case 'bigInt': {
      const sql: string | undefined = INTEGER_NATIVE[name];
      return sql === undefined ? undefined : simple(sql, 'integer', false);
    }
    case 'float': {
      const sql: string | undefined = FLOAT_NATIVE[name];
      return sql === undefined ? undefined : simple(sql, 'float', false);
    }
    case 'string':
      return (name === 'char' || name === 'nchar') &&
        Number.isInteger(first) &&
        first > 0
        ? simple(`FixedString(${first})`, 'string', true)
        : undefined;
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// Scalar types
// ---------------------------------------------------------------------------

function decimalType(
  context: ChTypeContext,
  label: string,
  field: IrField
): ChType {
  const args: number[] = (field.nativeType?.args ?? [])
    .map((arg: string) => Number.parseInt(arg, 10))
    .filter((arg: number) => Number.isInteger(arg));
  const given: number | undefined = field.maxDigits ?? args[0];
  // Without a declared size, 38 digits (18 after the point) hold any realistic amount.
  let precision: number = given ?? 38;
  let scale: number =
    given === undefined ? 18 : (field.decimalPlaces ?? args[1] ?? 0);
  if (precision > 76) {
    context.warnings.push(
      `${label}: ClickHouse allows at most 76 digits in a Decimal; ${precision} was reduced to 76.`
    );
    precision = 76;
  }
  if (precision < 1) {
    precision = 1;
  }
  if (scale > precision) {
    scale = precision;
  }
  return simple(`Decimal(${precision}, ${scale})`, 'decimal', false);
}

function dateTimeType(field: IrField): ChType {
  const precision: number = Number.parseInt(
    field.nativeType?.args[0] ?? '',
    10
  );
  const name: string = field.nativeType?.name.toLowerCase() ?? '';
  const hasPrecision: boolean =
    /^(timestamp|timestamptz|datetime|datetime2)$/.test(name) &&
    Number.isInteger(precision) &&
    precision >= 0 &&
    precision <= 9;
  return simple(
    `DateTime64(${hasPrecision ? precision : 3})`,
    'dateTime',
    true
  );
}

function enumType(
  context: ChTypeContext,
  label: string,
  definition: IrEnum
): ChType {
  const values: IrEnumValue[] = definition.values;
  if (values.length > 65_535) {
    context.warnings.push(
      `${label}: enum ${definition.name} has more members than Enum16 holds; the column was written as LowCardinality(String).`
    );
    return simple('LowCardinality(String)', 'string', true);
  }
  const members: string = values
    .map(
      (value: IrEnumValue, position: number) =>
        `${chString(value.dbValue)} = ${position + 1}`
    )
    .join(', ');
  return simple(
    `${values.length > 127 ? 'Enum16' : 'Enum8'}(${members})`,
    'enum',
    true
  );
}

function scalarType(
  context: ChTypeContext,
  label: string,
  field: IrField
): ChType {
  if (field.enumName !== undefined) {
    const definition: IrEnum | undefined = context.enums.get(field.enumName);
    if (definition !== undefined) {
      return enumType(context, label, definition);
    }
    context.warnings.push(
      `${label}: enum "${field.enumName}" does not exist in the schema (or has no values); the column was written as a plain string.`
    );
    return simple('String', 'string', true);
  }
  const native: ChType | undefined = nativeType(field);
  if (native !== undefined) {
    return native;
  }
  switch (field.type) {
    case 'string':
    case 'text':
      return simple('String', 'string', true);
    case 'uuid':
      return simple('UUID', 'uuid', true);
    case 'int':
      return simple('Int32', 'integer', false);
    case 'bigInt':
      return simple('Int64', 'integer', false);
    case 'float':
      return simple('Float64', 'float', false);
    case 'decimal':
      return decimalType(context, label, field);
    case 'boolean':
      return simple('Bool', 'bool', false);
    case 'dateTime':
      return dateTimeType(field);
    case 'date':
      return simple('Date32', 'date', true);
    case 'time':
      context.warnings.push(
        `${label}: ClickHouse has no stable time-of-day type; the column was written as a String ("HH:MM:SS").`
      );
      return simple('String', 'string', true, 'time of day (HH:MM:SS)');
    case 'json':
      return simple('String', 'string', true, 'JSON document');
    case 'bytes':
      return simple('String', 'string', true, 'binary data');
    case 'duration':
      context.warnings.push(
        `${label}: ClickHouse has no interval column type; the duration was written as an Int64 (microseconds).`
      );
      return simple('Int64', 'integer', false, 'duration in microseconds');
    case 'ipAddress':
      return simple('IPv6', 'ip', true);
    case 'hstore':
      return {
        sql: 'Map(String, String)',
        kind: 'map',
        nullable: false,
        textual: false,
      };
    case 'range':
      context.warnings.push(
        `${label}: ClickHouse has no range type; the column was written as a String.`
      );
      return simple('String', 'string', true, 'range stored as text');
    case 'unsupported': {
      const raw: string | undefined = field.unsupportedType;
      if (raw !== undefined && raw !== '') {
        context.warnings.push(
          `${label}: the database type "${raw}" (Prisma Unsupported) was written as it is; check that ClickHouse has it.`
        );
        return simple(raw, 'other', false);
      }
      context.warnings.push(
        `${label}: the column has an unsupported database type that is unknown; it was written as a String.`
      );
      return simple('String', 'string', true);
    }
    default:
      context.warnings.push(
        `${label}: unknown field type "${String(field.type)}"; it was written as a String.`
      );
      return simple('String', 'string', true);
  }
}

/** The ClickHouse type of a field (an array field becomes nested `Array(...)`), without `Nullable`. */
export function clickhouseType(
  context: ChTypeContext,
  label: string,
  field: IrField
): ChType {
  const element: ChType = scalarType(context, label, field);
  const depth: number = field.arrayDepth ?? 0;
  if (depth === 0) {
    return element;
  }
  return {
    sql: `${'Array('.repeat(depth)}${element.sql}${')'.repeat(depth)}`,
    kind: 'array',
    nullable: false,
    textual: false,
    ...(element.comment === undefined ? {} : { comment: element.comment }),
  };
}

/** Wraps a type in `Nullable(...)` when the column is nullable and ClickHouse allows it. */
export function withNullability(type: ChType, nullable: boolean): string {
  return nullable && type.nullable ? `Nullable(${type.sql})` : type.sql;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const UUID_EXPRESSIONS: ReadonlySet<string> = new Set([
  'gen_random_uuid()',
  'uuid_generate_v4()',
  'uuid()',
  '(uuid())',
  'newid()',
  'newsequentialid()',
  'generateuuidv4()',
]);

const NOW_EXPRESSIONS: ReadonlySet<string> = new Set([
  'now()',
  'now64()',
  'now64(3)',
  'current_timestamp',
  'current_timestamp()',
  'current_timestamp(6)',
  'getdate()',
  'getutcdate()',
  'sysdatetime()',
  'sysutcdatetime()',
  "datetime('now')",
]);

const TODAY_EXPRESSIONS: ReadonlySet<string> = new Set([
  'current_date',
  'current_date()',
  'today()',
  '(current_date)',
]);

/** `now64(p)` with the fractional digits of the column. */
function nowExpression(type: ChType): string {
  const precision: RegExpExecArray | null = /^DateTime64\((\d)\)$/.exec(
    type.sql
  );
  return `now64(${precision?.[1] ?? '3'})`;
}

export function enumMember(
  definition: IrEnum | undefined,
  raw: string
): string | undefined {
  const value: IrEnumValue | undefined =
    definition?.values.find(
      (candidate: IrEnumValue) => candidate.name === raw
    ) ??
    definition?.values.find(
      (candidate: IrEnumValue) => candidate.dbValue === raw
    );
  return value?.dbValue;
}

function arrayLiteral(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    const items: (string | undefined)[] = value.map(arrayLiteral);
    return items.includes(undefined) ? undefined : `[${items.join(', ')}]`;
  }
  if (typeof value === 'string') {
    return chString(value);
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return undefined;
}

function dateTimeLiteral(text: string): string | undefined {
  const iso: RegExpExecArray | null =
    /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2}(?:\.\d+)?)Z?$/.exec(text);
  if (iso !== null) {
    return `'${iso[1]} ${(iso[2] ?? '').replace(/\.0+$/, '')}'`;
  }
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? `'${text}'` : undefined;
}

function literalDefault(
  field: IrField,
  type: ChType,
  value: string | number | boolean
): string | undefined {
  const text: string = String(value);
  if (type.kind === 'array') {
    try {
      return arrayLiteral(JSON.parse(text) as unknown);
    } catch {
      return undefined;
    }
  }
  switch (type.kind) {
    case 'integer':
    case 'float':
    case 'decimal':
      return Number.isFinite(Number(text)) && text.trim() !== ''
        ? text.trim()
        : undefined;
    case 'bool':
      if (/^(true|1)$/i.test(text)) {
        return 'true';
      }
      return /^(false|0)$/i.test(text) ? 'false' : undefined;
    case 'dateTime':
    case 'date':
      return dateTimeLiteral(text);
    case 'map':
      return undefined;
    default:
      return field.type === 'unsupported' ? undefined : chString(text);
  }
}

export interface DefaultResult {
  sql?: string;
  /** Why the default was dropped, when it was. */
  dropped?: string;
}

/** The text after DEFAULT for a field, or a reason the default cannot be written. */
export function clickhouseDefault(
  context: ChTypeContext,
  label: string,
  field: IrField,
  type: ChType,
  value: IrDefault
): DefaultResult {
  switch (value.kind) {
    case 'autoIncrement':
      return {
        dropped:
          'ClickHouse has no auto-increment; the auto-increment was dropped',
      };
    case 'now':
      if (field.type === 'dateTime') {
        return { sql: nowExpression(type) };
      }
      if (field.type === 'date') {
        return { sql: 'today()' };
      }
      return {
        dropped: `a "now" default on a ${field.type} column cannot be written; the default was dropped`,
      };
    case 'uuid':
      return field.type === 'uuid'
        ? { sql: 'generateUUIDv4()' }
        : {
            dropped: `a UUID default on a ${field.type} column cannot be written; the default was dropped`,
          };
    case 'clientGenerated':
      return {
        dropped: `the ${value.generator}() default is generated by the ORM client, not the database; the default was dropped`,
      };
    case 'enumValue': {
      const definition: IrEnum | undefined =
        field.enumName === undefined
          ? undefined
          : context.enums.get(field.enumName);
      const stored: string | undefined = enumMember(definition, value.value);
      if (type.kind === 'enum' && stored === undefined) {
        return {
          dropped: `the enum default "${value.value}" does not match a member of the enum; the default was dropped`,
        };
      }
      return { sql: chString(stored ?? value.value) };
    }
    case 'dbExpression': {
      if (value.isFunction === true) {
        return {
          dropped: `the ${value.expression} default function has no SQL equivalent; the default was dropped`,
        };
      }
      const normalized: string = value.expression
        .replace(/\s+/g, '')
        .toLowerCase();
      if (UUID_EXPRESSIONS.has(normalized) && field.type === 'uuid') {
        return { sql: 'generateUUIDv4()' };
      }
      if (NOW_EXPRESSIONS.has(normalized) && field.type === 'dateTime') {
        return { sql: nowExpression(type) };
      }
      if (TODAY_EXPRESSIONS.has(normalized) && field.type === 'date') {
        return { sql: 'today()' };
      }
      context.warnings.push(
        `${label}: the database default expression ${value.expression} was written as it is; check that ClickHouse accepts it.`
      );
      return { sql: value.expression.trim() };
    }
    case 'literal': {
      const sql: string | undefined = literalDefault(field, type, value.value);
      return sql === undefined
        ? {
            dropped: `the default ${String(value.value)} cannot be written as a ClickHouse ${type.sql} literal; the default was dropped`,
          }
        : { sql };
    }
    default:
      return {};
  }
}
