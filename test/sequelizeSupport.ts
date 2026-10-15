import type {
  IrField,
  IrIndex,
  IrModel,
  IrOnDelete,
  IrRelation,
  IrSchema,
} from '../src/ir.js';

/**
 * What the Sequelize verification tests share: the shape of what `test/tools/validate-sequelize.mjs` and
 * `validate-sequelize-emitter.mjs` print, and the comparison of that with an IR.
 */

// What validate-sequelize.mjs prints.
export interface DbColumn {
  name: string;
  allowNull: boolean;
}

export interface DbIndex {
  name: string;
  unique: boolean;
  origin: string;
  columns: string[];
}

export interface DbForeignKey {
  column: string;
  table: string;
  to: string;
  onDelete: string;
  onUpdate: string;
}

export interface DbTable {
  columns: DbColumn[];
  primaryKey: string[];
  indexes: DbIndex[];
  foreignKeys: DbForeignKey[];
}

export interface DbSchema {
  tables: Record<string, DbTable>;
}

export const ACTIONS: Readonly<Record<IrOnDelete, string>> = {
  cascade: 'CASCADE',
  setNull: 'SET NULL',
  restrict: 'RESTRICT',
  noAction: 'NO ACTION',
  setDefault: 'SET DEFAULT',
};

function sorted(values: string[]): string[] {
  return [...values].sort();
}

function key(columns: string[]): string {
  return sorted(columns).join(',');
}

/** The column behind a field or relation name of a model. */
function columnOf(model: IrModel, name: string): string {
  return (
    model.fields.find((field: IrField) => field.name === name)?.columnName ??
    model.relations.find((relation: IrRelation) => relation.name === name)
      ?.columnName ??
    name
  );
}

function expectedKeyColumn(
  target: IrModel | undefined,
  relation: IrRelation
): string {
  if (target === undefined) {
    return 'id';
  }
  if (relation.toField !== undefined) {
    return columnOf(target, relation.toField);
  }
  const names: string[] = target.compositePrimaryKey ?? [
    ...target.fields
      .filter((field: IrField) => field.isPrimaryKey)
      .map((field: IrField) => field.name),
    ...target.relations
      .filter((candidate: IrRelation) => candidate.isPrimaryKey === true)
      .map((candidate: IrRelation) => candidate.name),
  ];
  const first: string | undefined = names[0];
  return first === undefined ? 'id' : columnOf(target, first);
}

export interface ComparisonOptions {
  /** Also expect the multi-column foreign keys of `compositeForeignKeys` (only the EF Core writer creates them). */
  compositeForeignKeys?: boolean;
}

