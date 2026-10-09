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
  IrField,
  IrIndex,
  IrModel,
  IrRelation,
  IrSchema,
} from '../src/ir.js';
import { runConversion } from '../src/io.js';
import {
  gormColumnName,
  gormTableName,
  parseGorm,
  type GormSourceFile,
} from '../src/parsers/gorm.js';
import { DEFAULT_OPTIONS, expectOk } from './helpers.js';

const HEADER: string = `package models

import (
	"database/sql"
	"time"

	"github.com/google/uuid"
	"github.com/shopspring/decimal"
	"gorm.io/datatypes"
	"gorm.io/gorm"
)

`;

/** Parses Go declarations in one file; the package clause and the common imports are added. */
async function parse(...texts: string[]): Promise<IrSchema> {
  const sources: GormSourceFile[] = texts.map(
    (text: string, index: number): GormSourceFile => ({
      path: `file${index}.go`,
      text: index === 0 ? HEADER + text : `package models\n${text}`,
    })
  );
  return expectOk(await parseGorm(sources, { appLabel: 'app' }));
}

function model(schema: IrSchema, name: string): IrModel {
  const found: IrModel | undefined = schema.models.find(
    (candidate: IrModel) => candidate.name === name
  );
  if (found === undefined) {
    throw new Error(`Model ${name} was not parsed`);
  }
  return found;
}

function field(schema: IrSchema, modelName: string, name: string): IrField {
  const found: IrField | undefined = model(schema, modelName).fields.find(
    (candidate: IrField) => candidate.name === name
  );
  if (found === undefined) {
    throw new Error(`Field ${modelName}.${name} was not parsed`);
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
    throw new Error(`Relation ${modelName}.${name} was not parsed`);
  }
  return found;
}

function warningsMatching(schema: IrSchema, text: string): string[] {
  return schema.warnings.filter((warning: string) => warning.includes(text));
}

describe('gorm adapter registration', () => {
  it('is registered as a readable and writable format that does not claim .go', () => {
    const adapter = expectOk(getFormat('gorm'));
    expect(adapter.parse).toBeDefined();
    expect(adapter.emit).toBeDefined();
    expect(adapter.extensions).toEqual([]);
    expect(getFormatByExtension('.go')).toBeUndefined();
  });

  it('converts through convertText', async () => {
    const result = expectOk(
      await convertText(
        [
          {
            path: 'user.go',
            text: `package models

type User struct {
	ID   uint   \`gorm:"primaryKey"\`
	Name string \`gorm:"size:40;not null"\`
}
`,
          },
        ],
        { ...DEFAULT_OPTIONS, from: 'gorm', to: 'prisma' }
      )
    );
    expect(result.modelCount).toBe(1);
    expect(result.output).toContain('model User {');
    expect(result.output).toContain('@db.VarChar(40)');
  });

  it('fails with a descriptive error when no model is found', async () => {
    const result = await parseGorm(
      [{ path: 'dto.go', text: 'package x\ntype Dto struct { Name string }' }],
      { appLabel: 'app' }
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('NO_MODELS_FOUND');
      expect(result.error.message).toContain('dto.go');
      expect(result.error.message).toContain('embeds gorm.Model');
    }
  });
});

