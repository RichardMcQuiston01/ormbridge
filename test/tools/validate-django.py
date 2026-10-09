"""Loads generated Django models with the real Django and compares them with the IR.

Usage: python -I validate-django.py <project dir> <spec.json>

<project dir> is a scratch directory that holds the app package ("blog/models.py").
<spec.json> is the expected schema written by the test (test/realToolSupport.ts). The
script

1. runs ``manage.py check`` (``call_command("check")``),
2. runs ``makemigrations --dry-run``, then ``makemigrations`` and ``sqlmigrate`` for real,
3. applies the migration to an in-memory SQLite database,
4. compares ``_meta`` (tables, columns, field types, relations, ``on_delete``) and the
   database introspection (columns, nullability, primary key, foreign keys, unique
   constraints and indexes) with the spec.

Every difference is printed to stderr and the exit code is 1; success prints
"django models verified" and exits with 0. Exit code 2 means Django is not importable.
"""

from __future__ import annotations

import io
import json
import sys
from contextlib import redirect_stdout
from pathlib import Path
from typing import Any

APP_LABEL = "blog"

# IR scalar type -> acceptable Django internal types.
FIELD_TYPES: dict[str, tuple[str, ...]] = {
    "string": ("CharField",),
    "text": ("TextField",),
    "int": (
        "IntegerField",
        "AutoField",
        "SmallIntegerField",
        "PositiveIntegerField",
        "PositiveSmallIntegerField",
    ),
    "bigInt": ("BigIntegerField", "BigAutoField", "PositiveBigIntegerField"),
    "float": ("FloatField",),
    "decimal": ("DecimalField",),
    "boolean": ("BooleanField",),
    "dateTime": ("DateTimeField",),
    "date": ("DateField",),
    "time": ("TimeField",),
    "uuid": ("UUIDField",),
    "json": ("JSONField",),
    "bytes": ("BinaryField",),
    "duration": ("DurationField",),
    "ipAddress": ("GenericIPAddressField",),
}

ON_DELETE_NAMES: dict[str, str] = {
    "cascade": "CASCADE",
    "setNull": "SET_NULL",
    "restrict": "PROTECT",
    "noAction": "DO_NOTHING",
    "setDefault": "SET_DEFAULT",
}

Spec = dict[str, Any]


def configure_django(project: Path) -> None:
    """Configures Django for the scratch project with an in-memory SQLite database."""
    sys.path.insert(0, str(project))
    import django
    from django.conf import settings

    settings.configure(
        INSTALLED_APPS=[APP_LABEL],
        DATABASES={
            "default": {
                "ENGINE": "django.db.backends.sqlite3",
                "NAME": ":memory:",
            }
        },
        DEFAULT_AUTO_FIELD="django.db.models.AutoField",
        USE_TZ=True,
        SECRET_KEY="ormbridge-verification",
    )
    django.setup()


def run_command(name: str, *args: str, **options: Any) -> str:
    """Runs a management command and returns what it printed."""
    from django.core.management import call_command

    buffer = io.StringIO()
    call_command(name, *args, stdout=buffer, stderr=buffer, **options)
    return buffer.getvalue()


def check_commands(spec: Spec, problems: list[str]) -> bool:
    """Runs check, makemigrations and migrate. Returns False when the models do not load."""
    try:
        run_command("check")
    except Exception as error:  # noqa: BLE001 - report any failure of `check`.
        problems.append(f"manage.py check failed: {error}")
        return False

    dry_run = run_command("makemigrations", APP_LABEL, dry_run=True, verbosity=3)
    for model in spec["models"]:
        if f"Create model {model['name']}" not in dry_run:
            problems.append(
                f"makemigrations --dry-run does not create model {model['name']}"
            )

    run_command("makemigrations", APP_LABEL)
    sql = run_command("sqlmigrate", APP_LABEL, "0001")
    for model in spec["models"]:
        if f'CREATE TABLE "{model["table"]}"' not in sql:
            problems.append(
                f"sqlmigrate does not create the table {model['table']} for "
                f"{model['name']}"
            )
    run_command("migrate", verbosity=0)
    return True


