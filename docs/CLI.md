# Command Line Reference

[Back to README](../README.md)

| [Usage](#usage) | [Dry run and check](#dry-run-and-check) | [Config file](#config-file) | [Exit codes](#exit-codes) | [Multi-file output](#multi-file-output) | [Naming modes](#naming-modes) |

## Usage

```bash
# Django -> Prisma
ormbridge convert -i ./shop/models.py -o ./prisma/schema.prisma

# Whole project: finds models.py files and models/ packages (skips migrations, venvs, node_modules)
ormbridge convert -i ./backend -o ./prisma/schema.prisma

# Prisma -> Django
ormbridge convert -i ./prisma/schema.prisma -o ./shop/models.py --app-label shop

# TypeORM -> Prisma (a directory needs --from; every .ts file in it is read, entities are picked out)
ormbridge convert -i ./src/entities --from typeorm -o ./prisma/schema.prisma

# Doctrine (PHP 8 attributes) -> Prisma (every .php file is read; vendor/, var/ and *Test.php are skipped)
ormbridge convert -i ./src/Entity --from doctrine -o ./prisma/schema.prisma

# Laravel project root -> Prisma (reads database/migrations and app/; vendor/, storage/, tests/ and bootstrap/cache are skipped)
ormbridge convert -i ./my-laravel-app --from laravel -o ./prisma/schema.prisma

# GORM (Go structs with gorm tags) -> Prisma (every .go file is read; vendor/, testdata/ and *_test.go are skipped)
ormbridge convert -i ./internal/models --from gorm -o ./prisma/schema.prisma

# Drizzle ORM (pgTable / mysqlTable / sqliteTable) -> Prisma (every .ts file is read and the tables are picked out; node_modules/, *.d.ts and *.test.ts are skipped)
ormbridge convert -i ./src/db/schema --from drizzle -o ./prisma/schema.prisma

# Sequelize 6 models (JavaScript or TypeScript) -> Prisma (every .js, .cjs, .mjs and .ts file is read and the models are picked out; node_modules/, migrations/, seeders/, config/, dist/, build/, *.d.ts, *.test.* and *.spec.* are skipped)
ormbridge convert -i ./models --from sequelize -o ./prisma/schema.prisma

# JSON Schema or an OpenAPI document (JSON) -> Django (every .json file of a directory is read; several files may refer to each other)
ormbridge convert -i ./schemas --from json-schema -o ./blog/models.py
ormbridge convert -i ./openapi.json --from json-schema --to prisma -o ./prisma/schema.prisma

# SQL DDL (a pg_dump / mysqldump / sqlite .dump / SSMS script, or a folder of migrations) -> Prisma (every .sql file is read in name order; node_modules/, vendor/ and rollback scripts such as *.down.sql are skipped)
ormbridge convert -i ./schema.sql -o ./prisma/schema.prisma
ormbridge convert -i ./db/migrations --from sql --to django -o ./blog/models.py

# SQLAlchemy 2.0 or SQLModel models -> Prisma (.py belongs to Django, so pass --from sqlalchemy; every .py file is read; venvs, site-packages, migrations/, alembic/, __pycache__/ and test files are skipped)
ormbridge convert -i ./app/models --from sqlalchemy -o ./prisma/schema.prisma
# Prisma -> Sequelize 6 models (".ts" and ".js" are not inferred, so pass --to sequelize; -o is a directory; --style define writes the sequelize-cli CommonJS files)
ormbridge convert -i ./prisma/schema.prisma --to sequelize -o ./models
ormbridge convert -i ./prisma/schema.prisma --to sequelize --style define -o ./models

# Prisma -> SQLAlchemy 2.0 models (".py" means Django, so pass --to sqlalchemy; --style sqlmodel writes SQLModel classes instead)
ormbridge convert -i ./prisma/schema.prisma --to sqlalchemy -o ./app/models.py
ormbridge convert -i ./prisma/schema.prisma --to sqlalchemy --style sqlmodel -o ./app/models.py
```

Formats are inferred from file extensions (`.py` = Django, `.prisma` = Prisma, `.ts` = TypeORM, `.sql` = SQL), or set explicitly with `--from` / `--to`. Passing a directory does not infer the format, so add `--from typeorm` (or `--from drizzle`, `--from sequelize`, `--from json-schema`, `--from doctrine`, `--from laravel`, `--from gorm`) when reading a folder of entities (or `--from sql` for a folder of `.sql` files); `.php`, `.go` and `.json` are not inferred either, and `.ts` always means TypeORM, so Drizzle needs `--from drizzle` and Sequelize (`.js` or `.ts`) needs `--from sequelize`. Run `ormbridge formats` to list every supported format, its file extensions, and whether it can be read, written, or both. Without `-o`, the result is printed to stdout. Warnings go to stderr.

| Flag                      | Default                    | Description                                                                                                                                                                                                                                              |
| ------------------------- | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `-i, --input <paths...>`  | required (or config)       | Files or directories to read. Several files are merged into one schema, so abstract base classes can live in another file.                                                                                                                               |
| `-o, --output <path>`     | stdout                     | File to write. Parent directories are created.                                                                                                                                                                                                           |
| `-f, --from <format>`     | inferred                   | `django`, `prisma`, `typeorm`, `drizzle`, `doctrine`, `laravel`, `gorm`, `json-schema`, `sql`, `sqlalchemy` or `sequelize`                                                                                                                               |
| `-t, --to <format>`       | inferred                   | `django`, `prisma`, `typeorm`, `drizzle`, `doctrine`, `laravel`, `gorm`, `json-schema`, `sql`, `sqlalchemy` or `sequelize` (`drizzle`, `doctrine`, `laravel`, `gorm` and `sequelize` write a directory), `typescript`, `zod` or `graphene` (output only) |
| `--naming <mode>`         | `preserve`                 | `preserve` or `normalize` (see below)                                                                                                                                                                                                                    |
| `--provider <name>`       | `postgresql`               | Database: `postgresql`, `mysql`, `sqlite`, `sqlserver`, `mongodb`, `cockroachdb`. Picks Prisma native types, the Drizzle, GORM and SQL dialects and the Sequelize data types (`JSONB`, `ARRAY`, `INET` on PostgreSQL).                                   |
| `--no-header`             | off                        | Omit the Prisma `generator` / `datasource` blocks (useful when pasting models into an existing schema).                                                                                                                                                  |
| `--no-conventions`        | off                        | Omit the `x-table-name`, `x-primary-key`, `x-unique`, `x-indexes`, `x-on-delete` and `x-related-name` keywords from JSON Schema output (`--to json-schema` only), for validators such as Ajv in strict mode that reject unknown keywords.                |
| `--app-label <name>`      | directory name             | Django app label used for default table names (`<app>_<model>`).                                                                                                                                                                                         |
| `--auto-field <type>`     | `int`                      | Key type for Django models without an explicit primary key: `int` or `bigint`.                                                                                                                                                                           |
| `--namespace <name>`      | `App\Entity`, `App\Models` | PHP namespace of the Doctrine entities or Laravel models (`--to doctrine` / `--to laravel` only). Enums go in a sibling namespace.                                                                                                                       |
| `--go-package <name>`     | `models`                   | Go package name of the GORM models, also the output sub-directory (`--to gorm` only). Must be a valid Go identifier.                                                                                                                                     |
| `--prisma-version <6\|7>` | `6`                        | Prisma major version of the header (`--to prisma` only). `7` writes the `prisma-client` generator (with an `output`) and no datasource `url`.                                                                                                            |
| `--style <name>`          | `sqlalchemy`, `init`       | Layout of the SQLAlchemy output (`sqlalchemy` or `sqlmodel`) or the Sequelize output (`init` or `define`). A value that does not belong to `--to` fails with the valid values; other targets ignore it.                                                  |
| `--dry-run`               | off                        | Run the whole conversion and report what would be written, without touching the filesystem.                                                                                                                                                              |
| `--check`                 | off                        | Exit with code 3 if an output file is missing or differs from the conversion. Writes nothing. Needs an output path.                                                                                                                                      |
| `--config <path>`         | searched                   | Read settings from this JSON config file instead of searching for one.                                                                                                                                                                                   |
| `--no-config`             | off                        | Ignore any config file.                                                                                                                                                                                                                                  |

[Back to Top](#command-line-reference)

## Dry run and check

`--dry-run` converts everything exactly as a real run would and reports each file it would create or update (line count, size, and for an existing file a short diff summary such as `+3 -1 lines (first difference at line 12)`), plus all warnings. Nothing is written.

`--check` is for CI. It compares the conversion with the existing output and exits `0` when every file is up to date. If a file is missing or differs, it exits `3` and names the file:

```text
error: prisma/schema.prisma is out of date: +3 -1 lines (first difference at line 12).
Generated output is stale. Run "ormbridge convert" without --check to regenerate it.
```

Only the files the conversion produces are compared; extra files already in an output directory are ignored.

[Back to Top](#command-line-reference)

## Config file

Instead of repeating flags, put them in `ormbridge.config.json` (or `.ormbridgerc.json`). ormbridge looks in the current directory and each parent directory, and stops after the first directory that contains a `package.json` (or at the filesystem root). Use `--config <path>` to pick a file explicitly, or `--no-config` to ignore it. The file is plain JSON; no code is executed. Relative paths inside it resolve against the config file's directory, not the working directory.

```json
{
  "naming": "normalize",
  "provider": "postgresql",
  "conversions": [
    {
      "name": "prisma",
      "input": "backend",
      "output": "prisma/schema.prisma"
    },
    {
      "name": "types",
      "input": "backend",
      "to": "typescript",
      "output": "web/src/models.ts"
    }
  ]
}
```

| Key             | Type                  | Same as                                                          |
| --------------- | --------------------- | ---------------------------------------------------------------- |
| `input`         | string or string list | `-i, --input`                                                    |
| `output`        | string                | `-o, --output`                                                   |
| `from`          | string                | `-f, --from`                                                     |
| `to`            | string                | `-t, --to`                                                       |
| `naming`        | string                | `--naming` (`preserve` or `normalize`)                           |
| `provider`      | string                | `--provider`                                                     |
| `header`        | boolean               | `--no-header` when `false`                                       |
| `conventions`   | boolean               | `--no-conventions` when `false` (JSON Schema output)             |
| `appLabel`      | string                | `--app-label`                                                    |
| `autoField`     | string                | `--auto-field` (`int` or `bigint`)                               |
| `namespace`     | string                | `--namespace` (Doctrine or Laravel output)                       |
| `goPackage`     | string                | `--go-package` (GORM output)                                     |
| `prismaVersion` | number                | `--prisma-version` (`6` or `7`; Prisma output)                   |
| `style`         | string                | `--style` (`sqlalchemy`, `sqlmodel`, `init` or `define`)         |
| `conversions`   | list of objects       | Several named conversions; each takes the keys above plus `name` |

Top-level keys are defaults for every entry in `conversions`. Flags override config values. With no `-i`, `ormbridge convert` runs every conversion in the list (and `-o` is rejected, since the conversions write to different paths); with `-i`, it runs a single conversion from the top-level settings. Unknown keys and bad values fail with a message naming the key, such as `"conversions[1].naming" must be "preserve" or "normalize" (got "weird")`.

To fail CI when generated files are stale:

```yaml
# .github/workflows/ci.yml
- run: npx ormbridge convert --check
```

[Back to Top](#command-line-reference)

## Exit codes

| Code | Meaning                                                                                              |
| ---- | ---------------------------------------------------------------------------------------------------- |
| `0`  | Success (with `--check`: every output is up to date).                                                |
| `1`  | A conversion failed: unreadable input, parse error, unwritable output. Other conversions still run.  |
| `2`  | Usage or config error: bad flag or value, unknown format, invalid config file. Nothing is converted. |
| `3`  | `--check` found an output file that is missing or stale.                                             |

[Back to Top](#command-line-reference)

## Multi-file output

Most formats produce one text, written to the `-o` file. A format can instead return several files (a map of relative path to text; the Doctrine, Laravel, GORM and Drizzle formats do this). Then `-o` must be a directory (for example `ormbridge convert -i ./models.py --to doctrine -o ./`, or `--to laravel -o ./` to write `app/` and `database/migrations/` into a Laravel project): every file is written beneath it, creating folders as needed, and `--dry-run` and `--check` cover each file. If `-o` is an existing file or looks like a file path (it has an extension), ormbridge fails with a message listing the files and asking for a directory. See "Emitter output" under [Format registry](./API.md#format-registry) for the adapter side.

[Back to Top](#command-line-reference)

## Naming modes

**`preserve`** (default) keeps the existing database working unchanged: Django table names (`blog_post`) are kept via `@@map`, columns keep their names, and each Django many-to-many field becomes an explicit join model that matches the table Django already created.

**`normalize`** produces a fresh-schema style: singular snake_case table names (`post`), UUID primary keys in place of auto-increment ids, camelCase Prisma fields mapped to snake_case columns, `created_at` / `updated_at` added to models that lack them, and implicit many-to-many relations. Laravel and GORM output apply their own frameworks' conventions instead (plural snake_case tables, keys keep their type); see their sections below.

[Back to Top](#command-line-reference)

---

[Back to README](../README.md)
