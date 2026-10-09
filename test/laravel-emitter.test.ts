import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { emitLaravel } from '../src/emitters/laravel.js';
import { getFormat, type FormatOptions } from '../src/formats.js';
import type { MultiFileEmitOutput } from '../src/formats.js';
import type {
  IrEnum,
  IrField,
  IrModel,
  IrRelation,
  IrSchema,
} from '../src/ir.js';
import { convertCanonical } from './harness.js';
import { DEFAULT_OPTIONS } from './helpers.js';

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
  overrides: Partial<{
    provider: 'postgresql' | 'mysql' | 'sqlite' | 'sqlserver' | 'mongodb';
    naming: 'preserve' | 'normalize';
    namespace: string;
  }> = {}
): MultiFileEmitOutput {
  return emitLaravel(schema, { provider: 'postgresql', ...overrides });
}

function modelFile(output: MultiFileEmitOutput, name: string): string {
  const text: string | undefined = output.files[`app/Models/${name}.php`];
  if (text === undefined) {
    throw new Error(
      `No model ${name}. Files: ${Object.keys(output.files).join(', ')}`
    );
  }
  return text;
}

/** The migration whose file name contains `fragment`. */
function migration(output: MultiFileEmitOutput, fragment: string): string {
  const path: string | undefined = Object.keys(output.files).find(
    (candidate: string) =>
      candidate.startsWith('database/migrations/') &&
      candidate.includes(fragment)
  );
  if (path === undefined) {
    throw new Error(
      `No migration containing ${fragment}. Files: ${Object.keys(output.files).join(', ')}`
    );
  }
  return output.files[path] ?? '';
}

function migrationNames(output: MultiFileEmitOutput): string[] {
  return Object.keys(output.files)
    .filter((path: string) => path.startsWith('database/migrations/'))
    .sort();
}

const STATUS: IrEnum = {
  name: 'Status',
  values: [
    { name: 'DRAFT', dbValue: 'draft', label: 'Draft' },
    { name: 'LIVE', dbValue: 'live' },
  ],
};

describe('laravel emitter: files and namespaces', () => {
  it('writes one migration per table, one model per model and one enum per enum', () => {
    const output: MultiFileEmitOutput = emit(
      schemaOf([model('Post'), model('Tag')], [STATUS])
    );
    expect(Object.keys(output.files).sort()).toEqual([
      'app/Enums/Status.php',
      'app/Models/Post.php',
      'app/Models/Tag.php',
      'database/migrations/2024_01_01_000001_create_post_table.php',
      'database/migrations/2024_01_01_000002_create_tag_table.php',
    ]);
    expect(output.text).toBeUndefined();
  });

  it('writes anonymous-class migrations with up() and down()', () => {
    const output: MultiFileEmitOutput = emit(schemaOf([model('Post')]));
    expect(migration(output, 'create_post_table')).toBe(
      [
        '<?php',
        '',
        'declare(strict_types=1);',
        '',
        'use Illuminate\\Database\\Migrations\\Migration;',
        'use Illuminate\\Database\\Schema\\Blueprint;',
        'use Illuminate\\Support\\Facades\\Schema;',
        '',
        'return new class extends Migration',
        '{',
        '    public function up(): void',
        '    {',
        "        Schema::create('post', function (Blueprint $table): void {",
        '            $table->id();',
        '        });',
        '    }',
        '',
        '    public function down(): void',
        '    {',
        "        Schema::dropIfExists('post');",
        '    }',
        '};',
        '',
      ].join('\n')
    );
  });

  it('writes backed enums with their stored values', () => {
    const output: MultiFileEmitOutput = emit(schemaOf([model('A')], [STATUS]));
    expect(output.files['app/Enums/Status.php']).toBe(
      [
        '<?php',
        '',
        'declare(strict_types=1);',
        '',
        'namespace App\\Enums;',
        '',
        'enum Status: string',
        '{',
        "    case DRAFT = 'draft';",
        "    case LIVE = 'live';",
        '}',
        '',
      ].join('\n')
    );
  });

  it('maps a custom namespace to folders below app/ and a sibling Enums namespace', () => {
    const output: MultiFileEmitOutput = emit(schemaOf([model('A')], [STATUS]), {
      namespace: 'Acme\\Blog\\Models',
    });
    expect(
      Object.keys(output.files).filter((path: string) =>
        path.startsWith('app/')
      )
    ).toEqual(['app/Blog/Enums/Status.php', 'app/Blog/Models/A.php']);
    expect(output.files['app/Blog/Models/A.php']).toContain(
      'namespace Acme\\Blog\\Models;'
    );
    expect(output.files['app/Blog/Enums/Status.php']).toContain(
      'namespace Acme\\Blog\\Enums;'
    );
  });

  it('puts enums in an Enums child namespace when the namespace does not end in Models', () => {
    const output: MultiFileEmitOutput = emit(schemaOf([model('A')], [STATUS]), {
      namespace: 'Shop\\Domain',
    });
    expect(Object.keys(output.files)).toContain('app/Domain/Enums/Status.php');
  });

  it('falls back to the default namespace with a warning when the namespace is invalid', () => {
    const output: MultiFileEmitOutput = emit(schemaOf([model('A')]), {
      namespace: 'not a namespace!',
    });
    expect(Object.keys(output.files)).toContain('app/Models/A.php');
    expect(output.warnings.join('\n')).toContain(
      'The namespace "not a namespace!" is not a valid PHP namespace'
    );
  });

  it('is registered as the "laravel" format that does not claim .php', () => {
    const adapter = getFormat('laravel');
    expect(adapter.ok).toBe(true);
    if (adapter.ok) {
      expect(adapter.value.extensions).toEqual([]);
      expect(adapter.value.emit).toBeDefined();
    }
  });

  it('rejects an invalid namespace through the format adapter', () => {
    const adapter = getFormat('laravel');
    if (!adapter.ok || adapter.value.emit === undefined) {
      throw new Error('laravel format missing');
    }
    const options: FormatOptions = { ...DEFAULT_OPTIONS, namespace: '1Bad' };
    const result = adapter.value.emit(schemaOf([model('A')]), options);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('INVALID_OPTION');
    }
  });

  it('accepts --namespace through the format adapter', () => {
    const adapter = getFormat('laravel');
    if (!adapter.ok || adapter.value.emit === undefined) {
      throw new Error('laravel format missing');
    }
    const options: FormatOptions = {
      ...DEFAULT_OPTIONS,
      namespace: '\\Shop\\Models\\',
    };
    const result = adapter.value.emit(schemaOf([model('A')]), options);
    expect(result.ok && Object.keys(result.value.files ?? {})).toContain(
      'app/Models/A.php'
    );
  });
});

