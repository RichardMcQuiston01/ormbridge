# Examples

One runnable project per format. Each folder converts the shared blog schema in [`schema/schema.prisma`](schema/schema.prisma) (user, profile, post, category and tag models and a status enum) with `ormbridge convert`, and every generated file is committed so you can read the output without running anything.

| Folder                       | Format                  | Direction                                           |
| ---------------------------- | ----------------------- | --------------------------------------------------- |
| [`django`](django)           | Django models           | Prisma to Django (`models/`), Django back to Prisma |
| [`prisma`](prisma)           | Prisma schema           | Django to Prisma with `--naming normalize`          |
| [`typeorm`](typeorm)         | TypeORM entities        | both ways                                           |
| [`doctrine`](doctrine)       | Doctrine entities (PHP) | both ways                                           |
| [`laravel`](laravel)         | Laravel migrations      | both ways                                           |
| [`gorm`](gorm)               | GORM structs (Go)       | both ways                                           |
| [`drizzle`](drizzle)         | Drizzle ORM             | both ways                                           |
| [`json-schema`](json-schema) | JSON Schema / OpenAPI   | both ways                                           |
| [`sql`](sql)                 | SQL DDL                 | both ways                                           |
| [`sqlalchemy`](sqlalchemy)   | SQLAlchemy / SQLModel   | both ways                                           |
| [`sequelize`](sequelize)     | Sequelize models        | both ways                                           |
| [`efcore`](efcore)           | Entity Framework Core   | both ways                                           |
| [`graphene`](graphene)       | Graphene (GraphQL)      | write only (`generated/`)                           |
| [`typescript`](typescript)   | TypeScript interfaces   | write only (`generated/`)                           |
| [`zod`](zod)                 | Zod schemas             | write only (`generated/`)                           |

Folder layout:

- `ormbridge.config.json` lists the conversions ([config file reference](../docs/CLI.md#config-file)).
- `models/` (or `generated/` for write-only formats) holds the files written from the shared schema.
- `prisma/schema.prisma` holds the schema read back from `models/`, so you can compare it with the original.

Run an example from its folder:

```bash
cd examples/django
npx ormbridge convert            # rewrite the generated files
npx ormbridge convert --check    # exit 3 if they are stale
```

Inside this repository, `npm run examples` rewrites every example with the built CLI, and `npm run examples:check` (also part of the test suite) fails when any of them is out of date. The guide for each format is in [`docs/formats`](../docs/formats/README.md).
