# TypeORM example

TypeORM entities generated from the shared schema [`../schema/schema.prisma`](../schema/schema.prisma), and the way back.

- `ormbridge.config.json` defines two conversions.
- `models/entities.ts` is the TypeORM output (`to-typeorm`: Prisma to TypeORM), one file with all entities and the `PostStatus` enum.
- `prisma/schema.prisma` is the Prisma output read back from `models/` (`from-typeorm`: TypeORM to Prisma).

Both files are generated. Do not edit them by hand; change `../schema/schema.prisma` and regenerate. TypeORM claims no file extension, so the config names `from` and `to` explicitly.

## Run

```bash
cd examples/typeorm
npx ormbridge convert            # regenerate both files
npx ormbridge convert --check    # exit code 3 if a file is stale
```

Inside this repository, after `npm run build`, use `node ../../dist/cli.js convert` instead of `npx ormbridge convert`. From the repository root, `npm run examples` regenerates every example and `npm run examples:check` verifies them.

See the format guide: [`../../docs/formats/typeorm.md`](../../docs/formats/typeorm.md).
