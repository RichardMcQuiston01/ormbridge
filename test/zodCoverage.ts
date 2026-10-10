import type { IrEnum, IrModel, IrRelation, IrSchema } from '../src/ir.js';

function escapePattern(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Returns the text between a block's opening line (matched by `opening`) and its closing line. */
function blockBody(
  text: string,
  opening: RegExp,
  closing: string
): string | undefined {
  const match: RegExpExecArray | null = opening.exec(text);
  if (match === null) {
    return undefined;
  }
  const start: number = match.index + match[0].length;
  const end: number = text.indexOf(closing, start);
  return end === -1 ? undefined : text.slice(start, end);
}

function hasKey(body: string, key: string): boolean {
  return new RegExp(`^ {2}'?${escapePattern(key)}'?:`, 'm').test(body);
}

/**
 * A structural check of generated Zod schemas against the IR they came from.
 * Zod has no reader, so the conversion matrix cannot compare IRs; this lists
 * what is missing instead: a model without its `<Model>Schema`, a column or
 * foreign key without a property, a missing create or update schema (views have
 * none), a relation missing from `<Model>WithRelationsSchema` and an enum without its
 * schema or one of its values. An empty result means the output covers the IR.
 * It assumes the "preserve" naming mode.
 */
export function checkZodOutput(
  schema: IrSchema,
  files: Record<string, string>
): string[] {
  const text: string = Object.values(files).join('\n');
  const missing: string[] = [];
  for (const model of schema.models) {
    missing.push(...checkModel(text, model));
  }
  for (const enumDefinition of schema.enums) {
    missing.push(...checkEnum(text, enumDefinition));
  }
  return missing;
}

function checkModel(text: string, model: IrModel): string[] {
  const missing: string[] = [];
  const name: string = escapePattern(model.name);
  const body: string | undefined = blockBody(
    text,
    new RegExp(`^export const ${name}Schema = z\\.object\\(\\{\\n`, 'm'),
    '\n});'
  );
  if (body === undefined) {
    return [`${model.name}: no ${model.name}Schema`];
  }
  const keys: string[] = [
    ...model.fields.map((field) => field.name),
    ...model.relations
      .filter((relation: IrRelation) => relation.kind !== 'manyToMany')
      // A field that already holds the foreign key is not written twice.
      .map((relation: IrRelation) => relation.columnName),
  ];
  for (const key of keys) {
    if (!hasKey(body, key)) {
      missing.push(`${model.name}: no property for ${key}`);
    }
  }
  if (!new RegExp(`^export type ${name} = z\\.infer`, 'm').test(text)) {
    missing.push(`${model.name}: no inferred type`);
  }
  if (model.isView !== true) {
    for (const kind of ['Create', 'Update']) {
      if (
        !new RegExp(`^export const ${name}${kind}Schema = `, 'm').test(text)
      ) {
        missing.push(`${model.name}: no ${model.name}${kind}Schema`);
      }
    }
  }
  if (model.relations.length > 0) {
    const related: string | undefined = blockBody(
      text,
      new RegExp(
        `^export const ${name}WithRelationsSchema: [^\\n]*\\.extend\\(\\{\\n`,
        'm'
      ),
      '\n});'
    );
    if (related === undefined) {
      missing.push(`${model.name}: no ${model.name}WithRelationsSchema`);
    } else {
      for (const relation of model.relations) {
        if (!hasKey(related, relation.name)) {
          missing.push(
            `${model.name}.${relation.name}: not in ${model.name}WithRelationsSchema`
          );
        }
      }
    }
  }
  return missing;
}

function checkEnum(text: string, enumDefinition: IrEnum): string[] {
  const name: string = escapePattern(enumDefinition.name);
  const body: string | undefined = blockBody(
    text,
    new RegExp(`^export const ${name} = \\{\\n`, 'm'),
    '\n} as const;'
  );
  const hasSchema: boolean = new RegExp(
    `^export const ${name}Schema = z\\.enum\\(${name}\\);`,
    'm'
  ).test(text);
  if (body === undefined || !hasSchema) {
    return [`enum ${enumDefinition.name}: no z.enum schema`];
  }
  const missing: string[] = [];
  for (const value of enumDefinition.values) {
    if (!body.includes(`: '${value.dbValue}',`)) {
      missing.push(
        `enum ${enumDefinition.name}: no member for ${value.dbValue}`
      );
    }
  }
  return missing;
}
