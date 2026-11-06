import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  IrDefault,
  IrEnum,
  IrField,
  IrModel,
  IrRelation,
  IrSchema,
} from '../src/ir.js';
import { parseSqlDdl } from '../src/parsers/sqlDdl.js';
import { expectOk } from './helpers.js';
import { formatDifference, type IrDifference } from './irCompare.js';
import type { ToolProbe } from './realToolSupport.js';
import type { Sequelize7Probe } from './sequelize7Support.js';

/**
 * What the SQL Server checks of the Sequelize 7 output share: finding the dialect package, running
 * `tools/generate-sequelize7-mssql.mjs`, reading the DDL back and checking the spelling of the types and the rules
 * of SQL Server that the dialect does not enforce when it writes `CREATE TABLE`. SQL Server itself is never started
 * or contacted (its container image needs a license to be accepted); the DDL comes from the query generator of
 * `@sequelize/mssql`.
 */

const MSSQL_PACKAGE: string = '@sequelize/mssql';

/** Looks for `@sequelize/mssql` in SEQUELIZE7_DIR. */
export function probeSequelize7Mssql(probe: Sequelize7Probe): ToolProbe {
  if (!probe.available) {
    return probe;
  }
  if (
    !existsSync(
      join(probe.directory, 'node_modules', MSSQL_PACKAGE, 'package.json')
    )
  ) {
    return {
      available: false,
      reason: `SEQUELIZE7_DIR is missing ${MSSQL_PACKAGE} (see test/README.md)`,
    };
  }
  return { available: true, reason: '' };
}

/** What `tools/generate-sequelize7-mssql.mjs` prints. */
export interface Mssql7Run {
  /** The CREATE TABLE / CREATE INDEX statements `sequelize.sync()` sends to SQL Server, in order. */
  statements: string[];
  associations: { model: string; as: string; type: string }[];
}

/**
 * Loads the compiled entry module with the SQL Server dialect and collects the DDL `sync()` would run, without a
 * connection.
 */
export function runMssql7(
  probe: Sequelize7Probe,
  directory: string,
  entry: string
): { run: SpawnSyncReturns<string>; result: Mssql7Run | undefined } {
  const run: SpawnSyncReturns<string> = spawnSync(
    process.execPath,
    [
      fileURLToPath(
        new URL('./tools/generate-sequelize7-mssql.mjs', import.meta.url)
      ),
      probe.directory,
      join(directory, entry),
    ],
    { cwd: directory, encoding: 'utf8', timeout: 240_000 }
  );
  return {
    run,
    result:
      run.status === 0 ? (JSON.parse(run.stdout) as Mssql7Run) : undefined,
  };
}

// ---------------------------------------------------------------------------
// Reading the DDL
// ---------------------------------------------------------------------------

/** A column of a `CREATE TABLE`, with the type spelled the way the dialect wrote it. */
export interface MssqlColumn {
  name: string;
  /** `NVARCHAR(255)`, `DECIMAL(10, 2)`, `DATETIMEOFFSET(6)` ... */
  type: string;
  nullable: boolean;
  /** The text after `DEFAULT`, when the column has one. */
  default?: string;
}

export interface MssqlForeignKey {
  columns: string[];
  schema?: string;
  table: string;
  /** The text after `ON DELETE` (`CASCADE`, `SET NULL`, `NO ACTION`), absent when the key states none. */
  onDelete?: string;
  onUpdate?: string;
}

export interface MssqlTable {
  schema?: string;
  name: string;
  columns: MssqlColumn[];
  primaryKey: string[];
  /** UNIQUE constraints, by columns. */
  uniques: { name?: string; columns: string[] }[];
  foreignKeys: MssqlForeignKey[];
}

export interface MssqlIndex {
  name: string;
  schema?: string;
  table: string;
  unique: boolean;
  columns: string[];
}

