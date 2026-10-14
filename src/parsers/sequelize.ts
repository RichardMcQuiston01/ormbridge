import type Parser from 'web-tree-sitter';
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
import { toPascalCase, toSnakeCase } from '../naming.js';
import { describeThrown, err, ok, type Result } from '../result.js';
import {
  linkAssociations,
  type LinkResult,
  type ManyToManyLink,
  type Prepared,
  type ReverseSide,
} from './sequelizeAssociations.js';
import {
  collectFile,
  describeFile,
  mergeNamedIndexes,
  readIndexes,
  readModelOptions,
} from './sequelizeCollect.js';
import { pluralize, singularize, underscore } from './sequelizeInflection.js';
import type {
  AttributeLink,
  FileInfo,
  Located,
  ModelOptions,
  Project,
  RawAttribute,
  RawIndex,
  RawIndexField,
  RawModel,
} from './sequelizeModel.js';
import { resolveDataType, type ResolvedDataType } from './sequelizeTypes.js';
import { getTypeScriptParser, type TsValue } from './typescriptSyntax.js';

export interface SequelizeSourceFile {
  path: string;
  text: string;
}

export interface SequelizeParseOptions {
  /** App label stored on each model (Sequelize itself has no equivalent). */
  appLabel: string;
}

// ---------------------------------------------------------------------------
// Static tables
// ---------------------------------------------------------------------------

/** A file that mentions neither Sequelize nor its data types nor @Table cannot define a model. */
const SEQUELIZE_HINT: RegExp = /sequelize|DataTypes?\b|@Table\b/i;

const ON_ACTION_MAP: Readonly<Record<string, IrOnDelete>> = {
  CASCADE: 'cascade',
  'SET NULL': 'setNull',
  RESTRICT: 'restrict',
  'NO ACTION': 'noAction',
  'SET DEFAULT': 'setDefault',
};

/** Index access methods the IR spells the way Prisma does. */
const INDEX_METHODS: Readonly<Record<string, string>> = {
  btree: 'BTree',
  hash: 'Hash',
  gin: 'Gin',
  gist: 'Gist',
  spgist: 'SpGist',
  brin: 'BRIN',
};

/** TypeScript property types that sequelize-typescript turns into a column type. */
const TS_TYPES: Readonly<Record<string, ResolvedDataType>> = {
  string: { type: 'string', maxLength: 255 },
  number: { type: 'int' },
  bigint: { type: 'bigInt' },
  boolean: { type: 'boolean' },
  Date: { type: 'dateTime' },
  Buffer: { type: 'bytes' },
};

const NOW_SQL: RegExp =
  /^\(?(now\(\)|current_timestamp(\(\d*\))?|localtimestamp(\(\d*\))?|transaction_timestamp\(\)|sysdatetime\(\)|getdate\(\)|datetime\('now'\)|strftime\(.*'now'.*\))\)?$/i;
const UUID_SQL: RegExp =
  /^(uuid_generate_v[14]\(\)|gen_random_uuid\(\)|uuid\(\)|newid\(\))$/i;
const QUOTED_SQL: RegExp = /^'((?:[^']|'')*)'(::[\w\s]+)?$/;

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Parses Sequelize 6 models into the shared IR using tree-sitter. The source is only read: nothing is
 * imported or run, so models built in loops or from run-time values are not seen.
 */
export async function parseSequelize(
  sources: SequelizeSourceFile[],
  options: SequelizeParseOptions
): Promise<Result<IrSchema>> {
  const parserResult: Result<Parser> = await getTypeScriptParser();
  if (!parserResult.ok) {
    return parserResult;
  }
  const parser: Parser = parserResult.value;
  const project: Project = {
    files: [],
    models: [],
    associations: [],
    sharedConsts: new Map(),
    defaults: {},
    warnings: [],
  };

  // The trees are kept alive until the schema is built: the syntax nodes below point into them.
  const trees: Parser.Tree[] = [];
  try {
    for (const source of sources) {
      if (!SEQUELIZE_HINT.test(source.text)) {
        continue;
      }
      const tree: Parser.Tree = parser.parse(source.text);
      trees.push(tree);
      const file: FileInfo = describeFile(source.path, tree.rootNode);
      project.files.push(file);
      if (tree.rootNode.hasError) {
        project.warnings.push(
          `${file.label}: the file contains syntax errors; some models or attributes may be missing from the output.`
        );
      }
      for (const [name, node] of file.consts) {
        const shared: Located[] = project.sharedConsts.get(name) ?? [];
        shared.push({ file, node });
        project.sharedConsts.set(name, shared);
      }
    }
    for (const file of project.files) {
      collectFile(file, project);
    }
    if (project.models.length === 0) {
      const checkedPaths: string = sources
        .map((source: SequelizeSourceFile) => source.path)
        .join(', ');
      return err(
        'NO_MODELS_FOUND',
        `No Sequelize models were found in: ${checkedPaths}. A model is \`sequelize.define('Name', { ... })\`, ` +
          `\`class Name extends Model\` with \`Name.init({ ... }, { sequelize })\`, or a sequelize-typescript class with @Table.`
      );
    }
    return ok(buildSchema(project, options));
  } catch (thrown) {
    return err(
      'PARSE_FAILED',
      `Failed to read the Sequelize models: ${describeThrown(thrown)}`
    );
  } finally {
    for (const tree of trees) {
      tree.delete();
    }
  }
}

