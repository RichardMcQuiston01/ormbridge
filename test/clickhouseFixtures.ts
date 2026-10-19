import type { IrEnum, IrField, IrSchema } from '../src/ir.js';
import {
  field,
  idField,
  index,
  model,
  relation,
  schemaOf,
} from './gormFixtures.js';

/**
 * IR fixtures for the ClickHouse dialect of the SQL DDL writer: one model with every scalar type
 * (plain, nullable and as an array), enum, default and index forms, composite and missing primary
 * keys, relations that become plain columns, and awkward names.
 */

export const ROLE: IrEnum = {
  name: 'Role',
  values: [
    { name: 'ADMIN', dbValue: 'admin' },
    { name: 'MEMBER', dbValue: "it's a member" },
  ],
};

/** An enum with more members than Enum8 holds. */
export function bigEnum(count: number): IrEnum {
  return {
    name: 'Big',
    values: Array.from({ length: count }, (_unused, position: number) => ({
      name: `V${position}`,
      dbValue: `v${position}`,
    })),
  };
}

/** Every scalar type, once required and once nullable, plus arrays. */
export function scalarFields(): IrField[] {
  const types: IrField['type'][] = [
    'string',
    'text',
    'int',
    'bigInt',
    'float',
    'decimal',
    'boolean',
    'dateTime',
    'date',
    'time',
    'uuid',
    'json',
    'bytes',
    'duration',
    'ipAddress',
    'hstore',
    'range',
  ];
  return types.flatMap((type: IrField['type']): IrField[] => [
    field(`${type}_col`, { type }),
    field(`${type}_opt`, { type, isNullable: true }),
  ]);
}

