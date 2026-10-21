import { sql } from 'drizzle-orm';
import {
  boolean,
  char,
  datetime,
  decimal,
  int,
  json,
  mysqlEnum,
  mysqlTable,
  text,
  varchar,
} from 'drizzle-orm/mysql-core';

export const postStatusValues = ['draft', 'published'] as const;
export type PostStatus = (typeof postStatusValues)[number];

export const user = mysqlTable('user', {
  id: int('id').primaryKey(),
  createdAt: datetime('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: datetime('updated_at').notNull().$onUpdate(() => new Date()),
});

export type User = typeof user.$inferSelect;
export type NewUser = typeof user.$inferInsert;

export const category = mysqlTable('category', {
  id: int('id').primaryKey(),
  createdAt: datetime('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: datetime('updated_at').notNull(),
  name: varchar('name', { length: 100 }).notNull(),
  slug: varchar('slug', { length: 50 }).notNull(),
  parentId: int('parent_id'),
});

export type Category = typeof category.$inferSelect;
export type NewCategory = typeof category.$inferInsert;

export const post = mysqlTable('post', {
  id: int('id').primaryKey(),
  createdAt: datetime('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: datetime('updated_at').notNull(),
  publicId: char('public_id', { length: 36 }).notNull(),
  title: varchar('title', { length: 200 }).notNull(),
  body: text('body').notNull(),
  status: mysqlEnum('status', postStatusValues).notNull().default('draft'),
  rating: decimal('rating', { precision: 4, scale: 2 }),
  viewCount: int('view_count').notNull().default(0),
  isFeatured: boolean('is_featured').notNull().default(false),
  publishedAt: datetime('published_at')
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
  metadata: json('metadata').notNull().default({}),
  authorId: int('author_id').notNull(),
  editorId: int('editor_id'),
  categoryId: int('category_id').notNull(),
});

export type Post = typeof post.$inferSelect;
export type NewPost = typeof post.$inferInsert;

export const tag = mysqlTable('tag', {
  id: int('id').primaryKey(),
  label: varchar('label', { length: 50 }).notNull(),
  createdAt: datetime('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: datetime('updated_at').notNull().$onUpdate(() => new Date()),
});

export type Tag = typeof tag.$inferSelect;
export type NewTag = typeof tag.$inferInsert;

export const postTags = mysqlTable('post_tag', {
  id: int('id').primaryKey(),
  postId: int('post_id').notNull(),
  tagId: int('tag_id').notNull(),
  createdAt: datetime('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: datetime('updated_at').notNull().$onUpdate(() => new Date()),
});

export type PostTags = typeof postTags.$inferSelect;
export type NewPostTags = typeof postTags.$inferInsert;

export const profile = mysqlTable('profile', {
  id: int('id').primaryKey(),
  bio: text('bio'),
  avatar: varchar('avatar', { length: 100 }),
  userId: int('user_id').notNull(),
  createdAt: datetime('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: datetime('updated_at').notNull().$onUpdate(() => new Date()),
});

export type Profile = typeof profile.$inferSelect;
export type NewProfile = typeof profile.$inferInsert;