// ---------------------------------------------------------------------------
// Naming
// ---------------------------------------------------------------------------

/** The IR model name: the Sequelize model name, in PascalCase when it is written as `user` or `blog_post`. */
function irModelName(modelName: string): string {
  return /^[A-Z][A-Za-z0-9]*$/.test(modelName)
    ? modelName
    : toPascalCase(modelName) || modelName;
}

function tableNameOf(modelName: string, options: ModelOptions): string {
  if (options.tableName !== undefined) {
    return options.tableName;
  }
  if (options.freezeTableName) {
    return modelName;
  }
  const plural: string = pluralize(modelName);
  return options.underscored ? underscore(plural) : plural;
}

function columnName(options: ModelOptions, attribute: RawAttribute): string {
  return (
    attribute.field ??
    (options.underscored ? underscore(attribute.name) : attribute.name)
  );
}

function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

function describeNode(value: TsValue): string {
  const text: string =
    value.kind === 'name'
      ? value.value
      : value.kind === 'other'
        ? value.text
        : value.kind;
  const collapsed: string = text.replace(/\s+/g, ' ');
  return collapsed.length > 60 ? `${collapsed.slice(0, 57)}...` : collapsed;
}

// ---------------------------------------------------------------------------
// Preparation: options, names, the attributes Sequelize adds itself
// ---------------------------------------------------------------------------

const DATE_TYPE: TsValue = { kind: 'name', value: 'DataTypes.DATE' };
const INTEGER_TYPE: TsValue = { kind: 'name', value: 'DataTypes.INTEGER' };

/** Adds the `id` and timestamp columns that `Model.init` adds when the model does not declare them. */
function addDefaultAttributes(model: RawModel, options: ModelOptions): void {
  const attributes: RawAttribute[] = model.attributes;
  if (!attributes.some((attribute: RawAttribute) => attribute.primaryKey)) {
    if (attributes.some((attribute: RawAttribute) => attribute.name === 'id')) {
      model.unsupported.push(
        'an "id" column that is not a primary key (Sequelize refuses such a model)'
      );
    } else {
      attributes.unshift({
        name: 'id',
        origin: 'id',
        type: INTEGER_TYPE,
        allowNull: false,
        primaryKey: true,
        autoIncrement: true,
      });
    }
  }
  if (options.timestamps) {
    const timestamps: [
      'createdAt' | 'updatedAt' | 'deletedAt',
      string | false,
      boolean,
    ][] = [
      ['createdAt', options.createdAt, false],
      ['updatedAt', options.updatedAt, false],
      ['deletedAt', options.paranoid ? options.deletedAt : false, true],
    ];
    for (const [kind, name, nullable] of timestamps) {
      if (name === false) {
        continue;
      }
      const existing: RawAttribute | undefined = attributes.find(
        (attribute: RawAttribute) => attribute.name === name
      );
      if (existing !== undefined) {
        existing.timestamp = kind;
      } else {
        attributes.push({
          name,
          origin: 'timestamp',
          type: DATE_TYPE,
          timestamp: kind,
          ...(nullable ? {} : { allowNull: false }),
        });
      }
    }
  }
  if (
    options.version !== undefined &&
    !attributes.some(
      (attribute: RawAttribute) => attribute.name === options.version
    )
  ) {
    attributes.push({
      name: options.version,
      origin: 'declared',
      type: INTEGER_TYPE,
      allowNull: false,
      defaultValue: { kind: 'number', value: 0 },
    });
  }
}