/** Splits `text` at the commas outside parentheses, quotes and brackets. */
function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth: number = 0;
  let quote: string | undefined;
  let start: number = 0;
  for (let at: number = 0; at < text.length; at += 1) {
    const char: string = text.charAt(at);
    if (quote !== undefined) {
      if (char === quote) {
        quote = undefined;
      }
    } else if (char === "'") {
      quote = "'";
    } else if (char === '[') {
      quote = ']';
    } else if (char === '(') {
      depth += 1;
    } else if (char === ')') {
      depth -= 1;
    } else if (char === ',' && depth === 0) {
      parts.push(text.slice(start, at).trim());
      start = at + 1;
    }
  }
  parts.push(text.slice(start).trim());
  return parts.filter((part: string) => part !== '');
}

/** The identifiers of a `[a], [b] DESC` list. */
function identifiers(list: string): string[] {
  return [...list.matchAll(/\[([^\]]+)\]/g)].map(
    (match: RegExpMatchArray) => match[1] ?? ''
  );
}

/** `[schema].[table]` or `[table]` at the start of `text`: the names and what follows. */
function qualifiedName(text: string): {
  schema?: string;
  name: string;
  rest: string;
} {
  const match: RegExpExecArray | null =
    /^\s*(?:\[([^\]]+)\]\.)?\[([^\]]+)\]([\s\S]*)$/.exec(text);
  if (match === null) {
    return { name: '', rest: text };
  }
  return {
    ...(match[1] === undefined ? {} : { schema: match[1] }),
    name: match[2] ?? '',
    rest: match[3] ?? '',
  };
}

/** Reads the `CREATE TABLE` statements the dialect wrote (its own spelling, not a general SQL grammar). */
export function readTables(statements: readonly string[]): MssqlTable[] {
  const tables: MssqlTable[] = [];
  for (const statement of statements) {
    const create: RegExpExecArray | null =
      /\bCREATE\s+TABLE\s+([\s\S]*?)\s*\(([\s\S]*)\)\s*;?\s*$/i.exec(statement);
    if (create === null) {
      continue;
    }
    const name = qualifiedName(create[1] ?? '');
    const table: MssqlTable = {
      ...(name.schema === undefined ? {} : { schema: name.schema }),
      name: name.name,
      columns: [],
      primaryKey: [],
      uniques: [],
      foreignKeys: [],
    };
    for (const part of splitTopLevel(create[2] ?? '')) {
      const primary: RegExpExecArray | null =
        /^PRIMARY\s+KEY\s*\(([^)]*)\)/i.exec(part);
      const unique: RegExpExecArray | null =
        /^(?:CONSTRAINT\s+\[([^\]]+)\]\s+)?UNIQUE\s*\(([^)]*)\)/i.exec(part);
      const foreign: RegExpExecArray | null =
        /^(?:CONSTRAINT\s+\[[^\]]+\]\s+)?FOREIGN\s+KEY\s*\(([^)]*)\)\s*REFERENCES\s+([\s\S]*)$/i.exec(
          part
        );
      if (primary !== null) {
        table.primaryKey = identifiers(primary[1] ?? '');
      } else if (unique !== null) {
        table.uniques.push({
          ...(unique[1] === undefined ? {} : { name: unique[1] }),
          columns: identifiers(unique[2] ?? ''),
        });
      } else if (foreign !== null) {
        const target = qualifiedName(foreign[2] ?? '');
        const rest: string = target.rest;
        const onDelete: RegExpExecArray | null =
          /\bON\s+DELETE\s+(SET\s+NULL|SET\s+DEFAULT|NO\s+ACTION|CASCADE|RESTRICT)/i.exec(
            rest
          );
        const onUpdate: RegExpExecArray | null =
          /\bON\s+UPDATE\s+(SET\s+NULL|SET\s+DEFAULT|NO\s+ACTION|CASCADE|RESTRICT)/i.exec(
            rest
          );
        table.foreignKeys.push({
          columns: identifiers(foreign[1] ?? ''),
          ...(target.schema === undefined ? {} : { schema: target.schema }),
          table: target.name,
          ...(onDelete === null
            ? {}
            : { onDelete: (onDelete[1] ?? '').toUpperCase() }),
          ...(onUpdate === null
            ? {}
            : { onUpdate: (onUpdate[1] ?? '').toUpperCase() }),
        });
      } else {
        const column: RegExpExecArray | null =
          /^\[([^\]]+)\]\s+([A-Z]+(?:\s+PRECISION)?(?:\s*\([^)]*\))?)([\s\S]*)$/i.exec(
            part
          );
        if (column === null) {
          continue;
        }
        const rest: string = column[3] ?? '';
        const fallback: RegExpExecArray | null =
          /\bDEFAULT\s+([\s\S]*?)$/i.exec(
            rest.replace(
              /\s+(?:UNIQUE|PRIMARY\s+KEY|REFERENCES)\b[\s\S]*$/i,
              ''
            )
          );
        table.columns.push({
          name: column[1] ?? '',
          type: (column[2] ?? '').replace(/\s+/g, ' ').toUpperCase(),
          nullable: !/\bNOT\s+NULL\b/i.test(rest),
          ...(fallback === null ? {} : { default: (fallback[1] ?? '').trim() }),
        });
      }
    }
    tables.push(table);
  }
  return tables;
}

