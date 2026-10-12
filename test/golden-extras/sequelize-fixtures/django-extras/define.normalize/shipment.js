'use strict';

module.exports = (sequelize, DataTypes) => {
  const Shipment = sequelize.define(
    'Shipment',
    {
      id: {
        type: DataTypes.UUID,
        primaryKey: true,
        defaultValue: DataTypes.UUIDV4,
      },
      objectId: { type: DataTypes.INTEGER, allowNull: false },
      itemId: { type: DataTypes.UUID, allowNull: false },
      otherId: { type: DataTypes.UUID, allowNull: false },
      contentTypeId: { type: DataTypes.UUID, allowNull: false },
      createdById: { type: DataTypes.UUID, allowNull: false },
    },
    { tableName: 'shipment', timestamps: true, underscored: true }
  );

  Shipment.associate = (models) => {
    Shipment.belongsTo(models.Item, {
      as: 'item',
      foreignKey: 'itemId',
      onDelete: 'CASCADE',
    });
    Shipment.belongsTo(models.Item, {
      as: 'other',
      foreignKey: 'otherId',
      onDelete: 'CASCADE',
    });
    Shipment.belongsTo(models.ContentType, {
      as: 'contentType',
      foreignKey: 'contentTypeId',
      onDelete: 'CASCADE',
    });
    Shipment.belongsTo(models.Account, {
      as: 'createdBy',
      foreignKey: 'createdById',
      onDelete: 'CASCADE',
    });
  };

  return Shipment;
};
