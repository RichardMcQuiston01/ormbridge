import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
  type TestContext,
} from 'vitest';
import {
  emitGorm,
  gormColumnName,
  gormPluralize,
  gormTableName,
  isValidGoPackageName,
  normalizeGormSchema,
  type GormEmitOptions,
} from '../src/emitters/gorm.js';
import {
  getFormat,
  type FormatEmitOutput,
  type MultiFileEmitOutput,
} from '../src/formats.js';
import type { IrModel, IrSchema } from '../src/ir.js';
import { err } from '../src/result.js';
import { parseWith } from './conversionMatrix.js';
import { checkGormOutput } from './gormCoverage.js';
import {
  STATUS,
  field,
  idField,
  index,
  kitchenSinkSchema,
  stressSchema,
  model,
  relation,
  schemaOf,
} from './gormFixtures.js';
import { convertCanonical, loadCanonicalSources } from './harness.js';
import { DEFAULT_OPTIONS, expectOk } from './helpers.js';

function emit(
  schema: IrSchema,
  overrides: Partial<GormEmitOptions> = {}
): MultiFileEmitOutput {
  return emitGorm(schema, {
    provider: 'postgresql',
    naming: 'preserve',
    ...overrides,
  });
}

/** The text of `models/<file>.go`. */
function source(output: MultiFileEmitOutput, file: string): string {
  const text: string | undefined = output.files[`models/${file}.go`];
  if (text === undefined) {
    throw new Error(
      `No file ${file}. Files: ${Object.keys(output.files).join(', ')}`
    );
  }
  return text;
}

/**
 * A struct member as `Type tag` with the alignment padding collapsed, so
 * assertions do not depend on column widths.
 */
function member(text: string, name: string): string {
  const pattern: RegExp = new RegExp(`^\\t${name}\\s+(.*)$`, 'm');
  const match: RegExpMatchArray | null = pattern.exec(text);
  if (match === null) {
    throw new Error(`No member ${name} in:\n${text}`);
  }
  return (match[1] ?? '').replace(/\s{2,}/g, ' ').trim();
}

function tagOf(text: string, name: string): string {
  const found: string = member(text, name);
  const tag: RegExpMatchArray | null = /`gorm:"(.*)"`/.exec(found);
  return tag?.[1] ?? '';
}

function entries(text: string, name: string): string[] {
  const tag: string = tagOf(text, name);
  return tag === '' ? [] : tag.split(';');
}

describe('gorm emitter: files and package', () => {
  it('writes one snake_case file per model and per enum under the package directory', () => {
    const output: MultiFileEmitOutput = emit(
      schemaOf([model('Post'), model('BlogTag'), model('URLMapping')], [STATUS])
    );
    expect(Object.keys(output.files).sort()).toEqual([
      'models/blog_tag.go',
      'models/post.go',
      'models/status.go',
      'models/url_mapping.go',
    ]);
    expect(output.text).toBeUndefined();
    expect(source(output, 'post')).toBe(
      [
        'package models',
        '',
        '// Post maps to the "post" table.',
        'type Post struct {',
        '\tID int32 `gorm:"primaryKey;autoIncrement"`',
        '}',
        '',
        "// TableName overrides GORM's default table name (posts).",
        'func (Post) TableName() string {',
        '\treturn "post"',
        '}',
        '',
      ].join('\n')
    );
  });

  it('uses the same package clause and directory in every file', () => {
    const output: MultiFileEmitOutput = emit(
      schemaOf([model('Post'), model('Tag')], [STATUS]),
      { goPackage: 'store' }
    );
    expect(Object.keys(output.files).sort()).toEqual([
      'store/post.go',
      'store/status.go',
      'store/tag.go',
    ]);
    for (const text of Object.values(output.files)) {
      expect(text.startsWith('package store\n')).toBe(true);
    }
  });

  it('validates the package name as a Go identifier', () => {
    for (const valid of ['models', 'db', 'Store2', '_internal', 'main']) {
      expect(isValidGoPackageName(valid), valid).toBe(true);
    }
    for (const invalid of [
      '',
      '_',
      'my-models',
      '2models',
      'a.b',
      'func',
      'a b',
    ]) {
      expect(isValidGoPackageName(invalid), invalid).toBe(false);
    }
  });

  it('falls back to "models" with a warning when called directly with a bad package', () => {
    const output: MultiFileEmitOutput = emit(schemaOf([model('A')]), {
      goPackage: 'not valid',
    });
    expect(Object.keys(output.files)).toEqual(['models/a.go']);
    expect(output.warnings).toContain(
      'The Go package name "not valid" is not valid; "models" was used instead.'
    );
  });

  it('is registered as a "gorm" format that does not claim .go', () => {
    const adapter = expectOk(getFormat('gorm'));
    expect(adapter.parse).toBeDefined();
    expect(adapter.emit).toBeDefined();
    expect(adapter.extensions).toEqual([]);
  });

  it('rejects an invalid goPackage option through the adapter', () => {
    const adapter = expectOk(getFormat('gorm'));
    const result = adapter.emit?.(schemaOf([model('A')]), {
      ...DEFAULT_OPTIONS,
      goPackage: 'my-models',
    });
    expect(result).toEqual(
      err(
        'INVALID_OPTION',
        'Invalid Go package name "my-models". Expected a Go identifier such as models.'
      )
    );
  });

  it('passes goPackage, naming and provider through the adapter', () => {
    const adapter = expectOk(getFormat('gorm'));
    const result: FormatEmitOutput | undefined = expectOk(
      adapter.emit?.(schemaOf([model('Post')]), {
        ...DEFAULT_OPTIONS,
        goPackage: 'store',
        naming: 'normalize',
      }) ?? err('EMIT_FAILED', 'no emit')
    );
    expect(Object.keys(result.text === undefined ? result.files : {})).toEqual([
      'store/post.go',
    ]);
  });

  it('avoids file names Go treats as test or platform files', () => {
    const output: MultiFileEmitOutput = emit(
      schemaOf([
        model('UserTest'),
        model('PostLinux'),
        model('Linux'),
        model('Arm64'),
        model('Fine'),
      ])
    );
    expect(Object.keys(output.files).sort()).toEqual([
      'models/arm64.go',
      'models/fine.go',
      'models/linux.go',
      'models/post_linux_model.go',
      'models/user_test_model.go',
    ]);
  });

  it('keeps file names unique when two models share a snake_case name', () => {
    const output: MultiFileEmitOutput = emit(
      schemaOf([model('BlogPost'), model('blog_post'), model('Blog_Post')])
    );
    expect(Object.keys(output.files).sort()).toEqual([
      'models/blog_post.go',
      'models/blog_post2.go',
      'models/blog_post3.go',
    ]);
    expect(source(output, 'blog_post2')).toContain('type BlogPost2 struct');
  });
});

describe('gorm emitter: naming conventions', () => {
  it('derives column names like GORM', () => {
    const cases: [string, string][] = [
      ['ID', 'id'],
      ['PublicID', 'public_id'],
      ['UserID', 'user_id'],
      ['HTTPServer', 'http_server'],
      ['ImageURL', 'image_url'],
      ['ViewCount', 'view_count'],
      ['IsFeatured', 'is_featured'],
      ['CreatedAt', 'created_at'],
      ['OAuth', 'o_auth'],
      ['Field2Name', 'field2_name'],
      ['UUID', 'uuid'],
      ['XMLHTTP', 'xml_http'],
      ['FooBAr', 'foo_b_ar'],
    ];
    for (const [goName, column] of cases) {
      expect(gormColumnName(goName), goName).toBe(column);
    }
  });

  it('derives table names like GORM', () => {
    const cases: [string, string][] = [
      ['Post', 'posts'],
      ['Category', 'categories'],
      ['Status', 'statuses'],
      ['Person', 'people'],
      ['BlogPost', 'blog_posts'],
      ['Child', 'children'],
      ['Box', 'boxes'],
      ['Series', 'series'],
      ['Index', 'indices'],
      ['Mouse', 'mice'],
      ['Knife', 'knives'],
      ['Sheep', 'sheep'],
      ['Day', 'days'],
      ['PostTags', 'post_tags'],
    ];
    for (const [goName, table] of cases) {
      expect(gormTableName(goName), goName).toBe(table);
    }
    expect(gormPluralize('quiz')).toBe('quizzes');
  });

  it('writes column: only where GORM would derive another name', () => {
    const output: MultiFileEmitOutput = emit(
      schemaOf([
        model('T', {
          fields: [
            idField(),
            field('public_id', { type: 'uuid' }),
            field('viewCount', { columnName: 'view_count', type: 'int' }),
            field('HTTPCode', { columnName: 'http_code', type: 'int' }),
            field('legacy', { columnName: 'LegacyName' }),
            field('url', { columnName: 'link' }),
          ],
        }),
      ])
    );
    const text: string = source(output, 't');
    expect(entries(text, 'PublicID')).not.toContain('column:public_id');
    expect(entries(text, 'ViewCount')).not.toContain('column:view_count');
    expect(entries(text, 'HTTPCode')).not.toContain('column:http_code');
    expect(entries(text, 'Legacy')).toContain('column:LegacyName');
    expect(entries(text, 'URL')[0]).toBe('column:link');
  });

  it('writes TableName() only where GORM would derive another table', () => {
    const output: MultiFileEmitOutput = emit(
      schemaOf([
        model('Post', { tableName: 'posts' }),
        model('Category', { tableName: 'categories' }),
        model('Person', { tableName: 'people' }),
        model('Tag', { tableName: 'tag' }),
        model('Legacy', { tableName: 'LEGACY' }),
      ])
    );
    expect(source(output, 'post')).not.toContain('TableName');
    expect(source(output, 'category')).not.toContain('TableName');
    expect(source(output, 'person')).not.toContain('TableName');
    expect(source(output, 'tag')).toContain('return "tag"');
    expect(source(output, 'legacy')).toContain('return "LEGACY"');
  });

  it('turns IR names into exported Go names with initialisms', () => {
    const output: MultiFileEmitOutput = emit(
      schemaOf([
        model('Item', {
          fields: [
            idField(),
            field('user_id', { type: 'int' }),
            field('image_url'),
            field('api_key'),
            field('MAX_COUNT', { type: 'int' }),
            field('sqlQuery'),
          ],
        }),
      ])
    );
    const text: string = source(output, 'item');
    for (const name of [
      'ID',
      'UserID',
      'ImageURL',
      'APIKey',
      'MaxCount',
      'SQLQuery',
    ]) {
      expect(text, name).toMatch(new RegExp(`^\\t${name}\\s`, 'm'));
    }
  });

  it('repairs names that are not Go identifiers and warns', () => {
    const output: MultiFileEmitOutput = emit(
      schemaOf([
        model('9lives', {
          fields: [idField(), field('first-name'), field('2fa'), field('日本')],
        }),
      ])
    );
    const text: string = source(output, 'x9lives');
    expect(text).toContain('type X9lives struct');
    expect(text).toMatch(/^\tFirstName\s/m);
    expect(text).toMatch(/^\tX2fa\s/m);
    expect(text).toMatch(/^\tField\s/m);
    expect(output.warnings).toContain(
      '9lives: "9lives" is not a usable Go identifier; it was written as "X9lives".'
    );
    expect(output.warnings).toContain(
      '9lives.first-name: "first-name" is not a usable Go identifier; it was written as "FirstName".'
    );
  });

  it('keeps member names unique and away from methods GORM looks for', () => {
    const output: MultiFileEmitOutput = emit(
      schemaOf([
        model('Thing', {
          fields: [
            idField(),
            field('table_name'),
            field('TableName'),
            field('name'),
            field('Name'),
          ],
        }),
      ])
    );
    const text: string = source(output, 'thing');
    expect(text).toMatch(/^\tTableName2\s/m);
    expect(text).toMatch(/^\tTableName3\s/m);
    expect(text).toMatch(/^\tName\s/m);
    expect(text).toMatch(/^\tName2\s/m);
    expect(entries(text, 'TableName2')).toContain('column:table_name');
    expect(entries(text, 'Name2')).toContain('column:Name');
  });
});

