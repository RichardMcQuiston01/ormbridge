import { relations, sql } from 'drizzle-orm';
import {
  bigint,
  char,
  customType,
  date,
  datetime,
  decimal,
  double,
  index,
  int,
  json,
  mysqlEnum,
  mysqlTable,
  primaryKey,
  text,
  time,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/mysql-core';

const blob = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return 'blob';
  },
});

// Status: draft = Draft, live
export const statusValues = ['draft', 'live'] as const;
export type Status = (typeof statusValues)[number];

export const roleValues = ['owner', 'member'] as const;
export type Role = (typeof roleValues)[number];

export const account = mysqlTable(
  'account',
  {
    id: char('id', { length: 36 }).primaryKey().default(sql`(UUID())`),
    createdAt: datetime('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: datetime('updated_at').notNull().$onUpdate(() => new Date()),
    deletedAt: datetime('deleted_at'),
    email: varchar('email', { length: 255 }).notNull().unique(),
    balance: decimal('balance', { precision: 10, scale: 2 }).notNull(),
    score: double('score'),
    avatar: blob('avatar'),
    payload: json('payload'),
    labels: json('labels').$type<string[]>().notNull(),
    ttl: bigint('ttl', { mode: 'number' }),
    ip: varchar('ip', { length: 45 }),
    homepageUrl: varchar('homepage_url', { length: 255 }),
    born: date('born', { mode: 'string' }),
    alarm: time('alarm'),
    status: mysqlEnum('status', statusValues).notNull().default('draft'),
    note: text('note').notNull().default("it's; fine"),
  },
  (table) => [
    index('account_deleted_at_idx').on(table.deletedAt),
    index('account_email_status_idx').on(table.email, table.status),
  ]
);

export type Account = typeof account.$inferSelect;
export type NewAccount = typeof account.$inferInsert;

export const session = mysqlTable(
  'session',
  {
    id: char('id', { length: 36 }).primaryKey().default(sql`(UUID())`),
    token: char('token', { length: 36 }).default(sql`(UUID())`),
    deletedAt: datetime('deleted_at'),
    openedAt: datetime('opened_at').notNull().default(sql`CURRENT_TIMESTAMP`),
    createdAt: datetime('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: datetime('updated_at').notNull().$onUpdate(() => new Date()),
    accountId: char('account_id', { length: 36 })
      .references(() => account.id, { onDelete: 'set null', onUpdate: 'cascade' }),
  },
  (table) => [
    uniqueIndex('session_account_id_opened_at_key').on(table.accountId, table.openedAt),
  ]
);

export type Session = typeof session.$inferSelect;
export type NewSession = typeof session.$inferInsert;

export const group = mysqlTable('group', {
  id: char('id', { length: 36 }).primaryKey().default(sql`(UUID())`),
  name: varchar('name', { length: 40 }).notNull(),
  createdAt: datetime('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: datetime('updated_at').notNull().$onUpdate(() => new Date()),
});

export type Group = typeof group.$inferSelect;
export type NewGroup = typeof group.$inferInsert;

export const membership = mysqlTable(
  'membership',
  {
    role: mysqlEnum('role', roleValues).notNull(),
    createdAt: datetime('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: datetime('updated_at').notNull().$onUpdate(() => new Date()),
    accountId: char('account_id', { length: 36 })
      .notNull()
      .references(() => account.id, { onDelete: 'cascade' }),
    groupId: char('group_id', { length: 36 })
      .notNull()
      .references(() => group.id, { onDelete: 'restrict' }),
  },
  (table) => [
    primaryKey({ columns: [table.accountId, table.groupId] }),
  ]
);

export type Membership = typeof membership.$inferSelect;
export type NewMembership = typeof membership.$inferInsert;

export const profile = mysqlTable('profile', {
  id: char('id', { length: 36 }).primaryKey().default(sql`(UUID())`),
  bio: text('bio'),
  createdAt: datetime('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: datetime('updated_at').notNull().$onUpdate(() => new Date()),
  ownerAccountId: char('owner_account_id', { length: 36 })
    .notNull()
    .unique()
    .references(() => account.id, { onDelete: 'cascade' }),
});

export type Profile = typeof profile.$inferSelect;
export type NewProfile = typeof profile.$inferInsert;

export const legacyOrder = mysqlTable('legacy_order', {
  orderNo: int('order_no').primaryKey(),
  type: varchar('kind', { length: 255 }).notNull(),
  httpCode: int('http_code').notNull(),
  firstName: varchar('first_name', { length: 255 }),
  createdAt: datetime('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: datetime('updated_at').notNull().$onUpdate(() => new Date()),
  acct: char('acct', { length: 36 }).references(() => account.id),
});

export type LegacyOrder = typeof legacyOrder.$inferSelect;
export type NewLegacyOrder = typeof legacyOrder.$inferInsert;

export const groupFriends = mysqlTable(
  'group_friend',
  {
    id: char('id', { length: 36 }).primaryKey().default(sql`(UUID())`),
    fromGroupId: char('from_group_id', { length: 36 })
      .notNull()
      .references(() => group.id, { onDelete: 'cascade' }),
    toGroupId: char('to_group_id', { length: 36 })
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
