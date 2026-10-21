import { rmSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { emitSequelize } from '../src/emitters/sequelize.js';
import type { MultiFileEmitOutput } from '../src/formats.js';
import type { IrSchema } from '../src/ir.js';
import type { NamingMode } from '../src/transforms.js';
import { kitchenSinkSchema, stressSchema } from './gormFixtures.js';
import {
  SOURCES_WITHOUT_VIEWS,
  parseSource,
  titleWithReason,
  type VerifySource,
} from './realToolSupport.js';
import {
  compile7,
  probeSequelize7,
  run7,
  scratchProject7,
  type Run7,
  type Sequelize7Probe,
} from './sequelize7Support.js';
import {
  compareWithDatabase,
  expectedAssociations,
  expectedSchema,
  forSqlite,
} from './sequelizeSupport.js';

/**
 * Loads the Sequelize 7 models that the emitter writes (`--style v7`) with the real library. For each schema
 * (the canonical blog schema read from every format, the larger prisma, django and gorm "extras" fixtures and
 * two IR fixtures) and both naming modes, the models are written for SQLite and compiled with `tsc --strict`
 * against the types of `@sequelize/core`; `new Sequelize({ dialect: SqliteDialect, models })` defines and
 * associates them, `sequelize.sync()` creates the tables in a SQLite file, and the tables, columns, nullability,
 * keys, unique keys, indexes and foreign keys are compared with the IR, and the associations the models declare
 * with the relations of the IR.
 *
 * Set SEQUELIZE7_DIR to a directory where `npm install @sequelize/core @sequelize/sqlite3 typescript @types/node`
 * has been run (see test/README.md and test/tools/setup-verification-tools.sh). The tests are skipped when it
 * is not set.
 */

const probe: Sequelize7Probe = probeSequelize7();
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
];

describe(
  titleWithReason('sequelize 7 emitter: real Sequelize 7', probe),
  () => {
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
      'creates the schema of %s in SQLite from the Sequelize 7 models (%s naming)',
      async (_label: string, naming: NamingMode, subject: Subject) => {
        const schema: IrSchema = forSqlite(await subject.build());
        const output: MultiFileEmitOutput = emitSequelize(
          structuredClone(schema),
          { provider: 'sqlite', naming, style: 'v7' }
        );
        const files: Record<string, string> = {};
        for (const [path, text] of Object.entries(output.files)) {
          files[`models/${path}`] = text;
        }
        const directory: string = scratchProject7(probe, files);
        directories.push(directory);
        expect(compile7(probe, directory, Object.keys(files)), 'tsc').toBe('');

        const { run, result } = run7(probe, directory, 'out/models/index.js');
        expect(run.status, run.stderr).toBe(0);
        const database: Run7 = result as Run7;

        const ir: IrSchema = expectedSchema(schema, naming);
        expect(compareWithDatabase(ir, database)).toEqual([]);
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
  }
);
