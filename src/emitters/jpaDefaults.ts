import type { IrDefault, IrEnumValue, IrField, IrScalarType } from '../ir.js';
import { javaString, sqlString } from './jpaNames.js';
import type { EnumPlan } from './jpaTypes.js';
import type { PrismaProvider } from './prisma.js';

/** Turns the default of an IR field into what Hibernate can say: `@ColumnDefault` SQL or a generator. */

/** PostgreSQL and the databases that speak its types (MongoDB is written like PostgreSQL, with a warning). */
export function isPostgres(provider: PrismaProvider): boolean {
  return (
    provider === 'postgresql' ||
    provider === 'cockroachdb' ||
    provider === 'mongodb'
  );
}

export interface DefaultSpec {
  /** The text of `@ColumnDefault`. */
  sql?: string;
  /** True when the value is a UUID the application generates (`@UuidGenerator` or the id generator). */
  uuid?: boolean;
  /** True for a date-time "now" default, which `@CreationTimestamp` fills in. */
  creationTimestamp?: boolean;
  /** A Java expression with the same value, for the field initializer (so a new object already shows the default). */
  initializer?: string;
  /** The classes the initializer needs imported. */
  initializerImports?: string[];
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

/** The SQL that stands for "now" in a column type. */
function nowSql(provider: PrismaProvider, type: IrScalarType): string {
  if (provider === 'sqlserver' && type === 'dateTime') {
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

/** The enum member a default value names, by member name or by stored value. */
function enumMember(plan: EnumPlan, raw: string): IrEnumValue | undefined {
  return (
    plan.enumeration.values.find((value: IrEnumValue) => value.name === raw) ??
    plan.enumeration.values.find((value: IrEnumValue) => value.dbValue === raw)
  );
}

/** The stored value of an enum member as SQL: a number in a numeric column, quoted text otherwise. */
function enumSql(field: IrField, member: IrEnumValue): string {
  return (field.type === 'int' || field.type === 'bigInt') &&
    /^-?\d+$/.test(member.dbValue)
    ? member.dbValue
    : sqlString(member.dbValue);
}

function enumConstant(plan: EnumPlan, member: IrEnumValue): string {
  return `${plan.typeName}.${plan.members.get(member.name) ?? member.name}`;
}

/** The Java literal of a number for a column type, or undefined when it does not fit. */
function numberInitializer(field: IrField, value: number): string | undefined {
  if (!Number.isFinite(value)) {
    return undefined;
  }
  switch (field.type) {
    case 'int':
      return Number.isInteger(value) ? String(value) : undefined;
    case 'bigInt':
      return Number.isInteger(value) ? `${value}L` : undefined;
    case 'float': {
      const text: string = String(value);
      return /^-?\d+$/.test(text) ? `${text}.0` : text;
    }
    case 'decimal': {
      const text: string | undefined = numberSql(value);
      return text === undefined
        ? undefined
        : `new BigDecimal(${javaString(text)})`;
    }
    default:
      return undefined;
  }
}

function numberSql(value: number): string | undefined {
  if (!Number.isFinite(value)) {
    return undefined;
  }
  return /e/i.test(String(value))
    ? value.toFixed(20).replace(/\.?0+$/, '')
    : String(value);
}

function booleanSql(provider: PrismaProvider, value: boolean): string {
  return provider === 'mysql' ||
    provider === 'sqlite' ||
    provider === 'sqlserver'
    ? value
      ? '1'
      : '0'
    : String(value);
}

export interface DefaultContext {
  provider: PrismaProvider;
  warn: (message: string) => void;
}

function literalSql(
  context: DefaultContext,
  label: string,
  field: IrField,
  value: string | number | boolean,
  enumPlan: EnumPlan | undefined
): DefaultSpec {
  const drop = (reason: string): DefaultSpec => {
    context.warn(`${label}: ${reason}; the default was dropped.`);
    return {};
  };
  const asText: string = String(value);
  if (enumPlan !== undefined) {
    const found: IrEnumValue | undefined = enumMember(enumPlan, asText);
    if (found === undefined) {
      return drop(`the enum default "${asText}" matches no member`);
    }
    return {
      sql: enumSql(field, found),
      initializer: enumConstant(enumPlan, found),
    };
  }
  if (field.arrayDepth !== undefined) {
    return drop('an array default cannot be written');
  }
  switch (field.type) {
    case 'boolean': {
      const truth: boolean | undefined =
        typeof value === 'boolean'
          ? value
          : /^(1|true)$/i.test(asText)
            ? true
            : /^(0|false)$/i.test(asText)
              ? false
              : undefined;
      if (truth !== undefined) {
        return {
          sql: booleanSql(context.provider, truth),
          initializer: String(truth),
        };
      }
      return drop(`"${asText}" is not a boolean`);
    }
    case 'int':
    case 'bigInt':
    case 'float':
    case 'decimal': {
      const numeric: number = typeof value === 'number' ? value : Number(value);
      const number: string | undefined = numberSql(numeric);
      const initializer: string | undefined = numberInitializer(field, numeric);
      return number === undefined
        ? drop(`"${asText}" is not a number this column can hold`)
        : {
            sql: number,
            ...(initializer === undefined ? {} : { initializer }),
            ...(field.type === 'decimal'
              ? { initializerImports: ['java.math.BigDecimal'] }
              : {}),
          };
    }
    case 'json':
    case 'text':
      // MySQL does not accept a plain literal as the default of a TEXT or JSON column; an expression does.
      return {
        sql:
          context.provider === 'mysql'
            ? `(${sqlString(asText)})`
            : sqlString(asText),
        ...(field.type === 'text' ? { initializer: javaString(asText) } : {}),
      };
    case 'string':
      return { sql: sqlString(asText), initializer: javaString(asText) };
    case 'uuid':
      return {
        sql: sqlString(asText),
        ...(/^[0-9a-f-]{36}$/i.test(asText)
          ? {
              initializer: `UUID.fromString(${javaString(asText)})`,
              initializerImports: ['java.util.UUID'],
            }
          : {}),
      };
    case 'date':
    case 'time':
    case 'dateTime':
    case 'duration':
    case 'ipAddress':
      return { sql: sqlString(asText) };
    default:
      return drop(
        `a literal default on a ${field.type} column cannot be written`
      );
  }
}

/** Works out the default of a field; `isKey` is true for the single column of a primary key. */
export function defaultOf(
  context: DefaultContext,
  label: string,
  field: IrField,
  enumPlan: EnumPlan | undefined
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
      return {
        sql: nowSql(context.provider, field.type),
        ...(field.type === 'dateTime' ? { creationTimestamp: true } : {}),
      };
    case 'uuid':
      if (field.type !== 'uuid') {
        context.warn(
          `${label}: a UUID default on a ${field.type} column cannot be written; the default was dropped.`
        );
        return {};
      }
      return { uuid: true };
    case 'enumValue': {
      const found: IrEnumValue | undefined =
        enumPlan === undefined ? undefined : enumMember(enumPlan, value.value);
      if (enumPlan === undefined || found === undefined) {
        context.warn(
          `${label}: the enum default "${value.value}" matches no enum member; the default was dropped.`
        );
        return {};
      }
      return {
        sql: enumSql(field, found),
        initializer: enumConstant(enumPlan, found),
      };
    }
    case 'literal':
      return literalSql(context, label, field, value.value, enumPlan);
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
        `${label}: the ${value.generator}() default is generated by Prisma Client; JPA has no equivalent and the default was dropped.`
      );
      return {};
    default:
      return {};
  }
}