describe('laravel emitter: column types', () => {
  const fields: IrField[] = [
    idField(),
    field('title', { maxLength: 200 }),
    field('plain'),
    field('body', { type: 'text', isNullable: true }),
    field('count', { type: 'int', default: { kind: 'literal', value: 3 } }),
    field('big', { type: 'bigInt' }),
    field('ratio', { type: 'float' }),
    field('price', { type: 'decimal', maxDigits: 9, decimalPlaces: 2 }),
    field('active', {
      type: 'boolean',
      default: { kind: 'literal', value: true },
    }),
    field('seen', { type: 'dateTime', default: { kind: 'now' } }),
    field('day', {
      type: 'date',
      default: { kind: 'literal', value: '2020-01-02' },
    }),
    field('at', { type: 'time' }),
    field('token', { type: 'uuid', isUnique: true }),
    field('meta', {
      type: 'json',
      default: { kind: 'literal', value: '{}' },
    }),
    field('blob', { type: 'bytes' }),
    field('addr', { type: 'ipAddress' }),
    field('state', {
      enumName: 'Status',
      default: { kind: 'enumValue', value: 'DRAFT' },
    }),
    field('small', {
      type: 'int',
      nativeType: { name: 'UnsignedInt', args: [] },
    }),
    field('code', { nativeType: { name: 'Char', args: ['3'] } }),
  ];
  const output: MultiFileEmitOutput = emit(
    schemaOf([model('Thing', { fields })], [STATUS])
  );
  const text: string = migration(output, 'create_thing_table');

  it.each([
    '$table->id();',
    "$table->string('title', 200);",
    "$table->string('plain');",
    "$table->text('body')->nullable();",
    "$table->integer('count')->default(3);",
    "$table->bigInteger('big');",
    "$table->double('ratio');",
    "$table->decimal('price', 9, 2);",
    "$table->boolean('active')->default(true);",
    "$table->dateTime('seen')->useCurrent();",
    "$table->date('day')->default('2020-01-02');",
    "$table->time('at');",
    "$table->uuid('token')->unique();",
    "$table->jsonb('meta')->default('{}');",
    "$table->binary('blob');",
    "$table->ipAddress('addr');",
    "$table->enum('state', ['draft', 'live'])->default('draft');",
    "$table->unsignedInteger('small');",
    "$table->char('code', 3);",
  ])('writes %s', (line: string) => {
    expect(text).toContain(`            ${line}`);
  });

  it('uses json instead of jsonb outside PostgreSQL and a parenthesized default on MySQL', () => {
    const mysql: MultiFileEmitOutput = emit(
      schemaOf([model('Thing', { fields })], [STATUS]),
      { provider: 'mysql' }
    );
    const mysqlText: string = migration(mysql, 'create_thing_table');
    expect(mysqlText).toContain(
      `$table->json('meta')->default(new Expression('(\\'{}\\')'));`
    );
    expect(mysqlText).toContain('use Illuminate\\Database\\Query\\Expression;');
    expect(
      migration(
        emit(schemaOf([model('Thing', { fields })], [STATUS]), {
          provider: 'sqlite',
        }),
        'create_thing_table'
      )
    ).toContain("$table->json('meta')->default('{}');");
  });

  it('casts enums, booleans, arrays, dates and decimals on the model', () => {
    const thing: string = modelFile(output, 'Thing');
    expect(thing).toContain('use App\\Enums\\Status;');
    expect(thing).toContain("'state' => Status::class,");
    expect(thing).toContain("'price' => 'decimal:2',");
    expect(thing).toContain("'active' => 'boolean',");
    expect(thing).toContain("'seen' => 'datetime',");
    expect(thing).toContain("'meta' => 'array',");
    expect(thing).toContain("'ratio' => 'float',");
  });

  it('lists every writable column in $fillable but not the auto-increment key', () => {
    const thing: string = modelFile(output, 'Thing');
    expect(thing).toContain("        'title',");
    expect(thing).not.toContain("        'id',");
  });

  it('warns for arrays, durations, hstore, ranges and generated columns', () => {
    const warned: MultiFileEmitOutput = emit(
      schemaOf([
        model('W', {
          fields: [
            idField(),
            field('tags', { arrayDepth: 1 }),
            field('lasts', { type: 'duration' }),
            field('attrs', { type: 'hstore' }),
            field('span', { type: 'range', rangeOf: 'int' }),
            field('total', {
              type: 'int',
              generated: { expression: 'F("a") + F("b")', isStored: true },
            }),
          ],
        }),
      ])
    );
    const warnings: string = warned.warnings.join('\n');
    expect(warnings).toContain('W.tags: Laravel has no array column type');
    expect(warnings).toContain('W.lasts: Laravel has no interval column type');
    expect(warnings).toContain('W.attrs: Laravel has no hstore type');
    expect(warnings).toContain('W.span: Laravel has no range column type');
    expect(warnings).toContain('W.total: the generated column expression');
  });

  it('warns about Prisma-only constructs the way the other emitters do', () => {
    const warned: MultiFileEmitOutput = emit(
      schemaOf([
        model('V', { isView: true }),
        model('C', {
          fields: [
            idField(),
            field('a', { type: 'int' }),
            field('b', { type: 'int' }),
          ],
          compositeForeignKeys: [
            {
              name: 'link',
              targetModel: 'V',
              fields: ['a', 'b'],
              references: ['id', 'id'],
              kind: 'foreignKey',
              isNullable: false,
              onDelete: 'cascade',
            },
          ],
        }),
      ])
    );
    const warnings: string = warned.warnings.join('\n');
    expect(warnings).toContain('V: this is a database view');
    expect(warnings).toContain('C.link: the composite foreign key');
  });
});

