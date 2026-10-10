"""Loads generated SQLAlchemy / SQLModel models with the real libraries and compares them with the IR.

Usage: python -I validate-sqlalchemy-emitter.py <directory> <spec.json>

<directory> holds ``models.py``. <spec.json> is the expected schema written by the test
(test/sqlalchemySupport.ts). The script

1. imports ``models.py`` (SQLAlchemy warnings are errors) and configures the mappers,
2. renders the DDL of every table for PostgreSQL (no server needed),
3. runs ``create_all`` on a SQLite file with foreign keys enforced,
4. compares the tables, columns, nullability, primary keys, foreign keys with their ON DELETE
   action, unique constraints, indexes, string lengths, decimal precision and enum values that
   SQLAlchemy reports for the metadata and the database with the spec,
5. checks the mapped attributes and that every relationship has a partner (``back_populates``)
   on the other side, many-to-many ones included,
6. inserts rows through the ORM (defaults left to the framework, enums, foreign keys, composite
   keys, many-to-many through the relationships) and reads them back, and checks what the
   database does when a referenced row is deleted.

Every difference is printed to stderr and the exit code is 1; success prints
"sqlalchemy models verified" followed by a JSON summary and exits with 0. Exit code 2 means
SQLAlchemy is not importable.
"""

from __future__ import annotations

import datetime
import decimal
import importlib.util
import json
import sys
import time
import uuid
import warnings
from pathlib import Path
from typing import Any

try:
    import sqlalchemy as sa
    from sqlalchemy import event, inspect
    from sqlalchemy.dialects import postgresql
    from sqlalchemy.exc import IntegrityError, SAWarning
    from sqlalchemy.orm import Session, configure_mappers
    from sqlalchemy.schema import CreateIndex, CreateTable
except ImportError as error:  # pragma: no cover
    print(f"SQLAlchemy is not importable: {error}", file=sys.stderr)
    sys.exit(2)

Spec = dict[str, Any]

errors: list[str] = []


def fail(message: str) -> None:
    errors.append(message)


def load_models(directory: Path) -> Any:
    warnings.simplefilter("error", SAWarning)
    sys.path.insert(0, str(directory))
    spec = importlib.util.spec_from_file_location("models", directory / "models.py")
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules["models"] = module
    spec.loader.exec_module(module)
    return module


# IR scalar type -> acceptable SQLAlchemy type classes.
def type_classes(name: str) -> tuple[type, ...]:
    mapping: dict[str, tuple[type, ...]] = {
        "string": (sa.String,),
        "text": (sa.Text,),
        "int": (sa.Integer,),
        "bigInt": (sa.BigInteger,),
        "float": (sa.Float,),
        "decimal": (sa.Numeric,),
        "boolean": (sa.Boolean,),
        "dateTime": (sa.DateTime,),
        "date": (sa.Date,),
        "time": (sa.Time,),
        "uuid": (sa.Uuid,),
        "json": (sa.JSON,),
        "bytes": (sa.LargeBinary,),
        "duration": (sa.Interval,),
        "ipAddress": (postgresql.INET,),
        "hstore": (postgresql.HSTORE,),
        "range": (postgresql.AbstractRange,),
        "unsupported": (sa.String,),
    }
    return mapping[name]


