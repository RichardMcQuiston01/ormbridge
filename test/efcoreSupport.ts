import type { IrModel, IrRelation, IrSchema } from '../src/ir.js';
import type {
  DbColumn,
  DbForeignKey,
  DbIndex,
  DbSchema,
  DbTable,
} from './sequelizeSupport.js';

/**
 * What `test/tools/efcore-verify` prints for one DbContext: the tables of the SQLite database that EF Core
 * creates (`EnsureCreated`), straight from the `PRAGMA` statements.
 */
export interface EfcoreColumn {
  name: string;
  type: string;
  notNull: boolean;
  /** Position in the primary key, 0 when the column is not part of it. */
  primaryKey: number;
  /** True for computed columns, which SQLite reports as nullable. */
  generated: boolean;
  default: string | null;
}

export interface EfcoreForeignKey {
  table: string;
  from: string[];
  to: string[];
  onDelete: string;
  onUpdate: string;
}

export interface EfcoreTable {
  columns: EfcoreColumn[];
  indexes: DbIndex[];
  foreignKeys: EfcoreForeignKey[];
}

export type EfcoreDatabase = Record<string, EfcoreTable>;

/** The tool prints one database per DbContext type name. */
export type EfcoreToolOutput = Record<string, EfcoreDatabase>;

/**
 * Turns the tool output into the shape the shared comparison reads. Two things EF Core adds on its own are
 * left out because the model never asked for them: the index on every foreign key column (`IX_<table>_<column>`),
 * unless the IR lists the index, and the null flag of computed columns, which SQLite does not report.
 */
export function toDbSchema(database: EfcoreDatabase, ir: IrSchema): DbSchema {
  const tables: Record<string, DbTable> = {};
  for (const [name, table] of Object.entries(database)) {
    const model: IrModel | undefined = ir.models.find(
      (candidate: IrModel) => candidate.tableName === name
    );
    const foreignColumns: Set<string> = new Set(
      table.foreignKeys.map((foreign: EfcoreForeignKey) =>
        [...foreign.from].sort().join(',')
      )
    );
    const declared: Set<string> = new Set(
      (model?.indexes ?? []).map((index) =>
        index.fields
          .map(
            (field: string) =>
              model?.fields.find((candidate) => candidate.name === field)
                ?.columnName ??
              model?.relations.find(
                (candidate: IrRelation) => candidate.name === field
              )?.columnName ??
              field
          )
          .sort()
          .join(',')
      )
    );
    const columns: DbColumn[] = table.columns.map(
      (column: EfcoreColumn): DbColumn => {
        const irField = model?.fields.find(
          (candidate) => candidate.columnName === column.name
        );
        return {
          name: column.name,
          allowNull:
            column.generated && irField !== undefined
              ? irField.isNullable
              : !column.notNull,
        };
      }
    );
    const indexes: DbIndex[] = table.indexes.filter((index: DbIndex) => {
      const key: string = [...index.columns].sort().join(',');
      const isAutomatic: boolean =
        !index.unique &&
        index.name.startsWith('IX_') &&
        foreignColumns.has(key) &&
        !declared.has(key);
      return !isAutomatic;
    });
    const foreignKeys: DbForeignKey[] = table.foreignKeys.map(
      (foreign: EfcoreForeignKey): DbForeignKey => ({
        column: foreign.from.join(','),
        table: foreign.table,
        to: foreign.to.join(','),
        onDelete: foreign.onDelete,
        onUpdate: foreign.onUpdate,
      })
    );
    tables[name] = {
      columns,
      primaryKey: table.columns
        .filter((column: EfcoreColumn) => column.primaryKey > 0)
        .sort(
          (first: EfcoreColumn, second: EfcoreColumn) =>
            first.primaryKey - second.primaryKey
        )
        .map((column: EfcoreColumn) => column.name),
      indexes,
      foreignKeys,
    };
  }
  return { tables };
}
