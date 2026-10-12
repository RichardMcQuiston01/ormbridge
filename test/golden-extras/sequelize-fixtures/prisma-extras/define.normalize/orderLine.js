'use strict';

module.exports = (sequelize, DataTypes) => {
  const OrderLine = sequelize.define(
    'OrderLine',
    {
      id: {
        type: DataTypes.UUID,
        primaryKey: true,
        defaultValue: DataTypes.UUIDV4,
      },
      orderRegion: { type: DataTypes.STRING, allowNull: false },
      orderNumber: { type: DataTypes.INTEGER, allowNull: false },
      sku: { type: DataTypes.STRING(32), allowNull: false },
    },
    {
      tableName: 'order_line',
      schema: 'public',
      timestamps: true,
      underscored: true,
      indexes: [
        { fields: ['order_region', 'order_number'] },
      ],
    }
  );

  return OrderLine;
};