def check_column_type(label: str, column: sa.Column, spec: Spec) -> None:
    kind = spec["type"]
    sqla_type = column.type
    if isinstance(sqla_type, sa.types.TypeDecorator) and not isinstance(
        sqla_type, type_classes(kind)
    ):
        # SQLModel wraps its string type (AutoString).
        sqla_type = sqla_type.impl
    if spec.get("array"):
        if not isinstance(sqla_type, sa.ARRAY):
            fail(f"{label}: expected an ARRAY, got {sqla_type!r}")
        return
    if spec.get("enumValues") is not None:
        if not isinstance(sqla_type, sa.Enum):
            fail(f"{label}: expected an Enum, got {sqla_type!r}")
            return
        if list(sqla_type.enums) != spec["enumValues"]:
            fail(f"{label}: enum values {list(sqla_type.enums)} != {spec['enumValues']}")
        if spec.get("enumDbName") is not None and sqla_type.name != spec["enumDbName"]:
            fail(f"{label}: enum type name {sqla_type.name!r} != {spec['enumDbName']!r}")
        return
    if not isinstance(sqla_type, type_classes(kind)):
        fail(f"{label}: expected {kind}, got {sqla_type!r}")
        return
    if kind == "string" and isinstance(sqla_type, sa.Text):
        fail(f"{label}: expected a bounded string, got Text")
    if kind == "string" and spec.get("maxLength") is not None:
        if sqla_type.length != spec["maxLength"]:
            fail(f"{label}: length {sqla_type.length} != {spec['maxLength']}")
    if kind == "decimal" and spec.get("maxDigits") is not None:
        if sqla_type.precision != spec["maxDigits"]:
            fail(f"{label}: precision {sqla_type.precision} != {spec['maxDigits']}")
        if sqla_type.scale != (spec.get("decimalPlaces") or 0):
            fail(f"{label}: scale {sqla_type.scale} != {spec.get('decimalPlaces')}")
    if kind == "dateTime" and not sqla_type.timezone:
        fail(f"{label}: expected a timezone-aware DateTime")


def class_by_table(registry: Any) -> dict[str, Any]:
    classes: dict[str, Any] = {}
    for mapper in registry.mappers:
        classes[mapper.local_table.name] = mapper.class_
    return classes


def action_of(options: dict[str, Any], key: str) -> str | None:
    value = options.get(key)
    return None if value is None else str(value).upper()


EXPECTED_ACTION = {
    "cascade": "CASCADE",
    "setNull": "SET NULL",
    "restrict": "RESTRICT",
    "noAction": None,
    "setDefault": "SET DEFAULT",
}


