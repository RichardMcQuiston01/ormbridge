'use strict';

module.exports = (sequelize, DataTypes) => {
  const Comment = sequelize.define(
    'Comment',
    {
      id: {
        type: DataTypes.UUID,
        primaryKey: true,
        defaultValue: DataTypes.UUIDV4,
      },
      body: { type: DataTypes.TEXT, allowNull: false },
      ownerId: { type: DataTypes.BIGINT, allowNull: false },
      ownerType: { type: DataTypes.STRING(30), allowNull: false },
    },
    { tableName: 'comment', timestamps: true, underscored: true }
  );

  return Comment;
};
