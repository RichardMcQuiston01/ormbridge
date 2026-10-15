import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { convertText, type ConvertResult } from '../src/convert.js';
import {
  emitSequelize,
  isSequelizeStyle,
  SEQUELIZE_STYLES,
  type SequelizeEmitOptions,
  type SequelizeStyle,
} from '../src/emitters/sequelize.js';
import { getFormat, type MultiFileEmitOutput } from '../src/formats.js';
import type {
  IrCompositeForeignKey,
  IrEnum,
  IrField,
  IrModel,
  IrRelation,
  IrSchema,
} from '../src/ir.js';
import { parseSequelize } from '../src/parsers/sequelize.js';
import { checkStyle, OUTPUT_STYLES } from '../src/styles.js';
import { constructsSchema } from './drizzleFixtures.js';
import { CANONICAL_FIXTURES } from './fixtures/canonical.js';
import {
  field,
  idField,
  index,
  kitchenSinkSchema,
  model,
  relation,
  schemaOf,
  stressSchema,
} from './gormFixtures.js';
import {
  convertCanonical,
  expectFilesMatchGolden,
  loadCanonicalSources,
} from './harness.js';
import { DEFAULT_OPTIONS, expectOk } from './helpers.js';
import { compareIr, formatDifference } from './irCompare.js';
import { EXTRA_SOURCES, parseSource } from './realToolSupport.js';

type Provider = SequelizeEmitOptions['provider'];

function emit(
  schema: IrSchema,
  overrides: Partial<SequelizeEmitOptions> = {}
): MultiFileEmitOutput {
  return emitSequelize(structuredClone(schema), {
    provider: 'postgresql',
    naming: 'preserve',
    ...overrides,
  });
}

/** Joins the lines of wrapped objects and calls, so assertions do not depend on where a line was broken. */
function squash(text: string): string {
  return text
    .replace(/\n\s*/g, ' ')
    .replace(/([[(]) /g, '$1')
    .replace(/,\s*([\])])/g, '$1')
    .replace(/,\s*\}/g, ' }');
}

function fileText(output: MultiFileEmitOutput, name: string): string {
  const text: string | undefined = output.files[name];
  if (text === undefined) {
    throw new Error(
      `No file ${name}; the output has ${Object.keys(output.files).join(', ')}.`
    );
  }
  return text;
}

/** The squashed text of the `thing` model file, in the `define` style (JavaScript) unless told otherwise. */
function code(
  schema: IrSchema,
  overrides: Partial<SequelizeEmitOptions> = {},
  name: string = 'thing'
): string {
  const style: SequelizeStyle = overrides.style ?? 'define';
  return squash(
    fileText(
      emit(schema, { ...overrides, style }),
      `${name}.${style === 'init' ? 'ts' : 'js'}`
    )
  );
}

function thing(fields: IrField[], extra: Partial<IrModel> = {}): IrSchema {
  return schemaOf([model('Thing', { tableName: 'things', fields, ...extra })]);
}

const ROLE: IrEnum = {
  name: 'Role',
  values: [
    { name: 'ADMIN', dbValue: 'admin' },
    { name: 'USER', dbValue: 'user' },
  ],
};

/** Reads the output back with the Sequelize parser, the way a user would feed it in. */
async function reread(output: MultiFileEmitOutput): Promise<IrSchema> {
  return expectOk(
    await parseSequelize(
      Object.keys(output.files)
        .sort()
        .map((path: string) => ({ path, text: output.files[path] ?? '' })),
      { appLabel: 'app' }
    )
  );
}

function syntaxErrors(path: string, text: string): string[] {
  const result: ts.TranspileOutput = ts.transpileModule(text, {
    fileName: path,
    reportDiagnostics: true,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      allowJs: true,
    },
  });
  return (result.diagnostics ?? []).map((diagnostic: ts.Diagnostic) =>
    ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')
  );
}

describe('sequelize emitter: layout', () => {
  it('writes one TypeScript file per model and an index in the init style', () => {
    const output: MultiFileEmitOutput = emit(
      schemaOf([model('Author'), model('BlogPost')])
    );
    expect(Object.keys(output.files)).toEqual([
      'author.ts',
      'blogPost.ts',
      'index.ts',
    ]);
    expect(output.warnings).toEqual([]);
    const author: string = fileText(output, 'author.ts');
    expect(author).toContain(
      `import {\n  DataTypes,\n  Model,\n  type CreationOptional,\n  type InferAttributes,\n  type InferCreationAttributes,\n  type Sequelize,\n} from 'sequelize';`
    );
    expect(author).toContain(
      'export class Author extends Model<\n  InferAttributes<Author>,\n  InferCreationAttributes<Author>\n> {'
    );
    expect(author).toContain('declare id: CreationOptional<number>;');
    expect(author).toContain(
      'static initModel(sequelize: Sequelize): typeof Author {'
    );
    expect(author).toContain(
      "{ sequelize, modelName: 'Author', tableName: 'author', timestamps: false }"
    );
    const indexText: string = fileText(output, 'index.ts');
    expect(indexText).toContain("import { Author } from './author.js';");
    expect(indexText).toContain("import { BlogPost } from './blogPost.js';");
    expect(indexText).toContain('export { Author, BlogPost };');
    expect(indexText).toContain(
      'export function initModels(sequelize: Sequelize) {\n  Author.initModel(sequelize);\n  BlogPost.initModel(sequelize);'
    );
    expect(indexText).toContain('return { Author, BlogPost };');
    expect(indexText).toContain(
      'export type Models = ReturnType<typeof initModels>;'
    );
  });

  it('writes the sequelize-cli layout in the define style', () => {
    const output: MultiFileEmitOutput = emit(
      schemaOf([model('Author'), model('BlogPost')]),
      { style: 'define' }
    );
    expect(Object.keys(output.files)).toEqual([
      'author.js',
      'blogPost.js',
      'index.js',
    ]);
    const author: string = fileText(output, 'author.js');
    expect(
      author.startsWith(
        "'use strict';\n\nmodule.exports = (sequelize, DataTypes) => {\n"
      )
    ).toBe(true);
    expect(author).toContain("const Author = sequelize.define(\n    'Author'");
    expect(author).toContain('  return Author;\n};\n');
    expect(author).not.toContain('associate');
    const indexText: string = fileText(output, 'index.js');
    expect(indexText).toContain(
      "Author: require('./author')(sequelize, DataTypes)"
    );
    expect(indexText).toContain('model.associate(models);');
    expect(indexText).toContain('module.exports = { initModels };');
  });

  it('defaults to the init style and writes nothing for an empty schema', () => {
    expect(Object.keys(emit(schemaOf([model('A')])).files)).toContain('a.ts');
    expect(emit(schemaOf([])).files).toEqual({});
    expect(emit(schemaOf([]), { style: 'define' }).files).toEqual({});
  });

  it('recognises the style names', () => {
    expect(SEQUELIZE_STYLES).toEqual(['init', 'define']);
    expect(isSequelizeStyle('define')).toBe(true);
    expect(isSequelizeStyle('sqlmodel')).toBe(false);
    expect(OUTPUT_STYLES).toEqual([
      'sqlalchemy',
      'sqlmodel',
      'init',
      'define',
      'annotations',
      'fluent',
    ]);
  });

  it('checks a style against the target format', () => {
    expect(checkStyle('sequelize', 'define').ok).toBe(true);
    expect(checkStyle('sqlalchemy', 'sqlmodel').ok).toBe(true);
    const wrong = checkStyle('sequelize', 'sqlmodel');
    expect(wrong.ok).toBe(false);
    if (!wrong.ok) {
      expect(wrong.error.message).toBe(
        'Invalid --style value "sqlmodel" for the sequelize format. Expected one of: init, define.'
      );
    }
    // A format without styles ignores the option, but not a value nobody knows.
    expect(checkStyle('prisma', 'init').ok).toBe(true);
    const unknown = checkStyle('prisma', 'peewee');
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) {
      expect(unknown.error.message).toBe(
        'Invalid --style value "peewee". Expected one of: sqlalchemy, sqlmodel, init, define, annotations, fluent (sqlalchemy, sqlmodel for sqlalchemy; init, define for sequelize; annotations, fluent for efcore).'
      );
    }
  });

  it('rejects an unknown or foreign style through the adapter with the valid values', () => {
    const adapter = expectOk(getFormat('sequelize'));
    for (const style of ['peewee', 'sqlmodel']) {
      const result = adapter.emit?.(thing([idField()]), {
        ...DEFAULT_OPTIONS,
        style: style as SequelizeStyle,
      });
      expect(result?.ok).toBe(false);
      if (result !== undefined && !result.ok) {
        expect(result.error.code).toBe('INVALID_OPTION');
        expect(result.error.message).toBe(
          `Invalid style "${style}" for the sequelize format. Expected one of: init, define.`
        );
      }
    }
    const ok = adapter.emit?.(thing([idField()]), {
      ...DEFAULT_OPTIONS,
      style: 'define',
    });
    expect(ok?.ok).toBe(true);
  });

  it('names files after the model in camelCase and keeps them apart from the index', () => {
    const output: MultiFileEmitOutput = emit(
      schemaOf([
        model('PostTags'),
        model('post_tags'),
        model('Index'),
        model('HTTPLog'),
      ])
    );
    expect(Object.keys(output.files).sort()).toEqual([
      'httpLog.ts',
      'index.ts',
      'index2.ts',
      'postTags.ts',
      'postTags2.ts',
    ]);
    expect(fileText(output, 'index2.ts')).toContain('export class Index ');
    expect(fileText(output, 'index.ts')).toContain(
      "import { Index } from './index2.js';"
    );
  });

  it('writes PascalCase class and model names and renames names the files use', () => {
    const output: MultiFileEmitOutput = emit(
      schemaOf([
        model('legacy_order', { tableName: 'LEGACY' }),
        model('Model'),
        model('Models'),
      ])
    );
    const legacy: string = fileText(output, 'legacyOrder.ts');
    expect(legacy).toContain('export class LegacyOrder extends Model<');
    expect(legacy).toContain("modelName: 'LegacyOrder'");
    expect(legacy).toContain("tableName: 'LEGACY'");
    expect(fileText(output, 'modelModel.ts')).toContain(
      "modelName: 'ModelModel'"
    );
    expect(output.warnings).toEqual([
      'Model: "Model" is a name the generated files use, so the class and the model were named "ModelModel".',
      'Models: "Models" is a name the generated files use, so the class and the model were named "ModelsModel".',
    ]);
  });

  it('writes files that are valid TypeScript and JavaScript', () => {
    for (const style of SEQUELIZE_STYLES) {
      for (const naming of ['preserve', 'normalize'] as const) {
        const output: MultiFileEmitOutput = emit(kitchenSinkSchema(), {
          style,
          naming,
          provider: 'sqlite',
        });
        for (const [path, text] of Object.entries(output.files)) {
          expect(
            syntaxErrors(path, text),
            `${style} ${naming} ${path}`
          ).toEqual([]);
        }
      }
    }
  });
});

