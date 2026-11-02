import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { emitSequelize } from '../src/emitters/sequelize.js';
import type { PrismaProvider } from '../src/emitters/prisma.js';
import type { MultiFileEmitOutput } from '../src/formats.js';
import type { IrField, IrIndex, IrModel, IrSchema } from '../src/ir.js';
import { parseSequelize } from '../src/parsers/sequelize.js';
import type { NamingMode } from '../src/transforms.js';
import { expectOk } from './helpers.js';
import {
  field,
  idField,
  kitchenSinkSchema,
  model,
  schemaOf,
  stressSchema,
} from './gormFixtures.js';
import {
  SOURCES_WITHOUT_VIEWS,
  parseSource,
  titleWithReason,
  type ToolProbe,
  type VerifySource,
} from './realToolSupport.js';
import {
  compareServerColumns,
  compile7,
  probeSequelize7,
  probeSequelize7Server,
  run7Server,
  scratchProject7,
  type Run7,
  type Sequelize7Probe,
  type ServerKind,
} from './sequelize7Support.js';
import {
  compareWithDatabase,
  expectedAssociations,
  expectedSchema,
  forSqlite,
} from './sequelizeSupport.js';

/**
 * Runs the Sequelize 7 models against a real PostgreSQL and a real MySQL server, the way
 * `sequelize7-verify.test.ts` and `sequelize7-parser-verify.test.ts` do against SQLite. The writer's output
 * (`--style v7 --provider postgresql` / `mysql`) for the canonical blog schema of every format, the extras and two
 * IR fixtures, in both naming modes, and the reader's fixtures are compiled with `tsc --strict` against the types
 * of `@sequelize/core`; `new Sequelize({ dialect, models })` defines and associates them, `sequelize.sync()`
 * creates the tables in a scratch database of the server, and the tables, columns, types (real `BIGINT` and
 * `DECIMAL(p,s)`), nullability, defaults, primary and unique keys, indexes and foreign keys with their actions are
 * read back from the catalogs and compared with the IR. The associations the models declare are compared with the
 * relations of the IR.
 *
 * Set SEQUELIZE7_DIR to a directory where `npm install @sequelize/core @sequelize/postgres @sequelize/mysql
 * typescript @types/node` has been run (see test/README.md and test/tools/setup-verification-tools.sh), and
 * SQL_POSTGRES_URL / SQL_MYSQL_URL to the servers (the `psql` and `mysql` clients must be on the PATH, as for the
 * SQL DDL tests). Each server is skipped with a reason when its package or URL is missing.
 */

interface ServerCase {
  kind: ServerKind;
  provider: PrismaProvider;
  label: string;
}

const SERVER_CASES: readonly ServerCase[] = [
  { kind: 'postgres', provider: 'postgresql', label: 'PostgreSQL' },
  { kind: 'mysql', provider: 'mysql', label: 'MySQL' },
];

const base: Sequelize7Probe = probeSequelize7();
const directories: string[] = [];

afterAll(() => {
  for (const directory of directories) {
    rmSync(directory, { recursive: true, force: true });
  }
});

/** One schema to write: its name and how to build the IR. */
interface Subject {
  label: string;
  build: () => Promise<IrSchema>;
}

const SUBJECTS: readonly Subject[] = [
  ...SOURCES_WITHOUT_VIEWS.map((source: VerifySource): Subject => ({
    label: source.label,
    build: () => parseSource(source),
  })),
  { label: 'kitchen-sink', build: () => Promise.resolve(kitchenSinkSchema()) },
  { label: 'stress', build: () => Promise.resolve(stressSchema()) },
  { label: 'bigint-decimal', build: () => Promise.resolve(numbersSchema()) },
];

/**
 * What MySQL holds of a schema: an index over a JSON column (or an array, which MySQL stores as JSON) is skipped by
 * the writer with a warning, so the database must not have it. The writer still gets the index.
 */
