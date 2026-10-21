# Hibernate / JPA

ormbridge reads and writes Hibernate and JPA entities written in Java (`ormbridge formats` lists `jpa` as `read + write`). It claims no file extension, because `.java` is far too generic: always pass `--from jpa` or `--to jpa`. Without `--from` a `.java` input is read as Django and fails with `No concrete Django models were found in: ...`. The Java is parsed statically with tree-sitter; nothing is compiled or run, so no JDK, Maven, Gradle or database is needed.

A JPA model is the entity classes and their annotations, and ormbridge reads exactly that:

- **Entity classes** (`@Entity`) with their fields, or getters, and the mapping annotations (`@Table`, `@Id`, `@Column`, `@ManyToOne`, `@JoinColumn`, ...).
- **Mapped superclasses and embeddables** (`@MappedSuperclass`, `@Embeddable`), which are flattened into the entities that use them.
- **Hibernate annotations** that change the schema (`@ColumnDefault`, `@JdbcTypeCode`, `@OnDelete`, `@CreationTimestamp`, `@NaturalId`, ...) and **Bean Validation** hints (`@NotNull`, `@Size`, `@Length`, `@Digits`).

Not read: `orm.xml`, `persistence.xml` and `hbm.xml` mapping files (a model mapped in XML is not seen), and Kotlin or Groovy sources. Target: JPA 2.2 and 3 (`jakarta.persistence`), Hibernate 5 and 6, and the legacy `javax.persistence` package. Annotations are matched by their simple name, so wildcard imports (`import jakarta.persistence.*;`) and fully qualified names (`@jakarta.persistence.Entity`) work. The reader is checked against Hibernate ORM 6.4 (see the end of this page).

## Try it

The example in [`examples/jpa`](../../examples/jpa/) has two conversions in `ormbridge.config.json`:

```bash
cd examples/jpa
npx ormbridge convert            # writes models/ from ../schema/schema.prisma, then reads it back to prisma/schema.prisma
npx ormbridge convert --check
```

| Conversion | Input                     | Output                 |
| ---------- | ------------------------- | ---------------------- |
| `to-jpa`   | `../schema/schema.prisma` | `models`               |
| `from-jpa` | `models`                  | `prisma/schema.prisma` |

`models/` is generated (one `@Entity` class per model under `models/app/models/`, the `PostStatus` enum with its converter), so edit the schema rather than the Java. Inside this repository run `node ../../dist/cli.js convert` after `npm run build`. Without the config file: `ormbridge convert -i schema.prisma -t jpa -o src/main/java` writes the entities and `ormbridge convert -i src/main/java -f jpa -t prisma -o schema.prisma` reads them.

## Reading

- **Input.** A file or a directory. In a directory every `.java` file is read except `*Test.java`, `*Tests.java`, `module-info.java`, `package-info.java` and generated metamodel classes (`*_.java`, the `@StaticMetamodel` ones), and the directories `target`, `build`, `out`, `.gradle`, `.mvn`, `.idea`, `.settings`, `node_modules`, `.git`, `src/test` and `db/migration` (Flyway and Liquibase) are skipped. A file that is named explicitly is read, except that the same paths are skipped with a warning. Several files are merged, so a relationship may point at an entity in another file. Packages are ignored: types are matched by their simple name, and a second class with the same name is skipped with a warning.
- **Which classes are entities.** A class annotated with `@Entity`, also a nested `static` class. A `record`, an `enum`, an interface and an entity with `@Subselect` (a query, not a table) are not read; the last one warns. `@NamedQuery`, `@NamedNativeQuery`, `@Filter`, `@Where`, `@SQLDelete`, `@Cache` and `@EntityListeners` are not schema and are ignored silently.
- **Attributes and access.** Where the `@Id` (or `@EmbeddedId`) is written decides how the class is read: on a field, the non-`static`, non-`transient` fields are the attributes (field access, the usual case); on a getter, the `getX()` / `isX()` methods are (property access), and the annotations on fields are ignored with a warning. `@Access(AccessType.FIELD)` or `PROPERTY` on the class overrides this. `@Transient`, `transient` and `static` members are not columns. **Lombok** needs nothing: `@Getter`, `@Setter`, `@Data` and `@Builder` generate code, but the mapping is on the fields, which are read as written. A getter that Lombok would generate under property access has no annotations to read, so use field access with Lombok.
- **Annotations read.** `@Entity(name)`, `@Table(name, schema, uniqueConstraints, indexes)`, `@Id`, `@IdClass`, `@EmbeddedId`, `@Embedded`, `@AttributeOverride(s)`, `@GeneratedValue`, `@Column` (`name`, `length`, `nullable`, `unique`, `precision`, `scale`, `columnDefinition`, `insertable`, `updatable`), `@Basic(optional)`, `@Lob`, `@Enumerated`, `@Temporal`, `@Version`, `@Transient`, `@Convert`, `@ManyToOne`, `@OneToOne`, `@OneToMany`, `@ManyToMany`, `@JoinColumn(s)`, `@JoinTable`, `@MapsId`, `@ElementCollection`, `@CollectionTable`, `@OrderColumn`, `@Inheritance`, `@DiscriminatorColumn`, `@DiscriminatorValue`, `@PrimaryKeyJoinColumn`, `@MappedSuperclass`, `@Embeddable`, `@Access`; Hibernate's `@ColumnDefault`, `@JdbcTypeCode`, `@Type`, `@OnDelete`, `@CreationTimestamp`, `@UpdateTimestamp`, `@UuidGenerator`, `@NaturalId`, `@Formula`, `@Check`, `@Comment`, `@GeneratedColumn`, `@Subselect`, `@TenantId`; Spring Data's `@CreatedDate` and `@LastModifiedDate`; Bean Validation's `@NotNull`, `@Size`, `@Digits` and Hibernate Validator's `@Length`. Arguments may be literals, enum constants, `Foo.class`, `+` on strings and numbers, or `static final` constants defined in the input.

