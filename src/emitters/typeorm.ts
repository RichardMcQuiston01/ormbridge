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
import { toCamelCase, toSnakeCase } from '../naming.js';
import type { EmitOutput, PrismaProvider } from './prisma.js';

export interface TypeormEmitOptions {
  /** Database provider; chooses the column types (for example timestamptz vs datetime). */
  provider: PrismaProvider;
  /** Use camelCase property names and map them to the original column names. */
  camelFields: boolean;
}

type Dialect = 'postgres' | 'mysql' | 'sqlite' | 'sqlserver';

interface Member {
  /** Decorator lines followed by the property declaration, already indented. */
  lines: string[];
}

interface ModelNames {
  fields: Map<string, string>;
  relations: Map<string, string>;
  /** Scalar foreign-key property for relations that are part of the primary key. */
  scalars: Map<string, string>;
  used: Set<string>;
}

interface ColumnSpec {
  /** Entries for the column options that describe the type (type, length, enum, ...). */
  typeEntries: string[];
  tsType: string;
  dbType: string;
}

interface EmitContext {
  schema: IrSchema;
  options: TypeormEmitOptions;
  dialect: Dialect;
  warnings: string[];
  imports: Set<string>;
  names: Map<string, ModelNames>;
  /** "Model.relation" -> property name of the inverse side on the target model. */
  inverseNames: Map<string, string>;
}

const IDENTIFIER_PATTERN: RegExp = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const CREATED_FIELD_PATTERN: RegExp =
  /^(created|created_?at|date_?created|createdon)$/i;
const MAX_LINE_WIDTH: number = 80;

const ON_DELETE_NAMES: Readonly<Record<IrOnDelete, string>> = {
  cascade: 'CASCADE',
  setNull: 'SET NULL',
  restrict: 'RESTRICT',
  noAction: 'NO ACTION',
  setDefault: 'SET DEFAULT',
};

export function emitTypeorm(
  schema: IrSchema,
  options: TypeormEmitOptions
): EmitOutput {
  const context: EmitContext = {
    schema,
    options,
    dialect: dialectOf(options.provider),
    warnings: [],
    imports: new Set<string>(),
    names: new Map<string, ModelNames>(),
    inverseNames: new Map<string, string>(),
  };
  if (options.provider === 'mongodb') {
    context.warnings.push(
      'Provider "mongodb": TypeORM entities for MongoDB need different decorators; SQL column types (PostgreSQL style) were used.'
    );
  }

  allocateNames(context);

  const blocks: string[] = [];
  for (const enumDefinition of schema.enums) {
    blocks.push(emitEnum(context, enumDefinition));
  }

  const inverseMembers: Map<string, Member[]> = new Map<string, Member[]>();
  const classMembers: Map<string, Member[]> = new Map<string, Member[]>();
  for (const model of schema.models) {
    classMembers.set(
      model.name,
      buildForwardMembers(context, model, inverseMembers)
    );
  }
  for (const model of schema.models) {
    const members: Member[] = [
      ...(classMembers.get(model.name) ?? []),
      ...(inverseMembers.get(model.name) ?? []),
    ];
    blocks.push(emitClass(context, model, members));
  }

  if (blocks.length === 0) {
    return { text: '', warnings: context.warnings };
  }
  const importLine: string = buildImportLine(context.imports);
  return {
    text: `${[importLine, ...blocks].join('\n\n')}\n`,
    warnings: context.warnings,
  };
}

// ---------------------------------------------------------------------------
// Imports and small formatting helpers
// ---------------------------------------------------------------------------

function buildImportLine(imports: Set<string>): string {
  const names: string[] = [...imports].sort((first: string, second: string) =>
    first.localeCompare(second)
  );
  const specifiers: string[] = names.map((name: string) =>
    name === 'Relation' ? 'type Relation' : name
  );
  return `import { ${specifiers.join(', ')} } from 'typeorm';`;
}

function use(context: EmitContext, name: string): string {
  context.imports.add(name);
  return name;
}

function quote(value: string): string {
  const escaped: string = value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n');
  if (value.includes("'") && !value.includes('"')) {
    return `"${escaped}"`;
  }
  return `'${escaped.replace(/'/g, "\\'")}'`;
}

/**
 * Formats a decorator. Leading arguments are written as-is; options become one
 * object literal that wraps onto several lines when the decorator is too wide.
 */
