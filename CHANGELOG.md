# CHANGELOG

## Unreleased

### Added

- TypeScript interfaces emitter (`src/emitters/typescriptInterfaces.ts`, `emitTypescriptInterfaces`, the output-only `typescript` format; pass `--to typescript` because `.ts` is not inferred). Writes one `export interface` per model and string `export enum`s for enums, with `| null` for nullable fields, foreign-key scalars plus optional expanded relations and reverse lists, and JSON-friendly types (`string` for dates, decimals, big integers and UUIDs, `unknown` for JSON). A programmatic `dates: 'date'` option types dates as `Date`. Both naming modes are supported; unrepresentable constructs produce warnings naming the model and field. Tests compile the output of every source with the TypeScript compiler API.
- TypeORM parser (`parseTypeorm`, `--from typeorm`): reads entity classes with the tree-sitter TypeScript grammar. Supports `@Entity` names, `@Column` options (type, length, nullable, unique, default, precision/scale, enum), `@PrimaryGeneratedColumn` (increment/uuid), `@PrimaryColumn` (including composite keys), `@CreateDateColumn` / `@UpdateDateColumn`, `@OneToOne` / `@ManyToOne` / `@OneToMany` / `@ManyToMany` with `@JoinColumn` / `@JoinTable` and `onDelete`, `@Index`, `@Unique`, TypeScript enums and string lists, embedded entities and base-class inheritance. Unsupported constructs produce warnings naming the entity and column. Directory input with `--from typeorm` picks up `.ts` files (excluding `.d.ts`, `.test.ts` and `.spec.ts`).
- Canonical TypeORM fixture of the blog schema, with goldens for TypeORM to Django and Prisma.
- TypeORM emitter (`src/emitters/typeorm.ts`, `emitTypeorm`, the `typeorm` format is read and write; `.ts` is not inferred, so pass `--from typeorm` or `--to typeorm`). Writes entity classes with typed properties, `@PrimaryGeneratedColumn` / `@PrimaryColumn`, `@Column` with explicit types, TypeScript enums, `@CreateDateColumn` / `@UpdateDateColumn`, owning and inverse relation decorators with `@JoinColumn` / `@JoinTable` and `onDelete`, and class-level `@Index` / `@Unique`. Both naming modes are supported; unrepresentable constructs produce warnings naming the model and field.
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