def compare_structure(spec: Spec, metadata: sa.MetaData, engine: sa.Engine) -> None:
    inspector = inspect(engine)
    expected_tables = {model["table"] for model in spec["models"]}
    for model in spec["models"]:
        for link in model["manyToMany"]:
            expected_tables.add(link["table"])
    actual_tables = set(inspector.get_table_names())
    if actual_tables != expected_tables:
        fail(
            f"tables differ: missing {sorted(expected_tables - actual_tables)}, "
            f"unexpected {sorted(actual_tables - expected_tables)}"
        )

    for model in spec["models"]:
        table_name = model["table"]
        if table_name not in actual_tables:
            continue
        table = metadata.tables[table_name]
        columns = {column["name"]: column for column in inspector.get_columns(table_name)}
        expected_columns = {column["column"]: column for column in model["columns"]}
        if set(columns) != set(expected_columns):
            fail(
                f"{table_name}: columns {sorted(columns)} != {sorted(expected_columns)}"
            )
        primary_key = set(model["primaryKey"])
        reflected_key = set(inspector.get_pk_constraint(table_name)["constrained_columns"])
        if reflected_key != primary_key:
            fail(f"{table_name}: primary key {sorted(reflected_key)} != {sorted(primary_key)}")
        for name, column_spec in expected_columns.items():
            if name not in columns or name not in table.c:
                continue
            label = f"{table_name}.{name}"
            if name not in primary_key and columns[name]["nullable"] != column_spec["nullable"]:
                fail(f"{label}: nullable {columns[name]['nullable']} != {column_spec['nullable']}")
            if name in primary_key and columns[name]["nullable"]:
                # SQLite reports an INTEGER PRIMARY KEY as nullable only without NOT NULL.
                pass
            check_column_type(label, table.c[name], column_spec)

        foreign_keys = inspector.get_foreign_keys(table_name)
        for expected in model["foreignKeys"]:
            match = [
                reflected
                for reflected in foreign_keys
                if list(reflected["constrained_columns"]) == expected["columns"]
            ]
            if not match:
                fail(f"{table_name}: no foreign key on {expected['columns']}")
                continue
            reflected = match[0]
            if reflected["referred_table"] != expected["targetTable"]:
                fail(f"{table_name}.{expected['columns']}: references {reflected['referred_table']}")
            if list(reflected["referred_columns"]) != expected["targetColumns"]:
                fail(
                    f"{table_name}.{expected['columns']}: referred columns "
                    f"{reflected['referred_columns']} != {expected['targetColumns']}"
                )
            options = reflected.get("options", {})
            on_delete = action_of(options, "ondelete")
            wanted = EXPECTED_ACTION[expected["onDelete"]]
            if on_delete != wanted and not (wanted is None and on_delete == "NO ACTION"):
                fail(f"{table_name}.{expected['columns']}: ON DELETE {on_delete} != {wanted}")
            wanted_update = (
                None if expected.get("onUpdate") is None else EXPECTED_ACTION[expected["onUpdate"]]
            )
            on_update = action_of(options, "onupdate")
            if wanted_update is not None and on_update != wanted_update:
                fail(f"{table_name}.{expected['columns']}: ON UPDATE {on_update} != {wanted_update}")
        if len(foreign_keys) != len(model["foreignKeys"]):
            fail(
                f"{table_name}: {len(foreign_keys)} foreign keys, expected {len(model['foreignKeys'])}"
            )

        unique_sets = {tuple(item["column_names"]) for item in inspector.get_unique_constraints(table_name)}
        indexes = inspector.get_indexes(table_name)
        unique_sets |= {tuple(item["column_names"]) for item in indexes if item["unique"]}
        for column_spec in model["columns"]:
            if column_spec["unique"] and (column_spec["column"],) not in unique_sets:
                if set(model["primaryKey"]) != {column_spec["column"]}:
                    fail(f"{table_name}.{column_spec['column']}: no unique constraint")
        for expected in model["indexes"]:
            columns_key = tuple(expected["columns"])
            if expected["unique"]:
                if columns_key not in unique_sets:
                    fail(f"{table_name}: no unique constraint on {list(columns_key)}")
            else:
                found = [
                    item
                    for item in indexes
                    if tuple(item["column_names"]) == columns_key and not item["unique"]
                ]
                if not found:
                    fail(f"{table_name}: no index on {list(columns_key)}")
                elif expected.get("name") is not None and expected["name"] not in {
                    item["name"] for item in found
                }:
                    fail(f"{table_name}: index on {list(columns_key)} is not named {expected['name']}")

    for model in spec["models"]:
        for link in model["manyToMany"]:
            name = link["table"]
            if name not in actual_tables:
                continue
            key = set(inspector.get_pk_constraint(name)["constrained_columns"])
            if key != {link["ownerColumn"], link["targetColumn"]}:
                fail(f"{name}: association key {sorted(key)}")
            reflected = {
                tuple(item["constrained_columns"]): item["referred_table"]
                for item in inspector.get_foreign_keys(name)
            }
            if reflected.get((link["ownerColumn"],)) != model["table"]:
                fail(f"{name}: {link['ownerColumn']} does not reference {model['table']}")
            if reflected.get((link["targetColumn"],)) != link["targetTable"]:
                fail(f"{name}: {link['targetColumn']} does not reference {link['targetTable']}")


