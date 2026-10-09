import { basename } from 'node:path';
import type Parser from 'web-tree-sitter';
import type {
  IrDefault,
  IrEnum,
  IrEnumValue,
  IrField,
  IrGenerated,
  IrIndex,
  IrModel,
  IrOnDelete,
  IrRelation,
  IrScalarType,
  IrSchema,
} from '../ir.js';
import { singularize, toPascalCase, toSnakeCase } from '../naming.js';
import { err, ok, type Result } from '../result.js';
import {
  argumentNodes,
  collectDeclarations,
  evaluateNode,
  getPhpParser,
  lastNameSegment,
  readEnumDeclaration,
  resolveClassName,
  type EnumInfo,
  type FileContext,
  type PhpArgumentNode,
  type PhpValue,
  type SyntaxNode,
} from './phpSyntax.js';

export interface LaravelSourceFile {
  path: string;
  text: string;
}

export interface LaravelParseOptions {
  /** App label stored on each model (Laravel itself has no equivalent). */
  appLabel: string;
}

// ---------------------------------------------------------------------------
// Static tables
// ---------------------------------------------------------------------------

/** Framework classes an Eloquent model may extend, as fully qualified names. */
const MODEL_BASE_CLASSES: ReadonlySet<string> = new Set([
  'Illuminate\\Database\\Eloquent\\Model',
  'Illuminate\\Foundation\\Auth\\User',
  'Illuminate\\Database\\Eloquent\\Relations\\Pivot',
  'Illuminate\\Database\\Eloquent\\Relations\\MorphPivot',
]);

/** Short base class names accepted when the import cannot be resolved (for example a file read on its own). */
const MODEL_BASE_SHORT_NAMES: ReadonlySet<string> = new Set([
  'Model',
  'Authenticatable',
  'Pivot',
  'MorphPivot',
]);

const RELATION_METHODS: ReadonlySet<string> = new Set([
  'hasOne',
  'hasMany',
  'belongsTo',
  'belongsToMany',
  'hasOneThrough',
  'hasManyThrough',
  'morphTo',
  'morphOne',
  'morphMany',
  'morphToMany',
  'morphedByMany',
  'hasOneOfMany',
  'latestOfMany',
  'oldestOfMany',
]);

const RELATION_RETURN_TYPES: ReadonlySet<string> = new Set([
  'HasOne',
  'HasMany',
  'BelongsTo',
  'BelongsToMany',
  'HasOneThrough',
  'HasManyThrough',
  'MorphTo',
  'MorphOne',
  'MorphMany',
  'MorphToMany',
  'Relation',
]);

/** Methods that may follow a relationship call without changing which rows it relates. */
const HARMLESS_RELATION_MODIFIERS: ReadonlySet<string> = new Set([
  'withPivot',
  'withTimestamps',
  'as',
  'using',
  'withDefault',
  'withoutGlobalScopes',
  'withoutGlobalScope',
  'orderBy',
  'orderByDesc',
  'latest',
  'oldest',
  'withCount',
  'with',
  'withTrashed',
  'onlyTrashed',
  'select',
  'addSelect',
  'distinct',
  'limit',
  'take',
  'inRandomOrder',
  'cascadeOnDelete',
]);

const ON_DELETE_ACTIONS: Readonly<Record<string, IrOnDelete>> = {
  cascade: 'cascade',
  'set null': 'setNull',
  restrict: 'restrict',
  'no action': 'noAction',
  'set default': 'setDefault',
};

const GEOMETRY_TYPES: ReadonlySet<string> = new Set([
  'geometry',
  'geography',
  'point',
  'lineString',
  'polygon',
  'geometryCollection',
  'multiPoint',
  'multiLineString',
  'multiPolygon',
  'multiPolygonZ',
]);

/** `DB::` helpers that run SQL the parser cannot interpret. */
const RAW_SQL_METHODS: ReadonlySet<string> = new Set([
  'statement',
  'unprepared',
]);

/** Blueprint methods that change nothing the IR represents. */
const IGNORED_TABLE_METHODS: ReadonlySet<string> = new Set([
  'engine',
  'charset',
  'collation',
  'comment',
  'temporary',
]);

/** Schema methods that change nothing the IR represents. */
const IGNORED_SCHEMA_METHODS: ReadonlySet<string> = new Set([
  'disableForeignKeyConstraints',
  'enableForeignKeyConstraints',
  'defaultStringLength',
  'defaultMorphKeyType',
  'morphUsingUuids',
  'morphUsingUlids',
]);

/** Column modifiers that change nothing the IR represents. */
const IGNORED_COLUMN_MODIFIERS: ReadonlySet<string> = new Set([
  'unsigned',
  'comment',
  'after',
  'first',
  'charset',
  'collation',
  'invisible',
  'algorithm',
  'language',
  'deferrable',
  'initiallyImmediate',
  'notValid',
  'lock',
]);

const CONTROL_STATEMENTS: ReadonlySet<string> = new Set([
  'if_statement',
  'foreach_statement',
  'for_statement',
  'while_statement',
  'do_statement',
  'switch_statement',
  'try_statement',
]);

const CLAUSE_STATEMENTS: ReadonlySet<string> = new Set([
  'else_clause',
  'else_if_clause',
  'catch_clause',
  'finally_clause',
  'case_statement',
  'default_statement',
  'switch_block',
  'colon_block',
]);

const UNCOUNTABLE_NOUNS: ReadonlySet<string> = new Set([
  'audio',
  'bison',
  'cattle',
  'chassis',
  'compensation',
  'data',
  'deer',
  'education',
  'emoji',
  'equipment',
  'evidence',
  'feedback',
  'firmware',
  'fish',
  'furniture',
  'gold',
  'hardware',
  'information',
  'knowledge',
  'media',
  'metadata',
  'money',
  'moose',
  'news',
  'nutrition',
  'offspring',
  'police',
  'rain',
  'rice',
  'series',
  'sheep',
  'software',
  'staff',
  'species',
  'swine',
  'traffic',
  'wheat',
]);

const IRREGULAR_PLURALS: Readonly<Record<string, string>> = {
  person: 'people',
  man: 'men',
  woman: 'women',
  child: 'children',
  foot: 'feet',
  tooth: 'teeth',
  goose: 'geese',
  mouse: 'mice',
  ox: 'oxen',
  quiz: 'quizzes',
  move: 'moves',
  sex: 'sexes',
};

// ---------------------------------------------------------------------------
// Replayed schema state
// ---------------------------------------------------------------------------

interface ColumnDef {
  name: string;
  type: IrScalarType;
  isNullable: boolean;
  default?: IrDefault;
  maxLength?: number;
  /** True when the migration spelled out the length (`string('x', 100)`). */
  hasExplicitLength: boolean;
  maxDigits?: number;
  decimalPlaces?: number;
  isAutoIncrement: boolean;
  isAutoUpdated: boolean;
  /** Values of an `enum` column. */
  enumValues?: string[];
  unsupportedType?: string;
  generated?: IrGenerated;
}

interface IndexDef {
  columns: string[];
  isUnique: boolean;
  kind?: 'fulltext';
  /** Explicit name from the migration. */
  name?: string;
}

interface ForeignKeyDef {
  columns: string[];
  /** Referenced table; absent until `on()` / `constrained()` supplies it. */
  refTable?: string;
  /** Model class (fully qualified or as written) when `constrained()` follows `foreignIdFor()`. */
  refModel?: string;
  refColumns: string[];
  onDelete?: IrOnDelete;
  onUpdate?: IrOnDelete;
  name?: string;
}

interface TableState {
  name: string;
  columns: Map<string, ColumnDef>;
  indexes: IndexDef[];
  foreignKeys: ForeignKeyDef[];
  primaryKey: string[] | undefined;
  /** True when the table was only seen in `Schema::table` calls, so its other columns are unknown. */
  isPartial: boolean;
}

interface ReplayState {
  tables: Map<string, TableState>;
  warnings: string[];
}

interface MigrationClass {
  /** File name, for messages. */
  file: string;
  ctx: FileContext;
  up: SyntaxNode;
}

// ---------------------------------------------------------------------------
// Model structures
// ---------------------------------------------------------------------------

type RelationKind =
  'hasOne' | 'hasMany' | 'belongsTo' | 'belongsToMany' | 'through' | 'morph';

interface RelationMethod {
  /** Method name, which is the relation name. */
  name: string;
  /** Call as written, for example "hasMany". */
  call: string;
  kind: RelationKind;
  /** Fully qualified class name of the related model. */
  relatedFqn?: string;
  foreignKey?: string;
  /** `localKey` (hasOne / hasMany) or `ownerKey` (belongsTo). */
  otherKey?: string;
  pivotTable?: string;
  /** A pivot model class given in place of a table name. */
  pivotModelFqn?: string;
  relatedPivotKey?: string;
  parentKey?: string;
  relatedKey?: string;
  /** Modifiers chained after the call that are not understood. */
  extraModifiers: string[];
}

interface ModelClass {
  name: string;
  fqn: string;
  ctx: FileContext;
  parentFqn?: string;
  isAbstract: boolean;
  table?: string;
  primaryKey?: string;
  keyType?: string;
  incrementing?: boolean;
  timestamps?: boolean;
  /** `CREATED_AT` constant: a column name, or null when disabled. */
  createdAt?: string | null;
  updatedAt?: string | null;
  deletedAt?: string;
  /** Columns named by an overridden `uniqueIds()` (HasUuids / HasUlids). */
  uniqueIds?: string[];
  casts: Map<string, PhpValue>;
  traits: string[];
  relations: RelationMethod[];
}

