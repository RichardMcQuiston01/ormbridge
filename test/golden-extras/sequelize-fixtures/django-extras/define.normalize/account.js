'use strict';

module.exports = (sequelize, DataTypes) => {
  const Account = sequelize.define(
    'Account',
    {
      id: {
        type: DataTypes.UUID,
        primaryKey: true,
        defaultValue: DataTypes.UUIDV4,
      },
      email: { type: DataTypes.STRING(254), allowNull: false, unique: true },
    },
    { tableName: 'account', timestamps: true, underscored: true }
  );

  return Account;
};
