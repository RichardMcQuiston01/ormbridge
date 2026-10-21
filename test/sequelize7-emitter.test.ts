import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { convertText, type ConvertResult } from '../src/convert.js';
import {
  emitSequelize,
  isSequelizeOutputStyle,
  SEQUELIZE_GENERATIONS,
  SEQUELIZE_OUTPUT_STYLES,
  type SequelizeEmitOptions,
} from '../src/emitters/sequelize.js';
import { getFormat, type MultiFileEmitOutput } from '../src/formats.js';
import type { IrSchema } from '../src/ir.js';
import { parseSequelize } from '../src/parsers/sequelize.js';
import { checkStyle } from '../src/styles.js';
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
import { expectFilesMatchGolden, loadCanonicalSources } from './harness.js';
import { DEFAULT_OPTIONS, expectOk } from './helpers.js';
import { compareIr, formatDifference } from './irCompare.js';
import { EXTRA_SOURCES, parseSource } from './realToolSupport.js';

/**
 * The Sequelize 7 output (`--style v7`): decorated `@sequelize/core` classes, one file per model and an `index`
 * file that lists the models. The same output, loaded with the real library, is checked in
 * sequelize7-verify.test.ts.
 */

type Provider = SequelizeEmitOptions['provider'];

function emit(
  schema: IrSchema,
  overrides: Partial<SequelizeEmitOptions> = {}
): MultiFileEmitOutput {
  return emitSequelize(structuredClone(schema), {
    provider: 'postgresql',
    naming: 'preserve',
    style: 'v7',
    ...overrides,
  });
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

/** Joins the lines of wrapped objects and calls, so assertions do not depend on where a line was broken. */
function squash(text: string): string {
  return text
    .replace(/\n\s*/g, ' ')
    .replace(/([[(]) /g, '$1')
    .replace(/,\s*([\])])/g, '$1')
    .replace(/,\s*\}/g, ' }');
}

function syntaxErrors(path: string, text: string): string[] {
  const result: ts.TranspileOutput = ts.transpileModule(text, {
    fileName: path,
    reportDiagnostics: true,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      experimentalDecorators: true,
    },
  });
  return (result.diagnostics ?? []).map((diagnostic: ts.Diagnostic) =>
    ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')
  );
}

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

describe('sequelize 7 emitter: the style', () => {
  it('names the generations next to the layouts', () => {
    expect(SEQUELIZE_GENERATIONS).toEqual(['v6', 'v7']);
    expect(SEQUELIZE_OUTPUT_STYLES).toEqual(['init', 'define', 'v6', 'v7']);
    expect(isSequelizeOutputStyle('v7')).toBe(true);
    expect(isSequelizeOutputStyle('v8')).toBe(false);
    expect(checkStyle('sequelize', 'v7').ok).toBe(true);
    expect(checkStyle('sequelize', 'v6').ok).toBe(true);
    expect(checkStyle('sqlalchemy', 'v7').ok).toBe(false);
  });

  it('writes the same files for v6 as for the default init style', () => {
    const schema: IrSchema = kitchenSinkSchema();
    expect(emit(schema, { style: 'v6' })).toEqual(
      emit(schema, { style: 'init' })
    );
    expect(emit(schema, { style: 'v6' })).toEqual(
      emitSequelize(structuredClone(schema), {
        provider: 'postgresql',
        naming: 'preserve',
      })
    );
  });

  it('is accepted through the adapter and convertText', async () => {
    const adapter = expectOk(getFormat('sequelize'));
    const written = adapter.emit?.(schemaOf([model('A')]), {
      ...DEFAULT_OPTIONS,
      style: 'v7',
    });
    expect(written?.ok).toBe(true);
    const result: ConvertResult = expectOk(
      await convertText(loadCanonicalSources('prisma'), {
        ...DEFAULT_OPTIONS,
        from: 'prisma',
        to: 'sequelize',
        style: 'v7',
      })
    );
    expect(Object.keys(result.files ?? {})).toContain('index.ts');
    expect(result.files?.['post.ts']).toContain('@Table(');
  });

  it('writes TypeScript files and an index that lists the models', () => {
    const output: MultiFileEmitOutput = emit(
      schemaOf([model('Author'), model('BlogPost')])
    );
    expect(Object.keys(output.files)).toEqual([
      'author.ts',
      'blogPost.ts',
      'index.ts',
    ]);
    const index_: string = fileText(output, 'index.ts');
    expect(index_).toContain("import { Author } from './author.js';");
    expect(index_).toContain('export const models = [Author, BlogPost];');
    expect(index_).toContain(
      "import { PostgresDialect } from '@sequelize/postgres';"
    );
    expect(writeIndexDialect('mysql')).toContain(
      "import { MySqlDialect } from '@sequelize/mysql';"
    );
    expect(writeIndexDialect('sqlite')).toContain(
      "import { SqliteDialect } from '@sequelize/sqlite3';"
    );
    expect(writeIndexDialect('sqlserver')).toContain(
      "import { MsSqlDialect } from '@sequelize/mssql';"
    );
  });

  function writeIndexDialect(provider: Provider): string {
    return fileText(emit(schemaOf([model('A')]), { provider }), 'index.ts');
  }

  it('writes nothing for an empty schema', () => {
    expect(emit(schemaOf([])).files).toEqual({});
  });

  it('writes valid TypeScript for every provider and naming mode', () => {
    for (const provider of [
      'postgresql',
      'mysql',
      'sqlite',
      'sqlserver',
      'cockroachdb',
    ] as const) {
      for (const naming of ['preserve', 'normalize'] as const) {
        const output: MultiFileEmitOutput = emit(kitchenSinkSchema(), {
          provider,
          naming,
        });
        for (const [path, text] of Object.entries(output.files)) {
          expect(
            syntaxErrors(path, text),
            `${provider} ${naming} ${path}`
          ).toEqual([]);
        }
      }
    }
  });
});

