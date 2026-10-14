'use strict';

module.exports = (sequelize, DataTypes) => {
  const Comment = sequelize.define(
    'Comment',
    {
      id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
      body: { type: DataTypes.TEXT, allowNull: false },
      ownerId: { type: DataTypes.BIGINT, allowNull: false },
      ownerType: { type: DataTypes.STRING(30), allowNull: false },
    },
    { tableName: 'comments', timestamps: false, underscored: true }
  );

  return Comment;
};
