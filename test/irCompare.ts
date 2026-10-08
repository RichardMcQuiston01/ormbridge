import type {
  IrDefault,
  IrEnum,
  IrEnumValue,
  IrField,
  IrIndex,
  IrModel,
  IrRelation,
  IrSchema,
} from '../src/ir.js';

/**
 * Semantic comparison of two intermediate representations.
 *
 * The comparator answers "do these two schemas describe the same database
 * model?" and lists every way in which they do not. It deliberately ignores
 * differences that carry no meaning:
 *
 * - ordering of models, fields, relations, indexes and enum members;
 * - the case/underscore spelling of identifiers (`created_at` vs `createdAt`,
 *   `DRAFT` vs `Draft`), because every format has its own naming convention;
 * - the Django `appLabel`, which only exists to build default table names
 *   (the table name itself is compared);
 * - index and constraint names that the target merely synthesized (a name is
 *   only compared when the "before" side had an explicit one);
 * - an omitted reverse-accessor name when it equals the framework default
 *   (Django's `<model>_set` for foreign keys and `<model>` for one-to-one),
 *   which is how Django, Prisma and TypeORM each spell "no explicit name";
 * - the nullability of a many-to-many relation, which has no column to be
 *   null (TypeORM reads it as nullable, Django as required);
 * - values a target must invent because it cannot leave them out: a Django
 *   enum member label derived from the member name, and the `max_length`
 *   Django requires on an enum-backed column. They are only ignored when the
 *   "before" side had no value; a label or length that is lost is reported.
 *
 * Everything else (types, nullability, defaults, lengths, relations,
 * on-delete actions, enums, indexes, uniques and keys) is compared.
 */

export type IrDifferenceKind =
  | 'modelRemoved'
  | 'modelAdded'
  | 'tableName'
  | 'compositePrimaryKey'
  | 'joinTable'
  | 'fieldRemoved'
  | 'fieldAdded'
  | 'fieldType'
  | 'fieldPrimaryKey'
  | 'fieldUnique'
  | 'fieldNullability'
  | 'fieldDefault'
  | 'fieldMaxLength'
  | 'fieldMaxDigits'
  | 'fieldDecimalPlaces'
  | 'fieldAutoUpdated'
  | 'fieldEnum'
  | 'relationRemoved'
  | 'relationAdded'
  | 'relationKind'
  | 'relationTarget'
  | 'relationNullability'
  | 'relationOnDelete'
  | 'relationRelatedName'
  | 'relationToField'
  | 'relationPrimaryKey'
  | 'indexRemoved'
  | 'indexAdded'
  | 'indexName'
  | 'enumRemoved'
  | 'enumAdded'
  | 'enumValueRemoved'
  | 'enumValueAdded'
  | 'enumValueName'
  | 'enumValueLabel';

export interface IrDifference {
  kind: IrDifferenceKind;
  /** Model the difference belongs to (absent for enum differences). */
  model?: string;
  /** Field, relation or enum member the difference belongs to, when it has one. */
  field?: string;
  /** Description of the value in the "before" schema. */
  before: string;
  /** Description of the value in the "after" schema. */
  after: string;
}

const ABSENT: string = '(absent)';

/** Identifier spelling used for comparisons: case and underscores are not significant. */
export function normalizeName(name: string): string {
  return name.replace(/_/g, '').toLowerCase();
}

function describeDefault(value: IrDefault | undefined): string {
  if (value === undefined) {
    return '(none)';
  }
  switch (value.kind) {
    case 'literal':
      return `literal ${JSON.stringify(value.value)}`;
    case 'enumValue':
      return `enum member ${normalizeName(value.value)}`;
    default:
      return value.kind;
  }
}

function describeOptional(
  value: string | number | boolean | undefined
): string {
  return value === undefined ? '(none)' : String(value);
}

/** Reverse accessor name, with Django's implicit default filled in when none was written. */
function effectiveRelatedName(model: IrModel, relation: IrRelation): string {
  if (relation.relatedName !== undefined) {
    return normalizeName(relation.relatedName);
  }
  const base: string = normalizeName(model.name);
  return relation.kind === 'oneToOne' ? base : `${base}set`;
}

