import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type {
  IrCompositeForeignKey,
  IrField,
  IrIndex,
  IrModel,
  IrOnDelete,
  IrRelation,
  IrSchema,
} from '../src/ir.js';
import { parseSqlDdl } from '../src/parsers/sqlDdl.js';
import { expectOk } from './helpers.js';
import { titleWithReason, type ToolProbe } from './realToolSupport.js';

/**
 * Runs the SQLite fixtures in a real SQLite database and compares the schema the database reports
 * (tables, columns, nullability, type affinity, primary keys, generated columns, foreign keys and their
 * actions, unique constraints and indexes) with what the SQL parser read from the same text.
 *
 * SQLite comes from better-sqlite3 (set SQLITE_DIR to a directory where `npm install better-sqlite3` has
 * been run; DRIZZLE_DIR and TYPEORM_DIR already have it) or, when that is missing, from the `sqlite3`
 * command line shell. The tests are skipped with a reason in their title when neither is available.
 */

interface Row {
  [column: string]: string | number | null;
}

interface Database {
  /** Name of the driver, for the test titles. */
  driver: string;
  /** Runs the fixture and returns a function that answers queries against the resulting database. */
  load(script: string): (query: string) => Row[];
}

interface BetterSqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): { all(): Row[] };
}

function betterSqlite(): Database | undefined {
  for (const name of ['SQLITE_DIR', 'DRIZZLE_DIR', 'TYPEORM_DIR']) {
    const directory: string = process.env[name] ?? '';
    if (
      directory === '' ||
      !existsSync(
        join(directory, 'node_modules', 'better-sqlite3', 'package.json')
      )
    ) {
      continue;
    }
    try {
      const requireFromTools: NodeRequire = createRequire(
        join(directory, 'package.json')
      );
      const Constructor = requireFromTools('better-sqlite3') as new (
        path: string
      ) => BetterSqliteDatabase;
      // Loading the module is not enough: the native part must open a database.
      new Constructor(':memory:').exec('SELECT 1');
      return {
        driver: `better-sqlite3 (${name})`,
        load: (script: string): ((query: string) => Row[]) => {
          const database: BetterSqliteDatabase = new Constructor(':memory:');
          database.exec(script);
          return (query: string): Row[] => database.prepare(query).all();
        },
      };
    } catch {
      continue;
    }
  }
  return undefined;
}

function sqliteShell(): Database | undefined {
  const version: SpawnSyncReturns<string> = spawnSync('sqlite3', ['-version'], {
    encoding: 'utf8',
    timeout: 20_000,
  });
  if (version.error !== undefined || version.status !== 0) {
    return undefined;
  }
  return {
    driver: 'the sqlite3 shell',
    load: (script: string): ((query: string) => Row[]) => {
      return (query: string): Row[] => {
        const run: SpawnSyncReturns<string> = spawnSync(
          'sqlite3',
          ['-json', ':memory:'],
          {
            encoding: 'utf8',
            input: `${script}\n${query};\n`,
            timeout: 60_000,
          }
        );
        if (run.status !== 0) {
          throw new Error(`sqlite3 failed: ${run.stderr}`);
        }
        const text: string = run.stdout.trim();
        return text === '' ? [] : (JSON.parse(text) as Row[]);
      };
    },
  };
}

const database: Database | undefined = betterSqlite() ?? sqliteShell();
const probe: ToolProbe = database
  ? { available: true, reason: '' }
  : {
      available: false,
      reason:
        'set SQLITE_DIR to a directory with better-sqlite3 installed, or install the sqlite3 shell (see test/README.md)',
    };

const FIXTURES: string = fileURLToPath(new URL('./fixtures/', import.meta.url));

const GROUPS: readonly { label: string; file: string }[] = [
  { label: 'canonical blog schema', file: 'sql/sqlite/blog.sql' },
  { label: 'extras (notes)', file: 'sql-extras/notes.sqlite.sql' },
];

const ACTIONS: Readonly<Record<IrOnDelete, string>> = {
  cascade: 'CASCADE',
  setNull: 'SET NULL',
  restrict: 'RESTRICT',
  noAction: 'NO ACTION',
  setDefault: 'SET DEFAULT',
};

type Affinity = 'INTEGER' | 'TEXT' | 'BLOB' | 'REAL' | 'NUMERIC';

/** SQLite's rules for the affinity of a declared type (section 3.1 of "Datatypes In SQLite"). */
function affinityOf(declared: string): Affinity {
  const type: string = declared.toUpperCase();
  if (type.includes('INT')) {
    return 'INTEGER';
  }
  if (/CHAR|CLOB|TEXT/.test(type)) {
    return 'TEXT';
  }
  if (type === '' || type.includes('BLOB')) {
    return 'BLOB';
  }
  if (/REAL|FLOA|DOUB/.test(type)) {
    return 'REAL';
  }
  return 'NUMERIC';
}

