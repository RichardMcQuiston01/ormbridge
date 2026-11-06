// Loads Sequelize 7 (`@sequelize/core`) models with the real library and the SQL Server dialect (`@sequelize/mssql`)
// and prints the statements `sequelize.sync()` would run against SQL Server, plus the associations the models
// declare, as JSON. No SQL Server is needed and none is contacted: the Sequelize instance is only constructed (the
// dialect connects when the first query runs), and `queryRaw` is replaced by a function that records the statement
// and answers with no rows, so the DDL text comes from the dialect's own query generator (`createTableQuery`,
// `addIndex`, ...) exactly as `sync()` builds it.
//
// Usage: node generate-sequelize7-mssql.mjs <SEQUELIZE7_DIR> <entry module>
//
// SEQUELIZE7_DIR is a directory where `npm install @sequelize/core @sequelize/mssql` has been run. The entry module
// (CommonJS, or TypeScript compiled to CommonJS with experimental decorators) exports `models`, an array of model
// classes, as for validate-sequelize7.mjs.
//
// Output: { statements, associations }
//   statements:   the CREATE TABLE, CREATE INDEX and ALTER TABLE texts in the order `sync()` sends them
//   associations: [{ model, as, type }]   (Model.associations)
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import process from 'node:process';

const [sequelizeDir, entry] = process.argv.slice(2);
if (!sequelizeDir || !entry) {
  throw new Error(
    'Usage: generate-sequelize7-mssql.mjs <SEQUELIZE7_DIR> <entry module>'
  );
}
const require = createRequire(join(sequelizeDir, 'package.json'));
const { Sequelize } = require('@sequelize/core');
const { MsSqlDialect } = require('@sequelize/mssql');

/** The statements that create something; the DROPs of `force` and the catalog queries of `sync()` are not DDL to check. */
const DDL =
  /\b(?:CREATE\s+(?:UNIQUE\s+)?(?:(?:NON)?CLUSTERED\s+)?(?:TABLE|INDEX)|ALTER\s+TABLE)\b/i;

/**
 * Leaves out the `CREATE INDEX` of an index that `CREATE TABLE` already made as a named UNIQUE constraint. A real
 * `sync()` asks the server for the indexes of the table (`showIndex`) and skips the ones that exist, by name; the
 * recording `queryRaw` answers with no rows, so it would send them twice.
 */
function withoutIndexesOfConstraints(list) {
  const constraints = new Set();
  for (const text of list) {
    if (/\bCREATE\s+TABLE\b/i.test(text)) {
      for (const match of text.matchAll(
        /CONSTRAINT\s+\[([^\]]+)\]\s+UNIQUE\b/gi
      )) {
        constraints.add(match[1]);
      }
    }
  }
  return list.filter((text) => {
    const index = /^\s*CREATE\s+UNIQUE\s+INDEX\s+\[([^\]]+)\]/i.exec(text);
    return index === null || !constraints.has(index[1]);
  });
}

async function main() {
  const loaded = require(resolve(entry));
  const models = loaded.models;
  if (!Array.isArray(models) || models.length === 0) {
    throw new Error(
      'The entry module must export "models", an array of model classes.'
    );
  }
  const sequelize = new Sequelize({
    dialect: MsSqlDialect,
    server: 'localhost',
    database: 'ormbridge',
    authentication: {
      type: 'default',
      options: { userName: 'sa', password: 'unused' },
    },
    // Setting the version keeps Sequelize from asking the server for it.
    databaseVersion: '16.0.0',
    models,
    logging: false,
  });
  const statements = [];
  sequelize.queryRaw = async (sql) => {
    const text = typeof sql === 'string' ? sql : String(sql.query ?? sql);
    statements.push(text);
    return [];
  };
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
  process.stdout.write(
    JSON.stringify({
      statements: withoutIndexesOfConstraints(
        statements.filter((text) => DDL.test(text))
      ),
      associations,
    })
  );
}

main().catch((error) => {
  process.stderr.write(`${error && error.stack ? error.stack : error}\n`);
  for (let cause = error?.cause; cause; cause = cause.cause) {
    process.stderr.write(`Caused by: ${cause.message ?? cause}\n`);
  }
  process.exit(1);
});
