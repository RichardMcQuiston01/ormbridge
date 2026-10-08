import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { convertText, type ConvertResult } from '../src/convert.js';
import { emitDjango } from '../src/emitters/django.js';
import type { IrField, IrModel, IrSchema } from '../src/ir.js';
import { parseDjango } from '../src/parsers/django.js';
import type { Result } from '../src/result.js';
import { DEFAULT_OPTIONS, expectOk } from './helpers.js';

const FIXTURE_PATH: string = fileURLToPath(
  new URL('./fixtures/django-extras/models.py', import.meta.url)
);
const GOLDEN_DIRECTORY: string = fileURLToPath(
  new URL('./golden-extras/', import.meta.url)
);

/** Compares text with test/golden-extras/<name>; run with UPDATE_GOLDEN=1 to rewrite it. */
function expectMatchesExtrasGolden(name: string, actual: string): void {
  const goldenPath: string = `${GOLDEN_DIRECTORY}${name}`;
  if (process.env.UPDATE_GOLDEN === '1') {
    mkdirSync(dirname(goldenPath), { recursive: true });
    writeFileSync(goldenPath, actual);
    return;
  }
  if (!existsSync(goldenPath)) {
    throw new Error(
      `Golden file test/golden-extras/${name} does not exist. Run the tests with UPDATE_GOLDEN=1 to create it.`
    );
  }
  expect(actual).toBe(readFileSync(goldenPath, 'utf8'));
}

function fixtureText(): string {
  return readFileSync(FIXTURE_PATH, 'utf8');
}

async function convertExtras(
  to: string,
  overrides: Partial<typeof DEFAULT_OPTIONS> = {}
): Promise<ConvertResult> {
  const result: Result<ConvertResult> = await convertText(
    [{ path: FIXTURE_PATH, text: fixtureText() }],
    { ...DEFAULT_OPTIONS, appLabel: 'shop', ...overrides, from: 'django', to }
  );
  return expectOk(result);
}

async function parseSnippet(text: string): Promise<IrSchema> {
  return expectOk(
    await parseDjango([{ path: 'models.py', text, appLabel: 'shop' }], {
      autoField: 'int',
    })
  );
}

function fieldOf(schema: IrSchema, modelName: string, name: string): IrField {
  const model: IrModel | undefined = schema.models.find(
    (candidate: IrModel) => candidate.name === modelName
  );
  const field: IrField | undefined = model?.fields.find(
    (candidate: IrField) => candidate.name === name
  );
  if (field === undefined) {
    throw new Error(`Field ${modelName}.${name} was not parsed.`);
  }
  return field;
}

function wrap(body: string): string {
  return `from django.db import models\nfrom django.contrib.postgres.fields import *\n\n\nclass Thing(models.Model):\n${body
    .split('\n')
    .map((line: string) => `    ${line}`)
    .join('\n')}\n`;
}

