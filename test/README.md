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

## Conversion matrix

`conversion-matrix.test.ts` adds a semantic layer on top of the text goldens: for every ordered pair of readable and writable formats it reads A's fixture, writes B, reads B back and compares the two IRs with `irCompare.ts`. New readable formats join automatically. Every difference must be explained in `conversionMatrixDoc.ts` (`LOSS_REASONS`), and `docs/CONVERSION_MATRIX.md` is generated from the results (`npm run docs:matrix`, or `UPDATE_GOLDEN=1 npm test`).

## Round-trip drift files

`roundtrip-<from>-<via>.drift.txt` lists what a round trip changes. An empty file means the pair is lossless for the fixture. A non-empty file documents a lossy mapping: `+` lines were added and `-` lines were lost. Any change to a mapping shows up as a diff in these files.