### Names

JPA derives names when the annotations say nothing, and the reader derives them the same way, so the default `--naming preserve` gives the tables and columns Hibernate creates with its own naming strategy:

- **Table:** `@Table(name)`, else the entity name (`@Entity(name)`, else the class name): `BlogPost` is the table `BlogPost`. `@Table(schema)` is the schema.
- **Column:** `@Column(name)`, else the attribute name: `createdAt` is the column `createdAt`. Embedded attributes keep their own names (no prefix), so an embeddable used twice needs `@AttributeOverride`.
- **Join column:** `@JoinColumn(name)`, else `<attribute>_<referenced key column>`: `author` pointing at `id` is `author_id`.
- **Join table** of a `@ManyToMany`: `@JoinTable(name)`, else `<owner table>_<target table>` with the columns `<owner entity>_<key>` and `<attribute>_<key>` (`Book_Author`, `Book_id`, `authors_id`). The model derives its own join table, so a warning names the table and columns the other formats will use whenever they differ.
- **Collection table** of an `@ElementCollection`: `<entity name>_<attribute>` with the owner column `<entity name>_<key>`.

**Spring Boot is different.** Its default `CamelCaseToUnderscoresNamingStrategy` turns these names into `blog_post` and `created_at`, and `application.properties` (which also holds `spring.jpa.hibernate.naming.*`) is not read. The IR keeps the plain JPA names; the two ways to get Spring's names are to write them with `@Table` and `@Column`, or to use `--naming normalize`, which rewrites tables and columns to singular snake_case in every format (`BlogPost` becomes `blog_post`, `createdAt` becomes `created_at`). `normalize` is the fresh-schema style of the other readers, so it also replaces auto-increment integer keys with UUIDs and adds `created_at` / `updated_at` where the model has none; use it when you want a new schema, `preserve` (the default) to keep the existing database. Explicit names from `@Table` and `@Column` are written as given under `preserve`.

### Types and columns

