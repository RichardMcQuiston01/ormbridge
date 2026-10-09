import { basename } from 'node:path';
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
import {
  singularize,
  toCamelCase,
  toPascalCase,
  toSnakeCase,
} from '../naming.js';
import { err, ok, type Result } from '../result.js';
import {
  evaluateNode,
  getTypeScriptParser,
  type SyntaxNode,
  type TsObject,
  type TsValue,
} from './typescriptSyntax.js';

export interface DrizzleSourceFile {
  path: string;
  text: string;
}

export interface DrizzleParseOptions {
  /** App label stored on each model (Drizzle itself has no equivalent). */
  appLabel: string;
}

// ---------------------------------------------------------------------------
// Static tables
// ---------------------------------------------------------------------------

type Dialect = 'pg' | 'mysql' | 'sqlite';

/** Table builders that start a table definition, by dialect. */
const TABLE_FUNCTIONS: Readonly<Record<string, Dialect>> = {
  pgTable: 'pg',
  mysqlTable: 'mysql',
  sqliteTable: 'sqlite',
};

/** Table creators (`pgTableCreator((name) => ...)`), by dialect. */
const TABLE_CREATORS: Readonly<Record<string, Dialect>> = {
  pgTableCreator: 'pg',
  mysqlTableCreator: 'mysql',
  sqliteTableCreator: 'sqlite',
};

/** Schema builders (`pgSchema('auth')`), by dialect. */
const SCHEMA_FUNCTIONS: Readonly<Record<string, Dialect>> = {
  pgSchema: 'pg',
  mysqlSchema: 'mysql',
};

/** Table builders of Drizzle dialects this parser does not read. */
const UNSUPPORTED_DIALECT_TABLES: Readonly<Record<string, string>> = {
  singlestoreTable: 'SingleStore',
  gelTable: 'Gel',
  mssqlTable: 'SQL Server',
  cockroachTable: 'CockroachDB',
};

/** Top-level definitions that exist in the database but have no equivalent in the shared model. */
const UNSUPPORTED_DEFINITIONS: Readonly<Record<string, string>> = {
  pgView: 'views',
  pgMaterializedView: 'materialized views',
  mysqlView: 'views',
  sqliteView: 'views',
  pgSequence: 'sequences',
  pgRole: 'roles',
  pgPolicy: 'row level security policies',
};

/** PostgreSQL builders that map straight to one IR type. */
const PG_SIMPLE_TYPES: Readonly<Record<string, IrScalarType>> = {
  serial: 'int',
  smallserial: 'int',
  bigserial: 'bigInt',
  integer: 'int',
  smallint: 'int',
  bigint: 'bigInt',
  real: 'float',
  doublePrecision: 'float',
  boolean: 'boolean',
  text: 'text',
  uuid: 'uuid',
  json: 'json',
  jsonb: 'json',
  date: 'date',
  time: 'time',
  timestamp: 'dateTime',
  interval: 'duration',
  inet: 'ipAddress',
  bytea: 'bytes',
};

/** PostgreSQL builders that are auto-incrementing, implicitly NOT NULL columns. */
const PG_SERIAL_TYPES: ReadonlySet<string> = new Set([
  'serial',
  'smallserial',
  'bigserial',
]);

/** PostgreSQL builders with no IR type, mapped to the SQL type they create. */
const PG_UNSUPPORTED_TYPES: Readonly<Record<string, string>> = {
  point: 'point',
  line: 'line',
  macaddr: 'macaddr',
  macaddr8: 'macaddr8',
  cidr: 'cidr',
  geometry: 'geometry',
  vector: 'vector',
  halfvec: 'halfvec',
  sparsevec: 'sparsevec',
  bit: 'bit',
};

const MYSQL_SIMPLE_TYPES: Readonly<Record<string, IrScalarType>> = {
  int: 'int',
  tinyint: 'int',
  smallint: 'int',
  mediumint: 'int',
  bigint: 'bigInt',
  float: 'float',
  double: 'float',
  real: 'float',
  boolean: 'boolean',
  text: 'text',
  tinytext: 'text',
  mediumtext: 'text',
  longtext: 'text',
  date: 'date',
  datetime: 'dateTime',
  timestamp: 'dateTime',
  time: 'time',
  year: 'int',
  json: 'json',
};

const SQLITE_SIMPLE_TYPES: Readonly<Record<string, IrScalarType>> = {
  real: 'float',
};

const ON_ACTION_MAP: Readonly<Record<string, IrOnDelete>> = {
  cascade: 'cascade',
  'set null': 'setNull',
  restrict: 'restrict',
  'no action': 'noAction',
  'set default': 'setDefault',
};

/** Index access methods Prisma knows, spelled the way the IR stores them. */
const INDEX_METHODS: Readonly<Record<string, string>> = {
  btree: 'BTree',
  hash: 'Hash',
  gin: 'Gin',
  gist: 'Gist',
  spgist: 'SpGist',
  brin: 'BRIN',
};

const NOW_SQL: RegExp =
  /^\(?(now\(\)|current_timestamp(\(\d*\))?|localtimestamp(\(\d*\))?|transaction_timestamp\(\)|unixepoch\(\)|datetime\('now'\)|strftime\(.*'now'.*\)|\(unixepoch\(\)\)|\(datetime\('now'\)\))\)?$/i;
const UUID_SQL: RegExp =
  /^(uuid_generate_v[14]\(\)|gen_random_uuid\(\)|uuid\(\)|newid\(\))$/i;
const QUOTED_SQL: RegExp = /^'((?:[^']|'')*)'(::[\w\s]+)?$/;

/** Wrappers that change nothing about the value an expression evaluates to. */
const TRANSPARENT_NODES: ReadonlySet<string> = new Set([
  'parenthesized_expression',
  'as_expression',
  'satisfies_expression',
  'non_null_expression',
  'type_assertion',
]);

// ---------------------------------------------------------------------------
// Intermediate structures
// ---------------------------------------------------------------------------

interface FileInfo {
  path: string;
  /** Short name used in warnings. */
  label: string;
  /** Local name -> imported name (`import { pgTable as table }`). */
  aliases: Map<string, string>;
  /** Names of `import * as x` bindings, so `x.pgTable(...)` reads like `pgTable(...)`. */
  namespaces: Set<string>;
}

interface Declarator {
  file: FileInfo;
  name: string;
  node: SyntaxNode;
}

interface SchemaDecl {
  dbName: string;
  dialect: Dialect;
}

interface CreatorDecl {
  dialect: Dialect;
  /** Maps the name given to the table to the database name; undefined when it is not static. */
  transform: ((name: string) => string) | undefined;
}

interface EnumDecl {
  varName: string;
  ir: IrEnum;
}

interface TableDecl {
  file: FileInfo;
  varName: string;
  dialect: Dialect;
  schema?: string;
  creator?: CreatorDecl;
  nameNode: SyntaxNode | undefined;
  columnsNode: SyntaxNode | undefined;
  extraNode: SyntaxNode | undefined;
}

interface ColumnRef {
  /** Table (variable) the column is read from, when written as `table.column`. */
  owner: string | undefined;
  /** Property key of the column in its table definition. */
  key: string;
  sort?: 'asc' | 'desc';
  ops?: string;
}

/** A foreign key before it is turned into a relation. */
interface RawForeignKey {
  /** Local column keys, in key order. */
  columns: string[];
  targetVar: string;
  /** Referenced column keys, in the same order. */
  targetColumns: string[];
  onDelete: IrOnDelete | undefined;
  onUpdate: IrOnDelete | undefined;
  name: string | undefined;
}

interface RawIndex {
  columns: string[];
  isUnique: boolean;
  name: string | undefined;
  method: string | undefined;
  fieldOptions: Record<string, IrIndexFieldOptions>;
  isPartial: boolean;
}

interface RawColumn {
  key: string;
  field: IrField;
  isNotNull: boolean;
}

interface RawTable {
  decl: TableDecl;
  modelName: string;
  dbName: string;
  columns: RawColumn[];
  foreignKeys: RawForeignKey[];
  indexes: RawIndex[];
  primaryKey: { columns: string[]; name: string | undefined } | undefined;
}

/** One entry of a `relations(table, ({ one, many }) => ({ ... }))` callback. */
interface RelationEntry {
  key: string;
  kind: 'one' | 'many';
  targetVar: string;
  fields: ColumnRef[] | undefined;
  references: ColumnRef[] | undefined;
  relationName: string | undefined;
}

interface RelationDef {
  file: FileInfo;
  tableVar: string;
  entries: RelationEntry[];
}

/** The owning side of a relation: a foreign key, with the name the relation has. */
interface OwnerRelation {
  table: RawTable;
  name: string;
  foreignKey: RawForeignKey;
  relationName: string | undefined;
  reverseName: string | undefined;
  /** True when a `one(...)` entry of `relations()` declares it (as opposed to a bare foreign key). */
  isDeclared: boolean;
}

interface Project {
  files: FileInfo[];
  declarators: Declarator[];
  schemas: Map<string, SchemaDecl>;
  creators: Map<string, CreatorDecl>;
  /** Top-level object literals and functions returning objects or columns, for spreads and helpers. */
  helpers: Map<string, SyntaxNode>;
  enums: Map<string, EnumDecl>;
  tables: TableDecl[];
  relationDefs: RelationDef[];
  warnings: string[];
}

interface CallLink {
  name: string;
  args: SyntaxNode[];
}

/** A chain such as `integer('id').primaryKey().notNull()`: the first call and the calls chained on it. */
interface CallChain {
  baseCallee: string;
  baseArgs: SyntaxNode[];
  /** Chained calls, innermost first. */
  links: CallLink[];
}

