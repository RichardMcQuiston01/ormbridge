import { relations } from 'drizzle-orm';
import { categories } from './category.schema';
import { postTags } from './post-tag.schema';
import { posts } from './post.schema';
import { profiles } from './profile.schema';
import { tags } from './tag.schema';
import { users } from './user.schema';

export const usersRelations = relations(users, ({ one, many }) => ({
  posts: many(posts, { relationName: 'author' }),
  editedPosts: many(posts, { relationName: 'editor' }),
  profile: one(profiles),
}));

export const categoriesRelations = relations(categories, ({ one, many }) => ({
  parent: one(categories, {
    fields: [categories.parentId],
    references: [categories.id],
    relationName: 'category_tree',
  }),
  children: many(categories, { relationName: 'category_tree' }),
  posts: many(posts),
}));

export const postsRelations = relations(posts, ({ one, many }) => ({
  author: one(users, {
    fields: [posts.authorId],
    references: [users.id],
    relationName: 'author',
  }),
  editor: one(users, {
    fields: [posts.editorId],
    references: [users.id],
    relationName: 'editor',
  }),
  category: one(categories, {
    fields: [posts.categoryId],
    references: [categories.id],
  }),
  tags: many(postTags),
}));

export const tagsRelations = relations(tags, ({ many }) => ({
  posts: many(postTags),
}));

export const postTagsRelations = relations(postTags, ({ one }) => ({
  post: one(posts, { fields: [postTags.postId], references: [posts.id] }),
  tag: one(tags, { fields: [postTags.tagId], references: [tags.id] }),
}));

export const profilesRelations = relations(profiles, ({ one }) => ({
  user: one(users, { fields: [profiles.userId], references: [users.id] }),
}));
