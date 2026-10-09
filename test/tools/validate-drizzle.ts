/**
 * Loads generated Drizzle schemas with the real Drizzle ORM and drizzle-kit and compares them with
 * the IR.
 *
 * Usage (from the scratch project, after `tsc` compiled it to ./dist and `drizzle-kit generate` ran
 * in each dialect directory):
 *   node dist/validate-drizzle.js <spec.json> <dialect> [<dialect> ...]
 *
 * Dialects are `pg`, `mysql` and `sqlite`, and also the names of the directories that hold the
 * generated project (`<dialect>/schema.ts`, compiled to `dist/<dialect>/schema.js`, with the
 * drizzle-kit output in `<dialect>/drizzle/meta/0000_snapshot.json`). For each one the script
 *
 *  - builds Drizzle's relational configuration for the schema module
 *    (`extractTablesRelationalConfig`, which is what `drizzle()` runs and which throws for a
 *    relation it cannot pair) and checks that both sides of every foreign key exist;
 *  - compares drizzle-kit's snapshot with the spec: tables, columns, nullability, primary keys,
 *    unique constraints, indexes, foreign keys and referential actions, sized and decimal types
 *    and enums.
 *
 * For `sqlite` the script also reads `sqlite/push.db`, which `drizzle-kit push` created, and
 * compares the tables, columns, foreign keys and indexes SQLite reports, then runs a relational
 * query with every relation of every table through `drizzle-orm/better-sqlite3`.
 *
 * Every difference is printed to stderr and the exit code is 1; success prints
 * "drizzle schema verified".
 *
 * This file is compiled inside the scratch project (it imports `drizzle-orm`, which is not a
 * dependency of ormbridge), so it only uses the public Drizzle API.
 */
import Database from 'better-sqlite3';
import {
  createTableRelationsHelpers,
  extractTablesRelationalConfig,
  getTableName,
  type Column,
  type Relation,
  type TablesRelationalConfig,
} from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

interface SpecColumn {
  column: string;
  type: string;
  nullable: boolean;
  unique: boolean;
  primaryKey: boolean;
  maxLength?: number;
  maxDigits?: number;
  enumValues?: string[];
}

interface SpecRelation {
  column: string;
  kind: 'foreignKey' | 'oneToOne';
  targetTable: string;
  nullable: boolean;
  onDelete: string;
  primaryKey: boolean;
}

interface SpecIndex {
  columns: string[];
  unique: boolean;
  name?: string;
}

interface SpecModel {
  name: string;
  table: string;
  columns: SpecColumn[];
  relations: SpecRelation[];
  indexes: SpecIndex[];
  primaryKey: string[];
}

interface Spec {
  models: SpecModel[];
}

interface SnapshotColumn {
  name: string;
  type: string;
  primaryKey: boolean;
  notNull: boolean;
}

interface SnapshotIndex {
  name: string;
  columns: (string | { expression: string })[];
  isUnique: boolean;
}

interface SnapshotTable {
  name: string;
  columns: Record<string, SnapshotColumn>;
  indexes: Record<string, SnapshotIndex>;
  foreignKeys: Record<
    string,
    {
      tableFrom: string;
      tableTo: string;
      columnsFrom: string[];
      columnsTo: string[];
      onDelete: string;
    }
  >;
  compositePrimaryKeys: Record<string, { columns: string[] }>;
  uniqueConstraints: Record<string, { columns: string[] }>;
}

interface Snapshot {
  tables: Record<string, SnapshotTable>;
  enums?: Record<string, { name: string; values: string[] }>;
}

const ON_DELETE: Readonly<Record<string, string>> = {
  cascade: 'cascade',
  setNull: 'set null',
  restrict: 'restrict',
  noAction: 'no action',
  setDefault: 'set default',
};

const problems: string[] = [];

function report(dialect: string, message: string): void {
  problems.push(`${dialect}: ${message}`);
}

function sameSet(first: readonly string[], second: readonly string[]): boolean {
  return (
    first.length === second.length &&
    [...first].sort().join('\u0000') === [...second].sort().join('\u0000')
  );
}

