'use strict';

module.exports = (sequelize, DataTypes) => {
  const BlogUser = sequelize.define(
    'BlogUser',
    {
      id: {
        type: DataTypes.UUID,
        primaryKey: true,
        defaultValue: DataTypes.UUIDV4,
      },
    },
    { tableName: 'blog_user', timestamps: true, underscored: true }
  );

  BlogUser.associate = (models) => {
    BlogUser.hasMany(models.BlogPost, {
      as: 'authorBlogPosts',
      foreignKey: 'authorId',
      onDelete: 'CASCADE',
    });
    BlogUser.hasMany(models.BlogPost, {
      as: 'editorBlogPosts',
      foreignKey: 'editorId',
      onDelete: 'SET NULL',
    });
    BlogUser.hasOne(models.BlogProfile, {
      as: 'blogProfile',
      foreignKey: 'userId',
      onDelete: 'CASCADE',
    });
  };

  return BlogUser;
};
