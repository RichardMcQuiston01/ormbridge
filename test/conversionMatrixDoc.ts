import { fileURLToPath } from 'node:url';
import type { IrField, IrModel, IrSchema } from '../src/ir.js';
import type { EmitOnlyCell, MatrixCell } from './conversionMatrix.js';
import { formatDifference, type IrDifference } from './irCompare.js';

/** Where the generated document is committed. */
export const MATRIX_DOC_PATH: string = fileURLToPath(
  new URL('../docs/CONVERSION_MATRIX.md', import.meta.url)
);

/**
 * Reasons a conversion loses information. Every difference the matrix finds
 * must be explained by one of these; the matrix test fails otherwise, so a new
 * loss cannot slip in without being documented.
 */
export interface LossReason {
  id: string;
  title: string;
  explanation: string;
}

export const LOSS_REASONS: readonly LossReason[] = [
  {
    id: 'enum-length',
    title: 'Enum column length',
    explanation:
      'Django stores an enum-backed field as `CharField(max_length=N, choices=...)`, so the IR keeps `N`. A Prisma `enum` and a TypeORM `enum` column have no length, so it is dropped when writing them. Writing the enum back to Django invents a new length (the longest member value, but at least 32: `src/emitters/django.ts`), which is why the original 20 does not return.',
  },
  {
    id: 'enum-label',
    title: 'Enum member labels',
    explanation:
      'Django `TextChoices` members carry a human-readable label (`DRAFT = "draft", "Draft"`). Prisma enum members and TypeORM string-enum members have no label, so it is dropped. Django output derives a label from the member name, so the label may look the same but was not preserved.',
  },
  {
    id: 'join-table',
    title: 'Many-to-many becomes an explicit join model in Prisma',
    explanation:
      "In `preserve` naming mode the Prisma writer expands every many-to-many field with `expandManyToMany` (`src/transforms.ts`) into an explicit join model (`PostTags`) with a surrogate `id`, two cascading foreign keys and a unique pair. This mirrors the table Django creates, so existing Django databases stay compatible, and it avoids Prisma's implicit `_AToB` table. Prisma reads that model back as an ordinary model, so the relation `Post.tags` is not restored as a many-to-many. For TypeORM and GORM sources the join table is the ORM's own, whose primary key is the composite of the two foreign keys, so the Prisma join model also gains a surrogate `id` column that the source table does not have.",
  },
  {
    id: 'php-empty-array-default',
    title: 'Empty JSON defaults come back as a PHP array',
    explanation:
      'The Doctrine writer sets a JSON or array default as a property initializer (`private array $metadata = [];`). PHP has a single empty array literal, so an empty JSON object default (`{}`, Django `default=dict`) and an empty JSON list default (`[]`) both become `[]`, and the Doctrine reader returns `[]`.',
  },
  {
    id: 'gorm-empty-string-default',
    title: 'GORM cannot keep an empty string default',
    explanation:
      "The GORM writer puts a string default into the tag unquoted (`default:abc`), so an empty string default becomes a bare `default:`. GORM and the GORM reader treat that as no default, so a Doctrine property initializer such as `private string $body = '';` is lost on the way through GORM.",
  },
  {
    id: 'gorm-reverse-name',
    title: 'GORM names reverse relations in Go',
    explanation:
      'GORM has no related name: the reverse side of a relation is a field on the other struct, named after the plural of the model (`Posts`). A Django `related_name` or an ORM-specific default such as `postset` is therefore replaced by the GORM field name, and the GORM reader recovers that name rather than the original.',
  },
  {
    id: 'gorm-auto-timestamps',
    title: 'GORM refreshes `updated_at` columns itself',
    explanation:
      'A column named `updated_at` (or `UpdatedAt`) is maintained by GORM through `autoUpdateTime`, which the GORM writer adds and the reader reports as "updated automatically". A source format that cannot express the flag therefore gains it after a pass through GORM.',
  },
  {
    id: 'drizzle-join-tables',
    title: 'Many-to-many becomes an explicit join table in Drizzle',
    explanation:
      'Drizzle has no many-to-many field: a join table is an ordinary table with two foreign keys, and `relations()` describes each side of the pair. The Drizzle writer therefore writes an explicit join table (`PostTag`, named after the two models in the singular) in both naming modes, and the Drizzle reader reads it back as an ordinary model, the way the Prisma reader does, so the relation `Post.tags` is not restored as a many-to-many. A Prisma source that already has an explicit join model under another name (`PostTags`) is replaced by the one the writer derives.',
  },
  {
    id: 'drizzle-reverse-name',
    title: 'Drizzle names reverse relations in `relations()`',
    explanation:
      'Drizzle has no related name: each side of a relation is a key in `relations()`, named after the plural of the model (`posts`). A Django `related_name` or an ORM-specific default such as `postset` is therefore replaced by the Drizzle key, and the Drizzle reader recovers that name rather than the original.',
  },
  {
    id: 'json-schema-defaults',
    title:
      'JSON Schema describes defaults and nullability of values, not columns',
    explanation:
      'A property that has a default or is `readOnly` is not required, and the reader reads such a property back as non-nullable with the generated hint it can infer: a database default that is only a stored string (an empty JSON object) is not written, `now` defaults and auto-updated hints are inferred from `readOnly` and the property name, and a `json` column has no nullability of its own, so a required `json` column comes back nullable.',
  },
  {
    id: 'json-schema-join-tables',
    title: 'Many-to-many becomes an array property in JSON Schema',
    explanation:
      'A many-to-many relation is written as an array of references on each side and is read back as a many-to-many field on the model defined first, with a join table named after the two models rather than the source table. An explicit join model (Prisma) is a model with two single references; it is read back as an ordinary model and keeps its composite key through `x-primary-key`.',
  },
  {
    id: 'sqlalchemy-reverse-name',
    title: 'SQLAlchemy names both sides of a relationship',
    explanation:
      'A relationship is written on both classes with `back_populates`, so the reverse side always has a name. Where the source never named it (Django `post_set`, a Laravel or Doctrine inverse side that is not declared) the writer uses the plural of the model name (`posts`), and the reader keeps whatever the code says.',
  },
  {
    id: 'sqlalchemy-many-to-many',
    title: 'The side of a many-to-many that is written first can swap',
    explanation:
      'A many-to-many is written as an association `Table(...)` with `secondary=` on both classes. The reader keeps the two relationship names but not the name or the `ondelete` of the association table, and when both sides of the pair carry the same information it may read the pair with the other class as the owner.',
  },
  {
    id: 'sql-reverse-name',
    title: 'SQL stores no reverse accessor names',
    explanation:
      'A foreign key is a column, not a relation field, so the SQL reader names the reverse side after the table that holds the key (`blog_posts`, prefixed with the relation name when a table has two keys to the same target) and does not recover the `related_name` the source had.',
  },
  {
    id: 'sql-auto-timestamps',
    title: 'SQL cannot mark a column as refreshed on every save',
    explanation:
      'Only MySQL has `ON UPDATE CURRENT_TIMESTAMP`. The other dialects need a trigger, which is not written, so an auto-updated timestamp (`auto_now`, `@updatedAt`, `autoUpdateTime`) comes back as an ordinary timestamp with a default.',
  },
  {
    id: 'sql-unique-index',
    title: 'A unique index is not a unique column in SQL',
    explanation:
      'The SQL reader turns `UNIQUE (column)` constraints and column-level `UNIQUE` into a unique column, and keeps `CREATE UNIQUE INDEX` as an index, because the two are different objects in the database. A format that writes a single-column unique index (GORM `uniqueIndex`, a Laravel `unique()` migration call) therefore comes back as an index instead of a unique column, and the other way round.',
  },
  {
    id: 'sql-join-tables',
    title: 'Join tables and many-to-many fields in SQL',
    explanation:
      'A many-to-many field is written as a join table. The SQL reader turns a table of exactly two foreign-key columns that form its composite primary key, and nothing else, back into a many-to-many field and drops the table; any other join table (one with its own key or extra columns, as Django and Prisma write them) stays an explicit model, and a many-to-many field comes back as a model. The join table name and any `ON DELETE` action other than `CASCADE` are not kept.',
  },
  {
    id: 'django-enum-length-floor',
    title: 'Django enum columns are at least 32 characters',
    explanation:
      'The Django writer ignores the stored length of an enum-backed field and writes `max_length` as the longer of 32 and the longest enum value (`src/emitters/django.ts`). A length kept by another format (for example 20 in a Doctrine `length: 20` column) therefore becomes 32 once the schema passes through Django, which is why a second trip through Django is not stable for that field.',
  },
  {
    id: 'laravel-big-integer-keys',
    title: 'Laravel keys are big integers',
    explanation:
      'The Laravel writer spells an auto-increment key as `$table->id()`, which is an unsigned big integer, and writes the foreign keys that point at it as `foreignId()`. An `int` key therefore comes back as `bigInt` when the migrations are read again. Reading Laravel migrations written with `increments()` (the canonical Laravel fixture does) keeps `int`, so this only appears when the schema passes through the Laravel writer.',
  },
  {
    id: 'laravel-timestamps',
    title: 'Laravel timestamps are nullable and maintained by Eloquent',
    explanation:
      'The Laravel writer uses `$table->timestamps()` for `created_at` / `updated_at`, which creates nullable columns without a database default, because Eloquent fills them in. The Laravel reader reports them as nullable, treats `updated_at` of a model with `$timestamps` as auto-updated and `created_at` as defaulting to now. A source that has these columns as required, with a different default or without the auto-update flag (Doctrine keeps the default and sets the value in a lifecycle callback), therefore changes when it passes through Laravel; TypeORM only treats a column as `@UpdateDateColumn` while it is required, so the flag is lost on the way back from there.',
  },
  {
    id: 'laravel-reverse-name',
    title: 'Laravel names unnamed reverse relations in the plural',
    explanation:
      'A Django foreign key without `related_name` has the implicit reverse accessor `<model>_set`, which the IR records as no name. The Laravel writer needs a method name for the `hasMany` side and uses the plural of the model (`posts`), which the Laravel reader then reports as an explicit reverse name.',
  },
  {
    id: 'sequelize-timestamps',
    title: 'Sequelize fills in timestamps itself',
    explanation:
      "Sequelize adds `createdAt` and `updatedAt` as `NOT NULL` columns with no database default and sets them in JavaScript, so the IR of a Sequelize model records no default for them. The Sequelize writer maps a required `created_at` date-time column onto the `timestamps` option (`createdAt: 'created_at'`), so a `now` default the source had does not come back from Sequelize. The other way round, the GORM writer turns a `created_at` column into `autoCreateTime` and the Laravel writer into `timestamps()`, and both readers report that as a `now` default, so the value Sequelize left to the application comes back as a default.",
  },
  {
    id: 'sequelize-enum-names',
    title: 'Sequelize enums have no name of their own',
    explanation:
      'A Sequelize `ENUM(...)` column carries its values inline, so the Sequelize reader names the enum after the model and the attribute (`PostStatus` for `Post.status`, `BlogPostStatus` for `BlogPost.status`). A source whose enum is called something else (a SQL enum type, a Prisma enum shared by several models) comes back under the derived name.',
  },
];

