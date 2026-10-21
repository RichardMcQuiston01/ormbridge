import { singularize, toPascalCase, toSnakeCase } from '../naming.js';
import {
  addColumn,
  addConstraint,
  addIndex,
  changeColumn,
  createTable,
  defaultConstraintName,
  defaultIndexName,
  dropTable,
  findColumn,
  findTable,
  newState,
  removeColumn,
  removeConstraint,
  removeIndex,
  renameColumn,
  renameTable,
  type ConstraintKind,
  type ReplayState,
  type StateConstraint,
  type StateIndex,
  type StateTable,
} from './sequelizeMigrationState.js';
import {
  argsOf,
  boolOf,
  indexFieldOf,
  objectEntries,
  readAttribute,
  resolveNode,
  stringOf,
  stripWrappers,
  valueOf,
  type Ctx,
} from './sequelizeCollect.js';
import type {
  FileInfo,
  ModelOptions,
  Project,
  RawAttribute,
  RawIndex,
  RawIndexField,
  RawModel,
} from './sequelizeModel.js';
import {
  evaluateNode,
  type SyntaxNode,
  type TsValue,
} from './typescriptSyntax.js';

/**
 * Replays `sequelize-cli` migrations: the `up` function of each file runs, in file-name order, against the
 * schema the earlier files built. Nothing is run; the `queryInterface` calls are read from the syntax tree.
 * The result is one model per table that is left, with the columns the migrations gave it, so the reader
 * that turns models into the shared schema also turns migrations into one.
 */

// ---------------------------------------------------------------------------
// Finding the migration of a file
// ---------------------------------------------------------------------------

const FUNCTION_NODES: ReadonlySet<string> = new Set([
  'arrow_function',
  'function_expression',
  'function',
  'function_declaration',
  'generator_function',
  'generator_function_declaration',
  'method_definition',
]);

/** The `up` function of a migration file, with the names it gives the query interface. */
interface UpFunction {
  node: SyntaxNode;
  /** Names that stand for the query interface inside `up`. */
  queryInterfaces: string[];
}

/** The function-like declarations of a file by name, so `up: addTables` and `await addTables(queryInterface)` work. */
function declaredFunctions(file: FileInfo): Map<string, SyntaxNode> {
  const found: Map<string, SyntaxNode> = new Map();
  for (const node of file.root.namedChildren) {
    const declaration: SyntaxNode =
      node.type === 'export_statement'
        ? (node.namedChildren.find(
            (child: SyntaxNode) =>
              child.type === 'function_declaration' ||
              child.type === 'lexical_declaration'
          ) ?? node)
        : node;
    if (declaration.type === 'function_declaration') {
      const name: SyntaxNode | null = declaration.childForFieldName('name');
      if (name !== null) {
        found.set(name.text, declaration);
      }
    }
  }
  for (const [name, node] of file.consts) {
    const value: SyntaxNode = stripWrappers(node);
    if (FUNCTION_NODES.has(value.type) && !found.has(name)) {
      found.set(name, value);
    }
  }
  return found;
}

function asFunction(
  node: SyntaxNode | undefined,
  functions: Map<string, SyntaxNode>
): SyntaxNode | undefined {
  if (node === undefined) {
    return undefined;
  }
  const stripped: SyntaxNode = stripWrappers(node);
  if (FUNCTION_NODES.has(stripped.type)) {
    return stripped;
  }
  return stripped.type === 'identifier'
    ? functions.get(stripped.text)
    : undefined;
}

/** The name a parameter binds: `queryInterface`, or `queryInterface` from `{ context: queryInterface }`. */
function parameterName(parameter: SyntaxNode | undefined): string | undefined {
  if (parameter === undefined) {
    return undefined;
  }
  const pattern: SyntaxNode =
    parameter.childForFieldName('pattern') ?? parameter;
  if (pattern.type === 'identifier') {
    return pattern.text;
  }
  if (pattern.type === 'object_pattern') {
    for (const member of pattern.namedChildren) {
      if (member.type === 'shorthand_property_identifier_pattern') {
        if (member.text === 'context') {
          return 'context';
        }
      } else if (member.type === 'pair_pattern') {
        const key: SyntaxNode | null = member.childForFieldName('key');
        const value: SyntaxNode | null = member.childForFieldName('value');
        if (key !== null && key.text === 'context' && value !== null) {
          return value.type === 'identifier' ? value.text : undefined;
        }
      }
    }
  }
  return undefined;
}

/** The parameters of a function-like node, in order. */
function parametersOf(node: SyntaxNode): SyntaxNode[] {
  const parameters: SyntaxNode | null =
    node.childForFieldName('parameters') ?? node.childForFieldName('parameter');
  if (parameters === null) {
    return [];
  }
  return parameters.type === 'identifier'
    ? [parameters]
    : parameters.namedChildren;
}

function upFromObject(
  object: SyntaxNode,
  functions: Map<string, SyntaxNode>,
  ctx: Ctx
): SyntaxNode | undefined {
  return asFunction(objectEntries(object, ctx).entries.get('up'), functions);
}

