import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { convertText, type ConvertResult } from '../src/convert.js';
import {
  emitPrisma,
  type EmitOutput,
  type PrismaProvider,
  type PrismaVersion,
} from '../src/emitters/prisma.js';
import type {
  IrCompositeForeignKey,
  IrField,
  IrIndex,
  IrModel,
  IrSchema,
} from '../src/ir.js';
import { parsePrisma } from '../src/parsers/prisma.js';
import type { Result } from '../src/result.js';
import { DEFAULT_OPTIONS, expectOk } from './helpers.js';

const FIXTURE_PATH: string = fileURLToPath(
  new URL('./fixtures/prisma-extras/schema.prisma', import.meta.url)
);
const GOLDEN_DIRECTORY: string = fileURLToPath(
  new URL('./golden-extras/', import.meta.url)
);

/** Compares text with test/golden-extras/<name>; run with UPDATE_GOLDEN=1 to rewrite it. */
function expectMatchesExtrasGolden(name: string, actual: string): void {
  const goldenPath: string = `${GOLDEN_DIRECTORY}${name}`;
  if (process.env.UPDATE_GOLDEN === '1') {
    mkdirSync(dirname(goldenPath), { recursive: true });
    writeFileSync(goldenPath, actual);
    return;
  }
  if (!existsSync(goldenPath)) {
    throw new Error(
      `Golden file test/golden-extras/${name} does not exist. Run the tests with UPDATE_GOLDEN=1 to create it.`
    );
  }
  expect(actual).toBe(readFileSync(goldenPath, 'utf8'));
}

function fixtureText(): string {
  return readFileSync(FIXTURE_PATH, 'utf8');
}

function parse(text: string): IrSchema {
  return expectOk(
    parsePrisma([{ path: 'schema.prisma', text }], { appLabel: 'app' })
  );
}

function emit(
  schema: IrSchema,
  provider: PrismaProvider = 'postgresql',
  prismaVersion?: PrismaVersion
): EmitOutput {
  return emitPrisma(schema, {
    provider,
    header: true,
    camelFields: false,
    ...(prismaVersion === undefined ? {} : { prismaVersion }),
  });
}

/** Output text followed by the warnings, so goldens show both. */
function withWarnings(result: EmitOutput): string {
  const warnings: string = result.warnings
    .map((warning: string) => `// ${warning}`)
    .join('\n');
  return `${result.text}\n// --- warnings ---\n${warnings}\n`;
}

function modelOf(schema: IrSchema, name: string): IrModel {
  const model: IrModel | undefined = schema.models.find(
    (candidate: IrModel) => candidate.name === name
  );
  if (model === undefined) {
    throw new Error(`Model ${name} was not parsed.`);
  }
  return model;
}

function fieldOf(schema: IrSchema, modelName: string, name: string): IrField {
  const field: IrField | undefined = modelOf(schema, modelName).fields.find(
    (candidate: IrField) => candidate.name === name
  );
  if (field === undefined) {
    throw new Error(`Field ${modelName}.${name} was not parsed.`);
  }
  return field;
}

/** Wraps a model body in a datasource for the given provider. */
function snippet(provider: string, body: string): string {
  return `datasource db {\n  provider = "${provider}"\n  url = env("DATABASE_URL")\n}\n\n${body}\n`;
}

async function convertExtras(to: string): Promise<ConvertResult> {
  const result: Result<ConvertResult> = await convertText(
    [{ path: FIXTURE_PATH, text: fixtureText() }],
    { ...DEFAULT_OPTIONS, appLabel: 'shop', from: 'prisma', to }
  );
  return expectOk(result);
}

