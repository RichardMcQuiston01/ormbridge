# CHANGELOG

## Unreleased

### Added

- TypeORM emitter (`src/emitters/typeorm.ts`, `emitTypeorm`, registered as the output-only `typeorm` format; use `--to typeorm`). Writes entity classes with typed properties, `@PrimaryGeneratedColumn` / `@PrimaryColumn`, `@Column` with explicit types, TypeScript enums, `@CreateDateColumn` / `@UpdateDateColumn`, owning and inverse relation decorators with `@JoinColumn` / `@JoinTable` and `onDelete`, and class-level `@Index` / `@Unique`. Both naming modes are supported; unrepresentable constructs produce warnings naming the model and field.
- Shared test harness: a canonical schema per format (`test/fixtures/canonical.ts`), golden-file comparisons for every readable/writable format pair in both naming modes, and round-trip drift files that document lossy mappings. See `test/README.md`.
- Format registry (`src/formats.ts`) with a `FormatAdapter` interface (`name`, `extensions`, `description`, optional `parse` and `emit`) and `registerFormat`, `getFormat`, `getFormatByExtension`, `listFormats` and `listFormatNames` helpers, exported from the package. Django and Prisma are registered as adapters.
- `ormbridge formats` command listing each format with its file extensions and whether it can be read and/or written.
- ESLint (typescript-eslint) with `lint`, `lint:fix`, `format` and `format:check` scripts.
- GitHub Actions CI running lint, format check, build and tests on pull requests and pushes to `dev` and `main`.
- Publish workflow for `v*.*.*` tags: verifies the tag matches `package.json` and the commit is on `main`, runs lint, format check, build and tests, then publishes to npm with provenance. Prerelease versions publish under the `next` dist-tag.

### Changed

- `convertText` and the CLI look formats up in the registry instead of hard-coding Django and Prisma. Unknown formats, and formats that cannot be read or written, return descriptive errors. `FormatName` is now a `string`; `FORMAT_NAMES` still lists the built-in formats.
- Pinned TypeScript to 6.x because typescript-eslint does not yet support TypeScript 7.
- Formatted the codebase with Prettier.
