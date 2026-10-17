import type { IrOnDelete } from '../ir.js';
import type { JavaType } from './javaSyntax.js';
import type { ColumnShape } from './efcoreTypes.js';

/** Java types that are not objects: their columns are NOT NULL. */
const PRIMITIVES: ReadonlySet<string> = new Set([
  'int',
  'long',
  'short',
  'byte',
  'boolean',
  'float',
  'double',
  'char',
]);

export function isPrimitive(type: JavaType): boolean {
  return type.arrayDepth === 0 && PRIMITIVES.has(type.name);
}

const INTEGER_TYPES: ReadonlySet<string> = new Set([
  'int',
  'Integer',
  'short',
  'Short',
  'byte',
  'Byte',
  'long',
  'Long',
]);

/** True for the integer types an identity or sequence key can have. */
export function isIntegerType(type: JavaType): boolean {
  return type.arrayDepth === 0 && INTEGER_TYPES.has(type.name);
}

const COLLECTIONS: ReadonlySet<string> = new Set([
  'List',
  'Set',
  'Collection',
  'SortedSet',
  'NavigableSet',
  'ArrayList',
  'LinkedList',
  'HashSet',
  'LinkedHashSet',
  'TreeSet',
  'Iterable',
]);

export function isCollectionType(type: JavaType): boolean {
  return type.arrayDepth === 0 && COLLECTIONS.has(type.name);
}

export function isMapType(type: JavaType): boolean {
  return (
    type.arrayDepth === 0 &&
    /^(Map|HashMap|LinkedHashMap|TreeMap|SortedMap|SortedMap)$/.test(type.name)
  );
}

/** The element type of a collection or array, or undefined for other types. */
export function elementOf(type: JavaType): JavaType | undefined {
  if (type.arrayDepth > 0) {
    return { ...type, arrayDepth: type.arrayDepth - 1 };
  }
  return isCollectionType(type) ? type.args[0] : undefined;
}

const SIMPLE_SHAPES: Readonly<Record<string, ColumnShape>> = {
  String: { type: 'string', maxLength: 255 },
  char: { type: 'string', maxLength: 1 },
  Character: { type: 'string', maxLength: 1 },
  int: { type: 'int' },
  Integer: { type: 'int' },
  short: { type: 'int' },
  Short: { type: 'int' },
  byte: { type: 'int' },
  Byte: { type: 'int' },
  long: { type: 'bigInt' },
  Long: { type: 'bigInt' },
  BigInteger: { type: 'decimal', maxDigits: 38, decimalPlaces: 0 },
  BigDecimal: { type: 'decimal', maxDigits: 38, decimalPlaces: 2 },
  float: { type: 'float' },
  Float: { type: 'float' },
  double: { type: 'float' },
  Double: { type: 'float' },
  boolean: { type: 'boolean' },
  Boolean: { type: 'boolean' },
  LocalDate: { type: 'date' },
  LocalTime: { type: 'time' },
  OffsetTime: { type: 'time' },
  LocalDateTime: { type: 'dateTime' },
  OffsetDateTime: { type: 'dateTime' },
  ZonedDateTime: { type: 'dateTime' },
  Instant: { type: 'dateTime' },
  Timestamp: { type: 'dateTime' },
  Calendar: { type: 'dateTime' },
  GregorianCalendar: { type: 'dateTime' },
  Duration: { type: 'duration' },
  UUID: { type: 'uuid' },
  Blob: { type: 'bytes' },
  Clob: { type: 'text' },
  NClob: { type: 'text' },
  Locale: { type: 'string', maxLength: 255 },
  Currency: { type: 'string', maxLength: 255 },
  TimeZone: { type: 'string', maxLength: 255 },
  ZoneId: { type: 'string', maxLength: 255 },
  URL: { type: 'string', maxLength: 255 },
  Class: { type: 'string', maxLength: 255 },
  InetAddress: { type: 'ipAddress' },
  JsonNode: { type: 'json' },
  ObjectNode: { type: 'json' },
  ArrayNode: { type: 'json' },
  JsonObject: { type: 'json' },
};

/**
 * The column a Java type maps to by default, or undefined when JPA has no default for it (a class of your own,
 * `Object`, a `Map`). `imports` tells `java.sql.Date` from `java.util.Date`.
 */
