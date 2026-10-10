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
  IrRangeSubtype,
  IrRelation,
  IrScalarType,
  IrSchema,
} from '../ir.js';
import {
  singularize,
  toCamelCase,
  toPascalCase,
  toSnakeCase,
} from '../naming.js';
import { describeThrown, err, ok, type Result } from '../result.js';
import {
  evaluateNode,
  getPythonParser,
  lastSegment,
  type PyCall,
  type PyValue,
  type SyntaxNode,
} from './pythonSyntax.js';

export interface SqlAlchemySourceFile {
  path: string;
  text: string;
}

export interface SqlAlchemyParseOptions {
  /** Application label stored on every model (SQLAlchemy has no such concept). */
  appLabel: string;
}

// ---------------------------------------------------------------------------
// Limits and tables of known names
// ---------------------------------------------------------------------------

/** Files larger than this are skipped with a warning, so hostile input cannot stall the parser. */
const MAX_SOURCE_LENGTH: number = 2_000_000;
const MAX_WARNINGS: number = 500;
const MAX_TYPE_DEPTH: number = 24;
const MAX_STRING_ANNOTATION: number = 400;
const MAX_ALIAS_DEPTH: number = 8;
const MAX_INHERITANCE_DEPTH: number = 64;
const MAX_COLUMNS_PER_TABLE: number = 2000;
const MAX_RELATIONSHIPS_PER_TABLE: number = 2000;

interface TypeSpec {
  type: IrScalarType;
  /** The first argument (or `length`) is the maximum length. */
  length?: boolean;
  /** The first two arguments are precision and scale. */
  numeric?: boolean;
  rangeOf?: IrRangeSubtype;
}

/** SQLAlchemy and dialect column types, keyed by their lower-cased class name. */
const SA_TYPES: Readonly<Record<string, TypeSpec>> = {
  integer: { type: 'int' },
  int: { type: 'int' },
  smallinteger: { type: 'int' },
  smallint: { type: 'int' },
  tinyint: { type: 'int' },
  mediumint: { type: 'int' },
  biginteger: { type: 'bigInt' },
  bigint: { type: 'bigInt' },
  string: { type: 'string', length: true },
  varchar: { type: 'string', length: true },
  nvarchar: { type: 'string', length: true },
  unicode: { type: 'string', length: true },
  char: { type: 'string', length: true },
  nchar: { type: 'string', length: true },
  text: { type: 'text' },
  unicodetext: { type: 'text' },
  clob: { type: 'text' },
  longtext: { type: 'text' },
  mediumtext: { type: 'text' },
  tinytext: { type: 'text' },
  ntext: { type: 'text' },
  boolean: { type: 'boolean' },
  bool: { type: 'boolean' },
  float: { type: 'float' },
  real: { type: 'float' },
  double: { type: 'float' },
  double_precision: { type: 'float' },
  numeric: { type: 'decimal', numeric: true },
  decimal: { type: 'decimal', numeric: true },
  datetime: { type: 'dateTime' },
  timestamp: { type: 'dateTime' },
  date: { type: 'date' },
  time: { type: 'time' },
  interval: { type: 'duration' },
  largebinary: { type: 'bytes' },
  binary: { type: 'bytes' },
  varbinary: { type: 'bytes' },
  blob: { type: 'bytes' },
  bytea: { type: 'bytes' },
  pickletype: { type: 'bytes' },
  json: { type: 'json' },
  jsonb: { type: 'json' },
  uuid: { type: 'uuid' },
  guid: { type: 'uuid' },
  uniqueidentifier: { type: 'uuid' },
  inet: { type: 'ipAddress' },
  cidr: { type: 'ipAddress' },
  hstore: { type: 'hstore' },
  int4range: { type: 'range', rangeOf: 'int' },
  int8range: { type: 'range', rangeOf: 'bigInt' },
  numrange: { type: 'range', rangeOf: 'decimal' },
  daterange: { type: 'range', rangeOf: 'date' },
  tsrange: { type: 'range', rangeOf: 'dateTime' },
  tstzrange: { type: 'range', rangeOf: 'dateTime' },
};

/** Python types a `Mapped[...]` annotation or SQLModel field can name without an explicit column type. */
const PY_TYPES: Readonly<Record<string, TypeSpec>> = {
  int: { type: 'int' },
  str: { type: 'string' },
  float: { type: 'float' },
  bool: { type: 'boolean' },
  bytes: { type: 'bytes' },
  bytearray: { type: 'bytes' },
  datetime: { type: 'dateTime' },
  date: { type: 'date' },
  time: { type: 'time' },
  timedelta: { type: 'duration' },
  Decimal: { type: 'decimal' },
  UUID: { type: 'uuid' },
  IPv4Address: { type: 'ipAddress' },
  IPv6Address: { type: 'ipAddress' },
  IPv4Network: { type: 'ipAddress' },
  IPv6Network: { type: 'ipAddress' },
};

/** Calls found among the positional arguments of a column that are not its type. */
const NON_TYPE_CALLS: ReadonlySet<string> = new Set([
  'foreignkey',
  'identity',
  'sequence',
  'computed',
  'fetchedvalue',
  'checkconstraint',
  'foreignkeyconstraint',
  'uniqueconstraint',
  'primarykeyconstraint',
  'index',
  'defaultclause',
  'persisted',
]);

const ROOT_BASE_NAMES: ReadonlySet<string> = new Set([
  'DeclarativeBase',
  'DeclarativeBaseNoMeta',
]);

const ENUM_BASE_NAMES: ReadonlySet<string> = new Set([
  'Enum',
  'IntEnum',
  'StrEnum',
  'Flag',
  'IntFlag',
  'ReprEnum',
]);

const COLLECTION_TYPES: ReadonlySet<string> = new Set([
  'list',
  'set',
  'sequence',
  'collection',
  'mutablesequence',
  'frozenset',
  'iterable',
  'dict',
  'mapping',
  'defaultdict',
  'ordereddict',
]);

const ON_ACTION_MAP: Readonly<Record<string, IrOnDelete>> = {
  CASCADE: 'cascade',
  'SET NULL': 'setNull',
  RESTRICT: 'restrict',
  'NO ACTION': 'noAction',
  'SET DEFAULT': 'setDefault',
};

/** Mapped-attribute constructors that are not columns or relationships and are not converted. */
const UNSUPPORTED_ATTRIBUTES: ReadonlySet<string> = new Set([
  'column_property',
  'composite',
  'synonym',
  'deferred',
  'query_expression',
  'with_polymorphic',
]);

/** Constructors that never describe schema (read-only helpers on a model). */
const IGNORED_ATTRIBUTES: ReadonlySet<string> = new Set([
  'association_proxy',
  'hybrid_property',
  'hybrid_method',
  'validates',
  'reconstructor',
]);

const CURRENT_TIMESTAMP_EXPRESSIONS: ReadonlySet<string> = new Set([
  'now()',
  'current_timestamp',
  'current_timestamp()',
  'localtimestamp',
  'localtimestamp()',
  'getdate()',
  'sysdatetime()',
  'sysutcdatetime()',
  "datetime('now')",
  "(datetime('now'))",
  'transaction_timestamp()',
  'statement_timestamp()',
  'clock_timestamp()',
  'current_date',
  'current_date()',
  'current_time',
]);

const UUID_EXPRESSIONS: ReadonlySet<string> = new Set([
  'gen_random_uuid()',
  'uuid_generate_v4()',
  'uuid()',
  'newid()',
  'uuid_generate_v1()',
  'newsequentialid()',
]);

// ---------------------------------------------------------------------------
// Raw (pre-IR) structures
// ---------------------------------------------------------------------------

type TypeExpr =
  | { kind: 'name'; name: string }
  | { kind: 'sub'; base: string; args: TypeExpr[] }
  | { kind: 'union'; members: TypeExpr[] }
  | { kind: 'str'; value: string }
  | { kind: 'none' }
  | { kind: 'value'; value: PyValue }
  | { kind: 'other'; text: string };

interface RawMember {
  name: string;
  annotation?: TypeExpr;
  value?: PyValue;
}

interface EnumMember {
  name: string;
  value: PyValue | undefined;
}

interface RawClass {
  name: string;
  filePath: string;
  order: number;
  bases: string[];
  keywords: Record<string, PyValue>;
  members: RawMember[];
  isAbstract: boolean;
  /** Literal `__tablename__`. */
  tableName?: string;
  /** `@declared_attr` `__tablename__` that derives the name from the class name. */
  tableNameRule?: 'lower' | 'exact' | 'snake';
  /** Items of `__table_args__` (a dict is one item). Undefined when the class has none. */
  tableArgs?: PyValue[];
  /** `__table__ = Table(...)`. */
  tableExpr?: PyCall;
  /** Assigned names of the body, used when the class is a Python enum. */
  enumMembers: EnumMember[];
  /** `impl = String(50)` of a TypeDecorator. */
  impl?: PyValue;
  /** `metadata = MetaData(schema=...)` on a base class. */
  metadataSchema?: string;
}

interface ColSpec {
  columnName?: string;
  typeValue?: PyValue;
  foreignKeys: PyCall[];
  foreignKeyString?: PyValue;
  foreignKeyOnDelete?: PyValue;
  foreignKeyOnUpdate?: PyValue;
  primaryKey?: boolean;
  nullable?: boolean;
  unique?: boolean;
  index?: boolean;
  default?: PyValue;
  serverDefault?: PyValue;
  onUpdate?: PyValue;
  autoincrement?: boolean;
  identity?: boolean;
  computed?: PyCall;
  maxLength?: number;
  maxDigits?: number;
  decimalPlaces?: number;
  hasCheck?: boolean;
  /** The column comes from `sa_column=Column(...)`: nullability follows Column, not the annotation. */
  rawColumn?: boolean;
  /** Enum member names are saved instead of values unless values_callable says otherwise. */
}

interface ColRef {
  cls?: string;
  col: string;
}

interface RawRel {
  table: RawTable;
  key: string;
  order: number;
  targetName: string | undefined;
  backPopulates?: string;
  backref?: { name: string; uselist?: boolean };
  secondary?: PyValue;
  linkModel?: string;
  uselist?: boolean;
  /** True/false from the annotation (list[...] versus a single object); undefined without one. */
  collection?: boolean;
  foreignKeys: ColRef[];
  joinRefs: ColRef[];
  remoteSide: boolean;
  viewonly: boolean;
  synthetic: boolean;
  /** The partner of a many-to-many pair that was folded into the other side. */
  folded?: boolean;
}

interface FkTarget {
  schema?: string;
  table: string;
  /** Referenced database column names (empty means the primary key). */
  columns: string[];
}

interface RawFk {
  columns: string[];
  target: FkTarget;
  onDelete: IrOnDelete | undefined;
  onUpdate: IrOnDelete | undefined;
  name: string | undefined;
  ownerName?: string;
  reverseName?: string;
  /** Name given by back_populates / backref when the other side is not declared. */
  declaredRelatedName?: string;
  reverseScalar?: boolean;
}

interface RawColumn {
  key: string;
  field: IrField;
  /** An integer column that should count up when it is the only primary key. */
  wantsAutoIncrement: boolean;
  /** A column declared without a type takes the type of the column its foreign key points at. */
  inferFromForeignKey?: boolean;
}

interface RawIndex {
  columns: string[];
  isUnique: boolean;
  name: string | undefined;
  method: string | undefined;
  fieldOptions: Record<string, IrIndexFieldOptions>;
}

interface RawTable {
  modelName: string;
  tableName: string;
  schema?: string;
  cls?: RawClass;
  label: string;
  columns: RawColumn[];
  columnIndex: Map<string, number>;
  fks: RawFk[];
  indexes: RawIndex[];
  pk?: string[];
  pkName?: string;
  rels: RawRel[];
  m2m: IrRelation[];
  order: number;
  /** A Table() variable or class used only as the association table of a many-to-many. */
  consumed: boolean;
  /** Name of the Table() variable, when the table came from one. */
  varName?: string;
  /** The column or relationship limit was reached and the warning was given. */
  capped?: boolean;
  relsCapped?: boolean;
}

interface Ctx {
  parser: Parser;
  options: SqlAlchemyParseOptions;
  warnings: string[];
  suppressed: number;
  classes: Map<string, RawClass>;
  classList: RawClass[];
  /** Variables assigned from declarative_base() and friends. */
  baseVars: Set<string>;
  /** Annotated[...] and Optional[...] aliases: `intpk = Annotated[int, mapped_column(primary_key=True)]`. */
  aliases: Map<string, TypeExpr>;
  /** Normalized annotation text -> column type (`type_annotation_map`). */
  typeMap: Map<string, PyValue>;
  /** Table(...) assignments in the order they appear. */
  tableDefs: { varName: string; call: PyCall; filePath: string }[];
  /** Module-level `Index(...)` calls, applied after every class is read. */
  indexCalls: { call: PyCall; filePath: string }[];
  /** `registry.map_imperatively(Class, table)` calls. */
  imperative: { className: string; tableVar: string; hasProperties: boolean }[];
  enumInfos: Map<string, EnumInfo>;
  enums: IrEnum[];
  tables: RawTable[];
  byModel: Map<string, RawTable>;
  byVar: Map<string, RawTable>;
  counter: number;
  enumClassMemo: Map<string, boolean>;
  /** Table names -> tables, built once every table is read. */
  tablesByName: Map<string, RawTable[]>;
  /** Table() variable -> its definition. */
  tableDefByVar: Map<string, PyCall>;
  /** Model name -> table name for models generated as stubs. */
  stubTables: Map<string, string>;
  /** `metadata = MetaData(schema=...)` variables. */
  metadataSchemas: Map<string, string>;
  /** Base variables created with a schema-carrying MetaData. */
  baseVarSchemas: Map<string, string>;
}

interface EnumInfo {
  name: string;
  values: IrEnumValue[];
}

