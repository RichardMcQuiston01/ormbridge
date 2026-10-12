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
      favourite_book_id: DataTypes.INTEGER,
      latest_book_id: DataTypes.BIGINT,
    },
    { tableName: 'authors', timestamps: false }
  );

  Author.associate = (models) => {
    Author.belongsTo(models.Book, {
      as: 'latest_book',
      foreignKey: 'latest_book_id',
      onDelete: 'SET NULL',
    });
    Author.hasMany(models.Book, {
      as: 'books',
      foreignKey: 'author_id',
      onDelete: 'CASCADE',
    });
    Author.hasMany(models.Book, {
      as: 'edited_books',
      foreignKey: 'editor_id',
      onDelete: 'SET NULL',
    });
  };

  return Author;
};