describe('Prisma parser: keys and relations', () => {
  it('reads composite foreign keys, with referential actions and constraint names', () => {
    const schema: IrSchema = parse(fixtureText());
    const line: IrModel = modelOf(schema, 'OrderLine');
    expect(line.relations).toEqual([]);
    const key: IrCompositeForeignKey | undefined =
      line.compositeForeignKeys?.[0];
    expect(key).toMatchObject({
      name: 'order',
      targetModel: 'Order',
      fields: ['orderRegion', 'orderNumber'],
      references: ['region', 'number'],
      kind: 'foreignKey',
      isNullable: false,
      onDelete: 'cascade',
      onUpdate: 'restrict',
      constraintName: 'fk_line_order',
      relatedName: 'lines',
    });
    // The local columns stay ordinary fields.
    expect(fieldOf(schema, 'OrderLine', 'orderRegion').type).toBe('string');
  });

  it('marks a composite foreign key as one-to-one when it matches a unique constraint', () => {
    const schema: IrSchema = parse(
      snippet(
        'postgresql',
        [
          'model A {',
          '  x Int',
          '  y Int',
          '  b B?',
          '  @@id([x, y])',
          '}',
          'model B {',
          '  id Int @id',
          '  ax Int',
          '  ay Int',
          '  a A @relation(fields: [ax, ay], references: [x, y])',
          '  @@unique([ax, ay])',
          '}',
        ].join('\n')
      )
    );
    expect(modelOf(schema, 'B').compositeForeignKeys?.[0]?.kind).toBe(
      'oneToOne'
    );
  });

  it('skips a composite foreign key whose fields do not pair up, naming model and field', () => {
    const schema: IrSchema = parse(
      snippet(
        'postgresql',
        [
          'model A {',
          '  x Int',
          '  y Int',
          '  @@id([x, y])',
          '}',
          'model B {',
          '  id Int @id',
          '  ax Int',
          '  ay Int',
          '  a A @relation(fields: [ax, ay], references: [x])',
          '}',
        ].join('\n')
      )
    );
    expect(modelOf(schema, 'B').compositeForeignKeys).toBeUndefined();
    expect(schema.warnings.join('\n')).toContain(
      'B.a: the composite foreign key'
    );
  });

  it('keeps @id and @@id constraint names, @unique(map:) and single-column referential actions', () => {
    const schema: IrSchema = parse(fixtureText());
    expect(modelOf(schema, 'Order')).toMatchObject({
      compositePrimaryKey: ['region', 'number'],
      primaryKeyName: 'order_pkey',
    });
    expect(modelOf(schema, 'Account').primaryKeyName).toBe('account_pk');
    expect(fieldOf(schema, 'Account', 'email').uniqueName).toBe(
      'uq_account_email'
    );
    expect(modelOf(schema, 'Account').relations[0]).toMatchObject({
      name: 'tenant',
      onDelete: 'noAction',
      onUpdate: 'cascade',
      constraintName: 'fk_account_tenant',
    });
  });

  it('treats a relation to a model with a composite id through its referenced field', () => {
    const schema: IrSchema = parse(
      snippet(
        'postgresql',
        [
          'model A {',
          '  code String @unique',
          '  n Int',
          '  m Int',
          '  bs B[]',
          '  @@id([n, m])',
          '}',
          'model B {',
          '  id Int @id',
          '  aCode String',
          '  a A @relation(fields: [aCode], references: [code])',
          '}',
        ].join('\n')
      )
    );
    expect(modelOf(schema, 'B').relations[0]?.toField).toBe('code');
  });
});

describe('Prisma parser: indexes', () => {
  it('reads @@fulltext, index types, sort, length, ops and map names', () => {
    const schema: IrSchema = parse(fixtureText());
    const indexes: IrIndex[] = modelOf(schema, 'Document').indexes;
    expect(indexes[0]).toEqual({
      fields: ['title', 'created'],
      isUnique: false,
      name: 'ix_document_title',
      method: 'BTree',
      fieldOptions: { title: { sort: 'desc' } },
    });
    expect(indexes[1]).toMatchObject({
      fields: ['meta'],
      method: 'Gin',
      fieldOptions: { meta: { ops: 'JsonbPathOps' } },
    });
    expect(indexes[2]).toMatchObject({
      fields: ['title', 'day'],
      isUnique: true,
      name: 'uq_document_title_day',
    });

    const mysql: IrSchema = parse(
      snippet(
        'mysql',
        [
          'model P {',
          '  id Int @id',
          '  title String @db.VarChar(200)',
          '  body String @db.Text',
          '  @@fulltext([title, body], map: "ft_p")',
          '  @@index([title(length: 20, sort: Desc)])',
          '}',
        ].join('\n')
      )
    );
    expect(modelOf(mysql, 'P').indexes[0]).toEqual({
      fields: ['title', 'body'],
      isUnique: false,
      name: 'ft_p',
      kind: 'fulltext',
    });
    expect(modelOf(mysql, 'P').indexes[1]?.fieldOptions).toEqual({
      title: { length: 20, sort: 'desc' },
    });
  });

  it('warns about index options it cannot keep', () => {
    const schema: IrSchema = parse(
      snippet(
        'sqlserver',
        [
          'model P {',
          '  id Int @id',
          '  a String',
          '  @@unique([a], name: "custom_key", map: "uq_a")',
          '  @@index([a(foo: 1)], where: raw("a > 1"))',
          '}',
        ].join('\n')
      )
    );
    const text: string = schema.warnings.join('\n');
    expect(text).toContain('P @@unique: the client-side key name');
    expect(text).toContain('the option "foo: 1" on index entry "a"');
    expect(text).toContain('the partial index condition');
  });
});

