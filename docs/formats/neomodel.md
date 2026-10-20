# neomodel

The `neomodel` format writes Python classes for [neomodel](https://neomodel.readthedocs.io), the object mapper for [Neo4j](https://neo4j.com). Each model becomes a class, each column a property, and each foreign key a relationship. It is write-only: it works with `--to` and never with `--from`. It claims no file extension, so always pass `--to neomodel`. The output is one Python module, for example `models.py`.

The labels and relationship types are the same as in the [Neo4j](neo4j.md) Cypher output, so the two files describe the same graph. Cypher gives you the schema as statements. neomodel gives you the classes to work with in Python.

## Try it

The example project is [`examples/neomodel`](../../examples/neomodel/). It converts the shared Prisma schema `examples/schema/schema.prisma` into `generated/models.py`:

```sh
cd examples/neomodel
npx ormbridge convert           # writes generated/models.py
npx ormbridge convert --check   # exits with code 3 if the file is missing or differs
```

Inside this repository, run `npm run build` once and use `node ../../dist/cli.js convert` instead. Without the config file:

```sh
npx ormbridge convert -i ../schema/schema.prisma --from prisma --to neomodel -o generated/models.py
```

## Reading: not supported

There is no neomodel reader, and no Neo4j reader. A graph schema does not say how many nodes a relationship may join, or whether it is required. Reading it back would lose too much.

## Using the module

Install neomodel (`pip install neomodel`). The tests use version 7.0.0 with Neo4j 5, and the module also loads in 5.5.3. Then create the constraints and indexes, and connect:

```sh
neomodel_install_labels generated/models.py --db bolt://neo4j:password@localhost:7687
```

```python
from neomodel import db
from models import Post, User

db.set_connection("bolt://neo4j:password@localhost:7687")

user = User(id_=1).save()
post = Post(id_=1, title="Hello", body="First post", metadata={}, author_id=1, category_id=1).save()
post.author.connect(user)
print([p.title for p in user.posts.all()])
```

## Writing

One module. It starts with a comment block and the imports. Classes follow: first one `StructuredRel` class for each join table that has extra columns, then one `StructuredNode` class for each node label.

| Source                         | neomodel                                                                          |
| ------------------------------ | --------------------------------------------------------------------------------- |
| Model                          | `StructuredNode` class, named like the label (`blog_posts` gives `BlogPost`)      |
| Column                         | Property class (see [Types](#types))                                              |
| Primary key                    | `unique_index=True` and `required=True`                                           |
| Unique column, unique index    | `unique_index=True`                                                               |
| One-to-one foreign key         | `unique_index=True` on the foreign key property, `ZeroOrOne` on the reverse end   |
| Index                          | `index=True`; a full-text index on a string is `fulltext_index=FulltextIndex()`   |
| Required column                | `required=True` (left out when the column has a default)                          |
| Enum                           | `StringProperty(choices={...})`                                                   |
| Foreign key, relation          | `RelationshipTo` on the owner and `RelationshipFrom` on the target                |
| Join table (pure many-to-many) | One relationship, and no node class; extra columns become a `StructuredRel` class |

```python
class Post(StructuredNode):
    """Model Post (table blog_post)."""

    id_ = IntegerProperty(unique_index=True, required=True, db_property="id")
    title = StringProperty(max_length=200, index=True, required=True)
    author_id = IntegerProperty(index=True, required=True)
    author = RelationshipTo("User", "AUTHOR", cardinality=One)
    tags = RelationshipTo("Tag", "TAGS", cardinality=ZeroOrMore)
```

### Names

Python attribute names are snake_case in both naming modes. When the attribute differs from the property key in the graph, the writer adds `db_property`, so the graph keeps the key from the source (`createdAt` becomes `created_at` with `db_property="createdAt"`).

neomodel reserves some names. A property called `id`, `element_id` or `deleted` is refused, and `save`, `delete` or `labels` would hide a method. The writer adds an underscore (`id_`) and keeps the stored key with `db_property`. A Python keyword gets the same treatment (`class_`). When two attributes would match, the second one gets a number (`first_name_2`) and a warning.

A model whose label is a Python keyword, or the name of something the module imports (`One`, `StructuredNode`), gets a class name with a suffix, and `__label__` keeps the real label.

### Naming modes

- `--naming preserve` (default) keeps the column names as property keys, such as `public_id`.
- `--naming normalize` uses camelCase property keys, such as `publicId`, which is the Neo4j habit. It also applies the usual fresh-schema changes (UUID keys, `created_at` and `updated_at`). Labels do not change.

Attribute names do not change between the modes.

## Types

| Source type                          | neomodel property                                            |
| ------------------------------------ | ------------------------------------------------------------ |
| String                               | `StringProperty` (with `max_length` when the source has one) |
| Text, UUID, IP address               | `StringProperty`                                             |
| Integer, big integer                 | `IntegerProperty`                                            |
| Float                                | `FloatProperty`                                              |
| Boolean                              | `BooleanProperty`                                            |
| Date                                 | `DateProperty` (stored as ISO text)                          |
| Date and time                        | `DateTimeNeo4jFormatProperty` (a native Neo4j datetime)      |
| JSON                                 | `JSONProperty` (stored as a JSON string), with a warning     |
| Array                                | `ArrayProperty(base)`                                        |
| Enum                                 | `StringProperty(choices=...)`                                |
| UUID key with a generated default    | `UniqueIdProperty` (32 hexadecimal digits, no dashes)        |
| Decimal, hstore, range, unknown type | `StringProperty`, with a warning                             |
| Time, duration                       | `StringProperty` with ISO 8601 text, with a warning          |
| Binary                               | `StringProperty` with base64 text, with a warning            |
| Array of arrays, array of binary     | `StringProperty`, with a warning                             |

A date and time is stored as a native Neo4j datetime (`ZONED DATETIME`, or `LOCAL DATETIME` for a `timestamp` or `datetime` native type), so Cypher functions such as `datetime()` and `duration.between` work on it. A timezone-aware Python value is stored zoned and a naive one local. neomodel 7.0.0 has no native date property: `DateProperty` stores ISO text, so a date is a `STRING` in the database. An enum is checked in Python only.

A decimal is a string so that no digit is lost. Convert it with `Decimal(value)` when you need to add values.

## Defaults

neomodel does not allow `required=True` and a default together. The writer does not use `default_now=True` on a datetime: in neomodel 7.0.0 it fixes the time when the module is imported, so every node would get the same value. It writes a function that reads the clock on each save instead. When a column has a default, the property gets the default and no `required`.

| Source default                                | neomodel                                                                       |
| --------------------------------------------- | ------------------------------------------------------------------------------ |
| Text, number or boolean                       | `default=...`                                                                  |
| Enum value                                    | `default="stored value"`                                                       |
| Current time                                  | `default=lambda: datetime.now(timezone.utc)`; for a date, `default=date.today` |
| Generated UUID (key)                          | `UniqueIdProperty`                                                             |
| Generated UUID (other column)                 | `default=lambda: str(uuid4())`                                                 |
| Timestamp refreshed on every save             | The same default for the first save, with a warning                            |
| Auto-increment, database expression, `cuid()` | Dropped, with a warning                                                        |
| Default of an array or JSON column            | Dropped, with a warning                                                        |

## Relationships

Each foreign key becomes two lines, one on each class:

```python
class Post(StructuredNode):
    author = RelationshipTo("User", "AUTHOR", cardinality=One)

class User(StructuredNode):
    posts = RelationshipFrom("Post", "AUTHOR", cardinality=ZeroOrMore)
```

The type is the relation field name in UPPER_SNAKE_CASE (`edited_by` gives `EDITED_BY`). It is the same type the Cypher writer uses.

| Source                   | Owner end            | Reverse end  |
| ------------------------ | -------------------- | ------------ |
| Required foreign key     | `One`                | `ZeroOrMore` |
| Optional foreign key     | `ZeroOrOne`          | `ZeroOrMore` |
| One-to-one foreign key   | `One` or `ZeroOrOne` | `ZeroOrOne`  |
| Many-to-many, join table | `ZeroOrMore`         | `ZeroOrMore` |

The reverse end takes the name of the `related_name` in the source. When there is none, it is the plural of the owner (`posts`). If that name is taken, the writer adds a number and a warning.

The foreign key columns stay as plain properties, as they do in the Cypher output. Nothing ties them to the relationship, so keep them in step yourself, or leave them out of your code. neomodel does not enforce delete actions such as `cascade`. Each foreign key gets a warning that says so.

### Join tables

A table is a pure join table when it has exactly two required foreign keys, nothing else points at it, and either the two keys are its primary key or it has its own key plus a unique pair of the two keys. That is how Django, Prisma and the other formats write a many-to-many field.

A join table does not become a node class. It becomes one relationship, such as `(:Post)-[:TAGS]->(:Tag)`.

- The key of the join table is dropped, with a warning.
- Other columns become the properties of a `StructuredRel` class, and the relationship uses it with `model=`.
- A unique column becomes a unique relationship property. Other indexes on a join table are dropped with a warning.
- `connect` merges on the relationship properties. A pair that has properties with changing defaults, such as timestamps, can be connected twice. A pair without properties cannot.

A many-to-many field that the source declares on both sides is written once.

## Indexes and constraints

neomodel can make one property unique or indexed. It has no composite constraints.

- A composite primary key, composite unique index or composite index is written as an index on each property, with a warning.
- Index methods other than B-tree, and sort order, prefix length, operator class and clustering options, are dropped with a warning.
- A full-text index covers one string property. A full-text index over several properties gives each property its own index, with a warning. Full-text indexes need Neo4j 5.16 or later.
- Neo4j Enterprise constraints (`IS NOT NULL`, `NODE KEY`) are not created. neomodel checks `required` in Python only.

## Warnings

Everything that is dropped or approximated gets a warning that names the model and the field. These are the main cases:

- Defaults that neomodel cannot hold, auto-increment keys, generated columns and columns that refresh on every save.
- Decimal, JSON, time, duration, binary, hstore, range, nested array and unsupported database types.
- Each foreign key, because neomodel does not enforce the delete action and the property is not tied to the relationship.
- Composite keys and indexes.
- Join table keys and indexes that have no relationship form.
- Index methods other than B-tree, and indexes that name a column that does not exist.
- Views and database schemas.

## How it is checked

The test suite installs neomodel 7.0.0 into a virtual environment and imports the module. It runs `install_labels` against a real Neo4j 5 Community server and compares three things: what the classes declare, what `SHOW CONSTRAINTS` and `SHOW INDEXES` report, and the source schema. It does this for the canonical schemas and several larger fixtures, in both naming modes. It then saves nodes and relationships, reads them back, and checks that duplicate keys, missing required properties, long strings, values outside an enum and a second node on a `One` relationship are rejected. The tests need `NEOMODEL_PYTHON` and `NEO4J_URL` or `NEO4J_DOCKER=1`, and are skipped with a reason otherwise. See [`test/README.md`](../../test/README.md).

## Not supported yet

- Reading a neomodel module or a graph schema.
- Async classes (`AsyncStructuredNode`). The module uses the synchronous classes.
- A native Neo4j date property (neomodel 7.0.0 has none), vector and point indexes.
- Aliases, `Meta` options and class methods. The classes hold the schema only.
