'use strict';

module.exports = (sequelize, DataTypes) => {
  const Scratch = sequelize.define(
    'Scratch',
    {
      id: { type: DataTypes.INTEGER, primaryKey: true },
    },
    { tableName: 'Scratch', schema: 'audit', timestamps: false }
  );

  return Scratch;
};
