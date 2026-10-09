import type {
  IrEnum,
  IrField,
  IrIndex,
  IrModel,
  IrRelation,
  IrSchema,
} from '../src/ir.js';

/** Builders for IR fixtures used by the GORM tests. */

export function field(name: string, overrides: Partial<IrField> = {}): IrField {
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

export function idField(overrides: Partial<IrField> = {}): IrField {
  return field('id', {
    type: 'int',
    isPrimaryKey: true,
    default: { kind: 'autoIncrement' },
    ...overrides,
  });
}

export function relation(
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

export function model(name: string, overrides: Partial<IrModel> = {}): IrModel {
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

export function index(
  fields: string[],
  overrides: Partial<IrIndex> = {}
): IrIndex {
  return { fields, isUnique: false, ...overrides };
}

export function schemaOf(models: IrModel[], enums: IrEnum[] = []): IrSchema {
  return { models, enums, warnings: [] };
}

export const STATUS: IrEnum = {
  name: 'Status',
  values: [
    { name: 'DRAFT', dbValue: 'draft', label: 'Draft' },
    { name: 'LIVE', dbValue: 'live' },
  ],
};

/**
 * A schema that exercises most GORM mappings: the gorm.Model columns, every
 * scalar type, soft delete, UUID keys and defaults, a composite key made of
 * foreign keys, a self-referencing many-to-many, one-to-one, enums, custom
 * table and column names and the index forms. It is meant for SQLite
 * (`provider: 'sqlite'`), so every default in it is portable.
 */
export function kitchenSinkSchema(): IrSchema {
  const account: IrModel = model('Account', {
    tableName: 'accounts',
    fields: [
      idField({ type: 'bigInt' }),
      field('created_at', {
        type: 'dateTime',
        default: { kind: 'now' },
      }),
      field('updated_at', { type: 'dateTime', isAutoUpdated: true }),
      field('deleted_at', { type: 'dateTime', isNullable: true }),
      field('email', { maxLength: 255, isUnique: true }),
      field('balance', { type: 'decimal', maxDigits: 10, decimalPlaces: 2 }),
      field('score', { type: 'float', isNullable: true }),
      field('avatar', { type: 'bytes', isNullable: true }),
      field('payload', { type: 'json', isNullable: true }),
      field('labels', { type: 'string', arrayDepth: 1 }),
      field('ttl', { type: 'duration', isNullable: true }),
      field('ip', { type: 'ipAddress', isNullable: true }),
      field('homepage_url', { isNullable: true }),
      field('born', { type: 'date', isNullable: true }),
      field('alarm', { type: 'time', isNullable: true }),
      field('status', {
        enumName: 'Status',
        maxLength: 10,
        default: { kind: 'enumValue', value: 'DRAFT' },
      }),
      field('note', {
        type: 'text',
        default: { kind: 'literal', value: "it's; fine" },
      }),
    ],
    indexes: [index(['deleted_at']), index(['email', 'status'])],
  });
  const session: IrModel = model('Session', {
    tableName: 'sessions',
    fields: [
      field('id', {
        type: 'uuid',
        isPrimaryKey: true,
        default: { kind: 'uuid' },
      }),
      field('token', {
        type: 'uuid',
        isNullable: true,
        default: { kind: 'uuid', version: 7 },
      }),
      field('deleted_at', { type: 'dateTime', isNullable: true }),
      field('opened_at', {
        type: 'dateTime',
        default: { kind: 'now' },
      }),
    ],
    relations: [
      relation('account', 'Account', {
        isNullable: true,
        onDelete: 'setNull',
        onUpdate: 'cascade',
        relatedName: 'sessions',
      }),
    ],
    indexes: [index(['account', 'opened_at'], { isUnique: true })],
  });
  const group: IrModel = model('Group', {
    tableName: 'groups',
    fields: [idField(), field('name', { maxLength: 40 })],
    relations: [
      relation('friends', 'Group', {
        kind: 'manyToMany',
        columnName: 'friends_id',
        relatedName: 'friend_of',
      }),
    ],
  });
  const membership: IrModel = model('Membership', {
    tableName: 'memberships',
    fields: [field('role', { enumName: 'Role', maxLength: 12 })],
    relations: [
      relation('account', 'Account'),
      relation('group', 'Group', { onDelete: 'restrict' }),
    ],
    compositePrimaryKey: ['account', 'group'],
  });
  const profile: IrModel = model('Profile', {
    tableName: 'profiles',
    fields: [idField(), field('bio', { type: 'text', isNullable: true })],
    relations: [
      relation('owner', 'Account', {
        kind: 'oneToOne',
        columnName: 'owner_account_id',
        relatedName: 'profile',
      }),
    ],
  });
  const legacy: IrModel = model('legacy_order', {
    tableName: 'LEGACY_ORDER',
    fields: [
      field('order_no', {
        columnName: 'OrderNo',
        isPrimaryKey: true,
        type: 'int',
      }),
      field('type', { columnName: 'kind' }),
      field('HTTPCode', { columnName: 'http_code', type: 'int' }),
      field('first-name', { columnName: 'first name', isNullable: true }),
    ],
    relations: [
      relation('owner', 'Account', {
        columnName: 'acct',
        isNullable: true,
        onDelete: 'noAction',
      }),
    ],
  });
  const roles: IrEnum = {
    name: 'Role',
    values: [
      { name: 'owner', dbValue: 'owner' },
      { name: 'member', dbValue: 'member' },
    ],
  };
  return schemaOf(
    [account, session, group, membership, profile, legacy],
    [STATUS, roles]
  );
}

/** A schema with names, defaults and shapes the generator has special cases for. */
export function stressSchema(): IrSchema {
  return schemaOf(
    [
      model('Weird', {
        tableName: 'weird',
        fields: [
          idField(),
          field('a;b', { default: { kind: 'literal', value: 'x;y' } }),
          field('quote', { default: { kind: 'literal', value: 'say "hi"' } }),
          field('tick', { default: { kind: 'literal', value: 'a`b' } }),
        ],
        relations: [
          relation('self', 'Weird', { isNullable: true, onDelete: 'setNull' }),
          relation('other', 'Other', { relatedName: 'weirds' }),
        ],
      }),
      model('Other', { tableName: 'others', fields: [idField()] }),
    ],
    [STATUS, { name: 'Other', values: [{ name: 'A', dbValue: 'a' }] }]
  );
}
