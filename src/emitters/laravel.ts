import type { MultiFileEmitOutput } from '../formats.js';
import { prismaOnlyWarnings } from '../prismaOnlyConstructs.js';
import type {
  IrDefault,
  IrEnum,
  IrEnumValue,
  IrField,
  IrIndex,
  IrModel,
  IrOnDelete,
  IrRelation,
  IrSchema,
} from '../ir.js';
import { findModel } from '../ir.js';
import { toCamelCase, toPascalCase, toSnakeCase } from '../naming.js';
import type { NamingMode } from '../transforms.js';
import { isValidPhpNamespace } from './doctrine.js';
import type { PrismaProvider } from './prisma.js';

/**
 * Laravel emitter (Laravel 11 / 12 style, PHP 8.1+). Writes one migration per
 * table under `database/migrations/` (anonymous classes, deterministic
 * timestamped file names in dependency order), Eloquent models under
 * `app/Models/` and backed enums under `app/Enums/`, so it returns the
 * multi-file form of the emit contract.
 */
export interface LaravelEmitOptions {
  /** Database provider; chooses `jsonb` on PostgreSQL and MySQL-style JSON defaults. */
  provider: PrismaProvider;
  /**
   * "preserve" keeps the existing table and column names (written explicitly
   * on the models); "normalize" applies Laravel conventions (plural snake_case
   * tables, snake_case columns, `<singular>_id` keys, `created_at` /
   * `updated_at`, `post_tag` style pivot tables). Default "preserve".
   */
  naming?: NamingMode;
  /** PHP namespace of the models (default `App\Models`). Enums go in the sibling `Enums` namespace. */
  namespace?: string;
}

export const DEFAULT_LARAVEL_NAMESPACE: string = 'App\\Models';

const IDENTIFIER_PATTERN: RegExp = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_LINE_WIDTH: number = 100;
const INDENT: string = '    ';
const MIGRATION_DIRECTORY: string = 'database/migrations';
const MIGRATION_DATE_PREFIX: string = '2024_01_01';

const RESERVED_CLASS_NAMES: ReadonlySet<string> = new Set(
  [
    'abstract and array as break callable case catch',
    'class clone const continue declare default do echo',
    'else elseif empty enddeclare endfor endforeach endif endswitch',
    'endwhile enum eval exit extends final finally fn',
    'for foreach function global goto if implements include',
    'instanceof insteadof interface isset list match namespace new',
    'or print private protected public readonly require return',
    'static switch throw trait try unset use var',
    'while xor yield bool false float int iterable',
    'mixed never null object parent self string true',
    'void model softdeletes hasuuids hasulids belongsto belongstomany',
    'hasmany hasone collection',
  ]
    .join(' ')
    .split(' ')
);

/** Names of Eloquent methods that a relationship method must not shadow (lower case). */
const RESERVED_METHOD_NAMES: ReadonlySet<string> = new Set(
  [
    'save delete update fill refresh fresh touch push replicate query create',
    'find all get first newquery getkey getattribute setattribute is isnot',
    'with load toarray tojson booted boot casts trashed restore forcedelete',
    'uniqueids newuniqueid where getconnection gettable getkeyname fillable',
    'guarded hidden visible appends dates destroy upsert increment decrement',
    'getattributes setattributes getrelations setrelation relation unsetrelation',
    'qualifycolumn newinstance newcollection replicate usesuniqueids',
  ]
    .join(' ')
    .split(' ')
);

/** Words whose plural Laravel's inflector keeps unchanged. */
const UNCOUNTABLE_WORDS: ReadonlySet<string> = new Set([
  'equipment',
  'information',
  'rice',
  'money',
  'species',
  'series',
  'fish',
  'sheep',
  'news',
  'data',
  'metadata',
  'media',
]);

const IRREGULAR_PLURALS: Readonly<Record<string, string>> = {
  person: 'people',
  man: 'men',
  woman: 'women',
  child: 'children',
  foot: 'feet',
  tooth: 'teeth',
  goose: 'geese',
  mouse: 'mice',
  ox: 'oxen',
};

/** Word endings whose plural is irregular often enough that the emitter will not assume Laravel's guess. */
const UNCERTAIN_PLURAL_ENDING: RegExp =
  /(f|fe|o|z|is|us|um|on|ix|ex|ax|a|man|ouse|ooth|oot|ice|ife)$/;

const CREATED_FIELD_NAMES: ReadonlySet<string> = new Set([
  'created_at',
  'created',
  'createdat',
  'date_created',
]);
const UPDATED_FIELD_NAMES: ReadonlySet<string> = new Set([
  'updated_at',
  'updated',
  'updatedat',
  'modified',
  'modified_at',
  'date_updated',
]);

type ValueKind =
  | 'string'
  | 'int'
  | 'float'
  | 'decimal'
  | 'bool'
  | 'datetime'
  | 'date'
  | 'time'
  | 'json'
  | 'enum'
  | 'other';

/** One Blueprint call plus the modifiers chained after it. */
interface Chain {
  method: string;
  /** PHP source of every argument, the column name first. */
  args: string[];
  modifiers: string[];
}

interface ColumnSpec {
  method: string;
  /** Arguments after the column name. */
  args: string[];
  valueKind: ValueKind;
  /** PHP source of the Eloquent cast, e.g. `'boolean'` or `PostStatus::class`. */
  cast?: string;
  enumDefinition?: IrEnum;
}

type KeyKind = 'increments' | 'foreignId' | 'uuid' | 'ulid' | 'plain';

/** The single-column primary key of a model. */
interface KeyInfo {
  /** Database column. */
  column: string;
  /** Field or relation name in the IR. */
  name: string;
  kind: KeyKind;
  /** The field behind the key (for a relation key, the key field of its target). */
  field?: IrField;
}

/** How a column that references another table is declared. */
type ReferenceStyle = 'id' | 'uuid' | 'ulid' | 'plain';

interface ForeignKeyPlan {
  column: string;
  referencedTable: string;
  referencedColumn: string;
  style: ReferenceStyle;
  /** Column type (method and arguments after the name) for the `plain` style. */
  columnType?: { method: string; args: string[] };
  nullable: boolean;
  unique: boolean;
  /** True when the column is the primary key of its table. */
  isKey: boolean;
  onDelete: IrOnDelete;
  onUpdate?: IrOnDelete;
  /** Name of the table the key points to (graph node). */
  targetNode: string;
  /** Set when a dependency cycle forces the constraint into a later migration. */
  deferred: boolean;
}

interface TablePlan {
  /** Node key: the model name, or `pivot:<table>` for a many-to-many table. */
  node: string;
  table: string;
  primary?: Chain;
  columns: Chain[];
  foreignKeys: ForeignKeyPlan[];
  /** Chains written after the foreign keys (`timestamps()`, `softDeletes()`). */
  tail: Chain[];
  /** Statements such as `$table->primary([...])` and indexes, as PHP text. */
  constraints: string[];
  imports: Set<string>;
}

interface ModelPlan {
  model: IrModel;
  className: string;
  table: TablePlan;
  key: KeyInfo | undefined;
  /** Column names of a composite primary key. */
  compositeKey: string[] | undefined;
  hasTimestamps: boolean;
  hasSoftDeletes: boolean;
  fillable: string[];
  casts: [string, string][];
  /** Columns the HasUuids trait fills in. */
  uuidColumns: string[];
  usesUlid: boolean;
  usesUuid: boolean;
  /** True when HasUuids / HasUlids generates the primary key. */
  keyGenerated: boolean;
  /** Names that relationship methods must not reuse (lower case). */
  takenNames: Set<string>;
  methods: string[][];
  imports: Set<string>;
}

interface EmitContext {
  schema: IrSchema;
  options: LaravelEmitOptions;
  normalize: boolean;
  warnings: string[];
  modelNamespace: string;
  enumNamespace: string;
  classNames: Map<string, string>;
  enumNames: Map<string, string>;
  plans: Map<string, ModelPlan>;
  pivots: TablePlan[];
  usedTables: Set<string>;
}

// ---------------------------------------------------------------------------
// Public entry points
// ---------------------------------------------------------------------------

