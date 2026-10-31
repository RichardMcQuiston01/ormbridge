// Loads Sequelize 7 (`@sequelize/core`) models with the real library, creates their tables in a scratch database
// of a real PostgreSQL or MySQL server (`sequelize.sync()`), reads the database back through the system catalogs
// (`pg_catalog` for PostgreSQL, `information_schema` for MySQL) and prints what it holds, plus the associations
// the models declare, as JSON. The scratch database (named by the caller, who also drops it if this process is killed) is dropped at the end.
//
// Usage: node validate-sequelize7-server.mjs <SEQUELIZE7_DIR> <entry module> <postgres|mysql> <server URL> <scratch database>
//
// SEQUELIZE7_DIR is a directory where `npm install @sequelize/core @sequelize/postgres @sequelize/mysql` has been
// run. The server URL is SQL_POSTGRES_URL or SQL_MYSQL_URL (user, password, host and port are used; the database
// of the URL is only where the scratch database is created from). The entry module is the one of
// validate-sequelize7.mjs: it exports `models`, and the script builds the Sequelize instance itself with the
// dialect class of the chosen package.
//
// Output: { tables, associations }, the shape of validate-sequelize7.mjs
//   tables:       { [table]: { columns, primaryKey, indexes, foreignKeys } }
//     columns:     [{ name, allowNull, primaryKey, type, defaultValue }]
//                  (type: `format_type` / COLUMN_TYPE, lower case; defaultValue: the default expression or null)
//     primaryKey:  column names in key order
//     indexes:     [{ name, unique, origin, columns }]   (origin `pk` for the primary key, `c` otherwise)
//     foreignKeys: [{ column, table, to, onDelete, onUpdate }]   (one entry per column; actions in upper case)
//   associations: [{ model, as, type }]
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { URL } from 'node:url';

const [sequelizeDir, entry, kind, serverUrl, scratch] = process.argv.slice(2);
if (!sequelizeDir || !entry || !kind || !serverUrl || !scratch) {
  throw new Error(
    'Usage: validate-sequelize7-server.mjs <SEQUELIZE7_DIR> <entry module> <postgres|mysql> <server URL>'
  );
}
const require = createRequire(join(sequelizeDir, 'package.json'));
const { Sequelize, QueryTypes } = require('@sequelize/core');

const POSTGRES_ACTIONS = {
  a: 'NO ACTION',
  r: 'RESTRICT',
  c: 'CASCADE',
  n: 'SET NULL',
  d: 'SET DEFAULT',
};

/** The Sequelize options that connect to `database` on the server of the URL. */
function connection(database) {
  const url = new URL(serverUrl);
  const common = {
    host: url.hostname,
    port: url.port === '' ? undefined : Number(url.port),
    user: decodeURIComponent(url.username === '' ? 'root' : url.username),
    password: decodeURIComponent(url.password),
    database,
  };
  if (kind === 'postgres') {
    const { PostgresDialect } = require('@sequelize/postgres');
    return { dialect: PostgresDialect, ...common };
  }
  const { MySqlDialect } = require('@sequelize/mysql');
  return { dialect: MySqlDialect, ...common };
}

/** Runs a SELECT and returns its rows. */
function rows(sequelize, statement) {
  return sequelize.query(statement, { type: QueryTypes.SELECT });
}

function groupByTable(list) {
  const grouped = new Map();
  for (const item of list) {
    if (!grouped.has(item.table)) {
      grouped.set(item.table, []);
    }
    grouped.get(item.table).push(item);
  }
  return grouped;
}