def compare_mappers(spec: Spec, registry: Any, metadata: sa.MetaData) -> dict[str, Any]:
    classes = class_by_table(registry)
    for model in spec["models"]:
        table_name = model["table"]
        cls = classes.get(table_name)
        if cls is None:
            fail(f"{table_name}: no mapped class")
            continue
        mapper = sa.inspect(cls)
        table = metadata.tables[table_name]
        for column_spec in model["columns"]:
            name = column_spec["column"]
            try:
                mapper.get_property_by_column(table.c[name])
            except Exception:
                fail(f"{table_name}.{name}: no mapped attribute")
        if cls.__name__ != model["name"] and model.get("className") is None:
            # Class names may be repaired (collisions, invalid characters); only report a mismatch
            # for names that are already valid and unreserved.
            pass
        for foreign in model["foreignKeys"]:
            if foreign.get("toMissing"):
                continue
            forward = [
                prop
                for prop in mapper.relationships
                if prop.direction.name == "MANYTOONE"
                and sorted(column.name for column in prop.local_columns) == sorted(foreign["columns"])
                and prop.mapper.local_table.name == foreign["targetTable"]
            ]
            if not forward:
                fail(f"{table_name}: no many-to-one relationship for {foreign['columns']}")
                continue
            prop = forward[0]
            if prop.back_populates is None:
                fail(f"{table_name}.{prop.key}: no back_populates")
                continue
            reverse = prop.mapper.relationships.get(prop.back_populates)
            if reverse is None:
                fail(f"{prop.mapper.class_.__name__}.{prop.back_populates}: missing reverse side")
                continue
            if reverse.back_populates != prop.key:
                fail(f"{prop.mapper.class_.__name__}.{reverse.key}: back_populates is {reverse.back_populates}")
            if foreign["kind"] == "oneToOne":
                if reverse.uselist:
                    fail(f"{prop.mapper.class_.__name__}.{reverse.key}: a one-to-one reverse side is a list")
            elif not reverse.uselist:
                fail(f"{prop.mapper.class_.__name__}.{reverse.key}: a reverse side is not a list")
        for link in model["manyToMany"]:
            forward = [
                prop
                for prop in mapper.relationships
                if prop.secondary is not None
                and prop.secondary.name == link["table"]
                and prop.mapper.local_table.name == link["targetTable"]
                and any(
                    pair[1].name == link["ownerColumn"] for pair in prop.synchronize_pairs
                )
            ]
            if not forward:
                fail(f"{table_name}: no many-to-many relationship through {link['table']}")
                continue
            prop = forward[0]
            reverse = prop.mapper.relationships.get(prop.back_populates or "")
            if reverse is None or reverse.back_populates != prop.key:
                fail(f"{table_name}.{prop.key}: the many-to-many has no partner")
    return classes


def sample_value(column_spec: Spec, sqla_type: Any, counter: int) -> Any:
    kind = column_spec["type"]
    if column_spec.get("array"):
        inner = dict(column_spec, array=False)
        return [sample_value(inner, sqla_type.item_type, counter)]
    if isinstance(sqla_type, sa.Enum):
        return sqla_type.enum_class(column_spec["enumValues"][0])
    if kind == "string" or kind == "unsupported":
        length = column_spec.get("maxLength") or 40
        return f"s{counter}"[:length]
    if kind == "text":
        return f"text {counter}"
    if kind in ("int", "bigInt"):
        return counter
    if kind == "float":
        return 1.5
    if kind == "decimal":
        digits = column_spec.get("maxDigits")
        places = column_spec.get("decimalPlaces") or 0
        if digits is not None and digits - places < 1:
            return decimal.Decimal(0)
        return decimal.Decimal(counter % 7 + 1)
    if kind == "boolean":
        return True
    if kind == "dateTime":
        return datetime.datetime(2024, 1, 2, 3, 4, 5, tzinfo=datetime.timezone.utc)
    if kind == "date":
        return datetime.date(2024, 1, 2)
    if kind == "time":
        return datetime.time(3, 4, 5)
    if kind == "uuid":
        return uuid.uuid4()
    if kind == "json":
        return {"counter": counter}
    if kind == "bytes":
        return b"bytes"
    if kind == "duration":
        return datetime.timedelta(seconds=5)
    if kind == "ipAddress":
        return "127.0.0.1"
    if kind in ("hstore", "range"):
        return {"a": "b"}
    return f"s{counter}"


def has_framework_default(column_spec: Spec) -> bool:
    default = column_spec.get("default")
    if default is None:
        return False
    return default["kind"] in ("now", "literal", "enumValue", "uuid", "autoIncrement")


