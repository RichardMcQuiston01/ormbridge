import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  emitJpa,
  JPA_STYLES,
  type JpaKeyMode,
  type JpaStyle,
} from '../src/emitters/jpa.js';
import type { MultiFileEmitOutput } from '../src/formats.js';
import type {
  IrField,
  IrIndex,
  IrModel,
  IrRelation,
  IrSchema,
} from '../src/ir.js';
import { normalizeSchema, type NamingMode } from '../src/transforms.js';
import { constructsSchema } from './drizzleFixtures.js';
import { edgesSchema } from './efcoreFixtures.js';
import { kitchenSinkSchema, stressSchema } from './gormFixtures.js';
import { identifierCandidate } from '../src/emitters/jpaKeys.js';
import { compareBehavior } from './jpaBehavior.js';
import { jpaEdgesSchema } from './jpaFixtures.js';
import {
  isToolError,
  JPA_EXTRAS,
  parseJpaExtra,
  probeJava,
  runJpaTool,
  toDbSchema,
  type JpaDatabase,
  type JpaToolOutput,
} from './jpaSupport.js';
import {
  SOURCES_WITHOUT_VIEWS,
  parseSource,
  titleWithReason,
  type VerifySource,
} from './realToolSupport.js';
import { compareWithDatabase } from './sequelizeSupport.js';

/**
 * Compiles the Java that the JPA writer produces and lets the real Hibernate create the database from it. For each
 * schema (the canonical blog schema read from every format, the larger prisma, django and gorm "extras" fixtures,
 * the IR fixtures and the JPA reader's own fixtures), both styles and both naming modes, the entities are written
 * into their own directory; `test/tools/jpa-verify` compiles each with the JDK compiler (every lint warning is an
 * error), lets Hibernate create the schema in an in-memory H2 database (`hbm2ddl.auto=create`), prints what JDBC
 * metadata reports and then saves one row into every table through the entity classes. The `jakarta` style runs
 * on Hibernate 6.4, the `javax` style on Hibernate 5.6 (a second Maven module, `pom-javax.xml`). The tables,
 * columns, nullability, keys, unique keys, indexes and foreign keys (with their delete actions) are compared with
 * the IR, and the saved rows with its defaults, enums and generated values.
 *
 * Set JPA_DIR to a scratch directory (the Maven repository goes there; see test/tools/setup-verification-tools.sh)
 * and, when `java` or `mvn` are not on the PATH, JAVA and MVN to the executables. The tests are skipped, with the
 * reason in their title, when Java 17 or Maven is missing.
 */

const probe: ReturnType<typeof probeJava> = probeJava();
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
  { label: 'jpa-edges', build: () => Promise.resolve(jpaEdgesSchema()) },
  ...JPA_EXTRAS.map((name: string): Subject => ({
    label: `jpa-${name}`,
    build: () => parseJpaExtra(name),
  })),
];

type Provider = 'postgresql' | 'sqlite' | 'mysql' | 'sqlserver';

interface Combo {
  subject: Subject;
  style: JpaStyle;
  naming: NamingMode;
  provider: Provider;
  name: string;
  /** How composite keys are written; the default is `idclass`. */
  keyMode?: JpaKeyMode;
  /** True when the entities use Lombok annotations in place of accessors. */
  lombok?: boolean;
  /** Shown in the test title: the key mode and Lombok, or `default`. */
  variant: string;
  /** The IR the database has to match. */
  schema?: IrSchema;
  output?: MultiFileEmitOutput;
}

/**
 * The PostgreSQL output of the `jakarta` style uses PostgreSQL types (text columns, arrays) that H2 understands; the
 * `javax` style is checked with the SQLite provider, whose output (large objects, plain strings) needs no
 * PostgreSQL-only SQL at all. Two further providers run on `jakarta` to cover the other column mappings.
 */
