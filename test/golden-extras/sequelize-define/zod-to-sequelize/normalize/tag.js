'use strict';

module.exports = (sequelize, DataTypes) => {
  const Tag = sequelize.define(
    'Tag',
    {
      id: { type: DataTypes.INTEGER, primaryKey: true },
      label: { type: DataTypes.STRING(50), allowNull: false },
    },
    { tableName: 'tag', timestamps: true, underscored: true }
  );

  return Tag;
};
