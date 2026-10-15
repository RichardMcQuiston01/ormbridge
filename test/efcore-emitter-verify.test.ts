import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  EFCORE_STYLES,
  emitEfcore,
  type EfcoreStyle,
} from '../src/emitters/efcore.js';
import type { MultiFileEmitOutput } from '../src/formats.js';
import type { IrField, IrModel, IrRelation, IrSchema } from '../src/ir.js';
import { normalizeSchema, type NamingMode } from '../src/transforms.js';
import { constructsSchema } from './drizzleFixtures.js';
import { edgesSchema } from './efcoreFixtures.js';
import { compareBehavior } from './efcoreBehavior.js';
import {
  EFCORE_EXTRAS,
  isToolError,
  parseEfcoreExtra,
  splitExercise,
  probeDotnet,
  runEfcoreTool,
  toDbSchema,
  type EfcoreDatabase,
  type EfcoreToolOutput,
} from './efcoreSupport.js';
import { kitchenSinkSchema, stressSchema } from './gormFixtures.js';
import {
  SOURCES_WITHOUT_VIEWS,
  parseSource,
  titleWithReason,
  type VerifySource,
} from './realToolSupport.js';
import { compareWithDatabase } from './sequelizeSupport.js';

/**
 * Compiles the C# that the EF Core writer produces and lets the real Entity Framework Core 8 build the database
 * from it. For each schema (the canonical blog schema read from every format, the larger prisma, django and gorm
 * "extras" fixtures and three IR fixtures), both styles and both naming modes, the models are written for SQLite
 * into their own namespace; all of them are compiled together with `dotnet` (nullable warnings and every other
 * warning are errors), `EnsureCreated()` creates each context in an in-memory SQLite database, and
 * `test/tools/efcore-verify` prints what SQLite reports. The tables, columns, nullability, keys, unique keys,
 * indexes and foreign keys (with their delete actions) are compared with the IR.
 *
 * Set EFCORE_DIR to a scratch directory and have the .NET 8 SDK installed (see test/README.md and
 * test/tools/setup-verification-tools.sh). The tests are skipped, with the reason in their title, when it is missing.
 */

const probe: ReturnType<typeof probeDotnet> = probeDotnet();
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
  { label: 'constructs', build: () => Promise.resolve(constructsSchema()) },
  { label: 'edges', build: () => Promise.resolve(edgesSchema()) },
  ...EFCORE_EXTRAS.map((name: string): Subject => ({
    label: `efcore-${name}`,
    build: () => parseEfcoreExtra(name),
  })),
];

interface Combo {
  subject: Subject;
  style: EfcoreStyle;
  naming: NamingMode;
  provider: 'sqlite' | 'postgresql';
  namespace: string;
  /** The IR the database has to match. */
  schema?: IrSchema;
  output?: MultiFileEmitOutput;
}

const COMBOS: Combo[] = SUBJECTS.flatMap((subject: Subject, index: number) =>
  EFCORE_STYLES.flatMap((style: EfcoreStyle) =>
    (['preserve', 'normalize'] as const).map((naming: NamingMode): Combo => ({
      subject,
      style,
      naming,
      provider: 'sqlite',
      namespace: `Verify.S${index}.${style}.${naming}`,
    }))
  )
);

/**
 * The PostgreSQL output uses types and calls of the Npgsql provider (arrays of enums, NpgsqlRange, IPAddress,
 * hstore, index methods). SQLite cannot run it, so it is only compiled (against the Npgsql package, with warnings
 * as errors).
 */
const COMPILE_ONLY: Combo[] = SUBJECTS.flatMap(
  (subject: Subject, index: number) =>
    EFCORE_STYLES.map((style: EfcoreStyle): Combo => ({
      subject,
      style,
      naming: 'preserve',
      provider: 'postgresql',
      namespace: `Verify.Pg${index}.${style}`,
    }))
);

/**
 * What EF Core cannot write is taken out of the IR the database is compared with: referential actions on update
 * (EF Core has no setting for them) and SET DEFAULT (written as NO ACTION).
 */