describe('Django parser: field types', () => {
  it('parses ArrayField, including nested arrays and the base_field options', async () => {
    const schema: IrSchema = await parseSnippet(
      wrap(
        [
          'tags = ArrayField(models.CharField(max_length=20), default=list)',
          'grid = ArrayField(ArrayField(models.IntegerField()), null=True)',
          'named = ArrayField(base_field=models.DecimalField(max_digits=5, decimal_places=2))',
        ].join('\n')
      )
    );
    expect(fieldOf(schema, 'Thing', 'tags')).toMatchObject({
      type: 'string',
      maxLength: 20,
      arrayDepth: 1,
      default: { kind: 'literal', value: '[]' },
    });
    expect(fieldOf(schema, 'Thing', 'grid')).toMatchObject({
      type: 'int',
      arrayDepth: 2,
      isNullable: true,
    });
    expect(fieldOf(schema, 'Thing', 'named')).toMatchObject({
      type: 'decimal',
      maxDigits: 5,
      decimalPlaces: 2,
      arrayDepth: 1,
    });
    expect(schema.warnings).toEqual([]);
  });

  it('warns, naming model and field, when an ArrayField has no readable base_field', async () => {
    const schema: IrSchema = await parseSnippet(
      wrap('broken = ArrayField(some_base)')
    );
    expect(fieldOf(schema, 'Thing', 'broken')).toMatchObject({
      type: 'string',
      arrayDepth: 1,
    });
    expect(schema.warnings.join('\n')).toContain('Thing.broken');
  });

  it('parses HStoreField and every range field', async () => {
    const schema: IrSchema = await parseSnippet(
      wrap(
        [
          'attrs = HStoreField(default=dict)',
          'a = IntegerRangeField()',
          'b = BigIntegerRangeField()',
          'c = DecimalRangeField()',
          'd = DateRangeField()',
          'e = DateTimeRangeField(null=True)',
        ].join('\n')
      )
    );
    expect(fieldOf(schema, 'Thing', 'attrs')).toMatchObject({
      type: 'hstore',
      default: { kind: 'literal', value: '{}' },
    });
    const subtypes: (string | undefined)[] = ['a', 'b', 'c', 'd', 'e'].map(
      (name: string) => fieldOf(schema, 'Thing', name).rangeOf
    );
    expect(subtypes).toEqual(['int', 'bigInt', 'decimal', 'date', 'dateTime']);
    expect(fieldOf(schema, 'Thing', 'e').isNullable).toBe(true);
  });

  it('parses IP address, duration, file and small integer fields without warnings', async () => {
    const schema: IrSchema = await parseSnippet(
      wrap(
        [
          'ip = models.GenericIPAddressField(protocol="IPv4")',
          'old_ip = models.IPAddressField()',
          'span = models.DurationField()',
          'path = models.FilePathField(path="/tmp")',
          'doc = models.FileField(upload_to="docs/")',
          'img = models.ImageField(upload_to="img/")',
          'small = models.SmallIntegerField()',
          'tiny = models.PositiveSmallIntegerField()',
          'code = models.SmallAutoField(primary_key=True)',
        ].join('\n')
      )
    );
    expect(fieldOf(schema, 'Thing', 'ip').type).toBe('ipAddress');
    expect(fieldOf(schema, 'Thing', 'old_ip').type).toBe('ipAddress');
    expect(fieldOf(schema, 'Thing', 'span').type).toBe('duration');
    expect(fieldOf(schema, 'Thing', 'path')).toMatchObject({
      type: 'string',
      maxLength: 100,
    });
    expect(fieldOf(schema, 'Thing', 'doc')).toMatchObject({
      type: 'string',
      maxLength: 100,
    });
    expect(fieldOf(schema, 'Thing', 'img').type).toBe('string');
    expect(fieldOf(schema, 'Thing', 'small').type).toBe('int');
    expect(fieldOf(schema, 'Thing', 'tiny').type).toBe('int');
    expect(fieldOf(schema, 'Thing', 'code')).toMatchObject({
      type: 'int',
      isPrimaryKey: true,
      default: { kind: 'autoIncrement' },
    });
    expect(schema.warnings).toEqual([]);
  });
});

