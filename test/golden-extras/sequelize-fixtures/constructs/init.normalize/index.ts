import type { Sequelize } from 'sequelize';
import { Author } from './author.js';
import { Book } from './book.js';
import { Series } from './series.js';
import { Audiobook } from './audiobook.js';
import { Index } from './index2.js';
import { Tagged } from './tagged.js';

export { Author, Book, Series, Audiobook, Index, Tagged };

/** Initializes every model on a Sequelize instance, then sets up the associations. */
export function initModels(sequelize: Sequelize) {
  Author.initModel(sequelize);
  Book.initModel(sequelize);
  Series.initModel(sequelize);
  Audiobook.initModel(sequelize);
  Index.initModel(sequelize);
  Tagged.initModel(sequelize);

  Author.belongsTo(Book, {
    as: 'latestBook',
    foreignKey: 'latestBookId',
    onDelete: 'SET NULL',
  });
  Book.hasMany(Author, {
    as: 'latestFor',
    foreignKey: 'latestBookId',
    onDelete: 'SET NULL',
  });

  Book.belongsTo(Author, {
    as: 'author',
    foreignKey: 'authorId',
    onDelete: 'CASCADE',
  });
  Author.hasMany(Book, {
    as: 'books',
    foreignKey: 'authorId',
    onDelete: 'CASCADE',
  });

  Book.belongsTo(Author, {
    as: 'editor',
    foreignKey: 'editorId',
    onDelete: 'SET NULL',
  });
  Author.hasMany(Book, {
    as: 'editedBooks',
    foreignKey: 'editorId',
    onDelete: 'SET NULL',
  });

  Book.belongsTo(Series, {
    as: 'series',
    foreignKey: 'seriesHandle',
    targetKey: 'handle',
    onDelete: 'SET NULL',
  });

  Series.belongsTo(Series, {
    as: 'parent',
    foreignKey: 'parentId',
    onDelete: 'SET NULL',
  });
  Series.hasMany(Series, {
    as: 'children',
    foreignKey: 'parentId',
    onDelete: 'SET NULL',
  });

  Audiobook.belongsTo(Book, {
    as: 'book',
    foreignKey: 'bookPtrId',
    onDelete: 'CASCADE',
  });
  Book.hasOne(Audiobook, {
    as: 'audiobook',
    foreignKey: 'bookPtrId',
    onDelete: 'CASCADE',
  });

  Index.belongsTo(Series, {
    as: 'table2',
    foreignKey: 'table',
    onDelete: 'NO ACTION',
  });

  Tagged.belongsToMany(Book, {
    as: 'books',
    through: 'tagged_books',
    foreignKey: 'tagged_id',
    otherKey: 'book_id',
    timestamps: false,
  });

  return { Author, Book, Series, Audiobook, Index, Tagged };
}

export type Models = ReturnType<typeof initModels>;
