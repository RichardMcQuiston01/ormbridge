'use strict';

module.exports = (sequelize, DataTypes) => {
  const Label = sequelize.define(
    'Label',
    {
      id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
      name: { type: DataTypes.STRING(40), allowNull: false, unique: true },
    },
    { tableName: 'labels', timestamps: false }
  );

  return Label;
};