function prepareModels(project: Project): Prepared[] {
  const prepared: Prepared[] = [];
  const modelNames: Set<string> = new Set();
  const irNames: Set<string> = new Set();
  for (const model of project.models) {
    if (modelNames.has(model.modelName)) {
      project.warnings.push(
        `${model.location}: another model with the same name was already read; this one was skipped.`
      );
      continue;
    }
    const irName: string = irModelName(model.modelName);
    if (irNames.has(irName)) {
      project.warnings.push(
        `${model.location}: the name "${irName}" is already taken by another model; this one was skipped.`
      );
      continue;
    }
    modelNames.add(model.modelName);
    irNames.add(irName);
    const options: ModelOptions = readModelOptions(model, project);
    model.indexes = mergeNamedIndexes(readIndexes(model, project));
    addDefaultAttributes(model, options);
    prepared.push({
      raw: model,
      options,
      irName,
      tableName: tableNameOf(model.modelName, options),
    });
  }
  return prepared;
}

// ---------------------------------------------------------------------------
// Foreign keys declared with `references`
// ---------------------------------------------------------------------------

/** The model or table a `references.model` value names. */
function referencedName(value: TsValue | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  switch (value.kind) {
    case 'string':
      return value.value;
    case 'name':
      return value.value.split('.').pop();
    case 'call':
      // `User.getTableName()`
      return value.callee.split('.').slice(-2, -1)[0];
    case 'object': {
      const table: TsValue | undefined = value.properties['tableName'];
      return table !== undefined && table.kind === 'string'
        ? table.value
        : undefined;
    }
    default:
      return undefined;
  }
}

function findReferencedModel(
  name: string,
  prepared: Prepared[]
): Prepared | undefined {
  const lower: string = name.toLowerCase();
  return (
    prepared.find(
      (model: Prepared) => model.tableName.toLowerCase() === lower
    ) ??
    prepared.find((model: Prepared) => model.raw.modelName === name) ??
    prepared.find((model: Prepared) => model.raw.aliases.includes(name))
  );
}

/** Turns `references: { model, key }` on an attribute into a foreign key link. */
function resolveReferences(prepared: Prepared[], project: Project): void {
  for (const model of prepared) {
    for (const attribute of model.raw.attributes) {
      if (attribute.references === undefined || attribute.link !== undefined) {
        continue;
      }
      const name: string | undefined = referencedName(
        attribute.references.model
      );
      if (name === undefined) {
        project.warnings.push(
          `${model.raw.location}, field "${attribute.name}": the model in references could not be read statically, so no relation was created.`
        );
        continue;
      }
      const target: Prepared | undefined = findReferencedModel(name, prepared);
      const key: string | undefined = attribute.references.key;
      const keyAttribute: RawAttribute | undefined =
        target === undefined
          ? undefined
          : target.raw.attributes.find(
              (candidate: RawAttribute) =>
                candidate.name === key ||
                (key !== undefined &&
                  columnName(target.options, candidate) === key)
            );
      const link: AttributeLink = {
        target: target?.raw,
        targetName:
          target?.irName ?? irModelName(toPascalCase(singularize(name))),
        keyAttribute: keyAttribute?.name,
        ...(key === undefined || keyAttribute !== undefined
          ? {}
          : { keyColumn: key }),
        ...(attribute.onDelete === undefined
          ? {}
          : { onDelete: attribute.onDelete }),
        ...(attribute.onUpdate === undefined
          ? {}
          : { onUpdate: attribute.onUpdate }),
        constraint: true,
      };
      attribute.link = link;
    }
  }
}

// ---------------------------------------------------------------------------
// Types, defaults, enums
// ---------------------------------------------------------------------------

function enumMemberName(value: string): string {
  const snake: string = toSnakeCase(value).toUpperCase();
  if (snake === '') {
    return 'EMPTY';
  }
  return /^[0-9]/.test(snake) ? `V_${snake}` : snake;
}

function enumValuesOf(values: string[]): IrEnumValue[] {
  const used: Set<string> = new Set();
  return values.map((dbValue: string): IrEnumValue => {
    let name: string = enumMemberName(dbValue);
    while (used.has(name)) {
      name = `${name}_`;
    }
    used.add(name);
    return { name, dbValue };
  });
}

interface BuildContext {
  project: Project;
  options: SequelizeParseOptions;
  enums: IrEnum[];
  prepared: Prepared[];
  links: LinkResult;
}