export function emitLaravel(
  schema: IrSchema,
  options: LaravelEmitOptions
): MultiFileEmitOutput {
  const normalize: boolean = options.naming === 'normalize';
  const prepared: IrSchema = normalize
    ? normalizeLaravelSchema(schema)
    : schema;
  const warnings: string[] = prismaOnlyWarnings(prepared);
  let modelNamespace: string = DEFAULT_LARAVEL_NAMESPACE;
  if (options.namespace !== undefined) {
    const requested: string = options.namespace.replace(/^\\+|\\+$/g, '');
    if (isValidPhpNamespace(requested)) {
      modelNamespace = requested;
    } else {
      warnings.push(
        `The namespace "${options.namespace}" is not a valid PHP namespace; "${DEFAULT_LARAVEL_NAMESPACE}" was used instead.`
      );
    }
  }
  const context: EmitContext = {
    schema: prepared,
    options,
    normalize,
    warnings,
    modelNamespace,
    enumNamespace: siblingEnumNamespace(modelNamespace),
    classNames: new Map<string, string>(),
    enumNames: new Map<string, string>(),
    plans: new Map<string, ModelPlan>(),
    pivots: [],
    usedTables: new Set<string>(),
  };
  if (options.provider === 'mongodb') {
    warnings.push(
      'Provider "mongodb": Laravel migrations are relational (use the mongodb/laravel-mongodb package for MongoDB); relational migrations and models were written.'
    );
  }

  allocateNames(context);
  for (const model of prepared.models) {
    planModel(context, model);
  }
  const links: ManyToManyLink[] = [];
  for (const model of prepared.models) {
    planOwnedRelations(context, model, links);
  }
  for (const model of prepared.models) {
    planInverseRelations(context, model, links);
  }
  removeHandledWarnings(context);

  const files: Record<string, string> = {};
  for (const enumDefinition of prepared.enums) {
    files[enumPath(context, enumDefinition)] = renderEnum(
      context,
      enumDefinition
    );
  }
  for (const model of prepared.models) {
    const plan: ModelPlan | undefined = context.plans.get(model.name);
    if (plan !== undefined) {
      files[modelPath(context, plan)] = renderModel(context, plan);
    }
  }
  for (const [path, text] of Object.entries(renderMigrations(context))) {
    files[path] = text;
  }
  return { files, warnings };
}

/**
 * Applies Laravel conventions to a schema: plural snake_case table names (join
 * tables keep theirs), snake_case columns, and `created_at` / `updated_at`
 * where a model has none. Primary keys keep their type (UUID or ULID keys only
 * when the schema says so).
 */
export function normalizeLaravelSchema(schema: IrSchema): IrSchema {
  return {
    ...schema,
    models: schema.models.map((model: IrModel): IrModel =>
      normalizeLaravelModel(model)
    ),
  };
}