const EXPECTED_AFFINITY: Readonly<Record<string, Affinity>> = {
  int: 'INTEGER',
  bigInt: 'INTEGER',
  float: 'REAL',
  string: 'TEXT',
  text: 'TEXT',
  bytes: 'BLOB',
  decimal: 'NUMERIC',
  boolean: 'NUMERIC',
  dateTime: 'NUMERIC',
  date: 'NUMERIC',
  time: 'NUMERIC',
  json: 'NUMERIC',
};

const COLUMNS_QUERY: string = `SELECT m.name AS tbl, p.cid, p.name, p.type, p."notnull" AS "notnull", p.dflt_value, p.pk, p.hidden
  FROM sqlite_master m JOIN pragma_table_xinfo(m.name) p
  WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite_%' ORDER BY m.name, p.cid`;
const FOREIGN_KEYS_QUERY: string = `SELECT m.name AS tbl, f.id, f.seq, f."table" AS ref_table, f."from" AS from_col, f."to" AS to_col, f.on_update, f.on_delete
  FROM sqlite_master m JOIN pragma_foreign_key_list(m.name) f
  WHERE m.type = 'table' ORDER BY m.name, f.id, f.seq`;
const INDEXES_QUERY: string = `SELECT m.name AS tbl, i.name AS idx, i."unique" AS is_unique, i.origin, i.partial, c.seqno, c.name AS col
  FROM sqlite_master m JOIN pragma_index_list(m.name) i JOIN pragma_index_info(i.name) c
  WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite_%' ORDER BY m.name, i.name, c.seqno`;

interface DbIndex {
  name: string;
  unique: boolean;
  origin: string;
  columns: string[];
}

function group<T>(rows: T[], key: (row: T) => string): Map<string, T[]> {
  const grouped: Map<string, T[]> = new Map<string, T[]>();
  for (const row of rows) {
    const list: T[] = grouped.get(key(row)) ?? [];
    list.push(row);
    grouped.set(key(row), list);
  }
  return grouped;
}

/** The column behind an IR name: a field, or a relation that replaced its foreign-key column. */
function columnOfName(model: IrModel, name: string): string {
  const field: IrField | undefined = model.fields.find(
    (candidate: IrField) => candidate.name === name
  );
  if (field !== undefined) {
    return field.columnName;
  }
  const relation: IrRelation | undefined = model.relations.find(
    (candidate: IrRelation) => candidate.name === name
  );
  if (relation !== undefined) {
    return relation.columnName;
  }
  throw new Error(`${model.name} has no field or relation ${name}.`);
}

