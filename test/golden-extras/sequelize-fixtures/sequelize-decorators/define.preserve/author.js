'use strict';

module.exports = (sequelize, DataTypes) => {
  const Author = sequelize.define(
    'Author',
    {
      id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
      email: { type: DataTypes.STRING(80), allowNull: false, unique: true },
      bio: DataTypes.TEXT,
      state: {
        type: DataTypes.ENUM('active', 'banned'),
        defaultValue: 'active',
      },
      nickname: DataTypes.STRING(255),
      deletedAt: DataTypes.DATE,
    },
    { tableName: 'authors', timestamps: true }
  );

  Author.associate = (models) => {
    Author.hasOne(models.Profile, {
      as: 'profile',
      foreignKey: 'authorId',
      onDelete: 'CASCADE',
    });
    Author.hasMany(models.Post, {
      as: 'posts',
      foreignKey: 'authorId',
      onDelete: 'CASCADE',
    });
  };

  return Author;
};
