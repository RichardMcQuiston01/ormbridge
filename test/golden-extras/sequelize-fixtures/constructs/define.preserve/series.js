'use strict';

module.exports = (sequelize, DataTypes) => {
  const Series = sequelize.define(
    'Series',
    {
      id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
      handle: {
        type: DataTypes.STRING(20),
        allowNull: false,
        unique: 'series_handle_uq',
      },
      parent_id: DataTypes.INTEGER,
    },
    { tableName: 'series', timestamps: false }
  );

  Series.associate = (models) => {
    Series.belongsTo(models.Series, {
      as: 'parent',
      foreignKey: 'parent_id',
      onDelete: 'SET NULL',
    });
    Series.hasMany(models.Series, {
      as: 'children',
      foreignKey: 'parent_id',
      onDelete: 'SET NULL',
    });
  };

  return Series;
};