/** Resolves an index's field names to column identifiers so field and column spellings agree. */
function resolveIndexColumns(model: IrModel, index: IrIndex): string[] {
  return index.fields.map((name: string): string => {
    const wanted: string = normalizeName(name);
    const field: IrField | undefined = model.fields.find(
      (candidate: IrField) =>
        normalizeName(candidate.name) === wanted ||
        normalizeName(candidate.columnName) === wanted
    );
    if (field !== undefined) {
      return normalizeName(field.columnName);
    }
    const relation: IrRelation | undefined = model.relations.find(
      (candidate: IrRelation) =>
        normalizeName(candidate.name) === wanted ||
        normalizeName(candidate.columnName) === wanted
    );
    return relation !== undefined && relation.kind !== 'manyToMany'
      ? normalizeName(relation.columnName)
      : wanted;
  });
}

function indexKey(model: IrModel, index: IrIndex): string {
  const columns: string = resolveIndexColumns(model, index).join(', ');
  return `${index.isUnique ? 'unique' : 'index'} (${columns})`;
}

function describeRelation(relation: IrRelation): string {
  return `${relation.kind} -> ${relation.targetModel}`;
}

/** Collects differences as it walks both schemas. */
class DifferenceCollector {
  readonly differences: IrDifference[] = [];

  add(difference: IrDifference): void {
    this.differences.push(difference);
  }

  /** Records a difference when the two stringified values are not equal. */
  compare(
    kind: IrDifferenceKind,
    model: string | undefined,
    field: string | undefined,
    before: string,
    after: string
  ): void {
    if (before !== after) {
      this.add({ kind, model, field, before, after });
    }
  }
}

function indexByKey<T>(items: T[], key: (item: T) => string): Map<string, T> {
  const map: Map<string, T> = new Map<string, T>();
  for (const item of items) {
    map.set(key(item), item);
  }
  return map;
}

function compareFields(
  collector: DifferenceCollector,
  before: IrModel,
  after: IrModel
): void {
  const key = (field: IrField): string => normalizeName(field.columnName);
  const beforeFields: Map<string, IrField> = indexByKey(before.fields, key);
  const afterFields: Map<string, IrField> = indexByKey(after.fields, key);
  for (const [fieldKey, left] of beforeFields) {
    const right: IrField | undefined = afterFields.get(fieldKey);
    if (right === undefined) {
      collector.add({
        kind: 'fieldRemoved',
        model: before.name,
        field: left.columnName,
        before: left.type,
        after: ABSENT,
      });
      continue;
    }
    const at = (
      kind: IrDifferenceKind,
      beforeValue: string,
      afterValue: string
    ): void =>
      collector.compare(
        kind,
        before.name,
        left.columnName,
        beforeValue,
        afterValue
      );
    at('fieldType', left.type, right.type);
    at(
      'fieldPrimaryKey',
      String(left.isPrimaryKey),
      String(right.isPrimaryKey)
    );
    at('fieldUnique', String(left.isUnique), String(right.isUnique));
    at(
      'fieldNullability',
      left.isNullable ? 'nullable' : 'required',
      right.isNullable ? 'nullable' : 'required'
    );
    at(
      'fieldDefault',
      describeDefault(left.default),
      describeDefault(right.default)
    );
    // Django needs a length for an enum-backed column and invents one.
    const synthesizedLength: boolean =
      left.enumName !== undefined && left.maxLength === undefined;
    if (!synthesizedLength) {
      at(
        'fieldMaxLength',
        describeOptional(left.maxLength),
        describeOptional(right.maxLength)
      );
    }
    at(
      'fieldMaxDigits',
      describeOptional(left.maxDigits),
      describeOptional(right.maxDigits)
    );
    at(
      'fieldDecimalPlaces',
      describeOptional(left.decimalPlaces),
      describeOptional(right.decimalPlaces)
    );
    at(
      'fieldAutoUpdated',
      String(left.isAutoUpdated),
      String(right.isAutoUpdated)
    );
    at('fieldEnum', left.enumName ?? '(none)', right.enumName ?? '(none)');
  }
  for (const [fieldKey, right] of afterFields) {
    if (!beforeFields.has(fieldKey)) {
      collector.add({
        kind: 'fieldAdded',
        model: before.name,
        field: right.columnName,
        before: ABSENT,
        after: right.type,
      });
    }
  }
}

