import { timestamp } from 'drizzle-orm/pg-core';

/** Columns shared by several tables, spread into their definitions. */
export const timeStamped = {
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
};
