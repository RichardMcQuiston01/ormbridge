# SQLAlchemy and SQLModel

The `sqlalchemy` format covers Python models written with SQLAlchemy 2.0 (declarative `Mapped[...]` and `mapped_column`, the classic `Column(...)` style, and `Table(...)` objects) and with SQLModel. ormbridge both reads and writes it (`read + write`). It claims no extension, because `.py` belongs to Django: always pass `--from sqlalchemy` or `--to sqlalchemy` (a config file can set `from` and `to`). `--style sqlmodel` writes SQLModel classes instead of plain SQLAlchemy.

## Try it

The example project is [`examples/sqlalchemy`](../../examples/sqlalchemy/). Its config has two conversions:

```sh
cd examples/sqlalchemy
npx ormbridge convert           # runs both conversions below
npx ormbridge convert --check   # exits with code 3 if a generated file is missing or differs
```

| Conversion        | Input                     | Output                 |
| ----------------- | ------------------------- | ---------------------- |
| `to-sqlalchemy`   | `../schema/schema.prisma` | `models/models.py`     |
| `from-sqlalchemy` | `models/`                 | `prisma/schema.prisma` |

Inside this repository, run `npm run build` once and use `node ../../dist/cli.js convert` instead. Without the config file, including the SQLModel flavour:

```sh
npx ormbridge convert -i ../schema/schema.prisma --to sqlalchemy -o models/models.py
npx ormbridge convert -i ../schema/schema.prisma --to sqlalchemy --style sqlmodel -o models/sqlmodel_models.py
npx ormbridge convert -i models --from sqlalchemy --to prisma -o prisma/schema.prisma
```

The example run prints one warning: `Post.metadata: "metadata" would shadow a name the class needs; the attribute was written as metadata_.`

## Reading

The Python is parsed statically with a tree-sitter grammar. Nothing is imported or run, so no Python, SQLAlchemy or database is needed. The input is a file or a directory of `.py` files; virtual environments, `site-packages`, `migrations`, `alembic`, `__pycache__`, tool caches and files such as `test_*.py`, `*_test.py`, `conftest.py` and `setup.py` are skipped. A file over 2 million characters is skipped and a table keeps its first 2000 columns.

What is understood:

- **Models:** classes with `__tablename__` on `DeclarativeBase`, `declarative_base()`, `db.Model` or any imported base; SQLModel classes with `table=True`; `Table(...)` objects that are not association tables (a warning says which model name was used).
- **Columns:** `Mapped[T]`, `mapped_column`, `Column`, SQLModel `Field`; nullability from `Optional[T]`, `T | None` or `nullable=`; the usual types (`Integer`, `String(n)`, `Text`, `Numeric(p, s)`, `DateTime`, `Uuid`, `JSON`, `LargeBinary`, ...), bare Python types, `Annotated` aliases and `type_annotation_map`; `ARRAY`, `INET`, `HSTORE` and range types. Other types are kept as `unsupported` columns with a warning.
- **Enums:** `Enum(PyEnum)`, `Mapped[PyEnum]`, `Enum("a", "b", name=...)` and `Literal[...]`. As in SQLAlchemy, member names are stored unless `values_callable` is given.
- **Keys and defaults:** `primary_key`, `PrimaryKeyConstraint`, `autoincrement`, `Identity`, `default`, `server_default`, `onupdate`, `Computed`.
- **Relations:** `ForeignKey(..., ondelete=, onupdate=)`, `ForeignKeyConstraint`, `relationship(back_populates=, backref=, foreign_keys=, remote_side=, uselist=False, secondary=)`, SQLModel `Relationship` and `link_model`. A unique foreign key is one-to-one; `secondary=` becomes a many-to-many.
- **Indexes:** `Index(...)`, `index=True`, `unique=True`, `UniqueConstraint`, `postgresql_using`.
- **Structure:** mixins, `__abstract__` bases and joined-table inheritance. `schema=` is kept.

## Writing

One `models.py` file, so `-o` is a file and omitting it prints to stdout. It needs Python 3.9 or newer and SQLAlchemy 2.0 or newer (SQLModel 0.0.21 or newer for `--style sqlmodel`).

