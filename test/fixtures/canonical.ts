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
];