function normalizeLaravelModel(model: IrModel): IrModel {
  const fields: IrField[] = model.fields.map((field: IrField): IrField => ({
    ...field,
    columnName: toSnakeCase(field.columnName),
  }));
  if (model.isJoinTable !== true) {
    const hasCreated: boolean = fields.some((field: IrField) =>
      CREATED_FIELD_NAMES.has(field.name.toLowerCase())
    );
    const hasUpdated: boolean = fields.some(
      (field: IrField) =>
        field.isAutoUpdated || UPDATED_FIELD_NAMES.has(field.name.toLowerCase())
    );
    if (!hasCreated) {
      fields.push({
        name: 'created_at',
        columnName: 'created_at',
        type: 'dateTime',
        isPrimaryKey: false,
        isUnique: false,
        isNullable: false,
        isAutoUpdated: false,
        default: { kind: 'now' },
      });
    }
    if (!hasUpdated) {
      fields.push({
        name: 'updated_at',
        columnName: 'updated_at',
        type: 'dateTime',
        isPrimaryKey: false,
        isUnique: false,
        isNullable: false,
        isAutoUpdated: true,
      });
    }
  }
  return {
    ...model,
    tableName:
      model.isJoinTable === true
        ? model.tableName
        : pluralize(laravelSnake(model.name)).value,
    fields,
    relations: model.relations.map((relation: IrRelation): IrRelation => ({
      ...relation,
      columnName:
        relation.columnName === '' ? '' : toSnakeCase(relation.columnName),
    })),
  };
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Single-quoted PHP string. */
function quote(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

/** Laravel's `Str::snake`, which differs from the package helper for acronyms. */
function laravelSnake(value: string): string {
  if (value === value.toLowerCase()) {
    return value;
  }
  return value
    .replace(/\s+/g, '')
    .replace(/(.)(?=[A-Z])/gu, '$1_')
    .toLowerCase();
}

interface Plural {
  value: string;
  /** False when Laravel's inflector might pluralize the word differently. */
  certain: boolean;
}

/** Pluralizes the last word of a snake_case identifier the way Laravel's inflector does for regular words. */
function pluralize(snake: string): Plural {
  const words: string[] = snake.split('_');
  const last: string = words.pop() ?? '';
  const prefix: string = words.length === 0 ? '' : `${words.join('_')}_`;
  const lower: string = last.toLowerCase();
  const irregular: string | undefined = IRREGULAR_PLURALS[lower];
  if (irregular !== undefined) {
    return { value: `${prefix}${irregular}`, certain: true };
  }
  if (UNCOUNTABLE_WORDS.has(lower) || /data$/.test(lower)) {
    return { value: snake, certain: true };
  }
  if (/[^aeiou]y$/.test(lower)) {
    return { value: `${prefix}${last.slice(0, -1)}ies`, certain: true };
  }
  const certain: boolean = !UNCERTAIN_PLURAL_ENDING.test(lower);
  if (/ss$/.test(lower)) {
    return { value: `${prefix}${last}es`, certain: true };
  }
  if (/is$/.test(lower)) {
    return { value: `${prefix}${last.slice(0, -2)}es`, certain: false };
  }
  if (/(us|as)$/.test(lower)) {
    return { value: `${prefix}${last}es`, certain: false };
  }
  if (/s$/.test(lower)) {
    // Already plural (Laravel's inflector leaves "PostTags" and "Settings" alone).
    return { value: snake, certain };
  }
  if (/(x|ch|sh)$/.test(lower)) {
    return { value: `${prefix}${last}es`, certain };
  }
  return { value: `${prefix}${last}s`, certain };
}

function uniqueName(
  baseName: string,
  used: Set<string>,
  caseInsensitive: boolean = true
): string {
  const taken = (candidate: string): boolean =>
    used.has(caseInsensitive ? candidate.toLowerCase() : candidate);
  let candidate: string = baseName;
  let suffix: number = 2;
  while (taken(candidate)) {
    candidate = `${baseName}${suffix}`;
    suffix += 1;
  }
  used.add(caseInsensitive ? candidate.toLowerCase() : candidate);
  return candidate;
}

/** Makes a raw name a valid PHP identifier, warning when it had to change. */
function identifier(context: EmitContext, owner: string, raw: string): string {
  if (IDENTIFIER_PATTERN.test(raw)) {
    return raw;
  }
  const replaced: string = raw.replace(/[^A-Za-z0-9_]/g, '_');
  const safe: string = /^[0-9]/.test(replaced) ? `_${replaced}` : replaced;
  const result: string = safe === '' ? '_' : safe;
  context.warnings.push(
    `${owner}: "${raw}" is not a valid PHP identifier; it was written as "${result}".`
  );
  return result;
}

function siblingEnumNamespace(modelNamespace: string): string {
  const segments: string[] = modelNamespace.split('\\');
  if (segments.length > 1 && segments[segments.length - 1] === 'Models') {
    segments[segments.length - 1] = 'Enums';
    return segments.join('\\');
  }
  return `${modelNamespace}\\Enums`;
}

/** PSR-4 directory for a namespace: the first segment maps to `app/`, the rest to folders. */
function namespaceDirectory(namespace: string): string {
  return ['app', ...namespace.split('\\').slice(1)].join('/');
}

function modelPath(context: EmitContext, plan: ModelPlan): string {
  return `${namespaceDirectory(context.modelNamespace)}/${plan.className}.php`;
}

function enumPath(context: EmitContext, enumDefinition: IrEnum): string {
  const name: string = context.enumNames.get(enumDefinition.name) ?? '';
  return `${namespaceDirectory(context.enumNamespace)}/${name}.php`;
}

function findEnum(context: EmitContext, name: string): IrEnum | undefined {
  return context.schema.enums.find(
    (candidate: IrEnum) => candidate.name === name
  );
}

function classNameOf(context: EmitContext, modelName: string): string {
  return context.classNames.get(modelName) ?? modelName;
}

/** Local name of an enum inside a model file; aliased when a model has the same name. */
function enumLocalName(context: EmitContext, enumName: string): string {
  const phpName: string = context.enumNames.get(enumName) ?? enumName;
  const clashes: boolean = [...context.classNames.values()].some(
    (className: string) => className.toLowerCase() === phpName.toLowerCase()
  );
  return clashes ? `${phpName}Enum` : phpName;
}

function enumUseStatement(context: EmitContext, enumName: string): string {
  const phpName: string = context.enumNames.get(enumName) ?? enumName;
  const local: string = enumLocalName(context, enumName);
  return local === phpName
    ? `${context.enumNamespace}\\${phpName}`
    : `${context.enumNamespace}\\${phpName} as ${local}`;
}

function enumCaseName(context: EmitContext, value: IrEnumValue): string {
  const name: string = identifier({ ...context, warnings: [] }, '', value.name);
  return name.toLowerCase() === 'class' ? `${name}_` : name;
}

function allocateNames(context: EmitContext): void {
  const used: Set<string> = new Set<string>();
  for (const model of context.schema.models) {
    let base: string = model.name;
    if (!IDENTIFIER_PATTERN.test(base)) {
      base = identifier(context, model.name, toPascalCase(model.name));
    }
    if (RESERVED_CLASS_NAMES.has(base.toLowerCase())) {
      const renamed: string = `${base}Model`;
      context.warnings.push(
        `${model.name}: "${base}" cannot be used as a PHP class name; the class was named "${renamed}".`
      );
      base = renamed;
    }
    context.classNames.set(model.name, uniqueName(base, used));
  }
  for (const enumDefinition of context.schema.enums) {
    let base: string = enumDefinition.name;
    if (!IDENTIFIER_PATTERN.test(base)) {
      base = identifier(
        context,
        `enum ${enumDefinition.name}`,
        toPascalCase(enumDefinition.name)
      );
    }
    if (RESERVED_CLASS_NAMES.has(base.toLowerCase())) {
      const renamed: string = `${base}Enum`;
      context.warnings.push(
        `enum ${enumDefinition.name}: "${base}" cannot be used as a PHP class name; the enum was named "${renamed}".`
      );
      base = renamed;
    }
    context.enumNames.set(enumDefinition.name, base);
  }
}

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

function isUuidField(field: IrField): boolean {
  return (
    field.type === 'uuid' ||
    (field.default?.kind === 'uuid' &&
      (field.type === 'string' || field.type === 'text'))
  );
}

function isUlidField(field: IrField): boolean {
  return (
    field.default?.kind === 'clientGenerated' &&
    field.default.generator.toLowerCase() === 'ulid' &&
    (field.type === 'string' || field.type === 'uuid')
  );
}

function isAutoIncrement(field: IrField): boolean {
  return (
    field.default?.kind === 'autoIncrement' &&
    (field.type === 'int' || field.type === 'bigInt')
  );
}

function fieldKeyKind(field: IrField, isKey: boolean): KeyKind {
  if (isKey && isAutoIncrement(field)) {
    return 'increments';
  }
  if (isUlidField(field)) {
    return 'ulid';
  }
  if (isUuidField(field)) {
    return 'uuid';
  }
  return 'plain';
}

/** Column names of a composite primary key, or undefined for a single-column key. */
function compositeKeyNames(model: IrModel): string[] | undefined {
  if (model.compositePrimaryKey !== undefined) {
    return model.compositePrimaryKey.length > 0
      ? model.compositePrimaryKey
      : undefined;
  }
  const keyNames: string[] = [
    ...model.fields
      .filter((field: IrField) => field.isPrimaryKey)
      .map((field: IrField) => field.name),
    ...model.relations
      .filter(
        (relation: IrRelation) =>
          relation.isPrimaryKey === true && relation.kind !== 'manyToMany'
      )
      .map((relation: IrRelation) => relation.name),
  ];
  return keyNames.length > 1 ? keyNames : undefined;
}

function keyOf(
  context: EmitContext,
  model: IrModel,
  depth: number = 0
): KeyInfo | undefined {
  if (compositeKeyNames(model) !== undefined) {
    return undefined;
  }
  const keyField: IrField | undefined = model.fields.find(
    (field: IrField) => field.isPrimaryKey
  );
  if (keyField !== undefined) {
    return {
      column: keyField.columnName,
      name: keyField.name,
      kind: fieldKeyKind(keyField, true),
      field: keyField,
    };
  }
  const keyRelation: IrRelation | undefined = model.relations.find(
    (relation: IrRelation) =>
      relation.isPrimaryKey === true && relation.kind !== 'manyToMany'
  );
  if (keyRelation === undefined || depth > 5) {
    return undefined;
  }
  const target: IrModel | undefined = findModel(
    context.schema,
    keyRelation.targetModel
  );
  const targetKey: KeyInfo | undefined =
    target === undefined ? undefined : keyOf(context, target, depth + 1);
  if (targetKey === undefined) {
    return undefined;
  }
  return {
    column: keyRelation.columnName,
    name: keyRelation.name,
    kind: targetKey.kind === 'increments' ? 'foreignId' : targetKey.kind,
    ...(targetKey.field === undefined ? {} : { field: targetKey.field }),
  };
}

function referenceStyle(kind: KeyKind): ReferenceStyle {
  switch (kind) {
    case 'increments':
    case 'foreignId':
      return 'id';
    case 'uuid':
      return 'uuid';
    case 'ulid':
      return 'ulid';
    default:
      return 'plain';
  }
}

// ---------------------------------------------------------------------------
// Column types
// ---------------------------------------------------------------------------

function spec(
  method: string,
  args: string[],
  valueKind: ValueKind,
  cast?: string
): ColumnSpec {
  return {
    method,
    args,
    valueKind,
    ...(cast === undefined ? {} : { cast }),
  };
}

function valueKindOfMethod(method: string): ValueKind {
  if (/integer$/i.test(method)) {
    return 'int';
  }
  switch (method) {
    case 'string':
    case 'char':
    case 'text':
    case 'mediumText':
    case 'longText':
    case 'uuid':
    case 'ulid':
    case 'ipAddress':
      return 'string';
    case 'decimal':
      return 'decimal';
    case 'double':
    case 'float':
      return 'float';
    case 'dateTime':
    case 'dateTimeTz':
      return 'datetime';
    case 'date':
      return 'date';
    case 'time':
    case 'timeTz':
      return 'time';
    case 'json':
    case 'jsonb':
      return 'json';
    case 'boolean':
      return 'bool';
    default:
      return 'other';
  }
}

function castOf(kind: ValueKind, field: IrField): string | undefined {
  switch (kind) {
    case 'bool':
      return `'boolean'`;
    case 'json':
      return `'array'`;
    case 'datetime':
      return `'datetime'`;
    case 'date':
      return `'date'`;
    case 'float':
      return `'float'`;
    case 'decimal':
      return field.decimalPlaces === undefined
        ? undefined
        : `'decimal:${field.decimalPlaces}'`;
    default:
      return undefined;
  }
}

/** A native column type (Prisma `@db.*`) as a Blueprint method, when it maps to one. */
function nativeSpec(field: IrField): ColumnSpec | undefined {
  const native: IrField['nativeType'] = field.nativeType;
  if (native === undefined) {
    return undefined;
  }
  const first: string | undefined = native.args[0];
  const second: string | undefined = native.args[1];
  const simple = (method: string, args: string[] = []): ColumnSpec =>
    spec(method, args, valueKindOfMethod(method));
  switch (native.name.toLowerCase()) {
    case 'varchar':
      return simple('string', first === undefined ? [] : [first]);
    case 'char':
      return simple('char', first === undefined ? [] : [first]);
    case 'text':
    case 'tinytext':
      return simple('text');
    case 'mediumtext':
      return simple('mediumText');
    case 'longtext':
      return simple('longText');
    case 'uuid':
      return simple('uuid');
    case 'smallint':
    case 'int2':
      return simple('smallInteger');
    case 'tinyint':
      return first === '1' && field.type === 'boolean'
        ? simple('boolean')
        : simple('tinyInteger');
    case 'mediumint':
      return simple('mediumInteger');
    case 'unsignedint':
      return simple('unsignedInteger');
    case 'unsignedbigint':
      return simple('unsignedBigInteger');
    case 'unsignedsmallint':
      return simple('unsignedSmallInteger');
    case 'unsignedtinyint':
      return simple('unsignedTinyInteger');
    case 'unsignedmediumint':
      return simple('unsignedMediumInteger');
    case 'decimal':
    case 'numeric':
      return first !== undefined && second !== undefined
        ? simple('decimal', [first, second])
        : undefined;
    case 'doubleprecision':
    case 'double':
      return simple('double');
    case 'timestamptz':
      return simple('dateTimeTz', first === undefined ? [] : [first]);
    case 'timestamp':
    case 'datetime':
      return simple('dateTime', first === undefined ? [] : [first]);
    case 'jsonb':
      return simple('jsonb');
    case 'json':
      return simple('json');
    case 'bytea':
    case 'blob':
    case 'longblob':
    case 'mediumblob':
    case 'tinyblob':
    case 'binary':
    case 'varbinary':
      return simple('binary');
    case 'inet':
      return simple('ipAddress');
    default:
      return undefined;
  }
}

function columnSpecOf(
  context: EmitContext,
  label: string,
  field: IrField
): ColumnSpec {
  if ((field.arrayDepth ?? 0) > 0) {
    context.warnings.push(
      `${label}: Laravel has no array column type that works on every database; the array was written as a json column cast to an array.`
    );
    return spec(jsonMethod(context), [], 'json', `'array'`);
  }
  const native: ColumnSpec | undefined = nativeSpec(field);
  if (native !== undefined && field.enumName === undefined) {
    const cast: string | undefined = castOf(native.valueKind, field);
    return cast === undefined ? native : { ...native, cast };
  }
  return scalarSpec(context, label, field);
}

function jsonMethod(context: EmitContext): string {
  return context.options.provider === 'postgresql' ||
    context.options.provider === 'cockroachdb'
    ? 'jsonb'
    : 'json';
}

function scalarSpec(
  context: EmitContext,
  label: string,
  field: IrField
): ColumnSpec {
  if (field.enumName !== undefined) {
    const enumDefinition: IrEnum | undefined = findEnum(
      context,
      field.enumName
    );
    if (enumDefinition === undefined) {
      context.warnings.push(
        `${label}: enum "${field.enumName}" does not exist in the schema; the column is written as a plain string.`
      );
    } else {
      const values: string = enumDefinition.values
        .map((value: IrEnumValue) => quote(value.dbValue))
        .join(', ');
      return {
        method: 'enum',
        args: [`[${values}]`],
        valueKind: 'enum',
        cast: `${enumLocalName(context, enumDefinition.name)}::class`,
        enumDefinition,
      };
    }
  }
  switch (field.type) {
    case 'string':
      return spec(
        'string',
        field.maxLength === undefined || field.maxLength === 255
          ? []
          : [String(field.maxLength)],
        'string'
      );
    case 'text':
      return spec('text', [], 'string');
    case 'uuid':
      return spec('uuid', [], 'string');
    case 'int':
      return spec('integer', [], 'int');
    case 'bigInt':
      return spec('bigInteger', [], 'int');
    case 'float':
      return spec('double', [], 'float', `'float'`);
    case 'decimal':
      if (field.maxDigits !== undefined && field.decimalPlaces !== undefined) {
        return spec(
          'decimal',
          [String(field.maxDigits), String(field.decimalPlaces)],
          'decimal',
          `'decimal:${field.decimalPlaces}'`
        );
      }
      context.warnings.push(
        `${label}: the decimal precision and scale are unknown; Laravel's default of (8, 2) was used.`
      );
      return spec('decimal', [], 'decimal');
    case 'boolean':
      return spec('boolean', [], 'bool', `'boolean'`);
    case 'dateTime':
      return spec('dateTime', [], 'datetime', `'datetime'`);
    case 'date':
      return spec('date', [], 'date', `'date'`);
    case 'time':
      return spec('time', [], 'time');
    case 'json':
      return spec(jsonMethod(context), [], 'json', `'array'`);
    case 'bytes':
      return spec('binary', [], 'other');
    case 'duration':
      context.warnings.push(
        `${label}: Laravel has no interval column type; the duration was written as a string column.`
      );
      return spec('string', [], 'string');
    case 'ipAddress':
      return spec('ipAddress', [], 'string');
    case 'hstore':
      context.warnings.push(
        `${label}: Laravel has no hstore type; the field was written as a json column cast to an array.`
      );
      return spec(jsonMethod(context), [], 'json', `'array'`);
    case 'range':
      context.warnings.push(
        `${label}: Laravel has no range column type; the field was written as a string column holding the range text.`
      );
      return spec('string', [], 'string');
    case 'unsupported':
      return spec('string', [], 'string');
    default:
      context.warnings.push(
        `${label}: unknown field type "${String(field.type)}"; it was written as a string column.`
      );
      return spec('string', [], 'string');
  }
}

/** Finds the stored value of an enum default, given its case name or stored value. */
function enumStoredValue(
  definition: IrEnum | undefined,
  raw: string
): string | undefined {
  if (definition === undefined) {
    return undefined;
  }
  const match: IrEnumValue | undefined =
    definition.values.find(
      (candidate: IrEnumValue) => candidate.name === raw
    ) ??
    definition.values.find(
      (candidate: IrEnumValue) => candidate.dbValue === raw
    );
  return match?.dbValue;
}

function numberText(value: string | number | boolean): string | undefined {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? String(value) : undefined;
  }
  if (typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value.trim())) {
    return value.trim();
  }
  return undefined;
}

