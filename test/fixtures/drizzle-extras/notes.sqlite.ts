import { relations, sql } from 'drizzle-orm';
import {
  blob,
  index,
  integer,
  numeric,
  real,
  sqliteTable,
  text,
} from 'drizzle-orm/sqlite-core';
import type { AnySQLiteColumn } from 'drizzle-orm/sqlite-core';

export const notes = sqliteTable(
  'lite_notes',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    title: text('title', { length: 120 }).notNull(),
    body: text('body'),
    payload: text('payload', { mode: 'json' }),
    done: integer('done', { mode: 'boolean' }).notNull().default(false),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
    score: real('score').default(0.5),
    cost: numeric('cost'),
    thumbnail: blob('thumbnail', { mode: 'buffer' }),
    parentId: integer('parent_id').references((): AnySQLiteColumn => notes.id, {
      onDelete: 'set null',
    }),
  },
  (table) => [index('lite_notes_title_idx').on(table.title)]
);

export const attachments = sqliteTable('lite_attachments', {
  noteId: integer('note_id')
    .primaryKey()
    .references(() => notes.id, { onDelete: 'cascade' }),
  path: text('path').notNull(),
});

export const notesRelations = relations(notes, ({ one, many }) => ({
  parent: one(notes, {
    fields: [notes.parentId],
    references: [notes.id],
    relationName: 'note_tree',
  }),
  children: many(notes, { relationName: 'note_tree' }),
  attachment: one(attachments),
}));
