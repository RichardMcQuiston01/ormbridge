'use strict';

module.exports = (sequelize, DataTypes) => {
  const Post = sequelize.define(
    'Post',
    {
      id: { type: DataTypes.INTEGER, primaryKey: true },
      updated_at: { type: DataTypes.DATE, allowNull: false },
      public_id: { type: DataTypes.UUID, allowNull: false },
      title: { type: DataTypes.STRING(200), allowNull: false },
      body: { type: DataTypes.TEXT, allowNull: false },
      status: {
        type: DataTypes.ENUM('draft', 'published'),
        allowNull: false,
        defaultValue: 'draft',
      },
      rating: DataTypes.DECIMAL(4, 2),
      view_count: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
      },
      is_featured: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
      },
      published_at: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.NOW,
      },
      metadata: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
      author_id: { type: DataTypes.INTEGER, allowNull: false },
      editor_id: DataTypes.INTEGER,
      category_id: { type: DataTypes.INTEGER, allowNull: false },
    },
    {
      tableName: 'Post',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: false,
    }
  );

  return Post;
};
