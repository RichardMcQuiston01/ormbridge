import type {
  IrDefault,
  IrEnum,
  IrEnumValue,
  IrField,
  IrScalarType,
} from '../ir.js';
import { toCamelCase } from '../naming.js';
import {
  parseTypeText,
  type CsClass,
  type CsEnum,
  type CsType,
  type CsValue,
} from './csharpSyntax.js';
import type {
  EntityInfo,
  Project,
  PropConfig,
  ScalarMember,
} from './efcoreModel.js';
import { isNullableMember } from './efcoreRelations.js';
import {
  clrColumn,
  sqlColumn,
  sqlDefault,
  type ColumnShape,
} from './efcoreTypes.js';

/** The IR field of a column, with the enum it uses (if any). */
export interface BuiltField {
  field: IrField;
  member: ScalarMember;
  enumDefinition?: IrEnum;
}

export interface FieldContext {
  project: Project;
  info: EntityInfo;
  /** Property names that make up the primary key of the entity. */
  keyNames: readonly string[];
  warn: (message: string) => void;
}

const INTEGER_TYPES: ReadonlySet<string> = new Set([
  'int',
  'Int32',
  'uint',
  'UInt32',
  'short',
  'Int16',
  'ushort',
  'UInt16',
  'byte',
  'Byte',
  'sbyte',
  'SByte',
  'long',
  'Int64',
  'ulong',
  'UInt64',
]);

/** The IR name of a mapped property: `PublicId` is `publicId`, an owned `Address.Street` is `addressStreet`. */
export function irFieldName(member: ScalarMember): string {
  return toCamelCase(member.path.replace(/\./g, '_'));
}

/** The database column name: the configured name, or the property name with owned prefixes (`Address_Street`). */
export function columnNameOf(member: ScalarMember): string {
  return (
    member.config.column ?? `${member.prefix.replace(/\./g, '_')}${member.name}`
  );
}

function buildEnum(
  definition: CsEnum,
  stringStored: boolean,
  stored: ReadonlyMap<string, string> = new Map()
): IrEnum {
  const values: IrEnumValue[] = definition.members.map(
    (value, index): IrEnumValue => ({
      name: value.name,
      dbValue: stringStored
        ? (stored.get(value.name) ?? value.name)
        : String(value.value ?? index),
    })
  );
  return { name: definition.name, values };
}

/**
 * Reads the stored values of an enum from a value converter class of the input: a `ValueConverter<TEnum, string>`
 * whose conversion is written as switch arms (`"draft" => PostStatus.Draft`), the shape ormbridge writes.
 * Returns the stored string by member name, or undefined when the class is not such a converter.
 */
function converterValues(
  project: Project,
  className: string,
  definition: CsEnum
): Map<string, string> | undefined {
  const converter: CsClass | undefined = project.classes.get(className);
  const isEnumConverter: boolean =
    converter?.bases.some(
      (base: CsType) =>
        base.name === 'ValueConverter' &&
        base.args[0]?.name === definition.name &&
        base.args[1]?.name === 'string'
    ) ?? false;
  if (converter === undefined || !isEnumConverter) {
    return undefined;
  }
  const stored: Map<string, string> = new Map();
  const arm: RegExp = /"((?:[^"\\]|\\.)*)"\s*=>\s*(?:\w+\.)*(\w+)\s*[,;]/g;
  for (const method of converter.methods) {
    for (const match of method.node.text.matchAll(arm)) {
      const value: string = (match[1] ?? '').replace(/\\(.)/g, '$1');
      const member: string = match[2] ?? '';
      if (definition.members.some((item) => item.name === member)) {
        stored.set(member, value);
      }
    }
  }
  return definition.members.every((item) => stored.has(item.name))
    ? stored
    : undefined;
}

