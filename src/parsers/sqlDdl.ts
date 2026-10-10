import { basename } from 'node:path';
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
import { singularize, toPascalCase, toSnakeCase } from '../naming.js';
import { describeThrown, err, ok, type Result } from '../result.js';
import {
  Cursor,
  detectDialect,
  MAX_SOURCE_CHARACTERS,
  sourceOf,
  splitStatements,
  splitTopLevel,
  tokenize,
  type SqlDialect,
  type Token,
  type TokenizeResult,
} from './sqlSyntax.js';
import {
  defaultExpression,
  interpretDefault,
  mapType,
  parseType,
  type MappedType,
  type RawType,
} from './sqlTypes.js';

export interface SqlDdlSourceFile {
  path: string;
  text: string;
}

export interface SqlDdlParseOptions {
  /** App label stored on each model (SQL itself has no equivalent). */
  appLabel: string;
  /** Reads every file as this dialect instead of guessing it from the text. */
  dialect?: SqlDialect;
}

// ---------------------------------------------------------------------------
// Raw (syntactic) model
// ---------------------------------------------------------------------------

interface RawReference {
  name?: string;
  columns: string[];
  refSchema?: string;
  refTable: string;
  refColumns: string[];
  onDelete?: IrOnDelete;
  onUpdate?: IrOnDelete;
  line: number;
}

interface RawCheck {
  name?: string;
  tokens: Token[];
  text: string;
}

interface RawColumn {
  name: string;
  type: RawType;
  /** True for NOT NULL, false for an explicit NULL, undefined when not stated. */
  notNull: boolean | undefined;
  /** Tokens of the DEFAULT expression, without the DEFAULT keyword. */
  defaultTokens?: Token[];
  defaultText?: string;
  autoIncrement: boolean;
  onUpdateNow: boolean;
  generated?: { expression: string; isStored: boolean };
  line: number;
}

interface RawUnique {
  name?: string;
  columns: string[];
}

interface RawIndexElement {
  column?: string;
  isExpression: boolean;
  descending: boolean;
  length?: number;
  ops?: string;
}

interface RawIndex {
  name?: string;
  elements: RawIndexElement[];
  isUnique: boolean;
  kind?: 'fulltext' | 'spatial';
  method?: string;
  clustered?: boolean;
  isPartial: boolean;
  line: number;
}

interface RawTable {
  schema?: string;
  name: string;
  columns: RawColumn[];
  primaryKey?: { columns: string[]; name?: string };
  uniques: RawUnique[];
  references: RawReference[];
  indexes: RawIndex[];
  checks: RawCheck[];
  withoutRowid: boolean;
  dialect: SqlDialect;
  line: number;
  file: string;
  dropped: boolean;
}

interface RawEnum {
  schema?: string;
  name: string;
  values: string[];
  dropped: boolean;
}

type ConstraintResult =
  | { kind: 'primaryKey'; columns: string[]; name?: string }
  | { kind: 'unique'; columns: string[]; name?: string }
  | { kind: 'reference'; reference: RawReference }
  | { kind: 'check'; check: RawCheck }
  | { kind: 'index'; index: RawIndex }
  | { kind: 'default'; column: string; tokens: Token[]; text: string }
  | { kind: 'ignored' };

interface FileContext {
  /** Base name of the file, for warnings. */
  name: string;
  text: string;
  dialect: SqlDialect;
}

const DEFAULT_SCHEMAS: ReadonlySet<string> = new Set(['public', 'dbo', 'main']);

const MAX_WARNINGS: number = 400;

interface WarningSink {
  push(message: string): void;
}

interface SkippedKind {
  count: number;
  first: string;
}

interface Context {
  tables: RawTable[];
  tableByKey: Map<string, RawTable>;
  /** Tables by lower-case name, for references written without a schema. */
  tablesByName: Map<string, RawTable[]>;
  enums: RawEnum[];
  warnings: string[];
  suppressedWarnings: number;
  skipped: Map<string, SkippedKind>;
}

function warn(ctx: Context, message: string): void {
  if (ctx.warnings.length < MAX_WARNINGS) {
    ctx.warnings.push(message);
  } else {
    ctx.suppressedWarnings += 1;
  }
}

