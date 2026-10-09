import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { emitDoctrine } from '../src/emitters/doctrine.js';
import { getFormat, type FormatOptions } from '../src/formats.js';
import type { MultiFileEmitOutput } from '../src/formats.js';
import type {
  IrCompositeForeignKey,
  IrEnum,
  IrField,
  IrIndex,
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
    camelFields: boolean;
    namespace: string;
  }> = {}
): MultiFileEmitOutput {
  return emitDoctrine(schema, {
    provider: 'postgresql',
    camelFields: false,
    ...overrides,
  });
}

function entity(output: MultiFileEmitOutput, name: string): string {
  const text: string | undefined = output.files[`src/Entity/${name}.php`];
  if (text === undefined) {
    throw new Error(
      `No entity ${name}. Files: ${Object.keys(output.files).join(', ')}`
    );
  }
  return text;
}

const STATUS: IrEnum = {
  name: 'Status',
  values: [
    { name: 'DRAFT', dbValue: 'draft', label: 'Draft' },
    { name: 'LIVE', dbValue: 'live' },
  ],
};

describe('doctrine emitter: files and namespaces', () => {
  it('writes one PSR-4 file per entity and enum with strict types', () => {
    const output: MultiFileEmitOutput = emit(
      schemaOf([model('Post'), model('Tag')], [STATUS])
    );
    expect(Object.keys(output.files).sort()).toEqual([
      'src/Entity/Post.php',
      'src/Entity/Tag.php',
      'src/Enum/Status.php',
    ]);
    expect(output.text).toBeUndefined();
    const post: string = entity(output, 'Post');
    expect(
      post.startsWith(
        "<?php\n\ndeclare(strict_types=1);\n\nnamespace App\\Entity;\n\nuse Doctrine\\ORM\\Mapping as ORM;\n\n#[ORM\\Entity]\n#[ORM\\Table(name: 'post')]\nclass Post\n{"
      )
    ).toBe(true);
    expect(post.endsWith('}\n')).toBe(true);
  });

  it('writes backed enums with their stored values', () => {
    const output: MultiFileEmitOutput = emit(schemaOf([model('A')], [STATUS]));
    expect(output.files['src/Enum/Status.php']).toBe(
      [
        '<?php',
        '',
        'declare(strict_types=1);',
        '',
        'namespace App\\Enum;',
        '',
        'enum Status: string',
        '{',
        '    /** Draft */',
        "    case DRAFT = 'draft';",
        "    case LIVE = 'live';",
        '}',
        '',
      ].join('\n')
    );
  });

  it('maps a custom namespace to folders below src/ and a sibling Enum namespace', () => {
    const output: MultiFileEmitOutput = emit(schemaOf([model('A')], [STATUS]), {
      namespace: 'Acme\\Blog\\Entity',
    });
    expect(Object.keys(output.files).sort()).toEqual([
      'src/Blog/Entity/A.php',
      'src/Blog/Enum/Status.php',
    ]);
    expect(output.files['src/Blog/Entity/A.php']).toContain(
      'namespace Acme\\Blog\\Entity;'
    );
    expect(output.files['src/Blog/Enum/Status.php']).toContain(
      'namespace Acme\\Blog\\Enum;'
    );
  });

  it('puts enums in an Enum child namespace when the namespace does not end in Entity', () => {
    const output: MultiFileEmitOutput = emit(schemaOf([model('A')], [STATUS]), {
      namespace: 'Shop\\Models',
    });
    expect(Object.keys(output.files).sort()).toEqual([
      'src/Models/A.php',
      'src/Models/Enum/Status.php',
    ]);
  });

  it('falls back to the default namespace with a warning when the namespace is invalid', () => {
    const output: MultiFileEmitOutput = emit(schemaOf([model('A')]), {
      namespace: 'not a namespace!',
    });
    expect(Object.keys(output.files)).toEqual(['src/Entity/A.php']);
    expect(output.warnings.join('\n')).toContain(
      'The namespace "not a namespace!" is not a valid PHP namespace'
    );
  });

  it('is registered as a write-only "doctrine" format that does not claim .php', () => {
    const adapter = getFormat('doctrine');
    expect(adapter.ok).toBe(true);
    if (adapter.ok) {
      expect(adapter.value.extensions).toEqual([]);
      expect(adapter.value.emit).toBeDefined();
    }
  });

  it('rejects an invalid namespace through the format adapter', () => {
    const adapter = getFormat('doctrine');
    if (!adapter.ok || adapter.value.emit === undefined) {
      throw new Error('doctrine format missing');
    }
    const options: FormatOptions = { ...DEFAULT_OPTIONS, namespace: '1Bad' };
    const result = adapter.value.emit(schemaOf([model('A')]), options);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('INVALID_OPTION');
    }
  });

  it('accepts a namespace with a leading backslash through the format adapter', () => {
    const adapter = getFormat('doctrine');
    if (!adapter.ok || adapter.value.emit === undefined) {
      throw new Error('doctrine format missing');
    }
    const result = adapter.value.emit(schemaOf([model('A')]), {
      ...DEFAULT_OPTIONS,
      namespace: '\\Acme\\Entity',
    });
    expect(result.ok).toBe(true);
    if (result.ok && result.value.text === undefined) {
      expect(Object.keys(result.value.files)).toEqual(['src/Entity/A.php']);
    }
  });

  it('returns no files for an empty schema', () => {
    expect(emit(schemaOf([])).files).toEqual({});
  });
});

