import { describe, expect, it } from 'vitest';
import { convertText, type ConvertResult } from '../src/convert.js';
import type { Result } from '../src/result.js';
import { BLOG_FIXTURE_PATH, DEFAULT_OPTIONS, convertBlogFixture, expectOk } from './helpers.js';

describe('Django -> Prisma (preserve naming)', () => {
  it('maps tables, fields and nullability', async () => {
    const { output } = await convertBlogFixture();
    expect(output).toContain('model Post {');
    expect(output).toContain('@@map("blog_post")');
    expect(output).toMatch(/title\s+String\s+@db\.VarChar\(200\)/);
    expect(output).toMatch(/rating\s+Decimal\?\s+@db\.Decimal\(4, 2\)/);
    expect(output).toMatch(/body\s+String\s+@db\.Text/);
    expect(output).toMatch(/metadata\s+Json\s+@default\("\{\}"\)/);
  });

  it('inherits fields from abstract base models and omits the abstract model itself', async () => {
    const { output } = await convertBlogFixture();
    expect(output).not.toContain('model TimeStampedModel');
    expect(output).toMatch(/created_at\s+DateTime\s+@default\(now\(\)\)/);
    expect(output).toMatch(/updated_at\s+DateTime\s+@updatedAt/);
  });

  it('converts TextChoices to a Prisma enum with mapped values and defaults', async () => {
    const { output } = await convertBlogFixture();
    expect(output).toContain('enum PostStatus {');
    expect(output).toContain('DRAFT @map("draft")');
    expect(output).toMatch(/status\s+PostStatus\s+@default\(DRAFT\)/);
  });

  it('writes both sides of foreign keys with explicit onDelete behavior', async () => {
    const { output } = await convertBlogFixture();
    expect(output).toMatch(/category_id\s+Int\n/);
    expect(output).toMatch(/category\s+Category\s+@relation\(fields: \[category_id\], references: \[id\], onDelete: Restrict\)/);
    expect(output).toMatch(/parent\s+Category\?\s+@relation\("Category_parent", fields: \[parent_id\], references: \[id\], onDelete: SetNull\)/);
    expect(output).toMatch(/children\s+Category\[\]\s+@relation\("Category_parent"\)/);
  });

  it('names relations when a model pair is linked more than once', async () => {
    const { output } = await convertBlogFixture();
    expect(output).toContain('@relation("Post_author"');
    expect(output).toContain('@relation("Post_editor"');
  });

  it('turns one-to-one fields into unique foreign keys with an optional reverse side', async () => {
    const { output } = await convertBlogFixture();
    expect(output).toMatch(/user_id\s+Int\s+@unique/);
    expect(output).toMatch(/profile\s+Profile\?/);
  });

  it('creates an explicit join model matching the Django many-to-many table', async () => {
    const { output } = await convertBlogFixture();
    expect(output).toContain('model PostTags {');
    expect(output).toContain('@@map("blog_post_tags")');
    expect(output).toContain('@@unique([post_id, tag_id])');
  });

  it('maps unique_together, db_index and explicit indexes', async () => {
    const { output } = await convertBlogFixture();
    expect(output).toContain('@@unique([author_id, title])');
    expect(output).toContain('@@index([title])');
    expect(output).toContain('@@index([published_at, status], map: "post_pub_status_idx")');
  });

  it('generates a stub for AUTH_USER_MODEL and warns about it', async () => {
    const { output, warnings } = await convertBlogFixture();
    expect(output).toContain('model User {');
    expect(output).toContain('@@map("auth_user")');
    expect(warnings.some((warning: string) => warning.includes('AUTH_USER_MODEL'))).toBe(true);
    expect(warnings.some((warning: string) => warning.includes('stub model'))).toBe(true);
  });

  it('omits native database types for sqlite', async () => {
    const { output } = await convertBlogFixture({ provider: 'sqlite' });
    expect(output).not.toContain('@db.');
    expect(output).toContain('provider = "sqlite"');
  });

  it('omits the generator and datasource blocks with header disabled', async () => {
    const { output } = await convertBlogFixture({ header: false });
    expect(output).not.toContain('datasource');
    expect(output).not.toContain('generator');
  });
});

describe('Django -> Prisma (normalize naming)', () => {
  it('uses singular table names, UUID keys and camelCase fields mapped to snake_case columns', async () => {
    const { output } = await convertBlogFixture({ naming: 'normalize' });
    expect(output).toContain('@@map("post")');
    expect(output).toMatch(/id\s+String\s+@id @default\(uuid\(\)\) @db\.Uuid/);
    expect(output).toMatch(/viewCount\s+Int\s+@default\(0\) @map\("view_count"\)/);
    expect(output).toMatch(/authorId\s+String\s+@map\("author_id"\) @db\.Uuid/);
  });

  it('uses implicit many-to-many relations instead of a join model', async () => {
    const { output } = await convertBlogFixture({ naming: 'normalize' });
    expect(output).not.toContain('model PostTags');
    expect(output).toMatch(/tags\s+Tag\[\]/);
    expect(output).toMatch(/posts\s+Post\[\]/);
  });

  it('adds created_at and updated_at to models that lack them', async () => {
    const { output } = await convertBlogFixture({ naming: 'normalize' });
    const tagModel: string = /model Tag \{[\s\S]*?\n\}/.exec(output)?.[0] ?? '';
    expect(tagModel).toMatch(/createdAt\s+DateTime\s+@default\(now\(\)\) @map\("created_at"\)/);
    expect(tagModel).toMatch(/updatedAt\s+DateTime\s+@updatedAt @map\("updated_at"\)/);
  });
});

describe('Django parser edge cases', () => {
  it('reports unknown base classes instead of failing', async () => {
    const source: string = [
      'from django.db import models',
      '',
      'class Article(ExternalBase):',
      '    title = models.CharField(max_length=10)',
      '',
    ].join('\n');
    const result: Result<ConvertResult> = await convertText([{ path: 'models.py', text: source }], DEFAULT_OPTIONS);
    const converted: ConvertResult = expectOk(result);
    expect(converted.output).toContain('model Article {');
    expect(converted.warnings.some((warning: string) => warning.includes('ExternalBase'))).toBe(true);
  });

  it('returns NO_MODELS_FOUND when the file defines no models', async () => {
    const result: Result<ConvertResult> = await convertText(
      [{ path: 'models.py', text: 'VALUE = 1\n' }],
      DEFAULT_OPTIONS,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('NO_MODELS_FOUND');
      expect(result.error.message).toContain('models.py');
    }
  });

  it('rejects identical source and target formats with a descriptive error', async () => {
    const result: Result<ConvertResult> = await convertText(
      [{ path: BLOG_FIXTURE_PATH, text: 'x = 1' }],
      { ...DEFAULT_OPTIONS, from: 'django', to: 'django' },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('UNSUPPORTED_CONVERSION');
    }
  });

  it('uses BigAutoField-style keys when requested', async () => {
    const source: string = 'from django.db import models\n\nclass Thing(models.Model):\n    name = models.CharField(max_length=5)\n';
    const result: Result<ConvertResult> = await convertText(
      [{ path: 'models.py', text: source }],
      { ...DEFAULT_OPTIONS, autoField: 'bigInt' },
    );
    expect(expectOk(result).output).toMatch(/id\s+BigInt\s+@id @default\(autoincrement\(\)\)/);
  });
});
