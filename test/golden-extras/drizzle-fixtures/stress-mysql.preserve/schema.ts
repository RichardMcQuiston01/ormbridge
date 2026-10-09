import { relations } from 'drizzle-orm';
import {
  type AnyMySqlColumn,
  int,
  mysqlTable,
  varchar,
} from 'drizzle-orm/mysql-core';

// Status: draft = Draft, live
export const statusValues = ['draft', 'live'] as const;
export type Status = (typeof statusValues)[number];

export const otherValues = ['a'] as const;
export type Other = (typeof otherValues)[number];

export const other = mysqlTable('others', {
  id: int('id').primaryKey().autoincrement(),
});

export type Other2 = typeof other.$inferSelect;
export type NewOther2 = typeof other.$inferInsert;

export const weird = mysqlTable('weird', {
  id: int('id').primaryKey().autoincrement(),
  aB: varchar('a;b', { length: 255 }).notNull().default('x;y'),
  quote: varchar('quote', { length: 255 }).notNull().default('say "hi"'),
  tick: varchar('tick', { length: 255 }).notNull().default('a`b'),
  selfId: int('self_id')
    .references((): AnyMySqlColumn => weird.id, { onDelete: 'set null' }),
  otherId: int('other_id')
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