function compareWithDatabase(
  schema: IrSchema,
  query: (sql: string) => Row[]
): void {
  const columnRows: Row[] = query(COLUMNS_QUERY);
  const foreignKeyRows: Row[] = query(FOREIGN_KEYS_QUERY);
  const indexRows: Row[] = query(INDEXES_QUERY);
  const columnsByTable: Map<string, Row[]> = group(columnRows, (row: Row) =>
    String(row.tbl)
  );
  const foreignKeysByTable: Map<string, Row[]> = group(
    foreignKeyRows,
    (row: Row) => String(row.tbl)
  );
  const indexesByTable: Map<string, DbIndex[]> = new Map<string, DbIndex[]>();
  for (const [table, rows] of group(indexRows, (row: Row) => String(row.tbl))) {
    const indexes: DbIndex[] = [];
    for (const [name, parts] of group(rows, (row: Row) => String(row.idx))) {
      indexes.push({
        name,
        unique: Number(parts[0]?.is_unique) === 1,
        origin: String(parts[0]?.origin),
        columns: parts.map((part: Row) => String(part.col)),
      });
    }
    indexesByTable.set(table, indexes);
  }

  // Tables: every model, plus the join table behind each many-to-many relation.
  const expectedTables: string[] = schema.models.map(
    (model: IrModel) => model.tableName
  );
  for (const model of schema.models) {
    for (const relation of model.relations) {
      if (relation.kind === 'manyToMany') {
        expectedTables.push(`${model.tableName}_${relation.name}`);
      }
    }
  }
  expect([...columnsByTable.keys()].sort()).toEqual(expectedTables.sort());

  for (const model of schema.models) {
    const label: string = model.tableName;
    const columns: Row[] = columnsByTable.get(model.tableName) ?? [];
    const byName: Map<string, Row> = new Map<string, Row>(
      columns.map((column: Row) => [String(column.name), column])
    );

    // Columns: one per field and one per foreign key that replaced its column.
    const expectedColumns: string[] = [
      ...model.fields.map((field: IrField) => field.columnName),
      ...model.relations
        .filter((relation: IrRelation) => relation.kind !== 'manyToMany')
        .map((relation: IrRelation) => relation.columnName),
    ];
    expect([...byName.keys()].sort(), `${label}: columns`).toEqual(
      expectedColumns.sort()
    );

    const primaryKeyColumns: string[] = columns
      .filter((column: Row) => Number(column.pk) > 0)
      .sort((left: Row, right: Row) => Number(left.pk) - Number(right.pk))
      .map((column: Row) => String(column.name));
    const expectedKey: string[] =
      model.compositePrimaryKey !== undefined
        ? model.compositePrimaryKey.map((name: string) =>
            columnOfName(model, name)
          )
        : [
            ...model.fields
              .filter((field: IrField) => field.isPrimaryKey)
              .map((field: IrField) => field.columnName),
            ...model.relations
              .filter((relation: IrRelation) => relation.isPrimaryKey === true)
              .map((relation: IrRelation) => relation.columnName),
          ];
    expect(primaryKeyColumns, `${label}: primary key`).toEqual(expectedKey);

    for (const field of model.fields) {
      const column: Row | undefined = byName.get(field.columnName);
      if (column === undefined) {
        continue;
      }
      const where: string = `${label}.${field.columnName}`;
      const notNull: boolean =
        Number(column.notnull) === 1 || Number(column.pk) > 0;
      expect(notNull, `${where}: NOT NULL`).toBe(!field.isNullable);
      const expectedAffinity: Affinity | undefined =
        EXPECTED_AFFINITY[field.type];
      if (expectedAffinity !== undefined) {
        expect(affinityOf(String(column.type)), `${where}: affinity`).toBe(
          expectedAffinity
        );
      }
      const hidden: number = Number(column.hidden);
      expect(hidden === 2 || hidden === 3, `${where}: generated`).toBe(
        field.generated !== undefined
      );
      if (field.generated !== undefined) {
        expect(hidden === 3, `${where}: stored`).toBe(field.generated.isStored);
      }
      if (field.default?.kind === 'autoIncrement') {
        // SQLite fills an INTEGER PRIMARY KEY (a rowid alias) on insert.
        expect(String(column.type).toUpperCase(), where).toBe('INTEGER');
        expect(Number(column.pk), where).toBe(1);
      } else if (field.default !== undefined) {
        expect(column.dflt_value, `${where}: has a default`).not.toBeNull();
      } else if (field.generated === undefined) {
        expect(column.dflt_value, `${where}: has no default`).toBeNull();
      }
    }
    for (const relation of model.relations) {
      if (relation.kind === 'manyToMany') {
        continue;
      }
      const column: Row | undefined = byName.get(relation.columnName);
      const notNull: boolean =
        Number(column?.notnull) === 1 || Number(column?.pk) > 0;
      expect(notNull, `${label}.${relation.columnName}: NOT NULL`).toBe(
        !relation.isNullable
      );
    }

    // Foreign keys.
    const foreignKeys: Map<string, Row[]> = group(
      foreignKeysByTable.get(model.tableName) ?? [],
      (row: Row) => String(row.id)
    );
    const found: string[] = [...foreignKeys.values()].map((rows: Row[]) =>
      [
        rows.map((row: Row) => String(row.from_col)).join('+'),
        String(rows[0]?.ref_table),
        rows.map((row: Row) => String(row.to_col)).join('+'),
        String(rows[0]?.on_delete),
        String(rows[0]?.on_update),
      ].join(' | ')
    );
    const targetOf = (name: string): IrModel => {
      const target: IrModel | undefined = schema.models.find(
        (candidate: IrModel) => candidate.name === name
      );
      if (target === undefined) {
        throw new Error(`No model ${name}.`);
      }
      return target;
    };
    const expected: string[] = [];
    for (const relation of model.relations) {
      if (relation.kind === 'manyToMany') {
        continue;
      }
      const target: IrModel = targetOf(relation.targetModel);
      const targetColumn: string =
        relation.toField === undefined
          ? (target.fields.find((field: IrField) => field.isPrimaryKey)
              ?.columnName ??
            target.relations.find(
              (candidate: IrRelation) => candidate.isPrimaryKey === true
            )?.columnName ??
            '')
          : columnOfName(target, relation.toField);
      expected.push(
        [
          relation.columnName,
          target.tableName,
          targetColumn,
          ACTIONS[relation.onDelete],
          ACTIONS[relation.onUpdate ?? 'noAction'],
        ].join(' | ')
      );
    }
    for (const composite of model.compositeForeignKeys ?? []) {
      const target: IrModel = targetOf(composite.targetModel);
      const key: IrCompositeForeignKey = composite;
      expected.push(
        [
          key.fields.map((name: string) => columnOfName(model, name)).join('+'),
          target.tableName,
          key.references
            .map((name: string) => columnOfName(target, name))
            .join('+'),
          ACTIONS[key.onDelete],
          ACTIONS[key.onUpdate ?? 'noAction'],
        ].join(' | ')
      );
    }
    expect(found.sort(), `${label}: foreign keys`).toEqual(expected.sort());

    // Unique constraints and indexes. A unique foreign key is a one-to-one relation, so its
    // constraint is expected too.
    const dbIndexes: DbIndex[] = indexesByTable.get(model.tableName) ?? [];
    const dbUnique: string[] = dbIndexes
      .filter((index: DbIndex) => index.unique && index.origin !== 'pk')
      .map((index: DbIndex) => index.columns.join('+'));
    const expectedUnique: string[] = [
      ...model.fields
        .filter((field: IrField) => field.isUnique)
        .map((field: IrField) => field.columnName),
      ...model.relations
        .filter(
          (relation: IrRelation) =>
            relation.kind === 'oneToOne' && relation.isPrimaryKey !== true
        )
        .map((relation: IrRelation) => relation.columnName),
      ...model.indexes
        .filter((index: IrIndex) => index.isUnique)
        .map((index: IrIndex) =>
          index.fields
            .map((name: string) => columnOfName(model, name))
            .join('+')
        ),
    ];
    expect(dbUnique.sort(), `${label}: unique constraints`).toEqual(
      expectedUnique.sort()
    );
    for (const index of model.indexes.filter(
      (candidate: IrIndex) => candidate.name !== undefined
    )) {
      const match: DbIndex | undefined = dbIndexes.find(
        (candidate: DbIndex) => candidate.name === index.name
      );
      expect(match, `${label}: index ${index.name}`).toBeDefined();
      expect(match?.columns).toEqual(
        index.fields.map((name: string) => columnOfName(model, name))
      );
      expect(match?.unique).toBe(index.isUnique);
    }
    const plain: string[] = dbIndexes
      .filter((index: DbIndex) => !index.unique)
      .map((index: DbIndex) => index.columns.join('+'));
    expect(plain.sort(), `${label}: plain indexes`).toEqual(
      model.indexes
        .filter((index: IrIndex) => !index.isUnique)
        .map((index: IrIndex) =>
          index.fields
            .map((name: string) => columnOfName(model, name))
            .join('+')
        )
        .sort()
    );
  }

  // The join table of each many-to-many relation has exactly the two foreign keys.
  for (const model of schema.models) {
    for (const relation of model.relations) {
      if (relation.kind !== 'manyToMany') {
        continue;
      }
      const joinTable: string = `${model.tableName}_${relation.name}`;
      const target: IrModel | undefined = schema.models.find(
        (candidate: IrModel) => candidate.name === relation.targetModel
      );
      const keys: string[] = [
        ...group(foreignKeysByTable.get(joinTable) ?? [], (row: Row) =>
          String(row.id)
        ).values(),
      ].map((rows: Row[]) => String(rows[0]?.ref_table));
      expect(keys.sort(), `${joinTable}: foreign keys`).toEqual(
        [model.tableName, target?.tableName ?? ''].sort()
      );
      expect(columnsByTable.get(joinTable)).toHaveLength(2);
    }
  }
}

