'use strict';

module.exports = (sequelize, DataTypes) => {
  const Profile = sequelize.define(
    'Profile',
    {
      id: { type: DataTypes.INTEGER, primaryKey: true },
      bio: DataTypes.TEXT,
      avatar: DataTypes.STRING(100),
      userId: { type: DataTypes.INTEGER, allowNull: false },
    },
    { tableName: 'profile', timestamps: true, underscored: true }
  );

  return Profile;
};
