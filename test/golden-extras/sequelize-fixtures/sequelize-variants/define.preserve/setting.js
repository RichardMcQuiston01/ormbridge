'use strict';

module.exports = (sequelize, DataTypes) => {
  const Setting = sequelize.define(
    'Setting',
    {
      id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
      scope: DataTypes.STRING(30),
      key: DataTypes.STRING(30),
      value: DataTypes.TEXT,
    },
    {
      tableName: 'settings',
      timestamps: false,
      indexes: [
        { name: 'setting_key_value', unique: true, fields: ['key', 'value'] },
      ],
    }
  );

  return Setting;
};
