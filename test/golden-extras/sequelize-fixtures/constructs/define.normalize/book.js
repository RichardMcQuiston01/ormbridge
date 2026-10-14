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
      publishedOn: {
        type: DataTypes.DATEONLY,
        allowNull: false,
        defaultValue: DataTypes.NOW,
      },
      opensAt: DataTypes.TIME,
      releasedAt: {
        type: DataTypes.DATE,
        defaultValue: '2020-01-02T03:04:05Z',
      },
      pages: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 100 },
      ratio: { type: DataTypes.DOUBLE, allowNull: false, defaultValue: 0.5 },
      inPrint: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: true,
      },
      notes: DataTypes.TEXT,
      window: DataTypes.RANGE(DataTypes.INTEGER),
      extra: DataTypes.HSTORE,
      readTime: DataTypes.BIGINT,
      cover: DataTypes.BLOB,
      authorId: { type: DataTypes.UUID, allowNull: false },
      editorId: DataTypes.UUID,
      seriesHandle: DataTypes.STRING(20),
    },
    {
      tableName: 'book',
      timestamps: true,
      underscored: true,
      indexes: [
        { unique: true, fields: ['title', 'author_id'] },
        { name: 'books_published_idx', fields: ['published_on'] },
      ],
    }
  );

  Book.associate = (models) => {
    Book.hasMany(models.Author, {
      as: 'latestFor',
      foreignKey: 'latestBookId',
      onDelete: 'SET NULL',
    });
    Book.belongsTo(models.Author, {
      as: 'author',
      foreignKey: 'authorId',
      onDelete: 'CASCADE',
    });
    Book.belongsTo(models.Author, {
      as: 'editor',
      foreignKey: 'editorId',
      onDelete: 'SET NULL',
    });
    Book.belongsTo(models.Series, {
      as: 'series',
      foreignKey: 'seriesHandle',
      targetKey: 'handle',
      onDelete: 'SET NULL',
    });
    Book.hasOne(models.Audiobook, {
      as: 'audiobook',
      foreignKey: 'bookPtrId',
      onDelete: 'CASCADE',
    });
  };

  return Book;
};
