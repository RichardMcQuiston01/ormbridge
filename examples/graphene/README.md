# Graphene example

This folder shows ormbridge converting the shared blog schema to a Graphene (graphene-django) GraphQL schema. Graphene is write-only, so there is no conversion back.

- `ormbridge.config.json` defines one conversion: `to-graphene`.
- `generated/schema.py` is generated from `../schema/schema.prisma`: a `DjangoObjectType` per model, `Query` fields, create, update and delete mutations, and `schema = graphene.Schema(...)`. It imports the models from `.models`, so place it next to a Django `models.py` (ormbridge can write one with `--to django`).

Run it (the config file supplies the paths and formats):

```bash
cd examples/graphene
npx ormbridge convert           # regenerate generated/schema.py
npx ormbridge convert --check   # exit code 3 if it is stale
```

Inside this repository, run `npm run build` once and use `node ../../dist/cli.js convert` instead of `npx ormbridge convert`. `npm run examples` regenerates every example and `npm run examples:check` verifies them. Two warnings about the `PostStatus` enum input and `User` having no update mutation are expected.

The file is generated, so edit `../schema/schema.prisma` and rerun. See the [Graphene guide](../../docs/formats/graphene.md) for details.
