import type {
  IrDefault,
  IrEnum,
  IrEnumValue,
  IrField,
  IrScalarType,
} from '../ir.js';
import { csString, verbatim } from './efcoreNames.js';
import type { PrismaProvider } from './prisma.js';

/**
 * Works out how one column is written in C#: the property type, the facets (length, precision, column type), the
 * default, how the value is generated and how an enum is stored. The result is style independent; the renderers
 * turn it into data annotations or fluent calls.
 */

/** A C# enum written for an IR enum, with the names its members were given. */
export interface EnumPlan {
  enumeration: IrEnum;
  typeName: string;
  /** IR member name -> C# member name. */
  members: Map<string, string>;
  /** True when every stored value is an integer, so the members carry those numbers. */
  numeric: boolean;
  /** True when every member is named exactly like its stored value (`HasConversion<string>()` is enough). */
  namesMatch: boolean;
  /** The value converter class; set once a column needs a mapping from names to stored values. */
  converter?: string;
  /** Allocates the name of the converter class on first use. */
  converterName: () => string;
}

export interface ColumnContext {
  provider: PrismaProvider;
  enums: ReadonlyMap<string, EnumPlan>;
  warn: (message: string) => void;
}

export type Conversion =
  { kind: 'string' } | { kind: 'converter'; className: string };

export interface ColumnSpec {
  /** C# type without the nullable marker. */
  clrType: string;
  isValueType: boolean;
  nullable: boolean;
  /** Property initializer that keeps the compiler quiet about non-nullable reference types. */
  initializer: string | undefined;
  columnName: string;
  columnType: string | undefined;
  maxLength: number | undefined;
  precision: { precision: number; scale: number } | undefined;
  /** `identity` counts up in the database, `none` is never generated. */
  generated: 'identity' | 'none' | undefined;
  conversion: Conversion | undefined;
  /** A C# expression for `HasDefaultValue`. */
  defaultValue: string | undefined;
  /** The text of `HasDefaultValueSql`. */
  defaultSql: string | undefined;
  /** True for a Guid that EF Core generates when the row is added (no database function). */
  clientGuid: boolean;
  autoUpdated: boolean;
  computed: { sql: string; stored: boolean } | undefined;
  /** The enum behind the column, when it is written as a C# enum. */
  enumPlan: EnumPlan | undefined;
}

export interface ColumnOptions {
  propertyName: string;
  /** True when the column is part of the primary key. */
  isKey: boolean;
  /** True when it is the only column of the primary key. */
  singleKey: boolean;
}

interface Clr {
  name: string;
  valueType: boolean;
  initializer?: string;
  columnType?: string;
  maxLength?: number;
  precision?: { precision: number; scale: number };
}

const RANGE_ELEMENTS: Readonly<Record<string, string>> = {
  int: 'int',
  bigInt: 'long',
  decimal: 'decimal',
  date: 'DateOnly',
  dateTime: 'DateTime',
};

/** PostgreSQL and the databases that speak its types (MongoDB is written like PostgreSQL, with a warning). */
export function isPostgres(provider: PrismaProvider): boolean {
  return (
    provider === 'postgresql' ||
    provider === 'cockroachdb' ||
    provider === 'mongodb'
  );
}

/** Words that mark a generated-column expression as Python (Django) rather than SQL. */
const PYTHON_EXPRESSION: RegExp = /\b(F|Value|ExpressionWrapper|Func|Cast)\(/;

function sqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** SQLite and MySQL accept an expression as a default only in parentheses: `DEFAULT (uuid())`. */
const PLAIN_DEFAULT: RegExp =
  /^(current_(timestamp|date|time)(\(\d*\))?|localtimestamp|now\(\)|null|true|false|-?\d+(\.\d+)?|'(?:[^']|'')*')$/i;

function wrapExpression(provider: PrismaProvider, expression: string): string {
  const trimmed: string = expression.trim();
  const needsParentheses: boolean =
    (provider === 'sqlite' || provider === 'mysql') &&
    !PLAIN_DEFAULT.test(trimmed) &&
    !/^\(.*\)$/s.test(trimmed);
  return needsParentheses ? `(${trimmed})` : trimmed;
}