/** A model as resolved through its parent classes. */
interface EffectiveModel {
  source: ModelClass;
  table: string;
  primaryKey?: string;
  keyType?: string;
  incrementing?: boolean;
  timestamps: boolean;
  createdAt: string | null;
  updatedAt: string | null;
  deletedAt: string;
  /** Columns that get a generated UUID / ULID: `uniqueIds()` when overridden, otherwise the primary key. */
  uniqueIds?: string[];
  casts: Map<string, PhpValue>;
  usesSoftDeletes: boolean;
  usesUuids: boolean;
  usesUlids: boolean;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function pushWarning(warnings: string[], message: string): void {
  if (!warnings.includes(message)) {
    warnings.push(message);
  }
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

function sameList(first: string[], second: string[]): boolean {
  return (
    first.length === second.length &&
    first.every((item: string, index: number) => item === second[index])
  );
}

function pluralizeWord(word: string): string {
  const lower: string = word.toLowerCase();
  if (UNCOUNTABLE_NOUNS.has(lower)) {
    return word;
  }
  const irregular: string | undefined = IRREGULAR_PLURALS[lower];
  if (irregular !== undefined) {
    return irregular;
  }
  const rules: [RegExp, string][] = [
    [/(s)tatus$/i, '$1tatuses'],
    [/(alias)$/i, '$1es'],
    [/(matr|vert|ind)(ix|ex)$/i, '$1ices'],
    [/(octop|vir)us$/i, '$1i'],
    [/(ax|test)is$/i, '$1es'],
    [/(x|ch|ss|sh)$/i, '$1es'],
    [/([^aeiouy]|qu)y$/i, '$1ies'],
    [/(?:([^f])fe|([lr])f)$/i, '$1$2ves'],
    [/(lea)f$/i, '$1ves'],
    [/sis$/i, 'ses'],
    [/([ti])um$/i, '$1a'],
    [/(buffal|tomat|potat|her)o$/i, '$1oes'],
    [/(us|as)$/i, '$1es'],
    [/s$/i, 's'],
  ];
  for (const [pattern, replacement] of rules) {
    if (pattern.test(word)) {
      return word.replace(pattern, replacement);
    }
  }
  return `${word}s`;
}

/** Laravel's `Str::snake`: every capital starts a new word, so `APIKey` becomes `a_p_i_key`. */
function eloquentSnake(name: string): string {
  return name.replace(/(.)(?=[A-Z])/g, '$1_').toLowerCase();
}

/** Pluralizes the last word of a snake_case name, like Laravel's `Str::plural`. */
function pluralizeSnake(snakeName: string): string {
  const parts: string[] = snakeName.split('_');
  const last: string = parts[parts.length - 1] ?? '';
  parts[parts.length - 1] = pluralizeWord(last);
  return parts.join('_');
}

/** The table Eloquent assumes for a model without `$table`: `UserProfile` becomes `user_profiles`. */
function conventionalTableName(className: string): string {
  return pluralizeSnake(eloquentSnake(className));
}

/** The name Laravel gives an index when the migration does not: `posts_title_index`. */
function conventionalIndexName(
  table: string,
  columns: string[],
  type: 'index' | 'unique' | 'primary' | 'fulltext' | 'foreign'
): string {
  return `${table}_${columns.join('_')}_${type}`
    .toLowerCase()
    .replace(/[-.]/g, '_');
}

// ---------------------------------------------------------------------------
// Syntax helpers
// ---------------------------------------------------------------------------

interface CallLink {
  name: string;
  args: PhpArgumentNode[];
  node: SyntaxNode;
}

interface CallChain {
  /** The expression the chain starts from: `$table`, `$this`, or the class of a static call such as `Schema`. */
  root: SyntaxNode;
  /** True when the first link is a static call (`Schema::create(...)`). */
  isStatic: boolean;
  /** Calls in the order they are made. */
  links: CallLink[];
}

/** Flattens `$a->b()->c()` or `A::b()->c()` into its root and calls. */
function readChain(expression: SyntaxNode): CallChain | undefined {
  const links: CallLink[] = [];
  let current: SyntaxNode = expression;
  for (;;) {
    if (
      current.type === 'member_call_expression' ||
      current.type === 'nullsafe_member_call_expression'
    ) {
      const nameNode: SyntaxNode | null = current.childForFieldName('name');
      const objectNode: SyntaxNode | null = current.childForFieldName('object');
      if (nameNode === null || objectNode === null) {
        return undefined;
      }
      links.unshift({
        name: nameNode.text,
        args: argumentNodes(current.childForFieldName('arguments')),
        node: current,
      });
      current = objectNode;
    } else if (current.type === 'scoped_call_expression') {
      const nameNode: SyntaxNode | null = current.childForFieldName('name');
      const scopeNode: SyntaxNode | null = current.childForFieldName('scope');
      if (nameNode === null || scopeNode === null) {
        return undefined;
      }
      links.unshift({
        name: nameNode.text,
        args: argumentNodes(current.childForFieldName('arguments')),
        node: current,
      });
      return { root: scopeNode, isStatic: true, links };
    } else if (current.type === 'parenthesized_expression') {
      const inner: SyntaxNode | undefined = current.namedChildren[0];
      if (inner === undefined) {
        return undefined;
      }
      current = inner;
    } else {
      return { root: current, isStatic: false, links };
    }
  }
}

function rootName(chain: CallChain): string {
  return chain.root.text.replace(/\s+/g, '').replace(/^\\/, '');
}

function isFacade(chain: CallChain, facade: string): boolean {
  const name: string = rootName(chain);
  return (
    chain.isStatic &&
    (name === facade || name === `Illuminate\\Support\\Facades\\${facade}`)
  );
}

/** A value of an argument: a PHP constant, a raw SQL expression, or the current time. */
type ArgValue = PhpValue | { kind: 'raw'; sql: string } | { kind: 'now' };

function evaluateArgument(node: SyntaxNode): ArgValue {
  if (node.type === 'scoped_call_expression') {
    const chain: CallChain | undefined = readChain(node);
    const first: CallLink | undefined = chain?.links[0];
    if (chain !== undefined && first !== undefined) {
      const scope: string = rootName(chain);
      const lastScope: string = lastNameSegment(scope);
      if (lastScope === 'DB' && first.name === 'raw') {
        const sql: ArgValue | undefined = first.args[0]
          ? evaluateArgument(first.args[0].node)
          : undefined;
        if (sql !== undefined && sql.kind === 'string') {
          return { kind: 'raw', sql: sql.value };
        }
        return { kind: 'other', text: node.text };
      }
      if (
        (lastScope === 'Carbon' || lastScope === 'CarbonImmutable') &&
        first.name === 'now'
      ) {
        return { kind: 'now' };
      }
    }
  }
  if (node.type === 'function_call_expression') {
    const functionNode: SyntaxNode | null = node.childForFieldName('function');
    if (functionNode !== null && functionNode.text === 'now') {
      return { kind: 'now' };
    }
  }
  if (node.type === 'object_creation_expression') {
    const evaluated: PhpValue = evaluateNode(node);
    if (
      evaluated.kind === 'new' &&
      lastNameSegment(evaluated.className) === 'Expression'
    ) {
      const sql: PhpValue | undefined = evaluated.args[0];
      if (sql !== undefined && sql.kind === 'string') {
        return { kind: 'raw', sql: sql.value };
      }
    }
    return evaluated;
  }
  return evaluateNode(node);
}

function argumentAt(
  args: PhpArgumentNode[],
  index: number,
  name?: string
): PhpArgumentNode | undefined {
  if (name !== undefined) {
    const named: PhpArgumentNode | undefined = args.find(
      (candidate: PhpArgumentNode) => candidate.name === name
    );
    if (named !== undefined) {
      return named;
    }
  }
  return args.filter(
    (candidate: PhpArgumentNode) => candidate.name === undefined
  )[index];
}

/** Reads a string argument. `undefined` means absent; `null` means present but not a literal string. */
function stringArgument(
  args: PhpArgumentNode[],
  index: number,
  name?: string
): string | null | undefined {
  const argument: PhpArgumentNode | undefined = argumentAt(args, index, name);
  if (argument === undefined) {
    return undefined;
  }
  const value: ArgValue = evaluateArgument(argument.node);
  return value.kind === 'string' ? value.value : null;
}

/** Reads an integer argument (`undefined` when absent, `null` when not a literal number). */
function numberArgument(
  args: PhpArgumentNode[],
  index: number,
  name?: string
): number | null | undefined {
  const argument: PhpArgumentNode | undefined = argumentAt(args, index, name);
  if (argument === undefined) {
    return undefined;
  }
  const value: ArgValue = evaluateArgument(argument.node);
  return value.kind === 'number' ? value.value : null;
}

/** Reads a boolean argument (`undefined` when absent, `null` when not a literal boolean). */
function booleanArgument(
  args: PhpArgumentNode[],
  index: number,
  name?: string
): boolean | null | undefined {
  const argument: PhpArgumentNode | undefined = argumentAt(args, index, name);
  if (argument === undefined) {
    return undefined;
  }
  const value: ArgValue = evaluateArgument(argument.node);
  return value.kind === 'bool' ? value.value : null;
}

/** Reads a string or an array of strings. `null` when something in it is not a literal string. */
function stringListArgument(
  argument: PhpArgumentNode | undefined
): string[] | null | undefined {
  if (argument === undefined) {
    return undefined;
  }
  const value: ArgValue = evaluateArgument(argument.node);
  if (value.kind === 'string') {
    return [value.value];
  }
  if (value.kind === 'array') {
    const items: string[] = [];
    for (const item of value.items) {
      if (item.value.kind !== 'string') {
        return null;
      }
      items.push(item.value.value);
    }
    return items;
  }
  return null;
}

/** All string arguments of a call: `dropColumn('a', 'b')` and `dropColumn(['a', 'b'])` both give `['a', 'b']`. */
function allStringArguments(args: PhpArgumentNode[]): string[] | null {
  const names: string[] = [];
  for (const argument of args) {
    const list: string[] | null | undefined = stringListArgument(argument);
    if (list === null || list === undefined) {
      return null;
    }
    names.push(...list);
  }
  return names;
}

/** Fully qualified class name from `Foo::class` or a class-name string. */
function classReference(
  value: ArgValue,
  ctx: FileContext,
  ownerFqn: string
): string | undefined {
  if (value.kind === 'classRef') {
    const lowered: string = value.name.toLowerCase();
    return lowered === 'self' || lowered === 'static'
      ? ownerFqn
      : resolveClassName(value.name, ctx);
  }
  if (value.kind === 'string' && /^\\?[A-Za-z_][\w\\]*$/.test(value.value)) {
    return resolveClassName(value.value, ctx);
  }
  return undefined;
}

function shorten(text: string, length: number = 60): string {
  const flat: string = text.replace(/\s+/g, ' ').trim();
  return flat.length > length ? `${flat.slice(0, length - 3)}...` : flat;
}

// ---------------------------------------------------------------------------
// Migration replay
// ---------------------------------------------------------------------------

const NOW_SQL: RegExp =
  /^(now\(\)|current_timestamp(\(\d*\))?|getdate\(\)|sysdate|systimestamp|localtimestamp(\(\d*\))?|datetime\('now'\)|\(datetime\('now'\)\))$/i;
const UUID_SQL: RegExp =
  /^(uuid_generate_v[14]\(\)|gen_random_uuid\(\)|uuid\(\)|newid\(\)|newsequentialid\(\)|sys_guid\(\))$/i;

interface MigrationContext {
  state: ReplayState;
  /** Migration file name, for messages. */
  file: string;
  /** Tables touched so far, in order; used to name the tables a conditional or loop affected. */
  touched: string[];
}

/** What a chain of Blueprint calls is building. */
interface ChainTarget {
  columns: ColumnDef[];
  foreignKey?: ForeignKeyDef;
  /** The `foreignId` family column that `constrained()` refers to. */
  foreignIdColumn?: ColumnDef;
  /** Model class given to `foreignIdFor()`. */
  foreignIdModel?: string;
  change: boolean;
}

function newColumn(
  name: string,
  type: IrScalarType,
  overrides: Partial<ColumnDef> = {}
): ColumnDef {
  return {
    name,
    type,
    isNullable: false,
    hasExplicitLength: false,
    isAutoIncrement: false,
    isAutoUpdated: false,
    ...overrides,
  };
}

function emptyTable(name: string, isPartial: boolean): TableState {
  return {
    name,
    columns: new Map<string, ColumnDef>(),
    indexes: [],
    foreignKeys: [],
    primaryKey: undefined,
    isPartial,
  };
}

function actionFromText(text: string): IrOnDelete | undefined {
  return ON_DELETE_ACTIONS[text.trim().toLowerCase()];
}

function addIndex(table: TableState, definition: IndexDef): void {
  const existing: IndexDef | undefined = table.indexes.find(
    (candidate: IndexDef) =>
      sameList(candidate.columns, definition.columns) &&
      candidate.isUnique === definition.isUnique &&
      candidate.kind === definition.kind
  );
  if (existing === undefined) {
    table.indexes.push(definition);
  } else if (definition.name !== undefined) {
    existing.name = definition.name;
  }
}

function addForeignKey(table: TableState, definition: ForeignKeyDef): void {
  const position: number = table.foreignKeys.findIndex(
    (candidate: ForeignKeyDef) =>
      sameList(candidate.columns, definition.columns)
  );
  if (position >= 0) {
    table.foreignKeys.splice(position, 1, definition);
  } else {
    table.foreignKeys.push(definition);
  }
}

function removeColumn(table: TableState, columnName: string): void {
  table.columns.delete(columnName);
  table.indexes = table.indexes
    .map((index: IndexDef): IndexDef => ({
      ...index,
      columns: index.columns.filter((name: string) => name !== columnName),
    }))
    .filter((index: IndexDef) => index.columns.length > 0);
  table.foreignKeys = table.foreignKeys.filter(
    (key: ForeignKeyDef) => !key.columns.includes(columnName)
  );
  if (table.primaryKey?.includes(columnName) === true) {
    const remaining: string[] = table.primaryKey.filter(
      (name: string) => name !== columnName
    );
    table.primaryKey = remaining.length > 0 ? remaining : undefined;
  }
}

function renameColumn(table: TableState, from: string, to: string): void {
  const rebuilt: Map<string, ColumnDef> = new Map<string, ColumnDef>();
  for (const [name, column] of table.columns) {
    if (name === from) {
      rebuilt.set(to, { ...column, name: to });
    } else {
      rebuilt.set(name, column);
    }
  }
  table.columns = rebuilt;
  const rename = (names: string[]): string[] =>
    names.map((name: string) => (name === from ? to : name));
  for (const index of table.indexes) {
    index.columns = rename(index.columns);
  }
  for (const key of table.foreignKeys) {
    key.columns = rename(key.columns);
  }
  if (table.primaryKey !== undefined) {
    table.primaryKey = rename(table.primaryKey);
  }
}

/** Converts the argument of `default()` for a column; undefined means no default (or one that could not be read). */
function convertDefault(
  value: ArgValue,
  column: ColumnDef,
  table: string,
  warnings: string[]
): IrDefault | undefined {
  switch (value.kind) {
    case 'null':
      return undefined;
    case 'bool':
      return { kind: 'literal', value: value.value };
    case 'number':
      return column.type === 'string' || column.type === 'text'
        ? { kind: 'literal', value: String(value.value) }
        : { kind: 'literal', value: value.value };
    case 'now':
      return { kind: 'now' };
    case 'string':
      return convertTextDefault(value.value, column);
    case 'raw': {
      let sql: string = value.sql.trim();
      while (sql.startsWith('(') && sql.endsWith(')')) {
        sql = sql.slice(1, -1).trim();
      }
      if (NOW_SQL.test(sql)) {
        return { kind: 'now' };
      }
      if (UUID_SQL.test(sql)) {
        return { kind: 'uuid' };
      }
      if (/^-?\d+(\.\d+)?$/.test(sql)) {
        return { kind: 'literal', value: Number(sql) };
      }
      if (/^(true|false)$/i.test(sql)) {
        return { kind: 'literal', value: sql.toLowerCase() === 'true' };
      }
      const quoted: RegExpExecArray | null = /^'((?:[^']|'')*)'$/.exec(sql);
      if (quoted !== null) {
        return convertTextDefault(
          (quoted[1] ?? '').replace(/''/g, "'"),
          column
        );
      }
      return { kind: 'dbExpression', expression: sql };
    }
    default:
      warnings.push(
        `${table}.${column.name}: the default value (${shorten(describeValue(value))}) cannot be evaluated statically and was ignored.`
      );
      return undefined;
  }
}

function describeValue(value: ArgValue): string {
  switch (value.kind) {
    case 'other':
      return value.text;
    case 'array':
      return 'an array';
    case 'classRef':
      return `${value.name}::class`;
    case 'constant':
      return `${value.owner}::${value.name}`;
    default:
      return value.kind;
  }
}

function convertTextDefault(text: string, column: ColumnDef): IrDefault {
  const trimmed: string = text.trim();
  switch (column.type) {
    case 'dateTime':
    case 'date':
    case 'time':
      if (NOW_SQL.test(trimmed) || /^current_(date|time)$/i.test(trimmed)) {
        return { kind: 'now' };
      }
      break;
    case 'uuid':
    case 'string':
      if (UUID_SQL.test(trimmed)) {
        return { kind: 'uuid' };
      }
      break;
    case 'boolean':
      if (/^(1|true)$/i.test(trimmed)) {
        return { kind: 'literal', value: true };
      }
      if (/^(0|false)$/i.test(trimmed)) {
        return { kind: 'literal', value: false };
      }
      break;
    case 'int':
    case 'bigInt':
    case 'float':
    case 'decimal':
      if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
        return { kind: 'literal', value: Number(trimmed) };
      }
      break;
    default:
      break;
  }
  return { kind: 'literal', value: text };
}

const INTEGER_METHODS: Readonly<Record<string, IrScalarType>> = {
  integer: 'int',
  tinyInteger: 'int',
  smallInteger: 'int',
  mediumInteger: 'int',
  bigInteger: 'bigInt',
  unsignedInteger: 'int',
  unsignedTinyInteger: 'int',
  unsignedSmallInteger: 'int',
  unsignedMediumInteger: 'int',
  unsignedBigInteger: 'bigInt',
};

const INCREMENT_METHODS: Readonly<Record<string, IrScalarType>> = {
  increments: 'int',
  integerIncrements: 'int',
  tinyIncrements: 'int',
  smallIncrements: 'int',
  mediumIncrements: 'int',
  bigIncrements: 'bigInt',
};

const TEXT_METHODS: ReadonlySet<string> = new Set([
  'text',
  'tinyText',
  'mediumText',
  'longText',
]);

const DATE_METHODS: Readonly<Record<string, IrScalarType>> = {
  date: 'date',
  dateTime: 'dateTime',
  dateTimeTz: 'dateTime',
  timestamp: 'dateTime',
  timestampTz: 'dateTime',
  time: 'time',
  timeTz: 'time',
};

/** Methods that create a pair of `created_at` / `updated_at` columns. */
const TIMESTAMP_PAIR_METHODS: ReadonlySet<string> = new Set([
  'timestamps',
  'timestampsTz',
  'nullableTimestamps',
  'datetimes',
  'datetimesTz',
]);

const SOFT_DELETE_METHODS: ReadonlySet<string> = new Set([
  'softDeletes',
  'softDeletesTz',
  'softDeletesDatetime',
]);