/**
 * What a write-only target cannot keep or has to approximate. They are listed
 * in the matrix document next to the structural check, because the matrix
 * cannot re-read the output to measure them. Keyed by format name.
 */
export const EMIT_ONLY_NOTES: Readonly<Record<string, readonly LossReason[]>> =
  {
    'json-schema': [
      {
        id: 'json-schema-no-constraints',
        title: 'Database constraints are not validation rules',
        explanation:
          "Unique, primary-key, index and foreign-key constraints, referential actions and table names have no JSON Schema keyword, so they are written as ormbridge's own `x-table-name`, `x-primary-key`, `x-unique`, `x-indexes`, `x-on-delete` and `x-related-name` keywords (other tools ignore them; Ajv in strict mode needs them registered, or `conventions: false`). Index methods, operator classes, sort orders, full-text kinds, `onUpdate` actions and constraint names have no convention and are not written. Column comments do not exist in the IR, so `description` carries only enum labels and generated-column expressions.",
      },
      {
        id: 'json-schema-types',
        title: 'Types follow what travels as JSON',
        explanation:
          '`bigInt` and `decimal` are strings (with a `pattern`, narrowed by the precision when the IR has `maxDigits` and `decimalPlaces`) so no precision is lost, binary columns are base64 strings, `json` accepts any value, and integers carry `minimum` / `maximum` only when a Prisma native type such as `@db.SmallInt` names the width. IP addresses and ranges have no JSON Schema format and are plain strings and `{ lower, upper, bounds }` objects.',
      },
      {
        id: 'json-schema-required',
        title: 'Required and read-only are inferred',
        explanation:
          'A property is `required` when its column is not nullable and has no default and is not generated. Auto-increment, UUID, `now`, client-generated and database-expression defaults, auto-updated columns and generated columns are `readOnly`. Relations and reverse relations are optional properties; the foreign-key scalar is required when the relation is.',
      },
      {
        id: 'json-schema-enums',
        title: 'Enums are string enumerations',
        explanation:
          'An enum is `{ "type": "string", "enum": [...] }` with the stored values; member names and Django labels survive only as the `description` text, because the `enum` keyword has no place for them.',
      },
    ],
    gorm: [
      {
        id: 'gorm-integers',
        title: 'Integer widths and signs',
        explanation:
          '`int` is written as `int32` and `bigInt` as `int64`, both signed. The IR has no unsigned or 16-bit integers (Django positive integer fields become plain `int`). A model that has exactly the `gorm.Model` columns embeds `gorm.Model`, whose `ID` is an unsigned `uint`.',
      },
      {
        id: 'gorm-defaults',
        title: 'Where defaults live',
        explanation:
          'A `now` default on a date-time column becomes `autoCreateTime` (GORM fills it in Go, so a raw SQL insert gets no default) and an auto-updated column becomes `autoUpdateTime`. UUID defaults are `default:gen_random_uuid()` on PostgreSQL and a generated `BeforeCreate` hook on every other provider; client-generated defaults (`cuid()`, `ulid()`) are dropped with a warning. Literal and enum defaults are written as `default:` tags.',
      },
      {
        id: 'gorm-join-tables',
        title: 'Many-to-many join tables',
        explanation:
          'GORM creates the join table itself, with a composite primary key of the two foreign keys and no surrogate `id`. The table and column names are written explicitly (`many2many:`, `joinForeignKey`, `joinReferences`) when they differ from what GORM would pick, so the table matches the one other formats create. An explicit join model (Prisma) stays an ordinary model.',
      },
      {
        id: 'gorm-soft-delete',
        title: 'Soft delete is inferred from a column name',
        explanation:
          'The IR has no soft-delete flag. A nullable date-time column named `deleted_at` is written as `gorm.DeletedAt`, which also changes how GORM queries the model (rows with a value are hidden), so the writer warns.',
      },
      {
        id: 'gorm-enums',
        title: 'Enums are Go constants',
        explanation:
          'An enum is a typed string with a `const` block, stored as text. GORM has no database enum type and no check constraint is written, so the database does not enforce the values. Member labels are kept as comments.',
      },
      {
        id: 'gorm-unrepresentable',
        title: 'Constructs without a GORM tag',
        explanation:
          'Arrays and hstore become JSON columns (`datatypes.JSONSlice`, `datatypes.JSON`), durations become `time.Duration` (nanoseconds in a bigint), ranges become strings, generated columns become regular columns, and composite foreign keys, index types and operator classes, full-text indexes, views and `@@schema` are written as plain tables and columns, each with a warning. The IR has no check constraints, column comments or polymorphic relations, so none are written.',
      },
      {
        id: 'gorm-inverse-names',
        title: 'Reverse relations get Go names',
        explanation:
          'An unnamed reverse relation is named after the plural of the model (`Posts`), and a one-to-one after the model (`Profile`). Has-one and belongs-to fields are pointers unless a required parent can be held by value without making the struct type recursive.',
      },
    ],
    drizzle: [
      {
        id: 'drizzle-dialects',
        title: 'One dialect per output',
        explanation:
          "`--provider` picks `pg-core` (PostgreSQL, CockroachDB), `mysql-core` or `sqlite-core`. Drizzle has no SQL Server or MongoDB dialect, so those providers are written as PostgreSQL tables with a warning. The column builders follow the dialect: `timestamp({ withTimezone: true })` and `jsonb` on PostgreSQL, `datetime` and `json` on MySQL, and on SQLite `integer({ mode: 'timestamp' })`, `integer({ mode: 'boolean' })` and `text({ mode: 'json' })`.",
      },
      {
        id: 'drizzle-keys',
        title: 'Auto-increment keys and integer widths',
        explanation:
          'An auto-increment `int` key is `serial` (PostgreSQL), `int().autoincrement()` (MySQL) or `integer().primaryKey({ autoIncrement: true })` (SQLite); `bigInt` is `bigserial` or `bigint` in `number` mode, which loses precision above 2^53. SQLite integers are always 64 bits wide. A UUID key is `uuid().defaultRandom()`, `char(36)` with a `(UUID())` default or text.',
      },
      {
        id: 'drizzle-defaults',
        title: 'Where defaults live',
        explanation:
          'A `now` default is `.defaultNow()` (PostgreSQL), `CURRENT_TIMESTAMP` (MySQL) or `(unixepoch())` (SQLite), all evaluated by the database. Drizzle has no database default for a UUID on SQLite, so the writer uses `$defaultFn(() => crypto.randomUUID())`, which only runs for rows inserted through Drizzle, and warns. An auto-updated column gets `$onUpdate(() => new Date())`, which Drizzle applies in the client, not with a database trigger. Client-generated defaults (`cuid()`, `ulid()`) and database expressions are dropped with a warning.',
      },
      {
        id: 'drizzle-join-tables',
        title: 'Many-to-many join tables are explicit tables',
        explanation:
          'Drizzle has no many-to-many field. The writer expands every many-to-many relation into the join table Django creates (a surrogate `id`, two cascading foreign keys and a unique pair), in `preserve` and `normalize` naming alike, and both tables get a `many()` relation to it. The relation is therefore a one-to-many pair, not a many-to-many, when read back.',
      },
      {
        id: 'drizzle-enums',
        title: 'Enums by dialect',
        explanation:
          'PostgreSQL gets a `pgEnum` (a real database type). MySQL gets an inline `mysqlEnum` column. SQLite has no enum type, so the column is `text` with `{ enum: [...] }`, which narrows the TypeScript type but adds no check constraint. Every enum also exports its values as an `as const` array and a union type.',
      },
      {
        id: 'drizzle-unrepresentable',
        title: 'Constructs without a Drizzle builder',
        explanation:
          'Arrays, hstore and ranges outside PostgreSQL become JSON, text or varchar columns and durations become integers (microseconds), each with a warning. PostgreSQL columns without a builder (`bytea`, `hstore`, ranges) use small `customType` declarations at the top of the file. Generated columns (Python expressions), composite foreign keys, index types, sort orders and operator classes, full-text indexes, views and `@@schema` are written as plain tables and columns with a warning. Unique indexes are `uniqueIndex`, not unique constraints.',
      },
      {
        id: 'drizzle-relations',
        title: 'Both sides of every relation',
        explanation:
          'Every foreign key gets a `one()` relation on its table and the matching `many()` (or `one()` for a one-to-one) on the target. Two tables joined more than once, and self references, carry a `relationName` on both sides because Drizzle cannot pair them otherwise. An unnamed reverse relation is named after the plural of the model (`posts`). Tables are ordered so a table follows the tables it references; a reference to a table declared later (a cycle or a self reference) is annotated with `AnyPgColumn` (`AnyMySqlColumn`, `AnySQLiteColumn`).',
      },
    ],
    zod: [
      {
        id: 'zod-wire-types',
        title: 'Types that JSON cannot carry',
        explanation:
          'Big integers and decimals are validated as strings of digits (a decimal with `max_digits` and `decimal_places` gets a pattern sized to them), UUIDs with `z.uuid()` (which only accepts RFC 9562 versions and variants), binary data as base64 text, durations and times as plain strings, and JSON columns as `z.unknown()`. Date columns use `z.coerce.date()`, which also accepts `null` and numbers, so a null in a required date column is not rejected; the `dates: "string"` option validates ISO text strictly instead.',
      },
      {
        id: 'zod-create-update',
        title: 'Create and update schemas are inferred',
        explanation:
          'The IR has no notion of an API payload. `<Model>CreateSchema` leaves out auto-increment keys, generated columns and auto-updated timestamps, and makes columns with a default (or a database default) and nullable columns optional. `<Model>UpdateSchema` is the create schema made partial, so it cannot change a generated column. Views get neither.',
      },
      {
        id: 'zod-relations',
        title: 'Relations are a separate schema',
        explanation:
          'Relation fields are not part of `<Model>Schema`; the foreign-key scalar is. A model that takes part in a relation also gets `<Model>WithRelationsSchema`, where every related row is optional and resolved lazily. Referential actions (`onDelete`), `related_name` collisions and composite foreign keys are not validation rules, so they are dropped (a composite key stays as its scalar columns).',
      },
      {
        id: 'zod-database-rules',
        title: 'Database-only rules are not checked',
        explanation:
          'Unique constraints, indexes, check constraints, string lengths below the database limit, integer ranges, enum value order and column names are not validated or kept; only string `max_length`, enum membership, nullability and the types above are. Enum labels are kept as comments. Ranges become an object with `lower`, `upper` and `bounds`, and hstore a record of nullable strings.',
      },
    ],
    sql: [
      {
        id: 'sql-dialect-types',
        title: 'Types are chosen per dialect',
        explanation:
          'The matrix writes PostgreSQL (`--provider` picks MySQL, SQLite or SQL Server). `uuid` is `UUID` on PostgreSQL, `CHAR(36)` on MySQL and SQLite and `UNIQUEIDENTIFIER` on SQL Server; `json` is `JSONB`, `JSON`, `TEXT` with a `json_valid` check, or `NVARCHAR(MAX)` with an `ISJSON` check; booleans, timestamps, `bytes` and `float` follow the same pattern. A Prisma native type (`@db.VarChar`, `@db.Uuid`, ...) is kept when the dialect has a type of that name. A duration is an `INTERVAL` only on PostgreSQL (an integer of microseconds elsewhere), and arrays, hstore and ranges exist only there too (JSON or text elsewhere, with a warning).',
      },
      {
        id: 'sql-defaults',
        title: 'Defaults are database expressions',
        explanation:
          'A `now` default is `now()`, `CURRENT_TIMESTAMP`, `CURRENT_TIMESTAMP(6)` or `SYSUTCDATETIME()`, a UUID default is `gen_random_uuid()`, `(UUID())`, `NEWID()` or an expression over `randomblob` on SQLite, and an auto-increment key is `GENERATED BY DEFAULT AS IDENTITY`, `AUTO_INCREMENT`, `AUTOINCREMENT` or `IDENTITY(1,1)`. Defaults that are computed by the ORM client (`cuid()`, `ulid()`) are dropped with a warning, and a database expression is written as it is. A column the ORM refreshes on update (`auto_now`, `@updatedAt`) is `ON UPDATE CURRENT_TIMESTAMP(6)` on MySQL only; the other dialects need a trigger, which is not generated.',
      },
      {
        id: 'sql-enums',
        title: 'Enums depend on the dialect',
        explanation:
          'PostgreSQL gets a `CREATE TYPE ... AS ENUM`, MySQL an inline `ENUM(...)` and SQLite and SQL Server a `CHECK (column IN (...))` constraint on a text column. Member names and labels are not kept, only the stored values.',
      },
      {
        id: 'sql-lossy',
        title: 'What the DDL cannot say',
        explanation:
          'Views are a commented placeholder (the IR has no query), generated-column expressions are not SQL and the column is written as a regular one, database schemas (`@@schema`) are ignored, Prisma full-text indexes are a `FULLTEXT` index on MySQL and a `gin` index on PostgreSQL (an ordinary index elsewhere), and SQL Server downgrades a cascading action that would form a cycle or a second cascade path to `NO ACTION`. Relations, the reverse side of a relation and `related_name` are not part of DDL: only the foreign key remains.',
      },
    ],
    sqlalchemy: [
      {
        id: 'sqlalchemy-styles',
        title: 'Two flavours, one module',
        explanation:
          'The matrix writes the default `sqlalchemy` style: one `models.py` with a `Base(DeclarativeBase)`, typed `Mapped[...]` attributes built with `mapped_column`, and `relationship(back_populates=...)` on both sides of every relation. `--style sqlmodel` writes `SQLModel, table=True` classes with `Field(...)` and `Relationship(...)` instead (`sa_type`, `sa_column_kwargs`, `sa_column` and `sa_relationship_kwargs` only where `Field` and `Relationship` cannot say it). `--provider` is ignored: the output does not depend on the database.',
      },
      {
        id: 'sqlalchemy-names',
        title: 'Python attributes are snake_case',
        explanation:
          'Attribute names are snake_case in both naming modes, and the database column name is passed as the first argument of `mapped_column` whenever it differs. Names that would shadow something the class body needs (`class`, `metadata`, `text`, `datetime`, an enum or model name) get a trailing underscore, and a class name that collides with an imported name gets a `Model` suffix; each repair is a warning. An unnamed reverse relation is named after the plural of the model (`posts`), a one-to-one after the model.',
      },
      {
        id: 'sqlalchemy-defaults',
        title: 'Defaults live in the database where they can',
        explanation:
          'Literal, enum, boolean and `now` defaults are `server_default` (`func.now()`, `func.current_date()`, `true()`, `text(...)`), so a raw SQL insert gets them too. UUID defaults are `default=uuid.uuid4` (Python, no portable database function), an auto-updated column is `default=func.now(), onupdate=func.now()`, and a Prisma `dbgenerated(...)` expression is `server_default=text(...)`. Client-generated defaults (`cuid()`, `ulid()`) and Prisma default functions are dropped with a warning, and a UUID version 7 default is written as `uuid.uuid4`.',
      },
      {
        id: 'sqlalchemy-many-to-many',
        title: 'Many-to-many is an association table',
        explanation:
          'Every many-to-many relation is a `Table(...)` with the two foreign keys as a composite primary key (no surrogate `id`, unlike the table Django creates), referenced by `secondary=` on both relationships. A self-referential relation gets `primaryjoin` / `secondaryjoin`. The table is named `<owner table>_<relation>` and the columns `<model>_id` (`from_<model>_id` and `to_<model>_id` for a self reference).',
      },
      {
        id: 'sqlalchemy-keys',
        title: 'Keys, constraints and referential actions',
        explanation:
          'Composite primary keys and named primary keys are a `PrimaryKeyConstraint`, composite foreign keys a `ForeignKeyConstraint`, unique and index entries `UniqueConstraint` and `Index` in `__table_args__`; `ON DELETE` and `ON UPDATE` are written on every `ForeignKey`. A `SET NULL` action on a column that cannot be null is written as `RESTRICT` with a warning. The reverse side of a cascading or nulling key sets `passive_deletes=True`, so the ORM leaves the action to the database. A table without a primary key is mapped on its required columns with `__mapper_args__` (SQLModel needs one: the first column is marked as the key) and a warning.',
      },
      {
        id: 'sqlalchemy-enums',
        title: 'Enums are Python enum classes',
        explanation:
          'An enum is an `enum.Enum` class whose values are the stored values, bound with `Enum(Cls, name=..., values_callable=...)` so the database stores the values, not the member names. PostgreSQL gets a native enum type, other databases a `VARCHAR`. Member names that are not Python identifiers are repaired with a warning; labels are not kept.',
      },
      {
        id: 'sqlalchemy-postgres-types',
        title: 'PostgreSQL types fall back to JSON on SQLite',
        explanation:
          'Arrays (`ARRAY`, `dimensions=` for nested arrays), `HSTORE`, range types and `INET` are PostgreSQL types; each is written with `.with_variant(JSON(), "sqlite")` (a 45-character string for `INET`) so `create_all` also works in a SQLite test database, and the model gets a warning. Other databases are not covered. Durations are `Interval`, booleans `Boolean`, timestamps `DateTime(timezone=True)`, UUIDs the generic `Uuid`. A `bigInt` auto-increment key is `BigInteger().with_variant(Integer, "sqlite")` so SQLite counts it up.',
      },
      {
        id: 'sqlalchemy-unrepresentable',
        title: 'Constructs without a SQLAlchemy equivalent',
        explanation:
          'Views are a commented placeholder with a warning (SQLAlchemy has no declarative view; reflect it with `Table(..., autoload_with=engine)`), database schemas (`@@schema`) are ignored, generated-column expressions are not SQL and the column is written as a regular one, index methods, operator classes, sort order and full-text kinds are dropped (an ordinary index is written), and relations to a view or a model that is not in the input stay plain columns.',
      },
    ],
  };

