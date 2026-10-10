import { prismaOnlyWarnings } from '../prismaOnlyConstructs.js';
import type {
  IrCompositeForeignKey,
  IrDefault,
  IrEnum,
  IrField,
  IrIndex,
  IrModel,
  IrOnDelete,
  IrRelation,
  IrSchema,
} from '../ir.js';
import { limitIdentifier, toPascalCase, toSnakeCase } from '../naming.js';
import { normalizeSchema, type NamingMode } from '../transforms.js';
import type { EmitOutput } from './prisma.js';

/**
 * SQLAlchemy 2.0 emitter, with a SQLModel variant.
 *
 * The output is one `models.py`. With `style: 'sqlalchemy'` (the default) it is a declarative module:
 * a `Base(DeclarativeBase)`, typed `Mapped[...]` attributes built with `mapped_column`, `relationship`
 * on both sides of every relation (`back_populates`), `Table(...)` objects for many-to-many
 * association tables, Python `enum.Enum` classes behind `sa.Enum`, and constraints and indexes in
 * `__table_args__`. With `style: 'sqlmodel'` the classes are `SQLModel, table=True` classes with
 * `Field(...)` and `Relationship(...)`; `sa_type`, `sa_column_kwargs`, `sa_column` and
 * `sa_relationship_kwargs` appear only where `Field` / `Relationship` cannot say it.
 */

export type SqlAlchemyStyle = 'sqlalchemy' | 'sqlmodel';

export const SQLALCHEMY_STYLES: readonly SqlAlchemyStyle[] = [
  'sqlalchemy',
  'sqlmodel',
];

/** True when a value is one of the supported `--style` values. */
export function isSqlAlchemyStyle(value: string): value is SqlAlchemyStyle {
  return (SQLALCHEMY_STYLES as readonly string[]).includes(value);
}

export interface SqlAlchemyEmitOptions {
  /**
   * "preserve" keeps the database names of the source (table, column, index and enum type names);
   * "normalize" applies the fresh-schema style of the other emitters. Python attribute names are
   * snake_case in both modes.
   */
  naming: NamingMode;
  /** `sqlalchemy` (default) or `sqlmodel`. */
  style?: SqlAlchemyStyle;
}

// ---------------------------------------------------------------------------
// Source text building: a tiny expression tree that wraps long calls like Black does
// ---------------------------------------------------------------------------

const MAX_LINE_WIDTH: number = 88;
const INDENT: string = '    ';

/** A call, list, tuple or dict that can break one item per line when it does not fit. */
interface Group {
  open: string;
  items: Node[];
  close: string;
  /** Always one item per line. */
  force?: boolean;
}

type Node = string | Group;

function group(open: string, items: Node[], close: string = ')'): Group {
  return { open, items, close };
}

function call(name: string, items: Node[]): Group {
  return group(`${name}(`, items);
}

function flat(node: Node): string {
  if (typeof node === 'string') {
    return node;
  }
  return `${node.open}${node.items.map(flat).join(', ')}${node.close}`;
}

function renderNode(node: Node, column: number, indent: number): string {
  if (typeof node === 'string') {
    return node;
  }
  const inline: string = flat(node);
  if (
    node.items.length === 0 ||
    (node.force !== true && column + inline.length < MAX_LINE_WIDTH)
  ) {
    return inline;
  }
  const pad: string = ' '.repeat(indent + INDENT.length);
  const lines: string[] = node.items.map(
    (item: Node): string => `${pad}${renderNode(item, pad.length, pad.length)},`
  );
  return `${node.open}\n${lines.join('\n')}\n${' '.repeat(indent)}${node.close}`;
}

/** Renders a statement at an indentation level. */
function statement(node: Node, level: number): string {
  const indent: number = level * INDENT.length;
  return `${' '.repeat(indent)}${renderNode(node, indent, indent)}`;
}

function pyString(value: string): string {
  return JSON.stringify(value);
}

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

const PYTHON_KEYWORDS: readonly string[] = [
  'False',
  'None',
  'True',
  'and',
  'as',
  'assert',
  'async',
  'await',
  'break',
  'class',
  'continue',
  'def',
  'del',
  'elif',
  'else',
  'except',
  'finally',
  'for',
  'from',
  'global',
  'if',
  'import',
  'in',
  'is',
  'lambda',
  'nonlocal',
  'not',
  'or',
  'pass',
  'raise',
  'return',
  'try',
  'while',
  'with',
  'yield',
];

/** Names the generated module imports or relies on; no class, enum or table variable may take them. */
const MODULE_RESERVED: readonly string[] = [
  ...PYTHON_KEYWORDS,
  'ARRAY',
  'Any',
  'BigInteger',
  'Base',
  'Boolean',
  'Column',
  'Date',
  'DateTime',
  'DeclarativeBase',
  'Enum',
  'Field',
  'Float',
  'ForeignKey',
  'ForeignKeyConstraint',
  'HSTORE',
  'INET',
  'INT4RANGE',
  'INT8RANGE',
  'DATERANGE',
  'NUMRANGE',
  'TSTZRANGE',
  'Index',
  'Integer',
  'Interval',
  'JSON',
  'LargeBinary',
  'Mapped',
  'Numeric',
  'Optional',
  'PrimaryKeyConstraint',
  'Range',
  'Relationship',
  'SQLModel',
  'String',
  'Table',
  'Text',
  'Time',
  'UniqueConstraint',
  'Uuid',
  'bool',
  'bytes',
  'datetime',
  'decimal',
  'dict',
  'enum',
  'false',
  'float',
  'func',
  'int',
  'list',
  'mapped_column',
  'object',
  'relationship',
  'str',
  'text',
  'true',
  'uuid',
];

/** Names that, as an attribute of a class, would shadow something the class body still needs. */
const CLASS_RESERVED: readonly string[] = [
  ...MODULE_RESERVED,
  'metadata',
  'registry',
  'self',
  'cls',
];

/** Attribute names of `SQLModel` (pydantic's `BaseModel` and SQLModel itself) a field must not shadow. */
const SQLMODEL_RESERVED: readonly string[] = [
  'construct',
  'copy',
  'dict',
  'fields',
  'from_orm',
  'json',
  'parse_file',
  'parse_obj',
  'parse_raw',
  'schema',
  'schema_json',
  'update_forward_refs',
  'validate',
];

const IDENTIFIER_PATTERN: RegExp = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** The first free name: `base`, then `base2`, `base3`, ... A name also counts as taken when `others` holds it. */
function uniqueName(
  base: string,
  used: Set<string>,
  others: ReadonlySet<string> = new Set<string>()
): string {
  let candidate: string = base;
  let suffix: number = 2;
  while (used.has(candidate) || others.has(candidate)) {
    candidate = `${base}${suffix}`;
    suffix += 1;
  }
  used.add(candidate);
  return candidate;
}

function pluralize(word: string): string {
  if (/(s|x|z|ch|sh)$/i.test(word)) {
    return `${word}es`;
  }
  if (/[^aeiou]y$/i.test(word)) {
    return `${word.slice(0, -1)}ies`;
  }
  return `${word}s`;
}

/** A snake_case Python identifier built from any text. */
function snakeIdentifier(raw: string, fallback: string): string {
  const snake: string = toSnakeCase(raw);
  const safe: string = snake.replace(/[^A-Za-z0-9_]/g, '_');
  if (safe === '') {
    return fallback;
  }
  return /^[0-9]/.test(safe) ? `${fallback}_${safe}` : safe;
}

// ---------------------------------------------------------------------------
// Context and per-class bookkeeping
// ---------------------------------------------------------------------------

interface ResolvedKey {
  /** The scalar column the key finally lands on (its type is the key's type). */
  field: IrField;
  columnName: string;
  /** Attribute of the column on its class. */
  attr: string;
}

interface ClassInfo {
  model: IrModel;
  className: string;
  /** Attributes in use (columns, relationships). */
  used: Set<string>;
  /** IR field name -> attribute. */
  fieldAttrs: Map<string, string>;
  /** IR relation name -> attribute of its foreign-key column. */
  columnAttrs: Map<string, string>;
  /** IR relation or composite key name -> attribute of its relationship. */
  relationAttrs: Map<string, string>;
  /** Relationships that point at this class (the reverse sides). */
  incoming: Link[];
  /** Position in the output. */
  position: number;
}

interface EnumInfo {
  definition: IrEnum;
  className: string;
  /** Database type name of the enum. */
  dbName: string;
  /** The Python member name of each value, in the order of `definition.values`. */
  memberNames: string[];
}

interface Association {
  variable: string;
  tableName: string;
  ownerColumn: string;
  targetColumn: string;
  ownerKey: ResolvedKey | undefined;
  targetKey: ResolvedKey | undefined;
  selfReference: boolean;
}

interface Link {
  owner: ClassInfo;
  target: ClassInfo;
  kind: 'foreignKey' | 'oneToOne' | 'manyToMany';
  /** IR name of the relation. */
  name: string;
  isNullable: boolean;
  onDelete: IrOnDelete;
  onUpdate: IrOnDelete | undefined;
  constraintName: string | undefined;
  relatedName: string | undefined;
  forwardAttr: string;
  reverseAttr: string;
  /** Database columns of the owner holding the key, and their attributes. */
  localColumns: string[];
  localAttrs: string[];
  /** Referenced columns of the target, and their attributes. */
  remoteColumns: string[];
  remoteAttrs: string[];
  /** True for a key made of several columns. */
  composite: boolean;
  /** More than one foreign key joins this pair of classes, so `foreign_keys` must say which. */
  ambiguous: boolean;
  selfReference: boolean;
  association: Association | undefined;
}