describe('sequelize 7 emitter: models', () => {
  it('writes columns as decorators', () => {
    const output: MultiFileEmitOutput = emit(
      schemaOf([
        model('Thing', {
          tableName: 'things',
          fields: [
            idField(),
            field('email', { maxLength: 120, isUnique: true }),
            field('nick', { isNullable: true, maxLength: 30 }),
            field('views', {
              type: 'int',
              default: { kind: 'literal', value: 0 },
            }),
            field('made_at', {
              type: 'dateTime',
              columnName: 'created_on',
              default: { kind: 'now' },
            }),
            field('token', {
              type: 'uuid',
              isUnique: true,
              uniqueName: 'things_token',
              default: { kind: 'uuid' },
            }),
          ],
        }),
      ])
    );
    const text: string = squash(fileText(output, 'thing.ts'));
    expect(text).toContain(
      '@Attribute(DataTypes.INTEGER) @PrimaryKey @AutoIncrement declare id: CreationOptional<number>;'
    );
    expect(text).toContain(
      '@Attribute(DataTypes.STRING(120)) @NotNull @Unique declare email: string;'
    );
    expect(text).toContain(
      '@Attribute(DataTypes.STRING(30)) declare nick: CreationOptional<string | null>;'
    );
    expect(text).toContain(
      '@Attribute(DataTypes.INTEGER) @NotNull @Default(0) declare views: CreationOptional<number>;'
    );
    expect(text).toContain(
      "@Attribute(DataTypes.DATE) @NotNull @Default(DataTypes.NOW) @ColumnName('created_on') declare made_at: CreationOptional<Date>;"
    );
    expect(text).toContain(
      "@Attribute(DataTypes.UUID) @NotNull @Unique('things_token') @Default(DataTypes.UUIDV4) declare token: CreationOptional<string>;"
    );
    expect(text).toContain(
      "@Table({ tableName: 'things', timestamps: false })"
    );
  });

  it('imports only the decorators it uses, from the legacy decorator entry point', () => {
    const output: MultiFileEmitOutput = emit(schemaOf([model('A')]));
    const text: string = fileText(output, 'a.ts');
    expect(text).toContain(
      "import {\n  DataTypes,\n  Model,\n  type CreationOptional,\n  type InferAttributes,\n  type InferCreationAttributes,\n} from '@sequelize/core';"
    );
    expect(text).toContain(
      "import {\n  Attribute,\n  AutoIncrement,\n  PrimaryKey,\n  Table,\n} from '@sequelize/core/decorators-legacy';"
    );
    expect(text).not.toContain('NonAttribute');
  });

  it('writes createdAt and updatedAt as @CreatedAt and @UpdatedAt', () => {
    const output: MultiFileEmitOutput = emit(
      schemaOf([
        model('Thing', {
          fields: [
            idField(),
            field('createdAt', {
              type: 'dateTime',
              columnName: 'created_at',
              default: { kind: 'now' },
            }),
            field('updatedAt', {
              type: 'dateTime',
              columnName: 'updated_at',
              isAutoUpdated: true,
            }),
          ],
        }),
      ])
    );
    const text: string = squash(fileText(output, 'thing.ts'));
    expect(text).toContain(
      '@CreatedAt declare readonly createdAt: CreationOptional<Date>;'
    );
    expect(text).toContain(
      '@UpdatedAt declare readonly updatedAt: CreationOptional<Date>;'
    );
    expect(text).toContain('timestamps: true, underscored: true');
  });

  it('names a renamed timestamp with the decorator instead of a table option', () => {
    const output: MultiFileEmitOutput = emit(
      schemaOf([
        model('Thing', {
          fields: [
            idField(),
            field('created', { type: 'dateTime', columnName: 'created' }),
            field('changed', {
              type: 'dateTime',
              columnName: 'changed',
              isAutoUpdated: true,
            }),
          ],
        }),
      ])
    );
    const text: string = fileText(output, 'thing.ts');
    expect(text).not.toContain("createdAt: '");
    expect(text).not.toContain("updatedAt: '");
    expect(text).toContain('@UpdatedAt');
  });

  it('writes a model without a primary key as noPrimaryKey', () => {
    const output: MultiFileEmitOutput = emit(
      schemaOf([model('Log', { fields: [field('message')] })])
    );
    expect(fileText(output, 'log.ts')).toContain('noPrimaryKey: true');
    expect(output.warnings.join('\n')).not.toContain('removeAttribute');
  });

  it('writes the indexes in the @Table options', () => {
    const output: MultiFileEmitOutput = emit(
      schemaOf([
        model('Thing', {
          fields: [idField(), field('a'), field('b')],
          indexes: [
            index(['a', 'b'], { isUnique: true, name: 'a_b' }),
            index(['a']),
          ],
        }),
      ])
    );
    const text: string = fileText(output, 'thing.ts');
    expect(text).toContain('  indexes: [\n');
    expect(squash(text)).toContain(
      "indexes: [{ name: 'a_b', unique: true, fields: ['a', 'b'] }, { fields: ['a'] }]"
    );
  });

  it('writes a database expression default with sql.literal', () => {
    const output: MultiFileEmitOutput = emit(
      schemaOf([
        model('Thing', {
          fields: [
            idField(),
            field('slug', {
              default: { kind: 'dbExpression', expression: 'lower(uuid())' },
            }),
          ],
        }),
      ]),
      { provider: 'sqlite' }
    );
    const text: string = fileText(output, 'thing.ts');
    expect(text).toContain("@Default(sql.literal('(lower(uuid()))'))");
    expect(text).toContain('DataTypes,\n  Model,\n  sql,');
    expect(text).not.toContain('Sequelize.literal');
  });

  it('keeps a class out of the names the file imports', () => {
    const output: MultiFileEmitOutput = emit(
      schemaOf([model('Table'), model('Default')])
    );
    expect(Object.keys(output.files)).toEqual([
      'tableModel.ts',
      'defaultModel.ts',
      'index.ts',
    ]);
    expect(output.warnings).toEqual([
      'Table: "Table" is a name the generated files use, so the class and the model were named "TableModel".',
      'Default: "Default" is a name the generated files use, so the class and the model were named "DefaultModel".',
    ]);
  });
});

