'use strict';

// A .cjs file, a transaction callback with Promise.all, and a helper function that receives the query
// interface.
async function addAudit(queryInterface, Sequelize) {
  await queryInterface.addColumn('accounts', 'note', Sequelize.TEXT);
}

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.createTable(
        'transfers',
        {
          id: {
            type: Sequelize.INTEGER,
            primaryKey: true,
            autoIncrement: true,
          },
          from_account: {
            type: Sequelize.BIGINT,
            allowNull: false,
            references: { model: 'accounts', key: 'id' },
            onDelete: 'RESTRICT',
          },
          to_account: {
            type: Sequelize.BIGINT,
            allowNull: true,
            references: { model: { tableName: 'accounts' }, key: 'id' },
            onDelete: 'SET NULL',
          },
          amount: { type: Sequelize.DECIMAL(12, 2), allowNull: false },
        },
        { transaction }
      );
      await Promise.all([
        queryInterface.addIndex('transfers', ['from_account'], { transaction }),
        queryInterface.addIndex('transfers', ['to_account'], {
          name: 'transfers_target',
          transaction,
        }),
      ]);
    });
    await addAudit(queryInterface, Sequelize);
  },

  down: async (queryInterface) => {
    await queryInterface.dropTable('transfers');
    await queryInterface.removeColumn('accounts', 'note');
  },
};