def check_meta(spec: Spec, problems: list[str]) -> None:
    """Compares the model metadata (``_meta``) with the spec."""
    from django.apps import apps
    from django.core.exceptions import FieldDoesNotExist

    config = apps.get_app_config(APP_LABEL)
    expected_names = {model["name"] for model in spec["models"]}
    for model in config.get_models():
        if model.__name__ not in expected_names:
            problems.append(f"unexpected model {model.__name__}")

    for expected in spec["models"]:
        name = expected["name"]
        try:
            model = config.get_model(name)
        except LookupError:
            problems.append(f"model {name} is missing")
            continue
        meta = model._meta
        if meta.db_table != expected["table"]:
            problems.append(
                f"{name}: db_table is {meta.db_table}, expected {expected['table']}"
            )

        expected_columns = {column["column"] for column in expected["columns"]}
        expected_columns |= {relation["column"] for relation in expected["relations"]}
        actual_columns = {field.column for field in meta.concrete_fields}
        if actual_columns != expected_columns:
            problems.append(
                f"{name}: columns are {sorted(actual_columns)}, "
                f"expected {sorted(expected_columns)}"
            )

        for column in expected["columns"]:
            try:
                field = meta.get_field(column["name"])
            except FieldDoesNotExist:
                problems.append(f"{name}: field {column['name']} is missing")
                continue
            check_field(name, field, column, problems)

        for relation in expected["relations"]:
            try:
                field = meta.get_field(relation["name"])
            except FieldDoesNotExist:
                problems.append(f"{name}: relation {relation['name']} is missing")
                continue
            check_relation(name, field, relation, problems)

        for relation in expected["manyToMany"]:
            try:
                field = meta.get_field(relation["name"])
            except FieldDoesNotExist:
                problems.append(f"{name}: many-to-many {relation['name']} is missing")
                continue
            target = field.remote_field.model.__name__
            if not field.many_to_many or target != relation["target"]:
                problems.append(
                    f"{name}.{relation['name']}: expected a many-to-many to "
                    f"{relation['target']}, got {target}"
                )


def check_field(
    model: str, field: Any, column: dict[str, Any], problems: list[str]
) -> None:
    """Compares one concrete field with its spec."""
    where = f"{model}.{column['name']}"
    if field.column != column["column"]:
        problems.append(
            f"{where}: column is {field.column}, expected {column['column']}"
        )
    accepted = FIELD_TYPES.get(column["type"])
    if accepted is not None and field.get_internal_type() not in accepted:
        problems.append(
            f"{where}: type is {field.get_internal_type()}, expected one of "
            f"{', '.join(accepted)} for {column['type']}"
        )
    if not column["primaryKey"] and field.null != column["nullable"]:
        problems.append(f"{where}: null is {field.null}, expected {column['nullable']}")
    if (field.unique or field.primary_key) != (
        column["unique"] or column["primaryKey"]
    ):
        problems.append(f"{where}: unique does not match (expected {column['unique']})")
    if field.primary_key != column["primaryKey"]:
        problems.append(f"{where}: primary_key is {field.primary_key}")
    is_enum = "enumValues" in column
    for attribute, key in (
        ("max_length", "maxLength"),
        ("max_digits", "maxDigits"),
        ("decimal_places", "decimalPlaces"),
    ):
        # An enum-backed column gets a max_length that fits its longest value.
        if is_enum and key == "maxLength":
            continue
        if key in column and getattr(field, attribute, None) != column[key]:
            problems.append(
                f"{where}: {attribute} is {getattr(field, attribute, None)}, "
                f"expected {column[key]}"
            )
    if is_enum:
        longest = max((len(value) for value in column["enumValues"]), default=0)
        if field.max_length is not None and field.max_length < longest:
            problems.append(
                f"{where}: max_length is {field.max_length}, shorter than the "
                f"longest enum value ({longest})"
            )
        choices = [str(value) for value, _label in (field.choices or [])]
        if choices != column["enumValues"]:
            problems.append(
                f"{where}: choices are {choices}, expected {column['enumValues']}"
            )


def check_relation(
    model: str, field: Any, relation: dict[str, Any], problems: list[str]
) -> None:
    """Compares one foreign key or one-to-one field with its spec."""
    where = f"{model}.{relation['name']}"
    remote = field.remote_field
    if not field.is_relation or remote is None:
        problems.append(f"{where}: is not a relation")
        return
    if field.column != relation["column"]:
        problems.append(
            f"{where}: column is {field.column}, expected {relation['column']}"
        )
    if remote.model._meta.db_table != relation["targetTable"]:
        problems.append(
            f"{where}: points at {remote.model._meta.db_table}, "
            f"expected {relation['targetTable']}"
        )
    if remote.model.__name__ != relation["target"]:
        problems.append(
            f"{where}: points at model {remote.model.__name__}, "
            f"expected {relation['target']}"
        )
    kind = "oneToOne" if field.one_to_one else "foreignKey"
    if kind != relation["kind"]:
        problems.append(f"{where}: is a {kind}, expected {relation['kind']}")
    if not relation["primaryKey"] and field.null != relation["nullable"]:
        problems.append(
            f"{where}: null is {field.null}, expected {relation['nullable']}"
        )
    on_delete = remote.on_delete.__name__
    if on_delete != ON_DELETE_NAMES[relation["onDelete"]]:
        problems.append(
            f"{where}: on_delete is {on_delete}, expected "
            f"{ON_DELETE_NAMES[relation['onDelete']]}"
        )
    related_name = relation.get("relatedName")
    if related_name is not None and remote.related_name != related_name:
        problems.append(
            f"{where}: related_name is {remote.related_name}, expected {related_name}"
        )


