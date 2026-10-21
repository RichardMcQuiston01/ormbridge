import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { IrField, IrModel, IrRelation, IrSchema } from '../src/ir.js';
import { parseSequelize } from '../src/parsers/sequelize.js';
import { CANONICAL_FIXTURES } from './fixtures/canonical.js';
import { expectOk } from './helpers.js';
import { compareIr, formatDifference } from './irCompare.js';
import { summarizeSchema } from './schemaSummary.js';

/**
 * The Sequelize reader on Sequelize 7 (`@sequelize/core`) models. The Sequelize 7 canonical blog schema reads to
 * exactly the IR the Sequelize 6 canonical fixture gives; the cases below show what differs between the two
 * generations (decorators, `inverse`, the `onDelete` in the `foreignKey` option, the default actions).
 */

const FIXTURES: string = fileURLToPath(new URL('./fixtures/', import.meta.url));
const GOLDEN_PATH: string = fileURLToPath(
  new URL('./golden-extras/sequelize7/variants.txt', import.meta.url)
);

function read(paths: readonly string[]): { path: string; text: string }[] {
  return paths.map((path: string) => ({
    path,
    text: readFileSync(path, 'utf8'),
  }));
}

async function parse(files: Record<string, string>): Promise<IrSchema> {
  return expectOk(
    await parseSequelize(
      Object.entries(files).map(([path, text]) => ({ path, text })),
      { appLabel: 'app' }
    )
  );
}

function model(schema: IrSchema, name: string): IrModel {
  const found: IrModel | undefined = schema.models.find(
    (candidate: IrModel) => candidate.name === name
  );
  if (found === undefined) {
    throw new Error(
      `No model ${name}; have ${schema.models.map((item) => item.name).join(', ')}.`
    );
  }
  return found;
}

function relation(schema: IrSchema, owner: string, name: string): IrRelation {
  const found: IrRelation | undefined = model(schema, owner).relations.find(
    (candidate: IrRelation) => candidate.name === name
  );
  if (found === undefined) {
    throw new Error(`No relation ${owner}.${name}.`);
  }
  return found;
}

function field(schema: IrSchema, owner: string, name: string): IrField {
  const found: IrField | undefined = model(schema, owner).fields.find(
    (candidate: IrField) => candidate.name === name
  );
  if (found === undefined) {
    throw new Error(`No field ${owner}.${name}.`);
  }
  return found;
}

/** The header of a decorated Sequelize 7 file. */
const V7_HEADER: string = `
import { DataTypes, Model, sql } from '@sequelize/core';
import { Attribute, AutoIncrement, BelongsTo, BelongsToMany, ColumnName, Default,
  HasMany, HasOne, NotNull, PrimaryKey, Table, Unique } from '@sequelize/core/decorators-legacy';
`;

/** The same declarations as sequelize-typescript, which is Sequelize 6. */
const V6_HEADER: string = `
import { Table, Column, DataType, PrimaryKey, AutoIncrement, AllowNull, ForeignKey, BelongsTo, HasMany, Model } from 'sequelize-typescript';
`;

describe('sequelize 7 reader: the canonical blog schema', () => {
  it('reads to the IR of the Sequelize 6 canonical fixture', async () => {
    const v6Paths: readonly string[] =
      CANONICAL_FIXTURES.find((fixture) => fixture.format === 'sequelize')
        ?.paths ?? [];
    const v7Paths: string[] = [
      'category',
      'post',
      'profile',
      'tag',
      'user',
    ].map((name: string) => join(FIXTURES, `sequelize7/models/${name}.ts`));
    const v6: IrSchema = expectOk(
      await parseSequelize(read(v6Paths), { appLabel: 'app' })
    );
    const v7: IrSchema = expectOk(
      await parseSequelize(read(v7Paths), { appLabel: 'app' })
    );
    expect(compareIr(v6, v7).map(formatDifference)).toEqual([]);
    expect(v7.warnings).toEqual([]);
  });
});

describe('sequelize 7 reader: the variants fixture', () => {
  it('matches the golden summary', async () => {
    const schema: IrSchema = expectOk(
      await parseSequelize(
        read([join(FIXTURES, 'sequelize7-extras/variants.ts')]),
        { appLabel: 'app' }
      )
    );
    const actual: string = `${summarizeSchema(schema)}\n`;
    if (process.env.UPDATE_GOLDEN === '1') {
      mkdirSync(dirname(GOLDEN_PATH), { recursive: true });
      writeFileSync(GOLDEN_PATH, actual);
      return;
    }
    if (!existsSync(GOLDEN_PATH)) {
      throw new Error(
        'Golden file test/golden-extras/sequelize7/variants.txt does not exist. Run the tests with UPDATE_GOLDEN=1 to create it.'
      );
    }
    expect(actual).toBe(readFileSync(GOLDEN_PATH, 'utf8'));
  });
});

