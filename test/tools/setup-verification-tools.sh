#!/usr/bin/env bash
# Installs the real tools that the optional verification tests use (Django, graphene-django,
# TypeORM with SQLite, Drizzle ORM with drizzle-kit, Ajv for JSON Schema and Zod) into a scratch directory outside
# this repository, then prints the environment variables that switch the tests on.
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

echo "Installing Ajv and ajv-formats into ${target}/ajv" >&2
mkdir -p "${target}/ajv"
(
  cd "${target}/ajv"
  [ -f package.json ] || npm init -y > /dev/null
  npm install --silent ajv ajv-formats
)

echo "Installing Drizzle ORM, drizzle-kit and SQLite into ${target}/drizzle" >&2
mkdir -p "${target}/drizzle"
(
  cd "${target}/drizzle"
  [ -f package.json ] || npm init -y > /dev/null
  # drizzle-kit generate needs no database; better-sqlite3 lets drizzle-kit push into SQLite and
  # lets the tests inspect the result. PostgreSQL and MySQL output is compiled and turned into SQL.
  npm install --silent drizzle-orm drizzle-kit typescript @types/node better-sqlite3 \
    @types/better-sqlite3
)

echo "Installing Zod 4, TypeScript and tsx into ${target}/zod" >&2
mkdir -p "${target}/zod"
(
  cd "${target}/zod"
  [ -f package.json ] || npm init -y > /dev/null
  npm install --silent zod@4 typescript tsx @types/node
)

echo "export DJANGO_PYTHON=${target}/venv/bin/python"
echo "export TYPEORM_DIR=${target}/typeorm"
echo "export DRIZZLE_DIR=${target}/drizzle"
echo "export AJV_DIR=${target}/ajv"
echo "export ZOD_DIR=${target}/zod"