/** The `->default(...)`, `->useCurrent()` ... modifiers that carry a field's default. */
function defaultModifiers(
  context: EmitContext,
  label: string,
  field: IrField,
  columnSpec: ColumnSpec,
  imports: Set<string>
): string[] {
  const defaultValue: IrDefault | undefined = field.default;
  if (defaultValue === undefined) {
    return [];
  }
  const drop = (reason: string): string[] => {
    context.warnings.push(`${label}: ${reason}; it was dropped.`);
    return [];
  };
  switch (defaultValue.kind) {
    case 'autoIncrement':
      return drop(
        'an auto-increment default is only supported on primary keys'
      );
    case 'now':
      if (columnSpec.valueKind !== 'datetime') {
        return drop('a "now" default needs a dateTime column');
      }
      return ['useCurrent()'];
    case 'uuid':
      // Generated by the HasUuids trait rather than the database.
      return [];
    case 'enumValue':
      return enumDefault(columnSpec, defaultValue.value, drop);
    case 'literal':
      return literalDefault(
        context,
        field,
        columnSpec,
        defaultValue.value,
        imports,
        drop
      );
    default:
      // clientGenerated and dbExpression defaults are reported by prismaOnlyWarnings.
      return [];
  }
}

function enumDefault(
  columnSpec: ColumnSpec,
  raw: string,
  drop: (reason: string) => string[]
): string[] {
  const stored: string | undefined = enumStoredValue(
    columnSpec.enumDefinition,
    raw
  );
  return stored === undefined
    ? drop(`the enum default "${raw}" does not match a case of the enum`)
    : [`default(${quote(stored)})`];
}

function literalDefault(
  context: EmitContext,
  field: IrField,
  columnSpec: ColumnSpec,
  value: string | number | boolean,
  imports: Set<string>,
  drop: (reason: string) => string[]
): string[] {
  switch (columnSpec.valueKind) {
    case 'enum':
      return enumDefault(columnSpec, String(value), drop);
    case 'bool':
      return [
        `default(${value === true || value === 'true' ? 'true' : 'false'})`,
      ];
    case 'int': {
      const text: string | undefined = numberText(value);
      return text === undefined
        ? drop(`the default ${String(value)} is not a number`)
        : [`default(${String(Math.trunc(Number(text)))})`];
    }
    case 'float':
    case 'decimal': {
      const text: string | undefined = numberText(value);
      return text === undefined
        ? drop(`the default ${String(value)} is not a number`)
        : [`default(${text})`];
    }
    case 'string':
    case 'date':
    case 'datetime':
    case 'time':
      return [`default(${quote(String(value))})`];
    case 'json': {
      const text: string = typeof value === 'string' ? value : String(value);
      if (context.options.provider === 'mysql') {
        imports.add('Illuminate\\Database\\Query\\Expression');
        return [
          `default(new Expression(${quote(`('${text.replace(/'/g, "''")}')`)}))`,
        ];
      }
      return [`default(${quote(text)})`];
    }
    default:
      return drop(
        `a literal default on a ${field.type} column cannot be represented`
      );
  }
}

// ---------------------------------------------------------------------------
// Chain rendering
// ---------------------------------------------------------------------------

function chainText(chain: Chain): string {
  return `$table->${chain.method}(${chain.args.join(', ')})${chain.modifiers
    .map((modifier: string) => `->${modifier}`)
    .join('')}`;
}

/** Renders `$table->...;` at an indent, wrapping the chain one call per line when it is too long. */
function renderStatement(text: string, depth: number): string[] {
  const indent: string = INDENT.repeat(depth);
  const single: string = `${indent}${text};`;
  if (single.length <= MAX_LINE_WIDTH) {
    return [single];
  }
  const parts: string[] = splitCalls(text);
  return parts.map((part: string, index: number): string => {
    const prefix: string = index === 0 ? indent : `${indent}${INDENT}`;
    return `${prefix}${part}${index === parts.length - 1 ? ';' : ''}`;
  });
}

/** Splits `$table->a(1)->b('x')` at the top-level `->` separators. */
function splitCalls(text: string): string[] {
  const parts: string[] = [];
  let depth: number = 0;
  let inString: boolean = false;
  let current: string = '';
  for (let index: number = 0; index < text.length; index += 1) {
    const char: string = text.charAt(index);
    if (inString) {
      current += char;
      if (char === '\\') {
        index += 1;
        current += text.charAt(index);
      } else if (char === "'") {
        inString = false;
      }
      continue;
    }
    if (char === "'") {
      inString = true;
    } else if (char === '(' || char === '[') {
      depth += 1;
    } else if (char === ')' || char === ']') {
      depth -= 1;
    }
    if (
      depth === 0 &&
      char === '-' &&
      text.charAt(index + 1) === '>' &&
      current !== '$table'
    ) {
      parts.push(current);
      current = '->';
      index += 1;
      continue;
    }
    current += char;
  }
  parts.push(current);
  return parts;
}

// ---------------------------------------------------------------------------
// Planning: models, tables, columns
// ---------------------------------------------------------------------------

function newTablePlan(node: string, table: string): TablePlan {
  return {
    node,
    table,
    columns: [],
    foreignKeys: [],
    tail: [],
    constraints: [],
    imports: new Set<string>(),
  };
}

function conventionalTable(className: string): Plural {
  return pluralize(laravelSnake(className));
}

