# Spring Data Neo4j

The `sdn` format writes Java classes for [Spring Data Neo4j](https://spring.io/projects/spring-data-neo4j) 7, the version for Spring Boot 3. Each model becomes an `@Node` class, each column a field, and each foreign key an `@Relationship` field. It is write-only: it works with `--to` and never with `--from`. It claims no file extension, so always pass `--to sdn`. The output is a folder of `.java` files, one for each class, enum and converter.

The labels and relationship types are the same as in the [Neo4j](neo4j.md) Cypher output, so the files describe the same graph. Spring Data Neo4j does not create constraints or indexes, so use the Cypher file for those.

## Try it

The example project is [`examples/sdn`](../../examples/sdn/). It converts the shared Prisma schema `examples/schema/schema.prisma` into `generated/`:

```sh
cd examples/sdn
npx ormbridge convert           # writes generated/app/models/*.java
npx ormbridge convert --check   # exits with code 3 if a file is missing or differs
```

Inside this repository, run `npm run build` once and use `node ../../dist/cli.js convert` instead. Without the config file:

```sh
npx ormbridge convert -i ../schema/schema.prisma --from prisma --to sdn -o generated
```

Copy the files into `src/main/java`. They import only `org.springframework.data.neo4j`, `org.neo4j.driver` and `java.*` classes. There are no `javax` imports and no Lombok.

## Reading: not supported

There is no Spring Data Neo4j reader, and no Neo4j reader. A graph schema does not say how many nodes a relationship may join, or whether it is required. Reading it back would lose too much.

## Writing

| Source                         | Spring Data Neo4j                                                                   |
| ------------------------------ | ----------------------------------------------------------------------------------- |
| Model                          | `@Node("Label")` class, named like the label (`blog_posts` gives `BlogPost`)        |
| Column                         | Private field with a getter and a setter; `@Property("key")` when the names differ  |
| Primary key                    | `@Id` (see [Identifiers](#identifiers))                                             |
| Enum                           | Java `enum`, with a converter when the stored values differ from the constant names |
| Foreign key, relation          | `@Relationship(type, direction)` field on the owner and on the target               |
| Join table (pure many-to-many) | One relationship; extra columns become `@RelationshipProperties` classes            |
| Unique column, index           | Not written (see [Constraints](#constraints-and-indexes))                           |

```java
@Node("Post")
public class Post {
  @Id
  @GeneratedValue
  private Long id;

  @Property("view_count")
  private Integer viewCount = 0;

  @Relationship(type = "AUTHOR", direction = Relationship.Direction.OUTGOING)
  private User author;

  @Relationship(type = "TAGS", direction = Relationship.Direction.OUTGOING)
  private List<Tag> tags = new ArrayList<>();
  // getters and setters follow
}
```

### Names and package

Field names are camelCase. A Java keyword gets an underscore, and a name that is taken gets a number, with a warning. `--namespace` sets the Java package (default `app.models`), and the files are written below `-o` in the matching folders. A model called `Node`, `Id` or `Relationship` would hide an import, so its class is called `NodeEntity` and `@Node("Node")` keeps the label.

### Naming modes

- `--naming preserve` (default) keeps the column names as property keys, such as `view_count`. The field is `viewCount` with `@Property("view_count")`.
- `--naming normalize` uses camelCase property keys, such as `viewCount`, which is the Neo4j habit, so most fields need no `@Property`. It also applies the usual fresh-schema changes (UUID keys, `created_at` and `updated_at`). Labels do not change.

## Identifiers

Spring Data Neo4j needs one `@Id` on every node. The writer follows the key of the source:

| Source key                                             | Spring Data Neo4j                                                                              |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| Generated integer (auto-increment)                     | `@Id @GeneratedValue Long`: Neo4j's internal node id, with a warning                           |
| UUID with a generated default                          | `@Id @GeneratedValue(UUIDStringGenerator.class) String`                                        |
| Any other single column                                | `@Id` on that field, assigned by you                                                           |
| Composite key, no key, or a key that is a relationship | A generated internal id called `graphId`; the key columns are plain properties, with a warning |

The internal id is not stored as a property, so a column called `id` that you loaded from the old database is not found by it, and the internal id can change when the database is rebuilt. Spring Data Neo4j 7 also logs a deprecation warning for it. Use `--naming normalize`, which makes UUID keys, if you can.

## Types

| Source type                       | Java type                                                                     |
| --------------------------------- | ----------------------------------------------------------------------------- |
| String, text, IP address          | `String`                                                                      |
| UUID                              | `UUID`                                                                        |
| Integer, big integer              | `Integer`, `Long`                                                             |
| Float                             | `Double`                                                                      |
| Boolean                           | `Boolean`                                                                     |
| Decimal                           | `BigDecimal` (stored as a string, so no digit is lost)                        |
| Date                              | `LocalDate`                                                                   |
| Date and time                     | `ZonedDateTime` (`LocalDateTime` for `timestamp` and `datetime` native types) |
| Time, duration                    | `LocalTime` (`OffsetTime` for `timetz`), `Duration`                           |
| Binary                            | `byte[]`                                                                      |
| Array                             | `List<T>`                                                                     |
| JSON, hstore, range, unknown type | `String`, with a warning                                                      |
| Array of arrays, array of binary  | `String`, with a warning                                                      |
| Enum                              | Java `enum`                                                                   |

All types are boxed (`Integer`, not `int`), because a node can lack a property.

An enum is stored by constant name. When the stored values are different (`draft` for `DRAFT`, or numbers), the writer adds a converter class that implements `Neo4jPersistentPropertyConverter`, and the field gets `@ConvertWith`. Spring Data Neo4j converts a whole property, so an array of such enums is a `List<String>` of the stored values, with a warning.

## Defaults

A text, number, boolean or enum default is a Java field initializer. It applies to new objects only; a node read from the database without that property keeps the initial value too. Auto-increment, the current time, generated UUIDs (other than the key), database expressions, `cuid()` and defaults of arrays are dropped with a warning that names the model and field.

Required columns cannot be expressed, so the class comment lists them.

## Relationships

Each foreign key becomes two fields, one on each class:

```java
// Post
@Relationship(type = "AUTHOR", direction = Relationship.Direction.OUTGOING)
private User author;

// User
@Relationship(type = "AUTHOR", direction = Relationship.Direction.INCOMING)
private List<Post> posts = new ArrayList<>();
```

The type is the relation field name in UPPER_SNAKE_CASE. The owner has a single value, and the target has a `List` (a single value for a one-to-one key). The reverse side takes the name of the `related_name` in the source, or the plural of the owner (`posts`). If that name is taken, the writer adds a number and a warning. Java types cannot say that a relationship is required, so that is lost.

The foreign key columns stay as plain properties, as they do in the Cypher output. Nothing ties them to the relationship, so keep them in step yourself, or leave them out of your code. Spring Data Neo4j does not enforce delete actions such as `cascade`. Each foreign key gets a warning that says so.

### Join tables

A table is a pure join table when it has exactly two required foreign keys, nothing else points at it, and either the two keys are its primary key or it has its own key plus a unique pair of the two keys. That is how Django, Prisma and the other formats write a many-to-many field.

A join table does not become a node class. It becomes one relationship, such as `(:Post)-[:TAGS]->(:Tag)`.

- The key of the join table is dropped, with a warning.
- Other columns become `@RelationshipProperties` classes. Spring Data Neo4j needs one for each direction, because `@TargetNode` is the node at the other end: `EnrollmentCourse` (target `Course`) on `Student`, and `EnrollmentStudent` (target `Student`) on `Course`. Each has a `@RelationshipId`.
- Unique columns and indexes of the join table cannot be written (see below), and are listed in a warning.

A many-to-many field that the source declares on both sides is written once.

## Constraints and indexes

Spring Data Neo4j creates no constraints and no indexes, and has no maximum length for a string. So uniqueness, indexes and lengths are not written. For each model, one warning lists the constraints and indexes of the source, and the class comment says the same. Create them with the Cypher writer: `ormbridge convert --to neo4j`.

## Warnings

Everything that is dropped or approximated gets a warning that names the model and the field. These are the main cases:

- The identifier choices above.
- Constraints, indexes and maximum lengths.
- Defaults that cannot be written, auto-increment keys, generated columns and columns that refresh on every save.
- JSON, hstore, range, nested array and unsupported database types.
- Each foreign key, because Spring Data Neo4j does not enforce the delete action and the property is not tied to the relationship.
- Join table keys and indexes.
- Index methods other than B-tree, and indexes that name a column that does not exist.
- Views and database schemas.

## How it is checked

The test suite compiles every file with the JDK compiler, with every lint warning as an error, against Spring Data Neo4j 7.5.4. It builds the real `Neo4jMappingContext` and compares the labels, identifiers, graph property names, relationship types, directions, targets, lists and relationship properties with the source schema, for the canonical schemas and several larger fixtures in both naming modes. With a Neo4j 5 Community server, it also saves nodes and relationships through `Neo4jTemplate`, reads them back, and checks the stored labels, keys, enum values and relationship properties with Cypher. The tests need `SDN_DIR`, Java 17 and Maven (and `NEO4J_URL` or `NEO4J_DOCKER=1` for the server part), and are skipped with a reason otherwise. See [`test/README.md`](../../test/README.md).

When you save and read entities yourself outside Spring Boot, set the Cypher dialect for Neo4j 5 (`Dialect.NEO4J_5`) on the `Neo4jTemplate`, as Spring Boot does for you. Without it the derived queries compare ids as strings and find nothing.

## Not supported yet

- Reading Java entities or a graph schema.
- Spring Data Neo4j 6 and the reactive classes. The output targets version 7 with the imperative API.
- Lombok, records and Kotlin. The classes use plain getters and setters.
- `@Version`, `@CompositeProperty`, dynamic relationships and labels from `@DynamicLabels`.
- Repositories and Spring configuration.