export function clickhouseTypesSchema(): IrSchema {
  const everything = model('Everything', {
    tableName: 'everything',
    fields: [
      idField({ default: undefined }),
      ...scalarFields(),
      field('name_short', { type: 'string', maxLength: 50 }),
      field('amount', { type: 'decimal', maxDigits: 12, decimalPlaces: 4 }),
      field('amount_opt', {
        type: 'decimal',
        maxDigits: 20,
        decimalPlaces: 2,
        isNullable: true,
      }),
      field('role', { type: 'string', enumName: 'Role' }),
      field('role_opt', {
        type: 'string',
        enumName: 'Role',
        isNullable: true,
      }),
      field('tags', { type: 'string', arrayDepth: 1 }),
      field('tags_opt', { type: 'string', arrayDepth: 1, isNullable: true }),
      field('grid', { type: 'int', arrayDepth: 2 }),
      field('roles', { type: 'string', enumName: 'Role', arrayDepth: 1 }),
      field('tiny', {
        type: 'int',
        nativeType: { name: 'UnsignedTinyInt', args: [] },
      }),
      field('big_unsigned', {
        type: 'bigInt',
        nativeType: { name: 'UnsignedBigInt', args: [] },
      }),
      field('ratio', {
        type: 'float',
        nativeType: { name: 'Real', args: [] },
      }),
      field('code', {
        type: 'string',
        nativeType: { name: 'Char', args: ['8'] },
      }),
      field('stamp', {
        type: 'dateTime',
        nativeType: { name: 'Timestamp', args: ['6'] },
      }),
    ],
    indexes: [
      index(['string_col']),
      index(['int_col']),
      index(['int_col', 'string_col']),
      index(['role']),
      index(['text_col'], { kind: 'fulltext' }),
      index(['uuid_col'], { isUnique: true }),
      index(['tags']),
      index(['hstore_col']),
    ],
  });

  const defaults = model('Defaults', {
    tableName: 'defaults',
    fields: [
      field('id', {
        type: 'uuid',
        isPrimaryKey: true,
        default: { kind: 'uuid' },
      }),
      field('created_at', { type: 'dateTime', default: { kind: 'now' } }),
      field('day', { type: 'date', default: { kind: 'now' } }),
      field('count', { type: 'int', default: { kind: 'literal', value: 7 } }),
      field('price', {
        type: 'decimal',
        maxDigits: 8,
        decimalPlaces: 2,
        default: { kind: 'literal', value: '9.99' },
      }),
      field('label', {
        type: 'string',
        default: { kind: 'literal', value: "O'Brien \\ co" },
      }),
      field('active', {
        type: 'boolean',
        default: { kind: 'literal', value: true },
      }),
      field('role', {
        type: 'string',
        enumName: 'Role',
        default: { kind: 'enumValue', value: 'MEMBER' },
      }),
      field('seen', {
        type: 'dateTime',
        default: { kind: 'literal', value: '2024-01-02T03:04:05.000Z' },
      }),
      field('list', {
        type: 'string',
        arrayDepth: 1,
        default: { kind: 'literal', value: '["a","b"]' },
      }),
      field('payload', {
        type: 'json',
        default: { kind: 'literal', value: '{}' },
      }),
      field('token', {
        type: 'uuid',
        default: { kind: 'dbExpression', expression: 'gen_random_uuid()' },
      }),
      field('stamp', {
        type: 'dateTime',
        default: { kind: 'dbExpression', expression: 'CURRENT_TIMESTAMP' },
      }),
      field('total', {
        type: 'int',
        default: { kind: 'dbExpression', expression: '1 + 2' },
      }),
    ],
  });

  const generated = model('Generated', {
    tableName: 'generated',
    fields: [
      idField({ default: undefined }),
      field('a', { type: 'int' }),
      field('b', { type: 'int' }),
      field('total', {
        type: 'int',
        generated: { expression: 'F("a") + F("b") * 2', isStored: true },
      }),
      field('double', {
        type: 'int',
        generated: { expression: 'F("a") * 2', isStored: false },
      }),
      field('opaque', {
        type: 'string',
        generated: { expression: 'Concat(F("a"), Value("x"))', isStored: true },
      }),
    ],
  });

  const keyed = model('Keyed', {
    tableName: 'keyed',
    fields: [
      field('tenant', { type: 'string', isPrimaryKey: true }),
      field('seq', { type: 'bigInt', isPrimaryKey: true }),
      field('value', { type: 'string', isNullable: true }),
    ],
    compositePrimaryKey: ['tenant', 'seq'],
  });

  const keylessFirstKey = model('Nullable key', {
    tableName: 'nullable_key',
    fields: [
      field('k', { type: 'int', isPrimaryKey: true, isNullable: true }),
      field('v', { type: 'string' }),
    ],
  });

  const keyless = model('Keyless', {
    tableName: 'keyless',
    fields: [field('note', { type: 'string' })],
  });

  const author = model('Author', {
    tableName: 'authors',
    fields: [
      idField({ type: 'bigInt', default: undefined }),
      field('email', { type: 'string', isUnique: true }),
    ],
  });
  const post = model('Post', {
    tableName: 'posts',
    fields: [
      field('id', { type: 'uuid', isPrimaryKey: true }),
      idField({ name: 'seq', columnName: 'seq', isPrimaryKey: false }),
    ],
    relations: [
      relation('author', 'Author'),
      relation('editor', 'Author', { isNullable: true, onDelete: 'setNull' }),
      relation('profile', 'Author', { kind: 'oneToOne' }),
      relation('tags', 'Tag', { kind: 'manyToMany', columnName: '' }),
    ],
  });
  const tag = model('Tag', {
    tableName: 'tags',
    fields: [
      idField({ default: undefined }),
      field('label', { type: 'string' }),
    ],
  });

  const awkward = model('Awkward', {
    tableName: 'select',
    fields: [
      field('id', { type: 'int', isPrimaryKey: true }),
      field('order', { type: 'string' }),
      field('Mixed Case', { type: 'string', columnName: 'Mixed Case' }),
      field('back`tick', { type: 'int', columnName: 'back`tick' }),
      field('quote"d', {
        type: 'int',
        columnName: 'quote"d',
        isNullable: true,
      }),
      field('1st', { type: 'int', columnName: '1st' }),
      field('date', { type: 'date' }),
    ],
    indexes: [index(['order']), index(['Mixed Case'])],
  });

  const prefixed = model('Prefixed', {
    tableName: 'events',
    schema: 'analytics',
    fields: [idField({ default: undefined })],
  });

  return schemaOf(
    [
      everything,
      defaults,
      generated,
      keyed,
      keylessFirstKey,
      keyless,
      author,
      post,
      tag,
      awkward,
      prefixed,
    ],
    [ROLE]
  );
}