/** An enum column as MySQL spells its type, `enum('a','b')`, or undefined for any other column. */
function enumType(type, enums) {
  // The type name may carry its schema (audit.enum_role) and quotes.
  const name = type.replace(/\[\]$/, '').replace(/^.*\./, '').replace(/"/g, '');
  const labels = enums.get(name);
  return labels === undefined
    ? undefined
    : `enum(${labels.map((label) => `'${label}'`).join(',')})${type.endsWith('[]') ? '[]' : ''}`;
}

/** Reads the tables of the PostgreSQL schemas (the models can name several) from the catalogs. */
async function introspectPostgres(sequelize) {
  const scope = `n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast') AND c.relkind = 'r'`;
  const columns = await rows(
    sequelize,
    `SELECT c.relname AS "table", a.attname AS name, NOT a.attnotnull AS "allowNull",
       format_type(a.atttypid, a.atttypmod) AS type, pg_get_expr(d.adbin, d.adrelid) AS "defaultValue",
       a.attidentity AS identity
     FROM pg_attribute a
     JOIN pg_class c ON c.oid = a.attrelid
     JOIN pg_namespace n ON n.oid = c.relnamespace
     LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
     WHERE ${scope} AND a.attnum > 0 AND NOT a.attisdropped
     ORDER BY c.relname, a.attnum`
  );
  const keys = await rows(
    sequelize,
    `SELECT c.relname AS "table", con.contype AS kind, con.confdeltype AS "onDelete", con.confupdtype AS "onUpdate",
       rc.relname AS "refTable",
       (SELECT json_agg(a.attname ORDER BY k.ord) FROM unnest(con.conkey) WITH ORDINALITY k(attnum, ord)
          JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum) AS columns,
       (SELECT json_agg(a.attname ORDER BY k.ord) FROM unnest(con.confkey) WITH ORDINALITY k(attnum, ord)
          JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.attnum) AS "refColumns"
     FROM pg_constraint con
     JOIN pg_class c ON c.oid = con.conrelid
     JOIN pg_namespace n ON n.oid = c.relnamespace
     LEFT JOIN pg_class rc ON rc.oid = con.confrelid
     WHERE ${scope} AND con.contype IN ('p', 'f')`
  );
  const indexes = await rows(
    sequelize,
    `SELECT c.relname AS "table", i.relname AS name, x.indisunique AS "unique", x.indisprimary AS "primary",
       (SELECT json_agg(a.attname ORDER BY k.ord) FROM unnest(x.indkey::int2[]) WITH ORDINALITY k(attnum, ord)
          JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.attnum) AS columns
     FROM pg_index x
     JOIN pg_class c ON c.oid = x.indrelid
     JOIN pg_class i ON i.oid = x.indexrelid
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE ${scope}`
  );
  const enums = new Map(
    (
      await rows(
        sequelize,
        `SELECT t.typname AS name, json_agg(e.enumlabel ORDER BY e.enumsortorder) AS labels
         FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid GROUP BY t.typname`
      )
    ).map((row) => [row.name, row.labels])
  );
  const tables = {};
  const keysByTable = groupByTable(keys);
  const indexesByTable = groupByTable(indexes);
  for (const [name, list] of groupByTable(columns)) {
    const keyList = keysByTable.get(name) ?? [];
    const primaryKey = keyList.find((key) => key.kind === 'p')?.columns ?? [];
    tables[name] = {
      columns: list.map((column) => ({
        name: column.name,
        allowNull: column.allowNull,
        primaryKey: primaryKey.includes(column.name),
        type: enumType(column.type, enums) ?? column.type.toLowerCase(),
        // An identity column has no default expression; report it like SERIAL does.
        defaultValue:
          column.defaultValue ?? (column.identity === '' ? null : 'identity'),
      })),
      primaryKey,
      indexes: (indexesByTable.get(name) ?? []).map((index) => ({
        name: index.name,
        unique: index.unique,
        origin: index.primary ? 'pk' : 'c',
        columns: index.columns ?? [],
      })),
      foreignKeys: keyList
        .filter((key) => key.kind === 'f')
        .flatMap((key) =>
          key.columns.map((column, position) => ({
            column,
            table: key.refTable,
            to: key.refColumns[position],
            onDelete: POSTGRES_ACTIONS[key.onDelete],
            onUpdate: POSTGRES_ACTIONS[key.onUpdate],
          }))
        ),
    };
  }
  return tables;
}

/** Reads the tables of the current MySQL database from information_schema. */
async function introspectMysql(sequelize) {
  const columns = await rows(
    sequelize,
    `SELECT TABLE_NAME AS \`table\`, COLUMN_NAME AS name, IS_NULLABLE = 'YES' AS allowNull,
       COLUMN_TYPE AS type, COLUMN_DEFAULT AS defaultValue, EXTRA AS extra, COLUMN_KEY AS columnKey
     FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() ORDER BY TABLE_NAME, ORDINAL_POSITION`
  );
  const keys = await rows(
    sequelize,
    `SELECT k.TABLE_NAME AS \`table\`, k.CONSTRAINT_NAME AS constraintName, t.CONSTRAINT_TYPE AS kind,
       k.COLUMN_NAME AS \`column\`, k.ORDINAL_POSITION AS position, k.REFERENCED_TABLE_NAME AS refTable,
       k.REFERENCED_COLUMN_NAME AS refColumn, r.DELETE_RULE AS onDelete, r.UPDATE_RULE AS onUpdate
     FROM information_schema.KEY_COLUMN_USAGE k
     JOIN information_schema.TABLE_CONSTRAINTS t ON t.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA
       AND t.TABLE_NAME = k.TABLE_NAME AND t.CONSTRAINT_NAME = k.CONSTRAINT_NAME
     LEFT JOIN information_schema.REFERENTIAL_CONSTRAINTS r ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA
       AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME AND r.TABLE_NAME = k.TABLE_NAME
     WHERE k.TABLE_SCHEMA = DATABASE() AND t.CONSTRAINT_TYPE IN ('PRIMARY KEY', 'FOREIGN KEY')
     ORDER BY k.TABLE_NAME, k.CONSTRAINT_NAME, k.ORDINAL_POSITION`
  );
  const statistics = await rows(
    sequelize,
    `SELECT TABLE_NAME AS \`table\`, INDEX_NAME AS name, NON_UNIQUE = 0 AS \`unique\`, COLUMN_NAME AS \`column\`,
       SEQ_IN_INDEX AS position
     FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX`
  );
  const tables = {};
  const keysByTable = groupByTable(keys);
  const statisticsByTable = groupByTable(statistics);
  for (const [name, list] of groupByTable(columns)) {
    const keyList = keysByTable.get(name) ?? [];
    const primaryKey = keyList
      .filter((key) => key.kind === 'PRIMARY KEY')
      .map((key) => key.column);
    const foreignKeys = keyList.filter((key) => key.kind === 'FOREIGN KEY');
    // The columns of each foreign key, by constraint name.
    const foreignColumns = new Map();
    for (const key of foreignKeys) {
      foreignColumns.set(key.constraintName, [
        ...(foreignColumns.get(key.constraintName) ?? []),
        key.column,
      ]);
    }
    const byIndex = new Map();
    for (const part of statisticsByTable.get(name) ?? []) {
      if (!byIndex.has(part.name)) {
        byIndex.set(part.name, {
          name: part.name,
          unique: Boolean(part.unique),
          columns: [],
        });
      }
      byIndex.get(part.name).columns.push(part.column);
    }
    tables[name] = {
      columns: list.map((column) => ({
        name: column.name,
        allowNull: Boolean(column.allowNull),
        primaryKey: primaryKey.includes(column.name),
        // The type keyword in lower case; the members of an enum keep their case.
        type: column.type.replace(/^[a-z]+/i, (keyword) =>
          keyword.toLowerCase()
        ),
        defaultValue:
          column.defaultValue ??
          (column.extra.includes('auto_increment') ? 'auto_increment' : null),
      })),
      primaryKey,
      // MySQL creates a plain index over the columns of a foreign key that has none, named like the constraint or
      // like its first column; it is not something the models asked for.
      indexes: [...byIndex.values()]
        .filter(
          (index) =>
            index.name === 'PRIMARY' ||
            index.unique ||
            ![...foreignColumns].some(
              ([constraintName, columns]) =>
                columns.join(',') === index.columns.join(',') &&
                (index.name === constraintName || index.name === columns[0])
            )
        )
        .map((index) => ({
          name: index.name,
          unique: index.unique,
          origin: index.name === 'PRIMARY' ? 'pk' : 'c',
          columns: index.columns,
        })),
      foreignKeys: foreignKeys.map((key) => ({
        column: key.column,
        table: key.refTable,
        to: key.refColumn,
        onDelete: key.onDelete,
        onUpdate: key.onUpdate,
      })),
    };
  }
  return tables;
}

async function main() {
  const loaded = require(resolve(entry));
  const models = loaded.models;
  if (!Array.isArray(models) || models.length === 0) {
    throw new Error(
      'The entry module must export "models", an array of model classes.'
    );
  }
  const admin = new Sequelize({
    ...connection(kind === 'postgres' ? 'postgres' : undefined),
    logging: false,
  });
  const quoted = kind === 'mysql' ? `\`${scratch}\`` : `"${scratch}"`;
  await admin.query(`CREATE DATABASE ${quoted}`);
  try {
    const sequelize = new Sequelize({
      ...connection(scratch),
      models,
      logging: false,
    });
    try {
      if (kind === 'postgres') {
        await sequelize.query('CREATE EXTENSION IF NOT EXISTS hstore');
        // A model with a `schema` option (Prisma `@@schema`) needs that schema to exist; sync() does not create it.
        const schemas = new Set(
          models.map((model) => model.table.schema).filter(Boolean)
        );
        for (const schema of schemas) {
          await sequelize.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
        }
      }
      await sequelize.sync({ force: true });
      const associations = [];
      for (const model of models) {
        for (const [as, association] of Object.entries(model.associations)) {
          associations.push({
            model: model.name,
            as,
            type: association.associationType,
          });
        }
      }
      const tables =
        kind === 'postgres'
          ? await introspectPostgres(sequelize)
          : await introspectMysql(sequelize);
      process.stdout.write(JSON.stringify({ tables, associations }));
    } finally {
      await sequelize.close();
    }
  } finally {
    await admin.query(`DROP DATABASE IF EXISTS ${quoted}`);
    await admin.close();
  }
}

main().catch((error) => {
  process.stderr.write(`${error && error.stack ? error.stack : error}\n`);
  for (let cause = error?.cause; cause; cause = cause.cause) {
    process.stderr.write(`Caused by: ${cause.message ?? cause}\n`);
  }
  process.exit(1);
});
