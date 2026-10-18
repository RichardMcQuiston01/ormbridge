import type {
  IrDefault,
  IrEnum,
  IrEnumValue,
  IrField,
  IrRelation,
  IrSchema,
} from '../src/ir.js';
import type {
  JpaColumn,
  JpaDatabase,
  JpaExercise,
  JpaTable,
} from './jpaSupport.js';

/**
 * Compares what the JPA writer promised in the IR (defaults, enum values, generated keys, auto-updated columns) with
 * the DDL Hibernate wrote and the rows it saved. See `Exercise.java` in `tools/jpa-verify`.
 */

type ExpectedDefault =
  | { kind: 'text'; value: string }
  | { kind: 'number'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'now' };

/** The default the DDL has to show for a field, or undefined when there is nothing to check. */
function expectedDefault(
  ir: IrSchema,
  field: IrField
): ExpectedDefault | undefined {
  const value: IrDefault | undefined = field.default;
  if (value === undefined || field.arrayDepth !== undefined) {
    return undefined;
  }
  const enumeration: IrEnum | undefined = ir.enums.find(
    (candidate: IrEnum) => candidate.name === field.enumName
  );
  const asDatabase = (dbValue: string): ExpectedDefault =>
    field.type === 'int' || field.type === 'bigInt'
      ? { kind: 'number', value: Number(dbValue) }
      : { kind: 'text', value: dbValue };
  switch (value.kind) {
    case 'now':
      return { kind: 'now' };
    case 'enumValue': {
      const member: IrEnumValue | undefined = enumeration?.values.find(
        (candidate: IrEnumValue) => candidate.name === value.value
      );
      return member === undefined ? undefined : asDatabase(member.dbValue);
    }
    case 'literal': {
      if (enumeration !== undefined) {
        const member: IrEnumValue | undefined = enumeration.values.find(
          (candidate: IrEnumValue) =>
            candidate.name === String(value.value) ||
            candidate.dbValue === String(value.value)
        );
        return member === undefined ? undefined : asDatabase(member.dbValue);
      }
      switch (field.type) {
        case 'string':
        case 'text':
        case 'date':
        case 'time':
        case 'dateTime':
        case 'duration':
        case 'uuid':
          return { kind: 'text', value: String(value.value) };
        case 'int':
        case 'bigInt':
        case 'float':
        case 'decimal':
          return { kind: 'number', value: Number(value.value) };
        case 'boolean':
          return {
            kind: 'boolean',
            value: value.value === true || value.value === 1,
          };
        default:
          return undefined;
      }
    }
    default:
      return undefined;
  }
}

/** Removes the parentheses and quotes H2 keeps around a default expression. */
function unquoteDefault(text: string): string {
  let result: string = text.trim();
  while (/^\(.*\)$/s.test(result)) {
    result = result.slice(1, -1).trim();
  }
  const quoted: RegExpMatchArray | null = result.match(/^'((?:[^']|'')*)'$/s);
  return quoted === null ? result : (quoted[1] ?? '').replace(/''/g, "'");
}

function matches(expected: ExpectedDefault, actual: unknown): boolean {
  switch (expected.kind) {
    case 'now':
      return typeof actual === 'string' && actual !== '';
    case 'number':
      return Number(actual) === expected.value;
    case 'boolean':
      return actual === expected.value || actual === (expected.value ? 1 : 0);
    default:
      return actual === expected.value;
  }
}