describe('gorm emitter: column types', () => {
  function typeOf(
    fieldDefinition: ReturnType<typeof field>,
    provider: GormEmitOptions['provider'] = 'postgresql'
  ): string {
    const output: MultiFileEmitOutput = emit(
      schemaOf([
        model('T', { tableName: 't', fields: [idField(), fieldDefinition] }),
      ]),
      { provider }
    );
    return member(source(output, 't'), 'V');
  }

  it('maps every scalar type to a Go type and tag', () => {
    const cases: [Partial<Parameters<typeof field>[1]>, string][] = [
      [{ type: 'string' }, 'string `gorm:"not null"`'],
      [{ type: 'string', maxLength: 80 }, 'string `gorm:"size:80;not null"`'],
      [{ type: 'text' }, 'string `gorm:"type:text;not null"`'],
      [{ type: 'int' }, 'int32 `gorm:"not null"`'],
      [{ type: 'bigInt' }, 'int64 `gorm:"not null"`'],
      [{ type: 'float' }, 'float64 `gorm:"type:double precision;not null"`'],
      [{ type: 'boolean' }, 'bool `gorm:"not null"`'],
      [{ type: 'dateTime' }, 'time.Time `gorm:"not null"`'],
      [{ type: 'date' }, 'time.Time `gorm:"type:date;not null"`'],
      [{ type: 'time' }, 'time.Time `gorm:"type:time(6);not null"`'],
      [{ type: 'uuid' }, 'uuid.UUID `gorm:"type:uuid;not null"`'],
      [{ type: 'json' }, 'datatypes.JSON `gorm:"not null"`'],
      [{ type: 'bytes' }, '[]byte `gorm:"not null"`'],
      [{ type: 'ipAddress' }, 'string `gorm:"size:45;not null"`'],
      [
        { type: 'decimal', maxDigits: 8, decimalPlaces: 3 },
        'decimal.Decimal `gorm:"type:decimal(8,3);not null"`',
      ],
      [{ type: 'decimal' }, 'decimal.Decimal `gorm:"type:decimal;not null"`'],
      [{ type: 'duration' }, 'time.Duration `gorm:"not null"`'],
    ];
    for (const [overrides, expected] of cases) {
      expect(typeOf(field('v', overrides)), JSON.stringify(overrides)).toBe(
        expected
      );
    }
  });

  it('uses pointers for nullable columns, except for types that hold nil themselves', () => {
    const cases: [Partial<Parameters<typeof field>[1]>, string][] = [
      [{ type: 'string' }, '*string'],
      [{ type: 'int' }, '*int32'],
      [{ type: 'bigInt' }, '*int64'],
      [{ type: 'float' }, '*float64'],
      [{ type: 'boolean' }, '*bool'],
      [{ type: 'dateTime' }, '*time.Time'],
      [{ type: 'uuid' }, '*uuid.UUID'],
      [{ type: 'decimal', maxDigits: 4, decimalPlaces: 2 }, '*decimal.Decimal'],
      [{ type: 'json' }, 'datatypes.JSON'],
      [{ type: 'bytes' }, '[]byte'],
    ];
    for (const [overrides, goType] of cases) {
      const found: string = typeOf(
        field('v', { ...overrides, isNullable: true })
      );
      expect(
        found.startsWith(goType),
        `${JSON.stringify(overrides)}: ${found}`
      ).toBe(true);
      expect(found).not.toContain('not null');
    }
  });

  it('chooses UUID and text column types by provider', () => {
    const uuidType = (provider: GormEmitOptions['provider']): string =>
      typeOf(field('v', { type: 'uuid' }), provider);
    expect(uuidType('postgresql')).toBe(
      'uuid.UUID `gorm:"type:uuid;not null"`'
    );
    expect(uuidType('mysql')).toBe('uuid.UUID `gorm:"type:char(36);not null"`');
    expect(uuidType('sqlserver')).toBe(
      'uuid.UUID `gorm:"type:uniqueidentifier;not null"`'
    );
    expect(uuidType('sqlite')).toBe('uuid.UUID `gorm:"not null"`');
    expect(typeOf(field('v', { type: 'text' }), 'mysql')).toBe(
      'string `gorm:"type:longtext;not null"`'
    );
    expect(typeOf(field('v', { type: 'text' }), 'sqlserver')).toBe(
      'string `gorm:"type:nvarchar(max);not null"`'
    );
    expect(typeOf(field('v', { type: 'float' }), 'mysql')).toBe(
      'float64 `gorm:"not null"`'
    );
  });

  it('writes arrays as JSON slices and warns about lossy types', () => {
    const output: MultiFileEmitOutput = emit(
      schemaOf([
        model('T', {
          tableName: 't',
          fields: [
            idField(),
            field('tags', { arrayDepth: 1 }),
            field('grid', { type: 'int', arrayDepth: 2 }),
            field('attrs', { type: 'hstore' }),
            field('span', { type: 'range', rangeOf: 'int' }),
            field('shape', { type: 'unsupported', unsupportedType: 'circle' }),
            field('elapsed', { type: 'duration' }),
          ],
        }),
      ])
    );
    const text: string = source(output, 't');
    expect(member(text, 'Tags')).toBe(
      'datatypes.JSONSlice[string] `gorm:"not null"`'
    );
    expect(member(text, 'Grid')).toBe(
      'datatypes.JSONSlice[[]int32] `gorm:"not null"`'
    );
    expect(member(text, 'Attrs')).toBe('datatypes.JSON `gorm:"not null"`');
    expect(member(text, 'Span')).toBe('string `gorm:"not null"`');
    expect(member(text, 'Shape')).toBe('string `gorm:"type:circle;not null"`');
    expect(
      output.warnings.filter((warning) => warning.startsWith('T.'))
    ).toEqual([
      'T.tags: GORM has no portable array column type; the array was written as a JSON column (datatypes.JSONSlice).',
      'T.grid: GORM has no portable array column type; the array was written as a JSON column (datatypes.JSONSlice).',
      'T.attrs: GORM has no hstore type; the field was written as a JSON column (datatypes.JSON).',
      'T.span: GORM has no range column type; the field was written as a string column holding the range text.',
      'T.shape: the database type "circle" has no Go type here; the column was written as a string with type:circle.',
      'T.elapsed: GORM has no interval column; the duration was written as a time.Duration, stored as nanoseconds in a bigint column.',
    ]);
  });

  it('warns when a decimal without precision would lose its scale', () => {
    const output: MultiFileEmitOutput = emit(
      schemaOf([
        model('T', {
          fields: [idField(), field('amount', { type: 'decimal' })],
        }),
      ]),
      { provider: 'mysql' }
    );
    expect(output.warnings).toContain(
      'T.amount: a decimal column without precision and scale gets the database default (no decimal places on this provider).'
    );
  });

  it('treats the mongodb provider as relational with a warning', () => {
    const output: MultiFileEmitOutput = emit(schemaOf([model('A')]), {
      provider: 'mongodb',
    });
    expect(output.warnings).toContain(
      'Provider "mongodb": GORM is relational (it has no MongoDB driver); relational models were written.'
    );
  });
});

describe('gorm emitter: keys, nullability and uniqueness', () => {
  it('writes primaryKey and autoIncrement for generated keys', () => {
    const output: MultiFileEmitOutput = emit(
      schemaOf([
        model('A', { fields: [idField(), field('big', { type: 'bigInt' })] }),
      ])
    );
    expect(entries(source(output, 'a'), 'ID')).toEqual([
      'primaryKey',
      'autoIncrement',
    ]);
  });

  it('turns autoIncrement off for a lone integer key without an auto-increment default', () => {
    const output: MultiFileEmitOutput = emit(
      schemaOf([
        model('A', {
          fields: [field('code', { type: 'int', isPrimaryKey: true })],
        }),
        model('B', {
          fields: [field('code', { isPrimaryKey: true, maxLength: 8 })],
        }),
      ])
    );
    expect(entries(source(output, 'a'), 'Code')).toEqual([
      'primaryKey',
      'autoIncrement:false',
    ]);
    expect(entries(source(output, 'b'), 'Code')).toEqual([
      'size:8',
      'primaryKey',
    ]);
  });

  it('marks every member of a composite key with primaryKey and no auto-increment', () => {
    const output: MultiFileEmitOutput = emit(
      schemaOf([
        model('Pair', {
          fields: [
            field('a', { type: 'int', isPrimaryKey: true }),
            field('b', { type: 'int', isPrimaryKey: true }),
          ],
          compositePrimaryKey: ['a', 'b'],
        }),
      ])
    );
    const text: string = source(output, 'pair');
    expect(entries(text, 'A')).toEqual(['primaryKey']);
    expect(entries(text, 'B')).toEqual(['primaryKey']);
  });

  it('writes not null, unique and uniqueIndex for required and unique columns', () => {
    const output: MultiFileEmitOutput = emit(
      schemaOf([
        model('A', {
          fields: [
            idField(),
            field('plain'),
            field('maybe', { isNullable: true }),
            field('code', { isUnique: true }),
            field('named', { isUnique: true, uniqueName: 'uq_named' }),
          ],
        }),
      ])
    );
    const text: string = source(output, 'a');
    expect(entries(text, 'Plain')).toEqual(['not null']);
    expect(entries(text, 'Maybe')).toEqual([]);
    expect(entries(text, 'Code')).toEqual(['not null', 'unique']);
    expect(entries(text, 'Named')).toEqual([
      'not null',
      'uniqueIndex:uq_named',
    ]);
  });

  it('warns when a model has no primary key', () => {
    const output: MultiFileEmitOutput = emit(
      schemaOf([model('A', { fields: [field('x')] })])
    );
    expect(output.warnings).toContain(
      'A: the model has no primary key; GORM can still read and create rows, but updates and deletes by key need one.'
    );
  });
});

