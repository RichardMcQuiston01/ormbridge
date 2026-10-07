# CHANGELOG

## Unreleased

### Added

- ESLint (typescript-eslint) with `lint`, `lint:fix`, `format` and `format:check` scripts.
- GitHub Actions CI running lint, format check, build and tests on pull requests and pushes to `dev` and `main`.

### Changed

- Pinned TypeScript to 6.x because typescript-eslint does not yet support TypeScript 7.
- Formatted the codebase with Prettier.
