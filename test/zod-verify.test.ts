import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import {
  emitZod,
  type ZodBigIntMode,
  type ZodDateMode,
} from '../src/emitters/zod.js';
import type {
  IrEnum,
  IrField,
  IrModel,
  IrRelation,
  IrSchema,
} from '../src/ir.js';
import { findModel } from '../src/ir.js';
import { toCamelCase, toSnakeCase } from '../src/naming.js';
import { normalizeSchema, type NamingMode } from '../src/transforms.js';
import {
  convertSource,
  parseSource,
  titleWithReason,
  VERIFY_SOURCES,
  writeProjectFile,
  type ToolProbe,
  type VerifySource,
} from './realToolSupport.js';

/**
 * Compiles the generated Zod schemas with `tsc --strict` and runs them with the real Zod
 * (through tsx): valid sample rows built from the IR must be accepted by `<Model>Schema`, the
 * create, update and relation schemas, and rows that break one rule (a missing required
 * property, a too long string, a value outside an enum, null in a required property, ...) must
 * be rejected. See test/tools/validate-zod.ts for the full list.
 *
 * Set ZOD_DIR to a directory where `npm install zod typescript tsx @types/node` has been run;
 * see test/README.md and test/tools/setup-verification-tools.sh. The tests are skipped when it
 * is not set.
 */

const REQUIRED_PACKAGES: readonly string[] = [
  'zod',
  'typescript',
  'tsx',
  '@types/node',
];

const VALIDATOR_SOURCE: string = readFileSync(
  fileURLToPath(new URL('./tools/validate-zod.ts', import.meta.url)),
  'utf8'
);

const TSCONFIG: string = JSON.stringify(
  {
    compilerOptions: {
      target: 'ES2022',
      module: 'nodenext',
      moduleResolution: 'nodenext',
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      types: ['node'],
    },
    include: ['schemas.ts'],
  },
  null,
  2
);

function probeZod(): ToolProbe & { directory: string } {
  const directory: string = process.env.ZOD_DIR ?? '';
  if (directory === '') {
    return {
      available: false,
      reason:
        'set ZOD_DIR to a directory with zod, typescript and tsx installed (see test/README.md)',
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
      reason: `ZOD_DIR is missing ${missing.join(', ')} (see test/README.md)`,
      directory,
    };
  }
  return { available: true, reason: '', directory };
}

const probe: ReturnType<typeof probeZod> = probeZod();
const toolDirectory: string = probe.directory;
const directories: string[] = [];

