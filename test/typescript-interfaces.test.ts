import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import type { EmitOutput } from '../src/emitters/prisma.js';
import {
  emitTypescriptInterfaces,
  type TypescriptInterfacesOptions,
} from '../src/emitters/typescriptInterfaces.js';
import type {
  IrEnum,
  IrField,
  IrModel,
  IrRelation,
  IrSchema,
} from '../src/ir.js';
import { getFormat, getFormatByExtension } from '../src/formats.js';
import { convertCanonical } from './harness.js';

function field(name: string, overrides: Partial<IrField> = {}): IrField {
  return {
    name,
    columnName: name,
    type: 'string',
    isPrimaryKey: false,
    isUnique: false,
    isNullable: false,
    isAutoUpdated: false,
    ...overrides,
  };
}

function idField(): IrField {
  return field('id', {
    type: 'int',
    isPrimaryKey: true,
    default: { kind: 'autoIncrement' },
  });
}

function relation(
  name: string,
  targetModel: string,
  overrides: Partial<IrRelation> = {}
): IrRelation {
  return {
    name,
    kind: 'foreignKey',
    targetModel,
    columnName: `${name}_id`,
    isNullable: false,
    onDelete: 'cascade',
    ...overrides,
  };
}

function model(name: string, overrides: Partial<IrModel> = {}): IrModel {
  return {
    name,
    tableName: name.toLowerCase(),
    appLabel: 'app',
    fields: [idField()],
    relations: [],
    indexes: [],
    ...overrides,
  };
}

function schemaOf(models: IrModel[], enums: IrEnum[] = []): IrSchema {
  return { models, enums, warnings: [] };
}

function emit(
  schema: IrSchema,
  overrides: Partial<TypescriptInterfacesOptions> = {}
): EmitOutput {
  return emitTypescriptInterfaces(schema, { camelFields: false, ...overrides });
}

