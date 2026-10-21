import { sql } from 'drizzle-orm';
import { integer, numeric, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const postStatusValues = ['draft', 'published'] as const;
export type PostStatus = (typeof postStatusValues)[number];

export const user = sqliteTable('User', {
  id: integer('id').primaryKey(),
});

export type User = typeof user.$inferSelect;
export type NewUser = typeof user.$inferInsert;

export const category = sqliteTable('Category', {
  id: integer('id').primaryKey(),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
  name: text('name').notNull(),
  slug: text('slug').notNull(),
  parentId: integer('parent_id'),
});

export type Category = typeof category.$inferSelect;
export type NewCategory = typeof category.$inferInsert;

export const post = sqliteTable('Post', {
  id: integer('id').primaryKey(),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
  publicId: text('public_id').notNull(),
  title: text('title').notNull(),
  body: text('body').notNull(),
  status: text('status', { enum: postStatusValues }).notNull().default('draft'),
  rating: numeric('rating'),
  viewCount: integer('view_count').notNull().default(0),
  isFeatured: integer('is_featured', { mode: 'boolean' })
    .notNull()
    .default(false),
  publishedAt: integer('published_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
  metadata: text('metadata', { mode: 'json' }).notNull().default({}),
  authorId: integer('author_id').notNull(),
  editorId: integer('editor_id'),
  categoryId: integer('category_id').notNull(),
});

export type Post = typeof post.$inferSelect;
export type NewPost = typeof post.$inferInsert;

export const tag = sqliteTable('Tag', {
  id: integer('id').primaryKey(),
  label: text('label').notNull(),
});

export type Tag = typeof tag.$inferSelect;
export type NewTag = typeof tag.$inferInsert;

export const postTags = sqliteTable('PostTags', {
  id: integer('id').primaryKey(),
  postId: integer('post_id').notNull(),
  tagId: integer('tag_id').notNull(),
});

export type PostTags = typeof postTags.$inferSelect;
export type NewPostTags = typeof postTags.$inferInsert;

export const profile = sqliteTable('Profile', {
  id: integer('id').primaryKey(),
  bio: text('bio'),
  avatar: text('avatar'),
  userId: integer('user_id').notNull(),
});

export type Profile = typeof profile.$inferSelect;
export type NewProfile = typeof profile.$inferInsert;
