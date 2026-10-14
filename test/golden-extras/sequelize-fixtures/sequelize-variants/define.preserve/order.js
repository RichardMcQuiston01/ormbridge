'use strict';

module.exports = (sequelize, DataTypes) => {
  const Order = sequelize.define(
    'Order',
    {
      id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
      total: { type: DataTypes.DECIMAL(10, 2), allowNull: false },
      auditorId: DataTypes.INTEGER,
      AccountId: DataTypes.INTEGER,
      buyerId: DataTypes.INTEGER,
      referrerEmail: DataTypes.STRING(120),
    },
    { tableName: 'Orders', timestamps: false }
  );

  Order.associate = (models) => {
    Order.belongsTo(models.Account, {
      as: 'account',
      foreignKey: 'AccountId',
      onDelete: 'SET NULL',
    });
    Order.belongsTo(models.Account, {
      as: 'buyer',
      foreignKey: 'buyerId',
      onDelete: 'SET NULL',
    });
    Order.belongsTo(models.Account, {
      as: 'referrer',
      foreignKey: 'referrerEmail',
      targetKey: 'email',
      onDelete: 'RESTRICT',
    });
  };

  return Order;
};
