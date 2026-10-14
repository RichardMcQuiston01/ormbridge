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
    as: 'latest_book',
    foreignKey: 'latest_book_id',
    onDelete: 'SET NULL',
  });
  Book.hasMany(Author, {
    as: 'latest_for',
    foreignKey: 'latest_book_id',
    onDelete: 'SET NULL',
  });

  Book.belongsTo(Author, {
    as: 'author',
    foreignKey: 'author_id',
    onDelete: 'CASCADE',
  });
  Author.hasMany(Book, {
    as: 'books',
    foreignKey: 'author_id',
    onDelete: 'CASCADE',
  });

  Book.belongsTo(Author, {
    as: 'editor',
    foreignKey: 'editor_id',
    onDelete: 'SET NULL',
  });
  Author.hasMany(Book, {
    as: 'edited_books',
    foreignKey: 'editor_id',
    onDelete: 'SET NULL',
  });

  Book.belongsTo(Series, {
    as: 'series',
    foreignKey: 'series_handle',
    targetKey: 'handle',
    onDelete: 'SET NULL',
  });

  Series.belongsTo(Series, {
    as: 'parent',
    foreignKey: 'parent_id',
    onDelete: 'SET NULL',
  });
  Series.hasMany(Series, {
    as: 'children',
    foreignKey: 'parent_id',
    onDelete: 'SET NULL',
  });

  Audiobook.belongsTo(Book, {
    as: 'book',
    foreignKey: 'book_ptr_id',
    onDelete: 'CASCADE',
  });
  Book.hasOne(Audiobook, {
    as: 'audiobook',
    foreignKey: 'book_ptr_id',
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
