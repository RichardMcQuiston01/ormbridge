# CHANGELOG

## Unreleased

### Added

- ESLint (typescript-eslint) with `lint`, `lint:fix`, `format` and `format:check` scripts.
- GitHub Actions CI running lint, format check, build and tests on pull requests and pushes to `dev` and `main`.
- Publish workflow for `v*.*.*` tags: verifies the tag matches `package.json` and the commit is on `main`, runs lint, format check, build and tests, then publishes to npm with provenance. Prerelease versions publish under the `next` dist-tag.

### Changed

- Pinned TypeScript to 6.x because typescript-eslint does not yet support TypeScript 7.
- Formatted the codebase with Prettier.