function compareRelations(
  collector: DifferenceCollector,
  before: IrModel,
  after: IrModel
): void {
  const key = (relation: IrRelation): string => normalizeName(relation.name);
  const beforeRelations: Map<string, IrRelation> = indexByKey(
    before.relations,
    key
  );
  const afterRelations: Map<string, IrRelation> = indexByKey(
    after.relations,
    key
  );
  for (const [relationKey, left] of beforeRelations) {
    const right: IrRelation | undefined = afterRelations.get(relationKey);
    if (right === undefined) {
      collector.add({
        kind: 'relationRemoved',
        model: before.name,
        field: left.name,
        before: describeRelation(left),
        after: ABSENT,
      });
      continue;
    }
    const at = (
      kind: IrDifferenceKind,
      beforeValue: string,
      afterValue: string
    ): void =>
      collector.compare(kind, before.name, left.name, beforeValue, afterValue);
    at('relationKind', left.kind, right.kind);
    at('relationTarget', left.targetModel, right.targetModel);
    if (left.kind !== 'manyToMany' && right.kind !== 'manyToMany') {
      at(
        'relationNullability',
        left.isNullable ? 'nullable' : 'required',
        right.isNullable ? 'nullable' : 'required'
      );
    }
    at('relationOnDelete', left.onDelete, right.onDelete);
    at(
      'relationRelatedName',
      effectiveRelatedName(before, left),
      effectiveRelatedName(after, right)
    );
    at(
      'relationToField',
      left.toField ?? '(primary key)',
      right.toField ?? '(primary key)'
    );
    at(
      'relationPrimaryKey',
      String(left.isPrimaryKey === true),
      String(right.isPrimaryKey === true)
    );
  }
  for (const [relationKey, right] of afterRelations) {
    if (!beforeRelations.has(relationKey)) {
      collector.add({
        kind: 'relationAdded',
        model: before.name,
        field: right.name,
        before: ABSENT,
        after: describeRelation(right),
      });
    }
  }
}

function compareIndexes(
  collector: DifferenceCollector,
  before: IrModel,
  after: IrModel
): void {
  const beforeIndexes: Map<string, IrIndex> = indexByKey(
    before.indexes,
    (index: IrIndex) => indexKey(before, index)
  );
  const afterIndexes: Map<string, IrIndex> = indexByKey(
    after.indexes,
    (index: IrIndex) => indexKey(after, index)
  );
  for (const [key, left] of beforeIndexes) {
    const right: IrIndex | undefined = afterIndexes.get(key);
    if (right === undefined) {
      collector.add({
        kind: 'indexRemoved',
        model: before.name,
        before: key,
        after: ABSENT,
      });
      continue;
    }
    // A name the target synthesized is cosmetic; an explicit name that was
    // dropped or changed is a real difference.
    if (left.name !== undefined && left.name !== right.name) {
      collector.add({
        kind: 'indexName',
        model: before.name,
        field: key,
        before: left.name,
        after: right.name ?? '(none)',
      });
    }
  }
  for (const [key] of afterIndexes) {
    if (!beforeIndexes.has(key)) {
      collector.add({
        kind: 'indexAdded',
        model: before.name,
        before: ABSENT,
        after: key,
      });
    }
  }
}

function compareModel(
  collector: DifferenceCollector,
  before: IrModel,
  after: IrModel
): void {
  collector.compare(
    'tableName',
    before.name,
    undefined,
    before.tableName,
    after.tableName
  );
  const describeKey = (model: IrModel): string =>
    model.compositePrimaryKey === undefined
      ? '(none)'
      : `(${model.compositePrimaryKey.map(normalizeName).sort().join(', ')})`;
  collector.compare(
    'compositePrimaryKey',
    before.name,
    undefined,
    describeKey(before),
    describeKey(after)
  );
  collector.compare(
    'joinTable',
    before.name,
    undefined,
    String(before.isJoinTable === true),
    String(after.isJoinTable === true)
  );
  compareFields(collector, before, after);
  compareRelations(collector, before, after);
  compareIndexes(collector, before, after);
}

