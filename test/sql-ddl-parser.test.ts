import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { convertText, type ConvertResult } from '../src/convert.js';
import { getFormat, getFormatByExtension } from '../src/formats.js';
import type {
  IrEnum,
  IrField,
  IrIndex,
  IrModel,
  IrRelation,
  IrSchema,
} from '../src/ir.js';
import { runConversion } from '../src/io.js';
import { parseSqlDdl } from '../src/parsers/sqlDdl.js';
import {
  detectDialect,
  splitStatements,
  tokenize,
  type SqlDialect,
  type Token,
} from '../src/parsers/sqlSyntax.js';
import type { Result } from '../src/result.js';
import { loadCanonicalSources } from './harness.js';
import { DEFAULT_OPTIONS, expectOk } from './helpers.js';

function parseResult(text: string, dialect?: SqlDialect): Result<IrSchema> {
  return parseSqlDdl([{ path: 'schema.sql', text }], {
    appLabel: 'app',
    ...(dialect === undefined ? {} : { dialect }),
  });
}

function parse(text: string, dialect?: SqlDialect): IrSchema {
  return expectOk(parseResult(text, dialect));
}

function model(schema: IrSchema, name: string): IrModel {
  const found: IrModel | undefined = schema.models.find(
    (candidate: IrModel) => candidate.name === name
  );
  if (found === undefined) {
    throw new Error(
      `No model ${name}; have ${schema.models.map((item) => item.name).join(', ')}.`
    );
  }
  return found;
}

function field(schema: IrSchema, modelName: string, name: string): IrField {
  const found: IrField | undefined = model(schema, modelName).fields.find(
    (candidate: IrField) => candidate.name === name
  );
  if (found === undefined) {
    throw new Error(
      `No field ${modelName}.${name}; have ${model(schema, modelName)
        .fields.map((item) => item.name)
        .join(', ')}.`
    );
  }
  return found;
}

function relation(
  schema: IrSchema,
  modelName: string,
  name: string
): IrRelation {
  const found: IrRelation | undefined = model(schema, modelName).relations.find(
    (candidate: IrRelation) => candidate.name === name
  );
  if (found === undefined) {
    throw new Error(
      `No relation ${modelName}.${name}; have ${model(schema, modelName)
        .relations.map((item) => item.name)
        .join(', ')}.`
    );
  }
  return found;
}

function enumNamed(schema: IrSchema, name: string): IrEnum {
  const found: IrEnum | undefined = schema.enums.find(
    (candidate: IrEnum) => candidate.name === name
  );
  if (found === undefined) {
    throw new Error(`No enum ${name}.`);
  }
  return found;
}

/** The type of the only non-key column of `create table t (id int primary key, c <ddl>)`. */
function columnOf(
  ddl: string,
  dialect: SqlDialect = 'postgresql'
): { schema: IrSchema; field: IrField } {
  const schema: IrSchema = parse(
    `CREATE TABLE t (id int PRIMARY KEY, c ${ddl});`,
    dialect
  );
  return { schema, field: field(schema, 'T', 'c') };
}

const FIXTURES: string = fileURLToPath(
  new URL('./fixtures/sql/', import.meta.url)
);
const EXTRAS: string = fileURLToPath(
  new URL('./fixtures/sql-extras/', import.meta.url)
);

function readFixture(directory: string, name: string) {
  const path: string = join(directory, name);
  return { path, text: readFileSync(path, 'utf8') };
}

describe('registration', () => {
  it('registers a readable sql format that claims .sql', () => {
    const adapter = expectOk(getFormat('sql'));
    expect(adapter.parse).toBeDefined();
    expect(adapter.extensions).toEqual(['.sql']);
    expect(getFormatByExtension('.sql')?.name).toBe('sql');
  });

  it('converts through convertText', async () => {
    const result: ConvertResult = expectOk(
      await convertText(loadCanonicalSources('sql'), {
        ...DEFAULT_OPTIONS,
        from: 'sql',
        to: 'typescript',
      })
    );
    expect(result.modelCount).toBe(5);
    expect(result.output).toContain('interface BlogPost');
  });
});

describe('tokenizer', () => {
  const words = (text: string, dialect: SqlDialect = 'postgresql'): string[] =>
    tokenize(text, dialect).tokens.map((token: Token) => token.value);

  it('drops comments, including nested block comments in PostgreSQL', () => {
    expect(words('a -- x\n b /* y */ c /* o /* i */ o */ d')).toEqual([
      'a',
      'b',
      'c',
      'd',
    ]);
    // MySQL block comments do not nest and # starts a line comment.
    expect(words('a /* x /* y */ b # z\n c', 'mysql')).toEqual(['a', 'b', 'c']);
  });

  it('reads quoted identifiers and strings by dialect', () => {
    const postgres: Token[] = tokenize(
      `"a""b" 'it''s' [x]`,
      'postgresql'
    ).tokens;
    expect(postgres.map((token: Token) => token.kind)).toEqual([
      'ident',
      'string',
      'punct',
      'word',
      'punct',
    ]);
    expect(postgres[0]?.value).toBe('a"b');
    expect(postgres[1]?.value).toBe("it's");
    const mysql: Token[] = tokenize(
      '`a``b` "str\\"ing" \'x\\n\'',
      'mysql'
    ).tokens;
    expect(mysql.map((token: Token) => token.kind)).toEqual([
      'ident',
      'string',
      'string',
    ]);
    expect(mysql[0]?.value).toBe('a`b');
    expect(mysql[1]?.value).toBe('str"ing');
    expect(mysql[2]?.value).toBe('x\n');
    const server: Token[] = tokenize('[dbo].[a]]b] "q"', 'sqlserver').tokens;
    expect(server.map((token: Token) => token.value)).toEqual([
      'dbo',
      '.',
      'a]b',
      'q',
    ]);
  });

  it('reads dollar-quoted strings, E strings and positional parameters in PostgreSQL', () => {
    const tokens: Token[] = tokenize(
      `$$a;b$$ $tag$ x $$ y $tag$ E'a\\'b' $1`,
      'postgresql'
    ).tokens;
    expect(tokens.map((token: Token) => token.kind)).toEqual([
      'string',
      'string',
      'string',
      'word',
    ]);
    expect(tokens[0]?.value).toBe('a;b');
    expect(tokens[1]?.value).toBe(' x $$ y ');
    expect(tokens[2]?.value).toBe("a'b");
  });

  it('leaves an unterminated dollar quote as punctuation instead of swallowing the rest', () => {
    const tokens: Token[] = tokenize(
      '$a$ create table x (id int)',
      'postgresql'
    ).tokens;
    expect(tokens.some((token: Token) => token.up === 'CREATE')).toBe(true);
  });

  it('splits statements at ; and keeps BEGIN ... END bodies together', () => {
    const statements: Token[][] = splitStatements(
      tokenize(
        `create table a (id int); create trigger t after insert on a begin update a set id = 1; end; create table b (id int)`,
        'sqlite'
      ).tokens
    );
    expect(statements).toHaveLength(3);
    expect(statements[1]?.[1]?.up).toBe('TRIGGER');
  });

  it('understands MySQL DELIMITER and the SQL Server GO separator', () => {
    const mysql = tokenize(
      'DELIMITER ;;\ncreate trigger t begin select 1; end ;;\nDELIMITER ;\ncreate table a (id int);',
      'mysql'
    ).tokens;
    const statements: Token[][] = splitStatements(mysql);
    expect(statements).toHaveLength(2);
    const server = splitStatements(
      tokenize(
        'create table a (id int)\nGO\ncreate table b (id int)\ngo 2\n',
        'sqlserver'
      ).tokens
    );
    expect(server).toHaveLength(2);
  });

  it('skips the data rows of COPY ... FROM stdin', () => {
    const statements: Token[][] = splitStatements(
      tokenize(
        'copy t (a) from stdin;\n1\ncreate table fake (x int);\n\\.\ncreate table real (y int);',
        'postgresql'
      ).tokens
    );
    expect(statements).toHaveLength(2);
    expect(statements[1]?.[2]?.value).toBe('real');
  });

  it('guesses the dialect from characteristic syntax', () => {
    expect(detectDialect('CREATE TABLE `a` (id int) ENGINE=InnoDB;')).toBe(
      'mysql'
    );
    expect(
      detectDialect('CREATE TABLE a (id integer primary key autoincrement);')
    ).toBe('sqlite');
    expect(detectDialect('CREATE TABLE [a] (id int identity(1,1))\nGO')).toBe(
      'sqlserver'
    );
    expect(
      detectDialect('CREATE TABLE a (id serial, d timestamptz default now());')
    ).toBe('postgresql');
    expect(detectDialect('CREATE TABLE a (id int);')).toBe('postgresql');
  });
});

