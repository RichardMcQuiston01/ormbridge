import { relations, sql } from 'drizzle-orm';
import {
  type AnyMySqlColumn,
  char,
  datetime,
  mysqlTable,
  varchar,
} from 'drizzle-orm/mysql-core';

// Status: draft = Draft, live
export const statusValues = ['draft', 'live'] as const;
export type Status = (typeof statusValues)[number];

export const otherValues = ['a'] as const;
export type Other = (typeof otherValues)[number];

export const other = mysqlTable('other', {
  id: char('id', { length: 36 }).primaryKey().default(sql`(UUID())`),
  createdAt: datetime('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: datetime('updated_at').notNull().$onUpdate(() => new Date()),
});

export type Other2 = typeof other.$inferSelect;
export type NewOther2 = typeof other.$inferInsert;

export const weird = mysqlTable('weird', {
  id: char('id', { length: 36 }).primaryKey().default(sql`(UUID())`),
  aB: varchar('a_b', { length: 255 }).notNull().default('x;y'),
  quote: varchar('quote', { length: 255 }).notNull().default('say "hi"'),
  tick: varchar('tick', { length: 255 }).notNull().default('a`b'),
  createdAt: datetime('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: datetime('updated_at').notNull().$onUpdate(() => new Date()),
  selfId: char('self_id', { length: 36 })
    .references((): AnyMySqlColumn => weird.id, { onDelete: 'set null' }),
  otherId: char('other_id', { length: 36 })
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
