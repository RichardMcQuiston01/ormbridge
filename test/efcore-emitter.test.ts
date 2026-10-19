import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { convertText, type ConvertResult } from '../src/convert.js';
import {
  DEFAULT_EFCORE_NAMESPACE,
  EFCORE_STYLES,
  emitEfcore,
  isEfcoreStyle,
  isValidCsharpNamespace,
  type EfcoreEmitOptions,
  type EfcoreStyle,
} from '../src/emitters/efcore.js';
import { getFormat, type MultiFileEmitOutput } from '../src/formats.js';
import type { IrEnum, IrField, IrModel, IrSchema } from '../src/ir.js';
import { parseEfcore } from '../src/parsers/efcore.js';
import { checkStyle, OUTPUT_STYLES } from '../src/styles.js';
import { constructsSchema } from './drizzleFixtures.js';
import { edgesSchema } from './efcoreFixtures.js';
import { EFCORE_EXTRAS, parseEfcoreExtra } from './efcoreSupport.js';
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
import { CANONICAL_FIXTURES } from './fixtures/canonical.js';

type Provider = EfcoreEmitOptions['provider'];

function emit(
  schema: IrSchema,
  overrides: Partial<EfcoreEmitOptions> = {}
): MultiFileEmitOutput {
  return emitEfcore(structuredClone(schema), {
    provider: 'postgresql',
    naming: 'preserve',
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

/** Collapses the line breaks and indentation of wrapped calls, so assertions do not depend on where a line was broken. */
function squash(text: string): string {
  return text
    .replace(/\s*\n\s*(?=\.)/g, '')
    .replace(/\s*\n\s*/g, ' ')
    .replace(/\( /g, '(')
    .replace(/ \)/g, ')');
}

function entity(output: MultiFileEmitOutput, name: string): string {
  return fileText(output, `Models/${name}.cs`);
}

function context(output: MultiFileEmitOutput): string {
  return fileText(output, 'AppDbContext.cs');
}

/** The one-model schema the type and default tests use. */
function single(fields: IrField[], extra: Partial<IrModel> = {}): IrSchema {
  return schemaOf([model('Thing', { tableName: 'Things', fields, ...extra })]);
}

const STATUS_ENUM: IrEnum = {
  name: 'Status',
  values: [
    { name: 'DRAFT', dbValue: 'draft', label: 'Draft' },
    { name: 'LIVE', dbValue: 'live' },
  ],
};

/** The status enum without the label, which C# has no place for. */
const UNLABELLED_STATUS: IrEnum = {
  name: 'Status',
  values: STATUS_ENUM.values.map((value) => ({
    name: value.name,
    dbValue: value.dbValue,
  })),
};

describe('efcore emitter: layout', () => {
  const schema: IrSchema = schemaOf(
    [
      model('User', { tableName: 'auth_user' }),
      model('Post', {
        tableName: 'blog_post',
        fields: [idField(), field('title', { maxLength: 100 })],
        relations: [relation('author', 'User', { relatedName: 'posts' })],
      }),
    ],
    [STATUS_ENUM]
  );

  it('writes a class per model, a file per enum and an AppDbContext', () => {
    const output: MultiFileEmitOutput = emit(schema);
    expect(Object.keys(output.files).sort()).toEqual([
      'AppDbContext.cs',
      'Models/Post.cs',
      'Models/Status.cs',
      'Models/User.cs',
    ]);
    expect(output.warnings).toEqual([]);
    const post: string = entity(output, 'Post');
    expect(post).toContain('namespace App.Models;');
    expect(post).toContain('#nullable enable');
    expect(post).toContain('public class Post');
    expect(context(output)).toContain('public class AppDbContext : DbContext');
    expect(context(output)).toContain(
      'public DbSet<Post> Posts => Set<Post>();'
    );
    expect(context(output)).toContain(
      'public DbSet<User> Users => Set<User>();'
    );
  });

  it('defaults to the annotations style and writes nothing for an empty schema', () => {
    expect(emit(schema).files).toEqual(
      emit(schema, { style: 'annotations' }).files
    );
    expect(emit(schemaOf([])).files).toEqual({});
    expect(emit(schemaOf([]), { style: 'fluent' }).files).toEqual({});
  });

  it('writes plain classes and a configuration class per entity in the fluent style', () => {
    const output: MultiFileEmitOutput = emit(schema, { style: 'fluent' });
    expect(Object.keys(output.files).sort()).toEqual([
      'AppDbContext.cs',
      'Configurations/PostConfiguration.cs',
      'Configurations/UserConfiguration.cs',
      'Models/Post.cs',
      'Models/Status.cs',
      'Models/User.cs',
    ]);
    const post: string = entity(output, 'Post');
    expect(post).not.toMatch(/\[(Table|Column|Key|MaxLength|Index|ForeignKey)/);
    expect(post).toContain('public string Title { get; set; } = string.Empty;');
    const configuration: string = fileText(
      output,
      'Configurations/PostConfiguration.cs'
    );
    expect(configuration).toContain(
      'public class PostConfiguration : IEntityTypeConfiguration<Post>'
    );
    expect(configuration).toContain(
      'public void Configure(EntityTypeBuilder<Post> builder)'
    );
    expect(configuration).toContain('builder.ToTable("blog_post");');
    expect(configuration).toContain('builder.HasKey(e => e.Id);');
    expect(configuration).toContain(
      'builder.Property(e => e.Title).HasColumnName("title").HasMaxLength(100);'
    );
    expect(squash(configuration)).toContain(
      'builder.HasOne(e => e.Author).WithMany(r => r.Posts).HasForeignKey(e => e.AuthorId);'
    );
    expect(context(output)).toContain(
      'modelBuilder.ApplyConfiguration(new PostConfiguration());'
    );
    expect(context(output)).not.toContain('modelBuilder.Entity<');
  });

  it('puts only what annotations cannot say in OnModelCreating in the annotations style', () => {
    const output: MultiFileEmitOutput = emit(schema);
    const post: string = entity(output, 'Post');
    expect(post).toContain('[Table("blog_post")]');
    expect(post).toContain('[Column("title")]');
    expect(post).toContain('[MaxLength(100)]');
    expect(post).toContain('[ForeignKey(nameof(AuthorId))]');
    expect(post).toContain('[InverseProperty(nameof(User.Posts))]');
    // The default delete behavior of a required relation needs no fluent call.
    expect(context(output)).not.toContain('modelBuilder.Entity<');
  });

  it('writes the auto-generated header, which --no-header turns off', () => {
    const output: MultiFileEmitOutput = emit(schema);
    for (const text of Object.values(output.files)) {
      expect(text.startsWith('// <auto-generated>\n')).toBe(true);
      expect(text).toContain('// </auto-generated>\n#nullable enable\n');
    }
    const bare: MultiFileEmitOutput = emit(schema, { header: false });
    for (const text of Object.values(bare.files)) {
      expect(text.startsWith('#nullable enable\n')).toBe(true);
      expect(text).not.toContain('auto-generated');
    }
  });

  it('uses the namespace option for every file', () => {
    const output: MultiFileEmitOutput = emit(schema, {
      namespace: 'Shop.Data',
      style: 'fluent',
    });
    for (const text of Object.values(output.files)) {
      expect(text).toContain('namespace Shop.Data;');
    }
    expect(DEFAULT_EFCORE_NAMESPACE).toBe('App.Models');
  });

  it('recognises the style names and the namespaces', () => {
    expect(EFCORE_STYLES).toEqual(['annotations', 'fluent']);
    expect(isEfcoreStyle('fluent')).toBe(true);
    expect(isEfcoreStyle('init')).toBe(false);
    expect(OUTPUT_STYLES).toContain('annotations');
    expect(isValidCsharpNamespace('App.Models')).toBe(true);
    expect(isValidCsharpNamespace('App')).toBe(true);
    expect(isValidCsharpNamespace('App..Models')).toBe(false);
    expect(isValidCsharpNamespace('App\\Models')).toBe(false);
    expect(isValidCsharpNamespace('class.Models')).toBe(false);
    expect(isValidCsharpNamespace('1App')).toBe(false);
    expect(isValidCsharpNamespace('')).toBe(false);
  });

  it('checks a style against the target format', () => {
    expect(checkStyle('efcore', 'fluent').ok).toBe(true);
    const wrong = checkStyle('efcore', 'define');
    expect(wrong.ok).toBe(false);
    if (!wrong.ok) {
      expect(wrong.error.message).toBe(
        'Invalid --style value "define" for the efcore format. Expected one of: annotations, fluent.'
      );
    }
    // Other formats ignore an EF Core style, as they ignore any known style.
    expect(checkStyle('prisma', 'fluent').ok).toBe(true);
  });

  it('rejects an unknown or foreign style and a bad namespace through the adapter', () => {
    const adapter = expectOk(getFormat('efcore'));
    const options = { ...DEFAULT_OPTIONS };
    for (const style of ['peewee', 'init']) {
      const result = adapter.emit?.(schema, {
        ...options,
        style: style as EfcoreStyle,
      });
      expect(result?.ok).toBe(false);
      if (result !== undefined && !result.ok) {
        expect(result.error.code).toBe('INVALID_OPTION');
        expect(result.error.message).toBe(
          `Invalid style "${style}" for the efcore format. Expected one of: annotations, fluent.`
        );
      }
    }
    for (const namespace of ['App\\Models', 'a b', '.', 'new.Models']) {
      const result = adapter.emit?.(schema, { ...options, namespace });
      expect(result?.ok).toBe(false);
      if (result !== undefined && !result.ok) {
        expect(result.error.message).toBe(
          `Invalid namespace "${namespace}". Expected a C# namespace such as App.Models.`
        );
      }
    }
    // Leading and trailing dots are trimmed, like the backslashes of a PHP namespace.
    const trimmed = adapter.emit?.(schema, { ...options, namespace: '.Shop.' });
    expect(trimmed?.ok).toBe(true);
  });

  it('writes valid, balanced C# for every kind of fixture', () => {
    for (const schema of [
      kitchenSinkSchema(),
      stressSchema(),
      constructsSchema(),
      edgesSchema(),
    ]) {
      for (const style of EFCORE_STYLES) {
        for (const text of Object.values(emit(schema, { style }).files)) {
          for (const [open, close] of [
            ['{', '}'],
            ['(', ')'],
            ['[', ']'],
          ] as const) {
            // Quoted text is removed first: a default may contain any bracket.
            const code: string = text.replace(/"(?:[^"\\]|\\.)*"/g, '""');
            expect(code.split(open).length, text).toBe(
              code.split(close).length
            );
          }
        }
      }
    }
  });
});

describe('efcore emitter: names', () => {
  it('names the class after the model, in PascalCase, and the DbSet after the plural', () => {
    const output: MultiFileEmitOutput = emit(
      schemaOf([
        model('blog_post', { tableName: 'blog_post' }),
        model('Category', { tableName: 'Categories' }),
        model('Person', { tableName: 'people' }),
        model('PostTags', { tableName: 'post_tags' }),
        model('Address', { tableName: 'address' }),
      ])
    );
    expect(Object.keys(output.files)).toEqual([
      'Models/BlogPost.cs',
      'Models/Category.cs',
      'Models/Person.cs',
      'Models/PostTags.cs',
      'Models/Address.cs',
      'AppDbContext.cs',
    ]);
    const text: string = context(output);
    expect(text).toContain('public DbSet<BlogPost> BlogPosts');
    expect(text).toContain('public DbSet<Category> Categories');
    expect(text).toContain('public DbSet<Person> People');
    expect(text).toContain('public DbSet<PostTags> PostTags');
    expect(text).toContain('public DbSet<Address> Addresses');
  });

  it('skips [Table] when the table is named after the DbSet property, as EF Core does', () => {
    const output: MultiFileEmitOutput = emit(
      schemaOf([
        model('Category', { tableName: 'Categories' }),
        model('Tag', { tableName: 'tag' }),
        model('Post', { tableName: 'Post' }),
      ])
    );
    expect(entity(output, 'Category')).not.toContain('[Table');
    expect(entity(output, 'Tag')).toContain('[Table("tag")]');
    expect(entity(output, 'Post')).toContain('[Table("Post")]');
    expect(context(output)).toContain('public DbSet<Category> Categories');
    expect(context(output)).toContain('public DbSet<Post> Posts');
  });

  it('names a table that is a PascalCase word after the DbSet, keeping the schema table name', () => {
    const output: MultiFileEmitOutput = emit(
      schemaOf([model('Post', { tableName: 'BlogPosts' })])
    );
    expect(context(output)).toContain('public DbSet<Post> BlogPosts');
    expect(entity(output, 'Post')).not.toContain('[Table');
  });

  it('writes the table with its schema', () => {
    const schema: IrSchema = schemaOf([
      model('Audit', { tableName: 'audit_rows', schema: 'audit' }),
    ]);
    expect(entity(emit(schema), 'Audit')).toContain(
      '[Table("audit_rows", Schema = "audit")]'
    );
    expect(
      fileText(
        emit(schema, { style: 'fluent' }),
        'Configurations/AuditConfiguration.cs'
      )
    ).toContain('builder.ToTable("audit_rows", "audit");');
  });

  it('writes PascalCase properties and maps every column name that differs', () => {
    const output: MultiFileEmitOutput = emit(
      single([
        idField(),
        field('view_count', { type: 'int' }),
        field('publicId', { type: 'int' }),
        field('Title', { columnName: 'Title', type: 'int' }),
        field('first-name', { columnName: 'first name', isNullable: true }),
      ])
    );
    const text: string = entity(output, 'Thing');
    expect(text).toContain('[Column("view_count")]\n    public int ViewCount');
    expect(text).toContain('[Column("publicId")]\n    public int PublicId');
    expect(text).toContain('public int Title { get; set; }');
    expect(text).not.toContain('[Column("Title")]');
    expect(text).toContain(
      '[Column("first name")]\n    public string? FirstName'
    );
  });

  it('renames names that C# or EF Core would reject, with a warning', () => {
    const schema: IrSchema = schemaOf([
      model('Object', { tableName: 'objects' }),
      model('Account', {
        tableName: 'accounts',
        fields: [
          idField(),
          field('Equals', { type: 'int' }),
          field('account'),
          field('class'),
        ],
      }),
      model('Row', {
        tableName: 'rows',
        fields: [idField(), field('title')],
        relations: [
          relation('account', 'Account'),
          relation('title', 'Account'),
        ],
      }),
    ]);
    const output: MultiFileEmitOutput = emit(schema);
    expect(Object.keys(output.files)).toContain('Models/ObjectEntity.cs');
    const account: string = entity(output, 'Account');
    expect(account).toContain('public int EqualsValue');
    expect(account).toContain('public string AccountValue');
    expect(account).toContain('public string Class ');
    const row: string = entity(output, 'Row');
    expect(row).toContain('public string Title ');
    expect(row).toContain('public Account TitleRef ');
    expect(output.warnings).toEqual(
      expect.arrayContaining([
        'Object: "Object" is a name the generated code uses or another type has, so the class was named "ObjectEntity".',
        'Account.Equals: "Equals" cannot be a property of Account, so the property was named "EqualsValue".',
        'Account.account: "Account" cannot be a property of Account, so the property was named "AccountValue".',
      ])
    );
  });

  it('does not throw for names that are not identifiers', () => {
    const output: MultiFileEmitOutput = emit(
      schemaOf([
        model('1st thing', {
          tableName: 't',
          fields: [idField(), field('名前'), field('9lives')],
        }),
        model('名', { tableName: 'u' }),
      ])
    );
    for (const name of Object.keys(output.files)) {
      expect(name).toMatch(/^[A-Za-z0-9_/.]+$/);
    }
  });
});

describe('efcore emitter: column types', () => {
  const cases: [string, Partial<IrField>, string, string?][] = [
    [
      'string with a length',
      { type: 'string', maxLength: 30 },
      'public string Value { get; set; } = string.Empty;',
      '[MaxLength(30)]',
    ],
    [
      'text',
      { type: 'text' },
      'public string Value { get; set; } = string.Empty;',
    ],
    ['int', { type: 'int' }, 'public int Value { get; set; }'],
    ['bigInt', { type: 'bigInt' }, 'public long Value { get; set; }'],
    ['float', { type: 'float' }, 'public double Value { get; set; }'],
    ['boolean', { type: 'boolean' }, 'public bool Value { get; set; }'],
    [
      'decimal',
      { type: 'decimal', maxDigits: 10, decimalPlaces: 2 },
      'public decimal Value { get; set; }',
      '[Precision(10, 2)]',
    ],
    [
      'decimal without a precision',
      { type: 'decimal' },
      'public decimal Value { get; set; }',
    ],
    ['dateTime', { type: 'dateTime' }, 'public DateTime Value { get; set; }'],
    ['date', { type: 'date' }, 'public DateOnly Value { get; set; }'],
    ['time', { type: 'time' }, 'public TimeOnly Value { get; set; }'],
    ['duration', { type: 'duration' }, 'public TimeSpan Value { get; set; }'],
    ['uuid', { type: 'uuid' }, 'public Guid Value { get; set; }'],
    [
      'bytes',
      { type: 'bytes' },
      'public byte[] Value { get; set; } = Array.Empty<byte>();',
    ],
    [
      'json',
      { type: 'json' },
      'public string Value { get; set; } = string.Empty;',
      '[Column("value", TypeName = "jsonb")]',
    ],
    [
      'ipAddress',
      { type: 'ipAddress' },
      'public IPAddress Value { get; set; } = null!;',
    ],
    [
      'hstore',
      { type: 'hstore' },
      'public Dictionary<string, string> Value { get; set; } = new();',
    ],
    [
      'range',
      { type: 'range', rangeOf: 'int' },
      'public NpgsqlRange<int> Value { get; set; }',
    ],
    [
      'a range of dates',
      { type: 'range', rangeOf: 'date' },
      'public NpgsqlRange<DateOnly> Value { get; set; }',
    ],
    [
      'an array',
      { type: 'string', arrayDepth: 1 },
      'public string[] Value { get; set; } = Array.Empty<string>();',
    ],
    [
      'a nested array',
      { type: 'int', arrayDepth: 2 },
      'public int[,] Value { get; set; } = null!;',
    ],
    [
      'a nullable int',
      { type: 'int', isNullable: true },
      'public int? Value { get; set; }',
    ],
    [
      'a nullable string',
      { type: 'string', isNullable: true },
      'public string? Value { get; set; }',
    ],
    [
      'a nullable array',
      { type: 'int', arrayDepth: 1, isNullable: true },
      'public int[]? Value { get; set; }',
    ],
    [
      'an unsupported column',
      { type: 'unsupported', unsupportedType: 'circle' },
      'public string Value { get; set; } = string.Empty;',
      '[Column("value", TypeName = "circle")]',
    ],
  ];

  it.each(cases)('writes %s', (_label, overrides, property, attribute) => {
    const output: MultiFileEmitOutput = emit(
      single([idField(), field('value', { ...overrides })])
    );
    const text: string = entity(output, 'Thing');
    expect(text).toContain(property);
    if (attribute !== undefined) {
      expect(text).toContain(attribute);
    }
  });

  it('adds the using directives a file needs, and no others', () => {
    const plain: string = entity(
      emit(single([idField(), field('name', { type: 'int' })])),
      'Thing'
    );
    expect(plain).toContain(
      'using System.ComponentModel.DataAnnotations.Schema;'
    );
    expect(plain).not.toContain('using System;');
    expect(plain).not.toContain('using Microsoft.EntityFrameworkCore;');
    const rich: string = entity(
      emit(
        single([
          idField(),
          field('at', { type: 'dateTime' }),
          field('ip', { type: 'ipAddress' }),
          field('range', { type: 'range', rangeOf: 'int' }),
          field('label', { maxLength: 4 }),
        ])
      ),
      'Thing'
    );
    for (const name of [
      'System',
      'System.Net',
      'NpgsqlTypes',
      'System.ComponentModel.DataAnnotations',
      'System.ComponentModel.DataAnnotations.Schema',
    ]) {
      expect(rich).toContain(`using ${name};`);
    }
    expect(rich.indexOf('using System;')).toBeLessThan(
      rich.indexOf('using NpgsqlTypes;')
    );
  });

  it('writes a column type per provider and warns where EF Core has no mapping', () => {
    const schema: IrSchema = single([
      idField(),
      field('doc', { type: 'json' }),
      field('ip', { type: 'ipAddress' }),
      field('extra', { type: 'hstore', isNullable: true }),
      field('span', { type: 'range', rangeOf: 'int', isNullable: true }),
      field('grid', { type: 'int', arrayDepth: 2 }),
    ]);
    // The PostgreSQL warnings are about the range and the nested array, which need the Npgsql package.
    const postgres: string[] = ['Thing.span:', 'Thing.grid:'];
    const expectations: Record<Provider, { json: string; warnings: string[] }> =
      {
        postgresql: {
          json: '[Column("doc", TypeName = "jsonb")]',
          warnings: postgres,
        },
        // The notice, then CockroachDB has no hstore, range or multi-dimensional array type.
        cockroachdb: {
          json: '[Column("doc", TypeName = "jsonb")]',
          warnings: [
            'Provider "cockroachdb":',
            'Thing.extra:',
            'Thing.span:',
            'Thing.grid:',
          ],
        },
        mysql: {
          json: '[Column("doc", TypeName = "json")]',
          warnings: ['Thing.ip:', 'Thing.extra:', 'Thing.span:', 'Thing.grid:'],
        },
        sqlite: {
          json: '[Column("doc")]',
          warnings: [
            'Thing.doc:',
            'Thing.ip:',
            'Thing.extra:',
            'Thing.span:',
            'Thing.grid:',
          ],
        },
        sqlserver: {
          json: '[Column("doc")]',
          warnings: [
            'Thing.doc:',
            'Thing.ip:',
            'Thing.extra:',
            'Thing.span:',
            'Thing.grid:',
          ],
        },
        mongodb: {
          json: '[Column("doc", TypeName = "jsonb")]',
          warnings: ['Provider "mongodb":', ...postgres],
        },
      };
    for (const [provider, expected] of Object.entries(expectations) as [
      Provider,
      { json: string; warnings: string[] },
    ][]) {
      const output: MultiFileEmitOutput = emit(schema, { provider });
      expect(entity(output, 'Thing'), provider).toContain(expected.json);
      expect(
        output.warnings.map((warning: string) =>
          warning.slice(0, warning.indexOf(':') + 1)
        ),
        `${provider}: ${output.warnings.join('\n')}`
      ).toEqual(expected.warnings);
    }
    const sqlite: string = entity(
      emit(schema, { provider: 'sqlite' }),
      'Thing'
    );
    expect(sqlite).toContain('public string Ip { get; set; } = string.Empty;');
    expect(sqlite).toContain('[MaxLength(45)]');
    expect(sqlite).toContain('public string? Extra { get; set; }');
    expect(sqlite).toContain('public string? Span { get; set; }');
    expect(sqlite).toContain(
      'public string Grid { get; set; } = string.Empty;'
    );
    expect(emit(schema, { provider: 'mongodb' }).warnings[0]).toContain(
      'Provider "mongodb": EF Core is relational'
    );
  });

  it('takes a length or precision from a Prisma native type', () => {
    const output: MultiFileEmitOutput = emit(
      single([
        idField(),
        field('code', {
          nativeType: { name: 'VarChar', args: ['12'] },
        }),
        field('price', {
          type: 'decimal',
          nativeType: { name: 'Decimal', args: ['9', '3'] },
        }),
      ])
    );
    const text: string = entity(output, 'Thing');
    expect(text).toContain('[MaxLength(12)]');
    expect(text).toContain('[Precision(9, 3)]');
  });

  it('writes the generated-column expression of a SQL source and warns about a Python one', () => {
    const schema: IrSchema = single([
      idField(),
      field('total', {
        type: 'int',
        generated: { expression: '"a" + "b"', isStored: true },
      }),
      field('python', {
        type: 'int',
        generated: { expression: 'F("a") + F("b")', isStored: false },
      }),
    ]);
    const output: MultiFileEmitOutput = emit(schema);
    expect(squash(context(output))).toContain(
      'entity.Property(e => e.Total).HasComputedColumnSql("\\"a\\" + \\"b\\"", true);'
    );
    expect(context(output)).not.toContain('Python');
    expect(output.warnings).toEqual([
      'Thing.python: the generated column expression F("a") + F("b") is Python, not SQL; the column was written as a regular column.',
    ]);
  });
});

describe('efcore emitter: primary keys', () => {
  it('leaves an Id key to the conventions and marks any other key', () => {
    const output: MultiFileEmitOutput = emit(
      schemaOf([
        model('Plain', { tableName: 'plain' }),
        model('Named', {
          tableName: 'named',
          fields: [field('code', { isPrimaryKey: true, maxLength: 8 })],
        }),
        model('Typed', {
          tableName: 'typed',
          fields: [idField({ name: 'typed_id', columnName: 'typed_id' })],
        }),
      ])
    );
    expect(entity(output, 'Plain')).not.toContain('[Key]');
    expect(entity(output, 'Named')).toContain('[Key]\n    [Column("code")]');
    expect(entity(output, 'Typed')).not.toContain('[Key]');
  });

  it('says which keys are generated: a counting integer key needs nothing, other cases are explicit', () => {
    const output: MultiFileEmitOutput = emit(
      schemaOf([
        model('Counted'),
        model('Manual', {
          tableName: 'manual',
          fields: [idField({ default: undefined })],
        }),
        model('Guided', {
          tableName: 'guided',
          fields: [
            field('id', {
              type: 'uuid',
              isPrimaryKey: true,
              default: { kind: 'uuid' },
            }),
          ],
        }),
        model('Plain', {
          tableName: 'plain',
          fields: [field('id', { type: 'uuid', isPrimaryKey: true })],
        }),
        model('Other', {
          tableName: 'other',
          fields: [
            field('code', { isPrimaryKey: true }),
            field('seq', { type: 'int', default: { kind: 'autoIncrement' } }),
          ],
        }),
      ])
    );
    expect(entity(output, 'Counted')).not.toContain('DatabaseGenerated');
    expect(entity(output, 'Manual')).toContain(
      '[DatabaseGenerated(DatabaseGeneratedOption.None)]'
    );
    expect(entity(output, 'Guided')).not.toContain('DatabaseGenerated');
    expect(entity(output, 'Plain')).toContain(
      '[DatabaseGenerated(DatabaseGeneratedOption.None)]'
    );
    expect(entity(output, 'Other')).toContain(
      '[DatabaseGenerated(DatabaseGeneratedOption.Identity)]'
    );
  });

  it('writes a composite key with [PrimaryKey] or HasKey, relations included', () => {
    const schema: IrSchema = schemaOf([
      model('Account'),
      model('Group'),
      model('Membership', {
        tableName: 'memberships',
        fields: [field('role', { maxLength: 12 })],
        relations: [relation('account', 'Account'), relation('group', 'Group')],
        compositePrimaryKey: ['account', 'group'],
      }),
    ]);
    const annotations: string = entity(emit(schema), 'Membership');
    expect(annotations).toContain(
      '[PrimaryKey(nameof(AccountId), nameof(GroupId))]'
    );
    expect(annotations).not.toContain('[Key]');
    expect(
      fileText(
        emit(schema, { style: 'fluent' }),
        'Configurations/MembershipConfiguration.cs'
      )
    ).toContain('builder.HasKey(e => new { e.AccountId, e.GroupId });');
  });

  it('writes a relation that is the key as the key of its foreign key column', () => {
    const output: MultiFileEmitOutput = emit(
      schemaOf([
        model('Book', { tableName: 'books' }),
        model('Audiobook', {
          tableName: 'audiobooks',
          fields: [field('minutes', { type: 'int' })],
          relations: [
            relation('book', 'Book', {
              kind: 'oneToOne',
              columnName: 'book_ptr_id',
              isPrimaryKey: true,
              relatedName: 'audiobook',
            }),
          ],
        }),
      ])
    );
    const text: string = entity(output, 'Audiobook');
    expect(text).toContain(
      '[Key]\n    [DatabaseGenerated(DatabaseGeneratedOption.None)]\n    [Column("book_ptr_id")]\n    public int BookId { get; set; }'
    );
    expect(text).toContain('public Book Book { get; set; } = null!;');
    expect(entity(output, 'Book')).toContain(
      'public Audiobook? Audiobook { get; set; }'
    );
  });

  it('writes a named primary key constraint', () => {
    const output: MultiFileEmitOutput = emit(
      schemaOf([model('Thing', { primaryKeyName: 'PK_thing' })])
    );
    expect(context(output)).toContain(
      'entity.HasKey(e => e.Id).HasName("PK_thing");'
    );
  });

  it('writes a model without a key as keyless, with a warning', () => {
    const output: MultiFileEmitOutput = emit(
      schemaOf([model('Log', { tableName: 'Logs', fields: [field('line')] })])
    );
    const text: string = entity(output, 'Log');
    expect(text).toContain('[Table("Logs")]\n[Keyless]\npublic class Log');
    expect(output.warnings).toEqual([
      'Log: the model has no primary key; EF Core needs a key, so the class was written as keyless ([Keyless]).',
    ]);
  });

  it('writes a view with ToView and no key requirement', () => {
    const output: MultiFileEmitOutput = emit(
      schemaOf([
        model('Summary', {
          tableName: 'summaries',
          isView: true,
          fields: [field('total', { type: 'int' })],
        }),
      ])
    );
    expect(entity(output, 'Summary')).toContain('[Keyless]');
    expect(entity(output, 'Summary')).not.toContain('[Table');
    expect(context(output)).toContain('entity.ToView("summaries");');
    expect(output.warnings).toEqual([]);
  });
});

describe('efcore emitter: defaults', () => {
  const defaults: [string, Partial<IrField>, string][] = [
    [
      'an int',
      { type: 'int', default: { kind: 'literal', value: 3 } },
      '.HasDefaultValue(3)',
    ],
    [
      'a long',
      { type: 'bigInt', default: { kind: 'literal', value: 3 } },
      '.HasDefaultValue(3L)',
    ],
    [
      'a double',
      { type: 'float', default: { kind: 'literal', value: 2 } },
      '.HasDefaultValue(2.0)',
    ],
    [
      'a fractional double',
      { type: 'float', default: { kind: 'literal', value: 0.5 } },
      '.HasDefaultValue(0.5)',
    ],
    [
      'a decimal',
      { type: 'decimal', default: { kind: 'literal', value: 9.99 } },
      '.HasDefaultValue(9.99m)',
    ],
    [
      'true',
      { type: 'boolean', default: { kind: 'literal', value: true } },
      '.HasDefaultValue(true)',
    ],
    [
      'false from text',
      { type: 'boolean', default: { kind: 'literal', value: '0' } },
      '.HasDefaultValue(false)',
    ],
    [
      'a string',
      { default: { kind: 'literal', value: 'a "q" \\ b\n' } },
      '.HasDefaultValue("a \\"q\\" \\\\ b\\n")',
    ],
    [
      'a Guid',
      {
        type: 'uuid',
        default: {
          kind: 'literal',
          value: '5f2c9a1e-0000-4000-8000-000000000000',
        },
      },
      '.HasDefaultValue(Guid.Parse("5f2c9a1e-0000-4000-8000-000000000000"))',
    ],
    [
      'a date-time text as SQL',
      {
        type: 'dateTime',
        default: { kind: 'literal', value: '2020-01-02T03:04:05Z' },
      },
      '.HasDefaultValueSql("\'2020-01-02T03:04:05Z\'")',
    ],
    [
      'json as SQL',
      { type: 'json', default: { kind: 'literal', value: '{"a": 1}' } },
      '.HasDefaultValueSql("\'{\\"a\\": 1}\'")',
    ],
    [
      'now on a date-time',
      { type: 'dateTime', default: { kind: 'now' } },
      '.HasDefaultValueSql("CURRENT_TIMESTAMP")',
    ],
    [
      'now on a date',
      { type: 'date', default: { kind: 'now' } },
      '.HasDefaultValueSql("CURRENT_DATE")',
    ],
    [
      'now on a time',
      { type: 'time', default: { kind: 'now' } },
      '.HasDefaultValueSql("CURRENT_TIME")',
    ],
    [
      'a database function',
      { type: 'uuid', default: { kind: 'uuid' } },
      '.HasDefaultValueSql("gen_random_uuid()")',
    ],
    [
      'an expression',
      { default: { kind: 'dbExpression', expression: "lower('A')" } },
      '.HasDefaultValueSql("lower(\'A\')")',
    ],
  ];

  it.each(defaults)('writes %s', (_label, overrides, expected) => {
    const output: MultiFileEmitOutput = emit(
      single([idField(), field('value', { ...overrides })])
    );
    expect(squash(context(output))).toContain(
      `entity.Property(e => e.Value)${expected};`
    );
  });

  it('writes a default in the configuration class in the fluent style, with the column name', () => {
    const output: MultiFileEmitOutput = emit(
      single([
        idField(),
        field('view_count', {
          type: 'int',
          default: { kind: 'literal', value: 0 },
        }),
      ]),
      { style: 'fluent' }
    );
    expect(fileText(output, 'Configurations/ThingConfiguration.cs')).toContain(
      'builder.Property(e => e.ViewCount).HasColumnName("view_count").HasDefaultValue(0);'
    );
  });

  it('chooses the database function per provider', () => {
    const schema: IrSchema = single([
      idField(),
      field('token', { type: 'uuid', default: { kind: 'uuid' } }),
      field('at', { type: 'dateTime', default: { kind: 'now' } }),
      field('day', { type: 'date', default: { kind: 'now' } }),
    ]);
    const expected: Record<Provider, string[]> = {
      postgresql: [
        '"gen_random_uuid()"',
        '"CURRENT_TIMESTAMP"',
        '"CURRENT_DATE"',
      ],
      cockroachdb: [
        '"gen_random_uuid()"',
        '"CURRENT_TIMESTAMP"',
        '"CURRENT_DATE"',
      ],
      mysql: ['"(UUID())"', '"CURRENT_TIMESTAMP"', '"(CURRENT_DATE)"'],
      sqlserver: ['"NEWID()"', '"GETUTCDATE()"', '"GETUTCDATE()"'],
      sqlite: [
        'HasValueGenerator<GuidValueGenerator>()',
        '"CURRENT_TIMESTAMP"',
        '"CURRENT_DATE"',
      ],
      mongodb: ['"gen_random_uuid()"', '"CURRENT_TIMESTAMP"', '"CURRENT_DATE"'],
    };
    for (const [provider, fragments] of Object.entries(expected) as [
      Provider,
      string[],
    ][]) {
      const text: string = squash(context(emit(schema, { provider })));
      for (const fragment of fragments) {
        expect(text, `${provider} ${fragment}`).toContain(fragment);
      }
    }
    const sqlite = emit(schema, { provider: 'sqlite' });
    expect(sqlite.warnings).toEqual([
      'Thing.token: SQLite has no database-side UUID default; EF Core generates the Guid when the row is added through it.',
    ]);
    expect(squash(context(sqlite))).toContain(
      'entity.Property(e => e.Token).ValueGeneratedOnAdd().HasValueGenerator<GuidValueGenerator>();'
    );
  });

  it('puts expression defaults of SQLite and MySQL in parentheses', () => {
    const schema: IrSchema = single([
      idField(),
      field('stamp', {
        type: 'dateTime',
        default: { kind: 'dbExpression', expression: "datetime('now')" },
      }),
      field('plain', {
        type: 'dateTime',
        default: { kind: 'dbExpression', expression: 'CURRENT_TIMESTAMP' },
      }),
    ]);
    const sqlite: string = context(emit(schema, { provider: 'sqlite' }));
    expect(sqlite).toContain('HasDefaultValueSql("(datetime(\'now\'))")');
    expect(sqlite).toContain('HasDefaultValueSql("CURRENT_TIMESTAMP")');
    expect(context(emit(schema, { provider: 'postgresql' }))).toContain(
      'HasDefaultValueSql("datetime(\'now\')")'
    );
  });

  it('starts a column with a default as the default, or as null, so EF Core does not insert an empty value', () => {
    const output: MultiFileEmitOutput = emit(
      single([
        idField(),
        field('plain'),
        field('code', { default: { kind: 'literal', value: 'x' } }),
        field('flag', {
          type: 'boolean',
          default: { kind: 'literal', value: true },
        }),
        field('doc', {
          type: 'json',
          default: { kind: 'literal', value: '{}' },
        }),
        field('opt', {
          isNullable: true,
          default: { kind: 'literal', value: 'x' },
        }),
      ])
    );
    const text: string = entity(output, 'Thing');
    expect(text).toContain('public string Plain { get; set; } = string.Empty;');
    expect(text).toContain('public string Code { get; set; } = "x";');
    expect(text).toContain('public bool Flag { get; set; } = true;');
    expect(text).toContain('public string Doc { get; set; } = null!;');
    expect(text).toContain('public string? Opt { get; set; }');
  });

  it('warns about defaults it cannot write and drops them', () => {
    const output: MultiFileEmitOutput = emit(
      single([
        idField(),
        field('tags', {
          arrayDepth: 1,
          default: { kind: 'literal', value: '[]' },
        }),
        field('blob', {
          type: 'bytes',
          default: { kind: 'literal', value: 'x' },
        }),
        field('cuid', {
          default: { kind: 'clientGenerated', generator: 'cuid' },
        }),
        field('seq', { default: { kind: 'autoIncrement' } }),
        field('fn', {
          default: {
            kind: 'dbExpression',
            expression: 'auto()',
            isFunction: true,
          },
        }),
        field('n', { type: 'int', default: { kind: 'literal', value: 'abc' } }),
        field('s', { default: { kind: 'now' } }),
        field('u', { default: { kind: 'uuid' } }),
      ])
    );
    expect(context(output)).not.toContain('HasDefaultValue');
    expect(output.warnings).toEqual([
      'Thing.tags: an array default cannot be written; the default was dropped.',
      'Thing.blob: a literal default on a bytes column cannot be written; the default was dropped.',
      'Thing.cuid: the cuid() default is generated by Prisma Client; EF Core has no equivalent and the default was dropped.',
      'Thing.seq: an auto-increment default on a string column cannot be written; the default was dropped.',
      'Thing.fn: the Prisma function auto() is not a database expression; the default was dropped.',
      'Thing.n: "abc" is not a number this column can hold; the default was dropped.',
      'Thing.s: the "now" default applies to date and time columns only; the default was dropped.',
      'Thing.u: a UUID default on a string column cannot be written; the default was dropped.',
    ]);
  });
});

describe('efcore emitter: enums', () => {
  it('writes a C# enum per IR enum, stored as names when they match the stored values', () => {
    const schema: IrSchema = schemaOf(
      [
        model('Post', {
          fields: [
            idField(),
            field('status', {
              enumName: 'Level',
              maxLength: 10,
              default: { kind: 'enumValue', value: 'High' },
            }),
          ],
        }),
      ],
      [
        {
          name: 'Level',
          values: [
            { name: 'Low', dbValue: 'Low' },
            { name: 'High', dbValue: 'High' },
          ],
        },
      ]
    );
    const output: MultiFileEmitOutput = emit(schema);
    expect(fileText(output, 'Models/Level.cs')).toContain(
      'public enum Level\n{\n    Low,\n    High,\n}'
    );
    expect(entity(output, 'Post')).toContain(
      'public Level Status { get; set; } = Level.High;'
    );
    expect(squash(context(output))).toContain(
      'entity.Property(e => e.Status).HasMaxLength(10).HasConversion<string>().HasDefaultValue(Level.High);'
    );
    expect(Object.keys(output.files)).not.toContain('Models/LevelConverter.cs');
    expect(fileText(output, 'Models/Level.cs')).not.toContain('Converter');
  });

  it('keeps the stored values with a value converter when the names differ', () => {
    const schema: IrSchema = schemaOf(
      [
        model('Post', {
          fields: [
            idField(),
            field('status', {
              enumName: 'Status',
              default: { kind: 'enumValue', value: 'DRAFT' },
            }),
          ],
        }),
      ],
      [STATUS_ENUM]
    );
    const output: MultiFileEmitOutput = emit(schema);
    const text: string = fileText(output, 'Models/Status.cs');
    expect(text).toContain('public enum Status\n{\n    DRAFT,\n    LIVE,\n}');
    expect(text).toContain(
      'public class StatusConverter : ValueConverter<Status, string>'
    );
    expect(text).toContain('Status.DRAFT => "draft",');
    expect(text).toContain('"live" => Status.LIVE,');
    expect(text).toContain(
      'using Microsoft.EntityFrameworkCore.Storage.ValueConversion;'
    );
    expect(squash(context(output))).toContain(
      '.HasConversion(new StatusConverter()).HasDefaultValue(Status.DRAFT);'
    );
  });

  it('stores an enum of numbers as integers, with the numbers as members', () => {
    const schema: IrSchema = schemaOf(
      [
        model('Order', {
          fields: [
            idField(),
            field('state', {
              type: 'int',
              enumName: 'State',
              default: { kind: 'enumValue', value: 'Shipped' },
            }),
          ],
        }),
      ],
      [
        {
          name: 'State',
          values: [
            { name: 'Pending', dbValue: '0' },
            { name: 'Shipped', dbValue: '2' },
          ],
        },
      ]
    );
    const output: MultiFileEmitOutput = emit(schema);
    expect(fileText(output, 'Models/State.cs')).toContain(
      '    Pending = 0,\n    Shipped = 2,\n'
    );
    expect(context(output)).toContain('.HasDefaultValue(State.Shipped)');
    expect(context(output)).not.toContain('HasConversion');
  });

  it('escapes members that are keywords and repairs names that are not identifiers', () => {
    const output: MultiFileEmitOutput = emit(
      schemaOf(
        [
          model('Thing', {
            fields: [idField(), field('mode', { enumName: 'mode' })],
          }),
        ],
        [
          {
            name: 'mode',
            values: [
              { name: 'default', dbValue: 'default' },
              { name: 'in progress', dbValue: 'in progress' },
              { name: '9', dbValue: '9' },
            ],
          },
        ]
      )
    );
    const text: string = fileText(output, 'Models/Mode.cs');
    expect(text).toContain('    @default,\n    in_progress,\n    _9,\n');
    expect(output.warnings).toEqual([
      'enum mode: the member "in progress" was written as "in_progress".',
      'enum mode: the member "9" was written as "_9".',
    ]);
  });

  it('warns about an array of an enum and about an enum that does not exist', () => {
    const output: MultiFileEmitOutput = emit(
      schemaOf(
        [
          model('Thing', {
            fields: [
              idField(),
              field('many', { enumName: 'Status', arrayDepth: 1 }),
              field('gone', { enumName: 'Missing' }),
            ],
          }),
        ],
        [STATUS_ENUM]
      )
    );
    const text: string = entity(output, 'Thing');
    expect(text).toContain(
      'public Status[] Many { get; set; } = Array.Empty<Status>();'
    );
    expect(text).toContain('public string Gone { get; set; } = string.Empty;');
    expect(output.warnings).toEqual([
      'Thing.many: an array of the enum Status is stored as numbers by EF Core, not as names.',
      'Thing.gone: the enum "Missing" does not exist; the column was written as a plain string.',
    ]);
  });

  it('names an enum apart from a model of the same name', () => {
    const output: MultiFileEmitOutput = emit(
      schemaOf([model('Status')], [STATUS_ENUM])
    );
    expect(Object.keys(output.files)).toEqual(
      expect.arrayContaining(['Models/Status.cs', 'Models/StatusEntity.cs'])
    );
    expect(output.warnings).toContain(
      'Status: "Status" is a name the generated code uses or another type has, so the class was named "StatusEntity".'
    );
  });
});

describe('efcore emitter: indexes', () => {
  it('writes unique fields, named and composite indexes and sort orders as [Index]', () => {
    const output: MultiFileEmitOutput = emit(
      single(
        [
          idField(),
          field('email', { maxLength: 80, isUnique: true }),
          field('slug', {
            maxLength: 40,
            isUnique: true,
            uniqueName: 'slug_uq',
          }),
          field('a', { type: 'int' }),
          field('b', { type: 'int' }),
        ],
        {
          indexes: [
            index(['a']),
            index(['a', 'b'], { isUnique: true, name: 'a_b' }),
            index(['b', 'a'], { fieldOptions: { b: { sort: 'desc' } } }),
            index(['email'], { isUnique: true }),
          ],
        }
      )
    );
    const text: string = entity(output, 'Thing');
    expect(text).toContain('[Index(nameof(Email), IsUnique = true)]');
    expect(text).toContain(
      '[Index(nameof(Slug), IsUnique = true, Name = "slug_uq")]'
    );
    expect(text).toContain('[Index(nameof(A))]');
    expect(text).toContain(
      '[Index(nameof(A), nameof(B), IsUnique = true, Name = "a_b")]'
    );
    expect(text).toContain(
      '[Index(nameof(B), nameof(A), IsDescending = new[] { true, false })]'
    );
    // The same unique index, once as a field flag and once as an index, is written once.
    expect(text.match(/\[Index\(nameof\(Email\)/g)?.length).toBe(1);
  });

  it('writes the same indexes with HasIndex in the fluent style', () => {
    const output: MultiFileEmitOutput = emit(
      single(
        [idField(), field('a', { type: 'int' }), field('b', { type: 'int' })],
        {
          indexes: [
            index(['a', 'b'], {
              isUnique: true,
              name: 'a_b',
              fieldOptions: { a: { sort: 'desc' } },
            }),
          ],
        }
      ),
      { style: 'fluent' }
    );
    expect(
      squash(fileText(output, 'Configurations/ThingConfiguration.cs'))
    ).toContain(
      'builder.HasIndex(e => new { e.A, e.B }).IsUnique().HasDatabaseName("a_b").IsDescending(true, false);'
    );
  });

  it('writes an index method with HasMethod for PostgreSQL and warns elsewhere', () => {
    const schema: IrSchema = single(
      [idField(), field('tags', { type: 'json' })],
      { indexes: [index(['tags'], { method: 'Gin' })] }
    );
    const postgres: MultiFileEmitOutput = emit(schema);
    expect(entity(postgres, 'Thing')).not.toContain('[Index');
    expect(squash(context(postgres))).toContain(
      'entity.HasIndex(e => e.Tags).HasMethod("gin");'
    );
    const mysql: MultiFileEmitOutput = emit(schema, { provider: 'mysql' });
    expect(entity(mysql, 'Thing')).toContain('[Index(nameof(Tags))]');
    expect(mysql.warnings).toContain(
      'Thing index (tags): the Gin index method only exists in PostgreSQL (Npgsql); it was dropped.'
    );
  });

  it('warns about the index options EF Core cannot express', () => {
    const output: MultiFileEmitOutput = emit(
      single([idField(), field('a', { maxLength: 30 })], {
        indexes: [
          index(['a'], {
            clustered: true,
            kind: 'fulltext',
            fieldOptions: { a: { length: 10, ops: 'gin_trgm_ops' } },
          }),
        ],
      })
    );
    expect(output.warnings).toEqual([
      'Thing index (a): full-text indexes are not supported here; it was written as an ordinary index.',
      'Thing index (a): the prefix length and operator class and clustering option has no EF Core equivalent and was dropped.',
    ]);
  });

  it('maps relation names in an index to their foreign key properties and skips an unknown field', () => {
    const output: MultiFileEmitOutput = emit(
      schemaOf([
        model('User'),
        model('Post', {
          fields: [idField(), field('title')],
          relations: [relation('author', 'User')],
          indexes: [
            index(['author', 'title'], { isUnique: true }),
            index(['nope']),
          ],
        }),
      ])
    );
    expect(entity(output, 'Post')).toContain(
      '[Index(nameof(AuthorId), nameof(Title), IsUnique = true)]'
    );
    expect(output.warnings).toEqual([
      'Post: the index (nope) refers to "nope", which is not a field or relation of the model; the index was skipped.',
    ]);
  });
});

describe('efcore emitter: relations', () => {
  const blog: IrSchema = schemaOf([
    model('User', { tableName: 'users' }),
    model('Post', {
      tableName: 'posts',
      fields: [idField(), field('title')],
      relations: [
        relation('author', 'User', { relatedName: 'posts' }),
        relation('editor', 'User', {
          isNullable: true,
          onDelete: 'setNull',
          relatedName: 'edited_posts',
        }),
        relation('reviewer', 'User', {
          isNullable: true,
          onDelete: 'noAction',
        }),
      ],
    }),
  ]);

  it('writes the foreign key property, the navigation and the collection on the other side', () => {
    const output: MultiFileEmitOutput = emit(blog);
    const post: string = entity(output, 'Post');
    expect(post).toContain(
      '[Column("author_id")]\n    public int AuthorId { get; set; }'
    );
    expect(post).toContain(
      '[Column("editor_id")]\n    public int? EditorId { get; set; }'
    );
    expect(post).toContain(
      '[ForeignKey(nameof(AuthorId))]\n    [InverseProperty(nameof(User.Posts))]\n    public User Author { get; set; } = null!;'
    );
    expect(post).toContain('public User? Editor { get; set; }');
    const user: string = entity(output, 'User');
    expect(user).toContain(
      '[InverseProperty(nameof(Post.Author))]\n    public ICollection<Post> Posts { get; set; } = new List<Post>();'
    );
    expect(user).toContain(
      'public ICollection<Post> EditedPosts { get; set; } = new List<Post>();'
    );
    expect(user).toContain('using System.Collections.Generic;');
  });

  it('writes a delete behavior only where it differs from the EF Core default', () => {
    const output: MultiFileEmitOutput = emit(blog);
    const text: string = squash(context(output));
    // author: required + cascade and reviewer: optional + NO ACTION are what EF Core does anyway.
    expect(text).toContain(
      'entity.HasOne(e => e.Editor).WithMany(r => r.EditedPosts).HasForeignKey(e => e.EditorId).OnDelete(DeleteBehavior.SetNull);'
    );
    expect(text).not.toContain('e.Author');
    expect(text).not.toContain('e.Reviewer');
    expect(entity(output, 'Post')).toContain(
      '[ForeignKey(nameof(ReviewerId))]'
    );
  });

  it("writes every relation, and every delete behavior but EF Core's default, in the fluent style", () => {
    const output: MultiFileEmitOutput = emit(blog, { style: 'fluent' });
    const text: string = squash(
      fileText(output, 'Configurations/PostConfiguration.cs')
    );
    expect(text).toContain(
      'builder.HasOne(e => e.Author).WithMany(r => r.Posts).HasForeignKey(e => e.AuthorId);'
    );
    expect(text).toContain('.WithMany(r => r.EditedPosts)');
    expect(text).toContain(
      'builder.HasOne(e => e.Reviewer).WithMany().HasForeignKey(e => e.ReviewerId);'
    );
  });

  it('maps every referential action', () => {
    const actions = {
      cascade: 'Cascade',
      setNull: 'SetNull',
      restrict: 'Restrict',
      noAction: 'NoAction',
      setDefault: 'NoAction',
    } as const;
    for (const [action, behavior] of Object.entries(actions) as [
      keyof typeof actions,
      string,
    ][]) {
      // Optional relations default to NO ACTION and required ones to CASCADE, so each case picks the other one.
      const optional: boolean = action === 'cascade';
      const output: MultiFileEmitOutput = emit(
        schemaOf([
          model('User'),
          model('Post', {
            relations: [
              relation('author', 'User', {
                onDelete: action,
                isNullable: action !== 'noAction' ? optional : false,
              }),
            ],
          }),
        ]),
        { style: 'fluent' }
      );
      expect(
        fileText(output, 'Configurations/PostConfiguration.cs'),
        action
      ).toContain(`.OnDelete(DeleteBehavior.${behavior})`);
      expect(output.warnings.length > 0, action).toBe(
        action === 'setDefault' || action === 'setNull'
      );
    }
  });

  it('warns that SET DEFAULT has no EF Core behavior and that SET NULL on a required relation fails', () => {
    const output: MultiFileEmitOutput = emit(
      schemaOf([
        model('User'),
        model('Post', {
          relations: [
            relation('a', 'User', { onDelete: 'setNull' }),
            relation('b', 'User', { onDelete: 'setDefault', isNullable: true }),
          ],
        }),
      ])
    );
    expect(output.warnings).toEqual([
      'Post.a: SET NULL on a required relation; the column is NOT NULL, so deleting a User that is referenced fails.',
      'Post.b: EF Core has no SET DEFAULT delete behavior; NO ACTION was written.',
    ]);
  });

  it('writes a one-to-one relation with a single navigation on both sides and a unique key', () => {
    const output: MultiFileEmitOutput = emit(
      schemaOf([
        model('User'),
        model('Profile', {
          fields: [idField(), field('bio', { isNullable: true })],
          relations: [
            relation('user', 'User', {
              kind: 'oneToOne',
              relatedName: 'profile',
            }),
          ],
        }),
      ])
    );
    const profile: string = entity(output, 'Profile');
    expect(profile).toContain('[Index(nameof(UserId), IsUnique = true)]');
    expect(profile).toContain('[ForeignKey(nameof(UserId))]');
    expect(entity(output, 'User')).toContain(
      '[InverseProperty(nameof(Profile.User))]\n    public Profile? Profile { get; set; }'
    );
    const fluent: string = squash(
      fileText(
        emit(
          schemaOf([
            model('User'),
            model('Profile', {
              relations: [
                relation('user', 'User', {
                  kind: 'oneToOne',
                  relatedName: 'profile',
                }),
              ],
            }),
          ]),
          { style: 'fluent' }
        ),
        'Configurations/ProfileConfiguration.cs'
      )
    );
    expect(fluent).toContain(
      'builder.HasOne(e => e.User).WithOne(r => r.Profile).HasForeignKey<Profile>(e => e.UserId);'
    );
  });

  it('takes the type of the foreign key from the key it references', () => {
    const output: MultiFileEmitOutput = emit(
      schemaOf([
        model('Ledger', {
          tableName: 'ledgers',
          fields: [field('code', { isPrimaryKey: true, maxLength: 12 })],
        }),
        model('Session', {
          fields: [
            field('id', {
              type: 'uuid',
              isPrimaryKey: true,
              default: { kind: 'uuid' },
            }),
          ],
        }),
        model('Entry', {
          fields: [idField({ type: 'bigInt' })],
          relations: [
            relation('ledger', 'Ledger', { columnName: 'ledger_code' }),
            relation('session', 'Session', { isNullable: true }),
          ],
        }),
      ])
    );
    const text: string = entity(output, 'Entry');
    expect(text).toContain(
      '[MaxLength(12)]\n    public string LedgerId { get; set; } = string.Empty;'
    );
    expect(text).toContain('public Guid? SessionId { get; set; }');
    expect(text).not.toContain('DatabaseGenerated');
  });

  it('points at a column other than the primary key with HasPrincipalKey and an alternate key', () => {
    const output: MultiFileEmitOutput = emit(
      schemaOf([
        model('Series', {
          tableName: 'series',
          fields: [
            idField(),
            field('handle', { maxLength: 20, isUnique: true }),
          ],
        }),
        model('Book', {
          relations: [
            relation('series', 'Series', {
              columnName: 'series_handle',
              toField: 'handle',
              isNullable: true,
              onDelete: 'setNull',
            }),
          ],
        }),
      ])
    );
    expect(entity(output, 'Series')).not.toContain('[Index');
    const text: string = squash(context(output));
    expect(text).toContain('entity.HasAlternateKey(e => e.Handle);');
    expect(text).toContain(
      'entity.HasOne(e => e.Series).WithMany().HasForeignKey(e => e.SeriesId).HasPrincipalKey(r => r.Handle).OnDelete(DeleteBehavior.SetNull);'
    );
    expect(entity(output, 'Book')).toContain('public string? SeriesId');
  });

  it('writes the constraint name of a relation', () => {
    const output: MultiFileEmitOutput = emit(
      schemaOf([
        model('User'),
        model('Post', {
          relations: [
            relation('author', 'User', { constraintName: 'fk_author' }),
          ],
        }),
      ])
    );
    expect(squash(context(output))).toContain(
      '.HasConstraintName("fk_author")'
    );
  });

  it('writes a self reference and tells apart relations to the same model', () => {
    const output: MultiFileEmitOutput = emit(
      schemaOf([
        model('Category', {
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
    const text: string = entity(output, 'Category');
    expect(text).toContain('public int? ParentId { get; set; }');
    expect(text).toContain('public Category? Parent { get; set; }');
    expect(text).toContain(
      'public ICollection<Category> Children { get; set; } = new List<Category>();'
    );
    expect(squash(context(output))).toContain(
      '.HasOne(e => e.Parent).WithMany(r => r.Children)'
    );
  });

  it('keeps names apart: navigations, foreign keys and fields share one namespace', () => {
    const output: MultiFileEmitOutput = emit(
      schemaOf([
        model('User'),
        model('Post', {
          fields: [
            idField(),
            field('author'),
            field('author_id', { type: 'int' }),
          ],
          relations: [relation('author', 'User', { relatedName: 'User' })],
        }),
      ])
    );
    const post: string = entity(output, 'Post');
    expect(post).toContain('public string Author {');
    expect(post).toContain('public int AuthorId {');
    expect(post).toContain('public User AuthorRef {');
    expect(post).toContain('public int AuthorRefId {');
    expect(entity(output, 'User')).toContain('UserRef');
  });

  it('skips a relation to a missing model or to a model without a single key, and warns', () => {
    const output: MultiFileEmitOutput = emit(
      schemaOf([
        model('Pair', {
          fields: [field('a', { type: 'int' }), field('b', { type: 'int' })],
          compositePrimaryKey: ['a', 'b'],
        }),
        model('Thing', {
          relations: [
            relation('ghost', 'Ghost'),
            relation('pair', 'Pair'),
            relation('others', 'Ghost', { kind: 'manyToMany' }),
          ],
        }),
      ])
    );
    const text: string = entity(output, 'Thing');
    expect(text).not.toContain('Ghost');
    expect(text).not.toContain('PairId');
    expect(output.warnings).toEqual([
      'Thing.ghost: the model Ghost is not in the input, so the relation was skipped and its column left out.',
      'Thing.pair: Pair has no single-column key to reference, so the relation was skipped and its column left out.',
      'Thing.others: the model Ghost is not in the input, so the relation was skipped.',
    ]);
  });

  it('writes composite foreign keys with HasForeignKey and HasPrincipalKey', () => {
    const output: MultiFileEmitOutput = emit(edgesSchema());
    const text: string = squash(context(output));
    expect(text).toContain(
      'entity.HasOne(e => e.Shipment).WithMany(r => r.Parcels).HasForeignKey(e => new { e.ShipOrder, e.ShipLine }).OnDelete(DeleteBehavior.SetNull);'
    );
    expect(text).toContain(
      'entity.HasOne(e => e.Region).WithMany().HasForeignKey(e => new { e.RegionCode, e.RegionZone }).HasPrincipalKey(r => new { r.Code, r.Zone }).HasConstraintName("fk_parcel_region").OnDelete(DeleteBehavior.Cascade);'
    );
    expect(text).toContain(
      'entity.HasAlternateKey(e => new { e.Code, e.Zone });'
    );
    expect(entity(output, 'Parcel')).toContain(
      'public Shipment? Shipment { get; set; }'
    );
    expect(entity(output, 'Parcel')).toContain(
      'public Region Region { get; set; } = null!;'
    );
    expect(output.warnings).toEqual(
      expect.not.arrayContaining([
        expect.stringContaining('composite foreign key'),
      ])
    );
  });
});

describe('efcore emitter: many-to-many', () => {
  const schema: IrSchema = schemaOf([
    model('Tag', { tableName: 'blog_tag' }),
    model('Post', {
      tableName: 'blog_post',
      relations: [
        relation('tags', 'Tag', {
          kind: 'manyToMany',
          columnName: 'tags_id',
          relatedName: 'posts',
        }),
      ],
    }),
  ]);

  it('writes skip navigations on both sides and names the join table the way the other formats do', () => {
    const output: MultiFileEmitOutput = emit(schema);
    expect(entity(output, 'Post')).toContain(
      'public ICollection<Tag> Tags { get; set; } = new List<Tag>();'
    );
    expect(entity(output, 'Tag')).toContain(
      'public ICollection<Post> Posts { get; set; } = new List<Post>();'
    );
    expect(context(output)).toContain(
      [
        'entity',
        '    .HasMany(e => e.Tags)',
        '    .WithMany(r => r.Posts)',
        '    .UsingEntity<Dictionary<string, object>>(',
        '        "blog_post_tags",',
        '        right => right.HasOne<Tag>().WithMany().HasForeignKey("tag_id"),',
        '        left => left.HasOne<Post>().WithMany().HasForeignKey("post_id"),',
        '        join => join.ToTable("blog_post_tags"));',
      ]
        .map((line: string, position: number) =>
          position === 0 ? line : `            ${line}`
        )
        .join('\n')
    );
    expect(context(output)).toContain('using System.Collections.Generic;');
  });

  it('writes the join in the configuration class of the owner in the fluent style', () => {
    const output: MultiFileEmitOutput = emit(schema, { style: 'fluent' });
    expect(fileText(output, 'Configurations/PostConfiguration.cs')).toContain(
      '.UsingEntity<Dictionary<string, object>>('
    );
    expect(
      fileText(output, 'Configurations/TagConfiguration.cs')
    ).not.toContain('UsingEntity');
  });

  it('writes only the owner half when the relation has no related name, and names a self reference from and to', () => {
    const output: MultiFileEmitOutput = emit(
      schemaOf([
        model('Group', {
          tableName: 'groups',
          relations: [
            relation('friends', 'Group', { kind: 'manyToMany' }),
            relation('rivals', 'Group', {
              kind: 'manyToMany',
              relatedName: 'rival_of',
            }),
          ],
        }),
      ])
    );
    const text: string = squash(context(output));
    expect(text).toContain('.HasMany(e => e.Friends).WithMany().UsingEntity');
    expect(text).toContain(
      '"groups_friends", right => right.HasOne<Group>().WithMany().HasForeignKey("to_group_id"), left => left.HasOne<Group>().WithMany().HasForeignKey("from_group_id")'
    );
    expect(text).toContain('.WithMany(r => r.RivalOf)');
    expect(entity(output, 'Group')).toContain('ICollection<Group> RivalOf');
  });

  it('writes the join table of a model with a schema in that schema', () => {
    const output: MultiFileEmitOutput = emit(
      schemaOf([
        model('Tag'),
        model('Post', {
          schema: 'blog',
          relations: [relation('tags', 'Tag', { kind: 'manyToMany' })],
        }),
      ])
    );
    expect(context(output)).toContain(
      'join => join.ToTable("post_tags", "blog")'
    );
  });

  it('skips a many-to-many between models without a single key, and warns', () => {
    const output: MultiFileEmitOutput = emit(
      schemaOf([
        model('Pair', {
          fields: [field('a', { type: 'int' }), field('b', { type: 'int' })],
          compositePrimaryKey: ['a', 'b'],
          relations: [relation('others', 'Pair', { kind: 'manyToMany' })],
        }),
      ])
    );
    expect(entity(output, 'Pair')).not.toContain('Others');
    expect(output.warnings).toEqual([
      'Pair.others: a many-to-many relation needs a single-column key on both models; the relation was skipped.',
    ]);
  });
});

describe('efcore emitter: timestamps', () => {
  const schema: IrSchema = single([
    idField(),
    field('created_at', { type: 'dateTime', default: { kind: 'now' } }),
    field('updated_at', { type: 'dateTime', isAutoUpdated: true }),
  ]);

  it('lets the context set an auto-updated column on every save', () => {
    const output: MultiFileEmitOutput = emit(schema);
    const text: string = context(output);
    expect(text).toContain(
      'entity.Property(e => e.UpdatedAt).ValueGeneratedOnAddOrUpdate();'
    );
    expect(squash(text)).toContain(
      'entity.Property(e => e.UpdatedAt).Metadata.SetBeforeSaveBehavior(PropertySaveBehavior.Save);'
    );
    expect(squash(text)).toContain(
      'entity.Property(e => e.UpdatedAt).Metadata.SetAfterSaveBehavior(PropertySaveBehavior.Save);'
    );
    expect(text).toContain(
      'public override int SaveChanges(bool acceptAllChangesOnSuccess)'
    );
    expect(text).toContain('public override Task<int> SaveChangesAsync(');
    expect(text).toContain(
      'foreach (var entry in ChangeTracker.Entries<Thing>())'
    );
    expect(text).toContain(
      'if (entry.State is EntityState.Added or EntityState.Modified)'
    );
    expect(text).toContain(
      'entry.Property(e => e.UpdatedAt).CurrentValue = now;'
    );
    expect(text).toContain('using Microsoft.EntityFrameworkCore.Metadata;');
    expect(text).toContain('using System.Threading.Tasks;');
  });

  it('writes the same in the fluent style, and no override when nothing is auto-updated', () => {
    const fluent: MultiFileEmitOutput = emit(schema, { style: 'fluent' });
    expect(fileText(fluent, 'Configurations/ThingConfiguration.cs')).toContain(
      'ValueGeneratedOnAddOrUpdate()'
    );
    expect(context(fluent)).toContain('ApplyAutoUpdatedColumns');
    expect(context(emit(single([idField()])))).not.toContain('SaveChanges');
  });

  it('warns for an auto-updated column that is not a date-time or is a key', () => {
    const output: MultiFileEmitOutput = emit(
      single([
        idField(),
        field('version', { type: 'int', isAutoUpdated: true }),
      ])
    );
    expect(context(output)).not.toContain('SaveChanges');
    expect(output.warnings).toEqual([
      'Thing.version: EF Core cannot refresh a int column on every save; it was written as an ordinary column.',
    ]);
  });
});

describe('efcore emitter: naming modes', () => {
  it('writes singular snake_case tables and columns in normalize mode over the same properties', () => {
    const schema: IrSchema = schemaOf([
      model('BlogPost', {
        tableName: 'BlogPosts',
        fields: [
          idField(),
          field('viewCount', { columnName: 'ViewCount', type: 'int' }),
        ],
      }),
    ]);
    const preserve: string = entity(emit(schema), 'BlogPost');
    expect(preserve).not.toContain('[Table');
    expect(preserve).toContain('public int ViewCount { get; set; }');
    const normalize: MultiFileEmitOutput = emit(schema, {
      naming: 'normalize',
    });
    const text: string = entity(normalize, 'BlogPost');
    expect(text).toContain('[Table("blog_post")]');
    expect(text).toContain('[Column("view_count")]\n    public int ViewCount');
    // Counting keys become UUIDs, and the timestamps are added.
    expect(text).toContain('public Guid Id { get; set; }');
    expect(text).toContain('public DateTime CreatedAt { get; set; }');
    expect(text).toContain('public DateTime UpdatedAt { get; set; }');
    expect(context(normalize)).toContain('ValueGeneratedOnAddOrUpdate()');
  });
});

describe('efcore emitter: constructs it cannot write', () => {
  it('warns about the Prisma-only constructs the other emitters warn about, and not about the ones it writes', () => {
    const output: MultiFileEmitOutput = emit(
      schemaOf([
        model('Thing', {
          fields: [
            idField(),
            field('ignored', { isIgnored: true }),
            field('raw', {
              default: { kind: 'dbExpression', expression: 'x()' },
            }),
            field('odd', { type: 'unsupported', unsupportedType: 'circle' }),
          ],
          isIgnored: true,
          schema: 'public',
        }),
      ])
    );
    expect(output.warnings).toEqual(
      expect.arrayContaining([
        'Thing: @@ignore has no equivalent here; the model was written as a normal model.',
        'Thing.ignored: @ignore has no equivalent here; the field was written as a normal field.',
        'Thing.odd: the database type "circle" has no CLR equivalent; the column was written as a string with that column type.',
      ])
    );
    expect(output.warnings.join('\n')).not.toContain('@@schema');
    expect(output.warnings.join('\n')).not.toContain(
      'database default expression'
    );
    expect(output.warnings.join('\n')).not.toContain('Unsupported');
    expect(entity(output, 'Thing')).toContain(
      '[Table("thing", Schema = "public")]'
    );
  });

  it('warns that the update action of a relation is ignored', () => {
    const output: MultiFileEmitOutput = emit(
      schemaOf([
        model('User'),
        model('Post', {
          relations: [relation('author', 'User', { onUpdate: 'cascade' })],
        }),
      ])
    );
    expect(output.warnings).toEqual([
      'Post.author: the onUpdate action "cascade" is not supported by this format and was ignored.',
    ]);
  });
});

describe('efcore emitter: reading the output back', () => {
  async function reread(output: MultiFileEmitOutput): Promise<IrSchema> {
    return expectOk(
      await parseEfcore(
        Object.keys(output.files)
          .sort()
          .map((path: string) => ({ path, text: output.files[path] ?? '' })),
        { appLabel: 'app' }
      )
    );
  }

  it('reads what it wrote as the same schema for a blog-like schema, in both styles', async () => {
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
            field('created_at', { type: 'dateTime', default: { kind: 'now' } }),
            field('updated_at', { type: 'dateTime', isAutoUpdated: true }),
            field('title', { maxLength: 100 }),
            field('status', {
              enumName: 'Status',
              maxLength: 10,
              default: { kind: 'enumValue', value: 'LIVE' },
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
            field('views', {
              type: 'int',
              default: { kind: 'literal', value: 0 },
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
      [UNLABELLED_STATUS]
    );
    for (const style of EFCORE_STYLES) {
      const parsed: IrSchema = await reread(emit(schema, { style }));
      expect(compareIr(schema, parsed).map(formatDifference), style).toEqual(
        []
      );
      expect(parsed.warnings, style).toEqual([]);
    }
  });

  it('keeps the stored values of an enum with a converter and of an enum of numbers', async () => {
    const schema: IrSchema = schemaOf(
      [
        model('Order', {
          fields: [
            idField(),
            field('state', { type: 'int', enumName: 'State' }),
            field('status', { enumName: 'Status' }),
          ],
        }),
      ],
      [
        STATUS_ENUM,
        {
          name: 'State',
          values: [
            { name: 'Pending', dbValue: '0' },
            { name: 'Shipped', dbValue: '2' },
          ],
        },
      ]
    );
    for (const style of EFCORE_STYLES) {
      const parsed: IrSchema = await reread(emit(schema, { style }));
      const status = parsed.enums.find(
        (candidate) => candidate.name === 'Status'
      );
      expect(status?.values.map((value) => value.dbValue)).toEqual([
        'draft',
        'live',
      ]);
      const state = parsed.enums.find(
        (candidate) => candidate.name === 'State'
      );
      expect(state?.values.map((value) => value.dbValue)).toEqual(['0', '2']);
      // The numbers are read as an integer enum, with the warning EF Core's default calls for.
      expect(parsed.warnings.join('\n')).toContain('stored as an integer');
      expect(parsed.warnings.join('\n')).not.toContain(
        'custom value converter'
      );
    }
  });

  it('reads the EF Core fixtures back unchanged, in both styles', async () => {
    const groups: [string, Promise<IrSchema>][] = [
      [
        'canonical',
        (async (): Promise<IrSchema> => {
          const fixture = CANONICAL_FIXTURES.find(
            (candidate) => candidate.format === 'efcore'
          );
          return expectOk(
            await parseEfcore(
              (fixture?.paths ?? []).map((path: string) => ({
                path,
                text: readFileSync(path, 'utf8'),
              })),
              { appLabel: 'app' }
            )
          );
        })(),
      ],
      ...EFCORE_EXTRAS.map((name: string): [string, Promise<IrSchema>] => [
        name,
        parseEfcoreExtra(name),
      ]),
    ];
    for (const [label, pending] of groups) {
      const before: IrSchema = await pending;
      for (const style of EFCORE_STYLES) {
        const after: IrSchema = await reread(emit(before, { style }));
        expect(
          compareIr(before, after).map(formatDifference),
          `${label} ${style}`
        ).toEqual([]);
      }
    }
  });

  it('reads the canonical blog schema of every format back, in both styles', async () => {
    for (const fixture of CANONICAL_FIXTURES) {
      if (fixture.format === 'efcore') {
        continue;
      }
      const adapter = expectOk(getFormat(fixture.format));
      const before: IrSchema = expectOk(
        (await adapter.parse?.(loadCanonicalSources(fixture.format), {
          ...DEFAULT_OPTIONS,
          from: fixture.format,
        } as never)) ?? {
          ok: false as const,
          error: { code: 'PARSE_FAILED' as const, message: 'no parser' },
        }
      );
      for (const style of EFCORE_STYLES) {
        const after: IrSchema = await reread(emit(before, { style }));
        expect(after.models.length, `${fixture.format} ${style}`).toBe(
          before.models.length
        );
        expect(after.warnings, `${fixture.format} ${style}`).toEqual([]);
        const differences: string[] = compareIr(before, after).map(
          formatDifference
        );
        // What reading changes is limited to labels and names the source format spells differently.
        for (const difference of differences) {
          expect(difference, `${fixture.format} ${style}`).toMatch(
            /^(enumValueLabel|fieldMaxLength|indexName|enumValueName|relatedName|fieldDefault)/
          );
        }
      }
    }
  });

  it('converts through convertText in both styles and keeps the model count', async () => {
    for (const style of EFCORE_STYLES) {
      const result: ConvertResult = expectOk(
        await convertText(loadCanonicalSources('prisma'), {
          ...DEFAULT_OPTIONS,
          from: 'prisma',
          to: 'efcore',
          style,
        })
      );
      expect(result.output).toBe('');
      const models: number = result.modelCount;
      const files: string[] = Object.keys(result.files ?? {});
      expect(files.filter((path) => path.startsWith('Models/')).length).toBe(
        models + 1
      );
      expect(files).toContain('AppDbContext.cs');
    }
  });
});

describe('efcore emitter: golden files', () => {
  const goldenRoot: string = fileURLToPath(
    new URL('./golden-extras/', import.meta.url)
  );

  // The default (annotations style) conversions live in test/golden/<format>-to-efcore.<naming>/
  // (conversion.test.ts). The fluent style output of every canonical schema is checked here.
  describe.each(
    CANONICAL_FIXTURES.map((fixture) => fixture.format).filter(
      (format: string) => format !== 'efcore'
    )
  )('%s source in the fluent style', (format) => {
    it('matches the golden output', async () => {
      const files: Record<string, string> = {};
      for (const naming of ['preserve', 'normalize'] as const) {
        const result: ConvertResult = await convertCanonical(format, 'efcore', {
          naming,
          style: 'fluent',
        });
        for (const [path, text] of Object.entries(result.files ?? {})) {
          files[`${naming}/${path}`] = text;
        }
        files[`${naming}.warnings.txt`] = `${result.warnings.join('\n')}\n`;
      }
      expectFilesMatchGolden(
        `efcore-fluent/${format}-to-efcore`,
        files,
        goldenRoot
      );
    });
  });

  const fixtures: [string, () => Promise<IrSchema>, Provider][] = [
    ['kitchen-sink', () => Promise.resolve(kitchenSinkSchema()), 'sqlite'],
    ['stress', () => Promise.resolve(stressSchema()), 'sqlite'],
    ['constructs', () => Promise.resolve(constructsSchema()), 'postgresql'],
    ['edges', () => Promise.resolve(edgesSchema()), 'postgresql'],
    ...EXTRA_SOURCES.map(
      (source): [string, () => Promise<IrSchema>, Provider] => [
        source.label,
        () => parseSource(source),
        'postgresql',
      ]
    ),
    ...EFCORE_EXTRAS.map(
      (name: string): [string, () => Promise<IrSchema>, Provider] => [
        `efcore-${name}`,
        () => parseEfcoreExtra(name),
        'postgresql',
      ]
    ),
  ];

  describe.each(fixtures)('%s fixture', (label, build, provider) => {
    it('matches the golden output in both styles and naming modes, with the warnings and what reading it back changes', async () => {
      const schema: IrSchema = await build();
      const files: Record<string, string> = {};
      for (const style of EFCORE_STYLES) {
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
      // What the EF Core reader makes of the preserve output: the drift of the format.
      const reread_: IrSchema = expectOk(
        await parseEfcore(
          Object.entries(emit(schema, { provider }).files)
            .sort(([first], [second]) => (first < second ? -1 : 1))
            .map(([path, text]) => ({ path, text })),
          { appLabel: 'app' }
        )
      );
      files['annotations.preserve.drift.txt'] = `${compareIr(schema, reread_)
        .map(formatDifference)
        .join('\n')}\n`;
      expectFilesMatchGolden(`efcore-fixtures/${label}`, files, goldenRoot);
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
    expectFilesMatchGolden('efcore-providers/constructs', files, goldenRoot);
  });
});
