import type { IrSchema } from '../src/ir.js';
import {
  field,
  idField,
  index,
  model,
  relation,
  schemaOf,
  STATUS,
} from './gormFixtures.js';

/**
 * A schema for the `--provider cockroachdb` tests. It holds what CockroachDB writes differently from
 * PostgreSQL: 32-bit and 64-bit auto-increment keys, a UUID key with a database default, hstore, range
 * and multi-dimensional array columns (none of which CockroachDB has), a JSON column, native types the
 * Prisma provider names differently, an auto-updated timestamp, and the PostgreSQL index methods.
 *
 * Every construct that CockroachDB rejects is one the writers replace, so the SQL it produces runs on a
 * real CockroachDB (see cockroachdb-verify.test.ts).
 */
export function cockroachSchema(): IrSchema {
  const tenant = model('Tenant', {
    tableName: 'tenants',
    fields: [
      field('id', {
        type: 'uuid',
        isPrimaryKey: true,
        default: { kind: 'uuid' },
      }),
      field('name', { maxLength: 80, isUnique: true }),
      field('status', {
        enumName: 'Status',
        maxLength: 10,
        default: { kind: 'enumValue', value: 'DRAFT' },
      }),
    ],
  });
  const account = model('Account', {
    tableName: 'accounts',
    fields: [
      idField({ type: 'int' }),
      field('email', { maxLength: 255, isUnique: true }),
      field('age', { type: 'int', isNullable: true }),
      field('visits', {
        type: 'bigInt',
        default: { kind: 'literal', value: 0 },
      }),
      field('balance', { type: 'decimal', maxDigits: 12, decimalPlaces: 2 }),
      field('bio', { type: 'text', isNullable: true }),
      field('active', {
        type: 'boolean',
        default: { kind: 'literal', value: true },
      }),
      field('created_at', { type: 'dateTime', default: { kind: 'now' } }),
      field('updated_at', { type: 'dateTime', isAutoUpdated: true }),
      field('prefs', { type: 'json', isNullable: true }),
      field('labels', { type: 'string', arrayDepth: 1 }),
      field('grid', { type: 'int', arrayDepth: 2, isNullable: true }),
      field('attributes', {
        type: 'hstore',
        default: { kind: 'literal', value: '{}' },
      }),
      field('stock_range', {
        type: 'range',
        rangeOf: 'int',
        isNullable: true,
      }),
      field('last_ip', { type: 'ipAddress', isNullable: true }),
      field('shelf_life', { type: 'duration', isNullable: true }),
      field('avatar', { type: 'bytes', isNullable: true }),
      field('status', {
        enumName: 'Status',
        maxLength: 10,
        default: { kind: 'enumValue', value: 'DRAFT' },
      }),
    ],
    relations: [relation('tenant', 'Tenant', { onDelete: 'cascade' })],
    indexes: [
      index(['created_at']),
      index(['email', 'status'], { isUnique: true }),
      index(['prefs'], {
        method: 'gin',
        fieldOptions: { prefs: { ops: 'JsonbPathOps' } },
      }),
      index(['labels'], { method: 'gin' }),
      index(['email'], { method: 'hash' }),
      index(['stock_range'], { method: 'gist' }),
      index(['age'], { method: 'brin' }),
      index(['visits'], { method: 'gin' }),
    ],
  });
  const event = model('Event', {
    tableName: 'events',
    fields: [
      idField({ type: 'bigInt' }),
      field('kind', { type: 'int', default: { kind: 'literal', value: 0 } }),
      field('payload', {
        type: 'json',
        default: { kind: 'literal', value: '{}' },
      }),
    ],
    relations: [
      relation('account', 'Account', { onDelete: 'setNull', isNullable: true }),
    ],
  });
  return schemaOf([tenant, account, event], [STATUS]);
}
