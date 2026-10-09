import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import type { EmitOutput } from '../src/emitters/prisma.js';
import { emitTypescriptInterfaces } from '../src/emitters/typescriptInterfaces.js';
import { emitZod, type ZodEmitOptions } from '../src/emitters/zod.js';
import type {
  IrEnum,
  IrField,
  IrModel,
  IrRelation,
  IrSchema,
} from '../src/ir.js';
import { getFormat } from '../src/formats.js';
import { convertCanonical } from './harness.js';

function field(name: string, overrides: Partial<IrField> = {}): IrField {
  return {
    name,
    columnName: name,
    type: 'string',
    isPrimaryKey: false,
    isUnique: false,
    isNullable: false,
    isAutoUpdated: false,
    ...overrides,
  };
}

function idField(): IrField {
  return field('id', {
    type: 'int',
    isPrimaryKey: true,
    default: { kind: 'autoIncrement' },
  });
}

function relation(
  name: string,
  targetModel: string,
  overrides: Partial<IrRelation> = {}
): IrRelation {
  return {
    name,
    kind: 'foreignKey',
    targetModel,
    columnName: `${name}_id`,
    isNullable: false,
    onDelete: 'cascade',
    ...overrides,
  };
}

function model(name: string, overrides: Partial<IrModel> = {}): IrModel {
  return {
    name,
    tableName: name.toLowerCase(),
    appLabel: 'app',
    fields: [idField()],
    relations: [],
    indexes: [],
    ...overrides,
  };
}

function schemaOf(models: IrModel[], enums: IrEnum[] = []): IrSchema {
  return { models, enums, warnings: [] };
}

function emit(
  schema: IrSchema,
  overrides: Partial<ZodEmitOptions> = {}
): EmitOutput {
  return emitZod(schema, { camelFields: false, ...overrides });
}

/** Emits one model with the given fields and returns the line of the property `name`. */
function propertyLine(
  fields: IrField[],
  name: string,
  overrides: Partial<ZodEmitOptions> = {},
  enums: IrEnum[] = []
): string {
  const output: EmitOutput = emit(
    schemaOf([model('Item', { fields: [idField(), ...fields] })], enums),
    overrides
  );
  const line: string | undefined = output.text
    .split('\n')
    .find((candidate: string) => candidate.startsWith(`  ${name}:`));
  if (line === undefined) {
    throw new Error(`No property ${name} in:\n${output.text}`);
  }
  return line;
}

function line(property: string, expression: string): string {
  return `  ${property}: ${expression},`;
}

