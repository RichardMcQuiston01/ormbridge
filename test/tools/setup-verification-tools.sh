#!/usr/bin/env bash
# Installs the real tools that the optional verification tests use (Django, graphene-django,
# TypeORM with SQLite, Drizzle ORM with drizzle-kit, Ajv for JSON Schema, Zod, better-sqlite3 for the SQL DDL
# tests, SQLAlchemy 2 with SQLModel for the SQLAlchemy parser and emitter tests, Sequelize 6 with SQLite for the
# Sequelize parser and emitter tests, the .NET 8 SDK with EF Core 8, its SQLite provider and the Npgsql provider
# for the EF Core parser and emitter tests, and the Maven packages of Hibernate ORM 6 and 5 with H2 for the Hibernate / JPA
# parser and writer tests) into a scratch directory
# outside this repository, then prints the environment variables that switch the tests on. The Neo4j tests need a
# server instead of an install: the script only prints how to start one (NEO4J_DOCKER=1 or NEO4J_URL).
#
# Usage: test/tools/setup-verification-tools.sh [directory [component...]]
#   eval "$(test/tools/setup-verification-tools.sh /tmp/ormbridge-tools | grep '^export ')"
#   npx vitest run
#
# With no component, everything is installed. Name one or more components to install only those (the CI jobs do this,
# one ecosystem per job), and only their `export` lines are printed:
#   python    Django, graphene-django, SQLAlchemy 2 and SQLModel in a venv (DJANGO_PYTHON, SQLALCHEMY_PYTHON)
#   typeorm   TypeORM with better-sqlite3 (TYPEORM_DIR)
#   ajv       Ajv and ajv-formats (AJV_DIR)
#   drizzle   Drizzle ORM and drizzle-kit (DRIZZLE_DIR)
#   sequelize Sequelize 6 (SEQUELIZE_DIR)
#   zod       Zod 4 (ZOD_DIR)
#   sql       better-sqlite3 for the SQL DDL tests (SQL_DIR)
#   prisma    the Prisma CLI, major versions 6 and 7 (PRISMA6_BIN, PRISMA7_BIN)
#   node      typeorm, ajv, drizzle, sequelize, zod, sql and prisma
#   dotnet    the .NET SDK and the EF Core packages (EFCORE_DIR, DOTNET)
#   java      the Hibernate 6 and 5 Maven packages (JPA_DIR, MVN, JAVA)
#
# The npm components are installed at the same time (a failure of any of them fails the script), and better-sqlite3 is
# pinned to a release that ships a prebuilt binary for Node 20 (BETTER_SQLITE3 overrides the package spec): the newest
# releases have none, so npm compiled SQLite from source, about 80 s per copy and three copies in the CI node job.
#
# Needs python3 with venv + pip (python component), and node with npm (node components), and network access (or a
# package proxy). The EF Core part also
# needs the .NET SDK (8 or later): an existing `dotnet` on the PATH (or named by DOTNET) is used, otherwise the official
# dotnet-install.sh is tried, and when neither works that part is skipped with a message and the EF Core verification
# tests skip themselves (EFCORE_DIR and DOTNET are then not printed). The Hibernate / JPA part needs Java 17 or later
# and Maven on the PATH (or named by JAVA and MVN); without them it is skipped with a message and the JPA verification
# tests skip themselves (JPA_DIR, JAVA and MVN are then not printed).
set -euo pipefail

target="${1:-${TMPDIR:-/tmp}/ormbridge-verification-tools}"
mkdir -p "${target}"
shift || true

# The components to install: all of them when none is named.
all_components=(python typeorm ajv drizzle sequelize zod sql prisma dotnet java)
components=()
for name in "$@"; do
  case "${name}" in
    node) components+=(typeorm ajv drizzle sequelize zod sql prisma) ;;
    python | typeorm | ajv | drizzle | sequelize | zod | sql | prisma | dotnet | java) components+=("${name}") ;;
    *)
      echo "Unknown component '${name}'; use one of: ${all_components[*]} node" >&2
      exit 2
      ;;
  esac
done
if [ "${#components[@]}" -eq 0 ]; then
  components=("${all_components[@]}")
  everything="yes"
else
  everything=""
fi
want() {
  case " ${components[*]} " in
    *" $1 "*) return 0 ;;
    *) return 1 ;;
  esac
}

here="$(cd "$(dirname "$0")" && pwd)"
efcore_ready=""
jpa_ready=""

