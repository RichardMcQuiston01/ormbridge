import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { IrField, IrModel, IrSchema } from '../src/ir.js';
import {
  parseDoctrine,
  type DoctrineSourceFile,
} from '../src/parsers/doctrine.js';
import { expectOk } from './helpers.js';

const HEADER: string = `<?php
namespace App\\Entity;

use App\\Enum\\Status;
use Doctrine\\DBAL\\Types\\Types;
use Doctrine\\ORM\\Mapping as ORM;

`;

async function parse(...bodies: string[]): Promise<IrSchema> {
  const sources: DoctrineSourceFile[] = bodies.map(
    (text: string, index: number): DoctrineSourceFile => ({
      path: `File${index}.php`,
      text: index === 0 ? HEADER + text : text,
    })
  );
  return expectOk(await parseDoctrine(sources, { appLabel: 'app' }));
}

function field(schema: IrSchema, modelName: string, name: string): IrField {
  const found: IrField | undefined = schema.models
    .find((candidate: IrModel) => candidate.name === modelName)
    ?.fields.find((candidate: IrField) => candidate.name === name);
  if (found === undefined) {
    throw new Error(`Field ${modelName}.${name} was not parsed`);
  }
  return found;
}

const STATUS_ENUM: string = `<?php
namespace App\\Enum;

enum Status: string
{
    case Draft = 'draft';
    case Published = 'published';
}
`;

const ID: string = `
  #[ORM\\Id, ORM\\GeneratedValue, ORM\\Column]
  private ?int $id = null;
`;

function entity(body: string): string {
  return `#[ORM\\Entity] #[ORM\\HasLifecycleCallbacks] class Thing { ${ID} ${body} }`;
}

describe('lifecycle callbacks', () => {
  it('reads a PreUpdate timestamp assignment as "updated automatically"', async () => {
    const schema: IrSchema = await parse(
      entity(`
        #[ORM\\Column(name: 'updated_at', type: Types::DATETIME_IMMUTABLE)]
        private \\DateTimeImmutable $updatedAt;
        #[ORM\\PreUpdate]
        public function touch(): void { $this->updatedAt = new \\DateTimeImmutable(); }
      `)
    );
    expect(field(schema, 'Thing', 'updatedAt').isAutoUpdated).toBe(true);
    expect(field(schema, 'Thing', 'updatedAt').default).toBeUndefined();
    expect(schema.warnings).toEqual([]);
  });

  it('treats a callback for both events as auto-updated without a default', async () => {
    const schema: IrSchema = await parse(
      entity(`
        #[ORM\\Column(type: Types::DATETIME_IMMUTABLE)]
        private \\DateTimeImmutable $updatedAt;
        #[ORM\\PrePersist, ORM\\PreUpdate]
        public function refresh(): void { $this->updatedAt = new \\DateTime(); }
      `)
    );
    const updated: IrField = field(schema, 'Thing', 'updatedAt');
    expect(updated.isAutoUpdated).toBe(true);
    expect(updated.default).toBeUndefined();
  });

  it('treats a PrePersist-only timestamp as a "now" default', async () => {
    const schema: IrSchema = await parse(
      entity(`
        #[ORM\\Column(type: Types::DATETIME_IMMUTABLE)]
        private \\DateTimeImmutable $createdAt;
        #[ORM\\PrePersist]
        public function stamp(): void { $this->createdAt = new \\DateTimeImmutable('now'); }
      `)
    );
    const created: IrField = field(schema, 'Thing', 'createdAt');
    expect(created.isAutoUpdated).toBe(false);
    expect(created.default).toEqual({ kind: 'now' });
  });

  it('ignores other statements and warns about them', async () => {
    const schema: IrSchema = await parse(
      entity(`
        #[ORM\\Column(type: Types::DATETIME_IMMUTABLE)]
        private \\DateTimeImmutable $updatedAt;
        #[ORM\\PreUpdate]
        public function touch(): void {
          $this->audit();
          $this->updatedAt = $this->clock->now();
        }
      `)
    );
    expect(field(schema, 'Thing', 'updatedAt').isAutoUpdated).toBe(false);
    const warnings: string[] = schema.warnings.filter((warning: string) =>
      warning.includes('Thing::touch')
    );
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain('$this->audit();');
  });

  it('ignores methods without a lifecycle attribute', async () => {
    const schema: IrSchema = await parse(
      entity(`
        #[ORM\\Column(type: Types::DATETIME_IMMUTABLE)]
        private \\DateTimeImmutable $updatedAt;
        public function touch(): void { $this->updatedAt = new \\DateTimeImmutable(); }
      `)
    );
    expect(field(schema, 'Thing', 'updatedAt').isAutoUpdated).toBe(false);
  });
});

