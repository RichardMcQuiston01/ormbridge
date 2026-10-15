import type {
  IrDefault,
  IrEnum,
  IrEnumValue,
  IrField,
  IrRelation,
  IrSchema,
} from '../src/ir.js';
import type {
  EfcoreColumn,
  EfcoreDatabase,
  EfcoreExercise,
  EfcoreTable,
} from './efcoreSupport.js';

/**
 * Compares what the EF Core writer promised in the IR (defaults, enum values, generated keys, auto-updated
 * columns) with the DDL EF Core wrote and the rows it saved. See `Exercise` in `tools/efcore-verify/Program.cs`.
 */

type ExpectedDefault =
  | { kind: 'text'; value: string }
  | { kind: 'number'; value: number }
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
        case 'json':
        case 'date':
        case 'time':
        case 'dateTime':
        case 'duration':
        case 'ipAddress':
          return { kind: 'text', value: String(value.value) };
        case 'int':
        case 'bigInt':
        case 'float':
        case 'decimal':
          return { kind: 'number', value: Number(value.value) };
        case 'boolean':
          return { kind: 'number', value: value.value === true ? 1 : 0 };
        default:
          return undefined;
      }
    }
    default:
      return undefined;
  }
}

/** Removes the parentheses and quotes SQLite keeps around a default expression. */
function unquoteDefault(text: string): string {
  let result: string = text.trim();
  while (/^\(.*\)$/s.test(result)) {
    result = result.slice(1, -1).trim();
  }
  const quoted: RegExpMatchArray | null = result.match(/^'((?:[^']|'')*)'$/s);
  return quoted === null ? result : (quoted[1] ?? '').replace(/''/g, "'");
}

function defaultProblems(
  ir: IrSchema,
  tableName: string,
  table: EfcoreTable,
  fields: readonly IrField[]
): string[] {
  const problems: string[] = [];
  for (const field of fields) {
    const column: EfcoreColumn | undefined = table.columns.find(
      (candidate: EfcoreColumn) => candidate.name === field.columnName
    );
    const expected: ExpectedDefault | undefined = expectedDefault(ir, field);
    if (
      column === undefined ||
      expected === undefined ||
      field.generated !== undefined
    ) {
      continue;
    }
    const label: string = `${tableName}.${field.columnName}`;
    if (column.default === null) {
      problems.push(
        `${label}: no default in the DDL, ${JSON.stringify(field.default)} in the IR`
      );
      continue;
    }
    const actual: string = unquoteDefault(column.default);
    const matches: boolean =
      expected.kind === 'now'
        ? /^CURRENT_(TIMESTAMP|DATE|TIME)$/i.test(actual)
        : expected.kind === 'number'
          ? Number(actual) === expected.value
          : actual === expected.value;
    if (!matches) {
      problems.push(
        `${label}: default ${column.default} in the DDL, ${JSON.stringify(expected)} in the IR`
      );
    }
  }
  return problems;
}

/**
 * Lists everything in which the defaults of the DDL, the rows EF Core wrote and the columns it refreshed differ from
 * the IR. The DDL is what `HasDefaultValue` and `HasDefaultValueSql` end up as; the rows show that the enum
 * converters store the right text, that keys are generated and that the context sets auto-updated columns.
 */
export function compareBehavior(
  ir: IrSchema,
  tables: EfcoreDatabase,
  exercise: EfcoreExercise
): string[] {
  const problems: string[] = exercise.errors.map(
    (error: string) => `error: ${error}`
  );
  for (const model of ir.models) {
    const table: EfcoreTable | undefined = tables[model.tableName];
    if (table === undefined) {
      continue;
    }
    problems.push(...defaultProblems(ir, model.tableName, table, model.fields));

    const row: Record<string, unknown> | null | undefined =
      exercise.rows[model.tableName];
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
        field.default === undefined &&
        !field.isNullable
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
        if (change === undefined) {
          problems.push(
            `${label}: the context does not refresh the column on update`
          );
        } else if (change[0] === change[1]) {
          problems.push(
            `${label}: the column kept ${JSON.stringify(change[0])} on update`
          );
        }
      }
    }
  }
  return problems;
}
