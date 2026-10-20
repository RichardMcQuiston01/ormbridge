# Neo4j example

This folder shows the `neo4j` format: a Cypher schema generated from the shared Prisma schema [`../schema/schema.prisma`](../schema/schema.prisma). The format is write-only, so there is no round trip.

- `ormbridge.config.json` defines two conversions, both from `prisma` to `neo4j`.
- `generated/schema.cypher` is the default `community` style. It runs on Neo4j Community Edition.
- `generated/schema.enterprise.cypher` is the `enterprise` style (`"style": "enterprise"`). It adds `IS NOT NULL` and property type constraints, which need Enterprise Edition.

Each model becomes a node label. Cypher has no relationship schema, so foreign keys and the post-to-tag join table are written as comment blocks, with a `MATCH ... MERGE` query that creates each relationship after the data is loaded.

Generated files are committed. Regenerate or verify them with:

```sh
cd examples/neo4j
npx ormbridge convert           # rewrites both files in generated/
npx ormbridge convert --check   # exit code 3 if one is out of date
```

Inside this repository, run `npm run build` first and use `node ../../dist/cli.js convert` (or `npm run examples` / `npm run examples:check` from the root, which cover every example).

To apply a file, use `cypher-shell`. Every statement uses `IF NOT EXISTS`, so you can run it again safely:

```sh
cypher-shell -u neo4j -p <password> -f generated/schema.cypher
```

Read the format guide for type mappings, naming and warnings: [`../../docs/formats/neo4j.md`](../../docs/formats/neo4j.md).