/** Reads the `CREATE [UNIQUE] INDEX` statements. */
export function readIndexes(statements: readonly string[]): MssqlIndex[] {
  const indexes: MssqlIndex[] = [];
  for (const statement of statements) {
    const match: RegExpExecArray | null =
      /^\s*CREATE\s+(UNIQUE\s+)?INDEX\s+\[([^\]]+)\]\s+ON\s+([\s\S]*?)\s*\(([\s\S]*)\)\s*;?\s*$/i.exec(
        statement
      );
    if (match === null) {
      continue;
    }
    const target = qualifiedName(match[3] ?? '');
    indexes.push({
      name: match[2] ?? '',
      ...(target.schema === undefined ? {} : { schema: target.schema }),
      table: target.name,
      unique: match[1] !== undefined,
      columns: identifiers(match[4] ?? ''),
    });
  }
  return indexes;
}

// ---------------------------------------------------------------------------
// Reading it back with the SQL reader
// ---------------------------------------------------------------------------

/**
 * The statements without the `IF OBJECT_ID(N'[t]', 'U') IS NULL` guard that Sequelize puts before `CREATE TABLE`
 * (the SQL reader starts at `CREATE`), joined into one SQL Server script.
 */
export function ddlScript(statements: readonly string[]): string {
  return statements
    .map(
      (statement: string) =>
        `${statement.replace(/^\s*IF\s+OBJECT_ID\([^)]*\)\s+IS\s+NULL\s+/i, '').replace(/;\s*$/, '')};`
    )
    .join('\n');
}

/** Reads the DDL back with the repo's SQL DDL reader (`--from sql`), as SQL Server. */
export function readBack(statements: readonly string[]): IrSchema {
  return expectOk(
    parseSqlDdl([{ path: 'sync.sql', text: ddlScript(statements) }], {
      appLabel: 'app',
      dialect: 'sqlserver',
    })
  );
}

/**
 * What the reader made of the SQL, with each model and relation named like the IR the writer started from: a model
 * by its table, a relation by its column (a many-to-many relation by its target, in order). The reader derives
 * those names from the SQL, and the reverse accessor of a relation is a guess too, so it is left out.
 */
export function namedLike(read: IrSchema, schema: IrSchema): IrSchema {
  const names: Map<string, string> = new Map<string, string>();
  for (const model of read.models) {
    const found: IrModel | undefined = schema.models.find(
      (candidate: IrModel) => candidate.tableName === model.tableName
    );
    names.set(model.name, found?.name ?? model.name);
  }
  return {
    ...read,
    models: read.models.map((model: IrModel): IrModel => {
      const counterpart: IrModel | undefined = schema.models.find(
        (candidate: IrModel) => candidate.tableName === model.tableName
      );
      const manyToMany: IrRelation[] = (counterpart?.relations ?? []).filter(
        (candidate: IrRelation) => candidate.kind === 'manyToMany'
      );
      return {
        ...model,
        name: names.get(model.name) ?? model.name,
        relations: model.relations.map((relation: IrRelation): IrRelation => {
          const target: string =
            names.get(relation.targetModel) ?? relation.targetModel;
          const found: IrRelation | undefined =
            relation.kind === 'manyToMany'
              ? manyToMany.find(
                  (candidate: IrRelation) => candidate.targetModel === target
                )
              : counterpart?.relations.find(
                  (candidate: IrRelation) =>
                    candidate.kind !== 'manyToMany' &&
                    candidate.columnName === relation.columnName
                );
          if (found !== undefined && relation.kind === 'manyToMany') {
            manyToMany.splice(manyToMany.indexOf(found), 1);
          }
          const { relatedName: _related, ...rest } = relation;
          void _related;
          return {
            ...rest,
            name: found?.name ?? relation.name,
            targetModel: target,
          };
        }),
      };
    }),
  };
}

