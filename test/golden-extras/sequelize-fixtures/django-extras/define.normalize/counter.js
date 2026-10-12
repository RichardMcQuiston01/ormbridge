'use strict';

module.exports = (sequelize, DataTypes) => {
  const Counter = sequelize.define(
    'Counter',
    {
      smallId: {
        type: DataTypes.UUID,
        primaryKey: true,
        defaultValue: DataTypes.UUIDV4,
      },
      label: { type: DataTypes.STRING(20), allowNull: false },
    },
    { tableName: 'counter', timestamps: true, underscored: true }
  );

  return Counter;
};
