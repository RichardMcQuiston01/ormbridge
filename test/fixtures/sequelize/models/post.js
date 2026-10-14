'use strict';

module.exports = (sequelize, DataTypes) => {
  const Post = sequelize.define(
    'Post',
    {
      publicId: {
        type: DataTypes.UUID,
        allowNull: false,
        unique: true,
        defaultValue: DataTypes.UUIDV4,
      },
      title: {
        type: DataTypes.STRING(200),
        allowNull: false,
      },
      body: {
        type: DataTypes.TEXT,
        allowNull: false,
      },
      status: {
        type: DataTypes.ENUM('draft', 'published'),
        allowNull: false,
        defaultValue: 'draft',
      },
      rating: DataTypes.DECIMAL(4, 2),
      viewCount: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
      },
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
      metadata: {
        type: DataTypes.JSON,
        allowNull: false,
        defaultValue: {},
      },
      // Declared here, so Sequelize completes it instead of adding it (and keeps allowNull: false).
      authorId: {
        type: DataTypes.INTEGER,
        allowNull: false,
      },
    },
    {
      tableName: 'blog_post',
      underscored: true,
      indexes: [
        { fields: ['title'] },
        { fields: ['author_id', 'title'], unique: true },
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
      foreignKey: { name: 'editorId', allowNull: true },
      onDelete: 'SET NULL',
    });
    Post.belongsTo(models.Category, {
      foreignKey: { name: 'categoryId', allowNull: false },
      onDelete: 'RESTRICT',
    });
    Post.belongsToMany(models.Tag, {
      through: 'blog_post_tags',
      as: 'tags',
      foreignKey: 'post_id',
      otherKey: 'tag_id',
      timestamps: false,
    });
  };

  return Post;
};
