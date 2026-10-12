'use strict';

module.exports = (sequelize, DataTypes) => {
  const Weird = sequelize.define(
    'Weird',
    {
      id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
      a_b: {
        type: DataTypes.TEXT,
        allowNull: false,
        defaultValue: 'x;y',
        field: 'a;b',
      },
      quote: {
        type: DataTypes.TEXT,
        allowNull: false,
        defaultValue: 'say "hi"',
      },
      tick: { type: DataTypes.TEXT, allowNull: false, defaultValue: 'a`b' },
      self_id: DataTypes.INTEGER,
      other_id: { type: DataTypes.INTEGER, allowNull: false },
    },
    { tableName: 'weird', timestamps: false }
  );

  Weird.associate = (models) => {
    Weird.belongsTo(models.Weird, {
      as: 'self',
      foreignKey: 'self_id',
      onDelete: 'SET NULL',
    });
    Weird.belongsTo(models.Other, {
      as: 'other',
      foreignKey: 'other_id',
      onDelete: 'CASCADE',
    });
  };

  return Weird;
};
