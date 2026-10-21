import type { SyntaxNode, TsValue } from './typescriptSyntax.js';

/** One parsed source file. */
export interface FileInfo {
  path: string;
  /** Short name used in warnings. */
  label: string;
  root: SyntaxNode;
  /** Every `const name = <value>` in the file, so `sequelize.define('X', attributes)` can be followed. */
  consts: Map<string, SyntaxNode>;
  /** 7 when the file imports from the `@sequelize` scope (`@sequelize/core`), else 6. */
  generation: 6 | 7;
}

/** A node together with the file it was read from, for lookups that may leave the file. */
export interface Located {
  file: FileInfo;
  node: SyntaxNode;
}

export type TimestampKind = 'createdAt' | 'updatedAt' | 'deletedAt';

/** Where a column comes from: written in the model, or added by Sequelize itself. */
export type AttributeOrigin = 'declared' | 'id' | 'timestamp' | 'foreignKey';

/** One attribute of a model: everything `sequelize.define('X', { attribute: { ... } })` can say about a column. */
export interface RawAttribute {
  /** The attribute (property) name; the column name is `field`, or derived from it. */
  name: string;
  origin: AttributeOrigin;
  /** The data type expression as written (`DataTypes.STRING(100)`). */
  type?: TsValue;
  /** The TypeScript type of a decorated property, used when `@Column` names no data type. */
  tsType?: string;
  /** True when the TypeScript annotation allows null or the property is optional. */
  tsNullable?: boolean;
  allowNull?: boolean;
  primaryKey?: boolean;
  autoIncrement?: boolean;
  /** `unique: true` (no name) or `unique: 'name'` / `unique: { name }`. */
  unique?: { name?: string };
  defaultValue?: TsValue;
  references?: { model?: TsValue; key?: string };
  onDelete?: string;
  onUpdate?: string;
  field?: string;
  comment?: string;
  /** Values from the older `{ type: DataTypes.ENUM, values: [...] }` spelling. */
  enumValues?: string[];
  /** True when the attribute declares `get` or `set`. */
  hasAccessor?: boolean;
  timestamp?: TimestampKind;
  /** The foreign key an association added or completed (or a `references` the attribute declares). */
  link?: AttributeLink;
}

/** A foreign key on an attribute, resolved against the models of the project. */
export interface AttributeLink {
  /** The referenced model; undefined when it is not part of the input. */
  target: RawModel | undefined;
  /** The referenced model's name as the source wrote it (also used for the stub model). */
  targetName: string;
  /** Attribute of the target the key points at (its primary key unless `targetKey` / `sourceKey` says otherwise). */
  keyAttribute: string | undefined;
  /** Column of the target when the reference named a column instead of an attribute. */
  keyColumn?: string;
  onDelete?: string;
  onUpdate?: string;
  /** False for `constraints: false`, which creates no foreign key in the database. */
  constraint: boolean;
}

export interface RawIndexField {
  /** Attribute or column name. */
  name: string;
  order?: 'asc' | 'desc';
  length?: number;
  operator?: string;
}

export interface RawIndex {
  fields: RawIndexField[];
  unique: boolean;
  name?: string;
  using?: string;
  /** `FULLTEXT` or `SPATIAL` (`UNIQUE` is folded into `unique`). */
  type?: string;
  /** True for a partial index (`where`); the IR cannot hold the predicate. */
  isPartial: boolean;
  /** True when a field is a `Sequelize.literal(...)` or another expression rather than a column. */
  hasExpression: boolean;
}

export type AssociationKind =
  'hasMany' | 'hasOne' | 'belongsTo' | 'belongsToMany';

/** A foreign key option: the attribute name, plus whatever the option object says about the column. */
export interface AssociationKey {
  name?: string;
  /** Allow-null, column name, unique and the other attribute settings of `{ name, allowNull, field }`. */
  attribute: RawAttribute;
}

