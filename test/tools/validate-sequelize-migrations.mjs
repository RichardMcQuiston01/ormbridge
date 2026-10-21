// Runs a folder of sequelize-cli migrations with the real `sequelize-cli db:migrate` against a SQLite file and
// prints what the database holds afterwards, as JSON.
//
// Usage: node validate-sequelize-migrations.mjs <SEQUELIZE_DIR> <migrations directory>
//
// SEQUELIZE_DIR is a directory where `npm install sequelize@6 sqlite3 sequelize-cli` has been run. The
// migrations are CommonJS files (a `package.json` with "type": "commonjs" next to them keeps a project that
// is a module from loading them as one). sequelize-cli applies them in file-name order, the way a project
// does with `npx sequelize-cli db:migrate`.
//
// Output: { tables: { [table]: { columns, primaryKey, indexes, foreignKeys } } }, the SequelizeMeta table
// left out (see sequelize-introspect.mjs for the shape of a table).
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { introspect } from './sequelize-introspect.mjs';

const [sequelizeDir, migrations] = process.argv.slice(2);
if (!sequelizeDir || !migrations) {
  throw new Error(
    'Usage: validate-sequelize-migrations.mjs <SEQUELIZE_DIR> <migrations directory>'
  );
}
const require = createRequire(join(sequelizeDir, 'package.json'));
const { Sequelize, QueryTypes } = require('sequelize');

const work = mkdtempSync(join(tmpdir(), 'ormbridge-sequelize-cli-'));
try {
  const storage = join(work, 'database.sqlite');
  const config = join(work, 'config.json');
  writeFileSync(
    config,
    JSON.stringify({
      development: { dialect: 'sqlite', storage, logging: false },
    })
  );
  const cli = spawnSync(
    join(sequelizeDir, 'node_modules', '.bin', 'sequelize-cli'),
    [
      'db:migrate',
      '--env',
      'development',
      '--config',
      config,
      '--migrations-path',
      resolve(migrations),
    ],
    { cwd: work, encoding: 'utf8', timeout: 120_000 }
  );
  if (cli.status !== 0) {
    throw new Error(
      `sequelize-cli db:migrate failed:\n${cli.stdout}${cli.stderr}`
    );
  }
  const sequelize = new Sequelize({
    dialect: 'sqlite',
    storage,
    logging: false,
  });
  const schema = await introspect(sequelize, QueryTypes);
  delete schema.tables['SequelizeMeta'];
  process.stdout.write(JSON.stringify(schema));
  await sequelize.close();
} catch (error) {
  process.stderr.write(`${error && error.stack ? error.stack : error}\n`);
  process.exitCode = 1;
} finally {
  rmSync(work, { recursive: true, force: true });
}