/** Finds `up` in `module.exports = { up }`, `exports.up = ...`, `export async function up` and `export default { up }`. */
function findUp(file: FileInfo, ctx: Ctx): UpFunction | undefined {
  const functions: Map<string, SyntaxNode> = declaredFunctions(file);
  let node: SyntaxNode | undefined;
  for (const statement of file.root.namedChildren) {
    if (statement.type === 'expression_statement') {
      const assignment: SyntaxNode | undefined = statement.namedChildren[0];
      if (
        assignment === undefined ||
        assignment.type !== 'assignment_expression'
      ) {
        continue;
      }
      const left: string = (
        assignment.childForFieldName('left')?.text ?? ''
      ).replace(/\s+/g, '');
      const right: SyntaxNode | null = assignment.childForFieldName('right');
      if (right === null) {
        continue;
      }
      if (/^(?:module\.)?exports\.up$/.test(left)) {
        node = asFunction(right, functions);
      } else if (
        left === 'module.exports' ||
        left === 'exports.default' ||
        left === 'module.exports.default'
      ) {
        const value: SyntaxNode = resolveNode(right, ctx);
        node =
          value.type === 'object'
            ? upFromObject(value, functions, ctx)
            : undefined;
      }
    } else if (statement.type === 'export_statement') {
      const declaration: SyntaxNode | undefined = statement.namedChildren.find(
        (child: SyntaxNode) =>
          child.type === 'function_declaration' ||
          child.type === 'lexical_declaration'
      );
      if (declaration?.type === 'function_declaration') {
        if (declaration.childForFieldName('name')?.text === 'up') {
          node = declaration;
        }
      } else if (declaration?.type === 'lexical_declaration') {
        for (const declarator of declaration.namedChildren) {
          if (declarator.childForFieldName('name')?.text === 'up') {
            node = asFunction(
              declarator.childForFieldName('value') ?? undefined,
              functions
            );
          }
        }
      } else if (/^export\s+default\b/.test(statement.text)) {
        const value: SyntaxNode | null = statement.childForFieldName('value');
        const resolved: SyntaxNode | undefined =
          value === null ? undefined : resolveNode(value, ctx);
        node =
          resolved?.type === 'object'
            ? upFromObject(resolved, functions, ctx)
            : undefined;
      }
    }
    if (node !== undefined) {
      break;
    }
  }
  // `module.exports = { up, down }` and `export { up, down }` name functions declared elsewhere in the file.
  node ??= functions.get('up');
  if (node === undefined) {
    return undefined;
  }
  const first: string | undefined =
    parameterName(parametersOf(node)[0]) ?? 'queryInterface';
  return { node, queryInterfaces: [first] };
}

/**
 * True when the file is a migration: it has an `up` function that works on a query interface. The text test
 * keeps ordinary models (which never call `queryInterface` or `createTable`) out of the tree walk.
 */
export function isMigrationFile(file: FileInfo, ctx: Ctx): boolean {
  if (!/queryInterface|createTable|addColumn|context\b/.test(file.root.text)) {
    return false;
  }
  return findUp(file, ctx) !== undefined;
}

// ---------------------------------------------------------------------------
// The calls of one migration
// ---------------------------------------------------------------------------

/** How many times something happened and where it first did, for the summarizing warnings. */
interface Tally {
  count: number;
  first: string;
}

function tally(counter: Tally | undefined, where: string): Tally {
  return counter === undefined
    ? { count: 1, first: where }
    : { count: counter.count + 1, first: counter.first };
}

interface Run {
  state: ReplayState;
  project: Project;
  /** Raw SQL, row data and unsupported calls, reported once after the last migration. */
  raw: Tally | undefined;
  rawTables: Set<string>;
  data: Tally | undefined;
  unsupported: Map<string, Tally>;
  /** Tables the calls inside a control statement touched, for its warning. */
  touched: string[];
}

interface Scope {
  file: FileInfo;
  ctx: Ctx;
  queryInterfaces: ReadonlySet<string>;
  functions: Map<string, SyntaxNode>;
  /** Functions being read, so a function that calls itself ends. */
  active: ReadonlySet<SyntaxNode>;
}

/** Queries that only look at the schema or at data and change nothing the shared schema holds. */
const READ_ONLY_CALLS: ReadonlySet<string> = new Set([
  'describeTable',
  'showAllTables',
  'tableExists',
  'showIndex',
  'showConstraint',
  'getForeignKeysForTables',
  'getForeignKeyReferencesForTable',
  'quoteIdentifier',
  'quoteIdentifiers',
  'quoteTable',
  'escape',
  'select',
  'rawSelect',
  'createSchema',
  'dropSchema',
  'showAllSchemas',
  'databaseVersion',
  'getDatabaseName',
  'getQueryInterface',
  'queryGenerator',
]);

/** Calls that read or write rows. */
const DATA_CALLS: ReadonlySet<string> = new Set([
  'bulkInsert',
  'bulkUpdate',
  'bulkDelete',
  'insert',
  'update',
  'upsert',
  'delete',
  'increment',
  'decrement',
]);

/** The key under which calls made from a list that is computed at run time are counted. */
const COMPUTED_LIST: string = '<computed list>';

const CONTROL_STATEMENTS: ReadonlySet<string> = new Set([
  'if_statement',
  'for_statement',
  'for_in_statement',
  'while_statement',
  'do_statement',
  'switch_statement',
]);

const CLAUSE_STATEMENTS: ReadonlySet<string> = new Set([
  'else_clause',
  'catch_clause',
  'finally_clause',
  'switch_body',
  'switch_case',
  'switch_default',
]);

function line(node: SyntaxNode): number {
  return node.startPosition.row + 1;
}

function where(scope: Scope, node: SyntaxNode): string {
  return `${scope.file.label}:${line(node)}`;
}

function warn(run: Run, message: string): void {
  if (!run.project.warnings.includes(message)) {
    run.project.warnings.push(message);
  }
}

function describeTable(
  table: StateTable | { name: string; schema?: string }
): string {
  return `"${table.schema === undefined ? table.name : `${table.schema}.${table.name}`}"`;
}

/** A table named by a string, a `{ tableName, schema }` object or a constant holding either. */
function readTableRef(
  node: SyntaxNode | undefined,
  scope: Scope
): { name: string; schema?: string } | undefined {
  if (node === undefined) {
    return undefined;
  }
  const value: TsValue = evaluateNode(resolveNode(node, scope.ctx));
  if (value.kind === 'string' && value.value !== '') {
    return { name: value.value };
  }
  if (value.kind === 'object') {
    const name: TsValue | undefined = value.properties['tableName'];
    const schema: TsValue | undefined = value.properties['schema'];
    if (name !== undefined && name.kind === 'string') {
      return {
        name: name.value,
        ...(schema !== undefined &&
        schema.kind === 'string' &&
        schema.value !== ''
          ? { schema: schema.value }
          : {}),
      };
    }
  }
  return undefined;
}

function readString(
  node: SyntaxNode | undefined,
  scope: Scope
): string | undefined {
  return node === undefined ? undefined : stringOf(node, scope.ctx);
}

