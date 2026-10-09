import type { IrModel, IrSchema } from '../src/ir.js';

type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

/**
 * Structural check of a JSON Schema document written with the default (preserve) naming: it
 * declares the 2020-12 dialect, every enum and model has a definition, every model has a property
 * per column and per relation, and every enum-backed column points at its enum. Returns what is
 * missing; empty when the document covers the IR. The matrix cannot re-read JSON Schema, so this
 * stands in for the IR comparison.
 */
export function checkJsonSchemaOutput(
  schema: IrSchema,
  files: Record<string, string>
): string[] {
  const missing: string[] = [];
  const text: string | undefined = Object.values(files)[0];
  if (text === undefined) {
    return ['the JSON Schema document'];
  }
  let document: JsonObject | undefined;
  try {
    document = asObject(JSON.parse(text));
  } catch {
    return ['a document that parses as JSON'];
  }
  if (document === undefined) {
    return ['a JSON object at the top level'];
  }
  if (document.$schema !== 'https://json-schema.org/draft/2020-12/schema') {
    missing.push('the draft 2020-12 $schema');
  }
  if (typeof document.$id !== 'string') {
    missing.push('$id');
  }
  const definitions: JsonObject = asObject(document.$defs) ?? {};
  for (const enumDefinition of schema.enums) {
    if (asObject(definitions[enumDefinition.name]) === undefined) {
      missing.push(`$defs entry for enum ${enumDefinition.name}`);
    }
  }
  for (const model of schema.models) {
    const definition: JsonObject | undefined = asObject(
      definitions[model.name]
    );
    if (definition === undefined) {
      missing.push(`$defs entry for model ${model.name}`);
      continue;
    }
    missing.push(...checkModel(model, definition));
  }
  return missing;
}

function checkModel(model: IrModel, definition: JsonObject): string[] {
  const missing: string[] = [];
  const properties: JsonObject = asObject(definition.properties) ?? {};
  if (definition.additionalProperties !== false) {
    missing.push(`${model.name}: additionalProperties: false`);
  }
  for (const field of model.fields) {
    if (!(field.name in properties)) {
      missing.push(`${model.name}.${field.name}`);
    }
    if (field.enumName !== undefined) {
      const encoded: string = JSON.stringify(properties[field.name] ?? null);
      if (!encoded.includes(`/${field.enumName}"`)) {
        missing.push(
          `${model.name}.${field.name} reference to ${field.enumName}`
        );
      }
    }
  }
  for (const relation of model.relations) {
    if (!(relation.name in properties)) {
      missing.push(`${model.name}.${relation.name}`);
    }
  }
  return missing;
}