describe('constructor assignments', () => {
  it('reads the values the Doctrine writer produces', async () => {
    const schema: IrSchema = await parse(
      entity(`
        #[ORM\\Column(type: Types::GUID)]
        private string $publicId;
        #[ORM\\Column(type: Types::STRING, length: 20, enumType: Status::class)]
        private Status $status;
        #[ORM\\Column(type: Types::DATETIME_IMMUTABLE)]
        private \\DateTimeImmutable $seenAt;
        #[ORM\\Column(type: Types::DATE_IMMUTABLE)]
        private \\DateTimeImmutable $day;
        #[ORM\\Column(type: Types::JSON)]
        private array $metadata;
        public function __construct() {
          $this->publicId = self::generateUuid();
          $this->status = Status::Draft;
          $this->seenAt = new \\DateTimeImmutable();
          $this->day = new \\DateTimeImmutable('2024-01-31');
          $this->metadata = [];
        }
        private static function generateUuid(): string { return 'x'; }
      `),
      STATUS_ENUM
    );
    expect(field(schema, 'Thing', 'publicId').default).toEqual({
      kind: 'uuid',
    });
    expect(field(schema, 'Thing', 'status').default).toEqual({
      kind: 'enumValue',
      value: 'Draft',
    });
    expect(field(schema, 'Thing', 'seenAt').default).toEqual({ kind: 'now' });
    expect(field(schema, 'Thing', 'day').default).toEqual({
      kind: 'literal',
      value: '2024-01-31',
    });
    expect(field(schema, 'Thing', 'metadata').default).toEqual({
      kind: 'literal',
      value: '[]',
    });
    expect(schema.warnings).toEqual([]);
  });

  it('accepts common hand-written UUID spellings and scalar literals', async () => {
    const schema: IrSchema = await parse(
      entity(`
        #[ORM\\Column(type: Types::GUID)]
        private string $a;
        #[ORM\\Column(type: Types::GUID)]
        private string $b;
        #[ORM\\Column(type: Types::INTEGER)]
        private int $views;
        #[ORM\\Column(type: Types::BOOLEAN)]
        private bool $live;
        #[ORM\\Column(type: Types::STRING, length: 10)]
        private string $label;
        #[ORM\\Column(type: Types::JSON)]
        private array $settings;
        public function __construct() {
          $this->a = \\Symfony\\Component\\Uid\\Uuid::v4()->toRfc4122();
          $this->b = Uuid::uuid4()->toString();
          $this->views = 3;
          $this->live = true;
          $this->label = "new";
          $this->settings = ['theme' => 'dark', 'sizes' => [1, 2]];
        }
      `)
    );
    expect(field(schema, 'Thing', 'a').default).toEqual({ kind: 'uuid' });
    expect(field(schema, 'Thing', 'b').default).toEqual({ kind: 'uuid' });
    expect(field(schema, 'Thing', 'views').default).toEqual({
      kind: 'literal',
      value: 3,
    });
    expect(field(schema, 'Thing', 'live').default).toEqual({
      kind: 'literal',
      value: true,
    });
    expect(field(schema, 'Thing', 'label').default).toEqual({
      kind: 'literal',
      value: 'new',
    });
    expect(field(schema, 'Thing', 'settings').default).toEqual({
      kind: 'literal',
      value: '{"theme":"dark","sizes":[1,2]}',
    });
  });

  it('keeps a column default over a constructor assignment', async () => {
    const schema: IrSchema = await parse(
      entity(`
        #[ORM\\Column(type: Types::INTEGER, options: ['default' => 5])]
        private int $views;
        public function __construct() { $this->views = 9; }
      `)
    );
    expect(field(schema, 'Thing', 'views').default).toEqual({
      kind: 'literal',
      value: 5,
    });
  });

  it('skips values it cannot evaluate, with a warning', async () => {
    const schema: IrSchema = await parse(
      entity(`
        #[ORM\\Column(type: Types::INTEGER)]
        private int $views;
        #[ORM\\Column(type: Types::STRING, length: 10)]
        private string $code;
        public function __construct() {
          $this->views = $this->compute();
          $this->code = self::DEFAULT_CODE;
          $this->items = new ArrayCollection();
        }
      `)
    );
    expect(field(schema, 'Thing', 'views').default).toBeUndefined();
    expect(field(schema, 'Thing', 'code').default).toBeUndefined();
    expect(
      schema.warnings.filter((warning: string) => warning.includes('Thing.'))
    ).toHaveLength(2);
  });
});