| Java                                                                       | Read as                                                                                                   |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `String`                                                                   | `string` of 255, or the length from `@Column(length)`, `@Size(max)` or `@Length(max)`; `text` with `@Lob` |
| `int`, `Integer`, `short`, `Short`, `byte`, `Byte`                         | `int`                                                                                                     |
| `long`, `Long`                                                             | `bigInt`                                                                                                  |
| `boolean`, `Boolean`                                                       | `boolean`                                                                                                 |
| `float`, `double` and their wrappers                                       | `float`                                                                                                   |
| `BigDecimal`                                                               | `decimal(38, 2)`, or `@Column(precision, scale)`, or `@Digits(integer, fraction)`                         |
| `BigInteger`                                                               | `decimal(38, 0)`                                                                                          |
| `char`, `Character`                                                        | `string` of 1                                                                                             |
| `LocalDate`, `java.sql.Date`                                               | `date`                                                                                                    |
| `LocalTime`, `OffsetTime`, `java.sql.Time`                                 | `time`                                                                                                    |
| `LocalDateTime`, `Instant`, `OffsetDateTime`, `ZonedDateTime`, `Timestamp` | `dateTime`                                                                                                |
| `java.util.Date`, `Calendar`                                               | `dateTime`, or `date` / `time` with `@Temporal`                                                           |
| `Duration`                                                                 | `duration`                                                                                                |
| `UUID`                                                                     | `uuid`                                                                                                    |
| `byte[]`, `Byte[]`, `Blob`, `@Lob byte[]`                                  | `bytes`                                                                                                   |
| `Clob`, `@Lob String`, `@Lob char[]`                                       | `text`                                                                                                    |
| `JsonNode`, `@JdbcTypeCode(SqlTypes.JSON)`, `@Type(...JsonType.class)`     | `json`                                                                                                    |
| `List<String>`, `String[]` without `@ElementCollection`                    | an array column (`arrayDepth` 1), as Hibernate 6 maps it                                                  |
| a Java `enum`                                                              | an enum of the model, see below                                                                           |
| anything else (your own class, `Object`, `Thread`)                         | an `unsupported` column with the Java type and a warning                                                  |

`@Column(columnDefinition)` is read for its type (`varchar(12)`, `text`, `jsonb`, `numeric(9,4)`), `not null`, `unique` and `default`; a definition the reader does not know warns and the column keeps the type of the Java field. An `AttributeConverter<X, Y>` found in the input gives the column the type of `Y` (`@Convert(converter = ...)`, or `@Converter(autoApply = true)` for every attribute of type `X`), with a warning that the converter is not run.