/** The reverse accessors of the relations are names the reader guesses; they are not in the SQL. */
export function withoutRelatedNames(schema: IrSchema): IrSchema {
  return {
    ...schema,
    models: schema.models.map((model: IrModel): IrModel => ({
      ...model,
      relations: model.relations.map((relation: IrRelation): IrRelation => {
        const { relatedName: _related, ...rest } = relation;
        void _related;
        return rest;
      }),
    })),
  };
}

/**
 * What the Sequelize 7 SQL Server dialect makes of the columns of a schema, apart from the referential actions
 * and indexes the writer warns about (those are matched with its warnings): enums are plain strings without a
 * CHECK, arrays, JSON, hstore and ranges are NVARCHAR(MAX), an IP address is NVARCHAR(45), a duration is a BIGINT,
 * a DECIMAL without precision is DECIMAL(18, 0), a string without a length is NVARCHAR(255) as a key and
 * NVARCHAR(MAX) otherwise, and what Sequelize fills in itself (a client-side UUID, `NOW`, a Prisma Client
 * generator, the refresh of an updated-at column) is not in the SQL.
 */
export function asSqlServerHolds(
  schema: IrSchema,
  tables: readonly MssqlTable[]
): IrSchema {
  const held = (model: IrModel, field: IrField): IrField => {
    const result: IrField = { ...field, isAutoUpdated: false };
    const column: MssqlColumn | undefined = tables
      .find((candidate: MssqlTable) => candidate.name === model.tableName)
      ?.columns.find(
        (candidate: MssqlColumn) => candidate.name === field.columnName
      );
    const kind: IrDefault['kind'] | undefined = field.default?.kind;
    if (kind === 'now' || kind === 'clientGenerated' || kind === 'uuid') {
      delete result.default;
    }
    if (
      field.default?.kind === 'dbExpression' &&
      field.type === 'uuid' &&
      /uuid|newid/i.test(field.default.expression)
    ) {
      result.default = { kind: 'uuid' };
    }
    if (
      (field.arrayDepth ?? 0) > 0 ||
      ['json', 'hstore', 'range', 'unsupported'].includes(field.type)
    ) {
      delete result.arrayDepth;
      delete result.maxLength;
      delete result.enumName;
      result.type = 'text';
    } else if (field.enumName !== undefined) {
      const stored: string | undefined = schema.enums
        .find((candidate: IrEnum) => candidate.name === field.enumName)
        ?.values.find(
          (member) =>
            field.default?.kind === 'enumValue' &&
            member.name === field.default.value
        )?.dbValue;
      delete result.enumName;
      result.type = 'string';
      result.maxLength = 255;
      if (stored !== undefined) {
        result.default = { kind: 'literal', value: stored };
      }
    } else if (field.type === 'ipAddress') {
      result.type = 'string';
      result.maxLength = 45;
    } else if (field.type === 'duration') {
      result.type = 'bigInt';
    } else if (field.type === 'decimal' && field.maxDigits === undefined) {
      result.maxDigits = 18;
      result.decimalPlaces = 0;
    } else if (field.type === 'string' && field.maxLength === undefined) {
      if (column?.type === 'NVARCHAR(MAX)') {
        result.type = 'text';
      } else {
        result.maxLength = 255;
      }
    }
    return result;
  };
  return {
    ...schema,
    enums: [],
    models: schema.models.map((model: IrModel): IrModel => ({
      ...model,
      fields: model.fields.map((field: IrField) => held(model, field)),
    })),
  };
}

