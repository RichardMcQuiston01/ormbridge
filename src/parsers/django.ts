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
import { toPascalCase } from '../naming.js';
import { err, ok, type Result } from '../result.js';
import {
  evaluateNode,
  getPythonParser,
  lastSegment,
  type PyCall,
  type PyValue,
  type SyntaxNode,
} from './pythonSyntax.js';

export interface DjangoSourceFile {
  path: string;
  text: string;
  /** Django app label, used for default table names (app_model). */
  appLabel: string;
}

export interface DjangoParseOptions {
  /** Primary key type for models without an explicit primary key. */
  autoField: 'int' | 'bigInt';
}

interface ScalarSpec {
  type: IrScalarType;
  isAutoIncrement?: boolean;
  defaultMaxLength?: number;
}

const SCALAR_FIELDS: Readonly<Record<string, ScalarSpec>> = {
  AutoField: { type: 'int', isAutoIncrement: true },
  SmallAutoField: { type: 'int', isAutoIncrement: true },
  BigAutoField: { type: 'bigInt', isAutoIncrement: true },
  CharField: { type: 'string' },
  SlugField: { type: 'string', defaultMaxLength: 50 },
  EmailField: { type: 'string', defaultMaxLength: 254 },
  URLField: { type: 'string', defaultMaxLength: 200 },
  FileField: { type: 'string', defaultMaxLength: 100 },
  ImageField: { type: 'string', defaultMaxLength: 100 },
  FilePathField: { type: 'string', defaultMaxLength: 100 },
  GenericIPAddressField: { type: 'string', defaultMaxLength: 39 },
  TextField: { type: 'text' },
  IntegerField: { type: 'int' },
  SmallIntegerField: { type: 'int' },
  PositiveIntegerField: { type: 'int' },
  PositiveSmallIntegerField: { type: 'int' },
  BigIntegerField: { type: 'bigInt' },
  PositiveBigIntegerField: { type: 'bigInt' },
  DurationField: { type: 'bigInt' },
  FloatField: { type: 'float' },
  DecimalField: { type: 'decimal' },
  BooleanField: { type: 'boolean' },
  NullBooleanField: { type: 'boolean' },
  DateTimeField: { type: 'dateTime' },
  DateField: { type: 'date' },
  TimeField: { type: 'time' },
  UUIDField: { type: 'uuid' },
  JSONField: { type: 'json' },
  BinaryField: { type: 'bytes' },
};

const RELATION_FIELDS: ReadonlySet<string> = new Set([
  'ForeignKey',
  'OneToOneField',
  'ManyToManyField',
]);

const ON_DELETE_MAP: Readonly<Record<string, IrOnDelete>> = {
  CASCADE: 'cascade',
  SET_NULL: 'setNull',
  PROTECT: 'restrict',
  RESTRICT: 'restrict',
  DO_NOTHING: 'noAction',
  SET_DEFAULT: 'setDefault',
};

const NOW_CALLABLES: ReadonlySet<string> = new Set([
  'now',
  'timezone.now',
  'datetime.now',
  'datetime.datetime.now',
]);

type EnumInfo =
  | { kind: 'string'; enumName: string; values: IrEnumValue[] }
  | { kind: 'integer' };

interface RawModel {
  name: string;
  appLabel: string;
  filePath: string;
  bases: string[];
  isAbstract: boolean;
  isProxy: boolean;
  tableName?: string;
  fields: IrField[];
  relations: IrRelation[];
  indexes: IrIndex[];
}

interface ParsedFile {
  models: RawModel[];
  enums: IrEnum[];
  warnings: string[];
}

interface FieldContext {
  modelName: string;
  enumByClass: Map<string, EnumInfo>;
  newEnums: IrEnum[];
  warnings: string[];
}

interface MetaInfo {
  isAbstract: boolean;
  isProxy: boolean;
  tableName?: string;
  appLabel?: string;
  indexes: IrIndex[];
}

/** Parses Django model files into the shared IR using tree-sitter (no Python required). */
export async function parseDjango(
  sources: DjangoSourceFile[],
  options: DjangoParseOptions
): Promise<Result<IrSchema>> {
  const parserResult: Result<Parser> = await getPythonParser();
  if (!parserResult.ok) {
    return parserResult;
  }
  const parser: Parser = parserResult.value;

  const parsedFiles: ParsedFile[] = sources.map((source: DjangoSourceFile) =>
    parseFile(parser, source)
  );
  const schema: IrSchema = buildSchema(parsedFiles, options);

  if (schema.models.length === 0) {
    const checkedPaths: string = sources
      .map((source: DjangoSourceFile) => source.path)
      .join(', ');
    return err(
      'NO_MODELS_FOUND',
      `No concrete Django models were found in: ${checkedPaths}. A model is a class inheriting from ` +
        `models.Model (directly, or through an abstract base) that is not marked abstract = True in its Meta class.`
    );
  }
  return ok(schema);
}

