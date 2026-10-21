import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import type { IrSchema } from '../src/ir.js';
import { parseSequelize } from '../src/parsers/sequelize.js';
import { expectOk } from './helpers.js';
import { titleWithReason, type ToolProbe } from './realToolSupport.js';
import {
  compareColumnTypes,
  compareWithDatabase,
  type DbSchema,
} from './sequelizeSupport.js';

/**
 * Runs folders of `sequelize-cli` migrations with the real `sequelize-cli db:migrate` against a SQLite file,
 * reads what the database holds afterwards (tables, columns and their types, defaults, nullability, keys,
 * indexes, foreign keys and their actions) and checks that replaying the same files with the Sequelize reader
 * gives the same schema. Each scenario also runs without one migration that changes the schema, and that
 * replay has to differ from the database, which proves the comparison can fail.
 *
 * Set SEQUELIZE_DIR to a directory where `npm install sequelize@6 sqlite3 sequelize-cli` has been run (see
 * test/README.md and test/tools/setup-verification-tools.sh). The tests are skipped when it is not set.
 * SQLite rebuilds a table for `renameColumn`, `changeColumn` and `removeColumn` and loses foreign key actions
 * and some unique keys when it does, so the scenarios use those calls only on tables without keys.
 */

interface Scenario {
  label: string;
  /** The folder of migrations, relative to test/fixtures. */
  directory: string;
  /** A migration that changes the schema: a replay without it must differ from the database. */
  control: string;
  /** TypeScript migrations: compiled with `tsc` first, and the compiled files are what sequelize-cli runs. */
  compile?: true;
}

const FIXTURES: string = fileURLToPath(new URL('./fixtures/', import.meta.url));
const REQUIRED: readonly string[] = ['sequelize', 'sqlite3', 'sequelize-cli'];
const TYPESCRIPT: readonly string[] = ['typescript', '@types/node'];

const SCENARIOS: readonly Scenario[] = [
  {
    label: 'blog (create, add, rename, change, index, constraint, drop)',
    directory: 'sequelize-migrations/blog',
    control: '20240106000000-rename-table-and-cleanup.js',
  },
  {
    label:
      'module shapes (exports.up, .cjs, transaction callback, helper, constants)',
    directory: 'sequelize-migrations/shapes',
    control: '20230103000000-constraints.js',
  },
  {
    label:
      'constraints (unique, primary key and foreign key through addConstraint, removeConstraint)',
    directory: 'sequelize-migrations/keys',
    control: '20230203000000-drop-keys.js',
  },
  {
    label:
      'column and table changes (renameColumn, changeColumn, removeColumn, renameTable, dropTable)',
    directory: 'sequelize-migrations/changes',
    control: '20230302000000-alter.js',
  },
  {
    label: 'TypeScript migrations (export function up, module.exports)',
    directory: 'sequelize-migrations/typescript',
    control: '20230402000000-comments.ts',
    compile: true,
  },
];

function probeSequelizeCli(): ToolProbe & { directory: string } {
  const directory: string = process.env.SEQUELIZE_DIR ?? '';
  if (directory === '') {
    return {
      available: false,
      reason:
        'set SEQUELIZE_DIR to a directory with sequelize@6, sqlite3 and sequelize-cli installed (see test/README.md)',
      directory,
    };
  }
  const missing: string[] = REQUIRED.filter(
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

const probe: ReturnType<typeof probeSequelizeCli> = probeSequelizeCli();
const directories: string[] = [];

afterAll(() => {
  for (const directory of directories) {
    rmSync(directory, { recursive: true, force: true });
  }
});

/** The migration files of a folder, read the way the CLI hands them over (every JavaScript file). */
function readMigrations(
  directory: string,
  without?: string
): { path: string; text: string }[] {
  return readdirSync(directory)
    .filter(
      (name: string) => /\.(?:[cm]?js|ts)$/.test(name) && name !== without
    )
    .map((name: string) => ({
      path: join(directory, name),
      text: readFileSync(join(directory, name), 'utf8'),
    }));
}

describe(
  titleWithReason('sequelize migrations: real sequelize-cli', probe),
  () => {
    it.skipIf(!probe.available).each(SCENARIOS)(
      'replays the migrations of $label into the schema sequelize-cli creates',
      async (scenario: Scenario) => {
        const work: string = mkdtempSync(
          join(tmpdir(), 'ormbridge-sequelize-migrations-')
        );
        directories.push(work);
        cpSync(join(FIXTURES, scenario.directory), work, { recursive: true });
        let executed: string = work;
        if (scenario.compile === true) {
          const missing: string[] = TYPESCRIPT.filter(
            (name: string) =>
              !existsSync(
                join(probe.directory, 'node_modules', name, 'package.json')
              )
          );
          if (missing.length > 0) {
            console.warn(
              `Skipped "${scenario.label}": SEQUELIZE_DIR is missing ${missing.join(', ')}.`
            );
            return;
          }
          symlinkSync(
            join(probe.directory, 'node_modules'),
            join(work, 'node_modules'),
            'dir'
          );
          executed = join(work, 'out');
          const compiled: SpawnSyncReturns<string> = spawnSync(
            join(probe.directory, 'node_modules', '.bin', 'tsc'),
            [
              ...readdirSync(work).filter((name: string) =>
                name.endsWith('.ts')
              ),
              '--outDir',
              executed,
              '--module',
              'commonjs',
              '--target',
              'es2020',
              '--esModuleInterop',
              '--skipLibCheck',
              '--strict',
              '--types',
              'node',
            ],
            { cwd: work, encoding: 'utf8', timeout: 240_000 }
          );
          expect(compiled.stdout + compiled.stderr, 'tsc').toBe('');
          copyFileSync(
            join(work, 'package.json'),
            join(executed, 'package.json')
          );
        }

        const run: SpawnSyncReturns<string> = spawnSync(
          process.execPath,
          [
            fileURLToPath(
              new URL(
                './tools/validate-sequelize-migrations.mjs',
                import.meta.url
              )
            ),
            probe.directory,
            executed,
          ],
          { encoding: 'utf8', timeout: 240_000 }
        );
        expect(run.status, run.stderr).toBe(0);
        const database: DbSchema = JSON.parse(run.stdout) as DbSchema;

        const ir: IrSchema = expectOk(
          await parseSequelize(readMigrations(work), { appLabel: 'blog' })
        );
        expect(compareWithDatabase(ir, database)).toEqual([]);
        expect(compareColumnTypes(ir, database)).toEqual([]);

        const without: IrSchema = expectOk(
          await parseSequelize(readMigrations(work, scenario.control), {
            appLabel: 'blog',
          })
        );
        expect(
          [
            ...compareWithDatabase(without, database),
            ...compareColumnTypes(without, database),
          ].length,
          `a replay without ${scenario.control} should differ from the database`
        ).toBeGreaterThan(0);
      },
      300_000
    );
  }
);
