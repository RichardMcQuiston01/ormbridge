import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  convertText,
  type ConvertOptions,
  type ConvertResult,
} from '../src/convert.js';
import { getFormat, type SourceText } from '../src/formats.js';
import type {
  IrField,
  IrIndex,
  IrModel,
  IrOnDelete,
  IrRelation,
  IrSchema,
} from '../src/ir.js';
import { toSnakeCase } from '../src/naming.js';
import { CANONICAL_FIXTURES } from './fixtures/canonical.js';
import { DEFAULT_OPTIONS, expectOk } from './helpers.js';
import { loadCanonicalSources } from './harness.js';

/**
 * Shared helpers for the tests that check emitter output with the real tools (Django,
 * graphene-django, TypeORM). They describe what the output has to look like as a plain JSON
 * "spec" derived from the IR, which the scripts in test/tools compare with what the tool reports.
 */

/** A column of a model as the database and the ORM must see it. */
export interface SpecColumn {
  /** Property name (snake_case for Django). */
  name: string;
  /** Database column name. */
  column: string;
  /** IR scalar type; the scripts map it to a framework type. */
  type: string;
  nullable: boolean;
  unique: boolean;
  primaryKey: boolean;
  maxLength?: number;
  maxDigits?: number;
  decimalPlaces?: number;
  /** Stored values of the enum behind the field. */
  enumValues?: string[];
  /** Name of the enum behind the field. */
  enumName?: string;
  /** True when the source gave a database-specific column type, such as `Inet`. */
  nativeType?: boolean;
}

/** A foreign-key or one-to-one relation. */
export interface SpecRelation {
  name: string;
  column: string;
  kind: 'foreignKey' | 'oneToOne';
  target: string;
  targetTable: string;
  nullable: boolean;
  onDelete: IrOnDelete;
  relatedName?: string;
  primaryKey: boolean;
}

/** A many-to-many relation (the join table is created by the framework). */
export interface SpecManyToMany {
  name: string;
  target: string;
  relatedName?: string;
}

/** An index or unique constraint over columns. */
export interface SpecIndex {
  columns: string[];
  unique: boolean;
  name?: string;
}

export interface SpecModel {
  name: string;
  table: string;
  columns: SpecColumn[];
  relations: SpecRelation[];
  manyToMany: SpecManyToMany[];
  indexes: SpecIndex[];
  /** Columns of the primary key. */
  primaryKey: string[];
}

export interface Spec {
  models: SpecModel[];
}

export interface SpecOptions {
  /** Rename properties to snake_case, as the Django and Graphene emitters do. */
  snakeCaseNames: boolean;
}

/** A schema to verify: where it is read from and how it is called in test names. */
export interface VerifySource {
  /** Name used in test titles, for example "prisma" or "prisma-extras". */
  label: string;
  /** The format the files are read as. */
  format: string;
  /** The files that hold the schema. */
  sources: SourceText[];
}

function readSources(paths: readonly string[]): SourceText[] {
  return paths.map((path: string): SourceText => {
    const absolute: string = fileURLToPath(new URL(path, import.meta.url));
    return { path: absolute, text: readFileSync(absolute, 'utf8') };
  });
}

/** The canonical blog schema, read from every readable format. */
export const CANONICAL_SOURCES: readonly VerifySource[] =
  CANONICAL_FIXTURES.map((fixture): VerifySource => ({
    label: fixture.format,
    format: fixture.format,
    sources: loadCanonicalSources(fixture.format),
  }));

/**
 * The larger fixtures that exercise more constructs than the blog schema: explicit join models,
 * composite keys, sized and typed columns, defaults, native types and referential actions.
 */
