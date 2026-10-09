import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import type { EmitOutput } from '../src/emitters/prisma.js';
import { emitTypeorm } from '../src/emitters/typeorm.js';
import type { IrField, IrModel, IrRelation, IrSchema } from '../src/ir.js';
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

function schemaOf(models: IrModel[], enums: IrSchema['enums'] = []): IrSchema {
  return { models, enums, warnings: [] };
}

function emit(
  schema: IrSchema,
  overrides: Partial<{
    provider: 'postgresql' | 'mysql' | 'sqlite' | 'sqlserver' | 'mongodb';
    camelFields: boolean;
  }> = {}
): EmitOutput {
  return emitTypeorm(schema, {
    provider: 'postgresql',
    camelFields: false,
    ...overrides,
  });
}

describe('typeorm emitter: columns', () => {
  it('writes one import line and one blank line between entities', () => {
    const output: EmitOutput = emit(schemaOf([model('A'), model('B')]));
    const lines: string[] = output.text.split('\n');
    expect(lines[0]).toBe(
      "import { Entity, PrimaryGeneratedColumn } from 'typeorm';"
    );
    expect(lines[1]).toBe('');
    expect(output.text).toContain('}\n\n@Entity(');
    expect(output.text.match(/^import /gm)).toHaveLength(1);
    expect(output.text.endsWith('}\n')).toBe(true);
  });

  it('maps types, length, precision, nullability, unique and defaults', () => {
    const output: EmitOutput = emit(
      schemaOf([
        model('Item', {
          tableName: 'shop_item',
          fields: [
            idField(),
            field('title', { maxLength: 80, isUnique: true }),
            field('notes', { type: 'text', isNullable: true }),
            field('price', { type: 'decimal', maxDigits: 8, decimalPlaces: 2 }),
            field('stock', {
              type: 'int',
              default: { kind: 'literal', value: 0 },
            }),
            field('label', { default: { kind: 'literal', value: "it's" } }),
            field('active', {
              type: 'boolean',
              default: { kind: 'literal', value: true },
            }),
            field('big', { type: 'bigInt' }),
            field('data', { type: 'json', isNullable: true }),
          ],
        }),
      ])
    );
    expect(output.warnings).toEqual([]);
    const text: string = output.text;
    expect(text).toContain("@Entity('shop_item')");
    expect(text).toContain(
      "@PrimaryGeneratedColumn('increment')\n  id!: number;"
    );
    expect(text).toContain(
      "@Column({ type: 'varchar', length: 80, unique: true })\n  title!: string;"
    );
    expect(text).toContain(
      "@Column({ type: 'text', nullable: true })\n  notes!: string | null;"
    );
    expect(text).toContain(
      "@Column({ type: 'decimal', precision: 8, scale: 2 })\n  price!: string;"
    );
    expect(text).toContain('default: 0 })');
    expect(text).toContain('default: "it\'s" })');
    expect(text).toContain('default: true })');
    expect(text).toContain("@Column({ type: 'bigint' })\n  big!: string;");
    expect(text).toContain(
      "@Column({ type: 'jsonb', nullable: true })\n  data!: unknown | null;"
    );
  });

  it('writes explicit column names in preserve mode and camelCase properties in normalize mode', () => {
    const schema: IrSchema = schemaOf([
      model('Item', {
        fields: [idField(), field('view_count', { type: 'int' })],
      }),
    ]);
    expect(emit(schema).text).toContain(
      "@Column({ type: 'int' })\n  view_count!: number;"
    );
    expect(emit(schema, { camelFields: true }).text).toContain(
      "@Column({ name: 'view_count', type: 'int' })\n  viewCount!: number;"
    );
    const renamed: IrSchema = schemaOf([
      model('Item', {
        fields: [idField(), field('title', { columnName: 'item_title' })],
      }),
    ]);
    expect(emit(renamed).text).toContain(
      "@Column({ name: 'item_title', type: 'varchar' })\n  title!: string;"
    );
  });

  it('uses uuid, bigint and composite primary keys', () => {
    const output: EmitOutput = emit(
      schemaOf([
        model('A', {
          fields: [
            field('id', {
              type: 'uuid',
              isPrimaryKey: true,
              default: { kind: 'uuid' },
            }),
          ],
        }),
        model('B', {
          fields: [
            field('id', {
              type: 'bigInt',
              isPrimaryKey: true,
              default: { kind: 'autoIncrement' },
            }),
          ],
        }),
        model('C', {
          fields: [field('code'), field('region')],
          compositePrimaryKey: ['code', 'region'],
        }),
        model('D', { fields: [field('slug', { isPrimaryKey: true })] }),
      ])
    );
    expect(output.warnings).toEqual([]);
    expect(output.text).toContain(
      "@PrimaryGeneratedColumn('uuid')\n  id!: string;"
    );
    expect(output.text).toContain(
      "@PrimaryGeneratedColumn('increment', { type: 'bigint' })\n  id!: string;"
    );
    expect(output.text).toContain(
      "@PrimaryColumn({ type: 'varchar' })\n  code!: string;"
    );
    expect(output.text).toContain(
      "@PrimaryColumn({ type: 'varchar' })\n  region!: string;"
    );
    expect(output.text).toContain(
      "@PrimaryColumn({ type: 'varchar' })\n  slug!: string;"
    );
  });

  it('writes an auto-increment bigint key as a plain integer on SQLite', () => {
    // SQLite rejects `bigint PRIMARY KEY AUTOINCREMENT`; INTEGER PRIMARY KEY is 64 bits wide.
    const schema: IrSchema = schemaOf([
      model('B', {
        fields: [
          field('id', {
            type: 'bigInt',
            isPrimaryKey: true,
            default: { kind: 'autoIncrement' },
          }),
        ],
      }),
    ]);
    const sqlite: EmitOutput = emit(schema, { provider: 'sqlite' });
    expect(sqlite.text).toContain(
      "@PrimaryGeneratedColumn('increment')\n  id!: number;"
    );
    expect(sqlite.text).not.toContain('bigint');
    expect(emit(schema, { provider: 'mysql' }).text).toContain(
      "@PrimaryGeneratedColumn('increment', { type: 'bigint' })\n  id!: string;"
    );
  });

  it('uses CreateDateColumn and UpdateDateColumn for timestamps', () => {
    const output: EmitOutput = emit(
      schemaOf([
        model('Item', {
          fields: [
            idField(),
            field('created_at', { type: 'dateTime', default: { kind: 'now' } }),
            field('updated_at', { type: 'dateTime', isAutoUpdated: true }),
            field('published_at', {
              type: 'dateTime',
              default: { kind: 'now' },
            }),
          ],
        }),
      ])
    );
    expect(output.text).toContain(
      "@CreateDateColumn({ type: 'timestamptz' })\n  created_at!: Date;"
    );
    expect(output.text).toContain(
      "@UpdateDateColumn({ type: 'timestamptz' })\n  updated_at!: Date;"
    );
    expect(output.text).toContain(
      "@Column({ type: 'timestamptz', default: () => 'CURRENT_TIMESTAMP' })\n  published_at!: Date;"
    );
  });

  it('emits TypeScript enums and uses them in enum columns', () => {
    const output: EmitOutput = emit(
      schemaOf(
        [
          model('Post', {
            fields: [
              idField(),
              field('status', {
                enumName: 'Status',
                default: { kind: 'enumValue', value: 'DRAFT' },
              }),
              field('kind', {
                enumName: 'Status',
                isNullable: true,
                default: { kind: 'literal', value: 'published' },
              }),
            ],
          }),
        ],
        [
          {
            name: 'Status',
            values: [
              { name: 'DRAFT', dbValue: 'draft' },
              { name: 'PUBLISHED', dbValue: 'published' },
            ],
          },
        ]
      )
    );
    expect(output.warnings).toEqual([]);
    expect(output.text).toContain(
      "export enum Status {\n  DRAFT = 'draft',\n  PUBLISHED = 'published',\n}"
    );
    expect(output.text).toContain(
      "@Column({ type: 'enum', enum: Status, default: Status.DRAFT })\n  status!: Status;"
    );
    expect(output.text).toContain('default: Status.PUBLISHED');
    expect(output.text).toContain('kind!: Status | null;');
  });

  it('chooses column types for the provider', () => {
    const schema: IrSchema = schemaOf([
      model('Item', {
        fields: [
          idField(),
          field('at', { type: 'dateTime' }),
          field('uid', { type: 'uuid' }),
          field('doc', { type: 'json' }),
        ],
      }),
    ]);
    const mysql: string = emit(schema, { provider: 'mysql' }).text;
    expect(mysql).toContain("type: 'datetime'");
    expect(mysql).toContain("type: 'varchar', length: 36");
    expect(mysql).toContain("type: 'json'");
    const sqlite: string = emit(schema, { provider: 'sqlite' }).text;
    expect(sqlite).toContain("type: 'simple-json'");
  });
});