describe('gorm emitter: defaults and timestamps', () => {
  function tags(
    fieldDefinition: ReturnType<typeof field>,
    overrides: Partial<GormEmitOptions> = {},
    enums = [STATUS]
  ): string[] {
    const output: MultiFileEmitOutput = emit(
      schemaOf(
        [model('T', { tableName: 't', fields: [idField(), fieldDefinition] })],
        enums
      ),
      overrides
    );
    return entries(source(output, 't'), 'V');
  }

  it('writes literal defaults', () => {
    const base = { default: undefined };
    expect(
      tags(field('v', { ...base, default: { kind: 'literal', value: 'a b' } }))
    ).toEqual(['not null', 'default:a b']);
    expect(
      tags(
        field('v', { type: 'int', default: { kind: 'literal', value: 3.7 } })
      )
    ).toEqual(['not null', 'default:3']);
    expect(
      tags(
        field('v', { type: 'float', default: { kind: 'literal', value: 1.5 } })
      )
    ).toEqual(['type:double precision', 'not null', 'default:1.5']);
    expect(
      tags(
        field('v', {
          type: 'boolean',
          default: { kind: 'literal', value: true },
        })
      )
    ).toEqual(['not null', 'default:true']);
    expect(
      tags(
        field('v', {
          type: 'boolean',
          default: { kind: 'literal', value: 'false' },
        })
      )
    ).toEqual(['not null', 'default:false']);
    expect(
      tags(
        field('v', {
          type: 'decimal',
          maxDigits: 5,
          decimalPlaces: 2,
          default: { kind: 'literal', value: '1.50' },
        })
      )
    ).toEqual(['type:decimal(5,2)', 'not null', 'default:1.50']);
  });

  it('quotes defaults that GORM passes to the database as written', () => {
    expect(
      tags(
        field('v', { type: 'json', default: { kind: 'literal', value: '{}' } })
      )
    ).toEqual(['not null', "default:'{}'"]);
    expect(
      tags(
        field('v', {
          type: 'dateTime',
          default: { kind: 'literal', value: '2024-01-01 00:00:00' },
        })
      )
    ).toEqual(['not null', "default:'2024-01-01 00:00:00'"]);
  });

  it('escapes semicolons in tag values', () => {
    const output: MultiFileEmitOutput = emit(
      schemaOf([
        model('T', {
          fields: [
            idField(),
            field('v', { default: { kind: 'literal', value: 'a;b' } }),
          ],
        }),
      ])
    );
    // The tag escapes the backslash, which GORM reads as an escaped semicolon.
    expect(member(source(output, 't'), 'V')).toBe(
      'string `gorm:"not null;default:a\\\\;b"`'
    );
  });

  it('writes enum defaults by value or by name', () => {
    expect(
      tags(
        field('v', {
          enumName: 'Status',
          default: { kind: 'enumValue', value: 'LIVE' },
        })
      )
    ).toEqual(['not null', 'default:live']);
    expect(
      tags(
        field('v', {
          enumName: 'Status',
          default: { kind: 'literal', value: 'draft' },
        })
      )
    ).toEqual(['not null', 'default:draft']);
  });

  it('warns and drops a default that does not fit', () => {
    const output: MultiFileEmitOutput = emit(
      schemaOf(
        [
          model('T', {
            fields: [
              idField(),
              field('a', {
                enumName: 'Status',
                default: { kind: 'enumValue', value: 'GONE' },
              }),
              field('b', {
                type: 'bytes',
                default: { kind: 'literal', value: 'x' },
              }),
              field('c', { type: 'boolean', default: { kind: 'now' } }),
              field('d', { type: 'int', default: { kind: 'uuid' } }),
              field('e', {
                type: 'string',
                default: { kind: 'autoIncrement' },
              }),
            ],
          }),
        ],
        [STATUS]
      )
    );
    expect(output.warnings).toEqual([
      'T.a: the enum default "GONE" does not match a value of the enum; it was dropped.',
      'T.b: a literal default on a bytes column cannot be represented; it was dropped.',
      'T.c: a "now" default needs a date or time column; it was dropped.',
      'T.d: a UUID default needs a uuid or string column; it was dropped.',
      'T.e: an auto-increment default is only supported on integer columns; it was dropped.',
    ]);
  });

  it('writes now defaults as autoCreateTime, and database defaults as a default expression', () => {
    expect(
      tags(field('v', { type: 'dateTime', default: { kind: 'now' } }))
    ).toEqual(['not null', 'autoCreateTime']);
    expect(
      tags(
        field('v', {
          type: 'dateTime',
          default: { kind: 'now' },
          isDbDefault: true,
        })
      )
    ).toEqual(['not null', 'autoCreateTime', 'default:CURRENT_TIMESTAMP']);
    expect(
      tags(field('v', { type: 'string', default: { kind: 'now' } }))
    ).toEqual(['not null', 'default:CURRENT_TIMESTAMP']);
  });

  it('writes autoUpdateTime for auto-updated timestamps and warns for other types', () => {
    expect(tags(field('v', { type: 'dateTime', isAutoUpdated: true }))).toEqual(
      ['not null', 'autoUpdateTime']
    );
    const output: MultiFileEmitOutput = emit(
      schemaOf([
        model('T', {
          fields: [idField(), field('v', { type: 'int', isAutoUpdated: true })],
        }),
      ])
    );
    expect(output.warnings).toContain(
      'T.v: an auto-updated field must be a date or time column; it was written as a plain column.'
    );
  });

  it('writes database default expressions and leaves Prisma functions to the shared warning', () => {
    const output: MultiFileEmitOutput = emit(
      schemaOf([
        model('T', {
          fields: [
            idField(),
            field('a', {
              type: 'uuid',
              default: {
                kind: 'dbExpression',
                expression: 'gen_random_uuid()',
              },
            }),
            field('b', {
              type: 'int',
              default: {
                kind: 'dbExpression',
                expression: 'auto()',
                isFunction: true,
              },
            }),
            field('c', {
              default: { kind: 'clientGenerated', generator: 'cuid' },
            }),
          ],
        }),
      ])
    );
    const text: string = source(output, 't');
    expect(entries(text, 'A')).toContain('default:gen_random_uuid()');
    expect(entries(text, 'B')).not.toContain('default:auto()');
    expect(output.warnings).toEqual([
      'T.b: the database default expression auto() was dropped.',
      'T.c: the cuid() default is generated by Prisma Client and was dropped.',
    ]);
  });

  it('warns about generated columns', () => {
    const output: MultiFileEmitOutput = emit(
      schemaOf([
        model('T', {
          fields: [
            idField(),
            field('total', {
              type: 'int',
              generated: { expression: 'F("a") + F("b")', isStored: true },
            }),
          ],
        }),
      ])
    );
    expect(output.warnings).toContain(
      'T.total: the generated column expression F("a") + F("b") is not SQL GORM can run; the field was written as a regular column.'
    );
  });
});

describe('gorm emitter: UUID defaults', () => {
  const uuidModel: IrModel = model('T', {
    tableName: 't',
    fields: [
      field('id', {
        type: 'uuid',
        isPrimaryKey: true,
        default: { kind: 'uuid' },
      }),
      field('ref', {
        type: 'uuid',
        isNullable: true,
        default: { kind: 'uuid' },
      }),
      field('slug', { default: { kind: 'uuid' } }),
    ],
  });

  it('uses gen_random_uuid() on PostgreSQL and no hook', () => {
    const text: string = source(emit(schemaOf([uuidModel])), 't');
    expect(entries(text, 'ID')).toEqual([
      'type:uuid',
      'primaryKey',
      'default:gen_random_uuid()',
    ]);
    expect(entries(text, 'Ref')).toContain('default:gen_random_uuid()');
    expect(text).not.toContain('BeforeCreate');
    expect(text).not.toContain('gorm.io/gorm');
  });

  it('writes a BeforeCreate hook on other providers', () => {
    for (const provider of ['sqlite', 'mysql', 'sqlserver'] as const) {
      const text: string = source(
        emit(schemaOf([uuidModel]), { provider }),
        't'
      );
      expect(entries(text, 'ID'), provider).not.toContain(
        'default:gen_random_uuid()'
      );
      expect(text, provider).toContain(
        [
          'func (t *T) BeforeCreate(tx *gorm.DB) error {',
          '\tif t.ID == uuid.Nil {',
          '\t\tt.ID = uuid.New()',
          '\t}',
          '\tif t.Ref == nil {',
          '\t\tid := uuid.New()',
          '\t\tt.Ref = &id',
          '\t}',
          '\tif t.Slug == "" {',
          '\t\tt.Slug = uuid.NewString()',
          '\t}',
          '\treturn nil',
          '}',
        ].join('\n')
      );
      expect(text).toContain('"github.com/google/uuid"');
      expect(text).toContain('"gorm.io/gorm"');
    }
  });

  it('generates version 7 UUIDs in the hook on every provider', () => {
    const v7: IrModel = model('T', {
      fields: [
        field('id', {
          type: 'uuid',
          isPrimaryKey: true,
          default: { kind: 'uuid', version: 7 },
        }),
      ],
    });
    const text: string = source(emit(schemaOf([v7])), 't');
    expect(text).toContain(
      [
        '\tif t.ID == uuid.Nil {',
        '\t\tid, err := uuid.NewV7()',
        '\t\tif err != nil {',
        '\t\t\treturn err',
        '\t\t}',
        '\t\tt.ID = id',
        '\t}',
      ].join('\n')
    );
    expect(entries(text, 'ID')).not.toContain('default:gen_random_uuid()');
  });

  it('warns about UUID versions it cannot reproduce', () => {
    const v1: IrModel = model('T', {
      fields: [
        field('id', {
          type: 'uuid',
          isPrimaryKey: true,
          default: { kind: 'uuid', version: 1 },
        }),
      ],
    });
    expect(emit(schemaOf([v1])).warnings).toContain(
      'T.id: a version 1 UUID default was written as a random (version 4) UUID.'
    );
  });
});

