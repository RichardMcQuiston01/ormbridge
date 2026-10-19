# Sequelize

ormbridge reads and writes Sequelize 6 models (`ormbridge formats` lists `sequelize` as `read + write`). It claims no file extension, because `.js` and `.ts` are too generic: always pass `--from sequelize` (or `--to sequelize`). Without it a `.js` or `.ts` input is read as Django and fails with `No concrete Django models were found in: ...`. The models are parsed statically with tree-sitter; nothing is imported or run, so no Node project, `sequelize` install or database is needed.

Three ways of defining models are read:

- `sequelize.define('Name', { ...attributes }, { ...options })`, including the factory that `sequelize-cli` generates (`module.exports = (sequelize, DataTypes) => { const X = sequelize.define(...); X.associate = ...; return X; }`).
- `class X extends Model {}` with `X.init({ ...attributes }, { sequelize, modelName, tableName })`, in JavaScript or TypeScript, also from a static method (`this.init(...)`, `super.init(...)`).
- sequelize-typescript: classes decorated with `@Table`, with `@Column`, `@PrimaryKey`, `@ForeignKey`, `@BelongsTo` and the other decorators.

Sequelize 7 (`@sequelize/core` with `@Attribute` decorators) is not supported yet.

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

- **Input.** A file or a directory. In a directory every `.js`, `.cjs`, `.mjs` and `.ts` file is read except `*.d.ts`, `*.test.*` and `*.spec.*`, and models are picked out of them; loaders such as `models/index.js` define nothing and are ignored. Directory walks skip `node_modules`, `dist`, `build`, `coverage`, `.git` and the `sequelize-cli` directories `migrations`, `seeders` and `config`. A file that is named explicitly is always read. Several files are merged, so associations may point at models in other files, and an attribute set that is a `const` (or imported from another input file) is followed.
- **Names.** The model name is the first argument of `define`, the `modelName` option, or the class name (PascalCase when written as `blog_post`). The table is `tableName`, or Sequelize's plural of the model name (`PostTag` becomes `PostTags`, `Person` `People`), snake_cased with `underscored`, left alone with `freezeTableName`. The plural rules are those of the `inflection` package Sequelize uses. An attribute's column is its `field`, or the attribute name (snake_case with `underscored`).
- **Columns.** `DataTypes.STRING(n)` / `CHAR(n)` (255 without a length), `TEXT`, `INTEGER` and the other widths, `BIGINT`, `FLOAT` / `REAL` / `DOUBLE`, `DECIMAL(p, s)`, `BOOLEAN`, `DATE`, `DATEONLY`, `TIME`, `UUID`, `JSON` / `JSONB`, `BLOB`, `ENUM(...)`, `ARRAY(type)`, `RANGE(type)`, `INET` and `HSTORE`, written as `DataTypes.X`, `DataType.X`, `Sequelize.X` or a bare name, with `.UNSIGNED` and similar flags, either as `{ type: DataTypes.X }` or as the bare type. `primaryKey`, `autoIncrement`, `allowNull` (columns are nullable unless `allowNull: false`), `unique` (`true`, a name, or `{ name, msg }`; a name shared by several attributes is a composite unique constraint), `defaultValue`, `field`, `references` and `onDelete` / `onUpdate`.
- **Defaults.** Literals, `DataTypes.NOW` (`now`), `DataTypes.UUIDV4` / `UUIDV1` (generated UUID), objects and arrays on JSON columns, enum values, and `Sequelize.fn('now')` / `Sequelize.literal('...')` (a database expression, or `now` / a literal when it is one). Sequelize generates `NOW` and `UUIDV4` defaults in JavaScript, not in the database; they are recorded as defaults all the same. A function default (`() => ...`, `new Date()`) is dropped with a warning.
- **Generated columns.** Sequelize adds an `id` (integer, auto-increment, primary key) when no attribute is a primary key, and `createdAt` / `updatedAt` as non-null date-time columns (the second one auto-updated) unless `timestamps: false`. `createdAt`, `updatedAt` and `deletedAt` can be renamed or turned off, `paranoid` adds a nullable `deletedAt`, and `version` adds an integer column. An attribute you declare under the same name replaces the generated one, as in Sequelize. `new Sequelize(..., { define: { ... } })` supplies the defaults of `underscored`, `timestamps`, `freezeTableName`, `paranoid` and the timestamp names.
- **Options.** `tableName`, `modelName`, `freezeTableName`, `timestamps`, `paranoid`, `underscored`, `schema`, `indexes` (`fields`, `unique`, `name`, `using`, `type`) and `uniqueKeys`. Index fields may be attribute or column names.
- **Associations.** `hasMany`, `hasOne`, `belongsTo` and `belongsToMany` with `as`, `foreignKey` (a name or `{ name, allowNull, field }`), `otherKey`, `sourceKey`, `targetKey`, `onDelete`, `onUpdate`, `constraints` and `through`, written at the top level, inside `associate(models)` functions or static methods (`this.hasMany(...)`), on `models.Post`, `sequelize.models.Post` or `sequelize.model('Post')`. The reader applies them the way Sequelize does when `associate` runs: the foreign key column is added to the model that holds it (or completed when the model already declares it), with Sequelize's default name (`<as>Id`, or `<Model>Id` for `hasMany`), type, `ON DELETE` and `ON UPDATE CASCADE`. The column becomes the relation of the shared model rather than a separate field; a `hasMany` or `hasOne` on the same column as a `belongsTo` gives its reverse name. A string `through` becomes a many-to-many relation (the two `belongsToMany` calls over one table are one relation), a `through` model stays an ordinary model that receives the two key columns.
- **sequelize-typescript.** `@Table({ ... })` (also bare), `@Column(DataType.X)` / `@Column({ type, allowNull, ... })` (without a type, `@Column` takes it from the TypeScript type), `@PrimaryKey`, `@AutoIncrement`, `@AllowNull`, `@NotNull`, `@Unique`, `@Default`, `@Comment`, `@CreatedAt` / `@UpdatedAt` / `@DeletedAt`, `@Index`, `@ForeignKey(() => Model)` (which also finds the key of `@BelongsTo`, `@HasMany`, `@HasOne` and `@BelongsToMany` when none is named), and the association decorators with their option, string and `through` forms. The property name is the alias, as in sequelize-typescript.

