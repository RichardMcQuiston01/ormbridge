'use strict';

module.exports = (sequelize, DataTypes) => {
  const User = sequelize.define(
    'User',
    {
      id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
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
      as: 'edited_posts',
      foreignKey: 'editor_id',
      onDelete: 'SET NULL',
    });
  };

  return User;
};
