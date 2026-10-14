'use strict';

module.exports = (sequelize, DataTypes) => {
  const DocumentSummary = sequelize.define(
    'DocumentSummary',
    {
      id: { type: DataTypes.STRING, primaryKey: true, unique: true },
      title: { type: DataTypes.TEXT, allowNull: false },
    },
    {
      tableName: 'document_summary',
      schema: 'audit',
      timestamps: true,
      underscored: true,
    }
  );

  return DocumentSummary;
};