describe('gorm emitter: gorm.Model and soft delete', () => {
  function modelShape(overrides: Partial<IrModel> = {}): IrModel {
    return model('Account', {
      tableName: 'accounts',
      fields: [
        idField({ type: 'bigInt' }),
        field('created_at', { type: 'dateTime', default: { kind: 'now' } }),
        field('updated_at', { type: 'dateTime', isAutoUpdated: true }),
        field('deleted_at', { type: 'dateTime', isNullable: true }),
        field('email'),
      ],
      indexes: [index(['deleted_at'])],
      ...overrides,
    });
  }

  it('embeds gorm.Model when the model has exactly its columns', () => {
    const output: MultiFileEmitOutput = emit(schemaOf([modelShape()]));
    const text: string = source(output, 'account');
    expect(text).toContain(
      [
        'type Account struct {',
        '\tgorm.Model',
        '\tEmail string `gorm:"not null"`',
        '}',
      ].join('\n')
    );
    expect(text).not.toContain('CreatedAt');
    expect(text).toContain('"gorm.io/gorm"');
    expect(text).not.toContain('"time"');
    expect(output.warnings).toEqual([]);
  });

  it('does not embed when a column differs from gorm.Model', () => {
    const variants: Partial<Record<string, (m: IrModel) => IrModel>> = {
      'int id': (m) => ({
        ...m,
        fields: m.fields.map((f) =>
          f.name === 'id' ? { ...f, type: 'int' as const } : f
        ),
      }),
      'id without auto-increment': (m) => ({
        ...m,
        fields: m.fields.map((f) =>
          f.name === 'id' ? { ...f, default: undefined } : f
        ),
      }),
      'not auto-updated': (m) => ({
        ...m,
        fields: m.fields.map((f) =>
          f.name === 'updated_at' ? { ...f, isAutoUpdated: false } : f
        ),
      }),
      'required deleted_at': (m) => ({
        ...m,
        fields: m.fields.map((f) =>
          f.name === 'deleted_at' ? { ...f, isNullable: false } : f
        ),
      }),
      'unindexed deleted_at': (m) => ({ ...m, indexes: [] }),
      'unique index on deleted_at': (m) => ({
        ...m,
        indexes: [index(['deleted_at'], { isUnique: true })],
      }),
      'named index on deleted_at': (m) => ({
        ...m,
        indexes: [index(['deleted_at'], { name: 'idx_x' })],
      }),
      'missing created_at': (m) => ({
        ...m,
        fields: m.fields.filter((f) => f.name !== 'created_at'),
      }),
      'extra primary key': (m) => ({
        ...m,
        fields: [...m.fields, field('code', { isPrimaryKey: true })],
      }),
      'composite key': (m) => ({ ...m, compositePrimaryKey: ['id', 'email'] }),
      'created_at with another column name': (m) => ({
        ...m,
        fields: m.fields.map((f) =>
          f.name === 'created_at' ? { ...f, columnName: 'made' } : f
        ),
      }),
    };
    for (const [name, change] of Object.entries(variants)) {
      const text: string = source(
        emit(schemaOf([change?.(modelShape()) ?? modelShape()])),
        'account'
      );
      expect(text, name).not.toContain('gorm.Model');
    }
  });

  it('writes a nullable deleted_at as gorm.DeletedAt with a warning', () => {
    const output: MultiFileEmitOutput = emit(
      schemaOf([
        model('Session', {
          fields: [
            idField(),
            field('deleted_at', { type: 'dateTime', isNullable: true }),
          ],
          indexes: [index(['deleted_at'])],
        }),
      ])
    );
    const text: string = source(output, 'session');
    expect(member(text, 'DeletedAt')).toBe('gorm.DeletedAt `gorm:"index"`');
    expect(output.warnings).toContain(
      'Session.deleted_at: a nullable deleted_at timestamp was written as gorm.DeletedAt, so GORM treats Session as soft-deleted: queries skip rows where it is set and Delete only sets it.'
    );
  });

  it('keeps a required or defaulted deleted_at a plain timestamp', () => {
    const output: MultiFileEmitOutput = emit(
      schemaOf([
        model('A', {
          fields: [idField(), field('deleted_at', { type: 'dateTime' })],
        }),
      ])
    );
    expect(member(source(output, 'a'), 'DeletedAt')).toBe(
      'time.Time `gorm:"not null"`'
    );
  });

  it('keeps promoted gorm.Model names free for other members', () => {
    const output: MultiFileEmitOutput = emit(
      schemaOf([
        modelShape({
          fields: [
            ...modelShape().fields,
            field('model'),
            field('ID_', { columnName: 'legacy_id' }),
          ],
        }),
      ])
    );
    const text: string = source(output, 'account');
    expect(text).toMatch(/^\tModel2\s/m);
  });
});