function defaultProblems(
  ir: IrSchema,
  tableName: string,
  table: JpaTable,
  fields: readonly IrField[],
  row: Record<string, unknown> | null | undefined
): string[] {
  const problems: string[] = [];
  for (const field of fields) {
    const column: JpaColumn | undefined = table.columns.find(
      (candidate: JpaColumn) => candidate.name === field.columnName
    );
    const expected: ExpectedDefault | undefined = expectedDefault(ir, field);
    if (
      column === undefined ||
      expected === undefined ||
      field.generated !== undefined ||
      field.isPrimaryKey
    ) {
      continue;
    }
    const label: string = `${tableName}.${field.columnName}`;
    if (column.default === null) {
      problems.push(
        `${label}: no default in the DDL, ${JSON.stringify(field.default)} in the IR`
      );
    } else if (expected.kind !== 'now') {
      const actual: string = unquoteDefault(column.default);
      const ok: boolean =
        expected.kind === 'boolean'
          ? /^(true|1)$/i.test(actual) === expected.value
          : matches(expected, expected.kind === 'number' ? actual : actual);
      if (!ok) {
        problems.push(
          `${label}: default ${column.default} in the DDL, ${JSON.stringify(expected)} in the IR`
        );
      }
    } else if (!/^CURRENT_(TIMESTAMP|DATE|TIME)/i.test(column.default)) {
      problems.push(
        `${label}: default ${column.default} in the DDL, "now" in the IR`
      );
    }
    // The row that was saved without a value for the column shows what the default does.
    const value: unknown = row?.[field.columnName];
    const textual: boolean = [
      'json',
      'date',
      'time',
      'dateTime',
      'duration',
    ].includes(field.type);
    if (row !== null && row !== undefined && !textual) {
      if (!matches(expected, value)) {
        problems.push(
          `${label}: the saved row has ${JSON.stringify(value)}, the IR default is ${JSON.stringify(expected)}`
        );
      }
    }
  }
  return problems;
}

/**
 * Lists everything in which the defaults of the DDL, the rows Hibernate saved and the columns it refreshed differ
 * from the IR. The rows show that enum converters store the right values, that keys are generated, that defaults
 * reach the database and that `@UpdateTimestamp` columns change on update.
 */
export function compareBehavior(ir: IrSchema, database: JpaDatabase): string[] {
  const exercise: JpaExercise | undefined = database.exercise;
  if (exercise === undefined) {
    return ['the tool did not exercise the entities'];
  }
  const problems: string[] = exercise.errors.map(
    (error: string) => `error: ${error}`
  );
  for (const model of ir.models) {
    const table: JpaTable | undefined = database.tables[model.tableName];
    if (table === undefined) {
      continue;
    }
    const row: Record<string, unknown> | null | undefined =
      exercise.rows[model.tableName];
    problems.push(
      ...defaultProblems(ir, model.tableName, table, model.fields, row)
    );
    const hasKey: boolean =
      model.compositePrimaryKey !== undefined ||
      model.fields.some((field: IrField) => field.isPrimaryKey) ||
      model.relations.some(
        (relation: IrRelation) => relation.isPrimaryKey === true
      );
    if (row === undefined || row === null) {
      if (hasKey && model.isView !== true) {
        problems.push(`${model.tableName}: no sample row could be written`);
      }
      continue;
    }
    for (const field of model.fields) {
      const value: unknown = row[field.columnName];
      const label: string = `${model.tableName}.${field.columnName}`;
      if (
        field.isPrimaryKey &&
        model.compositePrimaryKey === undefined &&
        (value === null || value === undefined)
      ) {
        problems.push(`${label}: the key of the sample row is empty`);
      }
      const enumeration: IrEnum | undefined = ir.enums.find(
        (candidate: IrEnum) => candidate.name === field.enumName
      );
      const first: IrEnumValue | undefined = enumeration?.values[0];
      if (
        first !== undefined &&
        field.arrayDepth === undefined &&
        field.default === undefined
      ) {
        const expected: string | number =
          field.type === 'int' || field.type === 'bigInt'
            ? Number(first.dbValue)
            : first.dbValue;
        if (value !== expected) {
          problems.push(
            `${label}: the first member of ${enumeration?.name ?? ''} was stored as ${JSON.stringify(value)} instead of ${JSON.stringify(expected)}`
          );
        }
      }
      if (
        field.isAutoUpdated &&
        field.type === 'dateTime' &&
        !field.isPrimaryKey
      ) {
        const change: [unknown, unknown] | undefined =
          exercise.updates[model.tableName]?.[field.columnName];
        if (value === null || value === undefined) {
          problems.push(
            `${label}: the auto-updated column was empty after the insert`
          );
        }
        if (change !== undefined && change[0] === change[1]) {
          problems.push(
            `${label}: the column kept ${JSON.stringify(change[0])} on update`
          );
        }
      }
    }
  }
  return problems;
}