describe('directory input', () => {
  const created: string[] = [];
  afterEach(() => {
    for (const directory of created.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('reads every .go file of the fixture folder with --from gorm', async () => {
    const directory: string = fileURLToPath(
      new URL('./fixtures/gorm', import.meta.url)
    );
    const summary = expectOk(
      await runConversion({
        ...DEFAULT_OPTIONS,
        from: 'gorm',
        to: 'prisma',
        inputs: [directory],
      })
    );
    expect(summary.modelCount).toBe(5);
    expect(summary.warnings).toEqual([]);
    expect(summary.inputFiles).toHaveLength(7);
  });

  it('skips vendor/, testdata/ and *_test.go files', async () => {
    const root: string = mkdtempSync(join(tmpdir(), 'ormbridge-gorm-'));
    created.push(root);
    mkdirSync(join(root, 'vendor', 'dep'), { recursive: true });
    mkdirSync(join(root, 'testdata'));
    writeFileSync(
      join(root, 'user.go'),
      'package m\ntype User struct { ID uint `gorm:"primaryKey"` }\n'
    );
    writeFileSync(
      join(root, 'user_test.go'),
      'package m\ntype Fake struct { ID uint `gorm:"primaryKey"` }\n'
    );
    writeFileSync(
      join(root, 'vendor', 'dep', 'dep.go'),
      'package dep\ntype Vendored struct { ID uint `gorm:"primaryKey"` }\n'
    );
    writeFileSync(
      join(root, 'testdata', 'data.go'),
      'package d\ntype Data struct { ID uint `gorm:"primaryKey"` }\n'
    );
    const summary = expectOk(
      await runConversion({
        ...DEFAULT_OPTIONS,
        from: 'gorm',
        to: 'prisma',
        inputs: [root],
      })
    );
    expect(summary.modelCount).toBe(1);
    expect(summary.inputFiles).toHaveLength(1);
  });

  it('names the expected files when a directory has no Go files', async () => {
    const root: string = mkdtempSync(join(tmpdir(), 'ormbridge-gorm-'));
    created.push(root);
    const result = await runConversion({
      ...DEFAULT_OPTIONS,
      from: 'gorm',
      to: 'prisma',
      inputs: [root],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('NO_INPUT_FILES');
      expect(result.error.message).toContain('Go (.go) model files');
    }
  });
});

describe('GORM naming conventions', () => {
  it.each([
    ['ID', 'id'],
    ['UserID', 'user_id'],
    ['PublicID', 'public_id'],
    ['CreatedAt', 'created_at'],
    ['HTTPServer', 'http_server'],
    ['APIKey', 'api_key'],
    ['OAuth2Token', 'o_auth2_token'],
    ['Name', 'name'],
    ['SKU', 'sku'],
  ])('maps the field %s to the column %s', (goName: string, column: string) => {
    expect(gormColumnName(goName)).toBe(column);
  });

  it.each([
    ['User', 'users'],
    ['Category', 'categories'],
    ['Person', 'people'],
    ['Status', 'statuses'],
    ['Address', 'addresses'],
    ['PostTag', 'post_tags'],
    ['Child', 'children'],
    ['Box', 'boxes'],
    ['Wolf', 'wolves'],
    ['Series', 'series'],
    ['Data', 'data'],
    ['Index', 'indices'],
    ['Day', 'days'],
  ])(
    'maps the struct %s to the table %s',
    (structName: string, table: string) => {
      expect(gormTableName(structName)).toBe(table);
    }
  );

  it('uses the conventional table, column and key names without any tags', async () => {
    const schema: IrSchema = await parse(`
type BlogPost struct {
	ID        uint
	AuthorID  uint
	Author    User
	PublicURL string
}
type User struct {
	ID uint
	BlogPosts []BlogPost \`gorm:"foreignKey:AuthorID"\`
}
`);
    expect(model(schema, 'BlogPost').tableName).toBe('blog_posts');
    expect(field(schema, 'BlogPost', 'id').isPrimaryKey).toBe(true);
    expect(field(schema, 'BlogPost', 'publicUrl').columnName).toBe(
      'public_url'
    );
    const author: IrRelation = relation(schema, 'BlogPost', 'author');
    expect(author.columnName).toBe('author_id');
    expect(author.targetModel).toBe('User');
    expect(author.relatedName).toBe('blogPosts');
    expect(schema.warnings).toEqual([]);
  });
});

describe('column types', () => {
  it('maps Go and library types', async () => {
    const schema: IrSchema = await parse(`
type Sample struct {
	ID       uint
	Text     string
	Flag     bool
	Small    int16
	Medium   int32
	Large    int64
	Plain    int
	Unsigned uint32
	Single   float32
	Double   float64
	When     time.Time
	Wait     time.Duration
	Raw      []byte
	Key      uuid.UUID
	Money    decimal.Decimal
	Doc      datatypes.JSON
	Day      datatypes.Date
}
`);
    const types: Record<string, string> = {};
    for (const item of model(schema, 'Sample').fields) {
      types[item.name] = item.type;
    }
    expect(types).toEqual({
      id: 'bigInt',
      text: 'text',
      flag: 'boolean',
      small: 'int',
      medium: 'int',
      large: 'bigInt',
      plain: 'bigInt',
      // GORM's PostgreSQL dialect needs one more bit for unsigned types.
      unsigned: 'bigInt',
      single: 'float',
      double: 'float',
      when: 'dateTime',
      wait: 'bigInt',
      raw: 'bytes',
      key: 'uuid',
      money: 'decimal',
      doc: 'json',
      day: 'date',
    });
    expect(schema.warnings).toEqual([]);
  });

  it('reads size, precision, scale and type tags', async () => {
    const schema: IrSchema = await parse(`
type Sample struct {
	ID     uint
	Code   string          \`gorm:"size:12"\`
	Name   string          \`gorm:"type:varchar(80)"\`
	Body   string          \`gorm:"type:text"\`
	Price  decimal.Decimal \`gorm:"precision:10;scale:2"\`
	Ratio  float64         \`gorm:"precision:6;scale:3"\`
	Cost   decimal.Decimal \`gorm:"type:numeric(8,1)"\`
	Count  int             \`gorm:"size:32"\`
	Tiny   int             \`gorm:"type:smallint"\`
	Stamp  time.Time       \`gorm:"type:date"\`
	Blob   string          \`gorm:"type:jsonb"\`
	Marks  string          \`gorm:"type:text[]"\`
	Place  string          \`gorm:"type:geometry"\`
}
`);
    expect(field(schema, 'Sample', 'code')).toMatchObject({
      type: 'string',
      maxLength: 12,
    });
    expect(field(schema, 'Sample', 'name')).toMatchObject({
      type: 'string',
      maxLength: 80,
    });
    expect(field(schema, 'Sample', 'body').type).toBe('text');
    expect(field(schema, 'Sample', 'price')).toMatchObject({
      type: 'decimal',
      maxDigits: 10,
      decimalPlaces: 2,
    });
    // A float with a precision is stored as numeric(precision, scale).
    expect(field(schema, 'Sample', 'ratio')).toMatchObject({
      type: 'decimal',
      maxDigits: 6,
      decimalPlaces: 3,
    });
    expect(field(schema, 'Sample', 'cost')).toMatchObject({
      type: 'decimal',
      maxDigits: 8,
      decimalPlaces: 1,
    });
    expect(field(schema, 'Sample', 'count').type).toBe('int');
    expect(field(schema, 'Sample', 'tiny').type).toBe('int');
    expect(field(schema, 'Sample', 'stamp').type).toBe('date');
    expect(field(schema, 'Sample', 'blob').type).toBe('json');
    expect(field(schema, 'Sample', 'marks')).toMatchObject({
      type: 'text',
      arrayDepth: 1,
    });
    expect(field(schema, 'Sample', 'place')).toMatchObject({
      type: 'unsupported',
      unsupportedType: 'geometry',
    });
    expect(warningsMatching(schema, 'geometry')).toHaveLength(1);
  });

  it('reads serializers and unknown types', async () => {
    const schema: IrSchema = await parse(`
type Sample struct {
	ID    uint
	Doc   map[string]string \`gorm:"serializer:json"\`
	Items []string          \`gorm:"serializer:json"\`
	Loose map[string]int
	Tags  []string
	Other pgtype.Numeric
}
`);
    expect(field(schema, 'Sample', 'doc').type).toBe('json');
    expect(field(schema, 'Sample', 'items').type).toBe('json');
    expect(field(schema, 'Sample', 'loose').type).toBe('json');
    expect(field(schema, 'Sample', 'tags')).toMatchObject({
      type: 'text',
      arrayDepth: 1,
    });
    expect(field(schema, 'Sample', 'other')).toMatchObject({
      type: 'unsupported',
      unsupportedType: 'pgtype.Numeric',
    });
    expect(warningsMatching(schema, 'Sample.loose')).toHaveLength(0);
    expect(warningsMatching(schema, 'Sample.Loose')).toHaveLength(1);
    expect(warningsMatching(schema, 'Sample.Tags')).toHaveLength(1);
    expect(warningsMatching(schema, 'pgtype.Numeric')).toHaveLength(1);
  });

  it('ignores unexported fields and gorm:"-" fields', async () => {
    const schema: IrSchema = await parse(`
type Sample struct {
	ID       uint
	hidden   string
	Secret   string \`gorm:"-"\`
	Skipped  string \`gorm:"-:migration"\`
	ReadOnly string \`gorm:"-:write"\`
	Name     string
}
`);
    expect(model(schema, 'Sample').fields.map((item) => item.name)).toEqual([
      'id',
      'readOnly',
      'name',
    ]);
  });
});

describe('nullability', () => {
  it('reads pointers and sql.Null* types as nullable and plain types as required', async () => {
    const schema: IrSchema = await parse(`
type Sample struct {
	ID       uint
	Plain    string
	Pointer  *string
	NullStr  sql.NullString
	NullInt  sql.NullInt64
	NullTime sql.NullTime
	Generic  sql.Null[int32]
	PtrReq   *string \`gorm:"not null"\`
	Deleted  gorm.DeletedAt
	PtrTime  *time.Time
}
`);
    const nullable: Record<string, boolean> = {};
    for (const item of model(schema, 'Sample').fields) {
      nullable[item.name] = item.isNullable;
    }
    expect(nullable).toEqual({
      id: false,
      plain: false,
      pointer: true,
      nullStr: true,
      nullInt: true,
      nullTime: true,
      generic: true,
      ptrReq: false,
      deleted: true,
      ptrTime: true,
    });
    expect(field(schema, 'Sample', 'nullInt').type).toBe('bigInt');
    expect(field(schema, 'Sample', 'generic').type).toBe('int');
  });
});

describe('keys, defaults and timestamps', () => {
  it('treats ID as the primary key and auto-increments integer keys', async () => {
    const schema: IrSchema = await parse(`
type Implicit struct { ID uint; Name string }
type Explicit struct {
	Code uint \`gorm:"primaryKey;autoIncrement:false"\`
}
type Keyed struct {
	Key uuid.UUID \`gorm:"type:uuid;primaryKey;default:gen_random_uuid()"\`
}
type Serial struct {
	N int32 \`gorm:"primaryKey;type:serial"\`
}
type Manual struct {
	N int32 \`gorm:"primaryKey"\`
	M int32 \`gorm:"autoIncrement"\`
}
`);
    expect(field(schema, 'Implicit', 'id')).toMatchObject({
      isPrimaryKey: true,
      isNullable: false,
      default: { kind: 'autoIncrement' },
    });
    expect(field(schema, 'Explicit', 'code').isPrimaryKey).toBe(true);
    expect(field(schema, 'Explicit', 'code').default).toBeUndefined();
    expect(field(schema, 'Keyed', 'key').default).toEqual({ kind: 'uuid' });
    expect(field(schema, 'Serial', 'n').default).toEqual({
      kind: 'autoIncrement',
    });
    // Any integer field can ask for auto-increment.
    expect(field(schema, 'Manual', 'm').default).toEqual({
      kind: 'autoIncrement',
    });
  });

  it('reads composite primary keys', async () => {
    const schema: IrSchema = await parse(`
type Pair struct {
	A int32 \`gorm:"primaryKey"\`
	B int32 \`gorm:"primaryKey"\`
	C string
}
`);
    expect(model(schema, 'Pair').compositePrimaryKey).toEqual(['a', 'b']);
    expect(field(schema, 'Pair', 'a').isPrimaryKey).toBe(false);
    expect(field(schema, 'Pair', 'a').default).toBeUndefined();
  });

  it('warns when a struct has no primary key', async () => {
    const schema: IrSchema = await parse(
      'type Loose struct { Name string `gorm:"size:5"` }'
    );
    expect(
      warningsMatching(schema, 'Loose: the struct has no primary key')
    ).toHaveLength(1);
  });

  it('converts default values', async () => {
    const schema: IrSchema = await parse(`
type Sample struct {
	ID      uint
	Count   int32     \`gorm:"default:7"\`
	Neg     int32     \`gorm:"default:-3"\`
	Rate    float64   \`gorm:"default:1.5"\`
	On      bool      \`gorm:"default:true"\`
	Off     bool      \`gorm:"default:false"\`
	Name    string    \`gorm:"default:anon"\`
	Quoted  string    \`gorm:"default:'hello world'"\`
	Empty   string    \`gorm:"default:"\`
	Nothing *string   \`gorm:"default:null"\`
	Stamp   time.Time \`gorm:"default:CURRENT_TIMESTAMP"\`
	Now     time.Time \`gorm:"default:now()"\`
	Key     uuid.UUID \`gorm:"default:uuid_generate_v4()"\`
	Expr    string    \`gorm:"default:lower('X')"\`
	Doc     datatypes.JSON \`gorm:"default:'{}'"\`
	Cast    int32     \`gorm:"default:(1+2)"\`
}
`);
    const defaults: Record<string, unknown> = {};
    for (const item of model(schema, 'Sample').fields) {
      defaults[item.name] = item.default;
    }
    expect(defaults).toMatchObject({
      count: { kind: 'literal', value: 7 },
      neg: { kind: 'literal', value: -3 },
      rate: { kind: 'literal', value: 1.5 },
      on: { kind: 'literal', value: true },
      off: { kind: 'literal', value: false },
      name: { kind: 'literal', value: 'anon' },
      quoted: { kind: 'literal', value: 'hello world' },
      empty: undefined,
      nothing: undefined,
      stamp: { kind: 'now' },
      now: { kind: 'now' },
      key: { kind: 'uuid' },
      expr: { kind: 'dbExpression', expression: "lower('X')" },
      doc: { kind: 'literal', value: '{}' },
      cast: { kind: 'dbExpression', expression: '(1+2)' },
    });
  });

  it('applies GORM timestamp conventions and tags', async () => {
    const schema: IrSchema = await parse(`
type Stamped struct {
	ID        uint
	CreatedAt time.Time
	UpdatedAt time.Time
	Born      time.Time \`gorm:"autoCreateTime"\`
	Touched   time.Time \`gorm:"autoUpdateTime"\`
	Off       time.Time \`gorm:"autoCreateTime:false"\`
}
type Epoch struct {
	ID        uint
	CreatedAt int64
	UpdatedAt int64
}
`);
    expect(field(schema, 'Stamped', 'createdAt').default).toEqual({
      kind: 'now',
    });
    expect(field(schema, 'Stamped', 'updatedAt').isAutoUpdated).toBe(true);
    expect(field(schema, 'Stamped', 'born').default).toEqual({ kind: 'now' });
    expect(field(schema, 'Stamped', 'touched').isAutoUpdated).toBe(true);
    expect(field(schema, 'Stamped', 'off').default).toBeUndefined();
    // On an integer field the time is a Unix timestamp: a plain integer column.
    expect(field(schema, 'Epoch', 'createdAt').default).toBeUndefined();
    expect(field(schema, 'Epoch', 'updatedAt').isAutoUpdated).toBe(false);
  });

  it('reads gorm.Model and reports soft delete', async () => {
    const schema: IrSchema = await parse(`
type Account struct {
	gorm.Model
	Name string
}
`);
    expect(model(schema, 'Account').tableName).toBe('accounts');
    expect(
      model(schema, 'Account').fields.map((item: IrField) => item.name)
    ).toEqual(['id', 'createdAt', 'updatedAt', 'deletedAt', 'name']);
    expect(field(schema, 'Account', 'id')).toMatchObject({
      type: 'bigInt',
      isPrimaryKey: true,
      default: { kind: 'autoIncrement' },
    });
    expect(field(schema, 'Account', 'deletedAt').isNullable).toBe(true);
    expect(model(schema, 'Account').indexes).toEqual([
      { fields: ['deletedAt'], isUnique: false },
    ]);
    expect(warningsMatching(schema, 'soft-delete')).toHaveLength(1);
  });
});

describe('embedded structs', () => {
  it('flattens anonymous and tagged embedded structs with prefixes', async () => {
    const schema: IrSchema = await parse(`
type Base struct {
	ID        uint \`gorm:"primaryKey"\`
	CreatedAt time.Time
}
type Address struct {
	Street string \`gorm:"column:road"\`
	City   string
}
type Company struct {
	Base
	Name    string
	Home    Address \`gorm:"embedded;embeddedPrefix:home_"\`
	Work    Address \`gorm:"embedded"\`
	Created string
}
`);
    expect(
      model(schema, 'Company').fields.map((item: IrField) => item.name)
    ).toEqual([
      'id',
      'createdAt',
      'name',
      'homeStreet',
      'homeCity',
      // Work has no prefix and Home's fields are named after it, so Work's fields keep their own names.
      'street',
      'city',
      'created',
    ]);
    expect(field(schema, 'Company', 'homeStreet').columnName).toBe('home_road');
    expect(field(schema, 'Company', 'street').columnName).toBe('road');
    // A struct that is only embedded is not a model of its own.
    expect(schema.models.map((item: IrModel) => item.name)).toEqual([
      'Company',
    ]);
  });

  it('lets a field of the model shadow a promoted field', async () => {
    const schema: IrSchema = await parse(`
type Base struct {
	ID   uint \`gorm:"primaryKey"\`
	Name string \`gorm:"size:10"\`
}
type Thing struct {
	Base
	Name string \`gorm:"size:20"\`
}
`);
    expect(field(schema, 'Thing', 'name').maxLength).toBe(20);
    expect(
      model(schema, 'Thing').fields.filter(
        (item: IrField) => item.name === 'name'
      )
    ).toHaveLength(1);
  });

  it('warns when an embedded type is missing from the input', async () => {
    const schema: IrSchema = await parse(`
type Thing struct {
	ID uint
	Missing
}
`);
    expect(warningsMatching(schema, 'Missing')).toHaveLength(1);
  });
});

describe('indexes and constraints', () => {
  it('reads unique, uniqueIndex and index tags', async () => {
    const schema: IrSchema = await parse(`
type Sample struct {
	ID    uint
	Mail  string \`gorm:"unique"\`
	Login string \`gorm:"uniqueIndex"\`
	Nick  string \`gorm:"index"\`
	Slug  string \`gorm:"uniqueIndex:uq_slug"\`
	A     string \`gorm:"index:idx_ab,priority:2;uniqueIndex:uq_ab,priority:1"\`
	B     string \`gorm:"index:idx_ab,priority:1;uniqueIndex:uq_ab,priority:2"\`
	Body  string \`gorm:"index:idx_body,class:FULLTEXT,length:20,sort:desc,type:gin"\`
	Alt   string \`gorm:"index:,composite:pair,priority:1;index:,composite:pair,priority:2"\`
}
`);
    expect(field(schema, 'Sample', 'mail').isUnique).toBe(true);
    expect(field(schema, 'Sample', 'login').isUnique).toBe(true);
    expect(field(schema, 'Sample', 'nick').isUnique).toBe(false);
    const indexes: IrIndex[] = model(schema, 'Sample').indexes;
    expect(indexes).toContainEqual({ fields: ['nick'], isUnique: false });
    expect(indexes).toContainEqual({
      fields: ['slug'],
      isUnique: true,
      name: 'uq_slug',
    });
    expect(indexes).toContainEqual({
      fields: ['b', 'a'],
      isUnique: false,
      name: 'idx_ab',
    });
    expect(indexes).toContainEqual({
      fields: ['a', 'b'],
      isUnique: true,
      name: 'uq_ab',
    });
    expect(indexes).toContainEqual({
      fields: ['body'],
      isUnique: false,
      name: 'idx_body',
      kind: 'fulltext',
      method: 'Gin',
      fieldOptions: { body: { sort: 'desc', length: 20 } },
    });
  });

  it('warns about partial and expression indexes, check constraints and comments', async () => {
    const schema: IrSchema = await parse(`
type Sample struct {
	ID    uint
	Live  bool   \`gorm:"index:idx_live,where:live = true"\`
	Lower string \`gorm:"index:idx_lower,expression:lower(lower)"\`
	Age   int32  \`gorm:"check:age >= 0;comment:years"\`
}
`);
    expect(warningsMatching(schema, 'partial index')).toHaveLength(1);
    expect(model(schema, 'Sample').indexes.map((i) => i.name)).toEqual([
      'idx_live',
    ]);
    expect(warningsMatching(schema, 'uses an expression')).toHaveLength(1);
    expect(
      warningsMatching(schema, 'check constraint "age >= 0"')
    ).toHaveLength(1);
    expect(warningsMatching(schema, 'column comment')).toHaveLength(1);
  });
});

describe('table names', () => {
  it('reads TableName() with value and pointer receivers and constants', async () => {
    const schema: IrSchema = await parse(`
const legacy = "legacy_things"

type A struct { ID uint }
func (A) TableName() string { return "tbl_a" }

type B struct { ID uint }
func (b *B) TableName() string { return "tbl_b" }

type C struct { ID uint }
func (C) TableName() string { return legacy }

type D struct { ID uint }
func (D) TableName() string { return prefix + "d" }
`);
    expect(model(schema, 'A').tableName).toBe('tbl_a');
    expect(model(schema, 'B').tableName).toBe('tbl_b');
    expect(model(schema, 'C').tableName).toBe('legacy_things');
    expect(model(schema, 'D').tableName).toBe('ds');
    expect(warningsMatching(schema, 'D: TableName()')).toHaveLength(1);
  });
});

describe('enums', () => {
  it('turns typed string constants into enums', async () => {
    const schema: IrSchema = await parse(`
type Status string

const (
	StatusActive  Status = "active"
	StatusBlocked Status = "blocked"
	Retired       Status = "retired"
)

type Account struct {
	ID     uint
	State  Status  \`gorm:"size:20;default:active"\`
	Other  *Status
	Plain  string
}
`);
    expect(schema.enums).toEqual([
      {
        name: 'Status',
        values: [
          { name: 'Active', dbValue: 'active' },
          { name: 'Blocked', dbValue: 'blocked' },
          { name: 'Retired', dbValue: 'retired' },
        ],
      },
    ]);
    expect(field(schema, 'Account', 'state')).toMatchObject({
      type: 'string',
      enumName: 'Status',
      maxLength: 20,
      default: { kind: 'enumValue', value: 'Active' },
    });
    expect(field(schema, 'Account', 'other')).toMatchObject({
      enumName: 'Status',
      isNullable: true,
    });
    expect(field(schema, 'Account', 'plain').enumName).toBeUndefined();
  });

  it('reads constants declared in another file and drops unused enums', async () => {
    const schema: IrSchema = await parse(
      `
type Account struct {
	ID    uint
	State Status
}
`,
      `
type Status string
const StatusOn Status = "on"

type Unused string
const UnusedA Unused = "a"
`
    );
    expect(schema.enums.map((item) => item.name)).toEqual(['Status']);
  });

  it('converts integer constants to a plain integer column and warns', async () => {
    const schema: IrSchema = await parse(`
type Level int

const (
	LevelLow Level = iota + 1
	LevelHigh
)

type Task struct {
	ID    uint
	Level Level
}
`);
    expect(schema.enums).toEqual([]);
    expect(field(schema, 'Task', 'level')).toMatchObject({ type: 'bigInt' });
    expect(field(schema, 'Task', 'level').enumName).toBeUndefined();
    expect(warningsMatching(schema, 'integer constants')).toHaveLength(1);
  });

  it('reports a default that is not a member of the enum', async () => {
    const schema: IrSchema = await parse(`
type Status string
const StatusOn Status = "on"
type Account struct {
	ID    uint
	State Status \`gorm:"default:off"\`
}
`);
    expect(field(schema, 'Account', 'state').default).toEqual({
      kind: 'literal',
      value: 'off',
    });
    expect(warningsMatching(schema, 'not a value of the enum')).toHaveLength(1);
  });
});

describe('associations', () => {
  it('reads belongs to, has one and has many by convention', async () => {
    const schema: IrSchema = await parse(`
type Company struct {
	ID    uint
	Users []User
	Owner *Person
}
type Person struct {
	ID        uint
	CompanyID uint
}
type User struct {
	ID        uint
	CompanyID *uint
	Company   Company
	Card      CreditCard
}
type CreditCard struct {
	ID     uint
	UserID uint
	Number string
}
`);
    const company: IrRelation = relation(schema, 'User', 'company');
    expect(company).toMatchObject({
      kind: 'foreignKey',
      targetModel: 'Company',
      columnName: 'company_id',
      isNullable: true,
      relatedName: 'users',
      onDelete: 'noAction',
    });
    // The foreign key field is replaced by the relation.
    expect(
      model(schema, 'User').fields.map((item: IrField) => item.name)
    ).toEqual(['id']);
    // CreditCard declares only the key: the has-one on User creates the relation, named after the key.
    expect(relation(schema, 'CreditCard', 'user')).toMatchObject({
      kind: 'oneToOne',
      targetModel: 'User',
      columnName: 'user_id',
      isNullable: false,
    });
    expect(warningsMatching(schema, 'User.Card')).toEqual([]);
    expect(schema.warnings).toEqual([]);
  });

  it('marks has one as a one-to-one relation owned by the other side', async () => {
    const schema: IrSchema = await parse(`
type User struct {
	ID      uint
	Profile Profile
}
type Profile struct {
	ID     uint
	UserID uint
	User   User
}
`);
    expect(relation(schema, 'Profile', 'user')).toMatchObject({
      kind: 'oneToOne',
      relatedName: 'profile',
    });
    expect(model(schema, 'User').relations).toEqual([]);
  });

  it('reads foreignKey, references and constraint tags', async () => {
    const schema: IrSchema = await parse(`
type Country struct {
	Code string \`gorm:"primaryKey;size:2"\`
	Name string
}
type City struct {
	ID          uint
	CountryCode string  \`gorm:"size:2"\`
	Country     Country \`gorm:"foreignKey:CountryCode;references:Code;constraint:OnUpdate:CASCADE,OnDelete:SET NULL"\`
	StateID     *uint
	State       *Country \`gorm:"foreignKey:StateID;constraint:fk_city_state,OnDelete:CASCADE"\`
}
`);
    expect(relation(schema, 'City', 'country')).toMatchObject({
      columnName: 'country_code',
      onDelete: 'setNull',
      onUpdate: 'cascade',
    });
    expect(relation(schema, 'City', 'country').toField).toBeUndefined();
    expect(relation(schema, 'City', 'state')).toMatchObject({
      columnName: 'state_id',
      onDelete: 'cascade',
      constraintName: 'fk_city_state',
      isNullable: true,
    });
  });

  it('points at a non-key column with references', async () => {
    const schema: IrSchema = await parse(`
type Team struct {
	ID   uint
	Slug string \`gorm:"uniqueIndex;size:20"\`
}
type Member struct {
	ID       uint
	TeamSlug string
	Team     Team \`gorm:"foreignKey:TeamSlug;references:Slug"\`
}
`);
    expect(relation(schema, 'Member', 'team')).toMatchObject({
      columnName: 'team_slug',
      toField: 'slug',
    });
  });

  it('takes the constraint from the has side and warns about the ignored belongs-to tag', async () => {
    const schema: IrSchema = await parse(`
type Author struct {
	ID    uint
	Books []Book \`gorm:"constraint:OnDelete:CASCADE"\`
}
type Book struct {
	ID       uint
	AuthorID uint
	Author   Author \`gorm:"constraint:OnDelete:SET NULL"\`
}
`);
    expect(relation(schema, 'Book', 'author').onDelete).toBe('cascade');
    expect(
      warningsMatching(schema, 'GORM ignores the constraint')
    ).toHaveLength(1);
  });

  it('reads self-referencing associations', async () => {
    const schema: IrSchema = await parse(`
type Node struct {
	ID       uint
	ParentID *uint
	Parent   *Node
	Children []Node \`gorm:"foreignKey:ParentID"\`
}
`);
    expect(relation(schema, 'Node', 'parent')).toMatchObject({
      targetModel: 'Node',
      columnName: 'parent_id',
      relatedName: 'children',
      isNullable: true,
    });
  });

  it('reads composite foreign keys', async () => {
    const schema: IrSchema = await parse(`
type Tenant struct {
	Region string \`gorm:"primaryKey"\`
	Number int32  \`gorm:"primaryKey"\`
}
type Site struct {
	ID     uint
	TenantRegion string
	TenantNumber int32
	Tenant       Tenant \`gorm:"foreignKey:TenantRegion,TenantNumber;references:Region,Number"\`
}
`);
    expect(model(schema, 'Site').compositeForeignKeys).toEqual([
      {
        name: 'tenant',
        targetModel: 'Tenant',
        fields: ['tenantRegion', 'tenantNumber'],
        references: ['region', 'number'],
        kind: 'foreignKey',
        isNullable: false,
        onDelete: 'noAction',
      },
    ]);
    // The key columns stay ordinary fields.
    expect(
      model(schema, 'Site').fields.map((item: IrField) => item.name)
    ).toEqual(['id', 'tenantRegion', 'tenantNumber']);
  });

  it('keeps the unique foreign key of a one-to-one relation', async () => {
    const schema: IrSchema = await parse(`
type Owner struct { ID uint }
type Passport struct {
	ID      uint
	OwnerID uint  \`gorm:"uniqueIndex"\`
	Owner   Owner
}
`);
    expect(relation(schema, 'Passport', 'owner').kind).toBe('oneToOne');
    expect(model(schema, 'Passport').indexes).toEqual([]);
  });

  it('indexes and keys that use a foreign key refer to the relation', async () => {
    const schema: IrSchema = await parse(`
type Group struct { ID uint }
type Link struct {
	GroupID uint   \`gorm:"primaryKey"\`
	Group   Group
	Label   string \`gorm:"primaryKey;index:idx_link,priority:2"\`
	Extra   string \`gorm:"index:idx_link,priority:3"\`
}
`);
    expect(model(schema, 'Link').compositePrimaryKey).toEqual([
      'group',
      'label',
    ]);
    expect(relation(schema, 'Link', 'group').isPrimaryKey).toBeUndefined();
  });

  it('warns when no foreign key can be found', async () => {
    const schema: IrSchema = await parse(`
type A struct {
	ID uint
	Bs []B
}
type B struct {
	ID   uint
	Name string
}
`);
    expect(model(schema, 'B').relations).toEqual([]);
    expect(warningsMatching(schema, 'A.Bs: no foreign key')).toHaveLength(1);
  });

  it('reports polymorphic associations as a loss', async () => {
    const schema: IrSchema = await parse(`
type Dog struct {
	ID   uint
	Toys []Toy \`gorm:"polymorphic:Owner;polymorphicValue:master"\`
}
type Toy struct {
	ID        uint
	OwnerID   uint
	OwnerType string
}
`);
    expect(model(schema, 'Toy').relations).toEqual([]);
    expect(
      model(schema, 'Toy').fields.map((item: IrField) => item.name)
    ).toEqual(['id', 'ownerId', 'ownerType']);
    expect(
      warningsMatching(schema, 'polymorphic association "Owner"')
    ).toHaveLength(1);
  });

  it('keeps a field with a column type as a column, not an association', async () => {
    const schema: IrSchema = await parse(`
type Address struct { Street string }
type Place struct {
	ID   uint
	Spot Address \`gorm:"type:jsonb"\`
}
`);
    expect(field(schema, 'Place', 'spot').type).toBe('json');
    expect(model(schema, 'Place').relations).toEqual([]);
  });
});

describe('many to many', () => {
  it('links both sides of a many2many pair by the join table', async () => {
    const schema: IrSchema = await parse(`
type Post struct {
	ID   uint
	Tags []Tag \`gorm:"many2many:posts_tags"\`
}
type Tag struct {
	ID    uint
	Posts []Post \`gorm:"many2many:posts_tags"\`
}
`);
    expect(relation(schema, 'Post', 'tags')).toMatchObject({
      kind: 'manyToMany',
      targetModel: 'Tag',
      relatedName: 'posts',
    });
    expect(model(schema, 'Tag').relations).toEqual([]);
    // posts_tags is also the table other formats derive for the field "tags" of the table "posts".
    expect(warningsMatching(schema, 'join table')).toEqual([]);
  });

  it('warns when the join table or its columns differ from the derived ones', async () => {
    const schema: IrSchema = await parse(`
type Student struct {
	ID      uint
	Courses []Course \`gorm:"many2many:enrolment;joinForeignKey:PupilRef;joinReferences:ClassRef"\`
}
type Course struct { ID uint }
`);
    const warnings: string[] = warningsMatching(schema, 'Student.Courses');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('"enrolment" (columns pupil_ref, class_ref)');
    expect(warnings[0]).toContain('"students_courses"');
    expect(model(schema, 'Student').relations).toHaveLength(1);
    expect(relation(schema, 'Student', 'courses').relatedName).toBeUndefined();
  });

  it('names the second column of a self-referencing association after the field', async () => {
    const schema: IrSchema = await parse(`
type Person struct {
	ID      uint
	Friends []Person \`gorm:"many2many:friendships"\`
}
`);
    expect(relation(schema, 'Person', 'friends').targetModel).toBe('Person');
    expect(
      warningsMatching(schema, '(columns person_id, friend_id)')
    ).toHaveLength(1);
  });

  it('rejects a many2many without a table name', async () => {
    const schema: IrSchema = await parse(`
type A struct {
	ID uint
	Bs []B \`gorm:"many2many"\`
}
type B struct { ID uint }
`);
    expect(model(schema, 'A').relations).toEqual([]);
    expect(warningsMatching(schema, 'needs a join table name')).toHaveLength(1);
  });
});

describe('input problems', () => {
  it('warns about syntax errors but keeps the models it can read', async () => {
    const schema: IrSchema = await parse(`
type Good struct { ID uint }
type Bad struct {
	ID uint
	Name string
`);
    expect(warningsMatching(schema, 'syntax errors')).toHaveLength(1);
    expect(schema.models.map((item: IrModel) => item.name)).toContain('Good');
  });

  it('ignores a duplicate struct name', async () => {
    const schema: IrSchema = await parse(
      'type Thing struct { ID uint; A string }',
      'type Thing struct { ID uint; B string }'
    );
    expect(
      warningsMatching(schema, 'Duplicate struct name "Thing"')
    ).toHaveLength(1);
    expect(model(schema, 'Thing').fields.map((item) => item.name)).toContain(
      'a'
    );
  });

  it('reads a file that does not end in a newline', async () => {
    const result = expectOk(
      await parseGorm(
        [
          {
            path: 'a.go',
            text: 'package m\ntype Thing struct { ID uint }',
          },
        ],
        { appLabel: 'app' }
      )
    );
    expect(result.models.map((item: IrModel) => item.name)).toEqual(['Thing']);
    expect(result.warnings).toEqual([]);
  });

  it('resolves aliased imports', async () => {
    const schema = expectOk(
      await parseGorm(
        [
          {
            path: 'a.go',
            text: `package m
import (
	gid "github.com/google/uuid"
	d "github.com/shopspring/decimal"
)
type Thing struct {
	ID    gid.UUID \`gorm:"primaryKey"\`
	Price d.Decimal
}`,
          },
        ],
        { appLabel: 'app' }
      )
    );
    expect(field(schema, 'Thing', 'id').type).toBe('uuid');
    expect(field(schema, 'Thing', 'price').type).toBe('decimal');
  });
});

describe('extras fixture', () => {
  const directory: string = fileURLToPath(
    new URL('./fixtures/gorm-extras', import.meta.url)
  );
  const goldenDirectory: string = fileURLToPath(
    new URL('./golden-extras/', import.meta.url)
  );

  /** Compares text with test/golden-extras/<name>; run with UPDATE_GOLDEN=1 to rewrite it. */
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

  async function convertExtras(to: string): Promise<ConvertResult> {
    return expectOk(
      await convertText(
        [
          {
            path: `${directory}/shop.go`,
            text: readFileSync(`${directory}/shop.go`, 'utf8'),
          },
        ],
        { ...DEFAULT_OPTIONS, appLabel: 'shop', from: 'gorm', to }
      )
    );
  }

  it('reads the advanced constructs into the IR', async () => {
    const schema: IrSchema = expectOk(
      await parseGorm(
        [
          {
            path: 'shop.go',
            text: readFileSync(`${directory}/shop.go`, 'utf8'),
          },
        ],
        { appLabel: 'shop' }
      )
    );
    expect(schema.models.map((item: IrModel) => item.name)).toEqual([
      'Customer',
      'Order',
      'OrderItem',
      'Product',
      'Label',
      'Comment',
    ]);
    expect(model(schema, 'Order').tableName).toBe('shop_orders');
    expect(model(schema, 'OrderItem').compositePrimaryKey).toEqual([
      'order',
      'lineNo',
    ]);
    expect(field(schema, 'Customer', 'billingPostal').columnName).toBe(
      'billing_zip'
    );
    expect(relation(schema, 'Order', 'customer')).toMatchObject({
      onDelete: 'restrict',
      onUpdate: 'cascade',
      relatedName: 'orders',
    });
    expect(schema.enums.map((item) => item.name)).toEqual(['Role']);
  });

  it('matches the Prisma golden', async () => {
    const result: ConvertResult = await convertExtras('prisma');
    expectMatchesExtrasGolden('gorm-to-prisma.txt', result.output);
  });

  it('matches the warnings golden', async () => {
    const result: ConvertResult = await convertExtras('prisma');
    expectMatchesExtrasGolden(
      'gorm-warnings.txt',
      result.warnings.map((warning: string) => `${warning}\n`).join('')
    );
  });
});