function readStringList(
  node: SyntaxNode | undefined,
  scope: Scope
): string[] | undefined {
  if (node === undefined) {
    return undefined;
  }
  const resolved: SyntaxNode = resolveNode(node, scope.ctx);
  if (resolved.type !== 'array') {
    return undefined;
  }
  const names: string[] = [];
  for (const item of resolved.namedChildren) {
    const text: string | undefined = stringOf(item, scope.ctx);
    if (text === undefined) {
      return undefined;
    }
    names.push(text);
  }
  return names;
}

function skip(
  run: Run,
  scope: Scope,
  call: SyntaxNode,
  action: string,
  reason: string
): void {
  warn(
    run,
    `${where(scope, call)}: ${action}: ${reason}; the statement was skipped.`
  );
}

/** The column of a migration, as `sequelize.define` would read the same definition. */
function readColumn(
  name: string,
  node: SyntaxNode,
  scope: Scope,
  run: Run,
  table: string
): RawAttribute {
  const attribute: RawAttribute = readAttribute(name, node, scope.ctx);
  // The names of a migration are the database's: there is no `field`.
  delete attribute.field;
  const label: string = `${where(scope, node)}: table "${table}", column "${name}"`;
  if (attribute.unique?.name !== undefined) {
    warn(
      run,
      `${label}: unique: '${attribute.unique.name}' does nothing in a migration (queryInterface only reads unique: true), so the column is not unique.`
    );
    delete attribute.unique;
  }
  const resolved: SyntaxNode = resolveNode(node, scope.ctx);
  if (resolved.type === 'object') {
    const references: SyntaxNode | undefined = objectEntries(
      resolved,
      scope.ctx
    ).entries.get('references');
    const target: TsValue | undefined =
      references === undefined ? undefined : valueOf(references, scope.ctx);
    if (target !== undefined && target.kind === 'string') {
      attribute.references = { model: target };
    }
  }
  const model: TsValue | undefined = attribute.references?.model;
  if (model !== undefined && model.kind !== 'string') {
    const table: string | undefined =
      model.kind === 'object' &&
      model.properties['tableName']?.kind === 'string'
        ? model.properties['tableName'].value
        : undefined;
    if (table === undefined) {
      warn(
        run,
        `${label}: the table in references could not be read statically, so no foreign key was created.`
      );
      delete attribute.references;
      delete attribute.onDelete;
      delete attribute.onUpdate;
    } else {
      attribute.references = {
        ...attribute.references,
        model: { kind: 'string', value: table },
      };
    }
  }
  return attribute;
}

// -- createTable, addColumn and the other calls ---------------------------------------------------

function applyCreateTable(
  call: SyntaxNode,
  args: SyntaxNode[],
  scope: Scope,
  run: Run
): void {
  const ref = readTableRef(args[0], scope);
  if (ref === undefined) {
    warn(
      run,
      `${where(scope, call)}: createTable: the table name cannot be read statically; the statement was skipped.`
    );
    return;
  }
  const options: Map<string, SyntaxNode> =
    args[2] === undefined
      ? new Map()
      : objectEntries(args[2], scope.ctx).entries;
  const schema: string | undefined =
    ref.schema ?? readString(options.get('schema'), scope);
  const table: StateTable = {
    name: ref.name,
    ...(schema === undefined ? {} : { schema }),
    file: scope.file,
    columns: [],
    indexes: [],
    constraints: [],
  };
  const attributes =
    args[1] === undefined ? undefined : objectEntries(args[1], scope.ctx);
  if (
    attributes === undefined ||
    (attributes.entries.size === 0 && attributes.incomplete)
  ) {
    warn(
      run,
      `${where(scope, call)}: createTable ${describeTable(table)}: the columns cannot be read statically; the table has none.`
    );
  } else if (attributes.incomplete) {
    warn(
      run,
      `${where(scope, call)}: createTable ${describeTable(table)}: some columns are built from values that cannot be read statically and are missing.`
    );
  }
  for (const [name, node] of attributes?.entries ?? []) {
    table.columns.push(readColumn(name, node, scope, run, ref.name));
  }
  const reason: string | undefined = createTable(run.state, table);
  if (reason !== undefined) {
    skip(run, scope, call, `createTable ${describeTable(table)}`, reason);
    return;
  }
  run.touched.push(ref.name);
  const keys: SyntaxNode | undefined = options.get('uniqueKeys');
  if (keys !== undefined) {
    for (const [name, value] of objectEntries(keys, scope.ctx).entries) {
      const fields: string[] | undefined = readStringList(
        objectEntries(value, scope.ctx).entries.get('fields'),
        scope
      );
      const known: boolean =
        fields !== undefined &&
        fields.every((field: string) => findColumn(table, field) !== undefined);
      if (fields === undefined || !known) {
        warn(
          run,
          `${where(scope, call)}: createTable ${describeTable(table)}: the unique key "${name}" lists columns that cannot be read or do not exist; it was skipped.`
        );
        continue;
      }
      table.constraints.push({ kind: 'unique', name, columns: fields });
    }
  }
}

function applyAddColumn(
  call: SyntaxNode,
  args: SyntaxNode[],
  scope: Scope,
  run: Run
): void {
  const ref = readTableRef(args[0], scope);
  const name: string | undefined = readString(args[1], scope);
  if (ref === undefined || name === undefined || args[2] === undefined) {
    warn(
      run,
      `${where(scope, call)}: addColumn: the table or column name cannot be read statically; the statement was skipped.`
    );
    return;
  }
  const table: StateTable | undefined = findTable(
    run.state,
    ref.name,
    ref.schema
  );
  if (table === undefined) {
    skip(
      run,
      scope,
      call,
      `addColumn ${describeTable(ref)}, column "${name}"`,
      `the table does not exist at this point`
    );
    return;
  }
  const reason: string | undefined = addColumn(
    table,
    readColumn(name, args[2], scope, run, table.name)
  );
  if (reason !== undefined) {
    skip(
      run,
      scope,
      call,
      `addColumn ${describeTable(table)}, column "${name}"`,
      reason
    );
  }
  run.touched.push(table.name);
}

