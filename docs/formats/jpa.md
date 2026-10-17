# Hibernate / JPA

ormbridge reads Hibernate and JPA entities written in Java (`ormbridge formats` lists `jpa` as `read`). It cannot write them yet: the writer is the next item on the [roadmap](../../ROADMAP.md). It claims no file extension, because `.java` is far too generic: always pass `--from jpa`. Without it a `.java` input is read as Django and fails with `No concrete Django models were found in: ...`. The Java is parsed statically with tree-sitter; nothing is compiled or run, so no JDK, Maven, Gradle or database is needed.

A JPA model is the entity classes and their annotations, and ormbridge reads exactly that:

- **Entity classes** (`@Entity`) with their fields, or getters, and the mapping annotations (`@Table`, `@Id`, `@Column`, `@ManyToOne`, `@JoinColumn`, ...).
- **Mapped superclasses and embeddables** (`@MappedSuperclass`, `@Embeddable`), which are flattened into the entities that use them.
- **Hibernate annotations** that change the schema (`@ColumnDefault`, `@JdbcTypeCode`, `@OnDelete`, `@CreationTimestamp`, `@NaturalId`, ...) and **Bean Validation** hints (`@NotNull`, `@Size`, `@Length`, `@Digits`).

Not read: `orm.xml`, `persistence.xml` and `hbm.xml` mapping files (a model mapped in XML is not seen), and Kotlin or Groovy sources. Target: JPA 2.2 and 3 (`jakarta.persistence`), Hibernate 5 and 6, and the legacy `javax.persistence` package. Annotations are matched by their simple name, so wildcard imports (`import jakarta.persistence.*;`) and fully qualified names (`@jakarta.persistence.Entity`) work. The reader is checked against Hibernate ORM 6.4 (see the end of this page).

## Try it

The example in [`examples/jpa`](../../examples/jpa/) has one conversion in `ormbridge.config.json`:

```bash
cd examples/jpa
npx ormbridge convert            # reads models/ and writes prisma/schema.prisma
npx ormbridge convert --check
```

| Conversion | Input    | Output                 |
| ---------- | -------- | ---------------------- |
| `from-jpa` | `models` | `prisma/schema.prisma` |

`models/` is a hand-written folder: entity classes, a mapped superclass and an enum. Inside this repository run `node ../../dist/cli.js convert` after `npm run build`. Without the config file: `ormbridge convert -i models -f jpa -t prisma -o prisma/schema.prisma`.

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

**Embeddables** (`@Embedded`, or a field whose class is `@Embeddable`) are flattened into the owner as `<attribute><Name>` (`homeStreet`), also nested (`homeGeoLat`), with the JPA column names. `@AttributeOverride` is applied at any depth (`name = "geo.lat"`), also on the entity class for inherited attributes; its `@Column` replaces the attribute's own. `@AssociationOverride` is not applied and warns.

**Keys.** `@Id` is the primary key; several `@Id` attributes (with `@IdClass`) or an `@EmbeddedId` are a composite key. `@MapsId` and an `@Id` on a relationship (a derived identity) make the foreign key the key: the relationship carries the key column and the duplicate id attribute is folded into it. A second, read-only mapping of a foreign key column (`@Column(name = "author_id", insertable = false, updatable = false) Long authorId`) is also folded into the relationship.

**Relationships.** `@ManyToOne` and `@OneToOne` are foreign keys on the declaring table (a one-to-one is unique), named by `@JoinColumn` or `<attribute>_<key>`; `referencedColumnName` may name a unique column that is not the key; several `@JoinColumn`s are a composite foreign key. The delete action is `@OnDelete(action = ...)` (`CASCADE`, `SET_NULL`, `SET_DEFAULT`, `RESTRICT`, `NO_ACTION`); without it the database has none, which is `noAction`. `cascade = REMOVE/ALL` and `orphanRemoval` happen in the ORM only and add no `ON DELETE CASCADE`, which a warning says. `@JoinColumn(foreignKey = @ForeignKey(name = ...))` names the constraint. The inverse side (`mappedBy`) adds nothing: it becomes the related name of the owning side, so `Post.author` knows its reverse accessor is `User.posts`. A `@ManyToMany` is one many-to-many relation on the owning side; its join table is derived by the other formats. A unidirectional `@OneToMany` with `@JoinColumn` is a foreign key on the target's table; without it Hibernate uses a join table and it is read as a many-to-many (that each target belongs to one owner is not represented, with a warning).

**Inheritance.** A `@MappedSuperclass` is copied into each entity that extends it, superclass attributes first; a generic one (`Base<ID>`) takes the type its subclass gives. For entity hierarchies `@Inheritance` decides, and each case warns: `SINGLE_TABLE` (the default) is one model with the columns of every class, a discriminator column (`DTYPE`, or `@DiscriminatorColumn`) and the discriminator values listed in the warning, a column that a subclass declares NOT NULL stays NOT NULL as in Hibernate's DDL; `JOINED` is one model per class, the subclass key being a foreign key to its parent (a one-to-one primary key relation); `TABLE_PER_CLASS` is an independent table per concrete class with the inherited columns.

**Element collections.** An `@ElementCollection` of basic values (`List<String>`, `Set<Role>`) is read as a child table named `<entity>_<attribute>` (or `@CollectionTable`) with a foreign key to the owner and the value column; its primary key is the owner and the order column with `@OrderColumn`, the owner and the value for a `Set` whose value column is NOT NULL, and none otherwise, as in Hibernate. Collections of embeddables and `Map`s are skipped with a warning.

**Indexes and constraints.** `@Table(uniqueConstraints = ...)` and `@Table(indexes = ...)` (`columnList` with `ASC` / `DESC`, `unique`, `name`), `@Column(unique = true)` and `@NaturalId` (one attribute is unique, several are one unique index). An unnamed unique constraint over one column is the unique flag of that column. Columns are named by column name; the index entry names the field or relationship that owns the column.

## Writing

Not supported yet. `--to jpa` fails with `The format "jpa" can only be used as an input`. Use the [conversion matrix](../CONVERSION_MATRIX.md) to see what survives when JPA entities are written to every other format. The writer is the next item on the [roadmap](../../ROADMAP.md).

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
}
```

`parseJpa` returns a `Result` and never throws: input without entities is an error with the code `NO_MODELS_FOUND`, and constructs it cannot read are warnings in `schema.warnings`. `isSkippedJpaPath(path)` tells whether a path is one of the build-output, test, generated or migration files the reader skips.