describe('Zod emitter: scalar types', () => {
  it('maps every scalar type to a validator', () => {
    const types: [IrField['type'], string][] = [
      ['string', 'z.string()'],
      ['text', 'z.string()'],
      ['uuid', 'z.uuid()'],
      ['time', 'z.string()'],
      ['duration', 'z.string()'],
      ['bytes', 'z.base64()'],
      ['bigInt', 'z.string().regex(/^-?\\d+$/)'],
      ['decimal', 'z.string().regex(/^-?\\d+(\\.\\d+)?$/)'],
      ['int', 'z.number().int()'],
      ['float', 'z.number()'],
      ['boolean', 'z.boolean()'],
      ['dateTime', 'z.coerce.date()'],
      ['date', 'z.coerce.date()'],
      ['json', 'z.unknown()'],
      ['ipAddress', 'z.union([z.ipv4(), z.ipv6()])'],
      ['hstore', 'z.record(z.string(), z.string().nullable())'],
    ];
    for (const [type, expression] of types) {
      expect(propertyLine([field('value', { type })], 'value'), type).toBe(
        line('value', expression)
      );
    }
  });

  it('never infers an email or url validator from a name', () => {
    const text: string = propertyLine([field('email')], 'email');
    expect(text).toBe(line('email', 'z.string()'));
  });

  it('uses the maximum length of strings and texts', () => {
    expect(propertyLine([field('name', { maxLength: 80 })], 'name')).toBe(
      line('name', 'z.string().max(80)')
    );
    expect(
      propertyLine([field('body', { type: 'text', maxLength: 5 })], 'body')
    ).toBe(line('body', 'z.string().max(5)'));
  });

  it('sizes the pattern of a decimal from its digits and places', () => {
    const sized = (maxDigits: number, decimalPlaces: number): string =>
      propertyLine(
        [field('price', { type: 'decimal', maxDigits, decimalPlaces })],
        'price'
      );
    expect(sized(8, 2)).toBe(
      line('price', 'z.string().regex(/^-?\\d{1,6}(\\.\\d{1,2})?$/)')
    );
    expect(sized(5, 0)).toBe(line('price', 'z.string().regex(/^-?\\d{1,5}$/)'));
    // All digits are decimals: the integer part is still a single digit (0.5).
    expect(sized(2, 2)).toBe(
      line('price', 'z.string().regex(/^-?\\d{1,1}(\\.\\d{1,2})?$/)')
    );
  });

  it('writes nullable columns with .nullable()', () => {
    expect(
      propertyLine([field('note', { isNullable: true, maxLength: 9 })], 'note')
    ).toBe(line('note', 'z.string().max(9).nullable()'));
  });

  it('writes arrays around the element, nullability outside', () => {
    expect(
      propertyLine([field('tags', { arrayDepth: 1, maxLength: 5 })], 'tags')
    ).toBe(line('tags', 'z.array(z.string().max(5))'));
    expect(
      propertyLine(
        [field('grid', { type: 'int', arrayDepth: 2, isNullable: true })],
        'grid'
      )
    ).toBe(line('grid', 'z.array(z.array(z.number().int())).nullable()'));
  });

  it('writes a range as an object with nullable bounds', () => {
    expect(
      propertyLine([field('span', { type: 'range', rangeOf: 'int' })], 'span')
    ).toBe(
      line(
        'span',
        'z.object({ lower: z.number().int().nullable(), upper: z.number().int().nullable(), bounds: z.string().optional() })'
      )
    );
  });

  it('warns about an unsupported type and validates it as unknown', () => {
    const output: EmitOutput = emit(
      schemaOf([
        model('Item', {
          fields: [
            idField(),
            field('shape', { type: 'unsupported', unsupportedType: 'circle' }),
          ],
        }),
      ])
    );
    expect(output.text).toContain(line('shape', 'z.unknown()'));
    expect(output.warnings.join('\n')).toContain('Item.shape');
  });

  it('switches dates to ISO text with the "string" mode', () => {
    expect(
      propertyLine([field('at', { type: 'dateTime' })], 'at', {
        dates: 'string',
      })
    ).toBe(line('at', 'z.iso.datetime({ offset: true })'));
    expect(
      propertyLine([field('on', { type: 'date' })], 'on', { dates: 'string' })
    ).toBe(line('on', 'z.iso.date()'));
  });

  it('switches big integers to native bigint with the "bigint" mode', () => {
    expect(
      propertyLine([field('n', { type: 'bigInt' })], 'n', { bigints: 'bigint' })
    ).toBe(line('n', 'z.coerce.bigint()'));
  });
});

describe('Zod emitter: enums', () => {
  const role: IrEnum = {
    name: 'Role',
    values: [
      { name: 'ADMIN', dbValue: 'admin', label: 'Administrator' },
      { name: 'USER', dbValue: "it's a user" },
    ],
  };

  it('exports a const object, its z.enum schema and the union type', () => {
    const output: EmitOutput = emit(
      schemaOf(
        [
          model('Account', {
            fields: [idField(), field('role', { enumName: 'Role' })],
          }),
        ],
        [role]
      )
    );
    expect(output.text).toContain(
      [
        'export const Role = {',
        '  /** Administrator */',
        "  ADMIN: 'admin',",
        "  USER: 'it\\'s a user',",
        '} as const;',
        'export const RoleSchema = z.enum(Role);',
        'export type Role = z.infer<typeof RoleSchema>;',
      ].join('\n')
    );
    expect(output.text).toContain(line('role', 'RoleSchema'));
  });

  it('warns about an enum that does not exist and validates a string', () => {
    const output: EmitOutput = emit(
      schemaOf([
        model('Account', {
          fields: [idField(), field('role', { enumName: 'Missing' })],
        }),
      ])
    );
    expect(output.text).toContain(line('role', 'z.string()'));
    expect(output.warnings).toContain(
      'Account.role: enum "Missing" does not exist in the schema; the property is validated as a string.'
    );
  });

  it('renames a repeated member and warns', () => {
    const output: EmitOutput = emit(
      schemaOf(
        [],
        [
          {
            name: 'E',
            values: [
              { name: 'A', dbValue: 'a' },
              { name: 'A', dbValue: 'b' },
            ],
          },
        ]
      )
    );
    expect(output.text).toContain("  A2: 'b',");
    expect(output.warnings).toContain(
      'enum E: the member "A" is declared more than once; the repeat was written as "A2".'
    );
  });
});