describe('laravel emitter: keys', () => {
  it('writes timestamps() and softDeletes() for the Laravel pair and deleted_at', () => {
    const output: MultiFileEmitOutput = emit(
      schemaOf([
        model('Post', {
          fields: [
            idField(),
            field('created_at', { type: 'dateTime', default: { kind: 'now' } }),
            field('updated_at', { type: 'dateTime', isAutoUpdated: true }),
            field('deleted_at', { type: 'dateTime', isNullable: true }),
          ],
        }),
      ])
    );
    const text: string = migration(output, 'create_post_table');
    expect(text).toContain('$table->timestamps();');
    expect(text).toContain('$table->softDeletes();');
    expect(text).not.toContain("'created_at'");
    const post: string = modelFile(output, 'Post');
    expect(post).toContain('use Illuminate\\Database\\Eloquent\\SoftDeletes;');
    expect(post).toContain('    use SoftDeletes;');
    expect(post).not.toContain('$timestamps');
  });

  it('turns timestamps off when the pair is incomplete', () => {
    const output: MultiFileEmitOutput = emit(
      schemaOf([
        model('Post', {
          fields: [
            idField(),
            field('created_at', { type: 'dateTime', default: { kind: 'now' } }),
          ],
        }),
      ])
    );
    expect(modelFile(output, 'Post')).toContain('public $timestamps = false;');
    expect(migration(output, 'create_post_table')).toContain(
      "$table->dateTime('created_at')->useCurrent();"
    );
  });

  it('writes a UUID key with HasUuids and foreignUuid references', () => {
    const output: MultiFileEmitOutput = emit(
      schemaOf([
        model('Account', {
          tableName: 'accounts',
          fields: [
            field('id', { type: 'uuid', isPrimaryKey: true }),
            field('code', {
              type: 'uuid',
              default: { kind: 'uuid' },
              isUnique: true,
            }),
          ],
        }),
        model('Project', {
          tableName: 'projects',
          relations: [relation('account', 'Account')],
        }),
      ])
    );
    expect(migration(output, 'create_accounts_table')).toContain(
      "$table->uuid('id')->primary();"
    );
    expect(migration(output, 'create_projects_table')).toContain(
      "$table->foreignUuid('account_id')->constrained('accounts')->cascadeOnDelete();"
    );
    const account: string = modelFile(output, 'Account');
    expect(account).toContain(
      'use Illuminate\\Database\\Eloquent\\Concerns\\HasUuids;'
    );
    expect(account).toContain('    use HasUuids;');
    expect(account).toContain("return ['id', 'code'];");
    expect(account).not.toContain('$keyType');
  });

  it('writes a ULID key with HasUlids', () => {
    const output: MultiFileEmitOutput = emit(
      schemaOf([
        model('Ticket', {
          tableName: 'tickets',
          fields: [
            field('id', {
              isPrimaryKey: true,
              default: { kind: 'clientGenerated', generator: 'ulid' },
            }),
          ],
        }),
        model('Note', {
          tableName: 'notes',
          relations: [relation('ticket', 'Ticket')],
        }),
      ])
    );
    expect(migration(output, 'create_tickets_table')).toContain(
      "$table->ulid('id')->primary();"
    );
    expect(migration(output, 'create_notes_table')).toContain(
      "$table->foreignUlid('ticket_id')->constrained('tickets')->cascadeOnDelete();"
    );
    expect(modelFile(output, 'Ticket')).toContain('    use HasUlids;');
    expect(output.warnings.join('\n')).not.toContain('Ticket.id');
  });

  it('writes a string key with $primaryKey, $keyType and $incrementing', () => {
    const output: MultiFileEmitOutput = emit(
      schemaOf([
        model('Country', {
          tableName: 'countries',
          fields: [field('code', { isPrimaryKey: true, maxLength: 2 })],
        }),
        model('Region', {
          tableName: 'regions',
          relations: [
            relation('country', 'Country', { columnName: 'country_code' }),
          ],
        }),
      ])
    );
    expect(migration(output, 'create_countries_table')).toContain(
      "$table->string('code', 2)->primary();"
    );
    const country: string = modelFile(output, 'Country');
    expect(country).toContain("protected $primaryKey = 'code';");
    expect(country).toContain("protected $keyType = 'string';");
    expect(country).toContain('public $incrementing = false;');
    const regions: string = migration(output, 'create_regions_table');
    expect(regions).toContain("$table->string('country_code', 2);");
    expect(regions).toContain(
      "$table->foreign('country_code')->references('code')->on('countries')->cascadeOnDelete();"
    );
    // `country_code` is what Eloquent derives from the method name and the `code` key.
    expect(modelFile(output, 'Region')).toContain(
      'return $this->belongsTo(Country::class);'
    );
    expect(modelFile(output, 'Country')).toContain(
      'return $this->hasMany(Region::class);'
    );
  });

  it('writes a non-id auto-increment key', () => {
    const output: MultiFileEmitOutput = emit(
      schemaOf([
        model('Legacy', {
          tableName: 'legacy',
          fields: [
            field('legacy_id', {
              type: 'int',
              isPrimaryKey: true,
              default: { kind: 'autoIncrement' },
            }),
          ],
        }),
      ])
    );
    expect(migration(output, 'create_legacy_table')).toContain(
      "$table->bigIncrements('legacy_id');"
    );
    expect(modelFile(output, 'Legacy')).toContain(
      "protected $primaryKey = 'legacy_id';"
    );
  });

  it('writes composite keys with primary([...]) and warns that Eloquent has none', () => {
    const output: MultiFileEmitOutput = emit(
      schemaOf([
        model('Order'),
        model('Line', {
          tableName: 'lines',
          fields: [field('no', { type: 'int' })],
          relations: [relation('order', 'Order', { isPrimaryKey: true })],
          compositePrimaryKey: ['no', 'order'],
        }),
      ])
    );
    const text: string = migration(output, 'create_lines_table');
    expect(text).toContain("$table->primary(['no', 'order_id']);");
    expect(output.warnings.join('\n')).toContain(
      'Line: Eloquent does not support composite primary keys'
    );
  });

  it('writes a relation that is the primary key as a primary foreign key', () => {
    const output: MultiFileEmitOutput = emit(
      schemaOf([
        model('Item'),
        model('Detail', {
          tableName: 'details',
          fields: [field('note', { isNullable: true })],
          relations: [
            relation('item_ptr', 'Item', {
              kind: 'oneToOne',
              isPrimaryKey: true,
            }),
          ],
        }),
      ])
    );
    expect(migration(output, 'create_details_table')).toContain(
      "$table->foreignId('item_ptr_id')->primary()->constrained('item')->cascadeOnDelete();"
    );
    const detail: string = modelFile(output, 'Detail');
    expect(detail).toContain("protected $primaryKey = 'item_ptr_id';");
    expect(detail).toContain('public $incrementing = false;');
  });

  it('warns about a model without a primary key', () => {
    const output: MultiFileEmitOutput = emit(
      schemaOf([model('Log', { fields: [field('line')] })])
    );
    expect(output.warnings.join('\n')).toContain(
      'Log: the model has no primary key'
    );
    expect(modelFile(output, 'Log')).toContain('protected $primaryKey = null;');
  });
});

