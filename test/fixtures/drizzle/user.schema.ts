import { pgTable, serial } from 'drizzle-orm/pg-core';

export const users = pgTable('auth_user', {
  id: serial('id').primaryKey(),
});
