import { pgTable, serial, varchar } from 'drizzle-orm/pg-core';

export const tags = pgTable('blog_tag', {
  id: serial('id').primaryKey(),
  label: varchar('label', { length: 50 }).notNull(),
});
