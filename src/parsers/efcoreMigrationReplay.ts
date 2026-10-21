import type { IrOnDelete } from '../ir.js';
import {
  bodyStatements,
  flattenChain,
  readLambda,
  selectedMembers,
  type CsCall,
  type CsChain,
  type CsLambda,
} from './csharpChains.js';
import {
  evaluate,
  type ConstLookup,
  type CsAttribute,
  type CsClass,
  type CsMethod,
  type CsType,
  type CsValue,
  type SyntaxNode,
} from './csharpSyntax.js';
import {
  dropColumn,
  findColumn,
  referentialAction,
  renameColumn,
  renameTable,
  tableKey,
  type MigrationColumn,
  type MigrationForeignKey,
  type MigrationIndex,
  type MigrationKey,
  type MigrationSchema,
  type MigrationTable,
} from './efcoreMigrationState.js';

/** One migration class and where its `Up` method is. */
export interface MigrationClassInfo {
  path: string;
  className: string;
  /** The migration id: the `[Migration("...")]` value, else the file name without `.cs`. */
  id: string;
  /** The `Up` method body. */
  up: SyntaxNode;
  /** The name of the `MigrationBuilder` parameter. */
  builder: string;
}

const NO_CONSTANTS: ConstLookup = (): CsValue | undefined => undefined;

/** The parameter names of the `MigrationBuilder` methods in order, for calls that pass arguments by position. */
const PARAMETERS: Readonly<Record<string, readonly string[]>> = {
  CreateTable: ['name', 'columns', 'schema', 'constraints', 'comment'],
  DropTable: ['name', 'schema'],
  RenameTable: ['name', 'schema', 'newName', 'newSchema'],
  AddColumn: [
    'name',
    'table',
    'type',
    'unicode',
    'maxLength',
    'rowVersion',
    'schema',
    'nullable',
    'defaultValue',
    'defaultValueSql',
    'computedColumnSql',
    'fixedLength',
    'comment',
    'collation',
    'precision',
    'scale',
    'stored',
  ],
  DropColumn: ['name', 'table', 'schema'],
  RenameColumn: ['name', 'table', 'newName', 'schema'],
  CreateIndex: [
    'name',
    'table',
    'columns',
    'schema',
    'unique',
    'filter',
    'descending',
  ],
  DropIndex: ['name', 'table', 'schema'],
  RenameIndex: ['name', 'newName', 'table', 'schema'],
  AddForeignKey: [
    'name',
    'table',
    'columns',
    'principalTable',
    'schema',
    'principalSchema',
    'principalColumns',
    'onUpdate',
    'onDelete',
  ],
  DropForeignKey: ['name', 'table', 'schema'],
  AddPrimaryKey: ['name', 'table', 'columns', 'schema'],
  DropPrimaryKey: ['name', 'table', 'schema'],
  AddUniqueConstraint: ['name', 'table', 'columns', 'schema'],
  DropUniqueConstraint: ['name', 'table', 'schema'],
  AddCheckConstraint: ['name', 'table', 'sql', 'schema'],
  DropCheckConstraint: ['name', 'table', 'schema'],
  Sql: ['sql', 'suppressTransaction'],
  // The column builder inside CreateTable.
  Column: [
    'type',
    'unicode',
    'maxLength',
    'rowVersion',
    'name',
    'nullable',
    'defaultValue',
    'defaultValueSql',
    'computedColumnSql',
    'fixedLength',
    'comment',
    'collation',
    'precision',
    'scale',
    'stored',
  ],
  // The constraint builder inside CreateTable.
  ForeignKey: [
    'name',
    'columns',
    'principalTable',
    'principalSchema',
    'principalColumns',
    'onUpdate',
    'onDelete',
  ],
};

/** Calls that change nothing the shared model holds. */
const IGNORED_CALLS: ReadonlySet<string> = new Set([
  'EnsureSchema',
  'DropSchema',
  'AlterDatabase',
  'AlterTable',
  'Annotation',
]);

const SEQUENCE_CALLS: ReadonlySet<string> = new Set([
  'CreateSequence',
  'AlterSequence',
  'DropSequence',
  'RenameSequence',
  'RestartSequence',
]);

const DATA_CALLS: ReadonlySet<string> = new Set([
  'InsertData',
  'UpdateData',
  'DeleteData',
]);

const CONTROL_STATEMENTS: ReadonlySet<string> = new Set([
  'if_statement',
  'for_statement',
  'foreach_statement',
  'while_statement',
  'do_statement',
  'switch_statement',
  'try_statement',
  'using_statement',
  'lock_statement',
]);

