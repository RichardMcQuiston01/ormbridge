import type { Ann, Annotated } from './jpaAnnotations.js';
import type {
  ConstLookup,
  JavaClass,
  JavaType,
  SyntaxNode,
} from './javaSyntax.js';

/** What the reader knows about the whole input; shared by every step. */
export interface Project {
  /** Every class of the input by simple name (enums are in `enums`). */
  classes: Map<string, JavaClass>;
  /** Java `enum` types by simple name. */
  enums: Map<string, JavaClass>;
  /** `AttributeConverter` classes by simple name. */
  converters: Map<string, ConverterInfo>;
  lookup: ConstLookup;
  warnings: string[];
  appLabel: string;
}

/** An `AttributeConverter<X, Y>` class: attributes of type X are stored as Y. */
export interface ConverterInfo {
  name: string;
  attributeType: JavaType;
  columnType: JavaType;
  autoApply: boolean;
}

/** A mapped attribute of a class: a field, or a getter under property access. */
export interface Attribute {
  name: string;
  type: JavaType;
  notes: Annotated;
  /** The class that declares the attribute. */
  declaredIn: string;
  /** The class's imports, to tell `java.sql.Date` from `java.util.Date`. */
  imports: readonly string[];
  isProperty: boolean;
  initializer?: SyntaxNode;
}

export type MemberKind = 'basic' | 'relation' | 'collection';

/** An attribute of an entity after embeddables are flattened into it. */
export interface Member {
  attr: Attribute;
  /** Attribute names from the entity down to this attribute: `['address', 'street']`. */
  path: string[];
  kind: MemberKind;
  /** The `@Column` that applies: from the closest `@AttributeOverride`, else the attribute's own. */
  column?: Ann;
  /** True for `@Id` attributes and the attributes of an `@EmbeddedId`. */
  isId: boolean;
  /** True for the attributes of an `@EmbeddedId`. */
  inEmbeddedId: boolean;
  /** The entity class the member belongs to (the subclass in a hierarchy). */
  declaredIn: string;
}

export type InheritanceKind =
  'none' | 'singleTable' | 'joined' | 'tablePerClass';

/** An entity class with its position in a hierarchy. */
export interface EntityInfo {
  cls: JavaClass;
  /** The class name, which is also the IR model name. */
  name: string;
  /** The JPA entity name: `@Entity(name)`, else the class name. */
  entityName: string;
  notes: Annotated;
  /** The superclasses in the input, root first, ending with the class itself. */
  chain: JavaClass[];
  /** The access type of each class of `chain`. */
  accesses: ('field' | 'property')[];
  /** The closest superclass that is an entity, when there is one. */
  parent?: EntityInfo;
  /** The entities that extend this one directly. */
  children: EntityInfo[];
  /** The first entity of the hierarchy. */
  root: EntityInfo;
  inheritance: InheritanceKind;
  isAbstract: boolean;
  /** The attributes that become columns or relationships of this entity's table. */
  members: Member[];
}