describe('property initialisers', () => {
  it('reads scalar, null and empty array initialisers', async () => {
    const schema: IrSchema = await parse(
      entity(`
        #[ORM\\Column(type: Types::INTEGER)]
        private int $views = 0;
        #[ORM\\Column(type: Types::FLOAT)]
        private float $ratio = 1.5;
        #[ORM\\Column(type: Types::BOOLEAN)]
        private bool $live = false;
        #[ORM\\Column(type: Types::STRING, length: 10, nullable: true)]
        private ?string $note = null;
        #[ORM\\Column(type: Types::JSON)]
        private array $metadata = [];
        #[ORM\\Column(type: Types::STRING, length: 20, enumType: Status::class)]
        private Status $status = Status::Published;
      `),
      STATUS_ENUM
    );
    expect(field(schema, 'Thing', 'views').default).toEqual({
      kind: 'literal',
      value: 0,
    });
    expect(field(schema, 'Thing', 'ratio').default).toEqual({
      kind: 'literal',
      value: 1.5,
    });
    expect(field(schema, 'Thing', 'live').default).toEqual({
      kind: 'literal',
      value: false,
    });
    expect(field(schema, 'Thing', 'note').default).toBeUndefined();
    expect(field(schema, 'Thing', 'metadata').default).toEqual({
      kind: 'literal',
      value: '[]',
    });
    expect(field(schema, 'Thing', 'status').default).toEqual({
      kind: 'enumValue',
      value: 'Published',
    });
  });

  it('lets a constructor assignment override an initialiser', async () => {
    const schema: IrSchema = await parse(
      entity(`
        #[ORM\\Column(type: Types::INTEGER)]
        private int $views = 1;
        public function __construct() { $this->views = 2; }
      `)
    );
    expect(field(schema, 'Thing', 'views').default).toEqual({
      kind: 'literal',
      value: 2,
    });
  });
});

describe('behaviour fixture', () => {
  it('reads the callbacks and constructor defaults of test/fixtures/doctrine-behaviour', async () => {
    const read = (name: string): DoctrineSourceFile => ({
      path: name,
      text: readFileSync(
        fileURLToPath(
          new URL(`./fixtures/doctrine-behaviour/${name}`, import.meta.url)
        ),
        'utf8'
      ),
    });
    const schema: IrSchema = expectOk(
      await parseDoctrine([read('Article.php'), read('Status.php')], {
        appLabel: 'app',
      })
    );
    expect(field(schema, 'Article', 'publicId').default).toEqual({
      kind: 'uuid',
    });
    expect(field(schema, 'Article', 'status').default).toEqual({
      kind: 'enumValue',
      value: 'Draft',
    });
    expect(field(schema, 'Article', 'metadata').default).toEqual({
      kind: 'literal',
      value: '[]',
    });
    expect(field(schema, 'Article', 'views').default).toEqual({
      kind: 'literal',
      value: 0,
    });
    expect(field(schema, 'Article', 'published').default).toEqual({
      kind: 'literal',
      value: false,
    });
    expect(field(schema, 'Article', 'label').default).toEqual({
      kind: 'literal',
      value: 'untitled',
    });
    expect(field(schema, 'Article', 'importedAt').default).toEqual({
      kind: 'now',
    });
    expect(field(schema, 'Article', 'createdAt').default).toEqual({
      kind: 'now',
    });
    expect(field(schema, 'Article', 'updatedAt').isAutoUpdated).toBe(true);
    expect(field(schema, 'Article', 'slug').default).toBeUndefined();
    const warnings: string[] = schema.warnings.filter((warning: string) =>
      warning.includes('Article')
    );
    expect(warnings).toHaveLength(2);
    expect(warnings.join('\n')).toContain('Article::touch');
    expect(warnings.join('\n')).toContain('Article.slug');
  });
});
