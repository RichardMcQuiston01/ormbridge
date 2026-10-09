import type { IrEnum, IrModel, IrSchema } from '../src/ir.js';
import {
  STATUS,
  field,
  idField,
  index,
  kitchenSinkSchema,
  model,
  relation,
  schemaOf,
  stressSchema,
} from './gormFixtures.js';

/** IR fixtures for the Drizzle tests: the GORM kitchen sink plus schemas of the shapes Drizzle is picky about. */

const COLOR: IrEnum = {
  name: 'color',
  dbName: 'color_t',
  values: [
    { name: 'RED', dbValue: 'red' },
    { name: 'GREEN', dbValue: 'green', label: 'Green' },
  ],
};

/**
 * A schema that stresses the constructs Drizzle handles differently from the other emitters:
 * a reference cycle between tables, a self reference, a UUID primary key that foreign keys copy the
 * type of, a reference to a unique column, a multi-table-inheritance style key (a relation that is
 * the primary key), array, enum, range, hstore and duration columns, JSON, date and decimal
 * defaults, and model names that collide with the builders Drizzle exports.
 */
export function constructsSchema(): IrSchema {
  const author: IrModel = model('Author', {
    tableName: 'authors',
    fields: [
      field('id', {
        type: 'uuid',
        isPrimaryKey: true,
        default: { kind: 'uuid' },
      }),
      field('handle', { maxLength: 30, isUnique: true }),
      field('favourite_book_id', {
        type: 'int',
        isNullable: true,
      }),
    ],
    relations: [
      relation('latest_book', 'Book', {
        columnName: 'latest_book_id',
        isNullable: true,
        onDelete: 'setNull',
        relatedName: 'latest_for',
      }),
    ],
  });
  const book: IrModel = model('Book', {
    tableName: 'books',
    fields: [
      idField({ type: 'bigInt' }),
      field('title', { maxLength: 120 }),
      field('tags', {
        arrayDepth: 1,
        default: { kind: 'literal', value: '[]' },
      }),
      field('grid', { type: 'int', arrayDepth: 2, isNullable: true }),
      field('colors', { enumName: 'color', arrayDepth: 1, isNullable: true }),
      field('color', {
        enumName: 'color',
        default: { kind: 'enumValue', value: 'RED' },
      }),
      field('price', {
        type: 'decimal',
        maxDigits: 8,
        decimalPlaces: 2,
        default: { kind: 'literal', value: 9.99 },
      }),
      field('settings', {
        type: 'json',
        default: {
          kind: 'literal',
          value: '{"theme": "dark", "tabs": [1, 2]}',
        },
      }),
      field('published_on', {
        type: 'date',
        default: { kind: 'now' },
      }),
      field('opens_at', { type: 'time', isNullable: true }),
      field('released_at', {
        type: 'dateTime',
        isNullable: true,
        default: { kind: 'literal', value: '2020-01-02T03:04:05Z' },
      }),
      field('pages', { type: 'int', default: { kind: 'literal', value: 100 } }),
      field('ratio', {
        type: 'float',
        default: { kind: 'literal', value: 0.5 },
      }),
      field('in_print', {
        type: 'boolean',
        default: { kind: 'literal', value: true },
      }),
      field('notes', { type: 'text', isNullable: true }),
      field('window', { type: 'range', rangeOf: 'int', isNullable: true }),
      field('extra', { type: 'hstore', isNullable: true }),
      field('read_time', { type: 'duration', isNullable: true }),
      field('cover', { type: 'bytes', isNullable: true }),
    ],
    relations: [
      relation('author', 'Author', {
        columnName: 'author_id',
        relatedName: 'books',
        onUpdate: 'cascade',
      }),
      relation('editor', 'Author', {
        columnName: 'editor_id',
        isNullable: true,
        onDelete: 'setNull',
        relatedName: 'edited_books',
      }),
      relation('series', 'Series', {
        columnName: 'series_handle',
        toField: 'handle',
        isNullable: true,
        onDelete: 'setNull',
      }),
    ],
    indexes: [
      index(['title', 'author'], { isUnique: true }),
      index(['published_on'], { name: 'books_published_idx' }),
    ],
  });
  const series: IrModel = model('Series', {
    tableName: 'series',
    fields: [
      idField(),
      field('handle', {
        maxLength: 20,
        isUnique: true,
        uniqueName: 'series_handle_uq',
      }),
    ],
    relations: [
      relation('parent', 'Series', {
        columnName: 'parent_id',
        isNullable: true,
        onDelete: 'setNull',
        relatedName: 'children',
      }),
    ],
  });
  const audiobook: IrModel = model('Audiobook', {
    tableName: 'audiobooks',
    fields: [field('minutes', { type: 'int' })],
    relations: [
      relation('book', 'Book', {
        kind: 'oneToOne',
        columnName: 'book_ptr_id',
        isPrimaryKey: true,
        relatedName: 'audiobook',
      }),
    ],
  });
  const reserved: IrModel = model('index', {
    tableName: 'index_rows',
    fields: [
      idField(),
      field('sql', { isNullable: true }),
      field('class', { columnName: 'class', isNullable: true }),
    ],
    relations: [
      relation('table', 'Series', {
        columnName: 'table',
        isNullable: true,
        onDelete: 'noAction',
      }),
    ],
  });
  const tagged: IrModel = model('Tagged', {
    tableName: 'tagged',
    fields: [idField({ type: 'bigInt' })],
    relations: [
      relation('books', 'Book', { kind: 'manyToMany', columnName: 'books_id' }),
    ],
  });
  return schemaOf(
    [author, book, series, audiobook, reserved, tagged],
    [COLOR, STATUS]
  );
}

/** Every IR fixture the real-tool tests run, with a short label. */
export const DRIZZLE_IR_FIXTURES: readonly (readonly [
  string,
  () => IrSchema,
])[] = [
  ['kitchen-sink', kitchenSinkSchema],
  ['stress', stressSchema],
  ['constructs', constructsSchema],
];
