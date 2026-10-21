'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('gadgets', {
      id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
      title: { type: Sequelize.STRING(50), allowNull: false },
      price: { type: Sequelize.DECIMAL(8, 2) },
      color: { type: Sequelize.STRING(20) },
      stock: { type: Sequelize.INTEGER, defaultValue: 0 },
      sku: { type: Sequelize.STRING(16), allowNull: false },
    });
    await queryInterface.createTable('legacy_things', {
      id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
      v: Sequelize.STRING,
    });
    await queryInterface.createTable('sprockets', {
      id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
      n: Sequelize.INTEGER,
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('sprockets');
    await queryInterface.dropTable('legacy_things');
    await queryInterface.dropTable('gadgets');
  },
};
