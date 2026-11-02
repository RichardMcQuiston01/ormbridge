'use strict';

module.exports = (sequelize, DataTypes) => {
  const Item = sequelize.define(
    'Item',
    {
      id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
      first_name: { type: DataTypes.STRING(40), allowNull: false },
      last_name: { type: DataTypes.STRING(40), allowNull: false },
      full_name: { type: DataTypes.STRING(81), allowNull: false },
      quantity: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
      total_cents: { type: DataTypes.INTEGER, allowNull: false },
      tags: {
        type: DataTypes.ARRAY(DataTypes.STRING(20)),
        allowNull: false,
        defaultValue: [],
      },
      grid: DataTypes.ARRAY(DataTypes.ARRAY(DataTypes.INTEGER)),
      kinds: {
        type: DataTypes.ARRAY(DataTypes.ENUM('tool', 'toy')),
        allowNull: false,
        defaultValue: [],
      },
      attributes: {
        type: DataTypes.HSTORE,
        allowNull: false,
        defaultValue: {},
      },
      stock_range: DataTypes.RANGE(DataTypes.INTEGER),
      big_range: DataTypes.RANGE(DataTypes.BIGINT),
      price_range: DataTypes.RANGE(DataTypes.DECIMAL),
      available: DataTypes.RANGE(DataTypes.DATEONLY),
      valid_during: DataTypes.RANGE(DataTypes.DATE),
      last_ip: DataTypes.INET,
      legacy_ip: { type: DataTypes.INET, unique: true },
      shelf_life: DataTypes.BIGINT,
      source_path: DataTypes.STRING(100),
      manual: DataTypes.STRING(100),
      photo: DataTypes.STRING(100),
      small_count: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
      },
      tiny_count: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
      },
      is_active: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: true,
      },
      stocked_at: {
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
    { tableName: 'blog_item', timestamps: false }
  );

  Item.associate = (models) => {
    Item.hasMany(models.Shipment, {
      as: 'shipments',
      foreignKey: 'item_id',
      onDelete: 'CASCADE',
    });
    Item.hasMany(models.Shipment, {
      as: 'other_shipments',
      foreignKey: 'other_id',
      onDelete: 'CASCADE',
    });
  };

  return Item;
};