def check_database(spec: Spec, problems: list[str]) -> None:
    """Compares the migrated SQLite database with the spec."""
    from django.db import connection

    with connection.cursor() as cursor:
        introspection = connection.introspection
        tables = set(introspection.table_names(cursor))
        for expected in spec["models"]:
            table = expected["table"]
            if table not in tables:
                problems.append(f"the table {table} was not created")
                continue
            check_table(cursor, introspection, expected, problems)
            for relation in expected["manyToMany"]:
                check_join_table(tables, expected, relation, problems)


def check_table(
    cursor: Any, introspection: Any, expected: dict[str, Any], problems: list[str]
) -> None:
    """Compares the columns, keys and indexes of one table."""
    table = expected["table"]
    description = {
        column.name: column
        for column in introspection.get_table_description(cursor, table)
    }
    expected_columns = {column["column"]: column for column in expected["columns"]}
    expected_columns.update({r["column"]: r for r in expected["relations"]})
    if set(description) != set(expected_columns):
        problems.append(
            f"table {table}: columns are {sorted(description)}, "
            f"expected {sorted(expected_columns)}"
        )
    for name, column in expected_columns.items():
        info = description.get(name)
        if info is None or column.get("primaryKey"):
            continue
        nullable = column.get("nullable", False)
        if bool(info.null_ok) != nullable:
            problems.append(
                f"table {table}: column {name} null_ok is {info.null_ok}, "
                f"expected {nullable}"
            )

    primary_key = introspection.get_primary_key_columns(cursor, table) or []
    if sorted(primary_key) != sorted(expected["primaryKey"]):
        problems.append(
            f"table {table}: primary key is {primary_key}, expected {expected['primaryKey']}"
        )

    relations = introspection.get_relations(cursor, table)
    for relation in expected["relations"]:
        found = relations.get(relation["column"])
        if found is None or found[1] != relation["targetTable"]:
            problems.append(
                f"table {table}: no foreign key from {relation['column']} to "
                f"{relation['targetTable']} (found {found})"
            )

    constraints = introspection.get_constraints(cursor, table)
    unique_sets = {
        tuple(entry["columns"])
        for entry in constraints.values()
        if entry["unique"] and not entry["primary_key"]
    }
    index_sets = {
        tuple(entry["columns"]) for entry in constraints.values() if entry["index"]
    }
    for column in expected["columns"]:
        if column["unique"] and not column["primaryKey"]:
            if (column["column"],) not in unique_sets:
                problems.append(
                    f"table {table}: no unique constraint on {column['column']}"
                )
    for relation in expected["relations"]:
        if relation["kind"] == "oneToOne" and not relation["primaryKey"]:
            if (relation["column"],) not in unique_sets:
                problems.append(
                    f"table {table}: no unique constraint on {relation['column']}"
                )
    for index in expected["indexes"]:
        columns = tuple(index["columns"])
        found = unique_sets if index["unique"] else index_sets
        if columns not in found:
            problems.append(
                f"table {table}: no {'unique ' if index['unique'] else ''}index on "
                f"{list(columns)}"
            )
        name = index.get("name")
        if name is not None and len(name) <= 30 and name not in constraints:
            problems.append(f"table {table}: no constraint or index named {name}")


def check_join_table(
    tables: set[str],
    expected: dict[str, Any],
    relation: dict[str, Any],
    problems: list[str],
) -> None:
    """Checks that Django created a join table for a many-to-many field."""
    from django.apps import apps

    model = apps.get_app_config(APP_LABEL).get_model(expected["name"])
    try:
        field = model._meta.get_field(relation["name"])
    except Exception:  # noqa: BLE001 - already reported by check_meta.
        return
    through = field.remote_field.through._meta.db_table
    if through not in tables:
        problems.append(
            f"{expected['name']}.{relation['name']}: join table {through} was not created"
        )


def main(argv: list[str]) -> int:
    """Entry point."""
    if len(argv) < 3:
        print(__doc__, file=sys.stderr)
        return 2
    project = Path(argv[1]).resolve()
    spec: Spec = json.loads(Path(argv[2]).read_text(encoding="utf8"))
    try:
        configure_django(project)
    except ImportError as error:
        print(f"Django is not importable: {error}", file=sys.stderr)
        return 2

    problems: list[str] = []
    try:
        loaded = io.StringIO()
        with redirect_stdout(loaded):
            migrated = check_commands(spec, problems)
    except Exception as error:  # noqa: BLE001 - surface the failure with its type.
        print(f"{type(error).__name__}: {error}", file=sys.stderr)
        return 1
    check_meta(spec, problems)
    if migrated:
        check_database(spec, problems)

    if problems:
        for problem in problems:
            print(f"- {problem}", file=sys.stderr)
        return 1
    print(f"django models verified: {len(spec['models'])} models")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
