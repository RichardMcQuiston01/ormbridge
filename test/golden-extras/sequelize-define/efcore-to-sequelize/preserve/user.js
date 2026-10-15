'use strict';

module.exports = (sequelize, DataTypes) => {
  const User = sequelize.define(
    'User',
    {
      id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true,
        field: 'Id',
      },
    },
    { tableName: 'auth_user', timestamps: false }
  );

  User.associate = (models) => {
    User.hasMany(models.Post, {
      as: 'posts',
      foreignKey: 'author_id',
      onDelete: 'CASCADE',
    });
    User.hasMany(models.Post, {
      as: 'editedPosts',
      foreignKey: 'editor_id',
      onDelete: 'SET NULL',
    });
    User.hasOne(models.Profile, {
      as: 'profile',
      foreignKey: 'user_id',
      onDelete: 'CASCADE',
    });
  };

  return User;
};