/**
 * What a format that can only be read cannot express, or has to guess, when it is read. The matrix
 * compares IRs, so these losses (which happen before the IR exists) never show up as differences;
 * they are listed in the matrix document next to the read-only rows instead. Keyed by format name.
 */
export const READ_ONLY_NOTES: Readonly<Record<string, readonly LossReason[]>> =
  {
    'json-schema': [
      {
        id: 'json-schema-annotations',
        title: 'Descriptions and validation keywords',
        explanation:
          'The IR has no comment slot, so `description`, `title` and `examples` are dropped. Validation keywords with no column meaning (`minimum`, `maximum`, `minLength`, `pattern`, `minItems`, `uniqueItems`, `writeOnly`, `deprecated`, `format` values such as `email` or `uri`) are not stored either; only `maxLength` becomes a column length.',
      },
      {
        id: 'json-schema-no-database-meaning',
        title: 'Constructs without a database meaning',
        explanation:
          '`oneOf` / `anyOf` unions (other than "a schema or null" and a list of constants, which are read as a nullable property and an enum), `patternProperties`, maps (`additionalProperties` with a schema), `if` / `then` / `else`, tuple arrays and a union of `type`s are reported as warnings. A property that uses one becomes a `json` column; a model-level one is ignored. A nested inline object is also a `json` column, and a `oneOf` of models is not a model.',
      },
      {
        id: 'json-schema-inheritance',
        title: 'Inheritance is flattened',
        explanation:
          'A model built with `allOf` (or a `$ref` next to `properties`) gets copies of the properties of every parent, with a warning. The IR has no inheritance, so the parent link is lost; the parent stays a model of its own when it is an object schema with properties.',
      },
      {
        id: 'json-schema-relations',
        title: 'Relations are inferred from `$ref` properties',
        explanation:
          'JSON Schema has no foreign keys. A property that references another model is a foreign key (required means not null, `x-on-delete` sets the action and `x-related-name` names the reverse side); an array of models on one model and a reference back on the other is one relation seen from both sides; arrays on both sides are a many-to-many; two single references that point at each other are a one-to-one (the required side holds the key, with a warning when that is a guess). An array with no counterpart gets a nullable foreign key added to the other model, with a warning. A foreign key column keeps its name (`<relation>_id`) unless a scalar property such as `authorId` is declared next to the relation.',
      },
      {
        id: 'json-schema-types',
        title: 'Column types are guessed from `type` and `format`',
        explanation:
          'A string without `maxLength` and without a `format` is `text`; with `maxLength` it is a length-limited `string`. Integers are `int` unless `format` is `int64`; numbers are `float` unless `format` is `decimal` (precision and scale come from `x-precision` / `x-scale` or `multipleOf`). A column type the IR has no name for (unsigned, 16-bit, native database types) cannot be stated. Only string enums become enums; the other enums keep their plain type with a warning.',
      },
      {
        id: 'json-schema-keys',
        title: 'Keys, generated values and names',
        explanation:
          'The primary key is the `x-primary-key` property (several make a composite key), else `id`, else `<model>Id`; a model with none gets an integer `id` and a warning. `readOnly` marks a value the database generates: an integer key counts up, a uuid is generated, a date-time is set on insert (or on every save when the name starts with `updated`). A date-time `default` of `now` or `CURRENT_TIMESTAMP` is the current time. Table names are the model names unless `x-table-name` says otherwise.',
      },
      {
        id: 'json-schema-input',
        title: 'Input limits',
        explanation:
          'Only JSON is read (the package has no YAML parser, so a YAML OpenAPI document must be converted first). References are followed between the files that are given: `#/...` pointers, `#`, and `$id`- or path-relative references; remote references are never fetched and named anchors (`$anchor`, `$dynamicRef`) are not resolved. An unresolved reference keeps its property as a `json` column.',
      },
    ],
    sqlalchemy: [
      {
        id: 'sqlalchemy-static',
        title: 'The models are read, not run',
        explanation:
          'The reader parses the Python source with tree-sitter and never imports it, so only what is written literally is understood: string table and column names, literal arguments, `Mapped[...]` annotations, `Annotated[...]` aliases and a literal `type_annotation_map`. A name computed at import time, a model built in a loop or function, `__table_args__` produced by a `@declared_attr`, and any other `@declared_attr` member are skipped with a warning (a `@declared_attr` `__tablename__` that returns the class name is the one exception).',
      },
      {
        id: 'sqlalchemy-constraints',
        title: 'Constraints and indexes with no model equivalent',
        explanation:
          '`CheckConstraint`, `ExcludeConstraint`, partial indexes (a `*_where` argument), expression indexes (`func.lower(...)`, `text(...)`), index operator classes and `INCLUDE` columns, `deferrable` / `initially`, comments and `info` have no place in the IR and are dropped, each with a warning. Named unique constraints, ordinary and unique indexes (also `Index(...)` written after the class), composite primary and foreign keys, `ondelete` and `onupdate` are kept.',
      },
      {
        id: 'sqlalchemy-defaults',
        title: 'Defaults are reduced to the ones the IR can state',
        explanation:
          'Literals, `func.now()` and `datetime` callables (the current time), `uuid.uuid4`, `dict` / `list` and a `lambda` returning one of those, enum members, `Decimal(...)` and SQL text such as `text("0")`, `text("\'draft\'")` or `text("CURRENT_TIMESTAMP")` are kept; any other expression in `server_default` is kept as a database expression, and any other Python callable in `default` is dropped with a warning. A `server_default` wins over `default` when both are given. `onupdate=func.now()` marks the column as refreshed on every save and drops the redundant `now` default.',
      },
      {
        id: 'sqlalchemy-types',
        title: 'Column types are mapped to the nearest model type',
        explanation:
          '`SmallInteger` and `Integer` are both `int`, `String(n)` and `Unicode(n)` a length-limited `string`, `DateTime(timezone=True)` and `DateTime` the same `dateTime`, `JSON` and `JSONB` the same `json`, and `Float(precision=...)` a plain `float`. A Python type with no column type of its own (`dict`, `list[str]`, a custom class) needs an explicit SQLAlchemy type and otherwise becomes an `unsupported` column with a warning, as do types the IR has no name for (`Geometry`, `TSVECTOR`). A `TypeDecorator` is read through its `impl`.',
      },
      {
        id: 'sqlalchemy-enums',
        title: 'Enums store member names unless told otherwise',
        explanation:
          "SQLAlchemy writes the member names of a Python `Enum` to the database (`DRAFT`), not their values, unless `values_callable=lambda e: [m.value for m in e]` is given; the reader follows the same rule when it fills the stored value of each enum member. `native_enum`, `create_constraint`, `length` and `inherit_schema` are not kept; an explicit `name=` becomes the enum's database name.",
      },
      {
        id: 'sqlalchemy-inheritance',
        title: 'Inheritance',
        explanation:
          'Mixins, abstract bases (`__abstract__ = True`) and plain bases contribute their columns to every subclass. Joined-table inheritance becomes an ordinary model whose primary key is a one-to-one relation to the parent. Single-table inheritance (a subclass with no table of its own) and polymorphic identities are not modelled: the subclass is skipped with a warning.',
      },
      {
        id: 'sqlalchemy-relationships',
        title: 'Relationships are matched through foreign keys',
        explanation:
          "A relationship is not a database object, so the reader works out which side owns the foreign key (from `foreign_keys`, `remote_side`, `primaryjoin` or the only foreign key between the two tables) and attaches the other side as its related name (`back_populates`, `backref`). A reverse side that is a single object (`uselist=False`, or an annotation that is not a list) makes the relation one-to-one; so does a unique foreign key. Loader and cascade options (`lazy`, `cascade`, `order_by`, `passive_deletes`, `viewonly` relationships) are not kept. A many-to-many keeps the two names and drops the association table's own name and `ondelete` (it is re-derived as `<table>_<relation>`); extra columns on the association table are not represented, and an association class with extra columns stays an ordinary model.",
      },
      {
        id: 'sqlalchemy-sqlmodel',
        title: 'SQLModel',
        explanation:
          'A class declared with `table=True` is a model and its table name defaults to the lower-cased class name; classes without it only contribute fields. Pydantic constraints (`ge`, `le`, `min_length`, `regex`, validators) and `alias` / `exclude` settings have no database meaning and are dropped. A field typed `list` or `dict` needs `sa_type` or `sa_column` to name its column type.',
      },
    ],
    sql: [
      {
        id: 'sql-dropped-statements',
        title: 'Statements and clauses with no model equivalent',
        explanation:
          "Only `CREATE TABLE`, `CREATE TYPE ... AS ENUM`, `CREATE INDEX` and `ALTER TABLE` (`ADD COLUMN`, `ADD CONSTRAINT`, `ALTER COLUMN` default and nullability) are read. Views, functions, procedures, triggers, sequences, domains, composite types, row data (`INSERT`, `COPY`), comments (`COMMENT ON`, `COMMENT=`), grants, storage options (`ENGINE=`, `WITH (...)`, tablespaces, partitioning, inheritance) and `CHECK` / `EXCLUDE` constraints have no place in the model and are dropped; each kind is reported once as a warning with a count. A `CHECK` of the form `col IN (...)` or `col = 'a' OR col = 'b'` on a text column is the one exception: it becomes an enum, because SQLite and SQL Server have no enum type.",
      },
      {
        id: 'sql-types',
        title: 'Column types are mapped to the nearest model type',
        explanation:
          'The model keeps no native type, so `timestamptz` and `timestamp`, `jsonb` and `json`, `varchar(n)` and `char(n)` (both a length-limited string), `tinytext` to `longtext`, `smallint` to `bigint` (only `bigint` stays `bigInt`) and the integer display widths and `UNSIGNED` / `ZEROFILL` of MySQL are no longer told apart. A `varchar` without a length and SQL Server `(max)` types are `text`; `tinyint(1)` and `bit` are booleans; SQLite types follow its affinity rules. Types the model has no name for (`geometry`, `tsvector`, `money` outside SQL Server, `rowversion`, composite types) are kept as `unsupported` columns with a warning, and a MySQL `SET` is read as text.',
      },
      {
        id: 'sql-relations',
        title: 'Relation names and reverse accessors are invented',
        explanation:
          'SQL stores a foreign key, not a relation field: the relation is named after the column without its `_id` suffix, and the reverse accessor after the table that holds the key (`blog_posts`, prefixed with the relation name when a table has two keys to the same target). A foreign key whose columns are unique or are the primary key is one-to-one. A table with exactly two foreign-key columns that together are its primary key, and nothing else, is read as a many-to-many relation and the table disappears from the model; its name, and any `ON DELETE` action other than `CASCADE`, are not kept. A foreign key to a table that is not in the input stays an ordinary column.',
      },
      {
        id: 'sql-names',
        title: 'Names',
        explanation:
          'Table names become singular PascalCase model names (`blog_post` is `BlogPost`) and the table name is kept as written. Fields are named after their columns. Constraint and index names are kept only when the DDL names them explicitly; names the database generates are not recorded. A database schema other than `public`, `dbo` or `main` is kept as the model schema; the database qualifier of a MySQL name is dropped.',
      },
      {
        id: 'sql-indexes',
        title: 'Indexes the model cannot express',
        explanation:
          'Expression indexes and partial unique indexes are skipped with a warning, the `WHERE` of a partial index, `INCLUDE` columns and storage parameters are dropped, and a MySQL index over exactly the columns of a foreign key is not kept because MySQL creates one for every key. Index methods other than the default (`USING gin`), operator classes, sort direction, prefix lengths, `FULLTEXT` and SQL Server `CLUSTERED` are kept where the model has a slot for them.',
      },
      {
        id: 'sql-defaults',
        title: 'Defaults',
        explanation:
          'Literal defaults, `now()` / `CURRENT_TIMESTAMP` and its variants, uuid generators (`gen_random_uuid()`, `uuid_generate_v4()`, `NEWID()`, `UUID()`), serial, identity and `AUTO_INCREMENT` columns and enum members are understood; any other default expression is kept as written as a database expression. MySQL `ON UPDATE CURRENT_TIMESTAMP` is the only way a column is marked as refreshed on every save, so `updated_at` columns of the other dialects are not.',
      },
      {
        id: 'sql-dialect',
        title: 'The dialect is guessed',
        explanation:
          'Every file is read as PostgreSQL, MySQL, SQLite or SQL Server, chosen from characteristic syntax (backticks, `AUTO_INCREMENT`, `AUTOINCREMENT`, `IDENTITY(1,1)`, `GO`, `SERIAL`, `::` casts), and as PostgreSQL when nothing decides it. The choice only matters for quoting rules and a few types (`tinyint(1)`, `bit`, `INTEGER PRIMARY KEY` in SQLite is an auto-incrementing key). Programmatic callers can pass `dialect` to `parseSqlDdl`.',
      },
    ],
    sequelize: [
      {
        id: 'sequelize-static',
        title: 'The models are read, not run',
        explanation:
          'The reader parses the JavaScript or TypeScript with tree-sitter and never imports or runs it, so only what is written literally is understood: string model and table names, object literals for attributes and options (also constants and spreads of constants defined in the input), `DataTypes.X(...)` calls and association calls with a model name or `models.X` as the target. Models built in loops or functions, names computed at run time, `Object.keys(models).forEach(...)` loaders and attribute sets returned by helper functions are not seen (the unresolvable ones produce a warning). `sequelize-cli` migrations and seeders are not models and are skipped; replaying migrations is not supported. Sequelize 7 (`@sequelize/core` with `@Attribute` decorators) is not supported.',
      },
      {
        id: 'sequelize-names',
        title: "Default names follow Sequelize's inflection",
        explanation:
          "A model without `tableName` gets Sequelize's plural table name (`PostTag` becomes `PostTags`, `Person` `People`; `underscored` makes it `post_tags`, `freezeTableName` keeps the model name), a foreign key without a name gets `<as>Id` (or `<Model>Id` for `hasMany`), and an association without `as` is named after the model. The reader repeats the rules of the `inflection` package Sequelize 6 uses; `Sequelize.useInflection()` replaces them at run time and cannot be followed. Relation names in the IR are the association aliases with a lower-case first letter.",
      },
      {
        id: 'sequelize-timestamps-read',
        title: 'Timestamps, soft deletes and JavaScript defaults',
        explanation:
          '`timestamps` (on by default) adds `createdAt` and `updatedAt` as non-null `dateTime` columns, the second one marked as refreshed on every save; `paranoid` adds a nullable `deletedAt`, and `createdAt`, `updatedAt`, `deletedAt`, `underscored` and `freezeTableName` are honoured, also from `new Sequelize(..., { define })`. A column the model declares under the same name replaces the generated one, exactly as in Sequelize. `DataTypes.NOW` and `DataTypes.UUIDV4` defaults are generated by Sequelize in JavaScript, not by the database; they are recorded as `now` and `uuid` defaults like the other readers do. Function defaults (`() => ...`, `new Date()`) are dropped with a warning.',
      },
      {
        id: 'sequelize-associations',
        title: 'Associations become foreign keys',
        explanation:
          "Sequelize adds the key columns when `associate` runs, so the reader applies the associations in order: `belongsTo`, `hasOne` and `hasMany` add or complete the foreign key column (existing definitions win, as with Sequelize's `mergeDefaults`), with Sequelize's default `ON DELETE` (`SET NULL`, `NO ACTION` or `CASCADE`, chosen by whether the column allows null). The default `ON UPDATE CASCADE` is not recorded; another `onUpdate` action is. The column becomes the relation of the IR rather than a separate field, and a `hasMany` / `hasOne` with a matching `belongsTo` on the same column provides its reverse name. `hasOne` does not make the key unique, so the relation is only one-to-one when the column is unique. `constraints: false` creates no foreign key and leaves a plain column; `scope` (polymorphic associations) is not representable and warns. A string `through` becomes a many-to-many relation whose join table is derived by the other formats; its name, columns, composite key and timestamps are not kept and a warning says what the other formats will use. A `through` model is an ordinary model that receives the two key columns.",
      },
      {
        id: 'sequelize-types',
        title: 'Column types are mapped to the nearest model type',
        explanation:
          '`STRING(n)` and `CHAR(n)` are length-limited strings (255 without an argument), `TEXT` and `CITEXT` text, every integer width `int` (`BIGINT` `bigInt`), `FLOAT`, `REAL` and `DOUBLE` `float`, `DECIMAL(p, s)` a decimal, `DATE` a date-time, `DATEONLY` a date, `JSON` and `JSONB` json, `BLOB` bytes, `ENUM(...)` an enum named after the model and the attribute (`PostStatus`), `ARRAY(type)` an array and `RANGE(type)` a range. `GEOMETRY`, `GEOGRAPHY`, `CIDR`, `MACADDR` and `TSVECTOR` are unsupported columns with a warning. In sequelize-typescript, `@Column` without a type takes it from the TypeScript type (`string`, `number`, `boolean`, `bigint`, `Date`, `Buffer`).',
      },
      {
        id: 'sequelize-not-schema',
        title: 'Behaviour that is not schema',
        explanation:
          '`DataTypes.VIRTUAL` attributes have no column and are skipped with a warning. Getters, setters, validators, hooks, scopes and default scopes change how Sequelize reads and writes rows, not the database, and are ignored (getters, setters, hooks and scopes warn once per model). Table comments, engines and character sets are dropped silently. Index conditions (`where`), expression indexes (`Sequelize.literal`) and index parsers cannot be represented: the first is dropped with the index kept, the others skip the index, each with a warning. The `uniqueKeys` option replaces the unique constraints named on attributes in Sequelize itself, and the same happens here with a warning.',
      },
    ],
    efcore: [
      {
        id: 'efcore-static',
        title: 'The model is read, not built',
        explanation:
          'The reader parses the C# with tree-sitter; nothing is compiled, loaded or run, so EF Core never builds its model. It understands what is written literally: data annotations, `DbSet<T>` properties, `modelBuilder.Entity<T>(...)` and `IEntityTypeConfiguration<T>` classes (also through `ApplyConfiguration`, `ApplyConfigurationsFromAssembly`, helper methods and extension methods of the input), and string, number, boolean, `nameof` and constant arguments. Conditions (`if`), loops over the model, `ConfigureConventions`, value converters, `HasData` and anything computed at run time are not evaluated: each produces a warning. `Migrations/`, `bin/` and `obj/` directories and `*.Designer.cs` / `*ModelSnapshot.cs` files are skipped, because they describe history, not the model; replaying migrations is not supported. Target: EF Core 5 and later, checked against EF Core 8 (`[Index]`, `[Precision]`, `[Comment]`, `[PrimaryKey]`, owned types, skip navigations).',
      },
      {
        id: 'efcore-entities',
        title: 'Which classes are entities',
        explanation:
          'An entity is a class used in a `DbSet<T>` property of a `DbContext`, named by `modelBuilder.Entity<T>()` or `IEntityTypeConfiguration<T>`, reached through a navigation property of another entity, or marked with an EF Core data annotation (`[Table]`, `[Index]`, `[PrimaryKey]`, `[Keyless]`, or `[Key]`, `[ForeignKey]`, `[InverseProperty]`, `[DatabaseGenerated]`, `[Column]`, `[Timestamp]` on a property). `[Required]`, `[MaxLength]` and `[StringLength]` alone do not make a class an entity, because they validate other classes too. An abstract class or a base class without a `DbSet` is not an entity: its properties are mapped into the classes that derive from it, as in EF Core. Classes marked `[NotMapped]`, `[Owned]` or `[ComplexType]` are not entities.',
      },
      {
        id: 'efcore-conventions',
        title: 'EF Core conventions are applied by the reader',
        explanation:
          "A key is the property called `Id` or `<TypeName>Id` (any case) unless `[Key]`, `[PrimaryKey]` or `HasKey` names one; an integer key counts up and a `Guid` key is a `uuid` generated by the client. A foreign key is found the way EF Core finds it (`<Navigation>Id`, `<Navigation><Key>`, `<Type>Id`, `<Type><Key>`, or `[ForeignKey]`), and a missing one becomes a shadow column named after the navigation. A relationship is required when its foreign key is not nullable, or when the navigation is not nullable under nullable reference types, and then deletes cascade; an optional one gets `ClientSetNull`, which is `NO ACTION` in the database (`noAction`). A table is named after the `DbSet` property, else the class, and a column after the property, so names keep their C# case (`Title`) unless `[Table]`, `[Column]`, `ToTable` or `HasColumnName` say otherwise. Nullable reference types are on when a file says `#nullable enable` or writes a reference type with `?`; without them, a `string` column allows null unless `[Required]`. EF Core's index on every foreign key is implicit and is not listed.",
      },
      {
        id: 'efcore-types',
        title: 'Column types follow the C# type',
        explanation:
          '`int`, `short`, `byte` and `uint` are `int`, `long` `bigInt`, `bool` boolean, `decimal` a decimal (precision from `[Precision]`, `HasPrecision` or a column type), `double` and `float` float, `DateTime` and `DateTimeOffset` date-time, `DateOnly`, `TimeOnly` and `TimeSpan` date, time and duration, `Guid` uuid, `byte[]` bytes, `JsonDocument` json, `string` a length-limited string with `[MaxLength]` / `[StringLength]` / `HasMaxLength` and otherwise `text`, and arrays and lists of these a provider array. `HasColumnType` / `[Column(TypeName)]` override the type when the name is one the model knows. Types with no equivalent (spatial types, `object`) are unsupported columns with a warning. A C# enum is an enum of the model; EF Core stores it as an integer unless `HasConversion<string>()` is used, so an integer-stored enum is read with its numbers as values and a warning, and writers that create enum types will store text instead.',
      },
      {
        id: 'efcore-relationships',
        title: 'Relationships and join tables',
        explanation:
          '`HasOne` / `HasMany` with `WithOne` / `WithMany`, `HasForeignKey` (also composite), `HasPrincipalKey`, `OnDelete`, `IsRequired` and `HasConstraintName` are read, as are `[ForeignKey]` and `[InverseProperty]`, and relationships EF Core infers from two navigation properties. Two collection navigations are a many-to-many through a join table that EF Core creates (`CategoryProduct` with `ProductsId` and `CategoriesId` by default); the model derives its own join table, so a warning names the table and columns the other formats will use whenever `UsingEntity` does not already match them. A join class named by `UsingEntity<T>`, or written by hand, is an ordinary model. Several navigations that could belong to one relationship are skipped with a warning unless `[InverseProperty]` or `WithMany(...)` pairs them. The delete behaviors `ClientSetNull`, `ClientCascade` and `ClientNoAction` act on tracked entities only and all become `NO ACTION`.',
      },
      {
        id: 'efcore-owned-inheritance',
        title: 'Owned types and inheritance',
        explanation:
          'Owned types (`OwnsOne`, `[Owned]`, `ComplexProperty`) are flattened into the owner with a prefix (`Address_Street`), also nested, and are nullable when the owner navigation is; `ToJson()` makes one json column. Collections of owned types are stored in their own table by EF Core and are skipped with a warning. Table-per-hierarchy inheritance becomes one model with the columns of every type (those of the derived types nullable) and a discriminator column, with a warning; table-per-type and table-per-concrete-type are read as independent tables, also with a warning.',
      },
      {
        id: 'efcore-not-schema',
        title: 'Behaviour that is not schema',
        explanation:
          'Comments (`[Comment]`, `HasComment`), concurrency tokens and row versions (`[Timestamp]`, `[ConcurrencyCheck]`, `IsRowVersion`), check constraints, seed data (`HasData`), query filters, filtered and covering indexes (the index is kept as a full index) and value converters have no place in the model; each is reported once per model or column. The one converter that is read is the enum-to-string `ValueConverter<TEnum, string>` class ormbridge writes, whose switch arms list the stored values (`"draft" => PostStatus.Draft`); a converter written any other way is not evaluated. Validation attributes (`[Range]`, `[EmailAddress]`) and serialization attributes (`[JsonIgnore]`) are not EF Core and are ignored silently. A fluent call the reader does not know (`HasPostgresExtension`, `UseHiLo`, `IsFixedLength`) warns once per call and place. Default values come from `HasDefaultValue`, `HasDefaultValueSql` and `HasComputedColumnSql` only: a C# property initializer is not a database default.',
      },
    ],
    jpa: [
      {
        id: 'jpa-static',
        title: 'The model is read, not built',
        explanation:
          'The reader parses the Java with tree-sitter; nothing is compiled, loaded or run, so Hibernate never builds its metamodel. It understands what is written literally: annotations from `jakarta.persistence` or the legacy `javax.persistence` (matched by simple name, so wildcard imports work), and string, number, boolean, enum-constant and class-literal arguments, including constants (`static final String`) and `+` on them. `orm.xml`, `persistence.xml`, `hbm.xml` mappings, Kotlin and Groovy sources are not read. Lombok needs nothing, because the mapping is on the fields, and Spring Data annotations are read where they matter (auditing). `target/`, `build/`, `out/`, `.gradle/`, `node_modules/` and `src/test/` directories, `*Test.java` / `*Tests.java`, `module-info.java`, `package-info.java`, generated metamodel classes (`*_.java`) and `db/migration` folders are skipped. Target: JPA 2.2 and 3, Hibernate 5 and 6, checked against Hibernate 6.4 on H2.',
      },
      {
        id: 'jpa-entities',
        title: 'Which classes are entities',
        explanation:
          "An entity is a class annotated with `@Entity`. A `@MappedSuperclass` has no table: its attributes are copied into every entity that extends it, before the entity's own, and a generic one (`Base<ID>`) takes the type its subclass gives. `@Embeddable` classes are flattened into the owner, also nested, with `@AttributeOverride` applied at any depth. Records, enums, interfaces and `@Subselect` entities (a query, not a table) are not entities. A superclass that is not in the input (`AbstractPersistable<Long>`) cannot be read and is reported. The table is named by `@Table(name)`, else the entity name (`@Entity(name)`, else the class name), and a column by `@Column(name)`, else the attribute name, as JPA and Hibernate's own naming strategy do.",
      },
      {
        id: 'jpa-naming',
        title: 'Names follow plain JPA, not Spring Boot',
        explanation:
          'Without `@Table` and `@Column`, JPA keeps the Java names: `BlogPost` is the table `BlogPost` and `createdAt` the column `createdAt`, and a join column is `<attribute>_<key>` (`author_id`). Spring Boot changes that with `CamelCaseToUnderscoresNamingStrategy` (`blog_post`, `created_at`), which lives in `application.properties` and is not read. Choose with `--naming`: `preserve` (default) keeps the names as JPA derives them; `normalize` applies the fresh-schema style of the other readers (snake_case, singular tables), which is also what Spring Boot gives for ordinary names, but it replaces integer keys by UUIDs and adds timestamps. Explicit names in `@Table` and `@Column` are the same under both.',
      },
      {
        id: 'jpa-types',
        title: 'Column types follow the Java type',
        explanation:
          '`int`, `short` and `byte` are `int`, `long` `bigInt`, `boolean` boolean, `float` and `double` float, `BigDecimal` a decimal (38, 2 unless `@Column(precision, scale)` or `@Digits` say otherwise), `BigInteger` a decimal of 38 digits, `String` a string of 255 (`@Column(length)`, then `@Size(max)` / `@Length(max)`) and `text` with `@Lob`, `LocalDate`, `LocalTime` and the date-time types date, time and date-time (`@Temporal` selects for `java.util.Date` and `Calendar`), `Duration` a duration, `UUID` uuid, `byte[]` and `Blob` bytes, `JsonNode` and `@JdbcTypeCode(SqlTypes.JSON)` json, `List<String>` an array column. Primitives are NOT NULL; `@Id`, `@Column(nullable = false)`, `@Basic(optional = false)` and `@NotNull` too, in that order of precedence (`@NotBlank` and `@NotEmpty` change nothing in Hibernate\'s DDL and are ignored). `@Column(columnDefinition)` is read for its type, `not null`, `unique` and `default`. An enum is an enum of the model: `@Enumerated(STRING)` stores its names, the JPA default stores the ordinal number, so the numbers are the values and a warning says writers that create enum types will store text. Types with no column (your own classes, `Object`) are unsupported columns with a warning, and `@Convert` is not run: the column type is read from the `AttributeConverter` of the input when there is one. The one enum converter that is read is the form the writer produces: an `AttributeConverter<Enum, String|Integer>` named by `@Convert` on an enum whose constants carry the stored value as their only argument (`DRAFT("draft")`); any other converter of an enum is not evaluated and the enum is read as `@Enumerated` says.',
      },
      {
        id: 'jpa-relationships',
        title: 'Relationships and join tables',
        explanation:
          "`@ManyToOne` and `@OneToOne` become foreign keys (a one-to-one is unique), with `@JoinColumn` (name, `referencedColumnName`, `nullable`, `foreignKey`), `@JoinColumns` (a composite foreign key), `optional`, `@NotNull`, `@MapsId` and `@Id` on the relationship (the key is the foreign key). `@OnDelete` sets the action; without it the database has none (`noAction`), and `cascade = REMOVE/ALL` and `orphanRemoval` act in the ORM only, which a warning says. An inverse side (`mappedBy`) adds nothing: it names the reverse accessor of the owning side. A `@ManyToMany` is a many-to-many relation; the model derives its own join table, so a warning names the table and columns the other formats will use whenever `@JoinTable` (or Hibernate's default `Book_Author`) does not already match them. A unidirectional `@OneToMany` is a key on the target with `@JoinColumn`, else a join table read as a many-to-many (that each target belongs to one owner is not represented). `@ElementCollection` of basic values is read as a child table without the primary key Hibernate does not create either.",
      },
      {
        id: 'jpa-inheritance',
        title: 'Inheritance strategies',
        explanation:
          "Single-table inheritance (the default) becomes one model with the columns of every class and the discriminator column (`DTYPE`, or `@DiscriminatorColumn`); the discriminator values are listed in a warning and the subclasses are not separate models. Joined inheritance is read as one model per class, the subclass's primary key being a foreign key to its parent (a one-to-one primary key relation); the inherited attributes stay on the parent. Table-per-class entities are independent tables with the inherited columns, and an abstract root without a table cannot be a relationship target. Each case warns.",
      },
      {
        id: 'jpa-not-schema',
        title: 'Behaviour that is not schema',
        explanation:
          'Optimistic-locking `@Version`, `@Comment`, `@Check`, `@SecondaryTable` (everything is read into the primary table), `@Formula` (no column), `@TenantId`, Envers `@Audited` (its audit tables), sequence and table generators (read as auto-increment keys), and `@SqlResultSetMapping` have no place in the model; each is reported, by class and attribute. Named queries, `@Filter`, `@Where`, `@SQLDelete`, `@Cache`, entity listeners and fetch types are not schema and are ignored silently. A Java feature the reader does not know (`Optional` on a field, a `Map` without `@ElementCollection`) warns and skips the attribute. A `@ColumnDefault` is the only default: a field initializer (`= 5`) is not a database default.',
      },
      {
        id: 'jpa-written',
        title: 'What the writer approximates',
        explanation:
          'The writer names every table, column and join column explicitly, so the output means the same under any naming strategy. A default is written as `@ColumnDefault` (the database default) and, for a literal or `now`, as the field initializer, because Hibernate rejects a null for a NOT NULL property before the database can fill in its default; a default that only the database can compute (an expression) keeps the property null, writes `@DynamicInsert`, and needs Bean Validation on the class path or `hibernate.check_nullability=false`. `now` is `@CreationTimestamp` only on a column named like a creation time (`created_at`), because Hibernate overwrites such a column on every insert. A string without a length is `text` on PostgreSQL and 255 characters elsewhere (a large text column cannot be a key or an index); `text` is `@Lob` outside PostgreSQL. JSON is `@JdbcTypeCode(SqlTypes.JSON)` with Hibernate 6 and a String with a warning with Hibernate 5; arrays are Java arrays on PostgreSQL, JSON elsewhere, a String with Hibernate 5. An enum whose stored values differ from its names gets an `AttributeConverter` and constants that carry the stored value, which the reader reads back. A composite key is an `@IdClass`. A composite foreign key maps its scalar columns and a read-only `@JoinColumns` relationship. `ON UPDATE` actions, index methods, clustering, full-text indexes, computed columns (Hibernate 5), hstore, ranges, and `ON DELETE` actions other than `CASCADE` (Hibernate 5) have no JPA equivalent and each warns. A model without a primary key gets one column as its `@Id`. `@Version` is never written, because the IR has no optimistic-locking column.',
      },
    ],
  };