**Nullability** (highest wins): `@Id` and every part of a composite key are NOT NULL; then `@Column(nullable)`; then `@Basic(optional = false)` and `@NotNull` (Hibernate's `@NotNull` makes the column NOT NULL, `@NotBlank` and `@NotEmpty` add nothing to its DDL, so they are ignored); then the Java type: a primitive (`int`, `boolean`, `char`) is NOT NULL and a wrapper or reference type allows null. A relationship is required with `optional = false`, `@JoinColumn(nullable = false)` or `@NotNull`, and a shared key (`@MapsId`).

**Length** (highest wins): `@Column(length)`, then `@Size(max)` / `@Length(max)`, then 255 for a `String`. **Precision:** `@Column(precision, scale)`, then `@Digits`, then Hibernate's 38 and 2.

**Defaults.** Only a database default counts: `@ColumnDefault("...")` (read as SQL: `0`, `'draft'`, `CURRENT_TIMESTAMP` and `random_uuid()` become a literal, a string, `now` and a UUID; anything else is a database expression) and the `default` of a `columnDefinition`. A field initializer (`int count = 5;`) is not a database default. `@CreationTimestamp` and Spring Data's `@CreatedDate` make the default `now`; `@UpdateTimestamp` and `@LastModifiedDate` make the column refreshed on every save; `@UuidGenerator` is a generated UUID. `@GeneratedValue` on an integer key is an auto-increment column (`IDENTITY` and `AUTO` silently, `SEQUENCE` and `TABLE` with a warning that the key comes from a sequence or table), on a `UUID` a generated UUID.

**Enums.** A Java `enum` becomes an enum of the model. `@Enumerated(EnumType.STRING)` stores the names; without it JPA stores the ordinal number (`ORDINAL`), so the enum is read with the numbers as values and a warning, because writers that create enum types will store text instead. `@ColumnDefault("'Draft'")` is the enum default.

**Embeddables** (`@Embedded`, or a field whose class is `@Embeddable`) are value objects, and the shared model has no such type. They are flattened into the owner as plain columns named `<attribute><Name>` (`homeStreet`), also nested (`homeGeoLat`), with the JPA column names. `@AttributeOverride` is applied at any depth (`name = "geo.lat"`), also on the entity class for inherited attributes; its `@Column` replaces the attribute's own. `@AssociationOverride` is not applied and warns. What is lost: the class itself (its name, its methods and its other uses), and the fact that the columns belong together. Each flattened value object gets a warning that names the entity, the attribute and the columns, for example `Home.address: the embedded Address was flattened into the columns address.street, address.city; ...`. The embeddable of a composite key is not a value object in this sense and gets no warning (see Keys).

**Keys.** `@Id` is the primary key; several `@Id` attributes (with `@IdClass`) or an `@EmbeddedId` are a composite key. Both forms are read as the same key: the parts of an `@EmbeddedId` are named by their attribute in the key class (`sku`, not `idSku`), exactly like the `@Id` attributes of an `@IdClass`. Only when a part would get the same name as another attribute of the entity does it keep the name of the `@EmbeddedId` attribute as a prefix (`idLeft`). A key class can hold a relationship (`@ManyToOne` inside the `@Embeddable`) and nested embeddables, and `@AttributeOverride` on the `@EmbeddedId` attribute renames the key columns. `@MapsId` and an `@Id` on a relationship (a derived identity) make the foreign key the key: the relationship carries the key column and the duplicate id attribute is folded into it. A second, read-only mapping of a foreign key column (`@Column(name = "author_id", insertable = false, updatable = false) Long authorId`) is also folded into the relationship.

**Relationships.** `@ManyToOne` and `@OneToOne` are foreign keys on the declaring table (a one-to-one is unique), named by `@JoinColumn` or `<attribute>_<key>`; `referencedColumnName` may name a unique column that is not the key; several `@JoinColumn`s are a composite foreign key. The delete action is `@OnDelete(action = ...)` (`CASCADE`, `SET_NULL`, `SET_DEFAULT`, `RESTRICT`, `NO_ACTION`); without it the database has none, which is `noAction`. `cascade = REMOVE/ALL` and `orphanRemoval` happen in the ORM only and add no `ON DELETE CASCADE`, which a warning says. `@JoinColumn(foreignKey = @ForeignKey(name = ...))` names the constraint. The inverse side (`mappedBy`) adds nothing: it becomes the related name of the owning side, so `Post.author` knows its reverse accessor is `User.posts`. A `@ManyToMany` is one many-to-many relation on the owning side; its join table is derived by the other formats. A unidirectional `@OneToMany` with `@JoinColumn` is a foreign key on the target's table; without it Hibernate uses a join table and it is read as a many-to-many (that each target belongs to one owner is not represented, with a warning).

**Inheritance.** A `@MappedSuperclass` is copied into each entity that extends it, superclass attributes first; a generic one (`Base<ID>`) takes the type its subclass gives. For entity hierarchies `@Inheritance` decides, and each case warns: `SINGLE_TABLE` (the default) is one model with the columns of every class, a discriminator column (`DTYPE`, or `@DiscriminatorColumn`) and the discriminator values listed in the warning, a column that a subclass declares NOT NULL stays NOT NULL as in Hibernate's DDL; `JOINED` is one model per class, the subclass key being a foreign key to its parent (a one-to-one primary key relation); `TABLE_PER_CLASS` is an independent table per concrete class with the inherited columns.

**Element collections.** An `@ElementCollection` of basic values (`List<String>`, `Set<Role>`) is read as a child table named `<entity>_<attribute>` (or `@CollectionTable`) with a foreign key to the owner and the value column; its primary key is the owner and the order column with `@OrderColumn`, the owner and the value for a `Set` whose value column is NOT NULL, and none otherwise, as in Hibernate. Collections of embeddables and `Map`s are skipped with a warning.

**Indexes and constraints.** `@Table(uniqueConstraints = ...)` and `@Table(indexes = ...)` (`columnList` with `ASC` / `DESC`, `unique`, `name`), `@Column(unique = true)` and `@NaturalId` (one attribute is unique, several are one unique index). An unnamed unique constraint over one column is the unique flag of that column. Columns are named by column name; the index entry names the field or relationship that owns the column.

## Writing

`--to jpa` writes a multi-file output: one `@Entity` class per model, one Java `enum` per enum and, where needed, an `AttributeConverter` and a key class (an `@IdClass` class, or an `@Embeddable` class with `--jpa-key embedded`). Files go below `-o`, in the folder of the Java package (`app/models/Post.java`).

```bash
ormbridge convert -i schema.prisma --to jpa -o src/main/java
ormbridge convert -i schema.prisma --to jpa --style javax --namespace com.shop.data -o src/main/java
ormbridge convert -i schema.prisma --to jpa --jpa-key embedded --lombok -o src/main/java
```

| Option               | Effect                                                                                                                                                                                                                                                                                                                                                                                                |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--style jakarta`    | The default. `jakarta.persistence`, Hibernate 6, Spring Boot 3. Uses `@JdbcTypeCode(SqlTypes.JSON)`, `@UuidGenerator`, `@GeneratedColumn` and every `@OnDelete` action.                                                                                                                                                                                                                               |
| `--style javax`      | `javax.persistence`, Hibernate 5, Spring Boot 2. Where Hibernate 5 has no mapping the closest type is written and a warning says so (JSON, arrays, generated columns, `@OnDelete` other than CASCADE).                                                                                                                                                                                                |
| `--jpa-key <mode>`   | How a composite primary key is written. `idclass` (the default) writes an `@IdClass` class. `embedded` writes an `@Embeddable` key class and one `@EmbeddedId` on the entity (see below). A key of one column is always a plain `@Id`. The config file key is `jpaKey`.                                                                                                                               |
| `--lombok`           | Writes `@Getter`, `@Setter` and `@NoArgsConstructor` instead of hand-written getters and setters, and `@AllArgsConstructor` and `@EqualsAndHashCode` on key classes (see below). The project needs Lombok. It works with both styles and both key modes. The config file key is `lombok`.                                                                                                             |
| `--namespace <name>` | The Java package of every generated class (default `app.models`). It must be a dotted name of Java identifiers; anything else is an `INVALID_OPTION` error.                                                                                                                                                                                                                                           |
| `--provider <name>`  | Picks the column types and the SQL of defaults: `text` columns, `@Lob`, booleans as `true` or `1`, expression defaults in parentheses for MySQL and SQLite. Default `postgresql`. `cockroachdb` writes `Long` for generated integer keys, JSON or text for hstore and ranges, and names `org.hibernate.dialect.CockroachDialect` (Hibernate 6) or `CockroachDB201Dialect` (Hibernate 5) in a warning. |
| `--naming <mode>`    | `preserve` keeps the database names, `normalize` applies the fresh-schema style (singular snake_case tables, UUID keys, `created_at` / `updated_at`).                                                                                                                                                                                                                                                 |
| `--no-header`        | Leaves out the `// <auto-generated>` comment at the top of every file.                                                                                                                                                                                                                                                                                                                                |

By default the classes are plain: private fields, getters and setters. They compile against the persistence API and Hibernate's annotations (`hibernate-core`) alone; Jackson is needed at run time for the JSON columns of Hibernate 6. With `--lombok` they need Lombok as well (see below). Without `--jpa-key` and `--lombok` the output is the same as in earlier versions. An unknown `--style` is an error that lists the values of the format (`Invalid --style value "fluent" for the jpa format. Expected one of: jakarta, javax.`).

Every table, column, join column and join table is written with its name (`@Table(name)`, `@Column(name)`, `@JoinColumn(name, referencedColumnName)`), so the schema does not depend on a naming strategy.

### What is written

| IR                                             | Java                                                                                                                                                                           |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| primary key, auto-increment                    | `@Id @GeneratedValue(strategy = GenerationType.IDENTITY)` on an `Integer` or `Long`                                                                                            |
| primary key, UUID default                      | `@Id @GeneratedValue(strategy = GenerationType.UUID)`; with `javax` `@GeneratedValue(generator = "uuid2")` and `@GenericGenerator`                                             |
| composite primary key                          | `@IdClass(PostTagId.class)` and an `@Id` on every column; a relationship that is part of the key is an `@Id @ManyToOne` and the id class holds the key of its target           |
| composite primary key, `--jpa-key embedded`    | `@EmbeddedId PostTagId id` and an `@Embeddable` key class that holds the columns; a relationship that is part of the key is a `@MapsId("post") @ManyToOne`                     |
| shared primary key (one-to-one primary key)    | `@Id @OneToOne @JoinColumn` (the entity is `Serializable`, as Hibernate 5 requires)                                                                                            |
| no primary key                                 | one required column becomes the `@Id`, with a warning                                                                                                                          |
| `string`                                       | `String` with `@Column(length)`; without a length `text` on PostgreSQL and 255 characters elsewhere                                                                            |
| `text`                                         | `String` with `columnDefinition = "text"` on PostgreSQL, `@Lob` elsewhere                                                                                                      |
| `int`, `bigInt`, `float`, `boolean`            | `int`, `long`, `double`, `boolean` when required and without a database-only default, otherwise `Integer`, `Long`, `Double`, `Boolean`                                         |
| `decimal`                                      | `BigDecimal` with `@Column(precision, scale)`                                                                                                                                  |
| `dateTime`, `date`, `time`, `duration`         | `LocalDateTime` (`OffsetDateTime` when the source says `timestamptz`), `LocalDate`, `LocalTime`, `Duration`                                                                    |
| `uuid`, `bytes`                                | `UUID`; `byte[]` (with `@Lob` outside PostgreSQL)                                                                                                                              |
| `json`                                         | `Map<String, Object>` with `@JdbcTypeCode(SqlTypes.JSON)`; a `String` with the column definition `jsonb` / `json` on `javax`                                                   |
| arrays                                         | `String[]`, `Integer[]` on PostgreSQL; a JSON array elsewhere; a `String` with the column definition `text[]` on `javax`                                                       |
| `ipAddress`                                    | `InetAddress` with `@JdbcTypeCode(SqlTypes.INET)` on PostgreSQL, a `String` of 45 characters elsewhere                                                                         |
| enum, names equal the stored values            | a Java `enum` and `@Enumerated(EnumType.STRING)`                                                                                                                               |
| enum, stored values are positions `0, 1, 2`    | `@Enumerated(EnumType.ORDINAL)`                                                                                                                                                |
| enum, other stored values                      | constants that carry the value (`DRAFT("draft")`), a `PostStatusConverter` (`AttributeConverter<PostStatus, String>`) and `@Convert(converter = ...)`                          |
| default                                        | `@ColumnDefault("...")` and, for a literal or `now`, the field initializer (`private int viewCount = 0;`); a database expression sets no initializer and adds `@DynamicInsert` |
| `now` default on `created_at`, `isAutoUpdated` | `@CreationTimestamp`, `@UpdateTimestamp`                                                                                                                                       |
| UUID default on a column that is not the key   | `@UuidGenerator`                                                                                                                                                               |
| generated column                               | `@GeneratedColumn("expression")` with a read-only `@Column` (`jakarta` only)                                                                                                   |
| unique column, unique and plain indexes        | `@Column(unique = true)`, `@Table(uniqueConstraints, indexes)` (`DESC` kept in `columnList`)                                                                                   |
| foreign key, one-to-one                        | `@ManyToOne` / `@OneToOne(optional, fetch = LAZY)` with `@JoinColumn(name, referencedColumnName, nullable, foreignKey = @ForeignKey(name))`                                    |
| `onDelete`                                     | `@OnDelete(action = OnDeleteAction.X)` (CASCADE, SET_NULL, SET_DEFAULT, RESTRICT; `javax` keeps CASCADE only)                                                                  |
| reverse side (`relatedName`)                   | `@OneToMany(mappedBy)` with a `List`, `@OneToOne(mappedBy)`, `@ManyToMany(mappedBy)` with a `Set`                                                                              |
| many-to-many                                   | `@ManyToMany @JoinTable(name = "<table>_<field>", joinColumns, inverseJoinColumns)` with a `Set` (`from_` / `to_` columns for a self reference)                                |
| composite foreign key                          | `@ManyToOne @JoinColumns({...})` with `insertable = false, updatable = false` next to the scalar columns, which stay ordinary attributes                                       |
| schema                                         | `@Table(schema = ...)`                                                                                                                                                         |

**Composite keys: `@IdClass` or `@EmbeddedId`.** By default the entity keeps one `@Id` per column in the order of the key and the id class (`<Entity>Id`, `Serializable`, with `equals` and `hashCode`) repeats them. This keeps the columns flat, so the entity looks like the model.

With `--jpa-key embedded` the key columns move into an `@Embeddable` class with the same name (`<Entity>Id`). It implements `Serializable`, has a `@Column` on every part, a no-argument constructor, an all-argument constructor, getters, setters, `equals` and `hashCode`. The entity gets one attribute `@EmbeddedId private <Entity>Id id;` (named `id2` if a column is already called `id`). A relationship that is part of the key stays on the entity as `@MapsId("<attribute>") @ManyToOne`; the key class repeats its foreign key column and holds the key of its target. In both naming modes the key class is called `<Entity>Id` and follows `--namespace`; `--naming` changes only the table and column names, as it does everywhere. Choose `embedded` when you want to load a row by one key object (`repository.findById(new PostTagId(...))`) or when the key class is shared with other code.

Both forms create the same tables, and the reader reads both back as the same key. A key of one column is always a plain `@Id`, because there is nothing to embed.

**Lombok (`--lombok`).** Each entity gets `@Getter`, `@Setter` and `@NoArgsConstructor` and no accessor methods. A key class gets `@NoArgsConstructor`, `@AllArgsConstructor` and `@EqualsAndHashCode` instead of its constructors, `equals` and `hashCode` (an `@Embeddable` key class also gets `@Getter` and `@Setter`). Enums and converters are unchanged. The imports are `lombok.*` for both `jakarta` and `javax` output. The names of the accessors are the ones Lombok makes, which are the ones the plain output writes, including `isActive()` for a `boolean` and `getActive()` for a `Boolean`. Add Lombok to the build (`org.projectlombok:lombok`, compile-only, as an annotation processor) before you compile the output.

**Defaults and Hibernate.** The database default is declared with `@ColumnDefault`, but Hibernate inserts every column of the entity, null included, so a default only applies when the property is left out of the insert. Literal and `now` defaults therefore also set the field initializer, so a new object already carries the value. A default that only the database can compute leaves the property null; the class gets `@DynamicInsert` (null properties are left out of the insert) and Hibernate's nullability check must not reject the null: Bean Validation on the class path (Spring Boot's validation starter) or `hibernate.check_nullability=false`. A `now` default is `@CreationTimestamp` only on a column named like a creation time (`created_at`), because Hibernate overwrites such a column on every insert.