function resolveAttributeType(
  model: Prepared,
  attribute: RawAttribute,
  project: Project
): ResolvedDataType {
  const label: string = `${model.raw.location}, field "${attribute.name}"`;
  if (attribute.type !== undefined) {
    const resolved: ResolvedDataType | undefined = resolveDataType(
      attribute.type
    );
    if (resolved === undefined) {
      project.warnings.push(
        `${label}: the data type (${describeNode(attribute.type)}) is not a Sequelize data type that could be read statically; the field was read as unsupported.`
      );
      return { type: 'unsupported', unsupportedType: 'unknown' };
    }
    if (
      resolved.enumValues !== undefined &&
      resolved.enumValues.length === 0 &&
      attribute.enumValues !== undefined
    ) {
      return { ...resolved, enumValues: attribute.enumValues };
    }
    return resolved;
  }
  if (attribute.tsType !== undefined) {
    const inferred: ResolvedDataType | undefined = TS_TYPES[attribute.tsType];
    if (inferred !== undefined) {
      return inferred;
    }
    project.warnings.push(
      `${label}: sequelize-typescript cannot infer a column type from the TypeScript type "${attribute.tsType}"; name it in @Column(DataType.X). The field was read as unsupported.`
    );
    return { type: 'unsupported', unsupportedType: attribute.tsType };
  }
  project.warnings.push(
    `${label}: the attribute has no data type; the field was read as unsupported.`
  );
  return { type: 'unsupported', unsupportedType: 'unknown' };
}

function jsonText(value: TsValue): string | undefined {
  switch (value.kind) {
    case 'string':
      return JSON.stringify(value.value);
    case 'number':
      return String(value.value);
    case 'bool':
      return value.value ? 'true' : 'false';
    case 'null':
      return 'null';
    case 'array': {
      const items: (string | undefined)[] = value.items.map(jsonText);
      return items.every((item: string | undefined) => item !== undefined)
        ? `[${items.join(',')}]`
        : undefined;
    }
    case 'object': {
      const parts: string[] = [];
      for (const [key, item] of Object.entries(value.properties)) {
        const text: string | undefined = jsonText(item);
        if (text === undefined) {
          return undefined;
        }
        parts.push(`${JSON.stringify(key)}:${text}`);
      }
      return `{${parts.join(',')}}`;
    }
    default:
      return undefined;
  }
}

function convertSqlDefault(
  sql: string,
  field: IrField,
  enumeration: IrEnum | undefined
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
    const member: IrEnumValue | undefined = enumeration?.values.find(
      (candidate: IrEnumValue) => candidate.dbValue === text
    );
    return member === undefined
      ? { kind: 'literal', value: text }
      : { kind: 'enumValue', value: member.name };
  }
  return { kind: 'dbExpression', expression: trimmed };
}

/** `Sequelize.fn('now')` as SQL text: `now()`. Arguments must be literals. */
function callText(callee: string, args: TsValue[]): string | undefined {
  const rendered: string[] = [];
  for (const arg of args.slice(1)) {
    if (arg.kind === 'string') {
      rendered.push(`'${arg.value.replace(/'/g, "''")}'`);
    } else if (arg.kind === 'number') {
      rendered.push(String(arg.value));
    } else {
      return undefined;
    }
  }
  const first: TsValue | undefined = args[0];
  return first !== undefined && first.kind === 'string' && callee !== ''
    ? `${first.value}(${rendered.join(', ')})`
    : undefined;
}

function convertDefault(
  value: TsValue,
  field: IrField,
  enumeration: IrEnum | undefined,
  label: string,
  project: Project
): IrDefault | undefined {
  switch (value.kind) {
    case 'null':
      return undefined;
    case 'bool':
    case 'number':
      return { kind: 'literal', value: value.value };
    case 'string': {
      const member: IrEnumValue | undefined = enumeration?.values.find(
        (candidate: IrEnumValue) => candidate.dbValue === value.value
      );
      if (member !== undefined) {
        return { kind: 'enumValue', value: member.name };
      }
      if (
        /^-?\d+(\.\d+)?$/.test(value.value) &&
        (field.type === 'decimal' ||
          field.type === 'int' ||
          field.type === 'bigInt' ||
          field.type === 'float')
      ) {
        return { kind: 'literal', value: Number(value.value) };
      }
      return { kind: 'literal', value: value.value };
    }
    case 'name':
    case 'call': {
      const callee: string = value.kind === 'name' ? value.value : value.callee;
      if (/(^|\.)NOW$/.test(callee)) {
        return { kind: 'now' };
      }
      const version: RegExpExecArray | null = /(^|\.)UUIDV([14])$/.exec(callee);
      if (version !== null) {
        // Version 4 is what an unversioned IR default means.
        return version[2] === '4'
          ? { kind: 'uuid' }
          : { kind: 'uuid', version: Number(version[2]) };
      }
      if (value.kind === 'call' && /(^|\.)literal$/.test(callee)) {
        const sql: TsValue | undefined = value.args[0];
        if (sql !== undefined && sql.kind === 'string') {
          return convertSqlDefault(sql.value, field, enumeration);
        }
      }
      if (value.kind === 'call' && /(^|\.)fn$/.test(callee)) {
        const text: string | undefined = callText(callee, value.args);
        if (text !== undefined) {
          return convertSqlDefault(text, field, enumeration);
        }
      }
      break;
    }
    case 'object':
    case 'array': {
      const text: string | undefined = jsonText(value);
      if (
        text !== undefined &&
        field.type === 'json' &&
        field.arrayDepth === undefined
      ) {
        return { kind: 'literal', value: text };
      }
      break;
    }
    default:
      break;
  }
  project.warnings.push(
    `${label}: the default value (${describeNode(value)}) is computed at run time or cannot be read statically and was dropped.`
  );
  return undefined;
}