const COMBOS: Combo[] = SUBJECTS.flatMap((subject: Subject, index: number) => [
  ...(['preserve', 'normalize'] as const).flatMap((naming: NamingMode) => [
    {
      subject,
      style: 'jakarta' as const,
      naming,
      provider: 'postgresql' as const,
      name: `s${index}_jakarta_${naming}_pg`,
      variant: 'default',
    },
    {
      subject,
      style: 'javax' as const,
      naming,
      provider: 'sqlite' as const,
      name: `s${index}_javax_${naming}_sqlite`,
      variant: 'default',
    },
    // @EmbeddedId key classes with Lombok accessors (the compiler runs Lombok as an annotation processor).
    {
      subject,
      style: 'jakarta' as const,
      naming,
      provider: 'postgresql' as const,
      name: `s${index}_jakarta_${naming}_pg_embedded_lombok`,
      keyMode: 'embedded' as const,
      lombok: true,
      variant: 'embedded keys + Lombok',
    },
    {
      subject,
      style: 'javax' as const,
      naming,
      provider: 'sqlite' as const,
      name: `s${index}_javax_${naming}_sqlite_embedded_lombok`,
      keyMode: 'embedded' as const,
      lombok: true,
      variant: 'embedded keys + Lombok',
    },
  ]),
  {
    subject,
    style: 'jakarta' as const,
    naming: 'preserve' as const,
    provider: 'sqlite' as const,
    name: `s${index}_jakarta_preserve_sqlite`,
    variant: 'default',
  },
  // Each new mode alone: embedded keys with hand-written accessors, and Lombok with @IdClass keys.
  {
    subject,
    style: 'jakarta' as const,
    naming: 'preserve' as const,
    provider: 'sqlite' as const,
    name: `s${index}_jakarta_preserve_sqlite_embedded`,
    keyMode: 'embedded' as const,
    variant: 'embedded keys',
  },
  {
    subject,
    style: 'javax' as const,
    naming: 'preserve' as const,
    provider: 'sqlite' as const,
    name: `s${index}_javax_preserve_sqlite_lombok`,
    lombok: true,
    variant: 'Lombok',
  },
]);

/** Every subject is also compiled (not run) for the providers that cannot run on H2, in both styles. */
const COMPILE_ONLY: Combo[] = SUBJECTS.flatMap(
  (subject: Subject, index: number) =>
    JPA_STYLES.flatMap((style: JpaStyle) =>
      (['postgresql', 'mysql', 'sqlserver'] as const).map(
        (provider: Provider): Combo => ({
          subject,
          style,
          naming: 'preserve',
          provider,
          name: `c${index}_${style}_${provider}`,
          variant: 'default',
        })
      )
    )
);

/**
 * What the writer cannot write is taken out of the IR the database is compared with: referential actions on update
 * (JPA has no setting for them) and, with Hibernate 5, every action but CASCADE.
 */
function expectedSchema(
  schema: IrSchema,
  naming: NamingMode,
  style: JpaStyle
): IrSchema {
  const prepared: IrSchema =
    naming === 'normalize' ? normalizeSchema(schema) : schema;
  const action = (value: IrRelation['onDelete']): IrRelation['onDelete'] =>
    style === 'javax' && value !== 'cascade' ? 'noAction' : value;
  const clean = (relation: IrRelation): IrRelation => {
    const copy: IrRelation = { ...relation };
    delete copy.onUpdate;
    return { ...copy, onDelete: action(copy.onDelete) };
  };
  return {
    ...prepared,
    models: prepared.models.map((model: IrModel): IrModel => {
      const hasKey: boolean =
        model.compositePrimaryKey !== undefined ||
        model.fields.some((field: IrField) => field.isPrimaryKey) ||
        model.relations.some((relation) => relation.isPrimaryKey === true);
      // A model without a key gets the first NOT NULL column as its @Id.
      const chosen: IrField | undefined = hasKey
        ? undefined
        : identifierCandidate(model);
      return {
        ...model,
        fields: model.fields.map((field: IrField): IrField => {
          const copy: IrField = { ...field };
          if (copy === undefined || field !== chosen) {
            return copy;
          }
          return { ...copy, isPrimaryKey: true, isNullable: false };
        }),
        relations: model.relations.map(clean),
        compositeForeignKeys: model.compositeForeignKeys?.map((key) => {
          const copy = { ...key };
          delete copy.onUpdate;
          return { ...copy, onDelete: action(copy.onDelete) };
        }),
        indexes: model.indexes.map((index: IrIndex): IrIndex => index),
      };
    }),
  };
}

