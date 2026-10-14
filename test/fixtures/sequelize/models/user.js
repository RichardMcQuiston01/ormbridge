'use strict';

module.exports = (sequelize, DataTypes) => {
  const User = sequelize.define(
    'User',
    {
      id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true,
      },
    },
    { tableName: 'auth_user', timestamps: false }
  );

  User.associate = (models) => {
    User.hasMany(models.Post, { as: 'posts', foreignKey: 'authorId' });
    User.hasMany(models.Post, { as: 'editedPosts', foreignKey: 'editorId' });
    User.hasOne(models.Profile, { as: 'profile', foreignKey: 'userId' });
  };

  return User;
};