/** `morphs`-style methods: [type of the id column, nullable]. */
const MORPH_METHODS: Readonly<
  Record<string, { id: 'int' | 'uuid' | 'ulid'; nullable: boolean }>
> = {
  morphs: { id: 'int', nullable: false },
  nullableMorphs: { id: 'int', nullable: true },
  uuidMorphs: { id: 'uuid', nullable: false },
  nullableUuidMorphs: { id: 'uuid', nullable: true },
  ulidMorphs: { id: 'ulid', nullable: false },
  nullableUlidMorphs: { id: 'ulid', nullable: true },
};

/** Looks at the first call of a Blueprint statement and creates the columns or runs the table command. */
function startCall(
  table: TableState,
  first: CallLink,
  mctx: MigrationContext
): ChainTarget | undefined {
  const warnings: string[] = mctx.state.warnings;
  const method: string = first.name;
  const args: PhpArgumentNode[] = first.args;
  const skip = (what: string): undefined => {
    pushWarning(
      warnings,
      `${table.name}: ${method}() ${what}; the call was skipped.`
    );
    return undefined;
  };
  /** The column name argument, or the fallback; null when it is not a literal. */
  const columnName = (fallback?: string): string | null => {
    const given: string | null | undefined = stringArgument(args, 0, 'column');
    if (given === undefined) {
      return fallback ?? null;
    }
    return given;
  };
  const single = (
    type: IrScalarType,
    fallback: string | undefined,
    overrides: Partial<ColumnDef> = {}
  ): ChainTarget | undefined => {
    const name: string | null = columnName(fallback);
    if (name === null) {
      return skip('has a column name that is not a string literal');
    }
    return {
      columns: [newColumn(name, type, overrides)],
      change: false,
    };
  };
  const primaryTarget = (
    type: IrScalarType,
    fallback: string | undefined
  ): ChainTarget | undefined => {
    const target: ChainTarget | undefined = single(type, fallback, {
      isAutoIncrement: true,
      default: { kind: 'autoIncrement' },
    });
    const created: ColumnDef | undefined = target?.columns[0];
    if (created !== undefined) {
      table.primaryKey = [created.name];
    }
    return target;
  };

  // Columns --------------------------------------------------------------
  if (method === 'id') {
    return primaryTarget('bigInt', 'id');
  }
  const incrementType: IrScalarType | undefined = INCREMENT_METHODS[method];
  if (incrementType !== undefined) {
    return primaryTarget(incrementType, undefined);
  }
  const integerType: IrScalarType | undefined = INTEGER_METHODS[method];
  if (integerType !== undefined) {
    const autoIncrement: boolean =
      booleanArgument(args, 1, 'autoIncrement') === true;
    return autoIncrement
      ? primaryTarget(integerType, undefined)
      : single(integerType, undefined);
  }
  if (method === 'string' || method === 'char') {
    const length: number | null | undefined = numberArgument(args, 1, 'length');
    if (length === null) {
      pushWarning(
        warnings,
        `${table.name}: the length of ${method}() is not a number literal; the default length 255 was used.`
      );
    }
    return single('string', undefined, {
      maxLength: typeof length === 'number' ? length : 255,
      hasExplicitLength: typeof length === 'number',
    });
  }
  if (TEXT_METHODS.has(method)) {
    return single('text', undefined);
  }
  if (method === 'boolean') {
    return single('boolean', undefined);
  }
  if (method === 'decimal' || method === 'unsignedDecimal') {
    const total: number | null | undefined = numberArgument(args, 1, 'total');
    const places: number | null | undefined = numberArgument(args, 2, 'places');
    return single('decimal', undefined, {
      maxDigits: typeof total === 'number' ? total : 8,
      decimalPlaces: typeof places === 'number' ? places : 2,
    });
  }
  if (method === 'float' || method === 'double') {
    return single('float', undefined);
  }
  const dateType: IrScalarType | undefined = DATE_METHODS[method];
  if (dateType !== undefined) {
    return single(dateType, undefined);
  }
  if (method === 'year') {
    return single('int', undefined);
  }
  if (TIMESTAMP_PAIR_METHODS.has(method)) {
    return {
      columns: [
        newColumn('created_at', 'dateTime', { isNullable: true }),
        newColumn('updated_at', 'dateTime', { isNullable: true }),
      ],
      change: false,
    };
  }
  if (SOFT_DELETE_METHODS.has(method)) {
    return single('dateTime', 'deleted_at', { isNullable: true });
  }
  if (method === 'rememberToken') {
    return {
      columns: [
        newColumn('remember_token', 'string', {
          isNullable: true,
          maxLength: 100,
          hasExplicitLength: true,
        }),
      ],
      change: false,
    };
  }
  if (method === 'uuid') {
    return single('uuid', 'uuid');
  }
  if (method === 'ulid') {
    const length: number | null | undefined = numberArgument(args, 1, 'length');
    return single('string', 'ulid', {
      maxLength: typeof length === 'number' ? length : 26,
      hasExplicitLength: true,
    });
  }
  if (method === 'json' || method === 'jsonb') {
    return single('json', undefined);
  }
  if (method === 'binary') {
    return single('bytes', undefined);
  }
  if (method === 'ipAddress') {
    return single('ipAddress', 'ip_address');
  }
  if (method === 'macAddress') {
    const target: ChainTarget | undefined = single('string', 'mac_address', {
      maxLength: 17,
      hasExplicitLength: true,
    });
    if (target !== undefined) {
      pushWarning(
        warnings,
        `${table.name}.${target.columns[0]?.name ?? 'mac_address'}: macAddress() has no equivalent and was converted to a string column of length 17.`
      );
    }
    return target;
  }
  if (method === 'enum' || method === 'set') {
    const values: string[] | null | undefined = stringListArgument(
      argumentAt(args, 1, 'allowed')
    );
    const name: string | null = columnName(undefined);
    if (name === null) {
      return skip('has a column name that is not a string literal');
    }
    if (values === null || values === undefined) {
      return skip('has allowed values that are not string literals');
    }
    if (method === 'set') {
      pushWarning(
        warnings,
        `${table.name}.${name}: set() columns have no equivalent and were kept as unsupported columns.`
      );
      return {
        columns: [
          newColumn(name, 'unsupported', {
            unsupportedType: `set(${values.map((value: string) => `'${value}'`).join(',')})`,
          }),
        ],
        change: false,
      };
    }
    return {
      columns: [newColumn(name, 'string', { enumValues: values })],
      change: false,
    };
  }
  if (GEOMETRY_TYPES.has(method) || method === 'vector') {
    const target: ChainTarget | undefined = single('unsupported', undefined, {
      unsupportedType: method.toLowerCase(),
    });
    if (target !== undefined) {
      pushWarning(
        warnings,
        `${table.name}.${target.columns[0]?.name ?? method}: the ${method}() column type has no equivalent and was kept as an unsupported column.`
      );
    }
    return target;
  }
  if (
    method === 'foreignId' ||
    method === 'foreignUuid' ||
    method === 'foreignUlid'
  ) {
    const type: IrScalarType =
      method === 'foreignId'
        ? 'bigInt'
        : method === 'foreignUuid'
          ? 'uuid'
          : 'string';
    const target: ChainTarget | undefined = single(
      type,
      undefined,
      method === 'foreignUlid' ? { maxLength: 26, hasExplicitLength: true } : {}
    );
    if (target !== undefined) {
      target.foreignIdColumn = target.columns[0];
    }
    return target;
  }
  if (method === 'foreignIdFor') {
    const model: ArgValue | undefined = args[0]
      ? evaluateArgument(args[0].node)
      : undefined;
    const modelName: string | undefined =
      model !== undefined && model.kind === 'classRef'
        ? model.name
        : model !== undefined && model.kind === 'string'
          ? model.value
          : undefined;
    if (modelName === undefined) {
      return skip('was not given a model class');
    }
    const explicit: string | null | undefined = stringArgument(
      args,
      1,
      'column'
    );
    const name: string =
      explicit ?? `${eloquentSnake(lastNameSegment(modelName))}_id`;
    const column: ColumnDef = newColumn(name, 'bigInt');
    return {
      columns: [column],
      foreignIdColumn: column,
      foreignIdModel: modelName,
      change: false,
    };
  }
  const morph = MORPH_METHODS[method];
  if (morph !== undefined) {
    const name: string | null = columnName(undefined);
    if (name === null) {
      return skip('has a name that is not a string literal');
    }
    const typeColumn: ColumnDef = newColumn(`${name}_type`, 'string', {
      maxLength: 255,
      hasExplicitLength: true,
      isNullable: morph.nullable,
    });
    const idColumn: ColumnDef =
      morph.id === 'int'
        ? newColumn(`${name}_id`, 'bigInt', { isNullable: morph.nullable })
        : morph.id === 'uuid'
          ? newColumn(`${name}_id`, 'uuid', { isNullable: morph.nullable })
          : newColumn(`${name}_id`, 'string', {
              maxLength: 26,
              hasExplicitLength: true,
              isNullable: morph.nullable,
            });
    const indexName: string | null | undefined = stringArgument(
      args,
      1,
      'indexName'
    );
    addIndex(table, {
      columns: [typeColumn.name, idColumn.name],
      isUnique: false,
      ...(typeof indexName === 'string' ? { name: indexName } : {}),
    });
    pushWarning(
      warnings,
      `${table.name}: ${method}('${name}') creates the columns ${typeColumn.name} and ${idColumn.name}; polymorphic relations are not represented, so they were kept as plain columns.`
    );
    return { columns: [typeColumn, idColumn], change: false };
  }

  // Indexes and keys -------------------------------------------------------
  if (
    method === 'index' ||
    method === 'unique' ||
    method === 'primary' ||
    method === 'fullText' ||
    method === 'spatialIndex'
  ) {
    const columns: string[] | null | undefined = stringListArgument(
      argumentAt(args, 0, 'columns')
    );
    if (columns === null || columns === undefined) {
      return skip('has columns that are not string literals');
    }
    if (method === 'spatialIndex') {
      pushWarning(
        warnings,
        `${table.name}: the spatial index on (${columns.join(', ')}) has no equivalent and was ignored.`
      );
      return undefined;
    }
    if (method === 'primary') {
      table.primaryKey = columns;
      return undefined;
    }
    const name: string | null | undefined = stringArgument(args, 1, 'name');
    addIndex(table, {
      columns,
      isUnique: method === 'unique',
      ...(method === 'fullText' ? { kind: 'fulltext' as const } : {}),
      ...(typeof name === 'string' ? { name } : {}),
    });
    return undefined;
  }
  if (method === 'foreign') {
    const columns: string[] | null | undefined = stringListArgument(
      argumentAt(args, 0, 'columns')
    );
    if (columns === null || columns === undefined) {
      return skip('has columns that are not string literals');
    }
    const name: string | null | undefined = stringArgument(args, 1, 'name');
    const foreignKey: ForeignKeyDef = {
      columns,
      refColumns: [],
      ...(typeof name === 'string' ? { name } : {}),
    };
    addForeignKey(table, foreignKey);
    return { columns: [], foreignKey, change: false };
  }

  // Changes to existing columns and keys ----------------------------------
  return runDropOrRename(table, first, mctx);
}

/** `dropColumn`, `renameColumn`, `dropIndex` and friends. */
function runDropOrRename(
  table: TableState,
  first: CallLink,
  mctx: MigrationContext
): undefined {
  const warnings: string[] = mctx.state.warnings;
  const method: string = first.name;
  const args: PhpArgumentNode[] = first.args;
  const missing = (what: string): void => {
    pushWarning(
      warnings,
      `${table.name}: ${method}() ${what}; the call was skipped.`
    );
  };

  switch (method) {
    case 'dropColumn':
    case 'dropColumns': {
      const names: string[] | null = allStringArguments(args);
      if (names === null) {
        missing('has column names that are not string literals');
        return undefined;
      }
      for (const name of names) {
        removeColumn(table, name);
      }
      return undefined;
    }
    case 'renameColumn': {
      const from: string | null | undefined = stringArgument(args, 0, 'from');
      const to: string | null | undefined = stringArgument(args, 1, 'to');
      if (typeof from !== 'string' || typeof to !== 'string') {
        missing('has names that are not string literals');
      } else if (!table.columns.has(from)) {
        if (!table.isPartial) {
          pushWarning(
            warnings,
            `${table.name}.${from}: renameColumn() refers to a column that does not exist at this point; the call was skipped.`
          );
        }
      } else {
        renameColumn(table, from, to);
      }
      return undefined;
    }
    case 'dropTimestamps':
    case 'dropTimestampsTz':
      removeColumn(table, 'created_at');
      removeColumn(table, 'updated_at');
      return undefined;
    case 'dropSoftDeletes':
    case 'dropSoftDeletesTz': {
      const name: string | null | undefined = stringArgument(args, 0, 'column');
      removeColumn(table, typeof name === 'string' ? name : 'deleted_at');
      return undefined;
    }
    case 'dropRememberToken':
      removeColumn(table, 'remember_token');
      return undefined;
    case 'dropMorphs': {
      const name: string | null | undefined = stringArgument(args, 0, 'name');
      if (typeof name !== 'string') {
        missing('has a name that is not a string literal');
      } else {
        removeColumn(table, `${name}_type`);
        removeColumn(table, `${name}_id`);
      }
      return undefined;
    }
    case 'dropConstrainedForeignId':
    case 'dropForeignIdFor':
    case 'dropConstrainedForeignIdFor': {
      const nameArg: ArgValue | undefined = args[0]
        ? evaluateArgument(args[0].node)
        : undefined;
      const column: string | undefined =
        nameArg === undefined
          ? undefined
          : nameArg.kind === 'string' && method === 'dropConstrainedForeignId'
            ? nameArg.value
            : nameArg.kind === 'classRef'
              ? `${eloquentSnake(lastNameSegment(nameArg.name))}_id`
              : undefined;
      if (column === undefined) {
        missing('was not given a column or model it can resolve');
      } else {
        removeColumn(table, column);
      }
      return undefined;
    }
    case 'dropPrimary':
      table.primaryKey = undefined;
      return undefined;
    case 'dropIndex':
    case 'dropUnique':
    case 'dropFullText':
    case 'dropSpatialIndex': {
      const target: string[] | null | undefined = stringListArgument(args[0]);
      if (target === null || target === undefined) {
        missing('has an index name or columns that are not string literals');
        return undefined;
      }
      const type: 'index' | 'unique' | 'fulltext' =
        method === 'dropUnique'
          ? 'unique'
          : method === 'dropFullText'
            ? 'fulltext'
            : 'index';
      const isColumnList: boolean =
        args[0] !== undefined &&
        evaluateArgument(args[0].node).kind === 'array';
      const wanted: string = isColumnList
        ? conventionalIndexName(table.name, target, type)
        : (target[0] ?? '');
      const before: number = table.indexes.length;
      table.indexes = table.indexes.filter((index: IndexDef): boolean => {
        const indexType: 'index' | 'unique' | 'fulltext' =
          index.kind === 'fulltext'
            ? 'fulltext'
            : index.isUnique
              ? 'unique'
              : 'index';
        const name: string =
          index.name ??
          conventionalIndexName(table.name, index.columns, indexType);
        return name !== wanted;
      });
      if (table.indexes.length === before && !table.isPartial) {
        pushWarning(
          warnings,
          `${table.name}: ${method}() could not find the index "${wanted}"; the call was skipped.`
        );
      }
      return undefined;
    }
    case 'dropForeign': {
      const target: string[] | null | undefined = stringListArgument(args[0]);
      if (target === null || target === undefined) {
        missing(
          'has a constraint name or columns that are not string literals'
        );
        return undefined;
      }
      const isColumnList: boolean =
        args[0] !== undefined &&
        evaluateArgument(args[0].node).kind === 'array';
      const before: number = table.foreignKeys.length;
      table.foreignKeys = table.foreignKeys.filter((key: ForeignKeyDef) =>
        isColumnList
          ? !sameList(key.columns, target)
          : (key.name ??
              conventionalIndexName(table.name, key.columns, 'foreign')) !==
            target[0]
      );
      if (table.foreignKeys.length === before && !table.isPartial) {
        pushWarning(
          warnings,
          `${table.name}: dropForeign() could not find the foreign key ${target.join(', ')}; the call was skipped.`
        );
      }
      return undefined;
    }
    case 'renameIndex': {
      const from: string | null | undefined = stringArgument(args, 0, 'from');
      const to: string | null | undefined = stringArgument(args, 1, 'to');
      if (typeof from !== 'string' || typeof to !== 'string') {
        missing('has names that are not string literals');
        return undefined;
      }
      const index: IndexDef | undefined = table.indexes.find(
        (candidate: IndexDef) =>
          (candidate.name ??
            conventionalIndexName(
              table.name,
              candidate.columns,
              candidate.kind === 'fulltext'
                ? 'fulltext'
                : candidate.isUnique
                  ? 'unique'
                  : 'index'
            )) === from
      );
      if (index !== undefined) {
        index.name = to;
      }
      return undefined;
    }
    default:
      if (IGNORED_TABLE_METHODS.has(method)) {
        return undefined;
      }
      pushWarning(
        warnings,
        `${table.name}: the Blueprint call ${method}() is not understood and was ignored.`
      );
      return undefined;
  }
}