describe('gorm emitter: relations', () => {
  const user: IrModel = model('User', { tableName: 'users' });

  it('writes a belongs-to with its foreign key, and the has-many on the target', () => {
    const post: IrModel = model('Post', {
      tableName: 'posts',
      relations: [relation('author', 'User', { relatedName: 'posts' })],
    });
    const output: MultiFileEmitOutput = emit(schemaOf([user, post]));
    const postText: string = source(output, 'post');
    expect(member(postText, 'AuthorID')).toBe('int32 `gorm:"not null"`');
    expect(member(postText, 'Author')).toBe(
      'User `gorm:"foreignKey:AuthorID;constraint:OnDelete:CASCADE"`'
    );
    expect(member(source(output, 'user'), 'Posts')).toBe(
      '[]Post `gorm:"foreignKey:AuthorID;constraint:OnDelete:CASCADE"`'
    );
    // Columns come first, then a blank line, then the associations.
    expect(postText).toContain('`gorm:"not null"`\n\n\tAuthor ');
  });

  it('names an unnamed reverse relation after the plural of the model', () => {
    const output: MultiFileEmitOutput = emit(
      schemaOf([
        user,
        model('Category', { tableName: 'categories' }),
        model('Post', {
          tableName: 'posts',
          relations: [
            relation('author', 'User'),
            relation('category', 'Category'),
          ],
        }),
        model('Profile', {
          tableName: 'profiles',
          relations: [relation('user', 'User', { kind: 'oneToOne' })],
        }),
      ])
    );
    const userText: string = source(output, 'user');
    expect(userText).toMatch(/^\tPosts\s+\[\]Post\s/m);
    expect(userText).toMatch(/^\tProfile\s+\*Profile\s/m);
    expect(source(output, 'category')).toMatch(/^\tPosts\s+\[\]Post\s/m);
  });

  it('uses a pointer for nullable, self-referencing and recursive belongs-to relations', () => {
    const a: IrModel = model('A', {
      tableName: 'as',
      relations: [
        relation('parent', 'A'),
        relation('b', 'B'),
        relation('maybe', 'User', { isNullable: true, onDelete: 'setNull' }),
      ],
    });
    const b: IrModel = model('B', {
      tableName: 'bs',
      relations: [relation('a', 'A')],
    });
    const output: MultiFileEmitOutput = emit(schemaOf([a, b, user]));
    const aText: string = source(output, 'a');
    expect(member(aText, 'Parent')).toMatch(/^\*A /);
    // A holds B by value, so B must hold A by pointer to keep the types finite.
    expect(member(aText, 'B')).toMatch(/^B /);
    expect(member(source(output, 'b'), 'A')).toMatch(/^\*A /);
    expect(member(aText, 'Maybe')).toMatch(/^\*User /);
    expect(member(aText, 'MaybeID')).toBe('*int32');
  });

  it('writes a has-one for a one-to-one with a unique foreign key', () => {
    const profile: IrModel = model('Profile', {
      tableName: 'profiles',
      relations: [
        relation('user', 'User', { kind: 'oneToOne', relatedName: 'profile' }),
      ],
    });
    const output: MultiFileEmitOutput = emit(schemaOf([user, profile]));
    expect(entries(source(output, 'profile'), 'UserID')).toEqual([
      'not null',
      'unique',
    ]);
    expect(member(source(output, 'user'), 'Profile')).toBe(
      '*Profile `gorm:"foreignKey:UserID;constraint:OnDelete:CASCADE"`'
    );
  });

  it('writes referential actions on both sides, with onUpdate and constraint names', () => {
    const post: IrModel = model('Post', {
      tableName: 'posts',
      relations: [
        relation('a', 'User', {
          onDelete: 'setNull',
          isNullable: true,
          relatedName: 'as',
        }),
        relation('b', 'User', {
          onDelete: 'restrict',
          onUpdate: 'cascade',
          relatedName: 'bs',
        }),
        relation('c', 'User', { onDelete: 'noAction', relatedName: 'cs' }),
        relation('d', 'User', { onDelete: 'setDefault', relatedName: 'ds' }),
        relation('e', 'User', {
          onDelete: 'cascade',
          onUpdate: 'noAction',
          constraintName: 'fk_named',
          relatedName: 'es',
        }),
        relation('f', 'User', {
          onDelete: 'noAction',
          onUpdate: 'setNull',
          constraintName: 'has1digit',
          relatedName: 'fs',
        }),
        relation('g', 'User', {
          onDelete: 'cascade',
          constraintName: 'fk_ok-name',
          relatedName: 'gs',
        }),
      ],
    });
    const output: MultiFileEmitOutput = emit(schemaOf([user, post]));
    const text: string = source(output, 'post');
    expect(member(text, 'A')).toContain('constraint:OnDelete:SET NULL"');
    expect(member(text, 'B')).toContain(
      'constraint:OnUpdate:CASCADE,OnDelete:RESTRICT"'
    );
    expect(member(text, 'C')).not.toContain('constraint');
    expect(member(text, 'D')).toContain('constraint:OnDelete:SET DEFAULT"');
    expect(member(text, 'E')).toContain(
      'constraint:fk_named,OnDelete:CASCADE"'
    );
    expect(member(text, 'F')).toContain('constraint:OnUpdate:SET NULL"');
    expect(member(text, 'G')).toContain(
      'constraint:fk_ok-name,OnDelete:CASCADE"'
    );
    const userText: string = source(output, 'user');
    expect(member(userText, 'Bs')).toContain(
      'constraint:OnUpdate:CASCADE,OnDelete:RESTRICT"'
    );
    // onUpdate is written, so the shared "not supported" warning is dropped.
    expect(
      output.warnings.some((warning) => warning.includes('onUpdate'))
    ).toBe(false);
  });

  it('warns about SET NULL on a required relation', () => {
    const post: IrModel = model('Post', {
      relations: [relation('author', 'User', { onDelete: 'setNull' })],
    });
    expect(emit(schemaOf([user, post])).warnings).toContain(
      'Post.author: onDelete SET NULL on a required relation will fail at the database level; review the relation.'
    );
  });

  it('writes references for a relation that targets a non-key column', () => {
    const target: IrModel = model('Tenant', {
      tableName: 'tenants',
      fields: [idField(), field('code', { isUnique: true, maxLength: 12 })],
    });
    const post: IrModel = model('Post', {
      tableName: 'posts',
      relations: [
        relation('tenant', 'Tenant', {
          toField: 'code',
          columnName: 'tenant_code',
          relatedName: 'posts',
        }),
      ],
    });
    const output: MultiFileEmitOutput = emit(schemaOf([target, post]));
    const postText: string = source(output, 'post');
    expect(member(postText, 'TenantCode')).toBe(
      'string `gorm:"size:12;not null"`'
    );
    expect(member(postText, 'Tenant')).toBe(
      'Tenant `gorm:"foreignKey:TenantCode;references:Code;constraint:OnDelete:CASCADE"`'
    );
    expect(member(source(output, 'tenant'), 'Posts')).toBe(
      '[]Post `gorm:"foreignKey:TenantCode;references:Code;constraint:OnDelete:CASCADE"`'
    );
  });

  it('gives a foreign key the type and column options of a UUID key', () => {
    const target: IrModel = model('Org', {
      tableName: 'orgs',
      fields: [field('id', { type: 'uuid', isPrimaryKey: true })],
    });
    const member1: IrModel = model('Member', {
      tableName: 'members',
      relations: [
        relation('org', 'Org', { isNullable: true, onDelete: 'setNull' }),
      ],
    });
    const postgres: string = source(
      emit(schemaOf([target, member1])),
      'member'
    );
    expect(member(postgres, 'OrgID')).toBe('*uuid.UUID `gorm:"type:uuid"`');
    const sqlite: string = source(
      emit(schemaOf([target, member1]), { provider: 'sqlite' }),
      'member'
    );
    expect(member(sqlite, 'OrgID')).toBe('*uuid.UUID');
  });

  it('writes keyed relations as part of the primary key', () => {
    const output: MultiFileEmitOutput = emit(
      schemaOf([
        user,
        model('Group', { tableName: 'groups' }),
        model('Membership', {
          tableName: 'memberships',
          fields: [],
          relations: [relation('user', 'User'), relation('group', 'Group')],
          compositePrimaryKey: ['user', 'group'],
        }),
        model('Detail', {
          tableName: 'details',
          fields: [],
          relations: [
            relation('user', 'User', { kind: 'oneToOne', isPrimaryKey: true }),
          ],
        }),
      ])
    );
    const membership: string = source(output, 'membership');
    expect(entries(membership, 'UserID')).toEqual(['primaryKey']);
    expect(entries(membership, 'GroupID')).toEqual(['primaryKey']);
    const detail: string = source(output, 'detail');
    expect(entries(detail, 'UserID')).toEqual([
      'primaryKey',
      'autoIncrement:false',
    ]);
    expect(output.warnings.filter((w) => w.includes('no primary key'))).toEqual(
      []
    );
  });

  it('follows multi-table inheritance to the key of the parent', () => {
    const output: MultiFileEmitOutput = emit(
      schemaOf([
        model('Parent', {
          tableName: 'parents',
          fields: [field('id', { type: 'uuid', isPrimaryKey: true })],
        }),
        model('Child', {
          tableName: 'children',
          fields: [],
          relations: [
            relation('parent', 'Parent', {
              kind: 'oneToOne',
              isPrimaryKey: true,
            }),
          ],
        }),
        model('Toy', {
          tableName: 'toys',
          relations: [relation('child', 'Child')],
        }),
      ])
    );
    expect(member(source(output, 'toy'), 'ChildID')).toBe(
      'uuid.UUID `gorm:"type:uuid;not null"`'
    );
  });

  it('skips relations whose target is missing or has no usable key', () => {
    const output: MultiFileEmitOutput = emit(
      schemaOf([
        model('Keyless', { fields: [field('x')] }),
        model('Composite', {
          fields: [
            field('a', { isPrimaryKey: true }),
            field('b', { isPrimaryKey: true }),
          ],
          compositePrimaryKey: ['a', 'b'],
        }),
        model('Post', {
          relations: [
            relation('ghost', 'Ghost'),
            relation('keyless', 'Keyless'),
            relation('composite', 'Composite'),
            relation('tags', 'Keyless', { kind: 'manyToMany' }),
          ],
        }),
      ])
    );
    const text: string = source(output, 'post');
    expect(text).not.toContain('Ghost');
    expect(text).not.toContain('Keyless');
    expect(text).not.toContain('Composite');
    expect(output.warnings).toEqual(
      expect.arrayContaining([
        'Post.ghost: target model "Ghost" does not exist in the schema; the relation was skipped.',
        'Post.keyless: target model "Keyless" has no single-column primary key to reference; the relation was skipped.',
        'Post.composite: target model "Composite" has no single-column primary key to reference; the relation was skipped.',
        'Post.tags: Keyless has no single-column primary key to reference from a join table; the relation was skipped.',
      ])
    );
  });

  it('keeps names unique when a relation clashes with a column or another association', () => {
    const output: MultiFileEmitOutput = emit(
      schemaOf([
        user,
        model('Post', {
          tableName: 'posts',
          fields: [idField(), field('author')],
          relations: [relation('author', 'User', { relatedName: 'posts' })],
        }),
      ])
    );
    const text: string = source(output, 'post');
    expect(text).toMatch(/^\tAuthor\s+string/m);
    expect(text).toMatch(/^\tAuthor2\s+User/m);
    expect(entries(text, 'AuthorID')).toEqual(['not null']);
    expect(member(text, 'Author2')).toContain('foreignKey:AuthorID');
  });
});

describe('gorm emitter: many-to-many', () => {
  const tag: IrModel = model('Tag', { tableName: 'tags' });

  it('writes both sides with the join table and cascading actions', () => {
    const post: IrModel = model('Post', {
      tableName: 'posts',
      relations: [
        relation('tags', 'Tag', { kind: 'manyToMany', relatedName: 'posts' }),
      ],
    });
    const output: MultiFileEmitOutput = emit(schemaOf([post, tag]));
    expect(member(source(output, 'post'), 'Tags')).toBe(
      '[]Tag `gorm:"many2many:posts_tags;constraint:OnDelete:CASCADE"`'
    );
    expect(member(source(output, 'tag'), 'Posts')).toBe(
      '[]Post `gorm:"many2many:posts_tags;constraint:OnDelete:CASCADE"`'
    );
  });

  it("adds joinForeignKey and joinReferences when the join columns differ from GORM's", () => {
    const post: IrModel = model('Post', {
      tableName: 'posts',
      fields: [field('uid', { type: 'uuid', isPrimaryKey: true })],
      relations: [
        relation('tags', 'Tag', { kind: 'manyToMany', relatedName: 'posts' }),
      ],
    });
    const output: MultiFileEmitOutput = emit(schemaOf([post, tag]));
    expect(member(source(output, 'post'), 'Tags')).toBe(
      '[]Tag `gorm:"many2many:posts_tags;joinForeignKey:post_id;constraint:OnDelete:CASCADE"`'
    );
    expect(member(source(output, 'tag'), 'Posts')).toBe(
      '[]Post `gorm:"many2many:posts_tags;joinReferences:post_id;constraint:OnDelete:CASCADE"`'
    );
  });

  it('names both join columns of a self-referencing relation', () => {
    const group: IrModel = model('Group', {
      tableName: 'groups',
      relations: [
        relation('friends', 'Group', {
          kind: 'manyToMany',
          relatedName: 'friend_of',
        }),
      ],
    });
    const output: MultiFileEmitOutput = emit(schemaOf([group]));
    const text: string = source(output, 'group');
    expect(member(text, 'Friends')).toBe(
      '[]Group `gorm:"many2many:groups_friends;joinForeignKey:from_group_id;joinReferences:to_group_id;constraint:OnDelete:CASCADE"`'
    );
    expect(member(text, 'FriendOf')).toBe(
      '[]Group `gorm:"many2many:groups_friends;joinForeignKey:to_group_id;joinReferences:from_group_id;constraint:OnDelete:CASCADE"`'
    );
  });

  it('warns about join table names GORM would rewrite', () => {
    const post: IrModel = model('Post', {
      tableName: 'Posts',
      relations: [relation('tags', 'Tag', { kind: 'manyToMany' })],
    });
    expect(emit(schemaOf([post, tag])).warnings).toContain(
      'Post.tags: GORM lower-cases and pluralizes a join table name that has capital letters, so "Posts_tags" will not be used as written.'
    );
  });
});

