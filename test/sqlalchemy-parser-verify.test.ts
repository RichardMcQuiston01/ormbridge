import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import type {
  IrCompositeForeignKey,
  IrDefault,
  IrEnum,
  IrField,
  IrIndex,
  IrModel,
  IrRelation,
  IrSchema,
} from '../src/ir.js';
import {
  parseSqlAlchemy,
  type SqlAlchemySourceFile,
} from '../src/parsers/sqlalchemy.js';
import { expectOk } from './helpers.js';
import {
  titleWithReason,
  writeProjectFile,
  type ToolProbe,
} from './realToolSupport.js';

/**
 * Loads the SQLAlchemy and SQLModel fixtures with the real libraries: the models are imported, the
 * mappers configured, every table is created in an in-memory SQLite database and read back with
 * SQLAlchemy's inspector, and one row is inserted into each table to see the defaults work. What the
 * database and the mappers report is compared with what the parser read from the source
 * (`test/tools/validate-sqlalchemy.py`).
 *
 * Set SQLALCHEMY_PYTHON to a Python with SQLAlchemy 2 (and sqlmodel for the SQLModel fixture)
 * installed (see test/README.md and test/tools/setup-verification-tools.sh). The tests are skipped
 * with a reason in the title when it is not available.
 */

const SCRIPT: string = fileURLToPath(
  new URL('./tools/validate-sqlalchemy.py', import.meta.url)
);
const FIXTURES: string = fileURLToPath(new URL('./fixtures/', import.meta.url));

/** Timeout of one run: importing the libraries and creating the tables takes a few seconds. */
const VERIFY_TIMEOUT_MS: number = 120_000;

function sqlalchemyPython(): string {
  return process.env.SQLALCHEMY_PYTHON ?? 'python3';
}

function probeSqlAlchemy(modules: readonly string[]): ToolProbe {
  const python: string = sqlalchemyPython();
  const run: SpawnSyncReturns<string> = spawnSync(
    python,
    [
      '-I',
      '-c',
      'import importlib.util, sys; ' +
        `names = ${JSON.stringify(modules)}; ` +
        'sys.exit(2 if any(importlib.util.find_spec(n) is None for n in names) else ' +
        '(3 if int(__import__("sqlalchemy").__version__.split(".")[0]) < 2 else 0))',
    ],
    { encoding: 'utf8' }
  );
  if (run.error !== undefined) {
    return {
      available: false,
      reason: `${python} is not available; set SQLALCHEMY_PYTHON to a Python with ${modules.join(', ')} installed (see test/README.md)`,
    };
  }
  if (run.status === 3) {
    return {
      available: false,
      reason: `${python} has SQLAlchemy 1.x; set SQLALCHEMY_PYTHON to a Python with SQLAlchemy 2 (see test/README.md)`,
    };
  }
  if (run.status !== 0) {
    return {
      available: false,
      reason: `${python} cannot import ${modules.join(', ')}; set SQLALCHEMY_PYTHON to a Python with them installed (see test/README.md)`,
    };
  }
  return { available: true, reason: '' };
}

interface SpecColumn {
  name: string;
  column: string;
  type: string;
  nullable: boolean;
  unique: boolean;
  primaryKey: boolean;
  maxLength?: number;
  maxDigits?: number;
  decimalPlaces?: number;
  enumValues?: string[];
  arrayDepth?: number;
  default?: { kind: string; value?: unknown; dbValue?: string };
  isDbDefault?: boolean;
  isAutoUpdated?: boolean;
  generated?: boolean;
}

interface SpecTable {
  name: string;
  table: string;
  columns: SpecColumn[];
  relations: {
    name: string;
    column: string;
    kind: string;
    target: string;
    targetTable: string;
    nullable: boolean;
    onDelete: string;
    onUpdate?: string;
    relatedName?: string;
    primaryKey: boolean;
    targetColumn?: string;
  }[];
  manyToMany: { name: string; target: string; relatedName?: string }[];
  indexes: { columns: string[]; unique: boolean; name?: string }[];
  compositeForeignKeys: {
    name: string;
    columns: string[];
    targetTable: string;
    targetColumns: string[];
  }[];
  primaryKey: string[];
}

