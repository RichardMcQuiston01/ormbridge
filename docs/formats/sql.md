# SQL DDL

The `sql` format is the SQL that creates a database: `CREATE TABLE`, indexes and enums for PostgreSQL, MySQL/MariaDB, SQLite and SQL Server (and ClickHouse, write only). ormbridge both reads and writes it (`read + write`). It claims the `.sql` extension, so a single `.sql` file as input or output needs no `--from`/`--to`. A directory input has no extension to go by (it would be read as Django), so pass `--from sql`. Nothing is executed and no database is needed.

## Try it

The example project is [`examples/sql`](../../examples/sql/). Its config has two conversions:

```sh
cd examples/sql
npx ormbridge convert           # runs both conversions below
npx ormbridge convert --check   # exits with code 3 if a generated file is missing or differs
```

| Conversion | Input                     | Output                 |
| ---------- | ------------------------- | ---------------------- |
| `to-sql`   | `../schema/schema.prisma` | `models/schema.sql`    |
| `from-sql` | `models/`                 | `prisma/schema.prisma` |

Inside this repository, run `npm run build` once and use `node ../../dist/cli.js convert` instead. Without the config file, and for another dialect:

```sh
npx ormbridge convert -i ../schema/schema.prisma -o models/schema.sql
npx ormbridge convert -i ../schema/schema.prisma --to sql --provider mysql -o models/schema.mysql.sql
npx ormbridge convert -i models --from sql --to prisma -o prisma/schema.prisma
```

## Reading

