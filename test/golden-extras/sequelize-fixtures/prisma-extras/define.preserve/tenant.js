'use strict';

module.exports = (sequelize, DataTypes) => {
  const Tenant = sequelize.define(
    'Tenant',
    {
      id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    },
    { tableName: 'Tenant', schema: 'public', timestamps: false }
  );

  return Tenant;
};
