import type { IrSchema } from '../src/ir.js';
import {
  field,
  idField,
  kitchenSinkSchema,
  model,
  schemaOf,
  stressSchema,
} from './gormFixtures.js';
import {
  SOURCES_WITHOUT_VIEWS,
  parseSource,
  type VerifySource,
} from './realToolSupport.js';

/**
 * The schemas the Sequelize 7 writer is verified with against PostgreSQL and MySQL
 * (`sequelize7-server-verify.test.ts`) and against the SQL Server dialect (`sequelize7-mssql-verify.test.ts`).
 */

/** One schema to write: its name and how to build the IR. */
export interface Subject {
  label: string;
  build: () => Promise<IrSchema>;
}

/**
 * The two types the SQLite dialect of Sequelize 7 lacks: a 64-bit key and column, and exact decimals (with and
 * without a default), which PostgreSQL and MySQL have to create as `BIGINT` and `DECIMAL(p,s)`.
 */
export function numbersSchema(): IrSchema {
  return schemaOf([
    model('Ledger', {
      tableName: 'ledger',
      fields: [
        idField({ type: 'bigInt' }),
        field('views', { type: 'bigInt', isNullable: true }),
        field('balance', {
          type: 'decimal',
          maxDigits: 12,
          decimalPlaces: 2,
          default: { kind: 'literal', value: 0 },
        }),
        field('rate', {
          type: 'decimal',
          maxDigits: 5,
          decimalPlaces: 4,
          isNullable: true,
        }),
        field('whole', { type: 'decimal', maxDigits: 20, decimalPlaces: 0 }),
      ],
    }),
  ]);
}

export const SUBJECTS: readonly Subject[] = [
  ...SOURCES_WITHOUT_VIEWS.map((source: VerifySource): Subject => ({
    label: source.label,
    build: () => parseSource(source),
  })),
  { label: 'kitchen-sink', build: () => Promise.resolve(kitchenSinkSchema()) },
  { label: 'stress', build: () => Promise.resolve(stressSchema()) },
  { label: 'bigint-decimal', build: () => Promise.resolve(numbersSchema()) },
];
