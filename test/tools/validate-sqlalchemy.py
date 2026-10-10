"""Checks SQLAlchemy / SQLModel models against what the ormbridge parser read from them.

Usage: validate-sqlalchemy.py <project directory> <spec.json>

The project directory holds the fixture (a package or a models.py). The script imports it with the
real SQLAlchemy (2.0 or later, and sqlmodel for SQLModel fixtures), configures the mappers, creates
every table in an in-memory SQLite database, reads the schema back with the inspector and compares
tables, columns, nullability, primary keys, foreign keys with their actions, unique constraints,
indexes, enum values and relationships with the spec (a JSON rendering of the parser's IR). It then
inserts one row into every table it can fill and checks that the defaults the parser reported are the
ones that were applied.

Prints "sqlalchemy models verified" on success. Problems go to stderr, one per line, and the exit
status is 1.
"""

import datetime
import decimal
import enum
import importlib
import json
import sys
import uuid

import warnings

import sqlalchemy as sa
from sqlalchemy import event, inspect
from sqlalchemy.orm import configure_mappers
from sqlalchemy.orm.relationships import RelationshipProperty

# The inspector warns about expression-based indexes it cannot reflect; those are checked through the metadata.
warnings.simplefilter("ignore", sa.exc.SAWarning)

problems = []
checked = {"relationships": 0, "manyToMany": 0, "rows": 0}


def problem(message):
    problems.append(message)


ON_ACTIONS = {
    "cascade": "CASCADE",
    "setNull": "SET NULL",
    "restrict": "RESTRICT",
    "noAction": None,
    "setDefault": "SET DEFAULT",
}


def normalize_action(value):
    if value is None:
        return None
    value = value.upper()
    return None if value == "NO ACTION" else value


def unwrap(column_type):
    """SQLModel's AutoString and other TypeDecorators stand for the type they wrap."""
    while isinstance(column_type, sa.types.TypeDecorator):
        column_type = column_type.impl
    return column_type


def type_matches(column_type, spec):
    """True when the SQLAlchemy type fits the IR type of the spec column."""
    original = column_type
    column_type = unwrap(column_type)
    kind = spec["type"]
    if spec.get("enumValues") is not None:
        return isinstance(column_type, sa.Enum) and list(column_type.enums) == spec["enumValues"]
    if kind == "string":
        return isinstance(column_type, sa.String) and not isinstance(column_type, sa.Text)
    if kind == "text":
        return isinstance(column_type, sa.Text) or (
            isinstance(column_type, sa.String) and column_type.length is None
        )
    if kind == "int":
        return isinstance(column_type, sa.Integer) and not isinstance(column_type, sa.BigInteger)
    if kind == "bigInt":
        return isinstance(column_type, sa.BigInteger)
    if kind == "float":
        return isinstance(column_type, sa.Float)
    if kind == "decimal":
        return isinstance(column_type, sa.Numeric)
    if kind == "boolean":
        return isinstance(column_type, sa.Boolean)
    if kind == "dateTime":
        return isinstance(column_type, sa.DateTime)
    if kind == "date":
        return isinstance(column_type, sa.Date) and not isinstance(column_type, sa.DateTime)
    if kind == "time":
        return isinstance(column_type, sa.Time)
    if kind == "uuid":
        return isinstance(column_type, sa.Uuid)
    if kind == "json":
        return isinstance(column_type, sa.JSON)
    if kind == "bytes":
        return isinstance(column_type, sa.LargeBinary)
    if kind == "duration":
        return isinstance(original, sa.Interval) or isinstance(column_type, sa.Interval)
    return True


def sample_value(column, referenced):
    column_type = unwrap(column.type)
    if column.foreign_keys:
        fk = next(iter(column.foreign_keys))
        return referenced.get((fk.column.table.name, fk.column.name))
    if isinstance(column_type, sa.Enum):
        return column_type.enums[0]
    if isinstance(column_type, sa.Uuid):
        return uuid.uuid4()
    if isinstance(column_type, sa.JSON):
        return {}
    if isinstance(column_type, sa.Boolean):
        return True
    if isinstance(column_type, sa.Integer):
        return 1
    if isinstance(column_type, sa.Numeric):
        return decimal.Decimal("1")
    if isinstance(column_type, sa.Float):
        return 1.0
    if isinstance(column_type, sa.DateTime):
        return datetime.datetime(2020, 1, 2, 3, 4, 5)
    if isinstance(column_type, sa.Date):
        return datetime.date(2020, 1, 2)
    if isinstance(column_type, sa.Time):
        return datetime.time(3, 4, 5)
    if isinstance(column_type, sa.Interval):
        return datetime.timedelta(days=1)
    if isinstance(column_type, sa.LargeBinary):
        return b"x"
    if isinstance(column_type, sa.String):
        length = column_type.length or 8
        return ("x" * length)[: min(length, 8)]
    return None


