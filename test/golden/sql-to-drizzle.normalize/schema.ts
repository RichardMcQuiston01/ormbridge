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

export const blogUser = pgTable('blog_user', {
  id: uuid('id').primaryKey().defaultRandom(),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .$onUpdate(() => new Date()),
});

export type BlogUser = typeof blogUser.$inferSelect;
export type NewBlogUser = typeof blogUser.$inferInsert;

export const blogCategory = pgTable('blog_category', {
  id: uuid('id').primaryKey().defaultRandom(),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  name: varchar('name', { length: 100 }).notNull().unique(),
  slug: varchar('slug', { length: 50 }).notNull(),
  parentId: uuid('parent_id')
    .references((): AnyPgColumn => blogCategory.id, { onDelete: 'set null' }),
});

export type BlogCategory = typeof blogCategory.$inferSelect;
export type NewBlogCategory = typeof blogCategory.$inferInsert;

export const blogTag = pgTable('blog_tag', {
  id: uuid('id').primaryKey().defaultRandom(),
  label: varchar('label', { length: 50 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .$onUpdate(() => new Date()),
});

export type BlogTag = typeof blogTag.$inferSelect;
export type NewBlogTag = typeof blogTag.$inferInsert;

export const blogPost = pgTable(
  'blog_post',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
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
      .references(() => blogUser.id, { onDelete: 'cascade' }),
    editorId: uuid('editor_id')
      .references(() => blogUser.id, { onDelete: 'set null' }),
    categoryId: uuid('category_id')
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

export const blogProfile = pgTable('blog_profile', {
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
    .references(() => blogUser.id, { onDelete: 'cascade' }),
});

export type BlogProfile = typeof blogProfile.$inferSelect;
export type NewBlogProfile = typeof blogProfile.$inferInsert;

export const blogPostTags = pgTable(
  'blog_post_tag',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    blogPostId: uuid('blog_post_id')
      .notNull()
      .references(() => blogPost.id, { onDelete: 'cascade' }),
    blogTagId: uuid('blog_tag_id')
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