/**
 * The models that only join two others (two foreign keys that make up the primary key, no other column). The SQL
 * reader turns such a table into a many-to-many relation instead of a model.
 */
function joinModels(schema: IrSchema): Set<string> {
  return new Set(
    schema.models
      .filter(
        (model: IrModel) =>
          model.relations.length === 2 &&
          model.relations.every(
            (relation: IrRelation) => relation.kind === 'foreignKey'
          ) &&
          model.fields.every(
            (field: IrField) =>
              field.isPrimaryKey ||
              (model.compositePrimaryKey ?? []).includes(field.name)
          )
      )
      .map((model: IrModel) => model.name)
  );
}

/**
 * True for a difference that is not a defect: the action of a relation the writer changed and announced (SQL Server
 * has no RESTRICT, the dialect writes no ON UPDATE and drops some actions, and SQL Server refuses some cascades), an
 * index or unique constraint it skipped with a warning because SQL Server cannot index the column, and a join model
 * that the reader makes a many-to-many relation of. Anything else is a defect.
 */
export function announced(
  difference: IrDifference,
  warnings: readonly string[],
  joins: ReadonlySet<string>
): boolean {
  const where: string = [difference.model, difference.field]
    .filter((part): part is string => part !== undefined)
    .join('.');
  switch (difference.kind) {
    case 'relationOnDelete':
      return warnings.some(
        (warning: string) =>
          warning.includes('NO ACTION') && warning.startsWith(`${where}:`)
      );
    case 'indexRemoved':
      return warnings.some(
        (warning: string) =>
          warning.includes('SQL Server cannot index') &&
          warning.startsWith(`${difference.model ?? ''} index`)
      );
    case 'fieldUnique':
      return warnings.some(
        (warning: string) =>
          warning.includes('SQL Server cannot index') &&
          warning.startsWith(`${where}:`)
      );
    case 'modelRemoved':
      return joins.has(difference.model ?? '');
    case 'relationAdded':
      return joins.size > 0 && difference.after.includes('manyToMany');
    default:
      return false;
  }
}

