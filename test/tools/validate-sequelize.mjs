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
//   columns:     [{ name, allowNull, primaryKey }]  (queryInterface.describeTable)
//   primaryKey:  column names in key order          (PRAGMA table_info)
//   indexes:     [{ name, unique, origin, columns }] (PRAGMA index_list and index_info)
//   foreignKeys: [{ column, table, to, onDelete, onUpdate }] (PRAGMA foreign_key_list)
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import process from 'node:process';

const [sequelizeDir, entry] = process.argv.slice(2);
if (!sequelizeDir || !entry) {
  throw new Error(
    'Usage: validate-sequelize.mjs <SEQUELIZE_DIR> <entry module>'
  );
}
const require = createRequire(join(sequelizeDir, 'package.json'));
const { QueryTypes } = require('sequelize');

function pragma(sequelize, statement) {
  return sequelize.query(statement, { type: QueryTypes.SELECT });
}

function findSequelize(loaded) {
  if (loaded && typeof loaded.sync === 'function' && loaded.models) {
    return loaded;
  }
  for (const key of ['sequelize', 'default']) {
    const candidate = loaded && loaded[key];
    if (candidate && typeof candidate.sync === 'function') {
      return candidate;
    }
  }
  throw new Error(
    'The entry module must export a Sequelize instance or an object with a "sequelize" property.'
  );
}

async function main() {
  const sequelize = findSequelize(require(resolve(entry)));
  await sequelize.sync({ force: true });
  const queryInterface = sequelize.getQueryInterface();
  const names = (await queryInterface.showAllTables())
    .map((table) => (typeof table === 'string' ? table : table.tableName))
    .filter((name) => !name.startsWith('sqlite_'))
    .sort();

  const tables = {};
  for (const name of names) {
    const described = await queryInterface.describeTable(name);
    const columns = Object.entries(described).map(([column, info]) => ({
      name: column,
      allowNull: info.allowNull,
      primaryKey: info.primaryKey,
    }));
    const info = await pragma(sequelize, `PRAGMA table_info('${name}')`);
    const primaryKey = info
      .filter((column) => column.pk > 0)
      .sort((first, second) => first.pk - second.pk)
      .map((column) => column.name);

    const indexList = await pragma(sequelize, `PRAGMA index_list('${name}')`);
    const indexes = [];
    for (const index of indexList) {
      const columnsInfo = await pragma(
        sequelize,
        `PRAGMA index_info('${index.name}')`
      );
      indexes.push({
        name: index.name,
        unique: index.unique === 1,
        origin: index.origin,
        columns: columnsInfo
          .sort((first, second) => first.seqno - second.seqno)
          .map((column) => column.name),
      });
    }

    const foreign = await pragma(
      sequelize,
      `PRAGMA foreign_key_list('${name}')`
    );
    const foreignKeys = foreign.map((key) => ({
      column: key.from,
      table: key.table,
      to: key.to,
      onDelete: key.on_delete,
      onUpdate: key.on_update,
    }));
    tables[name] = { columns, primaryKey, indexes, foreignKeys };
  }
  process.stdout.write(JSON.stringify({ tables }));
  await sequelize.close();
}

main().catch((error) => {
  process.stderr.write(`${error && error.stack ? error.stack : error}\n`);
  process.exit(1);
});
