// Loads Sequelize models that ormbridge wrote for PostgreSQL, MySQL or SQL Server with the real library and prints
// the CREATE TABLE statement Sequelize builds for each model, as JSON. No database server is needed: the
// statements are only generated, which is enough to see that every data type, default and key exists in the dialect.
//
// Usage: node generate-sequelize-sql.mjs <SEQUELIZE_DIR> <postgres|mysql|mssql> <index module>
//
// SEQUELIZE_DIR is a directory where `npm install sequelize@6` and the driver of the dialect (`pg pg-hstore`,
// `mysql2` or `tedious`) have been run. The index module exports `initModels(sequelize)`.
//
// Output: { tables: { [table]: "CREATE TABLE ..." }, errors: [string] }
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import process from 'node:process';

const [sequelizeDir, dialect, entry] = process.argv.slice(2);
if (!sequelizeDir || !dialect || !entry) {
  throw new Error(
    'Usage: generate-sequelize-sql.mjs <SEQUELIZE_DIR> <postgres|mysql|mssql> <index module>'
  );
}
const require = createRequire(join(sequelizeDir, 'package.json'));
const { Sequelize } = require('sequelize');

const URLS = {
  postgres: 'postgres://user:secret@localhost:5432/app',
  mysql: 'mysql://user:secret@localhost:3306/app',
  mssql: 'mssql://user:secret@localhost:1433/app',
};
if (URLS[dialect] === undefined) {
  throw new Error(`Unknown dialect "${dialect}".`);
}

const sequelize = new Sequelize(URLS[dialect], { logging: false, dialect });
require(resolve(entry)).initModels(sequelize);
const generator = sequelize.getQueryInterface().queryGenerator;
const tables = {};
const errors = [];
for (const model of Object.values(sequelize.models)) {
  const table = model.getTableName();
  const name = typeof table === 'string' ? table : table.tableName;
  try {
    const attributes = {};
    for (const [attribute, definition] of Object.entries(model.rawAttributes)) {
      attributes[definition.field || attribute] = definition;
    }
    tables[name] = String(
      generator.createTableQuery(
        table,
        generator.attributesToSQL(attributes, {
          context: 'createTable',
          table,
        }),
        model.options
      )
    ).replace(/\s+/g, ' ');
  } catch (error) {
    errors.push(`${name}: ${error && error.message ? error.message : error}`);
  }
}
process.stdout.write(JSON.stringify({ tables, errors }));
