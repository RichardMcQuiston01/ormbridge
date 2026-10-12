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
        type: DataTypes.STRING,
        allowNull: false,
        unique: 'uq_account_email',
      },
      tenantId: { type: DataTypes.UUID, allowNull: false },
    },
    {
      tableName: 'account',
      schema: 'public',
      timestamps: true,
      underscored: true,
    }
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
