'use strict';

module.exports = (sequelize, DataTypes) => {
  const Author = sequelize.define(
    'Author',
    {
      id: {
        type: DataTypes.UUID,
        primaryKey: true,
        defaultValue: DataTypes.UUIDV4,
      },
      name: { type: DataTypes.STRING(80), allowNull: false },
      bio: DataTypes.TEXT,
      createdAt: DataTypes.DATE,
      updatedAt: DataTypes.DATE,
    },
    { tableName: 'author', timestamps: true, underscored: true }
  );

  Author.associate = (models) => {
    Author.hasMany(models.Book, {
      as: 'books',
      foreignKey: 'authorId',
      onDelete: 'CASCADE',
    });
  };

  return Author;
};