describe('Prisma parser: views, schemas and ignore', () => {
  it('reads view blocks as models flagged isView', () => {
    const schema: IrSchema = parse(fixtureText());
    const view: IrModel = modelOf(schema, 'DocumentSummary');
    expect(view.isView).toBe(true);
    expect(view.schema).toBe('audit');
    expect(fieldOf(schema, 'DocumentSummary', 'id').isUnique).toBe(true);
    expect(modelOf(schema, 'Order').isView).toBeUndefined();
  });

  it('reads @@schema, @@map and @@ignore on models and enums', () => {
    const schema: IrSchema = parse(fixtureText());
    expect(modelOf(schema, 'Document')).toMatchObject({
      tableName: 'documents',
      schema: 'audit',
    });
    expect(modelOf(schema, 'Scratch').isIgnored).toBe(true);
    expect(schema.enums[0]).toMatchObject({
      name: 'Role',
      dbName: 'role_t',
      schema: 'public',
    });
    expect(fieldOf(schema, 'Document', 'internal').isIgnored).toBe(true);
    expect(fieldOf(schema, 'Document', 'legacy').columnName).toBe(
      'legacy_name'
    );
  });
});

describe('Prisma parser: field types and defaults', () => {
  it('keeps native types, including ones the IR has no scalar for', () => {
    const schema: IrSchema = parse(fixtureText());
    expect(fieldOf(schema, 'Document', 'small')).toMatchObject({
      type: 'int',
      nativeType: { name: 'SmallInt', args: [] },
    });
    expect(fieldOf(schema, 'Document', 'ratio').nativeType?.name).toBe('Real');
    expect(fieldOf(schema, 'Document', 'meta').nativeType?.name).toBe('JsonB');
    expect(fieldOf(schema, 'Document', 'ip').type).toBe('ipAddress');
    expect(fieldOf(schema, 'Document', 'day').type).toBe('date');
    expect(fieldOf(schema, 'Document', 'at').type).toBe('time');
    expect(fieldOf(schema, 'Document', 'created').nativeType).toEqual({
      name: 'Timestamptz',
      args: ['3'],
    });
    expect(fieldOf(schema, 'Document', 'price')).toMatchObject({
      type: 'decimal',
      maxDigits: 10,
      decimalPlaces: 2,
    });
  });

  it('does not invent a precision for money types', () => {
    const money: IrField = fieldOf(parse(fixtureText()), 'Document', 'cost');
    expect(money.type).toBe('decimal');
    expect(money.maxDigits).toBeUndefined();
    expect(money.nativeType?.name).toBe('Money');
  });

  it('uses the SQL Server default decimal precision when the datasource says so', () => {
    const schema: IrSchema = parse(
      snippet('sqlserver', 'model A {\n  id Int @id\n  d Decimal\n}')
    );
    expect(fieldOf(schema, 'A', 'd')).toMatchObject({
      maxDigits: 32,
      decimalPlaces: 16,
    });
  });

  it('carries Unsupported(...) as an opaque column and recognizes range types', () => {
    const schema: IrSchema = parse(fixtureText());
    expect(fieldOf(schema, 'Document', 'area')).toMatchObject({
      type: 'unsupported',
      unsupportedType: 'circle',
      isNullable: true,
    });
    expect(fieldOf(schema, 'Document', 'place')).toMatchObject({
      type: 'unsupported',
      unsupportedType: 'geometry(Point, 4326)',
      isNullable: false,
      default: {
        kind: 'dbExpression',
        expression: "'POINT(0 0)'::geometry",
      },
    });
    expect(fieldOf(schema, 'Document', 'window')).toMatchObject({
      type: 'range',
      rangeOf: 'int',
      isNullable: true,
    });
  });

  it('reads scalar lists as arrays instead of Json', () => {
    const schema: IrSchema = parse(fixtureText());
    expect(fieldOf(schema, 'Document', 'tags')).toMatchObject({
      type: 'string',
      arrayDepth: 1,
    });
    expect(fieldOf(schema, 'Document', 'scores')).toMatchObject({
      type: 'int',
      arrayDepth: 1,
      default: { kind: 'literal', value: '[]' },
    });
    expect(schema.warnings).toEqual([]);
  });

  it('reads cuid(), ulid(), nanoid(), uuid(7) and dbgenerated() defaults', () => {
    const schema: IrSchema = parse(fixtureText());
    expect(fieldOf(schema, 'Document', 'id').default).toEqual({
      kind: 'clientGenerated',
      generator: 'cuid',
    });
    expect(fieldOf(schema, 'Document', 'ulid').default).toEqual({
      kind: 'clientGenerated',
      generator: 'ulid',
    });
    expect(fieldOf(schema, 'Document', 'short').default).toEqual({
      kind: 'clientGenerated',
      generator: 'nanoid',
      args: '12',
    });
    expect(fieldOf(schema, 'Document', 'uid').default).toEqual({
      kind: 'uuid',
      version: 7,
    });
    expect(fieldOf(schema, 'Document', 'token').default).toEqual({
      kind: 'dbExpression',
      expression: 'gen_random_uuid()',
    });
    expect(fieldOf(schema, 'Document', 'updated').isAutoUpdated).toBe(true);
  });

  it('keeps auto() and sequence() defaults as function expressions', () => {
    const schema: IrSchema = parse(
      snippet(
        'mongodb',
        [
          'model A {',
          '  id String @id @default(auto()) @map("_id") @db.ObjectId',
          '}',
        ].join('\n')
      )
    );
    expect(fieldOf(schema, 'A', 'id')).toMatchObject({
      columnName: '_id',
      nativeType: { name: 'ObjectId', args: [] },
      default: { kind: 'dbExpression', expression: 'auto()', isFunction: true },
    });
  });

  it('warns, naming model and field, for a dbgenerated() default without an expression', () => {
    const schema: IrSchema = parse(
      snippet(
        'postgresql',
        'model A {\n  id Int @id\n  c Unsupported("circle")? @default(dbgenerated())\n}'
      )
    );
    expect(fieldOf(schema, 'A', 'c').default).toBeUndefined();
    expect(schema.warnings.join('\n')).toContain(
      'A.c: @default(dbgenerated())'
    );
  });
});

