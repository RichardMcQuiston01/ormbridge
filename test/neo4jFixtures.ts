import type { IrEnum, IrModel, IrSchema } from '../src/ir.js';
import {
  field,
  idField,
  index,
  model,
  relation,
  schemaOf,
} from './gormFixtures.js';

/** IR fixtures for the Neo4j tests: every property type, awkward names, keys, indexes and join tables. */

const KIND: IrEnum = {
  name: 'Kind',
  values: [
    { name: 'BOOK', dbValue: 'book' },
    { name: 'FILM', dbValue: 'film; "quoted"\nsecond line' },
  ],
};

/** Every IR scalar type, an array, a nested array, an enum and awkward property names. */
export function typesModel(): IrModel {
  return model('Item', {
    tableName: 'items',
    fields: [
      idField({ type: 'uuid', default: { kind: 'uuid' } }),
      field('title', { maxLength: 80 }),
      field('body', { type: 'text', isNullable: true }),
      field('count', { type: 'int' }),
      field('big', { type: 'bigInt', isNullable: true }),
      field('ratio', { type: 'float', isNullable: true }),
      field('price', {
        type: 'decimal',
        maxDigits: 8,
        decimalPlaces: 2,
        isNullable: true,
      }),
      field('flag', {
        type: 'boolean',
        default: { kind: 'literal', value: true },
      }),
      field('born', { type: 'date', isNullable: true }),
      field('seen_at', { type: 'dateTime', default: { kind: 'now' } }),
      field('local_at', {
        type: 'dateTime',
        isNullable: true,
        nativeType: { name: 'Timestamp', args: [] },
      }),
      field('opens', { type: 'time', isNullable: true }),
      field('opens_tz', {
        type: 'time',
        isNullable: true,
        nativeType: { name: 'Timetz', args: [] },
      }),
      field('span', { type: 'duration', isNullable: true }),
      field('settings', { type: 'json', isNullable: true }),
      field('cover', { type: 'bytes', isNullable: true }),
      field('address', { type: 'ipAddress', isNullable: true }),
      field('extra', { type: 'hstore', isNullable: true }),
      field('window', { type: 'range', rangeOf: 'int', isNullable: true }),
      field('shape', {
        type: 'unsupported',
        unsupportedType: 'circle',
        isNullable: true,
      }),
      field('labels', { arrayDepth: 1, isNullable: true }),
      field('numbers', { type: 'int', arrayDepth: 1, isNullable: true }),
      field('grid', { type: 'int', arrayDepth: 2, isNullable: true }),
      field('blobs', { type: 'bytes', arrayDepth: 1, isNullable: true }),
      field('kind', {
        enumName: 'Kind',
        default: { kind: 'enumValue', value: 'BOOK' },
      }),
      field('select', { columnName: 'order by', isNullable: true }),
      field('back`tick', { columnName: 'back`tick', isNullable: true }),
      field('2fast', { columnName: '2fast', isNullable: true }),
      field('stamp', {
        type: 'dateTime',
        isAutoUpdated: true,
        isNullable: true,
      }),
      field('computed', {
        isNullable: true,
        generated: { expression: 'a || b', isStored: true },
      }),
    ],
  });
}

/** A node with a composite primary key, unique and plain indexes of every kind, and a self reference. */
export function keysSchema(): IrSchema {
  const ledger: IrModel = model('Ledger', {
    tableName: 'ledgers',
    fields: [
      field('year', { type: 'int' }),
      field('number', { type: 'int' }),
      field('memo', { isNullable: true }),
      field('code', { isUnique: true }),
      field('owner_id', { type: 'int', isNullable: true }),
    ],
    compositePrimaryKey: ['year', 'number'],
    relations: [
      relation('parent', 'Ledger', {
        columnName: 'parent_id',
        isNullable: true,
        onDelete: 'setNull',
        relatedName: 'children',
      }),
    ],
    indexes: [
      index(['memo']),
      index(['memo', 'code']),
      index(['memo', 'code'], { isUnique: true }),
      index(['code']),
      index(['memo'], { kind: 'fulltext' }),
      index(['memo'], { method: 'Hash' }),
      index(['year'], { fieldOptions: { year: { sort: 'desc' } } }),
      index(['missing']),
    ],
  });
  const line: IrModel = model('LineItem', {
    tableName: 'line_items',
    fields: [
      idField(),
      field('ledger_year', { type: 'int' }),
      field('ledger_number', { type: 'int' }),
    ],
    compositeForeignKeys: [
      {
        name: 'ledger',
        targetModel: 'Ledger',
        fields: ['ledger_year', 'ledger_number'],
        references: ['year', 'number'],
        kind: 'foreignKey',
        isNullable: false,
        onDelete: 'cascade',
      },
    ],
  });
  return schemaOf([ledger, line, typesModel()], [KIND]);
}

/** Join tables: with a surrogate key and extra columns, with a composite key, and a mirrored many-to-many. */
export function joinsSchema(): IrSchema {
  const student: IrModel = model('Student', { tableName: 'students' });
  const course: IrModel = model('Course', {
    tableName: 'courses',
    relations: [
      relation('teachers', 'Teacher', {
        kind: 'manyToMany',
        columnName: 'teachers_id',
        relatedName: 'courses',
      }),
    ],
  });
  const teacher: IrModel = model('Teacher', {
    tableName: 'teachers',
    relations: [
      relation('courses', 'Course', {
        kind: 'manyToMany',
        columnName: 'courses_id',
        relatedName: 'teachers',
      }),
    ],
  });
  const enrollment: IrModel = model('Enrollment', {
    tableName: 'enrollments',
    fields: [
      idField(),
      field('ticket', { isUnique: true }),
      field('role', { default: { kind: 'literal', value: 'student' } }),
      field('note', { isNullable: true }),
      field('seat', { type: 'int', isNullable: true }),
    ],
    relations: [
      relation('student', 'Student', { relatedName: 'courses' }),
      relation('course', 'Course', { relatedName: 'students' }),
    ],
    indexes: [
      index(['student', 'course'], { isUnique: true }),
      index(['seat', 'role'], { isUnique: true }),
      index(['note']),
    ],
  });
  const membership: IrModel = model('Membership', {
    tableName: 'memberships',
    fields: [],
    relations: [
      relation('student', 'Student', { isPrimaryKey: true }),
      relation('club', 'Club', { isPrimaryKey: true }),
    ],
  });
  const club: IrModel = model('Club', { tableName: 'clubs' });
  return schemaOf([student, course, teacher, enrollment, membership, club]);
}