describe('Zod emitter: create and update schemas', () => {
  function createLine(fields: IrField[]): string {
    const output: EmitOutput = emit(schemaOf([model('Item', { fields })]));
    const match: RegExpMatchArray | null =
      /^export const ItemCreateSchema = (.*);$/m.exec(output.text);
    return match?.[1] ?? output.text;
  }

  it('omits auto-increment keys, generated columns and auto-updated columns', () => {
    expect(
      createLine([
        idField(),
        field('total', {
          type: 'int',
          generated: { expression: 'a + b', isStored: true },
        }),
        field('touched', { type: 'dateTime', isAutoUpdated: true }),
        field('seq', {
          type: 'int',
          default: {
            kind: 'dbExpression',
            expression: 'auto()',
            isFunction: true,
          },
        }),
        field('name'),
      ])
    ).toBe(
      'ItemSchema.omit({ id: true, total: true, touched: true, seq: true })'
    );
  });

  it('makes columns with a default and nullable columns optional', () => {
    expect(
      createLine([
        field('id', {
          type: 'uuid',
          isPrimaryKey: true,
          default: { kind: 'uuid' },
        }),
        field('created', { type: 'dateTime', default: { kind: 'now' } }),
        field('flag', {
          type: 'boolean',
          default: { kind: 'literal', value: true },
        }),
        field('slug', { default: { kind: 'dbExpression', expression: 'x' } }),
        field('legacy', { type: 'int', isDbDefault: true }),
        field('note', { isNullable: true }),
        field('required'),
      ])
    ).toBe(
      'ItemSchema.partial({ id: true, created: true, flag: true, slug: true, legacy: true, note: true })'
    );
  });

  it('writes the plain schema when nothing is generated or optional', () => {
    expect(createLine([field('a'), field('b', { type: 'int' })])).toBe(
      'ItemSchema'
    );
  });

  it('makes the update schema a partial of the create schema', () => {
    const output: EmitOutput = emit(schemaOf([model('Item')]));
    expect(output.text).toContain(
      'export const ItemUpdateSchema = ItemCreateSchema.partial();'
    );
    expect(output.text).toContain(
      'export type ItemUpdate = z.infer<typeof ItemUpdateSchema>;'
    );
    expect(output.text).toContain(
      'export type ItemCreate = z.infer<typeof ItemCreateSchema>;'
    );
  });

  it('writes no create or update schema for a view', () => {
    const output: EmitOutput = emit(
      schemaOf([model('Summary', { isView: true })])
    );
    expect(output.text).toContain('export const SummarySchema = z.object({');
    expect(output.text).not.toContain('SummaryCreateSchema');
    expect(output.text).not.toContain('SummaryUpdateSchema');
    expect(output.warnings).toEqual([]);
  });
});

describe('Zod emitter: relations', () => {
  const post: IrModel = model('Post', {
    fields: [idField(), field('title')],
    relations: [
      relation('author', 'User'),
      relation('editor', 'User', { isNullable: true, relatedName: 'edited' }),
      relation('tags', 'Tag', { kind: 'manyToMany' }),
    ],
  });
  const user: IrModel = model('User', {
    fields: [idField(), field('email')],
    relations: [relation('profile', 'Profile', { kind: 'oneToOne' })],
  });
  const profile: IrModel = model('Profile', {
    fields: [field('id', { type: 'uuid', isPrimaryKey: true })],
  });
  const tag: IrModel = model('Tag');
  const result: EmitOutput = emit(schemaOf([post, user, profile, tag]));

  it('keeps foreign-key scalars as properties and leaves relation fields out of the row', () => {
    const body: string =
      /export const PostSchema = z\.object\(\{\n([\s\S]*?)\n\}\);/.exec(
        result.text
      )?.[1] ?? '';
    expect(body).toContain('  author_id: z.number().int(),');
    expect(body).toContain('  editor_id: z.number().int().nullable(),');
    expect(body).not.toMatch(/^ {2}author:/m);
    expect(body).not.toMatch(/^ {2}tags:/m);
    expect(body).not.toMatch(/^ {2}edited:/m);
  });

  it('types the foreign key like the referenced primary key', () => {
    expect(result.text).toContain('  profile_id: z.uuid(),');
  });

  it('makes a nullable foreign key optional on create', () => {
    expect(result.text).toContain(
      'export const PostCreateSchema = PostSchema.omit({ id: true }).partial({ editor_id: true });'
    );
  });

  it('writes related rows lazily in the WithRelations schema', () => {
    expect(result.text).toContain(
      [
        'export type PostWithRelations = Post & {',
        '  author?: UserWithRelations;',
        '  editor?: UserWithRelations | null;',
        '  tags?: TagWithRelations[];',
        '};',
        'export const PostWithRelationsSchema: z.ZodType<PostWithRelations> = PostSchema.extend({',
        '  author: z.lazy(() => UserWithRelationsSchema).optional(),',
        '  editor: z.lazy(() => UserWithRelationsSchema).nullable().optional(),',
        '  tags: z.array(z.lazy(() => TagWithRelationsSchema)).optional(),',
        '});',
      ].join('\n')
    );
  });

  it('adds the reverse side to the target', () => {
    expect(result.text).toContain(
      [
        'export type UserWithRelations = User & {',
        '  profile?: ProfileWithRelations;',
        '  post_set?: PostWithRelations[];',
        '  edited?: PostWithRelations[];',
        '};',
      ].join('\n')
    );
    expect(result.text).toContain('  user?: UserWithRelations | null;');
  });

  it('writes no WithRelations schema for a model without relations', () => {
    const alone: EmitOutput = emit(schemaOf([model('Solo')]));
    expect(alone.text).not.toContain('WithRelations');
  });

  it('skips a relation to a missing model with a warning', () => {
    const output: EmitOutput = emit(
      schemaOf([model('Post', { relations: [relation('author', 'Nobody')] })])
    );
    expect(output.text).not.toContain('WithRelations');
    expect(output.warnings).toContain(
      'Post.author: target model "Nobody" does not exist in the schema; the relation was skipped.'
    );
  });

  it('validates a foreign key to a keyless model as unknown, with a warning', () => {
    const output: EmitOutput = emit(
      schemaOf([
        model('Post', { relations: [relation('log', 'Log')] }),
        model('Log', { fields: [field('message')] }),
      ])
    );
    expect(output.text).toContain('  log_id: z.unknown(),');
    expect(output.warnings.join('\n')).toContain(
      'Post.log: target model "Log" has no single-column primary key to reference'
    );
  });
});