describe('canonical blog fixtures', () => {
  const dialects: SqlDialect[] = ['postgresql', 'mysql', 'sqlite', 'sqlserver'];
  const schemas: Record<string, IrSchema> = {};
  for (const dialect of dialects) {
    const { path, text } = readFixture(FIXTURES, `${dialect}/blog.sql`);
    schemas[dialect] = expectOk(
      parseSqlDdl([{ path, text }], { appLabel: 'blog' })
    );
  }

  it('detects the dialect of each fixture without being told', () => {
    for (const dialect of dialects) {
      const text: string = readFixture(FIXTURES, `${dialect}/blog.sql`).text;
      expect(detectDialect(text)).toBe(dialect);
    }
  });

  describe.each(dialects)('%s', (dialect) => {
    const schema: IrSchema = schemas[dialect] as IrSchema;

    it('reads the five models, the join table as many-to-many and no warnings', () => {
      expect(schema.models.map((item: IrModel) => item.name)).toEqual([
        'BlogUser',
        'BlogCategory',
        'BlogTag',
        'BlogPost',
        'BlogProfile',
      ]);
      expect(schema.models.map((item: IrModel) => item.tableName)).toEqual([
        'blog_user',
        'blog_category',
        'blog_tag',
        'blog_post',
        'blog_profile',
      ]);
      expect(schema.warnings).toEqual([]);
      expect(relation(schema, 'BlogPost', 'tags')).toMatchObject({
        kind: 'manyToMany',
        targetModel: 'BlogTag',
        relatedName: 'blog_posts',
      });
    });

    it('reads keys, lengths, nullability and defaults', () => {
      expect(field(schema, 'BlogPost', 'id')).toMatchObject({
        type: 'int',
        isPrimaryKey: true,
        isNullable: false,
        default: { kind: 'autoIncrement' },
      });
      expect(field(schema, 'BlogPost', 'title')).toMatchObject({
        type: 'string',
        maxLength: 200,
        isNullable: false,
      });
      expect(field(schema, 'BlogPost', 'body').type).toBe('text');
      expect(field(schema, 'BlogPost', 'rating')).toMatchObject({
        type: 'decimal',
        isNullable: true,
        maxDigits: 4,
        decimalPlaces: 2,
      });
      expect(field(schema, 'BlogPost', 'view_count').default).toEqual({
        kind: 'literal',
        value: 0,
      });
      expect(field(schema, 'BlogPost', 'is_featured')).toMatchObject({
        type: 'boolean',
        default: { kind: 'literal', value: false },
      });
      expect(field(schema, 'BlogPost', 'created_at')).toMatchObject({
        type: 'dateTime',
        default: { kind: 'now' },
      });
      expect(field(schema, 'BlogPost', 'published_at').default).toEqual({
        kind: 'now',
      });
      expect(field(schema, 'BlogProfile', 'avatar')).toMatchObject({
        type: 'string',
        maxLength: 100,
        isNullable: true,
      });
      expect(field(schema, 'BlogCategory', 'name')).toMatchObject({
        isUnique: true,
        maxLength: 100,
      });
    });

    it('reads the status column as an enum with its default', () => {
      const status: IrField = field(schema, 'BlogPost', 'status');
      expect(status.type).toBe('string');
      expect(status.enumName).toBeDefined();
      const enumType: IrEnum = enumNamed(schema, status.enumName as string);
      expect(enumType.values).toEqual([
        { name: 'DRAFT', dbValue: 'draft' },
        { name: 'PUBLISHED', dbValue: 'published' },
      ]);
      expect(status.default).toEqual({ kind: 'enumValue', value: 'DRAFT' });
    });

    it('reads the foreign keys with their actions and reverse accessors', () => {
      expect(relation(schema, 'BlogPost', 'author')).toMatchObject({
        kind: 'foreignKey',
        targetModel: 'BlogUser',
        columnName: 'author_id',
        isNullable: false,
        onDelete: 'cascade',
        relatedName: 'author_blog_posts',
      });
      expect(relation(schema, 'BlogPost', 'editor')).toMatchObject({
        isNullable: true,
        onDelete: 'setNull',
        relatedName: 'editor_blog_posts',
      });
      expect(relation(schema, 'BlogPost', 'category')).toMatchObject({
        targetModel: 'BlogCategory',
        isNullable: false,
        relatedName: 'blog_posts',
      });
      expect(relation(schema, 'BlogCategory', 'parent')).toMatchObject({
        targetModel: 'BlogCategory',
        isNullable: true,
        onDelete: 'setNull',
      });
      expect(relation(schema, 'BlogProfile', 'user')).toMatchObject({
        kind: 'oneToOne',
        onDelete: 'cascade',
        relatedName: 'blog_profile',
      });
    });

    it('reads the unique constraint and the indexes', () => {
      const indexes: IrIndex[] = model(schema, 'BlogPost').indexes;
      expect(indexes.find((index: IrIndex) => index.isUnique)?.fields).toEqual([
        'author',
        'title',
      ]);
      expect(
        indexes.find((index: IrIndex) => index.fields.join() === 'title')
      ).toMatchObject({ isUnique: false });
      expect(
        indexes.find((index: IrIndex) => index.name === 'post_pub_status_idx')
          ?.fields
      ).toEqual(['published_at', 'status']);
      // MySQL's indexes on the foreign-key columns are the ones the database adds itself.
      expect(model(schema, 'BlogCategory').indexes).toEqual([]);
      expect(indexes).toHaveLength(3);
    });
  });

  it('reads the dialect-specific details of each dialect', () => {
    const postgres = schemas.postgresql as IrSchema;
    expect(field(postgres, 'BlogPost', 'public_id')).toMatchObject({
      type: 'uuid',
      isUnique: true,
      default: { kind: 'uuid' },
    });
    expect(field(postgres, 'BlogPost', 'metadata')).toMatchObject({
      type: 'json',
      default: { kind: 'literal', value: '{}' },
    });
    expect(enumNamed(postgres, 'PostStatus').dbName).toBe('post_status');
    expect(model(postgres, 'BlogPost').compositePrimaryKey).toBeUndefined();
    expect(relation(postgres, 'BlogPost', 'category').constraintName).toBe(
      'blog_post_category_id_fkey'
    );

    const mysql = schemas.mysql as IrSchema;
    expect(field(mysql, 'BlogPost', 'updated_at')).toMatchObject({
      isAutoUpdated: true,
      default: { kind: 'now' },
    });
    expect(field(mysql, 'BlogPost', 'is_featured').type).toBe('boolean');
    expect(field(mysql, 'BlogPost', 'view_count').type).toBe('int');
    expect(field(mysql, 'BlogPost', 'body').type).toBe('text');
    expect(field(mysql, 'BlogPost', 'public_id')).toMatchObject({
      type: 'string',
      maxLength: 36,
      default: { kind: 'uuid' },
    });
    expect(enumNamed(mysql, 'BlogPostStatus').dbName).toBeUndefined();

    const sqlite = schemas.sqlite as IrSchema;
    expect(field(sqlite, 'BlogPost', 'metadata').type).toBe('json');
    expect(field(sqlite, 'BlogPost', 'is_featured').default).toEqual({
      kind: 'literal',
      value: false,
    });
    expect(field(sqlite, 'BlogPost', 'status')).toMatchObject({
      type: 'string',
      maxLength: 20,
      enumName: 'BlogPostStatus',
    });

    const sqlserver = schemas.sqlserver as IrSchema;
    expect(field(sqlserver, 'BlogPost', 'public_id')).toMatchObject({
      type: 'uuid',
      default: { kind: 'uuid' },
    });
    expect(field(sqlserver, 'BlogPost', 'body').type).toBe('text');
    expect(field(sqlserver, 'BlogPost', 'view_count').default).toEqual({
      kind: 'literal',
      value: 0,
    });
    expect(model(sqlserver, 'BlogPost').primaryKeyName).toBe('PK_blog_post');
    expect(relation(sqlserver, 'BlogPost', 'category')).toMatchObject({
      onDelete: 'noAction',
      constraintName: 'FK_blog_post_category',
    });
  });
});

describe('column types', () => {
  it.each<[SqlDialect, string, Partial<IrField>]>([
    ['postgresql', 'smallint', { type: 'int' }],
    ['postgresql', 'int2', { type: 'int' }],
    ['postgresql', 'integer', { type: 'int' }],
    ['postgresql', 'bigint', { type: 'bigInt' }],
    ['postgresql', 'int8', { type: 'bigInt' }],
    ['postgresql', 'real', { type: 'float' }],
    ['postgresql', 'double precision', { type: 'float' }],
    ['postgresql', 'float8', { type: 'float' }],
    [
      'postgresql',
      'numeric(10, 3)',
      { type: 'decimal', maxDigits: 10, decimalPlaces: 3 },
    ],
    [
      'postgresql',
      'decimal(8)',
      { type: 'decimal', maxDigits: 8, decimalPlaces: 0 },
    ],
    ['postgresql', 'numeric', { type: 'decimal' }],
    ['postgresql', 'boolean', { type: 'boolean' }],
    ['postgresql', 'bool', { type: 'boolean' }],
    ['postgresql', 'text', { type: 'text' }],
    ['postgresql', 'citext', { type: 'text' }],
    ['postgresql', 'varchar(40)', { type: 'string', maxLength: 40 }],
    ['postgresql', 'character varying(40)', { type: 'string', maxLength: 40 }],
    ['postgresql', 'character varying', { type: 'text' }],
    ['postgresql', 'varchar', { type: 'text' }],
    ['postgresql', 'char(3)', { type: 'string', maxLength: 3 }],
    ['postgresql', 'character(3)', { type: 'string', maxLength: 3 }],
    ['postgresql', 'char', { type: 'string', maxLength: 1 }],
    ['postgresql', 'bpchar', { type: 'text' }],
    ['postgresql', 'timestamp', { type: 'dateTime' }],
    ['postgresql', 'timestamp(3) without time zone', { type: 'dateTime' }],
    ['postgresql', 'timestamp with time zone', { type: 'dateTime' }],
    ['postgresql', 'timestamptz', { type: 'dateTime' }],
    ['postgresql', 'date', { type: 'date' }],
    ['postgresql', 'time', { type: 'time' }],
    ['postgresql', 'time(0) with time zone', { type: 'time' }],
    ['postgresql', 'interval', { type: 'duration' }],
    ['postgresql', 'interval day to second', { type: 'duration' }],
    ['postgresql', 'uuid', { type: 'uuid' }],
    ['postgresql', 'json', { type: 'json' }],
    ['postgresql', 'jsonb', { type: 'json' }],
    ['postgresql', 'bytea', { type: 'bytes' }],
    ['postgresql', 'inet', { type: 'ipAddress' }],
    ['postgresql', 'cidr', { type: 'ipAddress' }],
    ['postgresql', 'hstore', { type: 'hstore' }],
    ['postgresql', 'int4range', { type: 'range', rangeOf: 'int' }],
    ['postgresql', 'int8range', { type: 'range', rangeOf: 'bigInt' }],
    ['postgresql', 'numrange', { type: 'range', rangeOf: 'decimal' }],
    ['postgresql', 'daterange', { type: 'range', rangeOf: 'date' }],
    ['postgresql', 'tstzrange', { type: 'range', rangeOf: 'dateTime' }],
    ['postgresql', 'integer[]', { type: 'int', arrayDepth: 1 }],
    ['postgresql', 'text[][]', { type: 'text', arrayDepth: 2 }],
    [
      'postgresql',
      'varchar(10) ARRAY',
      { type: 'string', maxLength: 10, arrayDepth: 1 },
    ],
    ['postgresql', 'integer[3]', { type: 'int', arrayDepth: 1 }],
    [
      'postgresql',
      'tsvector',
      { type: 'unsupported', unsupportedType: 'tsvector' },
    ],
    [
      'postgresql',
      'geometry(Point, 4326)',
      { type: 'unsupported', unsupportedType: 'geometry(Point, 4326)' },
    ],
    ['postgresql', 'money', { type: 'unsupported' }],
    [
      'postgresql',
      'public.some_type',
      { type: 'unsupported', unsupportedType: 'public.some_type' },
    ],
    [
      'postgresql',
      'serial',
      { type: 'int', isNullable: false, default: { kind: 'autoIncrement' } },
    ],
    [
      'postgresql',
      'bigserial',
      { type: 'bigInt', default: { kind: 'autoIncrement' } },
    ],
    [
      'postgresql',
      'smallserial',
      { type: 'int', default: { kind: 'autoIncrement' } },
    ],
    ['mysql', 'tinyint(1)', { type: 'boolean' }],
    ['mysql', 'tinyint', { type: 'int' }],
    ['mysql', 'tinyint(4)', { type: 'int' }],
    ['mysql', 'mediumint unsigned', { type: 'int' }],
    ['mysql', 'int(11) unsigned zerofill', { type: 'int' }],
    ['mysql', 'bigint(20) unsigned', { type: 'bigInt' }],
    ['mysql', 'bit(1)', { type: 'boolean' }],
    ['mysql', 'bit(8)', { type: 'unsupported' }],
    ['mysql', 'double(8,2)', { type: 'float' }],
    ['mysql', 'float', { type: 'float' }],
    [
      'mysql',
      'decimal(10,2) unsigned',
      { type: 'decimal', maxDigits: 10, decimalPlaces: 2 },
    ],
    [
      'mysql',
      'varchar(255) CHARACTER SET utf8mb4',
      { type: 'string', maxLength: 255 },
    ],
    ['mysql', 'tinytext', { type: 'text' }],
    ['mysql', 'mediumtext', { type: 'text' }],
    ['mysql', 'longtext', { type: 'text' }],
    ['mysql', 'datetime(6)', { type: 'dateTime' }],
    ['mysql', 'timestamp', { type: 'dateTime' }],
    ['mysql', 'year', { type: 'int' }],
    ['mysql', 'json', { type: 'json' }],
    ['mysql', 'blob', { type: 'bytes' }],
    ['mysql', 'longblob', { type: 'bytes' }],
    ['mysql', 'varbinary(16)', { type: 'bytes' }],
    ['mysql', 'binary(16)', { type: 'bytes' }],
    ['mysql', 'serial', { type: 'bigInt', default: { kind: 'autoIncrement' } }],
    ['sqlite', 'INTEGER', { type: 'int' }],
    ['sqlite', 'INT', { type: 'int' }],
    ['sqlite', 'BIGINT', { type: 'bigInt' }],
    ['sqlite', 'UNSIGNED BIG INT', { type: 'bigInt' }],
    ['sqlite', 'TEXT', { type: 'text' }],
    ['sqlite', 'CLOB', { type: 'text' }],
    ['sqlite', 'VARCHAR(70)', { type: 'string', maxLength: 70 }],
    ['sqlite', 'VARYING CHARACTER(255)', { type: 'string', maxLength: 255 }],
    ['sqlite', 'NATIVE CHARACTER(70)', { type: 'string', maxLength: 70 }],
    ['sqlite', 'NCHAR(55)', { type: 'string', maxLength: 55 }],
    ['sqlite', 'BLOB', { type: 'bytes' }],
    ['sqlite', 'REAL', { type: 'float' }],
    ['sqlite', 'DOUBLE', { type: 'float' }],
    ['sqlite', 'FLOAT', { type: 'float' }],
    ['sqlite', 'NUMERIC', { type: 'decimal' }],
    [
      'sqlite',
      'DECIMAL(10,5)',
      { type: 'decimal', maxDigits: 10, decimalPlaces: 5 },
    ],
    ['sqlite', 'BOOLEAN', { type: 'boolean' }],
    ['sqlite', 'DATE', { type: 'date' }],
    ['sqlite', 'DATETIME', { type: 'dateTime' }],
    ['sqlite', 'JSON', { type: 'json' }],
    ['sqlite', 'MYSTERY', { type: 'decimal' }],
    ['sqlite', 'MYTEXTISH', { type: 'text' }],
    ['sqlserver', 'int', { type: 'int' }],
    ['sqlserver', 'tinyint', { type: 'int' }],
    ['sqlserver', 'bit', { type: 'boolean' }],
    ['sqlserver', 'nvarchar(50)', { type: 'string', maxLength: 50 }],
    ['sqlserver', 'nvarchar(max)', { type: 'text' }],
    ['sqlserver', 'varchar(max)', { type: 'text' }],
    ['sqlserver', 'nchar(10)', { type: 'string', maxLength: 10 }],
    ['sqlserver', 'ntext', { type: 'text' }],
    ['sqlserver', 'datetime2(7)', { type: 'dateTime' }],
    ['sqlserver', 'smalldatetime', { type: 'dateTime' }],
    ['sqlserver', 'datetimeoffset', { type: 'dateTime' }],
    ['sqlserver', 'uniqueidentifier', { type: 'uuid' }],
    [
      'sqlserver',
      'money',
      { type: 'decimal', maxDigits: 19, decimalPlaces: 4 },
    ],
    [
      'sqlserver',
      'smallmoney',
      { type: 'decimal', maxDigits: 10, decimalPlaces: 4 },
    ],
    ['sqlserver', 'varbinary(max)', { type: 'bytes' }],
    ['sqlserver', 'image', { type: 'bytes' }],
    [
      'sqlserver',
      'timestamp',
      { type: 'unsupported', unsupportedType: 'rowversion' },
    ],
    ['sqlserver', 'xml', { type: 'unsupported', unsupportedType: 'xml' }],
  ])('%s: %s', (dialect, ddl, expected) => {
    const result = columnOf(ddl, dialect);
    expect(result.field).toMatchObject(expected);
    if (
      expected.type === 'unsupported' &&
      expected.unsupportedType === undefined
    ) {
      expect(result.field.type).toBe('unsupported');
    }
  });

  it('reads quoted type names of SQL Server and keeps the unknown ones as unsupported with a warning', () => {
    const { schema, field: column } = columnOf(
      '[nvarchar](20) NULL',
      'sqlserver'
    );
    expect(column).toMatchObject({ type: 'string', maxLength: 20 });
    expect(schema.warnings).toEqual([]);
    const unknown = columnOf('mystery_type');
    expect(unknown.field).toMatchObject({
      type: 'unsupported',
      unsupportedType: 'mystery_type',
    });
    expect(unknown.schema.warnings.join('\n')).toContain('mystery_type');
  });
});

