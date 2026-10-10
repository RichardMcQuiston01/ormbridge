import type { IrDefault, IrEnum, IrRangeSubtype, IrScalarType } from '../ir.js';
import { Cursor, sourceOf, type SqlDialect, type Token } from './sqlSyntax.js';

/** A column type as written, before it is mapped to the shared model. */
export interface RawType {
  /** Lower-case type name with single spaces: `character varying`, `double precision`, `int`. */
  name: string;
  /** Text of the first parenthesised argument list: `['10', '2']` for `numeric(10, 2)`. */
  args: string[];
  arrayDepth: number;
  unsigned: boolean;
  /** Members of an inline MySQL `ENUM('a', 'b')`. */
  enumValues?: string[];
  /** Members of a MySQL `SET('a', 'b')`. */
  setValues?: string[];
  /** The type as written, for the `unsupportedType` of columns the model cannot describe. */
  text: string;
  /** Name of a user-defined type without schema or quotes, with the case it was written in. */
  userName: string;
}

export interface MappedType {
  type: IrScalarType;
  maxLength?: number;
  maxDigits?: number;
  decimalPlaces?: number;
  rangeOf?: IrRangeSubtype;
  /** True for serial types, which are auto-incrementing and not null. */
  autoIncrement?: boolean;
  /** True for types the model has no name for (the column keeps its type text). */
  unsupported?: boolean;
  /** True when the name is not a built-in type (it may be an enum). */
  isUserType?: boolean;
}

/** Words that may follow the first word of a type name, by that first word. */
const TYPE_CONTINUATIONS: Readonly<Record<string, ReadonlySet<string>>> = {
  double: new Set(['precision']),
  character: new Set(['varying', 'large', 'object']),
  char: new Set(['varying', 'large', 'object']),
  nchar: new Set(['varying', 'large', 'object']),
  national: new Set([
    'character',
    'char',
    'varchar',
    'varying',
    'large',
    'object',
  ]),
  native: new Set(['character']),
  varying: new Set(['character']),
  bit: new Set(['varying']),
  binary: new Set(['varying', 'large', 'object']),
  long: new Set(['varchar', 'raw', 'varbinary']),
  unsigned: new Set(['big', 'int', 'integer']),
  big: new Set(['int', 'integer']),
  interval: new Set(['year', 'month', 'day', 'hour', 'minute', 'second', 'to']),
};

/** Second words that may continue a multi-word type after another continuation word. */
const CHAINED_CONTINUATIONS: ReadonlySet<string> = new Set([
  'varying',
  'character',
  'char',
  'large',
  'object',
  'int',
  'integer',
  'to',
  'month',
  'day',
  'hour',
  'minute',
  'second',
  'year',
  'precision',
  'varchar',
]);

/**
 * Reads a column type. Never fails: a cursor at something that is not a type gives an empty name, which the
 * mapping reports as an unknown type.
 */
