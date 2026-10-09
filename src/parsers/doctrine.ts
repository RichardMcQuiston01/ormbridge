import type Parser from 'web-tree-sitter';
import type {
  IrDefault,
  IrEnum,
  IrEnumValue,
  IrField,
  IrIndex,
  IrModel,
  IrOnDelete,
  IrRelation,
  IrScalarType,
  IrSchema,
} from '../ir.js';
import { toCamelCase, toSnakeCase } from '../naming.js';
import { err, ok, type Result } from '../result.js';
import {
  attributesOf,
  collectDeclarations,
  getPhpParser,
  lastNameSegment,
  readEnumDeclaration,
  resolveClassName,
  typeOf,
  type EnumInfo,
  type FileContext,
  type PhpAttribute,
  type PhpNew,
  type PhpTypeInfo,
  type PhpValue,
  type SyntaxNode,
} from './phpSyntax.js';

export interface DoctrineSourceFile {
  path: string;
  text: string;
}

export interface DoctrineParseOptions {
  /** App label stored on each model (Doctrine itself has no equivalent). */
  appLabel: string;
}

// ---------------------------------------------------------------------------
// Static tables
// ---------------------------------------------------------------------------

const MAPPING_NAMESPACE: string = 'Doctrine\\ORM\\Mapping\\';

/** Doctrine DBAL type names mapped to the IR scalar type. */
const DBAL_TYPES: Readonly<Record<string, IrScalarType>> = {
  string: 'string',
  ascii_string: 'string',
  text: 'text',
  integer: 'int',
  smallint: 'int',
  bigint: 'bigInt',
  boolean: 'boolean',
  decimal: 'decimal',
  number: 'decimal',
  float: 'float',
  smallfloat: 'float',
  datetime: 'dateTime',
  datetime_immutable: 'dateTime',
  datetimetz: 'dateTime',
  datetimetz_immutable: 'dateTime',
  date: 'date',
  date_immutable: 'date',
  time: 'time',
  time_immutable: 'time',
  dateinterval: 'duration',
  json: 'json',
  json_array: 'json',
  jsonb: 'json',
  array: 'json',
  object: 'json',
  simple_array: 'text',
  binary: 'bytes',
  blob: 'bytes',
  guid: 'uuid',
  uuid: 'uuid',
  ulid: 'string',
  enum: 'string',
};

/** DBAL types whose storage differs from the IR type in a way worth telling the user about. */
const APPROXIMATED_TYPES: Readonly<Record<string, string>> = {
  array:
    'is stored as PHP-serialized text; the IR has no equivalent, so it was converted to json',
  object:
    'is stored as PHP-serialized text; the IR has no equivalent, so it was converted to json',
  simple_array:
    'is stored as comma-separated text; the IR has no array type, so it was converted to text',
  ulid: 'is stored as a 26 character string; it was converted to a string column',
};

/** Constants of `Doctrine\DBAL\Types\Types`, mapped to the type name they hold. */
const TYPE_CONSTANTS: Readonly<Record<string, string>> = {
  STRING: 'string',
  ASCII_STRING: 'ascii_string',
  TEXT: 'text',
  INTEGER: 'integer',
  SMALLINT: 'smallint',
  BIGINT: 'bigint',
  BOOLEAN: 'boolean',
  DECIMAL: 'decimal',
  NUMBER: 'number',
  FLOAT: 'float',
  SMALLFLOAT: 'smallfloat',
  DATETIME_MUTABLE: 'datetime',
  DATETIME_IMMUTABLE: 'datetime_immutable',
  DATETIMETZ_MUTABLE: 'datetimetz',
  DATETIMETZ_IMMUTABLE: 'datetimetz_immutable',
  DATE_MUTABLE: 'date',
  DATE_IMMUTABLE: 'date_immutable',
  TIME_MUTABLE: 'time',
  TIME_IMMUTABLE: 'time_immutable',
  DATEINTERVAL: 'dateinterval',
  JSON: 'json',
  ARRAY: 'array',
  SIMPLE_ARRAY: 'simple_array',
  OBJECT: 'object',
  BINARY: 'binary',
  BLOB: 'blob',
  GUID: 'guid',
  ENUM: 'enum',
  // Constants of the legacy `Doctrine\DBAL\Types\Type` class.
  DATETIME: 'datetime',
  DATETIMETZ: 'datetimetz',
  TARRAY: 'array',
  JSON_ARRAY: 'json_array',
};

/** Type names Doctrine infers from a PHP property type when `#[ORM\Column]` omits `type`. */
const PHP_TYPE_TO_DBAL: Readonly<Record<string, string>> = {
  int: 'integer',
  string: 'string',
  bool: 'boolean',
  float: 'float',
  array: 'json',
  datetime: 'datetime',
  datetimeimmutable: 'datetime_immutable',
  dateinterval: 'dateinterval',
};

const ON_DELETE_MAP: Readonly<Record<string, IrOnDelete>> = {
  CASCADE: 'cascade',
  'SET NULL': 'setNull',
  RESTRICT: 'restrict',
  'NO ACTION': 'noAction',
  'SET DEFAULT': 'setDefault',
};

const NOW_SQL: RegExp =
  /^(now\(\)|current_timestamp(\(\d*\))?|getdate\(\)|sysdate|systimestamp|localtimestamp(\(\d*\))?|datetime\('now'\)|\(datetime\('now'\)\))$/i;
const UUID_SQL: RegExp =
  /^(uuid_generate_v[14]\(\)|gen_random_uuid\(\)|uuid\(\)|newid\(\)|newsequentialid\(\)|sys_guid\(\))$/i;

const RELATION_ATTRIBUTES: ReadonlySet<string> = new Set([
  'ManyToOne',
  'OneToOne',
  'OneToMany',
  'ManyToMany',
]);

/** Positional parameter order of each attribute constructor (Doctrine ORM 3). */
const PARAMETER_ORDER: Readonly<Record<string, readonly string[]>> = {
  Entity: ['repositoryClass', 'readOnly'],
  Table: ['name', 'schema', 'indexes', 'uniqueConstraints', 'options'],
  Index: ['name', 'columns', 'fields', 'flags', 'options'],
  UniqueConstraint: ['name', 'columns', 'fields', 'options'],
  Column: [
    'name',
    'type',
    'length',
    'precision',
    'scale',
    'unique',
    'nullable',
    'insertable',
    'updatable',
    'enumType',
    'options',
    'columnDefinition',
    'generated',
    'index',
  ],
  GeneratedValue: ['strategy'],
  CustomIdGenerator: ['class'],
  SequenceGenerator: ['sequenceName', 'allocationSize', 'initialValue'],
  JoinColumn: [
    'name',
    'referencedColumnName',
    'deferrable',
    'unique',
    'nullable',
    'onDelete',
    'columnDefinition',
    'fieldName',
    'foreignKeyName',
    'options',
  ],
  JoinTable: [
    'name',
    'schema',
    'foreignKeyName',
    'inverseForeignKeyName',
    'options',
  ],
  ManyToOne: ['targetEntity', 'cascade', 'fetch', 'inversedBy'],
  OneToOne: [
    'targetEntity',
    'mappedBy',
    'inversedBy',
    'cascade',
    'fetch',
    'orphanRemoval',
  ],
  OneToMany: [
    'mappedBy',
    'targetEntity',
    'cascade',
    'fetch',
    'orphanRemoval',
    'indexBy',
  ],
  ManyToMany: [
    'targetEntity',
    'mappedBy',
    'inversedBy',
    'cascade',
    'fetch',
    'orphanRemoval',
    'indexBy',
  ],
  Embedded: ['class', 'columnPrefix'],
  InheritanceType: ['value'],
  DiscriminatorColumn: [
    'name',
    'type',
    'length',
    'columnDefinition',
    'enumType',
    'options',
  ],
  DiscriminatorMap: ['value'],
};

/** Mapping attributes that carry no schema information and are skipped without a warning. */
const IGNORED_ATTRIBUTES: ReadonlySet<string> = new Set([
  'HasLifecycleCallbacks',
  'ChangeTrackingPolicy',
  'EntityListeners',
  'EntityListener',
  'Cache',
  'OrderBy',
  'PrePersist',
  'PostPersist',
  'PreUpdate',
  'PostUpdate',
  'PreRemove',
  'PostRemove',
  'PostLoad',
  'PreFlush',
  'ReadOnly',
]);

/** Attributes that define schema we cannot represent; each produces a warning. */
const UNSUPPORTED_ATTRIBUTES: Readonly<Record<string, string>> = {
  AttributeOverride: 'attribute overrides are not supported',
  AttributeOverrides: 'attribute overrides are not supported',
  AssociationOverride: 'association overrides are not supported',
  AssociationOverrides: 'association overrides are not supported',
  NamedQuery: 'named queries are not part of the schema',
  NamedNativeQuery: 'named queries are not part of the schema',
  SqlResultSetMapping: 'result set mappings are not part of the schema',
};

/** Column options handled elsewhere or known to have no IR equivalent. */
const UNSUPPORTED_COLUMN_OPTIONS: Readonly<Record<string, string>> = {
  unsigned: 'unsigned integers',
  comment: 'a column comment',
  collation: 'a collation',
  charset: 'a character set',
  fixed: 'a fixed-length (CHAR) column',
  check: 'a column check constraint',
  autoincrement: 'an explicit autoincrement flag',
  version: 'a version flag',
};

/** Symfony UID id generators that map onto IR defaults. */
const UUID_GENERATORS: ReadonlySet<string> = new Set([
  'Symfony\\Bridge\\Doctrine\\IdGenerator\\UuidGenerator',
  'Ramsey\\Uuid\\Doctrine\\UuidGenerator',
]);
const ULID_GENERATORS: ReadonlySet<string> = new Set([
  'Symfony\\Bridge\\Doctrine\\IdGenerator\\UlidGenerator',
]);

// ---------------------------------------------------------------------------
// Intermediate (per-class) structures
// ---------------------------------------------------------------------------

interface RawIndex {
  /** Database column names (`columns`) or property names (`fields`). */
  refs: string[];
  isUnique: boolean;
  name?: string;
  flags: string[];
}

interface RelationMember {
  kind: 'relation';
  /** `targetModel` holds the target's fully qualified class name until the schema is assembled. */
  relation: IrRelation;
  /** True when the source declared `nullable` on the join column explicitly. */
  hasExplicitNullable: boolean;
}