/** Applies the calls chained after a column definition (`->nullable()->default(0)->unique()`). */
function applyModifiers(
  table: TableState,
  target: ChainTarget,
  links: CallLink[],
  mctx: MigrationContext
): void {
  const warnings: string[] = mctx.state.warnings;
  for (const link of links) {
    const name: string = link.name;
    const label: string =
      target.columns.length === 1 && target.columns[0] !== undefined
        ? `${table.name}.${target.columns[0].name}`
        : table.name;
    const setAction = (
      field: 'onDelete' | 'onUpdate',
      action: IrOnDelete
    ): void => {
      if (target.foreignKey === undefined) {
        pushWarning(
          warnings,
          `${label}: ${name}() was used without a foreign key definition and was ignored.`
        );
      } else {
        target.foreignKey[field] = action;
      }
    };
    switch (name) {
      case 'nullable': {
        const flag: boolean | null | undefined = booleanArgument(
          link.args,
          0,
          'value'
        );
        for (const column of target.columns) {
          column.isNullable = flag !== false;
        }
        break;
      }
      case 'default': {
        const argument: PhpArgumentNode | undefined = argumentAt(
          link.args,
          0,
          'value'
        );
        for (const column of target.columns) {
          if (argument === undefined) {
            continue;
          }
          const converted: IrDefault | undefined = convertDefault(
            evaluateArgument(argument.node),
            column,
            table.name,
            warnings
          );
          if (converted === undefined) {
            delete column.default;
          } else {
            column.default = converted;
          }
        }
        break;
      }
      case 'useCurrent':
        for (const column of target.columns) {
          column.default = { kind: 'now' };
        }
        break;
      case 'useCurrentOnUpdate':
        for (const column of target.columns) {
          column.isAutoUpdated = true;
        }
        break;
      case 'autoIncrement':
        for (const column of target.columns) {
          column.isAutoIncrement = true;
          column.default = { kind: 'autoIncrement' };
        }
        break;
      case 'unique':
      case 'index':
      case 'fullText':
      case 'primary':
      case 'spatialIndex': {
        const indexName: string | null | undefined = stringArgument(
          link.args,
          0,
          'indexName'
        );
        for (const column of target.columns) {
          if (name === 'primary') {
            table.primaryKey = [column.name];
          } else if (name === 'spatialIndex') {
            pushWarning(
              warnings,
              `${table.name}.${column.name}: the spatial index has no equivalent and was ignored.`
            );
          } else {
            addIndex(table, {
              columns: [column.name],
              isUnique: name === 'unique',
              ...(name === 'fullText' ? { kind: 'fulltext' as const } : {}),
              ...(typeof indexName === 'string' ? { name: indexName } : {}),
            });
          }
        }
        break;
      }
      case 'storedAs':
      case 'virtualAs': {
        const expression: ArgValue | undefined = link.args[0]
          ? evaluateArgument(link.args[0].node)
          : undefined;
        const text: string | undefined =
          expression === undefined
            ? undefined
            : expression.kind === 'string'
              ? expression.value
              : expression.kind === 'raw'
                ? expression.sql
                : undefined;
        for (const column of target.columns) {
          if (text === undefined) {
            pushWarning(
              warnings,
              `${table.name}.${column.name}: the expression of ${name}() is not a string literal and was ignored.`
            );
          } else {
            column.generated = {
              expression: text,
              isStored: name === 'storedAs',
            };
          }
        }
        break;
      }
      case 'generatedAs':
      case 'always':
        pushWarning(
          warnings,
          `${label}: identity columns (${name}()) have no equivalent and were ignored.`
        );
        break;
      case 'change':
        target.change = true;
        break;
      case 'constrained': {
        const column: ColumnDef | undefined = target.foreignIdColumn;
        if (column === undefined) {
          pushWarning(
            warnings,
            `${label}: constrained() can only follow foreignId(), foreignUuid(), foreignUlid() or foreignIdFor(); it was ignored.`
          );
          break;
        }
        const tableArgument: string | null | undefined = stringArgument(
          link.args,
          0,
          'table'
        );
        const columnArgument: string | null | undefined = stringArgument(
          link.args,
          1,
          'column'
        );
        const indexName: string | null | undefined = stringArgument(
          link.args,
          2,
          'indexName'
        );
        const foreignKey: ForeignKeyDef = {
          columns: [column.name],
          refColumns: [
            typeof columnArgument === 'string' ? columnArgument : 'id',
          ],
          ...(typeof tableArgument === 'string'
            ? { refTable: tableArgument }
            : target.foreignIdModel !== undefined
              ? { refModel: target.foreignIdModel }
              : { refTable: pluralizeSnake(column.name.replace(/_id$/, '')) }),
          ...(typeof indexName === 'string' ? { name: indexName } : {}),
        };
        target.foreignKey = foreignKey;
        addForeignKey(table, foreignKey);
        break;
      }
      case 'references': {
        const columns: string[] | null | undefined = stringListArgument(
          argumentAt(link.args, 0, 'columns')
        );
        const own: string[] = target.columns.map(
          (column: ColumnDef) => column.name
        );
        if (target.foreignKey === undefined) {
          if (own.length === 0) {
            pushWarning(
              warnings,
              `${label}: references() was used without a foreign key definition and was ignored.`
            );
            break;
          }
          target.foreignKey = { columns: own, refColumns: [] };
          addForeignKey(table, target.foreignKey);
        }
        if (columns === null || columns === undefined) {
          pushWarning(
            warnings,
            `${label}: references() was given columns that are not string literals; 'id' was assumed.`
          );
          target.foreignKey.refColumns = ['id'];
        } else {
          target.foreignKey.refColumns = columns;
        }
        break;
      }
      case 'on': {
        const referenced: string | null | undefined = stringArgument(
          link.args,
          0,
          'table'
        );
        if (target.foreignKey === undefined || typeof referenced !== 'string') {
          pushWarning(
            warnings,
            `${label}: on() ${target.foreignKey === undefined ? 'was used without a foreign key definition' : 'was given a table that is not a string literal'} and was ignored.`
          );
        } else {
          target.foreignKey.refTable = referenced;
        }
        break;
      }
      case 'onDelete':
      case 'onUpdate': {
        const text: string | null | undefined = stringArgument(
          link.args,
          0,
          'action'
        );
        const action: IrOnDelete | undefined =
          typeof text === 'string' ? actionFromText(text) : undefined;
        if (action === undefined) {
          pushWarning(
            warnings,
            `${label}: ${name}(${text === undefined || text === null ? '...' : `'${text}'`}) is not a supported referential action and was ignored.`
          );
        } else {
          setAction(name, action);
        }
        break;
      }
      case 'cascadeOnDelete':
        setAction('onDelete', 'cascade');
        break;
      case 'restrictOnDelete':
        setAction('onDelete', 'restrict');
        break;
      case 'nullOnDelete':
        setAction('onDelete', 'setNull');
        break;
      case 'noActionOnDelete':
        setAction('onDelete', 'noAction');
        break;
      case 'cascadeOnUpdate':
        setAction('onUpdate', 'cascade');
        break;
      case 'restrictOnUpdate':
        setAction('onUpdate', 'restrict');
        break;
      case 'nullOnUpdate':
        setAction('onUpdate', 'setNull');
        break;
      case 'noActionOnUpdate':
        setAction('onUpdate', 'noAction');
        break;
      default:
        if (!IGNORED_COLUMN_MODIFIERS.has(name)) {
          pushWarning(
            warnings,
            `${label}: the column modifier ${name}() is not understood and was ignored.`
          );
        }
        break;
    }
  }
}

function commitColumns(
  table: TableState,
  target: ChainTarget,
  mctx: MigrationContext
): void {
  for (const column of target.columns) {
    const existing: ColumnDef | undefined = table.columns.get(column.name);
    if (target.change) {
      if (existing === undefined && !table.isPartial) {
        pushWarning(
          mctx.state.warnings,
          `${table.name}.${column.name}: change() modifies a column that does not exist at this point; it was added instead.`
        );
      }
    } else if (existing !== undefined && !table.isPartial) {
      pushWarning(
        mctx.state.warnings,
        `${table.name}.${column.name}: the column is defined more than once; the later definition replaced the earlier one.`
      );
    }
    table.columns.set(column.name, column);
  }
}

function runTableCall(
  table: TableState,
  links: CallLink[],
  mctx: MigrationContext
): void {
  const first: CallLink | undefined = links[0];
  if (first === undefined) {
    return;
  }
  mctx.touched.push(table.name);
  const target: ChainTarget | undefined = startCall(table, first, mctx);
  if (target === undefined) {
    return;
  }
  applyModifiers(table, target, links.slice(1), mctx);
  commitColumns(table, target, mctx);
}

// -- Statement walking --------------------------------------------------------

function nestedStatements(node: SyntaxNode): SyntaxNode[] {
  const found: SyntaxNode[] = [];
  for (const child of node.namedChildren) {
    if (CLAUSE_STATEMENTS.has(child.type)) {
      found.push(...nestedStatements(child));
    } else if (
      child.type === 'compound_statement' ||
      child.type.endsWith('_statement')
    ) {
      found.push(child);
    }
  }
  return found;
}

function controlLabel(node: SyntaxNode): string {
  switch (node.type) {
    case 'if_statement':
      return 'a conditional';
    case 'switch_statement':
      return 'a switch';
    case 'try_statement':
      return 'a try block';
    default:
      return 'a loop';
  }
}

function forEachStatement(
  nodes: SyntaxNode[],
  handle: (statement: SyntaxNode) => void,
  onControl: (statement: SyntaxNode, descend: () => void) => void
): void {
  for (const node of nodes) {
    if (node.type === 'comment') {
      continue;
    }
    if (node.type === 'compound_statement') {
      forEachStatement(node.namedChildren, handle, onControl);
    } else if (CONTROL_STATEMENTS.has(node.type)) {
      onControl(node, (): void =>
        forEachStatement(nestedStatements(node), handle, onControl)
      );
    } else {
      handle(node);
    }
  }
}

/** The expression of an expression statement (or the node itself for an arrow function body). */
function statementExpression(statement: SyntaxNode): SyntaxNode | undefined {
  if (statement.type === 'expression_statement') {
    return statement.namedChildren.find(
      (child: SyntaxNode) => child.type !== 'comment'
    );
  }
  return statement.type.endsWith('_expression') ? statement : undefined;
}