/** True when either end of the pair is the given format. */
function involves(cell: MatrixCell, format: string): boolean {
  return cell.source === format || cell.target === format;
}

/** The column names Eloquent maintains itself. */
const LARAVEL_TIMESTAMP_COLUMNS: ReadonlySet<string> = new Set([
  'created_at',
  'updated_at',
]);

/** Differences that come from how the Laravel writer and reader treat keys, timestamps and reverse names. */
function explainLaravelDifference(
  difference: IrDifference,
  cell: MatrixCell
): string | undefined {
  const field: string = difference.field ?? '';
  switch (difference.kind) {
    case 'fieldType': {
      const model: IrModel | undefined = cell.sourceSchema.models.find(
        (candidate: IrModel) => candidate.name === difference.model
      );
      const source: IrField | undefined = model?.fields.find(
        (candidate: IrField) => candidate.columnName === field
      );
      // A join model synthesized for Prisma is not in the source schema; its key is called id.
      return (source?.isPrimaryKey === true || field === 'id') &&
        difference.before === 'int' &&
        difference.after === 'bigInt'
        ? 'laravel-big-integer-keys'
        : undefined;
    }
    case 'fieldNullability':
      return LARAVEL_TIMESTAMP_COLUMNS.has(field) &&
        difference.before === 'required' &&
        difference.after === 'nullable'
        ? 'laravel-timestamps'
        : undefined;
    case 'fieldDefault':
      return field === 'updated_at' && difference.after === '(none)'
        ? 'laravel-timestamps'
        : undefined;
    case 'fieldAutoUpdated':
      return field === 'updated_at' ? 'laravel-timestamps' : undefined;
    case 'relationRelatedName':
      return cell.target === 'laravel' ? 'laravel-reverse-name' : undefined;
    default:
      return undefined;
  }
}