function decorator(
  name: string,
  args: string[],
  entries: string[],
  indent: string = '  '
): string[] {
  const parts: string[] = [...args];
  if (entries.length > 0) {
    parts.push(`{ ${entries.join(', ')} }`);
  }
  const inline: string = `${indent}@${name}(${parts.join(', ')})`;
  if (entries.length === 0 || inline.length <= MAX_LINE_WIDTH) {
    return [inline];
  }
  const lead: string = args.length > 0 ? `${args.join(', ')}, ` : '';
  return [
    `${indent}@${name}(${lead}{`,
    ...entries.map((entry: string) => `${indent}  ${entry},`),
    `${indent}})`,
  ];
}

function identifier(context: EmitContext, owner: string, raw: string): string {
  if (IDENTIFIER_PATTERN.test(raw)) {
    return raw;
  }
  const replaced: string = raw.replace(/[^A-Za-z0-9_$]/g, '_');
  const safe: string = /^[0-9]/.test(replaced) ? `_${replaced}` : replaced;
  const result: string = safe === '' ? '_' : safe;
  context.warnings.push(
    `${owner}: "${raw}" is not a valid TypeScript identifier; it was written as "${result}".`
  );
  return result;
}

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

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

function propertyName(context: EmitContext, rawName: string): string {
  return context.options.camelFields ? toCamelCase(rawName) : rawName;
}

function isKeyedRelation(model: IrModel, relation: IrRelation): boolean {
  return (
    relation.isPrimaryKey === true ||
    (model.compositePrimaryKey?.includes(relation.name) ?? false)
  );
}

function allocateNames(context: EmitContext): void {
  for (const model of context.schema.models) {
    const names: ModelNames = {
      fields: new Map<string, string>(),
      relations: new Map<string, string>(),
      scalars: new Map<string, string>(),
      used: new Set<string>(),
    };
    for (const field of model.fields) {
      const safe: string = identifier(
        context,
        `${model.name}.${field.name}`,
        propertyName(context, field.name)
      );
      names.fields.set(field.name, uniqueName(safe, names.used));
    }
    for (const relation of model.relations) {
      const safe: string = identifier(
        context,
        `${model.name}.${relation.name}`,
        propertyName(context, relation.name)
      );
      const relationProp: string = uniqueName(safe, names.used);
      names.relations.set(relation.name, relationProp);
      if (relation.kind !== 'manyToMany' && isKeyedRelation(model, relation)) {
        const columnProp: string = propertyName(context, relation.columnName);
        const base: string =
          columnProp !== relationProp ? columnProp : `${relationProp}Id`;
        names.scalars.set(
          relation.name,
          uniqueName(
            identifier(context, `${model.name}.${relation.name}`, base),
            names.used
          )
        );
      }
    }
    context.names.set(model.name, names);
  }

  for (const model of context.schema.models) {
    for (const relation of model.relations) {
      const target: IrModel | undefined = findModel(
        context.schema,
        relation.targetModel
      );
      const targetNames: ModelNames | undefined = context.names.get(
        relation.targetModel
      );
      if (target === undefined || targetNames === undefined) {
        continue;
      }
      const defaultName: string =
        relation.kind === 'oneToOne'
          ? toSnakeCase(model.name)
          : `${toSnakeCase(model.name)}_set`;
      const safe: string = identifier(
        context,
        `${model.name}.${relation.name}`,
        propertyName(context, relation.relatedName ?? defaultName)
      );
      context.inverseNames.set(
        `${model.name}.${relation.name}`,
        uniqueName(safe, targetNames.used)
      );
    }
  }
}

function namesOf(context: EmitContext, model: IrModel): ModelNames {
  return (
    context.names.get(model.name) ?? {
      fields: new Map<string, string>(),
      relations: new Map<string, string>(),
      scalars: new Map<string, string>(),
      used: new Set<string>(),
    }
  );
}

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

function emitEnum(context: EmitContext, enumDefinition: IrEnum): string {
  const lines: string[] = [`export enum ${enumDefinition.name} {`];
  for (const value of enumDefinition.values) {
    lines.push(
      `  ${enumMemberName(context, enumDefinition, value)} = ${quote(value.dbValue)},`
    );
  }
  lines.push('}');
  return lines.join('\n');
}

function enumMemberName(
  context: EmitContext,
  enumDefinition: IrEnum,
  value: IrEnumValue
): string {
  return identifier(context, `enum ${enumDefinition.name}`, value.name);
}