describe('sequelize emitter: column types', () => {
  const cases: [string, Partial<IrField>, string, string][] = [
    ['a sized string', { maxLength: 80 }, 'DataTypes.STRING(80)', 'string'],
    ['an unsized string', {}, 'DataTypes.TEXT', 'string'],
    ['text', { type: 'text' }, 'DataTypes.TEXT', 'string'],
    ['an int', { type: 'int' }, 'DataTypes.INTEGER', 'number'],
    ['a bigint', { type: 'bigInt' }, 'DataTypes.BIGINT', 'string'],
    ['a float', { type: 'float' }, 'DataTypes.DOUBLE', 'number'],
    [
      'a decimal',
      { type: 'decimal', maxDigits: 8, decimalPlaces: 2 },
      'DataTypes.DECIMAL(8, 2)',
      'string',
    ],
    [
      'a decimal without a scale',
      { type: 'decimal', maxDigits: 8 },
      'DataTypes.DECIMAL(8)',
      'string',
    ],
    [
      'a decimal without precision',
      { type: 'decimal' },
      'DataTypes.DECIMAL',
      'string',
    ],
    ['a boolean', { type: 'boolean' }, 'DataTypes.BOOLEAN', 'boolean'],
    ['a date-time', { type: 'dateTime' }, 'DataTypes.DATE', 'Date'],
    ['a date', { type: 'date' }, 'DataTypes.DATEONLY', 'string'],
    ['a time', { type: 'time' }, 'DataTypes.TIME', 'string'],
    ['a uuid', { type: 'uuid' }, 'DataTypes.UUID', 'string'],
    ['json', { type: 'json' }, 'DataTypes.JSONB', 'unknown'],
    ['bytes', { type: 'bytes' }, 'DataTypes.BLOB', 'Buffer'],
    ['an ip address', { type: 'ipAddress' }, 'DataTypes.INET', 'string'],
    [
      'hstore',
      { type: 'hstore' },
      'DataTypes.HSTORE',
      'Record<string, string | null>',
    ],
    [
      'an array',
      { type: 'string', maxLength: 10, arrayDepth: 1 },
      'DataTypes.ARRAY(DataTypes.STRING(10))',
      'string[]',
    ],
    [
      'a nested array',
      { type: 'int', arrayDepth: 2 },
      'DataTypes.ARRAY(DataTypes.ARRAY(DataTypes.INTEGER))',
      'number[][]',
    ],
    [
      'a range',
      { type: 'range', rangeOf: 'dateTime' },
      'DataTypes.RANGE(DataTypes.DATE)',
      'unknown',
    ],
    [
      'a PostgreSQL-only type',
      { type: 'unsupported', unsupportedType: 'tsvector' },
      'DataTypes.TSVECTOR',
      'unknown',
    ],
  ];

  it.each(cases)(
    'maps %s on PostgreSQL',
    (_label, overrides, expression, tsType) => {
      const schema: IrSchema = thing([
        idField(),
        field('value', { isNullable: true, ...overrides }),
      ]);
      expect(code(schema)).toContain(`value: ${expression}`);
      expect(emit(schema).warnings).toEqual([]);
      const init: string = squash(
        fileText(emit(schema, { style: 'init' }), 'thing.ts')
      );
      expect(init).toContain(
        `declare value: CreationOptional<${tsType} | null>;`
      );
    }
  );

  it('writes a length-limited string for a key and an unsized string as TEXT', () => {
    const text: string = code(
      thing(
        [
          idField(),
          field('code', { isUnique: true }),
          field('slug'),
          field('summary'),
        ],
        { indexes: [index(['slug'])] }
      )
    );
    expect(text).toContain(
      'code: { type: DataTypes.STRING, allowNull: false, unique: true }'
    );
    expect(text).toContain(
      'slug: { type: DataTypes.STRING, allowNull: false }'
    );
    expect(text).toContain(
      'summary: { type: DataTypes.TEXT, allowNull: false }'
    );
  });

  it('reports a column type per dialect', () => {
    const schema: IrSchema = thing([
      idField(),
      field('tags', { type: 'string', maxLength: 5, arrayDepth: 1 }),
      field('doc', { type: 'json' }),
      field('ip', { type: 'ipAddress' }),
      field('span', { type: 'range', rangeOf: 'int' }),
      field('kv', { type: 'hstore' }),
    ]);
    const expected: Record<
      Exclude<Provider, 'mongodb' | 'cockroachdb' | 'postgresql'>,
      string[]
    > = {
      mysql: [
        'tags: { type: DataTypes.JSON, allowNull: false }',
        'doc: { type: DataTypes.JSON, allowNull: false }',
        'ip: { type: DataTypes.STRING(45), allowNull: false }',
        'span: { type: DataTypes.TEXT, allowNull: false }',
        'kv: { type: DataTypes.JSON, allowNull: false }',
      ],
      sqlite: [
        'tags: { type: DataTypes.JSON, allowNull: false }',
        'doc: { type: DataTypes.JSON, allowNull: false }',
        'ip: { type: DataTypes.STRING(45), allowNull: false }',
        'span: { type: DataTypes.TEXT, allowNull: false }',
        'kv: { type: DataTypes.JSON, allowNull: false }',
      ],
      sqlserver: [
        'tags: { type: DataTypes.TEXT, allowNull: false }',
        'doc: { type: DataTypes.TEXT, allowNull: false }',
        'ip: { type: DataTypes.STRING(45), allowNull: false }',
        'span: { type: DataTypes.TEXT, allowNull: false }',
        'kv: { type: DataTypes.TEXT, allowNull: false }',
      ],
    };
    for (const [provider, lines] of Object.entries(expected)) {
      const text: string = code(schema, { provider: provider as Provider });
      for (const line of lines) {
        expect(text, provider).toContain(line);
      }
      const warnings: string[] = emit(schema, {
        provider: provider as Provider,
      }).warnings;
      expect(
        warnings.some((warning: string) => warning.startsWith('Thing.tags:')),
        provider
      ).toBe(true);
      expect(
        warnings.some((warning: string) => warning.startsWith('Thing.span:')),
        provider
      ).toBe(true);
    }
    expect(emit(schema, { provider: 'sqlserver' }).warnings).toContain(
      'Thing.doc: SQL Server has no JSON column type before SQL Server 2025 (Sequelize would create a column of type JSON); the column was written as TEXT.'
    );
    expect(emit(schema, { provider: 'mysql' }).warnings).toContain(
      'Thing.tags: MySQL has no array column type; the array was written as JSON.'
    );
  });

  it('treats CockroachDB like PostgreSQL and warns that MongoDB is not relational', () => {
    const schema: IrSchema = thing([idField(), field('doc', { type: 'json' })]);
    expect(code(schema, { provider: 'cockroachdb' })).toContain(
      'DataTypes.JSONB'
    );
    expect(emit(schema, { provider: 'cockroachdb' }).warnings).toEqual([]);
    const mongo: MultiFileEmitOutput = emit(schema, { provider: 'mongodb' });
    expect(mongo.warnings).toEqual([
      'Provider "mongodb": Sequelize is relational (it has no MongoDB dialect; use Mongoose); PostgreSQL column types were written.',
    ]);
    expect(squash(fileText(mongo, 'thing.ts'))).toContain('DataTypes.JSONB');
  });

  it('writes durations as BIGINT, unknown database types as TEXT, and warns', () => {
    const output: MultiFileEmitOutput = emit(
      thing([
        idField(),
        field('ttl', { type: 'duration' }),
        field('shape', { type: 'unsupported', unsupportedType: 'circle' }),
        field('geo', { type: 'unsupported', unsupportedType: 'geometry' }),
        field('odd', { type: 'mystery' as IrField['type'] }),
      ]),
      { style: 'define', provider: 'mysql' }
    );
    const text: string = squash(fileText(output, 'thing.js'));
    expect(text).toContain('ttl: { type: DataTypes.BIGINT, allowNull: false }');
    expect(text).toContain('shape: { type: DataTypes.TEXT, allowNull: false }');
    expect(text).toContain('geo: { type: DataTypes.TEXT, allowNull: false }');
    expect(text).toContain('odd: { type: DataTypes.TEXT, allowNull: false }');
    expect(output.warnings).toEqual([
      'Thing.ttl: Sequelize has no interval type; the duration was written as BIGINT (microseconds).',
      'Thing.shape: the database type "circle" has no Sequelize data type; the column was written as TEXT.',
      'Thing.geo: the database type "geometry" has no Sequelize data type on MySQL; the column was written as TEXT.',
      'Thing.odd: unknown field type "mystery"; it was written as TEXT.',
    ]);
  });

  it('writes a PostgreSQL geometry column with the data type of the same name', () => {
    const schema: IrSchema = thing([
      idField(),
      field('geo', { type: 'unsupported', unsupportedType: 'geometry' }),
      field('shape', { type: 'unsupported', unsupportedType: 'CITEXT' }),
    ]);
    const text: string = code(schema);
    expect(text).toContain(
      'geo: { type: DataTypes.GEOMETRY, allowNull: false }'
    );
    expect(text).toContain(
      'shape: { type: DataTypes.CITEXT, allowNull: false }'
    );
  });

  it('warns about a generated column and writes it as a regular column', () => {
    const output: MultiFileEmitOutput = emit(
      thing([
        idField(),
        field('total', {
          type: 'int',
          generated: { expression: 'F("a") + F("b")', isStored: true },
        }),
      ])
    );
    expect(output.warnings).toEqual([
      'Thing.total: Sequelize has no generated columns, so the expression F("a") + F("b") was dropped and the column written as a regular one.',
    ]);
    expect(squash(fileText(output, 'thing.ts'))).toContain(
      'total: { type: DataTypes.INTEGER, allowNull: false }'
    );
  });
});

