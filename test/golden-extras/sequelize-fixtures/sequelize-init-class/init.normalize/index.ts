import type { Sequelize } from 'sequelize';
import { Author } from './author.js';
import { Book } from './book.js';

export { Author, Book };

/** Initializes every model on a Sequelize instance, then sets up the associations. */
export function initModels(sequelize: Sequelize) {
  Author.initModel(sequelize);
  Book.initModel(sequelize);

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

  return { Author, Book };
}

export type Models = ReturnType<typeof initModels>;