function applyRemoveColumn(
  call: SyntaxNode,
  args: SyntaxNode[],
  scope: Scope,
  run: Run
): void {
  const ref = readTableRef(args[0], scope);
  const name: string | undefined = readString(args[1], scope);
  if (ref === undefined || name === undefined) {
    warn(
      run,
      `${where(scope, call)}: removeColumn: the table or column name cannot be read statically; the statement was skipped.`
    );
    return;
  }
  const table: StateTable | undefined = findTable(
    run.state,
    ref.name,
    ref.schema
  );
  const reason: string | undefined =
    table === undefined
      ? 'the table does not exist at this point'
      : removeColumn(table, name);
  if (reason !== undefined) {
    skip(
      run,
      scope,
      call,
      `removeColumn ${describeTable(ref)}, column "${name}"`,
      reason
    );
  }
  run.touched.push(ref.name);
}

function applyRenameColumn(
  call: SyntaxNode,
  args: SyntaxNode[],
  scope: Scope,
  run: Run
): void {
  const ref = readTableRef(args[0], scope);
  const from: string | undefined = readString(args[1], scope);
  const to: string | undefined = readString(args[2], scope);
  if (ref === undefined || from === undefined || to === undefined) {
    warn(
      run,
      `${where(scope, call)}: renameColumn: the table or column names cannot be read statically; the statement was skipped.`
    );
    return;
  }
  const table: StateTable | undefined = findTable(
    run.state,
    ref.name,
    ref.schema
  );
  const reason: string | undefined =
    table === undefined
      ? 'the table does not exist at this point'
      : renameColumn(run.state, table, from, to);
  if (reason !== undefined) {
    skip(
      run,
      scope,
      call,
      `renameColumn ${describeTable(ref)}, column "${from}"`,
      reason
    );
  }
  run.touched.push(ref.name);
}

function applyRenameTable(
  call: SyntaxNode,
  args: SyntaxNode[],
  scope: Scope,
  run: Run
): void {
  const from = readTableRef(args[0], scope);
  const to = readTableRef(args[1], scope);
  if (from === undefined || to === undefined) {
    warn(
      run,
      `${where(scope, call)}: renameTable: the table names cannot be read statically; the statement was skipped.`
    );
    return;
  }
  const reason: string | undefined = renameTable(
    run.state,
    from.name,
    to.name,
    from.schema
  );
  if (reason !== undefined) {
    skip(run, scope, call, `renameTable ${describeTable(from)}`, reason);
  }
  run.touched.push(from.name);
}

function applyDropTable(
  call: SyntaxNode,
  args: SyntaxNode[],
  scope: Scope,
  run: Run
): void {
  const ref = readTableRef(args[0], scope);
  if (ref === undefined) {
    warn(
      run,
      `${where(scope, call)}: dropTable: the table name cannot be read statically; the statement was skipped.`
    );
    return;
  }
  const { dropped, dangling } = dropTable(run.state, ref.name, ref.schema);
  if (dropped === undefined) {
    skip(
      run,
      scope,
      call,
      `dropTable ${describeTable(ref)}`,
      'the table does not exist at this point'
    );
    return;
  }
  run.touched.push(ref.name);
  const cascade: boolean =
    args[1] !== undefined &&
    boolOf(
      objectEntries(args[1], scope.ctx).entries.get('cascade'),
      scope.ctx
    ) === true;
  if (dangling.length > 0 && !cascade) {
    warn(
      run,
      `${where(scope, call)}: dropTable ${describeTable(ref)}: the foreign keys on ${dangling.join(', ')} pointed at the table; the columns stay as plain columns.`
    );
  }
}

function applyChangeColumn(
  call: SyntaxNode,
  args: SyntaxNode[],
  scope: Scope,
  run: Run
): void {
  const ref = readTableRef(args[0], scope);
  const name: string | undefined = readString(args[1], scope);
  if (ref === undefined || name === undefined || args[2] === undefined) {
    warn(
      run,
      `${where(scope, call)}: changeColumn: the table or column name cannot be read statically; the statement was skipped.`
    );
    return;
  }
  const table: StateTable | undefined = findTable(
    run.state,
    ref.name,
    ref.schema
  );
  const action: string = `changeColumn ${describeTable(ref)}, column "${name}"`;
  if (table === undefined) {
    skip(run, scope, call, action, 'the table does not exist at this point');
    return;
  }
  const changes: RawAttribute = readColumn(
    name,
    args[2],
    scope,
    run,
    table.name
  );
  const spec: SyntaxNode = resolveNode(args[2], scope.ctx);
  const named: Set<string> = new Set(
    spec.type === 'object'
      ? objectEntries(spec, scope.ctx).entries.keys()
      : ['type']
  );
  const column: RawAttribute | undefined = findColumn(table, name);
  if (
    column !== undefined &&
    ((!named.has('defaultValue') && column.defaultValue !== undefined) ||
      (!named.has('allowNull') && column.allowNull === false))
  ) {
    warn(
      run,
      `${where(scope, call)}: ${action}: the call does not name ${[
        ...(named.has('allowNull') || column.allowNull !== false
          ? []
          : ['allowNull']),
        ...(named.has('defaultValue') || column.defaultValue === undefined
          ? []
          : ['defaultValue']),
      ].join(
        ' or '
      )}; the column keeps it (SQLite does that, PostgreSQL and MySQL reset what the call leaves out), so the result may differ from the real database.`
    );
  }
  const reason: string | undefined = changeColumn(table, name, changes, named);
  if (reason !== undefined) {
    skip(run, scope, call, action, reason);
  }
  run.touched.push(table.name);
}

/** The fields of an index or constraint: strings, or `{ name, order, length }` objects. */
function readIndexFields(
  node: SyntaxNode | undefined,
  scope: Scope
): { fields: RawIndexField[]; hasExpression: boolean } | undefined {
  if (node === undefined) {
    return undefined;
  }
  const resolved: SyntaxNode = resolveNode(node, scope.ctx);
  if (resolved.type !== 'array') {
    return undefined;
  }
  const fields: RawIndexField[] = [];
  let hasExpression: boolean = false;
  for (const item of resolved.namedChildren) {
    const field: RawIndexField | 'expression' = indexFieldOf(item, scope.ctx);
    if (field === 'expression') {
      hasExpression = true;
    } else {
      fields.push(field);
    }
  }
  return { fields, hasExpression };
}