describe('Django parser: GeneratedField and db_default', () => {
  it('carries the expression text and persistence of a GeneratedField', async () => {
    const schema: IrSchema = await parseSnippet(
      wrap(
        [
          'a = models.IntegerField()',
          'double = models.GeneratedField(',
          '    expression=F("a") * 2,',
          '    output_field=models.IntegerField(),',
          '    db_persist=True,',
          ')',
          'virtual = models.GeneratedField(expression=Lower("name"), output_field=models.CharField(max_length=5), db_persist=False)',
        ].join('\n')
      )
    );
    expect(fieldOf(schema, 'Thing', 'double')).toMatchObject({
      type: 'int',
      generated: { expression: 'F("a") * 2', isStored: true },
    });
    expect(fieldOf(schema, 'Thing', 'virtual')).toMatchObject({
      type: 'string',
      maxLength: 5,
      generated: { expression: 'Lower("name")', isStored: false },
    });
    expect(schema.warnings).toEqual([]);
  });

  it('warns when a GeneratedField has no readable output_field or expression', async () => {
    const schema: IrSchema = await parseSnippet(
      wrap(
        [
          'no_output = models.GeneratedField(expression=F("a"))',
          'no_expr = models.GeneratedField(output_field=models.IntegerField())',
        ].join('\n')
      )
    );
    expect(fieldOf(schema, 'Thing', 'no_output').type).toBe('string');
    expect(fieldOf(schema, 'Thing', 'no_expr').generated).toBeUndefined();
    expect(schema.warnings.join('\n')).toContain('Thing.no_output');
    expect(schema.warnings.join('\n')).toContain('Thing.no_expr');
  });

  it('reads db_default values and marks them as database-level', async () => {
    const schema: IrSchema = await parseSnippet(
      wrap(
        [
          'flag = models.BooleanField(db_default=True)',
          'when = models.DateTimeField(db_default=Now())',
          'count = models.IntegerField(db_default=Value(5))',
          'label = models.CharField(max_length=5, db_default="x")',
          'tags = ArrayField(models.IntegerField(), db_default=[])',
          'both = models.IntegerField(default=1, db_default=2)',
          'odd = models.IntegerField(db_default=Func(F("a"), function="ABS"))',
        ].join('\n')
      )
    );
    expect(fieldOf(schema, 'Thing', 'flag')).toMatchObject({
      default: { kind: 'literal', value: true },
      isDbDefault: true,
    });
    expect(fieldOf(schema, 'Thing', 'when').default).toEqual({ kind: 'now' });
    expect(fieldOf(schema, 'Thing', 'count').default).toEqual({
      kind: 'literal',
      value: 5,
    });
    expect(fieldOf(schema, 'Thing', 'label').default).toEqual({
      kind: 'literal',
      value: 'x',
    });
    expect(fieldOf(schema, 'Thing', 'tags').default).toEqual({
      kind: 'literal',
      value: '[]',
    });
    const both: IrField = fieldOf(schema, 'Thing', 'both');
    expect(both.default).toEqual({ kind: 'literal', value: 1 });
    expect(both.isDbDefault).toBeUndefined();
    expect(fieldOf(schema, 'Thing', 'odd').default).toBeUndefined();
    const warnings: string = schema.warnings.join('\n');
    expect(warnings).toContain('Thing.both: db_default was ignored');
    expect(warnings).toContain('Thing.odd: db_default=Func(...)');
  });
});