**Warnings** (named by model and field, never silent): ON UPDATE actions, index types, clustering, prefix lengths and operator classes, full-text indexes, hstore and range columns, `Unsupported` types (written as a `String` with the column definition), client-generated defaults (`cuid()`), auto-increment on a column that is not the key, computed columns on Hibernate 5 or with a Python expression, JSON, arrays and UUID defaults on Hibernate 5, `ON DELETE` actions other than CASCADE on Hibernate 5, unbounded strings outside PostgreSQL, views (mapped `@Immutable`; Hibernate would create a table of that name if it manages the schema), a model without a key, a relation to a model that is missing, and class or enum names that clash with the types the generated code imports (`Table` becomes `TableEntity`).

**Not written.** `@Version` (the IR has no optimistic-locking column), cascade types, fetch strategies other than LAZY on to-one relations, inheritance (the IR has none), Bean Validation annotations, Spring Data annotations, other Lombok annotations (`@Data`, `@Builder`, `@ToString`) and `@Embeddable` value objects (the IR only knows columns, so the writer uses `@Embeddable` for composite keys only).

**Round trip.** `parse(emit(x))` equals `x` for the canonical schema of every format apart from what the other format already loses (enum labels, Django's enum length) and, with `javax`, the `ON DELETE` actions Hibernate 5 cannot express. The reader changed in one place for this: an `AttributeConverter<Enum, String|Integer>` named by `@Convert` on an enum whose constants carry the stored value as their only constructor argument is read with those values.

**Checked against Hibernate.** When Java 17 and Maven are installed and `JPA_DIR` is set, `test/jpa-emitter-verify.test.ts` writes the canonical schema of every format, the larger extras, the IR fixtures and the reader's own fixtures in both styles and both naming modes, compiles them with `-Xlint:all -Werror`, lets Hibernate 6.4 (`jakarta`) and Hibernate 5.6 (`javax`) create the schema in H2, compares tables, columns, nullability, keys, unique keys, indexes and foreign keys with the IR, and saves a row into every table through the entity classes to check defaults, enum values, generated keys and `@UpdateTimestamp`. The same run also writes every schema with embedded keys and Lombok accessors (both styles and both naming modes, and each option alone): the compiler runs Lombok as an annotation processor, Hibernate creates the same tables, and one row with an embedded key is saved, loaded again by its key object and checked for `equals` and `hashCode`. The output for the other providers is compiled too.

## Limitations and warnings

Warnings appear on stderr as `warning: <message>`. Real examples:

- `Sample.color: the enum Color is stored as its ordinal number (the default of @Enumerated); it was read as an enum with the numbers as values, and writers that create enum types will store text instead. Use @Enumerated(EnumType.STRING) to store the names.`
- `Book.authors: the join table "Book_Author" (columns Book_id, authors_id) is not preserved by name; formats that derive join tables will use "Book_authors" (columns book_id, author_id).`
- `Vehicle: Car, Truck extend Vehicle in one table (single table inheritance). The hierarchy was read as a single model with the columns of every class and the discriminator column "kind" (values: V = Vehicle, C = Car, T = Truck); the subclasses are not separate models. ...`
- `Parent.items: cascade ALL deletes children through the ORM only; it adds no ON DELETE CASCADE to the foreign key, which is written as read (add @OnDelete(action = OnDeleteAction.CASCADE) on the owning side for that).`
- `Ledger: the superclass AbstractPersistable is not in the input, so the attributes it declares are not read.` A base class from a library cannot be read; copy it into the input.
- `Sample.version: the @Version attribute is Hibernate's optimistic-locking counter; it was read as an ordinary column.`
- Reported, each with a warning naming the class and attribute: `@Formula` (no column), `@Version`, `@Comment`, `@Check`, `@SecondaryTable` (everything is read into the primary table), `@Subselect` (the entity is skipped), `@SqlResultSetMapping`, `@TenantId`, Envers `@Audited`, `@AssociationOverride`, `@Any` / `@ManyToAny`, converters (not run), custom `@Type` classes, `Optional` fields and `Map`s without `@ElementCollection` (skipped), sequence and table generators, attributes whose type has no column type, relationships to types that are not in the input, and embedded types that are not in the input.
- Not part of the schema and ignored silently: named queries, `@Filter`, `@Where`, `@SQLDelete`, `@Cache`, `@EntityListeners`, `fetch`, `@OrderBy`, lazy loading hints and field initializers.
- Not seen: `orm.xml`, `persistence.xml` and `hbm.xml` mappings, Kotlin and Groovy entities, `application.properties` (naming strategies, `spring.jpa.*`), classes that exist only in a dependency, and anything computed at run time. Migrations (Flyway, Liquibase) are not replayed.

See [jpa to prisma](../CONVERSION_MATRIX.md#jpa--prisma), [jpa to django](../CONVERSION_MATRIX.md#jpa--django), [jpa to typeorm](../CONVERSION_MATRIX.md#jpa--typeorm), [jpa to sql](../CONVERSION_MATRIX.md#jpa--sql) and [what jpa cannot express](../CONVERSION_MATRIX.md#what-jpa-cannot-express).

The reader is checked against the real library: when Java 17 and Maven are installed and `JPA_DIR` is set, the tests build `test/tools/jpa-verify` (Hibernate ORM 6.4 with H2), let Hibernate create the schema of every fixture (`hbm2ddl.auto=create`) and compare tables, columns, nullability, keys, indexes and foreign keys with what the parser read (see [test/README.md](../../test/README.md)). The fixtures cover the canonical blog, every column type, the three inheritance strategies, composite keys, `@MapsId`, embeddables and overrides, join tables, element collections, and the `javax` (imports rewritten for Hibernate 6), property access, Lombok and Spring Data auditing variants.

## Programmatic API

```ts
import {
  convertText,
  emitJpa,
  parseJpa,
  type ConvertResult,
  type IrSchema,
  type Result,
} from 'ormbridge';

declare const postClass: string;
declare const userClass: string;

// Hibernate / JPA -> Prisma, in memory.
const converted: Result<ConvertResult> = await convertText(
  [
    { path: 'src/main/java/blog/Post.java', text: postClass },
    { path: 'src/main/java/blog/User.java', text: userClass },
  ],
  {
    from: 'jpa',
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
const parsed: Result<IrSchema> = await parseJpa(
  [{ path: 'src/main/java/blog/Post.java', text: postClass }],
  { appLabel: 'app' }
);
if (parsed.ok) {
  console.log(parsed.value.models.map((model) => model.tableName));
  console.log(parsed.value.warnings);

  // IR -> Hibernate 5 entities: a map of relative paths to Java source, and the warnings.
  const written = emitJpa(parsed.value, {
    provider: 'postgresql',
    naming: 'preserve',
    style: 'javax',
    packageName: 'com.shop.data',
    keyMode: 'embedded', // '@EmbeddedId' key classes; the default is 'idclass'
    lombok: true, // @Getter and @Setter instead of accessors; the default is false
  });
  console.log(Object.keys(written.files)); // ['com/shop/data/Post.java', ...]
}
```

`emitJpa` returns the files and the warnings and never throws; through `convertText` (`to: 'jpa'`, with `style`, `namespace`, `jpaKey` and `lombok`) an invalid style, package or key mode is an `INVALID_OPTION` error. `JPA_KEY_MODES` and `isJpaKeyMode` are exported too.

`parseJpa` returns a `Result` and never throws: input without entities is an error with the code `NO_MODELS_FOUND`, and constructs it cannot read are warnings in `schema.warnings`. `isSkippedJpaPath(path)` tells whether a path is one of the build-output, test, generated or migration files the reader skips.
