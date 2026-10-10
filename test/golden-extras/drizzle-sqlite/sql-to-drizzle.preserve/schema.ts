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

export const blogUser = sqliteTable('blog_user', {
  id: integer('id').primaryKey({ autoIncrement: true }),
});

export type BlogUser = typeof blogUser.$inferSelect;
export type NewBlogUser = typeof blogUser.$inferInsert;

export const blogCategory = sqliteTable('blog_category', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
  name: text('name').notNull().unique(),
  slug: text('slug').notNull(),
  parentId: integer('parent_id')
    .references((): AnySQLiteColumn => blogCategory.id, { onDelete: 'set null' }),
});

export type BlogCategory = typeof blogCategory.$inferSelect;
export type NewBlogCategory = typeof blogCategory.$inferInsert;

export const blogTag = sqliteTable('blog_tag', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  label: text('label').notNull(),
});

export type BlogTag = typeof blogTag.$inferSelect;
export type NewBlogTag = typeof blogTag.$inferInsert;

export const blogPost = sqliteTable(
  'blog_post',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
    updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
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
      .references(() => blogUser.id, { onDelete: 'cascade' }),
    editorId: integer('editor_id')
      .references(() => blogUser.id, { onDelete: 'set null' }),
    categoryId: integer('category_id')
      .notNull()
      .references(() => blogCategory.id, { onDelete: 'restrict' }),
  },
  (table) => [
    uniqueIndex('blog_post_author_id_title_key').on(table.authorId, table.title),
    index('blog_post_title_idx').on(table.title),
    index('post_pub_status_idx').on(table.publishedAt, table.status),
  ]
);

export type BlogPost = typeof blogPost.$inferSelect;
export type NewBlogPost = typeof blogPost.$inferInsert;

export const blogProfile = sqliteTable('blog_profile', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  bio: text('bio'),
  avatar: text('avatar'),
  userId: integer('user_id')
    .notNull()
    .unique()
    .references(() => blogUser.id, { onDelete: 'cascade' }),
});

export type BlogProfile = typeof blogProfile.$inferSelect;
export type NewBlogProfile = typeof blogProfile.$inferInsert;

export const blogPostTags = sqliteTable(
  'blog_post_tags',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    blogPostId: integer('blog_post_id')
      .notNull()
      .references(() => blogPost.id, { onDelete: 'cascade' }),
    blogTagId: integer('blog_tag_id')
      .notNull()
      .references(() => blogTag.id, { onDelete: 'cascade' }),
  },
  (table) => [
    uniqueIndex('blog_post_tags_blog_post_id_blog_tag_id_key').on(table.blogPostId, table.blogTagId),
  ]
);

export type BlogPostTags = typeof blogPostTags.$inferSelect;
export type NewBlogPostTags = typeof blogPostTags.$inferInsert;

export const blogUserRelations = relations(blogUser, ({ one, many }) => ({
  authorBlogPosts: many(blogPost, { relationName: 'BlogPost_author' }),
  editorBlogPosts: many(blogPost, { relationName: 'BlogPost_editor' }),
  blogProfile: one(blogProfile),
}));

export const blogCategoryRelations = relations(blogCategory, ({ one, many }) => ({
  parent: one(blogCategory, {
    fields: [blogCategory.parentId],
    references: [blogCategory.id],
    relationName: 'BlogCategory_parent',
  }),
  blogCategories: many(blogCategory, { relationName: 'BlogCategory_parent' }),
  blogPosts: many(blogPost),
}));

export const blogTagRelations = relations(blogTag, ({ many }) => ({
  blogPostTags: many(blogPostTags),
}));

export const blogPostRelations = relations(blogPost, ({ one, many }) => ({
  author: one(blogUser, {
    fields: [blogPost.authorId],
    references: [blogUser.id],
    relationName: 'BlogPost_author',
  }),
  editor: one(blogUser, {
    fields: [blogPost.editorId],
    references: [blogUser.id],
    relationName: 'BlogPost_editor',
  }),
  category: one(blogCategory, {
    fields: [blogPost.categoryId],
    references: [blogCategory.id],
  }),
  blogPostTags: many(blogPostTags),
}));

export const blogProfileRelations = relations(blogProfile, ({ one }) => ({
  user: one(blogUser, {
    fields: [blogProfile.userId],
    references: [blogUser.id],
  }),
}));

export const blogPostTagsRelations = relations(blogPostTags, ({ one }) => ({
  blogPost: one(blogPost, {
    fields: [blogPostTags.blogPostId],
    references: [blogPost.id],
  }),
  blogTag: one(blogTag, {
    fields: [blogPostTags.blogTagId],
    references: [blogTag.id],
  }),
}));