function warn(ctx: Ctx, message: string): void {
  if (ctx.warnings.length < MAX_WARNINGS) {
    ctx.warnings.push(message);
  } else {
    ctx.suppressed += 1;
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/** Parses SQLAlchemy and SQLModel model files into the shared IR using tree-sitter (no Python required). */
export async function parseSqlAlchemy(
  sources: SqlAlchemySourceFile[],
  options: SqlAlchemyParseOptions
): Promise<Result<IrSchema>> {
  const parserResult: Result<Parser> = await getPythonParser();
  if (!parserResult.ok) {
    return parserResult;
  }
  try {
    return buildFromSources(parserResult.value, sources, options);
  } catch (thrown) {
    return err(
      'PARSE_FAILED',
      `Failed to read the SQLAlchemy models: ${describeThrown(thrown)}`
    );
  }
}

function buildFromSources(
  parser: Parser,
  sources: SqlAlchemySourceFile[],
  options: SqlAlchemyParseOptions
): Result<IrSchema> {
  const ctx: Ctx = {
    parser,
    options,
    warnings: [],
    suppressed: 0,
    classes: new Map(),
    classList: [],
    baseVars: new Set(),
    aliases: new Map(),
    typeMap: new Map(),
    tableDefs: [],
    indexCalls: [],
    imperative: [],
    enumInfos: new Map(),
    enums: [],
    tables: [],
    byModel: new Map(),
    byVar: new Map(),
    counter: 0,
    enumClassMemo: new Map(),
    tablesByName: new Map(),
    tableDefByVar: new Map(),
    stubTables: new Map(),
    metadataSchemas: new Map(),
    baseVarSchemas: new Map(),
  };
  for (const source of sources) {
    readSource(ctx, source);
  }
  buildTables(ctx);
  applyModuleIndexes(ctx);
  resolveRelationships(ctx);
  const models: IrModel[] = finalizeAll(ctx);
  if (ctx.suppressed > 0) {
    ctx.warnings.push(
      `${ctx.suppressed} more warnings were left out to keep the output readable.`
    );
  }
  if (models.length === 0) {
    const checkedPaths: string = sources
      .map((source: SqlAlchemySourceFile) => source.path)
      .join(', ');
    return err(
      'NO_MODELS_FOUND',
      `No SQLAlchemy or SQLModel models were found in: ${checkedPaths}. A model is a class with a ` +
        `__tablename__ (or a SQLModel class declared with table=True) that declares mapped columns, ` +
        `or a Table(...) assigned to a variable.`
    );
  }
  return ok({ models, enums: ctx.enums, warnings: ctx.warnings });
}

// ---------------------------------------------------------------------------
// Reading files
// ---------------------------------------------------------------------------

function readSource(ctx: Ctx, source: SqlAlchemySourceFile): void {
  if (typeof source.text !== 'string') {
    warn(ctx, `${source.path}: the file has no text and was skipped.`);
    return;
  }
  if (source.text.length > MAX_SOURCE_LENGTH) {
    warn(
      ctx,
      `${source.path}: the file is larger than ${MAX_SOURCE_LENGTH} characters and was skipped.`
    );
    return;
  }
  let tree: Parser.Tree | null = null;
  try {
    tree = ctx.parser.parse(source.text);
    if (tree.rootNode.hasError) {
      warn(
        ctx,
        `${source.path}: the file contains Python syntax errors; some models or columns may be missing from the output.`
      );
    }
    for (const statement of tree.rootNode.namedChildren) {
      readTopLevel(ctx, source.path, statement);
    }
  } catch (thrown) {
    warn(
      ctx,
      `${source.path}: the file could not be read completely (${describeThrown(thrown)}).`
    );
  } finally {
    if (tree !== null) {
      tree.delete();
    }
  }
}

function readTopLevel(ctx: Ctx, filePath: string, statement: SyntaxNode): void {
  switch (statement.type) {
    case 'class_definition':
      readClass(ctx, filePath, statement);
      return;
    case 'decorated_definition': {
      const definition: SyntaxNode | null =
        statement.childForFieldName('definition');
      if (definition !== null && definition.type === 'class_definition') {
        readClass(ctx, filePath, definition);
      }
      return;
    }
    case 'expression_statement':
      readModuleExpression(ctx, filePath, statement);
      return;
    case 'if_statement':
    case 'try_statement': {
      // Models are sometimes declared under `if not TYPE_CHECKING:` or after a guarded import.
      const body: SyntaxNode | null =
        statement.childForFieldName('consequence');
      if (body !== null) {
        for (const nested of body.namedChildren) {
          readTopLevel(ctx, filePath, nested);
        }
      }
      return;
    }
    default:
      return;
  }
}

function assignmentParts(
  statement: SyntaxNode
):
  | { left: SyntaxNode; right: SyntaxNode | null; type: SyntaxNode | null }
  | undefined {
  const assignment: SyntaxNode | undefined = statement.namedChildren[0];
  if (assignment === undefined || assignment.type !== 'assignment') {
    return undefined;
  }
  const left: SyntaxNode | null = assignment.childForFieldName('left');
  if (left === null) {
    return undefined;
  }
  return {
    left,
    right: assignment.childForFieldName('right'),
    type: assignment.childForFieldName('type'),
  };
}

function readModuleExpression(
  ctx: Ctx,
  filePath: string,
  statement: SyntaxNode
): void {
  const parts = assignmentParts(statement);
  if (parts === undefined) {
    const expression: SyntaxNode | undefined = statement.namedChildren[0];
    if (expression !== undefined && expression.type === 'call') {
      const value: PyValue = evaluateNode(expression);
      if (value.kind === 'call') {
        const callee: string = lastSegment(value.callee);
        if (callee === 'Index') {
          ctx.indexCalls.push({ call: value, filePath });
        } else if (callee === 'map_imperatively') {
          readImperative(ctx, value);
        }
      }
    }
    return;
  }
  if (parts.left.type !== 'identifier' || parts.right === null) {
    return;
  }
  const name: string = parts.left.text;
  if (parts.right.type === 'call') {
    const value: PyValue = evaluateNode(parts.right);
    if (value.kind !== 'call') {
      return;
    }
    const callee: string = lastSegment(value.callee);
    if (callee === 'Table') {
      ctx.tableDefs.push({ varName: name, call: value, filePath });
      ctx.tableDefByVar.set(name, value);
    } else if (callee === 'MetaData') {
      const schema: string | undefined = stringOf(value.kwargs['schema']);
      if (schema !== undefined) {
        ctx.metadataSchemas.set(name, schema);
      }
    } else if (
      callee === 'declarative_base' ||
      callee === 'automap_base' ||
      callee === 'generate_base'
    ) {
      ctx.baseVars.add(name);
      const metadata: PyValue | undefined = value.kwargs['metadata'];
      const schema: string | undefined =
        metadata === undefined ? undefined : metadataSchemaOf(ctx, metadata);
      if (schema !== undefined) {
        ctx.metadataSchemas.set(`${name}.metadata`, schema);
        ctx.baseVarSchemas.set(name, schema);
      }
    }
    return;
  }
  if (
    parts.right.type === 'subscript' ||
    parts.right.type === 'generic_type' ||
    parts.right.type === 'binary_operator'
  ) {
    const alias: TypeExpr = toTypeExpr(ctx, parts.right, 0);
    if (alias.kind === 'sub' || alias.kind === 'union') {
      ctx.aliases.set(name, alias);
    }
  }
}

function readImperative(ctx: Ctx, call: PyCall): void {
  const classArg: PyValue | undefined = call.args[0];
  const tableArg: PyValue | undefined = call.args[1];
  if (
    classArg !== undefined &&
    classArg.kind === 'name' &&
    tableArg !== undefined &&
    tableArg.kind === 'name'
  ) {
    ctx.imperative.push({
      className: lastSegment(classArg.value),
      tableVar: tableArg.value,
      hasProperties: call.kwargs['properties'] !== undefined,
    });
  }
}

// ---------------------------------------------------------------------------
// Classes
// ---------------------------------------------------------------------------

function stringOf(value: PyValue | undefined): string | undefined {
  return value !== undefined && value.kind === 'string'
    ? value.value
    : undefined;
}

function boolOf(value: PyValue | undefined): boolean | undefined {
  return value !== undefined && value.kind === 'bool' ? value.value : undefined;
}

function numberOf(value: PyValue | undefined): number | undefined {
  return value !== undefined && value.kind === 'number'
    ? value.value
    : undefined;
}

function readClass(ctx: Ctx, filePath: string, node: SyntaxNode): void {
  const nameNode: SyntaxNode | null = node.childForFieldName('name');
  if (nameNode === null) {
    return;
  }
  const name: string = nameNode.text;
  const bases: string[] = [];
  const keywords: Record<string, PyValue> = {};
  const superclasses: SyntaxNode | null =
    node.childForFieldName('superclasses');
  if (superclasses !== null) {
    for (const child of superclasses.namedChildren) {
      if (child.type === 'keyword_argument') {
        const keyNode: SyntaxNode | null = child.childForFieldName('name');
        const valueNode: SyntaxNode | null = child.childForFieldName('value');
        if (keyNode !== null && valueNode !== null) {
          keywords[keyNode.text] = evaluateNode(valueNode);
        }
      } else if (child.type !== 'comment') {
        bases.push(child.text.replace(/\s+/g, ''));
      }
    }
  }
  const raw: RawClass = {
    name,
    filePath,
    order: ctx.counter,
    bases,
    keywords,
    members: [],
    isAbstract: false,
    enumMembers: [],
  };
  ctx.counter += 1;
  const body: SyntaxNode | null = node.childForFieldName('body');
  for (const statement of body === null ? [] : body.namedChildren) {
    readClassStatement(ctx, raw, statement);
  }
  if (ctx.classes.has(name)) {
    warn(
      ctx,
      `Duplicate class name "${name}" (${filePath}); only the first definition was converted.`
    );
    return;
  }
  ctx.classes.set(name, raw);
  ctx.classList.push(raw);
}

function flattenItems(value: PyValue): PyValue[] {
  return value.kind === 'list' ? value.items : [value];
}

function readClassStatement(
  ctx: Ctx,
  raw: RawClass,
  statement: SyntaxNode
): void {
  if (statement.type === 'decorated_definition') {
    const definition: SyntaxNode | null =
      statement.childForFieldName('definition');
    if (definition !== null && definition.type === 'function_definition') {
      readClassFunction(ctx, raw, definition, statement);
    }
    return;
  }
  if (statement.type !== 'expression_statement') {
    return;
  }
  const parts = assignmentParts(statement);
  if (parts === undefined || parts.left.type !== 'identifier') {
    return;
  }
  const name: string = parts.left.text;
  const value: PyValue | undefined =
    parts.right === null ? undefined : evaluateNode(parts.right);
  const annotationNode: SyntaxNode | undefined = parts.type?.namedChildren[0];
  if (name === '__tablename__') {
    raw.tableName = stringOf(value);
    return;
  }
  if (name === '__abstract__') {
    raw.isAbstract = boolOf(value) === true;
    return;
  }
  if (name === '__table_args__') {
    if (value !== undefined) {
      raw.tableArgs = flattenItems(value);
    }
    return;
  }
  if (name === '__table__') {
    if (value !== undefined && value.kind === 'call') {
      raw.tableExpr = value;
    }
    return;
  }
  if (name === 'impl' && value !== undefined) {
    raw.impl = value;
  }
  if (name === 'metadata' && value !== undefined) {
    const schema: string | undefined = metadataSchemaOf(ctx, value);
    if (schema !== undefined) {
      raw.metadataSchema = schema;
    }
    return;
  }
  if (name === 'type_annotation_map' && value !== undefined) {
    if (value.kind === 'dict') {
      for (const entry of value.entries) {
        const key: string = normalizeTypeText(valueText(entry.key));
        if (key !== '' && !ctx.typeMap.has(key)) {
          ctx.typeMap.set(key, entry.value);
        }
      }
    }
    return;
  }
  if (name.startsWith('__')) {
    return;
  }
  raw.enumMembers.push({ name, value });
  const member: RawMember = { name };
  if (annotationNode !== undefined) {
    member.annotation = toTypeExpr(ctx, annotationNode, 0);
  }
  if (value !== undefined) {
    member.value = value;
  }
  raw.members.push(member);
}

function metadataSchemaOf(ctx: Ctx, value: PyValue): string | undefined {
  if (value.kind === 'call' && lastSegment(value.callee) === 'MetaData') {
    return stringOf(value.kwargs['schema']);
  }
  if (value.kind === 'name') {
    return ctx.metadataSchemas.get(value.value);
  }
  return undefined;
}

function valueText(value: PyValue): string {
  switch (value.kind) {
    case 'name':
      return value.value;
    case 'other':
      return value.text;
    case 'string':
      return value.value;
    case 'call':
      return value.text;
    default:
      return '';
  }
}

function readClassFunction(
  ctx: Ctx,
  raw: RawClass,
  definition: SyntaxNode,
  decorated: SyntaxNode
): void {
  const nameNode: SyntaxNode | null = definition.childForFieldName('name');
  if (nameNode === null) {
    return;
  }
  const functionName: string = nameNode.text;
  const isDeclaredAttr: boolean = decorated.namedChildren.some(
    (child: SyntaxNode) =>
      child.type === 'decorator' && /declared_attr/.test(child.text)
  );
  if (!isDeclaredAttr) {
    return;
  }
  if (functionName === '__tablename__') {
    const body: SyntaxNode | null = definition.childForFieldName('body');
    const returned: SyntaxNode | undefined = body?.namedChildren.find(
      (child: SyntaxNode) => child.type === 'return_statement'
    );
    const expression: SyntaxNode | undefined = returned?.namedChildren[0];
    const text: string =
      expression === undefined ? '' : expression.text.replace(/\s+/g, '');
    if (/^cls\.__name__\.lower\(\)$/.test(text)) {
      raw.tableNameRule = 'lower';
    } else if (/^cls\.__name__$/.test(text)) {
      raw.tableNameRule = 'exact';
    } else if (/__name__/.test(text) && /snake|underscore|re\.sub/.test(text)) {
      raw.tableNameRule = 'snake';
    } else if (expression !== undefined && expression.type === 'string') {
      raw.tableName = stringOf(evaluateNode(expression));
    } else {
      warn(
        ctx,
        `${raw.name}.__tablename__: the @declared_attr could not be evaluated; the table name is derived from the class name.`
      );
      raw.tableNameRule = 'snake';
    }
    return;
  }
  warn(
    ctx,
    `${raw.name}.${functionName}: @declared_attr members are not supported and were skipped.`
  );
}

// ---------------------------------------------------------------------------
// Type expressions (annotations)
// ---------------------------------------------------------------------------

function toTypeExpr(ctx: Ctx, node: SyntaxNode, depth: number): TypeExpr {
  if (depth > MAX_TYPE_DEPTH) {
    return { kind: 'other', text: node.text.slice(0, 100) };
  }
  const next: number = depth + 1;
  switch (node.type) {
    case 'type':
    case 'parenthesized_expression': {
      const inner: SyntaxNode | undefined = node.namedChildren[0];
      return inner === undefined
        ? { kind: 'other', text: node.text }
        : toTypeExpr(ctx, inner, next);
    }
    case 'identifier':
    case 'attribute':
      return { kind: 'name', name: node.text.replace(/\s+/g, '') };
    case 'none':
      return { kind: 'none' };
    case 'string':
    case 'concatenated_string': {
      const value: PyValue = evaluateNode(node);
      return value.kind === 'string'
        ? { kind: 'str', value: value.value }
        : { kind: 'other', text: node.text.slice(0, 100) };
    }
    case 'binary_operator': {
      const left: SyntaxNode | null = node.childForFieldName('left');
      const right: SyntaxNode | null = node.childForFieldName('right');
      const operator: SyntaxNode | null = node.childForFieldName('operator');
      if (
        left === null ||
        right === null ||
        operator === null ||
        operator.text !== '|'
      ) {
        return { kind: 'other', text: node.text.slice(0, 100) };
      }
      const members: TypeExpr[] = [];
      for (const side of [left, right]) {
        const member: TypeExpr = toTypeExpr(ctx, side, next);
        if (member.kind === 'union') {
          members.push(...member.members);
        } else {
          members.push(member);
        }
      }
      return { kind: 'union', members };
    }
    case 'generic_type': {
      const baseNode: SyntaxNode | undefined = node.namedChildren[0];
      const parameters: SyntaxNode | undefined = node.namedChildren.find(
        (child: SyntaxNode) => child.type === 'type_parameter'
      );
      if (baseNode === undefined) {
        return { kind: 'other', text: node.text.slice(0, 100) };
      }
      return {
        kind: 'sub',
        base: baseNode.text.replace(/\s+/g, ''),
        args: (parameters === undefined ? [] : parameters.namedChildren).map(
          (child: SyntaxNode): TypeExpr => toTypeExpr(ctx, child, next)
        ),
      };
    }
    case 'subscript': {
      const baseNode: SyntaxNode | null = node.childForFieldName('value');
      if (baseNode === null) {
        return { kind: 'other', text: node.text.slice(0, 100) };
      }
      return {
        kind: 'sub',
        base: baseNode.text.replace(/\s+/g, ''),
        args: node
          .childrenForFieldName('subscript')
          .filter((child: SyntaxNode) => child.isNamed)
          .map((child: SyntaxNode): TypeExpr => toTypeExpr(ctx, child, next)),
      };
    }
    case 'call':
      return { kind: 'value', value: evaluateNode(node) };
    default:
      return { kind: 'other', text: node.text.slice(0, 100) };
  }
}

/** Parses the text of a string annotation such as "Mapped[list['Post']]" once. */
function typeFromString(ctx: Ctx, text: string): TypeExpr {
  const trimmed: string = text.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_STRING_ANNOTATION) {
    return { kind: 'name', name: trimmed.slice(0, MAX_STRING_ANNOTATION) };
  }
  if (/^[A-Za-z_][\w.]*$/.test(trimmed)) {
    return { kind: 'name', name: trimmed };
  }
  let tree: Parser.Tree | null = null;
  try {
    tree = ctx.parser.parse(trimmed);
    const statement: SyntaxNode | undefined = tree.rootNode.namedChildren[0];
    const expression: SyntaxNode | undefined = statement?.namedChildren[0];
    if (
      statement === undefined ||
      statement.type !== 'expression_statement' ||
      expression === undefined
    ) {
      return { kind: 'other', text: trimmed };
    }
    return toTypeExpr(ctx, expression, MAX_TYPE_DEPTH - 6);
  } finally {
    if (tree !== null) {
      tree.delete();
    }
  }
}

/** Replaces string forward references by the types they name. */
function expandStrings(ctx: Ctx, expression: TypeExpr): TypeExpr {
  return expression.kind === 'str'
    ? typeFromString(ctx, expression.value)
    : expression;
}

function renderType(expression: TypeExpr): string {
  switch (expression.kind) {
    case 'name':
      return expression.name;
    case 'sub':
      return `${expression.base}[${expression.args.map(renderType).join(',')}]`;
    case 'union':
      return expression.members.map(renderType).join('|');
    case 'str':
      return expression.value;
    case 'none':
      return 'None';
    case 'value':
      return valueText(expression.value);
    case 'other':
      return expression.text;
  }
}

function normalizeTypeText(text: string): string {
  return text.replace(/\s+/g, '').replace(/\b\w+\./g, '');
}

interface Peeled {
  /** The type with Mapped[], Optional[], Annotated[] and aliases removed. */
  core: TypeExpr;
  optional: boolean;
  /** True when a Mapped[...] wrapper was found (SQLAlchemy 2.0 style). */
  mapped: boolean;
  /** mapped_column(...) calls found in Annotated[...] metadata, outermost last. */
  metadata: PyCall[];
}

/** Unwraps Mapped[...], Optional[...], `X | None`, Annotated[...] and aliases. */
function peelType(
  ctx: Ctx,
  expression: TypeExpr | undefined,
  depth: number = 0
): Peeled {
  const result: Peeled = {
    core: expression ?? { kind: 'other', text: '' },
    optional: false,
    mapped: false,
    metadata: [],
  };
  if (expression === undefined) {
    return result;
  }
  let current: TypeExpr = expandStrings(ctx, expression);
  for (let step: number = 0; step < MAX_ALIAS_DEPTH + 8; step += 1) {
    if (depth > MAX_ALIAS_DEPTH) {
      break;
    }
    if (current.kind === 'sub') {
      const base: string = lastSegment(current.base);
      const first: TypeExpr | undefined = current.args[0];
      if (
        (base === 'Mapped' ||
          base === 'WriteOnlyMapped' ||
          base === 'DynamicMapped') &&
        first !== undefined
      ) {
        result.mapped = true;
        current = expandStrings(ctx, first);
        continue;
      }
      if (base === 'Optional' && first !== undefined) {
        result.optional = true;
        current = expandStrings(ctx, first);
        continue;
      }
      if (base === 'Union') {
        const members: TypeExpr[] = current.args.map((arg: TypeExpr) =>
          expandStrings(ctx, arg)
        );
        const rest: TypeExpr[] = members.filter(
          (member: TypeExpr) => member.kind !== 'none'
        );
        if (rest.length < members.length) {
          result.optional = true;
        }
        if (rest.length === 1 && rest[0] !== undefined) {
          current = rest[0];
          continue;
        }
        break;
      }
      if (base === 'Annotated' && first !== undefined) {
        for (const extra of current.args.slice(1)) {
          if (extra.kind === 'value' && extra.value.kind === 'call') {
            result.metadata.push(extra.value);
          }
        }
        current = expandStrings(ctx, first);
        continue;
      }
      break;
    }
    if (current.kind === 'union') {
      const rest: TypeExpr[] = current.members
        .map((member: TypeExpr) => expandStrings(ctx, member))
        .filter((member: TypeExpr) => member.kind !== 'none');
      if (rest.length < current.members.length) {
        result.optional = true;
      }
      if (rest.length === 1 && rest[0] !== undefined) {
        current = rest[0];
        continue;
      }
      break;
    }
    if (current.kind === 'name') {
      const alias: TypeExpr | undefined = ctx.aliases.get(current.name);
      if (alias !== undefined) {
        const inner: Peeled = peelType(ctx, alias, depth + 1);
        result.optional = result.optional || inner.optional;
        result.mapped = result.mapped || inner.mapped;
        result.metadata.unshift(...inner.metadata);
        current = inner.core;
      }
    }
    break;
  }
  result.core = current;
  return result;
}

/** The class name a relationship annotation points at, and whether it is a collection. */
function relationshipAnnotation(
  ctx: Ctx,
  annotation: TypeExpr | undefined
): { target: string | undefined; collection: boolean | undefined } {
  if (annotation === undefined) {
    return { target: undefined, collection: undefined };
  }
  let peeled: Peeled = peelType(ctx, annotation);
  let collection: boolean = false;
  for (let step: number = 0; step < 4; step += 1) {
    const core: TypeExpr = peeled.core;
    if (
      core.kind === 'sub' &&
      COLLECTION_TYPES.has(lastSegment(core.base).toLowerCase())
    ) {
      collection = true;
      const element: TypeExpr | undefined =
        core.args[core.args.length - 1] ?? core.args[0];
      peeled = peelType(ctx, element);
      continue;
    }
    break;
  }
  const core: TypeExpr = peeled.core;
  if (core.kind === 'name') {
    if (COLLECTION_TYPES.has(lastSegment(core.name).toLowerCase())) {
      return { target: undefined, collection: true };
    }
    return { target: lastSegment(core.name), collection };
  }
  return { target: undefined, collection };
}

// ---------------------------------------------------------------------------
// Inheritance and model detection
// ---------------------------------------------------------------------------

function resolveBase(ctx: Ctx, baseName: string): RawClass | undefined {
  return ctx.classes.get(lastSegment(baseName));
}

function isEnumClass(ctx: Ctx, cls: RawClass, depth: number = 0): boolean {
  const memo: boolean | undefined = ctx.enumClassMemo.get(cls.name);
  if (memo !== undefined) {
    return memo;
  }
  if (depth > MAX_INHERITANCE_DEPTH) {
    return false;
  }
  let result: boolean = false;
  for (const base of cls.bases) {
    if (ENUM_BASE_NAMES.has(lastSegment(base))) {
      result = true;
      break;
    }
    const parent: RawClass | undefined = resolveBase(ctx, base);
    if (
      parent !== undefined &&
      parent !== cls &&
      isEnumClass(ctx, parent, depth + 1)
    ) {
      result = true;
      break;
    }
  }
  ctx.enumClassMemo.set(cls.name, result);
  return result;
}

/** True when the class derives from a declarative base, SQLModel or Flask-SQLAlchemy's db.Model. */
function derivesFrom(
  ctx: Ctx,
  cls: RawClass,
  predicate: (baseName: string) => boolean,
  visiting: Set<string> = new Set()
): boolean {
  if (visiting.has(cls.name) || visiting.size > MAX_INHERITANCE_DEPTH) {
    return false;
  }
  visiting.add(cls.name);
  for (const base of cls.bases) {
    if (predicate(base)) {
      return true;
    }
    const parent: RawClass | undefined = resolveBase(ctx, base);
    if (parent !== undefined && derivesFrom(ctx, parent, predicate, visiting)) {
      return true;
    }
  }
  return false;
}

function isSqlModelBase(baseName: string): boolean {
  return lastSegment(baseName) === 'SQLModel';
}

function isFlaskModelBase(baseName: string): boolean {
  return /^db\.Model$/.test(baseName);
}

function isDeclarativeBase(ctx: Ctx, baseName: string): boolean {
  return (
    ROOT_BASE_NAMES.has(lastSegment(baseName)) ||
    ctx.baseVars.has(baseName) ||
    isSqlModelBase(baseName) ||
    isFlaskModelBase(baseName)
  );
}

/** A class declared directly on DeclarativeBase is the base itself, never a model. */
function isRootClass(cls: RawClass): boolean {
  return cls.bases.some((base: string) =>
    ROOT_BASE_NAMES.has(lastSegment(base))
  );
}

function inheritedRule(
  ctx: Ctx,
  cls: RawClass,
  visiting: Set<string> = new Set()
): RawClass['tableNameRule'] {
  if (cls.tableNameRule !== undefined) {
    return cls.tableNameRule;
  }
  if (visiting.has(cls.name) || visiting.size > MAX_INHERITANCE_DEPTH) {
    return undefined;
  }
  visiting.add(cls.name);
  for (const base of cls.bases) {
    const parent: RawClass | undefined = resolveBase(ctx, base);
    if (parent !== undefined) {
      const rule: RawClass['tableNameRule'] = inheritedRule(
        ctx,
        parent,
        visiting
      );
      if (rule !== undefined) {
        return rule;
      }
    }
  }
  return undefined;
}

function hasAnyColumns(cls: RawClass): boolean {
  return cls.members.length > 0;
}

/** Decides how a class maps to a table: its name, or undefined when it is not a model. */
function tableNameOf(ctx: Ctx, cls: RawClass): string | undefined {
  if (cls.isAbstract || isEnumClass(ctx, cls) || isRootClass(cls)) {
    return undefined;
  }
  if (cls.keywords['table'] !== undefined) {
    return boolOf(cls.keywords['table']) === true
      ? (cls.tableName ?? cls.name.toLowerCase())
      : undefined;
  }
  if (derivesFrom(ctx, cls, isSqlModelBase)) {
    // A SQLModel class without table=True is a plain data model (a base for table classes).
    return undefined;
  }
  if (cls.tableName !== undefined) {
    return cls.tableName;
  }
  if (cls.tableExpr !== undefined) {
    return stringOf(cls.tableExpr.args[0]) ?? toSnakeCase(cls.name);
  }
  const rule: RawClass['tableNameRule'] = inheritedRule(ctx, cls);
  if (
    rule !== undefined &&
    derivesFrom(ctx, cls, (base: string) => isDeclarativeBase(ctx, base)) &&
    hasAnyColumns(cls)
  ) {
    return rule === 'lower'
      ? cls.name.toLowerCase()
      : rule === 'exact'
        ? cls.name
        : toSnakeCase(cls.name);
  }
  if (derivesFrom(ctx, cls, isFlaskModelBase) && hasAnyColumns(cls)) {
    return toSnakeCase(cls.name);
  }
  return undefined;
}

interface Gathered {
  members: Map<string, RawMember>;
  tableArgs: PyValue[] | undefined;
  /** Mixins and abstract bases that contributed. */
  seen: Set<string>;
}

/** Collects the members of a class and of the mixins and abstract bases it inherits from. */
function gatherMembers(
  ctx: Ctx,
  cls: RawClass,
  gathered: Gathered,
  depth: number
): void {
  if (depth > MAX_INHERITANCE_DEPTH || gathered.seen.has(cls.name)) {
    return;
  }
  gathered.seen.add(cls.name);
  for (const base of cls.bases) {
    const parent: RawClass | undefined = resolveBase(ctx, base);
    if (parent === undefined || parent === cls) {
      continue;
    }
    // A concrete table is a parent in joined inheritance: its columns live in its own table.
    if (tableNameOf(ctx, parent) !== undefined) {
      continue;
    }
    gatherMembers(ctx, parent, gathered, depth + 1);
  }
  for (const member of cls.members) {
    gathered.members.delete(member.name);
    gathered.members.set(member.name, member);
  }
  if (cls.tableArgs !== undefined) {
    gathered.tableArgs = cls.tableArgs;
  }
}

// ---------------------------------------------------------------------------
// Building tables
// ---------------------------------------------------------------------------

function newTable(
  ctx: Ctx,
  init: Pick<RawTable, 'modelName' | 'tableName' | 'label'> & Partial<RawTable>
): RawTable {
  const table: RawTable = {
    columns: [],
    columnIndex: new Map(),
    fks: [],
    indexes: [],
    rels: [],
    m2m: [],
    consumed: false,
    order: ctx.counter,
    ...init,
  };
  ctx.counter += 1;
  return table;
}

function buildTables(ctx: Ctx): void {
  const imperativeByTable: Map<string, string> = new Map();
  for (const mapping of ctx.imperative) {
    imperativeByTable.set(mapping.tableVar, mapping.className);
    if (mapping.hasProperties) {
      warn(
        ctx,
        `${mapping.className}: the properties of map_imperatively(...) (relationships, column overrides) are not read.`
      );
    }
  }

  for (const cls of ctx.classList) {
    const tableName: string | undefined = tableNameOf(ctx, cls);
    const parentModel: RawClass | undefined = cls.bases
      .map((base: string) => resolveBase(ctx, base))
      .find(
        (parent: RawClass | undefined) =>
          parent !== undefined &&
          parent !== cls &&
          tableNameOf(ctx, parent) !== undefined
      );
    if (tableName === undefined) {
      if (
        parentModel !== undefined &&
        !cls.isAbstract &&
        !isEnumClass(ctx, cls) &&
        !derivesFrom(ctx, cls, isSqlModelBase) &&
        cls.members.some((member: RawMember) => memberLooksMapped(ctx, member))
      ) {
        warn(
          ctx,
          `${cls.name}: single-table inheritance from ${parentModel.name} is not supported; the subclass was skipped.`
        );
      }
      continue;
    }
    // Flask-SQLAlchemy and similar: a subclass of a concrete model with no table of its own.
    if (
      parentModel !== undefined &&
      cls.tableName === undefined &&
      cls.tableExpr === undefined &&
      cls.keywords['table'] === undefined &&
      inheritedRule(ctx, cls) === undefined
    ) {
      warn(
        ctx,
        `${cls.name}: single-table inheritance from ${parentModel.name} is not supported; the subclass was skipped.`
      );
      continue;
    }
    const table: RawTable = newTable(ctx, {
      modelName: cls.name,
      tableName,
      label: cls.name,
      cls,
    });
    buildClassTable(ctx, table, cls);
    ctx.byModel.set(cls.name, table);
    ctx.tables.push(table);
  }

  // Module-level Table(...) objects: association tables, imperative mappings or plain tables.
  for (const definition of ctx.tableDefs) {
    const tableName: string | undefined = stringOf(definition.call.args[0]);
    if (tableName === undefined) {
      warn(
        ctx,
        `${definition.varName}: the name of the Table is not a string literal; it was skipped.`
      );
      continue;
    }
    const mappedClass: string | undefined = imperativeByTable.get(
      definition.varName
    );
    const table: RawTable = newTable(ctx, {
      modelName:
        mappedClass ?? toPascalCase(singularize(toSnakeCase(tableName))),
      tableName,
      label: mappedClass ?? tableName,
      varName: definition.varName,
    });
    const schema: string | undefined = stringOf(
      definition.call.kwargs['schema']
    );
    if (schema !== undefined) {
      table.schema = schema;
    }
    buildFromTableCall(ctx, table, definition.call);
    ctx.byVar.set(definition.varName, table);
    ctx.tables.push(table);
    if (!ctx.byModel.has(table.modelName)) {
      ctx.byModel.set(table.modelName, table);
    }
  }

  for (const table of ctx.tables) {
    const same: RawTable[] = ctx.tablesByName.get(table.tableName) ?? [];
    same.push(table);
    ctx.tablesByName.set(table.tableName, same);
  }
}

/** True when a class member declares a column or relationship (so a table-less subclass is worth a warning). */
function memberLooksMapped(ctx: Ctx, member: RawMember): boolean {
  if (member.value !== undefined && member.value.kind === 'call') {
    const lowered: string = lowerCallee(member.value);
    return (
      lowered === 'mapped_column' ||
      lowered === 'column' ||
      lowered === 'relationship'
    );
  }
  return (
    member.annotation !== undefined && peelType(ctx, member.annotation).mapped
  );
}

function buildFromTableCall(ctx: Ctx, table: RawTable, call: PyCall): void {
  const rest: PyValue[] = call.args.slice(2);
  for (const item of rest) {
    if (item.kind !== 'call') {
      continue;
    }
    const callee: string = lastSegment(item.callee);
    if (callee === 'Column') {
      const spec: ColSpec = specFromCall(item);
      addColumn(ctx, table, spec.columnName ?? '', spec, undefined, 'classic');
    }
  }
  for (const item of rest) {
    if (item.kind === 'call' && lastSegment(item.callee) !== 'Column') {
      applyTableItem(ctx, table, item);
    }
  }
  if (call.kwargs['autoload_with'] !== undefined) {
    warn(
      ctx,
      `${table.label}: the Table is reflected from a database (autoload_with); no columns are known.`
    );
  }
}

function buildClassTable(ctx: Ctx, table: RawTable, cls: RawClass): void {
  const gathered: Gathered = {
    members: new Map(),
    tableArgs: undefined,
    seen: new Set(),
  };
  gatherMembers(ctx, cls, gathered, 0);
  const isSqlModel: boolean = derivesFrom(ctx, cls, isSqlModelBase);
  const defaultSchema: string | undefined = inheritedSchema(ctx, cls);
  if (defaultSchema !== undefined) {
    table.schema = defaultSchema;
  }
  if (cls.tableExpr !== undefined) {
    buildFromTableCall(ctx, table, cls.tableExpr);
    const schema: string | undefined = stringOf(cls.tableExpr.kwargs['schema']);
    if (schema !== undefined) {
      table.schema = schema;
    }
  }
  for (const member of gathered.members.values()) {
    readMember(ctx, table, member, isSqlModel);
  }
  if (gathered.tableArgs !== undefined) {
    for (const item of gathered.tableArgs) {
      if (item.kind === 'dict') {
        for (const entry of item.entries) {
          if (stringOf(entry.key) === 'schema') {
            const schema: string | undefined = stringOf(entry.value);
            if (schema !== undefined) {
              table.schema = schema;
            }
          }
        }
      } else if (item.kind === 'call') {
        applyTableItem(ctx, table, item);
      } else if (item.kind !== 'string') {
        warn(
          ctx,
          `${table.label}.__table_args__: an entry that is not a constraint, index or dict was ignored.`
        );
      }
    }
  }
}

/** The schema of the MetaData a class's base was created with. */
function inheritedSchema(
  ctx: Ctx,
  cls: RawClass,
  visiting: Set<string> = new Set()
): string | undefined {
  if (cls.metadataSchema !== undefined) {
    return cls.metadataSchema;
  }
  if (visiting.has(cls.name) || visiting.size > MAX_INHERITANCE_DEPTH) {
    return undefined;
  }
  visiting.add(cls.name);
  for (const base of cls.bases) {
    const fromVar: string | undefined = ctx.baseVarSchemas.get(base);
    if (fromVar !== undefined) {
      return fromVar;
    }
    const parent: RawClass | undefined = resolveBase(ctx, base);
    if (parent !== undefined) {
      const schema: string | undefined = inheritedSchema(ctx, parent, visiting);
      if (schema !== undefined) {
        return schema;
      }
    }
  }
  return undefined;
}

function lowerCallee(call: PyCall): string {
  return lastSegment(call.callee).toLowerCase();
}

function readMember(
  ctx: Ctx,
  table: RawTable,
  member: RawMember,
  isSqlModel: boolean
): void {
  const location: string = `${table.label}.${member.name}`;
  const value: PyValue | undefined = member.value;
  if (value !== undefined && value.kind === 'call') {
    const callee: string = lastSegment(value.callee);
    const lowered: string = callee.toLowerCase();
    if (lowered === 'relationship' || callee === 'Relationship') {
      addRelationship(ctx, table, member, value);
      return;
    }
    if (UNSUPPORTED_ATTRIBUTES.has(callee)) {
      warn(
        ctx,
        `${location}: ${callee}(...) is not supported and was skipped.`
      );
      return;
    }
    if (IGNORED_ATTRIBUTES.has(callee)) {
      return;
    }
    if (lowered === 'mapped_column' || lowered === 'column') {
      const spec: ColSpec = mergeAnnotationSpec(
        ctx,
        specFromCall(value),
        member.annotation
      );
      addColumn(
        ctx,
        table,
        member.name,
        spec,
        member.annotation,
        lowered === 'column' ? 'classic' : 'mapped'
      );
      return;
    }
    if (callee === 'Field') {
      addSqlModelField(ctx, table, member, value);
      return;
    }
    if (member.annotation !== undefined && isSqlModel) {
      // SQLModel field with a default produced by a call: `created: datetime = datetime.utcnow()`.
      addColumn(
        ctx,
        table,
        member.name,
        mergeAnnotationSpec(
          ctx,
          { foreignKeys: [], default: value },
          member.annotation
        ),
        member.annotation,
        'sqlmodel'
      );
      return;
    }
    if (member.annotation !== undefined) {
      const peeled: Peeled = peelType(ctx, member.annotation);
      if (peeled.mapped) {
        warn(
          ctx,
          `${location}: ${callee}(...) is not a column or relationship constructor ormbridge reads; the attribute was skipped.`
        );
      }
    }
    return;
  }
  if (member.annotation === undefined) {
    return;
  }
  const peeled: Peeled = peelType(ctx, member.annotation);
  if (peeled.mapped) {
    // `name: Mapped[int]` with no mapped_column(...): a plain column.
    addColumn(
      ctx,
      table,
      member.name,
      mergeAnnotationSpec(ctx, { foreignKeys: [] }, member.annotation),
      member.annotation,
      'mapped'
    );
    return;
  }
  if (isSqlModel) {
    if (
      /^ClassVar/.test(renderType(member.annotation)) ||
      isModelReference(ctx, member.annotation)
    ) {
      return;
    }
    const spec: ColSpec = mergeAnnotationSpec(
      ctx,
      value === undefined
        ? { foreignKeys: [] }
        : { foreignKeys: [], default: value },
      member.annotation
    );
    addColumn(ctx, table, member.name, spec, member.annotation, 'sqlmodel');
  }
}

/** True when an annotation names another model class (a SQLModel relationship type). */
function isModelReference(ctx: Ctx, annotation: TypeExpr): boolean {
  const target: string | undefined = relationshipAnnotation(
    ctx,
    annotation
  ).target;
  if (target === undefined) {
    return false;
  }
  const cls: RawClass | undefined = ctx.classes.get(target);
  return cls !== undefined && !isEnumClass(ctx, cls);
}

// ---------------------------------------------------------------------------
// Column specifications
// ---------------------------------------------------------------------------

function mergeSpecs(base: ColSpec, over: ColSpec): ColSpec {
  const merged: ColSpec = {
    ...base,
    foreignKeys: [...base.foreignKeys, ...over.foreignKeys],
  };
  for (const [key, value] of Object.entries(over)) {
    if (key !== 'foreignKeys' && value !== undefined) {
      (merged as unknown as Record<string, unknown>)[key] = value;
    }
  }
  return merged;
}

/** Adds the mapped_column(...) calls found in Annotated[...] aliases beneath the column's own arguments. */
function mergeAnnotationSpec(
  ctx: Ctx,
  spec: ColSpec,
  annotation: TypeExpr | undefined
): ColSpec {
  const peeled: Peeled = peelType(ctx, annotation);
  let merged: ColSpec = { foreignKeys: [] };
  for (const call of peeled.metadata) {
    const lowered: string = lowerCallee(call);
    if (lowered === 'mapped_column' || lowered === 'column') {
      merged = mergeSpecs(merged, specFromCall(call));
    }
  }
  return mergeSpecs(merged, spec);
}

function specFromCall(call: PyCall): ColSpec {
  const spec: ColSpec = { foreignKeys: [] };
  call.args.forEach((argument: PyValue, index: number): void => {
    if (argument.kind === 'string') {
      if (index === 0) {
        spec.columnName = argument.value;
      }
      return;
    }
    if (argument.kind === 'call') {
      const lowered: string = lowerCallee(argument);
      if (lowered === 'foreignkey') {
        spec.foreignKeys.push(argument);
        return;
      }
      if (lowered === 'identity' || lowered === 'sequence') {
        spec.identity = true;
        return;
      }
      if (lowered === 'computed') {
        spec.computed = argument;
        return;
      }
      if (lowered === 'checkconstraint') {
        spec.hasCheck = true;
        return;
      }
      if (NON_TYPE_CALLS.has(lowered)) {
        return;
      }
    }
    if (
      (argument.kind === 'call' || argument.kind === 'name') &&
      spec.typeValue === undefined
    ) {
      spec.typeValue = argument;
    }
  });
  const kwargs: Record<string, PyValue> = call.kwargs;
  const name: string | undefined = stringOf(kwargs['name']);
  if (name !== undefined) {
    spec.columnName = name;
  }
  if (kwargs['type_'] !== undefined) {
    spec.typeValue = kwargs['type_'];
  }
  const flags: [keyof ColSpec, string][] = [
    ['primaryKey', 'primary_key'],
    ['nullable', 'nullable'],
    ['unique', 'unique'],
    ['index', 'index'],
  ];
  for (const [target, key] of flags) {
    const flag: boolean | undefined = boolOf(kwargs[key]);
    if (flag !== undefined) {
      (spec as unknown as Record<string, unknown>)[target] = flag;
    }
  }
  const autoincrement: PyValue | undefined = kwargs['autoincrement'];
  if (autoincrement !== undefined) {
    spec.autoincrement = boolOf(autoincrement) ?? true;
  }
  spec.default = kwargs['default'] ?? kwargs['insert_default'];
  if (kwargs['default_factory'] !== undefined) {
    spec.default = kwargs['default_factory'];
  }
  spec.serverDefault = kwargs['server_default'];
  spec.onUpdate = kwargs['onupdate'];
  return stripUndefined(spec);
}

function stripUndefined<T extends object>(value: T): T {
  const cleaned: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined) {
      cleaned[key] = entry;
    }
  }
  return cleaned as T;
}

