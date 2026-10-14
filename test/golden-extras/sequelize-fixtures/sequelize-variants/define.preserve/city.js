'use strict';

module.exports = (sequelize, DataTypes) => {
  const City = sequelize.define(
    'City',
    {
      id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
      name: DataTypes.STRING(255),
      countryCode: DataTypes.STRING(2),
    },
    { tableName: 'cities', timestamps: false }
  );

  City.associate = (models) => {
    City.belongsTo(models.Country, {
      as: 'country',
      foreignKey: 'countryCode',
      onDelete: 'CASCADE',
    });
  };

  return City;
};