interface EmitContext {
  schema: IrSchema;
  style: SqlAlchemyStyle;
  naming: NamingMode;
  warnings: string[];
  /** Module-level names taken (classes, enums, association tables, imports). */
  moduleNames: Set<string>;
  classes: Map<string, ClassInfo>;
  enums: Map<string, EnumInfo>;
  links: Link[];
  /** Index and constraint names (unique per database schema). */
  constraintNames: Set<string>;
  /** Every class attribute allocated, so no module-level variable can be shadowed by one. */
  attributes: Set<string>;
  /** `from sqlalchemy import ...` names. */
  saImports: Set<string>;
  /** `from sqlalchemy.dialects.postgresql import ...` names. */
  pgImports: Set<string>;
  /** While a column type is built, the names it uses are collected here instead (see `TypeInfo.uses`). */
  collector: TypeUses | undefined;
  /** `from sqlalchemy.orm import ...` names (SQLAlchemy style) or `from sqlmodel import ...` names (SQLModel style). */
  frameworkImports: Set<string>;
  /** Plain modules (`datetime`, `decimal`, `enum`, `uuid`). */
  modules: Set<string>;
  /** `from typing import ...` names. */
  typingImports: Set<string>;
  associations: Association[];
}

/** The SQLAlchemy names a column type needs, imported only when the type is written. */
interface TypeUses {
  sa: Set<string>;
  pg: Set<string>;
}

function sa(context: EmitContext, name: string): string {
  (context.collector?.sa ?? context.saImports).add(name);
  return name;
}

function pg(context: EmitContext, name: string): string {
  (context.collector?.pg ?? context.pgImports).add(name);
  return name;
}

/** Builds a column type, collecting the imports it needs instead of registering them. */
function collectTypes(
  context: EmitContext,
  build: () => Omit<TypeInfo, 'uses'>
): TypeInfo {
  const uses: TypeUses = { sa: new Set<string>(), pg: new Set<string>() };
  const previous: TypeUses | undefined = context.collector;
  context.collector = uses;
  try {
    return { ...build(), uses };
  } finally {
    context.collector = previous;
  }
}

/** Registers the imports of a column type that is written to the output. */
function commitTypes(context: EmitContext, type: TypeInfo): void {
  for (const name of type.uses.sa) {
    context.saImports.add(name);
  }
  for (const name of type.uses.pg) {
    context.pgImports.add(name);
  }
}

function framework(context: EmitContext, name: string): string {
  context.frameworkImports.add(name);
  return name;
}

function mod(context: EmitContext, name: string): string {
  context.modules.add(name);
  return name;
}

function optional(context: EmitContext, annotation: string): string {
  context.typingImports.add('Optional');
  return `Optional[${annotation}]`;
}

