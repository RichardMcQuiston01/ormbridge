import type {
  IrCompositeForeignKey,
  IrField,
  IrModel,
  IrRelation,
  IrSchema,
} from '../ir.js';
import type { ColumnSpec, EnumPlan } from './efcoreColumns.js';
import type { PrismaProvider } from './prisma.js';

/** The shapes the planning and rendering steps of the EF Core emitter share. */

export type EfcoreStyle = 'annotations' | 'fluent';

/** One property that is a database column: a field, or the foreign key column of a relation. */
export interface ColumnMember {
  property: string;
  spec: ColumnSpec;
  /** True when the column is part of the primary key. */
  isKey: boolean;
  /** The IR field, for a field. */
  fieldName?: string;
  /** The IR relation, for a foreign key column. */
  relationName?: string;
}

/** One navigation property. */
export interface NavMember {
  property: string;
  /** The class the navigation points at. */
  typeName: string;
  collection: boolean;
  /** True when a reference may be null. */
  nullable: boolean;
  /** Foreign key properties, for the reference navigation of the dependent side. */
  foreignKeys?: string[];
  /** The navigation on the other side, for `[InverseProperty]`. */
  inverseOf?: { className: string; property: string };
}

export interface ConfigIndex {
  properties: string[];
  unique: boolean;
  name?: string;
  /** Sort order by position; empty when every column is ascending. */
  descending: boolean[];
  /** Access method (`gin`); only the fluent API can say it. */
  method?: string;
}

/** A one-to-many or one-to-one relationship, seen from the entity that holds the foreign key. */
export interface Link {
  owner: ModelPlan;
  target: ModelPlan;
  relationName: string;
  relation?: IrRelation;
  composite?: IrCompositeForeignKey;
  /** The reference navigation on the owner. */
  nav: string;
  /** The navigation on the target, when the relation has a related name. */
  inverse?: string;
  oneToOne: boolean;
  /** Foreign key properties on the owner. */
  foreignKeys: string[];
  /** Referenced properties on the target when they are not its primary key. */
  principalKeys?: string[];
  /** The `DeleteBehavior` to write; undefined when EF Core's default is the wanted one. */
  behavior?: string;
  required: boolean;
  constraintName?: string;
  /** The key field the foreign key column copies its type from. */
  keyField?: IrField;
}

export interface ManyToManyLink {
  owner: ModelPlan;
  target: ModelPlan;
  relationName: string;
  nav: string;
  inverse?: string;
  joinTable: string;
  ownerColumn: string;
  targetColumn: string;
}

export interface ModelPlan {
  model: IrModel;
  className: string;
  /** The `DbSet` property name on the context. */
  dbSet: string;
  tableName: string;
  /** True when the table name is not the `DbSet` name, so the class needs `[Table]` / `ToTable`. */
  needsTable: boolean;
  schema: string | undefined;
  /** Member names in use on the class. */
  used: Set<string>;
  /** IR field name -> property. */
  fieldProps: Map<string, string>;
  /** IR relation name -> foreign key property. */
  relationFks: Map<string, string>;
  /** IR relation name -> navigation property. */
  relationNavs: Map<string, string>;
  columns: ColumnMember[];
  navs: NavMember[];
  /** Primary key properties, in key order. */
  keyProps: string[];
  keyless: boolean;
  isView: boolean;
  keyName: string | undefined;
  alternateKeys: string[][];
  indexes: ConfigIndex[];
  links: Link[];
  manyToMany: ManyToManyLink[];
  /** Properties that are refreshed on every save. */
  autoUpdated: string[];
}

export interface Plan {
  schema: IrSchema;
  style: EfcoreStyle;
  namespace: string;
  header: boolean;
  provider: PrismaProvider;
  models: ModelPlan[];
  enums: EnumPlan[];
}
