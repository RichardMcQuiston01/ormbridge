'use strict';

module.exports = (sequelize, DataTypes) => {
  const BlogPost = sequelize.define(
    'BlogPost',
    {
      id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
      updated_at: { type: DataTypes.DATE, allowNull: false },
      public_id: {
        type: DataTypes.UUID,
        allowNull: false,
        unique: true,
        defaultValue: DataTypes.UUIDV4,
      },
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
      tableName: 'blog_post',
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: false,
      indexes: [
        {
          name: 'blog_post_author_id_title_key',
          unique: true,
          fields: ['author_id', 'title'],
        },
        { name: 'blog_post_title_idx', fields: ['title'] },
        { name: 'post_pub_status_idx', fields: ['published_at', 'status'] },
      ],
    }
  );

  BlogPost.associate = (models) => {
    BlogPost.belongsTo(models.BlogUser, {
      as: 'author',
      foreignKey: 'author_id',
      onDelete: 'CASCADE',
    });
    BlogPost.belongsTo(models.BlogUser, {
      as: 'editor',
      foreignKey: 'editor_id',
      onDelete: 'SET NULL',
    });
    BlogPost.belongsTo(models.BlogCategory, {
      as: 'category',
      foreignKey: 'category_id',
      onDelete: 'RESTRICT',
    });
    BlogPost.belongsToMany(models.BlogTag, {
      as: 'tags',
      through: 'blog_post_tags',
      foreignKey: 'blog_post_id',
      otherKey: 'blog_tag_id',
      timestamps: false,
    });
  };

  return BlogPost;
};
