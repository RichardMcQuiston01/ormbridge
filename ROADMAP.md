# ROADMAP

Work is split into tracks that can be built by separate agents in parallel. Each track owns its own files, so branches rarely touch the same code. Tracks marked **blocked by** must wait for that step to merge into `dev`.

## Workflow

- **Branches:** every task is a feature branch cut from `dev`, named `feature/<track>-<short-description>` (for example `feature/typeorm-emitter`). Nobody commits directly to `dev` or `main`.
- **Pull requests into `dev`:** a PR may merge only after lint, build, and tests pass in CI. Prefer small PRs and squash merges. Rebase on `dev` before opening the PR.
- **Release:** once `dev` is fully tested, open one `dev` → `main` PR (same checks required).
- **Publishing:** after the release PR merges, bump the version on `main` (`npm version <patch|minor|major>`) and push the tag (`git push --follow-tags`). The publish workflow runs from the tag, confirms the tagged commit is on `main`, then publishes to npm.
- **Every PR** updates `CHANGELOG.md`, and the README "What is converted" section when it adds a format or field type.
- **Shared files** (`src/ir.ts`, `src/index.ts`, `src/formats.ts`, README tables) are conflict hotspots. Change them in the smallest PR possible and merge it before dependent work starts.

## Phase 0: Foundations (sequential, complete before Phase 1)

| Step | Branch | Work | Blocked by |
| --- | --- | --- | --- |
| 0.1 | `feature/tooling-lint-ci` | Add ESLint (typescript-eslint) next to the existing Prettier config, plus `lint` and `format:check` scripts. CI runs lint, build, and tests on PRs to `dev` and `main`. Enable branch protection on both branches. | none |
| 0.2 | `feature/release-workflow` | Publish workflow on `v*.*.*` tags: verify the tag matches `package.json`, verify the commit is an ancestor of `main`, build, test, publish. Prerelease versions publish under `next`. | 0.1 |
| 0.3 | `feature/format-registry` | Replace the hard-coded Django/Prisma checks in `convert.ts` and `cli.ts` with a registry. Each format is one adapter (`name`, file extensions, optional `parse`, optional `emit`) registered in `src/formats.ts`. The CLI validates `--from`/`--to` against the registry and gets a `formats` command that lists what is supported. | 0.1 |
| 0.4 | `feature/test-harness` | Shared fixture set in `test/fixtures/` (one canonical schema expressed in every format) plus helpers for golden-file and round-trip tests, so each adapter only adds its own fixture. | 0.3 |

0.2 and 0.3 can run in parallel once 0.1 is merged.

## Phase 1: Adapters and coverage (parallel)

Each track below is independent after Phase 0 and owns its files.

| Track | Branch | Owns | Work |
| --- | --- | --- | --- |
| A. TypeORM parser | `feature/typeorm-parser` | `src/parsers/typeorm.ts`, `src/parsers/typescriptSyntax.ts` | Read entity classes with tree-sitter (TypeScript grammar from `tree-sitter-wasms`): `@Entity`, `@Column` options, `@PrimaryGeneratedColumn`, relation decorators with `@JoinColumn`/`@JoinTable`, `@Index`, `@Unique`, enums, embedded entities. |
| B. TypeORM emitter | `feature/typeorm-emitter` | `src/emitters/typeorm.ts` | Emit entity classes from the IR, with typed properties, the correct relation decorators, and reverse sides. Works without track A by testing against IR fixtures. |
| C. Graphene emitter | `feature/graphene-emitter` | `src/emitters/graphene.ts` | Emit `DjangoObjectType` classes plus Query/Mutation scaffolding from the IR. Needs no parser. |
| D. TypeScript interfaces | `feature/typescript-interfaces` | `src/emitters/typescriptInterfaces.ts` | Emit plain interfaces and enums from the IR for sharing in a front end library (the original Angular use case). Needs no parser. |
| E. Django coverage | `feature/django-fields` | `src/parsers/django.ts`, `src/emitters/django.ts` | More field types (`django.contrib.postgres`: `ArrayField`, `HStoreField`, range fields), `GeneratedField`, `db_default`, proxy and swappable models, custom managers ignored cleanly. |
| F. Prisma coverage | `feature/prisma-coverage` | `src/parsers/prisma.ts`, `src/emitters/prisma.ts` | Composite foreign keys, `@@fulltext`, views, native-type edge cases, `Unsupported(...)` handling, Prisma 7 datasource header. |

