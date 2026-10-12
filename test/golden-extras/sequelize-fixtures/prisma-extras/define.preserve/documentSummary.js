'use strict';

module.exports = (sequelize, DataTypes) => {
  const DocumentSummary = sequelize.define(
    'DocumentSummary',
    {
      id: { type: DataTypes.STRING, primaryKey: true, unique: true },
      title: { type: DataTypes.TEXT, allowNull: false },
    },
    { tableName: 'DocumentSummary', schema: 'audit', timestamps: false }
  );

  return DocumentSummary;
};