/**
 * H2 cannot evaluate or store the PostgreSQL-only things of the PostgreSQL output: database functions of a default
 * (`gen_random_uuid()`), `inet`, `hstore` and range columns, and arrays written with Hibernate 5. They are left out of the schema that is written to H2
 * (the output for them is checked by the golden files and by compiling it).
 */
function forH2(
  schema: IrSchema,
  provider: Provider,
  style: JpaStyle
): IrSchema {
  const unsupported: ReadonlySet<string> = new Set([
    'hstore',
    'range',
    'ipAddress',
    'unsupported',
  ]);
  return {
    ...schema,
    models: schema.models.map((model: IrModel): IrModel => {
      // A JSON column of Hibernate 5 is large text, which H2 cannot index (the index was a PostgreSQL GIN index).
      const unindexed: Set<string> = new Set(
        style === 'javax'
          ? model.fields
              .filter((field: IrField) => field.type === 'json')
              .map((field: IrField) => field.name)
          : []
      );
      const dropped: Set<string> = new Set(
        model.fields
          .filter(
            (field: IrField) =>
              (provider === 'postgresql' && unsupported.has(field.type)) ||
              // Hibernate 5 writes an array as a text column with the PostgreSQL column definition `integer[]`.
              (style === 'javax' && field.arrayDepth !== undefined)
          )
          .map((field: IrField) => field.name)
      );
      const withoutPublic: IrModel = { ...model };
      if (model.schema?.toLowerCase() === 'public') {
        // H2 names its default schema PUBLIC, and the names are quoted here, so "public" would be another schema.
        delete withoutPublic.schema;
      }
      return {
        ...withoutPublic,
        fields: model.fields
          .filter((field: IrField) => !dropped.has(field.name))
          .map((field: IrField): IrField => {
            if (
              field.default?.kind !== 'dbExpression' ||
              /^(current_|now\(\))/i.test(field.default.expression)
            ) {
              return field;
            }
            const withoutDefault: IrField = { ...field };
            delete withoutDefault.default;
            return withoutDefault;
          }),
        indexes: model.indexes.filter(
          (index: IrIndex) =>
            !index.fields.some(
              (name: string) => dropped.has(name) || unindexed.has(name)
            )
        ),
      };
    }),
  };
}

let jakartaOutput: JpaToolOutput = {};
let javaxOutput: JpaToolOutput = {};
let compileOutput: JpaToolOutput = {};
let compileJavaxOutput: JpaToolOutput = {};

function write(root: string, combo: Combo): void {
  for (const [path, text] of Object.entries(combo.output?.files ?? {})) {
    const target: string = join(root, combo.name, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, text);
  }
}

function groups(
  root: string,
  list: readonly Combo[]
): { name: string; directory: string }[] {
  return list.map((combo: Combo) => ({
    name: combo.name,
    directory: join(root, combo.name),
  }));
}