/** The `HasDefaultValueSql` text that stands for "now" in a column type. */
function nowSql(provider: PrismaProvider, type: IrScalarType): string {
  if (provider === 'sqlserver') {
    return 'GETUTCDATE()';
  }
  if (type === 'date') {
    return provider === 'mysql' ? '(CURRENT_DATE)' : 'CURRENT_DATE';
  }
  if (type === 'time') {
    return provider === 'mysql' ? '(CURRENT_TIME)' : 'CURRENT_TIME';
  }
  return 'CURRENT_TIMESTAMP';
}

/** The `HasDefaultValueSql` text of a database-generated UUID, or undefined where the database has none. */
function uuidSql(provider: PrismaProvider): string | undefined {
  switch (provider) {
    case 'mysql':
      return '(UUID())';
    case 'sqlserver':
      return 'NEWID()';
    case 'sqlite':
      return undefined;
    default:
      return 'gen_random_uuid()';
  }
}

function scalarClr(
  context: ColumnContext,
  label: string,
  field: IrField,
  type: IrScalarType
): Clr {
  const postgres: boolean = isPostgres(context.provider);
  switch (type) {
    case 'string':
      return {
        name: 'string',
        valueType: false,
        initializer: 'string.Empty',
        ...(field.maxLength === undefined
          ? {}
          : { maxLength: field.maxLength }),
      };
    case 'text':
      return { name: 'string', valueType: false, initializer: 'string.Empty' };
    case 'int':
      return { name: 'int', valueType: true };
    case 'bigInt':
      return { name: 'long', valueType: true };
    case 'float':
      return { name: 'double', valueType: true };
    case 'boolean':
      return { name: 'bool', valueType: true };
    case 'decimal': {
      const digits: number | undefined =
        field.maxDigits ?? (field.decimalPlaces === undefined ? undefined : 18);
      return {
        name: 'decimal',
        valueType: true,
        ...(digits === undefined
          ? {}
          : {
              precision: {
                precision: digits,
                scale: field.decimalPlaces ?? 0,
              },
            }),
      };
    }
    case 'dateTime':
      return { name: 'DateTime', valueType: true };
    case 'date':
      return { name: 'DateOnly', valueType: true };
    case 'time':
      return { name: 'TimeOnly', valueType: true };
    case 'duration':
      return { name: 'TimeSpan', valueType: true };
    case 'uuid':
      return { name: 'Guid', valueType: true };
    case 'bytes':
      return {
        name: 'byte[]',
        valueType: false,
        initializer: 'Array.Empty<byte>()',
      };
    case 'json': {
      const base: Clr = {
        name: 'string',
        valueType: false,
        initializer: 'string.Empty',
      };
      if (postgres) {
        return { ...base, columnType: 'jsonb' };
      }
      if (context.provider === 'mysql') {
        return { ...base, columnType: 'json' };
      }
      context.warn(
        `${label}: ${context.provider === 'sqlite' ? 'SQLite' : 'SQL Server'} has no JSON column type in EF Core 8; the column was written as a string and stored as text.`
      );
      return base;
    }
    case 'ipAddress':
      if (postgres) {
        return { name: 'IPAddress', valueType: false, initializer: 'null!' };
      }
      context.warn(
        `${label}: only PostgreSQL maps IPAddress; the column was written as a string of at most 45 characters.`
      );
      return {
        name: 'string',
        valueType: false,
        initializer: 'string.Empty',
        maxLength: 45,
      };
    case 'hstore':
      if (postgres) {
        return {
          name: 'Dictionary<string, string>',
          valueType: false,
          initializer: 'new()',
        };
      }
      context.warn(
        `${label}: hstore is a PostgreSQL type; the column was written as a string.`
      );
      return { name: 'string', valueType: false, initializer: 'string.Empty' };
    case 'range': {
      const element: string | undefined =
        field.rangeOf === undefined ? undefined : RANGE_ELEMENTS[field.rangeOf];
      if (postgres && element !== undefined) {
        context.warn(
          `${label}: the range column uses NpgsqlRange<${element}>, which needs the Npgsql.EntityFrameworkCore.PostgreSQL package.`
        );
        return { name: `NpgsqlRange<${element}>`, valueType: true };
      }
      context.warn(
        `${label}: range types exist only in PostgreSQL; the column was written as a string.`
      );
      return { name: 'string', valueType: false, initializer: 'string.Empty' };
    }
    case 'unsupported':
    default: {
      context.warn(
        `${label}: the database type "${field.unsupportedType ?? 'unknown'}" has no CLR equivalent; the column was written as a string with that column type.`
      );
      return {
        name: 'string',
        valueType: false,
        initializer: 'string.Empty',
        ...(field.unsupportedType === undefined
          ? {}
          : { columnType: field.unsupportedType }),
      };
    }
  }
}

