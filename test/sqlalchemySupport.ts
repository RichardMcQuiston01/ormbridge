import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import type {
  IrCompositeForeignKey,
  IrDefault,
  IrField,
  IrIndex,
  IrModel,
  IrRelation,
  IrSchema,
} from '../src/ir.js';
import { toSnakeCase } from '../src/naming.js';
import { normalizeSchema, type NamingMode } from '../src/transforms.js';
import { constructsSchema } from './drizzleFixtures.js';
import { kitchenSinkSchema, stressSchema } from './gormFixtures.js';
import type { ToolProbe } from './realToolSupport.js';

/**
 * Shared helpers for the tests that load the SQLAlchemy / SQLModel output with the real libraries:
 * the Python interpreter, the probe, the IR fixtures and the "spec" (what the models must look
 * like, derived from the IR) that `test/tools/validate-sqlalchemy-emitter.py` compares with what
 * SQLAlchemy reports.
 */

/** The Python interpreter that has SQLAlchemy 2 and SQLModel installed. */
export function sqlalchemyPython(): string {
  return process.env.SQLALCHEMY_PYTHON ?? 'python3';
}

/** Checks that the interpreter can import SQLAlchemy 2 or newer and SQLModel. */
export function probeSqlAlchemy(): ToolProbe {
  const python: string = sqlalchemyPython();
  const probe: SpawnSyncReturns<string> = spawnSync(
    python,
    [
      '-I',
      '-c',
      'import sqlalchemy, sqlmodel; raise SystemExit(0 if int(sqlalchemy.__version__.split(".")[0]) >= 2 else 3)',
    ],
    { encoding: 'utf8' }
  );
  if (probe.error !== undefined || probe.status !== 0) {
    return {
      available: false,
      reason: `${python} cannot import SQLAlchemy 2 and SQLModel; set SQLALCHEMY_PYTHON to a Python with them installed (see test/README.md)`,
    };
  }
  return { available: true, reason: '' };
}

/** The IR fixtures of the GORM and Drizzle tests that every emitter verification reuses. */
export const SQLALCHEMY_IR_FIXTURES: readonly (readonly [
  string,
  () => IrSchema,
])[] = [
  ['kitchen-sink', kitchenSinkSchema],
  ['stress', stressSchema],
  ['constructs', constructsSchema],
];

// ---------------------------------------------------------------------------
// The spec
// ---------------------------------------------------------------------------

interface SpecColumn {
  column: string;
  type: string;
  array: boolean;
  nullable: boolean;
  primaryKey: boolean;
  unique: boolean;
  maxLength?: number;
  maxDigits?: number;
  decimalPlaces?: number;
  enumValues?: string[];
  enumDbName?: string;
  enumNames?: Record<string, string>;
  default?: IrDefault;
  autoUpdated: boolean;
}

interface SpecForeignKey {
  columns: string[];
  targetTable: string;
  targetColumns: string[];
  onDelete: string;
  onUpdate?: string;
  kind: 'foreignKey' | 'oneToOne';
}

interface SpecManyToMany {
  table: string;
  ownerColumn: string;
  targetColumn: string;
  targetTable: string;
}

interface SpecIndex {
  columns: string[];
  unique: boolean;
  name?: string;
}

interface SpecModel {
  name: string;
  table: string;
  columns: SpecColumn[];
  foreignKeys: SpecForeignKey[];
  manyToMany: SpecManyToMany[];
  indexes: SpecIndex[];
  primaryKey: string[];
}

export interface SqlAlchemySpec {
  style: 'sqlalchemy' | 'sqlmodel';
  models: SpecModel[];
}

interface Key {
  column: string;
  field: IrField;
}

function findKey(
  schema: IrSchema,
  modelName: string,
  name: string | undefined,
  depth: number = 0
): Key | undefined {
  const model: IrModel | undefined = schema.models.find(
    (candidate: IrModel) => candidate.name === modelName
  );
  if (model === undefined || depth > 8) {
    return undefined;
  }
  let wanted: string | undefined = name;
  if (wanted === undefined) {
    wanted =
      model.fields.find((field: IrField) => field.isPrimaryKey)?.name ??
      model.relations.find((relation: IrRelation) => relation.isPrimaryKey)
        ?.name ??
      (model.compositePrimaryKey?.length === 1
        ? model.compositePrimaryKey[0]
        : undefined);
  }
  const field: IrField | undefined = model.fields.find(
    (candidate: IrField) =>
      candidate.name === wanted || candidate.columnName === wanted
  );
  if (field !== undefined) {
    return { column: field.columnName, field };
  }
  const relation: IrRelation | undefined = model.relations.find(
    (candidate: IrRelation) =>
      candidate.kind !== 'manyToMany' && candidate.name === wanted
  );
  if (relation === undefined) {
    return undefined;
  }
  const inner: Key | undefined = findKey(
    schema,
    relation.targetModel,
    relation.toField,
    depth + 1
  );
  return inner === undefined
    ? undefined
    : { column: relation.columnName, field: inner.field };
}

