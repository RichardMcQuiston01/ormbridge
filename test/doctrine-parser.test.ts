import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { convertText } from '../src/convert.js';
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
  parseDoctrine,
  type DoctrineSourceFile,
} from '../src/parsers/doctrine.js';
import { DEFAULT_OPTIONS, expectOk } from './helpers.js';

const HEADER: string = `<?php
namespace App\\Entity;

use Doctrine\\DBAL\\Types\\Types;
use Doctrine\\ORM\\Mapping as ORM;

`;

/** Parses PHP class bodies in one file; the header with the namespace and the ORM alias is added. */
async function parse(...texts: string[]): Promise<IrSchema> {
  const sources: DoctrineSourceFile[] = texts.map(
    (text: string, index: number): DoctrineSourceFile => ({
      path: `File${index}.php`,
      text: index === 0 ? HEADER + text : text,
    })
  );
  return expectOk(await parseDoctrine(sources, { appLabel: 'app' }));
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

const ID: string = `
  #[ORM\\Id, ORM\\GeneratedValue, ORM\\Column]
  private ?int $id = null;
`;

describe('doctrine adapter registration', () => {
  it('is registered as a readable format that does not claim .php', () => {
    const adapter = expectOk(getFormat('doctrine'));
    expect(adapter.parse).toBeDefined();
    expect(adapter.extensions).toEqual([]);
    expect(getFormatByExtension('.php')).toBeUndefined();
  });

  it('converts through convertText', async () => {
    const result = expectOk(
      await convertText(
        [
          {
            path: 'User.php',
            text:
              HEADER +
              `#[ORM\\Entity] class User { ${ID} #[ORM\\Column(length: 40)] private string $name; }`,
          },
        ],
        { ...DEFAULT_OPTIONS, from: 'doctrine', to: 'prisma' }
      )
    );
    expect(result.modelCount).toBe(1);
    expect(result.output).toContain('model User {');
    expect(result.output).toContain('name');
  });
});

describe('directory input', () => {
  const created: string[] = [];
  afterEach(() => {
    for (const directory of created.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('reads every .php file of the fixture folder with --from doctrine', async () => {
    const directory: string = fileURLToPath(
      new URL('./fixtures/doctrine', import.meta.url)
    );
    const summary = expectOk(
      await runConversion({
        ...DEFAULT_OPTIONS,
        from: 'doctrine',
        to: 'prisma',
        inputs: [directory],
      })
    );
    expect(summary.modelCount).toBe(5);
    expect(summary.warnings).toEqual([]);
    expect(summary.inputFiles).toHaveLength(7);
  });

  it('skips vendor/, var/ and *Test.php files', async () => {
    const root: string = mkdtempSync(join(tmpdir(), 'ormbridge-doctrine-'));
    created.push(root);
    const entity: string = `${HEADER}#[ORM\\Entity] class Thing { ${ID} }`;
    mkdirSync(join(root, 'src'));
    mkdirSync(join(root, 'vendor'));
    mkdirSync(join(root, 'var'));
    writeFileSync(join(root, 'src', 'Thing.php'), entity);
    writeFileSync(join(root, 'src', 'ThingTest.php'), entity);
    writeFileSync(join(root, 'vendor', 'Other.php'), entity);
    writeFileSync(join(root, 'var', 'Cached.php'), entity);
    const summary = expectOk(
      await runConversion({
        ...DEFAULT_OPTIONS,
        from: 'doctrine',
        to: 'prisma',
        inputs: [root],
      })
    );
    expect(summary.inputFiles).toEqual([join(root, 'src', 'Thing.php')]);
  });
});

describe('entities and tables', () => {
  it('uses the underscore naming strategy for default table names', async () => {
    const schema: IrSchema = await parse(`
      #[ORM\\Entity] class BlogPost { ${ID} }
      #[ORM\\Entity] #[ORM\\Table(name: 'custom_tbl')] class Thing { ${ID} }
      #[ORM\\Entity(repositoryClass: BlogPostRepository::class)] class Plain { ${ID} }
    `);
    expect(model(schema, 'BlogPost').tableName).toBe('blog_post');
    expect(model(schema, 'Thing').tableName).toBe('custom_tbl');
    expect(model(schema, 'Plain').tableName).toBe('plain');
    expect(schema.warnings).toEqual([]);
  });

  it('warns that a table schema and table options are ignored', async () => {
    const schema: IrSchema = await parse(`
      #[ORM\\Entity]
      #[ORM\\Table(name: 't', schema: 'audit', options: ['engine' => 'InnoDB'])]
      class Audited { ${ID} }
    `);
    expect(
      warningsMatching(schema, 'Audited: the schema "audit"')
    ).toHaveLength(1);
    expect(warningsMatching(schema, 'Audited: the options')).toHaveLength(1);
  });

  it('resolves attributes through aliases, direct imports and fully qualified names', async () => {
    const schema: IrSchema = await parse(
      `
      use Doctrine\\ORM\\Mapping\\Entity;
      use Doctrine\\ORM\\Mapping\\{Column as Col, Id};
      use Doctrine\\ORM\\Mapping;

      #[Entity] class Direct { #[Id, Col(type: 'integer')] private int $id; #[Col] private string $label; }
      #[\\Doctrine\\ORM\\Mapping\\Entity] class Qualified { #[Mapping\\Id, Mapping\\Column] private int $id; }
    `
    );
    expect(model(schema, 'Direct').fields.map((f: IrField) => f.name)).toEqual([
      'id',
      'label',
    ]);
    expect(field(schema, 'Direct', 'id').isPrimaryKey).toBe(true);
    expect(field(schema, 'Qualified', 'id').isPrimaryKey).toBe(true);
  });

  it('ignores attributes from other libraries and lifecycle callbacks cleanly', async () => {
    const schema: IrSchema = await parse(`
      use Symfony\\Component\\Validator\\Constraints as Assert;

      #[ORM\\Entity]
      #[ORM\\HasLifecycleCallbacks]
      class Checked {
        ${ID}
        #[ORM\\Column(length: 20)]
        #[Assert\\NotBlank]
        private string $name;

        #[ORM\\PrePersist]
        public function touch(): void {}
      }
    `);
    expect(schema.warnings).toEqual([]);
    expect(field(schema, 'Checked', 'name').maxLength).toBe(20);
  });

  it('warns about unsupported ORM attributes instead of dropping them silently', async () => {
    const schema: IrSchema = await parse(`
      #[ORM\\Entity]
      #[ORM\\AttributeOverrides([])]
      class Overridden {
        ${ID}
        #[ORM\\Column]
        #[ORM\\Frobnicate]
        private string $name;
      }
    `);
    expect(
      warningsMatching(schema, 'Overridden: #[ORM\\AttributeOverrides]')
    ).toHaveLength(1);
    expect(
      warningsMatching(
        schema,
        'Overridden.name: the attribute #[ORM\\Frobnicate]'
      )
    ).toHaveLength(1);
  });

  it('returns NO_MODELS_FOUND when there is no entity', async () => {
    const result = await parseDoctrine(
      [{ path: 'x.php', text: '<?php class Plain { private int $id; }' }],
      { appLabel: 'app' }
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('NO_MODELS_FOUND');
      expect(result.error.message).toContain('x.php');
    }
  });

  it('reports docblock annotations clearly instead of producing an empty schema', async () => {
    const annotated: string = `<?php
namespace App\\Entity;
use Doctrine\\ORM\\Mapping as ORM;

/**
 * @ORM\\Entity
 * @ORM\\Table(name="old")
 */
class Old {
  /** @ORM\\Id @ORM\\Column(type="integer") */
  private $id;
}
`;
    const onlyAnnotated = await parseDoctrine(
      [{ path: 'Old.php', text: annotated }],
      { appLabel: 'app' }
    );
    expect(onlyAnnotated.ok).toBe(false);
    if (!onlyAnnotated.ok) {
      expect(onlyAnnotated.error.message).toContain(
        'annotation mapping is not supported'
      );
    }

    const mixed: IrSchema = expectOk(
      await parseDoctrine(
        [
          { path: 'Old.php', text: annotated },
          {
            path: 'New.php',
            text: `${HEADER}#[ORM\\Entity] class Fresh { ${ID} }`,
          },
        ],
        { appLabel: 'app' }
      )
    );
    expect(mixed.models.map((m: IrModel) => m.name)).toEqual(['Fresh']);
    expect(
      warningsMatching(mixed, 'Old.php: Doctrine docblock annotations')
    ).toHaveLength(1);
  });

  it('warns about PHP syntax errors', async () => {
    const schema: IrSchema = await parse(
      `#[ORM\\Entity] class Broken { ${ID} #[ORM\\Column] private string $x = ; }`
    );
    expect(warningsMatching(schema, 'syntax errors')).toHaveLength(1);
  });

  it('reads braced namespaces and per-namespace imports', async () => {
    const text: string = `<?php
namespace A {
  use Doctrine\\ORM\\Mapping as ORM;
  #[ORM\\Entity] class One { #[ORM\\Id, ORM\\Column] private int $id; }
}
namespace B {
  use Doctrine\\ORM\\Mapping as M;
  #[M\\Entity] class Two { #[M\\Id, M\\Column] private int $id; }
}
`;
    const schema: IrSchema = expectOk(
      await parseDoctrine([{ path: 'ns.php', text }], { appLabel: 'app' })
    );
    expect(schema.models.map((m: IrModel) => m.name)).toEqual(['One', 'Two']);
  });
});

describe('columns', () => {
  it('maps DBAL types, Types constants, lengths, precision and names', async () => {
    const schema: IrSchema = await parse(`
      #[ORM\\Entity]
      class Wide {
        ${ID}
        #[ORM\\Column(length: 80, unique: true)] private string $title;
        #[ORM\\Column(type: Types::TEXT)] private string $body;
        #[ORM\\Column(type: 'smallint')] private int $small;
        #[ORM\\Column(type: Types::BIGINT)] private string $big;
        #[ORM\\Column(type: Types::DECIMAL, precision: 8, scale: 3)] private string $price;
        #[ORM\\Column(type: Types::DECIMAL)] private string $defaultPrice;
        #[ORM\\Column(type: Types::FLOAT)] private float $ratio;
        #[ORM\\Column(type: Types::BOOLEAN)] private bool $active;
        #[ORM\\Column(type: Types::DATETIME_IMMUTABLE)] private \\DateTimeImmutable $at;
        #[ORM\\Column(type: Types::DATE_MUTABLE)] private \\DateTime $day;
        #[ORM\\Column(type: Types::TIME_MUTABLE)] private \\DateTime $hour;
        #[ORM\\Column(type: Types::DATEINTERVAL)] private \\DateInterval $gap;
        #[ORM\\Column(type: Types::JSON)] private array $data;
        #[ORM\\Column(type: Types::BLOB)] private $raw;
        #[ORM\\Column(type: Types::GUID)] private string $token;
        #[ORM\\Column(name: 'legacy_name', nullable: true)] private ?string $renamed = null;
        #[ORM\\Column(name: '\`order\`')] private int $quoted;
      }
    `);
    const expectField = (
      name: string,
      type: string,
      columnName: string
    ): IrField => {
      const found: IrField = field(schema, 'Wide', name);
      expect(found.type).toBe(type);
      expect(found.columnName).toBe(columnName);
      return found;
    };
    expect(expectField('title', 'string', 'title')).toMatchObject({
      maxLength: 80,
      isUnique: true,
      isNullable: false,
    });
    expectField('body', 'text', 'body');
    expectField('small', 'int', 'small');
    expectField('big', 'bigInt', 'big');
    expect(expectField('price', 'decimal', 'price')).toMatchObject({
      maxDigits: 8,
      decimalPlaces: 3,
    });
    expect(
      expectField('defaultPrice', 'decimal', 'default_price')
    ).toMatchObject({ maxDigits: 10, decimalPlaces: 0 });
    expectField('ratio', 'float', 'ratio');
    expectField('active', 'boolean', 'active');
    expectField('at', 'dateTime', 'at');
    expectField('day', 'date', 'day');
    expectField('hour', 'time', 'hour');
    expectField('gap', 'duration', 'gap');
    expectField('data', 'json', 'data');
    expectField('raw', 'bytes', 'raw');
    expectField('token', 'uuid', 'token');
    expect(expectField('renamed', 'string', 'legacy_name').isNullable).toBe(
      true
    );
    expectField('quoted', 'int', 'order');
    expect(schema.warnings).toEqual([]);
  });

  it('infers the column type from the PHP property type, as Doctrine does', async () => {
    const schema: IrSchema = await parse(`
      #[ORM\\Entity]
      class Inferred {
        #[ORM\\Id, ORM\\Column] private int $id;
        #[ORM\\Column] private string $s;
        #[ORM\\Column] private bool $b;
        #[ORM\\Column] private float $f;
        #[ORM\\Column] private array $a;
        #[ORM\\Column] private \\DateTimeImmutable $dti;
        #[ORM\\Column] private \\DateTime $dt;
        #[ORM\\Column] private ?string $nullableType;
        #[ORM\\Column] private string|null $unionNullable;
        #[ORM\\Column] private $untyped;
        #[ORM\\Column] private SomethingElse $unknown;
      }
    `);
    expect(field(schema, 'Inferred', 'id').type).toBe('int');
    expect(field(schema, 'Inferred', 's')).toMatchObject({
      type: 'string',
      maxLength: 255,
    });
    expect(field(schema, 'Inferred', 'b').type).toBe('boolean');
    expect(field(schema, 'Inferred', 'f').type).toBe('float');
    expect(field(schema, 'Inferred', 'a').type).toBe('json');
    expect(field(schema, 'Inferred', 'dti').type).toBe('dateTime');
    expect(field(schema, 'Inferred', 'dt').type).toBe('dateTime');
    expect(warningsMatching(schema, 'Inferred.untyped')).toHaveLength(1);
    expect(warningsMatching(schema, 'Inferred.unknown')).toHaveLength(1);
  });

  it('keeps nullability from the attribute, because Doctrine does not infer it from the PHP type', async () => {
    const schema: IrSchema = await parse(`
      #[ORM\\Entity]
      class Nullability {
        ${ID}
        #[ORM\\Column] private ?string $typedNullable = null;
        #[ORM\\Column] private string|null $unionNullable = null;
        #[ORM\\Column(nullable: true)] private string $declaredNullable;
      }
    `);
    expect(field(schema, 'Nullability', 'typedNullable').isNullable).toBe(
      false
    );
    expect(field(schema, 'Nullability', 'unionNullable').isNullable).toBe(
      false
    );
    expect(field(schema, 'Nullability', 'declaredNullable').isNullable).toBe(
      true
    );
  });

  it('reads constructor promotion', async () => {
    const schema: IrSchema = await parse(`
      #[ORM\\Entity]
      class Promoted {
        public function __construct(
          #[ORM\\Id, ORM\\GeneratedValue, ORM\\Column] private ?int $id = null,
          #[ORM\\Column(length: 30)] private string $name = '',
          #[ORM\\Column(nullable: true)] protected int|null $count = 5,
        ) {}
      }
    `);
    expect(field(schema, 'Promoted', 'id')).toMatchObject({
      isPrimaryKey: true,
      default: { kind: 'autoIncrement' },
    });
    expect(field(schema, 'Promoted', 'name').maxLength).toBe(30);
    expect(field(schema, 'Promoted', 'count')).toMatchObject({
      type: 'int',
      isNullable: true,
    });
  });

  it('reads several properties declared together and skips static ones', async () => {
    const schema: IrSchema = await parse(`
      #[ORM\\Entity]
      class Multi {
        ${ID}
        #[ORM\\Column(length: 9)] private string $first, $second;
        #[ORM\\Column] private static string $ignored;
      }
    `);
    expect(field(schema, 'Multi', 'first').maxLength).toBe(9);
    expect(field(schema, 'Multi', 'second').maxLength).toBe(9);
    expect(model(schema, 'Multi').fields.map((f: IrField) => f.name)).toEqual([
      'id',
      'first',
      'second',
    ]);
  });

  it('converts defaults from the options array', async () => {
    const schema: IrSchema = await parse(`
      #[ORM\\Entity]
      class Defaults {
        ${ID}
        #[ORM\\Column(options: ['default' => 5])] private int $n;
        #[ORM\\Column(options: ['default' => '7'])] private int $numeric;
        #[ORM\\Column(options: ['default' => true])] private bool $flag;
        #[ORM\\Column(options: ['default' => '0'])] private bool $off;
        #[ORM\\Column(options: ['default' => 'hello'])] private string $greeting;
        #[ORM\\Column(type: Types::DATETIME_IMMUTABLE, options: ['default' => 'CURRENT_TIMESTAMP'])] private \\DateTimeImmutable $at;
        #[ORM\\Column(type: Types::GUID, options: ['default' => 'gen_random_uuid()'])] private string $token;
        #[ORM\\Column(type: Types::JSON, options: ['default' => '{}'])] private array $meta;
        #[ORM\\Column(options: ['default' => SOME_CONSTANT])] private string $dynamic;
      }
    `);
    expect(field(schema, 'Defaults', 'n').default).toEqual({
      kind: 'literal',
      value: 5,
    });
    expect(field(schema, 'Defaults', 'numeric').default).toEqual({
      kind: 'literal',
      value: 7,
    });
    expect(field(schema, 'Defaults', 'flag').default).toEqual({
      kind: 'literal',
      value: true,
    });
    expect(field(schema, 'Defaults', 'off').default).toEqual({
      kind: 'literal',
      value: false,
    });
    expect(field(schema, 'Defaults', 'greeting').default).toEqual({
      kind: 'literal',
      value: 'hello',
    });
    expect(field(schema, 'Defaults', 'at').default).toEqual({ kind: 'now' });
    expect(field(schema, 'Defaults', 'token').default).toEqual({
      kind: 'uuid',
    });
    expect(field(schema, 'Defaults', 'meta').default).toEqual({
      kind: 'literal',
      value: '{}',
    });
    expect(field(schema, 'Defaults', 'dynamic').default).toBeUndefined();
    expect(warningsMatching(schema, 'Defaults.dynamic')).toHaveLength(1);
  });

  it('warns about column options that have no equivalent', async () => {
    const schema: IrSchema = await parse(`
      #[ORM\\Entity]
      class Fancy {
        ${ID}
        #[ORM\\Column(type: Types::INTEGER, options: ['unsigned' => true, 'comment' => 'hi'])] private int $counter;
        #[ORM\\Column(columnDefinition: 'CHAR(2) NOT NULL')] private string $code;
        #[ORM\\Column(insertable: false)] private string $readonlyish;
        #[ORM\\Column(type: 'money')] private string $custom;
        #[ORM\\Column(type: Types::SIMPLE_ARRAY)] private array $csv;
        #[ORM\\Column(type: Types::ARRAY)] private array $serialized;
      }
    `);
    for (const text of [
      'Fancy.counter: unsigned integers',
      'Fancy.counter: a column comment',
      'Fancy.code: columnDefinition',
      'Fancy.readonlyish: insertable: false',
      'Fancy.custom: column type "money"',
      'Fancy.csv: column type "simple_array"',
      'Fancy.serialized: column type "array"',
    ]) {
      expect(warningsMatching(schema, text), text).toHaveLength(1);
    }
    expect(field(schema, 'Fancy', 'custom').type).toBe('string');
    expect(field(schema, 'Fancy', 'csv').type).toBe('text');
    expect(field(schema, 'Fancy', 'serialized').type).toBe('json');
  });
});

describe('identifiers', () => {
  it('maps generation strategies', async () => {
    const schema: IrSchema = await parse(`
      use Doctrine\\ORM\\Mapping\\ClassMetadata;

      #[ORM\\Entity] class Auto { ${ID} }
      #[ORM\\Entity] class Identity {
        #[ORM\\Id, ORM\\GeneratedValue(strategy: 'IDENTITY'), ORM\\Column(type: Types::BIGINT)] private ?string $id = null;
      }
      #[ORM\\Entity] class Seq {
        #[ORM\\Id, ORM\\GeneratedValue(strategy: 'SEQUENCE'), ORM\\SequenceGenerator(sequenceName: 'seq_x'), ORM\\Column] private ?int $id = null;
      }
      #[ORM\\Entity] class UuidKey {
        #[ORM\\Id, ORM\\GeneratedValue(strategy: 'UUID'), ORM\\Column(type: Types::GUID)] private ?string $id = null;
      }
      #[ORM\\Entity] class AutoGuid {
        #[ORM\\Id, ORM\\GeneratedValue, ORM\\Column(type: Types::GUID)] private ?string $id = null;
      }
      #[ORM\\Entity] class None {
        #[ORM\\Id, ORM\\GeneratedValue(strategy: 'NONE'), ORM\\Column(length: 12)] private string $id;
      }
      #[ORM\\Entity] class Constant {
        #[ORM\\Id, ORM\\GeneratedValue(strategy: ClassMetadata::GENERATOR_TYPE_IDENTITY), ORM\\Column] private ?int $id = null;
      }
      #[ORM\\Entity] class Custom {
        #[ORM\\Id, ORM\\GeneratedValue(strategy: 'CUSTOM'), ORM\\CustomIdGenerator(class: \\App\\Mine\\Generator::class), ORM\\Column] private ?int $id = null;
      }
      #[ORM\\Entity] class SymfonyUuid {
        #[ORM\\Id, ORM\\GeneratedValue(strategy: 'CUSTOM'), ORM\\CustomIdGenerator(class: \\Symfony\\Bridge\\Doctrine\\IdGenerator\\UuidGenerator::class), ORM\\Column(type: 'uuid')] private ?string $id = null;
      }
    `);
    expect(field(schema, 'Auto', 'id')).toMatchObject({
      type: 'int',
      isPrimaryKey: true,
      isNullable: false,
      default: { kind: 'autoIncrement' },
    });
    expect(field(schema, 'Identity', 'id')).toMatchObject({
      type: 'bigInt',
      default: { kind: 'autoIncrement' },
    });
    expect(field(schema, 'Seq', 'id').default).toEqual({
      kind: 'autoIncrement',
    });
    expect(warningsMatching(schema, 'Seq.id: the SEQUENCE')).toHaveLength(1);
    expect(
      warningsMatching(schema, 'Seq.id: #[ORM\\SequenceGenerator]')
    ).toHaveLength(1);
    expect(field(schema, 'UuidKey', 'id')).toMatchObject({
      type: 'uuid',
      default: { kind: 'uuid' },
    });
    expect(field(schema, 'AutoGuid', 'id').default).toEqual({ kind: 'uuid' });
    expect(field(schema, 'None', 'id').default).toBeUndefined();
    expect(field(schema, 'None', 'id').maxLength).toBe(12);
    expect(field(schema, 'Constant', 'id').default).toEqual({
      kind: 'autoIncrement',
    });
    expect(field(schema, 'Custom', 'id').default).toBeUndefined();
    expect(
      warningsMatching(schema, 'Custom.id: the custom id generator "Generator"')
    ).toHaveLength(1);
    expect(field(schema, 'SymfonyUuid', 'id')).toMatchObject({
      type: 'uuid',
      default: { kind: 'uuid' },
    });
  });

  it('builds composite keys from several #[ORM\\Id] properties and relations', async () => {
    const schema: IrSchema = await parse(`
      #[ORM\\Entity] class Account { ${ID} }
      #[ORM\\Entity]
      class Membership {
        #[ORM\\Id, ORM\\ManyToOne(targetEntity: Account::class), ORM\\JoinColumn(nullable: false)] private Account $account;
        #[ORM\\Id, ORM\\Column(length: 20)] private string $role;
      }
    `);
    const membership: IrModel = model(schema, 'Membership');
    expect(membership.compositePrimaryKey).toEqual(['role', 'account']);
    expect(field(schema, 'Membership', 'role').isPrimaryKey).toBe(false);
    expect(
      relation(schema, 'Membership', 'account').isPrimaryKey
    ).toBeUndefined();
    expect(relation(schema, 'Membership', 'account').columnName).toBe(
      'account_id'
    );
  });

  it('warns when an entity has no identifier', async () => {
    const schema: IrSchema = await parse(
      `#[ORM\\Entity] class Keyless { #[ORM\\Column] private string $x; }`
    );
    expect(
      warningsMatching(schema, 'Keyless: the entity has no identifier')
    ).toHaveLength(1);
  });

  it('keeps #[ORM\\Version] as an integer defaulting to 1 with a warning', async () => {
    const schema: IrSchema = await parse(`
      #[ORM\\Entity]
      class Versioned {
        ${ID}
        #[ORM\\Version, ORM\\Column(type: Types::INTEGER)] private int $version = 1;
      }
    `);
    expect(field(schema, 'Versioned', 'version').default).toEqual({
      kind: 'literal',
      value: 1,
    });
    expect(
      warningsMatching(schema, 'Versioned.version: #[ORM\\Version]')
    ).toHaveLength(1);
  });
});

describe('enums', () => {
  const STATUS: string = `<?php
namespace App\\Entity;
enum Status: string { case Draft = 'draft'; case Published = 'published'; }
`;

  it('maps backed enums used through enumType, in the same or another file', async () => {
    const entity: string = `
      #[ORM\\Entity]
      class Doc {
        ${ID}
        #[ORM\\Column(enumType: Status::class, options: ['default' => 'draft'])] private Status $status;
        #[ORM\\Column(type: Types::STRING, length: 20, enumType: Status::class)] private Status $explicit;
      }
    `;
    const schema: IrSchema = await parse(entity, STATUS);
    expect(schema.enums).toEqual<IrEnum[]>([
      {
        name: 'Status',
        values: [
          { name: 'Draft', dbValue: 'draft' },
          { name: 'Published', dbValue: 'published' },
        ],
      },
    ]);
    expect(field(schema, 'Doc', 'status')).toMatchObject({
      type: 'string',
      enumName: 'Status',
      default: { kind: 'enumValue', value: 'Draft' },
    });
    expect(field(schema, 'Doc', 'status').maxLength).toBeUndefined();
    expect(field(schema, 'Doc', 'explicit').maxLength).toBe(20);
    expect(schema.warnings).toEqual([]);
  });

  it('infers an enum column from the PHP property type', async () => {
    const schema: IrSchema = await parse(
      `#[ORM\\Entity] class Doc { ${ID} #[ORM\\Column] private Status $status; }
       enum Status: string { case A = 'a'; }`
    );
    expect(field(schema, 'Doc', 'status').enumName).toBe('Status');
  });

  it('declares an enum in the same file as a pure enum and warns', async () => {
    const schema: IrSchema = await parse(
      `enum Pure { case A; case B; }
       #[ORM\\Entity] class Doc { ${ID} #[ORM\\Column(enumType: Pure::class)] private Pure $kind; }`
    );
    expect(
      warningsMatching(schema, 'Doc.kind: the enum "Pure" is not a backed enum')
    ).toHaveLength(1);
    expect(field(schema, 'Doc', 'kind').enumName).toBeUndefined();
  });

  it('converts int-backed enums to int columns with a warning', async () => {
    const schema: IrSchema = await parse(
      `enum Level: int { case Low = 1; case High = 2; }
       #[ORM\\Entity] class Doc { ${ID} #[ORM\\Column(enumType: Level::class)] private Level $level; }`
    );
    expect(field(schema, 'Doc', 'level').type).toBe('int');
    expect(schema.enums).toEqual([]);
    expect(
      warningsMatching(schema, 'Doc.level: the enum "Level" has integer values')
    ).toHaveLength(1);
  });

  it('warns when the enum is not part of the input', async () => {
    const schema: IrSchema = await parse(
      `use Elsewhere\\Colour;
       #[ORM\\Entity] class Doc { ${ID} #[ORM\\Column(enumType: Colour::class)] private Colour $colour; }`
    );
    expect(
      warningsMatching(schema, 'Doc.colour: the enum "Colour" was not found')
    ).toHaveLength(1);
    expect(field(schema, 'Doc', 'colour').type).toBe('string');
  });
});

describe('relations', () => {
  const PEOPLE: string = `
    #[ORM\\Entity] class Team {
      ${ID}
      #[ORM\\OneToMany(targetEntity: Person::class, mappedBy: 'team')] private $members;
      #[ORM\\ManyToMany(targetEntity: Person::class, mappedBy: 'teams')] private $everyone;
    }
    #[ORM\\Entity] class Person {
      ${ID}
      #[ORM\\ManyToOne(targetEntity: Team::class, inversedBy: 'members', cascade: ['persist'], fetch: 'EAGER')]
      private ?Team $team = null;
      #[ORM\\ManyToMany(targetEntity: Team::class, inversedBy: 'everyone')]
      private $teams;
    }
  `;

  it('defaults join columns to <property>_id, nullable, with no delete action', async () => {
    const schema: IrSchema = await parse(PEOPLE);
    expect(relation(schema, 'Person', 'team')).toMatchObject({
      kind: 'foreignKey',
      targetModel: 'Team',
      columnName: 'team_id',
      isNullable: true,
      onDelete: 'noAction',
      relatedName: 'members',
    });
    expect(schema.warnings).toEqual([]);
  });

  it('reads join column options', async () => {
    const schema: IrSchema = await parse(`
      #[ORM\\Entity] class Owner { ${ID} }
      #[ORM\\Entity]
      class Pet {
        ${ID}
        #[ORM\\ManyToOne(targetEntity: Owner::class)]
        #[ORM\\JoinColumn(name: 'the_owner', referencedColumnName: 'ref', nullable: false, onDelete: 'SET NULL')]
        private Owner $owner;
        #[ORM\\ManyToOne(targetEntity: Owner::class)]
        #[ORM\\JoinColumn(onDelete: 'cascade')]
        private Owner $previousOwner;
        #[ORM\\ManyToOne(targetEntity: Owner::class)]
        #[ORM\\JoinColumn(onDelete: 'WEIRD')]
        private Owner $weird;
        #[ORM\\ManyToOne]
        private ?Owner $inferredTarget = null;
      }
    `);
    expect(relation(schema, 'Pet', 'owner')).toMatchObject({
      columnName: 'the_owner',
      toField: 'ref',
      isNullable: false,
      onDelete: 'setNull',
    });
    expect(relation(schema, 'Pet', 'previousOwner')).toMatchObject({
      columnName: 'previous_owner_id',
      onDelete: 'cascade',
    });
    expect(relation(schema, 'Pet', 'weird').onDelete).toBe('noAction');
    expect(
      warningsMatching(schema, 'Pet.weird: onDelete "WEIRD"')
    ).toHaveLength(1);
    expect(relation(schema, 'Pet', 'inferredTarget').targetModel).toBe('Owner');
  });

  it('links one-to-many and many-to-many inverse sides to their owners', async () => {
    const schema: IrSchema = await parse(PEOPLE);
    expect(relation(schema, 'Person', 'teams')).toMatchObject({
      kind: 'manyToMany',
      targetModel: 'Team',
      relatedName: 'everyone',
    });
    expect(model(schema, 'Team').relations).toEqual([]);
  });

  it('treats a one-to-one with mappedBy as the inverse side', async () => {
    const schema: IrSchema = await parse(`
      #[ORM\\Entity] class Account {
        ${ID}
        #[ORM\\OneToOne(targetEntity: Settings::class, mappedBy: 'account')] private ?Settings $settings = null;
      }
      #[ORM\\Entity] class Settings {
        ${ID}
        #[ORM\\OneToOne(inversedBy: 'settings')] #[ORM\\JoinColumn(nullable: false)] private Account $account;
      }
    `);
    expect(relation(schema, 'Settings', 'account')).toMatchObject({
      kind: 'oneToOne',
      isNullable: false,
      relatedName: 'settings',
    });
    expect(model(schema, 'Account').relations).toEqual([]);
  });

  it('resolves string and relative targets and self references', async () => {
    const schema: IrSchema = await parse(`
      #[ORM\\Entity] class Node {
        ${ID}
        #[ORM\\ManyToOne(targetEntity: 'Node')] private ?Node $byString = null;
        #[ORM\\ManyToOne(targetEntity: '\\\\App\\\\Entity\\\\Node')] private ?Node $byQualified = null;
        #[ORM\\ManyToOne(targetEntity: self::class)] private ?Node $bySelf = null;
      }
    `);
    for (const name of ['byString', 'byQualified', 'bySelf']) {
      expect(relation(schema, 'Node', name).targetModel).toBe('Node');
    }
  });

  it('adds a stub model with a warning for an unknown target', async () => {
    const schema: IrSchema = await parse(`
      use Vendor\\Bundle\\Account;
      #[ORM\\Entity] class Thing {
        ${ID}
        #[ORM\\ManyToOne(targetEntity: Account::class)] private ?Account $account = null;
      }
    `);
    expect(model(schema, 'Account').fields[0]?.name).toBe('id');
    expect(
      warningsMatching(schema, 'Thing.account references "Account"')
    ).toHaveLength(1);
  });

  it('merges a duplicated scalar foreign-key property into the relation', async () => {
    const schema: IrSchema = await parse(`
      #[ORM\\Entity] class Parentish { ${ID} }
      #[ORM\\Entity] class Childish {
        ${ID}
        #[ORM\\Column(name: 'parent_id', insertable: false, updatable: false)] private ?int $parentId = null;
        #[ORM\\ManyToOne(targetEntity: Parentish::class)] #[ORM\\JoinColumn(name: 'parent_id', nullable: false)] private Parentish $parent;
      }
    `);
    expect(
      model(schema, 'Childish').fields.map((f: IrField) => f.name)
    ).toEqual(['id']);
    expect(relation(schema, 'Childish', 'parent').columnName).toBe('parent_id');
  });

  it('warns about unsupported relation features', async () => {
    const schema: IrSchema = await parse(`
      #[ORM\\Entity] class Target { ${ID} }
      #[ORM\\Entity] class Source {
        ${ID}
        #[ORM\\ManyToOne(targetEntity: Target::class)]
        #[ORM\\JoinColumn(name: 'a_id')]
        #[ORM\\JoinColumn(name: 'b_id')]
        private Target $composite;
        #[ORM\\OneToMany(targetEntity: Target::class, mappedBy: 'source', orphanRemoval: true)] private $removed;
        #[ORM\\ManyToMany(targetEntity: Target::class)]
        #[ORM\\JoinTable(name: 'custom_link')]
        private $custom;
        #[ORM\\ManyToOne] private $untyped;
      }
    `);
    expect(
      warningsMatching(schema, 'Source.composite: composite foreign keys')
    ).toHaveLength(1);
    expect(
      warningsMatching(schema, 'Source.removed: ORM-level cascade remove')
    ).toHaveLength(1);
    expect(
      warningsMatching(
        schema,
        'Source.custom: custom join table settings (name)'
      )
    ).toHaveLength(1);
    expect(
      warningsMatching(
        schema,
        'Source.untyped: the target of #[ORM\\ManyToOne]'
      )
    ).toHaveLength(1);
    expect(
      model(schema, 'Source').relations.map((r: IrRelation) => r.name)
    ).toEqual(['custom']);
  });

  it('warns when the owning side of an inverse relation is missing', async () => {
    const schema: IrSchema = await parse(`
      #[ORM\\Entity] class Owner { ${ID}
        #[ORM\\OneToMany(targetEntity: Pet::class, mappedBy: 'nobody')] private $pets;
      }
      #[ORM\\Entity] class Pet { ${ID} }
    `);
    expect(
      warningsMatching(
        schema,
        'Owner.pets: the owning side "Pet.nobody" was not found'
      )
    ).toHaveLength(1);
  });
});

describe('indexes and unique constraints', () => {
  it('reads class-level and Table-level indexes, mapping columns to IR names', async () => {
    const schema: IrSchema = await parse(`
      #[ORM\\Entity]
      #[ORM\\Table(name: 'ev', indexes: [new ORM\\Index(name: 'by_when', columns: ['starts_at', 'kind'])], uniqueConstraints: [new ORM\\UniqueConstraint(name: 'uniq_slot', columns: ['starts_at', 'place_id'])])]
      #[ORM\\Index(columns: ['kind'])]
      #[ORM\\UniqueConstraint(fields: ['code'])]
      class Event {
        ${ID}
        #[ORM\\Column(name: 'starts_at', type: Types::DATETIME_IMMUTABLE)] private \\DateTimeImmutable $startsAt;
        #[ORM\\Column(length: 10)] private string $kind;
        #[ORM\\Column(length: 10)] private string $code;
        #[ORM\\ManyToOne(targetEntity: Place::class)] private ?Place $place = null;
      }
      #[ORM\\Entity] class Place { ${ID} }
    `);
    const indexes: IrIndex[] = model(schema, 'Event').indexes;
    expect(indexes).toEqual<IrIndex[]>([
      { fields: ['startsAt', 'kind'], isUnique: false, name: 'by_when' },
      { fields: ['startsAt', 'place'], isUnique: true, name: 'uniq_slot' },
      { fields: ['kind'], isUnique: false },
    ]);
    // A single-column unnamed unique constraint becomes a unique column.
    expect(field(schema, 'Event', 'code').isUnique).toBe(true);
    expect(schema.warnings).toEqual([]);
  });

  it('maps fulltext flags and warns about options and unknown references', async () => {
    const schema: IrSchema = await parse(`
      #[ORM\\Entity]
      #[ORM\\Index(name: 'ft', columns: ['body'], flags: ['fulltext'])]
      #[ORM\\Index(name: 'partial', columns: ['body'], options: ['where' => '(body IS NOT NULL)'])]
      #[ORM\\Index(name: 'broken', columns: ['missing'])]
      class Article {
        ${ID}
        #[ORM\\Column(type: Types::TEXT)] private string $body;
      }
    `);
    const indexes: IrIndex[] = model(schema, 'Article').indexes;
    expect(indexes.find((i: IrIndex) => i.name === 'ft')?.kind).toBe(
      'fulltext'
    );
    expect(
      warningsMatching(schema, 'Article: the "where" option of #[ORM\\Index]')
    ).toHaveLength(1);
    expect(
      warningsMatching(schema, 'Article: the index on (missing)')
    ).toHaveLength(1);
  });

  it('supports Column(index: true)', async () => {
    const schema: IrSchema = await parse(`
      #[ORM\\Entity] class Indexed { ${ID} #[ORM\\Column(length: 10, index: true)] private string $code; }
    `);
    expect(model(schema, 'Indexed').indexes).toEqual([
      { fields: ['code'], isUnique: false },
    ]);
  });
});

describe('embeddables and inheritance', () => {
  it('flattens embeddables using the underscore prefix, an explicit prefix or none', async () => {
    const schema: IrSchema = await parse(`
      #[ORM\\Embeddable]
      class Address {
        #[ORM\\Column(length: 40)] private string $streetLine;
        #[ORM\\Column(nullable: true)] private ?string $zip = null;
      }
      #[ORM\\Entity]
      class Customer {
        ${ID}
        #[ORM\\Embedded(class: Address::class)] private Address $home;
        #[ORM\\Embedded(class: Address::class, columnPrefix: 'work_')] private Address $work;
        #[ORM\\Embedded(columnPrefix: false)] private Address $bare;
      }
    `);
    const columns: Record<string, string> = Object.fromEntries(
      model(schema, 'Customer').fields.map((f: IrField) => [
        f.name,
        f.columnName,
      ])
    );
    expect(columns).toMatchObject({
      homeStreetLine: 'home_street_line',
      homeZip: 'home_zip',
      workStreetLine: 'work_street_line',
      workZip: 'work_zip',
      bareStreetLine: 'street_line',
      bareZip: 'zip',
    });
    expect(field(schema, 'Customer', 'homeZip').isNullable).toBe(true);
    expect(schema.models.map((m: IrModel) => m.name)).toEqual(['Customer']);
    expect(schema.warnings).toEqual([]);
  });

  it('warns about a missing embeddable', async () => {
    const schema: IrSchema = await parse(`
      #[ORM\\Entity] class Customer { ${ID} #[ORM\\Embedded(class: Missing::class)] private $m; }
    `);
    expect(
      warningsMatching(
        schema,
        'Customer.m: the embeddable "Missing" was not found'
      )
    ).toHaveLength(1);
  });

  it('inherits columns, relations and indexes from mapped superclasses and traits', async () => {
    const schema: IrSchema = await parse(
      `
      trait Stamped { #[ORM\\Column(options: ['default' => 'CURRENT_TIMESTAMP'], type: Types::DATETIME_IMMUTABLE)] private \\DateTimeImmutable $stamp; }
      #[ORM\\MappedSuperclass]
      #[ORM\\Index(columns: ['owner_id'])]
      abstract class Base {
        ${ID}
        #[ORM\\ManyToOne(targetEntity: Owner::class)] private ?Owner $owner = null;
      }
      #[ORM\\MappedSuperclass] abstract class Middle extends Base { #[ORM\\Column(length: 5)] private string $mid; }
      #[ORM\\Entity] class Leaf extends Middle { use Stamped; #[ORM\\Column(length: 7)] private string $own; }
      #[ORM\\Entity] class Owner { ${ID} }
    `
    );
    expect(model(schema, 'Leaf').fields.map((f: IrField) => f.name)).toEqual([
      'id',
      'mid',
      'stamp',
      'own',
    ]);
    expect(relation(schema, 'Leaf', 'owner').targetModel).toBe('Owner');
    expect(model(schema, 'Leaf').indexes).toEqual([
      { fields: ['owner'], isUnique: false },
    ]);
    expect(schema.models.map((m: IrModel) => m.name)).toEqual([
      'Leaf',
      'Owner',
    ]);
    expect(schema.warnings).toEqual([]);
  });

  it('warns about a base class or trait outside the input', async () => {
    const schema: IrSchema = await parse(`
      use Vendor\\Bundle\\BaseEntity;
      use Vendor\\Bundle\\SoftDelete;
      #[ORM\\Entity] class Leaf extends BaseEntity { use SoftDelete; ${ID} }
    `);
    expect(
      warningsMatching(schema, 'Leaf: base class "BaseEntity" was not found')
    ).toHaveLength(1);
    expect(
      warningsMatching(schema, 'Leaf: the trait "SoftDelete" was not found')
    ).toHaveLength(1);
  });

  it('flattens single-table inheritance into the root table', async () => {
    const schema: IrSchema = await parse(`
      #[ORM\\Entity]
      #[ORM\\InheritanceType('SINGLE_TABLE')]
      #[ORM\\DiscriminatorColumn(name: 'kind', type: 'string', length: 12)]
      #[ORM\\DiscriminatorMap(['car' => Car::class, 'bike' => Bike::class])]
      class Vehicle { ${ID} #[ORM\\Column(length: 20)] private string $name; }
      #[ORM\\Entity] class Car extends Vehicle { #[ORM\\Column(length: 3)] private string $plate; }
      #[ORM\\Entity] class Bike extends Vehicle { #[ORM\\Column(type: Types::BOOLEAN)] private bool $electric; }
      #[ORM\\Entity] class Garage { ${ID} #[ORM\\ManyToOne(targetEntity: Car::class)] private ?Car $car = null; }
    `);
    expect(schema.models.map((m: IrModel) => m.name)).toEqual([
      'Vehicle',
      'Garage',
    ]);
    expect(model(schema, 'Vehicle').fields.map((f: IrField) => f.name)).toEqual(
      ['id', 'name', 'plate', 'electric', 'kind']
    );
    expect(field(schema, 'Vehicle', 'kind')).toMatchObject({
      type: 'string',
      maxLength: 12,
      isNullable: false,
    });
    expect(field(schema, 'Vehicle', 'plate').isNullable).toBe(true);
    expect(field(schema, 'Vehicle', 'electric').isNullable).toBe(true);
    expect(relation(schema, 'Garage', 'car').targetModel).toBe('Vehicle');
    expect(
      warningsMatching(
        schema,
        'Vehicle: single-table inheritance was flattened'
      )
    ).toHaveLength(1);
    expect(
      warningsMatching(schema, 'discriminator map (2 entries)')
    ).toHaveLength(1);
  });

  it('converts joined-table inheritance to a one-to-one primary key', async () => {
    const schema: IrSchema = await parse(`
      #[ORM\\Entity]
      #[ORM\\InheritanceType('JOINED')]
      #[ORM\\DiscriminatorColumn(name: 'kind', type: 'string')]
      #[ORM\\DiscriminatorMap(['person' => Person::class, 'employee' => Employee::class])]
      class Person { ${ID} #[ORM\\Column(length: 20)] private string $name; }
      #[ORM\\Entity] #[ORM\\Table(name: 'staff')] class Employee extends Person { #[ORM\\Column(length: 9)] private string $badge; }
    `);
    expect(schema.models.map((m: IrModel) => m.name)).toEqual([
      'Person',
      'Employee',
    ]);
    expect(model(schema, 'Employee').tableName).toBe('staff');
    expect(
      model(schema, 'Employee').fields.map((f: IrField) => f.name)
    ).toEqual(['badge']);
    expect(relation(schema, 'Employee', 'person_ptr')).toMatchObject({
      kind: 'oneToOne',
      targetModel: 'Person',
      columnName: 'id',
      isPrimaryKey: true,
      isNullable: false,
      onDelete: 'cascade',
    });
    expect(field(schema, 'Person', 'kind').maxLength).toBe(255);
    expect(
      warningsMatching(
        schema,
        'Employee: joined-table inheritance from "Person"'
      )
    ).toHaveLength(1);
  });

  it('skips a class that has mapped properties but no class attribute, with a warning', async () => {
    const schema: IrSchema = await parse(`
      #[ORM\\Entity] class Real { ${ID} }
      class Forgotten { #[ORM\\Column] private string $x; }
    `);
    expect(schema.models.map((m: IrModel) => m.name)).toEqual(['Real']);
    expect(
      warningsMatching(
        schema,
        'Forgotten: the class has Doctrine mapping attributes'
      )
    ).toHaveLength(1);
  });
});
