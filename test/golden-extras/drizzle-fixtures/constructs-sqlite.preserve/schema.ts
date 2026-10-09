import { relations, sql } from 'drizzle-orm';
import {
  type AnySQLiteColumn,
  blob,
  index,
  integer,
  numeric,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

// color: red, green = Green
export const colorValues = ['red', 'green'] as const;
export type Color = (typeof colorValues)[number];

// Status: draft = Draft, live
export const statusValues = ['draft', 'live'] as const;
export type Status = (typeof statusValues)[number];

export const series = sqliteTable('series', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  handle: text('handle').notNull().unique('series_handle_uq'),
  parentId: integer('parent_id')
    .references((): AnySQLiteColumn => series.id, { onDelete: 'set null' }),
});

export type Series = typeof series.$inferSelect;
export type NewSeries = typeof series.$inferInsert;

export const book = sqliteTable(
  'books',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    title: text('title').notNull(),
    tags: text('tags', { mode: 'json' }).$type<string[]>().notNull().default([]),
    grid: text('grid', { mode: 'json' }).$type<number[][]>(),
    colors: text('colors', { mode: 'json' }).$type<Color[]>(),
    color: text('color', { enum: colorValues }).notNull().default('red'),
    price: numeric('price').notNull().default('9.99'),
    settings: text('settings', { mode: 'json' })
      .notNull()
      .default({ theme: 'dark', tabs: [1, 2] }),
    publishedOn: text('published_on').notNull().default(sql`(CURRENT_DATE)`),
    opensAt: text('opens_at'),
    releasedAt: integer('released_at', { mode: 'timestamp' })
      .default(new Date('2020-01-02T03:04:05Z')),
    pages: integer('pages').notNull().default(100),
    ratio: real('ratio').notNull().default(0.5),
    inPrint: integer('in_print', { mode: 'boolean' }).notNull().default(true),
    notes: text('notes'),
    window: text('window'),
    extra: text('extra', { mode: 'json' }).$type<Record<string, string | null>>(),
    readTime: integer('read_time'),
    cover: blob('cover', { mode: 'buffer' }),
    authorId: text('author_id')
      .notNull()
      .references((): AnySQLiteColumn => author.id, { onDelete: 'cascade', onUpdate: 'cascade' }),
    editorId: text('editor_id')
      .references((): AnySQLiteColumn => author.id, { onDelete: 'set null' }),
    seriesHandle: text('series_handle')
      .references(() => series.handle, { onDelete: 'set null' }),
  },
  (table) => [
    uniqueIndex('books_title_author_id_key').on(table.title, table.authorId),
    index('books_published_idx').on(table.publishedOn),
  ]
);

export type Book = typeof book.$inferSelect;
export type NewBook = typeof book.$inferInsert;

export const author = sqliteTable('authors', {
  id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  handle: text('handle').notNull().unique(),
  favouriteBookId: integer('favourite_book_id'),
  latestBookId: integer('latest_book_id')
    .references(() => book.id, { onDelete: 'set null' }),
});

export type Author = typeof author.$inferSelect;
export type NewAuthor = typeof author.$inferInsert;

export const audiobook = sqliteTable('audiobooks', {
  minutes: integer('minutes').notNull(),
  bookPtrId: integer('book_ptr_id')
    .primaryKey()
    .references(() => book.id, { onDelete: 'cascade' }),
});

export type Audiobook = typeof audiobook.$inferSelect;
export type NewAudiobook = typeof audiobook.$inferInsert;

export const index2 = sqliteTable('index_rows', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  sql: text('sql'),
  class: text('class'),
  table: integer('table').references(() => series.id),
});

export type Index = typeof index2.$inferSelect;
export type NewIndex = typeof index2.$inferInsert;

export const tagged = sqliteTable('tagged', {
  id: integer('id').primaryKey({ autoIncrement: true }),
});

export type Tagged = typeof tagged.$inferSelect;
export type NewTagged = typeof tagged.$inferInsert;

export const taggedBooks = sqliteTable(
  'tagged_books',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    taggedId: integer('tagged_id')
      .notNull()
      .references(() => tagged.id, { onDelete: 'cascade' }),
    bookId: integer('book_id')
      .notNull()
      .references(() => book.id, { onDelete: 'cascade' }),
  },
  (table) => [
    uniqueIndex('tagged_books_tagged_id_book_id_key').on(table.taggedId, table.bookId),
  ]
);

export type TaggedBooks = typeof taggedBooks.$inferSelect;
export type NewTaggedBooks = typeof taggedBooks.$inferInsert;

export const seriesRelations = relations(series, ({ one, many }) => ({
  parent: one(series, {
    fields: [series.parentId],
    references: [series.id],
    relationName: 'Series_parent',
  }),
  books: many(book),
  children: many(series, { relationName: 'Series_parent' }),
  indexes: many(index2),
}));

export const bookRelations = relations(book, ({ one, many }) => ({
  author: one(author, {
    fields: [book.authorId],
    references: [author.id],
    relationName: 'Book_author',
  }),
  editor: one(author, {
    fields: [book.editorId],
    references: [author.id],
    relationName: 'Book_editor',
  }),
  series: one(series, {
    fields: [book.seriesHandle],
    references: [series.handle],
  }),
  latestFor: many(author, { relationName: 'Author_latest_book' }),
  audiobook: one(audiobook),
  taggedBooks: many(taggedBooks),
}));

export const authorRelations = relations(author, ({ one, many }) => ({
  latestBook: one(book, {
    fields: [author.latestBookId],
    references: [book.id],
    relationName: 'Author_latest_book',
  }),
  books: many(book, { relationName: 'Book_author' }),
  editedBooks: many(book, { relationName: 'Book_editor' }),
}));

export const audiobookRelations = relations(audiobook, ({ one }) => ({
  book: one(book, {
    fields: [audiobook.bookPtrId],
    references: [book.id],
  }),
}));

export const index2Relations = relations(index2, ({ one }) => ({
  table2: one(series, {
    fields: [index2.table],
    references: [series.id],
  }),
}));

export const taggedRelations = relations(tagged, ({ many }) => ({
  taggedBooks: many(taggedBooks),
}));

export const taggedBooksRelations = relations(taggedBooks, ({ one }) => ({
  tagged: one(tagged, {
    fields: [taggedBooks.taggedId],
    references: [tagged.id],
  }),
  book: one(book, {
    fields: [taggedBooks.bookId],
    references: [book.id],
  }),
}));