describe('defaults', () => {
  const defaultOf = (
    type: string,
    expression: string,
    dialect: SqlDialect = 'postgresql',
    tail: string = ''
  ): unknown =>
    columnOf(`${type} DEFAULT ${expression}${tail}`, dialect).field.default;

  it.each<[SqlDialect, string, string, unknown]>([
    ['postgresql', 'integer', '42', { kind: 'literal', value: 42 }],
    ['postgresql', 'integer', '-7', { kind: 'literal', value: -7 }],
    ['postgresql', 'numeric(5,2)', '1.50', { kind: 'literal', value: 1.5 }],
    ['postgresql', 'double precision', '0.1', { kind: 'literal', value: 0.1 }],
    ['postgresql', 'text', "'it''s'", { kind: 'literal', value: "it's" }],
    ['postgresql', 'text', "'x'::text", { kind: 'literal', value: 'x' }],
    [
      'postgresql',
      'varchar(5)',
      "'x'::character varying",
      { kind: 'literal', value: 'x' },
    ],
    ['postgresql', 'boolean', 'true', { kind: 'literal', value: true }],
    ['postgresql', 'boolean', 'FALSE', { kind: 'literal', value: false }],
    ['postgresql', 'boolean', "'t'", { kind: 'literal', value: true }],
    ['postgresql', 'timestamptz', 'now()', { kind: 'now' }],
    ['postgresql', 'timestamptz', 'CURRENT_TIMESTAMP', { kind: 'now' }],
    ['postgresql', 'timestamp', 'CURRENT_TIMESTAMP(3)', { kind: 'now' }],
    ['postgresql', 'timestamp', 'LOCALTIMESTAMP', { kind: 'now' }],
    ['postgresql', 'date', 'CURRENT_DATE', { kind: 'now' }],
    ['postgresql', 'uuid', 'gen_random_uuid()', { kind: 'uuid' }],
    ['postgresql', 'uuid', 'uuid_generate_v4()', { kind: 'uuid' }],
    [
      'postgresql',
      'integer',
      "nextval('seq'::regclass)",
      { kind: 'autoIncrement' },
    ],
    ['postgresql', 'jsonb', "'{}'::jsonb", { kind: 'literal', value: '{}' }],
    [
      'postgresql',
      'text[]',
      "'{}'",
      { kind: 'dbExpression', expression: "'{}'" },
    ],
    [
      'postgresql',
      'timestamp',
      "(now() AT TIME ZONE 'utc')",
      { kind: 'dbExpression', expression: "now() AT TIME ZONE 'utc'" },
    ],
    [
      'postgresql',
      'integer',
      '(1 + 2)',
      { kind: 'dbExpression', expression: '1 + 2' },
    ],
    [
      'postgresql',
      'text',
      "'a' || 'b'",
      { kind: 'dbExpression', expression: "'a' || 'b'" },
    ],
    [
      'postgresql',
      'integer',
      'abs(-3)',
      { kind: 'dbExpression', expression: 'abs(-3)' },
    ],
    ['mysql', 'tinyint(1)', "'0'", { kind: 'literal', value: false }],
    ['mysql', 'tinyint(1)', '1', { kind: 'literal', value: true }],
    ['mysql', 'int', "'5'", { kind: 'literal', value: 5 }],
    ['mysql', 'bit(1)', "b'1'", { kind: 'literal', value: true }],
    ['mysql', 'datetime(6)', 'CURRENT_TIMESTAMP(6)', { kind: 'now' }],
    ['mysql', 'char(36)', '(UUID())', { kind: 'uuid' }],
    ['mysql', 'varchar(10)', "'a\\'b'", { kind: 'literal', value: "a'b" }],
    ['sqlite', 'DATETIME', "(datetime('now'))", { kind: 'now' }],
    ['sqlite', 'DATETIME', 'CURRENT_TIMESTAMP', { kind: 'now' }],
    [
      'sqlite',
      'INTEGER',
      "(strftime('%s','now'))",
      { kind: 'dbExpression', expression: "strftime('%s','now')" },
    ],
    ['sqlite', 'BOOLEAN', '0', { kind: 'literal', value: false }],
    ['sqlite', 'TEXT', "'x'", { kind: 'literal', value: 'x' }],
    ['sqlserver', 'int', '((0))', { kind: 'literal', value: 0 }],
    ['sqlserver', 'bit', '((1))', { kind: 'literal', value: true }],
    ['sqlserver', 'datetime', '(getdate())', { kind: 'now' }],
    ['sqlserver', 'datetime2', '(sysutcdatetime())', { kind: 'now' }],
    ['sqlserver', 'uniqueidentifier', '(newid())', { kind: 'uuid' }],
    [
      'sqlserver',
      'nvarchar(10)',
      "(N'abc')",
      { kind: 'literal', value: 'abc' },
    ],
  ])('%s %s default %s', (dialect, type, expression, expected) => {
    expect(defaultOf(type, expression, dialect)).toEqual(expected);
  });

  it('treats DEFAULT NULL as no default and stops the expression at the next constraint', () => {
    expect(columnOf('int DEFAULT NULL').field.default).toBeUndefined();
    const { field: column } = columnOf('int DEFAULT 5 NOT NULL UNIQUE');
    expect(column).toMatchObject({
      default: { kind: 'literal', value: 5 },
      isNullable: false,
      isUnique: true,
    });
    expect(
      columnOf('text DEFAULT \'a\' COLLATE "C" NOT NULL').field
    ).toMatchObject({
      default: { kind: 'literal', value: 'a' },
      isNullable: false,
    });
  });

  it('keeps an enum default as the member and an unknown value as an expression', () => {
    const schema: IrSchema = parse(
      `CREATE TYPE s AS ENUM ('a b', 'c');
       CREATE TABLE t (id int PRIMARY KEY, x s DEFAULT 'a b', y s DEFAULT 'zzz');`
    );
    expect(field(schema, 'T', 'x').default).toEqual({
      kind: 'enumValue',
      value: 'A_B',
    });
    expect(field(schema, 'T', 'y').default).toEqual({
      kind: 'dbExpression',
      expression: "'zzz'",
    });
  });

  it('marks identity, auto_increment and autoincrement columns as auto-incrementing', () => {
    expect(
      columnOf('integer GENERATED ALWAYS AS IDENTITY').field.default
    ).toEqual({ kind: 'autoIncrement' });
    expect(
      columnOf('integer GENERATED BY DEFAULT AS IDENTITY (START WITH 5)').field
        .default
    ).toEqual({ kind: 'autoIncrement' });
    expect(columnOf('int AUTO_INCREMENT', 'mysql').field.default).toEqual({
      kind: 'autoIncrement',
    });
    expect(columnOf('int IDENTITY(1,1)', 'sqlserver').field).toMatchObject({
      default: { kind: 'autoIncrement' },
      isNullable: false,
    });
    // Not an integer: nothing to count.
    expect(
      columnOf('varchar(5) AUTO_INCREMENT', 'mysql').field.default
    ).toBeUndefined();
  });

  it('reads generated columns', () => {
    expect(
      columnOf('int GENERATED ALWAYS AS (id * 2) STORED').field.generated
    ).toEqual({ expression: 'id * 2', isStored: true });
    expect(columnOf('int AS (id * 2)', 'mysql').field.generated).toEqual({
      expression: 'id * 2',
      isStored: false,
    });
    expect(
      parse(
        'CREATE TABLE t (id int PRIMARY KEY, c AS (id + 1) PERSISTED, d int)',
        'sqlserver'
      ).warnings.join('\n')
    ).toContain('no declared type');
  });

  it('reads ON UPDATE CURRENT_TIMESTAMP as auto-updated', () => {
    const { field: column } = columnOf(
      'datetime DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP',
      'mysql'
    );
    expect(column).toMatchObject({
      isAutoUpdated: true,
      default: { kind: 'now' },
    });
  });
});

