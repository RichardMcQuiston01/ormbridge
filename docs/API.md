# API Reference

[Back to README](../README.md)

| [Programmatic API](#programmatic-api) | [Format registry](#format-registry) |

## Programmatic API

```ts
import { convertText } from 'ormbridge';

const result = await convertText([{ path: 'models.py', text: source }], {
  from: 'django',
  to: 'prisma',
  naming: 'preserve',
  provider: 'postgresql',
  header: true,
  appLabel: 'shop',
  autoField: 'int',
});

if (!result.ok) {
  console.error(`${result.error.code}: ${result.error.message}`);
} else {
  console.log(result.value.output);
  console.warn(result.value.warnings);
}
```

All functions return a `Result` (`{ ok: true, value } | { ok: false, error }`) instead of throwing, with a descriptive error code and message. Parsers and emitters are exported too (`parseDjango`, `parsePrisma`, `parseTypeorm`, `parseDrizzle`, `parseDoctrine`, `parseLaravel`, `parseGorm`, `parseJsonSchema`, `parseSqlDdl`, `parseSqlAlchemy`, `parseSequelize`, `parseEfcore`, `parseJpa`, `emitPrisma`, `emitDjango`, `emitDoctrine`, `emitLaravel`, `emitGorm`, `emitDrizzle`, `emitJsonSchema`, `emitZod`, `emitNeo4j`, `emitNeomodel`, `emitSdn`, `emitSqlDdl`, `emitSqlAlchemy`, `emitSequelize`, `emitEfcore`, `emitJpa`), all built on a shared intermediate representation, which is how new formats plug in. `orderSqlMigrationFiles(paths)` puts SQL migration files in the order they run (Flyway versions, the drizzle-kit journal or natural file-name order), for callers that pass several files to `parseSqlDdl`.

[Back to Top](#api-reference)

## Format registry

Each format is an adapter registered in `src/formats.ts`: a `name`, its file `extensions`, a `description`, and an optional `parse` and/or `emit`. `convertText` and the CLI look formats up in the registry, so a format that only has `emit` is output-only and one that only has `parse` is input-only. Lookups return a `Result` with a descriptive error for unknown or unsupported formats.

```ts
import { getFormat, listFormats, registerFormat } from 'ormbridge';

const adapter = getFormat('prisma'); // Result<FormatAdapter>
const formats = listFormats(); // every registered adapter
registerFormat({
  name: 'example',
  extensions: ['.example'],
  description: 'An output-only example format',
  emit: (schema, options) => ({ ok: true, value: { text: '', warnings: [] } }),
});
```

### Emitter output

`emit` returns `Result<FormatEmitOutput>`, which is either `{ text, warnings }` (one file, what every built-in emitter returns) or `{ files, warnings }`, where `files` maps a relative path (forward slashes, no leading slash, no `..`) to the file text. Return the second form when the format needs several files:

```ts
emit: (schema) => ({
  ok: true,
  value: {
    files: { 'src/Entity/Post.php': '<?php ...', 'config/orm.yaml': '...' },
    warnings: [],
  },
}),
```

`convertText` then returns `files` next to an empty `output`, and the CLI writes the map under the `-o` directory. A multi-file format cannot print to stdout.

[Back to Top](#api-reference)

---

[Back to README](../README.md)