interface InverseMember {
  kind: 'inverse';
  property: string;
  targetFqn: string;
  mappedBy?: string;
  relationKind: 'oneToMany' | 'oneToOne' | 'manyToMany';
}

interface EmbeddedMember {
  kind: 'embedded';
  property: string;
  classFqn: string;
  /** Explicit prefix string, `false` for none, or undefined for the property name. */
  prefix: string | false | undefined;
}

type Member =
  | { kind: 'field'; field: IrField }
  | RelationMember
  | InverseMember
  | EmbeddedMember;

type ClassRole = 'entity' | 'mappedSuperclass' | 'embeddable' | 'plain';
type InheritanceKind = 'SINGLE_TABLE' | 'JOINED' | 'NONE';

interface RawClass {
  name: string;
  fqn: string;
  ctx: FileContext;
  isTrait: boolean;
  isAbstract: boolean;
  role: ClassRole;
  tableName?: string;
  parentFqn?: string;
  traitFqns: string[];
  members: Member[];
  indexes: RawIndex[];
  inheritanceType?: InheritanceKind;
  discriminatorName?: string;
  discriminatorType?: string;
  discriminatorLength?: number;
  discriminatorMapSize: number;
  /** True when the class carries at least one Doctrine mapping attribute on a property. */
  hasMappedProperties: boolean;
}

interface Collected {
  fields: IrField[];
  relations: RelationMember[];
  inverses: InverseMember[];
  indexes: RawIndex[];
}

interface MappingAttribute {
  /** Doctrine attribute name without the namespace, for example "Column". */
  name: string;
  attribute: PhpAttribute;
  /** Positional and named arguments merged by parameter name. */
  args: Record<string, PhpValue>;
}

interface PropertyInfo {
  name: string;
  attributes: PhpAttribute[];
  type: PhpTypeInfo | undefined;
}

interface ParseState {
  enums: Map<string, EnumInfo>;
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/** Parses Doctrine ORM entity files (PHP 8 attributes) into the shared IR using tree-sitter. */
export async function parseDoctrine(
  sources: DoctrineSourceFile[],
  options: DoctrineParseOptions
): Promise<Result<IrSchema>> {
  const parserResult: Result<Parser> = await getPhpParser();
  if (!parserResult.ok) {
    return parserResult;
  }
  const parser: Parser = parserResult.value;

  const warnings: string[] = [];
  const state: ParseState = { enums: new Map(), warnings };
  const parsedFiles: {
    source: DoctrineSourceFile;
    declarations: { ctx: FileContext; node: SyntaxNode }[];
  }[] = [];
  let annotationFiles: string[] = [];

  for (const source of sources) {
    const tree: Parser.Tree = parser.parse(source.text);
    if (tree.rootNode.hasError) {
      warnings.push(
        `${source.path}: the file contains PHP syntax errors; some entities or columns may be missing from the output.`
      );
    }
    if (usesDocblockAnnotations(tree.rootNode)) {
      annotationFiles = [...annotationFiles, source.path];
      warnings.push(
        `${source.path}: Doctrine docblock annotations (such as @ORM\\Entity) are not supported yet; ` +
          `convert them to PHP 8 attributes (#[ORM\\Entity]). Annotated classes were skipped.`
      );
    }
    parsedFiles.push({
      source,
      declarations: collectDeclarations(tree.rootNode, source.path),
    });
  }

  // Enums are collected from every file first, so a column can reference an enum from another file.
  for (const { declarations } of parsedFiles) {
    for (const { ctx, node } of declarations) {
      if (node.type === 'enum_declaration') {
        registerEnum(node, ctx, state);
      }
    }
  }

  const classes: Map<string, RawClass> = new Map();
  for (const { declarations } of parsedFiles) {
    for (const { ctx, node } of declarations) {
      if (
        node.type !== 'class_declaration' &&
        node.type !== 'trait_declaration'
      ) {
        continue;
      }
      const rawClass: RawClass | undefined = parseClass(node, ctx, state);
      if (rawClass === undefined) {
        continue;
      }
      if (classes.has(rawClass.fqn)) {
        warnings.push(
          `Duplicate class name "${rawClass.fqn}" (${ctx.path}); only the first definition was converted.`
        );
        continue;
      }
      classes.set(rawClass.fqn, rawClass);
    }
  }

  const schema: IrSchema = buildSchema(classes, state, options);
  if (schema.models.length === 0) {
    const checkedPaths: string = sources
      .map((source: DoctrineSourceFile) => source.path)
      .join(', ');
    const annotationHint: string =
      annotationFiles.length > 0
        ? ` Docblock annotations (@ORM\\Entity) were found in ${annotationFiles.join(', ')}; annotation mapping is not supported yet, so convert them to PHP 8 attributes.`
        : '';
    return err(
      'NO_MODELS_FOUND',
      `No Doctrine entities were found in: ${checkedPaths}. An entity is a class marked with the #[ORM\\Entity] attribute ` +
        `(XML and YAML mappings are not supported).${annotationHint}`
    );
  }
  return ok(schema);
}

// ---------------------------------------------------------------------------
// File structure: namespaces, imports, declarations
// ---------------------------------------------------------------------------

function usesDocblockAnnotations(root: SyntaxNode): boolean {
  return root
    .descendantsOfType('comment')
    .some((comment: SyntaxNode) =>
      /@(ORM\\\w+|(?:Entity|MappedSuperclass|Embeddable)\b)/.test(comment.text)
    );
}

/** The Doctrine mapping attribute name (for example "Column") for an attribute, or undefined for other attributes. */
function mappingName(
  attribute: PhpAttribute,
  ctx: FileContext
): string | undefined {
  const fqn: string = resolveClassName(attribute.rawName, ctx);
  if (fqn.startsWith(MAPPING_NAMESPACE)) {
    return fqn.slice(MAPPING_NAMESPACE.length);
  }
  // A snippet that uses the conventional alias without importing it.
  if (attribute.rawName.startsWith('ORM\\') && !ctx.uses.has('orm')) {
    return attribute.rawName.slice('ORM\\'.length);
  }
  return undefined;
}

function toMappingAttributes(
  attributes: PhpAttribute[],
  ctx: FileContext
): MappingAttribute[] {
  const mapped: MappingAttribute[] = [];
  for (const attribute of attributes) {
    const name: string | undefined = mappingName(attribute, ctx);
    if (name !== undefined) {
      mapped.push({
        name,
        attribute,
        args: mergeArguments(name, attribute.args, attribute.named),
      });
    }
  }
  return mapped;
}

function mergeArguments(
  name: string,
  positional: PhpValue[],
  named: Record<string, PhpValue>
): Record<string, PhpValue> {
  const merged: Record<string, PhpValue> = { ...named };
  const order: readonly string[] = PARAMETER_ORDER[name] ?? [];
  positional.forEach((value: PhpValue, index: number): void => {
    const key: string | undefined = order[index];
    if (key !== undefined && merged[key] === undefined) {
      merged[key] = value;
    }
  });
  return merged;
}

// ---------------------------------------------------------------------------
// Value helpers
// ---------------------------------------------------------------------------

function stringValue(value: PhpValue | undefined): string | undefined {
  return value !== undefined && value.kind === 'string'
    ? value.value
    : undefined;
}

function boolValue(value: PhpValue | undefined): boolean | undefined {
  return value !== undefined && value.kind === 'bool' ? value.value : undefined;
}

function numberValue(value: PhpValue | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value.kind === 'number') {
    return value.value;
  }
  if (value.kind === 'string' && /^\d+$/.test(value.value)) {
    return Number(value.value);
  }
  return undefined;
}

/** The elements of an array value, or an empty list for anything else. */
function arrayItems(value: PhpValue | undefined): PhpValue[] {
  return value !== undefined && value.kind === 'array'
    ? value.items.map((item) => item.value)
    : [];
}

/** The string elements of an array value; undefined when any element is not a plain string. */
function stringList(value: PhpValue | undefined): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value.kind === 'string') {
    return [value.value];
  }
  if (value.kind !== 'array') {
    return undefined;
  }
  const strings: string[] = value.items.flatMap((item): string[] =>
    item.value.kind === 'string' ? [item.value.value] : []
  );
  return strings.length === value.items.length ? strings : undefined;
}

/** The entries of a `['key' => value]` array whose keys are strings. */
function arrayEntries(value: PhpValue | undefined): Record<string, PhpValue> {
  const entries: Record<string, PhpValue> = {};
  if (value !== undefined && value.kind === 'array') {
    for (const item of value.items) {
      if (item.key !== undefined && item.key.kind === 'string') {
        entries[item.key.value] = item.value;
      }
    }
  }
  return entries;
}

/** Reads `'IDENTITY'` or `ClassMetadata::GENERATOR_TYPE_IDENTITY` as upper case text. */
function keywordValue(
  value: PhpValue | undefined,
  prefix: string
): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value.kind === 'string') {
    return value.value.toUpperCase();
  }
  if (value.kind === 'constant' && value.name.startsWith(prefix)) {
    return value.name.slice(prefix.length);
  }
  if (value.kind === 'constant' || value.kind === 'name') {
    const text: string = value.kind === 'name' ? value.value : value.name;
    return text.toUpperCase();
  }
  return undefined;
}

/** A class name written as `Foo::class`, `'Foo'` or `'\App\Foo'`, resolved against the current file and class. */
function entityReference(
  value: PhpValue | undefined,
  ctx: FileContext,
  currentFqn: string
): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value.kind === 'classRef') {
    const lowered: string = value.name.toLowerCase();
    if (lowered === 'self' || lowered === 'static') {
      return currentFqn;
    }
    return resolveClassName(value.name, ctx);
  }
  if (value.kind === 'string') {
    // Doctrine treats a string without a namespace as relative to the entity's own namespace.
    if (value.value.startsWith('\\')) {
      return value.value.slice(1);
    }
    return value.value.includes('\\') || ctx.namespace === ''
      ? value.value
      : `${ctx.namespace}\\${value.value}`;
  }
  return undefined;
}

function describeValue(value: PhpValue): string {
  switch (value.kind) {
    case 'other':
      return value.text;
    case 'name':
      return value.value;
    case 'constant':
      return `${value.owner}::${value.name}`;
    case 'classRef':
      return `${value.name}::class`;
    default:
      return value.kind;
  }
}

// ---------------------------------------------------------------------------
// Doctrine naming strategy (UnderscoreNamingStrategy)
// ---------------------------------------------------------------------------

