'use strict';

module.exports = (sequelize, DataTypes) => {
  const Account = sequelize.define(
    'Account',
    {
      id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
      email: {
        type: DataTypes.STRING(120),
        allowNull: false,
        unique: 'account_email_unique',
      },
      balance: {
        type: DataTypes.DECIMAL(10, 2),
        allowNull: false,
        defaultValue: 0,
      },
      settings: { type: DataTypes.JSONB, defaultValue: {} },
      nickname: DataTypes.STRING(255),
      legacyCode: { type: DataTypes.STRING(8), field: 'legacy_code' },
      lastSeen: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
    },
    { tableName: 'Accounts', timestamps: true }
  );

  Account.associate = (models) => {
    Account.hasMany(models.Order, {
      as: 'orders',
      foreignKey: 'AccountId',
      onDelete: 'SET NULL',
    });
  };

  return Account;
};
