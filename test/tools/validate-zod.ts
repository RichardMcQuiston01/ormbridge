/**
 * Checks generated Zod schemas with the real Zod: valid sample rows are accepted and rows that
 * break one rule are rejected.
 *
 * Usage (from the scratch project, next to the generated `schemas.ts`):
 *   tsx validate-zod.ts <spec.json>
 *
 * The spec lists, per model, the properties of the row with their IR type, nullability, length,
 * enum values and create-schema role (see test/zod-verify.test.ts). For every model the script
 * generates a valid row and checks that
 *
 * - `<Model>Schema` accepts it, accepts null exactly in nullable properties, and rejects a row
 *   with a missing property, a too long string, a value outside an enum, a malformed decimal,
 *   and null in a non-nullable property;
 * - `<Model>CreateSchema` accepts a row without generated and optional properties, drops the
 *   generated ones and rejects a missing required property;
 * - `<Model>UpdateSchema` accepts an empty object and each property alone, and rejects an
 *   invalid value;
 * - `<Model>WithRelationsSchema` accepts the row with related rows nested (resolved lazily)
 *   and rejects a related row of the wrong shape.
 *
 * Every problem is printed to stderr and the exit code is 1; success prints
 * "zod schemas verified".
 *
 * This file is run inside the scratch project (it imports the generated `schemas.ts`, which
 * imports `zod`, a package ormbridge does not depend on), so it only uses the public Zod API.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

interface SpecProperty {
  key: string;
  /** IR scalar type; "unknown" when the schema does not constrain the value. */
  type: string;
  arrayDepth: number;
  nullable: boolean;
  maxLength?: number;
  maxDigits?: number;
  decimalPlaces?: number;
  enumValues?: string[];
  rangeOf?: string;
  /** True when the create schema leaves the property out. */
  omitOnCreate: boolean;
  /** True when the create schema allows the property to be missing. */
  optionalOnCreate: boolean;
}

interface SpecRelation {
  key: string;
  /** Name of the related model. */
  target: string;
  list: boolean;
  /** True for the side that holds the foreign key. */
  forward: boolean;
}

interface SpecModel {
  /** The name of the TypeScript type the schemas are called after. */
  typeName: string;
  isView: boolean;
  properties: SpecProperty[];
  relations: SpecRelation[];
}

interface Spec {
  dates: 'coerce' | 'string';
  bigints: 'string' | 'bigint';
  models: SpecModel[];
}

interface SafeParseResult {
  success: boolean;
  data?: unknown;
}

interface ZodLikeSchema {
  safeParse(value: unknown): SafeParseResult;
}

type Row = Record<string, unknown>;

const problems: string[] = [];

function expectParse(
  schemaName: string,
  schema: ZodLikeSchema | undefined,
  value: unknown,
  accepted: boolean,
  what: string
): SafeParseResult | undefined {
  if (schema === undefined) {
    problems.push(`${schemaName} is not exported`);
    return undefined;
  }
  const result: SafeParseResult = schema.safeParse(value);
  if (result.success !== accepted) {
    const shown: string = JSON.stringify(
      value,
      (_key: string, item: unknown) =>
        typeof item === 'bigint' ? `${item}n` : item
    );
    problems.push(
      `${schemaName} ${accepted ? 'rejected' : 'accepted'} ${what}: ${shown.length > 240 ? `${shown.slice(0, 240)}...` : shown}`
    );
  }
  return result;
}

