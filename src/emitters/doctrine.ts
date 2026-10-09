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
import {
  singularize,
  toCamelCase,
  toPascalCase,
  toSnakeCase,
} from '../naming.js';
import type { PrismaProvider } from './prisma.js';

/**
 * Doctrine ORM emitter (PHP 8.1+ attributes). Writes one PSR-4 file per entity
 * (`src/Entity/Post.php`) and one per backed enum (`src/Enum/PostStatus.php`),
 * so it returns the multi-file form of the emit contract.
 */
export interface DoctrineEmitOptions {
  /** Database provider; chooses timezone-aware date types and JSONB on PostgreSQL. */
  provider: PrismaProvider;
  /** Use camelCase property names and map them to the original column names. */
  camelFields: boolean;
  /** PHP namespace of the entities (default `App\Entity`). Enums go in the sibling `Enum` namespace. */
  namespace?: string;
}

export const DEFAULT_DOCTRINE_NAMESPACE: string = 'App\\Entity';

const NAMESPACE_PATTERN: RegExp =
  /^[A-Za-z_][A-Za-z0-9_]*(\\[A-Za-z_][A-Za-z0-9_]*)*$/;
const IDENTIFIER_PATTERN: RegExp = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_LINE_WIDTH: number = 100;
const INDENT: string = '    ';

/** True when `value` is a valid PHP namespace such as `App\Entity` (no leading or trailing backslash). */
export function isValidPhpNamespace(value: string): boolean {
  return NAMESPACE_PATTERN.test(value);
}

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
    'void arraycollection collection dateinterval datetimeimmutable orm',
  ]
    .join(' ')
    .split(' ')
    .map((name: string) => name.toLowerCase())
);

const ON_DELETE_NAMES: Readonly<Record<IrOnDelete, string>> = {
  cascade: 'CASCADE',
  setNull: 'SET NULL',
  restrict: 'RESTRICT',
  noAction: 'NO ACTION',
  setDefault: 'SET DEFAULT',
};

type Dialect = 'postgres' | 'mysql' | 'sqlite' | 'sqlserver';

/** How a default value is written in PHP. */
type ValueKind =
  | 'string'
  | 'int'
  | 'float'
  | 'bool'
  | 'date'
  | 'json'
  | 'array'
  | 'enum'
  | 'other';

interface ColumnSpec {
  /** `type:`, `length:`, `precision:`, `scale:` and `enumType:` entries. */
  entries: string[];
  /** PHP type without the nullable marker, e.g. `int` or `DateTimeImmutable`. */
  phpType: string;
  valueKind: ValueKind;
  /** Names to import (global classes such as DateTimeImmutable, or the local enum name). */
  imports: string[];
  /** Local name of the enum class when the column is enum-backed. */
  enumClass?: string;
  /** The IR enum behind an enum-backed column. */
  enumDefinition?: IrEnum;
}

interface DefaultSpec {
  /** Property initializer expression, e.g. `0` or `PostStatus::DRAFT`. */
  initializer?: string;
  /** Statement for the constructor, without indentation. */
  constructorLine?: string;
  /** PHP literal for `options: ['default' => ...]`. */
  databaseValue?: string;
}

type PropRole =
  'column' | 'owningToOne' | 'inverseToOne' | 'inverseToMany' | 'manyToMany';

interface PropPlan {
  /** PHP property name (without `$`). */
  name: string;
  role: PropRole;
  /** True when the property can hold null. */
  nullable: boolean;
  /** Declared type including the nullable marker, e.g. `?int`. */
  phpType: string;
  /** Docblock type for collections, e.g. `Collection<int, Post>`. */
  docType?: string;
  /** Local class name of the associated entity. */
  element?: string;
  initializer?: string;
  getter: string;
  setter?: string;
  adder?: string;
  remover?: string;
  /** Singular parameter name used by `add*` and `remove*`. */
  elementParam?: string;
  /** The property on the other side of the association. */
  peer?: PropPlan;
  /** Builds the attributes (each entry may span lines) once every name is known. */
  attributes: () => string[][];
}

interface ClassPlan {
  model: IrModel;
  className: string;
  props: PropPlan[];
  propNames: Set<string>;
  methodNames: Set<string>;
  /** "f:<field>", "r:<relation>" and "i:<Model>.<relation>" to the property that implements them. */
  byKey: Map<string, PropPlan>;
  imports: Set<string>;
  constructorLines: string[];
  /** Property names refreshed on every save (Django auto_now, Prisma @updatedAt). */
  autoUpdated: string[];
  usesUuid: boolean;
}

interface EmitContext {
  schema: IrSchema;
  options: DoctrineEmitOptions;
  dialect: Dialect;
  warnings: string[];
  entityNamespace: string;
  enumNamespace: string;
  /** IR model name to PHP class name. */
  classNames: Map<string, string>;
  /** IR enum name to PHP enum name. */
  enumNames: Map<string, string>;
  classes: Map<string, ClassPlan>;
}

export function emitDoctrine(
  schema: IrSchema,
  options: DoctrineEmitOptions
): MultiFileEmitOutput {
  const warnings: string[] = prismaOnlyWarnings(schema);
  let entityNamespace: string = DEFAULT_DOCTRINE_NAMESPACE;
  if (options.namespace !== undefined) {
    const requested: string = options.namespace.replace(/^\\+|\\+$/g, '');
    if (isValidPhpNamespace(requested)) {
      entityNamespace = requested;
    } else {
      warnings.push(
        `The namespace "${options.namespace}" is not a valid PHP namespace; "${DEFAULT_DOCTRINE_NAMESPACE}" was used instead.`
      );
    }
  }
  const context: EmitContext = {
    schema,
    options,
    dialect: dialectOf(options.provider),
    warnings,
    entityNamespace,
    enumNamespace: siblingEnumNamespace(entityNamespace),
    classNames: new Map<string, string>(),
    enumNames: new Map<string, string>(),
    classes: new Map<string, ClassPlan>(),
  };
  if (options.provider === 'mongodb') {
    warnings.push(
      'Provider "mongodb": Doctrine ORM is relational (use Doctrine MongoDB ODM for MongoDB); relational entity mappings were written.'
    );
  }

  allocateClassNames(context);
  for (const model of schema.models) {
    planClass(context, model);
  }
  for (const model of schema.models) {
    planInverseSides(context, model);
  }

  const files: Record<string, string> = {};
  for (const enumDefinition of schema.enums) {
    files[enumPath(context, enumDefinition)] = renderEnum(
      context,
      enumDefinition
    );
  }
  for (const model of schema.models) {
    const plan: ClassPlan | undefined = context.classes.get(model.name);
    if (plan !== undefined) {
      files[entityPath(context, plan)] = renderClass(context, plan);
    }
  }
  return { files, warnings };
}

