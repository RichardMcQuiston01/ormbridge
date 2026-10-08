# ormbridge

Convert ORM models between frameworks and languages, so one data model can be shared across your whole stack, from the command line or from code.

See [What is converted](#what-is-converted) for the formats currently supported.

- **No Python needed.** Django models are parsed statically, so there is no Django install, virtualenv, or database connection.
- **Safe for existing databases.** The default mode keeps your Django table and column names, so Prisma can sit on top of the database you already have.
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
```

Formats are inferred from file extensions (`.py` = Django, `.prisma` = Prisma, `.ts` = TypeORM), or set explicitly with `--from` / `--to`. Passing a directory does not infer the format, so add `--from typeorm` when reading a folder of TypeORM entities. Run `ormbridge formats` to list every supported format, its file extensions, and whether it can be read, written, or both. Without `-o`, the result is printed to stdout. Warnings go to stderr.

| Flag                     | Default        | Description                                                                                                                             |
| ------------------------ | -------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `-i, --input <paths...>` | required       | Files or directories to read. Several files are merged into one schema, so abstract base classes can live in another file.              |
| `-o, --output <path>`    | stdout         | File to write. Parent directories are created.                                                                                          |
| `-f, --from <format>`    | inferred       | `django`, `prisma` or `typeorm`                                                                                                         |
| `-t, --to <format>`      | inferred       | `django`, `prisma`, `typeorm`, `typescript` or `graphene` (output only)                                                                 |
| `--naming <mode>`        | `preserve`     | `preserve` or `normalize` (see below)                                                                                                   |
| `--provider <name>`      | `postgresql`   | Prisma datasource: `postgresql`, `mysql`, `sqlite`, `sqlserver`, `mongodb`, `cockroachdb`. Controls native types such as `@db.VarChar`. |
| `--no-header`            | off            | Omit the Prisma `generator` / `datasource` blocks (useful when pasting models into an existing schema).                                 |
| `--app-label <name>`     | directory name | Django app label used for default table names (`<app>_<model>`).                                                                        |
| `--auto-field <type>`    | `int`          | Key type for Django models without an explicit primary key: `int` or `bigint`.                                                          |

[Back to Table of Contents](#table-of-contents)

### Naming modes

**`preserve`** (default) keeps the existing database working unchanged: Django table names (`blog_post`) are kept via `@@map`, columns keep their names, and each Django many-to-many field becomes an explicit join model that matches the table Django already created.

**`normalize`** produces a fresh-schema style: singular snake_case table names (`post`), UUID primary keys in place of auto-increment ids, camelCase Prisma fields mapped to snake_case columns, `created_at` / `updated_at` added to models that lack them, and implicit many-to-many relations.

## What is converted

| Django                                                                                                         | Prisma                                                                   | TypeORM                                                                                               |
| -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| `CharField`, `SlugField`, `EmailField`, `URLField`                                                             | `String @db.VarChar(n)`                                                  | `@Column({ type: 'varchar', length: n })`                                                             |
| `TextField`                                                                                                    | `String @db.Text`                                                        | `@Column({ type: 'text' })`                                                                           |
| `Integer*`, `PositiveInteger*` / `BigInteger*` / `AutoField` / `BigAutoField`                                  | `Int` / `BigInt` / `@default(autoincrement())`                           | `int` / `bigint` (`string`), `@PrimaryGeneratedColumn('increment')`                                   |
| `FloatField`, `DecimalField`                                                                                   | `Float`, `Decimal @db.Decimal(p, s)`                                     | `float`, `decimal` with `precision` / `scale` (`string`)                                              |
| `BooleanField`, `UUIDField`, `JSONField`, `BinaryField`                                                        | `Boolean`, `String @db.Uuid`, `Json`, `Bytes`                            | `boolean`, `uuid`, `jsonb`, `bytea` (types follow `--provider`)                                       |
| `DateTimeField`, `DateField`, `TimeField`                                                                      | `DateTime` (with `@db.Date` / `@db.Time`)                                | `timestamptz` / `date` / `time`                                                                       |
| `ArrayField(base_field)` (nested arrays too)                                                                   | scalar list `String[]` (PostgreSQL, CockroachDB, MongoDB)                | `array: true` on PostgreSQL, `json` elsewhere                                                         |
| `HStoreField`                                                                                                  | `Json`                                                                   | `hstore` on PostgreSQL, `json` elsewhere                                                              |
| `IntegerRangeField`, `BigIntegerRangeField`, `DecimalRangeField`, `DateRangeField`, `DateTimeRangeField`       | `Unsupported("int4range")` and friends on PostgreSQL, `String` elsewhere | `int4range`, `int8range`, `numrange`, `daterange`, `tstzrange` on PostgreSQL                          |
| `GenericIPAddressField`, `IPAddressField`                                                                      | `String @db.Inet` (PostgreSQL)                                           | `inet` on PostgreSQL, `varchar(45)` elsewhere                                                         |
| `DurationField`                                                                                                | `BigInt` (no interval type)                                              | `interval` on PostgreSQL, `bigint` elsewhere                                                          |
| `FileField`, `ImageField`, `FilePathField`, `SmallIntegerField`, `PositiveSmallIntegerField`, `SmallAutoField` | `String`, `Int` as above                                                 | `varchar(100)`, `int` as above                                                                        |
| `GeneratedField` (`expression`, `output_field`, `db_persist`)                                                  | regular column plus a warning                                            | regular column plus a warning                                                                         |
| `db_default` (`Value(...)`, `Now()`, literals)                                                                 | `@default(...)`                                                          | `default: ...`                                                                                        |
| `auto_now_add` / `auto_now`                                                                                    | `@default(now())` / `@updatedAt`                                         | `@CreateDateColumn` / `@UpdateDateColumn`                                                             |
| `default=uuid.uuid4`, `timezone.now`, literals                                                                 | `@default(uuid())`, `@default(now())`, literals                          | `@PrimaryGeneratedColumn('uuid')`, `default: () => 'CURRENT_TIMESTAMP'`, literals                     |
| `TextChoices`, inline `choices=[...]`                                                                          | `enum`                                                                   | TypeScript `enum` plus `@Column({ type: 'enum', enum })`                                              |
| `ForeignKey`, `OneToOneField` (`on_delete`, `related_name`, `null`)                                            | `@relation(... onDelete: ...)` plus the reverse field                    | `@ManyToOne` / `@OneToOne` with `@JoinColumn` and `onDelete`, plus `@OneToMany` / inverse `@OneToOne` |
| `ManyToManyField`                                                                                              | join model (`preserve`) or implicit relation (`normalize`)               | `@ManyToMany` with `@JoinTable` and the inverse side                                                  |
| `Meta.db_table`, `unique_together`, `indexes`, `UniqueConstraint`, `db_index`                                  | `@@map`, `@@unique`, `@@index`                                           | `@Entity('table')`, `@Unique([...])`, `@Index([...])`                                                 |
| Abstract base classes, multi-table inheritance                                                                 | fields inherited / one-to-one primary key                                | fields inherited / one-to-one primary key                                                             |
| Proxy models (`Meta.proxy`), `Meta.swappable`, `models.CompositePrimaryKey`                                    | merged into the concrete model / resolved / `@@id`                       | merged into the concrete model / resolved / composite `@PrimaryColumn`                                |

TypeORM output is a single TypeScript file of entity classes. Relations use `Relation<T>` so entities declared in one file do not trip over circular references, and `--provider` picks the column types (`timestamptz` and `jsonb` for PostgreSQL, `datetime` and `json` for MySQL, `simple-json` for SQLite). Use `--naming normalize` for camelCase properties mapped to snake_case columns with `name:` options. `.ts` is not inferred as a format, so pass `--from typeorm` or `--to typeorm`. Reading uses decorators only (see Limitations). TypeORM entities are parsed statically with tree-sitter (no `reflect-metadata`, TypeScript compiler, or database needed), and the same naming modes apply to the result.

Graphene output (`--to graphene`) is write-only and pairs with Django models: it writes one Python file that imports every model from `.models` (generate it with `--to django`, or use your own models) and defines a `DjangoObjectType` per model with an explicit `Meta.fields` list (forward and reverse relations included), a `Query` with a single-item field (`post(id)`) and a list field (`post_list`) per model, `Create`/`Update`/`Delete` mutations built on `graphene.Mutation`, and a final `schema = graphene.Schema(query=Query, mutation=Mutation)`. Inputs map the scalar types to `String`, `Int`, `BigInt`, `Float`, `Decimal`, `Boolean`, `DateTime`, `Date`, `Time`, `UUID` and `JSONString`; a field is required when it is not nullable and has no default, and relations are `ID` inputs (`author_id`, many-to-many `tags_ids`). Enum-backed fields rely on graphene-django's choice conversion for output and are `String` inputs validated by the model. Binary columns and relations to models outside the schema are left out, and models with a composite primary key get only a list query and a create mutation; each case produces a warning naming the model and field. Field names are snake_case like the Django output, `.py` stays owned by Django so pass `--to graphene`, and the naming mode has no effect. Requires graphene-django 3.x at runtime.

Django-only constructs: a proxy model (`Meta.proxy = True`) has no table of its own, so it is merged into its concrete model (chains of proxies are followed) and relations that target it are pointed at the concrete model, with a warning. A model with `Meta.swappable = "AUTH_USER_MODEL"` is used as the target of `settings.AUTH_USER_MODEL` and `get_user_model()` instead of an assumed `User`. Custom managers (`objects = MyManager()`, `Manager.from_queryset(...)()`, `QuerySet.as_manager()`) and the classes behind them are ignored without warnings. `django.contrib.postgres` arrays, HStore and range fields, and `GeneratedField` / `db_default` (Django 5.0+), round-trip through `--to django`; the Django emitter writes the `django.contrib.postgres.fields` import and notes the required Django version in a warning.

Prisma → Django applies the reverse mapping. Field names are converted from camelCase to snake_case, with `db_column` set when the column name differs.

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
- Generated names for Django indexes are shortened to Django's 30-character limit.

Always review the output and run your own migrations/`prisma validate` before applying it to a real database.

### Conversion matrix

[docs/CONVERSION_MATRIX.md](./docs/CONVERSION_MATRIX.md) shows, for every pair of readable and writable formats (Django, Prisma, TypeORM), whether the schema survives a round trip and exactly what is lost when it does not (for example enum labels and column lengths, and Prisma's explicit join model for many-to-many fields). It is generated from the test fixtures with `npm run docs:matrix`, and the tests fail if it is out of date.

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

All functions return a `Result` (`{ ok: true, value } | { ok: false, error }`) instead of throwing, with a descriptive error code and message. Parsers and emitters are exported too (`parseDjango`, `parsePrisma`, `parseTypeorm`, `emitPrisma`, `emitDjango`), all built on a shared intermediate representation, which is how new formats plug in.

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

[Back to Table of Contents](#table-of-contents)

## License

MIT

## Copyright

(c)2026 Richard McQuiston.

## Buy Me a Coffee

If this app, code, or repository has helped you or someone you know, please consider donating. I appreciate any help to offset the costs of development and/or AI Credits.

[**Donate via Stripe**](https://donate.stripe.com/00w5kD3Gj1Xo9v7gVOcs800), or scan:

[![Donate via Stripe](./donate.svg)](https://donate.stripe.com/00w5kD3Gj1Xo9v7gVOcs800)
