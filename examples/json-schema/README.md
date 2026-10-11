# JSON Schema example

This folder shows the `json-schema` format in both directions, using the shared Prisma schema [`../schema/schema.prisma`](../schema/schema.prisma) as the starting point.

- `ormbridge.config.json` defines two conversions: `to-json-schema` and `from-json-schema`.
- `models/schemas.json` is the JSON Schema (draft 2020-12) document written from the Prisma schema, with `x-` convention keywords.
- `prisma/schema.prisma` is that document read back into Prisma.

Generated files are committed. Regenerate or verify them with:

```sh
cd examples/json-schema
npx ormbridge convert           # runs both conversions
npx ormbridge convert --check   # exit code 3 if a file is out of date
```

Inside this repository, run `npm run build` first and use `node ../../dist/cli.js convert` (or `npm run examples` / `npm run examples:check` from the root, which cover every example). `.json` is not inferred as a format, so the config sets `from` and `to` explicitly. Validating `schemas.json` with Ajv in strict mode needs the `x-` keywords registered; see the guide.

Read the format guide for the mappings, conventions and warnings: [`../../docs/formats/json-schema.md`](../../docs/formats/json-schema.md).
