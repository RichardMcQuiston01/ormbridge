# TypeScript example

This folder shows the `typescript` format: plain TypeScript interfaces and enums generated from the shared Prisma schema [`../schema/schema.prisma`](../schema/schema.prisma). The format is write-only, so there is no round trip.

- `ormbridge.config.json` defines one conversion, `to-typescript` (`prisma` to `typescript`).
- `generated/models.ts` is its output: one `enum` for `PostStatus` and one `interface` per model.

Generated files are committed. Regenerate or verify them with:

```sh
cd examples/typescript
npx ormbridge convert           # rewrites generated/models.ts
npx ormbridge convert --check   # exit code 3 if it is out of date
```

Inside this repository, run `npm run build` first and use `node ../../dist/cli.js convert` (or `npm run examples` / `npm run examples:check` from the root, which cover every example).

Read the format guide for type mappings, naming modes and warnings: [`../../docs/formats/typescript.md`](../../docs/formats/typescript.md).