def check_default(table_name, column_spec, actual, sa_column):
    default = column_spec.get("default")
    label = "%s.%s" % (table_name, column_spec["column"])
    if default is None:
        return
    kind = default["kind"]
    if kind in ("now", "uuid", "autoIncrement", "dbExpression"):
        if actual is None:
            problem("%s: the %s default was not applied" % (label, kind))
        return
    expected = default.get("value")
    if kind == "enumValue":
        expected = default.get("dbValue")
        if isinstance(actual, enum.Enum):
            # The Enum type hands back the member; compare what is stored in the database.
            actual = sa_column.type._db_value_for_elem(actual)
    if isinstance(expected, bool):
        actual = bool(actual) if actual is not None else None
    elif isinstance(expected, (int, float)) and actual is not None:
        actual = float(actual)
        expected = float(expected)
    elif isinstance(expected, str) and column_spec["type"] == "json" and actual is not None:
        actual = json.dumps(actual)
        expected = json.dumps(json.loads(expected))
    if actual != expected:
        problem("%s: default %r was expected, found %r" % (label, expected, actual))


def main():
    directory, spec_path = sys.argv[1], sys.argv[2]
    sys.path.insert(0, directory)
    with open(spec_path, encoding="utf8") as handle:
        spec = json.load(handle)

    for module_name in spec["modules"]:
        importlib.import_module(module_name)
    base_module, base_name = spec["base"].split(":")
    base = getattr(importlib.import_module(base_module), base_name)
    metadata = base.metadata
    registry = getattr(base, "registry", None) or getattr(base, "_sa_registry")

    configure_mappers()
    engine = sa.create_engine("sqlite://")

    @event.listens_for(engine, "connect")
    def enable_foreign_keys(connection, _record):
        connection.execute("PRAGMA foreign_keys=ON")

    metadata.create_all(engine)
    inspector = inspect(engine)

    mappers_by_class = {mapper.class_.__name__: mapper for mapper in registry.mappers}
    tables_by_name = {name: table for name, table in metadata.tables.items()}
    spec_by_model = {table["name"]: table for table in spec["tables"]}

    for model in spec["tables"]:
        verify_table(model, spec, inspector, tables_by_name, mappers_by_class, spec_by_model)

    insert_rows(engine, spec, tables_by_name)

    if problems:
        for line in problems:
            print(line, file=sys.stderr)
        sys.exit(1)
    print(
        "sqlalchemy models verified (%d tables, %d relationships, %d many-to-many, %d rows)"
        % (len(spec["tables"]), checked["relationships"], checked["manyToMany"], checked["rows"])
    )


