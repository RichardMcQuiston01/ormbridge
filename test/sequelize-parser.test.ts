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
  IrEnum,
  IrField,
  IrIndex,
  IrModel,
  IrRelation,
  IrSchema,
} from '../src/ir.js';
import { runConversion } from '../src/io.js';
import {
  parseSequelize,
  type SequelizeSourceFile,
} from '../src/parsers/sequelize.js';
import {
  pluralize,
  singularize,
  underscore,
} from '../src/parsers/sequelizeInflection.js';
import { loadCanonicalSources } from './harness.js';
import { DEFAULT_OPTIONS, expectOk } from './helpers.js';

/** Parses Sequelize models in one or more files (the `require` lines are not needed). */
async function parse(...texts: string[]): Promise<IrSchema> {
  const sources: SequelizeSourceFile[] = texts.map(
    (text: string, index: number): SequelizeSourceFile => ({
      path: `models${index}.js`,
      text,
    })
  );
  return expectOk(await parseSequelize(sources, { appLabel: 'app' }));
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

function fieldNames(schema: IrSchema, modelName: string): string[] {
  return model(schema, modelName).fields.map((item: IrField) => item.name);
}

function warningsMatching(schema: IrSchema, text: string): string[] {
  return schema.warnings.filter((warning: string) => warning.includes(text));
}

/** A model with one attribute, wrapped in `sequelize.define`, for tests of a single attribute. */
async function parseAttribute(
  definition: string,
  options: string = ''
): Promise<IrSchema> {
  return parse(
    `const Thing = sequelize.define('Thing', { value: ${definition} }, { timestamps: false${options} });`
  );
}

describe('sequelize adapter registration', () => {
  it('is registered as a read-only format that does not claim .js or .ts', () => {
    const adapter = expectOk(getFormat('sequelize'));
    expect(adapter.parse).toBeDefined();
    expect(adapter.emit).toBeUndefined();
    expect(adapter.extensions).toEqual([]);
    expect(getFormatByExtension('.js')).toBeUndefined();
    expect(getFormatByExtension('.ts')).toBeUndefined();
  });

  it('converts through convertText', async () => {
    const result: ConvertResult = expectOk(
      await convertText(
        [
          {
            path: 'user.js',
            text: `module.exports = (sequelize, DataTypes) =>
  sequelize.define('User', { name: { type: DataTypes.STRING(40), allowNull: false } });`,
          },
        ],
        { ...DEFAULT_OPTIONS, from: 'sequelize', to: 'prisma' }
      )
    );
    expect(result.modelCount).toBe(1);
    expect(result.output).toContain('model User {');
    expect(result.output).toContain('@db.VarChar(40)');
    expect(result.output).toContain('@@map("Users")');
  });

  it('cannot be a target', async () => {
    const result = await convertText(
      [{ path: 'schema.prisma', text: 'model A {\n  id Int @id\n}\n' }],
      { ...DEFAULT_OPTIONS, from: 'prisma', to: 'sequelize' }
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain(
        'The format "sequelize" can only be used as an input'
      );
    }
  });

  it('fails with a descriptive error when no model is found', async () => {
    const result = await parseSequelize(
      [{ path: 'app.js', text: 'const sequelize = new Sequelize(url);' }],
      { appLabel: 'app' }
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('NO_MODELS_FOUND');
      expect(result.error.message).toContain('app.js');
      expect(result.error.message).toContain('sequelize.define');
    }
  });

  it('fails the same way for empty input and for files that are not about Sequelize', async () => {
    for (const sources of [
      [],
      [{ path: 'a.js', text: '' }],
      [{ path: 'b.ts', text: 'export const x: number = 1;\n' }],
    ]) {
      const result = await parseSequelize(sources, { appLabel: 'app' });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('NO_MODELS_FOUND');
      }
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

  function modelSource(name: string): string {
    return `module.exports = (sequelize, DataTypes) => sequelize.define('${name}', { label: DataTypes.STRING });\n`;
  }

  function project(files: Record<string, string>): string {
    const root: string = mkdtempSync(join(tmpdir(), 'ormbridge-sequelize-'));
    created.push(root);
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), text);
    }
    return root;
  }

  it('reads the canonical fixture folder with --from sequelize', async () => {
    const directory: string = fileURLToPath(
      new URL('./fixtures/sequelize/models', import.meta.url)
    );
    const summary = expectOk(
      await runConversion({
        ...DEFAULT_OPTIONS,
        from: 'sequelize',
        to: 'prisma',
        inputs: [directory],
      })
    );
    expect(summary.modelCount).toBe(5);
    expect(summary.warnings).toEqual([]);
    // index.js is read too (it just defines nothing) and package.json is not a source file.
    expect(summary.inputFiles).toHaveLength(6);
  });

  it('reads .js, .cjs, .mjs and .ts files and skips the rest of a project', async () => {
    const root: string = project({
      'models/a.js': modelSource('A'),
      'models/b.cjs': modelSource('B'),
      'models/c.mjs': modelSource('C'),
      'models/d.ts': modelSource('D'),
      'models/e.json': '{"E": 1}',
      'models/f.md': '# F',
      'models/index.js': 'module.exports = {};\n',
      'models/g.d.ts': modelSource('G'),
      'models/h.test.js': modelSource('H'),
      'models/i.spec.ts': modelSource('I'),
      'models/j.test.mjs': modelSource('J'),
      'migrations/20240101-create-k.js': modelSource('K'),
      'seeders/l.js': modelSource('L'),
      'config/m.js': modelSource('M'),
      'node_modules/dep/n.js': modelSource('N'),
      'dist/o.js': modelSource('O'),
      'build/p.js': modelSource('P'),
    });
    const summary = expectOk(
      await runConversion({
        ...DEFAULT_OPTIONS,
        from: 'sequelize',
        to: 'prisma',
        inputs: [root],
      })
    );
    expect(summary.modelCount).toBe(4);
    expect(
      summary.inputFiles.map((path: string) => path.slice(root.length + 1))
    ).toEqual([
      join('models', 'a.js'),
      join('models', 'b.cjs'),
      join('models', 'c.mjs'),
      join('models', 'd.ts'),
      join('models', 'index.js'),
    ]);
  });

  it('reads a file that is named explicitly, whatever its name', async () => {
    const root: string = project({ 'config/db.js': modelSource('Db') });
    const summary = expectOk(
      await runConversion({
        ...DEFAULT_OPTIONS,
        from: 'sequelize',
        to: 'prisma',
        inputs: [join(root, 'config', 'db.js')],
      })
    );
    expect(summary.modelCount).toBe(1);
  });

  it('names the expected files when a directory has none', async () => {
    const root: string = project({ 'migrations/x.js': modelSource('X') });
    const result = await runConversion({
      ...DEFAULT_OPTIONS,
      from: 'sequelize',
      to: 'prisma',
      inputs: [root],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('NO_INPUT_FILES');
      expect(result.error.message).toContain('Sequelize model files');
    }
  });
});

describe('inflection (the rules Sequelize 6 applies to model names)', () => {
  it('pluralizes, singularizes and underscores like the inflection package', () => {
    expect(pluralize('User')).toBe('Users');
    expect(pluralize('Person')).toBe('People');
    expect(pluralize('Category')).toBe('Categories');
    expect(pluralize('Status')).toBe('Statuses');
    expect(pluralize('Box')).toBe('Boxes');
    expect(pluralize('Wife')).toBe('Wives');
    expect(pluralize('Mouse')).toBe('Mice');
    expect(pluralize('News')).toBe('News');
    expect(pluralize('Series')).toBe('Series');
    expect(pluralize('PostTag')).toBe('PostTags');
    expect(singularize('Categories')).toBe('Category');
    expect(singularize('People')).toBe('Person');
    expect(singularize('Users')).toBe('User');
    expect(singularize('Status')).toBe('Status');
    expect(underscore('createdAt')).toBe('created_at');
    expect(underscore('PostTags')).toBe('post_tags');
    expect(underscore('UserID')).toBe('user_i_d');
  });
});

describe('table names and model options', () => {
  it('pluralizes the model name unless tableName or freezeTableName says otherwise', async () => {
    const schema: IrSchema = await parse(`
sequelize.define('Person', {}, { timestamps: false });
sequelize.define('BlogPost', {}, { timestamps: false });
sequelize.define('Frozen', {}, { timestamps: false, freezeTableName: true });
sequelize.define('Named', {}, { timestamps: false, tableName: 'tbl_named' });
sequelize.define('SnakeCase', {}, { timestamps: false, underscored: true });
sequelize.define('SnakeFrozen', {}, { timestamps: false, underscored: true, freezeTableName: true });
`);
    expect(
      Object.fromEntries(
        schema.models.map((item: IrModel) => [item.name, item.tableName])
      )
    ).toEqual({
      Person: 'People',
      BlogPost: 'BlogPosts',
      Frozen: 'Frozen',
      Named: 'tbl_named',
      SnakeCase: 'snake_cases',
      SnakeFrozen: 'SnakeFrozen',
    });
    expect(model(schema, 'Person').appLabel).toBe('app');
  });

  it('turns lower-case model names into PascalCase IR names and keeps the table', async () => {
    const schema: IrSchema = await parse(`
sequelize.define('blog_post', { title: DataTypes.STRING }, { timestamps: false });
sequelize.define('user', { name: DataTypes.STRING }, { timestamps: false });
`);
    expect(schema.models.map((item: IrModel) => item.name)).toEqual([
      'BlogPost',
      'User',
    ]);
    expect(model(schema, 'BlogPost').tableName).toBe('blog_posts');
  });

  it('adds an auto-increment id when no attribute is a primary key', async () => {
    const schema: IrSchema = await parse(
      `sequelize.define('Thing', { name: DataTypes.STRING }, { timestamps: false });`
    );
    expect(field(schema, 'Thing', 'id')).toMatchObject({
      type: 'int',
      isPrimaryKey: true,
      isNullable: false,
      default: { kind: 'autoIncrement' },
    });
    expect(fieldNames(schema, 'Thing')).toEqual(['id', 'name']);
  });

  it('keeps a declared primary key and does not add an id', async () => {
    const schema: IrSchema = await parse(`
sequelize.define('Country', {
  code: { type: DataTypes.CHAR(2), primaryKey: true },
  name: DataTypes.STRING,
}, { timestamps: false });
`);
    expect(fieldNames(schema, 'Country')).toEqual(['code', 'name']);
    expect(field(schema, 'Country', 'code')).toMatchObject({
      isPrimaryKey: true,
      isNullable: false,
      type: 'string',
      maxLength: 2,
    });
  });

  it('reads a composite primary key', async () => {
    const schema: IrSchema = await parse(`
sequelize.define('Enrolment', {
  studentId: { type: DataTypes.INTEGER, primaryKey: true },
  courseId: { type: DataTypes.INTEGER, primaryKey: true },
  grade: DataTypes.STRING(2),
}, { timestamps: false });
`);
    const enrolment: IrModel = model(schema, 'Enrolment');
    expect(enrolment.compositePrimaryKey).toEqual(['studentId', 'courseId']);
    expect(enrolment.fields.every((item: IrField) => !item.isPrimaryKey)).toBe(
      true
    );
  });

  it('adds createdAt and updatedAt by default', async () => {
    const schema: IrSchema = await parse(
      `sequelize.define('Thing', { name: DataTypes.STRING });`
    );
    expect(field(schema, 'Thing', 'createdAt')).toMatchObject({
      type: 'dateTime',
      columnName: 'createdAt',
      isNullable: false,
      isAutoUpdated: false,
    });
    expect(field(schema, 'Thing', 'updatedAt')).toMatchObject({
      type: 'dateTime',
      columnName: 'updatedAt',
      isNullable: false,
      isAutoUpdated: true,
    });
    expect(field(schema, 'Thing', 'createdAt').default).toBeUndefined();
  });

  it('honours timestamps: false and the createdAt / updatedAt / deletedAt names', async () => {
    const schema: IrSchema = await parse(`
sequelize.define('Off', {}, { timestamps: false });
sequelize.define('Custom', {}, { createdAt: 'made', updatedAt: 'changed' });
sequelize.define('CreatedOnly', {}, { updatedAt: false });
sequelize.define('UpdatedOnly', {}, { createdAt: false });
sequelize.define('Ignored', {}, { timestamps: false, paranoid: true, createdAt: 'made' });
sequelize.define('Paranoid', {}, { paranoid: true, deletedAt: 'removed_at' });
`);
    expect(fieldNames(schema, 'Off')).toEqual(['id']);
    expect(fieldNames(schema, 'Custom')).toEqual(['id', 'made', 'changed']);
    expect(field(schema, 'Custom', 'changed').isAutoUpdated).toBe(true);
    expect(fieldNames(schema, 'CreatedOnly')).toEqual(['id', 'createdAt']);
    expect(fieldNames(schema, 'UpdatedOnly')).toEqual(['id', 'updatedAt']);
    expect(fieldNames(schema, 'Ignored')).toEqual(['id']);
    expect(fieldNames(schema, 'Paranoid')).toEqual([
      'id',
      'createdAt',
      'updatedAt',
      'removed_at',
    ]);
    expect(field(schema, 'Paranoid', 'removed_at')).toMatchObject({
      type: 'dateTime',
      isNullable: true,
    });
  });

  it('snake_cases the columns and timestamps of an underscored model', async () => {
    const schema: IrSchema = await parse(`
sequelize.define('BlogPost', {
  viewCount: DataTypes.INTEGER,
  lastSeen: { type: DataTypes.DATE, field: 'seen' },
}, { underscored: true, paranoid: true });
`);
    expect(
      model(schema, 'BlogPost').fields.map((item: IrField) => [
        item.name,
        item.columnName,
      ])
    ).toEqual([
      ['id', 'id'],
      ['viewCount', 'view_count'],
      ['lastSeen', 'seen'],
      ['createdAt', 'created_at'],
      ['updatedAt', 'updated_at'],
      ['deletedAt', 'deleted_at'],
    ]);
  });

  it('lets a declared attribute replace the generated timestamp column', async () => {
    const schema: IrSchema = await parse(`
sequelize.define('Thing', {
  createdAt: DataTypes.DATE,
  updatedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
});
`);
    expect(field(schema, 'Thing', 'createdAt').isNullable).toBe(true);
    expect(field(schema, 'Thing', 'updatedAt')).toMatchObject({
      isNullable: false,
      isAutoUpdated: true,
      default: { kind: 'now' },
    });
    expect(fieldNames(schema, 'Thing')).toEqual([
      'id',
      'createdAt',
      'updatedAt',
    ]);
  });

  it('adds a version column for version: true', async () => {
    const schema: IrSchema = await parse(
      `sequelize.define('Thing', {}, { timestamps: false, version: true });
sequelize.define('Other', {}, { timestamps: false, version: 'rev' });`
    );
    expect(field(schema, 'Thing', 'version')).toMatchObject({
      type: 'int',
      isNullable: false,
      default: { kind: 'literal', value: 0 },
    });
    expect(field(schema, 'Other', 'rev').type).toBe('int');
  });

  it('records the database schema', async () => {
    const schema: IrSchema = await parse(
      `sequelize.define('Thing', {}, { timestamps: false, schema: 'shop' });`
    );
    expect(model(schema, 'Thing').schema).toBe('shop');
  });

  it('uses the define defaults of new Sequelize(...)', async () => {
    const schema: IrSchema = await parse(`
const sequelize = new Sequelize('db', 'user', 'pw', {
  dialect: 'postgres',
  define: { underscored: true, freezeTableName: true, timestamps: false },
});
sequelize.define('BlogPost', { viewCount: DataTypes.INTEGER });
sequelize.define('Stamped', { viewCount: DataTypes.INTEGER }, { timestamps: true, underscored: false });
`);
    expect(model(schema, 'BlogPost').tableName).toBe('BlogPost');
    expect(fieldNames(schema, 'BlogPost')).toEqual(['id', 'viewCount']);
    expect(field(schema, 'BlogPost', 'viewCount').columnName).toBe(
      'view_count'
    );
    expect(model(schema, 'Stamped').tableName).toBe('Stamped');
    expect(fieldNames(schema, 'Stamped')).toContain('createdAt');
    expect(field(schema, 'Stamped', 'viewCount').columnName).toBe('viewCount');
  });

  it('follows attribute and option objects that are constants or spreads', async () => {
    const schema: IrSchema = await parse(`
const stamps = { createdBy: { type: DataTypes.STRING(30), allowNull: false } };
const attributes = { ...stamps, title: DataTypes.STRING(60) };
const options = { tableName: 'things', timestamps: false };
sequelize.define('Thing', attributes, options);
`);
    expect(model(schema, 'Thing').tableName).toBe('things');
    expect(fieldNames(schema, 'Thing')).toEqual(['id', 'createdBy', 'title']);
    expect(schema.warnings).toEqual([]);
  });

  it('follows attributes imported from another file', async () => {
    const schema: IrSchema = await parse(
      `const { shared } = require('./shared');
sequelize.define('Thing', shared, { timestamps: false });`,
      `const shared = { code: { type: DataTypes.STRING(8), unique: true } };
module.exports = { shared };`
    );
    expect(field(schema, 'Thing', 'code')).toMatchObject({
      maxLength: 8,
      isUnique: true,
    });
  });
});

describe('column types', () => {
  async function typeOf(expression: string): Promise<IrField> {
    return field(await parseAttribute(expression), 'Thing', 'value');
  }

  it('reads strings, text and binary', async () => {
    expect(await typeOf('DataTypes.STRING')).toMatchObject({
      type: 'string',
      maxLength: 255,
    });
    expect(await typeOf('DataTypes.STRING(100)')).toMatchObject({
      type: 'string',
      maxLength: 100,
    });
    expect(await typeOf('DataTypes.STRING({ length: 12 })')).toMatchObject({
      maxLength: 12,
    });
    expect(await typeOf('DataTypes.CHAR(3)')).toMatchObject({
      type: 'string',
      maxLength: 3,
    });
    expect(await typeOf('DataTypes.TEXT')).toMatchObject({ type: 'text' });
    expect(await typeOf("DataTypes.TEXT('long')")).toMatchObject({
      type: 'text',
    });
    expect(await typeOf('DataTypes.CITEXT')).toMatchObject({ type: 'text' });
    expect(await typeOf('DataTypes.STRING.BINARY')).toMatchObject({
      type: 'bytes',
    });
    expect(await typeOf('DataTypes.BLOB')).toMatchObject({ type: 'bytes' });
    expect(await typeOf("DataTypes.BLOB('tiny')")).toMatchObject({
      type: 'bytes',
    });
  });

  it('reads numbers', async () => {
    for (const type of [
      'INTEGER',
      'SMALLINT',
      'TINYINT',
      'MEDIUMINT',
      'INTEGER.UNSIGNED',
      'INTEGER.UNSIGNED.ZEROFILL',
    ]) {
      expect(await typeOf(`DataTypes.${type}`)).toMatchObject({ type: 'int' });
    }
    expect(await typeOf('DataTypes.INTEGER(11)')).toMatchObject({
      type: 'int',
    });
    expect(await typeOf('DataTypes.BIGINT')).toMatchObject({ type: 'bigInt' });
    for (const type of ['FLOAT', 'REAL', 'DOUBLE']) {
      expect(await typeOf(`DataTypes.${type}`)).toMatchObject({
        type: 'float',
      });
    }
    expect(await typeOf('DataTypes.FLOAT(11, 10)')).toMatchObject({
      type: 'float',
    });
    expect(await typeOf('DataTypes.DECIMAL')).toEqual(
      expect.objectContaining({ type: 'decimal' })
    );
    expect(await typeOf('DataTypes.DECIMAL(10, 2)')).toMatchObject({
      type: 'decimal',
      maxDigits: 10,
      decimalPlaces: 2,
    });
    expect(
      await typeOf('DataTypes.DECIMAL({ precision: 8, scale: 3 })')
    ).toMatchObject({ maxDigits: 8, decimalPlaces: 3 });
    expect(await typeOf('DataTypes.DECIMAL(12, 4).UNSIGNED')).toMatchObject({
      maxDigits: 12,
      decimalPlaces: 4,
    });
    expect(await typeOf('DataTypes.NUMERIC(5, 1)')).toMatchObject({
      type: 'decimal',
      maxDigits: 5,
    });
  });

  it('reads booleans, dates, uuids and json', async () => {
    expect(await typeOf('DataTypes.BOOLEAN')).toMatchObject({
      type: 'boolean',
    });
    expect(await typeOf('DataTypes.DATE')).toMatchObject({ type: 'dateTime' });
    expect(await typeOf('DataTypes.DATE(6)')).toMatchObject({
      type: 'dateTime',
    });
    expect(await typeOf('DataTypes.DATEONLY')).toMatchObject({ type: 'date' });
    expect(await typeOf('DataTypes.TIME')).toMatchObject({ type: 'time' });
    expect(await typeOf('DataTypes.UUID')).toMatchObject({ type: 'uuid' });
    expect(await typeOf('DataTypes.JSON')).toMatchObject({ type: 'json' });
    expect(await typeOf('DataTypes.JSONB')).toMatchObject({ type: 'json' });
    expect(await typeOf('DataTypes.INET')).toMatchObject({
      type: 'ipAddress',
    });
    expect(await typeOf('DataTypes.HSTORE')).toMatchObject({ type: 'hstore' });
  });

  it('accepts DataType, Sequelize, aliases, bare names and new', async () => {
    expect(await typeOf('DataType.STRING(20)')).toMatchObject({
      maxLength: 20,
    });
    expect(await typeOf('Sequelize.INTEGER')).toMatchObject({ type: 'int' });
    expect(await typeOf('DT.TEXT')).toMatchObject({ type: 'text' });
    expect(await typeOf('BOOLEAN')).toMatchObject({ type: 'boolean' });
    expect(await typeOf('{ type: DataTypes.BIGINT }')).toMatchObject({
      type: 'bigInt',
    });
  });

  it('reads enums into IR enums named after the model and the attribute', async () => {
    const schema: IrSchema = await parse(`
sequelize.define('Post', {
  status: { type: DataTypes.ENUM('draft', 'in review'), defaultValue: 'draft' },
  kind: DataTypes.ENUM({ values: ['a', 'b'] }),
  tone: { type: DataTypes.ENUM, values: ['calm', 'loud'] },
}, { timestamps: false });
`);
    expect(
      schema.enums.map((item: IrEnum) => [
        item.name,
        item.values.map((value) => `${value.name}=${value.dbValue}`),
      ])
    ).toEqual([
      ['PostStatus', ['DRAFT=draft', 'IN_REVIEW=in review']],
      ['PostKind', ['A=a', 'B=b']],
      ['PostTone', ['CALM=calm', 'LOUD=loud']],
    ]);
    expect(field(schema, 'Post', 'status')).toMatchObject({
      type: 'string',
      enumName: 'PostStatus',
      default: { kind: 'enumValue', value: 'DRAFT' },
    });
  });

  it('warns about an enum without readable values', async () => {
    const schema: IrSchema = await parseAttribute(
      'DataTypes.ENUM(...Object.values(Status))'
    );
    expect(field(schema, 'Thing', 'value')).toMatchObject({
      type: 'string',
      maxLength: 255,
    });
    expect(warningsMatching(schema, 'ENUM values')).toHaveLength(1);
    const bare: IrSchema = await parseAttribute('DataTypes.ENUM');
    expect(warningsMatching(bare, 'ENUM column without values')).toHaveLength(
      1
    );
  });

  it('reads arrays, ranges and unsupported PostgreSQL types', async () => {
    expect(await typeOf('DataTypes.ARRAY(DataTypes.TEXT)')).toMatchObject({
      type: 'text',
      arrayDepth: 1,
    });
    expect(
      await typeOf('DataTypes.ARRAY(DataTypes.ARRAY(DataTypes.INTEGER))')
    ).toMatchObject({ type: 'int', arrayDepth: 2 });
    expect(await typeOf('DataTypes.RANGE(DataTypes.DATE)')).toMatchObject({
      type: 'range',
      rangeOf: 'dateTime',
    });
    const geometry: IrSchema = await parseAttribute(
      "DataTypes.GEOMETRY('POINT')"
    );
    expect(field(geometry, 'Thing', 'value')).toMatchObject({
      type: 'unsupported',
      unsupportedType: 'geometry',
    });
    expect(warningsMatching(geometry, 'GEOMETRY')).toHaveLength(1);
    expect(warningsMatching(geometry, 'Thing')).toHaveLength(1);
  });

  it('warns about a type that is not a Sequelize data type', async () => {
    const schema: IrSchema = await parseAttribute('customType');
    expect(field(schema, 'Thing', 'value').type).toBe('unsupported');
    const warnings: string[] = warningsMatching(schema, 'Thing');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('"value"');
  });

  it('skips virtual attributes with a warning', async () => {
    const schema: IrSchema = await parse(`
sequelize.define('Person', {
  first: DataTypes.STRING,
  last: DataTypes.STRING,
  full: { type: DataTypes.VIRTUAL, get() { return this.first + this.last; } },
  initials: DataTypes.VIRTUAL(DataTypes.STRING, ['first']),
}, { timestamps: false });
`);
    expect(fieldNames(schema, 'Person')).toEqual(['id', 'first', 'last']);
    expect(warningsMatching(schema, 'DataTypes.VIRTUAL')).toHaveLength(2);
    expect(warningsMatching(schema, 'getters or setters on full')).toHaveLength(
      1
    );
  });
});

describe('column options', () => {
  it('reads allowNull (nullable by default), primary keys and auto-increment', async () => {
    const schema: IrSchema = await parse(`
sequelize.define('Thing', {
  id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
  a: DataTypes.STRING,
  b: { type: DataTypes.STRING, allowNull: true },
  c: { type: DataTypes.STRING, allowNull: false },
}, { timestamps: false });
`);
    expect(field(schema, 'Thing', 'id')).toMatchObject({
      type: 'bigInt',
      isNullable: false,
      default: { kind: 'autoIncrement' },
    });
    expect(field(schema, 'Thing', 'a').isNullable).toBe(true);
    expect(field(schema, 'Thing', 'b').isNullable).toBe(true);
    expect(field(schema, 'Thing', 'c').isNullable).toBe(false);
  });

  it('reads field (the column name), unique and its named forms', async () => {
    const schema: IrSchema = await parse(`
sequelize.define('Thing', {
  a: { type: DataTypes.STRING, field: 'col_a', unique: true },
  b: { type: DataTypes.STRING, unique: 'b_key' },
  c: { type: DataTypes.STRING, unique: { name: 'c_key', msg: 'taken' } },
  d: { type: DataTypes.STRING, unique: false },
}, { timestamps: false });
`);
    expect(field(schema, 'Thing', 'a')).toMatchObject({
      columnName: 'col_a',
      isUnique: true,
    });
    expect(field(schema, 'Thing', 'a').uniqueName).toBeUndefined();
    expect(field(schema, 'Thing', 'b')).toMatchObject({
      isUnique: true,
      uniqueName: 'b_key',
    });
    expect(field(schema, 'Thing', 'c')).toMatchObject({
      isUnique: true,
      uniqueName: 'c_key',
    });
    expect(field(schema, 'Thing', 'd').isUnique).toBe(false);
  });

  it('turns a unique name shared by several attributes into a composite unique index', async () => {
    const schema: IrSchema = await parse(`
sequelize.define('Setting', {
  scope: { type: DataTypes.STRING, unique: 'scope_key' },
  key: { type: DataTypes.STRING, unique: 'scope_key' },
  other: { type: DataTypes.STRING },
}, { timestamps: false });
`);
    expect(model(schema, 'Setting').indexes).toEqual([
      { fields: ['scope', 'key'], isUnique: true, name: 'scope_key' },
    ]);
    expect(field(schema, 'Setting', 'scope').isUnique).toBe(false);
  });

  it('ignores the unique names on attributes when the uniqueKeys option is set, like Sequelize', async () => {
    const schema: IrSchema = await parse(`
sequelize.define('Setting', {
  scope: { type: DataTypes.STRING, unique: 'scope_key' },
  key: { type: DataTypes.STRING, unique: 'scope_key' },
}, { timestamps: false, uniqueKeys: { by_key: { fields: ['key'] } } });
`);
    expect(model(schema, 'Setting').indexes).toEqual([
      { fields: ['key'], isUnique: true, name: 'by_key' },
    ]);
    expect(warningsMatching(schema, 'uniqueKeys option replaces')).toHaveLength(
      1
    );
  });

  it('reads literal, time and uuid defaults', async () => {
    const schema: IrSchema = await parse(`
sequelize.define('Thing', {
  a: { type: DataTypes.INTEGER, defaultValue: 5 },
  b: { type: DataTypes.STRING, defaultValue: 'hi' },
  c: { type: DataTypes.BOOLEAN, defaultValue: false },
  d: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
  e: { type: DataTypes.DATE, defaultValue: Sequelize.NOW },
  f: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4 },
  g: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV1 },
  h: { type: DataTypes.JSON, defaultValue: { a: [1, 'x'], b: null } },
  i: { type: DataTypes.JSON, defaultValue: [] },
  j: { type: DataTypes.DECIMAL(5, 2), defaultValue: '1.50' },
  k: { type: DataTypes.STRING, defaultValue: null },
  l: { type: DataTypes.INTEGER, defaultValue: -1 },
}, { timestamps: false });
`);
    const defaults = (name: string) => field(schema, 'Thing', name).default;
    expect(defaults('a')).toEqual({ kind: 'literal', value: 5 });
    expect(defaults('b')).toEqual({ kind: 'literal', value: 'hi' });
    expect(defaults('c')).toEqual({ kind: 'literal', value: false });
    expect(defaults('d')).toEqual({ kind: 'now' });
    expect(defaults('e')).toEqual({ kind: 'now' });
    expect(defaults('f')).toEqual({ kind: 'uuid' });
    expect(defaults('g')).toEqual({ kind: 'uuid', version: 1 });
    expect(defaults('h')).toEqual({
      kind: 'literal',
      value: '{"a":[1,"x"],"b":null}',
    });
    expect(defaults('i')).toEqual({ kind: 'literal', value: '[]' });
    expect(defaults('j')).toEqual({ kind: 'literal', value: 1.5 });
    expect(defaults('k')).toBeUndefined();
    expect(defaults('l')).toEqual({ kind: 'literal', value: -1 });
    expect(schema.warnings).toEqual([]);
  });

  it('reads database expressions from Sequelize.fn and Sequelize.literal', async () => {
    const schema: IrSchema = await parse(`
sequelize.define('Thing', {
  a: { type: DataTypes.DATE, defaultValue: Sequelize.fn('now') },
  b: { type: DataTypes.DATE, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
  c: { type: DataTypes.UUID, defaultValue: Sequelize.fn('gen_random_uuid') },
  d: { type: DataTypes.INTEGER, defaultValue: Sequelize.literal('7') },
  e: { type: DataTypes.STRING, defaultValue: Sequelize.literal("'abc'") },
  f: { type: DataTypes.STRING, defaultValue: Sequelize.fn('lower', 'ABC') },
  g: { type: DataTypes.STRING, defaultValue: Sequelize.literal('nextval(seq)') },
}, { timestamps: false });
`);
    const defaults = (name: string) => field(schema, 'Thing', name).default;
    expect(defaults('a')).toEqual({ kind: 'now' });
    expect(defaults('b')).toEqual({ kind: 'now' });
    expect(defaults('c')).toEqual({ kind: 'uuid' });
    expect(defaults('d')).toEqual({ kind: 'literal', value: 7 });
    expect(defaults('e')).toEqual({ kind: 'literal', value: 'abc' });
    expect(defaults('f')).toEqual({
      kind: 'dbExpression',
      expression: "lower('ABC')",
    });
    expect(defaults('g')).toEqual({
      kind: 'dbExpression',
      expression: 'nextval(seq)',
    });
  });

  it('warns about defaults computed at run time', async () => {
    const schema: IrSchema = await parse(`
sequelize.define('Thing', {
  a: { type: DataTypes.DATE, defaultValue: () => new Date() },
  b: { type: DataTypes.DATE, defaultValue: new Date() },
  c: { type: DataTypes.STRING, defaultValue: someConstant },
}, { timestamps: false });
`);
    for (const name of ['a', 'b', 'c']) {
      expect(field(schema, 'Thing', name).default).toBeUndefined();
    }
    expect(warningsMatching(schema, 'computed at run time')).toHaveLength(3);
  });

  it('turns references on an attribute into a foreign key', async () => {
    const schema: IrSchema = await parse(`
sequelize.define('Account', { code: { type: DataTypes.STRING(8), unique: true } }, { tableName: 'accounts', timestamps: false });
sequelize.define('Ticket', {
  accountId: { type: DataTypes.INTEGER, allowNull: false, references: { model: 'accounts', key: 'id' }, onDelete: 'CASCADE', onUpdate: 'RESTRICT' },
  accountCode: { type: DataTypes.STRING(8), references: { model: 'accounts', key: 'code' }, onDelete: 'set null' },
  orphan: { type: DataTypes.INTEGER, references: { model: 'nowhere', key: 'id' } },
}, { timestamps: false });
`);
    expect(relation(schema, 'Ticket', 'account')).toMatchObject({
      kind: 'foreignKey',
      targetModel: 'Account',
      columnName: 'accountId',
      isNullable: false,
      onDelete: 'cascade',
      onUpdate: 'restrict',
    });
    expect(relation(schema, 'Ticket', 'accountCode')).toMatchObject({
      isNullable: true,
      onDelete: 'setNull',
      toField: 'code',
    });
    expect(relation(schema, 'Ticket', 'orphan').targetModel).toBe('Nowhere');
    expect(
      warningsMatching(schema, '"Nowhere", which is not a model')
    ).toHaveLength(1);
    expect(fieldNames(schema, 'Ticket')).toEqual(['id']);
  });

  it('follows references to a model variable or a table name constant', async () => {
    const schema: IrSchema = await parse(`
const TABLE = 'accounts';
const Account = sequelize.define('Account', {}, { tableName: 'accounts', timestamps: false });
sequelize.define('Ticket', {
  viaVariable: { type: DataTypes.INTEGER, references: { model: Account, key: 'id' } },
  viaConstant: { type: DataTypes.INTEGER, references: { model: TABLE, key: 'id' } },
}, { timestamps: false });
`);
    expect(relation(schema, 'Ticket', 'viaVariable').targetModel).toBe(
      'Account'
    );
    expect(relation(schema, 'Ticket', 'viaConstant').targetModel).toBe(
      'Account'
    );
    expect(schema.models).toHaveLength(2);
  });

  it('warns about an unknown referential action', async () => {
    const schema: IrSchema = await parse(`
sequelize.define('A', {}, { timestamps: false });
sequelize.define('B', { aId: { type: DataTypes.INTEGER, references: { model: 'As', key: 'id' }, onDelete: 'EXPLODE' } }, { timestamps: false });
`);
    expect(relation(schema, 'B', 'a').onDelete).toBe('noAction');
    expect(warningsMatching(schema, 'onDelete "EXPLODE"')).toHaveLength(1);
  });
});

describe('indexes', () => {
  it('reads the indexes option', async () => {
    const schema: IrSchema = await parse(`
sequelize.define('Event', {
  title: DataTypes.STRING,
  startsAt: { type: DataTypes.DATE, field: 'starts_at' },
  slug: DataTypes.STRING,
  body: DataTypes.TEXT,
}, {
  timestamps: false,
  indexes: [
    { fields: ['title'] },
    { name: 'by_start', fields: ['starts_at', 'title'], using: 'BTREE' },
    { unique: true, fields: ['slug', 'title'] },
    { type: 'UNIQUE', name: 'slug_key', fields: ['slug'] },
    { type: 'FULLTEXT', fields: ['body'] },
    { fields: [{ name: 'title', order: 'DESC', length: 10 }], using: 'gin' },
    { fields: ['title'], unique: true },
  ],
});
`);
    const indexes: IrIndex[] = model(schema, 'Event').indexes;
    expect(indexes).toEqual([
      { fields: ['title'], isUnique: false },
      {
        fields: ['startsAt', 'title'],
        isUnique: false,
        name: 'by_start',
        method: 'BTree',
      },
      { fields: ['slug', 'title'], isUnique: true },
      { fields: ['slug'], isUnique: true, name: 'slug_key' },
      { fields: ['body'], isUnique: false, kind: 'fulltext' },
      {
        fields: ['title'],
        isUnique: false,
        method: 'Gin',
        fieldOptions: { title: { sort: 'desc', length: 10 } },
      },
    ]);
    // An unnamed unique index over one column is the same as unique: true.
    expect(field(schema, 'Event', 'title').isUnique).toBe(true);
  });

  it('reads uniqueKeys and names them', async () => {
    const schema: IrSchema = await parse(`
sequelize.define('Thing', { a: DataTypes.STRING, b: DataTypes.STRING }, {
  timestamps: false,
  uniqueKeys: { a_b: { fields: ['a', 'b'] }, only_a: { fields: ['a'], customIndex: true } },
});
`);
    expect(model(schema, 'Thing').indexes).toEqual([
      { fields: ['a', 'b'], isUnique: true, name: 'a_b' },
      { fields: ['a'], isUnique: true, name: 'only_a' },
    ]);
  });

  it('skips indexes it cannot keep and says why', async () => {
    const schema: IrSchema = await parse(`
sequelize.define('Thing', { a: DataTypes.STRING }, {
  timestamps: false,
  indexes: [
    { fields: ['missing'] },
    { fields: [Sequelize.literal('lower(a)')] },
    { fields: ['a'], where: { a: 'x' } },
    { fields: ['a'], using: 'WEIRD', name: 'weird' },
  ],
});
`);
    expect(model(schema, 'Thing').indexes.map((item) => item.name)).toEqual([
      undefined,
      'weird',
    ]);
    expect(
      warningsMatching(schema, '"missing", which is not a column')
    ).toHaveLength(1);
    expect(
      warningsMatching(schema, 'expression (Sequelize.literal)')
    ).toHaveLength(1);
    expect(warningsMatching(schema, 'where condition')).toHaveLength(1);
    expect(warningsMatching(schema, 'method "WEIRD"')).toHaveLength(1);
  });
});

describe('what is not schema', () => {
  it('warns once per model about hooks, scopes and getters, and ignores validators silently', async () => {
    const schema: IrSchema = await parse(`
sequelize.define('Thing', {
  name: { type: DataTypes.STRING, validate: { len: [1, 10] }, set(value) { this.setDataValue('name', value); } },
  email: { type: DataTypes.STRING, get() { return 1; } },
}, {
  timestamps: false,
  validate: { both() {} },
  hooks: { beforeCreate() {} },
  scopes: { active: { where: { a: 1 } } },
  defaultScope: { where: { b: 1 } },
  comment: 'a table',
  engine: 'InnoDB',
});
`);
    expect(
      warningsMatching(schema, 'getters or setters on name, email')
    ).toHaveLength(1);
    const unsupported: string[] = warningsMatching(
      schema,
      'not part of the database schema'
    );
    expect(unsupported).toHaveLength(1);
    expect(unsupported[0]).toContain('hooks, scopes, a default scope');
    expect(schema.warnings).toHaveLength(2);
  });
});

describe('Model.init classes', () => {
  it('reads a class with a top-level init call', async () => {
    const schema: IrSchema = await parse(`
class User extends Model {
  static associate(models) {
    User.hasMany(models.Post, { as: 'posts', foreignKey: 'authorId' });
  }
}
User.init({ name: DataTypes.STRING(30) }, { sequelize, modelName: 'User', tableName: 'users' });
class Post extends Model {}
Post.init({ title: DataTypes.STRING, authorId: DataTypes.INTEGER }, { sequelize });
`);
    expect(model(schema, 'User').tableName).toBe('users');
    expect(model(schema, 'Post').tableName).toBe('Posts');
    expect(relation(schema, 'Post', 'author')).toMatchObject({
      targetModel: 'User',
      relatedName: 'posts',
      columnName: 'authorId',
    });
  });

  it('reads the sequelize-cli class template', async () => {
    const schema: IrSchema = await parse(
      `
'use strict';
const { Model } = require('sequelize');
module.exports = (sequelize, DataTypes) => {
  class Project extends Model {
    static associate(models) {
      this.belongsTo(models.Owner, { foreignKey: 'ownerId' });
    }
  }
  Project.init({ name: DataTypes.STRING, ownerId: DataTypes.INTEGER }, { sequelize, modelName: 'Project' });
  return Project;
};`,
      `module.exports = (sequelize, DataTypes) => {
  class Owner extends Model {}
  Owner.init({ name: DataTypes.STRING }, { sequelize, modelName: 'Owner' });
  return Owner;
};`
    );
    expect(model(schema, 'Project').tableName).toBe('Projects');
    // ownerId is declared without allowNull, which Sequelize does not count as "allows null": NO ACTION.
    expect(relation(schema, 'Project', 'owner')).toMatchObject({
      targetModel: 'Owner',
      columnName: 'ownerId',
      isNullable: true,
      onDelete: 'noAction',
    });
  });

  it('reads init called from a static method (this.init and super.init)', async () => {
    const schema: IrSchema = await parse(`
class A extends Model {
  static initModel(sequelize) {
    this.init({ x: DataTypes.INTEGER }, { sequelize, timestamps: false });
    return this;
  }
}
class B extends Model {
  static init(sequelize) {
    return super.init({ y: DataTypes.INTEGER }, { sequelize, timestamps: false });
  }
}
`);
    expect(fieldNames(schema, 'A')).toEqual(['id', 'x']);
    expect(fieldNames(schema, 'B')).toEqual(['id', 'y']);
  });

  it('reads TypeScript classes with typed fields', async () => {
    const schema: IrSchema = expectOk(
      await parseSequelize(
        [
          {
            path: 'user.ts',
            text: `import { CreationOptional, DataTypes, InferAttributes, Model, Sequelize } from 'sequelize';
export class User extends Model<InferAttributes<User>> {
  declare id: CreationOptional<number>;
  declare name: string;
  declare bio: string | null;
}
User.init(
  { id: { type: DataTypes.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true }, name: { type: DataTypes.STRING, allowNull: false }, bio: DataTypes.TEXT },
  { sequelize, tableName: 'users', timestamps: false }
);`,
          },
        ],
        { appLabel: 'app' }
      )
    );
    expect(model(schema, 'User').tableName).toBe('users');
    expect(fieldNames(schema, 'User')).toEqual(['id', 'name', 'bio']);
    expect(field(schema, 'User', 'bio').isNullable).toBe(true);
    expect(field(schema, 'User', 'name').isNullable).toBe(false);
  });

  it('ignores init calls that are not Sequelize models', async () => {
    const schema: IrSchema = await parse(`
const thing = { init(a, b) {} };
thing.init({ a: 1 }, { b: 2 });
sequelize.define('Real', {}, { timestamps: false });
`);
    expect(schema.models.map((item: IrModel) => item.name)).toEqual(['Real']);
  });

  it('reads the sequelize.define pattern of old sequelize-cli versions', async () => {
    const schema: IrSchema = await parse(`
module.exports = function (sequelize, DataTypes) {
  return sequelize.define('legacy_item', { sku: DataTypes.STRING(12) }, { tableName: 'legacy', timestamps: false });
};`);
    expect(model(schema, 'LegacyItem').tableName).toBe('legacy');
    expect(field(schema, 'LegacyItem', 'sku').maxLength).toBe(12);
  });
});

describe('associations', () => {
  it('adds the foreign key of hasMany with the default name and action', async () => {
    const schema: IrSchema = await parse(`
const User = sequelize.define('User', {}, { timestamps: false });
const Post = sequelize.define('Post', {}, { timestamps: false });
User.hasMany(Post);
`);
    expect(
      model(schema, 'Post').fields.map((item: IrField) => item.name)
    ).toEqual(['id']);
    expect(relation(schema, 'Post', 'user')).toMatchObject({
      kind: 'foreignKey',
      targetModel: 'User',
      columnName: 'UserId',
      isNullable: true,
      onDelete: 'setNull',
      relatedName: 'posts',
    });
  });

  it('names the key after the alias for belongsTo and snake_cases it for underscored models', async () => {
    const schema: IrSchema = await parse(`
const User = sequelize.define('User', {}, { timestamps: false });
const Post = sequelize.define('Post', {}, { timestamps: false, underscored: true });
Post.belongsTo(User);
Post.belongsTo(User, { as: 'editor' });
`);
    expect(relation(schema, 'Post', 'user')).toMatchObject({
      columnName: 'user_id',
      onDelete: 'setNull',
    });
    expect(relation(schema, 'Post', 'editor').columnName).toBe('editor_id');
    expect(relation(schema, 'Post', 'user').relatedName).toBeUndefined();
  });

  it('chooses the default ON DELETE from allowNull, as Sequelize does', async () => {
    const schema: IrSchema = await parse(`
const User = sequelize.define('User', {}, { timestamps: false });
const Post = sequelize.define('Post', { declared: DataTypes.INTEGER, required: { type: DataTypes.INTEGER, allowNull: false } }, { timestamps: false });
Post.belongsTo(User, { as: 'viaOption', foreignKey: { name: 'optionId', allowNull: false } });
Post.belongsTo(User, { as: 'fresh', foreignKey: 'freshId' });
Post.belongsTo(User, { as: 'declared', foreignKey: 'declared' });
Post.belongsTo(User, { as: 'required', foreignKey: 'required' });
User.hasMany(Post, { as: 'manyRequired', foreignKey: 'required' });
User.hasMany(Post, { as: 'manyOption', foreignKey: { name: 'manyId', allowNull: false } });
User.hasMany(Post, { as: 'manyNull', foreignKey: 'manyNullId' });
`);
    // belongsTo: SET NULL when the new column allows null, NO ACTION when it does not.
    expect(relation(schema, 'Post', 'viaOption')).toMatchObject({
      isNullable: false,
      onDelete: 'noAction',
    });
    expect(relation(schema, 'Post', 'fresh')).toMatchObject({
      isNullable: true,
      onDelete: 'setNull',
    });
    // A column the model declares without allowNull is not "allow null" for this decision.
    expect(relation(schema, 'Post', 'declared')).toMatchObject({
      isNullable: true,
      onDelete: 'noAction',
    });
    expect(relation(schema, 'Post', 'required')).toMatchObject({
      isNullable: false,
      onDelete: 'noAction',
    });
    // hasMany: SET NULL when the column allows null, CASCADE when it does not.
    expect(
      model(schema, 'Post').relations.find(
        (item) => item.relatedName === 'manyOption'
      )
    ).toMatchObject({ onDelete: 'cascade', isNullable: false });
    expect(
      model(schema, 'Post').relations.find(
        (item) => item.relatedName === 'manyNull'
      )
    ).toMatchObject({ onDelete: 'setNull' });
  });

  it('lets an explicit onDelete and onUpdate win', async () => {
    const schema: IrSchema = await parse(`
const User = sequelize.define('User', {}, { timestamps: false });
const Post = sequelize.define('Post', {}, { timestamps: false });
Post.belongsTo(User, { onDelete: 'CASCADE', onUpdate: 'RESTRICT' });
Post.belongsTo(User, { as: 'other', onDelete: 'RESTRICT' });
`);
    expect(relation(schema, 'Post', 'user')).toMatchObject({
      onDelete: 'cascade',
      onUpdate: 'restrict',
    });
    expect(relation(schema, 'Post', 'other')).toMatchObject({
      onDelete: 'restrict',
    });
    expect(relation(schema, 'Post', 'other').onUpdate).toBeUndefined();
  });

  it('pairs hasMany and belongsTo on the same key into one relation with a reverse name', async () => {
    const schema: IrSchema = await parse(`
const User = sequelize.define('User', {}, { timestamps: false });
const Post = sequelize.define('Post', {}, { timestamps: false });
Post.belongsTo(User, { as: 'author', foreignKey: 'authorId' });
Post.belongsTo(User, { as: 'editor', foreignKey: 'editorId' });
User.hasMany(Post, { as: 'posts', foreignKey: 'authorId' });
User.hasMany(Post, { as: 'editedPosts', foreignKey: 'editorId' });
`);
    expect(
      model(schema, 'Post').relations.map((item: IrRelation) => [
        item.name,
        item.relatedName,
      ])
    ).toEqual([
      ['author', 'posts'],
      ['editor', 'editedPosts'],
    ]);
  });

  it('names a relation after its key when only the reverse side is declared', async () => {
    const schema: IrSchema = await parse(`
const User = sequelize.define('User', {}, { timestamps: false });
const Post = sequelize.define('Post', {}, { timestamps: false });
User.hasMany(Post, { as: 'posts', foreignKey: 'authorId' });
User.hasMany(Post, { as: 'others', foreignKey: 'owner' });
`);
    expect(relation(schema, 'Post', 'author').relatedName).toBe('posts');
    expect(relation(schema, 'Post', 'owner').relatedName).toBe('others');
  });

  it('makes hasOne a one-to-one only when the key is unique', async () => {
    const schema: IrSchema = await parse(`
const User = sequelize.define('User', {}, { timestamps: false });
const Profile = sequelize.define('Profile', { userId: { type: DataTypes.INTEGER, unique: true } }, { timestamps: false });
const Badge = sequelize.define('Badge', {}, { timestamps: false });
User.hasOne(Profile, { foreignKey: 'userId' });
User.hasOne(Badge, { foreignKey: 'userId' });
`);
    expect(relation(schema, 'Profile', 'user')).toMatchObject({
      kind: 'oneToOne',
      relatedName: 'profile',
    });
    expect(relation(schema, 'Badge', 'user')).toMatchObject({
      kind: 'foreignKey',
      relatedName: 'badge',
    });
    expect(
      warningsMatching(schema, 'does not make "userId" unique')
    ).toHaveLength(1);
  });

  it('names the key of hasOne after its alias, as Sequelize does', async () => {
    const schema: IrSchema = await parse(`
const User = sequelize.define('User', {}, { timestamps: false });
const Profile = sequelize.define('Profile', {}, { timestamps: false });
User.hasOne(Profile, { as: 'details' });
`);
    expect(relation(schema, 'Profile', 'detail').columnName).toBe('detailId');
  });

  it('reads sourceKey and targetKey', async () => {
    const schema: IrSchema = await parse(`
const User = sequelize.define('User', { email: { type: DataTypes.STRING(80), unique: true } }, { timestamps: false });
const Post = sequelize.define('Post', {}, { timestamps: false });
Post.belongsTo(User, { as: 'author', foreignKey: 'authorEmail', targetKey: 'email' });
User.hasMany(Post, { as: 'written', foreignKey: 'writerEmail', sourceKey: 'email' });
`);
    expect(relation(schema, 'Post', 'author')).toMatchObject({
      toField: 'email',
    });
    expect(relation(schema, 'Post', 'writerEmail')).toMatchObject({
      toField: 'email',
      relatedName: 'written',
    });
    expect(model(schema, 'Post').fields.map((item) => item.name)).toEqual([
      'id',
    ]);
  });

  it('copies the type of a non-integer key to the foreign key column', async () => {
    const schema: IrSchema = await parse(`
const Country = sequelize.define('Country', { code: { type: DataTypes.CHAR(2), primaryKey: true } }, { timestamps: false });
const City = sequelize.define('City', {}, { timestamps: false });
City.belongsTo(Country, { foreignKey: 'countryCode' });
`);
    expect(relation(schema, 'City', 'country')).toMatchObject({
      columnName: 'countryCode',
    });
    expect(relation(schema, 'City', 'country').toField).toBeUndefined();
  });

  it('reads a self reference', async () => {
    const schema: IrSchema = await parse(`
const Category = sequelize.define('Category', {}, { timestamps: false });
Category.belongsTo(Category, { as: 'parent', foreignKey: 'parentId' });
Category.hasMany(Category, { as: 'children', foreignKey: 'parentId' });
`);
    expect(relation(schema, 'Category', 'parent')).toMatchObject({
      targetModel: 'Category',
      relatedName: 'children',
      columnName: 'parentId',
    });
  });

  it('applies associations written in associate functions, classes and at the top level', async () => {
    const schema: IrSchema = await parse(
      `module.exports = (sequelize, DataTypes) => {
  const A = sequelize.define('A', {}, { timestamps: false });
  A.associate = function (models) {
    this.hasMany(models.B, { as: 'bs', foreignKey: 'aId' });
  };
  return A;
};`,
      `class B extends Model {}
B.init({}, { sequelize, timestamps: false });
B.associate = (models) => { B.hasMany(models.C, { as: 'cs', foreignKey: 'bId' }); };
sequelize.models.C.belongsTo(sequelize.models.B, { as: 'b', foreignKey: 'bId' });`,
      `export const C = sequelize.define('C', {}, { timestamps: false });
sequelize.model('B').hasMany(C, { as: 'cs', foreignKey: 'bId' });`
    );
    expect(relation(schema, 'B', 'a').relatedName).toBe('bs');
    expect(relation(schema, 'C', 'b').relatedName).toBe('cs');
  });

  it('reads constraints: false as a plain column', async () => {
    const schema: IrSchema = await parse(`
const A = sequelize.define('A', {}, { timestamps: false });
const B = sequelize.define('B', {}, { timestamps: false });
B.belongsTo(A, { foreignKey: 'aId', constraints: false });
`);
    expect(model(schema, 'B').relations).toEqual([]);
    expect(field(schema, 'B', 'aId').type).toBe('int');
    expect(warningsMatching(schema, 'constraints: false')).toHaveLength(1);
  });

  it('warns about scoped (polymorphic) associations', async () => {
    const schema: IrSchema = await parse(`
const Comment = sequelize.define('Comment', { commentableId: DataTypes.INTEGER, commentableType: DataTypes.STRING }, { timestamps: false });
const Image = sequelize.define('Image', {}, { timestamps: false });
Image.hasMany(Comment, { foreignKey: 'commentableId', constraints: false, scope: { commentableType: 'image' } });
`);
    expect(warningsMatching(schema, 'scope')).toHaveLength(1);
    expect(warningsMatching(schema, 'constraints: false')).toHaveLength(1);
  });

  it('warns and skips associations it cannot resolve', async () => {
    const schema: IrSchema = await parse(`
const A = sequelize.define('A', {}, { timestamps: false });
A.hasMany(Missing);
Unknown.hasMany(A);
A.belongsTo(models[dynamic]);
A.belongsToMany(A, { as: 'peers' });
`);
    expect(model(schema, 'A').relations).toEqual([]);
    expect(warningsMatching(schema, 'Missing')).toHaveLength(1);
    expect(warningsMatching(schema, '"Unknown"')).toHaveLength(1);
    expect(
      warningsMatching(schema, 'cannot be resolved statically')
    ).toHaveLength(1);
    expect(warningsMatching(schema, 'needs a through option')).toHaveLength(1);
  });

  it('generates a stub for a belongsTo target that is not in the input', async () => {
    const schema: IrSchema = await parse(`
const Post = sequelize.define('Post', {}, { timestamps: false });
Post.belongsTo(models.Author, { as: 'author', foreignKey: 'authorId' });
`);
    expect(relation(schema, 'Post', 'author').targetModel).toBe('Author');
    expect(model(schema, 'Author').fields.map((item) => item.name)).toEqual([
      'id',
    ]);
    expect(
      warningsMatching(schema, '"Author", which is not a model')
    ).toHaveLength(1);
  });
});

describe('many-to-many', () => {
  it('reads a string through as a many-to-many relation and pairs the two sides', async () => {
    const schema: IrSchema = await parse(`
const Post = sequelize.define('Post', {}, { tableName: 'blog_post', timestamps: false });
const Tag = sequelize.define('Tag', {}, { tableName: 'blog_tag', timestamps: false });
Post.belongsToMany(Tag, { through: 'blog_post_tags', as: 'tags', foreignKey: 'post_id', otherKey: 'tag_id' });
Tag.belongsToMany(Post, { through: 'blog_post_tags', as: 'posts', foreignKey: 'tag_id', otherKey: 'post_id' });
`);
    expect(model(schema, 'Post').relations).toEqual([
      expect.objectContaining({
        name: 'tags',
        kind: 'manyToMany',
        targetModel: 'Tag',
        relatedName: 'posts',
      }),
    ]);
    expect(model(schema, 'Tag').relations).toEqual([]);
    expect(schema.models).toHaveLength(2);
    expect(schema.warnings).toEqual([]);
  });

  it('keeps a one-sided many-to-many and defaults the alias to the plural model name', async () => {
    const schema: IrSchema = await parse(`
const Post = sequelize.define('Post', {}, { tableName: 'blog_post', timestamps: false });
const Tag = sequelize.define('Tag', {}, { timestamps: false });
Post.belongsToMany(Tag, { through: 'blog_post_tags', foreignKey: 'post_id', otherKey: 'tag_id' });
`);
    expect(relation(schema, 'Post', 'tags')).toMatchObject({
      kind: 'manyToMany',
      targetModel: 'Tag',
    });
    expect(relation(schema, 'Post', 'tags').relatedName).toBeUndefined();
  });

  it('warns when the join table cannot be derived by the other formats', async () => {
    const schema: IrSchema = await parse(`
const Post = sequelize.define('Post', {}, { timestamps: false });
const Tag = sequelize.define('Tag', {}, { timestamps: false });
Post.belongsToMany(Tag, { through: 'PostTags' });
Person.belongsToMany(Person, { through: 'friends', as: 'friends' });
const Person = sequelize.define('Person', {}, { timestamps: false });
`);
    const warnings: string[] = warningsMatching(
      schema,
      'is not preserved by name'
    );
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain('"PostTags" (columns PostId, TagId)');
    expect(warnings[0]).toContain('"Posts_tags" (columns post_id, tag_id)');
  });

  it('adds the key columns to an explicit join model and makes them its primary key', async () => {
    const schema: IrSchema = await parse(`
const Post = sequelize.define('Post', {}, { timestamps: false });
const Tag = sequelize.define('Tag', {}, { timestamps: false });
const PostTag = sequelize.define('PostTag', { weight: DataTypes.INTEGER }, { timestamps: false });
Post.belongsToMany(Tag, { through: PostTag });
Tag.belongsToMany(Post, { through: PostTag });
`);
    expect(model(schema, 'Post').relations).toEqual([]);
    const join: IrModel = model(schema, 'PostTag');
    expect(join.compositePrimaryKey).toEqual(['post', 'tag']);
    expect(join.fields.map((item: IrField) => item.name)).toEqual(['weight']);
    expect(
      join.relations.map((item: IrRelation) => [
        item.name,
        item.columnName,
        item.targetModel,
        item.onDelete,
      ])
    ).toEqual([
      ['post', 'PostId', 'Post', 'cascade'],
      ['tag', 'TagId', 'Tag', 'cascade'],
    ]);
  });

  it('keeps the key of a join model that has one and makes the pair unique', async () => {
    const schema: IrSchema = await parse(`
const Post = sequelize.define('Post', {}, { timestamps: false });
const Tag = sequelize.define('Tag', {}, { timestamps: false });
const PostTag = sequelize.define('PostTag', { id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true } }, { timestamps: false, tableName: 'post_tags' });
Post.belongsToMany(Tag, { through: { model: PostTag, unique: true }, foreignKey: 'postId', otherKey: 'tagId' });
`);
    const join: IrModel = model(schema, 'PostTag');
    expect(join.compositePrimaryKey).toBeUndefined();
    expect(join.indexes).toEqual([
      {
        fields: ['post', 'tag'],
        isUnique: true,
        name: 'post_tags_postId_tagId_unique',
      },
    ]);
  });

  it('uses the model of a through string that names one', async () => {
    const schema: IrSchema = await parse(`
const Post = sequelize.define('Post', {}, { timestamps: false });
const Tag = sequelize.define('Tag', {}, { timestamps: false });
sequelize.define('Link', {}, { timestamps: false });
Post.belongsToMany(Tag, { through: 'Link' });
`);
    expect(model(schema, 'Link').relations).toHaveLength(2);
    expect(model(schema, 'Post').relations).toEqual([]);
  });

  it('pairs the two halves of a many-to-many to the same model', async () => {
    const schema: IrSchema = await parse(`
const Person = sequelize.define('Person', {}, { tableName: 'people', timestamps: false });
Person.belongsToMany(Person, { through: 'people_friends', as: 'friends', foreignKey: 'from_person_id', otherKey: 'to_person_id' });
Person.belongsToMany(Person, { through: 'people_friends', as: 'friendOf', foreignKey: 'to_person_id', otherKey: 'from_person_id' });
`);
    expect(
      model(schema, 'Person').relations.map((item: IrRelation) => [
        item.name,
        item.relatedName,
      ])
    ).toEqual([['friends', 'friendOf']]);
    expect(schema.warnings).toEqual([]);
  });
});

describe('sequelize-typescript', () => {
  async function parseTs(text: string): Promise<IrSchema> {
    return expectOk(
      await parseSequelize([{ path: 'models.ts', text }], { appLabel: 'app' })
    );
  }

  it('reads @Table options, columns and the usual property decorators', async () => {
    const schema: IrSchema = await parseTs(`
@Table({ tableName: 'authors', paranoid: true, underscored: true })
export class Author extends Model {
  @PrimaryKey @AutoIncrement @Column(DataType.BIGINT) id!: number;
  @AllowNull(false) @Unique @Column(DataType.STRING(80)) email!: string;
  @Unique('author_nick') @Column({ type: DataType.STRING, field: 'nick' }) nickname!: string;
  @Column(DataType.TEXT) bio!: string | null;
  @Default('active') @Column(DataType.ENUM('active', 'banned')) state!: string;
  @NotNull @Default(0) @Column(DataType.INTEGER) points!: number;
  @Comment('free text') @Column notes!: string;
  @Column visits!: number;
  @Column active!: boolean;
  @Column born!: Date;
  @Column big!: bigint;
  @Column raw!: Buffer;
  @CreatedAt createdAt!: Date;
  @UpdatedAt updatedAt!: Date;
  @DeletedAt deletedAt!: Date | null;
  notAColumn!: string;
}`);
    const author: IrModel = model(schema, 'Author');
    expect(author.tableName).toBe('authors');
    expect(
      author.fields.map((item: IrField) => [
        item.name,
        item.columnName,
        item.type,
      ])
    ).toEqual([
      ['id', 'id', 'bigInt'],
      ['email', 'email', 'string'],
      ['nickname', 'nick', 'string'],
      ['bio', 'bio', 'text'],
      ['state', 'state', 'string'],
      ['points', 'points', 'int'],
      ['notes', 'notes', 'string'],
      ['visits', 'visits', 'int'],
      ['active', 'active', 'boolean'],
      ['born', 'born', 'dateTime'],
      ['big', 'big', 'bigInt'],
      ['raw', 'raw', 'bytes'],
      ['createdAt', 'created_at', 'dateTime'],
      ['updatedAt', 'updated_at', 'dateTime'],
      ['deletedAt', 'deleted_at', 'dateTime'],
    ]);
    expect(field(schema, 'Author', 'id')).toMatchObject({
      isPrimaryKey: true,
      default: { kind: 'autoIncrement' },
    });
    expect(field(schema, 'Author', 'email')).toMatchObject({
      isNullable: false,
      isUnique: true,
      maxLength: 80,
    });
    expect(field(schema, 'Author', 'nickname')).toMatchObject({
      isUnique: true,
      uniqueName: 'author_nick',
    });
    expect(field(schema, 'Author', 'points')).toMatchObject({
      isNullable: false,
      default: { kind: 'literal', value: 0 },
    });
    expect(field(schema, 'Author', 'state').default).toEqual({
      kind: 'enumValue',
      value: 'ACTIVE',
    });
    expect(field(schema, 'Author', 'notes')).toMatchObject({
      type: 'string',
      maxLength: 255,
    });
    expect(field(schema, 'Author', 'updatedAt').isAutoUpdated).toBe(true);
    expect(field(schema, 'Author', 'deletedAt').isNullable).toBe(true);
    expect(field(schema, 'Author', 'createdAt').isNullable).toBe(false);
  });

  it('lets @CreatedAt name the timestamp column without declaring it', async () => {
    const schema: IrSchema = await parseTs(`
@Table
export class Entry extends Model {
  @Column(DataType.STRING) title!: string;
  @CreatedAt made!: Date;
  @UpdatedAt changed!: Date;
}`);
    expect(model(schema, 'Entry').tableName).toBe('Entries');
    expect(fieldNames(schema, 'Entry')).toEqual([
      'id',
      'title',
      'made',
      'changed',
    ]);
    expect(field(schema, 'Entry', 'made').isNullable).toBe(false);
    expect(field(schema, 'Entry', 'changed').isAutoUpdated).toBe(true);
  });

  it('reads classes with the decorator before or after export, and modelName', async () => {
    const schema: IrSchema = await parseTs(`
@Table({ modelName: 'Renamed', timestamps: false })
class First extends Model { @Column(DataType.STRING) a!: string; }
@Table({ timestamps: false })
export default class Second extends Model { @Column(DataType.STRING) b!: string; }
export class NotATable extends Model { @Column(DataType.STRING) c!: string; }`);
    expect(schema.models.map((item: IrModel) => item.name)).toEqual([
      'Renamed',
      'Second',
    ]);
    expect(model(schema, 'Renamed').tableName).toBe('Renameds');
  });

  it('finds foreign keys through @ForeignKey and names relations after the properties', async () => {
    const schema: IrSchema = await parseTs(`
@Table({ timestamps: false })
export class Author extends Model {
  @PrimaryKey @Column(DataType.INTEGER) id!: number;
  @HasMany(() => Post) posts!: Post[];
  @HasOne(() => Profile) profile!: Profile | null;
}
@Table({ timestamps: false })
export class Profile extends Model {
  @PrimaryKey @Column(DataType.INTEGER) id!: number;
  @ForeignKey(() => Author) @AllowNull(false) @Unique @Column(DataType.INTEGER) authorId!: number;
  @BelongsTo(() => Author, { onDelete: 'CASCADE' }) author!: Author;
}
@Table({ timestamps: false })
export class Post extends Model {
  @PrimaryKey @Column(DataType.INTEGER) id!: number;
  @ForeignKey(() => Author) @AllowNull @Column(DataType.INTEGER) writerId!: number | null;
  @BelongsTo(() => Author, 'writerId') writer!: Author | null;
}`);
    expect(
      model(schema, 'Profile').fields.map((item: IrField) => item.name)
    ).toEqual(['id']);
    expect(relation(schema, 'Profile', 'author')).toMatchObject({
      kind: 'oneToOne',
      columnName: 'authorId',
      isNullable: false,
      onDelete: 'cascade',
      relatedName: 'profile',
    });
    expect(relation(schema, 'Post', 'writer')).toMatchObject({
      kind: 'foreignKey',
      columnName: 'writerId',
      isNullable: true,
      onDelete: 'setNull',
      relatedName: 'posts',
    });
  });

  it('reads @BelongsToMany with a join model, a table name and options', async () => {
    const schema: IrSchema = await parseTs(`
@Table({ tableName: 'posts', timestamps: false })
export class Post extends Model {
  @PrimaryKey @Column(DataType.INTEGER) id!: number;
  @BelongsToMany(() => Tag, () => PostTag) tags!: Tag[];
  @BelongsToMany(() => Tag, { through: 'post_labels', foreignKey: 'post_id', otherKey: 'label_id' }) labels!: Tag[];
  @BelongsToMany(() => Tag, 'post_stars', 'post_id', 'star_id') stars!: Tag[];
}
@Table({ tableName: 'tags', timestamps: false })
export class Tag extends Model {
  @PrimaryKey @Column(DataType.INTEGER) id!: number;
  @BelongsToMany(() => Post, () => PostTag) posts!: Post[];
}
@Table({ tableName: 'post_tags', timestamps: false })
export class PostTag extends Model {
  @ForeignKey(() => Post) @Column(DataType.INTEGER) postId!: number;
  @ForeignKey(() => Tag) @Column(DataType.INTEGER) tagId!: number;
}`);
    expect(
      model(schema, 'Post').relations.map((item: IrRelation) => [
        item.name,
        item.kind,
      ])
    ).toEqual([
      ['labels', 'manyToMany'],
      ['stars', 'manyToMany'],
    ]);
    const join: IrModel = model(schema, 'PostTag');
    expect(join.compositePrimaryKey).toEqual(['post', 'tag']);
    expect(join.relations.map((item: IrRelation) => item.columnName)).toEqual([
      'postId',
      'tagId',
    ]);
    expect(warningsMatching(schema, 'post_labels')).toHaveLength(1);
  });

  it('merges @Index decorators with the same name into one index', async () => {
    const schema: IrSchema = await parseTs(`
@Table({ timestamps: false })
export class Post extends Model {
  @Index @Column(DataType.STRING) title!: string;
  @Index({ name: 'status_idx' }) @Column(DataType.STRING) status!: string;
  @Index({ name: 'status_idx' }) @Column(DataType.DATE) at!: Date;
  @Index({ name: 'uniq_slug', unique: true }) @Column(DataType.STRING) slug!: string;
}`);
    expect(model(schema, 'Post').indexes).toEqual([
      { fields: ['title'], isUnique: false },
      { fields: ['status', 'at'], isUnique: false, name: 'status_idx' },
      { fields: ['slug'], isUnique: true, name: 'uniq_slug' },
    ]);
  });

  it('warns when the indexes option of @Table replaces @Index decorators', async () => {
    const schema: IrSchema = await parseTs(`
@Table({ timestamps: false, indexes: [{ fields: ['title'], name: 'kept' }] })
export class Post extends Model {
  @Index @Column(DataType.STRING) title!: string;
}`);
    expect(
      model(schema, 'Post').indexes.map((item: IrIndex) => item.name)
    ).toEqual(['kept']);
    expect(
      warningsMatching(schema, 'replaces the indexes declared with @Index')
    ).toHaveLength(1);
  });

  it('warns about hooks, scopes and contradictory nullability', async () => {
    const schema: IrSchema = await parseTs(`
@Table({ timestamps: false })
@DefaultScope(() => ({ attributes: ['name'] }))
export class Thing extends Model {
  @AllowNull(false) @Column(DataType.STRING) name?: string;
  @Column(DataType.VIRTUAL) get label(): string { return 'x'; }
  @BeforeCreate static trim(thing: Thing) {}
  @Column object!: Record<string, unknown>;
}`);
    expect(warningsMatching(schema, 'allows null')).toHaveLength(1);
    expect(warningsMatching(schema, 'hooks')).toHaveLength(1);
    expect(warningsMatching(schema, 'a default scope, hooks')).toHaveLength(1);
    expect(warningsMatching(schema, 'DataTypes.VIRTUAL')).toHaveLength(1);
    expect(warningsMatching(schema, 'cannot infer a column type')).toHaveLength(
      1
    );
    expect(field(schema, 'Thing', 'name').isNullable).toBe(false);
  });
});

describe('robustness', () => {
  it('warns about syntax errors but keeps what it can read', async () => {
    const schema: IrSchema = await parse(`
sequelize.define('Good', { a: DataTypes.STRING }, { timestamps: false });
const broken = {{{;
`);
    expect(model(schema, 'Good').fields).toHaveLength(2);
    expect(warningsMatching(schema, 'syntax errors')).toHaveLength(1);
  });

  it('skips a model whose name is computed and one whose attributes are', async () => {
    const schema: IrSchema = await parse(`
sequelize.define(name, { a: DataTypes.STRING });
sequelize.define('Dynamic', makeAttributes());
sequelize.define('Partial', { ...makeAttributes(), b: DataTypes.STRING }, { timestamps: false });
sequelize.define('Fine', {}, { timestamps: false });
`);
    expect(schema.models.map((item: IrModel) => item.name)).toEqual([
      'Partial',
      'Fine',
    ]);
    expect(warningsMatching(schema, 'not a string literal')).toHaveLength(1);
    expect(
      warningsMatching(schema, 'could not be read statically')
    ).toHaveLength(1);
    expect(
      warningsMatching(schema, 'some columns may be missing')
    ).toHaveLength(1);
    expect(fieldNames(schema, 'Partial')).toEqual(['id', 'b']);
  });

  it('skips a second model with the same name', async () => {
    const schema: IrSchema = await parse(
      `sequelize.define('Same', { a: DataTypes.STRING }, { timestamps: false });`,
      `sequelize.define('Same', { b: DataTypes.STRING }, { timestamps: false });
sequelize.define('same', {}, { timestamps: false });`
    );
    expect(schema.models.map((item: IrModel) => item.name)).toEqual(['Same']);
    expect(warningsMatching(schema, 'already')).toHaveLength(2);
  });

  it('never throws on hostile input', async () => {
    const inputs: string[] = [
      '\u0000\u0001\u0002 sequelize',
      'sequelize.define(',
      "sequelize.define('X', ".repeat(2000),
      `sequelize.define('X', { a: ${'DataTypes.ARRAY('.repeat(500)}DataTypes.TEXT${')'.repeat(500)} });`,
      `const a = ${'['.repeat(5000)}; sequelize`,
      `class X extends Model {} ${'X.init({}, { sequelize });'.repeat(500)}`,
      `A.hasMany(B);`.repeat(5000) + ' sequelize',
    ];
    for (const text of inputs) {
      const result = await parseSequelize([{ path: 'x.js', text }], {
        appLabel: 'a',
      });
      if (!result.ok) {
        expect(result.error.message.length).toBeGreaterThan(0);
      }
    }
  });
});

describe('canonical fixture', () => {
  it('reads the blog schema', async () => {
    const schema: IrSchema = expectOk(
      await parseSequelize(loadCanonicalSources('sequelize'), {
        appLabel: 'blog',
      })
    );
    expect(schema.warnings).toEqual([]);
    expect(schema.models.map((item: IrModel) => item.tableName).sort()).toEqual(
      ['auth_user', 'blog_category', 'blog_post', 'blog_profile', 'blog_tag']
    );
    expect(relation(schema, 'Post', 'author')).toMatchObject({
      kind: 'foreignKey',
      targetModel: 'User',
      columnName: 'author_id',
      isNullable: false,
      onDelete: 'cascade',
      relatedName: 'posts',
    });
    expect(relation(schema, 'Post', 'editor')).toMatchObject({
      isNullable: true,
      onDelete: 'setNull',
      relatedName: 'editedPosts',
    });
    expect(relation(schema, 'Post', 'category')).toMatchObject({
      isNullable: false,
      onDelete: 'restrict',
    });
    expect(relation(schema, 'Post', 'tags')).toMatchObject({
      kind: 'manyToMany',
      targetModel: 'Tag',
      relatedName: 'posts',
    });
    expect(relation(schema, 'Profile', 'user')).toMatchObject({
      kind: 'oneToOne',
      relatedName: 'profile',
    });
    expect(relation(schema, 'Category', 'parent')).toMatchObject({
      relatedName: 'children',
      onDelete: 'setNull',
    });
    expect(field(schema, 'Post', 'rating')).toMatchObject({
      type: 'decimal',
      maxDigits: 4,
      decimalPlaces: 2,
      isNullable: true,
    });
    expect(field(schema, 'Post', 'publicId')).toMatchObject({
      type: 'uuid',
      isUnique: true,
      columnName: 'public_id',
    });
    expect(schema.enums.map((item: IrEnum) => item.name)).toEqual([
      'PostStatus',
    ]);
    expect(model(schema, 'Post').indexes).toHaveLength(3);
  });
});

describe('extras fixtures', () => {
  const directory: string = fileURLToPath(
    new URL('./fixtures/sequelize-extras', import.meta.url)
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

  function extrasSources(file: string): SequelizeSourceFile[] {
    return [
      {
        path: `${directory}/${file}`,
        text: readFileSync(`${directory}/${file}`, 'utf8'),
      },
    ];
  }

  const FILES: string[] = readdirSync(directory)
    .filter((name: string) => /\.(js|ts)$/.test(name))
    .sort();

  it('has one fixture per style', () => {
    expect(FILES).toEqual(['decorators.ts', 'init-class.ts', 'variants.js']);
  });

  it('reads the variants (defaults, underscored, paranoid, join models, keys, indexes)', async () => {
    const schema: IrSchema = expectOk(
      await parseSequelize(extrasSources('variants.js'), { appLabel: 'shop' })
    );
    expect(
      Object.fromEntries(
        schema.models.map((item: IrModel) => [item.name, item.tableName])
      )
    ).toEqual({
      Account: 'Accounts',
      Person: 'people',
      AuditEntry: 'AuditEntry',
      Group: 'Groups',
      Membership: 'Memberships',
      Order: 'Orders',
      Setting: 'settings',
      Event: 'events',
      Ticket: 'tickets',
      Country: 'countries',
      City: 'cities',
    });
    expect(model(schema, 'Membership').compositePrimaryKey).toEqual([
      'account',
      'group',
    ]);
    expect(fieldNames(schema, 'AuditEntry')).toEqual([
      'id',
      'action',
      'level',
      'logged_at',
    ]);
    expect(relation(schema, 'Order', 'referrer')).toMatchObject({
      toField: 'email',
      onDelete: 'restrict',
    });
    expect(relation(schema, 'Order', 'account').columnName).toBe('AccountId');
    expect(fieldNames(schema, 'Order')).toContain('auditorId');
    expect(relation(schema, 'Person', 'friends').kind).toBe('manyToMany');
  });

  it('reads the class style (init, this.init)', async () => {
    const schema: IrSchema = expectOk(
      await parseSequelize(extrasSources('init-class.ts'), { appLabel: 'shop' })
    );
    expect(schema.models.map((item: IrModel) => item.tableName)).toEqual([
      'authors',
      'books',
    ]);
    expect(relation(schema, 'Book', 'author')).toMatchObject({
      relatedName: 'books',
      onDelete: 'cascade',
      columnName: 'author_id',
    });
    expect(field(schema, 'Author', 'createdAt').isNullable).toBe(true);
  });

  it('reads the sequelize-typescript style', async () => {
    const schema: IrSchema = expectOk(
      await parseSequelize(extrasSources('decorators.ts'), { appLabel: 'shop' })
    );
    expect(schema.models.map((item: IrModel) => item.name).sort()).toEqual([
      'Author',
      'Category',
      'Post',
      'PostTag',
      'Profile',
      'Tag',
    ]);
    expect(model(schema, 'PostTag').compositePrimaryKey).toEqual([
      'post',
      'tag',
    ]);
    expect(relation(schema, 'Profile', 'author').kind).toBe('oneToOne');
  });

  it.each(FILES)(
    'matches the Prisma and warnings goldens for %s',
    async (file: string) => {
      const result: ConvertResult = expectOk(
        await convertText(extrasSources(file), {
          ...DEFAULT_OPTIONS,
          appLabel: 'shop',
          from: 'sequelize',
          to: 'prisma',
        })
      );
      const base: string = file.replace(/\.(js|ts)$/, '');
      expectMatchesExtrasGolden(
        `sequelize-${base}-to-prisma.txt`,
        result.output
      );
      expectMatchesExtrasGolden(
        `sequelize-${base}-warnings.txt`,
        result.warnings.map((warning: string) => `${warning}\n`).join('')
      );
    }
  );
});
