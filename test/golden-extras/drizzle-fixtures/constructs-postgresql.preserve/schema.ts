import { relations, sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  bigint,
  bigserial,
  boolean,
  customType,
  date,
  doublePrecision,
  index,
  integer,
  interval,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  serial,
  text,
  time,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return 'bytea';
  },
});

const hstore = customType<{ data: string; driverData: string }>({
  dataType() {
    return 'hstore';
  },
});

const int4range = customType<{ data: string; driverData: string }>({
  dataType() {
    return 'int4range';
  },
});

// color: red, green = Green
export const colorValues = ['red', 'green'] as const;
export type Color = (typeof colorValues)[number];
export const colorEnum = pgEnum('color_t', colorValues);

// Status: draft = Draft, live
export const statusValues = ['draft', 'live'] as const;
export type Status = (typeof statusValues)[number];
export const statusEnum = pgEnum('Status', statusValues);

export const series = pgTable('series', {
  id: serial('id').primaryKey(),
  handle: varchar('handle', { length: 20 })
    .notNull()
    .unique('series_handle_uq'),
  parentId: integer('parent_id')
    .references((): AnyPgColumn => series.id, { onDelete: 'set null' }),
});

export type Series = typeof series.$inferSelect;
export type NewSeries = typeof series.$inferInsert;

export const book = pgTable(
  'books',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    title: varchar('title', { length: 120 }).notNull(),
    tags: text('tags').array().notNull().default([]),
    grid: integer('grid').array().array(),
    colors: colorEnum('colors').array(),
    color: colorEnum('color').notNull().default('red'),
    price: numeric('price', { precision: 8, scale: 2 }).notNull().default('9.99'),
    settings: jsonb('settings')
      .notNull()
      .default({ theme: 'dark', tabs: [1, 2] }),
    publishedOn: date('published_on', { mode: 'string' })
      .notNull()
      .default(sql`CURRENT_DATE`),
    opensAt: time('opens_at'),
    releasedAt: timestamp('released_at', { withTimezone: true })
      .default(new Date('2020-01-02T03:04:05Z')),
    pages: integer('pages').notNull().default(100),
    ratio: doublePrecision('ratio').notNull().default(0.5),
    inPrint: boolean('in_print').notNull().default(true),
    notes: text('notes'),
    window: int4range('window'),
    extra: hstore('extra'),
    readTime: interval('read_time'),
    cover: bytea('cover'),
    authorId: uuid('author_id')
      .notNull()
      .references((): AnyPgColumn => author.id, { onDelete: 'cascade', onUpdate: 'cascade' }),
    editorId: uuid('editor_id')
      .references((): AnyPgColumn => author.id, { onDelete: 'set null' }),
    seriesHandle: varchar('series_handle', { length: 20 })
      .references(() => series.handle, { onDelete: 'set null' }),
  },
  (table) => [
    uniqueIndex('books_title_author_id_key').on(table.title, table.authorId),
    index('books_published_idx').on(table.publishedOn),
  ]
);

export type Book = typeof book.$inferSelect;
export type NewBook = typeof book.$inferInsert;

export const author = pgTable('authors', {
  id: uuid('id').primaryKey().defaultRandom(),
  handle: varchar('handle', { length: 30 }).notNull().unique(),
  favouriteBookId: integer('favourite_book_id'),
  latestBookId: bigint('latest_book_id', { mode: 'number' })
    .references(() => book.id, { onDelete: 'set null' }),
});

export type Author = typeof author.$inferSelect;
export type NewAuthor = typeof author.$inferInsert;

export const audiobook = pgTable('audiobooks', {
  minutes: integer('minutes').notNull(),
  bookPtrId: bigint('book_ptr_id', { mode: 'number' })
    .primaryKey()
    .references(() => book.id, { onDelete: 'cascade' }),
});

export type Audiobook = typeof audiobook.$inferSelect;
export type NewAudiobook = typeof audiobook.$inferInsert;

export const index2 = pgTable('index_rows', {
  id: serial('id').primaryKey(),
  sql: text('sql'),
  class: text('class'),
  table: integer('table').references(() => series.id),
});

export type Index = typeof index2.$inferSelect;
export type NewIndex = typeof index2.$inferInsert;

export const tagged = pgTable('tagged', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
});

export type Tagged = typeof tagged.$inferSelect;
export type NewTagged = typeof tagged.$inferInsert;

export const taggedBooks = pgTable(
  'tagged_books',
  {
    id: serial('id').primaryKey(),
    taggedId: bigint('tagged_id', { mode: 'number' })
      .notNull()
      .references(() => tagged.id, { onDelete: 'cascade' }),
    bookId: bigint('book_id', { mode: 'number' })
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
