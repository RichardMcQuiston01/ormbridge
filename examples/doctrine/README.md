# Doctrine example

Doctrine ORM entities (PHP 8 attributes) generated from the shared schema [`../schema/schema.prisma`](../schema/schema.prisma), and the way back.

- `ormbridge.config.json` defines two conversions.
- `models/src/Entity/*.php` holds one entity per model, and `models/src/Enum/PostStatus.php` the backed enum (`to-doctrine`: Prisma to Doctrine, default namespace `App\Entity`).
- `prisma/schema.prisma` is the Prisma output read back from `models/` (`from-doctrine`: Doctrine to Prisma).

All files are generated. Do not edit them by hand; change `../schema/schema.prisma` and regenerate. Doctrine claims no file extension, so the config names `from` and `to` explicitly, and the output is a directory.

## Run

```bash
cd examples/doctrine
npx ormbridge convert            # regenerate all files
npx ormbridge convert --check    # exit code 3 if a file is stale
```

Inside this repository, after `npm run build`, use `node ../../dist/cli.js convert` instead of `npx ormbridge convert`. From the repository root, `npm run examples` regenerates every example and `npm run examples:check` verifies them.

See the format guide: [`../../docs/formats/doctrine.md`](../../docs/formats/doctrine.md).
