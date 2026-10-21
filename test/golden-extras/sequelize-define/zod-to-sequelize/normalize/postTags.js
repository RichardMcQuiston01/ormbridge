'use strict';

module.exports = (sequelize, DataTypes) => {
  const PostTags = sequelize.define(
    'PostTags',
    {
      id: { type: DataTypes.INTEGER, primaryKey: true },
      postId: { type: DataTypes.INTEGER, allowNull: false },
      tagId: { type: DataTypes.INTEGER, allowNull: false },
    },
    { tableName: 'post_tag', timestamps: true, underscored: true }
  );

  return PostTags;
};
