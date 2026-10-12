'use strict';

module.exports = (sequelize, DataTypes) => {
  const Post = sequelize.define(
    'Post',
    {
      updatedAt: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.NOW,
      },
      id: {
        type: DataTypes.UUID,
        primaryKey: true,
        defaultValue: DataTypes.UUIDV4,
      },
      publicId: {
        type: DataTypes.UUID,
        allowNull: false,
        unique: true,
        defaultValue: DataTypes.UUIDV4,
      },
      title: { type: DataTypes.STRING(200), allowNull: false },
      body: { type: DataTypes.TEXT, allowNull: false, defaultValue: '' },
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
      authorId: { type: DataTypes.UUID, allowNull: false },
      editorId: DataTypes.UUID,
      categoryId: { type: DataTypes.UUID, allowNull: false },
    },
    {
      tableName: 'post',
      timestamps: true,
      updatedAt: false,
      underscored: true,
      indexes: [
        { unique: true, fields: ['author_id', 'title'] },
        { fields: ['title'] },
        { name: 'post_pub_status_idx', fields: ['published_at', 'status'] },
      ],
    }
  );

  Post.associate = (models) => {
    Post.belongsTo(models.User, {
      as: 'author',
      foreignKey: 'authorId',
      onDelete: 'CASCADE',
    });
    Post.belongsTo(models.User, {
      as: 'editor',
      foreignKey: 'editorId',
      onDelete: 'SET NULL',
    });
    Post.belongsTo(models.Category, {
      as: 'category',
      foreignKey: 'categoryId',
      onDelete: 'RESTRICT',
    });
    Post.belongsToMany(models.Tag, {
      as: 'tags',
      through: 'post_tags',
      foreignKey: 'post_id',
      otherKey: 'tag_id',
      timestamps: false,
    });
  };

  return Post;
};