Tracks A and B can be built by separate agents at the same time. A should land first if only one reviewer is available, since B's round-trip tests become stronger once A exists.

## Phase 2: Integration (after the Phase 1 tracks it needs)

| Step | Branch | Work | Blocked by |
| --- | --- | --- | --- |
| 2.1 | `feature/conversion-matrix` | Round-trip and cross-format tests across every parser and emitter pair (Django, Prisma, TypeORM), with a documented table of what is lossy. | A, B |
| 2.2 | `feature/cli-polish` | `--dry-run`, `--check` (exit non-zero if the output file is stale, for CI use), config file support, and clearer multi-file output for formats that need several files. | 0.3 |
| 2.3 | `feature/docs-examples` | Format-by-format guides and a runnable example project per supported format. | whichever formats it documents |

## Phase 3: PHP ORMs (after Phase 2)

Doctrine ships first because it maps closely onto TypeORM. Laravel follows, since its schema lives in migrations rather than in the models. Symfony uses Doctrine, so one adapter covers both.

| Track | Branch | Owns | Work | Blocked by |
| --- | --- | --- | --- | --- |
| G. Doctrine parser | `feature/doctrine-parser` | `src/parsers/doctrine.ts`, `src/parsers/phpSyntax.ts` | Read PHP 8 entity classes with tree-sitter (PHP grammar from `tree-sitter-wasms`): `#[ORM\Entity]`, `#[ORM\Column]`, `#[ORM\Id]`, `#[ORM\GeneratedValue]`, relation attributes with `JoinColumn`/`JoinTable`, `#[ORM\Index]`, `#[ORM\UniqueConstraint]`, backed enums, embeddables, and inheritance mapping. Attributes first; docblock annotations and XML/YAML mappings later. | 0.3, 0.4 |
| H. Doctrine emitter | `feature/doctrine-emitter` | `src/emitters/doctrine.ts` | Emit entity classes from the IR with typed PHP 8 properties, attributes, getters and setters, enums, and the owning and inverse sides of each relation. Tests against IR fixtures, so it does not wait for track G. | 0.3, 0.4 |
| I. Laravel parser | `feature/laravel-parser` | `src/parsers/laravel.ts` | Replay migration files in order (`Schema::create`, `Schema::table`, `dropColumn`, `renameColumn`, and so on) to rebuild the current schema, then read Eloquent model methods (`hasMany`, `belongsTo`, `belongsToMany`, `morphTo`) for relations. Honour Laravel naming conventions (plural tables, `<model>_id` keys) in `preserve` mode. | 0.3, 0.4, multi-file input (2.2) |
| J. Laravel emitter | `feature/laravel-emitter` | `src/emitters/laravel.ts` | Emit Eloquent models and one migration per table, with pivot tables for many-to-many relations. Produces several files, so the emitter returns a file map. | 0.3, 0.4, multi-file output (2.2) |

Tracks G and H run in parallel, as do I and J. After they land, extend the conversion matrix (2.1) to cover the PHP formats and document what is lossy.

## Phase 4: Release

1. Merge all finished tracks into `dev`; run the full suite there.
2. Open the `dev` → `main` release PR; update `CHANGELOG.md` and the README.
3. Tag from `main` (`npm version minor && git push --follow-tags`); the workflow publishes.

## Parallel work plan

- **Now (one agent each, parallel):** 0.1, then 0.2 and 0.3 together, then 0.4.
- **After 0.4 (up to six agents):** tracks A, B, C, D, E, F.
- **After A and B:** 2.1. 2.2 and 2.3 can run any time their blockers are merged.
- **After Phase 2 (up to four agents):** tracks G, H, I, J. Start G and H first; I and J need the multi-file work from 2.2.

## Backlog (unscheduled)

- Additional ORMs (SQLAlchemy, Sequelize, Drizzle, Entity Framework, Hibernate/JPA)
- Zod and JSON Schema emitters
- Watch mode for regenerating shared models during development
