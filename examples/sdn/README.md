# Spring Data Neo4j example

This folder shows the `sdn` format: Java entity classes for Spring Data Neo4j 7 (Spring Boot 3) generated from the shared Prisma schema [`../schema/schema.prisma`](../schema/schema.prisma). The format is write-only, so there is no round trip.

- `ormbridge.config.json` defines one conversion, from `prisma` to `sdn`.
- `generated/app/models/` holds the files, in the package `app.models` (change it with `"namespace"`). Each model is an `@Node` class, each foreign key an `@Relationship` field on one class and its reverse on the other, and the post-to-tag join table is one relationship with no class of its own.

The labels and relationship types are the same as in the [Neo4j example](../neo4j) and the [neomodel example](../neomodel), so the folders describe the same graph. Spring Data Neo4j creates no constraints, so apply the Cypher file of the Neo4j example for those.

Generated files are committed. Regenerate or verify them with:

```sh
cd examples/sdn
npx ormbridge convert           # rewrites generated/
npx ormbridge convert --check   # exit code 3 if a file is out of date
```

Inside this repository, run `npm run build` first and use `node ../../dist/cli.js convert` (or `npm run examples` / `npm run examples:check` from the root, which cover every example).

Read the format guide for identifiers, types, defaults, naming and warnings: [`../../docs/formats/sdn.md`](../../docs/formats/sdn.md).
