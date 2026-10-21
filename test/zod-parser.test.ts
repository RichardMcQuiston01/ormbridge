import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { convertText } from '../src/convert.js';
import { getFormat, getFormatByExtension } from '../src/formats.js';
import type {
  IrEnum,
  IrField,
  IrModel,
  IrRelation,
  IrSchema,
} from '../src/ir.js';
import { runConversion } from '../src/io.js';
import { parseZod, type ZodSourceFile } from '../src/parsers/zod.js';
import { DEFAULT_OPTIONS, expectOk } from './helpers.js';

/** Parses Zod modules (the import line is optional). */
async function parse(...texts: string[]): Promise<IrSchema> {
  const sources: ZodSourceFile[] = texts.map(
    (text: string, index: number): ZodSourceFile => ({
      path: `schema${index}.ts`,
      text,
    })
  );
  return expectOk(await parseZod(sources, { appLabel: 'app' }));
}

function fixture(name: string): ZodSourceFile {
  const path: string = fileURLToPath(
    new URL(`./fixtures/zod-extras/${name}`, import.meta.url)
  );
  return { path, text: readFileSync(path, 'utf8') };
}

async function parseFixtures(...names: string[]): Promise<IrSchema> {
  return expectOk(await parseZod(names.map(fixture), { appLabel: 'app' }));
}

