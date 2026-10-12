'use strict';

module.exports = (sequelize, DataTypes) => {
  const City = sequelize.define(
    'City',
    {
      id: {
        type: DataTypes.UUID,
        primaryKey: true,
        defaultValue: DataTypes.UUIDV4,
      },
      name: DataTypes.STRING(255),
      countryCode: DataTypes.STRING(2),
    },
    { tableName: 'city', timestamps: true, underscored: true }
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