describe('typeorm emitter: relations', () => {
  const blogModels: IrModel[] = [
    model('User', { tableName: 'auth_user' }),
    model('Profile', {
      relations: [
        relation('user', 'User', { kind: 'oneToOne', relatedName: 'profile' }),
      ],
    }),
    model('Post', {
      relations: [
        relation('author', 'User', { relatedName: 'posts' }),
        relation('editor', 'User', {
          isNullable: true,
          onDelete: 'setNull',
          relatedName: 'edited_posts',
        }),
        relation('tags', 'Tag', {
          kind: 'manyToMany',
          columnName: '',
          relatedName: 'posts',
        }),
      ],
    }),
    model('Tag'),
  ];

  it('emits owning and inverse sides for each relation kind', () => {
    const output: EmitOutput = emit(schemaOf(blogModels));
    expect(output.warnings).toEqual([]);
    const text: string = output.text;
    expect(text).toContain(
      "@ManyToOne(() => User, (entity) => entity.posts, {\n    onDelete: 'CASCADE',\n    nullable: false,\n  })\n  @JoinColumn({ name: 'author_id' })\n  author!: Relation<User>;"
    );
    expect(text).toContain("onDelete: 'SET NULL'");
    expect(text).toContain('editor!: Relation<User> | null;');
    expect(text).toContain(
      '@OneToMany(() => Post, (entity) => entity.author)\n  posts!: Post[];'
    );
    expect(text).toContain(
      '@OneToMany(() => Post, (entity) => entity.editor)\n  edited_posts!: Post[];'
    );
    expect(text).toContain(
      "@OneToOne(() => User, (entity) => entity.profile, {\n    onDelete: 'CASCADE',\n    nullable: false,\n  })\n  @JoinColumn({ name: 'user_id' })\n  user!: Relation<User>;"
    );
    expect(text).toContain(
      '@OneToOne(() => Profile, (entity) => entity.user)\n  profile!: Relation<Profile> | null;'
    );
    expect(text).toContain(
      "@ManyToMany(() => Tag, (entity) => entity.posts)\n  @JoinTable({\n    name: 'post_tags',\n    joinColumn: { name: 'post_id', referencedColumnName: 'id' },\n    inverseJoinColumn: { name: 'tag_id', referencedColumnName: 'id' },\n  })\n  tags!: Tag[];"
    );
    expect(text).toContain(
      '@ManyToMany(() => Post, (entity) => entity.tags)\n  posts!: Post[];'
    );
    // The inverse side never carries @JoinTable or @JoinColumn.
    expect(text.match(/@JoinTable/g)).toHaveLength(1);
    expect(text.match(/@JoinColumn/g)).toHaveLength(3);
  });

  it('names the inverse side after the model when there is no related name', () => {
    const output: EmitOutput = emit(
      schemaOf([model('A'), model('B', { relations: [relation('a', 'A')] })])
    );
    expect(output.text).toContain('b_set!: B[];');
  });

  it('writes class-level indexes and unique constraints', () => {
    const output: EmitOutput = emit(
      schemaOf([
        model('User'),
        model('Post', {
          fields: [idField(), field('title')],
          relations: [relation('author', 'User')],
          indexes: [
            { fields: ['title'], isUnique: false },
            { fields: ['author_id', 'title'], isUnique: true },
            { fields: ['title', 'author'], isUnique: false, name: 'by_title' },
          ],
        }),
      ])
    );
    expect(output.warnings).toEqual([]);
    expect(output.text).toContain(
      "@Entity('post')\n@Index(['title'])\n@Unique(['author', 'title'])\n@Index('by_title', ['title', 'author'])\nexport class Post {"
    );
  });

  it('writes a primary-key relation as a primary column plus a join column', () => {
    const output: EmitOutput = emit(
      schemaOf([
        model('Place'),
        model('Restaurant', {
          fields: [],
          relations: [
            relation('place', 'Place', {
              kind: 'oneToOne',
              isPrimaryKey: true,
              columnName: 'place_ptr_id',
            }),
          ],
        }),
      ])
    );
    expect(output.warnings).toEqual([]);
    expect(output.text).toContain(
      "@PrimaryColumn({ name: 'place_ptr_id', type: 'int' })\n  place_ptr_id!: number;"
    );
    expect(output.text).toContain("@JoinColumn({ name: 'place_ptr_id' })");
  });

  it('references a non-primary target column with referencedColumnName', () => {
    const output: EmitOutput = emit(
      schemaOf([
        model('User', {
          fields: [idField(), field('email', { isUnique: true })],
        }),
        model('Note', {
          relations: [relation('owner', 'User', { toField: 'email' })],
        }),
      ])
    );
    expect(output.text).toContain(
      "@JoinColumn({ name: 'owner_id', referencedColumnName: 'email' })"
    );
  });
});