/** Maps a configured default (HasDefaultValue) to an IR default, with a warning when it cannot be read. */
function valueDefault(
  value: CsValue,
  type: IrScalarType,
  definition: CsEnum | undefined,
  stringStored: boolean,
  place: string,
  warn: (message: string) => void
): IrDefault | undefined {
  switch (value.kind) {
    case 'string':
      if (definition !== undefined) {
        return definition.members.some((item) => item.name === value.value)
          ? { kind: 'enumValue', value: value.value }
          : { kind: 'literal', value: value.value };
      }
      return { kind: 'literal', value: value.value };
    case 'number': {
      if (definition !== undefined && !stringStored) {
        const member = definition.members.find(
          (item) => item.value === value.value
        );
        if (member !== undefined) {
          return { kind: 'enumValue', value: member.name };
        }
      }
      return { kind: 'literal', value: value.value };
    }
    case 'bool':
      return { kind: 'literal', value: value.value };
    case 'null':
      return undefined;
    case 'member': {
      const last: string = value.path[value.path.length - 1] ?? '';
      if (definition !== undefined) {
        return definition.members.some((item) => item.name === last)
          ? { kind: 'enumValue', value: last }
          : undefined;
      }
      if (
        value.path.length >= 2 &&
        /^(DateTime|DateTimeOffset|DateOnly)$/.test(
          value.path[value.path.length - 2] ?? ''
        ) &&
        /^(Now|UtcNow|Today)$/.test(last)
      ) {
        return { kind: 'now' };
      }
      break;
    }
    case 'other':
      if (/Guid\.NewGuid\(\)/.test(value.text) && type === 'uuid') {
        return { kind: 'uuid' };
      }
      if (/^(DateTime|DateTimeOffset)\.(UtcNow|Now)$/.test(value.text)) {
        return { kind: 'now' };
      }
      break;
    default:
      break;
  }
  warn(
    `${place}: the default value expression "${value.kind === 'other' ? value.text : value.kind}" cannot be evaluated statically and was dropped.`
  );
  return undefined;
}

