'use strict';

module.exports = (sequelize, DataTypes) => {
  const LegacyOrder = sequelize.define(
    'LegacyOrder',
    {
      orderNo: { type: DataTypes.INTEGER, primaryKey: true },
      type: { type: DataTypes.TEXT, allowNull: false, field: 'kind' },
      httpCode: { type: DataTypes.INTEGER, allowNull: false },
      firstName: DataTypes.TEXT,
      acct: DataTypes.UUID,
    },
    { tableName: 'legacy_order', timestamps: true, underscored: true }
  );

  LegacyOrder.associate = (models) => {
    LegacyOrder.belongsTo(models.Account, {
      as: 'owner',
      foreignKey: 'acct',
      onDelete: 'NO ACTION',
    });
  };

  return LegacyOrder;
};