/** The options of one association call (or decorator). */
export interface AssociationOptions {
  as?: string;
  /** The foreign key as written: a name, or an attribute definition (`{ name, allowNull, field }`). */
  foreignKey?: AssociationKey;
  otherKey?: AssociationKey;
  sourceKey?: string;
  targetKey?: string;
  onDelete?: string;
  onUpdate?: string;
  /** `constraints: false` (`foreignKeyConstraints: false` in Sequelize 7) */
  constraints?: boolean;
  /**
   * Sequelize 7 `inverse`: the association the other side gets. On a `belongsTo` it names the reverse
   * (`hasMany` unless `type` says `hasOne`); on the others it names the `belongsTo`.
   */
  inverse?: { as?: string; type?: 'hasMany' | 'hasOne' };
  /** `through` for `belongsToMany`: a join table name or a reference to a model. */
  through?: { table?: string; model?: string; unique?: boolean };
  /** `scope`, `inverse` and other options this reader does not model. */
  unsupported: string[];
}

/** An association call that was found in the source, before the model names are resolved. */
export interface RawAssociation {
  kind: AssociationKind;
  file: FileInfo;
  /** The model the call was made on, as written (`User`, `this`, `models.User`). */
  source: string;
  /** The class a `this` receiver stands for, when the call is inside a class or `X.associate = ...`. */
  enclosing: string | undefined;
  /** The target model as written (`models.Post`, `Post`). */
  target: string;
  options: AssociationOptions;
  /** For decorators: the property the decorator is on, which is the default alias. */
  propertyName?: string;
  /** For decorators: the model the property belongs to (resolved without a receiver). */
  owner?: RawModel;
  /** Text identifying the call in warnings, for example `Post.belongsTo(User)`. */
  label: string;
}

export interface ModelOptions {
  tableName?: string;
  freezeTableName: boolean;
  timestamps: boolean;
  paranoid: boolean;
  underscored: boolean;
  schema?: string;
  /** Names of the timestamp columns; false disables the column. */
  createdAt: string | false;
  updatedAt: string | false;
  deletedAt: string | false;
  /** `version: true` / `version: 'name'` adds an integer column. */
  version?: string;
  /** Sequelize 7 `noPrimaryKey: true`: the model gets no `id` column when it declares no key. */
  noPrimaryKey?: boolean;
  /** `name: { singular, plural }`, which replaces the inflected model name. */
  nameSingular?: string;
  namePlural?: string;
}

/** Defaults a `new Sequelize(..., { define: { ... } })` call gives every model. */
export type ModelOptionDefaults = Partial<
  Pick<
    ModelOptions,
    | 'freezeTableName'
    | 'timestamps'
    | 'paranoid'
    | 'underscored'
    | 'schema'
    | 'createdAt'
    | 'updatedAt'
    | 'deletedAt'
  >
>;

export type ModelStyle = 'define' | 'init' | 'decorators' | 'migration';

export interface RawModel {
  file: FileInfo;
  style: ModelStyle;
  /** The Sequelize model name (`modelName`, the first argument of `define`, or the class name). */
  modelName: string;
  /** Variable and class names the source uses for the model. */
  aliases: string[];
  attributes: RawAttribute[];
  /** The model options as written, read once the project defaults are known. */
  optionEntries: Map<string, SyntaxNode>;
  /** Options that decorators contribute (`@CreatedAt` renames the timestamp column, and so on). */
  decoratorOptions: Partial<ModelOptions>;
  indexes: RawIndex[];
  /** sequelize-typescript `@ForeignKey(() => Model)`: attribute name -> model name. */
  foreignKeyHints: Map<string, string>;
  /** Names of the attributes that declare getters or setters. */
  accessors: string[];
  /** Unsupported features seen on the model (hooks, scopes, ...), reported once. */
  unsupported: string[];
  /** Text identifying the model in warnings, for example `user.js: model "User"`. */
  location: string;
  /**
   * The options of a table rebuilt from migrations. Such a model lists every column the table has, so
   * Sequelize's own `id` and timestamp columns are not added and `optionEntries` stays empty.
   */
  presetOptions?: ModelOptions;
}

export interface Project {
  files: FileInfo[];
  models: RawModel[];
  associations: RawAssociation[];
  /** Constants of every file, for lookups across files (an imported attribute set). */
  sharedConsts: Map<string, Located[]>;
  /** The first `new Sequelize(..., { define })` found. */
  defaults: ModelOptionDefaults;
  warnings: string[];
}
