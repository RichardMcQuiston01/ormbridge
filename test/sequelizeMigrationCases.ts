/**
 * One case per `queryInterface` call or migration shape the Sequelize reader replays. Each case is a small set
 * of migration files (the file names sort in the order they run) that the replay test reads and writes as a
 * summary of the schema and its warnings. The summaries are the golden file
 * test/golden-extras/sequelize-migrations/statements.txt.
 */
export interface MigrationCase {
  name: string;
  /** File name -> text. The names are the ones `sequelize-cli` sorts. */
  files: Record<string, string>;
}

/** A CommonJS migration whose `up` holds `body`. */
function up(body: string): string {
  return `'use strict';\nmodule.exports = {\n  async up(queryInterface, Sequelize) {\n${body}\n  },\n  async down() {},\n};\n`;
}

/** A first migration that creates the tables most cases change. */
const SETUP: string = up(`
    await queryInterface.createTable('authors', {
      id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
      email: { type: Sequelize.STRING(120), allowNull: false },
      nickname: Sequelize.STRING(30),
    });
    await queryInterface.createTable('posts', {
      id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
      author_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: 'authors', key: 'id' },
        onDelete: 'CASCADE',
      },
      title: { type: Sequelize.STRING(200), allowNull: false },
      body: Sequelize.TEXT,
      status: { type: Sequelize.STRING(20), defaultValue: 'draft' },
    });
    await queryInterface.addIndex('posts', ['title', 'status']);
`);

function after(body: string): Record<string, string> {
  return { '001-setup.js': SETUP, '002-change.js': up(body) };
}