function compareEnum(
  collector: DifferenceCollector,
  before: IrEnum,
  after: IrEnum
): void {
  const key = (value: IrEnumValue): string => value.dbValue;
  const beforeValues: Map<string, IrEnumValue> = indexByKey(before.values, key);
  const afterValues: Map<string, IrEnumValue> = indexByKey(after.values, key);
  for (const [dbValue, left] of beforeValues) {
    const right: IrEnumValue | undefined = afterValues.get(dbValue);
    if (right === undefined) {
      collector.add({
        kind: 'enumValueRemoved',
        field: `${before.name}.${left.name}`,
        before: dbValue,
        after: ABSENT,
      });
      continue;
    }
    collector.compare(
      'enumValueName',
      undefined,
      `${before.name}.${dbValue}`,
      normalizeName(left.name),
      normalizeName(right.name)
    );
    // A label the target derived from the member name is synthesized.
    if (left.label !== undefined) {
      collector.compare(
        'enumValueLabel',
        undefined,
        `${before.name}.${dbValue}`,
        left.label,
        right.label ?? '(none)'
      );
    }
  }
  for (const [dbValue, right] of afterValues) {
    if (!beforeValues.has(dbValue)) {
      collector.add({
        kind: 'enumValueAdded',
        field: `${after.name}.${right.name}`,
        before: ABSENT,
        after: dbValue,
      });
    }
  }
}

/**
 * Compares two schemas and returns every meaningful difference, ordered by
 * model, then by kind of difference. An empty list means the schemas are
 * semantically equivalent.
 */
export function compareIr(before: IrSchema, after: IrSchema): IrDifference[] {
  const collector: DifferenceCollector = new DifferenceCollector();
  const beforeModels: Map<string, IrModel> = indexByKey(
    before.models,
    (model: IrModel) => model.name
  );
  const afterModels: Map<string, IrModel> = indexByKey(
    after.models,
    (model: IrModel) => model.name
  );
  for (const [name, left] of beforeModels) {
    const right: IrModel | undefined = afterModels.get(name);
    if (right === undefined) {
      collector.add({
        kind: 'modelRemoved',
        model: name,
        before: `model ${name}`,
        after: ABSENT,
      });
    } else {
      compareModel(collector, left, right);
    }
  }
  for (const [name] of afterModels) {
    if (!beforeModels.has(name)) {
      collector.add({
        kind: 'modelAdded',
        model: name,
        before: ABSENT,
        after: `model ${name}`,
      });
    }
  }

  const beforeEnums: Map<string, IrEnum> = indexByKey(
    before.enums,
    (enumeration: IrEnum) => enumeration.name
  );
  const afterEnums: Map<string, IrEnum> = indexByKey(
    after.enums,
    (enumeration: IrEnum) => enumeration.name
  );
  for (const [name, left] of beforeEnums) {
    const right: IrEnum | undefined = afterEnums.get(name);
    if (right === undefined) {
      collector.add({
        kind: 'enumRemoved',
        field: name,
        before: `enum ${name}`,
        after: ABSENT,
      });
    } else {
      compareEnum(collector, left, right);
    }
  }
  for (const [name] of afterEnums) {
    if (!beforeEnums.has(name)) {
      collector.add({
        kind: 'enumAdded',
        field: name,
        before: ABSENT,
        after: `enum ${name}`,
      });
    }
  }
  return collector.differences;
}

/** One-line human-readable rendering of a difference. */
export function formatDifference(difference: IrDifference): string {
  const where: string = [difference.model, difference.field]
    .filter((part): part is string => part !== undefined)
    .join('.');
  return `${difference.kind}${where === '' ? '' : ` ${where}`}: ${difference.before} -> ${difference.after}`;
}
