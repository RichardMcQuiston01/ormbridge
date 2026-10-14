'use strict';

module.exports = (sequelize, DataTypes) => {
  const Group = sequelize.define(
    'Group',
    {
      id: {
        type: DataTypes.UUID,
        primaryKey: true,
        defaultValue: DataTypes.UUIDV4,
      },
      title: DataTypes.STRING(255),
    },
    { tableName: 'group', timestamps: true, underscored: true }
  );

  return Group;
};
