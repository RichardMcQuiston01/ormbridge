'use strict';

module.exports = (sequelize, DataTypes) => {
  const OrderLine = sequelize.define(
    'OrderLine',
    {
      id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
      orderRegion: { type: DataTypes.STRING, allowNull: false },
      orderNumber: { type: DataTypes.INTEGER, allowNull: false },
      sku: { type: DataTypes.STRING(32), allowNull: false },
    },
    {
      tableName: 'OrderLine',
      schema: 'public',
      timestamps: false,
      indexes: [
        { fields: ['orderRegion', 'orderNumber'] },
      ],
    }
  );

  return OrderLine;
};
