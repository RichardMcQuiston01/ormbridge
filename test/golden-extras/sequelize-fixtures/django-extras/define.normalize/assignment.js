'use strict';

module.exports = (sequelize, DataTypes) => {
  const Assignment = sequelize.define(
    'Assignment',
    {
      itemId: { type: DataTypes.UUID, primaryKey: true },
      accountId: { type: DataTypes.UUID, primaryKey: true },
    },
    { tableName: 'assignment', timestamps: true, underscored: true }
  );

  Assignment.associate = (models) => {
    Assignment.belongsTo(models.Item, {
      as: 'item',
      foreignKey: 'itemId',
      onDelete: 'CASCADE',
    });
    Assignment.belongsTo(models.Account, {
      as: 'account',
      foreignKey: 'accountId',
      onDelete: 'CASCADE',
    });
  };

  return Assignment;
};