/** Lists everything in which the database differs from the IR; empty when they agree. */
export function compareWithDatabase(
  ir: IrSchema,
  db: DbSchema,
  options: ComparisonOptions = {}
): string[] {
  const problems: string[] = [];
  const byTable: Map<string, IrModel> = new Map(
    ir.models.map((model: IrModel): [string, IrModel] => [
      model.tableName,
      model,
    ])
  );
  const byName: Map<string, IrModel> = new Map(
    ir.models.map((model: IrModel): [string, IrModel] => [model.name, model])
  );

  for (const model of ir.models) {
    const table: DbTable | undefined = db.tables[model.tableName];
    if (table === undefined) {
      problems.push(`table ${model.tableName} was not created by the ORM`);
      continue;
    }
    const label: string = model.tableName;
    const relations: IrRelation[] = model.relations.filter(
      (relation: IrRelation) => relation.kind !== 'manyToMany'
    );

    // Columns and nullability. SQLite reports primary key columns as nullable, so they are skipped.
    const primaryColumns: string[] = (
      model.compositePrimaryKey ?? [
        ...model.fields
          .filter((field: IrField) => field.isPrimaryKey)
          .map((field: IrField) => field.name),
        ...relations
          .filter((relation: IrRelation) => relation.isPrimaryKey === true)
          .map((relation: IrRelation) => relation.name),
      ]
    ).map((name: string) => columnOf(model, name));
    const expected: Map<string, boolean> = new Map([
      ...model.fields.map((field: IrField): [string, boolean] => [
        field.columnName,
        field.isNullable,
      ]),
      ...relations.map((relation: IrRelation): [string, boolean] => [
        relation.columnName,
        relation.isNullable,
      ]),
    ]);
    const actual: Map<string, boolean> = new Map(
      table.columns.map((column: DbColumn): [string, boolean] => [
        column.name,
        column.allowNull,
      ])
    );
    if (key([...expected.keys()]) !== key([...actual.keys()])) {
      problems.push(
        `${label}: columns ${key([...actual.keys()])} in the database, ${key([...expected.keys()])} in the IR`
      );
    }
    for (const [column, nullable] of expected) {
      if (
        actual.has(column) &&
        !primaryColumns.includes(column) &&
        actual.get(column) !== nullable
      ) {
        problems.push(
          `${label}.${column}: ${nullable ? 'nullable' : 'NOT NULL'} in the IR, the opposite in the database`
        );
      }
    }

    // Primary key.
    if (key(table.primaryKey) !== key(primaryColumns)) {
      problems.push(
        `${label}: primary key (${key(table.primaryKey)}) in the database, (${key(primaryColumns)}) in the IR`
      );
    }

    // Unique constraints and indexes.
    const uniques: string[] = [
      ...model.fields
        .filter((field: IrField) => field.isUnique && !field.isPrimaryKey)
        .map((field: IrField) => field.columnName),
      ...relations
        .filter(
          (relation: IrRelation) =>
            relation.kind === 'oneToOne' && relation.isPrimaryKey !== true
        )
        .map((relation: IrRelation) => relation.columnName),
      ...model.indexes
        .filter((index: IrIndex) => index.isUnique)
        .map((index: IrIndex) =>
          index.fields.map((name: string) => columnOf(model, name)).join(',')
        ),
    ].map((columns: string) => key(columns.split(',')));
    const dbUniques: string[] = table.indexes
      .filter((index: DbIndex) => index.unique && index.origin !== 'pk')
      .map((index: DbIndex) => key(index.columns));
    if (key(uniques) !== key(dbUniques)) {
      problems.push(
        `${label}: unique keys [${sorted(dbUniques).join(' ')}] in the database, [${sorted(uniques).join(' ')}] in the IR`
      );
    }
    const plain: string[] = model.indexes
      .filter((index: IrIndex) => !index.isUnique)
      .map((index: IrIndex) =>
        key(index.fields.map((name: string) => columnOf(model, name)))
      );
    const dbPlain: string[] = table.indexes
      .filter((index: DbIndex) => !index.unique)
      .map((index: DbIndex) => key(index.columns));
    if (key(plain) !== key(dbPlain)) {
      problems.push(
        `${label}: indexes [${sorted(dbPlain).join(' ')}] in the database, [${sorted(plain).join(' ')}] in the IR`
      );
    }

    // Foreign keys.
    const keys: string[] = relations.map((relation: IrRelation) => {
      const target: IrModel | undefined = byName.get(relation.targetModel);
      return [
        relation.columnName,
        target?.tableName ?? relation.targetModel,
        expectedKeyColumn(target, relation),
        ACTIONS[relation.onDelete],
        relation.onUpdate === undefined
          ? 'any'
          : (ACTIONS[relation.onUpdate] ?? 'any'),
      ].join('|');
    });
    for (const composite of options.compositeForeignKeys === true
      ? (model.compositeForeignKeys ?? [])
      : []) {
      const target: IrModel | undefined = byName.get(composite.targetModel);
      keys.push(
        [
          composite.fields
            .map((name: string) => columnOf(model, name))
            .join(','),
          target?.tableName ?? composite.targetModel,
          composite.references
            .map((name: string) =>
              target === undefined ? name : columnOf(target, name)
            )
            .join(','),
          ACTIONS[composite.onDelete],
          'any',
        ].join('|')
      );
    }
    const dbKeys: string[] = table.foreignKeys.map((foreign: DbForeignKey) => {
      const owner: IrRelation | undefined = relations.find(
        (relation: IrRelation) => relation.columnName === foreign.column
      );
      return [
        foreign.column,
        foreign.table,
        foreign.to,
        foreign.onDelete,
        owner?.onUpdate === undefined ? 'any' : foreign.onUpdate,
      ].join('|');
    });
    if (key(keys) !== key(dbKeys)) {
      problems.push(
        `${label}: foreign keys [${sorted(dbKeys).join(' ')}] in the database, [${sorted(keys).join(' ')}] in the IR`
      );
    }
  }

  // Tables the IR does not list must be the join tables of its many-to-many relations.
  const extra: Set<string> = new Set(
    Object.keys(db.tables).filter((name: string) => !byTable.has(name))
  );
  for (const model of ir.models) {
    for (const relation of model.relations) {
      if (relation.kind !== 'manyToMany') {
        continue;
      }
      const target: IrModel | undefined = byName.get(relation.targetModel);
      const join: string | undefined = [...extra].find((name: string) => {
        const table: DbTable | undefined = db.tables[name];
        const referenced: string[] =
          table?.foreignKeys.map((foreign: DbForeignKey) => foreign.table) ??
          [];
        return (
          key(referenced) === key([model.tableName, target?.tableName ?? ''])
        );
      });
      if (join === undefined) {
        problems.push(
          `${model.tableName}.${relation.name}: no join table between ${model.tableName} and ${target?.tableName ?? relation.targetModel}`
        );
      } else {
        extra.delete(join);
      }
    }
  }
  for (const name of extra) {
    problems.push(`table ${name} exists in the database but not in the IR`);
  }
  return problems;
}
