'use strict';

module.exports = (sequelize, DataTypes) => {
  const Book = sequelize.define(
    'Book',
    {
      id: {
        type: DataTypes.UUID,
        primaryKey: true,
        defaultValue: DataTypes.UUIDV4,
      },
      title: { type: DataTypes.STRING(255), allowNull: false },
      isbn: { type: DataTypes.STRING(13), unique: true },
      pages: { type: DataTypes.INTEGER, defaultValue: 0 },
      authorId: { type: DataTypes.UUID, allowNull: false },
    },
    {
      tableName: 'book',
      timestamps: true,
      underscored: true,
      indexes: [
        { fields: ['title'] },
      ],
    }
  );

  Book.associate = (models) => {
    Book.belongsTo(models.Author, {
      as: 'author',
      foreignKey: 'authorId',
      onDelete: 'CASCADE',
    });
  };

  return Book;
};
