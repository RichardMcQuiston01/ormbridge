'use strict';

module.exports = (sequelize, DataTypes) => {
  const User = sequelize.define(
    'User',
    {
      id: {
        type: DataTypes.UUID,
        primaryKey: true,
        defaultValue: DataTypes.UUIDV4,
      },
    },
    { tableName: 'user', timestamps: true, underscored: true }
  );

  User.associate = (models) => {
    User.hasMany(models.Post, {
      as: 'posts',
      foreignKey: 'authorId',
      onDelete: 'CASCADE',
    });
    User.hasMany(models.Post, {
      as: 'editedPosts',
      foreignKey: 'editorId',
      onDelete: 'SET NULL',
    });
  };

  return User;
};