function expectedSchema(schema: IrSchema, naming: NamingMode): IrSchema {
  const prepared: IrSchema =
    naming === 'normalize' ? normalizeSchema(schema) : schema;
  const clean = (relation: IrRelation): IrRelation => {
    const copy: IrRelation = { ...relation };
    delete copy.onUpdate;
    return copy.onDelete === 'setDefault'
      ? { ...copy, onDelete: 'noAction' }
      : copy;
  };
  return {
    ...prepared,
    models: prepared.models.map((model: IrModel): IrModel => ({
      ...model,
      relations: model.relations.map(clean),
      compositeForeignKeys: model.compositeForeignKeys?.map((key) => {
        const copy = { ...key };
        delete copy.onUpdate;
        return copy.onDelete === 'setDefault'
          ? { ...copy, onDelete: 'noAction' as const }
          : copy;
      }),
    })),
  };
}

/**
 * SQLite cannot evaluate the database functions of a PostgreSQL schema (`gen_random_uuid()` from Prisma's
 * `dbgenerated`), so a row could not be inserted: those defaults are left out of the schema that is written.
 */
function forSqlite(schema: IrSchema): IrSchema {
  return {
    ...schema,
    models: schema.models.map((model: IrModel): IrModel => ({
      ...model,
      fields: model.fields.map((field: IrField): IrField => {
        if (
          field.default?.kind !== 'dbExpression' ||
          /^datetime\(/i.test(field.default.expression)
        ) {
          return field;
        }
        const withoutDefault: IrField = { ...field };
        delete withoutDefault.default;
        return withoutDefault;
      }),
    })),
  };
}

let output: EfcoreToolOutput = {};

beforeAll(async () => {
  if (!probe.available) {
    return;
  }
  const fixtures: string = mkdtempSync(join(tmpdir(), 'ormbridge-efcore-gen-'));
  directories.push(fixtures);
  for (const combo of [...COMBOS, ...COMPILE_ONLY]) {
    const built: IrSchema = await combo.subject.build();
    const schema: IrSchema =
      combo.provider === 'sqlite' ? forSqlite(built) : built;
    combo.schema = schema;
    combo.output = emitEfcore(structuredClone(schema), {
      provider: combo.provider,
      naming: combo.naming,
      style: combo.style,
      namespace: combo.namespace,
    });
    for (const [path, text] of Object.entries(combo.output.files)) {
      const target: string = join(fixtures, combo.namespace, path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, text);
    }
  }
  output = runEfcoreTool(probe, {
    fixturesDir: fixtures,
    contexts: COMBOS.map((combo: Combo) => `${combo.namespace}.AppDbContext`),
    strict: true,
    exercise: true,
  });
}, 960_000);

describe(titleWithReason('efcore emitter: real EF Core', probe), () => {
  it.skipIf(!probe.available).each(COMBOS)(
    'compiles and creates the schema of $subject.label in SQLite ($style style, $naming naming)',
    (combo: Combo) => {
      const database = output[`${combo.namespace}.AppDbContext`];
      expect(database, `no output for ${combo.namespace}`).toBeDefined();
      if (isToolError(database)) {
        throw new Error(`EF Core rejected the model:\n${database.__error}`);
      }
      const ir: IrSchema = expectedSchema(
        combo.schema ?? { models: [], enums: [], warnings: [] },
        combo.naming
      );
      expect(
        compareWithDatabase(
          ir,
          toDbSchema((database ?? {}) as EfcoreDatabase, ir),
          { compositeForeignKeys: true }
        )
      ).toEqual([]);
    },
    60_000
  );

  it.skipIf(!probe.available).each(COMBOS)(
    'saves rows of $subject.label with the defaults, enums and generated values of the IR ($style style, $naming naming)',
    (combo: Combo) => {
      const database = output[`${combo.namespace}.AppDbContext`];
      if (database === undefined || isToolError(database)) {
        throw new Error(`no database for ${combo.namespace}`);
      }
      const { tables, exercise } = splitExercise(database as EfcoreDatabase);
      expect(exercise, 'the tool did not exercise the context').toBeDefined();
      const ir: IrSchema = expectedSchema(
        combo.schema ?? { models: [], enums: [], warnings: [] },
        combo.naming
      );
      if (exercise !== undefined) {
        expect(compareBehavior(ir, tables, exercise)).toEqual([]);
      }
    },
    60_000
  );
});

describe(titleWithReason('efcore emitter: PostgreSQL output', probe), () => {
  it.skipIf(!probe.available).each(COMPILE_ONLY)(
    'compiles the PostgreSQL output of $subject.label without warnings ($style style)',
    (combo: Combo) => {
      // The build of the whole project succeeded in beforeAll; this checks that the files were part of it.
      expect(Object.keys(combo.output?.files ?? {})).toContain(
        'AppDbContext.cs'
      );
      expect(Object.keys(output).length).toBe(COMBOS.length);
    }
  );
});
