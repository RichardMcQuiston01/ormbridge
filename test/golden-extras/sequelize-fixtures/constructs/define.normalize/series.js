'use strict';

module.exports = (sequelize, DataTypes) => {
  const Series = sequelize.define(
    'Series',
    {
      id: {
        type: DataTypes.UUID,
        primaryKey: true,
        defaultValue: DataTypes.UUIDV4,
      },
      handle: {
        type: DataTypes.STRING(20),
        allowNull: false,
        unique: 'series_handle_uq',
      },
      parentId: DataTypes.UUID,
    },
    { tableName: 'series', timestamps: true, underscored: true }
  );

  Series.associate = (models) => {
    Series.belongsTo(models.Series, {
      as: 'parent',
      foreignKey: 'parentId',
      onDelete: 'SET NULL',
    });
    Series.hasMany(models.Series, {
      as: 'children',
      foreignKey: 'parentId',
      onDelete: 'SET NULL',
    });
  };

  return Series;
};