function applyAddIndex(
  call: SyntaxNode,
  args: SyntaxNode[],
  scope: Scope,
  run: Run
): void {
  const ref = readTableRef(args[0], scope);
  if (ref === undefined) {
    warn(
      run,
      `${where(scope, call)}: addIndex: the table name cannot be read statically; the statement was skipped.`
    );
    return;
  }
  // addIndex(table, fields, options) or addIndex(table, { fields, ...options })
  const second: SyntaxNode | undefined =
    args[1] === undefined ? undefined : resolveNode(args[1], scope.ctx);
  const optionsNode: SyntaxNode | undefined =
    second?.type === 'array' ? args[2] : args[1];
  const options: Map<string, SyntaxNode> =
    optionsNode === undefined
      ? new Map()
      : objectEntries(optionsNode, scope.ctx).entries;
  const list = readIndexFields(
    second?.type === 'array' ? args[1] : options.get('fields'),
    scope
  );
  const action: string = `addIndex ${describeTable(ref)}`;
  const table: StateTable | undefined = findTable(
    run.state,
    ref.name,
    ref.schema
  );
  if (table === undefined) {
    skip(run, scope, call, action, 'the table does not exist at this point');
    return;
  }
  if (list === undefined) {
    skip(run, scope, call, action, 'the columns cannot be read statically');
    return;
  }
  const missing: RawIndexField[] = list.fields.filter(
    (field: RawIndexField) => findColumn(table, field.name) === undefined
  );
  if (missing.length > 0) {
    skip(
      run,
      scope,
      call,
      `${action} (${list.fields.map((field: RawIndexField) => field.name).join(', ')})`,
      `the column "${missing[0]?.name ?? ''}" does not exist at this point`
    );
    return;
  }
  const explicitName: string | undefined = readString(
    options.get('name'),
    scope
  );
  const type: string | undefined = readString(
    options.get('type'),
    scope
  )?.toUpperCase();
  const using: string | undefined = readString(options.get('using'), scope);
  const names: string[] = list.fields.map((field: RawIndexField) => field.name);
  const index: RawIndex = {
    fields: list.fields,
    unique:
      boolOf(options.get('unique'), scope.ctx) === true || type === 'UNIQUE',
    ...(using === undefined ? {} : { using }),
    ...(type === 'FULLTEXT' || type === 'SPATIAL' ? { type } : {}),
    isPartial: options.has('where'),
    hasExpression: list.hasExpression,
  };
  const entry: StateIndex = {
    name: explicitName ?? defaultIndexName(table.name, names),
    isExplicit: explicitName !== undefined,
    index:
      explicitName === undefined ? index : { ...index, name: explicitName },
  };
  const reason: string | undefined = addIndex(table, entry);
  if (reason !== undefined) {
    skip(run, scope, call, action, reason);
  }
  run.touched.push(table.name);
}

function applyRemoveIndex(
  call: SyntaxNode,
  args: SyntaxNode[],
  scope: Scope,
  run: Run
): void {
  const ref = readTableRef(args[0], scope);
  const target: SyntaxNode | undefined =
    args[1] === undefined ? undefined : resolveNode(args[1], scope.ctx);
  const nameOrFields: string | string[] | undefined =
    target === undefined
      ? undefined
      : target.type === 'array'
        ? readStringList(target, scope)
        : readString(target, scope);
  if (ref === undefined || nameOrFields === undefined) {
    warn(
      run,
      `${where(scope, call)}: removeIndex: the table or index cannot be read statically; the statement was skipped.`
    );
    return;
  }
  const table: StateTable | undefined = findTable(
    run.state,
    ref.name,
    ref.schema
  );
  const reason: string | undefined =
    table === undefined
      ? 'the table does not exist at this point'
      : removeIndex(
          table,
          typeof nameOrFields === 'string' ? nameOrFields : nameOrFields
        );
  if (reason !== undefined) {
    skip(run, scope, call, `removeIndex ${describeTable(ref)}`, reason);
  }
  run.touched.push(ref.name);
}

const CONSTRAINT_KINDS: Readonly<Record<string, ConstraintKind>> = {
  UNIQUE: 'unique',
  'PRIMARY KEY': 'primary key',
  'FOREIGN KEY': 'foreign key',
  CHECK: 'check',
  DEFAULT: 'default',
};