function columnNamesOf(model: SpecModel): string[] {
  return [
    ...model.columns.map((column: SpecColumn) => column.column),
    ...model.relations.map((relation: SpecRelation) => relation.column),
  ];
}

/** The column lists that must be unique: unique fields, one-to-one relations and unique indexes. */
function expectedUniqueSets(model: SpecModel): string[][] {
  const sets: string[][] = [];
  for (const column of model.columns) {
    if (column.unique && !column.primaryKey) {
      sets.push([column.column]);
    }
  }
  for (const relation of model.relations) {
    if (relation.kind === 'oneToOne' && !relation.primaryKey) {
      sets.push([relation.column]);
    }
  }
  for (const index of model.indexes) {
    if (index.unique) {
      sets.push(index.columns);
    }
  }
  return sets;
}

function expectedPlainIndexes(model: SpecModel): string[][] {
  return model.indexes
    .filter((index: SpecIndex) => !index.unique)
    .map((index: SpecIndex) => index.columns);
}

function containsSet(sets: string[][], wanted: string[]): boolean {
  return sets.some((candidate: string[]) => sameSet(candidate, wanted));
}

// ---------------------------------------------------------------------------
// drizzle-kit snapshot
// ---------------------------------------------------------------------------

function checkSnapshot(dialect: string, spec: Spec, snapshot: Snapshot): void {
  const tables: SnapshotTable[] = Object.values(snapshot.tables);
  const wantedTables: string[] = spec.models.map(
    (model: SpecModel) => model.table
  );
  const foundTables: string[] = tables.map(
    (table: SnapshotTable) => table.name
  );
  if (!sameSet(wantedTables, foundTables)) {
    report(
      dialect,
      `tables differ: expected ${wantedTables.join(', ')}, found ${foundTables.join(', ')}`
    );
  }
  const enumValueLists: string[][] = Object.values(snapshot.enums ?? {}).map(
    (definition) => definition.values
  );

  for (const model of spec.models) {
    const table: SnapshotTable | undefined = tables.find(
      (candidate: SnapshotTable) => candidate.name === model.table
    );
    if (table === undefined) {
      continue;
    }
    const label: string = `${dialect} ${model.table}`;
    const columns: SnapshotColumn[] = Object.values(table.columns);
    if (
      !sameSet(
        columnNamesOf(model),
        columns.map((column: SnapshotColumn) => column.name)
      )
    ) {
      report(
        label,
        `columns differ: expected ${columnNamesOf(model).join(', ')}, found ${columns.map((column) => column.name).join(', ')}`
      );
    }

    const primaryKey: string[] = [
      ...columns
        .filter((column: SnapshotColumn) => column.primaryKey)
        .map((column: SnapshotColumn) => column.name),
      ...Object.values(table.compositePrimaryKeys).flatMap(
        (key) => key.columns
      ),
    ];
    if (!sameSet([...new Set(primaryKey)], model.primaryKey)) {
      report(
        label,
        `primary key differs: expected (${model.primaryKey.join(', ')}), found (${[...new Set(primaryKey)].join(', ')})`
      );
    }

    for (const column of model.columns) {
      const found: SnapshotColumn | undefined = columns.find(
        (candidate: SnapshotColumn) => candidate.name === column.column
      );
      if (found === undefined) {
        continue;
      }
      if (!column.primaryKey && found.notNull === column.nullable) {
        report(
          label,
          `${column.column} should be ${column.nullable ? 'nullable' : 'NOT NULL'}`
        );
      }
      if (dialect !== 'sqlite') {
        checkColumnType(label, column, found, enumValueLists);
      }
    }
    for (const relation of model.relations) {
      const found: SnapshotColumn | undefined = columns.find(
        (candidate: SnapshotColumn) => candidate.name === relation.column
      );
      if (
        found !== undefined &&
        !relation.primaryKey &&
        found.notNull === relation.nullable
      ) {
        report(
          label,
          `${relation.column} should be ${relation.nullable ? 'nullable' : 'NOT NULL'}`
        );
      }
    }

    const uniqueSets: string[][] = [
      ...Object.values(table.uniqueConstraints).map((unique) => unique.columns),
      ...Object.values(table.indexes)
        .filter((index: SnapshotIndex) => index.isUnique)
        .map((index: SnapshotIndex) => indexColumns(index)),
    ];
    for (const wanted of expectedUniqueSets(model)) {
      if (!containsSet(uniqueSets, wanted)) {
        report(label, `no unique constraint on (${wanted.join(', ')})`);
      }
    }
    const plainIndexes: string[][] = Object.values(table.indexes)
      .filter((index: SnapshotIndex) => !index.isUnique)
      .map((index: SnapshotIndex) => indexColumns(index));
    for (const wanted of expectedPlainIndexes(model)) {
      if (!containsSet(plainIndexes, wanted)) {
        report(label, `no index on (${wanted.join(', ')})`);
      }
    }
    for (const index of model.indexes) {
      if (
        index.name !== undefined &&
        !Object.values(table.indexes).some(
          (candidate: SnapshotIndex) => candidate.name === index.name
        )
      ) {
        report(label, `no index named ${index.name}`);
      }
    }

    const foreignKeys = Object.values(table.foreignKeys);
    if (foreignKeys.length !== model.relations.length) {
      report(
        label,
        `expected ${model.relations.length} foreign key(s), found ${foreignKeys.length}`
      );
    }
    for (const relation of model.relations) {
      const found = foreignKeys.find((key) =>
        sameSet(key.columnsFrom, [relation.column])
      );
      if (found === undefined) {
        report(label, `no foreign key on ${relation.column}`);
        continue;
      }
      if (found.tableTo !== relation.targetTable) {
        report(
          label,
          `${relation.column} references ${found.tableTo}, expected ${relation.targetTable}`
        );
      }
      const wantedAction: string = ON_DELETE[relation.onDelete] ?? 'no action';
      if (found.onDelete !== wantedAction) {
        report(
          label,
          `${relation.column} has ON DELETE ${found.onDelete}, expected ${wantedAction}`
        );
      }
    }
  }
}