describe('doctrine emitter: columns', () => {
  it('maps every scalar type to an explicit Doctrine type and PHP type', () => {
    const fields: IrField[] = [
      idField(),
      field('s', { type: 'string', maxLength: 80 }),
      field('t', { type: 'text' }),
      field('i', { type: 'int' }),
      field('b', { type: 'bigInt' }),
      field('f', { type: 'float' }),
      field('d', { type: 'decimal', maxDigits: 8, decimalPlaces: 3 }),
      field('flag', { type: 'boolean' }),
      field('at', { type: 'dateTime' }),
      field('day', { type: 'date' }),
      field('clock', { type: 'time' }),
      field('uid', { type: 'uuid' }),
      field('doc', { type: 'json' }),
      field('raw', { type: 'bytes' }),
      field('ip', { type: 'ipAddress' }),
    ];
    const post: string = entity(emit(schemaOf([model('M', { fields })])), 'M');
    expect(post).toContain(
      "#[ORM\\Column(name: 's', type: 'string', length: 80)]\n    private string $s;"
    );
    expect(post).toContain("name: 't', type: 'text')]\n    private string $t;");
    expect(post).toContain("name: 'i', type: 'integer')]\n    private int $i;");
    expect(post).toContain(
      "name: 'b', type: 'bigint')]\n    private string $b;"
    );
    expect(post).toContain("name: 'f', type: 'float')]\n    private float $f;");
    expect(post).toContain(
      "name: 'd', type: 'decimal', precision: 8, scale: 3)]\n    private string $d;"
    );
    expect(post).toContain(
      "name: 'flag', type: 'boolean')]\n    private bool $flag;"
    );
    expect(post).toContain(
      "type: 'datetimetz_immutable')]\n    private DateTimeImmutable $at;"
    );
    expect(post).toContain(
      "type: 'date_immutable')]\n    private DateTimeImmutable $day;"
    );
    expect(post).toContain(
      "type: 'time_immutable')]\n    private DateTimeImmutable $clock;"
    );
    expect(post).toContain(
      "name: 'uid', type: 'guid')]\n    private string $uid;"
    );
    expect(post).toContain(
      "type: 'json', options: ['jsonb' => true])]\n    private mixed $doc;"
    );
    expect(post).toContain(
      "name: 'raw', type: 'blob')]\n    private mixed $raw;"
    );
    expect(post).toContain(
      "name: 'ip', type: 'string', length: 45)]\n    private string $ip;"
    );
    expect(post).toContain('use DateTimeImmutable;');
  });

  it('follows the provider for timezone-aware dates and JSONB', () => {
    const fields: IrField[] = [
      idField(),
      field('at', { type: 'dateTime' }),
      field('doc', { type: 'json' }),
    ];
    const mysql: string = entity(
      emit(schemaOf([model('M', { fields })]), { provider: 'mysql' }),
      'M'
    );
    expect(mysql).toContain("type: 'datetime_immutable'");
    expect(mysql).toContain("name: 'doc', type: 'json')]");
    expect(mysql).not.toContain('jsonb');
  });

  it('writes nullable, unique and the explicit column name', () => {
    const post: string = entity(
      emit(
        schemaOf([
          model('M', {
            fields: [
              idField(),
              field('nick_name', {
                columnName: 'nickname',
                isNullable: true,
                isUnique: true,
                maxLength: 30,
              }),
            ],
          }),
        ])
      ),
      'M'
    );
    expect(post).toContain(
      "#[ORM\\Column(name: 'nickname', type: 'string', length: 30, nullable: true, unique: true)]\n    private ?string $nick_name = null;"
    );
    expect(post).toContain('public function getNickName(): ?string');
    expect(post).toContain(
      'public function setNickName(?string $nickName): static'
    );
  });

  it('uses camelCase properties with snake_case columns when camelFields is on', () => {
    const post: string = entity(
      emit(
        schemaOf([
          model('M', {
            fields: [idField(), field('created_at', { type: 'dateTime' })],
          }),
        ]),
        { camelFields: true }
      ),
      'M'
    );
    expect(post).toContain("name: 'created_at'");
    expect(post).toContain('private DateTimeImmutable $createdAt;');
  });

  it('writes a generated auto-increment key as Id plus GeneratedValue with a nullable property', () => {
    const post: string = entity(emit(schemaOf([model('M')])), 'M');
    expect(post).toContain(
      "#[ORM\\Id]\n    #[ORM\\GeneratedValue(strategy: 'AUTO')]\n    #[ORM\\Column(name: 'id', type: 'integer')]\n    private ?int $id = null;"
    );
    expect(post).toContain('public function getId(): ?int');
    expect(post).not.toContain('setId');
  });

  it('generates the UUID of a uuid-default key in the constructor without extra packages', () => {
    const post: string = entity(
      emit(
        schemaOf([
          model('M', {
            fields: [
              field('id', {
                type: 'uuid',
                isPrimaryKey: true,
                default: { kind: 'uuid' },
              }),
            ],
          }),
        ])
      ),
      'M'
    );
    expect(post).toContain("#[ORM\\Column(name: 'id', type: 'guid')]");
    expect(post).not.toContain('GeneratedValue');
    expect(post).toContain('$this->id = self::generateUuid();');
    expect(post).toContain('private static function generateUuid(): string');
    expect(post).toContain('public function setId(string $id): static');
  });

  it('writes composite ids as several Id attributes without GeneratedValue', () => {
    const post: string = entity(
      emit(
        schemaOf([
          model('Link', {
            fields: [
              field('a', { type: 'int' }),
              field('b', { type: 'int' }),
              field('note'),
            ],
            compositePrimaryKey: ['a', 'b'],
          }),
        ])
      ),
      'Link'
    );
    expect(post.match(/#\[ORM\\Id\]/g)).toHaveLength(2);
    expect(post).not.toContain('GeneratedValue');
    expect(post).toContain('public function setA(int $a): static');
  });

  it('writes a primary-key relation as an Id on the association', () => {
    const output: MultiFileEmitOutput = emit(
      schemaOf([
        model('Place'),
        model('Restaurant', {
          fields: [field('menu')],
          relations: [
            relation('place_ptr', 'Place', {
              kind: 'oneToOne',
              columnName: 'place_ptr_id',
              isPrimaryKey: true,
            }),
          ],
        }),
      ])
    );
    const restaurant: string = entity(output, 'Restaurant');
    expect(restaurant).toContain(
      "#[ORM\\Id]\n    #[ORM\\OneToOne(targetEntity: Place::class, inversedBy: 'restaurant')]"
    );
    expect(restaurant).toContain('private Place $place_ptr;');
    expect(output.warnings.filter((w) => w.includes('no primary key'))).toEqual(
      []
    );
  });

  it('quotes reserved SQL words used as table and column names', () => {
    const output: MultiFileEmitOutput = emit(
      schemaOf([
        model('Order', {
          tableName: 'order',
          fields: [idField(), field('group')],
          indexes: [{ fields: ['group'], isUnique: false }],
        }),
      ])
    );
    const order: string = entity(output, 'Order');
    expect(order).toContain("#[ORM\\Table(name: '`order`')]");
    expect(order).toContain("#[ORM\\Index(columns: ['`group`'])]");
    expect(order).toContain("name: '`group`'");
  });
});

describe('doctrine emitter: defaults', () => {
  it('writes literal defaults as property initializers and column defaults', () => {
    const post: string = entity(
      emit(
        schemaOf([
          model('M', {
            fields: [
              idField(),
              field('n', {
                type: 'int',
                default: { kind: 'literal', value: 7 },
              }),
              field('flag', {
                type: 'boolean',
                default: { kind: 'literal', value: false },
              }),
              field('title', {
                default: { kind: 'literal', value: "it's" },
              }),
              field('ratio', {
                type: 'float',
                default: { kind: 'literal', value: 1 },
              }),
              field('price', {
                type: 'decimal',
                maxDigits: 5,
                decimalPlaces: 2,
                default: { kind: 'literal', value: '0.00' },
              }),
              field('doc', {
                type: 'json',
                default: { kind: 'literal', value: '{"a": [1, "x"]}' },
              }),
            ],
          }),
        ])
      ),
      'M'
    );
    expect(post).toContain(
      "options: ['default' => 7])]\n    private int $n = 7;"
    );
    expect(post).toContain('private bool $flag = false;');
    expect(post).toContain("'default' => 'it\\'s'");
    expect(post).toContain("private string $title = 'it\\'s';");
    expect(post).toContain('private float $ratio = 1.0;');
    expect(post).toContain("private string $price = '0.00';");
    expect(post).toContain("private mixed $doc = ['a' => [1, 'x']];");
  });

  it('uses enum cases for enum defaults and enumType for the column', () => {
    const output: MultiFileEmitOutput = emit(
      schemaOf(
        [
          model('M', {
            fields: [
              idField(),
              field('status', {
                enumName: 'Status',
                maxLength: 10,
                default: { kind: 'literal', value: 'draft' },
              }),
              field('other', { enumName: 'Status', isNullable: true }),
            ],
          }),
        ],
        [STATUS]
      )
    );
    const post: string = entity(output, 'M');
    expect(post).toContain('use App\\Enum\\Status;');
    expect(post).toContain(
      "        length: 10,\n        enumType: Status::class,\n        options: ['default' => 'draft'],\n    )]\n    private Status $status = Status::DRAFT;"
    );
    expect(post).toContain('private ?Status $other = null;');
    expect(post).toContain('public function getStatus(): Status');
  });

  it('aliases an enum whose name clashes with an entity', () => {
    const output: MultiFileEmitOutput = emit(
      schemaOf(
        [
          model('Status'),
          model('M', {
            fields: [idField(), field('status', { enumName: 'Status' })],
          }),
        ],
        [STATUS]
      )
    );
    const post: string = entity(output, 'M');
    expect(post).toContain('use App\\Enum\\Status as StatusEnum;');
    expect(post).toContain('enumType: StatusEnum::class');
    expect(post).toContain('private StatusEnum $status;');
  });

  it('sets a now default in the constructor and keeps a database default', () => {
    const post: string = entity(
      emit(
        schemaOf([
          model('M', {
            fields: [
              idField(),
              field('created', { type: 'dateTime', default: { kind: 'now' } }),
            ],
          }),
        ])
      ),
      'M'
    );
    expect(post).toContain("options: ['default' => 'CURRENT_TIMESTAMP']");
    expect(post).toContain('$this->created = new DateTimeImmutable();');
  });

  it('refreshes auto-updated fields with lifecycle callbacks', () => {
    const post: string = entity(
      emit(
        schemaOf([
          model('M', {
            fields: [
              idField(),
              field('updated_at', { type: 'dateTime', isAutoUpdated: true }),
            ],
          }),
        ])
      ),
      'M'
    );
    expect(post).toContain('#[ORM\\HasLifecycleCallbacks]');
    expect(post).toContain(
      '    #[ORM\\PrePersist]\n    #[ORM\\PreUpdate]\n    public function refreshAutoUpdatedFields(): void\n    {\n        $this->updated_at = new DateTimeImmutable();\n    }'
    );
  });
});

describe('doctrine emitter: relations', () => {
  const blog: IrSchema = schemaOf([
    model('User'),
    model('Post', {
      fields: [idField()],
      relations: [
        relation('author', 'User', { relatedName: 'posts' }),
        relation('editor', 'User', {
          isNullable: true,
          onDelete: 'setNull',
          relatedName: 'edited_posts',
        }),
        relation('tags', 'Tag', { kind: 'manyToMany', relatedName: 'posts' }),
      ],
    }),
    model('Tag'),
    model('Profile', {
      relations: [
        relation('user', 'User', { kind: 'oneToOne', relatedName: 'profile' }),
      ],
    }),
  ]);

  it('pairs the owning ManyToOne with an inverse OneToMany through inversedBy and mappedBy', () => {
    const output: MultiFileEmitOutput = emit(blog);
    const post: string = entity(output, 'Post');
    const user: string = entity(output, 'User');
    expect(post).toContain(
      "#[ORM\\ManyToOne(targetEntity: User::class, inversedBy: 'posts')]"
    );
    expect(post).toContain(
      "#[ORM\\JoinColumn(\n        name: 'author_id',\n        referencedColumnName: 'id',\n        nullable: false,\n        onDelete: 'CASCADE',\n    )]\n    private User $author;"
    );
    expect(post).toContain(
      "inversedBy: 'edited_posts')]\n    #[ORM\\JoinColumn(\n        name: 'editor_id',\n        referencedColumnName: 'id',\n        nullable: true,\n        onDelete: 'SET NULL',\n    )]\n    private ?User $editor = null;"
    );
    expect(user).toContain(
      "/** @var Collection<int, Post> */\n    #[ORM\\OneToMany(targetEntity: Post::class, mappedBy: 'author')]\n    private Collection $posts;"
    );
    expect(user).toContain(
      "mappedBy: 'editor')]\n    private Collection $edited_posts;"
    );
  });

  it('initialises collections in the constructor and imports the collection classes', () => {
    const user: string = entity(emit(blog), 'User');
    expect(user).toContain(
      'use Doctrine\\Common\\Collections\\ArrayCollection;'
    );
    expect(user).toContain('use Doctrine\\Common\\Collections\\Collection;');
    expect(user).toContain(
      '    public function __construct()\n    {\n        $this->posts = new ArrayCollection();\n        $this->edited_posts = new ArrayCollection();\n    }'
    );
  });

  it('pairs a one-to-one with an inverse OneToOne side', () => {
    const output: MultiFileEmitOutput = emit(blog);
    expect(entity(output, 'Profile')).toContain(
      "#[ORM\\OneToOne(targetEntity: User::class, inversedBy: 'profile')]"
    );
    const user: string = entity(output, 'User');
    expect(user).toContain(
      "#[ORM\\OneToOne(targetEntity: Profile::class, mappedBy: 'user')]\n    private ?Profile $profile = null;"
    );
    expect(user).toContain(
      'public function setProfile(?Profile $profile): static\n    {\n        $this->profile = $profile;\n        if ($profile !== null) {\n            $profile->setUser($this);\n        }'
    );
  });

  it('writes both sides of a many-to-many with a join table and synchronised helpers', () => {
    const output: MultiFileEmitOutput = emit(blog);
    const post: string = entity(output, 'Post');
    const tag: string = entity(output, 'Tag');
    expect(post).toContain(
      "#[ORM\\ManyToMany(targetEntity: Tag::class, inversedBy: 'posts')]\n    #[ORM\\JoinTable(name: 'post_tags')]\n    #[ORM\\JoinColumn(name: 'post_id', referencedColumnName: 'id', onDelete: 'CASCADE')]\n    #[ORM\\InverseJoinColumn(name: 'tag_id', referencedColumnName: 'id', onDelete: 'CASCADE')]\n    private Collection $tags;"
    );
    expect(tag).toContain(
      "#[ORM\\ManyToMany(targetEntity: Post::class, mappedBy: 'tags')]\n    private Collection $posts;"
    );
    expect(post).toContain(
      'public function addTag(Tag $tag): static\n    {\n        if (!$this->tags->contains($tag)) {\n            $this->tags->add($tag);\n            $tag->addPost($this);\n        }'
    );
    expect(post).toContain(
      'public function removeTag(Tag $tag): static\n    {\n        if ($this->tags->removeElement($tag)) {\n            $tag->removePost($this);\n        }'
    );
    expect(tag).toContain('$post->addTag($this);');
    expect(tag).toContain('$post->removeTag($this);');
  });

  it('keeps one-to-many helpers in sync with the owning side', () => {
    const user: string = entity(emit(blog), 'User');
    expect(user).toContain(
      'public function addPost(Post $post): static\n    {\n        if (!$this->posts->contains($post)) {\n            $this->posts->add($post);\n            $post->setAuthor($this);\n        }'
    );
    // The required author is not unset on removal; the nullable editor is.
    expect(user).toContain(
      'public function removeEditedPost(Post $editedPost): static'
    );
    expect(user).toContain(
      '$editedPost->getEditor() === $this) {\n                $editedPost->setEditor(null);'
    );
    const removePost: string = user.slice(
      user.indexOf('public function removePost(')
    );
    expect(removePost.slice(0, 260)).not.toContain('setAuthor(null)');
  });

  it('names and suffixes inverse properties without clashes', () => {
    const output: MultiFileEmitOutput = emit(
      schemaOf([
        model('User'),
        model('Post', {
          relations: [relation('author', 'User'), relation('editor', 'User')],
        }),
      ])
    );
    const user: string = entity(output, 'User');
    expect(user).toContain('private Collection $post_set;');
    expect(user).toContain('private Collection $post_set2;');
    expect(user).toContain('public function addPost(Post $post)');
    expect(user).toContain('public function addPostSet2(Post $postSet2)');
  });

  it('writes self-referencing many-to-many join columns with from_ and to_ prefixes', () => {
    const output: MultiFileEmitOutput = emit(
      schemaOf([
        model('Person', {
          relations: [
            relation('friends', 'Person', {
              kind: 'manyToMany',
              relatedName: 'friend_of',
            }),
          ],
        }),
      ])
    );
    const person: string = entity(output, 'Person');
    expect(person).toContain("name: 'from_person_id'");
    expect(person).toContain("name: 'to_person_id'");
    expect(person).toContain("mappedBy: 'friends'");
  });

  it('references the target column of a to_field and a non-id primary key', () => {
    const output: MultiFileEmitOutput = emit(
      schemaOf([
        model('Country', {
          fields: [
            field('code', { isPrimaryKey: true, maxLength: 2 }),
            field('iso', { columnName: 'iso_code', isUnique: true }),
          ],
        }),
        model('City', {
          relations: [
            relation('country', 'Country'),
            relation('by_iso', 'Country', { toField: 'iso' }),
          ],
        }),
      ])
    );
    const city: string = entity(output, 'City');
    expect(city).toContain(
      "name: 'country_id',\n        referencedColumnName: 'code'"
    );
    expect(city).toContain(
      "name: 'by_iso_id',\n        referencedColumnName: 'iso_code'"
    );
    expect(output.warnings.join('\n')).toContain(
      'City.by_iso: the relation references Country.iso, which is not a primary key'
    );
  });

  it('maps every onDelete action', () => {
    const output: MultiFileEmitOutput = emit(
      schemaOf([
        model('T'),
        model('M', {
          relations: [
            relation('a', 'T', { onDelete: 'cascade' }),
            relation('b', 'T', { onDelete: 'restrict' }),
            relation('c', 'T', { onDelete: 'noAction' }),
            relation('d', 'T', { onDelete: 'setDefault' }),
            relation('e', 'T', { onDelete: 'setNull', isNullable: true }),
          ],
        }),
      ])
    );
    const text: string = entity(output, 'M');
    for (const action of [
      'CASCADE',
      'RESTRICT',
      'NO ACTION',
      'SET DEFAULT',
      'SET NULL',
    ]) {
      expect(text).toContain(`onDelete: '${action}'`);
    }
  });
});

describe('doctrine emitter: table attributes', () => {
  it('writes indexes and unique constraints as class-level attributes on column names', () => {
    const indexes: IrIndex[] = [
      { fields: ['title'], isUnique: false },
      { fields: ['owner', 'title'], isUnique: true },
      { fields: ['title', 'body'], isUnique: false, name: 'title_body_idx' },
    ];
    const output: MultiFileEmitOutput = emit(
      schemaOf([
        model('User'),
        model('Doc', {
          fields: [idField(), field('title'), field('body')],
          relations: [relation('owner', 'User')],
          indexes,
        }),
      ])
    );
    const doc: string = entity(output, 'Doc');
    expect(doc).toContain(
      "#[ORM\\Table(name: 'doc')]\n#[ORM\\Index(columns: ['title'])]\n#[ORM\\UniqueConstraint(columns: ['owner_id', 'title'])]\n#[ORM\\Index(name: 'title_body_idx', columns: ['title', 'body'])]"
    );
    // Table(indexes:, uniqueConstraints:) has no effect in ORM 3, so it is not written.
    expect(doc).not.toContain('indexes:');
  });

  it('skips an index on a many-to-many relation with a warning', () => {
    const output: MultiFileEmitOutput = emit(
      schemaOf([
        model('Tag'),
        model('Post', {
          relations: [relation('tags', 'Tag', { kind: 'manyToMany' })],
          indexes: [{ fields: ['tags'], isUnique: false }],
        }),
      ])
    );
    expect(entity(output, 'Post')).not.toContain('ORM\\Index');
    expect(output.warnings.join('\n')).toContain(
      'Post index (tags): "tags" is a many-to-many relation and has no column'
    );
  });
});

describe('doctrine emitter: accessors', () => {
  it('writes fluent static setters and is/get getters', () => {
    const post: string = entity(
      emit(
        schemaOf([
          model('M', {
            fields: [
              idField(),
              field('is_featured', { type: 'boolean' }),
              field('published', { type: 'boolean' }),
              field('title'),
            ],
          }),
        ])
      ),
      'M'
    );
    expect(post).toContain(
      '    public function isFeatured(): bool\n    {\n        return $this->is_featured;\n    }'
    );
    expect(post).toContain('public function isPublished(): bool');
    expect(post).toContain(
      '    public function setTitle(string $title): static\n    {\n        $this->title = $title;\n\n        return $this;\n    }'
    );
  });
});

describe('doctrine emitter: warnings', () => {
  it('describes what has no Doctrine equivalent, naming model and field', () => {
    const output: MultiFileEmitOutput = emit(
      schemaOf([
        model('M', {
          fields: [
            idField(),
            field('tags', { type: 'string', arrayDepth: 1 }),
            field('attrs', { type: 'hstore' }),
            field('span', { type: 'range', rangeOf: 'int' }),
            field('lasts', { type: 'duration' }),
            field('total', {
              type: 'int',
              generated: { expression: 'F("a") + F("b")', isStored: true },
            }),
            field('shape', { type: 'unsupported', unsupportedType: 'circle' }),
            field('ghost', { enumName: 'Missing' }),
          ],
        }),
      ])
    );
    const warnings: string = output.warnings.join('\n');
    expect(warnings).toContain('M.tags: Doctrine has no array column type');
    expect(warnings).toContain('M.attrs: Doctrine has no hstore type');
    expect(warnings).toContain('M.span: Doctrine has no range column type');
    expect(warnings).toContain(
      'M.lasts: Doctrine has no database interval type'
    );
    expect(warnings).toContain('M.total: the generated column expression');
    expect(warnings).toContain('M.shape: the database type "circle"');
    expect(warnings).toContain('M.ghost: enum "Missing" does not exist');
    const text: string = entity(output, 'M');
    expect(text).toContain(
      "name: 'tags', type: 'json')]\n    private array $tags;"
    );
    expect(text).toContain(
      "name: 'lasts', type: 'dateinterval')]\n    private DateInterval $lasts;"
    );
  });

  it('reports Prisma-only constructs by model and field', () => {
    const key: IrCompositeForeignKey = {
      name: 'order',
      targetModel: 'Order',
      fields: ['a', 'b'],
      references: ['x', 'y'],
      kind: 'foreignKey',
      isNullable: false,
      onDelete: 'cascade',
    };
    const output: MultiFileEmitOutput = emit(
      schemaOf([
        model('Order'),
        model('Line', {
          isView: true,
          compositeForeignKeys: [key],
          fields: [
            idField(),
            field('code', {
              default: { kind: 'clientGenerated', generator: 'cuid' },
            }),
          ],
        }),
      ])
    );
    const warnings: string = output.warnings.join('\n');
    expect(warnings).toContain('Line: this is a database view');
    expect(warnings).toContain('Line.order: the composite foreign key');
    expect(warnings).toContain('Line.code: the cuid() default');
  });

  it('skips relations to missing models and composite-key targets', () => {
    const output: MultiFileEmitOutput = emit(
      schemaOf([
        model('Pair', {
          fields: [field('a', { type: 'int' }), field('b', { type: 'int' })],
          compositePrimaryKey: ['a', 'b'],
        }),
        model('M', {
          relations: [relation('gone', 'Nothing'), relation('pair', 'Pair')],
        }),
      ])
    );
    const warnings: string = output.warnings.join('\n');
    expect(warnings).toContain(
      'M.gone: target model "Nothing" does not exist in the schema'
    );
    expect(warnings).toContain(
      'M.pair: target model "Pair" has no single-column primary key'
    );
    expect(entity(output, 'M')).not.toContain('gone');
    expect(entity(output, 'M')).not.toContain('Pair');
  });

  it('warns about models without a primary key, set-null on required relations and MongoDB', () => {
    const output: MultiFileEmitOutput = emit(
      schemaOf([
        model('T'),
        model('NoKey', { fields: [field('x')] }),
        model('M', {
          relations: [relation('t', 'T', { onDelete: 'setNull' })],
        }),
      ]),
      { provider: 'mongodb' }
    );
    const warnings: string = output.warnings.join('\n');
    expect(warnings).toContain('NoKey: the model has no primary key');
    expect(warnings).toContain('M.t: onDelete SET NULL on a required relation');
    expect(warnings).toContain('Provider "mongodb"');
  });

  it('renames models that cannot be PHP class names', () => {
    const output: MultiFileEmitOutput = emit(
      schemaOf([model('List'), model('Collection'), model('Fine')])
    );
    expect(Object.keys(output.files).sort()).toEqual([
      'src/Entity/CollectionEntity.php',
      'src/Entity/Fine.php',
      'src/Entity/ListEntity.php',
    ]);
    expect(output.warnings.join('\n')).toContain(
      'List: "List" cannot be used as a PHP class name; the class was named "ListEntity".'
    );
  });

  it('repairs property names that are not valid PHP identifiers', () => {
    const output: MultiFileEmitOutput = emit(
      schemaOf([
        model('M', {
          fields: [idField(), field('1st-place', { type: 'int' })],
        }),
      ])
    );
    expect(entity(output, 'M')).toContain('private int $_1st_place;');
    expect(output.warnings.join('\n')).toContain(
      'M.1st-place: "1st-place" is not a valid PHP identifier'
    );
  });
});

describe('doctrine emitter: canonical conversions', () => {
  it.each(['django', 'prisma', 'typeorm'])(
    'converts the %s blog schema in both naming modes',
    async (from: string) => {
      const preserved = await convertCanonical(from, 'doctrine');
      const normalized = await convertCanonical(from, 'doctrine', {
        naming: 'normalize',
      });
      expect(preserved.output).toBe('');
      expect(Object.keys(preserved.files ?? {})).toContain(
        'src/Entity/Post.php'
      );
      expect(preserved.files?.['src/Entity/Post.php']).toContain(
        "#[ORM\\Table(name: 'blog_post')]"
      );
      expect(normalized.files?.['src/Entity/Post.php']).toContain(
        "#[ORM\\Table(name: 'post')]"
      );
      expect(normalized.files?.['src/Entity/Post.php']).toContain(
        "name: 'published_at'"
      );
      expect(normalized.files?.['src/Entity/Post.php']).toContain(
        'private DateTimeImmutable $publishedAt;'
      );
    }
  );

  it('honours the namespace option end to end', async () => {
    const result = await convertCanonical('django', 'doctrine', {
      namespace: 'Acme\\Blog\\Entity',
    });
    expect(Object.keys(result.files ?? {})).toContain(
      'src/Blog/Entity/Post.php'
    );
    expect(result.files?.['src/Blog/Entity/Post.php']).toContain(
      'use Acme\\Blog\\Enum\\PostStatus;'
    );
  });
});

// ---------------------------------------------------------------------------
// Real PHP and real Doctrine
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
  const directory: string = mkdtempSync(join(tmpdir(), 'ormbridge-doctrine-'));
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
      model('Order', {
        tableName: 'order',
        fields: [
          idField(),
          field('group'),
          field('state', {
            enumName: 'Status',
            default: { kind: 'literal', value: 'draft' },
          }),
          field('amount', { type: 'decimal', maxDigits: 9, decimalPlaces: 2 }),
          field('meta', {
            type: 'json',
            default: { kind: 'literal', value: '{}' },
          }),
          field('tags', { type: 'string', arrayDepth: 1, isNullable: true }),
          field('token', {
            type: 'uuid',
            default: { kind: 'uuid' },
            isUnique: true,
          }),
          field('placed', { type: 'dateTime', default: { kind: 'now' } }),
          field('touched', { type: 'dateTime', isAutoUpdated: true }),
          field('lasts', { type: 'duration', isNullable: true }),
          field('blob', { type: 'bytes', isNullable: true }),
          field('addr', { type: 'ipAddress' }),
          field('attrs', { type: 'hstore', isNullable: true }),
          field('span', { type: 'range', rangeOf: 'int', isNullable: true }),
          field('big', {
            type: 'bigInt',
            default: { kind: 'literal', value: 5 },
          }),
          field('day', {
            type: 'date',
            default: { kind: 'literal', value: '2020-01-02' },
          }),
        ],
        relations: [
          relation('customer', 'Customer', { relatedName: 'orders' }),
          relation('items', 'Item', {
            kind: 'manyToMany',
            relatedName: 'orders',
          }),
        ],
        indexes: [
          {
            fields: ['group', 'state'],
            isUnique: false,
            name: 'order_group_state',
          },
          { fields: ['customer', 'token'], isUnique: true },
        ],
      }),
      model('Customer', {
        fields: [
          field('code', { isPrimaryKey: true, maxLength: 8 }),
          field('email', { isUnique: true }),
        ],
        relations: [
          relation('referrer', 'Customer', {
            isNullable: true,
            onDelete: 'setNull',
            relatedName: 'referred',
          }),
        ],
      }),
      model('Item'),
      model('Line', {
        fields: [field('qty', { type: 'int' })],
        relations: [
          relation('order', 'Order', {
            isPrimaryKey: true,
            relatedName: 'lines',
          }),
        ],
        compositePrimaryKey: ['qty', 'order'],
      }),
      model('Detail', {
        fields: [field('note', { isNullable: true })],
        relations: [
          relation('line_ptr', 'Item', {
            kind: 'oneToOne',
            isPrimaryKey: true,
            relatedName: 'detail',
          }),
        ],
      }),
    ],
    [STATUS]
  );
}

