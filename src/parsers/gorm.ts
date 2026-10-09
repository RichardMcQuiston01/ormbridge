import type Parser from 'web-tree-sitter';
import type {
  IrCompositeForeignKey,
  IrDefault,
  IrEnum,
  IrEnumValue,
  IrField,
  IrIndex,
  IrIndexFieldOptions,
  IrModel,
  IrOnDelete,
  IrRelation,
  IrScalarType,
  IrSchema,
} from '../ir.js';
import { singularize, toCamelCase, toSnakeCase } from '../naming.js';
import { describeThrown, err, ok, type Result } from '../result.js';
import {
  defaultImportName,
  describeGoType,
  getGoParser,
  lookupStructTag,
  readGoFile,
  type GoConst,
  type GoField,
  type GoFile,
  type GoMethod,
  type GoNamedType,
  type GoStruct,
  type GoType,
} from './goSyntax.js';

export interface GormSourceFile {
  path: string;
  text: string;
}

export interface GormParseOptions {
  /** App label stored on each model (GORM itself has no equivalent). */
  appLabel: string;
}

// ---------------------------------------------------------------------------
// GORM naming conventions (gorm.io/gorm/schema NamingStrategy)
// ---------------------------------------------------------------------------

/** Initialisms GORM keeps together when it converts a Go name to snake_case, in GORM's priority order. */
const COMMON_INITIALISMS: readonly string[] = [
  'API',
  'ASCII',
  'CPU',
  'CSS',
  'DNS',
  'EOF',
  'GUID',
  'HTML',
  'HTTP',
  'HTTPS',
  'ID',
  'IP',
  'JSON',
  'LHS',
  'QPS',
  'RAM',
  'RHS',
  'RPC',
  'SLA',
  'SMTP',
  'SSH',
  'TLS',
  'TTL',
  'UID',
  'UI',
  'UUID',
  'URI',
  'URL',
  'UTF8',
  'VM',
  'XML',
  'XSRF',
  'XSS',
];

const INITIALISM_PATTERN: RegExp = new RegExp(
  COMMON_INITIALISMS.join('|'),
  'g'
);

function isUpperAscii(character: string | undefined): boolean {
  return character !== undefined && character >= 'A' && character <= 'Z';
}

function isDigit(character: string | undefined): boolean {
  return character !== undefined && character >= '0' && character <= '9';
}

/** GORM's default column name for a Go field name: `PublicID` becomes `public_id`. */
export function gormColumnName(goName: string): string {
  if (goName === '') {
    return '';
  }
  const value: string = goName.replace(
    INITIALISM_PATTERN,
    (initialism: string): string =>
      initialism.charAt(0) + initialism.slice(1).toLowerCase()
  );
  let result: string = '';
  let lastIsUpper: boolean = false;
  let currentIsUpper: boolean = isUpperAscii(value.charAt(0));
  for (let index: number = 0; index < value.length - 1; index += 1) {
    const character: string = value.charAt(index);
    const nextIsUpper: boolean = isUpperAscii(value.charAt(index + 1));
    const nextIsDigit: boolean = isDigit(value.charAt(index + 1));
    if (currentIsUpper) {
      if (lastIsUpper && (nextIsUpper || nextIsDigit)) {
        result += character.toLowerCase();
      } else {
        if (
          index > 0 &&
          value.charAt(index - 1) !== '_' &&
          value.charAt(index + 1) !== '_'
        ) {
          result += '_';
        }
        result += character.toLowerCase();
      }
    } else {
      result += character;
    }
    lastIsUpper = currentIsUpper;
    currentIsUpper = nextIsUpper;
  }
  const lastCharacter: string = value.charAt(value.length - 1);
  if (currentIsUpper) {
    if (!lastIsUpper && value.length > 1) {
      result += '_';
    }
    result += lastCharacter.toLowerCase();
  } else {
    result += lastCharacter;
  }
  return result;
}

const UNCOUNTABLE_WORDS: readonly string[] = [
  'equipment',
  'information',
  'rice',
  'money',
  'species',
  'series',
  'fish',
  'sheep',
  'jeans',
  'police',
];

const IRREGULAR_PLURALS: readonly (readonly [string, string])[] = [
  ['person', 'people'],
  ['man', 'men'],
  ['child', 'children'],
  ['sex', 'sexes'],
  ['move', 'moves'],
  ['mombie', 'mombies'],
];

/** The plural rules of github.com/jinzhu/inflection (which GORM uses), in the order they are tried. */
const PLURAL_RULES: readonly (readonly [RegExp, string])[] = [
  [/(quiz)$/, '$1zes'],
  [/^(oxen)$/, '$1'],
  [/^(ox)$/, '$1en'],
  [/^(m|l)ice$/, '$1ice'],
  [/^(m|l)ouse$/, '$1ice'],
  [/(matr|vert|ind)(?:ix|ex)$/, '$1ices'],
  [/(x|ch|ss|sh)$/, '$1es'],
  [/([^aeiouy]|qu)y$/, '$1ies'],
  [/(hive)$/, '$1s'],
  [/(?:([^f])fe|([lr])f)$/, '$1$2ves'],
  [/sis$/, 'ses'],
  [/([ti])a$/, '$1a'],
  [/([ti])um$/, '$1a'],
  [/(buffal|tomat)o$/, '$1oes'],
  [/(bu)s$/, '$1ses'],
  [/(alias|status)$/, '$1es'],
  [/(octop|vir)i$/, '$1i'],
  [/(octop|vir)us$/, '$1i'],
  [/^(ax|test)is$/, '$1es'],
  [/s$/, 's'],
  [/([a-z])$/, '$1s'],
];

function pluralize(word: string): string {
  if (UNCOUNTABLE_WORDS.includes(word.toLowerCase())) {
    return word;
  }
  for (const [singular, plural] of IRREGULAR_PLURALS) {
    if (word.endsWith(singular)) {
      return word.slice(0, word.length - singular.length) + plural;
    }
  }
  for (const [pattern, replacement] of PLURAL_RULES) {
    if (pattern.test(word)) {
      return word.replace(pattern, replacement);
    }
  }
  return word;
}

/** GORM's default table name for a struct: `PostTag` becomes `post_tags`. */
export function gormTableName(structName: string): string {
  return pluralize(gormColumnName(structName));
}