function applyAddConstraint(
  call: SyntaxNode,
  args: SyntaxNode[],
  scope: Scope,
  run: Run
): void {
  const ref = readTableRef(args[0], scope);
  const options: Map<string, SyntaxNode> =
    args[1] === undefined
      ? new Map()
      : objectEntries(args[1], scope.ctx).entries;
  const kind: ConstraintKind | undefined =
    CONSTRAINT_KINDS[
      (readString(options.get('type'), scope) ?? '').toUpperCase()
    ];
  const fields: string[] | undefined = readStringList(
    options.get('fields'),
    scope
  );
  const typeText: string | undefined = readString(options.get('type'), scope);
  if (ref !== undefined && typeText !== undefined && kind === undefined) {
    warn(
      run,
      `${where(scope, call)}: addConstraint ${describeTable(ref)}: the constraint type "${typeText}" is not unique, primary key, foreign key, check or default; the statement was skipped.`
    );
    return;
  }
  if (
    ref === undefined ||
    kind === undefined ||
    fields === undefined ||
    fields.length === 0
  ) {
    warn(
      run,
      `${where(scope, call)}: addConstraint: the table, type or fields cannot be read statically; the statement was skipped.`
    );
    return;
  }
  const action: string = `addConstraint ${describeTable(ref)} (${fields.join(', ')})`;
  const table: StateTable | undefined = findTable(
    run.state,
    ref.name,
    ref.schema
  );
  if (table === undefined) {
    skip(run, scope, call, action, 'the table does not exist at this point');
    return;
  }
  const columns: RawAttribute[] = [];
  for (const field of fields) {
    const column: RawAttribute | undefined = findColumn(table, field);
    if (column === undefined) {
      skip(
        run,
        scope,
        call,
        action,
        `the column "${field}" does not exist at this point`
      );
      return;
    }
    columns.push(column);
  }
  const explicitName: string | undefined = readString(
    options.get('name'),
    scope
  );
  let referencedTable: string | undefined;
  if (kind === 'foreign key') {
    const references: Map<string, SyntaxNode> = objectEntries(
      options.get('references') ?? call,
      scope.ctx
    ).entries;
    const target = readTableRef(references.get('table'), scope);
    const key: string | undefined =
      readString(references.get('field'), scope) ??
      readStringList(references.get('fields'), scope)?.[0];
    if (target === undefined || key === undefined) {
      skip(
        run,
        scope,
        call,
        action,
        'the referenced table or column cannot be read statically'
      );
      return;
    }
    if (fields.length > 1) {
      skip(
        run,
        scope,
        call,
        action,
        'a foreign key over several columns is not part of the shared model'
      );
      return;
    }
    referencedTable = target.name;
    const column: RawAttribute | undefined = columns[0];
    if (column !== undefined) {
      column.references = {
        model: { kind: 'string', value: target.name },
        key,
      };
      const onDelete: string | undefined = readString(
        options.get('onDelete'),
        scope
      );
      const onUpdate: string | undefined = readString(
        options.get('onUpdate'),
        scope
      );
      if (onDelete === undefined) {
        delete column.onDelete;
      } else {
        column.onDelete = onDelete;
      }
      if (onUpdate === undefined) {
        delete column.onUpdate;
      } else {
        column.onUpdate = onUpdate;
      }
    }
  } else if (kind === 'primary key') {
    for (const column of columns) {
      column.primaryKey = true;
    }
  } else if (kind === 'default') {
    const value: SyntaxNode | undefined = options.get('defaultValue');
    const column: RawAttribute | undefined = columns[0];
    if (value !== undefined && column !== undefined) {
      column.defaultValue = valueOf(value, scope.ctx);
    }
  } else if (kind === 'check') {
    warn(
      run,
      `${where(scope, call)}: ${action}: a check constraint is not part of the shared model; the condition was ignored.`
    );
  }
  const reason: string | undefined = addConstraint(table, {
    kind,
    name:
      explicitName ??
      defaultConstraintName(table.name, kind, fields, referencedTable),
    columns: fields,
  });
  if (reason !== undefined) {
    skip(run, scope, call, action, reason);
  }
  run.touched.push(table.name);
}

function applyRemoveConstraint(
  call: SyntaxNode,
  args: SyntaxNode[],
  scope: Scope,
  run: Run
): void {
  const ref = readTableRef(args[0], scope);
  const name: string | undefined = readString(args[1], scope);
  if (ref === undefined || name === undefined) {
    warn(
      run,
      `${where(scope, call)}: removeConstraint: the table or constraint name cannot be read statically; the statement was skipped.`
    );
    return;
  }
  const table: StateTable | undefined = findTable(
    run.state,
    ref.name,
    ref.schema
  );
  const reason: string | undefined =
    table === undefined
      ? 'the table does not exist at this point'
      : removeConstraint(table, name);
  if (reason !== undefined) {
    skip(
      run,
      scope,
      call,
      `removeConstraint ${describeTable(ref)} "${name}"`,
      reason
    );
  }
  run.touched.push(ref.name);
}

// -- Raw SQL ----------------------------------------------------------------------------------------

