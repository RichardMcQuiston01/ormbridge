import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
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
  parseLaravel,
  type LaravelSourceFile,
} from '../src/parsers/laravel.js';
import { loadCanonicalSources } from './harness.js';
import { DEFAULT_OPTIONS, expectOk } from './helpers.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** An anonymous-class migration whose up() holds `body`. */
function migration(body: string): string {
  return `<?php
use Illuminate\\Database\\Migrations\\Migration;
use Illuminate\\Database\\Schema\\Blueprint;
use Illuminate\\Support\\Facades\\DB;
use Illuminate\\Support\\Facades\\Schema;

return new class extends Migration
{
    public function up(): void
    {
${body}
    }

    public function down(): void
    {
        Schema::dropIfExists('should_be_ignored');
    }
};
`;
}

/** A model class in App\\Models; `body` is the class body. */
function modelClass(name: string, body: string, base = 'Model'): string {
  return `<?php
namespace App\\Models;

use App\\Enums\\Status;
use Illuminate\\Database\\Eloquent\\Model;
use Illuminate\\Database\\Eloquent\\SoftDeletes;
use Illuminate\\Foundation\\Auth\\User as Authenticatable;

class ${name} extends ${base}
{
${body}
}
`;
}

/** Files are given as { 'name.php': text }; paths do not matter beyond the migration order. */
async function parse(files: Record<string, string>): Promise<IrSchema> {
  const sources: LaravelSourceFile[] = Object.entries(files).map(
    ([path, text]: [string, string]): LaravelSourceFile => ({ path, text })
  );
  return expectOk(await parseLaravel(sources, { appLabel: 'app' }));
}

/** Parses migrations only, named 2024_01_01_00000N_x.php in the order given. */
async function parseMigrations(...bodies: string[]): Promise<IrSchema> {
  const files: Record<string, string> = {};
  bodies.forEach((body: string, index: number) => {
    files[`2024_01_01_00000${index}_step.php`] = migration(body);
  });
  return parse(files);
}

function model(schema: IrSchema, name: string): IrModel {
  const found: IrModel | undefined = schema.models.find(
    (candidate: IrModel) => candidate.name === name
  );
  if (found === undefined) {
    throw new Error(
      `Model ${name} was not parsed (found: ${schema.models.map((m: IrModel) => m.name).join(', ')})`
    );
  }
  return found;
}

function field(schema: IrSchema, modelName: string, name: string): IrField {
  const found: IrField | undefined = model(schema, modelName).fields.find(
    (candidate: IrField) => candidate.name === name
  );
  if (found === undefined) {
    throw new Error(
      `Field ${modelName}.${name} was not parsed (found: ${model(
        schema,
        modelName
      )
        .fields.map((f: IrField) => f.name)
        .join(', ')})`
    );
  }
  return found;
}