// ---------------------------------------------------------------------------
// Namespaces and paths
// ---------------------------------------------------------------------------

function siblingEnumNamespace(entityNamespace: string): string {
  const segments: string[] = entityNamespace.split('\\');
  if (segments.length > 1 && segments[segments.length - 1] === 'Entity') {
    segments[segments.length - 1] = 'Enum';
    return segments.join('\\');
  }
  return `${entityNamespace}\\Enum`;
}

/** PSR-4 directory for a namespace: the first segment maps to `src/`, the rest to folders. */
function namespaceDirectory(namespace: string): string {
  const segments: string[] = namespace.split('\\').slice(1);
  return ['src', ...segments].join('/');
}

function entityPath(context: EmitContext, plan: ClassPlan): string {
  return `${namespaceDirectory(context.entityNamespace)}/${plan.className}.php`;
}

function enumPath(context: EmitContext, enumDefinition: IrEnum): string {
  const name: string = context.enumNames.get(enumDefinition.name) ?? '';
  return `${namespaceDirectory(context.enumNamespace)}/${name}.php`;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function dialectOf(provider: PrismaProvider): Dialect {
  switch (provider) {
    case 'mysql':
      return 'mysql';
    case 'sqlite':
      return 'sqlite';
    case 'sqlserver':
      return 'sqlserver';
    default:
      return 'postgres';
  }
}

/** Single-quoted PHP string. */
function quote(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

/** Words that are reserved on at least one of PostgreSQL, MySQL, SQL Server and SQLite. */
const RESERVED_SQL_NAMES: ReadonlySet<string> = new Set(
  [
    'all alter and any as asc between by',
    'case check column constraint create cross current_date current_time',
    'current_timestamp current_user default delete desc distinct drop else',
    'end exists false for foreign from full grant',
    'group having in index inner insert into is',
    'join key left like limit not null offset',
    'on or order outer primary references right select',
    'session_user set table then to true union unique',
    'update user using values when where with',
  ]
    .join(' ')
    .split(' ')
);

/**
 * Quotes a database identifier with backticks (Doctrine's portable quoting)
 * when it is a reserved SQL word such as a table named "user" or "order".
 */
function sqlIdentifier(name: string): string {
  return RESERVED_SQL_NAMES.has(name.toLowerCase()) ? `\`${name}\`` : name;
}

/** A database identifier as a PHP string literal. */
function dbName(name: string): string {
  return quote(sqlIdentifier(name));
}

function uniqueName(
  baseName: string,
  used: Set<string>,
  caseInsensitive: boolean = false
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

function propertyName(context: EmitContext, rawName: string): string {
  return context.options.camelFields ? toCamelCase(rawName) : rawName;
}

function isKeyedRelation(model: IrModel, relation: IrRelation): boolean {
  return (
    relation.isPrimaryKey === true ||
    (model.compositePrimaryKey?.includes(relation.name) ?? false)
  );
}

/**
 * Formats an attribute. Arguments stay on one line when they fit and wrap one
 * per line otherwise.
 */
function attribute(name: string, args: string[]): string[] {
  const inline: string = `#[ORM\\${name}${
    args.length === 0 ? '' : `(${args.join(', ')})`
  }]`;
  if (args.length === 0 || INDENT.length + inline.length <= MAX_LINE_WIDTH) {
    return [inline];
  }
  return [
    `#[ORM\\${name}(`,
    ...args.map((arg: string) => `${INDENT}${arg},`),
    ')]',
  ];
}

function methodWords(propName: string): string {
  const pascal: string = toPascalCase(propName);
  return pascal === '' ? 'Value' : pascal;
}

function parameterName(propName: string): string {
  const camel: string = toCamelCase(propName);
  if (!IDENTIFIER_PATTERN.test(camel) || camel === 'this') {
    return 'value';
  }
  return camel;
}

function phpFloat(value: number): string {
  const text: string = String(value);
  return /[.eE]/.test(text) ? text : `${text}.0`;
}

/** Renders a parsed JSON value as a PHP literal (short array syntax). */
function phpLiteral(value: unknown): string {
  if (value === null || value === undefined) {
    return 'null';
  }
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }
  if (typeof value === 'number') {
    return Number.isInteger(value) ? String(value) : phpFloat(value);
  }
  if (typeof value === 'string') {
    return quote(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(phpLiteral).join(', ')}]`;
  }
  if (typeof value === 'object') {
    const entries: string[] = Object.entries(
      value as Record<string, unknown>
    ).map(
      ([key, entry]: [string, unknown]) =>
        `${quote(key)} => ${phpLiteral(entry)}`
    );
    return `[${entries.join(', ')}]`;
  }
  return 'null';
}

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

function allocateClassNames(context: EmitContext): void {
  const used: Set<string> = new Set<string>();
  for (const model of context.schema.models) {
    let base: string = model.name;
    if (!IDENTIFIER_PATTERN.test(base)) {
      base = identifier(context, model.name, toPascalCase(model.name));
    }
    if (RESERVED_CLASS_NAMES.has(base.toLowerCase())) {
      const renamed: string = `${base}Entity`;
      context.warnings.push(
        `${model.name}: "${base}" cannot be used as a PHP class name; the class was named "${renamed}".`
      );
      base = renamed;
    }
    context.classNames.set(model.name, uniqueName(base, used, true));
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
    context.enumNames.set(
      enumDefinition.name,
      uniqueName(base, new Set<string>(), true)
    );
  }
}

function classNameOf(context: EmitContext, modelName: string): string {
  return context.classNames.get(modelName) ?? modelName;
}

/** Local name of an enum inside an entity file; aliased when an entity has the same name. */
function enumLocalName(context: EmitContext, enumName: string): string {
  const phpName: string = context.enumNames.get(enumName) ?? enumName;
  const clashes: boolean = [...context.classNames.values()].some(
    (className: string) => className.toLowerCase() === phpName.toLowerCase()
  );
  return clashes ? `${phpName}Enum` : phpName;
}

function useStatementFor(context: EmitContext, localName: string): string {
  for (const [irName, phpName] of context.enumNames) {
    const alias: string = enumLocalName(context, irName);
    if (alias === localName) {
      return alias === phpName
        ? `${context.enumNamespace}\\${phpName}`
        : `${context.enumNamespace}\\${phpName} as ${alias}`;
    }
  }
  return localName;
}

// ---------------------------------------------------------------------------
// Column types
// ---------------------------------------------------------------------------

function findEnum(context: EmitContext, name: string): IrEnum | undefined {
  return context.schema.enums.find(
    (candidate: IrEnum) => candidate.name === name
  );
}

function plain(
  type: string,
  phpType: string,
  valueKind: ValueKind,
  extra: string[] = [],
  imports: string[] = []
): ColumnSpec {
  return {
    entries: [`type: ${quote(type)}`, ...extra],
    phpType,
    valueKind,
    imports,
  };
}

function columnSpecOf(
  context: EmitContext,
  label: string,
  field: IrField
): ColumnSpec {
  if ((field.arrayDepth ?? 0) > 0) {
    context.warnings.push(
      `${label}: Doctrine has no array column type that works on every platform; the array was written as a json column (PHP array).`
    );
    return plain('json', 'array', 'array');
  }
  return scalarColumnSpec(context, label, field);
}

function scalarColumnSpec(
  context: EmitContext,
  label: string,
  field: IrField
): ColumnSpec {
  const dialect: Dialect = context.dialect;
  const lengthEntry: string[] =
    field.maxLength === undefined ? [] : [`length: ${field.maxLength}`];

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
      const local: string = enumLocalName(context, enumDefinition.name);
      return {
        entries: [
          `type: 'string'`,
          ...lengthEntry,
          `enumType: ${local}::class`,
        ],
        phpType: local,
        valueKind: 'enum',
        imports: [local],
        enumClass: local,
        enumDefinition,
      };
    }
  }

  switch (field.type) {
    case 'string':
      return plain('string', 'string', 'string', lengthEntry);
    case 'text':
      return plain('text', 'string', 'string');
    case 'uuid':
      return plain('guid', 'string', 'string');
    case 'int':
      return plain('integer', 'int', 'int');
    case 'bigInt':
      return plain('bigint', 'string', 'string');
    case 'float':
      return plain('float', 'float', 'float');
    case 'decimal': {
      const extra: string[] = [];
      if (field.maxDigits !== undefined && field.decimalPlaces !== undefined) {
        extra.push(
          `precision: ${field.maxDigits}`,
          `scale: ${field.decimalPlaces}`
        );
      }
      return plain('decimal', 'string', 'string', extra);
    }
    case 'boolean':
      return plain('boolean', 'bool', 'bool');
    case 'dateTime':
      return plain(
        dialect === 'postgres' || dialect === 'sqlserver'
          ? 'datetimetz_immutable'
          : 'datetime_immutable',
        'DateTimeImmutable',
        'date',
        [],
        ['DateTimeImmutable']
      );
    case 'date':
      return plain(
        'date_immutable',
        'DateTimeImmutable',
        'date',
        [],
        ['DateTimeImmutable']
      );
    case 'time':
      return plain(
        'time_immutable',
        'DateTimeImmutable',
        'date',
        [],
        ['DateTimeImmutable']
      );
    case 'json':
      return plain('json', 'mixed', 'json');
    case 'bytes':
      return plain('blob', 'mixed', 'other');
    case 'duration':
      context.warnings.push(
        `${label}: Doctrine has no database interval type; the duration was written as a dateinterval column (an ISO 8601 string such as P1DT2H), so the stored values differ from the source column.`
      );
      return plain(
        'dateinterval',
        'DateInterval',
        'other',
        [],
        ['DateInterval']
      );
    case 'ipAddress':
      return plain('string', 'string', 'string', ['length: 45']);
    case 'hstore':
      context.warnings.push(
        `${label}: Doctrine has no hstore type; the field was written as a json column (PHP array).`
      );
      return plain('json', 'array', 'array');
    case 'range':
      context.warnings.push(
        `${label}: Doctrine has no range column type; the field was written as a string column holding the range text.`
      );
      return plain('string', 'string', 'string');
    case 'unsupported':
      return plain('string', 'string', 'string');
    default:
      context.warnings.push(
        `${label}: unknown field type "${String(field.type)}"; it was written as a string column.`
      );
      return plain('string', 'string', 'string');
  }
}

/** Finds the enum case a default refers to, by case name or stored value. */
function enumCaseReference(
  context: EmitContext,
  spec: ColumnSpec,
  raw: string
): { reference: string; value: string } | undefined {
  const definition: IrEnum | undefined = spec.enumDefinition;
  if (definition === undefined || spec.enumClass === undefined) {
    return undefined;
  }
  const match: IrEnumValue | undefined =
    definition.values.find(
      (candidate: IrEnumValue) => candidate.name === raw
    ) ??
    definition.values.find(
      (candidate: IrEnumValue) => candidate.dbValue === raw
    );
  if (match === undefined) {
    return undefined;
  }
  return {
    reference: `${spec.enumClass}::${enumCaseName(context, definition, match)}`,
    value: match.dbValue,
  };
}

function enumCaseName(
  context: EmitContext,
  definition: IrEnum,
  value: IrEnumValue
): string {
  return identifier({ ...context, warnings: [] }, '', value.name);
}

/** Works out how a field's default is written as an initializer, constructor statement and column option. */
function defaultOf(
  context: EmitContext,
  label: string,
  field: IrField,
  spec: ColumnSpec,
  property: string,
  plan: ClassPlan
): DefaultSpec {
  const defaultValue: IrDefault | undefined = field.default;
  if (defaultValue === undefined) {
    return {};
  }
  switch (defaultValue.kind) {
    case 'autoIncrement':
      context.warnings.push(
        `${label}: an auto-increment default is only supported on primary keys; it was dropped.`
      );
      return {};
    case 'now':
      if (spec.valueKind !== 'date') {
        context.warnings.push(
          `${label}: a "now" default needs a date or time column; it was dropped.`
        );
        return {};
      }
      plan.imports.add('DateTimeImmutable');
      return {
        constructorLine: `$this->${property} = new DateTimeImmutable();`,
        databaseValue: quote('CURRENT_TIMESTAMP'),
      };
    case 'uuid':
      if (spec.valueKind !== 'string') {
        context.warnings.push(
          `${label}: a UUID default needs a string or uuid column; it was dropped.`
        );
        return {};
      }
      plan.usesUuid = true;
      return { constructorLine: `$this->${property} = self::generateUuid();` };
    case 'enumValue': {
      const found = enumCaseReference(context, spec, defaultValue.value);
      if (found === undefined) {
        context.warnings.push(
          `${label}: the enum default "${defaultValue.value}" does not match a case of the enum; it was dropped.`
        );
        return {};
      }
      return {
        initializer: found.reference,
        databaseValue: quote(found.value),
      };
    }
    case 'literal':
      return literalDefault(
        context,
        label,
        field,
        spec,
        defaultValue.value,
        property,
        plan
      );
    default:
      // clientGenerated and dbExpression defaults are reported by prismaOnlyWarnings.
      return {};
  }
}

function literalDefault(
  context: EmitContext,
  label: string,
  field: IrField,
  spec: ColumnSpec,
  value: string | number | boolean,
  property: string,
  plan: ClassPlan
): DefaultSpec {
  switch (spec.valueKind) {
    case 'enum': {
      const found = enumCaseReference(context, spec, String(value));
      if (found === undefined) {
        context.warnings.push(
          `${label}: the enum default "${String(value)}" does not match a case of the enum; it was dropped.`
        );
        return {};
      }
      return {
        initializer: found.reference,
        databaseValue: quote(found.value),
      };
    }
    case 'bool': {
      const text: string =
        value === true || value === 'true' ? 'true' : 'false';
      return { initializer: text, databaseValue: text };
    }
    case 'int': {
      const text: string = String(Math.trunc(Number(value)));
      return { initializer: text, databaseValue: text };
    }
    case 'float': {
      const text: string = phpFloat(Number(value));
      return { initializer: text, databaseValue: text };
    }
    case 'string':
      return {
        initializer: quote(String(value)),
        databaseValue: quote(String(value)),
      };
    case 'date':
      if (typeof value !== 'string') {
        return {};
      }
      plan.imports.add('DateTimeImmutable');
      return {
        constructorLine: `$this->${property} = new DateTimeImmutable(${quote(value)});`,
        databaseValue: quote(value),
      };
    case 'json':
    case 'array': {
      if (typeof value !== 'string') {
        return { initializer: phpLiteral(value) };
      }
      try {
        return { initializer: phpLiteral(JSON.parse(value) as unknown) };
      } catch {
        context.warnings.push(
          `${label}: the default ${quote(value)} is not valid JSON and was dropped.`
        );
        return {};
      }
    }
    default:
      context.warnings.push(
        `${label}: a literal default on a ${field.type} column cannot be represented; it was dropped.`
      );
      return {};
  }
}

// ---------------------------------------------------------------------------
// Planning: classes, fields, relations
// ---------------------------------------------------------------------------

function newPlan(context: EmitContext, model: IrModel): ClassPlan {
  const plan: ClassPlan = {
    model,
    className: classNameOf(context, model.name),
    props: [],
    propNames: new Set<string>(),
    methodNames: new Set<string>(['__construct', 'generateuuid']),
    byKey: new Map<string, PropPlan>(),
    imports: new Set<string>(['Doctrine\\ORM\\Mapping as ORM']),
    constructorLines: [],
    autoUpdated: [],
    usesUuid: false,
  };
  context.classes.set(model.name, plan);
  return plan;
}

function addProp(plan: ClassPlan, key: string, prop: PropPlan): void {
  plan.props.push(prop);
  plan.byKey.set(key, prop);
}

function allocateAccessors(
  plan: ClassPlan,
  propName: string,
  isBool: boolean
): { getter: string; setter: string } {
  const words: string = methodWords(propName);
  let getterBase: string = `get${words}`;
  if (isBool) {
    getterBase = /^(Is|Has|Can|Should|Was|Did)[A-Z]/.test(words)
      ? `${words.charAt(0).toLowerCase()}${words.slice(1)}`
      : `is${words}`;
  }
  return {
    getter: uniqueName(getterBase, plan.methodNames, true),
    setter: uniqueName(`set${words}`, plan.methodNames, true),
  };
}

function isGeneratedKey(model: IrModel, field: IrField): boolean {
  const inComposite: boolean =
    model.compositePrimaryKey?.includes(field.name) ?? false;
  return (
    field.isPrimaryKey &&
    !inComposite &&
    field.default?.kind === 'autoIncrement' &&
    (field.type === 'int' || field.type === 'bigInt')
  );
}

function planClass(context: EmitContext, model: IrModel): void {
  const plan: ClassPlan = newPlan(context, model);

  const hasPrimaryKey: boolean =
    model.fields.some((field: IrField) => field.isPrimaryKey) ||
    model.relations.some(
      (relation: IrRelation) => relation.isPrimaryKey === true
    ) ||
    (model.compositePrimaryKey !== undefined &&
      model.compositePrimaryKey.length > 0);
  if (!hasPrimaryKey) {
    context.warnings.push(
      `${model.name}: the model has no primary key; Doctrine requires at least one #[ORM\\Id] property.`
    );
  }

  for (const field of model.fields) {
    planField(context, plan, field);
  }
  for (const relation of model.relations) {
    const target: IrModel | undefined = findModel(
      context.schema,
      relation.targetModel
    );
    const label: string = `${model.name}.${relation.name}`;
    if (target === undefined) {
      context.warnings.push(
        `${label}: target model "${relation.targetModel}" does not exist in the schema; the relation was skipped.`
      );
      continue;
    }
    if (relation.kind === 'manyToMany') {
      planManyToMany(context, plan, relation, target);
    } else {
      planToOne(context, plan, relation, target);
    }
  }
}