describe('sequelize 7 emitter: SQLite types', () => {
  const schema: IrSchema = schemaOf([
    model('Thing', {
      fields: [
        idField({ type: 'bigInt' }),
        field('big', { type: 'bigInt' }),
        field('price', { type: 'decimal', maxDigits: 8, decimalPlaces: 2 }),
        field('span', { type: 'duration' }),
      ],
    }),
  ]);

  it('writes INTEGER and DOUBLE where the SQLite dialect has no BIGINT or DECIMAL', () => {
    const output: MultiFileEmitOutput = emit(schema, { provider: 'sqlite' });
    const text: string = squash(fileText(output, 'thing.ts'));
    expect(text).toContain(
      '@Attribute(DataTypes.INTEGER) @PrimaryKey @AutoIncrement declare id: CreationOptional<number>;'
    );
    expect(text).toContain(
      '@Attribute(DataTypes.INTEGER) @NotNull declare big: number;'
    );
    expect(text).toContain(
      '@Attribute(DataTypes.DOUBLE) @NotNull declare price: number;'
    );
    expect(output.warnings).toEqual([
      'Thing.price: the Sequelize 7 SQLite dialect has no DECIMAL type; the column was written as DOUBLE, which is not exact.',
      'Thing.span: Sequelize has no interval type; the duration was written as BIGINT (microseconds).',
    ]);
  });

  it('keeps BIGINT and DECIMAL for the other providers, and in the Sequelize 6 styles', () => {
    expect(squash(fileText(emit(schema), 'thing.ts'))).toContain(
      'DataTypes.DECIMAL(8, 2)'
    );
    expect(
      fileText(emit(schema, { provider: 'sqlite', style: 'init' }), 'thing.ts')
    ).toContain('DataTypes.DECIMAL(8, 2)');
  });
});

