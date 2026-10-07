import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  deriveAppLabel,
  runConversion,
  type RunOptions,
  type RunSummary,
} from '../src/io.js';
import type { Result } from '../src/result.js';
import { BLOG_FIXTURE_PATH, DEFAULT_OPTIONS, expectOk } from './helpers.js';

let workDirectory: string;

beforeEach(async () => {
  workDirectory = await mkdtemp(join(tmpdir(), 'ormbridge-test-'));
});

afterEach(async () => {
  await rm(workDirectory, { recursive: true, force: true });
});

function baseOptions(overrides: Partial<RunOptions>): RunOptions {
  const withoutLabel: RunOptions = { ...DEFAULT_OPTIONS };
  delete withoutLabel.appLabel;
  return { ...withoutLabel, inputs: [BLOG_FIXTURE_PATH], ...overrides };
}

describe('deriveAppLabel', () => {
  it('uses the directory containing models.py', () => {
    expect(deriveAppLabel(join('project', 'shop', 'models.py'))).toBe('shop');
  });

  it('uses the app directory for a models/ package', () => {
    expect(deriveAppLabel(join('project', 'shop', 'models', 'orders.py'))).toBe(
      'shop'
    );
  });
});

describe('runConversion', () => {
  it('writes the converted schema, creating parent directories', async () => {
    const outputPath: string = join(workDirectory, 'prisma', 'schema.prisma');
    const result: Result<RunSummary> = await runConversion(
      baseOptions({ output: outputPath })
    );
    const summary: RunSummary = expectOk(result);
    expect(summary.outputPath).toBe(outputPath);
    const written: string = await readFile(outputPath, 'utf8');
    expect(written).toContain('model Post {');
    expect(written).toContain('@@map("blog_post")');
  });

  it('derives the app label from the directory when none is given', async () => {
    const result: Result<RunSummary> = await runConversion(baseOptions({}));
    expect(expectOk(result).output).toContain('@@map("blog_post")');
  });

  it('discovers models.py files and models/ packages inside a directory, skipping migrations', async () => {
    const shopDirectory: string = join(workDirectory, 'shop');
    await mkdir(join(shopDirectory, 'migrations'), { recursive: true });
    await writeFile(
      join(shopDirectory, 'models.py'),
      'from django.db import models\n\nclass Product(models.Model):\n    name = models.CharField(max_length=50)\n'
    );
    await writeFile(
      join(shopDirectory, 'migrations', 'models.py'),
      'from django.db import models\n\nclass Ignored(models.Model):\n    name = models.CharField(max_length=5)\n'
    );
    const result: Result<RunSummary> = await runConversion(
      baseOptions({ inputs: [workDirectory] })
    );
    const summary: RunSummary = expectOk(result);
    expect(summary.inputFiles).toHaveLength(1);
    expect(summary.output).toContain('model Product {');
    expect(summary.output).toContain('@@map("shop_product")');
    expect(summary.output).not.toContain('Ignored');
  });

  it('returns INPUT_NOT_FOUND with the missing path', async () => {
    const missingPath: string = join(workDirectory, 'nope.py');
    const result: Result<RunSummary> = await runConversion(
      baseOptions({ inputs: [missingPath] })
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('INPUT_NOT_FOUND');
      expect(result.error.message).toContain(missingPath);
    }
  });

  it('returns NO_INPUT_FILES for a directory without models', async () => {
    const result: Result<RunSummary> = await runConversion(
      baseOptions({ inputs: [workDirectory] })
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('NO_INPUT_FILES');
    }
  });
});
