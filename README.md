# ormbridge

Convert ORM models between frameworks and languages, so one data model can be shared across your whole stack, from the command line or from code.

| Format                      | Read | Write | Notes                                                      |
| --------------------------- | :--: | :---: | ---------------------------------------------------------- |
| Django models               |  ✔   |   ✔   | `models.py` files or `models/` packages                    |
| Prisma schema               |  ✔   |   ✔   | All six providers; Prisma 7 header via the API             |
| TypeORM entities            |  ✔   |   ✔   | Decorator-based entity classes                             |
| Doctrine ORM entities (PHP) |  ✔   |   ✔   | PHP 8 attributes; writes one file per entity               |
| Laravel (PHP)               |  ✔   |   ✔   | Reads migrations plus Eloquent models; writes both         |
| GORM (Go)                   |  ✔   |       | Go structs with `gorm:"..."` tags; read only for now       |
| TypeScript interfaces       |      |   ✔   | Plain interfaces and enums for front ends                  |
| Graphene (graphene-django)  |      |   ✔   | GraphQL types, queries and mutations that pair with Django |

See [What is converted](#what-is-converted) for the field-level mapping and [docs/CONVERSION_MATRIX.md](docs/CONVERSION_MATRIX.md) for exactly what survives a round trip between the readable formats.

- **Static parsing, no runtime needed.** Source files are read with [tree-sitter](https://tree-sitter.github.io/), so there is no Python, Django, PHP, Composer, Go toolchain or database to install or connect to.
- **Safe for existing databases.** The default `preserve` mode keeps your existing table and column names, so a new tool can sit on top of the database you already have.
- **Honest output.** Anything that cannot be represented produces a warning naming the model and field.

## Table of Contents

### | [Install](#install) | [Usage](#usage) | [What is converted](#what-is-converted) | [Limitations and warnings](#limitations-and-warnings) | [Programmatic API](#programmatic-api) |

## Install

```bash
npm install --global ormbridge   # or: npx ormbridge ...
```

Requires Node.js 20 or newer.

[Back to Table of Contents](#table-of-contents)

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
```

Formats are inferred from file extensions (`.py` = Django, `.prisma` = Prisma, `.ts` = TypeORM), or set explicitly with `--from` / `--to`. Passing a directory does not infer the format, so add `--from typeorm` (or `--from doctrine`, `--from laravel`, `--from gorm`) when reading a folder of entities; `.php` and `.go` are not inferred either. Run `ormbridge formats` to list every supported format, its file extensions, and whether it can be read, written, or both. Without `-o`, the result is printed to stdout. Warnings go to stderr.

| Flag                     | Default                    | Description                                                                                                                             |
| ------------------------ | -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `-i, --input <paths...>` | required (or config)       | Files or directories to read. Several files are merged into one schema, so abstract base classes can live in another file.              |
| `-o, --output <path>`    | stdout                     | File to write. Parent directories are created.                                                                                          |
| `-f, --from <format>`    | inferred                   | `django`, `prisma`, `typeorm`, `doctrine`, `laravel` or `gorm`                                                                          |
| `-t, --to <format>`      | inferred                   | `django`, `prisma`, `typeorm`, `doctrine` or `laravel` (both write a directory), `typescript` or `graphene` (output only)               |
| `--naming <mode>`        | `preserve`                 | `preserve` or `normalize` (see below)                                                                                                   |
| `--provider <name>`      | `postgresql`               | Prisma datasource: `postgresql`, `mysql`, `sqlite`, `sqlserver`, `mongodb`, `cockroachdb`. Controls native types such as `@db.VarChar`. |
| `--no-header`            | off                        | Omit the Prisma `generator` / `datasource` blocks (useful when pasting models into an existing schema).                                 |
| `--app-label <name>`     | directory name             | Django app label used for default table names (`<app>_<model>`).                                                                        |
| `--auto-field <type>`    | `int`                      | Key type for Django models without an explicit primary key: `int` or `bigint`.                                                          |
| `--namespace <name>`     | `App\Entity`, `App\Models` | PHP namespace of the Doctrine entities or Laravel models (`--to doctrine` / `--to laravel` only). Enums go in a sibling namespace.      |
| `--dry-run`              | off                        | Run the whole conversion and report what would be written, without touching the filesystem.                                             |
| `--check`                | off                        | Exit with code 3 if an output file is missing or differs from the conversion. Writes nothing. Needs an output path.                     |
| `--config <path>`        | searched                   | Read settings from this JSON config file instead of searching for one.                                                                  |
| `--no-config`            | off                        | Ignore any config file.                                                                                                                 |

### Dry run and check

`--dry-run` converts everything exactly as a real run would and reports each file it would create or update (line count, size, and for an existing file a short diff summary such as `+3 -1 lines (first difference at line 12)`), plus all warnings. Nothing is written.

`--check` is for CI. It compares the conversion with the existing output and exits `0` when every file is up to date. If a file is missing or differs, it exits `3` and names the file:

```text
error: prisma/schema.prisma is out of date: +3 -1 lines (first difference at line 12).
Generated output is stale. Run "ormbridge convert" without --check to regenerate it.
```

Only the files the conversion produces are compared; extra files already in an output directory are ignored.

### Config file

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

| Key           | Type                  | Same as                                                          |
| ------------- | --------------------- | ---------------------------------------------------------------- |
| `input`       | string or string list | `-i, --input`                                                    |
| `output`      | string                | `-o, --output`                                                   |
| `from`        | string                | `-f, --from`                                                     |
| `to`          | string                | `-t, --to`                                                       |
| `naming`      | string                | `--naming` (`preserve` or `normalize`)                           |
| `provider`    | string                | `--provider`                                                     |
| `header`      | boolean               | `--no-header` when `false`                                       |
| `appLabel`    | string                | `--app-label`                                                    |
| `autoField`   | string                | `--auto-field` (`int` or `bigint`)                               |
| `namespace`   | string                | `--namespace` (Doctrine output)                                  |
| `conversions` | list of objects       | Several named conversions; each takes the keys above plus `name` |

Top-level keys are defaults for every entry in `conversions`. Flags override config values. With no `-i`, `ormbridge convert` runs every conversion in the list (and `-o` is rejected, since the conversions write to different paths); with `-i`, it runs a single conversion from the top-level settings. Unknown keys and bad values fail with a message naming the key, such as `"conversions[1].naming" must be "preserve" or "normalize" (got "weird")`.

To fail CI when generated files are stale:

```yaml
# .github/workflows/ci.yml
- run: npx ormbridge convert --check
```

### Exit codes

| Code | Meaning                                                                                              |
| ---- | ---------------------------------------------------------------------------------------------------- |
| `0`  | Success (with `--check`: every output is up to date).                                                |
| `1`  | A conversion failed: unreadable input, parse error, unwritable output. Other conversions still run.  |
| `2`  | Usage or config error: bad flag or value, unknown format, invalid config file. Nothing is converted. |
| `3`  | `--check` found an output file that is missing or stale.                                             |

### Multi-file output

Most formats produce one text, written to the `-o` file. A format can instead return several files (a map of relative path to text; the Doctrine and Laravel formats do this). Then `-o` must be a directory (for example `ormbridge convert -i ./models.py --to doctrine -o ./`, or `--to laravel -o ./` to write `app/` and `database/migrations/` into a Laravel project): every file is written beneath it, creating folders as needed, and `--dry-run` and `--check` cover each file. If `-o` is an existing file or looks like a file path (it has an extension), ormbridge fails with a message listing the files and asking for a directory. See "Emitter output" under [Format registry](#format-registry) for the adapter side.

[Back to Table of Contents](#table-of-contents)

### Naming modes

**`preserve`** (default) keeps the existing database working unchanged: Django table names (`blog_post`) are kept via `@@map`, columns keep their names, and each Django many-to-many field becomes an explicit join model that matches the table Django already created.

**`normalize`** produces a fresh-schema style: singular snake_case table names (`post`), UUID primary keys in place of auto-increment ids, camelCase Prisma fields mapped to snake_case columns, `created_at` / `updated_at` added to models that lack them, and implicit many-to-many relations.

## What is converted

| Django                                                                                                         | Prisma                                                                   | TypeORM                                                                                               | Doctrine                                                                                                                     |
| -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `CharField`, `SlugField`, `EmailField`, `URLField`                                                             | `String @db.VarChar(n)`                                                  | `@Column({ type: 'varchar', length: n })`                                                             | `type: 'string'`, `length: n`                                                                                                |
| `TextField`                                                                                                    | `String @db.Text`                                                        | `@Column({ type: 'text' })`                                                                           | `type: 'text'`                                                                                                               |
| `Integer*`, `PositiveInteger*` / `BigInteger*` / `AutoField` / `BigAutoField`                                  | `Int` / `BigInt` / `@default(autoincrement())`                           | `int` / `bigint` (`string`), `@PrimaryGeneratedColumn('increment')`                                   | `integer` / `bigint` (`string`), `#[ORM\GeneratedValue(strategy: 'AUTO')]`                                                   |
| `FloatField`, `DecimalField`                                                                                   | `Float`, `Decimal @db.Decimal(p, s)`                                     | `float`, `decimal` with `precision` / `scale` (`string`)                                              | `float`, `decimal` with `precision` / `scale` (`string`)                                                                     |
| `BooleanField`, `UUIDField`, `JSONField`, `BinaryField`                                                        | `Boolean`, `String @db.Uuid`, `Json`, `Bytes`                            | `boolean`, `uuid`, `jsonb`, `bytea` (types follow `--provider`)                                       | `boolean`, `guid`, `json` (`jsonb` on PostgreSQL), `blob`                                                                    |
| `DateTimeField`, `DateField`, `TimeField`                                                                      | `DateTime` (with `@db.Date` / `@db.Time`)                                | `timestamptz` / `date` / `time`                                                                       | `DateTimeImmutable` (`datetimetz_immutable` on PostgreSQL, `date_immutable`, `time_immutable`)                               |
| `ArrayField(base_field)` (nested arrays too)                                                                   | scalar list `String[]` (PostgreSQL, CockroachDB, MongoDB)                | `array: true` on PostgreSQL, `json` elsewhere                                                         | `json` (PHP `array`) plus a warning                                                                                          |
| `HStoreField`                                                                                                  | `Json`                                                                   | `hstore` on PostgreSQL, `json` elsewhere                                                              | `json` plus a warning                                                                                                        |
| `IntegerRangeField`, `BigIntegerRangeField`, `DecimalRangeField`, `DateRangeField`, `DateTimeRangeField`       | `Unsupported("int4range")` and friends on PostgreSQL, `String` elsewhere | `int4range`, `int8range`, `numrange`, `daterange`, `tstzrange` on PostgreSQL                          | `string` plus a warning                                                                                                      |
| `GenericIPAddressField`, `IPAddressField`                                                                      | `String @db.Inet` (PostgreSQL)                                           | `inet` on PostgreSQL, `varchar(45)` elsewhere                                                         | `string` (length 45)                                                                                                         |
| `DurationField`                                                                                                | `BigInt` (no interval type)                                              | `interval` on PostgreSQL, `bigint` elsewhere                                                          | `dateinterval` plus a warning                                                                                                |
| `FileField`, `ImageField`, `FilePathField`, `SmallIntegerField`, `PositiveSmallIntegerField`, `SmallAutoField` | `String`, `Int` as above                                                 | `varchar(100)`, `int` as above                                                                        | `string(100)`, `integer` as above                                                                                            |
| `GeneratedField` (`expression`, `output_field`, `db_persist`)                                                  | regular column plus a warning                                            | regular column plus a warning                                                                         | regular column plus a warning                                                                                                |
| `db_default` (`Value(...)`, `Now()`, literals)                                                                 | `@default(...)`                                                          | `default: ...`                                                                                        | `options: ['default' => ...]`                                                                                                |
| `auto_now_add` / `auto_now`                                                                                    | `@default(now())` / `@updatedAt`                                         | `@CreateDateColumn` / `@UpdateDateColumn`                                                             | constructor default plus `#[ORM\PrePersist]` / `#[ORM\PreUpdate]` callbacks                                                  |
| `default=uuid.uuid4`, `timezone.now`, literals                                                                 | `@default(uuid())`, `@default(now())`, literals                          | `@PrimaryGeneratedColumn('uuid')`, `default: () => 'CURRENT_TIMESTAMP'`, literals                     | constructor-generated UUID, `options: ['default' => ...]`, literals                                                          |
| `TextChoices`, inline `choices=[...]`                                                                          | `enum`                                                                   | TypeScript `enum` plus `@Column({ type: 'enum', enum })`                                              | backed `enum` in `src/Enum/` plus `enumType:`                                                                                |
| `ForeignKey`, `OneToOneField` (`on_delete`, `related_name`, `null`)                                            | `@relation(... onDelete: ...)` plus the reverse field                    | `@ManyToOne` / `@OneToOne` with `@JoinColumn` and `onDelete`, plus `@OneToMany` / inverse `@OneToOne` | `#[ORM\ManyToOne]` / `#[ORM\OneToOne]` with `#[ORM\JoinColumn(onDelete:)]`, plus `OneToMany(mappedBy:)` / inverse `OneToOne` |
| `ManyToManyField`                                                                                              | join model (`preserve`) or implicit relation (`normalize`)               | `@ManyToMany` with `@JoinTable` and the inverse side                                                  | `#[ORM\ManyToMany]` with `#[ORM\JoinTable]` and the inverse side                                                             |
| `Meta.db_table`, `unique_together`, `indexes`, `UniqueConstraint`, `db_index`                                  | `@@map`, `@@unique`, `@@index`                                           | `@Entity('table')`, `@Unique([...])`, `@Index([...])`                                                 | `#[ORM\Table(name:)]`, `#[ORM\Index]`, `#[ORM\UniqueConstraint]`                                                             |
| Abstract base classes, multi-table inheritance                                                                 | fields inherited / one-to-one primary key                                | fields inherited / one-to-one primary key                                                             | fields inherited / `#[ORM\Id]` on the one-to-one                                                                             |
| Proxy models (`Meta.proxy`), `Meta.swappable`, `models.CompositePrimaryKey`                                    | merged into the concrete model / resolved / `@@id`                       | merged into the concrete model / resolved / composite `@PrimaryColumn`                                | merged into the concrete model / resolved / several `#[ORM\Id]`                                                              |

TypeORM output is a single TypeScript file of entity classes. Relations use `Relation<T>` so entities declared in one file do not trip over circular references, and `--provider` picks the column types (`timestamptz` and `jsonb` for PostgreSQL, `datetime` and `json` for MySQL, `simple-json` for SQLite). Use `--naming normalize` for camelCase properties mapped to snake_case columns with `name:` options. `.ts` is not inferred as a format, so pass `--from typeorm` or `--to typeorm`. Reading uses decorators only (see Limitations). TypeORM entities are parsed statically with tree-sitter (no `reflect-metadata`, TypeScript compiler, or database needed), and the same naming modes apply to the result.

Doctrine (`--from doctrine`) reads PHP 8 entity classes with the tree-sitter PHP grammar, so no PHP, Composer or database is needed. Pass the entity directory (one class per file is typical; enums and mapped superclasses can live in other files) or individual files; `.php` is not claimed because Laravel uses it too. Doctrine's default underscore naming is assumed for anything the attributes leave out: the table is the snake_cased class name, the column the snake_cased property, a join column `<property>_id`, an embedded column `<property>_<column>`.

| Doctrine (PHP 8 attributes)                                                                                        | Read as                                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `#[ORM\Entity]` (`repositoryClass` ignored), `#[ORM\Table(name:)]`                                                 | a model; table `name` or the snake_cased class name                                                                                                     |
| `#[ORM\Column]` `type` (or a `Types::` constant), `length`, `precision`, `scale`, `nullable`, `unique`, `name`     | string (length 255 by default), text, int, bigint, decimal (10,0 by default), float, boolean, date and time types, json, binary, guid                   |
| `#[ORM\Column]` without `type`                                                                                     | inferred from the PHP type, as Doctrine does (`int`, `string`, `bool`, `float`, `array`, `DateTime`, `DateTimeImmutable`, `DateInterval`, backed enums) |
| `options: ['default' => ...]`                                                                                      | literal, `now` (`CURRENT_TIMESTAMP`), `uuid` (`gen_random_uuid()`) or enum member defaults                                                              |
| `#[ORM\Id]`, `#[ORM\GeneratedValue(strategy:)]`, `#[ORM\CustomIdGenerator]`                                        | primary key; AUTO/IDENTITY/SEQUENCE become auto-increment, UUID (and Symfony `UuidGenerator`) a UUID key, NONE no default                               |
| several `#[ORM\Id]`                                                                                                | composite primary key                                                                                                                                   |
| `#[ORM\ManyToOne]`, `#[ORM\OneToOne]` with `#[ORM\JoinColumn(name:, referencedColumnName:, nullable:, onDelete:)]` | foreign key / one-to-one (column `<property>_id`, nullable unless `nullable: false`)                                                                    |
| `#[ORM\OneToMany]`, inverse `#[ORM\OneToOne]`, `mappedBy` / `inversedBy`                                           | the reverse accessor of the owning relation                                                                                                             |
| `#[ORM\ManyToMany]` (owning side)                                                                                  | many-to-many (custom `#[ORM\JoinTable]` names are not preserved)                                                                                        |
| `#[ORM\Index]`, `#[ORM\UniqueConstraint]` (class level or inside `#[ORM\Table]`), `Column(unique:, index:)`        | indexes, unique constraints (a single unnamed unique column becomes a unique field), `fulltext` flag                                                    |
| backed enums (`enum Status: string`) used through `enumType` or the property type                                  | an enum plus an enum-backed column                                                                                                                      |
| `#[ORM\Embeddable]` / `#[ORM\Embedded(columnPrefix:)]`                                                             | the embeddable's columns flattened into the owner, prefixed as Doctrine does                                                                            |
| `#[ORM\MappedSuperclass]` and traits                                                                               | columns, relations and indexes inherited                                                                                                                |
| `#[ORM\InheritanceType('SINGLE_TABLE')]`, `#[ORM\DiscriminatorColumn]`                                             | subclasses merged into the root table (nullable columns) plus a discriminator column                                                                    |
| `#[ORM\InheritanceType('JOINED')]`                                                                                 | child table with a one-to-one primary key to the parent                                                                                                 |
| `#[ORM\Version]`                                                                                                   | integer column defaulting to 1 (optimistic locking is not represented)                                                                                  |
| `#[ORM\HasLifecycleCallbacks]`, lifecycle callbacks, `#[ORM\Cache]`, `#[ORM\OrderBy]`, other libraries' attributes | ignored without a warning                                                                                                                               |

Doctrine output (`--to doctrine`) writes a directory, so pass `-o <directory>`. It follows PSR-4: one PHP 8.1+ file per entity (`src/Entity/Post.php`) and one backed enum per enum (`src/Enum/PostStatus.php`), each with `declare(strict_types=1);` and `use Doctrine\ORM\Mapping as ORM;`. `.php` is not inferred, so pass `--to doctrine`.

- **Namespace and paths.** The default namespace is `App\Entity` (enums in `App\Enum`). `--namespace Acme\Blog\Entity` (or `namespace` in the config file, or the `namespace` option of `emitDoctrine` / `convertText`) writes `src/Blog/Entity/Post.php` and puts the enums in `Acme\Blog\Enum`: the first namespace segment maps to `src/`, the rest to folders, and a namespace not ending in `Entity` gets a child `Enum` namespace.
- **Properties.** Typed and nullable (`?int`, `?string`, `DateTimeImmutable`, `bool`), private, with explicit `type:`, `length:`, `precision:` / `scale:`, `nullable:`, `unique:` and the column `name:`. Defaults are PHP property initializers plus `options: ['default' => ...]`; `now` defaults and UUIDs are set in the constructor (no extra packages: UUID keys and defaults use a small private `generateUuid()` helper). Auto-updated timestamps get `#[ORM\PrePersist]` / `#[ORM\PreUpdate]` lifecycle callbacks. Enum columns use `enumType:` with the PHP backed enum, and a default becomes the enum case.
- **Keys.** An auto-increment key is `#[ORM\Id]` with `#[ORM\GeneratedValue(strategy: 'AUTO')]`; composite keys repeat `#[ORM\Id]`, and a relation that is the primary key (multi-table inheritance) carries the `#[ORM\Id]` itself.
- **Relations.** Every relation is written on both sides with matching `inversedBy:` / `mappedBy:`: `ManyToOne` with `JoinColumn(name:, referencedColumnName:, nullable:, onDelete:)` and an inverse `OneToMany`, `OneToOne` with an inverse `OneToOne`, and `ManyToMany` with `JoinTable`, `JoinColumn`, `InverseJoinColumn` and an inverse `ManyToMany`. To-many properties are `Collection` (docblock `Collection<int, Post>`) initialised with `ArrayCollection` in the constructor.
- **Accessors.** Getters and fluent `static` setters (`isFeatured()` for booleans); to-many properties get `getPosts()`, `addPost()` and `removePost()` that keep the owning and inverse sides in sync.
- **Tables and indexes.** `#[ORM\Table(name:)]` plus class-level `#[ORM\Index(columns: [...])]` and `#[ORM\UniqueConstraint(columns: [...])]` on database column names. (`Table(indexes:, uniqueConstraints:)` has no effect in Doctrine ORM 3, so it is not used; ORM 2.19 or newer and PHP 8.1 or newer are required.) Reserved SQL words used as table or column names (`user`, `order`, ...) are written with Doctrine's backtick quoting.
- **Naming.** `preserve` keeps the property names of the source (`published_at`) and always writes the table and column names explicitly; `normalize` writes camelCase properties (`publishedAt`) mapped to snake_case columns. Getter and setter names are always camelCase (`getPublishedAt()`).
- **Lossy or unsupported.** Arrays and HStore become `json` columns; ranges become strings; durations become `dateinterval` (an ISO 8601 string); `GeneratedField` expressions, views, composite foreign keys, `Unsupported(...)` types, full-text indexes, `@@schema` and other Prisma-only constructs are written as plain tables and columns; a relation to a model without a single-column primary key is skipped; each case warns with the model and field. `onUpdate` actions have no Doctrine equivalent. A relation that points at a non-primary-key column (`to_field`) is written, but Doctrine's `orm:validate-schema` rejects it, and the warning says so. Doctrine ORM is relational, so `--provider mongodb` only warns.
- **Reading.** `--from doctrine` reads the same attributes back, so Doctrine round trips through the shared model.

Laravel output (`--to laravel`) writes a directory, so pass `-o <directory>` (the project root of a Laravel 11 or 12 app, for example `-o .`). `.php` is not inferred, so pass `--to laravel` (and `--from laravel` to read a project back, described below). Existing files with the same name are overwritten (use `--check` or `--dry-run` first); the migration file names are fixed (see below), so running the conversion again rewrites the same files rather than adding new ones.

- **Files.** One migration per table in `database/migrations/` (anonymous `return new class extends Migration` with `up()` and `down()` = `Schema::dropIfExists`), one Eloquent model per model in `app/Models/` (namespace `App\Models`) and one backed enum per enum in `app/Enums/` (`App\Enums`). `--namespace Acme\Blog\Models` (or `namespace` in the config file, or the `namespace` option of `emitLaravel` / `convertText`) writes `app/Blog/Models/Post.php` and puts the enums in `Acme\Blog\Enums`; the first namespace segment maps to `app/`.
- **Migration order and names.** Files are named `2024_01_01_000001_create_posts_table.php`, `..._000002_...`, counting up by one, with the date fixed so the output is deterministic. Tables are ordered so a foreign key always points at a table created earlier. A self reference is written inline (`constrained()` on the same table). A real dependency cycle (A needs B, B needs A) creates the tables first and adds the constraints that could not be written in a later `add_foreign_keys_to_<table>_table` migration, whose `down()` drops them. A fresh Laravel app already has a `users` migration, so a `User` model produces a second `create_users_table`: delete one of them.
- **Columns.** `id()` for an auto-increment key (`bigIncrements('code')` when the key is not called `id`; an `int` key becomes a big integer, like Laravel's own `id()`, and foreign keys use `foreignId`), `uuid()->primary()` or `ulid()->primary()` only when the schema says so (with `HasUuids` / `HasUlids` and `foreignUuid` / `foreignUlid` references), `string(n)`, `text`, `integer`, `bigInteger`, `unsignedInteger` and the other sized integers when a Prisma native type (`@db.UnsignedInt`, ...) says so, `double`, `decimal(p, s)`, `boolean`, `dateTime` / `dateTimeTz` / `date` / `time`, `jsonb` on PostgreSQL and `json` elsewhere, `binary`, `ipAddress`, `enum('status', [...])`, `nullable()`, `unique()`, `default(...)` and `useCurrent()` for `now` defaults. A `created_at` + `updated_at` pair becomes `timestamps()` (Eloquent maintains it) and a nullable `deleted_at` becomes `softDeletes()` with `use SoftDeletes`. Indexes and unique constraints are `index([...], 'name')` / `unique([...])`, and composite keys `primary([...])`.
- **Foreign keys.** `foreignId('author_id')->constrained('auth_user')->cascadeOnDelete()` with the matching helper for each action (`restrictOnDelete()`, `nullOnDelete()`, `cascadeOnUpdate()`, ...; `set default` through `onDelete('set default')`). A reference to a non-id column or to a string key is written as `$table->foreign('col')->references('col')->on('table')`.
- **Many-to-many.** A pivot table with both foreign keys and a composite primary key. `normalize` follows Laravel's convention (`post_tag`: singular model names in alphabetical order, `post_id` and `tag_id`) so `belongsToMany(Tag::class)` needs no extra arguments; `preserve` keeps the `<table>_<relation>` name of the other formats and passes the table and key names explicitly. A self relation uses `from_user_id` / `to_user_id`. When the source already models the join table (Prisma's explicit join model), it is an ordinary table and model with `belongsTo` / `hasMany`.
- **Models.** `$table`, `$primaryKey`, `$keyType`, `$incrementing` and `$timestamps` are written only when they differ from what Laravel would guess (`$table` is also written when the plural of the model name is not certain: `Person` is fine, `Axis` is written out). `$fillable` lists every writable column except generated keys and `timestamps()` columns; `$casts` has backed enums, `boolean`, `array` (json columns, arrays, hstore), `datetime`, `date`, `float` and `decimal:N`. Every relation is written on both sides with typed methods and generics docblocks: `belongsTo` (and `hasMany` / `hasOne` on the target), `belongsToMany` on both models, with explicit keys only when they are not Laravel's (`belongsTo(User::class, 'writer_user_id')`). A method that would clash with a column or an Eloquent method gets a `Relation` suffix and a warning.
- **Naming.** `preserve` keeps table and column names exactly (written as `$table` and in the migrations); `normalize` uses plural snake_case tables (`blog_posts`), snake_case columns, `<relation>_id` keys, adds `created_at` / `updated_at` where missing and keeps auto-increment keys as they are. Relationship methods are always camelCase (`editedPosts()`).
- **Lossy or unsupported.** Arrays and HStore become `json` columns, ranges and durations become strings, `GeneratedField` expressions (Python, not SQL), views, composite foreign keys, `Unsupported(...)` types, full-text indexes, index options, `@@schema` and other Prisma-only constructs are written as plain tables and columns; a relation to a model without a single-column primary key is skipped; each case warns with the model and field. Eloquent has no composite primary keys: the migration gets `primary([...])` and the model a warning. An auto-updated column that is not part of `timestamps()` is only refreshed by MySQL (`useCurrentOnUpdate()`). Laravel does not map PostgreSQL-specific types, so `--provider` only chooses `jsonb` versus `json` and the MySQL form of JSON defaults.
- **Not converted.** Policies, factories, seeders, observers, morph relations and anything else outside the schema are not generated, and the models extend `Illuminate\Database\Eloquent\Model` (not `Authenticatable`).

Graphene output (`--to graphene`) is write-only and pairs with Django models: it writes one Python file that imports every model from `.models` (generate it with `--to django`, or use your own models) and defines a `DjangoObjectType` per model with an explicit `Meta.fields` list (forward and reverse relations included), a `Query` with a single-item field (`post(id)`) and a list field (`post_list`) per model, `Create`/`Update`/`Delete` mutations built on `graphene.Mutation`, and a final `schema = graphene.Schema(query=Query, mutation=Mutation)`. Inputs map the scalar types to `String`, `Int`, `BigInt`, `Float`, `Decimal`, `Boolean`, `DateTime`, `Date`, `Time`, `UUID` and `JSONString`; a field is required when it is not nullable and has no default, and relations are `ID` inputs (`author_id`, many-to-many `tags_ids`). Enum-backed fields rely on graphene-django's choice conversion for output and are `String` inputs validated by the model. Binary columns and relations to models outside the schema are left out, and models with a composite primary key get only a list query and a create mutation; each case produces a warning naming the model and field. Field names are snake_case like the Django output, `.py` stays owned by Django so pass `--to graphene`, and the naming mode has no effect. Requires graphene-django 3.x at runtime.

Django-only constructs: a proxy model (`Meta.proxy = True`) has no table of its own, so it is merged into its concrete model (chains of proxies are followed) and relations that target it are pointed at the concrete model, with a warning. A model with `Meta.swappable = "AUTH_USER_MODEL"` is used as the target of `settings.AUTH_USER_MODEL` and `get_user_model()` instead of an assumed `User`. Custom managers (`objects = MyManager()`, `Manager.from_queryset(...)()`, `QuerySet.as_manager()`) and the classes behind them are ignored without warnings. `django.contrib.postgres` arrays, HStore and range fields, and `GeneratedField` / `db_default` (Django 5.0+), round-trip through `--to django`; the Django emitter writes the `django.contrib.postgres.fields` import and notes the required Django version in a warning.

Prisma → Django applies the reverse mapping. Field names are converted from camelCase to snake_case, with `db_column` set when the column name differs.

### Laravel (`--from laravel`)

Laravel keeps its schema in migrations, not in the models, so `--from laravel` works in two steps, with the tree-sitter PHP grammar (no PHP, Composer or database is needed). First it replays the migration files in order (sorted by file name, which starts with the timestamp) to rebuild the **current** schema: a column added by one migration, renamed by the next and dropped by a third is handled the way the database would. Then it reads the Eloquent models for what the migrations do not say: relation names and their reverse names, casts to backed enums, custom table names and timestamp handling. A table without a model is still converted (its model is named after the singular table name), and `down()` is ignored.

Pass the project root (only `database/migrations` and `app/` are read; `vendor/`, `storage/`, `tests/`, `bootstrap/cache` and `node_modules/` are skipped), or the migrations and model directories separately: `ormbridge convert -i ./database/migrations ./app/Models ./app/Enums --from laravel`. Files are recognised by what they contain, not by where they live: a class whose `up()` calls `Schema::`, a class that extends `Model` (or `Authenticatable`, or another model) and a backed enum, so a flat folder works too. Anonymous (`return new class extends Migration`) and named migration classes are both read. `.php` is not claimed, so pass `--from laravel`. Laravel output (`--to laravel`) is described above.

| Laravel migration                                                                                                                   | Read as                                                                                                                                                             |
| ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Schema::create`, `Schema::table`, `drop`, `dropIfExists`, `rename`, `dropColumns`                                                  | tables are created, altered, dropped and renamed in migration order                                                                                                 |
| `$table->dropColumn`, `renameColumn`, `->change()`                                                                                  | the column is removed, renamed (also inside indexes and keys) or restated (`change()` replaces the definition, as Laravel does)                                     |
| `dropIndex`, `dropUnique`, `dropFullText`, `dropPrimary`, `dropForeign`, `renameIndex`                                              | by name or by column list, using Laravel's default index names (`posts_title_index`)                                                                                |
| `dropTimestamps`, `dropSoftDeletes`, `dropRememberToken`, `dropMorphs`, `dropConstrainedForeignId`                                  | the columns they added are removed                                                                                                                                  |
| `id`, `bigIncrements`, `increments` and the tiny / small / medium variants, `integer(col, true)`                                    | auto-increment primary key (`BigInt` for `id` and `bigIncrements`)                                                                                                  |
| `string`, `char`, `text`, `mediumText`, `longText`, `tinyText`                                                                      | `string` with its length (255 by default), `text`                                                                                                                   |
| `integer`, `tinyInteger`, `smallInteger`, `mediumInteger`, `bigInteger` and the `unsigned*` variants, `year`                        | `int` / `bigInt` (unsigned is not tracked)                                                                                                                          |
| `boolean`, `decimal(col, total, places)`, `float`, `double`, `unsignedDecimal`                                                      | `boolean`, `decimal` with precision and scale (8, 2 by default), `float`                                                                                            |
| `date`, `dateTime`, `dateTimeTz`, `time`, `timeTz`, `timestamp`, `timestampTz`                                                      | `date`, `dateTime`, `time`                                                                                                                                          |
| `timestamps`, `timestampsTz`, `nullableTimestamps`, `softDeletes`, `softDeletesTz`, `rememberToken`                                 | expanded to `created_at` / `updated_at` (nullable), `deleted_at` (nullable), `remember_token` (`string(100)`, nullable)                                             |
| `json`, `jsonb`, `binary`, `uuid`, `ulid`, `ipAddress`                                                                              | `json`, `bytes`, `uuid`, `string(26)`, `ipAddress`                                                                                                                  |
| `enum(col, [...])`                                                                                                                  | a string column with an enum; a cast to a backed enum on the model supplies the enum name, otherwise one is created from the values (`PostStatus`)                  |
| `nullable`, `default` (literals, `DB::raw`, `now()`, `Carbon::now()`), `useCurrent`, `useCurrentOnUpdate`, `storedAs` / `virtualAs` | nullability, defaults (`CURRENT_TIMESTAMP` becomes `now`, `gen_random_uuid()` becomes a UUID default), auto-updated timestamps, generated columns                   |
| `unique`, `index`, `fullText`, `primary` (also with column lists and names), `->unique()` and `->index()` on a column               | unique columns, indexes (a name is kept only when it is not Laravel's default), composite primary keys                                                              |
| `foreignId()->constrained()`, `foreignUuid`, `foreignUlid`, `foreignIdFor`, `foreign()->references()->on()`, `onDelete`, `onUpdate` | a relation with its column, nullability and referential actions (`cascadeOnDelete`, `restrictOnDelete`, `nullOnDelete`, `noActionOnDelete` and the update variants) |
| `comment`, `after`, `first`, `charset`, `collation`, `engine`, `invisible`                                                          | ignored without a warning                                                                                                                                           |

| Eloquent model                                                                                               | Read as                                                                                                                                                                                                                                          |
| ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `class Post extends Model` (also `Authenticatable`, abstract base models, `Pivot`)                           | the table is `$table`, or Laravel's convention: the snake_case plural of the class name (`UserProfile` becomes `user_profiles`); a model without a table is skipped with a warning                                                               |
| `$casts` / `casts()` to a string-backed enum (PHP 8.1), `boolean`, `array` / `json`, `decimal:2`, `datetime` | the field gets the enum (declared in any file), and the types the cast implies                                                                                                                                                                   |
| `$timestamps`, `CREATED_AT`, `UPDATED_AT`                                                                    | with timestamps on, the update column refreshes on every save and the creation column starts at the current time; with `$timestamps = false` nothing is assumed                                                                                  |
| `use SoftDeletes`, `HasUuids`, `HasUlids`                                                                    | `deleted_at` is checked to exist; the primary key gets a generated UUID / ULID default                                                                                                                                                           |
| `belongsTo`, `hasMany`, `hasOne` (custom foreign and owner keys)                                             | name the relation (`author`) and its reverse (`posts`); the foreign key is `<method>_id` for `belongsTo` and `<model>_id` for `hasOne` / `hasMany`, as in Laravel; a `hasOne` or a unique column makes it one-to-one                             |
| `belongsToMany` (pivot table, key and `withPivot` arguments)                                                 | a pivot table that holds only the two keys (and optionally an `id` and timestamps) becomes a many-to-many field; the default pivot name is the singular model names in alphabetical order (`post_tag`); a pivot with other columns stays a model |

Everything is taken from the migrations and the models together, so a relation can come from a foreign key constraint, from a `belongsTo`, or from the `hasMany` on the other side; a foreign key column with none of the three is a plain column.

### GORM (`--from gorm`)

GORM has no schema file: the schema is the Go structs and their `gorm:"..."` tags. `--from gorm` reads them with the tree-sitter Go grammar (no Go toolchain or database is needed, and no Go code is run). Pass the directory that holds the models, or the files; every `.go` file is read, except `*_test.go` and anything below `vendor/`, `testdata/`, `node_modules/` and `.git/`. `.go` is not claimed, so pass `--from gorm`. GORM is read only for now: there is no `--to gorm` yet.

GORM does not mark a model, so a struct is read as one when it embeds `gorm.Model`, has a `gorm:"..."` tag, has a field called `ID`, has a `TableName()` method, or is the target of an association from another model. A struct that is only embedded in others (a shared base) is not a model of its own; unexported fields, `gorm:"-"` fields and `-:migration` fields are not columns.

Names follow GORM's own conventions, so the database names are reproduced exactly: tables are the pluralised snake_case struct name (`BlogPost` becomes `blog_posts`; the plural rules are those of `jinzhu/inflection`, which GORM uses) unless `TableName()` returns another literal or constant, columns are the snake_case field name (`PublicID` becomes `public_id`, with GORM's initialisms such as `ID`, `URL` and `HTTP`) unless `column:` says otherwise, a field called `ID` is the primary key, and a foreign key is `<Field>ID` (`AuthorID` for the field `Author`). The names were checked against GORM v1.31 (`gorm.io/gorm/schema`) for the test fixtures. Struct names are the model names; field names become camelCase (`PublicID` becomes `publicId`).

| GORM                                                                                                                      | Read as                                                                                                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `string`, `bool`, `int*`, `uint*`, `float*`, `[]byte`                                                                     | `text` (`string` with a length when `size:` is given), `boolean`, `int` up to 32 bits and `bigInt` above (as in GORM's PostgreSQL dialect, so `int`, `int64`, `uint` and `uint32` are `bigInt`), `float`, `bytes`       |
| `time.Time`, `time.Duration`, `uuid.UUID`, `decimal.Decimal`, `datatypes.JSON`, `datatypes.Date`, `net.IP`                | `dateTime`, `bigInt`, `uuid`, `decimal`, `json`, `date`, `ipAddress`                                                                                                                                                    |
| pointers, `sql.NullString` and the other `sql.Null*` types, `sql.Null[T]`, `gorm.DeletedAt`                               | a nullable column; a plain (non-pointer) field is required, as the Go code treats it (AutoMigrate itself only adds `NOT NULL` for `not null` and primary keys)                                                          |
| `type:`, `size:`, `precision:`, `scale:`, `serializer:json`                                                               | the SQL type (`varchar(n)`, `numeric(p,s)`, `jsonb`, arrays such as `text[]`, ...), length, digits and scale; a float with a precision is a `decimal`; an unknown SQL type is an unsupported column                     |
| `column:`, `primaryKey`, `autoIncrement`, `unique`, `not null`, `default:`                                                | column name, primary key (several make a composite key; an integer key auto-increments unless `autoIncrement:false`), unique, required, defaults (`now()`, `gen_random_uuid()`, literals, expressions)                  |
| `index`, `uniqueIndex` (named, composite with `priority:` or `composite:`), `sort:`, `length:`, `class:FULLTEXT`, `type:` | indexes; a single unnamed unique index becomes a unique field                                                                                                                                                           |
| `CreatedAt`, `UpdatedAt`, `autoCreateTime`, `autoUpdateTime`                                                              | a creation column defaulting to now, an update column refreshed on every save                                                                                                                                           |
| `gorm.Model`, `embedded`, `embeddedPrefix:`, anonymous embedded structs                                                   | the columns flattened into the owner, in order, with the prefix applied to the column names (a field of the owner shadows a promoted field of the same name)                                                            |
| `gorm.DeletedAt` (soft delete)                                                                                            | a nullable timestamp column, with a warning that GORM's query filtering is not represented                                                                                                                              |
| belongs to, has one, has many (`foreignKey:`, `references:`, composite keys, `constraint:OnDelete:...,OnUpdate:...`)      | a foreign key or one-to-one relation with its reverse name, found the way GORM finds it (by convention or by the tags); the foreign key field is replaced by the relation; composite keys become composite foreign keys |
| `many2many:table` (`joinForeignKey:`, `joinReferences:`), one or both sides declared                                      | a many-to-many field with its reverse name; a join table or column name that differs from the derived one is not preserved (warning)                                                                                    |
| `type Status string` with typed constants                                                                                 | an enum (`StatusDraft` is the member `Draft`); the column keeps its length and an enum default                                                                                                                          |
| `TableName()` returning a literal or a constant                                                                           | the table name                                                                                                                                                                                                          |

### Prisma constructs

The Prisma parser and emitter cover more than the Django mapping above. Constructs the shared model can carry survive a Prisma → Prisma round trip; the other formats get the closest equivalent and a warning naming the model and field.

| Prisma                                                                                                                    | Read as                                                                    | Written back / other formats                                                                                                                                                                        |
| ------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@relation(fields: [a, b], references: [x, y])` (composite foreign key, `onDelete`, `onUpdate`, `map:`)                   | composite foreign key; the columns stay plain fields                       | written back with the reverse field; dropped with a warning in Django, TypeORM, TypeScript and Graphene                                                                                             |
| `@@id([a, b], map: "...")`, `@id(map: "...")`, `@unique(map: "...")`, `@@index(..., map: "...")`, `@relation(map: "...")` | constraint names                                                           | written back where the provider supports them (primary key names are dropped with a warning on MySQL, SQLite and MongoDB, foreign key names on SQLite and MongoDB)                                  |
| `@@index([a(sort: Desc, length: 10, ops: ...)], type: Hash, clustered: ...)`                                              | index options                                                              | written back where the provider accepts them (`type` on PostgreSQL, `Gin` also on CockroachDB; `length` on MySQL; `ops` on PostgreSQL; `clustered` on SQL Server), otherwise dropped with a warning |
| `@@fulltext([a, b])`                                                                                                      | full-text index                                                            | `@@fulltext` on MySQL and MongoDB; an ordinary `@@index` with a warning elsewhere                                                                                                                   |
| `view` blocks                                                                                                             | model flagged as a view                                                    | `view` block (the header gets `previewFeatures = ["views"]`); other formats treat it as a table and warn                                                                                            |
| `Unsupported("circle")`                                                                                                   | opaque column (`Unsupported("int4range")` and friends become range fields) | `Unsupported("circle")` plus a warning that Prisma Client cannot use it; a plain string column and a warning elsewhere                                                                              |
| `@db.*` native types (PostgreSQL, CockroachDB, MySQL, SQL Server, MongoDB)                                                | carried on the field                                                       | written back when the target provider accepts that type for the scalar, otherwise dropped with a warning in favour of the provider default                                                          |
| `@default(cuid())`, `ulid()`, `nanoid(n)`, `uuid(7)`, `dbgenerated("...")`, `auto()`, `sequence()`                        | kept as defaults                                                           | written back; dropped with a warning in the other formats (`uuid()` still maps to a UUID default)                                                                                                   |
| `String[]`, `Int[]`, ... (scalar lists), `@default([])`                                                                   | array fields                                                               | scalar list on PostgreSQL, CockroachDB and MongoDB, `Json` elsewhere; `ArrayField` in Django, `array: true` in TypeORM                                                                              |
| `@@schema("...")` with the datasource `schemas` list (multiSchema), `@@map` on enums                                      | schema and database name                                                   | written back with the `schemas` list on PostgreSQL, CockroachDB and SQL Server, dropped with a warning elsewhere                                                                                    |
| `@ignore`, `@@ignore`                                                                                                     | flags                                                                      | written back; dropped with a warning in the other formats                                                                                                                                           |

The Prisma emitter also adapts to what the target provider rejects, each time with a warning naming the model and field: `Restrict` becomes `NoAction` on SQL Server, enums are written as `String` on SQL Server (which has none), `autoincrement()` on an `Int` becomes `sequence()` on CockroachDB, `Json` is written as `String @db.NVarChar(Max)` on SQL Server, and CockroachDB uses its own type names (`@db.String(n)`, not `@db.VarChar(n)`).

Prisma 7 changed the schema header: the `prisma-client` generator replaces `prisma-client-js` and needs an `output` path, and the datasource no longer takes `url` (connection URLs move to `prisma.config.ts`). Programmatic callers can pass `prismaVersion: 7` to `convertText` (or `emitPrisma`) to get that header; the default stays Prisma 6, and there is no CLI flag for it yet. ormbridge does not generate `prisma.config.ts` or the driver adapter that Prisma 7 needs at runtime.

### TypeScript interfaces (`--to typescript`)

Writes plain TypeScript interfaces and enums for sharing models with a front end (for example an Angular app). It is output only, needs no parser, and `.ts` is not inferred, so pass `--to typescript`.

- One `export interface` per model, with properties in the IR's order, and one string `export enum` per enum using the stored values (a Django choice label becomes a `/** ... */` comment). The IR carries no model or field help text, so no other doc comments are written.
- Types follow what travels as JSON: `string`, `text`, `uuid`, `time`, `bigInt`, `decimal` (to keep precision) and `bytes` (base64) are `string`; `int` and `float` are `number`; `boolean` is `boolean`; `json` is `unknown`. `DateTime` and `Date` are `string` (ISO 8601). Programmatic callers can pass `dates: 'date'` to `emitTypescriptInterfaces` to type them as `Date`; the CLI always writes `string`.
- Nullable fields get `| null`. Fields are never optional, because the interfaces describe the data a server returns, defaults included.
- A foreign key is written as its scalar (`categoryId: number`, typed from the referenced primary key or `to_field`) plus an optional expanded relation (`category?: Category`). Reverse sides are optional (`comments?: Comment[]`, a one-to-one reverse side is `profile?: Profile | null`), as are many-to-many lists on both sides.
- `--naming normalize` writes camelCase property names, `preserve` keeps the existing names. Names that are not valid identifiers are quoted.
- Warnings name the model and field for relations to unknown models, composite-key targets (the foreign key becomes `unknown`), unknown enums or field types, and invalid or clashing type names.

[Back to Table of Contents](#table-of-contents)

## Limitations and warnings

ormbridge never fails silently on something it cannot represent: each case produces a `warning:` on stderr naming the model and field. The main ones:

- `settings.AUTH_USER_MODEL` and `get_user_model()` are assumed to be a model named `User`. Models referenced but not found in the input get a stub with an auto-increment id.
- `GeneratedField` expressions are Python (`F`, `Concat`, ...), so they are carried only into Django output; Prisma and TypeORM get a regular column and a warning. Range fields are `Unsupported(...)` in Prisma and `string` in TypeORM and TypeScript objects (`{ lower, upper, bounds }`), nested arrays are `Json` in Prisma, `size=` on `ArrayField` is not kept, and `FileField` / `ImageField` / `FilePathField` / `GenericIPAddressField(protocol=...)` options are not kept (they come back as `CharField` or a plain IP field). `UniqueConstraint(condition=...)` (partial unique constraints), `GenericForeignKey` / `GenericRelation` and `CheckConstraint` are skipped with a warning.
- Python is parsed statically, so computed defaults, custom field classes, and fields added dynamically are skipped or approximated.
- Prisma composite primary keys become `models.CompositePrimaryKey` (Django 5.2+). Composite foreign keys, `Unsupported(...)` types, views, `@@fulltext`, `@@schema`, `@ignore` and client-generated defaults (`cuid()`, `ulid()`, `nanoid()`) have no direct Django, TypeORM, TypeScript or Graphene equivalent; the composite key columns stay as plain fields, a view becomes a table, and each case warns. Scalar lists become `ArrayField` (PostgreSQL only).
- Not read from Prisma schemas: composite types (`type` blocks, MongoDB), `relationMode`, the client-side `name:` of `@@unique` / `@@id`, partial indexes (`where:`), `@default(..., map:)` constraint names (SQL Server), and sort / length options on `@@id`. Native types are matched to the target provider by name only (the table was built with `prisma validate`); arguments such as a `VarChar` length are passed through unchanged. MongoDB output warns about ids that are not `@map("_id") @db.ObjectId` and about `Decimal` and compound ids, which Prisma rejects there. SQL Server cannot index `NVarChar(Max)` and MySQL needs a prefix length to index `TEXT`; indexes on such columns warn.
- Prisma's implicit many-to-many join table (`_AToB`) differs from Django's, so data needs migrating.
- TypeORM: entities are read from decorators only. Not supported, each with a warning naming the entity and column: `EntitySchema`, `@ChildEntity` / `@TableInheritance` (single-table inheritance), `@ViewEntity`, `@Tree*`, `@ObjectIdColumn`, `@VirtualColumn`, array columns, partial and spatial indexes, `@Check` / `@Exclusion`, composite foreign keys, relations inside embedded entities, and column options such as `unsigned`, `collation` and `transformer`. Custom `@JoinTable` names are not preserved. Relations without `onDelete` become `NoAction` and relations are nullable unless `nullable: false`, as in TypeORM. Numeric enums become integers.
- TypeORM many-to-many relations use TypeORM's join table (composite key), so Django's surrogate `id` column on the join table is not reproduced. SQL Server has no enum column, so enums become `varchar`. Database-side UUID defaults are not available on SQLite. MongoDB entities are not supported.
- Doctrine: only PHP 8 attributes are read. Docblock annotations (`@ORM\Entity`) are detected and reported with a warning (or an error when nothing else is found), and XML / YAML mappings are not read; both are planned. Not supported, each with a warning naming the entity and property: attribute and association overrides, composite foreign keys (several `#[ORM\JoinColumn]`), `columnDefinition`, `unsigned` / `comment` / `collation` and other column `options`, `insertable: false` / `updatable: false`, partial and spatial indexes, table `schema` and `options`, custom id generators and `#[ORM\SequenceGenerator]`, `array` / `object` / `simple_array` / custom DBAL types, int-backed and non-backed enums, relations inside embeddables, and the `#[ORM\DiscriminatorMap]` values (the discriminator column is kept, the map is not). Nullability follows the attribute (`nullable: true`), never the PHP type: Doctrine does not infer it, so `?string` with a plain `#[ORM\Column]` is `NOT NULL`. Custom join table names, ORM-level `cascade` / `fetch` / `orphanRemoval` and other runtime-only settings are not part of the schema and are not converted; `cascade: ['remove']` and `orphanRemoval` warn. A custom naming strategy configured outside the attributes cannot be seen, so Doctrine's underscore naming is assumed. Classes the input does not contain (a vendor base class or trait, an enum in another package) produce a warning that names the missing class.
- Laravel: the schema is rebuilt statically, so what Laravel decides at run time is not seen. A conditional or loop inside a migration is applied as if it always ran, and a dynamic table or column name is skipped; both warn and name the table. Raw SQL (`DB::statement`, `DB::unprepared`) is not interpreted, so a view, trigger, partial index or column created that way is missing, with a warning naming the table. Not represented, each with a warning naming the table and column: polymorphic relations (`morphs`, `morphTo`, `morphMany`, `morphToMany`; the `_type` and `_id` columns stay plain columns), derived relations (`hasManyThrough`, `hasOneThrough`, `*OfMany`), relation constraints (`->where(...)`), composite foreign keys, foreign keys to tables no migration creates, tables that migrations alter but never create (for example `users` from a package), `set`, geometry and `vector` columns, `macAddress` (kept as a string), identity columns, spatial indexes, custom pivot table and key names (the join table gets the name other formats derive: `blog_post_tags` survives, `post_tag` does not), pivot timestamps and non-cascading pivot keys, and `parentKey` / `relatedKey` that are not the primary key. Casts to custom cast classes and to int-backed enums are ignored. Mass-assignment and visibility properties (`$fillable`, `$guarded`, `$hidden`) are not part of the schema. Soft deletes have no IR equivalent beyond the nullable `deleted_at` column.
- GORM: only struct tags are read and nothing is executed, so a `TableName()` that computes its result, a custom `NamingStrategy` (prefix, `SingularTable`, `NoLowerCase`) set when the database is opened, and `Scanner` / `Valuer` types are not seen: the default naming is assumed, and such a type is an unsupported column unless a `type:` tag names the column type. Not represented, each with a warning naming the struct and field: polymorphic associations (`polymorphic:`; the `<Name>ID` and `<Name>Type` columns stay plain fields), `check:` constraints, column `comment:`, partial (`where:`) and expression indexes, soft delete beyond the nullable `deleted_at` column, integer-backed constant types (a plain integer column), `autoCreateTime` / `autoUpdateTime` on integer fields (Unix time), custom join table and column names, and `serializer:` values other than `json`, `gob` and `unixtime`. GORM ignores a `constraint:` tag on a belongs-to field when the other side describes the same key, and so does the parser (with a warning). Slices and maps without a `type:` or `serializer:` tag, which GORM cannot migrate, are read as arrays and `json` with a warning. Unsigned integers need one more bit in the type mapping, as in GORM's PostgreSQL dialect (`uint32` is `bigInt`).
- Generated names for Django indexes are shortened to Django's 30-character limit.

Always review the output and run your own migrations/`prisma validate` before applying it to a real database.

### Conversion matrix

[docs/CONVERSION_MATRIX.md](./docs/CONVERSION_MATRIX.md) shows, for every pair of readable and writable formats (Django, Prisma, TypeORM, Doctrine, Laravel), whether the schema survives a round trip and exactly what is lost when it does not (for example enum labels and column lengths, and Prisma's explicit join model for many-to-many fields). GORM, which can only be read for now, is listed as a source. It is generated from the test fixtures with `npm run docs:matrix`, and the tests fail if it is out of date.

Django models are read with a static [tree-sitter](https://tree-sitter.github.io/) parser, so **no Python, Django install, or database is needed**.

[Back to Table of Contents](#table-of-contents)

## Programmatic API

```ts
import { convertText } from 'ormbridge';

const result = await convertText([{ path: 'models.py', text: source }], {
  from: 'django',
  to: 'prisma',
  naming: 'preserve',
  provider: 'postgresql',
  header: true,
  appLabel: 'shop',
  autoField: 'int',
});

if (!result.ok) {
  console.error(`${result.error.code}: ${result.error.message}`);
} else {
  console.log(result.value.output);
  console.warn(result.value.warnings);
}
```

All functions return a `Result` (`{ ok: true, value } | { ok: false, error }`) instead of throwing, with a descriptive error code and message. Parsers and emitters are exported too (`parseDjango`, `parsePrisma`, `parseTypeorm`, `parseDoctrine`, `parseLaravel`, `emitPrisma`, `emitDjango`, `emitDoctrine`, `emitLaravel`), all built on a shared intermediate representation, which is how new formats plug in.

### Format registry

Each format is an adapter registered in `src/formats.ts`: a `name`, its file `extensions`, a `description`, and an optional `parse` and/or `emit`. `convertText` and the CLI look formats up in the registry, so a format that only has `emit` is output-only and one that only has `parse` is input-only. Lookups return a `Result` with a descriptive error for unknown or unsupported formats.

```ts
import { getFormat, listFormats, registerFormat } from 'ormbridge';

const adapter = getFormat('prisma'); // Result<FormatAdapter>
const formats = listFormats(); // every registered adapter
registerFormat({
  name: 'example',
  extensions: ['.example'],
  description: 'An output-only example format',
  emit: (schema, options) => ({ ok: true, value: { text: '', warnings: [] } }),
});
```

#### Emitter output

`emit` returns `Result<FormatEmitOutput>`, which is either `{ text, warnings }` (one file, what every built-in emitter returns) or `{ files, warnings }`, where `files` maps a relative path (forward slashes, no leading slash, no `..`) to the file text. Return the second form when the format needs several files:

```ts
emit: (schema) => ({
  ok: true,
  value: {
    files: { 'src/Entity/Post.php': '<?php ...', 'config/orm.yaml': '...' },
    warnings: [],
  },
}),
```

`convertText` then returns `files` next to an empty `output`, and the CLI writes the map under the `-o` directory. A multi-file format cannot print to stdout.

[Back to Table of Contents](#table-of-contents)

## License

MIT

## Copyright

(c)2026 Richard McQuiston.

## Buy Me a Coffee

If this app, code, or repository has helped you or someone you know, please consider donating. I appreciate any help to offset the costs of development and/or AI Credits.

[**Donate via Stripe**](https://donate.stripe.com/00w5kD3Gj1Xo9v7gVOcs800), or scan:

[![Donate via Stripe](./donate.svg)](https://donate.stripe.com/00w5kD3Gj1Xo9v7gVOcs800)
