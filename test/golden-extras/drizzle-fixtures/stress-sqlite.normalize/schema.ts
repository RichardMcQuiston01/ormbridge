import { relations, sql } from 'drizzle-orm';
import {
  type AnySQLiteColumn,
  integer,
  sqliteTable,
  text,
} from 'drizzle-orm/sqlite-core';

// Status: draft = Draft, live
export const statusValues = ['draft', 'live'] as const;
export type Status = (typeof statusValues)[number];

export const otherValues = ['a'] as const;
export type Other = (typeof otherValues)[number];

export const other = sqliteTable('other', {
  id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
  updatedAt: integer('updated_at', { mode: 'timestamp' })
    .notNull()
    .$onUpdate(() => new Date()),
});

export type Other2 = typeof other.$inferSelect;
export type NewOther2 = typeof other.$inferInsert;

export const weird = sqliteTable('weird', {
  id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  aB: text('a_b').notNull().default('x;y'),
  quote: text('quote').notNull().default('say "hi"'),
  tick: text('tick').notNull().default('a`b'),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
  updatedAt: integer('updated_at', { mode: 'timestamp' })
    .notNull()
    .$onUpdate(() => new Date()),
  selfId: text('self_id')
    .references((): AnySQLiteColumn => weird.id, { onDelete: 'set null' }),
  otherId: text('other_id')
    .notNull()
    .references(() => other.id, { onDelete: 'cascade' }),
});

export type Weird = typeof weird.$inferSelect;
export type NewWeird = typeof weird.$inferInsert;

export const otherRelations = relations(other, ({ many }) => ({
  weirds: many(weird),
}));

export const weirdRelations = relations(weird, ({ one, many }) => ({
  self: one(weird, {
    fields: [weird.selfId],
    references: [weird.id],
    relationName: 'Weird_self',
  }),
  other: one(other, {
    fields: [weird.otherId],
    references: [other.id],
  }),
  weirds: many(weird, { relationName: 'Weird_self' }),
}));