export const MIGRATION_CASES: MigrationCase[] = [
  {
    name: 'createTable: column forms, defaults, keys and references',
    files: {
      '001.js': up(`
    await queryInterface.createTable('accounts', {
      id: { type: Sequelize.UUID, primaryKey: true, defaultValue: Sequelize.UUIDV4 },
      handle: Sequelize.STRING,
      code: { type: Sequelize.CHAR(8), allowNull: false },
      score: { type: Sequelize.DECIMAL(10, 2), allowNull: false, defaultValue: 0 },
      kind: { type: Sequelize.ENUM('free', 'paid'), defaultValue: 'free' },
      active: { type: Sequelize.BOOLEAN, defaultValue: true },
      seen_at: { type: Sequelize.DATE, defaultValue: Sequelize.fn('now') },
      made_at: { type: Sequelize.DATE, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      born: Sequelize.DATEONLY,
      raw: Sequelize.BLOB,
      extra: { type: Sequelize.JSON, defaultValue: {} },
      tags: { type: Sequelize.ARRAY(Sequelize.TEXT), allowNull: false },
      owner_id: { type: Sequelize.INTEGER, references: { model: 'accounts', key: 'id' } },
      slug: { type: Sequelize.STRING(40), unique: true },
      note: { type: Sequelize.TEXT, comment: 'free text', field: 'ignored_in_migrations' },
    });
`),
    },
  },
  {
    name: 'createTable: a composite primary key, a table in a schema and a reference through an object',
    files: {
      '001.js': up(`
    await queryInterface.createTable('a', { id: { type: Sequelize.INTEGER, primaryKey: true } });
    await queryInterface.createTable({ tableName: 'links', schema: 'crm' }, {
      a_id: { type: Sequelize.INTEGER, primaryKey: true, references: { model: { tableName: 'a' }, key: 'id' } },
      b_id: { type: Sequelize.INTEGER, primaryKey: true },
    });
`),
    },
  },
  {
    name: 'createTable: an existing table, uniqueKeys, a name unique and an unreadable reference',
    files: {
      '001.js': up(`
    await queryInterface.createTable('t', {
      id: { type: Sequelize.INTEGER, primaryKey: true },
      a: Sequelize.STRING,
      b: Sequelize.STRING,
      c: { type: Sequelize.STRING, unique: 'c_unique' },
      d: { type: Sequelize.INTEGER, references: { model: SomeModel, key: 'id' } },
    }, { uniqueKeys: { t_a_b: { fields: ['a', 'b'] }, t_bad: { fields: ['a', 'nope'] } } });
    await queryInterface.createTable('t', { id: Sequelize.INTEGER });
    await queryInterface.createTable('computed', buildColumns());
`),
    },
  },
  {
    name: 'addColumn: types, options, a reference, an unknown table and a duplicate',
    files: after(`
    await queryInterface.addColumn('authors', 'bio', Sequelize.TEXT);
    await queryInterface.addColumn('authors', 'age', { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 });
    await queryInterface.addColumn('posts', 'editor_id', {
      type: Sequelize.INTEGER,
      references: { model: 'authors', key: 'id' },
      onDelete: 'SET NULL',
    });
    await queryInterface.addColumn('nope', 'x', Sequelize.TEXT);
    await queryInterface.addColumn('authors', 'email', Sequelize.TEXT);
`),
  },
  {
    name: 'removeColumn: indexes, constraints and keys that use the column go with it',
    files: after(`
    await queryInterface.addConstraint('posts', { fields: ['title'], type: 'unique', name: 'posts_title_uq' });
    await queryInterface.removeColumn('posts', 'title');
    await queryInterface.removeColumn('posts', 'author_id');
    await queryInterface.removeColumn('posts', 'missing');
    await queryInterface.removeColumn('nope', 'x');
`),
  },
  {
    name: 'renameColumn: indexes, constraints and the foreign keys of other tables follow',
    files: after(`
    await queryInterface.addConstraint('posts', { fields: ['body'], type: 'unique', name: 'posts_body_uq' });
    await queryInterface.renameColumn('authors', 'id', 'author_id');
    await queryInterface.renameColumn('posts', 'title', 'headline');
    await queryInterface.renameColumn('posts', 'body', 'content');
    await queryInterface.renameColumn('posts', 'status', 'headline');
    await queryInterface.renameColumn('posts', 'missing', 'other');
    await queryInterface.renameColumn('nope', 'a', 'b');
`),
  },
  {
    name: 'renameTable: foreign keys that point at the table follow',
    files: after(`
    await queryInterface.renameTable('authors', 'writers');
    await queryInterface.renameTable('posts', 'writers');
    await queryInterface.renameTable('nope', 'other');
`),
  },
  {
    name: 'changeColumn: the options the call names replace the old ones',
    files: after(`
    await queryInterface.changeColumn('authors', 'email', Sequelize.TEXT);
    await queryInterface.changeColumn('authors', 'nickname', { type: Sequelize.STRING(60), allowNull: false });
    await queryInterface.changeColumn('posts', 'status', { type: Sequelize.ENUM('draft', 'live'), allowNull: false, defaultValue: 'live' });
    await queryInterface.changeColumn('posts', 'author_id', { type: Sequelize.BIGINT, allowNull: true });
    await queryInterface.changeColumn('posts', 'missing', Sequelize.TEXT);
    await queryInterface.changeColumn('nope', 'x', Sequelize.TEXT);
`),
  },
  {
    name: 'addIndex: argument forms, options, default names and columns that do not exist',
    files: after(`
    await queryInterface.addIndex('authors', ['email'], { unique: true });
    await queryInterface.addIndex('authors', { fields: ['nickname'], name: 'authors_nick', using: 'BTREE' });
    await queryInterface.addIndex('posts', [{ name: 'title', order: 'DESC', length: 20 }, 'author_id'], { name: 'posts_sorted' });
    await queryInterface.addIndex('posts', ['body'], { where: { status: 'draft' }, name: 'posts_draft_body' });
    await queryInterface.addIndex('posts', [Sequelize.literal('lower(title)')], { name: 'posts_lower_title' });
    await queryInterface.addIndex('posts', ['status'], { type: 'FULLTEXT', name: 'posts_status_ft' });
    await queryInterface.addIndex('posts', ['missing']);
    await queryInterface.addIndex('posts', ['title', 'status']);
    await queryInterface.addIndex('nope', ['x']);
`),
  },
  {
    name: 'removeIndex: by name, by columns and by the name Sequelize gave it',
    files: after(`
    await queryInterface.addIndex('authors', ['nickname']);
    await queryInterface.addIndex('authors', ['email', 'nickname'], { name: 'authors_pair' });
    await queryInterface.removeIndex('authors', 'authors_nickname');
    await queryInterface.removeIndex('authors', ['email', 'nickname']);
    await queryInterface.removeIndex('posts', ['title', 'status']);
    await queryInterface.removeIndex('posts', 'gone');
    await queryInterface.removeIndex('nope', 'gone');
`),
  },
  {
    name: 'addConstraint: unique, primary key, foreign key, check and default',
    files: after(`
    await queryInterface.addConstraint('authors', { fields: ['email'], type: 'unique' });
    await queryInterface.addConstraint('authors', { fields: ['email', 'nickname'], type: 'unique', name: 'authors_pair_uq' });
    await queryInterface.createTable('tags', { a: Sequelize.INTEGER, b: Sequelize.INTEGER, label: Sequelize.STRING });
    await queryInterface.addConstraint('tags', { fields: ['a', 'b'], type: 'primary key', name: 'tags_pk' });
    await queryInterface.addConstraint('tags', { fields: ['a'], type: 'foreign key', references: { table: 'authors', field: 'id' }, onDelete: 'cascade', onUpdate: 'restrict' });
    await queryInterface.addConstraint('tags', { fields: ['a', 'b'], type: 'foreign key', name: 'tags_pair_fk', references: { table: 'authors', fields: ['id', 'id'] } });
    await queryInterface.addConstraint('tags', { fields: ['label'], type: 'check', where: { label: 'x' } });
    await queryInterface.addConstraint('tags', { fields: ['label'], type: 'default', defaultValue: 'tag', name: 'tags_label_df' });
    await queryInterface.addConstraint('tags', { fields: ['missing'], type: 'unique' });
    await queryInterface.addConstraint('tags', { fields: ['label'], type: 'banana' });
    await queryInterface.addConstraint('nope', { fields: ['x'], type: 'unique' });
`),
  },
  {
    name: 'removeConstraint: by the name given, by the name a database gives, and unknown names',
    files: after(`
    await queryInterface.addConstraint('authors', { fields: ['email'], type: 'unique', name: 'authors_email_uq' });
    await queryInterface.addConstraint('authors', { fields: ['nickname'], type: 'unique', name: 'authors_nick_uq' });
    await queryInterface.addConstraint('posts', { fields: ['body'], type: 'foreign key', name: 'posts_body_fk', references: { table: 'authors', field: 'id' } });
    await queryInterface.removeConstraint('authors', 'authors_email_uq');
    await queryInterface.removeConstraint('posts', 'posts_body_fk');
    await queryInterface.removeConstraint('posts', 'posts_author_id_fkey');
    await queryInterface.removeConstraint('authors', 'authors_pkey');
    await queryInterface.removeConstraint('authors', 'gone');
    await queryInterface.removeConstraint('nope', 'gone');
`),
  },
  {
    name: 'dropTable: the foreign keys that pointed at the table become plain columns',
    files: after(`
    await queryInterface.dropTable('authors');
    await queryInterface.dropTable('nope');
`),
  },
  {
    name: 'dropTable with cascade drops the dependent foreign keys without a warning',
    files: after(`
    await queryInterface.dropTable('authors', { cascade: true });
`),
  },
  {
    name: 'data and raw SQL give one warning each, whatever else a migration reads',
    files: after(`
    await queryInterface.bulkInsert('authors', [{ email: 'a@b.c' }, { email: 'd@e.f' }]);
    await queryInterface.bulkUpdate('authors', { nickname: 'x' }, { id: 1 });
    await queryInterface.bulkDelete('posts', null);
    await queryInterface.sequelize.query('UPDATE posts SET status = \\'draft\\'');
    await queryInterface.sequelize.query('ALTER TABLE authors ADD COLUMN extra int');
    await queryInterface.describeTable('authors');
    await queryInterface.showAllTables();
    await queryInterface.createSchema('crm');
    await queryInterface.createFunction('touch', [], 'void', 'plpgsql', 'BEGIN END;');
    await queryInterface.createFunction('touch2', [], 'void', 'plpgsql', 'BEGIN END;');
    await queryInterface.dropTrigger('posts', 'tg');
`),
  },
  {
    name: 'control flow is applied as if it always ran, with a warning; try blocks run their body',
    files: after(`
    if (process.env.EXTRA) {
      await queryInterface.addColumn('authors', 'extra', Sequelize.TEXT);
    } else {
      await queryInterface.addColumn('authors', 'other', Sequelize.TEXT);
    }
    for (const name of ['a', 'b']) {
      await queryInterface.addColumn('posts', name, Sequelize.TEXT);
    }
    const transaction = await queryInterface.sequelize.transaction();
    try {
      await queryInterface.addColumn('posts', 'slug', { type: Sequelize.STRING }, { transaction });
      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
`),
  },
  {
    name: 'a transaction callback, Promise.all, then chains and local helpers are followed',
    files: {
      '001.js': SETUP,
      '002.js': `'use strict';
async function addAudit(qi, DataTypes) {
  await qi.addColumn('authors', 'audit', DataTypes.TEXT);
}
const addStamp = async (qi) => {
  await qi.addColumn('posts', 'stamp', { type: 'x' });
};
module.exports = {
  up: (queryInterface, Sequelize) =>
    queryInterface.sequelize.transaction(async (t) => {
      await Promise.all([
        queryInterface.addColumn('authors', 'a', Sequelize.TEXT, { transaction: t }),
        queryInterface.addColumn('authors', 'b', Sequelize.TEXT, { transaction: t }),
      ]);
      await queryInterface.createTable('t1', { id: Sequelize.INTEGER }, { transaction: t })
        .then(() => queryInterface.addColumn('t1', 'v', Sequelize.TEXT));
      await addAudit(queryInterface, Sequelize);
      await Promise.all(['x', 'y'].map((n) => queryInterface.addColumn('posts', n, Sequelize.TEXT)));
    }),
  down: async () => {},
};
`,
    },
  },
  {
    name: 'migration shapes: exports.up, ES modules, default export, shorthand and a context parameter',
    files: {
      '001-exports.js': `exports.up = async function (qi, Sequelize) {
  await qi.createTable('one', { id: { type: Sequelize.INTEGER, primaryKey: true } });
};
`,
      '002-esm.mjs': `export async function up(queryInterface, Sequelize) {
  await queryInterface.createTable('two', { id: { type: Sequelize.INTEGER, primaryKey: true } });
}
export async function down() {}
`,
      '003-default.mjs': `export default {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('three', { id: { type: Sequelize.INTEGER, primaryKey: true } });
  },
};
`,
      '004-shorthand.cjs': `async function up(queryInterface, Sequelize) {
  await queryInterface.createTable('four', { id: { type: Sequelize.INTEGER, primaryKey: true } });
}
async function down() {}
module.exports = { up, down };
`,
      '005-context.ts': `import { DataTypes, QueryInterface } from 'sequelize';
export const up = async ({ context: queryInterface }: { context: QueryInterface }) => {
  await queryInterface.createTable('five', { id: { type: DataTypes.INTEGER, primaryKey: true } });
};
`,
      '006-expression.js': `module.exports = {
  up: (queryInterface, Sequelize) =>
    queryInterface.createTable('six', { id: { type: Sequelize.INTEGER, primaryKey: true } }),
};
`,
    },
  },
  {
    name: 'migrations run in file-name order, whatever order the files are given in',
    files: {
      '20240203-second.js': up(
        `    await queryInterface.addColumn('t', 'later', Sequelize.TEXT);\n    await queryInterface.renameColumn('t', 'first', 'renamed');`
      ),
      '20240101-first.js': up(
        `    await queryInterface.createTable('t', { id: { type: Sequelize.INTEGER, primaryKey: true }, first: Sequelize.TEXT });`
      ),
    },
  },
  {
    name: 'a file that is not a migration is left alone, and a table that is not found by name is reported',
    files: {
      '001.js': up(
        `    await queryInterface.createTable('Users', { id: { type: Sequelize.INTEGER, primaryKey: true } });\n    await queryInterface.addIndex('users', ['id']);`
      ),
      'helper.js': "module.exports = { greet() { return 'hi'; } };\n",
    },
  },
];
