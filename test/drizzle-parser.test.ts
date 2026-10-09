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
import { convertText, type ConvertResult } from '../src/convert.js';
import { getFormat, getFormatByExtension } from '../src/formats.js';
import type {
  IrCompositeForeignKey,
  IrField,
  IrIndex,
  IrModel,
  IrRelation,
  IrSchema,
} from '../src/ir.js';
import { runConversion } from '../src/io.js';
import {
  parseDrizzle,
  type DrizzleSourceFile,
} from '../src/parsers/drizzle.js';
import { DEFAULT_OPTIONS, expectOk } from './helpers.js';

/** Parses TypeScript declarations in one or more files (imports are not needed). */
async function parse(...texts: string[]): Promise<IrSchema> {
  const sources: DrizzleSourceFile[] = texts.map(
    (text: string, index: number): DrizzleSourceFile => ({
      path: `schema${index}.ts`,
      text,
    })
  );
  return expectOk(await parseDrizzle(sources, { appLabel: 'app' }));
}

function model(schema: IrSchema, name: string): IrModel {
  const found: IrModel | undefined = schema.models.find(
    (candidate: IrModel) => candidate.name === name
  );
  if (found === undefined) {
    throw new Error(`Model ${name} was not parsed`);
  }
  return found;
}

function field(schema: IrSchema, modelName: string, name: string): IrField {
  const found: IrField | undefined = model(schema, modelName).fields.find(
    (candidate: IrField) => candidate.name === name
  );
  if (found === undefined) {
    throw new Error(`Field ${modelName}.${name} was not parsed`);
  }
  return found;
}

function relation(
  schema: IrSchema,
  modelName: string,
  name: string
): IrRelation {
  const found: IrRelation | undefined = model(schema, modelName).relations.find(
    (candidate: IrRelation) => candidate.name === name
  );
  if (found === undefined) {
    throw new Error(`Relation ${modelName}.${name} was not parsed`);
  }
  return found;
}

function warningsMatching(schema: IrSchema, text: string): string[] {
  return schema.warnings.filter((warning: string) => warning.includes(text));
}

describe('drizzle adapter registration', () => {
  it('is registered as a readable format that does not claim .ts', () => {
    const adapter = expectOk(getFormat('drizzle'));
    expect(adapter.parse).toBeDefined();
    expect(adapter.extensions).toEqual([]);
    expect(getFormatByExtension('.ts')).toBeUndefined();
  });

  it('converts through convertText', async () => {
    const result = expectOk(
      await convertText(
        [
          {
            path: 'users.ts',
            text: `export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  name: varchar('name', { length: 40 }).notNull(),
});`,
          },
        ],
        { ...DEFAULT_OPTIONS, from: 'drizzle', to: 'prisma' }
      )
    );
    expect(result.modelCount).toBe(1);
    expect(result.output).toContain('model User {');
    expect(result.output).toContain('@db.VarChar(40)');
  });

  it('fails with a descriptive error when no table is found', async () => {
    const result = await parseDrizzle(
      [{ path: 'db.ts', text: 'export const db = drizzle(client);' }],
      { appLabel: 'app' }
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('NO_MODELS_FOUND');
      expect(result.error.message).toContain('db.ts');
      expect(result.error.message).toContain('pgTable');
    }
  });
});

