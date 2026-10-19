# Format guides

One guide per format: what is read, what is written, the options that apply, and what is lost. Each guide links to a runnable project in [`examples/`](../../examples/README.md). For the cell-by-cell comparison of every pair of formats, see the [conversion matrix](../CONVERSION_MATRIX.md).

| Format                                  | Reads | Writes | Notes                                                     |
| --------------------------------------- | :---: | :----: | --------------------------------------------------------- |
| [Django](django.md)                     |  yes  |  yes   | `models.py` or a `models/` package; claims `.py`          |
| [Prisma](prisma.md)                     |  yes  |  yes   | `schema.prisma`; Prisma 6 and 7 headers                   |
| [TypeORM](typeorm.md)                   |  yes  |  yes   | Entity classes, decorators                                |
| [Doctrine](doctrine.md)                 |  yes  |  yes   | PHP 8 attributes                                          |
| [Laravel](laravel.md)                   |  yes  |  yes   | Migrations are replayed; Eloquent models name relations   |
| [GORM](gorm.md)                         |  yes  |  yes   | Go structs with `gorm` tags                               |
| [Drizzle](drizzle.md)                   |  yes  |  yes   | `pgTable`, `mysqlTable`, `sqliteTable`                    |
| [JSON Schema / OpenAPI](json-schema.md) |  yes  |  yes   | Draft 2020-12 and `components.schemas`                    |
| [SQL DDL](sql.md)                       |  yes  |  yes   | PostgreSQL, MySQL, SQLite, SQL Server                     |
| [SQLAlchemy / SQLModel](sqlalchemy.md)  |  yes  |  yes   | Declarative, `Column()` and `Table()` styles              |
| [Sequelize](sequelize.md)               |  yes  |  yes   | Sequelize 6: `define`, `Model.init`, sequelize-typescript |
| [Entity Framework Core](efcore.md)      |  yes  |  yes   | EF Core 8: annotations or fluent API, `DbContext`         |
| [Hibernate / JPA](jpa.md)               |  yes  |  yes   | Java entities, `--style jakarta` (default) or `javax`     |
| [Graphene](graphene.md)                 |  no   |  yes   | graphene-django GraphQL schema                            |
| [TypeScript](typescript.md)             |  no   |  yes   | Plain interfaces and enums                                |
| [Zod](zod.md)                           |  no   |  yes   | Zod 4 schemas                                             |

Only Django (`.py`), Prisma (`.prisma`) and SQL (`.sql`) claim a file extension, so pass `--from` or `--to` for every other format.
