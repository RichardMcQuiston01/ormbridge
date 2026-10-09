import { relations, sql } from 'drizzle-orm';
import {
  blob,
  index,
  integer,
  numeric,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

// Status: draft = Draft, live
export const statusValues = ['draft', 'live'] as const;
export type Status = (typeof statusValues)[number];

export const roleValues = ['owner', 'member'] as const;
export type Role = (typeof roleValues)[number];

export const account = sqliteTable(
  'account',
  {
    id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
    updatedAt: integer('updated_at', { mode: 'timestamp' })
      .notNull()
      .$onUpdate(() => new Date()),
    deletedAt: integer('deleted_at', { mode: 'timestamp' }),
    email: text('email').notNull().unique(),
    balance: numeric('balance').notNull(),
    score: real('score'),
    avatar: blob('avatar', { mode: 'buffer' }),
    payload: text('payload', { mode: 'json' }),
    labels: text('labels', { mode: 'json' }).$type<string[]>().notNull(),
    ttl: integer('ttl'),
    ip: text('ip'),
    homepageUrl: text('homepage_url'),
    born: text('born'),
    alarm: text('alarm'),
    status: text('status', { enum: statusValues }).notNull().default('draft'),
    note: text('note').notNull().default("it's; fine"),
  },
  (table) => [
    index('account_deleted_at_idx').on(table.deletedAt),
    index('account_email_status_idx').on(table.email, table.status),
  ]
);

export type Account = typeof account.$inferSelect;
export type NewAccount = typeof account.$inferInsert;

export const session = sqliteTable(
  'session',
  {
    id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
    token: text('token').$defaultFn(() => crypto.randomUUID()),
    deletedAt: integer('deleted_at', { mode: 'timestamp' }),
    openedAt: integer('opened_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
    updatedAt: integer('updated_at', { mode: 'timestamp' })
      .notNull()
      .$onUpdate(() => new Date()),
    accountId: text('account_id')
      .references(() => account.id, { onDelete: 'set null', onUpdate: 'cascade' }),
  },
  (table) => [
    uniqueIndex('session_account_id_opened_at_key').on(table.accountId, table.openedAt),
  ]
);

export type Session = typeof session.$inferSelect;
export type NewSession = typeof session.$inferInsert;

export const group = sqliteTable('group', {
  id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  name: text('name').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
  updatedAt: integer('updated_at', { mode: 'timestamp' })
    .notNull()
    .$onUpdate(() => new Date()),
});

export type Group = typeof group.$inferSelect;
export type NewGroup = typeof group.$inferInsert;

export const membership = sqliteTable(
  'membership',
  {
    role: text('role', { enum: roleValues }).notNull(),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
    updatedAt: integer('updated_at', { mode: 'timestamp' })
      .notNull()
      .$onUpdate(() => new Date()),
    accountId: text('account_id')
      .notNull()
      .references(() => account.id, { onDelete: 'cascade' }),
    groupId: text('group_id')
      .notNull()
      .references(() => group.id, { onDelete: 'restrict' }),
  },
  (table) => [
    primaryKey({ columns: [table.accountId, table.groupId] }),
  ]
);

export type Membership = typeof membership.$inferSelect;
export type NewMembership = typeof membership.$inferInsert;

export const profile = sqliteTable('profile', {
  id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  bio: text('bio'),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
  updatedAt: integer('updated_at', { mode: 'timestamp' })
    .notNull()
    .$onUpdate(() => new Date()),
  ownerAccountId: text('owner_account_id')
    .notNull()
    .unique()
    .references(() => account.id, { onDelete: 'cascade' }),
});

export type Profile = typeof profile.$inferSelect;
export type NewProfile = typeof profile.$inferInsert;

export const legacyOrder = sqliteTable('legacy_order', {
  orderNo: integer('order_no').primaryKey(),
  type: text('kind').notNull(),
  httpCode: integer('http_code').notNull(),
  firstName: text('first_name'),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
  updatedAt: integer('updated_at', { mode: 'timestamp' })
    .notNull()
    .$onUpdate(() => new Date()),
  acct: text('acct').references(() => account.id),
});

export type LegacyOrder = typeof legacyOrder.$inferSelect;
export type NewLegacyOrder = typeof legacyOrder.$inferInsert;

export const groupFriends = sqliteTable(
  'group_friend',
  {
    id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
    fromGroupId: text('from_group_id')
      .notNull()
      .references(() => group.id, { onDelete: 'cascade' }),
    toGroupId: text('to_group_id')
      .notNull()
      .references(() => group.id, { onDelete: 'cascade' }),
  },
  (table) => [
    uniqueIndex('group_friend_from_group_id_to_group_id_key').on(table.fromGroupId, table.toGroupId),
  ]
);

export type GroupFriends = typeof groupFriends.$inferSelect;
export type NewGroupFriends = typeof groupFriends.$inferInsert;

export const accountRelations = relations(account, ({ one, many }) => ({
  sessions: many(session),
  memberships: many(membership),
  profile: one(profile),
  legacyOrders: many(legacyOrder),
}));

export const sessionRelations = relations(session, ({ one }) => ({
  account: one(account, {
    fields: [session.accountId],
    references: [account.id],
  }),
}));

export const groupRelations = relations(group, ({ many }) => ({
  memberships: many(membership),
  groupFriendsFromGroup: many(groupFriends, { relationName: 'GroupFriends_from_group' }),
  groupFriendsToGroup: many(groupFriends, { relationName: 'GroupFriends_to_group' }),
}));

export const membershipRelations = relations(membership, ({ one }) => ({
  account: one(account, {
    fields: [membership.accountId],
    references: [account.id],
  }),
  group: one(group, {
    fields: [membership.groupId],
    references: [group.id],
  }),
}));

export const profileRelations = relations(profile, ({ one }) => ({
  owner: one(account, {
    fields: [profile.ownerAccountId],
    references: [account.id],
  }),
}));

export const legacyOrderRelations = relations(legacyOrder, ({ one }) => ({
  owner: one(account, {
    fields: [legacyOrder.acct],
    references: [account.id],
  }),
}));

export const groupFriendsRelations = relations(groupFriends, ({ one }) => ({
  fromGroup: one(group, {
    fields: [groupFriends.fromGroupId],
    references: [group.id],
    relationName: 'GroupFriends_from_group',
  }),
  toGroup: one(group, {
    fields: [groupFriends.toGroupId],
    references: [group.id],
    relationName: 'GroupFriends_to_group',
  }),
}));