describe('typeorm emitter: warnings', () => {
  it('warns when a relation target is missing', () => {
    const output: EmitOutput = emit(
      schemaOf([model('Post', { relations: [relation('author', 'Ghost')] })])
    );
    expect(output.warnings).toEqual([
      'Post.author: target model "Ghost" does not exist in the schema; the relation was skipped.',
    ]);
    expect(output.text).not.toContain('author');
  });

  it('warns when a model has no primary key', () => {
    const output: EmitOutput = emit(
      schemaOf([model('Loose', { fields: [field('name')] })])
    );
    expect(output.warnings).toEqual([
      'Loose: the model has no primary key; TypeORM requires at least one primary column.',
    ]);
  });

  it('warns about defaults and types it cannot represent', () => {
    const output: EmitOutput = emit(
      schemaOf([
        model('Item', {
          fields: [
            idField(),
            field('counter', {
              type: 'int',
              default: { kind: 'autoIncrement' },
            }),
            field('uid', { type: 'uuid', default: { kind: 'uuid' } }),
            field('kind', { enumName: 'Missing' }),
            field('1st place'),
          ],
        }),
      ]),
      { provider: 'sqlite' }
    );
    expect(output.warnings).toEqual(
      expect.arrayContaining([
        'Item.1st place: "1st place" is not a valid TypeScript identifier; it was written as "_1st_place".',
        'Item.counter: an auto-increment default is only supported on primary keys; it was dropped.',
        'Item.uid: SQLite has no database-side UUID default; the default was dropped.',
        'Item.kind: enum "Missing" does not exist in the schema; the column is written as a plain string.',
      ])
    );
  });

  it('warns that SQL Server has no enum columns', () => {
    const output: EmitOutput = emit(
      schemaOf(
        [model('P', { fields: [idField(), field('s', { enumName: 'E' })] })],
        [{ name: 'E', values: [{ name: 'A', dbValue: 'a' }] }]
      ),
      { provider: 'sqlserver' }
    );
    expect(output.warnings).toEqual([
      'P.s: SQL Server has no enum column type; it was written as varchar and the TypeScript enum "E" is only used for typing.',
    ]);
  });
});