describe('sequelize 7 reader: attributes', () => {
  it('reads @Attribute as @Column, with a data type or an options object', async () => {
    const schema: IrSchema = await parse({
      'a.ts': `${V7_HEADER}
@Table({ tableName: 'things', timestamps: false })
export class Thing extends Model {
  @Attribute(DataTypes.INTEGER) @PrimaryKey @AutoIncrement declare id: number;
  @Attribute({ type: DataTypes.STRING(40), allowNull: false, unique: true }) declare code: string;
  @Attribute({ type: DataTypes.TEXT, columnName: 'long_note' }) declare note: string | null;
}`,
    });
    expect(field(schema, 'Thing', 'code')).toMatchObject({
      type: 'string',
      maxLength: 40,
      isNullable: false,
      isUnique: true,
    });
    expect(field(schema, 'Thing', 'note')).toMatchObject({
      type: 'text',
      columnName: 'long_note',
    });
  });

  it('names a column with @ColumnName and takes the defaults of @Default', async () => {
    const schema: IrSchema = await parse({
      'a.ts': `${V7_HEADER}
@Table({ tableName: 'things', timestamps: false })
export class Thing extends Model {
  @Attribute(DataTypes.INTEGER) @PrimaryKey @AutoIncrement declare id: number;
  @Attribute(DataTypes.INTEGER) @NotNull @Default(5) @ColumnName('view_count') declare viewCount: number;
  @Attribute(DataTypes.UUID) @Default(sql.uuidV4) declare a: string;
  @Attribute(DataTypes.UUID) @Default(sql.uuidV4.asJavaScript) declare b: string;
  @Attribute(DataTypes.UUID) @Default(DataTypes.UUIDV1) declare c: string;
  @Attribute(DataTypes.DATE) @Default(sql\`CURRENT_TIMESTAMP\`) declare d: Date;
  @Attribute(DataTypes.DATE) @Default(sql.fn('now')) declare e: Date;
  @Attribute(DataTypes.TEXT) @Default(sql.literal("'x'")) declare f: string;
}`,
    });
    expect(field(schema, 'Thing', 'viewCount')).toMatchObject({
      columnName: 'view_count',
      isNullable: false,
      default: { kind: 'literal', value: 5 },
    });
    expect(field(schema, 'Thing', 'a').default).toEqual({ kind: 'uuid' });
    expect(field(schema, 'Thing', 'b').default).toEqual({ kind: 'uuid' });
    expect(field(schema, 'Thing', 'c').default).toEqual({
      kind: 'uuid',
      version: 1,
    });
    expect(field(schema, 'Thing', 'd').default).toEqual({ kind: 'now' });
    expect(field(schema, 'Thing', 'e').default).toEqual({ kind: 'now' });
    expect(field(schema, 'Thing', 'f').default).toEqual({
      kind: 'literal',
      value: 'x',
    });
    expect(schema.warnings).toEqual([]);
  });

  it('adds an id unless the model says noPrimaryKey', async () => {
    const schema: IrSchema = await parse({
      'a.ts': `${V7_HEADER}
@Table({ tableName: 'with_id', timestamps: false })
export class WithId extends Model { @Attribute(DataTypes.TEXT) declare note: string | null; }
@Table({ tableName: 'without_id', timestamps: false, noPrimaryKey: true })
export class WithoutId extends Model { @Attribute(DataTypes.TEXT) declare note: string | null; }`,
    });
    expect(model(schema, 'WithId').fields.map((f) => f.name)).toEqual([
      'id',
      'note',
    ]);
    expect(model(schema, 'WithoutId').fields.map((f) => f.name)).toEqual([
      'note',
    ]);
  });
});

