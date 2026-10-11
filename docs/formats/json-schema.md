# JSON Schema

The `json-schema` format covers JSON Schema (draft 2020-12 is written; drafts 2020-12, 2019-09 and 7 are read) and the `components.schemas` of OpenAPI 3.x documents (`definitions` of Swagger 2 as well). ormbridge both reads and writes it (`read + write` in `node dist/cli.js formats`). Only JSON is supported; there is no YAML reader, so convert a YAML OpenAPI file to JSON first. The format claims no extension, because `.json` is too generic: always pass `--from json-schema` or `--to json-schema` (a config file can set `from` and `to`).

## Try it

The example project is [`examples/json-schema`](../../examples/json-schema/). Its config has two conversions:

```sh
cd examples/json-schema
npx ormbridge convert           # runs both conversions below
npx ormbridge convert --check   # exits with code 3 if a generated file is missing or differs
```

| Conversion         | Input                     | Output                 |
| ------------------ | ------------------------- | ---------------------- |
| `to-json-schema`   | `../schema/schema.prisma` | `models/schemas.json`  |
| `from-json-schema` | `models/`                 | `prisma/schema.prisma` |

Inside this repository, run `npm run build` once and use `node ../../dist/cli.js convert` instead. Single conversions without the config file:

```sh
npx ormbridge convert -i ../schema/schema.prisma --from prisma --to json-schema -o models/schemas.json
npx ormbridge convert -i models --from json-schema --to prisma -o prisma/schema.prisma
```

## Reading

Every object schema with properties under `$defs`, `definitions` or `components.schemas` is a model, named after its key; a root object schema is a model too (named after `title`, `$id` or the file name). Enums, scalar aliases and free-form objects are not models.

- **Input.** A file, or a directory read recursively: every `.json` file except tool configuration (`package.json`, `tsconfig*.json`, ...) and anything under `node_modules/`, `vendor/`, `dist/`, `build/`, `coverage/` and `.git/`. Several files may refer to each other with `$ref`; `$ref` pointers (`#/$defs/X`, `#/components/schemas/X`, `$id`-relative and relative file references) are followed.
- **Fields.** `properties` and `required` give columns; a property outside `required` is nullable unless it has a `default` or is `readOnly`. `string` becomes a string of `maxLength` or text; `format` `date-time`, `date`, `time`, `uuid`, `duration`, `ipv4`/`ipv6` and base64 content map to the matching type; `integer` and `number` become `int`, `bigInt` or `float`; an object or an untyped schema is `json`; arrays of scalars are array columns. String `enum` and `oneOf` of `{const, title}` become enums.
- **Relations.** A `$ref` to another model is a foreign key (`x-on-delete`, `x-related-name` are honoured), an array of `$ref` is the reverse side, and arrays on both models are a many-to-many.
- **Conventions.** The `x-` keywords the writer produces are read back: `x-table-name`, `x-primary-key`, `x-unique`, `x-indexes`, `x-index`, `x-on-delete`, `x-related-name`, plus `x-precision` and `x-scale`. Without a property named `id`, `<model>Id` or an `x-primary-key`, an integer `id` column is added (with a warning).

## Writing

One document: `$schema`, `$id` (`urn:ormbridge:schema`) and `$defs` with an entry for each enum and each model. Every model is `type: "object"` with `additionalProperties: false`.

- **Types.** `string`/`text` carry `maxLength`; `int` is `integer`; dates, `uuid`, `time` and `duration` are strings with a `format`; `bytes` is a string with `contentEncoding: "base64"`; `json` is `{}`. `bigInt` and `decimal` are strings with a `pattern` (`decimal(4,2)` gives `^-?[0-9]{1,2}(\.[0-9]{1,2})?$`). `minimum`/`maximum` appear only when a Prisma native type fixes the width (`@db.SmallInt`).
- **Required.** A property is required when the column is not nullable, has no default and is not generated. Generated columns are `readOnly: true`; literal and enum defaults become `default`. Nullable columns are `type: [..., "null"]`, nullable relations use `anyOf` with `{ "type": "null" }`.
- **Relations.** A foreign key keeps its scalar (`author_id`) and adds an optional `$ref` property (`author`). Reverse sides and many-to-many fields are optional arrays of `$ref`.
- **Convention keywords** (default on) carry what JSON Schema has no keyword for: `x-table-name`, `x-primary-key`, `x-unique`, `x-indexes`, `x-on-delete`, `x-related-name`. They make the file read back into the same models, tables and indexes.

