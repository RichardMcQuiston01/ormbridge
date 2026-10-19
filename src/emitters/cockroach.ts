import type { IrField } from '../ir.js';
import type { PrismaProvider } from './prisma.js';

/**
 * Shared facts about `--provider cockroachdb`, so every writer words its warnings the same way.
 *
 * CockroachDB speaks the PostgreSQL wire protocol and most of its SQL, so the ORM writers keep their
 * PostgreSQL column types. What differs is written as a warning that starts with `Provider
 * "cockroachdb":`, and the output is changed only where the PostgreSQL form would fail or misbehave
 * on CockroachDB (64-bit `SERIAL`, `hstore`, range types, most index methods).
 */

/** True when the provider is CockroachDB. */
export function isCockroach(provider: PrismaProvider): boolean {
  return provider === 'cockroachdb';
}

/** The start of every CockroachDB warning. */
export const COCKROACH_PREFIX: string = 'Provider "cockroachdb":';

/** What to tell people who write sequential keys. */
export const COCKROACH_KEY_ADVICE: string =
  'sequential keys send every insert to the same range (a hot spot); CockroachDB recommends UUID keys with gen_random_uuid()';

/**
 * One warning for a set of auto-increment columns. `how` says what was written instead of PostgreSQL's
 * `SERIAL` (for CockroachDB, `SERIAL` is `unique_rowid()`: 64-bit, unordered and not consecutive).
 */
export function cockroachSequentialWarning(
  labels: readonly string[],
  how: string
): string {
  return `${COCKROACH_PREFIX} ${labels.join(', ')} ${
    labels.length === 1 ? 'is an auto-increment key' : 'are auto-increment keys'
  }: ${how}; ${COCKROACH_KEY_ADVICE}.`;
}

/** The index methods CockroachDB can build (B-tree, and inverted indexes through GIN). */
export const COCKROACH_INDEX_METHODS: readonly string[] = ['btree', 'gin'];

/** PostgreSQL types that CockroachDB rejects (checked against v26.3; `geometry`, `citext` and `ltree` exist). */
export const COCKROACH_MISSING_TYPES: readonly string[] = [
  'hstore',
  'money',
  'xml',
  'circle',
  'point',
  'box',
  'line',
  'lseg',
  'path',
  'polygon',
  'macaddr',
  'macaddr8',
  'cidr',
  'int4range',
  'int8range',
  'numrange',
  'tsrange',
  'tstzrange',
  'daterange',
  'int4multirange',
  'int8multirange',
  'nummultirange',
  'tsmultirange',
  'tstzmultirange',
  'datemultirange',
];

/** The PostgreSQL type name when the text names a type CockroachDB does not have. */
export function cockroachMissingType(typeText: string): string | undefined {
  const base: string = typeText
    .trim()
    .toLowerCase()
    .replace(/\(.*$/, '')
    .replace(/\[\]$/, '');
  return COCKROACH_MISSING_TYPES.includes(base) ? base : undefined;
}

/**
 * True when CockroachDB can build an inverted (GIN) index over the column: JSON, arrays and (through the
 * writers' fallback) hstore, plus the full-text and spatial types it keeps as written. A GIN index over
 * anything else is rejected there.
 */
export function cockroachInvertible(field: IrField | undefined): boolean {
  if (field === undefined) {
    return false;
  }
  if ((field.arrayDepth ?? 0) > 0) {
    return true;
  }
  if (field.type === 'json' || field.type === 'hstore') {
    return true;
  }
  const raw: string = (field.unsupportedType ?? '').toLowerCase();
  return /^(tsvector|geometry|geography)\b/.test(raw);
}
