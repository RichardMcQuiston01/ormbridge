# Laravel

Laravel (11 and 12, PHP 8.1+) keeps its schema in migrations and its relations in Eloquent models. ormbridge reads and writes both (`ormbridge formats` lists it as `read + write`). It claims no file extension, because `.php` is shared with Doctrine, so pass `--from laravel` when reading and `--to laravel` when writing. Laravel output is a directory, so `-o` must be a directory.

## Try it

```bash
cd examples/laravel
npx ormbridge convert           # runs both conversions in ormbridge.config.json
npx ormbridge convert --check   # exit code 3 if the output is stale
# inside this repository, after npm run build: node ../../dist/cli.js convert
```

- `to-laravel`: `../schema/schema.prisma` becomes `models/app/Models/*.php`, `models/app/Enums/PostStatus.php` and `models/database/migrations/2024_01_01_00000N_create_<table>_table.php` (six migrations).
- `from-laravel`: `models/` is read back into `prisma/schema.prisma`.

The runnable example is in [examples/laravel](../../examples/laravel/).

## Reading

`--from laravel` works in two steps and needs no PHP, Composer or database (it uses the tree-sitter PHP grammar):

1. It replays the migrations in file-name order to rebuild the current schema: `Schema::create`, `Schema::table`, `drop`, `rename`, `dropColumn`, `renameColumn`, `->change()`, index and foreign key drops, and the column helpers (`id`, `string`, `decimal`, `timestamps`, `softDeletes`, `uuid`, `enum`, `foreignId()->constrained()`, `foreign()->references()->on()` and so on). `down()` is ignored.
2. It reads the Eloquent models for what migrations do not say: relation names and reverse names (`belongsTo`, `hasMany`, `hasOne`, `belongsToMany`), `$casts` / `casts()` to string-backed enums and other types, `$table`, `$timestamps`, `SoftDeletes`, `HasUuids`, `HasUlids`.

Input is the project root (only `database/migrations` and `app/` are read; `vendor/`, `storage/`, `tests/`, `bootstrap/cache` and `node_modules/` are skipped) or several directories or files:

```bash
ormbridge convert -i ./my-laravel-app --from laravel -o ./prisma/schema.prisma
ormbridge convert -i ./database/migrations ./app/Models ./app/Enums --from laravel -o schema.prisma
```

Files are recognised by content (a class whose `up()` calls `Schema::`, a class extending `Model`, a backed enum), so a flat folder works. A table without a model is still converted. The full construct tables are in the README section "Laravel (`--from laravel`)".

## Writing

Output is multi-file, with fixed names so a rerun overwrites the same files:

- one migration per table in `database/migrations/` (`2024_01_01_000001_create_<table>_table.php`, anonymous `Migration` class, ordered so each foreign key points at an earlier table; a true cycle adds an `add_foreign_keys_to_<table>_table` migration)
- one Eloquent model per model in `app/Models/`, relations written on both sides
- one backed enum per enum in `app/Enums/`

Type mappings that matter: an auto-increment key is `id()` (an `int` key becomes a big integer), `created_at` + `updated_at` become `timestamps()`, a nullable `deleted_at` becomes `softDeletes()` with `use SoftDeletes`, JSON is `jsonb` on PostgreSQL and `json` elsewhere, `now` defaults are `useCurrent()`, foreign keys use `foreignId(...)->constrained(...)->cascadeOnDelete()` and friends. Many-to-many becomes a pivot table with a composite primary key and `belongsToMany` on both models.

| Option                         | Effect                                                                                                                                                                                                                                                  |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--naming preserve`            | Default. Keeps table and column names (written as `$table` and in the migrations). The example's `blog_post` stays `blog_post`.                                                                                                                         |
| `--naming normalize`           | Laravel conventions: plural snake_case tables (`posts`, `post_tags`), snake_case columns, `created_at` / `updated_at` added where missing.                                                                                                              |
| `--provider <name>`            | Only chooses `jsonb` versus `json` and the MySQL form of JSON defaults. `mongodb` warns that the relational output was written anyway. `cockroachdb` writes the same `jsonb` migrations and warns that Laravel has no CockroachDB driver (use `pgsql`). |
| `--namespace Acme\Blog\Models` | PHP namespace of the models (default `App\Models`); enums go in the sibling `Enums` namespace and files in `app/Blog/Models`. Config key: `namespace`.                                                                                                  |

Other config-file keys (`input`, `output`, `from`, `to`, `naming`, `provider`, `header`, `namespace`) are the same settings; `--dry-run` and `--check` cover every file.

## Limitations and warnings

- Eloquent has no composite primary keys: the migration gets `primary([...])` and the model warns: `Doc: Eloquent does not support composite primary keys; the migration declares primary(a, b) but ...`.
- Arrays are written as `json` columns cast to `array` (`Doc.tags: Laravel has no array column type that works on every database; ...`). Unsupported types become strings (`Doc.body: the database type "tsvector" (Prisma Unsupported) has no equivalent here; the column was written as a plain string.`). Composite foreign keys, views, generated columns, full-text indexes and `@@schema` are written as plain tables and columns, each with a warning.
- A `User` model produces a second `create_users_table` next to the one in a fresh Laravel app: delete one of them. Policies, factories, seeders and morph relations are not generated.
- Reading is static. Conditionals and loops in migrations are applied as if they always ran, raw `DB::statement` SQL is not interpreted, and polymorphic relations (`morphs`, `morphTo`), `hasManyThrough`, composite foreign keys, tables altered but never created, and custom pivot names are reported or lost, each with a warning naming the table.
- Round trips: auto-increment keys come back as `bigInt` (reason 19), `timestamps()` columns come back nullable (reason 20), and unnamed reverse relations get a plural name (reason 21).

See [prisma → laravel](../CONVERSION_MATRIX.md#prisma--laravel), [laravel → prisma](../CONVERSION_MATRIX.md#laravel--prisma) and [why information is lost](../CONVERSION_MATRIX.md#why-information-is-lost) in the conversion matrix.

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
    to: 'laravel',
    naming: 'normalize',
    provider: 'mysql',
    header: true,
    autoField: 'int',
    namespace: 'Acme\\Blog\\Models',
  }
);
if (!result.ok) {
  console.error(result.error.code, result.error.message);
} else {
  // files: path -> text, e.g. "app/Blog/Models/Post.php"
  for (const [path, php] of Object.entries(result.value.files ?? {})) {
    console.log(path, php.length);
  }
  console.log(result.value.warnings);
}
```

`parseLaravel(sources, { appLabel })` returns `Result<IrSchema>` and `emitLaravel(schema, { provider, naming, namespace })` returns `{ files, warnings }` for lower-level use.
