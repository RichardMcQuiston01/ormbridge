import { gormColumnName } from '../src/emitters/gorm.js';
import type { IrEnum, IrModel, IrRelation, IrSchema } from '../src/ir.js';

/** One struct found in generated Go: its table, and the columns its fields map to. */
interface GoStruct {
  table: string;
  columns: Set<string>;
  tags: string[];
}

/** The tag `gorm:"..."` of a struct line, split into entries (an escaped semicolon stays inside its entry). */
function tagEntries(line: string): string[] {
  const tag: RegExpMatchArray | null = /`gorm:"(.*)"`/.exec(line);
  if (tag === null) {
    return [];
  }
  return (tag[1] ?? '')
    .replace(/\\\\;/g, '\uE000')
    .split(';')
    .map((entry: string) => entry.replace(/\uE000/g, ';'));
}

function readStructs(files: Record<string, string>): GoStruct[] {
  const structs: GoStruct[] = [];
  for (const text of Object.values(files)) {
    const header: RegExpMatchArray | null =
      /^\/\/ \w+ maps to the "(.*)" table\.$/m.exec(text);
    const body: RegExpMatchArray | null =
      /^type \w+ struct \{\n([\s\S]*?)^\}/m.exec(text);
    if (header === null || body === null) {
      continue;
    }
    const struct: GoStruct = {
      table: header[1] ?? '',
      columns: new Set<string>(),
      tags: [],
    };
    for (const line of (body[1] ?? '').split('\n')) {
      const member: RegExpMatchArray | null = /^\t(\w+)\s+(\S+)/.exec(line);
      if (member === null) {
        continue;
      }
      const entries: string[] = tagEntries(line);
      struct.tags.push(...entries);
      const isAssociation: boolean = entries.some(
        (entry: string) =>
          entry.startsWith('foreignKey:') || entry.startsWith('many2many:')
      );
      if (isAssociation) {
        continue;
      }
      const explicit: string | undefined = entries
        .find((entry: string) => entry.startsWith('column:'))
        ?.slice('column:'.length);
      struct.columns.add(explicit ?? gormColumnName(member[1] ?? ''));
    }
    // gorm.Model brings its four columns along.
    if (/^\tgorm\.Model$/m.test(body[1] ?? '')) {
      for (const column of ['id', 'created_at', 'updated_at', 'deleted_at']) {
        struct.columns.add(column);
      }
    }
    structs.push(struct);
  }
  return structs;
}

/**
 * A structural check of generated GORM models against the IR they came from.
 * GORM has no reader yet, so the conversion matrix cannot compare IRs; this
 * lists what is missing instead: a model without a struct for its table, a
 * column without a field, a many-to-many relation without its join table tag
 * and an enum without its type. An empty result means the output covers the IR.
 */
export function checkGormOutput(
  schema: IrSchema,
  files: Record<string, string>
): string[] {
  const missing: string[] = [];
  const structs: GoStruct[] = readStructs(files);
  for (const model of schema.models) {
    const struct: GoStruct | undefined = structs.find(
      (candidate: GoStruct) => candidate.table === model.tableName
    );
    if (struct === undefined) {
      missing.push(`${model.name}: no struct for table ${model.tableName}`);
      continue;
    }
    const expected: string[] = [
      ...model.fields.map((field) => field.columnName),
      ...model.relations
        .filter((relation: IrRelation) => relation.kind !== 'manyToMany')
        .map((relation: IrRelation) => relation.columnName),
    ];
    for (const column of expected) {
      if (!struct.columns.has(column)) {
        missing.push(`${model.name}: no field for column ${column}`);
      }
    }
    missing.push(...checkManyToMany(model, struct));
  }
  missing.push(...checkEnums(schema.enums, files));
  return missing;
}

function checkManyToMany(model: IrModel, struct: GoStruct): string[] {
  const missing: string[] = [];
  for (const relation of model.relations) {
    if (relation.kind !== 'manyToMany') {
      continue;
    }
    const wanted: string = `many2many:${model.tableName}_${relation.name}`;
    if (!struct.tags.includes(wanted)) {
      missing.push(`${model.name}.${relation.name}: no ${wanted} association`);
    }
  }
  return missing;
}

function checkEnums(enums: IrEnum[], files: Record<string, string>): string[] {
  const missing: string[] = [];
  const texts: string[] = Object.values(files);
  for (const enumDefinition of enums) {
    const declaring: string | undefined = texts.find((text: string) =>
      new RegExp(`^type ${enumDefinition.name} string$`, 'm').test(text)
    );
    if (declaring === undefined) {
      missing.push(`enum ${enumDefinition.name}: no string type`);
      continue;
    }
    for (const value of enumDefinition.values) {
      if (!declaring.includes(`= ${JSON.stringify(value.dbValue)}`)) {
        missing.push(
          `enum ${enumDefinition.name}: no constant for ${value.dbValue}`
        );
      }
    }
  }
  return missing;
}
