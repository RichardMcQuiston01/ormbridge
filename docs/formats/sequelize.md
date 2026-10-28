# Sequelize

ormbridge reads and writes Sequelize 6 and Sequelize 7 models and rebuilds a schema from `sequelize-cli` migrations (`ormbridge formats` lists `sequelize` as `read + write`). It claims no file extension, because `.js` and `.ts` are too generic: always pass `--from sequelize` (or `--to sequelize`). Without it a `.js` or `.ts` input is read as Django and fails with `No concrete Django models were found in: ...`. The models are parsed statically with tree-sitter; nothing is imported or run, so no Node project, `sequelize` install or database is needed.

Four ways of defining models are read, and one way of describing a schema without models:

- `sequelize.define('Name', { ...attributes }, { ...options })`, including the factory that `sequelize-cli` generates (`module.exports = (sequelize, DataTypes) => { const X = sequelize.define(...); X.associate = ...; return X; }`).
- `class X extends Model {}` with `X.init({ ...attributes }, { sequelize, modelName, tableName })`, in JavaScript or TypeScript, also from a static method (`this.init(...)`, `super.init(...)`).
- sequelize-typescript: classes decorated with `@Table`, with `@Column`, `@PrimaryKey`, `@ForeignKey`, `@BelongsTo` and the other decorators.
- Sequelize 7 (`@sequelize/core`): classes decorated with `@Table`, `@Attribute`, `@PrimaryKey`, `@AutoIncrement`, `@NotNull`, `@Unique`, `@Default`, `@HasMany`, `@BelongsTo`, `@BelongsToMany` and the rest of `@sequelize/core/decorators-legacy`. The reader tells the generations apart by the import: a file that imports from the `@sequelize` scope follows the Sequelize 7 rules, any other file the Sequelize 6 ones, so one input can hold both.
- A folder of `sequelize-cli` migrations (`up(queryInterface, Sequelize)`) holds no models: it is replayed, file by file, into the schema the database ends with ([below](#migrations)).

## Try it

The example in [`examples/sequelize`](../../examples/sequelize/) has two conversions in `ormbridge.config.json`:

```bash
cd examples/sequelize
npx ormbridge convert            # writes models/ from the shared schema, then reads it back
npx ormbridge convert --check
```

| Conversion       | Input                     | Output                 |
| ---------------- | ------------------------- | ---------------------- |
| `to-sequelize`   | `../schema/schema.prisma` | `models`               |
| `from-sequelize` | `models`                  | `prisma/schema.prisma` |

`models/` is generated: one TypeScript file per model plus `index.ts`. Inside this repository run `node ../../dist/cli.js convert` after `npm run build`. Without the config file: `ormbridge convert -i ../schema/schema.prisma -t sequelize -o models` and `ormbridge convert -i models -f sequelize -t prisma -o prisma/schema.prisma`.

## Reading

- **Input.** A file or a directory. In a directory every `.js`, `.cjs`, `.mjs` and `.ts` file is read except `*.d.ts`, `*.test.*` and `*.spec.*`, and models are picked out of them; loaders such as `models/index.js` define nothing and are ignored. Directory walks skip `node_modules`, `dist`, `build`, `coverage`, `.git` and the `sequelize-cli` directories `migrations`, `seeders` and `config`, so the models of a project root are read and its migrations are not; a project root without any model file reads its migrations instead ([below](#migrations)). A file that is named explicitly is always read. Several files are merged, so associations may point at models in other files, and an attribute set that is a `const` (or imported from another input file) is followed.
- **Names.** The model name is the first argument of `define`, the `modelName` option, or the class name (PascalCase when written as `blog_post`). The table is `tableName`, or Sequelize's plural of the model name (`PostTag` becomes `PostTags`, `Person` `People`), snake_cased with `underscored`, left alone with `freezeTableName`. The plural rules are those of the `inflection` package Sequelize uses. An attribute's column is its `field`, or the attribute name (snake_case with `underscored`).
- **Columns.** `DataTypes.STRING(n)` / `CHAR(n)` (255 without a length), `TEXT`, `INTEGER` and the other widths, `BIGINT`, `FLOAT` / `REAL` / `DOUBLE`, `DECIMAL(p, s)`, `BOOLEAN`, `DATE`, `DATEONLY`, `TIME`, `UUID`, `JSON` / `JSONB`, `BLOB`, `ENUM(...)`, `ARRAY(type)`, `RANGE(type)`, `INET` and `HSTORE`, written as `DataTypes.X`, `DataType.X`, `Sequelize.X` or a bare name, with `.UNSIGNED` and similar flags, either as `{ type: DataTypes.X }` or as the bare type. `primaryKey`, `autoIncrement`, `allowNull` (columns are nullable unless `allowNull: false`), `unique` (`true`, a name, or `{ name, msg }`; a name shared by several attributes is a composite unique constraint), `defaultValue`, `field`, `references` and `onDelete` / `onUpdate`.
- **Defaults.** Literals, `DataTypes.NOW` (`now`), `DataTypes.UUIDV4` / `UUIDV1` (generated UUID), objects and arrays on JSON columns, enum values, and `Sequelize.fn('now')` / `Sequelize.literal('...')` (a database expression, or `now` / a literal when it is one). Sequelize generates `NOW` and `UUIDV4` defaults in JavaScript, not in the database; they are recorded as defaults all the same. A function default (`() => ...`, `new Date()`) is dropped with a warning.
- **Generated columns.** Sequelize adds an `id` (integer, auto-increment, primary key) when no attribute is a primary key, and `createdAt` / `updatedAt` as non-null date-time columns (the second one auto-updated) unless `timestamps: false`. `createdAt`, `updatedAt` and `deletedAt` can be renamed or turned off, `paranoid` adds a nullable `deletedAt`, and `version` adds an integer column. An attribute you declare under the same name replaces the generated one, as in Sequelize. `new Sequelize(..., { define: { ... } })` supplies the defaults of `underscored`, `timestamps`, `freezeTableName`, `paranoid` and the timestamp names.
- **Options.** `tableName`, `modelName`, `freezeTableName`, `timestamps`, `paranoid`, `underscored`, `schema`, `indexes` (`fields`, `unique`, `name`, `using`, `type`) and `uniqueKeys`. Index fields may be attribute or column names.
- **Associations.** `hasMany`, `hasOne`, `belongsTo` and `belongsToMany` with `as`, `foreignKey` (a name or `{ name, allowNull, field }`), `otherKey`, `sourceKey`, `targetKey`, `onDelete`, `onUpdate`, `constraints` and `through`, written at the top level, inside `associate(models)` functions or static methods (`this.hasMany(...)`), on `models.Post`, `sequelize.models.Post` or `sequelize.model('Post')`. The reader applies them the way Sequelize does when `associate` runs: the foreign key column is added to the model that holds it (or completed when the model already declares it), with Sequelize's default name (`<as>Id`, or `<Model>Id` for `hasMany`), type, `ON DELETE` and `ON UPDATE CASCADE`. The column becomes the relation of the shared model rather than a separate field; a `hasMany` or `hasOne` on the same column as a `belongsTo` gives its reverse name. A string `through` becomes a many-to-many relation (the two `belongsToMany` calls over one table are one relation), a `through` model stays an ordinary model that receives the two key columns.
- **sequelize-typescript.** `@Table({ ... })` (also bare), `@Column(DataType.X)` / `@Column({ type, allowNull, ... })` (without a type, `@Column` takes it from the TypeScript type), `@PrimaryKey`, `@AutoIncrement`, `@AllowNull`, `@NotNull`, `@Unique`, `@Default`, `@Comment`, `@CreatedAt` / `@UpdatedAt` / `@DeletedAt`, `@Index`, `@ForeignKey(() => Model)` (which also finds the key of `@BelongsTo`, `@HasMany`, `@HasOne` and `@BelongsToMany` when none is named), and the association decorators with their option, string and `through` forms. The property name is the alias, as in sequelize-typescript.

- **Sequelize 7.** `@Attribute(DataTypes.X)` or `@Attribute({ type, allowNull, columnName, ... })` is the column (`@Column` still works in sequelize-typescript files), with `@PrimaryKey`, `@AutoIncrement`, `@NotNull`, `@AllowNull`, `@Unique`, `@Default`, `@ColumnName`, `@Comment` and `@Index`; `@CreatedAt`, `@UpdatedAt`, `@DeletedAt` and `@Version` name the columns Sequelize adds itself; `@Table` takes `tableName`, `timestamps`, `underscored`, `paranoid`, `schema`, `indexes` and `noPrimaryKey: true` (without it a model that declares no key gets an `id`). An association decorator names its key as the second argument (`@BelongsTo(() => User, 'authorId')`) or in `foreignKey`, and `onDelete` / `onUpdate` sit in the `foreignKey` option (`foreignKey: { name: 'authorId', onDelete: 'CASCADE' }`). The `inverse` option defines the other side: `@BelongsTo(() => User, { foreignKey: 'authorId', inverse: { type: 'hasMany', as: 'posts' } })` reads as a relation with the related name `posts`, and `inverse: 'author'` on a `@HasMany`, `@HasOne` or `@BelongsToMany` names the `belongsTo` or the other half. `through: { model: 'post_tags', timestamps: false }` and `foreignKeyConstraints: false` are read. `sql.uuidV4` (also `.asJavaScript`), ``sql`CURRENT_TIMESTAMP` ``, `sql.fn` and `sql.literal` are defaults. A foreign key that no `onDelete` names gets the default of the generation: Sequelize 7 chooses `SET NULL` for a column that allows null (one that says nothing about `allowNull` does) and `CASCADE` for a required one, whichever association defines the key, where Sequelize 6 chooses `NO ACTION` for a required `belongsTo` key.

The IR keeps model, field and relation names as written (relation names start with a lower-case letter, so the default alias `User` is `user`) and the database names separately, so the default `preserve` naming gives the same tables and columns Sequelize creates.

## Migrations

`--from sequelize` on a folder of `sequelize-cli` migrations replays them into one schema, the way the Laravel reader replays PHP migrations and the SQL reader replays a folder of SQL files. Nothing is run: the `up` function of each file is read from the syntax tree, so no database, no `sequelize-cli` and no `umzug` are needed.

```bash
ormbridge convert -i ./migrations --from sequelize -o ./prisma/schema.prisma
ormbridge convert -i ./my-project --from sequelize -o ./prisma/schema.prisma   # no model files: reads migrations/
```

- **What is read.** `.js`, `.cjs`, `.mjs` and `.ts` files that define `up`: `module.exports = { up, down }` (also `async up()` methods, arrow functions and names declared elsewhere in the file), `exports.up = ...`, `export async function up`, `export const up = ...`, `export default { up }`, and the umzug 3 form `up: async ({ context: queryInterface }) => ...`. `down` is never read. A project root that has model files is read as models and its `migrations` folder is skipped; a project root without model files reads the folder `.sequelizerc` names (`'migrations-path': path.resolve('db', 'migrate')`), or the first of `migrations`, `db/migrations`, `database/migrations`, `src/migrations` and `src/db/migrations` that exists. When models and migrations are passed together, the models win and one warning names the ignored files.
- **Order.** By file name, as `sequelize-cli` (umzug) sorts them, so the timestamp prefix (`20240102000000-create-posts.js`) is the order, whatever order the files are given in.
- **Calls replayed.** `createTable` (columns written as `{ type, allowNull, defaultValue, primaryKey, autoIncrement, unique: true, references }` or as a bare type, the `schema` option and `uniqueKeys`), `dropTable` (a `cascade` option drops the foreign keys that pointed at the table silently), `renameTable`, `addColumn`, `removeColumn`, `renameColumn`, `changeColumn`, `addIndex` (an array of columns or `{ fields }`, with `name`, `unique`, `using`, `type`, `where` and per-column `order` / `length`), `removeIndex` (by name, by columns, or by the name Sequelize derives, `posts_user_id`), `addConstraint` (`unique`, `primary key`, `foreign key` over one column, and `default`) and `removeConstraint` (by the name given, or by the name PostgreSQL or MySQL gives an inline constraint: `posts_author_id_fkey`, `users_email_key`, `users_pkey`, `posts_ibfk_1`). A rename carries the indexes, constraints and the foreign keys of other tables that use the table or column; `removeColumn` drops the indexes and constraints that include the column.
- **Reading the calls.** The table name is a string, a constant, or `{ tableName, schema }`. A `queryInterface.sequelize.transaction(async (t) => { ... })` callback, `Promise.all([...])` of calls, `.then(() => ...)` chains, `try` blocks (the body runs; the `catch` only undoes it), helper functions declared in the same file that receive the query interface, and arrow functions that return the call are followed. The query interface may be called anything (`qi`, or `context`).
- **The result.** One model per table the migrations leave, named after the table (`blog_posts` becomes `BlogPost`, `Users` `User`; a clash gets a number) with the database's own table and column names: no `id` and no `createdAt` / `updatedAt` are added, because a migration lists every column it creates. A column with `references` is a relation named after it (`userId` and `user_id` become `user`, a name without an `_id` stays as it is), with the `onDelete` / `onUpdate` the migration wrote (none is `NO ACTION`). A table without a primary key gets the usual warning.

What does not fit is reported, with the file, line, table and column where there is one:

- `20240103-add-columns.js:12: addColumn "nope", column "x": the table does not exist at this point; the statement was skipped.` The same sentence ends the warnings for an unknown table, column, index or constraint, a name that is taken (`createTable`, `renameTable`, `renameColumn`, `addIndex`) and a table or column name that cannot be read statically.
- `Skipped 3 data statements (first at 20240106-seed.js:14): row data is not part of the schema.` for `bulkInsert`, `bulkUpdate`, `bulkDelete`, `insert`, `update`, `upsert` and `delete`; `Skipped 2 raw SQL queries (first at 20240107-views.js:9, tables: posts, authors): raw SQL is not replayed, so the schema may differ from the real database.` for `queryInterface.sequelize.query(...)`; and `Skipped 2 createFunction calls (first at ...)` for any other call that changes the database but not the schema this reader holds (`createFunction`, `createTrigger`, `dropEnum`, ...). `describeTable`, `showAllTables`, `createSchema` and the other calls that only look are silent.
- `20240110-flags.js:5: a conditional contains schema changes; it was applied as if it always ran (tables: authors), so the result may differ from the real database.` for `if`, `switch` and loops. `Promise.all(list.map(...))` over a computed list is reported as calls made from a list computed at run time.
- `changeColumn` replaces the attributes the call names (the type always) and keeps the rest, which is what SQLite does; PostgreSQL drops a default the call leaves out and MySQL resets nullability too. A call that leaves out an `allowNull` or `defaultValue` the column has says so in a warning.
- `unique: 'name'` on a column does nothing in a migration (`queryInterface` only reads `unique: true`), a check constraint and a foreign key over several columns are not part of the shared model, and an index on an expression or with a `where` condition loses the expression or the condition; each is reported.

The replay is checked against the real tool: the tests run the fixture migrations with `sequelize-cli db:migrate` on SQLite and compare the database it ends with (tables, column types, defaults, nullability, keys, indexes and foreign key actions) with the replay (see [test/README.md](../../test/README.md)). SQLite rebuilds a table for `renameColumn`, `changeColumn` and `removeColumn` and loses foreign key actions and some unique keys when it does, so those calls are checked on tables without keys; the unit tests replay them everywhere.

## Writing

`--to sequelize` writes Sequelize models: one file per model plus an `index` file, so `-o` is a directory (`models/`). `--style` picks the generation and the layout: `init` (the default) and `define` are Sequelize 6, `v6` is another name for `init`, and `v7` writes Sequelize 7 decorators; any other value fails with `Invalid --style value "..." for the sequelize format. Expected one of: init, define, v6, v7.`

### `--style init` (default): TypeScript

```ts
// models/post.ts
export class Post extends Model<
  InferAttributes<Post>,
  InferCreationAttributes<Post>
> {
  declare id: CreationOptional<number>;
  declare title: string;
  declare author_id: number;
  declare author?: NonAttribute<User>;

  static initModel(sequelize: Sequelize): typeof Post {
    Post.init(
      {
        id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
        title: { type: DataTypes.STRING(200), allowNull: false },
        author_id: { type: DataTypes.INTEGER, allowNull: false },
      },
      {
        sequelize,
        modelName: 'Post',
        tableName: 'blog_post',
        timestamps: false,
      }
    );
    return Post;
  }
}
```

```ts
// models/index.ts
export function initModels(sequelize: Sequelize) {
  Post.initModel(sequelize);
  User.initModel(sequelize);

  Post.belongsTo(User, {
    as: 'author',
    foreignKey: 'author_id',
    onDelete: 'CASCADE',
  });
  User.hasMany(Post, {
    as: 'posts',
    foreignKey: 'author_id',
    onDelete: 'CASCADE',
  });

  return { Post, User };
}
```

Fields are typed with `declare` (`CreationOptional` for a column with a default, an auto-increment key or a nullable column, `| null` for nullable ones, a string-literal union for an enum), and each association is declared as `NonAttribute<...>`. Cross-file references are `import type`, so the circular imports vanish when the code is compiled. The files import with a `.js` extension (compile with `tsc`, or run them with `tsx`). `initModels(sequelize)` runs every `initModel` and then the associations, in the order of the schema.

### `--style define`: `sequelize-cli` files

```js
// models/post.js
module.exports = (sequelize, DataTypes) => {
  const Post = sequelize.define('Post', { ... }, { tableName: 'blog_post', timestamps: false });

  Post.associate = (models) => {
    Post.belongsTo(models.User, { as: 'author', foreignKey: 'author_id', onDelete: 'CASCADE' });
  };

  return Post;
};
```

The CommonJS layout `sequelize-cli` generates: a factory per file with `sequelize.define` and an `associate(models)` function (written only when the model has associations). `models/index.js` exports `initModels(sequelize)`, which requires every file, defines the models and runs the `associate` functions. The files use `module.exports`, so a project with `"type": "module"` needs a `package.json` with `"type": "commonjs"` in the folder.

### `--style v7`: Sequelize 7 decorators

```ts
// models/post.ts
@Table({ tableName: 'blog_post', timestamps: false })
export class Post extends Model<
  InferAttributes<Post>,
  InferCreationAttributes<Post>
> {
  @Attribute(DataTypes.INTEGER)
  @PrimaryKey
  @AutoIncrement
  declare id: CreationOptional<number>;

  @Attribute(DataTypes.STRING(200))
  @NotNull
  declare title: string;

  @Attribute(DataTypes.INTEGER)
  @NotNull
  declare author_id: number;

  @BelongsTo(() => User, {
    foreignKey: { name: 'author_id', onDelete: 'CASCADE' },
    inverse: { type: 'hasMany', as: 'posts' },
  })
  declare author?: NonAttribute<User>;
}
```

```ts
// models/index.ts
export { Post, User };

/** Every model of the schema, for new Sequelize({ dialect, models }). */
export const models = [Post, User];
```

Needs `@sequelize/core` 7 and the package of the dialect (`@sequelize/postgres`, `@sequelize/mysql`, `@sequelize/sqlite3` or `@sequelize/mssql`, chosen by `--provider` and named in the comment of `index.ts`) and TypeScript with `experimentalDecorators`. Sequelize 7 is an alpha release at the time of writing; the output is checked against `7.0.0-alpha.48`.

- **Columns** are `@Attribute(DataTypes.X)` with `@PrimaryKey`, `@AutoIncrement`, `@NotNull`, `@Unique` / `@Unique('name')`, `@Default(...)` and `@ColumnName('column')`. The `createdAt` and `updatedAt` columns Sequelize adds itself are `@CreatedAt` / `@UpdatedAt` properties (which also name them, so no `createdAt: 'created_on'` option is written).
- **Relations** are declared once, on the model that holds the key: `@BelongsTo` whose `inverse` option defines the other side, which is a typed `declare` property on the other class. `onDelete` is always written, `onUpdate` only when it is not `CASCADE`, both inside `foreignKey`. A relation without a related name has no `inverse`. A self reference is declared from the `@HasMany` / `@HasOne` side (`inverse: 'parent'`), because Sequelize 7 cannot build the inverse of a self-referencing `@BelongsTo`. A many-to-many is one `@BelongsToMany` with `through: { model, timestamps: false }`, `foreignKey`, `otherKey` and `inverse`; a self-referencing one needs two different names, so it gets an `<alias>Inverse` property (with a warning) and `throughAssociations` names, which Sequelize 7 otherwise defines twice.
- **SQLite.** The Sequelize 7 SQLite dialect has no `BIGINT`, `DECIMAL` or `CHAR`: `bigInt` and `duration` columns are written as `INTEGER` (SQLite integers have 64 bits) and decimals as `DOUBLE` with a warning that the column is not exact. The other providers keep `BIGINT` and `DECIMAL(p, s)`, which are checked against real PostgreSQL 16 and MySQL 8 servers.
- **MySQL.** The dialect refuses a `DECIMAL` without precision, so a decimal with no digits recorded is written as `DECIMAL(10, 0)` (the MySQL default) with a warning. A `schema` is another database in MySQL, which Sequelize would name in every query, so it is ignored with a warning; `using` other than `BTREE` / `HASH` is dropped, and an index over a JSON column (or an array, which is written as JSON) is skipped, each with a warning.
- **Model without a key.** `@Table({ noPrimaryKey: true })`, where Sequelize 6 uses `removeAttribute('id')`.
- A database default expression is `sql.literal('...')` (imported from `@sequelize/core`). Class names that the file imports (`Table`, `Default`, `Unique`, ...) get a `Model` suffix with a warning.

### Options

| Option               | Effect                                                                                                                                                                                                                                                                                                                           |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--style <name>`     | `init` (default), `define`, `v6` (the same as `init`) or `v7`, as above.                                                                                                                                                                                                                                                         |
| `--provider <name>`  | Picks the data types (below). `postgresql` is the default; `cockroachdb` uses the `postgres` dialect through the `sequelize-cockroachdb` package (the generated `index` file says how to create the instance) with warnings for hstore, ranges, sequential keys and index methods; `mongodb` warns and is written as PostgreSQL. |
| `--naming preserve`  | Default. Keeps the table names (`tableName`), column names (`field`) and the attribute names of the source, so the models describe the existing database.                                                                                                                                                                        |
| `--naming normalize` | Fresh-schema style: singular snake_case tables, UUID keys instead of auto-increment ids, `created_at` / `updated_at`, camelCase attributes over snake_case columns (`underscored: true`).                                                                                                                                        |

### What is written

- **Names.** `modelName` and the class are the model name in PascalCase (`legacy_order` becomes `LegacyOrder`); a name the generated files use (`Model`, `Models`, `Sequelize`, ...) gets a `Model` suffix with a warning. Files are named after the model in camelCase (`postTags.ts`). Every table is an explicit `tableName` (and `schema` when the model has one; SQLite has no schemas, so it is dropped with a warning), so Sequelize's pluralization never matters. An attribute keeps the name of the IR field and gets `field: 'column'` when its column differs. When most camelCase attributes of a model already map onto their snake_case columns, the model gets `underscored: true` and only the exceptions need a `field`; `normalize` always uses `underscored: true`. A name that is not a JavaScript identifier is repaired with a warning (`first-name` becomes `first_name`, with `field: 'first name'`).
- **Types.** `STRING(n)`, `TEXT`, `INTEGER`, `BIGINT`, `DOUBLE`, `DECIMAL(p, s)`, `BOOLEAN`, `DATE`, `DATEONLY`, `TIME`, `UUID`, `BLOB` and `ENUM('a', 'b')` (the stored values). A string without a length is `TEXT`, because Sequelize has no unbounded `VARCHAR`; it is `STRING` (255) when the column is a key, unique or indexed, since MySQL cannot index `TEXT`. `JSON` columns are `JSONB` on PostgreSQL and `JSON` elsewhere (`TEXT` with a warning for SQL Server, which has no JSON type before 2025). PostgreSQL also gets `ARRAY(type)` (nested for several dimensions), `INET`, `HSTORE`, `RANGE(type)` and the `GEOMETRY`, `GEOGRAPHY`, `CIDR`, `MACADDR`, `TSVECTOR` and `CITEXT` columns that Unsupported types name; on the other dialects an array or hstore becomes `JSON` (or `TEXT`), an `INET` a `STRING(45)`, a range `TEXT`, each with a warning. Durations have no Sequelize type and are `BIGINT` microseconds with a warning; a generated column is written as a regular one with a warning. SQL Server enums are written as `STRING` with a warning, because Sequelize's ENUM there is a `CHECK` constraint that loses `NOT NULL` and the default.
- **Keys and constraints.** `primaryKey` (several for a composite key), `autoIncrement` on a single integer key (a big-integer key on SQLite is written as `INTEGER`, the only type SQLite lets count), `allowNull: false`, `unique: true` (or the constraint name), and `indexes: [{ fields, unique, name, using, type }]` for composite unique constraints and indexes, with column names, `order`, `length` and `operator` for the per-column options. `using` is written for PostgreSQL and MySQL, `FULLTEXT` for MySQL; elsewhere they are dropped with a warning. A model with no primary key gets `removeAttribute('id')`, because Sequelize would add an `id` column (a keyless model that has an `id` column gets `primaryKey: true` on it instead, because Sequelize refuses such a model).
- **Defaults.** Literals, `DataTypes.NOW`, `DataTypes.UUIDV4` (`UUIDV1` for version 1), an enum value by its stored value, JSON as an object literal and `Sequelize.literal('...')` for a database expression (in parentheses for SQLite and MySQL, which require them). `cuid()`, `ulid()` and similar client-generated defaults are dropped with a warning, and so is an auto-increment default that is not a single integer key. Sequelize generates `NOW` and `UUIDV4` defaults in JavaScript, not in the database.
- **Timestamps.** A required date-time column named like `created_at` / `createdAt` (and a required auto-updated date-time column) becomes Sequelize's own timestamp: `timestamps: true`, with `createdAt: 'created_at'` / `updatedAt: 'updated_at'` when the name is not the default and `createdAt: false` / `updatedAt: false` for the one that is missing. The `define` style leaves the column out of the attributes; the `init` style lists it as `{ type: DataTypes.DATE, allowNull: false }`, because the TypeScript types want every declared property there. A `now` default on the created column is not written (Sequelize sets it in JavaScript; this is the one difference the [conversion matrix](../CONVERSION_MATRIX.md) shows for every format written to Sequelize). A nullable timestamp, or one with another default or a unique flag, is declared as an ordinary attribute next to the option. Without such columns the model has `timestamps: false`. `paranoid` (soft delete) is never written: a `deleted_at` column is an ordinary nullable column.
- **Associations.** Every relation is written with its foreign key column declared on the model (type taken from the key it references, `allowNull`, `field`) and an explicit `as`, `foreignKey` and `onDelete` (`CASCADE`, `SET NULL`, `RESTRICT`, `NO ACTION`, `SET DEFAULT`): `belongsTo` on the model that holds the key and, when the IR has a related name, `hasMany` (`hasOne` for a one-to-one relation, whose column is `unique: true`) on the other side. `onUpdate` is written only when it is not `CASCADE`, which Sequelize adds anyway. A relation to a column other than the primary key uses `targetKey` / `sourceKey`. A relation without a related name has no reverse association (the other emitters invent one such as `post_set`). Self references and several relations to the same model work through the aliases. A key that is a relation is the `primaryKey` of its column. A relation to a model that is not in the schema, or to one without a single-column primary key, is skipped with a warning, and composite foreign keys are not written.
- **Many-to-many.** A many-to-many relation is a `belongsToMany` with `through: '<owner table>_<relation>'` and `timestamps: false`, so Sequelize creates the join table (a composite primary key of the two keys, `<model>_id` columns, `from_` / `to_` for a self reference), plus the other half when the IR has a related name. An explicit join model (Prisma) is an ordinary model with two foreign keys.
- **Warnings** name the model and field, as in the other writers: generated columns, durations and ranges outside PostgreSQL, unsupported database types, client-generated defaults, views (written as models, but `sync()` would create a table), `@@ignore`, composite foreign keys, enum database schemas, clustered indexes and anything else Sequelize cannot express.

The output assumes the Sequelize instance uses the library's defaults for `define` (for example no `define: { underscored: true }`), since each model states its own `tableName`, `timestamps` and `underscored`.

Reading the output back with `--from sequelize` gives the same schema, apart from the differences listed in the [conversion matrix](../CONVERSION_MATRIX.md): the `now` default of a created timestamp, enum names (an enum is named after the model and attribute), a string without a length (read back as `text`, or as 255 characters for a key), durations (read back as big integers) and the owner of a many-to-many relation, which is the side whose association comes first (the `init` style keeps the schema order; in the `define` style it is the file that sorts first).

## Limitations and warnings

Warnings appear on stderr as `warning: <file>: model "<Model>", field "<field>": ...`. Real examples:

- `Order: the association uses constraints: false, so there is no foreign key in the database; the column is read as a plain column.`
- `Account: DataTypes.VIRTUAL has no database column, so the field was skipped.`
- `Person: the join table "friendships" (columns person_id, friend_id) of Person.belongsToMany(Person) is not preserved by name; formats that derive join tables will use "people_friends" (columns from_person_id, to_person_id).` A many-to-many has no join table of its own in the shared model; the other formats derive the table and the columns from the two models.
- `User.hasOne(Profile) does not make "userId" unique, so the relation was read as a foreign key; add unique: true to the column for a one-to-one relation.`
- `Post: hooks, scopes are not part of the database schema and were ignored.` Getters, setters, hooks, scopes and default scopes are behaviour, not schema, and are ignored; validators and table options such as `comment` and `engine` are ignored silently.
- Not read, each with a warning: models built in loops or functions, computed model or table names, attribute sets returned by functions, `scope` (polymorphic associations), index expressions (`Sequelize.literal`), `where` conditions of indexes, geometry and similar PostgreSQL types (`GEOMETRY`, `CIDR`, `MACADDR`, `TSVECTOR`), and associations whose models are not in the input (a `belongsTo` target becomes a stub model).
- Sequelize-specific behaviour that the reader repeats: a column that the model declares without `allowNull` does not count as "allows null" when the default `ON DELETE` is chosen (`NO ACTION` for `belongsTo`, `CASCADE` for `hasMany`); the `uniqueKeys` option replaces the unique constraints named on attributes (a warning says so); the `indexes` option of `@Table` replaces the `@Index` decorators of sequelize-typescript.
- `Sequelize.useInflection()` (custom plural rules) and models registered only at run time (`sequelize.addModels(path)`, `Object.keys(models).forEach(...)`) are not seen. Migrations are replayed only from a folder of migrations (see [Migrations](#migrations)); a database that was changed outside them, or by raw SQL, differs from the replay.
- Sequelize 7 is read by its decorators and its `Model.init` / association-call form; `Sequelize.addModels` with a path, `sequelize.models` built in loops and the `sql` template with substitutions are not seen, and `@sequelize/core` options that have no column (`hooks`, scopes, `validate`) are ignored like their Sequelize 6 counterparts.

The timestamps Sequelize fills in itself are recorded without a database default, so writing them to GORM or Laravel (whose readers see `created_at` as having one) shows that one difference in the [conversion matrix](../CONVERSION_MATRIX.md), and so does writing a `now` default to Sequelize. See [sequelize to prisma](../CONVERSION_MATRIX.md#sequelize--prisma), [sequelize to django](../CONVERSION_MATRIX.md#sequelize--django), [sequelize to typeorm](../CONVERSION_MATRIX.md#sequelize--typeorm), [sequelize to sql](../CONVERSION_MATRIX.md#sequelize--sql) and [what sequelize cannot express](../CONVERSION_MATRIX.md#what-sequelize-cannot-express).

The reader and the writer are checked against the real libraries: when `SEQUELIZE7_DIR` points at an install of `@sequelize/core` 7 and `@sequelize/sqlite3` (and `typescript`), the tests compile the Sequelize 7 fixtures and the models `--style v7` writes (the same schemas as below, both naming modes) with `tsc --strict`, define them with `new Sequelize({ dialect: SqliteDialect, models })`, create the tables with `sync()` and compare tables, columns, nullability, keys, indexes, foreign keys and associations with the IR. With `@sequelize/postgres` and `@sequelize/mysql` installed too, and `SQL_POSTGRES_URL` / `SQL_MYSQL_URL` set, the same fixtures and the output of `--style v7 --provider postgresql` / `mysql` are synced into a scratch database of a real PostgreSQL 16 and MySQL 8 server and read back from the catalogs: besides the SQLite comparison they check the column types (real `BIGINT` and `DECIMAL(p,s)`, string lengths, enum members) and defaults. SQL Server is not run. When `SEQUELIZE_DIR` points at an install of `sequelize@6` and `sqlite3`, the tests load every fixture (and every model the writer generates for the canonical schema, the extras and two IR fixtures, in both styles and both naming modes), create the tables in SQLite with `sequelize.sync()` and compare tables, columns, nullability, keys, indexes and foreign keys with the IR; the writer's models are also given sample rows, so defaults, enums, foreign key actions and associations (including many-to-many) are exercised (see [test/README.md](../../test/README.md)).

## Programmatic API

```ts
import {
  convertText,
  emitSequelize,
  parseSequelize,
  type ConvertResult,
  type IrSchema,
  type MultiFileEmitOutput,
  type Result,
} from 'ormbridge';

declare const userModel: string;
declare const postModel: string;
declare const prismaText: string;

// Sequelize -> Prisma, in memory.
const converted: Result<ConvertResult> = await convertText(
  [
    { path: 'models/user.js', text: userModel },
    { path: 'models/post.js', text: postModel },
  ],
  {
    from: 'sequelize',
    to: 'prisma',
    naming: 'preserve',
    provider: 'postgresql',
    header: true,
    autoField: 'int',
  }
);
if (converted.ok) {
  console.log(converted.value.output); // schema.prisma text
} else {
  console.error(`${converted.error.code}: ${converted.error.message}`);
}

// Lower level.
const parsed: Result<IrSchema> = await parseSequelize(
  [{ path: 'models/user.js', text: userModel }],
  { appLabel: 'app' }
);
if (parsed.ok) {
  console.log(parsed.value.models.map((model) => model.tableName));
  console.log(parsed.value.warnings);
}
```

`parseSequelize` returns a `Result` and never throws: a file without models is an error with the code `NO_MODELS_FOUND`, and constructs it cannot read are warnings in `schema.warnings`.

```ts
// Prisma -> Sequelize, in memory: `files` maps each path to its text.
const written: Result<ConvertResult> = await convertText(
  [{ path: 'schema.prisma', text: prismaText }],
  {
    from: 'prisma',
    to: 'sequelize',
    naming: 'preserve',
    provider: 'postgresql',
    header: true,
    autoField: 'int',
    style: 'init', // or 'define', 'v6' or 'v7'
  }
);
if (written.ok) {
  for (const [path, text] of Object.entries(written.value.files ?? {})) {
    console.log(path, text.length); // post.ts, user.ts, ..., index.ts
  }
}

// Lower level: emitSequelize takes an IrSchema and does not throw.
declare const schema: IrSchema;
const output: MultiFileEmitOutput = emitSequelize(schema, {
  provider: 'postgresql',
  naming: 'preserve',
  style: 'define',
});
console.warn(output.warnings);
```

`emitSequelize` returns the files and the warnings. A style the format does not have is rejected by the format adapter (`convertText`, the CLI, the config file) with `INVALID_OPTION` and the valid values; `checkStyle(format, value)` is exported for callers that want the same check.