The IR keeps model, field and relation names as written (relation names start with a lower-case letter, so the default alias `User` is `user`) and the database names separately, so the default `preserve` naming gives the same tables and columns Sequelize creates.

## Writing

`--to sequelize` writes Sequelize 6 models: one file per model plus an `index` file, so `-o` is a directory (`models/`). `--style` picks the layout; any other value fails with `Invalid --style value "..." for the sequelize format. Expected one of: init, define.`

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

### Options

| Option               | Effect                                                                                                                                                                                                                                                                                                                           |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--style <name>`     | `init` (default) or `define`, as above.                                                                                                                                                                                                                                                                                          |
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
- `Sequelize.useInflection()` (custom plural rules), models registered only at run time (`sequelize.addModels(path)`, `Object.keys(models).forEach(...)`) and `sequelize-cli` migrations are not seen. Replaying migrations to rebuild a schema, as the Laravel reader does, is not supported yet.

The timestamps Sequelize fills in itself are recorded without a database default, so writing them to GORM or Laravel (whose readers see `created_at` as having one) shows that one difference in the [conversion matrix](../CONVERSION_MATRIX.md), and so does writing a `now` default to Sequelize. See [sequelize to prisma](../CONVERSION_MATRIX.md#sequelize--prisma), [sequelize to django](../CONVERSION_MATRIX.md#sequelize--django), [sequelize to typeorm](../CONVERSION_MATRIX.md#sequelize--typeorm), [sequelize to sql](../CONVERSION_MATRIX.md#sequelize--sql) and [what sequelize cannot express](../CONVERSION_MATRIX.md#what-sequelize-cannot-express).

The reader and the writer are checked against the real library: when `SEQUELIZE_DIR` points at an install of `sequelize@6` and `sqlite3`, the tests load every fixture (and every model the writer generates for the canonical schema, the extras and two IR fixtures, in both styles and both naming modes), create the tables in SQLite with `sequelize.sync()` and compare tables, columns, nullability, keys, indexes and foreign keys with the IR; the writer's models are also given sample rows, so defaults, enums, foreign key actions and associations (including many-to-many) are exercised (see [test/README.md](../../test/README.md)).

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
    style: 'init', // or 'define'
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
