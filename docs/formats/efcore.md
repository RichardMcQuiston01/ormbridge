# Entity Framework Core

ormbridge reads and writes Entity Framework Core (EF Core) models in C# (`ormbridge formats` lists `efcore` as `read + write`). It claims no file extension, because `.cs` is far too generic: always pass `--from efcore` (or `--to efcore`). Without it a `.cs` input is read as Django and fails with `No concrete Django models were found in: ...`. The C# is parsed statically with tree-sitter; nothing is compiled or run, so no .NET SDK, NuGet package or database is needed to convert.

An EF Core model is spread over three places, and ormbridge reads all of them:

- **Entity classes** with data annotations (`[Table]`, `[Key]`, `[Column]`, `[Required]`, `[MaxLength]`, `[ForeignKey]`, `[Index]`, ...) and properties.
- **The `DbContext`**: `DbSet<T>` properties and `OnModelCreating` with the fluent API (`modelBuilder.Entity<T>(...)`).
- **`IEntityTypeConfiguration<T>` classes**, applied with `modelBuilder.ApplyConfiguration(new X())` or `ApplyConfigurationsFromAssembly`.

A folder of migrations (`Migrations/*.cs` and the model snapshot) is read too, by replaying it ([Migrations](#migrations)). Target: EF Core 5 and later. The reader is checked against EF Core 8 (see the end of this page).

## Try it

The example in [`examples/efcore`](../../examples/efcore/) has two conversions in `ormbridge.config.json`:

```bash
cd examples/efcore
npx ormbridge convert            # writes models/ from the shared schema, then reads it back
npx ormbridge convert --check
```

| Conversion    | Input                     | Output                 |
| ------------- | ------------------------- | ---------------------- |
| `to-efcore`   | `../schema/schema.prisma` | `models`               |
| `from-efcore` | `models`                  | `prisma/schema.prisma` |

`models/` is generated: `AppDbContext.cs` and one class per model in `models/Models/`. Inside this repository run `node ../../dist/cli.js convert` after `npm run build`. Without the config file: `ormbridge convert -i ../schema/schema.prisma -t efcore -o models` and `ormbridge convert -i models -f efcore -t prisma -o prisma/schema.prisma`.

## Reading

- **Input.** A file or a directory. In a directory every `.cs` file is read except `*.Designer.cs`, `*.g.cs` and `*.generated.cs`, and the directories `bin`, `obj`, `packages`, `node_modules`, `.vs` and `.git` are skipped. The `Migrations` folder and the `*ModelSnapshot.cs` are read as well: when the input has entity classes they are skipped with one warning (the classes describe the model), and when it has none they are replayed (see [Migrations](#migrations)). A file that is named explicitly is read, except that a path inside `bin/` or `obj/` or a designer file is skipped with a warning. Several files are merged, so a navigation may point at an entity in another file. Namespaces are ignored: types are matched by their simple name, and a second class with the same name is skipped with a warning (`partial` classes are merged).
- **Which classes are entities.** A class used in a `DbSet<T>` property of a `DbContext` (also one that derives from `IdentityDbContext<...>` or another context), named by `modelBuilder.Entity<T>()`, `HasOne<T>()` or an `IEntityTypeConfiguration<T>`, reached through a navigation property of another entity, or marked with a data annotation that only EF Core reads (`[Table]`, `[Index]`, `[PrimaryKey]`, `[Keyless]`, or `[Key]`, `[ForeignKey]`, `[InverseProperty]`, `[DatabaseGenerated]`, `[Column]`, `[Timestamp]` on a property). `[Required]`, `[MaxLength]` and `[StringLength]` alone do not make a class an entity. Abstract classes and base classes without a `DbSet` are not entities: their properties are mapped into the classes that derive from them, as in EF Core.
- **Properties.** Public properties with a getter and a setter (any accessibility, `init` too) are columns. Static, computed (`=>`), get-only and field members, `[NotMapped]` properties and `Ignore()` are not. Positional `record` parameters are properties. A generic base class (`Entity<TKey>`) has its type parameters replaced by the arguments of the derived class.
- **Data annotations.** `[Table(name, Schema = ...)]`, `[Column(name, TypeName = ...)]`, `[Key]`, `[PrimaryKey(...)]` (composite), `[Required]`, `[MaxLength]`, `[StringLength]`, `[ForeignKey]` (on the navigation, on the key property, or on a collection), `[InverseProperty]`, `[Index(...)]` (`IsUnique`, `Name`, `IsDescending`, `AllDescending`), `[NotMapped]`, `[DatabaseGenerated]`, `[Timestamp]`, `[ConcurrencyCheck]`, `[Precision]`, `[Comment]`, `[Keyless]`, `[Owned]`, `[ComplexType]`, `[Unicode]`. String arguments may be literals, `nameof(...)`, or constants defined in the input.
- **Fluent API.** In `OnModelCreating` and in `Configure` methods, also inside `modelBuilder.Entity<T>(entity => { ... })`, in variables (`var entity = modelBuilder.Entity<T>();`), in helper methods of the same class and in extension methods of the input: `ToTable(name, schema)`, `ToView`, `HasKey` (composite too), `HasNoKey`, `HasAlternateKey`, `HasIndex` (`IsUnique`, `HasDatabaseName`, `IsDescending`, `HasMethod`), `Property(...)` with `HasColumnName`, `HasColumnType`, `HasMaxLength`, `IsRequired`, `HasPrecision`, `HasDefaultValue`, `HasDefaultValueSql`, `HasComputedColumnSql`, `ValueGeneratedOnAdd` / `OnAddOrUpdate` / `Never`, `HasConversion<string>()`, `HasValueGenerator<GuidValueGenerator>()` (a `uuid` default) and `HasComment`; `Ignore`; `HasOne` / `HasMany` with `WithOne` / `WithMany`, `HasForeignKey`, `HasPrincipalKey`, `OnDelete(DeleteBehavior.X)`, `IsRequired`, `HasConstraintName` and `UsingEntity`; `OwnsOne`, `ComplexProperty`; `HasDiscriminator`; `HasDefaultSchema`.
- **Conventions.** The key is the property `Id` or `<TypeName>Id` (any case); integer keys count up and `Guid` keys are `uuid` values generated by EF Core. A foreign key is `<Navigation>Id`, `<Navigation><Key>`, `<Type>Id` or `<Type><Key>`; without a matching property EF Core creates a shadow column (`BlogId`), and so does the reader. Two collection navigations are a skip-navigation many-to-many. A relationship is required when its foreign key is not nullable, or, for a shadow key, when the navigation is `[Required]` or not nullable under nullable reference types; required relationships cascade on delete and optional ones use EF Core's `ClientSetNull`, which is `NO ACTION` in the database. The table is named after the `DbSet` property, or the class when there is none, and the column after the property, so the IR keeps C# names (`Title`) unless an attribute or the fluent API renames them.
- **Nullability.** `int?`, `Nullable<int>` and reference types written with `?` allow null. Nullable reference types are on when a file says `#nullable enable` (or any file writes a reference type with `?`); then `string` is required and `string?` optional. Without them every reference type column allows null unless `[Required]` or `IsRequired()` says otherwise. `#nullable disable` turns them off for that file.
- **Types.** `int`, `short`, `byte`, `uint` are `int`; `long` is `bigInt`; `bool`; `decimal` (precision from `[Precision]`, `HasPrecision` or a column type); `double` and `float`; `DateTime` and `DateTimeOffset`; `DateOnly`, `TimeOnly`, `TimeSpan`; `Guid`; `byte[]`; `JsonDocument` / `JsonElement`; `IPAddress`; `string` (a length-limited string with a length, otherwise `text`); `char`; arrays and lists of these as arrays. `HasColumnType("jsonb")` and `[Column(TypeName = "varchar(80)")]` override the type when the name is a known one. Spatial types and `object` are unsupported columns with a warning.
- **Enums.** A C# enum becomes an enum of the shared model. EF Core stores it as an integer unless `HasConversion<string>()` (or `EnumToStringConverter<T>`) is used; an integer-stored enum is read with its numbers as values and a warning, because writers that create enum types will store text instead. `HasDefaultValue(PostStatus.Draft)` is the enum default. One value converter is understood: a class that derives from `ValueConverter<TEnum, string>` and lists the stored values as `switch` arms (`"draft" => PostStatus.Draft`), used as `HasConversion(new PostStatusConverter())`, which is the shape the writer produces when the stored values differ from the member names; any other converter warns.
- **Owned types.** `OwnsOne`, `[Owned]` and `ComplexProperty` are flattened into the owner with EF Core's column names (`Address_Street`, nested `Address_Geo_Lat`); a column setting made in the `OwnsOne` lambda (`HasColumnName`, `HasMaxLength`) is applied, and the columns allow null when the owner navigation does. `ToJson()` is one json column. `OwnsMany` (and an `[Owned]` type used in a collection) is a table of its own in EF Core and a model of its own here: named after the owned class (`Line`; `SupplierLine` when two owners own the same class), with the table EF Core uses (the class name, or `<owner table>_<collection>` such as `Customers_Lines` when two owners own the same class, or `ToTable` in the `OwnsMany` lambda), a foreign key to the owner named after the owner and its key (`CustomerId`; for an owner with a composite key `OrderCustomerId`, `OrderId`) that cascades on delete, and the key EF Core gives such a table: the foreign key plus an `Id` (the property of that name, else a generated integer). Collections inside collections work the same way (the inner one has a composite foreign key), the owned type's own columns, `OwnsOne` inside it, `HasColumnName`, `HasMaxLength` and `HasIndex` in the `OwnsMany` lambda apply to the child table, and `ToJson()` on the collection is one json column of the owner. `HasKey` or `WithOwner().HasForeignKey(...)` inside the lambda is not interpreted (a warning), and an owner without a key cannot be referenced and is skipped with a warning.
- **Inheritance.** Table-per-hierarchy (`HasDiscriminator`, or just derived types in the model) is one model with the columns of every type (those of the derived types nullable) and a discriminator column, with a warning. Table-per-type and table-per-concrete-type (`ToTable` on the derived type, `UseTptMappingStrategy`) are read as independent tables, also with a warning.
- **Many-to-many.** Skip navigations are one many-to-many relation on the entity declared first; its join table is derived by the other formats, and a warning names the join table EF Core creates (`CategoryProduct` with `CategoriesId` and `ProductsId` by default, or what `UsingEntity` names) when it differs. `UsingEntity<TJoin>` with a class makes that class an ordinary model with a composite key.

The IR keeps model names as the class names, field and relation names in camelCase (`PublicId` is `publicId`; the default alias `Author` is `author`) and the database names separately, so the default `preserve` naming gives the tables and columns EF Core creates.

## Migrations

A folder of EF Core migrations is read as the schema the database ends with, the way the Laravel reader replays PHP migrations. Pass the `Migrations` folder (or the project) with `--from efcore`; when the input has **no entity classes** the migrations are replayed, and when it has entity classes the classes win (they describe the model, with the C# names) and the migration files are skipped with one warning. The usual case for a replay is a project that holds only the migrations and the snapshot, as when the migrations live in an assembly of their own (`MigrationsAssembly`).

- **Order.** The `Up` methods run in the order of the migration ids: the `[Migration("20240101120000_Initial")]` value when a class has the attribute, else the file name without `.cs` (`20240101120000_Initial.cs`), compared as text like EF Core does, so the files can be given in any order. An id without a 14-digit timestamp prefix is ordered by name and warns. `Down` methods and `*.Designer.cs` files are not read. All migrations are replayed into one schema, so several contexts in one folder give one schema.
- **Operations.** `CreateTable` (columns, `PrimaryKey`, `ForeignKey`, `UniqueConstraint`, `CheckConstraint`), `DropTable`, `RenameTable`, `AddColumn`, `DropColumn`, `RenameColumn`, `AlterColumn`, `CreateIndex`, `DropIndex`, `RenameIndex`, `AddForeignKey`, `DropForeignKey`, `AddPrimaryKey`, `DropPrimaryKey`, `AddUniqueConstraint`, `DropUniqueConstraint`, `AddCheckConstraint` and `DropCheckConstraint`. Arguments are read by name or by position, a column with a `name:` argument keeps that name, and a rename carries the keys, indexes and foreign keys that use the table or column. `AlterColumn` replaces the column definition, as EF Core writes the whole new definition. `EnsureSchema`, `DropSchema`, `AlterDatabase` and `AlterTable` change nothing the shared model holds and are ignored.
- **Columns.** The type comes from the CLR type argument (`Column<int>`) and the provider's column type (`type: "nvarchar(450)"`, `"uuid"`, `"jsonb"`, `"decimal(18,2)"`); the CLR type decides except where the column type says more (json, a length, a precision, `date` for a `DateTime`), and the generic SQLite types (`TEXT`, `INTEGER`) say nothing. `nullable:`, `maxLength:`, `precision:` / `scale:`, `defaultValue:` (a literal, `new Guid("...")`, `new DateTime(...)`), `defaultValueSql:`, `computedColumnSql:` with `stored:`, and the identity annotations of the providers (`SqlServer:Identity`, `Sqlite:Autoincrement`, `Npgsql:ValueGenerationStrategy`, `MySql:ValueGenerationStrategy`) are read; an index reads `unique:`, `filter:`, `descending:` and the `Npgsql:IndexMethod` annotation. When EF Core adds a column that is not nullable (or makes one so) it writes the CLR default (`defaultValue: ""`, `0`, `false`, `0m`) to fill the rows that exist; that is a step of the migration, so it is not a default of the model. An enum column is its integer or string (a migration does not name the enum), and the index EF Core adds on every foreign key is left out, as for entity classes.
- **Names.** Without a snapshot a model is named after its table (`Posts` is `Post`, `Categories` is `Category`), a field after its column (camelCase), a relation after its foreign key column without `Id`, and constraint, index and key names are kept only when they are not the ones EF Core gives by convention (`PK_Posts`, `FK_Posts_Blogs_BlogId`, `IX_Posts_Title`, `AK_Products_Sku`).
- **The model snapshot.** A `*ModelSnapshot.cs` is read too, from its `BuildModel` method (`modelBuilder.Entity("App.Blog", b => ...)`, `OwnsOne`, `OwnsMany`, `ComplexProperty`, `HasOne` / `HasForeignKey`), without the entity classes. It is compared with the replay at the level the shared model keeps: tables, columns and their nullability, the primary key, unique keys, indexes, and foreign keys with their delete action. When they **agree**, the snapshot supplies the entity, property and navigation names (`EmployeeProfile` instead of `Profile`, related names such as `posts`); when they **do not**, one warning lists the differences, the schema is rebuilt from the migrations alone and the names of the snapshot are not used. A snapshot without migrations is read alone, with a warning.
- **Owned types.** The tables of `OwnsMany` collections (`Order`, `OrderLine`) are ordinary models with a foreign key to the owner and the composite key EF Core gives them; `OwnsOne` columns (`Home_Street`) are plain columns.
- **Warnings** name the file and line, and the table and column when there is one: `Migrations/20240101120000_Initial.cs:12: AddColumn "X" refers to the table "Missing", which no earlier migration creates; the change was skipped.` Raw `migrationBuilder.Sql(...)` gives one warning per call (with the statement and the table when it can be told), `InsertData`, `UpdateData` and `DeleteData` (seed data) and sequences one each, and statements in an `if`, loop or `try` are applied as if they always ran, with a warning (only the first block: an `else` branch is skipped). Check constraints, filtered and covering indexes, row versions and non-Unicode columns warn as they do for entity classes.
- **Not interpreted.** Anything a migration does with SQL, a provider's own annotations beyond those listed, collations, comments, operations written with helper methods or variables instead of `migrationBuilder.X(...)` calls, and migrations that are built at run time. A many-to-many join table stays a model with a composite key (a migration does not say it is a skip navigation).

The replay is checked against the real EF Core: `test/tools/efcore-migrations-verify` writes the migrations and the snapshot that EF Core generates for several models (each with a few versions) and describes the final model from EF Core's relational model; the tests replay the first _k_ migrations, with and without the snapshot, and compare the result for every _k_ (see the end of this page).

## Writing

`--to efcore` writes Entity Framework Core 8 models in C# (`#nullable enable`): one entity class per model, a C# `enum` per enum and an `AppDbContext` with a `DbSet<T>` for every entity. That is more than one file, so `-o` is a directory:

```bash
ormbridge convert -i ./prisma/schema.prisma --to efcore -o ./Data
```

```
Data/
  AppDbContext.cs
  Models/
    Post.cs  User.cs  ...           one class per model
    PostStatus.cs                   one file per enum (and its value converter, when it needs one)
  Configurations/                   only with --style fluent
    PostConfiguration.cs  ...       one IEntityTypeConfiguration<T> per model
```

Every table, column, key, index and foreign key is written explicitly, so the output creates the schema of the IR, and reading it back with `--from efcore` gives the same schema.

### Options

| Option               | Effect                                                                                                                                                                                                                                                                                              |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--style <name>`     | `annotations` (default) or `fluent`, as below. Anything else fails with `Invalid --style value "..." for the efcore format. Expected one of: annotations, fluent.`                                                                                                                                  |
| `--namespace <name>` | The C# namespace of every file (file-scoped, `namespace App.Models;`). Default `App.Models`; the entities, the enums, the configuration classes and the context share it. `App\Models` and other non-C# names are rejected.                                                                         |
| `--no-header`        | Leaves out the three-line `// <auto-generated>` comment at the top of every file.                                                                                                                                                                                                                   |
| `--provider <name>`  | Picks the column types and the SQL of defaults (below). `postgresql` is the default; `cockroachdb` is written for Npgsql with a warning (hstore, range and nested-array columns become strings, index methods other than B-tree and GIN are dropped); `mongodb` warns and is written as PostgreSQL. |
| `--naming preserve`  | Default. Keeps the table and column names of the source: every name that differs from what EF Core would pick is written with `[Table]` / `[Column]` (or `ToTable` / `HasColumnName`).                                                                                                              |
| `--naming normalize` | Fresh-schema style: singular snake_case tables and columns, UUID keys instead of auto-increment ids, `created_at` / `updated_at`. Properties are PascalCase in both modes.                                                                                                                          |

Config keys: `style`, `namespace`, `header`, `provider` and `naming`.

### `--style annotations` (default)

The classes carry what data annotations can say; `OnModelCreating` holds only the rest.

```csharp
// Models/Post.cs
[Table("blog_post")]
[Index(nameof(Title))]
[Index(nameof(AuthorId), nameof(Title), IsUnique = true)]
public class Post
{
    [Column("id")]
    public int Id { get; set; }

    [Column("title")]
    [MaxLength(200)]
    public string Title { get; set; } = string.Empty;

    [Column("status")]
    public PostStatus Status { get; set; } = PostStatus.DRAFT;

    [Column("author_id")]
    public int AuthorId { get; set; }

    [ForeignKey(nameof(AuthorId))]
    [InverseProperty(nameof(User.Posts))]
    public User Author { get; set; } = null!;
}
```

```csharp
// AppDbContext.cs
modelBuilder.Entity<Post>(entity =>
{
    entity.Property(e => e.Status).HasConversion(new PostStatusConverter()).HasDefaultValue(PostStatus.DRAFT);
    entity.HasOne(e => e.Editor).WithMany(r => r.EditedPosts).HasForeignKey(e => e.EditorId).OnDelete(DeleteBehavior.SetNull);
});
```

`[Table]`, `[Column]`, `[Key]` / `[PrimaryKey]`, `[MaxLength]`, `[Precision]`, `[DatabaseGenerated]`, `[Index]`, `[Keyless]`, `[ForeignKey]` and `[InverseProperty]` go on the classes. The fluent API is used only where an annotation cannot say it: defaults (`HasDefaultValue`, `HasDefaultValueSql`), enum conversions, computed columns, delete behaviors that differ from EF Core's default (a required relationship cascades and an optional one does `NO ACTION`), relationships to a column other than the key (`HasPrincipalKey`, `HasAlternateKey`), composite foreign keys, constraint names, index methods, views (`ToView`), many-to-many join tables and the key name. A relationship the fluent API describes is not annotated a second time.

### `--style fluent`

The entity classes are plain C# classes with no attributes, and every mapping is in a configuration class:

```csharp
// Configurations/PostConfiguration.cs
public class PostConfiguration : IEntityTypeConfiguration<Post>
{
    public void Configure(EntityTypeBuilder<Post> builder)
    {
        builder.ToTable("blog_post");
        builder.HasKey(e => e.Id);
        builder.Property(e => e.Title).HasColumnName("title").HasMaxLength(200);
        builder.HasIndex(e => new { e.AuthorId, e.Title }).IsUnique();
        builder.HasOne(e => e.Author).WithMany(r => r.Posts).HasForeignKey(e => e.AuthorId);
    }
}
```

`AppDbContext.OnModelCreating` applies them with `modelBuilder.ApplyConfiguration(new PostConfiguration());`, one line per entity. A many-to-many join table is configured in the class of the model that owns the relation.

### What is written

- **Names.** The class is the model name in PascalCase (`blog_post` becomes `BlogPost`); a name the generated code uses or the .NET base library has (`Object`, `DateTime`, `List`, `DbContext`, ...) gets an `Entity` suffix with a warning. The `DbSet` is the plural of the class (`Posts`, `Categories`, `People`; a name that already ends in a plural `s`, like `PostTags`, is kept). The table needs `[Table]` / `ToTable` whenever it is not that `DbSet` name, and a table that is a PascalCase word (`BlogPosts`) names the `DbSet` instead and needs nothing. Properties are PascalCase (`view_count` becomes `ViewCount`) with `[Column("view_count")]`; a name EF Core or C# would reject (`Equals`, the name of the class itself) gets a `Value` suffix with a warning, and a navigation that collides with a property gets a `Ref` suffix. Keywords are written with `@`.
- **Types.** `string` (with `[MaxLength(n)]`), `int`, `long`, `double`, `decimal` (`[Precision(p, s)]`), `bool`, `DateTime`, `DateOnly`, `TimeOnly`, `TimeSpan`, `Guid`, `byte[]`; a column is nullable (`int?`, `string?`) when the IR says so, and every non-nullable reference type gets an initializer that keeps the compiler quiet. `json` is a `string` with the column type `jsonb` on PostgreSQL and `json` on MySQL (SQLite and SQL Server have no JSON column type in EF Core 8: a string stored as text, with a warning). PostgreSQL also gets arrays (`string[]`, `int[,]` for nested ones), `IPAddress`, `Dictionary<string, string>` (hstore) and `NpgsqlRange<T>` (a range, which needs the Npgsql package); on the other providers an IP address is a string of at most 45 characters, a nested array, an hstore and a range are strings, each with a warning. An unsupported database type is a `string` with that column type, with a warning.
- **Keys.** A single `Id` (or `<Class>Id`) key is left to EF Core's conventions; any other single key gets `[Key]` (`HasKey`). A counting integer key needs nothing, an integer or `Guid` key that is not generated says `[DatabaseGenerated(DatabaseGeneratedOption.None)]` (`ValueGeneratedNever()`), a counting column that is not the key says `Identity`. A composite key is `[PrimaryKey(nameof(A), nameof(B))]` (`HasKey(e => new { e.A, e.B })`), relations included. A relation that is the key marks its foreign key property. A model without a key is written `[Keyless]` (with `[Table]`, because EF Core maps a keyless entity to no table otherwise) and a warning. A named primary key constraint is `HasKey(...).HasName("PK_x")`.
- **Defaults.** Literals are `HasDefaultValue(3)`, `HasDefaultValue(3L)`, `HasDefaultValue(0.5)`, `HasDefaultValue(9.99m)`, `HasDefaultValue("x")` and `HasDefaultValue(Guid.Parse("..."))`, typed the way EF Core 8 insists on; a date or JSON literal is `HasDefaultValueSql("'...'")`. `now` is `CURRENT_TIMESTAMP` (`CURRENT_DATE`, `CURRENT_TIME`; `GETUTCDATE()` on SQL Server), a UUID default is `gen_random_uuid()` on PostgreSQL, `(UUID())` on MySQL, `NEWID()` on SQL Server, and on SQLite `ValueGeneratedOnAdd().HasValueGenerator<GuidValueGenerator>()` with a warning (EF Core creates the Guid, the database cannot); a UUID key is generated by EF Core itself. A database expression is written as it is (in parentheses for SQLite and MySQL, which require them). A plain C# default is also the initial value of the property, and a reference-type column with a database default starts as `null!`, so a new object does not insert an empty value instead of the default. `cuid()` and other client-generated defaults, array defaults and Prisma default functions are dropped with a warning.
- **Enums.** A C# `enum` with the members of the IR enum. When every member is named exactly like its stored value the column is `HasConversion<string>()`; otherwise the file also holds a `ValueConverter<TEnum, string>` class (`PostStatusConverter`) with the stored values in two `switch` expressions, so the database keeps `draft` while the C# member is `DRAFT`. An enum whose stored values are all integers (and whose column is an integer) is an `enum` with those numbers and no conversion. A column length becomes `HasMaxLength(n)`; an enum default is `HasDefaultValue(PostStatus.DRAFT)`. A member that is a keyword is written with `@`, and one that is not an identifier is repaired with a warning. An array of an enum is stored as numbers by EF Core, which is a warning.
- **Indexes.** A unique column and a unique index are `[Index(nameof(Email), IsUnique = true)]` (`HasIndex(e => e.Email).IsUnique()`), with `Name = "..."` for a named one and `IsDescending = new[] { true, false }` for a sort order. A unique column that another table references with a non-key column is a `HasAlternateKey`, not an index. A one-to-one foreign key is unique. An index method (`gin`) is `HasMethod("gin")`, written for PostgreSQL only (it needs the Npgsql package; the other providers drop it with a warning); prefix lengths, operator classes and clustering are dropped with a warning, and a full-text index is an ordinary index. EF Core's own index on every foreign key is not written: it creates it.
- **Relations.** Every foreign key is a property (`AuthorId`, typed from the key it references, with `[MaxLength]` for a string key) next to a navigation (`Author`, non-nullable when the column is not) and, when the IR has a related name, the other side: `ICollection<Post> Posts`, or a single `Profile?` for a one-to-one relation. `ON DELETE` is `DeleteBehavior.Cascade`, `SetNull`, `Restrict` or `NoAction`, written when it is not what EF Core does anyway; `SET DEFAULT` has no EF Core behavior and is written as `NoAction`, and EF Core cannot set `ON UPDATE` at all; both are warnings. `SET NULL` on a column that is not nullable is written, with a warning that deleting the parent fails. A composite foreign key is `HasForeignKey(e => new { e.A, e.B })` (with `HasPrincipalKey` when it does not reference the key); a relation to a model that is not in the schema, or to one without a single key, is skipped with a warning.
- **Many-to-many.** Two skip navigations (`ICollection<Tag> Tags` and, with a related name, `ICollection<Post> Posts`) and a `UsingEntity<Dictionary<string, object>>` call that names the join table the way the other formats do (`<owner table>_<relation>`, columns `<model>_id`, `from_` / `to_` for a self reference), so the table matches the one Django or Sequelize create. An explicit join model (Prisma) is an ordinary entity with a composite key.
- **Timestamps.** EF Core has no `auto_now`. A date-time column that the IR refreshes on every save is `ValueGeneratedOnAddOrUpdate()` (which is what the reader looks for), and `AppDbContext` overrides `SaveChanges` and `SaveChangesAsync` to set it to `DateTime.UtcNow` whenever an entity is added or modified; EF Core is told it may save the value (`Metadata.SetBeforeSaveBehavior` and `SetAfterSaveBehavior`), because it otherwise ignores a value it expects the database to generate. Other auto-updated columns are written as ordinary columns, with a warning.
- **Views and schemas.** A view is `ToView("name")` and `[Keyless]` when it has no key; a database schema is `[Table("t", Schema = "s")]` (`ToTable("t", "s")`).
- **Warnings** name the model and field, as in the other writers: JSON on SQLite and SQL Server, PostgreSQL-only types elsewhere, unsupported database types, client-generated defaults, the `ON UPDATE` action, `SET DEFAULT`, models without a key, skipped relations, generated columns whose expression is Python, `@@ignore` and anything else EF Core cannot express.

The output compiles without warnings in a project with nullable reference types and no implicit usings (every file lists the `using` directives it needs), and the PostgreSQL output compiles against `Npgsql.EntityFrameworkCore.PostgreSQL`.

Reading the output back with `--from efcore` gives the same schema, apart from the differences listed in the [conversion matrix](../CONVERSION_MATRIX.md): a string without a length (read back as `text`), a model name that was not PascalCase, enum labels, `SET DEFAULT`, the unique constraint of a column that has a constraint name, and the types EF Core has no CLR type for (ranges, enum arrays), which come back as unsupported columns with a warning. The enum converter class is read back too: its `switch` arms give the stored values.

## Limitations and warnings

Warnings appear on stderr as `warning: <message>`. Real examples:

- `Order.State: the enum OrderState is stored as an integer by EF Core; it is read as an enum with the numbers as values, and writers that create enum types will store text instead. Add HasConversion<string>() to store the names.`
- `Product.Categories: the join table "CategoryProduct" (columns ProductsId, CategoriesId) is not preserved by name; formats that derive join tables will use "Products_categories" (columns product_id, category_id).`
- `Vehicle: Car, Truck derive from Vehicle in one table (table per hierarchy). The hierarchy was read as a single model with the columns of every type (those of the derived types nullable) and a discriminator column; derived types are not separate models.`
- `Book.Stamp: the row version ([Timestamp] / IsRowVersion) has no equivalent in the shared model; it was read as an ordinary column.`
- `ShopContext.OnModelCreating: the call HasPostgresExtension(...) is not interpreted and was ignored.` Fluent calls the reader does not know warn once per call and place.
- Not read, each with a warning: conditionals and loops around configuration code (a loop that assigns `DeleteBehavior` to every foreign key is applied), `ConfigureConventions`, value converters other than `HasConversion<string>()`, `ToSqlQuery`, filtered and covering indexes (kept as full indexes), seed data (`HasData`), global query filters, comments, check constraints, concurrency tokens, navigations to types that are not in the input, and properties whose type has no column type.
- Not part of the schema and ignored silently: validation attributes (`[Range]`, `[EmailAddress]`), serialization attributes (`[JsonIgnore]`), property initializers (a C# default such as `= 5` is not a database default; only `HasDefaultValue` and `HasDefaultValueSql` are) and the index EF Core adds on every foreign key.
- Not seen: reflection, run-time model building, models split across projects that are not in the input, global usings and `Directory.Build.props` settings (a `<Nullable>enable</Nullable>` project setting is detected only when some file writes `?` on a reference type or says `#nullable enable`), and table-per-type inheritance (read as independent tables). A composite foreign key that points at a table whose key has a foreign key column in it (the inner collection of a nested `OwnsMany`) names that column by its relation, which writers such as Prisma cannot resolve: they skip that foreign key with a warning.

The writer's warnings use the same format. Real examples:

- `Account.ip: only PostgreSQL maps IPAddress; the column was written as a string of at most 45 characters.`
- `Session.token: SQLite has no database-side UUID default; EF Core generates the Guid when the row is added through it.`
- `Post.author: SET NULL on a required relation; the column is NOT NULL, so deleting a User that is referenced fails.`
- `Log: the model has no primary key; EF Core needs a key, so the class was written as keyless ([Keyless]).`
- `Book.window: the range column uses NpgsqlRange<int>, which needs the Npgsql.EntityFrameworkCore.PostgreSQL package.`

See [efcore to prisma](../CONVERSION_MATRIX.md#efcore--prisma), [efcore to django](../CONVERSION_MATRIX.md#efcore--django), [efcore to typeorm](../CONVERSION_MATRIX.md#efcore--typeorm), [efcore to sql](../CONVERSION_MATRIX.md#efcore--sql), [prisma to efcore](../CONVERSION_MATRIX.md#prisma--efcore) and [what efcore cannot express](../CONVERSION_MATRIX.md#what-efcore-cannot-express).

The reader and the writer are checked against the real library. When the .NET SDK is installed and `EFCORE_DIR` is set, the tests build `test/tools/efcore-verify` (EF Core 8 with SQLite). The reader tests create every fixture's database with `EnsureCreated()` and compare tables, columns, nullability, keys, indexes and foreign keys with what the parser read. The writer tests compile the models written for the canonical schema of every format, the larger `extras` fixtures, the EF Core fixtures and three IR fixtures (both styles, both naming modes) with warnings as errors and without implicit usings, create each context in SQLite and compare the same things with the IR; the tool then saves a row into every table through the entity classes, so defaults, enum conversions, generated keys and the `SaveChanges` override are exercised too. The PostgreSQL output is compiled against the Npgsql provider. The migration replay and `OwnsMany` have their own checks: `test/tools/efcore-migrations-verify` (EF Core 8 with its design-time package) writes the migrations, designer files and model snapshots for seven models in two to three versions each (SQLite and PostgreSQL), including renames, key changes, owned types and a table per hierarchy, and prints the relational model EF Core builds for every version; `efcore-migrations-verify.test.ts` replays the first _k_ migrations with and without the snapshot and compares tables, columns, nullability, types, keys, unique keys, indexes and foreign keys with that model. The `OwnsMany` fixture (`fixtures/efcore-extras/orders`) is created in SQLite like the other fixtures and compared with the database. The generated migrations are committed in `test/fixtures/efcore-migrations` for the offline unit tests (`UPDATE_MIGRATION_FIXTURES=1` rewrites them). See [test/README.md](../../test/README.md).

## Programmatic API

```ts
import {
  convertText,
  emitEfcore,
  parseEfcore,
  type ConvertResult,
  type IrSchema,
  type MultiFileEmitOutput,
  type Result,
} from 'ormbridge';

declare const postClass: string;
declare const contextClass: string;
declare const schema: IrSchema;

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

// IR -> EF Core, in memory: a map of relative paths to C# text.
const efcore: MultiFileEmitOutput = emitEfcore(schema, {
  provider: 'postgresql',
  naming: 'preserve',
  style: 'annotations', // or 'fluent'
  namespace: 'App.Models', // the default
  header: true,
});
console.log(Object.keys(efcore.files)); // ['Models/Post.cs', ..., 'AppDbContext.cs']
console.log(efcore.warnings);
```

`parseEfcore` returns a `Result` and never throws: input without entities is an error with the code `NO_MODELS_FOUND`, and constructs it cannot read are warnings in `schema.warnings`. `isSkippedEfcorePath(path)` tells whether a path is one of the migration, build-output or generated files the reader skips.
