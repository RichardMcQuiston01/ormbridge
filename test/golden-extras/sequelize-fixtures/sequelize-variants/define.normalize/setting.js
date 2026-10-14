'use strict';

module.exports = (sequelize, DataTypes) => {
  const Setting = sequelize.define(
    'Setting',
    {
      id: {
        type: DataTypes.UUID,
        primaryKey: true,
        defaultValue: DataTypes.UUIDV4,
      },
      scope: DataTypes.STRING(30),
      key: DataTypes.STRING(30),
      value: DataTypes.TEXT,
    },
    {
      tableName: 'setting',
      timestamps: true,
      underscored: true,
      indexes: [
        { name: 'setting_key_value', unique: true, fields: ['key', 'value'] },
      ],
    }
  );

  return Setting;
};
