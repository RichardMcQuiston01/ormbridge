# Entity Framework Core

ormbridge reads Entity Framework Core (EF Core) models written in C# (`ormbridge formats` lists `efcore` as `read`). It cannot write EF Core models yet. It claims no file extension, because `.cs` is far too generic: always pass `--from efcore`. Without it a `.cs` input is read as Django and fails with `No concrete Django models were found in: ...`. The C# is parsed statically with tree-sitter; nothing is compiled or run, so no .NET SDK, NuGet package or database is needed.

An EF Core model is spread over three places, and ormbridge reads all of them:

- **Entity classes** with data annotations (`[Table]`, `[Key]`, `[Column]`, `[Required]`, `[MaxLength]`, `[ForeignKey]`, `[Index]`, ...) and properties.
- **The `DbContext`**: `DbSet<T>` properties and `OnModelCreating` with the fluent API (`modelBuilder.Entity<T>(...)`).
- **`IEntityTypeConfiguration<T>` classes**, applied with `modelBuilder.ApplyConfiguration(new X())` or `ApplyConfigurationsFromAssembly`.

Target: EF Core 5 and later. The reader is checked against EF Core 8 (see the end of this page).

## Try it

The example in [`examples/efcore`](../../examples/efcore/) has one conversion in `ormbridge.config.json`:

```bash
cd examples/efcore
npx ormbridge convert            # reads models/ and writes prisma/schema.prisma
npx ormbridge convert --check
```

| Conversion    | Input    | Output                 |
| ------------- | -------- | ---------------------- |
| `from-efcore` | `models` | `prisma/schema.prisma` |

`models/` is a hand-written folder: entity classes, a base class, an enum, a configuration class and the context. Inside this repository run `node ../../dist/cli.js convert` after `npm run build`. Without the config file: `ormbridge convert -i models -f efcore -t prisma -o prisma/schema.prisma`.

## Reading

