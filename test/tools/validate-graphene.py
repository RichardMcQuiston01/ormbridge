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
4. creates the tables and runs every list query, and a create / query / update / delete
   round trip on each model whose input needs no other row.

Every difference is printed to stderr and the exit code is 1; success prints
"graphene schema verified" and exits with 0. Exit code 2 means Django or graphene-django
is not importable.
"""

from __future__ import annotations

import json
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


def configure_django(project: Path) -> None:
    """Configures Django for the scratch project with an in-memory SQLite database."""
    sys.path.insert(0, str(project))
    import django
    from django.conf import settings

    settings.configure(
        INSTALLED_APPS=["graphene_django", APP_LABEL],
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


def required_input(schema: Any, input_name: str) -> str | None:
    """Builds the input literal of a mutation, or None when it needs other rows."""
    fields = type_fields(schema, input_name)
    if fields is None:
        return None
    values: list[str] = []
    for name, field in fields.items():
        if not str(field.type).endswith("!"):
            continue
        scalar = getattr(unwrap(field.type), "name", "")
        if scalar not in SAMPLE_VALUES or scalar == "ID":
            return None
        values.append(f"{name}: {SAMPLE_VALUES[scalar]}")
    return "{" + ", ".join(values) + "}"


def key_field(model: dict[str, Any]) -> str | None:
    """The GraphQL name of the single-column primary key of a model, if it has one."""
    names = [column["name"] for column in model["columns"] if column["primaryKey"]]
    names += [rel["name"] for rel in model["relations"] if rel["primaryKey"]]
    return camel(names[0]) if len(names) == 1 else None


def run_queries(schema: Any, spec: Spec, problems: list[str]) -> None:
    """Creates the tables, runs every list query and a CRUD round trip where possible."""
    from django.core.management import call_command

    call_command("migrate", run_syncdb=True, verbosity=0)
    for model in spec["models"]:
        name = model["name"]
        base = camel(snake(name))
        composite = len(model["primaryKey"]) > 1
        try:
            data = execute(schema, f"{{ {base}List {{ __typename }} }}")
            if data[f"{base}List"] != []:
                problems.append(f"{base}List is not empty on a new database")
        except RuntimeError as error:
            problems.append(str(error))
            continue
        key = key_field(model)
        # Sample values cannot satisfy columns with a database-specific type (an Inet
        # column validates as an IP address), so those models only get the list query.
        if (
            composite
            or key is None
            or any(c.get("nativeType") for c in model["columns"])
        ):
            continue
        literal = required_input(schema, f"{name}Input")
        if literal is None:
            continue
        try:
            created = execute(
                schema,
                f"mutation {{ create{name}(input: {literal}) "
                f"{{ {base} {{ {key} }} }} }}",
            )
            identifier = created[f"create{name}"][base][key]
            fetched = execute(schema, f'{{ {base}(id: "{identifier}") {{ {key} }} }}')
            if fetched[base] is None:
                problems.append(f"{base}(id) did not find the created {name}")
            if type_fields(schema, f"{name}UpdateInput") is not None:
                updated = required_input(schema, f"{name}UpdateInput")
                if updated is not None:
                    execute(
                        schema,
                        f'mutation {{ update{name}(id: "{identifier}", '
                        f"input: {updated}) {{ {base} {{ {key} }} }} }}",
                    )
            deleted = execute(
                schema, f'mutation {{ delete{name}(id: "{identifier}") {{ ok }} }}'
            )
            if deleted[f"delete{name}"]["ok"] is not True:
                problems.append(f"delete{name} did not report ok")
        except RuntimeError as error:
            problems.append(str(error))


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
    run_queries(schema, spec, problems)

    if problems:
        for problem in problems:
            print(f"- {problem}", file=sys.stderr)
        return 1
    print(
        f"graphene schema verified: {len(spec['models'])} models, {len(sdl.splitlines())} SDL lines"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