function planField(
  context: EmitContext,
  plan: ClassPlan,
  field: IrField
): void {
  const model: IrModel = plan.model;
  const label: string = `${model.name}.${field.name}`;
  const name: string = uniqueName(
    identifier(context, label, propertyName(context, field.name)),
    plan.propNames
  );
  const spec: ColumnSpec = columnSpecOf(context, label, field);
  for (const imported of spec.imports) {
    plan.imports.add(
      spec.enumClass === imported
        ? useStatementFor(context, imported)
        : imported
    );
  }
  if (field.generated !== undefined) {
    context.warnings.push(
      `${label}: the generated column expression ${field.generated.expression} is Python, not SQL, and has no Doctrine equivalent; the property was written as a regular column.`
    );
  }
  if (field.isAutoUpdated && spec.valueKind !== 'date') {
    context.warnings.push(
      `${label}: an auto-updated field must be a date or time column; it was written as a plain column.`
    );
  }

  const inComposite: boolean =
    model.compositePrimaryKey?.includes(field.name) ?? false;
  const isKey: boolean = field.isPrimaryKey || inComposite;
  const generatedKey: boolean = isGeneratedKey(model, field);
  const defaults: DefaultSpec = generatedKey
    ? {}
    : defaultOf(context, label, field, spec, name, plan);
  if (defaults.constructorLine !== undefined) {
    plan.constructorLines.push(defaults.constructorLine);
  }
  if (field.isAutoUpdated && spec.valueKind === 'date') {
    plan.autoUpdated.push(name);
  }

  const nullable: boolean = field.isNullable || generatedKey;
  const canBeNull: boolean = spec.phpType !== 'mixed' && nullable;
  const phpType: string = `${canBeNull ? '?' : ''}${spec.phpType}`;
  let initializer: string | undefined = defaults.initializer;
  if (initializer === undefined && nullable && spec.phpType !== 'mixed') {
    initializer = 'null';
  } else if (
    initializer === undefined &&
    field.isNullable &&
    spec.phpType === 'mixed'
  ) {
    initializer = 'null';
  }

  const accessors = allocateAccessors(plan, name, spec.phpType === 'bool');
  const nameOption: string = `name: ${dbName(field.columnName)}`;

  const attributes = (): string[][] => {
    const result: string[][] = [];
    if (isKey) {
      result.push(attribute('Id', []));
    }
    if (generatedKey) {
      result.push(attribute('GeneratedValue', [`strategy: 'AUTO'`]));
    }
    const entries: string[] = [];
    entries.push(nameOption, ...spec.entries);
    if (!isKey && field.isNullable) {
      entries.push('nullable: true');
    }
    if (!isKey && field.isUnique) {
      entries.push('unique: true');
    }
    const options: string[] = [];
    if (defaults.databaseValue !== undefined) {
      options.push(`'default' => ${defaults.databaseValue}`);
    }
    if (
      field.type === 'json' &&
      context.dialect === 'postgres' &&
      (field.arrayDepth ?? 0) === 0
    ) {
      options.push(`'jsonb' => true`);
    }
    if (options.length > 0) {
      entries.push(`options: [${options.join(', ')}]`);
    }
    result.push(attribute('Column', entries));
    return result;
  };

  addProp(plan, `f:${field.name}`, {
    name,
    role: 'column',
    nullable: canBeNull,
    phpType,
    ...(initializer === undefined ? {} : { initializer }),
    getter: accessors.getter,
    ...(generatedKey ? {} : { setter: accessors.setter }),
    attributes,
  });
  if (generatedKey) {
    plan.methodNames.delete(accessors.setter.toLowerCase());
  }
}

