'use strict';

module.exports = (sequelize, DataTypes) => {
  const Tenant = sequelize.define(
    'Tenant',
    {
      id: {
        type: DataTypes.UUID,
        primaryKey: true,
        defaultValue: DataTypes.UUIDV4,
      },
    },
    {
      tableName: 'tenant',
      schema: 'public',
      timestamps: true,
      underscored: true,
    }
  );

  return Tenant;
};
