import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { emitSqlDdl } from '../src/emitters/sqlDdl.js';
import type { IrIndex, IrModel, IrSchema } from '../src/ir.js';
import { runConversion } from '../src/io.js';
import { parseSqlDdl } from '../src/parsers/sqlDdl.js';
import { orderSqlMigrationFiles } from '../src/parsers/sqlMigrationOrder.js';
import type { SqlDialect } from '../src/parsers/sqlSyntax.js';
import { expandManyToMany } from '../src/transforms.js';
import { DEFAULT_OPTIONS, expectOk } from './helpers.js';
import { constructsSchema } from './drizzleFixtures.js';
import { kitchenSinkSchema, stressSchema } from './gormFixtures.js';
import { parseSource, VERIFY_SOURCES } from './realToolSupport.js';
import { summarizeSchema } from './schemaSummary.js';
import { REPLAY_CASES, type ReplayCase } from './sqlReplayCases.js';

const GOLDEN_DIRECTORY: string = fileURLToPath(
  new URL('./golden-extras/sql-migration-replay/', import.meta.url)
);

/** Compares text with test/golden-extras/sql-migration-replay/<name>; run with UPDATE_GOLDEN=1 to rewrite it. */
function expectMatchesGolden(name: string, actual: string): void {
  const goldenPath: string = join(GOLDEN_DIRECTORY, name);
  if (process.env.UPDATE_GOLDEN === '1') {
    mkdirSync(dirname(goldenPath), { recursive: true });
    writeFileSync(goldenPath, actual);
    return;
  }
  if (!existsSync(goldenPath)) {
    throw new Error(
      `Golden file test/golden-extras/sql-migration-replay/${name} does not exist. Run the tests with UPDATE_GOLDEN=1 to create it.`
    );
  }
  expect(actual).toBe(readFileSync(goldenPath, 'utf8'));
}

// ---------------------------------------------------------------------------
// Statement forms, per dialect
// ---------------------------------------------------------------------------

describe.each(REPLAY_CASES)(
  'migration replay: $label statements',
  ({ label, dialect, cases }) => {
    it('matches the golden summary of every statement form', () => {
      const sections: string[] = cases.map((replay: ReplayCase): string => {
        const schema: IrSchema = expectOk(
          parseSqlDdl([{ path: 'migration.sql', text: replay.sql }], {
            appLabel: 'app',
            dialect,
          })
        );
        return `## ${replay.name}\n${summarizeSchema(schema)}\n`;
      });
      expectMatchesGolden(`${label}.txt`, sections.join('\n'));
    });
  }
);

function parse(text: string, dialect: SqlDialect = 'postgresql'): IrSchema {
  return expectOk(
    parseSqlDdl([{ path: 'm.sql', text }], { appLabel: 'app', dialect })
  );
}

function model(schema: IrSchema, table: string): IrModel {
  const found: IrModel | undefined = schema.models.find(
    (candidate: IrModel) => candidate.tableName === table
  );
  if (found === undefined) {
    throw new Error(
      `No table ${table}; have ${schema.models.map((item) => item.tableName).join(', ')}.`
    );
  }
  return found;
}