describe('Prisma emitter: native types per provider', () => {
  const body: string = [
    'model T {',
    '  id Int @id',
    '  a String @db.VarChar(20)',
    '  b Int @db.SmallInt',
    '  c DateTime @db.Timestamp(3)',
    '  d Decimal @db.Money',
    '  e Json @db.JsonB',
    '  f String @db.Uuid',
    '}',
  ].join('\n');

  it('writes the carried native types back on PostgreSQL', () => {
    const { text, warnings } = emit(parse(snippet('postgresql', body)));
    expect(text).toMatch(/b\s+Int\s+@db\.SmallInt/);
    expect(text).toMatch(/c\s+DateTime\s+@db\.Timestamp\(3\)/);
    expect(text).toMatch(/d\s+Decimal\s+@db\.Money/);
    expect(text).toMatch(/e\s+Json\s+@db\.JsonB/);
    expect(warnings).toEqual([]);
  });

  it('drops native types the target provider rejects and names the field', () => {
    const { text, warnings } = emit(
      parse(snippet('postgresql', body)),
      'mysql'
    );
    expect(text).toMatch(/b\s+Int\s+@db\.SmallInt/);
    expect(text).not.toContain('JsonB');
    expect(text).not.toContain('@db.Money');
    const joined: string = warnings.join('\n');
    expect(joined).toContain(
      'T.e: the native type @db.JsonB is not available for Json on mysql'
    );
    expect(joined).toContain('T.d: the native type @db.Money');
    expect(joined).toContain('T.f: the native type @db.Uuid');
  });

  it('has no native types on SQLite and warns for each carried one', () => {
    const { text, warnings } = emit(
      parse(snippet('postgresql', body)),
      'sqlite'
    );
    expect(text).not.toContain('@db.');
    expect(warnings.join('\n')).toContain(
      'T.b: SQLite has no native column types'
    );
  });

  it('uses CockroachDB type names instead of PostgreSQL ones', () => {
    const { text } = emit(
      parse(
        snippet(
          'postgresql',
          'model T {\n  id Int @id\n  a String @db.VarChar(20)\n  b String @db.Text\n}'
        )
      ),
      'cockroachdb'
    );
    expect(text).toMatch(/a\s+String\s+@db\.String\(20\)/);
    expect(text).not.toContain('@db.VarChar');
    expect(text).not.toContain('@db.Text');
  });

  it('gives Django-style fields CockroachDB, SQL Server and MongoDB mappings that validate', () => {
    const schema: IrSchema = parse(
      snippet(
        'postgresql',
        [
          'model T {',
          '  id Int @id @default(autoincrement())',
          '  name String @db.VarChar(40)',
          '  note String @db.Text',
          '  uid String @db.Uuid',
          '  day DateTime @db.Date',
          '  doc Json',
          '}',
        ].join('\n')
      )
    );
    const cockroach: EmitOutput = emit(schema, 'cockroachdb');
    expect(cockroach.text).toContain('@default(sequence())');
    expect(cockroach.warnings.join('\n')).toContain(
      'T.id: CockroachDB allows autoincrement()'
    );
    const sqlserver: EmitOutput = emit(schema, 'sqlserver');
    expect(sqlserver.text).toMatch(/name\s+String\s+@db\.VarChar\(40\)/);
    expect(sqlserver.text).toMatch(/uid\s+String\s+@db\.UniqueIdentifier/);
    expect(sqlserver.text).toMatch(/doc\s+String\s+@db\.NVarChar\(Max\)/);
    expect(sqlserver.warnings.join('\n')).toContain(
      'T.doc: SQL Server has no Json type'
    );
    const mongo: EmitOutput = emit(schema, 'mongodb');
    expect(mongo.warnings.join('\n')).toContain(
      'T: MongoDB needs a single id field mapped to _id'
    );
    expect(mongo.warnings.join('\n')).toContain(
      'T.id: MongoDB does not support autoincrement()'
    );
  });
});

