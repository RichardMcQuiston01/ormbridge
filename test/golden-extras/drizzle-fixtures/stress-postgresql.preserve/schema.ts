import { relations } from 'drizzle-orm';
import {
  type AnyPgColumn,
  integer,
  pgEnum,
  pgTable,
  serial,
  text,
} from 'drizzle-orm/pg-core';

// Status: draft = Draft, live
export const statusValues = ['draft', 'live'] as const;
export type Status = (typeof statusValues)[number];
export const statusEnum = pgEnum('Status', statusValues);

export const otherValues = ['a'] as const;
export type Other = (typeof otherValues)[number];
export const otherEnum = pgEnum('Other', otherValues);

export const other = pgTable('others', {
  id: serial('id').primaryKey(),
});

export type Other2 = typeof other.$inferSelect;
export type NewOther2 = typeof other.$inferInsert;

export const weird = pgTable('weird', {
  id: serial('id').primaryKey(),
  aB: text('a;b').notNull().default('x;y'),
  quote: text('quote').notNull().default('say "hi"'),
  tick: text('tick').notNull().default('a`b'),
  selfId: integer('self_id')
    .references((): AnyPgColumn => weird.id, { onDelete: 'set null' }),
  otherId: integer('other_id')
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