- **Input.** A file or a directory. In a directory every `.cs` file is read except `*.Designer.cs`, `*.g.cs`, `*.generated.cs` and `*ModelSnapshot.cs`, and the directories `Migrations`, `bin`, `obj`, `packages`, `node_modules`, `.vs` and `.git` are skipped, because migrations restate the model as history. A file that is named explicitly is read, except that a path inside `Migrations/`, `bin/` or `obj/` or a designer or snapshot file is skipped with a warning. Several files are merged, so a navigation may point at an entity in another file. Namespaces are ignored: types are matched by their simple name, and a second class with the same name is skipped with a warning (`partial` classes are merged).
- **Which classes are entities.** A class used in a `DbSet<T>` property of a `DbContext` (also one that derives from `IdentityDbContext<...>` or another context), named by `modelBuilder.Entity<T>()`, `HasOne<T>()` or an `IEntityTypeConfiguration<T>`, reached through a navigation property of another entity, or marked with a data annotation that only EF Core reads (`[Table]`, `[Index]`, `[PrimaryKey]`, `[Keyless]`, or `[Key]`, `[ForeignKey]`, `[InverseProperty]`, `[DatabaseGenerated]`, `[Column]`, `[Timestamp]` on a property). `[Required]`, `[MaxLength]` and `[StringLength]` alone do not make a class an entity. Abstract classes and base classes without a `DbSet` are not entities: their properties are mapped into the classes that derive from them, as in EF Core.
- **Properties.** Public properties with a getter and a setter (any accessibility, `init` too) are columns. Static, computed (`=>`), get-only and field members, `[NotMapped]` properties and `Ignore()` are not. Positional `record` parameters are properties. A generic base class (`Entity<TKey>`) has its type parameters replaced by the arguments of the derived class.
- **Data annotations.** `[Table(name, Schema = ...)]`, `[Column(name, TypeName = ...)]`, `[Key]`, `[PrimaryKey(...)]` (composite), `[Required]`, `[MaxLength]`, `[StringLength]`, `[ForeignKey]` (on the navigation, on the key property, or on a collection), `[InverseProperty]`, `[Index(...)]` (`IsUnique`, `Name`, `IsDescending`, `AllDescending`), `[NotMapped]`, `[DatabaseGenerated]`, `[Timestamp]`, `[ConcurrencyCheck]`, `[Precision]`, `[Comment]`, `[Keyless]`, `[Owned]`, `[ComplexType]`, `[Unicode]`. String arguments may be literals, `nameof(...)`, or constants defined in the input.
- **Fluent API.** In `OnModelCreating` and in `Configure` methods, also inside `modelBuilder.Entity<T>(entity => { ... })`, in variables (`var entity = modelBuilder.Entity<T>();`), in helper methods of the same class and in extension methods of the input: `ToTable(name, schema)`, `ToView`, `HasKey` (composite too), `HasNoKey`, `HasAlternateKey`, `HasIndex` (`IsUnique`, `HasDatabaseName`, `IsDescending`, `HasMethod`), `Property(...)` with `HasColumnName`, `HasColumnType`, `HasMaxLength`, `IsRequired`, `HasPrecision`, `HasDefaultValue`, `HasDefaultValueSql`, `HasComputedColumnSql`, `ValueGeneratedOnAdd` / `OnAddOrUpdate` / `Never`, `HasConversion<string>()` and `HasComment`; `Ignore`; `HasOne` / `HasMany` with `WithOne` / `WithMany`, `HasForeignKey`, `HasPrincipalKey`, `OnDelete(DeleteBehavior.X)`, `IsRequired`, `HasConstraintName` and `UsingEntity`; `OwnsOne`, `ComplexProperty`; `HasDiscriminator`; `HasDefaultSchema`.
- **Conventions.** The key is the property `Id` or `<TypeName>Id` (any case); integer keys count up and `Guid` keys are `uuid` values generated by EF Core. A foreign key is `<Navigation>Id`, `<Navigation><Key>`, `<Type>Id` or `<Type><Key>`; without a matching property EF Core creates a shadow column (`BlogId`), and so does the reader. Two collection navigations are a skip-navigation many-to-many. A relationship is required when its foreign key is not nullable, or, for a shadow key, when the navigation is `[Required]` or not nullable under nullable reference types; required relationships cascade on delete and optional ones use EF Core's `ClientSetNull`, which is `NO ACTION` in the database. The table is named after the `DbSet` property, or the class when there is none, and the column after the property, so the IR keeps C# names (`Title`) unless an attribute or the fluent API renames them.
- **Nullability.** `int?`, `Nullable<int>` and reference types written with `?` allow null. Nullable reference types are on when a file says `#nullable enable` (or any file writes a reference type with `?`); then `string` is required and `string?` optional. Without them every reference type column allows null unless `[Required]` or `IsRequired()` says otherwise. `#nullable disable` turns them off for that file.
- **Types.** `int`, `short`, `byte`, `uint` are `int`; `long` is `bigInt`; `bool`; `decimal` (precision from `[Precision]`, `HasPrecision` or a column type); `double` and `float`; `DateTime` and `DateTimeOffset`; `DateOnly`, `TimeOnly`, `TimeSpan`; `Guid`; `byte[]`; `JsonDocument` / `JsonElement`; `IPAddress`; `string` (a length-limited string with a length, otherwise `text`); `char`; arrays and lists of these as arrays. `HasColumnType("jsonb")` and `[Column(TypeName = "varchar(80)")]` override the type when the name is a known one. Spatial types and `object` are unsupported columns with a warning.
- **Enums.** A C# enum becomes an enum of the shared model. EF Core stores it as an integer unless `HasConversion<string>()` (or `EnumToStringConverter<T>`) is used; an integer-stored enum is read with its numbers as values and a warning, because writers that create enum types will store text instead. `HasDefaultValue(PostStatus.Draft)` is the enum default.
- **Owned types.** `OwnsOne`, `[Owned]` and `ComplexProperty` are flattened into the owner with EF Core's column names (`Address_Street`, nested `Address_Geo_Lat`); a column setting made in the `OwnsOne` lambda (`HasColumnName`, `HasMaxLength`) is applied, and the columns allow null when the owner navigation does. `ToJson()` is one json column. `OwnsMany` is a separate table in EF Core and is skipped with a warning.
- **Inheritance.** Table-per-hierarchy (`HasDiscriminator`, or just derived types in the model) is one model with the columns of every type (those of the derived types nullable) and a discriminator column, with a warning. Table-per-type and table-per-concrete-type (`ToTable` on the derived type, `UseTptMappingStrategy`) are read as independent tables, also with a warning.
- **Many-to-many.** Skip navigations are one many-to-many relation on the entity declared first; its join table is derived by the other formats, and a warning names the join table EF Core creates (`CategoryProduct` with `CategoriesId` and `ProductsId` by default, or what `UsingEntity` names) when it differs. `UsingEntity<TJoin>` with a class makes that class an ordinary model with a composite key.

