import { relations } from 'drizzle-orm';
import {
  type AnyPgColumn,
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

export const postStatusValues = ['draft', 'published'] as const;
export type PostStatus = (typeof postStatusValues)[number];
export const postStatusEnum = pgEnum('post_status', postStatusValues);

export const user = pgTable('user', {
  id: uuid('id').primaryKey().defaultRandom(),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .$onUpdate(() => new Date()),
});

export type User = typeof user.$inferSelect;
export type NewUser = typeof user.$inferInsert;

export const category = pgTable('category', {
  id: uuid('id').primaryKey().defaultRandom(),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .$onUpdate(() => new Date()),
  name: varchar('name', { length: 100 }).notNull().unique(),
  slug: varchar('slug', { length: 50 }).notNull(),
  parentId: uuid('parent_id')
    .references((): AnyPgColumn => category.id, { onDelete: 'set null' }),
});

export type Category = typeof category.$inferSelect;
export type NewCategory = typeof category.$inferInsert;

export const tag = pgTable('tag', {
  id: uuid('id').primaryKey().defaultRandom(),
  label: varchar('label', { length: 50 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .$onUpdate(() => new Date()),
});

export type Tag = typeof tag.$inferSelect;
export type NewTag = typeof tag.$inferInsert;

export const post = pgTable(
  'post',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .$onUpdate(() => new Date()),
    publicId: uuid('public_id').notNull().unique().defaultRandom(),
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
    authorId: uuid('author_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    editorId: uuid('editor_id')
      .references(() => user.id, { onDelete: 'set null' }),
    categoryId: uuid('category_id')
      .notNull()
      .references(() => category.id, { onDelete: 'restrict' }),
  },
  (table) => [
    uniqueIndex('post_author_id_title_key').on(table.authorId, table.title),
    index('post_title_idx').on(table.title),
    index('post_pub_status_idx').on(table.publishedAt, table.status),
  ]
);

export type Post = typeof post.$inferSelect;
export type NewPost = typeof post.$inferInsert;

export const profile = pgTable('profile', {
  id: uuid('id').primaryKey().defaultRandom(),
  bio: text('bio'),
  avatar: varchar('avatar', { length: 100 }),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .$onUpdate(() => new Date()),
  userId: uuid('user_id')
    .notNull()
    .unique()
    .references(() => user.id, { onDelete: 'cascade' }),
});

export type Profile = typeof profile.$inferSelect;
export type NewProfile = typeof profile.$inferInsert;

export const postTags = pgTable(
  'post_tag',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    postId: uuid('post_id')
      .notNull()
      .references(() => post.id, { onDelete: 'cascade' }),
    tagId: uuid('tag_id')
      .notNull()
      .references(() => tag.id, { onDelete: 'cascade' }),
  },
  (table) => [
    uniqueIndex('post_tag_post_id_tag_id_key').on(table.postId, table.tagId),
  ]
);

export type PostTags = typeof postTags.$inferSelect;
export type NewPostTags = typeof postTags.$inferInsert;

export const userRelations = relations(user, ({ one, many }) => ({
  posts: many(post, { relationName: 'Post_author' }),
  editedPosts: many(post, { relationName: 'Post_editor' }),
  profile: one(profile),
}));

export const categoryRelations = relations(category, ({ one, many }) => ({
  parent: one(category, {
    fields: [category.parentId],
    references: [category.id],
    relationName: 'Category_parent',
  }),
  children: many(category, { relationName: 'Category_parent' }),
  posts: many(post),
}));

export const tagRelations = relations(tag, ({ many }) => ({
  postTags: many(postTags),
}));

export const postRelations = relations(post, ({ one, many }) => ({
  author: one(user, {
    fields: [post.authorId],
    references: [user.id],
    relationName: 'Post_author',
  }),
  editor: one(user, {
    fields: [post.editorId],
    references: [user.id],
    relationName: 'Post_editor',
  }),
  category: one(category, {
    fields: [post.categoryId],
    references: [category.id],
  }),
  postTags: many(postTags),
}));

export const profileRelations = relations(profile, ({ one }) => ({
  user: one(user, {
    fields: [profile.userId],
    references: [user.id],
  }),
}));

export const postTagsRelations = relations(postTags, ({ one }) => ({
  post: one(post, {
    fields: [postTags.postId],
    references: [post.id],
  }),
  tag: one(tag, {
    fields: [postTags.tagId],
    references: [tag.id],
  }),
}));