describe('doctrine emitter: PHP syntax', () => {
  const cases: [string, MultiFileEmitOutput][] = [
    ['stress schema (preserve)', emit(stressSchema())],
    ['stress schema (camel)', emit(stressSchema(), { camelFields: true })],
    [
      'stress schema (mysql, custom namespace)',
      emit(stressSchema(), {
        provider: 'mysql',
        namespace: 'Acme\\Shop\\Entity',
      }),
    ],
  ];

  it.skipIf(!hasPhp).each(cases)('%s passes php -l', (_name, output) => {
    const directory: string = writeFiles(output.files);
    for (const path of Object.keys(output.files)) {
      const lint: SpawnSyncReturns<string> = spawnSync(
        'php',
        ['-l', join(directory, path)],
        { encoding: 'utf8' }
      );
      expect(lint.stdout + lint.stderr, path).toContain('No syntax errors');
    }
  });

  it.skipIf(!hasPhp).each(['django', 'prisma', 'typeorm'])(
    'the %s blog conversion passes php -l in both naming modes',
    async (from: string) => {
      for (const naming of ['preserve', 'normalize'] as const) {
        const result = await convertCanonical(from, 'doctrine', { naming });
        const files: Record<string, string> = result.files ?? {};
        const directory: string = writeFiles(files);
        for (const path of Object.keys(files)) {
          const lint: SpawnSyncReturns<string> = spawnSync(
            'php',
            ['-l', join(directory, path)],
            { encoding: 'utf8' }
          );
          expect(
            lint.stdout + lint.stderr,
            `${from} ${naming} ${path}`
          ).toContain('No syntax errors');
        }
      }
    }
  );
});

