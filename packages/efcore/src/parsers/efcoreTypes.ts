import type { IrOnDelete, IrScalarType } from 'ormbridge';
import type { ColumnShape } from 'ormbridge';

import type { CsType, CsValue } from './csharpSyntax.js';

export { sqlColumn, sqlDefault } from 'ormbridge';
export type { ColumnShape } from 'ormbridge';

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
