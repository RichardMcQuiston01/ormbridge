// Loads the Sequelize models that ormbridge wrote with the real library and exercises them in an in-memory
// SQLite database: it creates the tables with `sequelize.sync()`, reads them back (tables, columns, keys,
// indexes, foreign keys), then inserts sample rows through the models and the associations and reports what
// happened, as JSON.
//
// Usage: node validate-sequelize-emitter.mjs <SEQUELIZE_DIR> <index module>
//
// SEQUELIZE_DIR is a directory where `npm install sequelize@6 sqlite3` has been run. The index module is the
// `index.js` of the `define` style, or the compiled `index.ts` of the `init` style: both export
// `initModels(sequelize)`, which is called with a fresh in-memory SQLite connection. `sequelize` is found
// through a node_modules directory next to the module, which the test links to SEQUELIZE_DIR.
//
// Output: { tables, exercise }
//   tables:   see sequelize-introspect.mjs
//   exercise: {
//     rows:         { [table]: { [column]: value } }         the first row created through each model (raw)
//     foreignKeys:  [{ table, column, enforced, onDelete }]  inserting a missing parent fails; deleting a
//                                                             parent: 'cascade', 'setNull', 'restrict' (refused)
//     unique:       [{ table, columns, rejected }]           a second row with the same single unique value
//     enums:        [{ table, column, rejected }]            a value outside the ENUM
//     associations: [{ model, as, type, ok }]                include (belongsTo, hasMany, hasOne) and add/count
//                                                             (belongsToMany) through the association
//     errors:       [string]                                 anything that threw unexpectedly
//   }
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { introspect } from './sequelize-introspect.mjs';

const [sequelizeDir, entry] = process.argv.slice(2);
if (!sequelizeDir || !entry) {
  throw new Error(
    'Usage: validate-sequelize-emitter.mjs <SEQUELIZE_DIR> <index module>'
  );
}
const require = createRequire(join(sequelizeDir, 'package.json'));
const { Sequelize, QueryTypes } = require('sequelize');

let counter = 0;

function sampleValue(attribute) {
  counter += 1;
  const key = attribute.type.key;
  switch (key) {
    case 'STRING':
    case 'CHAR': {
      const length = attribute.type.options?.length ?? attribute.type._length;
      const text = `s${counter}`;
      return length === undefined ? text : text.slice(-length);
    }
    case 'TEXT':
    case 'CITEXT':
      return `text ${counter}`;
    case 'INTEGER':
    case 'BIGINT':
    case 'SMALLINT':
    case 'MEDIUMINT':
    case 'TINYINT':
      return counter;
    case 'FLOAT':
    case 'DOUBLE':
    case 'REAL':
      return counter + 0.5;
    case 'DECIMAL':
      return `${counter}.5`;
    case 'BOOLEAN':
      return true;
    case 'DATE':
      return new Date(Date.UTC(2024, 0, 1, 12, 0, counter % 60));
    case 'DATEONLY':
      return '2024-01-02';
    case 'TIME':
      return '12:34:56';
    case 'UUID':
      return randomUUID();
    case 'JSON':
    case 'JSONB':
      return { sample: counter };
    case 'BLOB':
      return Buffer.from(`blob${counter}`);
    case 'ENUM':
      return attribute.values[0];
    case 'INET':
      return '10.0.0.1';
    default:
      throw new Error(`No sample value for the ${key} type.`);
  }
}

function tableOf(model) {
  const name = model.getTableName();
  return typeof name === 'string' ? name : name.tableName;
}

function modelForTable(sequelize, table) {
  return Object.values(sequelize.models).find(
    (model) => tableOf(model) === table
  );
}

/** The attribute of a model that stores a column. */
function attributeForColumn(model, column) {
  return Object.entries(model.rawAttributes).find(
    ([name, attribute]) => (attribute.field ?? name) === column
  )?.[0];
}

