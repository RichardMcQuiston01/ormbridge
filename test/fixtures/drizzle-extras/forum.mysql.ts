import { relations, sql } from 'drizzle-orm';
import {
  bigint,
  binary,
  boolean,
  decimal,
  index,
  int,
  json,
  longtext,
  mysqlEnum,
  mysqlTable,
  serial,
  timestamp,
  tinyint,
  uniqueIndex,
  varchar,
  year,
} from 'drizzle-orm/mysql-core';

export const accounts = mysqlTable(
  'forum_accounts',
  {
    id: int('id').primaryKey().autoincrement(),
    handle: varchar('handle', { length: 40 }).notNull(),
    kind: mysqlEnum('kind', ['member', 'moderator'])
      .notNull()
      .default('member'),
    karma: int('karma', { unsigned: true }).notNull().default(0),
    level: tinyint('level').notNull().default(1),
    isBanned: boolean('is_banned').notNull().default(false),
    settings: json('settings'),
    avatar: binary('avatar', { length: 16 }),
    joinedYear: year('joined_year'),
    balance: decimal('balance', { precision: 8, scale: 2 }),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow().onUpdateNow(),
  },
  (table) => [
    uniqueIndex('forum_accounts_handle_uq').on(table.handle),
    index('forum_accounts_kind_idx').on(table.kind, table.createdAt),
  ]
);

export const threads = mysqlTable('forum_threads', {
  id: serial('id').primaryKey(),
  accountId: bigint('account_id', { mode: 'number' })
    .notNull()
    .references(() => accounts.id, { onDelete: 'cascade' }),
  title: varchar('title', { length: 200 }).notNull(),
  body: longtext('body'),
  closedAt: timestamp('closed_at').default(sql`CURRENT_TIMESTAMP`),
});

export const accountsRelations = relations(accounts, ({ many }) => ({
  threads: many(threads),
}));

export const threadsRelations = relations(threads, ({ one }) => ({
  author: one(accounts, {
    fields: [threads.accountId],
    references: [accounts.id],
  }),
}));
