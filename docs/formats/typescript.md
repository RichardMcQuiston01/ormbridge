# TypeScript interfaces

The `typescript` format writes plain TypeScript `interface` and `enum` declarations that describe the rows a server returns, for sharing models with a front end. It is write-only: `node dist/cli.js formats` lists it as `write`, so it can be used with `--to` but never `--from`. It claims no file extension, because `.ts` is also read by TypeORM and Drizzle. Always pass `--to typescript`, even when the output path ends in `.ts`.

## Try it

The example project is [`examples/typescript`](../../examples/typescript/). It converts the shared Prisma schema `examples/schema/schema.prisma` into `generated/models.ts`:

```sh
cd examples/typescript
npx ormbridge convert           # writes generated/models.ts
npx ormbridge convert --check   # exits with code 3 if the file is missing or differs
```

Inside this repository, run `npm run build` once and use `node ../../dist/cli.js convert` instead of `npx ormbridge convert`. The same conversion without the config file:

```sh
npx ormbridge convert -i ../schema/schema.prisma --from prisma --to typescript -o generated/models.ts
```

Without `-o` the interfaces are printed to stdout.

## Reading: not supported

There is no TypeScript reader for this format; to read TypeScript, use the `typeorm` or `drizzle` formats.

## Writing

The output is a single file with no header comment: the enums first, then one `export interface` per model, in the order of the schema.

- **Enums** are string enums holding the stored values (`DRAFT = 'draft'`). A label from the source becomes a `/** ... */` comment.
- **Scalar types** follow what travels as JSON. `string`, `text`, `uuid`, `time`, `bigInt`, `decimal`, `bytes` (base64) and `duration` are `string`; `int` and `float` are `number`; `boolean` is `boolean`; `json` is `unknown`; date and date-time columns are `string` (ISO 8601). HStore is `Record<string, string | null>`, a range is `{ lower; upper; bounds? }`, and array columns end in `[]`.
- **Nullable** columns get `| null`. No column is optional, because the interface describes a returned row, defaults included.
- **Relations.** A foreign key is written as its scalar, typed from the referenced key (`author_id: number`), followed by an optional expanded property (`author?: User`, or `User | null` when nullable). Reverse sides and many-to-many lists are optional arrays (`tags?: PostTags[]`); a one-to-one reverse side is `profile?: Profile | null`.
- Constraints, defaults, indexes and referential actions have no TypeScript form and are not written.

Options that apply:

| Option                        | Effect                                                                                                    |
| ----------------------------- | --------------------------------------------------------------------------------------------------------- |
| `--naming preserve` (default) | Keeps the property names of the source (`created_at`).                                                    |
| `--naming normalize`          | camelCase properties (`createdAt`, `authorId`) and `string` primary keys (UUID), like the other emitters. |
| config key `naming`           | Same as the flag.                                                                                         |

`--provider`, `--style` and the other flags are ignored. Date handling is not configurable on the command line: the CLI always writes `string`. Programmatic callers can pass `dates: 'date'` to `emitTypescriptInterfaces` to type date columns as `Date`.

## Limitations and warnings

Everything the type system cannot say is dropped silently: string lengths, uniqueness, indexes, defaults and `onDelete`. Use the [`zod`](zod.md) or [`json-schema`](json-schema.md) format when you need validation. `bigInt`, `decimal` and `bytes` become `string` to keep precision, so the consuming code has to parse them.

Constructs that only Prisma can express produce a warning, and the output is still written:

```
warning: B: @@ignore has no equivalent here; the model was written as a normal model.
```

The same family covers views, composite foreign keys, `@@schema`, `onUpdate` actions and full-text indexes. Warnings specific to this emitter name the model and property for:

- a relation to a model that is not in the schema (the relation is skipped);
- a target without a single-column primary key (the foreign key is typed `unknown`);
- an unknown enum or field type;
- a model, enum or member name that is not a valid identifier or that clashes (it is renamed, for example `"my-model" is not a valid TypeScript identifier; it was written as "my_model"`).

`typescript` is not part of the generated [conversion matrix](../CONVERSION_MATRIX.md); see its [list of information-losing steps](../CONVERSION_MATRIX.md#why-information-is-lost) for losses that happen before the emitter runs, when the source is not Prisma.

## Programmatic API

```ts
import {
  convertText,
  emitTypescriptInterfaces,
  parsePrisma,
  type ConvertResult,
  type IrSchema,
  type Result,
} from 'ormbridge';

declare const prismaText: string;

// Whole pipeline: text in, text out. Never throws; check `ok`.
const converted: Result<ConvertResult> = await convertText(
  [{ path: 'schema.prisma', text: prismaText }],
  {
    from: 'prisma',
    to: 'typescript',
    naming: 'normalize',
    provider: 'postgresql',
    header: true,
    autoField: 'int',
  }
);
if (converted.ok) {
  console.log(converted.value.output, converted.value.warnings);
}

// Emitter only, with the options the CLI does not expose.
const parsed: Result<IrSchema> = parsePrisma(
  [{ path: 'schema.prisma', text: prismaText }],
  { appLabel: 'app' }
);
if (parsed.ok) {
  const { text, warnings } = emitTypescriptInterfaces(parsed.value, {
    camelFields: false,
    dates: 'date',
  });
}
```
