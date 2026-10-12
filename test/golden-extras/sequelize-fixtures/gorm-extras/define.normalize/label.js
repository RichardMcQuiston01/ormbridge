'use strict';

module.exports = (sequelize, DataTypes) => {
  const Label = sequelize.define(
    'Label',
    {
      id: {
        type: DataTypes.UUID,
        primaryKey: true,
        defaultValue: DataTypes.UUIDV4,
      },
      name: { type: DataTypes.STRING(40), allowNull: false, unique: true },
    },
    { tableName: 'label', timestamps: true, underscored: true }
  );

  return Label;
};
