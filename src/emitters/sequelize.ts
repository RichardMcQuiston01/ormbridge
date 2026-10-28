import type { MultiFileEmitOutput } from '../formats.js';
import type {
  IrDefault,
  IrEnum,
  IrEnumValue,
  IrField,
  IrIndex,
  IrIndexFieldOptions,
  IrModel,
  IrOnDelete,
  IrRelation,
  IrSchema,
} from '../ir.js';
import { findModel } from '../ir.js';
import { toCamelCase, toPascalCase, toSnakeCase } from '../naming.js';
import { underscore } from '../parsers/sequelizeInflection.js';
import { prismaOnlyWarnings } from '../prismaOnlyConstructs.js';
import { normalizeSchema, type NamingMode } from '../transforms.js';
import {
  COCKROACH_PREFIX,
  cockroachInvertible,
  cockroachSequentialWarning,
  isCockroach,
} from './cockroach.js';
import type { PrismaProvider } from './prisma.js';
import {
  writeV7Index,
  writeV7ModelFile,
  type V7Association,
  type V7Attribute,
  type V7Dialect,
  type V7Model,
} from './sequelize7.js';
import {
  compact,
  IDENTIFIER_PATTERN,
  INDENT,
  MAX_LINE_WIDTH,
  objectLines,
  quote,
} from './sequelizeText.js';

/**
 * Writes Sequelize models, one file per model plus an `index` file. Sequelize 6 has two styles:
 *
 * - `init` (the default) is TypeScript: `class User extends Model<InferAttributes<User>, ...>` with `declare`
 *   fields and a static `initModel(sequelize)` that calls `User.init({ ... }, { sequelize, modelName, tableName })`.
 *   `index.ts` exports the models and an `initModels(sequelize)` function that runs every `initModel` and then
 *   the associations (`belongsTo`, `hasMany`, `hasOne`, `belongsToMany`).
 * - `define` is the CommonJS layout `sequelize-cli` generates: `module.exports = (sequelize, DataTypes) => ...`
 *   with `sequelize.define(...)` and an `associate(models)` function, and an `index.js` that wires them together.
 *
 * Every table, column and association is written explicitly (`tableName`, `field`, `as`, `foreignKey`,
 * `onDelete`), so the models create the schema of the IR and the Sequelize reader reads the output back.
 *
 * Sequelize 7 (`@sequelize/core`) has one: `v7` writes TypeScript classes with decorators (`@Table`, `@Attribute`,
 * `@PrimaryKey`, `@BelongsTo`, ...) and an `index` file that lists the models for `new Sequelize({ dialect, models })`
 * (see `sequelize7.ts`). `v6` is the explicit name of the default generation, the same as `init`.
 */

/** The Sequelize 6 layouts. */
export type SequelizeStyle = 'init' | 'define';

export const SEQUELIZE_STYLES: readonly SequelizeStyle[] = ['init', 'define'];

/** The Sequelize generations `--style` can name: `v6` is the default output (the `init` layout), `v7` the decorators. */
export type SequelizeGeneration = 'v6' | 'v7';

export const SEQUELIZE_GENERATIONS: readonly SequelizeGeneration[] = [
  'v6',
  'v7',
];

/** Every value `--style` takes when the target is Sequelize. */
export type SequelizeOutputStyle = SequelizeStyle | SequelizeGeneration;

export const SEQUELIZE_OUTPUT_STYLES: readonly SequelizeOutputStyle[] = [
  ...SEQUELIZE_STYLES,
  ...SEQUELIZE_GENERATIONS,
];

/** The layouts the writer produces; `v6` is `init`. */
type Layout = SequelizeStyle | 'v7';

/** True when a value is one of the Sequelize `--style` values. */
export function isSequelizeStyle(value: string): value is SequelizeStyle {
  return (SEQUELIZE_STYLES as readonly string[]).includes(value);
}

/** True when a value is a Sequelize 6 layout or a generation (`v6`, `v7`). */
export function isSequelizeOutputStyle(
  value: string
): value is SequelizeOutputStyle {
  return (SEQUELIZE_OUTPUT_STYLES as readonly string[]).includes(value);
}

export interface SequelizeEmitOptions {
  /** Database provider; picks the data types (JSONB vs JSON, ARRAY, INET, ...). */
  provider: PrismaProvider;
  /**
   * "preserve" keeps the database names of the source: the attribute names stay as written and every
   * `tableName` and `field` is explicit. "normalize" applies the fresh-schema style of the other emitters
   * (singular snake_case tables, UUID keys, `created_at` / `updated_at`) with camelCase attributes over
   * snake_case columns (`underscored: true`).
   */
  naming: NamingMode;
  /** Output layout or generation; defaults to `init` (Sequelize 6, the same as `v6`). */
  style?: SequelizeOutputStyle;
}

type Dialect = 'postgres' | 'mysql' | 'sqlite' | 'mssql';

/** The Sequelize type of a column and the TypeScript type of its property. */
interface TypeSpec {
  expression: string;
  ts: string;
}

/** One attribute of a model: the entries after `type` and how the class declares the property. */
interface AttributeSpec {
  name: string;
  type: string;
  /** `allowNull`, `unique`, `defaultValue`, `field`, ... (everything but `type`). */
  entries: string[];
  ts: string;
  /** True when `CreationOptional` makes the property optional in `create()`. */
  optional: boolean;
  isReadonly: boolean;
  /**
   * True for a column Sequelize adds itself (createdAt / updatedAt). The `define` style leaves it out of the
   * attributes; the `init` style lists it, because the TypeScript types want every declared property there.
   */
  implicit: boolean;
  /** Set on an implicit createdAt / updatedAt column, which the Sequelize 7 style writes as `@CreatedAt` / `@UpdatedAt`. */
  timestamp?: 'created' | 'updated';
}

/** One association call, written in `initModels` (init) or in `associate` (define). */
interface AssociationSpec {
  /** The model the call is made on. */
  owner: string;
  method: 'belongsTo' | 'hasOne' | 'hasMany' | 'belongsToMany';
  target: string;
  alias: string;
  options: string[];
  /** The relation this call belongs to ("Model.relation"); the two sides of one relation share it. */
  relation: string;
}

/** Every association call, by the model it is made on and in the order the relations were written. */
interface AssociationLog {
  byOwner: Map<string, AssociationSpec[]>;
  ordered: AssociationSpec[];
  /** The Sequelize 7 style: the association properties of each class, decorated or only typed. */
  v7: Map<string, V7Association[]>;
}

interface TimestampPlan {
  /** Field names that map to Sequelize's createdAt and updatedAt. */
  created?: IrField;
  updated?: IrField;
}

interface ModelPlan {
  model: IrModel;
  className: string;
  fileBase: string;
  underscored: boolean;
  /** IR field name -> attribute name. */
  attrs: Map<string, string>;
  /** Relation name -> attribute name of its foreign key column. */
  keys: Map<string, string>;
  /** Relation name -> association alias. */
  aliases: Map<string, string>;
  /** Attribute and alias names in use (they share one namespace on an instance). */
  used: Set<string>;
  timestamps: TimestampPlan;
  /** Fields whose database type needs a length-limited string (keys and indexed columns). */
  keyLike: Set<string>;
}

interface EmitContext {
  schema: IrSchema;
  options: SequelizeEmitOptions;
  style: Layout;
  dialect: Dialect;
  /** True for `--provider cockroachdb`: the `postgres` dialect through sequelize-cockroachdb. */
  cockroach: boolean;
  /** CockroachDB: auto-increment keys, reported in one warning. */
  sequentialKeys: string[];
  warnings: string[];
  plans: Map<string, ModelPlan>;
  /** "Model.relation" -> alias of the other side on the target model. */
  inverseAliases: Map<string, string>;
  /** True when some default needs `Sequelize.literal`. */
  usesLiteral: boolean;
}

const CREATED_FIELD_PATTERN: RegExp =
  /^(created_?at|created|date_?created|createdon)$/i;

/** Names a generated model file declares or imports, which a class cannot take. */
const RESERVED_CLASS_NAMES: ReadonlySet<string> = new Set([
  'Model',
  'Sequelize',
  'DataTypes',
  'CreationOptional',
  'InferAttributes',
  'InferCreationAttributes',
  'NonAttribute',
  'Buffer',
  'Date',
  'Object',
  'Array',
  'Record',
  'String',
  'Number',
  'Boolean',
  'Models',
]);

/** Names the Sequelize 7 model files import as well, which a class cannot take there. */
const V7_RESERVED_CLASS_NAMES: ReadonlySet<string> = new Set([
  'Attribute',
  'AutoIncrement',
  'BelongsTo',
  'BelongsToMany',
  'ColumnName',
  'CreatedAt',
  'Default',
  'HasMany',
  'HasOne',
  'NotNull',
  'PrimaryKey',
  'Table',
  'Unique',
  'UpdatedAt',
  'sql',
]);

/** Words an attribute cannot be called on a Sequelize instance without shadowing a member of `Model`. */
const RESERVED_ATTRIBUTES: ReadonlySet<string> = new Set([
  'constructor',
  'prototype',
  'sequelize',
  'dataValues',
  'isNewRecord',
]);

const ON_ACTIONS: Readonly<Record<IrOnDelete, string>> = {
  cascade: 'CASCADE',
  setNull: 'SET NULL',
  restrict: 'RESTRICT',
  noAction: 'NO ACTION',
  setDefault: 'SET DEFAULT',
};

/** The index method the IR spells like Prisma, as Sequelize's `using` writes it. */
const INDEX_METHODS: Readonly<Record<string, string>> = {
  btree: 'BTREE',
  hash: 'HASH',
  gin: 'GIN',
  gist: 'GIST',
  spgist: 'SPGIST',
  brin: 'BRIN',
};

