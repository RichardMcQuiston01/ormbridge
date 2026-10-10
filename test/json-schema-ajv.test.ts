import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Checks the JSON Schema and OpenAPI fixtures with the real Ajv validator, so the fixtures the
 * parser is tested with are known to be valid documents (and not merely something the parser
 * tolerates). The canonical JSON Schema fixture and the OpenAPI fixture are also compiled, which
 * resolves every `$ref`. The extras fixture is only checked against the meta-schema: it contains
 * references that cannot be resolved on purpose.
 *
 * Set AJV_DIR to a directory where `npm install ajv ajv-formats` has been run (outside this
 * repository); see test/README.md and test/tools/setup-verification-tools.sh. The tests are
 * skipped when it is not set.
 */

const AJV_DIR: string | undefined = process.env.AJV_DIR;
const AJV_TIMEOUT_MS: number = 60_000;

function probe(): string | undefined {
  if (AJV_DIR === undefined || AJV_DIR === '') {
    return 'AJV_DIR is not set';
  }
  if (!existsSync(join(AJV_DIR, 'node_modules', 'ajv', 'package.json'))) {
    return `ajv is not installed in ${AJV_DIR}`;
  }
  return undefined;
}

const skipReason: string | undefined = probe();

interface Report {
  files: { file: string; metaSchemaValid: boolean; errors: string[] }[];
  compiled: boolean | null;
  errors: string[];
}

function validate(compile: boolean, files: string[]): Report {
  const script: string = fileURLToPath(
    new URL('./tools/validate-json-schema-fixtures.mjs', import.meta.url)
  );
  const run: SpawnSyncReturns<string> = spawnSync(
    process.execPath,
    [script, AJV_DIR ?? '', ...(compile ? ['--compile'] : []), ...files],
    { encoding: 'utf8', timeout: AJV_TIMEOUT_MS }
  );
  if (run.status !== 0) {
    throw new Error(
      `validate-json-schema-fixtures.mjs failed (${run.status}): ${run.stderr || run.error?.message || ''}`
    );
  }
  return JSON.parse(run.stdout) as Report;
}

function fixture(path: string): string {
  return fileURLToPath(new URL(`./fixtures/${path}`, import.meta.url));
}

describe(`Ajv${skipReason === undefined ? '' : ` (skipped: ${skipReason})`}`, () => {
  it.skipIf(skipReason !== undefined)(
    'accepts the canonical JSON Schema fixture and resolves its references',
    () => {
      const report: Report = validate(true, [
        fixture('json-schema/blog.schema.json'),
      ]);
      expect(report.files.map((file) => file.errors)).toEqual([[]]);
      expect(report.compiled, report.errors.join('; ')).toBe(true);
    },
    AJV_TIMEOUT_MS
  );

  it.skipIf(skipReason !== undefined)(
    'accepts the OpenAPI fixture and resolves its references',
    () => {
      const report: Report = validate(true, [
        fixture('json-schema/blog.openapi.json'),
      ]);
      expect(report.files.map((file) => file.errors)).toEqual([[]]);
      expect(report.compiled, report.errors.join('; ')).toBe(true);
    },
    AJV_TIMEOUT_MS
  );

  it.skipIf(skipReason !== undefined)(
    'accepts the extras fixtures as schemas (draft 2020-12 and draft 7)',
    () => {
      const report: Report = validate(false, [
        fixture('json-schema-extras/shop.schema.json'),
        fixture('json-schema-extras/people.schema.json'),
      ]);
      expect(report.files.map((file) => file.errors)).toEqual([[], []]);
      expect(report.files.every((file) => file.metaSchemaValid)).toBe(true);
    },
    AJV_TIMEOUT_MS
  );
});
