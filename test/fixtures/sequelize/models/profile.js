'use strict';

module.exports = (sequelize, DataTypes) => {
  const Profile = sequelize.define(
    'Profile',
    {
      bio: DataTypes.TEXT,
      avatar: DataTypes.STRING(100),
      userId: {
        type: DataTypes.INTEGER,
        allowNull: false,
        unique: true,
        field: 'user_id',
      },
    },
    { tableName: 'blog_profile', timestamps: false }
  );

  Profile.associate = (models) => {
    Profile.belongsTo(models.User, {
      as: 'user',
      foreignKey: 'userId',
      onDelete: 'CASCADE',
    });
  };

  return Profile;
};
