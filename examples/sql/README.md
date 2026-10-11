# SQL example

This folder shows the `sql` format in both directions, using the shared Prisma schema [`../schema/schema.prisma`](../schema/schema.prisma) as the starting point.

- `ormbridge.config.json` defines two conversions: `to-sql` and `from-sql`.
- `models/schema.sql` is PostgreSQL DDL written from the Prisma schema (enum type, tables, constraints and indexes).
- `prisma/schema.prisma` is that script read back into Prisma. Model names come from the table names (`BlogPost`).

Generated files are committed. Regenerate or verify them with:

```sh
cd examples/sql
npx ormbridge convert           # runs both conversions
npx ormbridge convert --check   # exit code 3 if a file is out of date
```

Inside this repository, run `npm run build` first and use `node ../../dist/cli.js convert` (or `npm run examples` / `npm run examples:check` from the root, which cover every example). Add `provider` to the `to-sql` entry (or pass `--provider mysql|sqlite|sqlserver`) to write another dialect. The PostgreSQL run prints a warning that `updated_at` columns need a trigger; that is expected.

Read the format guide for dialects, reading rules and warnings: [`../../docs/formats/sql.md`](../../docs/formats/sql.md).
