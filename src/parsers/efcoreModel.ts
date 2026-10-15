import type { CsClass, CsEnum, CsValue, CsType } from './csharpSyntax.js';

/** Settings that data annotations and the fluent API give one property. Fluent calls overwrite annotations. */
export interface PropConfig {
  column?: string;
  columnType?: string;
  maxLength?: number;
  /** True or false when the property is explicitly required or optional. */
  required?: boolean;
  precision?: number;
  scale?: number;
  /** `HasDefaultValue(...)`. A `null` value means HasDefaultValue() with no argument. */
  defaultValue?: CsValue;
  defaultSql?: string;
  /** How the value is generated: `identity` / `onAdd`, `computed` / `onAddOrUpdate`, or `never`. */
  generated?: 'onAdd' | 'onAddOrUpdate' | 'never';
  computedSql?: string;
  computedStored?: boolean;
  /** The storage type of `HasConversion<T>()`, for example `string`. */
  conversion?: string;
  /** True when a converter was given that cannot be evaluated statically. */
  customConversion?: boolean;
  isRowVersion?: boolean;
  isConcurrencyToken?: boolean;
  isUnicode?: boolean;
  comment?: string;
  ignored?: boolean;
  /** Set by [Key]; the order is the position among several [Key] properties. */
  isKey?: boolean;
  /** True when the fluent API named the property (`Property(...)`). */
  declared?: boolean;
  /** The CLR type of a shadow property: `Property<int>("TenantId")`. */
  shadowType?: string;
}

/** An index or unique constraint declared by [Index], HasIndex or HasAlternateKey. */
export interface ConfigIndex {
  /** Property names (dotted for owned members). */
  members: string[];
  unique: boolean;
  name?: string;
  /** True when HasFilter / Filter makes it a partial index. */
  hasFilter: boolean;
  /** True when IncludeProperties adds covering columns. */
  hasInclude: boolean;
  /** Descending flags by member position; empty when all ascending. */
  descending: boolean[];
  /** Access method, from `HasMethod("gin")` (Npgsql). */
  method?: string;
  /** True for an alternate key rather than an index. */
  isAlternateKey?: boolean;
}

/** Members and settings of a type that is part of an entity (the entity itself, or an owned type). */
export interface Scope {
  props: Map<string, PropConfig>;
  ignored: Set<string>;
  owned: Map<string, OwnedConfig>;
}

export interface OwnedConfig extends Scope {
  /** The navigation property name on the owner. */
  nav: string;
  many: boolean;
  /** True for `ToJson()`: the owned type is stored in one JSON column. */
  toJson: boolean;
  /** Set by OwnsOne / ComplexProperty with an explicit column prefix; unused by default. */
  table?: string;
}

/** A relationship from HasOne / HasMany and what follows. */
export interface FluentRelation {
  /** The entity whose builder the call was made on. */
  owner: string;
  /** The navigation on `owner`, or undefined for `HasOne<T>()`. */
  ownerNav?: string;
  ownerMany: boolean;
  /** The type argument of `HasOne<T>()` / `HasMany<T>()`. */
  target?: string;
  /** The navigation on the other side (`WithMany(x => x.Posts)`). */
  inverseNav?: string;
  inverseMany: boolean;
  /** True once a With* call was seen (a half-built relation is ignored). */
  complete: boolean;
  foreignKey?: string[];
  /** The type argument of `HasForeignKey<T>(...)`: the dependent entity. */
  foreignKeyEntity?: string;
  principalKey?: string[];
  onDelete?: string;
  required?: boolean;
  constraintName?: string;
  /** Join entity settings of a many-to-many (`UsingEntity`). */
  join?: JoinConfig;
}

/** What `UsingEntity(...)` says about the join table of a skip-navigation many-to-many. */
export interface JoinConfig {
  /** The join entity type name when written as a string or a type argument. */
  entityName?: string;
  /** True when the join entity is a class in the input (explicit join model). */
  entityClass?: string;
  table?: string;
  schema?: string;
  /** Foreign key columns on the join table: toward the left (owner) and the right (inverse) entity. */
  leftColumn?: string;
  rightColumn?: string;
  leftOnDelete?: string;
  rightOnDelete?: string;
}

