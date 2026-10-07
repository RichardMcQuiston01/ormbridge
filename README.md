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
```

Formats are inferred from file extensions (`.py` = Django, `.prisma` = Prisma), or set explicitly with `--from` / `--to`. Run `ormbridge formats` to list every supported format, its file extensions, and whether it can be read, written, or both. Without `-o`, the result is printed to stdout. Warnings go to stderr.

| Flag                     | Default        | Description                                                                                                                             |
| ------------------------ | -------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `-i, --input <paths...>` | required       | Files or directories to read. Several files are merged into one schema, so abstract base classes can live in another file.              |
| `-o, --output <path>`    | stdout         | File to write. Parent directories are created.                                                                                          |
| `-f, --from <format>`    | inferred       | `django` or `prisma`                                                                                                                    |
| `-t, --to <format>`      | inferred       | `django` or `prisma`                                                                                                                    |
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

| Django                                                                        | Prisma                                                     |
| ----------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `CharField`, `SlugField`, `EmailField`, `URLField`                            | `String @db.VarChar(n)`                                    |
| `TextField`                                                                   | `String @db.Text`                                          |
| `Integer*`, `PositiveInteger*` / `BigInteger*` / `AutoField` / `BigAutoField` | `Int` / `BigInt` / `@default(autoincrement())`             |
| `FloatField`, `DecimalField`                                                  | `Float`, `Decimal @db.Decimal(p, s)`                       |
| `BooleanField`, `UUIDField`, `JSONField`, `BinaryField`                       | `Boolean`, `String @db.Uuid`, `Json`, `Bytes`              |
| `DateTimeField`, `DateField`, `TimeField`                                     | `DateTime` (with `@db.Date` / `@db.Time`)                  |
| `auto_now_add` / `auto_now`                                                   | `@default(now())` / `@updatedAt`                           |
| `default=uuid.uuid4`, `timezone.now`, literals                                | `@default(uuid())`, `@default(now())`, literals            |
| `TextChoices`, inline `choices=[...]`                                         | `enum`                                                     |
| `ForeignKey`, `OneToOneField` (`on_delete`, `related_name`, `null`)           | `@relation(... onDelete: ...)` plus the reverse field      |
| `ManyToManyField`                                                             | join model (`preserve`) or implicit relation (`normalize`) |
| `Meta.db_table`, `unique_together`, `indexes`, `UniqueConstraint`, `db_index` | `@@map`, `@@unique`, `@@index`                             |
| Abstract base classes, multi-table inheritance                                | fields inherited / one-to-one primary key                  |

Prisma → Django applies the reverse mapping. Field names are converted from camelCase to snake_case, with `db_column` set when the column name differs.

[Back to Table of Contents](#table-of-contents)

## Limitations and warnings

ormbridge never fails silently on something it cannot represent: each case produces a `warning:` on stderr naming the model and field. The main ones:

- `settings.AUTH_USER_MODEL` and `get_user_model()` are assumed to be a model named `User`. Models referenced but not found in the input get a stub with an auto-increment id.
- Python is parsed statically, so computed defaults, custom field classes, and fields added dynamically are skipped or approximated.
- Prisma composite primary keys become `models.CompositePrimaryKey` (Django 5.2+). Composite foreign keys, `Unsupported(...)` types, and scalar lists have no direct Django equivalent.
- Prisma's implicit many-to-many join table (`_AToB`) differs from Django's, so data needs migrating.
- Generated names for Django indexes are shortened to Django's 30-character limit.

Always review the output and run your own migrations/`prisma validate` before applying it to a real database.

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

All functions return a `Result` (`{ ok: true, value } | { ok: false, error }`) instead of throwing, with a descriptive error code and message. Parsers and emitters are exported too (`parseDjango`, `parsePrisma`, `emitPrisma`, `emitDjango`), all built on a shared intermediate representation, which is how new formats plug in.

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