function planModel(context: EmitContext, model: IrModel): void {
  const className: string = classNameOf(context, model.name);
  const table: TablePlan = newTablePlan(model.name, model.tableName);
  if (context.usedTables.has(model.tableName)) {
    context.warnings.push(
      `${model.name}: the table "${model.tableName}" is also used by another model; the migrations would create it twice.`
    );
  }
  context.usedTables.add(model.tableName);
  const key: KeyInfo | undefined = keyOf(context, model);
  const compositeKey: string[] | undefined = compositeKeyNames(model);
  const plan: ModelPlan = {
    model,
    className,
    table,
    key,
    compositeKey: undefined,
    hasTimestamps: false,
    hasSoftDeletes: false,
    fillable: [],
    casts: [],
    uuidColumns: [],
    usesUlid: false,
    usesUuid: false,
    keyGenerated: false,
    takenNames: new Set<string>(),
    methods: [],
    imports: new Set<string>(['Illuminate\\Database\\Eloquent\\Model']),
  };
  context.plans.set(model.name, plan);
  if (key === undefined && compositeKey === undefined) {
    context.warnings.push(
      `${model.name}: the model has no primary key; Eloquent expects one, so $primaryKey was set to null.`
    );
  }
  if (compositeKey !== undefined) {
    context.warnings.push(
      `${model.name}: Eloquent does not support composite primary keys; the migration declares primary(${compositeKey.join(', ')}) but the model can only address the table through its own queries.`
    );
  }

  planFields(context, plan, compositeKey);
  planTableIndexes(context, plan);
}

function columnOfName(model: IrModel, name: string): string | undefined {
  const field: IrField | undefined = model.fields.find(
    (candidate: IrField) => candidate.name === name
  );
  if (field !== undefined) {
    return field.columnName;
  }
  return model.relations.find(
    (candidate: IrRelation) => candidate.name === name
  )?.columnName;
}

function planFields(
  context: EmitContext,
  plan: ModelPlan,
  compositeKey: string[] | undefined
): void {
  const model: IrModel = plan.model;
  const table: TablePlan = plan.table;
  const pair: [IrField, IrField] | undefined = timestampPair(model);
  const softDelete: IrField | undefined = model.fields.find(
    (field: IrField) =>
      field.columnName === 'deleted_at' &&
      field.type === 'dateTime' &&
      field.isNullable &&
      field.default === undefined &&
      field.enumName === undefined &&
      !field.isPrimaryKey &&
      (field.arrayDepth ?? 0) === 0
  );
  plan.hasTimestamps = pair !== undefined;
  plan.hasSoftDeletes = softDelete !== undefined;
  plan.compositeKey =
    compositeKey === undefined
      ? undefined
      : compositeKey
          .map((name: string) => columnOfName(model, name))
          .filter(
            (column: string | undefined): column is string =>
              column !== undefined
          );

  for (const field of model.fields) {
    const label: string = `${model.name}.${field.name}`;
    plan.takenNames.add(field.columnName.toLowerCase());
    plan.takenNames.add(field.name.toLowerCase());
    if (pair?.includes(field) === true || field === softDelete) {
      continue;
    }
    planField(context, plan, field, label, compositeKey);
  }
  for (const relation of model.relations) {
    if (relation.kind !== 'manyToMany') {
      plan.takenNames.add(relation.columnName.toLowerCase());
    }
  }
  if (pair !== undefined) {
    table.tail.push({ method: 'timestamps', args: [], modifiers: [] });
  }
  if (softDelete !== undefined) {
    table.tail.push({ method: 'softDeletes', args: [], modifiers: [] });
    plan.imports.add('Illuminate\\Database\\Eloquent\\SoftDeletes');
  }
}

/** The `created_at` / `updated_at` pair that Laravel's `timestamps()` and Eloquent manage together. */
function timestampPair(model: IrModel): [IrField, IrField] | undefined {
  const usable = (field: IrField | undefined): field is IrField =>
    field !== undefined &&
    field.type === 'dateTime' &&
    field.enumName === undefined &&
    (field.arrayDepth ?? 0) === 0 &&
    !field.isPrimaryKey &&
    !field.isUnique &&
    (field.default === undefined || field.default.kind === 'now');
  const created: IrField | undefined = model.fields.find(
    (field: IrField) => field.columnName === 'created_at'
  );
  const updated: IrField | undefined = model.fields.find(
    (field: IrField) => field.columnName === 'updated_at'
  );
  if (!usable(created) || !usable(updated)) {
    return undefined;
  }
  if (created.isAutoUpdated) {
    return undefined;
  }
  return [created, updated];
}

function planField(
  context: EmitContext,
  plan: ModelPlan,
  field: IrField,
  label: string,
  compositeKey: string[] | undefined
): void {
  const table: TablePlan = plan.table;
  const columnSpec: ColumnSpec = columnSpecOf(context, label, field);
  if (field.generated !== undefined) {
    context.warnings.push(
      `${label}: the generated column expression ${field.generated.expression} is not a SQL expression Laravel can write (storedAs / virtualAs); the column was written as a regular column.`
    );
  }
  const inComposite: boolean = compositeKey?.includes(field.name) ?? false;
  const isKey: boolean =
    plan.key?.field === field && plan.key.name === field.name;
  const keyKind: KeyKind = fieldKeyKind(field, isKey && !inComposite);
  const quotedName: string = quote(field.columnName);

  if (isKey && keyKind === 'increments') {
    table.primary =
      field.columnName === 'id'
        ? { method: 'id', args: [], modifiers: [] }
        : { method: 'bigIncrements', args: [quotedName], modifiers: [] };
    return;
  }

  const chain: Chain = {
    method: columnSpec.method,
    args: [quotedName, ...columnSpec.args],
    modifiers: [],
  };
  if (isKey && keyKind === 'uuid') {
    chain.method = 'uuid';
    chain.args = [quotedName];
    plan.usesUuid = true;
    plan.keyGenerated = true;
  } else if (isKey && keyKind === 'ulid') {
    chain.method = 'ulid';
    chain.args = [quotedName];
    plan.usesUlid = true;
    plan.keyGenerated = true;
  } else if (!isKey && keyKind === 'uuid' && field.default?.kind === 'uuid') {
    plan.uuidColumns.push(field.columnName);
    plan.usesUuid = true;
  }
  if (!isKey && field.isNullable) {
    chain.modifiers.push('nullable()');
  }
  if (!isKey && field.isUnique) {
    chain.modifiers.push(
      field.uniqueName === undefined
        ? 'unique()'
        : `unique(${quote(field.uniqueName)})`
    );
  }
  if (isKey) {
    chain.modifiers.push('primary()');
  } else {
    chain.modifiers.push(
      ...defaultModifiers(context, label, field, columnSpec, table.imports)
    );
  }
  if (field.isAutoUpdated) {
    context.warnings.push(
      `${label}: an auto-updated column outside the created_at / updated_at pair is only refreshed by MySQL (ON UPDATE CURRENT_TIMESTAMP); Eloquent does not maintain it.`
    );
    if (columnSpec.valueKind === 'datetime') {
      if (!chain.modifiers.includes('useCurrent()')) {
        chain.modifiers.push('useCurrent()');
      }
      chain.modifiers.push('useCurrentOnUpdate()');
    }
  }
  table.columns.push(chain);

  if (!isKey || keyKind === 'plain') {
    plan.fillable.push(field.columnName);
  }
  if (columnSpec.cast !== undefined && !(isKey && keyKind !== 'plain')) {
    plan.casts.push([field.columnName, columnSpec.cast]);
    if (columnSpec.enumDefinition !== undefined) {
      plan.imports.add(
        enumUseStatement(context, columnSpec.enumDefinition.name)
      );
    }
  }
}

function planTableIndexes(context: EmitContext, plan: ModelPlan): void {
  const model: IrModel = plan.model;
  if (plan.compositeKey !== undefined && plan.compositeKey.length > 0) {
    plan.table.constraints.push(
      `$table->primary([${plan.compositeKey.map(quote).join(', ')}])`
    );
  }
  for (const index of model.indexes) {
    const label: string = `${model.name} index (${index.fields.join(', ')})`;
    const columns: string[] = [];
    let missing: string | undefined;
    for (const name of index.fields) {
      const column: string | undefined = columnOfName(model, name);
      if (column === undefined) {
        missing = name;
        break;
      }
      columns.push(column);
    }
    if (missing !== undefined || columns.length === 0) {
      context.warnings.push(
        `${label}: "${missing ?? ''}" is not a field or relation of the model; the index was skipped.`
      );
      continue;
    }
    plan.table.constraints.push(indexStatement(index, columns));
  }
}

function indexStatement(index: IrIndex, columns: string[]): string {
  const target: string =
    columns.length === 1
      ? quote(columns[0] ?? '')
      : `[${columns.map(quote).join(', ')}]`;
  const name: string = index.name === undefined ? '' : `, ${quote(index.name)}`;
  return `$table->${index.isUnique ? 'unique' : 'index'}(${target}${name})`;
}

// ---------------------------------------------------------------------------
// Planning: relations
// ---------------------------------------------------------------------------

interface ManyToManyLink {
  owner: string;
  target: string;
  relation: IrRelation;
  table: string;
  ownerColumn: string;
  targetColumn: string;
  /** True when the table and columns are what Eloquent would pick without being told. */
  conventional: boolean;
}