function addSqlModelField(
  ctx: Ctx,
  table: RawTable,
  member: RawMember,
  call: PyCall
): void {
  const kwargs: Record<string, PyValue> = call.kwargs;
  let spec: ColSpec = { foreignKeys: [] };
  const flags: [keyof ColSpec, string][] = [
    ['primaryKey', 'primary_key'],
    ['nullable', 'nullable'],
    ['unique', 'unique'],
    ['index', 'index'],
  ];
  for (const [target, key] of flags) {
    const flag: boolean | undefined = boolOf(kwargs[key]);
    if (flag !== undefined) {
      (spec as unknown as Record<string, unknown>)[target] = flag;
    }
  }
  const maxLength: number | undefined = numberOf(kwargs['max_length']);
  if (maxLength !== undefined) {
    spec.maxLength = maxLength;
  }
  const maxDigits: number | undefined = numberOf(kwargs['max_digits']);
  if (maxDigits !== undefined) {
    spec.maxDigits = maxDigits;
  }
  const decimalPlaces: number | undefined = numberOf(kwargs['decimal_places']);
  if (decimalPlaces !== undefined) {
    spec.decimalPlaces = decimalPlaces;
  }
  if (kwargs['foreign_key'] !== undefined) {
    spec.foreignKeyString = kwargs['foreign_key'];
  }
  if (kwargs['ondelete'] !== undefined) {
    spec.foreignKeyOnDelete = kwargs['ondelete'];
  }
  spec.default = kwargs['default'] ?? kwargs['default_factory'];
  if (kwargs['default_factory'] !== undefined) {
    spec.default = kwargs['default_factory'];
  }
  if (kwargs['sa_type'] !== undefined) {
    spec.typeValue = kwargs['sa_type'];
  }
  const columnKwargs: PyValue | undefined = kwargs['sa_column_kwargs'];
  if (columnKwargs !== undefined && columnKwargs.kind === 'dict') {
    const extra: Record<string, PyValue> = {};
    for (const entry of columnKwargs.entries) {
      const key: string | undefined = stringOf(entry.key);
      if (key !== undefined) {
        extra[key] = entry.value;
      }
    }
    spec = mergeSpecs(
      spec,
      specFromCall({
        kind: 'call',
        callee: 'Column',
        args: [],
        kwargs: extra,
        text: '',
      })
    );
  }
  const columnArgs: PyValue | undefined = kwargs['sa_column_args'];
  if (columnArgs !== undefined && columnArgs.kind === 'list') {
    spec = mergeSpecs(
      spec,
      specFromCall({
        kind: 'call',
        callee: 'Column',
        args: columnArgs.items,
        kwargs: {},
        text: '',
      })
    );
  }
  const saColumn: PyValue | undefined = kwargs['sa_column'];
  if (saColumn !== undefined) {
    if (saColumn.kind === 'call') {
      // SQLModel uses the Column as it is: the other Field arguments only describe the pydantic field.
      spec = mergeSpecs(
        {
          foreignKeys: [],
          ...(spec.maxLength === undefined
            ? {}
            : { maxLength: spec.maxLength }),
          rawColumn: true,
        },
        specFromCall(saColumn)
      );
    } else {
      warn(
        ctx,
        `${table.label}.${member.name}: sa_column could not be evaluated; the Field arguments were used.`
      );
    }
  }
  addColumn(
    ctx,
    table,
    member.name,
    mergeAnnotationSpec(ctx, spec, member.annotation),
    member.annotation,
    'sqlmodel'
  );
}

