'use strict';

module.exports = (sequelize, DataTypes) => {
  const PostTag = sequelize.define(
    'PostTag',
    {
      post_id: { type: DataTypes.INTEGER, primaryKey: true },
      tag_id: { type: DataTypes.INTEGER, primaryKey: true },
    },
    { tableName: 'blog_post_tags', timestamps: false }
  );

  PostTag.associate = (models) => {
    PostTag.belongsTo(models.Post, {
      as: 'post',
      foreignKey: 'post_id',
      onDelete: 'CASCADE',
    });
    PostTag.belongsTo(models.Tag, {
      as: 'tag',
      foreignKey: 'tag_id',
      onDelete: 'CASCADE',
    });
  };

  return PostTag;
};