describe('sequelize emitter: primary keys', () => {
  it('marks an auto-increment key and keeps SQLite counting with an INTEGER', () => {
    expect(code(thing([idField()]))).toContain(
      'id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true }'
    );
    expect(code(thing([idField({ type: 'bigInt' })]))).toContain(
      'id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true }'
    );
    expect(
      code(thing([idField({ type: 'bigInt' })]), { provider: 'sqlite' })
    ).toContain(
      'id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true }'
    );
  });

  it('gives a UUID key a generated default and a string key none', () => {
    const text: string = code(
      thing([
        field('id', {
          type: 'uuid',
          isPrimaryKey: true,
          default: { kind: 'uuid' },
        }),
      ])
    );
    expect(text).toContain(
      'id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 }'
    );
    expect(
      code(thing([field('code', { maxLength: 8, isPrimaryKey: true })]))
    ).toContain('code: { type: DataTypes.STRING(8), primaryKey: true }');
  });

  it('writes a composite primary key as primaryKey on every member, relations included', () => {
    const schema: IrSchema = schemaOf([
      model('Account'),
      model('Group'),
      model('Membership', {
        tableName: 'memberships',
        fields: [field('role', { maxLength: 10 })],
        relations: [relation('account', 'Account'), relation('group', 'Group')],
        compositePrimaryKey: ['account', 'group'],
      }),
      model('Pair', {
        tableName: 'pairs',
        fields: [
          field('a', { type: 'int' }),
          field('b', { type: 'int' }),
          field('note', { isNullable: true, maxLength: 5 }),
        ],
        compositePrimaryKey: ['a', 'b'],
      }),
    ]);
    const membership: string = code(schema, {}, 'membership');
    expect(membership).toContain(
      'account_id: { type: DataTypes.INTEGER, primaryKey: true }'
    );
    expect(membership).toContain(
      'group_id: { type: DataTypes.INTEGER, primaryKey: true }'
    );
    const pair: string = code(schema, {}, 'pair');
    expect(pair).toContain('a: { type: DataTypes.INTEGER, primaryKey: true }');
    expect(pair).toContain('b: { type: DataTypes.INTEGER, primaryKey: true }');
    expect(pair).toContain('note: DataTypes.STRING(5)');
  });

  it('writes a key that is a relation as the key of the foreign key column', () => {
    const schema: IrSchema = schemaOf([
      model('Place'),
      model('Restaurant', {
        tableName: 'restaurants',
        fields: [field('menu', { maxLength: 20 })],
        relations: [
          relation('place', 'Place', {
            kind: 'oneToOne',
            isPrimaryKey: true,
            relatedName: 'restaurant',
          }),
        ],
      }),
    ]);
    const restaurant: string = code(schema, {}, 'restaurant');
    expect(restaurant).toContain(
      'place_id: { type: DataTypes.INTEGER, primaryKey: true }'
    );
    expect(restaurant).not.toContain('unique');
    expect(restaurant).toContain(
      "Restaurant.belongsTo(models.Place, { as: 'place', foreignKey: 'place_id', onDelete: 'CASCADE' });"
    );
  });

  it('removes the id Sequelize adds to a model without a key, or marks an id column as the key', () => {
    const noKey: MultiFileEmitOutput = emit(
      thing([field('name', { maxLength: 5 })]),
      { style: 'define' }
    );
    expect(fileText(noKey, 'thing.js')).toContain(
      "Thing.removeAttribute('id');"
    );
    expect(noKey.warnings).toEqual([
      'Thing: the model has no primary key; Sequelize would add an "id" column, so removeAttribute(\'id\') was written. Most Sequelize features need a key.',
    ]);
    const withId: MultiFileEmitOutput = emit(
      thing([field('id', { type: 'int' })]),
      { style: 'define' }
    );
    expect(squash(fileText(withId, 'thing.js'))).toContain(
      'id: { type: DataTypes.INTEGER, primaryKey: true }'
    );
    expect(withId.warnings[0]).toContain(
      '"id" was written with primaryKey: true'
    );
    const init: string = fileText(
      emit(thing([field('name', { maxLength: 5 })])),
      'thing.ts'
    );
    expect(init).toContain("Thing.removeAttribute('id');\n    return Thing;");
  });

  it('warns that an auto-increment default outside a single integer key is dropped', () => {
    const output: MultiFileEmitOutput = emit(
      thing([
        idField(),
        field('counter', { type: 'int', default: { kind: 'autoIncrement' } }),
      ])
    );
    expect(output.warnings).toEqual([
      'Thing.counter: an auto-increment default is only supported on a single integer primary key; it was dropped.',
    ]);
    expect(squash(fileText(output, 'thing.ts'))).toContain(
      'counter: { type: DataTypes.INTEGER, allowNull: false }'
    );
  });
});

