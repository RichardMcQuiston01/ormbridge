import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  serial,
  text,
  timestamp,
  unique,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { categories } from './category.schema';
import { postStatus } from './post-status.enum';
import { timeStamped } from './time-stamped';
import { users } from './user.schema';

export const posts = pgTable(
  'blog_post',
  {
    id: serial('id').primaryKey(),
    ...timeStamped,
    publicId: uuid('public_id').notNull().unique().defaultRandom(),
    title: varchar('title', { length: 200 }).notNull(),
    body: text('body').notNull(),
    status: postStatus('status').notNull().default('draft'),
    rating: numeric('rating', { precision: 4, scale: 2 }),
    viewCount: integer('view_count').notNull().default(0),
    isFeatured: boolean('is_featured').notNull().default(false),
    publishedAt: timestamp('published_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    metadata: jsonb('metadata').notNull().default({}),
    authorId: integer('author_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    editorId: integer('editor_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    categoryId: integer('category_id')
      .notNull()
      .references(() => categories.id, { onDelete: 'restrict' }),
  },
  (table) => [
    unique().on(table.authorId, table.title),
    index('post_pub_status_idx').on(table.publishedAt, table.status),
    index().on(table.title),
  ]
);
