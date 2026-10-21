'use strict';

module.exports = (sequelize, DataTypes) => {
  const User = sequelize.define(
    'User',
    {
      id: { type: DataTypes.INTEGER, primaryKey: true },
    },
    { tableName: 'user', timestamps: true, underscored: true }
  );

  return User;
};