function warnRawSql(
  chain: CallChain,
  mctx: MigrationContext,
  statementText: string
): void {
  const first: CallLink | undefined = chain.links[0];
  if (first === undefined || !RAW_SQL_METHODS.has(first.name)) {
    return;
  }
  const sqlArgument: ArgValue | undefined = first.args[0]
    ? evaluateArgument(first.args[0].node)
    : undefined;
  const sql: string | undefined =
    sqlArgument !== undefined && sqlArgument.kind === 'string'
      ? sqlArgument.value
      : undefined;
  const tableMatch: RegExpExecArray | null =
    sql === undefined
      ? null
      : /\b(?:alter\s+table|create\s+table(?:\s+if\s+not\s+exists)?|drop\s+table(?:\s+if\s+exists)?|truncate(?:\s+table)?|rename\s+table|create\s+(?:unique\s+)?index\s+\S+\s+on|drop\s+index\s+\S+\s+on|comment\s+on\s+(?:table|column))\s+[`"']?([A-Za-z0-9_.]+)/i.exec(
          sql
        );
  const tableName: string | undefined = tableMatch?.[1];
  pushWarning(
    mctx.state.warnings,
    `${mctx.file}: the raw SQL statement "${shorten(sql ?? statementText)}"${tableName === undefined ? '' : ` on the table "${tableName}"`} is not interpreted; the rebuilt schema may differ from the real database.`
  );
  if (tableName !== undefined) {
    mctx.touched.push(tableName);
  }
}

function runBlueprint(
  argument: PhpArgumentNode | undefined,
  table: TableState,
  mctx: MigrationContext
): void {
  if (argument === undefined) {
    pushWarning(
      mctx.state.warnings,
      `${table.name}: no Blueprint callback was found; the table has no columns.`
    );
    return;
  }
  const closure: SyntaxNode = argument.node;
  if (
    closure.type !== 'anonymous_function_creation_expression' &&
    closure.type !== 'anonymous_function' &&
    closure.type !== 'arrow_function'
  ) {
    pushWarning(
      mctx.state.warnings,
      `${table.name}: the Blueprint callback is not an inline closure, so its columns could not be read.`
    );
    return;
  }
  const parameter: SyntaxNode | undefined = closure
    .childForFieldName('parameters')
    ?.namedChildren.find(
      (child: SyntaxNode) => child.type === 'simple_parameter'
    );
  const variable: string =
    parameter?.childForFieldName('name')?.text ?? '$table';
  const body: SyntaxNode | null = closure.childForFieldName('body');
  if (body === null) {
    return;
  }
  const statements: SyntaxNode[] =
    body.type === 'compound_statement' ? body.namedChildren : [body];
  forEachStatement(
    statements,
    (statement: SyntaxNode): void => {
      const expression: SyntaxNode | undefined = statementExpression(statement);
      if (expression === undefined) {
        return;
      }
      const chain: CallChain | undefined = readChain(expression);
      if (chain === undefined) {
        return;
      }
      if (!chain.isStatic && chain.root.text === variable) {
        runTableCall(table, chain.links, mctx);
      } else if (isFacade(chain, 'DB')) {
        warnRawSql(chain, mctx, statement.text);
      }
    },
    (statement: SyntaxNode, descend: () => void): void =>
      describeControlFlow(statement, descend, mctx)
  );
}

function describeControlFlow(
  statement: SyntaxNode,
  descend: () => void,
  mctx: MigrationContext
): void {
  const before: number = mctx.touched.length;
  descend();
  const tables: string[] = unique(mctx.touched.slice(before));
  pushWarning(
    mctx.state.warnings,
    `${mctx.file}: ${controlLabel(statement)} contains schema changes; it was applied as if it always ran` +
      (tables.length > 0
        ? ` (tables: ${tables.join(', ')}), so the result may differ from the real database.`
        : ', so the result may differ from the real database.')
  );
}

function runSchemaCall(chain: CallChain, mctx: MigrationContext): void {
  const state: ReplayState = mctx.state;
  const links: CallLink[] =
    chain.links[0]?.name === 'connection' ? chain.links.slice(1) : chain.links;
  const call: CallLink | undefined = links[0];
  if (call === undefined) {
    return;
  }
  const method: string = call.name;
  const tableNameOf = (): string | undefined => {
    const name: string | null | undefined = stringArgument(
      call.args,
      0,
      'table'
    );
    if (typeof name !== 'string') {
      pushWarning(
        state.warnings,
        `${mctx.file}: Schema::${method}() was given a table name that is not a string literal; the call was skipped.`
      );
      return undefined;
    }
    return name;
  };

  switch (method) {
    case 'create':
    case 'table': {
      const name: string | undefined = tableNameOf();
      if (name === undefined) {
        return;
      }
      let table: TableState | undefined = state.tables.get(name);
      if (method === 'create') {
        if (table !== undefined && !table.isPartial) {
          pushWarning(
            state.warnings,
            `${name}: Schema::create() ran for a table that already exists (in ${mctx.file}); the earlier definition was replaced.`
          );
        }
        state.tables.delete(name);
        table = emptyTable(name, false);
        state.tables.set(name, table);
      } else if (table === undefined) {
        table = emptyTable(name, true);
        state.tables.set(name, table);
      }
      mctx.touched.push(name);
      runBlueprint(argumentAt(call.args, 1, 'callback'), table, mctx);
      return;
    }
    case 'drop':
    case 'dropIfExists': {
      const name: string | undefined = tableNameOf();
      if (name !== undefined) {
        mctx.touched.push(name);
        state.tables.delete(name);
      }
      return;
    }
    case 'rename': {
      const from: string | null | undefined = stringArgument(
        call.args,
        0,
        'from'
      );
      const to: string | null | undefined = stringArgument(call.args, 1, 'to');
      if (typeof from !== 'string' || typeof to !== 'string') {
        pushWarning(
          state.warnings,
          `${mctx.file}: Schema::rename() was given table names that are not string literals; the call was skipped.`
        );
        return;
      }
      const table: TableState | undefined = state.tables.get(from);
      mctx.touched.push(from, to);
      if (table === undefined) {
        return;
      }
      const rebuilt: Map<string, TableState> = new Map<string, TableState>();
      for (const [name, existing] of state.tables) {
        if (name === from) {
          rebuilt.set(to, { ...existing, name: to });
        } else {
          rebuilt.set(name, existing);
        }
      }
      state.tables = rebuilt;
      for (const other of state.tables.values()) {
        for (const key of other.foreignKeys) {
          if (key.refTable === from) {
            key.refTable = to;
          }
        }
      }
      return;
    }
    case 'dropColumns': {
      const name: string | undefined = tableNameOf();
      const columns: string[] | null | undefined = stringListArgument(
        argumentAt(call.args, 1, 'columns')
      );
      const table: TableState | undefined =
        name === undefined ? undefined : state.tables.get(name);
      if (columns === null || columns === undefined) {
        pushWarning(
          state.warnings,
          `${mctx.file}: Schema::dropColumns() was given columns that are not string literals; the call was skipped.`
        );
      } else if (table !== undefined) {
        mctx.touched.push(table.name);
        for (const column of columns) {
          removeColumn(table, column);
        }
      }
      return;
    }
    default:
      if (
        !IGNORED_SCHEMA_METHODS.has(method) &&
        !method.startsWith('has') &&
        !method.startsWith('get')
      ) {
        pushWarning(
          state.warnings,
          `${mctx.file}: Schema::${method}() is not interpreted and was ignored.`
        );
      }
      return;
  }
}

function replayMigration(migration: MigrationClass, state: ReplayState): void {
  const mctx: MigrationContext = {
    state,
    file: migration.file,
    touched: [],
  };
  const statements: SyntaxNode[] = migration.up.namedChildren;
  forEachStatement(
    statements,
    (statement: SyntaxNode): void => {
      const expression: SyntaxNode | undefined = statementExpression(statement);
      if (expression === undefined) {
        return;
      }
      const chain: CallChain | undefined = readChain(expression);
      if (chain === undefined) {
        return;
      }
      if (isFacade(chain, 'Schema')) {
        runSchemaCall(chain, mctx);
      } else if (isFacade(chain, 'DB')) {
        warnRawSql(chain, mctx, statement.text);
      }
    },
    (statement: SyntaxNode, descend: () => void): void =>
      describeControlFlow(statement, descend, mctx)
  );
}

// ---------------------------------------------------------------------------
// Class discovery: migrations, models, enums
// ---------------------------------------------------------------------------

interface Discovered {
  migrations: { key: string; migration: MigrationClass }[];
  models: ModelClass[];
  enums: Map<string, EnumInfo>;
}

function declarationBody(node: SyntaxNode): SyntaxNode | undefined {
  const body: SyntaxNode | null = node.childForFieldName('body');
  if (body !== null) {
    return body;
  }
  return node.namedChildren.find(
    (child: SyntaxNode) => child.type === 'declaration_list'
  );
}

function methodName(method: SyntaxNode): string {
  return method.childForFieldName('name')?.text ?? '';
}

/** A class is a migration when its `up()` method calls `Schema::`. */
function readMigration(
  node: SyntaxNode,
  ctx: FileContext
): MigrationClass | undefined {
  const body: SyntaxNode | undefined = declarationBody(node);
  if (body === undefined) {
    return undefined;
  }
  const up: SyntaxNode | undefined = body.namedChildren.find(
    (member: SyntaxNode) =>
      member.type === 'method_declaration' && methodName(member) === 'up'
  );
  const upBody: SyntaxNode | null = up?.childForFieldName('body') ?? null;
  if (upBody === null || !/\bSchema\s*::/.test(upBody.text)) {
    return undefined;
  }
  return { file: basename(ctx.path), ctx, up: upBody };
}

function propertyValue(element: SyntaxNode): SyntaxNode | undefined {
  const initializer: SyntaxNode | undefined = element.namedChildren.find(
    (child: SyntaxNode) => child.type === 'property_initializer'
  );
  return initializer?.namedChildren[0];
}

function castsFromArray(node: SyntaxNode | undefined): Map<string, PhpValue> {
  const casts: Map<string, PhpValue> = new Map<string, PhpValue>();
  if (node === undefined) {
    return casts;
  }
  const value: PhpValue = evaluateNode(node);
  if (value.kind !== 'array') {
    return casts;
  }
  for (const item of value.items) {
    if (item.key !== undefined && item.key.kind === 'string') {
      casts.set(item.key.value, item.value);
    }
  }
  return casts;
}

function relationFromMethod(
  method: SyntaxNode,
  owner: ModelClass,
  warnings: string[]
): RelationMethod | undefined {
  const name: string = methodName(method);
  const body: SyntaxNode | null = method.childForFieldName('body');
  const returnType: SyntaxNode | undefined = method.namedChildren.find(
    (child: SyntaxNode) =>
      child.type === 'named_type' ||
      child.type === 'optional_type' ||
      child.type === 'union_type'
  );
  const declaresRelation: boolean =
    returnType !== undefined &&
    RELATION_RETURN_TYPES.has(
      lastNameSegment(returnType.text.replace(/^\?/, ''))
    );
  if (body === null) {
    return undefined;
  }
  const returned: SyntaxNode | undefined = body.namedChildren.find(
    (child: SyntaxNode) => child.type === 'return_statement'
  );
  const expression: SyntaxNode | undefined = returned?.namedChildren[0];
  const chain: CallChain | undefined =
    expression === undefined ? undefined : readChain(expression);
  const first: CallLink | undefined = chain?.links[0];
  if (
    chain === undefined ||
    first === undefined ||
    chain.isStatic ||
    chain.root.text !== '$this' ||
    !RELATION_METHODS.has(first.name)
  ) {
    if (declaresRelation) {
      warnings.push(
        `${owner.name}::${name}(): the relationship method could not be analysed (it does not simply return a $this->hasMany()-style call); the relation was skipped.`
      );
    }
    return undefined;
  }

  const extraModifiers: string[] = chain.links
    .slice(1)
    .map((link: CallLink) => link.name)
    .filter((modifier: string) => !HARMLESS_RELATION_MODIFIERS.has(modifier));
  const call: string = first.name;
  const optionalString = (
    index: number,
    parameter: string
  ): string | undefined => {
    const text: string | null | undefined = stringArgument(
      first.args,
      index,
      parameter
    );
    if (text === null) {
      warnings.push(
        `${owner.name}::${name}(): the ${parameter} argument of ${call}() is not a string literal and was ignored.`
      );
      return undefined;
    }
    return text;
  };
  const relatedArgument: PhpArgumentNode | undefined = argumentAt(
    first.args,
    0,
    'related'
  );
  const relatedFqn: string | undefined =
    relatedArgument === undefined
      ? undefined
      : classReference(
          evaluateArgument(relatedArgument.node),
          owner.ctx,
          owner.fqn
        );

  const base: RelationMethod = {
    name,
    call,
    kind: 'morph',
    ...(relatedFqn === undefined ? {} : { relatedFqn }),
    extraModifiers,
  };
  switch (call) {
    case 'hasOne':
    case 'hasMany': {
      const foreignKey: string | undefined = optionalString(1, 'foreignKey');
      const otherKey: string | undefined = optionalString(2, 'localKey');
      return {
        ...base,
        kind: call,
        ...(foreignKey === undefined ? {} : { foreignKey }),
        ...(otherKey === undefined ? {} : { otherKey }),
      };
    }
    case 'belongsTo': {
      const foreignKey: string | undefined = optionalString(1, 'foreignKey');
      const otherKey: string | undefined = optionalString(2, 'ownerKey');
      return {
        ...base,
        kind: 'belongsTo',
        ...(foreignKey === undefined ? {} : { foreignKey }),
        ...(otherKey === undefined ? {} : { otherKey }),
      };
    }
    case 'belongsToMany': {
      const tableArgument: PhpArgumentNode | undefined = argumentAt(
        first.args,
        1,
        'table'
      );
      let pivotTable: string | undefined;
      let pivotModelFqn: string | undefined;
      if (tableArgument !== undefined) {
        const value: ArgValue = evaluateArgument(tableArgument.node);
        if (value.kind === 'classRef') {
          pivotModelFqn = classReference(value, owner.ctx, owner.fqn);
        } else if (value.kind === 'string') {
          pivotTable = value.value;
        } else {
          warnings.push(
            `${owner.name}::${name}(): the table argument of belongsToMany() is not a string literal and was ignored.`
          );
        }
      }
      const foreignKey: string | undefined = optionalString(
        2,
        'foreignPivotKey'
      );
      const relatedPivotKey: string | undefined = optionalString(
        3,
        'relatedPivotKey'
      );
      const parentKey: string | undefined = optionalString(4, 'parentKey');
      const relatedKey: string | undefined = optionalString(5, 'relatedKey');
      return {
        ...base,
        kind: 'belongsToMany',
        ...(pivotTable === undefined ? {} : { pivotTable }),
        ...(pivotModelFqn === undefined ? {} : { pivotModelFqn }),
        ...(foreignKey === undefined ? {} : { foreignKey }),
        ...(relatedPivotKey === undefined ? {} : { relatedPivotKey }),
        ...(parentKey === undefined ? {} : { parentKey }),
        ...(relatedKey === undefined ? {} : { relatedKey }),
      };
    }
    case 'hasOneThrough':
    case 'hasManyThrough':
    case 'hasOneOfMany':
    case 'latestOfMany':
    case 'oldestOfMany':
      return { ...base, kind: 'through' };
    default:
      return base;
  }
}

function readModelClass(
  node: SyntaxNode,
  ctx: FileContext,
  warnings: string[]
): ModelClass | undefined {
  const nameNode: SyntaxNode | null = node.childForFieldName('name');
  const body: SyntaxNode | undefined = declarationBody(node);
  if (nameNode === null || body === undefined) {
    return undefined;
  }
  const fqn: string =
    ctx.namespace === '' ? nameNode.text : `${ctx.namespace}\\${nameNode.text}`;
  const model: ModelClass = {
    name: nameNode.text,
    fqn,
    ctx,
    isAbstract: node.namedChildren.some(
      (child: SyntaxNode) => child.type === 'abstract_modifier'
    ),
    casts: new Map<string, PhpValue>(),
    traits: [],
    relations: [],
  };
  const baseClause: SyntaxNode | undefined = node.namedChildren.find(
    (child: SyntaxNode) => child.type === 'base_clause'
  );
  const baseName: SyntaxNode | undefined = baseClause?.namedChildren[0];
  if (baseName !== undefined) {
    model.parentFqn = resolveClassName(baseName.text.replace(/\s+/g, ''), ctx);
  }

  for (const member of body.namedChildren) {
    if (member.type === 'use_declaration') {
      for (const used of member.namedChildren) {
        if (used.type === 'name' || used.type === 'qualified_name') {
          model.traits.push(
            resolveClassName(used.text.replace(/\s+/g, ''), ctx)
          );
        }
      }
    } else if (member.type === 'const_declaration') {
      for (const element of member.namedChildren) {
        if (element.type !== 'const_element') {
          continue;
        }
        const constName: string | undefined = element.namedChildren[0]?.text;
        const valueNode: SyntaxNode | undefined = element.namedChildren[1];
        if (valueNode === undefined) {
          continue;
        }
        const value: PhpValue = evaluateNode(valueNode);
        const text: string | null | undefined =
          value.kind === 'string'
            ? value.value
            : value.kind === 'null'
              ? null
              : undefined;
        if (text === undefined) {
          continue;
        }
        if (constName === 'CREATED_AT') {
          model.createdAt = text;
        } else if (constName === 'UPDATED_AT') {
          model.updatedAt = text;
        } else if (constName === 'DELETED_AT' && text !== null) {
          model.deletedAt = text;
        }
      }
    } else if (member.type === 'property_declaration') {
      readModelProperty(member, model, warnings);
    } else if (member.type === 'method_declaration') {
      const memberName: string = methodName(member);
      const isStatic: boolean = member.namedChildren.some(
        (child: SyntaxNode) => child.type === 'static_modifier'
      );
      const visibility: string | undefined = member.namedChildren.find(
        (child: SyntaxNode) => child.type === 'visibility_modifier'
      )?.text;
      if (memberName === 'casts') {
        const returned: SyntaxNode | undefined = member
          .childForFieldName('body')
          ?.namedChildren.find(
            (child: SyntaxNode) => child.type === 'return_statement'
          );
        for (const [key, value] of castsFromArray(returned?.namedChildren[0])) {
          model.casts.set(key, value);
        }
      } else if (memberName === 'uniqueIds') {
        const returned: SyntaxNode | undefined = member
          .childForFieldName('body')
          ?.namedChildren.find(
            (child: SyntaxNode) => child.type === 'return_statement'
          );
        const list: PhpValue | undefined =
          returned?.namedChildren[0] === undefined
            ? undefined
            : evaluateNode(returned.namedChildren[0]);
        if (list !== undefined && list.kind === 'array') {
          model.uniqueIds = list.items.flatMap((item): string[] =>
            item.value.kind === 'string' ? [item.value.value] : []
          );
        }
      } else if (
        !isStatic &&
        (visibility === undefined || visibility === 'public')
      ) {
        const relation: RelationMethod | undefined = relationFromMethod(
          member,
          model,
          warnings
        );
        if (relation !== undefined) {
          model.relations.push(relation);
        }
      }
    }
  }
  return model;
}

function readModelProperty(
  declaration: SyntaxNode,
  model: ModelClass,
  warnings: string[]
): void {
  if (
    declaration.namedChildren.some(
      (child: SyntaxNode) => child.type === 'static_modifier'
    )
  ) {
    return;
  }
  for (const element of declaration.namedChildren) {
    if (element.type !== 'property_element') {
      continue;
    }
    const name: string | undefined = element.namedChildren[0]?.text.replace(
      /^\$/,
      ''
    );
    const valueNode: SyntaxNode | undefined = propertyValue(element);
    if (name === undefined || valueNode === undefined) {
      continue;
    }
    if (name === 'casts') {
      for (const [key, value] of castsFromArray(valueNode)) {
        model.casts.set(key, value);
      }
      continue;
    }
    const value: PhpValue = evaluateNode(valueNode);
    switch (name) {
      case 'table':
      case 'primaryKey':
      case 'keyType':
        if (value.kind === 'string') {
          if (name === 'table') {
            model.table = value.value;
          } else if (name === 'primaryKey') {
            model.primaryKey = value.value;
          } else {
            model.keyType = value.value;
          }
        } else {
          warnings.push(
            `${model.name}: $${name} is not a string literal and was ignored.`
          );
        }
        break;
      case 'incrementing':
      case 'timestamps':
        if (value.kind === 'bool') {
          if (name === 'timestamps') {
            model.timestamps = value.value;
          } else {
            model.incrementing = value.value;
          }
        }
        break;
      default:
        break;
    }
  }
}

function discover(
  sources: LaravelSourceFile[],
  parser: Parser,
  warnings: string[]
): Discovered {
  const found: Discovered = { migrations: [], models: [], enums: new Map() };
  const classNodes: { node: SyntaxNode; ctx: FileContext }[] = [];
  for (const source of sources) {
    const tree: Parser.Tree = parser.parse(source.text);
    if (tree.rootNode.hasError) {
      warnings.push(
        `${source.path}: the file contains PHP syntax errors; some migrations, models or columns may be missing from the output.`
      );
    }
    for (const { ctx, node } of collectDeclarations(
      tree.rootNode,
      source.path,
      true
    )) {
      if (node.type === 'enum_declaration') {
        const info: EnumInfo | undefined = readEnumDeclaration(
          node,
          ctx,
          warnings
        );
        if (info !== undefined && !found.enums.has(info.fqn)) {
          found.enums.set(info.fqn, info);
        }
        continue;
      }
      const migration: MigrationClass | undefined = readMigration(node, ctx);
      if (migration !== undefined) {
        found.migrations.push({
          key: basename(source.path).replace(/\.php$/i, ''),
          migration,
        });
      } else if (node.type === 'class_declaration') {
        classNodes.push({ node, ctx });
      }
    }
  }

  // A class is a model when it extends an Eloquent base class, directly or through another model.
  const candidates: ModelClass[] = [];
  for (const { node, ctx } of classNodes) {
    const model: ModelClass | undefined = readModelClass(node, ctx, warnings);
    if (model !== undefined && model.parentFqn !== undefined) {
      candidates.push(model);
    }
  }
  const projectClasses: Set<string> = new Set(
    candidates.map((model: ModelClass) => model.fqn)
  );
  const isBase = (model: ModelClass): boolean => {
    const parent: string | undefined = model.parentFqn;
    if (parent === undefined) {
      return false;
    }
    if (MODEL_BASE_CLASSES.has(parent)) {
      return true;
    }
    // A short name that did not resolve to a class of the project (the import is missing, or the file is read on its own).
    return (
      MODEL_BASE_SHORT_NAMES.has(lastNameSegment(parent)) &&
      !projectClasses.has(parent)
    );
  };
  const accepted: Map<string, ModelClass> = new Map<string, ModelClass>();
  let changed: boolean = true;
  while (changed) {
    changed = false;
    for (const model of candidates) {
      if (accepted.has(model.fqn)) {
        continue;
      }
      if (
        isBase(model) ||
        (model.parentFqn !== undefined && accepted.has(model.parentFqn))
      ) {
        accepted.set(model.fqn, model);
        changed = true;
      }
    }
  }
  found.models = candidates.filter((model: ModelClass) =>
    accepted.has(model.fqn)
  );
  return found;
}

// ---------------------------------------------------------------------------
// Models resolved through their parents
// ---------------------------------------------------------------------------

function resolveModel(
  model: ModelClass,
  all: Map<string, ModelClass>
): EffectiveModel {
  const chain: ModelClass[] = [];
  const seen: Set<string> = new Set<string>();
  let current: ModelClass | undefined = model;
  while (current !== undefined && !seen.has(current.fqn)) {
    chain.push(current);
    seen.add(current.fqn);
    current =
      current.parentFqn === undefined ? undefined : all.get(current.parentFqn);
  }
  const firstDefined = <T>(
    read: (cls: ModelClass) => T | undefined
  ): T | undefined => {
    for (const cls of chain) {
      const value: T | undefined = read(cls);
      if (value !== undefined) {
        return value;
      }
    }
    return undefined;
  };
  const casts: Map<string, PhpValue> = new Map<string, PhpValue>();
  for (const cls of [...chain].reverse()) {
    for (const [key, value] of cls.casts) {
      casts.set(key, value);
    }
  }
  const traits: string[] = chain.flatMap((cls: ModelClass) => cls.traits);
  const hasTrait = (...names: string[]): boolean =>
    traits.some((trait: string) => names.includes(lastNameSegment(trait)));
  const timestamps: boolean | undefined = firstDefined(
    (cls: ModelClass) => cls.timestamps
  );
  const createdAt: string | null | undefined = firstDefined(
    (cls: ModelClass) => cls.createdAt
  );
  const updatedAt: string | null | undefined = firstDefined(
    (cls: ModelClass) => cls.updatedAt
  );
  const primaryKey: string | undefined = firstDefined(
    (cls: ModelClass) => cls.primaryKey
  );
  const keyType: string | undefined = firstDefined(
    (cls: ModelClass) => cls.keyType
  );
  const incrementing: boolean | undefined = firstDefined(
    (cls: ModelClass) => cls.incrementing
  );
  const uniqueIds: string[] | undefined = firstDefined(
    (cls: ModelClass) => cls.uniqueIds
  );
  return {
    source: model,
    table: model.table ?? conventionalTableName(model.name),
    ...(primaryKey === undefined ? {} : { primaryKey }),
    ...(keyType === undefined ? {} : { keyType }),
    ...(incrementing === undefined ? {} : { incrementing }),
    timestamps: timestamps ?? true,
    createdAt: createdAt === undefined ? 'created_at' : createdAt,
    updatedAt: updatedAt === undefined ? 'updated_at' : updatedAt,
    deletedAt: firstDefined((cls: ModelClass) => cls.deletedAt) ?? 'deleted_at',
    ...(uniqueIds === undefined ? {} : { uniqueIds }),
    casts,
    usesSoftDeletes: hasTrait('SoftDeletes'),
    usesUuids: hasTrait('HasUuids', 'HasVersion4Uuids', 'HasVersion7Uuids'),
    usesUlids: hasTrait('HasUlids'),
  };
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Parses a Laravel project into the shared IR. The schema is rebuilt by replaying
 * the migrations in file-name order (the source of truth for columns, indexes and
 * foreign keys); Eloquent models contribute relation names, casts to backed enums,
 * custom table names and timestamps handling.
 */
export async function parseLaravel(
  sources: LaravelSourceFile[],
  options: LaravelParseOptions
): Promise<Result<IrSchema>> {
  const parserResult: Result<Parser> = await getPhpParser();
  if (!parserResult.ok) {
    return parserResult;
  }
  const warnings: string[] = [];
  const found: Discovered = discover(sources, parserResult.value, warnings);
  if (found.migrations.length === 0) {
    const checkedPaths: string = sources
      .map((source: LaravelSourceFile) => source.path)
      .join(', ');
    return err(
      'NO_MODELS_FOUND',
      `No Laravel migrations were found in: ${checkedPaths}. A migration is a class whose up() method calls Schema::create() or Schema::table(); ` +
        `Laravel keeps its schema in migrations, so pass the database/migrations directory (or the project root) together with the models.`
    );
  }

  const ordered: Discovered['migrations'] = [...found.migrations].sort(
    (first, second) =>
      first.key < second.key ? -1 : first.key > second.key ? 1 : 0
  );
  const hasPrefix = (key: string): boolean =>
    /^\d{4}_\d{2}_\d{2}_\d{6}_/.test(key);
  if (ordered.length > 1) {
    for (const entry of ordered) {
      if (!hasPrefix(entry.key)) {
        warnings.push(
          `${entry.migration.file}: the migration file name has no timestamp prefix (YYYY_MM_DD_HHMMSS_); migrations were ordered by file name.`
        );
      }
    }
  }

  const state: ReplayState = { tables: new Map(), warnings };
  for (const entry of ordered) {
    replayMigration(entry.migration, state);
  }

  const schema: IrSchema = buildSchema(state, found, options);
  if (schema.models.length === 0) {
    return err(
      'NO_MODELS_FOUND',
      `The Laravel migrations in ${sources.map((source: LaravelSourceFile) => source.path).join(', ')} leave no tables behind ` +
        `(every table is dropped again, or only altered without being created).`
    );
  }
  return ok(schema);
}

// ---------------------------------------------------------------------------
// Schema assembly
// ---------------------------------------------------------------------------

/** A foreign key column on a table, from a constraint and/or a model relationship. */
interface Candidate {
  column: string;
  targetTable: string;
  targetColumn: string;
  name?: string;
  foreignKey?: ForeignKeyDef;
  /** Name of the reverse accessor and whether it returns one model or many. */
  reverse?: { name: string; many: boolean };
}

/** One `belongsToMany` relationship resolved against the tables. */
interface PivotUse {
  owner: EffectiveModel;
  related: EffectiveModel;
  method: RelationMethod;
  table: string;
  ownerColumn: string;
  relatedColumn: string;
  isFoldable: boolean;
}

function singlePrimaryKey(table: TableState | undefined): string | undefined {
  return table?.primaryKey?.length === 1 ? table.primaryKey[0] : undefined;
}

function buildSchema(
  state: ReplayState,
  found: Discovered,
  options: LaravelParseOptions
): IrSchema {
  const warnings: string[] = state.warnings;

  // Tables -----------------------------------------------------------------
  const live: Map<string, TableState> = new Map<string, TableState>();
  for (const table of state.tables.values()) {
    if (table.isPartial) {
      warnings.push(
        `${table.name}: the table is altered by the migrations but never created in the provided files; it was skipped.`
      );
    } else {
      live.set(table.name, table);
    }
  }

  // Models -----------------------------------------------------------------
  const classesByFqn: Map<string, ModelClass> = new Map<string, ModelClass>(
    found.models.map((model: ModelClass): [string, ModelClass] => [
      model.fqn,
      model,
    ])
  );
  const effectiveByFqn: Map<string, EffectiveModel> = new Map<
    string,
    EffectiveModel
  >();
  const effectiveByTable: Map<string, EffectiveModel> = new Map<
    string,
    EffectiveModel
  >();
  for (const model of found.models) {
    if (model.isAbstract) {
      continue;
    }
    const effective: EffectiveModel = resolveModel(model, classesByFqn);
    if (!live.has(effective.table)) {
      warnings.push(
        `${model.name}: the model maps to the table "${effective.table}", which no migration creates; the model was skipped.`
      );
      continue;
    }
    const taken: EffectiveModel | undefined = effectiveByTable.get(
      effective.table
    );
    if (taken !== undefined) {
      warnings.push(
        `${model.name}: the table "${effective.table}" is already used by the model ${taken.source.name}; ${model.name} was ignored.`
      );
      continue;
    }
    effectiveByTable.set(effective.table, effective);
    effectiveByFqn.set(model.fqn, effective);
  }
  const keyName = (effective: EffectiveModel): string =>
    effective.primaryKey ?? singlePrimaryKey(live.get(effective.table)) ?? 'id';

  // Pivot tables -------------------------------------------------------------
  const uses: PivotUse[] = [];
  for (const effective of effectiveByTable.values()) {
    const owner: ModelClass = effective.source;
    for (const method of owner.relations) {
      if (method.kind !== 'belongsToMany') {
        continue;
      }
      const related: EffectiveModel | undefined =
        method.relatedFqn === undefined
          ? undefined
          : effectiveByFqn.get(method.relatedFqn);
      if (related === undefined) {
        warnings.push(
          `${owner.name}::${method.name}(): the related class is not a model with a table in the provided files; the relation was skipped.`
        );
        continue;
      }
      const pivotModel: EffectiveModel | undefined =
        method.pivotModelFqn === undefined
          ? undefined
          : effectiveByFqn.get(method.pivotModelFqn);
      const table: string =
        method.pivotTable ??
        pivotModel?.table ??
        [eloquentSnake(owner.name), eloquentSnake(related.source.name)]
          .sort()
          .join('_');
      const ownerColumn: string =
        method.foreignKey ??
        `${eloquentSnake(owner.name)}_${keyName(effective)}`;
      const relatedColumn: string =
        method.relatedPivotKey ??
        `${eloquentSnake(related.source.name)}_${keyName(related)}`;
      const pivot: TableState | undefined = live.get(table);
      if (pivot === undefined) {
        warnings.push(
          `${owner.name}::${method.name}(): the pivot table "${table}" is not created by the migrations; the relation was skipped.`
        );
        continue;
      }
      if (
        !pivot.columns.has(ownerColumn) ||
        !pivot.columns.has(relatedColumn)
      ) {
        warnings.push(
          `${owner.name}::${method.name}(): the pivot table "${table}" has no column "${
            pivot.columns.has(ownerColumn) ? relatedColumn : ownerColumn
          }"; the relation was skipped.`
        );
        continue;
      }
      if (method.parentKey !== undefined || method.relatedKey !== undefined) {
        warnings.push(
          `${owner.name}::${method.name}(): the parentKey / relatedKey arguments (keys other than the primary key) are not represented.`
        );
      }
      const extraColumns: string[] = [...pivot.columns.keys()].filter(
        (name: string) =>
          name !== ownerColumn &&
          name !== relatedColumn &&
          !(name === 'id' && pivot.primaryKey?.join() === 'id') &&
          name !== 'created_at' &&
          name !== 'updated_at'
      );
      const isFoldable: boolean = extraColumns.length === 0;
      if (!isFoldable) {
        warnings.push(
          `${owner.name}::${method.name}(): the pivot table "${table}" has extra columns (${extraColumns.join(', ')}), so it was kept as a model and the relation was not converted to a many-to-many field.`
        );
      }
      uses.push({
        owner: effective,
        related,
        method,
        table,
        ownerColumn,
        relatedColumn,
        isFoldable,
      });
    }
  }
  const folded: Set<string> = new Set<string>();
  for (const table of unique(uses.map((use: PivotUse) => use.table))) {
    if (
      uses
        .filter((use: PivotUse) => use.table === table)
        .every((use: PivotUse) => use.isFoldable)
    ) {
      folded.add(table);
    }
  }

  // Names ------------------------------------------------------------------
  const modelNames: Map<string, string> = new Map<string, string>();
  const takenNames: Set<string> = new Set<string>();
  for (const table of live.keys()) {
    const preferred: string =
      effectiveByTable.get(table)?.source.name ??
      toPascalCase(singularize(table));
    let name: string = preferred === '' ? 'Model' : preferred;
    while (takenNames.has(name)) {
      name = `${name}Table`;
    }
    takenNames.add(name);
    modelNames.set(table, name);
  }
  const tableForClassName = (className: string): string => {
    const short: string = lastNameSegment(className);
    for (const [table, effective] of effectiveByTable) {
      if (effective.source.name === short) {
        return table;
      }
    }
    return conventionalTableName(short);
  };

  // Foreign key candidates -------------------------------------------------
  const candidates: Map<string, Map<string, Candidate>> = new Map();
  const candidatesOf = (table: string): Map<string, Candidate> => {
    let map: Map<string, Candidate> | undefined = candidates.get(table);
    if (map === undefined) {
      map = new Map<string, Candidate>();
      candidates.set(table, map);
    }
    return map;
  };
  const isTarget = (table: string): boolean =>
    live.has(table) && !folded.has(table);

  for (const table of live.values()) {
    if (folded.has(table.name)) {
      continue;
    }
    for (const key of table.foreignKeys) {
      const column: string | undefined = key.columns[0];
      if (key.columns.length !== 1 || column === undefined) {
        warnings.push(
          `${table.name}: the composite foreign key (${key.columns.join(', ')}) is not supported; its columns were kept as plain columns.`
        );
        continue;
      }
      if (!table.columns.has(column)) {
        continue;
      }
      const referenced: string | undefined =
        key.refTable ??
        (key.refModel === undefined
          ? undefined
          : tableForClassName(key.refModel));
      if (referenced === undefined) {
        warnings.push(
          `${table.name}.${column}: the foreign key does not name a referenced table; the column was kept as a plain column.`
        );
        continue;
      }
      if (!isTarget(referenced)) {
        warnings.push(
          `${table.name}.${column}: the foreign key references the table "${referenced}", which no migration creates; the column was kept as a plain column.`
        );
        continue;
      }
      candidatesOf(table.name).set(column, {
        column,
        targetTable: referenced,
        targetColumn: key.refColumns[0] ?? 'id',
        foreignKey: key,
      });
    }
  }

  for (const effective of effectiveByTable.values()) {
    const owner: ModelClass = effective.source;
    for (const method of owner.relations) {
      if (method.kind === 'morph' || method.kind === 'through') {
        warnings.push(
          method.kind === 'morph'
            ? `${owner.name}::${method.name}(): the polymorphic relation (${method.call}) is not represented; its columns, if any, were kept as plain columns.`
            : `${owner.name}::${method.name}(): the ${method.call} relation is derived from other relations and was not converted.`
        );
        continue;
      }
      if (method.extraModifiers.length > 0) {
        warnings.push(
          `${owner.name}::${method.name}(): the relation is further constrained by ${method.extraModifiers.join(', ')}(); the constraint is not represented.`
        );
      }
      if (method.kind === 'belongsToMany') {
        continue;
      }
      const related: EffectiveModel | undefined =
        method.relatedFqn === undefined
          ? undefined
          : effectiveByFqn.get(method.relatedFqn);
      if (related === undefined) {
        warnings.push(
          `${owner.name}::${method.name}(): the related class is not a model with a table in the provided files; the relation was skipped.`
        );
        continue;
      }
      if (method.kind === 'belongsTo') {
        const ownerKey: string = method.otherKey ?? keyName(related);
        const column: string =
          method.foreignKey ?? `${eloquentSnake(method.name)}_${ownerKey}`;
        const table: TableState | undefined = live.get(effective.table);
        if (table === undefined || !table.columns.has(column)) {
          warnings.push(
            `${owner.name}::${method.name}(): belongsTo uses the column "${column}", which the table "${effective.table}" does not have; the relation was skipped.`
          );
          continue;
        }
        if (!isTarget(related.table)) {
          continue;
        }
        const existing: Candidate | undefined = candidatesOf(
          effective.table
        ).get(column);
        if (existing === undefined) {
          candidatesOf(effective.table).set(column, {
            column,
            targetTable: related.table,
            targetColumn: ownerKey,
            name: method.name,
          });
        } else {
          existing.name = method.name;
          if (existing.targetTable !== related.table) {
            warnings.push(
              `${owner.name}::${method.name}(): belongsTo points at "${related.table}" but the foreign key on ${effective.table}.${column} references "${existing.targetTable}"; the foreign key was used.`
            );
          }
        }
        continue;
      }
      // hasOne / hasMany: the foreign key lives on the related table.
      const column: string =
        method.foreignKey ??
        `${eloquentSnake(owner.name)}_${keyName(effective)}`;
      const localKey: string = method.otherKey ?? keyName(effective);
      const relatedTable: TableState | undefined = live.get(related.table);
      if (relatedTable === undefined || !isTarget(related.table)) {
        continue;
      }
      if (!relatedTable.columns.has(column)) {
        warnings.push(
          `${owner.name}::${method.name}(): ${method.call} uses the column "${column}", which the table "${related.table}" does not have; the relation was skipped.`
        );
        continue;
      }
      const existing: Candidate | undefined = candidatesOf(related.table).get(
        column
      );
      const reverse: Candidate['reverse'] = {
        name: method.name,
        many: method.kind === 'hasMany',
      };
      if (existing === undefined) {
        candidatesOf(related.table).set(column, {
          column,
          targetTable: effective.table,
          targetColumn: localKey,
          reverse,
        });
      } else if (existing.targetTable !== effective.table) {
        warnings.push(
          `${owner.name}::${method.name}(): ${method.call} expects ${related.table}.${column} to reference "${effective.table}" but it references "${existing.targetTable}"; the reverse name was not applied.`
        );
      } else if (existing.reverse === undefined) {
        existing.reverse = reverse;
      }
    }
  }

  // Pivot tables kept as models still need their relations.
  for (const use of uses) {
    if (folded.has(use.table)) {
      continue;
    }
    const pairs: [string, EffectiveModel][] = [
      [use.ownerColumn, use.owner],
      [use.relatedColumn, use.related],
    ];
    for (const [column, target] of pairs) {
      if (!candidatesOf(use.table).has(column) && isTarget(target.table)) {
        candidatesOf(use.table).set(column, {
          column,
          targetTable: target.table,
          targetColumn: keyName(target),
        });
      }
    }
  }

  // Enums ------------------------------------------------------------------
  const enums: Map<string, IrEnum> = new Map<string, IrEnum>();
  const findEnum = (
    className: string,
    model: ModelClass
  ): EnumInfo | undefined => {
    const resolved: string = resolveClassName(className, model.ctx);
    const exact: EnumInfo | undefined = found.enums.get(resolved);
    if (exact !== undefined) {
      return exact;
    }
    const short: EnumInfo[] = [...found.enums.values()].filter(
      (info: EnumInfo) => info.name === lastNameSegment(className)
    );
    return short.length === 1 ? short[0] : undefined;
  };
  const registerEnum = (info: EnumInfo): void => {
    if (!enums.has(info.name)) {
      enums.set(info.name, { name: info.name, values: info.values });
    }
  };
  const synthesizeEnum = (modelName: string, column: ColumnDef): string => {
    const values: IrEnumValue[] = [];
    const seen: Set<string> = new Set<string>();
    (column.enumValues ?? []).forEach((value: string, position: number) => {
      let name: string = toPascalCase(value);
      if (name === '' || /^\d/.test(name)) {
        name = `Value${position + 1}`;
      }
      while (seen.has(name)) {
        name = `${name}_`;
      }
      seen.add(name);
      values.push({ name, dbValue: value });
    });
    let enumName: string = `${modelName}${toPascalCase(column.name)}`;
    while (enums.has(enumName)) {
      enumName = `${enumName}_`;
    }
    enums.set(enumName, { name: enumName, values });
    return enumName;
  };

  // Models -----------------------------------------------------------------
  const models: IrModel[] = [];
  for (const table of live.values()) {
    if (folded.has(table.name)) {
      continue;
    }
    models.push(
      buildModel({
        table,
        modelName: modelNames.get(table.name) ?? table.name,
        effective: effectiveByTable.get(table.name),
        candidates: candidates.get(table.name) ?? new Map<string, Candidate>(),
        modelNames,
        live,
        enums,
        findEnum,
        registerEnum,
        synthesizeEnum,
        warnings,
        appLabel: options.appLabel,
      })
    );
  }

  addManyToMany(models, uses, folded, modelNames, live, warnings);

  const referenced: Set<string> = new Set<string>();
  for (const model of models) {
    for (const field of model.fields) {
      if (field.enumName !== undefined) {
        referenced.add(field.enumName);
      }
    }
  }
  return {
    models,
    enums: [...enums.values()].filter((entry: IrEnum) =>
      referenced.has(entry.name)
    ),
    warnings,
  };
}

