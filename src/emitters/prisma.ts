import type {
  IrCompositeForeignKey,
  IrDefault,
  IrEnum,
  IrField,
  IrIndex,
  IrIndexFieldOptions,
  IrModel,
  IrOnDelete,
  IrRelation,
  IrSchema,
} from '../ir.js';
import { findModel } from '../ir.js';
import { toCamelCase, toSnakeCase } from '../naming.js';

export type PrismaProvider =
  'postgresql' | 'mysql' | 'sqlite' | 'sqlserver' | 'mongodb' | 'cockroachdb';

export const PRISMA_PROVIDERS: readonly PrismaProvider[] = [
  'postgresql',
  'mysql',
  'sqlite',
  'sqlserver',
  'mongodb',
  'cockroachdb',
];

export interface PrismaEmitOptions {
  provider: PrismaProvider;
  /** Emit the generator and datasource blocks. */
  header: boolean;
  /** Use camelCase Prisma field names and map them to snake_case columns. */
  camelFields: boolean;
  /**
   * Prisma major version the header targets (default 6). Version 7 writes the `prisma-client` generator
   * with an `output` path and a datasource without `url` (the connection URL moves to prisma.config.ts).
   */
  prismaVersion?: PrismaVersion;
}

export type PrismaVersion = 6 | 7;

export interface EmitOutput {
  text: string;
  warnings: string[];
}

interface Line {
  name: string;
  type: string;
  attrs: string[];
}

interface KeyInfo {
  fieldName: string;
  type: string;
  nativeAttr?: string;
}

interface EmitContext {
  schema: IrSchema;
  options: PrismaEmitOptions;
  warnings: string[];
  pairCounts: Map<string, number>;
}

/**
 * Native types (`@db.*`) each provider accepts per Prisma scalar type. Checked against `prisma validate`
 * (Prisma 6.19 and 7.10); SQLite has none. Names only, arguments are passed through as written.
 */
const NATIVE_TYPES: Readonly<
  Record<PrismaProvider, Readonly<Record<string, readonly string[]>>>
> = {
  postgresql: {
    String: [
      'Text',
      'Char',
      'VarChar',
      'Bit',
      'VarBit',
      'Uuid',
      'Xml',
      'Inet',
      'Citext',
    ],
    Boolean: ['Boolean'],
    DateTime: ['Timestamp', 'Timestamptz', 'Date', 'Time', 'Timetz'],
    Int: ['Integer', 'SmallInt', 'Oid'],
    BigInt: ['BigInt'],
    Float: ['DoublePrecision', 'Real'],
    Decimal: ['Decimal', 'Money'],
    Json: ['Json', 'JsonB'],
    Bytes: ['ByteA'],
  },
  cockroachdb: {
    String: [
      'String',
      'Char',
      'CatalogSingleChar',
      'Bit',
      'VarBit',
      'Uuid',
      'Inet',
    ],
    Boolean: ['Bool'],
    DateTime: ['Timestamp', 'Timestamptz', 'Time', 'Timetz', 'Date'],
    Int: ['Int4', 'Int2', 'Oid'],
    BigInt: ['Int8'],
    Float: ['Float8', 'Float4'],
    Decimal: ['Decimal'],
    Json: ['JsonB'],
    Bytes: ['Bytes'],
  },
  mysql: {
    String: ['VarChar', 'Char', 'TinyText', 'Text', 'MediumText', 'LongText'],
    Boolean: ['TinyInt', 'Bit'],
    DateTime: ['DateTime', 'Date', 'Time', 'Timestamp'],
    Int: [
      'Int',
      'UnsignedInt',
      'SmallInt',
      'UnsignedSmallInt',
      'MediumInt',
      'UnsignedMediumInt',
      'TinyInt',
      'UnsignedTinyInt',
      'Year',
    ],
    BigInt: ['BigInt', 'UnsignedBigInt'],
    Float: ['Float', 'Double'],
    Decimal: ['Decimal'],
    Json: ['Json'],
    Bytes: [
      'LongBlob',
      'Binary',
      'VarBinary',
      'TinyBlob',
      'Blob',
      'MediumBlob',
      'Bit',
    ],
  },
  sqlserver: {
    String: [
      'Char',
      'NChar',
      'VarChar',
      'NVarChar',
      'Text',
      'NText',
      'Xml',
      'UniqueIdentifier',
    ],
    Boolean: ['Bit'],
    DateTime: [
      'DateTime',
      'DateTime2',
      'SmallDateTime',
      'Date',
      'Time',
      'DateTimeOffset',
    ],
    Int: ['Int', 'SmallInt', 'TinyInt'],
    BigInt: ['BigInt'],
    Float: ['Real', 'Float', 'Money', 'SmallMoney'],
    Decimal: ['Decimal'],
    Bytes: ['Binary', 'VarBinary', 'Image'],
  },
  mongodb: {
    String: ['String', 'ObjectId'],
    Boolean: ['Bool'],
    DateTime: ['Date', 'Timestamp'],
    Int: ['Int'],
    BigInt: ['Long'],
    Float: ['Double'],
    Json: ['Json'],
    Bytes: ['ObjectId', 'BinData'],
  },
  sqlite: {},
};

/** Index access methods (`type:`) accepted per provider. */
const INDEX_METHODS: Readonly<Record<string, readonly string[]>> = {
  postgresql: ['BTree', 'Hash', 'Gist', 'Gin', 'SpGist', 'Brin'],
  cockroachdb: ['BTree', 'Gin'],
};

const ON_DELETE_NAMES: Readonly<Record<IrOnDelete, string>> = {
  cascade: 'Cascade',
  setNull: 'SetNull',
  restrict: 'Restrict',
  noAction: 'NoAction',
  setDefault: 'SetDefault',
};

