// Loads Sequelize 7 (`@sequelize/core`) models with the real library, creates their tables in a SQLite file
// (`sequelize.sync()`), reads the file back with the SQLite PRAGMAs and prints what the database holds, plus
// the associations the models declare, as JSON.
//
// Usage: node validate-sequelize7.mjs <SEQUELIZE7_DIR> <entry module>
//
// SEQUELIZE7_DIR is a directory where `npm install @sequelize/core @sequelize/sqlite3` has been run. The entry
// module (CommonJS, or TypeScript compiled to CommonJS with experimental decorators) exports `models`, an array
// of model classes; the script builds the Sequelize instance itself:
// `new Sequelize({ dialect: SqliteDialect, storage, models })`. It finds `@sequelize/core` through a
// node_modules directory next to the module, which the test links to SEQUELIZE7_DIR.
//
// Output: { tables, associations }
//   tables:       { [table]: { columns, primaryKey, indexes, foreignKeys } }
//     columns:     [{ name, allowNull, primaryKey, type, defaultValue }]  (PRAGMA table_info)
//     primaryKey:  column names in key order
//     indexes:     [{ name, unique, origin, columns }]                    (PRAGMA index_list and index_info)
//     foreignKeys: [{ column, table, to, onDelete, onUpdate }]            (PRAGMA foreign_key_list)
//   associations: [{ model, as, type }]                                   (Model.associations)
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';

const [sequelizeDir, entry] = process.argv.slice(2);
if (!sequelizeDir || !entry) {
  throw new Error(
    'Usage: validate-sequelize7.mjs <SEQUELIZE7_DIR> <entry module>'
  );
}
const require = createRequire(join(sequelizeDir, 'package.json'));
const { Sequelize } = require('@sequelize/core');
const { SqliteDialect } = require('@sequelize/sqlite3');
const sqlite3 = require('sqlite3');

/** Runs a query on a sqlite3 database and resolves with all rows. */
function all(database, statement) {
  return new Promise((resolveRows, reject) => {
    database.all(statement, (error, rows) =>
      error ? reject(error) : resolveRows(rows)
    );
  });
}

/** Reads the tables of a SQLite file with the PRAGMAs. */
async function introspect(file) {
  const database = new sqlite3.Database(file);
  try {
    const names = (
      await all(
        database,
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
      )
    ).map((row) => row.name);
    const tables = {};
    for (const name of names) {
      const info = await all(database, `PRAGMA table_info('${name}')`);
      const columns = info.map((column) => ({
        name: column.name,
        allowNull: column.notnull === 0,
        primaryKey: column.pk > 0,
        type: column.type,
        defaultValue: column.dflt_value,
      }));
      const primaryKey = info
        .filter((column) => column.pk > 0)
        .sort((first, second) => first.pk - second.pk)
        .map((column) => column.name);
      const indexes = [];
      for (const index of await all(database, `PRAGMA index_list('${name}')`)) {
        const parts = await all(database, `PRAGMA index_info('${index.name}')`);
        indexes.push({
          name: index.name,
          unique: index.unique === 1,
          origin: index.origin,
          columns: parts
            .sort((first, second) => first.seqno - second.seqno)
            .map((part) => part.name),
        });
      }
      const foreignKeys = (
        await all(database, `PRAGMA foreign_key_list('${name}')`)
      ).map((key) => ({
        column: key.from,
        table: key.table,
        to: key.to,
        onDelete: key.on_delete,
        onUpdate: key.on_update,
      }));
      tables[name] = { columns, primaryKey, indexes, foreignKeys };
    }
    return tables;
  } finally {
    database.close();
  }
}

async function main() {
  const loaded = require(resolve(entry));
  const models = loaded.models;
  if (!Array.isArray(models) || models.length === 0) {
    throw new Error(
      'The entry module must export "models", an array of model classes.'
    );
  }
  const directory = mkdtempSync(join(tmpdir(), 'ormbridge-sequelize7-'));
  try {
    const storage = join(directory, 'database.sqlite');
    const sequelize = new Sequelize({
      dialect: SqliteDialect,
      storage,
      models,
      logging: false,
    });
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
    await sequelize.close();
    process.stdout.write(
      JSON.stringify({ tables: await introspect(storage), associations })
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${error && error.stack ? error.stack : error}\n`);
  for (let cause = error?.cause; cause; cause = cause.cause) {
    process.stderr.write(`Caused by: ${cause.message ?? cause}\n`);
  }
  process.exit(1);
});