describe('gorm emitter: indexes', () => {
  function indexed(
    indexes: ReturnType<typeof index>[],
    extraFields = ['a', 'b', 'c']
  ): string {
    return source(
      emit(
        schemaOf([
          model('T', {
            tableName: 'ts',
            fields: [idField(), ...extraFields.map((name) => field(name))],
            indexes,
          }),
        ])
      ),
      't'
    );
  }

  it('writes single-column indexes on the field', () => {
    const text: string = indexed([
      index(['a']),
      index(['b'], { isUnique: true }),
      index(['c'], { name: 'idx_c' }),
    ]);
    expect(entries(text, 'A')).toEqual(['not null', 'index']);
    expect(entries(text, 'B')).toEqual(['not null', 'uniqueIndex']);
    expect(entries(text, 'C')).toEqual(['not null', 'index:idx_c']);
  });

  it('joins composite indexes through one name with priorities', () => {
    const text: string = indexed([
      index(['b', 'a']),
      index(['a', 'c'], { isUnique: true }),
      index(['c', 'b'], { name: 'by_cb' }),
    ]);
    expect(entries(text, 'A')).toEqual([
      'not null',
      'index:idx_ts_b_a,priority:2',
      'uniqueIndex:uni_ts_a_c,priority:1',
    ]);
    expect(entries(text, 'B')).toEqual([
      'not null',
      'index:idx_ts_b_a,priority:1',
      'index:by_cb,priority:2',
    ]);
    expect(entries(text, 'C')).toEqual([
      'not null',
      'uniqueIndex:uni_ts_a_c,priority:2',
      'index:by_cb,priority:1',
    ]);
  });

  it('resolves relation names and column names, and skips what it cannot place', () => {
    const output: MultiFileEmitOutput = emit(
      schemaOf([
        model('User'),
        model('Post', {
          tableName: 'posts',
          fields: [idField(), field('title', { columnName: 'headline' })],
          relations: [relation('author', 'User')],
          indexes: [
            index(['author', 'headline'], { isUnique: true }),
            index(['nope']),
            index(['author']),
          ],
        }),
      ])
    );
    const text: string = source(output, 'post');
    expect(entries(text, 'AuthorID')).toEqual([
      'not null',
      'uniqueIndex:uni_posts_author_id_headline,priority:1',
      'index',
    ]);
    expect(entries(text, 'Title')).toEqual([
      'column:headline',
      'not null',
      'uniqueIndex:uni_posts_author_id_headline,priority:2',
    ]);
    expect(output.warnings).toContain(
      'Post index (nope): "nope" is not a column of the model (or belongs to gorm.Model); the index was skipped.'
    );
  });

  it('does not repeat a unique index the column already has', () => {
    const output: MultiFileEmitOutput = emit(
      schemaOf([
        model('T', {
          tableName: 'ts',
          fields: [idField(), field('code', { isUnique: true })],
          indexes: [index(['code'], { isUnique: true })],
        }),
      ])
    );
    expect(entries(source(output, 't'), 'Code')).toEqual([
      'not null',
      'unique',
    ]);
  });

  it('keeps reporting index options GORM cannot take from the shared warnings', () => {
    const output: MultiFileEmitOutput = emit(
      schemaOf([
        model('T', {
          fields: [idField(), field('a')],
          indexes: [index(['a'], { method: 'Gin' })],
        }),
      ])
    );
    expect(output.warnings).toContain(
      'T index (a): the index type, clustering, sort order, prefix length and operator class options were dropped.'
    );
  });
});

describe('gorm emitter: enums', () => {
  it('writes a typed string with a const block and labels', () => {
    const output: MultiFileEmitOutput = emit(schemaOf([model('A')], [STATUS]));
    expect(source(output, 'status')).toBe(
      [
        'package models',
        '',
        '// Status is a database enum, stored as text.',
        'type Status string',
        '',
        'const (',
        '\tStatusDraft Status = "draft" // Draft',
        '\tStatusLive  Status = "live"',
        ')',
        '',
      ].join('\n')
    );
  });

  it('uses the enum type for columns and keeps constants clear of other names', () => {
    const output: MultiFileEmitOutput = emit(
      schemaOf(
        [
          model('StatusDraft'),
          model('A', {
            fields: [
              idField(),
              field('status', { enumName: 'Status', maxLength: 9 }),
              field('maybe', { enumName: 'Status', isNullable: true }),
            ],
          }),
        ],
        [STATUS]
      )
    );
    const text: string = source(output, 'a');
    expect(member(text, 'Status')).toBe('Status `gorm:"size:9;not null"`');
    expect(member(text, 'Maybe')).toBe('*Status');
    // The model StatusDraft owns that name, so the constant gets a suffix.
    expect(source(output, 'status')).toContain('StatusDraft2 Status = "draft"');
  });

  it('writes enum arrays as JSON slices of the enum type', () => {
    const output: MultiFileEmitOutput = emit(
      schemaOf(
        [
          model('A', {
            fields: [
              idField(),
              field('all', { enumName: 'Status', arrayDepth: 1 }),
            ],
          }),
        ],
        [STATUS]
      )
    );
    expect(member(source(output, 'a'), 'All')).toBe(
      'datatypes.JSONSlice[Status] `gorm:"not null"`'
    );
  });

  it('falls back to a string for an unknown enum and handles empty enums', () => {
    const output: MultiFileEmitOutput = emit(
      schemaOf(
        [
          model('A', {
            fields: [idField(), field('s', { enumName: 'Missing' })],
          }),
        ],
        [{ name: 'Empty', values: [] }]
      )
    );
    expect(member(source(output, 'a'), 'S')).toBe('string `gorm:"not null"`');
    expect(output.warnings).toContain(
      'A.s: enum "Missing" does not exist in the schema; the column was written as a plain string.'
    );
    expect(source(output, 'empty')).not.toContain('const');
  });
});

describe('gorm emitter: structural coverage check', () => {
  it('reports a missing struct, column, join table tag and enum', () => {
    const schema: IrSchema = schemaOf(
      [
        model('Post', {
          tableName: 'posts',
          fields: [idField(), field('title')],
          relations: [
            relation('author', 'User'),
            relation('tags', 'Tag', { kind: 'manyToMany' }),
          ],
        }),
        model('User', { tableName: 'users' }),
        model('Tag', { tableName: 'tags' }),
      ],
      [STATUS]
    );
    const files: Record<string, string> = emit(schema).files;
    expect(checkGormOutput(schema, files)).toEqual([]);

    const broken: Record<string, string> = { ...files };
    delete broken['models/user.go'];
    delete broken['models/status.go'];
    broken['models/post.go'] = (broken['models/post.go'] ?? '')
      .replace(/\tTitle .*\n/, '')
      .replace(/many2many:posts_tags/, 'many2many:other');
    expect(checkGormOutput(schema, broken)).toEqual([
      'Post: no field for column title',
      'Post.tags: no many2many:posts_tags association',
      'User: no struct for table users',
      'enum Status: no string type',
    ]);
  });
});

describe('gorm emitter: edge cases', () => {
  it('writes a model without fields as an empty struct', () => {
    const output: MultiFileEmitOutput = emit(
      schemaOf([model('Empty', { tableName: 'empties', fields: [] })])
    );
    expect(source(output, 'empty')).toContain('type Empty struct{}\n');
  });

  it('gives a type that clashes with an enum a numeric suffix', () => {
    const output: MultiFileEmitOutput = emit(
      schemaOf([model('Status', { tableName: 'statuses' })], [STATUS])
    );
    expect(Object.keys(output.files).sort()).toEqual([
      'models/status.go',
      'models/status2.go',
    ]);
    expect(source(output, 'status')).toContain('type Status struct');
    expect(source(output, 'status2')).toContain('type Status2 string');
  });
});

describe('gorm emitter: imports', () => {
  it('imports only what a file uses, sorted gofmt style in two groups', () => {
    const output: MultiFileEmitOutput = emit(
      schemaOf([
        model('Plain', { fields: [idField(), field('name')] }),
        model('Timed', {
          fields: [idField(), field('at', { type: 'dateTime' })],
        }),
        model('Everything', {
          fields: [
            idField(),
            field('at', { type: 'dateTime' }),
            field('u', { type: 'uuid' }),
            field('d', { type: 'decimal', maxDigits: 3, decimalPlaces: 1 }),
            field('j', { type: 'json' }),
            field('x', { type: 'dateTime', isNullable: true }),
          ],
          indexes: [],
        }),
        model('Soft', {
          fields: [
            idField(),
            field('deleted_at', { type: 'dateTime', isNullable: true }),
          ],
        }),
      ])
    );
    expect(source(output, 'plain')).not.toContain('import');
    expect(source(output, 'timed')).toContain('import "time"\n');
    expect(source(output, 'everything')).toContain(
      [
        'import (',
        '\t"time"',
        '',
        '\t"github.com/google/uuid"',
        '\t"github.com/shopspring/decimal"',
        '\t"gorm.io/datatypes"',
        ')',
      ].join('\n')
    );
    expect(source(output, 'soft')).toContain('import "gorm.io/gorm"\n');
  });
});

describe('gorm emitter: naming modes', () => {
  it('normalize applies GORM conventions: plural tables, snake columns and timestamps', async () => {
    const result = await convertCanonical('django', 'gorm', {
      naming: 'normalize',
    });
    const files: Record<string, string> = result.files ?? {};
    expect(Object.keys(files).sort()).toEqual([
      'models/category.go',
      'models/post.go',
      'models/post_status.go',
      'models/profile.go',
      'models/tag.go',
      'models/user.go',
    ]);
    const post: string = files['models/post.go'] ?? '';
    expect(post).toContain('// Post maps to the "posts" table.');
    expect(post).not.toContain('TableName');
    expect(files['models/tag.go']).toContain('CreatedAt');
    expect(files['models/tag.go']).toContain('UpdatedAt');
  });

  it('preserve keeps the source table names with TableName()', async () => {
    const result = await convertCanonical('django', 'gorm', {
      naming: 'preserve',
    });
    const post: string = result.files?.['models/post.go'] ?? '';
    expect(post).toContain('// Post maps to the "blog_post" table.');
    expect(post).toContain('return "blog_post"');
  });

  it('normalizeGormSchema leaves join tables and key types alone', () => {
    const normalized: IrSchema = normalizeGormSchema(
      schemaOf([
        model('PostTag', { tableName: 'blog_post_tag', isJoinTable: true }),
        model('Person', { tableName: 'Person' }),
      ])
    );
    expect(normalized.models.map((m) => m.tableName)).toEqual([
      'blog_post_tag',
      'people',
    ]);
    expect(normalized.models[1]?.fields[0]?.type).toBe('int');
    expect(normalized.models[0]?.fields.map((f) => f.name)).toEqual(['id']);
    expect(normalized.models[1]?.fields.map((f) => f.name)).toEqual([
      'id',
      'created_at',
      'updated_at',
    ]);
  });
});

