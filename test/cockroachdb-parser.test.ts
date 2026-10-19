import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { convertText } from '../src/convert.js';
import { emitPrisma } from '../src/emitters/prisma.js';
import type { IrField, IrModel, IrSchema } from '../src/ir.js';
import { parsePrisma } from '../src/parsers/prisma.js';
import { parseSqlDdl } from '../src/parsers/sqlDdl.js';
import { parseTypeorm } from '../src/parsers/typeorm.js';
import { DEFAULT_OPTIONS, expectOk } from './helpers.js';

/**
 * The readers and CockroachDB. The SQL reader takes the output of `SHOW CREATE ALL TABLES` (captured from a
 * real CockroachDB v26.3.2, test/fixtures/cockroachdb/show-create-all-tables.sql), the Prisma reader a
 * `cockroachdb` datasource and the TypeORM reader the column types of its `cockroachdb` driver. Each is read
 * like its PostgreSQL equivalent.
 */

const DUMP_PATH: string = fileURLToPath(
  new URL('./fixtures/cockroachdb/show-create-all-tables.sql', import.meta.url)
);

function dump(): string {
  return readFileSync(DUMP_PATH, 'utf8');
}

function model(schema: IrSchema, name: string): IrModel {
  const found: IrModel | undefined = schema.models.find(
    (candidate: IrModel) => candidate.name === name
  );
  if (found === undefined) {
    throw new Error(
      `no model ${name}; models: ${schema.models.map((m) => m.name).join(', ')}`
    );
  }
  return found;
}

function field(schema: IrSchema, modelName: string, name: string): IrField {
  const found: IrField | undefined = model(schema, modelName).fields.find(
    (candidate: IrField) => candidate.name === name
  );
  if (found === undefined) {
    throw new Error(`no field ${modelName}.${name}`);
  }
  return found;
}