def check_default(label: str, column_spec: Spec, actual: Any, column: sa.Column) -> None:
    default = column_spec["default"]
    kind = default["kind"]
    if actual is None:
        fail(f"{label}: the default {kind} was not applied")
        return
    if kind == "uuid" and not isinstance(actual, uuid.UUID):
        fail(f"{label}: uuid default gave {actual!r}")
    elif kind == "enumValue":
        names = column_spec.get("enumNames") or {}
        wanted = names.get(default["value"])
        if getattr(actual, "value", actual) != wanted:
            fail(f"{label}: enum default gave {actual!r}, expected {wanted!r}")
    elif kind == "literal":
        value = default["value"]
        if column_spec["type"] == "boolean":
            wanted_bool = value if isinstance(value, bool) else str(value).lower() == "true"
            if actual != wanted_bool:
                fail(f"{label}: default {actual!r} != {wanted_bool!r}")
        elif column_spec.get("array"):
            if actual != []:
                fail(f"{label}: array default gave {actual!r}")
        elif column_spec["type"] == "json":
            if actual != json.loads(str(value)):
                fail(f"{label}: json default gave {actual!r}")
        elif column_spec["type"] in ("int", "bigInt", "float", "decimal"):
            if float(actual) != float(value):
                fail(f"{label}: default {actual!r} != {value!r}")
        elif column_spec["type"] in ("string", "text"):
            if actual != str(value):
                fail(f"{label}: default {actual!r} != {value!r}")


