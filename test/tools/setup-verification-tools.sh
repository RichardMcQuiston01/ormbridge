#!/usr/bin/env bash
# Installs the real tools that the optional verification tests use (Django, graphene-django,
# TypeORM with SQLite, Drizzle ORM with drizzle-kit, Ajv for JSON Schema, Zod, better-sqlite3 for the SQL DDL
# tests, SQLAlchemy 2 with SQLModel for the SQLAlchemy parser and emitter tests, Sequelize 6 with SQLite for the
# Sequelize parser and emitter tests, the .NET 8 SDK with EF Core 8, its SQLite provider and the Npgsql provider
# for the EF Core parser and emitter tests, and the Maven packages of Hibernate ORM 6 with H2 for the Hibernate / JPA
# parser tests) into a scratch directory
# outside this repository, then prints the environment variables that switch the tests on.
#
# Usage: test/tools/setup-verification-tools.sh [directory]
#   eval "$(test/tools/setup-verification-tools.sh /tmp/ormbridge-tools | grep '^export ')"
#   npx vitest run
#
# Needs python3 with venv + pip, and node with npm, and network access (or a package proxy). The EF Core part also
# needs the .NET SDK (8 or later): an existing `dotnet` on the PATH (or named by DOTNET) is used, otherwise the official
# dotnet-install.sh is tried, and when neither works that part is skipped with a message and the EF Core verification
# tests skip themselves (EFCORE_DIR and DOTNET are then not printed). The Hibernate / JPA part needs Java 17 or later
# and Maven on the PATH (or named by JAVA and MVN); without them it is skipped with a message and the JPA verification
# tests skip themselves (JPA_DIR, JAVA and MVN are then not printed).
set -euo pipefail

target="${1:-${TMPDIR:-/tmp}/ormbridge-verification-tools}"
mkdir -p "${target}"

echo "Installing Django and graphene-django into ${target}/venv" >&2
python3 -m venv "${target}/venv"
"${target}/venv/bin/pip" install --quiet django graphene-django

echo "Installing SQLAlchemy 2 and SQLModel into ${target}/venv" >&2
# The SQLAlchemy parser and emitter tests (SQLALCHEMY_PYTHON) load the models with the real libraries, so they share the
# virtual environment with Django.
"${target}/venv/bin/pip" install --quiet "sqlalchemy>=2" sqlmodel

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

echo "Installing Sequelize 6, sqlite3, sequelize-typescript and the PostgreSQL, MySQL and SQL Server drivers into ${target}/sequelize" >&2
mkdir -p "${target}/sequelize"
(
  cd "${target}/sequelize"
  [ -f package.json ] || npm init -y > /dev/null
  # Sequelize does not support better-sqlite3: its SQLite dialect needs sqlite3. sequelize-typescript,
  # reflect-metadata and typescript load the decorator fixtures (compiled with tsc, no database server needed).
  # pg, pg-hstore, mysql2 and tedious let Sequelize build the CREATE TABLE statements of the other dialects (no server needed).
  npm install --silent sequelize@6 sqlite3 sequelize-typescript reflect-metadata typescript @types/node \
    pg pg-hstore mysql2 tedious
)

echo "Preparing the .NET SDK and the EF Core 8 packages (SQLite and Npgsql providers) in ${target}/efcore" >&2
here="$(cd "$(dirname "$0")" && pwd)"
dotnet_bin="${DOTNET:-$(command -v dotnet || true)}"
if [ -z "${dotnet_bin}" ]; then
  # No SDK installed: try Microsoft's installer (needs network access to dot.net and the download hosts).
  if curl -fsSL https://dot.net/v1/dotnet-install.sh -o "${target}/dotnet-install.sh" \
    && bash "${target}/dotnet-install.sh" --channel 8.0 --install-dir "${target}/dotnet" >&2; then
    dotnet_bin="${target}/dotnet/dotnet"
  else
    echo "The .NET SDK could not be installed (dot.net may be blocked: 'apt-get install dotnet-sdk-8.0' works on Ubuntu); the EF Core verification tests will be skipped." >&2
  fi
