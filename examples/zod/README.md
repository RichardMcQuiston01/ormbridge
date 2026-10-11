# Zod example

This folder shows the `zod` format: Zod 4 schemas and inferred types generated from the shared Prisma schema [`../schema/schema.prisma`](../schema/schema.prisma). The format is write-only, so there is no round trip.

- `ormbridge.config.json` defines one conversion, `to-zod` (`prisma` to `zod`).
- `generated/schemas.ts` is its output: for each model a row, create and update schema, plus a `WithRelations` schema where relations exist.

Generated files are committed. Regenerate or verify them with:

```sh
cd examples/zod
npx ormbridge convert           # rewrites generated/schemas.ts
npx ormbridge convert --check   # exit code 3 if it is out of date
```

Inside this repository, run `npm run build` first and use `node ../../dist/cli.js convert` (or `npm run examples` / `npm run examples:check` from the root, which cover every example). To use the output in your own project, install `zod` 4.

Read the format guide for type mappings, date handling and warnings: [`../../docs/formats/zod.md`](../../docs/formats/zod.md).