export const EXTRA_SOURCES: readonly VerifySource[] = [
  {
    label: 'prisma-extras',
    format: 'prisma',
    // Left out because no real tool can load them here: views (written like tables without a
    // key, with a warning, which TypeORM rejects) and the PostgreSQL-only array and
    // Unsupported(...) columns (Django needs django.contrib.postgres and a PostgreSQL server).
    sources: readSources(['./fixtures/prisma-extras/schema.prisma']).map(
      (source: SourceText): SourceText => ({
        ...source,
        text: source.text
          .replace(/^view [^{]*\{[^}]*\}\n?/gmu, '')
          .replace(/^.*(?:\[\]|Unsupported\().*\n/gmu, ''),
      })
    ),
  },
  {
    label: 'django-extras',
    format: 'django',
    sources: readSources(['./fixtures/django-extras/models.py']),
  },
  {
    label: 'gorm-extras',
    format: 'gorm',
    sources: readSources(['./fixtures/gorm-extras/shop.go']),
  },
];

/** Every schema the verification tests run on. */
export const VERIFY_SOURCES: readonly VerifySource[] = [
  ...CANONICAL_SOURCES,
  ...EXTRA_SOURCES,
];

/** The options the verification tests give the converter. */
export function verifyOptions(
  overrides: Partial<ConvertOptions> = {}
): ConvertOptions {
  return { ...DEFAULT_OPTIONS, appLabel: 'blog', ...overrides };
}

/** Reads a source into the IR, before any naming transform. */
export async function parseSource(source: VerifySource): Promise<IrSchema> {
  const adapter = expectOk(getFormat(source.format));
  if (adapter.parse === undefined) {
    throw new Error(`The format "${source.format}" cannot be read.`);
  }
  return expectOk(await adapter.parse(source.sources, verifyOptions()));
}

/** Converts a source into another format. */
export async function convertSource(
  source: VerifySource,
  to: string,
  overrides: Partial<ConvertOptions> = {}
): Promise<ConvertResult> {
  return expectOk(
    await convertText(
      source.sources,
      verifyOptions({ ...overrides, from: source.format, to })
    )
  );
}

function columnOf(model: IrModel, name: string): string {
  const field: IrField | undefined = model.fields.find(
    (candidate: IrField) => candidate.name === name
  );
  if (field !== undefined) {
    return field.columnName;
  }
  const relation: IrRelation | undefined = model.relations.find(
    (candidate: IrRelation) => candidate.name === name
  );
  return relation?.columnName ?? name;
}

/** Builds the spec of a schema: what the real tool has to find after loading the output. */
export function buildSpec(
  schema: IrSchema,
  options: SpecOptions = { snakeCaseNames: false }
): Spec {
  const rename = (name: string): string =>
    options.snakeCaseNames ? toSnakeCase(name) || name : name;
  const tables: Map<string, string> = new Map(
    schema.models.map((model: IrModel): [string, string] => [
      model.name,
      model.tableName,
    ])
  );
  const models: SpecModel[] = schema.models.map((model: IrModel): SpecModel => {
    const columns: SpecColumn[] = model.fields.map(
      (field: IrField): SpecColumn => {
        const enumDefinition = schema.enums.find(
          (candidate) => candidate.name === field.enumName
        );
        return {
          name: rename(field.name),
          column: field.columnName,
          type: field.arrayDepth === undefined ? field.type : 'array',
          nullable: field.isNullable,
          unique: field.isUnique,
          primaryKey: field.isPrimaryKey,
          ...(field.maxLength === undefined
            ? {}
            : { maxLength: field.maxLength }),
          ...(field.maxDigits === undefined
            ? {}
            : { maxDigits: field.maxDigits }),
          ...(field.decimalPlaces === undefined
            ? {}
            : { decimalPlaces: field.decimalPlaces }),
          ...(field.nativeType === undefined ? {} : { nativeType: true }),
          ...(enumDefinition === undefined
            ? {}
            : {
                enumName: enumDefinition.name,
                enumValues: enumDefinition.values.map((value) => value.dbValue),
              }),
        };
      }
    );
    const foreign: IrRelation[] = model.relations.filter(
      (relation: IrRelation) => relation.kind !== 'manyToMany'
    );
    const relations: SpecRelation[] = foreign.map(
      (relation: IrRelation): SpecRelation => ({
        name: rename(relation.name),
        column: relation.columnName,
        kind: relation.kind === 'oneToOne' ? 'oneToOne' : 'foreignKey',
        target: relation.targetModel,
        targetTable: tables.get(relation.targetModel) ?? '',
        nullable: relation.isNullable,
        onDelete: relation.onDelete,
        ...(relation.relatedName === undefined
          ? {}
          : { relatedName: rename(relation.relatedName) }),
        primaryKey: relation.isPrimaryKey === true,
      })
    );
    const primaryKey: string[] = model.compositePrimaryKey?.map(
      (name: string) => columnOf(model, name)
    ) ?? [
      ...columns
        .filter((column: SpecColumn) => column.primaryKey)
        .map((column: SpecColumn) => column.column),
      ...relations
        .filter((relation: SpecRelation) => relation.primaryKey)
        .map((relation: SpecRelation) => relation.column),
    ];
    return {
      name: model.name,
      table: model.tableName,
      columns,
      relations,
      manyToMany: model.relations
        .filter((relation: IrRelation) => relation.kind === 'manyToMany')
        .map((relation: IrRelation): SpecManyToMany => ({
          name: rename(relation.name),
          target: relation.targetModel,
          ...(relation.relatedName === undefined
            ? {}
            : { relatedName: rename(relation.relatedName) }),
        })),
      indexes: model.indexes
        .filter((index: IrIndex) => index.kind === undefined)
        .map((index: IrIndex): SpecIndex => ({
          columns: index.fields.map((name: string) => columnOf(model, name)),
          unique: index.isUnique,
          ...(index.name === undefined ? {} : { name: index.name }),
        })),
      primaryKey,
    };
  });
  return { models };
}

/** Writes a file below a directory, creating the directories on the way. */
export function writeProjectFile(
  directory: string,
  relativePath: string,
  text: string
): void {
  const path: string = join(directory, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

/** The result of probing for a tool: either usable, or the reason it is not. */
export interface ToolProbe {
  available: boolean;
  /** Why the tests are skipped; empty when the tool is available. */
  reason: string;
}

/** Runs a Python interpreter and checks that it can find the given modules (without importing them). */
export function probePython(
  python: string,
  modules: readonly string[],
  envHint: string
): ToolProbe {
  const probe: SpawnSyncReturns<string> = spawnSync(
    python,
    [
      '-I',
      '-c',
      'import importlib.util, sys; ' +
        `sys.exit(any(importlib.util.find_spec(name) is None for name in ${JSON.stringify(modules)}))`,
    ],
    { encoding: 'utf8' }
  );
  if (probe.error !== undefined) {
    return {
      available: false,
      reason: `${python} is not available; set ${envHint} to a Python with ${modules.join(', ')} installed (see test/README.md)`,
    };
  }
  if (probe.status !== 0) {
    return {
      available: false,
      reason: `${python} cannot import ${modules.join(', ')}; set ${envHint} to a Python with them installed (see test/README.md)`,
    };
  }
  return { available: true, reason: '' };
}

/** The Python interpreter that has Django (and graphene-django) installed. */
export function djangoPython(): string {
  return process.env.DJANGO_PYTHON ?? 'python3';
}

/** Returns `title` with the skip reason appended when the tool is unavailable. */
export function titleWithReason(title: string, probe: ToolProbe): string {
  return probe.available ? title : `${title} (skipped: ${probe.reason})`;
}
