import type { IrDefault, IrEnum, IrField, IrScalarType } from '../ir.js';
import { toCamelCase } from '../naming.js';
import { sqlColumn, sqlDefault, type ColumnShape } from './efcoreTypes.js';
import type { Ann, Annotated } from './jpaAnnotations.js';
import type { ConverterInfo, EntityInfo, Member, Project } from './jpaModel.js';
import {
  isIntegerType,
  isPrimitive,
  javaColumn,
  jdbcTypeColumn,
  temporalColumn,
} from './jpaTypes.js';
import type { JavaClass, JavaType, JavaValue } from './javaSyntax.js';
import { evaluate } from './javaValues.js';

/** What building a column needs to know. */
export interface ColumnContext {
  project: Project;
  entity: EntityInfo;
  warn: (message: string) => void;
}

/** An IR field with the member it came from. */
export interface BuiltField {
  field: IrField;
  member: Member;
  enumDefinition?: IrEnum;
  /** True when the attribute is part of the natural id (`@NaturalId`). */
  naturalId: boolean;
  /** True for `@Column(insertable = false, updatable = false)`: a second mapping of a column. */
  readOnly: boolean;
}

/** The IR name of a member: `address.street` is `addressStreet`. */
export function irFieldName(member: Member): string {
  return toCamelCase(member.path.join('_'));
}