describe('keys, constraints and relations', () => {
  it('reads inline and table-level primary keys, composite keys and key names', () => {
    const schema: IrSchema = parse(`
      CREATE TABLE a (id int PRIMARY KEY, n text);
      CREATE TABLE b (id int, n text, CONSTRAINT b_pk PRIMARY KEY (id));
      CREATE TABLE c (x int, y int, z text, PRIMARY KEY (x, y));
      CREATE TABLE d (id int NOT NULL, n text);
      ALTER TABLE d ADD PRIMARY KEY (id);
    `);
    expect(field(schema, 'A', 'id')).toMatchObject({
      isPrimaryKey: true,
      isNullable: false,
    });
    expect(field(schema, 'B', 'id').isPrimaryKey).toBe(true);
    expect(model(schema, 'B').primaryKeyName).toBe('b_pk');
    expect(model(schema, 'C').compositePrimaryKey).toEqual(['x', 'y']);
    expect(field(schema, 'C', 'x')).toMatchObject({
      isPrimaryKey: false,
      isNullable: false,
    });
    expect(field(schema, 'D', 'id').isPrimaryKey).toBe(true);
  });

  it('warns about a table without a primary key', () => {
    const schema: IrSchema = parse('CREATE TABLE t (a int);');
    expect(schema.warnings.join('\n')).toContain('no primary key');
  });

  it('reads unique constraints: inline, named, table-level and added later', () => {
    const schema: IrSchema = parse(`
      CREATE TABLE t (
        id int PRIMARY KEY,
        a text UNIQUE,
        b text CONSTRAINT uq_b UNIQUE,
        c text, d text, e text, f text,
        UNIQUE (c),
        UNIQUE (d, e)
      );
      ALTER TABLE t ADD CONSTRAINT uq_f UNIQUE (f);
    `);
    expect(field(schema, 'T', 'a')).toMatchObject({ isUnique: true });
    expect(field(schema, 'T', 'b')).toMatchObject({
      isUnique: true,
      uniqueName: 'uq_b',
    });
    expect(field(schema, 'T', 'c').isUnique).toBe(true);
    expect(field(schema, 'T', 'f')).toMatchObject({
      isUnique: true,
      uniqueName: 'uq_f',
    });
    expect(model(schema, 'T').indexes).toEqual([
      { fields: ['d', 'e'], isUnique: true },
    ]);
  });

  it('reads every referential action and the default', () => {
    const schema: IrSchema = parse(`
      CREATE TABLE p (id int PRIMARY KEY);
      CREATE TABLE c (
        id int PRIMARY KEY,
        a int REFERENCES p (id) ON DELETE CASCADE ON UPDATE RESTRICT,
        b int REFERENCES p (id) ON DELETE SET NULL ON UPDATE SET DEFAULT,
        c int REFERENCES p (id) ON DELETE RESTRICT,
        d int REFERENCES p (id) ON DELETE NO ACTION ON UPDATE NO ACTION,
        e int REFERENCES p (id) ON DELETE SET DEFAULT DEFERRABLE INITIALLY DEFERRED,
        f int REFERENCES p (id) MATCH FULL NOT DEFERRABLE,
        g int REFERENCES p
      );
    `);
    const actions = (name: string) => {
      const found: IrRelation = relation(schema, 'C', name);
      return [found.onDelete, found.onUpdate];
    };
    expect(actions('a')).toEqual(['cascade', 'restrict']);
    expect(actions('b')).toEqual(['setNull', 'setDefault']);
    expect(actions('c')).toEqual(['restrict', undefined]);
    expect(actions('d')).toEqual(['noAction', undefined]);
    expect(actions('e')).toEqual(['setDefault', undefined]);
    expect(actions('f')).toEqual(['noAction', undefined]);
    expect(relation(schema, 'C', 'g')).toMatchObject({
      targetModel: 'P',
      onDelete: 'noAction',
    });
  });

  it('names relations after the column without its key suffix', () => {
    const schema: IrSchema = parse(`
      CREATE TABLE p (id int PRIMARY KEY);
      CREATE TABLE c (
        id int PRIMARY KEY,
        author_id int REFERENCES p (id),
        editorId int REFERENCES p (id),
        owner int REFERENCES p (id),
        p_uuid int REFERENCES p (id)
      );
    `);
    expect(
      model(schema, 'C').relations.map((item: IrRelation) => item.name)
    ).toEqual(['author', 'editor', 'owner', 'p']);
    expect(relation(schema, 'C', 'author').relatedName).toBe('author_cs');
    expect(model(schema, 'C').fields.map((item: IrField) => item.name)).toEqual(
      ['id']
    );
  });

  it('reads a unique or primary-key foreign key as one-to-one, and the key itself as a relation', () => {
    const schema: IrSchema = parse(`
      CREATE TABLE p (id int PRIMARY KEY);
      CREATE TABLE u1 (id int PRIMARY KEY, p_id int UNIQUE REFERENCES p (id));
      CREATE TABLE u2 (id int PRIMARY KEY, p_id int REFERENCES p (id), UNIQUE (p_id));
      CREATE TABLE u3 (id int PRIMARY KEY, p_id int REFERENCES p (id));
      CREATE UNIQUE INDEX u3_p ON u3 (p_id);
      CREATE TABLE u4 (p_id int PRIMARY KEY REFERENCES p (id), note text);
      CREATE TABLE u5 (id int PRIMARY KEY, p_id int REFERENCES p (id));
      CREATE INDEX u5_p ON u5 (p_id);
    `);
    expect(relation(schema, 'U1', 'p').kind).toBe('oneToOne');
    expect(relation(schema, 'U2', 'p').kind).toBe('oneToOne');
    expect(relation(schema, 'U3', 'p').kind).toBe('oneToOne');
    expect(relation(schema, 'U4', 'p')).toMatchObject({
      kind: 'oneToOne',
      isPrimaryKey: true,
      isNullable: false,
    });
    expect(
      model(schema, 'U4').fields.map((item: IrField) => item.name)
    ).toEqual(['note']);
    expect(relation(schema, 'U5', 'p').kind).toBe('foreignKey');
    expect(relation(schema, 'U1', 'p').relatedName).toBe('u1');
    expect(relation(schema, 'U5', 'p').relatedName).toBe('u5s');
  });

  it('reads a foreign key to a unique column that is not the key as toField', () => {
    const schema: IrSchema = parse(`
      CREATE TABLE p (id int PRIMARY KEY, code text UNIQUE);
      CREATE TABLE c (id int PRIMARY KEY, p_code text REFERENCES p (code));
    `);
    expect(relation(schema, 'C', 'p')).toMatchObject({
      targetModel: 'P',
      toField: 'code',
    });
  });

  it('reads composite foreign keys, keeping the local columns as fields', () => {
    const schema: IrSchema = parse(`
      CREATE TABLE o (a int, b int, PRIMARY KEY (a, b));
      CREATE TABLE c (
        id int PRIMARY KEY, a int NOT NULL, b int,
        CONSTRAINT c_o FOREIGN KEY (a, b) REFERENCES o (a, b) ON DELETE CASCADE ON UPDATE CASCADE
      );
    `);
    expect(model(schema, 'C').compositeForeignKeys).toEqual([
      {
        name: 'o',
        targetModel: 'O',
        fields: ['a', 'b'],
        references: ['a', 'b'],
        kind: 'foreignKey',
        isNullable: true,
        onDelete: 'cascade',
        onUpdate: 'cascade',
        relatedName: 'cs',
        constraintName: 'c_o',
      },
    ]);
    expect(model(schema, 'C').fields.map((item: IrField) => item.name)).toEqual(
      ['id', 'a', 'b']
    );
  });

  it('keeps the column and warns when a foreign key points at an unknown table or column', () => {
    const schema: IrSchema = parse(`
      CREATE TABLE p (id int PRIMARY KEY);
      CREATE TABLE c (
        id int PRIMARY KEY,
        x int REFERENCES nowhere (id),
        y int REFERENCES p (missing),
        z int REFERENCES other_schema.p (id)
      );
    `);
    expect(
      model(schema, 'C').relations.map((item: IrRelation) => item.name)
    ).toEqual([]);
    expect(model(schema, 'C').fields.map((item: IrField) => item.name)).toEqual(
      ['id', 'x', 'y', 'z']
    );
    expect(schema.warnings.join('\n')).toContain('"nowhere"');
    expect(schema.warnings.join('\n')).toContain('"other_schema.p"');
    expect(schema.warnings.join('\n')).toContain('does not match the columns');
  });

  it('names two keys to the same table and avoids clashes between reverse accessors', () => {
    const schema: IrSchema = parse(`
      CREATE TABLE u (id int PRIMARY KEY, posts text);
      CREATE TABLE post (id int PRIMARY KEY, author_id int REFERENCES u (id), editor_id int REFERENCES u (id));
      CREATE TABLE note (id int PRIMARY KEY, u_id int REFERENCES u (id));
    `);
    expect(relation(schema, 'Post', 'author').relatedName).toBe('author_posts');
    expect(relation(schema, 'Post', 'editor').relatedName).toBe('editor_posts');
    expect(relation(schema, 'Note', 'u').relatedName).toBe('notes');
    const clash: IrSchema = parse(`
      CREATE TABLE u (id int PRIMARY KEY, notes text);
      CREATE TABLE note (id int PRIMARY KEY, u_id int REFERENCES u (id));
    `);
    expect(relation(clash, 'Note', 'u').relatedName).toBe('notes_2');
  });

  it('reads the foreign key written after the column list and added with ALTER TABLE', () => {
    const schema: IrSchema = parse(`
      CREATE TABLE p (id int PRIMARY KEY);
      CREATE TABLE c (id int PRIMARY KEY, p_id int);
      ALTER TABLE ONLY public.c ADD CONSTRAINT c_p_fk FOREIGN KEY (p_id) REFERENCES public.p (id) ON DELETE CASCADE;
    `);
    expect(relation(schema, 'C', 'p')).toMatchObject({
      onDelete: 'cascade',
      constraintName: 'c_p_fk',
    });
  });
});

describe('indexes', () => {
  const base: string =
    'CREATE TABLE t (id int PRIMARY KEY, a text, b text, c text);';

  it('reads plain, unique and multi-column indexes with their names', () => {
    const schema: IrSchema = parse(`${base}
      CREATE INDEX t_a ON t (a);
      CREATE UNIQUE INDEX t_ab ON t (a, b);
      CREATE INDEX ON t (c);
    `);
    expect(model(schema, 'T').indexes).toEqual([
      { fields: ['a'], isUnique: false, name: 't_a' },
      { fields: ['a', 'b'], isUnique: true, name: 't_ab' },
      { fields: ['c'], isUnique: false },
    ]);
  });

  it('reads sort order, operator classes, the access method and CONCURRENTLY / IF NOT EXISTS', () => {
    const schema: IrSchema = parse(`${base}
      CREATE INDEX CONCURRENTLY IF NOT EXISTS t_a ON ONLY public.t USING gin (a gin_trgm_ops, b DESC NULLS LAST) INCLUDE (c) WITH (fillfactor = 70);
    `);
    expect(model(schema, 'T').indexes).toEqual([
      {
        fields: ['a', 'b'],
        isUnique: false,
        name: 't_a',
        method: 'Gin',
        fieldOptions: {
          a: { ops: 'raw("gin_trgm_ops")' },
          b: { sort: 'desc' },
        },
      },
    ]);
    expect(schema.warnings).toEqual([]);
  });

  it('reads MySQL KEY, UNIQUE KEY and FULLTEXT definitions with prefix lengths', () => {
    const schema: IrSchema = parse(
      `CREATE TABLE \`t\` (
        \`id\` int NOT NULL AUTO_INCREMENT, \`a\` text, \`b\` varchar(10),
        PRIMARY KEY (\`id\`),
        KEY \`k\` (\`a\`(20), \`b\` DESC),
        UNIQUE KEY \`u\` (\`b\`),
        FULLTEXT KEY \`f\` (\`a\`)
      ) ENGINE=InnoDB;
      CREATE INDEX \`late\` USING BTREE ON \`t\` (\`b\`, \`a\`(5));`
    );
    expect(model(schema, 'T').indexes).toEqual([
      {
        fields: ['a', 'b'],
        isUnique: false,
        name: 'k',
        fieldOptions: { a: { length: 20 }, b: { sort: 'desc' } },
      },
      { fields: ['a'], isUnique: false, name: 'f', kind: 'fulltext' },
      {
        fields: ['b', 'a'],
        isUnique: false,
        name: 'late',
        fieldOptions: { a: { length: 5 } },
      },
    ]);
    expect(field(schema, 'T', 'b')).toMatchObject({
      isUnique: true,
      uniqueName: 'u',
    });
  });

  it('reads SQL Server CLUSTERED / NONCLUSTERED indexes', () => {
    const schema: IrSchema = parse(
      `CREATE TABLE [t] ([id] int NOT NULL PRIMARY KEY, [a] int);
       CREATE CLUSTERED INDEX [ix_a] ON [dbo].[t] ([a] DESC);
       CREATE UNIQUE NONCLUSTERED INDEX [ux_a] ON [t] ([a]);`
    );
    expect(model(schema, 'T').indexes).toEqual([
      {
        fields: ['a'],
        isUnique: false,
        name: 'ix_a',
        clustered: true,
        fieldOptions: { a: { sort: 'desc' } },
      },
      { fields: ['a'], isUnique: true, name: 'ux_a', clustered: false },
    ]);
  });

  it('skips expression indexes and partial unique indexes, and drops the predicate of other partial indexes', () => {
    const schema: IrSchema = parse(`${base}
      CREATE INDEX e1 ON t (lower(a));
      CREATE INDEX e2 ON t ((a || b));
      CREATE UNIQUE INDEX p1 ON t (a) WHERE b IS NOT NULL;
      CREATE INDEX p2 ON t (b) WHERE c > 3;
      CREATE INDEX missing ON t (nope);
      CREATE INDEX nowhere ON no_such_table (a);
    `);
    expect(model(schema, 'T').indexes).toEqual([
      { fields: ['b'], isUnique: false, name: 'p2' },
    ]);
    const text: string = schema.warnings.join('\n');
    expect(text).toContain('"e1" is on an expression');
    expect(text).toContain('"e2" is on an expression');
    expect(text).toContain('partial unique index "p1"');
    expect(text).toContain('WHERE condition of the index "p2"');
    expect(text).toContain('unknown column');
    expect(text).toContain('unknown table "no_such_table"');
  });
});