function columnsOf(model: IrModel, name: string): string[] {
  const field: IrField | undefined = model.fields.find(
    (candidate: IrField) => candidate.name === name
  );
  if (field !== undefined) {
    return [field.columnName];
  }
  const relation: IrRelation | undefined = model.relations.find(
    (candidate: IrRelation) =>
      candidate.kind !== 'manyToMany' && candidate.name === name
  );
  if (relation !== undefined) {
    return [relation.columnName];
  }
  const composite: IrCompositeForeignKey | undefined = (
    model.compositeForeignKeys ?? []
  ).find((candidate: IrCompositeForeignKey) => candidate.name === name);
  return composite === undefined
    ? [name]
    : composite.fields.flatMap((fieldName: string) =>
        columnsOf(model, fieldName)
      );
}

/** The many-to-many relations that are the second side of a pair (they get no table of their own). */
function mirroredSides(schema: IrSchema): Set<string> {
  const mirrored: Set<string> = new Set<string>();
  for (const model of schema.models) {
    for (const relation of model.relations) {
      if (
        relation.kind !== 'manyToMany' ||
        relation.relatedName === undefined ||
        mirrored.has(`${model.name}.${relation.name}`)
      ) {
        continue;
      }
      const other: IrModel | undefined = schema.models.find(
        (candidate: IrModel) => candidate.name === relation.targetModel
      );
      const counterpart: IrRelation | undefined = other?.relations.find(
        (candidate: IrRelation) =>
          candidate.kind === 'manyToMany' &&
          candidate.name === relation.relatedName &&
          candidate.targetModel === model.name
      );
      if (other !== undefined && other !== model && counterpart !== undefined) {
        mirrored.add(`${other.name}.${counterpart.name}`);
      }
    }
  }
  return mirrored;
}

function specColumn(
  schema: IrSchema,
  naming: NamingMode,
  field: IrField
): SpecColumn {
  const enumDefinition = schema.enums.find(
    (candidate) => candidate.name === field.enumName
  );
  const usable =
    enumDefinition !== undefined && enumDefinition.values.length > 0;
  const dbName: string | undefined = usable
    ? (enumDefinition.dbName ?? enumDefinition.name)
    : undefined;
  return {
    column: field.columnName,
    type: field.type,
    array: (field.arrayDepth ?? 0) > 0,
    nullable: field.isNullable && !field.isPrimaryKey,
    primaryKey: field.isPrimaryKey,
    unique: field.isUnique,
    ...(field.maxLength === undefined || field.type !== 'string'
      ? {}
      : { maxLength: field.maxLength }),
    ...(field.maxDigits === undefined ? {} : { maxDigits: field.maxDigits }),
    ...(field.decimalPlaces === undefined
      ? {}
      : { decimalPlaces: field.decimalPlaces }),
    ...(usable
      ? {
          enumValues: enumDefinition.values.map((value) => value.dbValue),
          enumDbName:
            naming === 'normalize' && dbName !== undefined
              ? toSnakeCase(dbName) || dbName
              : dbName,
          enumNames: Object.fromEntries(
            enumDefinition.values.map((value) => [value.name, value.dbValue])
          ),
        }
      : {}),
    ...(field.default === undefined ? {} : { default: field.default }),
    autoUpdated: field.isAutoUpdated,
  };
}

/**
 * Builds the spec of a schema as the emitter sees it: the tables, columns, keys, indexes and
 * association tables the generated models must create, and the relationships they must map.
 */
