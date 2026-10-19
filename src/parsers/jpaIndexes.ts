import type { IrIndex, IrIndexFieldOptions } from '../ir.js';
import type { Ann } from './jpaAnnotations.js';
import type { EntityInfo } from './jpaModel.js';
import { cleanIdentifier } from './jpaColumns.js';

export interface IndexResult {
  indexes: IrIndex[];
  /** IR names of columns that carry a single-column unnamed unique constraint. */
  uniqueFields: Set<string>;
}

/** Splits `a, b DESC, c ASC` into column names and sort flags. */
function parseColumnList(
  list: string
): { column: string; descending: boolean }[] {
  return list
    .split(',')
    .map((part: string) => part.trim())
    .filter((part: string) => part !== '')
    .map((part: string) => {
      const match: RegExpMatchArray | null = part.match(
        /^(.*?)(?:\s+(ASC|DESC))?$/i
      );
      return {
        column: cleanIdentifier((match?.[1] ?? part).trim()),
        descending: (match?.[2] ?? '').toUpperCase() === 'DESC',
      };
    });
}

/**
 * Reads `@Table(uniqueConstraints, indexes)` and the natural id into IR indexes. `names` maps a column name (any
 * case) or an attribute name to the IR field or relation that owns it.
 */
export function buildIndexes(
  entity: EntityInfo,
  names: ReadonlyMap<string, string>,
  naturalId: readonly string[],
  warn: (message: string) => void
): IndexResult {
  const indexes: IrIndex[] = [];
  const uniqueFields: Set<string> = new Set();
  const place: string = entity.name;
  const table: Ann | undefined = entity.notes.get('Table');
  const resolve = (columns: string[], label: string): string[] | undefined => {
    const resolved: string[] = [];
    for (const column of columns) {
      const found: string | undefined =
        names.get(column.toLowerCase()) ?? names.get(column);
      if (found === undefined) {
        warn(
          `${place}: ${label} refers to "${column}", which is not a column of the table; it was skipped.`
        );
        return undefined;
      }
      resolved.push(found);
    }
    return resolved.length === 0 ? undefined : resolved;
  };
  const seen: Set<string> = new Set();
  const add = (
    columns: string[],
    unique: boolean,
    name: string | undefined,
    descending: boolean[],
    label: string
  ): void => {
    const fields: string[] | undefined = resolve(columns, label);
    if (fields === undefined) {
      return;
    }
    const signature: string = `${unique ? 'u' : 'i'}|${fields.join(',')}|${name ?? ''}`;
    if (seen.has(signature)) {
      return;
    }
    seen.add(signature);
    const only: string | undefined = fields[0];
    if (unique && fields.length === 1 && only !== undefined && !name) {
      uniqueFields.add(only);
      return;
    }
    const fieldOptions: Record<string, IrIndexFieldOptions> = {};
    descending.forEach((flag: boolean, position: number) => {
      const field: string | undefined = fields[position];
      if (flag && field !== undefined) {
        fieldOptions[field] = { sort: 'desc' };
      }
    });
    indexes.push({
      fields,
      isUnique: unique,
      ...(name ? { name } : {}),
      ...(Object.keys(fieldOptions).length === 0 ? {} : { fieldOptions }),
    });
  };
  for (const constraint of table?.annotations('uniqueConstraints') ?? []) {
    const name: string | undefined = constraint.string('name');
    const columns: string[] = constraint.strings('columnNames');
    add(
      columns.map(cleanIdentifier),
      true,
      name,
      columns.map(() => false),
      `the unique constraint${name ? ` "${name}"` : ''}`
    );
  }
  for (const index of table?.annotations('indexes') ?? []) {
    const name: string | undefined = index.string('name');
    const parts = parseColumnList(index.string('columnList') ?? '');
    add(
      parts.map((part) => part.column),
      index.boolean('unique') === true,
      name,
      parts.map((part) => part.descending),
      `the index${name ? ` "${name}"` : ''}`
    );
  }
  if (naturalId.length > 0) {
    if (naturalId.length === 1 && naturalId[0] !== undefined) {
      uniqueFields.add(naturalId[0]);
    } else {
      indexes.push({ fields: [...naturalId], isUnique: true });
    }
  }
  return { indexes, uniqueFields };
}
