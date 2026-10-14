'use strict';

module.exports = (sequelize, DataTypes) => {
  const LegacyOrder = sequelize.define(
    'LegacyOrder',
    {
      order_no: { type: DataTypes.INTEGER, primaryKey: true, field: 'OrderNo' },
      type: { type: DataTypes.TEXT, allowNull: false, field: 'kind' },
      HTTPCode: {
        type: DataTypes.INTEGER,
        allowNull: false,
        field: 'http_code',
      },
      first_name: { type: DataTypes.TEXT, field: 'first name' },
      acct: DataTypes.BIGINT,
    },
    { tableName: 'LEGACY_ORDER', timestamps: false }
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
