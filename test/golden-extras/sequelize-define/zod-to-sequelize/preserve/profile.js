'use strict';

module.exports = (sequelize, DataTypes) => {
  const Profile = sequelize.define(
    'Profile',
    {
      id: { type: DataTypes.INTEGER, primaryKey: true },
      bio: DataTypes.TEXT,
      avatar: DataTypes.STRING(100),
      user_id: { type: DataTypes.INTEGER, allowNull: false },
    },
    { tableName: 'Profile', timestamps: false }
  );

  return Profile;
};
