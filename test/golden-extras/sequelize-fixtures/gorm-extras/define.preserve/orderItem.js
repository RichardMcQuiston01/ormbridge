'use strict';

module.exports = (sequelize, DataTypes) => {
  const OrderItem = sequelize.define(
    'OrderItem',
    {
      lineNo: { type: DataTypes.INTEGER, primaryKey: true },
      quantity: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
      product_sku: { type: DataTypes.STRING(40), allowNull: false },
      order_id: { type: DataTypes.UUID, primaryKey: true },
    },
    { tableName: 'order_items', timestamps: false, underscored: true }
  );

  OrderItem.associate = (models) => {
    OrderItem.belongsTo(models.Product, {
      as: 'product',
      foreignKey: 'product_sku',
      onDelete: 'NO ACTION',
    });
    OrderItem.belongsTo(models.Order, {
      as: 'order',
      foreignKey: 'order_id',
      onDelete: 'NO ACTION',
    });
  };

  return OrderItem;
};
