# Sequelize

ormbridge reads Sequelize 6 models (`ormbridge formats` lists `sequelize` as `read`). It cannot write Sequelize models yet. It claims no file extension, because `.js` and `.ts` are too generic: always pass `--from sequelize`. Without it a `.js` or `.ts` input is read as Django and fails with `No concrete Django models were found in: ...`. The models are parsed statically with tree-sitter; nothing is imported or run, so no Node project, `sequelize` install or database is needed.

Three ways of defining models are read:

- `sequelize.define('Name', { ...attributes }, { ...options })`, including the factory that `sequelize-cli` generates (`module.exports = (sequelize, DataTypes) => { const X = sequelize.define(...); X.associate = ...; return X; }`).
- `class X extends Model {}` with `X.init({ ...attributes }, { sequelize, modelName, tableName })`, in JavaScript or TypeScript, also from a static method (`this.init(...)`, `super.init(...)`).
- sequelize-typescript: classes decorated with `@Table`, with `@Column`, `@PrimaryKey`, `@ForeignKey`, `@BelongsTo` and the other decorators.

Sequelize 7 (`@sequelize/core` with `@Attribute` decorators) is not supported yet.

## Try it

The example in [`examples/sequelize`](../../examples/sequelize/) has one conversion in `ormbridge.config.json`:

```bash
cd examples/sequelize
npx ormbridge convert            # reads models/ and writes prisma/schema.prisma
npx ormbridge convert --check
```

| Conversion       | Input    | Output                 |
| ---------------- | -------- | ---------------------- |
| `from-sequelize` | `models` | `prisma/schema.prisma` |

`models/` is the one hand-written folder among the examples: five model files in the layout `sequelize-cli` generates, plus its `index.js` loader. Inside this repository run `node ../../dist/cli.js convert` after `npm run build`. Without the config file: `ormbridge convert -i models -f sequelize -t prisma -o prisma/schema.prisma`.

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

Not supported yet. `--to sequelize` fails with `The format "sequelize" can only be used as an input`. Use the [conversion matrix](../CONVERSION_MATRIX.md) to see what survives when Sequelize models are written to every other format.

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

The timestamps Sequelize fills in itself are recorded without a database default, so writing them to GORM or Laravel (whose readers see `created_at` as having one) shows that one difference in the [conversion matrix](../CONVERSION_MATRIX.md). See [sequelize to prisma](../CONVERSION_MATRIX.md#sequelize--prisma), [sequelize to django](../CONVERSION_MATRIX.md#sequelize--django), [sequelize to typeorm](../CONVERSION_MATRIX.md#sequelize--typeorm), [sequelize to sql](../CONVERSION_MATRIX.md#sequelize--sql) and [what sequelize cannot express](../CONVERSION_MATRIX.md#what-sequelize-cannot-express).

The reader is checked against the real library: when `SEQUELIZE_DIR` points at an install of `sequelize@6` and `sqlite3`, the tests load every fixture, create the tables in SQLite with `sequelize.sync()` and compare tables, columns, nullability, keys, indexes and foreign keys with what the parser read (see [test/README.md](../../test/README.md)).

## Programmatic API

```ts
import {
  convertText,
  parseSequelize,
  type ConvertResult,
  type IrSchema,
  type Result,
} from 'ormbridge';

declare const userModel: string;
declare const postModel: string;

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