// ---------------------------------------------------------------------------
// File parsing
// ---------------------------------------------------------------------------

function parseFile(parser: Parser, source: DjangoSourceFile): ParsedFile {
  const warnings: string[] = [];
  const models: RawModel[] = [];
  const enums: IrEnum[] = [];

  const tree: Parser.Tree = parser.parse(source.text);
  if (tree.rootNode.hasError) {
    warnings.push(
      `${source.path}: the file contains Python syntax errors; some models or fields may be missing from the output.`
    );
  }

  const classNodes: SyntaxNode[] = collectTopLevelClasses(tree.rootNode);
  const enumByClass: Map<string, EnumInfo> = new Map();

  for (const classNode of classNodes) {
    const className: string = classNameOf(classNode);
    if (isChoicesClass(classNode)) {
      const info: EnumInfo = parseChoicesClass(classNode, className, enums);
      enumByClass.set(className, info);
    }
  }

  for (const classNode of classNodes) {
    const className: string = classNameOf(classNode);
    if (isChoicesClass(classNode)) {
      continue;
    }
    const bases: string[] = basesOf(classNode);
    const rawModel: RawModel | undefined = parseModelClass(
      classNode,
      className,
      bases,
      source,
      enumByClass,
      enums,
      warnings
    );
    if (rawModel !== undefined) {
      models.push(rawModel);
    }
  }

  return { models, enums, warnings };
}

function collectTopLevelClasses(root: SyntaxNode): SyntaxNode[] {
  const classNodes: SyntaxNode[] = [];
  for (const child of root.namedChildren) {
    if (child.type === 'class_definition') {
      classNodes.push(child);
    } else if (child.type === 'decorated_definition') {
      const definition: SyntaxNode | null =
        child.childForFieldName('definition');
      if (definition !== null && definition.type === 'class_definition') {
        classNodes.push(definition);
      }
    }
  }
  return classNodes;
}

function classNameOf(classNode: SyntaxNode): string {
  const nameNode: SyntaxNode | null = classNode.childForFieldName('name');
  return nameNode === null ? '' : nameNode.text;
}

function basesOf(classNode: SyntaxNode): string[] {
  const superclasses: SyntaxNode | null =
    classNode.childForFieldName('superclasses');
  if (superclasses === null) {
    return [];
  }
  return superclasses.namedChildren
    .filter(
      (child: SyntaxNode) =>
        child.type !== 'keyword_argument' && child.type !== 'comment'
    )
    .map((child: SyntaxNode) => child.text.replace(/\s+/g, ''));
}

function bodyStatements(classNode: SyntaxNode): SyntaxNode[] {
  const body: SyntaxNode | null = classNode.childForFieldName('body');
  return body === null ? [] : body.namedChildren;
}

const MODEL_BASE_NAMES: ReadonlySet<string> = new Set([
  'Model',
  'AbstractUser',
  'AbstractBaseUser',
]);

function isDjangoModelBase(baseName: string): boolean {
  return MODEL_BASE_NAMES.has(lastSegment(baseName));
}

/** True when the class is a model: it has fields, a Django base, or inherits from another model. */
function isModelClass(
  rawModel: RawModel,
  rawByName: Map<string, RawModel>,
  visiting: Set<string>
): boolean {
  if (
    rawModel.fields.length > 0 ||
    rawModel.relations.length > 0 ||
    rawModel.bases.some(isDjangoModelBase)
  ) {
    return true;
  }
  visiting.add(rawModel.name);
  return rawModel.bases.some((baseName: string): boolean => {
    const parent: RawModel | undefined = rawByName.get(lastSegment(baseName));
    return (
      parent !== undefined &&
      !visiting.has(parent.name) &&
      isModelClass(parent, rawByName, new Set(visiting))
    );
  });
}

function isChoicesClass(classNode: SyntaxNode): boolean {
  return basesOf(classNode).some((base: string) =>
    /Choices$/.test(lastSegment(base))
  );
}