/** The differences between the IR and what was read back that are defects, formatted. */
export function unannounced(
  expected: IrSchema,
  differences: readonly IrDifference[],
  warnings: readonly string[]
): string[] {
  const joins: Set<string> = joinModels(expected);
  return differences
    .filter(
      (difference: IrDifference) => !announced(difference, warnings, joins)
    )
    .map(formatDifference);
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * The SQL Server type the Sequelize 7 dialect writes for a field (`@sequelize/mssql`: STRING is NVARCHAR, DATE is
 * DATETIMEOFFSET, JSON is NVARCHAR(MAX)); undefined for a field whose column the writer does not decide alone
 * (database-specific types, generated columns, enums are checked as strings).
 */
export function expectedMssqlType(field: IrField): RegExp | undefined {
  if (field.nativeType !== undefined || field.generated !== undefined) {
    return undefined;
  }
  if ((field.arrayDepth ?? 0) > 0) {
    return /^NVARCHAR\(MAX\)$/;
  }
  if (field.enumName !== undefined) {
    return /^NVARCHAR\(255\)$/;
  }
  switch (field.type) {
    case 'string':
      // A string without a length is TEXT, or STRING (255) when it is a key or an indexed column.
      return field.maxLength === undefined
        ? /^NVARCHAR\((?:255|MAX)\)$/
        : new RegExp(`^NVARCHAR\\(${field.maxLength}\\)$`);
    case 'text':
    case 'json':
    case 'hstore':
      return /^NVARCHAR\(MAX\)$/;
    case 'int':
      return /^INTEGER$/;
    case 'bigInt':
    case 'duration':
      return /^BIGINT$/;
    case 'float':
      return /^DOUBLE PRECISION$/;
    case 'decimal':
      return field.maxDigits === undefined
        ? /^DECIMAL\(\d+, \d+\)$/
        : new RegExp(
            `^DECIMAL\\(${field.maxDigits}, ${field.decimalPlaces ?? 0}\\)$`
          );
    case 'boolean':
      return /^BIT$/;
    case 'dateTime':
      return /^DATETIMEOFFSET(?:\(\d+\))?$/;
    case 'date':
      return /^DATE$/;
    case 'time':
      return /^TIME$/;
    case 'uuid':
      return /^UNIQUEIDENTIFIER$/;
    case 'bytes':
      return /^VARBINARY\(MAX\)$/;
    case 'ipAddress':
      return /^NVARCHAR\(45\)$/;
    default:
      return undefined;
  }
}

/** Lists the columns whose SQL Server type is not the one the IR field calls for. */
export function compareMssqlTypes(
  ir: IrSchema,
  tables: readonly MssqlTable[]
): string[] {
  const problems: string[] = [];
  for (const model of ir.models) {
    const table: MssqlTable | undefined = tables.find(
      (candidate: MssqlTable) => candidate.name === model.tableName
    );
    if (table === undefined) {
      continue;
    }
    for (const field of model.fields) {
      const column: MssqlColumn | undefined = table.columns.find(
        (candidate: MssqlColumn) => candidate.name === field.columnName
      );
      const expected: RegExp | undefined = expectedMssqlType(field);
      if (column === undefined || expected === undefined) {
        continue;
      }
      if (!expected.test(column.type)) {
        problems.push(
          `${model.tableName}.${field.columnName}: type ${column.type} in the DDL, ${field.type}${field.maxLength === undefined ? '' : `(${field.maxLength})`} in the IR`
        );
      }
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Rules of SQL Server that the dialect does not enforce
// ---------------------------------------------------------------------------

/** The longest identifier SQL Server accepts. */
const MAX_IDENTIFIER_LENGTH: number = 128;

/** Types SQL Server cannot use as an index or key column. */
const UNKEYABLE: RegExp = /^(?:NVARCHAR|VARCHAR|VARBINARY)\(MAX\)$/;

/** Defaults SQL Server knows: a number, a string literal, or one of its own functions. */
const SQL_SERVER_DEFAULT: RegExp =
  /^(?:-?\d+(?:\.\d+)?|N?'(?:[^']|'')*'|\(?(?:GETDATE|GETUTCDATE|SYSDATETIME|SYSUTCDATETIME|SYSDATETIMEOFFSET|NEWID|NEWSEQUENTIALID)\(\)\)?|CURRENT_TIMESTAMP|NULL)$/i;

/** True for a cascading action of a foreign key, which SQL Server restricts (error 1785). */
function cascading(action: string | undefined): boolean {
  return (
    action === 'CASCADE' || action === 'SET NULL' || action === 'SET DEFAULT'
  );
}

/** The key of a table in the cascade graph. */
function tableKey(schema: string | undefined, name: string): string {
  return `${schema ?? 'dbo'}.${name}`;
}

/**
 * SQL Server refuses a foreign key with a cascading action that makes a cycle (a table that cascades to itself
 * included) or a second cascade path from one table to another. Lists the foreign keys that would be refused.
 */
function cascadeProblems(tables: readonly MssqlTable[]): string[] {
  const edges: Map<string, string[]> = new Map<string, string[]>();
  for (const table of tables) {
    for (const key of table.foreignKeys) {
      if (!cascading(key.onDelete) && !cascading(key.onUpdate)) {
        continue;
      }
      const parent: string = tableKey(key.schema ?? table.schema, key.table);
      edges.set(parent, [
        ...(edges.get(parent) ?? []),
        tableKey(table.schema, table.name),
      ]);
    }
  }
  const problems: string[] = [];
  for (const start of edges.keys()) {
    const paths: Map<string, number> = new Map<string, number>();
    const walk = (node: string, stack: readonly string[]): void => {
      for (const next of edges.get(node) ?? []) {
        if (stack.includes(next) || next === start) {
          problems.push(
            `a cascading foreign key cycle through ${[...stack, next].join(' -> ')}`
          );
          continue;
        }
        paths.set(next, (paths.get(next) ?? 0) + 1);
        walk(next, [...stack, next]);
      }
    };
    walk(start, [start]);
    for (const [target, count] of paths) {
      if (count > 1) {
        problems.push(
          `${count} cascade paths from ${start} to ${target} (SQL Server error 1785)`
        );
      }
    }
  }
  return [...new Set(problems)];
}

/**
 * Lists what SQL Server would refuse in the DDL although the dialect writes it: `RESTRICT` actions, a key or index
 * over an unbounded column, defaults it has no function for, identifiers over 128 characters, a schema called
 * `public`, a second index of one name on a table, and cascading foreign keys that cycle or take two paths.
 */
export function sqlServerProblems(statements: readonly string[]): string[] {
  const tables: MssqlTable[] = readTables(statements);
  const indexes: MssqlIndex[] = readIndexes(statements);
  const problems: string[] = [];
  const typeOf = (table: MssqlTable, column: string): string =>
    table.columns.find((candidate: MssqlColumn) => candidate.name === column)
      ?.type ?? '';
  for (const table of tables) {
    const label: string = `${table.schema === undefined ? '' : `${table.schema}.`}${table.name}`;
    if (table.schema === 'public') {
      problems.push(
        `${label}: SQL Server has no schema "public" (dbo is its default)`
      );
    }
    const names: string[] = [
      table.name,
      ...table.columns.map((column: MssqlColumn) => column.name),
      ...table.uniques.flatMap((unique) =>
        unique.name === undefined ? [] : [unique.name]
      ),
    ];
    for (const name of names) {
      if (name.length > MAX_IDENTIFIER_LENGTH) {
        problems.push(
          `${label}: the identifier ${name} is longer than ${MAX_IDENTIFIER_LENGTH} characters`
        );
      }
    }
    for (const key of table.foreignKeys) {
      for (const action of [key.onDelete, key.onUpdate]) {
        if (action === 'RESTRICT') {
          problems.push(
            `${label}: ON DELETE/UPDATE RESTRICT is not T-SQL (NO ACTION is its equivalent)`
          );
        }
      }
    }
    const keyed: string[][] = [
      table.primaryKey,
      ...table.uniques.map((unique) => unique.columns),
    ];
    for (const columns of keyed) {
      for (const column of columns) {
        if (UNKEYABLE.test(typeOf(table, column))) {
          problems.push(
            `${label}.${column}: ${typeOf(table, column)} cannot be a key column`
          );
        }
      }
    }
    for (const column of table.columns) {
      if (
        column.default !== undefined &&
        !SQL_SERVER_DEFAULT.test(column.default)
      ) {
        problems.push(
          `${label}.${column.name}: DEFAULT ${column.default} is not a SQL Server default`
        );
      }
    }
  }
  const seen: Set<string> = new Set<string>();
  for (const index of indexes) {
    const table: MssqlTable | undefined = tables.find(
      (candidate: MssqlTable) => candidate.name === index.table
    );
    const label: string = `${index.table}.${index.name}`;
    if (seen.has(label)) {
      problems.push(`${label}: the index name is used twice on the table`);
    }
    seen.add(label);
    if (index.name.length > MAX_IDENTIFIER_LENGTH) {
      problems.push(
        `${label}: the index name is longer than ${MAX_IDENTIFIER_LENGTH} characters`
      );
    }
    for (const column of index.columns) {
      if (table !== undefined && UNKEYABLE.test(typeOf(table, column))) {
        problems.push(
          `${label}: ${typeOf(table, column)} column ${column} cannot be indexed`
        );
      }
    }
  }
  for (const table of tables) {
    for (const unique of table.uniques) {
      if (
        unique.name !== undefined &&
        seen.has(`${table.name}.${unique.name}`)
      ) {
        problems.push(
          `${table.name}.${unique.name}: a unique constraint and an index have the same name`
        );
      }
    }
  }
  return [...problems, ...cascadeProblems(tables)];
}
