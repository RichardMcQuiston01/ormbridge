import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { convertText, type ConvertResult } from '../src/convert.js';
import { getFormat, getFormatByExtension } from '../src/formats.js';
import type {
  IrCompositeForeignKey,
  IrEnum,
  IrField,
  IrIndex,
  IrModel,
  IrRelation,
  IrSchema,
} from '../src/ir.js';
import { runConversion } from '../src/io.js';
import {
  parseSqlAlchemy,
  type SqlAlchemySourceFile,
} from '../src/parsers/sqlalchemy.js';
import { loadCanonicalSources } from './harness.js';
import { DEFAULT_OPTIONS, expectOk } from './helpers.js';

/** Parses Python source in one or more files (imports are not needed). */
async function parse(...texts: string[]): Promise<IrSchema> {
  const sources: SqlAlchemySourceFile[] = texts.map(
    (text: string, index: number): SqlAlchemySourceFile => ({
      path: `models${index}.py`,
      text,
    })
  );
  return expectOk(await parseSqlAlchemy(sources, { appLabel: 'app' }));
}

function model(schema: IrSchema, name: string): IrModel {
  const found: IrModel | undefined = schema.models.find(
    (candidate: IrModel) => candidate.name === name
  );
  if (found === undefined) {
    throw new Error(
      `Model ${name} was not parsed (found: ${schema.models.map((item: IrModel) => item.name).join(', ')})`
    );
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

const HEADER: string = `
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship

class Base(DeclarativeBase):
    pass
`;

/** One model on a DeclarativeBase with the given body lines. */
function single(body: string): string {
  return `${HEADER}
class Thing(Base):
    __tablename__ = "things"
    id: Mapped[int] = mapped_column(primary_key=True)
${body
  .split('\n')
  .map((line: string) => `    ${line}`)
  .join('\n')}
`;
}

describe('sqlalchemy adapter registration', () => {
  it('is registered as a readable format that does not claim .py', () => {
    const adapter = expectOk(getFormat('sqlalchemy'));
    expect(adapter.parse).toBeDefined();
    expect(adapter.extensions).toEqual([]);
    expect(adapter.description).toContain('SQLModel');
    expect(getFormatByExtension('.py')?.name).toBe('django');
  });

  it('converts through convertText', async () => {
    const result: ConvertResult = expectOk(
      await convertText(
        [
          {
            path: 'models.py',
            text: single('name: Mapped[str] = mapped_column(String(40))'),
          },
        ],
        { ...DEFAULT_OPTIONS, from: 'sqlalchemy', to: 'prisma' }
      )
    );
    expect(result.modelCount).toBe(1);
    expect(result.output).toContain('model Thing {');
    expect(result.output).toContain('@db.VarChar(40)');
    expect(result.output).toContain('@@map("things")');
  });

  it('fails with a descriptive error when no model is found', async () => {
    const result = await parseSqlAlchemy(
      [{ path: 'db.py', text: 'engine = create_engine("sqlite://")\n' }],
      { appLabel: 'app' }
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('NO_MODELS_FOUND');
      expect(result.error.message).toContain('db.py');
      expect(result.error.message).toContain('__tablename__');
    }
  });

  it('uses the app label of the options for every model', async () => {
    const schema: IrSchema = expectOk(
      await parseSqlAlchemy([{ path: 'm.py', text: single('') }], {
        appLabel: 'shop',
      })
    );
    expect(model(schema, 'Thing').appLabel).toBe('shop');
  });
});

describe('directory input', () => {
  const created: string[] = [];
  afterEach(() => {
    for (const directory of created.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('reads every .py file of the fixture package with --from sqlalchemy', async () => {
    const directory: string = fileURLToPath(
      new URL('./fixtures/sqlalchemy', import.meta.url)
    );
    const summary = expectOk(
      await runConversion({
        ...DEFAULT_OPTIONS,
        from: 'sqlalchemy',
        to: 'prisma',
        inputs: [directory],
      })
    );
    expect(summary.modelCount).toBe(5);
    expect(summary.warnings).toEqual([]);
    expect(summary.inputFiles).toHaveLength(8);
  });

  it('skips virtual environments, migrations, caches, tests and tooling', async () => {
    const root: string = mkdtempSync(join(tmpdir(), 'ormbridge-sqlalchemy-'));
    created.push(root);
    const files: Record<string, string> = {
      'app/models.py': single(''),
      'venv/lib/site-packages/dep/models.py': single('').replace('Thing', 'V'),
      '.venv/models.py': single('').replace('Thing', 'W'),
      'alembic/versions/001_init.py': single('').replace('Thing', 'X'),
      'migrations/0001.py': single('').replace('Thing', 'Y'),
      'app/__pycache__/models.py': single('').replace('Thing', 'Z'),
      'app/test_models.py': single('').replace('Thing', 'T1'),
      'app/models_test.py': single('').replace('Thing', 'T2'),
      'conftest.py': single('').replace('Thing', 'T3'),
      'setup.py': single('').replace('Thing', 'T4'),
      'README.md': 'not python',
    };
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), text);
    }
    const summary = expectOk(
      await runConversion({
        ...DEFAULT_OPTIONS,
        from: 'sqlalchemy',
        to: 'prisma',
        inputs: [root],
      })
    );
    expect(summary.modelCount).toBe(1);
    expect(summary.inputFiles).toHaveLength(1);
  });

  it('names the expected files when a directory has no Python files', async () => {
    const root: string = mkdtempSync(join(tmpdir(), 'ormbridge-sqlalchemy-'));
    created.push(root);
    const result = await runConversion({
      ...DEFAULT_OPTIONS,
      from: 'sqlalchemy',
      to: 'prisma',
      inputs: [root],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('NO_INPUT_FILES');
      expect(result.error.message).toContain('SQLAlchemy or SQLModel');
    }
  });
});

describe('model and table names', () => {
  it('uses the class name for the model and __tablename__ for the table', async () => {
    const schema: IrSchema = await parse(single(''));
    expect(model(schema, 'Thing').tableName).toBe('things');
  });

  it('accepts the classic declarative_base() and a base imported from elsewhere', async () => {
    const classic: IrSchema = await parse(`
Base = declarative_base()

class Account(Base):
    __tablename__ = "accounts"
    id = Column(Integer, primary_key=True)
`);
    expect(model(classic, 'Account').tableName).toBe('accounts');
    const imported: IrSchema = await parse(`
from app.db import Base

class Account(Base):
    __tablename__ = "accounts"
    id = Column(Integer, primary_key=True)
`);
    expect(model(imported, 'Account').tableName).toBe('accounts');
  });

  it('derives the table name from a @declared_attr that returns the class name', async () => {
    const schema: IrSchema = await parse(`
class Base(DeclarativeBase):
    @declared_attr.directive
    def __tablename__(cls) -> str:
        return cls.__name__.lower()

class Widget(Base):
    id: Mapped[int] = mapped_column(primary_key=True)

class Plain:
    @declared_attr
    def __tablename__(cls):
        return cls.__name__.lower()
    id: Mapped[int] = mapped_column(primary_key=True)
`);
    expect(schema.models.map((item: IrModel) => item.name)).toEqual(['Widget']);
    expect(model(schema, 'Widget').tableName).toBe('widget');
  });

  it('warns about a @declared_attr table name it cannot evaluate and other declared_attr members', async () => {
    const schema: IrSchema = await parse(`
class Base(DeclarativeBase):
    @declared_attr
    def __tablename__(cls):
        return compute(cls)

class Widget(Base):
    id: Mapped[int] = mapped_column(primary_key=True)
    @declared_attr
    def owner_id(cls):
        return mapped_column(ForeignKey("owner.id"))
`);
    expect(model(schema, 'Widget').tableName).toBe('widget');
    expect(warningsMatching(schema, '__tablename__')).toHaveLength(1);
    expect(warningsMatching(schema, 'Widget.owner_id')).toHaveLength(1);
  });

  it('names Flask-SQLAlchemy models (db.Model) after the snake-cased class', async () => {
    const schema: IrSchema = await parse(`
class UserProfile(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    bio = db.Column(db.Text)
`);
    expect(model(schema, 'UserProfile').tableName).toBe('user_profile');
    expect(field(schema, 'UserProfile', 'bio').type).toBe('text');
  });

  it('skips abstract bases, mixins and the declarative base itself', async () => {
    const schema: IrSchema = await parse(`
class Base(DeclarativeBase):
    pass

class Stamped(Base):
    __abstract__ = True
    created: Mapped[int] = mapped_column()

class Mixin:
    note: Mapped[str] = mapped_column()

class Thing(Mixin, Stamped):
    __tablename__ = "things"
    id: Mapped[int] = mapped_column(primary_key=True)
`);
    expect(schema.models.map((item: IrModel) => item.name)).toEqual(['Thing']);
    expect(
      model(schema, 'Thing').fields.map((item: IrField) => item.name)
    ).toEqual(['note', 'created', 'id']);
  });

  it('lets a subclass override a field of its mixin', async () => {
    const schema: IrSchema = await parse(`
class Mixin:
    note: Mapped[str] = mapped_column(String(10))

class Thing(Mixin, Base):
    __tablename__ = "things"
    id: Mapped[int] = mapped_column(primary_key=True)
    note: Mapped[str] = mapped_column(String(99))
`);
    expect(field(schema, 'Thing', 'note').maxLength).toBe(99);
    expect(
      model(schema, 'Thing').fields.filter(
        (item: IrField) => item.name === 'note'
      )
    ).toHaveLength(1);
  });

  it('keeps the first of two classes with the same name and warns', async () => {
    const schema: IrSchema = await parse(single(''), single(''));
    expect(schema.models).toHaveLength(1);
    expect(
      warningsMatching(schema, 'Duplicate class name "Thing"')
    ).toHaveLength(1);
  });

  it('survives a cyclic inheritance', async () => {
    const schema: IrSchema = await parse(`
class A(B):
    __tablename__ = "a"
    id: Mapped[int] = mapped_column(primary_key=True)

class B(A):
    pass
`);
    expect(model(schema, 'A').tableName).toBe('a');
  });

  it('skips a subclass that relies on single-table inheritance', async () => {
    const schema: IrSchema = await parse(`
class Base(DeclarativeBase):
    pass

class Employee(Base):
    __tablename__ = "employees"
    id: Mapped[int] = mapped_column(primary_key=True)
    kind: Mapped[str]

class Manager(Employee):
    budget: Mapped[int] = mapped_column(nullable=True)
`);
    expect(schema.models.map((item: IrModel) => item.name)).toEqual([
      'Employee',
    ]);
    expect(warningsMatching(schema, 'single-table inheritance')).toHaveLength(
      1
    );
  });

  it('reads joined-table inheritance as a primary key that is a one-to-one relation', async () => {
    const schema: IrSchema = await parse(`
class Base(DeclarativeBase):
    pass

class Employee(Base):
    __tablename__ = "employees"
    id: Mapped[int] = mapped_column(primary_key=True)

class Manager(Employee):
    __tablename__ = "managers"
    id: Mapped[int] = mapped_column(ForeignKey("employees.id"), primary_key=True)
    budget: Mapped[int]
`);
    expect(relation(schema, 'Manager', 'id')).toMatchObject({
      kind: 'oneToOne',
      targetModel: 'Employee',
      columnName: 'id',
      isPrimaryKey: true,
      isNullable: false,
    });
    expect(
      model(schema, 'Manager').fields.map((item: IrField) => item.name)
    ).toEqual(['budget']);
  });
});

describe('column types', () => {
  it('reads through a with_variant() modifier, as the emitter writes for big keys', async () => {
    const schema: IrSchema = await parse(
      single(`
id: Mapped[int] = mapped_column(
    BigInteger().with_variant(Integer, "sqlite"), primary_key=True, autoincrement=True
)
code: Mapped[str] = mapped_column(String(12).with_variant(Text, "sqlite"))
`)
    );
    expect(field(schema, 'Thing', 'id').type).toBe('bigInt');
    expect(field(schema, 'Thing', 'id').default?.kind).toBe('autoIncrement');
    expect(field(schema, 'Thing', 'code').type).toBe('string');
    expect(field(schema, 'Thing', 'code').maxLength).toBe(12);
    expect(warningsMatching(schema, 'could not be evaluated')).toEqual([]);
  });

  it('maps SQLAlchemy column types', async () => {
    const schema: IrSchema = await parse(
      single(`
a: Mapped[int] = mapped_column(Integer)
b: Mapped[int] = mapped_column(SmallInteger)
c: Mapped[int] = mapped_column(BigInteger)
d: Mapped[str] = mapped_column(String(30))
e: Mapped[str] = mapped_column(Unicode(length=40))
f: Mapped[str] = mapped_column(Text)
g: Mapped[bool] = mapped_column(Boolean)
h: Mapped[float] = mapped_column(Float)
i: Mapped[float] = mapped_column(sa.Double)
j: Mapped[Decimal] = mapped_column(Numeric(10, 3))
k: Mapped[Decimal] = mapped_column(Numeric(precision=8, scale=1))
l: Mapped[datetime] = mapped_column(DateTime(timezone=True))
m: Mapped[date] = mapped_column(Date)
n: Mapped[time] = mapped_column(Time)
o: Mapped[timedelta] = mapped_column(Interval)
p: Mapped[bytes] = mapped_column(LargeBinary)
q: Mapped[dict] = mapped_column(JSON)
r: Mapped[dict] = mapped_column(postgresql.JSONB)
s: Mapped[uuid.UUID] = mapped_column(Uuid)
t: Mapped[str] = mapped_column(postgresql.INET)
u: Mapped[str] = mapped_column(UUID(as_uuid=True))
v: Mapped[str] = mapped_column(Unicode)
`)
    );
    const type = (name: string): string => field(schema, 'Thing', name).type;
    expect(
      [
        'a',
        'b',
        'c',
        'd',
        'e',
        'f',
        'g',
        'h',
        'i',
        'j',
        'k',
        'l',
        'm',
        'n',
        'o',
        'p',
        'q',
        'r',
        's',
        't',
        'u',
        'v',
      ].map(type)
    ).toEqual([
      'int',
      'int',
      'bigInt',
      'string',
      'string',
      'text',
      'boolean',
      'float',
      'float',
      'decimal',
      'decimal',
      'dateTime',
      'date',
      'time',
      'duration',
      'bytes',
      'json',
      'json',
      'uuid',
      'ipAddress',
      'uuid',
      'string',
    ]);
    expect(field(schema, 'Thing', 'd').maxLength).toBe(30);
    expect(field(schema, 'Thing', 'e').maxLength).toBe(40);
    expect(field(schema, 'Thing', 'v').maxLength).toBeUndefined();
    expect(field(schema, 'Thing', 'j')).toMatchObject({
      maxDigits: 10,
      decimalPlaces: 3,
    });
    expect(field(schema, 'Thing', 'k')).toMatchObject({
      maxDigits: 8,
      decimalPlaces: 1,
    });
    expect(schema.warnings).toEqual([]);
  });

  it('maps Python types of Mapped[...] without a column type', async () => {
    const schema: IrSchema = await parse(
      single(`
a: Mapped[int]
b: Mapped[str]
c: Mapped[float]
d: Mapped[bool]
e: Mapped[bytes]
f: Mapped[datetime.datetime]
g: Mapped[datetime.date]
h: Mapped[datetime.time]
i: Mapped[datetime.timedelta]
j: Mapped[decimal.Decimal]
k: Mapped[uuid.UUID]
l: Mapped["int"]
`)
    );
    expect(
      ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l'].map(
        (name: string) => field(schema, 'Thing', name).type
      )
    ).toEqual([
      'int',
      'string',
      'float',
      'boolean',
      'bytes',
      'dateTime',
      'date',
      'time',
      'duration',
      'decimal',
      'uuid',
      'int',
    ]);
    expect(schema.warnings).toEqual([]);
  });

  it('keeps types it does not know as unsupported columns with a warning', async () => {
    const schema: IrSchema = await parse(
      single(`
shape: Mapped[str] = mapped_column(Geometry("POINT"))
blob: Mapped[dict]
bare = mapped_column()
tags: Mapped[list[str]]
`)
    );
    expect(field(schema, 'Thing', 'shape')).toMatchObject({
      type: 'unsupported',
      unsupportedType: 'Geometry(POINT)',
    });
    expect(field(schema, 'Thing', 'blob').type).toBe('unsupported');
    expect(field(schema, 'Thing', 'bare').type).toBe('unsupported');
    expect(field(schema, 'Thing', 'tags').type).toBe('unsupported');
    expect(warningsMatching(schema, 'Thing.shape')).toHaveLength(1);
    expect(warningsMatching(schema, 'Thing.blob')).toHaveLength(1);
  });

  it('reads PostgreSQL arrays, ranges and hstore', async () => {
    const schema: IrSchema = await parse(
      single(`
tags: Mapped[list[str]] = mapped_column(ARRAY(String(20)))
grid: Mapped[list[list[int]]] = mapped_column(postgresql.ARRAY(Integer, dimensions=2))
nested: Mapped[list] = mapped_column(ARRAY(ARRAY(Integer)))
window = mapped_column(INT4RANGE)
span = mapped_column(TSTZRANGE)
labels = mapped_column(HSTORE)
`)
    );
    expect(field(schema, 'Thing', 'tags')).toMatchObject({
      type: 'string',
      maxLength: 20,
      arrayDepth: 1,
    });
    expect(field(schema, 'Thing', 'grid')).toMatchObject({
      type: 'int',
      arrayDepth: 2,
    });
    expect(field(schema, 'Thing', 'nested').arrayDepth).toBe(2);
    expect(field(schema, 'Thing', 'window')).toMatchObject({
      type: 'range',
      rangeOf: 'int',
    });
    expect(field(schema, 'Thing', 'span')).toMatchObject({
      type: 'range',
      rangeOf: 'dateTime',
    });
    expect(field(schema, 'Thing', 'labels').type).toBe('hstore');
  });

  it('reads Annotated aliases, inline Annotated types and Optional aliases', async () => {
    const schema: IrSchema = await parse(`
${HEADER}
intpk = Annotated[int, mapped_column(primary_key=True)]
str30 = Annotated[str, mapped_column(String(30))]
required_name = Annotated[str, mapped_column(String(80), nullable=False, unique=True)]

class Thing(Base):
    __tablename__ = "things"
    id: Mapped[intpk]
    name: Mapped[required_name]
    nick: Mapped[Optional[str30]]
    code: Mapped[Annotated[str, mapped_column(String(5))]]
    other: Mapped[str30] = mapped_column(String(7))
`);
    expect(field(schema, 'Thing', 'id')).toMatchObject({
      isPrimaryKey: true,
      isNullable: false,
      type: 'int',
      default: { kind: 'autoIncrement' },
    });
    expect(field(schema, 'Thing', 'name')).toMatchObject({
      maxLength: 80,
      isUnique: true,
    });
    expect(field(schema, 'Thing', 'nick')).toMatchObject({
      maxLength: 30,
      isNullable: true,
    });
    expect(field(schema, 'Thing', 'code').maxLength).toBe(5);
    expect(field(schema, 'Thing', 'other').maxLength).toBe(7);
  });

  it('reads a literal type_annotation_map', async () => {
    const schema: IrSchema = await parse(`
class Base(DeclarativeBase):
    type_annotation_map = {
        dict[str, Any]: JSON,
        Decimal: Numeric(12, 2),
        str: String(60),
    }

class Thing(Base):
    __tablename__ = "things"
    id: Mapped[int] = mapped_column(primary_key=True)
    prefs: Mapped[dict[str, Any]]
    price: Mapped[Decimal]
    title: Mapped[str]
`);
    expect(field(schema, 'Thing', 'prefs').type).toBe('json');
    expect(field(schema, 'Thing', 'price')).toMatchObject({
      type: 'decimal',
      maxDigits: 12,
      decimalPlaces: 2,
    });
    expect(field(schema, 'Thing', 'title').maxLength).toBe(60);
  });

  it('reads a TypeDecorator through its impl', async () => {
    const schema: IrSchema = await parse(`
class Money(TypeDecorator):
    impl = Numeric(14, 4)
    cache_ok = True

${single('amount: Mapped[Decimal] = mapped_column(Money)')}
`);
    expect(field(schema, 'Thing', 'amount')).toMatchObject({
      type: 'decimal',
      maxDigits: 14,
      decimalPlaces: 4,
    });
  });

  it('accepts aliased imports and module prefixes', async () => {
    const schema: IrSchema = await parse(`
import sqlalchemy as sa
from sqlalchemy import orm

class Thing(orm.DeclarativeBase):
    pass

class Gadget(Thing):
    __tablename__ = "gadgets"
    id: orm.Mapped[int] = orm.mapped_column(primary_key=True)
    name: orm.Mapped[str] = orm.mapped_column(sa.String(12))
`);
    expect(field(schema, 'Gadget', 'name').maxLength).toBe(12);
  });
});

describe('nullability, keys and uniqueness', () => {
  it('derives nullability from Optional, | None, Union and nullable=', async () => {
    const schema: IrSchema = await parse(
      single(`
a: Mapped[int]
b: Mapped[Optional[int]]
c: Mapped[int | None]
d: Mapped[Union[int, None]]
e: Mapped[Optional[int]] = mapped_column(nullable=False)
f: Mapped[int] = mapped_column(nullable=True)
g = mapped_column(Integer)
h = mapped_column(Integer, nullable=False)
i: Mapped["Optional[int]"]
j: Mapped[None | int]
`)
    );
    const nullable = (name: string): boolean =>
      field(schema, 'Thing', name).isNullable;
    expect(
      ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'].map(nullable)
    ).toEqual([false, true, true, true, false, true, true, false, true, true]);
  });

  it('uses the classic Column rules: nullable unless a primary key or nullable=False', async () => {
    const schema: IrSchema = await parse(`
Base = declarative_base()
class Thing(Base):
    __tablename__ = "things"
    id = Column(Integer, primary_key=True)
    a = Column(String(10))
    b = Column(String(10), nullable=False)
    c = Column("see", String(10), unique=True)
    d = Column(Integer, primary_key=True, nullable=True)
`);
    expect(field(schema, 'Thing', 'a').isNullable).toBe(true);
    expect(field(schema, 'Thing', 'b').isNullable).toBe(false);
    expect(field(schema, 'Thing', 'c')).toMatchObject({
      name: 'c',
      columnName: 'see',
      isUnique: true,
    });
    expect(model(schema, 'Thing').compositePrimaryKey).toEqual(['id', 'd']);
    expect(field(schema, 'Thing', 'd').isNullable).toBe(false);
  });

  it('uses the attribute name unless the column is named', async () => {
    const schema: IrSchema = await parse(
      single(`
metadata_: Mapped[dict] = mapped_column("metadata", JSON)
other: Mapped[int] = mapped_column(name="legacy_other")
`)
    );
    expect(field(schema, 'Thing', 'metadata_').columnName).toBe('metadata');
    expect(field(schema, 'Thing', 'other').columnName).toBe('legacy_other');
  });

  it('makes a lone integer primary key count up unless disabled or defaulted', async () => {
    const schema: IrSchema = await parse(`
${HEADER}
class A(Base):
    __tablename__ = "a"
    id: Mapped[int] = mapped_column(primary_key=True)

class B(Base):
    __tablename__ = "b"
    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=False)

class C(Base):
    __tablename__ = "c"
    id: Mapped[str] = mapped_column(String(10), primary_key=True)

class D(Base):
    __tablename__ = "d"
    id: Mapped[int] = mapped_column(Identity(), primary_key=True)

class E(Base):
    __tablename__ = "e"
    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)

class F(Base):
    __tablename__ = "f"
    id: Mapped[int] = mapped_column(Sequence("f_seq"), primary_key=True)
    other: Mapped[int] = mapped_column(autoincrement=True)
`);
    expect(field(schema, 'A', 'id').default).toEqual({ kind: 'autoIncrement' });
    expect(field(schema, 'B', 'id').default).toBeUndefined();
    expect(field(schema, 'C', 'id').default).toBeUndefined();
    expect(field(schema, 'D', 'id').default).toEqual({ kind: 'autoIncrement' });
    expect(field(schema, 'E', 'id').default).toEqual({ kind: 'uuid' });
    expect(field(schema, 'F', 'id').default).toEqual({ kind: 'autoIncrement' });
    expect(field(schema, 'F', 'other').default).toEqual({
      kind: 'autoIncrement',
    });
  });

  it('reads a composite primary key from several columns or PrimaryKeyConstraint', async () => {
    const schema: IrSchema = await parse(`
${HEADER}
class Pair(Base):
    __tablename__ = "pairs"
    left: Mapped[int] = mapped_column(primary_key=True)
    right: Mapped[int] = mapped_column(primary_key=True)

class Other(Base):
    __tablename__ = "others"
    __table_args__ = (PrimaryKeyConstraint("a", "b", name="pk_others"),)
    a: Mapped[int]
    b: Mapped[int]
    c: Mapped[int]
`);
    expect(model(schema, 'Pair').compositePrimaryKey).toEqual([
      'left',
      'right',
    ]);
    expect(field(schema, 'Pair', 'left')).toMatchObject({
      isPrimaryKey: false,
      isNullable: false,
    });
    expect(model(schema, 'Other').compositePrimaryKey).toEqual(['a', 'b']);
    expect(model(schema, 'Other').primaryKeyName).toBe('pk_others');
    expect(field(schema, 'Other', 'a').isNullable).toBe(false);
  });

  it('warns about a table without a primary key', async () => {
    const schema: IrSchema = await parse(`
${HEADER}
class Loose(Base):
    __tablename__ = "loose"
    name: Mapped[str]
`);
    expect(
      warningsMatching(schema, 'Loose: the table has no primary key')
    ).toHaveLength(1);
  });
});

describe('defaults', () => {
  it('reads literal Python defaults', async () => {
    const schema: IrSchema = await parse(
      single(`
a: Mapped[int] = mapped_column(default=7)
b: Mapped[float] = mapped_column(default=-1.5)
c: Mapped[str] = mapped_column(default="x")
d: Mapped[bool] = mapped_column(default=True)
e: Mapped[Optional[int]] = mapped_column(default=None)
f: Mapped[dict] = mapped_column(JSON, default=dict)
g: Mapped[list] = mapped_column(JSON, default=list)
h: Mapped[dict] = mapped_column(JSON, default=lambda: {})
i: Mapped[Decimal] = mapped_column(Numeric(5, 2), default=Decimal("1.50"))
j: Mapped[int] = mapped_column(default=lambda: 3)
`)
    );
    const defaults = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'].map(
      (name: string) => field(schema, 'Thing', name).default
    );
    expect(defaults).toEqual([
      { kind: 'literal', value: 7 },
      { kind: 'literal', value: -1.5 },
      { kind: 'literal', value: 'x' },
      { kind: 'literal', value: true },
      undefined,
      { kind: 'literal', value: '{}' },
      { kind: 'literal', value: '[]' },
      { kind: 'literal', value: '{}' },
      { kind: 'literal', value: 1.5 },
      { kind: 'literal', value: 3 },
    ]);
    expect(field(schema, 'Thing', 'a').isDbDefault).toBeUndefined();
  });

  it('reads the current time and UUID callables', async () => {
    const schema: IrSchema = await parse(
      single(`
a: Mapped[datetime] = mapped_column(default=func.now())
b: Mapped[datetime] = mapped_column(default=datetime.utcnow)
c: Mapped[datetime] = mapped_column(default=datetime.now)
d: Mapped[datetime] = mapped_column(default=lambda: datetime.now(timezone.utc))
e: Mapped[date] = mapped_column(default=date.today)
f: Mapped[uuid.UUID] = mapped_column(default=uuid.uuid4)
g: Mapped[uuid.UUID] = mapped_column(default=uuid4)
h: Mapped[uuid.UUID] = mapped_column(default=lambda: uuid.uuid4())
i: Mapped[datetime] = mapped_column(default=datetime.datetime.utcnow)
j: Mapped[datetime] = mapped_column(default=sa.func.current_timestamp())
`)
    );
    expect(
      ['a', 'b', 'c', 'd', 'e', 'i', 'j'].map(
        (name: string) => field(schema, 'Thing', name).default
      )
    ).toEqual(Array(7).fill({ kind: 'now' }));
    expect(
      ['f', 'g', 'h'].map(
        (name: string) => field(schema, 'Thing', name).default
      )
    ).toEqual(Array(3).fill({ kind: 'uuid' }));
    expect(schema.warnings).toEqual([]);
  });

  it('marks server defaults as database defaults', async () => {
    const schema: IrSchema = await parse(
      single(`
a: Mapped[datetime] = mapped_column(server_default=func.now())
b: Mapped[int] = mapped_column(server_default=text("0"))
c: Mapped[int] = mapped_column(server_default="5")
d: Mapped[str] = mapped_column(server_default="draft")
e: Mapped[str] = mapped_column(server_default=text("'draft'"))
f: Mapped[bool] = mapped_column(server_default=text("false"))
g: Mapped[bool] = mapped_column(server_default=sa.true())
h: Mapped[uuid.UUID] = mapped_column(server_default=text("gen_random_uuid()"))
i: Mapped[uuid.UUID] = mapped_column(server_default=func.gen_random_uuid())
j: Mapped[dict] = mapped_column(JSON, server_default=text("'{}'::jsonb"))
k: Mapped[datetime] = mapped_column(server_default=text("CURRENT_TIMESTAMP"))
l: Mapped[int] = mapped_column(server_default=text("(1 + 2)"))
m: Mapped[str] = mapped_column(server_default=func.lower("X"))
n: Mapped[float] = mapped_column(server_default=text("0.25"))
`)
    );
    const defaults = 'abcdefghijklmn'
      .split('')
      .map((name: string) => field(schema, 'Thing', name));
    expect(defaults.map((item: IrField) => item.default)).toEqual([
      { kind: 'now' },
      { kind: 'literal', value: 0 },
      { kind: 'literal', value: 5 },
      { kind: 'literal', value: 'draft' },
      { kind: 'literal', value: 'draft' },
      { kind: 'literal', value: false },
      { kind: 'literal', value: true },
      { kind: 'uuid' },
      { kind: 'uuid' },
      { kind: 'literal', value: '{}' },
      { kind: 'now' },
      { kind: 'dbExpression', expression: '(1 + 2)' },
      { kind: 'dbExpression', expression: 'lower("X")' },
      { kind: 'literal', value: 0.25 },
    ]);
    expect(defaults.every((item: IrField) => item.isDbDefault === true)).toBe(
      true
    );
  });

  it('prefers server_default over default when both are given', async () => {
    const schema: IrSchema = await parse(
      single(
        'a: Mapped[int] = mapped_column(default=1, server_default=text("2"))'
      )
    );
    expect(field(schema, 'Thing', 'a')).toMatchObject({
      default: { kind: 'literal', value: 2 },
      isDbDefault: true,
    });
  });

  it('warns about defaults it cannot evaluate', async () => {
    const schema: IrSchema = await parse(
      single(`
a: Mapped[int] = mapped_column(default=compute_default)
b: Mapped[int] = mapped_column(default=other())
c: Mapped[str] = mapped_column(default=lambda ctx: ctx.get_current_parameters()["x"])
d: Mapped[int] = mapped_column(default=1 + 2)
`)
    );
    for (const name of ['a', 'b', 'c', 'd']) {
      expect(field(schema, 'Thing', name).default).toBeUndefined();
      expect(warningsMatching(schema, `Thing.${name}:`)).toHaveLength(1);
    }
  });

  it('reads onupdate as an auto-updated column and drops the redundant now default', async () => {
    const schema: IrSchema = await parse(
      single(`
a: Mapped[datetime] = mapped_column(default=func.now(), onupdate=func.now())
b: Mapped[datetime] = mapped_column(server_default=func.now(), onupdate=datetime.utcnow)
c: Mapped[int] = mapped_column(onupdate=5)
`)
    );
    expect(field(schema, 'Thing', 'a')).toMatchObject({ isAutoUpdated: true });
    expect(field(schema, 'Thing', 'a').default).toBeUndefined();
    expect(field(schema, 'Thing', 'b').isAutoUpdated).toBe(true);
    expect(field(schema, 'Thing', 'b').isDbDefault).toBeUndefined();
    expect(field(schema, 'Thing', 'c').isAutoUpdated).toBe(false);
    expect(warningsMatching(schema, 'Thing.c: onupdate')).toHaveLength(1);
  });

  it('reads generated columns', async () => {
    const schema: IrSchema = await parse(
      single(`
a: Mapped[int]
b: Mapped[int] = mapped_column(Computed("a * 2", persisted=True))
c: Mapped[int] = mapped_column(Computed("a * 3"))
`)
    );
    expect(field(schema, 'Thing', 'b').generated).toEqual({
      expression: 'a * 2',
      isStored: true,
    });
    expect(field(schema, 'Thing', 'c').generated?.isStored).toBe(false);
  });
});

describe('enums', () => {
  const STATUS: string = `
class Status(str, enum.Enum):
    NEW = "new"
    DONE = "done"
    _ignored = "x"
`;

  it('stores member names for a Python enum column, as SQLAlchemy does', async () => {
    const schema: IrSchema = await parse(`
${STATUS}
${single('status: Mapped[Status] = mapped_column(default=Status.NEW)')}
`);
    expect(schema.enums).toEqual([
      {
        name: 'Status',
        values: [
          { name: 'NEW', dbValue: 'NEW' },
          { name: 'DONE', dbValue: 'DONE' },
        ],
      },
    ]);
    expect(field(schema, 'Thing', 'status')).toMatchObject({
      enumName: 'Status',
      default: { kind: 'enumValue', value: 'NEW' },
    });
  });

  it('stores values when values_callable says so', async () => {
    const schema: IrSchema = await parse(`
${STATUS}
${single(`status: Mapped[Status] = mapped_column(
    Enum(Status, values_callable=lambda e: [m.value for m in e]),
    default=Status.DONE,
)`)}
`);
    expect(schema.enums[0]?.values).toEqual([
      { name: 'NEW', dbValue: 'new' },
      { name: 'DONE', dbValue: 'done' },
    ]);
    expect(field(schema, 'Thing', 'status').default).toEqual({
      kind: 'enumValue',
      value: 'DONE',
    });
  });

  it('reads sa.Enum with string values and a database name', async () => {
    const schema: IrSchema = await parse(`
${single(`
state = mapped_column(Enum("on", "off", name="power_state"), server_default="on")
mode: Mapped[str] = mapped_column(sa.Enum("fast", "slow"))
`)}
`);
    expect(schema.enums).toEqual([
      {
        name: 'PowerState',
        dbName: 'power_state',
        values: [
          { name: 'ON', dbValue: 'on' },
          { name: 'OFF', dbValue: 'off' },
        ],
      },
      {
        name: 'ThingMode',
        values: [
          { name: 'FAST', dbValue: 'fast' },
          { name: 'SLOW', dbValue: 'slow' },
        ],
      },
    ]);
    expect(field(schema, 'Thing', 'state')).toMatchObject({
      enumName: 'PowerState',
      default: { kind: 'enumValue', value: 'ON' },
    });
  });

  it('turns Literal[...] into an enum named after the model and field', async () => {
    const schema: IrSchema = await parse(
      single(
        'tier: Mapped[Literal["free", "pro"]] = mapped_column(default="free")'
      )
    );
    expect(schema.enums[0]).toMatchObject({
      name: 'ThingTier',
      values: [
        { name: 'FREE', dbValue: 'free' },
        { name: 'PRO', dbValue: 'pro' },
      ],
    });
    expect(field(schema, 'Thing', 'tier').default).toEqual({
      kind: 'enumValue',
      value: 'FREE',
    });
  });

  it('shares one enum between columns, reads aliased enums and warns about unknown ones', async () => {
    const schema: IrSchema = await parse(`
${STATUS}
class Level(Status):
    pass

${single(`
a: Mapped[Status]
b: Mapped[Optional[Status]]
c: Mapped[Level]
d: Mapped[Missing] = mapped_column(Enum(Missing))
`)}
`);
    expect(schema.enums.map((item: IrEnum) => item.name)).toEqual([
      'Status',
      'Level',
    ]);
    expect(field(schema, 'Thing', 'b')).toMatchObject({
      enumName: 'Status',
      isNullable: true,
    });
    expect(field(schema, 'Thing', 'd').type).toBe('string');
    expect(warningsMatching(schema, 'Thing.d')).toHaveLength(1);
  });

  it('does not register an enum class that no column uses', async () => {
    const schema: IrSchema = await parse(`
${STATUS}
${single('')}
`);
    expect(schema.enums).toEqual([]);
  });
});

describe('foreign keys', () => {
  const TWO: string = `
${HEADER}
class Owner(Base):
    __tablename__ = "owners"
    id: Mapped[int] = mapped_column(primary_key=True)
    email: Mapped[str] = mapped_column(unique=True)
`;

  it('reads ondelete, onupdate and the constraint name', async () => {
    const schema: IrSchema = await parse(`
${TWO}
class Pet(Base):
    __tablename__ = "pets"
    id: Mapped[int] = mapped_column(primary_key=True)
    a_id: Mapped[int] = mapped_column(ForeignKey("owners.id", ondelete="CASCADE", onupdate="SET NULL", name="fk_a"))
    b_id: Mapped[Optional[int]] = mapped_column(ForeignKey("owners.id", ondelete="SET NULL"))
    c_id: Mapped[int] = mapped_column(ForeignKey("owners.id", ondelete="restrict"))
    d_id: Mapped[int] = mapped_column(ForeignKey("owners.id", ondelete="NO ACTION"))
    e_id: Mapped[int] = mapped_column(ForeignKey("owners.id", ondelete="SET DEFAULT"))
    f_id: Mapped[int] = mapped_column(ForeignKey("owners.id"))
    g_id: Mapped[int] = mapped_column(ForeignKey("owners.id", ondelete="weird"))
`);
    const pick = (name: string): IrRelation => relation(schema, 'Pet', name);
    expect(pick('a')).toMatchObject({
      onDelete: 'cascade',
      onUpdate: 'setNull',
      constraintName: 'fk_a',
      columnName: 'a_id',
      isNullable: false,
      kind: 'foreignKey',
    });
    expect(pick('b')).toMatchObject({ onDelete: 'setNull', isNullable: true });
    expect(pick('c').onDelete).toBe('restrict');
    expect(pick('d').onDelete).toBe('noAction');
    expect(pick('e').onDelete).toBe('setDefault');
    expect(pick('f').onDelete).toBe('noAction');
    expect(pick('g').onDelete).toBe('noAction');
    expect(warningsMatching(schema, 'ondelete="weird"')).toHaveLength(1);
    expect(
      model(schema, 'Pet').fields.map((item: IrField) => item.name)
    ).toEqual(['id']);
  });

  it('names the relation after the column without _id, or after the relationship', async () => {
    const schema: IrSchema = await parse(`
${TWO}
class Pet(Base):
    __tablename__ = "pets"
    id: Mapped[int] = mapped_column(primary_key=True)
    owner_id: Mapped[int] = mapped_column(ForeignKey("owners.id"))
    ownerId: Mapped[int] = mapped_column(ForeignKey("owners.id"))
    keeper: Mapped[int] = mapped_column(ForeignKey("owners.id"))
    vet_id: Mapped[int] = mapped_column(ForeignKey("owners.id"))
    vet: Mapped["Owner"] = relationship(foreign_keys=[vet_id])
`);
    expect(
      model(schema, 'Pet').relations.map((item: IrRelation) => item.name)
    ).toEqual(['owner', 'ownerId', 'keeper', 'vet']);
  });

  it('resolves ForeignKey(Model.column) and ForeignKey(table.c.column)', async () => {
    const schema: IrSchema = await parse(`
${TWO}
owners_table = Table("owner_copy", Base.metadata, Column("id", Integer, primary_key=True))

class Pet(Base):
    __tablename__ = "pets"
    id: Mapped[int] = mapped_column(primary_key=True)
    a_id: Mapped[int] = mapped_column(ForeignKey(Owner.id))
    b_id: Mapped[int] = mapped_column(ForeignKey(owners_table.c.id))
    c_id: Mapped[int] = mapped_column(ForeignKey(Owner.__table__.c.id))
`);
    expect(relation(schema, 'Pet', 'a').targetModel).toBe('Owner');
    expect(relation(schema, 'Pet', 'b').targetModel).toBe('OwnerCopy');
    expect(relation(schema, 'Pet', 'c').targetModel).toBe('Owner');
  });

  it('records the referenced column when it is not the primary key', async () => {
    const schema: IrSchema = await parse(`
${TWO}
class Pet(Base):
    __tablename__ = "pets"
    id: Mapped[int] = mapped_column(primary_key=True)
    owner_email: Mapped[str] = mapped_column(ForeignKey("owners.email"))
`);
    expect(relation(schema, 'Pet', 'owner_email')).toMatchObject({
      targetModel: 'Owner',
      toField: 'email',
    });
  });

  it('reads a unique or primary key foreign key as a one-to-one', async () => {
    const schema: IrSchema = await parse(`
${TWO}
class Card(Base):
    __tablename__ = "cards"
    id: Mapped[int] = mapped_column(primary_key=True)
    owner_id: Mapped[int] = mapped_column(ForeignKey("owners.id"), unique=True)

class Badge(Base):
    __tablename__ = "badges"
    __table_args__ = (UniqueConstraint("owner_id"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    owner_id: Mapped[int] = mapped_column(ForeignKey("owners.id"))
`);
    expect(relation(schema, 'Card', 'owner').kind).toBe('oneToOne');
    expect(relation(schema, 'Badge', 'owner').kind).toBe('oneToOne');
  });

  it('infers the type of a column declared as Column("id", ForeignKey(...))', async () => {
    const schema: IrSchema = await parse(`
${HEADER}
class Key(Base):
    __tablename__ = "keys"
    code = Column(String(12), primary_key=True)

class Lock(Base):
    __tablename__ = "locks"
    id = Column(Integer, primary_key=True)
    key_code = Column(ForeignKey("keys.code"))
`);
    expect(model(schema, 'Lock').relations[0]).toMatchObject({
      name: 'key_code',
      targetModel: 'Key',
      columnName: 'key_code',
    });
    expect(warningsMatching(schema, 'no type')).toEqual([]);
  });

  it('generates a stub for a table that is not in the input', async () => {
    const schema: IrSchema = await parse(`
${HEADER}
class Pet(Base):
    __tablename__ = "pets"
    id: Mapped[int] = mapped_column(primary_key=True)
    owner_id: Mapped[int] = mapped_column(ForeignKey("auth_users.id"))
`);
    expect(relation(schema, 'Pet', 'owner').targetModel).toBe('AuthUser');
    expect(model(schema, 'AuthUser').tableName).toBe('auth_users');
    expect(warningsMatching(schema, 'stub model')).toHaveLength(1);
  });

  it('warns about a foreign key it cannot read', async () => {
    const schema: IrSchema = await parse(`
${HEADER}
class Pet(Base):
    __tablename__ = "pets"
    id: Mapped[int] = mapped_column(primary_key=True)
    a_id: Mapped[int] = mapped_column(ForeignKey(compute()))
    b_id: Mapped[int] = mapped_column(ForeignKey(""))
`);
    expect(
      warningsMatching(schema, 'ForeignKey(...) could not be evaluated')
    ).toHaveLength(2);
    expect(model(schema, 'Pet').relations).toEqual([]);
  });

  it('reads a composite foreign key from ForeignKeyConstraint', async () => {
    const schema: IrSchema = await parse(`
${HEADER}
class Line(Base):
    __tablename__ = "lines"
    order_id: Mapped[int] = mapped_column(primary_key=True)
    number: Mapped[int] = mapped_column(primary_key=True)

class Note(Base):
    __tablename__ = "notes"
    __table_args__ = (
        ForeignKeyConstraint(
            ["order_id", "line_no"],
            ["lines.order_id", "lines.number"],
            ondelete="CASCADE",
            onupdate="RESTRICT",
            name="fk_note_line",
        ),
    )
    id: Mapped[int] = mapped_column(primary_key=True)
    order_id: Mapped[int]
    line_no: Mapped[int]
`);
    const composite: IrCompositeForeignKey | undefined = model(schema, 'Note')
      .compositeForeignKeys?.[0];
    expect(composite).toMatchObject({
      targetModel: 'Line',
      fields: ['order_id', 'line_no'],
      references: ['order_id', 'number'],
      onDelete: 'cascade',
      onUpdate: 'restrict',
      constraintName: 'fk_note_line',
      isNullable: false,
    });
    expect(
      model(schema, 'Note').fields.map((item: IrField) => item.name)
    ).toEqual(['id', 'order_id', 'line_no']);
  });

  it('turns a single-column ForeignKeyConstraint into an ordinary foreign key', async () => {
    const schema: IrSchema = await parse(`
${TWO}
class Pet(Base):
    __tablename__ = "pets"
    __table_args__ = (ForeignKeyConstraint(["owner_id"], ["owners.id"], ondelete="CASCADE"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    owner_id: Mapped[int]
`);
    expect(relation(schema, 'Pet', 'owner')).toMatchObject({
      onDelete: 'cascade',
      columnName: 'owner_id',
    });
  });

  it('warns about a constraint that names a column that does not exist', async () => {
    const schema: IrSchema = await parse(`
${TWO}
class Pet(Base):
    __tablename__ = "pets"
    __table_args__ = (
        ForeignKeyConstraint(["ghost"], ["owners.id"]),
        UniqueConstraint("ghost"),
        Index("ix_ghost", "ghost"),
        PrimaryKeyConstraint("ghost"),
    )
    id: Mapped[int] = mapped_column(primary_key=True)
`);
    expect(warningsMatching(schema, 'Pet.__table_args__')).toHaveLength(4);
  });
});

describe('indexes and constraints', () => {
  it('reads index=True, unique=True and named indexes', async () => {
    const schema: IrSchema = await parse(`
${HEADER}
class Thing(Base):
    __tablename__ = "things"
    __table_args__ = (
        Index("ix_pair", "a", "b"),
        Index("ix_unique_c", "c", unique=True),
        Index("ix_d_desc", Thing.d.desc(), Thing.a),
        Index(None, "b"),
        Index("ix_gin", "e", postgresql_using="gin"),
        UniqueConstraint("a", "c", name="uq_a_c"),
        UniqueConstraint("b"),
        UniqueConstraint("d", name="uq_d"),
    )
    id: Mapped[int] = mapped_column(primary_key=True)
    a: Mapped[int] = mapped_column(index=True)
    b: Mapped[int]
    c: Mapped[int]
    d: Mapped[int] = mapped_column(index=True, unique=True)
    e: Mapped[str]
`);
    expect(model(schema, 'Thing').indexes).toEqual<IrIndex[]>([
      { fields: ['a'], isUnique: false },
      { fields: ['a', 'b'], isUnique: false, name: 'ix_pair' },
      { fields: ['c'], isUnique: true, name: 'ix_unique_c' },
      {
        fields: ['d', 'a'],
        isUnique: false,
        name: 'ix_d_desc',
        fieldOptions: { d: { sort: 'desc' } },
      },
      { fields: ['b'], isUnique: false },
      { fields: ['e'], isUnique: false, name: 'ix_gin', method: 'gin' },
      { fields: ['a', 'c'], isUnique: true, name: 'uq_a_c' },
    ]);
    expect(field(schema, 'Thing', 'b').isUnique).toBe(true);
    expect(field(schema, 'Thing', 'd')).toMatchObject({
      isUnique: true,
      uniqueName: 'uq_d',
    });
  });

  it('reads Index(...) written after the class body', async () => {
    const schema: IrSchema = await parse(
      single(`
a: Mapped[int]
b: Mapped[str]
`) +
        `
Index("ix_thing_ab", Thing.a, Thing.b)
Index("ix_thing_b", Thing.__table__.c.b, unique=True)
`
    );
    expect(model(schema, 'Thing').indexes).toEqual<IrIndex[]>([
      { fields: ['a', 'b'], isUnique: false, name: 'ix_thing_ab' },
      { fields: ['b'], isUnique: true, name: 'ix_thing_b' },
    ]);
  });

  it('refers to columns by attribute name or database name', async () => {
    const schema: IrSchema = await parse(`
${HEADER}
class Thing(Base):
    __tablename__ = "things"
    __table_args__ = (Index("ix_a", "legacy_a"), Index("ix_b", "b"))
    id: Mapped[int] = mapped_column(primary_key=True)
    a: Mapped[int] = mapped_column("legacy_a")
    b: Mapped[int] = mapped_column("legacy_b")
`);
    expect(
      model(schema, 'Thing').indexes.map((item: IrIndex) => item.fields)
    ).toEqual([['a'], ['b']]);
  });

  it('warns about check, exclude, partial and expression indexes and keeps going', async () => {
    const schema: IrSchema = await parse(`
${HEADER}
class Thing(Base):
    __tablename__ = "things"
    __table_args__ = (
        CheckConstraint("a > 0", name="ck_a"),
        ExcludeConstraint(("a", "=")),
        Index("ix_partial", "a", postgresql_where=text("a > 0")),
        Index("ix_expr", func.lower(text("b"))),
        Frobnicate("x"),
        "comment",
        {"schema": "audit", "comment": "x"},
    )
    id: Mapped[int] = mapped_column(primary_key=True)
    a: Mapped[int] = mapped_column(CheckConstraint("a < 100"))
    b: Mapped[str]
`);
    expect(model(schema, 'Thing').indexes).toEqual([]);
    expect(model(schema, 'Thing').schema).toBe('audit');
    expect(warningsMatching(schema, 'CheckConstraint')).toHaveLength(2);
    expect(warningsMatching(schema, 'ExcludeConstraint')).toHaveLength(1);
    expect(warningsMatching(schema, 'partial index')).toHaveLength(1);
    expect(warningsMatching(schema, 'expression')).toHaveLength(1);
    expect(warningsMatching(schema, 'Frobnicate')).toHaveLength(1);
  });

  it('reads the schema of MetaData(schema=...) and resolves schema-qualified keys', async () => {
    const schema: IrSchema = await parse(`
class Base(DeclarativeBase):
    metadata = MetaData(schema="inv")

class Owner(Base):
    __tablename__ = "owners"
    id: Mapped[int] = mapped_column(primary_key=True)

class Pet(Base):
    __tablename__ = "pets"
    id: Mapped[int] = mapped_column(primary_key=True)
    owner_id: Mapped[int] = mapped_column(ForeignKey("inv.owners.id"))
`);
    expect(model(schema, 'Owner').schema).toBe('inv');
    expect(relation(schema, 'Pet', 'owner').targetModel).toBe('Owner');
    const viaVariable: IrSchema = await parse(`
meta = MetaData(schema="inv")
Base = declarative_base(metadata=meta)

class Owner(Base):
    __tablename__ = "owners"
    id = Column(Integer, primary_key=True)
`);
    expect(model(viaVariable, 'Owner').schema).toBe('inv');
  });
});

describe('relationships', () => {
  const PAIR: string = `
${HEADER}
class Author(Base):
    __tablename__ = "authors"
    id: Mapped[int] = mapped_column(primary_key=True)
    books: Mapped[list["Book"]] = relationship(back_populates="author")
    profile: Mapped[Optional["Profile"]] = relationship(back_populates="author")

class Book(Base):
    __tablename__ = "books"
    id: Mapped[int] = mapped_column(primary_key=True)
    author_id: Mapped[int] = mapped_column(ForeignKey("authors.id"))
    author: Mapped["Author"] = relationship(back_populates="books")

class Profile(Base):
    __tablename__ = "profiles"
    id: Mapped[int] = mapped_column(primary_key=True)
    author_id: Mapped[int] = mapped_column(ForeignKey("authors.id"))
    author: Mapped["Author"] = relationship(back_populates="profile")
`;

  it('links both sides through back_populates and reads a scalar reverse side as one-to-one', async () => {
    const schema: IrSchema = await parse(PAIR);
    expect(relation(schema, 'Book', 'author')).toMatchObject({
      kind: 'foreignKey',
      relatedName: 'books',
    });
    expect(relation(schema, 'Profile', 'author')).toMatchObject({
      kind: 'oneToOne',
      relatedName: 'profile',
    });
    expect(model(schema, 'Author').relations).toEqual([]);
    expect(schema.warnings).toEqual([]);
  });

  it('reads uselist=False as one-to-one', async () => {
    const schema: IrSchema = await parse(`
${HEADER}
class Author(Base):
    __tablename__ = "authors"
    id: Mapped[int] = mapped_column(primary_key=True)
    profile = relationship("Profile", uselist=False, back_populates="author")

class Profile(Base):
    __tablename__ = "profiles"
    id: Mapped[int] = mapped_column(primary_key=True)
    author_id: Mapped[int] = mapped_column(ForeignKey("authors.id"))
    author = relationship("Author", back_populates="profile")
`);
    expect(relation(schema, 'Profile', 'author')).toMatchObject({
      kind: 'oneToOne',
      relatedName: 'profile',
    });
  });

  it('creates the other side of backref="name" and backref(...)', async () => {
    const schema: IrSchema = await parse(`
${HEADER}
class Author(Base):
    __tablename__ = "authors"
    id: Mapped[int] = mapped_column(primary_key=True)
    books = relationship("Book", backref="author")
    profile = relationship("Profile", backref=backref("owner", uselist=False))

class Book(Base):
    __tablename__ = "books"
    id: Mapped[int] = mapped_column(primary_key=True)
    author_id: Mapped[int] = mapped_column(ForeignKey("authors.id"))

class Profile(Base):
    __tablename__ = "profiles"
    id: Mapped[int] = mapped_column(primary_key=True)
    owner_id: Mapped[int] = mapped_column(ForeignKey("authors.id"))
`);
    expect(relation(schema, 'Book', 'author')).toMatchObject({
      kind: 'foreignKey',
      relatedName: 'books',
    });
    expect(relation(schema, 'Profile', 'owner')).toMatchObject({
      relatedName: 'profile',
    });
    expect(schema.warnings).toEqual([]);
  });

  it('keeps the name of a backref when the owning relationship is declared on the other side', async () => {
    const schema: IrSchema = await parse(`
${HEADER}
class Author(Base):
    __tablename__ = "authors"
    id: Mapped[int] = mapped_column(primary_key=True)

class Book(Base):
    __tablename__ = "books"
    id: Mapped[int] = mapped_column(primary_key=True)
    author_id: Mapped[int] = mapped_column(ForeignKey("authors.id"))
    author = relationship("Author", backref="books")
`);
    expect(relation(schema, 'Book', 'author').relatedName).toBe('books');
  });

  it('uses foreign_keys to tell several keys to the same table apart', async () => {
    const schema: IrSchema = await parse(`
${HEADER}
class User(Base):
    __tablename__ = "users"
    id: Mapped[int] = mapped_column(primary_key=True)
    written: Mapped[list["Post"]] = relationship(back_populates="writer", foreign_keys="Post.writer_id")
    edited: Mapped[list["Post"]] = relationship(back_populates="editor", foreign_keys="[Post.editor_id]")

class Post(Base):
    __tablename__ = "posts"
    id: Mapped[int] = mapped_column(primary_key=True)
    writer_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    editor_id: Mapped[Optional[int]] = mapped_column(ForeignKey("users.id"))
    writer: Mapped["User"] = relationship(back_populates="written", foreign_keys=[writer_id])
    editor: Mapped[Optional["User"]] = relationship(back_populates="edited", foreign_keys=lambda: [Post.editor_id])
`);
    expect(relation(schema, 'Post', 'writer').relatedName).toBe('written');
    expect(relation(schema, 'Post', 'editor').relatedName).toBe('edited');
    expect(schema.warnings).toEqual([]);
  });

  it('matches the relationship to the key by name and warns when it is ambiguous', async () => {
    const schema: IrSchema = await parse(`
${HEADER}
class User(Base):
    __tablename__ = "users"
    id: Mapped[int] = mapped_column(primary_key=True)

class Post(Base):
    __tablename__ = "posts"
    id: Mapped[int] = mapped_column(primary_key=True)
    writer_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    editor_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    writer: Mapped["User"] = relationship()
    editor: Mapped["User"] = relationship()
`);
    expect(schema.models.length).toBe(2);
    expect(warningsMatching(schema, 'several foreign keys')).toHaveLength(2);
    expect(relation(schema, 'Post', 'writer').columnName).toBe('writer_id');
    expect(relation(schema, 'Post', 'editor').columnName).toBe('editor_id');
  });

  it('reads primaryjoin as a hint for the key', async () => {
    const schema: IrSchema = await parse(`
${HEADER}
class User(Base):
    __tablename__ = "users"
    id: Mapped[int] = mapped_column(primary_key=True)
    posts: Mapped[list["Post"]] = relationship(
        back_populates="writer", primaryjoin="User.id == foreign(Post.writer_id)"
    )

class Post(Base):
    __tablename__ = "posts"
    id: Mapped[int] = mapped_column(primary_key=True)
    writer_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    editor_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    writer: Mapped["User"] = relationship(
        back_populates="posts", primaryjoin="Post.writer_id == User.id"
    )
`);
    expect(relation(schema, 'Post', 'writer')).toMatchObject({
      columnName: 'writer_id',
      relatedName: 'posts',
    });
  });

  it('reads a self reference with remote_side as the owning side', async () => {
    const schema: IrSchema = await parse(`
${HEADER}
class Node(Base):
    __tablename__ = "nodes"
    id: Mapped[int] = mapped_column(primary_key=True)
    parent_id: Mapped[Optional[int]] = mapped_column(ForeignKey("nodes.id"))
    parent: Mapped[Optional["Node"]] = relationship(back_populates="children", remote_side=[id])
    children: Mapped[list["Node"]] = relationship(back_populates="parent")
`);
    expect(relation(schema, 'Node', 'parent')).toMatchObject({
      targetModel: 'Node',
      relatedName: 'children',
      isNullable: true,
    });
  });

  it('reads remote_side given as a string', async () => {
    const schema: IrSchema = await parse(`
${HEADER}
class Node(Base):
    __tablename__ = "nodes"
    id: Mapped[int] = mapped_column(primary_key=True)
    parent_id: Mapped[Optional[int]] = mapped_column(ForeignKey("nodes.id"))
    parent = relationship("Node", remote_side="Node.id", backref="kids")
`);
    expect(relation(schema, 'Node', 'parent').relatedName).toBe('kids');
  });

  it('accepts forward references written as strings, lambdas and dotted paths', async () => {
    const schema: IrSchema = await parse(`
${HEADER}
class Author(Base):
    __tablename__ = "authors"
    id: Mapped[int] = mapped_column(primary_key=True)
    a = relationship("app.models.Book", back_populates="x")
    b = relationship(lambda: Book, viewonly=True)
    c: "Mapped[list[Book]]" = relationship(viewonly=True)

class Book(Base):
    __tablename__ = "books"
    id: Mapped[int] = mapped_column(primary_key=True)
    author_id: Mapped[int] = mapped_column(ForeignKey("authors.id"))
    x: "Mapped[Author]" = relationship(back_populates="a")
`);
    expect(model(schema, 'Book').relations).toHaveLength(1);
    expect(relation(schema, 'Book', 'x')).toMatchObject({
      targetModel: 'Author',
      relatedName: 'a',
    });
    expect(schema.warnings).toEqual([]);
  });

  it('warns about a relationship to an unknown model or one without a key', async () => {
    const schema: IrSchema = await parse(`
${HEADER}
class Thing(Base):
    __tablename__ = "things"
    id: Mapped[int] = mapped_column(primary_key=True)
    ghost = relationship("Ghost")
    other: Mapped["Other"] = relationship()
    nothing = relationship(compute())

class Other(Base):
    __tablename__ = "others"
    id: Mapped[int] = mapped_column(primary_key=True)
`);
    expect(warningsMatching(schema, 'Thing.ghost')).toHaveLength(1);
    expect(
      warningsMatching(schema, 'no foreign key links Thing and Other')
    ).toHaveLength(1);
    expect(warningsMatching(schema, 'Thing.nothing')).toHaveLength(1);
  });

  it('ignores viewonly relationships when linking sides', async () => {
    const schema: IrSchema = await parse(`
${HEADER}
class Author(Base):
    __tablename__ = "authors"
    id: Mapped[int] = mapped_column(primary_key=True)
    books: Mapped[list["Book"]] = relationship(back_populates="author")
    recent: Mapped[list["Book"]] = relationship(viewonly=True)

class Book(Base):
    __tablename__ = "books"
    id: Mapped[int] = mapped_column(primary_key=True)
    author_id: Mapped[int] = mapped_column(ForeignKey("authors.id"))
    author: Mapped["Author"] = relationship(back_populates="books")
`);
    expect(relation(schema, 'Book', 'author').relatedName).toBe('books');
  });
});

describe('many-to-many', () => {
  const TABLES: string = `
${HEADER}
links = Table(
    "post_tags",
    Base.metadata,
    Column("post_id", ForeignKey("posts.id", ondelete="CASCADE"), primary_key=True),
    Column("tag_id", ForeignKey("tags.id"), primary_key=True),
)
`;

  it('reads secondary=Table as one many-to-many with the other side as its related name', async () => {
    const schema: IrSchema = await parse(`
${TABLES}
class Post(Base):
    __tablename__ = "posts"
    id: Mapped[int] = mapped_column(primary_key=True)
    tags: Mapped[list["Tag"]] = relationship(secondary=links, back_populates="posts")

class Tag(Base):
    __tablename__ = "tags"
    id: Mapped[int] = mapped_column(primary_key=True)
    posts: Mapped[list["Post"]] = relationship(secondary=links, back_populates="tags")
`);
    expect(relation(schema, 'Post', 'tags')).toEqual({
      name: 'tags',
      kind: 'manyToMany',
      targetModel: 'Tag',
      columnName: '',
      isNullable: false,
      onDelete: 'cascade',
      relatedName: 'posts',
    });
    expect(model(schema, 'Tag').relations).toEqual([]);
    expect(schema.models.map((item: IrModel) => item.name)).toEqual([
      'Post',
      'Tag',
    ]);
    expect(schema.warnings).toEqual([]);
  });

  it('accepts the table by name or as a lambda, and backref on one side', async () => {
    const schema: IrSchema = await parse(`
${TABLES}
class Post(Base):
    __tablename__ = "posts"
    id: Mapped[int] = mapped_column(primary_key=True)
    tags = relationship("Tag", secondary="post_tags", backref="posts")

class Tag(Base):
    __tablename__ = "tags"
    id: Mapped[int] = mapped_column(primary_key=True)
    other = relationship("Post", secondary=lambda: links, viewonly=True)
`);
    expect(relation(schema, 'Post', 'tags')).toMatchObject({
      kind: 'manyToMany',
      relatedName: 'posts',
    });
    expect(schema.models).toHaveLength(2);
  });

  it('keeps a one-sided many-to-many and reads a self-referential pair', async () => {
    const schema: IrSchema = await parse(`
${HEADER}
follows = Table(
    "follows",
    Base.metadata,
    Column("follower_id", ForeignKey("people.id"), primary_key=True),
    Column("followed_id", ForeignKey("people.id"), primary_key=True),
)

class Person(Base):
    __tablename__ = "people"
    id: Mapped[int] = mapped_column(primary_key=True)
    following: Mapped[list["Person"]] = relationship(
        secondary=follows,
        primaryjoin=id == follows.c.follower_id,
        secondaryjoin=id == follows.c.followed_id,
        back_populates="followers",
    )
    followers: Mapped[list["Person"]] = relationship(
        secondary=follows,
        primaryjoin=id == follows.c.followed_id,
        secondaryjoin=id == follows.c.follower_id,
        back_populates="following",
    )
`);
    expect(model(schema, 'Person').relations).toEqual([
      expect.objectContaining({
        name: 'following',
        kind: 'manyToMany',
        targetModel: 'Person',
        relatedName: 'followers',
      }),
    ]);
    const oneSided: IrSchema = await parse(`
${TABLES}
class Post(Base):
    __tablename__ = "posts"
    id: Mapped[int] = mapped_column(primary_key=True)
    tags: Mapped[list["Tag"]] = relationship(secondary=links)

class Tag(Base):
    __tablename__ = "tags"
    id: Mapped[int] = mapped_column(primary_key=True)
`);
    expect(relation(oneSided, 'Post', 'tags').relatedName).toBeUndefined();
  });

  it('warns about an association table that is not in the input', async () => {
    const schema: IrSchema = await parse(`
${HEADER}
class Post(Base):
    __tablename__ = "posts"
    id: Mapped[int] = mapped_column(primary_key=True)
    tags: Mapped[list["Tag"]] = relationship(secondary="missing_table")

class Tag(Base):
    __tablename__ = "tags"
    id: Mapped[int] = mapped_column(primary_key=True)
`);
    expect(relation(schema, 'Post', 'tags').kind).toBe('manyToMany');
    expect(warningsMatching(schema, '"missing_table"')).toHaveLength(1);
  });

  it('warns about extra columns on an association table and keeps the relation', async () => {
    const schema: IrSchema = await parse(`
${HEADER}
links = Table(
    "post_tags",
    Base.metadata,
    Column("post_id", ForeignKey("posts.id"), primary_key=True),
    Column("tag_id", ForeignKey("tags.id"), primary_key=True),
    Column("weight", Integer),
)

class Post(Base):
    __tablename__ = "posts"
    id: Mapped[int] = mapped_column(primary_key=True)
    tags: Mapped[list["Tag"]] = relationship(secondary=links)

class Tag(Base):
    __tablename__ = "tags"
    id: Mapped[int] = mapped_column(primary_key=True)
`);
    expect(relation(schema, 'Post', 'tags').kind).toBe('manyToMany');
    expect(
      warningsMatching(schema, 'columns besides its two foreign keys')
    ).toHaveLength(1);
  });

  it('keeps an association object (a class with its own columns) as an ordinary model', async () => {
    const schema: IrSchema = await parse(`
${HEADER}
class Post(Base):
    __tablename__ = "posts"
    id: Mapped[int] = mapped_column(primary_key=True)
    links: Mapped[list["PostTag"]] = relationship(back_populates="post")

class Tag(Base):
    __tablename__ = "tags"
    id: Mapped[int] = mapped_column(primary_key=True)

class PostTag(Base):
    __tablename__ = "post_tags"
    post_id: Mapped[int] = mapped_column(ForeignKey("posts.id"), primary_key=True)
    tag_id: Mapped[int] = mapped_column(ForeignKey("tags.id"), primary_key=True)
    weight: Mapped[int] = mapped_column(default=1)
    post: Mapped["Post"] = relationship(back_populates="links")
`);
    expect(model(schema, 'PostTag').compositePrimaryKey).toEqual([
      'post',
      'tag',
    ]);
    expect(relation(schema, 'PostTag', 'post').relatedName).toBe('links');
    expect(field(schema, 'PostTag', 'weight').default).toEqual({
      kind: 'literal',
      value: 1,
    });
  });

  it('converts a Table that is neither mapped nor a secondary table, with a warning', async () => {
    const schema: IrSchema = await parse(`
${HEADER}
audit_log = Table(
    "audit_logs",
    Base.metadata,
    Column("id", Integer, primary_key=True),
    Column("message", Text, nullable=False),
    Index("ix_audit_message", "message"),
    schema="audit",
)
`);
    expect(model(schema, 'AuditLog')).toMatchObject({
      tableName: 'audit_logs',
      schema: 'audit',
    });
    expect(model(schema, 'AuditLog').indexes[0]?.name).toBe('ix_audit_message');
    expect(warningsMatching(schema, 'not mapped to a class')).toHaveLength(1);
  });

  it('names a Table after the class mapped to it imperatively', async () => {
    const schema: IrSchema = await parse(`
mapper_registry = registry()

user_table = Table("users", mapper_registry.metadata, Column("id", Integer, primary_key=True), Column("name", String(20)))

class User:
    pass

mapper_registry.map_imperatively(User, user_table, properties={"x": 1})
`);
    expect(model(schema, 'User')).toMatchObject({ tableName: 'users' });
    expect(field(schema, 'User', 'name').maxLength).toBe(20);
    expect(
      warningsMatching(schema, 'properties of map_imperatively')
    ).toHaveLength(1);
    expect(warningsMatching(schema, 'not mapped to a class')).toEqual([]);
  });

  it('reads __table__ = Table(...) in a declarative class', async () => {
    const schema: IrSchema = await parse(`
class Thing(Base):
    __table__ = Table("things", Base.metadata, Column("id", Integer, primary_key=True), Column("name", String(9)))
`);
    expect(model(schema, 'Thing').tableName).toBe('things');
    expect(field(schema, 'Thing', 'name').maxLength).toBe(9);
  });
});

describe('SQLModel', () => {
  it('reads table=True classes and ignores plain SQLModel classes', async () => {
    const schema: IrSchema = await parse(`
class HeroBase(SQLModel):
    name: str = Field(index=True)
    secret_name: str

class Hero(HeroBase, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    age: Optional[int] = None

class HeroCreate(HeroBase):
    password: str
`);
    expect(schema.models.map((item: IrModel) => item.name)).toEqual(['Hero']);
    expect(model(schema, 'Hero').tableName).toBe('hero');
    expect(
      model(schema, 'Hero').fields.map((item: IrField) => item.name)
    ).toEqual(['name', 'secret_name', 'id', 'age']);
    expect(field(schema, 'Hero', 'name').type).toBe('string');
    expect(field(schema, 'Hero', 'age').isNullable).toBe(true);
    expect(field(schema, 'Hero', 'secret_name').isNullable).toBe(false);
    expect(model(schema, 'Hero').indexes).toEqual([
      { fields: ['name'], isUnique: false },
    ]);
    expect(field(schema, 'Hero', 'id').default).toEqual({
      kind: 'autoIncrement',
    });
  });

  it('reads Field options: keys, length, digits, defaults and foreign keys', async () => {
    const schema: IrSchema = await parse(`
class Team(SQLModel, table=True):
    __tablename__ = "teams"
    id: int = Field(primary_key=True)

class Hero(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    code: str = Field(max_length=12, unique=True)
    score: Decimal = Field(max_digits=8, decimal_places=2, default=Decimal("1.5"))
    level: int = Field(default=3)
    alias: Optional[str] = Field(default=None, nullable=False)
    stamp: datetime = Field(default_factory=datetime.utcnow)
    token: uuid.UUID = Field(default_factory=uuid.uuid4)
    team_id: Optional[int] = Field(default=None, foreign_key="teams.id", ondelete="SET NULL")
    rival_id: int = Field(foreign_key="teams.id")
    active: bool = True
    nickname: str = "anon"
`);
    expect(field(schema, 'Hero', 'code')).toMatchObject({
      maxLength: 12,
      isUnique: true,
    });
    expect(field(schema, 'Hero', 'score')).toMatchObject({
      type: 'decimal',
      maxDigits: 8,
      decimalPlaces: 2,
      default: { kind: 'literal', value: 1.5 },
    });
    expect(field(schema, 'Hero', 'level').default).toEqual({
      kind: 'literal',
      value: 3,
    });
    expect(field(schema, 'Hero', 'alias').isNullable).toBe(false);
    expect(field(schema, 'Hero', 'stamp').default).toEqual({ kind: 'now' });
    expect(field(schema, 'Hero', 'token').default).toEqual({ kind: 'uuid' });
    expect(relation(schema, 'Hero', 'team')).toMatchObject({
      targetModel: 'Team',
      onDelete: 'setNull',
      isNullable: true,
    });
    expect(relation(schema, 'Hero', 'rival')).toMatchObject({
      isNullable: false,
    });
    expect(field(schema, 'Hero', 'active').default).toEqual({
      kind: 'literal',
      value: true,
    });
    expect(field(schema, 'Hero', 'nickname').default).toEqual({
      kind: 'literal',
      value: 'anon',
    });
  });

  it('reads sa_column, sa_type, sa_column_kwargs and sa_column_args', async () => {
    const schema: IrSchema = await parse(`
class Hero(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    data: dict = Field(default_factory=dict, sa_column=Column("payload", JSON, nullable=False))
    body: str = Field(sa_type=Text)
    stamp: datetime = Field(
        default_factory=datetime.utcnow,
        sa_type=DateTime(timezone=True),
        sa_column_kwargs={"server_default": func.now(), "onupdate": func.now(), "unique": True},
    )
    code: str = Field(sa_column_args=[String(7)])
`);
    expect(field(schema, 'Hero', 'data')).toMatchObject({
      columnName: 'payload',
      type: 'json',
      isNullable: false,
    });
    expect(field(schema, 'Hero', 'body').type).toBe('text');
    expect(field(schema, 'Hero', 'stamp')).toMatchObject({
      type: 'dateTime',
      isAutoUpdated: true,
      isUnique: true,
    });
    expect(field(schema, 'Hero', 'code')).toMatchObject({
      type: 'string',
      maxLength: 7,
    });
  });

  it('reads Relationship with back_populates, sa_relationship_kwargs and link_model', async () => {
    const schema: IrSchema = await parse(`
class HeroTeamLink(SQLModel, table=True):
    team_id: Optional[int] = Field(default=None, foreign_key="team.id", primary_key=True)
    hero_id: Optional[int] = Field(default=None, foreign_key="hero.id", primary_key=True)

class Team(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    heroes: List["Hero"] = Relationship(back_populates="teams", link_model=HeroTeamLink)
    captain_of: List["Hero"] = Relationship(
        back_populates="captain", sa_relationship_kwargs={"foreign_keys": "[Hero.captain_id]"}
    )

class Hero(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    captain_id: Optional[int] = Field(default=None, foreign_key="team.id")
    captain: Optional[Team] = Relationship(
        back_populates="captain_of", sa_relationship_kwargs={"foreign_keys": "[Hero.captain_id]"}
    )
    teams: List[Team] = Relationship(back_populates="heroes", link_model=HeroTeamLink)
`);
    expect(schema.models.map((item: IrModel) => item.name)).toEqual([
      'Team',
      'Hero',
    ]);
    expect(relation(schema, 'Team', 'heroes')).toMatchObject({
      kind: 'manyToMany',
      targetModel: 'Hero',
      relatedName: 'teams',
    });
    expect(relation(schema, 'Hero', 'captain')).toMatchObject({
      relatedName: 'captain_of',
      isNullable: true,
    });
    expect(schema.warnings).toEqual([]);
  });

  it('keeps a link model with extra columns as an ordinary model and skips the many-to-many', async () => {
    const schema: IrSchema = await parse(`
class Link(SQLModel, table=True):
    team_id: Optional[int] = Field(default=None, foreign_key="team.id", primary_key=True)
    hero_id: Optional[int] = Field(default=None, foreign_key="hero.id", primary_key=True)
    since: int = 0

class Team(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    heroes: List["Hero"] = Relationship(back_populates="teams", link_model=Link)

class Hero(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    teams: List[Team] = Relationship(back_populates="heroes", link_model=Link)
`);
    expect(schema.models.map((item: IrModel) => item.name).sort()).toEqual([
      'Hero',
      'Link',
      'Team',
    ]);
    expect(model(schema, 'Team').relations).toEqual([]);
    expect(warningsMatching(schema, 'link model Link')).toHaveLength(2);
  });

  it('does not read ClassVar annotations or pydantic-only fields of plain classes as columns', async () => {
    const schema: IrSchema = await parse(`
class Hero(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    registry: ClassVar[dict] = {}

    def shout(self) -> str:
        return "x"
`);
    expect(
      model(schema, 'Hero').fields.map((item: IrField) => item.name)
    ).toEqual(['id']);
  });
});

describe('inheritance of abstract and mixin members', () => {
  it('copies the columns of abstract bases, mixins and Annotated aliases into every subclass', async () => {
    const schema: IrSchema = await parse(`
${HEADER}
stamp = Annotated[datetime, mapped_column(DateTime, server_default=func.now())]

class AuditMixin:
    created_at: Mapped[stamp]
    created_by: Mapped[Optional[str]] = mapped_column(String(20))

class A(AuditMixin, Base):
    __tablename__ = "a"
    id: Mapped[int] = mapped_column(primary_key=True)

class B(AuditMixin, Base):
    __tablename__ = "b"
    id: Mapped[int] = mapped_column(primary_key=True)
`);
    for (const name of ['A', 'B']) {
      expect(field(schema, name, 'created_at')).toMatchObject({
        type: 'dateTime',
        default: { kind: 'now' },
        isDbDefault: true,
      });
      expect(field(schema, name, 'created_by').maxLength).toBe(20);
    }
  });

  it('reads MappedAsDataclass models and dataclass arguments', async () => {
    const schema: IrSchema = await parse(`
class Base(MappedAsDataclass, DeclarativeBase):
    pass

class Note(Base):
    __tablename__ = "notes"
    id: Mapped[int] = mapped_column(init=False, primary_key=True)
    text_: Mapped[str] = mapped_column("text", Text)
    pinned: Mapped[bool] = mapped_column(default=False, kw_only=True)
    tags: Mapped[dict] = mapped_column(JSON, default_factory=dict)
`);
    expect(field(schema, 'Note', 'text_').columnName).toBe('text');
    expect(field(schema, 'Note', 'pinned').default).toEqual({
      kind: 'literal',
      value: false,
    });
    expect(field(schema, 'Note', 'tags').default).toEqual({
      kind: 'literal',
      value: '{}',
    });
  });

  it('ignores helper members that are not columns', async () => {
    const schema: IrSchema = await parse(
      single(`
name: Mapped[str]
full: Mapped[str] = column_property(name + "x")
upper = association_proxy("name", "upper")

@hybrid_property
def shout(self):
    return self.name

def helper(self):
    return 1

class Config:
    extra = 1
`)
    );
    expect(
      model(schema, 'Thing').fields.map((item: IrField) => item.name)
    ).toEqual(['id', 'name']);
    expect(warningsMatching(schema, 'column_property')).toHaveLength(1);
  });
});

describe('input problems', () => {
  it('warns about syntax errors but keeps the models it can read', async () => {
    const schema: IrSchema = await parse(`
${single('a: Mapped[int]')}

def broken(:
    pass
`);
    expect(
      model(schema, 'Thing').fields.map((item: IrField) => item.name)
    ).toContain('a');
    expect(warningsMatching(schema, 'syntax errors')).toHaveLength(1);
  });

  it('returns an error rather than throwing for empty, binary and non-Python input', async () => {
    const inputs: string[] = [
      '',
      '\u0000\u0001\u0002',
      '{"json": true}',
      '<?php echo 1;',
      'class',
      'class X(',
      '@',
      ')))(((',
    ];
    for (const text of inputs) {
      const result = await parseSqlAlchemy([{ path: 'x.py', text }], {
        appLabel: 'app',
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('NO_MODELS_FOUND');
      }
    }
    const none = await parseSqlAlchemy([], { appLabel: 'app' });
    expect(none.ok).toBe(false);
  });

  it('survives values of the wrong type', async () => {
    const weird = [
      { path: 'a.py', text: undefined as unknown as string },
      { path: 'b.py', text: 42 as unknown as string },
    ];
    const result = await parseSqlAlchemy(weird, { appLabel: 'app' });
    expect(result.ok).toBe(false);
  });

  it('skips a file larger than the limit with a warning', async () => {
    const huge: string = `${single('')}\n# ${'x'.repeat(2_100_000)}\n`;
    const schema: IrSchema = await parse(
      single('').replace('Thing', 'Small'),
      huge
    );
    expect(schema.models.map((item: IrModel) => item.name)).toEqual(['Small']);
    expect(warningsMatching(schema, 'larger than')).toHaveLength(1);
  });

  it('survives hostile nesting and very long expressions quickly', async () => {
    const depth: number = 20_000;
    const nestedCalls: string = `${'f('.repeat(depth)}1${')'.repeat(depth)}`;
    const nestedLists: string = `${'['.repeat(depth)}${']'.repeat(depth)}`;
    const nestedParens: string = `${'('.repeat(depth)}1${')'.repeat(depth)}`;
    const union: string = Array.from({ length: 5_000 }, () => 'int').join(
      ' | '
    );
    const started: number = Date.now();
    const schema: IrSchema = await parse(
      single(`
a: Mapped[int] = mapped_column(default=${nestedCalls})
b: Mapped[int] = mapped_column(default=${nestedLists})
c: Mapped[int] = mapped_column(default=${nestedParens})
d: Mapped[${union}]
e: Mapped[${'Optional['.repeat(3_000)}int${']'.repeat(3_000)}]
f: Mapped["${'Optional['.repeat(500)}int${']'.repeat(500)}"]
`)
    );
    expect(model(schema, 'Thing').fields.length).toBeGreaterThan(0);
    expect(Date.now() - started).toBeLessThan(20_000);
  }, 30_000);

  it('handles many classes, columns and relationships in linear time', async () => {
    const lines: string[] = [HEADER];
    for (let index: number = 0; index < 600; index += 1) {
      lines.push(`
class M${index}(Base):
    __tablename__ = "m${index}"
    id: Mapped[int] = mapped_column(primary_key=True)
    parent_id: Mapped[Optional[int]] = mapped_column(ForeignKey("m${Math.max(0, index - 1)}.id"))
    parent: Mapped[Optional["M${Math.max(0, index - 1)}"]] = relationship(back_populates="kids${index}")
${Array.from({ length: 20 }, (_unused, column: number) => `    c${column}: Mapped[str] = mapped_column(String(10), index=True)`).join('\n')}
`);
    }
    const started: number = Date.now();
    const schema: IrSchema = await parse(lines.join('\n'));
    expect(schema.models).toHaveLength(600);
    expect(Date.now() - started).toBeLessThan(20_000);
  }, 30_000);

  it('limits the number of warnings', async () => {
    const body: string = Array.from(
      { length: 800 },
      (_unused, index: number) =>
        `c${index}: Mapped[int] = mapped_column(default=bad${index}())`
    ).join('\n');
    const schema: IrSchema = await parse(single(body));
    expect(schema.warnings.length).toBeLessThanOrEqual(501);
    expect(schema.warnings[schema.warnings.length - 1]).toContain(
      'more warnings were left out'
    );
  });

  it('caps the columns of a single table', async () => {
    const body: string = Array.from(
      { length: 2_500 },
      (_unused, index: number) => `c${index}: Mapped[int]`
    ).join('\n');
    const schema: IrSchema = await parse(single(body));
    expect(model(schema, 'Thing').fields.length).toBeLessThanOrEqual(2_000);
    expect(warningsMatching(schema, 'more than 2000 columns')).toHaveLength(1);
  });
});

describe('canonical fixtures in three styles', () => {
  const root: string = fileURLToPath(new URL('./fixtures/', import.meta.url));

  function readTree(directory: string): SqlAlchemySourceFile[] {
    return readdirSync(directory)
      .sort()
      .flatMap((name: string): SqlAlchemySourceFile[] => {
        const path: string = join(directory, name);
        if (statSync(path).isDirectory()) {
          return readTree(path);
        }
        return name.endsWith('.py')
          ? [{ path, text: readFileSync(path, 'utf8') }]
          : [];
      });
  }

  async function parseTree(name: string): Promise<IrSchema> {
    return expectOk(
      await parseSqlAlchemy(readTree(join(root, name)), { appLabel: 'blog' })
    );
  }

  function sorted(schema: IrSchema): IrSchema {
    return {
      ...schema,
      models: [...schema.models].sort((first: IrModel, second: IrModel) =>
        first.name.localeCompare(second.name)
      ),
      warnings: [],
    };
  }

  it('reads the SQLAlchemy 2.0 package into the blog schema', async () => {
    const schema: IrSchema = await parseTree('sqlalchemy');
    expect(schema.warnings).toEqual([]);
    expect(schema.models.map((item: IrModel) => item.name).sort()).toEqual([
      'Category',
      'Post',
      'Profile',
      'Tag',
      'User',
    ]);
    expect(model(schema, 'Post').tableName).toBe('blog_post');
    expect(field(schema, 'Post', 'status')).toMatchObject({
      enumName: 'PostStatus',
      default: { kind: 'enumValue', value: 'DRAFT' },
    });
    expect(field(schema, 'Post', 'metadata_').columnName).toBe('metadata');
    expect(model(schema, 'Post').indexes).toEqual([
      { fields: ['title'], isUnique: false },
      { fields: ['author', 'title'], isUnique: true },
      {
        fields: ['published_at', 'status'],
        isUnique: false,
        name: 'post_pub_status_idx',
      },
    ]);
    expect(relation(schema, 'Post', 'tags')).toMatchObject({
      kind: 'manyToMany',
      relatedName: 'posts',
    });
    expect(relation(schema, 'Profile', 'user')).toMatchObject({
      kind: 'oneToOne',
      relatedName: 'profile',
    });
    expect(relation(schema, 'Category', 'parent')).toMatchObject({
      isNullable: true,
      onDelete: 'setNull',
      relatedName: 'children',
    });
    expect(schema.enums).toEqual([
      {
        name: 'PostStatus',
        values: [
          { name: 'DRAFT', dbValue: 'draft' },
          { name: 'PUBLISHED', dbValue: 'published' },
        ],
      },
    ]);
  });

  it('reads the SQLModel version into the same schema', async () => {
    const reference: IrSchema = await parseTree('sqlalchemy');
    const schema: IrSchema = await parseTree('sqlalchemy-sqlmodel');
    expect(schema.warnings).toEqual([]);
    expect(sorted(schema)).toEqual(sorted(reference));
  });

  it('reads the classic Column() version into the same schema', async () => {
    const reference: IrSchema = await parseTree('sqlalchemy');
    const schema: IrSchema = await parseTree('sqlalchemy-classic');
    expect(schema.warnings).toEqual([]);
    expect(sorted(schema)).toEqual(sorted(reference));
  });

  it('reads the files in the canonical fixture registry', () => {
    expect(loadCanonicalSources('sqlalchemy')).toHaveLength(7);
  });
});

describe('extras fixture', () => {
  const directory: string = fileURLToPath(
    new URL('./fixtures/sqlalchemy-extras', import.meta.url)
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

  function extrasSources(file: string): SqlAlchemySourceFile[] {
    return [
      {
        path: `${directory}/${file}`,
        text: readFileSync(`${directory}/${file}`, 'utf8'),
      },
    ];
  }

  async function convertExtras(
    file: string,
    to: string
  ): Promise<ConvertResult> {
    return expectOk(
      await convertText(extrasSources(file), {
        ...DEFAULT_OPTIONS,
        appLabel: 'shop',
        from: 'sqlalchemy',
        to,
      })
    );
  }

  it('reads the advanced constructs into the IR', async () => {
    const schema: IrSchema = expectOk(
      await parseSqlAlchemy(extrasSources('shop.py'), { appLabel: 'shop' })
    );
    expect(schema.models.map((item: IrModel) => item.name).sort()).toEqual([
      'Address',
      'AuditLog',
      'Book',
      'Customer',
      'Invoice',
      'LineItem',
      'Note',
      'Product',
      'Review',
      'Warehouse',
    ]);
    expect(model(schema, 'Invoice').tableName).toBe('invoice');
    expect(model(schema, 'Address').compositePrimaryKey).toEqual([
      'customer',
      'kind',
    ]);
    expect(model(schema, 'LineItem').compositePrimaryKey).toEqual([
      'invoice',
      'product',
    ]);
    const composite: IrCompositeForeignKey | undefined = model(
      schema,
      'Invoice'
    ).compositeForeignKeys?.[0];
    expect(composite).toMatchObject({
      targetModel: 'Warehouse',
      fields: ['ship_region', 'ship_code'],
      references: ['region', 'code'],
      onDelete: 'setNull',
      constraintName: 'fk_invoice_ship',
    });
    expect(relation(schema, 'Customer', 'referrer')).toMatchObject({
      onDelete: 'setNull',
      onUpdate: 'cascade',
      relatedName: 'referrals',
    });
    expect(relation(schema, 'Customer', 'following')).toMatchObject({
      kind: 'manyToMany',
      relatedName: 'followers',
    });
    expect(relation(schema, 'Book', 'id')).toMatchObject({
      kind: 'oneToOne',
      isPrimaryKey: true,
      targetModel: 'Product',
    });
    expect(relation(schema, 'Review', 'product').relatedName).toBe('reviews');
    expect(field(schema, 'Invoice', 'total').generated).toEqual({
      expression: 'subtotal + tax',
      isStored: true,
    });
    expect(field(schema, 'Customer', 'created_at')).toMatchObject({
      default: { kind: 'now' },
      isDbDefault: true,
    });
    expect(field(schema, 'Customer', 'credit')).toMatchObject({
      type: 'decimal',
      maxDigits: 12,
      decimalPlaces: 2,
    });
    expect(schema.enums.map((item: IrEnum) => item.name).sort()).toEqual([
      'Currency',
      'CustomerTier',
      'InvoiceState',
    ]);
    expect(model(schema, 'Customer').indexes).toEqual([
      {
        fields: ['email', 'name'],
        isUnique: true,
        name: 'uq_customers_email_name',
      },
    ]);
  });

  it('reads the PostgreSQL constructs', async () => {
    const schema: IrSchema = expectOk(
      await parseSqlAlchemy(extrasSources('postgres.py'), { appLabel: 'shop' })
    );
    expect(model(schema, 'Device').schema).toBe('inventory');
    expect(field(schema, 'Device', 'tags')).toMatchObject({
      arrayDepth: 1,
      maxLength: 30,
    });
    expect(field(schema, 'Device', 'grid').arrayDepth).toBe(2);
    expect(field(schema, 'Device', 'window')).toMatchObject({
      type: 'range',
      rangeOf: 'int',
    });
    expect(field(schema, 'Device', 'shape').type).toBe('unsupported');
    expect(field(schema, 'Device', 'id').default).toEqual({ kind: 'uuid' });
    expect(schema.enums[0]).toMatchObject({ name: 'Mood', dbName: 'mood' });
    expect(relation(schema, 'Device', 'owner').relatedName).toBe('devices');
    expect(model(schema, 'Device').indexes).toEqual([
      {
        fields: ['tags'],
        isUnique: false,
        name: 'ix_devices_tags',
        method: 'gin',
      },
    ]);
  });

  it('reads the directory as one project', async () => {
    const summary = expectOk(
      await runConversion({
        ...DEFAULT_OPTIONS,
        from: 'sqlalchemy',
        to: 'prisma',
        inputs: [directory],
      })
    );
    expect(summary.inputFiles).toHaveLength(2);
    expect(summary.modelCount).toBe(12);
  });

  it('matches the Prisma and Django goldens', async () => {
    expectMatchesExtrasGolden(
      'sqlalchemy-to-prisma.txt',
      (await convertExtras('shop.py', 'prisma')).output
    );
    expectMatchesExtrasGolden(
      'sqlalchemy-to-django.txt',
      (await convertExtras('shop.py', 'django')).output
    );
    expectMatchesExtrasGolden(
      'sqlalchemy-postgres-to-sql.txt',
      (await convertExtras('postgres.py', 'sql')).output
    );
  });

  it('matches the warnings golden', async () => {
    const shop: ConvertResult = await convertExtras('shop.py', 'prisma');
    const postgres: ConvertResult = await convertExtras(
      'postgres.py',
      'prisma'
    );
    expectMatchesExtrasGolden(
      'sqlalchemy-warnings.txt',
      [...shop.warnings, '---', ...postgres.warnings]
        .map((warning: string) => `${warning}\n`)
        .join('')
    );
  });
});
