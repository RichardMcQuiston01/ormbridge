'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('people', {
      id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
      email: { type: Sequelize.STRING(100), allowNull: false },
      nickname: { type: Sequelize.STRING(30) },
    });
    await queryInterface.createTable('projects', {
      code: { type: Sequelize.STRING(12), allowNull: false },
      title: { type: Sequelize.STRING(100), allowNull: false },
      owner_id: { type: Sequelize.INTEGER, allowNull: false },
      reviewer_id: { type: Sequelize.INTEGER },
    });
    await queryInterface.createTable('memberships', {
      person_id: { type: Sequelize.INTEGER, allowNull: false },
      project_code: { type: Sequelize.STRING(12), allowNull: false },
      since: { type: Sequelize.DATEONLY },
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('memberships');
    await queryInterface.dropTable('projects');
    await queryInterface.dropTable('people');
  },
};