- **`--style sqlalchemy`** (default, config key `style`): `class Base(DeclarativeBase)`, one class per model with `__tablename__`, typed `Mapped[...]` attributes built with `mapped_column`, and `relationship(back_populates=...)` on both sides of every relation. Enums are Python `enum.Enum` classes bound with `Enum(Cls, name=..., values_callable=...)`, so the database stores the values.
- **`--style sqlmodel`**: `class Post(SQLModel, table=True)` with `Field(...)` and `Relationship(...)`. Types SQLModel infers are left to it; `max_length`, `max_digits` and `decimal_places` carry lengths and precision; `sa_type` and `sa_column_kwargs` appear only where needed.
- **Keys:** composite keys use `PrimaryKeyConstraint`, composite foreign keys `ForeignKeyConstraint`; `ForeignKey(..., ondelete=...)` carries referential actions; unique and index entries go in `__table_args__`.
- **Many-to-many** is a `Table(...)` with two foreign keys as a composite primary key, used as `secondary=` on both sides (no surrogate `id`).
- **Naming:** attributes are snake_case in both modes. `--naming preserve` (default) keeps table, column, index and enum type names; `--naming normalize` writes singular snake_case tables, UUID keys and `created_at`/`updated_at`. Attributes that would shadow Python or SQLAlchemy names get a trailing underscore, with a warning.

`--provider` is ignored: the models do not depend on the database. `--style` with any other value fails with `Invalid --style value "bogus". Expected one of: sqlalchemy, sqlmodel.`

## Limitations and warnings

- **PostgreSQL-only types.** Arrays, `HSTORE`, ranges and `INET` are written with a `.with_variant(JSON(), "sqlite")` fallback and a warning: `Thing.tags: array, HSTORE, range and IP address columns are PostgreSQL types; they fall back to JSON (or a string) on SQLite.`
- **Dropped on write,** each with a warning: client-side defaults (`cuid()`, `ulid()`), database schemas (`@@schema`), generated-column expressions, index methods, operator classes, sort order, full-text kinds. `SET NULL` on a required relation is written as `RESTRICT`. Views are a commented placeholder.
- **Not read,** each with a warning naming the model and column: `CheckConstraint`, `ExcludeConstraint`, partial and expression indexes (`A.__table_args__: the index "ix" on an expression or on a column that does not exist was ignored.`), single-table inheritance, `column_property`, `composite`, `synonym`, reflected tables and unrecognised default calls. Hybrid properties, `association_proxy`, cascade options and SQLModel's pydantic constraints are dropped without a warning.
- **Missing targets.** A foreign key to a table not in the input gets a stub model: `A.o references "Other", which is not a table in the input. A stub model with an auto-increment id was generated; replace it with the real definition.`
- **Names of both sides.** Both sides of a relation are written, so an unnamed reverse side gets the plural of the model (`posts`); the reader keeps whatever the code says. The association table's name and `ondelete` are not read back.

See the conversion matrix: [why information is lost](../CONVERSION_MATRIX.md#why-information-is-lost) (items 12 and 13 concern SQLAlchemy), [prisma to sqlalchemy](../CONVERSION_MATRIX.md#prisma--sqlalchemy) and [sqlalchemy to prisma](../CONVERSION_MATRIX.md#sqlalchemy--prisma).

## Programmatic API

```ts
import {
  convertText,
  emitSqlAlchemy,
  parseSqlAlchemy,
  type ConvertResult,
  type IrSchema,
  type Result,
} from 'ormbridge';

declare const pythonText: string;

const converted: Result<ConvertResult> = await convertText(
  [{ path: 'models.py', text: pythonText }],
  {
    from: 'sqlalchemy',
    to: 'prisma',
    naming: 'preserve',
    provider: 'postgresql',
    header: true,
    autoField: 'int',
  }
);
if (!converted.ok) {
  console.error(`${converted.error.code}: ${converted.error.message}`);
}

// The parser is async (it loads a grammar); the emitter returns { text, warnings }.
const parsed: Result<IrSchema> = await parseSqlAlchemy(
  [{ path: 'models.py', text: pythonText }],
  { appLabel: 'app' }
);
if (parsed.ok) {
  const { text, warnings } = emitSqlAlchemy(parsed.value, {
    naming: 'preserve',
    style: 'sqlmodel',
  });
}
```
