'use strict';

module.exports = (sequelize, DataTypes) => {
  const BlogUser = sequelize.define(
    'BlogUser',
    {
      id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    },
    { tableName: 'blog_user', timestamps: false }
  );

  BlogUser.associate = (models) => {
    BlogUser.hasMany(models.BlogPost, {
      as: 'author_blog_posts',
      foreignKey: 'author_id',
      onDelete: 'CASCADE',
    });
    BlogUser.hasMany(models.BlogPost, {
      as: 'editor_blog_posts',
      foreignKey: 'editor_id',
      onDelete: 'SET NULL',
    });
    BlogUser.hasOne(models.BlogProfile, {
      as: 'blog_profile',
      foreignKey: 'user_id',
      onDelete: 'CASCADE',
    });
  };

  return BlogUser;
};
