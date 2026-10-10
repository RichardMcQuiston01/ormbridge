import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { getFormat } from '../src/formats.js';
import type { IrSchema } from '../src/ir.js';
import type { NamingMode } from '../src/transforms.js';
import {
  parseSource,
  titleWithReason,
  VERIFY_SOURCES,
  type ToolProbe,
  type VerifySource,
} from './realToolSupport.js';
import {
  buildSqlAlchemySpec,
  probeSqlAlchemy,
  SQLALCHEMY_IR_FIXTURES,
  sqlalchemyPython,
} from './sqlalchemySupport.js';
import { DEFAULT_OPTIONS, expectOk } from './helpers.js';
import { field, idField, model, relation, schemaOf } from './gormFixtures.js';

/**
 * Loads the generated SQLAlchemy and SQLModel code with the real libraries (SQLAlchemy 2 and
 * SQLModel): the models are imported, the mappers configured, the PostgreSQL DDL rendered, the
 * tables created in SQLite and compared with the IR (columns, nullability, keys, foreign keys with
 * their ON DELETE action, unique constraints, indexes, lengths, precision, enums), rows are
 * inserted through the ORM (framework defaults, enums, foreign keys, composite keys, many-to-many
 * through the relationships) and the referential actions are exercised.
 *
 * Set SQLALCHEMY_PYTHON to a Python with SQLAlchemy 2 and SQLModel (see test/README.md and
 * test/tools/setup-verification-tools.sh); the tests are skipped when `python3` has neither.
 */

const SCRIPT: string = fileURLToPath(
  new URL('./tools/validate-sqlalchemy-emitter.py', import.meta.url)
);

/** Each case starts Python, imports the libraries and writes a database, so give it room. */
const CASE_TIMEOUT_MS: number = 180_000;

const probe: ToolProbe = probeSqlAlchemy();
const directories: string[] = [];

afterAll(() => {
  for (const directory of directories) {
    rmSync(directory, { recursive: true, force: true });
  }
});

interface Summary {
  inserted: string[];
  skipped: string[];
  followed: number;
  manyToMany: string[];
  autoUpdated: string[];
  actions: Record<string, number>;
}

interface Verified {
  run: SpawnSyncReturns<string>;
  summary: Summary | undefined;
}

function emitModels(
  schema: IrSchema,
  naming: NamingMode,
  style: 'sqlalchemy' | 'sqlmodel'
): string {
  const adapter = expectOk(getFormat('sqlalchemy'));
  if (adapter.emit === undefined) {
    throw new Error('The sqlalchemy format cannot be written.');
  }
  const emitted = expectOk(
    adapter.emit(structuredClone(schema), { ...DEFAULT_OPTIONS, naming, style })
  );
  return emitted.text ?? '';
}

function verify(
  schema: IrSchema,
  naming: NamingMode,
  style: 'sqlalchemy' | 'sqlmodel'
): Verified {
  const directory: string = mkdtempSync(join(tmpdir(), 'ormbridge-sqla-'));
  directories.push(directory);
  writeFileSync(
    join(directory, 'models.py'),
    emitModels(schema, naming, style)
  );
  writeFileSync(
    join(directory, 'spec.json'),
    JSON.stringify(buildSqlAlchemySpec(schema, naming, style))
  );
  const run: SpawnSyncReturns<string> = spawnSync(
    sqlalchemyPython(),
    ['-I', SCRIPT, directory, join(directory, 'spec.json')],
    { encoding: 'utf8', timeout: CASE_TIMEOUT_MS - 10_000 }
  );
  const lines: string[] = run.stdout.trim().split('\n');
  const summary: Summary | undefined =
    run.status === 0 && lines.length > 1
      ? (JSON.parse(lines[lines.length - 1] ?? '{}') as Summary)
      : undefined;
  return { run, summary };
}

const NAMINGS: readonly NamingMode[] = ['preserve', 'normalize'];
const STYLES = ['sqlalchemy', 'sqlmodel'] as const;