function referencedField(
  target: IrModel,
  key: KeyInfo | undefined,
  toField: string | undefined
): { column: string; field: IrField | undefined } | undefined {
  if (toField !== undefined) {
    const field: IrField | undefined = target.fields.find(
      (candidate: IrField) => candidate.name === toField
    );
    return field === undefined
      ? undefined
      : { column: field.columnName, field };
  }
  return key === undefined
    ? undefined
    : { column: key.column, field: key.field };
}

function keyStyleOf(
  key: KeyInfo | undefined,
  referenced: IrField | undefined,
  toField: string | undefined
): ReferenceStyle {
  if (toField === undefined) {
    return key === undefined ? 'plain' : referenceStyle(key.kind);
  }
  return referenced !== undefined && isUuidField(referenced) ? 'uuid' : 'plain';
}

function onDeleteModifiers(action: IrOnDelete): string[] {
  switch (action) {
    case 'cascade':
      return ['cascadeOnDelete()'];
    case 'restrict':
      return ['restrictOnDelete()'];
    case 'setNull':
      return ['nullOnDelete()'];
    case 'setDefault':
      return [`onDelete('set default')`];
    default:
      return [];
  }
}

function onUpdateModifiers(action: IrOnDelete | undefined): string[] {
  switch (action) {
    case 'cascade':
      return ['cascadeOnUpdate()'];
    case 'restrict':
      return ['restrictOnUpdate()'];
    case 'setNull':
      return ['nullOnUpdate()'];
    case 'setDefault':
      return [`onUpdate('set default')`];
    case 'noAction':
      return ['noActionOnUpdate()'];
    default:
      return [];
  }
}

/** The column type a foreign key needs to match the field it references. */
function plainColumnType(
  context: EmitContext,
  label: string,
  field: IrField | undefined
): { columnType?: { method: string; args: string[] } } {
  if (field === undefined) {
    return {};
  }
  const columnSpec: ColumnSpec = columnSpecOf(context, label, {
    ...field,
    enumName: undefined,
    arrayDepth: undefined,
  });
  return { columnType: { method: columnSpec.method, args: columnSpec.args } };
}

function methodNameFor(
  context: EmitContext,
  plan: ModelPlan,
  label: string,
  rawName: string
): string {
  const base: string = identifier(
    context,
    label,
    toCamelCase(rawName) || rawName
  );
  const taken = (candidate: string): boolean =>
    plan.takenNames.has(candidate.toLowerCase()) ||
    RESERVED_METHOD_NAMES.has(candidate.toLowerCase());
  let candidate: string = base;
  if (taken(candidate)) {
    candidate = `${base}Relation`;
    let suffix: number = 2;
    while (taken(candidate)) {
      candidate = `${base}Relation${suffix}`;
      suffix += 1;
    }
    context.warnings.push(
      `${label}: "${base}" clashes with a column or an Eloquent method; the relationship method was named "${candidate}".`
    );
  }
  plan.takenNames.add(candidate.toLowerCase());
  return candidate;
}

function addMethod(
  plan: ModelPlan,
  returnType: string,
  generic: string,
  name: string,
  body: string
): void {
  plan.imports.add(`Illuminate\\Database\\Eloquent\\Relations\\${returnType}`);
  plan.methods.push([
    `${INDENT}/** @return ${returnType}<${generic}, $this> */`,
    `${INDENT}public function ${name}(): ${returnType}`,
    `${INDENT}{`,
    `${INDENT}${INDENT}return ${body};`,
    `${INDENT}}`,
  ]);
}

function planOwnedRelations(
  context: EmitContext,
  model: IrModel,
  links: ManyToManyLink[]
): void {
  const plan: ModelPlan | undefined = context.plans.get(model.name);
  if (plan === undefined) {
    return;
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
    if (relation.kind === 'manyToMany') {
      planManyToMany(context, plan, relation, target, links);
    } else {
      planToOne(context, plan, relation, target);
    }
  }
}

