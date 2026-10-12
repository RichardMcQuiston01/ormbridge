'use strict';

module.exports = (sequelize, DataTypes) => {
  const BlogTag = sequelize.define(
    'BlogTag',
    {
      id: {
        type: DataTypes.UUID,
        primaryKey: true,
        defaultValue: DataTypes.UUIDV4,
      },
      label: { type: DataTypes.STRING(50), allowNull: false },
    },
    { tableName: 'blog_tag', timestamps: true, underscored: true }
  );

  BlogTag.associate = (models) => {
    BlogTag.belongsToMany(models.BlogPost, {
      as: 'blogPosts',
      through: 'blog_post_tags',
      foreignKey: 'blog_tag_id',
      otherKey: 'blog_post_id',
      timestamps: false,
    });
  };

  return BlogTag;
};