/** The facets that a Prisma `@db.*` native type adds to a field the type alone leaves open. */
function withNativeFacets(field: IrField): IrField {
  const native: IrField['nativeType'] = field.nativeType;
  if (native === undefined) {
    return field;
  }
  const name: string = native.name.toLowerCase();
  const first: number = Number(native.args[0]);
  const second: number = Number(native.args[1] ?? 0);
  if (
    (name === 'varchar' || name === 'char') &&
    field.type === 'string' &&
    field.maxLength === undefined &&
    Number.isInteger(first)
  ) {
    return { ...field, maxLength: first };
  }
  if (
    (name === 'decimal' || name === 'numeric') &&
    field.type === 'decimal' &&
    field.maxDigits === undefined &&
    Number.isInteger(first)
  ) {
    return {
      ...field,
      maxDigits: first,
      decimalPlaces: Number.isInteger(second) ? second : 0,
    };
  }
  return field;
}

function numberLiteral(type: IrScalarType, value: number): string | undefined {
  if (!Number.isFinite(value)) {
    return undefined;
  }
  switch (type) {
    case 'int':
      return Number.isInteger(value) ? String(value) : undefined;
    case 'bigInt':
      return Number.isInteger(value) ? `${value}L` : undefined;
    case 'float': {
      const text: string = String(value);
      return /^-?\d+$/.test(text) ? `${text}.0` : text;
    }
    case 'decimal': {
      const text: string = /e/i.test(String(value))
        ? value.toFixed(20).replace(/\.?0+$/, '')
        : String(value);
      return `${text}m`;
    }
    default:
      return undefined;
  }
}

/** The enum member a default value names, by member name or by stored value. */
function enumMember(
  plan: EnumPlan,
  raw: string
): { member: IrEnumValue; csName: string } | undefined {
  const member: IrEnumValue | undefined =
    plan.enumeration.values.find((value: IrEnumValue) => value.name === raw) ??
    plan.enumeration.values.find((value: IrEnumValue) => value.dbValue === raw);
  if (member === undefined) {
    return undefined;
  }
  return {
    member,
    csName: verbatim(plan.members.get(member.name) ?? member.name),
  };
}

interface DefaultSpec {
  value?: string;
  sql?: string;
  clientGuid?: boolean;
}

function literalDefault(
  context: ColumnContext,
  label: string,
  field: IrField,
  value: string | number | boolean,
  enumPlan: EnumPlan | undefined
): DefaultSpec {
  const drop = (reason: string): DefaultSpec => {
    context.warn(`${label}: ${reason}; the default was dropped.`);
    return {};
  };
  if (enumPlan !== undefined) {
    const found: { csName: string } | undefined = enumMember(
      enumPlan,
      String(value)
    );
    return found === undefined
      ? drop(`the enum default "${String(value)}" matches no member`)
      : { value: `${enumPlan.typeName}.${found.csName}` };
  }
  if (field.arrayDepth !== undefined) {
    return drop('an array default cannot be written');
  }
  const asText: string = String(value);
  switch (field.type) {
    case 'string':
    case 'text':
      return { value: csString(asText) };
    case 'boolean': {
      if (typeof value === 'boolean') {
        return { value: String(value) };
      }
      if (/^(1|true)$/i.test(asText)) {
        return { value: 'true' };
      }
      if (/^(0|false)$/i.test(asText)) {
        return { value: 'false' };
      }
      return drop(`"${asText}" is not a boolean`);
    }
    case 'int':
    case 'bigInt':
    case 'float':
    case 'decimal': {
      const number: number = typeof value === 'number' ? value : Number(value);
      const literal: string | undefined = numberLiteral(field.type, number);
      return literal === undefined
        ? drop(`"${asText}" is not a number this column can hold`)
        : { value: literal };
    }
    case 'uuid':
      return { value: `Guid.Parse(${csString(asText)})` };
    case 'json':
    case 'date':
    case 'time':
    case 'dateTime':
    case 'duration':
    case 'ipAddress':
      return { sql: wrapExpression(context.provider, sqlLiteral(asText)) };
    default:
      return drop(
        `a literal default on a ${field.type} column cannot be written`
      );
  }
}

