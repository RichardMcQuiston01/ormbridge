import { describe, expect, it } from 'vitest';
import { convertText } from '../src/convert.js';
import { getFormat, getFormatByExtension } from '../src/formats.js';
import type { IrField, IrModel, IrRelation, IrSchema } from '../src/ir.js';
import {
  parseTypeorm,
  type TypeormSourceFile,
} from '../src/parsers/typeorm.js';
import { runConversion } from '../src/io.js';
import { DEFAULT_OPTIONS, expectOk } from './helpers.js';
import { fileURLToPath } from 'node:url';

const IMPORTS: string = `import { Column, Entity, Index, JoinColumn, JoinTable, ManyToMany, ManyToOne, OneToMany, OneToOne, PrimaryColumn, PrimaryGeneratedColumn, CreateDateColumn, UpdateDateColumn, Unique } from 'typeorm';\n`;

async function parse(...texts: string[]): Promise<IrSchema> {
  const sources: TypeormSourceFile[] = texts.map(
    (text: string, index: number): TypeormSourceFile => ({
      path: `file${index}.ts`,
      text: index === 0 ? IMPORTS + text : text,
    })
  );
  return expectOk(await parseTypeorm(sources, { appLabel: 'app' }));
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

describe('typeorm adapter registration', () => {
  it('is registered as a read and write format that does not claim .ts', () => {
    const adapter = expectOk(getFormat('typeorm'));
    expect(adapter.parse).toBeDefined();
    expect(adapter.emit).toBeDefined();
    expect(getFormatByExtension('.ts')).toBeUndefined();
  });

  it('converts through convertText', async () => {
    const result = expectOk(
      await convertText(
        [
          {
            path: 'user.ts',
            text:
              IMPORTS +
              `@Entity() export class User { @PrimaryGeneratedColumn() id: number; @Column() name: string; }`,
          },
        ],
        { ...DEFAULT_OPTIONS, from: 'typeorm', to: 'prisma' }
      )
    );
    expect(result.modelCount).toBe(1);
    expect(result.output).toContain('model User {');
    expect(result.output).toContain('name String');
  });
});

describe('directory input', () => {
  it('reads every .ts file in a folder when --from typeorm is given', async () => {
    const directory: string = fileURLToPath(
      new URL('./fixtures/typeorm', import.meta.url)
    );
    const summary = expectOk(
      await runConversion({
        ...DEFAULT_OPTIONS,
        from: 'typeorm',
        to: 'prisma',
        inputs: [directory],
      })
    );
    expect(summary.modelCount).toBe(5);
    expect(summary.warnings).toEqual([]);
    expect(summary.inputFiles).toHaveLength(7);
  });
});

describe('entities and tables', () => {
  it('uses TypeORM default naming (snake_case) and explicit table names', async () => {
    const schema: IrSchema = await parse(`
      @Entity() export class BlogPost { @PrimaryGeneratedColumn() id: number; }
      @Entity('custom_tbl') export class Thing { @PrimaryGeneratedColumn() id: number; }
      @Entity({ name: 'opt_tbl', schema: 'public' }) export class Other { @PrimaryGeneratedColumn() id: number; }
    `);
    expect(model(schema, 'BlogPost').tableName).toBe('blog_post');
    expect(model(schema, 'Thing').tableName).toBe('custom_tbl');
    expect(model(schema, 'Other').tableName).toBe('opt_tbl');
    expect(warningsMatching(schema, 'Other: the schema "public"')).toHaveLength(
      1
    );
  });

  it('reads classes that are not exported, and aliased decorator imports', async () => {
    const schema: IrSchema = await parse(`
      import { Entity as E, PrimaryGeneratedColumn as Pk, Column as Col } from 'typeorm';
      @E('aliased') class Aliased { @Pk() id: number; @Col() label: string; }
    `);
    expect(model(schema, 'Aliased').tableName).toBe('aliased');
    expect(field(schema, 'Aliased', 'label').type).toBe('string');
  });

  it('returns NO_MODELS_FOUND when there is no entity', async () => {
    const result = await parseTypeorm(
      [{ path: 'x.ts', text: 'export class Plain { id: number }' }],
      { appLabel: 'app' }
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('NO_MODELS_FOUND');
    }
  });

  it('warns about EntitySchema definitions and syntax errors', async () => {
    const schema: IrSchema = await parse(
      `@Entity() export class A { @PrimaryGeneratedColumn() id: number; }`,
      `export const S = new EntitySchema({ name: 'S' });`,
      `export class Broken { @Column( }`
    );
    expect(warningsMatching(schema, 'EntitySchema')).toHaveLength(1);
    expect(warningsMatching(schema, 'syntax errors')).toHaveLength(1);
  });
});

describe('columns', () => {
  it('reads type, length, nullable, unique and defaults', async () => {
    const schema: IrSchema = await parse(`
      @Entity() export class Item {
        @PrimaryGeneratedColumn() id: number;
        @Column({ type: 'varchar', length: 40, nullable: true, unique: true, default: 'x' }) code: string | null;
        @Column('text') body: string;
        @Column({ type: 'decimal', precision: 10, scale: 2, default: 0 }) price: string;
        @Column({ name: 'is_on', default: true }) isOn: boolean;
        @Column() count: number;
        @Column() at: Date;
        @Column({ type: 'bigint' }) big: string;
        @Column({ type: 'jsonb', default: () => "'{}'" }) meta: object;
        @Column({ type: 'timestamp', default: () => 'CURRENT_TIMESTAMP' }) stamped: Date;
        @Column({ type: 'uuid', default: () => 'uuid_generate_v4()' }) token: string;
        @Column({ type: 'bytea' }) data: Buffer;
      }
    `);
    expect(field(schema, 'Item', 'code')).toMatchObject({
      type: 'string',
      maxLength: 40,
      isNullable: true,
      isUnique: true,
      default: { kind: 'literal', value: 'x' },
    });
    expect(field(schema, 'Item', 'body').type).toBe('text');
    expect(field(schema, 'Item', 'price')).toMatchObject({
      type: 'decimal',
      maxDigits: 10,
      decimalPlaces: 2,
      default: { kind: 'literal', value: 0 },
    });
    expect(field(schema, 'Item', 'isOn')).toMatchObject({
      columnName: 'is_on',
      type: 'boolean',
      default: { kind: 'literal', value: true },
    });
    expect(field(schema, 'Item', 'count').type).toBe('int');
    expect(field(schema, 'Item', 'at').type).toBe('dateTime');
    expect(field(schema, 'Item', 'big').type).toBe('bigInt');
    expect(field(schema, 'Item', 'meta')).toMatchObject({
      type: 'json',
      default: { kind: 'literal', value: '{}' },
    });
    expect(field(schema, 'Item', 'stamped').default).toEqual({ kind: 'now' });
    expect(field(schema, 'Item', 'token').default).toEqual({ kind: 'uuid' });
    expect(field(schema, 'Item', 'data').type).toBe('bytes');
    expect(schema.warnings).toEqual([]);
  });

  it('maps primary key decorators', async () => {
    const schema: IrSchema = await parse(`
      @Entity() export class A { @PrimaryGeneratedColumn() id: number; }
      @Entity() export class B { @PrimaryGeneratedColumn('uuid') id: string; }
      @Entity() export class C { @PrimaryGeneratedColumn({ type: 'bigint', name: 'c_id' }) id: string; }
      @Entity() export class D { @PrimaryColumn() code: string; }
    `);
    expect(field(schema, 'A', 'id')).toMatchObject({
      type: 'int',
      isPrimaryKey: true,
      default: { kind: 'autoIncrement' },
    });
    expect(field(schema, 'B', 'id')).toMatchObject({
      type: 'uuid',
      isPrimaryKey: true,
      default: { kind: 'uuid' },
    });
    expect(field(schema, 'C', 'id')).toMatchObject({
      type: 'bigInt',
      columnName: 'c_id',
    });
    expect(field(schema, 'D', 'code')).toMatchObject({
      type: 'string',
      isPrimaryKey: true,
      isNullable: false,
    });
  });

  it('builds a composite primary key from several @PrimaryColumn', async () => {
    const schema: IrSchema = await parse(`
      @Entity() export class Pair { @PrimaryColumn() a: number; @PrimaryColumn() b: number; }
    `);
    expect(model(schema, 'Pair').compositePrimaryKey).toEqual(['a', 'b']);
    expect(field(schema, 'Pair', 'a').isPrimaryKey).toBe(false);
  });

  it('maps date columns and warns about soft-delete and version columns', async () => {
    const schema: IrSchema = await parse(`
      import { DeleteDateColumn, VersionColumn } from 'typeorm';
      @Entity() export class Stamped {
        @PrimaryGeneratedColumn() id: number;
        @CreateDateColumn() createdAt: Date;
        @UpdateDateColumn() updatedAt: Date;
        @DeleteDateColumn() deletedAt: Date;
        @VersionColumn() version: number;
      }
    `);
    expect(field(schema, 'Stamped', 'createdAt')).toMatchObject({
      type: 'dateTime',
      default: { kind: 'now' },
      isAutoUpdated: false,
    });
    expect(field(schema, 'Stamped', 'updatedAt')).toMatchObject({
      type: 'dateTime',
      isAutoUpdated: true,
    });
    expect(field(schema, 'Stamped', 'deletedAt').isNullable).toBe(true);
    expect(warningsMatching(schema, 'Stamped.deletedAt')).toHaveLength(1);
    expect(warningsMatching(schema, 'Stamped.version')).toHaveLength(1);
  });

  it('applies @Generated to a plain column', async () => {
    const schema: IrSchema = await parse(`
      import { Generated } from 'typeorm';
      @Entity() export class G {
        @PrimaryGeneratedColumn() id: number;
        @Column() @Generated('uuid') ref: string;
      }
    `);
    expect(field(schema, 'G', 'ref')).toMatchObject({
      type: 'uuid',
      default: { kind: 'uuid' },
    });
  });

  it('warns for column types and options it cannot represent', async () => {
    const schema: IrSchema = await parse(`
      @Entity() export class W {
        @PrimaryGeneratedColumn() id: number;
        @Column({ type: 'geometry' }) shape: string;
        @Column({ type: 'int', array: true }) nums: number[];
        @Column({ type: 'int', unsigned: true }) small: number;
        @Column({ type: 'varchar', default: () => 'lower(name)' }) odd: string;
        @Column() mystery: Money;
        @Column() free: any;
      }
    `);
    expect(warningsMatching(schema, 'W.shape')[0]).toContain('"geometry"');
    expect(field(schema, 'W', 'nums').type).toBe('json');
    expect(warningsMatching(schema, 'W.nums')).toHaveLength(1);
    expect(warningsMatching(schema, 'W.small')[0]).toContain('unsigned');
    expect(warningsMatching(schema, 'W.odd')[0]).toContain('lower(name)');
    expect(warningsMatching(schema, 'W.mystery')).toHaveLength(1);
    expect(field(schema, 'W', 'free').type).toBe('json');
  });

  it('warns about unsupported property decorators', async () => {
    const schema: IrSchema = await parse(`
      import { ObjectIdColumn, VirtualColumn } from 'typeorm';
      @Entity() export class U {
        @PrimaryGeneratedColumn() id: number;
        @ObjectIdColumn() oid: string;
        @VirtualColumn({ query: () => 'x' }) computed: number;
      }
    `);
    expect(warningsMatching(schema, 'U.oid')).toHaveLength(1);
    expect(warningsMatching(schema, 'U.computed')).toHaveLength(1);
    expect(model(schema, 'U').fields.map((f: IrField) => f.name)).toEqual([
      'id',
    ]);
  });

  it('warns when an entity has no primary key', async () => {
    const schema: IrSchema = await parse(
      `@Entity() export class NoKey { @Column() a: string; }`
    );
    expect(
      warningsMatching(schema, 'NoKey: the entity has no primary key')
    ).toHaveLength(1);
  });
});

describe('enums', () => {
  const STATUS: string = `export enum Status { Draft = 'draft', Live = 'live' }
    export enum Level { Low, High }`;

  it('links a TypeScript enum, its default member, and an enum from another file', async () => {
    const schema: IrSchema = await parse(
      `
      import { Status } from './status';
      @Entity() export class P {
        @PrimaryGeneratedColumn() id: number;
        @Column({ type: 'enum', enum: Status, default: Status.Live }) status: Status;
        @Column({ type: 'simple-enum', enum: Object.values(Status), default: 'draft' }) other: Status;
      }`,
      STATUS
    );
    expect(schema.enums).toEqual([
      {
        name: 'Status',
        values: [
          { name: 'Draft', dbValue: 'draft' },
          { name: 'Live', dbValue: 'live' },
        ],
      },
    ]);
    expect(field(schema, 'P', 'status')).toMatchObject({
      enumName: 'Status',
      default: { kind: 'enumValue', value: 'Live' },
    });
    expect(field(schema, 'P', 'other')).toMatchObject({
      enumName: 'Status',
      default: { kind: 'enumValue', value: 'Draft' },
    });
  });

  it('creates an enum from an inline list of values', async () => {
    const schema: IrSchema = await parse(`
      @Entity() export class Q {
        @PrimaryGeneratedColumn() id: number;
        @Column({ type: 'enum', enum: ['in-progress', 'done'], default: 'done' }) state: 'in-progress' | 'done';
      }
    `);
    expect(schema.enums).toEqual([
      {
        name: 'QState',
        values: [
          { name: 'IN_PROGRESS', dbValue: 'in-progress' },
          { name: 'DONE', dbValue: 'done' },
        ],
      },
    ]);
    expect(field(schema, 'Q', 'state')).toMatchObject({
      enumName: 'QState',
      default: { kind: 'enumValue', value: 'DONE' },
    });
  });

  it('treats a const object of strings like an enum', async () => {
    const schema: IrSchema = await parse(`
      export const Role = { Admin: 'admin', User: 'user' } as const;
      @Entity() export class R {
        @PrimaryGeneratedColumn() id: number;
        @Column({ type: 'enum', enum: Role }) role: string;
      }
    `);
    expect(schema.enums[0]?.name).toBe('Role');
    expect(field(schema, 'R', 'role').enumName).toBe('Role');
  });

  it('warns for numeric enums and unknown enums', async () => {
    const schema: IrSchema = await parse(
      `
      import { Level } from './status';
      @Entity() export class N {
        @PrimaryGeneratedColumn() id: number;
        @Column({ type: 'enum', enum: Level }) level: Level;
        @Column({ type: 'enum', enum: Missing }) other: string;
        @Column({ type: 'enum' }) bare: string;
      }`,
      STATUS
    );
    expect(field(schema, 'N', 'level').type).toBe('int');
    expect(warningsMatching(schema, 'N.level')[0]).toContain('numeric');
    expect(warningsMatching(schema, 'N.other')[0]).toContain('"Missing"');
    expect(warningsMatching(schema, 'N.bare')).toHaveLength(1);
    expect(schema.enums).toEqual([]);
  });
});

describe('relations', () => {
  const BLOG: string = `
    @Entity() export class User {
      @PrimaryGeneratedColumn() id: number;
      @OneToMany(() => Post, (post) => post.author) posts: Post[];
      @OneToOne(() => Profile, (profile) => profile.user) profile: Profile;
    }
    @Entity() export class Profile {
      @PrimaryGeneratedColumn() id: number;
      @OneToOne(() => User, (user) => user.profile, { nullable: false, onDelete: 'CASCADE' })
      @JoinColumn() user: User;
    }
    @Entity() export class Tag {
      @PrimaryGeneratedColumn() id: number;
      @ManyToMany(() => Post, (post) => post.tags) posts: Post[];
    }
    @Entity() export class Post {
      @PrimaryGeneratedColumn() id: number;
      @ManyToOne(() => User, (user) => user.posts, { nullable: false, onDelete: 'CASCADE' }) author: User;
      @ManyToOne('User', { onDelete: 'SET NULL' }) @JoinColumn({ name: 'editor_ref', referencedColumnName: 'id' }) editor: User;
      @ManyToOne(() => User, { onDelete: 'RESTRICT', nullable: false }) reviewer: User;
      @ManyToOne(() => User) plain: User;
      @ManyToMany(() => Tag, (tag) => tag.posts) @JoinTable() tags: Tag[];
    }
  `;

  it('converts owning sides and uses TypeORM default join column names', async () => {
    const schema: IrSchema = await parse(BLOG);
    expect(relation(schema, 'Post', 'author')).toMatchObject({
      kind: 'foreignKey',
      targetModel: 'User',
      columnName: 'authorId',
      isNullable: false,
      onDelete: 'cascade',
      relatedName: 'posts',
    });
    expect(relation(schema, 'Post', 'editor')).toMatchObject({
      columnName: 'editor_ref',
      onDelete: 'setNull',
      isNullable: true,
      toField: 'id',
    });
    expect(relation(schema, 'Post', 'reviewer').onDelete).toBe('restrict');
    // No onDelete means NO ACTION in the database; relations are nullable by default.
    expect(relation(schema, 'Post', 'plain')).toMatchObject({
      onDelete: 'noAction',
      isNullable: true,
    });
    expect(relation(schema, 'Profile', 'user')).toMatchObject({
      kind: 'oneToOne',
      columnName: 'userId',
      relatedName: 'profile',
    });
    expect(relation(schema, 'Post', 'tags')).toMatchObject({
      kind: 'manyToMany',
      targetModel: 'Tag',
      relatedName: 'posts',
    });
  });

  it('does not create fields or relations for inverse sides', async () => {
    const schema: IrSchema = await parse(BLOG);
    expect(model(schema, 'User').relations).toEqual([]);
    expect(model(schema, 'Tag').relations).toEqual([]);
    expect(schema.warnings).toEqual([]);
  });

  it('takes the reverse accessor name from the inverse side when the owner has none', async () => {
    const schema: IrSchema = await parse(`
      @Entity() export class Author {
        @PrimaryGeneratedColumn() id: number;
        @OneToMany(() => Book, (book) => book.writer) books: Book[];
      }
      @Entity() export class Book {
        @PrimaryGeneratedColumn() id: number;
        @ManyToOne(() => Author) writer: Author;
      }
    `);
    expect(relation(schema, 'Book', 'writer').relatedName).toBe('books');
  });

  it('warns when the owning side of an inverse relation is missing', async () => {
    const schema: IrSchema = await parse(`
      @Entity() export class Author {
        @PrimaryGeneratedColumn() id: number;
        @OneToMany(() => Book, (book) => book.nobody) books: Book[];
        @OneToOne(() => Book, (book) => book.author) favourite: Book;
      }
      @Entity() export class Book {
        @PrimaryGeneratedColumn() id: number;
        @OneToOne(() => Author, (a) => a.favourite) author: Author;
      }
    `);
    expect(warningsMatching(schema, 'Author.books')[0]).toContain(
      '"Book.nobody" was not found'
    );
    expect(warningsMatching(schema, 'Author.favourite')[0]).toContain(
      'was not found'
    );
  });

  it('merges an explicit foreign key column with its relation and remaps indexes', async () => {
    const schema: IrSchema = await parse(`
      @Entity() export class User { @PrimaryGeneratedColumn() id: number; }
      @Entity()
      @Unique(['ownerId', 'title'])
      export class Note {
        @PrimaryGeneratedColumn() id: number;
        @Column({ name: 'owner_id' }) ownerId: number;
        @Column() title: string;
        @ManyToOne(() => User, { onDelete: 'CASCADE' }) @JoinColumn({ name: 'owner_id' }) owner: User;
      }
    `);
    const note: IrModel = model(schema, 'Note');
    expect(note.fields.map((f: IrField) => f.name)).toEqual(['id', 'title']);
    expect(relation(schema, 'Note', 'owner')).toMatchObject({
      columnName: 'owner_id',
      isNullable: false,
    });
    expect(note.indexes).toEqual([
      { fields: ['owner', 'title'], isUnique: true },
    ]);
  });

  it('warns about composite foreign keys, custom join tables and unresolved targets', async () => {
    const schema: IrSchema = await parse(`
      @Entity() export class A { @PrimaryGeneratedColumn() id: number; }
      @Entity() export class B {
        @PrimaryGeneratedColumn() id: number;
        @ManyToOne(() => A) @JoinColumn([{ name: 'a1' }, { name: 'a2' }]) comp: A;
        @ManyToMany(() => A) @JoinTable({ name: 'a_b_link' }) many: A[];
        @ManyToOne(target) dynamic: A;
        @ManyToOne(() => Ghost) ghost: Ghost;
      }
    `);
    expect(warningsMatching(schema, 'B.comp')[0]).toContain('composite');
    expect(warningsMatching(schema, 'B.many')[0]).toContain('name');
    expect(warningsMatching(schema, 'B.dynamic')).toHaveLength(1);
    expect(model(schema, 'Ghost').fields.map((f: IrField) => f.name)).toEqual([
      'id',
    ]);
    expect(warningsMatching(schema, 'B.ghost')[0]).toContain('stub');
  });

  it('supports self references', async () => {
    const schema: IrSchema = await parse(`
      @Entity() export class Node {
        @PrimaryGeneratedColumn() id: number;
        @ManyToOne(() => Node, (n) => n.children) parent: Node;
        @OneToMany(() => Node, (n) => n.parent) children: Node[];
      }
    `);
    expect(relation(schema, 'Node', 'parent')).toMatchObject({
      targetModel: 'Node',
      relatedName: 'children',
    });
  });

  it('derives the foreign key column from a non-id target key', async () => {
    const schema: IrSchema = await parse(`
      @Entity() export class Country { @PrimaryColumn({ name: 'iso' }) code: string; }
      @Entity() export class City {
        @PrimaryGeneratedColumn() id: number;
        @ManyToOne(() => Country) country: Country;
      }
    `);
    expect(relation(schema, 'City', 'country').columnName).toBe('countryIso');
  });
});

describe('indexes and constraints', () => {
  it('reads @Index and @Unique in their different forms', async () => {
    const schema: IrSchema = await parse(`
      @Entity()
      @Index(['a', 'b'])
      @Index('named_idx', ['b', 'c'], { unique: true })
      @Index('fn_idx', (e) => [e.a, e.c])
      @Unique('uq_ab', ['a', 'b'])
      @Unique(['c'])
      export class Idx {
        @PrimaryGeneratedColumn() id: number;
        @Column() a: string;
        @Column() b: string;
        @Column() c: string;
        @Index() @Column() d: string;
        @Index({ unique: true }) @Column() e: string;
      }
    `);
    const idx: IrModel = model(schema, 'Idx');
    expect(idx.indexes).toEqual([
      { fields: ['a', 'b'], isUnique: false },
      { fields: ['b', 'c'], isUnique: true, name: 'named_idx' },
      { fields: ['a', 'c'], isUnique: false, name: 'fn_idx' },
      { fields: ['a', 'b'], isUnique: true, name: 'uq_ab' },
      { fields: ['d'], isUnique: false },
    ]);
    // Single-column unique constraints become column uniqueness.
    expect(field(schema, 'Idx', 'c').isUnique).toBe(true);
    expect(field(schema, 'Idx', 'e').isUnique).toBe(true);
    expect(schema.warnings).toEqual([]);
  });

  it('warns about options, unknown columns and unsupported constraints', async () => {
    const schema: IrSchema = await parse(`
      import { Check } from 'typeorm';
      @Entity()
      @Index(['a'], { where: '"a" > 0' })
      @Index(['missing'])
      @Check('"a" > 0')
      export class Odd {
        @PrimaryGeneratedColumn() id: number;
        @Column() a: number;
      }
    `);
    expect(warningsMatching(schema, '"where"')).toHaveLength(1);
    expect(warningsMatching(schema, '"missing"')).toHaveLength(1);
    expect(warningsMatching(schema, '@Check')).toHaveLength(1);
    expect(model(schema, 'Odd').indexes).toEqual([
      { fields: ['a'], isUnique: false },
    ]);
  });
});

describe('embedded entities', () => {
  it('flattens columns using TypeORM prefix naming', async () => {
    const schema: IrSchema = await parse(`
      export class Address {
        @Column() street: string;
        @Column({ name: 'zip_code', nullable: true }) zip: string;
      }
      export class Geo { @Column({ type: 'float' }) lat: number; }
      @Entity() export class Shop {
        @PrimaryGeneratedColumn() id: number;
        @Column(() => Address) address: Address;
        @Column(() => Address, { prefix: 'billing' }) bill: Address;
        @Column(() => Geo, { prefix: false }) geo: Geo;
      }
    `);
    expect(model(schema, 'Shop').fields.map((f: IrField) => f.name)).toEqual([
      'id',
      'addressStreet',
      'addressZip',
      'billingStreet',
      'billingZip',
      'lat',
    ]);
    expect(field(schema, 'Shop', 'addressZip')).toMatchObject({
      columnName: 'addressZip_code',
      isNullable: true,
    });
    expect(model(schema, 'Shop').fields).toHaveLength(6);
  });

  it('warns for a missing embedded type and relations inside embedded types', async () => {
    const schema: IrSchema = await parse(`
      export class Holder { @ManyToOne(() => Shop) shop: Shop; @Column() v: string; }
      @Entity() export class Shop {
        @PrimaryGeneratedColumn() id: number;
        @Column(() => Missing) m: Missing;
        @Column(() => Holder) h: Holder;
      }
    `);
    expect(warningsMatching(schema, 'Shop.m')[0]).toContain('"Missing"');
    expect(warningsMatching(schema, 'Shop.h.shop')[0]).toContain('embedded');
    expect(model(schema, 'Shop').fields.map((f: IrField) => f.name)).toEqual([
      'id',
      'hV',
    ]);
  });
});

describe('inheritance', () => {
  it('inherits columns from abstract and concrete base classes', async () => {
    const schema: IrSchema = await parse(`
      export abstract class Base {
        @PrimaryGeneratedColumn() id: number;
        @CreateDateColumn() createdAt: Date;
      }
      export abstract class Named extends Base { @Column() name: string; }
      @Entity() export class Parent extends Named { @Column() extra: string; }
      @Entity() export class Child extends Parent { @Column({ nullable: true }) name: string; }
    `);
    expect(model(schema, 'Parent').fields.map((f: IrField) => f.name)).toEqual([
      'id',
      'createdAt',
      'name',
      'extra',
    ]);
    expect(schema.models.map((m: IrModel) => m.name)).toEqual([
      'Parent',
      'Child',
    ]);
    // The child's own declaration overrides the inherited one.
    expect(field(schema, 'Child', 'name').isNullable).toBe(true);
    expect(model(schema, 'Child').fields).toHaveLength(4);
  });

  it('warns for missing bases, single-table inheritance and complex base expressions', async () => {
    const schema: IrSchema = await parse(`
      import { TableInheritance, ChildEntity } from 'typeorm';
      @Entity() export class Orphan extends Elsewhere { @PrimaryGeneratedColumn() id: number; }
      @Entity() @TableInheritance({ column: 'type' }) export class Vehicle { @PrimaryGeneratedColumn() id: number; }
      @ChildEntity() export class Car extends Vehicle { @Column() doors: number; }
      @Entity() export class Mixed extends Mixin(Vehicle) { @PrimaryGeneratedColumn() id: number; }
    `);
    expect(
      warningsMatching(schema, 'Orphan: base class "Elsewhere"')
    ).toHaveLength(1);
    expect(warningsMatching(schema, 'Vehicle: @TableInheritance')).toHaveLength(
      1
    );
    expect(warningsMatching(schema, 'Car: @ChildEntity')).toHaveLength(1);
    expect(warningsMatching(schema, 'Mixin(Vehicle)')).toHaveLength(1);
    expect(schema.models.map((m: IrModel) => m.name)).not.toContain('Car');
  });

  it('does not treat BaseEntity as a missing base', async () => {
    const schema: IrSchema = await parse(`
      import { BaseEntity } from 'typeorm';
      @Entity() export class Active extends BaseEntity { @PrimaryGeneratedColumn() id: number; }
    `);
    expect(schema.warnings).toEqual([]);
  });
});
