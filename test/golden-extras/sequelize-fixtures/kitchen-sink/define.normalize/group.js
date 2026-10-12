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
      name: { type: DataTypes.STRING(40), allowNull: false },
    },
    { tableName: 'group', timestamps: true, underscored: true }
  );

  Group.associate = (models) => {
    Group.belongsToMany(models.Group, {
      as: 'friends',
      through: 'group_friends',
      foreignKey: 'from_group_id',
      otherKey: 'to_group_id',
      timestamps: false,
    });
    Group.belongsToMany(models.Group, {
      as: 'friendOf',
      through: 'group_friends',
      foreignKey: 'to_group_id',
      otherKey: 'from_group_id',
      timestamps: false,
    });
  };

  return Group;
};
