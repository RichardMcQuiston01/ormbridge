'use strict';

module.exports = {
  up: (queryInterface, Sequelize) => {
    return queryInterface
      .createTable('Posts', {
        id: {
          allowNull: false,
          autoIncrement: true,
          primaryKey: true,
          type: Sequelize.INTEGER,
        },
        userId: {
          type: Sequelize.INTEGER,
          allowNull: false,
          references: { model: 'Users', key: 'id' },
          onUpdate: 'CASCADE',
          onDelete: 'CASCADE',
        },
        title: {
          type: Sequelize.STRING(200),
          allowNull: false,
        },
        body: Sequelize.TEXT,
        published: {
          type: Sequelize.BOOLEAN,
          allowNull: false,
          defaultValue: false,
        },
        views: {
          type: Sequelize.INTEGER,
          defaultValue: 0,
        },
        createdAt: { allowNull: false, type: Sequelize.DATE },
        updatedAt: { allowNull: false, type: Sequelize.DATE },
      })
      .then(() => queryInterface.addIndex('Posts', ['userId']));
  },

  down: (queryInterface) => queryInterface.dropTable('Posts'),
};