/** Differences that come from how the JSON Schema writer and reader treat defaults, nullability and join tables. */
function explainJsonSchemaDifference(
  difference: IrDifference
): string | undefined {
  switch (difference.kind) {
    case 'fieldDefault':
      return difference.after === '(none)' ? 'json-schema-defaults' : undefined;
    case 'fieldNullability':
      return 'json-schema-defaults';
    case 'fieldAutoUpdated':
      return difference.before === 'false' && difference.after === 'true'
        ? 'json-schema-defaults'
        : undefined;
    case 'relationRemoved':
    case 'relationAdded':
      return difference.before.startsWith('manyToMany') ||
        difference.after.startsWith('manyToMany')
        ? 'json-schema-join-tables'
        : undefined;
    case 'fieldAdded':
    case 'fieldRemoved':
    case 'modelAdded':
    case 'modelRemoved':
      return 'json-schema-join-tables';
    default:
      return undefined;
  }
}

function explainSqlAlchemyDifference(
  difference: IrDifference
): string | undefined {
  switch (difference.kind) {
    case 'relationRelatedName':
      return 'sqlalchemy-reverse-name';
    case 'relationRemoved':
    case 'relationAdded':
      return difference.before.startsWith('manyToMany') ||
        difference.after.startsWith('manyToMany')
        ? 'sqlalchemy-many-to-many'
        : undefined;
    default:
      return undefined;
  }
}