/** Finds the enum member a default refers to, by member name or stored value. */
function enumReference(
  context: EmitContext,
  enumDefinition: IrEnum,
  raw: string
): string | undefined {
  const value: IrEnumValue | undefined =
    enumDefinition.values.find((candidate) => candidate.name === raw) ??
    enumDefinition.values.find((candidate) => candidate.dbValue === raw);
  if (value === undefined) {
    return undefined;
  }
  const memberName: string = identifier(
    { ...context, warnings: [] },
    '',
    value.name
  );
  return `${enumDefinition.name}.${memberName}`;
}

// ---------------------------------------------------------------------------
// Column types
// ---------------------------------------------------------------------------

const POSTGRES_RANGE_TYPES: Readonly<Record<string, string>> = {
  int: 'int4range',
  bigInt: 'int8range',
  decimal: 'numrange',
  date: 'daterange',
  dateTime: 'tstzrange',
};

/** Column type of a field, including array columns built on top of the element type. */
function columnSpecOf(
  context: EmitContext,
  label: string,
  field: IrField
): ColumnSpec {
  const depth: number = field.arrayDepth ?? 0;
  if (depth === 0) {
    return scalarColumnSpec(context, label, field);
  }
  const element: ColumnSpec = scalarColumnSpec(context, label, {
    ...field,
    arrayDepth: undefined,
  });
  const tsType: string = `${element.tsType.includes(' ') ? `(${element.tsType})` : element.tsType}${'[]'.repeat(depth)}`;
  if (context.dialect === 'postgres') {
    return {
      typeEntries: [...element.typeEntries, 'array: true'],
      tsType,
      dbType: element.dbType,
    };
  }
  const jsonType: string = context.dialect === 'mysql' ? 'json' : 'simple-json';
  context.warnings.push(
    `${label}: ${context.dialect} has no array column type; the array was written as ${jsonType}.`
  );
  return {
    typeEntries: [`type: '${jsonType}'`],
    tsType,
    dbType: jsonType,
  };
}