/** Renders the parser's result as the JSON the script compares the real library with. */
function buildSpec(
  schema: IrSchema,
  base: string,
  modules: string[]
): { base: string; modules: string[]; tables: SpecTable[] } {
  const byName: Map<string, IrModel> = new Map(
    schema.models.map((model: IrModel): [string, IrModel] => [
      model.name,
      model,
    ])
  );
  const columnOf = (model: IrModel, name: string): string =>
    model.fields.find((field: IrField) => field.name === name)?.columnName ??
    model.relations.find((relation: IrRelation) => relation.name === name)
      ?.columnName ??
    name;
  const tables: SpecTable[] = schema.models.map((model: IrModel): SpecTable => {
    const columns: SpecColumn[] = model.fields.map(
      (field: IrField): SpecColumn => {
        const enumDefinition: IrEnum | undefined = schema.enums.find(
          (candidate: IrEnum) => candidate.name === field.enumName
        );
        const fieldDefault: IrDefault | undefined = field.default;
        return {
          name: field.name,
          column: field.columnName,
          type: field.type,
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
          ...(enumDefinition === undefined
            ? {}
            : {
                enumValues: enumDefinition.values.map((value) => value.dbValue),
              }),
          ...(field.arrayDepth === undefined
            ? {}
            : { arrayDepth: field.arrayDepth }),
          ...(fieldDefault === undefined
            ? {}
            : {
                default: {
                  kind: fieldDefault.kind,
                  ...(fieldDefault.kind === 'literal'
                    ? { value: fieldDefault.value }
                    : {}),
                  ...(fieldDefault.kind === 'enumValue'
                    ? {
                        dbValue: enumDefinition?.values.find(
                          (value) => value.name === fieldDefault.value
                        )?.dbValue,
                      }
                    : {}),
                },
              }),
          ...(field.isDbDefault === true ? { isDbDefault: true } : {}),
          ...(field.isAutoUpdated ? { isAutoUpdated: true } : {}),
          ...(field.generated === undefined ? {} : { generated: true }),
        };
      }
    );
    const foreign: IrRelation[] = model.relations.filter(
      (relation: IrRelation) => relation.kind !== 'manyToMany'
    );
    const primaryKey: string[] = model.compositePrimaryKey?.map(
      (name: string) => columnOf(model, name)
    ) ?? [
      ...model.fields
        .filter((field: IrField) => field.isPrimaryKey)
        .map((field: IrField) => field.columnName),
      ...foreign
        .filter((relation: IrRelation) => relation.isPrimaryKey === true)
        .map((relation: IrRelation) => relation.columnName),
    ];
    return {
      name: model.name,
      table: model.tableName,
      columns,
      relations: foreign.map((relation: IrRelation) => {
        const target: IrModel | undefined = byName.get(relation.targetModel);
        return {
          name: relation.name,
          column: relation.columnName,
          kind: relation.kind,
          target: relation.targetModel,
          targetTable: target?.tableName ?? '',
          nullable: relation.isNullable,
          onDelete: relation.onDelete,
          ...(relation.onUpdate === undefined
            ? {}
            : { onUpdate: relation.onUpdate }),
          ...(relation.relatedName === undefined
            ? {}
            : { relatedName: relation.relatedName }),
          primaryKey: relation.isPrimaryKey === true,
          ...(relation.toField === undefined || target === undefined
            ? {}
            : { targetColumn: columnOf(target, relation.toField) }),
        };
      }),
      manyToMany: model.relations
        .filter((relation: IrRelation) => relation.kind === 'manyToMany')
        .map((relation: IrRelation) => ({
          name: relation.name,
          target: relation.targetModel,
          ...(relation.relatedName === undefined
            ? {}
            : { relatedName: relation.relatedName }),
        })),
      indexes: model.indexes
        .filter((index: IrIndex) => index.kind === undefined)
        .map((index: IrIndex) => ({
          columns: index.fields.map((name: string) => columnOf(model, name)),
          unique: index.isUnique,
          ...(index.name === undefined ? {} : { name: index.name }),
        })),
      compositeForeignKeys: (model.compositeForeignKeys ?? []).map(
        (key: IrCompositeForeignKey) => {
          const target: IrModel | undefined = byName.get(key.targetModel);
          return {
            name: key.name,
            columns: key.fields.map((name: string) => columnOf(model, name)),
            targetTable: target?.tableName ?? '',
            targetColumns: key.references.map((name: string) =>
              target === undefined ? name : columnOf(target, name)
            ),
          };
        }
      ),
      primaryKey,
    };
  });
  return { base, modules, tables };
}

interface VerifyGroup {
  label: string;
  /** Files copied into the scratch project: [fixture path below test/fixtures, path in the project]. */
  files: [string, string][];
  base: string;
  modules: string[];
  /** Extra Python packages the fixture needs. */
  requires: string[];
  /** Minimum number of tables, relationships and many-to-many relations the run must have checked. */
  minimum: { relationships: number; manyToMany: number; rows: number };
}