interface ModelBuildInput {
  table: TableState;
  modelName: string;
  effective: EffectiveModel | undefined;
  candidates: Map<string, Candidate>;
  modelNames: Map<string, string>;
  live: Map<string, TableState>;
  enums: Map<string, IrEnum>;
  findEnum: (className: string, model: ModelClass) => EnumInfo | undefined;
  registerEnum: (info: EnumInfo) => void;
  synthesizeEnum: (modelName: string, column: ColumnDef) => string;
  warnings: string[];
  appLabel: string;
}

function buildModel(input: ModelBuildInput): IrModel {
  const { table, effective, warnings } = input;
  const primaryKey: string[] = table.primaryKey ?? [];
  const relationColumns: Set<string> = new Set(input.candidates.keys());
  const uniqueSingles: Set<string> = new Set<string>();
  for (const index of table.indexes) {
    const only: string | undefined = index.columns[0];
    if (
      index.isUnique &&
      index.kind === undefined &&
      index.columns.length === 1 &&
      only !== undefined
    ) {
      uniqueSingles.add(only);
    }
  }
  if (primaryKey.length === 1 && primaryKey[0] !== undefined) {
    uniqueSingles.add(primaryKey[0]);
  }

  // Fields -----------------------------------------------------------------
  const fields: IrField[] = [];
  for (const column of table.columns.values()) {
    if (relationColumns.has(column.name)) {
      continue;
    }
    fields.push(buildField(column, table, effective, input));
  }
  const usedNames: Set<string> = new Set(
    fields.map((field: IrField) => field.name)
  );

  // Relations --------------------------------------------------------------
  const relationNames: Map<string, string> = new Map<string, string>();
  const relations: IrRelation[] = [];
  for (const column of table.columns.values()) {
    const candidate: Candidate | undefined = input.candidates.get(column.name);
    if (candidate === undefined) {
      continue;
    }
    let name: string = candidate.name ?? column.name.replace(/_id$/, '');
    if (name === '') {
      name = column.name;
    }
    while (usedNames.has(name)) {
      name = `${name}_rel`;
    }
    usedNames.add(name);
    relationNames.set(column.name, name);

    const isPrimary: boolean =
      primaryKey.length === 1 && primaryKey[0] === column.name;
    const targetTable: TableState | undefined = input.live.get(
      candidate.targetTable
    );
    const targetKey: string = singlePrimaryKey(targetTable) ?? 'id';
    const kind: IrRelation['kind'] =
      candidate.reverse?.many === false ||
      (candidate.reverse === undefined && uniqueSingles.has(column.name))
        ? 'oneToOne'
        : 'foreignKey';
    const relation: IrRelation = {
      name,
      kind,
      targetModel:
        input.modelNames.get(candidate.targetTable) ?? candidate.targetTable,
      columnName: column.name,
      isNullable: column.isNullable && !isPrimary,
      onDelete: candidate.foreignKey?.onDelete ?? 'noAction',
      ...(candidate.reverse === undefined
        ? {}
        : { relatedName: candidate.reverse.name }),
      ...(candidate.targetColumn === targetKey
        ? {}
        : { toField: candidate.targetColumn }),
      ...(isPrimary ? { isPrimaryKey: true } : {}),
      ...(candidate.foreignKey?.onUpdate === undefined
        ? {}
        : { onUpdate: candidate.foreignKey.onUpdate }),
    };
    relations.push(relation);
  }
  const irName = (column: string): string =>
    relationNames.get(column) ?? column;

  // Primary key ------------------------------------------------------------
  let compositePrimaryKey: string[] | undefined;
  if (primaryKey.length > 1) {
    compositePrimaryKey = primaryKey.map(irName);
  } else if (primaryKey.length === 0) {
    warnings.push(`${table.name}: the table has no primary key.`);
  }

  // Indexes ----------------------------------------------------------------
  const indexes: IrIndex[] = [];
  for (const index of table.indexes) {
    const missing: string[] = index.columns.filter(
      (name: string) => !table.columns.has(name)
    );
    if (missing.length > 0) {
      warnings.push(
        `${table.name}: the ${index.isUnique ? 'unique constraint' : 'index'} on (${index.columns.join(', ')}) refers to "${missing.join('", "')}", which is not a column of the table; it was skipped.`
      );
      continue;
    }
    const type: 'index' | 'unique' | 'fulltext' =
      index.kind === 'fulltext'
        ? 'fulltext'
        : index.isUnique
          ? 'unique'
          : 'index';
    const conventional: string = conventionalIndexName(
      table.name,
      index.columns,
      type
    );
    const explicitName: string | undefined =
      index.name !== undefined && index.name !== conventional
        ? index.name
        : undefined;
    const names: string[] = index.columns.map(irName);
    const only: string | undefined = index.columns[0];
    if (
      index.isUnique &&
      index.kind === undefined &&
      explicitName === undefined &&
      index.columns.length === 1 &&
      only !== undefined
    ) {
      const field: IrField | undefined = fields.find(
        (candidate: IrField) => candidate.columnName === only
      );
      if (field !== undefined) {
        if (!field.isPrimaryKey) {
          field.isUnique = true;
        }
        continue;
      }
      if (relationNames.has(only)) {
        // The relation is one-to-one already; nothing else to record.
        continue;
      }
    }
    indexes.push({
      fields: names,
      isUnique: index.isUnique,
      ...(explicitName === undefined ? {} : { name: explicitName }),
      ...(index.kind === undefined ? {} : { kind: index.kind }),
    });
  }

  // Soft deletes -----------------------------------------------------------
  if (
    effective !== undefined &&
    effective.usesSoftDeletes &&
    !table.columns.has(effective.deletedAt)
  ) {
    warnings.push(
      `${effective.source.name}: the model uses SoftDeletes but the table "${table.name}" has no "${effective.deletedAt}" column.`
    );
  }

  return {
    name: input.modelName,
    tableName: table.name,
    appLabel: input.appLabel,
    fields,
    relations,
    indexes,
    ...(compositePrimaryKey === undefined ? {} : { compositePrimaryKey }),
  };
}

