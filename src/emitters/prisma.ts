import type {
  IrDefault,
  IrEnum,
  IrField,
  IrIndex,
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
}

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
  if (options.header) {
    blocks.push(emitHeader(options.provider));
  }
  for (const enumDefinition of schema.enums) {
    blocks.push(emitEnum(enumDefinition));
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

function emitHeader(provider: PrismaProvider): string {
  return [
    'generator client {',
    '  provider = "prisma-client-js"',
    '}',
    '',
    'datasource db {',
    `  provider = "${provider}"`,
    '  url      = env("DATABASE_URL")',
    '}',
  ].join('\n');
}

function emitEnum(enumDefinition: IrEnum): string {
  const lines: string[] = [`enum ${enumDefinition.name} {`];
  for (const value of enumDefinition.values) {
    const mapAttr: string =
      value.dbValue === value.name
        ? ''
        : ` @map(${JSON.stringify(value.dbValue)})`;
    lines.push(`  ${value.name}${mapAttr}`);
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
    for (const relation of model.relations) {
      const key: string = pairKey(model.name, relation.targetModel);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return counts;
}

/** Prisma needs an explicit relation name when two models are linked more than once. */
function relationNameFor(
  context: EmitContext,
  model: IrModel,
  relation: IrRelation
): string | undefined {
  const isSelfReference: boolean = model.name === relation.targetModel;
  const count: number =
    context.pairCounts.get(pairKey(model.name, relation.targetModel)) ?? 0;
  if (isSelfReference || count > 1) {
    return `${model.name}_${relation.name}`;
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

function usesNativeTypes(provider: PrismaProvider): boolean {
  return (
    provider === 'postgresql' ||
    provider === 'mysql' ||
    provider === 'cockroachdb'
  );
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

function prismaTypeOf(context: EmitContext, field: IrField): PrismaType {
  const provider: PrismaProvider = context.options.provider;
  const native: boolean = usesNativeTypes(provider);
  const postgres: boolean =
    provider === 'postgresql' || provider === 'cockroachdb';

  if (field.enumName !== undefined) {
    return { type: field.enumName };
  }
  switch (field.type) {
    case 'string':
      return field.maxLength !== undefined && native
        ? { type: 'String', nativeAttr: `@db.VarChar(${field.maxLength})` }
        : { type: 'String' };
    case 'text':
      return native
        ? { type: 'String', nativeAttr: '@db.Text' }
        : { type: 'String' };
    case 'uuid':
      return postgres
        ? { type: 'String', nativeAttr: '@db.Uuid' }
        : { type: 'String' };
    case 'int':
      return { type: 'Int' };
    case 'bigInt':
      return { type: 'BigInt' };
    case 'float':
      return { type: 'Float' };
    case 'decimal':
      return native &&
        field.maxDigits !== undefined &&
        field.decimalPlaces !== undefined
        ? {
            type: 'Decimal',
            nativeAttr: `@db.Decimal(${field.maxDigits}, ${field.decimalPlaces})`,
          }
        : { type: 'Decimal' };
    case 'boolean':
      return { type: 'Boolean' };
    case 'dateTime':
      return postgres
        ? { type: 'DateTime', nativeAttr: '@db.Timestamptz(6)' }
        : { type: 'DateTime' };
    case 'date':
      return provider === 'postgresql' || provider === 'mysql'
        ? { type: 'DateTime', nativeAttr: '@db.Date' }
        : { type: 'DateTime' };
    case 'time':
      return provider === 'postgresql' || provider === 'mysql'
        ? { type: 'DateTime', nativeAttr: '@db.Time(6)' }
        : { type: 'DateTime' };
    case 'json':
      return { type: 'Json' };
    case 'bytes':
      return { type: 'Bytes' };
    case 'duration':
      return { type: 'BigInt' };
    case 'ipAddress':
      return postgres
        ? { type: 'String', nativeAttr: '@db.Inet' }
        : { type: 'String' };
    case 'hstore':
      return { type: 'Json' };
    case 'range':
      return postgres
        ? { type: `Unsupported(${JSON.stringify(rangeTypeName(field))})` }
        : { type: 'String' };
    default:
      return { type: 'String' };
  }
}

function defaultAttrOf(field: IrField): string | undefined {
  const defaultValue: IrDefault | undefined = field.default;
  if (defaultValue === undefined) {
    return undefined;
  }
  switch (defaultValue.kind) {
    case 'autoIncrement':
      return field.type === 'int' || field.type === 'bigInt'
        ? '@default(autoincrement())'
        : undefined;
    case 'now':
      return field.isAutoUpdated ? undefined : '@default(now())';
    case 'uuid':
      return '@default(uuid())';
    case 'enumValue':
      return `@default(${defaultValue.value})`;
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
  return lines;
}

/** Reports the places where a field type or column feature has no Prisma equivalent. */
function warnAboutSpecialField(
  context: EmitContext,
  model: IrModel,
  field: IrField
): void {
  const label: string = `${model.name}.${field.name}`;
  const postgres: boolean =
    context.options.provider === 'postgresql' ||
    context.options.provider === 'cockroachdb';
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
  if (field.generated !== undefined) {
    context.warnings.push(
      `${label}: the generated column expression ${field.generated.expression} has no Prisma equivalent; ` +
        `it was written as a regular column, so Prisma will try to write to it.`
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
  const mapped: PrismaType = prismaTypeOf(context, field);
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
      typeText = 'Json';
      nativeAttr = undefined;
    }
  }

  const attrs: string[] = [];
  if (field.isPrimaryKey) {
    attrs.push('@id');
  }
  const defaultAttr: string | undefined =
    depth > 0 && isList
      ? field.default?.kind === 'literal' && field.default.value === '[]'
        ? '@default([])'
        : undefined
      : isUnsupported
        ? undefined
        : defaultAttrOf(field);
  if (defaultAttr !== undefined) {
    attrs.push(defaultAttr);
  }
  if (field.isUnique && !field.isPrimaryKey && !isUnsupported) {
    attrs.push('@unique');
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
  const optionalMark: string = field.isNullable && !isList ? '?' : '';
  return { name, type: `${typeText}${optionalMark}`, attrs };
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
    scalarAttrs.push('@id');
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
    relation
  );
  const relationArgs: string[] = [];
  if (explicitName !== undefined) {
    relationArgs.push(JSON.stringify(explicitName));
  }
  relationArgs.push(
    `fields: [${scalarName}]`,
    `references: [${key.fieldName}]`,
    `onDelete: ${ON_DELETE_NAMES[relation.onDelete]}`
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
    relation
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
    blockAttributes.push(
      `@@id([${resolveIndexFields(context, model, model.compositePrimaryKey).join(', ')}])`
    );
  }
  for (const index of model.indexes) {
    blockAttributes.push(formatIndex(context, model, index));
  }
  if (model.tableName !== model.name) {
    blockAttributes.push(`@@map(${JSON.stringify(model.tableName)})`);
  }

  const hasPrimaryKey: boolean =
    model.fields.some((field: IrField) => field.isPrimaryKey) ||
    model.relations.some(
      (relation: IrRelation) => relation.isPrimaryKey === true
    ) ||
    (model.compositePrimaryKey !== undefined &&
      model.compositePrimaryKey.length > 0);
  if (!hasPrimaryKey) {
    context.warnings.push(
      `${model.name}: the model has no primary key; Prisma requires one (@id or @@id).`
    );
  }

  const parts: string[] = [`model ${model.name} {`, ...body];
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

function formatIndex(
  context: EmitContext,
  model: IrModel,
  index: IrIndex
): string {
  const attribute: string = index.isUnique ? '@@unique' : '@@index';
  const fields: string = resolveIndexFields(context, model, index.fields).join(
    ', '
  );
  const mapArgument: string =
    index.name === undefined ? '' : `, map: ${JSON.stringify(index.name)}`;
  return `${attribute}([${fields}]${mapArgument})`;
}