def verify_table(model, spec, inspector, tables, mappers, spec_by_model):
    name = model["table"]
    if name not in tables:
        problem("%s: the table was not created" % name)
        return
    table = tables[name]
    db_columns = {column["name"]: column for column in inspector.get_columns(name)}
    expected_columns = [column["column"] for column in model["columns"]] + [
        relation["column"] for relation in model["relations"]
    ]
    if sorted(db_columns) != sorted(expected_columns):
        problem(
            "%s: columns %s were expected, the database has %s"
            % (name, sorted(expected_columns), sorted(db_columns))
        )
    primary_key = set(inspector.get_pk_constraint(name)["constrained_columns"])
    if primary_key != set(model["primaryKey"]):
        problem(
            "%s: primary key %s was expected, found %s"
            % (name, sorted(model["primaryKey"]), sorted(primary_key))
        )

    for column in model["columns"]:
        label = "%s.%s" % (name, column["column"])
        if column["column"] not in table.c:
            continue
        sa_column = table.c[column["column"]]
        if column["column"] not in primary_key and sa_column.nullable != column["nullable"]:
            problem("%s: nullable=%s was expected" % (label, column["nullable"]))
        if column.get("arrayDepth") is None and not type_matches(sa_column.type, column):
            problem("%s: the type %r does not fit %s" % (label, sa_column.type, column["type"]))
        length = getattr(unwrap(sa_column.type), "length", None)
        if column.get("maxLength") is not None and length != column["maxLength"]:
            problem("%s: length %s was expected, found %s" % (label, column["maxLength"], length))
        if column["type"] == "decimal":
            if column.get("maxDigits") is not None and unwrap(sa_column.type).precision != column["maxDigits"]:
                problem("%s: precision %s was expected" % (label, column["maxDigits"]))
            if column.get("decimalPlaces") is not None and unwrap(sa_column.type).scale != column["decimalPlaces"]:
                problem("%s: scale %s was expected" % (label, column["decimalPlaces"]))
        default = column.get("default")
        if default is not None and default["kind"] not in ("autoIncrement",):
            if column.get("isDbDefault"):
                if sa_column.server_default is None and sa_column.default is None:
                    problem("%s: no database default is declared" % label)
            elif sa_column.default is None and sa_column.server_default is None:
                problem("%s: no default is declared" % label)
        if column.get("isAutoUpdated") and sa_column.onupdate is None:
            problem("%s: onupdate is missing" % label)
        if column.get("generated") and sa_column.computed is None:
            problem("%s: the generated column is not computed" % label)

    foreign_keys = inspector.get_foreign_keys(name)
    for relation in model["relations"]:
        label = "%s.%s" % (name, relation["name"])
        found = [
            fk
            for fk in foreign_keys
            if fk["constrained_columns"] == [relation["column"]]
        ]
        if not found:
            problem("%s: no foreign key on %s" % (label, relation["column"]))
            continue
        fk = found[0]
        if fk["referred_table"] != relation["targetTable"]:
            problem("%s: the key points at %s, not %s" % (label, fk["referred_table"], relation["targetTable"]))
        options = fk.get("options", {})
        if normalize_action(options.get("ondelete")) != ON_ACTIONS[relation["onDelete"]]:
            problem(
                "%s: ON DELETE %s was expected, found %s"
                % (label, ON_ACTIONS[relation["onDelete"]], options.get("ondelete"))
            )
        if relation.get("onUpdate") is not None and normalize_action(options.get("onupdate")) != ON_ACTIONS[relation["onUpdate"]]:
            problem(
                "%s: ON UPDATE %s was expected, found %s"
                % (label, ON_ACTIONS[relation["onUpdate"]], options.get("onupdate"))
            )
        if relation.get("targetColumn") is not None and fk["referred_columns"] != [relation["targetColumn"]]:
            problem("%s: the key points at %s" % (label, fk["referred_columns"]))
    for composite in model["compositeForeignKeys"]:
        label = "%s.%s" % (name, composite["name"])
        found = [fk for fk in foreign_keys if fk["constrained_columns"] == composite["columns"]]
        if not found:
            problem("%s: no composite foreign key on %s" % (label, composite["columns"]))
            continue
        if found[0]["referred_table"] != composite["targetTable"] or found[0]["referred_columns"] != composite["targetColumns"]:
            problem("%s: the composite key points at %s" % (label, found[0]["referred_columns"]))

    uniques = [tuple(unique["column_names"]) for unique in inspector.get_unique_constraints(name)]
    indexes = inspector.get_indexes(name)
    unique_sets = uniques + [tuple(index["column_names"]) for index in indexes if index["unique"]]
    for column in model["columns"]:
        if column["unique"] and (column["column"],) not in unique_sets and column["column"] not in primary_key:
            problem("%s.%s: no unique constraint" % (name, column["column"]))
    for relation in model["relations"]:
        if relation["kind"] == "oneToOne" and not relation["primaryKey"]:
            if (relation["column"],) not in unique_sets:
                problem("%s.%s: a one-to-one needs a unique key" % (name, relation["name"]))
    for index in model["indexes"]:
        columns = tuple(index["columns"])
        if index["unique"]:
            if columns not in unique_sets:
                problem("%s: unique constraint or index on %s is missing" % (name, list(columns)))
        else:
            if not any(tuple(candidate["column_names"]) == columns for candidate in indexes):
                problem("%s: index on %s is missing" % (name, list(columns)))
        if index.get("name") is not None:
            names = [candidate["name"] for candidate in indexes] + [
                unique.get("name") for unique in inspector.get_unique_constraints(name)
            ]
            if index["name"] not in names:
                problem("%s: no index or constraint named %s (found %s)" % (name, index["name"], names))

    verify_relationships(model, tables, mappers, spec_by_model)