/** Each test builds several TypeScript programs, which exceeds vitest's 5 s default on a busy CI runner. */
const TYPE_CHECK_TIMEOUT_MS: number = 60_000;

describe('typeorm emitter: generated code type-checks', () => {
  const TYPEORM_STUB: string = `
declare module 'typeorm' {
  export type Relation<T> = T;
  export function Entity(name?: string): ClassDecorator;
  export function Column(options?: object): PropertyDecorator;
  export function PrimaryColumn(options?: object): PropertyDecorator;
  export function PrimaryGeneratedColumn(
    strategy?: 'increment' | 'uuid',
    options?: object
  ): PropertyDecorator;
  export function CreateDateColumn(options?: object): PropertyDecorator;
  export function UpdateDateColumn(options?: object): PropertyDecorator;
  export function OneToMany<T>(
    type: () => new () => T,
    inverse: (entity: T) => unknown,
    options?: object
  ): PropertyDecorator;
  export function ManyToOne<T>(
    type: () => new () => T,
    inverse?: (entity: T) => unknown,
    options?: object
  ): PropertyDecorator;
  export function OneToOne<T>(
    type: () => new () => T,
    inverse?: (entity: T) => unknown,
    options?: object
  ): PropertyDecorator;
  export function ManyToMany<T>(
    type: () => new () => T,
    inverse?: (entity: T) => unknown,
    options?: object
  ): PropertyDecorator;
  export function JoinColumn(options?: object): PropertyDecorator;
  export function JoinTable(options?: object): PropertyDecorator;
  export function Index(...args: unknown[]): ClassDecorator;
  export function Unique(...args: unknown[]): ClassDecorator;
}
`;

  /** Compiles source text in memory and returns the diagnostic messages. */
  function diagnose(files: Record<string, string>): string[] {
    const options: ts.CompilerOptions = {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      strict: true,
      experimentalDecorators: true,
      noEmit: true,
      skipLibCheck: true,
      types: [],
    };
    const host: ts.CompilerHost = ts.createCompilerHost(options);
    const defaultRead = host.readFile.bind(host);
    const defaultExists = host.fileExists.bind(host);
    const defaultSource = host.getSourceFile.bind(host);
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

  it(
    'compiles the emitted blog schema in both naming modes',
    async () => {
      for (const naming of ['preserve', 'normalize'] as const) {
        for (const from of ['django', 'prisma']) {
          const result = await convertCanonical(from, 'typeorm', { naming });
          const diagnostics: string[] = diagnose({
            'typeorm-stub.d.ts': TYPEORM_STUB,
            'entities.ts': result.output,
          });
          expect(diagnostics, `${from} ${naming}`).toEqual([]);
        }
      }
    },
    TYPE_CHECK_TIMEOUT_MS
  );

  it(
    'compiles an IR schema that uses every decorator',
    () => {
      const output: EmitOutput = emit(
        schemaOf([
          model('User'),
          model('Post', {
            fields: [idField(), field('title')],
            relations: [
              relation('author', 'User', { relatedName: 'posts' }),
              relation('tags', 'Tag', {
                kind: 'manyToMany',
                relatedName: 'posts',
              }),
            ],
            indexes: [{ fields: ['title'], isUnique: true }],
          }),
          model('Tag'),
        ])
      );
      expect(
        diagnose({
          'typeorm-stub.d.ts': TYPEORM_STUB,
          'entities.ts': output.text,
        })
      ).toEqual([]);
    },
    TYPE_CHECK_TIMEOUT_MS
  );

  it('reports errors in broken code (sanity check for the harness)', () => {
    expect(
      diagnose({
        'typeorm-stub.d.ts': TYPEORM_STUB,
        'entities.ts':
          "import { Entity } from 'typeorm';\nexport const x: number = Entity;",
      }).length
    ).toBeGreaterThan(0);
  });
});
