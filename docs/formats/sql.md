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

Accepted input: a `pg_dump --schema-only`, `mysqldump --no-data` or SQLite `.dump` script, an SSMS script, hand-written DDL, or a folder of plain `.sql` migrations read in file-name order (so later `ALTER TABLE` statements apply to earlier tables). Directories are walked recursively; `node_modules`, `vendor`, `venv`, `.venv`, `dist`, `build`, `coverage`, `__pycache__` and `.git` are skipped, as are rollback scripts (`*.down.sql`, `*_rollback.sql`, `undo.sql`, ...). `migrations/` is read. The dialect of each file is guessed from its syntax (backticks and `ENGINE=`, `AUTOINCREMENT`, `[brackets]` and `GO`, `serial` and `::`), defaulting to PostgreSQL; the API can force one.

What is understood:

- `CREATE TABLE` becomes a model named after the table in singular PascalCase (`blog_post` is `BlogPost`); the table name is kept.
- Column types, `NOT NULL`, `PRIMARY KEY` (also composite), `UNIQUE`, `DEFAULT`, auto-increment forms (`serial`, `IDENTITY`, `AUTO_INCREMENT`, `AUTOINCREMENT`), generated columns and MySQL `ON UPDATE CURRENT_TIMESTAMP`.
- Enums: `CREATE TYPE ... AS ENUM`, MySQL `ENUM(...)`, and a `CHECK (col IN (...))` on a text column.
- Foreign keys (inline, table-level and via `ALTER TABLE`) with `ON DELETE`/`ON UPDATE`; a unique or primary-key foreign key is one-to-one.
- A table of exactly two foreign-key columns forming its primary key becomes a many-to-many field.
- `CREATE [UNIQUE] INDEX` with names, column order, descending columns, methods and operator classes, prefix lengths, `FULLTEXT` and `CLUSTERED`.
- `ALTER TABLE` (add column or constraint, defaults, nullability), `DROP TABLE` and `DROP TYPE`, applied in order.
- CockroachDB output (`SHOW CREATE ALL TABLES` and `SHOW CREATE ALL TYPES`) is read as PostgreSQL: `INT2` / `INT4` / `INT8`, `STRING` and `STRING(n)`, `BYTES`, `unique_rowid()` as an auto-increment key, the `:::` cast of its defaults (`now():::TIMESTAMPTZ`, `1:::INT8`), the `INDEX`, `UNIQUE INDEX`, `INVERTED INDEX` (read as `gin`) and `FAMILY` lines inside `CREATE TABLE`, and `CREATE INVERTED INDEX`. `STORING` columns, `USING HASH` and `WITH (...)` clauses are ignored, and the hidden `crdb_internal_*_shard_*` column of a hash-sharded index is skipped with a warning.

Everything else is skipped with one counted warning per kind, for example:

```
warning: Skipped 1 CREATE VIEW statement (first at v.sql:2): views are not read.
```

Views, functions, triggers, sequences, domains and row data (`INSERT`, `COPY`) are skipped this way. Other warnings name the table: an unknown type kept as an unsupported column (`table "a", column "g": the type "geometry" is unknown; it is kept as an unsupported column.`), a dropped `WHERE` of a partial index, a table without a primary key, `CHECK` constraints that are not enums, expression indexes, `INHERITS` and partitioning, and foreign keys to tables not in the input.

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

// Parser and emitter directly; `dialect` forces the reader's dialect.
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
