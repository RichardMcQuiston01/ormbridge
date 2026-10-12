'use strict';

module.exports = (sequelize, DataTypes) => {
  const Assignment = sequelize.define(
    'Assignment',
    {
      item_id: { type: DataTypes.INTEGER, primaryKey: true },
      account_id: { type: DataTypes.INTEGER, primaryKey: true },
    },
    { tableName: 'blog_assignment', timestamps: false }
  );

  Assignment.associate = (models) => {
    Assignment.belongsTo(models.Item, {
      as: 'item',
      foreignKey: 'item_id',
      onDelete: 'CASCADE',
    });
    Assignment.belongsTo(models.Account, {
      as: 'account',
      foreignKey: 'account_id',
      onDelete: 'CASCADE',
    });
  };

  return Assignment;
};