/** Removes the backticks and quotes that make an identifier case-sensitive: `` `Order` `` is `Order`. */
export function cleanIdentifier(name: string): string {
  return name.replace(/^[`"[]|[`"\]]$/g, '');
}

/** The database column name: `@Column(name)`, else the attribute name. */
export function columnNameOf(member: Member): string {
  const given: string | undefined = member.column?.string('name');
  return given === undefined || given === ''
    ? (member.path[member.path.length - 1] ?? member.attr.name)
    : cleanIdentifier(given);
}

function converterFor(
  member: Member,
  ctx: ColumnContext
): ConverterInfo | undefined {
  const notes: Annotated = member.attr.notes;
  const convert: Ann | undefined = notes.get('Convert');
  if (convert?.boolean('disableConversion') === true) {
    return undefined;
  }
  const named: string | undefined = convert?.className('converter');
  if (named !== undefined) {
    return (
      ctx.project.converters.get(named) ?? {
        name: named,
        attributeType: member.attr.type,
        columnType: { name: '', text: '', args: [], arrayDepth: 0 },
        autoApply: false,
      }
    );
  }
  if (notes.has('Id') || notes.has('Version') || notes.has('Enumerated')) {
    return undefined;
  }
  for (const converter of ctx.project.converters.values()) {
    if (
      converter.autoApply &&
      converter.attributeType.name === member.attr.type.name &&
      converter.attributeType.arrayDepth === member.attr.type.arrayDepth
    ) {
      return converter;
    }
  }
  return undefined;
}

function enumDefinition(definition: JavaClass, stringStored: boolean): IrEnum {
  return {
    name: definition.name,
    values: definition.enumConstants.map((constant, index) => ({
      name: constant.name,
      dbValue: stringStored ? constant.name : String(index),
    })),
  };
}

/** The stored values of an enum written with a converter: the constants' arguments (`DRAFT("draft")`). */
interface ConvertedEnum {
  values: string[];
  numeric: boolean;
}

/**
 * Reads an enum that an `AttributeConverter<Enum, String|Integer>` stores under other values than its names, the
 * way ormbridge writes it: every constant carries its stored value as the only constructor argument. The converter
 * is not run, so any other shape (a converter that computes the value) is not understood and returns undefined.
 */
function convertedEnum(
  member: Member,
  definition: JavaClass,
  ctx: ColumnContext
): ConvertedEnum | undefined {
  const named: string | undefined = member.attr.notes
    .get('Convert')
    ?.className('converter');
  const converter: ConverterInfo | undefined =
    named === undefined ? undefined : ctx.project.converters.get(named);
  if (
    converter === undefined ||
    converter.attributeType.name !== definition.name
  ) {
    return undefined;
  }
  const numeric: boolean = /^(int|Integer|long|Long|short|Short)$/.test(
    converter.columnType.name
  );
  if (!numeric && converter.columnType.name !== 'String') {
    return undefined;
  }
  const values: string[] = [];
  for (const constant of definition.enumConstants) {
    const only = constant.args.length === 1 ? constant.args[0] : undefined;
    const value: JavaValue | undefined =
      only === undefined ? undefined : evaluate(only, ctx.project.lookup);
    if (numeric && value?.kind === 'number') {
      values.push(String(value.value));
    } else if (!numeric && value?.kind === 'string') {
      values.push(value.value);
    } else {
      return undefined;
    }
  }
  return { values, numeric };
}

/** Reads `default ...` out of a `columnDefinition` such as `varchar(20) not null default 'x'`. */
function definitionParts(definition: string): {
  type: string;
  defaultText?: string;
  notNull: boolean;
  unique: boolean;
} {
  const defaultMatch: RegExpMatchArray | null = definition.match(
    /\bdefault\s+('(?:[^']|'')*'|\([^)]*\)|[^\s,]+)/i
  );
  const type: string = definition
    .replace(/\bdefault\s+('(?:[^']|'')*'|\([^)]*\)|[^\s,]+)/gi, ' ')
    .replace(
      /\b(not null|null|unique|primary key|auto_increment|autoincrement|check\s*\(.*\)|generated\b.*|comment\s+'[^']*')/gi,
      ' '
    )
    .replace(/\s+/g, ' ')
    .trim();
  return {
    type,
    ...(defaultMatch?.[1] === undefined
      ? {}
      : { defaultText: defaultMatch[1] }),
    notNull: /\bnot\s+null\b/i.test(definition),
    unique: /\bunique\b/i.test(definition),
  };
}

/** Bean Validation hints, in the order Hibernate applies them: `@Size`/`@Length` for the length, `@NotNull` for nullability. */
function validationLength(notes: Annotated): number | undefined {
  const size: number | undefined = notes.get('Size')?.number('max');
  const length: number | undefined = notes.get('Length', true)?.number('max');
  const found: number | undefined = size ?? length;
  return found !== undefined && found < 2_000_000_000 ? found : undefined;
}

function isDeclaredNotNull(notes: Annotated): boolean {
  // Hibernate turns @NotNull into NOT NULL; @NotEmpty and @NotBlank add nothing to the DDL (checked against 6.4).
  return (
    notes.has('NotNull') || notes.get('Basic')?.boolean('optional') === false
  );
}

/** Builds the IR field for one mapped column. */
export function buildField(
  member: Member,
  ctx: ColumnContext,
  singleKey: boolean
): BuiltField {
  const attribute = member.attr;
  const notes: Annotated = attribute.notes;
  const type: JavaType = attribute.type;
  const column: Ann | undefined = member.column;
  const place: string = `${ctx.entity.name}.${member.path.join('.')}`;
  const definitionText: string | undefined = column?.string('columnDefinition');
  const definition =
    definitionText === undefined || definitionText === ''
      ? undefined
      : definitionParts(definitionText);

  let shape: ColumnShape | undefined;
  let enumDef: IrEnum | undefined;
  let fromJavaType: boolean = false;
  const enumClass: JavaClass | undefined =
    type.arrayDepth === 0 ? ctx.project.enums.get(type.name) : undefined;
  const converter: ConverterInfo | undefined =
    enumClass === undefined ? converterFor(member, ctx) : undefined;
  const converted: ConvertedEnum | undefined =
    enumClass === undefined ? undefined : convertedEnum(member, enumClass, ctx);
  const jdbc: Ann | undefined = notes.get('JdbcTypeCode', true);
  const hibernateType: Ann | undefined = notes.get('Type', true);

  if (converter !== undefined) {
    const target: JavaType = converter.columnType;
    shape =
      target.name === '' ? undefined : javaColumn(target, attribute.imports);
    ctx.warn(
      `${place}: the converter ${converter.name} is not run; ${
        shape === undefined
          ? 'its column type is not known'
          : `the column was read as ${target.name}`
      }.`
    );
  } else if (enumClass !== undefined && converted !== undefined) {
    enumDef = {
      name: enumClass.name,
      values: enumClass.enumConstants.map((constant, index) => ({
        name: constant.name,
        dbValue: converted.values[index] ?? constant.name,
      })),
    };
    shape = converted.numeric
      ? { type: 'int' }
      : { type: 'string', maxLength: 255 };
  } else if (enumClass !== undefined) {
    const mode: string | undefined = notes.get('Enumerated')?.member('value');
    const stringStored: boolean = mode === 'STRING';
    enumDef = enumDefinition(enumClass, stringStored);
    shape = stringStored ? { type: 'string', maxLength: 255 } : { type: 'int' };
    if (!stringStored) {
      ctx.warn(
        `${place}: the enum ${enumClass.name} is stored as its ordinal number (the default of @Enumerated); it was read as an enum with the numbers as values, and writers that create enum types will store text instead. Use @Enumerated(EnumType.STRING) to store the names.`
      );
    }
  } else if (jdbc !== undefined) {
    const code: string | undefined = jdbc.member('value');
    shape = code === undefined ? undefined : jdbcTypeColumn(code);
    if (shape === undefined) {
      ctx.warn(
        `${place}: @JdbcTypeCode(${code ?? '?'}) is not one the model knows; the column was read from the Java type ${type.text}.`
      );
    }
  } else if (hibernateType !== undefined) {
    const named: string = hibernateType.className('value') ?? '';
    if (/json/i.test(named)) {
      shape = { type: 'json' };
    } else {
      ctx.warn(
        `${place}: @Type(${named}) is a custom type and is not run; the column was read from the Java type ${type.text}.`
      );
    }
  }
  if (shape === undefined && notes.has('Lob')) {
    if (/^(byte|Byte)$/.test(type.name) || type.name === 'Blob') {
      shape = { type: 'bytes' };
    } else if (
      type.name === 'String' ||
      /^(char|Character|Clob)$/.test(type.name)
    ) {
      shape = { type: 'text' };
    } else {
      shape = { type: 'bytes' };
    }
  }
  if (
    shape === undefined &&
    enumClass === undefined &&
    converter === undefined
  ) {
    const temporal: string | undefined = notes.get('Temporal')?.member('value');
    if (temporal !== undefined && /^(Date|Calendar)$/.test(type.name)) {
      shape = temporalColumn(temporal);
    }
    if (shape === undefined) {
      shape = javaColumn(type, attribute.imports);
      fromJavaType = shape !== undefined;
    }
  }
  if (
    definition !== undefined &&
    definition.type !== '' &&
    enumClass === undefined
  ) {
    const fromSql: ColumnShape | undefined = sqlColumn(definition.type);
    if (fromSql === undefined) {
      ctx.warn(
        `${place}: the columnDefinition "${definitionText ?? ''}" was not understood; the column was read from the Java type ${type.text}.`
      );
    } else {
      shape = fromSql;
    }
  }
  if (shape === undefined) {
    shape = { type: 'unsupported', unsupportedType: type.text };
    ctx.warn(
      `${place}: the type ${type.text} has no column type in the shared model (add @Convert, @JdbcTypeCode or @Embedded); the column is read as unsupported (${type.text}).`
    );
  }

  // Lengths, precision and scale ---------------------------------------------------------------
  let irType: IrScalarType = shape.type;
  let maxLength: number | undefined = shape.maxLength;
  const declaredLength: number | undefined = column?.number('length');
  const hinted: number | undefined = validationLength(notes);
  if (irType === 'string') {
    if (declaredLength !== undefined) {
      maxLength = declaredLength;
    } else if (shape.maxLength === 255 || shape.maxLength === undefined) {
      maxLength = definition !== undefined ? shape.maxLength : (hinted ?? 255);
    }
  }
  if (irType === 'text' && declaredLength !== undefined && !notes.has('Lob')) {
    irType = 'string';
    maxLength = declaredLength;
  }
  let maxDigits: number | undefined = shape.maxDigits;
  let decimalPlaces: number | undefined = shape.decimalPlaces;
  if (irType === 'decimal' && fromJavaType) {
    const precision: number | undefined = column?.number('precision');
    const scale: number | undefined = column?.number('scale');
    const digits: Ann | undefined = notes.get('Digits');
    if (precision !== undefined && precision > 0) {
      maxDigits = precision;
      decimalPlaces = scale ?? 0;
    } else if (scale !== undefined && scale > 0) {
      decimalPlaces = scale;
    } else if (digits !== undefined) {
      const whole: number = digits.number('integer') ?? 0;
      const fraction: number = digits.number('fraction') ?? 0;
      maxDigits = whole + fraction;
      decimalPlaces = fraction;
    }
  }

  // Nullability ----------------------------------------------------------------------------
  let isNullable: boolean = true;
  if (isPrimitive(type)) {
    isNullable = false;
  }
  if (isDeclaredNotNull(notes) || definition?.notNull === true) {
    isNullable = false;
  }
  const explicitNullable: boolean | undefined = column?.boolean('nullable');
  if (explicitNullable === false) {
    isNullable = false;
  } else if (explicitNullable === true && !isPrimitive(type)) {
    isNullable = true;
  }
  const isKey: boolean = member.isId;
  if (isKey) {
    isNullable = false;
  }

  // Defaults and generated values -------------------------------------------------------------
  let defaultValue: IrDefault | undefined;
  const columnDefault: string | undefined =
    notes.get('ColumnDefault', true)?.string('value') ??
    definition?.defaultText;
  if (columnDefault !== undefined) {
    defaultValue = sqlDefault(columnDefault, irType);
    if (
      enumDef !== undefined &&
      defaultValue.kind === 'literal' &&
      typeof defaultValue.value === 'string'
    ) {
      const text: string = defaultValue.value;
      const found = enumDef.values.find((item) => item.dbValue === text);
      if (found !== undefined) {
        defaultValue = { kind: 'enumValue', value: found.name };
      }
    }
  }
  let isAutoUpdated: boolean = false;
  const created: boolean =
    notes.has('CreationTimestamp', true) || notes.has('CreatedDate');
  const updated: boolean =
    notes.has('UpdateTimestamp', true) || notes.has('LastModifiedDate');
  if (created && defaultValue === undefined && irType === 'dateTime') {
    defaultValue = { kind: 'now' };
  }
  if (updated && irType === 'dateTime') {
    isAutoUpdated = true;
  }
  if (defaultValue === undefined && notes.has('UuidGenerator', true)) {
    defaultValue = { kind: 'uuid' };
  }
  const generatedValue: Ann | undefined = notes.get('GeneratedValue');
  if (generatedValue !== undefined && defaultValue === undefined) {
    const strategy: string = generatedValue.member('strategy') ?? 'AUTO';
    if (irType === 'uuid' && /^(AUTO|UUID)$/.test(strategy)) {
      defaultValue = { kind: 'uuid' };
    } else if (isIntegerType(type)) {
      defaultValue = { kind: 'autoIncrement' };
      if (strategy === 'SEQUENCE' || strategy === 'TABLE') {
        ctx.warn(
          `${place}: the key is generated from ${strategy === 'TABLE' ? 'a table' : 'a sequence'} (@GeneratedValue(strategy = ${strategy})); it was read as an auto-increment column.`
        );
      }
    }
  }
  const computed: Ann | undefined = notes.get('GeneratedColumn', true);
  const expression: string | undefined = computed?.string('value');
  if (notes.has('Version')) {
    ctx.warn(
      `${place}: the @Version attribute is Hibernate's optimistic-locking counter; it was read as an ordinary column.`
    );
  }
  if (
    notes.has('Convert') &&
    converter === undefined &&
    converted === undefined
  ) {
    ctx.warn(`${place}: @Convert(disableConversion = true) was ignored.`);
  }

  const unique: boolean =
    (column?.boolean('unique') ?? false) || (definition?.unique ?? false);
  const field: IrField = {
    name: irFieldName(member),
    columnName: columnNameOf(member),
    type: irType,
    isPrimaryKey: isKey && singleKey,
    isUnique: unique && !(isKey && singleKey),
    isNullable,
    isAutoUpdated,
    ...(defaultValue === undefined ? {} : { default: defaultValue }),
    ...(irType === 'string' && maxLength !== undefined ? { maxLength } : {}),
    ...(irType === 'decimal' && maxDigits !== undefined ? { maxDigits } : {}),
    ...(irType === 'decimal' && decimalPlaces !== undefined
      ? { decimalPlaces }
      : {}),
    ...(shape.arrayDepth === undefined ? {} : { arrayDepth: shape.arrayDepth }),
    ...(enumDef === undefined ? {} : { enumName: enumDef.name }),
    ...(irType === 'unsupported' && shape.unsupportedType !== undefined
      ? { unsupportedType: shape.unsupportedType }
      : {}),
    ...(expression === undefined
      ? {}
      : { generated: { expression, isStored: false } }),
  };
  return {
    field,
    member,
    ...(enumDef === undefined ? {} : { enumDefinition: enumDef }),
    naturalId: notes.has('NaturalId', true),
    readOnly:
      column?.boolean('insertable') === false &&
      column.boolean('updatable') === false,
  };
}