describe('migration replay: what a rename carries along', () => {
  it('points foreign keys, indexes and uniques at the renamed table and column', () => {
    const schema: IrSchema = parse(`
      CREATE TABLE author (id serial PRIMARY KEY, email text UNIQUE);
      CREATE TABLE post (id serial PRIMARY KEY, author_id int NOT NULL REFERENCES author (id), title text);
      CREATE INDEX post_title_idx ON post (title);
      CREATE UNIQUE INDEX post_author_title_key ON post (author_id, title);
      ALTER TABLE author RENAME TO writer;
      ALTER TABLE writer RENAME COLUMN id TO writer_id;
      ALTER TABLE post RENAME COLUMN title TO headline;
      ALTER TABLE post RENAME COLUMN author_id TO writer_ref;
    `);
    expect(schema.warnings).toEqual([]);
    const post: IrModel = model(schema, 'post');
    expect(post.relations).toHaveLength(1);
    expect(post.relations[0]).toMatchObject({
      columnName: 'writer_ref',
      targetModel: 'Writer',
    });
    expect(post.indexes.map((index: IrIndex) => index.fields)).toEqual([
      ['headline'],
      ['writer', 'headline'],
    ]);
    expect(
      model(schema, 'writer').fields.map((field) => field.columnName)
    ).toEqual(['writer_id', 'email']);
  });

  it('keeps a foreign key whose table was dropped and created again under the old name', () => {
    const schema: IrSchema = parse(
      `
      CREATE TABLE users (id integer PRIMARY KEY);
      CREATE TABLE posts (id integer PRIMARY KEY, user_id integer REFERENCES users (id));
      CREATE TABLE __new_users (id integer PRIMARY KEY, email text);
      DROP TABLE users;
      ALTER TABLE __new_users RENAME TO users;
    `,
      'sqlite'
    );
    expect(schema.warnings).toEqual([]);
    expect(model(schema, 'posts').relations[0]).toMatchObject({
      targetModel: 'User',
    });
    expect(
      model(schema, 'users').fields.map((field) => field.columnName)
    ).toEqual(['id', 'email']);
  });

  it('rewrites the column in CHECK enums and generated columns', () => {
    const schema: IrSchema = parse(`
      CREATE TABLE t (
        id int PRIMARY KEY,
        state text NOT NULL,
        price int,
        double_price int GENERATED ALWAYS AS (price * 2) STORED,
        CONSTRAINT t_state_check CHECK (state IN ('a', 'b'))
      );
      ALTER TABLE t RENAME COLUMN state TO status;
      ALTER TABLE t RENAME COLUMN price TO cost;
    `);
    expect(
      schema.enums.map((item) => item.values.map((value) => value.dbValue))
    ).toEqual([['a', 'b']]);
    expect(
      model(schema, 't').fields.find((field) => field.columnName === 'status')
        ?.enumName
    ).toBeDefined();
    expect(
      model(schema, 't').fields.find(
        (field) => field.columnName === 'double_price'
      )?.generated?.expression
    ).toBe('cost * 2');
  });
});

describe('migration replay: warnings', () => {
  it('names the file, line, table and column of a statement it cannot apply', () => {
    const schema: IrSchema = parse(`
      CREATE TABLE t (id int PRIMARY KEY);
      ALTER TABLE t RENAME COLUMN missing TO other;
      ALTER TABLE t DROP COLUMN gone;
      DROP TABLE nope;
    `);
    expect(schema.warnings).toEqual([
      'm.sql:3: ALTER TABLE "t" RENAME COLUMN "missing": the column does not exist at this point; the statement was skipped.',
      'm.sql:4: ALTER TABLE "t" DROP COLUMN "gone": the column does not exist at this point; the statement was skipped.',
      'm.sql:5: DROP TABLE "nope": the table does not exist at this point; the statement was skipped.',
    ]);
  });

  it('summarizes data statements in one warning for the whole input, and ignores TRUNCATE', () => {
    const result: IrSchema = expectOk(
      parseSqlDdl(
        [
          {
            path: '1.sql',
            text: 'CREATE TABLE t (id int PRIMARY KEY); INSERT INTO t VALUES (1);',
          },
          {
            path: '2.sql',
            text: 'UPDATE t SET id = 2; DELETE FROM t; TRUNCATE t;',
          },
        ],
        { appLabel: 'app' }
      )
    );
    expect(result.warnings).toEqual([
      'Skipped 3 data statements (first at 1.sql:1): row data is not part of the schema.',
    ]);
  });

  it('reports a change it cannot replay once, with the table', () => {
    const schema: IrSchema = parse(`
      CREATE TABLE t (id int PRIMARY KEY);
      ALTER TABLE t SET SCHEMA other;
      ALTER TABLE t SET SCHEMA third;
    `);
    expect(schema.warnings).toEqual([
      'Skipped 2 ALTER TABLE ... SET SCHEMA statements (first at m.sql:3, table "t"): the change is not replayed, so the result may differ from the final database.',
    ]);
  });
});

