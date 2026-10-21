import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import type { IrSchema } from '../src/ir.js';
import { parseSequelize } from '../src/parsers/sequelize.js';
import { expectOk } from './helpers.js';
import { titleWithReason } from './realToolSupport.js';
import { compareWithDatabase } from './sequelizeSupport.js';
import {
  compile7,
  probeSequelize7,
  run7,
  scratchProject7,
  type Run7,
  type Sequelize7Probe,
} from './sequelize7Support.js';

/**
 * Loads the Sequelize 7 fixtures with the real library: the decorated models are compiled with `tsc` against the
 * types of `@sequelize/core`, `new Sequelize({ dialect: SqliteDialect, models })` defines and associates them,
 * `sequelize.sync()` creates their tables in a SQLite file, and what the database reports (tables, columns,
 * nullability, primary and unique keys, indexes, foreign keys and their actions) and the associations the models
 * declare are compared with what the parser read from the same source.
 *
 * Set SEQUELIZE7_DIR to a directory where `npm install @sequelize/core @sequelize/sqlite3 typescript @types/node`
 * has been run (see test/README.md and test/tools/setup-verification-tools.sh). The tests are skipped when it
 * is not set.
 */

interface Group {
  label: string;
  /** Fixture files to copy, relative to the fixtures directory (their layout is kept). */
  files: readonly string[];
  /** The module that exports `models`. */
  entry: string;
  /** The files the parser reads. */
  sources: readonly string[];
}

const FIXTURES: string = fileURLToPath(new URL('./fixtures/', import.meta.url));

const GROUPS: readonly Group[] = [
  {
    label: 'canonical blog schema (decorators)',
    files: [
      'sequelize7/models/category.ts',
      'sequelize7/models/index.ts',
      'sequelize7/models/post.ts',
      'sequelize7/models/profile.ts',
      'sequelize7/models/tag.ts',
      'sequelize7/models/user.ts',
    ],
    entry: 'sequelize7/models/index.ts',
    sources: [
      'sequelize7/models/category.ts',
      'sequelize7/models/post.ts',
      'sequelize7/models/profile.ts',
      'sequelize7/models/tag.ts',
      'sequelize7/models/user.ts',
    ],
  },
  {
    label:
      'variants (paranoid, version, indexes, join model, inverse, column types)',
    files: ['sequelize7-extras/variants.ts'],
    entry: 'sequelize7-extras/variants.ts',
    sources: ['sequelize7-extras/variants.ts'],
  },
];

/**
 * The v7 SQLite dialect has no DECIMAL, BIGINT or CHAR (SQLite stores numbers as 8-byte integers or floats), so
 * the models are loaded with DOUBLE and INTEGER in their place. The parser reads the same text, so the IR and
 * the database still describe one schema; the other column types are checked by the parser tests.
 */
function forSqlite(text: string): string {
  return text
    .replace(/DataTypes\.DECIMAL\([^)]*\)/g, 'DataTypes.DOUBLE')
    .replace(/DataTypes\.BIGINT/g, 'DataTypes.INTEGER');
}

const probe: Sequelize7Probe = probeSequelize7();
const directories: string[] = [];

afterAll(() => {
  for (const directory of directories) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe(titleWithReason('sequelize 7 parser: real Sequelize 7', probe), () => {
  it.skipIf(!probe.available).each(GROUPS)(
    'agrees with the SQLite database Sequelize 7 creates for the $label',
    async (group: Group) => {
      const files: Record<string, string> = {};
      for (const file of group.files) {
        files[file] = forSqlite(readFileSync(join(FIXTURES, file), 'utf8'));
      }
      const directory: string = scratchProject7(probe, files);
      directories.push(directory);
      expect(compile7(probe, directory, group.files), 'tsc').toBe('');

      const { run, result } = run7(
        probe,
        directory,
        join('out', group.entry.replace(/\.ts$/, '.js'))
      );
      expect(run.status, run.stderr).toBe(0);
      const database: Run7 = result as Run7;

      const ir: IrSchema = expectOk(
        await parseSequelize(
          group.sources.map((path: string) => ({
            path: join(FIXTURES, path),
            text: files[path] ?? '',
          })),
          { appLabel: 'blog' }
        )
      );
      expect(compareWithDatabase(ir, database)).toEqual([]);
      // Every relation the parser read is an association the models declare (`Model.alias`).
      const declared: string[] = database.associations.map(
        (association: { model: string; as: string }) =>
          `${association.model}.${association.as}`
      );
      for (const model of ir.models) {
        for (const relation of model.relations) {
          expect(declared, `${model.name}.${relation.name}`).toContain(
            `${model.name}.${relation.name}`
          );
          if (relation.relatedName !== undefined) {
            expect(
              declared,
              `${relation.targetModel}.${relation.relatedName}`
            ).toContain(`${relation.targetModel}.${relation.relatedName}`);
          }
        }
      }
    },
    300_000
  );
});
