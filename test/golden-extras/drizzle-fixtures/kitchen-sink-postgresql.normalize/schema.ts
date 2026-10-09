import { relations } from 'drizzle-orm';
import {
  customType,
  date,
  doublePrecision,
  index,
  inet,
  integer,
  interval,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  time,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return 'bytea';
  },
});

// Status: draft = Draft, live
export const statusValues = ['draft', 'live'] as const;
export type Status = (typeof statusValues)[number];
export const statusEnum = pgEnum('status', statusValues);

export const roleValues = ['owner', 'member'] as const;
export type Role = (typeof roleValues)[number];
export const roleEnum = pgEnum('role', roleValues);

export const account = pgTable(
  'account',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .$onUpdate(() => new Date()),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    email: varchar('email', { length: 255 }).notNull().unique(),
    balance: numeric('balance', { precision: 10, scale: 2 }).notNull(),
    score: doublePrecision('score'),
    avatar: bytea('avatar'),
    payload: jsonb('payload'),
    labels: text('labels').array().notNull(),
    ttl: interval('ttl'),
    ip: inet('ip'),
    homepageUrl: text('homepage_url'),
    born: date('born', { mode: 'string' }),
    alarm: time('alarm'),
    status: statusEnum('status').notNull().default('draft'),
    note: text('note').notNull().default("it's; fine"),
  },
  (table) => [
    index('account_deleted_at_idx').on(table.deletedAt),
    index('account_email_status_idx').on(table.email, table.status),
  ]
);

export type Account = typeof account.$inferSelect;
export type NewAccount = typeof account.$inferInsert;

export const session = pgTable(
  'session',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    token: uuid('token').defaultRandom(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    openedAt: timestamp('opened_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .$onUpdate(() => new Date()),
    accountId: uuid('account_id')
      .references(() => account.id, { onDelete: 'set null', onUpdate: 'cascade' }),
  },
  (table) => [
    uniqueIndex('session_account_id_opened_at_key').on(table.accountId, table.openedAt),
  ]
);

export type Session = typeof session.$inferSelect;
export type NewSession = typeof session.$inferInsert;

export const group = pgTable('group', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: varchar('name', { length: 40 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .$onUpdate(() => new Date()),
});

export type Group = typeof group.$inferSelect;
export type NewGroup = typeof group.$inferInsert;

export const membership = pgTable(
  'membership',
  {
    role: roleEnum('role').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .$onUpdate(() => new Date()),
    accountId: uuid('account_id')
      .notNull()
      .references(() => account.id, { onDelete: 'cascade' }),
    groupId: uuid('group_id')
      .notNull()
      .references(() => group.id, { onDelete: 'restrict' }),
  },
  (table) => [
    primaryKey({ columns: [table.accountId, table.groupId] }),
  ]
);

export type Membership = typeof membership.$inferSelect;
export type NewMembership = typeof membership.$inferInsert;

export const profile = pgTable('profile', {
  id: uuid('id').primaryKey().defaultRandom(),
  bio: text('bio'),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .$onUpdate(() => new Date()),
  ownerAccountId: uuid('owner_account_id')
    .notNull()
    .unique()
    .references(() => account.id, { onDelete: 'cascade' }),
});

export type Profile = typeof profile.$inferSelect;
export type NewProfile = typeof profile.$inferInsert;

export const legacyOrder = pgTable('legacy_order', {
  orderNo: integer('order_no').primaryKey(),
  type: text('kind').notNull(),
  httpCode: integer('http_code').notNull(),
  firstName: text('first_name'),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .$onUpdate(() => new Date()),
  acct: uuid('acct').references(() => account.id),
});

export type LegacyOrder = typeof legacyOrder.$inferSelect;
export type NewLegacyOrder = typeof legacyOrder.$inferInsert;

export const groupFriends = pgTable(
  'group_friend',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    fromGroupId: uuid('from_group_id')
      .notNull()
      .references(() => group.id, { onDelete: 'cascade' }),
    toGroupId: uuid('to_group_id')
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