/** A valid value for the element type of a property. */
function sampleElement(spec: Spec, property: SpecProperty): unknown {
  if (property.enumValues !== undefined) {
    return property.enumValues[0];
  }
  switch (property.type) {
    case 'string':
    case 'text':
      return 'x'.repeat(Math.min(property.maxLength ?? 3, 3));
    case 'uuid':
      return '123e4567-e89b-42d3-a456-426614174000';
    case 'time':
      return '03:04:05';
    case 'duration':
      return '1 day, 2:00:00';
    case 'bytes':
      return 'aGVsbG8=';
    case 'bigInt':
      return spec.bigints === 'bigint' ? 12n : '12';
    case 'decimal':
      return (property.decimalPlaces ?? 0) > 0 ? '1.5' : '1';
    case 'int':
      return 1;
    case 'float':
      return 1.5;
    case 'boolean':
      return true;
    case 'dateTime':
      return spec.dates === 'string'
        ? '2024-01-02T03:04:05.000Z'
        : new Date('2024-01-02T03:04:05.000Z');
    case 'date':
      return '2024-01-02';
    case 'json':
      return { a: [1, 2] };
    case 'ipAddress':
      return '127.0.0.1';
    case 'hstore':
      return { a: 'b', c: null };
    case 'range':
      return {
        lower: rangeBound(spec, property.rangeOf),
        upper: null,
        bounds: '[)',
      };
    default:
      return 'anything';
  }
}

function rangeBound(spec: Spec, rangeOf: string | undefined): unknown {
  switch (rangeOf) {
    case 'int':
      return 1;
    case 'bigInt':
      return spec.bigints === 'bigint' ? 1n : '1';
    case 'decimal':
      return '1.5';
    case 'dateTime':
      return spec.dates === 'string' ? '2024-01-02T03:04:05Z' : new Date(0);
    case 'date':
      return '2024-01-02';
    default:
      return 'bound';
  }
}

function sample(spec: Spec, property: SpecProperty): unknown {
  let value: unknown = sampleElement(spec, property);
  for (let level: number = 0; level < property.arrayDepth; level += 1) {
    value = [value];
  }
  return value;
}

function sampleRow(spec: Spec, model: SpecModel): Row {
  const row: Row = {};
  for (const property of model.properties) {
    row[property.key] = sample(spec, property);
  }
  return row;
}

/** Properties whose schema accepts any value, including undefined and null. */
function isUnconstrained(property: SpecProperty): boolean {
  return (
    property.arrayDepth === 0 &&
    (property.type === 'json' ||
      property.type === 'unknown' ||
      property.type === 'unsupported')
  );
}

/** True when `null` is not rejected by the schema of a non-nullable property. */
function acceptsNull(spec: Spec, property: SpecProperty): boolean {
  const isDate: boolean =
    property.type === 'date' || property.type === 'dateTime';
  // z.coerce.date() turns null into the epoch.
  return (
    isUnconstrained(property) ||
    (isDate && spec.dates === 'coerce' && property.arrayDepth === 0)
  );
}

/** A string or array value whose length is one over the limit. */
function tooLong(property: SpecProperty): unknown {
  let value: unknown = 'x'.repeat((property.maxLength ?? 0) + 1);
  for (let level: number = 0; level < property.arrayDepth; level += 1) {
    value = [value];
  }
  return value;
}