describe('Zod emitter: naming', () => {
  it('uses camelCase properties for the normalize mode', () => {
    const output: EmitOutput = emit(
      schemaOf([
        model('Post', {
          fields: [idField(), field('created_at', { type: 'dateTime' })],
          relations: [relation('blog_author', 'Post')],
        }),
      ]),
      { camelFields: true }
    );
    expect(output.text).toContain('  createdAt: z.coerce.date(),');
    expect(output.text).toContain('  blogAuthorId: z.number().int(),');
    expect(output.text).toContain('  blogAuthor: z.lazy');
  });

  it('quotes properties that are not identifiers', () => {
    const output: EmitOutput = emit(
      schemaOf([
        model('Item', {
          fields: [
            idField(),
            field('first-name', { default: { kind: 'literal', value: 'x' } }),
          ],
        }),
      ])
    );
    expect(output.text).toContain("  'first-name': z.string(),");
    expect(output.text).toContain(".partial({ 'first-name': true })");
  });

  it('sanitizes type names and keeps derived names from colliding', () => {
    const output: EmitOutput = emit(
      schemaOf([
        model('User'),
        model('UserCreate'),
        model('my-model'),
        model('z'),
      ])
    );
    expect(output.text).toContain('export const UserSchema = ');
    // "UserCreate" would clash with the type written for User's create schema.
    expect(output.text).toContain('export const UserCreate2Schema = ');
    expect(output.text).toContain('export const my_modelSchema = ');
    expect(output.text).toContain('export const z2Schema = ');
    const warnings: string = output.warnings.join('\n');
    expect(warnings).toContain(
      '"my-model" is not a valid TypeScript identifier'
    );
    expect(warnings).toContain('UserCreate: the name is already used');
    expect(warnings).toContain('z: the name is already used');
  });

  it('writes nothing for an empty schema', () => {
    expect(emit(schemaOf([])).text).toBe('');
  });

  it('starts with the zod import', () => {
    expect(
      emit(schemaOf([model('Item')])).text.startsWith(
        "import { z } from 'zod';\n\n"
      )
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The property names agree with the TypeScript interfaces emitter.
// ---------------------------------------------------------------------------

function objectLiteralKeys(node: ts.ObjectLiteralExpression): string[] {
  return node.properties.flatMap((property: ts.ObjectLiteralElementLike) =>
    property.name !== undefined &&
    (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))
      ? [property.name.text]
      : []
  );
}

/** Property names of each `export const XSchema = z.object({..})` and `XWithRelationsSchema = ..extend({..})`. */
function zodKeys(text: string): Map<string, string[]> {
  const source: ts.SourceFile = ts.createSourceFile(
    'schemas.ts',
    text,
    ts.ScriptTarget.ES2022,
    true
  );
  const keys: Map<string, string[]> = new Map<string, string[]>();
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      const name: string = node.name.text;
      const call: ts.Expression | undefined = node.initializer;
      const argument: ts.Expression | undefined =
        call !== undefined && ts.isCallExpression(call)
          ? call.arguments[0]
          : undefined;
      if (
        argument !== undefined &&
        ts.isObjectLiteralExpression(argument) &&
        name.endsWith('Schema') &&
        !/(Create|Update)Schema$/.test(name)
      ) {
        const model: string = name
          .replace(/WithRelationsSchema$/, '')
          .replace(/Schema$/, '');
        keys.set(model, [
          ...(keys.get(model) ?? []),
          ...objectLiteralKeys(argument),
        ]);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return keys;
}

function interfaceKeys(text: string): Map<string, string[]> {
  const source: ts.SourceFile = ts.createSourceFile(
    'types.ts',
    text,
    ts.ScriptTarget.ES2022,
    true
  );
  const keys: Map<string, string[]> = new Map<string, string[]>();
  source.forEachChild((node: ts.Node): void => {
    if (ts.isInterfaceDeclaration(node)) {
      keys.set(
        node.name.text,
        node.members.flatMap((member: ts.TypeElement) =>
          member.name !== undefined &&
          (ts.isIdentifier(member.name) || ts.isStringLiteral(member.name))
            ? [member.name.text]
            : []
        )
      );
    }
  });
  return keys;
}

describe('Zod emitter: agreement with the TypeScript interfaces emitter', () => {
  const rich: IrSchema = schemaOf(
    [
      model('Post', {
        fields: [
          idField(),
          field('created_at', { type: 'dateTime' }),
          field('author_id', { type: 'int' }),
        ],
        relations: [
          relation('author', 'User'),
          relation('editor', 'User', { relatedName: 'edited_posts' }),
          relation('tags', 'Tag', { kind: 'manyToMany' }),
          relation('parent', 'Post', { isNullable: true }),
        ],
      }),
      model('User', {
        relations: [relation('profile', 'Profile', { kind: 'oneToOne' })],
      }),
      model('Profile', {
        fields: [
          field('id', { type: 'uuid', isPrimaryKey: true }),
          field('first-name'),
        ],
      }),
      model('Tag', { fields: [idField(), field('post_set')] }),
    ],
    [{ name: 'Role', values: [{ name: 'ADMIN', dbValue: 'admin' }] }]
  );

  it.each([false, true])(
    'writes the same property names (camelFields: %s)',
    (camelFields: boolean) => {
      const zod: Map<string, string[]> = zodKeys(
        emitZod(rich, { camelFields }).text
      );
      const interfaces: Map<string, string[]> = interfaceKeys(
        emitTypescriptInterfaces(rich, { camelFields }).text
      );
      expect([...zod.keys()].sort()).toEqual([...interfaces.keys()].sort());
      for (const [name, names] of interfaces) {
        expect(
          [...(zod.get(name) ?? [])].sort(),
          `properties of ${name}`
        ).toEqual([...names].sort());
      }
    }
  );

  it('uses the same enum members and values as the interface enum', () => {
    expect(emitZod(rich, { camelFields: false }).text).toContain(
      "export const Role = {\n  ADMIN: 'admin',\n} as const;"
    );
  });
});

describe('Zod emitter: valid TypeScript', () => {
  it('parses without syntax errors for a schema with every construct', async () => {
    for (const naming of ['preserve', 'normalize'] as const) {
      const { output } = await convertCanonical('django', 'zod', { naming });
      const transpiled: ts.TranspileOutput = ts.transpileModule(output, {
        reportDiagnostics: true,
        compilerOptions: { target: ts.ScriptTarget.ES2022 },
      });
      expect(transpiled.diagnostics ?? []).toEqual([]);
    }
  });
});

describe('Zod emitter: registration', () => {
  it('is registered as a write-only "zod" format that claims no extension', () => {
    const adapter = getFormat('zod');
    expect(adapter.ok).toBe(true);
    if (adapter.ok) {
      expect(adapter.value.extensions).toEqual([]);
      expect(adapter.value.parse).toBeUndefined();
      expect(adapter.value.emit).toBeDefined();
    }
  });

  it('applies the normalize naming mode through the adapter', async () => {
    const preserve = await convertCanonical('django', 'zod', {
      naming: 'preserve',
    });
    const normalize = await convertCanonical('django', 'zod', {
      naming: 'normalize',
    });
    expect(preserve.output).toContain('  created_at: z.coerce.date(),');
    expect(normalize.output).toContain('  createdAt: z.coerce.date(),');
  });
});
