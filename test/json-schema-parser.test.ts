import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { convertText, type ConvertResult } from '../src/convert.js';
import { getFormat, getFormatByExtension } from '../src/formats.js';
import type {
  IrEnum,
  IrField,
  IrModel,
  IrRelation,
  IrSchema,
} from '../src/ir.js';
import { runConversion } from '../src/io.js';
import { parseJsonSchema } from '../src/parsers/jsonSchema.js';
import type { Result } from '../src/result.js';
import { loadCanonicalSources } from './harness.js';
import { DEFAULT_OPTIONS, expectOk } from './helpers.js';
import { compareIr, formatDifference } from './irCompare.js';

type Json = Record<string, unknown>;

/** Parses JSON Schema documents given as objects (or raw text); each is one file. */
function parseDocs(...documents: (Json | string)[]): Result<IrSchema> {
  return parseJsonSchema(
    documents.map((document: Json | string, index: number) => ({
      path: `doc${index}.json`,
      text: typeof document === 'string' ? document : JSON.stringify(document),
    })),
    { appLabel: 'app' }
  );
}

function parse(...documents: (Json | string)[]): IrSchema {
  return expectOk(parseDocs(...documents));
}

/** A document whose `$defs` hold the given schemas. */
function defs(entries: Json, extra: Json = {}): Json {
  return { $defs: entries, ...extra };
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

function field(schema: IrSchema, modelName: string, name: string): IrField {
  const found: IrField | undefined = model(schema, modelName).fields.find(
    (candidate: IrField) => candidate.name === name
  );
  if (found === undefined) {
    throw new Error(`No field ${modelName}.${name}.`);
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
    throw new Error(`No relation ${modelName}.${name}.`);
  }
  return found;
}

function enumNamed(schema: IrSchema, name: string): IrEnum {
  const found: IrEnum | undefined = schema.enums.find(
    (candidate: IrEnum) => candidate.name === name
  );
  if (found === undefined) {
    throw new Error(`No enum ${name}.`);
  }
  return found;
}

/** A model with an id and the given extra properties. */
function thing(properties: Json, extra: Json = {}): Json {
  return {
    type: 'object',
    properties: { id: { type: 'integer' }, ...properties },
    required: ['id', ...Object.keys(properties)],
    ...extra,
  };
}

const FIXTURES: string = fileURLToPath(
  new URL('./fixtures/json-schema/', import.meta.url)
);
const EXTRAS: string = fileURLToPath(
  new URL('./fixtures/json-schema-extras/', import.meta.url)
);

function readFixture(directory: string, name: string) {
  const path: string = join(directory, name);
  return { path, text: readFileSync(path, 'utf8') };
}

describe('registration', () => {
  it('registers a readable and writable json-schema format that claims no extension', () => {
    const adapter = expectOk(getFormat('json-schema'));
    expect(adapter.parse).toBeDefined();
    expect(adapter.emit).toBeDefined();
    expect(adapter.extensions).toEqual([]);
    expect(getFormatByExtension('.json')).toBeUndefined();
  });

  it('converts through convertText', async () => {
    const result: ConvertResult = expectOk(
      await convertText(loadCanonicalSources('json-schema'), {
        ...DEFAULT_OPTIONS,
        from: 'json-schema',
        to: 'typescript',
      })
    );
    expect(result.modelCount).toBe(5);
    expect(result.output).toContain('interface Post');
  });
});

describe('canonical blog fixture', () => {
  const schema: IrSchema = expectOk(
    parseJsonSchema(loadCanonicalSources('json-schema'), { appLabel: 'blog' })
  );

  it('reads the five models and the enum without warnings', () => {
    expect(schema.models.map((item: IrModel) => item.name)).toEqual([
      'Category',
      'Post',
      'Tag',
      'Profile',
      'User',
    ]);
    expect(schema.enums.map((item: IrEnum) => item.name)).toEqual([
      'PostStatus',
    ]);
    expect(schema.warnings).toEqual([]);
  });

  it('reads scalar columns', () => {
    expect(field(schema, 'Post', 'id')).toMatchObject({
      type: 'int',
      isPrimaryKey: true,
      default: { kind: 'autoIncrement' },
    });
    expect(field(schema, 'Post', 'title')).toMatchObject({
      type: 'string',
      maxLength: 200,
      isNullable: false,
    });
    expect(field(schema, 'Post', 'body').type).toBe('text');
    expect(field(schema, 'Post', 'rating')).toMatchObject({
      type: 'decimal',
      isNullable: true,
      maxDigits: 4,
      decimalPlaces: 2,
    });
    expect(field(schema, 'Post', 'public_id')).toMatchObject({
      type: 'uuid',
      isUnique: true,
      default: { kind: 'uuid' },
    });
    expect(field(schema, 'Post', 'status')).toMatchObject({
      enumName: 'PostStatus',
      default: { kind: 'enumValue', value: 'DRAFT' },
    });
    expect(field(schema, 'Post', 'updated_at').isAutoUpdated).toBe(true);
    expect(field(schema, 'Post', 'created_at').default).toEqual({
      kind: 'now',
    });
    expect(field(schema, 'Post', 'metadata')).toMatchObject({
      type: 'json',
      default: { kind: 'literal', value: '{}' },
    });
    expect(model(schema, 'Post').tableName).toBe('blog_post');
  });

  it('reads relations with their reverse names', () => {
    expect(relation(schema, 'Post', 'author')).toMatchObject({
      kind: 'foreignKey',
      targetModel: 'User',
      columnName: 'author_id',
      isNullable: false,
      onDelete: 'cascade',
      relatedName: 'posts',
    });
    expect(relation(schema, 'Post', 'editor')).toMatchObject({
      isNullable: true,
      onDelete: 'setNull',
      relatedName: 'edited_posts',
    });
    expect(relation(schema, 'Post', 'tags')).toMatchObject({
      kind: 'manyToMany',
      targetModel: 'Tag',
      relatedName: 'posts',
    });
    expect(relation(schema, 'Profile', 'user')).toMatchObject({
      kind: 'oneToOne',
      relatedName: 'profile',
    });
    expect(relation(schema, 'Category', 'parent')).toMatchObject({
      targetModel: 'Category',
      isNullable: true,
      relatedName: 'children',
    });
    // The reverse sides are not relations of their own.
    expect(model(schema, 'User').relations).toEqual([]);
    expect(model(schema, 'Tag').relations).toEqual([]);
  });

  it('reads indexes', () => {
    expect(model(schema, 'Post').indexes).toEqual([
      { fields: ['title'], isUnique: false },
      { fields: ['author', 'title'], isUnique: true },
      {
        fields: ['published_at', 'status'],
        isUnique: false,
        name: 'post_pub_status_idx',
      },
    ]);
  });

  async function canonicalIr(format: string): Promise<IrSchema> {
    const adapter = expectOk(getFormat(format));
    if (adapter.parse === undefined) {
      throw new Error(`${format} cannot be read.`);
    }
    return expectOk(
      await adapter.parse(loadCanonicalSources(format), DEFAULT_OPTIONS)
    );
  }

  it('describes the same schema as the canonical TypeORM fixture', async () => {
    expect(compareIr(await canonicalIr('typeorm'), schema)).toEqual([]);
  });

  it('describes the same schema as the canonical Prisma fixture, which spells the join table out', async () => {
    expect(
      compareIr(await canonicalIr('prisma'), schema).map(formatDifference)
    ).toEqual([
      'relationAdded Post.tags: (absent) -> manyToMany -> Tag',
      'modelRemoved PostTags: model PostTags -> (absent)',
    ]);
  });
});

describe('OpenAPI document', () => {
  it('reads the same schema as the JSON Schema fixture', () => {
    const jsonSchema: IrSchema = parse(
      readFixture(FIXTURES, 'blog.schema.json').text
    );
    const openApi: IrSchema = parse(
      readFixture(FIXTURES, 'blog.openapi.json').text
    );
    expect(compareIr(jsonSchema, openApi)).toEqual([]);
    expect(openApi.warnings).toEqual([]);
    expect(openApi.models.map((item: IrModel) => item.name)).toEqual(
      jsonSchema.models.map((item: IrModel) => item.name)
    );
    expect(field(openApi, 'Post', 'rating').isNullable).toBe(true);
    expect(relation(openApi, 'Post', 'editor').isNullable).toBe(true);
  });

  it('only reads components.schemas, not the document root', () => {
    const schema: IrSchema = parse({
      openapi: '3.1.0',
      info: { title: 'x', version: '1' },
      properties: { ignored: { type: 'string' } },
      components: { schemas: { Pet: thing({ name: { type: 'string' } }) } },
    });
    expect(schema.models.map((item: IrModel) => item.name)).toEqual(['Pet']);
  });

  it('reads Swagger 2 definitions', () => {
    const schema: IrSchema = parse({
      swagger: '2.0',
      definitions: { Pet: thing({ name: { type: 'string' } }) },
    });
    expect(model(schema, 'Pet').fields.map((item) => item.name)).toEqual([
      'id',
      'name',
    ]);
  });

  it('maps OpenAPI integer and number formats', () => {
    const schema: IrSchema = parse({
      openapi: '3.0.3',
      components: {
        schemas: {
          Numbers: thing({
            small: { type: 'integer', format: 'int32' },
            big: { type: 'integer', format: 'int64' },
            ratio: { type: 'number', format: 'float' },
            precise: { type: 'number', format: 'double' },
            plain: { type: 'number' },
            blob: { type: 'string', format: 'byte' },
            file: { type: 'string', format: 'binary' },
            maybe: { type: 'string', nullable: true },
          }),
        },
      },
    });
    expect(field(schema, 'Numbers', 'small').type).toBe('int');
    expect(field(schema, 'Numbers', 'big').type).toBe('bigInt');
    expect(field(schema, 'Numbers', 'ratio').type).toBe('float');
    expect(field(schema, 'Numbers', 'precise').type).toBe('float');
    expect(field(schema, 'Numbers', 'plain').type).toBe('float');
    expect(field(schema, 'Numbers', 'blob').type).toBe('bytes');
    expect(field(schema, 'Numbers', 'file').type).toBe('bytes');
    expect(field(schema, 'Numbers', 'maybe').isNullable).toBe(true);
  });
});

describe('scalar types', () => {
  it.each([
    [{ type: 'string' }, 'text'],
    [{ type: 'string', maxLength: 30 }, 'string'],
    [{ type: 'string', format: 'email' }, 'string'],
    [{ type: 'string', format: 'uri' }, 'string'],
    [{ type: 'string', format: 'date-time' }, 'dateTime'],
    [{ type: 'string', format: 'date' }, 'date'],
    [{ type: 'string', format: 'time' }, 'time'],
    [{ type: 'string', format: 'uuid' }, 'uuid'],
    [{ type: 'string', format: 'duration' }, 'duration'],
    [{ type: 'string', format: 'ipv6' }, 'ipAddress'],
    [{ type: 'string', contentEncoding: 'base64' }, 'bytes'],
    [{ type: 'string', contentMediaType: 'application/json' }, 'json'],
    [{ type: 'integer' }, 'int'],
    [{ type: 'integer', format: 'int64' }, 'bigInt'],
    [{ type: 'number' }, 'float'],
    [{ type: 'number', format: 'decimal' }, 'decimal'],
    [{ type: 'string', format: 'decimal' }, 'decimal'],
    [{ type: 'boolean' }, 'boolean'],
    [{ type: 'object' }, 'json'],
    [{}, 'json'],
    [true, 'json'],
    [{ const: 'fixed' }, 'text'],
    [{ const: 3 }, 'int'],
  ])('reads %j as %s', (property: unknown, expected: string) => {
    const schema: IrSchema = parse(defs({ Thing: thing({ value: property }) }));
    expect(field(schema, 'Thing', 'value').type).toBe(expected);
  });

  it('reads the precision and scale of a decimal', () => {
    const schema: IrSchema = parse(
      defs({
        Thing: thing({
          a: { type: 'number', format: 'decimal', multipleOf: 0.001 },
          b: {
            type: 'string',
            format: 'decimal',
            'x-precision': 10,
            'x-scale': 4,
          },
        }),
      })
    );
    expect(field(schema, 'Thing', 'a')).toMatchObject({ decimalPlaces: 3 });
    expect(field(schema, 'Thing', 'b')).toMatchObject({
      maxDigits: 10,
      decimalPlaces: 4,
    });
  });

  it('reads arrays of scalars as array columns', () => {
    const schema: IrSchema = parse(
      defs({
        Thing: thing({
          tags: { type: 'array', items: { type: 'string', maxLength: 10 } },
          grid: {
            type: 'array',
            items: { type: 'array', items: { type: 'integer' } },
          },
          loose: { type: 'array' },
        }),
      })
    );
    expect(field(schema, 'Thing', 'tags')).toMatchObject({
      type: 'string',
      maxLength: 10,
      arrayDepth: 1,
    });
    expect(field(schema, 'Thing', 'grid')).toMatchObject({
      type: 'int',
      arrayDepth: 2,
    });
    expect(field(schema, 'Thing', 'loose')).toMatchObject({ type: 'json' });
    expect(field(schema, 'Thing', 'loose').arrayDepth).toBeUndefined();
    expect(
      schema.warnings.some((w: string) => w.startsWith('Thing.loose'))
    ).toBe(true);
  });

  it('reads defaults', () => {
    const schema: IrSchema = parse(
      defs({
        Thing: thing({
          count: { type: 'integer', default: 5 },
          label: { type: 'string', default: 'x' },
          flag: { type: 'boolean', default: true },
          blob: { type: 'object', default: { a: 1 } },
          created: {
            type: 'string',
            format: 'date-time',
            default: 'CURRENT_TIMESTAMP',
          },
          nothing: { type: ['string', 'null'], default: null },
          list: { type: 'array', items: { type: 'string' }, default: ['a'] },
        }),
      })
    );
    expect(field(schema, 'Thing', 'count').default).toEqual({
      kind: 'literal',
      value: 5,
    });
    expect(field(schema, 'Thing', 'label').default).toEqual({
      kind: 'literal',
      value: 'x',
    });
    expect(field(schema, 'Thing', 'flag').default).toEqual({
      kind: 'literal',
      value: true,
    });
    expect(field(schema, 'Thing', 'blob').default).toEqual({
      kind: 'literal',
      value: '{"a":1}',
    });
    expect(field(schema, 'Thing', 'created').default).toEqual({ kind: 'now' });
    expect(field(schema, 'Thing', 'nothing').default).toBeUndefined();
    expect(field(schema, 'Thing', 'list').default).toBeUndefined();
    expect(
      schema.warnings.some((w: string) => w.startsWith('Thing.list'))
    ).toBe(true);
  });

  it('turns readOnly into generated hints', () => {
    const schema: IrSchema = parse(
      defs({
        Thing: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid', readOnly: true },
            created_at: {
              type: 'string',
              format: 'date-time',
              readOnly: true,
            },
            updatedAt: { type: 'string', format: 'date-time', readOnly: true },
            note: { type: 'string', readOnly: true },
          },
          required: ['id'],
        },
        Counter: {
          type: 'object',
          properties: { id: { type: 'integer', readOnly: true } },
          required: ['id'],
        },
        Manual: {
          type: 'object',
          properties: { id: { type: 'integer' } },
          required: ['id'],
        },
      })
    );
    expect(field(schema, 'Thing', 'id').default).toEqual({ kind: 'uuid' });
    expect(field(schema, 'Thing', 'created_at').default).toEqual({
      kind: 'now',
    });
    expect(field(schema, 'Thing', 'updatedAt').isAutoUpdated).toBe(true);
    expect(field(schema, 'Thing', 'note').default).toBeUndefined();
    expect(field(schema, 'Counter', 'id').default).toEqual({
      kind: 'autoIncrement',
    });
    expect(field(schema, 'Manual', 'id').default).toBeUndefined();
  });

  it('marks unique and indexed properties', () => {
    const schema: IrSchema = parse(
      defs({
        Thing: thing(
          {
            email: { type: 'string', 'x-unique': true },
            code: { type: 'string', 'x-index': true },
          },
          { 'x-indexes': [{ fields: ['code', 'email'], unique: true }] }
        ),
      })
    );
    expect(field(schema, 'Thing', 'email').isUnique).toBe(true);
    expect(model(schema, 'Thing').indexes).toEqual([
      { fields: ['code'], isUnique: false },
      { fields: ['code', 'email'], isUnique: true },
    ]);
  });

  it('ignores indexes that name unknown properties', () => {
    const schema: IrSchema = parse(
      defs({
        Thing: thing(
          {},
          { 'x-indexes': [{ fields: ['nope'] }, { fields: 3 }] }
        ),
      })
    );
    expect(model(schema, 'Thing').indexes).toEqual([]);
    expect(
      schema.warnings.filter((w: string) => w.startsWith('Thing:'))
    ).toHaveLength(2);
  });
});

