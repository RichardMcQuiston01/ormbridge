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

## Conversion matrix

`conversion-matrix.test.ts` adds a semantic layer on top of the text goldens: for every ordered pair of readable and writable formats it reads A's fixture, writes B, reads B back and compares the two IRs with `irCompare.ts`. New readable formats join automatically. Every difference must be explained in `conversionMatrixDoc.ts` (`LOSS_REASONS`), and `docs/CONVERSION_MATRIX.md` is generated from the results (`npm run docs:matrix`, or `UPDATE_GOLDEN=1 npm test`).

## Round-trip drift files

`roundtrip-<from>-<via>.drift.txt` lists what a round trip changes. An empty file means the pair is lossless for the fixture. A non-empty file documents a lossy mapping: `+` lines were added and `-` lines were lost. Any change to a mapping shows up as a diff in these files.
