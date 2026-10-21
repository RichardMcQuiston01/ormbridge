'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.renameColumn('gadgets', 'color', 'colour');
    await queryInterface.changeColumn('gadgets', 'title', {
      type: Sequelize.TEXT,
      allowNull: false,
    });
    await queryInterface.changeColumn('gadgets', 'price', {
      type: Sequelize.DECIMAL(10, 2),
      allowNull: false,
      defaultValue: 0,
    });
    await queryInterface.removeColumn('gadgets', 'stock');
    await queryInterface.addColumn('gadgets', 'weight', Sequelize.FLOAT);
    await queryInterface.renameTable('legacy_things', 'things');
    await queryInterface.dropTable('sprockets');
  },

  async down(queryInterface) {
    await queryInterface.renameTable('things', 'legacy_things');
  },
};