describe('nullability', () => {
  it('reads required, type unions, nullable and anyOf with null', () => {
    const schema: IrSchema = parse(
      defs({
        Thing: {
          type: 'object',
          properties: {
            id: { type: 'integer' },
            required: { type: 'string' },
            optional: { type: 'string' },
            union: { type: ['string', 'null'] },
            openApi: { type: 'string', nullable: true },
            wrapped: { anyOf: [{ type: 'string' }, { type: 'null' }] },
            oneOf: { oneOf: [{ type: 'null' }, { type: 'integer' }] },
          },
          required: ['id', 'required', 'union', 'openApi', 'wrapped', 'oneOf'],
        },
      })
    );
    const nullable = (name: string): boolean =>
      field(schema, 'Thing', name).isNullable;
    expect(nullable('required')).toBe(false);
    expect(nullable('optional')).toBe(true);
    expect(nullable('union')).toBe(true);
    expect(nullable('openApi')).toBe(true);
    expect(nullable('wrapped')).toBe(true);
    expect(nullable('oneOf')).toBe(true);
    expect(field(schema, 'Thing', 'wrapped').type).toBe('text');
    expect(field(schema, 'Thing', 'oneOf').type).toBe('int');
    expect(schema.warnings).toEqual([]);
  });

  it('keeps a primary key required whatever the schema says', () => {
    const schema: IrSchema = parse(
      defs({
        Thing: {
          type: 'object',
          properties: { id: { type: ['integer', 'null'] } },
        },
      })
    );
    expect(field(schema, 'Thing', 'id')).toMatchObject({
      isPrimaryKey: true,
      isNullable: false,
    });
  });
});

