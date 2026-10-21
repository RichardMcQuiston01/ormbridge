import {
  boolean,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

export const postStatusValues = ['draft', 'published'] as const;
export type PostStatus = (typeof postStatusValues)[number];
export const postStatusEnum = pgEnum('PostStatus', postStatusValues);

export const user = pgTable('User', {
  id: integer('id').primaryKey(),
});

export type User = typeof user.$inferSelect;
export type NewUser = typeof user.$inferInsert;

export const category = pgTable('Category', {
  id: integer('id').primaryKey(),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  name: varchar('name', { length: 100 }).notNull(),
  slug: varchar('slug', { length: 50 }).notNull(),
  parentId: integer('parent_id'),
});

export type Category = typeof category.$inferSelect;
export type NewCategory = typeof category.$inferInsert;

export const post = pgTable('Post', {
  id: integer('id').primaryKey(),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  publicId: uuid('public_id').notNull(),
  title: varchar('title', { length: 200 }).notNull(),
  body: text('body').notNull(),
  status: postStatusEnum('status').notNull().default('draft'),
  rating: numeric('rating', { precision: 4, scale: 2 }),
  viewCount: integer('view_count').notNull().default(0),
  isFeatured: boolean('is_featured').notNull().default(false),
  publishedAt: timestamp('published_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  metadata: jsonb('metadata').notNull().default({}),
  authorId: integer('author_id').notNull(),
  editorId: integer('editor_id'),
  categoryId: integer('category_id').notNull(),
});

export type Post = typeof post.$inferSelect;
export type NewPost = typeof post.$inferInsert;

export const tag = pgTable('Tag', {
  id: integer('id').primaryKey(),
  label: varchar('label', { length: 50 }).notNull(),
});

export type Tag = typeof tag.$inferSelect;
export type NewTag = typeof tag.$inferInsert;

export const postTags = pgTable('PostTags', {
  id: integer('id').primaryKey(),
  postId: integer('post_id').notNull(),
  tagId: integer('tag_id').notNull(),
});

export type PostTags = typeof postTags.$inferSelect;
export type NewPostTags = typeof postTags.$inferInsert;

export const profile = pgTable('Profile', {
  id: integer('id').primaryKey(),
  bio: text('bio'),
  avatar: varchar('avatar', { length: 100 }),
  userId: integer('user_id').notNull(),
});

export type Profile = typeof profile.$inferSelect;
export type NewProfile = typeof profile.$inferInsert;
