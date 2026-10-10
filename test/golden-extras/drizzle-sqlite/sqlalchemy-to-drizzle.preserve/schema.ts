import { relations, sql } from 'drizzle-orm';
import {
  type AnySQLiteColumn,
  index,
  integer,
  numeric,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

export const postStatusValues = ['draft', 'published'] as const;
export type PostStatus = (typeof postStatusValues)[number];

export const user = sqliteTable('auth_user', {
  id: integer('id').primaryKey({ autoIncrement: true }),
});

export type User = typeof user.$inferSelect;
export type NewUser = typeof user.$inferInsert;

export const category = sqliteTable('blog_category', {
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
  updatedAt: integer('updated_at', { mode: 'timestamp' })
    .notNull()
    .$onUpdate(() => new Date()),
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull().unique(),
  slug: text('slug').notNull(),
  parentId: integer('parent_id')
    .references((): AnySQLiteColumn => category.id, { onDelete: 'set null' }),
});

export type Category = typeof category.$inferSelect;
export type NewCategory = typeof category.$inferInsert;

export const post = sqliteTable(
  'blog_post',
  {
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
    updatedAt: integer('updated_at', { mode: 'timestamp' })
      .notNull()
      .$onUpdate(() => new Date()),
    id: integer('id').primaryKey({ autoIncrement: true }),
    publicId: text('public_id')
      .notNull()
      .unique()
      .$defaultFn(() => crypto.randomUUID()),
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
    authorId: integer('author_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    editorId: integer('editor_id')
      .references(() => user.id, { onDelete: 'set null' }),
    categoryId: integer('category_id')
      .notNull()
      .references(() => category.id, { onDelete: 'restrict' }),
  },
  (table) => [
    index('blog_post_title_idx').on(table.title),
    uniqueIndex('blog_post_author_id_title_key').on(table.authorId, table.title),
    index('post_pub_status_idx').on(table.publishedAt, table.status),
  ]
);

export type Post = typeof post.$inferSelect;
export type NewPost = typeof post.$inferInsert;

export const tag = sqliteTable('blog_tag', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  label: text('label').notNull(),
});

export type Tag = typeof tag.$inferSelect;
export type NewTag = typeof tag.$inferInsert;

export const profile = sqliteTable('blog_profile', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  bio: text('bio'),
  avatar: text('avatar'),
  userId: integer('user_id')
    .notNull()
    .unique()
    .references(() => user.id, { onDelete: 'cascade' }),
});

export type Profile = typeof profile.$inferSelect;
export type NewProfile = typeof profile.$inferInsert;

export const postTags = sqliteTable(
  'blog_post_tags',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    postId: integer('post_id')
      .notNull()
      .references(() => post.id, { onDelete: 'cascade' }),
    tagId: integer('tag_id')
      .notNull()
      .references(() => tag.id, { onDelete: 'cascade' }),
  },
  (table) => [
    uniqueIndex('blog_post_tags_post_id_tag_id_key').on(table.postId, table.tagId),
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