describe('enums', () => {
  it('names an inline enum after the property and a $defs enum after its entry', () => {
    const schema: IrSchema = parse(
      defs({
        Role: { type: 'string', enum: ['admin', 'staff'] },
        User: thing({
          role: { $ref: '#/$defs/Role' },
          other: { $ref: '#/$defs/Role' },
          account_state: { type: 'string', enum: ['open', 'closed'] },
        }),
      })
    );
    expect(schema.enums.map((item: IrEnum) => item.name)).toEqual([
      'Role',
      'AccountState',
    ]);
    expect(field(schema, 'User', 'role').enumName).toBe('Role');
    expect(field(schema, 'User', 'other').enumName).toBe('Role');
    expect(field(schema, 'User', 'account_state').enumName).toBe(
      'AccountState'
    );
    expect(enumNamed(schema, 'Role').values).toEqual([
      { name: 'ADMIN', dbValue: 'admin' },
      { name: 'STAFF', dbValue: 'staff' },
    ]);
  });

  it('reuses an enum with the same values and renames one with different values', () => {
    const schema: IrSchema = parse(
      defs({
        A: thing({ status: { enum: ['x', 'y'] } }),
        B: thing({ status: { enum: ['x', 'y'] } }),
        C: thing({ status: { enum: ['p', 'q'] } }),
      })
    );
    expect(field(schema, 'A', 'status').enumName).toBe('Status');
    expect(field(schema, 'B', 'status').enumName).toBe('Status');
    expect(field(schema, 'C', 'status').enumName).toBe('CStatus');
    expect(schema.enums.map((item: IrEnum) => item.name)).toEqual([
      'Status',
      'CStatus',
    ]);
  });

  it('reads labelled oneOf constants and x-enum-varnames', () => {
    const schema: IrSchema = parse(
      defs({
        Thing: thing({
          level: {
            oneOf: [
              { const: 'lo', title: 'Low' },
              { const: 'hi', title: 'High' },
            ],
          },
          size: {
            type: 'string',
            enum: ['s', 'm'],
            'x-enum-varnames': ['SMALL', 'MEDIUM'],
          },
          odd: { enum: ['in-progress', '', '9 lives', 'inProgress'] },
        }),
      })
    );
    expect(enumNamed(schema, 'Level').values).toEqual([
      { name: 'LO', dbValue: 'lo', label: 'Low' },
      { name: 'HI', dbValue: 'hi', label: 'High' },
    ]);
    expect(enumNamed(schema, 'Size').values.map((v) => v.name)).toEqual([
      'SMALL',
      'MEDIUM',
    ]);
    expect(enumNamed(schema, 'Odd').values.map((v) => v.name)).toEqual([
      'IN_PROGRESS',
      'EMPTY',
      '_9_LIVES',
      'IN_PROGRESS_4',
    ]);
  });

  it('makes a nullable enum and a default', () => {
    const schema: IrSchema = parse(
      defs({
        Thing: thing({
          tier: { enum: ['a', 'b', null], default: 'b' },
          bad: { enum: ['a', 'b'], default: 'zzz' },
        }),
      })
    );
    expect(field(schema, 'Thing', 'tier')).toMatchObject({
      isNullable: true,
      default: { kind: 'enumValue', value: 'B' },
    });
    expect(field(schema, 'Thing', 'bad').default).toBeUndefined();
    expect(schema.warnings.some((w: string) => w.startsWith('Thing.bad'))).toBe(
      true
    );
  });

  it('keeps the plain type of a non-string enum and warns', () => {
    const schema: IrSchema = parse(
      defs({ Thing: thing({ n: { type: 'integer', enum: [1, 2] } }) })
    );
    expect(field(schema, 'Thing', 'n').type).toBe('int');
    expect(schema.enums).toEqual([]);
    expect(schema.warnings.some((w: string) => w.startsWith('Thing.n'))).toBe(
      true
    );
  });

  it('makes arrays of enum values enum arrays', () => {
    const schema: IrSchema = parse(
      defs({
        Thing: thing({
          roles: { type: 'array', items: { enum: ['a', 'b'] } },
        }),
      })
    );
    expect(field(schema, 'Thing', 'roles')).toMatchObject({
      enumName: 'Roles',
      arrayDepth: 1,
    });
  });
});

