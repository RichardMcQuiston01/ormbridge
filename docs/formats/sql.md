# SQL DDL

The `sql` format is the SQL that creates a database: `CREATE TABLE`, indexes and enums for PostgreSQL, MySQL/MariaDB, SQLite and SQL Server. ormbridge both reads and writes it (`read + write`). It claims the `.sql` extension, so a single `.sql` file as input or output needs no `--from`/`--to`. A directory input has no extension to go by (it would be read as Django), so pass `--from sql`. Nothing is executed and no database is needed.

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
| `mongodb`                              | PostgreSQL        | Falls back with `Provider "mongodb": MongoDB has no SQL schema; PostgreSQL DDL was written.`                                            |

`--provider cockroachdb` writes PostgreSQL syntax with CockroachDB's types. Differences that change the output (each is a warning):

- `INT4` instead of `INTEGER`, because `INT` is a 64-bit integer there; `MONEY` becomes `NUMERIC(19, 4)`, `XML` becomes `TEXT`, `JSON` becomes `JSONB`.
- hstore becomes `JSONB`, a range type becomes `TEXT`, a multi-dimensional array or an array of JSON becomes `JSONB`. A column of another PostgreSQL-only type that you wrote as `Unsupported(...)` (`circle`, `point`, `macaddr`, ...) is kept and warned about, because creating it fails.
- Auto-increment keys stay `GENERATED BY DEFAULT AS IDENTITY` (a sequence), not `SERIAL`, which CockroachDB fills with `unique_rowid()`; one warning lists the keys and recommends UUID keys with `gen_random_uuid()`. A Prisma `sequence()` default is read as an auto-increment key.
- Indexes keep the B-tree and `USING gin` forms. `hash`, `gist`, `spgist` and `brin` are dropped (an ordinary index is written), `gin` over a column that is not JSON, an array, `tsvector` or spatial is dropped too, and operator classes are dropped.
- An auto-updated timestamp is written as `DEFAULT now() ON UPDATE now()`, which CockroachDB (unlike PostgreSQL) has.

`--naming preserve` (default) keeps table and column names; `--naming normalize` writes singular snake_case tables, UUID keys and `created_at`/`updated_at`. Identifiers are bare unless reserved in any dialect, then quoted for the dialect. Prisma native types (`@db.VarChar`, `@db.Uuid`) are kept when the dialect has a type of that name. Other flags (`--style`, `--no-header`) are ignored.

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