export function parseType(
  cursor: Cursor,
  text: string,
  dialect: SqlDialect
): RawType {
  const startToken: Token = cursor.peek();
  const startPosition: number = cursor.position;
  const consumed: Token[] = [];
  const nameWords: string[] = [];
  let userName: string;
  let args: string[] = [];
  let enumValues: string[] | undefined;
  let setValues: string[] | undefined;
  let arrayDepth: number = 0;
  let unsigned: boolean = false;
  let hasArgs: boolean = false;

  if (startToken.kind === 'ident') {
    // A quoted type name, possibly schema-qualified: "public"."post_status".
    let last: Token = cursor.next();
    consumed.push(last);
    while (cursor.isPunct('.')) {
      cursor.next();
      const part: Token = cursor.peek();
      if (part.kind === 'ident' || part.kind === 'word') {
        last = cursor.next();
        consumed.push(last);
      } else {
        break;
      }
    }
    userName = last.value;
    nameWords.push(last.value.toLowerCase());
  } else if (startToken.kind === 'word') {
    cursor.next();
    consumed.push(startToken);
    if (cursor.isPunct('.')) {
      // schema.type
      let last: Token = startToken;
      while (cursor.isPunct('.')) {
        cursor.next();
        const part: Token = cursor.peek();
        if (part.kind === 'ident' || part.kind === 'word') {
          last = cursor.next();
          consumed.push(last);
        } else {
          break;
        }
      }
      userName = last.value;
      nameWords.push(last.value.toLowerCase());
    } else {
      userName = startToken.value;
      nameWords.push(startToken.value.toLowerCase());
    }
  } else {
    return {
      name: '',
      args: [],
      arrayDepth: 0,
      unsigned: false,
      text: '',
      userName: '',
    };
  }

  const first: string = nameWords[0] ?? '';
  const isBuiltInStart: boolean =
    startToken.kind === 'word' && nameWords.length === 1;

  for (;;) {
    const token: Token = cursor.peek();
    if (token.kind === 'word') {
      const word: string = token.value.toLowerCase();
      if (word === 'unsigned' || word === 'signed' || word === 'zerofill') {
        if (word === 'unsigned') {
          unsigned = true;
        }
        consumed.push(cursor.next());
        continue;
      }
      if (word === 'array') {
        arrayDepth += 1;
        consumed.push(cursor.next());
        if (cursor.isPunct('[')) {
          while (!cursor.atEnd && !cursor.isPunct(']')) {
            consumed.push(cursor.next());
          }
          if (cursor.isPunct(']')) {
            consumed.push(cursor.next());
          }
        }
        continue;
      }
      if (
        (word === 'with' || word === 'without') &&
        (cursor.isKeyword('TIME', 1) || cursor.isKeyword('LOCAL', 1))
      ) {
        consumed.push(cursor.next());
        if (cursor.isKeyword('LOCAL')) {
          consumed.push(cursor.next());
        }
        if (cursor.isKeyword('TIME')) {
          consumed.push(cursor.next());
        }
        if (cursor.isKeyword('ZONE')) {
          consumed.push(cursor.next());
        }
        continue;
      }
      const allowed: ReadonlySet<string> | undefined = isBuiltInStart
        ? TYPE_CONTINUATIONS[first]
        : undefined;
      const chained: boolean =
        nameWords.length > 1 && CHAINED_CONTINUATIONS.has(word);
      if (
        isBuiltInStart &&
        (allowed?.has(word) === true || chained) &&
        // `varchar CHARACTER SET utf8` is a column option, not a type word.
        !(word === 'character' && cursor.isKeyword('SET', 1))
      ) {
        nameWords.push(word);
        consumed.push(cursor.next());
        continue;
      }
      break;
    }
    if (token.kind === 'punct' && token.text === '(' && !hasArgs) {
      hasArgs = true;
      const group: Token[] = cursor.readGroup() ?? [];
      consumed.push(token);
      for (const inner of group) {
        consumed.push(inner);
      }
      consumed.push(cursor.tokens[cursor.position - 1] ?? token);
      args = group
        .filter(
          (inner: Token) =>
            inner.kind === 'number' ||
            inner.kind === 'word' ||
            inner.kind === 'ident'
        )
        .map((inner: Token) => inner.value);
      const strings: string[] = group
        .filter((inner: Token) => inner.kind === 'string')
        .map((inner: Token) => inner.value);
      if (first === 'enum' && strings.length > 0) {
        enumValues = strings;
      } else if (first === 'set' && strings.length > 0) {
        setValues = strings;
      }
      continue;
    }
    if (token.kind === 'punct' && token.text === '[') {
      // PostgreSQL array suffix: [] or [3].
      consumed.push(cursor.next());
      while (!cursor.atEnd && !cursor.isPunct(']')) {
        consumed.push(cursor.next());
      }
      if (cursor.isPunct(']')) {
        consumed.push(cursor.next());
      }
      arrayDepth += 1;
      continue;
    }
    break;
  }

  if (cursor.position === startPosition) {
    cursor.next();
  }
  return {
    name: nameWords.join(' '),
    args,
    arrayDepth,
    unsigned,
    ...(enumValues === undefined ? {} : { enumValues }),
    ...(setValues === undefined ? {} : { setValues }),
    text:
      dialect === 'postgresql'
        ? sourceOf(text, consumed)
        : sourceOf(text, consumed).replace(/[[\]`]/g, ''),
    userName,
  };
}

function toInteger(value: string | undefined): number | undefined {
  if (value === undefined || !/^\d{1,9}$/.test(value)) {
    return undefined;
  }
  return Number(value);
}

const INT_NAMES: ReadonlySet<string> = new Set([
  'int',
  'integer',
  'int2',
  'int4',
  'smallint',
  'mediumint',
  'int3',
  'tinyint',
  'int1',
  'year',
]);
const BIG_INT_NAMES: ReadonlySet<string> = new Set([
  'bigint',
  'int8',
  'big int',
  'unsigned big int',
]);
const SERIAL_NAMES: Readonly<Record<string, IrScalarType>> = {
  serial: 'int',
  serial4: 'int',
  serial2: 'int',
  smallserial: 'int',
  bigserial: 'bigInt',
  serial8: 'bigInt',
};
const FLOAT_NAMES: ReadonlySet<string> = new Set([
  'real',
  'float',
  'float4',
  'float8',
  'double',
  'double precision',
  'binary_float',
  'binary_double',
]);
const DECIMAL_NAMES: ReadonlySet<string> = new Set([
  'numeric',
  'decimal',
  'dec',
  'fixed',
  'number',
]);
const STRING_NAMES: ReadonlySet<string> = new Set([
  'varchar',
  'character varying',
  'varying character',
  'nvarchar',
  'national varchar',
  'national character varying',
  'national char varying',
  'nchar varying',
  'varchar2',
  'nvarchar2',
  'bpchar',
  'name',
  'native character',
]);
const FIXED_CHAR_NAMES: ReadonlySet<string> = new Set([
  'char',
  'character',
  'nchar',
  'national char',
  'national character',
]);
const TEXT_NAMES: ReadonlySet<string> = new Set([
  'text',
  'tinytext',
  'mediumtext',
  'longtext',
  'ntext',
  'clob',
  'nclob',
  'long',
  'long varchar',
  'citext',
  'character large object',
  'char large object',
  'string',
]);
const DATE_TIME_NAMES: ReadonlySet<string> = new Set([
  'timestamp',
  'timestamptz',
  'datetime',
  'datetime2',
  'smalldatetime',
  'datetimeoffset',
]);
const BYTES_NAMES: ReadonlySet<string> = new Set([
  'bytea',
  'blob',
  'tinyblob',
  'mediumblob',
  'longblob',
  'binary',
  'varbinary',
  'binary varying',
  'image',
  'raw',
  'long raw',
  'long varbinary',
  'binary large object',
]);
const RANGE_NAMES: Readonly<Record<string, IrRangeSubtype>> = {
  int4range: 'int',
  int8range: 'bigInt',
  numrange: 'decimal',
  daterange: 'date',
  tsrange: 'dateTime',
  tstzrange: 'dateTime',
};

/** SQLite assigns a type affinity from substrings of the declared type. */
function mapSqliteAffinity(name: string): MappedType | undefined {
  if (name.includes('int')) {
    return { type: 'int' };
  }
  if (name.includes('char') || name.includes('clob') || name.includes('text')) {
    return { type: 'text' };
  }
  if (name.includes('blob')) {
    return { type: 'bytes' };
  }
  if (name.includes('real') || name.includes('floa') || name.includes('doub')) {
    return { type: 'float' };
  }
  return undefined;
}

/** Maps a column type to the shared model. Unknown names come back as `isUserType` (possibly an enum). */
export function mapType(raw: RawType, dialect: SqlDialect): MappedType {
  const name: string = raw.name;
  const first: number | undefined = toInteger(raw.args[0]);
  const second: number | undefined = toInteger(raw.args[1]);

  if (raw.enumValues !== undefined) {
    return { type: 'string' };
  }
  if (raw.setValues !== undefined) {
    return { type: 'text' };
  }
  const serial: IrScalarType | undefined = SERIAL_NAMES[name];
  if (serial !== undefined && dialect !== 'sqlite') {
    return {
      type: dialect === 'mysql' && name === 'serial' ? 'bigInt' : serial,
      autoIncrement: true,
    };
  }
  if (name === 'bool' || name === 'boolean') {
    return { type: 'boolean' };
  }
  if (name === 'bit') {
    if (raw.args.length === 0 || first === 1) {
      return { type: 'boolean' };
    }
    return { type: 'unsupported', unsupported: true };
  }
  if (name === 'tinyint' && dialect === 'mysql' && first === 1) {
    return { type: 'boolean' };
  }
  if (INT_NAMES.has(name)) {
    return { type: 'int' };
  }
  if (BIG_INT_NAMES.has(name)) {
    return { type: 'bigInt' };
  }
  if (FLOAT_NAMES.has(name)) {
    return { type: 'float' };
  }
  if (DECIMAL_NAMES.has(name)) {
    return {
      type: 'decimal',
      ...(first === undefined ? {} : { maxDigits: first }),
      ...(first === undefined ? {} : { decimalPlaces: second ?? 0 }),
    };
  }
  if (name === 'money' || name === 'smallmoney') {
    if (dialect === 'sqlserver') {
      return {
        type: 'decimal',
        maxDigits: name === 'money' ? 19 : 10,
        decimalPlaces: 4,
      };
    }
    return { type: 'unsupported', unsupported: true };
  }
  if (STRING_NAMES.has(name)) {
    if (raw.args[0]?.toLowerCase() === 'max' || first === undefined) {
      return { type: 'text' };
    }
    return { type: 'string', maxLength: first };
  }
  if (FIXED_CHAR_NAMES.has(name)) {
    if (raw.args[0]?.toLowerCase() === 'max') {
      return { type: 'text' };
    }
    if (first === undefined) {
      return dialect === 'sqlite'
        ? { type: 'text' }
        : { type: 'string', maxLength: 1 };
    }
    return { type: 'string', maxLength: first };
  }
  if (TEXT_NAMES.has(name)) {
    return { type: 'text' };
  }
  if (name === 'json' || name === 'jsonb') {
    return { type: 'json' };
  }
  if (name === 'timestamp' && dialect === 'sqlserver') {
    return { type: 'unsupported', unsupported: true };
  }
  if (name === 'rowversion') {
    return { type: 'unsupported', unsupported: true };
  }
  if (DATE_TIME_NAMES.has(name)) {
    return { type: 'dateTime' };
  }
  if (name === 'date') {
    return { type: 'date' };
  }
  if (name === 'time' || name === 'timetz') {
    return { type: 'time' };
  }
  if (name === 'interval' || name.startsWith('interval ')) {
    return { type: 'duration' };
  }
  if (name === 'uuid' || name === 'uniqueidentifier') {
    return { type: 'uuid' };
  }
  if (BYTES_NAMES.has(name)) {
    return { type: 'bytes' };
  }
  if (name === 'inet' || name === 'cidr') {
    return { type: 'ipAddress' };
  }
  if (name === 'hstore') {
    return { type: 'hstore' };
  }
  const rangeOf: IrRangeSubtype | undefined = RANGE_NAMES[name];
  if (rangeOf !== undefined) {
    return { type: 'range', rangeOf };
  }
  if (dialect === 'sqlite') {
    const affinity: MappedType | undefined = mapSqliteAffinity(name);
    if (affinity !== undefined) {
      return affinity;
    }
    if (name === '') {
      return { type: 'bytes' };
    }
    return { type: 'decimal' };
  }
  return { type: 'unsupported', unsupported: true, isUserType: true };
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const NOW_FUNCTIONS: ReadonlySet<string> = new Set([
  'CURRENT_TIMESTAMP',
  'CURRENT_DATE',
  'CURRENT_TIME',
  'LOCALTIMESTAMP',
  'LOCALTIME',
  'NOW',
  'GETDATE',
  'GETUTCDATE',
  'SYSDATETIME',
  'SYSUTCDATETIME',
  'SYSDATETIMEOFFSET',
  'TRANSACTION_TIMESTAMP',
  'STATEMENT_TIMESTAMP',
  'CLOCK_TIMESTAMP',
]);
const UUID_FUNCTIONS: ReadonlySet<string> = new Set([
  'GEN_RANDOM_UUID',
  'UUID_GENERATE_V4',
  'UUID_GENERATE_V1',
  'UUID_GENERATE_V1MC',
  'NEWID',
  'NEWSEQUENTIALID',
  'UUID',
  'UUID_V4',
  'UUIDV4',
]);
const SQLITE_NOW_FUNCTIONS: ReadonlySet<string> = new Set([
  'DATETIME',
  'DATE',
  'TIME',
  'JULIANDAY',
]);

/** What the default of a column is read against. */
export interface DefaultTarget {
  type: IrScalarType;
  /** The enum that backs the column, when it has one. */
  enumType?: IrEnum;
  isArray: boolean;
}

/** Layers of wrapping parentheses removed from a default; more than this is never a real default. */
const MAX_STRIPPED_LAYERS: number = 32;

/** Removes parentheses that wrap the whole expression: `((0))` becomes `0`. */
function stripOuterParens(tokens: readonly Token[]): readonly Token[] {
  let from: number = 0;
  let to: number = tokens.length;
  for (let layer: number = 0; layer < MAX_STRIPPED_LAYERS; layer += 1) {
    const first: Token | undefined = tokens[from];
    const last: Token | undefined = tokens[to - 1];
    if (
      to - from < 2 ||
      first === undefined ||
      last === undefined ||
      first.text !== '(' ||
      first.kind !== 'punct' ||
      last.text !== ')' ||
      last.kind !== 'punct'
    ) {
      break;
    }
    let depth: number = 0;
    let wrapsAll: boolean = true;
    for (let at: number = from; at < to; at += 1) {
      const token: Token | undefined = tokens[at];
      if (token?.kind === 'punct') {
        if (token.text === '(') {
          depth += 1;
        } else if (token.text === ')') {
          depth -= 1;
          if (depth === 0 && at < to - 1) {
            wrapsAll = false;
            break;
          }
        }
      }
    }
    if (!wrapsAll) {
      break;
    }
    from += 1;
    to -= 1;
  }
  return from === 0 && to === tokens.length ? tokens : tokens.slice(from, to);
}

/** True when what follows a literal is only a type cast: `::character varying`, `::text[]`, `::"public"."x"`. */
function isCastOnly(tokens: readonly Token[]): boolean {
  const first: Token | undefined = tokens[0];
  if (first === undefined) {
    return true;
  }
  if (first.kind !== 'punct' || first.text !== '::') {
    return false;
  }
  return tokens.every(
    (token: Token): boolean =>
      token.kind === 'word' ||
      token.kind === 'ident' ||
      token.kind === 'number' ||
      (token.kind === 'punct' && /^(::|\(|\)|,|\.|\[|\])$/.test(token.text))
  );
}

function numberLiteral(text: string): number | string {
  const value: number = Number(text);
  if (
    Number.isFinite(value) &&
    String(value) !== '' &&
    /^[+-]?\d+(\.\d+)?$/.test(text)
  ) {
    const normalized: string = text
      .replace(/^\+/, '')
      .replace(/^(-?)0+(?=\d)/, '$1');
    const canonical: string = String(value);
    if (
      canonical === normalized ||
      (normalized.includes('.') &&
        canonical === normalized.replace(/0+$/, '').replace(/\.$/, ''))
    ) {
      return value;
    }
  }
  return text;
}

/**
 * Reads a DEFAULT expression. Returns `null` for `DEFAULT NULL` (no default at all), and `undefined` for an
 * expression the model cannot describe, which the caller keeps as a raw database expression.
 */
export function interpretDefault(
  allTokens: readonly Token[],
  target: DefaultTarget,
  dialect: SqlDialect
): IrDefault | null | undefined {
  const tokens: readonly Token[] = stripOuterParens(allTokens);
  const first: Token | undefined = tokens[0];
  if (first === undefined) {
    return null;
  }
  const stringish: boolean =
    target.type === 'string' ||
    target.type === 'text' ||
    target.type === 'uuid' ||
    target.type === 'json' ||
    target.type === 'dateTime' ||
    target.type === 'date' ||
    target.type === 'time' ||
    target.type === 'duration' ||
    target.type === 'ipAddress';

  if (first.kind === 'word' && first.up === 'NULL' && tokens.length === 1) {
    return null;
  }

  // Booleans and numbers.
  if (first.kind === 'word' && (first.up === 'TRUE' || first.up === 'FALSE')) {
    if (tokens.length === 1 && !target.isArray) {
      if (target.type === 'boolean') {
        return { kind: 'literal', value: first.up === 'TRUE' };
      }
      if (target.type === 'int' || target.type === 'bigInt') {
        return { kind: 'literal', value: first.up === 'TRUE' ? 1 : 0 };
      }
    }
    return undefined;
  }
  let signed: string = '';
  let numberToken: Token | undefined;
  if (first.kind === 'number' && tokens.length === 1) {
    numberToken = first;
  } else if (
    first.kind === 'punct' &&
    (first.text === '-' || first.text === '+') &&
    tokens.length === 2 &&
    tokens[1]?.kind === 'number'
  ) {
    signed = first.text === '-' ? '-' : '';
    numberToken = tokens[1];
  }
  if (numberToken !== undefined && !target.isArray) {
    const text: string = `${signed}${numberToken.value}`;
    if (target.type === 'boolean') {
      if (text === '1') {
        return { kind: 'literal', value: true };
      }
      if (text === '0') {
        return { kind: 'literal', value: false };
      }
      return undefined;
    }
    if (
      target.type === 'int' ||
      target.type === 'bigInt' ||
      target.type === 'float' ||
      target.type === 'decimal'
    ) {
      return { kind: 'literal', value: numberLiteral(text) };
    }
    if (stringish && target.enumType === undefined) {
      return { kind: 'literal', value: text };
    }
    return undefined;
  }

  // String literals, optionally cast.
  if (first.kind === 'string' && !target.isArray) {
    const rest: readonly Token[] = tokens.slice(1);
    if (isCastOnly(rest)) {
      const value: string = first.value;
      if (target.enumType !== undefined) {
        const member = target.enumType.values.find(
          (candidate) => candidate.dbValue === value
        );
        if (member !== undefined) {
          return { kind: 'enumValue', value: member.name };
        }
        return undefined;
      }
      if (target.type === 'boolean') {
        const lowered: string = value.toLowerCase();
        if (['t', 'true', '1', 'y', 'yes', 'on'].includes(lowered)) {
          return { kind: 'literal', value: true };
        }
        if (['f', 'false', '0', 'n', 'no', 'off'].includes(lowered)) {
          return { kind: 'literal', value: false };
        }
        return undefined;
      }
      if (
        target.type === 'int' ||
        target.type === 'bigInt' ||
        target.type === 'float' ||
        target.type === 'decimal'
      ) {
        if (/^[+-]?\d+(\.\d+)?$/.test(value.trim())) {
          return { kind: 'literal', value: numberLiteral(value.trim()) };
        }
        return undefined;
      }
      if (
        (target.type === 'dateTime' ||
          target.type === 'date' ||
          target.type === 'time') &&
        value.toLowerCase() === 'now'
      ) {
        return { kind: 'now' };
      }
      if (stringish) {
        return { kind: 'literal', value };
      }
    }
    return undefined;
  }

  // Function calls and keywords.
  if (first.kind === 'word') {
    const callGroup: boolean =
      tokens.length === 1 ||
      (tokens[1]?.kind === 'punct' &&
        tokens[1].text === '(' &&
        tokens[tokens.length - 1]?.text === ')' &&
        tokens[tokens.length - 1]?.kind === 'punct');
    if (callGroup && NOW_FUNCTIONS.has(first.up)) {
      if (
        target.type === 'dateTime' ||
        target.type === 'date' ||
        target.type === 'time'
      ) {
        return { kind: 'now' };
      }
    }
    if (
      callGroup &&
      UUID_FUNCTIONS.has(first.up) &&
      (target.type === 'uuid' || target.type === 'string')
    ) {
      return { kind: 'uuid' };
    }
    if (
      callGroup &&
      first.up === 'NEXTVAL' &&
      (target.type === 'int' || target.type === 'bigInt')
    ) {
      return { kind: 'autoIncrement' };
    }
    if (
      dialect === 'sqlite' &&
      SQLITE_NOW_FUNCTIONS.has(first.up) &&
      tokens[1]?.text === '(' &&
      tokens[2]?.kind === 'string' &&
      tokens[2].value.toLowerCase() === 'now' &&
      tokens.slice(3).every((token: Token) => token.kind !== 'word') &&
      (target.type === 'dateTime' ||
        target.type === 'date' ||
        target.type === 'time')
    ) {
      return { kind: 'now' };
    }
  }
  return undefined;
}

/** The raw expression of a default that is kept as written (parentheses around the whole text removed). */
export function defaultExpression(
  allTokens: readonly Token[],
  text: string
): string {
  return sourceOf(text, stripOuterParens(allTokens));
}