const SQL_TABLE: RegExp =
  /\b(?:alter\s+table|create\s+(?:or\s+replace\s+)?(?:table|view)(?:\s+if\s+not\s+exists)?|drop\s+(?:table|view)(?:\s+if\s+exists)?|truncate(?:\s+table)?|insert\s+into|update|delete\s+from|create\s+(?:unique\s+)?index\s+\S+\s+on)\s+[[`"']?([A-Za-z0-9_.]+)/i;

type Arguments = Map<string, SyntaxNode>;

/** Where a migration statement is, for warnings: `Migrations/2024_Initial.cs:12`. */
function placeOf(path: string, node: SyntaxNode): string {
  return `${path}:${node.startPosition.row + 1}`;
}

function shorten(text: string, length: number = 60): string {
  const flat: string = text.replace(/\s+/g, ' ').trim();
  return flat.length > length ? `${flat.slice(0, length - 3)}...` : flat;
}

/** The argument expressions of one call by parameter name, whether they were passed by name or by position. */
function readArguments(call: CsCall, parameters: readonly string[]): Arguments {
  const found: Arguments = new Map();
  const list: SyntaxNode | null = call.node.childForFieldName('arguments');
  let position: number = 0;
  for (const argument of list?.namedChildren ?? []) {
    if (argument.type !== 'argument') {
      continue;
    }
    const label: SyntaxNode | undefined = argument.namedChildren.find(
      (child: SyntaxNode) => child.type === 'name_colon'
    );
    const value: SyntaxNode | undefined = [...argument.namedChildren]
      .reverse()
      .find((child: SyntaxNode) => child.type !== 'name_colon');
    if (value === undefined) {
      continue;
    }
    if (label === undefined) {
      const name: string | undefined = parameters[position];
      position += 1;
      if (name !== undefined) {
        found.set(name, value);
      }
    } else {
      found.set(label.text.replace(/:\s*$/, '').trim(), value);
    }
  }
  return found;
}

function valueOf(args: Arguments, name: string): CsValue | undefined {
  const node: SyntaxNode | undefined = args.get(name);
  return node === undefined ? undefined : evaluate(node, NO_CONSTANTS);
}

function textArgument(args: Arguments, name: string): string | undefined {
  const value: CsValue | undefined = valueOf(args, name);
  return value?.kind === 'string' ? value.value : undefined;
}

function boolArgument(args: Arguments, name: string): boolean | undefined {
  const value: CsValue | undefined = valueOf(args, name);
  return value?.kind === 'bool' ? value.value : undefined;
}

function numberArgument(args: Arguments, name: string): number | undefined {
  const value: CsValue | undefined = valueOf(args, name);
  return value?.kind === 'number' ? value.value : undefined;
}

/** A string or an array of strings (`column: "A"`, `columns: new[] { "A", "B" }`), as a list. */
function textList(
  args: Arguments,
  single: string,
  many: string
): string[] | undefined {
  for (const name of [many, single]) {
    const value: CsValue | undefined = valueOf(args, name);
    if (value?.kind === 'string') {
      return [value.value];
    }
    if (
      value?.kind === 'array' &&
      value.items.every((item: CsValue) => item.kind === 'string')
    ) {
      return value.items.map((item: CsValue) =>
        item.kind === 'string' ? item.value : ''
      );
    }
  }
  return undefined;
}

function boolList(args: Arguments, name: string): boolean[] {
  const value: CsValue | undefined = valueOf(args, name);
  if (value?.kind !== 'array') {
    return [];
  }
  return value.items.map((item: CsValue) => item.kind === 'bool' && item.value);
}

/** The referential action of `onDelete: ReferentialAction.Cascade`; the database default when it is not given. */
function actionArgument(args: Arguments, name: string): IrOnDelete | undefined {
  const value: CsValue | undefined = valueOf(args, name);
  if (value === undefined) {
    return 'noAction';
  }
  if (value.kind === 'member') {
    return referentialAction(value.path[value.path.length - 1] ?? '');
  }
  return undefined;
}

/** What `.Annotation("key", value)` calls after a column, index or table say. */
function annotationsOf(chain: CsChain): Map<string, CsValue> {
  const found: Map<string, CsValue> = new Map();
  for (const call of chain.calls) {
    if (call.name !== 'Annotation') {
      continue;
    }
    const key: SyntaxNode | undefined = call.args[0];
    const value: SyntaxNode | undefined = call.args[1];
    if (key === undefined || value === undefined) {
      continue;
    }
    const name: CsValue = evaluate(key, NO_CONSTANTS);
    if (name.kind === 'string') {
      found.set(name.value, evaluate(value, NO_CONSTANTS));
    }
  }
  return found;
}

/** True when the annotations of a column make it an identity, serial or autoincrement column. */
export function identityOf(annotations: ReadonlyMap<string, CsValue>): boolean {
  for (const [key, value] of annotations) {
    if (/:(?:Identity|Autoincrement)$/i.test(key)) {
      return !(value.kind === 'bool' && !value.value);
    }
    if (/:ValueGenerationStrategy$/i.test(key)) {
      const text: string =
        value.kind === 'member'
          ? value.path.join('.')
          : value.kind === 'string'
            ? value.value
            : '';
      return /Identity|Serial/i.test(text);
    }
  }
  return false;
}

/** The index settings the provider annotations carry: the access method and the covering columns. */
export interface IndexAnnotations {
  method?: string;
  includes: string[];
}

export function indexAnnotations(
  annotations: ReadonlyMap<string, CsValue>
): IndexAnnotations {
  let method: string | undefined;
  let includes: string[] = [];
  for (const [key, value] of annotations) {
    if (/:IndexMethod$/i.test(key) && value.kind === 'string') {
      method = value.value;
    }
    if (/:(?:Include|IndexInclude)$/i.test(key) && value.kind === 'array') {
      includes = value.items.map((item: CsValue) =>
        item.kind === 'string' ? item.value : ''
      );
    }
  }
  return { ...(method === undefined ? {} : { method }), includes };
}

/** The column named by the arguments of `Column<T>(...)`, `AddColumn<T>(...)` or `AlterColumn<T>(...)`. */
function columnOf(
  name: string,
  clrType: CsType | undefined,
  args: Arguments,
  chain: CsChain
): MigrationColumn {
  const storeType: string | undefined = textArgument(args, 'type');
  const maxLength: number | undefined = numberArgument(args, 'maxLength');
  const precision: number | undefined = numberArgument(args, 'precision');
  const scale: number | undefined = numberArgument(args, 'scale');
  const isUnicode: boolean | undefined = boolArgument(args, 'unicode');
  const defaultValue: CsValue | undefined = valueOf(args, 'defaultValue');
  const defaultSql: string | undefined = textArgument(args, 'defaultValueSql');
  const computedSql: string | undefined = textArgument(
    args,
    'computedColumnSql'
  );
  const isStored: boolean | undefined = boolArgument(args, 'stored');
  return {
    name,
    clrType,
    isNullable: boolArgument(args, 'nullable') === true,
    isRowVersion: boolArgument(args, 'rowVersion') === true,
    isIdentity: identityOf(annotationsOf(chain)),
    ...(storeType === undefined ? {} : { storeType }),
    ...(maxLength === undefined ? {} : { maxLength }),
    ...(precision === undefined ? {} : { precision }),
    ...(scale === undefined ? {} : { scale }),
    ...(isUnicode === undefined ? {} : { isUnicode }),
    ...(defaultValue === undefined || defaultValue.kind === 'null'
      ? {}
      : { defaultValue }),
    ...(defaultSql === undefined ? {} : { defaultSql }),
    ...(computedSql === undefined ? {} : { computedSql }),
    ...(isStored === undefined ? {} : { isStored }),
  };
}

/** Drops the CLR default (`""`, 0, false, 0m, an empty Guid) that EF Core writes to fill existing rows. */
function withoutBackfill(column: MigrationColumn): MigrationColumn {
  const value: CsValue | undefined = column.defaultValue;
  if (value === undefined || column.isNullable) {
    return column;
  }
  const isZero: boolean =
    (value.kind === 'string' && value.value === '') ||
    (value.kind === 'number' && value.value === 0) ||
    (value.kind === 'bool' && !value.value) ||
    (value.kind === 'other' &&
      /^(?:new\s+(?:byte\[\s*0\s*\]|Guid\(\s*"0{8}-0{4}-0{4}-0{4}-0{12}"\s*\)|DateTime\(\s*1,\s*1,\s*1,\s*0,\s*0,\s*0,\s*0(?:,\s*DateTimeKind\.\w+)?\s*\)|TimeSpan\(\s*0(?:,\s*0)*\s*\)|DateTimeOffset\(\s*0\s*,\s*TimeSpan\.Zero\s*\))|Guid\.Empty|TimeSpan\.Zero)/.test(
        value.text
      ));
  if (!isZero) {
    return column;
  }
  const rest: MigrationColumn = { ...column };
  delete rest.defaultValue;
  return rest;
}

interface ReplayContext {
  path: string;
  schema: MigrationSchema;
  warn: (message: string) => void;
  /** Number of schema changes made so far, so a control statement can tell whether it changed anything. */
  changes: number;
}

function lookupTable(
  ctx: ReplayContext,
  node: SyntaxNode,
  operation: string,
  schema: string | undefined,
  name: string | undefined
): MigrationTable | undefined {
  if (name === undefined) {
    ctx.warn(
      `${placeOf(ctx.path, node)}: ${operation} names no table, so it was skipped.`
    );
    return undefined;
  }
  const table: MigrationTable | undefined = ctx.schema.get(
    tableKey(schema, name)
  );
  if (table === undefined) {
    ctx.warn(
      `${placeOf(ctx.path, node)}: ${operation} refers to the table "${name}", which no earlier migration creates; the change was skipped.`
    );
  }
  return table;
}

/** Finds an index or constraint by name when the call does not name its table. */
function tableWith(
  ctx: ReplayContext,
  schema: string | undefined,
  table: string | undefined,
  has: (candidate: MigrationTable) => boolean
): MigrationTable | undefined {
  if (table !== undefined) {
    return ctx.schema.get(tableKey(schema, table));
  }
  return [...ctx.schema.values()].find(has);
}

/** Reads `x => x.A` or `x => new { x.A, x.B }` into column names, through the property-to-column map. */
function selectColumns(
  node: SyntaxNode | undefined,
  columns: ReadonlyMap<string, string>
): string[] | undefined {
  if (node === undefined) {
    return undefined;
  }
  const members: string[] | undefined = selectedMembers(node, NO_CONSTANTS);
  return members?.map((member: string) => columns.get(member) ?? member);
}

function createTable(
  call: CsCall,
  ctx: ReplayContext,
  statement: SyntaxNode
): void {
  const place: string = placeOf(ctx.path, statement);
  const args: Arguments = readArguments(call, PARAMETERS['CreateTable'] ?? []);
  const name: string | undefined = textArgument(args, 'name');
  if (name === undefined) {
    ctx.warn(`${place}: CreateTable has no table name, so it was skipped.`);
    return;
  }
  const schemaName: string | undefined = textArgument(args, 'schema');
  const table: MigrationTable = {
    name,
    columns: [],
    uniqueKeys: [],
    indexes: [],
    foreignKeys: [],
    checkConstraints: [],
    ...(schemaName === undefined ? {} : { schema: schemaName }),
  };
  const key: string = tableKey(schemaName, name);
  if (ctx.schema.has(key)) {
    ctx.warn(
      `${place}: CreateTable creates the table "${name}" again; the earlier definition was replaced.`
    );
  }
  const columnNames: Map<string, string> = new Map();
  const columnsNode: SyntaxNode | undefined = args.get('columns');
  const lambda: CsLambda | undefined =
    columnsNode === undefined ? undefined : readLambda(columnsNode);
  const body: SyntaxNode | undefined = lambda?.body;
  if (
    lambda === undefined ||
    body === undefined ||
    body.type !== 'anonymous_object_creation_expression'
  ) {
    ctx.warn(
      `${place}: the columns of the table "${name}" are not written as table => new { ... }, so none were read.`
    );
  } else {
    readColumnList(body, table, columnNames, ctx);
  }
  const constraints: SyntaxNode | undefined = args.get('constraints');
  const constraintLambda: CsLambda | undefined =
    constraints === undefined ? undefined : readLambda(constraints);
  if (constraintLambda !== undefined) {
    for (const item of bodyStatements(constraintLambda.body)) {
      const expression: SyntaxNode | undefined =
        item.type === 'expression_statement'
          ? (item.namedChild(0) ?? undefined)
          : item;
      const chain: CsChain | undefined =
        expression === undefined ? undefined : flattenChain(expression);
      const first: CsCall | undefined = chain?.calls[0];
      if (chain === undefined || first === undefined) {
        continue;
      }
      readConstraint(first, table, columnNames, ctx, item);
    }
  }
  ctx.schema.set(key, table);
  ctx.changes += 1;
}

/** Reads `table => new { Id = table.Column<int>(...), Name = table.Column<string>(...) }`. */
function readColumnList(
  body: SyntaxNode,
  table: MigrationTable,
  columnNames: Map<string, string>,
  ctx: ReplayContext
): void {
  const children: SyntaxNode[] = body.namedChildren.flatMap(
    (child: SyntaxNode): SyntaxNode[] =>
      child.type === 'anonymous_object_member_declarator'
        ? child.namedChildren
        : [child]
  );
  for (let at: number = 0; at < children.length; at += 1) {
    const label: SyntaxNode | undefined = children[at];
    const expression: SyntaxNode | undefined = children[at + 1];
    if (label === undefined || label.type !== 'name_equals') {
      continue;
    }
    at += 1;
    const propertyName: string = label.namedChild(0)?.text ?? label.text;
    const chain: CsChain | undefined =
      expression === undefined ? undefined : flattenChain(expression);
    const call: CsCall | undefined = chain?.calls[0];
    if (chain === undefined || call === undefined || call.name !== 'Column') {
      ctx.warn(
        `${placeOf(ctx.path, label)}: the column "${propertyName}" of the table "${table.name}" is not written as table.Column<T>(...), so it was skipped.`
      );
      continue;
    }
    const args: Arguments = readArguments(call, PARAMETERS['Column'] ?? []);
    const name: string = textArgument(args, 'name') ?? propertyName;
    columnNames.set(propertyName, name);
    table.columns.push(columnOf(name, call.typeArgs[0], args, chain));
  }
}

function readConstraint(
  call: CsCall,
  table: MigrationTable,
  columnNames: ReadonlyMap<string, string>,
  ctx: ReplayContext,
  statement: SyntaxNode
): void {
  const place: string = placeOf(ctx.path, statement);
  switch (call.name) {
    case 'PrimaryKey':
    case 'UniqueConstraint': {
      const args: Arguments = readArguments(call, ['name', 'columns']);
      const columns: string[] | undefined = selectColumns(
        args.get('columns'),
        columnNames
      );
      const name: string | undefined = textArgument(args, 'name');
      if (columns === undefined) {
        ctx.warn(
          `${place}: the columns of the ${call.name === 'PrimaryKey' ? 'primary key' : 'unique constraint'} of the table "${table.name}" could not be read, so it was skipped.`
        );
        return;
      }
      const key: MigrationKey = {
        columns,
        ...(name === undefined ? {} : { name }),
      };
      if (call.name === 'PrimaryKey') {
        table.primaryKey = key;
      } else {
        table.uniqueKeys.push(key);
      }
      return;
    }
    case 'ForeignKey': {
      const args: Arguments = readArguments(
        call,
        PARAMETERS['ForeignKey'] ?? []
      );
      const columns: string[] | undefined = selectColumns(
        args.get('columns') ?? args.get('column'),
        columnNames
      );
      const principalTable: string | undefined = textArgument(
        args,
        'principalTable'
      );
      if (columns === undefined || principalTable === undefined) {
        ctx.warn(
          `${place}: a foreign key of the table "${table.name}" could not be read, so it was skipped.`
        );
        return;
      }
      pushForeignKey(table, args, columns, principalTable, ctx, statement);
      return;
    }
    case 'CheckConstraint': {
      const args: Arguments = readArguments(call, ['name', 'sql']);
      table.checkConstraints.push(textArgument(args, 'name') ?? 'check');
      return;
    }
    default:
      ctx.warn(
        `${place}: table.${call.name}(...) in CreateTable of "${table.name}" is not known and was skipped.`
      );
  }
}

function pushForeignKey(
  table: MigrationTable,
  args: Arguments,
  columns: string[],
  principalTable: string,
  ctx: ReplayContext,
  statement: SyntaxNode
): void {
  const place: string = placeOf(ctx.path, statement);
  const principalSchema: string | undefined = textArgument(
    args,
    'principalSchema'
  );
  const onDelete: IrOnDelete | undefined = actionArgument(args, 'onDelete');
  const onUpdate: IrOnDelete | undefined = actionArgument(args, 'onUpdate');
  if (onDelete === undefined || onUpdate === undefined) {
    ctx.warn(
      `${place}: the referential action of a foreign key on "${table.name}" (${columns.join(', ')}) is not a ReferentialAction member; NO ACTION was used.`
    );
  }
  // Without column names the key references the primary key of the principal table.
  const principalColumns: string[] =
    textList(args, 'principalColumn', 'principalColumns') ?? [];
  const name: string | undefined = textArgument(args, 'name');
  const foreignKey: MigrationForeignKey = {
    name: name ?? '',
    columns,
    principalTable,
    principalColumns,
    onDelete: onDelete ?? 'noAction',
    onUpdate: onUpdate ?? 'noAction',
    ...(principalSchema === undefined ? {} : { principalSchema }),
  };
  table.foreignKeys.push(foreignKey);
}

/** Applies one `migrationBuilder.X(...)` call. */
function applyCall(
  chain: CsChain,
  ctx: ReplayContext,
  statement: SyntaxNode
): void {
  const call: CsCall | undefined = chain.calls[0];
  if (call === undefined) {
    return;
  }
  const place: string = placeOf(ctx.path, statement);
  const parameters: readonly string[] = PARAMETERS[call.name] ?? [];
  const args: Arguments = readArguments(call, parameters);
  const schemaName: string | undefined = textArgument(args, 'schema');
  const name: string | undefined = textArgument(args, 'name');
  const tableName: string | undefined = textArgument(args, 'table');
  ctx.changes += 1;
  switch (call.name) {
    case 'CreateTable':
      createTable(call, ctx, statement);
      return;
    case 'DropTable': {
      const table: MigrationTable | undefined = lookupTable(
        ctx,
        statement,
        'DropTable',
        schemaName,
        name
      );
      if (table === undefined) {
        return;
      }
      ctx.schema.delete(tableKey(table.schema, table.name));
      for (const other of ctx.schema.values()) {
        const before: number = other.foreignKeys.length;
        other.foreignKeys = other.foreignKeys.filter(
          (key: MigrationForeignKey) =>
            !(
              key.principalTable === table.name &&
              key.principalSchema === table.schema
            )
        );
        if (other.foreignKeys.length !== before) {
          ctx.warn(
            `${place}: DropTable "${table.name}" also removed the foreign keys of "${other.name}" that referenced it; the migration did not drop them first.`
          );
        }
      }
      return;
    }
    case 'RenameTable': {
      const table: MigrationTable | undefined = lookupTable(
        ctx,
        statement,
        'RenameTable',
        schemaName,
        name
      );
      const newName: string | undefined = textArgument(args, 'newName');
      if (table === undefined) {
        return;
      }
      if (newName === undefined && !args.has('newSchema')) {
        ctx.warn(
          `${place}: RenameTable "${table.name}" names neither a new name nor a new schema, so it changed nothing.`
        );
        return;
      }
      renameTable(
        ctx.schema,
        table,
        // A table stays in its schema only when the call says so: EF Core moves it to the default schema otherwise.
        textArgument(args, 'newSchema'),
        newName ?? table.name
      );
      return;
    }
    case 'AddColumn':
    case 'AlterColumn': {
      const table: MigrationTable | undefined = lookupTable(
        ctx,
        statement,
        `${call.name} "${name ?? '?'}"`,
        schemaName,
        tableName
      );
      if (table === undefined || name === undefined) {
        return;
      }
      const fullArgs: Arguments = readArguments(
        call,
        PARAMETERS['AddColumn'] ?? []
      );
      const made: MigrationColumn = columnOf(
        name,
        call.typeArgs[0],
        fullArgs,
        chain
      );
      // EF Core fills the rows that exist with the CLR default when it adds a column that is not nullable or makes
      // a nullable one so; that default is a step of the migration, not part of the model.
      const column: MigrationColumn =
        call.name === 'AddColumn' ||
        (boolArgument(args, 'oldNullable') === true && !made.isNullable)
          ? withoutBackfill(made)
          : made;
      const existing: MigrationColumn | undefined = findColumn(table, name);
      if (call.name === 'AddColumn') {
        if (existing !== undefined) {
          ctx.warn(
            `${place}: AddColumn adds "${table.name}"."${name}", which already exists; the column was replaced.`
          );
          table.columns[table.columns.indexOf(existing)] = column;
        } else {
          table.columns.push(column);
        }
      } else if (existing === undefined) {
        ctx.warn(
          `${place}: AlterColumn changes "${table.name}"."${name}", which no earlier migration adds; the column was added.`
        );
        table.columns.push(column);
      } else {
        table.columns[table.columns.indexOf(existing)] = column;
      }
      return;
    }
    case 'DropColumn': {
      const table: MigrationTable | undefined = lookupTable(
        ctx,
        statement,
        `DropColumn "${name ?? '?'}"`,
        schemaName,
        tableName
      );
      if (table === undefined || name === undefined) {
        return;
      }
      if (findColumn(table, name) === undefined) {
        ctx.warn(
          `${place}: DropColumn removes "${table.name}"."${name}", which no earlier migration adds.`
        );
        return;
      }
      dropColumn(table, name);
      return;
    }
    case 'RenameColumn': {
      const table: MigrationTable | undefined = lookupTable(
        ctx,
        statement,
        `RenameColumn "${name ?? '?'}"`,
        schemaName,
        tableName
      );
      const newName: string | undefined = textArgument(args, 'newName');
      if (table === undefined || name === undefined || newName === undefined) {
        return;
      }
      if (findColumn(table, name) === undefined) {
        ctx.warn(
          `${place}: RenameColumn renames "${table.name}"."${name}", which no earlier migration adds.`
        );
        return;
      }
      renameColumn(ctx.schema, table, name, newName);
      return;
    }
    case 'CreateIndex': {
      const table: MigrationTable | undefined = lookupTable(
        ctx,
        statement,
        `CreateIndex "${name ?? '?'}"`,
        schemaName,
        tableName
      );
      const columns: string[] | undefined = textList(args, 'column', 'columns');
      if (table === undefined || name === undefined) {
        return;
      }
      if (columns === undefined) {
        ctx.warn(
          `${place}: the columns of the index "${name}" on "${table.name}" could not be read, so it was skipped.`
        );
        return;
      }
      const filter: string | undefined = textArgument(args, 'filter');
      const extra: IndexAnnotations = indexAnnotations(annotationsOf(chain));
      const index: MigrationIndex = {
        name,
        columns,
        isUnique: boolArgument(args, 'unique') === true,
        includes: extra.includes,
        descending: boolList(args, 'descending'),
        ...(filter === undefined ? {} : { filter }),
        ...(extra.method === undefined ? {} : { method: extra.method }),
      };
      table.indexes = table.indexes.filter(
        (item: MigrationIndex) => item.name !== name
      );
      table.indexes.push(index);
      return;
    }
    case 'DropIndex': {
      const table: MigrationTable | undefined = tableWith(
        ctx,
        schemaName,
        tableName,
        (candidate: MigrationTable) =>
          candidate.indexes.some((item: MigrationIndex) => item.name === name)
      );
      if (
        table === undefined ||
        name === undefined ||
        !table.indexes.some((item: MigrationIndex) => item.name === name)
      ) {
        ctx.warn(
          `${place}: DropIndex "${name ?? '?'}" refers to an index that no earlier migration creates.`
        );
        return;
      }
      table.indexes = table.indexes.filter(
        (item: MigrationIndex) => item.name !== name
      );
      return;
    }
    case 'RenameIndex': {
      const newName: string | undefined = textArgument(args, 'newName');
      const table: MigrationTable | undefined = tableWith(
        ctx,
        schemaName,
        tableName,
        (candidate: MigrationTable) =>
          candidate.indexes.some((item: MigrationIndex) => item.name === name)
      );
      const index: MigrationIndex | undefined = table?.indexes.find(
        (item: MigrationIndex) => item.name === name
      );
      if (index === undefined || newName === undefined) {
        ctx.warn(
          `${place}: RenameIndex "${name ?? '?'}" refers to an index that no earlier migration creates.`
        );
        return;
      }
      index.name = newName;
      return;
    }
    case 'AddForeignKey': {
      const table: MigrationTable | undefined = lookupTable(
        ctx,
        statement,
        `AddForeignKey "${name ?? '?'}"`,
        schemaName,
        tableName
      );
      const columns: string[] | undefined = textList(args, 'column', 'columns');
      const principalTable: string | undefined = textArgument(
        args,
        'principalTable'
      );
      if (table === undefined) {
        return;
      }
      if (columns === undefined || principalTable === undefined) {
        ctx.warn(
          `${place}: the foreign key "${name ?? '?'}" on "${table.name}" could not be read, so it was skipped.`
        );
        return;
      }
      table.foreignKeys = table.foreignKeys.filter(
        (item: MigrationForeignKey) => item.name !== name
      );
      pushForeignKey(table, args, columns, principalTable, ctx, statement);
      return;
    }
    case 'DropForeignKey': {
      const table: MigrationTable | undefined = tableWith(
        ctx,
        schemaName,
        tableName,
        (candidate: MigrationTable) =>
          candidate.foreignKeys.some(
            (item: MigrationForeignKey) => item.name === name
          )
      );
      if (
        table === undefined ||
        !table.foreignKeys.some(
          (item: MigrationForeignKey) => item.name === name
        )
      ) {
        ctx.warn(
          `${place}: DropForeignKey "${name ?? '?'}" refers to a foreign key that no earlier migration creates.`
        );
        return;
      }
      table.foreignKeys = table.foreignKeys.filter(
        (item: MigrationForeignKey) => item.name !== name
      );
      return;
    }
    case 'AddPrimaryKey':
    case 'AddUniqueConstraint': {
      const table: MigrationTable | undefined = lookupTable(
        ctx,
        statement,
        `${call.name} "${name ?? '?'}"`,
        schemaName,
        tableName
      );
      const columns: string[] | undefined = textList(args, 'column', 'columns');
      if (table === undefined) {
        return;
      }
      if (columns === undefined) {
        ctx.warn(
          `${place}: the columns of ${call.name} "${name ?? '?'}" on "${table.name}" could not be read, so it was skipped.`
        );
        return;
      }
      const key: MigrationKey = {
        columns,
        ...(name === undefined ? {} : { name }),
      };
      if (call.name === 'AddPrimaryKey') {
        table.primaryKey = key;
      } else {
        table.uniqueKeys.push(key);
      }
      return;
    }
    case 'DropPrimaryKey': {
      const table: MigrationTable | undefined = lookupTable(
        ctx,
        statement,
        'DropPrimaryKey',
        schemaName,
        tableName
      );
      if (table !== undefined) {
        delete table.primaryKey;
      }
      return;
    }
    case 'DropUniqueConstraint': {
      const table: MigrationTable | undefined = tableWith(
        ctx,
        schemaName,
        tableName,
        (candidate: MigrationTable) =>
          candidate.uniqueKeys.some((item: MigrationKey) => item.name === name)
      );
      if (
        table === undefined ||
        !table.uniqueKeys.some((item: MigrationKey) => item.name === name)
      ) {
        ctx.warn(
          `${place}: DropUniqueConstraint "${name ?? '?'}" refers to a constraint that no earlier migration creates.`
        );
        return;
      }
      table.uniqueKeys = table.uniqueKeys.filter(
        (item: MigrationKey) => item.name !== name
      );
      return;
    }
    case 'AddCheckConstraint': {
      const table: MigrationTable | undefined = lookupTable(
        ctx,
        statement,
        `AddCheckConstraint "${name ?? '?'}"`,
        schemaName,
        tableName
      );
      table?.checkConstraints.push(name ?? 'check');
      return;
    }
    case 'DropCheckConstraint': {
      const table: MigrationTable | undefined = tableWith(
        ctx,
        schemaName,
        tableName,
        (candidate: MigrationTable) =>
          candidate.checkConstraints.includes(name ?? '')
      );
      if (table !== undefined) {
        table.checkConstraints = table.checkConstraints.filter(
          (item: string) => item !== name
        );
      }
      return;
    }
    case 'Sql': {
      const sql: string | undefined = textArgument(args, 'sql');
      const tableMatch: RegExpExecArray | null =
        sql === undefined ? null : SQL_TABLE.exec(sql);
      ctx.warn(
        `${place}: the raw SQL "${shorten(sql ?? statement.text)}"${tableMatch?.[1] === undefined ? '' : ` on the table "${tableMatch[1]}"`} (migrationBuilder.Sql) is not interpreted; the rebuilt schema may differ from the real database.`
      );
      return;
    }
    default:
      break;
  }
  if (IGNORED_CALLS.has(call.name)) {
    ctx.changes -= 1;
  } else if (SEQUENCE_CALLS.has(call.name)) {
    ctx.warn(
      `${place}: ${call.name}${name === undefined ? '' : ` "${name}"`} changes a sequence, which the shared model cannot hold; it was skipped.`
    );
  } else if (DATA_CALLS.has(call.name)) {
    const target: string | undefined = textArgument(args, 'table');
    ctx.warn(
      `${place}: ${call.name}${target === undefined ? '' : ` on the table "${target}"`} changes rows, not the schema (seed data is not preserved).`
    );
  } else {
    ctx.warn(
      `${place}: migrationBuilder.${call.name}(...) is not known and was skipped.`
    );
  }
}

/** Runs the statements of an `Up` body, descending into `if`, loops and `try` with a warning when they change the schema. */
function replayStatements(
  statements: readonly SyntaxNode[],
  builder: string,
  ctx: ReplayContext
): void {
  for (const statement of statements) {
    if (statement.type === 'expression_statement') {
      const expression: SyntaxNode | null = statement.namedChild(0);
      const chain: CsChain | undefined =
        expression === null ? undefined : flattenChain(expression);
      if (chain !== undefined && chain.root.text === builder) {
        applyCall(chain, ctx, statement);
      }
      continue;
    }
    if (CONTROL_STATEMENTS.has(statement.type)) {
      const before: number = ctx.changes;
      const nested: SyntaxNode[] = statement.namedChildren.filter(
        (child: SyntaxNode) => child.type === 'block'
      );
      // Only the first block runs: the `if` branch, the loop body, the `try` body. An `else` is not applied.
      const first: SyntaxNode | undefined = nested[0];
      if (first !== undefined) {
        replayStatements(bodyStatements(first), builder, ctx);
      }
      if (ctx.changes !== before || nested.length > 1) {
        ctx.warn(
          `${placeOf(ctx.path, statement)}: ${statement.type.replace(/_statement$/, '')} contains schema changes; the first block was applied as if it always ran` +
            `${nested.length > 1 ? ' and the other blocks were skipped' : ''}, so the result may differ from the real database.`
        );
      }
    }
  }
}

/** Finds the migration classes of a file: classes that derive from `Migration` and have an `Up` method. */
export function findMigrations(
  classes: readonly CsClass[],
  path: string
): MigrationClassInfo[] {
  const found: MigrationClassInfo[] = [];
  for (const cls of classes) {
    if (!cls.bases.some((base: CsType) => base.name === 'Migration')) {
      continue;
    }
    const up: CsMethod | undefined = cls.methods.find(
      (method: CsMethod) => method.name === 'Up'
    );
    if (up?.body === undefined) {
      continue;
    }
    const attribute: CsAttribute | undefined = cls.attributes.find(
      (item: CsAttribute) => item.name === 'Migration'
    );
    const declared: CsValue | undefined =
      attribute?.args[0] === undefined
        ? undefined
        : evaluate(attribute.args[0], NO_CONSTANTS);
    const base: string = path.split(/[\\/]/).pop() ?? path;
    found.push({
      path,
      className: cls.name,
      id:
        declared?.kind === 'string'
          ? declared.value
          : base.replace(/\.cs$/i, ''),
      up: up.body,
      builder: up.parameters[0]?.name ?? 'migrationBuilder',
    });
  }
  return found;
}

/** Replays the `Up` method of one migration into the schema. */
export function replayMigration(
  migration: MigrationClassInfo,
  schema: MigrationSchema,
  warn: (message: string) => void
): void {
  const ctx: ReplayContext = {
    path: migration.path,
    schema,
    warn,
    changes: 0,
  };
  replayStatements(bodyStatements(migration.up), migration.builder, ctx);
}
