'use strict';

module.exports = (sequelize, DataTypes) => {
  const PostTags = sequelize.define(
    'PostTags',
    {
      id: { type: DataTypes.INTEGER, primaryKey: true },
      post_id: { type: DataTypes.INTEGER, allowNull: false },
      tag_id: { type: DataTypes.INTEGER, allowNull: false },
    },
    { tableName: 'PostTags', timestamps: false }
  );

  return PostTags;
};