describe('sequelize 7 emitter: relations', () => {
  const user = model('User', { tableName: 'users' });

  it('declares a relation once, with the reverse side as an inverse option and a typed property', () => {
    const output: MultiFileEmitOutput = emit(
      schemaOf([
        user,
        model('Post', {
          tableName: 'posts',
          relations: [
            relation('author', 'User', { relatedName: 'posts' }),
            relation('editor', 'User', {
              isNullable: true,
              onDelete: 'setNull',
              onUpdate: 'restrict',
              relatedName: 'edited_posts',
            }),
          ],
        }),
      ])
    );
    const post: string = squash(fileText(output, 'post.ts'));
    expect(post).toContain(
      "@BelongsTo(() => User, { foreignKey: { name: 'author_id', onDelete: 'CASCADE' }, inverse: { type: 'hasMany', as: 'posts' } }) declare author?: NonAttribute<User>;"
    );
    expect(post).toContain(
      "foreignKey: { name: 'editor_id', onDelete: 'SET NULL', onUpdate: 'RESTRICT' }"
    );
    expect(post).toContain("import { User } from './user.js';");
    const owner: string = fileText(output, 'user.ts');
    expect(owner).toContain('declare posts?: NonAttribute<Post[]>;');
    expect(owner).toContain('declare edited_posts?: NonAttribute<Post[]>;');
    expect(owner).toContain("import type { Post } from './post.js';");
    expect(owner).not.toContain('@HasMany');
  });

  it('writes a one-to-one relation as hasOne, and one without a reverse name as a lone @BelongsTo', () => {
    const output: MultiFileEmitOutput = emit(
      schemaOf([
        user,
        model('Profile', {
          tableName: 'profiles',
          relations: [
            relation('user', 'User', {
              kind: 'oneToOne',
              relatedName: 'profile',
            }),
            relation('owner', 'User'),
          ],
        }),
      ])
    );
    const text: string = squash(fileText(output, 'profile.ts'));
    expect(text).toContain("inverse: { type: 'hasOne', as: 'profile' }");
    expect(text).toContain(
      "@BelongsTo(() => User, { foreignKey: { name: 'owner_id', onDelete: 'CASCADE' } }) declare owner?: NonAttribute<User>;"
    );
    expect(fileText(output, 'user.ts')).toContain(
      'declare profile?: NonAttribute<Profile>;'
    );
  });

  it('declares a self reference from the HasMany side, because Sequelize 7 cannot pair a self-referencing BelongsTo', () => {
    const output: MultiFileEmitOutput = emit(
      schemaOf([
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
      ])
    );
    const text: string = squash(fileText(output, 'category.ts'));
    expect(text).toContain(
      "@HasMany(() => Category, { foreignKey: { name: 'parent_id', onDelete: 'SET NULL' }, inverse: 'parent' }) declare children?: NonAttribute<Category[]>;"
    );
    expect(text).toContain('declare parent?: NonAttribute<Category>;');
    expect(text).not.toContain('@BelongsTo');
  });

  it('writes a many-to-many as one @BelongsToMany with an inverse', () => {
    const output: MultiFileEmitOutput = emit(
      schemaOf([
        model('Post', {
          tableName: 'posts',
          relations: [
            relation('tags', 'Tag', {
              kind: 'manyToMany',
              relatedName: 'posts',
            }),
          ],
        }),
        model('Tag', { tableName: 'tags' }),
      ])
    );
    const post: string = squash(fileText(output, 'post.ts'));
    expect(post).toContain(
      "@BelongsToMany(() => Tag, { through: { model: 'posts_tags', timestamps: false }, foreignKey: 'post_id', otherKey: 'tag_id', inverse: 'posts' }) declare tags?: NonAttribute<Tag[]>;"
    );
    expect(fileText(output, 'tag.ts')).toContain(
      'declare posts?: NonAttribute<Post[]>;'
    );
  });

  it('gives a self-referencing many-to-many two different names and the join model its own association names', () => {
    const output: MultiFileEmitOutput = emit(
      schemaOf([
        model('Product', {
          tableName: 'products',
          relations: [relation('similar', 'Product', { kind: 'manyToMany' })],
        }),
      ])
    );
    const text: string = squash(fileText(output, 'product.ts'));
    expect(text).toContain("inverse: 'similarInverse'");
    expect(text).toContain(
      "throughAssociations: { fromSource: 'similarLinks', toSource: 'similarSource', fromTarget: 'similarInverseLinks', toTarget: 'similarTarget' }"
    );
    expect(output.warnings).toEqual([
      'Product.similar: Sequelize 7 needs a name for the other side of a self-referencing many-to-many relation; "similarInverse" was added.',
    ]);
  });

  it('declares the key of a relation as a plain attribute with its column name', () => {
    const output: MultiFileEmitOutput = emit(
      schemaOf([
        user,
        model('Post', {
          relations: [
            relation('author', 'User', {
              columnName: 'writer',
              isNullable: true,
              onDelete: 'setNull',
            }),
          ],
        }),
      ])
    );
    const text: string = squash(fileText(output, 'post.ts'));
    expect(text).toContain(
      '@Attribute(DataTypes.INTEGER) declare writer: CreationOptional<number | null>;'
    );
  });
});