afterAll(() => {
  for (const directory of directories) {
    rmSync(directory, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// The spec: what the schemas have to accept and reject, derived from the IR.
// ---------------------------------------------------------------------------

interface SpecProperty {
  key: string;
  type: string;
  arrayDepth: number;
  nullable: boolean;
  maxLength?: number;
  maxDigits?: number;
  decimalPlaces?: number;
  enumValues?: string[];
  rangeOf?: string;
  omitOnCreate: boolean;
  optionalOnCreate: boolean;
}

interface SpecRelation {
  key: string;
  target: string;
  list: boolean;
  forward: boolean;
}

interface SpecModel {
  typeName: string;
  isView: boolean;
  properties: SpecProperty[];
  relations: SpecRelation[];
}

interface Spec {
  dates: ZodDateMode;
  bigints: ZodBigIntMode;
  models: SpecModel[];
}

function isGenerated(field: IrField): boolean {
  if (field.generated !== undefined || field.isAutoUpdated) {
    return true;
  }
  return (
    field.default?.kind === 'autoIncrement' ||
    (field.default?.kind === 'dbExpression' &&
      field.default.isFunction === true)
  );
}

/** The column a relation points at: an explicit field, else the primary key, else through a key relation. */
function referencedField(
  schema: IrSchema,
  target: IrModel,
  toField: string | undefined,
  depth: number = 0
): IrField | undefined {
  const column: IrField | undefined =
    target.fields.find((field: IrField) => field.name === toField) ??
    target.fields.find((field: IrField) => field.isPrimaryKey);
  if (column !== undefined || depth > 5) {
    return column;
  }
  const chained: IrRelation | undefined = target.relations.find(
    (relation: IrRelation) => relation.isPrimaryKey === true
  );
  const next: IrModel | undefined =
    chained === undefined ? undefined : findModel(schema, chained.targetModel);
  return next === undefined
    ? undefined
    : referencedField(schema, next, chained?.toField, depth + 1);
}

function fieldProperty(
  schema: IrSchema,
  field: IrField,
  key: string
): SpecProperty {
  const enumDefinition: IrEnum | undefined = schema.enums.find(
    (candidate: IrEnum) => candidate.name === field.enumName
  );
  const omitOnCreate: boolean = isGenerated(field);
  return {
    key,
    type: field.type,
    arrayDepth: field.arrayDepth ?? 0,
    nullable: field.isNullable,
    ...(field.maxLength === undefined ? {} : { maxLength: field.maxLength }),
    ...(field.maxDigits === undefined ? {} : { maxDigits: field.maxDigits }),
    ...(field.decimalPlaces === undefined
      ? {}
      : { decimalPlaces: field.decimalPlaces }),
    ...(enumDefinition === undefined
      ? {}
      : { enumValues: enumDefinition.values.map((value) => value.dbValue) }),
    ...(field.rangeOf === undefined ? {} : { rangeOf: field.rangeOf }),
    omitOnCreate,
    optionalOnCreate:
      !omitOnCreate &&
      (field.isNullable ||
        field.default !== undefined ||
        field.isDbDefault === true),
  };
}

function buildSpec(
  schema: IrSchema,
  camel: boolean,
  dates: ZodDateMode,
  bigints: ZodBigIntMode
): Spec {
  const rename = (name: string): string => (camel ? toCamelCase(name) : name);
  const models: SpecModel[] = schema.models.map((model: IrModel): SpecModel => {
    const properties: SpecProperty[] = model.fields.map((field: IrField) =>
      fieldProperty(schema, field, rename(field.name))
    );
    const relations: SpecRelation[] = [];
    for (const relation of model.relations) {
      const target: IrModel | undefined = findModel(
        schema,
        relation.targetModel
      );
      if (target === undefined) {
        continue;
      }
      if (relation.kind !== 'manyToMany') {
        const key: string = rename(relation.columnName);
        if (
          !properties.some((property: SpecProperty) => property.key === key)
        ) {
          const column: IrField | undefined = referencedField(
            schema,
            target,
            relation.toField
          );
          properties.push({
            ...(column === undefined
              ? {
                  key,
                  type: 'unknown',
                  arrayDepth: 0,
                  nullable: false,
                  omitOnCreate: false,
                  optionalOnCreate: relation.isNullable,
                }
              : {
                  ...fieldProperty(schema, column, key),
                  nullable: relation.isNullable,
                  omitOnCreate: false,
                  optionalOnCreate: relation.isNullable,
                  // The foreign key carries the type of the column, not its generated-ness.
                }),
          });
        }
      }
      relations.push({
        key: rename(relation.name),
        target: target.name,
        list: relation.kind === 'manyToMany',
        forward: true,
      });
    }
    return {
      typeName: model.name,
      isView: model.isView === true,
      properties,
      relations,
    };
  });
  // The reverse side of every relation lives on the target model.
  for (const model of schema.models) {
    for (const relation of model.relations) {
      const holder: SpecModel | undefined = models.find(
        (candidate: SpecModel) => candidate.typeName === relation.targetModel
      );
      if (holder === undefined) {
        continue;
      }
      const fallback: string =
        relation.kind === 'oneToOne'
          ? toSnakeCase(model.name)
          : `${toSnakeCase(model.name)}_set`;
      holder.relations.push({
        key: rename(relation.relatedName ?? fallback),
        target: model.name,
        list: relation.kind !== 'oneToOne',
        forward: false,
      });
    }
  }
  return { dates, bigints, models };
}

// ---------------------------------------------------------------------------
// Running the real tools
// ---------------------------------------------------------------------------

function run(
  directory: string,
  command: string,
  args: string[]
): SpawnSyncReturns<string> {
  return spawnSync(command, args, {
    cwd: directory,
    encoding: 'utf8',
    timeout: 120_000,
  });
}

/** Writes the project, compiles `schemas.ts` with tsc --strict and runs the validator. */
function verify(schemasText: string, spec: Spec, label: string): void {
  const directory: string = mkdtempSync(join(tmpdir(), 'ormbridge-zod-'));
  directories.push(directory);
  symlinkSync(
    join(toolDirectory, 'node_modules'),
    join(directory, 'node_modules'),
    'dir'
  );
  writeProjectFile(directory, 'schemas.ts', schemasText);
  writeProjectFile(directory, 'tsconfig.json', TSCONFIG);
  writeProjectFile(directory, 'validate-zod.ts', VALIDATOR_SOURCE);
  writeProjectFile(directory, 'spec.json', JSON.stringify(spec));

  const compiled: SpawnSyncReturns<string> = run(
    directory,
    join(toolDirectory, 'node_modules', '.bin', 'tsc'),
    ['-p', 'tsconfig.json']
  );
  expect(compiled.stdout + compiled.stderr, `${label} tsc`).toBe('');
  expect(compiled.status).toBe(0);

  const verified: SpawnSyncReturns<string> = run(
    directory,
    join(toolDirectory, 'node_modules', '.bin', 'tsx'),
    ['validate-zod.ts', 'spec.json']
  );
  expect(verified.stderr, `${label}: ${verified.stdout}`).toBe('');
  expect(verified.stdout).toContain('zod schemas verified');
  expect(verified.status).toBe(0);
}

describe(titleWithReason('zod emitter: real Zod', probe), () => {
  const cases: (readonly [VerifySource, NamingMode])[] = VERIFY_SOURCES.flatMap(
    (source: VerifySource): (readonly [VerifySource, NamingMode])[] => [
      [source, 'preserve'],
      [source, 'normalize'],
    ]
  );

  it.skipIf(!probe.available).each(cases)(
    'compiles and validates the schemas generated from %o (%s naming)',
    async (source: VerifySource, naming: NamingMode) => {
      const parsed: IrSchema = await parseSource(source);
      const prepared: IrSchema =
        naming === 'normalize' ? normalizeSchema(parsed) : parsed;
      const result = await convertSource(source, 'zod', { naming });
      verify(
        result.output,
        buildSpec(prepared, naming === 'normalize', 'coerce', 'string'),
        `${source.label} (${naming})`
      );
    },
    180_000
  );

  const alternates: VerifySource[] = VERIFY_SOURCES.filter(
    (source: VerifySource) =>
      source.label === 'prisma' || source.label === 'django-extras'
  );

  it.skipIf(!probe.available).each(alternates)(
    'validates the "string" dates and "bigint" modes on the $label schema',
    async (source: VerifySource) => {
      const parsed: IrSchema = await parseSource(source);
      const text: string = emitZod(parsed, {
        camelFields: false,
        dates: 'string',
        bigints: 'bigint',
      }).text;
      verify(text, buildSpec(parsed, false, 'string', 'bigint'), source.label);
    },
    180_000
  );
});
