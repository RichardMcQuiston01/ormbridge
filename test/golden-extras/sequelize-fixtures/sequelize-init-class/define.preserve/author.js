'use strict';

module.exports = (sequelize, DataTypes) => {
  const Author = sequelize.define(
    'Author',
    {
      id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
      name: { type: DataTypes.STRING(80), allowNull: false },
      bio: DataTypes.TEXT,
      createdAt: DataTypes.DATE,
      updatedAt: DataTypes.DATE,
    },
    { tableName: 'authors', timestamps: true }
  );

  Author.associate = (models) => {
    Author.hasMany(models.Book, {
      as: 'books',
      foreignKey: 'author_id',
      onDelete: 'CASCADE',
    });
  };

  return Author;
};