export function javaColumn(
  type: JavaType,
  imports: readonly string[]
): ColumnShape | undefined {
  if (type.arrayDepth === 1 && /^(byte|Byte)$/.test(type.name)) {
    return { type: 'bytes' };
  }
  if (type.arrayDepth === 1 && type.name === 'char') {
    return { type: 'string', maxLength: 255 };
  }
  if (type.arrayDepth > 0) {
    const inner: ColumnShape | undefined = javaColumn(
      { ...type, arrayDepth: 0 },
      imports
    );
    return inner === undefined
      ? undefined
      : { ...inner, arrayDepth: type.arrayDepth };
  }
  if (type.name === 'Date') {
    return imports.includes('java.sql.Date') || type.text === 'java.sql.Date'
      ? { type: 'date' }
      : { type: 'dateTime' };
  }
  if (type.name === 'Time') {
    return { type: 'time' };
  }
  const shape: ColumnShape | undefined = SIMPLE_SHAPES[type.name];
  if (shape !== undefined) {
    return shape;
  }
  if (isCollectionType(type) && type.args.length === 1) {
    const inner: JavaType | undefined = type.args[0];
    const column: ColumnShape | undefined =
      inner === undefined ? undefined : javaColumn(inner, imports);
    return column === undefined || column.arrayDepth !== undefined
      ? undefined
      : { ...column, arrayDepth: 1 };
  }
  return undefined;
}

/** The column type `@Temporal` selects. */
export function temporalColumn(kind: string): ColumnShape | undefined {
  switch (kind) {
    case 'DATE':
      return { type: 'date' };
    case 'TIME':
      return { type: 'time' };
    case 'TIMESTAMP':
      return { type: 'dateTime' };
    default:
      return undefined;
  }
}

/** The IR type for a `SqlTypes.*` constant of `@JdbcTypeCode`; undefined when it is not one the model knows. */
export function jdbcTypeColumn(name: string): ColumnShape | undefined {
  switch (name) {
    case 'JSON':
    case 'JSON_ARRAY':
      return { type: 'json' };
    case 'UUID':
      return { type: 'uuid' };
    case 'BLOB':
    case 'BINARY':
    case 'VARBINARY':
    case 'LONGVARBINARY':
    case 'LONG32VARBINARY':
      return { type: 'bytes' };
    case 'CLOB':
    case 'NCLOB':
    case 'LONGVARCHAR':
    case 'LONGNVARCHAR':
    case 'LONG32VARCHAR':
    case 'LONG32NVARCHAR':
      return { type: 'text' };
    case 'VARCHAR':
    case 'NVARCHAR':
    case 'CHAR':
    case 'NCHAR':
      return { type: 'string', maxLength: 255 };
    case 'INTEGER':
    case 'SMALLINT':
    case 'TINYINT':
      return { type: 'int' };
    case 'BIGINT':
      return { type: 'bigInt' };
    case 'BOOLEAN':
    case 'BIT':
      return { type: 'boolean' };
    case 'DECIMAL':
    case 'NUMERIC':
      return { type: 'decimal', maxDigits: 38, decimalPlaces: 2 };
    case 'FLOAT':
    case 'REAL':
    case 'DOUBLE':
      return { type: 'float' };
    case 'DATE':
      return { type: 'date' };
    case 'TIME':
      return { type: 'time' };
    case 'TIMESTAMP':
    case 'TIMESTAMP_WITH_TIMEZONE':
    case 'TIMESTAMP_UTC':
      return { type: 'dateTime' };
    case 'INTERVAL_SECOND':
      return { type: 'duration' };
    case 'INET':
      return { type: 'ipAddress' };
    default:
      return undefined;
  }
}

const ON_DELETE: Readonly<Record<string, IrOnDelete>> = {
  CASCADE: 'cascade',
  SET_NULL: 'setNull',
  SET_DEFAULT: 'setDefault',
  RESTRICT: 'restrict',
  NO_ACTION: 'noAction',
};

/** Maps a Hibernate `OnDeleteAction` constant to the referential action. */
export function onDeleteAction(name: string): IrOnDelete | undefined {
  return ON_DELETE[name];
}

/** Lower-cases the first letter: `Post` is `post`, `URL` stays `URL`. */
export function decapitalize(name: string): string {
  if (name.length > 1 && name[0] === name[0]?.toUpperCase()) {
    if (name[1] === name[1]?.toUpperCase() && /[A-Za-z]/.test(name[1] ?? '')) {
      return name;
    }
  }
  return name.charAt(0).toLowerCase() + name.slice(1);
}