describe('Django parser: model constructs', () => {
  const MODELS: string = `
from django.db import models
from django.conf import settings


class QS(models.QuerySet):
    def live(self):
        return self


class LiveManager(models.Manager):
    def get_queryset(self):
        return super().get_queryset()


class Base(models.Model):
    name = models.CharField(max_length=10)
    objects = models.Manager()
    live = LiveManager()
    qs = QS.as_manager()
    mixed = LiveManager.from_queryset(QS)()


class BaseProxy(Base):
    class Meta:
        proxy = True


class BaseProxyProxy(BaseProxy):
    class Meta:
        proxy = True


class Child(models.Model):
    parent = models.ForeignKey(BaseProxyProxy, on_delete=models.CASCADE)
    owner = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE)


class Member(models.Model):
    email = models.EmailField()

    class Meta:
        swappable = "AUTH_USER_MODEL"
`;

  it('ignores managers and querysets without warnings or extra models', async () => {
    const schema: IrSchema = await parseSnippet(MODELS);
    expect(schema.models.map((model: IrModel) => model.name)).toEqual([
      'Base',
      'Child',
      'Member',
    ]);
    expect(
      schema.warnings.filter((warning: string) => /manager|QS/i.test(warning))
    ).toEqual([]);
    expect(fieldOf(schema, 'Base', 'name').columnName).toBe('name');
  });

  it('merges proxy models into their concrete model and retargets relations', async () => {
    const schema: IrSchema = await parseSnippet(MODELS);
    const child: IrModel | undefined = schema.models.find(
      (model: IrModel) => model.name === 'Child'
    );
    expect(child?.relations.find((r) => r.name === 'parent')?.targetModel).toBe(
      'Base'
    );
    const warnings: string = schema.warnings.join('\n');
    expect(warnings).toContain(
      'BaseProxy: proxy model of "Base" has no table of its own'
    );
    expect(warnings).toContain('BaseProxyProxy: proxy model of "Base"');
  });

  it('resolves AUTH_USER_MODEL to the swappable model without assuming "User"', async () => {
    const schema: IrSchema = await parseSnippet(MODELS);
    const child: IrModel | undefined = schema.models.find(
      (model: IrModel) => model.name === 'Child'
    );
    expect(child?.relations.find((r) => r.name === 'owner')?.targetModel).toBe(
      'Member'
    );
    expect(schema.models.some((model: IrModel) => model.name === 'User')).toBe(
      false
    );
    expect(schema.warnings.join('\n')).not.toContain('AUTH_USER_MODEL');
  });

  it('retargets a proxy of an external model to that model and stubs it', async () => {
    const schema: IrSchema = await parseSnippet(`
from django.contrib.auth.models import User
from django.db import models


class Staff(User):
    class Meta:
        proxy = True


class Note(models.Model):
    author = models.ForeignKey(Staff, on_delete=models.CASCADE)
`);
    const note: IrModel | undefined = schema.models.find(
      (model: IrModel) => model.name === 'Note'
    );
    expect(note?.relations[0]?.targetModel).toBe('User');
    expect(schema.models.some((model: IrModel) => model.name === 'User')).toBe(
      true
    );
  });

  it('reads models.CompositePrimaryKey and skips the automatic id', async () => {
    const schema: IrSchema = await parseSnippet(`
from django.db import models


class Pair(models.Model):
    pk = models.CompositePrimaryKey("a", "b")
    a = models.IntegerField()
    b = models.IntegerField()
`);
    const pair: IrModel | undefined = schema.models[0];
    expect(pair?.compositePrimaryKey).toEqual(['a', 'b']);
    expect(pair?.fields.map((field: IrField) => field.name)).toEqual([
      'a',
      'b',
    ]);
  });

  it('skips partial unique constraints with a warning instead of making them unconditional', async () => {
    const schema: IrSchema = await parseSnippet(`
from django.db import models


class Thing(models.Model):
    a = models.IntegerField()
    b = models.IntegerField()

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["a"], condition=models.Q(b=1), name="partial"),
            models.UniqueConstraint(fields=["a", "b"], name="full"),
        ]
`);
    expect(schema.models[0]?.indexes).toEqual([
      { fields: ['a', 'b'], isUnique: true, name: 'full' },
    ]);
    expect(schema.warnings.join('\n')).toContain('partial unique constraint');
  });
});