function scalarColumnSpec(
  context: EmitContext,
  label: string,
  field: IrField
): ColumnSpec {
  const dialect: Dialect = context.dialect;

  if (field.enumName !== undefined) {
    const enumDefinition: IrEnum | undefined = context.schema.enums.find(
      (candidate: IrEnum) => candidate.name === field.enumName
    );
    if (enumDefinition === undefined) {
      context.warnings.push(
        `${label}: enum "${field.enumName}" does not exist in the schema; the column is written as a plain string.`
      );
    } else if (dialect === 'sqlserver') {
      context.warnings.push(
        `${label}: SQL Server has no enum column type; it was written as varchar and the TypeScript enum "${enumDefinition.name}" is only used for typing.`
      );
      return {
        typeEntries: [`type: 'varchar'`],
        tsType: enumDefinition.name,
        dbType: 'varchar',
      };
    } else {
      const enumType: string = dialect === 'sqlite' ? 'simple-enum' : 'enum';
      return {
        typeEntries: [
          `type: ${quote(enumType)}`,
          `enum: ${enumDefinition.name}`,
        ],
        tsType: enumDefinition.name,
        dbType: enumType,
      };
    }
  }

  switch (field.type) {
    case 'string': {
      const entries: string[] = [`type: 'varchar'`];
      if (field.maxLength !== undefined) {
        entries.push(`length: ${field.maxLength}`);
      }
      return { typeEntries: entries, tsType: 'string', dbType: 'varchar' };
    }
    case 'text':
      return {
        typeEntries: [`type: 'text'`],
        tsType: 'string',
        dbType: 'text',
      };
    case 'uuid':
      if (dialect === 'mysql' || dialect === 'sqlite') {
        return {
          typeEntries: [`type: 'varchar'`, 'length: 36'],
          tsType: 'string',
          dbType: 'varchar',
        };
      }
      return dialect === 'sqlserver'
        ? {
            typeEntries: [`type: 'uniqueidentifier'`],
            tsType: 'string',
            dbType: 'uniqueidentifier',
          }
        : { typeEntries: [`type: 'uuid'`], tsType: 'string', dbType: 'uuid' };
    case 'int':
      return { typeEntries: [`type: 'int'`], tsType: 'number', dbType: 'int' };
    case 'bigInt':
      return {
        typeEntries: [`type: 'bigint'`],
        tsType: 'string',
        dbType: 'bigint',
      };
    case 'float':
      return {
        typeEntries: [`type: 'float'`],
        tsType: 'number',
        dbType: 'float',
      };
    case 'decimal': {
      const entries: string[] = [`type: 'decimal'`];
      if (field.maxDigits !== undefined && field.decimalPlaces !== undefined) {
        entries.push(
          `precision: ${field.maxDigits}`,
          `scale: ${field.decimalPlaces}`
        );
      }
      return { typeEntries: entries, tsType: 'string', dbType: 'decimal' };
    }
    case 'boolean': {
      const booleanType: string = dialect === 'sqlserver' ? 'bit' : 'boolean';
      return {
        typeEntries: [`type: '${booleanType}'`],
        tsType: 'boolean',
        dbType: booleanType,
      };
    }
    case 'dateTime': {
      const dateTimeType: string =
        dialect === 'postgres'
          ? 'timestamptz'
          : dialect === 'sqlserver'
            ? 'datetimeoffset'
            : 'datetime';
      return {
        typeEntries: [`type: '${dateTimeType}'`],
        tsType: 'Date',
        dbType: dateTimeType,
      };
    }
    case 'date':
      return {
        typeEntries: [`type: 'date'`],
        tsType: 'string',
        dbType: 'date',
      };
    case 'time':
      return {
        typeEntries: [`type: 'time'`],
        tsType: 'string',
        dbType: 'time',
      };
    case 'json': {
      const jsonType: string =
        dialect === 'postgres'
          ? 'jsonb'
          : dialect === 'mysql'
            ? 'json'
            : 'simple-json';
      return {
        typeEntries: [`type: '${jsonType}'`],
        tsType: 'unknown',
        dbType: jsonType,
      };
    }
    case 'bytes': {
      const bytesType: string =
        dialect === 'postgres'
          ? 'bytea'
          : dialect === 'sqlserver'
            ? 'varbinary'
            : 'blob';
      return {
        typeEntries: [`type: '${bytesType}'`],
        tsType: 'Buffer',
        dbType: bytesType,
      };
    }
    case 'duration':
      if (dialect === 'postgres') {
        return {
          typeEntries: [`type: 'interval'`],
          tsType: 'string',
          dbType: 'interval',
        };
      }
      context.warnings.push(
        `${label}: ${dialect} has no interval type; the duration was written as bigint (microseconds).`
      );
      return {
        typeEntries: [`type: 'bigint'`],
        tsType: 'string',
        dbType: 'bigint',
      };
    case 'ipAddress':
      if (dialect === 'postgres') {
        return {
          typeEntries: [`type: 'inet'`],
          tsType: 'string',
          dbType: 'inet',
        };
      }
      return {
        typeEntries: [`type: 'varchar'`, 'length: 45'],
        tsType: 'string',
        dbType: 'varchar',
      };
    case 'hstore':
      if (dialect === 'postgres') {
        return {
          typeEntries: [`type: 'hstore'`],
          tsType: 'Record<string, string | null>',
          dbType: 'hstore',
        };
      }
      context.warnings.push(
        `${label}: hstore exists only on PostgreSQL; the field was written as ${dialect === 'mysql' ? 'json' : 'simple-json'}.`
      );
      return {
        typeEntries: [
          `type: '${dialect === 'mysql' ? 'json' : 'simple-json'}'`,
        ],
        tsType: 'Record<string, string | null>',
        dbType: dialect === 'mysql' ? 'json' : 'simple-json',
      };
    case 'range':
      if (dialect === 'postgres') {
        const rangeType: string =
          POSTGRES_RANGE_TYPES[field.rangeOf ?? 'int'] ?? 'int4range';
        return {
          typeEntries: [`type: '${rangeType}'`],
          tsType: 'string',
          dbType: rangeType,
        };
      }
      context.warnings.push(
        `${label}: range columns exist only on PostgreSQL; the field was written as varchar.`
      );
      return {
        typeEntries: [`type: 'varchar'`],
        tsType: 'string',
        dbType: 'varchar',
      };
    default:
      context.warnings.push(
        `${label}: unknown field type "${String(field.type)}"; it was written as varchar.`
      );
      return {
        typeEntries: [`type: 'varchar'`],
        tsType: 'string',
        dbType: 'varchar',
      };
  }
}

