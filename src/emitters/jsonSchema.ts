import { prismaOnlyWarnings } from '../prismaOnlyConstructs.js';
import type {
  IrDefault,
  IrEnum,
  IrEnumValue,
  IrField,
  IrModel,
  IrRelation,
  IrSchema,
} from '../ir.js';
import { findModel } from '../ir.js';
import { toCamelCase, toSnakeCase } from '../naming.js';
import type { EmitOutput } from './prisma.js';

/** The JSON Schema dialect the document declares. */
export const JSON_SCHEMA_DIALECT: string =
  'https://json-schema.org/draft/2020-12/schema';

/** Identifier written when the caller gives none. */
export const JSON_SCHEMA_DEFAULT_ID: string = 'urn:ormbridge:schema';

/** Where `$ref` values point by default: the `$defs` of the document itself. */
export const JSON_SCHEMA_DEFAULT_REF_PREFIX: string = '#/$defs/';

export interface JsonSchemaOptions {
  /** Use camelCase property names (the `normalize` naming mode). */
  camelFields: boolean;
  /** Value of the top-level `$id`. Defaults to `urn:ormbridge:schema`. */
  id?: string;
  /**
   * Prefix of every `$ref`. Defaults to `#/$defs/`; pass `#/components/schemas/` after copying the
   * `$defs` entries into an OpenAPI document's `components.schemas`.
   */
  refPrefix?: string;
}

type JsonObject = Record<string, unknown>;

interface ModelNames {
  fields: Map<string, string>;
  relations: Map<string, string>;
  /** Foreign-key scalar property per relation (absent when a field already provides it). */
  scalars: Map<string, string>;
  used: Set<string>;
}

interface Property {
  name: string;
  schema: JsonObject;
  required: boolean;
}

interface EmitContext {
  schema: IrSchema;
  refPrefix: string;
  camelFields: boolean;
  warnings: string[];
  names: Map<string, ModelNames>;
  /** "Model.relation" -> property name of the reverse side on the target model. */
  inverseNames: Map<string, string>;
  /** Definition names that were actually written (after sanitizing), keyed "model:X" / "enum:X". */
  defNames: Map<string, string>;
}

const DEF_NAME_PATTERN: RegExp = /^[A-Za-z0-9_.-]+$/;
const MAX_KEY_DEPTH: number = 5;

/** Value ranges of Prisma native integer types (the IR has no other integer sizes). */
const NATIVE_INT_RANGES: Readonly<Record<string, readonly [number, number]>> = {
  smallint: [-32768, 32767],
  smallserial: [1, 32767],
  tinyint: [-128, 127],
  unsignedtinyint: [0, 255],
  unsignedsmallint: [0, 65535],
  mediumint: [-8388608, 8388607],
  unsignedmediumint: [0, 16777215],
  integer: [-2147483648, 2147483647],
  int: [-2147483648, 2147483647],
  serial: [1, 2147483647],
  unsignedint: [0, 4294967295],
  unsignedinteger: [0, 4294967295],
};

export function emitJsonSchema(
  schema: IrSchema,
  options: JsonSchemaOptions
): EmitOutput {
  const context: EmitContext = {
    schema,
    refPrefix: options.refPrefix ?? JSON_SCHEMA_DEFAULT_REF_PREFIX,
    camelFields: options.camelFields,
    warnings: prismaOnlyWarnings(schema),
    names: new Map<string, ModelNames>(),
    inverseNames: new Map<string, string>(),
    defNames: new Map<string, string>(),
  };

  allocateDefinitionNames(context);
  allocateMemberNames(context);

  const reverse: Map<string, Property[]> = new Map<string, Property[]>();
  const forward: Map<string, Property[]> = new Map<string, Property[]>();
  for (const model of schema.models) {
    forward.set(model.name, buildForwardProperties(context, model, reverse));
  }

  const definitions: JsonObject = {};
  for (const enumDefinition of schema.enums) {
    definitions[enumDefName(context, enumDefinition)] = enumSchema(
      context,
      enumDefinition
    );
  }
  for (const model of schema.models) {
    const properties: Property[] = [
      ...(forward.get(model.name) ?? []),
      ...(reverse.get(model.name) ?? []),
    ];
    definitions[modelDefName(context, model)] = objectSchema(properties);
  }

  const document: JsonObject = {
    $schema: JSON_SCHEMA_DIALECT,
    $id: options.id ?? JSON_SCHEMA_DEFAULT_ID,
    $defs: definitions,
  };
  return {
    text: `${JSON.stringify(document, null, 2)}\n`,
    warnings: context.warnings,
  };
}

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