describe('laravel emitter: foreign keys and ordering', () => {
  it('maps every referential action to the Laravel helper', () => {
    const output: MultiFileEmitOutput = emit(
      schemaOf([
        model('Parent'),
        model('Child', {
          relations: [
            relation('a', 'Parent', { onDelete: 'cascade' }),
            relation('b', 'Parent', { onDelete: 'restrict' }),
            relation('c', 'Parent', { onDelete: 'setNull', isNullable: true }),
            relation('d', 'Parent', { onDelete: 'noAction' }),
            relation('e', 'Parent', { onDelete: 'setDefault' }),
            relation('f', 'Parent', {
              onDelete: 'cascade',
              onUpdate: 'restrict',
            }),
            relation('g', 'Parent', {
              onDelete: 'cascade',
              onUpdate: 'cascade',
            }),
          ],
        }),
      ])
    );
    const text: string = migration(output, 'create_child_table');
    expect(text).toContain("->constrained('parent')->cascadeOnDelete();");
    expect(text).toContain("->constrained('parent')->restrictOnDelete();");
    expect(text).toContain(
      "->nullable()->constrained('parent')->nullOnDelete();"
    );
    expect(text).toContain("$table->foreignId('d_id')->constrained('parent');");
    expect(text).toContain("->onDelete('set default');");
    expect(text).toContain('->cascadeOnDelete()->restrictOnUpdate();');
    expect(text).toContain('->cascadeOnDelete()->cascadeOnUpdate();');
    expect(output.warnings.join('\n')).not.toContain('onUpdate action');
  });

  it('warns about SET NULL on a required relation', () => {
    const output: MultiFileEmitOutput = emit(
      schemaOf([
        model('P'),
        model('C', {
          relations: [relation('p', 'P', { onDelete: 'setNull' })],
        }),
      ])
    );
    expect(output.warnings.join('\n')).toContain(
      'C.p: onDelete SET NULL on a required relation'
    );
  });

  it('creates referenced tables first, whatever the model order', () => {
    const output: MultiFileEmitOutput = emit(
      schemaOf([
        model('Comment', {
          relations: [relation('post', 'Post'), relation('author', 'User')],
        }),
        model('Post', { relations: [relation('author', 'User')] }),
        model('User'),
      ])
    );
    expect(migrationNames(output)).toEqual([
      'database/migrations/2024_01_01_000001_create_user_table.php',
      'database/migrations/2024_01_01_000002_create_post_table.php',
      'database/migrations/2024_01_01_000003_create_comment_table.php',
    ]);
  });

  it('writes self references inline', () => {
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
    expect(migrationNames(output)).toHaveLength(1);
    expect(migration(output, 'create_category_table')).toContain(
      "->constrained('category')"
    );
    const category: string = modelFile(output, 'Category');
    expect(category).toContain('return $this->belongsTo(Category::class);');
    expect(category).toContain(
      "return $this->hasMany(Category::class, 'parent_id');"
    );
  });

  it('breaks a dependency cycle with a later add_foreign_keys migration', () => {
    const output: MultiFileEmitOutput = emit(
      schemaOf([
        model('Org', {
          relations: [
            relation('primary_team', 'Team', {
              isNullable: true,
              onDelete: 'setNull',
            }),
          ],
        }),
        model('Team', { relations: [relation('org', 'Org')] }),
      ])
    );
    expect(migrationNames(output)).toEqual([
      'database/migrations/2024_01_01_000001_create_org_table.php',
      'database/migrations/2024_01_01_000002_create_team_table.php',
      'database/migrations/2024_01_01_000003_add_foreign_keys_to_org_table.php',
    ]);
    const org: string = migration(output, 'create_org_table');
    expect(org).toContain("$table->foreignId('primary_team_id')->nullable();");
    expect(org).not.toContain('constrained');
    expect(migration(output, 'create_team_table')).toContain(
      "->constrained('org')"
    );
    const later: string = migration(output, 'add_foreign_keys_to_org_table');
    expect(later).toContain("Schema::table('org'");
    expect(later).toContain(
      "$table->foreign('primary_team_id')->references('id')->on('team')->nullOnDelete();"
    );
    expect(later).toContain("$table->dropForeign(['primary_team_id']);");
  });

  it('wraps long column chains one call per line', () => {
    const output: MultiFileEmitOutput = emit(
      schemaOf([
        model('A', { tableName: 'alpha_table_with_a_long_name' }),
        model('B', {
          relations: [
            relation('alpha_with_a_rather_long_relation_name', 'A', {
              isNullable: true,
              onDelete: 'setNull',
            }),
          ],
        }),
      ])
    );
    expect(migration(output, 'create_b_table')).toContain(
      [
        "            $table->foreignId('alpha_with_a_rather_long_relation_name_id')",
        '                ->nullable()',
        "                ->constrained('alpha_table_with_a_long_name')",
        '                ->nullOnDelete();',
      ].join('\n')
    );
  });

  it('skips relations to unknown targets and to targets without a single key', () => {
    const output: MultiFileEmitOutput = emit(
      schemaOf([
        model('Pair', {
          fields: [field('a', { type: 'int' }), field('b', { type: 'int' })],
          compositePrimaryKey: ['a', 'b'],
        }),
        model('Ref', {
          relations: [
            relation('pair', 'Pair'),
            relation('ghost', 'Ghost'),
            relation('others', 'Pair', { kind: 'manyToMany' }),
          ],
        }),
      ])
    );
    const warnings: string = output.warnings.join('\n');
    expect(warnings).toContain(
      'Ref.pair: target model "Pair" has no single-column primary key'
    );
    expect(warnings).toContain(
      'Ref.ghost: target model "Ghost" does not exist'
    );
    expect(warnings).toContain(
      'Ref.others: Pair has no single-column primary key'
    );
    expect(migration(output, 'create_ref_table')).not.toContain('constrained');
  });

  it('references a non-primary column named by toField', () => {
    const output: MultiFileEmitOutput = emit(
      schemaOf([
        model('Customer', {
          fields: [idField(), field('slug', { isUnique: true, maxLength: 40 })],
        }),
        model('Order', {
          relations: [
            relation('customer', 'Customer', {
              columnName: 'customer_slug',
              toField: 'slug',
            }),
          ],
        }),
      ])
    );
    expect(migration(output, 'create_order_table')).toContain(
      "$table->foreign('customer_slug')->references('slug')->on('customer')->cascadeOnDelete();"
    );
    expect(modelFile(output, 'Order')).toContain(
      "return $this->belongsTo(Customer::class, 'customer_slug', 'slug');"
    );
    expect(modelFile(output, 'Customer')).toContain(
      "return $this->hasMany(Order::class, 'customer_slug', 'slug');"
    );
  });

  it('writes composite and single-column indexes and unique constraints', () => {
    const output: MultiFileEmitOutput = emit(
      schemaOf([
        model('P'),
        model('C', {
          fields: [
            idField(),
            field('title'),
            field('slug', { isUnique: true }),
          ],
          relations: [relation('p', 'P')],
          indexes: [
            { fields: ['title'], isUnique: false },
            { fields: ['p', 'title'], isUnique: true },
            { fields: ['slug', 'title'], isUnique: false, name: 'c_idx' },
            { fields: ['nope'], isUnique: false },
          ],
        }),
      ])
    );
    const text: string = migration(output, 'create_c_table');
    expect(text).toContain("$table->string('slug')->unique();");
    expect(text).toContain("$table->index('title');");
    expect(text).toContain("$table->unique(['p_id', 'title']);");
    expect(text).toContain("$table->index(['slug', 'title'], 'c_idx');");
    expect(output.warnings.join('\n')).toContain(
      'C index (nope): "nope" is not a field or relation of the model'
    );
  });
});

