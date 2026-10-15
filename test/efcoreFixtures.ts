import type { IrEnum, IrSchema } from '../src/ir.js';
import {
  field,
  idField,
  index,
  model,
  relation,
  schemaOf,
} from './gormFixtures.js';

/**
 * An IR schema for the EF Core writer with the shapes that need special handling: names that are C# keywords or
 * clash with types and members, a string key that foreign keys copy, SET NULL on a required relation, SET DEFAULT,
 * composite foreign keys (to a composite key and to alternate keys), a self-referencing many-to-many, a model
 * without a key, enums stored as numbers and as names, and the literal defaults of every scalar type.
 */
export function edgesSchema(): IrSchema {
  const level: IrEnum = {
    name: 'Level',
    values: [
      { name: 'Low', dbValue: '0' },
      { name: 'High', dbValue: '2' },
    ],
  };
  const mode: IrEnum = {
    name: 'mode',
    values: [
      { name: 'default', dbValue: 'default' },
      { name: 'new', dbValue: 'new' },
    ],
  };
  const account = model('Account', {
    tableName: 'accounts',
    fields: [
      field('id', {
        type: 'uuid',
        isPrimaryKey: true,
        default: { kind: 'uuid' },
      }),
      field('class', { maxLength: 30 }),
      field('Equals', { type: 'int', default: { kind: 'literal', value: 1 } }),
      field('account', { isNullable: true }),
      field('level', {
        type: 'int',
        enumName: 'Level',
        default: { kind: 'enumValue', value: 'High' },
      }),
      field('mode', {
        enumName: 'mode',
        maxLength: 12,
        default: { kind: 'literal', value: 'new' },
      }),
      field('big', { type: 'bigInt', default: { kind: 'literal', value: 5 } }),
      field('amount', {
        type: 'decimal',
        maxDigits: 8,
        decimalPlaces: 2,
        default: { kind: 'literal', value: 1.5 },
      }),
      field('price', {
        type: 'float',
        default: { kind: 'literal', value: 2 },
      }),
      field('notes', {
        type: 'text',
        default: { kind: 'literal', value: 'it\'s a "quote"\\' },
      }),
      field('flag', {
        type: 'boolean',
        default: { kind: 'literal', value: true },
      }),
      field('born', { type: 'date', default: { kind: 'now' } }),
      field('meta', {
        type: 'json',
        default: { kind: 'literal', value: '{"a": 1}' },
      }),
      field('slug', { maxLength: 40, isUnique: true, uniqueName: 'slug_uq' }),
      field('stamp', {
        type: 'dateTime',
        default: { kind: 'dbExpression', expression: "datetime('now')" },
      }),
    ],
    indexes: [
      index(['class', 'level'], { isUnique: true, name: 'class_level' }),
      index(['big', 'price'], {
        fieldOptions: { big: { sort: 'desc' } },
      }),
    ],
  });
  const objectModel = model('Object', {
    tableName: 'objects',
    fields: [idField(), field('title', { isNullable: true })],
    relations: [
      relation('account', 'Account', {
        isNullable: true,
        onDelete: 'restrict',
        columnName: 'owner_id',
        relatedName: 'objects',
      }),
    ],
  });
  const ledger = model('Ledger', {
    tableName: 'ledgers',
    fields: [
      field('code', { maxLength: 12, isPrimaryKey: true }),
      field('balance', { type: 'decimal', maxDigits: 10, decimalPlaces: 2 }),
    ],
  });
  const entry = model('LedgerEntry', {
    tableName: 'ledger_entries',
    fields: [idField({ type: 'bigInt' })],
    relations: [
      // SET NULL on a column that is NOT NULL.
      relation('ledger', 'Ledger', {
        columnName: 'ledger_code',
        onDelete: 'setNull',
        relatedName: 'entries',
      }),
      relation('other', 'Ledger', {
        columnName: 'other_code',
        isNullable: true,
        onDelete: 'setDefault',
      }),
    ],
  });
  const shipment = model('Shipment', {
    tableName: 'shipments',
    fields: [
      field('order_no', { type: 'int', columnName: 'order_no' }),
      field('line_no', { type: 'int', columnName: 'line_no' }),
    ],
    compositePrimaryKey: ['order_no', 'line_no'],
  });
  const region = model('Region', {
    tableName: 'regions',
    fields: [
      idField(),
      field('code', { maxLength: 8 }),
      field('zone', { type: 'int' }),
    ],
    indexes: [index(['code', 'zone'], { isUnique: true })],
  });
  const parcel = model('Parcel', {
    tableName: 'parcels',
    fields: [
      idField(),
      field('ship_order', { type: 'int', isNullable: true }),
      field('ship_line', { type: 'int', isNullable: true }),
      field('region_code', { maxLength: 8 }),
      field('region_zone', { type: 'int' }),
    ],
    compositeForeignKeys: [
      {
        name: 'shipment',
        targetModel: 'Shipment',
        fields: ['ship_order', 'ship_line'],
        references: ['order_no', 'line_no'],
        kind: 'foreignKey',
        isNullable: true,
        onDelete: 'setNull',
        relatedName: 'parcels',
      },
      {
        name: 'region',
        targetModel: 'Region',
        fields: ['region_code', 'region_zone'],
        references: ['code', 'zone'],
        kind: 'foreignKey',
        isNullable: false,
        onDelete: 'cascade',
        constraintName: 'fk_parcel_region',
      },
    ],
  });
  const person = model('Person', {
    tableName: 'people',
    fields: [idField(), field('name', { maxLength: 50 })],
    relations: [
      relation('friends', 'Person', {
        kind: 'manyToMany',
        columnName: 'friends_id',
        relatedName: 'friend_of',
      }),
      relation('boss', 'Person', {
        columnName: 'boss_id',
        isNullable: true,
        onDelete: 'setNull',
        relatedName: 'reports',
      }),
    ],
  });
  const tag = model('Tag', {
    tableName: 'tags',
    fields: [idField(), field('label', { maxLength: 20 })],
  });
  const post = model('Post', {
    tableName: 'posts',
    fields: [idField(), field('title', { maxLength: 80 })],
    relations: [
      relation('tags', 'Tag', { kind: 'manyToMany', columnName: 'tags_id' }),
    ],
  });
  const log = model('Log', {
    tableName: 'logs',
    fields: [
      field('line', { type: 'text' }),
      field('at', { type: 'dateTime', default: { kind: 'now' } }),
    ],
  });
  const audit = model('Audit', {
    tableName: 'audit_rows',
    schema: 'audit',
    fields: [idField(), field('what', { maxLength: 20 })],
  });
  return schemaOf(
    [
      account,
      objectModel,
      ledger,
      entry,
      shipment,
      region,
      parcel,
      person,
      tag,
      post,
      log,
      audit,
    ],
    [level, mode]
  );
}