fi
efcore_ready=""
if [ -n "${dotnet_bin}" ]; then
  mkdir -p "${target}/efcore"
  scratch="$(mktemp -d)"
  cp "${here}/efcore-verify/EfcoreVerify.csproj" "${here}/efcore-verify/Program.cs" "${scratch}/"
  # Restoring fills the NuGet cache that the test uses (NUGET_PACKAGES); the test then needs no network.
  if (
    cd "${scratch}"
    NUGET_PACKAGES="${target}/efcore/nuget" DOTNET_CLI_HOME="${target}/efcore/home" \
      DOTNET_CLI_TELEMETRY_OPTOUT=1 DOTNET_NOLOGO=1 "${dotnet_bin}" restore --verbosity quiet >&2
  ); then
    efcore_ready="yes"
  else
    echo "Restoring the EF Core packages failed; the EF Core verification tests will be skipped." >&2
  fi
  rm -rf "${scratch}"
fi

echo "Preparing Maven and the Hibernate ORM 6 and H2 packages in ${target}/jpa" >&2
java_bin="${JAVA:-$(command -v java || true)}"
mvn_bin="${MVN:-$(command -v mvn || true)}"
jpa_ready=""
if [ -n "${java_bin}" ] && [ -n "${mvn_bin}" ]; then
  mkdir -p "${target}/jpa"
  scratch="$(mktemp -d)"
  cp -r "${here}/jpa-verify/pom.xml" "${here}/jpa-verify/src" "${scratch}/"
  java_home="$(dirname "$(dirname "$(readlink -f "${java_bin}")")")"
  # Building the tool fills the Maven repository that the test uses (-Dmaven.repo.local); the test then needs no network.
  if (
    cd "${scratch}"
    JAVA_HOME="${java_home}" "${mvn_bin}" -B -q -Dmaven.repo.local="${target}/jpa/m2" \
      package dependency:build-classpath -Dmdep.outputFile="${scratch}/cp.txt" >&2
  ); then
    jpa_ready="yes"
  else
    echo "Resolving the Hibernate packages with Maven failed; the JPA verification tests will be skipped." >&2
  fi
  rm -rf "${scratch}"
else
  echo "Java 17 and Maven were not found ('apt-get install openjdk-17-jdk maven' works on Ubuntu); the JPA verification tests will be skipped." >&2
fi

echo "Installing Zod 4, TypeScript and tsx into ${target}/zod" >&2
mkdir -p "${target}/zod"
(
  cd "${target}/zod"
  [ -f package.json ] || npm init -y > /dev/null
  npm install --silent zod@4 typescript tsx @types/node
)

echo "Installing better-sqlite3 into ${target}/sql" >&2
mkdir -p "${target}/sql"
(
  cd "${target}/sql"
  [ -f package.json ] || npm init -y > /dev/null
  # Runs the SQL DDL output on Node versions without node:sqlite (before 22.5). PostgreSQL and MySQL
  # need a server: set SQL_POSTGRES_URL / SQL_MYSQL_URL yourself (see test/README.md).
  npm install --silent better-sqlite3
)

echo "export DJANGO_PYTHON=${target}/venv/bin/python"
echo "export SQLALCHEMY_PYTHON=${target}/venv/bin/python"
echo "export TYPEORM_DIR=${target}/typeorm"
echo "export DRIZZLE_DIR=${target}/drizzle"
echo "export SEQUELIZE_DIR=${target}/sequelize"
echo "export AJV_DIR=${target}/ajv"
echo "export ZOD_DIR=${target}/zod"
echo "export SQL_DIR=${target}/sql"
if [ -n "${efcore_ready}" ]; then
  echo "export EFCORE_DIR=${target}/efcore"
  echo "export DOTNET=${dotnet_bin}"
fi
if [ -n "${jpa_ready}" ]; then
  echo "export JPA_DIR=${target}/jpa"
  echo "export MVN=${mvn_bin}"
  echo "export JAVA=${java_bin}"
fi
