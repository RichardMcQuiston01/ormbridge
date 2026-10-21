'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    const transaction = await queryInterface.sequelize.transaction();
    try {
      await queryInterface.addColumn(
        'Users',
        'bio',
        { type: Sequelize.TEXT },
        { transaction }
      );
      await queryInterface.addColumn(
        'Posts',
        'slug',
        { type: Sequelize.STRING(80), allowNull: true },
        { transaction }
      );
      await queryInterface.addColumn(
        'Posts',
        'rating',
        { type: Sequelize.DECIMAL(4, 2), defaultValue: 0 },
        { transaction }
      );
      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('Posts', 'rating');
    await queryInterface.removeColumn('Posts', 'slug');
    await queryInterface.removeColumn('Users', 'bio');
  },
};