/** Returns the evaluated call when the statement looks like `name = something(...)`. */
function assignmentOf(
  statement: SyntaxNode
): { name: string; value: PyValue } | undefined {
  if (statement.type !== 'expression_statement') {
    return undefined;
  }
  const assignment: SyntaxNode | undefined = statement.namedChildren[0];
  if (assignment === undefined || assignment.type !== 'assignment') {
    return undefined;
  }
  const left: SyntaxNode | null = assignment.childForFieldName('left');
  const right: SyntaxNode | null = assignment.childForFieldName('right');
  if (left === null || right === null || left.type !== 'identifier') {
    return undefined;
  }
  return { name: left.text, value: evaluateNode(right) };
}

function fieldCallOf(
  statement: SyntaxNode
): { name: string; call: PyCall } | undefined {
  const assignment = assignmentOf(statement);
  if (assignment === undefined || assignment.value.kind !== 'call') {
    return undefined;
  }
  const calleeName: string = lastSegment(assignment.value.callee);
  if (
    RELATION_FIELDS.has(calleeName) ||
    calleeName in SCALAR_FIELDS ||
    calleeName.endsWith('Field')
  ) {
    return { name: assignment.name, call: assignment.value };
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Choices (TextChoices / IntegerChoices) -> enums
// ---------------------------------------------------------------------------

function parseChoicesClass(
  classNode: SyntaxNode,
  enumName: string,
  enums: IrEnum[]
): EnumInfo {
  const isInteger: boolean = basesOf(classNode).some(
    (base: string) => lastSegment(base) === 'IntegerChoices'
  );
  if (isInteger) {
    return { kind: 'integer' };
  }
  const values: IrEnumValue[] = [];
  for (const statement of bodyStatements(classNode)) {
    const assignment = assignmentOf(statement);
    if (assignment === undefined || assignment.name.startsWith('_')) {
      continue;
    }
    const value: PyValue = assignment.value;
    if (value.kind === 'string') {
      values.push({
        name: assignment.name,
        dbValue: value.value,
        label: toPascalCase(assignment.name),
      });
    } else if (value.kind === 'list') {
      const first: PyValue | undefined = value.items[0];
      const second: PyValue | undefined = value.items[1];
      if (first !== undefined && first.kind === 'string') {
        const label: string | undefined =
          second !== undefined && second.kind === 'string'
            ? second.value
            : undefined;
        values.push({
          name: assignment.name,
          dbValue: first.value,
          ...(label === undefined ? {} : { label }),
        });
      }
    }
  }
  enums.push({ name: enumName, values });
  return { kind: 'string', enumName, values };
}

function memberNameFromValue(rawValue: string, usedNames: Set<string>): string {
  let memberName: string = rawValue
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase();
  if (memberName.length === 0 || /^[0-9]/.test(memberName)) {
    memberName = `V_${memberName}`;
  }
  let candidate: string = memberName;
  let suffix: number = 2;
  while (usedNames.has(candidate)) {
    candidate = `${memberName}_${suffix}`;
    suffix += 1;
  }
  usedNames.add(candidate);
  return candidate;
}

// ---------------------------------------------------------------------------
// Model classes
// ---------------------------------------------------------------------------

function parseModelClass(
  classNode: SyntaxNode,
  className: string,
  bases: string[],
  source: DjangoSourceFile,
  fileEnums: Map<string, EnumInfo>,
  allEnums: IrEnum[],
  warnings: string[]
): RawModel | undefined {
  const enumByClass: Map<string, EnumInfo> = new Map(fileEnums);
  const statements: SyntaxNode[] = bodyStatements(classNode);

  // Nested Choices classes are namespaced by their model to keep enum names unique.
  for (const statement of statements) {
    if (statement.type === 'class_definition' && isChoicesClass(statement)) {
      const nestedName: string = classNameOf(statement);
      const info: EnumInfo = parseChoicesClass(
        statement,
        `${className}${nestedName}`,
        allEnums
      );
      enumByClass.set(nestedName, info);
    }
  }

  const fieldContext: FieldContext = {
    modelName: className,
    enumByClass,
    newEnums: allEnums,
    warnings,
  };
  const fields: IrField[] = [];
  const relations: IrRelation[] = [];
  const indexes: IrIndex[] = [];
  let meta: MetaInfo = { isAbstract: false, isProxy: false, indexes: [] };

  for (const statement of statements) {
    if (
      statement.type === 'class_definition' &&
      classNameOf(statement) === 'Meta'
    ) {
      meta = parseMeta(
        statement,
        `${source.path}: ${className}.Meta`,
        warnings
      );
      continue;
    }
    const fieldCall = fieldCallOf(statement);
    if (fieldCall === undefined) {
      continue;
    }
    const parsed = parseFieldCall(fieldCall.name, fieldCall.call, fieldContext);
    if (parsed.field !== undefined) {
      fields.push(parsed.field);
    }
    if (parsed.relation !== undefined) {
      relations.push(parsed.relation);
    }
    if (parsed.index !== undefined) {
      indexes.push(parsed.index);
    }
  }

  if (bases.length === 0 && fields.length === 0 && relations.length === 0) {
    // A plain Python class with no bases and no model fields (helper, constants): not a model.
    return undefined;
  }

  return {
    name: className,
    appLabel: meta.appLabel ?? source.appLabel,
    filePath: source.path,
    bases,
    isAbstract: meta.isAbstract,
    isProxy: meta.isProxy,
    ...(meta.tableName === undefined ? {} : { tableName: meta.tableName }),
    fields,
    relations,
    indexes: [...indexes, ...meta.indexes],
  };
}

function parseMeta(
  metaNode: SyntaxNode,
  location: string,
  warnings: string[]
): MetaInfo {
  const meta: MetaInfo = { isAbstract: false, isProxy: false, indexes: [] };
  for (const statement of bodyStatements(metaNode)) {
    const assignment = assignmentOf(statement);
    if (assignment === undefined) {
      continue;
    }
    const value: PyValue = assignment.value;
    switch (assignment.name) {
      case 'abstract':
        meta.isAbstract = value.kind === 'bool' && value.value;
        break;
      case 'proxy':
        meta.isProxy = value.kind === 'bool' && value.value;
        break;
      case 'db_table':
        if (value.kind === 'string') {
          meta.tableName = value.value;
        }
        break;
      case 'app_label':
        if (value.kind === 'string') {
          meta.appLabel = value.value;
        }
        break;
      case 'managed':
        if (value.kind === 'bool' && !value.value) {
          warnings.push(
            `${location}: managed = False is ignored; the model is converted like any other table.`
          );
        }
        break;
      case 'unique_together':
        meta.indexes.push(...parseUniqueTogether(value));
        break;
      case 'index_together':
        meta.indexes.push(
          ...parseUniqueTogether(value).map((index: IrIndex) => ({
            ...index,
            isUnique: false,
          }))
        );
        break;
      case 'indexes':
        meta.indexes.push(...parseIndexList(value, false, location, warnings));
        break;
      case 'constraints':
        meta.indexes.push(...parseIndexList(value, true, location, warnings));
        break;
      default:
        break;
    }
  }
  return meta;
}

function stringItems(value: PyValue | undefined): string[] {
  if (value === undefined) {
    return [];
  }
  if (value.kind === 'string') {
    return [value.value];
  }
  if (value.kind === 'list') {
    return value.items.flatMap((item: PyValue) =>
      item.kind === 'string' ? [item.value.replace(/^-/, '')] : []
    );
  }
  return [];
}

function parseUniqueTogether(value: PyValue): IrIndex[] {
  if (value.kind !== 'list') {
    return [];
  }
  const allStrings: boolean = value.items.every(
    (item: PyValue) => item.kind === 'string'
  );
  if (allStrings) {
    return [{ fields: stringItems(value), isUnique: true }];
  }
  return value.items
    .map((item: PyValue): IrIndex => ({
      fields: stringItems(item),
      isUnique: true,
    }))
    .filter((index: IrIndex) => index.fields.length > 0);
}

function parseIndexList(
  value: PyValue,
  constraintsOnly: boolean,
  location: string,
  warnings: string[]
): IrIndex[] {
  if (value.kind !== 'list') {
    return [];
  }
  const indexes: IrIndex[] = [];
  for (const item of value.items) {
    if (item.kind !== 'call') {
      continue;
    }
    const calleeName: string = lastSegment(item.callee);
    const fields: string[] = stringItems(item.kwargs['fields']);
    const explicitName: PyValue | undefined = item.kwargs['name'];
    const name: string | undefined =
      explicitName !== undefined && explicitName.kind === 'string'
        ? explicitName.value
        : undefined;
    if (calleeName === 'Index' && !constraintsOnly && fields.length > 0) {
      indexes.push({
        fields,
        isUnique: false,
        ...(name === undefined ? {} : { name }),
      });
    } else if (calleeName === 'UniqueConstraint' && fields.length > 0) {
      indexes.push({
        fields,
        isUnique: true,
        ...(name === undefined ? {} : { name }),
      });
    } else if (
      calleeName === 'CheckConstraint' ||
      calleeName === 'UniqueConstraint' ||
      calleeName === 'Index'
    ) {
      warnings.push(
        `${location}: ${calleeName}(...) could not be converted (only field-based indexes and unique constraints are supported).`
      );
    }
  }
  return indexes;
}

// ---------------------------------------------------------------------------
// Fields
// ---------------------------------------------------------------------------

interface ParsedField {
  field?: IrField;
  relation?: IrRelation;
  index?: IrIndex;
}

function boolKwarg(call: PyCall, key: string): boolean {
  const value: PyValue | undefined = call.kwargs[key];
  return value !== undefined && value.kind === 'bool' && value.value;
}

function stringKwarg(call: PyCall, key: string): string | undefined {
  const value: PyValue | undefined = call.kwargs[key];
  return value !== undefined && value.kind === 'string'
    ? value.value
    : undefined;
}

function numberKwarg(call: PyCall, key: string): number | undefined {
  const value: PyValue | undefined = call.kwargs[key];
  return value !== undefined && value.kind === 'number'
    ? value.value
    : undefined;
}

function parseFieldCall(
  fieldName: string,
  call: PyCall,
  context: FieldContext
): ParsedField {
  const calleeName: string = lastSegment(call.callee);
  if (RELATION_FIELDS.has(calleeName)) {
    return parseRelationField(fieldName, calleeName, call, context);
  }
  return parseScalarField(fieldName, calleeName, call, context);
}

function parseScalarField(
  fieldName: string,
  calleeName: string,
  call: PyCall,
  context: FieldContext
): ParsedField {
  const location: string = `${context.modelName}.${fieldName}`;
  let spec: ScalarSpec | undefined = SCALAR_FIELDS[calleeName];
  if (spec === undefined) {
    context.warnings.push(
      `${location}: unknown field type "${calleeName}"; it was converted as a plain string column. ` +
        `Review the generated type.`
    );
    spec = { type: 'string' };
  }

  const isPrimaryKey: boolean = boolKwarg(call, 'primary_key');
  const field: IrField = {
    name: fieldName,
    columnName: stringKwarg(call, 'db_column') ?? fieldName,
    type: spec.type,
    isPrimaryKey,
    isUnique: boolKwarg(call, 'unique') && !isPrimaryKey,
    isNullable:
      !isPrimaryKey &&
      (boolKwarg(call, 'null') || calleeName === 'NullBooleanField'),
    isAutoUpdated: boolKwarg(call, 'auto_now'),
  };

  const maxLength: number | undefined =
    numberKwarg(call, 'max_length') ?? spec.defaultMaxLength;
  if (
    maxLength !== undefined &&
    (spec.type === 'string' || spec.type === 'text')
  ) {
    field.maxLength = maxLength;
  }
  if (spec.type === 'decimal') {
    const maxDigits: number | undefined = numberKwarg(call, 'max_digits');
    const decimalPlaces: number | undefined = numberKwarg(
      call,
      'decimal_places'
    );
    if (maxDigits !== undefined) {
      field.maxDigits = maxDigits;
    }
    if (decimalPlaces !== undefined) {
      field.decimalPlaces = decimalPlaces;
    }
  }

  const enumInfo: EnumInfo | undefined = resolveChoices(
    fieldName,
    call,
    context
  );
  if (enumInfo !== undefined && enumInfo.kind === 'string') {
    field.enumName = enumInfo.enumName;
    field.type = 'string';
  }

  const defaultValue: IrDefault | undefined = resolveDefault(
    location,
    call,
    spec,
    enumInfo,
    context
  );
  if (defaultValue !== undefined) {
    field.default = defaultValue;
  } else if (spec.isAutoIncrement === true) {
    field.default = { kind: 'autoIncrement' };
  }
  if (boolKwarg(call, 'auto_now_add')) {
    field.default = { kind: 'now' };
  }

  const parsed: ParsedField = { field };
  if (boolKwarg(call, 'db_index') && !isPrimaryKey && !field.isUnique) {
    parsed.index = { fields: [fieldName], isUnique: false };
  }
  return parsed;
}

function resolveChoices(
  fieldName: string,
  call: PyCall,
  context: FieldContext
): EnumInfo | undefined {
  const choices: PyValue | undefined = call.kwargs['choices'];
  if (choices === undefined) {
    return undefined;
  }
  if (choices.kind === 'name') {
    const className: string = choices.value.split('.')[0] ?? '';
    return context.enumByClass.get(className);
  }
  if (choices.kind === 'list') {
    const usedNames: Set<string> = new Set();
    const values: IrEnumValue[] = [];
    for (const item of choices.items) {
      if (item.kind !== 'list') {
        continue;
      }
      const first: PyValue | undefined = item.items[0];
      const second: PyValue | undefined = item.items[1];
      if (first !== undefined && first.kind === 'string') {
        const label: string | undefined =
          second !== undefined && second.kind === 'string'
            ? second.value
            : undefined;
        values.push({
          name: memberNameFromValue(first.value, usedNames),
          dbValue: first.value,
          ...(label === undefined ? {} : { label }),
        });
      }
    }
    if (values.length === 0) {
      return undefined;
    }
    const enumName: string = `${context.modelName}${toPascalCase(fieldName)}`;
    context.newEnums.push({ name: enumName, values });
    return { kind: 'string', enumName, values };
  }
  return undefined;
}

function resolveDefault(
  location: string,
  call: PyCall,
  spec: ScalarSpec,
  enumInfo: EnumInfo | undefined,
  context: FieldContext
): IrDefault | undefined {
  const value: PyValue | undefined = call.kwargs['default'];
  if (value === undefined || value.kind === 'none') {
    return undefined;
  }
  switch (value.kind) {
    case 'bool':
    case 'number':
      return { kind: 'literal', value: value.value };
    case 'string': {
      if (enumInfo !== undefined && enumInfo.kind === 'string') {
        const member: IrEnumValue | undefined = enumInfo.values.find(
          (enumValue: IrEnumValue) => enumValue.dbValue === value.value
        );
        if (member !== undefined) {
          return { kind: 'enumValue', value: member.name };
        }
      }
      return { kind: 'literal', value: value.value };
    }
    case 'name': {
      const dotted: string = value.value;
      if (
        dotted === 'uuid.uuid4' ||
        dotted === 'uuid4' ||
        dotted === 'uuid.uuid1'
      ) {
        return { kind: 'uuid' };
      }
      if (NOW_CALLABLES.has(dotted) || dotted.endsWith('timezone.now')) {
        return { kind: 'now' };
      }
      if (dotted === 'list' && spec.type === 'json') {
        return { kind: 'literal', value: '[]' };
      }
      if (dotted === 'dict' && spec.type === 'json') {
        return { kind: 'literal', value: '{}' };
      }
      const segments: string[] = dotted.split('.');
      const memberName: string | undefined = segments[1];
      const enumClass: EnumInfo | undefined = context.enumByClass.get(
        segments[0] ?? ''
      );
      if (
        enumClass !== undefined &&
        enumClass.kind === 'string' &&
        memberName !== undefined
      ) {
        return { kind: 'enumValue', value: memberName };
      }
      if (enumClass !== undefined && enumClass.kind === 'integer') {
        return undefined;
      }
      context.warnings.push(
        `${location}: default=${dotted} is not representable and was dropped.`
      );
      return undefined;
    }
    case 'call': {
      const arg: PyValue | undefined = value.args[0];
      if (lastSegment(value.callee) === 'Decimal' && arg !== undefined) {
        if (arg.kind === 'string' && !Number.isNaN(Number(arg.value))) {
          return { kind: 'literal', value: Number(arg.value) };
        }
        if (arg.kind === 'number') {
          return { kind: 'literal', value: arg.value };
        }
      }
      context.warnings.push(
        `${location}: default=${value.callee}(...) is not representable and was dropped.`
      );
      return undefined;
    }
    default:
      context.warnings.push(
        `${location}: a computed default value was dropped (only literals and now/uuid are supported).`
      );
      return undefined;
  }
}

function parseRelationField(
  fieldName: string,
  calleeName: string,
  call: PyCall,
  context: FieldContext
): ParsedField {
  const location: string = `${context.modelName}.${fieldName}`;
  const target: string | undefined = resolveRelationTarget(
    location,
    call,
    context
  );
  if (target === undefined) {
    context.warnings.push(
      `${location}: could not determine the target model of ${calleeName}(...); the field was skipped.`
    );
    return {};
  }

  if (
    calleeName === 'ManyToManyField' &&
    call.kwargs['through'] !== undefined
  ) {
    context.warnings.push(
      `${location}: ManyToManyField with through= was skipped; the explicit through model carries the relations.`
    );
    return {};
  }

  const relatedNameValue: string | undefined = stringKwarg(
    call,
    'related_name'
  );
  const relatedName: string | undefined =
    relatedNameValue === undefined || relatedNameValue.endsWith('+')
      ? undefined
      : relatedNameValue;
  const toField: string | undefined = stringKwarg(call, 'to_field');

  let kind: IrRelation['kind'] = 'foreignKey';
  if (calleeName === 'OneToOneField') {
    kind = 'oneToOne';
  } else if (calleeName === 'ManyToManyField') {
    kind = 'manyToMany';
  } else if (boolKwarg(call, 'unique')) {
    kind = 'oneToOne';
  }

  const relation: IrRelation = {
    name: fieldName,
    kind,
    targetModel: target,
    columnName: stringKwarg(call, 'db_column') ?? `${fieldName}_id`,
    isNullable: boolKwarg(call, 'null'),
    onDelete: resolveOnDelete(location, call, context),
    ...(relatedName === undefined ? {} : { relatedName }),
    ...(toField === undefined ? {} : { toField }),
    ...(boolKwarg(call, 'primary_key') ? { isPrimaryKey: true } : {}),
  };
  return { relation };
}

function resolveRelationTarget(
  location: string,
  call: PyCall,
  context: FieldContext
): string | undefined {
  const targetValue: PyValue | undefined = call.args[0] ?? call.kwargs['to'];
  if (targetValue === undefined) {
    return undefined;
  }
  switch (targetValue.kind) {
    case 'string':
      return targetValue.value === 'self'
        ? context.modelName
        : lastSegment(targetValue.value);
    case 'name':
      if (lastSegment(targetValue.value) === 'AUTH_USER_MODEL') {
        context.warnings.push(
          `${location}: settings.AUTH_USER_MODEL was assumed to be a model named "User".`
        );
        return 'User';
      }
      return lastSegment(targetValue.value);
    case 'call':
      if (lastSegment(targetValue.callee) === 'get_user_model') {
        context.warnings.push(
          `${location}: get_user_model() was assumed to return a model named "User".`
        );
        return 'User';
      }
      return undefined;
    default:
      return undefined;
  }
}

function resolveOnDelete(
  location: string,
  call: PyCall,
  context: FieldContext
): IrOnDelete {
  const value: PyValue | undefined = call.kwargs['on_delete'] ?? call.args[1];
  if (value === undefined) {
    return 'cascade';
  }
  const rawName: string =
    value.kind === 'name'
      ? lastSegment(value.value)
      : value.kind === 'call'
        ? lastSegment(value.callee)
        : '';
  const mapped: IrOnDelete | undefined = ON_DELETE_MAP[rawName];
  if (mapped !== undefined) {
    return mapped;
  }
  context.warnings.push(
    `${location}: on_delete=${rawName || 'unknown'} has no equivalent and was converted to NoAction.`
  );
  return 'noAction';
}

// ---------------------------------------------------------------------------
// Schema assembly (inheritance, primary keys, stubs)
// ---------------------------------------------------------------------------

interface Members {
  fields: IrField[];
  relations: IrRelation[];
  indexes: IrIndex[];
}

const KNOWN_EXTERNAL_BASES: ReadonlySet<string> = new Set([
  'Model',
  'AbstractUser',
  'AbstractBaseUser',
  'PermissionsMixin',
  'Manager',
]);

function buildSchema(
  parsedFiles: ParsedFile[],
  options: DjangoParseOptions
): IrSchema {
  const warnings: string[] = parsedFiles.flatMap(
    (file: ParsedFile) => file.warnings
  );
  const enumsByName: Map<string, IrEnum> = new Map();
  for (const file of parsedFiles) {
    for (const enumDefinition of file.enums) {
      enumsByName.set(enumDefinition.name, enumDefinition);
    }
  }

  const rawByName: Map<string, RawModel> = new Map();
  for (const file of parsedFiles) {
    for (const rawModel of file.models) {
      if (rawByName.has(rawModel.name)) {
        warnings.push(
          `Duplicate model name "${rawModel.name}" (${rawModel.filePath}); only the first definition was converted.`
        );
        continue;
      }
      rawByName.set(rawModel.name, rawModel);
    }
  }

  const models: IrModel[] = [];
  for (const rawModel of rawByName.values()) {
    if (rawModel.isAbstract || !isModelClass(rawModel, rawByName, new Set())) {
      continue;
    }
    if (rawModel.isProxy) {
      warnings.push(
        `${rawModel.name}: proxy models have no table and were skipped.`
      );
      continue;
    }
    const members: Members = collectMembers(
      rawModel,
      rawByName,
      warnings,
      new Set()
    );
    models.push(finalizeModel(rawModel, members, options));
  }

  addStubModels(models, rawByName, warnings, options);
  return { models, enums: [...enumsByName.values()], warnings };
}

function collectMembers(
  rawModel: RawModel,
  rawByName: Map<string, RawModel>,
  warnings: string[],
  visiting: Set<string>
): Members {
  const inherited: Members = { fields: [], relations: [], indexes: [] };
  visiting.add(rawModel.name);

  for (const baseName of rawModel.bases) {
    const shortName: string = lastSegment(baseName);
    const parent: RawModel | undefined = rawByName.get(shortName);
    if (parent === undefined) {
      if (!KNOWN_EXTERNAL_BASES.has(shortName)) {
        warnings.push(
          `${rawModel.name}: base class "${baseName}" was not found in the input files, so any fields it defines ` +
            `are missing. Add the file that defines it to --input.`
        );
      } else if (shortName !== 'Model') {
        warnings.push(
          `${rawModel.name}: fields inherited from django.contrib.auth "${shortName}" are not included; ` +
            `add them to the output manually.`
        );
      }
      continue;
    }
    if (visiting.has(parent.name)) {
      warnings.push(
        `${rawModel.name}: circular inheritance through "${parent.name}" was ignored.`
      );
      continue;
    }
    if (parent.isAbstract) {
      const parentMembers: Members = collectMembers(
        parent,
        rawByName,
        warnings,
        new Set(visiting)
      );
      inherited.fields.push(...parentMembers.fields);
      inherited.relations.push(...parentMembers.relations);
      inherited.indexes.push(...parentMembers.indexes);
    } else {
      const pointerName: string = `${parent.name.toLowerCase()}_ptr`;
      inherited.relations.push({
        name: pointerName,
        kind: 'oneToOne',
        targetModel: parent.name,
        columnName: `${pointerName}_id`,
        isNullable: false,
        onDelete: 'cascade',
        isPrimaryKey: true,
      });
      warnings.push(
        `${rawModel.name}: multi-table inheritance from "${parent.name}" was converted to a one-to-one primary key ` +
          `named "${pointerName}".`
      );
    }
  }

  const ownFieldNames: Set<string> = new Set(
    rawModel.fields.map((field: IrField) => field.name)
  );
  const ownRelationNames: Set<string> = new Set(
    rawModel.relations.map((relation: IrRelation) => relation.name)
  );
  return {
    fields: [
      ...inherited.fields.filter(
        (field: IrField) => !ownFieldNames.has(field.name)
      ),
      ...rawModel.fields,
    ],
    relations: [
      ...inherited.relations.filter(
        (relation: IrRelation) => !ownRelationNames.has(relation.name)
      ),
      ...rawModel.relations,
    ],
    indexes: [...inherited.indexes, ...rawModel.indexes],
  };
}

function autoPrimaryKey(options: DjangoParseOptions): IrField {
  return {
    name: 'id',
    columnName: 'id',
    type: options.autoField,
    isPrimaryKey: true,
    isUnique: false,
    isNullable: false,
    isAutoUpdated: false,
    default: { kind: 'autoIncrement' },
  };
}

function finalizeModel(
  rawModel: RawModel,
  members: Members,
  options: DjangoParseOptions
): IrModel {
  const hasPrimaryKey: boolean =
    members.fields.some((field: IrField) => field.isPrimaryKey) ||
    members.relations.some(
      (relation: IrRelation) => relation.isPrimaryKey === true
    );
  const fields: IrField[] = hasPrimaryKey
    ? members.fields
    : [autoPrimaryKey(options), ...members.fields];
  return {
    name: rawModel.name,
    tableName:
      rawModel.tableName ??
      `${rawModel.appLabel}_${rawModel.name.toLowerCase()}`,
    appLabel: rawModel.appLabel,
    fields,
    relations: members.relations,
    indexes: members.indexes,
  };
}

function addStubModels(
  models: IrModel[],
  rawByName: Map<string, RawModel>,
  warnings: string[],
  options: DjangoParseOptions
): void {
  const known: Set<string> = new Set(
    models.map((model: IrModel) => model.name)
  );
  const stubs: IrModel[] = [];
  for (const model of models) {
    for (const relation of model.relations) {
      const target: string = relation.targetModel;
      if (known.has(target) || rawByName.has(target)) {
        continue;
      }
      known.add(target);
      const isUserModel: boolean = target === 'User';
      stubs.push({
        name: target,
        tableName: isUserModel
          ? 'auth_user'
          : `${model.appLabel}_${target.toLowerCase()}`,
        appLabel: isUserModel ? 'auth' : model.appLabel,
        fields: [autoPrimaryKey(options)],
        relations: [],
        indexes: [],
      });
      warnings.push(
        `${model.name}.${relation.name} references model "${target}", which was not found in the input. ` +
          `A stub model with an auto-increment id was generated; replace it with the real definition.`
      );
    }
  }
  models.push(...stubs);
}