describe('sequelize emitter: defaults', () => {
  const defaults: [string, Partial<IrField>, string][] = [
    [
      'a number',
      { type: 'int', default: { kind: 'literal', value: 3 } },
      'defaultValue: 3',
    ],
    [
      'a decimal',
      { type: 'decimal', default: { kind: 'literal', value: 1.5 } },
      'defaultValue: 1.5',
    ],
    [
      'a boolean',
      { type: 'boolean', default: { kind: 'literal', value: false } },
      'defaultValue: false',
    ],
    [
      'a string',
      { maxLength: 9, default: { kind: 'literal', value: 'x' } },
      "defaultValue: 'x'",
    ],
    [
      'a quote',
      { maxLength: 9, default: { kind: 'literal', value: "it's" } },
      'defaultValue: "it\'s"',
    ],
    [
      'an empty string',
      { maxLength: 9, default: { kind: 'literal', value: '' } },
      "defaultValue: ''",
    ],
    [
      'now',
      { type: 'dateTime', default: { kind: 'now' } },
      'defaultValue: DataTypes.NOW',
    ],
    [
      'a UUID',
      { type: 'uuid', default: { kind: 'uuid' } },
      'defaultValue: DataTypes.UUIDV4',
    ],
    [
      'a UUID version 1',
      { type: 'uuid', default: { kind: 'uuid', version: 1 } },
      'defaultValue: DataTypes.UUIDV1',
    ],
    [
      'a JSON object',
      { type: 'json', default: { kind: 'literal', value: '{"a": [1, 2]}' } },
      'defaultValue: { a: [1, 2] }',
    ],
    [
      'an empty JSON array',
      { type: 'json', default: { kind: 'literal', value: '[]' } },
      'defaultValue: []',
    ],
    [
      'a JSON string',
      { type: 'json', default: { kind: 'literal', value: '"x"' } },
      "defaultValue: 'x'",
    ],
    [
      'an empty array column',
      { type: 'int', arrayDepth: 1, default: { kind: 'literal', value: '[]' } },
      'defaultValue: []',
    ],
    [
      'a database expression',
      {
        type: 'dateTime',
        default: {
          kind: 'dbExpression',
          expression: "now() + interval '1 day'",
        },
      },
      `defaultValue: Sequelize.literal("now() + interval '1 day'")`,
    ],
  ];

  it.each(defaults)('writes %s', (_label, overrides, expected) => {
    const schema: IrSchema = thing([idField(), field('value', overrides)]);
    expect(code(schema)).toContain(expected);
  });

  it('imports Sequelize as a value only when a default needs literal()', () => {
    const literal: IrSchema = thing([
      idField(),
      field('at', {
        type: 'dateTime',
        default: { kind: 'dbExpression', expression: 'now()' },
      }),
    ]);
    const init: string = fileText(emit(literal), 'thing.ts');
    expect(init).toContain('  DataTypes,\n  Model,\n  Sequelize,\n');
    expect(init).not.toContain('type Sequelize');
    expect(fileText(emit(literal, { style: 'define' }), 'thing.js')).toContain(
      "const { Sequelize } = require('sequelize');"
    );
    const plain: string = fileText(emit(thing([idField()])), 'thing.ts');
    expect(plain).toContain('  type Sequelize,\n');
    expect(
      fileText(emit(thing([idField()]), { style: 'define' }), 'thing.js')
    ).not.toContain('require(');
  });

  it('warns about defaults it cannot write and drops them', () => {
    const output: MultiFileEmitOutput = emit(
      thing([
        idField(),
        field('a', { default: { kind: 'clientGenerated', generator: 'cuid' } }),
        field('b', { type: 'bytes', default: { kind: 'literal', value: 'x' } }),
        field('c', {
          type: 'int',
          arrayDepth: 1,
          default: { kind: 'literal', value: '{1}' },
        }),
        field('d', { type: 'uuid', default: { kind: 'uuid', version: 7 } }),
      ])
    );
    expect(output.warnings).toEqual([
      'Thing.a: the cuid() default is generated by Prisma Client; Sequelize has no equivalent and the default was dropped.',
      'Thing.b: a literal default on a binary column cannot be written; it was dropped.',
      'Thing.c: the array default {1} cannot be written; it was dropped.',
      'Thing.d: Sequelize generates UUID versions 1 and 4 only; the version 7 default was written as UUIDV4.',
    ]);
    const text: string = squash(fileText(output, 'thing.ts'));
    expect(text).toContain('a: { type: DataTypes.TEXT, allowNull: false }');
    expect(text).toContain(
      'd: { type: DataTypes.UUID, allowNull: false, defaultValue: DataTypes.UUIDV4 }'
    );
  });

  it('makes a column with a default or without NOT NULL optional when creating', () => {
    const text: string = fileText(
      emit(
        thing([
          idField(),
          field('required', { type: 'int' }),
          field('defaulted', {
            type: 'int',
            default: { kind: 'literal', value: 1 },
          }),
          field('nullable', { type: 'int', isNullable: true }),
        ])
      ),
      'thing.ts'
    );
    expect(text).toContain('declare required: number;');
    expect(text).toContain('declare defaulted: CreationOptional<number>;');
    expect(text).toContain(
      'declare nullable: CreationOptional<number | null>;'
    );
  });
});

