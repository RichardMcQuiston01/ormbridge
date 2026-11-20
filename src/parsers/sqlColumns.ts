import type { IrDefault, IrScalarType } from '../ir.js';

/** What a CLR type, or a database column type name, maps to in the shared model. */
export interface ColumnShape {
  type: IrScalarType;
  maxLength?: number;
  maxDigits?: number;
  decimalPlaces?: number;
  arrayDepth?: number;
  /** The raw type text of an `unsupported` column. */
  unsupportedType?: string;
}

function toInteger(text: string | undefined): number | undefined {
  if (text === undefined || !/^\d+$/.test(text.trim())) {
    return undefined;
  }
  return Number(text.trim());
}

/**
 * Maps a database column type name given to HasColumnType / [Column(TypeName = ...)] to a column.
 * Returns undefined when the name is not recognised.
 */
export function sqlColumn(typeName: string): ColumnShape | undefined {
  const text: string = typeName.trim().toLowerCase().replace(/\s+/g, ' ');
  const match: RegExpMatchArray | null = text.match(
    /^([a-z_][a-z0-9_ ]*?)\s*(?:\(([^)]*)\))?(\s*\[\])?(?: unsigned)?$/
  );
  if (match === null) {
    return undefined;
  }
  const name: string = match[1] ?? '';
  const args: string[] = (match[2] ?? '')
    .split(',')
    .map((part: string) => part.trim())
    .filter((part: string) => part !== '');
  const isArray: boolean = match[3] !== undefined;
  const first: number | undefined = toInteger(args[0]);
  const second: number | undefined = toInteger(args[1]);
  const shape: ColumnShape | undefined = sqlName(name, args, first, second);
  if (shape === undefined) {
    return undefined;
  }
  return isArray ? { ...shape, arrayDepth: 1 } : shape;
}

function sqlName(
  name: string,
  args: string[],
  first: number | undefined,
  second: number | undefined
): ColumnShape | undefined {
  switch (name) {
    case 'varchar':
    case 'nvarchar':
    case 'char':
    case 'nchar':
    case 'character varying':
    case 'character':
    case 'national character varying':
    case 'national character':
    case 'varchar2':
    case 'nvarchar2':
    case 'bpchar':
    case 'string':
      if (first === undefined) {
        return args[0]?.toLowerCase() === 'max' || name === 'string'
          ? { type: 'text' }
          : { type: 'string' };
      }
      return { type: 'string', maxLength: first };
    case 'text':
    case 'ntext':
    case 'tinytext':
    case 'mediumtext':
    case 'longtext':
    case 'clob':
    case 'nclob':
    case 'citext':
    case 'xml':
      return { type: 'text' };
    case 'int':
    case 'integer':
    case 'int4':
    case 'mediumint':
    case 'serial':
    case 'serial4':
    case 'smallint':
    case 'int2':
    case 'smallserial':
    case 'tinyint':
      return { type: 'int' };
    case 'bigint':
    case 'int8':
    case 'bigserial':
    case 'serial8':
      return { type: 'bigInt' };
    case 'bit':
    case 'bool':
    case 'boolean':
      return { type: 'boolean' };
    case 'decimal':
    case 'numeric':
    case 'number':
    case 'dec':
      return {
        type: 'decimal',
        ...(first === undefined ? {} : { maxDigits: first }),
        ...(first === undefined ? {} : { decimalPlaces: second ?? 0 }),
      };
    case 'money':
    case 'smallmoney':
      return { type: 'decimal' };
    case 'float':
    case 'float4':
    case 'float8':
    case 'real':
    case 'double':
    case 'double precision':
      return { type: 'float' };
    case 'datetime':
    case 'datetime2':
    case 'datetimeoffset':
    case 'smalldatetime':
    case 'timestamp':
    case 'timestamptz':
    case 'timestamp with time zone':
    case 'timestamp without time zone':
      return { type: 'dateTime' };
    case 'date':
      return { type: 'date' };
    case 'time':
    case 'timetz':
    case 'time with time zone':
    case 'time without time zone':
      return { type: 'time' };
    case 'interval':
      return { type: 'duration' };
    case 'uuid':
    case 'uniqueidentifier':
      return { type: 'uuid' };
    case 'json':
    case 'jsonb':
      return { type: 'json' };
    case 'bytea':
    case 'blob':
    case 'tinyblob':
    case 'mediumblob':
    case 'longblob':
    case 'binary':
    case 'varbinary':
    case 'image':
    case 'rowversion':
      return { type: 'bytes' };
    case 'inet':
      return { type: 'ipAddress' };
    case 'hstore':
      return { type: 'hstore' };
    default:
      return undefined;
  }
}

const NOW_SQL: RegExp =
  /^\(?(now\(\)|current_timestamp(\(\d*\))?|localtimestamp(\(\d*\))?|transaction_timestamp\(\)|sysdatetime\(\)|sysutcdatetime\(\)|sysdatetimeoffset\(\)|getdate\(\)|getutcdate\(\)|datetime\('now'\)|strftime\(.*'now'.*\))\)?$/i;
const UUID_SQL: RegExp =
  /^\(?(uuid_generate_v[14]\(\)|gen_random_uuid\(\)|uuid\(\)|newid\(\)|newsequentialid\(\))\)?$/i;

function stripQuotes(text: string): string {
  const quoted: RegExpMatchArray | null = text.match(
    /^N?'((?:[^']|'')*)'(?:::[\w\s]+)?$/
  );
  return quoted === null ? text : (quoted[1] ?? '').replace(/''/g, "'");
}

/** Interprets the text of HasDefaultValueSql(...) / a computed or generated default. */
export function sqlDefault(raw: string, type: IrScalarType): IrDefault {
  let text: string = raw.trim();
  // Wrapping parentheses, as SQL Server stores defaults: ((0)).
  while (/^\(.*\)$/.test(text) && !/^\([^()]*\)\s*\(/.test(text)) {
    const inner: string = text.slice(1, -1).trim();
    if (inner === '' || !balanced(inner)) {
      break;
    }
    text = inner;
  }
  if (UUID_SQL.test(text)) {
    return { kind: 'uuid' };
  }
  if (NOW_SQL.test(text) || /^current_(date|time)$/i.test(text)) {
    return { kind: 'now' };
  }
  const unquoted: string = stripQuotes(text);
  const isQuoted: boolean = unquoted !== text;
  if (type === 'boolean') {
    if (/^(1|true|b'1')$/i.test(unquoted)) {
      return { kind: 'literal', value: true };
    }
    if (/^(0|false|b'0')$/i.test(unquoted)) {
      return { kind: 'literal', value: false };
    }
  }
  if (
    (type === 'int' ||
      type === 'bigInt' ||
      type === 'float' ||
      type === 'decimal') &&
    /^-?\d+(\.\d+)?$/.test(unquoted)
  ) {
    return { kind: 'literal', value: Number(unquoted) };
  }
  if (isQuoted && type !== 'json') {
    return { kind: 'literal', value: unquoted };
  }
  if (isQuoted && type === 'json') {
    return { kind: 'literal', value: unquoted };
  }
  return { kind: 'dbExpression', expression: text };
}

function balanced(text: string): boolean {
  let depth: number = 0;
  for (const character of text) {
    if (character === '(') {
      depth += 1;
    } else if (character === ')') {
      depth -= 1;
      if (depth < 0) {
        return false;
      }
    }
  }
  return depth === 0;
}