describe('gorm emitter: shared warnings', () => {
  it('starts with the Prisma-only construct warnings', () => {
    const output: MultiFileEmitOutput = emit(
      schemaOf([model('V', { isView: true }), model('S', { schema: 'audit' })])
    );
    expect(output.warnings).toEqual([
      'V: this is a database view; it was written like a regular table model, so migrations would try to create a table.',
      'S: the database schema "audit" (@@schema) was ignored.',
    ]);
  });

  it('is deterministic', () => {
    const first: MultiFileEmitOutput = emit(kitchenSinkSchema(), {
      provider: 'sqlite',
    });
    const second: MultiFileEmitOutput = emit(kitchenSinkSchema(), {
      provider: 'sqlite',
    });
    expect(second).toEqual(first);
  });

  it('writes struct tags that contain backticks or control characters as string literals', () => {
    const output: MultiFileEmitOutput = emit(
      schemaOf([
        model('T', {
          fields: [
            idField(),
            field('a', { default: { kind: 'literal', value: 'x`y' } }),
            field('b', { default: { kind: 'literal', value: 'x"y' } }),
            field('c', { default: { kind: 'literal', value: 'two\nlines' } }),
          ],
        }),
      ])
    );
    const text: string = source(output, 't');
    expect(text).toContain('"gorm:\\"not null;default:x`y\\""');
    expect(text).toContain('`gorm:"not null;default:x\\"y"`');
    expect(text).toContain('"gorm:\\"not null;default:two\\nlines\\""');
  });
});

// ---------------------------------------------------------------------------
// Real Go: gofmt always, go vet and a SQLite AutoMigrate when the modules can be fetched
// ---------------------------------------------------------------------------

const GO_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  // Never download a newer Go toolchain; use the one that is installed.
  GOTOOLCHAIN: 'local',
  GOFLAGS: '-mod=mod',
  GOWORK: 'off',
};

function goAvailable(): boolean {
  const probe: SpawnSyncReturns<string> = spawnSync('go', ['version'], {
    encoding: 'utf8',
  });
  return probe.status === 0;
}

const hasGo: boolean = goAvailable();
const scratch: string[] = [];