// ---------------------------------------------------------------------------
// Fields
// ---------------------------------------------------------------------------

function registerEnum(
  context: BuildContext,
  model: Prepared,
  attribute: RawAttribute,
  values: string[]
): IrEnum {
  let name: string = `${model.irName}${toPascalCase(attribute.name)}`;
  while (context.enums.some((item: IrEnum) => item.name === name)) {
    name = `${name}Enum`;
  }
  const created: IrEnum = {
    name,
    values: enumValuesOf(values),
    ...(model.options.schema === undefined
      ? {}
      : { schema: model.options.schema }),
  };
  context.enums.push(created);
  return created;
}

function buildField(
  context: BuildContext,
  model: Prepared,
  attribute: RawAttribute
): IrField | undefined {
  const label: string = `${model.raw.location}, field "${attribute.name}"`;
  const resolved: ResolvedDataType = resolveAttributeType(
    model,
    attribute,
    context.project
  );
  if (resolved.isVirtual === true) {
    context.project.warnings.push(
      `${label}: DataTypes.VIRTUAL has no database column, so the field was skipped.`
    );
    return undefined;
  }
  if (resolved.note !== undefined) {
    context.project.warnings.push(`${label}: ${resolved.note}.`);
  }
  const isPrimaryKey: boolean = attribute.primaryKey === true;
  if (attribute.tsNullable === true && attribute.allowNull === false) {
    context.project.warnings.push(
      `${label}: the TypeScript type allows null (or the property is optional) but the column is NOT NULL (allowNull: false); the column was read as NOT NULL.`
    );
  }
  const field: IrField = {
    name: attribute.name,
    columnName: columnName(model.options, attribute),
    type: resolved.type,
    isPrimaryKey,
    isUnique: false,
    isNullable: !isPrimaryKey && attribute.allowNull !== false,
    isAutoUpdated: attribute.timestamp === 'updatedAt',
    ...(resolved.maxLength === undefined
      ? {}
      : { maxLength: resolved.maxLength }),
    ...(resolved.maxDigits === undefined
      ? {}
      : { maxDigits: resolved.maxDigits }),
    ...(resolved.decimalPlaces === undefined
      ? {}
      : { decimalPlaces: resolved.decimalPlaces }),
    ...(resolved.arrayDepth === undefined
      ? {}
      : { arrayDepth: resolved.arrayDepth }),
    ...(resolved.rangeOf === undefined ? {} : { rangeOf: resolved.rangeOf }),
    ...(resolved.unsupportedType === undefined
      ? {}
      : { unsupportedType: resolved.unsupportedType }),
  };
  let enumeration: IrEnum | undefined;
  if (resolved.enumValues !== undefined) {
    if (resolved.enumValues.length === 0) {
      context.project.warnings.push(
        `${label}: an ENUM column without values was read as a plain string.`
      );
      field.maxLength = 255;
    } else {
      enumeration = registerEnum(
        context,
        model,
        attribute,
        resolved.enumValues
      );
      field.enumName = enumeration.name;
    }
  }
  if (attribute.autoIncrement === true) {
    field.default = { kind: 'autoIncrement' };
  } else if (attribute.defaultValue !== undefined) {
    const converted: IrDefault | undefined = convertDefault(
      attribute.defaultValue,
      field,
      enumeration,
      label,
      context.project
    );
    if (converted !== undefined) {
      field.default = converted;
    }
  }
  return field;
}

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

function mapAction(
  value: string | undefined,
  label: string,
  what: string,
  project: Project
): IrOnDelete | undefined {
  if (value === undefined) {
    return undefined;
  }
  const mapped: IrOnDelete | undefined = ON_ACTION_MAP[value.toUpperCase()];
  if (mapped === undefined) {
    project.warnings.push(
      `${label}: ${what} "${value}" has no equivalent and was read as NO ACTION.`
    );
    return 'noAction';
  }
  return mapped;
}

