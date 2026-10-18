import type { IrEnum, IrField, IrModel } from '../ir.js';
import type { AnnotationNode } from './jpaFormat.js';

/** The package family of the persistence API: `jakarta` (Hibernate 6) or `javax` (Hibernate 5). */
export type JpaStyle = 'jakarta' | 'javax';

/** The set of types one Java file imports, by simple name. */
export class Imports {
  private readonly names: Map<string, string> = new Map<string, string>();

  constructor(private readonly style: JpaStyle) {}

  /** Imports a class by its full name and returns its simple name. */
  use(fullName: string): string {
    const simple: string = fullName.slice(fullName.lastIndexOf('.') + 1);
    this.names.set(simple, fullName);
    return simple;
  }

  /** A class of the persistence API (`jakarta.persistence.Entity` or `javax.persistence.Entity`). */
  persistence(name: string): string {
    return this.use(`${this.style}.persistence.${name}`);
  }

  /** A class of `org.hibernate.annotations`. */
  hibernate(name: string): string {
    return this.use(`org.hibernate.annotations.${name}`);
  }

  /** Adds every import of another set. */
  merge(other: Imports): void {
    for (const [simple, full] of other.names) {
      this.names.set(simple, full);
    }
  }

  /** The import lines in ASCII order; `java.lang` classes and the file's own package need none. */
  lines(): string[] {
    return [...this.names.values()]
      .filter((full: string) => !/^java\.lang\.[A-Z]/.test(full))
      .sort((first: string, second: string) =>
        first < second ? -1 : first > second ? 1 : 0
      )
      .map((full: string) => `import ${full};`);
  }
}

/** How an IR enum is written and stored. */
export interface EnumPlan {
  enumeration: IrEnum;
  /** The Java enum name. */
  typeName: string;
  /** IR member name to Java constant. */
  members: Map<string, string>;
  /** `names`: stored as the constant names; `ordinal`: as their position; `converter`: via an AttributeConverter. */
  storage: 'names' | 'ordinal' | 'converter';
  /** True when the stored values are numbers (the converter then maps to `Integer`). */
  numeric: boolean;
  /** The converter class, allocated when the enum needs one. */
  converterName: string;
}

/** One attribute (field) of a generated class. */
export interface Attribute {
  name: string;
  /** The Java type as written, with the generics. */
  type: string;
  /** Annotations of the field, in order. */
  annotations: AnnotationNode[];
  /** The initializer, for collections. */
  initializer?: string;
  /** True for the primitive `boolean`, whose getter is `isX`. */
  isPrimitiveBoolean?: boolean;
  /** Imports the type and the annotations need. */
  imports: Imports;
}

/** A component of a composite primary key and the type its `@IdClass` field has. */
export interface IdPart {
  /** The attribute name in the entity (and in the id class). */
  name: string;
  /** The boxed Java type. */
  type: string;
  imports: Imports;
}

/** What the generated class of a model is made of. */
export interface ModelPlan {
  model: IrModel;
  className: string;
  /** Attribute names by IR field name. */
  fieldNames: Map<string, string>;
  /** Attribute names by IR relation name (`composite:<name>` for composite foreign keys). */
  relationNames: Map<string, string>;
  used: Set<string>;
  attributes: Attribute[];
  classAnnotations: AnnotationNode[];
  imports: Imports;
  /** The `@IdClass` class, when the primary key has several columns. */
  idClass?: { name: string; parts: IdPart[] };
  /** True when the key is a relationship: Hibernate then wants the entity itself to be `Serializable`. */
  serializable?: boolean;
  /** True when a column default is left to the database, so inserts must leave null properties out. */
  dynamicInsert: boolean;
}

/** The planned column of a field: its Java attribute and what the key role adds. */
export interface FieldColumn {
  field: IrField;
  attribute: Attribute;
  /** The boxed type, for an id class. */
  boxedType: string;
}