/** Creates a row with every required column set; required parents are created first. */
async function createRow(sequelize, model, overrides = {}, depth = 0) {
  if (depth > 5) {
    throw new Error(`${model.name}: the required foreign keys form a cycle.`);
  }
  const values = { ...overrides };
  for (const [name, attribute] of Object.entries(model.rawAttributes)) {
    if (name in values || attribute.autoIncrement) {
      continue;
    }
    if (attribute.references) {
      if (attribute.allowNull !== false && !attribute.primaryKey) {
        continue;
      }
      const ref = attribute.references;
      const table =
        typeof ref.model === 'string' ? ref.model : ref.model.tableName;
      const parentModel = modelForTable(sequelize, table);
      const parent = await createRow(sequelize, parentModel, {}, depth + 1);
      const keyName = attributeForColumn(parentModel, ref.key) ?? ref.key;
      values[name] = parent.getDataValue(keyName);
      continue;
    }
    if (attribute.defaultValue !== undefined) {
      continue;
    }
    if (attribute.allowNull !== false && !attribute.primaryKey) {
      continue;
    }
    values[name] = sampleValue(attribute);
  }
  return model.create(values);
}

/** The primary key of an instance, by attribute name. */
function whereOf(model, instance) {
  const where = {};
  for (const name of Object.keys(model.primaryKeys)) {
    where[name] = instance.getDataValue(name);
  }
  return where;
}

async function rawRow(sequelize, model, instance) {
  const where = whereOf(model, instance);
  const keys = Object.keys(where);
  const conditions = keys.map(
    (key) => `"${model.rawAttributes[key].field ?? key}" = ?`
  );
  const rows = await sequelize.query(
    `SELECT * FROM "${tableOf(model)}" WHERE ${conditions.join(' AND ')}`,
    { type: QueryTypes.SELECT, replacements: keys.map((key) => where[key]) }
  );
  return rows[0];
}

async function attempt(errors, label, action) {
  try {
    return await action();
  } catch (error) {
    errors.push(`${label}: ${error && error.message ? error.message : error}`);
    return undefined;
  }
}

