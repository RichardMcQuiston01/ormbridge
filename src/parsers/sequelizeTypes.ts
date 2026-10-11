import type { IrRangeSubtype, IrScalarType } from '../ir.js';
import type { TsValue } from './typescriptSyntax.js';

/** A Sequelize `DataTypes` expression reduced to what the IR can hold. */
export interface ResolvedDataType {
  type: IrScalarType;
  maxLength?: number;
  maxDigits?: number;
  decimalPlaces?: number;
  /** Values of an `ENUM` column. */
  enumValues?: string[];
  /** Dimensions of an `ARRAY` column; `type` then describes the innermost element. */
  arrayDepth?: number;
  rangeOf?: IrRangeSubtype;
  unsupportedType?: string;
  /** True for `DataTypes.VIRTUAL`, which has no database column. */
  isVirtual?: boolean;
  /** An approximation made while reading the type, to be reported with the field's location. */
  note?: string;
}

/** Sequelize's default length for `STRING` and `CHAR` (VARCHAR(255)). */
const DEFAULT_STRING_LENGTH: number = 255;

const SIMPLE_TYPES: Readonly<Record<string, IrScalarType>> = {
  TEXT: 'text',
  CITEXT: 'text',
  TINYINT: 'int',
  SMALLINT: 'int',
  MEDIUMINT: 'int',
  INTEGER: 'int',
  NUMBER: 'int',
  BIGINT: 'bigInt',
  FLOAT: 'float',
  REAL: 'float',
  DOUBLE: 'float',
  BOOLEAN: 'boolean',
  DATE: 'dateTime',
  DATEONLY: 'date',
  TIME: 'time',
  NOW: 'dateTime',
  UUID: 'uuid',
  UUIDV1: 'uuid',
  UUIDV4: 'uuid',
  JSON: 'json',
  JSONB: 'json',
  BLOB: 'bytes',
  HSTORE: 'hstore',
  INET: 'ipAddress',
};

/** Types the IR has no scalar for; the value is the SQL type they create. */
const UNSUPPORTED_TYPES: Readonly<Record<string, string>> = {
  GEOMETRY: 'geometry',
  GEOGRAPHY: 'geography',
  CIDR: 'cidr',
  MACADDR: 'macaddr',
  TSVECTOR: 'tsvector',
};

const STRUCTURED_TYPES: ReadonlySet<string> = new Set([
  'STRING',
  'CHAR',
  'DECIMAL',
  'NUMERIC',
  'ENUM',
  'ARRAY',
  'RANGE',
  'VIRTUAL',
]);

const RANGE_SUBTYPES: Readonly<Record<string, IrRangeSubtype>> = {
  INTEGER: 'int',
  BIGINT: 'bigInt',
  DECIMAL: 'decimal',
  NUMERIC: 'decimal',
  DATE: 'dateTime',
  DATEONLY: 'date',
};

function isTypeName(name: string): boolean {
  return (
    SIMPLE_TYPES[name] !== undefined ||
    UNSUPPORTED_TYPES[name] !== undefined ||
    STRUCTURED_TYPES.has(name)
  );
}

interface TypeExpression {
  /** The `DataTypes` member, for example "DECIMAL". */
  base: string;
  args: TsValue[];
  /** Chained flags such as `UNSIGNED`, `ZEROFILL` or `BINARY`. */
  modifiers: string[];
}