function fieldNames(schema: IrSchema, modelName: string): string[] {
  return model(schema, modelName).fields.map((f: IrField) => f.name);
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

/** The table Eloquent derives for a class name, for the few test classes that need it. */
function conventionalTable(className: string): string {
  const tables: Record<string, string> = {
    Post: 'posts',
    Tag: 'tags',
    UserProfile: 'user_profiles',
    BlogPost: 'blog_posts',
    APIKey: 'a_p_i_keys',
    Zebra: 'zebras',
  };
  return tables[className] ?? className;
}

/** A users table plus one more, to give foreign keys something to point at. */
const USERS: string = `
        Schema::create('users', function (Blueprint $table) {
            $table->id();
        });`;

// ---------------------------------------------------------------------------
// Registry and canonical fixture
// ---------------------------------------------------------------------------

describe('laravel adapter', () => {
  it('is registered without claiming the .php extension', () => {
    const adapter = expectOk(getFormat('laravel'));
    expect(adapter.parse).toBeDefined();
    expect(adapter.extensions).toEqual([]);
    expect(getFormatByExtension('.php')).toBeUndefined();
  });
});

describe('canonical project', () => {
  it('rebuilds the blog schema from the migrations in order', async () => {
    const sources = loadCanonicalSources('laravel');
    const schema: IrSchema = expectOk(
      await parseLaravel(sources, { appLabel: 'blog' })
    );
    expect(schema.warnings).toEqual([]);
    expect(schema.models.map((m: IrModel) => m.name).sort()).toEqual([
      'Category',
      'Post',
      'Profile',
      'Tag',
      'User',
    ]);
    // Tables created and dropped again (blog_comment) and pivot tables leave no model behind.
    expect(schema.models.map((m: IrModel) => m.tableName).sort()).toEqual([
      'auth_user',
      'blog_category',
      'blog_post',
      'blog_profile',
      'blog_tag',
    ]);
    // add column (parent_id), rename (name -> label), change (slug 100 -> 50), drop column (excerpt).
    expect(fieldNames(schema, 'Tag')).toEqual(['id', 'label']);
    expect(field(schema, 'Category', 'slug').maxLength).toBe(50);
    expect(fieldNames(schema, 'Post')).not.toContain('excerpt');
    expect(relation(schema, 'Category', 'parent')).toMatchObject({
      targetModel: 'Category',
      columnName: 'parent_id',
      isNullable: true,
      onDelete: 'setNull',
      relatedName: 'children',
    });
    // The slug index was added and dropped again; the later indexes and foreign key survive.
    expect(model(schema, 'Category').indexes).toEqual([]);
    expect(model(schema, 'Post').indexes).toEqual([
      { fields: ['author', 'title'], isUnique: true },
      { fields: ['title'], isUnique: false },
      {
        fields: ['published_at', 'status'],
        isUnique: false,
        name: 'post_pub_status_idx',
      },
    ]);
    expect(relation(schema, 'Post', 'category')).toMatchObject({
      onDelete: 'restrict',
      relatedName: 'posts',
    });
    // The pivot table is folded into a many-to-many field.
    expect(relation(schema, 'Post', 'tags')).toMatchObject({
      kind: 'manyToMany',
      targetModel: 'Tag',
      relatedName: 'posts',
    });
    expect(relation(schema, 'Profile', 'user').kind).toBe('oneToOne');
    expect(field(schema, 'Post', 'status')).toMatchObject({
      type: 'string',
      enumName: 'PostStatus',
      default: { kind: 'enumValue', value: 'Draft' },
    });
    expect(schema.enums).toEqual<IrEnum[]>([
      {
        name: 'PostStatus',
        values: [
          { name: 'Draft', dbValue: 'draft' },
          { name: 'Published', dbValue: 'published' },
        ],
      },
    ]);
    expect(field(schema, 'Post', 'public_id')).toMatchObject({
      type: 'uuid',
      isUnique: true,
      default: { kind: 'uuid' },
    });
    expect(field(schema, 'Post', 'updated_at').isAutoUpdated).toBe(true);
  });

  it('does not depend on the order of the files or on their folders', async () => {
    const sources = loadCanonicalSources('laravel');
    const forward: IrSchema = expectOk(
      await parseLaravel(sources, { appLabel: 'blog' })
    );
    const flat: LaravelSourceFile[] = [...sources].reverse().map((source) => ({
      path: source.path.split('/').pop() ?? source.path,
      text: source.text,
    }));
    const shuffled: IrSchema = expectOk(
      await parseLaravel(flat, { appLabel: 'blog' })
    );
    expect(shuffled).toEqual(forward);
  });
});

// ---------------------------------------------------------------------------
// Replay semantics
// ---------------------------------------------------------------------------

describe('migration replay', () => {
  it('orders migrations by file name, whatever order they are passed in', async () => {
    const schema: IrSchema = await parse({
      '2024_03_01_000000_rename.php': migration(`
        Schema::table('posts', function (Blueprint $table) {
            $table->renameColumn('title', 'headline');
        });`),
      '2024_01_01_000000_create.php': migration(`
        Schema::create('posts', function (Blueprint $table) {
            $table->id();
            $table->string('title');
        });`),
      '2024_02_01_000000_add.php': migration(`
        Schema::table('posts', function (Blueprint $table) {
            $table->text('body')->nullable();
        });`),
    });
    expect(fieldNames(schema, 'Post')).toEqual(['id', 'headline', 'body']);
    expect(schema.warnings).toEqual([]);
  });

  it('ignores down() and reads named migration classes', async () => {
    const schema: IrSchema = await parse({
      '2024_01_01_000000_create_posts_table.php': `<?php
use Illuminate\\Database\\Migrations\\Migration;
use Illuminate\\Database\\Schema\\Blueprint;
use Illuminate\\Support\\Facades\\Schema;

class CreatePostsTable extends Migration
{
    public function up()
    {
        Schema::create('posts', function (Blueprint $table) {
            $table->bigIncrements('id');
        });
    }

    public function down()
    {
        Schema::drop('posts');
    }
}
`,
    });
    expect(model(schema, 'Post').tableName).toBe('posts');
  });

  it('adds, renames, drops and changes columns', async () => {
    const schema: IrSchema = await parseMigrations(
      `
        Schema::create('posts', function (Blueprint $table) {
            $table->id();
            $table->string('title', 100)->nullable();
            $table->string('slug');
            $table->integer('views')->default(5);
            $table->text('summary');
        });`,
      `
        Schema::table('posts', function (Blueprint $table) {
            $table->boolean('is_live')->default(true);
            $table->renameColumn('slug', 'permalink');
            $table->dropColumn('summary');
            $table->string('title', 200)->change();
            $table->bigInteger('views')->change();
        });`
    );
    expect(fieldNames(schema, 'Post')).toEqual([
      'id',
      'title',
      'permalink',
      'views',
      'is_live',
    ]);
    // change() restates the column: modifiers that are not repeated are reset.
    expect(field(schema, 'Post', 'title')).toMatchObject({
      maxLength: 200,
      isNullable: false,
    });
    expect(field(schema, 'Post', 'views')).toMatchObject({ type: 'bigInt' });
    expect(field(schema, 'Post', 'views').default).toBeUndefined();
    expect(field(schema, 'Post', 'is_live').default).toEqual({
      kind: 'literal',
      value: true,
    });
  });

  it('drops several columns given as arguments or as an array, and Schema::dropColumns', async () => {
    const schema: IrSchema = await parseMigrations(
      `
        Schema::create('posts', function (Blueprint $table) {
            $table->id();
            $table->string('a');
            $table->string('b');
            $table->string('c');
            $table->string('d');
        });`,
      `
        Schema::table('posts', function (Blueprint $table) {
            $table->dropColumn('a', 'b');
            $table->dropColumn(['c']);
        });
        Schema::dropColumns('posts', ['d']);`
    );
    expect(fieldNames(schema, 'Post')).toEqual(['id']);
  });

  it('drops and recreates tables, and renames them', async () => {
    const schema: IrSchema = await parseMigrations(
      `
        Schema::create('drafts', function (Blueprint $table) {
            $table->id();
            $table->string('old');
        });
        Schema::create('notes', function (Blueprint $table) {
            $table->id();
        });`,
      `
        Schema::dropIfExists('drafts');
        Schema::drop('missing_table');
        Schema::create('drafts', function (Blueprint $table) {
            $table->id();
            $table->string('fresh');
        });
        Schema::rename('notes', 'memos');`
    );
    expect(schema.models.map((m: IrModel) => m.tableName).sort()).toEqual([
      'drafts',
      'memos',
    ]);
    expect(fieldNames(schema, 'Draft')).toEqual(['id', 'fresh']);
  });

  it('points foreign keys at a renamed table', async () => {
    const schema: IrSchema = await parseMigrations(
      `
        Schema::create('writers', function (Blueprint $table) {
            $table->id();
        });
        Schema::create('posts', function (Blueprint $table) {
            $table->id();
            $table->foreignId('writer_id')->constrained('writers');
        });`,
      `Schema::rename('writers', 'authors');`
    );
    expect(relation(schema, 'Post', 'writer').targetModel).toBe('Author');
  });

  it('replays index and foreign key changes by name or by columns', async () => {
    const schema: IrSchema = await parseMigrations(
      `
        Schema::create('authors', function (Blueprint $table) {
            $table->id();
        });
        Schema::create('posts', function (Blueprint $table) {
            $table->id();
            $table->string('slug');
            $table->string('title');
            $table->string('code');
            $table->unsignedBigInteger('author_id');
            $table->unsignedBigInteger('editor_id')->nullable();
            $table->unique('slug');
            $table->index(['title', 'code']);
            $table->index('code', 'custom_code_index');
            $table->foreign('author_id')->references('id')->on('authors');
            $table->foreign('editor_id', 'posts_editor_fk')->references('id')->on('authors');
        });`,
      `
        Schema::table('posts', function (Blueprint $table) {
            $table->dropUnique(['slug']);
            $table->dropIndex(['title', 'code']);
            $table->dropIndex('custom_code_index');
            $table->dropForeign(['author_id']);
            $table->dropForeign('posts_editor_fk');
        });`
    );
    const post: IrModel = model(schema, 'Post');
    expect(post.indexes).toEqual([]);
    expect(field(schema, 'Post', 'slug').isUnique).toBe(false);
    expect(post.relations).toEqual([]);
    expect(fieldNames(schema, 'Post')).toContain('author_id');
    expect(schema.warnings).toEqual([]);
  });

  it('keeps an index when only one of its columns is dropped', async () => {
    const schema: IrSchema = await parseMigrations(
      `
        Schema::create('posts', function (Blueprint $table) {
            $table->id();
            $table->string('a');
            $table->string('b');
            $table->index(['a', 'b']);
        });`,
      `
        Schema::table('posts', function (Blueprint $table) {
            $table->dropColumn('a');
        });`
    );
    expect(model(schema, 'Post').indexes).toEqual([
      { fields: ['b'], isUnique: false },
    ]);
  });

  it('renames columns inside indexes and foreign keys', async () => {
    const schema: IrSchema = await parseMigrations(
      `
        Schema::create('users', function (Blueprint $table) {
            $table->id();
        });
        Schema::create('posts', function (Blueprint $table) {
            $table->id();
            $table->string('slug');
            $table->unsignedBigInteger('owner_id');
            $table->unique(['slug', 'owner_id']);
            $table->foreign('owner_id')->references('id')->on('users')->cascadeOnDelete();
        });`,
      `
        Schema::table('posts', function (Blueprint $table) {
            $table->renameColumn('owner_id', 'author_id');
            $table->renameColumn('slug', 'permalink');
        });`
    );
    expect(relation(schema, 'Post', 'author')).toMatchObject({
      columnName: 'author_id',
      onDelete: 'cascade',
    });
    expect(model(schema, 'Post').indexes).toEqual([
      { fields: ['permalink', 'author'], isUnique: true },
    ]);
  });

  it('drops the primary key and replaces it', async () => {
    const schema: IrSchema = await parseMigrations(
      `
        Schema::create('pairs', function (Blueprint $table) {
            $table->unsignedInteger('a');
            $table->unsignedInteger('b');
            $table->unsignedInteger('c');
            $table->primary(['a', 'b']);
        });`,
      `
        Schema::table('pairs', function (Blueprint $table) {
            $table->dropPrimary();
            $table->primary('c');
        });`
    );
    expect(field(schema, 'Pair', 'c').isPrimaryKey).toBe(true);
    expect(model(schema, 'Pair').compositePrimaryKey).toBeUndefined();
  });

  it('turns a composite primary key into compositePrimaryKey', async () => {
    const schema: IrSchema = await parseMigrations(`
        Schema::create('pairs', function (Blueprint $table) {
            $table->unsignedInteger('a');
            $table->unsignedInteger('b');
            $table->primary(['a', 'b']);
        });`);
    expect(model(schema, 'Pair').compositePrimaryKey).toEqual(['a', 'b']);
    expect(field(schema, 'Pair', 'a').isPrimaryKey).toBe(false);
  });

  it('skips a table that is only altered and never created', async () => {
    const schema: IrSchema = await parseMigrations(
      `
        Schema::table('users', function (Blueprint $table) {
            $table->string('nickname')->nullable();
        });`,
      `
        Schema::create('notes', function (Blueprint $table) {
            $table->id();
        });`
    );
    expect(schema.models.map((m: IrModel) => m.tableName)).toEqual(['notes']);
    expect(
      warningsMatching(schema, 'users: the table is altered')
    ).toHaveLength(1);
  });

  it('warns when a migration changes something that is not there', async () => {
    const schema: IrSchema = await parseMigrations(`
        Schema::create('posts', function (Blueprint $table) {
            $table->id();
            $table->string('a');
            $table->string('a');
        });
        Schema::table('posts', function (Blueprint $table) {
            $table->renameColumn('ghost', 'spirit');
            $table->string('ghost2', 10)->change();
            $table->dropIndex('nope');
            $table->dropForeign(['a']);
        });`);
    expect(
      warningsMatching(schema, 'posts.a: the column is defined more than once')
    ).toHaveLength(1);
    expect(
      warningsMatching(schema, 'posts.ghost: renameColumn()')
    ).toHaveLength(1);
    expect(warningsMatching(schema, 'posts.ghost2: change()')).toHaveLength(1);
    expect(
      warningsMatching(schema, 'could not find the index "nope"')
    ).toHaveLength(1);
    expect(
      warningsMatching(schema, 'dropForeign() could not find')
    ).toHaveLength(1);
  });

  it('warns about a table created twice', async () => {
    const schema: IrSchema = await parseMigrations(
      `Schema::create('notes', function (Blueprint $table) { $table->id(); });`,
      `Schema::create('notes', function (Blueprint $table) { $table->id(); $table->string('x'); });`
    );
    expect(
      warningsMatching(
        schema,
        'notes: Schema::create() ran for a table that already exists'
      )
    ).toHaveLength(1);
    expect(fieldNames(schema, 'Note')).toEqual(['id', 'x']);
  });

  it('reads arrow-function callbacks and Schema::connection()', async () => {
    const schema: IrSchema = await parseMigrations(`
        Schema::connection('tenant')->create('notes', fn (Blueprint $table) => $table->id());
        Schema::table('notes', fn (Blueprint $t) => $t->string('title'));`);
    expect(fieldNames(schema, 'Note')).toEqual(['id', 'title']);
  });
});

// ---------------------------------------------------------------------------
// Column types, modifiers and expansions
// ---------------------------------------------------------------------------

describe('column types', () => {
  it('maps the column methods to IR types', async () => {
    const schema: IrSchema = await parseMigrations(`
        Schema::create('kitchen', function (Blueprint $table) {
            $table->id();
            $table->string('s');
            $table->string('s50', 50);
            $table->char('c', 4);
            $table->text('t');
            $table->mediumText('mt');
            $table->longText('lt');
            $table->integer('i');
            $table->tinyInteger('ti');
            $table->smallInteger('si');
            $table->mediumInteger('mi');
            $table->bigInteger('bi');
            $table->unsignedInteger('ui');
            $table->unsignedBigInteger('ubi');
            $table->boolean('b');
            $table->decimal('d', 10, 3);
            $table->decimal('d_default');
            $table->float('f');
            $table->double('db');
            $table->date('da');
            $table->dateTime('dt');
            $table->dateTimeTz('dtz');
            $table->time('tm');
            $table->timestamp('ts');
            $table->timestampTz('tstz');
            $table->year('yr');
            $table->json('j');
            $table->jsonb('jb');
            $table->binary('bin');
            $table->ipAddress('ip');
            $table->ipAddress();
            $table->uuid('u');
            $table->ulid('ul');
        });`);
    const types: Record<string, string> = {};
    for (const f of model(schema, 'Kitchen').fields) {
      types[f.name] = f.type;
    }
    expect(types).toEqual({
      id: 'bigInt',
      s: 'string',
      s50: 'string',
      c: 'string',
      t: 'text',
      mt: 'text',
      lt: 'text',
      i: 'int',
      ti: 'int',
      si: 'int',
      mi: 'int',
      bi: 'bigInt',
      ui: 'int',
      ubi: 'bigInt',
      b: 'boolean',
      d: 'decimal',
      d_default: 'decimal',
      f: 'float',
      db: 'float',
      da: 'date',
      dt: 'dateTime',
      dtz: 'dateTime',
      tm: 'time',
      ts: 'dateTime',
      tstz: 'dateTime',
      yr: 'int',
      j: 'json',
      jb: 'json',
      bin: 'bytes',
      ip: 'ipAddress',
      ip_address: 'ipAddress',
      u: 'uuid',
      ul: 'string',
    });
    expect(field(schema, 'Kitchen', 's').maxLength).toBe(255);
    expect(field(schema, 'Kitchen', 's50').maxLength).toBe(50);
    expect(field(schema, 'Kitchen', 'c').maxLength).toBe(4);
    expect(field(schema, 'Kitchen', 'ul').maxLength).toBe(26);
    expect(field(schema, 'Kitchen', 'd')).toMatchObject({
      maxDigits: 10,
      decimalPlaces: 3,
    });
    expect(field(schema, 'Kitchen', 'd_default')).toMatchObject({
      maxDigits: 8,
      decimalPlaces: 2,
    });
  });

  it('treats the increments family as auto-increment primary keys', async () => {
    const schema: IrSchema = await parseMigrations(`
        Schema::create('a', function (Blueprint $table) { $table->increments('id'); });
        Schema::create('b', function (Blueprint $table) { $table->bigIncrements('id'); });
        Schema::create('c', function (Blueprint $table) { $table->smallIncrements('id'); });
        Schema::create('d', function (Blueprint $table) { $table->integer('id', true); });
        Schema::create('e', function (Blueprint $table) { $table->unsignedBigInteger('id')->autoIncrement()->primary(); });
        Schema::create('f', function (Blueprint $table) { $table->uuid('id')->primary(); });`);
    for (const [name, type] of [
      ['A', 'int'],
      ['B', 'bigInt'],
      ['C', 'int'],
      ['D', 'int'],
      ['E', 'bigInt'],
    ] as const) {
      expect(field(schema, name, 'id')).toMatchObject({
        type,
        isPrimaryKey: true,
        isNullable: false,
        default: { kind: 'autoIncrement' },
      });
    }
    expect(field(schema, 'F', 'id')).toMatchObject({
      type: 'uuid',
      isPrimaryKey: true,
    });
    expect(field(schema, 'F', 'id').default).toBeUndefined();
  });

  it('expands timestamps, softDeletes and rememberToken', async () => {
    const schema: IrSchema = await parseMigrations(`
        Schema::create('posts', function (Blueprint $table) {
            $table->id();
            $table->rememberToken();
            $table->softDeletes();
            $table->timestamps();
        });
        Schema::create('others', function (Blueprint $table) {
            $table->id();
            $table->softDeletesTz('removed_at');
            $table->timestampsTz();
        });`);
    expect(fieldNames(schema, 'Post')).toEqual([
      'id',
      'remember_token',
      'deleted_at',
      'created_at',
      'updated_at',
    ]);
    expect(field(schema, 'Post', 'remember_token')).toMatchObject({
      type: 'string',
      maxLength: 100,
      isNullable: true,
    });
    for (const name of ['deleted_at', 'created_at', 'updated_at']) {
      expect(field(schema, 'Post', name)).toMatchObject({
        type: 'dateTime',
        isNullable: true,
      });
    }
    expect(fieldNames(schema, 'Other')).toEqual([
      'id',
      'removed_at',
      'created_at',
      'updated_at',
    ]);
  });

  it('drops what timestamps, softDeletes, rememberToken and morphs added', async () => {
    const schema: IrSchema = await parseMigrations(
      `
        Schema::create('posts', function (Blueprint $table) {
            $table->id();
            $table->rememberToken();
            $table->softDeletes();
            $table->timestamps();
            $table->morphs('taggable');
            $table->string('keep');
        });`,
      `
        Schema::table('posts', function (Blueprint $table) {
            $table->dropRememberToken();
            $table->dropSoftDeletes();
            $table->dropTimestamps();
            $table->dropMorphs('taggable');
        });`
    );
    expect(fieldNames(schema, 'Post')).toEqual(['id', 'keep']);
    expect(model(schema, 'Post').indexes).toEqual([]);
  });

  it('keeps morph columns as plain columns and warns', async () => {
    const schema: IrSchema = await parseMigrations(`
        Schema::create('comments', function (Blueprint $table) {
            $table->id();
            $table->morphs('commentable');
            $table->nullableMorphs('author');
            $table->uuidMorphs('owner');
            $table->nullableUlidMorphs('ulid_owner');
        });`);
    expect(field(schema, 'Comment', 'commentable_type')).toMatchObject({
      type: 'string',
      maxLength: 255,
      isNullable: false,
    });
    expect(field(schema, 'Comment', 'commentable_id')).toMatchObject({
      type: 'bigInt',
      isNullable: false,
    });
    expect(field(schema, 'Comment', 'author_id').isNullable).toBe(true);
    expect(field(schema, 'Comment', 'owner_id').type).toBe('uuid');
    expect(field(schema, 'Comment', 'ulid_owner_id')).toMatchObject({
      type: 'string',
      maxLength: 26,
      isNullable: true,
    });
    expect(model(schema, 'Comment').indexes[0]).toEqual({
      fields: ['commentable_type', 'commentable_id'],
      isUnique: false,
    });
    expect(
      warningsMatching(
        schema,
        "morphs('commentable') creates the columns commentable_type and commentable_id"
      )
    ).toHaveLength(1);
    expect(warningsMatching(schema, "nullableMorphs('author')")).toHaveLength(
      1
    );
  });

  it('keeps enum() values and warns about set(), geometry and macAddress', async () => {
    const schema: IrSchema = await parseMigrations(`
        Schema::create('things', function (Blueprint $table) {
            $table->id();
            $table->enum('level', ['low', 'in-progress', '2fast']);
            $table->set('flags', ['a', 'b']);
            $table->point('location');
            $table->geometry('shape');
            $table->macAddress('mac');
        });`);
    expect(field(schema, 'Thing', 'level')).toMatchObject({
      type: 'string',
      enumName: 'ThingLevel',
    });
    expect(schema.enums).toEqual<IrEnum[]>([
      {
        name: 'ThingLevel',
        values: [
          { name: 'Low', dbValue: 'low' },
          { name: 'InProgress', dbValue: 'in-progress' },
          { name: 'Value3', dbValue: '2fast' },
        ],
      },
    ]);
    expect(field(schema, 'Thing', 'flags')).toMatchObject({
      type: 'unsupported',
      unsupportedType: "set('a','b')",
    });
    expect(field(schema, 'Thing', 'location')).toMatchObject({
      type: 'unsupported',
      unsupportedType: 'point',
    });
    expect(field(schema, 'Thing', 'shape').type).toBe('unsupported');
    expect(field(schema, 'Thing', 'mac')).toMatchObject({
      type: 'string',
      maxLength: 17,
    });
    expect(
      warningsMatching(schema, 'things.flags: set() columns')
    ).toHaveLength(1);
    expect(
      warningsMatching(schema, 'things.location: the point() column type')
    ).toHaveLength(1);
    expect(warningsMatching(schema, 'things.mac: macAddress()')).toHaveLength(
      1
    );
  });
});

describe('column modifiers', () => {
  it('reads nullable, default, unique, index and primary', async () => {
    const schema: IrSchema = await parseMigrations(`
        Schema::create('posts', function (Blueprint $table) {
            $table->id();
            $table->string('a')->nullable();
            $table->string('b')->nullable(false);
            $table->string('c')->default('x');
            $table->integer('d')->default(7);
            $table->integer('e')->nullable()->default(null);
            $table->string('f')->unique();
            $table->string('g')->unique('g_custom_name');
            $table->string('h')->index();
            $table->string('i')->index('i_named');
            $table->text('j')->fullText();
            $table->string('k')->comment('ignored')->after('a')->charset('utf8mb4')->collation('x')->unsigned();
            $table->string('l');
            $table->string('m');
            $table->unique(['l', 'm'], 'l_m_unique_name');
            $table->index(['m', 'l']);
            $table->fullText(['j', 'k']);
        });`);
    expect(field(schema, 'Post', 'a').isNullable).toBe(true);
    expect(field(schema, 'Post', 'b').isNullable).toBe(false);
    expect(field(schema, 'Post', 'c').default).toEqual({
      kind: 'literal',
      value: 'x',
    });
    expect(field(schema, 'Post', 'd').default).toEqual({
      kind: 'literal',
      value: 7,
    });
    expect(field(schema, 'Post', 'e')).toMatchObject({ isNullable: true });
    expect(field(schema, 'Post', 'e').default).toBeUndefined();
    expect(field(schema, 'Post', 'f').isUnique).toBe(true);
    // A unique constraint with a non-conventional name keeps the name.
    expect(field(schema, 'Post', 'g').isUnique).toBe(false);
    expect(model(schema, 'Post').indexes).toEqual<IrIndex[]>([
      { fields: ['g'], isUnique: true, name: 'g_custom_name' },
      { fields: ['h'], isUnique: false },
      { fields: ['i'], isUnique: false, name: 'i_named' },
      { fields: ['j'], isUnique: false, kind: 'fulltext' },
      { fields: ['l', 'm'], isUnique: true, name: 'l_m_unique_name' },
      { fields: ['m', 'l'], isUnique: false },
      { fields: ['j', 'k'], isUnique: false, kind: 'fulltext' },
    ]);
    expect(schema.warnings).toEqual([]);
  });

  it('converts defaults by column type', async () => {
    const schema: IrSchema = await parseMigrations(`
        Schema::create('posts', function (Blueprint $table) {
            $table->id();
            $table->timestamp('a')->useCurrent();
            $table->timestamp('b')->default(DB::raw('CURRENT_TIMESTAMP'));
            $table->timestamp('c')->default(now());
            $table->timestamp('d')->default('now()');
            $table->uuid('e')->default(DB::raw('gen_random_uuid()'));
            $table->uuid('f')->default(DB::raw('(uuid_generate_v4())'));
            $table->string('g')->default(DB::raw("'quoted'"));
            $table->integer('h')->default(DB::raw('42'));
            $table->boolean('i')->default(1);
            $table->boolean('j')->default('0');
            $table->integer('k')->default('12');
            $table->string('l')->default(5);
            $table->string('m')->default(DB::raw('lower(name)'));
            $table->json('n')->default('[]');
            $table->decimal('o', 5, 2)->default('1.50');
        });`);
    const defaults: Record<string, unknown> = {};
    for (const f of model(schema, 'Post').fields) {
      defaults[f.name] = f.default;
    }
    expect(defaults['a']).toEqual({ kind: 'now' });
    expect(defaults['b']).toEqual({ kind: 'now' });
    expect(defaults['c']).toEqual({ kind: 'now' });
    expect(defaults['d']).toEqual({ kind: 'now' });
    expect(defaults['e']).toEqual({ kind: 'uuid' });
    expect(defaults['f']).toEqual({ kind: 'uuid' });
    expect(defaults['g']).toEqual({ kind: 'literal', value: 'quoted' });
    expect(defaults['h']).toEqual({ kind: 'literal', value: 42 });
    expect(defaults['i']).toEqual({ kind: 'literal', value: 1 });
    expect(defaults['j']).toEqual({ kind: 'literal', value: false });
    expect(defaults['k']).toEqual({ kind: 'literal', value: 12 });
    expect(defaults['l']).toEqual({ kind: 'literal', value: '5' });
    expect(defaults['m']).toEqual({
      kind: 'dbExpression',
      expression: 'lower(name)',
    });
    expect(defaults['n']).toEqual({ kind: 'literal', value: '[]' });
    expect(defaults['o']).toEqual({ kind: 'literal', value: 1.5 });
  });

  it('marks useCurrentOnUpdate columns as auto-updated', async () => {
    const schema: IrSchema = await parseMigrations(`
        Schema::create('posts', function (Blueprint $table) {
            $table->id();
            $table->timestamp('changed')->useCurrent()->useCurrentOnUpdate();
        });`);
    expect(field(schema, 'Post', 'changed')).toMatchObject({
      isAutoUpdated: true,
      default: { kind: 'now' },
    });
  });

  it('reads generated columns and warns about identity columns', async () => {
    const schema: IrSchema = await parseMigrations(`
        Schema::create('posts', function (Blueprint $table) {
            $table->id();
            $table->integer('a');
            $table->integer('b');
            $table->integer('total')->storedAs('a + b');
            $table->integer('diff')->virtualAs(DB::raw('a - b'));
            $table->integer('ident')->generatedAs();
        });`);
    expect(field(schema, 'Post', 'total').generated).toEqual({
      expression: 'a + b',
      isStored: true,
    });
    expect(field(schema, 'Post', 'diff').generated).toEqual({
      expression: 'a - b',
      isStored: false,
    });
    expect(
      warningsMatching(schema, 'posts.ident: identity columns')
    ).toHaveLength(1);
  });

  it('warns about unknown modifiers and Blueprint calls', async () => {
    const schema: IrSchema = await parseMigrations(`
        Schema::create('posts', function (Blueprint $table) {
            $table->id();
            $table->string('a')->mystery();
            $table->engine('InnoDB');
            $table->madeUpColumn('b');
        });`);
    expect(
      warningsMatching(schema, 'posts.a: the column modifier mystery()')
    ).toHaveLength(1);
    expect(
      warningsMatching(schema, 'posts: the Blueprint call madeUpColumn()')
    ).toHaveLength(1);
    expect(warningsMatching(schema, 'engine')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Foreign keys
// ---------------------------------------------------------------------------

describe('foreign keys', () => {
  it('reads foreignId()->constrained() and infers the table from the column', async () => {
    const schema: IrSchema = await parseMigrations(
      USERS,
      `
        Schema::create('categories', function (Blueprint $table) {
            $table->id();
        });
        Schema::create('posts', function (Blueprint $table) {
            $table->id();
            $table->foreignId('user_id')->constrained()->cascadeOnDelete();
            $table->foreignId('category_id')->nullable()->constrained()->nullOnDelete();
            $table->foreignId('reviewer_id')->nullable()->constrained('users')->restrictOnDelete()->cascadeOnUpdate();
            $table->foreignId('editor_id')->constrained(table: 'users')->onDelete('set null');
        });`
    );
    expect(relation(schema, 'Post', 'user')).toMatchObject({
      kind: 'foreignKey',
      targetModel: 'User',
      columnName: 'user_id',
      isNullable: false,
      onDelete: 'cascade',
    });
    expect(relation(schema, 'Post', 'category')).toMatchObject({
      targetModel: 'Category',
      isNullable: true,
      onDelete: 'setNull',
    });
    expect(relation(schema, 'Post', 'reviewer')).toMatchObject({
      targetModel: 'User',
      onDelete: 'restrict',
      onUpdate: 'cascade',
    });
    expect(relation(schema, 'Post', 'editor').onDelete).toBe('setNull');
    expect(fieldNames(schema, 'Post')).toEqual(['id']);
  });

  it('reads foreignUuid, foreignUlid and foreignIdFor', async () => {
    const schema: IrSchema = await parseMigrations(
      `
        Schema::create('users', function (Blueprint $table) {
            $table->id();
        });
        Schema::create('posts', function (Blueprint $table) {
            $table->id();
            $table->foreignUuid('uuid_ref')->nullable()->constrained('users');
            $table->foreignUlid('ulid_ref')->nullable()->constrained('users');
            $table->foreignIdFor(App\\Models\\User::class)->constrained();
            $table->foreignIdFor(App\\Models\\User::class, 'second_user_id')->constrained();
        });`
    );
    expect(relation(schema, 'Post', 'uuid_ref').targetModel).toBe('User');
    expect(relation(schema, 'Post', 'ulid_ref').targetModel).toBe('User');
    expect(relation(schema, 'Post', 'user').columnName).toBe('user_id');
    expect(relation(schema, 'Post', 'second_user').columnName).toBe(
      'second_user_id'
    );
  });

  it('reads references()->on() and foreign() with actions', async () => {
    const schema: IrSchema = await parseMigrations(
      USERS,
      `
        Schema::create('posts', function (Blueprint $table) {
            $table->id();
            $table->unsignedBigInteger('author_id');
            $table->unsignedBigInteger('editor_id')->nullable();
            $table->unsignedBigInteger('other_id')->nullable();
            $table->foreign('author_id')->references('id')->on('users')->onDelete('cascade')->onUpdate('restrict');
            $table->foreign('editor_id')->references('id')->on('users')->nullOnDelete();
            $table->foreign('other_id')->references('id')->on('users')->noActionOnDelete();
        });`
    );
    expect(relation(schema, 'Post', 'author')).toMatchObject({
      onDelete: 'cascade',
      onUpdate: 'restrict',
    });
    expect(relation(schema, 'Post', 'editor').onDelete).toBe('setNull');
    expect(relation(schema, 'Post', 'other').onDelete).toBe('noAction');
  });

  it('turns a foreign key to a non-primary column into toField', async () => {
    const schema: IrSchema = await parseMigrations(`
        Schema::create('countries', function (Blueprint $table) {
            $table->id();
            $table->string('code', 2)->unique();
        });
        Schema::create('cities', function (Blueprint $table) {
            $table->id();
            $table->string('country_code', 2);
            $table->foreign('country_code')->references('code')->on('countries');
        });`);
    expect(relation(schema, 'City', 'country_code')).toMatchObject({
      targetModel: 'Country',
      toField: 'code',
    });
  });

  it('makes a unique foreign key one-to-one and a primary-key foreign key a key', async () => {
    const schema: IrSchema = await parseMigrations(
      USERS,
      `
        Schema::create('profiles', function (Blueprint $table) {
            $table->foreignId('user_id')->primary()->constrained()->cascadeOnDelete();
        });
        Schema::create('badges', function (Blueprint $table) {
            $table->id();
            $table->foreignId('user_id')->unique()->constrained();
        });`
    );
    expect(relation(schema, 'Profile', 'user')).toMatchObject({
      kind: 'oneToOne',
      isPrimaryKey: true,
      isNullable: false,
    });
    expect(relation(schema, 'Badge', 'user').kind).toBe('oneToOne');
    expect(model(schema, 'Badge').indexes).toEqual([]);
  });

  it('keeps unresolvable and composite foreign keys as plain columns, with warnings', async () => {
    const schema: IrSchema = await parseMigrations(`
        Schema::create('posts', function (Blueprint $table) {
            $table->id();
            $table->unsignedBigInteger('tenant_id');
            $table->unsignedBigInteger('a_id');
            $table->unsignedBigInteger('b_id');
            $table->foreign('tenant_id')->references('id')->on('tenants');
            $table->foreign(['a_id', 'b_id'])->references(['x', 'y'])->on('posts');
        });`);
    expect(fieldNames(schema, 'Post')).toEqual([
      'id',
      'tenant_id',
      'a_id',
      'b_id',
    ]);
    expect(model(schema, 'Post').relations).toEqual([]);
    expect(
      warningsMatching(
        schema,
        'posts.tenant_id: the foreign key references the table "tenants"'
      )
    ).toHaveLength(1);
    expect(
      warningsMatching(schema, 'the composite foreign key (a_id, b_id)')
    ).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

describe('Eloquent models', () => {
  const POSTS_AND_USERS: string = `
        Schema::create('users', function (Blueprint $table) {
            $table->id();
            $table->string('name');
        });
        Schema::create('posts', function (Blueprint $table) {
            $table->id();
            $table->foreignId('user_id')->constrained();
            $table->string('title');
        });`;

  it('maps models to tables by convention and by $table', async () => {
    const schema: IrSchema = await parse({
      '2024_01_01_000000_create.php': migration(`
        Schema::create('posts', function (Blueprint $table) { $table->id(); });
        Schema::create('user_profiles', function (Blueprint $table) { $table->id(); });
        Schema::create('categories', function (Blueprint $table) { $table->id(); });
        Schema::create('people', function (Blueprint $table) { $table->id(); });
        Schema::create('legacy_things', function (Blueprint $table) { $table->id(); });
      `),
      'Post.php': modelClass('Post', ''),
      'UserProfile.php': modelClass('UserProfile', ''),
      'Category.php': modelClass('Category', ''),
      'Person.php': modelClass('Person', ''),
      'Thing.php': modelClass('Thing', "protected $table = 'legacy_things';"),
    });
    expect(
      Object.fromEntries(
        schema.models.map((m: IrModel): [string, string] => [
          m.name,
          m.tableName,
        ])
      )
    ).toEqual({
      Post: 'posts',
      UserProfile: 'user_profiles',
      Category: 'categories',
      Person: 'people',
      Thing: 'legacy_things',
    });
  });

  it('names tables without a model after the singular table name', async () => {
    const schema: IrSchema = await parseMigrations(`
        Schema::create('password_reset_tokens', function (Blueprint $table) { $table->string('email')->primary(); });
        Schema::create('blog_posts', function (Blueprint $table) { $table->id(); });
        Schema::create('media', function (Blueprint $table) { $table->id(); });`);
    expect(schema.models.map((m: IrModel) => m.name)).toEqual([
      'PasswordResetToken',
      'BlogPost',
      'Media',
    ]);
  });

  it('skips models whose table no migration creates, and ignores other classes', async () => {
    const schema: IrSchema = await parse({
      '2024_01_01_000000_create.php': migration(
        `Schema::create('posts', function (Blueprint $table) { $table->id(); });`
      ),
      'Post.php': modelClass('Post', ''),
      'Ghost.php': modelClass('Ghost', ''),
      'Controller.php': `<?php
namespace App\\Http;
class PostController extends Controller { public function index() { return Post::all(); } }
`,
      'Enum.php': `<?php
namespace App\\Enums;
enum Plain { case A; case B; }
`,
    });
    expect(schema.models.map((m: IrModel) => m.name)).toEqual(['Post']);
    expect(
      warningsMatching(schema, 'Ghost: the model maps to the table "ghosts"')
    ).toHaveLength(1);
  });

  it('reads has-one, has-many and belongs-to for names and reverse names', async () => {
    const schema: IrSchema = await parse({
      '2024_01_01_000000_create.php': migration(POSTS_AND_USERS),
      'User.php': modelClass(
        'User',
        `
    public function posts() { return $this->hasMany(Post::class); }
    public function latestPost() { return $this->hasOne(Post::class); }
`,
        'Authenticatable'
      ),
      'Post.php': modelClass(
        'Post',
        `
    public function author() { return $this->belongsTo(User::class, 'user_id'); }
`
      ),
    });
    // Both relationships point at posts.user_id; the belongs-to names the relation, the first reverse wins.
    expect(relation(schema, 'Post', 'author')).toMatchObject({
      kind: 'foreignKey',
      targetModel: 'User',
      columnName: 'user_id',
      relatedName: 'posts',
    });
    expect(model(schema, 'Post').relations).toHaveLength(1);
  });

  it('uses hasOne for a one-to-one reverse and falls back to the column name without a model', async () => {
    const schema: IrSchema = await parse({
      '2024_01_01_000000_create.php': migration(POSTS_AND_USERS),
      'User.php': modelClass(
        'User',
        `public function post() { return $this->hasOne(Post::class); }`,
        'Authenticatable'
      ),
      'Post.php': modelClass('Post', ''),
    });
    expect(relation(schema, 'Post', 'user')).toMatchObject({
      kind: 'oneToOne',
      relatedName: 'post',
    });
  });

  it('creates a relation from hasMany even when the table has no foreign key constraint', async () => {
    const schema: IrSchema = await parse({
      '2024_01_01_000000_create.php': migration(`
        Schema::create('users', function (Blueprint $table) { $table->id(); });
        Schema::create('posts', function (Blueprint $table) {
            $table->id();
            $table->unsignedBigInteger('writer_id')->nullable();
        });`),
      'User.php': modelClass(
        'User',
        `public function posts() { return $this->hasMany(Post::class, 'writer_id'); }`
      ),
      'Post.php': modelClass('Post', ''),
    });
    expect(relation(schema, 'Post', 'writer')).toMatchObject({
      columnName: 'writer_id',
      isNullable: true,
      onDelete: 'noAction',
      relatedName: 'posts',
    });
    expect(fieldNames(schema, 'Post')).toEqual(['id']);
  });

  it('honours custom keys: belongsTo foreign and owner keys, hasMany local keys', async () => {
    const schema: IrSchema = await parse({
      '2024_01_01_000000_create.php': migration(`
        Schema::create('accounts', function (Blueprint $table) {
            $table->id();
            $table->string('handle')->unique();
        });
        Schema::create('posts', function (Blueprint $table) {
            $table->id();
            $table->string('owner_handle');
        });`),
      'Account.php': modelClass(
        'Account',
        `public function posts() { return $this->hasMany(Post::class, 'owner_handle', 'handle'); }`
      ),
      'Post.php': modelClass(
        'Post',
        `public function owner() { return $this->belongsTo(Account::class, 'owner_handle', 'handle'); }`
      ),
    });
    expect(relation(schema, 'Post', 'owner')).toMatchObject({
      columnName: 'owner_handle',
      toField: 'handle',
      relatedName: 'posts',
    });
  });

  it('derives the default foreign key from the method name for belongsTo', async () => {
    const schema: IrSchema = await parse({
      '2024_01_01_000000_create.php': migration(`
        Schema::create('users', function (Blueprint $table) { $table->id(); });
        Schema::create('posts', function (Blueprint $table) {
            $table->id();
            $table->unsignedBigInteger('author_id');
        });`),
      'User.php': modelClass('User', ''),
      'Post.php': modelClass(
        'Post',
        `public function author() { return $this->belongsTo(User::class); }`
      ),
    });
    expect(relation(schema, 'Post', 'author').columnName).toBe('author_id');
  });

  it('warns when a relationship uses a column the table does not have', async () => {
    const schema: IrSchema = await parse({
      '2024_01_01_000000_create.php': migration(POSTS_AND_USERS),
      'User.php': modelClass(
        'User',
        `public function posts() { return $this->hasMany(Post::class, 'author_id'); }`
      ),
      'Post.php': modelClass(
        'Post',
        `public function writer() { return $this->belongsTo(User::class); }`
      ),
    });
    expect(
      warningsMatching(
        schema,
        'User::posts(): hasMany uses the column "author_id"'
      )
    ).toHaveLength(1);
    expect(
      warningsMatching(
        schema,
        'Post::writer(): belongsTo uses the column "writer_id"'
      )
    ).toHaveLength(1);
    // The constraint on user_id still produces a relation named after the column.
    expect(relation(schema, 'Post', 'user').targetModel).toBe('User');
  });

  it('reads $casts, casts() and the backed enums they name', async () => {
    const status: string = `<?php
namespace App\\Enums;
enum Status: string {
    case Draft = 'draft';
    case Live = 'live';
}
`;
    const intEnum: string = `<?php
namespace App\\Enums;
enum Level: int {
    case Low = 1;
}
`;
    const files: Record<string, string> = {
      '2024_01_01_000000_create.php': migration(`
        Schema::create('posts', function (Blueprint $table) {
            $table->id();
            $table->string('status')->default('draft');
            $table->string('kind', 20);
            $table->enum('mode', ['draft', 'live'])->default('live');
            $table->tinyInteger('is_live')->default(1);
            $table->text('payload');
            $table->string('seen_at');
            $table->decimal('price', 8, 4);
            $table->integer('level');
            $table->string('secret');
        });`),
      'Status.php': status,
      'Level.php': intEnum,
      'Post.php': modelClass(
        'Post',
        `
    protected $casts = [
        'status' => Status::class,
        'is_live' => 'boolean',
        'payload' => 'array',
        'price' => 'decimal:2',
        'secret' => 'encrypted',
    ];

    protected function casts(): array
    {
        return [
            'mode' => Status::class,
            'seen_at' => 'datetime',
            'level' => \\App\\Enums\\Level::class,
            'kind' => 'App\\\\Enums\\\\Status',
        ];
    }
`
      ),
    };
    const schema: IrSchema = await parse(files);
    expect(field(schema, 'Post', 'status')).toMatchObject({
      type: 'string',
      enumName: 'Status',
      default: { kind: 'enumValue', value: 'Draft' },
    });
    expect(field(schema, 'Post', 'status').maxLength).toBeUndefined();
    // An explicit length stays when the column is enum-backed.
    expect(field(schema, 'Post', 'kind')).toMatchObject({
      enumName: 'Status',
      maxLength: 20,
    });
    expect(field(schema, 'Post', 'mode')).toMatchObject({
      enumName: 'Status',
      default: { kind: 'enumValue', value: 'Live' },
    });
    expect(field(schema, 'Post', 'is_live')).toMatchObject({
      type: 'boolean',
      default: { kind: 'literal', value: true },
    });
    expect(field(schema, 'Post', 'payload').type).toBe('json');
    expect(field(schema, 'Post', 'seen_at').type).toBe('dateTime');
    expect(field(schema, 'Post', 'price')).toMatchObject({
      type: 'decimal',
      maxDigits: 8,
      decimalPlaces: 2,
    });
    expect(field(schema, 'Post', 'level')).toMatchObject({ type: 'int' });
    expect(field(schema, 'Post', 'level').enumName).toBeUndefined();
    expect(
      warningsMatching(
        schema,
        'posts.level: the cast to the int-backed enum Level'
      )
    ).toHaveLength(1);
    // Only the enums that fields use are part of the schema.
    expect(schema.enums.map((entry: IrEnum) => entry.name)).toEqual(['Status']);
  });

  it('prefers a backed enum cast but reports values that are not cases', async () => {
    const schema: IrSchema = await parse({
      '2024_01_01_000000_create.php': migration(`
        Schema::create('posts', function (Blueprint $table) {
            $table->id();
            $table->enum('status', ['draft', 'archived']);
        });`),
      'Status.php': `<?php
namespace App\\Enums;
enum Status: string { case Draft = 'draft'; }
`,
      'Post.php': modelClass(
        'Post',
        `protected $casts = ['status' => Status::class];`
      ),
    });
    expect(field(schema, 'Post', 'status').enumName).toBe('Status');
    expect(
      warningsMatching(
        schema,
        'posts.status: the enum() values (archived) are not cases of Status'
      )
    ).toHaveLength(1);
  });

  it('uses $timestamps, CREATED_AT and UPDATED_AT', async () => {
    const schema: IrSchema = await parse({
      '2024_01_01_000000_create.php': migration(`
        Schema::create('posts', function (Blueprint $table) {
            $table->id();
            $table->timestamps();
        });
        Schema::create('notes', function (Blueprint $table) {
            $table->id();
            $table->timestamps();
        });
        Schema::create('events', function (Blueprint $table) {
            $table->id();
            $table->timestamp('made_at')->nullable();
            $table->timestamp('touched_at')->nullable();
            $table->timestamp('updated_at')->nullable();
        });
        Schema::create('logs', function (Blueprint $table) {
            $table->id();
            $table->timestamp('created_at')->nullable();
            $table->timestamp('updated_at')->nullable();
        });`),
      'Post.php': modelClass('Post', ''),
      'Note.php': modelClass('Note', 'public $timestamps = false;'),
      'Event.php': modelClass(
        'Event',
        `const CREATED_AT = 'made_at';
    const UPDATED_AT = 'touched_at';`
      ),
      'Log.php': modelClass('Log', 'const UPDATED_AT = null;'),
    });
    // Eloquent maintains the timestamp columns: updated_at refreshes, created_at starts at the current time.
    expect(field(schema, 'Post', 'updated_at').isAutoUpdated).toBe(true);
    expect(field(schema, 'Post', 'created_at').default).toEqual({
      kind: 'now',
    });
    // With $timestamps = false nothing is assumed.
    expect(field(schema, 'Note', 'updated_at').isAutoUpdated).toBe(false);
    expect(field(schema, 'Note', 'created_at').default).toBeUndefined();
    // Renamed constants point at other columns; the stock updated_at is then a plain column.
    expect(field(schema, 'Event', 'touched_at').isAutoUpdated).toBe(true);
    expect(field(schema, 'Event', 'made_at').default).toEqual({ kind: 'now' });
    expect(field(schema, 'Event', 'updated_at').isAutoUpdated).toBe(false);
    // UPDATED_AT = null turns the updated column off.
    expect(field(schema, 'Log', 'updated_at').isAutoUpdated).toBe(false);
    expect(field(schema, 'Log', 'created_at').default).toEqual({ kind: 'now' });
  });

  it('keeps deleted_at for SoftDeletes and warns when the column is missing', async () => {
    const schema: IrSchema = await parse({
      '2024_01_01_000000_create.php': migration(`
        Schema::create('posts', function (Blueprint $table) {
            $table->id();
            $table->softDeletes();
        });
        Schema::create('notes', function (Blueprint $table) {
            $table->id();
        });
        Schema::create('events', function (Blueprint $table) {
            $table->id();
            $table->timestamp('removed_at')->nullable();
        });`),
      'Post.php': modelClass('Post', 'use SoftDeletes;'),
      'Note.php': modelClass('Note', 'use SoftDeletes;'),
      'Event.php': modelClass(
        'Event',
        "use SoftDeletes;\n    const DELETED_AT = 'removed_at';"
      ),
    });
    expect(field(schema, 'Post', 'deleted_at')).toMatchObject({
      type: 'dateTime',
      isNullable: true,
    });
    expect(
      warningsMatching(
        schema,
        'Note: the model uses SoftDeletes but the table "notes" has no "deleted_at" column'
      )
    ).toHaveLength(1);
    expect(
      warningsMatching(schema, 'Event: the model uses SoftDeletes')
    ).toHaveLength(0);
  });

  it('generates keys for HasUuids and HasUlids models', async () => {
    const schema: IrSchema = await parse({
      '2024_01_01_000000_create.php': migration(`
        Schema::create('posts', function (Blueprint $table) { $table->uuid('id')->primary(); });
        Schema::create('notes', function (Blueprint $table) { $table->ulid('id')->primary(); });`),
      'Post.php': modelClass(
        'Post',
        'use \\Illuminate\\Database\\Eloquent\\Concerns\\HasUuids;'
      ),
      'Note.php': modelClass(
        'Note',
        'use \\Illuminate\\Database\\Eloquent\\Concerns\\HasUlids;'
      ),
    });
    expect(field(schema, 'Post', 'id').default).toEqual({ kind: 'uuid' });
    expect(field(schema, 'Note', 'id').default).toEqual({
      kind: 'clientGenerated',
      generator: 'ulid',
    });
  });

  it('inherits timestamps and casts from an abstract base model', async () => {
    const schema: IrSchema = await parse({
      '2024_01_01_000000_create.php': migration(`
        Schema::create('posts', function (Blueprint $table) {
            $table->id();
            $table->text('data');
            $table->timestamp('updated_at')->nullable();
        });`),
      'BaseModel.php': modelClass(
        'BaseModel',
        `protected $casts = ['data' => 'array'];`
      ).replace('class BaseModel', 'abstract class BaseModel'),
      'Post.php': modelClass('Post', '', 'BaseModel'),
    });
    expect(schema.models.map((m: IrModel) => m.name)).toEqual(['Post']);
    expect(field(schema, 'Post', 'data').type).toBe('json');
    expect(field(schema, 'Post', 'updated_at').isAutoUpdated).toBe(true);
  });

  it('warns about polymorphic, through and constrained relations', async () => {
    const schema: IrSchema = await parse({
      '2024_01_01_000000_create.php': migration(`
        Schema::create('countries', function (Blueprint $table) { $table->id(); });
        Schema::create('users', function (Blueprint $table) {
            $table->id();
            $table->foreignId('country_id')->constrained();
        });
        Schema::create('posts', function (Blueprint $table) {
            $table->id();
            $table->foreignId('user_id')->constrained();
            $table->morphs('imageable');
        });`),
      'Country.php': modelClass(
        'Country',
        `
    public function posts() { return $this->hasManyThrough(Post::class, User::class); }
    public function users() { return $this->hasMany(User::class); }
`
      ),
      'User.php': modelClass(
        'User',
        `
    public function posts() { return $this->hasMany(Post::class)->where('published', true); }
    public function images() { return $this->morphMany(Image::class, 'imageable'); }
`
      ),
      'Post.php': modelClass(
        'Post',
        `
    public function imageable() { return $this->morphTo(); }
    public function broken(): HasMany { return someHelper(); }
`
      ),
    });
    expect(
      warningsMatching(
        schema,
        'Country::posts(): the hasManyThrough relation is derived'
      )
    ).toHaveLength(1);
    expect(
      warningsMatching(
        schema,
        'User::images(): the polymorphic relation (morphMany)'
      )
    ).toHaveLength(1);
    expect(
      warningsMatching(
        schema,
        'Post::imageable(): the polymorphic relation (morphTo)'
      )
    ).toHaveLength(1);
    expect(
      warningsMatching(
        schema,
        'User::posts(): the relation is further constrained by where()'
      )
    ).toHaveLength(1);
    expect(
      warningsMatching(
        schema,
        'Post::broken(): the relationship method could not be analysed'
      )
    ).toHaveLength(1);
    // The morph columns stay ordinary columns.
    expect(fieldNames(schema, 'Post')).toEqual([
      'id',
      'imageable_type',
      'imageable_id',
    ]);
    expect(relation(schema, 'User', 'country').relatedName).toBe('users');
  });
});

// ---------------------------------------------------------------------------
// Pivot tables
// ---------------------------------------------------------------------------

describe('pivot tables', () => {
  const POSTS_AND_TAGS: string = `
        Schema::create('posts', function (Blueprint $table) { $table->id(); });
        Schema::create('tags', function (Blueprint $table) { $table->id(); });`;

  it('folds the conventionally named pivot table into a many-to-many field', async () => {
    const schema: IrSchema = await parse({
      '2024_01_01_000000_create.php': migration(`${POSTS_AND_TAGS}
        Schema::create('post_tag', function (Blueprint $table) {
            $table->foreignId('post_id')->constrained()->cascadeOnDelete();
            $table->foreignId('tag_id')->constrained()->cascadeOnDelete();
            $table->primary(['post_id', 'tag_id']);
        });`),
      'Post.php': modelClass(
        'Post',
        `public function tags() { return $this->belongsToMany(Tag::class); }`
      ),
      'Tag.php': modelClass(
        'Tag',
        `public function posts() { return $this->belongsToMany(Post::class); }`
      ),
    });
    expect(schema.models.map((m: IrModel) => m.name).sort()).toEqual([
      'Post',
      'Tag',
    ]);
    expect(relation(schema, 'Post', 'tags')).toMatchObject({
      kind: 'manyToMany',
      targetModel: 'Tag',
      relatedName: 'posts',
    });
    // The other side is represented by relatedName only.
    expect(model(schema, 'Tag').relations).toEqual([]);
    // Pivot name "post_tag" (singular, alphabetical) differs from what other formats derive.
    expect(warningsMatching(schema, 'the pivot table "post_tag"')).toHaveLength(
      1
    );
  });

  it('does not warn when the pivot table matches what other formats derive', async () => {
    const schema: IrSchema = await parse({
      '2024_01_01_000000_create.php': migration(`${POSTS_AND_TAGS}
        Schema::create('posts_tags', function (Blueprint $table) {
            $table->unsignedBigInteger('post_id');
            $table->unsignedBigInteger('tag_id');
        });`),
      'Post.php': modelClass(
        'Post',
        `public function tags() { return $this->belongsToMany(Tag::class, 'posts_tags'); }`
      ),
      'Tag.php': modelClass('Tag', ''),
    });
    expect(relation(schema, 'Post', 'tags').relatedName).toBeUndefined();
    expect(schema.models.map((m: IrModel) => m.name).sort()).toEqual([
      'Post',
      'Tag',
    ]);
    expect(schema.warnings).toEqual([]);
  });

  it('honours custom pivot table and key names', async () => {
    const schema: IrSchema = await parse({
      '2024_01_01_000000_create.php': migration(`${POSTS_AND_TAGS}
        Schema::create('labels_on_posts', function (Blueprint $table) {
            $table->unsignedBigInteger('article');
            $table->unsignedBigInteger('label');
        });`),
      'Post.php': modelClass(
        'Post',
        `public function tags() { return $this->belongsToMany(Tag::class, 'labels_on_posts', 'article', 'label'); }`
      ),
      'Tag.php': modelClass('Tag', ''),
    });
    expect(relation(schema, 'Post', 'tags').kind).toBe('manyToMany');
    expect(schema.models.map((m: IrModel) => m.name).sort()).toEqual([
      'Post',
      'Tag',
    ]);
    expect(
      warningsMatching(
        schema,
        'the pivot table "labels_on_posts" (columns article, label)'
      )
    ).toHaveLength(1);
  });

  it('folds a pivot with an id column and timestamps, noting the timestamps', async () => {
    const schema: IrSchema = await parse({
      '2024_01_01_000000_create.php': migration(`${POSTS_AND_TAGS}
        Schema::create('post_tag', function (Blueprint $table) {
            $table->id();
            $table->unsignedBigInteger('post_id');
            $table->unsignedBigInteger('tag_id');
            $table->timestamps();
        });`),
      'Post.php': modelClass(
        'Post',
        `public function tags() { return $this->belongsToMany(Tag::class)->withTimestamps(); }`
      ),
      'Tag.php': modelClass('Tag', ''),
    });
    expect(relation(schema, 'Post', 'tags').kind).toBe('manyToMany');
    expect(schema.models.map((m: IrModel) => m.name).sort()).toEqual([
      'Post',
      'Tag',
    ]);
    expect(
      warningsMatching(
        schema,
        'timestamp columns of the pivot table "post_tag"'
      )
    ).toHaveLength(1);
  });

  it('warns when pivot foreign keys do not cascade', async () => {
    const schema: IrSchema = await parse({
      '2024_01_01_000000_create.php': migration(`${POSTS_AND_TAGS}
        Schema::create('post_tag', function (Blueprint $table) {
            $table->unsignedBigInteger('post_id');
            $table->unsignedBigInteger('tag_id');
            $table->foreign('post_id')->references('id')->on('posts')->restrictOnDelete();
            $table->foreign('tag_id')->references('id')->on('tags')->cascadeOnDelete();
        });`),
      'Post.php': modelClass(
        'Post',
        `public function tags() { return $this->belongsToMany(Tag::class); }`
      ),
      'Tag.php': modelClass('Tag', ''),
    });
    expect(warningsMatching(schema, 'do not cascade on delete')).toHaveLength(
      1
    );
  });

  it('keeps a pivot with extra columns as a model', async () => {
    const schema: IrSchema = await parse({
      '2024_01_01_000000_create.php': migration(`${POSTS_AND_TAGS}
        Schema::create('post_tag', function (Blueprint $table) {
            $table->unsignedBigInteger('post_id');
            $table->unsignedBigInteger('tag_id');
            $table->integer('weight')->default(0);
            $table->primary(['post_id', 'tag_id']);
        });`),
      'Post.php': modelClass(
        'Post',
        `public function tags() { return $this->belongsToMany(Tag::class)->withPivot('weight'); }`
      ),
      'Tag.php': modelClass('Tag', ''),
    });
    expect(schema.models.map((m: IrModel) => m.name).sort()).toEqual([
      'Post',
      'PostTag',
      'Tag',
    ]);
    expect(model(schema, 'Post').relations).toEqual([]);
    expect(relation(schema, 'PostTag', 'post')).toMatchObject({
      targetModel: 'Post',
      columnName: 'post_id',
    });
    expect(relation(schema, 'PostTag', 'tag').targetModel).toBe('Tag');
    expect(model(schema, 'PostTag').compositePrimaryKey).toEqual([
      'post',
      'tag',
    ]);
    expect(field(schema, 'PostTag', 'weight').default).toEqual({
      kind: 'literal',
      value: 0,
    });
    expect(
      warningsMatching(
        schema,
        'Post::tags(): the pivot table "post_tag" has extra columns (weight)'
      )
    ).toHaveLength(1);
  });

  it('pairs a self-referencing many-to-many with its mirror', async () => {
    const schema: IrSchema = await parse({
      '2024_01_01_000000_create.php': migration(`
        Schema::create('users', function (Blueprint $table) { $table->id(); });
        Schema::create('follows', function (Blueprint $table) {
            $table->unsignedBigInteger('follower_id');
            $table->unsignedBigInteger('followed_id');
        });`),
      'User.php': modelClass(
        'User',
        `
    public function following() { return $this->belongsToMany(User::class, 'follows', 'follower_id', 'followed_id'); }
    public function followers() { return $this->belongsToMany(User::class, 'follows', 'followed_id', 'follower_id'); }
`
      ),
    });
    const user: IrModel = model(schema, 'User');
    expect(user.relations).toHaveLength(1);
    expect(user.relations[0]).toMatchObject({
      name: 'followers',
      kind: 'manyToMany',
      targetModel: 'User',
      relatedName: 'following',
    });
  });

  it('skips belongsToMany relations whose pivot table or columns are missing', async () => {
    const schema: IrSchema = await parse({
      '2024_01_01_000000_create.php': migration(`${POSTS_AND_TAGS}
        Schema::create('post_tag', function (Blueprint $table) { $table->unsignedBigInteger('post_id'); });`),
      'Post.php': modelClass(
        'Post',
        `
    public function tags() { return $this->belongsToMany(Tag::class); }
    public function labels() { return $this->belongsToMany(Tag::class, 'nowhere'); }
    public function strangers() { return $this->belongsToMany(Stranger::class); }
`
      ),
      'Tag.php': modelClass('Tag', ''),
    });
    expect(model(schema, 'Post').relations).toEqual([]);
    expect(
      warningsMatching(
        schema,
        'Post::tags(): the pivot table "post_tag" has no column "tag_id"'
      )
    ).toHaveLength(1);
    expect(
      warningsMatching(
        schema,
        'Post::labels(): the pivot table "nowhere" is not created'
      )
    ).toHaveLength(1);
    expect(
      warningsMatching(
        schema,
        'Post::strangers(): the related class is not a model'
      )
    ).toHaveLength(1);
  });
});

// Expected tables come from Laravel itself: Str::snake(Str::pluralStudly($class)) in illuminate/support v13.35.
describe('Laravel naming conventions', () => {
  const CLASS_TABLES: [string, string][] = [
    ['Post', 'posts'],
    ['Category', 'categories'],
    ['Person', 'people'],
    ['Child', 'children'],
    ['UserProfile', 'user_profiles'],
    ['Status', 'statuses'],
    ['Box', 'boxes'],
    ['Bus', 'buses'],
    ['Quiz', 'quizzes'],
    ['Leaf', 'leaves'],
    ['Wolf', 'wolves'],
    ['Knife', 'knives'],
    ['Day', 'days'],
    ['Key', 'keys'],
    ['Hero', 'heroes'],
    ['Potato', 'potatoes'],
    ['Analysis', 'analyses'],
    ['Address', 'addresses'],
    ['Media', 'media'],
    ['Data', 'data'],
    ['News', 'news'],
    ['Series', 'series'],
    ['Species', 'species'],
    ['Fish', 'fish'],
    ['Sheep', 'sheep'],
    ['Index', 'indices'],
    ['Matrix', 'matrices'],
    ['Vertex', 'vertices'],
    ['Alias', 'aliases'],
    ['Virus', 'viri'],
    ['Crisis', 'crises'],
    ['Axis', 'axes'],
    ['Thesis', 'theses'],
    ['Mouse', 'mice'],
    ['Man', 'men'],
    ['Woman', 'women'],
    ['Tooth', 'teeth'],
    ['Foot', 'feet'],
    ['Goose', 'geese'],
    ['Ox', 'oxen'],
    ['Move', 'moves'],
    ['Sex', 'sexes'],
    ['Money', 'money'],
    ['Information', 'information'],
    ['Equipment', 'equipment'],
    ['Staff', 'staff'],
    ['Menu', 'menus'],
    ['Bureau', 'bureaus'],
    ['Photo', 'photos'],
    ['Piano', 'pianos'],
    ['Policy', 'policies'],
    ['Company', 'companies'],
    ['Buzz', 'buzzs'],
    ['Class', 'classes'],
    ['Dish', 'dishes'],
    ['Church', 'churches'],
    ['Tax', 'taxes'],
    ['Life', 'lives'],
    ['Shelf', 'shelves'],
    ['Half', 'halves'],
    ['Review', 'reviews'],
    ['Comment', 'comments'],
    ['Tag', 'tags'],
    ['OrderItem', 'order_items'],
    ['BlogPost', 'blog_posts'],
    ['ApiKey', 'api_keys'],
    ['Currency', 'currencies'],
    ['Bonus', 'bonuses'],
    ['Campus', 'campuses'],
    ['Atlas', 'atlases'],
    ['Canvas', 'canvases'],
  ];

  it('maps model classes to the table names Eloquent derives', async () => {
    const tables: string[] = [
      ...new Set(CLASS_TABLES.map(([, table]) => table)),
    ];
    const classes: Map<string, string> = new Map<string, string>();
    for (const [name, table] of CLASS_TABLES) {
      if (!classes.has(table)) {
        classes.set(table, name);
      }
    }
    const files: Record<string, string> = {
      '2024_01_01_000000_all.php': migration(
        tables
          .map(
            (table: string) =>
              `Schema::create('${table}', function (Blueprint $table) { $table->id(); });`
          )
          .join('\n')
      ),
    };
    for (const name of classes.values()) {
      files[`${name}.php`] = modelClass(name, '');
    }
    const schema: IrSchema = await parse(files);
    expect(schema.warnings).toEqual([]);
    expect(
      Object.fromEntries(
        schema.models.map((m: IrModel): [string, string] => [
          m.tableName,
          m.name,
        ])
      )
    ).toEqual(Object.fromEntries(classes));
  });

  // belongsToMany() tables and keys as computed by Eloquent for these pairs.
  it.each([
    ['Post', 'Tag', 'post_tag', 'post_id', 'tag_id'],
    [
      'UserProfile',
      'BlogPost',
      'blog_post_user_profile',
      'user_profile_id',
      'blog_post_id',
    ],
    ['APIKey', 'Zebra', 'a_p_i_key_zebra', 'a_p_i_key_id', 'zebra_id'],
    ['Zebra', 'APIKey', 'a_p_i_key_zebra', 'zebra_id', 'a_p_i_key_id'],
  ])(
    'derives the pivot table and keys of %s -> %s',
    async (
      owner: string,
      related: string,
      pivot: string,
      ownerKey: string,
      relatedKey: string
    ) => {
      const schema: IrSchema = await parse({
        '2024_01_01_000000_all.php': migration(`
          Schema::create('${conventionalTable(owner)}', function (Blueprint $table) { $table->id(); });
          Schema::create('${conventionalTable(related)}', function (Blueprint $table) { $table->id(); });
          Schema::create('${pivot}', function (Blueprint $table) {
              $table->unsignedBigInteger('${ownerKey}');
              $table->unsignedBigInteger('${relatedKey}');
          });`),
        [`${owner}.php`]: modelClass(
          owner,
          `public function others() { return $this->belongsToMany(${related}::class); }`
        ),
        [`${related}.php`]: modelClass(related, ''),
      });
      expect(relation(schema, owner, 'others').kind).toBe('manyToMany');
      expect(warningsMatching(schema, 'pivot table')).toEqual(
        warningsMatching(schema, 'is not preserved by name')
      );
      expect(schema.models.map((m: IrModel) => m.name).sort()).toEqual(
        [owner, related].sort()
      );
    }
  );

  it('derives hasMany and belongsTo foreign keys like Eloquent', async () => {
    const schema: IrSchema = await parse({
      '2024_01_01_000000_all.php': migration(`
        Schema::create('user_profiles', function (Blueprint $table) { $table->id(); });
        Schema::create('blog_posts', function (Blueprint $table) {
            $table->id();
            $table->unsignedBigInteger('user_profile_id');
            $table->unsignedBigInteger('editor_id');
        });`),
      'UserProfile.php': modelClass(
        'UserProfile',
        `public function posts() { return $this->hasMany(BlogPost::class); }`
      ),
      'BlogPost.php': modelClass(
        'BlogPost',
        `public function editor() { return $this->belongsTo(UserProfile::class); }`
      ),
    });
    expect(relation(schema, 'BlogPost', 'user_profile')).toMatchObject({
      columnName: 'user_profile_id',
      relatedName: 'posts',
    });
    expect(relation(schema, 'BlogPost', 'editor').columnName).toBe('editor_id');
  });
});

// ---------------------------------------------------------------------------
// Constructs that cannot be replayed faithfully
// ---------------------------------------------------------------------------

describe('unsupported constructs', () => {
  it('warns about conditionals and loops, naming the tables, and still applies them', async () => {
    const schema: IrSchema = await parseMigrations(`
        Schema::create('posts', function (Blueprint $table) {
            $table->id();
            if (config('app.extra')) {
                $table->string('extra');
            }
            foreach (['a', 'b'] as $name) {
                $table->string($name);
            }
        });
        if (! Schema::hasColumn('posts', 'later')) {
            Schema::table('posts', function (Blueprint $table) {
                $table->string('later');
            });
        }
        foreach (['x', 'y'] as $suffix) {
            Schema::create('table_' . $suffix, function (Blueprint $table) { $table->id(); });
        }`);
    expect(fieldNames(schema, 'Post')).toEqual(['id', 'extra', 'later']);
    expect(
      warningsMatching(schema, 'a conditional contains schema changes')
    ).toHaveLength(1);
    expect(
      warningsMatching(schema, 'a loop contains schema changes')
    ).toHaveLength(2);
    expect(warningsMatching(schema, '(tables: posts)').length).toBeGreaterThan(
      0
    );
    expect(warningsMatching(schema, 'posts: the column name')).toHaveLength(0);
    expect(
      warningsMatching(
        schema,
        'string() has a column name that is not a string literal'
      )
    ).toHaveLength(1);
    expect(
      warningsMatching(
        schema,
        'Schema::create() was given a table name that is not a string literal'
      )
    ).toHaveLength(1);
  });

  it('warns about raw SQL and names the table', async () => {
    const schema: IrSchema = await parseMigrations(`
        Schema::create('posts', function (Blueprint $table) { $table->id(); });
        DB::statement('ALTER TABLE posts ADD COLUMN extra jsonb');
        DB::unprepared('CREATE INDEX idx ON posts (extra)');
        DB::statement($sql);
        DB::table('posts')->insert(['id' => 1]);`);
    expect(
      warningsMatching(
        schema,
        'the raw SQL statement "ALTER TABLE posts ADD COLUMN extra jsonb" on the table "posts" is not interpreted'
      )
    ).toHaveLength(1);
    expect(
      warningsMatching(
        schema,
        'the raw SQL statement "CREATE INDEX idx ON posts (extra)" on the table "posts"'
      )
    ).toHaveLength(1);
    expect(
      warningsMatching(schema, 'the raw SQL statement "DB::statement($sql);"')
    ).toHaveLength(1);
    expect(warningsMatching(schema, 'insert')).toHaveLength(0);
  });

  it('warns about unknown Schema methods and non-literal defaults', async () => {
    const schema: IrSchema = await parseMigrations(`
        Schema::create('posts', function (Blueprint $table) {
            $table->id();
            $table->string('a')->default($value);
            $table->json('b')->default([]);
        });
        Schema::createView('v', 'select 1');
        Schema::disableForeignKeyConstraints();
        Schema::hasTable('posts');`);
    expect(warningsMatching(schema, 'posts.a: the default value')).toHaveLength(
      1
    );
    expect(
      warningsMatching(schema, 'posts.b: the default value (an array)')
    ).toHaveLength(1);
    expect(
      warningsMatching(schema, 'Schema::createView() is not interpreted')
    ).toHaveLength(1);
    expect(
      warningsMatching(schema, 'disableForeignKeyConstraints')
    ).toHaveLength(0);
    expect(warningsMatching(schema, 'hasTable')).toHaveLength(0);
  });

  it('warns about a missing timestamp prefix and PHP syntax errors', async () => {
    const schema: IrSchema = await parse({
      'create_posts.php': migration(
        `Schema::create('posts', function (Blueprint $table) { $table->id(); });`
      ),
      '2024_01_01_000000_other.php': migration(
        `Schema::create('notes', function (Blueprint $table) { $table->id(); });`
      ),
      'Broken.php': '<?php class Broken extends { ',
    });
    expect(
      warningsMatching(
        schema,
        'create_posts.php: the migration file name has no timestamp prefix'
      )
    ).toHaveLength(1);
    expect(
      warningsMatching(
        schema,
        'Broken.php: the file contains PHP syntax errors'
      )
    ).toHaveLength(1);
  });

  it('keeps tables without a primary key and warns', async () => {
    const schema: IrSchema = await parseMigrations(
      `Schema::create('logs', function (Blueprint $table) { $table->string('line'); });`
    );
    expect(
      warningsMatching(schema, 'logs: the table has no primary key')
    ).toHaveLength(1);
  });

  it('fails clearly when there are no migrations or every table is dropped', async () => {
    const noMigrations = await parseLaravel(
      [{ path: 'Post.php', text: modelClass('Post', '') }],
      { appLabel: 'app' }
    );
    expect(noMigrations.ok).toBe(false);
    if (!noMigrations.ok) {
      expect(noMigrations.error.code).toBe('NO_MODELS_FOUND');
      expect(noMigrations.error.message).toContain('database/migrations');
    }
    const nothingLeft = await parseLaravel(
      [
        {
          path: '2024_01_01_000000_a.php',
          text: migration(`
            Schema::create('posts', function (Blueprint $table) { $table->id(); });
            Schema::dropIfExists('posts');`),
        },
      ],
      { appLabel: 'app' }
    );
    expect(nothingLeft.ok).toBe(false);
    if (!nothingLeft.ok) {
      expect(nothingLeft.error.message).toContain('leave no tables behind');
    }
  });
});

// ---------------------------------------------------------------------------
// Reading a project from disk
// ---------------------------------------------------------------------------

describe('reading a Laravel project directory', () => {
  const created: string[] = [];

  afterEach(() => {
    for (const directory of created.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  function project(files: Record<string, string>): string {
    const root: string = mkdtempSync(join(tmpdir(), 'ormbridge-laravel-'));
    created.push(root);
    for (const [path, text] of Object.entries(files)) {
      const target: string = join(root, path);
      mkdirSync(join(target, '..'), { recursive: true });
      writeFileSync(target, text);
    }
    return root;
  }

  const POSTS: string = migration(
    `Schema::create('posts', function (Blueprint $table) { $table->id(); });`
  );

  it('reads database/migrations and app from a project root and skips vendor, storage, tests and caches', async () => {
    const root: string = project({
      'database/migrations/2024_01_01_000000_create_posts.php': POSTS,
      'app/Models/Post.php': modelClass('Post', ''),
      'app/Http/Controllers/PostController.php':
        '<?php class PostController {}',
      'app/Console/PostTest.php': '<?php class PostTest {}',
      'vendor/laravel/framework/Model.php': '<?php class Model {}',
      'storage/framework/views/compiled.php': '<?php // compiled',
      'tests/Feature/PostTest.php': '<?php class T {}',
      'bootstrap/cache/services.php': '<?php return [];',
      'bootstrap/app.php': '<?php return null;',
      'node_modules/pkg/index.php': '<?php // nope',
      'routes/web.php': '<?php // routes',
      'database/seeders/DatabaseSeeder.php': '<?php class DatabaseSeeder {}',
    });
    const result = expectOk(
      await runConversion({
        ...DEFAULT_OPTIONS,
        from: 'laravel',
        to: 'prisma',
        inputs: [root],
      })
    );
    expect(
      result.inputFiles.map((file: string) =>
        relative(root, file).split('\\').join('/')
      )
    ).toEqual([
      'database/migrations/2024_01_01_000000_create_posts.php',
      'app/Http/Controllers/PostController.php',
      'app/Models/Post.php',
    ]);
    expect(result.modelCount).toBe(1);
    expect(result.output).toContain('model Post');
  });

  it('reads directories passed on their own, including a migrations folder', async () => {
    const root: string = project({
      'db/migrations/2024_01_01_000000_create_posts.php': POSTS,
      'models/Post.php': modelClass('Post', ''),
    });
    const result = expectOk(
      await runConversion({
        ...DEFAULT_OPTIONS,
        from: 'laravel',
        to: 'prisma',
        inputs: [join(root, 'db', 'migrations'), join(root, 'models')],
      })
    );
    expect(result.inputFiles).toHaveLength(2);
    expect(result.modelCount).toBe(1);
  });

  it('reports what it looked for when the folder has no PHP files', async () => {
    const root: string = project({ 'README.md': 'hello' });
    const result = await runConversion({
      ...DEFAULT_OPTIONS,
      from: 'laravel',
      to: 'prisma',
      inputs: [root],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('NO_INPUT_FILES');
      expect(result.error.message).toContain('migration and model files');
    }
  });
});

// ---------------------------------------------------------------------------
// The fixture against real PHP and real Laravel
// ---------------------------------------------------------------------------

function phpAvailable(): boolean {
  const probe: SpawnSyncReturns<string> = spawnSync('php', ['-v'], {
    encoding: 'utf8',
  });
  return probe.status === 0;
}

const hasPhp: boolean = phpAvailable();
const laravelDirectory: string | undefined = process.env.LARAVEL_DIR;
const replayScript: string = fileURLToPath(
  new URL('./tools/replay-laravel-migrations.php', import.meta.url)
);
const migrationsDirectory: string = fileURLToPath(
  new URL('./fixtures/laravel/database/migrations', import.meta.url)
);

interface DatabaseColumn {
  name: string;
  notNull: boolean;
  primaryKeyPosition: number;
}

interface DatabaseTable {
  columns: DatabaseColumn[];
  foreignKeys: {
    column: string;
    table: string;
    references: string;
    onDelete: string;
  }[];
  indexes: {
    name: string;
    unique: boolean;
    origin: string;
    columns: string[];
  }[];
}

describe('laravel fixture: real PHP and Illuminate', () => {
  it
    .skipIf(!hasPhp)
    .each(loadCanonicalSources('laravel').map((source) => source.path))(
    '%s passes php -l',
    (path: string) => {
      const lint: SpawnSyncReturns<string> = spawnSync('php', ['-l', path], {
        encoding: 'utf8',
      });
      expect(lint.status, lint.stdout + lint.stderr).toBe(0);
    }
  );

  // Set LARAVEL_DIR to a directory where `composer require illuminate/database
  // illuminate/events illuminate/container` has been run (outside this repository).
  // The migrations are then replayed by Laravel itself against SQLite and the
  // resulting tables are compared with the parser's result.
  it.skipIf(!hasPhp || laravelDirectory === undefined)(
    'rebuilds the same schema as Laravel migrating a SQLite database',
    async () => {
      const run: SpawnSyncReturns<string> = spawnSync(
        'php',
        [replayScript, migrationsDirectory],
        {
          encoding: 'utf8',
          env: { ...process.env, LARAVEL_DIR: laravelDirectory ?? '' },
        }
      );
      expect(run.status, run.stderr).toBe(0);
      const database: Record<string, DatabaseTable> = JSON.parse(run.stdout);
      const schema: IrSchema = expectOk(
        await parseLaravel(loadCanonicalSources('laravel'), {
          appLabel: 'blog',
        })
      );

      // Tables: the parser's models plus the pivot table folded into a many-to-many field.
      expect(Object.keys(database).sort()).toEqual(
        [
          ...schema.models.map((m: IrModel) => m.tableName),
          'blog_post_tags',
        ].sort()
      );

      const tableOf = (modelName: string): string =>
        model(schema, modelName).tableName;
      for (const irModel of schema.models) {
        const table: DatabaseTable | undefined = database[irModel.tableName];
        expect(table, irModel.tableName).toBeDefined();
        if (table === undefined) {
          continue;
        }
        const label: string = irModel.tableName;
        // Columns: fields plus foreign key columns of relations.
        const irColumns: string[] = [
          ...irModel.fields.map((f: IrField) => f.columnName),
          ...irModel.relations
            .filter((r: IrRelation) => r.kind !== 'manyToMany')
            .map((r: IrRelation) => r.columnName),
        ].sort();
        expect(
          table.columns.map((c: DatabaseColumn) => c.name).sort(),
          label
        ).toEqual(irColumns);
        // Nullability.
        for (const column of table.columns) {
          const irField: IrField | undefined = irModel.fields.find(
            (f: IrField) => f.columnName === column.name
          );
          const irRelation: IrRelation | undefined = irModel.relations.find(
            (r: IrRelation) => r.columnName === column.name
          );
          const nullable: boolean | undefined =
            irField?.isNullable ?? irRelation?.isNullable;
          if (column.primaryKeyPosition === 0) {
            expect(!column.notNull, `${label}.${column.name}`).toBe(nullable);
          }
        }
        // Primary key.
        const keyColumns: string[] = table.columns
          .filter((c: DatabaseColumn) => c.primaryKeyPosition > 0)
          .map((c: DatabaseColumn) => c.name);
        expect(
          irModel.fields
            .filter((f: IrField) => f.isPrimaryKey)
            .map((f: IrField) => f.columnName),
          label
        ).toEqual(keyColumns);
        // Foreign keys.
        const expectedKeys: string[] = irModel.relations
          .filter((r: IrRelation) => r.kind !== 'manyToMany')
          .map(
            (r: IrRelation) =>
              `${r.columnName}->${tableOf(r.targetModel)}:${
                {
                  cascade: 'CASCADE',
                  setNull: 'SET NULL',
                  restrict: 'RESTRICT',
                  noAction: 'NO ACTION',
                  setDefault: 'SET DEFAULT',
                }[r.onDelete]
              }`
          )
          .sort();
        expect(
          table.foreignKeys
            .map((k) => `${k.column}->${k.table}:${k.onDelete}`)
            .sort(),
          label
        ).toEqual(expectedKeys);
        // Indexes (the implicit index of a primary key is not listed).
        const columnOf = (name: string): string =>
          irModel.fields.find((f: IrField) => f.name === name)?.columnName ??
          irModel.relations.find((r: IrRelation) => r.name === name)
            ?.columnName ??
          name;
        const expectedIndexes: string[] = [
          ...irModel.fields
            .filter((f: IrField) => f.isUnique)
            .map((f: IrField) => `unique ${f.columnName}`),
          ...irModel.relations
            .filter(
              (r: IrRelation) =>
                r.kind === 'oneToOne' && r.isPrimaryKey !== true
            )
            .map((r: IrRelation) => `unique ${r.columnName}`),
          ...irModel.indexes.map(
            (i: IrIndex) =>
              `${i.isUnique ? 'unique' : 'index'} ${i.fields.map(columnOf).join(',')}`
          ),
        ].sort();
        expect(
          table.indexes
            .filter(
              (i) =>
                i.origin === 'c' ||
                (i.origin === 'u' && !i.name.startsWith('sqlite_autoindex'))
            )
            .map(
              (i) => `${i.unique ? 'unique' : 'index'} ${i.columns.join(',')}`
            )
            .sort(),
          label
        ).toEqual(expectedIndexes);
      }

      // The pivot table: both keys cascade.
      const pivot: DatabaseTable | undefined = database['blog_post_tags'];
      expect(
        pivot?.foreignKeys
          .map((k) => `${k.column}->${k.table}:${k.onDelete}`)
          .sort()
      ).toEqual(['post_id->blog_post:CASCADE', 'tag_id->blog_tag:CASCADE']);
    }
  );
});
