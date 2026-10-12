'use strict';

module.exports = (sequelize, DataTypes) => {
  const Item = sequelize.define(
    'Item',
    {
      id: {
        type: DataTypes.UUID,
        primaryKey: true,
        defaultValue: DataTypes.UUIDV4,
      },
      firstName: { type: DataTypes.STRING(40), allowNull: false },
      lastName: { type: DataTypes.STRING(40), allowNull: false },
      fullName: { type: DataTypes.STRING(81), allowNull: false },
      quantity: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
      totalCents: { type: DataTypes.INTEGER, allowNull: false },
      tags: {
        type: DataTypes.ARRAY(DataTypes.STRING(20)),
        allowNull: false,
        defaultValue: [],
      },
      grid: DataTypes.ARRAY(DataTypes.ARRAY(DataTypes.INTEGER)),
      kinds: {
        type: DataTypes.ARRAY(DataTypes.ENUM('tool', 'toy')),
        allowNull: false,
        defaultValue: '[]',
      },
      attributes: {
        type: DataTypes.HSTORE,
        allowNull: false,
        defaultValue: {},
      },
      stockRange: DataTypes.RANGE(DataTypes.INTEGER),
      bigRange: DataTypes.RANGE(DataTypes.BIGINT),
      priceRange: DataTypes.RANGE(DataTypes.DECIMAL),
      available: DataTypes.RANGE(DataTypes.DATEONLY),
      validDuring: DataTypes.RANGE(DataTypes.DATE),
      lastIp: DataTypes.INET,
      legacyIp: { type: DataTypes.INET, unique: true },
      shelfLife: DataTypes.BIGINT,
      sourcePath: DataTypes.STRING(100),
      manual: DataTypes.STRING(100),
      photo: DataTypes.STRING(100),
      smallCount: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
      },
      tinyCount: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      isActive: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: true,
      },
      stockedAt: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.NOW,
      },
      priority: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 5 },
      note: {
        type: DataTypes.STRING(20),
        allowNull: false,
        defaultValue: 'none',
      },
    },
    { tableName: 'item', timestamps: true, underscored: true }
  );

  Item.associate = (models) => {
    Item.hasMany(models.Shipment, {
      as: 'shipments',
      foreignKey: 'itemId',
      onDelete: 'CASCADE',
    });
    Item.hasMany(models.Shipment, {
      as: 'otherShipments',
      foreignKey: 'otherId',
      onDelete: 'CASCADE',
    });
  };

  return Item;
};
