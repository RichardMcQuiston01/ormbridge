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
    // Drizzle has no implicit many-to-many: the join table (post-tag.schema.ts) is an ordinary table.
    format: 'drizzle',
    paths: [
      './drizzle/time-stamped.ts',
      './drizzle/post-status.enum.ts',
      './drizzle/user.schema.ts',
      './drizzle/category.schema.ts',
      './drizzle/post.schema.ts',
      './drizzle/tag.schema.ts',
      './drizzle/post-tag.schema.ts',
      './drizzle/profile.schema.ts',
      './drizzle/relations.ts',
    ].map(fixturePath),
  },
  {
    // Sequelize 6 models in the layout sequelize-cli generates: one factory per file (sequelize.define plus an
    // associate function) and the models/index.js loader, which defines no models. Read only, so the matrix lists
    // it among the read-only sources. The class, sequelize-typescript and variant styles live in sequelize-extras.
    format: 'sequelize',
    paths: [
      './sequelize/models/index.js',
      './sequelize/models/category.js',
      './sequelize/models/post.js',
      './sequelize/models/profile.js',
      './sequelize/models/tag.js',
      './sequelize/models/user.js',
    ].map(fixturePath),
  },
  {
    // Entity Framework Core (C#): the data annotations live on the entity classes, the relationships, defaults and
    // the join table in an IEntityTypeConfiguration<Post> class and in OnModelCreating of the DbContext. Read only,
    // so the matrix lists it among the read-only sources. Fluent-only, owned-type, inheritance and many-to-many
    // variants live in efcore-extras.
    format: 'efcore',
    paths: [
      './efcore/TimeStamped.cs',
      './efcore/PostStatus.cs',
      './efcore/Category.cs',
      './efcore/Post.cs',
      './efcore/Tag.cs',
      './efcore/Profile.cs',
      './efcore/User.cs',
      './efcore/PostConfiguration.cs',
      './efcore/BlogContext.cs',
    ].map(fixturePath),
  },
  {
    format: 'json-schema',
    paths: [fixturePath('./json-schema/blog.schema.json')],
  },
  {
    // The same schema in the other dialects lives next to it (mysql, sqlite, sqlserver) and is checked in sql-ddl-parser.test.ts.
    format: 'sql',
    paths: [fixturePath('./sql/postgresql/blog.sql')],
  },
  {
    // SQLAlchemy 2.0 declarative models in a package. The SQLModel and classic Column() versions of the same
    // schema (fixtures/sqlalchemy-sqlmodel, fixtures/sqlalchemy-classic) are checked in sqlalchemy-parser.test.ts.
    format: 'sqlalchemy',
    paths: [
      './sqlalchemy/blog/base.py',
      './sqlalchemy/blog/enums.py',
      './sqlalchemy/blog/user.py',
      './sqlalchemy/blog/category.py',
      './sqlalchemy/blog/post.py',
      './sqlalchemy/blog/tag.py',
      './sqlalchemy/blog/profile.py',
    ].map(fixturePath),
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