describe('relations', () => {
  it('reads a to-one property as a foreign key and its optional state', () => {
    const schema: IrSchema = parse(
      defs({
        Owner: thing({}),
        Pet: thing(
          {
            owner: { $ref: '#/$defs/Owner' },
            vet: { $ref: '#/$defs/Owner' },
          },
          { required: ['id', 'owner'] }
        ),
      })
    );
    expect(relation(schema, 'Pet', 'owner')).toMatchObject({
      kind: 'foreignKey',
      columnName: 'owner_id',
      isNullable: false,
      onDelete: 'restrict',
    });
    expect(relation(schema, 'Pet', 'vet')).toMatchObject({
      isNullable: true,
      onDelete: 'setNull',
    });
  });

  it('uses a declared foreign key property as the relation column', () => {
    const schema: IrSchema = parse(
      defs({
        Owner: thing({}),
        Pet: thing({
          ownerId: { type: 'integer' },
          owner: { $ref: '#/$defs/Owner' },
        }),
      })
    );
    expect(relation(schema, 'Pet', 'owner').columnName).toBe('ownerId');
    expect(model(schema, 'Pet').fields.map((item) => item.name)).toEqual([
      'id',
    ]);
  });

  it('reads a to-one property wrapped in allOf, anyOf or with siblings', () => {
    const schema: IrSchema = parse(
      defs({
        Owner: thing({}),
        Pet: thing({
          a: { allOf: [{ $ref: '#/$defs/Owner' }], description: 'x' },
          b: { anyOf: [{ $ref: '#/$defs/Owner' }, { type: 'null' }] },
          c: { $ref: '#/$defs/Owner', description: 'sibling keyword' },
        }),
      })
    );
    expect(model(schema, 'Pet').relations.map((item) => item.name)).toEqual([
      'a',
      'b',
      'c',
    ]);
    expect(relation(schema, 'Pet', 'b').isNullable).toBe(true);
  });

  it('pairs an array with the foreign key on the other model as its reverse name', () => {
    const schema: IrSchema = parse(
      defs({
        Owner: thing({
          pets: { type: 'array', items: { $ref: '#/$defs/Pet' } },
        }),
        Pet: thing({ owner: { $ref: '#/$defs/Owner' } }),
      })
    );
    expect(relation(schema, 'Pet', 'owner')).toMatchObject({
      kind: 'foreignKey',
      relatedName: 'pets',
    });
    expect(model(schema, 'Owner').relations).toEqual([]);
    expect(schema.warnings).toEqual([]);
  });

  it('asks for x-related-name when several properties could be the reverse', () => {
    const schema: IrSchema = parse(
      defs({
        User: thing({
          posts: { type: 'array', items: { $ref: '#/$defs/Post' } },
        }),
        Post: thing({
          author: { $ref: '#/$defs/User' },
          editor: { $ref: '#/$defs/User' },
        }),
      })
    );
    expect(relation(schema, 'Post', 'author').relatedName).toBeUndefined();
    expect(
      schema.warnings.some(
        (w: string) =>
          w.startsWith('User.posts') && w.includes('x-related-name')
      )
    ).toBe(true);
  });

  it('picks the foreign key named by x-related-name', () => {
    const schema: IrSchema = parse(
      defs({
        User: thing({
          posts: { type: 'array', items: { $ref: '#/$defs/Post' } },
        }),
        Post: thing({
          author: { $ref: '#/$defs/User', 'x-related-name': 'posts' },
          editor: { $ref: '#/$defs/User' },
        }),
      })
    );
    expect(relation(schema, 'Post', 'author').relatedName).toBe('posts');
    expect(relation(schema, 'Post', 'editor').relatedName).toBeUndefined();
  });

  it('reads arrays on both sides as one many-to-many owned by the first model', () => {
    const schema: IrSchema = parse(
      defs({
        Post: thing({
          tags: { type: 'array', items: { $ref: '#/$defs/Tag' } },
        }),
        Tag: thing({
          posts: { type: 'array', items: { $ref: '#/$defs/Post' } },
        }),
      })
    );
    expect(relation(schema, 'Post', 'tags')).toMatchObject({
      kind: 'manyToMany',
      targetModel: 'Tag',
      relatedName: 'posts',
    });
    expect(model(schema, 'Tag').relations).toEqual([]);
  });

  it('reads a lone array of models as a foreign key added to the other model, with a warning', () => {
    const schema: IrSchema = parse(
      defs({
        Owner: thing({
          pets: { type: 'array', items: { $ref: '#/$defs/Pet' } },
        }),
        Pet: thing({}),
      })
    );
    expect(relation(schema, 'Pet', 'owner')).toMatchObject({
      kind: 'foreignKey',
      targetModel: 'Owner',
      isNullable: true,
      relatedName: 'pets',
    });
    expect(
      schema.warnings.some(
        (w: string) => w.startsWith('Owner.pets') && w.includes('Pet')
      )
    ).toBe(true);
  });

  it('reads two to-one properties that point at each other as a one-to-one relation', () => {
    const schema: IrSchema = parse(
      defs({
        User: thing(
          { profile: { $ref: '#/$defs/Profile' } },
          { required: ['id'] }
        ),
        Profile: thing({ user: { $ref: '#/$defs/User' } }),
      })
    );
    expect(relation(schema, 'Profile', 'user')).toMatchObject({
      kind: 'oneToOne',
      relatedName: 'profile',
      isNullable: false,
    });
    expect(model(schema, 'User').relations).toEqual([]);
    expect(schema.warnings).toEqual([]);
  });

  it('warns when the direction of a one-to-one relation is a guess', () => {
    const schema: IrSchema = parse(
      defs({
        A: thing({ b: { $ref: '#/$defs/B' } }, { required: ['id', 'b'] }),
        B: thing({ a: { $ref: '#/$defs/A' } }, { required: ['id', 'a'] }),
      })
    );
    expect(model(schema, 'B').relations.map((item) => item.name)).toEqual([
      'a',
    ]);
    expect(schema.warnings.some((w: string) => w.includes('one-to-one'))).toBe(
      true
    );
  });

  it('does not mistake a foreign key with an array reverse for a one-to-one relation', () => {
    const schema: IrSchema = parse(
      defs({
        Post: thing({
          comments: { type: 'array', items: { $ref: '#/$defs/Comment' } },
          latest: { $ref: '#/$defs/Comment' },
        }),
        Comment: thing({ post: { $ref: '#/$defs/Post' } }),
      })
    );
    expect(relation(schema, 'Comment', 'post')).toMatchObject({
      kind: 'foreignKey',
      relatedName: 'comments',
    });
    expect(relation(schema, 'Post', 'latest').kind).toBe('foreignKey');
  });

  it('reads a self relation', () => {
    const schema: IrSchema = parse(
      defs({
        Node: thing({
          parent: { $ref: '#/$defs/Node' },
          children: { type: 'array', items: { $ref: '#/$defs/Node' } },
        }),
      })
    );
    expect(relation(schema, 'Node', 'parent')).toMatchObject({
      targetModel: 'Node',
      relatedName: 'children',
    });
  });

  it('reads the on-delete action in several spellings', () => {
    const schema: IrSchema = parse(
      defs({
        Owner: thing({}),
        Pet: thing({
          a: { $ref: '#/$defs/Owner', 'x-on-delete': 'SET NULL' },
          b: { $ref: '#/$defs/Owner', 'x-on-delete': 'no_action' },
          c: { $ref: '#/$defs/Owner', 'x-on-delete': 'CASCADE' },
        }),
      })
    );
    expect(relation(schema, 'Pet', 'a').onDelete).toBe('setNull');
    expect(relation(schema, 'Pet', 'b').onDelete).toBe('noAction');
    expect(relation(schema, 'Pet', 'c').onDelete).toBe('cascade');
  });

  it('stores an array of models nested in another array as json', () => {
    const schema: IrSchema = parse(
      defs({
        Owner: thing({}),
        Pet: thing({
          grid: {
            type: 'array',
            items: { type: 'array', items: { $ref: '#/$defs/Owner' } },
          },
        }),
      })
    );
    expect(field(schema, 'Pet', 'grid').type).toBe('json');
    expect(schema.warnings.some((w: string) => w.startsWith('Pet.grid'))).toBe(
      true
    );
  });
});

