# Zod

The `zod` format reads [Zod](https://zod.dev) 3 and Zod 4 schemas and writes Zod 4 schemas with their inferred TypeScript types. The written schemas validate the same data the [`typescript`](typescript.md) format describes. It claims no file extension (`.ts` belongs to no single format), so always pass `--from zod` or `--to zod`. The files are never run: the reader only looks at the source text.

## Try it

The example project is [`examples/zod`](../../examples/zod/). Its config has two conversions:

```sh
cd examples/zod
npx ormbridge convert           # runs both conversions below
npx ormbridge convert --check   # exits with code 3 if a generated file is missing or differs
```

| Conversion | Input                     | Output                 |
| ---------- | ------------------------- | ---------------------- |
| `to-zod`   | `../schema/schema.prisma` | `generated/schemas.ts` |
| `from-zod` | `generated/schemas.ts`    | `prisma/schema.prisma` |

Inside this repository, run `npm run build` once and use `node ../../dist/cli.js convert` instead. Single conversions without the config file:

```sh
npx ormbridge convert -i ../schema/schema.prisma --from prisma --to zod -o generated/schemas.ts
npx ormbridge convert -i generated --from zod --to prisma -o prisma/schema.prisma
```

## Reading

Every top-level `const UserSchema = z.object({ ... })` is a model. The model is named after the variable without the `Schema` ending (`UserSchema` gives `User`) and keeps the order of the properties. Plain `z.infer` types, interfaces, schemas written inside functions and a `export default z.object(...)` are not models.

- **Input.** A file, or a folder read recursively: every `.ts`, `.mts`, `.js` and `.mjs` file except `*.d.ts`, `*.test.*`, `*.spec.*` and anything under `node_modules/`, `dist/`, `build/`, `coverage/` and `.git/`. Several files may refer to each other by name: a schema, an enum or a shared property object that one file imports is found in the other input file. The import itself is not followed.
- **Zod 3 and Zod 4.** Both spellings of the string formats work: `z.string().uuid()` and `z.uuid()`, `.email()` and `z.email()`, `.datetime()` and `z.iso.datetime()`, `.int()` and `z.int()`. `z.coerce.*` is read as the plain type. The namespace can be `z`, `zod`, `* as z`, the default import, `import { z } from 'zod/v4'` or named imports (`import { object, string } from 'zod'`).
- **Types.** Strings with `.max(n)` or `.length(n)` are length-limited strings, other strings are `text`. `.int()` and `z.int()` make `int`, other numbers are `float`, `z.bigint()` is `bigInt`. `z.date()` is a date-time (Zod cannot say "date only" there; `z.iso.date()` is a date). `uuid`, IP addresses, base64, ISO dates, times and durations map to their column types. `z.record`, `z.any`, `z.unknown` and `z.json` are `json`. Arrays become array columns.
- **Enums.** `z.enum([...])`, `z.enum(CONST_ARRAY)`, `z.enum(constObject)`, `z.nativeEnum(TsEnum)` and a union of string literals become enums. A named schema (`const RoleSchema = z.enum([...])`) gives the enum `Role`. An enum written inside a property is named after the model and the property (`UserRole`). Members of a const object or TypeScript enum keep their names and values. A numeric TypeScript enum cannot be an enum here: the column is an `int` and a warning says so.
- **Nullable and default.** `.optional()`, `.nullable()` and `.nullish()` make a column nullable, and so does a union with `z.null()`. `.default(x)` and `.catch(x)` read the default when it is a literal, an enum value, `() => new Date()`, `crypto.randomUUID()`, or `{}` or `[]` on a json column. A column with a default is not nullable, even with `.optional()`.
- **Primary keys.** Zod has no keys. The property named `id` (in any case) is the primary key, and it is never nullable. When no property has that name the model has no key and a warning says so.
- **Schemas inside schemas.** A property that holds another schema of the input (`author: UserSchema`, `z.lazy(() => UserSchema)`, or a Zod 4 getter such as `get parent() { return CategorySchema.nullable(); }`) is read as a foreign key to that model. The column is `<property>_id` and there is no delete rule, because Zod cannot say either. A list of schemas (`posts: z.array(PostSchema)`) is the reverse side of that foreign key when `Post` points back, and a many-to-many field otherwise. Each of these reads gives a warning, because it is a guess.
- **Building schemas from schemas.** `.extend`, `.merge`, `.pick`, `.omit`, `.partial`, `.required`, `...Other.shape` and a spread of a plain object of properties are applied when the base schema is in the input. The result is a model of its own. A schema built from one that is not in the input is skipped with a warning.
- **Dropped.** The shared model keeps no validation rules or comments. `.describe()` and `.meta()` are dropped without a word. Every other rule that has no column (`.min()`, `.email()`, `.regex()`, `.refine()`, `.transform()`, `.pipe()`, `.brand()`, `z.literal('a')` and more) is dropped, and **one warning for each schema** lists every property and rule:

```
warning: User: Zod rules the shared model has no place for were ignored: email (.email()); name (.min(3), .trim()); the schema itself (.refine())
```

- **Warnings that name the model and the property** are written for a nested `z.object`, a tuple, an intersection, a union of unlike types (all kept as `json`), a name that is not declared in the input, a Zod constructor the reader does not know, a schema that refers to itself, and two schemas that would get the same name (the second gets a number).

## Writing

One file, starting with `import { z } from 'zod';`. Property, enum and relation naming match the `typescript` output, so the two can be generated side by side. For every model the file declares:

| Export                                               | Meaning                                                                                                                                                                           |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<Model>Schema`, type `<Model>`                      | The row as stored. Foreign-key scalars are included; relation fields are not.                                                                                                     |
| `<Model>CreateSchema`, `<Model>Create`               | The row minus database-generated columns (auto-increment keys, generated columns, auto-updated timestamps). Columns with a default and nullable columns become optional.          |
| `<Model>UpdateSchema`, `<Model>Update`               | The create schema made partial.                                                                                                                                                   |
| `<Model>WithRelationsSchema`, `<Model>WithRelations` | Only for models that take part in a relation: the row plus optional related rows, resolved with `z.lazy`. The type is written by hand because the schemas are mutually recursive. |

Views get neither create nor update schemas.

Type mappings that matter:

- `string` and `text` are `z.string()`, with `.max(n)` when the column has a length; `int` is `z.number().int()`; `float` is `z.number()`; `json` is `z.unknown()`; `uuid` is `z.uuid()`; `bytes` is `z.base64()`; IP addresses are `z.union([z.ipv4(), z.ipv6()])`; times and durations are `z.string()`.
- `bigInt` is a string of digits and `decimal` is a string with a regex sized from the precision and scale (`decimal(4, 2)` gives `/^-?\d{1,2}(\.\d{1,2})?$/`), because JSON cannot carry either without losing precision.
- Date and date-time columns are `z.coerce.date()`.
- Enums are a const object plus `z.enum(...)`: `export const PostStatus = { DRAFT: 'draft', ... } as const;`, `PostStatusSchema` and a type of the same name. Labels become comments.
- Nullable columns add `.nullable()`; array columns wrap the element in `z.array(...)`.

Options that apply: `--naming preserve` (default) keeps property names; `--naming normalize` writes camelCase properties and UUID keys (`z.uuid()`). The config-file key `naming` is the same flag. `--provider`, `--style` and the remaining flags are ignored.

## What is lost

The Zod writer and reader are tested together: every canonical fixture is written with `--to zod` and read back with `--from zod`, and the result must match the original except for the losses below (`test/zod-roundtrip.test.ts`). The same list is in [the conversion matrix](../CONVERSION_MATRIX.md#why-information-is-lost).

| Lost                                                  | Why                                                                                                                                                                                                                 |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Table names                                           | Zod has no table names. The reader uses the model name.                                                                                                                                                             |
| Column names that differ from the property name       | The writer uses the property name. The reader takes the column name from it.                                                                                                                                        |
| Defaults                                              | The row schema has no defaults. A default only makes the column optional in the create schema, which the reader skips.                                                                                              |
| Auto-updated columns                                  | Zod cannot say that the database refreshes a column on every save.                                                                                                                                                  |
| Unique columns, indexes, composite unique constraints | A schema cannot know about other rows.                                                                                                                                                                              |
| Relations                                             | The row schema holds only the foreign-key column, as a plain property. The related rows are in the with-relations schema, which the reader skips. Delete rules, reverse names and many-to-many fields go with them. |
| Composite primary keys                                | The columns stay as properties, and the model has no key unless a column is named `id`.                                                                                                                             |
| Enum column length and enum labels                    | Zod validates the members, not the column width or a display name.                                                                                                                                                  |
| Date versus date-time, `time`, `duration`             | `z.coerce.date()` is read as a date-time. Times and durations are written as plain strings.                                                                                                                         |
| Primary-key generation                                | An `id` column does not say whether the database counts up. The reader does not guess.                                                                                                                              |

What survives: model and property names, the order of properties, types, nullability, string lengths, decimal precision (`decimal(4, 2)` is written as a pattern and read back as `decimal(4, 2)`), big integers, enums with their member names and stored values, array columns and the primary key named `id`.

## Limitations and warnings

- **Coerced dates accept more than dates.** `z.coerce.date()` also turns `null` and numbers into a date, so a null in a required date column is not rejected. The strict alternative, ISO text via `z.iso.datetime` and `z.iso.date`, is only available through the API (`dates: 'string'`); the CLI always writes the defaults. `bigints: 'bigint'` (API only) writes `z.coerce.bigint()`.
- **Database-only rules are not validated or kept:** unique constraints, indexes, check constraints, integer ranges, `onDelete` actions and column names. Only string `max_length`, enum membership, nullability and the types above are.
- **The reader skips the create, update and with-relations schemas** that the writer adds (`PostCreateSchema`, `PostUpdateSchema`, `PostWithRelationsSchema`) when the model they belong to is in the input, because they describe the same table. A schema with another name (`PostSummarySchema = PostSchema.pick({ ... })`) is a model.
- **Create and update schemas are inferred** from defaults and generated columns; the IR has no notion of an API payload.
- **Zod 3.** The output needs Zod 4 APIs. Zod 3.25 and later ship them under `zod/v4`, so change the import to `import { z } from 'zod/v4'`.

Constructs only Prisma can express produce a warning and the output is still written. For example, a model marked `@@ignore`:

```
warning: B: @@ignore has no equivalent here; the model was written as a normal model.
```

Views are not warned about (the emitter writes them without create or update schemas). Emitter warnings name the model and property for a relation to an unknown model (skipped), a target without a single-column primary key (`z.unknown()` is used for the key), an unknown enum or field type, and names that are not valid identifiers or that clash.

See [What zod cannot express](../CONVERSION_MATRIX.md#what-zod-cannot-express) in the conversion matrix, and [why information is lost](../CONVERSION_MATRIX.md#why-information-is-lost) for losses that happen before the writer, such as [prisma to zod](../CONVERSION_MATRIX.md#prisma--zod).

## Checked against the real library

`test/zod-parser-verify.test.ts` runs the fixture modules with the real Zod, Zod 3.25 and Zod 4 (through `tsx`), and compares what Zod reports (`schema.shape`, `isOptional()`, `isNullable()`, the type under the wrappers, string lengths and formats, enum members) with what the reader read. It needs `ZOD_DIR`; see [test/README.md](../../test/README.md). The test skips with a reason when Zod is not installed.

## Programmatic API

```ts
import {
  convertText,
  emitZod,
  parsePrisma,
  parseZod,
  type ConvertResult,
  type IrSchema,
  type Result,
} from 'ormbridge';

declare const prismaText: string;

const converted: Result<ConvertResult> = await convertText(
  [{ path: 'schema.prisma', text: prismaText }],
  {
    from: 'prisma',
    to: 'zod',
    naming: 'preserve',
    provider: 'postgresql',
    header: true,
    autoField: 'int',
  }
);
if (!converted.ok) {
  console.error(`${converted.error.code}: ${converted.error.message}`);
} else {
  console.log(converted.value.output, converted.value.warnings);
}

// Reader only: Zod modules to the shared model.
declare const zodText: string;
const read: Result<IrSchema> = await parseZod(
  [{ path: 'schemas.ts', text: zodText }],
  { appLabel: 'app' }
);
if (read.ok) {
  console.log(
    read.value.models.map((model) => model.name),
    read.value.warnings
  );
}

// Emitter only, with the options the CLI does not expose.
const parsed: Result<IrSchema> = parsePrisma(
  [{ path: 'schema.prisma', text: prismaText }],
  { appLabel: 'app' }
);
if (parsed.ok) {
  const { text, warnings } = emitZod(parsed.value, {
    camelFields: false,
    dates: 'string',
    bigints: 'bigint',
  });
}
```