describe('TypeScript interfaces emitter', () => {
  it('maps every scalar type to a JSON-friendly TypeScript type', () => {
    const types = [
      'string',
      'text',
      'int',
      'bigInt',
      'float',
      'decimal',
      'boolean',
      'dateTime',
      'date',
      'time',
      'uuid',
      'json',
      'bytes',
    ] as const;
    const output: EmitOutput = emit(
      schemaOf([
        model('Thing', {
          fields: [
            idField(),
            ...types.map((type) => field(`f_${type}`, { type })),
          ],
        }),
      ])
    );
    expect(output.warnings).toEqual([]);
    expect(output.text).toBe(`export interface Thing {
  id: number;
  f_string: string;
  f_text: string;
  f_int: number;
  f_bigInt: string;
  f_float: number;
  f_decimal: string;
  f_boolean: boolean;
  f_dateTime: string;
  f_date: string;
  f_time: string;
  f_uuid: string;
  f_json: unknown;
  f_bytes: string;
}
`);
  });

  it('types dates as Date when requested', () => {
    const output: EmitOutput = emit(
      schemaOf([
        model('Event', {
          fields: [
            idField(),
            field('at', { type: 'dateTime' }),
            field('day', { type: 'date', isNullable: true }),
            field('clock', { type: 'time' }),
          ],
        }),
      ]),
      { dates: 'date' }
    );
    expect(output.text).toContain('at: Date;');
    expect(output.text).toContain('day: Date | null;');
    expect(output.text).toContain('clock: string;');
  });

  it('adds | null for nullable fields and never marks fields optional', () => {
    const output: EmitOutput = emit(
      schemaOf([
        model('Note', {
          fields: [
            idField(),
            field('body', {
              isNullable: true,
              default: { kind: 'literal', value: 'x' },
            }),
            field('created', { type: 'dateTime', default: { kind: 'now' } }),
          ],
        }),
      ])
    );
    expect(output.text).toContain('  body: string | null;');
    expect(output.text).toContain('  created: string;');
  });

  it('writes string enums with the stored values and typed fields', () => {
    const output: EmitOutput = emit(
      schemaOf(
        [
          model('Post', {
            fields: [
              idField(),
              field('status', { enumName: 'PostStatus' }),
              field('kind', { enumName: 'Missing' }),
            ],
          }),
        ],
        [
          {
            name: 'PostStatus',
            values: [
              { name: 'DRAFT', dbValue: 'draft', label: 'Draft */ copy' },
              { name: 'in-review', dbValue: "it's" },
            ],
          },
        ]
      )
    );
    expect(output.text).toContain(`export enum PostStatus {
  /** Draft *\\/ copy */
  DRAFT = 'draft',
  'in-review' = 'it\\'s',
}`);
    expect(output.text).toContain('  status: PostStatus;');
    expect(output.text).toContain('  kind: string;');
    expect(output.warnings).toEqual([
      'Post.kind: enum "Missing" does not exist in the schema; the property is typed as string.',
    ]);
  });

  it('writes foreign keys as scalars with an optional expanded relation and reverse lists', () => {
    const output: EmitOutput = emit(
      schemaOf([
        model('Author', {
          fields: [field('uid', { type: 'uuid', isPrimaryKey: true })],
        }),
        model('Book', {
          relations: [
            relation('author', 'Author', { relatedName: 'books' }),
            relation('editor', 'Author', { isNullable: true }),
          ],
        }),
        model('Cover', {
          relations: [relation('book', 'Book', { kind: 'oneToOne' })],
        }),
      ])
    );
    expect(output.warnings).toEqual([]);
    expect(output.text).toContain(`export interface Author {
  uid: string;
  books?: Book[];
  book_set?: Book[];
}`);
    expect(output.text).toContain(`export interface Book {
  id: number;
  author_id: string;
  author?: Author;
  editor_id: string | null;
  editor?: Author | null;
  cover?: Cover | null;
}`);
  });

  it('writes many-to-many relations as optional arrays on both sides', () => {
    const output: EmitOutput = emit(
      schemaOf([
        model('Post', {
          relations: [
            relation('tags', 'Tag', {
              kind: 'manyToMany',
              relatedName: 'posts',
            }),
          ],
        }),
        model('Tag'),
      ])
    );
    expect(output.text).toContain('  tags?: Tag[];');
    expect(output.text).toContain(`export interface Tag {
  id: number;
  posts?: Post[];
}`);
  });

  it('uses camelCase property names with camelFields and keeps names otherwise', () => {
    const schema: IrSchema = schemaOf([
      model('Post', {
        fields: [idField(), field('created_at', { type: 'dateTime' })],
        relations: [
          relation('blog_author', 'Post', { relatedName: 'posts_by' }),
        ],
      }),
    ]);
    const camel: string = emit(schema, { camelFields: true }).text;
    expect(camel).toContain('  createdAt: string;');
    expect(camel).toContain('  blogAuthorId: number;');
    expect(camel).toContain('  blogAuthor?: Post;');
    expect(camel).toContain('  postsBy?: Post[];');
    const preserved: string = emit(schema).text;
    expect(preserved).toContain('  created_at: string;');
    expect(preserved).toContain('  blog_author_id: number;');
    expect(preserved).toContain('  posts_by?: Post[];');
  });

  it('quotes property and enum member names that are not identifiers', () => {
    const output: EmitOutput = emit(
      schemaOf(
        [
          model('Odd', {
            fields: [idField(), field('first-name'), field('2nd')],
          }),
        ],
        [{ name: 'Mode', values: [{ name: 'a b', dbValue: 'ab' }] }]
      )
    );
    expect(output.text).toContain("  'first-name': string;");
    expect(output.text).toContain("  '2nd': string;");
    expect(output.text).toContain("  'a b' = 'ab',");
  });

  it('uses the type of the referenced column, following to_field and key relations', () => {
    const output: EmitOutput = emit(
      schemaOf([
        model('Country', {
          fields: [idField(), field('code', { isUnique: true })],
        }),
        model('City', {
          relations: [relation('country', 'Country', { toField: 'code' })],
        }),
        model('Capital', {
          fields: [],
          relations: [
            relation('city', 'City', { kind: 'oneToOne', isPrimaryKey: true }),
          ],
        }),
      ])
    );
    expect(output.warnings).toEqual([]);
    expect(output.text).toContain('  country_id: string;');
    expect(output.text).toContain('  city_id: number;');
  });

  it('warns for relations to unknown models and unresolvable keys', () => {
    const output: EmitOutput = emit(
      schemaOf([
        model('Lonely', { relations: [relation('ghost', 'Ghost')] }),
        model('Pair', {
          fields: [field('a'), field('b')],
          compositePrimaryKey: ['a', 'b'],
        }),
        model('Ref', { relations: [relation('pair', 'Pair')] }),
      ])
    );
    expect(output.text).not.toContain('ghost');
    expect(output.text).toContain('  pair_id: unknown;');
    expect(output.text).toContain('  pair?: Pair;');
    expect(output.warnings).toEqual([
      'Lonely.ghost: target model "Ghost" does not exist in the schema; the relation was skipped.',
      'Ref.pair: target model "Pair" has no single-column primary key to reference; the foreign key "pair_id" is typed as unknown.',
    ]);
  });

  it('warns about unknown field types and invalid or clashing names', () => {
    const output: EmitOutput = emit(
      schemaOf(
        [
          model('Thing', {
            fields: [
              idField(),
              field('weird', { type: 'mystery' as IrField['type'] }),
            ],
          }),
          model('my-model'),
          model('Mode'),
        ],
        [
          {
            name: 'Mode',
            values: [
              { name: 'A', dbValue: 'a' },
              { name: 'A', dbValue: 'b' },
            ],
          },
        ]
      )
    );
    expect(output.text).toContain('  weird: unknown;');
    expect(output.text).toContain('export interface my_model {');
    expect(output.text).toContain('export interface Mode2 {');
    expect(output.warnings).toEqual([
      'my-model: "my-model" is not a valid TypeScript identifier; it was written as "my_model".',
      'Mode: the name is already used by an enum or another model; the interface was written as "Mode2".',
      'Thing.weird: unknown field type "mystery"; the property is typed as unknown.',
      'enum Mode: the member "A" is declared more than once; the repeat was written as "A2".',
    ]);
  });

  it('warns when a model named Date shadows the Date type in date mode', () => {
    const output: EmitOutput = emit(schemaOf([model('Date')]), {
      dates: 'date',
    });
    expect(output.warnings).toHaveLength(1);
    expect(output.warnings[0]).toContain('"Date"');
  });

  it('is deterministic and returns empty text for an empty schema', () => {
    const schema: IrSchema = schemaOf([model('A'), model('B')]);
    expect(emit(schema).text).toBe(emit(schema).text);
    expect(emit(schemaOf([])).text).toBe('');
  });
});

