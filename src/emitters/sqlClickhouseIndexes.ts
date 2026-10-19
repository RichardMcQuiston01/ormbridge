import type { IrIndex, IrModel } from '../ir.js';
import { limitIdentifier } from '../naming.js';
import { columnNameOf } from './sqlDdl.js';
import { chQuote, type ChEmitContext, type ChTable } from './sqlClickhouse.js';
import type { ChKind } from './sqlClickhouseTypes.js';

/**
 * Data-skipping indexes of the ClickHouse dialect. ClickHouse has no B-tree indexes: an IR index
 * becomes `INDEX name expr TYPE minmax|set(n)|bloom_filter|tokenbf_v1(...) GRANULARITY n`, chosen
 * from the type of the indexed column. Uniqueness cannot be kept, so a unique index is written as an
 * ordinary skipping index and the warning says so.
 */

interface SkipType {
  type: string;
  granularity: number;
}

function skipTypeOf(kinds: ChKind[], fulltext: boolean): SkipType | undefined {
  if (kinds.includes('map')) {
    return undefined;
  }
  if (fulltext && kinds.length === 1 && kinds[0] === 'string') {
    return { type: 'tokenbf_v1(10240, 3, 0)', granularity: 1 };
  }
  if (kinds.length > 1) {
    return { type: 'set(100)', granularity: 4 };
  }
  switch (kinds[0]) {
    case 'integer':
    case 'float':
    case 'decimal':
    case 'bool':
    case 'date':
    case 'dateTime':
      return { type: 'minmax', granularity: 4 };
    case 'enum':
      return { type: 'set(100)', granularity: 4 };
    default:
      return { type: 'bloom_filter', granularity: 1 };
  }
}

function warnAboutIndex(
  context: ChEmitContext,
  label: string,
  index: IrIndex,
  skip: SkipType
): void {
  if (index.isUnique) {
    context.warnings.push(
      `${label}: ClickHouse has no unique indexes; it was written as a data-skipping index (${skip.type}) and uniqueness is not enforced (a ReplacingMergeTree can deduplicate by ORDER BY key).`
    );
  }
  if (index.kind === 'fulltext' && !skip.type.startsWith('tokenbf')) {
    context.warnings.push(
      `${label}: a full-text index is only written as tokenbf_v1 for a single String column; it was written as ${skip.type}.`
    );
  }
  const dropped: string[] = [];
  if (index.method !== undefined) {
    dropped.push(`type ${index.method}`);
  }
  if (index.clustered !== undefined) {
    dropped.push('clustered');
  }
  if (index.fieldOptions !== undefined) {
    dropped.push('sort order, prefix length and operator class');
  }
  if (dropped.length > 0) {
    context.warnings.push(
      `${label}: the index option(s) ${dropped.join(', ')} have no ClickHouse equivalent and were dropped.`
    );
  }
}

/** The `INDEX ...` clauses of a table. */
export function buildClickhouseIndexes(
  context: ChEmitContext,
  table: ChTable
): string[] {
  const model: IrModel = table.model;
  const clauses: string[] = [];
  const used: Set<string> = new Set<string>();
  for (const index of model.indexes) {
    const label: string = `${model.name} index (${index.fields.join(', ')})`;
    const columns: string[] = [];
    for (const name of index.fields) {
      const column: string | undefined = columnNameOf(model, name);
      if (column === undefined) {
        context.warnings.push(
          `${model.name}: an index references "${name}", which is not a field of the model; the index was skipped.`
        );
        break;
      }
      columns.push(column);
    }
    if (columns.length !== index.fields.length || columns.length === 0) {
      continue;
    }
    const kinds: ChKind[] = [];
    for (const column of columns) {
      const written = table.columns.find(
        (candidate) => candidate.name === column
      );
      if (written !== undefined) {
        kinds.push(written.type.kind);
      }
    }
    if (kinds.length !== columns.length) {
      context.warnings.push(
        `${label}: the index refers to a column that was not written; the index was skipped.`
      );
      continue;
    }
    const skip: SkipType | undefined = skipTypeOf(
      kinds,
      index.kind === 'fulltext'
    );
    if (skip === undefined) {
      context.warnings.push(
        `${label}: ClickHouse cannot index a Map column with a data-skipping index; the index was skipped.`
      );
      continue;
    }
    warnAboutIndex(context, label, index, skip);
    const wanted: string =
      index.name ?? `${model.tableName}_${columns.join('_')}_idx`;
    let name: string = limitIdentifier(wanted, 128);
    for (let suffix = 2; used.has(name.toLowerCase()); suffix += 1) {
      name = `${limitIdentifier(wanted, 120)}_${suffix}`;
    }
    used.add(name.toLowerCase());
    const expression: string =
      columns.length === 1
        ? chQuote(columns[0] ?? '')
        : `(${columns.map(chQuote).join(', ')})`;
    clauses.push(
      `INDEX ${chQuote(name)} ${expression} TYPE ${skip.type} GRANULARITY ${skip.granularity}`
    );
  }
  return clauses;
}
