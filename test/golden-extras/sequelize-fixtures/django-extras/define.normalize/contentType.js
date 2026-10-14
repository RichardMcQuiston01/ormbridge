'use strict';

module.exports = (sequelize, DataTypes) => {
  const ContentType = sequelize.define(
    'ContentType',
    {
      id: {
        type: DataTypes.UUID,
        primaryKey: true,
        defaultValue: DataTypes.UUIDV4,
      },
    },
    { tableName: 'content_type', timestamps: true, underscored: true }
  );

  return ContentType;
};
