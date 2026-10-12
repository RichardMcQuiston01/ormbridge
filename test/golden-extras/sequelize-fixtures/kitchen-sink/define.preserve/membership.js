'use strict';

module.exports = (sequelize, DataTypes) => {
  const Membership = sequelize.define(
    'Membership',
    {
      role: { type: DataTypes.ENUM('owner', 'member'), allowNull: false },
      account_id: { type: DataTypes.BIGINT, primaryKey: true },
      group_id: { type: DataTypes.INTEGER, primaryKey: true },
    },
    { tableName: 'memberships', timestamps: false }
  );

  Membership.associate = (models) => {
    Membership.belongsTo(models.Account, {
      as: 'account',
      foreignKey: 'account_id',
      onDelete: 'CASCADE',
    });
    Membership.belongsTo(models.Group, {
      as: 'group',
      foreignKey: 'group_id',
      onDelete: 'RESTRICT',
    });
  };

  return Membership;
};