function planToOne(
  context: EmitContext,
  plan: ModelPlan,
  relation: IrRelation,
  target: IrModel
): void {
  const model: IrModel = plan.model;
  const label: string = `${model.name}.${relation.name}`;
  const targetPlan: ModelPlan | undefined = context.plans.get(target.name);
  if (targetPlan === undefined) {
    return;
  }
  const reference = referencedField(target, targetPlan.key, relation.toField);
  if (reference === undefined) {
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
  const isKey: boolean = relation.isPrimaryKey === true;
  const nullable: boolean = relation.isNullable && !isKey;
  plan.table.foreignKeys.push({
    column: relation.columnName,
    referencedTable: target.tableName,
    referencedColumn: reference.column,
    style: keyStyleOf(targetPlan.key, reference.field, relation.toField),
    ...plainColumnType(context, label, reference.field),
    nullable,
    unique: relation.kind === 'oneToOne' && !isKey,
    isKey,
    onDelete: relation.onDelete,
    ...(relation.onUpdate === undefined ? {} : { onUpdate: relation.onUpdate }),
    targetNode: target.name,
    deferred: false,
  });
  plan.fillable.push(relation.columnName);

  // belongsTo on the owning side.
  const methodName: string = methodNameFor(context, plan, label, relation.name);
  const targetKeyName: string = targetPlan.key?.column ?? 'id';
  const conventionalColumn: string = `${laravelSnake(methodName)}_${targetKeyName}`;
  const ownerKeyDiffers: boolean = reference.column !== targetKeyName;
  const args: string[] = [`${targetPlan.className}::class`];
  if (relation.columnName !== conventionalColumn || ownerKeyDiffers) {
    args.push(quote(relation.columnName));
  }
  if (ownerKeyDiffers) {
    args.push(quote(reference.column));
  }
  addMethod(
    plan,
    'BelongsTo',
    targetPlan.className,
    methodName,
    `$this->belongsTo(${args.join(', ')})`
  );
}

function pivotColumnNames(
  owner: ModelPlan,
  target: ModelPlan,
  ownerKey: KeyInfo,
  targetKey: KeyInfo
): { owner: string; target: string; conventional: boolean } {
  const isSelf: boolean = owner.model.name === target.model.name;
  const ownerColumn: string = `${isSelf ? 'from_' : ''}${laravelSnake(owner.className)}_${ownerKey.column}`;
  const targetColumn: string = `${isSelf ? 'to_' : ''}${laravelSnake(target.className)}_${targetKey.column}`;
  return { owner: ownerColumn, target: targetColumn, conventional: !isSelf };
}

function planManyToMany(
  context: EmitContext,
  plan: ModelPlan,
  relation: IrRelation,
  target: IrModel,
  links: ManyToManyLink[]
): void {
  const model: IrModel = plan.model;
  const label: string = `${model.name}.${relation.name}`;
  const targetPlan: ModelPlan | undefined = context.plans.get(target.name);
  if (targetPlan === undefined) {
    return;
  }
  const ownerKey: KeyInfo | undefined = plan.key;
  const targetKey: KeyInfo | undefined = targetPlan.key;
  if (ownerKey === undefined || targetKey === undefined) {
    context.warnings.push(
      `${label}: ${ownerKey === undefined ? model.name : target.name} has no single-column primary key to reference from a pivot table; the relation was skipped.`
    );
    return;
  }
  const reverse: ManyToManyLink | undefined = links.find(
    (link: ManyToManyLink) =>
      link.owner === target.name &&
      link.target === model.name &&
      (link.relation.relatedName === relation.name ||
        relation.relatedName === link.relation.name)
  );
  if (reverse !== undefined) {
    return;
  }

  const columns = pivotColumnNames(plan, targetPlan, ownerKey, targetKey);
  const sortedNames: string[] = [
    laravelSnake(plan.className),
    laravelSnake(targetPlan.className),
  ].sort();
  const conventionalTable: string = sortedNames.join('_');
  let tableName: string = context.normalize
    ? conventionalTable
    : `${model.tableName}_${relation.name}`;
  if (context.usedTables.has(tableName)) {
    tableName = `${model.tableName}_${relation.name}`;
    let suffix: number = 2;
    const base: string = tableName;
    while (context.usedTables.has(tableName)) {
      tableName = `${base}_${suffix}`;
      suffix += 1;
    }
  }
  context.usedTables.add(tableName);

  const pivot: TablePlan = newTablePlan(`pivot:${tableName}`, tableName);
  const sides: [string, KeyInfo, IrModel, string][] = [
    [columns.owner, ownerKey, model, model.name],
    [columns.target, targetKey, target, target.name],
  ];
  for (const [column, key, side, node] of sides) {
    pivot.foreignKeys.push({
      column,
      referencedTable: side.tableName,
      referencedColumn: key.column,
      style: referenceStyle(key.kind),
      ...plainColumnType(context, label, key.field),
      nullable: false,
      unique: false,
      isKey: false,
      onDelete: 'cascade',
      targetNode: node,
      deferred: false,
    });
  }
  pivot.constraints.push(
    `$table->primary([${quote(columns.owner)}, ${quote(columns.target)}])`
  );
  context.pivots.push(pivot);

  const link: ManyToManyLink = {
    owner: model.name,
    target: target.name,
    relation,
    table: tableName,
    ownerColumn: columns.owner,
    targetColumn: columns.target,
    conventional: columns.conventional && tableName === conventionalTable,
  };
  links.push(link);

  const methodName: string = methodNameFor(context, plan, label, relation.name);
  addMethod(
    plan,
    'BelongsToMany',
    targetPlan.className,
    methodName,
    `$this->belongsToMany(${belongsToManyArgs(targetPlan.className, link, false)})`
  );
}

function belongsToManyArgs(
  className: string,
  link: ManyToManyLink,
  inverse: boolean
): string {
  const args: string[] = [`${className}::class`];
  if (!link.conventional) {
    args.push(
      quote(link.table),
      quote(inverse ? link.targetColumn : link.ownerColumn),
      quote(inverse ? link.ownerColumn : link.targetColumn)
    );
  }
  return args.join(', ');
}

function planInverseRelations(
  context: EmitContext,
  model: IrModel,
  links: ManyToManyLink[]
): void {
  const ownerPlan: ModelPlan | undefined = context.plans.get(model.name);
  if (ownerPlan === undefined) {
    return;
  }
  for (const relation of model.relations) {
    const target: IrModel | undefined = findModel(
      context.schema,
      relation.targetModel
    );
    const targetPlan: ModelPlan | undefined =
      target === undefined ? undefined : context.plans.get(target.name);
    if (target === undefined || targetPlan === undefined) {
      continue;
    }
    const label: string = `${model.name}.${relation.name}`;
    if (relation.kind === 'manyToMany') {
      const link: ManyToManyLink | undefined = links.find(
        (candidate: ManyToManyLink) => candidate.relation === relation
      );
      if (link === undefined) {
        continue;
      }
      const defaultName: string = toCamelCase(
        pluralize(laravelSnake(ownerPlan.className)).value
      );
      const name: string = methodNameFor(
        context,
        targetPlan,
        label,
        relation.relatedName ?? defaultName
      );
      addMethod(
        targetPlan,
        'BelongsToMany',
        ownerPlan.className,
        name,
        `$this->belongsToMany(${belongsToManyArgs(ownerPlan.className, link, true)})`
      );
      continue;
    }
    planInverseToOne(context, ownerPlan, targetPlan, relation, label);
  }
}

function planInverseToOne(
  context: EmitContext,
  ownerPlan: ModelPlan,
  targetPlan: ModelPlan,
  relation: IrRelation,
  label: string
): void {
  const owning: ForeignKeyPlan | undefined = ownerPlan.table.foreignKeys.find(
    (candidate: ForeignKeyPlan) =>
      candidate.column === relation.columnName &&
      candidate.targetNode === targetPlan.model.name
  );
  if (owning === undefined) {
    return;
  }
  const isOne: boolean = relation.kind === 'oneToOne';
  const singular: string = toCamelCase(ownerPlan.className);
  const defaultName: string = isOne
    ? singular
    : toCamelCase(pluralize(laravelSnake(ownerPlan.className)).value);
  let rawName: string = relation.relatedName ?? defaultName;
  if (
    relation.relatedName === undefined &&
    targetPlan.takenNames.has(rawName.toLowerCase())
  ) {
    rawName = `${defaultName}As${toPascalCase(relation.name)}`;
  }
  const name: string = methodNameFor(context, targetPlan, label, rawName);
  const parentKeyName: string = targetPlan.key?.column ?? 'id';
  const conventionalColumn: string = `${laravelSnake(targetPlan.className)}_${parentKeyName}`;
  const localKeyDiffers: boolean = owning.referencedColumn !== parentKeyName;
  const args: string[] = [`${ownerPlan.className}::class`];
  if (relation.columnName !== conventionalColumn || localKeyDiffers) {
    args.push(quote(relation.columnName));
  }
  if (localKeyDiffers) {
    args.push(quote(owning.referencedColumn));
  }
  addMethod(
    targetPlan,
    isOne ? 'HasOne' : 'HasMany',
    ownerPlan.className,
    name,
    `$this->${isOne ? 'hasOne' : 'hasMany'}(${args.join(', ')})`
  );
}

/** Drops prismaOnlyWarnings lines for things this emitter does write (onUpdate actions, ULID defaults). */
function removeHandledWarnings(context: EmitContext): void {
  const handled: Set<string> = new Set<string>();
  for (const plan of context.plans.values()) {
    for (const relation of plan.model.relations) {
      if (relation.onUpdate !== undefined) {
        handled.add(
          `${plan.model.name}.${relation.name}: the onUpdate action "${relation.onUpdate}" is not supported by this format and was ignored.`
        );
      }
    }
    for (const field of plan.model.fields) {
      if (isUlidField(field)) {
        handled.add(
          `${plan.model.name}.${field.name}: the ${field.default?.kind === 'clientGenerated' ? field.default.generator : ''}() default is generated by Prisma Client and was dropped.`
        );
      }
    }
  }
  const kept: string[] = context.warnings.filter(
    (warning: string) => !handled.has(warning)
  );
  context.warnings.splice(0, context.warnings.length, ...kept);
}

// ---------------------------------------------------------------------------
// Ordering
// ---------------------------------------------------------------------------

/**
 * Orders the tables so every foreign key points at a table created earlier.
 * When a cycle blocks progress, the table with the fewest unplaced
 * dependencies goes next and the foreign keys to tables not yet created are
 * moved to a later migration (`deferred`).
 */
function orderTables(tables: TablePlan[]): TablePlan[] {
  const placed: Set<string> = new Set<string>();
  const ordered: TablePlan[] = [];
  let remaining: TablePlan[] = [...tables];
  const unplacedDependencies = (table: TablePlan): string[] => [
    ...new Set(
      table.foreignKeys
        .map((key: ForeignKeyPlan) => key.targetNode)
        .filter((node: string) => node !== table.node && !placed.has(node))
    ),
  ];
  while (remaining.length > 0) {
    let next: TablePlan | undefined = remaining.find(
      (table: TablePlan) => unplacedDependencies(table).length === 0
    );
    if (next === undefined) {
      let best: number = Number.POSITIVE_INFINITY;
      for (const table of remaining) {
        const count: number = unplacedDependencies(table).length;
        if (count < best) {
          best = count;
          next = table;
        }
      }
      if (next !== undefined) {
        for (const key of next.foreignKeys) {
          if (key.targetNode !== next.node && !placed.has(key.targetNode)) {
            key.deferred = true;
          }
        }
      }
    }
    const chosen: TablePlan | undefined = next ?? remaining[0];
    if (chosen === undefined) {
      break;
    }
    placed.add(chosen.node);
    ordered.push(chosen);
    remaining = remaining.filter((table: TablePlan) => table !== chosen);
  }
  return ordered;
}

// ---------------------------------------------------------------------------
// Rendering: migrations
// ---------------------------------------------------------------------------

function foreignKeyChain(key: ForeignKeyPlan, inline: boolean): Chain {
  const name: string = quote(key.column);
  let chain: Chain;
  switch (key.style) {
    case 'id':
      chain = { method: 'foreignId', args: [name], modifiers: [] };
      break;
    case 'uuid':
      chain = { method: 'foreignUuid', args: [name], modifiers: [] };
      break;
    case 'ulid':
      chain = { method: 'foreignUlid', args: [name], modifiers: [] };
      break;
    default:
      chain = plainReferenceChain(key);
  }
  if (key.nullable) {
    chain.modifiers.push('nullable()');
  }
  if (key.unique) {
    chain.modifiers.push('unique()');
  }
  if (key.isKey) {
    chain.modifiers.push('primary()');
  }
  if (inline && key.style !== 'plain') {
    chain.modifiers.push(
      key.referencedColumn === 'id'
        ? `constrained(${quote(key.referencedTable)})`
        : `constrained(${quote(key.referencedTable)}, ${quote(key.referencedColumn)})`,
      ...onDeleteModifiers(key.onDelete),
      ...onUpdateModifiers(key.onUpdate)
    );
  }
  return chain;
}

/** Column declaration for a foreign key whose referenced column is neither an auto-increment id nor a UUID. */
function plainReferenceChain(key: ForeignKeyPlan): Chain {
  const name: string = quote(key.column);
  const columnType: { method: string; args: string[] } = key.columnType ?? {
    method: 'string',
    args: [],
  };
  return {
    method: columnType.method,
    args: [name, ...columnType.args],
    modifiers: [],
  };
}

function foreignStatement(key: ForeignKeyPlan): string {
  const modifiers: string[] = [
    ...onDeleteModifiers(key.onDelete),
    ...onUpdateModifiers(key.onUpdate),
  ];
  return `$table->foreign(${quote(key.column)})->references(${quote(key.referencedColumn)})->on(${quote(key.referencedTable)})${modifiers
    .map((modifier: string) => `->${modifier}`)
    .join('')}`;
}

function sanitizeFileSegment(table: string): string {
  const cleaned: string = table.replace(/[^A-Za-z0-9_]+/g, '_');
  return cleaned.replace(/^_+|_+$/g, '') || 'table';
}

function renderMigrationFile(
  imports: Set<string>,
  up: string[],
  down: string[]
): string {
  const uses: string[] = [
    ...new Set([
      'Illuminate\\Database\\Migrations\\Migration',
      'Illuminate\\Database\\Schema\\Blueprint',
      'Illuminate\\Support\\Facades\\Schema',
      ...imports,
    ]),
  ].sort();
  return [
    '<?php',
    '',
    'declare(strict_types=1);',
    '',
    ...uses.map((name: string) => `use ${name};`),
    '',
    'return new class extends Migration',
    '{',
    `${INDENT}public function up(): void`,
    `${INDENT}{`,
    ...up,
    `${INDENT}}`,
    '',
    `${INDENT}public function down(): void`,
    `${INDENT}{`,
    ...down,
    `${INDENT}}`,
    '};',
    '',
  ].join('\n');
}

function renderCreate(table: TablePlan): string {
  const statements: string[] = [];
  const push = (text: string): void => {
    statements.push(...renderStatement(text, 3));
  };
  if (table.primary !== undefined) {
    push(chainText(table.primary));
  }
  for (const chain of table.columns) {
    push(chainText(chain));
  }
  for (const key of table.foreignKeys) {
    push(chainText(foreignKeyChain(key, !key.deferred)));
  }
  for (const chain of table.tail) {
    push(chainText(chain));
  }
  for (const key of table.foreignKeys) {
    if (key.style === 'plain' && !key.deferred) {
      push(foreignStatement(key));
    }
  }
  for (const constraint of table.constraints) {
    push(constraint);
  }
  const up: string[] = [
    `${INDENT}${INDENT}Schema::create(${quote(table.table)}, function (Blueprint $table): void {`,
    ...statements,
    `${INDENT}${INDENT}});`,
  ];
  const down: string[] = [
    `${INDENT}${INDENT}Schema::dropIfExists(${quote(table.table)});`,
  ];
  return renderMigrationFile(table.imports, up, down);
}

function renderForeignKeyMigration(
  table: TablePlan,
  keys: ForeignKeyPlan[]
): string {
  const up: string[] = [
    `${INDENT}${INDENT}Schema::table(${quote(table.table)}, function (Blueprint $table): void {`,
    ...keys.flatMap((key: ForeignKeyPlan) =>
      renderStatement(foreignStatement(key), 3)
    ),
    `${INDENT}${INDENT}});`,
  ];
  const down: string[] = [
    `${INDENT}${INDENT}Schema::table(${quote(table.table)}, function (Blueprint $table): void {`,
    ...keys.flatMap((key: ForeignKeyPlan) =>
      renderStatement(`$table->dropForeign([${quote(key.column)}])`, 3)
    ),
    `${INDENT}${INDENT}});`,
  ];
  return renderMigrationFile(new Set<string>(), up, down);
}

function renderMigrations(context: EmitContext): Record<string, string> {
  const tables: TablePlan[] = [
    ...context.schema.models.flatMap((model: IrModel): TablePlan[] => {
      const plan: ModelPlan | undefined = context.plans.get(model.name);
      return plan === undefined ? [] : [plan.table];
    }),
    ...context.pivots,
  ];
  const ordered: TablePlan[] = orderTables(tables);
  const files: Record<string, string> = {};
  let counter: number = 0;
  const filename = (name: string): string => {
    counter += 1;
    return `${MIGRATION_DIRECTORY}/${MIGRATION_DATE_PREFIX}_${String(counter).padStart(6, '0')}_${name}.php`;
  };
  for (const table of ordered) {
    files[filename(`create_${sanitizeFileSegment(table.table)}_table`)] =
      renderCreate(table);
  }
  for (const table of ordered) {
    const deferred: ForeignKeyPlan[] = table.foreignKeys.filter(
      (key: ForeignKeyPlan) => key.deferred
    );
    if (deferred.length > 0) {
      files[
        filename(
          `add_foreign_keys_to_${sanitizeFileSegment(table.table)}_table`
        )
      ] = renderForeignKeyMigration(table, deferred);
    }
  }
  return files;
}

// ---------------------------------------------------------------------------
// Rendering: enums and models
// ---------------------------------------------------------------------------

function renderEnum(context: EmitContext, enumDefinition: IrEnum): string {
  const name: string = context.enumNames.get(enumDefinition.name) ?? '';
  const used: Set<string> = new Set<string>();
  const cases: string[] = enumDefinition.values.map(
    (value: IrEnumValue): string => {
      const caseName: string = uniqueName(
        enumCaseName(context, value),
        used,
        false
      );
      return `${INDENT}case ${caseName} = ${quote(value.dbValue)};`;
    }
  );
  return [
    '<?php',
    '',
    'declare(strict_types=1);',
    '',
    `namespace ${context.enumNamespace};`,
    '',
    `enum ${name}: string`,
    '{',
    ...cases,
    '}',
    '',
  ].join('\n');
}

function renderModel(context: EmitContext, plan: ModelPlan): string {
  const model: IrModel = plan.model;
  const traits: string[] = [];
  if (plan.hasSoftDeletes) {
    traits.push('SoftDeletes');
  }
  if (plan.usesUlid) {
    traits.push('HasUlids');
    plan.imports.add('Illuminate\\Database\\Eloquent\\Concerns\\HasUlids');
  } else if (plan.usesUuid) {
    traits.push('HasUuids');
    plan.imports.add('Illuminate\\Database\\Eloquent\\Concerns\\HasUuids');
  }
  const blocks: string[][] = [];
  if (traits.length > 0) {
    blocks.push([`${INDENT}use ${traits.join(', ')};`]);
  }

  const conventional: Plural = conventionalTable(plan.className);
  if (!(conventional.certain && conventional.value === model.tableName)) {
    blocks.push([`${INDENT}protected $table = ${quote(model.tableName)};`]);
  }
  const key: KeyInfo | undefined = plan.key;
  const compositeFirst: string | undefined = plan.compositeKey?.[0];
  if (key === undefined && compositeFirst === undefined) {
    blocks.push([`${INDENT}protected $primaryKey = null;`]);
    blocks.push([`${INDENT}public $incrementing = false;`]);
  } else if (key === undefined) {
    blocks.push([
      `${INDENT}protected $primaryKey = ${quote(compositeFirst ?? 'id')};`,
    ]);
    blocks.push([`${INDENT}public $incrementing = false;`]);
  } else {
    if (key.column !== 'id') {
      blocks.push([`${INDENT}protected $primaryKey = ${quote(key.column)};`]);
    }
    if (key.kind !== 'increments' && !plan.keyGenerated) {
      const stringKey: boolean =
        key.kind === 'uuid' || key.kind === 'ulid' || isStringKey(key);
      if (stringKey) {
        blocks.push([`${INDENT}protected $keyType = 'string';`]);
      }
      blocks.push([`${INDENT}public $incrementing = false;`]);
    }
  }
  if (!plan.hasTimestamps) {
    blocks.push([`${INDENT}public $timestamps = false;`]);
  }
  blocks.push([
    `${INDENT}/** @var list<string> */`,
    ...listProperty('fillable', plan.fillable.map(quote)),
  ]);
  if (plan.casts.length > 0) {
    blocks.push([
      `${INDENT}/** @var array<string, string> */`,
      `${INDENT}protected $casts = [`,
      ...plan.casts.map(
        ([column, cast]: [string, string]) =>
          `${INDENT}${INDENT}${quote(column)} => ${cast},`
      ),
      `${INDENT}];`,
    ]);
  }
  if (plan.usesUuid && plan.uuidColumns.length > 0) {
    const columns: string[] = [
      ...(key?.kind === 'uuid' ? [key.column] : []),
      ...plan.uuidColumns,
    ];
    blocks.push([
      `${INDENT}/** @return list<string> */`,
      `${INDENT}public function uniqueIds(): array`,
      `${INDENT}{`,
      `${INDENT}${INDENT}return [${columns.map(quote).join(', ')}];`,
      `${INDENT}}`,
    ]);
  }
  blocks.push(...plan.methods);

  const imports: string[] = [...plan.imports].sort();
  const namespaceLine: string = `namespace ${context.modelNamespace};`;
  return [
    '<?php',
    '',
    'declare(strict_types=1);',
    '',
    namespaceLine,
    '',
    ...imports.map((name: string) => `use ${name};`),
    ...(imports.length > 0 ? [''] : []),
    `class ${plan.className} extends Model`,
    '{',
    blocks.map((block: string[]) => block.join('\n')).join('\n\n'),
    '}',
    '',
  ].join('\n');
}

function isStringKey(key: KeyInfo): boolean {
  const type: IrField['type'] | undefined = key.field?.type;
  return type === 'string' || type === 'text' || type === 'uuid';
}

function listProperty(name: string, items: string[]): string[] {
  if (items.length === 0) {
    return [`${INDENT}protected $${name} = [];`];
  }
  return [
    `${INDENT}protected $${name} = [`,
    ...items.map((item: string) => `${INDENT}${INDENT}${item},`),
    `${INDENT}];`,
  ];
}