function metadataExpression(context: EmitContext): string {
  return context.style === 'sqlmodel' ? 'SQLModel.metadata' : 'Base.metadata';
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/** Writes the IR as a SQLAlchemy 2.0 (or SQLModel) models.py. */
export function emitSqlAlchemy(
  schema: IrSchema,
  options: SqlAlchemyEmitOptions
): EmitOutput {
  const style: SqlAlchemyStyle = options.style ?? 'sqlalchemy';
  const prepared: IrSchema =
    options.naming === 'normalize' ? normalizeSchema(schema) : schema;
  const context: EmitContext = {
    schema: prepared,
    style,
    naming: options.naming,
    // Views, composite foreign keys, onUpdate actions and database default expressions are written here.
    warnings: prismaOnlyWarnings(prepared, true).filter(
      (warning: string) =>
        !warning.includes('the onUpdate action') &&
        !warning.includes('has no equivalent here; the relation was dropped') &&
        !warning.includes('the database default expression')
    ),
    moduleNames: new Set<string>(MODULE_RESERVED),
    classes: new Map<string, ClassInfo>(),
    enums: new Map<string, EnumInfo>(),
    links: [],
    constraintNames: new Set<string>(),
    attributes: new Set<string>(),
    saImports: new Set<string>(),
    pgImports: new Set<string>(),
    collector: undefined,
    frameworkImports: new Set<string>(),
    modules: new Set<string>(),
    typingImports: new Set<string>(),
    associations: [],
  };

  const mapped: IrModel[] = prepared.models.filter(
    (model: IrModel) => model.isView !== true
  );
  allocateClasses(context, mapped);
  allocateEnums(context);
  allocateAttributes(context, mirroredManyToMany(mapped));
  buildLinks(context, mapped);
  const ordered: ClassInfo[] = orderClasses(context, mapped);

  const blocks: string[] = [];
  if (style === 'sqlalchemy') {
    framework(context, 'DeclarativeBase');
    blocks.push('class Base(DeclarativeBase):\n    pass');
  }
  for (const info of context.enums.values()) {
    blocks.push(renderEnum(context, info));
  }
  for (const association of context.associations) {
    blocks.push(renderAssociation(context, association));
  }
  for (const info of ordered) {
    blocks.push(renderClass(context, info));
  }
  for (const model of prepared.models) {
    if (model.isView === true) {
      blocks.push(renderView(context, model));
    }
  }

  const header: string =
    '# Generated by ormbridge. Review the output before creating tables or migrations.';
  const importBlock: string = buildImports(context);
  const text: string = `${header}\n\n${importBlock}\n\n\n${blocks.join('\n\n\n')}\n`;
  return { text, warnings: context.warnings };
}

// ---------------------------------------------------------------------------
// Allocation of names
// ---------------------------------------------------------------------------

function classNameOf(context: EmitContext, model: IrModel): string {
  let name: string = model.name;
  if (!IDENTIFIER_PATTERN.test(name)) {
    name = toPascalCase(model.name).replace(/[^A-Za-z0-9_]/g, '_');
    if (name === '' || /^[0-9]/.test(name)) {
      name = `Model${name}`;
    }
  }
  if (context.moduleNames.has(name)) {
    const renamed: string = uniqueName(`${name}Model`, context.moduleNames);
    context.warnings.push(
      `${model.name}: the name collides with a Python or SQLAlchemy name used by the module; the class was written as ${renamed}.`
    );
    return renamed;
  }
  context.moduleNames.add(name);
  if (name !== model.name) {
    context.warnings.push(
      `${model.name}: not a valid Python class name; the class was written as ${name}.`
    );
  }
  return name;
}

function allocateClasses(context: EmitContext, models: IrModel[]): void {
  for (const model of models) {
    context.classes.set(model.name, {
      model,
      className: classNameOf(context, model),
      used: new Set<string>(
        context.style === 'sqlmodel'
          ? [...CLASS_RESERVED, ...SQLMODEL_RESERVED]
          : CLASS_RESERVED
      ),
      fieldAttrs: new Map<string, string>(),
      columnAttrs: new Map<string, string>(),
      relationAttrs: new Map<string, string>(),
      incoming: [],
      position: 0,
    });
  }
}

function allocateEnums(context: EmitContext): void {
  for (const definition of context.schema.enums) {
    if (definition.values.length === 0) {
      context.warnings.push(
        `enum ${definition.name}: an enum without values cannot be written; fields that use it became plain strings.`
      );
      continue;
    }
    let className: string = IDENTIFIER_PATTERN.test(definition.name)
      ? definition.name
      : toPascalCase(definition.name).replace(/[^A-Za-z0-9_]/g, '_') || 'Enum_';
    if (/^[0-9]/.test(className)) {
      className = `Enum${className}`;
    }
    if (context.moduleNames.has(className)) {
      className = `${className}Enum`;
    }
    className = uniqueName(className, context.moduleNames);
    if (className !== definition.name) {
      context.warnings.push(
        `enum ${definition.name}: the Python class was named ${className}.`
      );
    }
    const dbName: string = definition.dbName ?? definition.name;
    const used: Set<string> = new Set<string>();
    const memberNames: string[] = [];
    for (const value of definition.values) {
      let member: string = value.name.replace(/[^A-Za-z0-9_]/g, '_');
      if (member === '' || /^[0-9]/.test(member) || member.startsWith('_')) {
        member = `v_${member.replace(/^_+/, '')}`;
      }
      if (
        PYTHON_KEYWORDS.includes(member) ||
        member === 'name' ||
        member === 'value' ||
        member === 'mro'
      ) {
        member = `${member}_`;
      }
      const allocated: string = uniqueName(member, used);
      if (allocated !== value.name) {
        context.warnings.push(
          `enum ${definition.name}: the member "${value.name}" was written as ${allocated}.`
        );
      }
      memberNames.push(allocated);
    }
    context.enums.set(definition.name, {
      definition,
      className,
      dbName:
        context.naming === 'normalize' ? toSnakeCase(dbName) || dbName : dbName,
      memberNames,
    });
  }
}

/** A snake_case attribute for a name of the source, repaired when it would shadow or collide. */
function attributeName(
  context: EmitContext,
  info: ClassInfo,
  raw: string,
  owner: string
): string {
  const base: string = snakeIdentifier(raw, 'field');
  let candidate: string = base;
  if (info.used.has(candidate) || context.moduleNames.has(candidate)) {
    candidate = `${base}_`;
  }
  const allocated: string = uniqueName(
    candidate,
    info.used,
    context.moduleNames
  );
  context.attributes.add(allocated);
  if (allocated !== base && !CLASS_RESERVED.includes(base)) {
    context.warnings.push(
      `${owner}: the name "${raw}" collides with another attribute of the class or a name used by the module; it was written as ${allocated}.`
    );
  } else if (allocated !== base) {
    context.warnings.push(
      `${owner}: "${raw}" would shadow a name the class needs; the attribute was written as ${allocated}.`
    );
  }
  return allocated;
}

function allocateAttributes(context: EmitContext, mirrored: Set<string>): void {
  for (const info of context.classes.values()) {
    const model: IrModel = info.model;
    for (const field of model.fields) {
      info.fieldAttrs.set(
        field.name,
        attributeName(context, info, field.name, `${model.name}.${field.name}`)
      );
    }
    for (const key of model.compositeForeignKeys ?? []) {
      info.relationAttrs.set(
        key.name,
        attributeName(context, info, key.name, `${model.name}.${key.name}`)
      );
    }
    for (const relation of model.relations) {
      if (mirrored.has(`${model.name}.${relation.name}`)) {
        continue;
      }
      info.relationAttrs.set(
        relation.name,
        attributeName(
          context,
          info,
          relation.name,
          `${model.name}.${relation.name}`
        )
      );
    }
    for (const relation of model.relations) {
      if (relation.kind === 'manyToMany') {
        continue;
      }
      // The foreign-key column keeps its own name unless the relationship already took it.
      const wanted: string = snakeIdentifier(relation.columnName, 'column');
      const column: string = info.used.has(wanted) ? `${wanted}_id` : wanted;
      info.columnAttrs.set(
        relation.name,
        attributeName(context, info, column, `${model.name}.${relation.name}`)
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Keys and links
// ---------------------------------------------------------------------------

function isKeyRelation(model: IrModel, relation: IrRelation): boolean {
  return (
    relation.isPrimaryKey === true ||
    (model.compositePrimaryKey?.includes(relation.name) ?? false)
  );
}

/**
 * Finds the column a foreign key points at: the named column of the target, otherwise its primary key.
 * A key that is itself a relation (multi-table inheritance) is followed to the scalar underneath.
 */
function resolveKey(
  context: EmitContext,
  modelName: string,
  name: string | undefined,
  depth: number = 0
): ResolvedKey | undefined {
  const info: ClassInfo | undefined = context.classes.get(modelName);
  if (info === undefined || depth > 8) {
    return undefined;
  }
  const model: IrModel = info.model;
  let wanted: string | undefined = name;
  if (wanted === undefined) {
    const primary: IrField | undefined = model.fields.find(
      (field: IrField) => field.isPrimaryKey
    );
    if (primary !== undefined) {
      wanted = primary.name;
    } else {
      const keyRelation: IrRelation | undefined = model.relations.find(
        (relation: IrRelation) => relation.isPrimaryKey === true
      );
      wanted =
        keyRelation?.name ??
        (model.compositePrimaryKey?.length === 1
          ? model.compositePrimaryKey[0]
          : undefined);
    }
  }
  if (wanted === undefined) {
    return undefined;
  }
  const field: IrField | undefined =
    model.fields.find((candidate: IrField) => candidate.name === wanted) ??
    model.fields.find((candidate: IrField) => candidate.columnName === wanted);
  if (field !== undefined) {
    return {
      field,
      columnName: field.columnName,
      attr: info.fieldAttrs.get(field.name) ?? field.name,
    };
  }
  const relation: IrRelation | undefined = model.relations.find(
    (candidate: IrRelation) =>
      candidate.kind !== 'manyToMany' && candidate.name === wanted
  );
  if (relation === undefined) {
    return undefined;
  }
  const inner: ResolvedKey | undefined = resolveKey(
    context,
    relation.targetModel,
    relation.toField,
    depth + 1
  );
  if (inner === undefined) {
    return undefined;
  }
  return {
    field: inner.field,
    columnName: relation.columnName,
    attr: info.columnAttrs.get(relation.name) ?? relation.columnName,
  };
}

function pairKey(first: string, second: string): string {
  return first <= second
    ? `${first}\u0000${second}`
    : `${second}\u0000${first}`;
}

function defaultReverseName(
  owner: ClassInfo,
  kind: Link['kind'],
  sharedTarget: boolean,
  relationName: string
): string {
  const base: string = snakeIdentifier(owner.model.name, 'model');
  const name: string = kind === 'oneToOne' ? base : pluralize(base);
  return sharedTarget
    ? `${name}_${snakeIdentifier(relationName, 'rel')}`
    : name;
}

/**
 * A schema may list both sides of one many-to-many relation (each names the other as its related
 * name). The first side is the owner; the other is the reverse side and gets no relation of its own.
 */
function mirroredManyToMany(models: IrModel[]): Set<string> {
  const mirrored: Set<string> = new Set<string>();
  for (const model of models) {
    for (const relation of model.relations) {
      if (
        relation.kind !== 'manyToMany' ||
        relation.relatedName === undefined ||
        mirrored.has(`${model.name}.${relation.name}`)
      ) {
        continue;
      }
      const other: IrModel | undefined = models.find(
        (candidate: IrModel) => candidate.name === relation.targetModel
      );
      const counterpart: IrRelation | undefined = other?.relations.find(
        (candidate: IrRelation) =>
          candidate.kind === 'manyToMany' &&
          candidate.name === relation.relatedName &&
          candidate.targetModel === model.name
      );
      if (other !== undefined && counterpart !== undefined && other !== model) {
        mirrored.add(`${other.name}.${counterpart.name}`);
      }
    }
  }
  return mirrored;
}

function buildLinks(context: EmitContext, models: IrModel[]): void {
  const raw: Link[] = [];
  const mirrored: Set<string> = mirroredManyToMany(models);
  for (const model of models) {
    const owner: ClassInfo | undefined = context.classes.get(model.name);
    if (owner === undefined) {
      continue;
    }
    for (const relation of model.relations) {
      const target: ClassInfo | undefined = context.classes.get(
        relation.targetModel
      );
      if (target === undefined) {
        context.warnings.push(
          `${model.name}.${relation.name}: the target model ${relation.targetModel} is not a mapped table (it is missing or a view); ${relation.kind === 'manyToMany' ? 'the relation was dropped' : 'the foreign key column was written without a ForeignKey or a relationship'}.`
        );
        continue;
      }
      if (relation.kind === 'manyToMany') {
        if (mirrored.has(`${model.name}.${relation.name}`)) {
          continue;
        }
        raw.push(manyToManyLink(context, owner, target, relation));
      } else {
        raw.push(foreignKeyLink(context, owner, target, relation));
      }
    }
    for (const key of model.compositeForeignKeys ?? []) {
      const target: ClassInfo | undefined = context.classes.get(
        key.targetModel
      );
      if (target === undefined) {
        context.warnings.push(
          `${model.name}.${key.name}: the target model ${key.targetModel} is not a mapped table; the composite foreign key was dropped and its columns kept as plain columns.`
        );
        continue;
      }
      raw.push(compositeLink(context, owner, target, key));
    }
  }
  const links: Link[] = raw.filter(
    (link: Link) => link.localAttrs.length > 0 || link.association !== undefined
  );

  // More than one foreign key between a pair of classes needs `foreign_keys` on every side.
  const counts: Map<string, number> = new Map<string, number>();
  for (const link of links) {
    if (link.kind === 'manyToMany') {
      continue;
    }
    const key: string = pairKey(link.owner.model.name, link.target.model.name);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  // Reverse names: a model that points twice at the same target needs distinct reverse names.
  const sharedTargets: Map<string, number> = new Map<string, number>();
  for (const link of links) {
    const key: string = `${link.owner.model.name}\u0000${link.target.model.name}\u0000${link.kind}`;
    sharedTargets.set(key, (sharedTargets.get(key) ?? 0) + 1);
  }
  for (const link of links) {
    if (link.kind !== 'manyToMany') {
      link.ambiguous =
        (counts.get(pairKey(link.owner.model.name, link.target.model.name)) ??
          0) > 1;
    }
    const sharedKey: string = `${link.owner.model.name}\u0000${link.target.model.name}\u0000${link.kind}`;
    const shared: boolean = (sharedTargets.get(sharedKey) ?? 0) > 1;
    const wanted: string =
      link.relatedName === undefined
        ? defaultReverseName(link.owner, link.kind, shared, link.name)
        : snakeIdentifier(link.relatedName, 'related');
    const base: string =
      link.target.used.has(wanted) || context.moduleNames.has(wanted)
        ? `${wanted}_`
        : wanted;
    link.reverseAttr = uniqueName(base, link.target.used, context.moduleNames);
    context.attributes.add(link.reverseAttr);
    link.target.incoming.push(link);
  }
  context.links = links;
  for (const association of context.associations) {
    association.variable = uniqueName(
      snakeIdentifier(association.tableName, 'association'),
      context.moduleNames,
      context.attributes
    );
  }
}

function foreignKeyLink(
  context: EmitContext,
  owner: ClassInfo,
  target: ClassInfo,
  relation: IrRelation
): Link {
  const key: ResolvedKey | undefined = resolveKey(
    context,
    target.model.name,
    relation.toField
  );
  if (key === undefined) {
    context.warnings.push(
      `${owner.model.name}.${relation.name}: ${target.model.name} has no ${relation.toField === undefined ? 'primary key' : `column ${relation.toField}`} to reference; the foreign key points at ${target.model.tableName}.id.`
    );
  }
  return {
    owner,
    target,
    kind: relation.kind === 'oneToOne' ? 'oneToOne' : 'foreignKey',
    name: relation.name,
    isNullable: relation.isNullable,
    onDelete: relation.onDelete,
    onUpdate: relation.onUpdate,
    constraintName: relation.constraintName,
    relatedName: relation.relatedName,
    forwardAttr: owner.relationAttrs.get(relation.name) ?? relation.name,
    reverseAttr: '',
    localColumns: [relation.columnName],
    localAttrs: [owner.columnAttrs.get(relation.name) ?? relation.columnName],
    remoteColumns: [key?.columnName ?? 'id'],
    remoteAttrs: [key?.attr ?? 'id'],
    composite: false,
    ambiguous: false,
    selfReference: owner === target,
    association: undefined,
  };
}

function compositeLink(
  context: EmitContext,
  owner: ClassInfo,
  target: ClassInfo,
  key: IrCompositeForeignKey
): Link {
  const localColumns: string[] = [];
  const localAttrs: string[] = [];
  for (const name of key.fields) {
    const field: IrField | undefined = owner.model.fields.find(
      (candidate: IrField) => candidate.name === name
    );
    localColumns.push(field?.columnName ?? name);
    localAttrs.push(owner.fieldAttrs.get(name) ?? name);
  }
  const remoteColumns: string[] = [];
  const remoteAttrs: string[] = [];
  for (const name of key.references) {
    const resolved: ResolvedKey | undefined = resolveKey(
      context,
      target.model.name,
      name
    );
    remoteColumns.push(resolved?.columnName ?? name);
    remoteAttrs.push(resolved?.attr ?? name);
  }
  return {
    owner,
    target,
    kind: key.kind,
    name: key.name,
    isNullable: key.isNullable,
    onDelete: key.onDelete,
    onUpdate: key.onUpdate,
    constraintName: key.constraintName,
    relatedName: key.relatedName,
    forwardAttr: owner.relationAttrs.get(key.name) ?? key.name,
    reverseAttr: '',
    localColumns,
    localAttrs,
    remoteColumns,
    remoteAttrs,
    composite: true,
    ambiguous: false,
    selfReference: owner === target,
    association: undefined,
  };
}

function manyToManyLink(
  context: EmitContext,
  owner: ClassInfo,
  target: ClassInfo,
  relation: IrRelation
): Link {
  const selfReference: boolean = owner === target;
  const ownerSnake: string = snakeIdentifier(owner.model.name, 'model');
  const targetSnake: string = snakeIdentifier(target.model.name, 'model');
  const ownerColumn: string = selfReference
    ? `from_${ownerSnake}_id`
    : `${ownerSnake}_id`;
  const targetColumn: string = selfReference
    ? `to_${targetSnake}_id`
    : `${targetSnake}_id`;
  const tableName: string = `${owner.model.tableName}_${relation.name}`;
  const ownerKey: ResolvedKey | undefined = resolveKey(
    context,
    owner.model.name,
    undefined
  );
  const targetKey: ResolvedKey | undefined = resolveKey(
    context,
    target.model.name,
    undefined
  );
  for (const [info, key] of [
    [owner, ownerKey],
    [target, targetKey],
  ] as const) {
    if (key === undefined) {
      context.warnings.push(
        `${owner.model.name}.${relation.name}: ${info.model.name} has no single-column primary key; the association table column references ${info.model.tableName}.id.`
      );
    }
  }
  const association: Association = {
    variable: '',
    tableName,
    ownerColumn,
    targetColumn,
    ownerKey,
    targetKey,
    selfReference,
  };
  context.associations.push(association);
  return {
    owner,
    target,
    kind: 'manyToMany',
    name: relation.name,
    isNullable: false,
    onDelete: 'cascade',
    onUpdate: undefined,
    constraintName: undefined,
    relatedName: relation.relatedName,
    forwardAttr: owner.relationAttrs.get(relation.name) ?? relation.name,
    reverseAttr: '',
    localColumns: [],
    localAttrs: [],
    remoteColumns: [],
    remoteAttrs: [],
    composite: false,
    ambiguous: false,
    selfReference,
    association,
  };
}

/** Orders the classes so that a class follows the classes its foreign keys point at where it can. */
function orderClasses(context: EmitContext, models: IrModel[]): ClassInfo[] {
  const ordered: ClassInfo[] = [];
  const done: Set<string> = new Set<string>();
  const visiting: Set<string> = new Set<string>();
  const visit = (model: IrModel): void => {
    if (done.has(model.name) || visiting.has(model.name)) {
      return;
    }
    visiting.add(model.name);
    for (const link of context.links) {
      if (
        link.owner.model === model &&
        link.kind !== 'manyToMany' &&
        link.target.model !== model
      ) {
        visit(link.target.model);
      }
    }
    visiting.delete(model.name);
    done.add(model.name);
    const info: ClassInfo | undefined = context.classes.get(model.name);
    if (info !== undefined) {
      info.position = ordered.length;
      ordered.push(info);
    }
  };
  for (const model of models) {
    visit(model);
  }
  return ordered;
}

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

function renderEnum(context: EmitContext, info: EnumInfo): string {
  mod(context, 'enum');
  const lines: string[] = [`class ${info.className}(enum.Enum):`];
  info.definition.values.forEach((value, position: number): void => {
    lines.push(
      `${INDENT}${info.memberNames[position] ?? value.name} = ${pyString(value.dbValue)}`
    );
  });
  return lines.join('\n');
}

function enumOf(context: EmitContext, field: IrField): EnumInfo | undefined {
  return field.enumName === undefined
    ? undefined
    : context.enums.get(field.enumName);
}

function enumType(context: EmitContext, info: EnumInfo): Node {
  mod(context, 'enum');
  return call(sa(context, 'Enum'), [
    info.className,
    `name=${pyString(info.dbName)}`,
    'values_callable=lambda members: [member.value for member in members]',
  ]);
}

// ---------------------------------------------------------------------------
// Column types
// ---------------------------------------------------------------------------

/** What a column looks like in both styles. */
interface TypeInfo {
  /** SQLAlchemy type expression. */
  sa: Node;
  /** Python annotation of one value (without Optional). */
  py: string;
  /**
   * SQLModel derives this type from the annotation. Absent when the annotation is enough;
   * otherwise `sa_type=` carries `sa`.
   */
  needsSaType: boolean;
  /** SQLModel `Field` arguments that replace `sa_type` (max_length, max_digits, decimal_places). */
  fieldArgs: string[];
  /** The names `sa` needs; imported when the type is written (SQLModel often does not write it). */
  uses: TypeUses;
}

const RANGE_TYPES: Readonly<Record<string, [string, string]>> = {
  int: ['INT4RANGE', 'int'],
  bigInt: ['INT8RANGE', 'int'],
  decimal: ['NUMRANGE', 'decimal.Decimal'],
  date: ['DATERANGE', 'datetime.date'],
  dateTime: ['TSTZRANGE', 'datetime.datetime'],
};

function withSqliteFallback(
  context: EmitContext,
  type: Node,
  fallback: Node
): Node {
  return call(`${flat(type)}.with_variant`, [fallback, '"sqlite"']);
}

function scalarType(
  context: EmitContext,
  model: IrModel,
  field: IrField
): Omit<TypeInfo, 'uses'> {
  const label: string = `${model.name}.${field.name}`;
  const enumInfo: EnumInfo | undefined = enumOf(context, field);
  if (enumInfo !== undefined) {
    return {
      sa: enumType(context, enumInfo),
      py: enumInfo.className,
      needsSaType: true,
      fieldArgs: [],
    };
  }
  switch (field.type) {
    case 'string':
      return {
        sa:
          field.maxLength === undefined
            ? sa(context, 'String')
            : call(sa(context, 'String'), [String(field.maxLength)]),
        py: 'str',
        needsSaType: false,
        fieldArgs:
          field.maxLength === undefined
            ? []
            : [`max_length=${String(field.maxLength)}`],
      };
    case 'text':
      return {
        sa: sa(context, 'Text'),
        py: 'str',
        needsSaType: true,
        fieldArgs: [],
      };
    case 'int':
      return {
        sa: sa(context, 'Integer'),
        py: 'int',
        needsSaType: false,
        fieldArgs: [],
      };
    case 'bigInt':
      return {
        sa: sa(context, 'BigInteger'),
        py: 'int',
        needsSaType: true,
        fieldArgs: [],
      };
    case 'float':
      return {
        sa: sa(context, 'Float'),
        py: 'float',
        needsSaType: false,
        fieldArgs: [],
      };
    case 'decimal': {
      const hasPrecision: boolean = field.maxDigits !== undefined;
      return {
        sa: hasPrecision
          ? call(sa(context, 'Numeric'), [
              String(field.maxDigits),
              String(field.decimalPlaces ?? 0),
            ])
          : sa(context, 'Numeric'),
        py: `${mod(context, 'decimal')}.Decimal`,
        needsSaType: false,
        fieldArgs: hasPrecision
          ? [
              `max_digits=${String(field.maxDigits)}`,
              `decimal_places=${String(field.decimalPlaces ?? 0)}`,
            ]
          : [],
      };
    }
    case 'boolean':
      return {
        sa: sa(context, 'Boolean'),
        py: 'bool',
        needsSaType: false,
        fieldArgs: [],
      };
    case 'dateTime':
      return {
        sa: call(sa(context, 'DateTime'), ['timezone=True']),
        py: `${mod(context, 'datetime')}.datetime`,
        needsSaType: true,
        fieldArgs: [],
      };
    case 'date':
      return {
        sa: sa(context, 'Date'),
        py: `${mod(context, 'datetime')}.date`,
        needsSaType: false,
        fieldArgs: [],
      };
    case 'time':
      return {
        sa: sa(context, 'Time'),
        py: `${mod(context, 'datetime')}.time`,
        needsSaType: false,
        fieldArgs: [],
      };
    case 'duration':
      return {
        sa: sa(context, 'Interval'),
        py: `${mod(context, 'datetime')}.timedelta`,
        needsSaType: false,
        fieldArgs: [],
      };
    case 'uuid':
      return {
        sa: sa(context, 'Uuid'),
        py: `${mod(context, 'uuid')}.UUID`,
        needsSaType: false,
        fieldArgs: [],
      };
    case 'json':
      context.typingImports.add('Any');
      return {
        // None means SQL NULL for a nullable column, not the JSON value null.
        sa: field.isNullable
          ? call(sa(context, 'JSON'), ['none_as_null=True'])
          : sa(context, 'JSON'),
        py: 'Any',
        needsSaType: true,
        fieldArgs: [],
      };
    case 'bytes':
      return {
        sa: sa(context, 'LargeBinary'),
        py: 'bytes',
        needsSaType: false,
        fieldArgs: [],
      };
    case 'ipAddress':
      return {
        sa: withSqliteFallback(
          context,
          call(`${pg(context, 'INET')}`, []),
          call(sa(context, 'String'), ['45'])
        ),
        py: 'str',
        needsSaType: true,
        fieldArgs: [],
      };
    case 'hstore':
      return {
        sa: withSqliteFallback(
          context,
          call(pg(context, 'HSTORE'), []),
          call(sa(context, 'JSON'), [])
        ),
        py: 'dict[str, str]',
        needsSaType: true,
        fieldArgs: [],
      };
    case 'range': {
      const entry: [string, string] | undefined =
        RANGE_TYPES[field.rangeOf ?? 'int'];
      if (field.rangeOf === undefined) {
        context.warnings.push(
          `${label}: the range field has no element type; it was written as INT4RANGE.`
        );
      }
      const [rangeName, element] = entry ?? ['INT4RANGE', 'int'];
      const elementModule: string = element.split('.')[0] ?? '';
      if (elementModule === 'decimal' || elementModule === 'datetime') {
        mod(context, elementModule);
      }
      return {
        sa: withSqliteFallback(
          context,
          call(pg(context, rangeName), []),
          call(sa(context, 'JSON'), [])
        ),
        py: `${pg(context, 'Range')}[${element}]`,
        needsSaType: true,
        fieldArgs: [],
      };
    }
    default:
      return {
        sa: sa(context, 'String'),
        py: 'str',
        needsSaType: false,
        fieldArgs: [],
      };
  }
}

/** Wraps the element type of an array column, one level per dimension. */
function columnType(
  context: EmitContext,
  model: IrModel,
  field: IrField
): TypeInfo {
  return collectTypes(context, () => arrayOrScalarType(context, model, field));
}

function arrayOrScalarType(
  context: EmitContext,
  model: IrModel,
  field: IrField
): Omit<TypeInfo, 'uses'> {
  const element: Omit<TypeInfo, 'uses'> = scalarType(context, model, field);
  const depth: number = field.arrayDepth ?? 0;
  if (depth === 0) {
    return element;
  }
  let py: string = element.py;
  for (let level: number = 0; level < depth; level += 1) {
    py = `list[${py}]`;
  }
  const arguments_: Node[] = [element.sa];
  if (depth > 1) {
    arguments_.push(`dimensions=${String(depth)}`);
  }
  return {
    sa: withSqliteFallback(
      context,
      call(sa(context, 'ARRAY'), arguments_),
      call(sa(context, 'JSON'), [])
    ),
    py,
    needsSaType: true,
    fieldArgs: [],
  };
}

/** The type of a foreign-key column: the type of the key it references. */
function keyColumnType(
  context: EmitContext,
  model: IrModel,
  key: ResolvedKey | undefined
): TypeInfo {
  if (key === undefined) {
    return collectTypes(context, () => ({
      sa: sa(context, 'Integer'),
      py: 'int',
      needsSaType: false,
      fieldArgs: [],
    }));
  }
  // A key never needs the autoincrement-friendly variant, and an enum or array key is rare enough to share the path.
  return columnType(context, model, { ...key.field });
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/** How a column's default is written in each style. */
interface DefaultInfo {
  /** `server_default=` expression. */
  server?: Node;
  /** SQLAlchemy `default=` expression (applied by Python when the column is omitted on insert). */
  client?: Node;
  /** SQLModel `Field(default=...)` source for a plain Python value. */
  literal?: string;
  /** SQLModel `Field(default_factory=...)`. */
  factory?: string;
  /** `onupdate=` expression. */
  onUpdate?: Node;
}

/** A Python expression for a JSON text, as a factory that returns a fresh value; undefined when it is not JSON. */
function jsonFactory(text: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (Array.isArray(parsed) && parsed.length === 0) {
    return 'list';
  }
  if (
    typeof parsed === 'object' &&
    parsed !== null &&
    !Array.isArray(parsed) &&
    Object.keys(parsed).length === 0
  ) {
    return 'dict';
  }
  return `lambda: ${pythonLiteral(parsed)}`;
}

function pythonLiteral(value: unknown): string {
  if (value === null) {
    return 'None';
  }
  if (typeof value === 'boolean') {
    return value ? 'True' : 'False';
  }
  if (typeof value === 'number') {
    return String(value);
  }
  if (typeof value === 'string') {
    return pyString(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(pythonLiteral).join(', ')}]`;
  }
  const entries: string[] = Object.entries(
    value as Record<string, unknown>
  ).map(
    ([key, entry]: [string, unknown]) =>
      `${pyString(key)}: ${pythonLiteral(entry)}`
  );
  return `{${entries.join(', ')}}`;
}

function literalDefault(
  context: EmitContext,
  model: IrModel,
  field: IrField,
  value: string | number | boolean
): DefaultInfo {
  const label: string = `${model.name}.${field.name}`;
  const isArray: boolean = (field.arrayDepth ?? 0) > 0;
  if (typeof value === 'boolean' || field.type === 'boolean') {
    const truth: boolean =
      typeof value === 'boolean'
        ? value
        : String(value).toLowerCase() === 'true';
    return {
      server: call(sa(context, truth ? 'true' : 'false'), []),
      literal: truth ? 'True' : 'False',
    };
  }
  if (isArray) {
    if (value === '[]' || value === '{}') {
      return { client: 'list', factory: 'list' };
    }
    context.warnings.push(
      `${label}: the array default ${pyString(String(value))} has no portable form and was dropped.`
    );
    return {};
  }
  if (field.type === 'json') {
    const text: string = String(value);
    const result: DefaultInfo = {
      server: call(sa(context, 'text'), [
        pyString(`'${text.replace(/'/g, "''")}'`),
      ]),
    };
    // SQLModel passes the Python default of every field to the INSERT, and a JSON column would
    // store its None as the JSON value null, so the same value is also given as a factory.
    const factory: string | undefined = jsonFactory(text);
    if (factory !== undefined) {
      result.factory = factory;
    }
    return result;
  }
  if (field.type === 'hstore') {
    return value === '{}' ? { client: 'dict', factory: 'dict' } : {};
  }
  const numeric: boolean =
    field.type === 'int' ||
    field.type === 'bigInt' ||
    field.type === 'float' ||
    field.type === 'decimal';
  if (numeric && /^-?\d+(\.\d+)?$/.test(String(value))) {
    return {
      server: call(sa(context, 'text'), [pyString(String(value))]),
      literal: field.type === 'decimal' ? undefined : String(value),
    };
  }
  const text: string = String(value);
  return {
    server: pyString(text),
    literal:
      field.type === 'string' || field.type === 'text'
        ? pyString(text)
        : undefined,
  };
}

function nowExpression(context: EmitContext, field: IrField): Node {
  const funcName: string = sa(context, 'func');
  if (field.type === 'date') {
    return `${funcName}.current_date()`;
  }
  if (field.type === 'time') {
    return `${funcName}.current_time()`;
  }
  return `${funcName}.now()`;
}

function defaultOf(
  context: EmitContext,
  model: IrModel,
  field: IrField
): DefaultInfo {
  const label: string = `${model.name}.${field.name}`;
  const result: DefaultInfo = {};
  const value: IrDefault | undefined = field.default;
  if (value !== undefined) {
    switch (value.kind) {
      case 'autoIncrement':
        break;
      case 'now':
        result.server = nowExpression(context, field);
        break;
      case 'uuid':
        result.client = `${mod(context, 'uuid')}.uuid4`;
        result.factory = `${mod(context, 'uuid')}.uuid4`;
        if (value.version !== undefined && value.version !== 4) {
          context.warnings.push(
            `${label}: the UUID version ${String(value.version)} default was written as uuid.uuid4.`
          );
        }
        break;
      case 'enumValue': {
        const info: EnumInfo | undefined = enumOf(context, field);
        const position: number =
          info?.definition.values.findIndex(
            (entry) => entry.name === value.value
          ) ?? -1;
        const member: IrEnum['values'][number] | undefined =
          info?.definition.values[position];
        if (info !== undefined && member !== undefined) {
          result.server = pyString(member.dbValue);
          result.literal = `${info.className}.${info.memberNames[position] ?? member.name}`;
        } else {
          context.warnings.push(
            `${label}: the enum default ${value.value} is not a member of the enum and was dropped.`
          );
        }
        break;
      }
      case 'literal':
        Object.assign(
          result,
          literalDefault(context, model, field, value.value)
        );
        break;
      case 'dbExpression':
        if (value.isFunction === true) {
          context.warnings.push(
            `${label}: the Prisma default function ${value.expression} has no equivalent here and was dropped.`
          );
        } else {
          result.server = call(sa(context, 'text'), [
            pyString(value.expression),
          ]);
        }
        break;
      default:
        break;
    }
  }
  if (field.isAutoUpdated) {
    result.onUpdate = nowExpression(context, field);
    if (result.server === undefined && result.client === undefined) {
      result.client = nowExpression(context, field);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Columns
// ---------------------------------------------------------------------------

/** Everything the two renderers need to know about one column. */
interface Column {
  attr: string;
  /** Database column name. */
  name: string;
  type: TypeInfo;
  isNullable: boolean;
  /** Written as `primary_key=True` on the column itself. */
  primaryKey: boolean;
  /** Autoincrement flag when it differs from SQLAlchemy's "auto". */
  autoincrement: boolean | undefined;
  isUnique: boolean;
  defaults: DefaultInfo;
  foreignKey: ForeignKeySpec | undefined;
}

interface ForeignKeySpec {
  target: string;
  onDelete: IrOnDelete;
  onUpdate: IrOnDelete | undefined;
  name: string | undefined;
}

const ACTIONS: Readonly<Record<IrOnDelete, string>> = {
  cascade: 'CASCADE',
  setNull: 'SET NULL',
  restrict: 'RESTRICT',
  noAction: 'NO ACTION',
  setDefault: 'SET DEFAULT',
};

function foreignKeyNode(context: EmitContext, spec: ForeignKeySpec): Node {
  const args: Node[] = [pyString(spec.target)];
  args.push(`ondelete=${pyString(ACTIONS[spec.onDelete])}`);
  if (spec.onUpdate !== undefined) {
    args.push(`onupdate=${pyString(ACTIONS[spec.onUpdate])}`);
  }
  if (spec.name !== undefined) {
    args.push(`name=${pyString(spec.name)}`);
  }
  return call(sa(context, 'ForeignKey'), args);
}

function hasSingleKey(model: IrModel): boolean {
  return (
    model.compositePrimaryKey === undefined &&
    model.primaryKeyName === undefined
  );
}

function modelHasPrimaryKey(model: IrModel): boolean {
  return (
    (model.compositePrimaryKey?.length ?? 0) > 0 ||
    model.fields.some((field: IrField) => field.isPrimaryKey) ||
    model.relations.some(
      (relation: IrRelation) => relation.isPrimaryKey === true
    )
  );
}

function scalarColumn(
  context: EmitContext,
  info: ClassInfo,
  field: IrField
): Column {
  const model: IrModel = info.model;
  const label: string = `${model.name}.${field.name}`;
  let type: TypeInfo = columnType(context, model, field);
  if (field.generated !== undefined) {
    context.warnings.push(
      `${label}: the computed column expression ${field.generated.expression} is not SQL and was dropped; the column was written as a plain column.`
    );
  }
  const isAutoKey: boolean =
    field.default?.kind === 'autoIncrement' &&
    (field.type === 'int' || field.type === 'bigInt');
  const singlePrimary: boolean = field.isPrimaryKey && hasSingleKey(model);
  if (field.type === 'bigInt' && isAutoKey && field.isPrimaryKey) {
    // SQLite only counts up an INTEGER PRIMARY KEY.
    type = {
      ...type,
      sa: call('BigInteger().with_variant', ['Integer', '"sqlite"']),
    };
    type.uses.sa.add('BigInteger').add('Integer');
  }
  if (field.default?.kind === 'autoIncrement' && !field.isPrimaryKey) {
    context.warnings.push(
      `${label}: an auto-increment default on a column that is not the primary key has no equivalent here and was dropped.`
    );
  }
  let autoincrement: boolean | undefined;
  if (isAutoKey && field.isPrimaryKey) {
    autoincrement = singlePrimary ? true : undefined;
  } else if (
    field.isPrimaryKey &&
    (field.type === 'int' || field.type === 'bigInt') &&
    (model.compositePrimaryKey === undefined ||
      model.compositePrimaryKey.length === 0)
  ) {
    autoincrement = false;
  }
  return {
    attr: info.fieldAttrs.get(field.name) ?? field.name,
    name: field.columnName,
    type,
    isNullable: field.isNullable && !field.isPrimaryKey,
    primaryKey: singlePrimary,
    autoincrement,
    isUnique:
      field.isUnique && !field.isPrimaryKey && field.uniqueName === undefined,
    defaults: defaultOf(context, model, field),
    foreignKey: undefined,
  };
}

function relationColumn(
  context: EmitContext,
  info: ClassInfo,
  relation: IrRelation
): Column {
  const link: Link | undefined = context.links.find(
    (candidate: Link) =>
      candidate.owner === info &&
      candidate.name === relation.name &&
      candidate.kind !== 'manyToMany'
  );
  const target: ClassInfo | undefined = link?.target;
  const key: ResolvedKey | undefined =
    target === undefined || relation.kind === 'manyToMany'
      ? undefined
      : resolveKey(context, target.model.name, relation.toField);
  const type: TypeInfo = keyColumnType(context, info.model, key);
  let onDelete: IrOnDelete = relation.onDelete;
  if (onDelete === 'setNull' && !relation.isNullable) {
    context.warnings.push(
      `${info.model.name}.${relation.name}: onDelete SetNull needs a nullable column; it was written as RESTRICT.`
    );
    onDelete = 'restrict';
  }
  const asKey: boolean = isKeyRelation(info.model, relation);
  const foreignKey: ForeignKeySpec | undefined =
    link === undefined
      ? undefined
      : {
          target: `${link.target.model.tableName}.${link.remoteColumns[0] ?? 'id'}`,
          onDelete,
          onUpdate: relation.onUpdate,
          name: relation.constraintName,
        };
  return {
    attr: info.columnAttrs.get(relation.name) ?? relation.columnName,
    name: relation.columnName,
    type,
    isNullable: relation.isNullable && !asKey,
    primaryKey:
      relation.isPrimaryKey === true &&
      hasSingleKey(info.model) &&
      info.model.fields.every((field: IrField) => !field.isPrimaryKey),
    autoincrement: undefined,
    isUnique:
      relation.kind === 'oneToOne' && relation.isPrimaryKey !== true && !asKey,
    defaults: {},
    foreignKey,
  };
}

// ---------------------------------------------------------------------------
// Rendering of a column: SQLAlchemy style
// ---------------------------------------------------------------------------

function annotationOf(
  context: EmitContext,
  column: Column,
  nullable: boolean
): string {
  return nullable ? optional(context, column.type.py) : column.type.py;
}

/** `name=value`, keeping a long call as the value breakable. */
function keyword(name: string, value: Node): Node {
  return typeof value === 'string'
    ? `${name}=${value}`
    : group(`${name}=${value.open}`, value.items, value.close);
}

function serverDefaultArgument(server: Node): Node {
  return keyword('server_default', server);
}

function sqlAlchemyColumn(context: EmitContext, column: Column): string {
  const args: Node[] = [];
  if (column.attr !== column.name) {
    args.push(pyString(column.name));
  }
  commitTypes(context, column.type);
  args.push(column.type.sa);
  if (column.foreignKey !== undefined) {
    args.push(foreignKeyNode(context, column.foreignKey));
  }
  if (column.primaryKey) {
    args.push('primary_key=True');
  }
  if (column.autoincrement !== undefined) {
    args.push(`autoincrement=${column.autoincrement ? 'True' : 'False'}`);
  }
  if (column.isUnique) {
    args.push('unique=True');
  }
  if (column.defaults.client !== undefined) {
    args.push(`default=${flat(column.defaults.client)}`);
  }
  if (column.defaults.server !== undefined) {
    args.push(serverDefaultArgument(column.defaults.server));
  }
  if (column.defaults.onUpdate !== undefined) {
    args.push(`onupdate=${flat(column.defaults.onUpdate)}`);
  }
  const annotation: string = `${framework(context, 'Mapped')}[${annotationOf(context, column, column.isNullable)}]`;
  return statement(
    call(
      `${column.attr}: ${annotation} = ${framework(context, 'mapped_column')}`,
      args
    ),
    1
  );
}

// ---------------------------------------------------------------------------
// Rendering of a column: SQLModel style
// ---------------------------------------------------------------------------

function isPlainAction(action: IrOnDelete): boolean {
  return action === 'cascade' || action === 'setNull' || action === 'restrict';
}

function sqlModelColumn(context: EmitContext, column: Column): string {
  const fk: ForeignKeySpec | undefined = column.foreignKey;
  // `Field` knows foreign_key and ondelete, but not onupdate, a constraint name or NO ACTION.
  const needsColumn: boolean =
    fk !== undefined &&
    (fk.onUpdate !== undefined ||
      fk.name !== undefined ||
      !isPlainAction(fk.onDelete));
  const args: Node[] = [];

  // What the constructor sees, and the nullability SQLModel derives from it.
  let defaultIsNone: boolean = false;
  if (column.defaults.factory !== undefined) {
    args.push(`default_factory=${column.defaults.factory}`);
  } else if (column.defaults.literal !== undefined) {
    args.push(`default=${column.defaults.literal}`);
  } else if (
    column.isNullable ||
    (column.primaryKey && column.autoincrement === true) ||
    column.defaults.server !== undefined ||
    column.defaults.client !== undefined ||
    column.defaults.onUpdate !== undefined
  ) {
    // The column is optional, or the database (or the ORM) fills the value in.
    args.push('default=None');
    defaultIsNone = true;
  }
  const derivedNullable: boolean = !column.primaryKey && defaultIsNone;
  const optionalAnnotation: boolean = defaultIsNone || column.isNullable;

  if (needsColumn && fk !== undefined) {
    commitTypes(context, column.type);
    const parts: Node[] = [
      pyString(column.name),
      column.type.sa,
      foreignKeyNode(context, fk),
    ];
    if (column.primaryKey) {
      parts.push('primary_key=True');
    }
    parts.push(`nullable=${column.isNullable ? 'True' : 'False'}`);
    if (column.isUnique) {
      parts.push('unique=True');
    }
    if (
      column.defaults.client !== undefined &&
      column.defaults.factory === undefined
    ) {
      parts.push(`default=${flat(column.defaults.client)}`);
    }
    if (column.defaults.server !== undefined) {
      parts.push(serverDefaultArgument(column.defaults.server));
    }
    if (column.defaults.onUpdate !== undefined) {
      parts.push(`onupdate=${flat(column.defaults.onUpdate)}`);
    }
    args.push(call(`sa_column=${sa(context, 'Column')}`, parts));
  } else {
    if (column.primaryKey) {
      args.push('primary_key=True');
    }
    if (fk !== undefined) {
      args.push(
        `foreign_key=${pyString(fk.target)}`,
        `ondelete=${pyString(ACTIONS[fk.onDelete])}`
      );
    }
    if (!column.primaryKey && derivedNullable !== column.isNullable) {
      args.push(`nullable=${column.isNullable ? 'True' : 'False'}`);
    }
    if (column.isUnique) {
      args.push('unique=True');
    }
    args.push(...column.type.fieldArgs);
    if (column.type.needsSaType) {
      commitTypes(context, column.type);
      args.push(keyword('sa_type', column.type.sa));
    }
    const kwargs: Node[] = [];
    if (column.name !== column.attr) {
      kwargs.push(`"name": ${pyString(column.name)}`);
    }
    if (column.autoincrement === false) {
      kwargs.push('"autoincrement": False');
    }
    if (
      column.defaults.client !== undefined &&
      column.defaults.factory === undefined
    ) {
      kwargs.push(`"default": ${flat(column.defaults.client)}`);
    }
    if (column.defaults.server !== undefined) {
      kwargs.push(`"server_default": ${flat(column.defaults.server)}`);
    }
    if (column.defaults.onUpdate !== undefined) {
      kwargs.push(`"onupdate": ${flat(column.defaults.onUpdate)}`);
    }
    if (kwargs.length > 0) {
      args.push(group('sa_column_kwargs={', kwargs, '}'));
    }
  }
  const annotation: string = annotationOf(context, column, optionalAnnotation);
  if (args.length === 0) {
    return `${INDENT}${column.attr}: ${annotation}`;
  }
  framework(context, 'Field');
  return statement(call(`${column.attr}: ${annotation} = Field`, args), 1);
}

// ---------------------------------------------------------------------------
// Relationships
// ---------------------------------------------------------------------------

function columnListExpression(info: ClassInfo, attrs: string[]): string {
  return `[${attrs.map((attr: string) => `${info.className}.${attr}`).join(', ')}]`;
}

function relationshipArguments(
  context: EmitContext,
  link: Link,
  side: 'forward' | 'reverse'
): Node[] {
  const kwargs: Node[] = [];
  const back: string = side === 'forward' ? link.reverseAttr : link.forwardAttr;
  if (link.association !== undefined) {
    const association: Association = link.association;
    kwargs.push(`secondary=${association.variable}`);
    if (link.selfReference) {
      const from: string =
        side === 'forward' ? association.ownerColumn : association.targetColumn;
      const to: string =
        side === 'forward' ? association.targetColumn : association.ownerColumn;
      const keyAttr: string = association.ownerKey?.attr ?? 'id';
      const cls: string = link.owner.className;
      kwargs.push(
        `primaryjoin=lambda: ${cls}.${keyAttr} == ${association.variable}.c.${from}`,
        `secondaryjoin=lambda: ${cls}.${keyAttr} == ${association.variable}.c.${to}`
      );
    }
    return orderKwargs(context, back, kwargs);
  }
  if (link.ambiguous) {
    kwargs.push(
      `foreign_keys=${pyString(columnListExpression(link.owner, link.localAttrs))}`
    );
  }
  if (side === 'forward' && link.selfReference) {
    kwargs.push(
      `remote_side=${pyString(link.remoteAttrs.length === 1 ? `${link.target.className}.${link.remoteAttrs[0] ?? 'id'}` : columnListExpression(link.target, link.remoteAttrs))}`
    );
  }
  if (
    side === 'reverse' &&
    (link.onDelete === 'cascade' || link.onDelete === 'setNull')
  ) {
    kwargs.push('passive_deletes=True');
  }
  return orderKwargs(context, back, kwargs);
}

function orderKwargs(
  _context: EmitContext,
  back: string,
  kwargs: Node[]
): Node[] {
  return [`back_populates=${pyString(back)}`, ...kwargs];
}

function relationshipStatement(
  context: EmitContext,
  link: Link,
  side: 'forward' | 'reverse'
): string {
  const attr: string = side === 'forward' ? link.forwardAttr : link.reverseAttr;
  const targetClass: string =
    side === 'forward' ? link.target.className : link.owner.className;
  const collection: boolean =
    link.kind === 'manyToMany' ||
    (side === 'reverse' && link.kind === 'foreignKey');
  const nullable: boolean =
    side === 'forward'
      ? link.isNullable && link.kind !== 'manyToMany'
      : link.kind === 'oneToOne';
  const reference: string = pyString(targetClass);
  const annotation: string = collection
    ? `list[${reference}]`
    : nullable
      ? optional(context, reference)
      : reference;
  const args: Node[] = relationshipArguments(context, link, side);
  if (context.style === 'sqlmodel') {
    const direct: Node[] = [args[0] ?? ''];
    const extra: Node[] = args.slice(1).map((entry: Node): Node => {
      const text: string = flat(entry);
      const separator: number = text.indexOf('=');
      const name: string = text.slice(0, separator);
      return `${pyString(name)}: ${text.slice(separator + 1)}`;
    });
    if (extra.length > 0) {
      direct.push(group('sa_relationship_kwargs={', extra, '}'));
    }
    framework(context, 'Relationship');
    return statement(call(`${attr}: ${annotation} = Relationship`, direct), 1);
  }
  const mappedAnnotation: string = `${framework(context, 'Mapped')}[${annotation}]`;
  return statement(
    call(
      `${attr}: ${mappedAnnotation} = ${framework(context, 'relationship')}`,
      args
    ),
    1
  );
}

// ---------------------------------------------------------------------------
// Constraints and indexes
// ---------------------------------------------------------------------------

function columnNameOf(info: ClassInfo, name: string): string[] {
  const field: IrField | undefined = info.model.fields.find(
    (candidate: IrField) => candidate.name === name
  );
  if (field !== undefined) {
    return [field.columnName];
  }
  const relation: IrRelation | undefined = info.model.relations.find(
    (candidate: IrRelation) =>
      candidate.kind !== 'manyToMany' && candidate.name === name
  );
  if (relation !== undefined) {
    return [relation.columnName];
  }
  const composite: IrCompositeForeignKey | undefined = (
    info.model.compositeForeignKeys ?? []
  ).find((candidate: IrCompositeForeignKey) => candidate.name === name);
  if (composite !== undefined) {
    return composite.fields.flatMap((fieldName: string) =>
      columnNameOf(info, fieldName)
    );
  }
  return [name];
}

function tableArguments(context: EmitContext, info: ClassInfo): Node[] {
  const model: IrModel = info.model;
  const items: Node[] = [];

  if (!hasSingleKey(model) && modelHasPrimaryKey(model)) {
    const keyNames: string[] = model.compositePrimaryKey ?? [
      ...model.fields
        .filter((field: IrField) => field.isPrimaryKey)
        .map((field: IrField) => field.name),
      ...model.relations
        .filter((relation: IrRelation) => relation.isPrimaryKey === true)
        .map((relation: IrRelation) => relation.name),
    ];
    const columns: string[] = keyNames.flatMap((name: string) =>
      columnNameOf(info, name)
    );
    const args: Node[] = columns.map(pyString);
    if (model.primaryKeyName !== undefined) {
      args.push(`name=${pyString(model.primaryKeyName)}`);
    }
    items.push(call(sa(context, 'PrimaryKeyConstraint'), args));
  }

  for (const link of context.links) {
    if (link.owner !== info || !link.composite) {
      continue;
    }
    const args: Node[] = [
      group('[', link.localColumns.map(pyString), ']'),
      group(
        '[',
        link.remoteColumns.map((column: string) =>
          pyString(`${link.target.model.tableName}.${column}`)
        ),
        ']'
      ),
    ];
    if (link.constraintName !== undefined) {
      args.push(`name=${pyString(link.constraintName)}`);
    }
    args.push(`ondelete=${pyString(ACTIONS[link.onDelete])}`);
    if (link.onUpdate !== undefined) {
      args.push(`onupdate=${pyString(ACTIONS[link.onUpdate])}`);
    }
    items.push(call(sa(context, 'ForeignKeyConstraint'), args));
  }

  for (const field of model.fields) {
    if (
      field.isUnique &&
      !field.isPrimaryKey &&
      field.uniqueName !== undefined
    ) {
      const name: string = field.uniqueName;
      context.constraintNames.add(name);
      items.push(
        call(sa(context, 'UniqueConstraint'), [
          pyString(field.columnName),
          `name=${pyString(name)}`,
        ])
      );
    }
  }

  for (const index of model.indexes) {
    items.push(indexNode(context, info, index));
  }
  return items;
}

function indexNode(
  context: EmitContext,
  info: ClassInfo,
  index: IrIndex
): Node {
  const columns: string[] = index.fields.flatMap((name: string) =>
    columnNameOf(info, name)
  );
  const table: string = info.model.tableName;
  const prefix: string = index.isUnique ? 'uq' : 'ix';
  const requested: string =
    index.name ?? `${prefix}_${table}_${columns.join('_')}`;
  const name: string = uniqueName(
    limitIdentifier(requested, 63),
    context.constraintNames
  );
  if (index.isUnique) {
    return call(sa(context, 'UniqueConstraint'), [
      ...columns.map(pyString),
      `name=${pyString(name)}`,
    ]);
  }
  return call(sa(context, 'Index'), [pyString(name), ...columns.map(pyString)]);
}

// ---------------------------------------------------------------------------
// Classes
// ---------------------------------------------------------------------------

function renderClass(context: EmitContext, info: ClassInfo): string {
  const model: IrModel = info.model;
  const lines: string[] = [];
  lines.push(
    context.style === 'sqlmodel'
      ? `class ${info.className}(SQLModel, table=True):`
      : `class ${info.className}(Base):`
  );
  lines.push(`${INDENT}__tablename__ = ${pyString(model.tableName)}`);

  const tableArgs: Node[] = tableArguments(context, info);
  const hasKey: boolean = modelHasPrimaryKey(model);
  const columns: Column[] = [];
  for (const field of model.fields) {
    columns.push(scalarColumn(context, info, field));
  }
  const foreignColumns: Column[] = [];
  for (const relation of model.relations) {
    if (relation.kind === 'manyToMany') {
      continue;
    }
    foreignColumns.push(relationColumn(context, info, relation));
  }

  const postgresOnly: string[] = model.fields
    .filter(
      (field: IrField) =>
        (field.arrayDepth ?? 0) > 0 ||
        field.type === 'hstore' ||
        field.type === 'range' ||
        field.type === 'ipAddress'
    )
    .map((field: IrField) => field.name);
  if (postgresOnly.length > 0) {
    context.warnings.push(
      `${model.name}.${postgresOnly.join(', ')}: array, HSTORE, range and IP address columns are PostgreSQL types; they fall back to JSON (or a string) on SQLite.`
    );
  }

  if (!hasKey) {
    context.warnings.push(
      `${model.name}: the table has no primary key, which ${context.style === 'sqlmodel' ? 'SQLModel' : 'the SQLAlchemy ORM'} requires; ${context.style === 'sqlmodel' ? 'the first column was marked as the primary key' : 'every required column was declared as the mapper key (the table itself keeps no primary key)'}.`
    );
  }

  const mapperKey: string[] = [];
  const all: Column[] = [...columns, ...foreignColumns];
  if (!hasKey && all.length > 0) {
    if (context.style === 'sqlmodel') {
      const first: Column | undefined = all[0];
      if (first !== undefined) {
        first.primaryKey = true;
      }
    } else {
      const required: Column[] = all.filter(
        (column: Column) => !column.isNullable
      );
      for (const column of required.length > 0 ? required : all) {
        mapperKey.push(column.attr);
      }
    }
  }

  const body: string[] = [];
  for (const column of all) {
    body.push(
      context.style === 'sqlmodel'
        ? sqlModelColumn(context, column)
        : sqlAlchemyColumn(context, column)
    );
  }
  const relationships: string[] = [];
  for (const link of context.links) {
    if (link.owner === info) {
      relationships.push(relationshipStatement(context, link, 'forward'));
    }
  }
  for (const link of info.incoming) {
    relationships.push(relationshipStatement(context, link, 'reverse'));
  }

  if (tableArgs.length > 0) {
    lines.push(
      statement(
        {
          open: '__table_args__ = (',
          items: tableArgs,
          close: ')',
          force: true,
        },
        1
      )
    );
  }
  if (mapperKey.length > 0) {
    lines.push(
      `${INDENT}__mapper_args__ = {"primary_key": [${mapperKey.join(', ')}]}`
    );
  }
  lines.push('');
  lines.push(...body);
  if (relationships.length > 0) {
    lines.push('', ...relationships);
  }
  if (body.length === 0 && relationships.length === 0) {
    lines.push(`${INDENT}pass`);
  }
  while (lines[lines.length - 1] === '') {
    lines.pop();
  }
  return lines.join('\n');
}

function renderAssociation(
  context: EmitContext,
  association: Association
): string {
  const key = (
    column: string,
    resolved: ResolvedKey | undefined,
    table: string | undefined
  ): Node => {
    const target: string = `${table ?? 'unknown'}.${resolved?.columnName ?? 'id'}`;
    return call(sa(context, 'Column'), [
      pyString(column),
      call(sa(context, 'ForeignKey'), [pyString(target), 'ondelete="CASCADE"']),
      'primary_key=True',
    ]);
  };
  const link: Link | undefined = context.links.find(
    (candidate: Link) => candidate.association === association
  );
  const node: Group = call(
    `${association.variable} = ${sa(context, 'Table')}`,
    [
      pyString(association.tableName),
      metadataExpression(context),
      key(
        association.ownerColumn,
        association.ownerKey,
        link?.owner.model.tableName
      ),
      key(
        association.targetColumn,
        association.targetKey,
        link?.target.model.tableName
      ),
    ]
  );
  return statement(node, 0);
}

function renderView(context: EmitContext, model: IrModel): string {
  context.warnings.push(
    `${model.name}: this is a database view; SQLAlchemy has no declarative view, so it was written as a comment. Create the view in the database and reflect it (Table(${pyString(model.tableName)}, ${metadataExpression(context)}, autoload_with=engine)).`
  );
  const lines: string[] = [
    `# View ${model.name} (${model.tableName}) is not mapped: SQLAlchemy has no declarative view construct.`,
    `# Create the view in the database, then reflect it with`,
    `#     Table(${pyString(model.tableName)}, ${metadataExpression(context)}, autoload_with=engine)`,
    `# Columns: ${model.fields.map((field: IrField) => field.columnName).join(', ') || '(none)'}`,
  ];
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

function importLine(module: string, names: string[]): string {
  // isort's default: CONSTANTS first, then Classes, then functions.
  const rank = (name: string): number =>
    /^[A-Z0-9_]+$/.test(name) && name.length > 1
      ? 0
      : /^[A-Z]/.test(name)
        ? 1
        : 2;
  const sorted: string[] = [...names].sort(
    (first: string, second: string) =>
      rank(first) - rank(second) || first.localeCompare(second, 'en')
  );
  const inline: string = `from ${module} import ${sorted.join(', ')}`;
  if (inline.length <= MAX_LINE_WIDTH) {
    return inline;
  }
  return `from ${module} import (\n${sorted.map((name: string) => `${INDENT}${name},`).join('\n')}\n)`;
}

function buildImports(context: EmitContext): string {
  const standard: string[] = [...context.modules]
    .sort()
    .map((name: string) => `import ${name}`);
  if (context.typingImports.size > 0) {
    standard.push(importLine('typing', [...context.typingImports]));
  }
  const thirdParty: string[] = [];
  if (context.saImports.size > 0) {
    thirdParty.push(importLine('sqlalchemy', [...context.saImports]));
  }
  if (context.pgImports.size > 0) {
    thirdParty.push(
      importLine('sqlalchemy.dialects.postgresql', [...context.pgImports])
    );
  }
  if (context.style === 'sqlalchemy') {
    if (context.frameworkImports.size > 0) {
      thirdParty.push(
        importLine('sqlalchemy.orm', [...context.frameworkImports])
      );
    }
  } else {
    const names: Set<string> = new Set<string>(context.frameworkImports);
    names.add('SQLModel');
    thirdParty.push(importLine('sqlmodel', [...names]));
  }
  return [standard.join('\n'), thirdParty.join('\n')]
    .filter((block: string) => block !== '')
    .join('\n\n');
}
