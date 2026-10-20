# Neo4j

The `neo4j` format writes a Cypher schema for [Neo4j](https://neo4j.com). Each model becomes a node label, and the primary keys, unique columns and indexes become constraints and indexes. It is write-only: it works with `--to` and never with `--from`. It claims no file extension, so always pass `--to neo4j`. The output is a `.cypher` file.

The file holds schema statements only. It has no data. Foreign keys cannot be declared in Cypher, so they are written as comments. Read [Relationships](#relationships) before you use the file.

## Try it

The example project is [`examples/neo4j`](../../examples/neo4j/). It converts the shared Prisma schema `examples/schema/schema.prisma` into two files, one for each style:

```sh
cd examples/neo4j
npx ormbridge convert           # writes generated/schema.cypher and generated/schema.enterprise.cypher
npx ormbridge convert --check   # exits with code 3 if a file is missing or differs
```

Inside this repository, run `npm run build` once and use `node ../../dist/cli.js convert` instead. Without the config file:

```sh
npx ormbridge convert -i ../schema/schema.prisma --from prisma --to neo4j -o generated/schema.cypher
npx ormbridge convert -i ../schema/schema.prisma --from prisma --to neo4j --style enterprise -o generated/schema.enterprise.cypher
```

## Reading: not supported

There is no Neo4j reader. A graph schema does not say how many nodes a relationship may join, or whether it is required. Reading it back would lose too much.

## Writing

One file. It starts with a comment block, then has one section for each node label, then a section for the relationships.

| Source                         | Neo4j                                                                   |
| ------------------------------ | ----------------------------------------------------------------------- |
| Model                          | Node label, in PascalCase and singular (`blog_posts` gives `BlogPost`)  |
| Column                         | Property                                                                |
| Primary key                    | Uniqueness constraint (a composite key gets a composite constraint)     |
| Unique column, unique index    | Uniqueness constraint                                                   |
| One-to-one foreign key         | Uniqueness constraint on the foreign key property                       |
| Index                          | Range index (`CREATE INDEX`); a full-text index stays a full-text index |
| Foreign key, relation          | A comment block that describes the relationship                         |
| Join table (pure many-to-many) | One relationship comment, and no node label                             |
| Enum                           | `STRING` property, with the allowed values in a comment                 |

Every statement is one line and uses `IF NOT EXISTS`. You can run the file again and nothing changes.

```cypher
CREATE CONSTRAINT post_id_unique IF NOT EXISTS FOR (n:Post) REQUIRE n.id IS UNIQUE;
CREATE CONSTRAINT post_author_id_title_unique IF NOT EXISTS FOR (n:Post) REQUIRE (n.author_id, n.title) IS UNIQUE;
CREATE INDEX post_title_idx IF NOT EXISTS FOR (n:Post) ON (n.title);
```

### Names

Constraint and index names follow one pattern: the label, the properties and the kind, in snake_case. The kinds are `unique`, `key`, `required`, `type`, `idx` and `fulltext`. Neo4j shares one name space for constraints and indexes, so the writer adds a number when two names would match. Names from the source, such as `post_pub_status_idx`, are not used.

A label, property or name that is not a plain identifier (letters, digits and `_`, not starting with a digit) is wrapped in backticks. A backtick inside a name is doubled.

Two models can end up with the same label. The second one gets a number (`User2`) and a warning.

### Naming modes

- `--naming preserve` (default) keeps the column names as property keys, such as `public_id`.
- `--naming normalize` uses camelCase property keys, such as `publicId`, which is the Neo4j habit. It also applies the usual fresh-schema changes (UUID keys, `created_at` and `updated_at`). Labels do not change.

## Styles

`--style` picks which statements are written.

| Style                 | Meaning                                                                                                                                                       |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `community` (default) | Only what Neo4j Community Edition accepts. Required properties are listed in a comment.                                                                       |
| `enterprise`          | Adds `IS NOT NULL` constraints, `IS NODE KEY` for composite primary keys and property type constraints. Needs Neo4j Enterprise Edition, version 5.9 or later. |

With `enterprise`:

```cypher
CREATE CONSTRAINT post_title_required IF NOT EXISTS FOR (n:Post) REQUIRE n.title IS NOT NULL;
CREATE CONSTRAINT post_title_type IF NOT EXISTS FOR (n:Post) REQUIRE n.title IS :: STRING;
CREATE CONSTRAINT ledger_year_number_key IF NOT EXISTS FOR (n:Ledger) REQUIRE (n.year, n.number) IS NODE KEY;
```

With `community`, a composite primary key is a composite uniqueness constraint, and a comment says that `NODE KEY` needs Enterprise Edition. The same `--style` option is used by other formats. Only `community` and `enterprise` are valid for `neo4j`, and any other value is an error.

## Types

Each label section ends with a comment block that lists the Neo4j type of every property. In the `enterprise` style the types are also enforced.

| Source type                           | Neo4j type                                                                      |
| ------------------------------------- | ------------------------------------------------------------------------------- |
| Text, string, UUID, IP address        | `STRING`                                                                        |
| Integer, big integer                  | `INTEGER` (64-bit)                                                              |
| Float                                 | `FLOAT`                                                                         |
| Boolean                               | `BOOLEAN`                                                                       |
| Date                                  | `DATE`                                                                          |
| Date and time                         | `ZONED DATETIME` (`LOCAL DATETIME` for `timestamp` and `datetime` native types) |
| Time                                  | `LOCAL TIME` (`ZONED TIME` for a `timetz` native type)                          |
| Duration                              | `DURATION`                                                                      |
| Binary                                | Byte array (no type constraint, because Neo4j cannot name it)                   |
| Decimal                               | `STRING`, with a warning                                                        |
| JSON, hstore, range                   | `STRING`, with a warning                                                        |
| Database type with no equivalent      | `STRING`, with a warning                                                        |
| Enum                                  | `STRING`, with the allowed values in a comment                                  |
| Array                                 | `LIST<T NOT NULL>`                                                              |
| Array of arrays, array of byte arrays | `STRING`, with a warning                                                        |

Neo4j has no decimal type. A `STRING` keeps every digit. If you need to add the values up, use `FLOAT` or store whole cents in an `INTEGER`. A JSON value has to be stored as text, because a property cannot hold a map. Neo4j has no enum type, so nothing enforces the allowed values.

## Relationships

Cypher has no relationship schema. You cannot say that a `Post` must have an `AUTHOR`. So the writer does three things:

1. The foreign key columns stay as plain properties, for example `Post.author_id`. The header comment lists them.
2. Each foreign key and relation gets a comment block that names the relationship, the cardinality, whether it is required and the delete action. The delete action is a note: Neo4j does not enforce it.
3. Each block has a `MATCH ... MERGE` query that creates the relationships from the foreign key properties.

```cypher
// (:Post)-[:AUTHOR]->(:User)
//   many Post to one User, required.
//   foreign key property: Post.author_id references User.id
//   on delete: cascade (delete the Post when its User is deleted); Neo4j does not enforce it.
//   create: MATCH (s:Post), (t:User) WHERE s.author_id = t.id MERGE (s)-[:AUTHOR]->(t);
```

Load the nodes first, then run the queries. The relationship type is the relation field name in UPPER_SNAKE_CASE (`edited_by` gives `EDITED_BY`).

### Join tables

A table is a pure join table when it has exactly two required foreign keys, nothing else points at it, and either the two keys are its primary key or it has its own key plus a unique pair of the two keys. That is how Django, Prisma and the other formats write a many-to-many field.

A join table does not become a node label. It becomes one relationship comment, such as `(:Post)-[:TAGS]->(:Tag)`.

- The key of the join table is dropped, with a warning.
- Other columns are listed as relationship properties.
- A unique column or unique index on those columns becomes a relationship property uniqueness constraint (`FOR ()-[r:TAGS]-() REQUIRE r.ticket IS UNIQUE`). With `--style enterprise`, the required columns of such a table also get `IS NOT NULL`. A join table with no unique columns has no statements.
- Neo4j cannot make the pair of nodes unique for relationships, so the comment says to create them with `MERGE`.

A many-to-many field that the source declares on both sides is written once.

## Warnings

Everything that is dropped or approximated gets a warning that names the model and the field. These are the main cases:

- Defaults, auto-increment keys, generated columns and columns that refresh on every save. A schema cannot hold them. Set the values when you create the node.
- Maximum lengths. One warning for each model.
- Decimal, JSON, hstore, range, nested array and unsupported database types.
- Each foreign key, because Neo4j does not enforce it.
- Join table keys and indexes that have no relationship form.
- Index methods other than B-tree, and sort order, prefix length, operator class and clustering options.
- Indexes that name a column that does not exist.
- Views and database schemas.

An index that a uniqueness constraint already covers is left out without a warning, because the constraint has its own index.

## Python classes

The [`neomodel`](neomodel.md) format writes the same graph as Python classes for the neomodel library. It uses the same labels, relationship types, directions and cardinalities as this format, so both describe the same graph. Create the constraints with one of them, not both: the names differ (neomodel names a constraint `constraint_unique_Post_id`).

## Java classes

The [`sdn`](sdn.md) format writes the same graph as Spring Data Neo4j entity classes (Java). It uses the same labels and relationship types. Spring Data Neo4j creates no constraints or indexes, so use this format for them.

## Applying the file

```sh
cypher-shell -u neo4j -p <password> -f generated/schema.cypher
```

## How it is checked

The test suite runs the output in a real Neo4j server (version 5, Community Edition) and reads the constraints and indexes back. It applies each file twice to prove that `IF NOT EXISTS` makes it safe to run again. It also writes data to check that the constraints reject duplicates. When an Enterprise Edition server is available, it runs the `enterprise` style too, and checks that `NODE KEY`, `IS NOT NULL` and the type constraints reject bad data. The tests need `NEO4J_URL` or `NEO4J_DOCKER=1` and are skipped with a reason otherwise. See [`test/README.md`](../../test/README.md).

## Not supported yet

- Reading a Cypher file or a graph schema.
- Indexes on relationship properties, except the constraints above.
- Vector, point and text index kinds.