function defaultOf(
  context: ColumnContext,
  label: string,
  field: IrField,
  enumPlan: EnumPlan | undefined,
  isOnlyKey: boolean
): DefaultSpec {
  const value: IrDefault | undefined = field.default;
  if (value === undefined) {
    return {};
  }
  switch (value.kind) {
    case 'autoIncrement':
      return {};
    case 'now':
      if (
        field.type !== 'dateTime' &&
        field.type !== 'date' &&
        field.type !== 'time'
      ) {
        context.warn(
          `${label}: the "now" default applies to date and time columns only; the default was dropped.`
        );
        return {};
      }
      return { sql: nowSql(context.provider, field.type) };
    case 'uuid': {
      if (field.type !== 'uuid') {
        context.warn(
          `${label}: a UUID default on a ${field.type} column cannot be written; the default was dropped.`
        );
        return {};
      }
      if (isOnlyKey) {
        // EF Core generates the Guid of a single-column key itself.
        return {};
      }
      const sql: string | undefined = uuidSql(context.provider);
      if (sql === undefined) {
        context.warn(
          `${label}: SQLite has no database-side UUID default; EF Core generates the Guid when the row is added through it.`
        );
        return { clientGuid: true };
      }
      return { sql };
    }
    case 'enumValue': {
      const found: { csName: string } | undefined =
        enumPlan === undefined ? undefined : enumMember(enumPlan, value.value);
      if (enumPlan === undefined || found === undefined) {
        context.warn(
          `${label}: the enum default "${value.value}" matches no enum member; the default was dropped.`
        );
        return {};
      }
      return { value: `${enumPlan.typeName}.${found.csName}` };
    }
    case 'literal':
      return literalDefault(context, label, field, value.value, enumPlan);
    case 'dbExpression':
      if (value.isFunction === true) {
        context.warn(
          `${label}: the Prisma function ${value.expression} is not a database expression; the default was dropped.`
        );
        return {};
      }
      return { sql: wrapExpression(context.provider, value.expression) };
    case 'clientGenerated':
      context.warn(
        `${label}: the ${value.generator}() default is generated by Prisma Client; EF Core has no equivalent and the default was dropped.`
      );
      return {};
    default:
      return {};
  }
}

/**
 * The initializer of a property. A column with a default must not start as an empty string or an empty array, or
 * EF Core would insert that instead of letting the database fill the default: a reference type takes `null!` (EF Core
 * treats null as "not set"), and a default that is a plain C# value is also the initial value, so a new object
 * already shows what the database would store.
 */
function initializerOf(
  valueType: boolean,
  nullable: boolean,
  initializer: string | undefined,
  defaults: DefaultSpec,
  computed: boolean
): string | undefined {
  if (nullable) {
    return undefined;
  }
  if (defaults.value !== undefined) {
    return defaults.value;
  }
  if (valueType) {
    return undefined;
  }
  return defaults.sql !== undefined || defaults.clientGuid === true || computed
    ? 'null!'
    : initializer;
}