describe('primary keys', () => {
  it('prefers x-primary-key, then id, then <model>Id', () => {
    const schema: IrSchema = parse(
      defs({
        A: {
          type: 'object',
          properties: {
            id: { type: 'integer' },
            code: { type: 'string', 'x-primary-key': true },
          },
          required: ['id', 'code'],
        },
        B: {
          type: 'object',
          properties: { bId: { type: 'integer' }, id: { type: 'string' } },
          required: ['bId'],
        },
        C: {
          type: 'object',
          properties: { c_id: { type: 'integer' }, name: { type: 'string' } },
          required: ['c_id'],
        },
      })
    );
    expect(field(schema, 'A', 'code').isPrimaryKey).toBe(true);
    expect(field(schema, 'A', 'id').isPrimaryKey).toBe(false);
    expect(field(schema, 'B', 'id').isPrimaryKey).toBe(true);
    expect(field(schema, 'C', 'c_id').isPrimaryKey).toBe(true);
  });

  it('reads several x-primary-key properties as a composite key', () => {
    const schema: IrSchema = parse(
      defs({
        Item: {
          type: 'object',
          properties: {
            order: { type: 'string', 'x-primary-key': true },
            line: { type: 'integer', 'x-primary-key': true },
          },
        },
        Other: {
          type: 'object',
          'x-primary-key': ['a', 'b'],
          properties: { a: { type: 'string' }, b: { type: 'string' } },
        },
      })
    );
    expect(model(schema, 'Item').compositePrimaryKey).toEqual([
      'order',
      'line',
    ]);
    expect(model(schema, 'Other').compositePrimaryKey).toEqual(['a', 'b']);
    expect(field(schema, 'Item', 'order').isPrimaryKey).toBe(false);
    expect(schema.warnings).toEqual([]);
  });

  it('adds an id with a warning when there is no key', () => {
    const schema: IrSchema = parse(
      defs({
        Note: {
          type: 'object',
          properties: { text: { type: 'string' } },
          required: ['text'],
        },
      })
    );
    expect(field(schema, 'Note', 'id')).toMatchObject({
      type: 'int',
      isPrimaryKey: true,
      default: { kind: 'autoIncrement' },
    });
    expect(schema.warnings).toEqual([
      expect.stringContaining('Note: no primary key property was found'),
    ]);
  });

  it('does not take a json or float property as the key', () => {
    const schema: IrSchema = parse(
      defs({ Note: { type: 'object', properties: { id: { type: 'object' } } } })
    );
    expect(field(schema, 'Note', 'id').isPrimaryKey).toBe(false);
    expect(field(schema, 'Note', 'ormbridge_id').isPrimaryKey).toBe(true);
  });
});