/** Types Sequelize can name for a column the IR calls `unsupported`, by the database type it read. */
const POSTGRES_ONLY_TYPES: Readonly<Record<string, string>> = {
  geometry: 'GEOMETRY',
  geography: 'GEOGRAPHY',
  cidr: 'CIDR',
  macaddr: 'MACADDR',
  tsvector: 'TSVECTOR',
  citext: 'CITEXT',
};

/** Of the types above, the ones CockroachDB rejects (`geometry`, `geography`, `tsvector` and `citext` exist). */
const COCKROACH_MISSING: ReadonlySet<string> = new Set<string>([
  'cidr',
  'macaddr',
]);

const RANGE_SUBTYPES: Readonly<Record<string, string>> = {
  int: 'INTEGER',
  bigInt: 'BIGINT',
  decimal: 'DECIMAL',
  date: 'DATEONLY',
  dateTime: 'DATE',
};

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function emitSequelize(
  schema: IrSchema,
  options: SequelizeEmitOptions
): MultiFileEmitOutput {
  const prepared: IrSchema =
    options.naming === 'normalize' ? normalizeSchema(schema) : schema;
  const style: Layout =
    options.style === undefined || options.style === 'v6'
      ? 'init'
      : options.style;
  const context: EmitContext = {
    schema: prepared,
    options,
    style,
    dialect: dialectOf(options.provider),
    cockroach: isCockroach(options.provider),
    sequentialKeys: [],
    warnings: prismaOnlyWarnings(prepared, true).filter(isUnhandledWarning),
    plans: new Map<string, ModelPlan>(),
    inverseAliases: new Map<string, string>(),
    usesLiteral: false,
  };
  if (options.provider === 'mongodb') {
    context.warnings.push(
      'Provider "mongodb": Sequelize is relational (it has no MongoDB dialect; use Mongoose); PostgreSQL column types were written.'
    );
  }

  if (context.cockroach && style === 'v7') {
    context.warnings.push(
      `${COCKROACH_PREFIX} Sequelize 7 has no CockroachDB dialect or patch package, so the models use the PostgreSQL dialect (@sequelize/postgres) and may meet differences it does not handle; hstore, range types and multi-dimensional arrays (which CockroachDB lacks) are written as JSONB or TEXT.`
    );
  } else if (context.cockroach) {
    context.warnings.push(
      `${COCKROACH_PREFIX} the models use the "postgres" dialect through the sequelize-cockroachdb package (Sequelize 6): DataTypes.INTEGER creates a 64-bit INT8 column there, and hstore, range types and multi-dimensional arrays (which CockroachDB lacks) are written as JSONB or TEXT.`
    );
  }

  const files: Record<string, string> = {};
  if (prepared.models.length === 0) {
    return { files, warnings: context.warnings };
  }

  planModels(context);
  planInverseAliases(context);

  const associations: AssociationLog = {
    byOwner: new Map<string, AssociationSpec[]>(),
    ordered: [],
    v7: new Map<string, V7Association[]>(),
  };
  const extension: string = style === 'define' ? 'js' : 'ts';
  const rendered: Map<string, RenderedModel> = new Map<string, RenderedModel>();
  for (const model of prepared.models) {
    context.usesLiteral = false;
    rendered.set(
      model.name,
      renderModel(context, planOf(context, model), associations)
    );
  }
  for (const model of prepared.models) {
    const plan: ModelPlan = planOf(context, model);
    const result: RenderedModel | undefined = rendered.get(model.name);
    if (result === undefined) {
      continue;
    }
    files[`${plan.fileBase}.${extension}`] =
      style === 'init'
        ? writeInitFile(context, plan, result, associations)
        : style === 'v7'
          ? writeV7ModelFile(
              v7ModelOf(plan, result, associations),
              (className: string) => fileOf(context, className)
            )
          : writeDefineFile(plan, result, associations);
  }
  files[`index.${extension}`] =
    style === 'init'
      ? writeInitIndex(context, associations)
      : style === 'v7'
        ? writeV7Index(
            context.schema.models.map((model: IrModel) => {
              const plan: ModelPlan = planOf(context, model);
              return { className: plan.className, fileBase: plan.fileBase };
            }),
            v7DialectOf(context),
            v7Notes(context)
          )
        : writeDefineIndex(context);
  if (context.sequentialKeys.length > 0) {
    context.warnings.push(
      cockroachSequentialWarning(
        context.sequentialKeys,
        'autoIncrement creates a SERIAL column, which CockroachDB fills with unique_rowid() (64-bit values above 2^53 that a JavaScript number cannot hold exactly; sequelize-cockroachdb returns them as strings, so those keys and the foreign keys that point at them are typed string)'
      )
    );
  }
  return { files, warnings: context.warnings };
}

/** Drops the Prisma-only notes for things this emitter writes (schemas, defaults, actions, index details). */
function isUnhandledWarning(warning: string): boolean {
  if (warning.includes('the onUpdate action')) {
    return false;
  }
  if (warning.includes('the database default expression')) {
    return false;
  }
  if (warning.includes('(Prisma Unsupported)')) {
    return false;
  }
  if (warning.includes('is generated by Prisma Client and was dropped')) {
    return false;
  }
  if (warning.includes('full-text indexes are not supported here')) {
    return false;
  }
  if (warning.includes('the index type, clustering')) {
    return false;
  }
  return !(
    warning.includes('(@@schema) was ignored') && !warning.startsWith('enum ')
  );
}

function dialectOf(provider: PrismaProvider): Dialect {
  switch (provider) {
    case 'mysql':
      return 'mysql';
    case 'sqlite':
      return 'sqlite';
    case 'sqlserver':
      return 'mssql';
    default:
      return 'postgres';
  }
}

// ---------------------------------------------------------------------------
// Small helpers
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

function identifier(context: EmitContext, owner: string, raw: string): string {
  if (IDENTIFIER_PATTERN.test(raw)) {
    return raw;
  }
  const replaced: string = raw.replace(/[^A-Za-z0-9_$]/g, '_');
  const safe: string = /^[0-9]/.test(replaced) ? `_${replaced}` : replaced;
  const result: string = safe === '' ? '_' : safe;
  context.warnings.push(
    `${owner}: "${raw}" is not a valid JavaScript identifier; it was written as "${result}".`
  );
  return result;
}

function isIntegerKey(field: IrField): boolean {
  return field.type === 'int' || field.type === 'bigInt';
}

function planOf(context: EmitContext, model: IrModel): ModelPlan {
  const plan: ModelPlan | undefined = context.plans.get(model.name);
  if (plan === undefined) {
    throw new Error(`No plan exists for the model "${model.name}".`);
  }
  return plan;
}

function enumOf(context: EmitContext, field: IrField): IrEnum | undefined {
  return field.enumName === undefined
    ? undefined
    : context.schema.enums.find(
        (candidate: IrEnum) => candidate.name === field.enumName
      );
}

function enumMember(enumeration: IrEnum, raw: string): IrEnumValue | undefined {
  return (
    enumeration.values.find((value: IrEnumValue) => value.name === raw) ??
    enumeration.values.find((value: IrEnumValue) => value.dbValue === raw)
  );
}

// ---------------------------------------------------------------------------
// Planning: names, timestamps, key-like columns
// ---------------------------------------------------------------------------

function keyLikeFields(context: EmitContext, model: IrModel): Set<string> {
  const keyed: Set<string> = new Set<string>();
  for (const field of model.fields) {
    if (field.isPrimaryKey || field.isUnique) {
      keyed.add(field.name);
    }
  }
  for (const name of model.compositePrimaryKey ?? []) {
    keyed.add(name);
  }
  for (const index of model.indexes) {
    for (const name of index.fields) {
      keyed.add(name);
    }
  }
  for (const other of context.schema.models) {
    for (const relation of other.relations) {
      if (relation.targetModel === model.name && relation.toField) {
        keyed.add(relation.toField);
      }
    }
  }
  return keyed;
}

function attributeName(
  context: EmitContext,
  model: IrModel,
  rawName: string
): string {
  const styled: string =
    context.options.naming === 'normalize' ? toCamelCase(rawName) : rawName;
  const safe: string = identifier(
    context,
    `${model.name}.${rawName}`,
    styled === '' ? rawName : styled
  );
  return RESERVED_ATTRIBUTES.has(safe) ? `${safe}_` : safe;
}

/** `underscored` is the setting under which the most attribute names already map onto their column names. */
function chooseUnderscored(
  context: EmitContext,
  model: IrModel,
  attrs: Map<string, string>
): boolean {
  if (context.options.naming === 'normalize') {
    return true;
  }
  let underscored: number = 0;
  let plain: number = 0;
  for (const field of model.fields) {
    const attr: string = attrs.get(field.name) ?? field.name;
    const snake: boolean = underscore(attr) === field.columnName;
    const same: boolean = attr === field.columnName;
    if (snake && !same) {
      underscored += 1;
    } else if (same && !snake) {
      plain += 1;
    }
  }
  return underscored > plain;
}

