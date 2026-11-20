"""Builds a generated graphene-django schema with the real graphene and compares it with the IR.

Usage: python -I validate-graphene.py <project dir> <spec.json>

<project dir> holds the app package "blog" with the generated "models.py" and "schema.py".
<spec.json> is the expected schema written by the test (test/realToolSupport.ts). The
script

1. configures Django on in-memory SQLite and imports ``blog.schema`` (which imports the
   generated models, so a missing model or field name fails here),
2. checks that ``schema`` is a ``graphene.Schema``, prints its SDL and runs the standard
   introspection query,
3. looks for an object type, a ``Query`` single and list field and the ``Create`` /
   ``Update`` / ``Delete`` mutations of every model, the scalar and relation fields of
   every object type and the enum type behind every enum-backed field,
4. creates the tables, runs every list query, then creates a row of every model that can
   be created (a model whose input needs another row follows the model it points at),
   fetches and updates each one and deletes them in reverse order.

When the models file defines no ``User`` (the models of a Django source use the project's
user model) the project also installs ``django.contrib.auth``, so ``auth.User`` is the
user model.

Every difference is printed to stderr and the exit code is 1; success prints
"graphene schema verified" and exits with 0. Exit code 2 means Django or graphene-django
is not importable.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path
from typing import Any

APP_LABEL = "blog"

Spec = dict[str, Any]

# GraphQL scalar -> sample value for a required input.
SAMPLE_VALUES: dict[str, str] = {
    "String": '"sample"',
    "Int": "1",
    "BigInt": "1",
    "Float": "1.5",
    "Decimal": '"1.50"',
    "Boolean": "true",
    "DateTime": '"2024-01-01T00:00:00+00:00"',
    "Date": '"2024-01-01"',
    "Time": '"12:00:00"',
    "UUID": '"123e4567-e89b-12d3-a456-426614174000"',
    "JSONString": '"{\\"sample\\": 1}"',
}


def defines_user_model(project: Path) -> bool:
    """True when the generated models file defines its own ``User`` model."""
    models = (project / APP_LABEL / "models.py").read_text(encoding="utf8")
    return re.search(r"^class User\b", models, re.MULTILINE) is not None


def configure_django(project: Path) -> None:
    """Configures Django for the scratch project with an in-memory SQLite database.

    The models of a Django source point their foreign keys at ``settings.AUTH_USER_MODEL``
    and do not define the user model, so the project installs ``django.contrib.auth``
    (``auth.User``, the default user model, in the table ``auth_user``). Models generated
    from another format define their own ``User`` in the app, which would clash with it.
    """
    sys.path.insert(0, str(project))
    import django
    from django.conf import settings

    installed_apps = ["graphene_django", APP_LABEL]
    if not defines_user_model(project):
        installed_apps = [
            "django.contrib.contenttypes",
            "django.contrib.auth",
            *installed_apps,
        ]
    settings.configure(
        INSTALLED_APPS=installed_apps,
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


def snake(name: str) -> str:
    """The snake_case form of a model name, as the emitter writes it."""
    from graphene.utils.str_converters import to_snake_case

    return to_snake_case(name)


def camel(name: str) -> str:
    """The GraphQL name graphene gives a snake_case Python name."""
    from graphene.utils.str_converters import to_camel_case

    return to_camel_case(name)


def type_fields(schema: Any, name: str) -> dict[str, Any] | None:
    """The fields of a GraphQL object type, or None when the type does not exist."""
    graphql_type = schema.graphql_schema.type_map.get(name)
    if graphql_type is None or not hasattr(graphql_type, "fields"):
        return None
    return dict(graphql_type.fields)


def unwrap(graphql_type: Any) -> Any:
    """Strips NonNull and List wrappers."""
    while hasattr(graphql_type, "of_type"):
        graphql_type = graphql_type.of_type
    return graphql_type


def check_types(schema: Any, spec: Spec, problems: list[str]) -> None:
    """Checks the object types, their fields and the enum types."""
    from graphene_django.converter import convert_choice_name
    from graphql import GraphQLEnumType

    for model in spec["models"]:
        name = model["name"]
        fields = type_fields(schema, name)
        if fields is None:
            problems.append(f"the object type {name} is missing from the schema")
            continue
        for column in model["columns"]:
            if column["type"] == "bytes":
                continue
            field = fields.get(camel(column["name"]))
            if field is None:
                problems.append(f"{name}.{column['name']} is missing from the schema")
                continue
            if "enumValues" in column:
                enum_type = unwrap(field.type)
                if not isinstance(enum_type, GraphQLEnumType):
                    problems.append(
                        f"{name}.{column['name']} is {enum_type}, expected an enum"
                    )
                    continue
                expected = {convert_choice_name(v) for v in column["enumValues"]}
                if set(enum_type.values) != expected:
                    problems.append(
                        f"{name}.{column['name']}: enum values are "
                        f"{sorted(enum_type.values)}, expected {sorted(expected)}"
                    )
        for relation in model["relations"]:
            field = fields.get(camel(relation["name"]))
            if field is None:
                problems.append(f"{name}.{relation['name']} is missing from the schema")
            elif getattr(unwrap(field.type), "name", None) != relation["target"]:
                problems.append(
                    f"{name}.{relation['name']} is {unwrap(field.type)}, "
                    f"expected {relation['target']}"
                )
        for relation in model["manyToMany"]:
            field = fields.get(camel(relation["name"]))
            if field is None:
                problems.append(f"{name}.{relation['name']} is missing from the schema")
        # Reverse accessors with an explicit name are exposed on the target type.
        for other in spec["models"]:
            for relation in other["relations"]:
                reverse = relation.get("relatedName")
                if relation["target"] != name or reverse is None:
                    continue
                if camel(reverse) not in fields:
                    problems.append(
                        f"{name}.{reverse} (reverse of {other['name']}."
                        f"{relation['name']}) is missing from the schema"
                    )


def check_operations(schema: Any, spec: Spec, problems: list[str]) -> None:
    """Checks the Query and Mutation scaffolding."""
    query = type_fields(schema, "Query") or {}
    mutation = type_fields(schema, "Mutation") or {}
    if not mutation:
        problems.append("the schema has no Mutation type")
    for model in spec["models"]:
        name = model["name"]
        base = snake(name)
        composite = len(model["primaryKey"]) > 1
        wanted_query = [f"{camel(base)}List"]
        wanted_mutation = [f"create{name}"]
        if not composite:
            wanted_query.append(camel(base))
            wanted_mutation.append(f"delete{name}")
        for field in wanted_query:
            if field not in query:
                problems.append(f"Query.{field} is missing")
        for field in wanted_mutation:
            if field not in mutation:
                problems.append(f"Mutation.{field} is missing")


def execute(schema: Any, query: str) -> dict[str, Any]:
    """Runs a query and returns its data; raises when the result has errors."""
    result = schema.execute(query)
    if result.errors:
        raise RuntimeError(f"{query.strip()!r} failed: {result.errors[0]}")
    return result.data or {}


def required_input(
    schema: Any,
    input_name: str,
    model: dict[str, Any],
    created: dict[str, str],
) -> str | None:
    """Builds the input literal of a mutation, or None when it needs rows not created yet.

    A required relation is filled with the id of a row of its target model, taken from
    ``created`` (the ids of the rows the round trip created so far).
    """
    fields = type_fields(schema, input_name)
    if fields is None:
        return None
    # The emitter names the input of a relation `<relation>_id`.
    targets = {
        camel(f"{relation['name']}_id"): relation["target"]
        for relation in model["relations"]
    }
    values: list[str] = []
    for name, field in fields.items():
        if not str(field.type).endswith("!"):
            continue
        scalar = getattr(unwrap(field.type), "name", "")
        if scalar == "ID":
            target = targets.get(name)
            if target is None or target not in created:
                return None
            values.append(f'{name}: "{created[target]}"')
        elif scalar in SAMPLE_VALUES:
            values.append(f"{name}: {SAMPLE_VALUES[scalar]}")
        else:
            return None
    return "{" + ", ".join(values) + "}"


def key_field(model: dict[str, Any]) -> str | None:
    """The GraphQL name of the single-column primary key of a model, if it has one."""
    names = [column["name"] for column in model["columns"] if column["primaryKey"]]
    names += [rel["name"] for rel in model["relations"] if rel["primaryKey"]]
    return camel(names[0]) if len(names) == 1 else None


def create_row(
    schema: Any, model: dict[str, Any], created: dict[str, str]
) -> str | None:
    """Creates one row through the Create mutation and returns its id.

    Returns None when the model cannot be created yet: its input needs a row of another
    model that does not exist, or its columns take values samples cannot satisfy.
    """
    name = model["name"]
    base = camel(snake(name))
    key = key_field(model)
    # Sample values cannot satisfy columns with a database-specific type (an Inet
    # column validates as an IP address).
    if (
        len(model["primaryKey"]) > 1
        or key is None
        or any(c.get("nativeType") for c in model["columns"])
    ):
        return None
    selection = f"{{ {base} {{ {key} }} }}"
    if type_fields(schema, f"{name}Input") is None:
        # A model without writable fields has a Create mutation without arguments.
        mutation = f"mutation {{ create{name} {selection} }}"
    else:
        literal = required_input(schema, f"{name}Input", model, created)
        if literal is None:
            return None
        mutation = f"mutation {{ create{name}(input: {literal}) {selection} }}"
    created_row = execute(schema, mutation)
    return str(created_row[f"create{name}"][base][key])


def run_queries(schema: Any, spec: Spec, problems: list[str]) -> list[str]:
    """Creates the tables, runs every list query and a CRUD round trip where possible.

    Rows are created in passes, so a model whose input needs another row (a post needs its
    author and category) follows the models it points at. Every created row is then fetched
    and updated, and the rows are deleted in the reverse order of their creation. Returns
    the names of the models that went through the round trip.
    """
    from django.core.management import call_command

    call_command("migrate", run_syncdb=True, verbosity=0)
    models = {model["name"]: model for model in spec["models"]}
    for name, model in models.items():
        base = camel(snake(name))
        try:
            data = execute(schema, f"{{ {base}List {{ __typename }} }}")
            if data[f"{base}List"] != []:
                problems.append(f"{base}List is not empty on a new database")
        except RuntimeError as error:
            problems.append(str(error))

    created: dict[str, str] = {}
    pending = list(models)
    progress = True
    while pending and progress:
        progress = False
        for name in list(pending):
            try:
                identifier = create_row(schema, models[name], created)
            except RuntimeError as error:
                problems.append(str(error))
                pending.remove(name)
                continue
            if identifier is not None:
                created[name] = identifier
                pending.remove(name)
                progress = True

    for name, identifier in created.items():
        model = models[name]
        base = camel(snake(name))
        key = key_field(model)
        try:
            fetched = execute(
                schema, f'{{ {base}(id: "{identifier}") {{ {key} }} }}'
            )
            if fetched[base] is None:
                problems.append(f"{base}(id) did not find the created {name}")
            listed = execute(schema, f"{{ {base}List {{ {key} }} }}")
            if [str(row[key]) for row in listed[f"{base}List"]] != [identifier]:
                problems.append(f"{base}List does not list the created {name}")
            if type_fields(schema, f"{name}UpdateInput") is not None:
                literal = required_input(schema, f"{name}UpdateInput", model, created)
                if literal is not None:
                    execute(
                        schema,
                        f'mutation {{ update{name}(id: "{identifier}", '
                        f"input: {literal}) {{ {base} {{ {key} }} }} }}",
                    )
        except RuntimeError as error:
            problems.append(str(error))

    for name, identifier in reversed(created.items()):
        try:
            deleted = execute(
                schema, f'mutation {{ delete{name}(id: "{identifier}") {{ ok }} }}'
            )
            if deleted[f"delete{name}"]["ok"] is not True:
                problems.append(f"delete{name} did not report ok")
            base = camel(snake(name))
            gone = execute(schema, f'{{ {base}(id: "{identifier}") {{ __typename }} }}')
            if gone[base] is not None:
                problems.append(f"{name} {identifier} still exists after delete{name}")
        except RuntimeError as error:
            problems.append(str(error))
    return list(created)


def main(argv: list[str]) -> int:
    """Entry point."""
    if len(argv) < 3:
        print(__doc__, file=sys.stderr)
        return 2
    project = Path(argv[1]).resolve()
    spec: Spec = json.loads(Path(argv[2]).read_text(encoding="utf8"))
    try:
        configure_django(project)
        import graphene
        from graphql import get_introspection_query
    except ImportError as error:
        print(f"graphene-django is not importable: {error}", file=sys.stderr)
        return 2

    from importlib import import_module

    try:
        module = import_module(f"{APP_LABEL}.schema")
    except Exception as error:  # noqa: BLE001 - surface the failure with its type.
        print(
            f"importing {APP_LABEL}.schema failed: {type(error).__name__}: {error}",
            file=sys.stderr,
        )
        return 1
    schema = getattr(module, "schema", None)
    if not isinstance(schema, graphene.Schema):
        print(
            "the module does not define `schema = graphene.Schema(...)`",
            file=sys.stderr,
        )
        return 1

    problems: list[str] = []
    sdl = str(schema)
    if "type Query" not in sdl:
        problems.append("the SDL has no Query type")
    introspection = schema.execute(get_introspection_query())
    if introspection.errors:
        problems.append(f"the introspection query failed: {introspection.errors[0]}")
    check_types(schema, spec, problems)
    check_operations(schema, spec, problems)
    round_trip = run_queries(schema, spec, problems)

    if problems:
        for problem in problems:
            print(f"- {problem}", file=sys.stderr)
        return 1
    print(
        f"graphene schema verified: {len(spec['models'])} models, "
        f"{len(sdl.splitlines())} SDL lines, round trip: {', '.join(round_trip)}"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
