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
 * An IR schema for the JPA writer with the shapes that need special handling: classes named like imported types,
 * attributes named like Java keywords, a composite key made of a relation and a column, a shared primary key, a
 * model without a key, a string key that foreign keys copy, a reference to a non-key column, enums stored as names,
 * as their position and as other numbers, the literal defaults of every scalar type, arrays and a generated column.
 */
export function jpaEdgesSchema(): IrSchema {
  const level: IrEnum = {
    name: 'Level',
    values: [
      { name: 'LOW', dbValue: '0' },
      { name: 'MID', dbValue: '1' },
      { name: 'HIGH', dbValue: '2' },
    ],
  };
  const grade: IrEnum = {
    name: 'Grade',
    values: [
      { name: 'A', dbValue: '10' },
      { name: 'B', dbValue: '20' },
    ],
  };
  const color: IrEnum = {
    name: 'Color',
    values: [
      { name: 'RED', dbValue: 'RED' },
      { name: 'GREEN', dbValue: 'GREEN' },
    ],
  };
  const mode: IrEnum = {
    name: 'mode',
    values: [
      { name: 'default', dbValue: 'default' },
      { name: 'new', dbValue: 'n' },
    ],
  };
  const table = model('Table', {
    tableName: 'tables',
    fields: [
      idField(),
      field('class', { maxLength: 30 }),
      field('long', { type: 'int', default: { kind: 'literal', value: 3 } }),
      field('Equals', { type: 'int', isNullable: true }),
      field('user_id', { type: 'int', isNullable: true }),
      field('userId', { type: 'int', isNullable: true, columnName: 'uid' }),
      field('mode', {
        enumName: 'mode',
        maxLength: 12,
        default: { kind: 'literal', value: 'new' },
      }),
    ],
    indexes: [index(['class', 'long'], { isUnique: true, name: 'class_long' })],
  });
  const everything = model('Everything', {
    tableName: 'everything',
    fields: [
      field('id', {
        type: 'uuid',
        isPrimaryKey: true,
        default: { kind: 'uuid' },
      }),
      field('code', { maxLength: 40, isUnique: true }),
      field('slug', { maxLength: 20, isUnique: true, uniqueName: 'slug_uq' }),
      field('summary', { type: 'text' }),
      field('open_text'),
      field('small', { type: 'int', default: { kind: 'literal', value: -4 } }),
      field('big', { type: 'bigInt', default: { kind: 'literal', value: 5 } }),
      field('ratio', {
        type: 'float',
        default: { kind: 'literal', value: 2 },
      }),
      field('amount', {
        type: 'decimal',
        maxDigits: 12,
        decimalPlaces: 3,
        default: { kind: 'literal', value: 1.5 },
      }),
      field('flag', {
        type: 'boolean',
        default: { kind: 'literal', value: true },
      }),
      field('note', {
        maxLength: 60,
        default: { kind: 'literal', value: 'it\'s a "quote"\\' },
      }),
      field('born', { type: 'date', default: { kind: 'now' } }),
      field('opens', { type: 'time', isNullable: true }),
      field('seen_at', { type: 'dateTime', default: { kind: 'now' } }),
      field('created_at', { type: 'dateTime', default: { kind: 'now' } }),
      field('updated_at', { type: 'dateTime', isAutoUpdated: true }),
      field('took', { type: 'duration', isNullable: true }),
      field('payload', { type: 'bytes', isNullable: true }),
      field('meta', {
        type: 'json',
        default: { kind: 'literal', value: '{}' },
      }),
      field('extra', { type: 'json', isNullable: true }),
      field('other_id', { type: 'uuid', isNullable: true }),
      field('tags', { maxLength: 20, arrayDepth: 1, isNullable: true }),
      field('scores', { type: 'int', arrayDepth: 1, isNullable: true }),
      field('level', { type: 'int', enumName: 'Level', isNullable: true }),
      field('grade', {
        type: 'int',
        enumName: 'Grade',
        default: { kind: 'enumValue', value: 'B' },
      }),
      field('color', { enumName: 'Color', maxLength: 10 }),
      field('total', {
        type: 'int',
        isNullable: true,
        generated: { expression: '"small" * 2', isStored: true },
      }),
    ],
    indexes: [
      index(['small', 'big'], { fieldOptions: { small: { sort: 'desc' } } }),
      index(['code', 'ratio'], { isUnique: true }),
    ],
  });
  const person = model('Person', {
    tableName: 'people',
    fields: [idField({ type: 'bigInt' }), field('name', { maxLength: 50 })],
  });
  const passport = model('Passport', {
    tableName: 'passports',
    fields: [field('number', { maxLength: 20 })],
    relations: [
      relation('person', 'Person', {
        kind: 'oneToOne',
        columnName: 'person_id',
        isPrimaryKey: true,
        relatedName: 'passport',
      }),
    ],
  });
  const order = model('Order', {
    tableName: 'orders',
    fields: [idField(), field('placed', { type: 'date', isNullable: true })],
  });
  const line = model('OrderLine', {
    tableName: 'order_lines',
    fields: [
      field('line_no', { type: 'int' }),
      field('quantity', {
        type: 'int',
        default: { kind: 'literal', value: 1 },
      }),
    ],
    relations: [
      relation('order', 'Order', {
        columnName: 'order_id',
        relatedName: 'lines',
      }),
    ],
    compositePrimaryKey: ['order', 'line_no'],
  });
  const ledger = model('Ledger', {
    tableName: 'ledgers',
    fields: [
      field('code', { maxLength: 12, isPrimaryKey: true }),
      field('number', { type: 'int', isUnique: true }),
    ],
  });
  const entry = model('LedgerEntry', {
    tableName: 'ledger_entries',
    fields: [idField({ type: 'bigInt' })],
    relations: [
      relation('ledger', 'Ledger', {
        columnName: 'ledger_code',
        onDelete: 'restrict',
        relatedName: 'entries',
      }),
      relation('by_number', 'Ledger', {
        columnName: 'ledger_number',
        toField: 'number',
        isNullable: true,
        onDelete: 'setNull',
        constraintName: 'fk_entry_number',
      }),
    ],
  });
  const note = model('Note', {
    tableName: 'notes',
    fields: [
      field('text', { type: 'text' }),
      field('at', { type: 'dateTime', default: { kind: 'now' } }),
    ],
  });
  const audit = model('Audit', {
    tableName: 'audit_rows',
    schema: 'audit',
    fields: [idField(), field('what', { maxLength: 20 })],
  });
  const friend = model('Friend', {
    tableName: 'friends',
    fields: [idField(), field('name', { maxLength: 50 })],
    relations: [
      relation('friends', 'Friend', {
        kind: 'manyToMany',
        columnName: 'friends_id',
        relatedName: 'friend_of',
      }),
      relation('boss', 'Friend', {
        columnName: 'boss_id',
        isNullable: true,
        onDelete: 'setNull',
        relatedName: 'reports',
      }),
    ],
  });
  return schemaOf(
    [
      table,
      everything,
      person,
      passport,
      order,
      line,
      ledger,
      entry,
      note,
      audit,
      friend,
    ],
    [level, grade, color, mode]
  );
}
