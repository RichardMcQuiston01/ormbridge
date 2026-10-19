import type { IrEnum, IrField, IrScalarType } from '../ir.js';

/**
 * Output style of the Neo4j writer. `community` (the default) writes only what Neo4j Community
 * Edition accepts; `enterprise` adds the statements that need Enterprise Edition: `IS NOT NULL`
 * constraints, `IS NODE KEY` for composite primary keys and property type constraints.
 */
export type Neo4jStyle = 'community' | 'enterprise';

export const NEO4J_STYLES: readonly Neo4jStyle[] = ['community', 'enterprise'];

/** True when a value is a style of the Neo4j writer. */
export function isNeo4jStyle(value: string): value is Neo4jStyle {
  return (NEO4J_STYLES as readonly string[]).includes(value);
}

/** A Neo4j property type. */
export interface Neo4jType {
  /** Type name as the Neo4j manual spells it, for example `STRING` or `LIST<INTEGER NOT NULL>`. */
  name: string;
  /** False for types that a property type constraint cannot name (byte arrays). */
  constrainable: boolean;
}

/** A property type plus what was approximated to reach it. */
export interface Neo4jTypeMapping {
  type: Neo4jType;
  /** Present when the mapping loses or changes information; the text has no model or field prefix. */
  warning?: string;
}

const STRING: Neo4jType = { name: 'STRING', constrainable: true };

/** Column types of databases that store a date and time without a time zone. */
const LOCAL_DATETIME_TYPES: ReadonlySet<string> = new Set([
  'timestamp',
  'datetime',
  'datetime2',
  'smalldatetime',
]);

function scalarType(field: IrField): Neo4jTypeMapping {
  const native: string = field.nativeType?.name.toLowerCase() ?? '';
  const type: IrScalarType = field.type;
  switch (type) {
    case 'string':
    case 'text':
    case 'uuid':
    case 'ipAddress':
      return { type: STRING };
    case 'int':
    case 'bigInt':
      return { type: { name: 'INTEGER', constrainable: true } };
    case 'float':
      return { type: { name: 'FLOAT', constrainable: true } };
    case 'boolean':
      return { type: { name: 'BOOLEAN', constrainable: true } };
    case 'date':
      return { type: { name: 'DATE', constrainable: true } };
    case 'dateTime':
      return {
        type: {
          name: LOCAL_DATETIME_TYPES.has(native)
            ? 'LOCAL DATETIME'
            : 'ZONED DATETIME',
          constrainable: true,
        },
      };
    case 'time':
      return {
        type: {
          name: native === 'timetz' ? 'ZONED TIME' : 'LOCAL TIME',
          constrainable: true,
        },
      };
    case 'duration':
      return { type: { name: 'DURATION', constrainable: true } };
    case 'bytes':
      return { type: { name: 'BYTE ARRAY', constrainable: false } };
    case 'decimal':
      return {
        type: STRING,
        warning:
          'Neo4j has no decimal type; the value is stored as a STRING so no precision is lost (use FLOAT, or an integer count of cents, if you need arithmetic).',
      };
    case 'json':
      return {
        type: STRING,
        warning:
          'Neo4j properties cannot hold JSON objects; store the value as a serialized JSON STRING.',
      };
    case 'hstore':
      return {
        type: STRING,
        warning:
          'Neo4j has no key-value property type; the hstore value is stored as a serialized STRING.',
      };
    case 'range':
      return {
        type: STRING,
        warning:
          'Neo4j has no range type; the value is stored as a STRING such as "[1,10)".',
      };
    case 'unsupported':
      return {
        type: STRING,
        warning: `the database type "${field.unsupportedType ?? 'unknown'}" has no Neo4j equivalent; the property is a plain STRING.`,
      };
  }
}

/**
 * Maps a field to the Neo4j property type it is documented (and, in the enterprise style, constrained)
 * with. Enum-backed fields are strings. An array becomes a one-dimensional `LIST<T NOT NULL>`; Neo4j
 * cannot store lists of lists or lists of byte arrays, so those fall back to a STRING.
 */
export function mapFieldType(field: IrField): Neo4jTypeMapping {
  const element: Neo4jTypeMapping = scalarType(field);
  const depth: number = field.arrayDepth ?? 0;
  if (depth === 0) {
    return element;
  }
  if (depth > 1 || !element.type.constrainable) {
    return {
      type: STRING,
      warning: `Neo4j cannot store ${
        depth > 1 ? 'nested lists' : 'a list of byte arrays'
      } as a property; the value is stored as a serialized STRING.`,
    };
  }
  const mapping: Neo4jTypeMapping = {
    type: {
      name: `LIST<${element.type.name} NOT NULL>`,
      constrainable: true,
    },
  };
  return element.warning === undefined
    ? mapping
    : { ...mapping, warning: element.warning };
}

/** The stored values of the enum behind a field, or an empty list when the field is not enum-backed. */
export function enumValuesOf(
  field: IrField,
  enums: readonly IrEnum[]
): string[] {
  if (field.enumName === undefined) {
    return [];
  }
  const definition: IrEnum | undefined = enums.find(
    (candidate: IrEnum) => candidate.name === field.enumName
  );
  return definition === undefined
    ? []
    : definition.values.map((value) => value.dbValue);
}