/** Column name of the key a relation points at: an explicit `toField`, otherwise the primary key. */
function referencedColumn(
  context: EmitContext,
  target: IrModel,
  toField: string | undefined,
  depth: number = 0
): string | undefined {
  if (depth > 5) {
    return undefined;
  }
  const explicit: IrField | undefined =
    toField === undefined
      ? undefined
      : target.fields.find((field: IrField) => field.name === toField);
  if (explicit !== undefined) {
    return explicit.columnName;
  }
  const keys: IrField[] = target.fields.filter(
    (field: IrField) => field.isPrimaryKey
  );
  if (keys.length === 1 && (target.compositePrimaryKey?.length ?? 0) === 0) {
    return keys[0]?.columnName;
  }
  if (keys.length > 1 || (target.compositePrimaryKey?.length ?? 0) > 1) {
    return undefined;
  }
  const primaryRelation: IrRelation | undefined = target.relations.find(
    (relation: IrRelation) => relation.isPrimaryKey === true
  );
  if (primaryRelation !== undefined) {
    return primaryRelation.columnName;
  }
  return undefined;
}

function planToOne(
  context: EmitContext,
  plan: ClassPlan,
  relation: IrRelation,
  target: IrModel
): void {
  const model: IrModel = plan.model;
  const label: string = `${model.name}.${relation.name}`;
  const referenced: string | undefined = referencedColumn(
    context,
    target,
    relation.toField
  );
  if (referenced === undefined) {
    context.warnings.push(
      `${label}: target model "${target.name}" has no single-column primary key to reference; the relation was skipped.`
    );
    return;
  }
  const explicitTarget: IrField | undefined =
    relation.toField === undefined
      ? undefined
      : target.fields.find(
          (candidate: IrField) => candidate.name === relation.toField
        );
  if (explicitTarget !== undefined && !explicitTarget.isPrimaryKey) {
    context.warnings.push(
      `${label}: the relation references ${target.name}.${explicitTarget.name}, which is not a primary key; the foreign key is written as-is, but Doctrine's schema validator (orm:validate-schema) rejects referenced columns that are not primary keys.`
    );
  }
  if (relation.onDelete === 'setNull' && !relation.isNullable) {
    context.warnings.push(
      `${label}: onDelete SET NULL on a required relation will fail at the database level; review the relation.`
    );
  }
  const name: string = uniqueName(
    identifier(context, label, propertyName(context, relation.name)),
    plan.propNames
  );
  const element: string = classNameOf(context, target.name);
  const accessors = allocateAccessors(plan, name, false);
  const keyed: boolean = isKeyedRelation(model, relation);
  const nullable: boolean = relation.isNullable && !keyed;

  const prop: PropPlan = {
    name,
    role: 'owningToOne',
    nullable,
    phpType: `${nullable ? '?' : ''}${element}`,
    ...(nullable ? { initializer: 'null' } : {}),
    element,
    getter: accessors.getter,
    setter: accessors.setter,
    attributes: (): string[][] => {
      const result: string[][] = [];
      if (keyed) {
        result.push(attribute('Id', []));
      }
      const args: string[] = [`targetEntity: ${element}::class`];
      if (prop.peer !== undefined) {
        args.push(`inversedBy: ${quote(prop.peer.name)}`);
      }
      result.push(
        attribute(relation.kind === 'oneToOne' ? 'OneToOne' : 'ManyToOne', args)
      );
      result.push(
        attribute('JoinColumn', [
          `name: ${dbName(relation.columnName)}`,
          `referencedColumnName: ${dbName(referenced)}`,
          `nullable: ${nullable ? 'true' : 'false'}`,
          `onDelete: ${quote(ON_DELETE_NAMES[relation.onDelete])}`,
        ])
      );
      return result;
    },
  };
  addProp(plan, `r:${relation.name}`, prop);
}