describe('migration replay: dialects of a set', () => {
  it('reads a file with no dialect hint like the files around it', () => {
    const schema: IrSchema = expectOk(
      parseSqlDdl(
        [
          {
            path: '1.sql',
            text: 'CREATE TABLE `t` (`id` int NOT NULL AUTO_INCREMENT, `a` varchar(5), PRIMARY KEY (`id`)) ENGINE=InnoDB;',
          },
          { path: '2.sql', text: 'ALTER TABLE t DROP COLUMN a;' },
        ],
        { appLabel: 'app' }
      )
    );
    expect(schema.warnings).toEqual([]);
    expect(model(schema, 't').fields.map((field) => field.columnName)).toEqual([
      'id',
    ]);
  });

  it('does not take backticks for MySQL in a SQLite set', () => {
    const schema: IrSchema = expectOk(
      parseSqlDdl(
        [
          {
            path: '0000.sql',
            text: 'CREATE TABLE `t` (`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL, `a` text);',
          },
          {
            path: '0001.sql',
            text: 'ALTER TABLE `t` RENAME COLUMN `a` TO `b`;',
          },
        ],
        { appLabel: 'app' }
      )
    );
    expect(schema.warnings).toEqual([]);
    expect(model(schema, 't').fields.map((field) => field.columnName)).toEqual([
      'id',
      'b',
    ]);
  });
});

// ---------------------------------------------------------------------------
// The order of the files of a directory
// ---------------------------------------------------------------------------

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) {
    rmSync(roots.pop() as string, { recursive: true, force: true });
  }
});