Options that apply from the CLI: `--naming preserve` (default) keeps property names, `--naming normalize` writes camelCase; the config key `naming` is the same. `--no-conventions` (config key `conventions: false`, API option `conventions: false`) omits the `x-` keywords. The `id` and `refPrefix` options exist only in the API.

**Ajv strict mode** rejects unknown keywords. Either register the vocabulary or write without conventions:

```ts
import Ajv2020 from 'ajv/dist/2020';
import { JSON_SCHEMA_CONVENTION_KEYWORDS } from 'ormbridge';

const ajv = new Ajv2020({ strict: true });
ajv.addVocabulary(JSON_SCHEMA_CONVENTION_KEYWORDS);
```

For OpenAPI 3.1, copy the `$defs` entries into `components.schemas` and write with `refPrefix: '#/components/schemas/'`. Generating a full OpenAPI document (paths) is not supported.

## Limitations and warnings

Reading warns once per construct with the model and property:

```
warning: A.u: a oneOf/anyOf union has no database meaning, so the property was kept as a json column.
```

The same applies to type unions, `patternProperties`, `additionalProperties` maps, `if/then/else`, nested inline objects (define them under `$defs` to get models), non-string enums, array defaults, and `allOf` (flattened: "allOf composition was flattened; ..."). Keywords such as `minimum`, `pattern` and `description` are not kept, and in testing did not produce a warning. A model without a primary key gets an integer `id` and a warning. When reverse arrays cannot be paired with a foreign key, the warning asks for `"x-related-name"`.

Writing warns for Prisma-only constructs (for example `B: @@ignore has no equivalent here; ...`), relations to unknown models, composite-key targets (the foreign key accepts any value), unknown enums or field types, duplicate enum values and definition names unusable in a `$ref` (renamed). Index methods, operator classes, sort orders, full-text kinds, `onUpdate` actions and constraint names are not written.

Details: [why information is lost](../CONVERSION_MATRIX.md#why-information-is-lost) (items 10 and 11 concern JSON Schema), [prisma to json-schema](../CONVERSION_MATRIX.md#prisma--json-schema), [json-schema to prisma](../CONVERSION_MATRIX.md#json-schema--prisma) and the [write-only targets](../CONVERSION_MATRIX.md#write-only-targets) section, which checks the written JSON Schema covers the canonical schema.

## Programmatic API

```ts
import {
  convertText,
  emitJsonSchema,
  parseJsonSchema,
  type ConvertResult,
  type IrSchema,
  type Result,
} from 'ormbridge';

declare const jsonText: string;

const converted: Result<ConvertResult> = await convertText(
  [{ path: 'schemas.json', text: jsonText }],
  {
    from: 'json-schema',
    to: 'prisma',
    naming: 'preserve',
    provider: 'postgresql',
    header: true,
    autoField: 'int',
  }
);
if (!converted.ok) {
  console.error(`${converted.error.code}: ${converted.error.message}`);
}

const parsed: Result<IrSchema> = parseJsonSchema(
  [{ path: 'schemas.json', text: jsonText }],
  { appLabel: 'app' }
);
if (parsed.ok) {
  const { text, warnings } = emitJsonSchema(parsed.value, {
    camelFields: false,
    conventions: false,
    id: 'https://example.com/schemas',
    refPrefix: '#/components/schemas/',
  });
}
```