function explainSqlDifference(difference: IrDifference): string | undefined {
  switch (difference.kind) {
    case 'relationRelatedName':
      return 'sql-reverse-name';
    case 'fieldUnique':
      return difference.before === 'true' && difference.after === 'false'
        ? 'sql-unique-index'
        : undefined;
    case 'indexAdded':
    case 'indexRemoved':
      return 'sql-unique-index';
    case 'fieldAutoUpdated':
      return difference.before === 'true' && difference.after === 'false'
        ? 'sql-auto-timestamps'
        : undefined;
    case 'relationRemoved':
    case 'relationAdded':
      return difference.before.startsWith('manyToMany') ||
        difference.after.startsWith('manyToMany')
        ? 'sql-join-tables'
        : undefined;
    case 'modelAdded':
    case 'modelRemoved':
      return 'sql-join-tables';
    default:
      return undefined;
  }
}

/** Differences that come from Sequelize leaving the creation time to the application and from how it names enums. */
function explainSequelizeDifference(
  difference: IrDifference
): string | undefined {
  switch (difference.kind) {
    case 'fieldDefault':
      return /^created_?at$/i.test(difference.field ?? '') &&
        ((difference.before === '(none)' && difference.after === 'now') ||
          (difference.before === 'now' && difference.after === '(none)'))
        ? 'sequelize-timestamps'
        : undefined;
    case 'fieldEnum':
    case 'enumAdded':
    case 'enumRemoved':
      return 'sequelize-enum-names';
    default:
      return undefined;
  }
}

