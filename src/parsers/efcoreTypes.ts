import type { IrDefault, IrOnDelete, IrScalarType } from '../ir.js';
import type { CsType, CsValue } from './csharpSyntax.js';

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

interface ClrScalar {
  type: IrScalarType;
  /** True for C# value types, whose nullability comes from `?` alone. */
  valueType: boolean;
  maxLength?: number;
}

const CLR_SCALARS: Readonly<Record<string, ClrScalar>> = {
  int: { type: 'int', valueType: true },
  Int32: { type: 'int', valueType: true },
  uint: { type: 'int', valueType: true },
  UInt32: { type: 'int', valueType: true },
  short: { type: 'int', valueType: true },
  Int16: { type: 'int', valueType: true },
  ushort: { type: 'int', valueType: true },
  UInt16: { type: 'int', valueType: true },
  byte: { type: 'int', valueType: true },
  Byte: { type: 'int', valueType: true },
  sbyte: { type: 'int', valueType: true },
  SByte: { type: 'int', valueType: true },
  long: { type: 'bigInt', valueType: true },
  Int64: { type: 'bigInt', valueType: true },
  ulong: { type: 'bigInt', valueType: true },
  UInt64: { type: 'bigInt', valueType: true },
  bool: { type: 'boolean', valueType: true },
  Boolean: { type: 'boolean', valueType: true },
  string: { type: 'text', valueType: false },
  String: { type: 'text', valueType: false },
  char: { type: 'string', valueType: true, maxLength: 1 },
  Char: { type: 'string', valueType: true, maxLength: 1 },
  decimal: { type: 'decimal', valueType: true },
  Decimal: { type: 'decimal', valueType: true },
  double: { type: 'float', valueType: true },
  Double: { type: 'float', valueType: true },
  float: { type: 'float', valueType: true },
  Single: { type: 'float', valueType: true },
  Half: { type: 'float', valueType: true },
  DateTime: { type: 'dateTime', valueType: true },
  DateTimeOffset: { type: 'dateTime', valueType: true },
  DateOnly: { type: 'date', valueType: true },
  TimeOnly: { type: 'time', valueType: true },
  TimeSpan: { type: 'duration', valueType: true },
  Guid: { type: 'uuid', valueType: true },
  JsonDocument: { type: 'json', valueType: false },
  JsonElement: { type: 'json', valueType: true },
  JsonNode: { type: 'json', valueType: false },
  JsonObject: { type: 'json', valueType: false },
  JsonArray: { type: 'json', valueType: false },
  IPAddress: { type: 'ipAddress', valueType: false },
  PhysicalAddress: { type: 'string', valueType: false, maxLength: 17 },
  Uri: { type: 'text', valueType: false },
  Version: { type: 'string', valueType: false },
  CultureInfo: { type: 'string', valueType: false },
};

/** Types that EF providers map to a column but that the shared model has no name for. */
const UNSUPPORTED_CLR: ReadonlySet<string> = new Set([
  'object',
  'Object',
  'BigInteger',
  'BitArray',
  'Point',
  'Polygon',
  'LineString',
  'MultiPoint',
  'MultiPolygon',
  'MultiLineString',
  'Geometry',
  'GeometryCollection',
  'NpgsqlPoint',
  'NpgsqlRange',
  'NpgsqlTsVector',
  'NpgsqlTsQuery',
  'LTree',
  'BitVector32',
  'SqlHierarchyId',
  'HierarchyId',
  'Vector',
  'SqlVector',
]);

const COLLECTION_NAMES: ReadonlySet<string> = new Set([
  'ICollection',
  'IList',
  'List',
  'IEnumerable',
  'HashSet',
  'ISet',
  'IReadOnlyCollection',
  'IReadOnlyList',
  'Collection',
  'ObservableCollection',
  'SortedSet',
  'LinkedList',
  'Queue',
  'Stack',
  'ImmutableList',
  'ImmutableArray',
  'ImmutableHashSet',
]);