function planModels(context: EmitContext): void {
  const fileBases: Set<string> = new Set<string>(['index']);
  const reserved: ReadonlySet<string> =
    context.style === 'v7'
      ? new Set<string>([...RESERVED_CLASS_NAMES, ...V7_RESERVED_CLASS_NAMES])
      : RESERVED_CLASS_NAMES;
  const classNames: Set<string> = new Set<string>(reserved);
  for (const model of context.schema.models) {
    // Sequelize model names are PascalCase; `legacy_order` is written as `LegacyOrder`.
    const pascal: string = /^[A-Z][A-Za-z0-9]*$/.test(model.name)
      ? model.name
      : toPascalCase(model.name);
    const rawClass: string = identifier(
      context,
      model.name,
      pascal === '' ? model.name : pascal
    );
    const className: string = uniqueName(
      reserved.has(rawClass) ? `${rawClass}Model` : rawClass,
      classNames
    );
    if (reserved.has(rawClass)) {
      context.warnings.push(
        `${model.name}: "${rawClass}" is a name the generated files use, so the class and the model were named "${className}".`
      );
    }
    const base: string = toCamelCase(className) || 'model';
    const used: Set<string> = new Set<string>();
    const attrs: Map<string, string> = new Map<string, string>();
    for (const field of model.fields) {
      attrs.set(
        field.name,
        uniqueName(attributeName(context, model, field.name), used)
      );
    }
    const keys: Map<string, string> = new Map<string, string>();
    const aliases: Map<string, string> = new Map<string, string>();
    for (const relation of model.relations) {
      if (relation.kind === 'manyToMany') {
        continue;
      }
      keys.set(
        relation.name,
        uniqueName(attributeName(context, model, relation.columnName), used)
      );
    }
    for (const relation of model.relations) {
      aliases.set(
        relation.name,
        uniqueName(attributeName(context, model, relation.name), used)
      );
    }
    const plan: ModelPlan = {
      model,
      className,
      fileBase: uniqueName(base, fileBases),
      underscored: chooseUnderscored(context, model, attrs),
      attrs,
      keys,
      aliases,
      used,
      timestamps: {},
      keyLike: keyLikeFields(context, model),
    };
    plan.timestamps = planTimestamps(plan);
    context.plans.set(model.name, plan);
  }
}

/** The column Sequelize derives for an attribute. */
function derivedColumn(plan: ModelPlan, attribute: string): string {
  return plan.underscored ? underscore(attribute) : attribute;
}

/** Finds the fields that Sequelize's `createdAt` and `updatedAt` options can stand for. */
function planTimestamps(plan: ModelPlan): TimestampPlan {
  const model: IrModel = plan.model;
  const composite: Set<string> = new Set(model.compositePrimaryKey ?? []);
  const eligible = (field: IrField): boolean =>
    field.type === 'dateTime' &&
    !field.isPrimaryKey &&
    !composite.has(field.name) &&
    field.arrayDepth === undefined &&
    field.generated === undefined;
  const created: IrField | undefined = model.fields.find(
    (field: IrField) =>
      eligible(field) &&
      !field.isAutoUpdated &&
      CREATED_FIELD_PATTERN.test(field.name)
  );
  const updated: IrField | undefined = model.fields.find(
    (field: IrField) => eligible(field) && field.isAutoUpdated
  );
  return {
    ...(created === undefined ? {} : { created }),
    ...(updated === undefined ? {} : { updated }),
  };
}

/**
 * True when Sequelize can add the column itself: the attribute is not written because `timestamps`
 * creates exactly that column. A nullable column, one with another default or a unique flag, or one whose
 * name `underscored` does not derive is declared next to the option instead.
 */
function isImplicitTimestamp(
  plan: ModelPlan,
  field: IrField,
  kind: 'created' | 'updated'
): boolean {
  const attr: string = plan.attrs.get(field.name) ?? field.name;
  const defaultOk: boolean =
    field.default === undefined ||
    (kind === 'created' && field.default.kind === 'now');
  return (
    defaultOk &&
    !field.isNullable &&
    !field.isUnique &&
    field.enumName === undefined &&
    derivedColumn(plan, attr) === field.columnName
  );
}