/** Builds the C# column of an IR field. */
export function buildColumn(
  context: ColumnContext,
  label: string,
  source: IrField,
  options: ColumnOptions
): ColumnSpec {
  const field: IrField = withNativeFacets(source);
  const enumPlan: EnumPlan | undefined =
    field.enumName === undefined
      ? undefined
      : context.enums.get(field.enumName);
  if (field.enumName !== undefined && enumPlan === undefined) {
    context.warn(
      `${label}: the enum "${field.enumName}" does not exist; the column was written as a plain string.`
    );
  }

  const depth: number = field.arrayDepth ?? 0;
  let clr: Clr;
  let conversion: Conversion | undefined;
  if (enumPlan !== undefined && depth === 0) {
    const storedAsNumber: boolean =
      enumPlan.numeric && (field.type === 'int' || field.type === 'bigInt');
    clr = {
      name: enumPlan.typeName,
      valueType: true,
      ...(storedAsNumber || field.maxLength === undefined
        ? {}
        : { maxLength: field.maxLength }),
    };
    if (!storedAsNumber) {
      if (enumPlan.namesMatch) {
        conversion = { kind: 'string' };
      } else {
        enumPlan.converter ??= enumPlan.converterName();
        conversion = { kind: 'converter', className: enumPlan.converter };
      }
    }
  } else if (enumPlan !== undefined) {
    context.warn(
      `${label}: an array of the enum ${enumPlan.typeName} is stored as numbers by EF Core, not as names.`
    );
    clr = { name: enumPlan.typeName, valueType: true };
  } else {
    clr = scalarClr(context, label, field, field.type);
  }

  let clrType: string = clr.name;
  let valueType: boolean = clr.valueType;
  let initializer: string | undefined = clr.initializer;
  let columnType: string | undefined = clr.columnType;
  let maxLength: number | undefined = clr.maxLength;
  if (depth > 0) {
    if (isPostgres(context.provider) || depth === 1) {
      clrType = `${clr.name}[${','.repeat(depth - 1)}]`;
      if (depth > 1) {
        context.warn(
          `${label}: a nested array is written as a multidimensional array (${clrType}), which only Npgsql maps.`
        );
      }
      initializer = depth === 1 ? `Array.Empty<${clr.name}>()` : 'null!';
    } else {
      context.warn(
        `${label}: a nested array has no EF Core mapping outside PostgreSQL; the column was written as a string.`
      );
      clrType = 'string';
      initializer = 'string.Empty';
      columnType = undefined;
    }
    valueType = false;
    maxLength = undefined;
  }

  // Facets that do not apply to the CLR type are left out.
  const isText: boolean = clrType === 'string';
  const facetsApply: boolean = depth === 0;
  if (maxLength !== undefined && !isText && conversion === undefined) {
    maxLength = undefined;
  }

  // Generated values ---------------------------------------------------------------------------
  let generated: ColumnSpec['generated'];
  const isInteger: boolean =
    (field.type === 'int' || field.type === 'bigInt') &&
    depth === 0 &&
    enumPlan === undefined;
  if (field.default?.kind === 'autoIncrement') {
    if (!isInteger) {
      context.warn(
        `${label}: an auto-increment default on a ${field.type} column cannot be written; the default was dropped.`
      );
    } else if (!(options.isKey && options.singleKey)) {
      generated = 'identity';
    }
  } else if (options.isKey && options.singleKey) {
    const generatesItself: boolean =
      isInteger || (field.type === 'uuid' && depth === 0);
    const keepsDefault: boolean =
      field.type === 'uuid' &&
      (field.default?.kind === 'uuid' ||
        field.default?.kind === 'dbExpression');
    if (generatesItself && !keepsDefault) {
      generated = 'none';
    }
  }

  // Computed column -----------------------------------------------------------------------------
  let computed: ColumnSpec['computed'];
  if (field.generated !== undefined) {
    if (PYTHON_EXPRESSION.test(field.generated.expression)) {
      context.warn(
        `${label}: the generated column expression ${field.generated.expression} is Python, not SQL; the column was written as a regular column.`
      );
    } else {
      computed = {
        sql: field.generated.expression,
        stored: field.generated.isStored,
      };
    }
  }

  const defaults: DefaultSpec =
    computed !== undefined
      ? {}
      : defaultOf(
          context,
          label,
          field,
          enumPlan,
          options.isKey && options.singleKey
        );

  let autoUpdated: boolean = false;
  if (field.isAutoUpdated) {
    if (field.type === 'dateTime' && depth === 0 && !options.isKey) {
      autoUpdated = true;
    } else {
      context.warn(
        `${label}: EF Core cannot refresh a ${field.type} column on every save; it was written as an ordinary column.`
      );
    }
  }

  const precision: ColumnSpec['precision'] =
    facetsApply && field.type === 'decimal' ? clr.precision : undefined;
  const nullable: boolean = options.isKey ? false : field.isNullable;
  return {
    clrType,
    isValueType: valueType,
    nullable,
    initializer: initializerOf(
      valueType,
      nullable,
      initializer,
      defaults,
      computed !== undefined
    ),
    columnName: field.columnName,
    columnType,
    maxLength,
    precision,
    generated,
    conversion,
    defaultValue: defaults.value,
    defaultSql: defaults.sql,
    clientGuid: defaults.clientGuid === true,
    autoUpdated,
    computed,
    enumPlan: enumPlan !== undefined && depth === 0 ? enumPlan : undefined,
  };
}
