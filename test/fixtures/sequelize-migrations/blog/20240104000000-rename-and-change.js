'use strict';

module.exports = {
  async up(queryInterface) {
    await queryInterface.renameColumn('Users', 'name', 'fullName');
    await queryInterface.removeColumn('Users', 'bio');
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.addColumn('Users', 'bio', Sequelize.TEXT);
  },
};