/** Doctrine's `underscore()`: an underscore before an upper case letter that follows a lower case letter or digit. */
function underscore(name: string): string {
  return name.replace(/(?<=[a-z0-9])([A-Z])/g, '_$1').toLowerCase();
}

function stripQuotes(columnName: string): string {
  return columnName.replace(/^`(.*)`$/, '$1');
}

function upperFirst(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

function registerEnum(
  node: SyntaxNode,
  ctx: FileContext,
  state: ParseState
): void {
  const info: EnumInfo | undefined = readEnumDeclaration(
    node,
    ctx,
    state.warnings
  );
  if (info === undefined) {
    return;
  }
  if (state.enums.has(info.fqn)) {
    state.warnings.push(
      `Duplicate enum name "${info.fqn}" (${ctx.path}); only the first definition was used.`
    );
    return;
  }
  state.enums.set(info.fqn, info);
}

// ---------------------------------------------------------------------------
// Class parsing
// ---------------------------------------------------------------------------

function parseClass(
  node: SyntaxNode,
  ctx: FileContext,
  state: ParseState
): RawClass | undefined {
  const nameNode: SyntaxNode | null = node.childForFieldName('name');
  const bodyNode: SyntaxNode | null = node.childForFieldName('body');
  if (nameNode === null || bodyNode === null) {
    return undefined;
  }
  const className: string = nameNode.text;
  const fqn: string =
    ctx.namespace === '' ? className : `${ctx.namespace}\\${className}`;
  const mappings: MappingAttribute[] = toMappingAttributes(
    attributesOf(node),
    ctx
  );

  const rawClass: RawClass = {
    name: className,
    fqn,
    ctx,
    isTrait: node.type === 'trait_declaration',
    isAbstract: node.namedChildren.some(
      (child: SyntaxNode) => child.type === 'abstract_modifier'
    ),
    role: 'plain',
    traitFqns: [],
    members: [],
    indexes: [],
    discriminatorMapSize: 0,
    hasMappedProperties: false,
  };

  const baseClause: SyntaxNode | undefined = node.namedChildren.find(
    (child: SyntaxNode) => child.type === 'base_clause'
  );
  const baseName: SyntaxNode | undefined = baseClause?.namedChildren[0];
  if (baseName !== undefined) {
    rawClass.parentFqn = resolveClassName(
      baseName.text.replace(/\s+/g, ''),
      ctx
    );
  }

  parseClassAttributes(rawClass, mappings, state);

  for (const member of bodyNode.namedChildren) {
    if (member.type === 'use_declaration') {
      for (const used of member.namedChildren) {
        if (used.type === 'name' || used.type === 'qualified_name') {
          rawClass.traitFqns.push(
            resolveClassName(used.text.replace(/\s+/g, ''), ctx)
          );
        }
      }
    } else if (member.type === 'property_declaration') {
      parsePropertyDeclaration(member, rawClass, state);
    } else if (member.type === 'method_declaration') {
      parseConstructor(member, rawClass, state);
    }
  }

  if (
    rawClass.role === 'plain' &&
    !rawClass.isTrait &&
    rawClass.hasMappedProperties
  ) {
    state.warnings.push(
      `${className}: the class has Doctrine mapping attributes on its properties but is not marked with #[ORM\\Entity], ` +
        `#[ORM\\MappedSuperclass] or #[ORM\\Embeddable]; it was skipped.`
    );
  }
  return rawClass;
}

function parseClassAttributes(
  rawClass: RawClass,
  mappings: MappingAttribute[],
  state: ParseState
): void {
  const className: string = rawClass.name;
  for (const mapping of mappings) {
    const args: Record<string, PhpValue> = mapping.args;
    switch (mapping.name) {
      case 'Entity':
        rawClass.role = 'entity';
        if (boolValue(args['readOnly']) === true) {
          state.warnings.push(
            `${className}: the readOnly option of #[ORM\\Entity] has no equivalent and was ignored.`
          );
        }
        break;
      case 'MappedSuperclass':
        rawClass.role = 'mappedSuperclass';
        break;
      case 'Embeddable':
        rawClass.role = 'embeddable';
        break;
      case 'Table':
        parseTableAttribute(rawClass, args, state);
        break;
      case 'Index':
      case 'UniqueConstraint': {
        const index: RawIndex | undefined = parseIndexAttribute(
          mapping.name,
          args,
          undefined,
          className,
          rawClass.ctx,
          state
        );
        if (index !== undefined) {
          rawClass.indexes.push(index);
        }
        break;
      }
      case 'InheritanceType': {
        const kind: string | undefined = keywordValue(
          args['value'],
          'INHERITANCE_TYPE_'
        );
        if (kind === 'SINGLE_TABLE' || kind === 'JOINED' || kind === 'NONE') {
          rawClass.inheritanceType = kind;
        } else {
          state.warnings.push(
            `${className}: the inheritance type "${kind ?? 'unknown'}" is not supported; ` +
              `only SINGLE_TABLE and JOINED are converted.`
          );
        }
        break;
      }
      case 'DiscriminatorColumn':
        rawClass.discriminatorName = stringValue(args['name']);
        rawClass.discriminatorType = stringValue(args['type']);
        {
          const length: number | undefined = numberValue(args['length']);
          if (length !== undefined) {
            rawClass.discriminatorLength = length;
          }
        }
        if (args['columnDefinition'] !== undefined) {
          state.warnings.push(
            `${className}: the columnDefinition of #[ORM\\DiscriminatorColumn] has no equivalent and was ignored.`
          );
        }
        break;
      case 'DiscriminatorMap':
        rawClass.discriminatorMapSize = Object.keys(
          arrayEntries(args['value'])
        ).length;
        break;
      default: {
        const reason: string | undefined = UNSUPPORTED_ATTRIBUTES[mapping.name];
        if (reason !== undefined) {
          state.warnings.push(
            `${className}: #[ORM\\${mapping.name}] was skipped; ${reason}.`
          );
        } else if (!IGNORED_ATTRIBUTES.has(mapping.name)) {
          state.warnings.push(
            `${className}: the attribute #[ORM\\${mapping.name}] is not supported and was ignored.`
          );
        }
        break;
      }
    }
  }
}

function parseTableAttribute(
  rawClass: RawClass,
  args: Record<string, PhpValue>,
  state: ParseState
): void {
  const className: string = rawClass.name;
  const tableName: string | undefined = stringValue(args['name']);
  if (tableName !== undefined) {
    rawClass.tableName = stripQuotes(tableName);
  }
  const schemaName: string | undefined = stringValue(args['schema']);
  if (schemaName !== undefined) {
    state.warnings.push(
      `${className}: the schema "${schemaName}" given to #[ORM\\Table] was ignored; only the table name is converted.`
    );
  }
  if (args['options'] !== undefined) {
    state.warnings.push(
      `${className}: the options of #[ORM\\Table] (engine, charset and similar) have no equivalent and were ignored.`
    );
  }
  for (const key of ['indexes', 'uniqueConstraints']) {
    for (const item of arrayItems(args[key])) {
      const nested:
        { name: string; args: Record<string, PhpValue> } | undefined =
        nestedAttribute(item, rawClass.ctx);
      if (
        nested === undefined ||
        (nested.name !== 'Index' && nested.name !== 'UniqueConstraint')
      ) {
        state.warnings.push(
          `${className}: an entry of the "${key}" option of #[ORM\\Table] could not be read statically and was skipped.`
        );
        continue;
      }
      const index: RawIndex | undefined = parseIndexAttribute(
        nested.name,
        nested.args,
        undefined,
        className,
        rawClass.ctx,
        state
      );
      if (index !== undefined) {
        rawClass.indexes.push(index);
      }
    }
  }
}

/** Reads `new ORM\Index(...)` into the attribute name and its merged arguments. */
function nestedAttribute(
  value: PhpValue,
  ctx: FileContext
): { name: string; args: Record<string, PhpValue> } | undefined {
  if (value.kind !== 'new') {
    return undefined;
  }
  const created: PhpNew = value;
  const name: string | undefined = mappingName(
    { rawName: created.className, args: created.args, named: created.named },
    ctx
  );
  return name === undefined
    ? undefined
    : { name, args: mergeArguments(name, created.args, created.named) };
}

/** Parses `#[ORM\Index]` or `#[ORM\UniqueConstraint]`. A property attribute passes the property name. */
function parseIndexAttribute(
  attributeName: string,
  args: Record<string, PhpValue>,
  propertyName: string | undefined,
  location: string,
  _ctx: FileContext,
  state: ParseState
): RawIndex | undefined {
  const columns: string[] | undefined = stringList(args['columns']);
  const fields: string[] | undefined = stringList(args['fields']);
  let refs: string[] | undefined = columns ?? fields;
  if (refs === undefined && propertyName !== undefined) {
    refs = [propertyName];
  }
  if (refs === undefined || refs.length === 0) {
    state.warnings.push(
      `${location}: could not read the column list of #[ORM\\${attributeName}]; the ${attributeName === 'UniqueConstraint' ? 'unique constraint' : 'index'} was skipped.`
    );
    return undefined;
  }
  const flags: string[] = (stringList(args['flags']) ?? []).map(
    (flag: string) => flag.toLowerCase()
  );
  const options: Record<string, PhpValue> = arrayEntries(args['options']);
  for (const option of Object.keys(options)) {
    state.warnings.push(
      `${location}: the "${option}" option of #[ORM\\${attributeName}] has no equivalent and was ignored.`
    );
  }
  for (const flag of flags) {
    if (flag !== 'fulltext' && flag !== 'clustered') {
      state.warnings.push(
        `${location}: the "${flag}" flag of #[ORM\\${attributeName}] has no equivalent and was ignored.`
      );
    }
  }
  const name: string | undefined = stringValue(args['name']);
  return {
    refs: refs.map(stripQuotes),
    isUnique: attributeName === 'UniqueConstraint',
    flags,
    ...(name === undefined ? {} : { name }),
  };
}

// ---------------------------------------------------------------------------
// Property parsing
// ---------------------------------------------------------------------------

function parsePropertyDeclaration(
  node: SyntaxNode,
  rawClass: RawClass,
  state: ParseState
): void {
  if (
    node.namedChildren.some(
      (child: SyntaxNode) => child.type === 'static_modifier'
    )
  ) {
    return;
  }
  const attributes: PhpAttribute[] = attributesOf(node);
  const type: PhpTypeInfo | undefined = typeOf(node);
  for (const element of node.namedChildren) {
    if (element.type !== 'property_element') {
      continue;
    }
    const variable: SyntaxNode | undefined = element.namedChildren.find(
      (child: SyntaxNode) => child.type === 'variable_name'
    );
    if (variable === undefined) {
      continue;
    }
    parseProperty(
      { name: variable.text.replace(/^\$/, ''), attributes, type },
      rawClass,
      state
    );
  }
}

/** Constructor promotion: `public function __construct(#[ORM\Column] private string $name)`. */
function parseConstructor(
  node: SyntaxNode,
  rawClass: RawClass,
  state: ParseState
): void {
  const nameNode: SyntaxNode | null = node.childForFieldName('name');
  if (nameNode === null || nameNode.text.toLowerCase() !== '__construct') {
    return;
  }
  const parameters: SyntaxNode | null = node.childForFieldName('parameters');
  if (parameters === null) {
    return;
  }
  for (const parameter of parameters.namedChildren) {
    if (parameter.type !== 'property_promotion_parameter') {
      continue;
    }
    const variable: SyntaxNode | null = parameter.childForFieldName('name');
    if (variable === null) {
      continue;
    }
    parseProperty(
      {
        name: variable.text.replace(/^\$/, ''),
        attributes: attributesOf(parameter),
        type: typeOf(parameter),
      },
      rawClass,
      state
    );
  }
}

function parseProperty(
  info: PropertyInfo,
  rawClass: RawClass,
  state: ParseState
): void {
  const mappings: MappingAttribute[] = toMappingAttributes(
    info.attributes,
    rawClass.ctx
  );
  if (mappings.length === 0) {
    return;
  }
  rawClass.hasMappedProperties = true;
  const location: string = `${rawClass.name}.${info.name}`;
  const has = (name: string): boolean =>
    mappings.some((mapping: MappingAttribute) => mapping.name === name);

  const relation: MappingAttribute | undefined = mappings.find(
    (mapping: MappingAttribute) => RELATION_ATTRIBUTES.has(mapping.name)
  );
  const embedded: MappingAttribute | undefined = mappings.find(
    (mapping: MappingAttribute) => mapping.name === 'Embedded'
  );

  if (embedded !== undefined) {
    parseEmbedded(embedded, info, location, rawClass, state);
  } else if (relation !== undefined) {
    parseRelation(relation, mappings, info, location, rawClass, state);
  } else if (has('Column') || has('Id')) {
    if (!has('Column')) {
      state.warnings.push(
        `${location}: #[ORM\\Id] was used without #[ORM\\Column]; Doctrine needs both, so the column was mapped from the property type.`
      );
    }
    parseColumn(mappings, info, location, rawClass, state);
  }

  for (const mapping of mappings) {
    if (mapping.name === 'Index' || mapping.name === 'UniqueConstraint') {
      const index: RawIndex | undefined = parseIndexAttribute(
        mapping.name,
        mapping.args,
        info.name,
        location,
        rawClass.ctx,
        state
      );
      if (index !== undefined) {
        rawClass.indexes.push(index);
      }
    } else if (
      mapping.name !== 'Column' &&
      mapping.name !== 'Id' &&
      mapping.name !== 'Version' &&
      mapping.name !== 'GeneratedValue' &&
      mapping.name !== 'CustomIdGenerator' &&
      mapping.name !== 'SequenceGenerator' &&
      mapping.name !== 'JoinColumn' &&
      mapping.name !== 'InverseJoinColumn' &&
      mapping.name !== 'JoinTable' &&
      mapping.name !== 'Embedded' &&
      !RELATION_ATTRIBUTES.has(mapping.name) &&
      !IGNORED_ATTRIBUTES.has(mapping.name)
    ) {
      state.warnings.push(
        `${location}: the attribute #[ORM\\${mapping.name}] is not supported and was ignored.`
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Columns
// ---------------------------------------------------------------------------

interface ResolvedType {
  type: IrScalarType;
  dbalType: string | undefined;
  enumInfo?: EnumInfo;
}

/** The DBAL type name written in `type:`, as text; undefined when absent or not a plain name. */
function declaredTypeName(value: PhpValue | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value.kind === 'string') {
    return value.value.toLowerCase();
  }
  if (
    value.kind === 'constant' &&
    ['Types', 'Type'].includes(lastNameSegment(value.owner))
  ) {
    return TYPE_CONSTANTS[value.name];
  }
  return undefined;
}

function findEnum(fqn: string, state: ParseState): EnumInfo | undefined {
  const exact: EnumInfo | undefined = state.enums.get(fqn);
  if (exact !== undefined) {
    return exact;
  }
  const short: string = lastNameSegment(fqn);
  const candidates: EnumInfo[] = [...state.enums.values()].filter(
    (candidate: EnumInfo) => candidate.name === short
  );
  return candidates.length === 1 ? candidates[0] : undefined;
}

function resolveColumnType(
  args: Record<string, PhpValue>,
  type: PhpTypeInfo | undefined,
  location: string,
  rawClass: RawClass,
  state: ParseState
): ResolvedType {
  const ctx: FileContext = rawClass.ctx;
  const typeValue: PhpValue | undefined = args['type'];
  const declared: string | undefined = declaredTypeName(typeValue);
  if (typeValue !== undefined && declared === undefined) {
    state.warnings.push(
      `${location}: the column type (${describeValue(typeValue)}) cannot be read statically; it was converted to a string.`
    );
    return { type: 'string', dbalType: undefined };
  }

  // Enum-backed column: an explicit enumType, or a PHP type that is an enum.
  const enumValue: PhpValue | undefined = args['enumType'];
  let enumFqn: string | undefined = entityReference(
    enumValue,
    ctx,
    rawClass.fqn
  );
  const phpName: string | undefined = type?.names[0];
  if (
    enumFqn === undefined &&
    phpName !== undefined &&
    (declared === undefined || declared === 'enum')
  ) {
    const candidate: string = resolveClassName(phpName, ctx);
    if (findEnum(candidate, state) !== undefined) {
      enumFqn = candidate;
    }
  }
  if (enumFqn !== undefined) {
    const info: EnumInfo | undefined = findEnum(enumFqn, state);
    if (info === undefined) {
      state.warnings.push(
        `${location}: the enum "${lastNameSegment(enumFqn)}" was not found in the input files; the column was converted to a string. ` +
          `Add the file that defines it to --input.`
      );
      return { type: 'string', dbalType: declared };
    }
    if (info.backing === 'none') {
      state.warnings.push(
        `${location}: the enum "${info.name}" is not a backed enum, which Doctrine cannot store; the column was converted to a string.`
      );
      return { type: 'string', dbalType: declared };
    }
    if (info.backing === 'int') {
      state.warnings.push(
        `${location}: the enum "${info.name}" has integer values, which the shared model cannot represent; the column was converted to an int.`
      );
      return { type: 'int', dbalType: declared ?? 'integer' };
    }
    return { type: 'string', dbalType: declared ?? 'string', enumInfo: info };
  }

  if (declared !== undefined) {
    const mapped: IrScalarType | undefined = DBAL_TYPES[declared];
    if (mapped === undefined) {
      state.warnings.push(
        `${location}: column type "${declared}" has no equivalent in the shared model (custom DBAL types are not resolved); it was converted to a string.`
      );
      return { type: 'string', dbalType: declared };
    }
    const note: string | undefined = APPROXIMATED_TYPES[declared];
    if (note !== undefined) {
      state.warnings.push(`${location}: column type "${declared}" ${note}.`);
    }
    if (declared === 'enum') {
      state.warnings.push(
        `${location}: an enum column was declared without a readable enumType; it was converted to a string.`
      );
    }
    return { type: mapped, dbalType: declared };
  }

  // No explicit type: Doctrine infers it from the PHP property type.
  if (phpName === undefined || (type?.names.length ?? 0) > 1) {
    state.warnings.push(
      `${location}: no column type could be inferred (add a property type or an explicit type); it was converted to a string.`
    );
    return { type: 'string', dbalType: undefined };
  }
  const inferred: string | undefined =
    PHP_TYPE_TO_DBAL[lastNameSegment(phpName).toLowerCase()];
  if (inferred !== undefined) {
    return { type: DBAL_TYPES[inferred] ?? 'string', dbalType: inferred };
  }
  state.warnings.push(
    `${location}: the PHP type "${type?.text ?? phpName}" cannot be mapped to a column type; add an explicit type. It was converted to a string.`
  );
  return { type: 'string', dbalType: undefined };
}

function parseColumn(
  mappings: MappingAttribute[],
  info: PropertyInfo,
  location: string,
  rawClass: RawClass,
  state: ParseState
): void {
  const column: MappingAttribute | undefined = mappings.find(
    (mapping: MappingAttribute) => mapping.name === 'Column'
  );
  const args: Record<string, PhpValue> = column?.args ?? {};
  const has = (name: string): boolean =>
    mappings.some((mapping: MappingAttribute) => mapping.name === name);
  const find = (name: string): MappingAttribute | undefined =>
    mappings.find((mapping: MappingAttribute) => mapping.name === name);

  const isPrimaryKey: boolean = has('Id');
  const resolved: ResolvedType = resolveColumnType(
    args,
    info.type,
    location,
    rawClass,
    state
  );
  let irType: IrScalarType = resolved.type;

  const columnNameOption: string | undefined = stringValue(args['name']);
  const columnName: string =
    columnNameOption === undefined
      ? underscore(info.name)
      : stripQuotes(columnNameOption);
  const isNullable: boolean =
    !isPrimaryKey && boolValue(args['nullable']) === true;
  const field: IrField = {
    name: info.name,
    columnName,
    type: irType,
    isPrimaryKey,
    isUnique: boolValue(args['unique']) === true && !isPrimaryKey,
    isNullable,
    isAutoUpdated: false,
    ...(resolved.enumInfo === undefined
      ? {}
      : { enumName: resolved.enumInfo.name }),
  };

  // Length and precision ---------------------------------------------------
  const length: number | undefined = numberValue(args['length']);
  if (irType === 'string' && resolved.enumInfo === undefined) {
    field.maxLength = length ?? 255;
  } else if (irType === 'string' && length !== undefined) {
    field.maxLength = length;
  }
  if (irType === 'decimal') {
    field.maxDigits = numberValue(args['precision']) ?? 10;
    field.decimalPlaces = numberValue(args['scale']) ?? 0;
  }

  // Id generation ------------------------------------------------------------
  const generated: MappingAttribute | undefined = find('GeneratedValue');
  const customGenerator: MappingAttribute | undefined =
    find('CustomIdGenerator');
  let defaultValue: IrDefault | undefined;
  if (generated !== undefined || customGenerator !== undefined) {
    if (!isPrimaryKey) {
      state.warnings.push(
        `${location}: #[ORM\\GeneratedValue] was used on a property without #[ORM\\Id]; it was ignored.`
      );
    } else {
      const generatedDefault: { value?: IrDefault; type?: IrScalarType } =
        convertGenerator(
          generated,
          customGenerator,
          irType,
          location,
          rawClass,
          state
        );
      defaultValue = generatedDefault.value;
      if (generatedDefault.type !== undefined) {
        irType = generatedDefault.type;
        field.type = irType;
        delete field.maxLength;
        if (irType === 'string') {
          field.maxLength = 26;
        }
      }
    }
  }
  if (find('SequenceGenerator') !== undefined) {
    state.warnings.push(
      `${location}: #[ORM\\SequenceGenerator] settings (sequence name, allocation size) have no equivalent and were ignored.`
    );
  }

  // Defaults -----------------------------------------------------------------
  const columnOptions: Record<string, PhpValue> = arrayEntries(args['options']);
  const optionDefault: PhpValue | undefined = columnOptions['default'];
  if (optionDefault !== undefined && defaultValue === undefined) {
    defaultValue = convertDefault(
      optionDefault,
      field,
      resolved.enumInfo,
      location,
      state
    );
  }

  // Version columns ----------------------------------------------------------
  if (has('Version')) {
    state.warnings.push(
      `${location}: #[ORM\\Version] was converted to a plain column${irType === 'int' ? ' defaulting to 1' : ''}; ` +
        `Doctrine's optimistic locking is not represented.`
    );
    if (irType === 'int' && defaultValue === undefined) {
      defaultValue = { kind: 'literal', value: 1 };
    }
  }
  if (defaultValue !== undefined) {
    field.default = defaultValue;
  }

  // Options with no equivalent ----------------------------------------------
  for (const key of Object.keys(columnOptions)) {
    if (key === 'default' || key === 'jsonb') {
      continue;
    }
    const description: string | undefined = UNSUPPORTED_COLUMN_OPTIONS[key];
    state.warnings.push(
      description === undefined
        ? `${location}: the column option "${key}" has no equivalent and was ignored.`
        : `${location}: ${description} (option "${key}") has no equivalent and was ignored.`
    );
  }
  if (args['columnDefinition'] !== undefined) {
    state.warnings.push(
      `${location}: columnDefinition has no equivalent (it is raw DDL) and was ignored; the column type was derived from the declared type.`
    );
  }
  for (const key of ['insertable', 'updatable']) {
    if (boolValue(args[key]) === false) {
      state.warnings.push(
        `${location}: ${key}: false has no equivalent and was ignored.`
      );
    }
  }
  if (args['generated'] !== undefined) {
    state.warnings.push(
      `${location}: the generated option (a database-generated column) has no equivalent and was ignored.`
    );
  }

  if (boolValue(args['index']) === true) {
    rawClass.indexes.push({ refs: [info.name], isUnique: false, flags: [] });
  }
  rawClass.members.push({ kind: 'field', field });
}

/** Maps `#[ORM\GeneratedValue]` and `#[ORM\CustomIdGenerator]` to an IR default. */
function convertGenerator(
  generated: MappingAttribute | undefined,
  custom: MappingAttribute | undefined,
  type: IrScalarType,
  location: string,
  rawClass: RawClass,
  state: ParseState
): { value?: IrDefault; type?: IrScalarType } {
  const strategy: string =
    keywordValue(generated?.args['strategy'], 'GENERATOR_TYPE_') ??
    (generated === undefined ? 'CUSTOM' : 'AUTO');
  if (strategy === 'CUSTOM' || custom !== undefined) {
    const generatorClass: string | undefined = entityReference(
      custom?.args['class'],
      rawClass.ctx,
      rawClass.fqn
    );
    if (generatorClass !== undefined && UUID_GENERATORS.has(generatorClass)) {
      return { value: { kind: 'uuid' }, type: 'uuid' };
    }
    if (generatorClass !== undefined && ULID_GENERATORS.has(generatorClass)) {
      state.warnings.push(
        `${location}: the ULID id generator was converted to a client-generated string key (26 characters).`
      );
      return {
        value: { kind: 'clientGenerated', generator: 'ulid' },
        type: 'string',
      };
    }
    state.warnings.push(
      `${location}: the custom id generator ${generatorClass === undefined ? '(unreadable)' : `"${lastNameSegment(generatorClass)}"`} ` +
        `has no equivalent; the key has no generated default.`
    );
    return {};
  }
  switch (strategy) {
    case 'NONE':
      return {};
    case 'UUID':
      return { value: { kind: 'uuid' }, type: 'uuid' };
    case 'SEQUENCE':
      state.warnings.push(
        `${location}: the SEQUENCE generation strategy was converted to an auto-increment key.`
      );
      return type === 'int' || type === 'bigInt'
        ? { value: { kind: 'autoIncrement' } }
        : {};
    case 'AUTO':
    case 'IDENTITY':
      if (type === 'uuid') {
        return { value: { kind: 'uuid' } };
      }
      if (type === 'int' || type === 'bigInt') {
        return { value: { kind: 'autoIncrement' } };
      }
      state.warnings.push(
        `${location}: the ${strategy} generation strategy on a ${type} key has no equivalent; the key has no generated default.`
      );
      return {};
    default:
      state.warnings.push(
        `${location}: the generation strategy "${strategy}" is not supported; the key has no generated default.`
      );
      return {};
  }
}

function convertDefault(
  value: PhpValue,
  field: IrField,
  enumInfo: EnumInfo | undefined,
  location: string,
  state: ParseState
): IrDefault | undefined {
  switch (value.kind) {
    case 'null':
      return undefined;
    case 'bool':
      return { kind: 'literal', value: value.value };
    case 'number':
      return field.type === 'string' || field.type === 'text'
        ? { kind: 'literal', value: String(value.value) }
        : { kind: 'literal', value: value.value };
    case 'string':
      return convertStringDefault(
        value.value,
        field,
        enumInfo,
        location,
        state
      );
    case 'constant': {
      if (
        enumInfo !== undefined &&
        lastNameSegment(value.owner) === enumInfo.name
      ) {
        const member: IrEnumValue | undefined = enumInfo.values.find(
          (candidate: IrEnumValue) => candidate.name === value.name
        );
        if (member !== undefined) {
          return { kind: 'enumValue', value: member.name };
        }
      }
      break;
    }
    default:
      break;
  }
  state.warnings.push(
    `${location}: the default value (${describeValue(value)}) cannot be evaluated statically and was skipped.`
  );
  return undefined;
}

function convertStringDefault(
  text: string,
  field: IrField,
  enumInfo: EnumInfo | undefined,
  location: string,
  state: ParseState
): IrDefault | undefined {
  const trimmed: string = text.trim();
  if (enumInfo !== undefined) {
    const member: IrEnumValue | undefined = enumInfo.values.find(
      (candidate: IrEnumValue) => candidate.dbValue === text
    );
    if (member !== undefined) {
      return { kind: 'enumValue', value: member.name };
    }
    state.warnings.push(
      `${location}: the default "${text}" is not a value of the enum "${enumInfo.name}"; it was kept as a literal.`
    );
    return { kind: 'literal', value: text };
  }
  switch (field.type) {
    case 'dateTime':
    case 'date':
    case 'time':
      if (NOW_SQL.test(trimmed) || /^current_(date|time)$/i.test(trimmed)) {
        return { kind: 'now' };
      }
      break;
    case 'uuid':
    case 'string':
      if (UUID_SQL.test(trimmed)) {
        return { kind: 'uuid' };
      }
      break;
    case 'boolean':
      if (/^(1|true)$/i.test(trimmed)) {
        return { kind: 'literal', value: true };
      }
      if (/^(0|false)$/i.test(trimmed)) {
        return { kind: 'literal', value: false };
      }
      break;
    case 'int':
    case 'bigInt':
    case 'float':
    case 'decimal':
      if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
        return { kind: 'literal', value: Number(trimmed) };
      }
      break;
    default:
      break;
  }
  return { kind: 'literal', value: text };
}

// ---------------------------------------------------------------------------
// Embedded
// ---------------------------------------------------------------------------

function parseEmbedded(
  embedded: MappingAttribute,
  info: PropertyInfo,
  location: string,
  rawClass: RawClass,
  state: ParseState
): void {
  const args: Record<string, PhpValue> = embedded.args;
  let classFqn: string | undefined = entityReference(
    args['class'],
    rawClass.ctx,
    rawClass.fqn
  );
  if (classFqn === undefined && info.type?.names[0] !== undefined) {
    classFqn = resolveClassName(info.type.names[0], rawClass.ctx);
  }
  if (classFqn === undefined) {
    state.warnings.push(
      `${location}: the embeddable class of #[ORM\\Embedded] could not be resolved, so the columns were skipped.`
    );
    return;
  }
  const prefixValue: PhpValue | undefined = args['columnPrefix'];
  let prefix: string | false | undefined;
  if (prefixValue !== undefined && prefixValue.kind === 'string') {
    prefix = prefixValue.value;
  } else if (prefixValue !== undefined && prefixValue.kind === 'bool') {
    prefix = prefixValue.value ? undefined : false;
  }
  rawClass.members.push({
    kind: 'embedded',
    property: info.name,
    classFqn,
    prefix,
  });
}

// ---------------------------------------------------------------------------
// Relations
// ---------------------------------------------------------------------------

function parseRelation(
  relationAttribute: MappingAttribute,
  mappings: MappingAttribute[],
  info: PropertyInfo,
  location: string,
  rawClass: RawClass,
  state: ParseState
): void {
  const args: Record<string, PhpValue> = relationAttribute.args;
  const attributeName: string = relationAttribute.name;

  let targetFqn: string | undefined = entityReference(
    args['targetEntity'],
    rawClass.ctx,
    rawClass.fqn
  );
  if (
    targetFqn === undefined &&
    (attributeName === 'ManyToOne' || attributeName === 'OneToOne')
  ) {
    // Doctrine infers the target of a to-one relation from the property type.
    const typeName: string | undefined = info.type?.names[0];
    if (typeName !== undefined) {
      const lowered: string = typeName.toLowerCase();
      targetFqn =
        lowered === 'self' || lowered === 'static'
          ? rawClass.fqn
          : resolveClassName(typeName, rawClass.ctx);
    }
  }
  if (targetFqn === undefined) {
    state.warnings.push(
      `${location}: the target of #[ORM\\${attributeName}] could not be resolved (add targetEntity: Foo::class); the relation was skipped.`
    );
    return;
  }

  const mappedBy: string | undefined = stringValue(args['mappedBy']);
  const inversedBy: string | undefined = stringValue(args['inversedBy']);
  const cascade: string[] = (stringList(args['cascade']) ?? []).map(
    (item: string) => item.toLowerCase()
  );
  if (
    cascade.includes('remove') ||
    cascade.includes('all') ||
    boolValue(args['orphanRemoval']) === true
  ) {
    state.warnings.push(
      `${location}: ORM-level cascade remove / orphanRemoval is not represented; ` +
        `use onDelete: 'CASCADE' on the join column for a database-level cascade.`
    );
  }

  const isOwner: boolean =
    attributeName === 'ManyToOne' ||
    ((attributeName === 'OneToOne' || attributeName === 'ManyToMany') &&
      mappedBy === undefined);

  if (!isOwner) {
    rawClass.members.push({
      kind: 'inverse',
      property: info.name,
      targetFqn,
      ...(mappedBy === undefined ? {} : { mappedBy }),
      relationKind:
        attributeName === 'OneToMany'
          ? 'oneToMany'
          : attributeName === 'ManyToMany'
            ? 'manyToMany'
            : 'oneToOne',
    });
    return;
  }

  const kind: IrRelation['kind'] =
    attributeName === 'ManyToMany'
      ? 'manyToMany'
      : attributeName === 'OneToOne'
        ? 'oneToOne'
        : 'foreignKey';

  // Join columns ------------------------------------------------------------
  const joinColumns: Record<string, PhpValue>[] = mappings
    .filter((mapping: MappingAttribute) => mapping.name === 'JoinColumn')
    .map((mapping: MappingAttribute) => mapping.args);
  if (kind !== 'manyToMany' && joinColumns.length > 1) {
    state.warnings.push(
      `${location}: composite foreign keys (several join columns) are not supported; the relation was skipped.`
    );
    return;
  }
  const joinColumn: Record<string, PhpValue> | undefined = joinColumns[0];
  if (kind === 'manyToMany') {
    // Doctrine 2 passes joinColumns / inverseJoinColumns to JoinTable; Doctrine 3 uses #[ORM\JoinColumn] and #[ORM\InverseJoinColumn].
    const joinTable: MappingAttribute | undefined = mappings.find(
      (mapping: MappingAttribute) => mapping.name === 'JoinTable'
    );
    const customized: string[] = [
      ...['name', 'schema', 'joinColumns', 'inverseJoinColumns'].filter(
        (key: string) => joinTable?.args[key] !== undefined
      ),
      ...(joinColumns.length > 0 ? ['JoinColumn'] : []),
      ...(mappings.some(
        (mapping: MappingAttribute) => mapping.name === 'InverseJoinColumn'
      )
        ? ['InverseJoinColumn']
        : []),
    ];
    if (customized.length > 0) {
      state.warnings.push(
        `${location}: custom join table settings (${customized.join(', ')}) are not preserved; ` +
          `the join table name and columns are derived from the models.`
      );
    }
  }

  let explicitColumn: string | undefined;
  let referencedColumn: string | undefined;
  let nullableOption: boolean | undefined;
  let onDelete: IrOnDelete = 'noAction';
  if (joinColumn !== undefined && kind !== 'manyToMany') {
    explicitColumn = stringValue(joinColumn['name']);
    referencedColumn = stringValue(joinColumn['referencedColumnName']);
    nullableOption = boolValue(joinColumn['nullable']);
    if (joinColumn['columnDefinition'] !== undefined) {
      state.warnings.push(
        `${location}: the columnDefinition of the join column has no equivalent and was ignored.`
      );
    }
    const onDeleteValue: string | undefined = stringValue(
      joinColumn['onDelete']
    );
    if (onDeleteValue !== undefined) {
      const mapped: IrOnDelete | undefined =
        ON_DELETE_MAP[onDeleteValue.toUpperCase()];
      if (mapped === undefined) {
        state.warnings.push(
          `${location}: onDelete "${onDeleteValue}" has no equivalent and was converted to NoAction.`
        );
      } else {
        onDelete = mapped;
      }
    }
  }
  if (kind === 'manyToMany') {
    onDelete = 'cascade';
  }

  const isPrimaryKey: boolean = mappings.some(
    (mapping: MappingAttribute) => mapping.name === 'Id'
  );
  const relation: IrRelation = {
    name: info.name,
    kind,
    targetModel: targetFqn,
    columnName:
      explicitColumn === undefined
        ? `${underscore(info.name)}_id`
        : stripQuotes(explicitColumn),
    // Doctrine join columns are nullable unless nullable: false is given.
    isNullable: !isPrimaryKey && nullableOption !== false,
    onDelete,
    ...(inversedBy === undefined ? {} : { relatedName: inversedBy }),
    ...(referencedColumn === undefined || referencedColumn === 'id'
      ? {}
      : { toField: stripQuotes(referencedColumn) }),
    ...(isPrimaryKey ? { isPrimaryKey: true } : {}),
  };
  rawClass.members.push({
    kind: 'relation',
    relation,
    hasExplicitNullable: nullableOption !== undefined,
  });
}

// ---------------------------------------------------------------------------
// Schema assembly (inheritance, embeddables, inverse sides)
// ---------------------------------------------------------------------------

function buildSchema(
  classes: Map<string, RawClass>,
  state: ParseState,
  options: DoctrineParseOptions
): IrSchema {
  const warnings: string[] = state.warnings;
  const entities: RawClass[] = [...classes.values()].filter(
    (rawClass: RawClass) => rawClass.role === 'entity'
  );

  // Inheritance: how each entity relates to the entity it extends. -----------
  const rootOf = (rawClass: RawClass): RawClass => {
    let current: RawClass = rawClass;
    const seen: Set<string> = new Set([current.fqn]);
    for (;;) {
      const parent: RawClass | undefined = nearestEntityParent(
        current,
        classes
      );
      if (parent === undefined || seen.has(parent.fqn)) {
        return current;
      }
      seen.add(parent.fqn);
      current = parent;
    }
  };
  const rootsWithChildren: Set<string> = new Set(
    entities.flatMap((entity: RawClass): string[] =>
      nearestEntityParent(entity, classes) === undefined
        ? []
        : [rootOf(entity).fqn]
    )
  );
  const inheritanceOf = (rawClass: RawClass): InheritanceKind => {
    const root: RawClass = rootOf(rawClass);
    if (!rootsWithChildren.has(root.fqn)) {
      return 'NONE';
    }
    // Doctrine rejects an entity hierarchy without an inheritance type; single table is the closest reading.
    return root.inheritanceType === undefined || root.inheritanceType === 'NONE'
      ? 'SINGLE_TABLE'
      : root.inheritanceType;
  };

  const modelNames: Map<string, string> = new Map();
  const seenNames: Set<string> = new Set();
  const modelClasses: RawClass[] = [];
  for (const entity of entities) {
    const parent: RawClass | undefined = nearestEntityParent(entity, classes);
    const kind: InheritanceKind = inheritanceOf(entity);
    if (parent !== undefined) {
      const root: RawClass = rootOf(entity);
      if (root.inheritanceType === undefined) {
        warnings.push(
          `${entity.name}: the entity extends the entity "${parent.name}" but "${root.name}" has no #[ORM\\InheritanceType]; ` +
            `single-table inheritance was assumed.`
        );
      }
      if (kind === 'SINGLE_TABLE') {
        modelNames.set(entity.fqn, root.name);
        continue;
      }
    }
    if (seenNames.has(entity.name)) {
      warnings.push(
        `Duplicate entity name "${entity.name}" (${entity.ctx.path}); only the first definition was converted.`
      );
      continue;
    }
    seenNames.add(entity.name);
    modelNames.set(entity.fqn, entity.name);
    modelClasses.push(entity);
  }

  const models: IrModel[] = [];
  const inverseSides: { model: IrModel; inverse: InverseMember }[] = [];
  const joinedChildren: { model: IrModel; parentModel: string }[] = [];

  for (const entity of modelClasses) {
    const collected: Collected = collectMembers(
      entity,
      classes,
      state,
      new Set()
    );
    const kind: InheritanceKind = inheritanceOf(entity);
    const parent: RawClass | undefined = nearestEntityParent(entity, classes);
    const isRoot: boolean = parent === undefined;
    const isJoinedChild: boolean = parent !== undefined && kind === 'JOINED';

    const descendants: RawClass[] =
      isRoot && kind === 'SINGLE_TABLE'
        ? entities.filter(
            (candidate: RawClass) =>
              candidate !== entity &&
              rootOf(candidate) === entity &&
              modelNames.get(candidate.fqn) === entity.name
          )
        : [];

    const descendantMembers: Collected[] = descendants.map(
      (descendant: RawClass): Collected =>
        collectMembers(descendant, classes, state, new Set())
    );
    const model: IrModel = finalizeModel(
      entity,
      collected,
      descendantMembers,
      modelNames,
      state,
      options,
      isJoinedChild
    );

    if (isRoot && (kind === 'SINGLE_TABLE' || kind === 'JOINED')) {
      addDiscriminator(model, entity, state);
    }
    if (descendants.length > 0) {
      warnings.push(
        `${entity.name}: single-table inheritance was flattened into the table "${model.tableName}"; the columns of ` +
          `${descendants.map((descendant: RawClass) => descendant.name).join(', ')} were merged as nullable columns ` +
          `and the discriminator values are not preserved.`
      );
    }
    if (isJoinedChild && parent !== undefined) {
      joinedChildren.push({ model, parentModel: parent.name });
      warnings.push(
        `${entity.name}: joined-table inheritance from "${parent.name}" was converted to a one-to-one primary key ` +
          `named "${joinedPointerName(parent.name)}".`
      );
    }
    models.push(model);
    for (const inverse of collected.inverses) {
      inverseSides.push({ model, inverse });
    }
    for (const descendant of descendantMembers) {
      for (const inverse of descendant.inverses) {
        inverseSides.push({ model, inverse });
      }
    }
  }

  resolveInverseSides(models, inverseSides, modelNames, classes, warnings);
  resolveTargets(models, modelNames, classes, warnings, options);
  patchJoinedKeys(models, joinedChildren);
  normalizeReferencedColumns(models);

  return { models, enums: pruneEnums(state, models), warnings };
}

function joinedPointerName(parentName: string): string {
  return `${toSnakeCase(parentName)}_ptr`;
}

/** The closest ancestor that is an entity, skipping mapped superclasses and other plain classes. */
function nearestEntityParent(
  rawClass: RawClass,
  classes: Map<string, RawClass>
): RawClass | undefined {
  const seen: Set<string> = new Set([rawClass.fqn]);
  let current: RawClass = rawClass;
  for (;;) {
    if (current.parentFqn === undefined) {
      return undefined;
    }
    const parent: RawClass | undefined = classes.get(current.parentFqn);
    if (parent === undefined || seen.has(parent.fqn)) {
      return undefined;
    }
    if (parent.role === 'entity') {
      return parent;
    }
    seen.add(parent.fqn);
    current = parent;
  }
}

function emptyCollected(): Collected {
  return { fields: [], relations: [], inverses: [], indexes: [] };
}

/**
 * Gathers the members a class contributes: its traits, then (through mapped superclasses only)
 * its parents, then its own properties. Embedded properties are flattened into prefixed fields.
 */
function collectMembers(
  rawClass: RawClass,
  classes: Map<string, RawClass>,
  state: ParseState,
  visiting: Set<string>
): Collected {
  const inherited: Collected = emptyCollected();
  visiting.add(rawClass.fqn);

  if (rawClass.parentFqn !== undefined) {
    const parent: RawClass | undefined = classes.get(rawClass.parentFqn);
    if (parent === undefined) {
      if (rawClass.role === 'entity' || rawClass.role === 'mappedSuperclass') {
        state.warnings.push(
          `${rawClass.name}: base class "${lastNameSegment(rawClass.parentFqn)}" was not found in the input files, so any columns it defines ` +
            `are missing. Add the file that defines it to --input.`
        );
      }
    } else if (visiting.has(parent.fqn)) {
      state.warnings.push(
        `${rawClass.name}: circular inheritance through "${parent.name}" was ignored.`
      );
    } else if (parent.role === 'mappedSuperclass') {
      mergeCollected(
        inherited,
        collectMembers(parent, classes, state, new Set(visiting))
      );
    } else if (parent.role !== 'entity' && parent.hasMappedProperties) {
      state.warnings.push(
        `${rawClass.name}: the base class "${parent.name}" is not marked #[ORM\\MappedSuperclass], so Doctrine ignores its mapped properties.`
      );
    }
  }

  for (const traitFqn of rawClass.traitFqns) {
    const trait: RawClass | undefined = classes.get(traitFqn);
    if (trait === undefined) {
      state.warnings.push(
        `${rawClass.name}: the trait "${lastNameSegment(traitFqn)}" was not found in the input files, so any mapped properties it declares are missing. ` +
          `Add the file that defines it to --input.`
      );
    } else if (!visiting.has(trait.fqn)) {
      mergeCollected(
        inherited,
        collectMembers(trait, classes, state, new Set(visiting))
      );
    }
  }

  const own: Collected = emptyCollected();
  for (const member of rawClass.members) {
    switch (member.kind) {
      case 'field':
        own.fields.push(member.field);
        break;
      case 'relation':
        own.relations.push(member);
        break;
      case 'inverse':
        own.inverses.push(member);
        break;
      case 'embedded':
        own.fields.push(
          ...expandEmbedded(
            member,
            `${rawClass.name}.${member.property}`,
            classes,
            state,
            new Set([rawClass.fqn])
          )
        );
        break;
    }
  }
  own.indexes.push(...rawClass.indexes);

  const ownFieldNames: Set<string> = new Set(
    own.fields.map((field: IrField) => field.name)
  );
  const ownRelationNames: Set<string> = new Set(
    own.relations.map((member: RelationMember) => member.relation.name)
  );
  const ownInverseNames: Set<string> = new Set(
    own.inverses.map((member: InverseMember) => member.property)
  );
  return {
    fields: [
      ...inherited.fields.filter(
        (field: IrField) => !ownFieldNames.has(field.name)
      ),
      ...own.fields,
    ],
    relations: [
      ...inherited.relations.filter(
        (member: RelationMember) => !ownRelationNames.has(member.relation.name)
      ),
      ...own.relations,
    ],
    inverses: [
      ...inherited.inverses.filter(
        (member: InverseMember) => !ownInverseNames.has(member.property)
      ),
      ...own.inverses,
    ],
    indexes: [...inherited.indexes, ...own.indexes],
  };
}

function mergeCollected(target: Collected, source: Collected): void {
  target.fields.push(...source.fields);
  target.relations.push(...source.relations);
  target.inverses.push(...source.inverses);
  target.indexes.push(...source.indexes);
}

/** Flattens an embeddable into prefixed fields, the way Doctrine's underscore naming strategy names them. */
function expandEmbedded(
  embedded: EmbeddedMember,
  location: string,
  classes: Map<string, RawClass>,
  state: ParseState,
  visiting: Set<string>
): IrField[] {
  const embeddable: RawClass | undefined = classes.get(embedded.classFqn);
  if (embeddable === undefined) {
    state.warnings.push(
      `${location}: the embeddable "${lastNameSegment(embedded.classFqn)}" was not found in the input files, so its columns are missing. ` +
        `Add the file that defines it to --input.`
    );
    return [];
  }
  if (visiting.has(embeddable.fqn)) {
    state.warnings.push(`${location}: a recursive embeddable was ignored.`);
    return [];
  }
  if (embeddable.role !== 'embeddable') {
    state.warnings.push(
      `${location}: "${embeddable.name}" is not marked #[ORM\\Embeddable]; Doctrine would reject it, but its columns were embedded anyway.`
    );
  }
  const collected: Collected = collectMembers(
    embeddable,
    classes,
    state,
    new Set([...visiting, embeddable.fqn])
  );
  const columnPrefix: string =
    embedded.prefix === false
      ? ''
      : (embedded.prefix ?? `${underscore(embedded.property)}_`);
  for (const relation of collected.relations) {
    state.warnings.push(
      `${location}.${relation.relation.name}: relations inside embeddables are not supported and were skipped.`
    );
  }
  for (const inverse of collected.inverses) {
    state.warnings.push(
      `${location}.${inverse.property}: relations inside embeddables are not supported and were skipped.`
    );
  }
  if (collected.indexes.length > 0) {
    state.warnings.push(
      `${location}: indexes declared inside the embeddable "${embeddable.name}" were skipped.`
    );
  }
  return collected.fields.map((field: IrField): IrField => ({
    ...field,
    name: toCamelCase(`${embedded.property}_${upperFirst(field.name)}`),
    columnName: `${columnPrefix}${field.columnName}`,
    isPrimaryKey: false,
  }));
}

function finalizeModel(
  rawClass: RawClass,
  collected: Collected,
  descendants: Collected[],
  modelNames: Map<string, string>,
  state: ParseState,
  options: DoctrineParseOptions,
  isJoinedChild: boolean
): IrModel {
  const warnings: string[] = state.warnings;
  const fields: IrField[] = collected.fields.map((field: IrField): IrField => ({
    ...field,
  }));
  const relationMembers: RelationMember[] = [...collected.relations];
  const indexes: RawIndex[] = [...collected.indexes];

  // Columns of single-table subclasses are optional for rows of other subclasses.
  for (const descendant of descendants) {
    for (const field of descendant.fields) {
      if (!fields.some((existing: IrField) => existing.name === field.name)) {
        fields.push({ ...field, isNullable: true, isPrimaryKey: false });
      }
    }
    for (const member of descendant.relations) {
      if (
        !relationMembers.some(
          (existing: RelationMember) =>
            existing.relation.name === member.relation.name
        )
      ) {
        relationMembers.push({
          ...member,
          relation: { ...member.relation, isNullable: true },
        });
      }
    }
    indexes.push(...descendant.indexes);
  }

  const relations: IrRelation[] = [];
  /** Scalar foreign-key properties merged into relations: property name -> relation name. */
  const renamed: Map<string, string> = new Map();
  for (const member of relationMembers) {
    const relation: IrRelation = { ...member.relation };
    if (relation.kind !== 'manyToMany') {
      const backing: number = fields.findIndex(
        (field: IrField) => field.columnName === relation.columnName
      );
      const backingField: IrField | undefined = fields[backing];
      if (backingField !== undefined) {
        // The entity also declares the foreign key column as a plain property
        // (Doctrine requires insertable/updatable: false on it); the relation already represents it.
        fields.splice(backing, 1);
        renamed.set(backingField.name, relation.name);
        if (!member.hasExplicitNullable) {
          relation.isNullable = backingField.isNullable;
        }
        if (backingField.isPrimaryKey) {
          relation.isPrimaryKey = true;
          relation.isNullable = false;
        }
      }
    }
    relations.push(relation);
  }

  const irIndexes: IrIndex[] = [];
  for (const raw of indexes) {
    const names: string[] = [];
    const missing: string[] = [];
    for (const ref of raw.refs) {
      const resolved: string | undefined = resolveIndexReference(
        ref,
        fields,
        relations,
        renamed
      );
      if (resolved === undefined) {
        missing.push(ref);
      } else {
        names.push(resolved);
      }
    }
    if (missing.length > 0) {
      warnings.push(
        `${rawClass.name}: the ${raw.isUnique ? 'unique constraint' : 'index'} on (${raw.refs.join(', ')}) refers to ` +
          `"${missing.join('", "')}", which is not a column or relation of the entity; it was skipped.`
      );
      continue;
    }
    const singleField: IrField | undefined =
      names.length === 1
        ? fields.find((field: IrField) => field.name === names[0])
        : undefined;
    if (
      raw.isUnique &&
      raw.name === undefined &&
      singleField !== undefined &&
      !singleField.isPrimaryKey
    ) {
      singleField.isUnique = true;
      continue;
    }
    irIndexes.push({
      fields: names,
      isUnique: raw.isUnique,
      ...(raw.name === undefined ? {} : { name: raw.name }),
      ...(raw.flags.includes('fulltext') ? { kind: 'fulltext' as const } : {}),
      ...(raw.flags.includes('clustered') ? { clustered: true } : {}),
    });
  }

  // Primary key -------------------------------------------------------------
  const primaryFields: IrField[] = fields.filter(
    (field: IrField) => field.isPrimaryKey
  );
  const primaryRelations: IrRelation[] = relations.filter(
    (relation: IrRelation) => relation.isPrimaryKey === true
  );
  const keyCount: number = primaryFields.length + primaryRelations.length;
  let compositePrimaryKey: string[] | undefined;
  if (isJoinedChild) {
    if (keyCount > 0) {
      warnings.push(
        `${rawClass.name}: a joined-table child inherits its identifier; its own #[ORM\\Id] properties were kept as ordinary columns.`
      );
    }
  } else if (keyCount === 0) {
    warnings.push(
      `${rawClass.name}: the entity has no identifier; Doctrine requires a property marked #[ORM\\Id].`
    );
  } else if (keyCount > 1) {
    compositePrimaryKey = [
      ...primaryFields.map((field: IrField) => field.name),
      ...primaryRelations.map((relation: IrRelation) => relation.name),
    ];
    for (const field of primaryFields) {
      field.isPrimaryKey = false;
      field.isUnique = false;
    }
    for (const relation of primaryRelations) {
      delete relation.isPrimaryKey;
    }
  }

  if (isJoinedChild) {
    const parentFqn: string | undefined = rawClass.parentFqn;
    const parentName: string =
      parentFqn === undefined
        ? 'Parent'
        : (modelNames.get(parentFqn) ?? lastNameSegment(parentFqn));
    for (const field of fields) {
      field.isPrimaryKey = false;
    }
    relations.unshift({
      name: joinedPointerName(parentName),
      kind: 'oneToOne',
      targetModel: parentFqn ?? parentName,
      columnName: 'id',
      isNullable: false,
      onDelete: 'cascade',
      isPrimaryKey: true,
    });
  }

  return {
    name: rawClass.name,
    tableName: rawClass.tableName ?? underscore(rawClass.name),
    appLabel: options.appLabel,
    fields,
    relations,
    indexes: irIndexes,
    ...(compositePrimaryKey === undefined ? {} : { compositePrimaryKey }),
  };
}

/** Maps an index column (or property) reference to the IR field or relation name. */
function resolveIndexReference(
  ref: string,
  fields: IrField[],
  relations: IrRelation[],
  renamed: Map<string, string>
): string | undefined {
  const byColumn: IrField | undefined = fields.find(
    (field: IrField) => field.columnName === ref
  );
  if (byColumn !== undefined) {
    return byColumn.name;
  }
  const relationByColumn: IrRelation | undefined = relations.find(
    (relation: IrRelation) =>
      relation.kind !== 'manyToMany' && relation.columnName === ref
  );
  if (relationByColumn !== undefined) {
    return relationByColumn.name;
  }
  const renamedTo: string | undefined = renamed.get(ref);
  if (renamedTo !== undefined) {
    return renamedTo;
  }
  if (
    fields.some((field: IrField) => field.name === ref) ||
    relations.some((relation: IrRelation) => relation.name === ref)
  ) {
    return ref;
  }
  return undefined;
}

function addDiscriminator(
  model: IrModel,
  rawClass: RawClass,
  state: ParseState
): void {
  const name: string = rawClass.discriminatorName ?? 'dtype';
  if (
    model.fields.some(
      (field: IrField) => field.name === name || field.columnName === name
    )
  ) {
    return;
  }
  const type: string = (rawClass.discriminatorType ?? 'string').toLowerCase();
  const isInteger: boolean = type === 'integer' || type === 'smallint';
  if (!isInteger && type !== 'string') {
    state.warnings.push(
      `${rawClass.name}: the discriminator column type "${type}" is not supported; a string column was used.`
    );
  }
  model.fields.push({
    name,
    columnName: name,
    type: isInteger ? 'int' : 'string',
    isPrimaryKey: false,
    isUnique: false,
    isNullable: false,
    isAutoUpdated: false,
    ...(isInteger ? {} : { maxLength: rawClass.discriminatorLength ?? 255 }),
  });
  if (rawClass.discriminatorMapSize > 0) {
    state.warnings.push(
      `${rawClass.name}: the discriminator map (${rawClass.discriminatorMapSize} entries) maps values to subclasses and is not preserved; ` +
        `the discriminator column "${name}" is kept as a plain ${isInteger ? 'integer' : 'string'} column.`
    );
  }
}

/** Links inverse-side attributes (OneToMany, mappedBy) to the owning relation. */
function resolveInverseSides(
  models: IrModel[],
  inverseSides: { model: IrModel; inverse: InverseMember }[],
  modelNames: Map<string, string>,
  classes: Map<string, RawClass>,
  warnings: string[]
): void {
  const byName: Map<string, IrModel> = new Map(
    models.map((model: IrModel) => [model.name, model])
  );
  for (const { model, inverse } of inverseSides) {
    const location: string = `${model.name}.${inverse.property}`;
    const targetName: string | undefined =
      modelNames.get(inverse.targetFqn) ??
      findByShortName(inverse.targetFqn, modelNames);
    const target: IrModel | undefined =
      targetName === undefined ? undefined : byName.get(targetName);
    if (target === undefined) {
      if (!classes.has(inverse.targetFqn)) {
        warnings.push(
          `${location}: the target "${lastNameSegment(inverse.targetFqn)}" is not an entity in the input, so the reverse accessor is not linked.`
        );
      }
      continue;
    }
    if (inverse.mappedBy === undefined) {
      warnings.push(
        `${location}: this inverse side has no mappedBy, so it could not be linked to "${target.name}".`
      );
      continue;
    }
    const owner: IrRelation | undefined = target.relations.find(
      (relation: IrRelation) => relation.name === inverse.mappedBy
    );
    if (owner === undefined) {
      warnings.push(
        `${location}: the owning side "${target.name}.${inverse.mappedBy}" was not found; the reverse accessor is not included.`
      );
      continue;
    }
    if (owner.relatedName === undefined) {
      owner.relatedName = inverse.property;
    } else if (owner.relatedName !== inverse.property) {
      warnings.push(
        `${location}: the owning side "${target.name}.${inverse.mappedBy}" names its reverse accessor ` +
          `"${owner.relatedName}"; "${inverse.property}" was ignored.`
      );
    }
  }
}

function findByShortName(
  fqn: string,
  modelNames: Map<string, string>
): string | undefined {
  const short: string = lastNameSegment(fqn);
  const matches: string[] = [...modelNames.entries()]
    .filter(([key]: [string, string]) => lastNameSegment(key) === short)
    .map(([, name]: [string, string]) => name);
  return matches.length === 1 ? matches[0] : undefined;
}

/** Replaces the fully qualified targets stored on relations with model names, adding stubs for unknown classes. */
function resolveTargets(
  models: IrModel[],
  modelNames: Map<string, string>,
  classes: Map<string, RawClass>,
  warnings: string[],
  options: DoctrineParseOptions
): void {
  const known: Set<string> = new Set(
    models.map((model: IrModel) => model.name)
  );
  const stubs: IrModel[] = [];
  for (const model of models) {
    for (const relation of model.relations) {
      const fqn: string = relation.targetModel;
      const mapped: string | undefined =
        modelNames.get(fqn) ?? findByShortName(fqn, modelNames);
      if (mapped !== undefined) {
        relation.targetModel = mapped;
        continue;
      }
      const shortName: string = lastNameSegment(fqn);
      relation.targetModel = shortName;
      if (known.has(shortName)) {
        continue;
      }
      known.add(shortName);
      const nonEntity: RawClass | undefined = classes.get(fqn);
      stubs.push({
        name: shortName,
        tableName: underscore(shortName),
        appLabel: options.appLabel,
        fields: [
          {
            name: 'id',
            columnName: 'id',
            type: 'int',
            isPrimaryKey: true,
            isUnique: false,
            isNullable: false,
            isAutoUpdated: false,
            default: { kind: 'autoIncrement' },
          },
        ],
        relations: [],
        indexes: [],
      });
      warnings.push(
        `${model.name}.${relation.name} references "${shortName}", which is not ${nonEntity === undefined ? 'an entity in the input' : 'marked #[ORM\\Entity]'}. ` +
          `A stub model with an auto-increment id was generated; replace it with the real definition.`
      );
    }
  }
  models.push(...stubs);
}

/** Joined-table children reuse the key column of their parent. */
function patchJoinedKeys(
  models: IrModel[],
  joinedChildren: { model: IrModel; parentModel: string }[]
): void {
  const byName: Map<string, IrModel> = new Map(
    models.map((model: IrModel) => [model.name, model])
  );
  for (const { model, parentModel } of joinedChildren) {
    const parent: IrModel | undefined = byName.get(parentModel);
    const pointer: IrRelation | undefined = model.relations.find(
      (relation: IrRelation) => relation.isPrimaryKey === true
    );
    if (parent === undefined || pointer === undefined) {
      continue;
    }
    const key: string | undefined =
      parent.fields.find((field: IrField) => field.isPrimaryKey)?.columnName ??
      parent.relations.find(
        (relation: IrRelation) => relation.isPrimaryKey === true
      )?.columnName;
    if (key !== undefined) {
      pointer.columnName = key;
    }
  }
}

/** A referencedColumnName that names the target's own key is the default and is dropped. */
function normalizeReferencedColumns(models: IrModel[]): void {
  const byName: Map<string, IrModel> = new Map(
    models.map((model: IrModel) => [model.name, model])
  );
  for (const model of models) {
    for (const relation of model.relations) {
      if (relation.toField === undefined) {
        continue;
      }
      const target: IrModel | undefined = byName.get(relation.targetModel);
      const key: IrField | undefined = target?.fields.find(
        (field: IrField) => field.isPrimaryKey
      );
      if (key !== undefined && key.columnName === relation.toField) {
        delete relation.toField;
      }
    }
  }
}

/** Keeps only enums that a converted field refers to. */
function pruneEnums(state: ParseState, models: IrModel[]): IrEnum[] {
  const used: Set<string> = new Set(
    models.flatMap((model: IrModel) =>
      model.fields.flatMap((field: IrField) =>
        field.enumName === undefined ? [] : [field.enumName]
      )
    )
  );
  return [...state.enums.values()]
    .filter(
      (info: EnumInfo) => info.backing === 'string' && used.has(info.name)
    )
    .map((info: EnumInfo): IrEnum => ({
      name: info.name,
      values: info.values,
    }));
}