function withoutJsonIndexes(schema: IrSchema): IrSchema {
  return {
    ...schema,
    models: schema.models.map((candidate: IrModel): IrModel => {
      const unindexable: Set<string> = new Set(
        candidate.fields
          .filter(
            (item: IrField) =>
              item.type === 'json' || (item.arrayDepth ?? 0) > 0
          )
          .flatMap((item: IrField) => [item.name, item.columnName])
      );
      return {
        ...candidate,
        indexes: candidate.indexes.filter(
          (item: IrIndex) =>
            !item.fields.some((name: string) => unindexable.has(name))
        ),
      };
    }),
  };
}

/**
 * The two types the SQLite dialect of Sequelize 7 lacks: a 64-bit key and column, and exact decimals (with and
 * without a default), which PostgreSQL and MySQL have to create as `BIGINT` and `DECIMAL(p,s)`.
 */
function numbersSchema(): IrSchema {
  return schemaOf([
    model('Ledger', {
      tableName: 'ledger',
      fields: [
        idField({ type: 'bigInt' }),
        field('views', { type: 'bigInt', isNullable: true }),
        field('balance', {
          type: 'decimal',
          maxDigits: 12,
          decimalPlaces: 2,
          default: { kind: 'literal', value: 0 },
        }),
        field('rate', {
          type: 'decimal',
          maxDigits: 5,
          decimalPlaces: 4,
          isNullable: true,
        }),
        field('whole', { type: 'decimal', maxDigits: 20, decimalPlaces: 0 }),
      ],
    }),
  ]);
}

/** One reader fixture group, as in `sequelize7-parser-verify.test.ts`. */
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

describe.each(SERVER_CASES)(
  'sequelize 7: real $label',
  (server: ServerCase) => {
    const probe: ToolProbe = probeSequelize7Server(server.kind, base);
    const combos: [string, NamingMode, Subject][] = SUBJECTS.flatMap(
      (subject: Subject) =>
        (['preserve', 'normalize'] as const).map(
          (naming: NamingMode): [string, NamingMode, Subject] => [
            subject.label,
            naming,
            subject,
          ]
        )
    );

    it.skipIf(!probe.available).each(combos)(
      titleWithReason(
        'creates the schema of %s from the Sequelize 7 models (%s naming)',
        probe
      ),
      async (_label: string, naming: NamingMode, subject: Subject) => {
        const built: IrSchema = await subject.build();
        const schema: IrSchema =
          server.kind === 'mysql' ? forSqlite(built) : built;
        const output: MultiFileEmitOutput = emitSequelize(
          structuredClone(schema),
          { provider: server.provider, naming, style: 'v7' }
        );
        const files: Record<string, string> = {};
        for (const [path, text] of Object.entries(output.files)) {
          files[`models/${path}`] = text;
        }
        const directory: string = scratchProject7(base, files);
        directories.push(directory);
        expect(compile7(base, directory, Object.keys(files)), 'tsc').toBe('');

        const { run, result } = run7Server(
          server.kind,
          base,
          directory,
          'out/models/index.js'
        );
        expect(run.status, run.stderr).toBe(0);
        const database: Run7 = result as Run7;

        // The writer is given the indexes over JSON columns and has to skip them; the database must not have them.
        const ir: IrSchema = expectedSchema(
          server.kind === 'mysql' ? withoutJsonIndexes(schema) : schema,
          naming
        );
        expect(compareWithDatabase(ir, database)).toEqual([]);
        expect(compareServerColumns(server.kind, ir, database)).toEqual([]);
        const declared: string[] = database.associations.map(
          (association: { model: string; as: string }) =>
            `${association.model}.${association.as}`
        );
        for (const name of expectedAssociations(ir, naming)) {
          expect(declared, name).toContain(name);
        }
      },
      300_000
    );

    it.skipIf(!probe.available).each(GROUPS)(
      titleWithReason(
        'agrees with the database Sequelize 7 creates for the reader fixture $label',
        probe
      ),
      async (group: Group) => {
        const files: Record<string, string> = {};
        for (const file of group.files) {
          files[file] = readFileSync(join(FIXTURES, file), 'utf8');
        }
        const directory: string = scratchProject7(base, files);
        directories.push(directory);
        expect(compile7(base, directory, group.files), 'tsc').toBe('');

        const { run, result } = run7Server(
          server.kind,
          base,
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
        expect(compareServerColumns(server.kind, ir, database)).toEqual([]);
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
  }
);