describe('enums', () => {
  it('reads CREATE TYPE ... AS ENUM, its schema and the members', () => {
    const schema: IrSchema = parse(`
      CREATE TYPE mood AS ENUM ('sad', 'Very Happy', '7up', '');
      CREATE TYPE auth.role AS ENUM ('admin');
      CREATE TABLE t (id int PRIMARY KEY, m mood, r auth.role);
    `);
    expect(enumNamed(schema, 'Mood')).toEqual({
      name: 'Mood',
      dbName: 'mood',
      values: [
        { name: 'SAD', dbValue: 'sad' },
        { name: 'VERY_HAPPY', dbValue: 'Very Happy' },
        { name: 'V_7UP', dbValue: '7up' },
        { name: 'VALUE_4', dbValue: '' },
      ],
    });
    expect(enumNamed(schema, 'Role')).toMatchObject({
      schema: 'auth',
      dbName: 'role',
    });
    expect(field(schema, 'T', 'm')).toMatchObject({
      type: 'string',
      enumName: 'Mood',
    });
    expect(field(schema, 'T', 'r').enumName).toBe('Role');
  });

  it('applies ALTER TYPE ... ADD VALUE, including BEFORE and AFTER', () => {
    const schema: IrSchema = parse(`
      CREATE TYPE s AS ENUM ('a', 'c');
      ALTER TYPE s ADD VALUE 'b' AFTER 'a';
      ALTER TYPE s ADD VALUE IF NOT EXISTS 'z';
      ALTER TYPE s ADD VALUE 'start' BEFORE 'a';
      ALTER TYPE s ADD VALUE 'a';
      CREATE TABLE t (id int PRIMARY KEY, x s);
    `);
    expect(enumNamed(schema, 'S').values.map((item) => item.dbValue)).toEqual([
      'start',
      'a',
      'b',
      'c',
      'z',
    ]);
  });

  it('reads inline MySQL ENUM columns as an enum named after the table and column', () => {
    const schema: IrSchema = parse(
      "CREATE TABLE `posts` (`id` int PRIMARY KEY, `status` enum('draft','live') NOT NULL DEFAULT 'live', `tags` set('a','b'));",
      'mysql'
    );
    expect(enumNamed(schema, 'PostStatus').values).toEqual([
      { name: 'DRAFT', dbValue: 'draft' },
      { name: 'LIVE', dbValue: 'live' },
    ]);
    expect(field(schema, 'Post', 'status')).toMatchObject({
      enumName: 'PostStatus',
      default: { kind: 'enumValue', value: 'LIVE' },
    });
    expect(field(schema, 'Post', 'tags').type).toBe('text');
    expect(schema.warnings.join('\n')).toContain('SET column');
  });

  it.each<[string, SqlDialect, string]>([
    ["status varchar(10) CHECK (status IN ('a', 'b'))", 'sqlite', 'status'],
    ["status text, CHECK (status = 'a' OR status = 'b')", 'sqlite', 'status'],
    [
      "status text CHECK ((status)::text = ANY ((ARRAY['a'::character varying, 'b'::character varying])::text[]))",
      'postgresql',
      'status',
    ],
    [
      "[status] nvarchar(10), CONSTRAINT ck CHECK ([status]='a' OR [status]='b')",
      'sqlserver',
      'status',
    ],
  ])(
    'turns a CHECK on the allowed values into an enum: %s',
    (ddl, dialect, column) => {
      const schema: IrSchema = parse(
        `CREATE TABLE t (id int PRIMARY KEY, ${ddl});`,
        dialect
      );
      expect(field(schema, 'T', column).enumName).toBe('TStatus');
      expect(
        enumNamed(schema, 'TStatus').values.map((item) => item.dbValue)
      ).toEqual(['a', 'b']);
      expect(schema.warnings).toEqual([]);
    }
  );

  it.each([
    'CHECK (a > 0)',
    'CHECK (a IN (1, 2))',
    "CHECK (a NOT IN ('x'))",
    'CHECK (length(a) < 3)',
    "CHECK (a IN ('x') AND b IN ('y'))",
  ])(
    'keeps other CHECK constraints out of the enums but warns: %s',
    (check) => {
      const schema: IrSchema = parse(
        `CREATE TABLE t (id int PRIMARY KEY, a text, b text, ${check});`
      );
      expect(schema.enums).toEqual([]);
      expect(schema.warnings.join('\n')).toContain('CHECK constraint');
    }
  );
});

describe('join tables', () => {
  const owners: string = `
    CREATE TABLE blog_post (id int PRIMARY KEY);
    CREATE TABLE blog_tag (id int PRIMARY KEY);
  `;

  it('reads two foreign keys that form the primary key as many-to-many', () => {
    const schema: IrSchema = parse(`${owners}
      CREATE TABLE blog_post_tags (
        post_id int NOT NULL REFERENCES blog_post (id) ON DELETE CASCADE,
        tag_id int NOT NULL REFERENCES blog_tag (id) ON DELETE CASCADE,
        PRIMARY KEY (post_id, tag_id)
      );`);
    expect(schema.models.map((item: IrModel) => item.name)).toEqual([
      'BlogPost',
      'BlogTag',
    ]);
    expect(relation(schema, 'BlogPost', 'tags')).toEqual({
      name: 'tags',
      kind: 'manyToMany',
      targetModel: 'BlogTag',
      columnName: '',
      isNullable: false,
      onDelete: 'cascade',
      relatedName: 'blog_posts',
    });
    expect(model(schema, 'BlogTag').relations).toEqual([]);
    expect(schema.warnings).toEqual([]);
  });

  it('puts the relation on the table whose name starts the join table name', () => {
    const schema: IrSchema = parse(`${owners}
      CREATE TABLE blog_post_tags (
        tag_id int REFERENCES blog_tag (id),
        post_id int REFERENCES blog_post (id),
        PRIMARY KEY (tag_id, post_id)
      );`);
    expect(relation(schema, 'BlogPost', 'tags').targetModel).toBe('BlogTag');
  });

  it('names the relation after the target and warns when the join table name does not tell', () => {
    const schema: IrSchema = parse(`${owners}
      CREATE TABLE links (
        a int REFERENCES blog_post (id),
        b int REFERENCES blog_tag (id),
        PRIMARY KEY (a, b)
      );`);
    expect(relation(schema, 'BlogPost', 'blog_tags')).toMatchObject({
      kind: 'manyToMany',
      relatedName: 'blog_posts',
    });
    expect(schema.warnings.join('\n')).toContain('"links"');
  });

  it('reads a self-referencing join table with the directions named after the columns', () => {
    const schema: IrSchema = parse(`
      CREATE TABLE person (id int PRIMARY KEY);
      CREATE TABLE follow (
        follower_id int REFERENCES person (id),
        followee_id int REFERENCES person (id),
        PRIMARY KEY (follower_id, followee_id)
      );`);
    expect(relation(schema, 'Person', 'followees')).toMatchObject({
      kind: 'manyToMany',
      targetModel: 'Person',
      relatedName: 'followers',
    });
  });

  it.each([
    ['an extra column', 'extra text,'],
    ['a surrogate key', 'id serial,'],
  ])('keeps the table as a model with %s', (_label, extra) => {
    const primaryKey: string = extra.startsWith('id')
      ? 'PRIMARY KEY (id)'
      : 'PRIMARY KEY (post_id, tag_id)';
    const schema: IrSchema = parse(`${owners}
      CREATE TABLE blog_post_tags (
        ${extra}
        post_id int REFERENCES blog_post (id),
        tag_id int REFERENCES blog_tag (id),
        ${primaryKey}
      );`);
    expect(schema.models.map((item: IrModel) => item.name)).toContain(
      'BlogPostTag'
    );
    expect(relation(schema, 'BlogPostTag', 'post').targetModel).toBe(
      'BlogPost'
    );
  });

  it('keeps the table as a model when it has an index, a unique constraint, is referenced, or has a primary key of one column', () => {
    const variants: string[] = [
      'CREATE INDEX j_idx ON j (tag_id);',
      'ALTER TABLE j ADD UNIQUE (post_id);',
      'CREATE TABLE after_j (id int PRIMARY KEY, j_post int, j_tag int, FOREIGN KEY (j_post, j_tag) REFERENCES j (post_id, tag_id));',
    ];
    for (const extra of variants) {
      const schema: IrSchema = parse(`${owners}
        CREATE TABLE j (post_id int REFERENCES blog_post (id), tag_id int REFERENCES blog_tag (id), PRIMARY KEY (post_id, tag_id));
        ${extra}`);
      expect(schema.models.map((item: IrModel) => item.name)).toContain('J');
    }
    const single: IrSchema = parse(`${owners}
      CREATE TABLE j (post_id int PRIMARY KEY REFERENCES blog_post (id), tag_id int REFERENCES blog_tag (id));`);
    expect(single.models.map((item: IrModel) => item.name)).toContain('J');
  });

  it('keeps the table when a key does not point at the primary key of its target', () => {
    const schema: IrSchema = parse(`
      CREATE TABLE a (id int PRIMARY KEY, code text UNIQUE);
      CREATE TABLE b (id int PRIMARY KEY);
      CREATE TABLE j (a_code text REFERENCES a (code), b_id int REFERENCES b (id), PRIMARY KEY (a_code, b_id));`);
    expect(schema.models.map((item: IrModel) => item.name)).toContain('J');
  });
});

describe('ALTER TABLE', () => {
  it('adds columns and constraints', () => {
    const schema: IrSchema = parse(`
      CREATE TABLE p (id int PRIMARY KEY);
      CREATE TABLE t (id int NOT NULL);
      ALTER TABLE t ADD COLUMN IF NOT EXISTS n varchar(5) NOT NULL DEFAULT 'x';
      ALTER TABLE t ADD m int, ADD COLUMN p_id int;
      ALTER TABLE t ADD CONSTRAINT t_pk PRIMARY KEY (id);
      ALTER TABLE t ADD CONSTRAINT t_chk CHECK (m > 0);
      ALTER TABLE t ADD FOREIGN KEY (p_id) REFERENCES p (id);
    `);
    expect(field(schema, 'T', 'n')).toMatchObject({
      type: 'string',
      maxLength: 5,
      default: { kind: 'literal', value: 'x' },
    });
    expect(field(schema, 'T', 'm').type).toBe('int');
    expect(field(schema, 'T', 'id').isPrimaryKey).toBe(true);
    expect(relation(schema, 'T', 'p').targetModel).toBe('P');
    expect(schema.warnings.join('\n')).toContain('CHECK constraint');
  });

  it('replays the ALTER COLUMN forms pg_dump writes', () => {
    const schema: IrSchema = parse(`
      CREATE TABLE t (id integer NOT NULL, n text, d text DEFAULT 'a');
      ALTER TABLE ONLY public.t ALTER COLUMN id SET DEFAULT nextval('public.t_id_seq'::regclass);
      ALTER TABLE public.t ALTER COLUMN n SET NOT NULL;
      ALTER TABLE public.t ALTER COLUMN d DROP DEFAULT;
      ALTER TABLE public.t ALTER COLUMN d DROP NOT NULL;
      ALTER TABLE public.t OWNER TO postgres;
      ALTER TABLE ONLY public.t ADD CONSTRAINT t_pkey PRIMARY KEY (id);
    `);
    expect(field(schema, 'T', 'id').default).toEqual({ kind: 'autoIncrement' });
    expect(field(schema, 'T', 'n').isNullable).toBe(false);
    expect(field(schema, 'T', 'd').default).toBeUndefined();
    expect(schema.warnings).toEqual([]);
  });

  it('reads the SQL Server forms: WITH CHECK ADD, DEFAULT ... FOR, CHECK CONSTRAINT', () => {
    const schema: IrSchema = parse(
      `CREATE TABLE [dbo].[p] ([id] int NOT NULL PRIMARY KEY)
       GO
       CREATE TABLE [dbo].[t] ([id] int NOT NULL PRIMARY KEY, [p_id] int NOT NULL, [q] int NULL)
       GO
       ALTER TABLE [dbo].[t] WITH NOCHECK ADD CONSTRAINT [fk] FOREIGN KEY ([p_id]) REFERENCES [dbo].[p] ([id]) ON DELETE CASCADE
       GO
       ALTER TABLE [dbo].[t] CHECK CONSTRAINT [fk]
       GO
       ALTER TABLE [dbo].[t] ADD CONSTRAINT [df_q] DEFAULT ((7)) FOR [q]
       GO`
    );
    expect(relation(schema, 'T', 'p')).toMatchObject({
      onDelete: 'cascade',
      constraintName: 'fk',
    });
    expect(field(schema, 'T', 'q').default).toEqual({
      kind: 'literal',
      value: 7,
    });
    expect(schema.warnings).toEqual([]);
  });

  it('warns once per kind of change it does not replay, and about unknown tables', () => {
    const schema: IrSchema = parse(`
      CREATE TABLE t (id int PRIMARY KEY, a int);
      ALTER TABLE t DROP COLUMN a;
      ALTER TABLE t RENAME TO u;
      ALTER TABLE t ALTER COLUMN a TYPE bigint;
      ALTER TABLE nope ADD COLUMN x int;
      ALTER SEQUENCE s OWNED BY t.id;
    `);
    const text: string = schema.warnings.join('\n');
    expect(text).toContain('ALTER TABLE ... DROP');
    expect(text).toContain('ALTER TABLE ... RENAME');
    expect(text).toContain('ALTER COLUMN');
    expect(text).toContain('unknown table "nope"');
  });

  it('forgets dropped tables and types and lets a table be created again', () => {
    const schema: IrSchema = parse(`
      CREATE TYPE s AS ENUM ('a');
      CREATE TABLE gone (id int PRIMARY KEY);
      CREATE TABLE kept (id int PRIMARY KEY, x text);
      DROP TABLE IF EXISTS gone, missing CASCADE;
      DROP TYPE s;
      DROP TABLE kept;
      CREATE TABLE kept (id int PRIMARY KEY, y text);
    `);
    expect(schema.models.map((item: IrModel) => item.name)).toEqual(['Kept']);
    expect(
      model(schema, 'Kept').fields.map((item: IrField) => item.name)
    ).toEqual(['id', 'y']);
    expect(schema.enums).toEqual([]);
    expect(schema.warnings).toEqual([]);
  });
});

