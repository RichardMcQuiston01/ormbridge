'use strict';

module.exports = (sequelize, DataTypes) => {
  const ContentType = sequelize.define(
    'ContentType',
    {
      id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    },
    { tableName: 'blog_contenttype', timestamps: false }
  );

  return ContentType;
};
