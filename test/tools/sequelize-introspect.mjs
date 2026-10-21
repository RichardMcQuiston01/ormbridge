// What the Sequelize verification scripts share: reading the tables that `sequelize.sync()` created in an
// in-memory SQLite database back through Sequelize's query interface and the SQLite PRAGMAs.
//
// Output: { tables: { [table]: { columns, primaryKey, indexes, foreignKeys } } }
//   columns:     [{ name, allowNull, primaryKey, type, defaultValue }]  (queryInterface.describeTable)
//   primaryKey:  column names in key order          (PRAGMA table_info)
//   indexes:     [{ name, unique, origin, columns }] (PRAGMA index_list and index_info)
//   foreignKeys: [{ column, table, to, onDelete, onUpdate }] (PRAGMA foreign_key_list)

/** Finds the Sequelize instance a loaded entry module exports. */
export function findSequelize(loaded) {
  if (loaded && typeof loaded.sync === 'function' && loaded.models) {
    return loaded;
  }
  for (const key of ['sequelize', 'default']) {
    const candidate = loaded && loaded[key];
    if (candidate && typeof candidate.sync === 'function') {
      return candidate;
    }
  }
  return undefined;
}

export async function introspect(sequelize, QueryTypes) {
  const pragma = (statement) =>
    sequelize.query(statement, { type: QueryTypes.SELECT });
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
      type: info.type,
      defaultValue: info.defaultValue === undefined ? null : info.defaultValue,
    }));
    const info = await pragma(`PRAGMA table_info('${name}')`);
    const primaryKey = info
      .filter((column) => column.pk > 0)
      .sort((first, second) => first.pk - second.pk)
      .map((column) => column.name);

    const indexList = await pragma(`PRAGMA index_list('${name}')`);
    const indexes = [];
    for (const index of indexList) {
      const columnsInfo = await pragma(`PRAGMA index_info('${index.name}')`);
      indexes.push({
        name: index.name,
        unique: index.unique === 1,
        origin: index.origin,
        columns: columnsInfo
          .sort((first, second) => first.seqno - second.seqno)
          .map((column) => column.name),
      });
    }

    const foreign = await pragma(`PRAGMA foreign_key_list('${name}')`);
    const foreignKeys = foreign.map((key) => ({
      column: key.from,
      table: key.table,
      to: key.to,
      onDelete: key.on_delete,
      onUpdate: key.on_update,
    }));
    tables[name] = { columns, primaryKey, indexes, foreignKeys };
  }
  return { tables };
}
