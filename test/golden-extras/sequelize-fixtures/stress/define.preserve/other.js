'use strict';

module.exports = (sequelize, DataTypes) => {
  const Other = sequelize.define(
    'Other',
    {
      id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    },
    { tableName: 'others', timestamps: false }
  );

  Other.associate = (models) => {
    Other.hasMany(models.Weird, {
      as: 'weirds',
      foreignKey: 'other_id',
      onDelete: 'CASCADE',
    });
  };

  return Other;
};