afterAll(() => {
  for (const directory of scratch) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function newScratch(prefix: string): string {
  const directory: string = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(directory);
  return directory;
}

function writeFiles(directory: string, files: Record<string, string>): void {
  for (const [path, text] of Object.entries(files)) {
    const target: string = join(directory, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, text);
  }
}

interface GofmtCase {
  name: string;
  files: Record<string, string>;
}

async function gofmtCases(): Promise<GofmtCase[]> {
  const cases: GofmtCase[] = [];
  for (const from of ['django', 'prisma', 'typeorm', 'doctrine', 'laravel']) {
    for (const naming of ['preserve', 'normalize'] as const) {
      for (const provider of [
        'postgresql',
        'mysql',
        'sqlite',
        'sqlserver',
      ] as const) {
        const result = await convertCanonical(from, 'gorm', {
          naming,
          provider,
        });
        cases.push({
          name: `${from} ${naming} ${provider}`,
          files: result.files ?? {},
        });
      }
    }
  }
  for (const provider of [
    'postgresql',
    'mysql',
    'sqlite',
    'sqlserver',
  ] as const) {
    cases.push({
      name: `kitchen sink ${provider}`,
      files: emit(kitchenSinkSchema(), { provider }).files,
    });
    cases.push({
      name: `stress ${provider}`,
      files: emit(stressSchema(), { provider }).files,
    });
  }
  return cases;
}

describe('gorm emitter: gofmt', () => {
  it.skipIf(!hasGo)('leaves every generated file gofmt-clean', async () => {
    const directory: string = newScratch('ormbridge-gofmt-');
    const cases: GofmtCase[] = await gofmtCases();
    cases.forEach((current: GofmtCase, position: number): void => {
      writeFiles(join(directory, `case${position}`), current.files);
    });
    const run: SpawnSyncReturns<string> = spawnSync(
      'gofmt',
      ['-l', directory],
      {
        encoding: 'utf8',
      }
    );
    expect(run.stderr).toBe('');
    // gofmt -l lists the files it would change; none is expected.
    expect(
      run.stdout
        .trim()
        .split('\n')
        .filter((line) => line !== '')
    ).toEqual([]);
    expect(cases.length).toBeGreaterThan(40);
  });
});

// The Go modules are fetched once into a scratch module. When that is not
// possible (no network, or no module proxy), the vet and AutoMigrate tests are
// skipped and the gofmt test above still runs.
const MODULES: string[] = [
  'gorm.io/gorm@v1.31.2',
  'github.com/glebarez/sqlite@v1.11.0',
  'github.com/google/uuid@v1.6.0',
  'github.com/shopspring/decimal@v1.5.0',
  'gorm.io/datatypes@v1.2.7',
  'gorm.io/driver/postgres@v1.5.11',
  'gorm.io/driver/mysql@v1.5.6',
  'gorm.io/driver/sqlserver@v1.6.0',
];
const RUNNER: string = fileURLToPath(
  new URL('./tools/validate-gorm.go', import.meta.url)
);
const BLOG_CHECKS: string = fileURLToPath(
  new URL('./tools/validate-gorm-blog.go', import.meta.url)
);

let moduleDirectory: string | undefined;
let caseCounter: number = 0;

function go(
  directory: string,
  args: string[],
  extraEnv: NodeJS.ProcessEnv = {}
): SpawnSyncReturns<string> {
  return spawnSync('go', args, {
    cwd: directory,
    encoding: 'utf8',
    env: { ...GO_ENV, ...extraEnv },
    timeout: 600_000,
    maxBuffer: 64 * 1024 * 1024,
  });
}

beforeAll(() => {
  if (!hasGo) {
    return;
  }
  const directory: string = newScratch('ormbridge-gormcheck-');
  const init: SpawnSyncReturns<string> = go(directory, [
    'mod',
    'init',
    'gormcheck',
  ]);
  const fetched: SpawnSyncReturns<string> = go(directory, ['get', ...MODULES]);
  if (init.status === 0 && fetched.status === 0) {
    moduleDirectory = directory;
  } else {
    console.warn(
      `Skipping go vet and the SQLite AutoMigrate checks: the Go modules could not be fetched.\n${fetched.stderr}`
    );
  }
}, 900_000);

interface Column {
  name: string;
  type: string;
  notNull: boolean;
  default: string | null;
  primaryKey: number;
}
interface ForeignKey {
  from: string;
  table: string;
  to: string;
  onDelete: string;
  onUpdate: string;
}
interface TableIndex {
  name: string;
  unique: boolean;
  columns: string[];
}
interface Table {
  name: string;
  columns: Column[];
  foreignKeys: ForeignKey[];
  indexes: TableIndex[];
}

interface GoRun {
  tables: Table[];
  ddl: Record<string, string[]>;
}

/**
 * Writes the models into a case directory of the scratch module, vets them,
 * migrates them into SQLite and returns the resulting tables. The same models
 * are also rendered for PostgreSQL, MySQL and SQL Server without a database.
 */
function runModels(
  files: Record<string, string>,
  options: { blogChecks?: boolean; migrate?: boolean } = {}
): GoRun {
  if (moduleDirectory === undefined) {
    throw new Error('The Go scratch module is not available.');
  }
  caseCounter += 1;
  const name: string = `case${caseCounter}`;
  const directory: string = join(moduleDirectory, name);
  writeFiles(directory, files);
  const types: string[] = [];
  for (const text of Object.values(files)) {
    for (const found of text.matchAll(/^type ([A-Z][A-Za-z0-9]*) struct/gm)) {
      types.push(`&models.${found[1] ?? ''}{}`);
    }
  }
  copyFileSync(RUNNER, join(directory, 'main.go'));
  writeFileSync(
    join(directory, 'register.go'),
    [
      'package main',
      '',
      `import "gormcheck/${name}/models"`,
      '',
      'func allModels() []interface{} {',
      `\treturn []interface{}{${types.join(', ')}}`,
      '}',
      '',
    ].join('\n')
  );
  if (options.blogChecks === true) {
    writeFileSync(
      join(directory, 'blog.go'),
      readFileSync(BLOG_CHECKS, 'utf8').replace(
        '"gormcheck/models"',
        `"gormcheck/${name}/models"`
      )
    );
  }
  const vet: SpawnSyncReturns<string> = go(moduleDirectory, [
    'vet',
    `./${name}/...`,
  ]);
  expect(vet.status, `go vet:\n${vet.stdout}${vet.stderr}`).toBe(0);
  const migrate: boolean = options.migrate ?? true;
  const migrated: SpawnSyncReturns<string> = migrate
    ? go(moduleDirectory, ['run', `./${name}`])
    : { ...vet, stdout: '[]' };
  expect(
    migrated.status,
    `AutoMigrate:\n${migrated.stdout}${migrated.stderr}`
  ).toBe(0);
  const rendered: SpawnSyncReturns<string> = go(
    moduleDirectory,
    ['run', `./${name}`],
    { GORMCHECK_DDL: 'postgres,mysql,sqlserver' }
  );
  expect(rendered.status, `DDL:\n${rendered.stdout}${rendered.stderr}`).toBe(0);
  return {
    tables: JSON.parse(migrated.stdout) as Table[],
    ddl: JSON.parse(rendered.stdout) as Record<string, string[]>,
  };
}

const ON_DELETE_SQL: Record<string, string> = {
  cascade: 'CASCADE',
  setNull: 'SET NULL',
  restrict: 'RESTRICT',
  noAction: 'NO ACTION',
  setDefault: 'SET DEFAULT',
};

/** Checks the migrated SQLite schema against the IR the models were generated from. */
function expectSchemaMatches(
  tables: Table[],
  schema: IrSchema,
  label: string,
  exemptNotNull: ReadonlySet<string> = new Set<string>()
): void {
  const byName = (name: string): Table => {
    const found: Table | undefined = tables.find(
      (table) => table.name === name
    );
    if (found === undefined) {
      throw new Error(
        `${label}: no table ${name}. Tables: ${tables.map((table) => table.name).join(', ')}`
      );
    }
    return found;
  };
  const columnOf = (current: IrModel, name: string): string =>
    current.fields.find((candidate) => candidate.name === name)?.columnName ??
    current.relations.find((candidate) => candidate.name === name)
      ?.columnName ??
    name;
  for (const current of schema.models) {
    const table: Table = byName(current.tableName);
    const where: string = `${label}: ${current.name}`;
    for (const column of current.fields) {
      const found: Column | undefined = table.columns.find(
        (candidate) => candidate.name === column.columnName
      );
      expect(found, `${where}.${column.name} column`).toBeDefined();
      const isKey: boolean =
        column.isPrimaryKey ||
        (current.compositePrimaryKey?.includes(column.name) ?? false);
      if (isKey) {
        expect(
          (found?.primaryKey ?? 0) > 0,
          `${where}.${column.name} key`
        ).toBe(true);
      } else if (
        !column.isNullable &&
        !exemptNotNull.has(`${current.tableName}.${column.columnName}`)
      ) {
        expect(found?.notNull, `${where}.${column.name} not null`).toBe(true);
      }
      if (column.isUnique && !isKey) {
        expect(
          table.indexes.some(
            (candidate) =>
              candidate.unique &&
              candidate.columns.length === 1 &&
              candidate.columns[0] === column.columnName
          ),
          `${where}.${column.name} unique`
        ).toBe(true);
      }
    }
    for (const link of current.relations) {
      if (link.kind === 'manyToMany') {
        const join: Table = byName(`${current.tableName}_${link.name}`);
        expect(
          join.foreignKeys,
          `${where}.${link.name} join keys`
        ).toHaveLength(2);
        for (const key of join.foreignKeys) {
          expect(key.onDelete, `${where}.${link.name} join cascade`).toBe(
            'CASCADE'
          );
        }
        continue;
      }
      const target: IrModel | undefined = schema.models.find(
        (candidate) => candidate.name === link.targetModel
      );
      const key: ForeignKey | undefined = table.foreignKeys.find(
        (candidate) => candidate.from === link.columnName
      );
      expect(key, `${where}.${link.name} foreign key`).toBeDefined();
      expect(key?.table, `${where}.${link.name} target`).toBe(
        target?.tableName
      );
      expect(key?.onDelete, `${where}.${link.name} onDelete`).toBe(
        ON_DELETE_SQL[link.onDelete]
      );
      if (link.onUpdate !== undefined) {
        expect(key?.onUpdate, `${where}.${link.name} onUpdate`).toBe(
          ON_DELETE_SQL[link.onUpdate]
        );
      }
      if (link.kind === 'oneToOne') {
        expect(
          table.indexes.some(
            (candidate) =>
              candidate.unique &&
              candidate.columns.length === 1 &&
              candidate.columns[0] === link.columnName
          ) ||
            table.columns.some(
              (c) => c.name === link.columnName && c.primaryKey > 0
            ),
          `${where}.${link.name} one-to-one unique`
        ).toBe(true);
      }
    }
    for (const wanted of current.indexes) {
      const columns: string[] = wanted.fields.map((name) =>
        columnOf(current, name)
      );
      expect(
        table.indexes.some(
          (candidate) =>
            candidate.unique === wanted.isUnique &&
            candidate.columns.join(',') === columns.join(',') &&
            (wanted.name === undefined || candidate.name === wanted.name)
        ),
        `${where} index (${columns.join(', ')}) ${wanted.isUnique ? 'unique' : ''}`
      ).toBe(true);
    }
  }
}

describe('gorm emitter: real GORM', () => {
  const ready = (): boolean => moduleDirectory !== undefined;

  it.skipIf(!hasGo)(
    'vets and migrates the canonical schema of every readable format in both naming modes',
    async (context: TestContext) => {
      if (!ready()) {
        context.skip();
        return;
      }
      for (const from of [
        'django',
        'prisma',
        'typeorm',
        'doctrine',
        'laravel',
      ]) {
        const ir: IrSchema = await parseWith(
          expectOk(getFormat(from)),
          loadCanonicalSources(from)
        );
        for (const naming of ['preserve', 'normalize'] as const) {
          const output: MultiFileEmitOutput = emitGorm(ir, {
            provider: 'sqlite',
            naming,
          });
          const run: GoRun = runModels(output.files);
          expectSchemaMatches(
            run.tables,
            naming === 'normalize' ? normalizeGormSchema(ir) : ir,
            `${from} ${naming}`
          );
        }
      }
    },
    900_000
  );

  it.skipIf(!hasGo)(
    'creates, reads and deletes rows of the Django blog schema (hooks, defaults, relations, actions)',
    async (context: TestContext) => {
      if (!ready()) {
        context.skip();
        return;
      }
      const ir: IrSchema = await parseWith(
        expectOk(getFormat('django')),
        loadCanonicalSources('django')
      );
      runModels(
        emitGorm(ir, { provider: 'sqlite', naming: 'preserve' }).files,
        {
          blogChecks: true,
        }
      );
    },
    900_000
  );

  it.skipIf(!hasGo)(
    'vets and migrates the kitchen-sink schema and renders sensible DDL for other databases',
    (context: TestContext) => {
      if (!ready()) {
        context.skip();
        return;
      }
      const schema: IrSchema = kitchenSinkSchema();
      const run: GoRun = runModels(emit(schema, { provider: 'sqlite' }).files);
      expectSchemaMatches(
        run.tables,
        schema,
        'kitchen sink',
        // gorm.Model leaves its timestamps nullable.
        new Set([
          'accounts.created_at',
          'accounts.updated_at',
          'accounts.deleted_at',
        ])
      );

      const postgres: string = (
        runModels(emit(schema, { provider: 'postgresql' }).files, {
          migrate: false,
        }).ddl['postgres'] ?? []
      ).join('\n');
      expect(postgres).toContain('"id" bigserial');
      expect(postgres).toContain('"payload" JSONB');
      expect(postgres).toContain('"balance" decimal(10,2) NOT NULL');
      expect(postgres).toContain('"id" uuid DEFAULT gen_random_uuid()');
      expect(postgres).toContain('"token" uuid');
      expect(postgres).toContain('"score" double precision');
      expect(postgres).toContain('"created_at" timestamptz');
      expect(postgres).toContain('ON DELETE SET NULL ON UPDATE CASCADE');

      const mysql: string = (
        runModels(emit(schema, { provider: 'mysql' }).files, { migrate: false })
          .ddl['mysql'] ?? []
      ).join('\n');
      expect(mysql).toContain('`id` char(36)');
      expect(mysql).toContain('`note` longtext NOT NULL');
      expect(mysql).toContain('`balance` decimal(10,2) NOT NULL');

      const sqlserver: string = (
        runModels(emit(schema, { provider: 'sqlserver' }).files, {
          migrate: false,
        }).ddl['sqlserver'] ?? []
      ).join('\n');
      expect(sqlserver).toContain('"id" uniqueidentifier');
      expect(sqlserver).toContain('"note" nvarchar(max) NOT NULL');
    },
    900_000
  );

  it.skipIf(!hasGo)(
    'vets and migrates the stress schema',
    (context: TestContext) => {
      if (!ready()) {
        context.skip();
        return;
      }
      const schema: IrSchema = stressSchema();
      const run: GoRun = runModels(emit(schema, { provider: 'sqlite' }).files);
      expect(run.tables.map((table) => table.name)).toEqual([
        'others',
        'weird',
      ]);
    },
    900_000
  );

  it.skipIf(!hasGo)(
    'agrees with GORM on column and table naming',
    (context: TestContext) => {
      if (!ready() || moduleDirectory === undefined) {
        context.skip();
        return;
      }
      const columns: string[] = [
        'ID',
        'PublicID',
        'UserID',
        'HTTPServer',
        'URL',
        'ImageURL',
        'IP',
        'UUID',
        'Utf8Name',
        'Field2Name',
        'OAuth',
        'ID2',
        'XMLHTTP',
        'Name',
        'AB',
        'A',
        'TLSVersion',
        'UIDx',
        'ViewCount',
        'IsFeatured',
        'Foo_Bar',
        'FooBAr',
        'CreatedAt',
        'APIKey',
        'SQLQuery',
        'HTTPSPort',
        'UTF8String',
        'MaxCount',
      ];
      const tables: string[] = [
        'Post',
        'Category',
        'Status',
        'AuthUser',
        'Person',
        'PostTag',
        'Tag',
        'Child',
        'Box',
        'Quiz',
        'Series',
        'Data',
        'Media',
        'BlogPost',
        'Address',
        'News',
        'Index',
        'Matrix',
        'Mouse',
        'Ox',
        'Knife',
        'Hive',
        'Day',
        'Sheep',
        'Fish',
        'Money',
        'Bus',
        'Alias',
        'Tomato',
        'Buffalo',
        'Datum',
        'Axis',
        'Virus',
        'Wife',
        'Leaf',
        'Boy',
        'Key',
        'Vertex',
        'Woman',
        'Human',
        'Equipment',
        'Police',
        'Quiz',
        'Sex',
        'Move',
        'Class',
        'Wish',
        'URLMapping',
        'APIKey',
        'Tests',
        'Settings',
        'Pages',
        'Analysis',
        'Basis',
        'Crisis',
      ];
      const directory: string = join(moduleDirectory, 'naming');
      mkdirSync(directory, { recursive: true });
      writeFileSync(
        join(directory, 'main.go'),
        [
          'package main',
          '',
          'import (',
          '\t"encoding/json"',
          '\t"fmt"',
          '',
          '\t"gorm.io/gorm/schema"',
          ')',
          '',
          'func main() {',
          '\tns := schema.NamingStrategy{}',
          `\tcolumns := []string{${columns.map((c) => JSON.stringify(c)).join(', ')}}`,
          `\ttables := []string{${tables.map((t) => JSON.stringify(t)).join(', ')}}`,
          '\tout := map[string]map[string]string{"columns": {}, "tables": {}}',
          '\tfor _, c := range columns {',
          '\t\tout["columns"][c] = ns.ColumnName("", c)',
          '\t}',
          '\tfor _, t := range tables {',
          '\t\tout["tables"][t] = ns.TableName(t)',
          '\t}',
          '\tencoded, _ := json.Marshal(out)',
          '\tfmt.Println(string(encoded))',
          '}',
          '',
        ].join('\n')
      );
      const run: SpawnSyncReturns<string> = go(moduleDirectory, [
        'run',
        './naming',
      ]);
      expect(run.status, run.stderr).toBe(0);
      const real = JSON.parse(run.stdout) as Record<
        string,
        Record<string, string>
      >;
      for (const name of columns) {
        expect(gormColumnName(name), `column ${name}`).toBe(
          real['columns']?.[name]
        );
      }
      for (const name of tables) {
        expect(gormTableName(name), `table ${name}`).toBe(
          real['tables']?.[name]
        );
      }
    },
    900_000
  );
});