function tempDirectory(files: Record<string, string>): string {
  const root: string = mkdtempSync(join(tmpdir(), 'ormbridge-migrations-'));
  roots.push(root);
  for (const [name, text] of Object.entries(files)) {
    const path: string = join(root, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  }
  return root;
}

async function readDirectory(directory: string, extra: string[] = []) {
  return runConversion({
    ...DEFAULT_OPTIONS,
    inputs: [directory, ...extra],
    from: 'sql',
    to: 'prisma',
  });
}

function fileNames(paths: readonly string[], root: string): string[] {
  return paths.map((path: string) => path.slice(root.length + 1));
}

describe('migration files: order', () => {
  it('runs Flyway files by version number, then repeatable ones, and skips undo scripts and callbacks', () => {
    const files: string[] = [
      'V10__ten.sql',
      'V2__two.sql',
      'V1.10__one_ten.sql',
      'V1.2__one_two.sql',
      'V1_1__one_one.sql',
      'R__views.sql',
      'R__a_first.sql',
      'U2__undo_two.sql',
      'beforeMigrate.sql',
      'afterEachMigrate__log.sql',
      'baseline.sql',
    ].map((name: string) => join('db', name));
    expect(
      orderSqlMigrationFiles(files).map((path: string) => path.slice(3))
    ).toEqual([
      'baseline.sql',
      'V1_1__one_one.sql',
      'V1.2__one_two.sql',
      'V1.10__one_ten.sql',
      'V2__two.sql',
      'V10__ten.sql',
      'R__a_first.sql',
      'R__views.sql',
    ]);
  });

  it('puts numbered files in natural order, so 2 comes before 10', () => {
    const files: string[] = ['10_c.sql', '2_b.sql', '1_a.sql', '1a.sql'];
    expect(orderSqlMigrationFiles(files)).toEqual([
      '1_a.sql',
      '1a.sql',
      '2_b.sql',
      '10_c.sql',
    ]);
  });

  it('orders directory by directory, like Prisma migrations', () => {
    const files: string[] = [
      join('migrations', '20240301_add', 'migration.sql'),
      join('migrations', '20240101_init', 'migration.sql'),
      join('migrations', '20240201_mid', 'migration.sql'),
    ];
    expect(
      orderSqlMigrationFiles(files).map((path: string) => path.split('/')[1])
    ).toEqual(['20240101_init', '20240201_mid', '20240301_add']);
  });

  it('follows the drizzle-kit journal when it lists the files', () => {
    const directory: string = 'drizzle';
    const files: string[] = ['0001_b.sql', '0000_a.sql', '0002_c.sql'].map(
      (name: string) => join(directory, name)
    );
    const journals: Map<string, string[]> = new Map([
      [directory, ['0002_c', '0000_a', '0001_b']],
    ]);
    expect(orderSqlMigrationFiles(files, journals)).toEqual([
      join(directory, '0002_c.sql'),
      join(directory, '0000_a.sql'),
      join(directory, '0001_b.sql'),
    ]);
  });

  it('reads a directory in Flyway order, so a later ALTER sees the earlier table', async () => {
    const directory: string = tempDirectory({
      'V10__rename.sql': 'ALTER TABLE t RENAME COLUMN a TO c;',
      'V2__add.sql': 'ALTER TABLE t ADD COLUMN a text;',
      'V1__create.sql': 'CREATE TABLE t (id int PRIMARY KEY);',
      'V3__undo.undo.sql': 'DROP TABLE t;',
      'U2__undo.sql': 'DROP TABLE t;',
    });
    const result = expectOk(await readDirectory(directory));
    expect(fileNames(result.inputFiles, directory)).toEqual([
      'V1__create.sql',
      'V2__add.sql',
      'V10__rename.sql',
    ]);
    expect(result.warnings).toEqual([]);
    expect(result.output).toContain('c ');
  });

  it('reads a drizzle-kit directory in journal order, with its statement breakpoints', async () => {
    const directory: string = tempDirectory({
      '0000_init.sql':
        'CREATE TABLE `t` (`id` integer PRIMARY KEY NOT NULL);\n--> statement-breakpoint\nCREATE TABLE `u` (`id` integer PRIMARY KEY NOT NULL);',
      '0001_more.sql':
        'ALTER TABLE `t` ADD `note` text;--> statement-breakpoint\nALTER TABLE `u` RENAME TO `v`;',
      'meta/_journal.json': JSON.stringify({
        version: '7',
        dialect: 'sqlite',
        entries: [
          { idx: 0, tag: '0000_init' },
          { idx: 1, tag: '0001_more' },
        ],
      }),
      'meta/0000_snapshot.json': '{}',
    });
    const result = expectOk(await readDirectory(directory));
    expect(fileNames(result.inputFiles, directory)).toEqual([
      '0000_init.sql',
      '0001_more.sql',
    ]);
    expect(result.modelCount).toBe(2);
    expect(result.warnings).toEqual([]);
  });

  it('ignores a journal that is not valid JSON', async () => {
    const directory: string = tempDirectory({
      '0001_b.sql': 'ALTER TABLE t ADD COLUMN b int;',
      '0000_a.sql': 'CREATE TABLE t (id int PRIMARY KEY);',
      'meta/_journal.json': '{ not json',
    });
    const result = expectOk(await readDirectory(directory));
    expect(fileNames(result.inputFiles, directory)).toEqual([
      '0000_a.sql',
      '0001_b.sql',
    ]);
  });

  it('keeps the order of files that are named one by one', async () => {
    const directory: string = tempDirectory({
      'b.sql': 'ALTER TABLE t ADD COLUMN b int;',
      'a.sql': 'CREATE TABLE t (id int PRIMARY KEY);',
    });
    const result = expectOk(
      await runConversion({
        ...DEFAULT_OPTIONS,
        inputs: [join(directory, 'a.sql'), join(directory, 'b.sql')],
        from: 'sql',
        to: 'prisma',
      })
    );
    expect(fileNames(result.inputFiles, directory)).toEqual(['a.sql', 'b.sql']);
    expect(result.warnings).toEqual([]);
  });

  it('reads Liquibase formatted SQL, whose changeset lines are comments', async () => {
    const directory: string = tempDirectory({
      'changelog.sql': [
        '--liquibase formatted sql',
        '',
        '--changeset ann:1',
        'CREATE TABLE t (id int PRIMARY KEY, a text);',
        '--rollback DROP TABLE t;',
        '',
        '--changeset ann:2 splitStatements:true endDelimiter:;',
        'ALTER TABLE t RENAME COLUMN a TO b;',
        '--rollback ALTER TABLE t RENAME COLUMN b TO a;',
      ].join('\n'),
    });
    const result = expectOk(await readDirectory(directory));
    expect(result.warnings).toEqual([]);
    expect(result.output).toContain('b ');
    expect(result.output).not.toMatch(/\n\s+a\s/);
  });
});

// ---------------------------------------------------------------------------
// Round trip: IR -> SQL -> a migration set -> replay
// ---------------------------------------------------------------------------

const DIALECTS: readonly {
  provider: 'postgresql' | 'mysql' | 'sqlite' | 'sqlserver';
  dialect: SqlDialect;
}[] = [
  { provider: 'postgresql', dialect: 'postgresql' },
  { provider: 'mysql', dialect: 'mysql' },
  { provider: 'sqlite', dialect: 'sqlite' },
  { provider: 'sqlserver', dialect: 'sqlserver' },
];

/** Splits a script into statements at the semicolons that end a line (the writer puts none inside a statement). */
function splitScript(text: string): string[] {
  const statements: string[] = [];
  let current: string[] = [];
  for (const line of text.split('\n')) {
    if (line.startsWith('--') && current.length === 0) {
      continue;
    }
    current.push(line);
    if (line.trimEnd().endsWith(';') || line.trim() === 'GO') {
      statements.push(current.join('\n'));
      current = [];
    }
  }
  if (current.join('').trim() !== '') {
    statements.push(current.join('\n'));
  }
  return statements.filter((statement: string) => statement.trim() !== '');
}

function normalizeLocations(warnings: string[]): string[] {
  return warnings.map((warning: string) =>
    warning.replace(/[\w.-]+\.sql:\d+/g, 'FILE:LINE')
  );
}

interface RoundTripSchema {
  label: string;
  load: () => Promise<IrSchema>;
}

const ROUND_TRIP_SCHEMAS: readonly RoundTripSchema[] = [
  ...VERIFY_SOURCES.map((source): RoundTripSchema => ({
    label: source.label,
    load: () => parseSource(source),
  })),
  { label: 'kitchen-sink', load: () => Promise.resolve(kitchenSinkSchema()) },
  { label: 'stress', load: () => Promise.resolve(stressSchema()) },
  { label: 'constructs', load: () => Promise.resolve(constructsSchema()) },
];

describe.each(DIALECTS)(
  'migration round trip in $provider',
  ({ provider, dialect }) => {
    it.each(ROUND_TRIP_SCHEMAS)(
      'replays the $label schema written one statement per migration file',
      async (entry: RoundTripSchema) => {
        const schema: IrSchema = expandManyToMany(await entry.load());
        const script: string = emitSqlDdl(schema, {
          provider,
          naming: 'preserve',
        }).text;
        const whole: IrSchema = expectOk(
          parseSqlDdl([{ path: 'schema.sql', text: script }], {
            appLabel: 'app',
            dialect,
          })
        );
        const statements: string[] = splitScript(script);
        // Flyway names; V10 comes after V9 only when the numbers are compared as numbers.
        const files = statements.map((statement: string, position: number) => ({
          path: join('db', `V${position + 1}__step.sql`),
          text: statement,
        }));
        const ordered: string[] = orderSqlMigrationFiles(
          files.map((file) => file.path)
        );
        const byPath: Map<string, string> = new Map(
          files.map((file) => [file.path, file.text])
        );
        const replayed: IrSchema = expectOk(
          parseSqlDdl(
            ordered.map((path: string) => ({
              path,
              text: byPath.get(path) as string,
            })),
            { appLabel: 'app', dialect }
          )
        );
        expect(replayed.models).toEqual(whole.models);
        expect(replayed.enums).toEqual(whole.enums);
        expect(normalizeLocations(replayed.warnings)).toEqual(
          normalizeLocations(whole.warnings)
        );
      }
    );
  }
);
