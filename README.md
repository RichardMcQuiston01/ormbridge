# ormbridge

- Author: [Richard McQuiston](mailto:richard.mcquiston@gmail.com)
- Website: https://richardmcquiston.com/

## Table of Contents

| [Overview](#overview) | [Getting Started](#getting-started) | [More Information](#more-information) | [Buy Me a Coffee](#buy-me-a-coffee) | [License](#license) | [Copyright](#copyright) |

## Overview

ormbridge converts data models from one Object-Relational Mapper (ORM) to another. You define a model once and share it across your whole stack. Use it from the command line or from code.

It reads source files with [tree-sitter](https://tree-sitter.github.io/), so you do not need Python, PHP, Go, or a database. The default `preserve` mode keeps your table and column names, so a new tool can sit on top of the database you already have. When something cannot be converted, ormbridge prints a warning that names the model and field.

| Format                      | Read | Write | Notes                                                                                                                                |
| --------------------------- | :--: | :---: | ------------------------------------------------------------------------------------------------------------------------------------ |
| Django models               |  ✔   |   ✔   | `models.py` files or `models/` packages                                                                                              |
| Prisma schema               |  ✔   |   ✔   | All six providers; Prisma 7 header with `--prisma-version 7`                                                                         |
| TypeORM entities            |  ✔   |   ✔   | Decorator-based entity classes                                                                                                       |
| Doctrine ORM entities (PHP) |  ✔   |   ✔   | PHP 8 attributes; one file per entity                                                                                                |
| Laravel (PHP)               |  ✔   |   ✔   | Reads migrations plus Eloquent models; writes both                                                                                   |
| GORM (Go)                   |  ✔   |   ✔   | Structs with `gorm` tags; one file per model                                                                                         |
| Drizzle ORM (TypeScript)    |  ✔   |   ✔   | `pgTable`, `mysqlTable`, `sqliteTable` plus `relations()`                                                                            |
| Zod schemas (TypeScript)    |  ✔   |   ✔   | Reads Zod 3 and Zod 4 `z.object` schemas; writes Zod 4 schemas and inferred types                                                    |
| JSON Schema / OpenAPI       |  ✔   |   ✔   | Draft 2020-12, 2019-09 and 7, and OpenAPI `components.schemas` (JSON)                                                                |
| SQL DDL                     |  ✔   |   ✔   | Tables and migrations: PostgreSQL, CockroachDB, MySQL, SQLite, SQL Server, ClickHouse (write only)                                   |
| SQLAlchemy / SQLModel       |  ✔   |   ✔   | SQLAlchemy 2.0 (declarative, `Column()`, `Table()`) and SQLModel                                                                     |
| Sequelize (JavaScript/TS)   |  ✔   |   ✔   | Sequelize 6 and 7, `sequelize-cli` migrations; writes TypeScript, `sequelize-cli` (`--style define`) or v7 decorators (`--style v7`) |
| Entity Framework Core (C#)  |  ✔   |   ✔   | EF Core 8: annotations or `--style fluent`, and a `DbContext`                                                                        |
| Hibernate / JPA (Java)      |  ✔   |   ✔   | Hibernate 6 `jakarta` or 5 `--style javax`; `@EmbeddedId` keys; Lombok option                                                        |
| TypeScript interfaces       |      |   ✔   | Plain interfaces and enums for front ends                                                                                            |
| Graphene (graphene-django)  |      |   ✔   | GraphQL types, queries and mutations that pair with Django                                                                           |
| Neo4j (Cypher)              |      |   ✔   | Node constraints and indexes; relationships as comments; `--style enterprise` for Enterprise                                         |
| Spring Data Neo4j (Java)    |      |   ✔   | SDN 7 for Spring Boot 3: `@Node`, `@Relationship`, `@RelationshipProperties` classes                                                 |
| neomodel (Python, Neo4j)    |      |   ✔   | `StructuredNode` classes, relationships with cardinality, `StructuredRel` for join tables                                            |

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
- `--provider <name>`: the database to target: `postgresql`, `mysql`, `sqlite`, `sqlserver`, `mongodb`, `cockroachdb` or `clickhouse`. `cockroachdb` keeps the PostgreSQL types and warns about every difference (64-bit integers, `unique_rowid()` keys, no hstore or range types). MariaDB and Percona Server are MySQL-compatible, so use `mysql` for them. `clickhouse` is written by `--to sql` only.
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

Prisma to Zod schemas, and Zod schemas to Prisma (a folder needs `--from zod`):

```bash
ormbridge convert -i ./prisma/schema.prisma --to zod -o ./src/schemas.ts
ormbridge convert --from zod -i ./src/schemas -o ./prisma/schema.prisma
```

Prisma to a Neo4j Cypher schema (constraints and indexes; `--style enterprise` adds Enterprise Edition statements):

```bash
ormbridge convert -i ./prisma/schema.prisma --to neo4j -o ./neo4j/schema.cypher
```

Prisma to Spring Data Neo4j entities (Java, for Neo4j):

```bash
ormbridge convert -i ./prisma/schema.prisma --to sdn -o ./src/main/java
```

Prisma to neomodel classes (Python, for Neo4j):

```bash
ormbridge convert -i ./prisma/schema.prisma --to neomodel -o ./app/models.py
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
