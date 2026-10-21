import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { runConversion } from '../src/io.js';
import type { IrModel, IrSchema } from '../src/ir.js';
import { parseSequelize } from '../src/parsers/sequelize.js';
import { DEFAULT_OPTIONS, expectOk } from './helpers.js';
import { summarizeSchema } from './schemaSummary.js';
import {
  MIGRATION_CASES,
  type MigrationCase,
} from './sequelizeMigrationCases.js';

const FIXTURES: string = fileURLToPath(
  new URL('./fixtures/sequelize-migrations/', import.meta.url)
);
const GOLDEN_DIRECTORY: string = fileURLToPath(
  new URL('./golden-extras/sequelize-migrations/', import.meta.url)
);

/** Compares text with test/golden-extras/sequelize-migrations/<name>; run with UPDATE_GOLDEN=1 to rewrite it. */
function expectMatchesGolden(name: string, actual: string): void {
  const goldenPath: string = join(GOLDEN_DIRECTORY, name);
  if (process.env.UPDATE_GOLDEN === '1') {
    mkdirSync(dirname(goldenPath), { recursive: true });
    writeFileSync(goldenPath, actual);
    return;
  }
  if (!existsSync(goldenPath)) {
    throw new Error(
      `Golden file test/golden-extras/sequelize-migrations/${name} does not exist. Run the tests with UPDATE_GOLDEN=1 to create it.`
    );
  }
  expect(actual).toBe(readFileSync(goldenPath, 'utf8'));
}

/** Reads migration files with the Sequelize reader, handing them over in reverse order. */
async function replay(files: Record<string, string>): Promise<IrSchema> {
  const sources = Object.entries(files)
    .map(([path, text]) => ({ path, text }))
    .reverse();
  return expectOk(await parseSequelize(sources, { appLabel: 'app' }));
}

function readFolder(directory: string): Record<string, string> {
  const files: Record<string, string> = {};
  for (const name of readdirSync(directory).sort()) {
    if (/\.[cm]?[jt]s$/.test(name)) {
      files[name] = readFileSync(join(directory, name), 'utf8');
    }
  }
  return files;
}

function table(schema: IrSchema, name: string): IrModel {
  const found: IrModel | undefined = schema.models.find(
    (candidate: IrModel) => candidate.tableName === name
  );
  if (found === undefined) {
    throw new Error(
      `No table ${name}; have ${schema.models.map((item) => item.tableName).join(', ')}.`
    );
  }
  return found;
}

// ---------------------------------------------------------------------------
// Fixture sets and statement forms
// ---------------------------------------------------------------------------

describe('sequelize migrations: fixture sets', () => {
  const sets: string[] = readdirSync(FIXTURES).sort();

  it('has the fixture sets the real-tool test runs', () => {
    expect(sets).toEqual(['blog', 'changes', 'keys', 'shapes', 'typescript']);
  });

  it.each(sets)(
    'replays the %s set into the schema of the golden summary',
    async (set: string) => {
      const schema: IrSchema = await replay(readFolder(join(FIXTURES, set)));
      expectMatchesGolden(`${set}.txt`, `${summarizeSchema(schema)}\n`);
    }
  );
});

describe('sequelize migrations: statement forms', () => {
  it('matches the golden summary of every call', async () => {
    const sections: string[] = [];
    for (const replayCase of MIGRATION_CASES as MigrationCase[]) {
      const schema: IrSchema = await replay(replayCase.files);
      sections.push(`## ${replayCase.name}\n${summarizeSchema(schema)}\n`);
    }
    expectMatchesGolden('statements.txt', sections.join('\n'));
  });
});

// ---------------------------------------------------------------------------
// Behaviour the summaries do not show
// ---------------------------------------------------------------------------

