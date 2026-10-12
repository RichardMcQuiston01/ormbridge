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
      handle: { type: DataTypes.STRING(30), allowNull: false, unique: true },
      favouriteBookId: DataTypes.INTEGER,
      latestBookId: DataTypes.UUID,
    },
    { tableName: 'author', timestamps: true, underscored: true }
  );

  Author.associate = (models) => {
    Author.belongsTo(models.Book, {
      as: 'latestBook',
      foreignKey: 'latestBookId',
      onDelete: 'SET NULL',
    });
    Author.hasMany(models.Book, {
      as: 'books',
      foreignKey: 'authorId',
      onDelete: 'CASCADE',
    });
    Author.hasMany(models.Book, {
      as: 'editedBooks',
      foreignKey: 'editorId',
      onDelete: 'SET NULL',
    });
  };

  return Author;
};