function checkRow(
  spec: Spec,
  model: SpecModel,
  schemas: Record<string, ZodLikeSchema | undefined>
): void {
  const name: string = `${model.typeName}Schema`;
  const schema: ZodLikeSchema | undefined = schemas[name];
  const row: Row = sampleRow(spec, model);
  expectParse(name, schema, row, true, 'a valid row');
  expectParse(name, schema, 'not an object', false, 'a string');

  for (const property of model.properties) {
    const label: string = property.key;
    if (!isUnconstrained(property)) {
      const without: Row = { ...row };
      delete without[property.key];
      expectParse(name, schema, without, false, `a row without ${label}`);
    }
    if (property.nullable) {
      expectParse(
        name,
        schema,
        { ...row, [property.key]: null },
        true,
        `null in the nullable ${label}`
      );
    } else if (!acceptsNull(spec, property)) {
      expectParse(
        name,
        schema,
        { ...row, [property.key]: null },
        false,
        `null in the required ${label}`
      );
    }
    if (property.maxLength !== undefined && property.enumValues === undefined) {
      expectParse(
        name,
        schema,
        { ...row, [property.key]: tooLong(property) },
        false,
        `a ${label} over ${property.maxLength} characters`
      );
    }
    if (property.enumValues !== undefined) {
      for (const value of property.enumValues) {
        let item: unknown = value;
        for (let level: number = 0; level < property.arrayDepth; level += 1) {
          item = [item];
        }
        expectParse(
          name,
          schema,
          { ...row, [property.key]: item },
          true,
          `the enum value ${value} in ${label}`
        );
      }
      let bad: unknown = 'NOT_A_VALUE';
      for (let level: number = 0; level < property.arrayDepth; level += 1) {
        bad = [bad];
      }
      expectParse(
        name,
        schema,
        { ...row, [property.key]: bad },
        false,
        `a value outside the enum in ${label}`
      );
    }
    if (
      property.type === 'decimal' &&
      property.enumValues === undefined &&
      property.arrayDepth === 0
    ) {
      expectParse(
        name,
        schema,
        { ...row, [property.key]: 'abc' },
        false,
        `text in the decimal ${label}`
      );
      if (property.maxDigits !== undefined) {
        const integerDigits: number = Math.max(
          property.maxDigits - (property.decimalPlaces ?? 0),
          1
        );
        expectParse(
          name,
          schema,
          { ...row, [property.key]: '9'.repeat(integerDigits + 1) },
          false,
          `too many digits in the decimal ${label}`
        );
      }
    }
    if (property.type === 'int' && property.arrayDepth === 0) {
      expectParse(
        name,
        schema,
        { ...row, [property.key]: 1.5 },
        false,
        `a fraction in the integer ${label}`
      );
      expectParse(
        name,
        schema,
        { ...row, [property.key]: 'one' },
        false,
        `text in the integer ${label}`
      );
    }
    if (property.type === 'uuid' && property.arrayDepth === 0) {
      expectParse(
        name,
        schema,
        { ...row, [property.key]: 'not-a-uuid' },
        false,
        `a malformed uuid in ${label}`
      );
    }
    if (property.type === 'boolean' && property.arrayDepth === 0) {
      expectParse(
        name,
        schema,
        { ...row, [property.key]: 'yes' },
        false,
        `text in the boolean ${label}`
      );
    }
  }
}

function checkCreateAndUpdate(
  spec: Spec,
  model: SpecModel,
  schemas: Record<string, ZodLikeSchema | undefined>
): void {
  const createName: string = `${model.typeName}CreateSchema`;
  const updateName: string = `${model.typeName}UpdateSchema`;
  if (model.isView) {
    for (const name of [createName, updateName]) {
      if (schemas[name] !== undefined) {
        problems.push(`${name} is exported for a view`);
      }
    }
    return;
  }
  const create: ZodLikeSchema | undefined = schemas[createName];
  const update: ZodLikeSchema | undefined = schemas[updateName];
  const row: Row = sampleRow(spec, model);

  // The full row is accepted; the generated properties are stripped from the result.
  const result: SafeParseResult | undefined = expectParse(
    createName,
    create,
    row,
    true,
    'a full row'
  );
  const parsed: Row = (result?.data ?? {}) as Row;
  for (const property of model.properties) {
    if (property.omitOnCreate && property.key in parsed) {
      problems.push(
        `${createName} kept the generated property ${property.key}`
      );
    }
    if (!property.omitOnCreate && !(property.key in parsed)) {
      problems.push(`${createName} lost the property ${property.key}`);
    }
  }

  // Without the generated and the optional properties the row is still accepted.
  const minimal: Row = { ...row };
  for (const property of model.properties) {
    if (property.omitOnCreate || property.optionalOnCreate) {
      delete minimal[property.key];
    }
  }
  expectParse(
    createName,
    create,
    minimal,
    true,
    'a row with only the required'
  );

  for (const property of model.properties) {
    if (
      property.omitOnCreate ||
      property.optionalOnCreate ||
      isUnconstrained(property)
    ) {
      continue;
    }
    const without: Row = { ...minimal };
    delete without[property.key];
    expectParse(
      createName,
      create,
      without,
      false,
      `a row without the required ${property.key}`
    );
  }

  expectParse(updateName, update, {}, true, 'an empty object');
  for (const property of model.properties) {
    if (property.omitOnCreate) {
      const stripped: SafeParseResult | undefined = update?.safeParse({
        [property.key]: sample(spec, property),
      });
      if (
        stripped?.success === true &&
        property.key in (stripped.data as Row)
      ) {
        problems.push(
          `${updateName} kept the generated property ${property.key}`
        );
      }
      continue;
    }
    expectParse(
      updateName,
      update,
      { [property.key]: sample(spec, property) },
      true,
      `only ${property.key}`
    );
    if (!property.nullable && !acceptsNull(spec, property)) {
      expectParse(
        updateName,
        update,
        { [property.key]: null },
        false,
        `null in the required ${property.key}`
      );
    }
  }
}

