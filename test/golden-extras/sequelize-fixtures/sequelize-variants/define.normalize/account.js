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
      legacyCode: DataTypes.STRING(8),
      lastSeen: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
    },
    { tableName: 'account', timestamps: true, underscored: true }
  );

  Account.associate = (models) => {
    Account.hasMany(models.Order, {
      as: 'orders',
      foreignKey: 'accountId',
      onDelete: 'SET NULL',
    });
  };

  return Account;
};
