# Graphene

Graphene (graphene-django) is a Python GraphQL library. ormbridge writes a Graphene schema file and cannot read one (`ormbridge formats` lists it as `write`). It claims no file extension, because `.py` belongs to Django, so always pass `--to graphene`. The output is one text file, written to `-o`, and it is meant to sit next to a Django `models.py`, which you can generate with `--to django`.

## Try it

```bash
cd examples/graphene
npx ormbridge convert           # ../schema/schema.prisma -> generated/schema.py
npx ormbridge convert --check   # exit code 3 if generated/schema.py is stale
# inside this repository, after npm run build: node ../../dist/cli.js convert
```

The conversion produces `generated/schema.py` (490 lines) and prints two warnings, quoted below. The runnable example is in [examples/graphene](../../examples/graphene/).

## Reading: not supported

There is no `--from graphene`; use a Django `models.py` or any other readable format as the source.

## Writing

`schema.py` imports every model from `.models` and defines:

- a `DjangoObjectType` per model with an explicit `Meta.fields` list, including forward and reverse relations
- a `Query` with a single-item field (`post(id)`) and a list field (`post_list`) per model
- `Create`, `Update` and `Delete` mutations per model, built on `graphene.Mutation`; they run `full_clean()` before saving
- a final `schema = graphene.Schema(query=Query, mutation=Mutation)`

Input scalars: `String`, `Int`, `BigInt`, `Float`, `Decimal`, `Boolean`, `DateTime`, `Date`, `Time`, `UUID` and `JSONString`. A field is required when it is not nullable and has no default. Relations are `ID` inputs (`author_id`, and `tags_ids` for many-to-many). Enum-backed fields use graphene-django's choice conversion for output and are `String` inputs that the model validates. Field names are snake_case, like the Django output.

To use it, put the file in a Django app next to a `models.py` that defines the same models, for example:

```bash
ormbridge convert -i schema.prisma --to django -o ./blog/models.py
ormbridge convert -i schema.prisma --to graphene -o ./blog/schema.py
```

It requires graphene-django 3.x at runtime. The only options that matter are `--from`, `--to`, `-i`, `-o`, `--dry-run` and `--check`: `--naming`, `--provider` and the format flags have no effect on Graphene output, apart from the shared schema warnings.

## Limitations and warnings

- Binary columns, and relations to models outside the schema, are left out of the types. Columns with a type that has no GraphQL input scalar are left out of the mutation inputs.
- A model with a composite primary key gets only the list query and the create mutation.
- A reverse accessor or Query field that clashes with another name is skipped, with a warning.
- A schema with no models gets only a placeholder `ping` query.
- Prisma-only constructs also produce the shared warnings (for example `Doc.body: the database type "tsvector" (Prisma Unsupported) has no equivalent here; the column was written as a plain string.`).

Warnings from the example:

```text
warning: Post.status: the enum PostStatus is accepted as a String in mutation inputs; the model validates the value.
warning: User: the model has no updatable fields, so no update mutation was generated.
```

Graphene is write-only and is not covered by [the conversion matrix](../CONVERSION_MATRIX.md), which only compares readable formats and Zod. The README's Graphene section describes the output, and the tests build the generated schema with real Django and graphene-django when they are installed.

## Programmatic API

All functions return `Result<T>` and do not throw.

```ts
import { readFile } from 'node:fs/promises';
import { convertText } from 'ormbridge';
import type { ConvertResult, Result } from 'ormbridge';

const text: string = await readFile('schema.prisma', 'utf8');
const result: Result<ConvertResult> = await convertText(
  [{ path: 'schema.prisma', text }],
  {
    from: 'prisma',
    to: 'graphene',
    naming: 'preserve',
    provider: 'postgresql',
    header: true,
    autoField: 'int',
  }
);
if (!result.ok) {
  console.error(result.error.code, result.error.message);
} else {
  console.log(result.value.output); // the schema.py text
  console.log(result.value.warnings);
}
```

Lower-level: `emitGraphene(schema)` takes an `IrSchema` (from any `parse*` function) and returns `{ text, warnings }`.