describe('sequelize emitter: names, uniqueness and indexes', () => {
  it('writes explicit table and column names in preserve mode', () => {
    const output: MultiFileEmitOutput = emit(
      schemaOf([
        model('Legacy', {
          tableName: 'LEGACY_ORDER',
          schema: 'sales',
          fields: [
            field('order_no', {
              columnName: 'OrderNo',
              type: 'int',
              isPrimaryKey: true,
            }),
            field('HTTPCode', { columnName: 'http_code', type: 'int' }),
            field('first-name', {
              columnName: 'first name',
              isNullable: true,
              maxLength: 5,
            }),
          ],
        }),
      ]),
      { style: 'define' }
    );
    const text: string = squash(fileText(output, 'legacy.js'));
    expect(text).toContain(
      "order_no: { type: DataTypes.INTEGER, primaryKey: true, field: 'OrderNo' }"
    );
    expect(text).toContain(
      "HTTPCode: { type: DataTypes.INTEGER, allowNull: false, field: 'http_code' }"
    );
    expect(text).toContain(
      "first_name: { type: DataTypes.STRING(5), field: 'first name' }"
    );
    expect(text).toContain(
      "tableName: 'LEGACY_ORDER', schema: 'sales', timestamps: false"
    );
    expect(output.warnings).toEqual([
      'Legacy.first-name: "first-name" is not a valid JavaScript identifier; it was written as "first_name".',
    ]);
  });

  it('turns on underscored when most camelCase names map onto their snake_case columns', () => {
    const schema: IrSchema = thing([
      idField(),
      field('publicId', { columnName: 'public_id', type: 'int' }),
      field('viewCount', { columnName: 'view_count', type: 'int' }),
      field('odd', { columnName: 'Other', type: 'int' }),
    ]);
    const text: string = code(schema);
    expect(text).toContain(
      'publicId: { type: DataTypes.INTEGER, allowNull: false }'
    );
    expect(text).toContain(
      "odd: { type: DataTypes.INTEGER, allowNull: false, field: 'Other' }"
    );
    expect(text).toContain('underscored: true');
    const plain: string = code(
      thing([idField(), field('view_count', { type: 'int' })])
    );
    expect(plain).not.toContain('underscored');
  });

  it('writes camelCase attributes over snake_case columns in normalize mode', () => {
    const schema: IrSchema = schemaOf([
      model('BlogPost', {
        tableName: 'blog_posts',
        fields: [
          idField(),
          field('view_count', { type: 'int' }),
          field('address_2', { isNullable: true, maxLength: 5 }),
        ],
      }),
    ]);
    const text: string = code(schema, { naming: 'normalize' }, 'blogPost');
    expect(text).toContain("tableName: 'blog_post'");
    expect(text).toContain('underscored: true');
    expect(text).toContain(
      'viewCount: { type: DataTypes.INTEGER, allowNull: false }'
    );
    expect(text).toContain(
      "address2: { type: DataTypes.STRING(5), field: 'address_2' }"
    );
    // The key becomes a UUID, as in the other normalized output.
    expect(text).toContain(
      'id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 }'
    );
    // created_at and updated_at are added, and are Sequelize's timestamps: the define style leaves them out.
    expect(text).toContain('timestamps: true');
    expect(text).not.toContain('createdAt');
    expect(
      squash(fileText(emit(schema, { naming: 'normalize' }), 'blogPost.ts'))
    ).toContain('createdAt: { type: DataTypes.DATE, allowNull: false }');
  });

  it('writes unique columns, named unique constraints and composite unique indexes', () => {
    const text: string = code(
      thing(
        [
          idField(),
          field('email', { maxLength: 50, isUnique: true }),
          field('code', {
            maxLength: 5,
            isUnique: true,
            uniqueName: 'things_code_key',
          }),
          field('a', { type: 'int' }),
          field('b', { type: 'int' }),
        ],
        {
          indexes: [
            index(['a', 'b'], { isUnique: true, name: 'things_a_b' }),
            index(['a']),
          ],
        }
      )
    );
    expect(text).toContain(
      'email: { type: DataTypes.STRING(50), allowNull: false, unique: true }'
    );
    expect(text).toContain(
      "code: { type: DataTypes.STRING(5), allowNull: false, unique: 'things_code_key' }"
    );
    expect(text).toContain(
      "indexes: [{ name: 'things_a_b', unique: true, fields: ['a', 'b'] }, { fields: ['a'] }]"
    );
  });

  it('maps relation names in an index to their columns and skips an unknown field', () => {
    const schema: IrSchema = schemaOf([
      model('Owner'),
      model('Thing', {
        tableName: 'things',
        fields: [
          idField(),
          field('title', { columnName: 'Title', maxLength: 5 }),
        ],
        relations: [relation('owner', 'Owner')],
        indexes: [index(['owner', 'title']), index(['ghost'])],
      }),
    ]);
    const output: MultiFileEmitOutput = emit(schema, { style: 'define' });
    expect(squash(fileText(output, 'thing.js'))).toContain(
      "indexes: [{ fields: ['owner_id', 'Title'] }]"
    );
    expect(output.warnings).toEqual([
      'Thing index (ghost): "ghost" is not a column of the model; the index was skipped.',
    ]);
  });

  it('writes index methods, sort orders, prefix lengths and operator classes', () => {
    const schema: IrSchema = thing(
      [
        idField(),
        field('title', { maxLength: 50 }),
        field('doc', { type: 'json' }),
      ],
      {
        indexes: [
          index(['doc'], {
            method: 'Gin',
            fieldOptions: { doc: { ops: 'jsonb_path_ops' } },
          }),
          index(['title'], {
            name: 'by_title',
            fieldOptions: { title: { sort: 'desc', length: 10 } },
          }),
          index(['title'], { method: 'SpGist' }),
        ],
      }
    );
    const text: string = code(schema);
    expect(text).toContain(
      "{ using: 'GIN', fields: [{ name: 'doc', operator: 'jsonb_path_ops' }] }"
    );
    expect(text).toContain(
      "{ name: 'by_title', fields: [{ name: 'title', order: 'DESC', length: 10 }] }"
    );
    expect(text).toContain("{ using: 'SPGIST', fields: ['title'] }");
  });

  it('keeps index methods and full-text indexes to the dialects that have them', () => {
    const schema: IrSchema = thing(
      [idField(), field('body', { type: 'text' })],
      {
        indexes: [
          index(['body'], { kind: 'fulltext' }),
          index(['body'], { method: 'Hash' }),
          index(['body'], { method: 'Weird' }),
          index(['body'], { clustered: true }),
        ],
      }
    );
    const mysql: MultiFileEmitOutput = emit(schema, {
      provider: 'mysql',
      style: 'define',
    });
    const mysqlText: string = squash(fileText(mysql, 'thing.js'));
    expect(mysqlText).toContain("{ type: 'FULLTEXT', fields: ['body'] }");
    expect(mysqlText).toContain("{ using: 'HASH', fields: ['body'] }");
    const sqlite: MultiFileEmitOutput = emit(schema, {
      provider: 'sqlite',
      style: 'define',
    });
    const sqliteText: string = squash(fileText(sqlite, 'thing.js'));
    expect(sqliteText).not.toContain('FULLTEXT');
    expect(sqliteText).not.toContain('using');
    expect(sqlite.warnings).toEqual([
      'Thing index (body): full-text indexes are a MySQL feature in Sequelize; it was written as an ordinary index.',
      'Thing index (body): SQLite has no index methods; USING HASH was dropped.',
      'Thing index (body): the index method "Weird" is not known to Sequelize and was dropped.',
      'Thing index (body): clustered and non-clustered options have no Sequelize equivalent and were dropped.',
    ]);
  });
});

describe('sequelize emitter: timestamps', () => {
  const stamps: IrField[] = [
    field('created_at', { type: 'dateTime', default: { kind: 'now' } }),
    field('updated_at', { type: 'dateTime', isAutoUpdated: true }),
  ];

  it('maps required created and updated columns onto the timestamps option', () => {
    const define: string = code(thing([idField(), ...stamps]));
    expect(define).toContain(
      "tableName: 'things', timestamps: true, createdAt: 'created_at', updatedAt: 'updated_at'"
    );
    // The define style leaves the columns to Sequelize; the init style lists them for the types.
    expect(define).not.toContain('created_at:');
    const init: string = squash(
      fileText(emit(thing([idField(), ...stamps])), 'thing.ts')
    );
    expect(init).toContain(
      'created_at: { type: DataTypes.DATE, allowNull: false }'
    );
    expect(init).toContain(
      'declare readonly created_at: CreationOptional<Date>;'
    );
  });

  it('uses Sequelize default names without an option', () => {
    const text: string = code(
      thing([
        idField(),
        field('createdAt', { type: 'dateTime' }),
        field('updatedAt', { type: 'dateTime', isAutoUpdated: true }),
      ])
    );
    expect(text).toContain("tableName: 'things', timestamps: true");
    expect(text).not.toContain('createdAt');
  });

  it('turns off the timestamp that is missing and disables timestamps when both are', () => {
    expect(code(thing([idField(), stamps[0] as IrField]))).toContain(
      "timestamps: true, createdAt: 'created_at', updatedAt: false"
    );
    expect(code(thing([idField(), stamps[1] as IrField]))).toContain(
      "timestamps: true, createdAt: false, updatedAt: 'updated_at'"
    );
    expect(code(thing([idField()]))).toContain('timestamps: false');
  });

  it('declares a timestamp that Sequelize could not create exactly', () => {
    const text: string = code(
      thing([
        idField(),
        field('created_at', {
          type: 'dateTime',
          default: { kind: 'dbExpression', expression: 'clock_timestamp()' },
        }),
        field('updated_at', {
          type: 'dateTime',
          isAutoUpdated: true,
          isNullable: true,
        }),
      ])
    );
    expect(text).toContain(
      "created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('clock_timestamp()') }"
    );
    expect(text).toContain('updated_at: DataTypes.DATE');
    expect(text).toContain(
      "timestamps: true, createdAt: 'created_at', updatedAt: 'updated_at'"
    );
  });

  it('writes a plain column, with a warning, for an auto-updated column that is not a date-time', () => {
    const output: MultiFileEmitOutput = emit(
      thing([idField(), field('touched', { type: 'int', isAutoUpdated: true })])
    );
    expect(output.warnings).toEqual([
      "Thing.touched: only a date-time column can be Sequelize's updatedAt; it was written as a plain column that the application has to refresh.",
    ]);
    expect(squash(fileText(output, 'thing.ts'))).toContain('timestamps: false');
  });

  it('does not take a column that is a key or has another name for a timestamp', () => {
    const text: string = code(
      thing([
        idField(),
        field('published_at', { type: 'dateTime', default: { kind: 'now' } }),
        field('created_on', { type: 'dateTime', isUnique: true }),
      ])
    );
    expect(text).toContain('timestamps: false');
    expect(text).toContain(
      'published_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW }'
    );
  });
});

