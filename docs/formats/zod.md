# Zod

The `zod` format writes [Zod](https://zod.dev) 4 schemas and their inferred TypeScript types, for validating the same data the [`typescript`](typescript.md) format describes. It is write-only: it works with `--to` and never with `--from`. It claims no file extension (`.ts` belongs to no single format), so always pass `--to zod`.

## Try it

The example project is [`examples/zod`](../../examples/zod/). It converts the shared Prisma schema `examples/schema/schema.prisma` into `generated/schemas.ts`:

```sh
cd examples/zod
npx ormbridge convert           # writes generated/schemas.ts
npx ormbridge convert --check   # exits with code 3 if the file is missing or differs
```

Inside this repository, run `npm run build` once and use `node ../../dist/cli.js convert` instead. Without the config file:

```sh
npx ormbridge convert -i ../schema/schema.prisma --from prisma --to zod -o generated/schemas.ts
```

## Reading: not supported

There is no Zod reader.

## Writing

One file, starting with `import { z } from 'zod';`. Property, enum and relation naming match the `typescript` output, so the two can be generated side by side. For every model the file declares:

| Export | Meaning |
| --- | --- |
| `<Model>Schema`, type `<Model>` | The row as stored. Foreign-key scalars are included; relation fields are not. |
| `<Model>CreateSchema`, `<Model>Create` | The row minus database-generated columns (auto-increment keys, generated columns, auto-updated timestamps). Columns with a default and nullable columns become optional. |
| `<Model>UpdateSchema`, `<Model>Update` | The create schema made partial. |
| `<Model>WithRelationsSchema`, `<Model>WithRelations` | Only for models that take part in a relation: the row plus optional related rows, resolved with `z.lazy`. The type is written by hand because the schemas are mutually recursive. |

Views get neither create nor update schemas.

Type mappings that matter:

- `string` and `text` are `z.string()`, with `.max(n)` when the column has a length; `int` is `z.number().int()`; `float` is `z.number()`; `json` is `z.unknown()`; `uuid` is `z.uuid()`; `bytes` is `z.base64()`; IP addresses are `z.union([z.ipv4(), z.ipv6()])`; times and durations are `z.string()`.
- `bigInt` is a string of digits and `decimal` is a string with a regex sized from the precision and scale (`decimal(4, 2)` gives `/^-?\d{1,2}(\.\d{1,2})?$/`), because JSON cannot carry either without losing precision.
- Date and date-time columns are `z.coerce.date()`.
- Enums are a const object plus `z.enum(...)`: `export const PostStatus = { DRAFT: 'draft', ... } as const;`, `PostStatusSchema` and a type of the same name. Labels become comments.
- Nullable columns add `.nullable()`; array columns wrap the element in `z.array(...)`.

Options that apply: `--naming preserve` (default) keeps property names; `--naming normalize` writes camelCase properties and UUID keys (`z.uuid()`). The config-file key `naming` is the same flag. `--provider`, `--style` and the remaining flags are ignored.

## Limitations and warnings

- **Coerced dates accept more than dates.** `z.coerce.date()` also turns `null` and numbers into a date, so a null in a required date column is not rejected. The strict alternative, ISO text via `z.iso.datetime` and `z.iso.date`, is only available through the API (`dates: 'string'`); the CLI always writes the defaults. `bigints: 'bigint'` (API only) writes `z.coerce.bigint()`.
- **Database-only rules are not validated or kept:** unique constraints, indexes, check constraints, integer ranges, `onDelete` actions and column names. Only string `max_length`, enum membership, nullability and the types above are.
- **Create and update schemas are inferred** from defaults and generated columns; the IR has no notion of an API payload.
- **Zod 3.** The output needs Zod 4 APIs. Zod 3.25 and later ship them under `zod/v4`, so change the import to `import { z } from 'zod/v4'`.

Constructs only Prisma can express produce a warning and the output is still written. For example, a model marked `@@ignore`:

```
warning: B: @@ignore has no equivalent here; the model was written as a normal model.
```

Views are not warned about (the emitter writes them without create or update schemas). Emitter warnings name the model and property for a relation to an unknown model (skipped), a target without a single-column primary key (`z.unknown()` is used for the key), an unknown enum or field type, and names that are not valid identifiers or that clash.

See [What zod approximates](../CONVERSION_MATRIX.md#what-zod-approximates) and the [write-only targets](../CONVERSION_MATRIX.md#write-only-targets) table in the conversion matrix, and [why information is lost](../CONVERSION_MATRIX.md#why-information-is-lost) for losses that happen before the emitter, such as [prisma to zod](../CONVERSION_MATRIX.md#prisma--zod).

## Programmatic API

```ts
import {
  convertText,
  emitZod,
  parsePrisma,
  type ConvertResult,
  type IrSchema,
  type Result,
} from 'ormbridge';

declare const prismaText: string;

const converted: Result<ConvertResult> = await convertText(
  [{ path: 'schema.prisma', text: prismaText }],
  { from: 'prisma', to: 'zod', naming: 'preserve', provider: 'postgresql', header: true, autoField: 'int' }
);
if (!converted.ok) {
  console.error(`${converted.error.code}: ${converted.error.message}`);
} else {
  console.log(converted.value.output, converted.value.warnings);
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