describe('Django emitter', () => {
  function modelWith(...fields: IrField[]): IrSchema {
    const model: IrModel = {
      name: 'Thing',
      tableName: 'shop_thing',
      appLabel: 'shop',
      fields: [
        {
          name: 'id',
          columnName: 'id',
          type: 'int',
          isPrimaryKey: true,
          isUnique: false,
          isNullable: false,
          isAutoUpdated: false,
          default: { kind: 'autoIncrement' },
        },
        ...fields,
      ],
      relations: [],
      indexes: [],
    };
    return { models: [model], enums: [], warnings: [] };
  }

  function field(overrides: Partial<IrField> & { name: string }): IrField {
    return {
      columnName: overrides.name,
      type: 'string',
      isPrimaryKey: false,
      isUnique: false,
      isNullable: false,
      isAutoUpdated: false,
      ...overrides,
    };
  }

  it('writes arrays, hstore and ranges with the postgres import', () => {
    const output = emitDjango(
      modelWith(
        field({ name: 'tags', maxLength: 9, arrayDepth: 1 }),
        field({ name: 'grid', type: 'int', arrayDepth: 2, isNullable: true }),
        field({
          name: 'attrs',
          type: 'hstore',
          default: { kind: 'literal', value: '{}' },
        }),
        field({ name: 'span', type: 'range', rangeOf: 'date' })
      )
    );
    expect(output.text).toContain(
      'from django.contrib.postgres.fields import ArrayField, DateRangeField, HStoreField'
    );
    expect(output.text).toContain(
      'tags = ArrayField(models.CharField(max_length=9))'
    );
    expect(output.text).toContain(
      'grid = ArrayField(ArrayField(models.IntegerField()), null=True, blank=True)'
    );
    expect(output.text).toContain('attrs = HStoreField(default=dict)');
    expect(output.text).toContain('span = DateRangeField()');
    expect(output.warnings.join('\n')).toContain('Thing.tags');
  });

  it('writes GeneratedField with its expression, imports and persistence', () => {
    const output = emitDjango(
      modelWith(
        field({
          name: 'upper_name',
          maxLength: 5,
          generated: { expression: 'Upper(F("name"))', isStored: false },
        })
      )
    );
    expect(output.text).toContain(
      'upper_name = models.GeneratedField(expression=Upper(F("name")), output_field=models.CharField(max_length=5), db_persist=False)'
    );
    expect(output.text).toContain('from django.db.models import F');
    expect(output.text).toContain(
      'from django.db.models.functions import Upper'
    );
    expect(output.warnings.join('\n')).toContain('Thing.upper_name');
  });

  it('writes db_default for database-level defaults', () => {
    const output = emitDjango(
      modelWith(
        field({
          name: 'flag',
          type: 'boolean',
          default: { kind: 'literal', value: true },
          isDbDefault: true,
        }),
        field({
          name: 'stamp',
          type: 'dateTime',
          default: { kind: 'now' },
          isDbDefault: true,
        })
      )
    );
    expect(output.text).toContain(
      'flag = models.BooleanField(db_default=True)'
    );
    expect(output.text).toContain(
      'stamp = models.DateTimeField(db_default=Now())'
    );
    expect(output.text).toContain('from django.db.models.functions import Now');
  });

  it('writes duration and IP address fields', () => {
    const output = emitDjango(
      modelWith(
        field({ name: 'span', type: 'duration' }),
        field({ name: 'ip', type: 'ipAddress', isNullable: true })
      )
    );
    expect(output.text).toContain('span = models.DurationField()');
    expect(output.text).toContain(
      'ip = models.GenericIPAddressField(null=True, blank=True)'
    );
  });
});

describe('Django round trip of the extras fixture', () => {
  it('re-parses the emitted models to the same IR for representable constructs', async () => {
    const first: IrSchema = expectOk(
      await parseDjango(
        [{ path: FIXTURE_PATH, text: fixtureText(), appLabel: 'shop' }],
        { autoField: 'int' }
      )
    );
    const emitted = emitDjango(first);
    const second: IrSchema = expectOk(
      await parseDjango(
        [{ path: 'models.py', text: emitted.text, appLabel: 'shop' }],
        { autoField: 'int' }
      )
    );
    const item = (schema: IrSchema): IrModel => {
      const found: IrModel | undefined = schema.models.find(
        (model: IrModel) => model.name === 'Item'
      );
      if (found === undefined) {
        throw new Error('Item was not parsed.');
      }
      return found;
    };
    const keep = [
      'full_name',
      'total_cents',
      'tags',
      'grid',
      'kinds',
      'attributes',
      'stock_range',
      'big_range',
      'price_range',
      'available',
      'valid_during',
      'last_ip',
      'legacy_ip',
      'shelf_life',
      'is_active',
      'stocked_at',
      'priority',
      'note',
    ];
    const pick = (schema: IrSchema): IrField[] =>
      item(schema).fields.filter((candidate: IrField) =>
        keep.includes(candidate.name)
      );
    expect(pick(second)).toEqual(pick(first));
    const assignment = second.models.find(
      (model: IrModel) => model.name === 'Assignment'
    );
    expect(assignment?.compositePrimaryKey).toEqual(['item', 'account']);
    expect(emitDjango(second).text).toBe(emitted.text);
  });

  it('matches the stored Django output', async () => {
    const parsed: IrSchema = expectOk(
      await parseDjango(
        [{ path: FIXTURE_PATH, text: fixtureText(), appLabel: 'shop' }],
        { autoField: 'int' }
      )
    );
    expectMatchesExtrasGolden('django-roundtrip.txt', emitDjango(parsed).text);
  });
});

