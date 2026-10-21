'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.renameTable('Tags', 'Labels');
    await queryInterface.removeIndex('Posts', ['userId']);
    await queryInterface.addIndex('Posts', ['userId', 'published'], {
      name: 'posts_user_published',
    });
    await queryInterface.changeColumn('Notes', 'text', {
      type: Sequelize.TEXT,
      allowNull: false,
    });
    await queryInterface.createTable('Scratch', {
      id: { type: Sequelize.INTEGER, primaryKey: true },
    });
    await queryInterface.dropTable('Scratch');
    await queryInterface.bulkInsert('Labels', [
      { label: 'news' },
      { label: 'tech' },
    ]);
    await queryInterface.sequelize.query(
      'UPDATE "Users" SET "role" = \'reader\''
    );
  },

  async down(queryInterface) {
    await queryInterface.renameTable('Labels', 'Tags');
  },
};
