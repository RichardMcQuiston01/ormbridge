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
import { toCamelCase, toPascalCase, toSnakeCase } from '../naming.js';
import { err, ok, type Result } from '../result.js';
import {
  decoratorsOf,
  evaluateNode,
  getTypeScriptParser,
  lastSegment,
  type SyntaxNode,
  type TsArrow,
  type TsDecorator,
  type TsObject,
  type TsValue,
} from './typescriptSyntax.js';

export interface TypeormSourceFile {
  path: string;
  text: string;
}

export interface TypeormParseOptions {
  /** App label stored on each model (TypeORM itself has no equivalent). */
  appLabel: string;
}

// ---------------------------------------------------------------------------
// Static tables
// ---------------------------------------------------------------------------

/** Column type names (lower case) accepted by TypeORM, mapped to the IR scalar type. */
const COLUMN_TYPES: Readonly<Record<string, IrScalarType>> = {
  varchar: 'string',
  'character varying': 'string',
  varying: 'string',
  nvarchar: 'string',
  nvarchar2: 'string',
  varchar2: 'string',
  char: 'string',
  character: 'string',
  nchar: 'string',
  bpchar: 'string',
  citext: 'string',
  string: 'string',
  text: 'text',
  tinytext: 'text',
  mediumtext: 'text',
  longtext: 'text',
  ntext: 'text',
  clob: 'text',
  nclob: 'text',
  'simple-array': 'text',
  int: 'int',
  int2: 'int',
  int4: 'int',
  int8: 'bigInt',
  integer: 'int',
  smallint: 'int',
  tinyint: 'int',
  mediumint: 'int',
  number: 'int',
  serial: 'int',
  smallserial: 'int',
  bigserial: 'bigInt',
  bigint: 'bigInt',
  'unsigned big int': 'bigInt',
  float: 'float',
  float4: 'float',
  float8: 'float',
  double: 'float',
  'double precision': 'float',
  real: 'float',
  decimal: 'decimal',
  dec: 'decimal',
  numeric: 'decimal',
  fixed: 'decimal',
  money: 'decimal',
  smallmoney: 'decimal',
  boolean: 'boolean',
  bool: 'boolean',
  bit: 'boolean',
  date: 'date',
  time: 'time',
  timetz: 'time',
  'time with time zone': 'time',
  'time without time zone': 'time',
  datetime: 'dateTime',
  datetime2: 'dateTime',
  datetimeoffset: 'dateTime',
  smalldatetime: 'dateTime',
  timestamp: 'dateTime',
  timestamptz: 'dateTime',
  'timestamp with time zone': 'dateTime',
  'timestamp without time zone': 'dateTime',
  'timestamp with local time zone': 'dateTime',
  uuid: 'uuid',
  uniqueidentifier: 'uuid',
  json: 'json',
  jsonb: 'json',
  'simple-json': 'json',
  bytea: 'bytes',
  blob: 'bytes',
  tinyblob: 'bytes',
  mediumblob: 'bytes',
  longblob: 'bytes',
  binary: 'bytes',
  varbinary: 'bytes',
  image: 'bytes',
  raw: 'bytes',
};

/** Global constructors accepted as a column type, for example `@Column(String)`. */
const CONSTRUCTOR_TYPES: Readonly<Record<string, IrScalarType>> = {
  String: 'string',
  Number: 'int',
  Boolean: 'boolean',
  Date: 'dateTime',
  Buffer: 'bytes',
  BigInt: 'bigInt',
};

/** Column types whose storage differs from the IR type in a way worth telling the user about. */
const APPROXIMATED_TYPES: Readonly<Record<string, string>> = {
  'simple-array':
    'stored as comma-separated text; the IR has no array type, so it was converted to text',
  money: 'converted to a decimal column',
  smallmoney: 'converted to a decimal column',
  bit: 'converted to a boolean column',
};

const TS_TYPE_MAP: Readonly<Record<string, IrScalarType>> = {
  string: 'string',
  number: 'int',
  boolean: 'boolean',
  bigint: 'bigInt',
  Date: 'dateTime',
  Buffer: 'bytes',
  Uint8Array: 'bytes',
};

const JSON_LIKE_TS_TYPES: ReadonlySet<string> = new Set([
  'object',
  'Object',
  'Record',
  'any',
  'unknown',
]);

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
const QUOTED_SQL: RegExp = /^'((?:[^']|'')*)'(::[\w\s]+)?$/;

const RELATION_DECORATORS: ReadonlySet<string> = new Set([
  'OneToOne',
  'ManyToOne',
  'OneToMany',
  'ManyToMany',
]);

const COLUMN_DECORATORS: ReadonlySet<string> = new Set([
  'Column',
  'PrimaryColumn',
  'PrimaryGeneratedColumn',
  'CreateDateColumn',
  'UpdateDateColumn',
  'DeleteDateColumn',
  'VersionColumn',
]);

/** Property decorators that define schema we cannot represent; each produces a warning. */
const UNSUPPORTED_PROPERTY_DECORATORS: Readonly<Record<string, string>> = {
  ObjectIdColumn: 'MongoDB object id columns are not supported',
  VirtualColumn: 'virtual (computed) columns are not supported',
  RelationId: '@RelationId is a runtime-only helper and has no column',
  TreeChildren: 'tree entities (closure/materialized path) are not supported',
  TreeParent: 'tree entities (closure/materialized path) are not supported',
  TreeLevelColumn:
    'tree entities (closure/materialized path) are not supported',
  ViewColumn: 'view columns are not supported',
};

/** Column options that change the database schema but have no IR equivalent. */
const UNSUPPORTED_COLUMN_OPTIONS: Readonly<Record<string, string>> = {
  unsigned: 'unsigned integers',
  zerofill: 'zerofill',
  collation: 'a collation',
  charset: 'a character set',
  onUpdate: 'an ON UPDATE expression',
  asExpression: 'a generated (computed) column expression',
  generatedType: 'a generated (computed) column',
  transformer: 'a value transformer',
  hstoreType: 'an hstore type',
  spatialFeatureType: 'a spatial feature type',
  srid: 'a spatial reference id',
  primaryKeyConstraintName: 'a primary key constraint name',
};

// ---------------------------------------------------------------------------
// Intermediate (per-class) structures
// ---------------------------------------------------------------------------

type EnumInfo = { kind: 'string'; values: IrEnumValue[] } | { kind: 'numeric' };

interface RawIndex {
  fields: string[];
  isUnique: boolean;
  name?: string;
}

type Member =
  | { kind: 'field'; field: IrField }
  | {
      kind: 'relation';
      relation: IrRelation;
      /** True when the foreign-key column name came from @JoinColumn. */
      hasExplicitColumn: boolean;
      /** True when the source declared `nullable` explicitly. */
      hasExplicitNullable: boolean;
    }
  | {
      kind: 'inverse';
      property: string;
      targetModel: string;
      /** Property on the target class that owns the relation. */
      inverseProperty?: string;
      relationKind: 'oneToMany' | 'oneToOne' | 'manyToMany';
    }
  | {
      kind: 'embedded';
      property: string;
      typeName: string;
      /** Explicit prefix string, `false` for none, or undefined for the property name. */
      prefix: string | false | undefined;
    };

interface RawClass {
  name: string;
  filePath: string;
  isAbstract: boolean;
  isEntity: boolean;
  isChildEntity: boolean;
  tableName?: string;
  baseName?: string;
  /** True when the base class expression could not be resolved to a simple name. */
  hasComplexBase: boolean;
  members: Member[];
  indexes: RawIndex[];
}

interface ParseContext {
  filePath: string;
  enums: Map<string, EnumInfo>;
  newEnums: IrEnum[];
  warnings: string[];
}

