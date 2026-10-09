import { relations, sql } from 'drizzle-orm';
import {
  type AnyMySqlColumn,
  boolean,
  char,
  datetime,
  decimal,
  index,
  int,
  json,
  mysqlEnum,
  mysqlTable,
  text,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/mysql-core';

// PostStatus: draft = Draft, published = Published
export const postStatusValues = ['draft', 'published'] as const;
export type PostStatus = (typeof postStatusValues)[number];

export const category = mysqlTable('category', {
  id: char('id', { length: 36 }).primaryKey().default(sql`(UUID())`),
  createdAt: datetime('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: datetime('updated_at').notNull().$onUpdate(() => new Date()),
  name: varchar('name', { length: 100 }).notNull().unique(),
  slug: varchar('slug', { length: 50 }).notNull(),
  parentId: char('parent_id', { length: 36 })
    .references((): AnyMySqlColumn => category.id, { onDelete: 'set null' }),
});

export type Category = typeof category.$inferSelect;
export type NewCategory = typeof category.$inferInsert;

export const user = mysqlTable('user', {
  id: char('id', { length: 36 }).primaryKey().default(sql`(UUID())`),
  createdAt: datetime('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: datetime('updated_at').notNull().$onUpdate(() => new Date()),
});

export type User = typeof user.$inferSelect;
export type NewUser = typeof user.$inferInsert;

export const post = mysqlTable(
  'post',
  {
    id: char('id', { length: 36 }).primaryKey().default(sql`(UUID())`),
    createdAt: datetime('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: datetime('updated_at').notNull().$onUpdate(() => new Date()),
    publicId: char('public_id', { length: 36 })
      .notNull()
      .unique()
      .default(sql`(UUID())`),
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
    authorId: char('author_id', { length: 36 })
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    editorId: char('editor_id', { length: 36 })
      .references(() => user.id, { onDelete: 'set null' }),
    categoryId: char('category_id', { length: 36 })
      .notNull()
      .references(() => category.id, { onDelete: 'restrict' }),
  },
  (table) => [
    index('post_title_idx').on(table.title),
    uniqueIndex('post_author_id_title_key').on(table.authorId, table.title),
    index('post_pub_status_idx').on(table.publishedAt, table.status),
  ]
);

export type Post = typeof post.$inferSelect;
export type NewPost = typeof post.$inferInsert;

export const tag = mysqlTable('tag', {
  id: char('id', { length: 36 }).primaryKey().default(sql`(UUID())`),
  label: varchar('label', { length: 50 }).notNull(),
  createdAt: datetime('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: datetime('updated_at').notNull().$onUpdate(() => new Date()),
});

export type Tag = typeof tag.$inferSelect;
export type NewTag = typeof tag.$inferInsert;

export const profile = mysqlTable('profile', {
  id: char('id', { length: 36 }).primaryKey().default(sql`(UUID())`),
  bio: text('bio'),
  avatar: varchar('avatar', { length: 100 }),
  createdAt: datetime('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: datetime('updated_at').notNull().$onUpdate(() => new Date()),
  userId: char('user_id', { length: 36 })
    .notNull()
    .unique()
    .references(() => user.id, { onDelete: 'cascade' }),
});

export type Profile = typeof profile.$inferSelect;
export type NewProfile = typeof profile.$inferInsert;

export const postTags = mysqlTable(
  'post_tag',
  {
    id: char('id', { length: 36 }).primaryKey().default(sql`(UUID())`),
    postId: char('post_id', { length: 36 })
      .notNull()
      .references(() => post.id, { onDelete: 'cascade' }),
    tagId: char('tag_id', { length: 36 })
      .notNull()
      .references(() => tag.id, { onDelete: 'cascade' }),
  },
  (table) => [
    uniqueIndex('post_tag_post_id_tag_id_key').on(table.postId, table.tagId),
  ]
);

export type PostTags = typeof postTags.$inferSelect;
export type NewPostTags = typeof postTags.$inferInsert;

export const categoryRelations = relations(category, ({ one, many }) => ({
  parent: one(category, {
    fields: [category.parentId],
    references: [category.id],
    relationName: 'Category_parent',
  }),
  children: many(category, { relationName: 'Category_parent' }),
  posts: many(post),
}));

export const userRelations = relations(user, ({ one, many }) => ({
  posts: many(post, { relationName: 'Post_author' }),
  editedPosts: many(post, { relationName: 'Post_editor' }),
  profile: one(profile),
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

export const tagRelations = relations(tag, ({ many }) => ({
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
