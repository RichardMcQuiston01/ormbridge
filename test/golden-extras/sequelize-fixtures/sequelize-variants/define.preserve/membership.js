'use strict';

module.exports = (sequelize, DataTypes) => {
  const Membership = sequelize.define(
    'Membership',
    {
      role: { type: DataTypes.STRING(20), defaultValue: 'member' },
      AccountId: { type: DataTypes.INTEGER, primaryKey: true },
      GroupId: { type: DataTypes.INTEGER, primaryKey: true },
    },
    { tableName: 'Memberships', timestamps: false }
  );

  Membership.associate = (models) => {
    Membership.belongsTo(models.Account, {
      as: 'account',
      foreignKey: 'AccountId',
      onDelete: 'CASCADE',
    });
    Membership.belongsTo(models.Group, {
      as: 'group',
      foreignKey: 'GroupId',
      onDelete: 'CASCADE',
    });
  };

  return Membership;
};
