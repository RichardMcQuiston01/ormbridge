import { integer, pgTable, primaryKey } from 'drizzle-orm/pg-core';
import { posts } from './post.schema';
import { tags } from './tag.schema';

/** Drizzle has no implicit many-to-many: the join table is an ordinary table with two foreign keys. */
export const postTags = pgTable(
  'blog_post_tags',
  {
    postId: integer('post_id')
      .notNull()
      .references(() => posts.id, { onDelete: 'cascade' }),
    tagId: integer('tag_id')
      .notNull()
      .references(() => tags.id, { onDelete: 'cascade' }),
  },
  (table) => [primaryKey({ columns: [table.postId, table.tagId] })]
);
