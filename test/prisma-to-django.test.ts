import { describe, expect, it } from 'vitest';
import { convertText, type ConvertOptions, type ConvertResult } from '../src/convert.js';
import type { Result } from '../src/result.js';
import { DEFAULT_OPTIONS, convertBlogFixture, expectOk } from './helpers.js';

const PRISMA_OPTIONS: ConvertOptions = { ...DEFAULT_OPTIONS, from: 'prisma', to: 'django' };

const SAMPLE_SCHEMA: string = `
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

enum Role {
  ADMIN
  USER @map("user")
}

model Account {
  id          Int          @id @default(autoincrement())
  email       String       @unique @db.VarChar(255)
  role        Role         @default(USER)
  createdAt   DateTime     @default(now()) @map("created_at")
  balance     Decimal      @db.Decimal(10, 2)
  groups      Group[]
  memberships Membership[]

  @@map("accounts")
}

model Group {
  id          Int          @id @default(autoincrement())
  name        String
  accounts    Account[]
  memberships Membership[]
}

model Membership {
  accountId Int     @map("account_id")
  groupId   Int
  account   Account @relation(fields: [accountId], references: [id], onDelete: Cascade)
  group     Group   @relation(fields: [groupId], references: [id])

  @@id([accountId, groupId])
}
`;

async function convertSample(): Promise<ConvertResult> {
  const result: Result<ConvertResult> = await convertText([{ path: 'schema.prisma', text: SAMPLE_SCHEMA }], PRISMA_OPTIONS);
  return expectOk(result);
}

describe('Prisma -> Django', () => {
  it('maps models, tables and column names', async () => {
    const { output } = await convertSample();
    expect(output).toContain('class Account(models.Model):');
    expect(output).toContain('db_table = "accounts"');
    expect(output).toContain('email = models.CharField(max_length=255, unique=True)');
    expect(output).toContain('created_at = models.DateTimeField(default=timezone.now)');
    expect(output).toContain('balance = models.DecimalField(max_digits=10, decimal_places=2)');
  });

  it('converts enums into TextChoices with mapped database values', async () => {
    const { output } = await convertSample();
    expect(output).toContain('class Role(models.TextChoices):');
    expect(output).toContain('USER = "user", "User"');
    expect(output).toContain('choices=Role.choices, default=Role.USER');
  });

  it('turns foreign keys into ForeignKey with the mapped on_delete behavior', async () => {
    const { output } = await convertSample();
    expect(output).toContain('account = models.ForeignKey("Account", on_delete=models.CASCADE');
    expect(output).toContain('group = models.ForeignKey("Group", on_delete=models.PROTECT');
  });

  it('turns implicit many-to-many lists into a single ManyToManyField and warns about the join table', async () => {
    const { output, warnings } = await convertSample();
    expect(output).toContain('groups = models.ManyToManyField("Group", related_name="accounts", blank=True)');
    expect(output).not.toContain('accounts = models.ManyToManyField');
    expect(warnings.some((warning: string) => warning.includes('implicit many-to-many'))).toBe(true);
  });

  it('emits composite primary keys and warns about the required Django version', async () => {
    const { output, warnings } = await convertSample();
    expect(output).toContain('pk = models.CompositePrimaryKey("account", "group")');
    expect(warnings.some((warning: string) => warning.includes('Django 5.2'))).toBe(true);
  });

  it('fails clearly when the schema has no models', async () => {
    const result: Result<ConvertResult> = await convertText(
      [{ path: 'empty.prisma', text: 'datasource db {\n  provider = "sqlite"\n}\n' }],
      PRISMA_OPTIONS,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('NO_MODELS_FOUND');
    }
  });
});

describe('Round trip (Django -> Prisma -> Django)', () => {
  it('preserves model names, tables and relations', async () => {
    const prisma: ConvertResult = await convertBlogFixture();
    const result: Result<ConvertResult> = await convertText(
      [{ path: 'schema.prisma', text: prisma.output }],
      PRISMA_OPTIONS,
    );
    const django: string = expectOk(result).output;
    for (const modelName of ['Category', 'Post', 'Tag', 'Profile', 'User', 'PostTags']) {
      expect(django).toContain(`class ${modelName}(models.Model):`);
    }
    expect(django).toContain('db_table = "blog_post"');
    expect(django).toContain('author = models.ForeignKey("User", on_delete=models.CASCADE, related_name="posts")');
    expect(django).toContain('user = models.OneToOneField("User", on_delete=models.CASCADE, related_name="profile")');
  });
});
