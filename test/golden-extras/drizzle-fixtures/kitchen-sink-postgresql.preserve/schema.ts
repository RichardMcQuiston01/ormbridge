import { relations } from 'drizzle-orm';
import {
  bigint,
  bigserial,
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
  serial,
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
export const statusEnum = pgEnum('Status', statusValues);

export const roleValues = ['owner', 'member'] as const;
export type Role = (typeof roleValues)[number];
export const roleEnum = pgEnum('Role', roleValues);

export const account = pgTable(
  'accounts',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
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
    index('accounts_deleted_at_idx').on(table.deletedAt),
    index('accounts_email_status_idx').on(table.email, table.status),
  ]
);

export type Account = typeof account.$inferSelect;
export type NewAccount = typeof account.$inferInsert;

export const session = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    token: uuid('token').defaultRandom(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    openedAt: timestamp('opened_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    accountId: bigint('account_id', { mode: 'number' })
      .references(() => account.id, { onDelete: 'set null', onUpdate: 'cascade' }),
  },
  (table) => [
    uniqueIndex('sessions_account_id_opened_at_key').on(table.accountId, table.openedAt),
  ]
);

export type Session = typeof session.$inferSelect;
export type NewSession = typeof session.$inferInsert;

export const group = pgTable('groups', {
  id: serial('id').primaryKey(),
  name: varchar('name', { length: 40 }).notNull(),
});

export type Group = typeof group.$inferSelect;
export type NewGroup = typeof group.$inferInsert;

export const membership = pgTable(
  'memberships',
  {
    role: roleEnum('role').notNull(),
    accountId: bigint('account_id', { mode: 'number' })
      .notNull()
      .references(() => account.id, { onDelete: 'cascade' }),
    groupId: integer('group_id')
      .notNull()
      .references(() => group.id, { onDelete: 'restrict' }),
  },
  (table) => [
    primaryKey({ columns: [table.accountId, table.groupId] }),
  ]
);

export type Membership = typeof membership.$inferSelect;
export type NewMembership = typeof membership.$inferInsert;

export const profile = pgTable('profiles', {
  id: serial('id').primaryKey(),
  bio: text('bio'),
  ownerAccountId: bigint('owner_account_id', { mode: 'number' })
    .notNull()
    .unique()
    .references(() => account.id, { onDelete: 'cascade' }),
});

export type Profile = typeof profile.$inferSelect;
export type NewProfile = typeof profile.$inferInsert;

export const legacyOrder = pgTable('LEGACY_ORDER', {
  orderNo: integer('OrderNo').primaryKey(),
  type: text('kind').notNull(),
  httpCode: integer('http_code').notNull(),
  firstName: text('first name'),
  acct: bigint('acct', { mode: 'number' }).references(() => account.id),
});

export type LegacyOrder = typeof legacyOrder.$inferSelect;
export type NewLegacyOrder = typeof legacyOrder.$inferInsert;

export const groupFriends = pgTable(
  'groups_friends',
  {
    id: serial('id').primaryKey(),
    fromGroupId: integer('from_group_id')
      .notNull()
      .references(() => group.id, { onDelete: 'cascade' }),
    toGroupId: integer('to_group_id')
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
