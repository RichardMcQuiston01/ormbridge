#!/usr/bin/env bash
# Rewrites the generated files of every example project under examples/ with the built CLI
# (run "npm run build" first). Pass --check to verify they are up to date instead.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
cli="$root/dist/cli.js"
for config in "$root"/examples/*/ormbridge.config.json; do
  directory="$(dirname "$config")"
  echo "== ${directory#"$root"/}"
  (cd "$directory" && node "$cli" convert "$@")
done