function checkRelations(
  spec: Spec,
  model: SpecModel,
  schemas: Record<string, ZodLikeSchema | undefined>
): void {
  const name: string = `${model.typeName}WithRelationsSchema`;
  const schema: ZodLikeSchema | undefined = schemas[name];
  if (model.relations.length === 0) {
    if (schema !== undefined) {
      problems.push(`${name} is exported for a model without relations`);
    }
    return;
  }
  const row: Row = sampleRow(spec, model);
  expectParse(name, schema, row, true, 'the row without related rows');
  for (const relation of model.relations) {
    const target: SpecModel | undefined = spec.models.find(
      (candidate: SpecModel) => candidate.typeName === relation.target
    );
    if (target === undefined) {
      problems.push(`${name}: unknown related model ${relation.target}`);
      continue;
    }
    // The related row is resolved through z.lazy and the related model's own schema.
    const related: Row = sampleRow(spec, target);
    const nested: unknown = relation.list ? [related] : related;
    expectParse(
      name,
      schema,
      { ...row, [relation.key]: nested },
      true,
      `a related row in ${relation.key}`
    );
    expectParse(
      name,
      schema,
      { ...row, [relation.key]: relation.list ? 42 : 'wrong' },
      false,
      `a malformed value in ${relation.key}`
    );
    expectParse(
      name,
      schema,
      {
        ...row,
        [relation.key]: relation.list
          ? [{ ...related, [firstRequired(target)]: undefined }]
          : { ...related, [firstRequired(target)]: undefined },
      },
      false,
      `a related row missing a property in ${relation.key}`
    );
  }
}

/** The key of a property that the schema constrains (any model has one except an all-json model). */
function firstRequired(model: SpecModel): string {
  const property: SpecProperty | undefined = model.properties.find(
    (candidate: SpecProperty) => !isUnconstrained(candidate)
  );
  return property?.key ?? 'id';
}

async function main(): Promise<number> {
  const specPath: string | undefined = process.argv[2];
  if (specPath === undefined) {
    process.stderr.write('usage: validate-zod.ts <spec.json>\n');
    return 2;
  }
  const spec: Spec = JSON.parse(readFileSync(specPath, 'utf8')) as Spec;
  const schemas: Record<string, ZodLikeSchema | undefined> = (await import(
    pathToFileURL(join(process.cwd(), 'schemas.ts')).href
  )) as Record<string, ZodLikeSchema | undefined>;

  for (const model of spec.models) {
    if (schemas[`${model.typeName}Schema`] === undefined) {
      problems.push(`${model.typeName}Schema is not exported`);
      continue;
    }
    checkRow(spec, model, schemas);
    checkCreateAndUpdate(spec, model, schemas);
    checkRelations(spec, model, schemas);
  }

  if (problems.length > 0) {
    process.stderr.write(`${problems.join('\n')}\n`);
    return 1;
  }
  process.stdout.write(`zod schemas verified (${spec.models.length} models)\n`);
  return 0;
}

main().then(
  (code: number): void => {
    process.exitCode = code;
  },
  (error: unknown): void => {
    process.stderr.write(`${String(error)}\n`);
    process.exitCode = 1;
  }
);
