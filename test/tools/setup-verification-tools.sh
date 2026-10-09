#!/usr/bin/env bash
# Installs the real tools that the optional verification tests use (Django, graphene-django,
# TypeORM with SQLite and Drizzle ORM with drizzle-kit) into a scratch directory outside this
# repository, then prints the environment variables that switch the tests on.
#
# Usage: test/tools/setup-verification-tools.sh [directory]
#   eval "$(test/tools/setup-verification-tools.sh /tmp/ormbridge-tools | grep '^export ')"
#   npx vitest run
#
# Needs python3 with venv + pip, and node with npm, and network access (or a package proxy).
set -euo pipefail

target="${1:-${TMPDIR:-/tmp}/ormbridge-verification-tools}"
mkdir -p "${target}"

echo "Installing Django and graphene-django into ${target}/venv" >&2
python3 -m venv "${target}/venv"
"${target}/venv/bin/pip" install --quiet django graphene-django

echo "Installing TypeORM and SQLite into ${target}/typeorm" >&2
mkdir -p "${target}/typeorm"
(
  cd "${target}/typeorm"
  [ -f package.json ] || npm init -y > /dev/null
  # better-sqlite3 runs the SQLite checks. pg, mysql2 and mssql only let TypeORM build its
  # metadata for PostgreSQL, MySQL and SQL Server (no server is needed).
  npm install --silent typeorm reflect-metadata better-sqlite3 typescript @types/node \
    pg mysql2 mssql
)

echo "Installing Drizzle ORM and drizzle-kit into ${target}/drizzle" >&2
mkdir -p "${target}/drizzle"
(
  cd "${target}/drizzle"
  [ -f package.json ] || npm init -y > /dev/null
  # drizzle-kit reads the schema files and writes its own snapshot of them; no database is needed.
  npm install --silent drizzle-orm drizzle-kit typescript @types/node
)

echo "export DJANGO_PYTHON=${target}/venv/bin/python"
echo "export TYPEORM_DIR=${target}/typeorm"
echo "export DRIZZLE_DIR=${target}/drizzle"