function packageFiles(directory: string, target: string): [string, string][] {
  return readdirSync(join(FIXTURES, directory))
    .filter((name: string) => name.endsWith('.py'))
    .sort()
    .map((name: string): [string, string] => [
      `${directory}/${name}`,
      `${target}/${name}`,
    ]);
}

const GROUPS: readonly VerifyGroup[] = [
  {
    label: 'canonical blog schema (SQLAlchemy 2.0 package)',
    files: packageFiles('sqlalchemy/blog', 'blog'),
    base: 'blog:Base',
    modules: ['blog'],
    requires: [],
    minimum: { relationships: 5, manyToMany: 1, rows: 5 },
  },
  {
    label: 'canonical blog schema (classic Column() style)',
    files: [['sqlalchemy-classic/models.py', 'models.py']],
    base: 'models:Base',
    modules: ['models'],
    requires: [],
    minimum: { relationships: 5, manyToMany: 1, rows: 5 },
  },
  {
    label: 'canonical blog schema (SQLModel)',
    files: [['sqlalchemy-sqlmodel/models.py', 'models.py']],
    base: 'models:SQLModel',
    modules: ['models'],
    requires: ['sqlmodel'],
    minimum: { relationships: 5, manyToMany: 1, rows: 5 },
  },
  {
    label: 'extras (shop)',
    files: [['sqlalchemy-extras/shop.py', 'shop.py']],
    base: 'shop:Base',
    modules: ['shop'],
    requires: [],
    minimum: { relationships: 7, manyToMany: 1, rows: 8 },
  },
];

const directories: string[] = [];

afterAll(() => {
  for (const directory of directories) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function readGroupSources(group: VerifyGroup): SqlAlchemySourceFile[] {
  return group.files.map(([fixture]: [string, string]) => ({
    path: join(FIXTURES, fixture),
    text: readFileSync(join(FIXTURES, fixture), 'utf8'),
  }));
}

function validate(
  group: VerifyGroup,
  schema: IrSchema
): SpawnSyncReturns<string> {
  const directory: string = mkdtempSync(
    join(tmpdir(), 'ormbridge-sqlalchemy-')
  );
  directories.push(directory);
  for (const [fixture, target] of group.files) {
    mkdirSync(join(directory, target, '..'), { recursive: true });
    copyFileSync(join(FIXTURES, fixture), join(directory, target));
  }
  writeProjectFile(
    directory,
    'spec.json',
    JSON.stringify(buildSpec(schema, group.base, group.modules))
  );
  return spawnSync(
    sqlalchemyPython(),
    ['-I', SCRIPT, directory, join(directory, 'spec.json')],
    { encoding: 'utf8', timeout: VERIFY_TIMEOUT_MS }
  );
}

const baseProbe: ToolProbe = probeSqlAlchemy(['sqlalchemy']);
const modelProbe: ToolProbe = probeSqlAlchemy(['sqlalchemy', 'sqlmodel']);

describe(
  titleWithReason('sqlalchemy parser: real SQLAlchemy', baseProbe),
  () => {
    for (const group of GROUPS) {
      const probe: ToolProbe =
        group.requires.length > 0 ? modelProbe : baseProbe;
      it.skipIf(!probe.available)(
        `matches what SQLAlchemy builds from the ${group.label}${probe.available ? '' : ` (skipped: ${probe.reason})`}`,
        async () => {
          const schema: IrSchema = expectOk(
            await parseSqlAlchemy(readGroupSources(group), { appLabel: 'blog' })
          );
          const run: SpawnSyncReturns<string> = validate(group, schema);
          expect(run.stderr, `${group.label}: ${run.stdout}`).toBe('');
          expect(run.status).toBe(0);
          expect(run.stdout).toContain('sqlalchemy models verified');
          const counts: RegExpExecArray | null =
            /(\d+) tables, (\d+) relationships, (\d+) many-to-many, (\d+) rows/.exec(
              run.stdout
            );
          expect(counts, run.stdout).not.toBeNull();
          expect(Number(counts?.[2])).toBeGreaterThanOrEqual(
            group.minimum.relationships
          );
          expect(Number(counts?.[3])).toBeGreaterThanOrEqual(
            group.minimum.manyToMany
          );
          expect(Number(counts?.[4])).toBeGreaterThanOrEqual(
            group.minimum.rows
          );
        },
        VERIFY_TIMEOUT_MS + 30_000
      );
    }
  }
);
