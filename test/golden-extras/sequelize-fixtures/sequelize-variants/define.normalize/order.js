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
      total: { type: DataTypes.DECIMAL(10, 2), allowNull: false },
      auditorId: DataTypes.INTEGER,
      accountId: DataTypes.UUID,
      buyerId: DataTypes.UUID,
      referrerEmail: DataTypes.STRING(120),
    },
    { tableName: 'order', timestamps: true, underscored: true }
  );

  Order.associate = (models) => {
    Order.belongsTo(models.Account, {
      as: 'account',
      foreignKey: 'accountId',
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