/** True for `ICollection<T>`, `List<T>`, `HashSet<T>` and the other collection types. */
export function isCollectionType(type: CsType): boolean {
  return COLLECTION_NAMES.has(type.name) && type.args.length === 1;
}

/** The element type of a collection type, or of an array. */
export function elementType(type: CsType): CsType | undefined {
  if (type.arrayDepth > 0) {
    return { ...type, arrayDepth: type.arrayDepth - 1, nullable: false };
  }
  return isCollectionType(type) ? type.args[0] : undefined;
}

/** True when the C# type is a value type whose nullability needs `?`. */
export function isValueType(
  type: CsType,
  enumNames: ReadonlySet<string>
): boolean {
  if (type.arrayDepth > 0) {
    return false;
  }
  if (enumNames.has(type.name)) {
    return true;
  }
  return CLR_SCALARS[type.name]?.valueType === true;
}

/** True for a type name that maps to a column on its own. */
export function isKnownScalar(
  type: CsType,
  enumNames: ReadonlySet<string>
): boolean {
  if (enumNames.has(type.name)) {
    return true;
  }
  if (type.arrayDepth === 0) {
    return CLR_SCALARS[type.name] !== undefined;
  }
  // byte[] is a binary column; other arrays of scalars are provider arrays.
  const inner: CsType | undefined = elementType(type);
  return inner !== undefined && isKnownScalar(inner, enumNames);
}

/** True for types that are known to map to a column that the model cannot name (spatial types and so on). */
export function isKnownUnsupported(type: CsType): boolean {
  return UNSUPPORTED_CLR.has(type.name);
}

/** Maps a CLR type (nullable markers removed) to a column. Enums are handled by the caller. */
export function clrColumn(type: CsType): ColumnShape | undefined {
  if (type.arrayDepth === 1 && (type.name === 'byte' || type.name === 'Byte')) {
    return { type: 'bytes' };
  }
  if (type.arrayDepth > 0) {
    const inner: ColumnShape | undefined = clrColumn({
      ...type,
      arrayDepth: type.arrayDepth - 1,
    });
    return inner === undefined
      ? undefined
      : { ...inner, arrayDepth: (inner.arrayDepth ?? 0) + 1 };
  }
  if (isCollectionType(type)) {
    const first: CsType | undefined = type.args[0];
    const inner: ColumnShape | undefined =
      first === undefined ? undefined : clrColumn(first);
    return inner === undefined
      ? undefined
      : { ...inner, arrayDepth: (inner.arrayDepth ?? 0) + 1 };
  }
  if (type.name === 'Dictionary' || type.name === 'IDictionary') {
    return { type: 'hstore' };
  }
  const known: ClrScalar | undefined = CLR_SCALARS[type.name];
  if (known === undefined) {
    return undefined;
  }
  return {
    type: known.type,
    ...(known.maxLength === undefined ? {} : { maxLength: known.maxLength }),
  };
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

const DELETE_BEHAVIOR: Readonly<Record<string, IrOnDelete>> = {
  Cascade: 'cascade',
  SetNull: 'setNull',
  Restrict: 'restrict',
  NoAction: 'noAction',
  // The client-side behaviors act on tracked entities only; the constraint in the database has no action
  // (checked against the SQL EF Core writes: ON DELETE NO ACTION).
  ClientSetNull: 'noAction',
  ClientCascade: 'noAction',
  ClientNoAction: 'noAction',
};

/** Maps a `DeleteBehavior` member name to the referential action EF Core writes to the database. */
export function deleteBehavior(name: string): IrOnDelete | undefined {
  return DELETE_BEHAVIOR[name];
}

/** The text of a constant value, for messages. */
export function describeValue(value: CsValue): string {
  switch (value.kind) {
    case 'string':
      return JSON.stringify(value.value);
    case 'number':
      return value.text;
    case 'bool':
      return String(value.value);
    case 'null':
      return 'null';
    case 'member':
      return value.path.join('.');
    case 'nameof':
      return `nameof(${value.name})`;
    case 'typeof':
      return `typeof(${value.type})`;
    case 'array':
      return '[...]';
    case 'other':
      return value.text;
  }
}