describe('composition and losses', () => {
  it('flattens allOf inheritance and warns', () => {
    const schema: IrSchema = parse(
      defs({
        Base: thing({ name: { type: 'string', maxLength: 10 } }),
        Child: {
          allOf: [
            { $ref: '#/$defs/Base' },
            {
              type: 'object',
              properties: { extra: { type: 'integer' } },
              required: ['extra'],
            },
          ],
        },
      })
    );
    expect(model(schema, 'Child').fields.map((item) => item.name)).toEqual([
      'id',
      'name',
      'extra',
    ]);
    expect(
      schema.warnings.some(
        (w: string) => w.startsWith('Child:') && w.includes('Base')
      )
    ).toBe(true);
  });

  it('lets a later allOf member and the schema itself override earlier properties', () => {
    const schema: IrSchema = parse(
      defs({
        Base: thing({ name: { type: 'string', maxLength: 10 } }),
        Child: {
          allOf: [{ $ref: '#/$defs/Base' }],
          properties: { name: { type: 'string', maxLength: 20 } },
        },
      })
    );
    expect(field(schema, 'Child', 'name').maxLength).toBe(20);
  });

  it('copes with an allOf cycle', () => {
    const result: Result<IrSchema> = parseDocs(
      defs({
        A: {
          allOf: [{ $ref: '#/$defs/B' }],
          properties: { a: { type: 'string' } },
        },
        B: {
          allOf: [{ $ref: '#/$defs/A' }],
          properties: { b: { type: 'string' } },
        },
      })
    );
    const schema: IrSchema = expectOk(result);
    expect(model(schema, 'A').fields.map((item) => item.name)).toContain('a');
  });

  it('reports union, pattern, map and conditional constructs', () => {
    const schema: IrSchema = parse(
      defs({
        Thing: thing(
          {
            either: { oneOf: [{ type: 'string' }, { type: 'integer' }] },
            mixed: { type: ['string', 'integer'] },
            lookup: {
              type: 'object',
              additionalProperties: { type: 'string' },
            },
            pattern: {
              type: 'object',
              patternProperties: { '^a': { type: 'string' } },
            },
            nested: {
              type: 'object',
              properties: { street: { type: 'string' } },
            },
            list: {
              type: 'array',
              items: { type: 'object', properties: { a: { type: 'string' } } },
            },
          },
          {
            if: { required: ['id'] },
            then: {},
            additionalProperties: { type: 'string' },
          }
        ),
        Shape: {
          oneOf: [{ $ref: '#/$defs/Thing' }, { $ref: '#/$defs/Thing' }],
        },
        Multi: {
          type: 'object',
          properties: { id: { type: 'integer' } },
          patternProperties: { '^x': {} },
        },
      })
    );
    for (const name of [
      'either',
      'mixed',
      'lookup',
      'pattern',
      'nested',
      'list',
    ]) {
      expect(field(schema, 'Thing', name).type).toBe('json');
      expect(
        schema.warnings.some((w: string) => w.startsWith(`Thing.${name}:`)),
        name
      ).toBe(true);
    }
    expect(
      schema.warnings.some((w: string) => w.includes('if/then/else'))
    ).toBe(true);
    expect(
      schema.warnings.some(
        (w: string) =>
          w.startsWith('Thing:') && w.includes('additionalProperties')
      )
    ).toBe(true);
    expect(
      schema.warnings.some(
        (w: string) => w.startsWith('Shape:') && w.includes('oneOf')
      )
    ).toBe(true);
    expect(schema.models.map((item: IrModel) => item.name)).not.toContain(
      'Shape'
    );
    expect(
      schema.warnings.some(
        (w: string) => w.startsWith('Multi:') && w.includes('patternProperties')
      )
    ).toBe(true);
  });

  it('does not make models of enums, aliases or free-form objects', () => {
    const schema: IrSchema = parse(
      defs({
        Status: { enum: ['a', 'b'] },
        Name: { type: 'string', maxLength: 40 },
        Bag: { type: 'object' },
        Alias: { $ref: '#/$defs/Real' },
        Real: thing({
          n: { $ref: '#/$defs/Name' },
          b: { $ref: '#/$defs/Bag' },
        }),
      })
    );
    expect(schema.models.map((item: IrModel) => item.name)).toEqual(['Real']);
    expect(field(schema, 'Real', 'n')).toMatchObject({
      type: 'string',
      maxLength: 40,
    });
    expect(field(schema, 'Real', 'b').type).toBe('json');
  });
});

describe('references', () => {
  it('resolves JSON pointers with escapes and percent-encoding', () => {
    const schema: IrSchema = parse(
      defs({
        'a/b': thing({}),
        'c~d': thing({}),
        'e f': thing({}),
        User: thing({
          one: { $ref: '#/$defs/a~1b' },
          two: { $ref: '#/$defs/c~0d' },
          three: { $ref: '#/$defs/e%20f' },
        }),
      })
    );
    expect(
      model(schema, 'User').relations.map((item) => item.targetModel)
    ).toEqual(['a_b', 'c_d', 'e_f']);
    expect(
      schema.warnings.filter((w: string) => w.includes('reference'))
    ).toEqual([]);
  });

  it('resolves a reference to the root schema', () => {
    const schema: IrSchema = parse({
      title: 'Node',
      type: 'object',
      properties: {
        id: { type: 'integer' },
        next: { $ref: '#' },
      },
    });
    expect(schema.models.map((item: IrModel) => item.name)).toEqual(['Node']);
    expect(relation(schema, 'Node', 'next').targetModel).toBe('Node');
  });

  it('resolves older definitions pointers and draft-07 style documents', () => {
    const schema: IrSchema = parse({
      $schema: 'http://json-schema.org/draft-07/schema#',
      definitions: {
        A: thing({ b: { $ref: '#/definitions/B' } }),
        B: thing({}),
      },
    });
    expect(relation(schema, 'A', 'b').targetModel).toBe('B');
  });

  it('resolves references between files through $id', () => {
    const schema: IrSchema = parse(
      {
        $id: 'https://example.com/a.json',
        $defs: { A: thing({ b: { $ref: 'b.json#/$defs/B' } }) },
      },
      {
        $id: 'https://example.com/b.json',
        $defs: {
          B: thing({}),
          C: thing({ a: { $ref: 'https://example.com/a.json#/$defs/A' } }),
        },
      }
    );
    expect(relation(schema, 'A', 'b').targetModel).toBe('B');
    expect(relation(schema, 'C', 'a').targetModel).toBe('A');
    expect(schema.warnings).toEqual([]);
  });

  it('resolves references between files by path when there is no $id', () => {
    const schema: IrSchema = parse(
      defs({ A: thing({ b: { $ref: 'doc1.json#/$defs/B' } }) }),
      defs({ B: thing({}) })
    );
    expect(relation(schema, 'A', 'b').targetModel).toBe('B');
  });

  it('renames models that share a name across files', () => {
    const schema: IrSchema = parse(
      defs({ Item: thing({ a: { type: 'string' } }) }),
      defs({ Item: thing({ b: { type: 'string' } }) })
    );
    expect(schema.models.map((item: IrModel) => item.name)).toEqual([
      'Item',
      'Item2',
    ]);
    expect(schema.warnings).toHaveLength(1);
  });

  it('keeps a property with an unresolved remote reference as json and warns', () => {
    const schema: IrSchema = parse(
      defs({
        A: thing({
          remote: { $ref: 'https://example.org/other.json#/$defs/X' },
          missing: { $ref: '#/$defs/Nope' },
          anchor: { $ref: '#named' },
          badEscape: { $ref: '#/$defs/%E0%A4%A' },
        }),
      })
    );
    for (const name of ['remote', 'missing', 'anchor', 'badEscape']) {
      expect(field(schema, 'A', name).type, name).toBe('json');
      expect(
        schema.warnings.some((w: string) => w.startsWith(`A.${name}:`)),
        name
      ).toBe(true);
    }
    expect(
      schema.warnings.find((w: string) => w.startsWith('A.remote:'))
    ).toContain('remote references are not fetched');
  });

  it('breaks reference cycles that never reach an object', () => {
    const schema: IrSchema = parse(
      defs({
        X: { $ref: '#/$defs/Y' },
        Y: { $ref: '#/$defs/X' },
        A: thing({ loop: { $ref: '#/$defs/X' } }),
      })
    );
    expect(field(schema, 'A', 'loop').type).toBe('json');
    expect(
      schema.warnings.find((w: string) => w.startsWith('A.loop:'))
    ).toContain('reference cycle');
  });

  it('allows models to refer to each other in a cycle', () => {
    const schema: IrSchema = parse(
      defs({
        A: thing({ b: { $ref: '#/$defs/B' } }),
        B: thing({ a: { $ref: '#/$defs/A' }, c: { $ref: '#/$defs/C' } }),
        C: thing({ a: { $ref: '#/$defs/A' } }),
      })
    );
    expect(schema.models).toHaveLength(3);
  });

  it('gives up on very long reference chains instead of recursing forever', () => {
    const entries: Json = {};
    for (let index: number = 0; index < 60; index += 1) {
      entries[`L${index}`] = { $ref: `#/$defs/L${index + 1}` };
    }
    entries.L60 = { type: 'string' };
    entries.A = thing({ deep: { $ref: '#/$defs/L0' } });
    const schema: IrSchema = parse(defs(entries));
    expect(field(schema, 'A', 'deep').type).toBe('json');
    expect(schema.warnings.some((w: string) => w.startsWith('A.deep:'))).toBe(
      true
    );
  });

  it('warns about an allOf member that cannot be resolved', () => {
    const schema: IrSchema = parse(
      defs({
        A: {
          allOf: [{ $ref: '#/$defs/Missing' }],
          properties: { x: { type: 'string' } },
        },
      })
    );
    expect(model(schema, 'A').fields.map((item) => item.name)).toContain('x');
    expect(
      schema.warnings.some((w: string) => w.includes('allOf member skipped'))
    ).toBe(true);
  });
});

