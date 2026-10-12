'use strict';

module.exports = (sequelize, DataTypes) => {
  const Order = sequelize.define(
    'Order',
    {
      region: { type: DataTypes.STRING, primaryKey: true },
      number: { type: DataTypes.INTEGER, primaryKey: true },
      total: { type: DataTypes.DECIMAL, allowNull: false },
    },
    {
      tableName: 'order',
      schema: 'public',
      timestamps: true,
      underscored: true,
    }
  );

  return Order;
};