function indexColumns(index: SnapshotIndex): string[] {
  return index.columns.map((column) =>
    typeof column === 'string' ? column : column.expression
  );
}

function checkColumnType(
  label: string,
  column: SpecColumn,
  found: SnapshotColumn,
  enumValueLists: string[][]
): void {
  if (column.type === 'array') {
    // Arrays are checked for their presence only: the element type is not part of the spec.
    return;
  }
  if (column.enumValues !== undefined) {
    const matches: boolean =
      found.type.startsWith('enum(') ||
      enumValueLists.some((values: string[]) =>
        sameSet(values, column.enumValues ?? [])
      );
    if (!matches) {
      report(
        label,
        `${column.column} is not backed by an enum (${found.type})`
      );
    }
    return;
  }
  if (column.type === 'string' && column.maxLength !== undefined) {
    if (!found.type.includes(`(${column.maxLength})`)) {
      report(
        label,
        `${column.column} should have length ${column.maxLength}, found ${found.type}`
      );
    }
  }
  if (column.type === 'decimal' && column.maxDigits !== undefined) {
    if (!found.type.includes(`(${column.maxDigits}`)) {
      report(
        label,
        `${column.column} should have precision ${column.maxDigits}, found ${found.type}`
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Drizzle's relational configuration
// ---------------------------------------------------------------------------

function checkRelations(
  dialect: string,
  spec: Spec,
  schemaModule: Record<string, unknown>
): TablesRelationalConfig | undefined {
  let config: TablesRelationalConfig;
  try {
    config = extractTablesRelationalConfig(
      schemaModule,
      createTableRelationsHelpers
    ).tables;
  } catch (error) {
    report(
      dialect,
      `Drizzle rejected the relations: ${error instanceof Error ? error.message : String(error)}`
    );
    return undefined;
  }
  const byDbName = (name: string) =>
    Object.values(config).find((table) => table.dbName === name);
  for (const model of spec.models) {
    const table = byDbName(model.table);
    if (table === undefined) {
      report(dialect, `${model.table} is missing from the relational config`);
      continue;
    }
    const relations: Relation[] = Object.values(table.relations);
    for (const relation of model.relations) {
      const forward: Relation | undefined = relations.find(
        (candidate: Relation) =>
          getTableName(candidate.referencedTable) === relation.targetTable &&
          sameSet(
            fieldsOf(candidate).map((column: Column) => column.name),
            [relation.column]
          )
      );
      if (forward === undefined) {
        report(
          dialect,
          `${model.table}.${relation.column} has no relation to ${relation.targetTable}`
        );
      }
      const target = byDbName(relation.targetTable);
      const inverse: boolean =
        target !== undefined &&
        Object.values(target.relations).some(
          (candidate: Relation) =>
            getTableName(candidate.referencedTable) === model.table &&
            fieldsOf(candidate).length === 0
        );
      if (!inverse) {
        report(
          dialect,
          `${relation.targetTable} has no inverse relation to ${model.table} (${relation.column})`
        );
      }
    }
  }
  return config;
}

function fieldsOf(relation: Relation): Column[] {
  const config: { fields?: Column[] } | undefined = (
    relation as unknown as { config?: { fields?: Column[] } }
  ).config;
  return config?.fields ?? [];
}

// ---------------------------------------------------------------------------
// SQLite
// ---------------------------------------------------------------------------

interface TableInfoRow {
  name: string;
  notnull: number;
  pk: number;
}

interface ForeignKeyRow {
  from: string;
  table: string;
  on_delete: string;
}

interface IndexListRow {
  name: string;
  unique: number;
  origin: string;
}

interface IndexInfoRow {
  name: string;
}

function checkSqlite(
  spec: Spec,
  databasePath: string,
  schemaModule: Record<string, unknown>,
  config: TablesRelationalConfig | undefined
): void {
  const database: Database.Database = new Database(databasePath);
  try {
    const found: string[] = (
      database
        .prepare(
          `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '\\_\\_drizzle%' ESCAPE '\\'`
        )
        .all() as { name: string }[]
    ).map((row: { name: string }) => row.name);
    const wanted: string[] = spec.models.map((model: SpecModel) => model.table);
    if (!sameSet(wanted, found)) {
      report(
        'sqlite db',
        `tables differ: expected ${wanted.join(', ')}, found ${found.join(', ')}`
      );
    }
    for (const model of spec.models) {
      const label: string = `sqlite db ${model.table}`;
      const columns: TableInfoRow[] = database
        .prepare(`PRAGMA table_info("${model.table}")`)
        .all() as TableInfoRow[];
      if (
        !sameSet(
          columnNamesOf(model),
          columns.map((column: TableInfoRow) => column.name)
        )
      ) {
        report(
          label,
          `columns differ: expected ${columnNamesOf(model).join(', ')}, found ${columns.map((column) => column.name).join(', ')}`
        );
      }
      const primaryKey: string[] = columns
        .filter((column: TableInfoRow) => column.pk > 0)
        .map((column: TableInfoRow) => column.name);
      if (!sameSet(primaryKey, model.primaryKey)) {
        report(
          label,
          `primary key differs: expected (${model.primaryKey.join(', ')}), found (${primaryKey.join(', ')})`
        );
      }
      const nullable = new Map<string, boolean>([
        ...model.columns.map((column: SpecColumn): [string, boolean] => [
          column.column,
          column.nullable || column.primaryKey,
        ]),
        ...model.relations.map((relation: SpecRelation): [string, boolean] => [
          relation.column,
          relation.nullable,
        ]),
      ]);
      for (const column of columns) {
        const isPrimary: boolean = model.primaryKey.includes(column.name);
        if (
          !isPrimary &&
          nullable.has(column.name) &&
          (column.notnull === 0) !== nullable.get(column.name)
        ) {
          report(label, `${column.name} has the wrong nullability`);
        }
      }

      const foreignKeys: ForeignKeyRow[] = database
        .prepare(`PRAGMA foreign_key_list("${model.table}")`)
        .all() as ForeignKeyRow[];
      if (foreignKeys.length !== model.relations.length) {
        report(
          label,
          `expected ${model.relations.length} foreign key(s), found ${foreignKeys.length}`
        );
      }
      for (const relation of model.relations) {
        const key: ForeignKeyRow | undefined = foreignKeys.find(
          (candidate: ForeignKeyRow) => candidate.from === relation.column
        );
        if (key === undefined) {
          report(label, `no foreign key on ${relation.column}`);
          continue;
        }
        if (key.table !== relation.targetTable) {
          report(
            label,
            `${relation.column} references ${key.table}, expected ${relation.targetTable}`
          );
        }
        const action: string = (
          ON_DELETE[relation.onDelete] ?? 'no action'
        ).toUpperCase();
        if (key.on_delete !== action) {
          report(
            label,
            `${relation.column} has ON DELETE ${key.on_delete}, expected ${action}`
          );
        }
      }

      const indexes: IndexListRow[] = database
        .prepare(`PRAGMA index_list("${model.table}")`)
        .all() as IndexListRow[];
      const uniqueSets: string[][] = [];
      const plainSets: string[][] = [];
      for (const index of indexes) {
        if (index.origin === 'pk') {
          continue;
        }
        const indexColumns: string[] = (
          database
            .prepare(`PRAGMA index_info("${index.name}")`)
            .all() as IndexInfoRow[]
        ).map((row: IndexInfoRow) => row.name);
        (index.unique === 1 ? uniqueSets : plainSets).push(indexColumns);
      }
      for (const set of expectedUniqueSets(model)) {
        if (!containsSet(uniqueSets, set)) {
          report(label, `no unique index on (${set.join(', ')})`);
        }
      }
      for (const set of expectedPlainIndexes(model)) {
        if (!containsSet(plainSets, set)) {
          report(label, `no index on (${set.join(', ')})`);
        }
      }
    }

    // Every relation of every table must work in a relational query.
    if (config !== undefined) {
      const db = drizzle(database, { schema: schemaModule });
      const query = db.query as unknown as Record<
        string,
        { findMany: (options: object) => { sync: () => unknown } }
      >;
      for (const [tsName, table] of Object.entries(config)) {
        const withRelations: Record<string, true> = Object.fromEntries(
          Object.keys(table.relations).map((key: string) => [key, true])
        );
        const builder = query[tsName];
        if (builder === undefined) {
          report('sqlite db', `no query builder for ${tsName}`);
          continue;
        }
        try {
          builder.findMany({ with: withRelations, limit: 1 }).sync();
        } catch (error) {
          report(
            'sqlite db',
            `the relational query for ${tsName} failed: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      }
    }
  } finally {
    database.close();
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): void {
  const [specPath, ...dialects] = process.argv.slice(2);
  if (specPath === undefined || dialects.length === 0) {
    process.stderr.write(
      'usage: validate-drizzle <spec.json> <dialect> [<dialect> ...]\n'
    );
    process.exit(2);
  }
  const spec: Spec = JSON.parse(readFileSync(specPath, 'utf8')) as Spec;
  for (const dialect of dialects) {
    const snapshotPath: string = join(
      dialect,
      'drizzle',
      'meta',
      '0000_snapshot.json'
    );
    if (!existsSync(snapshotPath)) {
      report(dialect, `drizzle-kit wrote no snapshot (${snapshotPath})`);
      continue;
    }
    checkSnapshot(
      dialect,
      spec,
      JSON.parse(readFileSync(snapshotPath, 'utf8')) as Snapshot
    );
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const schemaModule = require(`./${dialect}/schema.js`) as Record<
      string,
      unknown
    >;
    const config: TablesRelationalConfig | undefined = checkRelations(
      dialect,
      spec,
      schemaModule
    );
    if (dialect === 'sqlite') {
      const databasePath: string = join(dialect, 'push.db');
      if (existsSync(databasePath)) {
        checkSqlite(spec, databasePath, schemaModule, config);
      } else {
        report(dialect, 'drizzle-kit push created no database');
      }
    }
  }
  if (problems.length > 0) {
    process.stderr.write(`${problems.join('\n')}\n`);
    process.exit(1);
  }
  process.stdout.write('drizzle schema verified\n');
}

main();