describe('sequelize emitter: relations', () => {
  const author: IrModel = model('Author', { tableName: 'authors' });

  function post(overrides: Partial<IrRelation> = {}): IrSchema {
    return schemaOf([
      author,
      model('Post', {
        tableName: 'posts',
        relations: [
          relation('author', 'Author', { relatedName: 'posts', ...overrides }),
        ],
      }),
    ]);
  }

  it('writes the foreign key column and both sides of a foreign key', () => {
    const output: MultiFileEmitOutput = emit(post(), { style: 'define' });
    expect(squash(fileText(output, 'post.js'))).toContain(
      'author_id: { type: DataTypes.INTEGER, allowNull: false }'
    );
    expect(squash(fileText(output, 'post.js'))).toContain(
      "Post.belongsTo(models.Author, { as: 'author', foreignKey: 'author_id', onDelete: 'CASCADE' });"
    );
    expect(squash(fileText(output, 'author.js'))).toContain(
      "Author.hasMany(models.Post, { as: 'posts', foreignKey: 'author_id', onDelete: 'CASCADE' });"
    );
    const init: string = fileText(emit(post()), 'author.ts');
    expect(init).toContain("import type { Post } from './post.js';");
    expect(init).toContain('declare posts?: NonAttribute<Post[]>;');
    expect(fileText(emit(post()), 'post.ts')).toContain(
      'declare author?: NonAttribute<Author>;'
    );
    const indexText: string = squash(fileText(emit(post()), 'index.ts'));
    expect(indexText).toContain(
      "Post.belongsTo(Author, { as: 'author', foreignKey: 'author_id', onDelete: 'CASCADE' }); Author.hasMany(Post, { as: 'posts', foreignKey: 'author_id', onDelete: 'CASCADE' });"
    );
  });

  it('leaves the reverse side out when the relation has no related name', () => {
    const schema: IrSchema = post({ relatedName: undefined });
    const output: MultiFileEmitOutput = emit(schema, { style: 'define' });
    expect(fileText(output, 'author.js')).not.toContain('associate');
    expect(fileText(output, 'post.js')).toContain('Post.associate');
  });

  it('writes every referential action and the nullable column', () => {
    const actions: [IrRelation['onDelete'], string][] = [
      ['cascade', 'CASCADE'],
      ['setNull', 'SET NULL'],
      ['restrict', 'RESTRICT'],
      ['noAction', 'NO ACTION'],
      ['setDefault', 'SET DEFAULT'],
    ];
    for (const [action, sql] of actions) {
      const text: string = code(
        post({ onDelete: action, isNullable: true }),
        {},
        'post'
      );
      expect(text, action).toContain(`onDelete: '${sql}'`);
      expect(text, action).toContain('author_id: DataTypes.INTEGER');
    }
    const updated: string = code(post({ onUpdate: 'restrict' }), {}, 'post');
    expect(updated).toContain("onDelete: 'CASCADE', onUpdate: 'RESTRICT'");
    // ON UPDATE CASCADE is what Sequelize adds anyway.
    expect(code(post({ onUpdate: 'cascade' }), {}, 'post')).not.toContain(
      'onUpdate'
    );
  });

  it('warns that SET NULL on a required relation fails', () => {
    expect(emit(post({ onDelete: 'setNull' })).warnings).toEqual([
      'Post.author: onDelete SET NULL on a required relation will fail at the database level; review the relation.',
    ]);
  });

  it('writes a one-to-one relation as a unique column with hasOne', () => {
    const output: MultiFileEmitOutput = emit(
      post({ kind: 'oneToOne', relatedName: 'post' }),
      { style: 'define' }
    );
    expect(squash(fileText(output, 'post.js'))).toContain(
      'author_id: { type: DataTypes.INTEGER, allowNull: false, unique: true }'
    );
    expect(squash(fileText(output, 'author.js'))).toContain(
      "Author.hasOne(models.Post, { as: 'post', foreignKey: 'author_id', onDelete: 'CASCADE' });"
    );
  });

  it('takes the column type from the key it references, including a key that is a relation', () => {
    const schema: IrSchema = schemaOf([
      model('Code', {
        tableName: 'codes',
        fields: [field('code', { type: 'uuid', isPrimaryKey: true })],
      }),
      model('Child', {
        tableName: 'children',
        fields: [],
        relations: [
          relation('code', 'Code', { kind: 'oneToOne', isPrimaryKey: true }),
        ],
      }),
      model('Leaf', {
        tableName: 'leaves',
        relations: [relation('child', 'Child')],
      }),
    ]);
    const output: MultiFileEmitOutput = emit(schema, { style: 'define' });
    expect(squash(fileText(output, 'child.js'))).toContain(
      'code_id: { type: DataTypes.UUID, primaryKey: true }'
    );
    expect(squash(fileText(output, 'leaf.js'))).toContain(
      'child_id: { type: DataTypes.UUID, allowNull: false }'
    );
  });

  it('points at a column other than the primary key with targetKey and sourceKey', () => {
    const schema: IrSchema = schemaOf([
      model('Account', {
        tableName: 'accounts',
        fields: [idField(), field('slug', { maxLength: 12, isUnique: true })],
      }),
      model('Note', {
        tableName: 'notes',
        relations: [
          relation('account', 'Account', {
            toField: 'slug',
            relatedName: 'notes',
          }),
        ],
      }),
    ]);
    const output: MultiFileEmitOutput = emit(schema, { style: 'define' });
    expect(squash(fileText(output, 'note.js'))).toContain(
      'account_id: { type: DataTypes.STRING(12), allowNull: false }'
    );
    expect(squash(fileText(output, 'note.js'))).toContain("targetKey: 'slug'");
    expect(squash(fileText(output, 'account.js'))).toContain(
      "sourceKey: 'slug'"
    );
  });

  it('writes a self reference and tells apart two relations to the same model', () => {
    const schema: IrSchema = schemaOf([
      model('User', { tableName: 'users' }),
      model('Category', {
        tableName: 'categories',
        relations: [
          relation('parent', 'Category', {
            isNullable: true,
            onDelete: 'setNull',
            relatedName: 'children',
          }),
        ],
      }),
      model('Post', {
        tableName: 'posts',
        relations: [
          relation('author', 'User', { relatedName: 'posts' }),
          relation('editor', 'User', {
            isNullable: true,
            onDelete: 'setNull',
            relatedName: 'edited_posts',
          }),
        ],
      }),
    ]);
    const output: MultiFileEmitOutput = emit(schema);
    const indexText: string = squash(fileText(output, 'index.ts'));
    expect(indexText).toContain(
      "Category.belongsTo(Category, { as: 'parent', foreignKey: 'parent_id', onDelete: 'SET NULL' });"
    );
    expect(indexText).toContain(
      "Category.hasMany(Category, { as: 'children', foreignKey: 'parent_id', onDelete: 'SET NULL' });"
    );
    expect(indexText).toContain(
      "Post.belongsTo(User, { as: 'author', foreignKey: 'author_id', onDelete: 'CASCADE' });"
    );
    expect(indexText).toContain(
      "Post.belongsTo(User, { as: 'editor', foreignKey: 'editor_id', onDelete: 'SET NULL' });"
    );
    expect(indexText).toContain(
      "User.hasMany(Post, { as: 'edited_posts', foreignKey: 'editor_id', onDelete: 'SET NULL' });"
    );
  });

  it('keeps an alias away from the names of columns and other aliases', () => {
    const schema: IrSchema = schemaOf([
      model('Author', {
        tableName: 'authors',
        fields: [idField(), field('posts', { maxLength: 5 })],
      }),
      model('Post', {
        tableName: 'posts',
        relations: [
          relation('author', 'Author', {
            columnName: 'author',
            relatedName: 'posts',
          }),
        ],
      }),
    ]);
    const output: MultiFileEmitOutput = emit(schema, { style: 'define' });
    // The column keeps its name; the attribute gets a suffix so the alias can have the relation's name.
    expect(squash(fileText(output, 'post.js'))).toContain(
      'author: { type: DataTypes.INTEGER, allowNull: false }'
    );
    expect(squash(fileText(output, 'post.js'))).toContain("as: 'author2'");
    expect(squash(fileText(output, 'author.js'))).toContain("as: 'posts2'");
  });

  it('uses camelCase aliases and keys in normalize mode', () => {
    const schema: IrSchema = schemaOf([
      model('User', { tableName: 'users' }),
      model('Post', {
        tableName: 'posts',
        relations: [
          relation('edited_by', 'User', { relatedName: 'edited_posts' }),
        ],
      }),
    ]);
    const text: string = squash(
      fileText(
        emit(schema, { naming: 'normalize', style: 'define' }),
        'post.js'
      )
    );
    expect(text).toContain(
      'editedById: { type: DataTypes.UUID, allowNull: false }'
    );
    expect(text).toContain(
      "Post.belongsTo(models.User, { as: 'editedBy', foreignKey: 'editedById', onDelete: 'CASCADE' });"
    );
    expect(
      squash(
        fileText(
          emit(schema, { naming: 'normalize', style: 'define' }),
          'user.js'
        )
      )
    ).toContain("as: 'editedPosts'");
  });

  it('skips a relation to a missing model or to a model without a single key, and warns', () => {
    const schema: IrSchema = schemaOf([
      model('Pair', {
        tableName: 'pairs',
        fields: [field('a', { type: 'int' }), field('b', { type: 'int' })],
        compositePrimaryKey: ['a', 'b'],
      }),
      model('Thing', {
        tableName: 'things',
        relations: [relation('ghost', 'Nowhere'), relation('pair', 'Pair')],
      }),
    ]);
    const output: MultiFileEmitOutput = emit(schema, { style: 'define' });
    expect(output.warnings).toEqual([
      'Thing.ghost: target model "Nowhere" does not exist in the schema; the relation was skipped.',
      'Thing.pair: target model "Pair" has no single-column primary key to reference; the relation was skipped.',
    ]);
    expect(fileText(output, 'thing.js')).not.toContain('associate');
  });

  it('warns about a composite foreign key and keeps its columns', () => {
    const composite: IrCompositeForeignKey = {
      name: 'order',
      targetModel: 'Order',
      fields: ['region', 'number'],
      references: ['region', 'number'],
      kind: 'foreignKey',
      isNullable: false,
      onDelete: 'cascade',
    };
    const output: MultiFileEmitOutput = emit(
      schemaOf([
        model('Order', {
          tableName: 'orders',
          fields: [
            field('region', { maxLength: 2, isPrimaryKey: true }),
            field('number', { type: 'int' }),
          ],
        }),
        model('Line', {
          tableName: 'lines',
          fields: [
            idField(),
            field('region', { maxLength: 2 }),
            field('number', { type: 'int' }),
          ],
          compositeForeignKeys: [composite],
        }),
      ])
    );
    expect(output.warnings).toEqual([
      'Line.order: the composite foreign key (region, number) to Order(region, number) has no equivalent here; the relation was dropped and the columns kept as plain fields.',
    ]);
  });
});

