'use strict';

module.exports = (sequelize, DataTypes) => {
  const Membership = sequelize.define(
    'Membership',
    {
      role: { type: DataTypes.STRING(20), defaultValue: 'member' },
      accountId: { type: DataTypes.UUID, primaryKey: true },
      groupId: { type: DataTypes.UUID, primaryKey: true },
    },
    { tableName: 'membership', timestamps: true, underscored: true }
  );

  Membership.associate = (models) => {
    Membership.belongsTo(models.Account, {
      as: 'account',
      foreignKey: 'accountId',
      onDelete: 'CASCADE',
    });
    Membership.belongsTo(models.Group, {
      as: 'group',
      foreignKey: 'groupId',
      onDelete: 'CASCADE',
    });
  };

  return Membership;
};
