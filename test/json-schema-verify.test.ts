import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type {
  IrEnum,
  IrField,
  IrModel,
  IrRelation,
  IrSchema,
} from '../src/ir.js';
import {
  convertSource,
  parseSource,
  titleWithReason,
  VERIFY_SOURCES,
  type ToolProbe,
  type VerifySource,
} from './realToolSupport.js';

/**
 * Loads the emitted JSON Schema document with the real Ajv (draft 2020-12 build, strict mode, with
 * ajv-formats): the document has to be a valid schema and compile, sample rows built from the IR
 * have to validate, and rows with a missing required property, a too-long string, a value outside
 * an enum, a null in a non-nullable column, a malformed date-time or an unknown property have to
 * be rejected.
 *
 * Set AJV_DIR to a directory where `npm install ajv ajv-formats` was run (see test/README.md and
 * test/tools/setup-verification-tools.sh); the tests are skipped without it.
 */

type JsonObject = Record<string, unknown>;

interface AjvValidate {
  (data: unknown): boolean;
  errors?: unknown;
}

interface AjvInstance {
  validateSchema(schema: unknown): boolean | Promise<unknown>;
  addSchema(schema: unknown): AjvInstance;
  getSchema(key: string): AjvValidate | undefined;
  errorsText(errors?: unknown): string;
}

type AjvConstructor = new (options: JsonObject) => AjvInstance;

const REQUIRED_PACKAGES: readonly string[] = ['ajv', 'ajv-formats'];

function probeAjv(): ToolProbe & { directory: string } {
  const directory: string = process.env.AJV_DIR ?? '';
  if (directory === '') {
    return {
      available: false,
      reason:
        'set AJV_DIR to a directory with ajv and ajv-formats installed (see test/README.md)',
      directory,
    };
  }
  const missing: string[] = REQUIRED_PACKAGES.filter(
    (name: string) =>
      !existsSync(join(directory, 'node_modules', name, 'package.json'))
  );
  if (missing.length > 0) {
    return {
      available: false,
      reason: `AJV_DIR is missing ${missing.join(', ')} (see test/README.md)`,
      directory,
    };
  }
  return { available: true, reason: '', directory };
}

const probe: ReturnType<typeof probeAjv> = probeAjv();

function createAjv(): AjvInstance {
  const load: NodeJS.Require = createRequire(
    join(probe.directory, 'package.json')
  );
  const ajvModule: { default: AjvConstructor } = load('ajv/dist/2020') as {
    default: AjvConstructor;
  };
  const formatsModule: { default: (ajv: AjvInstance) => void } = load(
    'ajv-formats'
  ) as { default: (ajv: AjvInstance) => void };
  const ajv: AjvInstance = new ajvModule.default({
    strict: true,
    allowUnionTypes: true,
    allErrors: false,
  });
  formatsModule.default(ajv);
  return ajv;
}

// ---------------------------------------------------------------------------
// Sample rows built from the IR (not from the emitted schema)
// ---------------------------------------------------------------------------

function sampleBound(field: IrField): unknown {
  switch (field.rangeOf) {
    case 'int':
      return 1;
    case 'date':
      return '2024-01-02';
    case 'dateTime':
      return '2024-01-02T03:04:05Z';
    default:
      return '1';
  }
}

function sampleElement(field: IrField, enums: IrEnum[]): unknown {
  if (field.enumName !== undefined) {
    const enumDefinition: IrEnum | undefined = enums.find(
      (candidate: IrEnum) => candidate.name === field.enumName
    );
    const first: string | undefined = enumDefinition?.values[0]?.dbValue;
    if (first !== undefined) {
      return first;
    }
  }
  switch (field.type) {
    case 'uuid':
      return '123e4567-e89b-12d3-a456-426614174000';
    case 'dateTime':
      return '2024-01-02T03:04:05Z';
    case 'date':
      return '2024-01-02';
    case 'time':
      return '03:04:05Z';
    case 'int':
      return 1;
    case 'float':
      return 1.5;
    case 'bigInt':
      return '1';
    case 'decimal':
      return '0';
    case 'boolean':
      return true;
    case 'json':
      return { a: 1 };
    case 'bytes':
      return 'AAAA';
    case 'duration':
      return 'P1D';
    case 'ipAddress':
      return '127.0.0.1';
    case 'hstore':
      return { a: 'b' };
    case 'range':
      return { lower: sampleBound(field), upper: sampleBound(field) };
    default:
      return 'x';
  }
}

function sampleValue(field: IrField, enums: IrEnum[]): unknown {
  let value: unknown = sampleElement(field, enums);
  for (let depth: number = 0; depth < (field.arrayDepth ?? 0); depth += 1) {
    value = [value];
  }
  return value;
}

function sampleKey(schema: IrSchema, relation: IrRelation): unknown {
  const target: IrModel | undefined = schema.models.find(
    (candidate: IrModel) => candidate.name === relation.targetModel
  );
  const column: IrField | undefined =
    target?.fields.find((candidate: IrField) =>
      relation.toField === undefined
        ? candidate.isPrimaryKey
        : candidate.name === relation.toField
    ) ?? target?.fields.find((candidate: IrField) => candidate.isPrimaryKey);
  return column === undefined ? 1 : sampleValue(column, schema.enums);
}

