'use strict';

module.exports = (sequelize, DataTypes) => {
  const Profile = sequelize.define(
    'Profile',
    {
      id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
      bio: DataTypes.TEXT,
      avatar: DataTypes.STRING(100),
      user_id: { type: DataTypes.INTEGER, allowNull: false, unique: true },
    },
    { tableName: 'blog_profile', timestamps: false }
  );

  Profile.associate = (models) => {
    Profile.belongsTo(models.User, {
      as: 'user',
      foreignKey: 'user_id',
      onDelete: 'CASCADE',
    });
  };

  return Profile;
};