describe('documents written by the ormbridge JSON Schema emitter', () => {
  it('keeps an optional property with a default or a generated value required in the database', () => {
    const schema: IrSchema = parse(
      defs({
        Thing: {
          type: 'object',
          properties: {
            id: { type: 'integer', readOnly: true },
            views: { type: 'integer', default: 0 },
            stamp: { type: 'string', format: 'date-time', readOnly: true },
            note: { type: 'string' },
            maybe: { type: ['string', 'null'] },
          },
          required: ['maybe'],
        },
      })
    );
    expect(field(schema, 'Thing', 'views').isNullable).toBe(false);
    expect(field(schema, 'Thing', 'stamp').isNullable).toBe(false);
    expect(field(schema, 'Thing', 'note').isNullable).toBe(true);
    expect(field(schema, 'Thing', 'maybe').isNullable).toBe(true);
  });

  it('takes the nullability of a relation from its foreign key scalar', () => {
    const schema: IrSchema = parse(
      defs({
        User: thing({}, { required: ['id'] }),
        Post: {
          type: 'object',
          properties: {
            id: { type: 'integer', readOnly: true },
            author_id: { type: 'integer' },
            author: { $ref: '#/$defs/User' },
            editor_id: { type: ['integer', 'null'] },
            editor: { anyOf: [{ $ref: '#/$defs/User' }, { type: 'null' }] },
          },
          required: ['author_id'],
        },
      })
    );
    expect(relation(schema, 'Post', 'author')).toMatchObject({
      columnName: 'author_id',
      isNullable: false,
    });
    expect(relation(schema, 'Post', 'editor')).toMatchObject({
      columnName: 'editor_id',
      isNullable: true,
    });
    expect(model(schema, 'Post').fields.map((item) => item.name)).toEqual([
      'id',
    ]);
  });

  it('matches reverse arrays with foreign keys in order of appearance when the counts agree', () => {
    const schema: IrSchema = parse(
      defs({
        User: {
          type: 'object',
          properties: {
            id: { type: 'integer' },
            posts: { type: 'array', items: { $ref: '#/$defs/Post' } },
            edited_posts: { type: 'array', items: { $ref: '#/$defs/Post' } },
          },
        },
        Post: {
          type: 'object',
          properties: {
            id: { type: 'integer' },
            author: { $ref: '#/$defs/User' },
            editor: { $ref: '#/$defs/User' },
          },
        },
      })
    );
    expect(relation(schema, 'Post', 'author').relatedName).toBe('posts');
    expect(relation(schema, 'Post', 'editor').relatedName).toBe('edited_posts');
    expect(
      schema.warnings.filter((w: string) => w.includes('order of appearance'))
    ).toHaveLength(1);
  });

  it.each([
    ['^-?[0-9]+$', { type: 'bigInt' }],
    ['^-?[0-9]+(\\.[0-9]+)?$', { type: 'decimal' }],
    [
      '^-?[0-9]{1,6}(\\.[0-9]{1,2})?$',
      { type: 'decimal', maxDigits: 8, decimalPlaces: 2 },
    ],
    [
      '^-?0?(\\.[0-9]{1,3})?$',
      { type: 'decimal', maxDigits: 3, decimalPlaces: 3 },
    ],
    ['^-?[0-9]{1,4}$', { type: 'decimal', maxDigits: 4, decimalPlaces: 0 }],
    ['^[a-z]+$', { type: 'text' }],
  ])('reads the string pattern %s', (pattern: string, expected: Json) => {
    const schema: IrSchema = parse(
      defs({ Thing: thing({ value: { type: 'string', pattern } }) })
    );
    expect(field(schema, 'Thing', 'value')).toMatchObject(expected);
  });
});

describe('errors', () => {
  it('reports invalid JSON with the file name', () => {
    const result: Result<IrSchema> = parseDocs('{ "a": ');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('PARSE_FAILED');
      expect(result.error.message).toContain('doc0.json');
      expect(result.error.message).toContain('not valid JSON');
    }
  });

  it('explains that YAML is not supported', () => {
    const result: Result<IrSchema> = parseJsonSchema(
      [{ path: 'api.yaml', text: 'openapi: 3.0.0\ncomponents: {}\n' }],
      { appLabel: 'app' }
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain('YAML is not supported');
    }
  });

  it('rejects a document that is not an object', () => {
    for (const text of ['[]', '3', 'null', '"x"', 'true']) {
      const result: Result<IrSchema> = parseDocs(text);
      expect(result.ok, text).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('PARSE_FAILED');
      }
    }
  });

  it('reports a document without models', () => {
    const result: Result<IrSchema> = parseDocs({ type: 'string' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('NO_MODELS_FOUND');
      expect(result.error.message).toContain('doc0.json');
    }
  });

  it('accepts a byte order mark', () => {
    const schema: IrSchema = parse(
      `${String.fromCharCode(0xfeff)}${JSON.stringify(defs({ A: thing({}) }))}`
    );
    expect(schema.models).toHaveLength(1);
  });

  it('never throws on hostile or malformed documents', () => {
    const hostile: (Json | string)[] = [
      defs({ A: null }),
      defs({ A: [] }),
      defs({ A: { properties: null } }),
      defs({ A: { properties: [] } }),
      defs({ A: { properties: { x: null } } }),
      defs({ A: { properties: { x: 5 }, required: 'x' } }),
      defs({ A: { properties: { x: { $ref: 5 } } } }),
      defs({ A: { properties: { x: { type: 5 } } } }),
      defs({ A: { properties: { x: { type: [5, null] } } } }),
      defs({ A: { properties: { x: { enum: 'a' } } } }),
      defs({ A: { properties: { x: { enum: [] } } } }),
      defs({ A: { properties: { x: { enum: [{}, []] } } } }),
      defs({ A: { properties: { x: { oneOf: 3 } } } }),
      defs({ A: { properties: { x: { anyOf: [null, 3] } } } }),
      defs({ A: { properties: { x: { allOf: [null, 3, { $ref: 7 }] } } } }),
      defs({ A: { properties: { x: { type: 'array', items: 3 } } } }),
      defs({ A: { properties: { x: { type: 'array', items: [{}] } } } }),
      defs({
        A: { properties: { x: { maxLength: 'a', default: undefined } } },
      }),
      defs({
        A: { 'x-indexes': 5, 'x-primary-key': 'a', properties: { a: {} } },
      }),
      defs({ A: { properties: { x: { $ref: '' } } } }),
      defs({ A: { properties: { x: { $ref: 'http://[bad' } } } }),
      { $id: 'ht!tp://', $defs: { A: thing({}) } },
      { $id: 5, $defs: { A: thing({}) } },
      '{"$defs":{"A":{"properties":{"__proto__":{"type":"string"},"constructor":{"type":"string"}}}}}',
      '{"$defs":{"__proto__":{"properties":{"a":{}}}}}',
    ];
    for (const document of hostile) {
      expect(() => parseDocs(document), JSON.stringify(document)).not.toThrow();
    }
  });

  it('survives very deeply nested schemas', () => {
    const depth: number = 400;
    const arrays: string =
      '{"type":"array","items":'.repeat(depth) +
      '{"type":"string"}' +
      '}'.repeat(depth);
    const inherited: string =
      '{"allOf":['.repeat(depth) +
      '{"properties":{"a":{"type":"string"}}}' +
      ']}'.repeat(depth);
    for (const nested of [arrays, inherited]) {
      const text: string = `{"$defs":{"A":{"type":"object","properties":{"id":{"type":"integer"},"deep":${nested}}},"B":${nested}}}`;
      expect(() => parseDocs(text)).not.toThrow();
    }
    const schema: IrSchema = parse(
      `{"$defs":{"A":{"type":"object","properties":{"id":{"type":"integer"},"deep":${arrays}}}}}`
    );
    expect(field(schema, 'A', 'deep').type).toBe('json');
  });
});

