'use strict';

module.exports = (sequelize, DataTypes) => {
  const Order = sequelize.define(
    'Order',
    {
      id: {
        type: DataTypes.UUID,
        primaryKey: true,
        defaultValue: DataTypes.UUIDV4,
      },
      placedAt: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.NOW,
      },
      modifiedAt: { type: DataTypes.BIGINT, allowNull: false },
      total: { type: DataTypes.DECIMAL(12, 2), allowNull: false },
      note: { type: DataTypes.STRING(500), allowNull: false },
      customerId: { type: DataTypes.UUID, allowNull: false },
    },
    {
      tableName: 'order',
      timestamps: true,
      underscored: true,
      indexes: [
        {
          name: 'idx_order_customer_placed',
          fields: ['customer_id', { name: 'placed_at', order: 'DESC' }],
        },
      ],
    }
  );

  Order.associate = (models) => {
    Order.belongsTo(models.Customer, {
      as: 'customer',
      foreignKey: 'customerId',
      onDelete: 'RESTRICT',
    });
    Order.belongsToMany(models.Label, {
      as: 'labels',
      through: 'order_labels',
      foreignKey: 'order_id',
      otherKey: 'label_id',
      timestamps: false,
    });
    Order.hasMany(models.OrderItem, {
      as: 'items',
      foreignKey: 'orderId',
      onDelete: 'NO ACTION',
    });
  };

  return Order;
};
