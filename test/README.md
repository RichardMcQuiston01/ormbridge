# Test harness

One canonical schema (the "blog" models) is expressed in every readable format. The shared tests in `conversion.test.ts` convert it between every registered format pair and compare the result with stored golden files.

## Adding a format

1. Express the canonical schema in your format and add the file(s) under `test/fixtures/`.
2. Add one entry to `CANONICAL_FIXTURES` in `test/fixtures/canonical.ts`.
3. Run `UPDATE_GOLDEN=1 npm test` to create the golden files for your format, then review the new files in `test/golden/` before committing.

A test fails if a readable format has no canonical fixture.

## Helpers (`harness.ts`)

- `loadCanonicalSources(format)` and `convertCanonical(from, to, overrides)` read and convert a fixture.
- `expectMatchesGolden(name, text)` compares text with `test/golden/<name>`. Set `UPDATE_GOLDEN=1` to write it instead.
- `roundTrip(from, via)` converts `from -> via -> from -> via`. `describeDrift(before, after)` lists the lines that changed.

## Multi-file formats

An emitter that returns a file map (such as `doctrine`) is compared file by file: its golden is the directory `test/golden/<pair>.<naming>/` with one golden file per generated file at the same relative path, instead of `<pair>.<naming>.txt`. `expectConversionMatchesGolden(pair, naming, result)` picks the right form; `expectFilesMatchGolden(name, files)` is the directory form. A file that is generated without a golden, or a golden that is no longer generated, fails the test and is named; `UPDATE_GOLDEN=1` rewrites the whole directory, so goldens of removed files disappear. `conversion.test.ts` also fails when `test/golden/` contains an entry that no format pair produces.

Round trips (`roundTrip`) feed every emitted file back into the parser (`resultToSources`) and `describeResultDrift` lists drift per file (`@@ path`, `+ file path`, `- file path`). The matrix helpers do the same (`emitWith` keeps the file map next to the joined text, `parseEmitted` reads all of the files). `harness.test.ts` covers this with a test-only readable multi-file format, so a multi-file format that also gets a parser (Doctrine, Laravel) joins the round trips and the matrix without further changes.

The Doctrine tests (`doctrine-emitter.test.ts`) lint the generated PHP with `php -l` and skip when PHP is missing. Set `DOCTRINE_DIR` to a directory where `composer require doctrine/orm symfony/cache` has been run (outside this repository) to also load the entities with Doctrine's real metadata factory, validate the mapping and create the schema in SQLite (`test/tools/validate-doctrine.php`).

The Laravel tests (`laravel-parser.test.ts`) lint the fixture project with `php -l` and skip when PHP is missing. Set `LARAVEL_DIR` to a directory where `composer require illuminate/database illuminate/events illuminate/container` has been run (outside this repository) to also run the fixture migrations in order against SQLite with the real Illuminate packages (`test/tools/replay-laravel-migrations.php`) and compare the resulting tables, keys and indexes with the parser's result.

The GORM tests (`gorm-emitter.test.ts`) run `gofmt -l` over every generated file (all five canonical conversions in both naming modes and all four providers, plus a kitchen-sink and a stress schema from `gormFixtures.ts`) and skip when Go is missing. When the Go modules can be fetched (the tests create a scratch module and `go get` pinned versions of `gorm.io/gorm`, `github.com/glebarez/sqlite`, `github.com/google/uuid`, `github.com/shopspring/decimal`, `gorm.io/datatypes` and the PostgreSQL, MySQL and SQL Server drivers; without network access these tests are skipped), they also `go vet` the models, run `AutoMigrate` on in-memory SQLite and compare the resulting tables, columns, foreign keys and indexes with the IR (`tools/validate-gorm.go`), run persistence checks on the Django blog schema (`tools/validate-gorm-blog.go`: `BeforeCreate` UUIDs, defaults, preloads, unique and referential actions), render the DDL for PostgreSQL, MySQL and SQL Server without a database, and compare the ported column and table naming functions with GORM's own `NamingStrategy`.

The Django, Graphene and TypeORM tests (`django-verify.test.ts`, `graphene-verify.test.ts`, `typeorm-verify.test.ts`) load the emitted code with the real tools and compare what the tools report with the IR of the canonical blog schema read from every other readable format, plus the larger prisma, django and gorm "extras" fixtures (Graphene covers the canonical Django fixture too) (`realToolSupport.ts` lists them and builds the expected "spec" from the IR). They are skipped with a reason in the test title when the tool is missing, and the `check` CI job does not install them (see "In CI" below). `test/tools/setup-verification-tools.sh [directory]` installs everything into a scratch directory and prints the two `export` lines below.

