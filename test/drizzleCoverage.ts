import type { IrEnum, IrModel, IrRelation, IrSchema } from '../src/ir.js';
import { expandManyToMany } from '../src/transforms.js';

const QUOTED: string = `(['"])(.*?)\\1`;
const TABLE_CALL: RegExp = new RegExp(
  `export const \\w+ = (?:pg|mysql|sqlite)Table\\(\\s*${QUOTED}`,
  'g'
);

/** One table found in generated Drizzle code: its database name and the text of its declaration. */
interface DrizzleTable {
  name: string;
  body: string;
}

function readTables(schemaText: string): DrizzleTable[] {
  const matches: RegExpMatchArray[] = [...schemaText.matchAll(TABLE_CALL)];
  return matches.map((match: RegExpMatchArray, position: number) => {
    const start: number = match.index ?? 0;
    const next: number = matches[position + 1]?.index ?? schemaText.length;
    const end: number = schemaText.indexOf('\nexport type ', start);
    return {
      name: match[2] ?? '',
      body: schemaText.slice(start, end === -1 ? next : Math.min(end, next)),
    };
  });
}

function hasColumn(table: DrizzleTable, column: string): boolean {
  return (
    table.body.includes(`('${column}'`) || table.body.includes(`("${column}"`)
  );
}

/** The text of a column's declaration, up to the next property of the table. */
function columnDeclaration(
  table: DrizzleTable,
  column: string
): string | undefined {
  const start: number = Math.max(
    table.body.indexOf(`('${column}'`),
    table.body.indexOf(`("${column}"`)
  );
  if (start === -1) {
    return undefined;
  }
  const rest: string = table.body.slice(start);
  const next: number = rest.search(/\n\s{2,6}[A-Za-z_$][\w$]*: /);
  return next === -1 ? rest : rest.slice(0, next);
}

function enumValueLists(schemaText: string): string[][] {
  const lists: string[][] = [];
  for (const match of schemaText.matchAll(
    /export const \w+Values = \[([\s\S]*?)\] as const;/g
  )) {
    lists.push(
      [...(match[1] ?? '').matchAll(new RegExp(QUOTED, 'g'))].map(
        (value: RegExpMatchArray) => value[2] ?? ''
      )
    );
  }
  return lists;
}

/**
 * A structural check of generated Drizzle code against the IR it came from. Drizzle has no reader
 * yet, so the conversion matrix cannot compare IRs; this lists what is missing instead: a model
 * without a table, a column or foreign key that was not written, a many-to-many relation without its
 * join table and an enum without its value list. An empty result means the output covers the IR.
 */
export function checkDrizzleOutput(
  schema: IrSchema,
  files: Record<string, string>
): string[] {
  const missing: string[] = [];
  const schemaText: string | undefined = files['schema.ts'];
  if (schemaText === undefined) {
    return ['no schema.ts file'];
  }
  if (files['drizzle.config.ts'] === undefined) {
    missing.push('no drizzle.config.ts file');
  }
  const tables: DrizzleTable[] = readTables(schemaText);
  // Many-to-many fields are written as the join tables the other formats create.
  const expanded: IrSchema = expandManyToMany(schema);
  for (const model of expanded.models) {
    const table: DrizzleTable | undefined = tables.find(
      (candidate: DrizzleTable) => candidate.name === model.tableName
    );
    if (table === undefined) {
      missing.push(`${model.name}: no table ${model.tableName}`);
      continue;
    }
    for (const field of model.fields) {
      if (!hasColumn(table, field.columnName)) {
        missing.push(`${model.name}: no column ${field.columnName}`);
      }
    }
    for (const relation of model.relations) {
      missing.push(...checkRelation(model, relation, table, schemaText));
    }
  }
  missing.push(...checkEnums(schema.enums, schemaText));
  return missing;
}

function checkRelation(
  model: IrModel,
  relation: IrRelation,
  table: DrizzleTable,
  schemaText: string
): string[] {
  if (relation.kind === 'manyToMany') {
    return [
      `${model.name}.${relation.name}: the many-to-many field was not expanded`,
    ];
  }
  const declaration: string | undefined = columnDeclaration(
    table,
    relation.columnName
  );
  if (declaration === undefined) {
    return [`${model.name}.${relation.name}: no column ${relation.columnName}`];
  }
  const missing: string[] = [];
  if (!declaration.includes('.references(')) {
    missing.push(`${model.name}.${relation.name}: no foreign key reference`);
  }
  if (!/relations\(/.test(schemaText)) {
    missing.push(`${model.name}.${relation.name}: no relations() call`);
  }
  return missing;
}

function checkEnums(enums: IrEnum[], schemaText: string): string[] {
  const missing: string[] = [];
  const lists: string[][] = enumValueLists(schemaText);
  for (const enumDefinition of enums) {
    const wanted: string[] = enumDefinition.values.map(
      (value) => value.dbValue
    );
    const found: boolean = lists.some(
      (list: string[]) =>
        list.length === wanted.length &&
        wanted.every((value: string) => list.includes(value))
    );
    if (!found) {
      missing.push(`enum ${enumDefinition.name}: no value list`);
    }
  }
  return missing;
}
