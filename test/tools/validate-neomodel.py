"""Loads a generated neomodel module against a real Neo4j server and reports what neomodel and the server see.

Usage: python validate-neomodel.py <schema|blog|joins|types> <models.py>

The connection comes from the environment: NEOMODEL_BOLT_URL (for example ``bolt://127.0.0.1:7687``),
NEOMODEL_USER and NEOMODEL_PASSWORD. The database is emptied first: nodes, constraints and indexes.

``schema``  imports the module, runs ``install_labels`` for every ``StructuredNode`` class in it, and
            prints (as one JSON document on stdout) what the classes declare (properties with their
            database names and flags, relationships with type, direction, cardinality, target and
            relationship class) and what ``SHOW CONSTRAINTS`` / ``SHOW INDEXES`` report afterwards.
``blog``    saves nodes and relationships of the canonical blog schema, reads them back and checks that
            unique, required, length, choice and cardinality rules are enforced.
``joins``   does the same for the join-table schema (relationship properties, a unique relationship
            property, many-to-many relations).
``types``   round-trips a node that has a property of every type.

The scenarios print a JSON list of ``{"name", "ok", "detail"}`` checks. Exit code 2 means neomodel is not
importable, 1 means the module could not be loaded or the server could not be reached.
"""

from __future__ import annotations

import contextlib
import datetime
import importlib.util
import io
import json
import os
import sys
from pathlib import Path
from typing import Any
from urllib.parse import quote, urlsplit

try:
    import neomodel
    from neomodel import StructuredNode, StructuredRel, db
except ImportError as error:  # pragma: no cover
    print(f"neomodel is not importable: {error}", file=sys.stderr)
    sys.exit(2)


def connect() -> None:
    parts = urlsplit(os.environ.get("NEOMODEL_BOLT_URL", "bolt://127.0.0.1:7687"))
    user = quote(os.environ.get("NEOMODEL_USER", "neo4j"), safe="")
    password = quote(os.environ.get("NEOMODEL_PASSWORD", "neo4j"), safe="")
    db.set_connection(f"{parts.scheme}://{user}:{password}@{parts.netloc}")


def clear_database() -> None:
    db.cypher_query("MATCH (n) DETACH DELETE n")
    for (name,) in db.cypher_query("SHOW CONSTRAINTS YIELD name")[0]:
        db.cypher_query(f"DROP CONSTRAINT `{name}` IF EXISTS")
    for name, _kind in db.cypher_query(
        "SHOW INDEXES YIELD name, type WHERE type <> 'LOOKUP'"
    )[0]:
        db.cypher_query(f"DROP INDEX `{name}` IF EXISTS")


