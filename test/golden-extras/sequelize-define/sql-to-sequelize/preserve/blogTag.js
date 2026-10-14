'use strict';

module.exports = (sequelize, DataTypes) => {
  const BlogTag = sequelize.define(
    'BlogTag',
    {
      id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
      label: { type: DataTypes.STRING(50), allowNull: false },
    },
    { tableName: 'blog_tag', timestamps: false }
  );

  BlogTag.associate = (models) => {
    BlogTag.belongsToMany(models.BlogPost, {
      as: 'blog_posts',
      through: 'blog_post_tags',
      foreignKey: 'blog_tag_id',
      otherKey: 'blog_post_id',
      timestamps: false,
    });
  };

  return BlogTag;
};
