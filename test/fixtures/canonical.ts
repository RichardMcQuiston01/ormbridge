import { fileURLToPath } from 'node:url';

/**
 * The canonical schema, expressed once per format. Every adapter that can be
 * read (has `parse`) adds one entry here pointing at its fixture file(s); the
 * shared harness tests then pick it up automatically.
 *
 * All entries must describe the same schema (the "blog" model set), so a
 * conversion from any entry can be compared against any other.
 */
export interface CanonicalFixture {
  /** Registered format name, for example "django". */
  format: string;
  /** Absolute paths of the fixture files that together hold the schema. */
  paths: string[];
}

function fixturePath(relativePath: string): string {
  return fileURLToPath(new URL(relativePath, import.meta.url));
}

export const CANONICAL_FIXTURES: readonly CanonicalFixture[] = [
  { format: 'django', paths: [fixturePath('./blog/models.py')] },
  { format: 'prisma', paths: [fixturePath('./canonical/schema.prisma')] },
  {
    format: 'typeorm',
    paths: [
      './typeorm/time-stamped.ts',
      './typeorm/post-status.enum.ts',
      './typeorm/category.entity.ts',
      './typeorm/post.entity.ts',
      './typeorm/tag.entity.ts',
      './typeorm/profile.entity.ts',
      './typeorm/user.entity.ts',
    ].map(fixturePath),
  },
  {
    format: 'doctrine',
    paths: [
      './doctrine/TimeStamped.php',
      './doctrine/PostStatus.php',
      './doctrine/Category.php',
      './doctrine/Post.php',
      './doctrine/Tag.php',
      './doctrine/Profile.php',
      './doctrine/User.php',
    ].map(fixturePath),
  },
  {
    format: 'gorm',
    paths: [
      './gorm/timestamped.go',
      './gorm/poststatus.go',
      './gorm/category.go',
      './gorm/post.go',
      './gorm/tag.go',
      './gorm/profile.go',
      './gorm/user.go',
    ].map(fixturePath),
  },
  {
    format: 'json-schema',
    paths: [fixturePath('./json-schema/blog.schema.json')],
  },
  {
    // Laravel keeps the schema in migrations: they are listed in the order Laravel runs them,
    // followed by the backed enum and the Eloquent models that name the relations.
    format: 'laravel',
    paths: [
      './laravel/database/migrations/2024_01_01_000000_create_auth_user_table.php',
      './laravel/database/migrations/2024_01_01_000100_create_blog_category_table.php',
      './laravel/database/migrations/2024_01_01_000200_create_blog_tag_table.php',
      './laravel/database/migrations/2024_01_01_000300_create_blog_post_table.php',
      './laravel/database/migrations/2024_01_01_000400_create_blog_profile_table.php',
      './laravel/database/migrations/2024_01_01_000500_create_blog_post_tags_table.php',
      './laravel/database/migrations/2024_02_01_000000_add_parent_to_blog_category_table.php',
      './laravel/database/migrations/2024_02_01_000100_rename_name_to_label_on_blog_tag_table.php',
      './laravel/database/migrations/2024_02_01_000200_shorten_slug_and_index_blog_category_table.php',
      './laravel/database/migrations/2024_02_15_000000_create_blog_comment_table.php',
      './laravel/database/migrations/2024_03_01_000000_finalize_blog_post_table.php',
      './laravel/database/migrations/2024_03_01_000100_drop_blog_comment_and_slug_index.php',
      './laravel/app/Enums/PostStatus.php',
      './laravel/app/Models/Category.php',
      './laravel/app/Models/Post.php',
      './laravel/app/Models/Profile.php',
      './laravel/app/Models/Tag.php',
      './laravel/app/Models/User.php',
    ].map(fixturePath),
  },
];