describe('Prisma emitter: provider limits', () => {
  const schema: IrSchema = parse(
    snippet(
      'postgresql',
      [
        'enum Kind {',
        '  A',
        '  B',
        '}',
        'model P {',
        '  id Int @id(map: "pk_p")',
        '  cs C[]',
        '}',
        'model C {',
        '  id Int @id',
        '  kind Kind @default(B)',
        '  pid Int',
        '  p P @relation(fields: [pid], references: [id], onDelete: Restrict, map: "fk_c_p")',
        '}',
      ].join('\n')
    )
  );

  it('rewrites Restrict, drops enums and constraint names on SQL Server', () => {
    const { text, warnings } = emit(schema, 'sqlserver');
    expect(text).not.toContain('enum Kind');
    expect(text).toMatch(/kind\s+String\s+@default\("B"\)/);
    expect(text).toContain('onDelete: NoAction');
    expect(text).toContain('map: "fk_c_p"');
    const joined: string = warnings.join('\n');
    expect(joined).toContain('enum Kind: sqlserver has no enum support');
    expect(joined).toContain(
      'C.p: SQL Server has no Restrict referential action'
    );
  });

  it('drops primary-key and foreign-key names where the provider rejects them', () => {
    const mysql: EmitOutput = emit(schema, 'mysql');
    expect(mysql.text).not.toContain('pk_p');
    expect(mysql.text).toContain('map: "fk_c_p"');
    expect(mysql.warnings.join('\n')).toContain(
      'P: mysql does not support named primary keys'
    );
    const sqlite: EmitOutput = emit(schema, 'sqlite');
    expect(sqlite.text).not.toContain('fk_c_p');
    expect(sqlite.warnings.join('\n')).toContain(
      'C.p: sqlite does not support named foreign keys'
    );
  });

  it('writes @@fulltext on MySQL and falls back to a plain index elsewhere', () => {
    const fulltext: IrSchema = parse(
      snippet(
        'mysql',
        'model P {\n  id Int @id\n  t String @db.VarChar(100)\n  @@fulltext([t], map: "ft_t")\n  @@index([t(length: 10)])\n}'
      )
    );
    const mysql: EmitOutput = emit(fulltext, 'mysql');
    expect(mysql.text).toContain('@@fulltext([t], map: "ft_t")');
    expect(mysql.text).toContain('@@index([t(length: 10)])');
    expect(mysql.warnings).toEqual([]);
    const postgres: EmitOutput = emit(fulltext, 'postgresql');
    expect(postgres.text).toContain('@@index([t], map: "ft_t")');
    expect(postgres.text).not.toContain('@@fulltext');
    const joined: string = postgres.warnings.join('\n');
    expect(joined).toContain('P index (t): postgresql has no @@fulltext index');
    expect(joined).toContain(
      'the prefix length on "t" is only supported on MySQL'
    );
  });

  it('warns when an index covers a column the provider cannot index', () => {
    const indexed: IrSchema = parse(
      snippet(
        'postgresql',
        'model P {\n  id Int @id\n  t String @db.Text\n  @@index([t])\n}'
      )
    );
    expect(emit(indexed, 'mysql').warnings.join('\n')).toContain(
      '"t" is a TEXT column; MySQL needs a prefix length'
    );
  });

  it('only writes index types the provider accepts', () => {
    const typed: IrSchema = parse(
      snippet(
        'postgresql',
        'model P {\n  id Int @id\n  t String\n  @@index([t], type: Hash)\n}'
      )
    );
    expect(emit(typed, 'postgresql').text).toContain(
      '@@index([t], type: Hash)'
    );
    const cockroach: EmitOutput = emit(typed, 'cockroachdb');
    expect(cockroach.text).toContain('@@index([t])');
    expect(cockroach.warnings.join('\n')).toContain(
      'the index type Hash is not supported on cockroachdb'
    );
  });
});