/** Builds the IR field of one mapped column. */
export function buildField(
  member: ScalarMember,
  ctx: FieldContext,
  enumDefinitions: ReadonlyMap<string, CsEnum>
): BuiltField {
  const place: string = `${ctx.info.name}.${member.path}`;
  const config: PropConfig = member.config;
  const type: CsType = member.type;
  const definition: CsEnum | undefined = enumDefinitions.get(type.name);
  const enumNames: ReadonlySet<string> = new Set(enumDefinitions.keys());
  const isKey: boolean = ctx.keyNames.includes(member.path);

  let shape: ColumnShape | undefined;
  let enumDefinition: IrEnum | undefined;
  let stringStored: boolean = false;
  let conversion: string | undefined = config.conversion;
  let storedValues: Map<string, string> | undefined;
  if (
    config.customConversion === true &&
    config.converterClass !== undefined &&
    definition !== undefined &&
    type.arrayDepth === 0
  ) {
    storedValues = converterValues(
      ctx.project,
      config.converterClass,
      definition
    );
    if (storedValues !== undefined) {
      conversion = 'string';
    }
  }

  if (config.customConversion === true && storedValues === undefined) {
    ctx.warn(
      `${place}: a custom value converter is not evaluated; the column was read from the property type ${type.text}.`
    );
  }
  if (definition !== undefined && type.arrayDepth === 0) {
    stringStored = conversion === 'string';
    if (conversion !== undefined && conversion !== 'string') {
      shape = clrColumn(parseTypeText(conversion));
    }
    const integerType: IrScalarType =
      shape?.type === 'bigInt' ? 'bigInt' : 'int';
    shape = stringStored ? { type: 'string' } : { type: integerType };
    enumDefinition = buildEnum(definition, stringStored, storedValues);
    if (!stringStored) {
      ctx.warn(
        `${place}: the enum ${definition.name} is stored as an integer by EF Core; it is read as an enum with the numbers as values, and writers that create enum types will store text instead. Add HasConversion<string>() to store the names.`
      );
    }
  } else if (conversion !== undefined && !(conversion === type.name)) {
    shape = clrColumn(parseTypeText(conversion));
    ctx.warn(
      `${place}: the value converter stores ${type.text} as ${conversion}; the column was read as ${conversion}.`
    );
  } else {
    shape = clrColumn(type);
  }

  if (config.columnType !== undefined) {
    const fromSql: ColumnShape | undefined = sqlColumn(config.columnType);
    if (fromSql === undefined) {
      ctx.warn(
        `${place}: the column type "${config.columnType}" is not recognised; the column was read from the property type ${type.text}.`
      );
    } else if (definition === undefined) {
      shape = {
        ...fromSql,
        ...(shape?.arrayDepth === undefined || fromSql.arrayDepth !== undefined
          ? {}
          : { arrayDepth: shape.arrayDepth }),
      };
    }
  }
  if (type.name === 'Dictionary' || type.name === 'IDictionary') {
    ctx.warn(
      `${place}: a ${type.name} property maps to a PostgreSQL hstore column (Npgsql only); it was read as an hstore column.`
    );
  }
  if (member.isJson === true) {
    shape = { type: 'json' };
  }
  if (shape === undefined) {
    shape = { type: 'unsupported', unsupportedType: type.text };
    ctx.warn(
      `${place}: the type ${type.text} has no column type in the shared model; the column is read as unsupported (${type.text}).`
    );
  }

  // Lengths and precision -------------------------------------------------------------------
  let irType: IrScalarType = shape.type;
  let maxLength: number | undefined = shape.maxLength;
  if (
    config.maxLength !== undefined &&
    (irType === 'text' || irType === 'string')
  ) {
    irType = 'string';
    maxLength = config.maxLength;
  }
  let maxDigits: number | undefined = shape.maxDigits;
  let decimalPlaces: number | undefined = shape.decimalPlaces;
  if (irType === 'decimal' && config.precision !== undefined) {
    maxDigits = config.precision;
    decimalPlaces = config.scale ?? 0;
  }

  // Nullability -------------------------------------------------------------------------------
  let isNullable: boolean = isNullableMember(
    member,
    ctx.info.nullableRefs,
    enumNames
  );
  if (member.forceNullable) {
    isNullable = true;
  }
  if (isKey) {
    isNullable = false;
  }

  // Defaults and generated values ---------------------------------------------------------------
  let defaultValue: IrDefault | undefined;
  let generated: IrField['generated'];
  let isAutoUpdated: boolean = false;
  if (config.computedSql !== undefined) {
    generated = {
      expression: config.computedSql,
      isStored: config.computedStored === true,
    };
  } else if (config.generated === 'onAddOrUpdate' && irType !== 'dateTime') {
    ctx.warn(
      `${place}: the column is computed or generated on update by the database, but no expression was given; it was read as an ordinary column.`
    );
  }
  if (config.generated === 'onAddOrUpdate' && irType === 'dateTime') {
    isAutoUpdated = config.computedSql === undefined;
  }
  if (generated === undefined) {
    if (config.defaultValue !== undefined) {
      defaultValue = valueDefault(
        config.defaultValue,
        irType,
        definition,
        stringStored,
        place,
        ctx.warn
      );
    } else if (config.defaultSql !== undefined) {
      defaultValue = sqlDefault(config.defaultSql, irType);
      if (
        definition !== undefined &&
        defaultValue.kind === 'literal' &&
        typeof defaultValue.value === 'string'
      ) {
        const text: string = defaultValue.value;
        const found: IrEnumValue | undefined = enumDefinition?.values.find(
          (item) => item.dbValue === text
        );
        defaultValue =
          found === undefined
            ? defaultValue
            : { kind: 'enumValue', value: found.name };
      }
    }
  }
  const isInteger: boolean =
    (irType === 'int' || irType === 'bigInt') &&
    INTEGER_TYPES.has(type.name) &&
    shape.arrayDepth === undefined;
  if (defaultValue === undefined && generated === undefined) {
    const isOnlyKey: boolean = isKey && ctx.keyNames.length === 1;
    if (isInteger && config.generated !== 'never') {
      if (config.generated === 'onAdd' || isOnlyKey) {
        defaultValue = { kind: 'autoIncrement' };
      }
    } else if (irType === 'uuid' && isOnlyKey && config.generated !== 'never') {
      // EF Core generates Guid keys on the client.
      defaultValue = { kind: 'uuid' };
    }
  }

  const field: IrField = {
    name: irFieldName(member),
    columnName: columnNameOf(member),
    type: irType,
    isPrimaryKey: isKey && ctx.keyNames.length === 1,
    isUnique: false,
    isNullable,
    isAutoUpdated,
    ...(defaultValue === undefined ? {} : { default: defaultValue }),
    ...(maxLength === undefined || irType !== 'string' ? {} : { maxLength }),
    ...(irType === 'decimal' && maxDigits !== undefined ? { maxDigits } : {}),
    ...(irType === 'decimal' && decimalPlaces !== undefined
      ? { decimalPlaces }
      : {}),
    ...(shape.arrayDepth === undefined ? {} : { arrayDepth: shape.arrayDepth }),
    ...(enumDefinition === undefined ? {} : { enumName: enumDefinition.name }),
    ...(irType === 'unsupported' && shape.unsupportedType !== undefined
      ? { unsupportedType: shape.unsupportedType }
      : {}),
    ...(generated === undefined ? {} : { generated }),
  };
  return {
    field,
    member,
    ...(enumDefinition === undefined ? {} : { enumDefinition }),
  };
}