const SQL_TABLE: RegExp =
  /\b(?:alter\s+table|create\s+table(?:\s+if\s+not\s+exists)?|drop\s+table(?:\s+if\s+exists)?|rename\s+table|create\s+(?:unique\s+)?index\s+\S+\s+on|drop\s+index\s+\S+\s+on|insert\s+into|update|delete\s+from)\s+[`"'[]?([A-Za-z0-9_.]+)/i;

function countRaw(
  call: SyntaxNode,
  args: SyntaxNode[],
  scope: Scope,
  run: Run
): void {
  run.raw = tally(run.raw, where(scope, call));
  const sql: string | undefined = readString(args[0], scope);
  const table: string | undefined =
    sql === undefined ? undefined : SQL_TABLE.exec(sql)?.[1];
  if (table !== undefined) {
    run.rawTables.add(table);
    run.touched.push(table);
  }
}

// -- Walking ----------------------------------------------------------------------------------------

function isQueryInterface(node: SyntaxNode, scope: Scope): boolean {
  const stripped: SyntaxNode = stripWrappers(node);
  return (
    stripped.type === 'identifier' && scope.queryInterfaces.has(stripped.text)
  );
}

/** `queryInterface.sequelize` (or `queryInterface.sequelize.getQueryInterface()` is not followed). */
function isQuerySequelize(node: SyntaxNode, scope: Scope): boolean {
  const stripped: SyntaxNode = stripWrappers(node);
  if (stripped.type !== 'member_expression') {
    return false;
  }
  const object: SyntaxNode | null = stripped.childForFieldName('object');
  return (
    object !== null &&
    isQueryInterface(object, scope) &&
    stripped.childForFieldName('property')?.text === 'sequelize'
  );
}

function runQueryInterfaceCall(
  method: string,
  call: SyntaxNode,
  scope: Scope,
  run: Run
): void {
  const args: SyntaxNode[] = argsOf(call);
  switch (method) {
    case 'createTable':
      applyCreateTable(call, args, scope, run);
      return;
    case 'addColumn':
      applyAddColumn(call, args, scope, run);
      return;
    case 'removeColumn':
      applyRemoveColumn(call, args, scope, run);
      return;
    case 'renameColumn':
      applyRenameColumn(call, args, scope, run);
      return;
    case 'renameTable':
      applyRenameTable(call, args, scope, run);
      return;
    case 'changeColumn':
      applyChangeColumn(call, args, scope, run);
      return;
    case 'addIndex':
      applyAddIndex(call, args, scope, run);
      return;
    case 'removeIndex':
      applyRemoveIndex(call, args, scope, run);
      return;
    case 'addConstraint':
      applyAddConstraint(call, args, scope, run);
      return;
    case 'removeConstraint':
      applyRemoveConstraint(call, args, scope, run);
      return;
    case 'dropTable':
      applyDropTable(call, args, scope, run);
      return;
    default:
      break;
  }
  if (DATA_CALLS.has(method)) {
    run.data = tally(run.data, where(scope, call));
    const table = readTableRef(args[0], scope);
    if (table !== undefined) {
      run.touched.push(table.name);
    }
  } else if (method === 'sql' || method === 'query') {
    countRaw(call, args, scope, run);
  } else if (!READ_ONLY_CALLS.has(method)) {
    run.unsupported.set(
      method,
      tally(run.unsupported.get(method), where(scope, call))
    );
  }
}

/** The statements of a function body, or the expression of an arrow function that has no block. */
function bodyStatements(fn: SyntaxNode): SyntaxNode[] {
  const body: SyntaxNode | null = fn.childForFieldName('body');
  if (body === null) {
    return [];
  }
  return body.type === 'statement_block' ? body.namedChildren : [body];
}

function walkFunction(
  fn: SyntaxNode,
  scope: Scope,
  run: Run,
  extra: readonly string[] = []
): void {
  if (scope.active.has(fn)) {
    return;
  }
  const inner: Scope = {
    ...scope,
    queryInterfaces: new Set([...scope.queryInterfaces, ...extra]),
    active: new Set([...scope.active, fn]),
  };
  walkStatements(bodyStatements(fn), inner, run);
}

function walkExpression(node: SyntaxNode, scope: Scope, run: Run): void {
  const expression: SyntaxNode = stripWrappers(node);
  if (expression.type === 'sequence_expression') {
    for (const part of expression.namedChildren) {
      walkExpression(part, scope, run);
    }
    return;
  }
  if (expression.type !== 'call_expression') {
    return;
  }
  const callee: SyntaxNode | null = expression.childForFieldName('function');
  if (callee === null) {
    return;
  }
  const target: SyntaxNode = stripWrappers(callee);
  const args: SyntaxNode[] = argsOf(expression);
  if (target.type === 'identifier') {
    // A helper declared in the same file: read its body with the query interface it was given.
    const helper: SyntaxNode | undefined = scope.functions.get(target.text);
    if (helper !== undefined) {
      const names: string[] = [];
      parametersOf(helper).forEach((parameter: SyntaxNode, at: number) => {
        const argument: SyntaxNode | undefined = args[at];
        const bound: string | undefined = parameterName(parameter);
        if (
          argument !== undefined &&
          bound !== undefined &&
          isQueryInterface(argument, scope)
        ) {
          names.push(bound);
        }
      });
      walkFunction(helper, scope, run, names);
    }
    return;
  }
  if (target.type !== 'member_expression') {
    return;
  }
  const object: SyntaxNode | null = target.childForFieldName('object');
  const property: SyntaxNode | null = target.childForFieldName('property');
  if (object === null || property === null) {
    return;
  }
  const method: string = property.text;
  if (isQueryInterface(object, scope)) {
    runQueryInterfaceCall(method, expression, scope, run);
    return;
  }
  if (isQuerySequelize(object, scope)) {
    if (method === 'query') {
      countRaw(expression, args, scope, run);
    } else if (method === 'transaction') {
      const handler: SyntaxNode | undefined = asFunction(
        args[args.length - 1],
        scope.functions
      );
      if (handler !== undefined) {
        walkFunction(handler, scope, run);
      }
    }
    return;
  }
  if (object.text === 'Promise') {
    if (method === 'all' || method === 'allSettled' || method === 'race') {
      const list: SyntaxNode | undefined =
        args[0] === undefined ? undefined : resolveNode(args[0], scope.ctx);
      if (list !== undefined && list.type === 'array') {
        for (const item of list.namedChildren) {
          walkExpression(item, scope, run);
        }
      } else if (list !== undefined) {
        walkComputedList(list, scope, run);
      }
    }
    return;
  }
  if (method === 'then' || method === 'catch' || method === 'finally') {
    // `createTable(...).then(() => addIndex(...))`: the receiver runs first.
    walkExpression(object, scope, run);
    if (method === 'then') {
      const handler: SyntaxNode | undefined = asFunction(
        args[0],
        scope.functions
      );
      if (handler !== undefined) {
        walkFunction(handler, scope, run);
      }
    }
  }
}

/** `Promise.all(list.map(...))` and similar: the calls depend on run-time values, so they are not replayed. */
function walkComputedList(list: SyntaxNode, scope: Scope, run: Run): void {
  let mentionsQueryInterface: boolean = false;
  const stack: SyntaxNode[] = [list];
  while (stack.length > 0 && !mentionsQueryInterface) {
    const node: SyntaxNode | undefined = stack.pop();
    if (node === undefined) {
      break;
    }
    if (node.type === 'identifier' && scope.queryInterfaces.has(node.text)) {
      mentionsQueryInterface = true;
    }
    stack.push(...node.namedChildren);
  }
  if (mentionsQueryInterface) {
    run.unsupported.set(
      COMPUTED_LIST,
      tally(run.unsupported.get(COMPUTED_LIST), where(scope, list))
    );
  }
}

function nestedStatements(node: SyntaxNode): SyntaxNode[] {
  const found: SyntaxNode[] = [];
  for (const child of node.namedChildren) {
    if (CLAUSE_STATEMENTS.has(child.type)) {
      found.push(...nestedStatements(child));
    } else if (
      child.type === 'statement_block' ||
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
    default:
      return 'a loop';
  }
}

function walkStatements(
  nodes: readonly SyntaxNode[],
  scope: Scope,
  run: Run
): void {
  for (const node of nodes) {
    switch (node.type) {
      case 'comment':
        break;
      case 'statement_block':
        walkStatements(node.namedChildren, scope, run);
        break;
      case 'expression_statement':
      case 'return_statement': {
        const expression: SyntaxNode | undefined = node.namedChildren.find(
          (child: SyntaxNode) => child.type !== 'comment'
        );
        if (expression !== undefined) {
          walkExpression(expression, scope, run);
        }
        break;
      }
      case 'lexical_declaration':
      case 'variable_declaration':
        for (const declarator of node.namedChildren) {
          const value: SyntaxNode | null =
            declarator.childForFieldName('value');
          if (value !== null) {
            walkExpression(value, scope, run);
          }
        }
        break;
      default:
        if (node.type === 'try_statement') {
          // `try { ...; await transaction.commit() } catch { await transaction.rollback(); throw }` is the
          // usual shape of a migration: the body is what runs, the handlers only undo it.
          const body: SyntaxNode | null = node.childForFieldName('body');
          if (body !== null) {
            walkStatements(body.namedChildren, scope, run);
          }
        } else if (CONTROL_STATEMENTS.has(node.type)) {
          const before: number = run.touched.length;
          walkStatements(nestedStatements(node), scope, run);
          const tables: string[] = [...new Set(run.touched.slice(before))];
          warn(
            run,
            `${where(scope, node)}: ${controlLabel(node)} contains schema changes; it was applied as if it always ran` +
              (tables.length > 0
                ? ` (tables: ${tables.join(', ')}), so the result may differ from the real database.`
                : ', so the result may differ from the real database.')
          );
        } else if (!node.type.endsWith('_declaration')) {
          // Anything else that is an expression in disguise (a bare call in an arrow body).
          walkExpression(node, scope, run);
        }
        break;
    }
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function pluralCount(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function reportSummaries(run: Run): void {
  if (run.raw !== undefined) {
    const tables: string = [...run.rawTables].join(', ');
    run.project.warnings.push(
      `Skipped ${pluralCount(run.raw.count, 'raw SQL query', 'raw SQL queries')} (first at ${run.raw.first}${tables === '' ? '' : `, tables: ${tables}`}): raw SQL is not replayed, so the schema may differ from the real database.`
    );
  }
  if (run.data !== undefined) {
    run.project.warnings.push(
      `Skipped ${pluralCount(run.data.count, 'data statement', 'data statements')} (first at ${run.data.first}): row data is not part of the schema.`
    );
  }
  for (const [method, counter] of run.unsupported) {
    const what: string =
      method === COMPUTED_LIST
        ? pluralCount(
            counter.count,
            'call made from a list computed at run time',
            'calls made from a list computed at run time'
          )
        : pluralCount(counter.count, `${method} call`, `${method} calls`);
    run.project.warnings.push(
      `Skipped ${what} (first at ${counter.first}): the change is not replayed, so the schema may differ from the real database.`
    );
  }
}

/** The options of a table read from migrations: the database's names, none of Sequelize's own columns. */
function tableOptions(table: StateTable): ModelOptions {
  return {
    tableName: table.name,
    freezeTableName: true,
    timestamps: false,
    paranoid: false,
    underscored: false,
    ...(table.schema === undefined ? {} : { schema: table.schema }),
    createdAt: false,
    updatedAt: false,
    deletedAt: false,
  };
}

/** The model name for a table: `blog_posts` becomes `BlogPost`, and a clash gets a number. */
function modelNameFor(table: StateTable, taken: Set<string>): string {
  let base: string = toPascalCase(singularize(toSnakeCase(table.name)));
  if (base === '') {
    base = 'Model';
  }
  if (/^\d/.test(base)) {
    base = `T${base}`;
  }
  if (taken.has(base) && table.schema !== undefined) {
    base = `${toPascalCase(table.schema)}${base}`;
  }
  let name: string = base;
  for (let suffix: number = 2; taken.has(name); suffix += 1) {
    name = `${base}${suffix}`;
  }
  taken.add(name);
  return name;
}

function toRawModel(table: StateTable, modelName: string): RawModel {
  const indexes: RawIndex[] = [
    ...table.indexes.map((entry: StateIndex): RawIndex => ({
      ...entry.index,
      fields: entry.index.fields.map((field: RawIndexField) => ({ ...field })),
    })),
    ...table.constraints
      .filter((constraint: StateConstraint) => constraint.kind === 'unique')
      .map((constraint: StateConstraint): RawIndex => ({
        fields: constraint.columns.map((name: string): RawIndexField => ({
          name,
        })),
        unique: true,
        name: constraint.name,
        isPartial: false,
        hasExpression: false,
      })),
  ];
  return {
    file: table.file,
    style: 'migration',
    modelName,
    aliases: [],
    attributes: table.columns,
    optionEntries: new Map(),
    decoratorOptions: {},
    indexes,
    foreignKeyHints: new Map(),
    accessors: [],
    unsupported: [],
    location: `table "${table.name}"`,
    presetOptions: tableOptions(table),
  };
}

/** Migration files in the order they run: by file name, as `sequelize-cli` (umzug) sorts them. */
export function orderMigrationFiles(files: readonly FileInfo[]): FileInfo[] {
  return [...files].sort((left: FileInfo, right: FileInfo): number => {
    if (left.label !== right.label) {
      return left.label < right.label ? -1 : 1;
    }
    return left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
  });
}

/**
 * Replays the `up` functions of the migration files and returns one model per table that exists at the end.
 * Warnings go to `project.warnings`.
 */
export function replayMigrations(
  files: readonly FileInfo[],
  project: Project
): RawModel[] {
  const run: Run = {
    state: newState(),
    project,
    raw: undefined,
    rawTables: new Set(),
    data: undefined,
    unsupported: new Map(),
    touched: [],
  };
  for (const file of orderMigrationFiles(files)) {
    const ctx: Ctx = { file, project };
    const up: UpFunction | undefined = findUp(file, ctx);
    if (up === undefined) {
      continue;
    }
    const scope: Scope = {
      file,
      ctx,
      queryInterfaces: new Set(up.queryInterfaces),
      functions: declaredFunctions(file),
      active: new Set([up.node]),
    };
    walkStatements(bodyStatements(up.node), scope, run);
  }
  reportSummaries(run);
  const taken: Set<string> = new Set();
  return [...run.state.tables.values()].map((table: StateTable) =>
    toRawModel(table, modelNameFor(table, taken))
  );
}
