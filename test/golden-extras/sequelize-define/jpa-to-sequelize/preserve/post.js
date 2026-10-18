'use strict';

module.exports = (sequelize, DataTypes) => {
  const Post = sequelize.define(
    'Post',
    {
      id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
      publicId: {
        type: DataTypes.UUID,
        allowNull: false,
        unique: true,
        defaultValue: DataTypes.UUIDV4,
      },
      title: { type: DataTypes.STRING(200), allowNull: false },
      body: { type: DataTypes.TEXT, allowNull: false },
      status: {
        type: DataTypes.ENUM('Draft', 'Published'),
        allowNull: false,
        defaultValue: 'Draft',
      },
      rating: DataTypes.DECIMAL(4, 2),
      viewCount: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      featured: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
        field: 'is_featured',
      },
      publishedAt: {
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
      tableName: 'blog_post',
      timestamps: true,
      underscored: true,
      indexes: [
        {
          name: 'uniq_post_author_title',
          unique: true,
          fields: ['author_id', 'title'],
        },
        { name: 'post_title_idx', fields: ['title'] },
        { name: 'post_pub_status_idx', fields: ['published_at', 'status'] },
      ],
    }
  );

  Post.associate = (models) => {
    Post.belongsTo(models.User, {
      as: 'author',
      foreignKey: 'author_id',
      onDelete: 'CASCADE',
    });
    Post.belongsTo(models.User, {
      as: 'editor',
      foreignKey: 'editor_id',
      onDelete: 'SET NULL',
    });
    Post.belongsTo(models.Category, {
      as: 'category',
      foreignKey: 'category_id',
      onDelete: 'RESTRICT',
    });
    Post.belongsToMany(models.Tag, {
      as: 'tags',
      through: 'blog_post_tags',
      foreignKey: 'post_id',
      otherKey: 'tag_id',
      timestamps: false,
    });
  };

  return Post;
};
