# Drizzle

Drizzle ORM defines its schema as TypeScript (`pgTable`, `mysqlTable`, `sqliteTable`). ormbridge reads and writes it (`ormbridge formats` lists it as `read + write`). It claims no file extension, because `.ts` always means TypeORM, so pass `--from drizzle` when reading and `--to drizzle` when writing. Drizzle output is a directory, so `-o` must be a directory.

## Try it

```bash
cd examples/drizzle
npx ormbridge convert           # runs both conversions in ormbridge.config.json
npx ormbridge convert --check   # exit code 3 if the output is stale
# inside this repository, after npm run build: node ../../dist/cli.js convert
```

- `to-drizzle`: `../schema/schema.prisma` becomes `models/schema.ts` and `models/drizzle.config.ts`.
- `from-drizzle`: `models/` is read back into `prisma/schema.prisma`.

The runnable example is in [examples/drizzle](../../examples/drizzle/).

## Reading

`--from drizzle` parses TypeScript with the tree-sitter grammar. No Node project, `drizzle-orm` install or database is needed, and none of your code runs. Pass the folder with the schema or individual files. Every `.ts` file is read except `*.d.ts`, `*.test.ts`, `*.spec.ts` and anything below `node_modules/`; only tables, enums and `relations()` in them are used.

- Dialect comes from the table function: `pgTable`, `mysqlTable`, `sqliteTable`, `pgSchema('x').table(...)`, `mysqlSchema(...)` and `pgTableCreator` with a template prefix or suffix. SingleStore, Gel, SQL Server and CockroachDB tables are reported and skipped.
- A model is named after the variable (`blogPosts` becomes `BlogPost`), the property key is the field name, and the builder's string argument is the column name.
- Column builders (`integer`, `serial`, `varchar`, `numeric`, `uuid`, `jsonb`, `timestamp`, SQLite `{ mode }` variants and others), `.notNull()`, `.primaryKey()`, `.unique()`, `.default*()`, `$defaultFn`, `$onUpdate`, `.generatedAlwaysAs()`, `.array()`.
- `pgEnum`, `mysqlEnum`, `.references(() => t.id, { onDelete, onUpdate })`, `foreignKey()` (single column), `index()`, `uniqueIndex()`, `primaryKey({ columns })`, and `relations()` with `relationName`, which supplies relation and reverse names.

The full table is in the README section "Drizzle ORM (`--from drizzle`)".

## Writing

Output is two files:

- `schema.ts`: every enum, table and `relations()` in one file, tables ordered so a table follows the tables it references, plus `export type Post` / `NewPost` row types.
- `drizzle.config.ts`: `defineConfig` with the matching `dialect`, `schema: './schema.ts'` and `out: './drizzle'`, so `npx drizzle-kit generate` works next to it.

It needs `drizzle-orm` 0.36 or newer, and `drizzle-kit` for the config. TypeScript keys are camelCase in both naming modes (`createdAt`). Foreign keys use `.references(() => table.id, { onDelete: 'set null' })`, annotated `(): AnyPgColumn =>` for self references and later tables. `relations()` is written for both sides, with `relationName` where two relations join the same tables. Enums export `postStatusValues`, a union type and `pgEnum` (PostgreSQL), `mysqlEnum` (MySQL) or `text(..., { enum })` (SQLite). A many-to-many field becomes an explicit join table.

| Option               | Effect                                                                                                                                                                                                                                                                                                                                    |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--provider <name>`  | Dialect: `postgresql` and `cockroachdb` use `pg-core`, `mysql` uses `mysql-core`, `sqlite` uses `sqlite-core`. Default `postgresql`. `cockroachdb` writes auto-increment keys as `generatedByDefaultAsIdentity()` instead of `serial` and warns (Drizzle 1.0 beta also has `drizzle-orm/cockroach-core`, which this writer does not use). |
| `--naming preserve`  | Default. Keeps source table, column and enum names as the string arguments.                                                                                                                                                                                                                                                               |
| `--naming normalize` | Fresh-schema style: singular snake_case tables, UUID keys, `created_at` / `updated_at`, snake_case columns.                                                                                                                                                                                                                               |

## Limitations and warnings

- No SQL Server or MongoDB dialect: `Provider "sqlserver": Drizzle ORM has no SQL Server dialect; PostgreSQL tables (pg-core) were written.` (and the same for `mongodb`).
- Outside PostgreSQL, arrays, hstore and ranges become JSON, text or varchar columns. On SQLite a UUID default is `$defaultFn(() => crypto.randomUUID())`, which only runs for rows inserted through Drizzle, and the writer warns.
- Unsupported types become plain strings (`Doc.body: the database type "tsvector" (Prisma Unsupported) has no equivalent here; the column was written as a plain string.`). Composite foreign keys, views (written as tables), index types and sort orders, full-text indexes and `@@schema` are written as plain tables and columns; `cuid()` and database-expression defaults are dropped; each with a warning.
- Reading is static. Tables built in loops or functions, run-time defaults, `check()` constraints, partial and expression indexes, views, sequences, policies and `defineRelations` (relations v2; foreign keys are still read) are not represented. SQLite `integer({ mode: 'timestamp' })` warns that the database stores Unix time.
- Round trips: a Prisma explicit join model is replaced by the join table the writer derives (reason 8), and reverse relation names become the `relations()` keys (reason 9).

See [prisma → drizzle](../CONVERSION_MATRIX.md#prisma--drizzle), [drizzle → prisma](../CONVERSION_MATRIX.md#drizzle--prisma) and [why information is lost](../CONVERSION_MATRIX.md#why-information-is-lost) in the conversion matrix.

## Programmatic API

All functions return `Result<T>` and do not throw.

```ts
import { readFile } from 'node:fs/promises';
import { convertText } from 'ormbridge';
import type { ConvertResult, Result } from 'ormbridge';

const text: string = await readFile('schema.prisma', 'utf8');
const result: Result<ConvertResult> = await convertText(
  [{ path: 'schema.prisma', text }],
  {
    from: 'prisma',
    to: 'drizzle',
    naming: 'preserve',
    provider: 'sqlite',
    header: true,
    autoField: 'int',
  }
);
if (!result.ok) {
  console.error(result.error.code, result.error.message);
} else {
  const files: Record<string, string> = result.value.files ?? {};
  console.log(Object.keys(files)); // ["schema.ts", "drizzle.config.ts"]
  console.log(result.value.warnings);
}
```

To read, pass the `.ts` files as `SourceText[]` with `from: 'drizzle'`. Lower-level: `parseDrizzle(sources, { appLabel })` returns `Result<IrSchema>` and `emitDrizzle(schema, { provider, naming })` returns `{ files, warnings }`.