// ---------------------------------------------------------------------------
// Columns
// ---------------------------------------------------------------------------

type ColumnStyle = 'mapped' | 'classic' | 'sqlmodel';

interface ResolvedType {
  type: IrScalarType;
  maxLength?: number;
  maxDigits?: number;
  decimalPlaces?: number;
  enumName?: string;
  arrayDepth?: number;
  rangeOf?: IrRangeSubtype;
  unsupportedType?: string;
}

function addColumn(
  ctx: Ctx,
  table: RawTable,
  key: string,
  spec: ColSpec,
  annotation: TypeExpr | undefined,
  style: ColumnStyle
): void {
  if (key === '') {
    warn(
      ctx,
      `${table.label}: a Column without a name was skipped (the first argument of Column(...) in a Table must be the column name).`
    );
    return;
  }
  const location: string = `${table.label}.${key}`;
  const peeled: Peeled = peelType(ctx, annotation);
  if (spec.hasCheck === true) {
    warn(
      ctx,
      `${location}: a CheckConstraint on the column was ignored (check constraints are not part of the shared model).`
    );
  }
  const inferFromForeignKey: boolean =
    spec.typeValue === undefined &&
    annotation === undefined &&
    (spec.foreignKeys.length > 0 || spec.foreignKeyString !== undefined);
  const resolved: ResolvedType = inferFromForeignKey
    ? { type: 'int' }
    : resolveColumnType(ctx, spec, peeled, table, key, location);
  const isPrimary: boolean = spec.primaryKey === true;
  const isNullable: boolean = isPrimary
    ? false
    : (spec.nullable ??
      (spec.rawColumn !== true && (peeled.mapped || style === 'sqlmodel')
        ? peeled.optional
        : true));
  const field: IrField = {
    name: key,
    columnName: spec.columnName ?? key,
    type: resolved.type,
    isPrimaryKey: isPrimary,
    isUnique: spec.unique === true,
    isNullable,
    isAutoUpdated: false,
  };
  if (resolved.maxLength !== undefined) {
    field.maxLength = resolved.maxLength;
  }
  if (resolved.maxDigits !== undefined) {
    field.maxDigits = resolved.maxDigits;
  }
  if (resolved.decimalPlaces !== undefined) {
    field.decimalPlaces = resolved.decimalPlaces;
  }
  if (resolved.enumName !== undefined) {
    field.enumName = resolved.enumName;
  }
  if (resolved.arrayDepth !== undefined) {
    field.arrayDepth = resolved.arrayDepth;
  }
  if (resolved.rangeOf !== undefined) {
    field.rangeOf = resolved.rangeOf;
  }
  if (resolved.unsupportedType !== undefined) {
    field.unsupportedType = resolved.unsupportedType;
  }
  if (spec.maxLength !== undefined && field.maxLength === undefined) {
    field.maxLength = spec.maxLength;
  }
  if (spec.maxDigits !== undefined && field.maxDigits === undefined) {
    field.maxDigits = spec.maxDigits;
  }
  if (spec.decimalPlaces !== undefined && field.decimalPlaces === undefined) {
    field.decimalPlaces = spec.decimalPlaces;
  }

  if (spec.computed !== undefined) {
    const expression: PyValue | undefined = spec.computed.args[0];
    field.generated = {
      expression: expression === undefined ? '' : valueText(expression) || '',
      isStored: boolOf(spec.computed.kwargs['persisted']) === true,
    };
  }
  applyDefaults(ctx, field, spec, resolved, location);

  const column: RawColumn = {
    key,
    field,
    ...(inferFromForeignKey ? { inferFromForeignKey: true } : {}),
    wantsAutoIncrement:
      spec.identity === true ||
      spec.autoincrement === true ||
      (spec.autoincrement !== false &&
        (resolved.type === 'int' || resolved.type === 'bigInt') &&
        resolved.arrayDepth === undefined),
  };
  if (spec.identity === true || spec.autoincrement === true) {
    column.wantsAutoIncrement = true;
    field.default ??= { kind: 'autoIncrement' };
  }
  const existing: number | undefined = table.columnIndex.get(key);
  if (existing !== undefined) {
    table.columns[existing] = column;
  } else if (table.columns.length >= MAX_COLUMNS_PER_TABLE) {
    if (table.capped !== true) {
      table.capped = true;
      warn(
        ctx,
        `${table.label}: more than ${MAX_COLUMNS_PER_TABLE} columns; the rest were skipped.`
      );
    }
    return;
  } else {
    table.columnIndex.set(key, table.columns.length);
    table.columns.push(column);
  }

  // Foreign keys.
  const foreignKeyCalls: PyCall[] = spec.foreignKeys;
  if (foreignKeyCalls.length > 1) {
    warn(
      ctx,
      `${location}: several ForeignKey(...) arguments on one column; only the first was kept.`
    );
  }
  const first: PyCall | undefined = foreignKeyCalls[0];
  if (first !== undefined) {
    addColumnForeignKey(ctx, table, key, first, location);
  } else if (spec.foreignKeyString !== undefined) {
    const target: FkTarget | undefined = parseFkTarget(
      ctx,
      spec.foreignKeyString,
      table
    );
    if (target === undefined) {
      warn(
        ctx,
        `${location}: foreign_key could not be evaluated; the column is kept without a foreign key.`
      );
    } else {
      table.fks.push({
        columns: [key],
        target,
        onDelete: actionOf(ctx, spec.foreignKeyOnDelete, location, 'ondelete'),
        onUpdate: undefined,
        name: undefined,
      });
    }
  }

  if (spec.index === true && spec.unique !== true) {
    table.indexes.push({
      columns: [key],
      isUnique: false,
      name: undefined,
      method: undefined,
      fieldOptions: {},
    });
  }
}