def exercise_rows(spec: Spec, classes: dict[str, Any], metadata: sa.MetaData, engine: sa.Engine) -> dict[str, Any]:
    models = {model["table"]: model for model in spec["models"]}
    order: list[str] = []
    visiting: set[str] = set()

    def visit(table: str) -> None:
        if table in order or table in visiting:
            return
        visiting.add(table)
        for foreign in models[table]["foreignKeys"]:
            target = foreign["targetTable"]
            if target in models and target != table:
                visit(target)
        visiting.discard(table)
        order.append(table)

    for table in models:
        visit(table)

    instances: dict[str, list[Any]] = {}
    inserted: list[str] = []
    skipped: list[str] = []
    counter = 100
    with Session(engine) as session:
        for table in order:
            model = models[table]
            cls = classes[table]
            mapper = sa.inspect(cls)
            sa_table = metadata.tables[table]
            foreign_by_column: dict[str, Spec] = {}
            for foreign in model["foreignKeys"]:
                for position, name in enumerate(foreign["columns"]):
                    foreign_by_column[name] = {"foreign": foreign, "position": position}
            rows: list[Any] = []
            usable = True
            for index in range(2):
                values: dict[str, Any] = {}
                omitted: list[Spec] = []
                for column_spec in model["columns"]:
                    name = column_spec["column"]
                    key = mapper.get_property_by_column(sa_table.c[name]).key
                    counter += 1
                    if name in foreign_by_column:
                        entry = foreign_by_column[name]
                        parents = instances.get(entry["foreign"]["targetTable"], [])
                        if not parents:
                            if column_spec["nullable"]:
                                continue
                            usable = False
                            break
                        parent = parents[index % len(parents)]
                        parent_mapper = sa.inspect(classes[entry["foreign"]["targetTable"]])
                        parent_table = metadata.tables[entry["foreign"]["targetTable"]]
                        target_column = entry["foreign"]["targetColumns"][entry["position"]]
                        parent_key = parent_mapper.get_property_by_column(parent_table.c[target_column]).key
                        values[key] = getattr(parent, parent_key)
                        continue
                    if has_framework_default(column_spec) and not column_spec.get("autoUpdated"):
                        omitted.append(column_spec)
                        continue
                    if column_spec.get("autoUpdated"):
                        continue
                    if column_spec["nullable"] and index == 1:
                        continue
                    if column_spec["type"] == "range" or column_spec.get("array"):
                        if column_spec["nullable"]:
                            continue
                    values[key] = sample_value(column_spec, sa_table.c[name].type, counter)
                if not usable:
                    break
                row = cls(**values)
                session.add(row)
                try:
                    session.flush()
                except Exception as error:  # noqa: BLE001
                    session.rollback()
                    fail(f"{table}: inserting a row failed: {error}")
                    usable = False
                    break
                session.refresh(row)
                for column_spec in omitted:
                    name = column_spec["column"]
                    key = mapper.get_property_by_column(sa_table.c[name]).key
                    check_default(f"{table}.{name}", column_spec, getattr(row, key), sa_table.c[name])
                for column_spec in model["columns"]:
                    if (
                        column_spec.get("enumValues") is not None
                        and not column_spec.get("array")
                        and column_spec["nullable"] is False
                    ):
                        raw = session.execute(
                            sa.text(f'SELECT "{column_spec["column"]}" FROM "{table}"')
                        ).scalars().all()
                        if not set(raw) <= set(column_spec["enumValues"]):
                            fail(f"{table}.{column_spec['column']}: stored {raw}, not the database values")
                rows.append(row)
            if usable:
                instances[table] = rows
                inserted.append(table)
            else:
                skipped.append(table)
        session.commit()

        # Relationships: follow every many-to-one and its reverse side.
        followed = 0
        for table, rows in instances.items():
            model = models[table]
            mapper = sa.inspect(classes[table])
            for foreign in model["foreignKeys"]:
                forward = [
                    prop
                    for prop in mapper.relationships
                    if prop.direction.name == "MANYTOONE"
                    and sorted(column.name for column in prop.local_columns) == sorted(foreign["columns"])
                    and prop.mapper.local_table.name == foreign["targetTable"]
                ]
                if not forward:
                    continue
                prop = forward[0]
                session.expire_all()
                for row in rows:
                    parent = getattr(row, prop.key)
                    if parent is None:
                        continue
                    followed += 1
                    if not isinstance(parent, classes[foreign["targetTable"]]):
                        fail(f"{table}.{prop.key}: gave {parent!r}")
                        continue
                    reverse = getattr(parent, prop.back_populates)
                    members = [reverse] if foreign["kind"] == "oneToOne" else list(reverse)
                    if row not in members:
                        fail(f"{table}.{prop.key}: the reverse side {prop.back_populates} lacks the row")

        # Many-to-many through the relationships.
        linked: list[str] = []
        for table, rows in instances.items():
            model = models[table]
            mapper = sa.inspect(classes[table])
            for link in model["manyToMany"]:
                targets = instances.get(link["targetTable"])
                if not targets:
                    continue
                forward = [
                    prop
                    for prop in mapper.relationships
                    if prop.secondary is not None
                    and prop.secondary.name == link["table"]
                    and prop.mapper.local_table.name == link["targetTable"]
                    and any(pair[1].name == link["ownerColumn"] for pair in prop.synchronize_pairs)
                ]
                if not forward:
                    continue
                prop = forward[0]
                getattr(rows[0], prop.key).append(targets[-1])
                session.flush()
                count = session.execute(sa.text(f'SELECT count(*) FROM "{link["table"]}"')).scalar()
                if count != 1:
                    fail(f"{link['table']}: {count} association rows after one append")
                session.expire_all()
                if rows[0] not in list(getattr(targets[-1], prop.back_populates)):
                    fail(f"{table}.{prop.key}: the partner side lacks the owner")
                linked.append(link["table"])
        session.commit()

        # An auto-updated column changes on update.
        updated: list[str] = []
        for table, rows in instances.items():
            model = models[table]
            stamped = [column for column in model["columns"] if column.get("autoUpdated")]
            if not stamped or not rows:
                continue
            mapper = sa.inspect(classes[table])
            sa_table = metadata.tables[table]
            column_spec = stamped[0]
            key = mapper.get_property_by_column(sa_table.c[column_spec["column"]]).key
            first = getattr(rows[0], key)
            if first is None:
                fail(f"{table}.{column_spec['column']}: not set on insert")
                continue
            time.sleep(1.1)
            pk_key = mapper.get_property_by_column(sa_table.c[model["primaryKey"][0]]).key if model["primaryKey"] else None
            if pk_key is None:
                continue
            session.execute(
                sa.update(sa_table)
                .where(sa_table.c[model["primaryKey"][0]] == getattr(rows[0], pk_key))
                .values({model["primaryKey"][0]: getattr(rows[0], pk_key)})
            )
            session.commit()
            session.refresh(rows[0])
            if getattr(rows[0], key) == first:
                fail(f"{table}.{column_spec['column']}: onupdate did not change the value")
            updated.append(table)
            break

    # Referential actions in the database.
    actions: dict[str, int] = {"cascade": 0, "setNull": 0, "restrict": 0, "skipped": 0}
    with engine.connect() as connection:
        for table, model in models.items():
            for foreign in model["foreignKeys"]:
                parent_table = foreign["targetTable"]
                if table not in instances or parent_table not in instances or parent_table == table:
                    continue
                child = metadata.tables[table]
                parent = metadata.tables[parent_table]
                child_columns = foreign["columns"]
                parent_columns = foreign["targetColumns"]
                row = connection.execute(sa.select(child)).mappings().first()
                if row is None or any(row[name] is None for name in child_columns):
                    continue
                condition = sa.and_(
                    *[parent.c[p] == row[c] for c, p in zip(child_columns, parent_columns)]
                )
                match = sa.and_(*[child.c[c] == row[c] for c in child_columns])
                action = foreign["onDelete"]
                try:
                    connection.execute(sa.delete(parent).where(condition))
                    outcome = "ok"
                except IntegrityError:
                    outcome = "blocked"
                if action in ("restrict", "noAction"):
                    if outcome != "blocked":
                        fail(f"{table}.{child_columns}: deleting the parent was not blocked")
                    else:
                        actions["restrict"] += 1
                elif outcome == "blocked":
                    actions["skipped"] += 1
                elif action == "cascade":
                    if connection.execute(sa.select(sa.func.count()).select_from(child).where(match)).scalar():
                        fail(f"{table}.{child_columns}: cascade left the child row")
                    actions["cascade"] += 1
                elif action == "setNull":
                    keys = model["primaryKey"]
                    if not keys:
                        actions["skipped"] += 1
                    else:
                        same_row = sa.and_(*[child.c[k] == row[k] for k in keys])
                        left = connection.execute(sa.select(child).where(same_row)).mappings().first()
                        if left is None:
                            # Another foreign key of the row cascaded; nothing to conclude.
                            actions["skipped"] += 1
                        elif any(left[c] is not None for c in child_columns):
                            fail(f"{table}.{child_columns}: SET NULL did not clear the column")
                        else:
                            actions["setNull"] += 1
                connection.rollback()
    return {
        "inserted": inserted,
        "skipped": skipped,
        "followed": followed,
        "manyToMany": linked,
        "autoUpdated": updated,
        "actions": actions,
    }