describe('laravel emitter: relationship methods', () => {
  const schema: IrSchema = schemaOf([
    model('User', { tableName: 'users' }),
    model('Post', {
      tableName: 'posts',
      relations: [
        relation('author', 'User', { relatedName: 'posts' }),
        relation('editor', 'User', {
          isNullable: true,
          relatedName: 'edited_posts',
        }),
        relation('writer', 'User', { columnName: 'writer_user_id' }),
        relation('tags', 'Tag', { kind: 'manyToMany', relatedName: 'posts' }),
      ],
    }),
    model('Tag', { tableName: 'tags' }),
    model('Profile', {
      tableName: 'profiles',
      relations: [relation('user', 'User', { kind: 'oneToOne' })],
    }),
  ]);

  it('writes both sides of every relation with typed methods', () => {
    const output: MultiFileEmitOutput = emit(schema, { naming: 'normalize' });
    const post: string = modelFile(output, 'Post');
    expect(post).toContain('/** @return BelongsTo<User, $this> */');
    expect(post).toContain('public function author(): BelongsTo');
    expect(post).toContain('return $this->belongsTo(User::class);');
    expect(post).toContain(
      "return $this->belongsTo(User::class, 'writer_user_id');"
    );
    expect(post).toContain('public function tags(): BelongsToMany');
    expect(post).toContain('return $this->belongsToMany(Tag::class);');
    const user: string = modelFile(output, 'User');
    expect(user).toContain('public function posts(): HasMany');
    expect(user).toContain("return $this->hasMany(Post::class, 'author_id');");
    expect(user).toContain('public function editedPosts(): HasMany');
    expect(user).toContain('public function profile(): HasOne');
    expect(user).toContain('return $this->hasOne(Profile::class);');
    const tag: string = modelFile(output, 'Tag');
    expect(tag).toContain('public function posts(): BelongsToMany');
    expect(tag).toContain('return $this->belongsToMany(Post::class);');
  });

  it('adds a unique constraint for one-to-one relations', () => {
    const output: MultiFileEmitOutput = emit(schema);
    expect(migration(output, 'create_profiles_table')).toContain(
      "$table->foreignId('user_id')->unique()->constrained('users')->cascadeOnDelete();"
    );
  });

  it('names pivot tables after the sorted singular model names in normalize mode', () => {
    const output: MultiFileEmitOutput = emit(schema, { naming: 'normalize' });
    const text: string = migration(output, 'create_post_tag_table');
    expect(text).toContain("Schema::create('post_tag'");
    expect(text).toContain(
      "$table->foreignId('post_id')->constrained('posts')->cascadeOnDelete();"
    );
    expect(text).toContain(
      "$table->foreignId('tag_id')->constrained('tags')->cascadeOnDelete();"
    );
    expect(text).toContain("$table->primary(['post_id', 'tag_id']);");
  });

  it('keeps an explicit pivot table name in preserve mode and passes it to belongsToMany', () => {
    const output: MultiFileEmitOutput = emit(schema);
    expect(
      migrationNames(output).some((name) =>
        name.includes('create_posts_tags_table')
      )
    ).toBe(true);
    expect(modelFile(output, 'Post')).toContain(
      "return $this->belongsToMany(Tag::class, 'posts_tags', 'post_id', 'tag_id');"
    );
    expect(modelFile(output, 'Tag')).toContain(
      "return $this->belongsToMany(Post::class, 'posts_tags', 'tag_id', 'post_id');"
    );
  });

  it('writes a self-referencing many-to-many with from_ and to_ columns', () => {
    const output: MultiFileEmitOutput = emit(
      schemaOf([
        model('User', {
          tableName: 'users',
          relations: [
            relation('friends', 'User', {
              kind: 'manyToMany',
              relatedName: 'friend_of',
            }),
          ],
        }),
      ]),
      { naming: 'normalize' }
    );
    const pivot: string = migration(output, 'create_user_user_table');
    expect(pivot).toContain("$table->foreignId('from_user_id')");
    expect(pivot).toContain("$table->foreignId('to_user_id')");
    expect(modelFile(output, 'User')).toContain(
      "return $this->belongsToMany(User::class, 'user_user', 'from_user_id', 'to_user_id');"
    );
    expect(modelFile(output, 'User')).toContain(
      "return $this->belongsToMany(User::class, 'user_user', 'to_user_id', 'from_user_id');"
    );
  });

  it('does not create a second pivot when both models declare the relation', () => {
    const output: MultiFileEmitOutput = emit(
      schemaOf([
        model('Post', {
          relations: [
            relation('tags', 'Tag', {
              kind: 'manyToMany',
              relatedName: 'posts',
            }),
          ],
        }),
        model('Tag', {
          relations: [
            relation('posts', 'Post', {
              kind: 'manyToMany',
              relatedName: 'tags',
            }),
          ],
        }),
      ]),
      { naming: 'normalize' }
    );
    expect(
      migrationNames(output).filter((name) => name.includes('post_tag'))
    ).toHaveLength(1);
    expect(modelFile(output, 'Post').match(/function tags\(/g)).toHaveLength(1);
    expect(modelFile(output, 'Tag').match(/function posts\(/g)).toHaveLength(1);
  });

  it('renames a relationship method that clashes with a column or Eloquent method', () => {
    const output: MultiFileEmitOutput = emit(
      schemaOf([
        model('User'),
        model('Post', {
          fields: [idField(), field('author')],
          relations: [
            relation('author', 'User'),
            relation('save', 'User', { columnName: 'save_id' }),
          ],
        }),
      ])
    );
    const warnings: string = output.warnings.join('\n');
    expect(warnings).toContain('Post.author: "author" clashes');
    expect(warnings).toContain('Post.save: "save" clashes');
    const post: string = modelFile(output, 'Post');
    expect(post).toContain('public function authorRelation(): BelongsTo');
    expect(post).toContain('public function saveRelation(): BelongsTo');
  });
});

describe('laravel emitter: naming modes', () => {
  const schema: IrSchema = schemaOf([
    model('BlogPost', {
      tableName: 'blog_blogpost',
      fields: [idField(), field('Title', { columnName: 'Title' })],
    }),
    model('Category', { tableName: 'blog_category' }),
    model('Person'),
  ]);

  it('preserve keeps table and column names and sets $table', () => {
    const output: MultiFileEmitOutput = emit(schema);
    expect(migrationNames(output)[0]).toContain('create_blog_blogpost_table');
    expect(migration(output, 'create_blog_blogpost_table')).toContain(
      "$table->string('Title');"
    );
    expect(modelFile(output, 'BlogPost')).toContain(
      "protected $table = 'blog_blogpost';"
    );
  });

  it('normalize uses plural snake_case tables, snake_case columns and timestamps without $table', () => {
    const output: MultiFileEmitOutput = emit(schema, { naming: 'normalize' });
    expect(migrationNames(output).join('\n')).toContain(
      'create_blog_posts_table'
    );
    expect(migration(output, 'create_blog_posts_table')).toContain(
      "$table->string('title');"
    );
    expect(migration(output, 'create_blog_posts_table')).toContain(
      '$table->timestamps();'
    );
    expect(modelFile(output, 'BlogPost')).not.toContain('$table =');
    expect(modelFile(output, 'Category')).not.toContain('$table =');
    expect(migrationNames(output).join('\n')).toContain(
      'create_categories_table'
    );
  });

  it('normalize writes $table where the inflector might disagree with the guess', () => {
    const output: MultiFileEmitOutput = emit(schema, { naming: 'normalize' });
    // "person" has an irregular plural, which the emitter knows; an "-is" word does not.
    expect(migrationNames(output).join('\n')).toContain('create_people_table');
    expect(modelFile(output, 'Person')).not.toContain('$table =');
    const odd: MultiFileEmitOutput = emit(schemaOf([model('Axis')]), {
      naming: 'normalize',
    });
    expect(modelFile(odd, 'Axis')).toContain("protected $table = 'axes';");
  });

  it('normalize keeps auto-increment keys; UUID keys only when the schema says so', () => {
    const output: MultiFileEmitOutput = emit(schema, { naming: 'normalize' });
    expect(migration(output, 'create_categories_table')).toContain(
      '$table->id();'
    );
    expect(migration(output, 'create_categories_table')).not.toContain('uuid');
  });
});

describe('laravel emitter: names that need care', () => {
  it('renames models that clash with PHP or Eloquent names', () => {
    const output: MultiFileEmitOutput = emit(
      schemaOf([model('Model'), model('Class')])
    );
    expect(Object.keys(output.files)).toContain('app/Models/ModelModel.php');
    expect(Object.keys(output.files)).toContain('app/Models/ClassModel.php');
    expect(output.warnings.join('\n')).toContain(
      'Model: "Model" cannot be used as a PHP class name'
    );
  });

  it('aliases an enum that has the same name as a model', () => {
    const output: MultiFileEmitOutput = emit(
      schemaOf(
        [
          model('Status', {
            tableName: 'statuses',
          }),
          model('Post', {
            fields: [idField(), field('state', { enumName: 'Status' })],
          }),
        ],
        [STATUS]
      )
    );
    const post: string = modelFile(output, 'Post');
    expect(post).toContain('use App\\Enums\\Status as StatusEnum;');
    expect(post).toContain("'state' => StatusEnum::class,");
  });

  it('warns about an enum default that is not a case', () => {
    const output: MultiFileEmitOutput = emit(
      schemaOf(
        [
          model('Post', {
            fields: [
              idField(),
              field('state', {
                enumName: 'Status',
                default: { kind: 'enumValue', value: 'NOPE' },
              }),
            ],
          }),
        ],
        [STATUS]
      )
    );
    expect(output.warnings.join('\n')).toContain(
      'Post.state: the enum default "NOPE" does not match a case of the enum; it was dropped.'
    );
  });

  it('warns that MySQL-only auto-updating columns are not refreshed by Eloquent', () => {
    const output: MultiFileEmitOutput = emit(
      schemaOf([
        model('Post', {
          fields: [
            idField(),
            field('touched', { type: 'dateTime', isAutoUpdated: true }),
          ],
        }),
      ])
    );
    expect(migration(output, 'create_post_table')).toContain(
      "$table->dateTime('touched')->useCurrent()->useCurrentOnUpdate();"
    );
    expect(output.warnings.join('\n')).toContain(
      'Post.touched: an auto-updated column'
    );
  });

  it('warns about MongoDB', () => {
    const output: MultiFileEmitOutput = emit(schemaOf([model('A')]), {
      provider: 'mongodb',
    });
    expect(output.warnings.join('\n')).toContain('Provider "mongodb"');
  });
});

// ---------------------------------------------------------------------------
// The shared blog schema
// ---------------------------------------------------------------------------

describe('laravel emitter: blog schema', () => {
  it.each(['django', 'prisma', 'typeorm', 'doctrine'])(
    'converts the %s blog schema to files with no emitter warnings',
    async (from: string) => {
      for (const naming of ['preserve', 'normalize'] as const) {
        const result = await convertCanonical(from, 'laravel', { naming });
        const names: string[] = Object.keys(result.files ?? {});
        expect(
          names.some((name) => name.startsWith('database/migrations/'))
        ).toBe(true);
        expect(names).toContain('app/Models/Post.php');
        expect(names).toContain('app/Enums/PostStatus.php');
        const post: string = result.files?.['app/Models/Post.php'] ?? '';
        expect(post).toContain('public function author(): BelongsTo');
        expect(post).toContain('PostStatus::class');
      }
    }
  );
});

// ---------------------------------------------------------------------------
// Real PHP and real Laravel
// ---------------------------------------------------------------------------

function phpAvailable(): boolean {
  const probe: SpawnSyncReturns<string> = spawnSync('php', ['-v'], {
    encoding: 'utf8',
  });
  return probe.status === 0;
}

const hasPhp: boolean = phpAvailable();
const scratch: string[] = [];

afterAll(() => {
  for (const directory of scratch) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function writeFiles(files: Record<string, string>): string {
  const directory: string = mkdtempSync(join(tmpdir(), 'ormbridge-laravel-'));
  scratch.push(directory);
  for (const [path, text] of Object.entries(files)) {
    const target: string = join(directory, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, text);
  }
  return directory;
}

/** A schema that exercises most mappings, used for the PHP checks. */
function stressSchema(): IrSchema {
  return schemaOf(
    [
      model('Account', {
        tableName: 'accounts',
        fields: [
          field('id', { type: 'uuid', isPrimaryKey: true }),
          field('name', { maxLength: 80 }),
          field('state', {
            enumName: 'Status',
            default: { kind: 'enumValue', value: 'DRAFT' },
          }),
          field('meta', {
            type: 'json',
            default: { kind: 'literal', value: '{}' },
          }),
          field('credit', { type: 'decimal', maxDigits: 9, decimalPlaces: 2 }),
          field('ratio', { type: 'float', isNullable: true }),
          field('visits', {
            type: 'bigInt',
            default: { kind: 'literal', value: 5 },
          }),
          field('active', {
            type: 'boolean',
            default: { kind: 'literal', value: true },
          }),
          field('blob', { type: 'bytes', isNullable: true }),
          field('addr', { type: 'ipAddress' }),
          field('tags', { type: 'string', arrayDepth: 1, isNullable: true }),
          field('token', {
            type: 'uuid',
            default: { kind: 'uuid' },
            isUnique: true,
          }),
          field('opened', { type: 'date', isNullable: true }),
          field('created_at', { type: 'dateTime', default: { kind: 'now' } }),
          field('updated_at', { type: 'dateTime', isAutoUpdated: true }),
          field('deleted_at', { type: 'dateTime', isNullable: true }),
        ],
        indexes: [{ fields: ['name', 'state'], isUnique: false }],
      }),
      model('Project', {
        tableName: 'projects',
        fields: [idField(), field('name', { maxLength: 60 })],
        relations: [
          relation('account', 'Account', { relatedName: 'projects' }),
          relation('lead', 'Member', {
            isNullable: true,
            onDelete: 'setNull',
            onUpdate: 'cascade',
            relatedName: 'led_projects',
          }),
          relation('members', 'Member', {
            kind: 'manyToMany',
            relatedName: 'projects',
          }),
        ],
        indexes: [{ fields: ['account', 'name'], isUnique: true }],
      }),
      model('Member', {
        tableName: 'members',
        fields: [
          idField(),
          field('email', { isUnique: true }),
          field('age', {
            type: 'int',
            nativeType: { name: 'UnsignedInt', args: [] },
          }),
        ],
        relations: [
          relation('manager', 'Member', {
            isNullable: true,
            onDelete: 'setNull',
            relatedName: 'reports',
          }),
          relation('friends', 'Member', {
            kind: 'manyToMany',
            relatedName: 'friend_of',
          }),
        ],
      }),
      model('Org', {
        tableName: 'orgs',
        relations: [
          relation('primary_team', 'Team', {
            isNullable: true,
            onDelete: 'setNull',
          }),
        ],
      }),
      model('Team', {
        tableName: 'teams',
        relations: [relation('org', 'Org', { relatedName: 'teams' })],
      }),
      model('Country', {
        tableName: 'countries',
        fields: [field('code', { isPrimaryKey: true, maxLength: 2 })],
      }),
      model('Region', {
        tableName: 'regions',
        fields: [idField(), field('name')],
        relations: [
          relation('country', 'Country', { columnName: 'country_code' }),
        ],
      }),
      model('Customer', {
        tableName: 'customers',
        fields: [idField(), field('slug', { isUnique: true, maxLength: 40 })],
      }),
      model('Order', {
        tableName: 'orders',
        relations: [
          relation('customer', 'Customer', {
            columnName: 'customer_slug',
            toField: 'slug',
          }),
        ],
      }),
      model('Item', { tableName: 'items' }),
      model('Detail', {
        tableName: 'details',
        fields: [field('note', { isNullable: true })],
        relations: [
          relation('item_ptr', 'Item', {
            kind: 'oneToOne',
            isPrimaryKey: true,
            relatedName: 'detail',
          }),
        ],
      }),
      model('Ticket', {
        tableName: 'tickets',
        fields: [
          field('id', {
            isPrimaryKey: true,
            default: { kind: 'clientGenerated', generator: 'ulid' },
          }),
          field('subject'),
        ],
      }),
      model('Note', {
        tableName: 'notes',
        fields: [idField(), field('body', { type: 'text' })],
        relations: [relation('ticket', 'Ticket', { relatedName: 'notes' })],
      }),
    ],
    [STATUS]
  );
}

describe('laravel emitter: PHP syntax', () => {
  const cases: [string, MultiFileEmitOutput][] = [
    ['stress schema (preserve)', emit(stressSchema())],
    [
      'stress schema (normalize)',
      emit(stressSchema(), { naming: 'normalize' }),
    ],
    [
      'stress schema (mysql, custom namespace)',
      emit(stressSchema(), {
        provider: 'mysql',
        namespace: 'Acme\\Shop\\Models',
      }),
    ],
  ];

  const lintAll = (label: string, files: Record<string, string>): void => {
    const directory: string = writeFiles(files);
    for (const path of Object.keys(files)) {
      const lint: SpawnSyncReturns<string> = spawnSync(
        'php',
        ['-l', join(directory, path)],
        { encoding: 'utf8' }
      );
      expect(lint.stdout + lint.stderr, `${label} ${path}`).toContain(
        'No syntax errors'
      );
    }
  };

  it.skipIf(!hasPhp).each(cases)('%s passes php -l', (name, output) => {
    lintAll(name, output.files);
  });

  it.skipIf(!hasPhp).each(['django', 'prisma', 'typeorm', 'doctrine'])(
    'the %s blog conversion passes php -l in both naming modes',
    async (from: string) => {
      for (const naming of ['preserve', 'normalize'] as const) {
        const result = await convertCanonical(from, 'laravel', { naming });
        lintAll(`${from} ${naming}`, result.files ?? {});
      }
    }
  );
});

// Set LARAVEL_DIR to a directory where
// `composer require illuminate/database illuminate/events illuminate/container illuminate/support ramsey/uuid symfony/uid`
// has been run (outside this repository). The generated migrations are then
// run (up and down) against in-memory SQLite and the models are loaded for a
// persistence round trip.
const laravelDirectory: string | undefined = process.env.LARAVEL_DIR;
const validateScript: string = fileURLToPath(
  new URL('./tools/validate-laravel.php', import.meta.url)
);

describe('laravel emitter: real Illuminate', () => {
  const run = (directory: string): SpawnSyncReturns<string> =>
    spawnSync('php', [validateScript, directory], {
      encoding: 'utf8',
      env: { ...process.env, LARAVEL_DIR: laravelDirectory ?? '' },
    });

  it
    .skipIf(!hasPhp || laravelDirectory === undefined)
    .each(['django', 'prisma', 'typeorm', 'doctrine'])(
    'runs the migrations and models of the %s blog schema',
    async (from: string) => {
      for (const naming of ['preserve', 'normalize'] as const) {
        const result = await convertCanonical(from, 'laravel', { naming });
        const run1 = run(writeFiles(result.files ?? {}));
        expect(run1.stdout + run1.stderr, `${from} ${naming}`).toContain(
          'laravel output verified'
        );
        expect(run1.status, `${from} ${naming}: ${run1.stdout}`).toBe(0);
      }
    }
  );

  it
    .skipIf(!hasPhp || laravelDirectory === undefined)
    .each(['preserve', 'normalize'] as const)(
    'runs the stress schema (%s naming)',
    (naming) => {
      const run1 = run(writeFiles(emit(stressSchema(), { naming }).files));
      expect(run1.stdout + run1.stderr).toContain('laravel output verified');
      expect(run1.status, run1.stdout + run1.stderr).toBe(0);
    }
  );
});
