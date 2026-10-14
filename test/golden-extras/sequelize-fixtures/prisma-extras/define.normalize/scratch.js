'use strict';

module.exports = (sequelize, DataTypes) => {
  const Scratch = sequelize.define(
    'Scratch',
    {
      id: { type: DataTypes.INTEGER, primaryKey: true },
    },
    {
      tableName: 'scratch',
      schema: 'audit',
      timestamps: true,
      underscored: true,
    }
  );

  return Scratch;
};