/** Reads the arguments of `DECIMAL(10,2).UNSIGNED`, which the evaluator keeps as a single name. */
function argumentsFromText(text: string): TsValue[] {
  const args: TsValue[] = [];
  for (const piece of text.split(',')) {
    const trimmed: string = piece.trim();
    if (trimmed === '') {
      continue;
    }
    const quoted: RegExpExecArray | null = /^(['"`])(.*)\1$/.exec(trimmed);
    if (quoted !== null) {
      args.push({ kind: 'string', value: quoted[2] ?? '' });
    } else if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
      args.push({ kind: 'number', value: Number(trimmed) });
    } else {
      args.push({ kind: 'name', value: trimmed });
    }
  }
  return args;
}

/** Splits `DataTypes.INTEGER.UNSIGNED` into the type and its modifiers, skipping the namespace. */
function splitDottedName(
  dotted: string
): { base: string; modifiers: string[] } | undefined {
  const parts: string[] = dotted.split('.');
  const index: number = parts.findIndex(isTypeName);
  const base: string | undefined = parts[index];
  if (index < 0 || base === undefined) {
    return undefined;
  }
  return { base, modifiers: parts.slice(index + 1) };
}

function toTypeExpression(value: TsValue): TypeExpression | undefined {
  if (value.kind === 'call') {
    const split = splitDottedName(value.callee);
    return split === undefined ? undefined : { ...split, args: value.args };
  }
  if (value.kind !== 'name') {
    return undefined;
  }
  const open: number = value.value.indexOf('(');
  if (open < 0) {
    const split = splitDottedName(value.value);
    return split === undefined ? undefined : { ...split, args: [] };
  }
  // `DataTypes.DECIMAL(10, 2).UNSIGNED`: a call followed by a member access.
  const close: number = value.value.lastIndexOf(')');
  const head = splitDottedName(value.value.slice(0, open));
  if (head === undefined || close < open) {
    return undefined;
  }
  const trailing: string[] = value.value
    .slice(close + 1)
    .split('.')
    .filter((part: string) => part !== '');
  return {
    base: head.base,
    args: argumentsFromText(value.value.slice(open + 1, close)),
    modifiers: [...head.modifiers, ...trailing],
  };
}

function numberAt(args: TsValue[], index: number): number | undefined {
  const value: TsValue | undefined = args[index];
  return value !== undefined && value.kind === 'number'
    ? value.value
    : undefined;
}

function optionsOf(args: TsValue[]): Record<string, TsValue> | undefined {
  const first: TsValue | undefined = args[0];
  return first !== undefined && first.kind === 'object'
    ? first.properties
    : undefined;
}

function numberProperty(
  properties: Record<string, TsValue> | undefined,
  key: string
): number | undefined {
  const value: TsValue | undefined = properties?.[key];
  return value !== undefined && value.kind === 'number'
    ? value.value
    : undefined;
}

function enumValuesOf(args: TsValue[]): string[] | undefined {
  const first: TsValue | undefined = args[0];
  const list: TsValue[] =
    args.length === 1 && first !== undefined && first.kind === 'array'
      ? first.items
      : args.length === 1 && first !== undefined && first.kind === 'object'
        ? valuesProperty(first.properties)
        : args;
  const values: string[] = [];
  for (const item of list) {
    if (item.kind !== 'string') {
      return undefined;
    }
    values.push(item.value);
  }
  return values;
}

function valuesProperty(properties: Record<string, TsValue>): TsValue[] {
  const values: TsValue | undefined = properties['values'];
  return values !== undefined && values.kind === 'array' ? values.items : [];
}

/**
 * Reads a `DataTypes` expression (`DataTypes.STRING(100)`, `DataType.INTEGER`, `STRING`, ...).
 * Returns undefined when the expression is not a Sequelize data type at all.
 */
export function resolveDataType(value: TsValue): ResolvedDataType | undefined {
  const expression: TypeExpression | undefined = toTypeExpression(value);
  if (expression === undefined) {
    return undefined;
  }
  const { base, args, modifiers } = expression;
  const options: Record<string, TsValue> | undefined = optionsOf(args);

  switch (base) {
    case 'STRING':
    case 'CHAR': {
      const length: number =
        numberAt(args, 0) ??
        numberProperty(options, 'length') ??
        DEFAULT_STRING_LENGTH;
      const binaryFlag: TsValue | undefined = options?.['binary'];
      const isBinary: boolean =
        modifiers.includes('BINARY') ||
        (binaryFlag !== undefined &&
          binaryFlag.kind === 'bool' &&
          binaryFlag.value) ||
        (args[1] !== undefined && args[1].kind === 'bool' && args[1].value);
      return isBinary
        ? { type: 'bytes', maxLength: length }
        : { type: 'string', maxLength: length };
    }
    case 'DECIMAL':
    case 'NUMERIC': {
      const precision: number | undefined =
        numberAt(args, 0) ?? numberProperty(options, 'precision');
      const scale: number | undefined =
        numberAt(args, 1) ?? numberProperty(options, 'scale');
      return {
        type: 'decimal',
        ...(precision === undefined ? {} : { maxDigits: precision }),
        ...(scale === undefined ? {} : { decimalPlaces: scale }),
      };
    }
    case 'ENUM': {
      const values: string[] | undefined = enumValuesOf(args);
      if (values === undefined) {
        return {
          type: 'string',
          maxLength: DEFAULT_STRING_LENGTH,
          note: 'the ENUM values are not all string literals, so the column was read as a plain string',
        };
      }
      return { type: 'string', enumValues: values };
    }
    case 'ARRAY': {
      const inner: TsValue | undefined = args[0];
      const element: ResolvedDataType | undefined =
        inner === undefined ? undefined : resolveDataType(inner);
      if (element === undefined) {
        return {
          type: 'unsupported',
          unsupportedType: 'array',
          note: 'the ARRAY element type could not be determined',
        };
      }
      return { ...element, arrayDepth: (element.arrayDepth ?? 0) + 1 };
    }
    case 'RANGE': {
      const inner: TsValue | undefined = args[0];
      const subtype: ResolvedDataType | undefined =
        inner === undefined ? undefined : resolveDataType(inner);
      const innerBase: string | undefined =
        inner === undefined ? undefined : toTypeExpression(inner)?.base;
      const rangeOf: IrRangeSubtype | undefined =
        innerBase === undefined ? undefined : RANGE_SUBTYPES[innerBase];
      if (subtype === undefined || rangeOf === undefined) {
        return {
          type: 'unsupported',
          unsupportedType: 'range',
          note: 'the RANGE element type is not one of INTEGER, BIGINT, DECIMAL, DATE or DATEONLY',
        };
      }
      return { type: 'range', rangeOf };
    }
    case 'VIRTUAL':
      return { type: 'unsupported', isVirtual: true };
    default:
      break;
  }

  const simple: IrScalarType | undefined = SIMPLE_TYPES[base];
  if (simple !== undefined) {
    return { type: simple };
  }
  const unsupported: string | undefined = UNSUPPORTED_TYPES[base];
  return {
    type: 'unsupported',
    unsupportedType: unsupported ?? base.toLowerCase(),
    note: `DataTypes.${base} has no equivalent in the shared model`,
  };
}
