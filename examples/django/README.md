# Django example

Django models generated from the shared schema [`../schema/schema.prisma`](../schema/schema.prisma), and the way back.

- `ormbridge.config.json` defines two conversions.
- `models/models.py` is the Django output (`to-django`: Prisma to Django).
- `prisma/schema.prisma` is the Prisma output read back from `models/` (`from-django`: Django to Prisma).

Both files are generated. Do not edit them by hand; change `../schema/schema.prisma` and regenerate.

## Run

```bash
cd examples/django
npx ormbridge convert            # regenerate both files
npx ormbridge convert --check    # exit code 3 if a file is stale
```

Inside this repository, after `npm run build`, use `node ../../dist/cli.js convert` instead of `npx ormbridge convert`. From the repository root, `npm run examples` regenerates every example and `npm run examples:check` verifies them.

See the format guide: [`../../docs/formats/django.md`](../../docs/formats/django.md).
