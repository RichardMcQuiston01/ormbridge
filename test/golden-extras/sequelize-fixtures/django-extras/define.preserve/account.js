'use strict';

module.exports = (sequelize, DataTypes) => {
  const Account = sequelize.define(
    'Account',
    {
      id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
      email: { type: DataTypes.STRING(254), allowNull: false, unique: true },
    },
    { tableName: 'blog_account', timestamps: false }
  );

  return Account;
};