function upperFirst(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** The IR name of a Go field: `PublicID` becomes `publicId`. */
function irFieldName(goName: string): string {
  return toCamelCase(goName);
}

// ---------------------------------------------------------------------------
// Static tables
// ---------------------------------------------------------------------------

const ON_DELETE_MAP: Readonly<Record<string, IrOnDelete>> = {
  CASCADE: 'cascade',
  'SET NULL': 'setNull',
  RESTRICT: 'restrict',
  'NO ACTION': 'noAction',
  'SET DEFAULT': 'setDefault',
};

const NOW_SQL: RegExp =
  /^(now\(\)|current_timestamp(\(\d*\))?|getdate\(\)|sysdate|systimestamp|localtimestamp(\(\d*\))?|datetime\('now'\)|\(datetime\('now'\)\))$/i;
const UUID_SQL: RegExp =
  /^(uuid_generate_v[14]\(\)|gen_random_uuid\(\)|uuid\(\)|\(uuid\(\)\)|newid\(\)|newsequentialid\(\)|sys_guid\(\))$/i;

/** How the Go kind of a field steers defaults, sizes and auto-increment. */
type GoKind = 'bool' | 'int' | 'uint' | 'float' | 'string' | 'time' | 'other';

interface KnownType {
  type: IrScalarType;
  goKind: GoKind;
  nullable?: boolean;
  arrayDepth?: number;
}

/** Library types by `<package>.<Name>`, where the package is the import's last path element. */
const KNOWN_TYPES: Readonly<Record<string, KnownType>> = {
  'time.Time': { type: 'dateTime', goKind: 'time' },
  'time.Duration': { type: 'bigInt', goKind: 'int' },
  'gorm.DeletedAt': { type: 'dateTime', goKind: 'time', nullable: true },
  'sql.NullString': { type: 'text', goKind: 'string', nullable: true },
  'sql.NullInt64': { type: 'bigInt', goKind: 'int', nullable: true },
  'sql.NullInt32': { type: 'int', goKind: 'int', nullable: true },
  'sql.NullInt16': { type: 'int', goKind: 'int', nullable: true },
  'sql.NullByte': { type: 'int', goKind: 'int', nullable: true },
  'sql.NullFloat64': { type: 'float', goKind: 'float', nullable: true },
  'sql.NullBool': { type: 'boolean', goKind: 'bool', nullable: true },
  'sql.NullTime': { type: 'dateTime', goKind: 'time', nullable: true },
  'sql.RawBytes': { type: 'bytes', goKind: 'other' },
  'uuid.UUID': { type: 'uuid', goKind: 'other' },
  'uuid.NullUUID': { type: 'uuid', goKind: 'other', nullable: true },
  'decimal.Decimal': { type: 'decimal', goKind: 'float' },
  'decimal.NullDecimal': { type: 'decimal', goKind: 'float', nullable: true },
  'datatypes.JSON': { type: 'json', goKind: 'other' },
  'datatypes.JSONMap': { type: 'json', goKind: 'other' },
  'datatypes.Date': { type: 'date', goKind: 'time' },
  'datatypes.Time': { type: 'time', goKind: 'time' },
  'datatypes.UUID': { type: 'uuid', goKind: 'other' },
  'datatypes.BinUUID': { type: 'uuid', goKind: 'other' },
  'json.RawMessage': { type: 'json', goKind: 'other' },
  'net.IP': { type: 'ipAddress', goKind: 'other' },
  'netip.Addr': { type: 'ipAddress', goKind: 'other' },
  'pq.StringArray': { type: 'text', goKind: 'string', arrayDepth: 1 },
  'pq.Int64Array': { type: 'bigInt', goKind: 'int', arrayDepth: 1 },
  'pq.Int32Array': { type: 'int', goKind: 'int', arrayDepth: 1 },
  'pq.Float64Array': { type: 'float', goKind: 'float', arrayDepth: 1 },
  'pq.BoolArray': { type: 'boolean', goKind: 'bool', arrayDepth: 1 },
  'pq.ByteaArray': { type: 'bytes', goKind: 'other', arrayDepth: 1 },
  'null.String': { type: 'text', goKind: 'string', nullable: true },
  'null.Int': { type: 'bigInt', goKind: 'int', nullable: true },
  'null.Int32': { type: 'int', goKind: 'int', nullable: true },
  'null.Float': { type: 'float', goKind: 'float', nullable: true },
  'null.Bool': { type: 'boolean', goKind: 'bool', nullable: true },
  'null.Time': { type: 'dateTime', goKind: 'time', nullable: true },
};

/** Generic library types whose single type argument is the stored value. */
const GENERIC_JSON_TYPES: ReadonlySet<string> = new Set([
  'datatypes.JSONType',
  'datatypes.JSONSlice',
]);

interface IntegerKind {
  bits: number;
  unsigned: boolean;
}

const INTEGER_KINDS: Readonly<Record<string, IntegerKind>> = {
  int: { bits: 64, unsigned: false },
  int8: { bits: 8, unsigned: false },
  int16: { bits: 16, unsigned: false },
  int32: { bits: 32, unsigned: false },
  int64: { bits: 64, unsigned: false },
  rune: { bits: 32, unsigned: false },
  uint: { bits: 64, unsigned: true },
  uint8: { bits: 8, unsigned: true },
  byte: { bits: 8, unsigned: true },
  uint16: { bits: 16, unsigned: true },
  uint32: { bits: 32, unsigned: true },
  uint64: { bits: 64, unsigned: true },
  uintptr: { bits: 64, unsigned: true },
};

/** An integer column is `int` up to 32 bits and `bigInt` above; unsigned types need one more bit, as in GORM's PostgreSQL dialect. */
function integerType(bits: number, unsigned: boolean): IrScalarType {
  return bits + (unsigned ? 1 : 0) <= 32 ? 'int' : 'bigInt';
}

// ---------------------------------------------------------------------------
// Struct tags
// ---------------------------------------------------------------------------

interface TagEntry {
  /** Upper-cased and trimmed key, as GORM reads it (`NOT NULL`, `PRIMARYKEY`). */
  key: string;
  value: string;
}

/**
 * Splits a tag into its settings the way GORM's `ParseTagSetting` does: `;` (or `separator`)
 * separates settings, `\;` escapes it, and the first `:` separates key from value.
 */
function parseSettings(text: string, separator: string): TagEntry[] {
  const entries: TagEntry[] = [];
  const names: string[] = text.split(separator);
  for (let position: number = 0; position < names.length; position += 1) {
    let current: string = names[position] ?? '';
    while (current.endsWith('\\') && position + 1 < names.length) {
      position += 1;
      current = current.slice(0, -1) + separator + (names[position] ?? '');
    }
    const parts: string[] = current.split(':');
    const key: string = (parts[0] ?? '').trim().toUpperCase();
    if (parts.length >= 2) {
      entries.push({ key, value: parts.slice(1).join(':') });
    } else if (key !== '') {
      entries.push({ key, value: key });
    }
  }
  return entries;
}

function gormTagOf(field: GoField): string {
  return field.tag === undefined
    ? ''
    : (lookupStructTag(field.tag, 'gorm') ?? '');
}

/** The last value given for any of the keys (GORM keeps the last duplicate). */
function entryValue(
  entries: readonly TagEntry[],
  ...keys: string[]
): string | undefined {
  for (let index: number = entries.length - 1; index >= 0; index -= 1) {
    const entry: TagEntry | undefined = entries[index];
    if (entry !== undefined && keys.includes(entry.key)) {
      return entry.value;
    }
  }
  return undefined;
}

/** True/false when a flag setting is present (`false` turns it off), undefined when absent. */
function entryFlag(
  entries: readonly TagEntry[],
  ...keys: string[]
): boolean | undefined {
  const value: string | undefined = entryValue(entries, ...keys);
  if (value === undefined) {
    return undefined;
  }
  return value !== '' && value.toLowerCase() !== 'false';
}

function entryNumber(
  entries: readonly TagEntry[],
  key: string
): number | undefined {
  const value: string | undefined = entryValue(entries, key);
  if (value === undefined) {
    return undefined;
  }
  const parsed: number = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function splitList(value: string | undefined): string[] {
  return value === undefined
    ? []
    : value
        .split(',')
        .map((item: string) => item.trim())
        .filter((item: string) => item !== '');
}

/** `gorm:"-"`, `-:all` and `-:migration` leave the field out of the schema. */
function isIgnored(entries: readonly TagEntry[]): boolean {
  const value: string | undefined = entryValue(entries, '-');
  return (
    value !== undefined &&
    ['-', 'all', 'migration'].includes(value.toLowerCase())
  );
}

// ---------------------------------------------------------------------------
// Intermediate structures
// ---------------------------------------------------------------------------

interface EnumInfo {
  name: string;
  backing: 'string' | 'int';
  values: IrEnumValue[];
}

/** A scalar Go type mapped to a column type. */
interface ScalarClass {
  kind: 'scalar';
  type: IrScalarType;
  goKind: GoKind;
  nullable: boolean;
  bits?: number;
  unsigned?: boolean;
  arrayDepth?: number;
  enumInfo?: EnumInfo;
  /** Set for an integer type that has named constants (an integer-backed enum). */
  intEnumName?: string;
  isSoftDelete?: boolean;
  /** Go type text of an unsupported scalar. */
  unsupportedType?: string;
  /** What the column type depends on when no `type:` or `serializer:` tag settles it: "slice", "map" or "scanner". */
  needsHint?: string;
}

interface AssociationClass {
  kind: 'association';
  target: string;
  many: boolean;
}

interface SkippedClass {
  kind: 'skip';
  message?: string;
}

type TypeClass = ScalarClass | AssociationClass | SkippedClass;

interface RawIndexTag {
  /** `index` or `uniqueIndex`. */
  isUnique: boolean;
  name: string | undefined;
  composite: string | undefined;
  priority: number;
  sort: 'asc' | 'desc' | undefined;
  length: number | undefined;
  kind: 'fulltext' | undefined;
  method: string | undefined;
  hasWhere: boolean;
  hasExpression: boolean;
}

interface ColumnMember {
  kind: 'column';
  /** The Go field name, which foreign-key tags refer to. */
  goName: string;
  field: IrField;
  entries: TagEntry[];
  indexTags: RawIndexTag[];
  isPrimary: boolean;
  /** Explicit `autoIncrement` / `autoIncrement:false`; undefined when not written. */
  autoIncrementTag: boolean | undefined;
  goKind: GoKind;
  /** Nesting depth of the struct that declares the field (0 for the model itself). */
  depth: number;
}

interface AssociationMember {
  kind: 'association';
  goName: string;
  irName: string;
  /** Target struct name. */
  target: string;
  many: boolean;
  entries: TagEntry[];
  depth: number;
}

type Member = ColumnMember | AssociationMember;

interface RawModel {
  name: string;
  struct: GoStruct;
  tableName: string;
  members: Member[];
  primaryMembers: ColumnMember[];
  /** Index of the first model-level source file, used for ordering messages. */
  softDeleteField: string | undefined;
}

interface ParseContext {
  warnings: string[];
  structs: Map<string, GoStruct>;
  namedTypes: Map<string, GoNamedType>;
  enums: Map<string, EnumInfo>;
  /** Methods by receiver type name, then method name. */
  methods: Map<string, Map<string, GoMethod>>;
  consts: Map<string, GoConst>;
  /** Names of the structs read as models. */
  models: Set<string>;
}

/** The `gorm.Model` struct that GORM provides for embedding. */
const GORM_MODEL: GoStruct = {
  name: 'Model',
  path: 'gorm.io/gorm',
  fields: [
    {
      name: 'ID',
      type: { kind: 'name', name: 'uint', args: [] },
      tag: 'gorm:"primarykey"',
    },
    {
      name: 'CreatedAt',
      type: {
        kind: 'name',
        name: 'Time',
        qualifier: 'time',
        importPath: 'time',
        args: [],
      },
    },
    {
      name: 'UpdatedAt',
      type: {
        kind: 'name',
        name: 'Time',
        qualifier: 'time',
        importPath: 'time',
        args: [],
      },
    },
    {
      name: 'DeletedAt',
      type: {
        kind: 'name',
        name: 'DeletedAt',
        qualifier: 'gorm',
        importPath: 'gorm.io/gorm',
        args: [],
      },
      tag: 'gorm:"index"',
    },
  ],
};

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/** Parses GORM model structs (Go source with `gorm:"..."` tags) into the shared IR using tree-sitter. */
export async function parseGorm(
  sources: GormSourceFile[],
  options: GormParseOptions
): Promise<Result<IrSchema>> {
  const parserResult: Result<Parser> = await getGoParser();
  if (!parserResult.ok) {
    return parserResult;
  }
  try {
    return readGorm(parserResult.value, sources, options);
  } catch (thrown) {
    return err(
      'PARSE_FAILED',
      `Failed to read GORM models from ${sources.map((source: GormSourceFile) => source.path).join(', ')}. ` +
        `Underlying error: ${describeThrown(thrown)}`
    );
  }
}

function readGorm(
  parser: Parser,
  sources: GormSourceFile[],
  options: GormParseOptions
): Result<IrSchema> {
  const warnings: string[] = [];
  const ctx: ParseContext = {
    warnings,
    structs: new Map(),
    namedTypes: new Map(),
    enums: new Map(),
    methods: new Map(),
    consts: new Map(),
    models: new Set(),
  };
  const structOrder: GoStruct[] = [];
  const constList: GoConst[] = [];

  for (const source of sources) {
    // The Go grammar needs the final statement to end in a newline, which Go inserts as a semicolon.
    const tree: Parser.Tree = parser.parse(
      source.text.endsWith('\n') ? source.text : `${source.text}\n`
    );
    const file: GoFile = readGoFile(tree.rootNode, source.path);
    if (file.hasErrors) {
      warnings.push(
        `${source.path}: the file contains Go syntax errors; some structs or fields may be missing from the output.`
      );
    }
    for (const goStruct of file.structs) {
      if (ctx.structs.has(goStruct.name)) {
        warnings.push(
          `Duplicate struct name "${goStruct.name}" (${source.path}); only the first definition was converted.`
        );
        continue;
      }
      ctx.structs.set(goStruct.name, goStruct);
      structOrder.push(goStruct);
    }
    for (const namedType of file.namedTypes) {
      if (!ctx.namedTypes.has(namedType.name)) {
        ctx.namedTypes.set(namedType.name, namedType);
      }
    }
    for (const goConst of file.consts) {
      constList.push(goConst);
      if (!ctx.consts.has(goConst.name)) {
        ctx.consts.set(goConst.name, goConst);
      }
    }
    for (const method of file.methods) {
      const byName: Map<string, GoMethod> =
        ctx.methods.get(method.receiver) ?? new Map();
      byName.set(method.name, method);
      ctx.methods.set(method.receiver, byName);
    }
  }

  buildEnums(ctx, constList);
  ctx.models = detectModels(structOrder, ctx);

  const rawModels: RawModel[] = structOrder
    .filter((goStruct: GoStruct) => ctx.models.has(goStruct.name))
    .map((goStruct: GoStruct): RawModel => buildRawModel(goStruct, ctx));

  if (rawModels.length === 0) {
    const checkedPaths: string = sources
      .map((source: GormSourceFile) => source.path)
      .join(', ');
    return err(
      'NO_MODELS_FOUND',
      `No GORM models were found in: ${checkedPaths}. A model is a struct that embeds gorm.Model, has a field with a ` +
        `gorm:"..." tag, has a field called ID, has a TableName() method, or is the target of an association from another model.`
    );
  }

  const schema: IrSchema = buildSchema(rawModels, ctx, options);
  return ok(schema);
}

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

/** `StatusDraft` of type `Status` is the enum member `Draft`. */
function enumMemberName(constName: string, typeName: string): string {
  if (constName.startsWith(typeName) && constName.length > typeName.length) {
    const rest: string = constName.slice(typeName.length).replace(/^_/, '');
    if (/^[A-Z0-9]/.test(rest)) {
      return rest;
    }
  }
  return constName;
}

/** Named string and integer types with typed constants become enums. */
function buildEnums(ctx: ParseContext, constList: GoConst[]): void {
  for (const namedType of ctx.namedTypes.values()) {
    const underlying: GoType = namedType.underlying;
    if (underlying.kind !== 'name' || underlying.qualifier !== undefined) {
      continue;
    }
    const members: GoConst[] = constList.filter(
      (candidate: GoConst) =>
        candidate.typeName === namedType.name && candidate.value !== undefined
    );
    if (members.length === 0) {
      continue;
    }
    if (underlying.name === 'string') {
      const values: IrEnumValue[] = [];
      for (const member of members) {
        if (member.value?.kind === 'string') {
          values.push({
            name: enumMemberName(member.name, namedType.name),
            dbValue: member.value.value,
          });
        }
      }
      if (values.length > 0) {
        ctx.enums.set(namedType.name, {
          name: namedType.name,
          backing: 'string',
          values,
        });
      }
    } else if (underlying.name in INTEGER_KINDS) {
      ctx.enums.set(namedType.name, {
        name: namedType.name,
        backing: 'int',
        values: [],
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Which structs are models
// ---------------------------------------------------------------------------

/** The struct an embedded field refers to, including GORM's own `gorm.Model`. */
function embeddedStruct(type: GoType, ctx: ParseContext): GoStruct | undefined {
  let current: GoType = type;
  while (current.kind === 'pointer') {
    current = current.elem;
  }
  if (current.kind !== 'name') {
    return undefined;
  }
  if (current.name === 'Model' && libraryName(current) === 'gorm') {
    return GORM_MODEL;
  }
  return ctx.structs.get(current.name);
}

/** The name of the package a qualified type comes from: the last import path element, or the qualifier as written. */
function libraryName(type: GoType): string {
  if (type.kind !== 'name' || type.qualifier === undefined) {
    return '';
  }
  return type.importPath === undefined
    ? type.qualifier
    : defaultImportName(type.importPath);
}

function isEmbeddedField(field: GoField, entries: TagEntry[]): boolean {
  return field.name === undefined || entryFlag(entries, 'EMBEDDED') === true;
}

/** Every field of a struct including those promoted from embedded structs. */
function promotedFields(
  goStruct: GoStruct,
  ctx: ParseContext,
  visited: Set<string> = new Set()
): GoField[] {
  if (visited.has(goStruct.name)) {
    return [];
  }
  visited.add(goStruct.name);
  const fields: GoField[] = [];
  for (const field of goStruct.fields) {
    const entries: TagEntry[] = parseSettings(gormTagOf(field), ';');
    if (isEmbeddedField(field, entries)) {
      const inner: GoStruct | undefined = embeddedStruct(field.type, ctx);
      if (inner !== undefined) {
        fields.push(...promotedFields(inner, ctx, visited));
      }
    } else {
      fields.push(field);
    }
  }
  return fields;
}

function hasGormMarkers(
  goStruct: GoStruct,
  ctx: ParseContext,
  visited: Set<string> = new Set()
): boolean {
  if (visited.has(goStruct.name)) {
    return false;
  }
  visited.add(goStruct.name);
  for (const field of goStruct.fields) {
    const entries: TagEntry[] = parseSettings(gormTagOf(field), ';');
    if (entries.length > 0 && !isIgnored(entries)) {
      return true;
    }
    if (field.name === undefined) {
      const inner: GoStruct | undefined = embeddedStruct(field.type, ctx);
      if (inner === GORM_MODEL) {
        return true;
      }
      if (inner !== undefined && hasGormMarkers(inner, ctx, visited)) {
        return true;
      }
    }
  }
  return false;
}

/** GORM treats a field called ID as the primary key, so a struct that has one is shaped like a model. */
function hasIdField(goStruct: GoStruct, ctx: ParseContext): boolean {
  return promotedFields(goStruct, ctx).some(
    (field: GoField) => field.name === 'ID' || field.name === 'Id'
  );
}

function implementsScanner(name: string, ctx: ParseContext): boolean {
  const methods: Map<string, GoMethod> | undefined = ctx.methods.get(name);
  return methods?.has('Scan') === true && methods.has('Value');
}

/** The struct a field's type refers to through pointers and slices, when it is one of the input structs. */
function referencedStruct(
  type: GoType,
  ctx: ParseContext
): GoStruct | undefined {
  let current: GoType = type;
  while (
    current.kind === 'pointer' ||
    current.kind === 'slice' ||
    current.kind === 'array'
  ) {
    current = current.elem;
  }
  if (current.kind !== 'name') {
    return undefined;
  }
  if (
    current.qualifier !== undefined &&
    `${libraryName(current)}.${current.name}` in KNOWN_TYPES
  ) {
    return undefined;
  }
  const found: GoStruct | undefined = ctx.structs.get(current.name);
  return found === undefined || implementsScanner(found.name, ctx)
    ? undefined
    : found;
}

/**
 * GORM has no marker for a model, so a struct counts as one when it embeds gorm.Model, has a
 * `gorm:"..."` tag, has a field called ID, has a TableName() method, or is the target of an
 * association from a model. A struct that is only embedded in others (a shared base) is not a
 * model of its own.
 */
function detectModels(structs: GoStruct[], ctx: ParseContext): Set<string> {
  const embeddedNames: Set<string> = new Set();
  for (const goStruct of structs) {
    for (const field of goStruct.fields) {
      const entries: TagEntry[] = parseSettings(gormTagOf(field), ';');
      if (isEmbeddedField(field, entries)) {
        const inner: GoStruct | undefined = embeddedStruct(field.type, ctx);
        if (inner !== undefined) {
          embeddedNames.add(inner.name);
        }
      }
    }
  }
  const models: Set<string> = new Set();
  for (const goStruct of structs) {
    const hasTableName: boolean =
      ctx.methods.get(goStruct.name)?.has('TableName') === true;
    const isMarked: boolean =
      hasTableName ||
      hasIdField(goStruct, ctx) ||
      hasGormMarkers(goStruct, ctx);
    if (isMarked && (hasTableName || !embeddedNames.has(goStruct.name))) {
      models.add(goStruct.name);
    }
  }
  // Association targets are models too, even without any marker of their own.
  let changed: boolean = true;
  while (changed) {
    changed = false;
    for (const name of [...models]) {
      const goStruct: GoStruct | undefined = ctx.structs.get(name);
      if (goStruct === undefined) {
        continue;
      }
      for (const field of promotedFields(goStruct, ctx)) {
        const entries: TagEntry[] = parseSettings(gormTagOf(field), ';');
        if (
          field.name === undefined ||
          isIgnored(entries) ||
          entryValue(entries, 'TYPE', 'SERIALIZER') !== undefined
        ) {
          continue;
        }
        const target: GoStruct | undefined = referencedStruct(field.type, ctx);
        if (target !== undefined && !models.has(target.name)) {
          models.add(target.name);
          changed = true;
        }
      }
    }
  }
  return models;
}

// ---------------------------------------------------------------------------
// Go types to column types
// ---------------------------------------------------------------------------

function classifyType(
  type: GoType,
  ctx: ParseContext,
  depth: number = 0
): TypeClass {
  let nullable: boolean = false;
  let current: GoType = type;
  while (current.kind === 'pointer') {
    nullable = true;
    current = current.elem;
  }
  switch (current.kind) {
    case 'slice':
    case 'array': {
      let element: GoType = current.elem;
      while (element.kind === 'pointer') {
        element = element.elem;
      }
      if (
        element.kind === 'name' &&
        element.qualifier === undefined &&
        (element.name === 'byte' || element.name === 'uint8')
      ) {
        return { kind: 'scalar', type: 'bytes', goKind: 'other', nullable };
      }
      const inner: TypeClass = classifyType(current.elem, ctx, depth + 1);
      if (inner.kind === 'association') {
        return { ...inner, many: true };
      }
      if (inner.kind === 'skip') {
        return inner;
      }
      return {
        ...inner,
        nullable,
        arrayDepth: (inner.arrayDepth ?? 0) + 1,
        needsHint: 'slice',
      };
    }
    case 'map':
      return {
        kind: 'scalar',
        type: 'json',
        goKind: 'other',
        nullable,
        needsHint: 'map',
      };
    case 'struct':
      return {
        kind: 'skip',
        message:
          'an inline struct type has no column mapping (declare a named struct and embed it)',
      };
    case 'other':
      return { kind: 'skip' };
    case 'name':
      return classifyNamed(current, nullable, ctx, depth);
    default:
      return { kind: 'skip' };
  }
}

function classifyNamed(
  type: GoType & { kind: 'name' },
  nullable: boolean,
  ctx: ParseContext,
  depth: number
): TypeClass {
  const qualified: boolean =
    type.qualifier !== undefined && type.qualifier !== '';
  if (qualified) {
    const key: string = `${libraryName(type)}.${type.name}`;
    const known: KnownType | undefined = KNOWN_TYPES[key];
    if (known !== undefined) {
      return {
        kind: 'scalar',
        type: known.type,
        goKind: known.goKind,
        nullable: nullable || known.nullable === true,
        ...(known.arrayDepth === undefined
          ? {}
          : { arrayDepth: known.arrayDepth }),
        ...(key === 'gorm.DeletedAt' ? { isSoftDelete: true } : {}),
      };
    }
    if (GENERIC_JSON_TYPES.has(key)) {
      return { kind: 'scalar', type: 'json', goKind: 'other', nullable };
    }
    if (key === 'sql.Null') {
      const argument: GoType | undefined = type.args[0];
      const inner: TypeClass =
        argument === undefined
          ? { kind: 'skip' }
          : classifyType(argument, ctx, depth + 1);
      return inner.kind === 'scalar' ? { ...inner, nullable: true } : inner;
    }
    // A type from another package of the same project (models.Post) is looked up by name.
    if (!ctx.structs.has(type.name) && !ctx.namedTypes.has(type.name)) {
      return {
        kind: 'scalar',
        type: 'unsupported',
        goKind: 'other',
        nullable,
        unsupportedType: describeGoType(type),
      };
    }
  }

  if (!qualified) {
    if (type.name === 'string') {
      return { kind: 'scalar', type: 'text', goKind: 'string', nullable };
    }
    if (type.name === 'bool') {
      return { kind: 'scalar', type: 'boolean', goKind: 'bool', nullable };
    }
    if (type.name === 'float32' || type.name === 'float64') {
      return { kind: 'scalar', type: 'float', goKind: 'float', nullable };
    }
    const integer: IntegerKind | undefined = INTEGER_KINDS[type.name];
    if (integer !== undefined) {
      return {
        kind: 'scalar',
        type: integerType(integer.bits, integer.unsigned),
        goKind: integer.unsigned ? 'uint' : 'int',
        nullable,
        bits: integer.bits,
        unsigned: integer.unsigned,
      };
    }
    if (type.name === 'any' || type.name === 'error') {
      return { kind: 'skip' };
    }
  }

  const namedType: GoNamedType | undefined = ctx.namedTypes.get(type.name);
  if (namedType !== undefined && depth < 8) {
    const underlying: TypeClass = classifyType(
      namedType.underlying,
      ctx,
      depth + 1
    );
    if (underlying.kind !== 'scalar') {
      return underlying;
    }
    const enumInfo: EnumInfo | undefined = ctx.enums.get(type.name);
    return {
      ...underlying,
      nullable: nullable || underlying.nullable,
      ...(enumInfo?.backing === 'string' ? { enumInfo } : {}),
      ...(enumInfo?.backing === 'int' ? { intEnumName: enumInfo.name } : {}),
    };
  }

  const goStruct: GoStruct | undefined = ctx.structs.get(type.name);
  if (goStruct !== undefined) {
    if (implementsScanner(goStruct.name, ctx)) {
      return {
        kind: 'scalar',
        type: 'unsupported',
        goKind: 'other',
        nullable,
        unsupportedType: goStruct.name,
        needsHint: 'scanner',
      };
    }
    return { kind: 'association', target: goStruct.name, many: false };
  }

  return {
    kind: 'scalar',
    type: 'unsupported',
    goKind: 'other',
    nullable,
    unsupportedType: describeGoType(type),
  };
}

interface DbType {
  type: IrScalarType;
  maxLength?: number;
  maxDigits?: number;
  decimalPlaces?: number;
  arrayDepth?: number;
  isSerial?: boolean;
  /** The type text when it has no equivalent in the shared model. */
  unsupportedType?: string;
}

/** Maps a `type:` tag (a SQL type such as `varchar(100)` or `numeric(10,2)`) to a column type. */
function readDbType(raw: string): DbType {
  let text: string = raw.trim().toLowerCase().replace(/\s+/g, ' ');
  let arrayDepth: number = 0;
  while (text.endsWith('[]')) {
    arrayDepth += 1;
    text = text.slice(0, -2).trim();
  }
  const argumentMatch: RegExpMatchArray | null = text.match(/\(([^)]*)\)/);
  const args: string[] = (argumentMatch?.[1] ?? '')
    .split(',')
    .map((item: string) => item.trim())
    .filter((item: string) => item !== '');
  const base: string = text
    .replace(/\([^)]*\)/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const first: number | undefined =
    args[0] !== undefined && /^\d+$/.test(args[0])
      ? Number.parseInt(args[0], 10)
      : undefined;
  const second: number | undefined =
    args[1] !== undefined && /^\d+$/.test(args[1])
      ? Number.parseInt(args[1], 10)
      : undefined;
  const withArray = (result: DbType): DbType =>
    arrayDepth > 0 ? { ...result, arrayDepth } : result;

  if (
    /^(varchar|character varying|nvarchar|varchar2|nvarchar2|char|character|nchar|bpchar)\b/.test(
      base
    )
  ) {
    return withArray({
      type: 'string',
      ...(first === undefined ? {} : { maxLength: first }),
    });
  }
  if (/^(text|tinytext|mediumtext|longtext|ntext|clob|citext)$/.test(base)) {
    return withArray({ type: 'text' });
  }
  if (/^(bool|boolean)$/.test(base) || (base === 'tinyint' && first === 1)) {
    return withArray({ type: 'boolean' });
  }
  if (/^bit$/.test(base) && (first === undefined || first === 1)) {
    return withArray({ type: 'boolean' });
  }
  if (/^(bigint|int8|bigserial|serial8)( unsigned)?$/.test(base)) {
    return withArray({
      type: 'bigInt',
      ...(base.includes('serial') ? { isSerial: true } : {}),
    });
  }
  if (
    /^(smallint|int2|tinyint|mediumint|integer|int|int4|serial|serial4|smallserial|serial2)( unsigned)?$/.test(
      base
    )
  ) {
    return withArray({
      type: 'int',
      ...(base.includes('serial') ? { isSerial: true } : {}),
    });
  }
  if (/^(numeric|decimal|dec|number|money)$/.test(base)) {
    return withArray({
      type: 'decimal',
      ...(first === undefined ? {} : { maxDigits: first }),
      ...(second === undefined ? {} : { decimalPlaces: second }),
    });
  }
  if (
    /^(real|float|float4|float8|double precision|double|binary_float|binary_double)$/.test(
      base
    )
  ) {
    return withArray({ type: 'float' });
  }
  if (
    /^(timestamp|timestamptz|datetime|datetime2|smalldatetime|datetimeoffset)\b/.test(
      base
    )
  ) {
    return withArray({ type: 'dateTime' });
  }
  if (base === 'date') {
    return withArray({ type: 'date' });
  }
  if (/^time\b/.test(base) || base === 'timetz') {
    return withArray({ type: 'time' });
  }
  if (base === 'interval') {
    return withArray({ type: 'duration' });
  }
  if (base === 'uuid' || base === 'uniqueidentifier') {
    return withArray({ type: 'uuid' });
  }
  if (base === 'json' || base === 'jsonb') {
    return withArray({ type: 'json' });
  }
  if (
    /^(bytea|blob|tinyblob|mediumblob|longblob|varbinary|binary|image|raw)$/.test(
      base
    )
  ) {
    return withArray({ type: 'bytes' });
  }
  if (base === 'inet' || base === 'cidr') {
    return withArray({ type: 'ipAddress' });
  }
  if (base === 'hstore') {
    return withArray({ type: 'hstore' });
  }
  return withArray({ type: 'unsupported', unsupportedType: raw.trim() });
}

// ---------------------------------------------------------------------------
// Columns
// ---------------------------------------------------------------------------

function parseIndexTags(tagText: string): RawIndexTag[] {
  const indexTags: RawIndexTag[] = [];
  for (const piece of tagText.split(';')) {
    if (piece === '') {
      continue;
    }
    const parts: string[] = piece.split(':');
    const key: string = (parts[0] ?? '').trim().toUpperCase();
    if (key !== 'INDEX' && key !== 'UNIQUEINDEX') {
      continue;
    }
    const tag: string = parts.slice(1).join(':');
    const comma: number = tag.indexOf(',');
    const name: string = comma === -1 ? tag : tag.slice(0, comma);
    const settings: TagEntry[] = parseSettings(
      comma === -1 ? '' : tag.slice(comma + 1),
      ','
    );
    const className: string = (
      entryValue(settings, 'CLASS') ?? ''
    ).toUpperCase();
    const priority: number = entryNumber(settings, 'PRIORITY') ?? 10;
    const sort: string = (entryValue(settings, 'SORT') ?? '').toLowerCase();
    const method: string = entryValue(settings, 'TYPE') ?? '';
    const composite: string | undefined = entryValue(settings, 'COMPOSITE');
    indexTags.push({
      isUnique:
        key === 'UNIQUEINDEX' ||
        entryValue(settings, 'UNIQUE') !== undefined ||
        className === 'UNIQUE',
      name: name === '' ? undefined : name,
      composite,
      priority,
      sort: sort === 'desc' ? 'desc' : sort === 'asc' ? 'asc' : undefined,
      length: entryNumber(settings, 'LENGTH'),
      kind: className === 'FULLTEXT' ? 'fulltext' : undefined,
      method: method === '' ? undefined : method,
      hasWhere: entryValue(settings, 'WHERE') !== undefined,
      hasExpression: entryValue(settings, 'EXPRESSION') !== undefined,
    });
  }
  return indexTags;
}

const INDEX_METHODS: Readonly<Record<string, string>> = {
  btree: 'BTree',
  hash: 'Hash',
  gin: 'Gin',
  gist: 'Gist',
  spgist: 'SpGist',
  brin: 'Brin',
};

function stripQuotes(value: string): string {
  const trimmed: string = value.trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith("'") && trimmed.endsWith("'")) ||
      (trimmed.startsWith('"') && trimmed.endsWith('"')))
  ) {
    return trimmed.slice(1, -1).replace(/''/g, "'");
  }
  return trimmed;
}

function isQuoted(value: string): boolean {
  return stripQuotes(value) !== value.trim();
}

/** Converts the value of a `default:` tag. Returns undefined when the column has no default. */
function convertDefault(
  raw: string,
  field: IrField,
  enumInfo: EnumInfo | undefined,
  location: string,
  ctx: ParseContext
): IrDefault | undefined {
  const trimmed: string = raw.trim();
  if (trimmed === '' || trimmed.toLowerCase() === 'null' || trimmed === '(-)') {
    return undefined;
  }
  if (enumInfo !== undefined) {
    const text: string = stripQuotes(trimmed);
    const member: IrEnumValue | undefined = enumInfo.values.find(
      (candidate: IrEnumValue) => candidate.dbValue === text
    );
    if (member !== undefined) {
      return { kind: 'enumValue', value: member.name };
    }
    ctx.warnings.push(
      `${location}: the default "${text}" is not a value of the enum "${enumInfo.name}"; it was kept as a literal.`
    );
    return { kind: 'literal', value: text };
  }
  // A function call (or any expression with parentheses) is passed to the database as written.
  if (!isQuoted(trimmed) && trimmed.includes('(') && trimmed.includes(')')) {
    if (UUID_SQL.test(trimmed)) {
      return { kind: 'uuid' };
    }
    if (NOW_SQL.test(trimmed)) {
      return { kind: 'now' };
    }
    return { kind: 'dbExpression', expression: trimmed };
  }
  const unquoted: string = stripQuotes(trimmed);
  switch (field.type) {
    case 'boolean':
      if (/^(1|t|true)$/i.test(unquoted)) {
        return { kind: 'literal', value: true };
      }
      if (/^(0|f|false)$/i.test(unquoted)) {
        return { kind: 'literal', value: false };
      }
      break;
    case 'int':
    case 'bigInt':
    case 'float':
    case 'decimal':
      if (/^-?\d+(\.\d+)?$/.test(unquoted)) {
        return { kind: 'literal', value: Number(unquoted) };
      }
      return { kind: 'dbExpression', expression: trimmed };
    case 'dateTime':
    case 'date':
    case 'time':
      if (NOW_SQL.test(unquoted) || /^current_(date|time)$/i.test(unquoted)) {
        return { kind: 'now' };
      }
      break;
    case 'uuid':
      if (UUID_SQL.test(unquoted)) {
        return { kind: 'uuid' };
      }
      break;
    default:
      break;
  }
  return { kind: 'literal', value: unquoted };
}

interface ColumnContext {
  ctx: ParseContext;
  /** Prefix of the column names (`embeddedPrefix`). */
  columnPrefix: string;
  /** Prefix of the IR names, in PascalCase. */
  namePrefix: string;
  depth: number;
}

/** Builds the column for a scalar field, or undefined when the field is not stored. */
function buildColumn(
  structName: string,
  goField: GoField & { name: string },
  entries: TagEntry[],
  scalar: ScalarClass,
  scope: ColumnContext
): ColumnMember {
  const ctx: ParseContext = scope.ctx;
  const location: string = `${structName}.${goField.name}`;
  const warnings: string[] = ctx.warnings;

  let type: IrScalarType = scalar.type;
  let maxLength: number | undefined;
  let maxDigits: number | undefined;
  let decimalPlaces: number | undefined;
  let arrayDepth: number | undefined = scalar.arrayDepth;
  let unsupportedType: string | undefined = scalar.unsupportedType;
  let enumInfo: EnumInfo | undefined = scalar.enumInfo;
  let isSerial: boolean = false;
  let goKind: GoKind = scalar.goKind;

  const typeTag: string | undefined = entryValue(entries, 'TYPE');
  const serializer: string | undefined = entryValue(
    entries,
    'SERIALIZER'
  )?.toLowerCase();
  if (typeTag !== undefined) {
    const dbType: DbType = readDbType(typeTag);
    type = dbType.type;
    maxLength = dbType.maxLength;
    maxDigits = dbType.maxDigits;
    decimalPlaces = dbType.decimalPlaces;
    arrayDepth = dbType.arrayDepth;
    unsupportedType = dbType.unsupportedType;
    isSerial = dbType.isSerial === true;
    if (dbType.type === 'unsupported') {
      warnings.push(
        `${location}: the column type "${typeTag}" has no equivalent in the shared model; it was kept as an unsupported column.`
      );
    }
    if (enumInfo !== undefined && type !== 'string' && type !== 'text') {
      warnings.push(
        `${location}: the column type "${typeTag}" is not a string type, so the enum "${enumInfo.name}" was not applied.`
      );
      enumInfo = undefined;
    }
  } else if (serializer !== undefined) {
    arrayDepth = undefined;
    unsupportedType = undefined;
    enumInfo = undefined;
    if (serializer === 'json') {
      type = 'json';
    } else if (serializer === 'gob') {
      type = 'bytes';
    } else if (serializer === 'unixtime') {
      type = 'bigInt';
    } else {
      type = 'unsupported';
      unsupportedType = `serializer:${serializer}`;
      warnings.push(
        `${location}: the serializer "${serializer}" is custom; the column was kept as an unsupported column.`
      );
    }
  } else if (scalar.needsHint !== undefined) {
    if (scalar.needsHint === 'scanner') {
      warnings.push(
        `${location}: "${scalar.unsupportedType ?? ''}" implements Scanner and Valuer, so GORM stores it as a column of a type ` +
          `only the database knows; add a type:... tag to set it. The column was kept as an unsupported column.`
      );
    } else {
      warnings.push(
        `${location}: a ${scalar.needsHint} column needs a type:... or serializer:... tag for GORM to migrate it; ` +
          `it was read as ${scalar.needsHint === 'map' ? 'a json column' : `an array of ${type}`}.`
      );
    }
  } else if (type === 'unsupported') {
    warnings.push(
      `${location}: the Go type "${unsupportedType ?? ''}" has no column mapping; add a type:... tag to choose one. ` +
        `It was kept as an unsupported column.`
    );
  }
  if (scalar.intEnumName !== undefined) {
    warnings.push(
      `${location}: the type "${scalar.intEnumName}" has integer constants, which the shared model cannot represent as an enum; ` +
        `the column was converted to a plain integer.`
    );
  }

  // size, precision and scale tags -----------------------------------------
  const size: number | undefined = entryNumber(entries, 'SIZE');
  const precision: number | undefined = entryNumber(entries, 'PRECISION');
  const scale: number | undefined = entryNumber(entries, 'SCALE');
  if (typeTag === undefined && serializer === undefined) {
    if (
      size !== undefined &&
      size > 0 &&
      (type === 'text' || type === 'string') &&
      goKind === 'string'
    ) {
      type = 'string';
      maxLength = size;
    } else if (
      size !== undefined &&
      size > 0 &&
      (goKind === 'int' || goKind === 'uint') &&
      (type === 'int' || type === 'bigInt')
    ) {
      type = integerType(size, goKind === 'uint');
    }
  }
  if (
    precision !== undefined &&
    precision > 0 &&
    (type === 'decimal' || type === 'float')
  ) {
    // GORM stores a float with a precision as numeric(precision, scale).
    type = 'decimal';
    maxDigits = precision;
    decimalPlaces = scale;
    goKind = 'float';
  } else if (type === 'decimal' && scale !== undefined) {
    decimalPlaces = scale;
  }
  if (enumInfo !== undefined && type === 'text') {
    type = 'string';
  }

  const columnName: string =
    scope.columnPrefix +
    (entryValue(entries, 'COLUMN') ?? gormColumnName(goField.name));
  const irName: string = irFieldName(scope.namePrefix + goField.name);

  // Primary key, nullability, uniqueness -----------------------------------
  const isPrimary: boolean =
    (entryFlag(entries, 'PRIMARYKEY', 'PRIMARY_KEY') ?? false) === true;
  const notNull: boolean = entryFlag(entries, 'NOT NULL', 'NOTNULL') === true;
  const isNullable: boolean = scalar.nullable && !notNull && !isPrimary;

  // Timestamps GORM maintains ----------------------------------------------
  const isTimeLike: boolean = goKind === 'time';
  const isIntegerLike: boolean = goKind === 'int' || goKind === 'uint';
  const createTag: boolean | undefined = entryFlag(entries, 'AUTOCREATETIME');
  const updateTag: boolean | undefined = entryFlag(entries, 'AUTOUPDATETIME');
  const autoCreate: boolean =
    createTag ??
    (goField.name === 'CreatedAt' && (isTimeLike || isIntegerLike));
  const autoUpdate: boolean =
    updateTag ??
    (goField.name === 'UpdatedAt' && (isTimeLike || isIntegerLike));
  if (
    (autoCreate || autoUpdate) &&
    isIntegerLike &&
    (createTag === true || updateTag === true)
  ) {
    warnings.push(
      `${location}: ${autoCreate ? 'autoCreateTime' : 'autoUpdateTime'} on an integer field stores Unix time; ` +
        `it was read as a plain integer column.`
    );
  }

  const field: IrField = {
    name: irName,
    columnName,
    type,
    isPrimaryKey: isPrimary,
    isUnique: !isPrimary && entryFlag(entries, 'UNIQUE') === true,
    isNullable,
    isAutoUpdated: autoUpdate && isTimeLike,
    ...(maxLength === undefined || type !== 'string' ? {} : { maxLength }),
    ...(type === 'decimal' && maxDigits !== undefined ? { maxDigits } : {}),
    ...(type === 'decimal' && decimalPlaces !== undefined
      ? { decimalPlaces }
      : {}),
    ...(arrayDepth === undefined || arrayDepth === 0 ? {} : { arrayDepth }),
    ...(enumInfo === undefined ? {} : { enumName: enumInfo.name }),
    ...(type === 'unsupported' && unsupportedType !== undefined
      ? { unsupportedType }
      : {}),
  };

  // Defaults ---------------------------------------------------------------
  const defaultTag: string | undefined = entryValue(entries, 'DEFAULT');
  const autoIncrementTag: boolean | undefined = entryFlag(
    entries,
    'AUTOINCREMENT'
  );
  if (defaultTag !== undefined) {
    const converted: IrDefault | undefined = convertDefault(
      defaultTag,
      field,
      enumInfo,
      location,
      ctx
    );
    if (converted !== undefined) {
      field.default = converted;
    }
  } else if (autoCreate && isTimeLike) {
    field.default = { kind: 'now' };
  }

  return {
    kind: 'column',
    goName: goField.name,
    field,
    entries,
    indexTags: parseIndexTags(gormTagOf(goField)),
    isPrimary,
    autoIncrementTag: isSerial ? (autoIncrementTag ?? true) : autoIncrementTag,
    goKind,
    depth: scope.depth,
  };
}

// ---------------------------------------------------------------------------
// Structs to raw models
// ---------------------------------------------------------------------------

function collectMembers(
  goStruct: GoStruct,
  structName: string,
  scope: ColumnContext,
  trail: Set<string>,
  soft: { field: string | undefined }
): Member[] {
  const ctx: ParseContext = scope.ctx;
  const members: Member[] = [];
  for (const field of goStruct.fields) {
    const entries: TagEntry[] = parseSettings(gormTagOf(field), ';');
    if (isIgnored(entries)) {
      continue;
    }
    if (isEmbeddedField(field, entries)) {
      const inner: GoStruct | undefined = embeddedStruct(field.type, ctx);
      const label: string = `${structName}.${field.name ?? describeGoType(field.type)}`;
      if (inner === undefined) {
        // An embedded scalar-like type (for example time.Time) is a column; only structs are expanded.
        if (field.name === undefined) {
          ctx.warnings.push(
            `${label}: the embedded type is not declared in the input files, so its columns are missing. ` +
              `Add the file that defines it to --input.`
          );
          continue;
        }
      } else {
        if (trail.has(inner.name)) {
          ctx.warnings.push(
            `${label}: the embedded struct "${inner.name}" contains itself; the recursion was cut.`
          );
          continue;
        }
        const prefix: string = entryValue(entries, 'EMBEDDEDPREFIX') ?? '';
        members.push(
          ...collectMembers(
            inner,
            structName,
            {
              ctx,
              columnPrefix: scope.columnPrefix + prefix,
              namePrefix:
                scope.namePrefix + (prefix === '' ? '' : toCamelCase(prefix)),
              depth: scope.depth + 1,
            },
            new Set([...trail, inner.name]),
            soft
          )
        );
        continue;
      }
    }
    const goName: string | undefined = field.name;
    if (goName === undefined || !isUpperAscii(goName.charAt(0))) {
      // Unexported fields are not part of the schema.
      continue;
    }
    const location: string = `${structName}.${goName}`;
    const hasColumnTag: boolean =
      entryValue(entries, 'TYPE', 'SERIALIZER') !== undefined;
    const classified: TypeClass = classifyType(field.type, ctx);
    if (classified.kind === 'skip') {
      if (classified.message !== undefined) {
        ctx.warnings.push(
          `${location}: ${classified.message}; it was skipped.`
        );
      }
      continue;
    }
    if (classified.kind === 'association') {
      if (hasColumnTag) {
        // An explicit column type makes the field a column, not an association.
        const column: ColumnMember = buildColumn(
          structName,
          { ...field, name: goName },
          entries,
          {
            kind: 'scalar',
            type: 'json',
            goKind: 'other',
            nullable: field.type.kind === 'pointer',
          },
          scope
        );
        members.push(column);
        continue;
      }
      members.push({
        kind: 'association',
        goName,
        irName: irFieldName(scope.namePrefix + goName),
        target: classified.target,
        many: classified.many,
        entries,
        depth: scope.depth,
      });
      continue;
    }
    if (classified.isSoftDelete === true && soft.field === undefined) {
      soft.field = goName;
    }
    members.push(
      buildColumn(
        structName,
        { ...field, name: goName },
        entries,
        classified,
        scope
      )
    );
  }
  return members;
}

/** Table name from a TableName() method, or GORM's default. */
function resolveTableName(goStruct: GoStruct, ctx: ParseContext): string {
  const method: GoMethod | undefined = ctx.methods
    .get(goStruct.name)
    ?.get('TableName');
  const fallback: string = gormTableName(goStruct.name);
  if (method === undefined) {
    return fallback;
  }
  if (method.returns?.kind === 'string') {
    return method.returns.value;
  }
  if (method.returns?.kind === 'identifier') {
    const constant: GoConst | undefined = ctx.consts.get(method.returns.name);
    if (constant?.value?.kind === 'string') {
      return constant.value.value;
    }
  }
  ctx.warnings.push(
    `${goStruct.name}: TableName() does not return a string literal or constant, so its value cannot be read statically; ` +
      `GORM's default table name "${fallback}" was used.`
  );
  return fallback;
}

function buildRawModel(goStruct: GoStruct, ctx: ParseContext): RawModel {
  const soft: { field: string | undefined } = { field: undefined };
  const collected: Member[] = collectMembers(
    goStruct,
    goStruct.name,
    { ctx, columnPrefix: '', namePrefix: '', depth: 0 },
    new Set([goStruct.name]),
    soft
  );
  // A field of the model itself shadows a promoted field of the same name.
  const members: Member[] = collected.filter(
    (member: Member, index: number): boolean => {
      const name: string =
        member.kind === 'column' ? member.field.name : member.irName;
      return !collected.some(
        (other: Member, otherIndex: number): boolean =>
          otherIndex !== index &&
          (other.kind === 'column' ? other.field.name : other.irName) ===
            name &&
          (other.depth < member.depth ||
            (other.depth === member.depth && otherIndex < index))
      );
    }
  );

  const columns: ColumnMember[] = members.filter(
    (member: Member): member is ColumnMember => member.kind === 'column'
  );
  let primaryMembers: ColumnMember[] = columns.filter(
    (column: ColumnMember) => column.isPrimary
  );
  if (primaryMembers.length === 0) {
    // GORM treats a field called ID as the primary key when none is declared.
    const implicit: ColumnMember | undefined = columns.find(
      (column: ColumnMember) => column.field.columnName === 'id'
    );
    if (implicit !== undefined) {
      implicit.isPrimary = true;
      implicit.field.isPrimaryKey = true;
      implicit.field.isNullable = false;
      implicit.field.isUnique = false;
      primaryMembers = [implicit];
    }
  }
  return {
    name: goStruct.name,
    struct: goStruct,
    tableName: resolveTableName(goStruct, ctx),
    members,
    primaryMembers,
    softDeleteField: soft.field,
  };
}

// ---------------------------------------------------------------------------
// Associations
// ---------------------------------------------------------------------------

interface ConstraintInfo {
  name?: string;
  onDelete?: IrOnDelete;
  onUpdate?: IrOnDelete;
}

function readConstraint(
  member: AssociationMember,
  location: string,
  ctx: ParseContext
): ConstraintInfo {
  const text: string | undefined = entryValue(member.entries, 'CONSTRAINT');
  if (text === undefined) {
    return {};
  }
  const result: ConstraintInfo = {};
  const comma: number = text.indexOf(',');
  if (comma !== -1 && /^[\w-]+$/.test(text.slice(0, comma))) {
    result.name = text.slice(0, comma);
  }
  const settings: TagEntry[] = parseSettings(text, ',');
  for (const [key, target] of [
    ['ONDELETE', 'onDelete'],
    ['ONUPDATE', 'onUpdate'],
  ] as const) {
    const value: string | undefined = entryValue(settings, key);
    if (value === undefined || value === '') {
      continue;
    }
    const mapped: IrOnDelete | undefined = ON_DELETE_MAP[value.toUpperCase()];
    if (mapped === undefined) {
      ctx.warnings.push(
        `${location}: ${target === 'onDelete' ? 'OnDelete' : 'OnUpdate'} "${value}" has no equivalent and was converted to NoAction.`
      );
      result[target] = 'noAction';
    } else {
      result[target] = mapped;
    }
  }
  return result;
}

/** GORM looks a field up by column name first, then by Go name. */
function lookupMember(model: RawModel, name: string): ColumnMember | undefined {
  const columns: ColumnMember[] = model.members.filter(
    (member: Member): member is ColumnMember => member.kind === 'column'
  );
  return (
    columns.find((column: ColumnMember) => column.field.columnName === name) ??
    columns.find((column: ColumnMember) => column.goName === name)
  );
}

interface KeyPair {
  foreign: ColumnMember[];
  references: ColumnMember[];
}

/**
 * Finds the foreign key of an association the way GORM does. For `has`, the key lives on the
 * target and refers to the declaring model; for `belongs`, it lives on the declaring model.
 */
function guessKeys(
  mode: 'has' | 'belongs',
  declaring: RawModel,
  target: RawModel,
  member: AssociationMember
): KeyPair | undefined {
  const primary: RawModel = mode === 'has' ? declaring : target;
  const foreign: RawModel = mode === 'has' ? target : declaring;
  const foreignNames: string[] = splitList(
    entryValue(member.entries, 'FOREIGNKEY')
  );
  const referenceNames: string[] = splitList(
    entryValue(member.entries, 'REFERENCES')
  );

  let primaryFields: ColumnMember[] = primary.primaryMembers;
  if (referenceNames.length > 0) {
    const resolved: (ColumnMember | undefined)[] = referenceNames.map(
      (name: string) => lookupMember(primary, name)
    );
    if (resolved.some((item: ColumnMember | undefined) => item === undefined)) {
      return undefined;
    }
    primaryFields = resolved.filter(
      (item: ColumnMember | undefined): item is ColumnMember =>
        item !== undefined
    );
  }

  if (foreignNames.length > 0) {
    const resolved: (ColumnMember | undefined)[] = foreignNames.map(
      (name: string) => lookupMember(foreign, name)
    );
    const found: ColumnMember[] = resolved.filter(
      (item: ColumnMember | undefined): item is ColumnMember =>
        item !== undefined
    );
    if (
      found.length !== foreignNames.length ||
      found.length !== primaryFields.length
    ) {
      return undefined;
    }
    return { foreign: found, references: primaryFields };
  }

  const foreignFields: ColumnMember[] = [];
  for (const primaryField of primaryFields) {
    const base: string =
      (mode === 'belongs' ? member.goName : primary.name) + primaryField.goName;
    const names: string[] = [base];
    if (primaryFields.length === 1) {
      const stem: string = base.slice(
        0,
        base.length - primaryField.goName.length
      );
      names.push(`${stem}ID`, `${stem}Id`, gormColumnName(`${stem}ID`));
    }
    let found: ColumnMember | undefined;
    for (const name of names) {
      found = lookupMember(foreign, name);
      if (found !== undefined) {
        break;
      }
    }
    if (found === undefined) {
      return undefined;
    }
    foreignFields.push(found);
  }
  return foreignFields.length === 0
    ? undefined
    : { foreign: foreignFields, references: primaryFields };
}

/** One database foreign key, assembled from the belongs-to and has-one / has-many sides that describe it. */
interface ForeignKeyLink {
  owner: RawModel;
  target: RawModel;
  keys: KeyPair;
  belongsTo?: { model: RawModel; member: AssociationMember };
  has?: { model: RawModel; member: AssociationMember };
  belongsConstraint: ConstraintInfo;
  hasConstraint: ConstraintInfo;
}

interface ManyToManyUse {
  owner: RawModel;
  member: AssociationMember;
  target: RawModel;
  table: string;
  ownerColumn: string;
  relatedColumn: string;
  consumed: boolean;
}

/**
 * The constraint settings that GORM applies to a foreign key. When both the belongs-to field and
 * the has-one / has-many field describe the key, GORM ignores the belongs-to field's settings.
 */
function effectiveConstraint(
  link: ForeignKeyLink,
  ctx: ParseContext
): ConstraintInfo {
  if (link.has === undefined) {
    return link.belongsConstraint;
  }
  const ignored: ConstraintInfo = link.belongsConstraint;
  if (
    link.belongsTo !== undefined &&
    (ignored.onDelete !== undefined ||
      ignored.onUpdate !== undefined ||
      ignored.name !== undefined)
  ) {
    ctx.warnings.push(
      `${link.belongsTo.model.name}.${link.belongsTo.member.goName}: GORM ignores the constraint:... tag of a belongs-to field when ` +
        `${link.has.model.name}.${link.has.member.goName} describes the same foreign key; set the constraint on that field instead.`
    );
  }
  return link.hasConstraint;
}

/** Resolves every association tag into foreign-key links and many-to-many uses. */
function resolveAssociations(
  models: RawModel[],
  ctx: ParseContext
): { links: ForeignKeyLink[]; manyToMany: ManyToManyUse[] } {
  const byName: Map<string, RawModel> = new Map(
    models.map((model: RawModel) => [model.name, model])
  );
  const links: Map<string, ForeignKeyLink> = new Map();
  const manyToMany: ManyToManyUse[] = [];

  for (const model of models) {
    for (const member of model.members) {
      if (member.kind !== 'association') {
        continue;
      }
      const location: string = `${model.name}.${member.goName}`;
      const target: RawModel | undefined = byName.get(member.target);
      if (target === undefined) {
        ctx.warnings.push(
          `${location}: the target "${member.target}" is not a model in the input; the association was skipped.`
        );
        continue;
      }
      const polymorphic: string | undefined = entryValue(
        member.entries,
        'POLYMORPHIC'
      );
      if (polymorphic !== undefined) {
        ctx.warnings.push(
          `${location}: the polymorphic association "${polymorphic}" (the ${polymorphic}ID and ${polymorphic}Type columns of "${target.name}") ` +
            `points at several models, which the shared model cannot represent; the association was dropped and the columns stay ordinary fields.`
        );
        continue;
      }
      const joinTable: string | undefined = entryValue(
        member.entries,
        'MANY2MANY'
      );
      if (joinTable !== undefined) {
        const use: ManyToManyUse | undefined = resolveManyToMany(
          model,
          member,
          target,
          joinTable,
          location,
          ctx
        );
        if (use !== undefined) {
          manyToMany.push(use);
        }
        continue;
      }

      const modes: ('has' | 'belongs')[] = member.many
        ? ['has']
        : model === target
          ? ['belongs', 'has']
          : ['has', 'belongs'];
      let resolvedMode: 'has' | 'belongs' | undefined;
      let keys: KeyPair | undefined;
      for (const mode of modes) {
        keys = guessKeys(mode, model, target, member);
        if (keys !== undefined) {
          resolvedMode = mode;
          break;
        }
      }
      if (keys === undefined || resolvedMode === undefined) {
        ctx.warnings.push(
          `${location}: no foreign key was found for the association to "${target.name}". Add a foreignKey:... tag or a ` +
            `${member.many ? `${model.name}ID` : `${member.goName}ID`} field; the association was skipped.`
        );
        continue;
      }
      const owner: RawModel = resolvedMode === 'has' ? target : model;
      const referenced: RawModel = resolvedMode === 'has' ? model : target;
      const key: string = `${owner.name}|${keys.foreign
        .map((column: ColumnMember) => column.field.columnName)
        .join(',')}|${referenced.name}`;
      const link: ForeignKeyLink = links.get(key) ?? {
        owner,
        target: referenced,
        keys,
        belongsConstraint: {},
        hasConstraint: {},
      };
      links.set(key, link);
      const constraint: ConstraintInfo = readConstraint(member, location, ctx);
      if (resolvedMode === 'belongs') {
        if (link.belongsTo === undefined) {
          link.belongsTo = { model, member };
        }
      } else if (link.has === undefined) {
        link.has = { model, member };
      } else {
        ctx.warnings.push(
          `${location}: "${link.has.model.name}.${link.has.member.goName}" already describes the same foreign key; this reverse accessor was ignored.`
        );
      }
      if (resolvedMode === 'belongs') {
        link.belongsConstraint = constraint;
      } else if (link.has?.member === member) {
        link.hasConstraint = constraint;
      }
    }
  }
  return { links: [...links.values()], manyToMany };
}

function resolveManyToMany(
  owner: RawModel,
  member: AssociationMember,
  target: RawModel,
  joinTable: string,
  location: string,
  ctx: ParseContext
): ManyToManyUse | undefined {
  if (joinTable === '' || joinTable === 'MANY2MANY') {
    ctx.warnings.push(
      `${location}: many2many needs a join table name (many2many:table_name); the association was skipped.`
    );
    return undefined;
  }
  const ownerKeyNames: string[] = splitList(
    entryValue(member.entries, 'FOREIGNKEY')
  );
  const targetKeyNames: string[] = splitList(
    entryValue(member.entries, 'REFERENCES')
  );
  const ownerKeys: ColumnMember[] =
    ownerKeyNames.length === 0
      ? owner.primaryMembers
      : ownerKeyNames
          .map((name: string) => lookupMember(owner, name))
          .filter(
            (item: ColumnMember | undefined): item is ColumnMember =>
              item !== undefined
          );
  const targetKeys: ColumnMember[] =
    targetKeyNames.length === 0
      ? target.primaryMembers
      : targetKeyNames
          .map((name: string) => lookupMember(target, name))
          .filter(
            (item: ColumnMember | undefined): item is ColumnMember =>
              item !== undefined
          );
  const ownerKey: ColumnMember | undefined = ownerKeys[0];
  const targetKey: ColumnMember | undefined = targetKeys[0];
  if (ownerKey === undefined || targetKey === undefined) {
    ctx.warnings.push(
      `${location}: the keys of the many2many association could not be determined (${owner.name} or ${target.name} has no primary key); the association was skipped.`
    );
    return undefined;
  }
  if (ownerKeys.length > 1 || targetKeys.length > 1) {
    ctx.warnings.push(
      `${location}: the many2many association uses composite keys; only the first column of each key is read and the join table "${joinTable}" is not preserved.`
    );
  }
  const joinForeignKey: string | undefined = splitList(
    entryValue(member.entries, 'JOINFOREIGNKEY')
  )[0];
  const joinReferences: string | undefined = splitList(
    entryValue(member.entries, 'JOINREFERENCES')
  )[0];

  const ownerField: string =
    joinForeignKey === undefined
      ? upperFirst(owner.name) + ownerKey.goName
      : upperFirst(joinForeignKey);
  let relatedField: string =
    joinReferences === undefined
      ? upperFirst(target.name) + targetKey.goName
      : upperFirst(joinReferences);
  if (relatedField === ownerField) {
    // A self-referencing association names the second column after the field: Friends -> FriendID.
    relatedField =
      member.goName !== target.name
        ? upperFirst(toPascalSingular(member.goName)) + targetKey.goName
        : `${target.name}Reference${targetKey.goName}`;
  }
  if (
    (ownerKeyNames.length > 0 && !ownerKey.isPrimary) ||
    (targetKeyNames.length > 0 && !targetKey.isPrimary)
  ) {
    ctx.warnings.push(
      `${location}: the join table "${joinTable}" refers to columns that are not primary keys; the relation is read as a many-to-many on the primary keys.`
    );
  }
  return {
    owner,
    member,
    target,
    table: joinTable,
    ownerColumn: gormColumnName(ownerField),
    relatedColumn: gormColumnName(relatedField),
    consumed: false,
  };
}

/** `Friends` becomes `Friend` (the singular of the last word). */
function toPascalSingular(goName: string): string {
  const snake: string = toSnakeCase(goName);
  const singular: string = singularize(snake);
  return singular
    .split('_')
    .map((word: string) => upperFirst(word))
    .join('');
}

// ---------------------------------------------------------------------------
// Schema assembly
// ---------------------------------------------------------------------------

interface IndexMemberUse {
  member: ColumnMember;
  tag: RawIndexTag;
  order: number;
}

interface IndexGroup {
  name: string | undefined;
  isUnique: boolean;
  kind: 'fulltext' | undefined;
  method: string | undefined;
  uses: IndexMemberUse[];
  hasWhere: boolean;
  hasExpression: boolean;
}

function buildIndexGroups(columns: ColumnMember[]): IndexGroup[] {
  const groups: Map<string, IndexGroup> = new Map();
  let order: number = 0;
  for (const column of columns) {
    for (const tag of column.indexTags) {
      const key: string =
        tag.name !== undefined
          ? `name:${tag.name}`
          : tag.composite !== undefined
            ? `composite:${tag.composite}`
            : `field:${column.field.name}:${order}`;
      const group: IndexGroup = groups.get(key) ?? {
        name: tag.name,
        isUnique: false,
        kind: undefined,
        method: undefined,
        uses: [],
        hasWhere: false,
        hasExpression: false,
      };
      group.isUnique = group.isUnique || tag.isUnique;
      group.kind = group.kind ?? tag.kind;
      group.method = group.method ?? tag.method;
      group.hasWhere = group.hasWhere || tag.hasWhere;
      group.hasExpression = group.hasExpression || tag.hasExpression;
      group.uses.push({ member: column, tag, order });
      order += 1;
      groups.set(key, group);
    }
  }
  return [...groups.values()];
}

function defaultRelationName(column: ColumnMember, taken: Set<string>): string {
  const base: string = column.field.name;
  const stripped: string =
    /Id$/.test(base) && base.length > 2 ? base.slice(0, -2) : base;
  return taken.has(stripped) ? `${stripped}Ref` : stripped;
}

function buildSchema(
  rawModels: RawModel[],
  ctx: ParseContext,
  options: GormParseOptions
): IrSchema {
  const warnings: string[] = ctx.warnings;
  const { links, manyToMany } = resolveAssociations(rawModels, ctx);
  const usedEnums: Set<string> = new Set();
  const models: IrModel[] = [];

  for (const raw of rawModels) {
    const columns: ColumnMember[] = raw.members.filter(
      (member: Member): member is ColumnMember => member.kind === 'column'
    );
    const takenNames: Set<string> = new Set(
      raw.members.map((member: Member) =>
        member.kind === 'column' ? member.field.name : member.irName
      )
    );

    // Foreign keys: the key columns turn into relations --------------------
    const consumed: Map<ColumnMember, string> = new Map();
    interface OrderedRelation {
      order: number;
      relation: IrRelation;
    }
    const orderedRelations: OrderedRelation[] = [];
    const compositeKeys: IrCompositeForeignKey[] = [];
    let synthesized: number = 0;
    for (const link of links) {
      if (link.owner !== raw) {
        continue;
      }
      const order: number =
        link.belongsTo === undefined
          ? raw.members.length + synthesized++
          : raw.members.indexOf(link.belongsTo.member);
      const first: ColumnMember | undefined = link.keys.foreign[0];
      if (first === undefined) {
        continue;
      }
      const constraint: ConstraintInfo = effectiveConstraint(link, ctx);
      const name: string =
        link.belongsTo?.member.irName ?? defaultRelationName(first, takenNames);
      const isNullable: boolean = link.keys.foreign.some(
        (column: ColumnMember) => column.field.isNullable
      );
      const relatedName: string | undefined = link.has?.member.irName;
      const kind: 'foreignKey' | 'oneToOne' =
        link.has !== undefined && !link.has.member.many
          ? 'oneToOne'
          : 'foreignKey';

      if (link.keys.foreign.length > 1) {
        compositeKeys.push({
          name,
          targetModel: link.target.name,
          fields: link.keys.foreign.map(
            (column: ColumnMember) => column.field.name
          ),
          references: link.keys.references.map(
            (column: ColumnMember) => column.field.name
          ),
          kind,
          isNullable,
          onDelete: constraint.onDelete ?? 'noAction',
          ...(constraint.onUpdate === undefined
            ? {}
            : { onUpdate: constraint.onUpdate }),
          ...(relatedName === undefined ? {} : { relatedName }),
          ...(constraint.name === undefined
            ? {}
            : { constraintName: constraint.name }),
        });
        continue;
      }

      const reference: ColumnMember | undefined = link.keys.references[0];
      const isTargetKey: boolean =
        reference !== undefined &&
        link.target.primaryMembers.length === 1 &&
        link.target.primaryMembers[0] === reference;
      const unique: boolean =
        first.field.isUnique ||
        first.indexTags.some(
          (tag: RawIndexTag) =>
            tag.isUnique &&
            tag.name === undefined &&
            tag.composite === undefined
        );
      const relation: IrRelation = {
        name,
        kind: kind === 'foreignKey' && unique ? 'oneToOne' : kind,
        targetModel: link.target.name,
        columnName: first.field.columnName,
        isNullable: first.isPrimary ? false : isNullable,
        onDelete: constraint.onDelete ?? 'noAction',
        ...(relatedName === undefined ? {} : { relatedName }),
        ...(reference === undefined || isTargetKey
          ? {}
          : { toField: reference.field.columnName }),
        ...(first.isPrimary ? { isPrimaryKey: true } : {}),
        ...(constraint.onUpdate === undefined
          ? {}
          : { onUpdate: constraint.onUpdate }),
        ...(constraint.name === undefined
          ? {}
          : { constraintName: constraint.name }),
      };
      consumed.set(first, name);
      orderedRelations.push({ order, relation });
    }

    // Many-to-many ----------------------------------------------------------
    for (const use of manyToMany) {
      if (use.owner !== raw || use.consumed) {
        continue;
      }
      use.consumed = true;
      const mirror: ManyToManyUse | undefined = manyToMany.find(
        (candidate: ManyToManyUse) =>
          !candidate.consumed &&
          candidate !== use &&
          candidate.owner === use.target &&
          candidate.target === use.owner &&
          candidate.table.toLowerCase() === use.table.toLowerCase()
      );
      if (mirror !== undefined) {
        mirror.consumed = true;
      }
      const relation: IrRelation = {
        name: use.member.irName,
        kind: 'manyToMany',
        targetModel: use.target.name,
        columnName: `${toSnakeCase(use.member.irName)}_id`,
        isNullable: false,
        onDelete: 'cascade',
        ...(mirror === undefined ? {} : { relatedName: mirror.member.irName }),
      };
      orderedRelations.push({
        order: raw.members.indexOf(use.member),
        relation,
      });
      // Other formats derive the join table from the two models; say what does not survive.
      const isSelf: boolean = use.owner === use.target;
      const expectedTable: string = `${raw.tableName}_${use.member.irName}`;
      const expectedOwner: string = `${isSelf ? 'from_' : ''}${toSnakeCase(use.owner.name)}_id`;
      const expectedRelated: string = `${isSelf ? 'to_' : ''}${toSnakeCase(use.target.name)}_id`;
      if (
        use.table !== expectedTable ||
        use.ownerColumn !== expectedOwner ||
        use.relatedColumn !== expectedRelated
      ) {
        warnings.push(
          `${raw.name}.${use.member.goName}: the join table "${use.table}" (columns ${use.ownerColumn}, ${use.relatedColumn}) is not preserved by name; ` +
            `formats that derive join tables will use "${expectedTable}" (columns ${expectedOwner}, ${expectedRelated}).`
        );
      }
    }

    const relations: IrRelation[] = orderedRelations
      .sort(
        (first: OrderedRelation, second: OrderedRelation) =>
          first.order - second.order
      )
      .map((entry: OrderedRelation) => entry.relation);

    // Fields -----------------------------------------------------------------
    const fields: IrField[] = columns
      .filter((column: ColumnMember) => !consumed.has(column))
      .map((column: ColumnMember): IrField => ({ ...column.field }));
    const finalName = (column: ColumnMember): string =>
      consumed.get(column) ?? column.field.name;
    const fieldFor = (column: ColumnMember): IrField | undefined =>
      fields.find((field: IrField) => field.name === column.field.name);

    // Primary key ------------------------------------------------------------
    const keyColumns: ColumnMember[] = raw.primaryMembers;
    let compositePrimaryKey: string[] | undefined;
    if (keyColumns.length === 0) {
      warnings.push(
        `${raw.name}: the struct has no primary key (GORM treats a field called ID, or a primaryKey tag, as one); ` +
          `other formats expect every model to have a key.`
      );
    } else if (keyColumns.length > 1) {
      compositePrimaryKey = keyColumns.map(finalName);
      for (const column of keyColumns) {
        const field: IrField | undefined = fieldFor(column);
        if (field !== undefined) {
          field.isPrimaryKey = false;
          field.isUnique = false;
        }
      }
      for (const relation of relations) {
        delete relation.isPrimaryKey;
      }
    }
    // The prioritized primary key of an integer type auto-increments unless told otherwise.
    for (const column of columns) {
      const field: IrField | undefined = fieldFor(column);
      if (field === undefined || field.default?.kind === 'autoIncrement') {
        continue;
      }
      const isInteger: boolean =
        field.type === 'int' || field.type === 'bigInt';
      const isOnlyKey: boolean =
        keyColumns.length === 1 && keyColumns[0] === column;
      if (
        isInteger &&
        field.arrayDepth === undefined &&
        (column.autoIncrementTag === true ||
          (isOnlyKey && column.autoIncrementTag === undefined)) &&
        field.default === undefined
      ) {
        field.default = { kind: 'autoIncrement' };
      }
    }

    // Indexes ----------------------------------------------------------------
    const irIndexes: IrIndex[] = [];
    for (const group of buildIndexGroups(columns)) {
      const label: string = group.name === undefined ? '' : ` "${group.name}"`;
      const sorted: IndexMemberUse[] = [...group.uses].sort(
        (first: IndexMemberUse, second: IndexMemberUse) =>
          first.tag.priority - second.tag.priority || first.order - second.order
      );
      if (group.hasExpression) {
        warnings.push(
          `${raw.name}: the index${label} on (${sorted.map((use: IndexMemberUse) => use.member.goName).join(', ')}) uses an expression, which cannot be represented; it was skipped.`
        );
        continue;
      }
      if (group.hasWhere) {
        warnings.push(
          `${raw.name}: the index${label} has a where condition (a partial index), which is not preserved; it was read as a full index.`
        );
      }
      const names: string[] = sorted.map((use: IndexMemberUse) =>
        finalName(use.member)
      );
      const only: IndexMemberUse | undefined = sorted[0];
      if (
        names.length === 1 &&
        only !== undefined &&
        group.isUnique &&
        group.name === undefined &&
        group.kind === undefined &&
        only.tag.sort === undefined &&
        only.tag.length === undefined
      ) {
        const field: IrField | undefined = fieldFor(only.member);
        if (field !== undefined) {
          if (!field.isPrimaryKey) {
            field.isUnique = true;
          }
          continue;
        }
        if (consumed.has(only.member)) {
          // The unique key is a foreign key: the relation already carries it (one-to-one).
          continue;
        }
      }
      const fieldOptions: Record<string, IrIndexFieldOptions> = {};
      for (const use of sorted) {
        const optionSet: IrIndexFieldOptions = {
          ...(use.tag.sort === undefined ? {} : { sort: use.tag.sort }),
          ...(use.tag.length === undefined ? {} : { length: use.tag.length }),
        };
        if (Object.keys(optionSet).length > 0) {
          fieldOptions[finalName(use.member)] = optionSet;
        }
      }
      const method: string | undefined =
        group.method === undefined
          ? undefined
          : INDEX_METHODS[group.method.toLowerCase()];
      if (group.method !== undefined && method === undefined) {
        warnings.push(
          `${raw.name}: the index method "${group.method}" has no equivalent and was ignored.`
        );
      }
      irIndexes.push({
        fields: names,
        isUnique: group.isUnique,
        ...(group.name === undefined ? {} : { name: group.name }),
        ...(group.kind === undefined ? {} : { kind: group.kind }),
        ...(method === undefined ? {} : { method }),
        ...(Object.keys(fieldOptions).length === 0 ? {} : { fieldOptions }),
      });
    }

    // Settings with no equivalent -----------------------------------------------
    for (const column of columns) {
      const check: string | undefined = entryValue(column.entries, 'CHECK');
      if (check !== undefined) {
        warnings.push(
          `${raw.name}.${column.goName}: the check constraint "${check}" has no equivalent in the shared model and was dropped.`
        );
      }
      const comment: string | undefined = entryValue(column.entries, 'COMMENT');
      if (comment !== undefined) {
        warnings.push(
          `${raw.name}.${column.goName}: the column comment is not preserved.`
        );
      }
      if (column.field.enumName !== undefined) {
        usedEnums.add(column.field.enumName);
      }
    }
    if (raw.softDeleteField !== undefined) {
      warnings.push(
        `${raw.name}.${raw.softDeleteField}: gorm.DeletedAt is read as a nullable timestamp column; the soft-delete behavior ` +
          `(GORM hides rows with a deletion time from queries) has no equivalent in the shared model.`
      );
    }

    models.push({
      name: raw.name,
      tableName: raw.tableName,
      appLabel: options.appLabel,
      fields,
      relations,
      indexes: irIndexes,
      ...(compositePrimaryKey === undefined ? {} : { compositePrimaryKey }),
      ...(compositeKeys.length === 0
        ? {}
        : { compositeForeignKeys: compositeKeys }),
    });
  }

  const enums: IrEnum[] = [...ctx.enums.values()]
    .filter(
      (info: EnumInfo) => info.backing === 'string' && usedEnums.has(info.name)
    )
    .map((info: EnumInfo): IrEnum => ({
      name: info.name,
      values: info.values,
    }));
  return { models, enums, warnings };
}
