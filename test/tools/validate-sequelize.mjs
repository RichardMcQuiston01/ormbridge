// Loads Sequelize models with the real library, creates their tables in an in-memory SQLite database
// (sequelize.sync) and prints what the database and Sequelize's query interface report, as JSON.
//
// Usage: node validate-sequelize.mjs <SEQUELIZE_DIR> <entry module>
//
// SEQUELIZE_DIR is a directory where `npm install sequelize@6 sqlite3` has been run. The entry module
// (CommonJS, or TypeScript compiled to CommonJS) exports a Sequelize instance, or an object with a
// `sequelize` property, whose models are defined and associated. It finds `sequelize` (and
// `sequelize-typescript`) through a node_modules directory next to it, which the test links to SEQUELIZE_DIR.
//
// Output: { tables: { [table]: { columns, primaryKey, indexes, foreignKeys } } }
// (see sequelize-introspect.mjs for the shape of a table)
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { findSequelize, introspect } from './sequelize-introspect.mjs';

const [sequelizeDir, entry] = process.argv.slice(2);
if (!sequelizeDir || !entry) {
  throw new Error(
    'Usage: validate-sequelize.mjs <SEQUELIZE_DIR> <entry module>'
  );
}
const require = createRequire(join(sequelizeDir, 'package.json'));
const { QueryTypes } = require('sequelize');

async function main() {
  const sequelize = findSequelize(require(resolve(entry)));
  if (sequelize === undefined) {
    throw new Error(
      'The entry module must export a Sequelize instance or an object with a "sequelize" property.'
    );
  }
  await sequelize.sync({ force: true });
  process.stdout.write(JSON.stringify(await introspect(sequelize, QueryTypes)));
  await sequelize.close();
}

main().catch((error) => {
  process.stderr.write(`${error && error.stack ? error.stack : error}\n`);
  process.exit(1);
});