// Set DOCTRINE_DIR to a directory where `composer require doctrine/orm symfony/cache`
// has been run (outside this repository). The mappings are then loaded by
// Doctrine's real metadata factory, validated, and created in SQLite.
const doctrineDirectory: string | undefined = process.env.DOCTRINE_DIR;
const validateScript: string = fileURLToPath(
  new URL('./tools/validate-doctrine.php', import.meta.url)
);

describe('doctrine emitter: real Doctrine ORM', () => {
  const run = (
    directory: string,
    namespaceRoot: string
  ): SpawnSyncReturns<string> =>
    spawnSync('php', [validateScript, directory, namespaceRoot], {
      encoding: 'utf8',
      env: { ...process.env, DOCTRINE_DIR: doctrineDirectory ?? '' },
    });

  it
    .skipIf(!hasPhp || doctrineDirectory === undefined)
    .each(['django', 'prisma', 'typeorm'])(
    'validates the mapping of the %s blog schema',
    async (from: string) => {
      for (const naming of ['preserve', 'normalize'] as const) {
        const result = await convertCanonical(from, 'doctrine', { naming });
        const run1 = run(writeFiles(result.files ?? {}), 'App');
        expect(run1.stdout + run1.stderr, `${from} ${naming}`).toContain(
          'schema created in sqlite'
        );
        expect(run1.status, `${from} ${naming}: ${run1.stdout}`).toBe(0);
      }
    }
  );

  it.skipIf(!hasPhp || doctrineDirectory === undefined)(
    'validates the stress schema mapping',
    () => {
      const run1 = run(writeFiles(emit(stressSchema()).files), 'App');
      expect(run1.status, run1.stdout + run1.stderr).toBe(0);
    }
  );
});
