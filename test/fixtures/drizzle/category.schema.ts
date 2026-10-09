import { integer, pgTable, serial, varchar } from 'drizzle-orm/pg-core';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { timeStamped } from './time-stamped';

export const categories = pgTable('blog_category', {
  id: serial('id').primaryKey(),
  ...timeStamped,
  name: varchar('name', { length: 100 }).notNull().unique(),
  slug: varchar('slug', { length: 50 }).notNull(),
  parentId: integer('parent_id').references((): AnyPgColumn => categories.id, {
    onDelete: 'set null',
  }),
});