function planManyToMany(
  context: EmitContext,
  plan: ClassPlan,
  relation: IrRelation,
  target: IrModel
): void {
  const model: IrModel = plan.model;
  const label: string = `${model.name}.${relation.name}`;
  const ownerKey: string | undefined = referencedColumn(
    context,
    model,
    undefined
  );
  const targetKey: string | undefined = referencedColumn(
    context,
    target,
    undefined
  );
  if (ownerKey === undefined || targetKey === undefined) {
    context.warnings.push(
      `${label}: ${ownerKey === undefined ? model.name : target.name} has no single-column primary key to reference from a join table; the relation was skipped.`
    );
    return;
  }
  const name: string = uniqueName(
    identifier(context, label, propertyName(context, relation.name)),
    plan.propNames
  );
  const element: string = classNameOf(context, target.name);
  const isSelfReference: boolean = model.name === target.name;
  const ownerColumn: string = `${isSelfReference ? 'from_' : ''}${toSnakeCase(model.name)}_id`;
  const targetColumn: string = `${isSelfReference ? 'to_' : ''}${toSnakeCase(target.name)}_id`;
  const collection = collectionAccessors(plan, name);
  plan.imports.add('Doctrine\\Common\\Collections\\ArrayCollection');
  plan.imports.add('Doctrine\\Common\\Collections\\Collection');
  plan.constructorLines.push(`$this->${name} = new ArrayCollection();`);

  const prop: PropPlan = {
    name,
    role: 'manyToMany',
    nullable: false,
    phpType: 'Collection',
    docType: `Collection<int, ${element}>`,
    element,
    ...collection,
    attributes: (): string[][] => {
      const args: string[] = [`targetEntity: ${element}::class`];
      if (prop.peer !== undefined) {
        args.push(`inversedBy: ${quote(prop.peer.name)}`);
      }
      return [
        attribute('ManyToMany', args),
        attribute('JoinTable', [
          `name: ${dbName(`${model.tableName}_${relation.name}`)}`,
        ]),
        attribute('JoinColumn', [
          `name: ${dbName(ownerColumn)}`,
          `referencedColumnName: ${dbName(ownerKey)}`,
          `onDelete: 'CASCADE'`,
        ]),
        attribute('InverseJoinColumn', [
          `name: ${dbName(targetColumn)}`,
          `referencedColumnName: ${dbName(targetKey)}`,
          `onDelete: 'CASCADE'`,
        ]),
      ];
    },
  };
  addProp(plan, `r:${relation.name}`, prop);
}