describe('SQL reader: SHOW CREATE ALL TABLES output from CockroachDB', () => {
  const schema: IrSchema = expectOk(
    parseSqlDdl([{ path: 'show-create.sql', text: dump() }], {
      appLabel: 'shop',
    })
  );

  it('reads the tables, the enum and the foreign keys', () => {
    expect(schema.models.map((m: IrModel) => m.tableName).sort()).toEqual([
      'accounts',
      'events',
      'order_lines',
      'orders',
    ]);
    expect(schema.enums.map((e) => e.dbName ?? e.name)).toContain('status');
    const orders: IrModel = model(schema, 'Order');
    expect(orders.relations).toHaveLength(1);
    expect(orders.relations[0]).toMatchObject({
      targetModel: 'Account',
      onDelete: 'cascade',
      onUpdate: 'cascade',
    });
    expect(model(schema, 'OrderLine').compositePrimaryKey).toBeDefined();
  });

  it('reads unique_rowid() and nextval() as auto-increment keys', () => {
    expect(field(schema, 'Account', 'id')).toMatchObject({
      type: 'bigInt',
      isPrimaryKey: true,
      default: { kind: 'autoIncrement' },
    });
    expect(field(schema, 'Order', 'id')).toMatchObject({
      type: 'int',
      isPrimaryKey: true,
      default: { kind: 'autoIncrement' },
    });
  });

  it('reads CockroachDB type names', () => {
    expect(field(schema, 'Account', 'email').type).toBe('text');
    expect(field(schema, 'Account', 'display_name')).toMatchObject({
      type: 'string',
      maxLength: 60,
    });
    expect(field(schema, 'Account', 'age').type).toBe('int');
    expect(field(schema, 'Account', 'level').type).toBe('int');
    expect(field(schema, 'Account', 'score').type).toBe('float');
    expect(field(schema, 'Account', 'avatar').type).toBe('bytes');
    expect(field(schema, 'Account', 'active').type).toBe('boolean');
    expect(field(schema, 'Account', 'tags')).toMatchObject({
      type: 'text',
      arrayDepth: 1,
    });
    expect(field(schema, 'Account', 'ip').type).toBe('ipAddress');
    expect(field(schema, 'Account', 'balance')).toMatchObject({
      type: 'decimal',
      maxDigits: 12,
      decimalPlaces: 2,
    });
    expect(field(schema, 'Account', 'state').enumName).toBe('Status');
  });

  it('reads defaults written with the ::: cast', () => {
    expect(field(schema, 'Account', 'level').default).toEqual({
      kind: 'literal',
      value: 1,
    });
    expect(field(schema, 'Account', 'balance').default).toEqual({
      kind: 'literal',
      value: 0,
    });
    expect(field(schema, 'Account', 'created_at').default).toEqual({
      kind: 'now',
    });
    expect(field(schema, 'Account', 'uid').default).toEqual({ kind: 'uuid' });
    expect(field(schema, 'Order', 'note').default).toEqual({
      kind: 'literal',
      value: 'none',
    });
    expect(field(schema, 'Event', 'payload').default).toEqual({
      kind: 'literal',
      value: '{}',
    });
    expect(field(schema, 'Event', 'at').default).toEqual({ kind: 'now' });
    expect(field(schema, 'Account', 'state').default).toEqual({
      kind: 'enumValue',
      value: 'DRAFT',
    });
  });

  it('reads the inline INDEX, UNIQUE INDEX and INVERTED INDEX lines', () => {
    const accounts: IrModel = model(schema, 'Account');
    expect(
      accounts.indexes.map((index) => [index.name, index.fields, index.method])
    ).toEqual([
      ['accounts_age_idx', ['age'], undefined],
      ['accounts_prefs_idx', ['prefs'], 'Gin'],
      ['accounts_created_idx', ['created_at'], undefined],
    ]);
    expect(accounts.indexes[0]?.fieldOptions?.['age']).toMatchObject({
      sort: 'desc',
    });
    expect(field(schema, 'Account', 'email').isUnique).toBe(true);
    expect(
      model(schema, 'Order').indexes.some(
        (index) => index.isUnique && index.fields.join() === 'account,placed'
      )
    ).toBe(true);
  });

  it('skips the hidden shard column of a hash-sharded index, with a warning', () => {
    expect(
      model(schema, 'OrderLine').fields.some((f: IrField) =>
        f.name.startsWith('crdb_internal')
      )
    ).toBe(false);
    expect(schema.warnings.join('\n')).toContain(
      'the hidden shard column "crdb_internal_sku_shard_4" of a hash-sharded index was skipped; the index is read as an ordinary index.'
    );
    expect(model(schema, 'OrderLine').indexes.map((i) => i.name)).toContain(
      'order_lines_sku_idx'
    );
  });

  it('converts to Prisma for a cockroachdb datasource without Unsupported columns', async () => {
    const result = expectOk(
      await convertText([{ path: DUMP_PATH, text: dump() }], {
        ...DEFAULT_OPTIONS,
        from: 'sql',
        to: 'prisma',
        provider: 'cockroachdb',
      })
    );
    expect(result.output).toContain('provider = "cockroachdb"');
    expect(result.output).not.toContain('Unsupported(');
    expect(result.output).toMatch(
      /id\s+Int\s+@id\(map: "orders_pkey"\) @default\(sequence\(\)\)/
    );
  });
});