function buildField(
  column: ColumnDef,
  table: TableState,
  effective: EffectiveModel | undefined,
  input: ModelBuildInput
): IrField {
  const { warnings } = input;
  const label: string = `${table.name}.${column.name}`;
  const isPrimary: boolean =
    table.primaryKey?.length === 1 && table.primaryKey[0] === column.name;
  const field: IrField = {
    name: column.name,
    columnName: column.name,
    type: column.type,
    isPrimaryKey: isPrimary,
    isUnique: false,
    isNullable: column.isNullable && !isPrimary,
    isAutoUpdated: column.isAutoUpdated,
  };
  if (column.default !== undefined) {
    field.default = column.default;
  }
  if (column.type === 'string' && column.maxLength !== undefined) {
    field.maxLength = column.maxLength;
  }
  if (column.type === 'decimal') {
    field.maxDigits = column.maxDigits ?? 8;
    field.decimalPlaces = column.decimalPlaces ?? 2;
  }
  if (column.unsupportedType !== undefined) {
    field.unsupportedType = column.unsupportedType;
  }
  if (column.generated !== undefined) {
    field.generated = column.generated;
  }

  // Eloquent behaviour for this column.
  if (effective !== undefined) {
    if (
      effective.timestamps &&
      field.type === 'dateTime' &&
      column.name === effective.updatedAt
    ) {
      field.isAutoUpdated = true;
    }
    if (
      effective.timestamps &&
      field.type === 'dateTime' &&
      column.name === effective.createdAt &&
      field.default === undefined
    ) {
      field.default = { kind: 'now' };
    }
    const generatesId: boolean =
      effective.uniqueIds === undefined
        ? isPrimary
        : effective.uniqueIds.includes(column.name);
    if (generatesId && field.default === undefined) {
      if (
        effective.usesUuids &&
        (field.type === 'uuid' || field.type === 'string')
      ) {
        field.default = { kind: 'uuid' };
      } else if (effective.usesUlids && field.type === 'string') {
        field.default = { kind: 'clientGenerated', generator: 'ulid' };
      }
    }
    const cast: PhpValue | undefined = effective.casts.get(column.name);
    if (cast !== undefined) {
      applyCast(field, column, cast, effective, label, input);
    }
  }

  // A column that refreshes on every save is also set when the row is created, which is
  // how the other formats spell it (`auto_now`, `@updatedAt`): no separate default.
  if (field.isAutoUpdated && field.default?.kind === 'now') {
    delete field.default;
  }

  // An `enum` column without a backed enum cast becomes an enum of its own.
  if (column.enumValues !== undefined && field.enumName === undefined) {
    field.enumName = input.synthesizeEnum(input.modelName, column);
    delete field.maxLength;
  }
  if (field.enumName !== undefined) {
    if (!column.hasExplicitLength) {
      delete field.maxLength;
    }
    convertEnumDefault(field, input.enums.get(field.enumName), label, warnings);
  }
  return field;
}

