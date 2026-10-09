import { relations, sql } from 'drizzle-orm';
import {
  type AnyMySqlColumn,
  bigint,
  boolean,
  char,
  customType,
  date,
  datetime,
  decimal,
  double,
  index,
  int,
  json,
  mysqlEnum,
  mysqlTable,
  text,
  time,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/mysql-core';

const blob = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return 'blob';
  },
});

// color: red, green = Green
export const colorValues = ['red', 'green'] as const;
export type Color = (typeof colorValues)[number];

// Status: draft = Draft, live
export const statusValues = ['draft', 'live'] as const;
export type Status = (typeof statusValues)[number];

export const series = mysqlTable('series', {
  id: char('id', { length: 36 }).primaryKey().default(sql`(UUID())`),
  handle: varchar('handle', { length: 20 })
    .notNull()
    .unique('series_handle_uq'),
  createdAt: datetime('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: datetime('updated_at').notNull().$onUpdate(() => new Date()),
  parentId: char('parent_id', { length: 36 })
    .references((): AnyMySqlColumn => series.id, { onDelete: 'set null' }),
});

export type Series = typeof series.$inferSelect;
export type NewSeries = typeof series.$inferInsert;

export const book = mysqlTable(
  'book',
  {
    id: char('id', { length: 36 }).primaryKey().default(sql`(UUID())`),
    title: varchar('title', { length: 120 }).notNull(),
    tags: json('tags').$type<string[]>().notNull().default([]),
    grid: json('grid').$type<number[][]>(),
    colors: json('colors').$type<Color[]>(),
    color: mysqlEnum('color', colorValues).notNull().default('red'),
    price: decimal('price', { precision: 8, scale: 2 }).notNull().default('9.99'),
    settings: json('settings').notNull().default({ theme: 'dark', tabs: [1, 2] }),
    publishedOn: date('published_on', { mode: 'string' })
      .notNull()
      .default(sql`(CURRENT_DATE)`),
    opensAt: time('opens_at'),
    releasedAt: datetime('released_at').default(new Date('2020-01-02T03:04:05Z')),
    pages: int('pages').notNull().default(100),
    ratio: double('ratio').notNull().default(0.5),
    inPrint: boolean('in_print').notNull().default(true),
    notes: text('notes'),
    window: varchar('window', { length: 255 }),
    extra: json('extra').$type<Record<string, string | null>>(),
    readTime: bigint('read_time', { mode: 'number' }),
    cover: blob('cover'),
    createdAt: datetime('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: datetime('updated_at').notNull().$onUpdate(() => new Date()),
    authorId: char('author_id', { length: 36 })
      .notNull()
      .references((): AnyMySqlColumn => author.id, { onDelete: 'cascade', onUpdate: 'cascade' }),
    editorId: char('editor_id', { length: 36 })
      .references((): AnyMySqlColumn => author.id, { onDelete: 'set null' }),
    seriesHandle: varchar('series_handle', { length: 20 })
      .references(() => series.handle, { onDelete: 'set null' }),
  },
  (table) => [
    uniqueIndex('book_title_author_id_key').on(table.title, table.authorId),
    index('books_published_idx').on(table.publishedOn),
  ]
);

export type Book = typeof book.$inferSelect;
export type NewBook = typeof book.$inferInsert;

export const author = mysqlTable('author', {
  id: char('id', { length: 36 }).primaryKey().default(sql`(UUID())`),
  handle: varchar('handle', { length: 30 }).notNull().unique(),
  favouriteBookId: int('favourite_book_id'),
  createdAt: datetime('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: datetime('updated_at').notNull().$onUpdate(() => new Date()),
  latestBookId: char('latest_book_id', { length: 36 })
    .references(() => book.id, { onDelete: 'set null' }),
});

export type Author = typeof author.$inferSelect;
export type NewAuthor = typeof author.$inferInsert;

export const audiobook = mysqlTable('audiobook', {
  minutes: int('minutes').notNull(),
  createdAt: datetime('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: datetime('updated_at').notNull().$onUpdate(() => new Date()),
  bookPtrId: char('book_ptr_id', { length: 36 })
    .primaryKey()
    .references(() => book.id, { onDelete: 'cascade' }),
});

export type Audiobook = typeof audiobook.$inferSelect;
export type NewAudiobook = typeof audiobook.$inferInsert;

export const index2 = mysqlTable('index', {
  id: char('id', { length: 36 }).primaryKey().default(sql`(UUID())`),
  sql: varchar('sql', { length: 255 }),
  class: varchar('class', { length: 255 }),
  createdAt: datetime('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: datetime('updated_at').notNull().$onUpdate(() => new Date()),
  table: char('table', { length: 36 }).references(() => series.id),
});

export type Index = typeof index2.$inferSelect;
export type NewIndex = typeof index2.$inferInsert;

export const tagged = mysqlTable('tagged', {
  id: char('id', { length: 36 }).primaryKey().default(sql`(UUID())`),
  createdAt: datetime('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: datetime('updated_at').notNull().$onUpdate(() => new Date()),
});

export type Tagged = typeof tagged.$inferSelect;
export type NewTagged = typeof tagged.$inferInsert;

export const taggedBooks = mysqlTable(
  'tagged_book',
  {
    id: char('id', { length: 36 }).primaryKey().default(sql`(UUID())`),
    taggedId: char('tagged_id', { length: 36 })
      .notNull()
      .references(() => tagged.id, { onDelete: 'cascade' }),
    bookId: char('book_id', { length: 36 })
      .notNull()
      .references(() => book.id, { onDelete: 'cascade' }),
  },
  (table) => [
    uniqueIndex('tagged_book_tagged_id_book_id_key').on(table.taggedId, table.bookId),
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