describe('Prisma reader: cockroachdb datasource', () => {
  const text: string = [
    'datasource db {',
    '  provider = "cockroachdb"',
    '  url      = env("DATABASE_URL")',
    '}',
    '',
    'model Ticket {',
    '  id    Int    @id @default(sequence())',
    '  seq   BigInt @unique @default(autoincrement())',
    '  limit Int    @default(sequence(maxValue: 100))',
    '  name  String @db.String(40)',
    '  small Int    @db.Int2',
    '  tag   Bytes  @db.Bytes',
    '}',
    '',
  ].join('\n');

  it('reads sequence() as an auto-increment key, like autoincrement()', () => {
    const schema: IrSchema = expectOk(
      parsePrisma([{ path: 'schema.prisma', text }], { appLabel: 'app' })
    );
    expect(field(schema, 'Ticket', 'id').default).toEqual({
      kind: 'autoIncrement',
    });
    expect(field(schema, 'Ticket', 'seq').default).toEqual({
      kind: 'autoIncrement',
    });
    // Only the plain sequence() is an auto-increment; one with options is kept as written.
    expect(field(schema, 'Ticket', 'limit').default).toMatchObject({
      kind: 'dbExpression',
      expression: 'sequence(maxValue: 100)',
    });
    expect(field(schema, 'Ticket', 'name')).toMatchObject({
      type: 'string',
      maxLength: 40,
    });
    expect(field(schema, 'Ticket', 'tag').type).toBe('bytes');
  });

  it('keeps sequence() as a database function on other providers', () => {
    const schema: IrSchema = expectOk(
      parsePrisma(
        [
          {
            path: 'schema.prisma',
            text: text.replace('"cockroachdb"', '"postgresql"'),
          },
        ],
        { appLabel: 'app' }
      )
    );
    expect(field(schema, 'Ticket', 'id').default).toMatchObject({
      kind: 'dbExpression',
      isFunction: true,
    });
  });

  it('writes the key back as sequence() for an Int and autoincrement() for a BigInt', () => {
    const schema: IrSchema = expectOk(
      parsePrisma([{ path: 'schema.prisma', text }], { appLabel: 'app' })
    );
    const output = emitPrisma(schema, {
      provider: 'cockroachdb',
      header: false,
      camelFields: false,
    });
    expect(output.text).toMatch(/id\s+Int\s+@id @default\(sequence\(\)\)/);
    expect(output.text).toMatch(
      /seq\s+BigInt\s+@default\(autoincrement\(\)\) @unique/
    );
  });

  it('drops a Gin index over a column CockroachDB cannot invert', () => {
    const source: string = [
      'datasource db {',
      '  provider = "postgresql"',
      '  url      = env("DATABASE_URL")',
      '}',
      '',
      'model Doc {',
      '  id    Int  @id',
      '  count Int',
      '  meta  Json',
      '  tags  String[]',
      '',
      '  @@index([count], type: Gin)',
      '  @@index([meta], type: Gin)',
      '  @@index([tags], type: Gin)',
      '}',
      '',
    ].join('\n');
    const schema: IrSchema = expectOk(
      parsePrisma([{ path: 'schema.prisma', text: source }], {
        appLabel: 'app',
      })
    );
    const output = emitPrisma(schema, {
      provider: 'cockroachdb',
      header: false,
      camelFields: false,
    });
    expect(output.text).toContain('@@index([meta], type: Gin)');
    expect(output.text).toContain('@@index([tags], type: Gin)');
    expect(output.text).toContain('@@index([count])');
    expect(output.warnings.join('\n')).toContain(
      'Doc index (count): CockroachDB builds an inverted (Gin) index only over Json, list or spatial columns, so the index type Gin was dropped.'
    );
  });
});

describe('TypeORM reader: the cockroachdb driver column types', () => {
  it('reads int4, int8, int64 and bytes', async () => {
    const source: string = [
      "import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';",
      '',
      "@Entity('blobs')",
      'export class Blob {',
      "  @PrimaryGeneratedColumn('rowid')",
      '  id!: number;',
      '',
      "  @Column({ type: 'int4' })",
      '  small!: number;',
      '',
      "  @Column({ type: 'int8' })",
      '  big!: string;',
      '',
      "  @Column({ type: 'int64' })",
      '  wide!: string;',
      '',
      "  @Column({ type: 'bytes' })",
      '  data!: Buffer;',
      '}',
      '',
    ].join('\n');
    const schema: IrSchema = expectOk(
      await parseTypeorm([{ path: 'blob.ts', text: source }], {
        appLabel: 'app',
      })
    );
    expect(field(schema, 'Blob', 'small').type).toBe('int');
    expect(field(schema, 'Blob', 'big').type).toBe('bigInt');
    expect(field(schema, 'Blob', 'wide').type).toBe('bigInt');
    expect(field(schema, 'Blob', 'data').type).toBe('bytes');
    expect(field(schema, 'Blob', 'id').default).toEqual({
      kind: 'autoIncrement',
    });
  });
});
