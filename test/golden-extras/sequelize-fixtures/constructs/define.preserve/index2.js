'use strict';

module.exports = (sequelize, DataTypes) => {
  const Index = sequelize.define(
    'Index',
    {
      id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
      sql: DataTypes.TEXT,
      class: DataTypes.TEXT,
      table: DataTypes.INTEGER,
    },
    { tableName: 'index_rows', timestamps: false }
  );

  Index.associate = (models) => {
    Index.belongsTo(models.Series, {
      as: 'table2',
      foreignKey: 'table',
      onDelete: 'NO ACTION',
    });
  };

  return Index;
};