interface TsTypeInfo {
  names: string[];
  literals: string[];
  nullable: boolean;
  isArray: boolean;
  text: string;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/** Parses TypeORM entity files into the shared IR using tree-sitter (no Node project required). */
export async function parseTypeorm(
  sources: TypeormSourceFile[],
  options: TypeormParseOptions
): Promise<Result<IrSchema>> {
  const parserResult: Result<Parser> = await getTypeScriptParser();
  if (!parserResult.ok) {
    return parserResult;
  }
  const parser: Parser = parserResult.value;

  const warnings: string[] = [];
  const classes: RawClass[] = [];
  const enumInfos: Map<string, EnumInfo> = new Map();
  const irEnums: Map<string, IrEnum> = new Map();

  // Enums are collected from every file first, so a column can reference an enum from another file.
  const trees: { source: TypeormSourceFile; tree: Parser.Tree }[] = [];
  for (const source of sources) {
    const tree: Parser.Tree = parser.parse(source.text);
    trees.push({ source, tree });
    collectEnums(tree.rootNode, source.path, enumInfos, irEnums, warnings);
  }
  for (const { source, tree } of trees) {
    classes.push(...parseClasses(tree, source, enumInfos, irEnums, warnings));
  }

  const schema: IrSchema = buildSchema(
    classes,
    [...irEnums.values()],
    warnings,
    options
  );
  if (schema.models.length === 0) {
    const checkedPaths: string = sources
      .map((source: TypeormSourceFile) => source.path)
      .join(', ');
    return err(
      'NO_MODELS_FOUND',
      `No TypeORM entities were found in: ${checkedPaths}. An entity is a non-abstract class decorated with @Entity() ` +
        `(EntitySchema definitions are not supported).`
    );
  }
  return ok(schema);
}

// ---------------------------------------------------------------------------
// File parsing
// ---------------------------------------------------------------------------

/** Reads the top-level declarations of a file, unwrapping `export` statements. */
function topLevelDeclarations(
  root: SyntaxNode
): { node: SyntaxNode; decorators: TsDecorator[] }[] {
  const declarations: { node: SyntaxNode; decorators: TsDecorator[] }[] = [];
  for (const statement of root.namedChildren) {
    if (statement.type === 'export_statement') {
      const decorators: TsDecorator[] = decoratorsOf(statement);
      for (const node of statement.namedChildren) {
        declarations.push({ node, decorators });
      }
    } else {
      declarations.push({ node: statement, decorators: [] });
    }
  }
  return declarations;
}

function collectEnums(
  root: SyntaxNode,
  filePath: string,
  enums: Map<string, EnumInfo>,
  irEnums: Map<string, IrEnum>,
  warnings: string[]
): void {
  for (const { node } of topLevelDeclarations(root)) {
    const parsedEnum: ParsedEnum | undefined =
      node.type === 'enum_declaration'
        ? parseEnumDeclaration(node)
        : node.type === 'lexical_declaration'
          ? parseConstObjectEnum(node)
          : undefined;
    if (parsedEnum !== undefined) {
      registerEnum(parsedEnum, enums, irEnums, filePath, warnings);
    }
  }
}

function parseClasses(
  tree: Parser.Tree,
  source: TypeormSourceFile,
  enums: Map<string, EnumInfo>,
  irEnums: Map<string, IrEnum>,
  sharedWarnings: string[]
): RawClass[] {
  if (tree.rootNode.hasError) {
    sharedWarnings.push(
      `${source.path}: the file contains TypeScript syntax errors; some entities or columns may be missing from the output.`
    );
  }
  if (/\bnew\s+EntitySchema\b/.test(source.text)) {
    sharedWarnings.push(
      `${source.path}: EntitySchema definitions are not supported and were skipped; use decorated entity classes.`
    );
  }

  const aliases: Map<string, string> = collectImportAliases(tree.rootNode);
  const context: ParseContext = {
    filePath: source.path,
    enums,
    newEnums: [],
    warnings: sharedWarnings,
  };
  const classes: RawClass[] = [];
  for (const { node, decorators } of topLevelDeclarations(tree.rootNode)) {
    if (
      node.type !== 'class_declaration' &&
      node.type !== 'abstract_class_declaration' &&
      node.type !== 'class'
    ) {
      continue;
    }
    const rawClass: RawClass | undefined = parseClass(
      node,
      [...decorators, ...decoratorsOf(node)].map((decorator: TsDecorator) =>
        normalizeDecorator(decorator, aliases)
      ),
      aliases,
      context
    );
    if (rawClass !== undefined) {
      classes.push(rawClass);
    }
  }
  for (const generated of context.newEnums) {
    irEnums.set(generated.name, generated);
  }
  return classes;
}

function collectImportAliases(root: SyntaxNode): Map<string, string> {
  const aliases: Map<string, string> = new Map();
  for (const statement of root.namedChildren) {
    if (statement.type !== 'import_statement') {
      continue;
    }
    const stack: SyntaxNode[] = [...statement.namedChildren];
    while (stack.length > 0) {
      const node: SyntaxNode | undefined = stack.pop();
      if (node === undefined) {
        break;
      }
      if (node.type === 'import_specifier') {
        const nameNode: SyntaxNode | null = node.childForFieldName('name');
        const aliasNode: SyntaxNode | null = node.childForFieldName('alias');
        if (nameNode !== null && aliasNode !== null) {
          aliases.set(aliasNode.text, nameNode.text);
        }
      } else {
        stack.push(...node.namedChildren);
      }
    }
  }
  return aliases;
}

function normalizeDecorator(
  decorator: TsDecorator,
  aliases: Map<string, string>
): TsDecorator {
  const original: string | undefined = aliases.get(decorator.name);
  return original === undefined ? decorator : { ...decorator, name: original };
}

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

interface ParsedEnum {
  name: string;
  info: EnumInfo;
}

function parseEnumDeclaration(node: SyntaxNode): ParsedEnum | undefined {
  const nameNode: SyntaxNode | null = node.childForFieldName('name');
  const bodyNode: SyntaxNode | null = node.childForFieldName('body');
  if (nameNode === null || bodyNode === null) {
    return undefined;
  }
  const values: IrEnumValue[] = [];
  let isNumeric: boolean = false;
  for (const member of bodyNode.namedChildren) {
    if (member.type === 'property_identifier') {
      isNumeric = true;
      continue;
    }
    if (member.type !== 'enum_assignment') {
      continue;
    }
    const memberName: SyntaxNode | null = member.childForFieldName('name');
    const memberValue: SyntaxNode | null = member.childForFieldName('value');
    if (memberName === null || memberValue === null) {
      continue;
    }
    const evaluated: TsValue = evaluateNode(memberValue);
    if (evaluated.kind === 'string') {
      values.push({
        name: unquoteName(memberName.text),
        dbValue: evaluated.value,
      });
    } else {
      isNumeric = true;
    }
  }
  const info: EnumInfo = isNumeric
    ? { kind: 'numeric' }
    : { kind: 'string', values };
  return { name: nameNode.text, info };
}

/** `export const Status = { A: 'a', B: 'b' } as const;` is treated like a string enum. */
function parseConstObjectEnum(node: SyntaxNode): ParsedEnum | undefined {
  for (const declarator of node.namedChildren) {
    if (declarator.type !== 'variable_declarator') {
      continue;
    }
    const nameNode: SyntaxNode | null = declarator.childForFieldName('name');
    const valueNode: SyntaxNode | null = declarator.childForFieldName('value');
    if (nameNode === null || valueNode === null) {
      continue;
    }
    const evaluated: TsValue = evaluateNode(valueNode);
    if (evaluated.kind !== 'object') {
      continue;
    }
    const entries: [string, TsValue][] = Object.entries(evaluated.properties);
    if (
      entries.length === 0 ||
      !entries.every(([, value]: [string, TsValue]) => value.kind === 'string')
    ) {
      continue;
    }
    const values: IrEnumValue[] = entries.flatMap(
      ([key, value]: [string, TsValue]): IrEnumValue[] =>
        value.kind === 'string' ? [{ name: key, dbValue: value.value }] : []
    );
    return { name: nameNode.text, info: { kind: 'string', values } };
  }
  return undefined;
}

function unquoteName(text: string): string {
  return /^(["']).*\1$/.test(text) ? text.slice(1, -1) : text;
}

function registerEnum(
  parsedEnum: ParsedEnum,
  enums: Map<string, EnumInfo>,
  irEnums: Map<string, IrEnum>,
  filePath: string,
  warnings: string[]
): void {
  enums.set(parsedEnum.name, parsedEnum.info);
  if (parsedEnum.info.kind === 'string') {
    if (irEnums.has(parsedEnum.name)) {
      warnings.push(
        `Duplicate enum name "${parsedEnum.name}" (${filePath}); only the first definition was used.`
      );
      return;
    }
    // Enums are registered eagerly so every file can reference them; unused ones are pruned later.
    irEnums.set(parsedEnum.name, {
      name: parsedEnum.name,
      values: parsedEnum.info.values,
    });
  }
}

// ---------------------------------------------------------------------------
// Value helpers
// ---------------------------------------------------------------------------

function objectArgument(args: TsValue[]): TsObject | undefined {
  for (const arg of args) {
    if (arg.kind === 'object') {
      return arg;
    }
  }
  return undefined;
}

function stringOption(
  options: TsObject | undefined,
  key: string
): string | undefined {
  const value: TsValue | undefined = options?.properties[key];
  return value !== undefined && value.kind === 'string'
    ? value.value
    : undefined;
}

function boolOption(
  options: TsObject | undefined,
  key: string
): boolean | undefined {
  const value: TsValue | undefined = options?.properties[key];
  return value !== undefined && value.kind === 'bool' ? value.value : undefined;
}

function numberOption(
  options: TsObject | undefined,
  key: string
): number | undefined {
  const value: TsValue | undefined = options?.properties[key];
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

/** True for an option explicitly switched off (`false`, `null`). */
function isOff(value: TsValue): boolean {
  return (value.kind === 'bool' && !value.value) || value.kind === 'null';
}

/** The class name an arrow function such as `() => User` or `(type) => User` returns. */
function arrowTargetName(value: TsValue | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value.kind === 'string') {
    return lastSegment(value.value);
  }
  if (value.kind === 'arrow' && value.body.kind === 'name') {
    return lastSegment(value.body.value);
  }
  return undefined;
}

/** The property an inverse-side function such as `(user) => user.posts` points at. */
function inverseSideName(value: TsValue | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value.kind === 'string') {
    return value.value;
  }
  if (value.kind === 'arrow' && value.body.kind === 'name') {
    const firstParam: string | undefined = value.params[0];
    const text: string = value.body.value;
    if (firstParam !== undefined && text.startsWith(`${firstParam}.`)) {
      return text.slice(firstParam.length + 1);
    }
    return lastSegment(text);
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// TypeScript type annotations
// ---------------------------------------------------------------------------

function describeTypeAnnotation(propertyNode: SyntaxNode): TsTypeInfo {
  const annotation: SyntaxNode | null = propertyNode.childForFieldName('type');
  const typeNode: SyntaxNode | undefined = annotation?.namedChildren[0];
  const info: TsTypeInfo = {
    names: [],
    literals: [],
    nullable: false,
    isArray: false,
    text: typeNode?.text ?? '',
  };
  if (typeNode !== undefined) {
    collectTypeNames(typeNode, info);
  }
  return info;
}

function collectTypeNames(node: SyntaxNode, info: TsTypeInfo): void {
  switch (node.type) {
    case 'union_type':
    case 'parenthesized_type':
      for (const child of node.namedChildren) {
        collectTypeNames(child, info);
      }
      return;
    case 'literal_type': {
      const inner: SyntaxNode | undefined = node.namedChildren[0];
      if (inner === undefined) {
        return;
      }
      if (inner.type === 'null' || inner.type === 'undefined') {
        info.nullable = true;
      } else if (inner.type === 'string') {
        const value: TsValue = evaluateNode(inner);
        if (value.kind === 'string') {
          info.literals.push(value.value);
        }
      } else {
        info.names.push(inner.type === 'number' ? 'number' : inner.text);
      }
      return;
    }
    case 'predefined_type':
      if (node.text === 'undefined' || node.text === 'null') {
        info.nullable = true;
      } else {
        info.names.push(node.text);
      }
      return;
    case 'type_identifier':
    case 'nested_type_identifier':
      if (node.text === 'undefined' || node.text === 'null') {
        info.nullable = true;
      } else {
        info.names.push(lastSegment(node.text));
      }
      return;
    case 'array_type': {
      info.isArray = true;
      const element: SyntaxNode | undefined = node.namedChildren[0];
      if (element !== undefined) {
        collectTypeNames(element, info);
      }
      return;
    }
    case 'generic_type': {
      const base: string = lastSegment(node.namedChildren[0]?.text ?? '');
      const argumentNode: SyntaxNode | undefined =
        node.namedChildren[1]?.namedChildren[0];
      if (base === 'Array' || base === 'ReadonlyArray') {
        info.isArray = true;
      }
      if (
        argumentNode !== undefined &&
        ['Relation', 'Promise', 'Awaited', 'Array', 'ReadonlyArray'].includes(
          base
        )
      ) {
        collectTypeNames(argumentNode, info);
      } else {
        info.names.push(base);
      }
      return;
    }
    default:
      info.names.push(node.text);
  }
}

// ---------------------------------------------------------------------------
// Class parsing
// ---------------------------------------------------------------------------

function parseClass(
  node: SyntaxNode,
  decorators: TsDecorator[],
  aliases: Map<string, string>,
  context: ParseContext
): RawClass | undefined {
  const nameNode: SyntaxNode | null = node.childForFieldName('name');
  const bodyNode: SyntaxNode | null = node.childForFieldName('body');
  if (nameNode === null || bodyNode === null) {
    return undefined;
  }
  const className: string = nameNode.text;
  const entityDecorator: TsDecorator | undefined = decorators.find(
    (decorator: TsDecorator) => decorator.name === 'Entity'
  );
  const rawClass: RawClass = {
    name: className,
    filePath: context.filePath,
    isAbstract: node.type === 'abstract_class_declaration',
    isEntity: entityDecorator !== undefined,
    isChildEntity: decorators.some(
      (decorator: TsDecorator) => decorator.name === 'ChildEntity'
    ),
    hasComplexBase: false,
    members: [],
    indexes: [],
  };

  const heritage: SyntaxNode | undefined = node.namedChildren.find(
    (child: SyntaxNode) => child.type === 'class_heritage'
  );
  const extendsClause: SyntaxNode | undefined = heritage?.namedChildren.find(
    (child: SyntaxNode) => child.type === 'extends_clause'
  );
  const baseNode: SyntaxNode | undefined = extendsClause?.namedChildren[0];
  if (baseNode !== undefined) {
    if (
      baseNode.type === 'identifier' ||
      baseNode.type === 'member_expression'
    ) {
      rawClass.baseName = lastSegment(baseNode.text.replace(/\s+/g, ''));
    } else {
      rawClass.hasComplexBase = true;
      context.warnings.push(
        `${className}: the base class expression "${baseNode.text}" is not a plain class name, so any columns it adds are missing.`
      );
    }
  }

  parseClassDecorators(rawClass, decorators, context);

  for (const member of bodyNode.namedChildren) {
    if (member.type === 'public_field_definition') {
      parseProperty(member, rawClass, aliases, context);
    }
  }
  return rawClass;
}

function parseClassDecorators(
  rawClass: RawClass,
  decorators: TsDecorator[],
  context: ParseContext
): void {
  const className: string = rawClass.name;
  for (const decorator of decorators) {
    switch (decorator.name) {
      case 'Entity': {
        const options: TsObject | undefined = objectArgument(decorator.args);
        const first: TsValue | undefined = decorator.args[0];
        const tableName: string | undefined =
          first !== undefined && first.kind === 'string'
            ? first.value
            : stringOption(options, 'name');
        if (tableName !== undefined) {
          rawClass.tableName = tableName;
        }
        for (const key of ['schema', 'database']) {
          const value: string | undefined = stringOption(options, key);
          if (value !== undefined) {
            context.warnings.push(
              `${className}: the ${key} "${value}" given to @Entity was ignored; only the table name is converted.`
            );
          }
        }
        break;
      }
      case 'Index':
      case 'Unique': {
        const index: RawIndex | undefined = parseIndexDecorator(
          decorator,
          undefined,
          `${className}`,
          context
        );
        if (index !== undefined) {
          rawClass.indexes.push(index);
        }
        break;
      }
      case 'ChildEntity':
        context.warnings.push(
          `${className}: @ChildEntity (single-table inheritance) is not supported; the entity and its columns were skipped.`
        );
        break;
      case 'TableInheritance':
        context.warnings.push(
          `${className}: @TableInheritance (single-table inheritance) is not supported; the discriminator column was not added and each class is converted as its own table.`
        );
        break;
      case 'ViewEntity':
        context.warnings.push(
          `${className}: @ViewEntity views are not supported and were skipped.`
        );
        rawClass.isEntity = false;
        break;
      case 'Tree':
        context.warnings.push(
          `${className}: @Tree (tree entities) is not supported; the closure/materialized-path table was not generated.`
        );
        break;
      case 'Check':
      case 'Exclusion':
        context.warnings.push(
          `${className}: @${decorator.name} constraints are not supported and were skipped.`
        );
        break;
      default:
        break;
    }
  }
}

/** Parses `@Index(...)` or `@Unique(...)`. A property decorator passes the property name. */
function parseIndexDecorator(
  decorator: TsDecorator,
  propertyName: string | undefined,
  location: string,
  context: ParseContext
): RawIndex | undefined {
  const args: TsValue[] = decorator.args;
  const options: TsObject | undefined = objectArgument(args);
  let name: string | undefined;
  let fields: string[] | undefined;

  const first: TsValue | undefined = args[0];
  const second: TsValue | undefined = args[1];
  const listFrom = (value: TsValue | undefined): string[] | undefined => {
    if (value === undefined) {
      return undefined;
    }
    if (value.kind === 'array') {
      const names: string[] = value.items.flatMap((item: TsValue): string[] =>
        item.kind === 'string' ? [item.value] : []
      );
      return names.length === value.items.length ? names : undefined;
    }
    if (value.kind === 'arrow') {
      return listFromArrow(value);
    }
    return undefined;
  };

  if (first !== undefined && first.kind === 'string') {
    if (
      second !== undefined &&
      (second.kind === 'array' || second.kind === 'arrow')
    ) {
      name = first.value;
      fields = listFrom(second);
    } else {
      name = first.value;
    }
  } else {
    fields = listFrom(first);
  }

  if (fields === undefined && propertyName !== undefined) {
    fields = [propertyName];
  }
  if (fields === undefined || fields.length === 0) {
    context.warnings.push(
      `${location}: could not read the column list of @${decorator.name}; the ${decorator.name === 'Unique' ? 'unique constraint' : 'index'} was skipped.`
    );
    return undefined;
  }

  for (const option of [
    'where',
    'spatial',
    'fulltext',
    'sparse',
    'parser',
    'nullFiltered',
    'expireAfterSeconds',
  ]) {
    const value: TsValue | undefined = options?.properties[option];
    if (value !== undefined && !isOff(value)) {
      context.warnings.push(
        `${location}: the "${option}" option of @${decorator.name} has no equivalent and was ignored.`
      );
    }
  }
  if (
    decorator.name === 'Unique' &&
    options?.properties['deferrable'] !== undefined
  ) {
    context.warnings.push(
      `${location}: the "deferrable" option of @Unique has no equivalent and was ignored.`
    );
  }

  const optionName: string | undefined = stringOption(options, 'name');
  const resolvedName: string | undefined = name ?? optionName;
  return {
    fields,
    isUnique:
      decorator.name === 'Unique' || boolOption(options, 'unique') === true,
    ...(resolvedName === undefined ? {} : { name: resolvedName }),
  };
}

/** Reads `(e) => [e.a, e.b]` into ["a", "b"]. */
function listFromArrow(arrow: TsArrow): string[] | undefined {
  if (arrow.body.kind !== 'array') {
    return undefined;
  }
  const names: string[] = [];
  for (const item of arrow.body.items) {
    const name: string | undefined = inverseSideName({
      kind: 'arrow',
      params: arrow.params,
      body: item,
    });
    if (name === undefined) {
      return undefined;
    }
    names.push(name);
  }
  return names;
}

// ---------------------------------------------------------------------------
// Property parsing
// ---------------------------------------------------------------------------

function parseProperty(
  node: SyntaxNode,
  rawClass: RawClass,
  aliases: Map<string, string>,
  context: ParseContext
): void {
  const nameNode: SyntaxNode | null = node.childForFieldName('name');
  if (nameNode === null) {
    return;
  }
  if (node.children.some((child: SyntaxNode) => child.type === 'static')) {
    return;
  }
  const propertyName: string = unquoteName(nameNode.text);
  const location: string = `${rawClass.name}.${propertyName}`;
  const decorators: TsDecorator[] = decoratorsOf(node).map(
    (decorator: TsDecorator) => normalizeDecorator(decorator, aliases)
  );
  if (decorators.length === 0) {
    return;
  }
  const typeInfo: TsTypeInfo = describeTypeAnnotation(node);

  const relationDecorator: TsDecorator | undefined = decorators.find(
    (decorator: TsDecorator) => RELATION_DECORATORS.has(decorator.name)
  );
  const columnDecorator: TsDecorator | undefined = decorators.find(
    (decorator: TsDecorator) => COLUMN_DECORATORS.has(decorator.name)
  );

  if (relationDecorator !== undefined) {
    parseRelation(
      relationDecorator,
      decorators,
      propertyName,
      location,
      rawClass,
      context
    );
  } else if (columnDecorator !== undefined) {
    parseColumn(
      columnDecorator,
      decorators,
      propertyName,
      location,
      typeInfo,
      rawClass,
      context
    );
  } else {
    for (const decorator of decorators) {
      const reason: string | undefined =
        UNSUPPORTED_PROPERTY_DECORATORS[decorator.name];
      if (reason !== undefined) {
        context.warnings.push(
          `${location}: @${decorator.name} was skipped; ${reason}.`
        );
      }
    }
  }

  for (const decorator of decorators) {
    if (decorator.name === 'Index' || decorator.name === 'Unique') {
      const index: RawIndex | undefined = parseIndexDecorator(
        decorator,
        propertyName,
        location,
        context
      );
      if (index !== undefined) {
        rawClass.indexes.push(index);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Columns
// ---------------------------------------------------------------------------

interface ColumnSpec {
  /** Explicit column type as written (`varchar`, `String`, ...), when present. */
  typeName?: string;
  options?: TsObject;
}

function readColumnSpec(decorator: TsDecorator): ColumnSpec {
  const first: TsValue | undefined = decorator.args[0];
  const options: TsObject | undefined = objectArgument(decorator.args);
  let typeName: string | undefined;
  if (first !== undefined) {
    if (first.kind === 'string') {
      typeName = first.value;
    } else if (first.kind === 'name') {
      typeName = first.value;
    } else if (first.kind === 'object') {
      const optionType: TsValue | undefined = first.properties['type'];
      if (optionType !== undefined && optionType.kind === 'string') {
        typeName = optionType.value;
      } else if (optionType !== undefined && optionType.kind === 'name') {
        typeName = optionType.value;
      }
    }
  }
  if (typeName === undefined && options !== undefined) {
    const optionType: TsValue | undefined = options.properties['type'];
    if (optionType !== undefined && optionType.kind === 'string') {
      typeName = optionType.value;
    } else if (optionType !== undefined && optionType.kind === 'name') {
      typeName = optionType.value;
    }
  }
  return {
    ...(typeName === undefined ? {} : { typeName }),
    ...(options === undefined ? {} : { options }),
  };
}

function parseColumn(
  decorator: TsDecorator,
  decorators: TsDecorator[],
  propertyName: string,
  location: string,
  typeInfo: TsTypeInfo,
  rawClass: RawClass,
  context: ParseContext
): void {
  const first: TsValue | undefined = decorator.args[0];
  if (
    decorator.name === 'Column' &&
    first !== undefined &&
    first.kind === 'arrow'
  ) {
    const typeName: string | undefined = arrowTargetName(first);
    if (typeName === undefined) {
      context.warnings.push(
        `${location}: the embedded type of @Column(() => ...) could not be resolved, so the column was skipped.`
      );
      return;
    }
    const options: TsObject | undefined = objectArgument(decorator.args);
    const prefixValue: TsValue | undefined = options?.properties['prefix'];
    let prefix: string | false | undefined;
    if (prefixValue !== undefined && prefixValue.kind === 'string') {
      prefix = prefixValue.value;
    } else if (prefixValue !== undefined && prefixValue.kind === 'bool') {
      prefix = prefixValue.value ? undefined : false;
    }
    if (boolOption(options, 'array') === true) {
      context.warnings.push(
        `${location}: an array of embedded entities is not supported and was skipped.`
      );
      return;
    }
    rawClass.members.push({
      kind: 'embedded',
      property: propertyName,
      typeName,
      prefix,
    });
    return;
  }

  const spec: ColumnSpec = readColumnSpec(decorator);
  const options: TsObject | undefined = spec.options;
  const generatedDecorator: TsDecorator | undefined = decorators.find(
    (candidate: TsDecorator) => candidate.name === 'Generated'
  );
  const generatedStrategy: string | undefined = (() => {
    const strategy: TsValue | undefined = generatedDecorator?.args[0];
    if (generatedDecorator === undefined) {
      return undefined;
    }
    return strategy !== undefined && strategy.kind === 'string'
      ? strategy.value
      : 'increment';
  })();

  const isPrimaryKey: boolean =
    decorator.name === 'PrimaryColumn' ||
    decorator.name === 'PrimaryGeneratedColumn' ||
    boolOption(options, 'primary') === true;

  // Resolve the type -------------------------------------------------------
  let irType: IrScalarType | undefined;
  let enumName: string | undefined;
  let enumInfo: EnumInfo | undefined;
  let strategy: string | undefined;

  if (decorator.name === 'PrimaryGeneratedColumn') {
    strategy =
      first !== undefined && first.kind === 'string'
        ? first.value
        : 'increment';
    if (strategy === 'uuid') {
      irType = 'uuid';
    } else {
      const wanted: string = (spec.typeName ?? '').toLowerCase();
      irType =
        wanted === 'bigint' || wanted === 'int8' || wanted === 'bigserial'
          ? 'bigInt'
          : 'int';
      if (strategy === 'rowid') {
        context.warnings.push(
          `${location}: the "rowid" generation strategy was converted to an auto-increment key.`
        );
      }
    }
  } else if (
    decorator.name === 'CreateDateColumn' ||
    decorator.name === 'UpdateDateColumn' ||
    decorator.name === 'DeleteDateColumn'
  ) {
    irType = 'dateTime';
    if (spec.typeName !== undefined) {
      irType = mapColumnType(spec.typeName, location, context) ?? 'dateTime';
    }
  } else if (decorator.name === 'VersionColumn') {
    irType = 'int';
  } else {
    const resolved = resolveColumnType(
      spec,
      typeInfo,
      location,
      rawClass,
      propertyName,
      context
    );
    irType = resolved.type;
    enumName = resolved.enumName;
    enumInfo = resolved.enumInfo;
  }

  if (
    boolOption(options, 'array') === true ||
    (typeInfo.isArray && irType !== 'json' && irType !== 'bytes')
  ) {
    context.warnings.push(
      `${location}: array columns have no equivalent in the shared model and were converted to json.`
    );
    irType = 'json';
    enumName = undefined;
    enumInfo = undefined;
  }

  // Build the field --------------------------------------------------------
  const columnName: string = stringOption(options, 'name') ?? propertyName;
  const isNullable: boolean =
    !isPrimaryKey &&
    (boolOption(options, 'nullable') === true ||
      decorator.name === 'DeleteDateColumn');
  const field: IrField = {
    name: propertyName,
    columnName,
    type: irType,
    isPrimaryKey,
    isUnique: boolOption(options, 'unique') === true && !isPrimaryKey,
    isNullable,
    isAutoUpdated: decorator.name === 'UpdateDateColumn',
    ...(enumName === undefined ? {} : { enumName }),
  };

  const length: number | undefined =
    numberOption(options, 'length') ??
    (decorator.args[1]?.kind === 'number'
      ? decorator.args[1].value
      : undefined);
  if (length !== undefined && (irType === 'string' || irType === 'text')) {
    field.maxLength = length;
  }
  const precision: number | undefined = numberOption(options, 'precision');
  const scale: number | undefined = numberOption(options, 'scale');
  if (irType === 'decimal') {
    if (precision !== undefined) {
      field.maxDigits = precision;
    }
    if (scale !== undefined) {
      field.decimalPlaces = scale;
    }
  }

  // Defaults ---------------------------------------------------------------
  let defaultValue: IrDefault | undefined;
  if (strategy === 'uuid' || generatedStrategy === 'uuid') {
    defaultValue = { kind: 'uuid' };
    if (irType === 'string') {
      field.type = 'uuid';
    }
  } else if (strategy !== undefined || generatedStrategy !== undefined) {
    defaultValue = { kind: 'autoIncrement' };
  } else if (decorator.name === 'CreateDateColumn') {
    defaultValue = { kind: 'now' };
  } else if (decorator.name === 'VersionColumn') {
    defaultValue = { kind: 'literal', value: 1 };
  }
  const optionDefault: TsValue | undefined = options?.properties['default'];
  if (optionDefault !== undefined && defaultValue === undefined) {
    defaultValue = convertDefault(
      optionDefault,
      field,
      enumName,
      enumInfo,
      location,
      context
    );
  }
  if (defaultValue !== undefined) {
    field.default = defaultValue;
  }

  // Warnings for options with no equivalent ---------------------------------
  for (const [option, description] of Object.entries(
    UNSUPPORTED_COLUMN_OPTIONS
  )) {
    const optionValue: TsValue | undefined = options?.properties[option];
    if (optionValue !== undefined && !isOff(optionValue)) {
      context.warnings.push(
        `${location}: ${description} (option "${option}") has no equivalent and was ignored.`
      );
    }
  }
  noteDecoratorSemantics(decorator, location, context);
  rawClass.members.push({ kind: 'field', field });
}

function noteDecoratorSemantics(
  decorator: TsDecorator,
  location: string,
  context: ParseContext
): void {
  if (decorator.name === 'DeleteDateColumn') {
    context.warnings.push(
      `${location}: @DeleteDateColumn was converted to a nullable timestamp; TypeORM's soft-delete behaviour is not represented.`
    );
  } else if (decorator.name === 'VersionColumn') {
    context.warnings.push(
      `${location}: @VersionColumn was converted to an integer defaulting to 1; the automatic increment on update is not represented.`
    );
  }
}

interface ResolvedType {
  type: IrScalarType;
  enumName?: string;
  enumInfo?: EnumInfo;
}

function mapColumnType(
  typeName: string,
  location: string,
  context: ParseContext
): IrScalarType | undefined {
  const constructorType: IrScalarType | undefined = CONSTRUCTOR_TYPES[typeName];
  if (constructorType !== undefined) {
    return constructorType;
  }
  const key: string = typeName.toLowerCase().replace(/\s*\(.*\)\s*$/, '');
  const mapped: IrScalarType | undefined = COLUMN_TYPES[key];
  if (mapped !== undefined) {
    const note: string | undefined = APPROXIMATED_TYPES[key];
    if (note !== undefined) {
      context.warnings.push(`${location}: column type "${typeName}" ${note}.`);
    }
    return mapped;
  }
  return undefined;
}

function resolveColumnType(
  spec: ColumnSpec,
  typeInfo: TsTypeInfo,
  location: string,
  rawClass: RawClass,
  propertyName: string,
  context: ParseContext
): ResolvedType {
  const typeName: string | undefined = spec.typeName;
  const options: TsObject | undefined = spec.options;
  const enumOption: TsValue | undefined = options?.properties['enum'];
  const isEnumType: boolean =
    typeName !== undefined &&
    (typeName === 'enum' || typeName === 'simple-enum');

  if (isEnumType || enumOption !== undefined) {
    const resolved: ResolvedType | undefined = resolveEnumColumn(
      enumOption,
      stringOption(options, 'enumName'),
      location,
      rawClass,
      propertyName,
      context
    );
    if (resolved !== undefined) {
      return resolved;
    }
    return { type: 'string' };
  }

  if (typeName !== undefined) {
    const mapped: IrScalarType | undefined = mapColumnType(
      typeName,
      location,
      context
    );
    if (mapped !== undefined) {
      return { type: mapped };
    }
    context.warnings.push(
      `${location}: column type "${typeName}" has no equivalent in the shared model and was converted to a string.`
    );
    return { type: 'string' };
  }

  // No explicit type: infer from the TypeScript annotation.
  const firstName: string | undefined = typeInfo.names[0];
  if (firstName === undefined) {
    if (typeInfo.literals.length > 0) {
      return { type: 'string' };
    }
    context.warnings.push(
      `${location}: no column type could be inferred (add a type annotation or an explicit type); it was converted to a string.`
    );
    return { type: 'string' };
  }
  const fromTs: IrScalarType | undefined = TS_TYPE_MAP[firstName];
  if (fromTs !== undefined) {
    return { type: fromTs };
  }
  const enumInfo: EnumInfo | undefined = context.enums.get(firstName);
  if (enumInfo !== undefined) {
    return enumInfo.kind === 'numeric' ? { type: 'int' } : { type: 'string' };
  }
  if (JSON_LIKE_TS_TYPES.has(firstName)) {
    context.warnings.push(
      `${location}: the TypeScript type "${typeInfo.text}" needs an explicit column type; it was converted to json.`
    );
    return { type: 'json' };
  }
  context.warnings.push(
    `${location}: the TypeScript type "${typeInfo.text}" cannot be mapped to a column type; it was converted to a string.`
  );
  return { type: 'string' };
}

function resolveEnumColumn(
  enumOption: TsValue | undefined,
  enumNameOption: string | undefined,
  location: string,
  rawClass: RawClass,
  propertyName: string,
  context: ParseContext
): ResolvedType | undefined {
  if (enumOption === undefined) {
    context.warnings.push(
      `${location}: an enum column was declared without an "enum" option; it was converted to a string.`
    );
    return undefined;
  }

  // Reference to a TypeScript enum, or Object.values(Enum).
  let referenced: string | undefined;
  if (enumOption.kind === 'name') {
    referenced = lastSegment(enumOption.value);
  } else if (
    enumOption.kind === 'call' &&
    enumOption.callee === 'Object.values' &&
    enumOption.args[0]?.kind === 'name'
  ) {
    referenced = lastSegment(enumOption.args[0].value);
  }
  if (referenced !== undefined) {
    const info: EnumInfo | undefined = context.enums.get(referenced);
    if (info === undefined) {
      context.warnings.push(
        `${location}: the enum "${referenced}" was not found in the input files; the column was converted to a string. ` +
          `Add the file that defines it to --input.`
      );
      return undefined;
    }
    if (info.kind === 'numeric') {
      context.warnings.push(
        `${location}: the enum "${referenced}" has numeric values, which the shared model cannot represent; the column was converted to an int.`
      );
      return { type: 'int' };
    }
    return { type: 'string', enumName: referenced, enumInfo: info };
  }

  // Inline list of string values (also the shape of a string-union type).
  if (enumOption.kind === 'array') {
    const values: IrEnumValue[] = [];
    for (const item of enumOption.items) {
      const value: string | undefined = enumItemValue(item, context);
      if (value === undefined) {
        context.warnings.push(
          `${location}: the enum values could not be read statically; the column was converted to a string.`
        );
        return undefined;
      }
      values.push({ name: enumMemberName(value), dbValue: value });
    }
    if (values.length === 0) {
      context.warnings.push(
        `${location}: the enum has no values; the column was converted to a string.`
      );
      return undefined;
    }
    const name: string =
      enumNameOption === undefined
        ? `${rawClass.name}${toPascalCase(propertyName)}`
        : toPascalCase(enumNameOption);
    const info: EnumInfo = { kind: 'string', values };
    context.newEnums.push({ name, values });
    return { type: 'string', enumName: name, enumInfo: info };
  }

  context.warnings.push(
    `${location}: the enum values (${describeValue(enumOption)}) could not be read statically; the column was converted to a string.`
  );
  return undefined;
}

function enumItemValue(
  item: TsValue,
  context: ParseContext
): string | undefined {
  if (item.kind === 'string') {
    return item.value;
  }
  if (item.kind === 'name') {
    const [enumName, memberName]: (string | undefined)[] =
      item.value.split('.');
    const info: EnumInfo | undefined = context.enums.get(enumName ?? '');
    if (info !== undefined && info.kind === 'string') {
      return info.values.find((value: IrEnumValue) => value.name === memberName)
        ?.dbValue;
    }
  }
  return undefined;
}

/** Derives an enum member name from a stored value, for example "in-progress" -> "IN_PROGRESS". */
function enumMemberName(value: string): string {
  const snake: string = toSnakeCase(value).toUpperCase();
  if (snake === '') {
    return 'EMPTY';
  }
  return /^[0-9]/.test(snake) ? `V_${snake}` : snake;
}

function describeValue(value: TsValue): string {
  return value.kind === 'other' ? value.text : value.kind;
}

function convertDefault(
  value: TsValue,
  field: IrField,
  enumName: string | undefined,
  enumInfo: EnumInfo | undefined,
  location: string,
  context: ParseContext
): IrDefault | undefined {
  const enumValues: IrEnumValue[] =
    enumInfo !== undefined && enumInfo.kind === 'string' ? enumInfo.values : [];
  const asEnum = (dbValue: string): IrDefault | undefined => {
    const member: IrEnumValue | undefined = enumValues.find(
      (candidate: IrEnumValue) => candidate.dbValue === dbValue
    );
    return member === undefined
      ? undefined
      : { kind: 'enumValue', value: member.name };
  };

  switch (value.kind) {
    case 'null':
      return undefined;
    case 'bool':
    case 'number':
      return { kind: 'literal', value: value.value };
    case 'string':
      if (enumName !== undefined) {
        const member: IrDefault | undefined = asEnum(value.value);
        if (member !== undefined) {
          return member;
        }
      }
      return { kind: 'literal', value: value.value };
    case 'name': {
      const [enumRef, memberName]: (string | undefined)[] =
        value.value.split('.');
      const referenced: EnumInfo | undefined = context.enums.get(enumRef ?? '');
      if (
        referenced !== undefined &&
        referenced.kind === 'string' &&
        memberName !== undefined
      ) {
        const member: IrEnumValue | undefined = referenced.values.find(
          (candidate: IrEnumValue) => candidate.name === memberName
        );
        if (member !== undefined) {
          return enumName === undefined
            ? { kind: 'literal', value: member.dbValue }
            : { kind: 'enumValue', value: member.name };
        }
      }
      break;
    }
    case 'arrow': {
      const body: TsValue = value.body;
      if (body.kind === 'string') {
        return convertSqlDefault(
          body.value,
          field,
          enumName,
          asEnum,
          location,
          context
        );
      }
      break;
    }
    default:
      break;
  }
  context.warnings.push(
    `${location}: the default value (${describeValue(value)}) cannot be evaluated statically and was skipped.`
  );
  return undefined;
}

function convertSqlDefault(
  sql: string,
  field: IrField,
  enumName: string | undefined,
  asEnum: (dbValue: string) => IrDefault | undefined,
  location: string,
  context: ParseContext
): IrDefault | undefined {
  const trimmed: string = sql.trim();
  if (NOW_SQL.test(trimmed)) {
    return { kind: 'now' };
  }
  if (UUID_SQL.test(trimmed)) {
    return { kind: 'uuid' };
  }
  if (/^null$/i.test(trimmed)) {
    return undefined;
  }
  if (/^(true|false)$/i.test(trimmed)) {
    return { kind: 'literal', value: trimmed.toLowerCase() === 'true' };
  }
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
    return field.type === 'string' || field.type === 'text'
      ? { kind: 'literal', value: trimmed }
      : { kind: 'literal', value: Number(trimmed) };
  }
  const quoted: RegExpExecArray | null = QUOTED_SQL.exec(trimmed);
  if (quoted !== null) {
    const text: string = (quoted[1] ?? '').replace(/''/g, "'");
    if (enumName !== undefined) {
      const member: IrDefault | undefined = asEnum(text);
      if (member !== undefined) {
        return member;
      }
    }
    return { kind: 'literal', value: text };
  }
  context.warnings.push(
    `${location}: the SQL default "${sql}" has no equivalent and was skipped.`
  );
  return undefined;
}

// ---------------------------------------------------------------------------
// Relations
// ---------------------------------------------------------------------------

function parseRelation(
  decorator: TsDecorator,
  decorators: TsDecorator[],
  propertyName: string,
  location: string,
  rawClass: RawClass,
  context: ParseContext
): void {
  const targetModel: string | undefined = arrowTargetName(decorator.args[0]);
  if (targetModel === undefined) {
    context.warnings.push(
      `${location}: the target of @${decorator.name} could not be resolved (use an arrow function such as () => User); the relation was skipped.`
    );
    return;
  }
  const inverseArgument: TsValue | undefined = decorator.args.find(
    (value: TsValue, index: number) => index > 0 && value.kind !== 'object'
  );
  const inverseProperty: string | undefined = inverseSideName(inverseArgument);
  const options: TsObject | undefined = objectArgument(decorator.args);

  const joinColumn: TsDecorator | undefined = decorators.find(
    (candidate: TsDecorator) => candidate.name === 'JoinColumn'
  );
  const joinTable: TsDecorator | undefined = decorators.find(
    (candidate: TsDecorator) => candidate.name === 'JoinTable'
  );

  if (boolOption(options, 'createForeignKeyConstraints') === false) {
    context.warnings.push(
      `${location}: createForeignKeyConstraints: false has no equivalent; the foreign key constraint is included in the output.`
    );
  }
  if (options?.properties['onUpdate'] !== undefined) {
    context.warnings.push(
      `${location}: the onUpdate option of @${decorator.name} has no equivalent and was ignored.`
    );
  }

  const isOwner: boolean =
    decorator.name === 'ManyToOne' ||
    (decorator.name === 'OneToOne' && joinColumn !== undefined) ||
    (decorator.name === 'ManyToMany' && joinTable !== undefined);

  if (!isOwner) {
    rawClass.members.push({
      kind: 'inverse',
      property: propertyName,
      targetModel,
      ...(inverseProperty === undefined ? {} : { inverseProperty }),
      relationKind:
        decorator.name === 'OneToMany'
          ? 'oneToMany'
          : decorator.name === 'ManyToMany'
            ? 'manyToMany'
            : 'oneToOne',
    });
    return;
  }

  const kind: IrRelation['kind'] =
    decorator.name === 'ManyToMany'
      ? 'manyToMany'
      : decorator.name === 'OneToOne'
        ? 'oneToOne'
        : 'foreignKey';

  let explicitColumn: string | undefined;
  let referencedColumn: string | undefined;
  if (kind !== 'manyToMany' && joinColumn !== undefined) {
    const joinArgument: TsValue | undefined = joinColumn.args[0];
    if (joinArgument !== undefined && joinArgument.kind === 'array') {
      if (joinArgument.items.length > 1) {
        context.warnings.push(
          `${location}: composite foreign keys (several @JoinColumn entries) are not supported; the relation was skipped.`
        );
        return;
      }
      const single: TsValue | undefined = joinArgument.items[0];
      if (single !== undefined && single.kind === 'object') {
        explicitColumn = stringOption(single, 'name');
        referencedColumn = stringOption(single, 'referencedColumnName');
      }
    } else if (joinArgument !== undefined && joinArgument.kind === 'object') {
      explicitColumn = stringOption(joinArgument, 'name');
      referencedColumn = stringOption(joinArgument, 'referencedColumnName');
    }
  }
  if (kind === 'manyToMany' && joinTable !== undefined) {
    const joinOptions: TsObject | undefined = objectArgument(joinTable.args);
    if (
      joinOptions !== undefined &&
      Object.keys(joinOptions.properties).length > 0
    ) {
      context.warnings.push(
        `${location}: custom @JoinTable settings (${Object.keys(joinOptions.properties).join(', ')}) are not preserved; ` +
          `the join table name and columns are derived from the models.`
      );
    }
  }

  const onDeleteValue: string | undefined = stringOption(options, 'onDelete');
  let onDelete: IrOnDelete = 'noAction';
  if (onDeleteValue !== undefined) {
    const mapped: IrOnDelete | undefined =
      ON_DELETE_MAP[onDeleteValue.toUpperCase()];
    if (mapped === undefined) {
      context.warnings.push(
        `${location}: onDelete "${onDeleteValue}" has no equivalent and was converted to NoAction.`
      );
    } else {
      onDelete = mapped;
    }
  }
  if (kind === 'manyToMany') {
    onDelete = 'cascade';
  }

  const nullableOption: boolean | undefined = boolOption(options, 'nullable');
  const isPrimaryKey: boolean = boolOption(options, 'primary') === true;
  const relation: IrRelation = {
    name: propertyName,
    kind,
    targetModel,
    columnName:
      explicitColumn ?? defaultJoinColumn(propertyName, referencedColumn),
    // TypeORM relations are nullable unless nullable: false is given.
    isNullable: !isPrimaryKey && nullableOption !== false,
    onDelete,
    ...(inverseProperty === undefined ? {} : { relatedName: inverseProperty }),
    ...(referencedColumn === undefined ? {} : { toField: referencedColumn }),
    ...(isPrimaryKey ? { isPrimaryKey: true } : {}),
  };
  rawClass.members.push({
    kind: 'relation',
    relation,
    hasExplicitColumn: explicitColumn !== undefined,
    hasExplicitNullable: nullableOption !== undefined,
  });
}

/** TypeORM's default join column name: camelCase(propertyName + "_" + referencedColumn). */
function defaultJoinColumn(
  propertyName: string,
  referencedColumn: string | undefined
): string {
  return toCamelCase(`${propertyName}_${referencedColumn ?? 'id'}`);
}

// ---------------------------------------------------------------------------
// Schema assembly (inheritance, embedded entities, inverse sides)
// ---------------------------------------------------------------------------

interface Collected {
  fields: IrField[];
  relations: Extract<Member, { kind: 'relation' }>[];
  inverses: Extract<Member, { kind: 'inverse' }>[];
  indexes: RawIndex[];
}

function buildSchema(
  classes: RawClass[],
  enums: IrEnum[],
  warnings: string[],
  options: TypeormParseOptions
): IrSchema {
  const classByName: Map<string, RawClass> = new Map();
  for (const rawClass of classes) {
    if (classByName.has(rawClass.name)) {
      warnings.push(
        `Duplicate class name "${rawClass.name}" (${rawClass.filePath}); only the first definition was converted.`
      );
      continue;
    }
    classByName.set(rawClass.name, rawClass);
  }

  const models: IrModel[] = [];
  const inverseSides: {
    model: string;
    inverse: Extract<Member, { kind: 'inverse' }>;
  }[] = [];
  const relationMembers: Map<string, Extract<Member, { kind: 'relation' }>[]> =
    new Map();

  for (const rawClass of classByName.values()) {
    if (!rawClass.isEntity || rawClass.isAbstract || rawClass.isChildEntity) {
      continue;
    }
    const collected: Collected = collectMembers(
      rawClass,
      classByName,
      warnings,
      new Set()
    );
    const model: IrModel = finalizeModel(
      rawClass,
      collected,
      warnings,
      options
    );
    models.push(model);
    relationMembers.set(model.name, collected.relations);
    for (const inverse of collected.inverses) {
      inverseSides.push({ model: model.name, inverse });
    }
  }

  resolveRelations(models, inverseSides, warnings);
  addStubModels(models, warnings, options);
  resolveDefaultColumns(models);

  return { models, enums: pruneEnums(enums, models), warnings };
}

function collectMembers(
  rawClass: RawClass,
  classByName: Map<string, RawClass>,
  warnings: string[],
  visiting: Set<string>
): Collected {
  const inherited: Collected = {
    fields: [],
    relations: [],
    inverses: [],
    indexes: [],
  };
  visiting.add(rawClass.name);

  if (rawClass.baseName !== undefined) {
    const parent: RawClass | undefined = classByName.get(rawClass.baseName);
    if (parent === undefined) {
      if (rawClass.baseName !== 'BaseEntity') {
        warnings.push(
          `${rawClass.name}: base class "${rawClass.baseName}" was not found in the input files, so any columns it defines ` +
            `are missing. Add the file that defines it to --input.`
        );
      }
    } else if (visiting.has(parent.name)) {
      warnings.push(
        `${rawClass.name}: circular inheritance through "${parent.name}" was ignored.`
      );
    } else {
      const parentMembers: Collected = collectMembers(
        parent,
        classByName,
        warnings,
        new Set(visiting)
      );
      inherited.fields.push(...parentMembers.fields);
      inherited.relations.push(...parentMembers.relations);
      inherited.inverses.push(...parentMembers.inverses);
      inherited.indexes.push(...parentMembers.indexes);
    }
  }

  const own: Collected = {
    fields: [],
    relations: [],
    inverses: [],
    indexes: [],
  };
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
            [],
            `${rawClass.name}.${member.property}`,
            classByName,
            warnings,
            new Set([rawClass.name])
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
    own.relations.map((member) => member.relation.name)
  );
  const ownInverseNames: Set<string> = new Set(
    own.inverses.map((member) => member.property)
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
        (member) => !ownRelationNames.has(member.relation.name)
      ),
      ...own.relations,
    ],
    inverses: [
      ...inherited.inverses.filter(
        (member) => !ownInverseNames.has(member.property)
      ),
      ...own.inverses,
    ],
    indexes: [...inherited.indexes, ...own.indexes],
  };
}

/** TypeORM's titleCase: first letter upper case, remaining letters lower case. */
function titleCase(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1).toLowerCase();
}

function embeddedName(prefixes: string[], name: string): string {
  return prefixes.length === 0
    ? name
    : toCamelCase(prefixes.join('_')) + titleCase(name);
}

/** Flattens an embedded entity into prefixed columns, the way TypeORM names them. */
function expandEmbedded(
  embedded: Extract<Member, { kind: 'embedded' }>,
  outerPrefixes: string[],
  location: string,
  classByName: Map<string, RawClass>,
  warnings: string[],
  visiting: Set<string>
): IrField[] {
  const embeddedClass: RawClass | undefined = classByName.get(
    embedded.typeName
  );
  if (embeddedClass === undefined) {
    warnings.push(
      `${location}: the embedded type "${embedded.typeName}" was not found in the input files, so its columns are missing. ` +
        `Add the file that defines it to --input.`
    );
    return [];
  }
  if (visiting.has(embeddedClass.name)) {
    warnings.push(`${location}: a recursive embedded type was ignored.`);
    return [];
  }
  const prefixes: string[] =
    embedded.prefix === false
      ? outerPrefixes
      : [...outerPrefixes, embedded.prefix ?? embedded.property];

  const collected: Collected = collectMembers(
    embeddedClass,
    classByName,
    warnings,
    new Set()
  );
  const nestedVisiting: Set<string> = new Set([
    ...visiting,
    embeddedClass.name,
  ]);
  const fields: IrField[] = collected.fields.map((field: IrField): IrField => {
    return {
      ...field,
      name: embeddedName(prefixes, field.name),
      columnName: embeddedName(prefixes, field.columnName),
    };
  });
  // Nested embedded entities appear as members of the embedded class itself.
  for (const member of embeddedClass.members) {
    if (member.kind === 'embedded') {
      fields.push(
        ...expandEmbedded(
          member,
          prefixes,
          `${location}.${member.property}`,
          classByName,
          warnings,
          nestedVisiting
        )
      );
    } else if (member.kind === 'relation' || member.kind === 'inverse') {
      const name: string =
        member.kind === 'relation' ? member.relation.name : member.property;
      warnings.push(
        `${location}.${name}: relations inside embedded entities are not supported and were skipped.`
      );
    }
  }
  if (collected.indexes.length > 0) {
    warnings.push(
      `${location}: indexes declared inside the embedded type "${embedded.typeName}" were skipped.`
    );
  }
  return fields;
}

function finalizeModel(
  rawClass: RawClass,
  collected: Collected,
  warnings: string[],
  options: TypeormParseOptions
): IrModel {
  const fields: IrField[] = [...collected.fields];
  const relations: IrRelation[] = [];
  /** Scalar foreign-key properties merged into relations: property name -> relation name. */
  const renamed: Map<string, string> = new Map();

  for (const member of collected.relations) {
    const relation: IrRelation = { ...member.relation };
    if (relation.kind !== 'manyToMany') {
      const backing: number = fields.findIndex(
        (field: IrField) =>
          field.columnName === relation.columnName ||
          (!member.hasExplicitColumn && field.name === relation.columnName)
      );
      const backingField: IrField | undefined = fields[backing];
      if (backingField !== undefined) {
        // The entity also declares the foreign key column as a plain property;
        // the relation already represents it.
        fields.splice(backing, 1);
        renamed.set(backingField.name, relation.name);
        relation.columnName = backingField.columnName;
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

  const indexes: IrIndex[] = [];
  for (const raw of collected.indexes) {
    const names: string[] = raw.fields.map(
      (name: string) => renamed.get(name) ?? name
    );
    const known: Set<string> = new Set([
      ...fields.map((field: IrField) => field.name),
      ...relations.map((relation: IrRelation) => relation.name),
    ]);
    const missing: string[] = names.filter((name: string) => !known.has(name));
    if (missing.length > 0) {
      warnings.push(
        `${rawClass.name}: the ${raw.isUnique ? 'unique constraint' : 'index'} on (${raw.fields.join(', ')}) refers to ` +
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
    indexes.push({
      fields: names,
      isUnique: raw.isUnique,
      ...(raw.name === undefined ? {} : { name: raw.name }),
    });
  }

  const primaryFields: IrField[] = fields.filter(
    (field: IrField) => field.isPrimaryKey
  );
  const primaryRelations: IrRelation[] = relations.filter(
    (relation: IrRelation) => relation.isPrimaryKey === true
  );
  const keyCount: number = primaryFields.length + primaryRelations.length;
  let compositePrimaryKey: string[] | undefined;
  if (keyCount === 0) {
    warnings.push(
      `${rawClass.name}: the entity has no primary key column; TypeORM requires one, so add @PrimaryGeneratedColumn() or @PrimaryColumn().`
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

  return {
    name: rawClass.name,
    tableName: rawClass.tableName ?? toSnakeCase(rawClass.name),
    appLabel: options.appLabel,
    fields,
    relations,
    indexes,
    ...(compositePrimaryKey === undefined ? {} : { compositePrimaryKey }),
  };
}

/** Links inverse-side decorators (@OneToMany and friends) to the owning relation. */
function resolveRelations(
  models: IrModel[],
  inverseSides: {
    model: string;
    inverse: Extract<Member, { kind: 'inverse' }>;
  }[],
  warnings: string[]
): void {
  const byName: Map<string, IrModel> = new Map(
    models.map((model: IrModel) => [model.name, model])
  );
  for (const { model, inverse } of inverseSides) {
    const location: string = `${model}.${inverse.property}`;
    const target: IrModel | undefined = byName.get(inverse.targetModel);
    if (target === undefined) {
      continue;
    }
    if (inverse.inverseProperty === undefined) {
      warnings.push(
        `${location}: the inverse side of this @${inverse.relationKind === 'oneToMany' ? 'OneToMany' : inverse.relationKind === 'manyToMany' ? 'ManyToMany' : 'OneToOne'} ` +
          `has no inverse-side function, so it could not be linked to "${inverse.targetModel}".`
      );
      continue;
    }
    const owner: IrRelation | undefined = target.relations.find(
      (relation: IrRelation) => relation.name === inverse.inverseProperty
    );
    if (owner === undefined) {
      warnings.push(
        `${location}: the owning side "${inverse.targetModel}.${inverse.inverseProperty}" was not found ` +
          `(for a one-to-one or many-to-many relation, the owning side needs @JoinColumn or @JoinTable); the reverse accessor is not included.`
      );
      continue;
    }
    if (owner.relatedName === undefined) {
      owner.relatedName = inverse.property;
    } else if (owner.relatedName !== inverse.property) {
      warnings.push(
        `${location}: the owning side "${inverse.targetModel}.${inverse.inverseProperty}" names its reverse accessor ` +
          `"${owner.relatedName}"; "${inverse.property}" was ignored.`
      );
    }
  }
}

function addStubModels(
  models: IrModel[],
  warnings: string[],
  options: TypeormParseOptions
): void {
  const known: Set<string> = new Set(
    models.map((model: IrModel) => model.name)
  );
  const stubs: IrModel[] = [];
  for (const model of models) {
    for (const relation of model.relations) {
      const target: string = relation.targetModel;
      if (known.has(target)) {
        continue;
      }
      known.add(target);
      stubs.push({
        name: target,
        tableName: toSnakeCase(target),
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
        `${model.name}.${relation.name} references "${target}", which is not an entity in the input. ` +
          `A stub model with an auto-increment id was generated; replace it with the real definition.`
      );
    }
  }
  models.push(...stubs);
}

/** Foreign keys without an explicit column take the referenced key's name, as TypeORM does. */
function resolveDefaultColumns(models: IrModel[]): void {
  const byName: Map<string, IrModel> = new Map(
    models.map((model: IrModel) => [model.name, model])
  );
  for (const model of models) {
    for (const relation of model.relations) {
      if (relation.kind === 'manyToMany') {
        continue;
      }
      const defaultName: string = defaultJoinColumn(
        relation.name,
        relation.toField
      );
      if (
        relation.columnName !== defaultName ||
        relation.toField !== undefined
      ) {
        continue;
      }
      const target: IrModel | undefined = byName.get(relation.targetModel);
      const key: IrField | undefined = target?.fields.find(
        (field: IrField) => field.isPrimaryKey
      );
      if (key !== undefined && key.columnName !== 'id') {
        relation.columnName = defaultJoinColumn(relation.name, key.columnName);
      }
    }
  }
}

/** Keeps only enums that a converted field refers to. */
function pruneEnums(enums: IrEnum[], models: IrModel[]): IrEnum[] {
  const used: Set<string> = new Set(
    models.flatMap((model: IrModel) =>
      model.fields.flatMap((field: IrField) =>
        field.enumName === undefined ? [] : [field.enumName]
      )
    )
  );
  return enums.filter((enumeration: IrEnum) => used.has(enumeration.name));
}