function recordSkipped(
  ctx: Context,
  file: FileContext,
  kind: string,
  line: number
): void {
  const entry: SkippedKind | undefined = ctx.skipped.get(kind);
  if (entry === undefined) {
    ctx.skipped.set(kind, { count: 1, first: `${file.name}:${line}` });
  } else {
    entry.count += 1;
  }
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Reads SQL DDL (PostgreSQL, MySQL / MariaDB, SQLite and SQL Server) into the shared model. Never throws:
 * input it cannot read becomes a warning, or an error result when no table was found at all.
 */
export function parseSqlDdl(
  sources: SqlDdlSourceFile[],
  options: SqlDdlParseOptions
): Result<IrSchema> {
  try {
    return parseSources(sources, options);
  } catch (thrown) {
    return err(
      'PARSE_FAILED',
      `The SQL input could not be converted: ${describeThrown(thrown)}`
    );
  }
}

function parseSources(
  sources: SqlDdlSourceFile[],
  options: SqlDdlParseOptions
): Result<IrSchema> {
  const totalCharacters: number = sources.reduce(
    (sum: number, source: SqlDdlSourceFile) => sum + source.text.length,
    0
  );
  if (totalCharacters > MAX_SOURCE_CHARACTERS) {
    return err(
      'PARSE_FAILED',
      `The SQL input is too large (${totalCharacters} characters; the limit is ${MAX_SOURCE_CHARACTERS}). Split it into smaller files.`
    );
  }
  const ctx: Context = {
    tables: [],
    tableByKey: new Map<string, RawTable>(),
    tablesByName: new Map<string, RawTable[]>(),
    enums: [],
    warnings: [],
    suppressedWarnings: 0,
    skipped: new Map<string, SkippedKind>(),
  };
  for (const source of sources) {
    const dialect: SqlDialect = options.dialect ?? detectDialect(source.text);
    const file: FileContext = {
      name: basename(source.path),
      text: source.text,
      dialect,
    };
    const scanned: TokenizeResult = tokenize(source.text, dialect);
    if (scanned.truncated) {
      warn(
        ctx,
        `${file.name}: the file has too many tokens; everything after the first ${scanned.tokens.length} was ignored.`
      );
    }
    for (const statement of splitStatements(scanned.tokens)) {
      try {
        handleStatement(ctx, file, statement);
      } catch (thrown) {
        warn(
          ctx,
          `${file.name}:${statement[0]?.line ?? 0}: a statement could not be read (${describeThrown(thrown)}) and was skipped.`
        );
      }
    }
  }
  for (const [kind, entry] of ctx.skipped) {
    warn(
      ctx,
      `Skipped ${entry.count} ${kind} statement${entry.count === 1 ? '' : 's'} (first at ${entry.first}): ${describeSkipReason(kind)}`
    );
  }

  const liveTables: RawTable[] = ctx.tables.filter(
    (table: RawTable) => !table.dropped
  );
  if (liveTables.length === 0) {
    return err(
      'NO_MODELS_FOUND',
      'No CREATE TABLE statements were found in the SQL input.'
    );
  }
  const schema: IrSchema = buildSchema(ctx, liveTables, options);
  if (ctx.suppressedWarnings > 0) {
    schema.warnings.push(
      `${ctx.suppressedWarnings} more warnings were not shown.`
    );
  }
  return ok(schema);
}

function describeSkipReason(kind: string): string {
  if (kind === 'data') {
    return 'row data is not part of the schema.';
  }
  if (/^CREATE (OR REPLACE )?(MATERIALIZED )?VIEW/.test(kind)) {
    return 'views are not read.';
  }
  if (kind.startsWith('ALTER TABLE')) {
    return 'the change is not replayed, so the result may differ from the final database.';
  }
  return 'it has no equivalent in the shared model.';
}

// ---------------------------------------------------------------------------
// Statements
// ---------------------------------------------------------------------------

/** Statements that never matter to the schema and are skipped without a warning. */
const QUIET_STATEMENTS: ReadonlySet<string> = new Set([
  'SET',
  'USE',
  'GRANT',
  'REVOKE',
  'BEGIN',
  'START',
  'COMMIT',
  'END',
  'ROLLBACK',
  'SAVEPOINT',
  'RELEASE',
  'PRAGMA',
  'LOCK',
  'UNLOCK',
  'COMMENT',
  'ANALYZE',
  'VACUUM',
  'REINDEX',
  'CLUSTER',
  'RESET',
  'PRINT',
  'DECLARE',
  'GO',
  'SHOW',
  'DO',
  'EXEC',
  'EXECUTE',
  'CHECKPOINT',
  'DISCARD',
]);

/** Data statements, reported together as one warning. */
const DATA_STATEMENTS: ReadonlySet<string> = new Set([
  'INSERT',
  'UPDATE',
  'DELETE',
  'SELECT',
  'COPY',
  'TRUNCATE',
  'MERGE',
  'REPLACE',
  'WITH',
  'VALUES',
]);

/** CREATE statements with no schema meaning for this reader and no value in warning about. */
const QUIET_CREATES: ReadonlySet<string> = new Set([
  'EXTENSION',
  'SCHEMA',
  'DATABASE',
  'ROLE',
  'USER',
  'TABLESPACE',
  'LANGUAGE',
  'COLLATION',
  'SERVER',
  'LOGIN',
  'CAST',
  'OPERATOR',
  'AGGREGATE',
  'PUBLICATION',
  'SUBSCRIPTION',
  'POLICY',
  'RULE',
]);

function handleStatement(
  ctx: Context,
  file: FileContext,
  tokens: Token[]
): void {
  const cursor: Cursor = new Cursor(tokens);
  const head: Token = cursor.peek();
  const line: number = head.line;
  if (head.kind !== 'word') {
    recordSkipped(ctx, file, 'unrecognised', line);
    return;
  }
  if (QUIET_STATEMENTS.has(head.up)) {
    return;
  }
  if (DATA_STATEMENTS.has(head.up)) {
    recordSkipped(ctx, file, 'data', line);
    return;
  }
  switch (head.up) {
    case 'CREATE':
      handleCreate(ctx, file, cursor);
      return;
    case 'ALTER':
      handleAlter(ctx, file, cursor);
      return;
    case 'DROP':
      handleDrop(ctx, file, cursor);
      return;
    default:
      recordSkipped(ctx, file, head.up, line);
  }
}

function handleCreate(ctx: Context, file: FileContext, cursor: Cursor): void {
  const line: number = cursor.peek().line;
  cursor.next();
  let isTemporary: boolean = false;
  let modifiers: string = '';
  for (;;) {
    const word: Token = cursor.peek();
    if (word.kind !== 'word') {
      break;
    }
    if (word.up === 'OR' && cursor.isKeyword('REPLACE', 1)) {
      modifiers += 'OR REPLACE ';
      cursor.next();
      cursor.next();
    } else if (word.up === 'TEMP' || word.up === 'TEMPORARY') {
      isTemporary = true;
      cursor.next();
    } else if (
      word.up === 'GLOBAL' ||
      word.up === 'LOCAL' ||
      word.up === 'UNLOGGED' ||
      word.up === 'MATERIALIZED'
    ) {
      if (word.up === 'MATERIALIZED') {
        modifiers += 'MATERIALIZED ';
      }
      cursor.next();
    } else {
      break;
    }
  }
  const kind: Token = cursor.peek();
  if (kind.kind !== 'word') {
    recordSkipped(ctx, file, 'unrecognised', line);
    return;
  }
  if (kind.up === 'TABLE') {
    if (isTemporary) {
      recordSkipped(ctx, file, 'CREATE TEMPORARY TABLE', line);
      return;
    }
    createTable(ctx, file, cursor, line);
    return;
  }
  if (
    kind.up === 'INDEX' ||
    kind.up === 'UNIQUE' ||
    kind.up === 'FULLTEXT' ||
    kind.up === 'SPATIAL' ||
    kind.up === 'CLUSTERED' ||
    kind.up === 'NONCLUSTERED' ||
    kind.up === 'COLUMNSTORE' ||
    kind.up === 'BITMAP'
  ) {
    createIndex(ctx, file, cursor, line);
    return;
  }
  if (kind.up === 'TYPE') {
    createType(ctx, file, cursor, line);
    return;
  }
  if (QUIET_CREATES.has(kind.up)) {
    return;
  }
  recordSkipped(ctx, file, `CREATE ${modifiers}${kind.up}`, line);
}

interface QualifiedName {
  schema?: string;
  name: string;
}

function parseQualifiedName(cursor: Cursor): QualifiedName | undefined {
  const parts: string[] = [];
  for (;;) {
    const token: Token = cursor.peek();
    if (token.kind !== 'word' && token.kind !== 'ident') {
      break;
    }
    parts.push(token.value);
    cursor.next();
    if (cursor.isPunct('.')) {
      cursor.next();
      // SQL Server allows an omitted schema: db..table.
      while (cursor.isPunct('.')) {
        cursor.next();
      }
      continue;
    }
    break;
  }
  const name: string | undefined = parts[parts.length - 1];
  if (name === undefined) {
    return undefined;
  }
  const schema: string | undefined = parts[parts.length - 2];
  return schema === undefined ? { name } : { schema, name };
}

/** MySQL names a database where other systems name a schema, so the qualifier is not kept. */
function normalizedSchema(
  name: QualifiedName,
  dialect: SqlDialect
): string | undefined {
  return dialect === 'mysql' ? undefined : name.schema;
}

function tableKey(schema: string | undefined, name: string): string {
  return `${(schema ?? '').toLowerCase()}.${name.toLowerCase()}`;
}

const CONSTRAINT_START_WORDS: ReadonlySet<string> = new Set([
  'NOT',
  'NULL',
  'DEFAULT',
  'PRIMARY',
  'UNIQUE',
  'REFERENCES',
  'CHECK',
  'CONSTRAINT',
  'COLLATE',
  'GENERATED',
  'AS',
  'AUTOINCREMENT',
  'AUTO_INCREMENT',
  'IDENTITY',
  'COMMENT',
  'ON',
]);

function createTable(
  ctx: Context,
  file: FileContext,
  cursor: Cursor,
  line: number
): void {
  cursor.next();
  const ifNotExists: boolean = cursor.acceptKeywords('IF', 'NOT', 'EXISTS');
  const name: QualifiedName | undefined = parseQualifiedName(cursor);
  if (name === undefined) {
    recordSkipped(ctx, file, 'unrecognised', line);
    return;
  }
  const label: string = name.name;
  if (!cursor.isPunct('(')) {
    recordSkipped(
      ctx,
      file,
      cursor.isKeyword('AS')
        ? 'CREATE TABLE ... AS SELECT'
        : cursor.isKeyword('PARTITION')
          ? 'CREATE TABLE ... PARTITION OF'
          : 'CREATE TABLE without a column list',
      line
    );
    return;
  }
  const group: Token[] = cursor.readGroup() ?? [];
  const table: RawTable = {
    ...(normalizedSchema(name, file.dialect) === undefined
      ? {}
      : { schema: normalizedSchema(name, file.dialect) as string }),
    name: name.name,
    columns: [],
    uniques: [],
    references: [],
    indexes: [],
    checks: [],
    withoutRowid: false,
    dialect: file.dialect,
    line,
    file: file.name,
    dropped: false,
  };

  // Table options after the column list.
  while (!cursor.atEnd) {
    const token: Token = cursor.next();
    if (token.kind !== 'word') {
      continue;
    }
    if (token.up === 'WITHOUT' && cursor.isKeyword('ROWID')) {
      table.withoutRowid = true;
    } else if (token.up === 'INHERITS' && cursor.isPunct('(')) {
      warn(
        ctx,
        `table "${label}": INHERITS is not read; the columns of the parent table are not copied.`
      );
    } else if (token.up === 'PARTITION' && cursor.isKeyword('BY')) {
      warn(
        ctx,
        `table "${label}": the partitioning clause is not read; the table is read as an ordinary table.`
      );
    }
  }

  for (const element of splitTopLevel(group)) {
    const parser: Cursor = new Cursor(element);
    if (isConstraintStart(parser, file.dialect)) {
      if (parser.isKeyword('LIKE')) {
        warn(
          ctx,
          `table "${label}": LIKE copies columns from another table and is not read.`
        );
        continue;
      }
      applyConstraint(
        ctx,
        table,
        parseTableConstraint(ctx, file, parser, label)
      );
      continue;
    }
    const column: RawColumn | undefined = parseColumn(
      ctx,
      file,
      parser,
      table,
      label
    );
    if (column === undefined) {
      warn(
        ctx,
        `table "${label}": ${file.name}:${element[0]?.line ?? line}: a column definition could not be read and was skipped.`
      );
    }
  }
  registerTable(ctx, table, ifNotExists);
}

function registerTable(
  ctx: Context,
  table: RawTable,
  ifNotExists: boolean
): void {
  const key: string = tableKey(table.schema, table.name);
  const existing: RawTable | undefined = ctx.tableByKey.get(key);
  if (existing !== undefined && !existing.dropped) {
    if (ifNotExists) {
      return;
    }
    warn(
      ctx,
      `table "${table.name}" is created twice (${existing.file}:${existing.line} and ${table.file}:${table.line}); the later definition is used.`
    );
    existing.dropped = true;
  }
  ctx.tables.push(table);
  ctx.tableByKey.set(key, table);
  const byName: RawTable[] =
    ctx.tablesByName.get(table.name.toLowerCase()) ?? [];
  byName.push(table);
  ctx.tablesByName.set(table.name.toLowerCase(), byName);
}

function isConstraintStart(cursor: Cursor, dialect: SqlDialect): boolean {
  const head: Token = cursor.peek();
  if (head.kind !== 'word') {
    return false;
  }
  const next: Token = cursor.peek(1);
  switch (head.up) {
    case 'CONSTRAINT':
      return true;
    case 'PRIMARY':
    case 'FOREIGN':
      return cursor.isKeyword('KEY', 1);
    case 'UNIQUE':
      return (
        cursor.isPunct('(', 1) ||
        cursor.isKeyword('KEY', 1) ||
        cursor.isKeyword('INDEX', 1) ||
        cursor.isKeyword('CLUSTERED', 1) ||
        cursor.isKeyword('NONCLUSTERED', 1) ||
        ((next.kind === 'word' || next.kind === 'ident') &&
          cursor.isPunct('(', 2))
      );
    case 'CHECK':
      return cursor.isPunct('(', 1);
    case 'EXCLUDE':
      return cursor.isKeyword('USING', 1) || cursor.isPunct('(', 1);
    case 'LIKE':
      return dialect === 'postgresql';
    case 'PERIOD':
      return cursor.isKeyword('FOR', 1);
    case 'KEY':
    case 'INDEX':
    case 'FULLTEXT':
    case 'SPATIAL':
      return dialect === 'mysql';
    default:
      return false;
  }
}

/** Reads the column names of `( a, b DESC, c(10) )`. */
function readColumnList(cursor: Cursor): string[] {
  const group: Token[] | undefined = cursor.readGroup();
  if (group === undefined) {
    return [];
  }
  const names: string[] = [];
  for (const element of splitTopLevel(group)) {
    const first: Token | undefined = element[0];
    if (
      first !== undefined &&
      (first.kind === 'word' || first.kind === 'ident')
    ) {
      names.push(first.value);
    }
  }
  return names;
}

function readIndexElements(group: Token[]): RawIndexElement[] {
  const elements: RawIndexElement[] = [];
  for (const element of splitTopLevel(group)) {
    const first: Token | undefined = element[0];
    if (first === undefined) {
      continue;
    }
    const second: Token | undefined = element[1];
    const isColumnToken: boolean =
      first.kind === 'ident' ||
      (first.kind === 'word' &&
        !(
          second?.kind === 'punct' &&
          second.text === '(' &&
          element.length > 4
        ));
    const isPrefixLength: boolean =
      second?.kind === 'punct' &&
      second.text === '(' &&
      element[2]?.kind === 'number' &&
      element[3]?.kind === 'punct' &&
      element[3].text === ')';
    if (
      !isColumnToken ||
      (second?.kind === 'punct' && second.text === '(' && !isPrefixLength) ||
      (second?.kind === 'punct' && second.text === '.')
    ) {
      elements.push({ isExpression: true, descending: false });
      continue;
    }
    const parsed: RawIndexElement = {
      column: first.value,
      isExpression: false,
      descending: false,
    };
    let at: number = 1;
    if (isPrefixLength) {
      parsed.length = Number(element[2]?.value ?? '0');
      at = 4;
    }
    while (at < element.length) {
      const token: Token | undefined = element[at];
      if (token === undefined) {
        break;
      }
      if (token.kind === 'word' && token.up === 'DESC') {
        parsed.descending = true;
      } else if (token.kind === 'word' && token.up === 'COLLATE') {
        at += 1;
      } else if (token.kind === 'word' && token.up === 'NULLS') {
        at += 1;
      } else if (
        token.kind === 'word' &&
        token.up !== 'ASC' &&
        parsed.ops === undefined
      ) {
        parsed.ops = token.value;
      } else if (token.kind === 'punct' && token.text === '(') {
        let depth: number = 0;
        while (at < element.length) {
          const inner: Token | undefined = element[at];
          if (inner?.kind === 'punct' && inner.text === '(') {
            depth += 1;
          } else if (inner?.kind === 'punct' && inner.text === ')') {
            depth -= 1;
            if (depth === 0) {
              break;
            }
          }
          at += 1;
        }
      }
      at += 1;
    }
    elements.push(parsed);
  }
  return elements;
}

const ACTIONS: Readonly<Record<string, IrOnDelete>> = {
  CASCADE: 'cascade',
  RESTRICT: 'restrict',
};

/** Reads `REFERENCES t (cols) MATCH x ON DELETE a ON UPDATE b DEFERRABLE ...` after the keyword. */
function parseReferences(
  cursor: Cursor,
  columns: string[],
  name: string | undefined,
  line: number
): RawReference | undefined {
  const target: QualifiedName | undefined = parseQualifiedName(cursor);
  if (target === undefined) {
    return undefined;
  }
  const refColumns: string[] = readColumnList(cursor);
  const reference: RawReference = {
    ...(name === undefined ? {} : { name }),
    columns,
    ...(target.schema === undefined ? {} : { refSchema: target.schema }),
    refTable: target.name,
    refColumns,
    line,
  };
  for (;;) {
    if (cursor.isKeyword('MATCH')) {
      cursor.next();
      cursor.next();
    } else if (
      cursor.isKeyword('ON') &&
      (cursor.isKeyword('DELETE', 1) || cursor.isKeyword('UPDATE', 1)) &&
      (cursor.isKeyword('CASCADE', 2) ||
        cursor.isKeyword('RESTRICT', 2) ||
        cursor.isKeyword('SET', 2) ||
        cursor.isKeyword('NO', 2))
    ) {
      cursor.next();
      const which: string = cursor.next().up;
      let action: IrOnDelete;
      if (cursor.acceptKeywords('SET', 'NULL')) {
        action = 'setNull';
      } else if (cursor.acceptKeywords('SET', 'DEFAULT')) {
        action = 'setDefault';
      } else if (cursor.acceptKeywords('NO', 'ACTION')) {
        action = 'noAction';
      } else {
        action = ACTIONS[cursor.next().up] ?? 'noAction';
      }
      if (which === 'DELETE') {
        reference.onDelete = action;
      } else {
        reference.onUpdate = action;
      }
    } else if (
      cursor.isKeyword('NOT') &&
      (cursor.isKeyword('DEFERRABLE', 1) || cursor.isKeyword('ENFORCED', 1))
    ) {
      cursor.next();
      cursor.next();
    } else if (
      cursor.isKeyword('DEFERRABLE') ||
      cursor.isKeyword('ENFORCED') ||
      (cursor.isKeyword('INITIALLY') &&
        (cursor.isKeyword('DEFERRED', 1) || cursor.isKeyword('IMMEDIATE', 1)))
    ) {
      cursor.next();
      if (cursor.isKeyword('DEFERRED') || cursor.isKeyword('IMMEDIATE')) {
        cursor.next();
      }
    } else {
      break;
    }
  }
  return reference;
}

/** Reads a table constraint, or one of the MySQL `KEY` / `FULLTEXT` index forms. */
function parseTableConstraint(
  ctx: Context,
  file: FileContext,
  cursor: Cursor,
  label: string
): ConstraintResult {
  const line: number = cursor.peek().line;
  let name: string | undefined;
  if (cursor.acceptKeyword('CONSTRAINT')) {
    const candidate: Token = cursor.peek();
    if (
      (candidate.kind === 'word' &&
        !['PRIMARY', 'UNIQUE', 'FOREIGN', 'CHECK', 'DEFAULT'].includes(
          candidate.up
        )) ||
      candidate.kind === 'ident'
    ) {
      name = cursor.next().value;
    }
  }
  const head: Token = cursor.peek();
  if (head.kind !== 'word') {
    return { kind: 'ignored' };
  }
  const skipUsing = (): void => {
    if (cursor.isKeyword('USING') && !cursor.isPunct('(', 1)) {
      cursor.next();
      cursor.next();
    }
  };
  switch (head.up) {
    case 'PRIMARY': {
      cursor.next();
      cursor.next();
      cursor.acceptKeyword('CLUSTERED');
      cursor.acceptKeyword('NONCLUSTERED');
      skipUsing();
      const columns: string[] = readColumnList(cursor);
      return {
        kind: 'primaryKey',
        columns,
        ...(name === undefined ? {} : { name }),
      };
    }
    case 'UNIQUE': {
      cursor.next();
      cursor.acceptKeyword('KEY');
      cursor.acceptKeyword('INDEX');
      cursor.acceptKeyword('CLUSTERED');
      cursor.acceptKeyword('NONCLUSTERED');
      const maybeName: Token = cursor.peek();
      if (
        (maybeName.kind === 'word' || maybeName.kind === 'ident') &&
        !cursor.isPunct('(')
      ) {
        if (name === undefined) {
          name = maybeName.value;
        }
        cursor.next();
      }
      skipUsing();
      const columns: string[] = readColumnList(cursor);
      return {
        kind: 'unique',
        columns,
        ...(name === undefined ? {} : { name }),
      };
    }
    case 'FOREIGN': {
      cursor.next();
      cursor.next();
      const maybeName: Token = cursor.peek();
      if (
        (maybeName.kind === 'word' || maybeName.kind === 'ident') &&
        !cursor.isPunct('(')
      ) {
        if (name === undefined) {
          name = maybeName.value;
        }
        cursor.next();
      }
      const columns: string[] = readColumnList(cursor);
      if (!cursor.acceptKeyword('REFERENCES')) {
        warn(
          ctx,
          `table "${label}": ${file.name}:${line}: a FOREIGN KEY without REFERENCES was skipped.`
        );
        return { kind: 'ignored' };
      }
      const reference: RawReference | undefined = parseReferences(
        cursor,
        columns,
        name,
        line
      );
      return reference === undefined
        ? { kind: 'ignored' }
        : { kind: 'reference', reference };
    }
    case 'CHECK': {
      cursor.next();
      const group: Token[] = cursor.readGroup() ?? [];
      return {
        kind: 'check',
        check: {
          ...(name === undefined ? {} : { name }),
          tokens: group,
          text: sourceOf(file.text, group),
        },
      };
    }
    case 'DEFAULT': {
      // SQL Server: ALTER TABLE t ADD CONSTRAINT DF_x DEFAULT (0) FOR col
      cursor.next();
      const expression: Token[] = [];
      while (!cursor.atEnd && !cursor.isKeyword('FOR')) {
        expression.push(cursor.next());
      }
      cursor.acceptKeyword('FOR');
      const column: Token = cursor.peek();
      if (column.kind === 'word' || column.kind === 'ident') {
        return {
          kind: 'default',
          column: column.value,
          tokens: expression,
          text: defaultExpression(expression, file.text),
        };
      }
      return { kind: 'ignored' };
    }
    case 'KEY':
    case 'INDEX':
    case 'FULLTEXT':
    case 'SPATIAL': {
      cursor.next();
      let kind: 'fulltext' | 'spatial' | undefined;
      if (head.up === 'FULLTEXT') {
        kind = 'fulltext';
      } else if (head.up === 'SPATIAL') {
        kind = 'spatial';
      }
      cursor.acceptKeyword('KEY');
      cursor.acceptKeyword('INDEX');
      const maybeName: Token = cursor.peek();
      let indexName: string | undefined = name;
      if (
        (maybeName.kind === 'word' || maybeName.kind === 'ident') &&
        !cursor.isPunct('(') &&
        !(maybeName.kind === 'word' && maybeName.up === 'USING')
      ) {
        indexName = maybeName.value;
        cursor.next();
      }
      skipUsing();
      const group: Token[] = cursor.readGroup() ?? [];
      return {
        kind: 'index',
        index: {
          ...(indexName === undefined ? {} : { name: indexName }),
          elements: readIndexElements(group),
          isUnique: false,
          ...(kind === undefined ? {} : { kind }),
          isPartial: false,
          line,
        },
      };
    }
    case 'EXCLUDE':
      warn(
        ctx,
        `table "${label}": an EXCLUDE constraint has no equivalent in the shared model and was skipped.`
      );
      return { kind: 'ignored' };
    default:
      return { kind: 'ignored' };
  }
}

function applyConstraint(
  ctx: Context,
  table: RawTable,
  result: ConstraintResult
): void {
  switch (result.kind) {
    case 'primaryKey':
      if (result.columns.length === 0) {
        return;
      }
      table.primaryKey = {
        columns: result.columns,
        ...(result.name === undefined ? {} : { name: result.name }),
      };
      return;
    case 'unique':
      if (result.columns.length > 0) {
        table.uniques.push({
          columns: result.columns,
          ...(result.name === undefined ? {} : { name: result.name }),
        });
      }
      return;
    case 'reference':
      table.references.push(result.reference);
      return;
    case 'check':
      table.checks.push(result.check);
      return;
    case 'index':
      table.indexes.push(result.index);
      return;
    case 'default': {
      const column: RawColumn | undefined = table.columns.find(
        (candidate: RawColumn) =>
          candidate.name.toLowerCase() === result.column.toLowerCase()
      );
      if (column === undefined) {
        warn(
          ctx,
          `table "${table.name}": a DEFAULT for the unknown column "${result.column}" was ignored.`
        );
        return;
      }
      column.defaultTokens = result.tokens;
      column.defaultText = result.text;
      return;
    }
    default:
      return;
  }
}

/** Words that end a DEFAULT expression when they appear outside parentheses. */
const DEFAULT_STOP_WORDS: ReadonlySet<string> = new Set([
  'NOT',
  'NULL',
  'PRIMARY',
  'UNIQUE',
  'REFERENCES',
  'CHECK',
  'CONSTRAINT',
  'COLLATE',
  'GENERATED',
  'COMMENT',
  'ON',
  'AUTO_INCREMENT',
  'AUTOINCREMENT',
  'IDENTITY',
]);

function readDefault(cursor: Cursor): Token[] {
  const tokens: Token[] = [];
  let depth: number = 0;
  while (!cursor.atEnd) {
    const token: Token = cursor.peek();
    if (
      depth === 0 &&
      tokens.length > 0 &&
      token.kind === 'word' &&
      DEFAULT_STOP_WORDS.has(token.up)
    ) {
      break;
    }
    if (token.kind === 'punct') {
      if (token.text === '(') {
        depth += 1;
      } else if (token.text === ')') {
        depth = Math.max(0, depth - 1);
      }
    }
    tokens.push(cursor.next());
  }
  return tokens;
}

/**
 * Reads a column definition and adds it, with the constraints written inline, to the table. Returns
 * undefined when the element does not start with a name.
 */
function parseColumn(
  ctx: Context,
  file: FileContext,
  cursor: Cursor,
  table: RawTable,
  label: string
): RawColumn | undefined {
  const nameToken: Token = cursor.peek();
  if (nameToken.kind !== 'word' && nameToken.kind !== 'ident') {
    return undefined;
  }
  cursor.next();
  const dialect: SqlDialect = file.dialect;
  const afterName: Token = cursor.peek();
  const hasNoType: boolean =
    cursor.atEnd ||
    (afterName.kind === 'word' && CONSTRAINT_START_WORDS.has(afterName.up));
  const type: RawType = hasNoType
    ? {
        name: '',
        args: [],
        arrayDepth: 0,
        unsigned: false,
        text: '',
        userName: '',
      }
    : parseType(cursor, file.text, dialect);
  const column: RawColumn = {
    name: nameToken.value,
    type,
    notNull: undefined,
    autoIncrement: false,
    onUpdateNow: false,
    line: nameToken.line,
  };
  let pendingName: string | undefined;
  let isPrimaryKey: boolean = false;

  while (!cursor.atEnd) {
    const token: Token = cursor.peek();
    if (token.kind !== 'word') {
      // Stray punctuation, strings or a parenthesised option: skip it.
      if (token.kind === 'punct' && token.text === '(') {
        cursor.readGroup();
      } else {
        cursor.next();
      }
      continue;
    }
    switch (token.up) {
      case 'CONSTRAINT': {
        cursor.next();
        const candidate: Token = cursor.peek();
        if (candidate.kind === 'word' || candidate.kind === 'ident') {
          if (!(
            candidate.kind === 'word' &&
            [
              'NOT',
              'NULL',
              'PRIMARY',
              'UNIQUE',
              'REFERENCES',
              'CHECK',
              'DEFAULT',
            ].includes(candidate.up)
          )) {
            pendingName = candidate.value;
            cursor.next();
          }
        }
        continue;
      }
      case 'NOT':
        cursor.next();
        if (cursor.acceptKeyword('NULL')) {
          column.notNull = true;
        }
        continue;
      case 'NULL':
        cursor.next();
        column.notNull = false;
        continue;
      case 'DEFAULT': {
        cursor.next();
        const tokens: Token[] = readDefault(cursor);
        column.defaultTokens = tokens;
        column.defaultText = defaultExpression(tokens, file.text);
        continue;
      }
      case 'PRIMARY':
        cursor.next();
        cursor.acceptKeyword('KEY');
        cursor.acceptKeyword('ASC');
        cursor.acceptKeyword('DESC');
        cursor.acceptKeyword('CLUSTERED');
        cursor.acceptKeyword('NONCLUSTERED');
        if (cursor.isKeyword('ON') && cursor.isKeyword('CONFLICT', 1)) {
          cursor.next();
          cursor.next();
          cursor.next();
        }
        isPrimaryKey = true;
        if (pendingName !== undefined && table.primaryKey === undefined) {
          table.primaryKey = { columns: [], name: pendingName };
        }
        pendingName = undefined;
        continue;
      case 'KEY':
        cursor.next();
        isPrimaryKey = true;
        continue;
      case 'UNIQUE': {
        cursor.next();
        cursor.acceptKeyword('KEY');
        cursor.acceptKeyword('INDEX');
        cursor.acceptKeyword('CLUSTERED');
        cursor.acceptKeyword('NONCLUSTERED');
        if (cursor.isKeyword('ON') && cursor.isKeyword('CONFLICT', 1)) {
          cursor.next();
          cursor.next();
          cursor.next();
        }
        table.uniques.push({
          columns: [column.name],
          ...(pendingName === undefined ? {} : { name: pendingName }),
        });
        pendingName = undefined;
        continue;
      }
      case 'REFERENCES': {
        cursor.next();
        const reference: RawReference | undefined = parseReferences(
          cursor,
          [column.name],
          pendingName,
          nameToken.line
        );
        if (reference !== undefined) {
          table.references.push(reference);
        }
        pendingName = undefined;
        continue;
      }
      case 'CHECK': {
        cursor.next();
        const group: Token[] | undefined = cursor.readGroup();
        if (group !== undefined) {
          table.checks.push({
            ...(pendingName === undefined ? {} : { name: pendingName }),
            tokens: group,
            text: sourceOf(file.text, group),
          });
        }
        pendingName = undefined;
        continue;
      }
      case 'AUTO_INCREMENT':
      case 'AUTOINCREMENT':
        cursor.next();
        column.autoIncrement = true;
        continue;
      case 'IDENTITY':
        cursor.next();
        column.autoIncrement = true;
        cursor.readGroup();
        continue;
      case 'GENERATED': {
        cursor.next();
        if (!cursor.acceptKeyword('ALWAYS')) {
          cursor.acceptKeywords('BY', 'DEFAULT');
        }
        if (cursor.acceptKeyword('AS')) {
          if (cursor.acceptKeyword('IDENTITY')) {
            column.autoIncrement = true;
            cursor.readGroup();
          } else {
            readGeneratedExpression(cursor, file, column);
          }
        }
        continue;
      }
      case 'AS':
        cursor.next();
        readGeneratedExpression(cursor, file, column);
        continue;
      case 'COLLATE':
        cursor.next();
        cursor.next();
        continue;
      case 'CHARACTER':
        cursor.next();
        cursor.acceptKeyword('SET');
        cursor.next();
        continue;
      case 'CHARSET':
        cursor.next();
        cursor.next();
        continue;
      case 'COMMENT':
        cursor.next();
        cursor.next();
        continue;
      case 'ON':
        cursor.next();
        if (cursor.acceptKeyword('UPDATE')) {
          const target: Token = cursor.next();
          if (
            target.kind === 'word' &&
            [
              'CURRENT_TIMESTAMP',
              'NOW',
              'LOCALTIMESTAMP',
              'LOCALTIME',
            ].includes(target.up)
          ) {
            column.onUpdateNow = true;
          }
          cursor.readGroup();
        } else {
          cursor.next();
        }
        continue;
      case 'STORAGE':
      case 'COMPRESSION':
        cursor.next();
        cursor.next();
        continue;
      default:
        cursor.next();
    }
  }

  if (isPrimaryKey) {
    if (table.primaryKey === undefined) {
      table.primaryKey = { columns: [column.name] };
    } else if (table.primaryKey.columns.length === 0) {
      table.primaryKey.columns = [column.name];
    } else {
      warn(
        ctx,
        `table "${label}": more than one PRIMARY KEY is declared; "${column.name}" is ignored as a key.`
      );
    }
  }
  table.columns.push(column);
  return column;
}

function readGeneratedExpression(
  cursor: Cursor,
  file: FileContext,
  column: RawColumn
): void {
  const group: Token[] | undefined = cursor.readGroup();
  if (group === undefined) {
    return;
  }
  let isStored: boolean = false;
  if (cursor.acceptKeyword('STORED') || cursor.acceptKeyword('PERSISTED')) {
    isStored = true;
  } else {
    cursor.acceptKeyword('VIRTUAL');
  }
  column.generated = { expression: sourceOf(file.text, group), isStored };
}

function createIndex(
  ctx: Context,
  file: FileContext,
  cursor: Cursor,
  line: number
): void {
  let isUnique: boolean = false;
  let kind: 'fulltext' | 'spatial' | undefined;
  let clustered: boolean | undefined;
  for (;;) {
    if (cursor.acceptKeyword('UNIQUE')) {
      isUnique = true;
    } else if (cursor.acceptKeyword('FULLTEXT')) {
      kind = 'fulltext';
    } else if (cursor.acceptKeyword('SPATIAL')) {
      kind = 'spatial';
    } else if (cursor.acceptKeyword('CLUSTERED')) {
      clustered = true;
    } else if (cursor.acceptKeyword('NONCLUSTERED')) {
      clustered = false;
    } else if (
      cursor.acceptKeyword('COLUMNSTORE') ||
      cursor.acceptKeyword('BITMAP')
    ) {
      continue;
    } else {
      break;
    }
  }
  if (!cursor.acceptKeyword('INDEX')) {
    recordSkipped(ctx, file, 'unrecognised', line);
    return;
  }
  cursor.acceptKeyword('CONCURRENTLY');
  cursor.acceptKeywords('IF', 'NOT', 'EXISTS');
  let name: string | undefined;
  if (!cursor.isKeyword('ON')) {
    const parsed: QualifiedName | undefined = parseQualifiedName(cursor);
    name = parsed?.name;
  }
  let method: string | undefined;
  // MySQL: CREATE INDEX name USING BTREE ON table (...)
  if (cursor.isKeyword('USING') && cursor.isKeyword('ON', 2)) {
    cursor.next();
    method = cursor.next().value.toLowerCase();
  }
  if (!cursor.acceptKeyword('ON')) {
    recordSkipped(ctx, file, 'unrecognised', line);
    return;
  }
  cursor.acceptKeyword('ONLY');
  const target: QualifiedName | undefined = parseQualifiedName(cursor);
  if (target === undefined) {
    return;
  }
  if (cursor.isKeyword('USING') && !cursor.isPunct('(', 1)) {
    cursor.next();
    method = cursor.next().value.toLowerCase();
  }
  const group: Token[] | undefined = cursor.readGroup();
  if (group === undefined) {
    recordSkipped(ctx, file, 'unrecognised', line);
    return;
  }
  // MySQL: USING after the column list.
  if (cursor.isKeyword('USING') && !cursor.isPunct('(', 1)) {
    cursor.next();
    method = cursor.next().value.toLowerCase();
  }
  let isPartial: boolean = false;
  while (!cursor.atEnd) {
    if (cursor.isKeyword('WHERE')) {
      isPartial = true;
      break;
    }
    if (cursor.isKeyword('INCLUDE') || cursor.isKeyword('WITH')) {
      cursor.next();
      cursor.readGroup();
    } else {
      cursor.next();
    }
  }
  const table: RawTable | undefined = lookupTable(ctx, target, file.dialect);
  if (table === undefined) {
    warn(
      ctx,
      `${file.name}:${line}: the index${name === undefined ? '' : ` "${name}"`} is on the unknown table "${target.name}" and was skipped.`
    );
    return;
  }
  table.indexes.push({
    ...(name === undefined ? {} : { name }),
    elements: readIndexElements(group),
    isUnique,
    ...(kind === undefined ? {} : { kind }),
    ...(method === undefined || method === 'btree' ? {} : { method }),
    ...(clustered === undefined ? {} : { clustered }),
    isPartial,
    line,
  });
}

function lookupTable(
  ctx: Context,
  name: QualifiedName,
  dialect: SqlDialect
): RawTable | undefined {
  const schema: string | undefined = normalizedSchema(name, dialect);
  const exact: RawTable | undefined = ctx.tableByKey.get(
    tableKey(schema, name.name)
  );
  if (exact !== undefined && !exact.dropped) {
    return exact;
  }
  // An unqualified name finds a table in any schema when there is only one candidate.
  if (schema === undefined) {
    const candidates: RawTable[] = (
      ctx.tablesByName.get(name.name.toLowerCase()) ?? []
    ).filter((table: RawTable) => !table.dropped);
    if (candidates.length === 1) {
      return candidates[0];
    }
  } else {
    const fallback: RawTable | undefined = ctx.tableByKey.get(
      tableKey(undefined, name.name)
    );
    if (
      fallback !== undefined &&
      !fallback.dropped &&
      DEFAULT_SCHEMAS.has(schema.toLowerCase())
    ) {
      return fallback;
    }
  }
  return undefined;
}

function createType(
  ctx: Context,
  file: FileContext,
  cursor: Cursor,
  line: number
): void {
  cursor.next();
  const name: QualifiedName | undefined = parseQualifiedName(cursor);
  if (name === undefined || !cursor.acceptKeyword('AS')) {
    recordSkipped(ctx, file, 'CREATE TYPE', line);
    return;
  }
  if (!cursor.acceptKeyword('ENUM')) {
    recordSkipped(ctx, file, 'CREATE TYPE (not an enum)', line);
    return;
  }
  const group: Token[] = cursor.readGroup() ?? [];
  const values: string[] = group
    .filter((token: Token) => token.kind === 'string')
    .map((token: Token) => token.value);
  ctx.enums.push({
    ...(name.schema === undefined ? {} : { schema: name.schema }),
    name: name.name,
    values,
    dropped: false,
  });
}

function findEnum(
  ctx: Context,
  name: QualifiedName | string
): RawEnum | undefined {
  const wanted: string = (
    typeof name === 'string' ? name : name.name
  ).toLowerCase();
  for (let at: number = ctx.enums.length - 1; at >= 0; at -= 1) {
    const candidate: RawEnum | undefined = ctx.enums[at];
    if (
      candidate !== undefined &&
      !candidate.dropped &&
      candidate.name.toLowerCase() === wanted
    ) {
      return candidate;
    }
  }
  return undefined;
}

function handleAlter(ctx: Context, file: FileContext, cursor: Cursor): void {
  const line: number = cursor.peek().line;
  cursor.next();
  if (cursor.isKeyword('TYPE')) {
    cursor.next();
    const name: QualifiedName | undefined = parseQualifiedName(cursor);
    const target: RawEnum | undefined =
      name === undefined ? undefined : findEnum(ctx, name);
    if (target !== undefined && cursor.acceptKeywords('ADD', 'VALUE')) {
      cursor.acceptKeywords('IF', 'NOT', 'EXISTS');
      const value: Token = cursor.next();
      if (value.kind === 'string' && !target.values.includes(value.value)) {
        let position: number = target.values.length;
        if (cursor.isKeyword('BEFORE') || cursor.isKeyword('AFTER')) {
          const after: boolean = cursor.next().up === 'AFTER';
          const anchor: Token = cursor.next();
          const anchorAt: number = target.values.indexOf(anchor.value);
          if (anchorAt !== -1) {
            position = after ? anchorAt + 1 : anchorAt;
          }
        }
        target.values.splice(position, 0, value.value);
      }
    }
    return;
  }
  if (!cursor.acceptKeyword('TABLE')) {
    // ALTER SEQUENCE, ALTER VIEW, ALTER DATABASE and similar change nothing the model holds.
    return;
  }
  cursor.acceptKeywords('IF', 'EXISTS');
  cursor.acceptKeyword('ONLY');
  const name: QualifiedName | undefined = parseQualifiedName(cursor);
  if (name === undefined) {
    return;
  }
  if (
    cursor.isKeyword('WITH') &&
    (cursor.isKeyword('CHECK', 1) || cursor.isKeyword('NOCHECK', 1))
  ) {
    cursor.next();
    cursor.next();
  }
  const rest: Token[] = [];
  while (!cursor.atEnd) {
    rest.push(cursor.next());
  }
  const table: RawTable | undefined = lookupTable(ctx, name, file.dialect);
  if (table === undefined) {
    warn(
      ctx,
      `${file.name}:${line}: ALTER TABLE on the unknown table "${name.name}" was skipped.`
    );
    return;
  }
  for (const action of splitTopLevel(rest)) {
    handleAlterAction(ctx, file, table, new Cursor(action), line);
  }
}

const QUIET_ALTER_ACTIONS: ReadonlySet<string> = new Set([
  'OWNER',
  'ENABLE',
  'DISABLE',
  'FORCE',
  'NO',
  'CLUSTER',
  'SET',
  'RESET',
  'REPLICA',
  'CHECK',
  'NOCHECK',
  'ATTACH',
  'DETACH',
  'AUTO_INCREMENT',
  'ENGINE',
  'ROW_FORMAT',
  'COMMENT',
  'CHARACTER',
  'COLLATE',
  'CONVERT',
  'ALGORITHM',
  'LOCK',
  'TRIGGER',
  'VALIDATE',
  'INHERIT',
  'OF',
  'NOT',
  'UNION',
  'WITH',
]);

function handleAlterAction(
  ctx: Context,
  file: FileContext,
  table: RawTable,
  cursor: Cursor,
  line: number
): void {
  const head: Token = cursor.peek();
  if (head.kind !== 'word') {
    return;
  }
  if (head.up === 'ADD') {
    cursor.next();
    cursor.acceptKeyword('COLUMN');
    cursor.acceptKeywords('IF', 'NOT', 'EXISTS');
    if (isConstraintStart(cursor, file.dialect)) {
      applyConstraint(
        ctx,
        table,
        parseTableConstraint(ctx, file, cursor, table.name)
      );
      return;
    }
    if (cursor.isKeyword('GENERATED') || cursor.isPunct('(') || cursor.atEnd) {
      return;
    }
    const column: RawColumn | undefined = parseColumn(
      ctx,
      file,
      cursor,
      table,
      table.name
    );
    if (column === undefined) {
      warn(
        ctx,
        `${file.name}:${line}: ALTER TABLE "${table.name}" ADD could not be read and was skipped.`
      );
    }
    return;
  }
  if (head.up === 'ALTER') {
    cursor.next();
    cursor.acceptKeyword('COLUMN');
    const columnToken: Token = cursor.next();
    const column: RawColumn | undefined = table.columns.find(
      (candidate: RawColumn) =>
        candidate.name.toLowerCase() === columnToken.value.toLowerCase()
    );
    if (column === undefined) {
      return;
    }
    if (cursor.acceptKeywords('SET', 'NOT', 'NULL')) {
      column.notNull = true;
    } else if (cursor.acceptKeywords('DROP', 'NOT', 'NULL')) {
      column.notNull = false;
    } else if (cursor.acceptKeywords('SET', 'DEFAULT')) {
      const tokens: Token[] = readDefault(cursor);
      column.defaultTokens = tokens;
      column.defaultText = defaultExpression(tokens, file.text);
    } else if (cursor.acceptKeywords('DROP', 'DEFAULT')) {
      delete column.defaultTokens;
      delete column.defaultText;
    } else if (cursor.acceptKeyword('ADD') && cursor.isKeyword('GENERATED')) {
      column.autoIncrement = true;
    } else {
      recordSkipped(
        ctx,
        file,
        'ALTER TABLE ... ALTER COLUMN (type or option change)',
        line
      );
    }
    return;
  }
  if (QUIET_ALTER_ACTIONS.has(head.up)) {
    return;
  }
  recordSkipped(ctx, file, `ALTER TABLE ... ${head.up}`, line);
}

function handleDrop(ctx: Context, file: FileContext, cursor: Cursor): void {
  cursor.next();
  const kind: Token = cursor.next();
  if (kind.up === 'TABLE') {
    cursor.acceptKeywords('IF', 'EXISTS');
    for (;;) {
      const name: QualifiedName | undefined = parseQualifiedName(cursor);
      if (name === undefined) {
        break;
      }
      const table: RawTable | undefined = lookupTable(ctx, name, file.dialect);
      if (table !== undefined) {
        table.dropped = true;
        ctx.tableByKey.delete(tableKey(table.schema, table.name));
      }
      if (!cursor.acceptPunct(',')) {
        break;
      }
    }
  } else if (kind.up === 'TYPE') {
    cursor.acceptKeywords('IF', 'EXISTS');
    const name: QualifiedName | undefined = parseQualifiedName(cursor);
    const target: RawEnum | undefined =
      name === undefined ? undefined : findEnum(ctx, name);
    if (target !== undefined) {
      target.dropped = true;
    }
  }
}

// ---------------------------------------------------------------------------
// Building the shared model
// ---------------------------------------------------------------------------

interface ResolvedReference {
  raw: RawReference;
  target: RawTable;
  /** Local column names as written in the table. */
  columns: RawColumn[];
  /** Referenced columns of the target table. */
  targetColumns: RawColumn[];
}

interface ModelBuild {
  table: RawTable;
  name: string;
  /** Names already taken in the model: fields, relations and reverse accessors. */
  used: Set<string>;
  /** Field name per lower-cased column name. */
  fieldNames: Map<string, string>;
  /** Columns that were replaced by a relation. */
  consumed: Set<string>;
  references: ResolvedReference[];
  /** References that became a relation of the model, by column. */
  single: Map<string, ResolvedReference>;
  composite: ResolvedReference[];
  relationNames: Map<ResolvedReference, string>;
  enumByColumn: Map<string, IrEnum>;
  fields: IrField[];
  relations: IrRelation[];
  compositeForeignKeys: IrCompositeForeignKey[];
  indexes: IrIndex[];
  isCollapsed: boolean;
}

function sanitizeIdentifier(value: string): string {
  let result: string = value.replace(/[^A-Za-z0-9_]+/g, '_');
  result = result.replace(/^_+(?=.)/, (match: string) =>
    value.startsWith('_') ? match : ''
  );
  if (result === '' || result === '_') {
    result = 'column';
  }
  if (/^\d/.test(result)) {
    result = `c_${result}`;
  }
  return result;
}

function uniqueName(base: string, used: Set<string>): string {
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  for (let suffix: number = 2; suffix <= used.size + 2; suffix += 1) {
    const candidate: string = `${base}_${suffix}`;
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
  }
  const fallback: string = `${base}_${used.size + 3}`;
  used.add(fallback);
  return fallback;
}

function pluralize(snake: string): string {
  const parts: string[] = snake.split('_');
  const word: string = parts.pop() ?? '';
  const lower: string = word.toLowerCase();
  let plural: string;
  if (
    ['data', 'news', 'series', 'species', 'media', 'metadata'].includes(lower)
  ) {
    plural = `${word}_set`;
  } else if (/[^aeiou]y$/.test(lower)) {
    plural = `${word.slice(0, -1)}ies`;
  } else if (/(s|x|z|ch|sh)$/.test(lower)) {
    plural = `${word}es`;
  } else {
    plural = `${word}s`;
  }
  parts.push(plural);
  return parts.join('_');
}

function modelNameFor(table: RawTable, taken: Set<string>): string {
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

function enumMembers(values: string[]): IrEnumValue[] {
  const used: Set<string> = new Set<string>();
  return values.map((value: string, position: number): IrEnumValue => {
    let base: string = toSnakeCase(value).toUpperCase();
    if (base === '') {
      base = `VALUE_${position + 1}`;
    }
    if (/^\d/.test(base)) {
      base = `V_${base}`;
    }
    return { name: uniqueName(base, used), dbValue: value };
  });
}

function findColumn(table: RawTable, name: string): RawColumn | undefined {
  const lower: string = name.toLowerCase();
  return table.columns.find(
    (column: RawColumn) => column.name.toLowerCase() === lower
  );
}

/** Reads `col IN ('a', 'b')`, `col = 'a' OR col = 'b'` and PostgreSQL's `col = ANY (ARRAY[...])` checks. */
function extractEnumCheck(
  check: RawCheck,
  table: RawTable
): { column: RawColumn; values: string[] } | undefined {
  const kept: Token[] = [];
  const tokens: Token[] = check.tokens;
  for (let at: number = 0; at < tokens.length; at += 1) {
    const token: Token | undefined = tokens[at];
    if (token === undefined) {
      continue;
    }
    if (token.kind === 'punct' && token.text === '::') {
      // Drop the cast: ::text, ::character varying(20), ::text[]
      at += 1;
      while (at < tokens.length) {
        const castPart: Token | undefined = tokens[at];
        if (
          castPart?.kind === 'word' &&
          [
            'TEXT',
            'VARCHAR',
            'CHARACTER',
            'VARYING',
            'CHAR',
            'BPCHAR',
            'NAME',
          ].includes(castPart.up)
        ) {
          at += 1;
        } else if (castPart?.kind === 'punct' && castPart.text === '[') {
          at += 1;
        } else if (castPart?.kind === 'punct' && castPart.text === ']') {
          at += 1;
        } else {
          break;
        }
      }
      at -= 1;
      continue;
    }
    kept.push(token);
  }
  let column: RawColumn | undefined;
  const values: string[] = [];
  let sawMembership: boolean = false;
  for (const token of kept) {
    if (token.kind === 'string') {
      if (!values.includes(token.value)) {
        values.push(token.value);
      }
    } else if (token.kind === 'word' || token.kind === 'ident') {
      const upper: string = token.value.toUpperCase();
      if (token.kind === 'word' && (upper === 'IN' || upper === 'ANY')) {
        sawMembership = true;
      } else if (
        token.kind === 'word' &&
        (upper === 'OR' || upper === 'ARRAY')
      ) {
        continue;
      } else {
        const candidate: RawColumn | undefined = findColumn(table, token.value);
        if (candidate === undefined) {
          return undefined;
        }
        if (column !== undefined && column !== candidate) {
          return undefined;
        }
        column = candidate;
      }
    } else if (token.kind === 'number') {
      return undefined;
    } else if (
      token.kind === 'punct' &&
      !['(', ')', ',', '=', '[', ']'].includes(token.text)
    ) {
      return undefined;
    } else if (token.kind === 'punct' && token.text === '=') {
      sawMembership = true;
    }
  }
  if (column === undefined || !sawMembership || values.length === 0) {
    return undefined;
  }
  return { column, values };
}

function referenceCoversExactly(
  columns: string[],
  candidate: string[]
): boolean {
  if (columns.length !== candidate.length) {
    return false;
  }
  const wanted: Set<string> = new Set(
    candidate.map((name: string) => name.toLowerCase())
  );
  return columns.every((name: string) => wanted.has(name.toLowerCase()));
}

function targetKeyColumns(target: RawTable): RawColumn[] {
  const names: string[] = target.primaryKey?.columns ?? [];
  const found: RawColumn[] = [];
  for (const name of names) {
    const column: RawColumn | undefined = findColumn(target, name);
    if (column !== undefined) {
      found.push(column);
    }
  }
  return found;
}

function buildSchema(
  ctx: Context,
  tables: RawTable[],
  options: SqlDdlParseOptions
): IrSchema {
  const warnings: WarningSink = {
    push: (message: string): void => warn(ctx, message),
  };
  const modelNames: Set<string> = new Set<string>();
  const builds: Map<RawTable, ModelBuild> = new Map<RawTable, ModelBuild>();
  for (const table of tables) {
    builds.set(table, {
      table,
      name: modelNameFor(table, modelNames),
      used: new Set<string>(),
      fieldNames: new Map<string, string>(),
      consumed: new Set<string>(),
      references: [],
      single: new Map<string, ResolvedReference>(),
      composite: [],
      relationNames: new Map<ResolvedReference, string>(),
      enumByColumn: new Map<string, IrEnum>(),
      fields: [],
      relations: [],
      compositeForeignKeys: [],
      indexes: [],
      isCollapsed: false,
    });
  }

  // Enums: CREATE TYPE ... AS ENUM first, then inline and CHECK-derived ones.
  const enums: IrEnum[] = [];
  const enumByType: Map<string, IrEnum> = new Map<string, IrEnum>();
  const enumNames: Set<string> = new Set<string>(modelNames);
  for (const raw of ctx.enums) {
    if (raw.dropped) {
      continue;
    }
    const name: string = uniqueName(
      toPascalCase(raw.name) || 'Enum',
      enumNames
    );
    const created: IrEnum = {
      name,
      values: enumMembers(raw.values),
      ...(name === raw.name ? {} : { dbName: raw.name }),
      ...(raw.schema === undefined || DEFAULT_SCHEMAS.has(raw.schema)
        ? {}
        : { schema: raw.schema }),
    };
    enums.push(created);
    enumByType.set(raw.name.toLowerCase(), created);
  }
  for (const table of tables) {
    const build: ModelBuild = builds.get(table) as ModelBuild;
    for (const column of table.columns) {
      if (column.type.enumValues !== undefined) {
        const created: IrEnum = {
          name: uniqueName(
            toPascalCase(
              `${singularize(toSnakeCase(table.name))}_${column.name}`
            ) || 'Enum',
            enumNames
          ),
          values: enumMembers(column.type.enumValues),
        };
        enums.push(created);
        build.enumByColumn.set(column.name.toLowerCase(), created);
      }
    }
    let droppedChecks: number = 0;
    for (const check of table.checks) {
      const found = extractEnumCheck(check, table);
      if (found !== undefined) {
        const mapped: MappedType = mapType(found.column.type, table.dialect);
        const key: string = found.column.name.toLowerCase();
        if (
          (mapped.type === 'string' || mapped.type === 'text') &&
          !build.enumByColumn.has(key) &&
          found.column.type.enumValues === undefined &&
          found.column.type.arrayDepth === 0
        ) {
          const created: IrEnum = {
            name: uniqueName(
              toPascalCase(
                `${singularize(toSnakeCase(table.name))}_${found.column.name}`
              ) || 'Enum',
              enumNames
            ),
            values: enumMembers(found.values),
          };
          enums.push(created);
          build.enumByColumn.set(key, created);
          continue;
        }
      }
      droppedChecks += 1;
    }
    if (droppedChecks > 0) {
      warnings.push(
        `table "${table.name}": ${droppedChecks} CHECK constraint${droppedChecks === 1 ? ' has' : 's have'} no equivalent in the shared model and ${droppedChecks === 1 ? 'was' : 'were'} dropped.`
      );
    }
  }

  // Foreign keys: which target does each one point at, and is it usable?
  const referencedTables: Set<RawTable> = new Set<RawTable>();
  for (const table of tables) {
    const build: ModelBuild = builds.get(table) as ModelBuild;
    for (const raw of table.references) {
      const target: RawTable | undefined = lookupTable(
        ctx,
        {
          ...(raw.refSchema === undefined ? {} : { schema: raw.refSchema }),
          name: raw.refTable,
        },
        table.dialect
      );
      if (target === undefined || builds.get(target) === undefined) {
        warnings.push(
          `table "${table.name}": the foreign key on (${raw.columns.join(', ')}) points at the unknown table "${raw.refSchema === undefined ? '' : `${raw.refSchema}.`}${raw.refTable}"; the column stays an ordinary field.`
        );
        continue;
      }
      const columns: RawColumn[] = [];
      for (const name of raw.columns) {
        const found: RawColumn | undefined = findColumn(table, name);
        if (found !== undefined) {
          columns.push(found);
        }
      }
      let targetColumns: RawColumn[] = [];
      if (raw.refColumns.length === 0) {
        targetColumns = targetKeyColumns(target);
      } else {
        for (const name of raw.refColumns) {
          const found: RawColumn | undefined = findColumn(target, name);
          if (found !== undefined) {
            targetColumns.push(found);
          }
        }
      }
      if (
        columns.length === 0 ||
        columns.length !== raw.columns.length ||
        targetColumns.length === 0 ||
        targetColumns.length !== columns.length ||
        (raw.refColumns.length > 0 &&
          raw.refColumns.length !== targetColumns.length)
      ) {
        warnings.push(
          `table "${table.name}": the foreign key on (${raw.columns.join(', ')}) does not match the columns of "${target.name}"; it was skipped.`
        );
        continue;
      }
      build.references.push({ raw, target, columns, targetColumns });
      referencedTables.add(target);
    }
  }

  // Join tables: exactly two foreign-key columns that together are the primary key.
  const collapsed: Map<
    RawTable,
    { first: ResolvedReference; second: ResolvedReference }
  > = new Map();
  for (const table of tables) {
    const build: ModelBuild = builds.get(table) as ModelBuild;
    const key: string[] = table.primaryKey?.columns ?? [];
    if (
      table.columns.length !== 2 ||
      key.length !== 2 ||
      build.references.length !== 2 ||
      table.uniques.length > 0 ||
      table.indexes.length > 0 ||
      table.checks.length > 0 ||
      referencedTables.has(table)
    ) {
      continue;
    }
    const [first, second] = build.references;
    if (first === undefined || second === undefined) {
      continue;
    }
    const columnNames: string[] = table.columns.map(
      (column: RawColumn) => column.name
    );
    if (
      first.columns.length !== 1 ||
      second.columns.length !== 1 ||
      !referenceCoversExactly(key, columnNames) ||
      !referenceCoversExactly(
        [first.columns[0]?.name ?? '', second.columns[0]?.name ?? ''],
        columnNames
      )
    ) {
      continue;
    }
    const isKeyTarget = (reference: ResolvedReference): boolean => {
      const expected: RawColumn[] = targetKeyColumns(reference.target);
      return (
        expected.length === 1 &&
        expected[0]?.name.toLowerCase() ===
          reference.targetColumns[0]?.name.toLowerCase()
      );
    };
    if (
      !isKeyTarget(first) ||
      !isKeyTarget(second) ||
      first.target === table ||
      second.target === table
    ) {
      continue;
    }
    // Keep the order of the primary key, so the first key column owns the relation by default.
    const ordered: ResolvedReference[] = [first, second].sort(
      (left: ResolvedReference, right: ResolvedReference) =>
        key.findIndex(
          (name: string) =>
            name.toLowerCase() === left.columns[0]?.name.toLowerCase()
        ) -
        key.findIndex(
          (name: string) =>
            name.toLowerCase() === right.columns[0]?.name.toLowerCase()
        )
    );
    const left: ResolvedReference | undefined = ordered[0];
    const right: ResolvedReference | undefined = ordered[1];
    if (left === undefined || right === undefined) {
      continue;
    }
    collapsed.set(table, { first: left, second: right });
    build.isCollapsed = true;
  }
  // A join table whose target is itself a join table stays a model.
  for (const [table, pair] of [...collapsed]) {
    if (collapsed.has(pair.first.target) || collapsed.has(pair.second.target)) {
      collapsed.delete(table);
      (builds.get(table) as ModelBuild).isCollapsed = false;
    }
  }

  const keptTables: RawTable[] = tables.filter(
    (table: RawTable) => !collapsed.has(table)
  );
  // Drop references to collapsed tables (cannot happen: referenced tables are never collapsed).

  // Column names, then relation names.
  for (const table of keptTables) {
    const build: ModelBuild = builds.get(table) as ModelBuild;
    const usedColumns: Set<string> = new Set<string>();
    // Single-column foreign keys replace their column; composite ones leave the columns as fields.
    const consumedBy: Map<string, ResolvedReference> = new Map();
    for (const reference of build.references) {
      if (reference.columns.length !== 1) {
        continue;
      }
      const column: RawColumn = reference.columns[0] as RawColumn;
      const key: string = column.name.toLowerCase();
      if (consumedBy.has(key)) {
        warnings.push(
          `table "${table.name}": the column "${column.name}" has more than one foreign key; only the first is read as a relation.`
        );
        continue;
      }
      consumedBy.set(key, reference);
      build.single.set(key, reference);
      build.consumed.add(key);
    }
    for (const column of table.columns) {
      const key: string = column.name.toLowerCase();
      if (build.consumed.has(key)) {
        continue;
      }
      const fieldName: string = uniqueName(
        sanitizeIdentifier(column.name),
        usedColumns
      );
      build.fieldNames.set(key, fieldName);
      build.used.add(fieldName);
    }
    for (const reference of build.references) {
      if (reference.columns.length === 1) {
        if (
          build.single.get(reference.columns[0]?.name.toLowerCase() ?? '') !==
          reference
        ) {
          continue;
        }
        const column: RawColumn = reference.columns[0] as RawColumn;
        let stripped: string = stripKeySuffix(column.name);
        if (stripped === column.name) {
          // order_no -> orders: no key suffix, but the column starts with the name of its target.
          const targetName: string = toSnakeCase(
            (builds.get(reference.target) as ModelBuild).name
          );
          if (column.name.toLowerCase().startsWith(`${targetName}_`)) {
            stripped = targetName;
          }
        }
        const base: string = sanitizeIdentifier(
          stripped === ''
            ? toSnakeCase((builds.get(reference.target) as ModelBuild).name)
            : stripped
        );
        const name: string = uniqueName(base, build.used);
        build.relationNames.set(reference, name);
        build.fieldNames.set(column.name.toLowerCase(), name);
      } else {
        const unconsumed: boolean = reference.columns.every(
          (column: RawColumn) => !build.consumed.has(column.name.toLowerCase())
        );
        if (!unconsumed) {
          warnings.push(
            `table "${table.name}": the composite foreign key on (${reference.columns.map((column: RawColumn) => column.name).join(', ')}) shares a column with a single-column foreign key and was skipped.`
          );
          continue;
        }
        const name: string = uniqueName(
          sanitizeIdentifier(
            toSnakeCase((builds.get(reference.target) as ModelBuild).name)
          ),
          build.used
        );
        build.composite.push(reference);
        build.relationNames.set(reference, name);
      }
    }
  }

  // Join tables become many-to-many relations on one of the two sides.
  interface ManyToMany {
    owner: ModelBuild;
    other: ModelBuild;
    name: string;
    relatedBase: string | undefined;
    relatedName?: string;
  }
  const manyToMany: ManyToMany[] = [];
  for (const [table, pair] of collapsed) {
    const first: ModelBuild = builds.get(pair.first.target) as ModelBuild;
    const second: ModelBuild = builds.get(pair.second.target) as ModelBuild;
    const joinName: string = table.name.toLowerCase();
    const prefixOf = (build: ModelBuild): boolean =>
      joinName.startsWith(`${build.table.name.toLowerCase()}_`) &&
      joinName.length > build.table.name.length + 1;
    let owner: ModelBuild = first;
    let other: ModelBuild = second;
    if (!prefixOf(first) && prefixOf(second)) {
      owner = second;
      other = first;
    }
    let relationName: string;
    let relatedBase: string | undefined;
    if (first === second) {
      // A self-referencing join table (follower_id, followee_id): the columns name both directions.
      const firstColumn: string = stripKeySuffix(
        pair.first.columns[0]?.name ?? ''
      );
      const secondColumn: string = stripKeySuffix(
        pair.second.columns[0]?.name ?? ''
      );
      relationName = pluralize(
        sanitizeIdentifier(
          secondColumn === '' ? toSnakeCase(other.name) : secondColumn
        )
      );
      relatedBase =
        firstColumn === ''
          ? undefined
          : pluralize(sanitizeIdentifier(firstColumn));
    } else if (prefixOf(owner)) {
      relationName = sanitizeIdentifier(
        table.name.slice(owner.table.name.length + 1)
      );
    } else {
      relationName = pluralize(toSnakeCase(other.name));
      warnings.push(
        `table "${table.name}": read as the many-to-many relation "${owner.name}.${relationName}"; writers name the join table "${owner.table.name}_${relationName}".`
      );
    }
    manyToMany.push({
      owner,
      other,
      name: uniqueName(relationName, owner.used),
      relatedBase,
    });
  }
  for (const entry of manyToMany) {
    entry.relatedName = uniqueName(
      entry.relatedBase ?? pluralize(toSnakeCase(entry.owner.name)),
      entry.other.used
    );
  }

  // Reverse accessor names of foreign keys.
  const relatedNames: Map<ResolvedReference, string> = new Map();
  for (const table of keptTables) {
    const build: ModelBuild = builds.get(table) as ModelBuild;
    for (const reference of build.references) {
      const name: string | undefined = build.relationNames.get(reference);
      if (name === undefined) {
        continue;
      }
      const targetBuild: ModelBuild = builds.get(
        reference.target
      ) as ModelBuild;
      const sources: number = build.references.filter(
        (other: ResolvedReference) =>
          other.target === reference.target && build.relationNames.has(other)
      ).length;
      const isUnique: boolean = isOneToOne(table, reference);
      const source: string = toSnakeCase(build.name);
      const base: string = isUnique ? source : pluralize(source);
      const preferred: string = sources > 1 ? `${name}_${base}` : base;
      relatedNames.set(reference, uniqueName(preferred, targetBuild.used));
    }
  }

  // Models.
  const models: IrModel[] = [];
  const modelSchemaOf = (table: RawTable): string | undefined =>
    table.schema !== undefined &&
    !DEFAULT_SCHEMAS.has(table.schema.toLowerCase())
      ? table.schema
      : undefined;
  for (const table of keptTables) {
    const build: ModelBuild = builds.get(table) as ModelBuild;
    buildFields(build, enumByType, warnings);
    const primaryKey: string[] = table.primaryKey?.columns ?? [];
    for (const reference of build.references) {
      const name: string | undefined = build.relationNames.get(reference);
      if (name === undefined) {
        continue;
      }
      const targetBuild: ModelBuild = builds.get(
        reference.target
      ) as ModelBuild;
      const targetKey: RawColumn[] = targetKeyColumns(reference.target);
      const oneToOne: boolean = isOneToOne(table, reference);
      const nullable: boolean = reference.columns.some(
        (column: RawColumn) =>
          column.notNull !== true &&
          !primaryKey.some(
            (key: string) => key.toLowerCase() === column.name.toLowerCase()
          )
      );
      const onDelete: IrOnDelete = reference.raw.onDelete ?? 'noAction';
      const onUpdate: IrOnDelete | undefined =
        reference.raw.onUpdate === undefined ||
        reference.raw.onUpdate === 'noAction'
          ? undefined
          : reference.raw.onUpdate;
      const relatedName: string | undefined = relatedNames.get(reference);
      if (reference.columns.length === 1) {
        const column: RawColumn = reference.columns[0] as RawColumn;
        const referenced: RawColumn = reference.targetColumns[0] as RawColumn;
        const pointsAtKey: boolean =
          targetKey.length === 1 &&
          targetKey[0]?.name.toLowerCase() === referenced.name.toLowerCase();
        const isKey: boolean =
          primaryKey.length === 1 &&
          primaryKey[0]?.toLowerCase() === column.name.toLowerCase();
        build.relations.push({
          name,
          kind: oneToOne ? 'oneToOne' : 'foreignKey',
          targetModel: targetBuild.name,
          columnName: column.name,
          isNullable: nullable && !isKey,
          onDelete,
          ...(relatedName === undefined ? {} : { relatedName }),
          ...(pointsAtKey
            ? {}
            : {
                toField:
                  targetBuild.fieldNames.get(referenced.name.toLowerCase()) ??
                  sanitizeIdentifier(referenced.name),
              }),
          ...(isKey ? { isPrimaryKey: true } : {}),
          ...(onUpdate === undefined ? {} : { onUpdate }),
          ...(reference.raw.name === undefined
            ? {}
            : { constraintName: reference.raw.name }),
        });
      } else {
        build.compositeForeignKeys.push({
          name,
          targetModel: targetBuild.name,
          fields: reference.columns.map(
            (column: RawColumn) =>
              build.fieldNames.get(column.name.toLowerCase()) ??
              sanitizeIdentifier(column.name)
          ),
          references: reference.targetColumns.map(
            (column: RawColumn) =>
              targetBuild.fieldNames.get(column.name.toLowerCase()) ??
              sanitizeIdentifier(column.name)
          ),
          kind: oneToOne ? 'oneToOne' : 'foreignKey',
          isNullable: nullable,
          onDelete,
          ...(onUpdate === undefined ? {} : { onUpdate }),
          ...(relatedName === undefined ? {} : { relatedName }),
          ...(reference.raw.name === undefined
            ? {}
            : { constraintName: reference.raw.name }),
        });
      }
    }
    for (const entry of manyToMany) {
      if (entry.owner === build) {
        build.relations.push({
          name: entry.name,
          kind: 'manyToMany',
          targetModel: entry.other.name,
          columnName: '',
          isNullable: false,
          onDelete: 'cascade',
          ...(entry.relatedName === undefined
            ? {}
            : { relatedName: entry.relatedName }),
        });
      }
    }
    buildIndexes(build, warnings);

    const keyNames: string[] = primaryKey.map(
      (name: string) =>
        build.fieldNames.get(name.toLowerCase()) ?? sanitizeIdentifier(name)
    );
    const model: IrModel = {
      name: build.name,
      tableName: table.name,
      appLabel: options.appLabel,
      fields: build.fields,
      relations: build.relations,
      indexes: build.indexes,
      ...(keyNames.length > 1 ? { compositePrimaryKey: keyNames } : {}),
      ...(modelSchemaOf(table) === undefined
        ? {}
        : { schema: modelSchemaOf(table) as string }),
      ...(table.primaryKey?.name === undefined
        ? {}
        : { primaryKeyName: table.primaryKey.name }),
      ...(build.compositeForeignKeys.length === 0
        ? {}
        : { compositeForeignKeys: build.compositeForeignKeys }),
    };
    if (primaryKey.length === 0) {
      warnings.push(
        `table "${table.name}": the table has no primary key; most ORMs need one.`
      );
    }
    models.push(model);
  }

  return { models, enums, warnings: ctx.warnings };
}

/** A foreign key is one-to-one when its columns are the primary key or carry a unique constraint or index. */
function isOneToOne(table: RawTable, reference: ResolvedReference): boolean {
  const names: string[] = reference.columns.map(
    (column: RawColumn) => column.name
  );
  if (
    table.primaryKey !== undefined &&
    referenceCoversExactly(names, table.primaryKey.columns)
  ) {
    return true;
  }
  if (
    table.uniques.some((unique: RawUnique) =>
      referenceCoversExactly(names, unique.columns)
    )
  ) {
    return true;
  }
  return table.indexes.some(
    (index: RawIndex) =>
      index.isUnique &&
      !index.isPartial &&
      index.kind === undefined &&
      index.elements.every(
        (element: RawIndexElement) => element.column !== undefined
      ) &&
      referenceCoversExactly(
        names,
        index.elements.map(
          (element: RawIndexElement) => element.column as string
        )
      )
  );
}

function stripKeySuffix(column: string): string {
  const match: RegExpExecArray | null =
    /^(.*?)(?:_(?:id|uuid|fk|pk|ref|key)|(?<=[a-z0-9])(?:Id|ID|Uuid))$/.exec(
      column
    );
  if (match === null) {
    return /^(?:id|uuid)$/i.test(column) ? '' : column;
  }
  return match[1] ?? '';
}

function buildFields(
  build: ModelBuild,
  enumByType: Map<string, IrEnum>,
  warnings: WarningSink
): void {
  const table: RawTable = build.table;
  const keyColumns: string[] = (table.primaryKey?.columns ?? []).map(
    (name: string) => name.toLowerCase()
  );
  const singleKey: boolean = keyColumns.length === 1;
  const uniqueNames: Map<string, string | undefined> = new Map();
  for (const unique of table.uniques) {
    if (unique.columns.length === 1) {
      uniqueNames.set(unique.columns[0]?.toLowerCase() ?? '', unique.name);
    }
  }

  for (const column of table.columns) {
    const key: string = column.name.toLowerCase();
    if (build.consumed.has(key)) {
      continue;
    }
    const fieldName: string =
      build.fieldNames.get(key) ?? sanitizeIdentifier(column.name);
    if (column.type.name === '' && table.dialect !== 'sqlite') {
      warnings.push(
        `table "${table.name}", column "${column.name}": the column has no declared type (a computed column?) and was skipped.`
      );
      build.fieldNames.delete(key);
      continue;
    }
    const mapped: MappedType = mapType(column.type, table.dialect);
    let type: IrScalarType = mapped.type;
    let enumType: IrEnum | undefined = build.enumByColumn.get(key);
    let unsupportedType: string | undefined;
    if (enumType === undefined && mapped.isUserType === true) {
      enumType = enumByType.get(column.type.userName.toLowerCase());
    }
    if (enumType !== undefined) {
      type = 'string';
    } else if (mapped.unsupported === true) {
      unsupportedType =
        table.dialect === 'sqlserver' && column.type.name === 'timestamp'
          ? 'rowversion'
          : column.type.text;
      if (mapped.isUserType === true) {
        warnings.push(
          `table "${table.name}", column "${column.name}": the type "${column.type.text}" is unknown; it is kept as an unsupported column.`
        );
      }
    }
    if (column.type.setValues !== undefined) {
      warnings.push(
        `table "${table.name}", column "${column.name}": a SET column is read as text; the member list is dropped.`
      );
    }
    const inKey: boolean = keyColumns.includes(key);
    const isPrimaryKey: boolean = singleKey && inKey;
    const isInteger: boolean = type === 'int' || type === 'bigInt';
    const implicitRowId: boolean =
      table.dialect === 'sqlite' &&
      !table.withoutRowid &&
      isPrimaryKey &&
      column.type.name === 'integer' &&
      column.type.arrayDepth === 0;
    const autoIncrement: boolean =
      isInteger &&
      column.type.arrayDepth === 0 &&
      (column.autoIncrement || mapped.autoIncrement === true || implicitRowId);
    const nullable: boolean =
      column.notNull !== true && !inKey && !autoIncrement;

    let columnDefault: IrDefault | undefined;
    if (column.generated === undefined) {
      if (column.defaultTokens !== undefined) {
        const interpreted: IrDefault | null | undefined = interpretDefault(
          column.defaultTokens,
          {
            type,
            ...(enumType === undefined ? {} : { enumType }),
            isArray: column.type.arrayDepth > 0,
          },
          table.dialect
        );
        if (interpreted === undefined) {
          const expression: string = column.defaultText ?? '';
          if (expression !== '') {
            columnDefault = { kind: 'dbExpression', expression };
          }
        } else if (interpreted !== null) {
          columnDefault = interpreted;
        }
      }
      if (autoIncrement && columnDefault === undefined) {
        columnDefault = { kind: 'autoIncrement' };
      }
    }

    const field: IrField = {
      name: fieldName,
      columnName: column.name,
      type,
      isPrimaryKey,
      isUnique: !isPrimaryKey && uniqueNames.has(key),
      isNullable: nullable,
      isAutoUpdated: column.onUpdateNow,
      ...(columnDefault === undefined ? {} : { default: columnDefault }),
      ...(mapped.maxLength === undefined
        ? {}
        : { maxLength: mapped.maxLength }),
      ...(mapped.maxDigits === undefined
        ? {}
        : { maxDigits: mapped.maxDigits }),
      ...(mapped.decimalPlaces === undefined
        ? {}
        : { decimalPlaces: mapped.decimalPlaces }),
      ...(enumType === undefined ? {} : { enumName: enumType.name }),
      ...(column.type.arrayDepth > 0
        ? { arrayDepth: column.type.arrayDepth }
        : {}),
      ...(mapped.rangeOf === undefined ? {} : { rangeOf: mapped.rangeOf }),
      ...(column.generated === undefined
        ? {}
        : { generated: column.generated }),
      ...(unsupportedType === undefined ? {} : { unsupportedType }),
      ...(!isPrimaryKey && uniqueNames.get(key) !== undefined
        ? { uniqueName: uniqueNames.get(key) as string }
        : {}),
    };
    build.fields.push(field);
  }
}

function buildIndexes(build: ModelBuild, warnings: WarningSink): void {
  const table: RawTable = build.table;
  const nameOf = (column: string): string | undefined =>
    build.fieldNames.get(column.toLowerCase());
  for (const unique of table.uniques) {
    if (unique.columns.length === 1) {
      continue;
    }
    const names: string[] = unique.columns.map(
      (column: string) => nameOf(column) ?? ''
    );
    if (names.some((name: string) => name === '')) {
      warnings.push(
        `table "${table.name}": a unique constraint refers to an unknown column and was skipped.`
      );
      continue;
    }
    build.indexes.push({
      fields: names,
      isUnique: true,
      ...(unique.name === undefined ? {} : { name: unique.name }),
    });
  }
  for (const index of table.indexes) {
    const label: string = index.name === undefined ? '' : ` "${index.name}"`;
    if (
      index.elements.some((element: RawIndexElement) => element.isExpression)
    ) {
      warnings.push(
        `table "${table.name}": the index${label} is on an expression, which the shared model cannot hold, and was skipped.`
      );
      continue;
    }
    const names: string[] = index.elements.map(
      (element: RawIndexElement) => nameOf(element.column ?? '') ?? ''
    );
    if (names.length === 0 || names.some((name: string) => name === '')) {
      warnings.push(
        `table "${table.name}": the index${label} refers to an unknown column and was skipped.`
      );
      continue;
    }
    // MySQL builds an index for every foreign key, so a plain index over exactly the key columns
    // is the one the database added (or one that duplicates it), not a separate declaration.
    if (
      table.dialect === 'mysql' &&
      !index.isUnique &&
      index.kind === undefined &&
      !index.isPartial &&
      index.method === undefined &&
      build.references.some((reference: ResolvedReference): boolean => {
        const own: string[] = reference.columns.map(
          (column: RawColumn) => nameOf(column.name) ?? ''
        );
        return (
          own.length === names.length &&
          own.every((name: string, at: number) => name === names[at])
        );
      })
    ) {
      continue;
    }
    if (index.isPartial) {
      if (index.isUnique) {
        warnings.push(
          `table "${table.name}": the partial unique index${label} would become unconditionally unique and was skipped.`
        );
        continue;
      }
      warnings.push(
        `table "${table.name}": the WHERE condition of the index${label} was dropped.`
      );
    }
    const fieldOptions: Record<string, IrIndexFieldOptions> = {};
    index.elements.forEach(
      (element: RawIndexElement, position: number): void => {
        const name: string = names[position] as string;
        const options: IrIndexFieldOptions = {
          ...(element.descending ? { sort: 'desc' as const } : {}),
          ...(element.length === undefined ? {} : { length: element.length }),
          ...(element.ops === undefined
            ? {}
            : { ops: `raw("${element.ops}")` }),
        };
        if (Object.keys(options).length > 0) {
          fieldOptions[name] = options;
        }
      }
    );
    build.indexes.push({
      fields: names,
      isUnique: index.isUnique,
      ...(index.name === undefined ? {} : { name: index.name }),
      ...(index.kind === 'fulltext' ? { kind: 'fulltext' as const } : {}),
      ...(index.method === undefined
        ? {}
        : { method: indexMethod(index.method) }),
      ...(index.clustered === undefined ? {} : { clustered: index.clustered }),
      ...(Object.keys(fieldOptions).length === 0 ? {} : { fieldOptions }),
    });
    if (index.kind === 'spatial') {
      warnings.push(
        `table "${table.name}": the spatial index${label} is read as an ordinary index.`
      );
    }
  }
}

const INDEX_METHODS: Readonly<Record<string, string>> = {
  hash: 'Hash',
  gin: 'Gin',
  gist: 'Gist',
  spgist: 'SpGist',
  brin: 'Brin',
  btree: 'BTree',
};

function indexMethod(method: string): string {
  return INDEX_METHODS[method.toLowerCase()] ?? toPascalCase(method);
}
