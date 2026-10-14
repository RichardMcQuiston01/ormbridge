'use strict';

module.exports = (sequelize, DataTypes) => {
  const Tag = sequelize.define(
    'Tag',
    {
      id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
      label: DataTypes.STRING(40),
    },
    { tableName: 'tags', timestamps: false }
  );

  return Tag;
};