- Django (`test/tools/validate-django.py`): set `DJANGO_PYTHON` to a Python with Django installed (default `python3`, which is used when it has Django). The script puts `models.py` into a scratch app and runs `check`, `makemigrations --dry-run`, `makemigrations`, `sqlmigrate` and `migrate` on in-memory SQLite, then compares `_meta` (table, column, field type, nullability, uniqueness, lengths, enum choices, relation targets, `on_delete`, `related_name`) and the introspected database (columns, nullability, primary key, foreign keys, unique constraints, named indexes, many-to-many join tables) with the IR.
- Graphene (`test/tools/validate-graphene.py`): the same `DJANGO_PYTHON`, with graphene-django installed. The generated `schema.py` is imported next to the Django models generated from the same source (a Django source is its own models file, used as written: the project installs `django.contrib.auth` so `settings.AUTH_USER_MODEL` is `auth.User`, and `User = get_user_model()` is appended so the `User` the schema imports from `.models` resolves), `graphene.Schema` is built, its SDL printed and the introspection query run; the script checks the object type and every field and relation of each model, the enum types behind enum fields, the `Query` single and list fields and the `Create`/`Update`/`Delete` mutations, creates the tables, runs every list query and a create, get, update and delete round trip through GraphQL for every model that can be created (a model whose input needs another row, such as a post with its author and category, follows the models it points at; the test for the Django fixture asserts that `Post` and `Profile` go through it).
- TypeORM (`test/tools/validate-typeorm.ts`): set `TYPEORM_DIR` to a directory where `npm install typeorm reflect-metadata better-sqlite3 typescript @types/node` has been run (add `pg mysql2 mssql` to also build the PostgreSQL, MySQL and SQL Server entities). The entities of every provider are compiled with `tsc` (`experimentalDecorators`, `emitDecoratorMetadata`, strict), TypeORM's metadata is built for them (`DataSource.buildMetadatas`, which rejects column types the driver does not support) and compared with the IR in both naming modes; the SQLite entities are also synchronized into an in-memory database (`synchronize: true`) and its tables, columns, foreign keys, unique constraints and indexes are compared. Without a server, PostgreSQL, MySQL and SQL Server only get the compile and metadata checks.

Left out of the extras on purpose: Prisma views and the PostgreSQL-only array and `Unsupported(...)` columns (no real tool can load them here, and the emitters already warn), and the django-extras fixture for Graphene (its `django.contrib.postgres` fields need psycopg and a PostgreSQL server to load).

## In CI

`.github/workflows/ci.yml` has two jobs. `check` (lint, format, build, `npm test`) installs no tools, so the optional tests skip there and it stays fast. `real-tools` installs the tools and runs the whole suite so that nothing skips: Django and graphene-django in a venv (`DJANGO_PYTHON`) and TypeORM with better-sqlite3, pg, mysql2 and mssql (`TYPEORM_DIR`) through `test/tools/setup-verification-tools.sh`, PHP 8.3 with Composer packages for Doctrine ORM (`DOCTRINE_DIR`) and Illuminate (`LARAVEL_DIR`), Prisma 6 (`PRISMA_BIN`, `PRISMA_MAJOR=6`, whole suite) and then Prisma 7 (`PRISMA_MAJOR=7`, `prisma-extras.test.ts` only), and the Go toolchain (GORM; the tests `go get` their pinned modules). npm, Composer and Go module downloads are cached. The real-tool tests that run PHP or the Prisma CLI set explicit vitest timeouts (`PHP_TOOL_TIMEOUT_MS`, `PRISMA_VALIDATE_TIMEOUT_MS`), because the 5 s default is too tight on a busy runner. To reproduce the job locally, follow the steps of `real-tools` in the workflow.

## Conversion matrix

`conversion-matrix.test.ts` adds a semantic layer on top of the text goldens: for every ordered pair of readable and writable formats it reads A's fixture, writes B, reads B back and compares the two IRs with `irCompare.ts`. New readable formats join automatically. Write-only formats with a structural check (`EMIT_ONLY_CHECKS` in `conversionMatrix.ts`, currently GORM) get a "Write-only targets" section instead of IR comparisons, with their approximations in `EMIT_ONLY_NOTES`. Every difference must be explained in `conversionMatrixDoc.ts` (`LOSS_REASONS`), and `docs/CONVERSION_MATRIX.md` is generated from the results (`npm run docs:matrix`, or `UPDATE_GOLDEN=1 npm test`).

## Round-trip drift files

`roundtrip-<from>-<via>.drift.txt` lists what a round trip changes. An empty file means the pair is lossless for the fixture. A non-empty file documents a lossy mapping: `+` lines were added and `-` lines were lost. Any change to a mapping shows up as a diff in these files.