export function emitPrisma(
  schema: IrSchema,
  options: PrismaEmitOptions
): EmitOutput {
  const context: EmitContext = {
    schema,
    options,
    warnings: [],
    pairCounts: countRelationPairs(schema),
  };

  const blocks: string[] = [];
  const schemaNames: string[] = collectSchemaNames(schema);
  const hasViews: boolean = schema.models.some(
    (model: IrModel) => model.isView === true
  );
  if (options.header) {
    blocks.push(emitHeader(context, schemaNames, hasViews));
  } else {
    warnAboutMissingHeader(context, schemaNames, hasViews);
  }
  for (const enumDefinition of schema.enums) {
    if (supportsEnums(options.provider)) {
      blocks.push(emitEnum(context, enumDefinition));
    } else {
      context.warnings.push(
        `enum ${enumDefinition.name}: ${options.provider} has no enum support in Prisma; the enum was dropped and fields that use it are written as String.`
      );
    }
  }

  const reverseLines: Map<string, Line[]> = new Map();
  const modelLines: Map<string, Line[]> = new Map();
  for (const model of schema.models) {
    modelLines.set(model.name, buildForwardLines(context, model, reverseLines));
  }
  for (const model of schema.models) {
    const lines: Line[] = [...(modelLines.get(model.name) ?? [])];
    const usedNames: Set<string> = new Set(
      lines.map((line: Line) => line.name)
    );
    for (const reverseLine of reverseLines.get(model.name) ?? []) {
      lines.push({
        ...reverseLine,
        name: uniqueName(reverseLine.name, usedNames),
      });
    }
    blocks.push(emitModel(context, model, lines));
  }

  return { text: `${blocks.join('\n\n')}\n`, warnings: context.warnings };
}

// ---------------------------------------------------------------------------
// Header and enums
// ---------------------------------------------------------------------------

/** Database schema names used by models and enums, in first-use order. */
function collectSchemaNames(schema: IrSchema): string[] {
  const names: Set<string> = new Set();
  for (const enumDefinition of schema.enums) {
    if (enumDefinition.schema !== undefined) {
      names.add(enumDefinition.schema);
    }
  }
  for (const model of schema.models) {
    if (model.schema !== undefined) {
      names.add(model.schema);
    }
  }
  return [...names];
}

function supportsEnums(provider: PrismaProvider): boolean {
  return provider !== 'sqlserver';
}

/** Primary-key constraint names (`map:`) exist on PostgreSQL, CockroachDB and SQL Server only. */
function supportsPrimaryKeyNames(provider: PrismaProvider): boolean {
  return (
    provider === 'postgresql' ||
    provider === 'cockroachdb' ||
    provider === 'sqlserver'
  );
}

/** Named foreign keys are rejected by SQLite and MongoDB. */
function supportsForeignKeyNames(provider: PrismaProvider): boolean {
  return provider !== 'sqlite' && provider !== 'mongodb';
}

function supportsSchemas(provider: PrismaProvider): boolean {
  return (
    provider === 'postgresql' ||
    provider === 'cockroachdb' ||
    provider === 'sqlserver'
  );
}

function emitHeader(
  context: EmitContext,
  schemaNames: string[],
  hasViews: boolean
): string {
  const provider: PrismaProvider = context.options.provider;
  const isV7: boolean = context.options.prismaVersion === 7;
  const generatorLines: string[] = isV7
    ? ['  provider = "prisma-client"', '  output   = "../generated/prisma"']
    : ['  provider = "prisma-client-js"'];
  if (hasViews) {
    generatorLines.push('  previewFeatures = ["views"]');
    // Keep the equals signs aligned the way `prisma format` writes them.
    generatorLines.forEach((line: string, position: number): void => {
      generatorLines[position] = line.replace(
        /^(\s+\w+)\s*=/,
        (_match: string, key: string) => `${key.padEnd(17)} =`
      );
    });
  }
  const datasourceLines: string[] = [`  provider = "${provider}"`];
  if (!isV7) {
    datasourceLines.push('  url      = env("DATABASE_URL")');
  }
  if (schemaNames.length > 0 && supportsSchemas(provider)) {
    datasourceLines.push(
      `  schemas  = [${schemaNames.map((name: string) => JSON.stringify(name)).join(', ')}]`
    );
  } else if (schemaNames.length > 0) {
    context.warnings.push(
      `Provider "${provider}" does not support multiple database schemas; @@schema (${schemaNames.join(', ')}) was written but Prisma will reject it.`
    );
  }
  if (isV7 && provider === 'mongodb') {
    context.warnings.push(
      'Prisma 7 header with provider "mongodb": the schema validates, but check the Prisma 7 release notes for MongoDB support before upgrading.'
    );
  }
  return [
    'generator client {',
    ...generatorLines,
    '}',
    '',
    'datasource db {',
    ...datasourceLines,
    '}',
  ].join('\n');
}

/** Without a header there is nowhere to switch on preview features or list schemas, so say so. */
function warnAboutMissingHeader(
  context: EmitContext,
  schemaNames: string[],
  hasViews: boolean
): void {
  if (hasViews) {
    context.warnings.push(
      'The schema contains views; add previewFeatures = ["views"] to your generator block, Prisma rejects view blocks without it.'
    );
  }
  if (schemaNames.length > 0) {
    context.warnings.push(
      `The schema uses @@schema (${schemaNames.join(', ')}); list them in the datasource block as schemas = [...].`
    );
  }
}