describe('sequelize migrations: what the replay does', () => {
  it('names a model after its table and keeps the database names', async () => {
    const schema: IrSchema = await replay({
      '001.js': `module.exports = { up: async (qi, S) => {
        await qi.createTable('blog_posts', { id: { type: S.INTEGER, primaryKey: true }, firstName: S.STRING, last_name: S.STRING });
        await qi.createTable('People', { id: { type: S.INTEGER, primaryKey: true } });
        await qi.createTable('person', { id: { type: S.INTEGER, primaryKey: true } });
      } };`,
    });
    expect(schema.models.map((model: IrModel) => model.name)).toEqual([
      'BlogPost',
      'Person',
      'Person2',
    ]);
    expect(table(schema, 'blog_posts').fields.map((f) => f.name)).toEqual([
      'id',
      'firstName',
      'last_name',
    ]);
  });

  it('does not add the id and timestamp columns Sequelize adds to a model', async () => {
    const schema: IrSchema = await replay({
      '001.js': `module.exports = { up: async (qi, S) => {
        await qi.createTable('plain', { name: S.STRING });
      } };`,
    });
    expect(table(schema, 'plain').fields.map((f) => f.columnName)).toEqual([
      'name',
    ]);
    expect(schema.warnings).toEqual([
      'table "plain": the model has no primary key; most ORMs need one, so add primaryKey: true to a column.',
    ]);
  });

  it('uses the models and ignores the migrations when the input holds both', async () => {
    const schema: IrSchema = await replay({
      'models/user.js': `module.exports = (sequelize, DataTypes) =>
        sequelize.define('User', { name: DataTypes.STRING }, { tableName: 'users' });`,
      'migrations/001.js': `module.exports = { up: async (qi, S) => {
        await qi.createTable('other', { id: { type: S.INTEGER, primaryKey: true } });
      } };`,
    });
    expect(schema.models.map((model: IrModel) => model.tableName)).toEqual([
      'users',
    ]);
    expect(schema.warnings).toContain(
      '1 migration file was ignored because the input also defines models: 001.js. Pass the migrations alone to rebuild the schema from them.'
    );
  });

  it('reports files that hold no migration in the message for an input without models', async () => {
    const result = await parseSequelize(
      [
        {
          path: 'migrations/001.js',
          text: 'module.exports = { up: async (qi) => { await qi.describeTable("x"); } };',
        },
      ],
      { appLabel: 'app' }
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('NO_MODELS_FOUND');
      expect(result.error.message).toContain(
        'A folder of sequelize-cli migrations'
      );
    }
  });

  it('never runs the code of a migration', async () => {
    const schema: IrSchema = await replay({
      '001.js': `process.exitCode = 99;
        throw new Error('migration code ran');
        module.exports = { up: async (qi, S) => { await qi.createTable('safe', { id: { type: S.INTEGER, primaryKey: true } }); } };`,
    });
    expect(schema.models.map((model: IrModel) => model.tableName)).toEqual([
      'safe',
    ]);
    expect(process.exitCode).not.toBe(99);
  });

  it('keeps the warnings of the replay out of the shared summary when the migrations are fine', async () => {
    const schema: IrSchema = await replay(readFolder(join(FIXTURES, 'keys')));
    expect(schema.warnings).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Folders: what --from sequelize reads
// ---------------------------------------------------------------------------

describe('sequelize migrations: folders', () => {
  const directories: string[] = [];

  afterEach(() => {
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  function project(files: Record<string, string>): string {
    const directory: string = mkdtempSync(join(tmpdir(), 'ormbridge-seqmig-'));
    directories.push(directory);
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(directory, path)), { recursive: true });
      writeFileSync(join(directory, path), text);
    }
    return directory;
  }

  const MIGRATION: string = `module.exports = { up: async (qi, S) => {
    await qi.createTable('things', { id: { type: S.INTEGER, primaryKey: true, autoIncrement: true } });
  } };`;

  async function convert(input: string): Promise<string> {
    const result = expectOk(
      await runConversion({
        ...DEFAULT_OPTIONS,
        inputs: [input],
        from: 'sequelize',
        to: 'prisma',
      })
    );
    return result.output;
  }

  it('reads a folder of migrations passed on its own', async () => {
    const directory: string = project({
      'migrations/001-create.js': MIGRATION,
    });
    expect(await convert(join(directory, 'migrations'))).toContain(
      'model Thing {'
    );
  });

  it('finds the migrations of a project that has no models', async () => {
    for (const folder of ['migrations', 'db/migrations', 'src/migrations']) {
      const directory: string = project({
        [`${folder}/001-create.js`]: MIGRATION,
      });
      expect(await convert(directory), folder).toContain('model Thing {');
    }
  });

  it('follows the migrations-path of .sequelizerc', async () => {
    const directory: string = project({
      '.sequelizerc': `const path = require('path');\nmodule.exports = { 'migrations-path': path.resolve('db', 'migrate') };\n`,
      'db/migrate/001-create.js': MIGRATION,
    });
    expect(await convert(directory)).toContain('model Thing {');
  });

  it('reads the models and skips the migrations of a project that has both', async () => {
    const directory: string = project({
      'models/user.js': `module.exports = (sequelize, DataTypes) =>
        sequelize.define('User', { name: DataTypes.STRING }, { tableName: 'users' });`,
      'migrations/001-create.js': MIGRATION,
    });
    const output: string = await convert(directory);
    expect(output).toContain('model User {');
    expect(output).not.toContain('model Thing');
  });
});