function planInverseAliases(context: EmitContext): void {
  for (const model of context.schema.models) {
    for (const relation of model.relations) {
      if (relation.relatedName === undefined) {
        continue;
      }
      const target: IrModel | undefined = findModel(
        context.schema,
        relation.targetModel
      );
      if (target === undefined) {
        continue;
      }
      const targetPlan: ModelPlan = planOf(context, target);
      const safe: string = identifier(
        context,
        `${model.name}.${relation.name}`,
        context.options.naming === 'normalize'
          ? toCamelCase(relation.relatedName)
          : relation.relatedName
      );
      context.inverseAliases.set(
        `${model.name}.${relation.name}`,
        uniqueName(safe, targetPlan.used)
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Column types
// ---------------------------------------------------------------------------

function typeSpecOf(
  context: EmitContext,
  label: string,
  field: IrField,
  keyLike: boolean
): TypeSpec {
  const depth: number = field.arrayDepth ?? 0;
  if (depth === 0) {
    return scalarTypeSpec(context, label, field, keyLike);
  }
  const element: TypeSpec = scalarTypeSpec(
    context,
    label,
    { ...field, arrayDepth: undefined },
    keyLike
  );
  const ts: string = `${element.ts.includes(' ') ? `(${element.ts})` : element.ts}${'[]'.repeat(depth)}`;
  if (context.cockroach && depth > 1) {
    context.warnings.push(
      `${label}: CockroachDB has no multi-dimensional arrays; the array was written as JSONB.`
    );
    return { expression: 'DataTypes.JSONB', ts };
  }
  if (context.dialect === 'postgres') {
    let expression: string = element.expression;
    for (let level: number = 0; level < depth; level += 1) {
      expression = `DataTypes.ARRAY(${expression})`;
    }
    return { expression, ts };
  }
  const jsonType: string = jsonTypeOf(
    { ...context, warnings: [] },
    label,
    'array'
  );
  context.warnings.push(
    `${label}: ${dialectName(context.dialect)} has no array column type; the array was written as ${jsonType.startsWith('DataTypes.JSON') ? 'JSON' : 'TEXT'}.`
  );
  return { expression: jsonType, ts };
}

/** True for SQLite under Sequelize 7, whose dialect has no BIGINT, DECIMAL or CHAR type. */
function v7Sqlite(context: EmitContext): boolean {
  return context.style === 'v7' && context.dialect === 'sqlite';
}

function dialectName(dialect: Dialect): string {
  switch (dialect) {
    case 'mysql':
      return 'MySQL';
    case 'sqlite':
      return 'SQLite';
    case 'mssql':
      return 'SQL Server';
    default:
      return 'PostgreSQL';
  }
}

/** JSON where the dialect has it; Sequelize's SQL Server dialect has none, so text holds the document. */
function jsonTypeOf(context: EmitContext, label: string, what: string): string {
  switch (context.dialect) {
    case 'postgres':
      return 'DataTypes.JSONB';
    case 'mssql':
      context.warnings.push(
        `${label}: SQL Server has no JSON column type before SQL Server 2025 (Sequelize would create a column of type JSON); the ${what} was written as TEXT.`
      );
      return 'DataTypes.TEXT';
    default:
      return 'DataTypes.JSON';
  }
}

function scalarTypeSpec(
  context: EmitContext,
  label: string,
  field: IrField,
  keyLike: boolean
): TypeSpec {
  const dialect: Dialect = context.dialect;

  if (field.enumName !== undefined) {
    const enumeration: IrEnum | undefined = enumOf(context, field);
    if (enumeration === undefined) {
      context.warnings.push(
        `${label}: enum "${field.enumName}" does not exist in the schema; the column was written as a plain string.`
      );
    } else if (dialect === 'mssql') {
      // Sequelize's SQL Server ENUM is a VARCHAR with a CHECK constraint that leaves out NOT NULL and the default.
      context.warnings.push(
        `${label}: Sequelize's ENUM for SQL Server drops NOT NULL and the default; the column was written as STRING and the values are only used for typing.`
      );
      return {
        expression: 'DataTypes.STRING',
        ts: enumUnion(enumeration),
      };
    } else {
      return {
        expression: `DataTypes.ENUM(${enumeration.values
          .map((value: IrEnumValue) => quote(value.dbValue))
          .join(', ')})`,
        ts: enumUnion(enumeration),
      };
    }
  }

  switch (field.type) {
    case 'string':
      if (field.maxLength !== undefined) {
        return {
          expression: `DataTypes.STRING(${field.maxLength})`,
          ts: 'string',
        };
      }
      // Sequelize has no unbounded varchar: TEXT keeps long values, but cannot be a key in MySQL.
      return {
        expression: keyLike ? 'DataTypes.STRING' : 'DataTypes.TEXT',
        ts: 'string',
      };
    case 'text':
      return { expression: 'DataTypes.TEXT', ts: 'string' };
    case 'uuid':
      return { expression: 'DataTypes.UUID', ts: 'string' };
    case 'int':
      // sequelize-cockroachdb returns the 64-bit unique_rowid() values of a SERIAL key as strings.
      return {
        expression: 'DataTypes.INTEGER',
        ts:
          context.cockroach && field.default?.kind === 'autoIncrement'
            ? 'string'
            : 'number',
      };
    case 'bigInt':
      return v7Sqlite(context)
        ? { expression: 'DataTypes.INTEGER', ts: 'number' }
        : { expression: 'DataTypes.BIGINT', ts: 'string' };
    case 'float':
      return { expression: 'DataTypes.DOUBLE', ts: 'number' };
    case 'decimal': {
      if (v7Sqlite(context)) {
        context.warnings.push(
          `${label}: the Sequelize 7 SQLite dialect has no DECIMAL type; the column was written as DOUBLE, which is not exact.`
        );
        return { expression: 'DataTypes.DOUBLE', ts: 'number' };
      }
      let precision: number | undefined = field.maxDigits;
      let scale: number | undefined = field.decimalPlaces;
      if (
        context.style === 'v7' &&
        context.dialect === 'mysql' &&
        precision === undefined
      ) {
        // The Sequelize 7 MySQL dialect refuses a DECIMAL without precision and scale.
        precision = 10;
        scale = 0;
        context.warnings.push(
          `${label}: the Sequelize 7 MySQL dialect needs a precision for DECIMAL; DECIMAL(10, 0), the MySQL default, was written.`
        );
      }
      const args: string =
        precision === undefined
          ? ''
          : scale === undefined
            ? `(${precision})`
            : `(${precision}, ${scale})`;
      return { expression: `DataTypes.DECIMAL${args}`, ts: 'string' };
    }
    case 'boolean':
      return { expression: 'DataTypes.BOOLEAN', ts: 'boolean' };
    case 'dateTime':
      return { expression: 'DataTypes.DATE', ts: 'Date' };
    case 'date':
      return { expression: 'DataTypes.DATEONLY', ts: 'string' };
    case 'time':
      return { expression: 'DataTypes.TIME', ts: 'string' };
    case 'json':
      return {
        expression: jsonTypeOf(context, label, 'column'),
        ts: 'unknown',
      };
    case 'bytes':
      return { expression: 'DataTypes.BLOB', ts: 'Buffer' };
    case 'duration':
      context.warnings.push(
        `${label}: Sequelize has no interval type; the duration was written as BIGINT (microseconds).`
      );
      return v7Sqlite(context)
        ? { expression: 'DataTypes.INTEGER', ts: 'number' }
        : { expression: 'DataTypes.BIGINT', ts: 'string' };
    case 'ipAddress':
      return dialect === 'postgres'
        ? { expression: 'DataTypes.INET', ts: 'string' }
        : { expression: 'DataTypes.STRING(45)', ts: 'string' };
    case 'hstore':
      if (context.cockroach) {
        context.warnings.push(
          `${label}: CockroachDB has no hstore type; the field was written as JSONB.`
        );
        return {
          expression: 'DataTypes.JSONB',
          ts: 'Record<string, string | null>',
        };
      }
      if (dialect === 'postgres') {
        return {
          expression: 'DataTypes.HSTORE',
          ts: 'Record<string, string | null>',
        };
      }
      context.warnings.push(
        `${label}: hstore exists only on PostgreSQL; the field was written as ${dialect === 'mssql' ? 'TEXT' : 'JSON'}.`
      );
      return {
        expression: jsonTypeOf({ ...context, warnings: [] }, label, 'field'),
        ts: 'Record<string, string | null>',
      };
    case 'range': {
      if (context.cockroach) {
        context.warnings.push(
          `${label}: CockroachDB has no range types (int4range, tstzrange, ...); the field was written as TEXT.`
        );
        return { expression: 'DataTypes.TEXT', ts: 'string' };
      }
      if (dialect === 'postgres') {
        const subtype: string =
          RANGE_SUBTYPES[field.rangeOf ?? 'int'] ?? 'INTEGER';
        return {
          expression: `DataTypes.RANGE(DataTypes.${subtype})`,
          ts: 'unknown',
        };
      }
      context.warnings.push(
        `${label}: range columns exist only on PostgreSQL; the field was written as TEXT.`
      );
      return { expression: 'DataTypes.TEXT', ts: 'string' };
    }
    case 'unsupported': {
      const raw: string = (field.unsupportedType ?? '').toLowerCase();
      const known: string | undefined = POSTGRES_ONLY_TYPES[raw];
      if (
        known !== undefined &&
        dialect === 'postgres' &&
        !(context.cockroach && COCKROACH_MISSING.has(raw))
      ) {
        return { expression: `DataTypes.${known}`, ts: 'unknown' };
      }
      context.warnings.push(
        `${label}: the database type "${field.unsupportedType ?? 'unknown'}" has no Sequelize data type${known === undefined ? '' : ` on ${context.cockroach ? 'CockroachDB' : dialectName(dialect)}`}; the column was written as TEXT.`
      );
      return { expression: 'DataTypes.TEXT', ts: 'string' };
    }
    default:
      context.warnings.push(
        `${label}: unknown field type "${String(field.type)}"; it was written as TEXT.`
      );
      return { expression: 'DataTypes.TEXT', ts: 'string' };
  }
}

function enumUnion(enumeration: IrEnum): string {
  return enumeration.values
    .map((value: IrEnumValue) => quote(value.dbValue))
    .join(' | ');
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/** The value of `defaultValue` for a field, or undefined when it has none or Sequelize cannot express it. */
function defaultOf(
  context: EmitContext,
  label: string,
  field: IrField
): string | undefined {
  const value: IrDefault | undefined = field.default;
  if (value === undefined) {
    return undefined;
  }
  const enumeration: IrEnum | undefined = enumOf(context, field);
  switch (value.kind) {
    case 'autoIncrement':
      return undefined;
    case 'now':
      return 'DataTypes.NOW';
    case 'uuid':
      if (value.version !== undefined && value.version !== 1) {
        if (value.version !== 4) {
          context.warnings.push(
            `${label}: Sequelize generates UUID versions 1 and 4 only; the version ${value.version} default was written as UUIDV4.`
          );
        }
      }
      return value.version === 1 ? 'DataTypes.UUIDV1' : 'DataTypes.UUIDV4';
    case 'enumValue': {
      const member: IrEnumValue | undefined =
        enumeration === undefined
          ? undefined
          : enumMember(enumeration, value.value);
      if (member === undefined) {
        context.warnings.push(
          `${label}: the enum default "${value.value}" does not match a member of the enum; it was written as a string.`
        );
        return quote(value.value);
      }
      return quote(member.dbValue);
    }
    case 'dbExpression':
      context.usesLiteral = true;
      return `${context.style === 'v7' ? 'sql' : 'Sequelize'}.literal(${quote(defaultExpression(context, value.expression))})`;
    case 'clientGenerated':
      context.warnings.push(
        `${label}: the ${value.generator}() default is generated by Prisma Client; Sequelize has no equivalent and the default was dropped.`
      );
      return undefined;
    case 'literal':
      return literalDefault(context, label, field, value.value, enumeration);
    default:
      return undefined;
  }
}

function literalDefault(
  context: EmitContext,
  label: string,
  field: IrField,
  value: string | number | boolean,
  enumeration: IrEnum | undefined
): string | undefined {
  if (typeof value !== 'string') {
    return String(value);
  }
  // The empty default of an array of enum values is an array too: the string `'[]'` is refused for the column.
  if ((field.arrayDepth ?? 0) > 0 && value === '[]') {
    return '[]';
  }
  if (enumeration !== undefined) {
    const member: IrEnumValue | undefined = enumMember(enumeration, value);
    return quote(member === undefined ? value : member.dbValue);
  }
  if ((field.arrayDepth ?? 0) > 0) {
    context.warnings.push(
      `${label}: the array default ${value} cannot be written; it was dropped.`
    );
    return undefined;
  }
  if (field.type === 'json') {
    try {
      return jsonLiteral(JSON.parse(value) as unknown);
    } catch {
      return quote(value);
    }
  }
  if (field.type === 'hstore' && value === '{}') {
    return '{}';
  }
  if (field.type === 'bytes') {
    context.warnings.push(
      `${label}: a literal default on a binary column cannot be written; it was dropped.`
    );
    return undefined;
  }
  return quote(value);
}

/** An expression default that every dialect reads without parentheses. */
const PLAIN_DEFAULT: RegExp =
  /^(current_(timestamp|date|time)(\(\d*\))?|localtimestamp|now\(\)|null|true|false|-?\d+(\.\d+)?|'(?:[^']|'')*')$/i;

/** SQLite and MySQL accept an expression as a default only in parentheses: `DEFAULT (uuid())`. */
function defaultExpression(context: EmitContext, expression: string): string {
  const trimmed: string = expression.trim();
  const needsParentheses: boolean =
    (context.dialect === 'sqlite' || context.dialect === 'mysql') &&
    !PLAIN_DEFAULT.test(trimmed) &&
    !/^\(.*\)$/s.test(trimmed);
  return needsParentheses ? `(${trimmed})` : trimmed;
}

function jsonLiteral(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  if (typeof value === 'string') {
    return quote(value);
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(jsonLiteral).join(', ')}]`;
  }
  if (typeof value === 'object') {
    const parts: string[] = Object.entries(
      value as Record<string, unknown>
    ).map(
      ([key, item]: [string, unknown]) =>
        `${IDENTIFIER_PATTERN.test(key) ? key : quote(key)}: ${jsonLiteral(item)}`
    );
    return parts.length === 0 ? '{}' : `{ ${parts.join(', ')} }`;
  }
  return 'null';
}

// ---------------------------------------------------------------------------
// Attributes
// ---------------------------------------------------------------------------

function columnEntry(
  plan: ModelPlan,
  attribute: string,
  column: string
): string | undefined {
  return derivedColumn(plan, attribute) === column
    ? undefined
    : `field: ${quote(column)}`;
}

function fieldAttribute(
  context: EmitContext,
  plan: ModelPlan,
  field: IrField
): AttributeSpec {
  const model: IrModel = plan.model;
  const label: string = `${model.name}.${field.name}`;
  const name: string = plan.attrs.get(field.name) ?? field.name;
  const spec: TypeSpec = typeSpecOf(
    context,
    label,
    field,
    plan.keyLike.has(field.name)
  );
  const inCompositeKey: boolean =
    model.compositePrimaryKey?.includes(field.name) ?? false;
  const isKey: boolean = field.isPrimaryKey || inCompositeKey;
  if (field.generated !== undefined) {
    context.warnings.push(
      `${label}: Sequelize has no generated columns, so the expression ${field.generated.expression} was dropped and the column written as a regular one.`
    );
  }
  if (field.isAutoUpdated && plan.timestamps.updated !== field) {
    context.warnings.push(
      `${label}: only a date-time column can be Sequelize's updatedAt; it was written as a plain column that the application has to refresh.`
    );
  }

  let autoIncrement: boolean = false;
  if (field.default?.kind === 'autoIncrement') {
    if (field.isPrimaryKey && !inCompositeKey && isIntegerKey(field)) {
      autoIncrement = true;
      if (context.cockroach) {
        context.sequentialKeys.push(label);
      }
    } else {
      context.warnings.push(
        `${label}: an auto-increment default is only supported on a single integer primary key; it was dropped.`
      );
    }
  }
  const defaultValue: string | undefined = defaultOf(context, label, field);
  const sqliteInteger: boolean =
    autoIncrement && context.dialect === 'sqlite' && field.type === 'bigInt';
  const entries: string[] = compact([
    isKey ? 'primaryKey: true' : undefined,
    autoIncrement ? 'autoIncrement: true' : undefined,
    !isKey && !field.isNullable ? 'allowNull: false' : undefined,
    field.isUnique && !isKey
      ? field.uniqueName === undefined
        ? 'unique: true'
        : `unique: ${quote(field.uniqueName)}`
      : undefined,
    defaultValue === undefined ? undefined : `defaultValue: ${defaultValue}`,
    columnEntry(plan, name, field.columnName),
  ]);
  const optional: boolean =
    field.isNullable ||
    autoIncrement ||
    defaultValue !== undefined ||
    field.default?.kind === 'autoIncrement';
  return {
    name,
    // SQLite only allows AUTOINCREMENT on INTEGER PRIMARY KEY, which already holds 64 bits.
    type: sqliteInteger ? 'DataTypes.INTEGER' : spec.expression,
    entries,
    ts: sqliteInteger ? 'number' : spec.ts,
    optional,
    isReadonly: false,
    implicit: false,
  };
}

/** The columns Sequelize adds for `timestamps`: required date-times that it fills in itself. */
function implicitTimestamp(
  name: string,
  timestamp: 'created' | 'updated'
): AttributeSpec {
  return {
    name,
    timestamp,
    type: 'DataTypes.DATE',
    entries: ['allowNull: false'],
    ts: 'Date',
    optional: true,
    isReadonly: true,
    implicit: true,
  };
}

interface KeyReference {
  /** The referenced column, for the type of the foreign key. */
  field: IrField;
  /** Attribute of the referenced column on the target model. */
  attr: string;
}

/** Resolves the column a relation points at: an explicit `toField`, otherwise the single primary key. */
function referencedKey(
  context: EmitContext,
  target: IrModel,
  toField: string | undefined,
  depth: number = 0
): KeyReference | undefined {
  if (depth > 5) {
    return undefined;
  }
  const plan: ModelPlan = planOf(context, target);
  const explicit: IrField | undefined =
    toField === undefined
      ? undefined
      : target.fields.find(
          (field: IrField) =>
            field.name === toField || field.columnName === toField
        );
  const column: IrField | undefined =
    explicit ?? target.fields.find((field: IrField) => field.isPrimaryKey);
  if (column !== undefined) {
    return { field: column, attr: plan.attrs.get(column.name) ?? column.name };
  }
  const primary: IrRelation | undefined = target.relations.find(
    (relation: IrRelation) => relation.isPrimaryKey === true
  );
  if (primary === undefined) {
    return undefined;
  }
  const chained: IrModel | undefined = findModel(
    context.schema,
    primary.targetModel
  );
  const chainedKey: KeyReference | undefined =
    chained === undefined
      ? undefined
      : referencedKey(context, chained, primary.toField, depth + 1);
  return chainedKey === undefined
    ? undefined
    : {
        field: chainedKey.field,
        attr: plan.keys.get(primary.name) ?? chainedKey.attr,
      };
}

function keyAttribute(
  context: EmitContext,
  plan: ModelPlan,
  relation: IrRelation,
  key: KeyReference
): AttributeSpec {
  const model: IrModel = plan.model;
  const label: string = `${model.name}.${relation.name}`;
  const name: string = plan.keys.get(relation.name) ?? relation.columnName;
  const spec: TypeSpec = typeSpecOf(
    context,
    label,
    {
      ...key.field,
      default: undefined,
      isUnique: false,
      isNullable: relation.isNullable,
      arrayDepth: undefined,
    },
    true
  );
  const isKey: boolean =
    relation.isPrimaryKey === true ||
    (model.compositePrimaryKey?.includes(relation.name) ?? false);
  const entries: string[] = compact([
    isKey ? 'primaryKey: true' : undefined,
    !isKey && !relation.isNullable ? 'allowNull: false' : undefined,
    relation.kind === 'oneToOne' && !isKey ? 'unique: true' : undefined,
    columnEntry(plan, name, relation.columnName),
  ]);
  return {
    name,
    type: spec.expression,
    entries,
    // A key that points at a SERIAL key holds the same string (see the 'int' case of scalarTypeSpec).
    ts:
      context.cockroach &&
      key.field.type === 'int' &&
      key.field.default?.kind === 'autoIncrement'
        ? 'string'
        : spec.ts,
    optional: relation.isNullable,
    isReadonly: false,
    implicit: false,
  };
}

// ---------------------------------------------------------------------------
// Indexes
// ---------------------------------------------------------------------------

function indexColumn(
  context: EmitContext,
  model: IrModel,
  name: string
): string | undefined {
  const relation: IrRelation | undefined =
    model.relations.find(
      (candidate: IrRelation) =>
        candidate.kind !== 'manyToMany' && candidate.name === name
    ) ??
    model.relations.find(
      (candidate: IrRelation) =>
        candidate.kind !== 'manyToMany' && candidate.columnName === name
    );
  if (relation !== undefined) {
    return relation.columnName;
  }
  const field: IrField | undefined =
    model.fields.find((candidate: IrField) => candidate.name === name) ??
    model.fields.find((candidate: IrField) => candidate.columnName === name);
  void context;
  return field?.columnName;
}

function indexField(
  column: string,
  options: IrIndexFieldOptions | undefined
): string {
  if (options === undefined) {
    return quote(column);
  }
  const entries: string[] = compact([
    `name: ${quote(column)}`,
    options.sort === 'desc' ? `order: 'DESC'` : undefined,
    options.length === undefined ? undefined : `length: ${options.length}`,
    options.ops === undefined ? undefined : `operator: ${quote(options.ops)}`,
  ]);
  return entries.length === 1 ? quote(column) : `{ ${entries.join(', ')} }`;
}

function indexEntries(
  context: EmitContext,
  model: IrModel,
  index: IrIndex
): string[] | undefined {
  const label: string = `${model.name} index (${index.fields.join(', ')})`;
  const fields: string[] = [];
  for (const name of index.fields) {
    const column: string | undefined = indexColumn(context, model, name);
    if (column === undefined) {
      context.warnings.push(
        `${label}: "${name}" is not a column of the model; the index was skipped.`
      );
      return undefined;
    }
    const indexed: IrField | undefined = model.fields.find(
      (candidate: IrField) =>
        candidate.name === name || candidate.columnName === name
    );
    if (
      context.dialect === 'mysql' &&
      indexed !== undefined &&
      (indexed.type === 'json' || (indexed.arrayDepth ?? 0) > 0)
    ) {
      // JSON is what a MySQL array column is written as, too.
      context.warnings.push(
        `${label}: MySQL cannot index the JSON column "${name}"; the index was skipped.`
      );
      return undefined;
    }
    let options: IrIndexFieldOptions | undefined = index.fieldOptions?.[name];
    if (context.cockroach && options?.ops !== undefined) {
      context.warnings.push(
        `${label}: CockroachDB supports only trigram operator classes on inverted indexes; the operator class of "${name}" was dropped.`
      );
      const { ops: _dropped, ...rest } = options;
      void _dropped;
      options = Object.keys(rest).length === 0 ? undefined : rest;
    }
    if (options?.ops !== undefined && context.dialect === 'postgres') {
      // Prisma names an operator class `JsonbPathOps`; PostgreSQL knows it as `jsonb_path_ops`. A name that is
      // not in Prisma's PascalCase (`jsonb_path_ops`, `pg_catalog.text_pattern_ops`) is the database's own.
      const raw: RegExpExecArray | null = /^raw\(\s*["'](.*)["']\s*\)$/.exec(
        options.ops
      );
      const prisma: boolean = /^[A-Z][A-Za-z0-9]*$/.test(options.ops);
      options = {
        ...options,
        ops: raw?.[1] ?? (prisma ? toSnakeCase(options.ops) : options.ops),
      };
    }
    fields.push(indexField(column, options));
  }
  const dialect: Dialect = context.dialect;
  let using: string | undefined;
  if (index.method !== undefined) {
    const method: string | undefined =
      INDEX_METHODS[index.method.toLowerCase()];
    if (method === undefined) {
      context.warnings.push(
        `${label}: the index method "${index.method}" is not known to Sequelize and was dropped.`
      );
    } else if (context.cockroach && method !== 'BTREE' && method !== 'GIN') {
      context.warnings.push(
        `${label}: CockroachDB has no ${method} indexes (only B-tree and inverted GIN); USING ${method} was dropped.`
      );
    } else if (
      context.cockroach &&
      method === 'GIN' &&
      !cockroachInvertible(
        model.fields.find(
          (candidate: IrField) =>
            candidate.name === index.fields[index.fields.length - 1] ||
            candidate.columnName === index.fields[index.fields.length - 1]
        )
      )
    ) {
      context.warnings.push(
        `${label}: CockroachDB builds an inverted (GIN) index only over JSON, array or spatial columns, so USING GIN was dropped.`
      );
    } else if (dialect === 'mysql' && method !== 'BTREE' && method !== 'HASH') {
      context.warnings.push(
        `${label}: MySQL indexes are B-tree or hash; USING ${method} was dropped.`
      );
    } else if (dialect === 'postgres' || dialect === 'mysql') {
      using = method;
    } else {
      context.warnings.push(
        `${label}: ${dialectName(dialect)} has no index methods; USING ${method} was dropped.`
      );
    }
  }
  let fullText: boolean = false;
  if (index.kind === 'fulltext') {
    if (dialect === 'mysql') {
      fullText = true;
    } else {
      context.warnings.push(
        `${label}: full-text indexes are a MySQL feature in Sequelize; it was written as an ordinary index.`
      );
    }
  }
  if (index.clustered !== undefined) {
    context.warnings.push(
      `${label}: clustered and non-clustered options have no Sequelize equivalent and were dropped.`
    );
  }
  return compact([
    index.name === undefined ? undefined : `name: ${quote(index.name)}`,
    index.isUnique ? 'unique: true' : undefined,
    fullText ? `type: 'FULLTEXT'` : undefined,
    using === undefined ? undefined : `using: ${quote(using)}`,
    `fields: [${fields.join(', ')}]`,
  ]);
}

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

interface RenderedModel {
  attributes: AttributeSpec[];
  /** Entries of the options object after `sequelize` and `modelName`. */
  options: string[];
  /** Lines of the `indexes` option (empty when the model has none). */
  indexLines: string[];
  /** True when the model has no primary key and Sequelize's implicit id must be removed. */
  removeId: boolean;
  /** True when a default needs `Sequelize.literal`. */
  usesLiteral: boolean;
}

function renderModel(
  context: EmitContext,
  plan: ModelPlan,
  associations: AssociationLog
): RenderedModel {
  const model: IrModel = plan.model;
  const attributes: AttributeSpec[] = [];
  const timestamps: TimestampPlan = plan.timestamps;

  const timestampKinds: Map<IrField, 'created' | 'updated'> = new Map<
    IrField,
    'created' | 'updated'
  >();
  if (timestamps.created !== undefined) {
    timestampKinds.set(timestamps.created, 'created');
  }
  if (timestamps.updated !== undefined) {
    timestampKinds.set(timestamps.updated, 'updated');
  }

  for (const field of model.fields) {
    const kind: 'created' | 'updated' | undefined = timestampKinds.get(field);
    if (kind !== undefined && isImplicitTimestamp(plan, field, kind)) {
      attributes.push(
        implicitTimestamp(plan.attrs.get(field.name) ?? field.name, kind)
      );
      continue;
    }
    attributes.push(fieldAttribute(context, plan, field));
  }

  for (const relation of model.relations) {
    renderRelation(context, plan, relation, attributes, associations);
  }

  const hasPrimaryKey: boolean =
    model.fields.some((field: IrField) => field.isPrimaryKey) ||
    model.relations.some(
      (relation: IrRelation) => relation.isPrimaryKey === true
    ) ||
    (model.compositePrimaryKey?.length ?? 0) > 0;
  let removeId: boolean = false;
  if (model.isView === true) {
    context.warnings.push(
      `${model.name}: this is a database view; it was written as a model of the same name, but Sequelize cannot define a view, so sync() would create a table instead.`
    );
  }
  if (!hasPrimaryKey) {
    const idAttribute: AttributeSpec | undefined = attributes.find(
      (attribute: AttributeSpec) => attribute.name === 'id'
    );
    if (idAttribute === undefined) {
      removeId = true;
      context.warnings.push(
        `${model.name}: the model has no primary key; Sequelize would add an "id" column, so ${context.style === 'v7' ? 'noPrimaryKey: true' : "removeAttribute('id')"} was written. Most Sequelize features need a key.`
      );
    } else {
      idAttribute.entries = [
        'primaryKey: true',
        ...idAttribute.entries.filter(
          (entry: string) => entry !== 'allowNull: false'
        ),
      ];
      context.warnings.push(
        `${model.name}: the model has no primary key, and Sequelize refuses a model with an "id" column that is not one; "id" was written with primaryKey: true.`
      );
    }
  }

  const options: string[] = [`tableName: ${quote(model.tableName)}`];
  if (model.schema !== undefined) {
    if (context.dialect === 'sqlite') {
      // Sequelize would name the SQLite table "schema.table" instead.
      context.warnings.push(
        `${model.name}: SQLite has no database schemas; the schema "${model.schema}" was ignored.`
      );
    } else if (context.dialect === 'mysql') {
      // A MySQL schema is another database, which Sequelize would name in every query ("schema"."table").
      context.warnings.push(
        `${model.name}: MySQL has no schemas inside a database (a schema is another database); the schema "${model.schema}" was ignored.`
      );
    } else {
      options.push(`schema: ${quote(model.schema)}`);
    }
  }
  const enabled: boolean =
    timestamps.created !== undefined || timestamps.updated !== undefined;
  options.push(`timestamps: ${enabled ? 'true' : 'false'}`);
  if (enabled) {
    const createdName: string | undefined =
      timestamps.created === undefined
        ? undefined
        : plan.attrs.get(timestamps.created.name);
    const updatedName: string | undefined =
      timestamps.updated === undefined
        ? undefined
        : plan.attrs.get(timestamps.updated.name);
    if (createdName === undefined) {
      options.push('createdAt: false');
    } else if (createdName !== 'createdAt') {
      options.push(`createdAt: ${quote(createdName)}`);
    }
    if (updatedName === undefined) {
      options.push('updatedAt: false');
    } else if (updatedName !== 'updatedAt') {
      options.push(`updatedAt: ${quote(updatedName)}`);
    }
  }
  if (plan.underscored) {
    options.push('underscored: true');
  }

  const indexLines: string[] = [];
  for (const index of model.indexes) {
    const entries: string[] | undefined = indexEntries(context, model, index);
    if (entries !== undefined) {
      indexLines.push(...objectLines('', entries, INDENT, ','));
    }
  }
  return {
    attributes,
    options,
    indexLines,
    removeId,
    usesLiteral: context.usesLiteral,
  };
}

function actionOptions(relation: IrRelation): string[] {
  const entries: string[] = [
    `onDelete: ${quote(ON_ACTIONS[relation.onDelete])}`,
  ];
  // ON UPDATE CASCADE is what Sequelize adds to every key; only another action is written.
  if (relation.onUpdate !== undefined && relation.onUpdate !== 'cascade') {
    entries.push(`onUpdate: ${quote(ON_ACTIONS[relation.onUpdate])}`);
  }
  return entries;
}

function addAssociation(
  associations: AssociationLog,
  spec: AssociationSpec
): void {
  const list: AssociationSpec[] = associations.byOwner.get(spec.owner) ?? [];
  list.push(spec);
  associations.byOwner.set(spec.owner, list);
  associations.ordered.push(spec);
}

function renderRelation(
  context: EmitContext,
  plan: ModelPlan,
  relation: IrRelation,
  attributes: AttributeSpec[],
  associations: AssociationLog
): void {
  const model: IrModel = plan.model;
  const label: string = `${model.name}.${relation.name}`;
  const target: IrModel | undefined = findModel(
    context.schema,
    relation.targetModel
  );
  if (target === undefined) {
    context.warnings.push(
      `${label}: target model "${relation.targetModel}" does not exist in the schema; the relation was skipped.`
    );
    return;
  }
  const targetPlan: ModelPlan = planOf(context, target);
  const alias: string = plan.aliases.get(relation.name) ?? relation.name;
  const inverse: string | undefined = context.inverseAliases.get(label);

  if (relation.kind === 'manyToMany') {
    renderManyToMany(
      context,
      plan,
      targetPlan,
      relation,
      alias,
      inverse,
      associations
    );
    return;
  }

  const key: KeyReference | undefined = referencedKey(
    context,
    target,
    relation.toField
  );
  if (key === undefined) {
    context.warnings.push(
      `${label}: target model "${target.name}" has no single-column primary key to reference; the relation was skipped.`
    );
    return;
  }
  if (relation.onDelete === 'setNull' && !relation.isNullable) {
    context.warnings.push(
      `${label}: onDelete SET NULL on a required relation will fail at the database level; review the relation.`
    );
  }
  const attribute: AttributeSpec = keyAttribute(context, plan, relation, key);
  attributes.push(attribute);

  const keyOption: string = `foreignKey: ${quote(attribute.name)}`;
  const toKey: string | undefined =
    relation.toField === undefined ? undefined : key.attr;
  if (context.style === 'v7') {
    addRelationV7(associations, plan, targetPlan, relation, {
      alias,
      inverse,
      key: attribute.name,
      targetKey: toKey,
    });
    return;
  }
  addAssociation(associations, {
    owner: plan.className,
    method: 'belongsTo',
    relation: label,
    target: targetPlan.className,
    alias,
    options: compact([
      `as: ${quote(alias)}`,
      keyOption,
      toKey === undefined ? undefined : `targetKey: ${quote(toKey)}`,
      ...actionOptions(relation),
    ]),
  });
  if (inverse !== undefined) {
    addAssociation(associations, {
      owner: targetPlan.className,
      method: relation.kind === 'oneToOne' ? 'hasOne' : 'hasMany',
      relation: label,
      target: plan.className,
      alias: inverse,
      options: compact([
        `as: ${quote(inverse)}`,
        keyOption,
        toKey === undefined ? undefined : `sourceKey: ${quote(toKey)}`,
        ...actionOptions(relation),
      ]),
    });
  }
}

function renderManyToMany(
  context: EmitContext,
  plan: ModelPlan,
  targetPlan: ModelPlan,
  relation: IrRelation,
  alias: string,
  inverse: string | undefined,
  associations: AssociationLog
): void {
  const model: IrModel = plan.model;
  const target: IrModel = targetPlan.model;
  const label: string = `${model.name}.${relation.name}`;
  const hasSingleKey = (candidate: IrModel): boolean =>
    candidate.fields.filter((field: IrField) => field.isPrimaryKey).length ===
    1;
  if (!hasSingleKey(model) || !hasSingleKey(target)) {
    context.warnings.push(
      `${label}: a many-to-many relation needs a single-column primary key on both models; the relation was skipped.`
    );
    return;
  }
  const isSelf: boolean = model.name === target.name;
  const ownerColumn: string = `${isSelf ? 'from_' : ''}${toSnakeCase(model.name)}_id`;
  const targetColumn: string = `${isSelf ? 'to_' : ''}${toSnakeCase(target.name)}_id`;
  // The join table the other emitters derive; Sequelize creates it itself.
  const table: string = quote(`${model.tableName}_${relation.name}`);
  if (context.style === 'v7') {
    let otherSide: string | undefined = inverse;
    if (otherSide === undefined && isSelf) {
      // Sequelize 7 refuses a self-referencing many-to-many whose two sides do not have different names.
      otherSide = uniqueName(`${alias}Inverse`, plan.used);
      context.warnings.push(
        `${label}: Sequelize 7 needs a name for the other side of a self-referencing many-to-many relation; "${otherSide}" was added.`
      );
    }
    // The two halves of a self-referencing relation would give the join model's associations the same names.
    const throughNames: string | undefined =
      isSelf && otherSide !== undefined
        ? `throughAssociations: { fromSource: ${quote(uniqueName(`${alias}Links`, plan.used))}, toSource: ${quote(`${alias}Source`)}, fromTarget: ${quote(uniqueName(`${otherSide}Links`, plan.used))}, toTarget: ${quote(`${alias}Target`)} }`
        : undefined;
    addAssociationV7(associations, plan.className, {
      decorator: 'BelongsToMany',
      alias,
      target: targetPlan.className,
      many: true,
      options: compact([
        `through: { model: ${table}, timestamps: false }`,
        `foreignKey: ${quote(ownerColumn)}`,
        `otherKey: ${quote(targetColumn)}`,
        otherSide === undefined ? undefined : `inverse: ${quote(otherSide)}`,
        throughNames,
      ]),
    });
    if (otherSide !== undefined) {
      addAssociationV7(associations, targetPlan.className, {
        alias: otherSide,
        target: plan.className,
        many: true,
        options: [],
      });
    }
    return;
  }
  addAssociation(associations, {
    owner: plan.className,
    method: 'belongsToMany',
    relation: label,
    target: targetPlan.className,
    alias,
    options: [
      `as: ${quote(alias)}`,
      `through: ${table}`,
      `foreignKey: ${quote(ownerColumn)}`,
      `otherKey: ${quote(targetColumn)}`,
      'timestamps: false',
    ],
  });
  if (inverse !== undefined) {
    addAssociation(associations, {
      owner: targetPlan.className,
      method: 'belongsToMany',
      relation: label,
      target: plan.className,
      alias: inverse,
      options: [
        `as: ${quote(inverse)}`,
        `through: ${table}`,
        `foreignKey: ${quote(targetColumn)}`,
        `otherKey: ${quote(ownerColumn)}`,
        'timestamps: false',
      ],
    });
  }
}

// ---------------------------------------------------------------------------
// Output: attribute and association text
// ---------------------------------------------------------------------------

function attributeLines(attribute: AttributeSpec, indent: string): string[] {
  const key: string = IDENTIFIER_PATTERN.test(attribute.name)
    ? attribute.name
    : quote(attribute.name);
  if (attribute.entries.length === 0) {
    return [`${indent}${key}: ${attribute.type},`];
  }
  return objectLines(
    `${key}: `,
    [`type: ${attribute.type}`, ...attribute.entries],
    indent,
    ','
  );
}

function associationLines(
  spec: AssociationSpec,
  targetExpression: string,
  indent: string
): string[] {
  const head: string = `${spec.owner}.${spec.method}(${targetExpression}, `;
  const inline: string = `${indent}${head}{ ${spec.options.join(', ')} });`;
  if (inline.length <= MAX_LINE_WIDTH) {
    return [inline];
  }
  return [
    `${indent}${spec.owner}.${spec.method}(${targetExpression}, {`,
    ...spec.options.map((entry: string) => `${indent}${INDENT}${entry},`),
    `${indent}});`,
  ];
}

function optionBlock(
  leading: string[],
  rendered: RenderedModel,
  indent: string
): string[] {
  const lines: string[] = [];
  const entries: string[] = [...leading, ...rendered.options];
  const inline: string = `${indent}{ ${[...entries].join(', ')} }`;
  if (rendered.indexLines.length === 0 && inline.length <= MAX_LINE_WIDTH) {
    return [inline];
  }
  lines.push(`${indent}{`);
  for (const entry of entries) {
    lines.push(`${indent}${INDENT}${entry},`);
  }
  if (rendered.indexLines.length > 0) {
    lines.push(`${indent}${INDENT}indexes: [`);
    for (const line of rendered.indexLines) {
      lines.push(`${indent}${INDENT}${line}`);
    }
    lines.push(`${indent}${INDENT}],`);
  }
  lines.push(`${indent}}`);
  return lines;
}

// ---------------------------------------------------------------------------
// Output: init style (TypeScript)
// ---------------------------------------------------------------------------

function creationType(attribute: AttributeSpec, nullable: boolean): string {
  const base: string = nullable ? `${attribute.ts} | null` : attribute.ts;
  return attribute.optional ? `CreationOptional<${base}>` : base;
}

function writeInitFile(
  context: EmitContext,
  plan: ModelPlan,
  rendered: RenderedModel,
  associations: AssociationLog
): string {
  const own: AssociationSpec[] = associations.byOwner.get(plan.className) ?? [];
  const nullableByName: Set<string> = new Set<string>();
  for (const field of plan.model.fields) {
    if (field.isNullable) {
      nullableByName.add(plan.attrs.get(field.name) ?? field.name);
    }
  }
  for (const relation of plan.model.relations) {
    const key: string | undefined = plan.keys.get(relation.name);
    if (relation.isNullable && key !== undefined) {
      nullableByName.add(key);
    }
  }

  const needsCreationOptional: boolean = rendered.attributes.some(
    (attribute: AttributeSpec) => attribute.optional
  );
  const classLines: string[] = rendered.attributes.map(
    (attribute: AttributeSpec): string =>
      `${INDENT}declare ${attribute.isReadonly ? 'readonly ' : ''}${attribute.name}: ${creationType(
        attribute,
        nullableByName.has(attribute.name)
      )};`
  );
  const importedTypes: Set<string> = new Set<string>();
  const associationLinesOut: string[] = [];
  for (const spec of own) {
    const many: boolean =
      spec.method === 'hasMany' || spec.method === 'belongsToMany';
    if (spec.target !== plan.className) {
      importedTypes.add(spec.target);
    }
    associationLinesOut.push(
      `${INDENT}declare ${spec.alias}?: NonAttribute<${spec.target}${many ? '[]' : ''}>;`
    );
  }

  const valueImports: string[] = ['DataTypes', 'Model'];
  const typeImports: string[] = ['InferAttributes', 'InferCreationAttributes'];
  if (rendered.usesLiteral) {
    valueImports.push('Sequelize');
  } else {
    typeImports.push('Sequelize');
  }
  if (needsCreationOptional) {
    typeImports.push('CreationOptional');
  }
  if (associationLinesOut.length > 0) {
    typeImports.push('NonAttribute');
  }
  typeImports.sort((first: string, second: string) =>
    first.localeCompare(second)
  );
  const specifiers: string[] = [
    ...valueImports,
    ...typeImports.map((name: string) => `type ${name}`),
  ];

  const lines: string[] = [
    'import {',
    ...specifiers.map((specifier: string) => `${INDENT}${specifier},`),
    `} from 'sequelize';`,
  ];
  const typeFiles: string[] = [...importedTypes].sort();
  for (const name of typeFiles) {
    lines.push(`import type { ${name} } from '${fileOf(context, name)}';`);
  }
  lines.push('', ...classHeader(plan), ...classLines);
  if (associationLinesOut.length > 0) {
    lines.push('', ...associationLinesOut);
  }
  lines.push(
    '',
    `${INDENT}static initModel(sequelize: Sequelize): typeof ${plan.className} {`,
    `${INDENT}${INDENT}${plan.className}.init(`,
    `${INDENT}${INDENT}${INDENT}{`
  );
  for (const attribute of rendered.attributes) {
    lines.push(...attributeLines(attribute, INDENT.repeat(4)));
  }
  lines.push(
    `${INDENT}${INDENT}${INDENT}},`,
    ...optionBlock(
      ['sequelize', `modelName: ${quote(plan.className)}`],
      rendered,
      INDENT.repeat(3)
    ),
    `${INDENT}${INDENT});`
  );
  if (rendered.removeId) {
    lines.push(`${INDENT}${INDENT}${plan.className}.removeAttribute('id');`);
  }
  lines.push(
    `${INDENT}${INDENT}return ${plan.className};`,
    `${INDENT}}`,
    '}',
    ''
  );
  return lines.join('\n');
}

function classHeader(plan: ModelPlan): string[] {
  const name: string = plan.className;
  const inline: string = `export class ${name} extends Model<InferAttributes<${name}>, InferCreationAttributes<${name}>> {`;
  if (inline.length <= MAX_LINE_WIDTH) {
    return [inline];
  }
  return [
    `export class ${name} extends Model<`,
    `${INDENT}InferAttributes<${name}>,`,
    `${INDENT}InferCreationAttributes<${name}>`,
    '> {',
  ];
}

/** Import path of another model's file, found by class name. */
function fileOf(context: EmitContext, className: string): string {
  for (const plan of context.plans.values()) {
    if (plan.className === className) {
      return `./${plan.fileBase}.js`;
    }
  }
  return `./${className}.js`;
}

function writeInitIndex(
  context: EmitContext,
  associations: AssociationLog
): string {
  const plans: ModelPlan[] = context.schema.models.map((model: IrModel) =>
    planOf(context, model)
  );
  const lines: string[] = context.cockroach
    ? [
        '// CockroachDB: import Sequelize from sequelize-cockroachdb (it patches Sequelize 6) and use the postgres dialect:',
        "//   import { Sequelize } from 'sequelize-cockroachdb';",
        "//   const sequelize = new Sequelize(process.env.DATABASE_URL!, { dialect: 'postgres' });",
        `import type { Sequelize } from 'sequelize';`,
      ]
    : [`import type { Sequelize } from 'sequelize';`];
  for (const plan of plans) {
    lines.push(`import { ${plan.className} } from './${plan.fileBase}.js';`);
  }
  lines.push(
    '',
    `export { ${plans.map((plan: ModelPlan) => plan.className).join(', ')} };`,
    '',
    '/** Initializes every model on a Sequelize instance, then sets up the associations. */',
    'export function initModels(sequelize: Sequelize) {'
  );
  for (const plan of plans) {
    lines.push(`${INDENT}${plan.className}.initModel(sequelize);`);
  }
  // The relations keep the order of the schema: a many-to-many pair is read with its first call as the owner.
  let previous: string | undefined;
  for (const spec of associations.ordered) {
    if (spec.relation !== previous) {
      lines.push('');
      previous = spec.relation;
    }
    lines.push(...associationLines(spec, spec.target, INDENT));
  }
  lines.push(
    '',
    `${INDENT}return { ${plans.map((plan: ModelPlan) => plan.className).join(', ')} };`,
    '}',
    '',
    'export type Models = ReturnType<typeof initModels>;',
    ''
  );
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Output: define style (sequelize-cli CommonJS)
// ---------------------------------------------------------------------------

function writeDefineFile(
  plan: ModelPlan,
  rendered: RenderedModel,
  associations: AssociationLog
): string {
  const own: AssociationSpec[] = associations.byOwner.get(plan.className) ?? [];
  const lines: string[] = [`'use strict';`, ''];
  if (rendered.usesLiteral) {
    lines.push(`const { Sequelize } = require('sequelize');`, '');
  }
  lines.push(
    'module.exports = (sequelize, DataTypes) => {',
    `${INDENT}const ${plan.className} = sequelize.define(`,
    `${INDENT}${INDENT}${quote(plan.className)},`,
    `${INDENT}${INDENT}{`
  );
  for (const attribute of rendered.attributes) {
    if (!attribute.implicit) {
      lines.push(...attributeLines(attribute, INDENT.repeat(3)));
    }
  }
  lines.push(
    `${INDENT}${INDENT}},`,
    ...optionBlock([], rendered, INDENT.repeat(2)),
    `${INDENT});`
  );
  if (rendered.removeId) {
    lines.push('', `${INDENT}${plan.className}.removeAttribute('id');`);
  }
  if (own.length > 0) {
    lines.push('', `${INDENT}${plan.className}.associate = (models) => {`);
    for (const spec of own) {
      lines.push(
        ...associationLines(spec, `models.${spec.target}`, INDENT.repeat(2))
      );
    }
    lines.push(`${INDENT}};`);
  }
  lines.push('', `${INDENT}return ${plan.className};`, '};', '');
  return lines.join('\n');
}

function writeDefineIndex(context: EmitContext): string {
  const plans: ModelPlan[] = context.schema.models.map((model: IrModel) =>
    planOf(context, model)
  );
  const lines: string[] = [
    `'use strict';`,
    '',
    `const { DataTypes } = require('sequelize');`,
    '',
    ...(context.cockroach
      ? [
          '// CockroachDB: require sequelize-cockroachdb (it patches Sequelize 6) and use the postgres dialect:',
          "//   const { Sequelize } = require('sequelize-cockroachdb');",
          "//   const sequelize = new Sequelize(process.env.DATABASE_URL, { dialect: 'postgres' });",
          '',
        ]
      : []),
    '// Defines every model on a Sequelize instance, then runs the associate functions:',
    "//   const { initModels } = require('./models');",
    '//   const models = initModels(sequelize);',
    'function initModels(sequelize) {',
    `${INDENT}const models = {`,
  ];
  for (const plan of plans) {
    lines.push(
      `${INDENT}${INDENT}${plan.className}: require('./${plan.fileBase}')(sequelize, DataTypes),`
    );
  }
  lines.push(
    `${INDENT}};`,
    `${INDENT}Object.values(models).forEach((model) => {`,
    `${INDENT}${INDENT}if (model.associate) {`,
    `${INDENT}${INDENT}${INDENT}model.associate(models);`,
    `${INDENT}${INDENT}}`,
    `${INDENT}});`,
    `${INDENT}return models;`,
    '}',
    '',
    'module.exports = { initModels };',
    ''
  );
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Output: Sequelize 7 style (decorators)
// ---------------------------------------------------------------------------

function addAssociationV7(
  associations: AssociationLog,
  owner: string,
  association: V7Association
): void {
  const list: V7Association[] = associations.v7.get(owner) ?? [];
  list.push(association);
  associations.v7.set(owner, list);
}

interface RelationNamesV7 {
  /** The alias of the relation on the model that holds the key. */
  alias: string;
  /** The alias of the other side, when the IR names one. */
  inverse: string | undefined;
  /** The attribute that holds the key. */
  key: string;
  /** The attribute of the target the key points at, when it is not the primary key. */
  targetKey: string | undefined;
}

/**
 * Declares a relation once. The model that holds the key gets `@BelongsTo`, whose `inverse` option defines the
 * other side as well; that side is only a typed property. A self reference is declared from the `@HasMany` /
 * `@HasOne` side, because Sequelize 7 cannot build the inverse of a self-referencing `@BelongsTo`.
 */
function addRelationV7(
  associations: AssociationLog,
  plan: ModelPlan,
  targetPlan: ModelPlan,
  relation: IrRelation,
  names: RelationNamesV7
): void {
  const entries: string[] = compact([
    `onDelete: ${quote(ON_ACTIONS[relation.onDelete])}`,
    // ON UPDATE CASCADE is what Sequelize adds to every key; only another action is written.
    relation.onUpdate !== undefined && relation.onUpdate !== 'cascade'
      ? `onUpdate: ${quote(ON_ACTIONS[relation.onUpdate])}`
      : undefined,
  ]);
  const foreignKey: string = `foreignKey: { name: ${quote(names.key)}, ${entries.join(', ')} }`;
  const isOne: boolean = relation.kind === 'oneToOne';
  const { alias, inverse, targetKey } = names;
  if (inverse === undefined) {
    addAssociationV7(associations, plan.className, {
      decorator: 'BelongsTo',
      alias,
      target: targetPlan.className,
      many: false,
      options: compact([
        foreignKey,
        targetKey === undefined ? undefined : `targetKey: ${quote(targetKey)}`,
      ]),
    });
  } else if (plan.className !== targetPlan.className) {
    addAssociationV7(associations, plan.className, {
      decorator: 'BelongsTo',
      alias,
      target: targetPlan.className,
      many: false,
      options: compact([
        foreignKey,
        targetKey === undefined ? undefined : `targetKey: ${quote(targetKey)}`,
        `inverse: { type: ${quote(isOne ? 'hasOne' : 'hasMany')}, as: ${quote(inverse)} }`,
      ]),
    });
    addAssociationV7(associations, targetPlan.className, {
      alias: inverse,
      target: plan.className,
      many: !isOne,
      options: [],
    });
  } else {
    addAssociationV7(associations, plan.className, {
      decorator: isOne ? 'HasOne' : 'HasMany',
      alias: inverse,
      target: plan.className,
      many: !isOne,
      options: compact([
        foreignKey,
        targetKey === undefined ? undefined : `sourceKey: ${quote(targetKey)}`,
        `inverse: ${quote(alias)}`,
      ]),
    });
    addAssociationV7(associations, plan.className, {
      alias,
      target: plan.className,
      many: false,
      options: [],
    });
  }
}

/** What the Sequelize 7 text writer needs to know about one model. */
function v7ModelOf(
  plan: ModelPlan,
  rendered: RenderedModel,
  associations: AssociationLog
): V7Model {
  const nullable: Set<string> = new Set<string>();
  for (const field of plan.model.fields) {
    if (field.isNullable) {
      nullable.add(plan.attrs.get(field.name) ?? field.name);
    }
  }
  for (const relation of plan.model.relations) {
    const key: string | undefined = plan.keys.get(relation.name);
    if (relation.isNullable && key !== undefined) {
      nullable.add(key);
    }
  }
  const attributes: V7Attribute[] = rendered.attributes.map(
    (attribute: AttributeSpec): V7Attribute => ({
      name: attribute.name,
      type: attribute.type,
      entries: attribute.entries,
      ts: attribute.ts,
      nullable: nullable.has(attribute.name),
      optional: attribute.optional,
      isReadonly: attribute.isReadonly,
      ...(attribute.timestamp === undefined
        ? {}
        : { timestamp: attribute.timestamp }),
    })
  );
  // `@CreatedAt` / `@UpdatedAt` name the columns that Sequelize adds, so the options that rename them are redundant.
  const created: boolean = attributes.some(
    (attribute: V7Attribute) => attribute.timestamp === 'created'
  );
  const updated: boolean = attributes.some(
    (attribute: V7Attribute) => attribute.timestamp === 'updated'
  );
  return {
    className: plan.className,
    attributes,
    tableOptions: rendered.options.filter(
      (entry: string) =>
        !(created && entry.startsWith("createdAt: '")) &&
        !(updated && entry.startsWith("updatedAt: '"))
    ),
    indexLines: rendered.indexLines,
    associations: associations.v7.get(plan.className) ?? [],
    noPrimaryKey: rendered.removeId,
    usesSql: rendered.usesLiteral,
  };
}

/** The Sequelize 7 dialect package and class for the provider, with the connection options of the example. */
function v7DialectOf(context: EmitContext): V7Dialect {
  switch (context.dialect) {
    case 'mysql':
      return {
        package: '@sequelize/mysql',
        dialect: 'MySqlDialect',
        connection: ['url: process.env.DATABASE_URL'],
      };
    case 'sqlite':
      return {
        package: '@sequelize/sqlite3',
        dialect: 'SqliteDialect',
        connection: ["storage: 'database.sqlite'"],
      };
    case 'mssql':
      return {
        package: '@sequelize/mssql',
        dialect: 'MsSqlDialect',
        connection: ["server: 'localhost'", "database: 'app'"],
      };
    default:
      return {
        package: '@sequelize/postgres',
        dialect: 'PostgresDialect',
        connection: ['url: process.env.DATABASE_URL'],
      };
  }
}

/** Remarks for the comment of the `index` file. */
function v7Notes(context: EmitContext): string[] {
  return context.cockroach
    ? [
        'CockroachDB: Sequelize 7 has no CockroachDB dialect; the PostgreSQL dialect above talks to it.',
      ]
    : [];
}