Accepted input: a `pg_dump --schema-only`, `mysqldump --no-data` or SQLite `.dump` script, an SSMS script, hand-written DDL, or a folder of `.sql` migrations (see [Migrations](#migrations): the folder is read as one schema, in the order the migrations run). Directories are walked recursively; `node_modules`, `vendor`, `venv`, `.venv`, `dist`, `build`, `coverage`, `__pycache__` and `.git` are skipped, as are rollback scripts (`*.down.sql`, `*_rollback.sql`, `undo.sql`, Flyway `U2__x.sql`, ...). `migrations/` is read. The dialect of each file is guessed from its syntax (backticks and `ENGINE=`, `AUTOINCREMENT`, `[brackets]` and `GO`, `serial` and `::`), defaulting to PostgreSQL. A file with no hint of its own (`ALTER TABLE t DROP COLUMN c`) is read like the other files of the set. The API can force one dialect.

What is understood:

- `CREATE TABLE` becomes a model named after the table in singular PascalCase (`blog_post` is `BlogPost`); the table name is kept.
- Column types, `NOT NULL`, `PRIMARY KEY` (also composite), `UNIQUE`, `DEFAULT`, auto-increment forms (`serial`, `IDENTITY`, `AUTO_INCREMENT`, `AUTOINCREMENT`), generated columns and MySQL `ON UPDATE CURRENT_TIMESTAMP`.
- Enums: `CREATE TYPE ... AS ENUM`, MySQL `ENUM(...)`, and a `CHECK (col IN (...))` on a text column.
- Foreign keys (inline, table-level and via `ALTER TABLE`) with `ON DELETE`/`ON UPDATE`; a unique or primary-key foreign key is one-to-one.
- A table of exactly two foreign-key columns forming its primary key becomes a many-to-many field.
- `CREATE [UNIQUE] INDEX` with names, column order, descending columns, methods and operator classes, prefix lengths, `FULLTEXT` and `CLUSTERED`.
- Schema changes after the `CREATE` statements (`ALTER TABLE`, `RENAME`, `DROP`, `CREATE INDEX`, ...), applied in order. See [Migrations](#migrations) for the list.
- CockroachDB output (`SHOW CREATE ALL TABLES` and `SHOW CREATE ALL TYPES`) is read as PostgreSQL: `INT2` / `INT4` / `INT8`, `STRING` and `STRING(n)`, `BYTES`, `unique_rowid()` as an auto-increment key, the `:::` cast of its defaults (`now():::TIMESTAMPTZ`, `1:::INT8`), the `INDEX`, `UNIQUE INDEX`, `INVERTED INDEX` (read as `gin`) and `FAMILY` lines inside `CREATE TABLE`, and `CREATE INVERTED INDEX`. `STORING` columns, `USING HASH` and `WITH (...)` clauses are ignored, and the hidden `crdb_internal_*_shard_*` column of a hash-sharded index is skipped with a warning.

Everything else is skipped with one counted warning per kind, for example:

```
warning: Skipped 1 CREATE VIEW statement (first at v.sql:2): views are not read.
```

Views, functions, triggers, sequences, domains and row data (`INSERT`, `COPY`) are skipped this way. Other warnings name the table: an unknown type kept as an unsupported column (`table "a", column "g": the type "geometry" is unknown; it is kept as an unsupported column.`), a dropped `WHERE` of a partial index, a table without a primary key, `CHECK` constraints that are not enums, expression indexes, `INHERITS` and partitioning, and foreign keys to tables not in the input.

## Migrations

A folder of migration files is read as one schema. The reader replays the statements in the order the database would run them, and the result is the schema the database ends with. Nothing is run and no database is needed.

```sh
npx ormbridge convert -i db/migration --from sql --to prisma -o prisma/schema.prisma
```

### Order of the files

The files of a folder (and its sub-folders) run in this order:

- **Flyway.** `V<version>__name.sql` run by version number, so `V2` comes before `V10` and `V1.2` before `V1.10` (a `_` in a version means a dot). Repeatable files `R__name.sql` run last, by name. Undo scripts (`U2__name.sql`) and callbacks (`beforeMigrate.sql`, `afterEachMigrate__x.sql`) are not read. A file that follows neither pattern, such as a baseline dump, comes first.
- **drizzle-kit.** `0000_name.sql`, `0001_name.sql`, ... run in the order of `meta/_journal.json` when that file lists them. Without a journal the numbers give the order. The `--> statement-breakpoint` lines are comments, so they need no special care. Point `-i` at the `drizzle/` folder (the `meta/` folder holds JSON, which is not read).
- **Prisma.** `migrations/<timestamp>_name/migration.sql` run folder by folder, in name order.
- **Anything else.** Natural order of the names, folder by folder: `2_add.sql` comes before `10_more.sql`.
- **Liquibase.** Only SQL changelogs are read. `--liquibase formatted sql`, `--changeset` and `--rollback` lines are comments, so a formatted SQL changelog is replayed like any other script. XML, YAML and JSON changelogs are not read.

Files that you name one by one (`-i a.sql -i b.sql`) keep the order you give. A shell wildcard such as `V*.sql` puts `V10` before `V2`, so pass the folder to get the Flyway order.

### What is replayed

| Change                | PostgreSQL, CockroachDB                                                                                    | MySQL, MariaDB                                                          | SQLite                    | SQL Server                                                                |
| --------------------- | ---------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | ------------------------- | ------------------------------------------------------------------------- |
| Add a column          | `ADD [COLUMN] [IF NOT EXISTS]`, several in one statement                                                   | also `FIRST`, `AFTER col` and `ADD COLUMN (a ..., b ...)`               | `ADD [COLUMN]`            | `ADD a int, b int`                                                        |
| Drop a column         | `DROP [COLUMN] [IF EXISTS]`                                                                                | `DROP [COLUMN] col`                                                     | `DROP COLUMN`             | `DROP COLUMN a, b`                                                        |
| Rename a column       | `RENAME [COLUMN] a TO b`                                                                                   | `RENAME COLUMN`, `CHANGE a b ...`                                       | `RENAME COLUMN`           | `sp_rename 't.a', 'b', 'COLUMN'`                                          |
| Rename a table        | `RENAME TO`                                                                                                | `RENAME TABLE a TO b, c TO d`, `ALTER TABLE ... RENAME [TO or AS] b`    | `RENAME TO`               | `sp_rename 'a', 'b'`                                                      |
| Change a type         | `ALTER COLUMN c [SET DATA] TYPE t [USING ...]`                                                             | `MODIFY [COLUMN] c definition`, `CHANGE`                                | none (tables are rebuilt) | `ALTER COLUMN c type [NOT] NULL`                                          |
| Nullability, defaults | `SET` or `DROP NOT NULL`, `SET` or `DROP DEFAULT`, `DROP IDENTITY`, `ADD GENERATED`, `DROP EXPRESSION`     | `ALTER COLUMN c SET` or `DROP DEFAULT`, `MODIFY`                        |                           | `ALTER COLUMN`, `ADD CONSTRAINT df DEFAULT x FOR c`, `DROP CONSTRAINT df` |
| Keys and checks       | `DROP CONSTRAINT [IF EXISTS]`, `RENAME CONSTRAINT`, `ADD PRIMARY KEY`, CockroachDB `ALTER PRIMARY KEY`     | `DROP PRIMARY KEY`, `DROP FOREIGN KEY`, `DROP CHECK`, `DROP CONSTRAINT` |                           | `DROP CONSTRAINT a, b`, `sp_rename 'c', 'd', 'OBJECT'`                    |
| Indexes               | `CREATE [UNIQUE] INDEX [IF NOT EXISTS]`, `DROP INDEX [IF EXISTS] a, b`, `ALTER INDEX a RENAME TO b`, `t@i` | `DROP INDEX` or `KEY`, `DROP INDEX i ON t`, `RENAME INDEX` or `KEY`     | `CREATE` and `DROP INDEX` | `DROP INDEX i ON t`, `DROP INDEX t.i`, `sp_rename 't.i', 'j', 'INDEX'`    |
| Tables                | `DROP TABLE [IF EXISTS] a, b [CASCADE]`                                                                    | `DROP TABLE [IF EXISTS] a, b`                                           | `DROP TABLE [IF EXISTS]`  | `DROP TABLE [IF EXISTS]`                                                  |
| Enums                 | `ALTER TYPE ... ADD VALUE`, `RENAME VALUE`, `RENAME TO`, `DROP TYPE`                                       | an enum is a column type, so `MODIFY` changes it                        |                           |                                                                           |

Details that follow the database:

- **A rename carries what points at it.** Foreign keys of other tables (and of the same table) follow a renamed table or column. So do the primary key, unique keys, indexes, `CHECK` enums and generated-column expressions of the renamed column.
- **Names the database makes up.** An unnamed constraint or index gets a name from the database (`t_a_key`, `t_b_fkey`, `t_c_check` and `t_a_idx` in PostgreSQL; the first column for a MySQL key; `t_ibfk_1` for a MySQL foreign key). Later statements use those names, so `DROP CONSTRAINT t_a_key` finds the unnamed `UNIQUE (a)`. The name is written down before a rename, because the database keeps it. SQL Server makes up random names and SQLite none, so only names you wrote can be dropped there.
- **Dropping a column** drops the keys, indexes and checks that use it, as PostgreSQL does. MySQL only takes the column out of its keys and indexes and drops the ones left empty. A foreign key in another table that points at the column goes too. The columns of a dropped primary key stay `NOT NULL`.
- **Dropping a table** keeps the foreign keys that point at it, unless you wrote `CASCADE` (PostgreSQL). A key that points at a table that is not there is reported at the end, and its column stays an ordinary field. This is also how a SQLite table rebuild works: the new table is renamed to the old name, and the keys find it again.
- **MySQL** reads `CREATE UNIQUE INDEX` as a unique key (as `SHOW CREATE TABLE` does). The index MySQL builds for a foreign key is not part of the model, so dropping it by name gives no warning.
- **Data statements** (`INSERT`, `UPDATE`, `DELETE`, `SELECT`, `COPY`, `MERGE`) are reported in one warning for the whole input, with a count and the first place: `Skipped 4 data statements (first at V1__create.sql:32): row data is not part of the schema.` `TRUNCATE`, `SET`, `BEGIN`, `COMMIT` and `LOCK` are ignored without a warning.
- **A statement that does not fit** is skipped with a warning that names the file, the line, the table and the column, for example `V3__rename.sql:2: ALTER TABLE "post" RENAME COLUMN "title": the column does not exist at this point; the statement was skipped.` Changes that have no meaning for the model are counted once per kind, for example `Skipped 2 ALTER TABLE ... SET SCHEMA statements (first at m.sql:3, table "t")`. Changes of a storage option, an owner or a trigger are ignored without a warning.

### How it was checked

`test/sql-migration-verify.test.ts` runs sets of migrations in real servers (PostgreSQL 16, MySQL 8, CockroachDB and SQLite), dumps the schema each server ends with (`pg_dump --schema-only`, `SHOW CREATE TABLE`, `SHOW CREATE ALL TABLES`, `sqlite_master`) and checks that replaying the same files gives the same schema as reading that dump. The comparison is exact, down to the order of the columns. It allows two differences only: the names a database makes up for objects that no migration named (`_pkey`, `_fkey` and `_ibfk_N`), and the type cast PostgreSQL adds to a default expression (`'{}'::text[]`). An unnamed unique key or index that no later statement touches also has a name in a dump and none in a replay, so the test sets name them. The steps cover renames of tables and columns that foreign keys point at, type changes, nullability and defaults, indexes and keys added and dropped by name, tables dropped and created again, and enum changes. Without the servers the test is skipped, with the reason in its title (see `test/README.md`). SQL Server has no server in the tests, so it is covered by the golden files in `test/golden-extras/sql-migration-replay/` only (as are the single statement forms of the other dialects).

## Writing

One `.sql` script. In order: extensions and enum types the dialect needs, one `CREATE TABLE` per model (referenced tables first), then each table's `CREATE [UNIQUE] INDEX` statements. A foreign key that closes a cycle is added with `ALTER TABLE ... ADD CONSTRAINT` (SQLite keeps it inline). Many-to-many fields become join tables. Constraints are named (for example `blog_post_author_id_fkey`).

`--provider` picks the dialect (config key `provider`):

| `--provider`                           | Dialect           | Notable output                                                                                                                          |
| -------------------------------------- | ----------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `postgresql` (default)                 | PostgreSQL        | `GENERATED BY DEFAULT AS IDENTITY`, `TIMESTAMPTZ`, `JSONB`, `CREATE TYPE ... AS ENUM`                                                   |
| `cockroachdb`                          | PostgreSQL syntax | `INT4` / `INT8` (a bare `INT` is 64-bit), identity columns, `JSONB`, `ON UPDATE now()`; no hstore, ranges or `USING hash`/`gist`/`brin` |
| `mysql` (also MariaDB, Percona Server) | MySQL             | `AUTO_INCREMENT`, inline `ENUM(...)`, `JSON`, `ON UPDATE CURRENT_TIMESTAMP(6)`                                                          |
| `sqlite`                               | SQLite            | `INTEGER PRIMARY KEY AUTOINCREMENT`, `CHAR(36)` UUIDs, enums as `CHECK (... IN (...))`                                                  |
| `sqlserver`                            | SQL Server        | `IDENTITY(1,1)`, `NVARCHAR`, `DATETIME2`, `ISJSON` checks                                                                               |
| `clickhouse`                           | ClickHouse        | `ENGINE = MergeTree() ORDER BY (...)`, `Nullable(T)`, `Enum8`, no keys or constraints (see below)                                       |
| `mongodb`                              | PostgreSQL        | Falls back with `Provider "mongodb": MongoDB has no SQL schema; PostgreSQL DDL was written.`                                            |

`--provider cockroachdb` writes PostgreSQL syntax with CockroachDB's types. Differences that change the output (each is a warning):

- `INT4` instead of `INTEGER`, because `INT` is a 64-bit integer there; `MONEY` becomes `NUMERIC(19, 4)`, `XML` becomes `TEXT`, `JSON` becomes `JSONB`.
- hstore becomes `JSONB`, a range type becomes `TEXT`, a multi-dimensional array or an array of JSON becomes `JSONB`. A column of another PostgreSQL-only type that you wrote as `Unsupported(...)` (`circle`, `point`, `macaddr`, ...) is kept and warned about, because creating it fails.
- Auto-increment keys stay `GENERATED BY DEFAULT AS IDENTITY` (a sequence), not `SERIAL`, which CockroachDB fills with `unique_rowid()`; one warning lists the keys and recommends UUID keys with `gen_random_uuid()`. A Prisma `sequence()` default is read as an auto-increment key.
- Indexes keep the B-tree and `USING gin` forms. `hash`, `gist`, `spgist` and `brin` are dropped (an ordinary index is written), `gin` over a column that is not JSON, an array, `tsvector` or spatial is dropped too, and operator classes are dropped.
- An auto-updated timestamp is written as `DEFAULT now() ON UPDATE now()`, which CockroachDB (unlike PostgreSQL) has.

`--naming preserve` (default) keeps table and column names; `--naming normalize` writes singular snake_case tables, UUID keys and `created_at`/`updated_at`. Identifiers are bare unless reserved in any dialect, then quoted for the dialect. Prisma native types (`@db.VarChar`, `@db.Uuid`) are kept when the dialect has a type of that name. Other flags (`--style`, `--no-header`) are ignored.

## ClickHouse

`--provider clickhouse` writes ClickHouse DDL. It is **write only**: reading ClickHouse DDL and `clickhouse-sqlalchemy` models are later work, and `--from sql` does not understand `ENGINE = MergeTree()` yet. Another writer asked for `--provider clickhouse` (Prisma, TypeORM, GORM, Drizzle, ...) warns and writes for PostgreSQL, the way `mongodb` does: ``Provider "clickhouse": ClickHouse is only supported by the SQL DDL writer (use `--to sql --provider clickhouse`); prisma output was written for PostgreSQL.``

```sql
CREATE TABLE blog_post (
  id Int32,
  title String,
  status Enum8('draft' = 1, 'published' = 2) DEFAULT 'draft',
  rating Nullable(Decimal(4, 2)),
  author_id Int32,
  INDEX blog_post_title_idx title TYPE bloom_filter GRANULARITY 1
)
ENGINE = MergeTree()
ORDER BY (id)
PRIMARY KEY (id);
```

**Engine, ORDER BY and PRIMARY KEY.** Every table is `ENGINE = MergeTree()` and `ORDER BY` is the primary key of the model (a composite key keeps its declared order). `PRIMARY KEY (...)` repeats the same columns, so it is always a prefix of the sorting key. A model without a primary key gets `ORDER BY tuple()` (no sorting key) and a warning. A sorting-key column is never `Nullable`, because ClickHouse rejects that unless `allow_nullable_key` is set. The engine is not configurable yet (`ReplacingMergeTree` and the others are on the roadmap).

**Types.** Columns are non-nullable unless the IR says otherwise; nullable columns are `Nullable(T)`, except arrays and maps, which ClickHouse cannot make nullable (a warning says so). `String` has no length, so `VARCHAR(n)` lengths are not enforced.

| IR type                   | ClickHouse type                                                                                                |
| ------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `string`, `text`          | `String` (`FixedString(n)` for a Prisma `@db.Char(n)`)                                                         |
| `int`, `bigInt`           | `Int32`, `Int64` (signed unless a Prisma `@db.Unsigned*` native type says otherwise, then `UInt8` to `UInt64`) |
| `float`                   | `Float64` (`Float32` for `@db.Real` and `@db.Float`)                                                           |
| `decimal`                 | `Decimal(P, S)` from the precision and scale; `Decimal(38, 18)` without a size; at most 76 digits              |
| `boolean`                 | `Bool`                                                                                                         |
| `dateTime`                | `DateTime64(3)` (the precision of a Prisma `@db.Timestamp(n)` when there is one)                               |
| `date`                    | `Date32` (1900 to 2299; `Date` cannot hold dates before 1970)                                                  |
| `time`                    | `String` with a comment and a warning (no stable time-of-day type)                                             |
| `uuid`                    | `UUID`                                                                                                         |
| `json`                    | `String` with the comment `JSON document` (see below)                                                          |
| `bytes`                   | `String` with the comment `binary data` (ClickHouse strings hold any bytes)                                    |
| `duration`                | `Int64` microseconds with a comment and a warning                                                              |
| `ipAddress`               | `IPv6` (an IPv4 address is stored as `::ffff:a.b.c.d`)                                                         |
| `hstore`                  | `Map(String, String)`                                                                                          |
| `range`                   | `String` with a comment and a warning                                                                          |
| enum                      | `Enum8('a' = 1, 'b' = 2)`; `Enum16` above 127 members                                                          |
| arrays                    | `Array(T)`, nested for each dimension (`Array(Array(Int32))`)                                                  |
| Prisma `Unsupported("x")` | `x`, as written, with a warning                                                                                |

Two choices have an alternative you can apply by hand. **Enums** are `Enum8` / `Enum16`, which reject unknown values like the enums of the other dialects; `LowCardinality(String)` accepts any string and lets you add values without an `ALTER TABLE`. **JSON** is a `String`, which works on every ClickHouse version and is read with the `JSONExtract*` functions; the `JSON` type stores the document as subcolumns (it was checked here only on ClickHouse 26.9, older versions need an experimental setting).

**Defaults.** Literals are typed (`DEFAULT 7`, `DEFAULT true`, `DEFAULT 'it''s'`; a backslash is doubled), `now` is `now64(p)` for a date-time and `today()` for a date, a UUID default is `generateUUIDv4()`, an enum default is its stored value, and the well-known expressions `gen_random_uuid()`, `uuid_generate_v4()`, `now()` and `CURRENT_TIMESTAMP` are translated. Any other database expression is written as it is with a warning. A generated column (Django `GeneratedField`) becomes `MATERIALIZED expr` (stored) or `ALIAS expr` (computed) when its expression is plain arithmetic over fields (`F("a") + F("b") * 2`); otherwise it is a regular column with a warning. Defaults generated by the ORM client (`cuid()`) and auto-increment are dropped with a warning.

**Indexes** are data-skipping indexes inside the `CREATE TABLE`: `minmax` for numbers, dates and booleans, `bloom_filter` for strings, UUIDs, IPs and arrays, `set(100)` for enums and composite indexes, and `tokenbf_v1(10240, 3, 0)` for a full-text index on one `String` column. The index options of other databases (method, sort order, prefix length, operator class, `CLUSTERED`) are dropped with a warning; an index on a `Map` column is skipped.

**Dropped, each with a warning that names the model and field:**

- **Foreign keys** (single and composite) and their `ON DELETE` / `ON UPDATE` actions. The relation stays as a plain column with the type of the referenced key. A relation to an unknown model or a view is skipped.
- **Unique constraints** (unique fields, one-to-one relations and unique indexes). A `ReplacingMergeTree` can deduplicate rows with the same `ORDER BY` key, but that is eventual, not an enforced constraint. A unique index is kept as an ordinary data-skipping index.
- **Auto-increment** and `ON UPDATE` timestamps (the application has to set them).
- **Views** are a commented placeholder, as in the other dialects.

**Names and layout.** Identifiers are bare unless they are reserved or not a plain lower-case word, then quoted with backticks (`` `select` ``, `` `Mixed Case` ``; a backtick is doubled). A model with a database (`@@schema`) is written as `db.table` and `CREATE DATABASE IF NOT EXISTS db;` comes first; the other dialects ignore `@@schema`. Tables are plain `CREATE TABLE`, with no `IF NOT EXISTS`, like the other dialects. They keep the order of the schema because nothing references anything. Many-to-many join tables are ordinary tables with the table comment `many-to-many join table`. `--naming normalize` works as in the other dialects.

The output is executed in a real ClickHouse server by `test/clickhouse-verify.test.ts` (see `test/README.md`).

## Limitations and warnings

- **Auto-updated timestamps** exist only on MySQL. Other dialects warn once: `PostgreSQL cannot refresh a column on update from the DDL (Category.updated_at, Post.updated_at); the application or a trigger has to set it.`
- **SQL Server cascade rules.** Cascading actions that form a cycle or a second path are written as `NO ACTION`: `Category.parent: SQL Server rejects cascading actions that form a cycle or a second cascade path; the foreign key was written with NO ACTION.` MySQL has no `SET DEFAULT` and gets the same treatment.
- **PostgreSQL-only types** (arrays, ranges, hstore, `interval`) become JSON or text elsewhere, with a warning. Client-side defaults (`cuid()`, `ulid()`) are dropped with a warning; unknown default expressions are written as-is with a warning.
- **Views** are a commented placeholder plus a warning. Enum member names and labels are not kept.
- **Reading** does not recover reverse accessor names (they are derived from the table, e.g. `blog_posts`), and a unique index is not read as a unique column; a join table with its own key or extra columns stays a model.

See the conversion matrix: [why information is lost](../CONVERSION_MATRIX.md#why-information-is-lost) (items 14 to 17 concern SQL), [prisma to sql](../CONVERSION_MATRIX.md#prisma--sql) and [sql to prisma](../CONVERSION_MATRIX.md#sql--prisma).

## Programmatic API

```ts
import {
  convertText,
  emitSqlDdl,
  orderSqlMigrationFiles,
  parseSqlDdl,
  type ConvertResult,
  type IrSchema,
  type Result,
} from 'ormbridge';

declare const sqlText: string;

const converted: Result<ConvertResult> = await convertText(
  [{ path: 'schema.sql', text: sqlText }],
  {
    from: 'sql',
    to: 'prisma',
    naming: 'preserve',
    provider: 'postgresql',
    header: true,
    autoField: 'int',
  }
);
if (!converted.ok) {
  console.error(`${converted.error.code}: ${converted.error.message}`);
}

// Parser and emitter directly; `dialect` forces the reader's dialect. Several files are one schema, read in
// the order given, so put them in migration order first.
const files: string[] = orderSqlMigrationFiles([
  'db/V10__b.sql',
  'db/V2__a.sql',
]);
const parsed: Result<IrSchema> = parseSqlDdl(
  [{ path: 'schema.sql', text: sqlText }],
  { appLabel: 'app', dialect: 'mysql' }
);
if (parsed.ok) {
  const { text, warnings } = emitSqlDdl(parsed.value, {
    provider: 'sqlite',
    naming: 'preserve',
  });
}
```