# The npm components are independent, so they are installed at the same time in the background while the other
# components run; wait_for_npm (below) fails the script when any of them failed. The output of the installs is
# interleaved, so every message starts with the component.
sqlite_pkg="${BETTER_SQLITE3:-better-sqlite3@~12.9.0}"
npm_pids=()
npm_names=()
in_background() {
  local name="$1"
  shift
  "$@" &
  npm_pids+=("$!")
  npm_names+=("${name}")
}
wait_for_npm() {
  local failed=""
  local index
  [ "${#npm_pids[@]}" -gt 0 ] || return 0
  for index in "${!npm_pids[@]}"; do
    wait "${npm_pids[${index}]}" || failed="${failed} ${npm_names[${index}]}"
  done
  if [ -n "${failed}" ]; then
    echo "Installing failed for:${failed}" >&2
    exit 1
  fi
}

install_typeorm() {
  echo "Installing TypeORM and SQLite into ${target}/typeorm" >&2
  mkdir -p "${target}/typeorm"
  cd "${target}/typeorm"
  [ -f package.json ] || npm init -y > /dev/null
  # better-sqlite3 runs the SQLite checks. pg, mysql2 and mssql only let TypeORM build its
  # metadata for PostgreSQL, MySQL and SQL Server (no server is needed).
  npm install --silent typeorm reflect-metadata "${sqlite_pkg}" typescript @types/node \
    pg mysql2 mssql
}

install_ajv() {
  echo "Installing Ajv and ajv-formats into ${target}/ajv" >&2
  mkdir -p "${target}/ajv"
  cd "${target}/ajv"
  [ -f package.json ] || npm init -y > /dev/null
  npm install --silent ajv ajv-formats
}

install_drizzle() {
  echo "Installing Drizzle ORM, drizzle-kit and SQLite into ${target}/drizzle" >&2
  mkdir -p "${target}/drizzle"
  cd "${target}/drizzle"
  [ -f package.json ] || npm init -y > /dev/null
  # drizzle-kit generate needs no database; better-sqlite3 lets drizzle-kit push into SQLite and
  # lets the tests inspect the result. PostgreSQL and MySQL output is compiled and turned into SQL.
  npm install --silent drizzle-orm drizzle-kit typescript @types/node "${sqlite_pkg}" \
    @types/better-sqlite3
}

install_sequelize() {
  echo "Installing Sequelize 6, sqlite3, sequelize-typescript and the PostgreSQL, MySQL and SQL Server drivers into ${target}/sequelize" >&2
  mkdir -p "${target}/sequelize"
  cd "${target}/sequelize"
  [ -f package.json ] || npm init -y > /dev/null
  # Sequelize does not support better-sqlite3: its SQLite dialect needs sqlite3. sequelize-typescript,
  # reflect-metadata and typescript load the decorator fixtures (compiled with tsc, no database server needed).
  # pg, pg-hstore, mysql2 and tedious let Sequelize build the CREATE TABLE statements of the other dialects (no server needed).
  npm install --silent sequelize@6 sqlite3 sequelize-typescript reflect-metadata typescript @types/node \
    pg pg-hstore mysql2 tedious
}

install_zod() {
  echo "Installing Zod 4, TypeScript and tsx into ${target}/zod" >&2
  mkdir -p "${target}/zod"
  cd "${target}/zod"
  [ -f package.json ] || npm init -y > /dev/null
  npm install --silent zod@4 typescript tsx @types/node
}

install_sql() {
  echo "Installing better-sqlite3 into ${target}/sql" >&2
  mkdir -p "${target}/sql"
  cd "${target}/sql"
  [ -f package.json ] || npm init -y > /dev/null
  # Runs the SQL DDL output on Node versions without node:sqlite (before 22.5). PostgreSQL and MySQL
  # need a server: set SQL_POSTGRES_URL / SQL_MYSQL_URL yourself, and COCKROACH_URL or COCKROACH_DOCKER for
  # CockroachDB (see test/README.md; the CI job starts the servers itself).
  npm install --silent "${sqlite_pkg}"
}

install_prisma() {
  echo "Installing the Prisma $1 CLI into ${target}/prisma$1" >&2
  mkdir -p "${target}/prisma$1"
  cd "${target}/prisma$1"
  [ -f package.json ] || npm init -y > /dev/null
  npm install --silent "prisma@$1"
}