function addColumnForeignKey(
  ctx: Ctx,
  table: RawTable,
  key: string,
  call: PyCall,
  location: string
): void {
  const targetArgument: PyValue | undefined =
    call.args[0] ?? call.kwargs['column'];
  const target: FkTarget | undefined =
    targetArgument === undefined
      ? undefined
      : parseFkTarget(ctx, targetArgument, table);
  if (target === undefined) {
    warn(
      ctx,
      `${location}: the target of ForeignKey(...) could not be evaluated; the column is kept without a foreign key.`
    );
    return;
  }
  table.fks.push({
    columns: [key],
    target,
    onDelete: actionOf(ctx, call.kwargs['ondelete'], location, 'ondelete'),
    onUpdate: actionOf(ctx, call.kwargs['onupdate'], location, 'onupdate'),
    name: stringOf(call.kwargs['name']),
  });
}

function actionOf(
  ctx: Ctx,
  value: PyValue | undefined,
  location: string,
  label: string
): IrOnDelete | undefined {
  const text: string | undefined = stringOf(value);
  if (text === undefined) {
    return undefined;
  }
  const mapped: IrOnDelete | undefined =
    ON_ACTION_MAP[text.trim().toUpperCase().replace(/_/g, ' ')];
  if (mapped === undefined) {
    warn(
      ctx,
      `${location}: ${label}="${text}" has no equivalent and was converted to NO ACTION.`
    );
    return 'noAction';
  }
  return mapped;
}

/** Reads the target of ForeignKey("table.column"), ForeignKey(Model.column) or ForeignKey(table.c.column). */
function parseFkTarget(
  ctx: Ctx,
  value: PyValue,
  owner: RawTable
): FkTarget | undefined {
  if (value.kind === 'string') {
    const parts: string[] = value.value
      .split('.')
      .map((part: string) => part.trim());
    if (parts.length === 0 || parts.some((part: string) => part === '')) {
      return undefined;
    }
    if (parts.length === 1) {
      return { table: parts[0] as string, columns: [] };
    }
    if (parts.length === 2) {
      return { table: parts[0] as string, columns: [parts[1] as string] };
    }
    const column: string = parts[parts.length - 1] as string;
    const tableName: string = parts[parts.length - 2] as string;
    return {
      schema: parts.slice(0, -2).join('.'),
      table: tableName,
      columns: [column],
    };
  }
  if (value.kind === 'name') {
    const parts: string[] = value.value
      .split('.')
      .filter((part: string) => part !== '__table__' && part !== 'c');
    if (parts.length !== 2) {
      return undefined;
    }
    const holder: string = parts[0] as string;
    const column: string = parts[1] as string;
    const viaClass: RawClass | undefined = ctx.classes.get(holder);
    if (viaClass !== undefined) {
      const name: string | undefined = tableNameOf(ctx, viaClass);
      const columnName: string = attributeColumnName(viaClass, column);
      return name === undefined
        ? undefined
        : { table: name, columns: [columnName] };
    }
    const viaVar: PyCall | undefined = ctx.tableDefByVar.get(holder);
    const varTable: string | undefined = stringOf(viaVar?.args[0]);
    if (varTable !== undefined) {
      return { table: varTable, columns: [column] };
    }
    if (holder === owner.modelName) {
      return { table: owner.tableName, columns: [column] };
    }
    return undefined;
  }
  return undefined;
}

/** The database column name of an attribute of a class (mapped_column("name") overrides the attribute name). */
function attributeColumnName(cls: RawClass, attribute: string): string {
  const member: RawMember | undefined = cls.members.find(
    (candidate: RawMember) => candidate.name === attribute
  );
  if (
    member !== undefined &&
    member.value !== undefined &&
    member.value.kind === 'call'
  ) {
    const explicit: string | undefined =
      stringOf(member.value.args[0]) ?? stringOf(member.value.kwargs['name']);
    if (explicit !== undefined) {
      return explicit;
    }
  }
  return attribute;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

function resolveColumnType(
  ctx: Ctx,
  spec: ColSpec,
  peeled: Peeled,
  table: RawTable,
  key: string,
  location: string
): ResolvedType {
  if (spec.typeValue !== undefined) {
    return resolveSaType(ctx, spec.typeValue, table, key, location, 0);
  }
  return resolvePythonType(ctx, peeled, table, key, location);
}

function typeNameOf(value: PyValue): string | undefined {
  if (value.kind === 'call') {
    return lastSegment(value.callee);
  }
  if (value.kind === 'name') {
    return lastSegment(value.value);
  }
  return undefined;
}

function resolveSaType(
  ctx: Ctx,
  value: PyValue,
  table: RawTable,
  key: string,
  location: string,
  depth: number
): ResolvedType {
  const name: string | undefined = typeNameOf(value);
  if (name === undefined || depth > MAX_ALIAS_DEPTH) {
    warn(ctx, `${location}: the column type could not be evaluated.`);
    return { type: 'unsupported', unsupportedType: valueText(value) };
  }
  const args: PyValue[] = value.kind === 'call' ? value.args : [];
  const kwargs: Record<string, PyValue> =
    value.kind === 'call' ? value.kwargs : {};
  const lowered: string = name.toLowerCase();

  if (lowered === 'enum') {
    return resolveEnumType(ctx, args, kwargs, table, key, location);
  }
  if (lowered === 'array') {
    const inner: PyValue | undefined = args[0];
    if (inner === undefined) {
      warn(ctx, `${location}: ARRAY(...) has no item type.`);
      return { type: 'unsupported', unsupportedType: 'ARRAY' };
    }
    const element: ResolvedType = resolveSaType(
      ctx,
      inner,
      table,
      key,
      location,
      depth + 1
    );
    const dimensions: number = numberOf(kwargs['dimensions']) ?? 1;
    return {
      ...element,
      arrayDepth:
        (element.arrayDepth ?? 0) + Math.max(1, Math.floor(dimensions)),
    };
  }
  const decorator: RawClass | undefined = ctx.classes.get(name);
  if (decorator !== undefined) {
    if (decorator.impl !== undefined) {
      return resolveSaType(
        ctx,
        decorator.impl,
        table,
        key,
        location,
        depth + 1
      );
    }
    if (isEnumClass(ctx, decorator)) {
      return resolveEnumType(ctx, [value], kwargs, table, key, location);
    }
  }
  const spec: TypeSpec | undefined = SA_TYPES[lowered];
  if (spec === undefined) {
    warn(
      ctx,
      `${location}: the column type ${name} is not known; the column was kept as an unsupported type.`
    );
    return {
      type: 'unsupported',
      unsupportedType: describeTypeCall(value, name),
    };
  }
  const resolved: ResolvedType = { type: spec.type };
  if (spec.rangeOf !== undefined) {
    resolved.rangeOf = spec.rangeOf;
  }
  if (spec.length === true) {
    const length: number | undefined =
      numberOf(args[0]) ?? numberOf(kwargs['length']);
    if (length !== undefined) {
      resolved.maxLength = length;
    }
  }
  if (spec.numeric === true) {
    const precision: number | undefined =
      numberOf(args[0]) ?? numberOf(kwargs['precision']);
    const scale: number | undefined =
      numberOf(args[1]) ?? numberOf(kwargs['scale']);
    if (precision !== undefined) {
      resolved.maxDigits = precision;
    }
    if (scale !== undefined) {
      resolved.decimalPlaces = scale;
    }
  }
  return resolved;
}

/** `Geometry("POINT")` -> `Geometry(POINT)`: the database type text without quotes. */
function describeTypeCall(value: PyValue, name: string): string {
  if (value.kind !== 'call' || value.args.length === 0) {
    return name;
  }
  const parts: string[] = value.args.map((argument: PyValue): string =>
    argument.kind === 'string' ? argument.value : valueText(argument)
  );
  return `${name}(${parts.join(', ').replace(/["\\]/g, '')})`.slice(0, 100);
}

function resolvePythonType(
  ctx: Ctx,
  peeled: Peeled,
  table: RawTable,
  key: string,
  location: string
): ResolvedType {
  const core: TypeExpr = peeled.core;
  const mapped: PyValue | undefined = ctx.typeMap.get(
    normalizeTypeText(renderType(core))
  );
  if (mapped !== undefined) {
    return resolveSaType(ctx, mapped, table, key, location, 1);
  }
  if (core.kind === 'sub' && lastSegment(core.base) === 'Literal') {
    const literals: PyValue[] = core.args.flatMap((arg: TypeExpr): PyValue[] =>
      arg.kind === 'str' ? [{ kind: 'string', value: arg.value }] : []
    );
    if (literals.length > 0 && literals.length === core.args.length) {
      return resolveEnumType(ctx, literals, {}, table, key, location);
    }
  }
  if (core.kind === 'name') {
    const name: string = lastSegment(core.name);
    const cls: RawClass | undefined = ctx.classes.get(name);
    if (cls !== undefined && isEnumClass(ctx, cls)) {
      return resolveEnumType(
        ctx,
        [{ kind: 'name', value: name }],
        {},
        table,
        key,
        location
      );
    }
    const spec: TypeSpec | undefined = PY_TYPES[name];
    if (spec !== undefined) {
      return { type: spec.type };
    }
    warn(
      ctx,
      `${location}: the Python type ${renderType(core)} has no known column type; the column was kept as an unsupported type (give mapped_column a SQLAlchemy type).`
    );
    return { type: 'unsupported', unsupportedType: renderType(core) };
  }
  const text: string = renderType(core);
  if (text === '') {
    warn(ctx, `${location}: the column has no type.`);
    return { type: 'unsupported', unsupportedType: 'unknown' };
  }
  warn(
    ctx,
    `${location}: the type ${text} has no known column type; the column was kept as an unsupported type.`
  );
  return { type: 'unsupported', unsupportedType: text.slice(0, 100) };
}

function enumMemberName(value: string, used: Set<string>): string {
  let name: string = value
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase();
  if (name.length === 0 || /^[0-9]/.test(name)) {
    name = `V_${name}`;
  }
  let candidate: string = name;
  let suffix: number = 2;
  while (used.has(candidate)) {
    candidate = `${name}_${suffix}`;
    suffix += 1;
  }
  used.add(candidate);
  return candidate;
}

function resolveEnumType(
  ctx: Ctx,
  args: PyValue[],
  kwargs: Record<string, PyValue>,
  table: RawTable,
  key: string,
  location: string
): ResolvedType {
  const explicitName: string | undefined = stringOf(kwargs['name']);
  const valuesCallable: PyValue | undefined = kwargs['values_callable'];
  const first: PyValue | undefined = args[0];
  if (first !== undefined && first.kind === 'name') {
    const cls: RawClass | undefined = ctx.classes.get(lastSegment(first.value));
    if (cls === undefined || !isEnumClass(ctx, cls)) {
      warn(
        ctx,
        `${location}: the enum ${first.value} is not defined in the input; the column was kept as a string.`
      );
      return { type: 'string' };
    }
    const useValues: boolean =
      valuesCallable !== undefined &&
      /\.value\b|\bvalue\b/.test(valueText(valuesCallable));
    const known: EnumInfo | undefined = ctx.enumInfos.get(cls.name);
    if (known !== undefined) {
      return { type: 'string', enumName: known.name };
    }
    const members: EnumMember[] = enumMembersOf(ctx, cls);
    const values: IrEnumValue[] = members.map(
      (member: EnumMember): IrEnumValue => {
        const raw: PyValue | undefined = member.value;
        const stored: string =
          useValues && raw !== undefined
            ? raw.kind === 'string'
              ? raw.value
              : raw.kind === 'number'
                ? String(raw.value)
                : member.name
            : member.name;
        return { name: member.name, dbValue: stored };
      }
    );
    return registerEnum(ctx, cls.name, values, explicitName);
  }
  const literals: string[] = [];
  for (const argument of args) {
    if (argument.kind === 'string') {
      literals.push(argument.value);
    }
  }
  if (literals.length === 0 || literals.length !== args.length) {
    warn(
      ctx,
      `${location}: the enum values could not be evaluated; the column was kept as a string.`
    );
    return { type: 'string' };
  }
  const enumName: string =
    explicitName === undefined
      ? `${table.modelName}${toPascalCase(key)}`
      : toPascalCase(explicitName);
  const used: Set<string> = new Set();
  const values: IrEnumValue[] = literals.map(
    (literal: string): IrEnumValue => ({
      name: enumMemberName(literal, used),
      dbValue: literal,
    })
  );
  return registerEnum(ctx, enumName, values, explicitName);
}

function enumMembersOf(ctx: Ctx, cls: RawClass): EnumMember[] {
  const members: EnumMember[] = [];
  const seen: Set<string> = new Set();
  const visit: (current: RawClass, depth: number) => void = (
    current: RawClass,
    depth: number
  ): void => {
    if (depth > MAX_INHERITANCE_DEPTH) {
      return;
    }
    for (const base of current.bases) {
      const parent: RawClass | undefined = resolveBase(ctx, base);
      if (parent !== undefined && parent !== current) {
        visit(parent, depth + 1);
      }
    }
    for (const member of current.enumMembers) {
      if (
        member.name.startsWith('_') ||
        seen.has(member.name) ||
        (member.value !== undefined &&
          member.value.kind === 'call' &&
          lastSegment(member.value.callee) === 'property')
      ) {
        continue;
      }
      seen.add(member.name);
      members.push(member);
    }
  };
  visit(cls, 0);
  return members;
}

function registerEnum(
  ctx: Ctx,
  name: string,
  values: IrEnumValue[],
  dbName: string | undefined
): ResolvedType {
  const existing: EnumInfo | undefined = ctx.enumInfos.get(name);
  if (existing !== undefined) {
    return { type: 'string', enumName: existing.name };
  }
  ctx.enumInfos.set(name, { name, values });
  ctx.enums.push({
    name,
    values,
    ...(dbName === undefined || dbName === name ? {} : { dbName }),
  });
  return { type: 'string', enumName: name };
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const NOW_CALLABLES: ReadonlySet<string> = new Set([
  'now',
  'utcnow',
  'today',
  'datetime.now',
  'datetime.utcnow',
  'datetime.datetime.now',
  'datetime.datetime.utcnow',
  'date.today',
  'datetime.date.today',
  'timezone.now',
  'func.now',
  'func.current_timestamp',
  'func.getdate',
  'func.localtimestamp',
  'sa.func.now',
  'sa.func.current_timestamp',
  'sqlalchemy.func.now',
  'sqlalchemy.func.current_timestamp',
]);

/** `datetime.utcnow`, `dt.date.today`, `timezone.now` ... */
const NOW_NAME_PATTERN: RegExp =
  /(?:^|\.)(?:now|utcnow|today|current_timestamp|localtimestamp)$/;

function stripFuncPrefix(text: string): string {
  return text.replace(/^(?:sa\.|sqlalchemy\.)?func\./, '');
}

function applyDefaults(
  ctx: Ctx,
  field: IrField,
  spec: ColSpec,
  resolved: ResolvedType,
  location: string
): void {
  if (spec.serverDefault !== undefined) {
    const converted: IrDefault | undefined = convertDefault(
      ctx,
      spec.serverDefault,
      field,
      resolved,
      true,
      location
    );
    if (converted !== undefined) {
      field.default = converted;
      field.isDbDefault = true;
    }
  }
  if (
    resolved.enumName !== undefined &&
    field.default !== undefined &&
    field.default.kind === 'literal' &&
    typeof field.default.value === 'string'
  ) {
    const member: IrDefault | undefined = enumValueFor(
      ctx,
      resolved.enumName,
      field.default.value
    );
    if (member !== undefined) {
      field.default = member;
    }
  }
  if (field.default === undefined && spec.default !== undefined) {
    const converted: IrDefault | undefined = convertDefault(
      ctx,
      spec.default,
      field,
      resolved,
      false,
      location
    );
    if (converted !== undefined) {
      field.default = converted;
    }
  }
  if (spec.onUpdate !== undefined) {
    const onUpdate: IrDefault | undefined = convertDefault(
      ctx,
      spec.onUpdate,
      field,
      resolved,
      false,
      location
    );
    if (onUpdate !== undefined && onUpdate.kind === 'now') {
      field.isAutoUpdated = true;
      // The timestamp is set on insert and on every update; the default would only repeat that.
      if (field.default !== undefined && field.default.kind === 'now') {
        delete field.default;
        delete field.isDbDefault;
      }
    } else {
      warn(
        ctx,
        `${location}: onupdate is only kept for timestamps (func.now() and datetime callables); it was dropped.`
      );
    }
  }
}

function enumValueFor(
  ctx: Ctx,
  enumName: string,
  stored: string
): IrDefault | undefined {
  const info: EnumInfo | undefined = ctx.enumInfos.get(enumName);
  if (info === undefined) {
    return undefined;
  }
  const member: IrEnumValue | undefined = info.values.find(
    (candidate: IrEnumValue) =>
      candidate.dbValue === stored || candidate.name === stored
  );
  return member === undefined
    ? undefined
    : { kind: 'enumValue', value: member.name };
}

function textExpressionDefault(
  expression: string,
  field: IrField,
  isServer: boolean
): IrDefault {
  const trimmed: string = expression.trim();
  const unwrapped: string = trimmed.replace(/^\((.*)\)$/s, '$1').trim();
  const lowered: string = unwrapped.toLowerCase();
  if (CURRENT_TIMESTAMP_EXPRESSIONS.has(lowered)) {
    return { kind: 'now' };
  }
  if (/^current_timestamp\(\d*\)$/.test(lowered) || /^now\(\)$/.test(lowered)) {
    return { kind: 'now' };
  }
  if (UUID_EXPRESSIONS.has(lowered)) {
    return { kind: 'uuid' };
  }
  const quoted: RegExpExecArray | null =
    /^'((?:[^']|'')*)'(?:::[\w\s."]+)?$/.exec(unwrapped);
  if (quoted !== null) {
    const body: string = (quoted[1] ?? '').replace(/''/g, "'");
    if (
      field.type === 'int' ||
      field.type === 'bigInt' ||
      field.type === 'float' ||
      field.type === 'decimal'
    ) {
      const asNumber: number = Number(body);
      if (body.trim() !== '' && !Number.isNaN(asNumber)) {
        return { kind: 'literal', value: asNumber };
      }
    }
    if (field.type === 'boolean') {
      if (/^(true|t|1)$/i.test(body)) {
        return { kind: 'literal', value: true };
      }
      if (/^(false|f|0)$/i.test(body)) {
        return { kind: 'literal', value: false };
      }
    }
    return { kind: 'literal', value: body };
  }
  if (/^-?\d+(\.\d+)?$/.test(unwrapped)) {
    if (field.type === 'boolean') {
      return { kind: 'literal', value: Number(unwrapped) !== 0 };
    }
    return { kind: 'literal', value: Number(unwrapped) };
  }
  if (/^(true|false)$/i.test(unwrapped)) {
    return { kind: 'literal', value: lowered === 'true' };
  }
  if (isServer) {
    return { kind: 'dbExpression', expression: trimmed };
  }
  return { kind: 'dbExpression', expression: trimmed };
}

