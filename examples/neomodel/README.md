# neomodel example

This folder shows the `neomodel` format: Python classes for [neomodel](https://neomodel.readthedocs.io) generated from the shared Prisma schema [`../schema/schema.prisma`](../schema/schema.prisma). The format is write-only, so there is no round trip.

- `ormbridge.config.json` defines one conversion, from `prisma` to `neomodel`.
- `generated/models.py` is the module. Each model is a `StructuredNode` class, and each foreign key is a `RelationshipTo` on one class and a `RelationshipFrom` on the other. The post-to-tag join table is one relationship, with no class of its own.

The labels and relationship types are the same as in the [Neo4j example](../neo4j), so the two folders describe the same graph.

Generated files are committed. Regenerate or verify them with:

```sh
cd examples/neomodel
npx ormbridge convert           # rewrites generated/models.py
npx ormbridge convert --check   # exit code 3 if it is out of date
```

Inside this repository, run `npm run build` first and use `node ../../dist/cli.js convert` (or `npm run examples` / `npm run examples:check` from the root, which cover every example).

To use the module, install neomodel (`pip install neomodel`), create the constraints and indexes, and connect:

```sh
neomodel_install_labels generated/models.py --db bolt://neo4j:<password>@localhost:7687
```

Read the format guide for types, defaults, naming and warnings: [`../../docs/formats/neomodel.md`](../../docs/formats/neomodel.md).
