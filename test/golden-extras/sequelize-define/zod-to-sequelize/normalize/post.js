'use strict';

module.exports = (sequelize, DataTypes) => {
  const Post = sequelize.define(
    'Post',
    {
      id: { type: DataTypes.INTEGER, primaryKey: true },
      updatedAt: { type: DataTypes.DATE, allowNull: false },
      publicId: { type: DataTypes.UUID, allowNull: false },
      title: { type: DataTypes.STRING(200), allowNull: false },
      body: { type: DataTypes.TEXT, allowNull: false },
      status: {
        type: DataTypes.ENUM('draft', 'published'),
        allowNull: false,
        defaultValue: 'draft',
      },
      rating: DataTypes.DECIMAL(4, 2),
      viewCount: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      isFeatured: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
      },
      publishedAt: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.NOW,
      },
      metadata: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
      authorId: { type: DataTypes.INTEGER, allowNull: false },
      editorId: DataTypes.INTEGER,
      categoryId: { type: DataTypes.INTEGER, allowNull: false },
    },
    { tableName: 'post', timestamps: true, updatedAt: false, underscored: true }
  );

  return Post;
};
