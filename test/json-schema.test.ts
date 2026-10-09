import { describe, expect, it } from 'vitest';
import {
  emitJsonSchema,
  type JsonSchemaOptions,
} from '../src/emitters/jsonSchema.js';
import type { EmitOutput } from '../src/emitters/prisma.js';
import type {
  IrEnum,
  IrField,
  IrModel,
  IrRelation,
  IrSchema,
} from '../src/ir.js';
import { getFormat, getFormatByExtension } from '../src/formats.js';

type JsonObject = Record<string, unknown>;

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
  overrides: Partial<JsonSchemaOptions> = {}
): { output: EmitOutput; document: JsonObject } {
  const output: EmitOutput = emitJsonSchema(schema, {
    camelFields: false,
    ...overrides,
  });
  return { output, document: JSON.parse(output.text) as JsonObject };
}

function definition(document: JsonObject, name: string): JsonObject {
  return (document.$defs as Record<string, JsonObject>)[name] ?? {};
}

function properties(
  document: JsonObject,
  name: string
): Record<string, JsonObject> {
  return definition(document, name).properties as Record<string, JsonObject>;
}

describe('JSON Schema emitter', () => {
  it('writes the dialect, an id and one $defs entry per model and enum', () => {
    const { output, document } = emit(
      schemaOf(
        [
          model('Post', {
            fields: [idField(), field('status', { enumName: 'S' })],
          }),
        ],
        [{ name: 'S', values: [{ name: 'A', dbValue: 'a' }] }]
      )
    );
    expect(output.warnings).toEqual([]);
    expect(document.$schema).toBe(
      'https://json-schema.org/draft/2020-12/schema'
    );
    expect(document.$id).toBe('urn:ormbridge:schema');
    expect(Object.keys(document.$defs as object)).toEqual(['S', 'Post']);
    expect(output.text.endsWith('\n')).toBe(true);
    expect(
      emit(schemaOf([model('A')]), { id: 'https://x.test/s.json' }).document.$id
    ).toBe('https://x.test/s.json');
  });

  it('maps every scalar type', () => {
    const { output, document } = emit(
      schemaOf([
        model('Thing', {
          fields: [
            idField(),
            field('s', { maxLength: 12 }),
            field('t', { type: 'text' }),
            field('i', { type: 'int' }),
            field('b', { type: 'bigInt' }),
            field('f', { type: 'float' }),
            field('d', { type: 'decimal', maxDigits: 8, decimalPlaces: 2 }),
            field('d2', { type: 'decimal' }),
            field('o', { type: 'boolean' }),
            field('dt', { type: 'dateTime' }),
            field('dd', { type: 'date' }),
            field('tm', { type: 'time' }),
            field('u', { type: 'uuid' }),
            field('j', { type: 'json' }),
            field('by', { type: 'bytes' }),
            field('du', { type: 'duration' }),
            field('ip', { type: 'ipAddress' }),
          ],
        }),
      ])
    );
    expect(output.warnings).toEqual([]);
    const props: Record<string, JsonObject> = properties(document, 'Thing');
    expect(props.s).toEqual({ type: 'string', maxLength: 12 });
    expect(props.t).toEqual({ type: 'string' });
    expect(props.i).toEqual({ type: 'integer' });
    expect(props.b).toEqual({ type: 'string', pattern: '^-?[0-9]+$' });
    expect(props.f).toEqual({ type: 'number' });
    expect(props.d).toEqual({
      type: 'string',
      pattern: '^-?[0-9]{1,6}(\\.[0-9]{1,2})?$',
    });
    expect(props.d2).toEqual({
      type: 'string',
      pattern: '^-?[0-9]+(\\.[0-9]+)?$',
    });
    expect(props.o).toEqual({ type: 'boolean' });
    expect(props.dt).toEqual({ type: 'string', format: 'date-time' });
    expect(props.dd).toEqual({ type: 'string', format: 'date' });
    expect(props.tm).toEqual({ type: 'string', format: 'time' });
    expect(props.u).toEqual({ type: 'string', format: 'uuid' });
    expect(props.j).toEqual({});
    expect(props.by).toEqual({ type: 'string', contentEncoding: 'base64' });
    expect(props.du).toEqual({ type: 'string', format: 'duration' });
    expect(props.ip).toEqual({ type: 'string' });
  });

  it('never infers email or other formats from names', () => {
    const { document } = emit(
      schemaOf([model('U', { fields: [idField(), field('email')] })])
    );
    expect(properties(document, 'U').email).toEqual({ type: 'string' });
  });

  it('writes integer ranges from Prisma native types only', () => {
    const { document } = emit(
      schemaOf([
        model('N', {
          fields: [
            idField(),
            field('small', {
              type: 'int',
              nativeType: { name: 'SmallInt', args: [] },
            }),
            field('plain', { type: 'int' }),
          ],
        }),
      ])
    );
    const props: Record<string, JsonObject> = properties(document, 'N');
    expect(props.small).toEqual({
      type: 'integer',
      minimum: -32768,
      maximum: 32767,
    });
    expect(props.plain).toEqual({ type: 'integer' });
  });

  it('writes nullable columns as type unions and arrays per dimension', () => {
    const { document } = emit(
      schemaOf([
        model('N', {
          fields: [
            idField(),
            field('a', { isNullable: true, maxLength: 3 }),
            field('j', { type: 'json', isNullable: true }),
            field('tags', { arrayDepth: 2, type: 'int' }),
            field('maybe', { arrayDepth: 1, isNullable: true }),
          ],
        }),
      ])
    );
    const props: Record<string, JsonObject> = properties(document, 'N');
    expect(props.a).toEqual({ type: ['string', 'null'], maxLength: 3 });
    expect(props.j).toEqual({});
    expect(props.tags).toEqual({
      type: 'array',
      items: { type: 'array', items: { type: 'integer' } },
    });
    expect(props.maybe).toEqual({
      type: ['array', 'null'],
      items: { type: 'string' },
    });
  });

  it('derives required and readOnly from nullability, defaults and generated values', () => {
    const { document } = emit(
      schemaOf([
        model('R', {
          fields: [
            idField(),
            field('name'),
            field('note', { isNullable: true }),
            field('flag', {
              type: 'boolean',
              default: { kind: 'literal', value: true },
            }),
            field('created', { type: 'dateTime', default: { kind: 'now' } }),
            field('touched', { type: 'dateTime', isAutoUpdated: true }),
            field('public_id', {
              type: 'uuid',
              default: { kind: 'uuid', version: 4 },
            }),
            field('total', {
              type: 'int',
              generated: { expression: 'F("a") + F("b")', isStored: true },
            }),
          ],
        }),
      ])
    );
    expect(definition(document, 'R').required).toEqual(['name']);
    const props: Record<string, JsonObject> = properties(document, 'R');
    expect(props.id).toEqual({ type: 'integer', readOnly: true });
    expect(props.flag).toEqual({ type: 'boolean', default: true });
    expect(props.created?.readOnly).toBe(true);
    expect(props.touched?.readOnly).toBe(true);
    expect(props.public_id?.readOnly).toBe(true);
    expect(props.total).toEqual({
      type: 'integer',
      description: 'Generated column: F("a") + F("b")',
      readOnly: true,
    });
    expect(props.name?.readOnly).toBeUndefined();
    expect(definition(document, 'R').additionalProperties).toBe(false);
  });

  it('omits required when nothing is required', () => {
    const { document } = emit(schemaOf([model('Only')]));
    expect(definition(document, 'Only').required).toBeUndefined();
  });

  it('writes enums with stored values, labels as description, and refs to them', () => {
    const { output, document } = emit(
      schemaOf(
        [
          model('Post', {
            fields: [
              idField(),
              field('status', {
                enumName: 'PostStatus',
                default: { kind: 'enumValue', value: 'DRAFT' },
              }),
              field('kind', { enumName: 'PostStatus', isNullable: true }),
              field('lost', { enumName: 'Missing' }),
            ],
          }),
        ],
        [
          {
            name: 'PostStatus',
            values: [
              { name: 'DRAFT', dbValue: 'draft', label: 'Draft' },
              { name: 'LIVE', dbValue: 'live' },
              { name: 'DUP', dbValue: 'live' },
            ],
          },
        ]
      )
    );
    expect(definition(document, 'PostStatus')).toEqual({
      type: 'string',
      enum: ['draft', 'live'],
      description: 'draft: Draft',
    });
    const props: Record<string, JsonObject> = properties(document, 'Post');
    expect(props.status).toEqual({
      $ref: '#/$defs/PostStatus',
      default: 'draft',
    });
    expect(props.kind).toEqual({
      anyOf: [{ $ref: '#/$defs/PostStatus' }, { type: 'null' }],
    });
    expect(props.lost).toEqual({ type: 'string' });
    expect(output.warnings.join('\n')).toContain('declared more than once');
    expect(output.warnings.join('\n')).toContain('"Missing" does not exist');
  });

  it('writes foreign keys as a scalar plus an optional $ref, with reverse sides', () => {
    const { document } = emit(
      schemaOf([
        model('User'),
        model('Post', {
          fields: [idField()],
          relations: [
            relation('author', 'User', { relatedName: 'posts' }),
            relation('editor', 'User', {
              isNullable: true,
              relatedName: 'edits',
            }),
          ],
        }),
        model('Profile', {
          relations: [
            relation('user', 'User', {
              kind: 'oneToOne',
              relatedName: 'profile',
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
      ])
    );
    const post: Record<string, JsonObject> = properties(document, 'Post');
    expect(post.author_id).toEqual({ type: 'integer' });
    expect(post.author).toEqual({ $ref: '#/$defs/User' });
    expect(post.editor_id).toEqual({ type: ['integer', 'null'] });
    expect(post.editor).toEqual({
      anyOf: [{ $ref: '#/$defs/User' }, { type: 'null' }],
    });
    expect(definition(document, 'Post').required).toEqual(['author_id']);
    expect(post.tags).toEqual({
      type: 'array',
      items: { $ref: '#/$defs/Tag' },
    });
    const user: Record<string, JsonObject> = properties(document, 'User');
    expect(user.posts).toEqual({
      type: 'array',
      items: { $ref: '#/$defs/Post' },
    });
    expect(user.profile).toEqual({
      anyOf: [{ $ref: '#/$defs/Profile' }, { type: 'null' }],
    });
    expect(definition(document, 'User').required).toBeUndefined();
  });

  it('types the foreign key from the referenced column and honours refPrefix', () => {
    const { document, output } = emit(
      schemaOf([
        model('Account', {
          fields: [
            field('slug', { isPrimaryKey: true, maxLength: 20 }),
            field('uid', { type: 'uuid', isUnique: true }),
          ],
        }),
        model('Note', {
          relations: [
            relation('account', 'Account'),
            relation('owner', 'Account', { toField: 'uid' }),
            relation('ghost', 'Nowhere'),
          ],
        }),
      ]),
      { refPrefix: '#/components/schemas/' }
    );
    const note: Record<string, JsonObject> = properties(document, 'Note');
    expect(note.account_id).toEqual({ type: 'string', maxLength: 20 });
    expect(note.owner_id).toEqual({ type: 'string', format: 'uuid' });
    expect(note.account).toEqual({ $ref: '#/components/schemas/Account' });
    expect(note.ghost).toBeUndefined();
    expect(output.warnings.join('\n')).toContain(
      '"Nowhere" does not exist in the schema'
    );
  });

  it('uses camelCase property names with camelFields and keeps names otherwise', () => {
    const schema: IrSchema = schemaOf([
      model('Post', {
        fields: [idField(), field('created_at', { type: 'dateTime' })],
        relations: [relation('blog_user', 'Post')],
      }),
    ]);
    const camel: JsonObject = properties(
      emit(schema, { camelFields: true }).document,
      'Post'
    );
    expect(Object.keys(camel)).toEqual([
      'id',
      'createdAt',
      'blogUserId',
      'blogUser',
      'postSet',
    ]);
    expect(Object.keys(properties(emit(schema).document, 'Post'))).toEqual([
      'id',
      'created_at',
      'blog_user_id',
      'blog_user',
      'post_set',
    ]);
  });

  it('writes hstore and range columns as objects', () => {
    const { document } = emit(
      schemaOf([
        model('X', {
          fields: [
            idField(),
            field('h', { type: 'hstore' }),
            field('r', { type: 'range', rangeOf: 'date' }),
          ],
        }),
      ])
    );
    const props: Record<string, JsonObject> = properties(document, 'X');
    expect(props.h).toEqual({
      type: 'object',
      additionalProperties: { type: ['string', 'null'] },
    });
    expect(props.r?.required).toEqual(['lower', 'upper']);
  });

  it('warns about unknown types and renames definitions that cannot be $ref targets', () => {
    const { output, document } = emit(
      schemaOf(
        [
          model('Odd Name', {
            fields: [idField(), field('c', { type: 'unsupported' })],
          }),
          model('S'),
        ],
        [{ name: 'S', values: [] }]
      )
    );
    expect(Object.keys(document.$defs as object)).toEqual([
      'S',
      'Odd_Name',
      'S2',
    ]);
    const warnings: string = output.warnings.join('\n');
    expect(warnings).toContain('"Odd Name" cannot be used in a $ref');
    expect(warnings).toContain('unknown field type "unsupported"');
    expect(warnings).toContain('already used by an enum or another model');
  });

  it('produces an empty $defs object for an empty schema', () => {
    const { document } = emit(schemaOf([]));
    expect(document.$defs).toEqual({});
  });

  it('is registered as a write-only json-schema format without extensions', () => {
    const adapter = getFormat('json-schema');
    expect(adapter.ok).toBe(true);
    if (!adapter.ok) {
      return;
    }
    expect(adapter.value.parse).toBeUndefined();
    expect(adapter.value.emit).toBeDefined();
    expect(adapter.value.extensions).toEqual([]);
    expect(getFormatByExtension('.json')).toBeUndefined();
  });
});
