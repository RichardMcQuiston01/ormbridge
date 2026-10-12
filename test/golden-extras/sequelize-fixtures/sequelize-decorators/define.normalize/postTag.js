'use strict';

module.exports = (sequelize, DataTypes) => {
  const PostTag = sequelize.define(
    'PostTag',
    {
      postId: { type: DataTypes.UUID, primaryKey: true },
      tagId: { type: DataTypes.UUID, primaryKey: true },
    },
    { tableName: 'post_tag', timestamps: true, underscored: true }
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
