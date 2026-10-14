'use strict';

module.exports = (sequelize, DataTypes) => {
  const Post = sequelize.define(
    'Post',
    {
      id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
      title: { type: DataTypes.STRING(200), allowNull: false },
      slug: { type: DataTypes.STRING(120), allowNull: false },
      status: { type: DataTypes.STRING(20), defaultValue: 'draft' },
      publishedAt: DataTypes.DATE,
      authorId: { type: DataTypes.INTEGER, allowNull: false },
      categoryId: DataTypes.INTEGER,
    },
    {
      tableName: 'posts',
      timestamps: true,
      indexes: [
        { fields: ['title'] },
        { name: 'posts_author_slug', unique: true, fields: ['slug', 'authorId'] },
        { name: 'posts_status_idx', fields: ['status', 'publishedAt'] },
      ],
    }
  );

  Post.associate = (models) => {
    Post.belongsTo(models.Author, {
      as: 'author',
      foreignKey: 'authorId',
      onDelete: 'CASCADE',
    });
    Post.belongsTo(models.Category, {
      as: 'category',
      foreignKey: 'categoryId',
      onDelete: 'SET NULL',
    });
  };

  return Post;
};
