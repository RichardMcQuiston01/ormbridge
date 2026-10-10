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

export const postStatusValues = ['draft', 'published'] as const;
export type PostStatus = (typeof postStatusValues)[number];

export const blogUser = mysqlTable('blog_user', {
  id: char('id', { length: 36 }).primaryKey().default(sql`(UUID())`),
  createdAt: datetime('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: datetime('updated_at').notNull().$onUpdate(() => new Date()),
});

export type BlogUser = typeof blogUser.$inferSelect;
export type NewBlogUser = typeof blogUser.$inferInsert;

export const blogCategory = mysqlTable('blog_category', {
  id: char('id', { length: 36 }).primaryKey().default(sql`(UUID())`),
  createdAt: datetime('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: datetime('updated_at').notNull(),
  name: varchar('name', { length: 100 }).notNull().unique(),
  slug: varchar('slug', { length: 50 }).notNull(),
  parentId: char('parent_id', { length: 36 })
    .references((): AnyMySqlColumn => blogCategory.id, { onDelete: 'set null' }),
});

export type BlogCategory = typeof blogCategory.$inferSelect;
export type NewBlogCategory = typeof blogCategory.$inferInsert;

export const blogTag = mysqlTable('blog_tag', {
  id: char('id', { length: 36 }).primaryKey().default(sql`(UUID())`),
  label: varchar('label', { length: 50 }).notNull(),
  createdAt: datetime('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: datetime('updated_at').notNull().$onUpdate(() => new Date()),
});

export type BlogTag = typeof blogTag.$inferSelect;
export type NewBlogTag = typeof blogTag.$inferInsert;

export const blogPost = mysqlTable(
  'blog_post',
  {
    id: char('id', { length: 36 }).primaryKey().default(sql`(UUID())`),
    createdAt: datetime('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: datetime('updated_at').notNull(),
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
      .references(() => blogUser.id, { onDelete: 'cascade' }),
    editorId: char('editor_id', { length: 36 })
      .references(() => blogUser.id, { onDelete: 'set null' }),
    categoryId: char('category_id', { length: 36 })
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

export const blogProfile = mysqlTable('blog_profile', {
  id: char('id', { length: 36 }).primaryKey().default(sql`(UUID())`),
  bio: text('bio'),
  avatar: varchar('avatar', { length: 100 }),
  createdAt: datetime('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: datetime('updated_at').notNull().$onUpdate(() => new Date()),
  userId: char('user_id', { length: 36 })
    .notNull()
    .unique()
    .references(() => blogUser.id, { onDelete: 'cascade' }),
});

export type BlogProfile = typeof blogProfile.$inferSelect;
export type NewBlogProfile = typeof blogProfile.$inferInsert;

export const blogPostTags = mysqlTable(
  'blog_post_tag',
  {
    id: char('id', { length: 36 }).primaryKey().default(sql`(UUID())`),
    blogPostId: char('blog_post_id', { length: 36 })
      .notNull()
      .references(() => blogPost.id, { onDelete: 'cascade' }),
    blogTagId: char('blog_tag_id', { length: 36 })
      .notNull()
      .references(() => blogTag.id, { onDelete: 'cascade' }),
  },
  (table) => [
    uniqueIndex('blog_post_tag_blog_post_id_blog_tag_id_key').on(table.blogPostId, table.blogTagId),
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