describe('extras fixture', () => {
  const goldenDirectory: string = fileURLToPath(
    new URL('./golden-extras/', import.meta.url)
  );

  function expectMatchesExtrasGolden(name: string, actual: string): void {
    const goldenPath: string = `${goldenDirectory}${name}`;
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

  // Relative paths keep the warnings (and so the golden) independent of where the repository is checked out.
  const sources = ['shop.schema.json', 'people.schema.json'].map((name) => ({
    path: name,
    text: readFixture(EXTRAS, name).text,
  }));

  async function convertExtras(to: string): Promise<ConvertResult> {
    return expectOk(
      await convertText(sources, {
        ...DEFAULT_OPTIONS,
        appLabel: 'shop',
        from: 'json-schema',
        to,
      })
    );
  }

  it('reads the awkward constructs into the IR', () => {
    const schema: IrSchema = expectOk(
      parseJsonSchema(sources, { appLabel: 'shop' })
    );
    expect(schema.models.map((item: IrModel) => item.name)).toEqual([
      'Customer',
      'Order',
      'OrderItem',
      'Product',
      'Label',
      'Person',
      'Employee',
      'Badge',
    ]);
    expect(model(schema, 'Customer').tableName).toBe('shop_customers');
    expect(field(schema, 'Customer', 'customerId')).toMatchObject({
      type: 'bigInt',
      isPrimaryKey: true,
    });
    expect(model(schema, 'OrderItem').compositePrimaryKey).toEqual([
      'order_no',
      'line_no',
    ]);
    expect(relation(schema, 'Order', 'customer')).toMatchObject({
      onDelete: 'restrict',
      relatedName: 'orders',
    });
    expect(relation(schema, 'Product', 'labels').kind).toBe('manyToMany');
    expect(relation(schema, 'Employee', 'favourite').targetModel).toBe(
      'Customer'
    );
    expect(model(schema, 'Employee').fields.map((item) => item.name)).toEqual([
      'id',
      'name',
      'salary',
      'remote',
    ]);
    expect(enumNamed(schema, 'Role').values[0]).toEqual({
      name: 'ADMIN',
      dbValue: 'admin',
      label: 'Administrator',
    });
    expect(field(schema, 'Customer', 'tags')).toMatchObject({
      type: 'text',
      arrayDepth: 1,
    });
    expect(field(schema, 'Customer', 'scores')).toMatchObject({
      type: 'int',
      arrayDepth: 2,
    });
    expect(field(schema, 'Customer', 'balance')).toMatchObject({
      type: 'decimal',
      maxDigits: 12,
      decimalPlaces: 2,
    });
  });

  it('matches the Prisma golden', async () => {
    const result: ConvertResult = await convertExtras('prisma');
    expectMatchesExtrasGolden('json-schema-to-prisma.txt', result.output);
  });

  it('matches the Django golden', async () => {
    const result: ConvertResult = await convertExtras('django');
    expectMatchesExtrasGolden('json-schema-to-django.txt', result.output);
  });

  it('matches the warnings golden', async () => {
    const result: ConvertResult = await convertExtras('prisma');
    expectMatchesExtrasGolden(
      'json-schema-warnings.txt',
      result.warnings.map((warning: string) => `${warning}\n`).join('')
    );
  });
});

describe('reading from disk', () => {
  const created: string[] = [];

  afterEach(() => {
    for (const directory of created.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  function scratchDirectory(): string {
    const directory: string = mkdtempSync(
      join(tmpdir(), 'ormbridge-jsonschema-')
    );
    created.push(directory);
    return directory;
  }

  it('reads every .json file of a directory and skips tool configuration', async () => {
    const directory: string = scratchDirectory();
    writeFileSync(
      join(directory, 'blog.schema.json'),
      readFileSync(join(FIXTURES, 'blog.schema.json'), 'utf8')
    );
    writeFileSync(join(directory, 'package.json'), '{"name":"x"}');
    writeFileSync(join(directory, 'tsconfig.json'), '{ not json');
    mkdirSync(join(directory, 'node_modules'));
    writeFileSync(join(directory, 'node_modules', 'bad.json'), '{ not json');
    writeFileSync(join(directory, 'notes.txt'), 'ignored');
    const summary = expectOk(
      await runConversion({
        ...DEFAULT_OPTIONS,
        inputs: [directory],
        from: 'json-schema',
        to: 'typescript',
      })
    );
    expect(summary.inputFiles).toEqual([join(directory, 'blog.schema.json')]);
    expect(summary.modelCount).toBe(5);
  });

  it('reads several files that refer to each other', async () => {
    const directory: string = scratchDirectory();
    writeFileSync(
      join(directory, 'a.json'),
      JSON.stringify(defs({ A: thing({ b: { $ref: 'b.json#/$defs/B' } }) }))
    );
    writeFileSync(
      join(directory, 'b.json'),
      JSON.stringify(defs({ B: thing({}) }))
    );
    const summary = expectOk(
      await runConversion({
        ...DEFAULT_OPTIONS,
        inputs: [directory],
        from: 'json-schema',
        to: 'prisma',
      })
    );
    expect(summary.modelCount).toBe(2);
    expect(summary.output).toContain('model A');
    expect(summary.output).toMatch(/b\s+B\s+@relation/);
  });

  it('names the expected files when a directory has none', async () => {
    const directory: string = scratchDirectory();
    writeFileSync(join(directory, 'package.json'), '{}');
    const result = await runConversion({
      ...DEFAULT_OPTIONS,
      inputs: [directory],
      from: 'json-schema',
      to: 'prisma',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('NO_INPUT_FILES');
      expect(result.error.message).toContain('JSON');
    }
  });
});
