import { integer, pgTable, serial, text, varchar } from 'drizzle-orm/pg-core';
import { users } from './user.schema';

export const profiles = pgTable('blog_profile', {
  id: serial('id').primaryKey(),
  userId: integer('user_id')
    .notNull()
    .unique()
    .references(() => users.id, { onDelete: 'cascade' }),
  bio: text('bio'),
  avatar: varchar('avatar', { length: 100 }),
});
