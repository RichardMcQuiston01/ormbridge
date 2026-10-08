/**
 * Intermediate representation (IR) shared by every parser and emitter.
 *
 * Each supported format (Django, Prisma, and later TypeORM / Graphene) only
 * needs to know how to read into and write out of this model.
 */

export type IrScalarType =
  | 'string'
  | 'text'
  | 'int'
  | 'bigInt'
  | 'float'
  | 'decimal'
  | 'boolean'
  | 'dateTime'
  | 'date'
  | 'time'
  | 'uuid'
  | 'json'
  | 'bytes'
  | 'duration'
  | 'ipAddress'
  | 'hstore'
  | 'range';

/** Element type of a `range` field (Django's django.contrib.postgres range fields). */
export type IrRangeSubtype = 'int' | 'bigInt' | 'decimal' | 'date' | 'dateTime';

/** A database-computed column (Django GeneratedField). */
export interface IrGenerated {
  /** Expression source as written in the input, e.g. `F("a") + F("b")`. */
  expression: string;
  /** True when the value is stored (db_persist=True), false when computed on read. */
  isStored: boolean;
}

export type IrDefault =
  | { kind: 'literal'; value: string | number | boolean }
  | { kind: 'autoIncrement' }
  | { kind: 'now' }
  | { kind: 'uuid' }
  | { kind: 'enumValue'; value: string };

export interface IrField {
  /** Field name as written in the source format. */
  name: string;
  /** Database column name. */
  columnName: string;
  type: IrScalarType;
  isPrimaryKey: boolean;
  isUnique: boolean;
  isNullable: boolean;
  default?: IrDefault;
  maxLength?: number;
  maxDigits?: number;
  decimalPlaces?: number;
  /** True when the value is refreshed on every save (Django auto_now, Prisma @updatedAt). */
  isAutoUpdated: boolean;
  /** Name of an IrEnum when the field is enum-backed. */
  enumName?: string;
  /**
   * Number of array dimensions (Django ArrayField, nested ArrayFields add one each).
   * When set, `type` (and maxLength, enumName, ...) describe the innermost element.
   */
  arrayDepth?: number;
  /** Element type of the field when `type` is "range". */
  rangeOf?: IrRangeSubtype;
  /** Set when the column is computed by the database from an expression. */
  generated?: IrGenerated;
  /** True when `default` is a database-level default (Django db_default). */
  isDbDefault?: boolean;
}

export type IrOnDelete =
  'cascade' | 'setNull' | 'restrict' | 'noAction' | 'setDefault';

export type IrRelationKind = 'foreignKey' | 'oneToOne' | 'manyToMany';

export interface IrRelation {
  /** Relation field name, e.g. "author". */
  name: string;
  kind: IrRelationKind;
  /** Target model name. */
  targetModel: string;
  /** Foreign-key column on this model (unused for manyToMany). */
  columnName: string;
  isNullable: boolean;
  onDelete: IrOnDelete;
  /** Name of the reverse accessor on the target model. */
  relatedName?: string;
  /** Target column when it is not the primary key. */
  toField?: string;
  /** True when this relation is the primary key (multi-table inheritance). */
  isPrimaryKey?: boolean;
}

export interface IrIndex {
  /** Field or relation names (IR names, not column names). */
  fields: string[];
  isUnique: boolean;
  /** Explicit database name, when the source specified one. */
  name?: string;
}

export interface IrModel {
  name: string;
  tableName: string;
  /** Django app label, used to build default table names. */
  appLabel: string;
  fields: IrField[];
  relations: IrRelation[];
  indexes: IrIndex[];
  /** Composite primary key made of IR field/relation names (Prisma @@id). */
  compositePrimaryKey?: string[];
  /** True for join models synthesized from a many-to-many field. */
  isJoinTable?: boolean;
}

export interface IrEnumValue {
  /** Member name, e.g. "ADMIN". */
  name: string;
  /** Stored database value, e.g. "admin". */
  dbValue: string;
  /** Human-readable label (Django TextChoices). */
  label?: string;
}

export interface IrEnum {
  name: string;
  values: IrEnumValue[];
}

export interface IrSchema {
  models: IrModel[];
  enums: IrEnum[];
  warnings: string[];
}

export function findModel(
  schema: IrSchema,
  modelName: string
): IrModel | undefined {
  return schema.models.find((model) => model.name === modelName);
}
