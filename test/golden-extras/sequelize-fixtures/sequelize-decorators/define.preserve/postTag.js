'use strict';

module.exports = (sequelize, DataTypes) => {
  const PostTag = sequelize.define(
    'PostTag',
    {
      postId: { type: DataTypes.INTEGER, primaryKey: true },
      tagId: { type: DataTypes.INTEGER, primaryKey: true },
    },
    { tableName: 'post_tags', timestamps: false }
  );

  PostTag.associate = (models) => {
    PostTag.belongsTo(models.Post, {
      as: 'post',
      foreignKey: 'postId',
      onDelete: 'CASCADE',
    });
    PostTag.belongsTo(models.Tag, {
      as: 'tag',
      foreignKey: 'tagId',
      onDelete: 'CASCADE',
    });
  };

  return PostTag;
};