export function buildSqlAlchemySpec(
  source: IrSchema,
  naming: NamingMode,
  style: 'sqlalchemy' | 'sqlmodel'
): SqlAlchemySpec {
  const schema: IrSchema =
    naming === 'normalize' ? normalizeSchema(source) : source;
  const mapped: IrModel[] = schema.models.filter(
    (model: IrModel) => model.isView !== true
  );
  const tables: Map<string, string> = new Map(
    mapped.map((model: IrModel): [string, string] => [
      model.name,
      model.tableName,
    ])
  );
  const mirrored: Set<string> = mirroredSides(schema);

  const models: SpecModel[] = mapped.map((model: IrModel): SpecModel => {
    const columns: SpecColumn[] = model.fields.map((field: IrField) =>
      specColumn(schema, naming, field)
    );
    const foreignKeys: SpecForeignKey[] = [];
    for (const relation of model.relations) {
      if (relation.kind === 'manyToMany') {
        continue;
      }
      const key: Key | undefined = findKey(
        schema,
        relation.targetModel,
        relation.toField
      );
      const isKey: boolean =
        relation.isPrimaryKey === true ||
        (model.compositePrimaryKey?.includes(relation.name) ?? false);
      if (key !== undefined) {
        columns.push({
          ...specColumn(schema, naming, {
            ...key.field,
            columnName: relation.columnName,
            isPrimaryKey: isKey,
            isUnique: relation.kind === 'oneToOne' && !isKey,
            isNullable: relation.isNullable,
            default: undefined,
            isAutoUpdated: false,
            enumName: undefined,
            arrayDepth: undefined,
          }),
        });
      }
      const targetTable: string | undefined = tables.get(relation.targetModel);
      if (targetTable === undefined) {
        continue;
      }
      // setNull on a column that cannot be null is written as RESTRICT.
      const onDelete: string =
        relation.onDelete === 'setNull' && !relation.isNullable
          ? 'restrict'
          : relation.onDelete;
      foreignKeys.push({
        columns: [relation.columnName],
        targetTable,
        targetColumns: [key?.column ?? 'id'],
        onDelete,
        ...(relation.onUpdate === undefined
          ? {}
          : { onUpdate: relation.onUpdate }),
        kind: relation.kind === 'oneToOne' ? 'oneToOne' : 'foreignKey',
      });
    }
    for (const composite of model.compositeForeignKeys ?? []) {
      const target: IrModel | undefined = mapped.find(
        (candidate: IrModel) => candidate.name === composite.targetModel
      );
      if (target === undefined) {
        continue;
      }
      foreignKeys.push({
        columns: composite.fields.flatMap((name: string) =>
          columnsOf(model, name)
        ),
        targetTable: target.tableName,
        targetColumns: composite.references.flatMap((name: string) =>
          columnsOf(target, name)
        ),
        onDelete: composite.onDelete,
        ...(composite.onUpdate === undefined
          ? {}
          : { onUpdate: composite.onUpdate }),
        kind: composite.kind,
      });
    }

    const manyToMany: SpecManyToMany[] = [];
    for (const relation of model.relations) {
      const targetTable: string | undefined = tables.get(relation.targetModel);
      if (
        relation.kind !== 'manyToMany' ||
        targetTable === undefined ||
        mirrored.has(`${model.name}.${relation.name}`)
      ) {
        continue;
      }
      const self: boolean = relation.targetModel === model.name;
      const ownerSnake: string = toSnakeCase(model.name);
      const targetSnake: string = toSnakeCase(relation.targetModel);
      manyToMany.push({
        table: `${model.tableName}_${relation.name}`,
        ownerColumn: self ? `from_${ownerSnake}_id` : `${ownerSnake}_id`,
        targetColumn: self ? `to_${targetSnake}_id` : `${targetSnake}_id`,
        targetTable,
      });
    }

    const primaryKey: string[] = model.compositePrimaryKey?.flatMap(
      (name: string) => columnsOf(model, name)
    ) ?? [
      ...model.fields
        .filter((field: IrField) => field.isPrimaryKey)
        .map((field: IrField) => field.columnName),
      ...model.relations
        .filter((relation: IrRelation) => relation.isPrimaryKey === true)
        .map((relation: IrRelation) => relation.columnName),
    ];
    for (const column of columns) {
      column.primaryKey = primaryKey.includes(column.column);
    }
    return {
      name: model.name,
      table: model.tableName,
      columns,
      foreignKeys,
      manyToMany,
      indexes: model.indexes.map((index: IrIndex): SpecIndex => ({
        columns: index.fields.flatMap((name: string) => columnsOf(model, name)),
        unique: index.isUnique,
        ...(index.name === undefined ? {} : { name: index.name }),
      })),
      primaryKey,
    };
  });
  return { style, models };
}
