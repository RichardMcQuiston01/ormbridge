import type { IrEnum, IrModel, IrRelation, IrSchema } from '../src/ir.js';
import { expandManyToMany } from '../src/transforms.js';

const IDENTIFIER: string =
  '(?:"(?:[^"]|"")+"|`(?:[^`]|``)+`|\\[[^\\]]+\\]|[A-Za-z_][\\w$]*)';
const TABLE_START: RegExp = new RegExp(
  `^CREATE TABLE (${IDENTIFIER}) \\(\\n`,
  'gm'
);

function unquote(identifier: string): string {
  if (identifier.startsWith('"')) {
    return identifier.slice(1, -1).replace(/""/g, '"');
  }
  if (identifier.startsWith('`')) {
    return identifier.slice(1, -1).replace(/``/g, '`');
  }
  if (identifier.startsWith('[')) {
    return identifier.slice(1, -1).replace(/\]\]/g, ']');
  }
  return identifier;
}

function escapePattern(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The statements of the script: each `CREATE TABLE` body, by table name. */
function readTables(text: string): Map<string, string> {
  const tables: Map<string, string> = new Map<string, string>();
  for (const match of text.matchAll(TABLE_START)) {
    const start: number = (match.index ?? 0) + match[0].length;
    const end: number = text.indexOf('\n)', start);
    tables.set(
      unquote(match[1] ?? ''),
      text.slice(start, end === -1 ? text.length : end)
    );
  }
  return tables;
}

/** True when a table body declares the column (a line that starts with its identifier). */
function declaresColumn(body: string, column: string): boolean {
  return new RegExp(
    `^ {2}(?:"${escapePattern(column.replace(/"/g, '""'))}"|\`${escapePattern(column)}\`|\\[${escapePattern(column)}\\]|${escapePattern(column)}) `,
    'm'
  ).test(body);
}

/**
 * A structural check of generated SQL DDL against the IR it came from. The SQL format has no reader
 * yet, so the conversion matrix cannot compare IRs; this lists what is missing instead: a model
 * without a `CREATE TABLE`, a column that was not written, a foreign key without its
 * `FOREIGN KEY ... REFERENCES` clause, a many-to-many relation without its join table, a unique
 * field without a `UNIQUE`, an index without a `CREATE INDEX`, an enum whose values are not written
 * anywhere in the script, and a view without its commented placeholder. An empty result means the
 * output covers the IR. It reads the "preserve" naming mode in any of the four dialects.
 */
export function checkSqlDdlOutput(
  schema: IrSchema,
  files: Record<string, string>
): string[] {
  const text: string | undefined = Object.values(files)[0];
  if (text === undefined) {
    return ['no sql file'];
  }
  const missing: string[] = [];
  const tables: Map<string, string> = readTables(text);
  // Many-to-many fields are written as the join tables the other formats create.
  const expanded: IrSchema = expandManyToMany(schema);
  for (const model of expanded.models) {
    if (model.isView === true) {
      if (!text.includes(`-- View `)) {
        missing.push(`${model.name}: no view placeholder`);
      }
      continue;
    }
    const body: string | undefined = tables.get(model.tableName);
    if (body === undefined) {
      missing.push(`${model.name}: no table ${model.tableName}`);
      continue;
    }
    for (const field of model.fields) {
      if (!declaresColumn(body, field.columnName)) {
        missing.push(`${model.name}: no column ${field.columnName}`);
      }
      if (
        field.isUnique &&
        !field.isPrimaryKey &&
        !new RegExp(`UNIQUE \\([^)]*${escapePattern(field.columnName)}`).test(
          `${body}\n${text}`
        )
      ) {
        missing.push(`${model.name}: no unique key on ${field.columnName}`);
      }
    }
    for (const relation of model.relations) {
      missing.push(...checkRelation(model, relation, body, text));
    }
    if (
      model.fields.some((field) => field.isPrimaryKey) &&
      !/PRIMARY KEY/.test(body)
    ) {
      missing.push(`${model.name}: no primary key`);
    }
    for (const index of model.indexes) {
      const lines: string[] = text
        .split('\n')
        .filter((line: string) =>
          /^CREATE (UNIQUE |FULLTEXT )?INDEX /.test(line)
        );
      const names: string[] = index.fields.map(
        (name: string) =>
          model.fields.find((field) => field.name === name)?.columnName ??
          model.relations.find((relation) => relation.name === name)
            ?.columnName ??
          name
      );
      const found: boolean = lines.some(
        (line: string) =>
          line.includes(model.tableName) &&
          names.every((name: string) => line.includes(name))
      );
      if (!found) {
        missing.push(`${model.name}: no index on (${names.join(', ')})`);
      }
    }
  }
  missing.push(...checkEnums(schema.enums, text));
  return missing;
}

function columnPattern(column: string): string {
  const plain: string = escapePattern(column);
  return `(?:"${escapePattern(column.replace(/"/g, '""'))}"|\`${plain}\`|\\[${plain}\\]|${plain})`;
}

function checkRelation(
  model: IrModel,
  relation: IrRelation,
  body: string,
  text: string
): string[] {
  if (relation.kind === 'manyToMany') {
    return [
      `${model.name}.${relation.name}: the many-to-many field was not expanded`,
    ];
  }
  const label: string = `${model.name}.${relation.name}`;
  if (!declaresColumn(body, relation.columnName)) {
    return [`${label}: no column ${relation.columnName}`];
  }
  const clause: RegExp = new RegExp(
    `FOREIGN KEY \\((?:[^)]*, )?${columnPattern(relation.columnName)}(?:, [^)]*)?\\) REFERENCES`
  );
  // A key that closes a cycle is added with ALTER TABLE instead of inside CREATE TABLE.
  const altered: boolean = text
    .split('\n')
    .some(
      (line: string) =>
        line.startsWith('ALTER TABLE ') &&
        line.includes(model.tableName) &&
        clause.test(line)
    );
  return clause.test(body) || altered
    ? []
    : [`${label}: no foreign key reference`];
}

function checkEnums(enums: IrEnum[], text: string): string[] {
  const missing: string[] = [];
  for (const definition of enums) {
    if (definition.values.length === 0) {
      continue;
    }
    const complete: boolean = definition.values.every((value) =>
      text.includes(`'${value.dbValue.replace(/'/g, "''")}'`)
    );
    if (!complete) {
      missing.push(`enum ${definition.name}: not all values are written`);
    }
  }
  return missing;
}
