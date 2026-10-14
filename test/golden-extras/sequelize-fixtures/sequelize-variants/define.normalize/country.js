'use strict';

module.exports = (sequelize, DataTypes) => {
  const Country = sequelize.define(
    'Country',
    {
      code: { type: DataTypes.STRING(2), primaryKey: true },
      name: DataTypes.STRING(255),
    },
    { tableName: 'country', timestamps: true, underscored: true }
  );

  return Country;
};