describe('directory input', () => {
  const created: string[] = [];
  afterEach(() => {
    for (const directory of created.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('reads every .ts file of the fixture folder with --from drizzle', async () => {
    const directory: string = fileURLToPath(
      new URL('./fixtures/drizzle', import.meta.url)
    );
    const summary = expectOk(
      await runConversion({
        ...DEFAULT_OPTIONS,
        from: 'drizzle',
        to: 'prisma',
        inputs: [directory],
      })
    );
    expect(summary.modelCount).toBe(6);
    expect(summary.warnings).toEqual([]);
    expect(summary.inputFiles).toHaveLength(9);
  });

  it('skips node_modules, declaration files and tests', async () => {
    const root: string = mkdtempSync(join(tmpdir(), 'ormbridge-drizzle-'));
    created.push(root);
    mkdirSync(join(root, 'node_modules', 'dep'), { recursive: true });
    writeFileSync(
      join(root, 'schema.ts'),
      "export const users = pgTable('users', { id: serial('id').primaryKey() });\n"
    );
    writeFileSync(
      join(root, 'schema.test.ts'),
      "export const fake = pgTable('fake', { id: serial('id').primaryKey() });\n"
    );
    writeFileSync(
      join(root, 'schema.d.ts'),
      "export const declared = pgTable('declared', { id: serial('id').primaryKey() });\n"
    );
    writeFileSync(
      join(root, 'node_modules', 'dep', 'index.ts'),
      "export const vendored = pgTable('vendored', { id: serial('id').primaryKey() });\n"
    );
    const summary = expectOk(
      await runConversion({
        ...DEFAULT_OPTIONS,
        from: 'drizzle',
        to: 'prisma',
        inputs: [root],
      })
    );
    expect(summary.modelCount).toBe(1);
    expect(summary.inputFiles).toHaveLength(1);
  });

  it('names the expected files when a directory has no TypeScript files', async () => {
    const root: string = mkdtempSync(join(tmpdir(), 'ormbridge-drizzle-'));
    created.push(root);
    const result = await runConversion({
      ...DEFAULT_OPTIONS,
      from: 'drizzle',
      to: 'prisma',
      inputs: [root],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('NO_INPUT_FILES');
      expect(result.error.message).toContain('Drizzle schema files');
    }
  });
});

describe('table and model names', () => {
  it('names models after the variable, singularized', async () => {
    const schema: IrSchema = await parse(`
export const users = pgTable('auth_user', { id: serial('id').primaryKey() });
export const categories = pgTable('cats', { id: serial('id').primaryKey() });
export const postTags = pgTable('post_tags', { id: serial('id').primaryKey() });
export const status = pgTable('status', { id: serial('id').primaryKey() });
`);
    expect(schema.models.map((item: IrModel) => item.name)).toEqual([
      'User',
      'Category',
      'PostTag',
      'Status',
    ]);
    expect(model(schema, 'User').tableName).toBe('auth_user');
    expect(model(schema, 'User').appLabel).toBe('app');
  });

  it('keeps the schema of pgSchema(...).table and of its enums', async () => {
    const schema: IrSchema = await parse(`
export const auth = pgSchema('auth');
export const level = auth.enum('level', ['low', 'high']);
export const accounts = auth.table('accounts', {
  id: serial('id').primaryKey(),
  level: level('level').notNull(),
});
`);
    expect(model(schema, 'Account').schema).toBe('auth');
    expect(model(schema, 'Account').tableName).toBe('accounts');
    expect(schema.enums[0]).toMatchObject({ name: 'Level', schema: 'auth' });
    expect(field(schema, 'Account', 'level').enumName).toBe('Level');
  });

  it('applies the prefix of a table creator', async () => {
    const schema: IrSchema = await parse(`
const createTable = pgTableCreator((name) => \`acme_\${name}\`);
export const things = createTable('things', { id: serial('id').primaryKey() });
`);
    expect(model(schema, 'Thing').tableName).toBe('acme_things');
  });

  it('warns when a table creator cannot be evaluated', async () => {
    const schema: IrSchema = await parse(`
const createTable = pgTableCreator((name) => prefix(name));
export const things = createTable('things', { id: serial('id').primaryKey() });
`);
    expect(model(schema, 'Thing').tableName).toBe('things');
    expect(warningsMatching(schema, 'createTable')).toHaveLength(1);
  });

  it('skips a table whose name is not a string literal', async () => {
    const schema: IrSchema = await parse(`
export const good = pgTable('good', { id: serial('id').primaryKey() });
export const dynamic = pgTable(NAME, { id: serial('id').primaryKey() });
`);
    expect(schema.models.map((item: IrModel) => item.name)).toEqual(['Good']);
    expect(
      warningsMatching(schema, 'schema0.ts: table "dynamic"')
    ).toHaveLength(1);
  });

  it('reads sqlite and mysql tables and resolves namespace and aliased imports', async () => {
    const schema: IrSchema = await parse(`
import * as lite from 'drizzle-orm/sqlite-core';
import { mysqlTable as table, int as integer32 } from 'drizzle-orm/mysql-core';
export const a = lite.sqliteTable('a', { id: lite.integer('id').primaryKey() });
export const b = table('b', { id: integer32('id').primaryKey() });
`);
    expect(model(schema, 'A').tableName).toBe('a');
    expect(field(schema, 'B', 'id').type).toBe('int');
  });
});

describe('column types', () => {
  it('maps PostgreSQL builders', async () => {
    const schema: IrSchema = await parse(`
export const t = pgTable('t', {
  a: serial('a').primaryKey(),
  b: bigserial('b', { mode: 'number' }),
  c: smallint('c'),
  d: bigint('d', { mode: 'bigint' }),
  e: varchar('e', { length: 20 }),
  f: char('f', { length: 3 }),
  g: text('g'),
  h: boolean('h'),
  i: timestamp('i', { withTimezone: true, mode: 'string' }),
  j: date('j'),
  k: numeric('k', { precision: 8, scale: 3 }),
  l: real('l'),
  m: doublePrecision('m'),
  n: json('n'),
  o: jsonb('o'),
  p: uuid('p'),
  q: time('q'),
  r: interval('r'),
  s: inet('s'),
  u: varchar({ length: 5 }),
});`);
    const types: Record<string, string> = Object.fromEntries(
      model(schema, 'T').fields.map((item: IrField) => [item.name, item.type])
    );
    expect(types).toEqual({
      a: 'int',
      b: 'bigInt',
      c: 'int',
      d: 'bigInt',
      e: 'string',
      f: 'string',
      g: 'text',
      h: 'boolean',
      i: 'dateTime',
      j: 'date',
      k: 'decimal',
      l: 'float',
      m: 'float',
      n: 'json',
      o: 'json',
      p: 'uuid',
      q: 'time',
      r: 'duration',
      s: 'ipAddress',
      u: 'string',
    });
    expect(field(schema, 'T', 'e').maxLength).toBe(20);
    expect(field(schema, 'T', 'f').maxLength).toBe(3);
    expect(field(schema, 'T', 'u')).toMatchObject({
      columnName: 'u',
      maxLength: 5,
    });
    expect(field(schema, 'T', 'k')).toMatchObject({
      maxDigits: 8,
      decimalPlaces: 3,
    });
    // serial is NOT NULL and auto-incrementing even without .notNull()
    expect(field(schema, 'T', 'b')).toMatchObject({
      isNullable: false,
      default: { kind: 'autoIncrement' },
    });
    expect(field(schema, 'T', 'c').isNullable).toBe(true);
  });

  it('maps MySQL builders', async () => {
    const schema: IrSchema = await parse(`
export const t = mysqlTable('t', {
  a: int('a').primaryKey().autoincrement(),
  b: tinyint('b'),
  c: bigint('c', { mode: 'number' }),
  d: serial('d'),
  e: varchar('e', { length: 20 }),
  f: text('f'),
  g: longtext('g'),
  h: datetime('h'),
  i: timestamp('i'),
  j: decimal('j', { precision: 5, scale: 2 }),
  k: double('k'),
  l: json('l'),
  m: boolean('m'),
  n: varbinary('n', { length: 8 }),
  o: mysqlEnum('o', ['x', 'y']),
});`);
    const types: Record<string, string> = Object.fromEntries(
      model(schema, 'T').fields.map((item: IrField) => [item.name, item.type])
    );
    expect(types).toMatchObject({
      a: 'int',
      b: 'int',
      c: 'bigInt',
      d: 'bigInt',
      e: 'string',
      f: 'text',
      g: 'text',
      h: 'dateTime',
      i: 'dateTime',
      j: 'decimal',
      k: 'float',
      l: 'json',
      m: 'boolean',
      n: 'bytes',
      o: 'string',
    });
    expect(field(schema, 'T', 'a').default).toEqual({ kind: 'autoIncrement' });
    expect(field(schema, 'T', 'd')).toMatchObject({
      isNullable: false,
      isUnique: true,
      default: { kind: 'autoIncrement' },
    });
    expect(field(schema, 'T', 'o').enumName).toBe('TO');
    expect(schema.enums.find((item) => item.name === 'TO')?.values).toEqual([
      { name: 'X', dbValue: 'x' },
      { name: 'Y', dbValue: 'y' },
    ]);
  });

  it('maps SQLite modes', async () => {
    const schema: IrSchema = await parse(`
export const t = sqliteTable('t', {
  a: integer('a').primaryKey({ autoIncrement: true }),
  b: integer('b', { mode: 'boolean' }),
  c: integer('c', { mode: 'timestamp' }),
  d: integer('d', { mode: 'timestamp_ms' }),
  e: text('e'),
  f: text('f', { mode: 'json' }),
  g: text('g', { enum: ['a', 'b'] }),
  h: real('h'),
  i: blob('i'),
  j: blob('j', { mode: 'json' }),
  k: blob('k', { mode: 'bigint' }),
  l: numeric('l'),
  m: integer('m'),
});`);
    const types: Record<string, string> = Object.fromEntries(
      model(schema, 'T').fields.map((item: IrField) => [item.name, item.type])
    );
    expect(types).toEqual({
      a: 'int',
      b: 'boolean',
      c: 'dateTime',
      d: 'dateTime',
      e: 'text',
      f: 'json',
      g: 'text',
      h: 'float',
      i: 'bytes',
      j: 'json',
      k: 'bigInt',
      l: 'decimal',
      m: 'int',
    });
    expect(field(schema, 'T', 'a').default).toEqual({ kind: 'autoIncrement' });
    expect(field(schema, 'T', 'm').default).toBeUndefined();
    expect(warningsMatching(schema, 'Unix time')).toHaveLength(2);
  });

  it('keeps types without an equivalent as unsupported columns', async () => {
    const schema: IrSchema = await parse(`
export const t = pgTable('t', {
  id: serial('id').primaryKey(),
  where: point('where'),
  vec: vector('vec', { dimensions: 1536 }),
  mystery: fancyType('mystery'),
});`);
    expect(field(schema, 't'.toUpperCase(), 'where')).toMatchObject({
      type: 'unsupported',
      unsupportedType: 'point',
    });
    expect(field(schema, 'T', 'vec').unsupportedType).toBe('vector(1536)');
    expect(field(schema, 'T', 'mystery')).toMatchObject({
      type: 'unsupported',
      unsupportedType: 'fancyType',
    });
    expect(warningsMatching(schema, 'table "t"')).toHaveLength(3);
  });

  it('reads arrays', async () => {
    const schema: IrSchema = await parse(`
export const t = pgTable('t', {
  id: serial('id').primaryKey(),
  a: text('a').array(),
  b: integer('b').array().array(),
});`);
    expect(field(schema, 'T', 'a')).toMatchObject({
      type: 'text',
      arrayDepth: 1,
    });
    expect(field(schema, 'T', 'b').arrayDepth).toBe(2);
  });

  it('uses the property name when the column has no name', async () => {
    const schema: IrSchema = await parse(`
export const t = pgTable('t', {
  id: serial().primaryKey(),
  createdAt: timestamp(),
  title: varchar({ length: 10 }),
});`);
    expect(field(schema, 'T', 'createdAt').columnName).toBe('createdAt');
    expect(field(schema, 'T', 'title').columnName).toBe('title');
  });
});

describe('column modifiers and defaults', () => {
  it('reads nullability, keys, uniqueness and generated columns', async () => {
    const schema: IrSchema = await parse(`
export const t = pgTable('t', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  a: text('a').notNull(),
  b: text('b'),
  c: text('c').unique(),
  d: text('d').unique('t_d_key'),
  e: text('e').generatedAlwaysAs(sql\`upper(b)\`, { mode: 'stored' }),
  f: text('f').$type<'x' | 'y'>(),
});`);
    expect(field(schema, 'T', 'id')).toMatchObject({
      isPrimaryKey: true,
      isNullable: false,
      default: { kind: 'autoIncrement' },
    });
    expect(field(schema, 'T', 'a').isNullable).toBe(false);
    expect(field(schema, 'T', 'b').isNullable).toBe(true);
    expect(field(schema, 'T', 'c').isUnique).toBe(true);
    expect(field(schema, 'T', 'd')).toMatchObject({
      isUnique: true,
      uniqueName: 't_d_key',
    });
    expect(field(schema, 'T', 'e').generated).toEqual({
      expression: 'upper(b)',
      isStored: true,
    });
    expect(schema.warnings).toEqual([]);
  });

  it('reads literal, sql and function defaults', async () => {
    const schema: IrSchema = await parse(`
export const t = pgTable('t', {
  id: serial('id').primaryKey(),
  a: integer('a').default(5),
  b: text('b').default('hello'),
  c: boolean('c').default(true),
  d: timestamp('d').defaultNow(),
  e: timestamp('e').default(sql\`now()\`),
  f: uuid('f').defaultRandom(),
  g: uuid('g').default(sql\`gen_random_uuid()\`),
  h: jsonb('h').default({ a: [1, 'x'] }),
  i: numeric('i').default('1.50'),
  j: text('j').default(sql\`'abc'::text\`),
  k: integer('k').default(sql\`(1 + 2)\`),
  l: bigint('l', { mode: 'bigint' }).default(7n),
  m: timestamp('m').default(sql\`CURRENT_TIMESTAMP\`),
  n: integer('n').default(-3),
});`);
    const defaults: Record<string, unknown> = Object.fromEntries(
      model(schema, 'T').fields.map((item: IrField) => [
        item.name,
        item.default,
      ])
    );
    expect(defaults).toMatchObject({
      a: { kind: 'literal', value: 5 },
      b: { kind: 'literal', value: 'hello' },
      c: { kind: 'literal', value: true },
      d: { kind: 'now' },
      e: { kind: 'now' },
      f: { kind: 'uuid' },
      g: { kind: 'uuid' },
      h: { kind: 'literal', value: '{"a":[1,"x"]}' },
      i: { kind: 'literal', value: 1.5 },
      j: { kind: 'literal', value: 'abc' },
      k: { kind: 'dbExpression', expression: '(1 + 2)' },
      l: { kind: 'literal', value: 7 },
      m: { kind: 'now' },
      n: { kind: 'literal', value: -3 },
    });
  });

  it('warns about defaults that cannot be evaluated', async () => {
    const schema: IrSchema = await parse(`
export const t = pgTable('t', {
  id: serial('id').primaryKey(),
  a: timestamp('a').default(new Date()),
  b: text('b').default(computeDefault()),
  c: text('c').default(sql\`\${other.column}\`),
});`);
    expect(field(schema, 'T', 'a').default).toBeUndefined();
    expect(
      warningsMatching(schema, 'cannot be evaluated statically')
    ).toHaveLength(2);
    expect(warningsMatching(schema, 'column "c"')).toHaveLength(1);
  });

  it('warns about $defaultFn and maps the cases it understands', async () => {
    const schema: IrSchema = await parse(`
export const t = pgTable('t', {
  id: serial('id').primaryKey(),
  a: uuid('a').$defaultFn(() => crypto.randomUUID()),
  b: timestamp('b').$defaultFn(() => new Date()),
  c: text('c').$defaultFn(() => createId()),
  d: text('d').$defaultFn(() => crypto.randomUUID()),
});`);
    expect(field(schema, 'T', 'a').default).toEqual({ kind: 'uuid' });
    expect(field(schema, 'T', 'b').default).toEqual({ kind: 'now' });
    expect(field(schema, 'T', 'c').default).toBeUndefined();
    expect(field(schema, 'T', 'd').default).toBeUndefined();
    expect(warningsMatching(schema, '$defaultFn')).toHaveLength(4);
  });

  it('reads $onUpdate and onUpdateNow as auto-updated and drops the redundant now default', async () => {
    const schema: IrSchema = await parse(`
export const t = pgTable('t', {
  id: serial('id').primaryKey(),
  a: timestamp('a').defaultNow().$onUpdate(() => new Date()),
  b: timestamp('b').$onUpdateFn(() => new Date()),
  c: integer('c').$onUpdate(() => sql\`c + 1\`),
});
export const m = mysqlTable('m', {
  id: int('id').primaryKey(),
  at: timestamp('at').defaultNow().onUpdateNow(),
});`);
    expect(field(schema, 'T', 'a')).toMatchObject({ isAutoUpdated: true });
    expect(field(schema, 'T', 'a').default).toBeUndefined();
    expect(field(schema, 'T', 'b').isAutoUpdated).toBe(true);
    expect(field(schema, 'T', 'c').isAutoUpdated).toBe(false);
    expect(field(schema, 'M', 'at').isAutoUpdated).toBe(true);
    expect(warningsMatching(schema, '$onUpdate on a int column')).toHaveLength(
      1
    );
  });

  it('warns about modifiers it does not know', async () => {
    const schema: IrSchema = await parse(`
export const t = pgTable('t', {
  id: serial('id').primaryKey(),
  a: text('a').comment('hello'),
});`);
    expect(warningsMatching(schema, '.comment()')).toHaveLength(1);
  });
});

describe('enums', () => {
  it('reads pgEnum, its default and its database name', async () => {
    const schema: IrSchema = await parse(`
export const status = pgEnum('post_status', ['draft', 'in-review', '2fa']);
export const posts = pgTable('posts', {
  id: serial('id').primaryKey(),
  status: status('status').notNull().default('in-review'),
  history: status('history').array(),
});`);
    expect(schema.enums).toEqual([
      {
        name: 'Status',
        dbName: 'post_status',
        values: [
          { name: 'DRAFT', dbValue: 'draft' },
          { name: 'IN_REVIEW', dbValue: 'in-review' },
          { name: 'V_2FA', dbValue: '2fa' },
        ],
      },
    ]);
    expect(field(schema, 'Post', 'status')).toMatchObject({
      type: 'string',
      enumName: 'Status',
      default: { kind: 'enumValue', value: 'IN_REVIEW' },
    });
    expect(field(schema, 'Post', 'history').arrayDepth).toBe(1);
  });

  it('reads values kept in a constant and skips dynamic ones', async () => {
    const schema: IrSchema = await parse(`
const KINDS = ['a', 'b'] as const;
export const kind = pgEnum('kind', KINDS);
export const bad = pgEnum('bad', Object.values(Other));
export const t = pgTable('t', { id: serial('id').primaryKey(), kind: kind('kind') });`);
    expect(schema.enums.map((item) => item.name)).toEqual(['Kind']);
    expect(warningsMatching(schema, 'the enum "bad"')).toHaveLength(1);
  });
});

describe('relations', () => {
  it('derives a relation name from the column when relations() is absent', async () => {
    const schema: IrSchema = await parse(`
export const users = pgTable('users', { id: serial('id').primaryKey() });
export const posts = pgTable('posts', {
  id: serial('id').primaryKey(),
  authorId: integer('author_id').notNull().references(() => users.id, { onDelete: 'cascade', onUpdate: 'no action' }),
  reviewer_id: integer('reviewer_id').references(() => users.id, { onDelete: 'set null' }),
  parent: integer('parent').references(() => posts.id),
});`);
    expect(relation(schema, 'Post', 'author')).toMatchObject({
      kind: 'foreignKey',
      targetModel: 'User',
      columnName: 'author_id',
      isNullable: false,
      onDelete: 'cascade',
      onUpdate: 'noAction',
    });
    expect(relation(schema, 'Post', 'reviewer')).toMatchObject({
      columnName: 'reviewer_id',
      isNullable: true,
      onDelete: 'setNull',
    });
    expect(relation(schema, 'Post', 'parent').targetModel).toBe('Post');
    // The foreign key columns are replaced by the relations.
    expect(model(schema, 'Post').fields.map((item) => item.name)).toEqual([
      'id',
    ]);
  });

  it('uses the names of relations() and links the reverse sides', async () => {
    const schema: IrSchema = await parse(`
export const users = pgTable('users', { id: serial('id').primaryKey() });
export const posts = pgTable('posts', {
  id: serial('id').primaryKey(),
  authorId: integer('author_id').references(() => users.id),
  editorId: integer('editor_id').references(() => users.id),
});
export const usersRelations = relations(users, ({ many }) => ({
  written: many(posts, { relationName: 'author' }),
  edited: many(posts, { relationName: 'editor' }),
}));
export const postsRelations = relations(posts, ({ one }) => ({
  writer: one(users, { fields: [posts.authorId], references: [users.id], relationName: 'author' }),
  editor: one(users, { fields: [posts.editorId], references: [users.id], relationName: 'editor' }),
}));`);
    expect(relation(schema, 'Post', 'writer')).toMatchObject({
      columnName: 'author_id',
      relatedName: 'written',
    });
    expect(relation(schema, 'Post', 'editor')).toMatchObject({
      columnName: 'editor_id',
      relatedName: 'edited',
    });
    expect(schema.warnings).toEqual([]);
  });

  it('warns when a many() is ambiguous or has no owner', async () => {
    const schema: IrSchema = await parse(`
export const users = pgTable('users', { id: serial('id').primaryKey() });
export const posts = pgTable('posts', {
  id: serial('id').primaryKey(),
  authorId: integer('author_id').references(() => users.id),
  editorId: integer('editor_id').references(() => users.id),
});
export const usersRelations = relations(users, ({ many }) => ({
  posts: many(posts),
  other: many(users, { relationName: 'missing' }),
}));
export const postsRelations = relations(posts, ({ one }) => ({
  author: one(users, { fields: [posts.authorId], references: [users.id] }),
  editor: one(users, { fields: [posts.editorId], references: [users.id] }),
}));`);
    expect(warningsMatching(schema, 'matches several relations')).toHaveLength(
      1
    );
    expect(warningsMatching(schema, 'has no matching one(')).toHaveLength(1);
    expect(relation(schema, 'Post', 'author').relatedName).toBe('posts');
  });

  it('reads a one-to-one from a unique or primary key foreign key, and its reverse side', async () => {
    const schema: IrSchema = await parse(`
export const users = pgTable('users', { id: serial('id').primaryKey() });
export const profiles = pgTable('profiles', {
  userId: integer('user_id').primaryKey().references(() => users.id, { onDelete: 'cascade' }),
});
export const cards = pgTable('cards', {
  id: serial('id').primaryKey(),
  userId: integer('user_id').notNull().unique().references(() => users.id),
}, (t) => [uniqueIndex('cards_user_idx').on(t.userId)]);
export const usersRelations = relations(users, ({ one }) => ({
  profile: one(profiles),
  card: one(cards),
}));
export const profilesRelations = relations(profiles, ({ one }) => ({
  user: one(users, { fields: [profiles.userId], references: [users.id] }),
}));
export const cardsRelations = relations(cards, ({ one }) => ({
  user: one(users, { fields: [cards.userId], references: [users.id] }),
}));`);
    expect(relation(schema, 'Profile', 'user')).toMatchObject({
      kind: 'oneToOne',
      isPrimaryKey: true,
      isNullable: false,
      relatedName: 'profile',
    });
    expect(relation(schema, 'Card', 'user')).toMatchObject({
      kind: 'oneToOne',
      relatedName: 'card',
    });
    // The unique index is implied by the one-to-one relation.
    expect(model(schema, 'Card').indexes).toEqual([]);
  });

  it('keeps a relation without a database constraint, from relations() alone', async () => {
    const schema: IrSchema = await parse(`
export const users = pgTable('users', { id: serial('id').primaryKey() });
export const posts = pgTable('posts', {
  id: serial('id').primaryKey(),
  authorId: integer('author_id'),
});
export const postsRelations = relations(posts, ({ one }) => ({
  author: one(users, { fields: [posts.authorId], references: [users.id] }),
}));`);
    expect(relation(schema, 'Post', 'author')).toMatchObject({
      columnName: 'author_id',
      isNullable: true,
      onDelete: 'noAction',
    });
  });

  it('records the referenced field when it is not the primary key', async () => {
    const schema: IrSchema = await parse(`
export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  email: text('email').notNull().unique(),
});
export const logs = pgTable('logs', {
  id: serial('id').primaryKey(),
  email: text('user_email').references(() => users.email),
});`);
    expect(relation(schema, 'Log', 'email')).toMatchObject({
      columnName: 'user_email',
      toField: 'email',
    });
  });

  it('stays a join model for a many-to-many through a join table', async () => {
    const schema: IrSchema = await parse(`
export const posts = pgTable('posts', { id: serial('id').primaryKey() });
export const tags = pgTable('tags', { id: serial('id').primaryKey() });
export const postsToTags = pgTable('posts_to_tags', {
  postId: integer('post_id').notNull().references(() => posts.id),
  tagId: integer('tag_id').notNull().references(() => tags.id),
}, (t) => [primaryKey({ columns: [t.postId, t.tagId] })]);
export const postsRelations = relations(posts, ({ many }) => ({ tags: many(postsToTags) }));
export const tagsRelations = relations(tags, ({ many }) => ({ posts: many(postsToTags) }));
export const joinRelations = relations(postsToTags, ({ one }) => ({
  post: one(posts, { fields: [postsToTags.postId], references: [posts.id] }),
  tag: one(tags, { fields: [postsToTags.tagId], references: [tags.id] }),
}));`);
    const join: IrModel = model(schema, 'PostsToTag');
    expect(join.compositePrimaryKey).toEqual(['post', 'tag']);
    expect(join.relations.map((item: IrRelation) => item.relatedName)).toEqual([
      'tags',
      'posts',
    ]);
    expect(model(schema, 'Post').relations).toEqual([]);
  });

  it('generates a stub for a table that is not in the input', async () => {
    const schema: IrSchema = await parse(`
export const posts = pgTable('posts', {
  id: serial('id').primaryKey(),
  authorId: integer('author_id').references(() => users.id),
});`);
    expect(model(schema, 'User').fields.map((item) => item.name)).toEqual([
      'id',
    ]);
    expect(warningsMatching(schema, 'stub model')).toHaveLength(1);
  });

  it('warns about a reference it cannot resolve', async () => {
    const schema: IrSchema = await parse(`
export const posts = pgTable('posts', {
  id: serial('id').primaryKey(),
  authorId: integer('author_id').references(lookup('users')),
});`);
    expect(model(schema, 'Post').relations).toEqual([]);
    expect(warningsMatching(schema, 'foreign key was skipped')).toHaveLength(1);
  });

  it('warns about relations v2', async () => {
    const schema: IrSchema = await parse(`
export const users = pgTable('users', { id: serial('id').primaryKey() });
export const relations = defineRelations({ users }, (r) => ({}));`);
    expect(warningsMatching(schema, 'defineRelations')).toHaveLength(1);
  });
});

describe('keys, indexes and constraints', () => {
  it('reads a composite primary key and a composite foreign key', async () => {
    const schema: IrSchema = await parse(`
export const lines = pgTable('lines', {
  orderId: integer('order_id').notNull(),
  lineNo: integer('line_no').notNull(),
}, (t) => [primaryKey({ name: 'lines_pk', columns: [t.orderId, t.lineNo] })]);
export const shipments = pgTable('shipments', {
  id: serial('id').primaryKey(),
  orderId: integer('order_id'),
  lineNo: integer('line_no'),
}, (t) => [
  foreignKey({ name: 'ship_fk', columns: [t.orderId, t.lineNo], foreignColumns: [lines.orderId, lines.lineNo] })
    .onDelete('cascade').onUpdate('set null'),
]);`);
    expect(model(schema, 'Line')).toMatchObject({
      compositePrimaryKey: ['orderId', 'lineNo'],
      primaryKeyName: 'lines_pk',
    });
    expect(field(schema, 'Line', 'orderId').isPrimaryKey).toBe(false);
    const keys: IrCompositeForeignKey[] =
      model(schema, 'Shipment').compositeForeignKeys ?? [];
    expect(keys).toEqual([
      {
        name: 'line',
        targetModel: 'Line',
        fields: ['orderId', 'lineNo'],
        references: ['orderId', 'lineNo'],
        kind: 'foreignKey',
        isNullable: true,
        onDelete: 'cascade',
        onUpdate: 'setNull',
        constraintName: 'ship_fk',
      },
    ]);
    // The columns of a composite foreign key stay ordinary fields.
    expect(model(schema, 'Shipment').fields.map((item) => item.name)).toEqual([
      'id',
      'orderId',
      'lineNo',
    ]);
  });

  it('reads a single-column foreignKey() like .references()', async () => {
    const schema: IrSchema = await parse(`
export const users = pgTable('users', { id: serial('id').primaryKey() });
export const posts = pgTable('posts', {
  id: serial('id').primaryKey(),
  authorId: integer('author_id').notNull(),
}, (t) => [foreignKey({ name: 'posts_author_fk', columns: [t.authorId], foreignColumns: [users.id] }).onDelete('cascade')]);`);
    expect(relation(schema, 'Post', 'author')).toMatchObject({
      columnName: 'author_id',
      onDelete: 'cascade',
      constraintName: 'posts_author_fk',
    });
  });

  it('reads indexes, unique constraints, methods and sort order', async () => {
    const schema: IrSchema = await parse(`
export const t = pgTable('t', {
  id: serial('id').primaryKey(),
  a: text('a'),
  b: text('b'),
  c: text('c'),
}, (table) => [
  index('t_a_idx').on(table.a),
  index().on(table.a, table.b.desc()),
  uniqueIndex('t_b_uq').on(table.b),
  unique().on(table.c),
  unique('t_ab_uq').on(table.a, table.b),
  index('t_c_idx').using('gin', table.c.op('gin_trgm_ops')),
  index('t_hnsw').using('hnsw', table.c),
]);`);
    const indexes: IrIndex[] = model(schema, 'T').indexes;
    expect(indexes).toEqual([
      { fields: ['a'], isUnique: false, name: 't_a_idx' },
      {
        fields: ['a', 'b'],
        isUnique: false,
        fieldOptions: { b: { sort: 'desc' } },
      },
      { fields: ['b'], isUnique: true, name: 't_b_uq' },
      { fields: ['a', 'b'], isUnique: true, name: 't_ab_uq' },
      {
        fields: ['c'],
        isUnique: false,
        name: 't_c_idx',
        method: 'Gin',
        fieldOptions: { c: { ops: 'raw("gin_trgm_ops")' } },
      },
      { fields: ['c'], isUnique: false, name: 't_hnsw' },
    ]);
    // An unnamed single-column unique becomes a flag on the field.
    expect(field(schema, 'T', 'c').isUnique).toBe(true);
    expect(warningsMatching(schema, 'hnsw')).toHaveLength(1);
  });

  it('accepts an object from the table callback and a block body', async () => {
    const schema: IrSchema = await parse(`
export const t = pgTable('t', {
  id: serial('id').primaryKey(),
  a: text('a'),
}, (table) => {
  return { aIdx: index('t_a_idx').on(table.a) };
});`);
    expect(model(schema, 'T').indexes).toHaveLength(1);
  });

  it('warns about partial indexes, expression indexes, checks and unknown columns', async () => {
    const schema: IrSchema = await parse(`
export const t = pgTable('t', {
  id: serial('id').primaryKey(),
  a: text('a'),
}, (table) => [
  index('t_partial').on(table.a).where(sql\`a is not null\`),
  uniqueIndex('t_partial_uq').on(table.a).where(sql\`a is not null\`),
  index('t_expr').on(sql\`lower(\${table.a})\`),
  check('t_check', sql\`\${table.a} <> ''\`),
  index('t_missing').on(table.nope),
  pgPolicy('p', {}),
]);`);
    expect(model(schema, 'T').indexes).toEqual([
      { fields: ['a'], isUnique: false, name: 't_partial' },
    ]);
    expect(warningsMatching(schema, 'partial index')).toHaveLength(2);
    expect(warningsMatching(schema, 'expression')).toHaveLength(1);
    expect(warningsMatching(schema, 'check constraint')).toHaveLength(1);
    expect(warningsMatching(schema, '"nope"')).toHaveLength(1);
    expect(warningsMatching(schema, 'pgPolicy')).toHaveLength(1);
  });

  it('warns about a table without a primary key', async () => {
    const schema: IrSchema = await parse(
      "export const t = pgTable('t', { a: text('a') });"
    );
    expect(warningsMatching(schema, 'no primary key')).toHaveLength(1);
  });
});

describe('shared column objects and helpers', () => {
  it('spreads shared column objects from the same or another file', async () => {
    const schema: IrSchema = await parse(
      `export const stamps = { createdAt: timestamp('created_at').defaultNow() };
export const base = () => ({ id: serial('id').primaryKey(), ...stamps });`,
      `export const t = pgTable('t', { ...base(), name: text('name') });`
    );
    expect(model(schema, 'T').fields.map((item) => item.name)).toEqual([
      'id',
      'createdAt',
      'name',
    ]);
    expect(schema.warnings).toEqual([]);
  });

  it('follows a one-level column helper', async () => {
    const schema: IrSchema = await parse(`
const id = () => integer('id').primaryKey().generatedAlwaysAsIdentity();
const label = (name) => varchar(name, { length: 30 }).notNull();
export const t = pgTable('t', { id: id(), caption: label('caption') });`);
    expect(field(schema, 'T', 'id')).toMatchObject({ isPrimaryKey: true });
    expect(field(schema, 'T', 'caption')).toMatchObject({
      columnName: 'caption',
      maxLength: 30,
      isNullable: false,
    });
  });

  it('warns about a spread that cannot be resolved', async () => {
    const schema: IrSchema = await parse(`
export const t = pgTable('t', { id: serial('id').primaryKey(), ...fromElsewhere });`);
    expect(warningsMatching(schema, '...fromElsewhere')).toHaveLength(1);
  });

  it('warns about a column that is not a builder call', async () => {
    const schema: IrSchema = await parse(`
export const t = pgTable('t', { id: serial('id').primaryKey(), other: someColumn });`);
    expect(warningsMatching(schema, 'column "other"')).toHaveLength(1);
    expect(model(schema, 'T').fields).toHaveLength(1);
  });
});

describe('input problems', () => {
  it('warns about unsupported dialects, views and syntax errors but keeps the tables it can read', async () => {
    const schema: IrSchema = await parse(
      `export const good = pgTable('good', { id: serial('id').primaryKey() });
export const other = singlestoreTable('other', { id: bigint('id') });
export const v = pgView('v').as((qb) => qb.select().from(good));
export const broken = pgTable('broken', { id: serial('id').primaryKey(),
`
    );
    expect(model(schema, 'Good')).toBeDefined();
    expect(warningsMatching(schema, 'syntax errors')).toHaveLength(1);
    expect(warningsMatching(schema, 'SingleStore')).toHaveLength(1);
    expect(warningsMatching(schema, 'views')).toHaveLength(1);
  });

  it('ignores a duplicate table variable', async () => {
    const schema: IrSchema = await parse(
      "export const t = pgTable('t', { id: serial('id').primaryKey(), a: text('a') });",
      "export const t = pgTable('t2', { id: serial('id').primaryKey(), b: text('b') });"
    );
    expect(schema.models).toHaveLength(1);
    expect(model(schema, 'T').fields.map((item) => item.name)).toContain('a');
    expect(warningsMatching(schema, 'same variable name')).toHaveLength(1);
  });

  it('resolves tables across files through aliased imports', async () => {
    const schema: IrSchema = await parse(
      "export const users = pgTable('users', { id: serial('id').primaryKey() });",
      `import { users as accounts } from './schema0';
export const posts = pgTable('posts', {
  id: serial('id').primaryKey(),
  authorId: integer('author_id').references(() => accounts.id),
});`
    );
    expect(relation(schema, 'Post', 'author').targetModel).toBe('User');
    expect(schema.warnings).toEqual([]);
  });
});

describe('extras fixture', () => {
  const directory: string = fileURLToPath(
    new URL('./fixtures/drizzle-extras', import.meta.url)
  );
  const goldenDirectory: string = fileURLToPath(
    new URL('./golden-extras/', import.meta.url)
  );

  /** Compares text with test/golden-extras/<name>; run with UPDATE_GOLDEN=1 to rewrite it. */
  function expectMatchesExtrasGolden(name: string, actual: string): void {
    const goldenPath: string = `${goldenDirectory}${name}`;
    if (process.env.UPDATE_GOLDEN === '1') {
      mkdirSync(dirname(goldenPath), { recursive: true });
      writeFileSync(goldenPath, actual);
      return;
    }
    if (!existsSync(goldenPath)) {
      throw new Error(
        `Golden file test/golden-extras/${name} does not exist. Run the tests with UPDATE_GOLDEN=1 to create it.`
      );
    }
    expect(actual).toBe(readFileSync(goldenPath, 'utf8'));
  }

  function extrasSources(): DrizzleSourceFile[] {
    return readdirSync(directory)
      .filter((name: string) => name.endsWith('.ts'))
      .sort()
      .map((name: string): DrizzleSourceFile => ({
        path: `${directory}/${name}`,
        text: readFileSync(`${directory}/${name}`, 'utf8'),
      }));
  }

  async function convertExtras(to: string): Promise<ConvertResult> {
    return expectOk(
      await convertText(extrasSources(), {
        ...DEFAULT_OPTIONS,
        appLabel: 'shop',
        from: 'drizzle',
        to,
      })
    );
  }

  it('reads the advanced constructs into the IR', async () => {
    const schema: IrSchema = expectOk(
      await parseDrizzle(extrasSources(), { appLabel: 'shop' })
    );
    expect(schema.models.map((item: IrModel) => item.name).sort()).toEqual([
      'Account',
      'Attachment',
      'Bin',
      'Customer',
      'Gadget',
      'Note',
      'Order',
      'OrderLine',
      'Product',
      'Shipment',
      'Thread',
      'Widget',
    ]);
    expect(model(schema, 'Widget').tableName).toBe('acme_widgets');
    expect(model(schema, 'Order').schema).toBe('shop');
    expect(model(schema, 'OrderLine').compositePrimaryKey).toEqual([
      'order',
      'lineNo',
    ]);
    expect(model(schema, 'Shipment').compositeForeignKeys).toHaveLength(1);
    expect(relation(schema, 'Order', 'customer')).toMatchObject({
      onDelete: 'restrict',
      onUpdate: 'cascade',
      relatedName: 'orders',
    });
    expect(relation(schema, 'Order', 'customerEmail').toField).toBe('email');
    expect(schema.enums.map((item) => item.name).sort()).toEqual([
      'AccountKind',
      'Role',
    ]);
  });

  it('matches the Prisma golden', async () => {
    const result: ConvertResult = await convertExtras('prisma');
    expectMatchesExtrasGolden('drizzle-to-prisma.txt', result.output);
  });

  it('matches the warnings golden', async () => {
    const result: ConvertResult = await convertExtras('prisma');
    expectMatchesExtrasGolden(
      'drizzle-warnings.txt',
      result.warnings.map((warning: string) => `${warning}\n`).join('')
    );
  });
});