/** The accessor name for a foreign key without a `belongsTo`: `authorId` becomes `author`. */
function derivedRelationName(
  attribute: RawAttribute,
  taken: Set<string>
): string {
  const stripped: string = lowerFirst(
    attribute.name.replace(/(_id|Id|ID)$/, '')
  );
  return stripped === '' || stripped === attribute.name || taken.has(stripped)
    ? attribute.name
    : stripped;
}

function primaryKeyAttributes(attributes: RawAttribute[]): RawAttribute[] {
  return attributes.filter(
    (attribute: RawAttribute) => attribute.primaryKey === true
  );
}

function indexMethod(
  using: string | undefined,
  label: string,
  project: Project
): string | undefined {
  if (using === undefined) {
    return undefined;
  }
  const method: string | undefined = INDEX_METHODS[using.toLowerCase()];
  if (method === undefined) {
    project.warnings.push(
      `${label}: the index method "${using}" has no equivalent and was dropped.`
    );
  }
  return method;
}

function buildModel(context: BuildContext, model: Prepared): IrModel {
  const { project, links } = context;
  const label: string = model.raw.location;
  const attributes: RawAttribute[] = model.raw.attributes;

  // Shared `unique: 'name'` values make a composite unique constraint. Sequelize creates the tables with
  // the model's uniqueKeys option when there is one, and then ignores the names given on attributes.
  const uniqueGroups: Map<string, RawAttribute[]> = new Map();
  const ignoredUniqueNames: string[] = [];
  for (const attribute of attributes) {
    const name: string | undefined = attribute.unique?.name;
    if (name === undefined) {
      continue;
    }
    if (model.raw.optionEntries.has('uniqueKeys')) {
      ignoredUniqueNames.push(name);
      delete attribute.unique;
    } else {
      uniqueGroups.set(name, [...(uniqueGroups.get(name) ?? []), attribute]);
    }
  }
  if (ignoredUniqueNames.length > 0) {
    project.warnings.push(
      `${label}: the uniqueKeys option replaces the unique constraints named on attributes (${[...new Set(ignoredUniqueNames)].join(', ')}), so Sequelize does not create them; they were ignored.`
    );
  }
  const isGrouped = (attribute: RawAttribute): boolean => {
    const name: string | undefined = attribute.unique?.name;
    return name !== undefined && (uniqueGroups.get(name)?.length ?? 0) > 1;
  };

  // A single-field unique index without a name is the same as `unique: true`.
  const uniqueByIndex: Set<string> = new Set();
  const modelIndexes: RawIndex[] = [];
  for (const index of model.raw.indexes) {
    const only: RawIndexField | undefined = index.fields[0];
    if (
      index.unique &&
      index.name === undefined &&
      index.fields.length === 1 &&
      only !== undefined &&
      !index.isPartial &&
      !index.hasExpression &&
      index.type === undefined &&
      index.using === undefined
    ) {
      uniqueByIndex.add(only.name);
    } else {
      modelIndexes.push(index);
    }
  }
  const isUniqueAttribute = (attribute: RawAttribute): boolean =>
    (attribute.unique !== undefined && !isGrouped(attribute)) ||
    uniqueByIndex.has(attribute.name) ||
    uniqueByIndex.has(columnName(model.options, attribute));

  const fields: IrField[] = [];
  const relations: IrRelation[] = [];
  /** Attribute name and column name -> the name the IR uses (a relation for foreign keys). */
  const irNames: Map<string, string> = new Map();
  const takenNames: Set<string> = new Set();
  const foreignKeys: RawAttribute[] = [];
  for (const attribute of attributes) {
    if (attribute.link?.constraint === true) {
      foreignKeys.push(attribute);
    } else {
      takenNames.add(attribute.name);
    }
  }

  for (const attribute of attributes) {
    if (attribute.link?.constraint === true) {
      continue;
    }
    const field: IrField | undefined = buildField(context, model, attribute);
    if (field === undefined) {
      continue;
    }
    if (isUniqueAttribute(attribute) && !field.isPrimaryKey) {
      field.isUnique = true;
      if (attribute.unique?.name !== undefined) {
        field.uniqueName = attribute.unique.name;
      }
    }
    fields.push(field);
    irNames.set(attribute.name, field.name);
    irNames.set(field.columnName, field.name);
  }

  const pkAttributes: RawAttribute[] = primaryKeyAttributes(attributes);
  for (const attribute of foreignKeys) {
    const link: AttributeLink | undefined = attribute.link;
    if (link === undefined) {
      continue;
    }
    const alias: string | undefined = links.aliases.get(attribute);
    const reverse: ReverseSide | undefined = links.reverses.get(attribute);
    let name: string = alias ?? derivedRelationName(attribute, takenNames);
    if (takenNames.has(name)) {
      name = attribute.name;
    }
    takenNames.add(name);
    const isPrimary: boolean =
      pkAttributes.length === 1 && pkAttributes[0] === attribute;
    const isOneToOne: boolean = isPrimary || isUniqueAttribute(attribute);
    if (reverse?.kind === 'hasOne' && !isOneToOne) {
      project.warnings.push(
        `${label}: ${reverse.label} does not make "${attribute.name}" unique, so the relation was read as a foreign key; add unique: true to the column for a one-to-one relation.`
      );
    }
    const target: RawModel | undefined = link.target;
    const targetPrepared: Prepared | undefined = context.prepared.find(
      (candidate: Prepared) => candidate.raw === target
    );
    const targetPrimary: RawAttribute | undefined = primaryKeyAttributes(
      target?.attributes ?? []
    )[0];
    const onDelete: IrOnDelete | undefined = mapAction(
      link.onDelete,
      `${label}, field "${attribute.name}"`,
      'onDelete',
      project
    );
    const onUpdate: IrOnDelete | undefined = mapAction(
      link.onUpdate,
      `${label}, field "${attribute.name}"`,
      'onUpdate',
      project
    );
    const isNullable: boolean =
      attribute.primaryKey !== true && attribute.allowNull !== false;
    relations.push({
      name,
      kind: isOneToOne ? 'oneToOne' : 'foreignKey',
      targetModel: targetPrepared?.irName ?? link.targetName,
      columnName: columnName(model.options, attribute),
      isNullable,
      onDelete: onDelete ?? 'noAction',
      ...(reverse === undefined ? {} : { relatedName: reverse.name }),
      ...(link.keyAttribute === undefined ||
      link.keyAttribute === targetPrimary?.name ||
      target === undefined
        ? {}
        : { toField: link.keyAttribute }),
      ...(isPrimary ? { isPrimaryKey: true } : {}),
      // ON UPDATE CASCADE is what Sequelize adds to every key; only a different action is worth recording.
      ...(onUpdate === undefined || onUpdate === 'cascade' ? {} : { onUpdate }),
    });
    irNames.set(attribute.name, name);
    irNames.set(columnName(model.options, attribute), name);
  }

  for (const link of links.manyToMany) {
    if (link.owner !== model) {
      continue;
    }
    relations.push(manyToManyRelation(link, takenNames, project));
  }

  // Indexes ----------------------------------------------------------------
  const indexes: IrIndex[] = [];
  for (const [name, group] of uniqueGroups) {
    if (group.length < 2) {
      continue;
    }
    indexes.push({
      fields: group.map(
        (attribute: RawAttribute) =>
          irNames.get(attribute.name) ?? attribute.name
      ),
      isUnique: true,
      name,
    });
  }
  for (const raw of modelIndexes) {
    const names: string[] = raw.fields.map(
      (field: RawIndexField) => irNames.get(field.name) ?? field.name
    );
    const known: Set<string> = new Set([
      ...fields.map((field: IrField) => field.name),
      ...relations.map((relation: IrRelation) => relation.name),
    ]);
    const missing: string[] = names.filter((name: string) => !known.has(name));
    if (raw.hasExpression || raw.fields.length === 0) {
      project.warnings.push(
        `${label}: an index on an expression (Sequelize.literal) cannot be represented and was skipped.`
      );
      continue;
    }
    if (missing.length > 0) {
      project.warnings.push(
        `${label}: the index on (${raw.fields.map((field: RawIndexField) => field.name).join(', ')}) refers to "${missing.join('", "')}", which is not a column of the model; it was skipped.`
      );
      continue;
    }
    if (raw.isPartial) {
      project.warnings.push(
        `${label}: the where condition of the index on (${names.join(', ')}) cannot be represented and was dropped.`
      );
    }
    if (raw.type === 'SPATIAL') {
      project.warnings.push(
        `${label}: the SPATIAL index on (${names.join(', ')}) was read as an ordinary index.`
      );
    }
    const method: string | undefined = indexMethod(raw.using, label, project);
    const fieldOptions: Record<string, IrIndexFieldOptions> = {};
    for (const field of raw.fields) {
      const options: IrIndexFieldOptions = {
        ...(field.order === undefined ? {} : { sort: field.order }),
        ...(field.length === undefined ? {} : { length: field.length }),
        ...(field.operator === undefined ? {} : { ops: field.operator }),
      };
      if (Object.keys(options).length > 0) {
        fieldOptions[irNames.get(field.name) ?? field.name] = options;
      }
    }
    indexes.push({
      fields: names,
      isUnique: raw.unique,
      ...(raw.name === undefined ? {} : { name: raw.name }),
      ...(raw.type === 'FULLTEXT' && !raw.unique ? { kind: 'fulltext' } : {}),
      ...(method === undefined ? {} : { method }),
      ...(Object.keys(fieldOptions).length === 0 ? {} : { fieldOptions }),
    });
  }

  // Primary key ------------------------------------------------------------
  let compositePrimaryKey: string[] | undefined;
  if (pkAttributes.length === 0) {
    project.warnings.push(
      `${label}: the model has no primary key; most ORMs need one, so add primaryKey: true to a column.`
    );
  } else if (pkAttributes.length > 1) {
    compositePrimaryKey = pkAttributes.map(
      (attribute: RawAttribute) => irNames.get(attribute.name) ?? attribute.name
    );
    for (const field of fields) {
      if (compositePrimaryKey.includes(field.name)) {
        field.isPrimaryKey = false;
        field.isUnique = false;
      }
    }
    for (const relation of relations) {
      delete relation.isPrimaryKey;
    }
  }

  // Behaviour that is not schema --------------------------------------------
  const accessors: string[] = attributes
    .filter((attribute: RawAttribute) => attribute.hasAccessor === true)
    .map((attribute: RawAttribute) => attribute.name);
  if (accessors.length > 0) {
    project.warnings.push(
      `${label}: custom getters or setters on ${accessors.join(', ')} are behaviour, not schema, and were ignored.`
    );
  }
  if (model.raw.unsupported.length > 0) {
    project.warnings.push(
      `${label}: ${model.raw.unsupported.join(', ')} ${model.raw.unsupported.length === 1 ? 'is' : 'are'} not part of the database schema and ${model.raw.unsupported.length === 1 ? 'was' : 'were'} ignored.`
    );
  }

  return {
    name: model.irName,
    tableName: model.tableName,
    appLabel: context.options.appLabel,
    fields,
    relations,
    indexes,
    ...(compositePrimaryKey === undefined ? {} : { compositePrimaryKey }),
    ...(model.options.schema === undefined
      ? {}
      : { schema: model.options.schema }),
  };
}

