import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ToolProbe } from './realToolSupport.js';
import type { DbSchema } from './sequelizeSupport.js';

/**
 * What the Sequelize 7 verification tests share: finding the install (`SEQUELIZE7_DIR`), setting up a scratch
 * project, compiling decorated TypeScript with the real `tsc`, and running `tools/validate-sequelize7.mjs`.
 */

export const SEQUELIZE7_PACKAGES: readonly string[] = [
  '@sequelize/core',
  '@sequelize/sqlite3',
  'typescript',
  '@types/node',
];

export type Sequelize7Probe = ToolProbe & { directory: string };

/** Looks for `npm install @sequelize/core @sequelize/sqlite3 typescript @types/node` in SEQUELIZE7_DIR. */
export function probeSequelize7(): Sequelize7Probe {
  const directory: string = process.env.SEQUELIZE7_DIR ?? '';
  if (directory === '') {
    return {
      available: false,
      reason:
        'set SEQUELIZE7_DIR to a directory with @sequelize/core 7 and @sequelize/sqlite3 installed (see test/README.md)',
      directory,
    };
  }
  const missing: string[] = SEQUELIZE7_PACKAGES.filter(
    (name: string) =>
      !existsSync(join(directory, 'node_modules', name, 'package.json'))
  );
  if (missing.length > 0) {
    return {
      available: false,
      reason: `SEQUELIZE7_DIR is missing ${missing.join(', ')} (see test/README.md)`,
      directory,
    };
  }
  return { available: true, reason: '', directory };
}

/** A scratch project holding `files`, with `node_modules` linked in from the Sequelize 7 install. */
export function scratchProject7(
  probe: Sequelize7Probe,
  files: Readonly<Record<string, string>>
): string {
  const directory: string = mkdtempSync(
    join(tmpdir(), 'ormbridge-sequelize7-')
  );
  symlinkSync(
    join(probe.directory, 'node_modules'),
    join(directory, 'node_modules'),
    'dir'
  );
  writeFileSync(
    join(directory, 'package.json'),
    JSON.stringify({ private: true, type: 'commonjs' })
  );
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(directory, path)), { recursive: true });
    writeFileSync(join(directory, path), text);
  }
  return directory;
}

/** The flags that compile Sequelize 7 models: legacy decorators, strict types, CommonJS output. */
const COMPILER_FLAGS: readonly string[] = [
  '--module',
  'commonjs',
  '--target',
  'es2022',
  '--experimentalDecorators',
  '--useDefineForClassFields',
  'false',
  '--esModuleInterop',
  '--skipLibCheck',
  '--strict',
  '--types',
  'node',
];

/**
 * Compiles TypeScript files to `<directory>/out` with the installed `tsc` (which also type-checks them against
 * the types of `@sequelize/core`). Returns what `tsc` printed: empty when the files compile.
 */
export function compile7(
  probe: Sequelize7Probe,
  directory: string,
  files: readonly string[]
): string {
  const compiled: SpawnSyncReturns<string> = spawnSync(
    join(probe.directory, 'node_modules', '.bin', 'tsc'),
    [...COMPILER_FLAGS, '--rootDir', '.', '--outDir', 'out', ...files],
    { cwd: directory, encoding: 'utf8', timeout: 240_000 }
  );
  return compiled.stdout + compiled.stderr;
}

/** What `tools/validate-sequelize7.mjs` prints. */
export interface Run7 extends DbSchema {
  associations: { model: string; as: string; type: string }[];
}

/** Loads the compiled entry module (it exports `models`), syncs it into SQLite and reads the result back. */
export function run7(
  probe: Sequelize7Probe,
  directory: string,
  entry: string
): { run: SpawnSyncReturns<string>; result: Run7 | undefined } {
  const run: SpawnSyncReturns<string> = spawnSync(
    process.execPath,
    [
      fileURLToPath(
        new URL('./tools/validate-sequelize7.mjs', import.meta.url)
      ),
      probe.directory,
      join(directory, entry),
    ],
    { cwd: directory, encoding: 'utf8', timeout: 240_000 }
  );
  return {
    run,
    result: run.status === 0 ? (JSON.parse(run.stdout) as Run7) : undefined,
  };
}