describe('statements that are skipped', () => {
  it('ignores COMMENT ON, SET, GRANT, transactions and extensions without a warning', () => {
    const schema: IrSchema = parse(`
      SET search_path = public;
      BEGIN;
      CREATE EXTENSION IF NOT EXISTS pgcrypto;
      CREATE SCHEMA app;
      CREATE TABLE t (id int PRIMARY KEY);
      COMMENT ON TABLE t IS 'a table; with a semicolon';
      COMMENT ON COLUMN t.id IS 'the id';
      GRANT ALL ON t TO someone;
      COMMIT;
    `);
    expect(schema.warnings).toEqual([]);
  });

  it('groups skipped statements by kind with a count and the first line', () => {
    const schema: IrSchema = parse(`CREATE TABLE t (id int PRIMARY KEY);
      CREATE VIEW v1 AS SELECT 1;
      CREATE VIEW v2 AS SELECT 2;
      CREATE OR REPLACE FUNCTION f() RETURNS int AS $$ SELECT 1; $$ LANGUAGE sql;
      CREATE SEQUENCE s;
      INSERT INTO t VALUES (1);
      INSERT INTO t VALUES (2);
      UPDATE t SET id = 3;
      CREATE TEMPORARY TABLE tmp (x int);
      CREATE TABLE copy_of AS SELECT * FROM t;
      CREATE TABLE child PARTITION OF t FOR VALUES IN (1);
      FROBNICATE everything;
    `);
    expect(schema.warnings).toEqual([
      'Skipped 2 CREATE VIEW statements (first at schema.sql:2): views are not read.',
      'Skipped 1 CREATE OR REPLACE FUNCTION statement (first at schema.sql:4): it has no equivalent in the shared model.',
      'Skipped 1 CREATE SEQUENCE statement (first at schema.sql:5): it has no equivalent in the shared model.',
      'Skipped 3 data statements (first at schema.sql:6): row data is not part of the schema.',
      'Skipped 1 CREATE TEMPORARY TABLE statement (first at schema.sql:9): it has no equivalent in the shared model.',
      'Skipped 1 CREATE TABLE ... AS SELECT statement (first at schema.sql:10): it has no equivalent in the shared model.',
      'Skipped 1 CREATE TABLE ... PARTITION OF statement (first at schema.sql:11): it has no equivalent in the shared model.',
      'Skipped 1 FROBNICATE statement (first at schema.sql:12): it has no equivalent in the shared model.',
    ]);
    expect(schema.models).toHaveLength(1);
  });

  it('does not read tables inside function bodies, trigger bodies, COPY data or strings', () => {
    const schema: IrSchema = parse(`
      CREATE TABLE real_one (id int PRIMARY KEY);
      CREATE FUNCTION f() RETURNS void AS $body$ CREATE TABLE in_function (id int); $body$ LANGUAGE sql;
      CREATE TRIGGER trg AFTER INSERT ON real_one BEGIN CREATE TABLE in_trigger (id int); END;
      COPY real_one (id) FROM stdin;
      CREATE TABLE in_copy (id int);
      \\.
      SELECT 'CREATE TABLE in_string (id int);';
      -- CREATE TABLE in_comment (id int);
      /* CREATE TABLE in_block_comment (id int); */
    `);
    expect(schema.models.map((item: IrModel) => item.name)).toEqual([
      'RealOne',
    ]);
  });

  it('warns about table options it ignores (INHERITS, PARTITION BY) and keeps the table', () => {
    const schema: IrSchema = parse(`
      CREATE TABLE parent (id int);
      CREATE TABLE child (extra int) INHERITS (parent);
      CREATE TABLE part (id int, d date) PARTITION BY RANGE (d);
    `);
    expect(schema.models).toHaveLength(3);
    expect(schema.warnings.join('\n')).toContain('INHERITS');
    expect(schema.warnings.join('\n')).toContain('partitioning');
  });
});

describe('naming', () => {
  it('turns table names into singular PascalCase model names and keeps the table name', () => {
    const schema: IrSchema = parse(`
      CREATE TABLE users (id int PRIMARY KEY);
      CREATE TABLE blog_categories (id int PRIMARY KEY);
      CREATE TABLE "OrderItems" (id int PRIMARY KEY);
      CREATE TABLE status (id int PRIMARY KEY);
      CREATE TABLE "2fa codes" (id int PRIMARY KEY);
      CREATE TABLE "---" (id int PRIMARY KEY);
    `);
    expect(
      schema.models.map((item: IrModel) => [item.name, item.tableName])
    ).toEqual([
      ['User', 'users'],
      ['BlogCategory', 'blog_categories'],
      ['OrderItem', 'OrderItems'],
      ['Status', 'status'],
      ['T2faCode', '2fa codes'],
      ['Model', '---'],
    ]);
  });

  it('makes model names unique and prefixes the schema when two schemas share a table name', () => {
    const schema: IrSchema = parse(`
      CREATE TABLE a.account (id int PRIMARY KEY);
      CREATE TABLE b.account (id int PRIMARY KEY);
      CREATE TABLE accounts (id int PRIMARY KEY);
    `);
    expect(schema.models.map((item: IrModel) => item.name)).toEqual([
      'Account',
      'BAccount',
      'Account2',
    ]);
    expect(schema.models.map((item: IrModel) => item.schema)).toEqual([
      'a',
      'b',
      undefined,
    ]);
  });

  it('keeps a schema other than public, dbo and main and resolves references across schemas', () => {
    const schema: IrSchema = parse(`
      CREATE TABLE public.p (id int PRIMARY KEY);
      CREATE TABLE auth.u (id int PRIMARY KEY, p_id int REFERENCES public.p (id), q_id int REFERENCES p (id));
    `);
    expect(model(schema, 'P').schema).toBeUndefined();
    expect(model(schema, 'U').schema).toBe('auth');
    expect(relation(schema, 'U', 'p').targetModel).toBe('P');
    expect(relation(schema, 'U', 'q').targetModel).toBe('P');
  });

  it('drops the database qualifier of MySQL names', () => {
    const schema: IrSchema = parse(
      'CREATE TABLE `shop`.`items` (`id` int PRIMARY KEY); CREATE TABLE `orders` (`id` int PRIMARY KEY, `item_id` int REFERENCES `shop`.`items` (`id`));',
      'mysql'
    );
    expect(model(schema, 'Item').schema).toBeUndefined();
    expect(relation(schema, 'Order', 'item').targetModel).toBe('Item');
  });

  it('makes odd column names usable as field names and keeps the column name', () => {
    const schema: IrSchema = parse(
      `CREATE TABLE t (id int PRIMARY KEY, "Created At" text, "a-b" text, "a b" text, "1st" text);`
    );
    expect(
      model(schema, 'T').fields.map((item: IrField) => [
        item.name,
        item.columnName,
      ])
    ).toEqual([
      ['id', 'id'],
      ['Created_At', 'Created At'],
      ['a_b', 'a-b'],
      ['a_b_2', 'a b'],
      ['c_1st', '1st'],
    ]);
  });

  it('uses the app label option on every model', () => {
    const result = expectOk(
      parseSqlDdl(
        [{ path: 'x.sql', text: 'CREATE TABLE t (id int PRIMARY KEY);' }],
        {
          appLabel: 'shop',
        }
      )
    );
    expect(model(result, 'T').appLabel).toBe('shop');
  });
});

