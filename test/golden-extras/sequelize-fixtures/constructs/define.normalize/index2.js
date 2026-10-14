'use strict';

module.exports = (sequelize, DataTypes) => {
  const Index = sequelize.define(
    'Index',
    {
      id: {
        type: DataTypes.UUID,
        primaryKey: true,
        defaultValue: DataTypes.UUIDV4,
      },
      sql: DataTypes.TEXT,
      class: DataTypes.TEXT,
      table: DataTypes.UUID,
    },
    { tableName: 'index', timestamps: true, underscored: true }
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