# Each function runs in its own background subshell, so its `cd` does not leak.
if want typeorm; then in_background typeorm install_typeorm; fi
if want ajv; then in_background ajv install_ajv; fi
if want drizzle; then in_background drizzle install_drizzle; fi
if want sequelize; then in_background sequelize install_sequelize; fi
if want zod; then in_background zod install_zod; fi
if want sql; then in_background sql install_sql; fi
if want prisma; then
  in_background prisma6 install_prisma 6
  in_background prisma7 install_prisma 7
fi

if want python; then
  echo "Installing Django and graphene-django into ${target}/venv" >&2
  python3 -m venv "${target}/venv"
  "${target}/venv/bin/pip" install --quiet django graphene-django

  echo "Installing SQLAlchemy 2 and SQLModel into ${target}/venv" >&2
  # The SQLAlchemy parser and emitter tests (SQLALCHEMY_PYTHON) load the models with the real libraries, so they share the
  # virtual environment with Django.
  "${target}/venv/bin/pip" install --quiet "sqlalchemy>=2" sqlmodel
fi

if want dotnet; then
  echo "Preparing the .NET SDK and the EF Core 8 packages (SQLite and Npgsql providers) in ${target}/efcore" >&2
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
fi

if want java; then
  echo "Preparing Maven and the Hibernate ORM 6 and H2 packages in ${target}/jpa" >&2
  java_bin="${JAVA:-$(command -v java || true)}"
  mvn_bin="${MVN:-$(command -v mvn || true)}"
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
      # The writer's javax style runs against Hibernate 5 (pom-javax.xml); its packages go into the same repository.
      cp "${here}/jpa-verify/pom-javax.xml" "${scratch}/pom.xml"
      if (
        cd "${scratch}"
        JAVA_HOME="${java_home}" "${mvn_bin}" -B -q -Dmaven.repo.local="${target}/jpa/m2" \
          package dependency:build-classpath -Dmdep.outputFile="${scratch}/cp5.txt" >&2
      ); then
        jpa_ready="yes"
      else
        echo "Resolving the Hibernate 5 packages with Maven failed; the JPA verification tests will be skipped." >&2
      fi
    else
      echo "Resolving the Hibernate packages with Maven failed; the JPA verification tests will be skipped." >&2
    fi
    rm -rf "${scratch}"
  else
    echo "Java 17 and Maven were not found ('apt-get install openjdk-17-jdk maven' works on Ubuntu); the JPA verification tests will be skipped." >&2
  fi
fi

wait_for_npm

# Neo4j needs a server, which this script does not install. With Docker, NEO4J_DOCKER=1 starts and removes a
# throwaway neo4j:5-community container; otherwise set NEO4J_URL, NEO4J_USER and NEO4J_PASSWORD (see test/README.md).
# The hint is only for a full install; the CI jobs name their components and start the servers themselves.
if [ -n "${everything}" ]; then
  if command -v docker > /dev/null 2>&1; then
    echo "Neo4j: docker found. Run the Neo4j tests with NEO4J_DOCKER=1 (neo4j:5-community), or set NEO4J_URL." >&2
  else
    echo "Neo4j: docker not found. Set NEO4J_URL (with NEO4J_USER and NEO4J_PASSWORD) to run the Neo4j tests; they skip themselves otherwise." >&2
  fi
fi

if want python; then
  echo "export DJANGO_PYTHON=${target}/venv/bin/python"
  echo "export SQLALCHEMY_PYTHON=${target}/venv/bin/python"
fi
if want typeorm; then echo "export TYPEORM_DIR=${target}/typeorm"; fi
if want drizzle; then echo "export DRIZZLE_DIR=${target}/drizzle"; fi
if want sequelize; then echo "export SEQUELIZE_DIR=${target}/sequelize"; fi
if want ajv; then echo "export AJV_DIR=${target}/ajv"; fi
if want zod; then echo "export ZOD_DIR=${target}/zod"; fi
if want sql; then echo "export SQL_DIR=${target}/sql"; fi
if want prisma; then
  echo "export PRISMA6_BIN=${target}/prisma6/node_modules/.bin/prisma"
  echo "export PRISMA7_BIN=${target}/prisma7/node_modules/.bin/prisma"
fi
if [ -n "${efcore_ready}" ]; then
  echo "export EFCORE_DIR=${target}/efcore"
  echo "export DOTNET=${dotnet_bin}"
fi
if [ -n "${jpa_ready}" ]; then
  echo "export JPA_DIR=${target}/jpa"
  echo "export MVN=${mvn_bin}"
  echo "export JAVA=${java_bin}"
fi
