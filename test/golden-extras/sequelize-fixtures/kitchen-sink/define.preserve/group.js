'use strict';

module.exports = (sequelize, DataTypes) => {
  const Group = sequelize.define(
    'Group',
    {
      id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
      name: { type: DataTypes.STRING(40), allowNull: false },
    },
    { tableName: 'groups', timestamps: false }
  );

  Group.associate = (models) => {
    Group.belongsToMany(models.Group, {
      as: 'friends',
      through: 'groups_friends',
      foreignKey: 'from_group_id',
      otherKey: 'to_group_id',
      timestamps: false,
    });
    Group.belongsToMany(models.Group, {
      as: 'friend_of',
      through: 'groups_friends',
      foreignKey: 'to_group_id',
      otherKey: 'from_group_id',
      timestamps: false,
    });
  };

  return Group;
};