beforeAll(async () => {
  if (!probe.available) {
    return;
  }
  const root: string = mkdtempSync(join(tmpdir(), 'ormbridge-jpa-gen-'));
  directories.push(root);
  for (const combo of [...COMBOS, ...COMPILE_ONLY]) {
    const built: IrSchema = await combo.subject.build();
    const compileOnly: boolean = combo.name.startsWith('c');
    const schema: IrSchema = compileOnly
      ? built
      : forH2(built, combo.provider, combo.style);
    combo.schema = schema;
    combo.output = emitJpa(structuredClone(schema), {
      provider: combo.provider,
      naming: combo.naming,
      style: combo.style,
      ...(combo.keyMode === undefined ? {} : { keyMode: combo.keyMode }),
      ...(combo.lombok === undefined ? {} : { lombok: combo.lombok }),
    });
    write(root, combo);
  }
  const options = { keepImports: true, strict: true };
  jakartaOutput = runJpaTool(
    probe,
    groups(
      root,
      COMBOS.filter((combo: Combo) => combo.style === 'jakarta')
    ),
    { ...options, exercise: true }
  );
  javaxOutput = runJpaTool(
    probe,
    groups(
      root,
      COMBOS.filter((combo: Combo) => combo.style === 'javax')
    ),
    { ...options, exercise: true, variant: 'javax' }
  );
  compileOutput = runJpaTool(
    probe,
    groups(
      root,
      COMPILE_ONLY.filter((combo: Combo) => combo.style === 'jakarta')
    ),
    { ...options, compileOnly: true }
  );
  compileJavaxOutput = runJpaTool(
    probe,
    groups(
      root,
      COMPILE_ONLY.filter((combo: Combo) => combo.style === 'javax')
    ),
    { ...options, compileOnly: true, variant: 'javax' }
  );
}, 1_800_000);

function databaseOf(combo: Combo): JpaDatabase {
  const output: JpaToolOutput =
    combo.style === 'jakarta' ? jakartaOutput : javaxOutput;
  const database = output[combo.name];
  expect(database, `no output for ${combo.name}`).toBeDefined();
  if (isToolError(database)) {
    throw new Error(
      `Hibernate (or the compiler) rejected ${combo.name}:\n${database.__error}`
    );
  }
  return database as JpaDatabase;
}

describe(titleWithReason('jpa emitter: real Hibernate', probe), () => {
  it.skipIf(!probe.available).each(COMBOS)(
    'compiles and creates the schema of $subject.label in H2 ($style style, $naming naming, $provider, $variant)',
    (combo: Combo) => {
      const database: JpaDatabase = databaseOf(combo);
      const ir: IrSchema = expectedSchema(
        combo.schema ?? { models: [], enums: [], warnings: [] },
        combo.naming,
        combo.style
      );
      expect(
        compareWithDatabase(ir, toDbSchema(database, ir), {
          compositeForeignKeys: true,
        })
      ).toEqual([]);
    },
    60_000
  );

  it.skipIf(!probe.available).each(COMBOS)(
    'saves rows of $subject.label with the defaults, enums and generated values of the IR ($style style, $naming naming, $provider, $variant)',
    (combo: Combo) => {
      const database: JpaDatabase = databaseOf(combo);
      const ir: IrSchema = expectedSchema(
        combo.schema ?? { models: [], enums: [], warnings: [] },
        combo.naming,
        combo.style
      );
      expect(compareBehavior(ir, database)).toEqual([]);
    },
    60_000
  );
});

describe(
  titleWithReason('jpa emitter: compiling every provider', probe),
  () => {
    it.skipIf(!probe.available).each(COMPILE_ONLY)(
      'compiles the $provider output of $subject.label without warnings ($style style)',
      (combo: Combo) => {
        const output: JpaToolOutput =
          combo.style === 'jakarta' ? compileOutput : compileJavaxOutput;
        const result = output[combo.name];
        expect(result, `no output for ${combo.name}`).toBeDefined();
        if (isToolError(result)) {
          throw new Error(
            `The compiler rejected ${combo.name}:\n${result.__error}`
          );
        }
        expect(Object.keys(combo.output?.files ?? {}).length).toBeGreaterThan(
          0
        );
      },
      60_000
    );
  }
);