async function exercise(sequelize, tables) {
  const result = {
    rows: {},
    foreignKeys: [],
    unique: [],
    enums: [],
    associations: [],
    errors: [],
  };
  const errors = result.errors;
  const models = Object.values(sequelize.models);

  for (const model of models) {
    const row = await attempt(errors, `create ${model.name}`, async () => {
      const instance = await createRow(sequelize, model);
      return rawRow(sequelize, model, instance);
    });
    if (row !== undefined) {
      result.rows[tableOf(model)] = row;
    }
  }

  // Foreign keys: a missing parent is refused, and deleting a parent does what ON DELETE says.
  for (const model of models) {
    const table = tableOf(model);
    for (const foreign of tables[table]?.foreignKeys ?? []) {
      const attribute = attributeForColumn(model, foreign.column);
      const parentModel = modelForTable(sequelize, foreign.table);
      if (attribute === undefined || parentModel === undefined) {
        continue;
      }
      let enforced = false;
      try {
        await createRow(sequelize, model, { [attribute]: 987654321 });
      } catch {
        enforced = true;
      }
      const outcome = await attempt(
        errors,
        `foreign key ${table}.${foreign.column}`,
        async () => {
          const parent = await createRow(sequelize, parentModel);
          const keyAttribute =
            attributeForColumn(parentModel, foreign.to) ?? foreign.to;
          const child = await createRow(sequelize, model, {
            [attribute]: parent.getDataValue(keyAttribute),
          });
          let refused = false;
          try {
            await sequelize.query(
              `DELETE FROM "${foreign.table}" WHERE "${foreign.to}" = ?`,
              { replacements: [parent.getDataValue(keyAttribute)] }
            );
          } catch {
            refused = true;
          }
          if (refused) {
            return 'restrict';
          }
          const remaining = await model.findOne({
            where: whereOf(model, child),
          });
          if (remaining === null) {
            return 'cascade';
          }
          return remaining.getDataValue(attribute) === null
            ? 'setNull'
            : 'kept';
        }
      );
      result.foreignKeys.push({
        table,
        column: foreign.column,
        enforced,
        onDelete: outcome ?? 'error',
      });
    }
  }

  // Single-column unique keys reject a second row with the same value.
  for (const model of models) {
    const table = tableOf(model);
    for (const index of tables[table]?.indexes ?? []) {
      if (
        !index.unique ||
        index.origin === 'pk' ||
        index.columns.length !== 1
      ) {
        continue;
      }
      const column = index.columns[0];
      const attribute = attributeForColumn(model, column);
      const sample = result.rows[table]?.[column];
      if (attribute === undefined || sample === undefined || sample === null) {
        continue;
      }
      let rejected = false;
      try {
        await createRow(sequelize, model, {
          [attribute]:
            model.rawAttributes[attribute].type.key === 'DATE'
              ? new Date(sample)
              : sample,
        });
      } catch {
        rejected = true;
      }
      result.unique.push({ table, columns: [column], rejected });
    }
  }

  // ENUM columns refuse a value that is not listed.
  for (const model of models) {
    for (const [name, attribute] of Object.entries(model.rawAttributes)) {
      if (attribute.type.key !== 'ENUM') {
        continue;
      }
      let rejected = false;
      try {
        await createRow(sequelize, model, { [name]: '__not_a_member__' });
      } catch {
        rejected = true;
      }
      result.enums.push({
        table: tableOf(model),
        column: attribute.field ?? name,
        rejected,
      });
    }
  }

  // Associations: the aliases and keys work for include, add and count.
  for (const model of models) {
    for (const association of Object.values(model.associations)) {
      const label = `${model.name}.${association.as}`;
      const type = association.associationType;
      const ok = await attempt(errors, `association ${label}`, async () => {
        if (type === 'BelongsToMany') {
          const source = await createRow(sequelize, model);
          const target = await createRow(sequelize, association.target);
          await source[association.accessors.add](target);
          return (await source[association.accessors.count]()) === 1;
        }
        if (type === 'BelongsTo') {
          const child = await createRow(sequelize, model);
          const foreignKey = association.foreignKey;
          if (child.getDataValue(foreignKey) == null) {
            const parent = await createRow(sequelize, association.target);
            await child.update({
              [foreignKey]: parent.getDataValue(association.targetKey),
            });
          }
          const loaded = await model.findOne({
            where: whereOf(model, child),
            include: [{ association: association.as }],
          });
          return loaded !== null && loaded[association.as] !== null;
        }
        const parent = await createRow(sequelize, model);
        await createRow(sequelize, association.target, {
          [association.foreignKey]: parent.getDataValue(association.sourceKey),
        });
        const loaded = await model.findOne({
          where: whereOf(model, parent),
          include: [{ association: association.as }],
        });
        const value = loaded?.[association.as];
        return Array.isArray(value) ? value.length === 1 : value != null;
      });
      result.associations.push({
        model: model.name,
        as: association.as,
        type,
        ok: ok === true,
      });
    }
  }
  return result;
}

async function main() {
  const loaded = require(resolve(entry));
  if (typeof loaded.initModels !== 'function') {
    throw new Error('The index module must export initModels(sequelize).');
  }
  const sequelize = new Sequelize({
    dialect: 'sqlite',
    storage: ':memory:',
    logging: false,
    // Checks values against their data type, which is what rejects a value outside an ENUM.
    typeValidation: true,
  });
  loaded.initModels(sequelize);
  await sequelize.sync({ force: true });
  const database = await introspect(sequelize, QueryTypes);
  const run = await exercise(sequelize, database.tables);
  process.stdout.write(JSON.stringify({ ...database, exercise: run }));
  await sequelize.close();
}

main().catch((error) => {
  process.stderr.write(`${error && error.stack ? error.stack : error}\n`);
  process.exit(1);
});