describe(titleWithReason('sqlalchemy emitter: real SQLAlchemy', probe), () => {
  describe.each(VERIFY_SOURCES)('$label schema', (source: VerifySource) => {
    describe.each(STYLES)('%s style', (style) => {
      it.skipIf(!probe.available).each(NAMINGS)(
        'loads the models, creates the tables and inserts rows (%s naming)',
        async (naming) => {
          const schema: IrSchema = await parseSource(source);
          const { run, summary } = verify(schema, naming, style);
          expect(run.stderr, run.stdout).toBe('');
          expect(run.stdout).toContain('sqlalchemy models verified');
          expect(run.status).toBe(0);
          expect(summary?.inserted.length).toBeGreaterThan(0);
        },
        CASE_TIMEOUT_MS
      );
    });
  });

  describe.each(SQLALCHEMY_IR_FIXTURES)('%s IR fixture', (_label, build) => {
    describe.each(STYLES)('%s style', (style) => {
      it.skipIf(!probe.available).each(NAMINGS)(
        'loads the models, creates the tables and inserts rows (%s naming)',
        (naming) => {
          const { run, summary } = verify(build(), naming, style);
          expect(run.stderr, run.stdout).toBe('');
          expect(run.stdout).toContain('sqlalchemy models verified');
          expect(run.status).toBe(0);
          expect(summary?.inserted.length).toBeGreaterThan(0);
        },
        CASE_TIMEOUT_MS
      );
    });
  });

  describe('the Django blog schema in depth', () => {
    const blog: VerifySource | undefined = VERIFY_SOURCES.find(
      (source: VerifySource) => source.label === 'django'
    );

    it.skipIf(!probe.available).each(STYLES)(
      'inserts every model, links the many-to-many and applies the referential actions (%s)',
      async (style) => {
        if (blog === undefined) {
          throw new Error('The Django canonical source is missing.');
        }
        const schema: IrSchema = await parseSource(blog);
        const { run, summary } = verify(schema, 'preserve', style);
        expect(run.stderr, run.stdout).toBe('');
        expect(run.status).toBe(0);
        expect(summary?.skipped).toEqual([]);
        expect(summary?.inserted).toEqual(
          expect.arrayContaining([
            'auth_user',
            'blog_category',
            'blog_post',
            'blog_tag',
            'blog_profile',
          ])
        );
        expect(summary?.manyToMany).toEqual(['blog_post_tags']);
        expect(summary?.autoUpdated.length).toBeGreaterThan(0);
        expect(summary?.followed).toBeGreaterThan(5);
        expect(summary?.actions['cascade']).toBeGreaterThan(0);
        expect(summary?.actions['restrict']).toBeGreaterThan(0);
      },
      CASE_TIMEOUT_MS
    );
  });

  describe('referential actions', () => {
    // One parent per action, so a restricting child never blocks the cascade of another.
    const actions = (): IrSchema =>
      schemaOf([
        model('Nest', { tableName: 'nests', fields: [idField()] }),
        model('Kennel', { tableName: 'kennels', fields: [idField()] }),
        model('Vault', { tableName: 'vaults', fields: [idField()] }),
        model('Kid', {
          tableName: 'kids',
          fields: [idField(), field('name', { maxLength: 20 })],
          relations: [
            relation('nest', 'Nest', {
              isNullable: true,
              onDelete: 'setNull',
              relatedName: 'kids',
            }),
          ],
        }),
        model('Pet', {
          tableName: 'pets',
          fields: [idField()],
          relations: [
            relation('kennel', 'Kennel', {
              onDelete: 'cascade',
              relatedName: 'pets',
            }),
          ],
        }),
        model('Bill', {
          tableName: 'bills',
          fields: [idField()],
          relations: [
            relation('vault', 'Vault', {
              onDelete: 'restrict',
              relatedName: 'bills',
            }),
          ],
        }),
      ]);

    it.skipIf(!probe.available).each(STYLES)(
      'SET NULL, CASCADE and RESTRICT act in the database (%s)',
      (style) => {
        const { run, summary } = verify(actions(), 'preserve', style);
        expect(run.stderr, run.stdout).toBe('');
        expect(run.status).toBe(0);
        expect(summary?.actions['setNull']).toBeGreaterThan(0);
        expect(summary?.actions['cascade']).toBeGreaterThan(0);
        expect(summary?.actions['restrict']).toBeGreaterThan(0);
      },
      CASE_TIMEOUT_MS
    );
  });
});