describe('Prisma emitter: header', () => {
  it('writes the Prisma 6 header by default, with views and schemas switched on', () => {
    const { text } = emit(parse(fixtureText()));
    expect(text.startsWith('generator client {')).toBe(true);
    expect(text).toContain('provider        = "prisma-client-js"');
    expect(text).toContain('previewFeatures = ["views"]');
    expect(text).toContain('url      = env("DATABASE_URL")');
    expect(text).toContain('schemas  = ["public", "audit"]');
  });

  it('writes the Prisma 7 header: prisma-client generator with output, no datasource url', () => {
    const { text } = emit(parse(fixtureText()), 'postgresql', 7);
    expect(text).toContain('provider        = "prisma-client"');
    expect(text).toContain('output          = "../generated/prisma"');
    expect(text).not.toContain('url');
    expect(text).not.toContain('prisma-client-js');
  });

  it('accepts a Prisma version through convertText', async () => {
    const result: Result<ConvertResult> = await convertText(
      [
        {
          path: 'models.py',
          text: 'from django.db import models\n\n\nclass A(models.Model):\n    name = models.CharField(max_length=5)\n',
        },
      ],
      { ...DEFAULT_OPTIONS, appLabel: 'a', prismaVersion: 7 }
    );
    const { output } = expectOk(result);
    expect(output).toContain('provider = "prisma-client"');
    expect(output).not.toContain('env("DATABASE_URL")');
  });

  it('warns about views and schemas when the header is omitted', () => {
    const result: EmitOutput = emitPrisma(parse(fixtureText()), {
      provider: 'postgresql',
      header: false,
      camelFields: false,
    });
    const joined: string = result.warnings.join('\n');
    expect(joined).toContain('add previewFeatures = ["views"]');
    expect(joined).toContain('list them in the datasource block as schemas');
  });

  it('warns when multiple schemas are used on a provider without them', () => {
    const result: EmitOutput = emit(parse(fixtureText()), 'mysql');
    const joined: string = result.warnings.join('\n');
    expect(joined).toContain(
      'Provider "mysql" does not support multiple database schemas'
    );
    expect(joined).toContain('Document: mysql has no database schemas');
  });
});

describe('Prisma round trip', () => {
  it('writes the extras fixture back unchanged in meaning', () => {
    expectMatchesExtrasGolden(
      'prisma-roundtrip.txt',
      withWarnings(emit(parse(fixtureText())))
    );
  });

  it('is stable: reading the output and writing it again gives the same text', () => {
    const first: EmitOutput = emit(parse(fixtureText()));
    const second: EmitOutput = emit(parse(first.text));
    expect(second.text).toBe(first.text);
    expect(second.warnings).toEqual(first.warnings);
  });

  it('keeps the IR identical after a round trip', () => {
    const before: IrSchema = parse(fixtureText());
    const after: IrSchema = parse(emit(before).text);
    expect(after.models).toEqual(before.models);
    expect(after.enums).toEqual(before.enums);
  });
});