interface ResolvedType {
  type: IrScalarType;
  maxLength?: number;
  maxDigits?: number;
  decimalPlaces?: number;
  autoIncrement?: boolean;
  /** True for builders that imply NOT NULL (serial). */
  notNull?: boolean;
  /** True for builders that imply a unique key (MySQL serial). */
  unique?: boolean;
  unsupportedType?: string;
  /** Warning about an approximation made while reading the type. */
  note?: string;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/** Parses Drizzle ORM schema files into the shared IR using tree-sitter (no Node project required). */
export async function parseDrizzle(
  sources: DrizzleSourceFile[],
  options: DrizzleParseOptions
): Promise<Result<IrSchema>> {
  const parserResult: Result<Parser> = await getTypeScriptParser();
  if (!parserResult.ok) {
    return parserResult;
  }
  const parser: Parser = parserResult.value;

  const project: Project = {
    files: [],
    declarators: [],
    schemas: new Map(),
    creators: new Map(),
    helpers: new Map(),
    enums: new Map(),
    tables: [],
    relationDefs: [],
    warnings: [],
  };

  // The trees are kept alive until the schema is built: the syntax nodes below point into them.
  const trees: Parser.Tree[] = [];
  for (const source of sources) {
    const tree: Parser.Tree = parser.parse(source.text);
    trees.push(tree);
    const file: FileInfo = describeFile(source.path, tree.rootNode);
    project.files.push(file);
    if (tree.rootNode.hasError) {
      project.warnings.push(
        `${file.label}: the file contains TypeScript syntax errors; some tables or columns may be missing from the output.`
      );
    }
    project.declarators.push(...topLevelDeclarators(file, tree.rootNode));
  }

  collectDeclarations(project);
  const schema: IrSchema = buildSchema(project, options);
  if (schema.models.length === 0) {
    const checkedPaths: string = sources
      .map((source: DrizzleSourceFile) => source.path)
      .join(', ');
    return err(
      'NO_MODELS_FOUND',
      `No Drizzle tables were found in: ${checkedPaths}. A table is a top-level \`export const users = pgTable('users', { ... })\` ` +
        `(or mysqlTable, sqliteTable, or a table of a pgSchema/mysqlSchema); relations and enums alone do not make a schema.`
    );
  }
  return ok(schema);
}

// ---------------------------------------------------------------------------
// Syntax helpers
// ---------------------------------------------------------------------------

function describeFile(path: string, root: SyntaxNode): FileInfo {
  const aliases: Map<string, string> = new Map();
  const namespaces: Set<string> = new Set();
  for (const statement of root.namedChildren) {
    if (statement.type !== 'import_statement') {
      continue;
    }
    const stack: SyntaxNode[] = [...statement.namedChildren];
    while (stack.length > 0) {
      const node: SyntaxNode | undefined = stack.pop();
      if (node === undefined) {
        break;
      }
      if (node.type === 'import_specifier') {
        const nameNode: SyntaxNode | null = node.childForFieldName('name');
        const aliasNode: SyntaxNode | null = node.childForFieldName('alias');
        if (nameNode !== null && aliasNode !== null) {
          aliases.set(aliasNode.text, nameNode.text);
        }
      } else if (node.type === 'namespace_import') {
        const nameNode: SyntaxNode | undefined = node.namedChildren[0];
        if (nameNode !== undefined) {
          namespaces.add(nameNode.text);
        }
      } else {
        stack.push(...node.namedChildren);
      }
    }
  }
  return { path, label: basename(path), aliases, namespaces };
}

/** The variable declarators at the top level of a file, including exported ones. */
function topLevelDeclarators(file: FileInfo, root: SyntaxNode): Declarator[] {
  const declarators: Declarator[] = [];
  for (const statement of root.namedChildren) {
    const declaration: SyntaxNode =
      statement.type === 'export_statement'
        ? (statement.childForFieldName('declaration') ?? statement)
        : statement;
    if (
      declaration.type !== 'lexical_declaration' &&
      declaration.type !== 'variable_declaration'
    ) {
      continue;
    }
    for (const declarator of declaration.namedChildren) {
      if (declarator.type !== 'variable_declarator') {
        continue;
      }
      const nameNode: SyntaxNode | null = declarator.childForFieldName('name');
      const valueNode: SyntaxNode | null =
        declarator.childForFieldName('value');
      if (nameNode !== null && valueNode !== null) {
        declarators.push({ file, name: nameNode.text, node: valueNode });
      }
    }
  }
  return declarators;
}

function stripWrappers(node: SyntaxNode): SyntaxNode {
  let current: SyntaxNode = node;
  while (TRANSPARENT_NODES.has(current.type)) {
    const inner: SyntaxNode | undefined = current.namedChildren[0];
    if (inner === undefined) {
      break;
    }
    current = inner;
  }
  return current;
}

function isFunctionNode(node: SyntaxNode): boolean {
  return (
    node.type === 'arrow_function' ||
    node.type === 'function_expression' ||
    node.type === 'function'
  );
}

/** The expression a function returns (the body of an arrow, or the sole `return` of a block). */
function functionResult(fn: SyntaxNode): SyntaxNode | undefined {
  const body: SyntaxNode | null = fn.childForFieldName('body');
  if (body === null) {
    return undefined;
  }
  if (body.type === 'statement_block') {
    const returned: SyntaxNode | undefined = body.namedChildren.find(
      (statement: SyntaxNode) => statement.type === 'return_statement'
    );
    return returned?.namedChildren.find(
      (child: SyntaxNode) => child.type !== 'comment'
    );
  }
  return stripWrappers(body);
}

/** The name of the first parameter of a function (`t` in `(t) => [...]`). */
function functionParameter(fn: SyntaxNode): string | undefined {
  const single: SyntaxNode | null = fn.childForFieldName('parameter');
  if (single !== null) {
    return single.text;
  }
  const parameters: SyntaxNode | null = fn.childForFieldName('parameters');
  const first: SyntaxNode | undefined = parameters?.namedChildren[0];
  if (first === undefined) {
    return undefined;
  }
  const pattern: SyntaxNode | null = first.childForFieldName('pattern');
  return (pattern ?? first).text;
}

function argumentsOf(call: SyntaxNode): SyntaxNode[] {
  const argumentsNode: SyntaxNode | null = call.childForFieldName('arguments');
  if (argumentsNode === null) {
    return [];
  }
  // A tagged template (sql`now()`) has the template itself as its arguments node.
  if (argumentsNode.type === 'template_string') {
    return [argumentsNode];
  }
  return argumentsNode.namedChildren.filter(
    (child: SyntaxNode) => child.type !== 'comment'
  );
}

/**
 * Splits `a('x').b().c()` into the first call and the calls chained on it. Returns undefined when the
 * expression is not a call chain at all.
 */
function unwindChain(node: SyntaxNode): CallChain | undefined {
  const links: CallLink[] = [];
  let current: SyntaxNode = stripWrappers(node);
  for (;;) {
    if (current.type !== 'call_expression') {
      return undefined;
    }
    const functionNode: SyntaxNode | null =
      current.childForFieldName('function');
    if (functionNode === null) {
      return undefined;
    }
    const args: SyntaxNode[] = argumentsOf(current);
    if (functionNode.type === 'member_expression') {
      const objectNode: SyntaxNode | null =
        functionNode.childForFieldName('object');
      const propertyNode: SyntaxNode | null =
        functionNode.childForFieldName('property');
      const inner: SyntaxNode | null =
        objectNode === null ? null : stripWrappers(objectNode);
      if (
        inner !== null &&
        propertyNode !== null &&
        inner.type === 'call_expression' &&
        !isTaggedTemplate(inner)
      ) {
        links.unshift({ name: propertyNode.text, args });
        current = inner;
        continue;
      }
    }
    return {
      baseCallee: functionNode.text.replace(/\s+/g, ''),
      baseArgs: args,
      links,
    };
  }
}

function isTaggedTemplate(call: SyntaxNode): boolean {
  return call.childForFieldName('arguments')?.type === 'template_string';
}

/** The text of an `sql\`...\`` template (or `sql.raw('...')`), or undefined when it is not one. */
function sqlText(
  node: SyntaxNode
): { text: string; isDynamic: boolean } | undefined {
  const call: SyntaxNode = stripWrappers(node);
  if (call.type !== 'call_expression') {
    return undefined;
  }
  const functionNode: SyntaxNode | null = call.childForFieldName('function');
  const argumentsNode: SyntaxNode | null = call.childForFieldName('arguments');
  if (functionNode === null || argumentsNode === null) {
    return undefined;
  }
  if (functionNode.text === 'sql' && argumentsNode.type === 'template_string') {
    return {
      text: argumentsNode.text.slice(1, -1),
      isDynamic: argumentsNode.namedChildren.some(
        (child: SyntaxNode) => child.type === 'template_substitution'
      ),
    };
  }
  if (functionNode.text === 'sql.raw') {
    const value: TsValue | undefined = argumentsOf(call)
      .map(evaluateNode)
      .find((candidate: TsValue) => candidate.kind === 'string');
    if (value !== undefined && value.kind === 'string') {
      return { text: value.value, isDynamic: false };
    }
  }
  return undefined;
}

/** Reads `table.column` (with chained `.desc()`, `.asc()`, `.op('...')`) as a column reference. */
function parseColumnRef(node: SyntaxNode): ColumnRef | undefined {
  let current: SyntaxNode = stripWrappers(node);
  let sort: 'asc' | 'desc' | undefined;
  let ops: string | undefined;
  while (current.type === 'call_expression') {
    const functionNode: SyntaxNode | null =
      current.childForFieldName('function');
    if (functionNode === null || functionNode.type !== 'member_expression') {
      return undefined;
    }
    const propertyName: string =
      functionNode.childForFieldName('property')?.text ?? '';
    if (propertyName === 'desc' || propertyName === 'asc') {
      sort = propertyName;
    } else if (propertyName === 'op') {
      const operatorClass: TsValue | undefined = argumentsOf(current)
        .map(evaluateNode)
        .find((candidate: TsValue) => candidate.kind === 'string');
      if (operatorClass !== undefined && operatorClass.kind === 'string') {
        ops = `raw("${operatorClass.value}")`;
      }
    }
    const objectNode: SyntaxNode | null =
      functionNode.childForFieldName('object');
    if (objectNode === null) {
      return undefined;
    }
    current = stripWrappers(objectNode);
  }
  if (current.type !== 'member_expression') {
    return undefined;
  }
  const parts: string[] = current.text.replace(/\s+/g, '').split('.');
  const key: string | undefined = parts[parts.length - 1];
  if (parts.length < 2 || key === undefined || key === '') {
    return undefined;
  }
  return {
    owner: parts[parts.length - 2],
    key,
    ...(sort === undefined ? {} : { sort }),
    ...(ops === undefined ? {} : { ops }),
  };
}

function columnRefs(node: SyntaxNode | undefined): ColumnRef[] | undefined {
  if (node === undefined) {
    return undefined;
  }
  const array: SyntaxNode = stripWrappers(node);
  if (array.type !== 'array') {
    return undefined;
  }
  const refs: ColumnRef[] = [];
  for (const item of array.namedChildren) {
    if (item.type === 'comment') {
      continue;
    }
    const ref: ColumnRef | undefined = parseColumnRef(item);
    if (ref === undefined) {
      return undefined;
    }
    refs.push(ref);
  }
  return refs;
}

/** The value node of a property of an object literal, or undefined. */
function objectProperty(
  node: SyntaxNode | undefined,
  name: string
): SyntaxNode | undefined {
  if (node === undefined) {
    return undefined;
  }
  const object: SyntaxNode = stripWrappers(node);
  if (object.type !== 'object') {
    return undefined;
  }
  for (const child of object.namedChildren) {
    if (child.type !== 'pair') {
      continue;
    }
    const keyNode: SyntaxNode | null = child.childForFieldName('key');
    if (keyNode !== null && unquote(keyNode.text) === name) {
      return child.childForFieldName('value') ?? undefined;
    }
  }
  return undefined;
}

function unquote(text: string): string {
  return /^(["'`]).*\1$/s.test(text) ? text.slice(1, -1) : text;
}

function stringValue(node: SyntaxNode | undefined): string | undefined {
  if (node === undefined) {
    return undefined;
  }
  const value: TsValue = evaluateNode(node);
  return value.kind === 'string' ? value.value : undefined;
}

function objectValue(node: SyntaxNode | undefined): TsObject | undefined {
  if (node === undefined) {
    return undefined;
  }
  const value: TsValue = evaluateNode(node);
  return value.kind === 'object' ? value : undefined;
}

function stringOption(
  options: TsObject | undefined,
  key: string
): string | undefined {
  const value: TsValue | undefined = options?.properties[key];
  return value !== undefined && value.kind === 'string'
    ? value.value
    : undefined;
}

function numberOption(
  options: TsObject | undefined,
  key: string
): number | undefined {
  const value: TsValue | undefined = options?.properties[key];
  return value !== undefined && value.kind === 'number'
    ? value.value
    : undefined;
}

function boolOption(
  options: TsObject | undefined,
  key: string
): boolean | undefined {
  const value: TsValue | undefined = options?.properties[key];
  return value !== undefined && value.kind === 'bool' ? value.value : undefined;
}

/** Local import aliases resolved to the imported name (`table` -> `pgTable`). */
function canonicalName(file: FileInfo, name: string): string {
  return file.aliases.get(name) ?? name;
}

/** Splits a callee into an optional object (`mySchema`) and a name (`table`), resolving import aliases. */
function parseCallee(
  file: FileInfo,
  callee: string
): { object: string | undefined; name: string } {
  const parts: string[] = callee.split('.');
  const name: string = canonicalName(file, parts[parts.length - 1] ?? callee);
  if (parts.length === 1) {
    return { object: undefined, name };
  }
  const object: string = parts.slice(0, -1).join('.');
  return file.namespaces.has(object)
    ? { object: undefined, name }
    : { object: canonicalName(file, object), name };
}

/** Evaluates a value that may be written inline or kept in a top-level constant. */
function resolveValue(node: SyntaxNode, project: Project): TsValue {
  const value: TsValue = evaluateNode(node);
  if (value.kind === 'name') {
    const helper: SyntaxNode | undefined = project.helpers.get(value.value);
    if (helper !== undefined) {
      return evaluateNode(helper);
    }
  }
  return value;
}

// ---------------------------------------------------------------------------
// Declarations (first pass over every file)
// ---------------------------------------------------------------------------

/** Template literal `prefix_${name}` as a function of the name, or undefined when it has another shape. */
function creatorTransform(
  node: SyntaxNode | undefined
): ((name: string) => string) | undefined {
  if (node === undefined) {
    return undefined;
  }
  const fn: SyntaxNode = stripWrappers(node);
  if (!isFunctionNode(fn)) {
    return undefined;
  }
  const parameter: string | undefined = functionParameter(fn);
  const result: SyntaxNode | undefined = functionResult(fn);
  if (parameter === undefined || result === undefined) {
    return undefined;
  }
  if (result.type === 'identifier' && result.text === parameter) {
    return (name: string): string => name;
  }
  if (result.type !== 'template_string') {
    return undefined;
  }
  let prefix: string = '';
  let suffix: string = '';
  let seenName: boolean = false;
  for (const part of result.namedChildren) {
    if (part.type === 'template_substitution') {
      const expression: SyntaxNode | undefined = part.namedChildren[0];
      if (
        seenName ||
        expression === undefined ||
        expression.text !== parameter
      ) {
        return undefined;
      }
      seenName = true;
    } else if (seenName) {
      suffix += part.text;
    } else {
      prefix += part.text;
    }
  }
  return seenName
    ? (name: string): string => `${prefix}${name}${suffix}`
    : undefined;
}

/** Sorts the top-level declarations into schemas, creators, enums, tables, relations and helpers. */
function collectDeclarations(project: Project): void {
  // Schemas, creators and helpers first: tables and enums can refer to them from any file.
  for (const declarator of project.declarators) {
    const node: SyntaxNode = stripWrappers(declarator.node);
    if (node.type === 'object') {
      project.helpers.set(declarator.name, node);
      continue;
    }
    if (node.type === 'array') {
      project.helpers.set(declarator.name, node);
      continue;
    }
    if (isFunctionNode(node)) {
      const result: SyntaxNode | undefined = functionResult(node);
      if (result !== undefined) {
        project.helpers.set(declarator.name, result);
      }
      continue;
    }
    const chain: CallChain | undefined = unwindChain(node);
    if (chain === undefined) {
      continue;
    }
    const callee = parseCallee(declarator.file, chain.baseCallee);
    if (callee.object !== undefined) {
      continue;
    }
    const schemaDialect: Dialect | undefined = SCHEMA_FUNCTIONS[callee.name];
    if (schemaDialect !== undefined) {
      const dbName: string | undefined = stringValue(chain.baseArgs[0]);
      if (dbName === undefined) {
        project.warnings.push(
          `${declarator.file.label}: the schema "${declarator.name}" has a name that is not a string literal; its tables were read without a schema.`
        );
      } else {
        project.schemas.set(declarator.name, {
          dbName,
          dialect: schemaDialect,
        });
      }
      continue;
    }
    const creatorDialect: Dialect | undefined = TABLE_CREATORS[callee.name];
    if (creatorDialect !== undefined) {
      const transform: ((name: string) => string) | undefined =
        creatorTransform(chain.baseArgs[0]);
      if (transform === undefined) {
        project.warnings.push(
          `${declarator.file.label}: the table creator "${declarator.name}" does not map names with a plain template such as \`app_\${name}\`; ` +
            `the tables made with it keep the name they were given, without the prefix.`
        );
      }
      project.creators.set(declarator.name, {
        dialect: creatorDialect,
        transform,
      });
    }
  }

  for (const declarator of project.declarators) {
    const chain: CallChain | undefined = unwindChain(declarator.node);
    if (chain === undefined) {
      continue;
    }
    collectCall(project, declarator, chain);
  }
}

function collectCall(
  project: Project,
  declarator: Declarator,
  chain: CallChain
): void {
  const file: FileInfo = declarator.file;
  const callee = parseCallee(file, chain.baseCallee);
  const schema: SchemaDecl | undefined =
    callee.object === undefined
      ? undefined
      : project.schemas.get(callee.object);
  const creator: CreatorDecl | undefined =
    callee.object === undefined ? project.creators.get(callee.name) : undefined;

  const tableDialect: Dialect | undefined =
    callee.object === undefined
      ? TABLE_FUNCTIONS[callee.name]
      : callee.name === 'table' && schema !== undefined
        ? schema.dialect
        : undefined;
  if (tableDialect !== undefined || creator !== undefined) {
    const dialect: Dialect | undefined = tableDialect ?? creator?.dialect;
    if (dialect === undefined) {
      return;
    }
    for (const link of chain.links) {
      project.warnings.push(
        `${file.label}: table "${declarator.name}": the chained .${link.name}() call is not represented in the shared model and was ignored.`
      );
    }
    project.tables.push({
      file,
      varName: declarator.name,
      dialect,
      ...(schema === undefined ? {} : { schema: schema.dbName }),
      ...(creator === undefined ? {} : { creator }),
      nameNode: chain.baseArgs[0],
      columnsNode: chain.baseArgs[1],
      extraNode: chain.baseArgs[2],
    });
    return;
  }

  if (callee.object === undefined && callee.name === 'pgEnum') {
    registerEnum(project, declarator, chain, undefined);
    return;
  }
  if (callee.name === 'enum' && schema !== undefined) {
    registerEnum(project, declarator, chain, schema.dbName);
    return;
  }
  if (callee.object === undefined && callee.name === 'relations') {
    registerRelations(project, declarator, chain);
    return;
  }
  if (callee.object === undefined && callee.name === 'defineRelations') {
    project.warnings.push(
      `${file.label}: defineRelations (Drizzle relational queries v2) is not supported; "${declarator.name}" was skipped, so the relation names and reverse sides it defines are not read. ` +
        `Foreign keys declared with .references() or foreignKey() are still read.`
    );
    return;
  }
  const unsupportedDialect: string | undefined =
    callee.object === undefined
      ? UNSUPPORTED_DIALECT_TABLES[callee.name]
      : undefined;
  if (unsupportedDialect !== undefined) {
    project.warnings.push(
      `${file.label}: table "${declarator.name}" uses the ${unsupportedDialect} dialect (${callee.name}), which is not supported; it was skipped.`
    );
    return;
  }
  const unsupportedDefinition: string | undefined =
    callee.object === undefined
      ? UNSUPPORTED_DEFINITIONS[callee.name]
      : undefined;
  if (unsupportedDefinition !== undefined) {
    project.warnings.push(
      `${file.label}: "${declarator.name}" defines ${unsupportedDefinition} (${callee.name}), which the shared model cannot represent; it was skipped.`
    );
  }
  if (
    callee.object !== undefined &&
    schema !== undefined &&
    UNSUPPORTED_DEFINITIONS[`pg${toPascalCase(callee.name)}`] !== undefined
  ) {
    project.warnings.push(
      `${file.label}: "${declarator.name}" defines ${UNSUPPORTED_DEFINITIONS[`pg${toPascalCase(callee.name)}`] ?? 'objects'} (${callee.object}.${callee.name}), which the shared model cannot represent; it was skipped.`
    );
  }
}

/** Derives an enum member name from a stored value, for example "in-progress" -> "IN_PROGRESS". */
function enumMemberName(value: string): string {
  const snake: string = toSnakeCase(value).toUpperCase();
  if (snake === '') {
    return 'EMPTY';
  }
  return /^[0-9]/.test(snake) ? `V_${snake}` : snake;
}

function enumValuesOf(values: string[], unique: boolean = true): IrEnumValue[] {
  const used: Set<string> = new Set();
  return values.map((dbValue: string): IrEnumValue => {
    let name: string = enumMemberName(dbValue);
    while (unique && used.has(name)) {
      name = `${name}_`;
    }
    used.add(name);
    return { name, dbValue };
  });
}

function registerEnum(
  project: Project,
  declarator: Declarator,
  chain: CallChain,
  schema: string | undefined
): void {
  const label: string = declarator.file.label;
  const dbName: string | undefined = stringValue(chain.baseArgs[0]);
  const valuesNode: SyntaxNode | undefined = chain.baseArgs[1];
  const values: TsValue | undefined =
    valuesNode === undefined ? undefined : resolveValue(valuesNode, project);
  if (
    dbName === undefined ||
    values === undefined ||
    values.kind !== 'array' ||
    !values.items.every((item: TsValue) => item.kind === 'string')
  ) {
    project.warnings.push(
      `${label}: the enum "${declarator.name}" is not defined with a string literal name and a literal list of strings; it was skipped.`
    );
    return;
  }
  const name: string = toPascalCase(declarator.name);
  project.enums.set(declarator.name, {
    varName: declarator.name,
    ir: {
      name,
      values: enumValuesOf(
        values.items.flatMap((item: TsValue) =>
          item.kind === 'string' ? [item.value] : []
        )
      ),
      ...(dbName === name ? {} : { dbName }),
      ...(schema === undefined ? {} : { schema }),
    },
  });
}

function registerRelations(
  project: Project,
  declarator: Declarator,
  chain: CallChain
): void {
  const file: FileInfo = declarator.file;
  const tableRef: SyntaxNode | undefined = chain.baseArgs[0];
  const callback: SyntaxNode | undefined =
    chain.baseArgs[1] === undefined
      ? undefined
      : stripWrappers(chain.baseArgs[1]);
  if (tableRef === undefined || callback === undefined) {
    return;
  }
  const tableVar: string = canonicalName(
    file,
    tableRef.text.split('.').pop() ?? tableRef.text
  );
  const result: SyntaxNode | undefined = isFunctionNode(callback)
    ? functionResult(callback)
    : undefined;
  if (result === undefined || result.type !== 'object') {
    project.warnings.push(
      `${file.label}: the relations of "${tableVar}" are not defined by a callback returning an object literal; they were skipped.`
    );
    return;
  }
  const entries: RelationEntry[] = [];
  for (const child of result.namedChildren) {
    if (child.type === 'comment') {
      continue;
    }
    if (child.type !== 'pair') {
      project.warnings.push(
        `${file.label}: the relations of "${tableVar}" contain a spread or computed entry (${child.text}); it was skipped.`
      );
      continue;
    }
    const keyNode: SyntaxNode | null = child.childForFieldName('key');
    const valueNode: SyntaxNode | null = child.childForFieldName('value');
    const call: CallChain | undefined =
      valueNode === null ? undefined : unwindChain(valueNode);
    const kindName: string | undefined = call?.baseCallee.split('.').pop();
    if (
      keyNode === null ||
      call === undefined ||
      (kindName !== 'one' && kindName !== 'many')
    ) {
      project.warnings.push(
        `${file.label}: the relation "${tableVar}.${keyNode === null ? '?' : unquote(keyNode.text)}" is not written as one(...) or many(...); it was skipped.`
      );
      continue;
    }
    const targetNode: SyntaxNode | undefined = call.baseArgs[0];
    const config: SyntaxNode | undefined = call.baseArgs[1];
    if (targetNode === undefined) {
      continue;
    }
    const relationName: string | undefined = stringValue(
      objectProperty(config, 'relationName')
    );
    entries.push({
      key: unquote(keyNode.text),
      kind: kindName,
      targetVar: canonicalName(
        file,
        targetNode.text.split('.').pop() ?? targetNode.text
      ),
      fields: columnRefs(objectProperty(config, 'fields')),
      references: columnRefs(objectProperty(config, 'references')),
      relationName,
    });
  }
  project.relationDefs.push({ file, tableVar, entries });
}

// ---------------------------------------------------------------------------
// Tables and columns
// ---------------------------------------------------------------------------

function tableLabel(table: RawTable | TableDecl): string {
  const decl: TableDecl = 'decl' in table ? table.decl : table;
  return `${decl.file.label}: table "${decl.varName}"`;
}

/** A model name from the variable a table is assigned to: `blogPosts` -> `BlogPost`. */
function modelNameOf(varName: string): string {
  return toPascalCase(singularize(toSnakeCase(varName)));
}

function buildSchema(project: Project, options: DrizzleParseOptions): IrSchema {
  const warnings: string[] = project.warnings;
  const tables: RawTable[] = [];
  const usedModelNames: Set<string> = new Set();
  const usedVars: Set<string> = new Set();

  for (const decl of project.tables) {
    if (usedVars.has(decl.varName)) {
      warnings.push(
        `${tableLabel(decl)}: another table with the same variable name was already read; this one was skipped.`
      );
      continue;
    }
    const tableName: string | undefined = stringValue(decl.nameNode);
    if (tableName === undefined) {
      warnings.push(
        `${tableLabel(decl)}: the table name is not a string literal, so the table was skipped.`
      );
      continue;
    }
    usedVars.add(decl.varName);
    let modelName: string = modelNameOf(decl.varName);
    if (usedModelNames.has(modelName)) {
      modelName = toPascalCase(decl.varName);
    }
    if (usedModelNames.has(modelName)) {
      warnings.push(
        `${tableLabel(decl)}: the model name "${modelName}" is already taken by another table; this table was skipped.`
      );
      continue;
    }
    usedModelNames.add(modelName);
    let dbName: string = tableName;
    if (decl.creator !== undefined && decl.creator.transform !== undefined) {
      dbName = decl.creator.transform(tableName);
    }
    tables.push({
      decl,
      modelName,
      dbName,
      columns: [],
      foreignKeys: [],
      indexes: [],
      primaryKey: undefined,
    });
  }

  const enums: IrEnum[] = [...project.enums.values()].map(
    (declared: EnumDecl): IrEnum => declared.ir
  );
  for (const table of tables) {
    buildColumns(table, project, enums);
    parseExtras(table, project);
  }
  const byVar: Map<string, RawTable> = new Map(
    tables.map((table: RawTable) => [table.decl.varName, table])
  );

  const owners: OwnerRelation[] = collectOwners(tables, byVar, project);
  linkReverseSides(tables, byVar, owners, project);

  const models: IrModel[] = tables.map((table: RawTable) =>
    finalizeModel(table, byVar, owners, warnings, options)
  );
  addStubModels(models, warnings, options);
  return { models, enums, warnings };
}

/** Reads the `{ key: column, ... }` object of a table, expanding spreads of shared column sets. */
function columnEntries(
  node: SyntaxNode | undefined,
  table: RawTable,
  project: Project,
  seen: Set<string> = new Set()
): { key: string; value: SyntaxNode }[] {
  if (node === undefined) {
    return [];
  }
  const object: SyntaxNode = stripWrappers(node);
  const label: string = tableLabel(table);
  if (object.type === 'identifier') {
    const helper: SyntaxNode | undefined = project.helpers.get(object.text);
    if (helper === undefined || seen.has(object.text)) {
      project.warnings.push(
        `${label}: the columns are not an object literal (${object.text}); the table has no columns.`
      );
      return [];
    }
    return columnEntries(
      helper,
      table,
      project,
      new Set([...seen, object.text])
    );
  }
  if (object.type !== 'object') {
    project.warnings.push(
      `${label}: the columns are not an object literal; the table has no columns.`
    );
    return [];
  }
  const entries: { key: string; value: SyntaxNode }[] = [];
  for (const child of object.namedChildren) {
    if (child.type === 'comment') {
      continue;
    }
    if (child.type === 'pair') {
      const keyNode: SyntaxNode | null = child.childForFieldName('key');
      const valueNode: SyntaxNode | null = child.childForFieldName('value');
      if (keyNode !== null && valueNode !== null) {
        entries.push({ key: unquote(keyNode.text), value: valueNode });
      }
    } else if (child.type === 'spread_element') {
      const spread: SyntaxNode | undefined = child.namedChildren[0];
      const target: SyntaxNode | undefined =
        spread === undefined
          ? undefined
          : spread.type === 'call_expression'
            ? (spread.childForFieldName('function') ?? undefined)
            : spread;
      const name: string | undefined = target?.text;
      const helper: SyntaxNode | undefined =
        name === undefined ? undefined : project.helpers.get(name);
      if (name === undefined || helper === undefined || seen.has(name)) {
        project.warnings.push(
          `${label}: the spread "${child.text}" cannot be resolved to a column object defined in the input; its columns were skipped.`
        );
        continue;
      }
      entries.push(
        ...columnEntries(helper, table, project, new Set([...seen, name]))
      );
    } else {
      project.warnings.push(
        `${label}: the entry "${child.text}" is not a "name: column" pair and was skipped.`
      );
    }
  }
  return entries;
}

function buildColumns(
  table: RawTable,
  project: Project,
  enums: IrEnum[]
): void {
  const seenKeys: Set<string> = new Set();
  for (const entry of columnEntries(table.decl.columnsNode, table, project)) {
    if (seenKeys.has(entry.key)) {
      continue;
    }
    seenKeys.add(entry.key);
    const column: RawColumn | undefined = buildColumn(
      table,
      entry.key,
      entry.value,
      project,
      enums
    );
    if (column !== undefined) {
      table.columns.push(column);
    }
  }
}

/** Resolves the builder call of a column, following one level of user-written column helpers. */
function resolveChain(
  table: RawTable,
  node: SyntaxNode,
  project: Project
): { chain: CallChain; fallbackName: string | undefined } | undefined {
  const chain: CallChain | undefined = unwindChain(node);
  if (chain === undefined) {
    return undefined;
  }
  const callee = parseCallee(table.decl.file, chain.baseCallee);
  const helper: SyntaxNode | undefined =
    callee.object === undefined ? project.helpers.get(callee.name) : undefined;
  if (helper === undefined || BUILTIN_BUILDERS.has(callee.name)) {
    return { chain, fallbackName: undefined };
  }
  const inner: CallChain | undefined = unwindChain(helper);
  if (inner === undefined) {
    return { chain, fallbackName: undefined };
  }
  return {
    chain: {
      baseCallee: inner.baseCallee,
      baseArgs: inner.baseArgs,
      links: [...inner.links, ...chain.links],
    },
    fallbackName: stringValue(chain.baseArgs[0]),
  };
}

/** Every builder name this parser knows; a user helper never shadows one of them. */
const BUILTIN_BUILDERS: ReadonlySet<string> = new Set([
  ...Object.keys(PG_SIMPLE_TYPES),
  ...Object.keys(PG_UNSUPPORTED_TYPES),
  ...Object.keys(MYSQL_SIMPLE_TYPES),
  ...Object.keys(SQLITE_SIMPLE_TYPES),
  'varchar',
  'char',
  'numeric',
  'decimal',
  'binary',
  'varbinary',
  'mysqlEnum',
  'integer',
  'text',
  'blob',
]);

function buildColumn(
  table: RawTable,
  key: string,
  node: SyntaxNode,
  project: Project,
  enums: IrEnum[]
): RawColumn | undefined {
  const label: string = `${tableLabel(table)}, column "${key}"`;
  const resolved = resolveChain(table, node, project);
  if (resolved === undefined) {
    project.warnings.push(
      `${label}: the column is not written as a builder call such as integer('name'); it was skipped.`
    );
    return undefined;
  }
  const { chain, fallbackName } = resolved;
  const callee = parseCallee(table.decl.file, chain.baseCallee);
  const builder: string = callee.name;

  // The first argument is the column name; builders also accept the options object first.
  const firstArg: SyntaxNode | undefined = chain.baseArgs[0];
  const firstValue: TsValue | undefined =
    firstArg === undefined ? undefined : evaluateNode(firstArg);
  const config: TsObject | undefined =
    firstValue?.kind === 'object' ? firstValue : objectValue(chain.baseArgs[1]);
  let columnName: string = key;
  if (firstValue?.kind === 'string') {
    columnName = firstValue.value;
  } else if (firstValue !== undefined && firstValue.kind !== 'object') {
    if (fallbackName !== undefined) {
      columnName = fallbackName;
    } else {
      project.warnings.push(
        `${label}: the column name is not a string literal; the property name "${key}" was used.`
      );
    }
  }

  const field: IrField = {
    name: key,
    columnName,
    type: 'string',
    isPrimaryKey: false,
    isUnique: false,
    isNullable: true,
    isAutoUpdated: false,
  };
  let isNotNull: boolean = false;

  const enumDecl: EnumDecl | undefined =
    callee.object === undefined ? project.enums.get(builder) : undefined;
  let resolvedType: ResolvedType | undefined;
  if (enumDecl !== undefined) {
    resolvedType = { type: 'string' };
    field.enumName = enumDecl.ir.name;
  } else if (builder === 'mysqlEnum' && table.decl.dialect === 'mysql') {
    const values: TsValue | undefined =
      chain.baseArgs[1] === undefined
        ? undefined
        : resolveValue(chain.baseArgs[1], project);
    if (values?.kind === 'array') {
      const inline: IrEnum = inlineEnum(
        table,
        key,
        values.items,
        enums,
        project
      );
      field.enumName = inline.name;
      resolvedType = { type: 'string' };
    } else {
      project.warnings.push(
        `${label}: mysqlEnum is not given a literal list of values; the column was read as a string.`
      );
      resolvedType = { type: 'string' };
    }
  } else {
    resolvedType = resolveType(table.decl.dialect, builder, config);
    if (resolvedType === undefined) {
      resolvedType = {
        type: 'unsupported',
        unsupportedType: builder,
        note:
          `the column builder "${chain.baseCallee}" is not a ${dialectName(table.decl.dialect)} column type this parser knows; ` +
          `the column was kept as an unsupported "${builder}" column.`,
      };
    }
  }
  field.type = resolvedType.type;
  if (resolvedType.maxLength !== undefined) {
    field.maxLength = resolvedType.maxLength;
  }
  if (resolvedType.maxDigits !== undefined) {
    field.maxDigits = resolvedType.maxDigits;
  }
  if (resolvedType.decimalPlaces !== undefined) {
    field.decimalPlaces = resolvedType.decimalPlaces;
  }
  if (resolvedType.unsupportedType !== undefined) {
    field.unsupportedType = resolvedType.unsupportedType;
    if (enumDecl === undefined && resolvedType.note === undefined) {
      project.warnings.push(
        `${label}: the column type "${resolvedType.unsupportedType}" has no equivalent in the shared model and was kept as an unsupported column.`
      );
    }
  }
  if (resolvedType.note !== undefined) {
    project.warnings.push(`${label}: ${resolvedType.note}`);
  }
  if (resolvedType.autoIncrement === true) {
    field.default = { kind: 'autoIncrement' };
  }
  if (resolvedType.notNull === true) {
    isNotNull = true;
  }
  if (resolvedType.unique === true) {
    field.isUnique = true;
  }
  if (config !== undefined && boolOption(config, 'unsigned') === true) {
    project.warnings.push(
      `${label}: unsigned integers are not represented in the shared model; the column was read as a signed integer.`
    );
  }

  let defaultNode: SyntaxNode | undefined;
  let hasDefaultFn: boolean = false;
  for (const link of chain.links) {
    switch (link.name) {
      case 'notNull':
        isNotNull = true;
        break;
      case 'primaryKey': {
        field.isPrimaryKey = true;
        isNotNull = true;
        if (boolOption(objectValue(link.args[0]), 'autoIncrement') === true) {
          field.default = { kind: 'autoIncrement' };
        }
        break;
      }
      case 'autoincrement':
      case 'generatedAlwaysAsIdentity':
      case 'generatedByDefaultAsIdentity':
        field.default = { kind: 'autoIncrement' };
        break;
      case 'unique': {
        field.isUnique = true;
        const constraintName: string | undefined = stringValue(link.args[0]);
        if (constraintName !== undefined) {
          field.uniqueName = constraintName;
        }
        if (link.args.some((arg: SyntaxNode) => arg.type === 'object')) {
          project.warnings.push(
            `${label}: the unique constraint options (NULLS NOT DISTINCT) are not represented in the shared model and were ignored.`
          );
        }
        break;
      }
      case 'default':
        defaultNode = link.args[0];
        break;
      case 'defaultNow':
        field.default = { kind: 'now' };
        break;
      case 'defaultRandom':
        field.default = { kind: 'uuid' };
        break;
      case '$defaultFn':
      case '$default':
        hasDefaultFn = true;
        applyClientDefault(field, link.args[0], label, project);
        break;
      case '$onUpdate':
      case '$onUpdateFn':
        applyOnUpdate(field, label, project);
        break;
      case 'onUpdateNow':
        field.isAutoUpdated = true;
        break;
      case 'array':
        field.arrayDepth = (field.arrayDepth ?? 0) + 1;
        break;
      case 'references':
        addReference(table, key, link.args, label, project);
        break;
      case 'generatedAlwaysAs':
        applyGenerated(field, link.args, label, project);
        break;
      case '$type':
      case 'notnull':
        break;
      default:
        project.warnings.push(
          `${label}: the .${link.name}() modifier is not represented in the shared model and was ignored.`
        );
        break;
    }
  }
  if (defaultNode !== undefined) {
    if (hasDefaultFn) {
      project.warnings.push(
        `${label}: both .default() and a client-side default are set; the .default() value is used.`
      );
    }
    const converted: IrDefault | undefined = convertDefault(
      defaultNode,
      field,
      label,
      project,
      enumDecl?.ir ?? enums.find((item: IrEnum) => item.name === field.enumName)
    );
    if (converted !== undefined) {
      field.default = converted;
    }
  }
  if (field.isAutoUpdated && field.default?.kind === 'now') {
    // An auto-updated column is stamped on every write, so the other readers do not carry a separate "now" default.
    delete field.default;
  }
  if (field.isPrimaryKey) {
    isNotNull = true;
    field.isUnique = false;
  }
  field.isNullable = !isNotNull;
  return { key, field, isNotNull };
}

function dialectName(dialect: Dialect): string {
  switch (dialect) {
    case 'pg':
      return 'PostgreSQL';
    case 'mysql':
      return 'MySQL';
    default:
      return 'SQLite';
  }
}

/** A MySQL `mysqlEnum` column becomes an enum named after the table and the column. */
function inlineEnum(
  table: RawTable,
  key: string,
  items: TsValue[],
  enums: IrEnum[],
  project: Project
): IrEnum {
  const values: string[] = items.flatMap((item: TsValue) =>
    item.kind === 'string' ? [item.value] : []
  );
  if (values.length !== items.length) {
    project.warnings.push(
      `${tableLabel(table)}, column "${key}": some mysqlEnum values are not string literals and were skipped.`
    );
  }
  let name: string = `${table.modelName}${toPascalCase(key)}`;
  while (enums.some((item: IrEnum) => item.name === name)) {
    name = `${name}Enum`;
  }
  const created: IrEnum = {
    name,
    values: enumValuesOf(values),
    ...(table.decl.schema === undefined ? {} : { schema: table.decl.schema }),
  };
  enums.push(created);
  return created;
}

/** Maps a column builder to an IR type. Returns undefined for a builder the dialect does not have. */
function resolveType(
  dialect: Dialect,
  builder: string,
  config: TsObject | undefined
): ResolvedType | undefined {
  const length: number | undefined = numberOption(config, 'length');
  const precision: number | undefined = numberOption(config, 'precision');
  const scale: number | undefined = numberOption(config, 'scale');
  const mode: string | undefined = stringOption(config, 'mode');

  const decimalType = (): ResolvedType => ({
    type: 'decimal',
    ...(precision === undefined ? {} : { maxDigits: precision }),
    ...(scale === undefined ? {} : { decimalPlaces: scale }),
  });

  if (dialect === 'pg') {
    const simple: IrScalarType | undefined = PG_SIMPLE_TYPES[builder];
    if (simple !== undefined) {
      const serial: boolean = PG_SERIAL_TYPES.has(builder);
      return {
        type: simple,
        ...(serial ? { autoIncrement: true, notNull: true } : {}),
      };
    }
    switch (builder) {
      case 'varchar':
        return {
          type: 'string',
          ...(length === undefined ? {} : { maxLength: length }),
        };
      case 'char':
        return { type: 'string', maxLength: length ?? 1 };
      case 'numeric':
      case 'decimal':
        return decimalType();
      default:
        break;
    }
    const unsupported: string | undefined = PG_UNSUPPORTED_TYPES[builder];
    if (unsupported !== undefined) {
      const dimensions: number | undefined = numberOption(config, 'dimensions');
      return {
        type: 'unsupported',
        unsupportedType:
          dimensions === undefined
            ? unsupported
            : `${unsupported}(${dimensions})`,
      };
    }
    return undefined;
  }

  if (dialect === 'mysql') {
    const simple: IrScalarType | undefined = MYSQL_SIMPLE_TYPES[builder];
    if (simple !== undefined) {
      return { type: simple };
    }
    switch (builder) {
      case 'serial':
        return {
          type: 'bigInt',
          autoIncrement: true,
          notNull: true,
          unique: true,
        };
      case 'varchar':
      case 'char':
        return {
          type: 'string',
          ...(length === undefined
            ? builder === 'char'
              ? { maxLength: 1 }
              : {}
            : { maxLength: length }),
        };
      case 'decimal':
      case 'numeric':
        return decimalType();
      case 'binary':
      case 'varbinary':
        return {
          type: 'bytes',
          ...(length === undefined ? {} : { maxLength: length }),
        };
      default:
        return undefined;
    }
  }

  // SQLite
  const simple: IrScalarType | undefined = SQLITE_SIMPLE_TYPES[builder];
  if (simple !== undefined) {
    return { type: simple };
  }
  switch (builder) {
    case 'integer':
      if (mode === 'timestamp' || mode === 'timestamp_ms') {
        return {
          type: 'dateTime',
          note: `integer({ mode: '${mode}' }) stores Unix time as an integer; it was read as a date-time column.`,
        };
      }
      return { type: mode === 'boolean' ? 'boolean' : 'int' };
    case 'text':
      if (mode === 'json') {
        return { type: 'json' };
      }
      return length === undefined
        ? { type: 'text' }
        : { type: 'string', maxLength: length };
    case 'blob':
      if (mode === 'json') {
        return { type: 'json' };
      }
      return { type: mode === 'bigint' ? 'bigInt' : 'bytes' };
    case 'numeric':
      return { type: 'decimal' };
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

function describeNode(node: SyntaxNode | undefined): string {
  const text: string = (node?.text ?? '').replace(/\s+/g, ' ');
  return text.length > 60 ? `${text.slice(0, 57)}...` : text;
}

function applyClientDefault(
  field: IrField,
  fn: SyntaxNode | undefined,
  label: string,
  project: Project
): void {
  const source: string = describeNode(fn);
  const result: SyntaxNode | undefined =
    fn === undefined || !isFunctionNode(stripWrappers(fn))
      ? undefined
      : functionResult(stripWrappers(fn));
  const body: string = result?.text ?? '';
  if (
    field.type === 'uuid' &&
    /randomUUID\s*\(|\buuid(v4)?\s*\(|\bv4\s*\(/i.test(body)
  ) {
    field.default = { kind: 'uuid' };
    project.warnings.push(
      `${label}: $defaultFn(${source}) is generated in application code; it was read as a generated UUID default, which the target generates instead.`
    );
    return;
  }
  if (
    (field.type === 'dateTime' || field.type === 'date') &&
    /^(new Date\(\)|Date\.now\(\)|sql`now\(\)`)$/.test(body)
  ) {
    field.default = { kind: 'now' };
    project.warnings.push(
      `${label}: $defaultFn(${source}) is evaluated in application code; it was read as a "now" default, which the target applies in the database instead.`
    );
    return;
  }
  project.warnings.push(
    `${label}: $defaultFn(${source}) is a client-side default computed in application code; it has no equivalent in the shared model and was dropped.`
  );
}

function applyOnUpdate(field: IrField, label: string, project: Project): void {
  if (
    field.type === 'dateTime' ||
    field.type === 'date' ||
    field.type === 'time'
  ) {
    field.isAutoUpdated = true;
    return;
  }
  project.warnings.push(
    `${label}: $onUpdate on a ${field.type} column is not represented in the shared model (only date-time columns refresh on update); it was ignored.`
  );
}

function applyGenerated(
  field: IrField,
  args: SyntaxNode[],
  label: string,
  project: Project
): void {
  const expressionNode: SyntaxNode | undefined = args[0];
  const expression: SyntaxNode | undefined =
    expressionNode === undefined
      ? undefined
      : isFunctionNode(stripWrappers(expressionNode))
        ? functionResult(stripWrappers(expressionNode))
        : expressionNode;
  const sql: { text: string; isDynamic: boolean } | undefined =
    expression === undefined ? undefined : sqlText(expression);
  if (sql === undefined) {
    project.warnings.push(
      `${label}: the generated column expression could not be read statically; the column was read as an ordinary column.`
    );
    return;
  }
  const mode: string | undefined = stringOption(objectValue(args[1]), 'mode');
  field.generated = {
    expression: sql.text.trim(),
    isStored: mode !== 'virtual',
  };
  if (sql.isDynamic) {
    project.warnings.push(
      `${label}: the generated column expression refers to other columns through \${...}; the expression text is kept as written.`
    );
  }
}

function jsonText(value: TsValue): string | undefined {
  switch (value.kind) {
    case 'string':
      return JSON.stringify(value.value);
    case 'number':
      return String(value.value);
    case 'bool':
      return value.value ? 'true' : 'false';
    case 'null':
      return 'null';
    case 'array': {
      const items: (string | undefined)[] = value.items.map(jsonText);
      return items.every((item: string | undefined) => item !== undefined)
        ? `[${items.join(',')}]`
        : undefined;
    }
    case 'object': {
      const parts: string[] = [];
      for (const [key, item] of Object.entries(value.properties)) {
        const text: string | undefined = jsonText(item);
        if (text === undefined) {
          return undefined;
        }
        parts.push(`${JSON.stringify(key)}:${text}`);
      }
      return `{${parts.join(',')}}`;
    }
    default:
      return undefined;
  }
}

function convertDefault(
  node: SyntaxNode,
  field: IrField,
  label: string,
  project: Project,
  enumeration: IrEnum | undefined
): IrDefault | undefined {
  const sql: { text: string; isDynamic: boolean } | undefined = sqlText(node);
  if (sql !== undefined) {
    if (sql.isDynamic) {
      project.warnings.push(
        `${label}: the default sql\`${sql.text}\` refers to other values through \${...} and cannot be read statically; it was dropped.`
      );
      return undefined;
    }
    return convertSqlDefault(sql.text, field, enumeration);
  }
  const value: TsValue = resolveValue(stripWrappers(node), project);
  switch (value.kind) {
    case 'null':
      return undefined;
    case 'bool':
      return { kind: 'literal', value: value.value };
    case 'number':
      return { kind: 'literal', value: value.value };
    case 'string': {
      const member: IrEnumValue | undefined = enumeration?.values.find(
        (candidate: IrEnumValue) => candidate.dbValue === value.value
      );
      if (member !== undefined) {
        return { kind: 'enumValue', value: member.name };
      }
      if (
        /^-?\d+(\.\d+)?$/.test(value.value) &&
        (field.type === 'decimal' ||
          field.type === 'int' ||
          field.type === 'bigInt' ||
          field.type === 'float')
      ) {
        return { kind: 'literal', value: Number(value.value) };
      }
      return { kind: 'literal', value: value.value };
    }
    case 'object':
    case 'array': {
      const text: string | undefined = jsonText(value);
      if (
        text !== undefined &&
        field.type === 'json' &&
        field.arrayDepth === undefined
      ) {
        return { kind: 'literal', value: text };
      }
      break;
    }
    case 'other': {
      const bigint: RegExpExecArray | null = /^(-?\d+)n$/.exec(value.text);
      if (bigint !== null) {
        return { kind: 'literal', value: Number(bigint[1]) };
      }
      break;
    }
    default:
      break;
  }
  project.warnings.push(
    `${label}: the default value (${describeNode(node)}) cannot be evaluated statically and was dropped.`
  );
  return undefined;
}

function convertSqlDefault(
  sql: string,
  field: IrField,
  enumeration: IrEnum | undefined
): IrDefault | undefined {
  const trimmed: string = sql.trim();
  if (NOW_SQL.test(trimmed)) {
    return { kind: 'now' };
  }
  if (UUID_SQL.test(trimmed)) {
    return { kind: 'uuid' };
  }
  if (/^null$/i.test(trimmed)) {
    return undefined;
  }
  if (/^(true|false)$/i.test(trimmed)) {
    return { kind: 'literal', value: trimmed.toLowerCase() === 'true' };
  }
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
    return field.type === 'string' || field.type === 'text'
      ? { kind: 'literal', value: trimmed }
      : { kind: 'literal', value: Number(trimmed) };
  }
  const quoted: RegExpExecArray | null = QUOTED_SQL.exec(trimmed);
  if (quoted !== null) {
    const text: string = (quoted[1] ?? '').replace(/''/g, "'");
    const member: IrEnumValue | undefined = enumeration?.values.find(
      (candidate: IrEnumValue) => candidate.dbValue === text
    );
    if (member !== undefined) {
      return { kind: 'enumValue', value: member.name };
    }
    return { kind: 'literal', value: text };
  }
  return { kind: 'dbExpression', expression: trimmed };
}

// ---------------------------------------------------------------------------
// Foreign keys, indexes and keys declared in the table callback
// ---------------------------------------------------------------------------

function mapAction(
  value: string | undefined,
  what: string,
  label: string,
  project: Project
): IrOnDelete | undefined {
  if (value === undefined) {
    return undefined;
  }
  const mapped: IrOnDelete | undefined = ON_ACTION_MAP[value.toLowerCase()];
  if (mapped === undefined) {
    project.warnings.push(
      `${label}: ${what} "${value}" has no equivalent and was ignored.`
    );
  }
  return mapped;
}

/** Reads `.references(() => users.id, { onDelete: 'cascade' })` into a foreign key on the column. */
function addReference(
  table: RawTable,
  key: string,
  args: SyntaxNode[],
  label: string,
  project: Project
): void {
  const targetFn: SyntaxNode | undefined =
    args[0] === undefined ? undefined : stripWrappers(args[0]);
  const target: SyntaxNode | undefined =
    targetFn === undefined || !isFunctionNode(targetFn)
      ? undefined
      : functionResult(targetFn);
  const ref: ColumnRef | undefined =
    target === undefined ? undefined : parseColumnRef(target);
  if (ref === undefined || ref.owner === undefined) {
    project.warnings.push(
      `${label}: the target of .references(${describeNode(args[0])}) is not written as () => table.column; the foreign key was skipped.`
    );
    return;
  }
  const config: TsObject | undefined = objectValue(args[1]);
  table.foreignKeys.push({
    columns: [key],
    targetVar: canonicalName(table.decl.file, ref.owner),
    targetColumns: [ref.key],
    onDelete: mapAction(
      stringOption(config, 'onDelete'),
      'onDelete',
      label,
      project
    ),
    onUpdate: mapAction(
      stringOption(config, 'onUpdate'),
      'onUpdate',
      label,
      project
    ),
    name: undefined,
  });
}

function parseExtras(table: RawTable, project: Project): void {
  const extra: SyntaxNode | undefined =
    table.decl.extraNode === undefined
      ? undefined
      : stripWrappers(table.decl.extraNode);
  if (extra === undefined) {
    return;
  }
  const label: string = tableLabel(table);
  const result: SyntaxNode | undefined = isFunctionNode(extra)
    ? functionResult(extra)
    : undefined;
  const container: SyntaxNode | undefined =
    result === undefined ? undefined : stripWrappers(result);
  if (
    container === undefined ||
    (container.type !== 'array' && container.type !== 'object')
  ) {
    project.warnings.push(
      `${label}: the indexes and constraints are not returned from the table callback as an array or object literal; they were skipped.`
    );
    return;
  }
  const items: SyntaxNode[] = [];
  for (const child of container.namedChildren) {
    if (child.type === 'comment') {
      continue;
    }
    if (container.type === 'array') {
      items.push(child);
    } else if (child.type === 'pair') {
      const value: SyntaxNode | null = child.childForFieldName('value');
      if (value !== null) {
        items.push(value);
      }
    } else {
      project.warnings.push(
        `${label}: the table callback entry "${describeNode(child)}" is a spread or computed entry and was skipped.`
      );
    }
  }
  for (const item of items) {
    parseExtraItem(table, item, project);
  }
}

function localKeys(
  table: RawTable,
  refs: ColumnRef[],
  label: string,
  project: Project
): string[] | undefined {
  const known: Set<string> = new Set(
    table.columns.map((column: RawColumn) => column.key)
  );
  const missing: string[] = refs
    .filter((ref: ColumnRef) => !known.has(ref.key))
    .map((ref: ColumnRef) => ref.key);
  if (missing.length > 0) {
    project.warnings.push(
      `${label}: refers to "${missing.join('", "')}", which is not a column of the table; it was skipped.`
    );
    return undefined;
  }
  return refs.map((ref: ColumnRef) => ref.key);
}

function parseExtraItem(
  table: RawTable,
  item: SyntaxNode,
  project: Project
): void {
  const label: string = tableLabel(table);
  const chain: CallChain | undefined = unwindChain(item);
  if (chain === undefined) {
    project.warnings.push(
      `${label}: the table callback entry "${describeNode(item)}" is not a call such as index('name').on(...) and was skipped.`
    );
    return;
  }
  const callee = parseCallee(table.decl.file, chain.baseCallee);
  switch (callee.name) {
    case 'index':
    case 'uniqueIndex':
    case 'unique':
      parseIndex(table, callee.name, chain, project);
      return;
    case 'primaryKey': {
      const options: SyntaxNode | undefined = chain.baseArgs[0];
      const refs: ColumnRef[] | undefined = columnRefs(
        objectProperty(options, 'columns')
      );
      const keys: string[] | undefined =
        refs === undefined
          ? undefined
          : localKeys(table, refs, `${label}: the primary key`, project);
      if (keys !== undefined) {
        table.primaryKey = {
          columns: keys,
          name: stringValue(objectProperty(options, 'name')),
        };
      } else if (refs === undefined) {
        project.warnings.push(
          `${label}: the primary key columns are not a literal list of table.column references; the primary key was skipped.`
        );
      }
      return;
    }
    case 'foreignKey': {
      const options: SyntaxNode | undefined = chain.baseArgs[0];
      const local: ColumnRef[] | undefined = columnRefs(
        objectProperty(options, 'columns')
      );
      const foreign: ColumnRef[] | undefined = columnRefs(
        objectProperty(options, 'foreignColumns')
      );
      const keys: string[] | undefined =
        local === undefined
          ? undefined
          : localKeys(table, local, `${label}: the foreign key`, project);
      const targetOwner: string | undefined = foreign?.[0]?.owner;
      if (
        foreign === undefined ||
        foreign.length !== local?.length ||
        targetOwner === undefined ||
        foreign.some((ref: ColumnRef) => ref.owner !== targetOwner)
      ) {
        if (keys !== undefined || local === undefined) {
          project.warnings.push(
            `${label}: a foreignKey() is not written with literal columns and foreignColumns lists of the same table; it was skipped.`
          );
        }
        return;
      }
      if (keys === undefined) {
        return;
      }
      const lookup = (name: string): string | undefined =>
        stringValue(chain.links.find((link) => link.name === name)?.args[0]);
      table.foreignKeys.push({
        columns: keys,
        targetVar: canonicalName(table.decl.file, targetOwner),
        targetColumns: foreign.map((ref: ColumnRef) => ref.key),
        onDelete: mapAction(lookup('onDelete'), 'onDelete', label, project),
        onUpdate: mapAction(lookup('onUpdate'), 'onUpdate', label, project),
        name: stringValue(objectProperty(options, 'name')),
      });
      return;
    }
    case 'check':
      project.warnings.push(
        `${label}: the check constraint ${describeNode(chain.baseArgs[0])} has no equivalent in the shared model and was dropped.`
      );
      return;
    default:
      project.warnings.push(
        `${label}: the table callback entry ${callee.name}(...) is not represented in the shared model and was skipped.`
      );
  }
}

function parseIndex(
  table: RawTable,
  kind: string,
  chain: CallChain,
  project: Project
): void {
  const label: string = tableLabel(table);
  const name: string | undefined = stringValue(chain.baseArgs[0]);
  const display: string = name === undefined ? '' : ` "${name}"`;
  const what: string = `the ${kind === 'index' ? 'index' : 'unique constraint'}${display}`;
  let refs: ColumnRef[] | undefined;
  let method: string | undefined;
  let isPartial: boolean = false;
  for (const link of chain.links) {
    if (link.name === 'on' || link.name === 'using') {
      const columnArgs: SyntaxNode[] =
        link.name === 'using' ? link.args.slice(1) : link.args;
      if (link.name === 'using') {
        method = stringValue(link.args[0]);
      }
      const parsed: (ColumnRef | undefined)[] = columnArgs.map(parseColumnRef);
      if (parsed.some((ref: ColumnRef | undefined) => ref === undefined)) {
        project.warnings.push(
          `${label}: ${what} is built on an expression (${describeNode(columnArgs[0])}) rather than plain columns; it was skipped.`
        );
        return;
      }
      refs = parsed.flatMap((ref: ColumnRef | undefined) =>
        ref === undefined ? [] : [ref]
      );
    } else if (link.name === 'where') {
      isPartial = true;
    } else if (link.name === 'nullsNotDistinct') {
      project.warnings.push(
        `${label}: ${what} is NULLS NOT DISTINCT, which is not represented in the shared model and was ignored.`
      );
    }
  }
  if (refs === undefined || refs.length === 0) {
    project.warnings.push(
      `${label}: ${what} has no .on(...) columns; it was skipped.`
    );
    return;
  }
  const keys: string[] | undefined = localKeys(
    table,
    refs,
    `${label}: ${what}`,
    project
  );
  if (keys === undefined) {
    return;
  }
  const isUnique: boolean = kind !== 'index';
  if (isPartial) {
    if (isUnique) {
      project.warnings.push(
        `${label}: ${what} has a where condition (a partial index), which the shared model cannot represent; it was dropped because a full unique index would reject rows the source accepts.`
      );
      return;
    }
    project.warnings.push(
      `${label}: ${what} has a where condition (a partial index), which is not preserved; it was read as a full index.`
    );
  }
  let indexMethod: string | undefined;
  if (method !== undefined) {
    indexMethod = INDEX_METHODS[method.toLowerCase()];
    if (indexMethod === undefined) {
      project.warnings.push(
        `${label}: ${what} uses the "${method}" access method, which is not represented in the shared model; the default method is used.`
      );
    }
  }
  const fieldOptions: Record<string, IrIndexFieldOptions> = {};
  for (const ref of refs) {
    if (ref.sort !== undefined || ref.ops !== undefined) {
      fieldOptions[ref.key] = {
        ...(ref.sort === undefined ? {} : { sort: ref.sort }),
        ...(ref.ops === undefined ? {} : { ops: ref.ops }),
      };
    }
  }
  table.indexes.push({
    columns: keys,
    isUnique,
    name,
    method: indexMethod,
    fieldOptions,
    isPartial,
  });
}

// ---------------------------------------------------------------------------
// Relations
// ---------------------------------------------------------------------------

function sameList(first: string[], second: string[]): boolean {
  return (
    first.length === second.length &&
    first.every((item: string, index: number) => item === second[index])
  );
}

/** The relation name for a foreign key declared only through `.references()`: `authorId` -> `author`. */
function derivedRelationName(
  table: RawTable,
  foreignKey: RawForeignKey
): string {
  const key: string = foreignKey.columns[0] ?? '';
  const stripped: string = key.replace(/(_id|Id|ID)$/, '');
  const taken: Set<string> = new Set(
    table.columns
      .filter((column: RawColumn) => !foreignKey.columns.includes(column.key))
      .map((column: RawColumn) => column.key)
  );
  if (foreignKey.columns.length > 1) {
    return toCamelCase(modelNameOf(foreignKey.targetVar));
  }
  return stripped === '' || stripped === key || taken.has(stripped)
    ? key
    : stripped;
}

/**
 * Builds the owning side of every relation: a foreign key, named by the `one(...)` entry of the
 * table's `relations()` when there is one, otherwise by the column it is declared on.
 */
function collectOwners(
  tables: RawTable[],
  byVar: Map<string, RawTable>,
  project: Project
): OwnerRelation[] {
  const owners: OwnerRelation[] = [];
  for (const table of tables) {
    const label: string = tableLabel(table);
    const used: Set<RawForeignKey> = new Set();
    const defs: RelationDef[] = project.relationDefs.filter(
      (def: RelationDef) => def.tableVar === table.decl.varName
    );
    for (const def of defs) {
      for (const entry of def.entries) {
        if (entry.kind !== 'one' || entry.fields === undefined) {
          continue;
        }
        const keys: string[] = entry.fields.map((ref: ColumnRef) => ref.key);
        const references: string[] = (entry.references ?? []).map(
          (ref: ColumnRef) => ref.key
        );
        const missing: string[] = keys.filter(
          (key: string) =>
            !table.columns.some((column: RawColumn) => column.key === key)
        );
        if (keys.length === 0 || missing.length > 0) {
          project.warnings.push(
            `${label}: the relation "${entry.key}" uses fields (${keys.join(', ')}) that are not columns of the table; it was skipped.`
          );
          continue;
        }
        let foreignKey: RawForeignKey | undefined = table.foreignKeys.find(
          (candidate: RawForeignKey) =>
            !used.has(candidate) &&
            sameList(candidate.columns, keys) &&
            candidate.targetVar === entry.targetVar
        );
        if (foreignKey === undefined) {
          // A relation without a database constraint (Drizzle relations are an application-level feature).
          foreignKey = {
            columns: keys,
            targetVar: entry.targetVar,
            targetColumns:
              references.length > 0
                ? references
                : primaryKeyOf(byVar.get(entry.targetVar)),
            onDelete: undefined,
            onUpdate: undefined,
            name: undefined,
          };
          table.foreignKeys.push(foreignKey);
        }
        used.add(foreignKey);
        owners.push({
          table,
          name: entry.key,
          foreignKey,
          relationName: entry.relationName,
          reverseName: undefined,
          isDeclared: true,
        });
      }
    }
    for (const foreignKey of table.foreignKeys) {
      if (!used.has(foreignKey)) {
        owners.push({
          table,
          name: derivedRelationName(table, foreignKey),
          foreignKey,
          relationName: undefined,
          reverseName: undefined,
          isDeclared: false,
        });
      }
    }
  }
  return owners;
}

function primaryKeyOf(table: RawTable | undefined): string[] {
  if (table === undefined) {
    return ['id'];
  }
  if (table.primaryKey !== undefined) {
    return table.primaryKey.columns;
  }
  const keys: string[] = table.columns
    .filter((column: RawColumn) => column.field.isPrimaryKey)
    .map((column: RawColumn) => column.key);
  return keys.length > 0 ? keys : ['id'];
}

/** Links the `many(...)` and field-less `one(...)` entries to the owning side they mirror. */
function linkReverseSides(
  tables: RawTable[],
  byVar: Map<string, RawTable>,
  owners: OwnerRelation[],
  project: Project
): void {
  for (const def of project.relationDefs) {
    const table: RawTable | undefined = byVar.get(def.tableVar);
    if (table === undefined) {
      project.warnings.push(
        `${def.file.label}: relations() are defined for "${def.tableVar}", which is not a table in the input; they were skipped.`
      );
      continue;
    }
    for (const entry of def.entries) {
      if (entry.kind === 'one' && entry.fields !== undefined) {
        continue;
      }
      const location: string = `${tableLabel(table)}: the relation "${entry.key}"`;
      const candidates: OwnerRelation[] = owners.filter(
        (owner: OwnerRelation) =>
          owner.table.decl.varName === entry.targetVar &&
          owner.foreignKey.targetVar === table.decl.varName &&
          owner.reverseName === undefined &&
          (entry.relationName === undefined ||
            owner.relationName === entry.relationName)
      );
      if (!byVar.has(entry.targetVar)) {
        project.warnings.push(
          `${location} points at "${entry.targetVar}", which is not a table in the input; the reverse side was skipped.`
        );
        continue;
      }
      // Drizzle only knows the relations written as one(...); a bare foreign key is a fallback.
      const declared: OwnerRelation[] = candidates.filter(
        (owner: OwnerRelation) => owner.isDeclared
      );
      const matching: OwnerRelation[] =
        declared.length > 0 ? declared : candidates;
      const owner: OwnerRelation | undefined = matching[0];
      if (owner === undefined) {
        project.warnings.push(
          `${location} has no matching one(${table.decl.varName}, { fields, references }) on "${entry.targetVar}"` +
            `${entry.relationName === undefined ? '' : ` with relationName "${entry.relationName}"`}; the reverse side was not linked.`
        );
        continue;
      }
      if (matching.length > 1) {
        project.warnings.push(
          `${location} matches several relations of "${entry.targetVar}" (${matching.map((candidate: OwnerRelation) => candidate.name).join(', ')}); add a relationName to tell them apart. It was linked to "${owner.name}".`
        );
      }
      owner.reverseName = entry.key;
    }
  }
}

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

function finalizeModel(
  table: RawTable,
  byVar: Map<string, RawTable>,
  owners: OwnerRelation[],
  warnings: string[],
  options: DrizzleParseOptions
): IrModel {
  const label: string = tableLabel(table);
  const fields: IrField[] = table.columns.map(
    (column: RawColumn) => column.field
  );
  const fieldByKey: Map<string, IrField> = new Map(
    fields.map((field: IrField) => [field.name, field])
  );
  const tableOwners: OwnerRelation[] = owners.filter(
    (owner: OwnerRelation) => owner.table === table
  );

  // Which keys form the primary key, and which single columns are unique.
  const pkKeys: string[] =
    table.primaryKey !== undefined
      ? table.primaryKey.columns
      : fields
          .filter((field: IrField) => field.isPrimaryKey)
          .map((field: IrField) => field.name);
  const uniqueKeys: Set<string> = new Set(
    fields
      .filter((field: IrField) => field.isUnique)
      .map((field: IrField) => field.name)
  );
  for (const index of table.indexes) {
    const only: string | undefined = index.columns[0];
    if (
      index.isUnique &&
      index.columns.length === 1 &&
      only !== undefined &&
      !index.isPartial
    ) {
      uniqueKeys.add(only);
    }
  }

  const relations: IrRelation[] = [];
  const compositeForeignKeys: IrCompositeForeignKey[] = [];
  /** Column key -> the relation that replaced it. */
  const renamed: Map<string, string> = new Map();
  const mergedKeys: Set<string> = new Set();
  const takenNames: Set<string> = new Set();

  for (const owner of tableOwners) {
    const foreignKey: RawForeignKey = owner.foreignKey;
    const target: RawTable | undefined = byVar.get(foreignKey.targetVar);
    const targetModel: string =
      target === undefined
        ? modelNameOf(foreignKey.targetVar)
        : target.modelName;
    const targetPk: string[] = primaryKeyOf(target);
    const columns: RawColumn[] = foreignKey.columns.flatMap((key: string) => {
      const column: RawColumn | undefined = table.columns.find(
        (candidate: RawColumn) => candidate.key === key
      );
      return column === undefined ? [] : [column];
    });
    if (foreignKey.columns.length > 1) {
      const references: string[] = foreignKey.targetColumns;
      compositeForeignKeys.push({
        name: owner.name,
        targetModel,
        fields: foreignKey.columns,
        references,
        kind: 'foreignKey',
        isNullable: columns.some((column: RawColumn) => !column.isNotNull),
        onDelete: foreignKey.onDelete ?? 'noAction',
        ...(foreignKey.onUpdate === undefined
          ? {}
          : { onUpdate: foreignKey.onUpdate }),
        ...(owner.reverseName === undefined
          ? {}
          : { relatedName: owner.reverseName }),
        ...(foreignKey.name === undefined
          ? {}
          : { constraintName: foreignKey.name }),
      });
      continue;
    }
    const backing: RawColumn | undefined = columns[0];
    if (backing === undefined || mergedKeys.has(backing.key)) {
      warnings.push(
        `${label}: the foreign key on "${foreignKey.columns.join(', ')}" ${backing === undefined ? 'refers to a column that does not exist' : 'repeats a column that already has a foreign key'}; it was skipped.`
      );
      continue;
    }
    let name: string = owner.name;
    if (takenNames.has(name)) {
      name = backing.key;
    }
    takenNames.add(name);
    mergedKeys.add(backing.key);
    renamed.set(backing.key, name);
    const isPrimary: boolean = pkKeys.length === 1 && pkKeys[0] === backing.key;
    const referenced: string | undefined = foreignKey.targetColumns[0];
    const isOneToOne: boolean = isPrimary || uniqueKeys.has(backing.key);
    relations.push({
      name,
      kind: isOneToOne ? 'oneToOne' : 'foreignKey',
      targetModel,
      columnName: backing.field.columnName,
      isNullable: !backing.isNotNull && !isPrimary,
      onDelete: foreignKey.onDelete ?? 'noAction',
      ...(owner.reverseName === undefined
        ? {}
        : { relatedName: owner.reverseName }),
      ...(referenced === undefined ||
      target === undefined ||
      sameList(targetPk, [referenced])
        ? {}
        : { toField: referenced }),
      ...(isPrimary ? { isPrimaryKey: true } : {}),
      ...(foreignKey.onUpdate === undefined
        ? {}
        : { onUpdate: foreignKey.onUpdate }),
      ...(foreignKey.name === undefined
        ? {}
        : { constraintName: foreignKey.name }),
    });
  }
  const finalFields: IrField[] = fields.filter(
    (field: IrField) => !mergedKeys.has(field.name)
  );

  // Indexes, with columns that became relations renamed.
  const known: Set<string> = new Set([
    ...finalFields.map((field: IrField) => field.name),
    ...relations.map((relation: IrRelation) => relation.name),
  ]);
  const indexes: IrIndex[] = [];
  for (const raw of table.indexes) {
    const names: string[] = raw.columns.map(
      (key: string) => renamed.get(key) ?? key
    );
    if (names.some((name: string) => !known.has(name))) {
      continue;
    }
    const single: IrField | undefined =
      names.length === 1
        ? finalFields.find((field: IrField) => field.name === names[0])
        : undefined;
    const onRelation: boolean =
      names.length === 1 &&
      relations.some((relation: IrRelation) => relation.name === names[0]);
    if (raw.isUnique && onRelation && !raw.isPartial) {
      // A unique foreign key is a one-to-one relation, which already implies the constraint.
      continue;
    }
    if (
      raw.isUnique &&
      raw.name === undefined &&
      single !== undefined &&
      !single.isPrimaryKey &&
      !raw.isPartial
    ) {
      single.isUnique = true;
      continue;
    }
    const fieldOptions: Record<string, IrIndexFieldOptions> = {};
    for (const [key, entry] of Object.entries(raw.fieldOptions)) {
      fieldOptions[renamed.get(key) ?? key] = entry;
    }
    indexes.push({
      fields: names,
      isUnique: raw.isUnique,
      ...(raw.name === undefined ? {} : { name: raw.name }),
      ...(raw.method === undefined ? {} : { method: raw.method }),
      ...(Object.keys(fieldOptions).length === 0 ? {} : { fieldOptions }),
    });
  }

  // Primary key.
  let compositePrimaryKey: string[] | undefined;
  if (pkKeys.length === 0) {
    warnings.push(
      `${label}: the table has no primary key; most ORMs need one, so add .primaryKey() to a column or a primaryKey({ columns: [...] }) constraint.`
    );
  } else if (pkKeys.length > 1) {
    compositePrimaryKey = pkKeys.map((key: string) => renamed.get(key) ?? key);
    for (const key of pkKeys) {
      const field: IrField | undefined = fieldByKey.get(key);
      if (field !== undefined) {
        field.isPrimaryKey = false;
        field.isUnique = false;
      }
    }
  } else if (table.primaryKey !== undefined) {
    const field: IrField | undefined = finalFields.find(
      (candidate: IrField) => candidate.name === table.primaryKey?.columns[0]
    );
    if (field !== undefined) {
      field.isPrimaryKey = true;
      field.isNullable = false;
    }
  }
  for (const relation of relations) {
    if (compositePrimaryKey !== undefined) {
      delete relation.isPrimaryKey;
    }
  }

  return {
    name: table.modelName,
    tableName: table.dbName,
    appLabel: options.appLabel,
    fields: finalFields,
    relations,
    indexes,
    ...(compositePrimaryKey === undefined ? {} : { compositePrimaryKey }),
    ...(table.primaryKey?.name !== undefined &&
    compositePrimaryKey !== undefined
      ? { primaryKeyName: table.primaryKey.name }
      : {}),
    ...(table.decl.schema === undefined ? {} : { schema: table.decl.schema }),
    ...(compositeForeignKeys.length === 0 ? {} : { compositeForeignKeys }),
  };
}

function addStubModels(
  models: IrModel[],
  warnings: string[],
  options: DrizzleParseOptions
): void {
  const known: Set<string> = new Set(
    models.map((model: IrModel) => model.name)
  );
  const stubs: IrModel[] = [];
  const targets: { from: string; via: string; target: string }[] = [];
  for (const model of models) {
    for (const relation of model.relations) {
      targets.push({
        from: model.name,
        via: relation.name,
        target: relation.targetModel,
      });
    }
    for (const composite of model.compositeForeignKeys ?? []) {
      targets.push({
        from: model.name,
        via: composite.name,
        target: composite.targetModel,
      });
    }
  }
  for (const { from, via, target } of targets) {
    if (known.has(target)) {
      continue;
    }
    known.add(target);
    stubs.push({
      name: target,
      tableName: toSnakeCase(target),
      appLabel: options.appLabel,
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
      `${from}.${via} references "${target}", which is not a table in the input. ` +
        `A stub model with an auto-increment id was generated; replace it with the real definition.`
    );
  }
  models.push(...stubs);
}