describe('sequelize emitter: many-to-many', () => {
  const tag: IrModel = model('Tag', { tableName: 'tags' });
  const post: IrModel = model('Post', {
    tableName: 'posts',
    relations: [
      relation('tags', 'Tag', { kind: 'manyToMany', relatedName: 'posts' }),
    ],
  });

  it('writes both halves over a join table that Sequelize creates', () => {
    const output: MultiFileEmitOutput = emit(schemaOf([post, tag]), {
      style: 'define',
    });
    expect(squash(fileText(output, 'post.js'))).toContain(
      "Post.belongsToMany(models.Tag, { as: 'tags', through: 'posts_tags', foreignKey: 'post_id', otherKey: 'tag_id', timestamps: false });"
    );
    expect(squash(fileText(output, 'tag.js'))).toContain(
      "Tag.belongsToMany(models.Post, { as: 'posts', through: 'posts_tags', foreignKey: 'tag_id', otherKey: 'post_id', timestamps: false });"
    );
    const init: string = fileText(emit(schemaOf([post, tag])), 'post.ts');
    expect(init).toContain('declare tags?: NonAttribute<Tag[]>;');
  });

  it('writes only the owner half when the relation has no related name', () => {
    const lonely: IrModel = {
      ...post,
      relations: [relation('tags', 'Tag', { kind: 'manyToMany' })],
    };
    const output: MultiFileEmitOutput = emit(schemaOf([lonely, tag]), {
      style: 'define',
    });
    expect(fileText(output, 'post.js')).toContain('belongsToMany');
    expect(fileText(output, 'tag.js')).not.toContain('belongsToMany');
  });

  it('keeps the owner first when the target comes first in the schema', () => {
    const indexText: string = squash(
      fileText(emit(schemaOf([tag, post])), 'index.ts')
    );
    expect(indexText.indexOf('Post.belongsToMany(Tag')).toBeLessThan(
      indexText.indexOf('Tag.belongsToMany(Post')
    );
  });

  it('names the keys of a self-referencing relation from and to', () => {
    const person: IrModel = model('Person', {
      tableName: 'people',
      relations: [
        relation('friends', 'Person', {
          kind: 'manyToMany',
          relatedName: 'friend_of',
        }),
      ],
    });
    const text: string = squash(
      fileText(emit(schemaOf([person]), { style: 'define' }), 'person.js')
    );
    expect(text).toContain(
      "Person.belongsToMany(models.Person, { as: 'friends', through: 'people_friends', foreignKey: 'from_person_id', otherKey: 'to_person_id', timestamps: false });"
    );
    expect(text).toContain(
      "Person.belongsToMany(models.Person, { as: 'friend_of', through: 'people_friends', foreignKey: 'to_person_id', otherKey: 'from_person_id', timestamps: false });"
    );
  });

  it('warns and skips a many-to-many between models without a single key', () => {
    const pair: IrModel = model('Pair', {
      tableName: 'pairs',
      fields: [field('a', { type: 'int' }), field('b', { type: 'int' })],
      compositePrimaryKey: ['a', 'b'],
      relations: [relation('tags', 'Tag', { kind: 'manyToMany' })],
    });
    expect(emit(schemaOf([pair, tag])).warnings).toEqual([
      'Pair.tags: a many-to-many relation needs a single-column primary key on both models; the relation was skipped.',
    ]);
  });
});

describe('sequelize emitter: enums', () => {
  const schema: IrSchema = schemaOf(
    [
      model('Member', {
        tableName: 'members',
        fields: [
          idField(),
          field('role', {
            enumName: 'Role',
            maxLength: 10,
            default: { kind: 'enumValue', value: 'USER' },
          }),
          field('old_role', { enumName: 'Role', isNullable: true }),
          field('roles', { enumName: 'Role', arrayDepth: 1 }),
        ],
      }),
    ],
    [ROLE]
  );

  it('writes the stored values inline, the default by value and a union type', () => {
    const text: string = code(schema, {}, 'member');
    expect(text).toContain(
      "role: { type: DataTypes.ENUM('admin', 'user'), allowNull: false, defaultValue: 'user' }"
    );
    expect(text).toContain("old_role: DataTypes.ENUM('admin', 'user')");
    expect(text).toContain(
      "roles: { type: DataTypes.ARRAY(DataTypes.ENUM('admin', 'user')), allowNull: false }"
    );
    const init: string = fileText(emit(schema), 'member.ts');
    expect(init).toContain("declare role: CreationOptional<'admin' | 'user'>;");
    expect(init).toContain("declare roles: ('admin' | 'user')[];");
  });

  it('writes the default of an enum field given as a literal or as a stored value', () => {
    const literal: IrSchema = schemaOf(
      [
        model('Member', {
          tableName: 'members',
          fields: [
            idField(),
            field('role', {
              enumName: 'Role',
              default: { kind: 'literal', value: 'admin' },
            }),
            field('other', {
              enumName: 'Role',
              default: { kind: 'enumValue', value: 'gone' },
            }),
          ],
        }),
      ],
      [ROLE]
    );
    const output: MultiFileEmitOutput = emit(literal, { style: 'define' });
    const text: string = squash(fileText(output, 'member.js'));
    expect(text).toContain("defaultValue: 'admin'");
    expect(text).toContain("defaultValue: 'gone'");
    expect(output.warnings).toEqual([
      'Member.other: the enum default "gone" does not match a member of the enum; it was written as a string.',
    ]);
  });

  it('writes an enum on SQL Server as a string, because Sequelize drops NOT NULL and the default there', () => {
    const output: MultiFileEmitOutput = emit(schema, {
      provider: 'sqlserver',
      style: 'define',
    });
    const text: string = squash(fileText(output, 'member.js'));
    expect(text).toContain(
      "role: { type: DataTypes.STRING, allowNull: false, defaultValue: 'user' }"
    );
    expect(output.warnings[0]).toBe(
      "Member.role: Sequelize's ENUM for SQL Server drops NOT NULL and the default; the column was written as STRING and the values are only used for typing."
    );
    expect(
      squash(fileText(emit(schema, { provider: 'sqlserver' }), 'member.ts'))
    ).toContain("declare role: CreationOptional<'admin' | 'user'>;");
  });

  it('writes a plain string for an enum that does not exist and warns', () => {
    const output: MultiFileEmitOutput = emit(
      thing([idField(), field('role', { enumName: 'Missing', maxLength: 5 })])
    );
    expect(output.warnings).toEqual([
      'Thing.role: enum "Missing" does not exist in the schema; the column was written as a plain string.',
    ]);
    expect(squash(fileText(output, 'thing.ts'))).toContain(
      'role: { type: DataTypes.STRING(5), allowNull: false }'
    );
  });
});

describe('sequelize emitter: constructs it cannot write', () => {
  it('warns about the Prisma-only constructs the other emitters warn about', () => {
    const output: MultiFileEmitOutput = emit(
      schemaOf(
        [
          model('Scratch', { isIgnored: true }),
          model('Report', {
            isView: true,
            fields: [
              field('id', { type: 'int' }),
              field('total', { type: 'int' }),
            ],
          }),
          model('Plain', {
            fields: [idField(), field('hidden', { isIgnored: true })],
          }),
        ],
        [{ ...ROLE, schema: 'auth' }]
      )
    );
    expect(output.warnings).toEqual([
      'enum Role: the database schema "auth" (@@schema) was ignored.',
      'Scratch: @@ignore has no equivalent here; the model was written as a normal model.',
      'Plain.hidden: @ignore has no equivalent here; the field was written as a normal field.',
      'Report: this is a database view; it was written as a model of the same name, but Sequelize cannot define a view, so sync() would create a table instead.',
      'Report: the model has no primary key, and Sequelize refuses a model with an "id" column that is not one; "id" was written with primaryKey: true.',
    ]);
  });

  it('does not throw for names that are not identifiers', () => {
    const output: MultiFileEmitOutput = emit(
      schemaOf([
        model('9 lives', {
          tableName: 'lives',
          fields: [
            idField(),
            field('1st', { type: 'int' }),
            field('', { type: 'int', columnName: 'blank' }),
          ],
        }),
      ])
    );
    for (const [path, text] of Object.entries(output.files)) {
      expect(syntaxErrors(path, text)).toEqual([]);
    }
    expect(output.warnings.length).toBeGreaterThan(0);
  });
});

