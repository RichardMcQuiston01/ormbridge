# ormbridge

- Author: [Richard McQuiston](mailto:richard.mcquiston@gmail.com)
- Website: https://richardmcquiston.com/

## Table of Contents

| [Overview](#overview) | [Getting Started](#getting-started) | [More Information](#more-information) | [Buy Me a Coffee](#buy-me-a-coffee) | [License](#license) | [Copyright](#copyright) |

## Overview

ormbridge converts data models from one Object-Relational Mapper (ORM) to another. You define a model once and share it across your whole stack. Use it from the command line or from code.

It reads source files with [tree-sitter](https://tree-sitter.github.io/), so you do not need Python, PHP, Go, or a database. The default `preserve` mode keeps your table and column names, so a new tool can sit on top of the database you already have. When something cannot be converted, ormbridge prints a warning that names the model and field.

| Format                      | Read | Write | Notes                                                                          |
| --------------------------- | :--: | :---: | ------------------------------------------------------------------------------ |
| Django models               |  ✔   |   ✔   | `models.py` files or `models/` packages                                        |
| Prisma schema               |  ✔   |   ✔   | All six providers; Prisma 7 header with `--prisma-version 7`                   |
| TypeORM entities            |  ✔   |   ✔   | Decorator-based entity classes                                                 |
| Doctrine ORM entities (PHP) |  ✔   |   ✔   | PHP 8 attributes; one file per entity                                          |
| Laravel (PHP)               |  ✔   |   ✔   | Reads migrations plus Eloquent models; writes both                             |
| GORM (Go)                   |  ✔   |   ✔   | Structs with `gorm` tags; one file per model                                   |
| Drizzle ORM (TypeScript)    |  ✔   |   ✔   | `pgTable`, `mysqlTable`, `sqliteTable` plus `relations()`                      |
| JSON Schema / OpenAPI       |  ✔   |   ✔   | Draft 2020-12, 2019-09 and 7, and OpenAPI `components.schemas` (JSON)          |
| SQL DDL                     |  ✔   |   ✔   | `CREATE TABLE` and more for PostgreSQL, CockroachDB, MySQL, SQLite, SQL Server |
| SQLAlchemy / SQLModel       |  ✔   |   ✔   | SQLAlchemy 2.0 (declarative, `Column()`, `Table()`) and SQLModel               |
| Sequelize (JavaScript/TS)   |  ✔   |   ✔   | Sequelize 6; writes TypeScript or `sequelize-cli` (`--style define`)           |
| Entity Framework Core (C#)  |  ✔   |   ✔   | EF Core 8: annotations or `--style fluent`, and a `DbContext`                  |
| Hibernate / JPA (Java)      |  ✔   |   ✔   | Hibernate 6 `jakarta` (default) or Hibernate 5 `--style javax`                 |
| TypeScript interfaces       |      |   ✔   | Plain interfaces and enums for front ends                                      |
| Graphene (graphene-django)  |      |   ✔   | GraphQL types, queries and mutations that pair with Django                     |
| Zod schemas                 |      |   ✔   | Zod 4 schemas and inferred types                                               |

Each format has a [guide](./docs/formats/README.md) and a runnable [example project](./examples/README.md).

[Back to Top](#table-of-contents)

## Getting Started

### Prerequisites

- Node.js 20 or newer.

### Installation

```bash
npm install --global ormbridge
```

You can also run it without installing: `npx ormbridge convert ...`.

### Usage

Run `ormbridge convert` with an input, an output, and optionally the formats:

```bash
ormbridge convert -i ./shop/models.py -o ./prisma/schema.prisma
```

Django (`.py`), Prisma (`.prisma`), and SQL (`.sql`) files are detected from the file extension. For every other format, add `--from` or `--to`. List all formats with `ormbridge formats`.

Useful options:

- `--naming preserve|normalize`: keep existing names (default), or write singular snake_case names with UUID keys.
- `--provider <name>`: the database to target: `postgresql`, `mysql`, `sqlite`, `sqlserver`, `mongodb` or `cockroachdb`. `cockroachdb` keeps the PostgreSQL types and warns about every difference (64-bit integers, `unique_rowid()` keys, no hstore or range types). MariaDB and Percona Server are MySQL-compatible, so use `mysql` for them.
- `--dry-run`: show what would be written, and write nothing.
- `--check`: exit with code 3 if an output file is out of date. Use it in Continuous Integration (CI).

You can keep your settings in an `ormbridge.config.json` file. See the [command line reference](./docs/CLI.md) for every option, the config file, and exit codes.

### Examples

Prisma to Django:

```bash
ormbridge convert -i ./prisma/schema.prisma -o ./shop/models.py
```

A TypeORM project to Prisma (a folder needs `--from`):

```bash
ormbridge convert --from typeorm -i ./src/entities -o ./prisma/schema.prisma
```

Prisma to Zod schemas:

```bash
ormbridge convert -i ./prisma/schema.prisma --to zod -o ./src/schemas.ts
```

Fail a build when generated files are out of date:

```bash
npx ormbridge convert --check
```

Use it from code:

```ts
import { convertText } from 'ormbridge';

const result = await convertText(
  [{ path: 'schema.prisma', text: prismaSource }],
  {
    from: 'prisma',
    to: 'django',
    naming: 'preserve',
    provider: 'postgresql',
    header: true,
    autoField: 'int',
  }
);
if (result.ok) {
  console.log(result.value.output);
}
```

The [API reference](./docs/API.md) lists every function. Each folder in [`examples/`](./examples/README.md) is a project you can run.

[Back to Top](#table-of-contents)

## More Information

- [Command line reference](./docs/CLI.md): options, config file, exit codes, multi-file output, and naming modes.
- [Format guides](./docs/formats/README.md): what each format reads and writes, and what it loses.
- [Examples](./examples/README.md): one runnable project per format.
- [Field mapping](./docs/FIELD_MAPPING.md): how each field type converts.
- [Limitations and warnings](./docs/LIMITATIONS.md): what cannot be converted, and how it was tested.
- [Conversion matrix](./docs/CONVERSION_MATRIX.md): what survives a round trip between every pair of formats.
- [API reference](./docs/API.md): `convertText`, the format registry, and more.
- [Changelog](./CHANGELOG.md) and [roadmap](./ROADMAP.md).
- [Test guide](./test/README.md): how the tests and the optional real-tool checks work.

[Back to Top](#table-of-contents)

## Buy Me a Coffee

If this app, code, or repository has helped you or someone you know, please consider donating. I appreciate any help to offset the costs of development and/or AI Credits.

[**Donate via Stripe**](https://donate.stripe.com/00w5kD3Gj1Xo9v7gVOcs800), or scan:

[![Donate via Stripe](./donate.svg)](https://donate.stripe.com/00w5kD3Gj1Xo9v7gVOcs800)

[Back to Top](#table-of-contents)

## License

MIT

[Back to Top](#table-of-contents)

## Copyright

(c)2026 Richard McQuiston. All rights reserved.

[Back to Top](#table-of-contents)
