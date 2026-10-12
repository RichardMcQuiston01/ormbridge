'use strict';

module.exports = (sequelize, DataTypes) => {
  const OrderItem = sequelize.define(
    'OrderItem',
    {
      lineNo: { type: DataTypes.INTEGER, primaryKey: true },
      quantity: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
      productSku: { type: DataTypes.STRING(40), allowNull: false },
      orderId: { type: DataTypes.UUID, primaryKey: true },
    },
    { tableName: 'order_item', timestamps: true, underscored: true }
  );

  OrderItem.associate = (models) => {
    OrderItem.belongsTo(models.Product, {
      as: 'product',
      foreignKey: 'productSku',
      onDelete: 'NO ACTION',
    });
    OrderItem.belongsTo(models.Order, {
      as: 'order',
      foreignKey: 'orderId',
      onDelete: 'NO ACTION',
    });
  };

  return OrderItem;
};
