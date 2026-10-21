'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('Tags', {
      id: {
        allowNull: false,
        autoIncrement: true,
        primaryKey: true,
        type: Sequelize.INTEGER,
      },
      label: { type: Sequelize.STRING(40), allowNull: false },
    });
    await queryInterface.createTable('PostTags', {
      postId: {
        type: Sequelize.INTEGER,
        primaryKey: true,
        references: { model: 'Posts', key: 'id' },
        onDelete: 'CASCADE',
      },
      tagId: {
        type: Sequelize.INTEGER,
        primaryKey: true,
        references: { model: 'Tags', key: 'id' },
        onDelete: 'CASCADE',
      },
    });
    await queryInterface.createTable('Notes', {
      id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
      text: { type: Sequelize.STRING(100), allowNull: false },
    });
    await queryInterface.addConstraint('Tags', {
      fields: ['label'],
      type: 'unique',
      name: 'tags_label_uq',
    });
    await queryInterface.addIndex('Posts', {
      fields: ['slug'],
      unique: true,
      name: 'posts_slug_unique',
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('PostTags');
    await queryInterface.dropTable('Tags');
  },
};