describe.each([
  ['prisma', 'prisma.txt'],
  ['typeorm', 'typeorm.txt'],
  ['typescript', 'typescript.txt'],
  ['graphene', 'graphene.txt'],
])('Django extras -> %s', (target, goldenName) => {
  it('matches the stored output', async () => {
    const { output } = await convertExtras(target);
    expectMatchesExtrasGolden(`django-to-${goldenName}`, output);
  });
});

describe('Django extras: degradation warnings', () => {
  it('Prisma maps scalar lists and names the fields it cannot represent', async () => {
    const { output, warnings } = await convertExtras('prisma');
    expect(output).toMatch(/tags\s+String\[\]\s+@default\(\[\]\)/);
    expect(output).toMatch(/kinds\s+ItemKind\[\]/);
    expect(output).toMatch(/grid\s+Json\?/);
    expect(output).toMatch(/stock_range\s+Unsupported\("int4range"\)\?/);
    expect(output).toMatch(/last_ip\s+String\?\s+@db\.Inet/);
    const text: string = warnings.join('\n');
    expect(text).toContain('Item.grid: Prisma supports only one-dimensional');
    expect(text).toContain('Item.attributes: Prisma has no hstore type');
    expect(text).toContain('Item.shelf_life: Prisma has no interval type');
    expect(text).toContain('Item.full_name: the generated column expression');
  });

  it('Prisma on MySQL writes arrays as Json and ranges as String', async () => {
    const { output, warnings } = await convertExtras('prisma', {
      provider: 'mysql',
    });
    expect(output).toMatch(/tags\s+Json\s/);
    expect(output).toMatch(/stock_range\s+String\?/);
    expect(warnings.join('\n')).toContain(
      'Item.tags: mysql has no scalar list type in Prisma'
    );
  });

  it('TypeORM uses array columns and postgres range types', async () => {
    const { output, warnings } = await convertExtras('typeorm');
    expect(output).toContain(
      `@Column({ type: 'varchar', length: 20, array: true, default: () => "'{}'" })`
    );
    expect(output).toContain('grid!: number[][] | null;');
    expect(output).toContain(`type: 'int4range'`);
    expect(output).toContain(`type: 'interval'`);
    expect(warnings.join('\n')).toContain('Item.full_name');
  });

  it('TypeORM on MySQL falls back to json with a warning', async () => {
    const { output, warnings } = await convertExtras('typeorm', {
      provider: 'mysql',
    });
    expect(output).toContain(`type: 'json'`);
    expect(warnings.join('\n')).toContain(
      'Item.tags: mysql has no array column type'
    );
    expect(warnings.join('\n')).toContain('Item.stock_range');
  });

  it('TypeScript types arrays, hstore and ranges', async () => {
    const { output } = await convertExtras('typescript');
    expect(output).toContain('tags: string[];');
    expect(output).toContain('grid: number[][] | null;');
    expect(output).toContain('attributes: Record<string, string | null>;');
    expect(output).toContain('shelf_life: string | null;');
  });

  it('Graphene accepts lists and leaves generated fields out of the inputs', async () => {
    const { output } = await convertExtras('graphene');
    expect(output).toContain('tags = graphene.List(graphene.String)');
    expect(output).toContain(
      'grid = graphene.List(graphene.List(graphene.Int))'
    );
    expect(output).toContain('stock_range = graphene.List(graphene.Int)');
    expect(output).not.toMatch(/^ {4}full_name = /m);
  });

  it('does not warn about managers, ordering or proxy Meta options', async () => {
    const { warnings } = await convertExtras('prisma');
    expect(
      warnings.filter((warning: string) => /manager|ordering/i.test(warning))
    ).toEqual([]);
  });
});
