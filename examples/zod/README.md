# Zod example

This folder shows the `zod` format both ways: Zod 4 schemas and inferred types generated from the shared Prisma schema [`../schema/schema.prisma`](../schema/schema.prisma), and the Zod file read back into a Prisma schema.

- `ormbridge.config.json` defines two conversions: `to-zod` (`prisma` to `zod`) and `from-zod` (`zod` to `prisma`).
- `generated/schemas.ts` is the output of `to-zod`: for each model a row, create and update schema, plus a `WithRelations` schema where relations exist.
- `prisma/schema.prisma` is the output of `from-zod`. Zod describes rows, not tables, so it is not the same schema as the one you started with: table names, defaults, unique constraints, indexes and relations are gone, and the foreign-key columns are plain fields. The [Zod guide](../../docs/formats/zod.md#what-is-lost) lists what is lost.

Generated files are committed. Regenerate or verify them with:

```sh
cd examples/zod
npx ormbridge convert           # rewrites both generated files
npx ormbridge convert --check   # exit code 3 if one is out of date
```

Inside this repository, run `npm run build` first and use `node ../../dist/cli.js convert` (or `npm run examples` / `npm run examples:check` from the root, which cover every example). To use the output in your own project, install `zod` 4.

Read the format guide for type mappings, date handling and warnings: [`../../docs/formats/zod.md`](../../docs/formats/zod.md).