function uniqueName(baseName: string, used: Set<string>): string {
  let candidate: string = baseName;
  let suffix: number = 2;
  while (used.has(candidate)) {
    candidate = `${baseName}${suffix}`;
    suffix += 1;
  }
  used.add(candidate);
  return candidate;
}

function propertyName(context: EmitContext, rawName: string): string {
  return context.camelFields ? toCamelCase(rawName) : rawName;
}

function definitionIdentifier(
  context: EmitContext,
  description: string,
  raw: string
): string {
  if (DEF_NAME_PATTERN.test(raw)) {
    return raw;
  }
  const result: string = raw.replace(/[^A-Za-z0-9_.-]/g, '_') || '_';
  context.warnings.push(
    `${description}: "${raw}" cannot be used in a $ref; it was written as "${result}".`
  );
  return result;
}

function allocateDefinitionNames(context: EmitContext): void {
  const used: Set<string> = new Set<string>();
  for (const enumDefinition of context.schema.enums) {
    const safe: string = definitionIdentifier(
      context,
      `enum ${enumDefinition.name}`,
      enumDefinition.name
    );
    const unique: string = uniqueName(safe, used);
    if (unique !== safe) {
      context.warnings.push(
        `enum ${enumDefinition.name}: the name is already used by another definition; it was written as "${unique}".`
      );
    }
    context.defNames.set(`enum:${enumDefinition.name}`, unique);
  }
  for (const model of context.schema.models) {
    const safe: string = definitionIdentifier(context, model.name, model.name);
    const unique: string = uniqueName(safe, used);
    if (unique !== safe) {
      context.warnings.push(
        `${model.name}: the name is already used by an enum or another model; the definition was written as "${unique}".`
      );
    }
    context.defNames.set(`model:${model.name}`, unique);
  }
}

function modelDefName(context: EmitContext, model: IrModel): string {
  return context.defNames.get(`model:${model.name}`) ?? model.name;
}

function enumDefName(context: EmitContext, enumDefinition: IrEnum): string {
  return (
    context.defNames.get(`enum:${enumDefinition.name}`) ?? enumDefinition.name
  );
}

function ref(context: EmitContext, definitionName: string): JsonObject {
  return { $ref: `${context.refPrefix}${definitionName}` };
}

function namesOf(context: EmitContext, model: IrModel): ModelNames {
  return (
    context.names.get(model.name) ?? {
      fields: new Map<string, string>(),
      relations: new Map<string, string>(),
      scalars: new Map<string, string>(),
      used: new Set<string>(),
    }
  );
}