function emitEnum(context: EmitContext, enumDefinition: IrEnum): string {
  const lines: string[] = [`enum ${enumDefinition.name} {`];
  for (const value of enumDefinition.values) {
    const mapAttr: string =
      value.dbValue === value.name
        ? ''
        : ` @map(${JSON.stringify(value.dbValue)})`;
    lines.push(`  ${value.name}${mapAttr}`);
  }
  const blockAttributes: string[] = [];
  if (
    enumDefinition.dbName !== undefined &&
    enumDefinition.dbName !== enumDefinition.name
  ) {
    blockAttributes.push(`@@map(${JSON.stringify(enumDefinition.dbName)})`);
  }
  if (enumDefinition.schema !== undefined) {
    if (supportsSchemas(context.options.provider)) {
      blockAttributes.push(
        `@@schema(${JSON.stringify(enumDefinition.schema)})`
      );
    } else {
      context.warnings.push(
        `enum ${enumDefinition.name}: ${context.options.provider} has no database schemas; @@schema("${enumDefinition.schema}") was dropped.`
      );
    }
  }
  if (blockAttributes.length > 0) {
    lines.push(
      '',
      ...blockAttributes.map((attribute: string) => `  ${attribute}`)
    );
  }
  lines.push('}');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Naming helpers
// ---------------------------------------------------------------------------

function displayName(context: EmitContext, rawName: string): string {
  return context.options.camelFields ? toCamelCase(rawName) : rawName;
}

function uniqueName(baseName: string, usedNames: Set<string>): string {
  let candidate: string = baseName;
  let suffix: number = 2;
  while (usedNames.has(candidate)) {
    candidate = `${baseName}${suffix}`;
    suffix += 1;
  }
  usedNames.add(candidate);
  return candidate;
}

function pairKey(firstModel: string, secondModel: string): string {
  return [firstModel, secondModel].sort().join('|');
}

function countRelationPairs(schema: IrSchema): Map<string, number> {
  const counts: Map<string, number> = new Map();
  for (const model of schema.models) {
    const targets: string[] = [
      ...model.relations.map((relation: IrRelation) => relation.targetModel),
      ...(model.compositeForeignKeys ?? []).map(
        (key: IrCompositeForeignKey) => key.targetModel
      ),
    ];
    for (const targetModel of targets) {
      const key: string = pairKey(model.name, targetModel);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return counts;
}

/** Prisma needs an explicit relation name when two models are linked more than once. */
function relationNameFor(
  context: EmitContext,
  model: IrModel,
  relationName: string,
  targetModel: string
): string | undefined {
  const isSelfReference: boolean = model.name === targetModel;
  const count: number =
    context.pairCounts.get(pairKey(model.name, targetModel)) ?? 0;
  if (isSelfReference || count > 1) {
    return `${model.name}_${relationName}`;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Field types
// ---------------------------------------------------------------------------

interface PrismaType {
  type: string;
  nativeAttr?: string;
}

function isPostgresFamily(provider: PrismaProvider): boolean {
  return provider === 'postgresql' || provider === 'cockroachdb';
}

const POSTGRES_RANGE_TYPES: Readonly<Record<string, string>> = {
  int: 'int4range',
  bigInt: 'int8range',
  decimal: 'numrange',
  date: 'daterange',
  dateTime: 'tstzrange',
};

function rangeTypeName(field: IrField): string {
  return POSTGRES_RANGE_TYPES[field.rangeOf ?? 'int'] ?? 'int4range';
}

function formatNative(name: string, args: readonly string[]): string {
  return `@db.${name}${args.length === 0 ? '' : `(${args.join(', ')})`}`;
}

/** Provider-specific native type written when the field carries no native type of its own. */
function defaultNative(
  provider: PrismaProvider,
  field: IrField
): string | undefined {
  const postgres: boolean = isPostgresFamily(provider);
  switch (field.type) {
    case 'string': {
      const length: number | undefined = field.maxLength;
      if (length === undefined) {
        return undefined;
      }
      if (provider === 'postgresql' || provider === 'mysql') {
        return `@db.VarChar(${length})`;
      }
      if (provider === 'cockroachdb') {
        return `@db.String(${length})`;
      }
      return provider === 'sqlserver' && length <= 4000
        ? `@db.NVarChar(${length})`
        : undefined;
    }
    case 'text':
      if (provider === 'postgresql' || provider === 'mysql') {
        return '@db.Text';
      }
      return provider === 'sqlserver' ? '@db.NVarChar(Max)' : undefined;
    case 'uuid':
      if (postgres) {
        return '@db.Uuid';
      }
      return provider === 'sqlserver' ? '@db.UniqueIdentifier' : undefined;
    case 'decimal':
      return provider !== 'sqlite' &&
        provider !== 'mongodb' &&
        field.maxDigits !== undefined &&
        field.decimalPlaces !== undefined
        ? `@db.Decimal(${field.maxDigits}, ${field.decimalPlaces})`
        : undefined;
    case 'dateTime':
      return postgres ? '@db.Timestamptz(6)' : undefined;
    case 'date':
      return provider === 'sqlite' || provider === 'mongodb'
        ? undefined
        : '@db.Date';
    case 'time':
      if (provider === 'sqlserver') {
        return '@db.Time';
      }
      return provider === 'sqlite' || provider === 'mongodb'
        ? undefined
        : '@db.Time(6)';
    case 'ipAddress':
      return postgres ? '@db.Inet' : undefined;
    case 'json':
      return provider === 'sqlserver' ? '@db.NVarChar(Max)' : undefined;
    default:
      return undefined;
  }
}

/** Prisma scalar type for an IR field, before native types are considered. */
function baseTypeOf(context: EmitContext, field: IrField): string {
  const provider: PrismaProvider = context.options.provider;
  if (field.enumName !== undefined) {
    return supportsEnums(provider) ? field.enumName : 'String';
  }
  switch (field.type) {
    case 'string':
    case 'text':
    case 'uuid':
      return 'String';
    case 'int':
      return 'Int';
    case 'bigInt':
    case 'duration':
      return 'BigInt';
    case 'float':
      return 'Float';
    case 'decimal':
      return 'Decimal';
    case 'boolean':
      return 'Boolean';
    case 'dateTime':
    case 'date':
    case 'time':
      return 'DateTime';
    case 'json':
      // SQL Server has no JSON type in Prisma; the column is stored as text.
      return provider === 'sqlserver' ? 'String' : 'Json';
    case 'bytes':
      return 'Bytes';
    case 'ipAddress':
      return 'String';
    case 'hstore':
      return 'Json';
    case 'range':
      return isPostgresFamily(provider)
        ? `Unsupported(${JSON.stringify(rangeTypeName(field))})`
        : 'String';
    case 'unsupported':
      return `Unsupported(${JSON.stringify(field.unsupportedType ?? '')})`;
    default:
      return 'String';
  }
}

/**
 * Checks a native type carried over from the source against what the target provider accepts for the
 * Prisma scalar type. Returns the `@db.*` attribute, or undefined (with a warning when a label is given).
 */
function resolveNativeType(
  context: EmitContext,
  field: IrField,
  baseType: string,
  label: string | undefined
): string | undefined {
  const nativeType = field.nativeType;
  if (nativeType === undefined) {
    return undefined;
  }
  const provider: PrismaProvider = context.options.provider;
  const accepted: readonly string[] = NATIVE_TYPES[provider][baseType] ?? [];
  if (accepted.includes(nativeType.name)) {
    return formatNative(nativeType.name, nativeType.args);
  }
  if (label !== undefined) {
    context.warnings.push(
      provider === 'sqlite'
        ? `${label}: SQLite has no native column types; @db.${nativeType.name} was dropped.`
        : `${label}: the native type @db.${nativeType.name} is not available for ${baseType} on ${provider}; the default column type was used instead.`
    );
  }
  return undefined;
}

/**
 * Maps an IR field to a Prisma type plus native attribute. A label turns on warnings about native types
 * that the target provider rejects (leave it out when only the type is needed, as for foreign keys).
 */
function prismaTypeOf(
  context: EmitContext,
  field: IrField,
  label?: string
): PrismaType {
  const baseType: string = baseTypeOf(context, field);
  if (field.type === 'range' || field.type === 'unsupported') {
    return { type: baseType };
  }
  if (field.enumName !== undefined) {
    return { type: baseType };
  }
  // A Json column stored as text on SQL Server cannot keep a JSON native type.
  const jsonAsText: boolean =
    field.type === 'json' && context.options.provider === 'sqlserver';
  const carried: string | undefined = jsonAsText
    ? undefined
    : resolveNativeType(context, field, baseType, label);
  const nativeAttr: string | undefined =
    carried ?? defaultNative(context.options.provider, field);
  return nativeAttr === undefined
    ? { type: baseType }
    : { type: baseType, nativeAttr };
}

function defaultAttrOf(
  context: EmitContext,
  field: IrField,
  label: string
): string | undefined {
  const defaultValue: IrDefault | undefined = field.default;
  if (defaultValue === undefined) {
    return undefined;
  }
  switch (defaultValue.kind) {
    case 'autoIncrement':
      if (field.type !== 'int' && field.type !== 'bigInt') {
        return undefined;
      }
      if (context.options.provider === 'mongodb') {
        context.warnings.push(
          `${label}: MongoDB does not support autoincrement(); the default was dropped (use @default(auto()) on an ObjectId key).`
        );
        return undefined;
      }
      if (context.options.provider === 'cockroachdb' && field.type === 'int') {
        context.warnings.push(
          `${label}: CockroachDB allows autoincrement() only on BigInt; the Int default was written as sequence().`
        );
        return '@default(sequence())';
      }
      return '@default(autoincrement())';
    case 'now':
      return field.isAutoUpdated ? undefined : '@default(now())';
    case 'uuid':
      return defaultValue.version === undefined
        ? '@default(uuid())'
        : `@default(uuid(${defaultValue.version}))`;
    case 'clientGenerated':
      return `@default(${defaultValue.generator}(${defaultValue.args ?? ''}))`;
    case 'dbExpression':
      return defaultValue.isFunction === true
        ? `@default(${defaultValue.expression})`
        : `@default(dbgenerated(${JSON.stringify(defaultValue.expression)}))`;
    case 'enumValue': {
      if (supportsEnums(context.options.provider)) {
        return `@default(${defaultValue.value})`;
      }
      const member = context.schema.enums
        .find((candidate: IrEnum) => candidate.name === field.enumName)
        ?.values.find((value) => value.name === defaultValue.value);
      return `@default(${JSON.stringify(member?.dbValue ?? defaultValue.value)})`;
    }
    case 'literal':
      return typeof defaultValue.value === 'string'
        ? `@default(${JSON.stringify(defaultValue.value)})`
        : `@default(${String(defaultValue.value)})`;
    default:
      return undefined;
  }
}

/** Resolves the target column of a relation: an explicit to_field, otherwise the primary key. */
function referencedKey(
  context: EmitContext,
  target: IrModel,
  toField: string | undefined,
  depth: number = 0
): KeyInfo | undefined {
  if (depth > 5) {
    return undefined;
  }
  if (toField !== undefined) {
    const explicit: IrField | undefined = target.fields.find(
      (field: IrField) => field.name === toField
    );
    if (explicit !== undefined) {
      const mapped: PrismaType = prismaTypeOf(context, explicit);
      return {
        fieldName: displayName(context, explicit.name),
        type: mapped.type,
        ...(mapped.nativeAttr === undefined
          ? {}
          : { nativeAttr: mapped.nativeAttr }),
      };
    }
  }
  const primaryField: IrField | undefined = target.fields.find(
    (field: IrField) => field.isPrimaryKey
  );
  if (primaryField !== undefined) {
    const mapped: PrismaType = prismaTypeOf(context, primaryField);
    return {
      fieldName: displayName(context, primaryField.name),
      type: mapped.type,
      ...(mapped.nativeAttr === undefined
        ? {}
        : { nativeAttr: mapped.nativeAttr }),
    };
  }
  const primaryRelation: IrRelation | undefined = target.relations.find(
    (relation: IrRelation) => relation.isPrimaryKey === true
  );
  if (primaryRelation !== undefined) {
    const chained: IrModel | undefined = findModel(
      context.schema,
      primaryRelation.targetModel
    );
    if (chained !== undefined) {
      const chainedKey: KeyInfo | undefined = referencedKey(
        context,
        chained,
        primaryRelation.toField,
        depth + 1
      );
      if (chainedKey !== undefined) {
        return {
          ...chainedKey,
          fieldName: scalarNameOf(context, primaryRelation),
        };
      }
    }
  }
  return undefined;
}

/** Name of the scalar foreign-key field that backs a relation. */
function scalarNameOf(context: EmitContext, relation: IrRelation): string {
  const scalarName: string = displayName(context, relation.columnName);
  const relationName: string = displayName(context, relation.name);
  if (scalarName !== relationName) {
    return scalarName;
  }
  return context.options.camelFields ? `${scalarName}Id` : `${scalarName}_id`;
}

// ---------------------------------------------------------------------------
// Model lines
// ---------------------------------------------------------------------------

function buildForwardLines(
  context: EmitContext,
  model: IrModel,
  reverseLines: Map<string, Line[]>
): Line[] {
  const lines: Line[] = [];

  for (const field of model.fields) {
    lines.push(buildFieldLine(context, model, field));
  }

  for (const relation of model.relations) {
    const target: IrModel | undefined = findModel(
      context.schema,
      relation.targetModel
    );
    if (target === undefined) {
      context.warnings.push(
        `${model.name}.${relation.name}: target model "${relation.targetModel}" does not exist in the schema; the relation was skipped.`
      );
      continue;
    }
    if (relation.kind === 'manyToMany') {
      addImplicitManyToMany(context, model, relation, reverseLines, lines);
    } else {
      addForeignKey(context, model, relation, target, reverseLines, lines);
    }
  }
  for (const key of model.compositeForeignKeys ?? []) {
    addCompositeForeignKey(context, model, key, reverseLines, lines);
  }
  return lines;
}

/** Reports the places where a field type or column feature has no Prisma equivalent. */
function warnAboutSpecialField(
  context: EmitContext,
  model: IrModel,
  field: IrField
): void {
  const label: string = `${model.name}.${field.name}`;
  const provider: PrismaProvider = context.options.provider;
  const postgres: boolean = isPostgresFamily(provider);
  if (field.type === 'duration') {
    context.warnings.push(
      `${label}: Prisma has no interval type; the duration was written as BigInt (microseconds).`
    );
  }
  if (field.type === 'hstore') {
    context.warnings.push(
      `${label}: Prisma has no hstore type; the field was written as Json.`
    );
  }
  if (field.type === 'range') {
    context.warnings.push(
      postgres
        ? `${label}: range columns are written as Unsupported("${rangeTypeName(field)}"), which Prisma Client cannot read or filter.`
        : `${label}: range columns exist only on PostgreSQL; the field was written as String.`
    );
  }
  if (field.type === 'unsupported') {
    context.warnings.push(
      `${label}: Unsupported("${field.unsupportedType ?? ''}") is kept as an opaque column; Prisma Client cannot read, filter or write it.`
    );
  }
  if (field.generated !== undefined) {
    context.warnings.push(
      `${label}: the generated column expression ${field.generated.expression} has no Prisma equivalent; ` +
        `it was written as a regular column, so Prisma will try to write to it.`
    );
  }
  if (field.type === 'json' && provider === 'sqlserver') {
    context.warnings.push(
      `${label}: SQL Server has no Json type in Prisma; the field was written as String @db.NVarChar(Max).`
    );
  }
  if (field.type === 'decimal' && provider === 'mongodb') {
    context.warnings.push(
      `${label}: MongoDB does not support Decimal in Prisma; Prisma will reject this field.`
    );
  }
}

function buildFieldLine(
  context: EmitContext,
  model: IrModel,
  field: IrField
): Line {
  const label: string = `${model.name}.${field.name}`;
  warnAboutSpecialField(context, model, field);
  const mapped: PrismaType = prismaTypeOf(context, field, label);
  let typeText: string = mapped.type;
  let nativeAttr: string | undefined = mapped.nativeAttr;
  const isUnsupported: boolean = typeText.startsWith('Unsupported(');
  const depth: number = field.arrayDepth ?? 0;
  let isList: boolean = false;
  if (depth > 0) {
    const provider: PrismaProvider = context.options.provider;
    const supportsLists: boolean =
      provider === 'postgresql' ||
      provider === 'cockroachdb' ||
      provider === 'mongodb';
    if (supportsLists && depth === 1 && !isUnsupported) {
      isList = true;
      typeText = `${typeText}[]`;
      if (field.isNullable) {
        context.warnings.push(
          `${label}: Prisma lists cannot be optional; the nullable array was written as a required list.`
        );
      }
    } else {
      context.warnings.push(
        supportsLists
          ? `${label}: Prisma supports only one-dimensional scalar lists; the ${depth}-dimensional array was written as Json.`
          : `${label}: ${provider} has no scalar list type in Prisma; the array was written as Json.`
      );
      const jsonFallback: boolean = context.options.provider !== 'sqlserver';
      typeText = jsonFallback ? 'Json' : 'String';
      nativeAttr = jsonFallback ? undefined : '@db.NVarChar(Max)';
    }
  }

  const attrs: string[] = [];
  if (field.isPrimaryKey) {
    attrs.push(idAttribute(context, model));
  }
  let defaultAttr: string | undefined;
  if (depth > 0 && isList) {
    defaultAttr =
      field.default?.kind === 'literal' && field.default.value === '[]'
        ? '@default([])'
        : undefined;
  } else if (field.type === 'range') {
    defaultAttr = undefined;
  } else if (isUnsupported) {
    defaultAttr =
      field.default?.kind === 'dbExpression'
        ? defaultAttrOf(context, field, label)
        : undefined;
  } else {
    defaultAttr = defaultAttrOf(context, field, label);
  }
  if (defaultAttr !== undefined) {
    attrs.push(defaultAttr);
  }
  if (field.isUnique && !field.isPrimaryKey && field.type !== 'range') {
    attrs.push(
      field.uniqueName === undefined
        ? '@unique'
        : `@unique(map: ${JSON.stringify(field.uniqueName)})`
    );
  }
  if (field.isAutoUpdated) {
    attrs.push('@updatedAt');
  }
  const name: string = displayName(context, field.name);
  if (field.columnName !== name) {
    attrs.push(`@map(${JSON.stringify(field.columnName)})`);
  }
  if (nativeAttr !== undefined) {
    attrs.push(nativeAttr);
  }
  if (field.isIgnored === true) {
    attrs.push('@ignore');
  }
  const optionalMark: string = field.isNullable && !isList ? '?' : '';
  return { name, type: `${typeText}${optionalMark}`, attrs };
}

/** `@id`, with the constraint name when the source gave one and the key is a single column. */
function idAttribute(context: EmitContext, model: IrModel): string {
  if (
    model.primaryKeyName === undefined ||
    model.compositePrimaryKey !== undefined
  ) {
    return '@id';
  }
  return withPrimaryKeyName(
    context,
    model,
    '@id',
    (name: string) => `@id(map: ${JSON.stringify(name)})`
  );
}

/** Applies the primary-key constraint name when the provider supports it, otherwise warns. */
function withPrimaryKeyName(
  context: EmitContext,
  model: IrModel,
  plain: string,
  named: (name: string) => string
): string {
  if (model.primaryKeyName === undefined) {
    return plain;
  }
  if (supportsPrimaryKeyNames(context.options.provider)) {
    return named(model.primaryKeyName);
  }
  context.warnings.push(
    `${model.name}: ${context.options.provider} does not support named primary keys; the constraint name "${model.primaryKeyName}" was dropped.`
  );
  return plain;
}

/** The arguments after `fields` / `references`: referential actions and the constraint name. */
function relationTail(
  context: EmitContext,
  label: string,
  onDelete: IrOnDelete,
  onUpdate: IrOnDelete | undefined,
  constraintName: string | undefined
): string[] {
  const provider: PrismaProvider = context.options.provider;
  const action = (value: IrOnDelete): string => {
    if (provider === 'sqlserver' && value === 'restrict') {
      context.warnings.push(
        `${label}: SQL Server has no Restrict referential action; NoAction was written instead.`
      );
      return ON_DELETE_NAMES.noAction;
    }
    return ON_DELETE_NAMES[value];
  };
  const tail: string[] = [`onDelete: ${action(onDelete)}`];
  if (onUpdate !== undefined) {
    tail.push(`onUpdate: ${action(onUpdate)}`);
  }
  if (constraintName !== undefined) {
    if (supportsForeignKeyNames(provider)) {
      tail.push(`map: ${JSON.stringify(constraintName)}`);
    } else {
      context.warnings.push(
        `${label}: ${provider} does not support named foreign keys; the constraint name "${constraintName}" was dropped.`
      );
    }
  }
  return tail;
}

function addForeignKey(
  context: EmitContext,
  model: IrModel,
  relation: IrRelation,
  target: IrModel,
  reverseLines: Map<string, Line[]>,
  lines: Line[]
): void {
  const key: KeyInfo | undefined = referencedKey(
    context,
    target,
    relation.toField
  );
  if (key === undefined) {
    context.warnings.push(
      `${model.name}.${relation.name}: target model "${target.name}" has no single-column primary key to reference ` +
        `(composite keys cannot be referenced here); the relation was skipped.`
    );
    return;
  }

  const scalarName: string = scalarNameOf(context, relation);
  const relationName: string = displayName(context, relation.name);
  const optionalMark: string = relation.isNullable ? '?' : '';
  const scalarAttrs: string[] = [];
  if (relation.isPrimaryKey === true) {
    scalarAttrs.push(idAttribute(context, model));
  } else if (relation.kind === 'oneToOne') {
    scalarAttrs.push('@unique');
  }
  if (relation.columnName !== scalarName) {
    scalarAttrs.push(`@map(${JSON.stringify(relation.columnName)})`);
  }
  if (key.nativeAttr !== undefined) {
    scalarAttrs.push(key.nativeAttr);
  }
  lines.push({
    name: scalarName,
    type: `${key.type}${optionalMark}`,
    attrs: scalarAttrs,
  });

  const explicitName: string | undefined = relationNameFor(
    context,
    model,
    relation.name,
    relation.targetModel
  );
  const relationArgs: string[] = [];
  if (explicitName !== undefined) {
    relationArgs.push(JSON.stringify(explicitName));
  }
  relationArgs.push(
    `fields: [${scalarName}]`,
    `references: [${key.fieldName}]`,
    ...relationTail(
      context,
      `${model.name}.${relation.name}`,
      relation.onDelete,
      relation.onUpdate,
      relation.constraintName
    )
  );
  lines.push({
    name: relationName,
    type: `${target.name}${optionalMark}`,
    attrs: [`@relation(${relationArgs.join(', ')})`],
  });

  const defaultReverse: string =
    relation.kind === 'oneToOne'
      ? toSnakeCase(model.name)
      : `${toSnakeCase(model.name)}_set`;
  const reverseName: string = displayName(
    context,
    relation.relatedName ?? defaultReverse
  );
  const reverseType: string =
    relation.kind === 'oneToOne' ? `${model.name}?` : `${model.name}[]`;
  const reverseAttrs: string[] =
    explicitName === undefined
      ? []
      : [`@relation(${JSON.stringify(explicitName)})`];
  addReverseLine(reverseLines, target.name, {
    name: reverseName,
    type: reverseType,
    attrs: reverseAttrs,
  });
}

/** Writes a multi-column foreign key; the local columns are ordinary fields of the model. */
function addCompositeForeignKey(
  context: EmitContext,
  model: IrModel,
  key: IrCompositeForeignKey,
  reverseLines: Map<string, Line[]>,
  lines: Line[]
): void {
  const label: string = `${model.name}.${key.name}`;
  const target: IrModel | undefined = findModel(
    context.schema,
    key.targetModel
  );
  if (target === undefined) {
    context.warnings.push(
      `${label}: target model "${key.targetModel}" does not exist in the schema; the composite foreign key was skipped.`
    );
    return;
  }
  const missingLocal: string | undefined = key.fields.find(
    (name: string) =>
      !model.fields.some((field: IrField) => field.name === name)
  );
  const missingTarget: string | undefined = key.references.find(
    (name: string) =>
      !target.fields.some((field: IrField) => field.name === name)
  );
  if (
    missingLocal !== undefined ||
    missingTarget !== undefined ||
    key.fields.length !== key.references.length
  ) {
    context.warnings.push(
      `${label}: the composite foreign key (${key.fields.join(', ')}) -> ${target.name}(${key.references.join(', ')}) ` +
        `uses fields that do not exist or do not pair up; it was skipped.`
    );
    return;
  }

  const optionalMark: string = key.isNullable ? '?' : '';
  const explicitName: string | undefined = relationNameFor(
    context,
    model,
    key.name,
    key.targetModel
  );
  const relationArgs: string[] = [];
  if (explicitName !== undefined) {
    relationArgs.push(JSON.stringify(explicitName));
  }
  relationArgs.push(
    `fields: [${key.fields.map((name: string) => displayName(context, name)).join(', ')}]`,
    `references: [${key.references.map((name: string) => displayName(context, name)).join(', ')}]`,
    ...relationTail(
      context,
      label,
      key.onDelete,
      key.onUpdate,
      key.constraintName
    )
  );
  lines.push({
    name: displayName(context, key.name),
    type: `${target.name}${optionalMark}`,
    attrs: [`@relation(${relationArgs.join(', ')})`],
  });

  const defaultReverse: string =
    key.kind === 'oneToOne'
      ? toSnakeCase(model.name)
      : `${toSnakeCase(model.name)}_set`;
  addReverseLine(reverseLines, target.name, {
    name: displayName(context, key.relatedName ?? defaultReverse),
    type: key.kind === 'oneToOne' ? `${model.name}?` : `${model.name}[]`,
    attrs:
      explicitName === undefined
        ? []
        : [`@relation(${JSON.stringify(explicitName)})`],
  });
}

function addImplicitManyToMany(
  context: EmitContext,
  model: IrModel,
  relation: IrRelation,
  reverseLines: Map<string, Line[]>,
  lines: Line[]
): void {
  const explicitName: string | undefined = relationNameFor(
    context,
    model,
    relation.name,
    relation.targetModel
  );
  const attrs: string[] =
    explicitName === undefined
      ? []
      : [`@relation(${JSON.stringify(explicitName)})`];
  lines.push({
    name: displayName(context, relation.name),
    type: `${relation.targetModel}[]`,
    attrs,
  });
  const reverseName: string = displayName(
    context,
    relation.relatedName ?? `${toSnakeCase(model.name)}_set`
  );
  addReverseLine(reverseLines, relation.targetModel, {
    name: reverseName,
    type: `${model.name}[]`,
    attrs: [...attrs],
  });
}

function addReverseLine(
  reverseLines: Map<string, Line[]>,
  targetModel: string,
  line: Line
): void {
  const existing: Line[] = reverseLines.get(targetModel) ?? [];
  existing.push(line);
  reverseLines.set(targetModel, existing);
}

// ---------------------------------------------------------------------------
// Model blocks
// ---------------------------------------------------------------------------

function emitModel(
  context: EmitContext,
  model: IrModel,
  lines: Line[]
): string {
  const body: string[] = formatLines(lines);
  const blockAttributes: string[] = [];

  if (
    model.compositePrimaryKey !== undefined &&
    model.compositePrimaryKey.length > 0
  ) {
    const keyFields: string = resolveIndexFields(
      context,
      model,
      model.compositePrimaryKey
    ).join(', ');
    blockAttributes.push(
      withPrimaryKeyName(
        context,
        model,
        `@@id([${keyFields}])`,
        (name: string) => `@@id([${keyFields}], map: ${JSON.stringify(name)})`
      )
    );
  }
  for (const index of model.indexes) {
    blockAttributes.push(formatIndex(context, model, index));
  }
  if (model.tableName !== model.name) {
    blockAttributes.push(`@@map(${JSON.stringify(model.tableName)})`);
  }
  if (model.isIgnored === true) {
    blockAttributes.push('@@ignore');
  }
  if (model.schema !== undefined) {
    if (supportsSchemas(context.options.provider)) {
      blockAttributes.push(`@@schema(${JSON.stringify(model.schema)})`);
    } else {
      context.warnings.push(
        `${model.name}: ${context.options.provider} has no database schemas; @@schema("${model.schema}") was dropped.`
      );
    }
  }

  const hasPrimaryKey: boolean =
    model.fields.some((field: IrField) => field.isPrimaryKey) ||
    model.relations.some(
      (relation: IrRelation) => relation.isPrimaryKey === true
    ) ||
    (model.compositePrimaryKey !== undefined &&
      model.compositePrimaryKey.length > 0);
  if (context.options.provider === 'mongodb' && hasPrimaryKey) {
    const keyedOnId: boolean =
      model.compositePrimaryKey === undefined &&
      model.fields.some(
        (field: IrField) => field.isPrimaryKey && field.columnName === '_id'
      );
    if (!keyedOnId) {
      context.warnings.push(
        `${model.name}: MongoDB needs a single id field mapped to _id (@map("_id")), usually String @db.ObjectId @default(auto()); ` +
          `the key was written as for a SQL database, so Prisma will reject it.`
      );
    }
  }
  if (!hasPrimaryKey && model.isView !== true) {
    context.warnings.push(
      `${model.name}: the model has no primary key; Prisma requires one (@id or @@id).`
    );
  }
  if (model.isView === true && !hasPrimaryKey) {
    const hasUnique: boolean =
      model.fields.some((field: IrField) => field.isUnique) ||
      model.indexes.some((index: IrIndex) => index.isUnique);
    if (!hasUnique) {
      context.warnings.push(
        `${model.name}: the view has no @id or @unique field; Prisma Client can only read it through findMany-style queries that need a unique key for cursors and relations.`
      );
    }
  }

  const keyword: string = model.isView === true ? 'view' : 'model';
  const parts: string[] = [`${keyword} ${model.name} {`, ...body];
  if (blockAttributes.length > 0) {
    parts.push(
      '',
      ...blockAttributes.map((attribute: string) => `  ${attribute}`)
    );
  }
  parts.push('}');
  return parts.join('\n');
}

function formatLines(lines: Line[]): string[] {
  if (lines.length === 0) {
    return [];
  }
  const nameWidth: number = Math.max(
    ...lines.map((line: Line) => line.name.length)
  );
  const typeWidth: number = Math.max(
    ...lines.map((line: Line) => line.type.length)
  );
  return lines.map((line: Line) =>
    `  ${line.name.padEnd(nameWidth)} ${line.type.padEnd(typeWidth)} ${line.attrs.join(' ')}`.trimEnd()
  );
}

function resolveIndexFields(
  context: EmitContext,
  model: IrModel,
  fieldNames: string[]
): string[] {
  return fieldNames.map((fieldName: string): string => {
    const relation: IrRelation | undefined = model.relations.find(
      (candidate: IrRelation) => candidate.name === fieldName
    );
    if (relation !== undefined) {
      return scalarNameOf(context, relation);
    }
    const field: IrField | undefined = model.fields.find(
      (candidate: IrField) => candidate.name === fieldName
    );
    if (field === undefined) {
      context.warnings.push(
        `${model.name}: an index references "${fieldName}", which is not a field of the model; it was written as-is.`
      );
    }
    return displayName(context, fieldName);
  });
}

/** Writes one index entry with the per-field options the provider accepts. */
function formatIndexEntry(
  context: EmitContext,
  label: string,
  name: string,
  options: IrIndexFieldOptions | undefined
): string {
  if (options === undefined) {
    return name;
  }
  const provider: PrismaProvider = context.options.provider;
  const parts: string[] = [];
  if (options.sort !== undefined) {
    parts.push(`sort: ${options.sort === 'desc' ? 'Desc' : 'Asc'}`);
  }
  if (options.length !== undefined) {
    if (provider === 'mysql') {
      parts.push(`length: ${options.length}`);
    } else {
      context.warnings.push(
        `${label}: the prefix length on "${name}" is only supported on MySQL and was dropped.`
      );
    }
  }
  if (options.ops !== undefined) {
    if (provider === 'postgresql') {
      parts.push(`ops: ${options.ops}`);
    } else {
      context.warnings.push(
        `${label}: the operator class on "${name}" is only supported on PostgreSQL and was dropped.`
      );
    }
  }
  return parts.length === 0 ? name : `${name}(${parts.join(', ')})`;
}

/** SQL Server cannot index NVarChar(Max) and MySQL needs a prefix length on TEXT columns. */
function warnAboutUnindexableColumns(
  context: EmitContext,
  model: IrModel,
  index: IrIndex,
  label: string
): void {
  const provider: PrismaProvider = context.options.provider;
  if (provider !== 'sqlserver' && provider !== 'mysql') {
    return;
  }
  for (const fieldName of index.fields) {
    const field: IrField | undefined = model.fields.find(
      (candidate: IrField) => candidate.name === fieldName
    );
    if (field === undefined) {
      continue;
    }
    const native: string | undefined = prismaTypeOf(context, field).nativeAttr;
    if (provider === 'sqlserver' && native === '@db.NVarChar(Max)') {
      context.warnings.push(
        `${label}: "${fieldName}" is NVarChar(Max), which SQL Server cannot index or make unique; Prisma will reject the index.`
      );
    }
    const isMysqlText: boolean =
      provider === 'mysql' &&
      native !== undefined &&
      /^@db\.(Tiny|Medium|Long)?Text$/.test(native) &&
      index.fieldOptions?.[fieldName]?.length === undefined &&
      index.kind !== 'fulltext';
    if (isMysqlText) {
      context.warnings.push(
        `${label}: "${fieldName}" is a TEXT column; MySQL needs a prefix length (e.g. ${fieldName}(length: 191)) to index it, and Prisma will reject the index.`
      );
    }
  }
}

function formatIndex(
  context: EmitContext,
  model: IrModel,
  index: IrIndex
): string {
  const provider: PrismaProvider = context.options.provider;
  const label: string = `${model.name} index (${index.fields.join(', ')})`;
  const fullText: boolean = index.kind === 'fulltext';
  let attribute: string = index.isUnique ? '@@unique' : '@@index';
  if (fullText) {
    if (provider === 'mysql' || provider === 'mongodb') {
      attribute = '@@fulltext';
    } else {
      context.warnings.push(
        `${label}: ${provider} has no @@fulltext index in Prisma; it was written as an ordinary @@index.`
      );
    }
  }
  warnAboutUnindexableColumns(context, model, index, label);
  const resolved: string[] = resolveIndexFields(context, model, index.fields);
  const entries: string[] = resolved.map(
    (name: string, position: number): string => {
      const options: IrIndexFieldOptions | undefined =
        index.fieldOptions?.[index.fields[position] ?? ''];
      if (attribute === '@@fulltext' && options !== undefined) {
        context.warnings.push(
          `${label}: per-field options on "${name}" are not supported in @@fulltext and were dropped.`
        );
        return name;
      }
      return formatIndexEntry(context, label, name, options);
    }
  );
  const args: string[] = [`[${entries.join(', ')}]`];
  if (index.method !== undefined && attribute !== '@@fulltext') {
    if (INDEX_METHODS[provider]?.includes(index.method) === true) {
      args.push(`type: ${index.method}`);
    } else if (index.method !== 'BTree') {
      // BTree is every database's default index type, so dropping it loses nothing.

      context.warnings.push(
        `${label}: the index type ${index.method} is not supported on ${provider} and was dropped.`
      );
    }
  }
  if (index.clustered !== undefined) {
    if (provider === 'sqlserver') {
      args.push(`clustered: ${String(index.clustered)}`);
    } else {
      context.warnings.push(
        `${label}: clustered indexes are only supported on SQL Server and the setting was dropped.`
      );
    }
  }
  if (index.name !== undefined) {
    args.push(`map: ${JSON.stringify(index.name)}`);
  }
  return `${attribute}(${args.join(', ')})`;
}