/** Returns the id of the reason that explains a difference, or undefined when it is unexplained. */
export function explainDifference(
  difference: IrDifference,
  cell: MatrixCell
): string | undefined {
  const schema: IrSchema = cell.sourceSchema;
  if (involves(cell, 'sequelize')) {
    const sequelizeReason: string | undefined =
      explainSequelizeDifference(difference);
    if (sequelizeReason !== undefined) {
      return sequelizeReason;
    }
  }
  if (involves(cell, 'json-schema')) {
    const jsonSchemaReason: string | undefined =
      explainJsonSchemaDifference(difference);
    if (jsonSchemaReason !== undefined) {
      return jsonSchemaReason;
    }
  }
  if (involves(cell, 'sqlalchemy')) {
    const sqlAlchemyReason: string | undefined =
      explainSqlAlchemyDifference(difference);
    if (sqlAlchemyReason !== undefined) {
      return sqlAlchemyReason;
    }
  }
  if (involves(cell, 'sql')) {
    const sqlReason: string | undefined = explainSqlDifference(difference);
    if (sqlReason !== undefined) {
      return sqlReason;
    }
  }
  if (involves(cell, 'laravel')) {
    const laravelReason: string | undefined = explainLaravelDifference(
      difference,
      cell
    );
    if (laravelReason !== undefined) {
      return laravelReason;
    }
  }
  switch (difference.kind) {
    case 'fieldMaxLength': {
      const model: IrModel | undefined = schema.models.find(
        (candidate: IrModel) => candidate.name === difference.model
      );
      const field: IrField | undefined = model?.fields.find(
        (candidate: IrField) => candidate.columnName === difference.field
      );
      if (field?.enumName === undefined) {
        return undefined;
      }
      if (difference.after === '(none)') {
        return 'enum-length';
      }
      return Number(difference.after) === 32 && Number(difference.before) < 32
        ? 'django-enum-length-floor'
        : undefined;
    }
    case 'fieldAutoUpdated':
      if (
        involves(cell, 'gorm') &&
        difference.field === 'updated_at' &&
        difference.before === 'false' &&
        difference.after === 'true'
      ) {
        return 'gorm-auto-timestamps';
      }
      return undefined;
    case 'relationRelatedName':
      if (involves(cell, 'drizzle')) {
        return 'drizzle-reverse-name';
      }
      return involves(cell, 'gorm') ? 'gorm-reverse-name' : undefined;
    case 'fieldDefault':
      if (
        cell.target === 'gorm' &&
        difference.before === 'literal ""' &&
        difference.after === '(none)'
      ) {
        return 'gorm-empty-string-default';
      }
      return involves(cell, 'doctrine') &&
        difference.before === 'literal "{}"' &&
        difference.after === 'literal "[]"'
        ? 'php-empty-array-default'
        : undefined;
    case 'enumValueLabel':
      return difference.after === '(none)' ? 'enum-label' : undefined;
    case 'relationRemoved':
      if (
        cell.target === 'drizzle' &&
        difference.before.startsWith('manyToMany')
      ) {
        return 'drizzle-join-tables';
      }
      return cell.target === 'prisma' &&
        difference.before.startsWith('manyToMany')
        ? 'join-table'
        : undefined;
    case 'modelRemoved':
      // The explicit join model of a Prisma source (`PostTags`) is replaced by the one Drizzle derives.
      return cell.target === 'drizzle' && cell.source === 'prisma'
        ? 'drizzle-join-tables'
        : undefined;
    case 'modelAdded':
      if (
        cell.target === 'drizzle' &&
        cell.differences.some(
          (other: IrDifference) =>
            (other.kind === 'relationRemoved' &&
              other.before.startsWith('manyToMany')) ||
            other.kind === 'modelRemoved'
        )
      ) {
        return 'drizzle-join-tables';
      }
      return cell.target === 'prisma' &&
        cell.differences.some(
          (other: IrDifference) =>
            other.kind === 'relationRemoved' &&
            other.before.startsWith('manyToMany')
        )
        ? 'join-table'
        : undefined;
    default:
      return undefined;
  }
}

/** Differences that no documented reason explains. */
export function unexplainedDifferences(cell: MatrixCell): IrDifference[] {
  return cell.differences.filter(
    (difference: IrDifference) =>
      explainDifference(difference, cell) === undefined
  );
}

/** Second-trip differences that no documented reason explains. */
export function unexplainedIdempotenceDifferences(
  cell: MatrixCell
): IrDifference[] {
  return cell.idempotenceDifferences.filter(
    (difference: IrDifference) =>
      explainDifference(difference, cell) === undefined
  );
}

function pairLabel(cell: MatrixCell): string {
  return `${cell.source} → ${cell.target}`;
}

function summaryCell(cell: MatrixCell | undefined): string {
  if (cell === undefined) {
    return '—';
  }
  const count: number = cell.differences.length;
  return count === 0
    ? '✔ lossless'
    : `⚠ ${count} difference${count === 1 ? '' : 's'}`;
}

function summaryMatrix(
  cells: MatrixCell[],
  sources: string[],
  targets: string[]
): string[] {
  const lines: string[] = [
    `| from \\ to | ${targets.join(' | ')} |`,
    `| --- | ${targets.map(() => '---').join(' | ')} |`,
  ];
  for (const source of sources) {
    const row: string[] = targets.map((target: string) =>
      summaryCell(
        cells.find(
          (cell: MatrixCell) => cell.source === source && cell.target === target
        )
      )
    );
    lines.push(`| **${source}** | ${row.join(' | ')} |`);
  }
  return lines;
}

function pairTable(cells: MatrixCell[]): string[] {
  const lines: string[] = [
    '| Pair | Result | Emit warnings | Re-read warnings | Stable after a second trip |',
    '| --- | --- | --- | --- | --- |',
  ];
  for (const cell of cells) {
    lines.push(
      `| ${pairLabel(cell)} | ${summaryCell(cell)} | ${cell.emitWarnings.length} | ${cell.reparseWarnings.length} | ${cell.readOnlySource === true ? 'n/a (read only)' : cell.idempotenceDifferences.length === 0 ? 'yes' : 'no'} |`
    );
  }
  return lines;
}

