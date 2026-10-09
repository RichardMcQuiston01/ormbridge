/**
 * Runs the generated SQLite Drizzle schema of the canonical Django blog fixture through a real
 * database: inserts, defaults, `$onUpdate`, uniqueness, referential actions and relational queries.
 *
 * Usage (from the scratch project, after `tsc` compiled it to ./dist and `drizzle-kit push` created
 * `sqlite/push.db`):
 *   node dist/validate-drizzle-blog.js
 *
 * Failures are printed to stderr and the exit code is 1; success prints "drizzle blog verified".
 * This file is compiled inside the scratch project, next to `sqlite/schema.ts`.
 */
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { eq } from 'drizzle-orm';
import * as schema from './sqlite/schema.js';

const problems: string[] = [];

function expect(condition: boolean, message: string): void {
  if (!condition) {
    problems.push(message);
  }
}

function throws(action: () => unknown): boolean {
  try {
    action();
    return false;
  } catch {
    return true;
  }
}

function main(): void {
  const sqlite: Database.Database = new Database('sqlite/push.db');
  sqlite.pragma('foreign_keys = ON');
  const db = drizzle(sqlite, { schema });

  const author = db.insert(schema.user).values({}).returning().get();
  const category = db
    .insert(schema.category)
    .values({ name: 'News', slug: 'news' })
    .returning()
    .get();
  expect(category.createdAt instanceof Date, 'createdAt default is a Date');
  expect(category.updatedAt instanceof Date, 'updatedAt is filled on insert');
  expect(category.parentId === null, 'parentId defaults to NULL');
  expect(
    throws(() =>
      db.insert(schema.category).values({ name: 'News', slug: 'other' }).run()
    ),
    'a duplicate unique name is rejected'
  );

  const post = db
    .insert(schema.post)
    .values({
      title: 'Hello',
      body: 'World',
      authorId: author.id,
      categoryId: category.id,
    })
    .returning()
    .get();
  expect(
    typeof post.publicId === 'string' && post.publicId.length === 36,
    'the UUID default is generated'
  );
  expect(post.status === 'draft', 'the enum default is applied');
  expect(post.viewCount === 0, 'the integer default is applied');
  expect(post.isFeatured === false, 'the boolean default is applied');
  expect(JSON.stringify(post.metadata) === '{}', 'the JSON default is applied');
  expect(post.publishedAt instanceof Date, 'the now() default is a Date');

  sqlite
    .prepare('UPDATE blog_post SET updated_at = 0 WHERE id = ?')
    .run(post.id);
  const updated = db
    .update(schema.post)
    .set({ title: 'Hello again' })
    .where(eq(schema.post.id, post.id))
    .returning()
    .get();
  expect(
    updated !== undefined && updated.updatedAt.getTime() > 1000,
    '$onUpdate refreshes updatedAt'
  );

  const tag = db.insert(schema.tag).values({ label: 'a' }).returning().get();
  db.insert(schema.postTags).values({ postId: post.id, tagId: tag.id }).run();
  expect(
    throws(() =>
      db
        .insert(schema.postTags)
        .values({ postId: post.id, tagId: tag.id })
        .run()
    ),
    'the unique pair of a join table is enforced'
  );
  db.insert(schema.profile).values({ userId: author.id }).run();
  expect(
    throws(() => db.insert(schema.profile).values({ userId: author.id }).run()),
    'a one-to-one relation is unique'
  );

  const loaded = db.query.post
    .findFirst({
      where: eq(schema.post.id, post.id),
      with: {
        author: true,
        category: true,
        postTags: { with: { tag: true } },
      },
    })
    .sync();
  expect(loaded?.author.id === author.id, 'the author relation loads');
  expect(loaded?.category.name === 'News', 'the category relation loads');
  expect(
    loaded?.postTags[0]?.tag.label === 'a',
    'the join table relation loads from both sides'
  );
  const user = db.query.user
    .findFirst({
      where: eq(schema.user.id, author.id),
      with: { profile: true, posts: true },
    })
    .sync();
  expect(user?.profile?.userId === author.id, 'the inverse one-to-one loads');
  expect(user?.posts.length === 1, 'the inverse one-to-many loads');
  const tagged = db.query.tag.findFirst({ with: { postTags: true } }).sync();
  expect(tagged?.postTags.length === 1, 'the inverse join side loads');

  expect(
    throws(() =>
      db
        .delete(schema.category)
        .where(eq(schema.category.id, category.id))
        .run()
    ),
    'deleting a category that has posts is restricted'
  );
  db.delete(schema.user).where(eq(schema.user.id, author.id)).run();
  expect(
    db.select().from(schema.post).all().length === 0,
    'deleting the author cascades to the posts'
  );
  expect(
    db.select().from(schema.postTags).all().length === 0,
    'the cascade reaches the join table'
  );
  sqlite.close();

  if (problems.length > 0) {
    process.stderr.write(`${problems.join('\n')}\n`);
    process.exit(1);
  }
  process.stdout.write('drizzle blog verified\n');
}

main();