describe('sequelize 7 emitter: fixtures', () => {
  const goldenRoot: string = fileURLToPath(
    new URL('./golden-extras/', import.meta.url)
  );
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
    [
      'sequelize7-canonical',
      ['category', 'post', 'profile', 'tag', 'user'].map((name: string) =>
        fileURLToPath(
          new URL(`./fixtures/sequelize7/models/${name}.ts`, import.meta.url)
        )
      ),
    ],
    [
      'sequelize7-variants',
      [
        fileURLToPath(
          new URL('./fixtures/sequelize7-extras/variants.ts', import.meta.url)
        ),
      ],
    ],
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
    it('matches the golden output in both naming modes, with the warnings and what reading it back changes', async () => {
      const schema: IrSchema = await build();
      const files: Record<string, string> = {};
      for (const naming of ['preserve', 'normalize'] as const) {
        const output: MultiFileEmitOutput = emit(schema, { naming, provider });
        for (const [path, text] of Object.entries(output.files)) {
          files[`${naming}/${path}`] = text;
          expect(syntaxErrors(path, text), `${naming} ${path}`).toEqual([]);
        }
        files[`${naming}.warnings.txt`] = `${output.warnings.join('\n')}\n`;
      }
      // What the Sequelize reader makes of the preserve output: the drift of the format.
      const read: IrSchema = await reread(emit(schema, { provider }));
      files['preserve.drift.txt'] = `${compareIr(schema, read)
        .map(formatDifference)
        .join('\n')}\n`;
      expectFilesMatchGolden(`sequelize7-fixtures/${label}`, files, goldenRoot);
    });
  });

  it('reads the Sequelize 7 fixtures back unchanged', async () => {
    for (const [label, paths] of sequelizeSources.slice(-2)) {
      const before: IrSchema = expectOk(
        await parseSequelize(
          paths.map((path: string) => ({
            path,
            text: readFileSync(path, 'utf8'),
          })),
          { appLabel: 'app' }
        )
      );
      const after: IrSchema = await reread(emit(before));
      expect(compareIr(before, after).map(formatDifference), label).toEqual([]);
      expect(after.warnings.length, label).toBe(before.warnings.length);
    }
  });

  it('writes the constructs fixture for every provider', () => {
    const files: Record<string, string> = {};
    for (const provider of [
      'postgresql',
      'mysql',
      'sqlite',
      'sqlserver',
      'cockroachdb',
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
    expectFilesMatchGolden(
      'sequelize7-providers/constructs',
      files,
      goldenRoot
    );
  });
});