def load_module(path: Path) -> Any:
    spec = importlib.util.spec_from_file_location(path.stem, path)
    if spec is None or spec.loader is None:
        raise ImportError(f"cannot load {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[path.stem] = module
    spec.loader.exec_module(module)
    return module


def node_classes(module: Any) -> list[type]:
    return [
        value
        for value in vars(module).values()
        if isinstance(value, type)
        and issubclass(value, StructuredNode)
        and value is not StructuredNode
        and value.__module__ == module.__name__
    ]


def install(classes: list[type]) -> None:
    installer = getattr(db, "install_labels", None) or neomodel.install_labels
    with contextlib.redirect_stdout(io.StringIO()):
        for cls in classes:
            installer(cls, quiet=True)


def describe_properties(cls: type) -> dict[str, Any]:
    described: dict[str, Any] = {}
    for attribute, prop in cls.defined_properties(aliases=False, rels=False).items():
        described[attribute] = {
            "db": prop.get_db_property_name(attribute),
            "type": type(prop).__name__,
            "unique": bool(prop.unique_index),
            "index": bool(prop.index),
            "fulltext": bool(prop.fulltext_index),
            "required": bool(prop.required),
            "hasDefault": bool(prop.has_default),
        }
    return described


def describe_module(module: Any) -> dict[str, Any]:
    classes: dict[str, Any] = {}
    relationship_classes: dict[str, Any] = {}
    for cls in node_classes(module):
        relationships: dict[str, Any] = {}
        for attribute, rel in cls.defined_properties(
            aliases=False, properties=False
        ).items():
            definition = rel.definition
            model = definition.get("model")
            relationships[attribute] = {
                "type": definition["relation_type"],
                "direction": {1: "out", -1: "in", 0: "either"}[definition["direction"]],
                "cardinality": rel.manager.__name__,
                "target": str(rel._raw_class if isinstance(rel._raw_class, str) else rel._raw_class.__name__),
                "model": None if model is None else model.__name__,
            }
            if model is not None:
                relationship_classes[model.__name__] = describe_properties(model)
        classes[cls.__name__] = {
            "label": cls.__label__,
            "properties": describe_properties(cls),
            "relationships": relationships,
        }
    return {"classes": classes, "relationshipClasses": relationship_classes}


def catalog() -> dict[str, Any]:
    constraints = [
        {"name": n, "type": t, "entityType": e, "labelsOrTypes": l, "properties": p}
        for n, t, e, l, p in db.cypher_query(
            "SHOW CONSTRAINTS YIELD name, type, entityType, labelsOrTypes, properties "
            "RETURN name, type, entityType, labelsOrTypes, properties ORDER BY name"
        )[0]
    ]
    indexes = [
        {"name": n, "type": t, "entityType": e, "labelsOrTypes": l, "properties": p}
        for n, t, e, l, p in db.cypher_query(
            "SHOW INDEXES YIELD name, type, entityType, labelsOrTypes, properties, owningConstraint "
            "WHERE type <> 'LOOKUP' AND owningConstraint IS NULL "
            "RETURN name, type, entityType, labelsOrTypes, properties ORDER BY name"
        )[0]
    ]
    return {"constraints": constraints, "indexes": indexes}


# ---------------------------------------------------------------------------
# Scenarios
# ---------------------------------------------------------------------------

checks: list[dict[str, Any]] = []

# A duplicate key is a UniqueProperty in neomodel 5 and a ConstraintValidationFailed in newer releases.
UNIQUE_ERRORS: tuple[type, ...] = tuple(
    getattr(neomodel.exceptions, name)
    for name in ("UniqueProperty", "ConstraintValidationFailed")
    if hasattr(neomodel.exceptions, name)
)


def check(name: str, ok: bool, detail: str = "") -> None:
    checks.append({"name": name, "ok": bool(ok), "detail": detail})


def raises(name: str, expected: tuple[type, ...], action: Any) -> None:
    """Checks that ``action`` raises one of the expected exceptions."""
    try:
        action()
    except expected as error:
        check(name, True, type(error).__name__)
    except Exception as error:  # noqa: BLE001
        check(name, False, f"raised {type(error).__name__}: {error}")
    else:
        check(name, False, "nothing was raised")


def ids(nodes: Any) -> list[str]:
    """The keys of nodes as text: the normalize naming mode makes the keys UUID strings."""
    return [str(node.id_) for node in nodes]


def run_blog(m: Any) -> None:
    now = datetime.datetime(2024, 5, 1, 12, 30, tzinfo=datetime.timezone.utc)
    user = m.User(id_=1).save()
    other = m.User(id_=2).save()
    category = m.Category(id_=1, name="news", slug="news", updated_at=now).save()
    post = m.Post(
        id_=1,
        updated_at=now,
        title="Hello",
        body="First post",
        metadata={"tags": ["a", "b"], "n": 1},
        author_id=1,
        category_id=1,
    ).save()
    tag = m.Tag(id_=1, label="graphs").save()
    post.author.connect(user)
    post.category.connect(category)
    post.tags.connect(tag)
    profile = m.Profile(id_=1, user_id=1).save()
    profile.user.connect(user)

    loaded = m.Post.nodes.get(id_=1)
    check("a saved node is read back", loaded.title == "Hello" and loaded.body == "First post")
    check("a JSON property round-trips", loaded.metadata == {"tags": ["a", "b"], "n": 1}, repr(loaded.metadata))
    check("a default is applied", loaded.view_count == 0 and loaded.is_featured is False and loaded.status == "draft")
    check("a datetime default is set", isinstance(loaded.created_at, datetime.datetime))
    check("the outgoing relationship is read back", str(loaded.author.single().id_) == "1")
    check("the reverse accessor sees the relationship", ids(user.posts.all()) == ["1"])
    check("the many-to-many relationship works both ways", ids(loaded.tags.all()) == ["1"] and ids(tag.posts.all()) == ["1"])
    check("a one-to-one relationship has a reverse side", str(user.profile.single().id_) == "1")
    key = m.Post.defined_properties(aliases=False, rels=False)["author_id"].get_db_property_name("author_id")
    stored = db.cypher_query(f"MATCH (n:Post) RETURN n.`{key}`")[0][0]
    check("the database property name is used", [str(value) for value in stored] == ["1"], repr(stored))
    check(
        "the relationship type is stored",
        db.cypher_query("MATCH (:Post)-[r:AUTHOR]->(:User) RETURN count(r)")[0][0][0] == 1,
    )

    raises("a duplicate primary key is rejected", UNIQUE_ERRORS, lambda: m.User(id_=1).save())
    raises("a duplicate unique column is rejected", UNIQUE_ERRORS, lambda: m.Category(id_=2, name="news", slug="x", updated_at=now).save())
    raises(
        "a missing required property is rejected",
        (neomodel.exceptions.RequiredProperty,),
        lambda: m.Tag(id_=9).save(),
    )
    raises(
        "a value longer than the maximum length is rejected",
        (ValueError, neomodel.exceptions.DeflateError),
        lambda: m.Tag(id_=9, label="x" * 51).save(),
    )
    raises(
        "a value outside the enum is rejected",
        (ValueError, neomodel.exceptions.DeflateError),
        lambda: m.Post(id_=9, updated_at=now, title="t", body="b", metadata={}, author_id=1, category_id=1, status="nonsense").save(),
    )
    raises(
        "a second author breaks the cardinality One",
        (neomodel.exceptions.AttemptedCardinalityViolation, neomodel.exceptions.CardinalityViolation),
        lambda: post.author.connect(other),
    )
    second = m.Profile(id_=2, user_id=2).save()
    raises(
        "a second profile breaks the cardinality ZeroOrOne",
        (neomodel.exceptions.AttemptedCardinalityViolation, neomodel.exceptions.CardinalityViolation),
        lambda: (second.user.connect(user)),
    )
    post.tags.connect(tag)
    if m.Post.tags.definition["model"] is None:
        check("connecting the same pair twice keeps one relationship", len(post.tags.all()) == 1)
    else:
        # connect() merges on the relationship properties too, and their defaults (timestamps) differ per call.
        check("connecting a pair with relationship properties twice adds a relationship", len(post.tags.all()) == 2)


def run_joins(m: Any) -> None:
    student = m.Student(id_=1).save()
    other = m.Student(id_=2).save()
    course = m.Course(id_=1).save()
    teacher = m.Teacher(id_=1).save()
    club = m.Club(id_=1).save()
    student.courses.connect(course, {"ticket": "t1", "role": "assistant", "seat": 4})
    rel = student.courses.relationship(course)
    check(
        "relationship properties round-trip",
        rel.ticket == "t1" and rel.role == "assistant" and rel.seat == 4,
        repr(rel.__properties__) if hasattr(rel, "__properties__") else "",
    )
    check("a relationship property default is applied", student.courses.relationship(course).role == "assistant")
    check("the reverse accessor sees the relationship", ids(course.students.all()) == ["1"])
    raises(
        "a duplicate unique relationship property is rejected",
        UNIQUE_ERRORS,
        lambda: other.courses.connect(course, {"ticket": "t1"}),
    )
    check(
        "the relationship unique constraint exists",
        any(
            c["type"] == "RELATIONSHIP_UNIQUENESS" and c["labelsOrTypes"] == ["COURSES"]
            for c in catalog()["constraints"]
        ),
    )
    course.teachers.connect(teacher)
    check("a many-to-many pair is read from both sides", ids(course.teachers.all()) == ["1"] and ids(teacher.courses.all()) == ["1"])
    student.club.connect(club)
    check("a join table with a composite key becomes a plain relationship", ids(student.club.all()) == ["1"] and ids(club.students.all()) == ["1"])
    student.club.connect(club)
    if m.Student.club.definition["model"] is None:
        check("connecting the same pair twice keeps one relationship", len(student.club.all()) == 1)


def run_types(m: Any) -> None:
    item = m.Item(
        title="A title",
        count=3,
        big=2**40,
        ratio=1.5,
        price="12.34",
        born=datetime.date(2001, 2, 3),
        settings={"a": [1, 2, {"b": None}]},
        labels_=["x", "y"],
        numbers=[1, 2, 3],
        opens="08:30:00",
        kind="film; \"quoted\"\nsecond line",
    ).save()
    check("a UniqueIdProperty key is generated", isinstance(item.id_, str) and len(item.id_) >= 32, str(item.id_))
    loaded = m.Item.nodes.get(id_=item.id_)
    check("strings round-trip", loaded.title == "A title" and loaded.price == "12.34" and loaded.opens == "08:30:00")
    check("integers round-trip", loaded.count == 3 and loaded.big == 2**40)
    check("floats round-trip", loaded.ratio == 1.5)
    check("a date round-trips", loaded.born == datetime.date(2001, 2, 3), repr(loaded.born))
    check("a default boolean is applied", loaded.flag is True)
    check("a datetime default is applied", isinstance(loaded.seen_at, datetime.datetime))
    check("JSON round-trips", loaded.settings == {"a": [1, 2, {"b": None}]}, repr(loaded.settings))
    check("arrays round-trip", loaded.labels_ == ["x", "y"] and loaded.numbers == [1, 2, 3])
    check("an enum value with awkward characters round-trips", loaded.kind == "film; \"quoted\"\nsecond line")
    check(
        "the database keeps the property names of the schema",
        db.cypher_query("MATCH (n:Item) RETURN n.seenAt IS NOT NULL OR n.seen_at IS NOT NULL")[0][0][0] is True,
    )


def main() -> int:
    if len(sys.argv) != 3 or sys.argv[1] not in ("schema", "blog", "joins", "types"):
        print(__doc__, file=sys.stderr)
        return 2
    mode, path = sys.argv[1], Path(sys.argv[2])
    try:
        connect()
        clear_database()
        module = load_module(path)
    except Exception as error:  # noqa: BLE001
        print(f"{type(error).__name__}: {error}", file=sys.stderr)
        return 1
    classes = node_classes(module)
    install(classes)
    if mode == "schema":
        report = describe_module(module)
        report.update(catalog())
        report["version"] = neomodel.__version__ if hasattr(neomodel, "__version__") else ""
        print(json.dumps(report))
        return 0
    {"blog": run_blog, "joins": run_joins, "types": run_types}[mode](module)
    print(json.dumps(checks))
    return 0


if __name__ == "__main__":
    sys.exit(main())