function sampleRow(schema: IrSchema, model: IrModel): JsonObject {
  const row: JsonObject = {};
  for (const field of model.fields) {
    row[field.name] = sampleValue(field, schema.enums);
  }
  for (const relation of model.relations) {
    if (relation.kind !== 'manyToMany' && !(relation.columnName in row)) {
      row[relation.columnName] = sampleKey(schema, relation);
    }
  }
  return row;
}

// ---------------------------------------------------------------------------

const CHECK_KINDS: readonly string[] = [
  'valid',
  'missing-required',
  'null',
  'too-long',
  'enum',
  'format',
  'extra',
];

describe(titleWithReason('json-schema emitter: real Ajv', probe), () => {
  // Views have no keys to speak of, but their rows validate like any other.
  const sources: readonly VerifySource[] = VERIFY_SOURCES;

  it.skipIf(!probe.available).each(sources)(
    'validates the document generated from the $label schema and its sample rows',
    async (source: VerifySource) => {
      const schema: IrSchema = await parseSource(source);
      const output: string = (await convertSource(source, 'json-schema'))
        .output;
      const document: JsonObject = JSON.parse(output) as JsonObject;

      const ajv: AjvInstance = createAjv();
      expect(
        ajv.validateSchema(document),
        `${source.label}: ${ajv.errorsText((ajv as unknown as { errors?: unknown }).errors)}`
      ).toBe(true);
      ajv.addSchema(document);
      const id: string = String(document.$id);
      const defs: JsonObject = document.$defs as JsonObject;
      for (const name of Object.keys(defs)) {
        // getSchema compiles the definition and resolves every $ref it contains.
        expect(
          ajv.getSchema(`${id}#/$defs/${name}`),
          `${source.label}: ${name} does not compile`
        ).toBeDefined();
      }

      const counts: Map<string, number> = new Map<string, number>();
      const count = (kind: string): void => {
        counts.set(kind, (counts.get(kind) ?? 0) + 1);
      };

      for (const model of schema.models) {
        const validate: AjvValidate | undefined = ajv.getSchema(
          `${id}#/$defs/${model.name}`
        );
        expect(validate).toBeDefined();
        if (validate === undefined) {
          continue;
        }
        const row: JsonObject = sampleRow(schema, model);
        const accepts = (candidate: JsonObject): boolean => validate(candidate);
        expect(
          accepts(row),
          `${source.label}.${model.name}: ${ajv.errorsText(validate.errors)}`
        ).toBe(true);
        count('valid');

        const required: string[] =
          ((defs[model.name] as JsonObject).required as string[] | undefined) ??
          [];
        const first: string | undefined = required[0];
        if (first !== undefined) {
          const broken: JsonObject = { ...row };
          delete broken[first];
          expect(accepts(broken), `${model.name} without ${first}`).toBe(false);
          count('missing-required');
        }

        const scalar: IrField | undefined = model.fields.find(
          (field: IrField) =>
            !field.isNullable &&
            field.arrayDepth === undefined &&
            field.type !== 'json' &&
            field.type !== 'unsupported'
        );
        if (scalar !== undefined) {
          expect(
            accepts({ ...row, [scalar.name]: null }),
            `${model.name}.${scalar.name} = null`
          ).toBe(false);
          count('null');
        }

        const long: IrField | undefined = model.fields.find(
          (field: IrField) =>
            field.maxLength !== undefined &&
            field.enumName === undefined &&
            field.arrayDepth === undefined &&
            (field.type === 'string' || field.type === 'text')
        );
        if (long?.maxLength !== undefined) {
          expect(
            accepts({ ...row, [long.name]: 'x'.repeat(long.maxLength + 1) }),
            `${model.name}.${long.name} too long`
          ).toBe(false);
          expect(
            accepts({ ...row, [long.name]: 'x'.repeat(long.maxLength) })
          ).toBe(true);
          count('too-long');
        }

        const enumerated: IrField | undefined = model.fields.find(
          (field: IrField) =>
            field.enumName !== undefined &&
            field.arrayDepth === undefined &&
            schema.enums.some(
              (candidate: IrEnum) => candidate.name === field.enumName
            )
        );
        if (enumerated !== undefined) {
          expect(
            accepts({ ...row, [enumerated.name]: 'not-a-listed-value' }),
            `${model.name}.${enumerated.name} bad enum`
          ).toBe(false);
          count('enum');
        }

        const dated: IrField | undefined = model.fields.find(
          (field: IrField) =>
            field.type === 'dateTime' &&
            field.arrayDepth === undefined &&
            field.enumName === undefined
        );
        if (dated !== undefined) {
          expect(
            accepts({ ...row, [dated.name]: 'yesterday afternoon' }),
            `${model.name}.${dated.name} bad date-time`
          ).toBe(false);
          count('format');
        }

        expect(
          accepts({ ...row, not_a_column: 1 }),
          `${model.name} with an unknown property`
        ).toBe(false);
        count('extra');
      }

      expect(counts.get('valid')).toBeGreaterThan(0);
      expect(counts.get('extra')).toBeGreaterThan(0);
      // The canonical blog schema has every kind of constraint; the extras only some.
      if (CANONICAL_LABELS.includes(source.label)) {
        for (const kind of CHECK_KINDS) {
          expect(counts.get(kind), `${source.label}: ${kind}`).toBeGreaterThan(
            0
          );
        }
      }
    },
    120_000
  );
});

const CANONICAL_LABELS: readonly string[] = [
  'django',
  'prisma',
  'typeorm',
  'doctrine',
  'laravel',
  'gorm',
];
