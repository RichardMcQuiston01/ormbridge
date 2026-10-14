'use strict';

module.exports = (sequelize, DataTypes) => {
  const Book = sequelize.define(
    'Book',
    {
      id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
      title: { type: DataTypes.STRING(255), allowNull: false },
      isbn: { type: DataTypes.STRING(13), unique: true },
      pages: { type: DataTypes.INTEGER, defaultValue: 0 },
      author_id: { type: DataTypes.INTEGER, allowNull: false },
    },
    {
      tableName: 'books',
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
      foreignKey: 'author_id',
      onDelete: 'CASCADE',
    });
  };

  return Book;
};
