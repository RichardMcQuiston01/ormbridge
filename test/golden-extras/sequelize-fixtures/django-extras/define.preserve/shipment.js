'use strict';

module.exports = (sequelize, DataTypes) => {
  const Shipment = sequelize.define(
    'Shipment',
    {
      id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
      object_id: { type: DataTypes.INTEGER, allowNull: false },
      item_id: { type: DataTypes.INTEGER, allowNull: false },
      other_id: { type: DataTypes.INTEGER, allowNull: false },
      content_type_id: { type: DataTypes.INTEGER, allowNull: false },
      created_by_id: { type: DataTypes.INTEGER, allowNull: false },
    },
    { tableName: 'blog_shipment', timestamps: false }
  );

  Shipment.associate = (models) => {
    Shipment.belongsTo(models.Item, {
      as: 'item',
      foreignKey: 'item_id',
      onDelete: 'CASCADE',
    });
    Shipment.belongsTo(models.Item, {
      as: 'other',
      foreignKey: 'other_id',
      onDelete: 'CASCADE',
    });
    Shipment.belongsTo(models.ContentType, {
      as: 'content_type',
      foreignKey: 'content_type_id',
      onDelete: 'CASCADE',
    });
    Shipment.belongsTo(models.Account, {
      as: 'created_by',
      foreignKey: 'created_by_id',
      onDelete: 'CASCADE',
    });
  };

  return Shipment;
};