describe('sequelize emitter: reading the output back', () => {
  it('reads what it wrote as the same schema for a blog-like schema', async () => {
    const schema: IrSchema = schemaOf(
      [
        model('User', { tableName: 'auth_user' }),
        model('Tag', {
          tableName: 'tags',
          fields: [idField(), field('label', { maxLength: 20 })],
        }),
        model('Post', {
          tableName: 'blog_post',
          fields: [
            idField(),
            field('created_at', { type: 'dateTime' }),
            field('updated_at', { type: 'dateTime', isAutoUpdated: true }),
            field('title', { maxLength: 100 }),
            field('status', {
              enumName: 'Role',
              default: { kind: 'enumValue', value: 'USER' },
            }),
            field('rating', {
              type: 'decimal',
              maxDigits: 4,
              decimalPlaces: 2,
              isNullable: true,
            }),
            field('meta', {
              type: 'json',
              default: { kind: 'literal', value: '{}' },
            }),
            field('public_id', {
              type: 'uuid',
              isUnique: true,
              default: { kind: 'uuid' },
            }),
          ],
          relations: [
            relation('author', 'User', { relatedName: 'posts' }),
            relation('editor', 'User', {
              isNullable: true,
              onDelete: 'setNull',
              relatedName: 'edited',
            }),
            relation('tags', 'Tag', {
              kind: 'manyToMany',
              relatedName: 'posts',
            }),
          ],
          indexes: [
            index(['title']),
            index(['author', 'title'], {
              isUnique: true,
              name: 'author_title',
            }),
          ],
        }),
      ],
      [ROLE]
    );
    for (const style of SEQUELIZE_STYLES) {
      const output: MultiFileEmitOutput = emit(schema, { style });
      const parsed: IrSchema = await reread(output);
      expect(compareIr(schema, parsed).map(formatDifference), style).toEqual([
        'fieldEnum Post.status: Role -> PostStatus',
        'enumRemoved Role: enum Role -> (absent)',
        'enumAdded PostStatus: (absent) -> enum PostStatus',
      ]);
      expect(parsed.warnings, style).toEqual([]);
    }
  });

  it('reads the Sequelize fixtures back unchanged, in both styles', async () => {
    const extras: string[] = [
      'decorators.ts',
      'init-class.ts',
      'variants.js',
    ].map((name: string) =>
      fileURLToPath(
        new URL(`./fixtures/sequelize-extras/${name}`, import.meta.url)
      )
    );
    const groups: string[][] = [
      CANONICAL_FIXTURES.find((fixture) => fixture.format === 'sequelize')
        ?.paths ?? [],
      ...extras.map((path: string) => [path]),
    ];
    for (const paths of groups) {
      const before: IrSchema = expectOk(
        await parseSequelize(
          paths.map((path: string) => ({
            path,
            text: readFileSync(path, 'utf8'),
          })),
          { appLabel: 'app' }
        )
      );
      for (const style of SEQUELIZE_STYLES) {
        const output: MultiFileEmitOutput = emit(before, { style });
        const after: IrSchema = await reread(output);
        expect(
          compareIr(before, after).map(formatDifference),
          `${paths.join('')} ${style}`
        ).toEqual([]);
      }
    }
  });

  it('converts through convertText in both styles and keeps the model count', async () => {
    for (const style of SEQUELIZE_STYLES) {
      const result: ConvertResult = expectOk(
        await convertText(loadCanonicalSources('prisma'), {
          ...DEFAULT_OPTIONS,
          from: 'prisma',
          to: 'sequelize',
          style,
        })
      );
      expect(result.output).toBe('');
      expect(Object.keys(result.files ?? {}).length).toBe(
        result.modelCount + 1
      );
    }
  });
});

describe('sequelize emitter: golden files', () => {
  const goldenRoot: string = fileURLToPath(
    new URL('./golden-extras/', import.meta.url)
  );

  // The default (init style) conversions live in test/golden/<format>-to-sequelize.<naming>/
  // (conversion.test.ts). The define style output of every canonical schema is checked here.
  describe.each(
    CANONICAL_FIXTURES.map((fixture) => fixture.format).filter(
      (format: string) => format !== 'sequelize'
    )
  )('%s source in the define style', (format) => {
    it('matches the golden output', async () => {
      const files: Record<string, string> = {};
      for (const naming of ['preserve', 'normalize'] as const) {
        const result: ConvertResult = await convertCanonical(
          format,
          'sequelize',
          {
            naming,
            style: 'define',
          }
        );
        for (const [path, text] of Object.entries(result.files ?? {})) {
          files[`${naming}/${path}`] = text;
        }
        files[`${naming}.warnings.txt`] = `${result.warnings.join('\n')}\n`;
      }
      expectFilesMatchGolden(
        `sequelize-define/${format}-to-sequelize`,
        files,
        goldenRoot
      );
    });
  });

  const sequelizeSources: [string, string[]][] = [
    [
      'sequelize-canonical',
      CANONICAL_FIXTURES.find((fixture) => fixture.format === 'sequelize')
        ?.paths ?? [],
    ],
    ...['decorators.ts', 'init-class.ts', 'variants.js'].map(
      (name: string): [string, string[]] => [
        `sequelize-${name.replace(/\.[jt]s$/, '')}`,
        [
          fileURLToPath(
            new URL(`./fixtures/sequelize-extras/${name}`, import.meta.url)
          ),
        ],
      ]
    ),
  ];

  const fixtures: [string, () => Promise<IrSchema>, Provider][] = [
    ['kitchen-sink', () => Promise.resolve(kitchenSinkSchema()), 'sqlite'],
    ['stress', () => Promise.resolve(stressSchema()), 'sqlite'],
    ['constructs', () => Promise.resolve(constructsSchema()), 'postgresql'],
    ...EXTRA_SOURCES.map(
      (source): [string, () => Promise<IrSchema>, Provider] => [
        source.label,
        () => parseSource(source),
        'postgresql',
      ]
    ),
    ...sequelizeSources.map(
      ([label, paths]): [string, () => Promise<IrSchema>, Provider] => [
        label,
        async () =>
          expectOk(
            await parseSequelize(
              paths.map((path: string) => ({
                path,
                text: readFileSync(path, 'utf8'),
              })),
              { appLabel: 'app' }
            )
          ),
        'postgresql',
      ]
    ),
  ];

  describe.each(fixtures)('%s fixture', (label, build, provider) => {
    it('matches the golden output in both styles and naming modes, with the warnings and what reading it back changes', async () => {
      const schema: IrSchema = await build();
      const files: Record<string, string> = {};
      for (const style of SEQUELIZE_STYLES) {
        for (const naming of ['preserve', 'normalize'] as const) {
          const output: MultiFileEmitOutput = emit(schema, {
            style,
            naming,
            provider,
          });
          for (const [path, text] of Object.entries(output.files)) {
            files[`${style}.${naming}/${path}`] = text;
          }
          files[`${style}.${naming}.warnings.txt`] =
            `${output.warnings.join('\n')}\n`;
        }
      }
      // What the Sequelize reader makes of the preserve output: the drift of the format.
      const reread_: IrSchema = await reread(
        emit(schema, { provider, style: 'init' })
      );
      files['init.preserve.drift.txt'] = `${compareIr(schema, reread_)
        .map(formatDifference)
        .join('\n')}\n`;
      expectFilesMatchGolden(`sequelize-fixtures/${label}`, files, goldenRoot);
    });
  });

  it('writes the constructs fixture for every provider', () => {
    const files: Record<string, string> = {};
    for (const provider of [
      'postgresql',
      'mysql',
      'sqlite',
      'sqlserver',
      'mongodb',
    ] as const) {
      const output: MultiFileEmitOutput = emit(constructsSchema(), {
        provider,
      });
      for (const [path, text] of Object.entries(output.files)) {
        files[`${provider}/${path}`] = text;
      }
      files[`${provider}.warnings.txt`] = `${output.warnings.join('\n')}\n`;
    }
    expectFilesMatchGolden('sequelize-providers/constructs', files, goldenRoot);
  });
});