describe('typescript format registration', () => {
  it('is output only and does not claim .ts', () => {
    const adapter = getFormat('typescript');
    expect(adapter.ok).toBe(true);
    if (adapter.ok) {
      expect(adapter.value.parse).toBeUndefined();
      expect(adapter.value.emit).toBeDefined();
      expect(adapter.value.extensions).toEqual([]);
    }
    expect(getFormatByExtension('.ts')).toBeUndefined();
  });
});

describe('emitted TypeScript compiles', () => {
  /** Compiles source text in memory under strict settings and returns the diagnostic messages. */
  function diagnose(files: Record<string, string>): string[] {
    const options: ts.CompilerOptions = {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      types: [],
    };
    const host: ts.CompilerHost = ts.createCompilerHost(options);
    const defaultSource = host.getSourceFile.bind(host);
    const defaultExists = host.fileExists.bind(host);
    const defaultRead = host.readFile.bind(host);
    host.fileExists = (name: string): boolean =>
      name in files || defaultExists(name);
    host.readFile = (name: string): string | undefined =>
      files[name] ?? defaultRead(name);
    host.getSourceFile = (name, languageVersion, onError) => {
      const text: string | undefined = files[name];
      return text === undefined
        ? defaultSource(name, languageVersion, onError)
        : ts.createSourceFile(name, text, languageVersion);
    };
    const program: ts.Program = ts.createProgram(
      Object.keys(files),
      options,
      host
    );
    return ts
      .getPreEmitDiagnostics(program)
      .map((diagnostic: ts.Diagnostic) =>
        ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')
      );
  }

  for (const from of ['django', 'prisma', 'typeorm']) {
    for (const naming of ['preserve', 'normalize'] as const) {
      it(`${from} -> typescript with ${naming} naming has no diagnostics`, async () => {
        const result = await convertCanonical(from, 'typescript', { naming });
        expect(result.output).not.toBe('');
        expect(diagnose({ 'models.ts': result.output })).toEqual([]);
      });
    }
  }

  it('compiles with Date-typed dates', () => {
    const output: EmitOutput = emit(
      schemaOf([
        model('E', {
          fields: [idField(), field('at', { type: 'dateTime' })],
        }),
      ]),
      { dates: 'date' }
    );
    expect(diagnose({ 'dates.ts': output.text })).toEqual([]);
  });
});