The IR keeps model names as the class names, field and relation names in camelCase (`PublicId` is `publicId`; the default alias `Author` is `author`) and the database names separately, so the default `preserve` naming gives the tables and columns EF Core creates.

## Writing

Not supported yet. `--to efcore` fails with `The format "efcore" can only be used as an input`. Use the [conversion matrix](../CONVERSION_MATRIX.md) to see what survives when EF Core models are written to every other format. The writer is the next item on the [roadmap](../../ROADMAP.md).

## Limitations and warnings

Warnings appear on stderr as `warning: <message>`. Real examples:

- `Order.State: the enum OrderState is stored as an integer by EF Core; it is read as an enum with the numbers as values, and writers that create enum types will store text instead. Add HasConversion<string>() to store the names.`
- `Product.Categories: the join table "CategoryProduct" (columns ProductsId, CategoriesId) is not preserved by name; formats that derive join tables will use "Products_categories" (columns product_id, category_id).`
- `Vehicle: Car, Truck derive from Vehicle in one table (table per hierarchy). The hierarchy was read as a single model with the columns of every type (those of the derived types nullable) and a discriminator column; derived types are not separate models.`
- `Book.Stamp: the row version ([Timestamp] / IsRowVersion) has no equivalent in the shared model; it was read as an ordinary column.`
- `ShopContext.OnModelCreating: the call HasPostgresExtension(...) is not interpreted and was ignored.` Fluent calls the reader does not know warn once per call and place.
- Not read, each with a warning: conditionals and loops around configuration code (a loop that assigns `DeleteBehavior` to every foreign key is applied), `ConfigureConventions`, value converters other than `HasConversion<string>()`, `OwnsMany`, `ToSqlQuery`, filtered and covering indexes (kept as full indexes), seed data (`HasData`), global query filters, comments, check constraints, concurrency tokens, navigations to types that are not in the input, and properties whose type has no column type.
- Not part of the schema and ignored silently: validation attributes (`[Range]`, `[EmailAddress]`), serialization attributes (`[JsonIgnore]`), property initializers (a C# default such as `= 5` is not a database default; only `HasDefaultValue` and `HasDefaultValueSql` are) and the index EF Core adds on every foreign key.
- Not seen: reflection, run-time model building, models split across projects that are not in the input, global usings and `Directory.Build.props` settings (a `<Nullable>enable</Nullable>` project setting is detected only when some file writes `?` on a reference type or says `#nullable enable`), and migrations (replaying them to rebuild a schema is not supported).

See [efcore to prisma](../CONVERSION_MATRIX.md#efcore--prisma), [efcore to django](../CONVERSION_MATRIX.md#efcore--django), [efcore to typeorm](../CONVERSION_MATRIX.md#efcore--typeorm), [efcore to sql](../CONVERSION_MATRIX.md#efcore--sql) and [what efcore cannot express](../CONVERSION_MATRIX.md#what-efcore-cannot-express).

The reader is checked against the real library: when the .NET SDK is installed and `EFCORE_DIR` is set, the tests build `test/tools/efcore-verify` (EF Core 8 with SQLite), create every fixture's database with `EnsureCreated()` and compare tables, columns, nullability, keys, indexes and foreign keys with what the parser read (see [test/README.md](../../test/README.md)).

## Programmatic API

```ts
import {
  convertText,
  parseEfcore,
  type ConvertResult,
  type IrSchema,
  type Result,
} from 'ormbridge';

declare const postClass: string;
declare const contextClass: string;

// EF Core -> Prisma, in memory.
const converted: Result<ConvertResult> = await convertText(
  [
    { path: 'Models/Post.cs', text: postClass },
    { path: 'Data/BlogContext.cs', text: contextClass },
  ],
  {
    from: 'efcore',
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
const parsed: Result<IrSchema> = await parseEfcore(
  [{ path: 'Models/Post.cs', text: postClass }],
  { appLabel: 'app' }
);
if (parsed.ok) {
  console.log(parsed.value.models.map((model) => model.tableName));
  console.log(parsed.value.warnings);
}
```

`parseEfcore` returns a `Result` and never throws: input without entities is an error with the code `NO_MODELS_FOUND`, and constructs it cannot read are warnings in `schema.warnings`. `isSkippedEfcorePath(path)` tells whether a path is one of the migration, build-output or generated files the reader skips.