function manyToManyRelation(
  link: ManyToManyLink,
  takenNames: Set<string>,
  project: Project
): IrRelation {
  let name: string = link.name;
  while (takenNames.has(name)) {
    name = `${name}_`;
  }
  takenNames.add(name);
  // Other formats derive the join table from the two models; say what does not survive.
  const isSelf: boolean = link.owner === link.target;
  const expectedTable: string = `${link.owner.tableName}_${name}`;
  const expectedOwner: string = `${isSelf ? 'from_' : ''}${toSnakeCase(link.owner.irName)}_id`;
  const expectedTarget: string = `${isSelf ? 'to_' : ''}${toSnakeCase(link.target.irName)}_id`;
  if (
    link.table !== expectedTable ||
    link.ownerColumn !== expectedOwner ||
    link.targetColumn !== expectedTarget
  ) {
    project.warnings.push(
      `${link.owner.raw.location}: the join table "${link.table}" (columns ${link.ownerColumn}, ${link.targetColumn}) of ${link.label} is not preserved by name; ` +
        `formats that derive join tables will use "${expectedTable}" (columns ${expectedOwner}, ${expectedTarget}).`
    );
  }
  return {
    name,
    kind: 'manyToMany',
    targetModel: link.target.irName,
    columnName: `${toSnakeCase(name)}_id`,
    isNullable: false,
    onDelete: 'cascade',
    ...(link.relatedName === undefined
      ? {}
      : { relatedName: link.relatedName }),
  };
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

function addStubModels(
  models: IrModel[],
  warnings: string[],
  options: SequelizeParseOptions
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
        `${model.name}.${relation.name} references "${target}", which is not a model in the input. ` +
          `A stub model with an auto-increment id was generated; replace it with the real definition.`
      );
    }
  }
  models.push(...stubs);
}

function buildSchema(
  project: Project,
  options: SequelizeParseOptions
): IrSchema {
  const prepared: Prepared[] = prepareModels(project);
  const links: LinkResult = linkAssociations(prepared, project);
  resolveReferences(prepared, project);
  const context: BuildContext = {
    project,
    options,
    enums: [],
    prepared,
    links,
  };
  const models: IrModel[] = prepared.map((model: Prepared) =>
    buildModel(context, model)
  );
  addStubModels(models, project.warnings, options);
  return { models, enums: context.enums, warnings: project.warnings };
}
