import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  convertText,
  type ConvertOptions,
  type ConvertResult,
} from '../src/convert.js';
import type { Result } from '../src/result.js';

export const BLOG_FIXTURE_PATH: string = fileURLToPath(
  new URL('./fixtures/blog/models.py', import.meta.url)
);

export function readBlogFixture(): string {
  return readFileSync(BLOG_FIXTURE_PATH, 'utf8');
}

export const DEFAULT_OPTIONS: ConvertOptions = {
  from: 'django',
  to: 'prisma',
  naming: 'preserve',
  provider: 'postgresql',
  header: true,
  appLabel: 'blog',
  autoField: 'int',
};

/** Unwraps a Result in tests, failing with the error message when the operation failed. */
export function expectOk<T>(result: Result<T>): T {
  if (!result.ok) {
    throw new Error(
      `Expected success but got ${result.error.code}: ${result.error.message}`
    );
  }
  return result.value;
}

export async function convertBlogFixture(
  overrides: Partial<ConvertOptions> = {}
): Promise<ConvertResult> {
  const result: Result<ConvertResult> = await convertText(
    [{ path: BLOG_FIXTURE_PATH, text: readBlogFixture() }],
    { ...DEFAULT_OPTIONS, ...overrides }
  );
  return expectOk(result);
}
