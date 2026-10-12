'use strict';

module.exports = (sequelize, DataTypes) => {
  const Weird = sequelize.define(
    'Weird',
    {
      id: {
        type: DataTypes.UUID,
        primaryKey: true,
        defaultValue: DataTypes.UUIDV4,
      },
      aB: { type: DataTypes.TEXT, allowNull: false, defaultValue: 'x;y' },
      quote: {
        type: DataTypes.TEXT,
        allowNull: false,
        defaultValue: 'say "hi"',
      },
      tick: { type: DataTypes.TEXT, allowNull: false, defaultValue: 'a`b' },
      selfId: DataTypes.UUID,
      otherId: { type: DataTypes.UUID, allowNull: false },
    },
    { tableName: 'weird', timestamps: true, underscored: true }
  );

  Weird.associate = (models) => {
    Weird.belongsTo(models.Weird, {
      as: 'self',
      foreignKey: 'selfId',
      onDelete: 'SET NULL',
    });
    Weird.belongsTo(models.Other, {
      as: 'other',
      foreignKey: 'otherId',
      onDelete: 'CASCADE',
    });
  };

  return Weird;
};
