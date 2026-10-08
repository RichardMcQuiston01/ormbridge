import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  countLines,
  deriveAppLabel,
  runConversion,
  summarizeDiff,
  type RunOptions,
  type RunSummary,
} from '../src/io.js';
import type { Result } from '../src/result.js';
import {
  MULTI_FILE_FORMAT,
  registerMultiFileFormat,
  unregisterMultiFileFormat,
} from './multiFileAdapter.js';
import { BLOG_FIXTURE_PATH, DEFAULT_OPTIONS, expectOk } from './helpers.js';

let workDirectory: string;

beforeEach(async () => {
  registerMultiFileFormat();
  workDirectory = await mkdtemp(join(tmpdir(), 'ormbridge-test-'));
});

afterEach(async () => {
  unregisterMultiFileFormat();
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

describe('line and diff helpers', () => {
  it('counts lines like an editor', () => {
    expect(countLines('')).toBe(0);
    expect(countLines('a\n')).toBe(1);
    expect(countLines('a\nb')).toBe(2);
    expect(countLines('a\n\nb\n')).toBe(3);
  });

  it('summarises added, removed and the first differing line', () => {
    expect(summarizeDiff('a\nb\nc\n', 'a\nB\nc\nd\n')).toBe(
      '+2 -1 lines (first difference at line 2)'
    );
    expect(summarizeDiff('a\n', 'a\nb\n')).toBe(
      '+1 -0 lines (first difference at line 2)'
    );
  });
});

describe('runConversion dry-run and check', () => {
  it('plans a new file without writing it on a dry run', async () => {
    const outputPath: string = join(workDirectory, 'out', 'schema.prisma');
    const summary: RunSummary = expectOk(
      await runConversion(baseOptions({ output: outputPath, dryRun: true }))
    );
    expect(summary.written).toBe(false);
    expect(summary.plannedFiles).toHaveLength(1);
    expect(summary.plannedFiles[0]).toMatchObject({
      path: outputPath,
      state: 'created',
    });
    expect(summary.plannedFiles[0]?.lines).toBeGreaterThan(0);
    expect(summary.plannedFiles[0]?.bytes).toBeGreaterThan(0);
    await expect(readdir(workDirectory)).resolves.toEqual([]);
  });

  it('reports unchanged, changed and created states', async () => {
    const outputPath: string = join(workDirectory, 'schema.prisma');
    expectOk(await runConversion(baseOptions({ output: outputPath })));
    const same: RunSummary = expectOk(
      await runConversion(baseOptions({ output: outputPath, check: true }))
    );
    expect(same.plannedFiles[0]?.state).toBe('unchanged');

    await writeFile(outputPath, 'stale\n');
    const changed: RunSummary = expectOk(
      await runConversion(baseOptions({ output: outputPath, check: true }))
    );
    expect(changed.plannedFiles[0]?.state).toBe('changed');
    expect(changed.plannedFiles[0]?.diff).toMatch(/^\+\d+ -1 lines/);
    expect(await readFile(outputPath, 'utf8')).toBe('stale\n');
    expect(changed.written).toBe(false);
  });

  it('does not rewrite an unchanged file', async () => {
    const outputPath: string = join(workDirectory, 'schema.prisma');
    expectOk(await runConversion(baseOptions({ output: outputPath })));
    const again: RunSummary = expectOk(
      await runConversion(baseOptions({ output: outputPath }))
    );
    expect(again.plannedFiles[0]?.state).toBe('unchanged');
    expect(again.written).toBe(true);
  });

  it('refuses a directory as the output of a single-file format', async () => {
    const result: Result<RunSummary> = await runConversion(
      baseOptions({ output: workDirectory })
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('INVALID_OPTION');
      expect(result.error.message).toContain('is a directory');
    }
  });
});

describe('runConversion with a multi-file format', () => {
  it('writes every file under the output directory', async () => {
    const outputDirectory: string = join(workDirectory, 'generated');
    const summary: RunSummary = expectOk(
      await runConversion(
        baseOptions({ to: MULTI_FILE_FORMAT, output: outputDirectory })
      )
    );
    expect(summary.outputPath).toBe(outputDirectory);
    expect(summary.warnings).toContain('multifile test warning');
    expect(summary.plannedFiles.map((file) => file.state)).toEqual(
      summary.plannedFiles.map(() => 'created')
    );
    expect(summary.plannedFiles.length).toBeGreaterThan(2);
    expect(
      await readFile(join(outputDirectory, 'index.txt'), 'utf8')
    ).toContain('Post');
    expect(
      await readFile(join(outputDirectory, 'models', 'Post.txt'), 'utf8')
    ).toBe('model Post\n');
  });

  it('supports dry-run and check without writing', async () => {
    const outputDirectory: string = join(workDirectory, 'generated');
    const dry: RunSummary = expectOk(
      await runConversion(
        baseOptions({
          to: MULTI_FILE_FORMAT,
          output: outputDirectory,
          dryRun: true,
        })
      )
    );
    expect(dry.written).toBe(false);
    await expect(readdir(workDirectory)).resolves.toEqual([]);

    expectOk(
      await runConversion(
        baseOptions({ to: MULTI_FILE_FORMAT, output: outputDirectory })
      )
    );
    await writeFile(join(outputDirectory, 'models', 'Post.txt'), 'old\n');
    await rm(join(outputDirectory, 'index.txt'));
    const checked: RunSummary = expectOk(
      await runConversion(
        baseOptions({
          to: MULTI_FILE_FORMAT,
          output: outputDirectory,
          check: true,
        })
      )
    );
    const states: Record<string, string> = Object.fromEntries(
      checked.plannedFiles.map((file) => [
        file.path.slice(outputDirectory.length + 1),
        file.state,
      ])
    );
    expect(states['index.txt']).toBe('created');
    expect(states[join('models', 'Post.txt')]).toBe('changed');
    expect(states[join('models', 'Category.txt')]).toBe('unchanged');
  });

  it('errors clearly when the output is a file path', async () => {
    const existing: string = join(workDirectory, 'out.txt');
    await writeFile(existing, 'x');
    for (const outputPath of [existing, join(workDirectory, 'new.prisma')]) {
      const result: Result<RunSummary> = await runConversion(
        baseOptions({ to: MULTI_FILE_FORMAT, output: outputPath })
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('INVALID_OPTION');
        expect(result.error.message).toContain('so -o must be a directory');
        expect(result.error.message).toContain('index.txt');
      }
    }
  });

  it('errors when no output directory is given', async () => {
    const result: Result<RunSummary> = await runConversion(
      baseOptions({ to: MULTI_FILE_FORMAT })
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain('needs an output directory');
    }
  });
});
