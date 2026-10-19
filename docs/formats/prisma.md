# Prisma

ormbridge reads and writes Prisma schemas (`ormbridge formats` lists `prisma` as `read + write`). It claims the `.prisma` extension, so `--from prisma` / `--to prisma` can be left out when the input or output path ends in `.prisma`. A directory never infers the format, so add `--from prisma` when reading a folder. Prisma is also the richest format in the shared model: most of what it can express is kept when converting to Prisma and back, while the other formats get the closest equivalent plus a warning.

Converting Prisma to Prisma is refused (`The source and target formats are both "prisma". Choose different values for --from and --to.`).

## Try it

The example in [`examples/prisma`](../../examples/prisma/) has one conversion in its `ormbridge.config.json`: it reads the Django example and writes Prisma with `"naming": "normalize"`.

```bash
cd examples/prisma
npx ormbridge convert            # ../django/models/models.py -> models/schema.prisma
npx ormbridge convert --check
```

Inside this repository run `node ../../dist/cli.js convert` after `npm run build`. The shared source schema, [`examples/schema/schema.prisma`](../../examples/schema/schema.prisma), is the input of the other examples (`ormbridge convert -i ../schema/schema.prisma -t django`).

## Reading

- **Input.** One or more `.prisma` files; several files are merged. A directory is searched for `.prisma` files and skips `node_modules`, `venv`, `.venv`, `env`, `.git`, `__pycache__`, `migrations`, `site-packages`, `dist` and `build`. A file with no `model` block fails with `NO_MODELS_FOUND`.
- **Blocks.** `model`, `view` (flagged as a view) and `enum` (including `@map` on members and on the enum). `generator` and `datasource` blocks are not carried over; the writer produces its own.
- **Scalars and types.** All Prisma scalars, scalar lists (`String[]`), `Unsupported("circle")` (kept as an opaque column; `int4range` and friends become range fields) and `@db.*` native types.
- **Attributes.** `@id`, `@@id`, `@unique`, `@@unique`, `@@index`, `@@fulltext`, `@default` (`autoincrement()`, `now()`, `uuid()`, `cuid()`, `ulid()`, `nanoid()`, `dbgenerated(...)`, `auto()`, `sequence()`, literals, lists), `@updatedAt`, `@map`, `@@map`, `@@schema`, `@ignore` and `@@ignore`, and index options (`sort`, `length`, `ops`, `type`, `clustered`, `map`).
- **Relations.** `@relation` with `fields`, `references`, `onDelete`, `onUpdate`, `map` and relation names, including composite foreign keys.
- **Not read.** Composite types (`type` blocks, MongoDB), `relationMode`, the client-side `name:` of `@@unique` / `@@id`, partial indexes (`where:`) and sort/length options on `@@id`. Each is reported, for example `The composite type "Address" is not supported and was skipped; fields that use it are skipped too.`

## Writing

The writer returns one text, the Prisma schema, with `generator` and `datasource` blocks first and then enums and models.

| Option                        | Effect                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--provider`                  | `postgresql` (default), `mysql`, `sqlite`, `sqlserver`, `mongodb` or `cockroachdb`. Sets the datasource and which `@db.*` native types are written. On `cockroachdb`, PostgreSQL native types are renamed (`@db.VarChar(n)` is `@db.String(n)`, `Integer` is `Int4`, `SmallInt` is `Int2`, `BigInt` is `Int8`, `Real` is `Float4`, `DoublePrecision` is `Float8`, `Boolean` is `Bool`, `ByteA` is `Bytes`, `Json` is `JsonB`); `Money`, `Xml` and `Citext` have no CockroachDB native type and are dropped with a warning. |
| `--no-header`                 | Omits the generator and datasource blocks. Config key: `"header": false`.                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `--prisma-version 6\|7`       | Default `6` writes `prisma-client-js` and `url = env("DATABASE_URL")`. `7` writes the `prisma-client` generator with `output = "../generated/prisma"` and no datasource `url`. Config key: `prismaVersion`. ormbridge does not generate `prisma.config.ts`.                                                                                                                                                                                                                                                                |
| `--naming preserve` (default) | Keeps database names (`@@map("blog_post")`) and column names. Every many-to-many relation becomes an explicit join model (`PostTags`) matching the table Django creates.                                                                                                                                                                                                                                                                                                                                                   |
| `--naming normalize`          | Singular snake_case tables (`@@map("post")`), UUID primary keys, camelCase fields mapped to snake_case columns, `created_at` / `updated_at` added where missing, implicit many-to-many relations.                                                                                                                                                                                                                                                                                                                          |

`--app-label` and `--auto-field` are read-side options for Django input only.

The writer adapts to the provider and warns about each adjustment, for example `Post.category: SQL Server has no Restrict referential action; NoAction was written instead.`, `enum PostStatus: sqlserver has no enum support in Prisma; the enum was dropped and fields that use it are written as String.` and `Category.id: MongoDB does not support autoincrement(); the default was dropped (use @default(auto()) on an ObjectId key).` SQLite drops `@db.*` types, and `Json` is written as `String @db.NVarChar(Max)` on SQL Server.

## Limitations and warnings

- Prisma-only constructs have no equivalent elsewhere and warn when written to another format: composite foreign keys (`the relation was dropped and the columns kept as plain fields`), `Unsupported(...)` types, views, `@@fulltext`, `@@schema`, `@ignore`, client-generated defaults such as `cuid()`, and `onUpdate` actions.- Prisma's implicit many-to-many table (`_PostToTag`, columns `A` and `B`) differs from the join table Django or TypeORM create, so data needs migrating. Preserve mode avoids this with an explicit join model.
- Reading is lenient: an unreadable line is skipped with `Model X: the line "..." could not be understood and was skipped.` and a type that is not a scalar, enum or model skips the field.
- Native types are matched to the target provider by name only; arguments such as a `VarChar` length are passed through unchanged. Always run `prisma validate` on the output.

See the [conversion matrix](../CONVERSION_MATRIX.md) for exact losses: [django to prisma](../CONVERSION_MATRIX.md#django--prisma), [typeorm to prisma](../CONVERSION_MATRIX.md#typeorm--prisma), [doctrine to prisma](../CONVERSION_MATRIX.md#doctrine--prisma), and [why information is lost](../CONVERSION_MATRIX.md#why-information-is-lost) (the many-to-many join model is reason 3).

## Programmatic API

```ts
import {
  convertText,
  parsePrisma,
  emitPrisma,
  type ConvertResult,
  type EmitOutput,
  type IrSchema,
  type Result,
} from 'ormbridge';

declare const modelsPy: string;
declare const prismaText: string;

// Django -> Prisma 7, in memory.
const converted: Result<ConvertResult> = await convertText(
  [{ path: 'shop/models.py', text: modelsPy }],
  {
    from: 'django',
    to: 'prisma',
    naming: 'normalize',
    provider: 'postgresql',
    header: true,
    autoField: 'int',
    prismaVersion: 7,
  }
);
if (!converted.ok) {
  console.error(`${converted.error.code}: ${converted.error.message}`);
}

// Lower level: parsePrisma is synchronous and returns a Result.
const parsed: Result<IrSchema> = parsePrisma(
  [{ path: 'schema.prisma', text: prismaText }],
  { appLabel: 'app' }
);
if (parsed.ok) {
  const emitted: EmitOutput = emitPrisma(parsed.value, {
    provider: 'mysql',
    header: false,
    camelFields: false,
  });
  console.log(emitted.text, emitted.warnings);
}
```

`emitPrisma` returns `{ text, warnings }` directly; `convertText` and the CLI apply `--naming` before calling it.