def verify_relationships(model, tables, mappers, spec_by_model):
    mapper = mappers.get(model["name"])
    if mapper is None:
        return
    properties = {prop.key: prop for prop in mapper.relationships}
    for relation in model["relations"]:
        label = "%s.%s" % (model["name"], relation["name"])
        prop = properties.get(relation["name"])
        if prop is None:
            # A foreign key column without a relationship() has no attribute to check.
            continue
        checked["relationships"] += 1
        if prop.mapper.class_.__name__ != relation["target"]:
            problem("%s: the relationship points at %s" % (label, prop.mapper.class_.__name__))
        if relation["kind"] == "oneToOne" and prop.uselist:
            problem("%s: a one-to-one relationship must not be a list" % label)
        if relation.get("relatedName") is not None:
            reverse = {p.key: p for p in prop.mapper.relationships}.get(relation["relatedName"])
            if reverse is None:
                problem("%s: the target has no relationship %s" % (label, relation["relatedName"]))
            elif reverse.mapper.class_.__name__ != model["name"]:
                problem("%s: the reverse side points at %s" % (label, reverse.mapper.class_.__name__))
            elif relation["kind"] == "oneToOne" and reverse.uselist:
                problem("%s: the reverse side of a one-to-one must not be a list" % label)
    for many in model["manyToMany"]:
        label = "%s.%s" % (model["name"], many["name"])
        prop = properties.get(many["name"])
        if prop is None:
            problem("%s: the mapper has no relationship %s" % (label, many["name"]))
            continue
        checked["manyToMany"] += 1
        if prop.secondary is None:
            problem("%s: the relationship has no secondary table" % label)
        if prop.mapper.class_.__name__ != many["target"]:
            problem("%s: the relationship points at %s" % (label, prop.mapper.class_.__name__))
        if many.get("relatedName") is not None:
            reverse = {p.key: p for p in prop.mapper.relationships}.get(many["relatedName"])
            if reverse is None or reverse.secondary is None:
                problem("%s: the target has no many-to-many %s" % (label, many["relatedName"]))
            elif reverse.secondary is not prop.secondary:
                problem("%s: the two sides use different secondary tables" % label)


def insert_rows(engine, spec, tables):
    """Inserts one row into every table whose required columns can be filled and reads the defaults back."""
    remaining = {
        model["table"]: model for model in spec["tables"] if model["table"] in tables
    }
    inserted = {}
    referenced = {}
    progressed = True
    while remaining and progressed:
        progressed = False
        for name in list(remaining):
            model = remaining[name]
            table = tables[name]
            targets = {fk.column.table.name for column in table.c for fk in column.foreign_keys}
            required_targets = {
                fk.column.table.name
                for column in table.c
                if not column.nullable
                for fk in column.foreign_keys
            }
            if any(target != name and target not in inserted for target in required_targets):
                continue
            values = {}
            for column in table.c:
                if column.computed is not None:
                    continue
                has_default = column.default is not None or column.server_default is not None
                is_auto = column.primary_key and column.autoincrement in (True, "auto") and isinstance(column.type, sa.Integer) and not column.foreign_keys and len(table.primary_key.columns) == 1
                if is_auto or has_default:
                    continue
                if column.nullable and not column.foreign_keys:
                    continue
                if column.nullable and column.foreign_keys:
                    continue
                values[column.name] = sample_value(column, referenced)
            try:
                with engine.begin() as connection:
                    result = connection.execute(table.insert().values(**values))
                    row = connection.execute(sa.select(table)).mappings().first()
            except Exception as error:  # noqa: BLE001 - reported as a problem with the table name
                problem("%s: inserting a row failed: %s" % (name, str(error).splitlines()[0]))
                del remaining[name]
                progressed = True
                continue
            inserted[name] = row
            checked["rows"] += 1
            for column in table.primary_key.columns:
                referenced[(name, column.name)] = row[column.name]
            for column in table.c:
                referenced.setdefault((name, column.name), row[column.name])
            for column in model["columns"]:
                if column["column"] in values:
                    continue
                check_default(name, column, row[column["column"]], table.c[column["column"]])
            del remaining[name]
            progressed = True
    for name in remaining:
        # Tables whose required parents could not be filled (a cycle of required keys).
        problem("%s: no row could be inserted because a required parent row is missing" % name)
    with engine.connect() as connection:
        violations = connection.execute(sa.text("PRAGMA foreign_key_check")).fetchall()
    if violations:
        problem("foreign_key_check reported %d violations" % len(violations))


main()
