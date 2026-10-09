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
  'accounts',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().autoincrement(),
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
    index('accounts_deleted_at_idx').on(table.deletedAt),
    index('accounts_email_status_idx').on(table.email, table.status),
  ]
);

export type Account = typeof account.$inferSelect;
export type NewAccount = typeof account.$inferInsert;

export const session = mysqlTable(
  'sessions',
  {
    id: char('id', { length: 36 }).primaryKey().default(sql`(UUID())`),
    token: char('token', { length: 36 }).default(sql`(UUID())`),
    deletedAt: datetime('deleted_at'),
    openedAt: datetime('opened_at').notNull().default(sql`CURRENT_TIMESTAMP`),
    accountId: bigint('account_id', { mode: 'number' })
      .references(() => account.id, { onDelete: 'set null', onUpdate: 'cascade' }),
  },
  (table) => [
    uniqueIndex('sessions_account_id_opened_at_key').on(table.accountId, table.openedAt),
  ]
);

export type Session = typeof session.$inferSelect;
export type NewSession = typeof session.$inferInsert;

export const group = mysqlTable('groups', {
  id: int('id').primaryKey().autoincrement(),
  name: varchar('name', { length: 40 }).notNull(),
});

export type Group = typeof group.$inferSelect;
export type NewGroup = typeof group.$inferInsert;

export const membership = mysqlTable(
  'memberships',
  {
    role: mysqlEnum('role', roleValues).notNull(),
    accountId: bigint('account_id', { mode: 'number' })
      .notNull()
      .references(() => account.id, { onDelete: 'cascade' }),
    groupId: int('group_id')
      .notNull()
      .references(() => group.id, { onDelete: 'restrict' }),
  },
  (table) => [
    primaryKey({ columns: [table.accountId, table.groupId] }),
  ]
);

export type Membership = typeof membership.$inferSelect;
export type NewMembership = typeof membership.$inferInsert;

export const profile = mysqlTable('profiles', {
  id: int('id').primaryKey().autoincrement(),
  bio: text('bio'),
  ownerAccountId: bigint('owner_account_id', { mode: 'number' })
    .notNull()
    .unique()
    .references(() => account.id, { onDelete: 'cascade' }),
});

export type Profile = typeof profile.$inferSelect;
export type NewProfile = typeof profile.$inferInsert;

export const legacyOrder = mysqlTable('LEGACY_ORDER', {
  orderNo: int('OrderNo').primaryKey(),
  type: varchar('kind', { length: 255 }).notNull(),
  httpCode: int('http_code').notNull(),
  firstName: varchar('first name', { length: 255 }),
  acct: bigint('acct', { mode: 'number' }).references(() => account.id),
});

export type LegacyOrder = typeof legacyOrder.$inferSelect;
export type NewLegacyOrder = typeof legacyOrder.$inferInsert;

export const groupFriends = mysqlTable(
  'groups_friends',
  {
    id: int('id').primaryKey().autoincrement(),
    fromGroupId: int('from_group_id')
      .notNull()
      .references(() => group.id, { onDelete: 'cascade' }),
    toGroupId: int('to_group_id')
      .notNull()
      .references(() => group.id, { onDelete: 'cascade' }),
  },
  (table) => [
    uniqueIndex('groups_friends_from_group_id_to_group_id_key').on(table.fromGroupId, table.toGroupId),
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
