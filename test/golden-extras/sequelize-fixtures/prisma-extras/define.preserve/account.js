'use strict';

module.exports = (sequelize, DataTypes) => {
  const Account = sequelize.define(
    'Account',
    {
      id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
      email: {
        type: DataTypes.STRING,
        allowNull: false,
        unique: 'uq_account_email',
      },
      tenantId: { type: DataTypes.INTEGER, allowNull: false },
    },
    { tableName: 'Account', schema: 'public', timestamps: false }
  );

  Account.associate = (models) => {
    Account.belongsTo(models.Tenant, {
      as: 'tenant',
      foreignKey: 'tenantId',
      onDelete: 'NO ACTION',
    });
    Account.hasOne(models.Profile, {
      as: 'profile',
      foreignKey: 'accountId',
      onDelete: 'RESTRICT',
    });
  };

  return Account;
};
