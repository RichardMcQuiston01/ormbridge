'use strict';

module.exports = (sequelize, DataTypes) => {
  const Tag = sequelize.define(
    'Tag',
    {
      id: {
        type: DataTypes.UUID,
        primaryKey: true,
        defaultValue: DataTypes.UUIDV4,
      },
      label: DataTypes.STRING(40),
    },
    { tableName: 'tag', timestamps: true, underscored: true }
  );

  return Tag;
};