describe('statement syntax variety', () => {
  it('reads IF NOT EXISTS, the first definition wins, and a duplicate without it warns', () => {
    const schema: IrSchema = parse(`
      CREATE TABLE IF NOT EXISTS t (id int PRIMARY KEY, a int);
      CREATE TABLE IF NOT EXISTS t (id int PRIMARY KEY, b int);
    `);
    expect(model(schema, 'T').fields.map((item: IrField) => item.name)).toEqual(
      ['id', 'a']
    );
    const twice: IrSchema = parse(`
      CREATE TABLE t (id int PRIMARY KEY, a int);
      CREATE TABLE t (id int PRIMARY KEY, b int);
    `);
    expect(model(twice, 'T').fields.map((item: IrField) => item.name)).toEqual([
      'id',
      'b',
    ]);
    expect(twice.warnings.join('\n')).toContain('created twice');
  });

  it('reads constraint names on columns, in any order of clauses', () => {
    const schema: IrSchema = parse(`
      CREATE TABLE t (
        id int CONSTRAINT t_pk PRIMARY KEY,
        a int CONSTRAINT a_nn NOT NULL CONSTRAINT a_def DEFAULT 1 CONSTRAINT a_chk CHECK (a > 0),
        b int NOT NULL REFERENCES t (id) ON DELETE CASCADE
      );
    `);
    expect(model(schema, 'T').primaryKeyName).toBe('t_pk');
    expect(field(schema, 'T', 'a')).toMatchObject({
      isNullable: false,
      default: { kind: 'literal', value: 1 },
    });
    expect(relation(schema, 'T', 'b').onDelete).toBe('cascade');
  });

  it('reads SQLite rowid keys, AUTOINCREMENT, WITHOUT ROWID and columns without a type', () => {
    const schema: IrSchema = parse(
      `CREATE TABLE a (id INTEGER PRIMARY KEY, n TEXT);
       CREATE TABLE b (id INTEGER PRIMARY KEY AUTOINCREMENT);
       CREATE TABLE c (id INTEGER PRIMARY KEY, n TEXT) WITHOUT ROWID;
       CREATE TABLE d (k TEXT PRIMARY KEY NOT NULL, v) WITHOUT ROWID;
       CREATE TABLE e (id INT PRIMARY KEY);
       CREATE TABLE f (id integer PRIMARY KEY ON CONFLICT REPLACE, n);`,
      'sqlite'
    );
    expect(field(schema, 'A', 'id').default).toEqual({ kind: 'autoIncrement' });
    expect(field(schema, 'B', 'id').default).toEqual({ kind: 'autoIncrement' });
    expect(field(schema, 'C', 'id').default).toBeUndefined();
    expect(field(schema, 'D', 'v')).toMatchObject({
      type: 'bytes',
      isNullable: true,
    });
    expect(field(schema, 'E', 'id').default).toBeUndefined();
    expect(field(schema, 'F', 'id').default).toEqual({ kind: 'autoIncrement' });
  });

  it('reads SQL Server constraint clauses: WITH (...), ON [PRIMARY], IDENTITY seeds, NOT FOR REPLICATION', () => {
    const schema: IrSchema = parse(
      `CREATE TABLE [dbo].[t](
        [id] [int] IDENTITY(5,2) NOT FOR REPLICATION NOT NULL,
        [n] [varchar](10) COLLATE Latin1_General_CI_AS NOT NULL,
        CONSTRAINT [pk_t] PRIMARY KEY CLUSTERED ([id] ASC) WITH (PAD_INDEX = OFF, IGNORE_DUP_KEY = OFF) ON [PRIMARY],
        CONSTRAINT [uq_t] UNIQUE NONCLUSTERED ([n]) ON [PRIMARY]
      ) ON [PRIMARY] TEXTIMAGE_ON [PRIMARY]
      GO`
    );
    expect(field(schema, 'T', 'id')).toMatchObject({
      isPrimaryKey: true,
      default: { kind: 'autoIncrement' },
    });
    expect(field(schema, 'T', 'n')).toMatchObject({
      isUnique: true,
      uniqueName: 'uq_t',
      maxLength: 10,
    });
  });

  it('reads MySQL column options: COMMENT, COLLATE, CHARACTER SET, invisible columns, UNSIGNED ZEROFILL', () => {
    const schema: IrSchema = parse(
      "CREATE TABLE t (id int unsigned NOT NULL AUTO_INCREMENT COMMENT 'pk', n varchar(5) CHARACTER SET latin1 COLLATE latin1_bin NOT NULL COMMENT 'name', PRIMARY KEY (id)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='x';",
      'mysql'
    );
    expect(field(schema, 'T', 'n')).toMatchObject({
      type: 'string',
      maxLength: 5,
      isNullable: false,
    });
    expect(field(schema, 'T', 'id').isPrimaryKey).toBe(true);
    expect(schema.warnings).toEqual([]);
  });

  it('reads an inline column PRIMARY KEY in MySQL written as KEY and a PRIMARY KEY USING BTREE', () => {
    const schema: IrSchema = parse(
      'CREATE TABLE t (id int NOT NULL, PRIMARY KEY USING BTREE (id));',
      'mysql'
    );
    expect(field(schema, 'T', 'id').isPrimaryKey).toBe(true);
  });

  it('accepts a dialect option that overrides the guess', () => {
    const text: string = 'CREATE TABLE t (id int PRIMARY KEY, f tinyint(1));';
    expect(field(parse(text, 'postgresql'), 'T', 'f').type).toBe('int');
    expect(field(parse(text, 'mysql'), 'T', 'f').type).toBe('boolean');
  });

  it('reads several files as one schema in order, each with its own dialect', () => {
    const schema: IrSchema = expectOk(
      parseSqlDdl(
        [
          { path: '001.sql', text: 'CREATE TABLE a (id serial PRIMARY KEY);' },
          {
            path: '002.sql',
            text: 'CREATE TABLE `b` (`id` int AUTO_INCREMENT, `a_id` int, PRIMARY KEY (`id`), FOREIGN KEY (`a_id`) REFERENCES `a` (`id`)) ENGINE=InnoDB;',
          },
          { path: '003.sql', text: 'ALTER TABLE a ADD COLUMN label text;' },
        ],
        { appLabel: 'app' }
      )
    );
    expect(relation(schema, 'B', 'a').targetModel).toBe('A');
    expect(field(schema, 'A', 'label').type).toBe('text');
  });
});

describe('invalid and unusual input', () => {
  it.each([
    ['empty input', ''],
    ['only whitespace', '  \n\t\r\n'],
    ['only comments', '-- nothing here\n/* at all */'],
    ['no tables', 'SELECT 1; INSERT INTO t VALUES (1);'],
    ['prose', 'This is not SQL at all, just a sentence.'],
    ['JSON', '{"models": [1, 2, 3]}'],
    [
      'a python file',
      'class Foo(models.Model):\n    name = models.CharField(max_length=3)\n',
    ],
    ['binary', '\u0000\u0001\u0002��\u007f'],
  ])('answers %s with NO_MODELS_FOUND instead of throwing', (_label, text) => {
    const result: Result<IrSchema> = parseResult(text);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('NO_MODELS_FOUND');
      expect(result.error.message).toContain('CREATE TABLE');
    }
  });

  it('answers a source list without files with NO_MODELS_FOUND', () => {
    const result = parseSqlDdl([], { appLabel: 'app' });
    expect(result.ok).toBe(false);
  });

  it('reads what it can from broken statements and warns instead of failing', () => {
    const schema: IrSchema = parse(`
      CREATE TABLE ok_one (id int PRIMARY KEY);
      CREATE TABLE ;
      CREATE TABLE no_columns;
      CREATE TABLE half (id int PRIMARY KEY, name varchar(10
      CREATE TABLE ok_two (id int PRIMARY KEY, , , x int,);
      CREATE INDEX;
      ALTER TABLE;
      ALTER TABLE ok_one ADD;
      ALTER TABLE ok_one ADD CONSTRAINT;
      CREATE TYPE x AS ENUM (;
      CREATE TABLE ok_three (id int PRIMARY KEY, 5 int, "" text, FOREIGN KEY, FOREIGN KEY (id));
      DROP;
      DROP TABLE;
    `);
    expect(schema.models.map((item: IrModel) => item.name)).toContain('OkOne');
    expect(Array.isArray(schema.warnings)).toBe(true);
  });

  it('survives truncation of every fixture at many offsets', () => {
    for (const name of [
      'postgresql/blog.sql',
      'mysql/blog.sql',
      'sqlite/blog.sql',
      'sqlserver/blog.sql',
    ]) {
      const text: string = readFixture(FIXTURES, name).text;
      for (let end: number = 0; end <= text.length; end += 37) {
        expect(() => parseResult(text.slice(0, end))).not.toThrow();
      }
    }
    for (const name of [
      'shop.pg.sql',
      'forum.mysql.sql',
      'notes.sqlite.sql',
      'inventory.sqlserver.sql',
    ]) {
      const text: string = readFixture(EXTRAS, name).text;
      for (let end: number = 0; end <= text.length; end += 41) {
        expect(() => parseResult(text.slice(0, end))).not.toThrow();
      }
    }
  });

  it('survives random token soup in every dialect', () => {
    const pieces: string[] = [
      'CREATE',
      'TABLE',
      'INDEX',
      'UNIQUE',
      'ON',
      'ALTER',
      'ADD',
      'CONSTRAINT',
      'PRIMARY',
      'KEY',
      'FOREIGN',
      'REFERENCES',
      'CHECK',
      'DEFAULT',
      'NOT',
      'NULL',
      'TYPE',
      'AS',
      'ENUM',
      'GENERATED',
      'ALWAYS',
      'IDENTITY',
      '(',
      ')',
      ',',
      ';',
      "'",
      '"',
      '`',
      '[',
      ']',
      '$$',
      '$a$',
      '--',
      '/*',
      '*/',
      '::',
      'x',
      'y_1',
      '12',
      '1.5e',
      'varchar',
      'int',
      'GO',
      'DELIMITER',
      '\n',
      ' ',
      '\\',
      '.',
    ];
    let seed: number = 12345;
    const random = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed;
    };
    for (const dialect of [
      'postgresql',
      'mysql',
      'sqlite',
      'sqlserver',
    ] as SqlDialect[]) {
      for (let round: number = 0; round < 150; round += 1) {
        let text: string = '';
        const count: number = 5 + (random() % 80);
        for (let at: number = 0; at < count; at += 1) {
          text += `${pieces[random() % pieces.length] ?? ''} `;
        }
        expect(() => parseResult(text, dialect)).not.toThrow();
      }
    }
  });
});

describe('hostile input', () => {
  const LIMIT: number = 30_000;

  /** Runs a parse and checks that it returns (a Result, never an exception) in reasonable time. */
  function parseQuickly(text: string, dialect?: SqlDialect): Result<IrSchema> {
    const started: number = Date.now();
    const result: Result<IrSchema> = parseResult(text, dialect);
    expect(Date.now() - started).toBeLessThan(15_000);
    return result;
  }

  it(
    'reads very deeply nested parentheses without overflowing the stack',
    () => {
      const depth: number = 200_000;
      const nested: string = '('.repeat(depth) + '1' + ')'.repeat(depth);
      const text: string = `CREATE TABLE t (id int PRIMARY KEY, a int DEFAULT ${nested}, b int CHECK ${nested}, c ${'varchar' + nested});
      CREATE INDEX i ON t ${nested};
      CREATE TABLE u (id int PRIMARY KEY);`;
      const result: Result<IrSchema> = parseQuickly(text);
      expect(result.ok).toBe(true);
    },
    LIMIT
  );

  it(
    'reads unbalanced parentheses',
    () => {
      expect(parseQuickly('CREATE TABLE t ' + '('.repeat(100_000)).ok).toBe(
        true
      );
      expect(
        parseQuickly('CREATE TABLE t (id int PRIMARY KEY' + ')'.repeat(100_000))
          .ok
      ).toBe(true);
    },
    LIMIT
  );

  it(
    'reads a very long run of unterminated strings, identifiers and comments',
    () => {
      for (const opener of [
        "'",
        '"',
        '`',
        '[',
        '/*',
        '$$',
        '$a$',
        '--',
        "E'",
      ]) {
        for (const dialect of [
          'postgresql',
          'mysql',
          'sqlserver',
        ] as SqlDialect[]) {
          expect(() =>
            parseQuickly(
              `CREATE TABLE t (id int); ${opener}${'x'.repeat(500_000)}`,
              dialect
            )
          ).not.toThrow();
        }
      }
    },
    LIMIT
  );

  it(
    'does not take quadratic time for many unmatched openers',
    () => {
      for (const opener of ['$a$ ', '[ ', '/* ', "' ", '( ']) {
        expect(() =>
          parseQuickly(opener.repeat(200_000), 'postgresql')
        ).not.toThrow();
        expect(() =>
          parseQuickly(opener.repeat(200_000), 'sqlserver')
        ).not.toThrow();
      }
      const tags: string = Array.from(
        { length: 50_000 },
        (_, index) => `$t${index}$ `
      ).join('');
      expect(() => parseQuickly(tags, 'postgresql')).not.toThrow();
    },
    LIMIT
  );

  it(
    'reads a table with a huge number of columns, enum members and index columns',
    () => {
      const columns: number = 50_000;
      const body: string = Array.from(
        { length: columns },
        (_, index) => `c${index} int`
      ).join(', ');
      const members: string = Array.from(
        { length: columns },
        (_, index) => `'v${index}'`
      ).join(', ');
      const text: string = `CREATE TYPE big AS ENUM (${members});
      CREATE TABLE t (id int PRIMARY KEY, ${body});
      CREATE INDEX wide ON t (${Array.from({ length: columns }, (_, index) => `c${index}`).join(', ')});`;
      const result: Result<IrSchema> = parseQuickly(text);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(model(result.value, 'T').fields).toHaveLength(columns + 1);
        expect(enumNamed(result.value, 'Big').values).toHaveLength(columns);
      }
    },
    LIMIT
  );

  it(
    'reads thousands of tables that reference each other',
    () => {
      const count: number = 5_000;
      const text: string = Array.from(
        { length: count },
        (_, index) =>
          `CREATE TABLE t${index} (id int PRIMARY KEY, next_id int REFERENCES t${(index + 1) % count} (id), prev_id int REFERENCES t${(index + count - 1) % count});`
      ).join('\n');
      const result: Result<IrSchema> = parseQuickly(text);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.models).toHaveLength(count);
      }
    },
    LIMIT
  );

  it(
    'stays linear when many names clash, many keys point at one table and one enum grows',
    () => {
      const count: number = 30_000;
      // Distinct punctuation runs: different quoted names that read the same once cleaned up.
      const punctuation = (index: number): string => {
        const marks: string = '-~!@#%';
        let rest: number = index;
        let run: string = '';
        do {
          run += marks.charAt(rest % marks.length);
          rest = Math.floor(rest / marks.length);
        } while (rest > 0);
        return run;
      };
      const clashing: string = Array.from(
        { length: count },
        (_, index) => `"a${punctuation(index)}" int`
      ).join(', ');
      const keyColumns: string = Array.from(
        { length: count },
        (_, index) => `k${index} int`
      ).join(', ');
      const keyList: string = Array.from(
        { length: count },
        (_, index) => `k${index}`
      ).join(', ');
      const references: string = Array.from(
        { length: count },
        (_, index) => `r${index} int REFERENCES target (id)`
      ).join(', ');
      const alterTypes: string = Array.from(
        { length: count },
        (_, index) =>
          `ALTER TYPE e ADD VALUE 'v${index}' AFTER 'v${index - 1}';`
      ).join('\n');
      const sameModelName: string = Array.from(
        { length: count },
        (_, index) => `CREATE TABLE "t${punctuation(index)}" (id int);`
      ).join('\n');
      const text: string = `
        CREATE TYPE e AS ENUM ('v-1');
        ${alterTypes}
        CREATE TABLE target (id int PRIMARY KEY);
        CREATE TABLE clashing (id int PRIMARY KEY, ${clashing});
        CREATE TABLE wide (${keyColumns}, ${references}, PRIMARY KEY (${keyList}), UNIQUE (${keyList}));
        CREATE INDEX wide_idx ON wide (${keyList});
        ${sameModelName}`;
      const result: Result<IrSchema> = parseQuickly(text);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(model(result.value, 'Clashing').fields).toHaveLength(count + 1);
        expect(result.value.models.length).toBeGreaterThan(count);
      }
    },
    LIMIT
  );

  it(
    'caps the number of warnings',
    () => {
      const text: string =
        'CREATE TABLE t (id int PRIMARY KEY);\n' +
        Array.from(
          { length: 5_000 },
          (_, index) => `CREATE INDEX i${index} ON t (nope${index});`
        ).join('\n');
      const result: Result<IrSchema> = parseQuickly(text);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.warnings.length).toBeLessThan(450);
        expect(result.value.warnings[result.value.warnings.length - 1]).toMatch(
          /more warnings were not shown/
        );
      }
    },
    LIMIT
  );

  it(
    'rejects input above the size limit with a clear error',
    () => {
      const result: Result<IrSchema> = parseSqlDdl(
        [{ path: 'huge.sql', text: ' '.repeat(33_000_000) }],
        { appLabel: 'app' }
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('PARSE_FAILED');
        expect(result.error.message).toContain('too large');
      }
    },
    LIMIT
  );

  it(
    'reads a megabytes-long single line and very long identifiers',
    () => {
      const name: string = 'a'.repeat(1_000_000);
      const result: Result<IrSchema> = parseQuickly(
        `CREATE TABLE ${name} (id int PRIMARY KEY, ${name}x int);${' '.repeat(2_000_000)}`
      );
      expect(result.ok).toBe(true);
    },
    LIMIT
  );

  it('reads Windows line endings, a byte order mark, NUL bytes and lone surrogates', () => {
    const text: string =
      '﻿CREATE TABLE t (\r\n  id int PRIMARY KEY,\r\n  \u0000n text\ud800\r\n);\r\n';
    expect(parseQuickly(text).ok).toBe(true);
  });
});