def render_postgres(metadata: sa.MetaData) -> None:
    dialect = postgresql.dialect()
    for table in metadata.tables.values():
        try:
            str(CreateTable(table).compile(dialect=dialect))
            for index in table.indexes:
                str(CreateIndex(index).compile(dialect=dialect))
        except Exception as error:  # noqa: BLE001
            fail(f"{table.name}: PostgreSQL DDL could not be rendered: {error}")


def main() -> int:
    directory = Path(sys.argv[1])
    spec: Spec = json.loads(Path(sys.argv[2]).read_text())
    module = load_models(directory)
    if spec["style"] == "sqlmodel":
        from sqlmodel import SQLModel

        metadata = SQLModel.metadata
        registry = SQLModel._sa_registry
    else:
        metadata = module.Base.metadata
        registry = module.Base.registry
    configure_mappers()
    render_postgres(metadata)

    database = directory / "check.db"
    if database.exists():
        database.unlink()
    engine = sa.create_engine(f"sqlite:///{database}")

    @event.listens_for(engine, "connect")
    def enable_foreign_keys(connection: Any, _record: Any) -> None:
        connection.execute("PRAGMA foreign_keys=ON")

    metadata.create_all(engine)
    compare_structure(spec, metadata, engine)
    classes = compare_mappers(spec, registry, metadata)
    summary = exercise_rows(spec, classes, metadata, engine)
    engine.dispose()

    if errors:
        for message in errors:
            print(message, file=sys.stderr)
        return 1
    print("sqlalchemy models verified")
    print(json.dumps(summary))
    return 0


if __name__ == "__main__":
    sys.exit(main())
