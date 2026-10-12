'use strict';

module.exports = (sequelize, DataTypes) => {
  const Book = sequelize.define(
    'Book',
    {
      id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
      title: { type: DataTypes.STRING(120), allowNull: false },
      tags: {
        type: DataTypes.ARRAY(DataTypes.TEXT),
        allowNull: false,
        defaultValue: [],
      },
      grid: DataTypes.ARRAY(DataTypes.ARRAY(DataTypes.INTEGER)),
      colors: DataTypes.ARRAY(DataTypes.ENUM('red', 'green')),
      color: {
        type: DataTypes.ENUM('red', 'green'),
        allowNull: false,
        defaultValue: 'red',
      },
      price: {
        type: DataTypes.DECIMAL(8, 2),
        allowNull: false,
        defaultValue: 9.99,
      },
      settings: {
        type: DataTypes.JSONB,
        allowNull: false,
        defaultValue: { theme: 'dark', tabs: [1, 2] },
      },
      published_on: {
        type: DataTypes.DATEONLY,
        allowNull: false,
        defaultValue: DataTypes.NOW,
      },
      opens_at: DataTypes.TIME,
      released_at: {
        type: DataTypes.DATE,
        defaultValue: '2020-01-02T03:04:05Z',
      },
      pages: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 100 },
      ratio: { type: DataTypes.DOUBLE, allowNull: false, defaultValue: 0.5 },
      in_print: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: true,
      },
      notes: DataTypes.TEXT,
      window: DataTypes.RANGE(DataTypes.INTEGER),
      extra: DataTypes.HSTORE,
      read_time: DataTypes.BIGINT,
      cover: DataTypes.BLOB,
      author_id: { type: DataTypes.UUID, allowNull: false },
      editor_id: DataTypes.UUID,
      series_handle: DataTypes.STRING(20),
    },
    {
      tableName: 'books',
      timestamps: false,
      indexes: [
        { unique: true, fields: ['title', 'author_id'] },
        { name: 'books_published_idx', fields: ['published_on'] },
      ],
    }
  );

  Book.associate = (models) => {
    Book.hasMany(models.Author, {
      as: 'latest_for',
      foreignKey: 'latest_book_id',
      onDelete: 'SET NULL',
    });
    Book.belongsTo(models.Author, {
      as: 'author',
      foreignKey: 'author_id',
      onDelete: 'CASCADE',
    });
    Book.belongsTo(models.Author, {
      as: 'editor',
      foreignKey: 'editor_id',
      onDelete: 'SET NULL',
    });
    Book.belongsTo(models.Series, {
      as: 'series',
      foreignKey: 'series_handle',
      targetKey: 'handle',
      onDelete: 'SET NULL',
    });
    Book.hasOne(models.Audiobook, {
      as: 'audiobook',
      foreignKey: 'book_ptr_id',
      onDelete: 'CASCADE',
    });
  };

  return Book;
};