describe('extras fixture', () => {
  const goldenDirectory: string = fileURLToPath(
    new URL('./golden-extras/', import.meta.url)
  );

  function expectMatchesExtrasGolden(name: string, actual: string): void {
    const goldenPath: string = `${goldenDirectory}${name}`;
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

  // Relative paths keep the warnings (and so the golden) independent of where the repository is checked out.
  const names: string[] = [
    'shop.pg.sql',
    'forum.mysql.sql',
    'notes.sqlite.sql',
    'inventory.sqlserver.sql',
  ];
  const sources = names.map((name: string) => ({
    path: name,
    text: readFixture(EXTRAS, name).text,
  }));
  const schema: IrSchema = expectOk(parseSqlDdl(sources, { appLabel: 'shop' }));

  async function convertExtras(to: string): Promise<ConvertResult> {
    return expectOk(
      await convertText(sources, {
        ...DEFAULT_OPTIONS,
        appLabel: 'shop',
        from: 'sql',
        to,
      })
    );
  }

  it('reads PostgreSQL enums, schemas, arrays, ranges, generated columns and composite keys', () => {
    expect(
      enumNamed(schema, 'OrderState').values.map((item) => item.dbValue)
    ).toEqual(['new', 'paid', 'refunded', 'shipped', 'cancelled']);
    expect(model(schema, 'Invoice').schema).toBe('billing');
    expect(field(schema, 'Customer', 'tags')).toMatchObject({
      type: 'text',
      arrayDepth: 1,
    });
    expect(field(schema, 'Customer', 'scores')).toMatchObject({
      type: 'int',
      arrayDepth: 2,
    });
    expect(field(schema, 'Customer', 'active_during')).toMatchObject({
      type: 'range',
      rangeOf: 'date',
    });
    expect(field(schema, 'Customer', 'location').type).toBe('unsupported');
    expect(field(schema, 'Customer', 'Signed_Up_At').columnName).toBe(
      'Signed Up At'
    );
    expect(field(schema, 'Order', 'total').generated).toEqual({
      expression: 'subtotal + tax',
      isStored: true,
    });
    expect(model(schema, 'OrderItem').compositePrimaryKey).toEqual([
      'order',
      'line_no',
    ]);
    expect(model(schema, 'PriceNote').compositeForeignKeys?.[0]).toMatchObject({
      targetModel: 'ProductPrice',
      fields: ['region', 'sku'],
      onDelete: 'cascade',
    });
    expect(relation(schema, 'Newsletter', 'customer').toField).toBe('email');
    expect(relation(schema, 'CustomerProfile', 'customer')).toMatchObject({
      isPrimaryKey: true,
      kind: 'oneToOne',
    });
    expect(relation(schema, 'Customer', 'favourites').kind).toBe('manyToMany');
    expect(field(schema, 'PriceNote', 'id').default).toEqual({
      kind: 'autoIncrement',
    });
    expect(model(schema, 'Customer').indexes).toEqual([
      {
        fields: ['tags'],
        isUnique: false,
        name: 'customers_tags_idx',
        method: 'Gin',
      },
    ]);
  });

  it('reads MySQL enums, sets, unsigned columns, prefix indexes and the DELIMITER trigger', () => {
    expect(enumNamed(schema, 'ForumUserRole').values).toHaveLength(3);
    expect(field(schema, 'ForumUser', 'id')).toMatchObject({
      type: 'bigInt',
      default: { kind: 'autoIncrement' },
    });
    expect(field(schema, 'ForumUser', 'active').default).toEqual({
      kind: 'literal',
      value: true,
    });
    expect(field(schema, 'ForumUser', 'last_seen').isAutoUpdated).toBe(true);
    expect(field(schema, 'ForumUser', 'quote').default).toEqual({
      kind: 'literal',
      value: "he said 'hi'",
    });
    expect(field(schema, 'ForumThread', 'pinned').type).toBe('boolean');
    expect(schema.models.map((item: IrModel) => item.tableName)).not.toContain(
      'ignored_inside_trigger'
    );
    expect(relation(schema, 'ForumUser', 'followees')).toMatchObject({
      kind: 'manyToMany',
      relatedName: 'followers',
    });
  });

  it('reads SQLite affinity types, WITHOUT ROWID tables, generated columns and check enums', () => {
    expect(field(schema, 'Note', 'kind').enumName).toBe('NoteKind');
    expect(field(schema, 'Note', 'flags').type).toBe('bigInt');
    expect(field(schema, 'Note', 'word_count').generated).toEqual({
      expression: 'length(body)',
      isStored: false,
    });
    expect(field(schema, 'Tag', 'name').isPrimaryKey).toBe(true);
    expect(relation(schema, 'Note', 'tag').kind).toBe('manyToMany');
    expect(field(schema, 'Notebook', 'created').default).toEqual({
      kind: 'now',
    });
  });

  it('reads SQL Server schemas, identity seeds, computed columns and DEFAULT ... FOR', () => {
    expect(model(schema, 'Warehouse').schema).toBe('inv');
    expect(field(schema, 'Item', 'ItemId')).toMatchObject({
      type: 'bigInt',
      default: { kind: 'autoIncrement' },
    });
    expect(field(schema, 'Item', 'Qty').default).toEqual({
      kind: 'literal',
      value: 0,
    });
    expect(field(schema, 'Item', 'Added').default).toEqual({ kind: 'now' });
    expect(field(schema, 'Item', 'Kind').enumName).toBe('ItemKind');
    expect(relation(schema, 'Item', 'Warehouse').onDelete).toBe('cascade');
    expect(
      model(schema, 'Item').fields.map((item: IrField) => item.name)
    ).not.toContain('Total');
  });

  it('matches the Prisma golden', async () => {
    const result: ConvertResult = await convertExtras('prisma');
    expectMatchesExtrasGolden('sql-to-prisma.txt', result.output);
  });

  it('matches the Django golden', async () => {
    const result: ConvertResult = await convertExtras('django');
    expectMatchesExtrasGolden('sql-to-django.txt', result.output);
  });

  it('matches the warnings golden', async () => {
    const result: ConvertResult = await convertExtras('prisma');
    expectMatchesExtrasGolden(
      'sql-warnings.txt',
      result.warnings.map((warning: string) => `${warning}\n`).join('')
    );
  });
});

describe('reading from disk', () => {
  const created: string[] = [];

  afterEach(() => {
    for (const directory of created.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  function scratchDirectory(): string {
    const directory: string = mkdtempSync(join(tmpdir(), 'ormbridge-sql-'));
    created.push(directory);
    return directory;
  }

  it('reads every .sql file of a directory in name order and skips rollbacks and tool directories', async () => {
    const directory: string = scratchDirectory();
    mkdirSync(join(directory, 'migrations'));
    mkdirSync(join(directory, 'node_modules'));
    writeFileSync(
      join(directory, 'migrations', '001_create_a.sql'),
      'CREATE TABLE a (id serial PRIMARY KEY);'
    );
    writeFileSync(
      join(directory, 'migrations', '001_create_a.down.sql'),
      'DROP TABLE a;'
    );
    writeFileSync(
      join(directory, 'migrations', '002_create_b.sql'),
      'CREATE TABLE b (id serial PRIMARY KEY, a_id int REFERENCES a (id));'
    );
    writeFileSync(
      join(directory, 'migrations', '003_undo.sql'),
      'DROP TABLE b;'
    );
    writeFileSync(join(directory, 'migrations', 'down.sql'), 'DROP TABLE b;');
    writeFileSync(
      join(directory, 'node_modules', 'bad.sql'),
      'CREATE TABLE evil (id int);'
    );
    writeFileSync(join(directory, 'notes.txt'), 'ignored');
    const summary = expectOk(
      await runConversion({
        ...DEFAULT_OPTIONS,
        inputs: [directory],
        from: 'sql',
        to: 'prisma',
      })
    );
    expect(
      summary.inputFiles.map((path: string) => path.slice(directory.length + 1))
    ).toEqual([
      join('migrations', '001_create_a.sql'),
      join('migrations', '002_create_b.sql'),
    ]);
    expect(summary.modelCount).toBe(2);
    expect(summary.output).toContain('model A');
  });

  it('infers the sql format from the .sql extension of a file', async () => {
    const directory: string = scratchDirectory();
    const path: string = join(directory, 'schema.sql');
    writeFileSync(path, readFixture(FIXTURES, 'postgresql/blog.sql').text);
    const summary = expectOk(
      await runConversion({
        ...DEFAULT_OPTIONS,
        inputs: [path],
        from: 'sql',
        to: 'typescript',
      })
    );
    expect(summary.modelCount).toBe(5);
  });

  it('names the expected files when a directory has none', async () => {
    const directory: string = scratchDirectory();
    writeFileSync(join(directory, 'readme.md'), '# nothing');
    const result = await runConversion({
      ...DEFAULT_OPTIONS,
      inputs: [directory],
      from: 'sql',
      to: 'prisma',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('NO_INPUT_FILES');
      expect(result.error.message).toContain('SQL');
    }
  });
});