function allocateMemberNames(context: EmitContext): void {
  for (const model of context.schema.models) {
    const names: ModelNames = {
      fields: new Map<string, string>(),
      relations: new Map<string, string>(),
      scalars: new Map<string, string>(),
      used: new Set<string>(),
    };
    for (const field of model.fields) {
      names.fields.set(
        field.name,
        uniqueName(propertyName(context, field.name), names.used)
      );
    }
    for (const relation of model.relations) {
      if (relation.kind !== 'manyToMany') {
        // The foreign-key scalar is written first; skip it when a field already provides it.
        const scalarName: string = propertyName(context, relation.columnName);
        if (!names.used.has(scalarName)) {
          names.used.add(scalarName);
          names.scalars.set(relation.name, scalarName);
        }
      }
      names.relations.set(
        relation.name,
        uniqueName(propertyName(context, relation.name), names.used)
      );
    }
    context.names.set(model.name, names);
  }

  for (const model of context.schema.models) {
    for (const relation of model.relations) {
      const targetNames: ModelNames | undefined = context.names.get(
        relation.targetModel
      );
      if (targetNames === undefined) {
        continue;
      }
      const defaultName: string =
        relation.kind === 'oneToOne'
          ? toSnakeCase(model.name)
          : `${toSnakeCase(model.name)}_set`;
      context.inverseNames.set(
        `${model.name}.${relation.name}`,
        uniqueName(
          propertyName(context, relation.relatedName ?? defaultName),
          targetNames.used
        )
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

function enumSchema(context: EmitContext, enumDefinition: IrEnum): JsonObject {
  const values: string[] = [];
  const labels: string[] = [];
  for (const value of enumDefinition.values) {
    if (values.includes(value.dbValue)) {
      context.warnings.push(
        `enum ${enumDefinition.name}: the value "${value.dbValue}" is declared more than once; the repeat was dropped.`
      );
      continue;
    }
    values.push(value.dbValue);
    if (value.label !== undefined && value.label !== '') {
      labels.push(`${value.dbValue}: ${value.label}`);
    }
  }
  const result: JsonObject = { type: 'string', enum: values };
  if (labels.length > 0) {
    result.description = labels.join('\n');
  }
  return result;
}

function findEnumValue(
  enumDefinition: IrEnum,
  raw: string
): IrEnumValue | undefined {
  return (
    enumDefinition.values.find((value: IrEnumValue) => value.name === raw) ??
    enumDefinition.values.find((value: IrEnumValue) => value.dbValue === raw)
  );
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Allows null next to the schema without changing what else it checks. */
function nullable(schema: JsonObject): JsonObject {
  const type: unknown = schema.type;
  if (typeof type === 'string') {
    return { ...schema, type: [type, 'null'] };
  }
  if (type === undefined && schema.$ref === undefined) {
    // An unconstrained schema (json) already accepts null.
    return schema;
  }
  return { anyOf: [schema, { type: 'null' }] };
}

/** Digits before and after the decimal point allowed by a `decimal` column, as a pattern. */
function decimalPattern(field: IrField): string {
  const places: number | undefined = field.decimalPlaces;
  const digits: number | undefined = field.maxDigits;
  if (digits === undefined || places === undefined || places > digits) {
    return '^-?[0-9]+(\\.[0-9]+)?$';
  }
  const whole: number = digits - places;
  const wholePart: string = whole === 0 ? '0?' : `[0-9]{1,${whole}}`;
  const fraction: string = places === 0 ? '' : `(\\.[0-9]{1,${places}})?`;
  return `^-?${wholePart}${fraction}$`;
}

function nativeIntRange(field: IrField): readonly [number, number] | undefined {
  if (field.nativeType === undefined) {
    return undefined;
  }
  return NATIVE_INT_RANGES[field.nativeType.name.toLowerCase()];
}

function rangeBoundSchema(field: IrField): JsonObject {
  switch (field.rangeOf) {
    case 'int':
      return { type: ['integer', 'null'] };
    case 'dateTime':
      return { type: ['string', 'null'], format: 'date-time' };
    case 'date':
      return { type: ['string', 'null'], format: 'date' };
    default:
      return { type: ['string', 'null'] };
  }
}

/**
 * Returns the schema of one value of a scalar field (the innermost element of an array),
 * without null. Problems are only reported when `report` is true, so a type that is looked
 * up twice produces one warning.
 */
function elementSchema(
  context: EmitContext,
  label: string,
  field: IrField,
  report: boolean
): JsonObject {
  if (field.enumName !== undefined) {
    const enumDefinition: IrEnum | undefined = context.schema.enums.find(
      (candidate: IrEnum) => candidate.name === field.enumName
    );
    if (enumDefinition !== undefined) {
      return ref(context, enumDefName(context, enumDefinition));
    }
    if (report) {
      context.warnings.push(
        `${label}: enum "${field.enumName}" does not exist in the schema; the property is typed as string.`
      );
    }
    return { type: 'string' };
  }

  switch (field.type) {
    case 'string':
    case 'text': {
      const result: JsonObject = { type: 'string' };
      if (field.maxLength !== undefined) {
        result.maxLength = field.maxLength;
      }
      return result;
    }
    case 'uuid':
      return { type: 'string', format: 'uuid' };
    case 'time':
      return { type: 'string', format: 'time' };
    case 'dateTime':
      return { type: 'string', format: 'date-time' };
    case 'date':
      return { type: 'string', format: 'date' };
    case 'duration':
      return { type: 'string', format: 'duration' };
    case 'ipAddress':
      return { type: 'string' };
    case 'bytes':
      // Binary data travels as base64 text.
      return { type: 'string', contentEncoding: 'base64' };
    case 'bigInt':
      // Does not fit a JSON number without losing precision, so it travels as a string.
      return { type: 'string', pattern: '^-?[0-9]+$' };
    case 'decimal':
      return { type: 'string', pattern: decimalPattern(field) };
    case 'int': {
      const result: JsonObject = { type: 'integer' };
      const range: readonly [number, number] | undefined =
        nativeIntRange(field);
      if (range !== undefined) {
        result.minimum = range[0];
        result.maximum = range[1];
      }
      return result;
    }
    case 'float':
      return { type: 'number' };
    case 'boolean':
      return { type: 'boolean' };
    case 'json':
      return {};
    case 'hstore':
      return {
        type: 'object',
        additionalProperties: { type: ['string', 'null'] },
      };
    case 'range':
      return {
        type: 'object',
        properties: {
          lower: rangeBoundSchema(field),
          upper: rangeBoundSchema(field),
          bounds: { type: 'string' },
        },
        required: ['lower', 'upper'],
        additionalProperties: false,
      };
    default:
      if (report) {
        context.warnings.push(
          `${label}: unknown field type "${String(field.type)}"; the property accepts any value.`
        );
      }
      return {};
  }
}

/** The schema of a field's value, wrapped in one `array` per dimension, without null. */
function valueSchema(
  context: EmitContext,
  label: string,
  field: IrField,
  report: boolean
): JsonObject {
  let result: JsonObject = elementSchema(context, label, field, report);
  for (let depth: number = 0; depth < (field.arrayDepth ?? 0); depth += 1) {
    result = { type: 'array', items: result };
  }
  return result;
}

/** Resolves the schema of the column a relation points at (an explicit to_field, else the primary key). */
function referencedSchema(
  context: EmitContext,
  target: IrModel,
  toField: string | undefined,
  depth: number = 0
): JsonObject | undefined {
  if (depth > MAX_KEY_DEPTH) {
    return undefined;
  }
  const explicit: IrField | undefined =
    toField === undefined
      ? undefined
      : target.fields.find((field: IrField) => field.name === toField);
  const column: IrField | undefined =
    explicit ?? target.fields.find((field: IrField) => field.isPrimaryKey);
  if (column !== undefined) {
    return valueSchema(context, `${target.name}.${column.name}`, column, false);
  }
  const primaryRelation: IrRelation | undefined = target.relations.find(
    (relation: IrRelation) => relation.isPrimaryKey === true
  );
  if (primaryRelation === undefined) {
    return undefined;
  }
  const chained: IrModel | undefined = findModel(
    context.schema,
    primaryRelation.targetModel
  );
  return chained === undefined
    ? undefined
    : referencedSchema(context, chained, primaryRelation.toField, depth + 1);
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/** True when the database or ORM fills the value in, so a client never has to send it. */
function isGenerated(field: IrField): boolean {
  if (field.isAutoUpdated || field.generated !== undefined) {
    return true;
  }
  const defaultValue: IrDefault | undefined = field.default;
  if (defaultValue === undefined) {
    return false;
  }
  switch (defaultValue.kind) {
    case 'autoIncrement':
    case 'now':
    case 'uuid':
    case 'clientGenerated':
    case 'dbExpression':
      return true;
    default:
      return false;
  }
}

/** The JSON value of a literal or enum default, or undefined when it cannot be written faithfully. */
function defaultValueOf(
  context: EmitContext,
  field: IrField,
  value: JsonObject
): unknown {
  const defaultValue: IrDefault | undefined = field.default;
  if (defaultValue === undefined || field.arrayDepth !== undefined) {
    return undefined;
  }
  if (defaultValue.kind === 'enumValue') {
    const enumDefinition: IrEnum | undefined = context.schema.enums.find(
      (candidate: IrEnum) => candidate.name === field.enumName
    );
    return enumDefinition === undefined
      ? undefined
      : findEnumValue(enumDefinition, defaultValue.value)?.dbValue;
  }
  if (defaultValue.kind !== 'literal') {
    return undefined;
  }
  const literal: string | number | boolean = defaultValue.value;
  switch (value.type) {
    case 'string':
      return typeof literal === 'boolean' ? undefined : String(literal);
    case 'integer':
    case 'number':
      return typeof literal === 'number' ? literal : undefined;
    case 'boolean':
      return typeof literal === 'boolean' ? literal : undefined;
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------

function fieldProperty(
  context: EmitContext,
  model: IrModel,
  field: IrField,
  name: string
): Property {
  const label: string = `${model.name}.${field.name}`;
  const base: JsonObject = valueSchema(context, label, field, true);
  let schema: JsonObject = field.isNullable ? nullable(base) : base;
  const generated: boolean = isGenerated(field);
  const description: string[] = [];
  if (field.generated !== undefined) {
    description.push(`Generated column: ${field.generated.expression}`);
  }
  if (description.length > 0) {
    schema = { ...schema, description: description.join('\n') };
  }
  const defaultValue: unknown = defaultValueOf(context, field, base);
  if (defaultValue !== undefined) {
    schema = { ...schema, default: defaultValue };
  }
  if (generated) {
    schema = { ...schema, readOnly: true };
  }
  return {
    name,
    schema,
    required: !field.isNullable && field.default === undefined && !generated,
  };
}

function buildForwardProperties(
  context: EmitContext,
  model: IrModel,
  reverse: Map<string, Property[]>
): Property[] {
  const properties: Property[] = [];
  const names: ModelNames = namesOf(context, model);

  for (const field of model.fields) {
    properties.push(
      fieldProperty(
        context,
        model,
        field,
        names.fields.get(field.name) ?? field.name
      )
    );
  }

  for (const relation of model.relations) {
    const label: string = `${model.name}.${relation.name}`;
    const target: IrModel | undefined = findModel(
      context.schema,
      relation.targetModel
    );
    if (target === undefined) {
      context.warnings.push(
        `${label}: target model "${relation.targetModel}" does not exist in the schema; the relation was skipped.`
      );
      continue;
    }
    const targetRef: JsonObject = ref(context, modelDefName(context, target));
    const relationProp: string =
      names.relations.get(relation.name) ?? relation.name;
    const inverseProp: string =
      context.inverseNames.get(label) ?? toSnakeCase(model.name);
    const ownRef: JsonObject = ref(context, modelDefName(context, model));

    if (relation.kind === 'manyToMany') {
      properties.push({
        name: relationProp,
        schema: { type: 'array', items: targetRef },
        required: false,
      });
      addReverse(reverse, target.name, {
        name: inverseProp,
        schema: { type: 'array', items: ownRef },
        required: false,
      });
      continue;
    }

    const scalarProp: string | undefined = names.scalars.get(relation.name);
    if (scalarProp !== undefined) {
      let keySchema: JsonObject | undefined = referencedSchema(
        context,
        target,
        relation.toField
      );
      if (keySchema === undefined) {
        context.warnings.push(
          `${label}: target model "${target.name}" has no single-column primary key to reference; the foreign key "${scalarProp}" accepts any value.`
        );
        keySchema = {};
      }
      properties.push({
        name: scalarProp,
        schema: relation.isNullable ? nullable(keySchema) : keySchema,
        required: !relation.isNullable,
      });
    }
    properties.push({
      name: relationProp,
      schema: relation.isNullable ? nullable(targetRef) : targetRef,
      required: false,
    });
    addReverse(reverse, target.name, {
      name: inverseProp,
      schema:
        relation.kind === 'oneToOne'
          ? nullable(ownRef)
          : { type: 'array', items: ownRef },
      required: false,
    });
  }
  return properties;
}

function addReverse(
  reverse: Map<string, Property[]>,
  targetName: string,
  property: Property
): void {
  const existing: Property[] = reverse.get(targetName) ?? [];
  existing.push(property);
  reverse.set(targetName, existing);
}

function objectSchema(properties: Property[]): JsonObject {
  const members: JsonObject = {};
  const required: string[] = [];
  for (const property of properties) {
    members[property.name] = property.schema;
    if (property.required) {
      required.push(property.name);
    }
  }
  const result: JsonObject = { type: 'object', properties: members };
  if (required.length > 0) {
    result.required = required;
  }
  result.additionalProperties = false;
  return result;
}