/** Returns the `default:` option text for a field, or undefined when there is none. */
function defaultEntryOf(
  context: EmitContext,
  label: string,
  field: IrField
): string | undefined {
  const defaultValue: IrDefault | undefined = field.default;
  if (defaultValue === undefined) {
    return undefined;
  }
  const enumDefinition: IrEnum | undefined =
    field.enumName === undefined
      ? undefined
      : context.schema.enums.find(
          (candidate: IrEnum) => candidate.name === field.enumName
        );

  switch (defaultValue.kind) {
    case 'autoIncrement':
      context.warnings.push(
        `${label}: an auto-increment default is only supported on primary keys; it was dropped.`
      );
      return undefined;
    case 'now':
      return `default: () => 'CURRENT_TIMESTAMP'`;
    case 'uuid': {
      const expression: string | undefined =
        context.dialect === 'postgres'
          ? 'gen_random_uuid()'
          : context.dialect === 'mysql'
            ? '(UUID())'
            : context.dialect === 'sqlserver'
              ? 'NEWID()'
              : undefined;
      if (expression === undefined) {
        context.warnings.push(
          `${label}: SQLite has no database-side UUID default; the default was dropped.`
        );
        return undefined;
      }
      return `default: () => ${quote(expression)}`;
    }
    case 'enumValue': {
      const reference: string | undefined =
        enumDefinition === undefined
          ? undefined
          : enumReference(context, enumDefinition, defaultValue.value);
      if (reference === undefined) {
        context.warnings.push(
          `${label}: the enum default "${defaultValue.value}" does not match a member of the enum; it was written as a string.`
        );
        return `default: ${quote(defaultValue.value)}`;
      }
      return `default: ${reference}`;
    }
    case 'literal': {
      if (typeof defaultValue.value === 'string') {
        if (enumDefinition !== undefined) {
          const reference: string | undefined = enumReference(
            context,
            enumDefinition,
            defaultValue.value
          );
          if (reference !== undefined) {
            return `default: ${reference}`;
          }
        }
        if ((field.arrayDepth ?? 0) > 0) {
          if (defaultValue.value !== '[]') {
            return undefined;
          }
          return context.dialect === 'postgres'
            ? `default: () => ${quote(quote('{}'))}`
            : `default: () => ${quote(quote('[]'))}`;
        }
        if (field.type === 'hstore' && defaultValue.value === '{}') {
          return context.dialect === 'postgres'
            ? `default: () => ${quote(quote(''))}`
            : `default: () => ${quote(quote('{}'))}`;
        }
        if (field.type === 'json') {
          return `default: () => ${quote(quote(defaultValue.value))}`;
        }
        if (field.type === 'bytes') {
          context.warnings.push(
            `${label}: a literal default on a binary column cannot be represented; it was dropped.`
          );
          return undefined;
        }
        return `default: ${quote(defaultValue.value)}`;
      }
      return `default: ${String(defaultValue.value)}`;
    }
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// Members
// ---------------------------------------------------------------------------

function isCreatedTimestamp(field: IrField): boolean {
  return (
    field.type === 'dateTime' &&
    !field.isNullable &&
    !field.isAutoUpdated &&
    field.default !== undefined &&
    field.default.kind === 'now' &&
    CREATED_FIELD_PATTERN.test(field.name)
  );
}

function isUpdatedTimestamp(field: IrField): boolean {
  return field.isAutoUpdated && field.type === 'dateTime' && !field.isNullable;
}

function nameEntry(columnName: string, propName: string): string | undefined {
  return columnName === propName ? undefined : `name: ${quote(columnName)}`;
}

function compact(entries: (string | undefined)[]): string[] {
  return entries.filter((entry): entry is string => entry !== undefined);
}

function buildFieldMember(
  context: EmitContext,
  model: IrModel,
  field: IrField,
  propName: string
): Member {
  const label: string = `${model.name}.${field.name}`;
  const spec: ColumnSpec = columnSpecOf(context, label, field);
  if (field.generated !== undefined) {
    context.warnings.push(
      `${label}: the generated column expression ${field.generated.expression} is Python, not SQL, and has no TypeORM equivalent; ` +
        `the property was written as a regular column.`
    );
  }
  const nameOption: string | undefined = nameEntry(field.columnName, propName);
  const inCompositeKey: boolean =
    model.compositePrimaryKey?.includes(field.name) ?? false;
  const nullableSuffix: string = field.isNullable ? ' | null' : '';
  const property: string = `  ${propName}!: ${spec.tsType}${nullableSuffix};`;

  if (field.isAutoUpdated && !isUpdatedTimestamp(field)) {
    context.warnings.push(
      `${label}: an auto-updated timestamp must be a non-null date-time column to become @UpdateDateColumn; it was written as a plain column.`
    );
  }

  if (field.isPrimaryKey || inCompositeKey) {
    const generated: IrDefault | undefined = field.default;
    if (
      field.isPrimaryKey &&
      !inCompositeKey &&
      generated !== undefined &&
      generated.kind === 'autoIncrement' &&
      (field.type === 'int' || field.type === 'bigInt')
    ) {
      const options: string[] = compact([
        nameOption,
        field.type === 'bigInt' ? `type: 'bigint'` : undefined,
      ]);
      return {
        lines: [
          ...decorator(
            use(context, 'PrimaryGeneratedColumn'),
            [`'increment'`],
            options
          ),
          property,
        ],
      };
    }
    if (
      field.isPrimaryKey &&
      !inCompositeKey &&
      generated !== undefined &&
      generated.kind === 'uuid' &&
      field.type === 'uuid' &&
      context.dialect !== 'sqlite'
    ) {
      return {
        lines: [
          ...decorator(
            use(context, 'PrimaryGeneratedColumn'),
            [`'uuid'`],
            compact([nameOption])
          ),
          property,
        ],
      };
    }
    const entries: string[] = compact([
      nameOption,
      ...spec.typeEntries,
      defaultEntryOf(context, label, field),
    ]);
    return {
      lines: [
        ...decorator(use(context, 'PrimaryColumn'), [], entries),
        property,
      ],
    };
  }

  if (isUpdatedTimestamp(field)) {
    return {
      lines: [
        ...decorator(
          use(context, 'UpdateDateColumn'),
          [],
          compact([nameOption, ...spec.typeEntries])
        ),
        property,
      ],
    };
  }
  if (isCreatedTimestamp(field)) {
    return {
      lines: [
        ...decorator(
          use(context, 'CreateDateColumn'),
          [],
          compact([nameOption, ...spec.typeEntries])
        ),
        property,
      ],
    };
  }

  const entries: string[] = compact([
    nameOption,
    ...spec.typeEntries,
    field.isNullable ? 'nullable: true' : undefined,
    field.isUnique ? 'unique: true' : undefined,
    defaultEntryOf(context, label, field),
  ]);
  return {
    lines: [...decorator(use(context, 'Column'), [], entries), property],
  };
}

interface KeyInfo {
  /** Property name of the referenced column on the target entity. */
  property: string;
  spec: ColumnSpec;
}

/** Resolves the target column of a relation: an explicit to_field, otherwise the primary key. */
function referencedKey(
  context: EmitContext,
  label: string,
  target: IrModel,
  toField: string | undefined,
  depth: number = 0
): KeyInfo | undefined {
  if (depth > 5) {
    return undefined;
  }
  const targetNames: ModelNames = namesOf(context, target);
  const explicit: IrField | undefined =
    toField === undefined
      ? undefined
      : target.fields.find((field: IrField) => field.name === toField);
  const column: IrField | undefined =
    explicit ?? target.fields.find((field: IrField) => field.isPrimaryKey);
  if (column !== undefined) {
    return {
      property: targetNames.fields.get(column.name) ?? column.name,
      spec: columnSpecOf(context, label, column),
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
    const chainedKey: KeyInfo | undefined =
      chained === undefined
        ? undefined
        : referencedKey(
            context,
            label,
            chained,
            primaryRelation.toField,
            depth + 1
          );
    if (chainedKey !== undefined) {
      return {
        property:
          targetNames.scalars.get(primaryRelation.name) ?? chainedKey.property,
        spec: chainedKey.spec,
      };
    }
  }
  return undefined;
}

/** Column name of the first primary key property of a model, for join tables. */
function primaryKeyProperty(
  context: EmitContext,
  model: IrModel
): string | undefined {
  const primary: IrField | undefined = model.fields.find(
    (field: IrField) => field.isPrimaryKey
  );
  return primary === undefined
    ? undefined
    : namesOf(context, model).fields.get(primary.name);
}

function buildForwardMembers(
  context: EmitContext,
  model: IrModel,
  inverseMembers: Map<string, Member[]>
): Member[] {
  const members: Member[] = [];
  const names: ModelNames = namesOf(context, model);

  for (const field of model.fields) {
    members.push(
      buildFieldMember(
        context,
        model,
        field,
        names.fields.get(field.name) ?? field.name
      )
    );
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
      addManyToMany(context, model, relation, target, members, inverseMembers);
    } else {
      addSingleRelation(
        context,
        model,
        relation,
        target,
        members,
        inverseMembers
      );
    }
  }
  return members;
}

function addInverse(
  inverseMembers: Map<string, Member[]>,
  targetName: string,
  member: Member
): void {
  const existing: Member[] = inverseMembers.get(targetName) ?? [];
  existing.push(member);
  inverseMembers.set(targetName, existing);
}

function addSingleRelation(
  context: EmitContext,
  model: IrModel,
  relation: IrRelation,
  target: IrModel,
  members: Member[],
  inverseMembers: Map<string, Member[]>
): void {
  const label: string = `${model.name}.${relation.name}`;
  const names: ModelNames = namesOf(context, model);
  const relationProp: string =
    names.relations.get(relation.name) ?? relation.name;
  const inverseProp: string =
    context.inverseNames.get(label) ?? toSnakeCase(model.name);
  const keyed: boolean = isKeyedRelation(model, relation);

  const needsKey: boolean = keyed || relation.toField !== undefined;
  const key: KeyInfo | undefined = needsKey
    ? referencedKey(context, label, target, relation.toField)
    : undefined;
  if (needsKey && key === undefined) {
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

  const scalarProp: string | undefined = names.scalars.get(relation.name);
  if (keyed && key !== undefined && scalarProp !== undefined) {
    members.push({
      lines: [
        ...decorator(
          use(context, 'PrimaryColumn'),
          [],
          compact([
            `name: ${quote(relation.columnName)}`,
            ...key.spec.typeEntries,
          ])
        ),
        `  ${scalarProp}!: ${key.spec.tsType};`,
      ],
    });
  }

  const decoratorName: string =
    relation.kind === 'oneToOne' ? 'OneToOne' : 'ManyToOne';
  const options: string[] = [
    `onDelete: ${quote(ON_DELETE_NAMES[relation.onDelete])}`,
    `nullable: ${relation.isNullable ? 'true' : 'false'}`,
  ];
  const joinEntries: string[] = compact([
    `name: ${quote(relation.columnName)}`,
    key !== undefined && relation.toField !== undefined
      ? `referencedColumnName: ${quote(key.property)}`
      : undefined,
  ]);
  const relationType: string = `${use(context, 'Relation')}<${target.name}>${
    relation.isNullable ? ' | null' : ''
  }`;
  members.push({
    lines: [
      ...decorator(
        use(context, decoratorName),
        [`() => ${target.name}`, `(entity) => entity.${inverseProp}`],
        options
      ),
      ...decorator(use(context, 'JoinColumn'), [], joinEntries),
      `  ${relationProp}!: ${relationType};`,
    ],
  });

  if (relation.kind === 'oneToOne') {
    addInverse(inverseMembers, target.name, {
      lines: [
        ...decorator(
          use(context, 'OneToOne'),
          [`() => ${model.name}`, `(entity) => entity.${relationProp}`],
          []
        ),
        `  ${inverseProp}!: ${use(context, 'Relation')}<${model.name}> | null;`,
      ],
    });
  } else {
    addInverse(inverseMembers, target.name, {
      lines: [
        ...decorator(
          use(context, 'OneToMany'),
          [`() => ${model.name}`, `(entity) => entity.${relationProp}`],
          []
        ),
        `  ${inverseProp}!: ${model.name}[];`,
      ],
    });
  }
}

function addManyToMany(
  context: EmitContext,
  model: IrModel,
  relation: IrRelation,
  target: IrModel,
  members: Member[],
  inverseMembers: Map<string, Member[]>
): void {
  const label: string = `${model.name}.${relation.name}`;
  const names: ModelNames = namesOf(context, model);
  const relationProp: string =
    names.relations.get(relation.name) ?? relation.name;
  const inverseProp: string =
    context.inverseNames.get(label) ?? `${toSnakeCase(model.name)}_set`;

  const ownerSnake: string = toSnakeCase(model.name);
  const targetSnake: string = toSnakeCase(target.name);
  const isSelfReference: boolean = model.name === target.name;
  const ownerColumn: string = `${
    isSelfReference ? 'from_' : ''
  }${ownerSnake}_id`;
  const targetColumn: string = `${isSelfReference ? 'to_' : ''}${targetSnake}_id`;
  const ownerKey: string | undefined = primaryKeyProperty(context, model);
  const targetKey: string | undefined = primaryKeyProperty(context, target);

  const joinColumn: string[] = compact([
    `name: ${quote(ownerColumn)}`,
    ownerKey === undefined
      ? undefined
      : `referencedColumnName: ${quote(ownerKey)}`,
  ]);
  const inverseJoinColumn: string[] = compact([
    `name: ${quote(targetColumn)}`,
    targetKey === undefined
      ? undefined
      : `referencedColumnName: ${quote(targetKey)}`,
  ]);
  members.push({
    lines: [
      ...decorator(
        use(context, 'ManyToMany'),
        [`() => ${target.name}`, `(entity) => entity.${inverseProp}`],
        []
      ),
      ...decorator(
        use(context, 'JoinTable'),
        [],
        [
          `name: ${quote(`${model.tableName}_${relation.name}`)}`,
          `joinColumn: { ${joinColumn.join(', ')} }`,
          `inverseJoinColumn: { ${inverseJoinColumn.join(', ')} }`,
        ]
      ),
      `  ${relationProp}!: ${target.name}[];`,
    ],
  });
  addInverse(inverseMembers, target.name, {
    lines: [
      ...decorator(
        use(context, 'ManyToMany'),
        [`() => ${model.name}`, `(entity) => entity.${relationProp}`],
        []
      ),
      `  ${inverseProp}!: ${model.name}[];`,
    ],
  });
}

// ---------------------------------------------------------------------------
// Classes
// ---------------------------------------------------------------------------

function resolveIndexProperty(
  context: EmitContext,
  model: IrModel,
  fieldName: string
): string {
  const names: ModelNames = namesOf(context, model);
  const relation: IrRelation | undefined =
    model.relations.find(
      (candidate: IrRelation) => candidate.name === fieldName
    ) ??
    model.relations.find(
      (candidate: IrRelation) =>
        candidate.kind !== 'manyToMany' && candidate.columnName === fieldName
    );
  if (relation !== undefined) {
    return names.relations.get(relation.name) ?? fieldName;
  }
  const field: IrField | undefined =
    model.fields.find((candidate: IrField) => candidate.name === fieldName) ??
    model.fields.find(
      (candidate: IrField) => candidate.columnName === fieldName
    );
  if (field !== undefined) {
    return names.fields.get(field.name) ?? fieldName;
  }
  context.warnings.push(
    `${model.name}: an index references "${fieldName}", which is not a field of the model; it was written as-is.`
  );
  return propertyName(context, fieldName);
}

function indexDecorator(
  context: EmitContext,
  model: IrModel,
  index: IrIndex
): string[] {
  const properties: string = `[${index.fields
    .map((fieldName: string) =>
      quote(resolveIndexProperty(context, model, fieldName))
    )
    .join(', ')}]`;
  const args: string[] =
    index.name === undefined ? [properties] : [quote(index.name), properties];
  return decorator(
    use(context, index.isUnique ? 'Unique' : 'Index'),
    args,
    [],
    ''
  );
}

function emitClass(
  context: EmitContext,
  model: IrModel,
  members: Member[]
): string {
  const hasPrimaryKey: boolean =
    model.fields.some((field: IrField) => field.isPrimaryKey) ||
    model.relations.some(
      (relation: IrRelation) => relation.isPrimaryKey === true
    ) ||
    (model.compositePrimaryKey !== undefined &&
      model.compositePrimaryKey.length > 0);
  if (!hasPrimaryKey) {
    context.warnings.push(
      `${model.name}: the model has no primary key; TypeORM requires at least one primary column.`
    );
  }

  const header: string[] = [
    ...decorator(use(context, 'Entity'), [quote(model.tableName)], [], ''),
  ];
  for (const index of model.indexes) {
    header.push(...indexDecorator(context, model, index));
  }

  const body: string[] = members.flatMap((member: Member, position: number) =>
    position === 0 ? member.lines : ['', ...member.lines]
  );
  return [...header, `export class ${model.name} {`, ...body, '}'].join('\n');
}