function model(schema: IrSchema, name: string): IrModel {
  const found: IrModel | undefined = schema.models.find(
    (candidate: IrModel) => candidate.name === name
  );
  if (found === undefined) {
    throw new Error(
      `Model ${name} was not parsed (got ${schema.models.map((m: IrModel) => m.name).join(', ')})`
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

function enumOf(schema: IrSchema, name: string): IrEnum {
  const found: IrEnum | undefined = schema.enums.find(
    (candidate: IrEnum) => candidate.name === name
  );
  if (found === undefined) {
    throw new Error(
      `Enum ${name} was not parsed (got ${schema.enums.map((e: IrEnum) => e.name).join(', ')})`
    );
  }
  return found;
}

function warningsMatching(schema: IrSchema, text: string): string[] {
  return schema.warnings.filter((warning: string) => warning.includes(text));
}

/** Wraps properties in a one-model module. */
function userModule(properties: string, imports: string = ''): string {
  return `import { z } from 'zod';\n${imports}\nexport const UserSchema = z.object({\n  id: z.number().int(),\n${properties}\n});`;
}

describe('zod adapter registration', () => {
  it('is registered as a readable and writable format that does not claim .ts', () => {
    const adapter = expectOk(getFormat('zod'));
    expect(adapter.parse).toBeDefined();
    expect(adapter.emit).toBeDefined();
    expect(adapter.extensions).toEqual([]);
    expect(getFormatByExtension('.ts')).toBeUndefined();
  });

  it('converts through convertText', async () => {
    const result = expectOk(
      await convertText(
        [
          {
            path: 'user.ts',
            text: userModule('  name: z.string().max(40),'),
          },
        ],
        { ...DEFAULT_OPTIONS, from: 'zod', to: 'prisma' }
      )
    );
    expect(result.modelCount).toBe(1);
    expect(result.output).toContain('model User {');
    expect(result.output).toContain('@db.VarChar(40)');
  });

  it('fails with a descriptive error when no schema is found', async () => {
    const result = await parseZod(
      [{ path: 'util.ts', text: 'export const answer = 42;' }],
      { appLabel: 'app' }
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('NO_MODELS_FOUND');
      expect(result.error.message).toContain('util.ts');
      expect(result.error.message).toContain('z.object');
    }
  });
});

describe('models', () => {
  it('strips a trailing Schema and keeps the property order', async () => {
    const schema: IrSchema = await parse(`
      import { z } from 'zod';
      export const UserSchema = z.object({ id: z.number().int(), b: z.string(), a: z.string() });
      const userProfileSchema = z.object({ id: z.number().int() });
      export const Account = z.object({ id: z.number().int() });
    `);
    expect(schema.models.map((m: IrModel) => m.name)).toEqual([
      'User',
      'UserProfile',
      'Account',
    ]);
    expect(model(schema, 'User').fields.map((f: IrField) => f.name)).toEqual([
      'id',
      'b',
      'a',
    ]);
    expect(model(schema, 'User').tableName).toBe('User');
    expect(model(schema, 'User').appLabel).toBe('app');
  });

  it('ignores types, plain objects and schemas that are not bound to a variable', async () => {
    const schema: IrSchema = await parse(`
      import { z } from 'zod';
      export const UserSchema = z.object({ id: z.number().int() });
      export type User = z.infer<typeof UserSchema>;
      export interface Other { id: number }
      export const config = { retries: 3 };
      export default z.object({ id: z.number() });
      function build() { return z.object({ id: z.number() }); }
    `);
    expect(schema.models.map((m: IrModel) => m.name)).toEqual(['User']);
  });

  it('names a clash with a number and warns', async () => {
    const schema: IrSchema = await parse(
      `export const UserSchema = z.object({ id: z.number().int() });`,
      `export const User = z.object({ id: z.number().int(), name: z.string() });`
    );
    expect(schema.models.map((m: IrModel) => m.name)).toEqual([
      'User',
      'User2',
    ]);
    expect(warningsMatching(schema, 'User')).not.toEqual([]);
  });

  it('reads files without imports, and the namespace under any local name', async () => {
    const aliased: IrSchema = await parse(
      `import { z as zod } from 'zod/v4';\nexport const ASchema = zod.object({ id: zod.int() });`,
      `import * as z from 'zod';\nexport const BSchema = z.object({ id: z.int() });`,
      `import z from 'zod';\nexport const CSchema = z.object({ id: z.int() });`,
      `import { object, int, string as str } from 'zod';\nexport const DSchema = object({ id: int(), name: str().max(9) });`
    );
    expect(aliased.models.map((m: IrModel) => m.name)).toEqual([
      'A',
      'B',
      'C',
      'D',
    ]);
    expect(field(aliased, 'D', 'name').maxLength).toBe(9);
    expect(field(aliased, 'A', 'id').type).toBe('int');
  });
});

describe('primary keys', () => {
  it('uses the property named id, in any case, and makes it required', async () => {
    const schema: IrSchema = await parse(`
      export const AschemaSchema = z.object({ id: z.number().int().optional() });
      export const BSchema = z.object({ ID: z.string().uuid() });
    `);
    expect(field(schema, 'Aschema', 'id').isPrimaryKey).toBe(true);
    expect(field(schema, 'Aschema', 'id').isNullable).toBe(false);
    expect(field(schema, 'B', 'ID').isPrimaryKey).toBe(true);
    expect(field(schema, 'B', 'ID').type).toBe('uuid');
  });

  it('warns that the model has no primary key when no property is named id', async () => {
    const schema: IrSchema = await parse(`
      export const TagSchema = z.object({ label: z.string() });
    `);
    expect(
      model(schema, 'Tag').fields.some((f: IrField) => f.isPrimaryKey)
    ).toBe(false);
    expect(
      warningsMatching(schema, 'Tag: Zod has no primary keys')
    ).toHaveLength(1);
  });
});

describe('Zod 3 types and modifiers', () => {
  it('maps the zod3-style fixture', async () => {
    const schema: IrSchema = await parseFixtures(
      'zod3-style.ts',
      'zod3-only.ts'
    );
    const expected: [string, Partial<IrField>][] = [
      ['id', { type: 'uuid', isPrimaryKey: true }],
      ['email', { type: 'string', maxLength: 120, isNullable: false }],
      ['handle', { type: 'string', maxLength: 30 }],
      ['age', { type: 'int', isNullable: true }],
      ['score', { type: 'float', isNullable: true }],
      ['ledger', { type: 'bigInt' }],
      [
        'active',
        {
          type: 'boolean',
          isNullable: false,
          default: { kind: 'literal', value: true },
        },
      ],
      ['joined', { type: 'dateTime' }],
      ['born', { type: 'date', isNullable: true }],
      ['seen', { type: 'dateTime', isNullable: true }],
      ['website', { type: 'text', isNullable: true }],
      ['bio', { type: 'text', isNullable: true }],
      ['tags', { type: 'text', arrayDepth: 1 }],
      ['scores', { type: 'int', arrayDepth: 1 }],
      ['grid', { type: 'float', arrayDepth: 2 }],
      ['settings', { type: 'json' }],
      ['extra', { type: 'json' }],
      [
        'role',
        {
          type: 'string',
          enumName: 'AccountRole',
          default: { kind: 'enumValue', value: 'member' },
        },
      ],
      ['kind', { type: 'string', enumName: 'AccountKind' }],
      ['plan', { type: 'string', enumName: 'AccountPlan' }],
      [
        'nickname',
        {
          type: 'text',
          isNullable: false,
          default: { kind: 'literal', value: 'anon' },
        },
      ],
      ['locale', { type: 'string', maxLength: 5 }],
      ['flag', { type: 'boolean' }],
      ['count', { type: 'int' }],
      ['stamp', { type: 'dateTime' }],
    ];
    for (const [name, wanted] of expected) {
      expect(field(schema, 'Account', name), `Account.${name}`).toMatchObject(
        wanted
      );
    }
    expect(field(schema, 'Host', 'address').type).toBe('ipAddress');
    expect(field(schema, 'Host', 'id').type).toBe('text');
  });

  it('reads string constants, TypeScript enums and unions of literals as enums', async () => {
    const schema: IrSchema = await parseFixtures('zod3-style.ts');
    expect(enumOf(schema, 'AccountRole').values).toEqual([
      { name: 'admin', dbValue: 'admin' },
      { name: 'member', dbValue: 'member' },
      { name: 'guest', dbValue: 'guest' },
    ]);
    expect(enumOf(schema, 'AccountPlan').values).toEqual([
      { name: 'Free', dbValue: 'free' },
      { name: 'Pro', dbValue: 'pro' },
    ]);
    expect(enumOf(schema, 'AccountKind').values.map((v) => v.dbValue)).toEqual([
      'person',
      'company',
    ]);
  });

  it('lists the dropped rules in one warning per schema, naming the properties', async () => {
    const schema: IrSchema = await parseFixtures('zod3-style.ts');
    const warnings: string[] = warningsMatching(schema, 'Account: Zod rules');
    expect(warnings).toHaveLength(1);
    const warning: string = warnings[0] ?? '';
    for (const expected of [
      'email (.email())',
      'handle (.min(3), .trim())',
      'age (.min(0))',
      'website (.url())',
      'token (.brand())',
      'checked (.refine(), .transform())',
    ]) {
      expect(warning).toContain(expected);
    }
    expect(warning).not.toContain('describe');
  });

  it('treats optional with a default as required, and nullable as nullable', async () => {
    const schema: IrSchema = await parse(
      userModule(`
        a: z.string().optional().default('x'),
        b: z.string().default('x').optional(),
        c: z.string().nullable().default('x'),
        d: z.string().nullish(),
        e: z.string().catch('y'),
      `)
    );
    expect(field(schema, 'User', 'a')).toMatchObject({ isNullable: false });
    expect(field(schema, 'User', 'b')).toMatchObject({ isNullable: false });
    expect(field(schema, 'User', 'c')).toMatchObject({ isNullable: true });
    expect(field(schema, 'User', 'd')).toMatchObject({ isNullable: true });
    expect(field(schema, 'User', 'e').default).toEqual({
      kind: 'literal',
      value: 'y',
    });
    expect(warningsMatching(schema, '.catch()')).toHaveLength(1);
  });

  it('reads defaults: literals, now, uuid and empty json', async () => {
    const schema: IrSchema = await parse(
      userModule(`
        n: z.number().default(5),
        s: z.string().default('a'),
        when: z.date().default(() => new Date()),
        stamp: z.coerce.date().default(() => new Date()),
        token: z.string().uuid().default(() => crypto.randomUUID()),
        blob: z.record(z.string(), z.unknown()).default({}),
        list: z.array(z.string()).default([]),
        calc: z.number().default(() => Math.random()),
        none: z.string().nullable().default(null),
      `)
    );
    expect(field(schema, 'User', 'n').default).toEqual({
      kind: 'literal',
      value: 5,
    });
    expect(field(schema, 'User', 'when').default).toEqual({ kind: 'now' });
    expect(field(schema, 'User', 'stamp').default).toEqual({ kind: 'now' });
    expect(field(schema, 'User', 'token').default).toEqual({ kind: 'uuid' });
    expect(field(schema, 'User', 'blob').default).toEqual({
      kind: 'literal',
      value: '{}',
    });
    expect(field(schema, 'User', 'list').default).toBeUndefined();
    expect(field(schema, 'User', 'calc').default).toBeUndefined();
    expect(field(schema, 'User', 'none').default).toBeUndefined();
    expect(warningsMatching(schema, 'calc (.default(')).toHaveLength(1);
  });

  it('makes a string with .max() a string with a length, and without one text', async () => {
    const schema: IrSchema = await parse(
      userModule(`
        a: z.string().max(10),
        b: z.string().min(2),
        c: z.string(),
        d: z.string().length(7),
        e: z.string().max(10).optional().array(),
      `)
    );
    expect(field(schema, 'User', 'a')).toMatchObject({
      type: 'string',
      maxLength: 10,
    });
    expect(field(schema, 'User', 'b').type).toBe('text');
    expect(field(schema, 'User', 'c').type).toBe('text');
    expect(field(schema, 'User', 'd')).toMatchObject({
      type: 'string',
      maxLength: 7,
    });
    expect(field(schema, 'User', 'e')).toMatchObject({
      arrayDepth: 1,
      maxLength: 10,
      isNullable: false,
    });
    expect(warningsMatching(schema, 'nullable array elements')).toHaveLength(1);
  });

  it('reads the decimal and bigint patterns the writer produces', async () => {
    const schema: IrSchema = await parse(
      userModule(`
        sized: z.string().regex(/^-?\\d{1,2}(\\.\\d{1,2})?$/),
        whole: z.string().regex(/^-?\\d{1,5}$/),
        free: z.string().regex(/^-?\\d+(\\.\\d+)?$/),
        big: z.string().regex(/^-?\\d+$/),
        other: z.string().regex(/^[a-z]+$/),
      `)
    );
    expect(field(schema, 'User', 'sized')).toMatchObject({
      type: 'decimal',
      maxDigits: 4,
      decimalPlaces: 2,
    });
    expect(field(schema, 'User', 'whole')).toMatchObject({
      type: 'decimal',
      maxDigits: 5,
      decimalPlaces: 0,
    });
    expect(field(schema, 'User', 'free').type).toBe('decimal');
    expect(field(schema, 'User', 'big').type).toBe('bigInt');
    expect(field(schema, 'User', 'other').type).toBe('text');
    expect(warningsMatching(schema, 'other (.regex())')).toHaveLength(1);
  });
});

describe('Zod 4 types', () => {
  it('maps the zod4-style fixture', async () => {
    const schema: IrSchema = await parseFixtures('zod4-style.ts');
    const expected: [string, Partial<IrField>][] = [
      ['id', { type: 'int', isPrimaryKey: true }],
      ['serial', { type: 'uuid' }],
      ['owner', { type: 'text' }],
      ['home', { type: 'text', isNullable: true }],
      ['addr', { type: 'ipAddress' }],
      ['addr6', { type: 'ipAddress', isNullable: true }],
      ['signature', { type: 'bytes' }],
      ['firmware', { type: 'int' }],
      ['weight', { type: 'float' }],
      ['huge', { type: 'bigInt' }],
      ['seen', { type: 'dateTime' }],
      ['built', { type: 'date', isNullable: true }],
      ['uptime', { type: 'duration' }],
      ['boot', { type: 'time' }],
      ['colour', { type: 'string', enumName: 'Colour' }],
      ['trim', { enumName: 'Colour', isNullable: true }],
      ['data', { type: 'json' }],
      ['note', { type: 'string', maxLength: 40, isNullable: true }],
      ['flags', { enumName: 'Colour', arrayDepth: 1 }],
      ['stringy', { type: 'boolean' }],
    ];
    for (const [name, wanted] of expected) {
      expect(field(schema, 'Device', name), `Device.${name}`).toMatchObject(
        wanted
      );
    }
    expect(enumOf(schema, 'Colour').values).toEqual([
      { name: 'Red', dbValue: 'red' },
      { name: 'Green', dbValue: 'green' },
    ]);
    expect(schema.enums).toHaveLength(1);
  });
});

describe('enums', () => {
  it('uses the declared name for a named enum schema and keeps unused ones', async () => {
    const schema: IrSchema = await parse(`
      export const RoleSchema = z.enum(['admin', 'user']);
      export const UnusedSchema = z.enum(['a']);
      export const UserSchema = z.object({ id: z.number(), role: RoleSchema, other: RoleSchema.optional() });
    `);
    expect(schema.enums.map((e: IrEnum) => e.name)).toEqual(['Role', 'Unused']);
    expect(field(schema, 'User', 'role').enumName).toBe('Role');
    expect(field(schema, 'User', 'other')).toMatchObject({
      enumName: 'Role',
      isNullable: true,
    });
  });

  it('names an inline enum after the model and the property, and shares identical ones', async () => {
    const schema: IrSchema = await parse(`
      export const AschemaSchema = z.object({ id: z.number(), state: z.enum(['x', 'y']) });
      export const BSchema = z.object({ id: z.number(), state: z.enum(['x', 'y']), mode: z.enum(['p']) });
    `);
    expect(schema.enums.map((e: IrEnum) => e.name)).toEqual([
      'AschemaState',
      'BState',
      'BMode',
    ]);
  });

  it('keeps a numeric TypeScript enum as an int with a warning', async () => {
    const schema: IrSchema = await parse(`
      enum Level { Low, High }
      export const JobSchema = z.object({ id: z.number(), level: z.nativeEnum(Level) });
    `);
    expect(field(schema, 'Job', 'level').type).toBe('int');
    expect(schema.enums).toEqual([]);
    expect(warningsMatching(schema, 'level (numeric enum')).toHaveLength(1);
  });

  it('reads an exported const object and z.enum over it', async () => {
    const schema: IrSchema = await parse(`
      export const Mode = { FAST: 'fast', SLOW: 'slow' } as const;
      export const ModeSchema = z.enum(Mode);
      export const JobSchema = z.object({ id: z.number(), mode: ModeSchema.default('fast') });
    `);
    expect(enumOf(schema, 'Mode').values).toEqual([
      { name: 'FAST', dbValue: 'fast' },
      { name: 'SLOW', dbValue: 'slow' },
    ]);
    expect(field(schema, 'Job', 'mode').default).toEqual({
      kind: 'enumValue',
      value: 'FAST',
    });
  });
});

describe('json and unlike types', () => {
  it('keeps what has no column type as json and warns with the model and property', async () => {
    const schema: IrSchema = await parseFixtures('json-fallbacks.ts');
    for (const name of [
      'address',
      'point',
      'either',
      'shape',
      'both',
      'dictionary',
      'nothing',
    ]) {
      expect(field(schema, 'Payload', name).type, name).toBe('json');
    }
    expect(
      warningsMatching(schema, 'Payload.address: a nested z.object()')
    ).toHaveLength(1);
    expect(warningsMatching(schema, 'Payload.point: a z.tuple()')).toHaveLength(
      1
    );
    expect(
      warningsMatching(
        schema,
        'Payload.either: a union of unlike types (string | number)'
      )
    ).toHaveLength(1);
    expect(
      warningsMatching(schema, 'Payload.shape: a z.discriminatedUnion()')
    ).toHaveLength(1);
    expect(
      warningsMatching(schema, 'Payload.both: a z.intersection()')
    ).toHaveLength(1);
    // Records, any and unknown are plain json: no warning.
    expect(warningsMatching(schema, 'Payload.dictionary')).toEqual([]);
  });

  it('turns unions with null into nullable, and unions of equal types into that type', async () => {
    const schema: IrSchema = await parse(
      userModule(`
        a: z.string().or(z.null()),
        b: z.union([z.string(), z.undefined()]),
        c: z.union([z.string().uuid(), z.string().uuid()]),
        d: z.union([z.number().int(), z.string()]),
      `)
    );
    expect(field(schema, 'User', 'a')).toMatchObject({
      type: 'text',
      isNullable: true,
    });
    expect(field(schema, 'User', 'b')).toMatchObject({
      type: 'text',
      isNullable: true,
    });
    expect(field(schema, 'User', 'c').type).toBe('uuid');
    expect(field(schema, 'User', 'd').type).toBe('json');
  });

  it('warns about unknown constructors and unresolved names', async () => {
    const schema: IrSchema = await parse(
      userModule(`
        a: z.somethingNew(),
        b: Missing,
        c: 42,
        d: z.custom<number>(),
      `)
    );
    for (const name of ['a', 'b', 'c', 'd']) {
      expect(field(schema, 'User', name).type, name).toBe('json');
    }
    expect(warningsMatching(schema, 'User.a: z.somethingNew()')).toHaveLength(
      1
    );
    expect(
      warningsMatching(schema, 'User.b: "Missing" is not declared')
    ).toHaveLength(1);
    expect(warningsMatching(schema, 'User.c:')).toHaveLength(1);
    expect(warningsMatching(schema, 'User.d: z.custom()')).toHaveLength(1);
  });
});

describe('aliases and shared property objects', () => {
  it('resolves reused property schemas and their modifiers', async () => {
    const schema: IrSchema = await parse(`
      const Email = z.string().email().max(80);
      const Money = z.string().regex(/^-?\\d{1,8}(\\.\\d{1,2})?$/);
      export const UserSchema = z.object({ id: z.number(), email: Email, backup: Email.nullable(), price: Money.optional() });
    `);
    expect(field(schema, 'User', 'email')).toMatchObject({
      type: 'string',
      maxLength: 80,
    });
    expect(field(schema, 'User', 'backup').isNullable).toBe(true);
    expect(field(schema, 'User', 'price')).toMatchObject({
      type: 'decimal',
      maxDigits: 10,
      decimalPlaces: 2,
      isNullable: true,
    });
  });

  it('reads schemas from several files by name', async () => {
    const schema: IrSchema = await parse(
      `export const base = { id: z.number().int(), name: z.string().max(5) };`,
      `import { base } from './a';\nexport const ItemSchema = z.object({ ...base, price: z.number() });`
    );
    expect(model(schema, 'Item').fields.map((f: IrField) => f.name)).toEqual([
      'id',
      'name',
      'price',
    ]);
  });
});

describe('extend, merge, pick, omit, partial and required', () => {
  it('applies the shape algebra', async () => {
    const schema: IrSchema = await parseFixtures('algebra.ts');
    const names = (modelName: string): string[] =>
      model(schema, modelName).fields.map((f: IrField) => f.name);
    expect(names('Base')).toEqual(['id', 'name', 'note']);
    expect(names('Extended')).toEqual(['id', 'name', 'note', 'active']);
    expect(field(schema, 'Extended', 'note')).toMatchObject({
      maxLength: 200,
      isNullable: true,
    });
    expect(names('Picked')).toEqual(['id', 'name']);
    expect(names('Omitted')).toEqual(['id', 'name', 'active']);
    expect(names('Merged')).toEqual(['id', 'name', 'note', 'extra']);
    expect(names('Spread')).toEqual([
      'id',
      'name',
      'note',
      'created_at',
      'created_by',
      'title',
    ]);
    expect(names('Strict')).toEqual(['id', 'name', 'note', 'flag']);
    expect(field(schema, 'Partial', 'name').isNullable).toBe(true);
    expect(field(schema, 'SomePartial', 'name').isNullable).toBe(true);
    expect(field(schema, 'SomePartial', 'id').isNullable).toBe(false);
    expect(field(schema, 'Required', 'note').isNullable).toBe(false);
    expect(field(schema, 'Base', 'note').isNullable).toBe(true);
    expect(schema.warnings).toEqual([]);
  });

  it('warns and skips a schema built from one that is not in the input', async () => {
    const schema: IrSchema = await parse(`
      import { Base } from './base';
      export const OneSchema = z.object({ id: z.number() });
      export const TwoSchema = Base.extend({ extra: z.string() });
    `);
    expect(schema.models.map((m: IrModel) => m.name)).toEqual(['One']);
    expect(
      warningsMatching(schema, 'Two: the schema is built from "Base"')
    ).toHaveLength(1);
  });

  it('warns when a mask is not an object literal, and about rules on the schema', async () => {
    const schema: IrSchema = await parse(`
      const keys = { id: true };
      export const OneSchema = z.object({ id: z.number(), name: z.string() });
      export const TwoSchema = OneSchema.pick(keys);
      export const ThreeSchema = z.object({ id: z.number() }).refine((v) => v.id > 0).brand<'X'>();
    `);
    expect(
      warningsMatching(schema, 'Two: .pick() needs an object literal')
    ).toHaveLength(1);
    expect(
      warningsMatching(
        schema,
        'Three: Zod rules the shared model has no place for were ignored: the schema itself (.refine(), .brand())'
      )
    ).toHaveLength(1);
  });
});

describe('schemas that hold other schemas', () => {
  it('reads a single schema as a foreign key and a list as many-to-many', async () => {
    const schema: IrSchema = await parseFixtures('relations.ts');
    const article: IrModel = model(schema, 'Article');
    const relation = (name: string): IrRelation => {
      const found: IrRelation | undefined = article.relations.find(
        (candidate: IrRelation) => candidate.name === name
      );
      if (found === undefined) {
        throw new Error(`Relation ${name} was not parsed`);
      }
      return found;
    };
    expect(relation('author')).toMatchObject({
      kind: 'foreignKey',
      targetModel: 'Author',
      columnName: 'author_id',
      isNullable: false,
    });
    expect(relation('editor').isNullable).toBe(true);
    expect(relation('reviewer').isNullable).toBe(true);
    expect(relation('topics')).toMatchObject({
      kind: 'manyToMany',
      targetModel: 'Topic',
    });
    expect(article.fields.map((f: IrField) => f.name)).toEqual(['id', 'title']);
    expect(model(schema, 'Comment').relations[0]).toMatchObject({
      name: 'article',
      targetModel: 'Article',
    });
    expect(
      warningsMatching(
        schema,
        'Article.author: the property holds the schema of "Author"'
      )
    ).toHaveLength(1);
  });

  it('reads a list that mirrors a foreign key as the related name of that key', async () => {
    const schema: IrSchema = await parse(`
      export const ParentSchema = z.object({ id: z.number(), children: z.array(z.lazy(() => ChildSchema)) });
      export const ChildSchema = z.object({ id: z.number(), parent: z.lazy(() => ParentSchema) });
    `);
    expect(model(schema, 'Parent').relations).toEqual([]);
    expect(model(schema, 'Child').relations[0]).toMatchObject({
      name: 'parent',
      kind: 'foreignKey',
      relatedName: 'children',
    });
  });

  it('reads a Zod 4 getter that closes a cycle', async () => {
    const schema: IrSchema = await parse(`
      export const CategorySchema = z.object({
        id: z.number(),
        get parent() { return CategorySchema.nullable(); },
        get children() { return z.array(CategorySchema); },
      });
    `);
    const category: IrModel = model(schema, 'Category');
    expect(category.relations).toHaveLength(1);
    expect(category.relations[0]).toMatchObject({
      name: 'parent',
      isNullable: true,
      relatedName: 'children',
    });
  });
});

describe('schemas the Zod writer derives', () => {
  it('skips the create, update and with-relations schemas of a model', async () => {
    const schema: IrSchema = await parse(`
      export const PostSchema = z.object({ id: z.number().int(), title: z.string() });
      export const PostCreateSchema = PostSchema.omit({ id: true });
      export const PostUpdateSchema = PostCreateSchema.partial();
      export const PostWithRelationsSchema = PostSchema.extend({ author: z.lazy(() => PostSchema) });
      export const PostSummarySchema = PostSchema.pick({ title: true });
    `);
    expect(schema.models.map((m: IrModel) => m.name)).toEqual([
      'Post',
      'PostSummary',
    ]);
  });
});

describe('directory input', () => {
  const created: string[] = [];
  afterEach(() => {
    for (const directory of created.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('reads the .ts files of the canonical fixture folder with --from zod', async () => {
    const directory: string = fileURLToPath(
      new URL('./fixtures/zod', import.meta.url)
    );
    const summary = expectOk(
      await runConversion({
        ...DEFAULT_OPTIONS,
        from: 'zod',
        to: 'prisma',
        inputs: [directory],
      })
    );
    expect(summary.modelCount).toBe(6);
    expect(summary.output).toContain('model PostTags {');
  });

  it('skips declaration, test and node_modules files', async () => {
    const root: string = mkdtempSync(join(tmpdir(), 'zod-dir-'));
    created.push(root);
    const schemaText: string = userModule('  name: z.string(),');
    mkdirSync(join(root, 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(join(root, 'user.ts'), schemaText);
    writeFileSync(
      join(root, 'user.test.ts'),
      schemaText.replace('User', 'Test')
    );
    writeFileSync(join(root, 'user.d.ts'), schemaText.replace('User', 'Decl'));
    writeFileSync(
      join(root, 'node_modules', 'pkg', 'index.ts'),
      schemaText.replace('User', 'Dep')
    );
    const summary = expectOk(
      await runConversion({
        ...DEFAULT_OPTIONS,
        from: 'zod',
        to: 'prisma',
        inputs: [root],
      })
    );
    expect(summary.modelCount).toBe(1);
  });
});
