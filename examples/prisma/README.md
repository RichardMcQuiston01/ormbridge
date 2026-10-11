# Prisma example

A Prisma schema generated from the Django example models, using `"naming": "normalize"`.

- `ormbridge.config.json` defines one conversion, `to-prisma`, from `../django/models/models.py`.
- `models/schema.prisma` is the output: singular snake_case tables, UUID ids, camelCase fields mapped to snake_case columns, and implicit many-to-many relations.

The file is generated. Do not edit it by hand; change the source and regenerate. Because the input is the generated Django example, run `npm run examples` from the repository root to refresh both in the right order.

## Run

```bash
cd examples/prisma
npx ormbridge convert            # regenerate models/schema.prisma
npx ormbridge convert --check    # exit code 3 if it is stale
```

Inside this repository, after `npm run build`, use `node ../../dist/cli.js convert` instead of `npx ormbridge convert`. `npm run examples:check` verifies every example.

See the format guide: [`../../docs/formats/prisma.md`](../../docs/formats/prisma.md).