function collectionAccessors(
  plan: ClassPlan,
  propName: string
): {
  getter: string;
  adder: string;
  remover: string;
  elementParam: string;
} {
  const snake: string = toSnakeCase(propName).replace(/_set$/, '');
  const singular: string = singularize(snake);
  const words: string = methodWords(singular);
  return {
    getter: uniqueName(`get${methodWords(propName)}`, plan.methodNames, true),
    adder: uniqueName(`add${words}`, plan.methodNames, true),
    remover: uniqueName(`remove${words}`, plan.methodNames, true),
    elementParam: parameterName(singular),
  };
}

/** Adds the inverse side of every relation that was planned on `model` to the target class. */
function planInverseSides(context: EmitContext, model: IrModel): void {
  const ownerPlan: ClassPlan | undefined = context.classes.get(model.name);
  if (ownerPlan === undefined) {
    return;
  }
  for (const relation of model.relations) {
    const owning: PropPlan | undefined = ownerPlan.byKey.get(
      `r:${relation.name}`
    );
    const target: IrModel | undefined = findModel(
      context.schema,
      relation.targetModel
    );
    const targetPlan: ClassPlan | undefined =
      target === undefined ? undefined : context.classes.get(target.name);
    if (
      owning === undefined ||
      target === undefined ||
      targetPlan === undefined
    ) {
      continue;
    }
    const label: string = `${model.name}.${relation.name}`;
    const defaultName: string =
      relation.kind === 'oneToOne'
        ? toSnakeCase(model.name)
        : `${toSnakeCase(model.name)}_set`;
    const name: string = uniqueName(
      identifier(
        context,
        label,
        propertyName(context, relation.relatedName ?? defaultName)
      ),
      targetPlan.propNames
    );
    const element: string = ownerPlan.className;
    const ownerColumnProp: string = owning.name;

    let inverse: PropPlan;
    if (relation.kind === 'oneToOne') {
      const accessors = allocateAccessors(targetPlan, name, false);
      inverse = {
        name,
        role: 'inverseToOne',
        nullable: true,
        phpType: `?${element}`,
        initializer: 'null',
        element,
        getter: accessors.getter,
        setter: accessors.setter,
        attributes: () => [
          attribute('OneToOne', [
            `targetEntity: ${element}::class`,
            `mappedBy: ${quote(ownerColumnProp)}`,
          ]),
        ],
      };
    } else if (relation.kind === 'manyToMany') {
      const collection = collectionAccessors(targetPlan, name);
      targetPlan.imports.add('Doctrine\\Common\\Collections\\ArrayCollection');
      targetPlan.imports.add('Doctrine\\Common\\Collections\\Collection');
      targetPlan.constructorLines.push(
        `$this->${name} = new ArrayCollection();`
      );
      inverse = {
        name,
        role: 'manyToMany',
        nullable: false,
        phpType: 'Collection',
        docType: `Collection<int, ${element}>`,
        element,
        ...collection,
        attributes: () => [
          attribute('ManyToMany', [
            `targetEntity: ${element}::class`,
            `mappedBy: ${quote(ownerColumnProp)}`,
          ]),
        ],
      };
    } else {
      const collection = collectionAccessors(targetPlan, name);
      targetPlan.imports.add('Doctrine\\Common\\Collections\\ArrayCollection');
      targetPlan.imports.add('Doctrine\\Common\\Collections\\Collection');
      targetPlan.constructorLines.push(
        `$this->${name} = new ArrayCollection();`
      );
      inverse = {
        name,
        role: 'inverseToMany',
        nullable: false,
        phpType: 'Collection',
        docType: `Collection<int, ${element}>`,
        element,
        ...collection,
        attributes: () => [
          attribute('OneToMany', [
            `targetEntity: ${element}::class`,
            `mappedBy: ${quote(ownerColumnProp)}`,
          ]),
        ],
      };
    }
    inverse.peer = owning;
    owning.peer = inverse;
    addProp(targetPlan, `i:${model.name}.${relation.name}`, inverse);
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderEnum(context: EmitContext, enumDefinition: IrEnum): string {
  const name: string =
    context.enumNames.get(enumDefinition.name) ?? enumDefinition.name;
  const lines: string[] = [
    '<?php',
    '',
    'declare(strict_types=1);',
    '',
    `namespace ${context.enumNamespace};`,
    '',
    `enum ${name}: string`,
    '{',
  ];
  const used: Set<string> = new Set<string>();
  for (const value of enumDefinition.values) {
    const caseName: string = uniqueName(
      identifier(context, `enum ${enumDefinition.name}`, value.name),
      used
    );
    if (value.label !== undefined && value.label !== '') {
      lines.push(`${INDENT}/** ${value.label.replace(/\*\//g, '* /')} */`);
    }
    lines.push(`${INDENT}case ${caseName} = ${quote(value.dbValue)};`);
  }
  lines.push('}', '');
  return lines.join('\n');
}

function indentLines(lines: string[], depth: number = 1): string[] {
  return lines.map((line: string) =>
    line === '' ? line : `${INDENT.repeat(depth)}${line}`
  );
}

/**
 * The table name plus one class-level `#[ORM\Index]` / `#[ORM\UniqueConstraint]`
 * per index. `Table(indexes:, uniqueConstraints:)` has no effect in Doctrine ORM
 * 3 (it is deprecated since 2.19), so the class-level attributes are used.
 */
function renderTableAttribute(context: EmitContext, plan: ClassPlan): string[] {
  const model: IrModel = plan.model;
  const lines: string[] = attribute('Table', [
    `name: ${dbName(model.tableName)}`,
  ]);
  for (const index of model.indexes) {
    const columns: string[] | undefined = indexColumns(context, model, index);
    if (columns === undefined) {
      continue;
    }
    const args: string[] = [];
    if (index.name !== undefined) {
      args.push(`name: ${quote(index.name)}`);
    }
    args.push(`columns: [${columns.map(quote).join(', ')}]`);
    lines.push(
      ...attribute(index.isUnique ? 'UniqueConstraint' : 'Index', args)
    );
  }
  return lines;
}

/** Resolves the IR field or relation names of an index to database column names. */
function indexColumns(
  context: EmitContext,
  model: IrModel,
  index: IrIndex
): string[] | undefined {
  const columns: string[] = [];
  const label: string = `${model.name} index (${index.fields.join(', ')})`;
  for (const fieldName of index.fields) {
    const relation: IrRelation | undefined =
      model.relations.find(
        (candidate: IrRelation) => candidate.name === fieldName
      ) ??
      model.relations.find(
        (candidate: IrRelation) =>
          candidate.kind !== 'manyToMany' && candidate.columnName === fieldName
      );
    if (relation !== undefined) {
      if (relation.kind === 'manyToMany') {
        context.warnings.push(
          `${label}: "${fieldName}" is a many-to-many relation and has no column; the index was skipped.`
        );
        return undefined;
      }
      columns.push(sqlIdentifier(relation.columnName));
      continue;
    }
    const field: IrField | undefined =
      model.fields.find((candidate: IrField) => candidate.name === fieldName) ??
      model.fields.find(
        (candidate: IrField) => candidate.columnName === fieldName
      );
    if (field !== undefined) {
      columns.push(sqlIdentifier(field.columnName));
      continue;
    }
    context.warnings.push(
      `${label}: an index references "${fieldName}", which is not a field of the model; it was written as-is.`
    );
    columns.push(sqlIdentifier(fieldName));
  }
  return columns;
}

function renderProperty(prop: PropPlan): string[] {
  const lines: string[] = [];
  if (prop.docType !== undefined) {
    lines.push(`/** @var ${prop.docType} */`);
  }
  for (const attributeLines of prop.attributes()) {
    lines.push(...attributeLines);
  }
  lines.push(
    `private ${prop.phpType} $${prop.name}${
      prop.initializer === undefined ? '' : ` = ${prop.initializer}`
    };`
  );
  return lines;
}

function method(
  signature: string,
  body: string[],
  docLines: string[] = []
): string[] {
  return [...docLines, signature, '{', ...indentLines(body), '}'];
}

function renderAccessors(prop: PropPlan): string[][] {
  const param: string = parameterName(prop.name);
  const methods: string[][] = [];
  switch (prop.role) {
    case 'column':
    case 'owningToOne':
      methods.push(
        method(`public function ${prop.getter}(): ${prop.phpType}`, [
          `return $this->${prop.name};`,
        ])
      );
      if (prop.setter !== undefined) {
        methods.push(
          method(
            `public function ${prop.setter}(${prop.phpType} $${param}): static`,
            [`$this->${prop.name} = $${param};`, '', 'return $this;']
          )
        );
      }
      break;
    case 'inverseToOne':
      methods.push(
        method(`public function ${prop.getter}(): ${prop.phpType}`, [
          `return $this->${prop.name};`,
        ])
      );
      if (prop.setter !== undefined) {
        const peerSetter: string = prop.peer?.setter ?? '';
        methods.push(
          method(
            `public function ${prop.setter}(${prop.phpType} $${param}): static`,
            [
              `$this->${prop.name} = $${param};`,
              ...(peerSetter === ''
                ? []
                : [
                    `if ($${param} !== null) {`,
                    `${INDENT}$${param}->${peerSetter}($this);`,
                    '}',
                  ]),
              '',
              'return $this;',
            ]
          )
        );
      }
      break;
    case 'inverseToMany':
    case 'manyToMany':
      methods.push(...renderCollectionAccessors(prop));
      break;
  }
  return methods;
}

function renderCollectionAccessors(prop: PropPlan): string[][] {
  const element: string = prop.element ?? 'mixed';
  const param: string = prop.elementParam ?? 'item';
  const peer: PropPlan | undefined = prop.peer;
  const addBody: string[] = [
    `if (!$this->${prop.name}->contains($${param})) {`,
    `${INDENT}$this->${prop.name}->add($${param});`,
  ];
  const removeBody: string[] = [];
  if (prop.role === 'manyToMany') {
    if (peer?.adder !== undefined) {
      addBody.push(`${INDENT}$${param}->${peer.adder}($this);`);
    }
    addBody.push('}');
    removeBody.push(`if ($this->${prop.name}->removeElement($${param})) {`);
    if (peer?.remover !== undefined) {
      removeBody.push(`${INDENT}$${param}->${peer.remover}($this);`);
    } else {
      removeBody.push(`${INDENT}// Nothing else to keep in sync.`);
    }
    removeBody.push('}');
  } else {
    if (peer?.setter !== undefined) {
      addBody.push(`${INDENT}$${param}->${peer.setter}($this);`);
    }
    addBody.push('}');
    removeBody.push(`if ($this->${prop.name}->removeElement($${param})) {`);
    if (peer?.nullable === true && peer.setter !== undefined) {
      removeBody.push(
        `${INDENT}if ($${param}->${peer.getter}() === $this) {`,
        `${INDENT}${INDENT}$${param}->${peer.setter}(null);`,
        `${INDENT}}`
      );
    } else {
      removeBody.push(
        `${INDENT}// The owning side is required, so it is not unset here.`
      );
    }
    removeBody.push('}');
  }
  return [
    method(
      `public function ${prop.getter}(): Collection`,
      [`return $this->${prop.name};`],
      ['/**', ` * @return ${prop.docType ?? 'Collection'}`, ' */']
    ),
    method(
      `public function ${prop.adder ?? 'add'}(${element} $${param}): static`,
      [...addBody, '', 'return $this;']
    ),
    method(
      `public function ${prop.remover ?? 'remove'}(${element} $${param}): static`,
      [...removeBody, '', 'return $this;']
    ),
  ];
}

const UUID_HELPER: string[] = [
  'private static function generateUuid(): string',
  '{',
  `${INDENT}$bytes = random_bytes(16);`,
  `${INDENT}$bytes[6] = chr((ord($bytes[6]) & 0x0f) | 0x40);`,
  `${INDENT}$bytes[8] = chr((ord($bytes[8]) & 0x3f) | 0x80);`,
  '',
  `${INDENT}return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($bytes), 4));`,
  '}',
];

function renderClass(context: EmitContext, plan: ClassPlan): string {
  const imports: string[] = [...plan.imports];
  const header: string[] = [
    '<?php',
    '',
    'declare(strict_types=1);',
    '',
    `namespace ${context.entityNamespace};`,
    '',
    ...imports
      .sort((first: string, second: string) => {
        const a: string = first.toLowerCase();
        const b: string = second.toLowerCase();
        return a < b ? -1 : a > b ? 1 : 0;
      })
      .map((name: string) => `use ${name};`),
    '',
  ];

  const classAttributes: string[] = [
    ...attribute('Entity', []),
    ...renderTableAttribute(context, plan),
  ];
  if (plan.autoUpdated.length > 0) {
    classAttributes.push(...attribute('HasLifecycleCallbacks', []));
  }

  const blocks: string[][] = [];
  for (const prop of plan.props) {
    blocks.push(renderProperty(prop));
  }
  // Properties are separated by a blank line; the constructor and methods follow.
  const body: string[] = blocks.flatMap((block: string[], index: number) =>
    index === 0 ? block : ['', ...block]
  );

  const members: string[][] = [];
  if (plan.constructorLines.length > 0) {
    members.push(
      method('public function __construct()', plan.constructorLines)
    );
  }
  for (const prop of plan.props) {
    members.push(...renderAccessors(prop));
  }
  if (plan.autoUpdated.length > 0) {
    const refresh: string = uniqueName(
      'refreshAutoUpdatedFields',
      plan.methodNames,
      true
    );
    members.push([
      ...attribute('PrePersist', []),
      ...attribute('PreUpdate', []),
      ...method(
        `public function ${refresh}(): void`,
        plan.autoUpdated.map(
          (name: string) => `$this->${name} = new DateTimeImmutable();`
        )
      ),
    ]);
  }
  if (plan.usesUuid) {
    members.push(UUID_HELPER);
  }

  const classBody: string[] = [...body];
  for (const member of members) {
    if (classBody.length > 0) {
      classBody.push('');
    }
    classBody.push(...member);
  }

  return [
    ...header,
    ...classAttributes,
    `class ${plan.className}`,
    '{',
    ...indentLines(classBody),
    '}',
    '',
  ].join('\n');
}