function convertDefault(
  ctx: Ctx,
  value: PyValue,
  field: IrField,
  resolved: ResolvedType,
  isServer: boolean,
  location: string
): IrDefault | undefined {
  switch (value.kind) {
    case 'none':
      return undefined;
    case 'bool':
      return { kind: 'literal', value: value.value };
    case 'number':
      return { kind: 'literal', value: value.value };
    case 'string': {
      if (resolved.enumName !== undefined) {
        const member: IrDefault | undefined = enumValueFor(
          ctx,
          resolved.enumName,
          value.value
        );
        if (member !== undefined) {
          return member;
        }
      }
      if (isServer) {
        return textExpressionDefault(
          `'${value.value.replace(/'/g, "''")}'`,
          field,
          true
        );
      }
      return { kind: 'literal', value: value.value };
    }
    case 'list':
      if (value.items.length === 0) {
        return { kind: 'literal', value: '[]' };
      }
      break;
    case 'dict':
      if (value.entries.length === 0) {
        return { kind: 'literal', value: '{}' };
      }
      break;
    case 'name': {
      const dotted: string = value.value;
      if (
        dotted === 'uuid.uuid4' ||
        dotted === 'uuid4' ||
        dotted === 'uuid.uuid1' ||
        dotted === 'uuid7' ||
        dotted === 'uuid.uuid7'
      ) {
        return { kind: 'uuid' };
      }
      if (NOW_CALLABLES.has(dotted) || NOW_NAME_PATTERN.test(dotted)) {
        return { kind: 'now' };
      }
      if (dotted === 'dict') {
        return { kind: 'literal', value: '{}' };
      }
      if (dotted === 'list' || dotted === 'set') {
        return { kind: 'literal', value: '[]' };
      }
      const member: IrDefault | undefined = enumMemberDefault(ctx, dotted);
      if (member !== undefined) {
        return member;
      }
      break;
    }
    case 'call': {
      const callee: string = value.callee;
      const lowered: string = lastSegment(callee).toLowerCase();
      if (lowered === 'text') {
        const argument: PyValue | undefined = value.args[0];
        const expression: string | undefined = stringOf(argument);
        if (expression !== undefined) {
          return textExpressionDefault(expression, field, isServer);
        }
      }
      if (/(^|\.)func\./.test(callee) || callee.startsWith('func.')) {
        const converted: IrDefault = textExpressionDefault(
          stripFuncPrefix(value.text),
          field,
          isServer
        );
        if (converted.kind !== 'dbExpression' || isServer) {
          return converted;
        }
        break;
      }
      if (
        (lowered === 'true' || lowered === 'false') &&
        value.args.length === 0
      ) {
        return { kind: 'literal', value: lowered === 'true' };
      }
      if (lowered === 'decimal' || lowered === 'int' || lowered === 'float') {
        const argument: PyValue | undefined = value.args[0];
        const numeric: number | undefined =
          argument === undefined
            ? undefined
            : argument.kind === 'number'
              ? argument.value
              : argument.kind === 'string' &&
                  !Number.isNaN(Number(argument.value))
                ? Number(argument.value)
                : undefined;
        if (numeric !== undefined) {
          return { kind: 'literal', value: numeric };
        }
      }
      if (NOW_CALLABLES.has(callee) || NOW_NAME_PATTERN.test(callee)) {
        return { kind: 'now' };
      }
      if (
        callee === 'uuid.uuid4' ||
        callee === 'uuid4' ||
        callee === 'uuid.uuid1'
      ) {
        return { kind: 'uuid' };
      }
      break;
    }
    case 'other': {
      const text: string = value.text.replace(/\s+/g, ' ');
      if (/^lambda\s*:/.test(text)) {
        const body: string = text.replace(/^lambda\s*:\s*/, '');
        if (
          /\b(utcnow|now|today)\s*\(/.test(body) ||
          /\bfunc\.now\(/.test(body)
        ) {
          return { kind: 'now' };
        }
        if (/\buuid[14]?\s*\(/.test(body)) {
          return { kind: 'uuid' };
        }
        if (body === '{}' || body === 'dict()') {
          return { kind: 'literal', value: '{}' };
        }
        if (body === '[]' || body === 'list()') {
          return { kind: 'literal', value: '[]' };
        }
        if (/^-?\d+(\.\d+)?$/.test(body)) {
          return { kind: 'literal', value: Number(body) };
        }
        const stringBody: RegExpExecArray | null = /^(['"])(.*)\1$/.exec(body);
        if (stringBody !== null) {
          return { kind: 'literal', value: stringBody[2] ?? '' };
        }
      }
      break;
    }
    default:
      break;
  }
  warn(
    ctx,
    `${location}: ${isServer ? 'server_default' : 'default'}=${valueText(value) || value.kind} is not representable and was dropped.`
  );
  return undefined;
}

/** `PostStatus.DRAFT` and `PostStatus.DRAFT.value` -> enumValue. */
function enumMemberDefault(ctx: Ctx, dotted: string): IrDefault | undefined {
  const segments: string[] = dotted.split('.');
  if (segments[segments.length - 1] === 'value') {
    segments.pop();
  }
  const memberName: string | undefined = segments[1];
  const className: string | undefined = segments[0];
  if (className === undefined || memberName === undefined) {
    return undefined;
  }
  const info: EnumInfo | undefined = ctx.enumInfos.get(className);
  if (info === undefined) {
    return undefined;
  }
  return info.values.some(
    (candidate: IrEnumValue) => candidate.name === memberName
  )
    ? { kind: 'enumValue', value: memberName }
    : undefined;
}

// ---------------------------------------------------------------------------
// Table constraints and indexes
// ---------------------------------------------------------------------------

function findColumn(table: RawTable, reference: string): RawColumn | undefined {
  const index: number | undefined = table.columnIndex.get(reference);
  if (index !== undefined) {
    return table.columns[index];
  }
  return table.columns.find(
    (column: RawColumn) => column.field.columnName === reference
  );
}

/** A column named in a constraint: a string, `Model.attribute`, or `table.c.column`. */
function constraintColumn(value: PyValue): {
  name?: string;
  sort?: 'asc' | 'desc';
  expression?: boolean;
} {
  if (value.kind === 'string') {
    return { name: value.value };
  }
  if (value.kind === 'name') {
    const parts: string[] = value.value.split('.');
    return { name: parts[parts.length - 1] };
  }
  if (value.kind === 'call') {
    const parts: string[] = value.callee.split('.');
    const method: string = (parts[parts.length - 1] ?? '').toLowerCase();
    if ((method === 'desc' || method === 'asc') && parts.length >= 2) {
      return {
        name: parts[parts.length - 2],
        sort: method === 'desc' ? 'desc' : 'asc',
      };
    }
  }
  return { expression: true };
}

function applyTableItem(ctx: Ctx, table: RawTable, call: PyCall): void {
  const callee: string = lastSegment(call.callee);
  const lowered: string = callee.toLowerCase();
  const label: string = `${table.label}.__table_args__`;
  switch (lowered) {
    case 'index':
      applyIndex(ctx, table, call, label);
      return;
    case 'uniqueconstraint':
      applyUnique(ctx, table, call, label);
      return;
    case 'primarykeyconstraint': {
      const columns: string[] = [];
      for (const argument of call.args) {
        const column = constraintColumn(argument);
        const found: RawColumn | undefined =
          column.name === undefined
            ? undefined
            : findColumn(table, column.name);
        if (found === undefined) {
          warn(
            ctx,
            `${label}: PrimaryKeyConstraint names a column that does not exist; it was ignored.`
          );
          return;
        }
        columns.push(found.key);
      }
      if (columns.length > 0) {
        table.pk = columns;
        const name: string | undefined = stringOf(call.kwargs['name']);
        if (name !== undefined) {
          table.pkName = name;
        }
      }
      return;
    }
    case 'foreignkeyconstraint':
      applyForeignKeyConstraint(ctx, table, call, label);
      return;
    case 'checkconstraint':
      warn(
        ctx,
        `${label}: a CheckConstraint${stringOf(call.kwargs['name']) === undefined ? '' : ` ("${stringOf(call.kwargs['name'])}")`} was ignored (check constraints are not part of the shared model).`
      );
      return;
    case 'excludeconstraint':
      warn(ctx, `${label}: an ExcludeConstraint was ignored.`);
      return;
    default:
      warn(ctx, `${label}: ${callee}(...) is not supported and was ignored.`);
  }
}

function applyForeignKeyConstraint(
  ctx: Ctx,
  table: RawTable,
  call: PyCall,
  label: string
): void {
  const localArgument: PyValue | undefined =
    call.args[0] ?? call.kwargs['columns'];
  const targetArgument: PyValue | undefined =
    call.args[1] ?? call.kwargs['refcolumns'];
  if (
    localArgument === undefined ||
    targetArgument === undefined ||
    localArgument.kind !== 'list' ||
    targetArgument.kind !== 'list'
  ) {
    warn(
      ctx,
      `${label}: a ForeignKeyConstraint could not be evaluated and was ignored.`
    );
    return;
  }
  const local: string[] = [];
  for (const item of localArgument.items) {
    const found: RawColumn | undefined =
      item.kind === 'string' ? findColumn(table, item.value) : undefined;
    if (found === undefined) {
      warn(
        ctx,
        `${label}: a ForeignKeyConstraint names a column that does not exist; it was ignored.`
      );
      return;
    }
    local.push(found.key);
  }
  const targets: FkTarget[] = [];
  for (const item of targetArgument.items) {
    const target: FkTarget | undefined = parseFkTarget(ctx, item, table);
    if (target === undefined) {
      warn(
        ctx,
        `${label}: a ForeignKeyConstraint target could not be evaluated and was ignored.`
      );
      return;
    }
    targets.push(target);
  }
  const head: FkTarget | undefined = targets[0];
  if (
    head === undefined ||
    targets.length !== local.length ||
    targets.some((target: FkTarget) => target.table !== head.table)
  ) {
    warn(
      ctx,
      `${label}: a ForeignKeyConstraint with mismatched or mixed targets was ignored.`
    );
    return;
  }
  table.fks.push({
    columns: local,
    target: {
      ...(head.schema === undefined ? {} : { schema: head.schema }),
      table: head.table,
      columns: targets.flatMap((target: FkTarget) => target.columns),
    },
    onDelete: actionOf(ctx, call.kwargs['ondelete'], label, 'ondelete'),
    onUpdate: actionOf(ctx, call.kwargs['onupdate'], label, 'onupdate'),
    name: stringOf(call.kwargs['name']),
  });
}

function applyUnique(
  ctx: Ctx,
  table: RawTable,
  call: PyCall,
  label: string
): void {
  const columns: string[] = [];
  for (const argument of call.args) {
    const column = constraintColumn(argument);
    const found: RawColumn | undefined =
      column.name === undefined ? undefined : findColumn(table, column.name);
    if (found === undefined) {
      warn(
        ctx,
        `${label}: a UniqueConstraint names a column that does not exist; it was ignored.`
      );
      return;
    }
    columns.push(found.key);
  }
  if (columns.length === 0) {
    return;
  }
  const name: string | undefined = stringOf(call.kwargs['name']);
  const only: string | undefined = columns[0];
  if (columns.length === 1 && only !== undefined) {
    const column: RawColumn | undefined = findColumn(table, only);
    if (column !== undefined) {
      column.field.isUnique = true;
      if (name !== undefined) {
        column.field.uniqueName = name;
      }
    }
    return;
  }
  table.indexes.push({
    columns,
    isUnique: true,
    name,
    method: undefined,
    fieldOptions: {},
  });
}

function applyIndex(
  ctx: Ctx,
  table: RawTable,
  call: PyCall,
  label: string
): void {
  const nameArgument: PyValue | undefined = call.args[0];
  const name: string | undefined =
    stringOf(nameArgument) ?? stringOf(call.kwargs['name']);
  const columns: string[] = [];
  const fieldOptions: Record<string, IrIndexFieldOptions> = {};
  for (const argument of call.args.slice(
    nameArgument !== undefined &&
      (nameArgument.kind === 'string' || nameArgument.kind === 'none')
      ? 1
      : 0
  )) {
    const column = constraintColumn(argument);
    const found: RawColumn | undefined =
      column.name === undefined ? undefined : findColumn(table, column.name);
    if (column.expression === true || found === undefined) {
      warn(
        ctx,
        `${label}: ${name === undefined ? 'an index' : `the index "${name}"`} on an expression or on a column that does not exist was ignored.`
      );
      return;
    }
    columns.push(found.key);
    if (column.sort === 'desc') {
      fieldOptions[found.key] = { sort: 'desc' };
    }
  }
  if (columns.length === 0) {
    return;
  }
  const where: PyValue | undefined = Object.entries(call.kwargs).find(([key]) =>
    /(^|_)where$/.test(key)
  )?.[1];
  if (where !== undefined) {
    warn(
      ctx,
      `${label}: the partial index${name === undefined ? '' : ` "${name}"`} (with a WHERE clause) was ignored.`
    );
    return;
  }
  const usingEntry: [string, PyValue] | undefined = Object.entries(
    call.kwargs
  ).find(([key]) => /(^|_)using$/.test(key));
  const method: string | undefined = stringOf(usingEntry?.[1]);
  table.indexes.push({
    columns,
    isUnique: boolOf(call.kwargs['unique']) === true,
    name,
    method,
    fieldOptions,
  });
}

/** Names an expression refers to first: `Post.title.desc()` -> Post, `func.lower(Post.title)` -> func, Post. */
function holderNames(value: PyValue, depth: number = 0): string[] {
  if (depth > 4) {
    return [];
  }
  if (value.kind === 'name') {
    return [(value.value.split('.')[0] ?? '').trim()];
  }
  if (value.kind === 'call') {
    return [
      (value.callee.split('.')[0] ?? '').trim(),
      ...value.args.flatMap((argument: PyValue) =>
        holderNames(argument, depth + 1)
      ),
    ];
  }
  return [];
}

/** `Index("name", Model.a, Model.b)` written after the class body. */
function applyModuleIndexes(ctx: Ctx): void {
  for (const { call } of ctx.indexCalls) {
    let table: RawTable | undefined;
    for (const argument of call.args) {
      for (const holder of holderNames(argument)) {
        table = ctx.byModel.get(holder) ?? ctx.byVar.get(holder);
        if (table !== undefined) {
          break;
        }
      }
      if (table !== undefined) {
        break;
      }
    }
    if (table === undefined) {
      warn(
        ctx,
        `Index(...) at module level could not be matched to a model or table (${call.text.slice(0, 80)}); it was ignored.`
      );
      continue;
    }
    applyIndex(ctx, table, call, `${table.label}`);
  }
}

// ---------------------------------------------------------------------------
// Relationships
// ---------------------------------------------------------------------------

function colRefsOf(value: PyValue | undefined): ColRef[] {
  if (value === undefined) {
    return [];
  }
  const refs: ColRef[] = [];
  const text: string = value.kind === 'list' ? '' : valueText(value);
  if (value.kind === 'list') {
    for (const item of value.items) {
      refs.push(...colRefsOf(item));
    }
    return refs;
  }
  for (const match of text.matchAll(/([A-Za-z_]\w*)(?:\.([A-Za-z_]\w*))?/g)) {
    const first: string = match[1] ?? '';
    const second: string | undefined = match[2];
    if (first === 'lambda' || first === 'foreign' || first === 'remote') {
      continue;
    }
    refs.push(
      second === undefined ? { col: first } : { cls: first, col: second }
    );
  }
  return refs;
}

function relationshipTarget(value: PyValue | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  switch (value.kind) {
    case 'string': {
      const cleaned: string = value.value.trim().replace(/^['"]|['"]$/g, '');
      return /^[\w.]+$/.test(cleaned) ? lastSegment(cleaned) : undefined;
    }
    case 'name':
      return lastSegment(value.value);
    case 'other': {
      const lambda: RegExpExecArray | null = /^lambda\s*:\s*([\w.]+)/.exec(
        value.text
      );
      return lambda === null ? undefined : lastSegment(lambda[1] ?? '');
    }
    default:
      return undefined;
  }
}

function addRelationship(
  ctx: Ctx,
  table: RawTable,
  member: RawMember,
  call: PyCall
): void {
  let kwargs: Record<string, PyValue> = { ...call.kwargs };
  const extra: PyValue | undefined = kwargs['sa_relationship_kwargs'];
  if (extra !== undefined && extra.kind === 'dict') {
    for (const entry of extra.entries) {
      const key: string | undefined = stringOf(entry.key);
      if (key !== undefined && kwargs[key] === undefined) {
        kwargs[key] = entry.value;
      }
    }
  }
  const inner: PyValue | undefined = kwargs['sa_relationship'];
  let effective: PyCall = call;
  if (inner !== undefined && inner.kind === 'call') {
    effective = inner;
    kwargs = { ...inner.kwargs, ...kwargs };
  }
  const fromAnnotation = relationshipAnnotation(ctx, member.annotation);
  const targetName: string | undefined =
    relationshipTarget(effective.args[0]) ??
    relationshipTarget(kwargs['argument']) ??
    fromAnnotation.target;
  const backref: PyValue | undefined = kwargs['backref'];
  let backrefInfo: RawRel['backref'];
  if (backref !== undefined) {
    if (backref.kind === 'string') {
      backrefInfo = { name: backref.value };
    } else if (backref.kind === 'call') {
      const name: string | undefined = stringOf(backref.args[0]);
      if (name !== undefined) {
        const uselist: boolean | undefined = boolOf(backref.kwargs['uselist']);
        backrefInfo = { name, ...(uselist === undefined ? {} : { uselist }) };
      }
    }
  }
  const uselist: boolean | undefined = boolOf(kwargs['uselist']);
  const rel: RawRel = {
    table,
    key: member.name,
    order: ctx.counter,
    targetName,
    foreignKeys: colRefsOf(kwargs['foreign_keys']),
    joinRefs: [
      ...colRefsOf(kwargs['primaryjoin']),
      ...colRefsOf(kwargs['secondaryjoin']),
    ],
    remoteSide: kwargs['remote_side'] !== undefined,
    viewonly: boolOf(kwargs['viewonly']) === true,
    synthetic: false,
  };
  ctx.counter += 1;
  const backPopulates: string | undefined = stringOf(kwargs['back_populates']);
  if (backPopulates !== undefined) {
    rel.backPopulates = backPopulates;
  }
  if (backrefInfo !== undefined) {
    rel.backref = backrefInfo;
  }
  if (kwargs['secondary'] !== undefined) {
    rel.secondary = kwargs['secondary'];
  }
  const linkModel: PyValue | undefined = kwargs['link_model'];
  if (linkModel !== undefined) {
    const linkName: string | undefined = relationshipTarget(linkModel);
    if (linkName !== undefined) {
      rel.linkModel = linkName;
    }
  }
  if (uselist !== undefined) {
    rel.uselist = uselist;
  }
  const collection: boolean | undefined = uselist ?? fromAnnotation.collection;
  if (collection !== undefined) {
    rel.collection = collection;
  }
  if (targetName === undefined) {
    warn(
      ctx,
      `${table.label}.${member.name}: the target model of the relationship could not be determined; it was skipped.`
    );
    return;
  }
  if (table.rels.length >= MAX_RELATIONSHIPS_PER_TABLE) {
    if (table.relsCapped !== true) {
      table.relsCapped = true;
      warn(
        ctx,
        `${table.label}: more than ${MAX_RELATIONSHIPS_PER_TABLE} relationships; the rest were skipped.`
      );
    }
    return;
  }
  table.rels.push(rel);
}

function tableOfRef(
  ctx: Ctx,
  rel: RawRel,
  reference: ColRef
): RawTable | undefined {
  return reference.cls === undefined
    ? rel.table
    : (ctx.byModel.get(reference.cls) ?? ctx.byVar.get(reference.cls));
}

function fkWithColumn(table: RawTable, key: string): RawFk | undefined {
  return table.fks.find((fk: RawFk) => fk.columns.includes(key));
}

function tableFor(ctx: Ctx, target: FkTarget): RawTable | undefined {
  const matches: RawTable[] = (ctx.tablesByName.get(target.table) ?? []).filter(
    (candidate: RawTable) =>
      target.schema === undefined || candidate.schema === target.schema
  );
  if (matches.length === 0 && target.schema !== undefined) {
    const unqualified: RawTable[] = ctx.tablesByName.get(target.table) ?? [];
    return unqualified.length === 1 ? unqualified[0] : undefined;
  }
  if (matches.length <= 1) {
    return matches[0];
  }
  // Prefer a class-mapped table when a Table() variable has the same name.
  return (
    matches.find((candidate: RawTable) => candidate.cls !== undefined) ??
    matches[0]
  );
}

function fksBetween(ctx: Ctx, from: RawTable, to: RawTable): RawFk[] {
  return from.fks.filter((fk: RawFk) => tableFor(ctx, fk.target) === to);
}

function resolveRelationships(ctx: Ctx): void {
  // backref="name" declares the other side implicitly.
  for (const table of [...ctx.tables]) {
    for (const rel of [...table.rels]) {
      if (
        rel.backref === undefined ||
        rel.viewonly ||
        rel.targetName === undefined
      ) {
        continue;
      }
      const target: RawTable | undefined = ctx.byModel.get(rel.targetName);
      if (
        target === undefined ||
        target.rels.some((other: RawRel) => other.key === rel.backref?.name)
      ) {
        continue;
      }
      const synthetic: RawRel = {
        table: target,
        key: rel.backref.name,
        order: rel.order + 0.5,
        targetName: table.modelName,
        backPopulates: rel.key,
        foreignKeys: rel.foreignKeys,
        joinRefs: rel.joinRefs,
        remoteSide: false,
        viewonly: false,
        synthetic: true,
        ...(rel.secondary === undefined ? {} : { secondary: rel.secondary }),
        ...(rel.linkModel === undefined ? {} : { linkModel: rel.linkModel }),
        ...(rel.backref.uselist === undefined
          ? {}
          : { uselist: rel.backref.uselist, collection: rel.backref.uselist }),
      };
      target.rels.push(synthetic);
    }
  }

  // Owning sides first, so reverse sides can find them by name.
  const reverse: RawRel[] = [];
  const manyToMany: RawRel[] = [];
  for (const table of ctx.tables) {
    for (const rel of table.rels) {
      if (rel.viewonly) {
        continue;
      }
      if (rel.secondary !== undefined || rel.linkModel !== undefined) {
        manyToMany.push(rel);
        continue;
      }
      classifyRelationship(ctx, rel, reverse);
    }
  }
  for (const rel of reverse) {
    linkReverse(ctx, rel);
  }
  linkManyToMany(ctx, manyToMany);
}

function sideOf(
  ctx: Ctx,
  rel: RawRel,
  target: RawTable
): { side: 'owner' | 'reverse' | 'none'; candidates: RawFk[] } {
  const own: RawTable = rel.table;
  const hints: ColRef[] = rel.foreignKeys.length > 0 ? rel.foreignKeys : [];
  if (hints.length > 0) {
    const hinted: ColRef | undefined = hints[0];
    const holder: RawTable | undefined =
      hinted === undefined ? undefined : tableOfRef(ctx, rel, hinted);
    if (holder !== undefined && hinted !== undefined) {
      const fk: RawFk | undefined = fkWithColumn(holder, hinted.col);
      if (fk !== undefined) {
        if (own === target) {
          return {
            side: rel.remoteSide ? 'owner' : 'reverse',
            candidates: [fk],
          };
        }
        return { side: holder === own ? 'owner' : 'reverse', candidates: [fk] };
      }
    }
  }
  // primaryjoin hints: columns that carry a foreign key between the two tables.
  const joinHints: RawFk[] = [];
  for (const reference of rel.joinRefs) {
    const holder: RawTable | undefined = tableOfRef(ctx, rel, reference);
    const fk: RawFk | undefined =
      holder === undefined ? undefined : fkWithColumn(holder, reference.col);
    if (
      holder !== undefined &&
      fk !== undefined &&
      ((holder === own && tableFor(ctx, fk.target) === target) ||
        (holder === target && tableFor(ctx, fk.target) === own))
    ) {
      joinHints.push(fk);
    }
  }
  const firstJoin: RawFk | undefined = joinHints[0];
  if (firstJoin !== undefined) {
    const owns: boolean = own.fks.includes(firstJoin);
    if (own === target) {
      return {
        side: rel.remoteSide ? 'owner' : 'reverse',
        candidates: [firstJoin],
      };
    }
    return { side: owns ? 'owner' : 'reverse', candidates: [firstJoin] };
  }
  const forward: RawFk[] = fksBetween(ctx, own, target);
  if (own === target) {
    return { side: rel.remoteSide ? 'owner' : 'reverse', candidates: forward };
  }
  const backward: RawFk[] = fksBetween(ctx, target, own);
  if (forward.length > 0 && backward.length === 0) {
    return { side: 'owner', candidates: forward };
  }
  if (backward.length > 0 && forward.length === 0) {
    return { side: 'reverse', candidates: backward };
  }
  if (forward.length > 0 && backward.length > 0) {
    return rel.collection === true
      ? { side: 'reverse', candidates: backward }
      : { side: 'owner', candidates: forward };
  }
  return { side: 'none', candidates: [] };
}

/** Picks the foreign key a relationship uses when several fit: by name, then by order. */
function pickForeignKey(
  rel: RawRel,
  candidates: RawFk[],
  taken: (fk: RawFk) => boolean
): RawFk | undefined {
  if (candidates.length <= 1) {
    return candidates[0];
  }
  const stripped = (key: string): string => key.replace(/(_id|Id|ID)$/, '');
  const byName: RawFk | undefined = candidates.find((fk: RawFk) =>
    fk.columns.some(
      (column: string) => column === rel.key || stripped(column) === rel.key
    )
  );
  if (byName !== undefined) {
    return byName;
  }
  return candidates.find((fk: RawFk) => !taken(fk)) ?? candidates[0];
}

function classifyRelationship(ctx: Ctx, rel: RawRel, reverse: RawRel[]): void {
  const location: string = `${rel.table.label}.${rel.key}`;
  const target: RawTable | undefined =
    rel.targetName === undefined ? undefined : ctx.byModel.get(rel.targetName);
  if (target === undefined) {
    warn(
      ctx,
      `${location}: the relationship points at "${rel.targetName ?? ''}", which is not a model in the input; it was skipped.`
    );
    return;
  }
  const { side, candidates } = sideOf(ctx, rel, target);
  if (side === 'none') {
    warn(
      ctx,
      `${location}: no foreign key links ${rel.table.modelName} and ${target.modelName}; the relationship was skipped.`
    );
    return;
  }
  if (side === 'reverse') {
    reverse.push(rel);
    return;
  }
  const fk: RawFk | undefined = pickForeignKey(
    rel,
    candidates,
    (candidate: RawFk) => candidate.ownerName !== undefined
  );
  if (fk === undefined) {
    return;
  }
  if (candidates.length > 1 && rel.foreignKeys.length === 0) {
    warn(
      ctx,
      `${location}: several foreign keys link ${rel.table.modelName} and ${target.modelName}; add foreign_keys=[...] to tell them apart.`
    );
  }
  if (fk.ownerName === undefined) {
    fk.ownerName = rel.key;
  }
  const declared: string | undefined = rel.backPopulates ?? rel.backref?.name;
  if (declared !== undefined && fk.declaredRelatedName === undefined) {
    fk.declaredRelatedName = declared;
  }
  if (
    rel.uselist === false &&
    rel.collection === false &&
    fk.reverseScalar === undefined
  ) {
    // uselist=False on the owning side is the default for many-to-one; it says nothing about one-to-one.
  }
}

function linkReverse(ctx: Ctx, rel: RawRel): void {
  const location: string = `${rel.table.label}.${rel.key}`;
  const target: RawTable | undefined =
    rel.targetName === undefined ? undefined : ctx.byModel.get(rel.targetName);
  if (target === undefined) {
    return;
  }
  const { candidates } = sideOf(ctx, rel, target);
  let fk: RawFk | undefined;
  if (rel.backPopulates !== undefined) {
    fk = candidates.find(
      (candidate: RawFk) => candidate.ownerName === rel.backPopulates
    );
  }
  if (fk === undefined) {
    fk = pickForeignKey(
      rel,
      candidates.filter(
        (candidate: RawFk) => candidate.reverseName === undefined
      ),
      (candidate: RawFk) => candidate.reverseName !== undefined
    );
  }
  if (fk === undefined) {
    warn(
      ctx,
      `${location}: the relationship could not be matched to a foreign key of ${target.modelName}; the reverse side was not linked.`
    );
    return;
  }
  if (fk.reverseName === undefined) {
    fk.reverseName = rel.key;
    if (rel.collection === false || rel.uselist === false) {
      fk.reverseScalar = true;
    }
  }
}

// ---------------------------------------------------------------------------
// Many-to-many
// ---------------------------------------------------------------------------

function associationTableOf(ctx: Ctx, rel: RawRel): RawTable | undefined {
  if (rel.linkModel !== undefined) {
    return ctx.byModel.get(rel.linkModel);
  }
  const secondary: PyValue | undefined = rel.secondary;
  if (secondary === undefined) {
    return undefined;
  }
  if (secondary.kind === 'name') {
    const variable: string = secondary.value;
    return (
      ctx.byVar.get(variable) ??
      ctx.byVar.get(lastSegment(variable)) ??
      ctx.byModel.get(lastSegment(variable))
    );
  }
  if (secondary.kind === 'string') {
    const name: string = lastSegment(secondary.value);
    return ctx.tablesByName.get(name)?.[0];
  }
  if (secondary.kind === 'other') {
    const lambda: RegExpExecArray | null = /^lambda\s*:\s*([\w.]+)/.exec(
      secondary.text
    );
    if (lambda !== null) {
      const variable: string = lambda[1] ?? '';
      return ctx.byVar.get(variable) ?? ctx.byModel.get(lastSegment(variable));
    }
  }
  return undefined;
}

function linkManyToMany(ctx: Ctx, relations: RawRel[]): void {
  const ordered: RawRel[] = [...relations].sort(
    (first: RawRel, second: RawRel) => first.order - second.order
  );
  for (const rel of ordered) {
    if (rel.folded === true) {
      continue;
    }
    const location: string = `${rel.table.label}.${rel.key}`;
    const target: RawTable | undefined =
      rel.targetName === undefined
        ? undefined
        : ctx.byModel.get(rel.targetName);
    if (target === undefined) {
      warn(
        ctx,
        `${location}: the many-to-many points at "${rel.targetName ?? ''}", which is not a model in the input; it was skipped.`
      );
      continue;
    }
    const association: RawTable | undefined = associationTableOf(ctx, rel);
    const secondaryText: string =
      rel.linkModel ??
      (rel.secondary === undefined ? '' : valueText(rel.secondary));
    if (association === undefined) {
      warn(
        ctx,
        `${location}: the association table ${secondaryText === '' ? '' : `"${secondaryText}" `}is not defined in the input; the many-to-many was kept without checking its columns.`
      );
    } else if (!isPureAssociation(ctx, association, rel.table, target)) {
      if (rel.linkModel !== undefined) {
        warn(
          ctx,
          `${location}: the link model ${association.modelName} has columns besides its two foreign keys, so it stays a model and the many-to-many was skipped.`
        );
        continue;
      }
      warn(
        ctx,
        `${location}: the association table ${association.tableName} has columns besides its two foreign keys; they are not represented.`
      );
      association.consumed = true;
    } else {
      association.consumed = true;
    }
    // Pair with the other side so the relation is written once, with the other name as its reverse.
    const partner: RawRel | undefined = target.rels.find(
      (other: RawRel) =>
        other !== rel &&
        other.folded !== true &&
        (other.secondary !== undefined || other.linkModel !== undefined) &&
        ((rel.backPopulates !== undefined && other.key === rel.backPopulates) ||
          (other.backPopulates === rel.key &&
            other.targetName === rel.table.modelName))
    );
    if (partner !== undefined) {
      partner.folded = true;
    }
    const relatedName: string | undefined =
      partner?.key ?? rel.backPopulates ?? rel.backref?.name;
    rel.table.m2m.push({
      name: rel.key,
      kind: 'manyToMany',
      targetModel: target.modelName,
      columnName: '',
      isNullable: false,
      onDelete: 'cascade',
      ...(relatedName === undefined ? {} : { relatedName }),
    });
  }
}

/** True when the table is made of the two foreign keys of a many-to-many and nothing else. */
function isPureAssociation(
  ctx: Ctx,
  association: RawTable,
  first: RawTable,
  second: RawTable
): boolean {
  const keyed: Set<string> = new Set(
    association.fks.flatMap((fk: RawFk) => fk.columns)
  );
  const hasFirst: boolean = association.fks.some(
    (fk: RawFk) => tableFor(ctx, fk.target) === first
  );
  const hasSecond: boolean = association.fks.some(
    (fk: RawFk) => tableFor(ctx, fk.target) === second
  );
  return (
    hasFirst &&
    hasSecond &&
    association.columns.every((column: RawColumn) => keyed.has(column.key))
  );
}

// ---------------------------------------------------------------------------
// Finalizing
// ---------------------------------------------------------------------------

/** Gives columns declared as `Column("id", ForeignKey("t.id"))` the type of the column they reference. */
function inferForeignKeyTypes(ctx: Ctx): void {
  for (const table of ctx.tables) {
    for (const column of table.columns) {
      if (column.inferFromForeignKey !== true) {
        continue;
      }
      const fk: RawFk | undefined = table.fks.find(
        (candidate: RawFk) =>
          candidate.columns.length === 1 && candidate.columns[0] === column.key
      );
      const target: RawTable | undefined =
        fk === undefined ? undefined : tableFor(ctx, fk.target);
      const referenced: string | undefined =
        fk === undefined ? undefined : fk.target.columns[0];
      const source: RawColumn | undefined =
        target === undefined
          ? undefined
          : target.columns.find((candidate: RawColumn) =>
              referenced === undefined
                ? candidate.field.isPrimaryKey
                : candidate.field.columnName === referenced
            );
      if (source === undefined) {
        warn(
          ctx,
          `${table.label}.${column.key}: the column has no type and the column its foreign key points at is not known; it was read as an integer.`
        );
        continue;
      }
      for (const property of [
        'type',
        'maxLength',
        'maxDigits',
        'decimalPlaces',
        'enumName',
        'arrayDepth',
        'rangeOf',
        'unsupportedType',
      ] as const) {
        const value: unknown = source.field[property];
        if (value === undefined) {
          delete column.field[property];
        } else {
          (column.field as unknown as Record<string, unknown>)[property] =
            value;
        }
      }
    }
  }
}

function finalizeAll(ctx: Ctx): IrModel[] {
  inferForeignKeyTypes(ctx);
  const warnings: string[] = ctx.warnings;
  const consumed: Set<RawTable> = new Set(
    ctx.tables.filter((table: RawTable) => table.consumed)
  );
  const models: IrModel[] = [];
  const names: Set<string> = new Set();
  for (const table of ctx.tables) {
    if (consumed.has(table)) {
      continue;
    }
    if (table.varName !== undefined && table.cls === undefined) {
      const mapped: boolean = ctx.imperative.some(
        (mapping) => mapping.tableVar === table.varName
      );
      if (!mapped) {
        warn(
          ctx,
          `${table.tableName}: the Table is not mapped to a class and not used as a secondary table; it is converted as the model ${table.modelName}.`
        );
      }
    }
    if (names.has(table.modelName)) {
      warn(
        ctx,
        `Two tables are named ${table.modelName}; the second one was skipped.`
      );
      continue;
    }
    names.add(table.modelName);
    models.push(finalizeModel(ctx, table));
  }
  addStubModels(ctx, models, warnings);
  return models;
}

function stripIdSuffix(key: string): string {
  return key.replace(/(_id|Id|ID)$/, '');
}

function modelNameForTable(ctx: Ctx, target: FkTarget): string {
  const found: RawTable | undefined = tableFor(ctx, target);
  if (found !== undefined) {
    return found.modelName;
  }
  const stubName: string = toPascalCase(singularize(toSnakeCase(target.table)));
  ctx.stubTables.set(stubName, target.table);
  return stubName;
}

function fieldNameForColumn(
  target: RawTable | undefined,
  columnName: string
): string {
  if (target === undefined) {
    return columnName;
  }
  const column: RawColumn | undefined = target.columns.find(
    (candidate: RawColumn) => candidate.field.columnName === columnName
  );
  return column === undefined ? columnName : column.key;
}

function primaryKeyOf(table: RawTable | undefined): string[] {
  if (table === undefined) {
    return ['id'];
  }
  if (table.pk !== undefined) {
    return table.pk;
  }
  const keys: string[] = table.columns
    .filter((column: RawColumn) => column.field.isPrimaryKey)
    .map((column: RawColumn) => column.key);
  return keys.length > 0 ? keys : ['id'];
}

function sameList(first: string[], second: string[]): boolean {
  return (
    first.length === second.length &&
    first.every((item: string, index: number) => item === second[index])
  );
}

function finalizeModel(ctx: Ctx, table: RawTable): IrModel {
  const label: string = table.label;
  const columns: RawColumn[] = table.columns;
  const pkKeys: string[] =
    table.pk ??
    columns
      .filter((column: RawColumn) => column.field.isPrimaryKey)
      .map((column: RawColumn) => column.key);
  const uniqueKeys: Set<string> = new Set(
    columns
      .filter((column: RawColumn) => column.field.isUnique)
      .map((column: RawColumn) => column.key)
  );
  for (const index of table.indexes) {
    const only: string | undefined = index.columns[0];
    if (index.isUnique && index.columns.length === 1 && only !== undefined) {
      uniqueKeys.add(only);
    }
  }
  const takenNames: Set<string> = new Set(
    columns
      .filter(
        (column: RawColumn) =>
          !table.fks.some(
            (fk: RawFk) =>
              fk.columns.length === 1 && fk.columns[0] === column.key
          )
      )
      .map((column: RawColumn) => column.key)
  );
  for (const relation of table.m2m) {
    takenNames.add(relation.name);
  }

  const relations: IrRelation[] = [];
  const compositeForeignKeys: IrCompositeForeignKey[] = [];
  const renamed: Map<string, string> = new Map();
  const merged: Set<string> = new Set();

  for (const fk of table.fks) {
    const target: RawTable | undefined = tableFor(ctx, fk.target);
    const targetModel: string = modelNameForTable(ctx, fk.target);
    const keyColumns: RawColumn[] = fk.columns.flatMap((key: string) => {
      const column: RawColumn | undefined = columns.find(
        (candidate: RawColumn) => candidate.key === key
      );
      return column === undefined ? [] : [column];
    });
    if (keyColumns.length !== fk.columns.length || keyColumns.length === 0) {
      warn(
        ctx,
        `${label}: the foreign key on (${fk.columns.join(', ')}) names a column that does not exist; it was skipped.`
      );
      continue;
    }
    const relatedName: string | undefined =
      fk.reverseName ?? fk.declaredRelatedName;
    if (fk.columns.length > 1) {
      const references: string[] =
        fk.target.columns.length > 0
          ? fk.target.columns.map((name: string) =>
              fieldNameForColumn(target, name)
            )
          : primaryKeyOf(target);
      let name: string = fk.ownerName ?? toCamelCase(targetModel);
      while (takenNames.has(name)) {
        name = `${name}_`;
      }
      takenNames.add(name);
      compositeForeignKeys.push({
        name,
        targetModel,
        fields: fk.columns,
        references,
        kind: 'foreignKey',
        isNullable: keyColumns.some(
          (column: RawColumn) => column.field.isNullable
        ),
        onDelete: fk.onDelete ?? 'noAction',
        ...(fk.onUpdate === undefined ? {} : { onUpdate: fk.onUpdate }),
        ...(relatedName === undefined ? {} : { relatedName }),
        ...(fk.name === undefined ? {} : { constraintName: fk.name }),
      });
      continue;
    }
    const backing: RawColumn = keyColumns[0] as RawColumn;
    if (merged.has(backing.key)) {
      warn(
        ctx,
        `${label}: the column "${backing.key}" has more than one foreign key; only the first was kept.`
      );
      continue;
    }
    const stripped: string = stripIdSuffix(backing.key);
    let name: string =
      fk.ownerName ??
      (stripped === '' || takenNames.has(stripped) ? backing.key : stripped);
    if (takenNames.has(name) && name !== backing.key) {
      name = backing.key;
    }
    takenNames.add(name);
    merged.add(backing.key);
    renamed.set(backing.key, name);
    const isPrimary: boolean = pkKeys.length === 1 && pkKeys[0] === backing.key;
    const referenced: string | undefined = fk.target.columns[0];
    const referencedField: string | undefined =
      referenced === undefined
        ? undefined
        : fieldNameForColumn(target, referenced);
    const isOneToOne: boolean =
      isPrimary || uniqueKeys.has(backing.key) || fk.reverseScalar === true;
    relations.push({
      name,
      kind: isOneToOne ? 'oneToOne' : 'foreignKey',
      targetModel,
      columnName: backing.field.columnName,
      isNullable: backing.field.isNullable && !isPrimary,
      onDelete: fk.onDelete ?? 'noAction',
      ...(relatedName === undefined ? {} : { relatedName }),
      ...(referencedField === undefined ||
      target === undefined ||
      sameList(primaryKeyOf(target), [referencedField])
        ? {}
        : { toField: referencedField }),
      ...(isPrimary ? { isPrimaryKey: true } : {}),
      ...(fk.onUpdate === undefined ? {} : { onUpdate: fk.onUpdate }),
      ...(fk.name === undefined ? {} : { constraintName: fk.name }),
    });
  }
  relations.push(...table.m2m);

  const fields: IrField[] = columns
    .filter((column: RawColumn) => !merged.has(column.key))
    .map((column: RawColumn) => column.field);
  const fieldByKey: Map<string, IrField> = new Map(
    columns.map((column: RawColumn) => [column.key, column.field])
  );

  // Indexes, with columns that became relations renamed.
  const known: Set<string> = new Set([
    ...fields.map((field: IrField) => field.name),
    ...relations.map((relation: IrRelation) => relation.name),
    ...compositeForeignKeys.map(
      (composite: IrCompositeForeignKey) => composite.name
    ),
  ]);
  const indexes: IrIndex[] = [];
  for (const raw of table.indexes) {
    const indexNames: string[] = raw.columns.map(
      (key: string) => renamed.get(key) ?? key
    );
    if (
      indexNames.some(
        (name: string) => !known.has(name) && !fieldByKey.has(name)
      )
    ) {
      continue;
    }
    const onRelation: boolean =
      indexNames.length === 1 &&
      relations.some((relation: IrRelation) => relation.name === indexNames[0]);
    if (raw.isUnique && onRelation && raw.name === undefined) {
      continue;
    }
    const single: IrField | undefined =
      indexNames.length === 1
        ? fields.find((field: IrField) => field.name === indexNames[0])
        : undefined;
    if (
      raw.isUnique &&
      raw.name === undefined &&
      single !== undefined &&
      !single.isPrimaryKey
    ) {
      single.isUnique = true;
      continue;
    }
    const fieldOptions: Record<string, IrIndexFieldOptions> = {};
    for (const [key, option] of Object.entries(raw.fieldOptions)) {
      fieldOptions[renamed.get(key) ?? key] = option;
    }
    indexes.push({
      fields: indexNames,
      isUnique: raw.isUnique,
      ...(raw.name === undefined ? {} : { name: raw.name }),
      ...(raw.method === undefined ? {} : { method: raw.method }),
      ...(Object.keys(fieldOptions).length === 0 ? {} : { fieldOptions }),
    });
  }

  // Primary key.
  let compositePrimaryKey: string[] | undefined;
  if (pkKeys.length === 0) {
    warn(
      ctx,
      `${label}: the table has no primary key; SQLAlchemy needs one to map a class, so add primary_key=True to a column.`
    );
  } else if (pkKeys.length > 1) {
    compositePrimaryKey = pkKeys.map((key: string) => renamed.get(key) ?? key);
    for (const key of pkKeys) {
      const field: IrField | undefined = fieldByKey.get(key);
      if (field !== undefined) {
        field.isPrimaryKey = false;
        field.isUnique = false;
        field.isNullable = false;
      }
    }
    for (const relation of relations) {
      delete relation.isPrimaryKey;
    }
  } else if (table.pk !== undefined) {
    const field: IrField | undefined = fields.find(
      (candidate: IrField) => candidate.name === table.pk?.[0]
    );
    if (field !== undefined) {
      field.isPrimaryKey = true;
      field.isNullable = false;
    }
  }
  // A lone integer primary key counts up unless the column says otherwise.
  if (pkKeys.length === 1) {
    const onlyKey: string | undefined = pkKeys[0];
    const column: RawColumn | undefined = columns.find(
      (candidate: RawColumn) => candidate.key === onlyKey
    );
    if (
      column !== undefined &&
      column.wantsAutoIncrement &&
      !merged.has(column.key) &&
      column.field.default === undefined &&
      column.field.generated === undefined
    ) {
      column.field.default = { kind: 'autoIncrement' };
    }
  }

  return {
    name: table.modelName,
    tableName: table.tableName,
    appLabel: ctx.options.appLabel,
    fields,
    relations,
    indexes,
    ...(compositePrimaryKey === undefined ? {} : { compositePrimaryKey }),
    ...(table.pkName !== undefined && compositePrimaryKey !== undefined
      ? { primaryKeyName: table.pkName }
      : {}),
    ...(table.schema === undefined ? {} : { schema: table.schema }),
    ...(compositeForeignKeys.length === 0 ? {} : { compositeForeignKeys }),
  };
}

function addStubModels(ctx: Ctx, models: IrModel[], warnings: string[]): void {
  const known: Set<string> = new Set(
    models.map((model: IrModel) => model.name)
  );
  const stubs: IrModel[] = [];
  for (const model of models) {
    const references: { via: string; target: string }[] = [
      ...model.relations
        .filter((relation: IrRelation) => relation.kind !== 'manyToMany')
        .map((relation: IrRelation) => ({
          via: relation.name,
          target: relation.targetModel,
        })),
      ...(model.compositeForeignKeys ?? []).map(
        (composite: IrCompositeForeignKey) => ({
          via: composite.name,
          target: composite.targetModel,
        })
      ),
    ];
    for (const { via, target } of references) {
      if (known.has(target)) {
        continue;
      }
      known.add(target);
      stubs.push({
        name: target,
        tableName: ctx.stubTables.get(target) ?? toSnakeCase(target),
        appLabel: ctx.options.appLabel,
        fields: [
          {
            name: 'id',
            columnName: 'id',
            type: 'int',
            isPrimaryKey: true,
            isUnique: false,
            isNullable: false,
            isAutoUpdated: false,
            default: { kind: 'autoIncrement' },
          },
        ],
        relations: [],
        indexes: [],
      });
      warnings.push(
        `${model.name}.${via} references "${target}", which is not a table in the input. ` +
          `A stub model with an auto-increment id was generated; replace it with the real definition.`
      );
    }
  }
  // Many-to-many targets are checked when they are linked, so only foreign keys can dangle.
  models.push(...stubs);
}