function convertEnumDefault(
  field: IrField,
  enumeration: IrEnum | undefined,
  label: string,
  warnings: string[]
): void {
  const current: IrDefault | undefined = field.default;
  if (
    enumeration === undefined ||
    current === undefined ||
    current.kind !== 'literal'
  ) {
    return;
  }
  const match: IrEnumValue | undefined = enumeration.values.find(
    (value: IrEnumValue) => value.dbValue === String(current.value)
  );
  if (match === undefined) {
    warnings.push(
      `${label}: the default "${String(current.value)}" is not a value of the enum "${enumeration.name}"; it was kept as a literal.`
    );
    return;
  }
  field.default = { kind: 'enumValue', value: match.name };
}

function applyCast(
  field: IrField,
  column: ColumnDef,
  cast: PhpValue,
  effective: EffectiveModel,
  label: string,
  input: ModelBuildInput
): void {
  if (
    cast.kind === 'classRef' ||
    (cast.kind === 'string' && /\\/.test(cast.value))
  ) {
    const className: string =
      cast.kind === 'classRef'
        ? cast.name
        : cast.kind === 'string'
          ? cast.value
          : '';
    const info: EnumInfo | undefined = input.findEnum(
      className,
      effective.source
    );
    if (info === undefined) {
      return;
    }
    if (info.backing !== 'string') {
      input.warnings.push(
        `${label}: the cast to the ${info.backing === 'int' ? 'int-backed' : 'non-backed'} enum ${info.name} is not supported; the column keeps its ${field.type} type.`
      );
      return;
    }
    if (field.type !== 'string' && field.type !== 'text') {
      input.warnings.push(
        `${label}: the cast to the enum ${info.name} was ignored because the column is of type ${field.type}.`
      );
      return;
    }
    if (column.enumValues !== undefined) {
      const allowed: string[] = info.values.map(
        (value: IrEnumValue) => value.dbValue
      );
      const differing: string[] = column.enumValues.filter(
        (value: string) => !allowed.includes(value)
      );
      if (differing.length > 0) {
        input.warnings.push(
          `${label}: the enum() values (${differing.join(', ')}) are not cases of ${info.name}.`
        );
      }
    }
    input.registerEnum(info);
    field.type = 'string';
    field.enumName = info.name;
    return;
  }
  if (cast.kind !== 'string') {
    return;
  }
  const [base, parameter] = cast.value.toLowerCase().split(':', 2);
  switch (base) {
    case 'boolean':
    case 'bool':
      if (field.type === 'int' || field.type === 'bigInt') {
        field.type = 'boolean';
        convertBooleanDefault(field);
      }
      break;
    case 'array':
    case 'json':
    case 'object':
    case 'collection':
      if (field.type === 'string' || field.type === 'text') {
        field.type = 'json';
        delete field.maxLength;
      }
      break;
    case 'decimal': {
      const places: number = Number(parameter);
      if (
        field.type === 'decimal' &&
        parameter !== undefined &&
        Number.isInteger(places)
      ) {
        field.decimalPlaces = places;
      }
      break;
    }
    case 'date':
    case 'immutable_date':
      if (field.type === 'string' || field.type === 'text') {
        field.type = 'date';
        delete field.maxLength;
      }
      break;
    case 'datetime':
    case 'immutable_datetime':
    case 'custom_datetime':
    case 'immutable_custom_datetime':
      if (field.type === 'string' || field.type === 'text') {
        field.type = 'dateTime';
        delete field.maxLength;
      }
      break;
    default:
      break;
  }
}

function convertBooleanDefault(field: IrField): void {
  if (field.default?.kind === 'literal') {
    const value: string | number | boolean = field.default.value;
    if (value === 0 || value === 1) {
      field.default = { kind: 'literal', value: value === 1 };
    }
  }
}

function addManyToMany(
  models: IrModel[],
  uses: PivotUse[],
  folded: Set<string>,
  modelNames: Map<string, string>,
  live: Map<string, TableState>,
  warnings: string[]
): void {
  const consumed: Set<PivotUse> = new Set<PivotUse>();
  const ordered: PivotUse[] = uses
    .filter((use: PivotUse) => folded.has(use.table))
    .sort((first, second) => {
      const firstKey: string = `${first.owner.source.name}.${first.method.name}`;
      const secondKey: string = `${second.owner.source.name}.${second.method.name}`;
      return firstKey < secondKey ? -1 : firstKey > secondKey ? 1 : 0;
    });
  for (const use of ordered) {
    if (consumed.has(use)) {
      continue;
    }
    consumed.add(use);
    const mirror: PivotUse | undefined = ordered.find(
      (candidate: PivotUse) =>
        !consumed.has(candidate) &&
        candidate.table === use.table &&
        candidate.owner === use.related &&
        candidate.related === use.owner &&
        candidate.ownerColumn === use.relatedColumn &&
        candidate.relatedColumn === use.ownerColumn
    );
    if (mirror !== undefined) {
      consumed.add(mirror);
    }
    const ownerModel: IrModel | undefined = models.find(
      (model: IrModel) => model.tableName === use.owner.table
    );
    const ownerName: string =
      modelNames.get(use.owner.table) ?? use.owner.table;
    const relatedName: string =
      modelNames.get(use.related.table) ?? use.related.table;
    if (ownerModel === undefined) {
      continue;
    }
    const relation: IrRelation = {
      name: use.method.name,
      kind: 'manyToMany',
      targetModel: relatedName,
      columnName: `${toSnakeCase(use.method.name)}_id`,
      isNullable: false,
      onDelete: 'cascade',
      ...(mirror === undefined ? {} : { relatedName: mirror.method.name }),
    };
    ownerModel.relations.push(relation);

    // Join tables are derived by the other formats; say what does not survive.
    const isSelf: boolean = use.owner === use.related;
    const expectedTable: string = `${use.owner.table}_${use.method.name}`;
    const expectedOwner: string = `${isSelf ? 'from_' : ''}${toSnakeCase(ownerName)}_id`;
    const expectedRelated: string = `${isSelf ? 'to_' : ''}${toSnakeCase(relatedName)}_id`;
    if (
      use.table !== expectedTable ||
      use.ownerColumn !== expectedOwner ||
      use.relatedColumn !== expectedRelated
    ) {
      warnings.push(
        `${ownerName}.${use.method.name}: the pivot table "${use.table}" (columns ${use.ownerColumn}, ${use.relatedColumn}) is not preserved by name; ` +
          `formats that derive join tables will use "${expectedTable}" (columns ${expectedOwner}, ${expectedRelated}).`
      );
    }
    const pivot: TableState | undefined = live.get(use.table);
    if (pivot !== undefined) {
      if (pivot.columns.has('created_at') || pivot.columns.has('updated_at')) {
        warnings.push(
          `${ownerName}.${use.method.name}: the timestamp columns of the pivot table "${use.table}" are not represented in the many-to-many field.`
        );
      }
      const customActions: string[] = pivot.foreignKeys
        .filter(
          (key: ForeignKeyDef) =>
            key.onDelete !== undefined &&
            key.onDelete !== 'cascade' &&
            (sameList(key.columns, [use.ownerColumn]) ||
              sameList(key.columns, [use.relatedColumn]))
        )
        .map((key: ForeignKeyDef) => key.columns.join(', '));
      if (customActions.length > 0) {
        warnings.push(
          `${ownerName}.${use.method.name}: the foreign keys of the pivot table "${use.table}" on (${customActions.join('; ')}) do not cascade on delete; many-to-many join tables always do.`
        );
      }
    }
  }
}
