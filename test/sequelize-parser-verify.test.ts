import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import type { IrSchema } from '../src/ir.js';
import { parseSequelize } from '../src/parsers/sequelize.js';
import { CANONICAL_FIXTURES } from './fixtures/canonical.js';
import { expectOk } from './helpers.js';
import { titleWithReason, type ToolProbe } from './realToolSupport.js';
import { compareWithDatabase, type DbSchema } from './sequelizeSupport.js';

/**
 * Loads the Sequelize fixtures with the real library: the models are defined and associated in Node,
 * `sequelize.sync()` creates their tables in an in-memory SQLite database, and what the database and
 * Sequelize's query interface report (tables, columns, nullability, primary and unique keys, indexes,
 * foreign keys and their actions) is compared with what the parser read from the same source.
 *
 * Set SEQUELIZE_DIR to a directory where `npm install sequelize@6 sqlite3` has been run (add
 * `sequelize-typescript reflect-metadata typescript @types/node` for the TypeScript fixtures; see
 * test/README.md and test/tools/setup-verification-tools.sh). The tests are skipped when it is not set.
 */

interface VerifyGroup {
  label: string;
  /** Packages that must be installed in SEQUELIZE_DIR for this group. */
  requires: readonly string[];
  /** Fixture files to copy, relative to the fixtures directory (their layout is kept). */
  files: readonly string[];
  /** The file that exports the Sequelize instance, relative to the fixtures directory. */
  entry: string;
  /** The files the parser reads (absolute paths). */
  sources: readonly string[];
}

const FIXTURES: string = fileURLToPath(new URL('./fixtures/', import.meta.url));
const BASE_PACKAGES: readonly string[] = ['sequelize', 'sqlite3'];
const TYPESCRIPT_PACKAGES: readonly string[] = [
  ...BASE_PACKAGES,
  'sequelize-typescript',
  'reflect-metadata',
  'typescript',
  '@types/node',
];

const CANONICAL_PATHS: readonly string[] =
  CANONICAL_FIXTURES.find((fixture) => fixture.format === 'sequelize')?.paths ??
  [];

const GROUPS: readonly VerifyGroup[] = [
  {
    label: 'canonical blog schema (sequelize-cli layout)',
    requires: BASE_PACKAGES,
    files: [
      'sequelize/package.json',
      ...CANONICAL_PATHS.map((path: string) => relative(FIXTURES, path)),
    ],
    entry: 'sequelize/models/index.js',
    sources: CANONICAL_PATHS,
  },
  {
    label: 'variants (defaults, underscored, join models, keys, indexes)',
    requires: BASE_PACKAGES,
    files: ['sequelize-extras/package.json', 'sequelize-extras/variants.js'],
    entry: 'sequelize-extras/variants.js',
    sources: [join(FIXTURES, 'sequelize-extras/variants.js')],
  },
  {
    label: 'Model.init classes (TypeScript)',
    requires: TYPESCRIPT_PACKAGES,
    files: ['sequelize-extras/init-class.ts'],
    entry: 'sequelize-extras/init-class.ts',
    sources: [join(FIXTURES, 'sequelize-extras/init-class.ts')],
  },
  {
    label: 'sequelize-typescript decorators',
    requires: TYPESCRIPT_PACKAGES,
    files: ['sequelize-extras/decorators.ts'],
    entry: 'sequelize-extras/decorators.ts',
    sources: [join(FIXTURES, 'sequelize-extras/decorators.ts')],
  },
];

function probeSequelize(): ToolProbe & { directory: string } {
  const directory: string = process.env.SEQUELIZE_DIR ?? '';
  if (directory === '') {
    return {
      available: false,
      reason:
        'set SEQUELIZE_DIR to a directory with sequelize@6 and sqlite3 installed (see test/README.md)',
      directory,
    };
  }
  const missing: string[] = BASE_PACKAGES.filter(
    (name: string) =>
      !existsSync(join(directory, 'node_modules', name, 'package.json'))
  );
  if (missing.length > 0) {
    return {
      available: false,
      reason: `SEQUELIZE_DIR is missing ${missing.join(', ')} (see test/README.md)`,
      directory,
    };
  }
  return { available: true, reason: '', directory };
}

const probe: ReturnType<typeof probeSequelize> = probeSequelize();
const directories: string[] = [];

afterAll(() => {
  for (const directory of directories) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function missingPackages(group: VerifyGroup): string[] {
  return group.requires.filter(
    (name: string) =>
      !existsSync(join(probe.directory, 'node_modules', name, 'package.json'))
  );
}

describe(titleWithReason('sequelize parser: real Sequelize', probe), () => {
  it.skipIf(!probe.available).each(GROUPS)(
    'agrees with the SQLite database Sequelize creates for the $label',
    async (group: VerifyGroup) => {
      const missing: string[] = missingPackages(group);
      if (missing.length > 0) {
        // Not an error: only the base packages are required to run the suite.
        console.warn(
          `Skipped "${group.label}": SEQUELIZE_DIR is missing ${missing.join(', ')}.`
        );
        return;
      }
      const directory: string = mkdtempSync(
        join(tmpdir(), 'ormbridge-sequelize-')
      );
      directories.push(directory);
      symlinkSync(
        join(probe.directory, 'node_modules'),
        join(directory, 'node_modules'),
        'dir'
      );
      for (const file of group.files) {
        mkdirSync(dirname(join(directory, file)), { recursive: true });
        copyFileSync(join(FIXTURES, file), join(directory, file));
      }

      let entry: string = join(directory, group.entry);
      if (entry.endsWith('.ts')) {
        const outDirectory: string = join(directory, 'out');
        const compiled: SpawnSyncReturns<string> = spawnSync(
          join(probe.directory, 'node_modules', '.bin', 'tsc'),
          [
            group.entry,
            '--outDir',
            outDirectory,
            '--module',
            'commonjs',
            '--target',
            'es2020',
            '--experimentalDecorators',
            '--emitDecoratorMetadata',
            '--useDefineForClassFields',
            'false',
            '--esModuleInterop',
            '--skipLibCheck',
            '--strict',
          ],
          { cwd: directory, encoding: 'utf8', timeout: 240_000 }
        );
        expect(compiled.stdout + compiled.stderr, 'tsc').toBe('');
        expect(compiled.status).toBe(0);
        entry = join(outDirectory, `${basename(group.entry, '.ts')}.js`);
      }

      const run: SpawnSyncReturns<string> = spawnSync(
        process.execPath,
        [
          fileURLToPath(
            new URL('./tools/validate-sequelize.mjs', import.meta.url)
          ),
          probe.directory,
          entry,
        ],
        { cwd: directory, encoding: 'utf8', timeout: 240_000 }
      );
      expect(run.status, run.stderr).toBe(0);
      const database: DbSchema = JSON.parse(run.stdout) as DbSchema;

      const ir: IrSchema = expectOk(
        await parseSequelize(
          group.sources.map((path: string) => ({
            path,
            text: readFileSync(path, 'utf8'),
          })),
          { appLabel: 'blog' }
        )
      );
      expect(compareWithDatabase(ir, database)).toEqual([]);
    },
    300_000
  );
});