describe('sequelize 7 reader: associations', () => {
  const TWO_MODELS = (post: string, user: string): Record<string, string> => ({
    'user.ts': `${V7_HEADER}
@Table({ tableName: 'users', timestamps: false })
export class User extends Model {
  @Attribute(DataTypes.INTEGER) @PrimaryKey @AutoIncrement declare id: number;
${user}
}`,
    'post.ts': `${V7_HEADER}
@Table({ tableName: 'posts', timestamps: false })
export class Post extends Model {
  @Attribute(DataTypes.INTEGER) @PrimaryKey @AutoIncrement declare id: number;
${post}
}`,
  });

  it('gives a belongsTo the default action of Sequelize 7: SET NULL for a nullable key, CASCADE for a required one', async () => {
    const schema: IrSchema = await parse(
      TWO_MODELS(
        `  @Attribute(DataTypes.INTEGER) declare authorId: number | null;
  @BelongsTo(() => User, 'authorId') declare author: User;
  @Attribute(DataTypes.INTEGER) @NotNull declare editorId: number;
  @BelongsTo(() => User, 'editorId') declare editor: User;`,
        ''
      )
    );
    expect(relation(schema, 'Post', 'author').onDelete).toBe('setNull');
    expect(relation(schema, 'Post', 'editor').onDelete).toBe('cascade');
  });

  it('keeps the Sequelize 6 default (NO ACTION for a required key) in a file of the old generation', async () => {
    const schema: IrSchema = await parse({
      'a.ts': `${V6_HEADER}
@Table({ tableName: 'users', timestamps: false })
export class User extends Model {
  @PrimaryKey @AutoIncrement @Column(DataType.INTEGER) id!: number;
}
@Table({ tableName: 'posts', timestamps: false })
export class Post extends Model {
  @PrimaryKey @AutoIncrement @Column(DataType.INTEGER) id!: number;
  @ForeignKey(() => User) @AllowNull(false) @Column(DataType.INTEGER) editorId!: number;
  @BelongsTo(() => User) editor!: User;
}`,
    });
    expect(relation(schema, 'Post', 'editor').onDelete).toBe('noAction');
  });

  it('takes onDelete and onUpdate from the foreignKey option', async () => {
    const schema: IrSchema = await parse(
      TWO_MODELS(
        `  @Attribute(DataTypes.INTEGER) @NotNull declare authorId: number;
  @BelongsTo(() => User, { foreignKey: { name: 'authorId', onDelete: 'RESTRICT', onUpdate: 'SET NULL' } }) declare author: User;`,
        ''
      )
    );
    expect(relation(schema, 'Post', 'author')).toMatchObject({
      onDelete: 'restrict',
      onUpdate: 'setNull',
    });
  });

  it('defines the other side of a belongsTo from its inverse option', async () => {
    const schema: IrSchema = await parse(
      TWO_MODELS(
        `  @Attribute(DataTypes.INTEGER) @NotNull declare authorId: number;
  @BelongsTo(() => User, { foreignKey: 'authorId', inverse: { type: 'hasMany', as: 'posts' } }) declare author: User;
  @Attribute(DataTypes.INTEGER) @NotNull @Unique declare reviewerId: number;
  @BelongsTo(() => User, { foreignKey: 'reviewerId', inverse: { type: 'hasOne', as: 'review' } }) declare reviewer: User;`,
        ''
      )
    );
    expect(relation(schema, 'Post', 'author')).toMatchObject({
      kind: 'foreignKey',
      relatedName: 'posts',
    });
    expect(relation(schema, 'Post', 'reviewer')).toMatchObject({
      kind: 'oneToOne',
      relatedName: 'review',
    });
  });

  it('defines the belongsTo of a hasMany or hasOne from its inverse option', async () => {
    const schema: IrSchema = await parse(
      TWO_MODELS(
        `  @Attribute(DataTypes.INTEGER) @NotNull declare authorId: number;`,
        `  @HasMany(() => Post, { foreignKey: 'authorId', inverse: 'author' }) declare posts: Post[];`
      )
    );
    expect(relation(schema, 'Post', 'author')).toMatchObject({
      kind: 'foreignKey',
      relatedName: 'posts',
      onDelete: 'cascade',
    });
  });

  it('pairs a self reference declared from the hasMany side', async () => {
    const schema: IrSchema = await parse({
      'a.ts': `${V7_HEADER}
@Table({ tableName: 'categories', timestamps: false })
export class Category extends Model {
  @Attribute(DataTypes.INTEGER) @PrimaryKey @AutoIncrement declare id: number;
  @Attribute(DataTypes.INTEGER) declare parentId: number | null;
  @HasMany(() => Category, { foreignKey: { name: 'parentId', onDelete: 'SET NULL' }, inverse: { as: 'parent' } })
  declare children: Category[];
}`,
    });
    expect(relation(schema, 'Category', 'parent')).toMatchObject({
      relatedName: 'children',
      onDelete: 'setNull',
      targetModel: 'Category',
    });
  });

  it('pairs a many-to-many from its inverse option', async () => {
    const schema: IrSchema = await parse({
      ...TWO_MODELS(
        `  @BelongsToMany(() => User, { through: { model: 'posts_users', timestamps: false }, foreignKey: 'post_id', otherKey: 'user_id', inverse: 'likedPosts' })
  declare likers: User[];`,
        ''
      ),
    });
    expect(relation(schema, 'Post', 'likers')).toMatchObject({
      kind: 'manyToMany',
      targetModel: 'User',
      relatedName: 'likedPosts',
    });
    // The join table keeps its own name; other formats derive theirs from the two models.
    expect(schema.warnings).toEqual([
      'post.ts: model "Post": the join table "posts_users" (columns post_id, user_id) of Post.likers (@BelongsToMany) is not preserved by name; formats that derive join tables will use "posts_likers" (columns post_id, user_id).',
    ]);
  });

  it('reads foreignKeyConstraints: false as a column without a constraint', async () => {
    const schema: IrSchema = await parse(
      TWO_MODELS(
        `  @Attribute(DataTypes.INTEGER) declare authorId: number | null;
  @BelongsTo(() => User, { foreignKey: 'authorId', foreignKeyConstraints: false }) declare author: User;`,
        ''
      )
    );
    expect(model(schema, 'Post').relations).toEqual([]);
    expect(schema.warnings).toEqual([
      'post.ts: model "Post", field "authorId": the association uses constraints: false, so there is no foreign key in the database; the column is read as a plain column.',
    ]);
  });

  it('reads the association calls of a Model.init class with the onDelete in the foreignKey option', async () => {
    const schema: IrSchema = await parse({
      'a.ts': `
import { DataTypes, Model } from '@sequelize/core';
export class User extends Model {}
User.init({ id: { type: DataTypes.INTEGER, primaryKey: true } }, { sequelize, tableName: 'users', timestamps: false });
export class Post extends Model {}
Post.init({ id: { type: DataTypes.INTEGER, primaryKey: true }, authorId: { type: DataTypes.INTEGER, allowNull: false } }, { sequelize, tableName: 'posts', timestamps: false });
Post.belongsTo(User, { as: 'author', foreignKey: { name: 'authorId', onDelete: 'SET NULL' } });
User.hasMany(Post, { as: 'posts', foreignKey: 'authorId' });`,
    });
    expect(relation(schema, 'Post', 'author')).toMatchObject({
      onDelete: 'setNull',
      relatedName: 'posts',
    });
  });

  it('uses the generation of each file for its own associations', async () => {
    const schema: IrSchema = await parse({
      ...TWO_MODELS(
        `  @Attribute(DataTypes.INTEGER) @NotNull declare editorId: number;
  @BelongsTo(() => User, 'editorId') declare editor: User;`,
        ''
      ),
      'old.js': `
const { Sequelize, DataTypes } = require('sequelize');
const sequelize = new Sequelize('sqlite::memory:');
const Owner = sequelize.define('Owner', { name: DataTypes.STRING }, { tableName: 'owners', timestamps: false });
const Pet = sequelize.define('Pet', { ownerId: { type: DataTypes.INTEGER, allowNull: false } }, { tableName: 'pets', timestamps: false });
Pet.belongsTo(Owner, { as: 'owner', foreignKey: 'ownerId' });`,
    });
    expect(relation(schema, 'Post', 'editor').onDelete).toBe('cascade');
    expect(relation(schema, 'Pet', 'owner').onDelete).toBe('noAction');
  });
});

describe('sequelize 7 reader: warnings and edge cases', () => {
  it('reads @Version and the timestamp decorators as the columns Sequelize adds', async () => {
    const schema: IrSchema = await parse({
      'a.ts': `
import { DataTypes, Model } from '@sequelize/core';
import { Attribute, AutoIncrement, CreatedAt, PrimaryKey, Table, UpdatedAt, Version } from '@sequelize/core/decorators-legacy';
@Table({ tableName: 'things' })
export class Thing extends Model {
  @Attribute(DataTypes.INTEGER) @PrimaryKey @AutoIncrement declare id: number;
  @CreatedAt declare made: Date;
  @UpdatedAt declare changed: Date;
  @Version declare revision: number;
}`,
    });
    expect(model(schema, 'Thing').fields.map((f) => f.columnName)).toEqual([
      'id',
      'made',
      'changed',
      'revision',
    ]);
    expect(field(schema, 'Thing', 'changed').isAutoUpdated).toBe(true);
    expect(field(schema, 'Thing', 'revision')).toMatchObject({
      type: 'int',
      isNullable: false,
      default: { kind: 'literal', value: 0 },
    });
  });
});