export interface DiscriminatorConfig {
  column?: string;
  /** The CLR type name of the discriminator, from `HasDiscriminator<T>()`. */
  type?: string;
  /** `HasValue<Derived>(value)` entries: derived entity (or '' for the base) to value. */
  values: Map<string, CsValue>;
}

export interface EntityConfig extends Scope {
  name: string;
  table?: string;
  schema?: string;
  viewName?: string;
  /** HasNoKey() or [Keyless]. */
  keyless: boolean;
  /** Primary key members from [Key], [PrimaryKey] or HasKey. */
  key?: string[];
  /** Name of the primary key constraint, from `HasKey(...).HasName("PK_x")`. */
  keyName?: string;
  indexes: ConfigIndex[];
  relations: FluentRelation[];
  discriminator?: DiscriminatorConfig;
  /** `HasBaseType<T>()` or `HasBaseType((Type?)null)`: the explicit base entity, '' for none. */
  baseType?: string;
  mapping?: 'tph' | 'tpt' | 'tpc';
  comment?: string;
  /** Set when HasData / HasQueryFilter was seen, to warn about it once. */
  hasData: boolean;
  hasQueryFilter: boolean;
  /** Table-level check constraints (`ToTable(t => t.HasCheckConstraint(...))`, [CheckConstraint]). */
  checkConstraints: string[];
  /** True when the class carries [NotMapped]. */
  notMapped: boolean;
  /** True for the class named by `UsingEntity<T>()`: its key defaults to the two foreign keys. */
  joinEntity?: boolean;
}

/** What is known about the input as a whole. */
export interface Project {
  classes: Map<string, CsClass>;
  enums: Map<string, CsEnum>;
  /** Classes that derive from DbContext (directly or through another context). */
  contexts: CsClass[];
  /** Classes that implement IEntityTypeConfiguration<T>, with the entity they configure. */
  configurations: { cls: CsClass; entity: string }[];
  /** DbSet property name by entity name. */
  dbSets: Map<string, string>;
  /** True when nullable reference types are in effect for the input as a whole. */
  nullableReferences: boolean;
  /** The `#nullable` directive of each file by path, which overrides the project-wide setting. */
  nullableByPath: Map<string, 'enable' | 'disable' | undefined>;
  /** Position of each class in the input (file order, then declaration order). */
  classOrder: Map<string, number>;
  warnings: string[];
}

/** A scalar column with the settings that decide its IR field. */
export interface ScalarMember {
  kind: 'scalar';
  /** Property name; dotted with the owned navigation for flattened members (`Address.Street`). */
  path: string;
  name: string;
  type: CsType;
  config: PropConfig;
  declaredIn: string;
  /** Column name prefix from owned navigations, e.g. `Address_`. */
  prefix: string;
  /** True when every column of an optional owned type must allow null. */
  forceNullable: boolean;
  /** The JSON column of a `ToJson()` owned type. */
  isJson?: boolean;
  /** The navigation named by [ForeignKey("Nav")] on this property. */
  foreignKeyNav?: string;
}

export interface NavMember {
  kind: 'nav';
  name: string;
  /** The target entity (class) name. */
  target: string;
  many: boolean;
  /** True when written with `?` (or inside a nullable-oblivious context: unknown). */
  nullable: boolean;
  declaredIn: string;
  /** The raw properties attributes: [ForeignKey], [InverseProperty], [Required]. */
  foreignKeyAttr?: string;
  inverseAttr?: string;
  requiredAttr: boolean;
}

export type Member = ScalarMember | NavMember;

/** One entity with its mapped members, before relationships are resolved. */
export interface EntityInfo {
  name: string;
  cls: CsClass;
  config: EntityConfig;
  /** The entity whose table holds this one: itself, or the root of a table-per-hierarchy. */
  root: string;
  /** For a root: the derived entities stored in the same table. */
  derived: string[];
  /** The mapped members: this entity's own, those of non-entity base classes, and for a root the derived ones. */
  members: Member[];
  /** True when nullable reference types are in effect in the declaring file. */
  nullableRefs: boolean;
  order: number;
}