describe.each([
  ['mysql', 6, 'mysql'],
  ['sqlserver', 6, 'sqlserver'],
  ['cockroachdb', 6, 'cockroachdb'],
  ['postgresql', 7, 'v7'],
] as const)('Prisma extras on %s (Prisma %i)', (provider, version, name) => {
  it('matches the stored output', () => {
    expectMatchesExtrasGolden(
      `prisma-to-${name}.txt`,
      withWarnings(emit(parse(fixtureText()), provider, version))
    );
  });
});

describe.each([
  ['django', 'django.txt'],
  ['typeorm', 'typeorm.txt'],
  ['typescript', 'typescript.txt'],
  ['graphene', 'graphene.txt'],
  ['zod', 'zod.txt'],
])('Prisma extras -> %s', (target, goldenName) => {
  it('matches the stored output and warns about what it cannot carry', async () => {
    const { output, warnings } = await convertExtras(target);
    expectMatchesExtrasGolden(
      `prisma-to-${goldenName}`,
      `${output}\n# --- warnings ---\n${warnings.map((warning: string) => `# ${warning}`).join('\n')}\n`
    );
  });
});

describe('Prisma extras: degradation warnings', () => {
  it('names the model and field for every Prisma-only construct', async () => {
    const { warnings } = await convertExtras('django');
    const text: string = warnings.join('\n');
    expect(text).toContain(
      'OrderLine.order: the composite foreign key (orderRegion, orderNumber)'
    );
    expect(text).toContain('Document.area: the database type "circle"');
    expect(text).toContain('DocumentSummary: this is a database view');
    expect(text).toContain('Scratch: @@ignore has no equivalent here');
    expect(text).toContain('Document.internal: @ignore has no equivalent here');
    expect(text).toContain(
      'Document: the database schema "audit" (@@schema) was ignored'
    );
    expect(text).toContain(
      'Document.id: the cuid() default is generated by Prisma Client'
    );
    expect(text).toContain(
      'Document.token: the database default expression gen_random_uuid()'
    );
    expect(text).toContain(
      'index (title, created): the index type, clustering'
    );
    expect(text).toContain('Account.tenant: the onUpdate action "cascade"');
  });
});

/** `prisma validate` starts a CLI process, which is slow on a busy CI runner (vitest's default is 5 s). */
const PRISMA_VALIDATE_TIMEOUT_MS: number = 120_000;

/**
 * Real verification: set PRISMA_BIN to a prisma CLI (6.x or 7.x) and PRISMA_MAJOR to its major version
 * to run `prisma validate` on the emitted schemas. Skipped when it is not set.
 */
describe.skipIf(process.env.PRISMA_BIN === undefined)(
  'prisma validate on the emitted schemas',
  () => {
    const urls: Record<PrismaProvider, string> = {
      postgresql: 'postgresql://u:p@localhost:5432/d',
      cockroachdb: 'postgresql://u:p@localhost:26257/d',
      mysql: 'mysql://u:p@localhost:3306/d',
      sqlserver: 'sqlserver://localhost:1433;database=d;user=u;password=p',
      sqlite: 'file:./d.db',
      mongodb: 'mongodb://localhost:27017/d',
    };
    const major: PrismaVersion = process.env.PRISMA_MAJOR === '7' ? 7 : 6;

    it.each(['postgresql', 'cockroachdb', 'mysql', 'sqlite'] as const)(
      'accepts the %s output',
      (provider) => {
        const directory: string = mkdtempSync(join(tmpdir(), 'ormbridge-'));
        const path: string = join(directory, 'schema.prisma');
        writeFileSync(path, emit(parse(fixtureText()), provider, major).text);
        expect(() =>
          execFileSync(
            process.env.PRISMA_BIN ?? 'prisma',
            ['validate', '--schema', path],
            {
              env: {
                ...process.env,
                DATABASE_URL: urls[provider],
                NO_COLOR: '1',
              },
              stdio: 'pipe',
            }
          )
        ).not.toThrow();
      },
      PRISMA_VALIDATE_TIMEOUT_MS
    );
  }
);