describe(titleWithReason('sql parser: real SQLite', probe), () => {
  it.skipIf(!probe.available).each(GROUPS)(
    '$label: the schema SQLite reports matches the parsed schema',
    ({ file }) => {
      const text: string = readFileSync(join(FIXTURES, file), 'utf8');
      const schema: IrSchema = expectOk(
        parseSqlDdl([{ path: file, text }], { appLabel: 'app' })
      );
      const query = (database as Database).load(text);
      compareWithDatabase(schema, query);
    },
    120_000
  );

  it.skipIf(!probe.available)(
    'SQLite accepts the DDL the fixtures use for the parsed defaults (a row with only the required columns is inserted)',
    () => {
      const text: string = readFileSync(
        join(FIXTURES, 'sql/sqlite/blog.sql'),
        'utf8'
      );
      const query = (database as Database).load(
        `${text}
         INSERT INTO blog_user DEFAULT VALUES;
         INSERT INTO blog_category (updated_at, name, slug) VALUES ('2024-01-01', 'a', 'a');
         INSERT INTO blog_post (updated_at, public_id, title, body, author_id, category_id)
           VALUES ('2024-01-01', 'p-1', 't', 'b', 1, 1);`
      );
      const rows: Row[] = query(
        'SELECT status, view_count, is_featured, metadata, created_at IS NOT NULL AS has_created FROM blog_post'
      );
      expect(rows).toEqual([
        {
          status: 'draft',
          view_count: 0,
          is_featured: 0,
          metadata: '{}',
          has_created: 1,
        },
      ]);
    },
    120_000
  );
});
