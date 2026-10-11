# SQLAlchemy example

This folder shows the `sqlalchemy` format in both directions, using the shared Prisma schema [`../schema/schema.prisma`](../schema/schema.prisma) as the starting point.

- `ormbridge.config.json` defines two conversions: `to-sqlalchemy` and `from-sqlalchemy`.
- `models/models.py` holds SQLAlchemy 2.0 declarative models (`Mapped[...]`, `mapped_column`, `relationship`).
- `prisma/schema.prisma` is those models read back into Prisma. The Python is parsed statically, so Python and SQLAlchemy are not needed to run it.

Generated files are committed. Regenerate or verify them with:

```sh
cd examples/sqlalchemy
npx ormbridge convert           # runs both conversions
npx ormbridge convert --check   # exit code 3 if a file is out of date
```

Inside this repository, run `npm run build` first and use `node ../../dist/cli.js convert` (or `npm run examples` / `npm run examples:check` from the root, which cover every example). Add `"style": "sqlmodel"` to the `to-sqlalchemy` entry (or pass `--style sqlmodel`) to write SQLModel classes. One warning is expected: the `metadata` column is written as `metadata_` because `metadata` is reserved on declarative classes.

Read the format guide for reading rules, SQLModel and warnings: [`../../docs/formats/sqlalchemy.md`](../../docs/formats/sqlalchemy.md).
