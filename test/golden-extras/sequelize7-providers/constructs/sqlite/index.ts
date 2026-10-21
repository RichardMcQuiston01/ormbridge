import { Author } from './author.js';
import { Book } from './book.js';
import { Series } from './series.js';
import { Audiobook } from './audiobook.js';
import { Index } from './index2.js';
import { Tagged } from './tagged.js';

export { Author, Book, Series, Audiobook, Index, Tagged };

/**
 * Every model of the schema. Sequelize 7 takes them in its constructor, together with the dialect, which
 * is a class from its own package (npm install @sequelize/core @sequelize/sqlite3):
 *
 *   import { Sequelize } from '@sequelize/core';
 *   import { SqliteDialect } from '@sequelize/sqlite3';
 *   import { models } from './models/index.js';
 *
 *   const sequelize = new Sequelize({ dialect: SqliteDialect, storage: 'database.sqlite', models });
 */
export const models = [Author, Book, Series, Audiobook, Index, Tagged];