function pairDetails(
  cell: MatrixCell,
  reasonNumbers: Map<string, number>
): string[] {
  const lines: string[] = [`### ${pairLabel(cell)}`, ''];
  if (cell.differences.length === 0) {
    lines.push('Lossless for the canonical schema.');
  } else {
    lines.push('Differences found:', '');
    for (const difference of cell.differences) {
      const reason: string | undefined = explainDifference(difference, cell);
      const number: number | undefined =
        reason === undefined ? undefined : reasonNumbers.get(reason);
      lines.push(
        `- \`${formatDifference(difference)}\`${number === undefined ? ' (unexplained)' : ` — see reason ${number}`}`
      );
    }
  }
  lines.push('');
  if (cell.emitWarnings.length === 0) {
    lines.push('Emit warnings: none.');
  } else {
    lines.push('Emit warnings:', '');
    for (const warning of cell.emitWarnings) {
      lines.push(`- ${warning}`);
    }
  }
  lines.push('');
  if (cell.reparseWarnings.length === 0) {
    lines.push('Warnings when the output is read back: none.');
  } else {
    lines.push('Warnings when the output is read back:', '');
    for (const warning of cell.reparseWarnings) {
      lines.push(`- ${warning}`);
    }
  }
  if (cell.readOnlySource === true) {
    lines.push(
      '',
      `Second trip not checked: ${cell.source} can only be read, so ${cell.target} → ${cell.source} → ${cell.target} cannot be run.`,
      ''
    );
    return lines;
  }
  const unexplainedSecondTrip: IrDifference[] =
    unexplainedIdempotenceDifferences(cell);
  lines.push(
    '',
    cell.idempotenceDifferences.length === 0
      ? `Stable: converting ${cell.target} → ${cell.source} → ${cell.target} again changes nothing further.`
      : unexplainedSecondTrip.length === 0
        ? `Not stable, but only for documented reasons: a second ${cell.target} → ${cell.source} → ${cell.target} trip changes:`
        : `Not stable: a second ${cell.target} → ${cell.source} → ${cell.target} trip changes:`
  );
  for (const difference of cell.idempotenceDifferences) {
    const reason: string | undefined = explainDifference(difference, cell);
    const number: number | undefined =
      reason === undefined ? undefined : reasonNumbers.get(reason);
    lines.push(
      `- \`${formatDifference(difference)}\`${number === undefined ? ' (unexplained)' : ` — see reason ${number}`}`
    );
  }
  lines.push('');
  return lines;
}

function emitOnlySection(cells: EmitOnlyCell[]): string[] {
  const targets: string[] = [];
  for (const cell of cells) {
    if (!targets.includes(cell.target)) {
      targets.push(cell.target);
    }
  }
  const lines: string[] = [
    '## Write-only targets',
    '',
    `Some formats can be written but not read (${targets.join(', ')}), so the matrix cannot re-read their output and compare IRs. For these it checks the written files against the IR instead: every model has a declaration for its table (a struct, a table builder call), every column has a field or builder, every many-to-many relation has its join table and every enum has its type or value list. JSON Schema: every model and enum has a \`$defs\` entry and every column and relation has a property. "Missing" lists what the check could not find; it is empty when the output covers the schema. What the format approximates or cannot express is listed below the table.`,
    '',
    '| Pair | Files | Emit warnings | Missing |',
    '| --- | --- | --- | --- |',
  ];
  for (const cell of cells) {
    lines.push(
      `| ${cell.source} → ${cell.target} | ${cell.files.length} | ${cell.emitWarnings.length} | ${cell.missing.length === 0 ? 'none' : cell.missing.length} |`
    );
  }
  lines.push('');
  for (const cell of cells) {
    lines.push(`### ${cell.source} → ${cell.target}`, '');
    lines.push(
      cell.missing.length === 0
        ? 'The output covers the canonical schema.'
        : `Missing from the output: ${cell.missing.join('; ')}.`
    );
    lines.push('');
    if (cell.emitWarnings.length === 0) {
      lines.push('Emit warnings: none.');
    } else {
      lines.push('Emit warnings:', '');
      for (const warning of cell.emitWarnings) {
        lines.push(`- ${warning}`);
      }
    }
    lines.push('');
  }
  for (const target of targets) {
    const notes: readonly LossReason[] = EMIT_ONLY_NOTES[target] ?? [];
    if (notes.length === 0) {
      continue;
    }
    lines.push(`### What ${target} approximates`, '');
    notes.forEach((note: LossReason, position: number): void => {
      lines.push(`${position + 1}. **${note.title}.** ${note.explanation}`);
    });
    lines.push('');
  }
  return lines;
}

/** Renders the committed conversion matrix document. */
export function renderMatrixMarkdown(
  cells: MatrixCell[],
  emitOnly: EmitOnlyCell[] = []
): string {
  const formats: string[] = [];
  for (const cell of cells) {
    for (const name of [cell.source, cell.target]) {
      if (!formats.includes(name)) {
        formats.push(name);
      }
    }
  }
  // Formats that only appear as the source of read-only cells cannot be written.
  const readOnly: string[] = formats.filter((name: string) =>
    cells
      .filter(
        (cell: MatrixCell) => cell.source === name || cell.target === name
      )
      .every(
        (cell: MatrixCell) =>
          cell.readOnlySource === true && cell.source === name
      )
  );
  const readWrite: string[] = formats.filter(
    (name: string) => !readOnly.includes(name)
  );
  const usedReasons: LossReason[] = LOSS_REASONS.filter((reason: LossReason) =>
    cells.some((cell: MatrixCell) =>
      [...cell.differences, ...cell.idempotenceDifferences].some(
        (difference: IrDifference) =>
          explainDifference(difference, cell) === reason.id
      )
    )
  );
  const reasonNumbers: Map<string, number> = new Map<string, number>(
    usedReasons.map((reason: LossReason, index: number) => [
      reason.id,
      index + 1,
    ])
  );

  const lines: string[] = [
    '# Conversion matrix',
    '',
    '<!-- Generated by `npm run docs:matrix` (scripts/generate-conversion-matrix.ts). Do not edit by hand: the tests fail when this file is stale. -->',
    '',
    `This page shows what survives a round trip between the formats ormbridge can both read and write (${readWrite.join(', ')})${readOnly.length === 0 ? '' : `, and what survives when a format that can only be read (${readOnly.join(', ')}) is written to each of them`}. It is generated from the canonical "blog" schema in \`test/fixtures/\`, so it describes the constructs that schema uses; the README's "Limitations and warnings" section lists constructs it does not cover.`,
    '',
    '## How a cell is computed',
    '',
    'For each ordered pair (A, B) the test suite',
    '',
    '1. reads the canonical fixture of A into the intermediate representation (IR),',
    '2. writes B (default `preserve` naming, PostgreSQL provider),',
    '3. reads the written B text back into the IR, and',
    '4. compares the two IRs with `test/irCompare.ts`.',
    '',
    "Each format is read from its own canonical fixture, and the fixtures spell the same blog schema in their native styles (for example the Prisma fixture writes the post/tag join table as an explicit `PostTags` model while Django and TypeORM declare a many-to-many field). A cell therefore compares a source with its own fixture, not with the other formats' fixtures.",
    '',
    "The comparison covers models, table names, fields, types, nullability, defaults, lengths and precision, primary and composite keys, relations (kind, target, nullability, `onDelete`, reverse accessor), enums, indexes and uniques. It ignores differences that mean nothing: ordering, case and underscore spelling of identifiers (`created_at` vs `createdAt`, `DRAFT` vs `Draft`), the Django app label, index and constraint names the target generated itself (an explicit name that is lost is reported), Django's implicit reverse accessor names (`post_set`), the nullability of many-to-many relations (they have no column), and values a target must invent (Django enum labels and the `max_length` Django requires on enum columns).",
    '',
    ...(readOnly.length === 0
      ? []
      : [
          `A format that can only be read (${readOnly.join(', ')}) has no writer yet, so its cells stop after step 4: the schema is read from its fixture, written to the target and read back, but it cannot be written back to the source for a second trip. These rows join the full matrix, with a second trip, once the format gains a writer.`,
          '',
        ]),
    'Text goldens in `test/golden/` pin the exact output and the `roundtrip-*.drift.txt` files pin the textual drift; this page is the semantic view of the same conversions.',
    '',
    '## Summary',
    '',
    'Rows are the source format, columns the target. ✔ means the canonical schema comes back unchanged; ⚠ gives the number of structural differences.',
    '',
    ...summaryMatrix(cells, formats, readWrite),
    '',
    ...pairTable(cells),
    '',
  ];

  if (usedReasons.length > 0) {
    lines.push('## Why information is lost', '');
    for (const reason of usedReasons) {
      lines.push(
        `${reasonNumbers.get(reason.id)}. **${reason.title}.** ${reason.explanation}`
      );
    }
    lines.push('');
  }

  lines.push('## Details per pair', '');
  for (const cell of cells) {
    lines.push(...pairDetails(cell, reasonNumbers));
  }

  if (emitOnly.length > 0) {
    lines.push(...emitOnlySection(emitOnly));
  }

  // The reader notes of every format that has them, whether or not it can also be written.
  for (const name of formats) {
    const readNotes: readonly LossReason[] = READ_ONLY_NOTES[name] ?? [];
    if (readNotes.length === 0) {
      continue;
    }
    lines.push(
      `## What ${name} cannot express`,
      '',
      `The cells above compare IRs, so they cannot show what is lost before the IR exists, when ${name} is read. These are the constructs the ${name} reader drops, approximates or has to guess; each case also produces a warning that names the model and property.`,
      ''
    );
    readNotes.forEach((note: LossReason, position: number): void => {
      lines.push(`${position + 1}. **${note.title}.** ${note.explanation}`);
    });
    lines.push('');
  }

  lines.push(
    '## Known issues',
    '',
    '- Writing a many-to-many to TypeORM emits `@JoinTable({ name, joinColumn, inverseJoinColumn })` so the join table matches the one Django creates. The TypeORM reader then warns that "custom @JoinTable settings (name, joinColumn, inverseJoinColumn) are not preserved" for ormbridge\'s own output. The names it would have read are the same ones it derives, so nothing is lost, but the warning is noise for generated code.',
    '- The matrix only covers the canonical schema. Constructs outside it (composite primary keys, one-to-one primary keys, scalar lists, custom join tables and so on) are not exercised here; see the README for how they convert.',
    ''
  );
  return lines.join('\n');
}

/** Rendering of one cell's differences, used in test failure messages. */
export function describeDifferences(differences: IrDifference[]): string {
  return differences.map(formatDifference).join('\n');
}
