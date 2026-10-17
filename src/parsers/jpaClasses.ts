import { Annotated, type Ann } from './jpaAnnotations.js';
import type {
  JavaAnnotation,
  JavaClass,
  JavaField,
  JavaType,
} from './javaSyntax.js';
import type { Attribute, Member, MemberKind, Project } from './jpaModel.js';
import { decapitalize, isMapType } from './jpaTypes.js';

const MAX_EMBEDDING_DEPTH: number = 8;

/** Annotations on the class itself. */
export function classNotes(project: Project, cls: JavaClass): Annotated {
  return new Annotated(cls.annotations, project.lookup, cls.imports);
}

export function isEntityClass(project: Project, cls: JavaClass): boolean {
  return cls.kind === 'class' && classNotes(project, cls).has('Entity');
}

export function isEmbeddableClass(project: Project, cls: JavaClass): boolean {
  return cls.kind === 'class' && classNotes(project, cls).has('Embeddable');
}

export function isMappedSuperclass(project: Project, cls: JavaClass): boolean {
  return (
    cls.kind === 'class' && classNotes(project, cls).has('MappedSuperclass')
  );
}

function isStatic(modifiers: readonly string[]): boolean {
  return modifiers.includes('static');
}

function fieldAttribute(project: Project, cls: JavaClass, field: JavaField) {
  const attribute: Attribute = {
    name: field.name,
    type: field.type,
    notes: new Annotated(field.annotations, project.lookup, cls.imports),
    declaredIn: cls.name,
    imports: cls.imports,
    isProperty: false,
    ...(field.initializer === undefined
      ? {}
      : { initializer: field.initializer }),
  };
  return attribute;
}

/** True for `getX()` / `isX()` without parameters. */
function propertyName(method: {
  name: string;
  parameters: unknown[];
  returnType: { name: string; arrayDepth: number };
}): string | undefined {
  if (method.parameters.length > 0 || method.returnType.name === 'void') {
    return undefined;
  }
  const getter: RegExpMatchArray | null = method.name.match(/^get([A-Z]\w*)$/);
  if (getter !== null) {
    return decapitalize(getter[1] ?? '');
  }
  const flag: RegExpMatchArray | null = method.name.match(/^is([A-Z]\w*)$/);
  if (flag !== null && /^(boolean|Boolean)$/.test(method.returnType.name)) {
    return decapitalize(flag[1] ?? '');
  }
  return undefined;
}

/** Explicit `@Access`, else where the `@Id` (or `@EmbeddedId`) is written, else the access of the superclass. */
export function accessOf(
  project: Project,
  cls: JavaClass,
  inherited: 'field' | 'property'
): 'field' | 'property' {
  const notes: Annotated = classNotes(project, cls);
  const explicit: string | undefined = notes.get('Access')?.member('value');
  if (explicit === 'PROPERTY') {
    return 'property';
  }
  if (explicit === 'FIELD') {
    return 'field';
  }
  const idNames: string[] = ['Id', 'EmbeddedId'];
  const onField: boolean = cls.fields.some(
    (field: JavaField) =>
      !isStatic(field.modifiers) &&
      field.annotations.some((annotation: JavaAnnotation) =>
        idNames.includes(annotation.name)
      )
  );
  if (onField) {
    return 'field';
  }
  const onMethod: boolean = cls.methods.some((method) =>
    method.annotations.some((annotation: JavaAnnotation) =>
      idNames.includes(annotation.name)
    )
  );
  return onMethod ? 'property' : inherited;
}

/** The attributes a class declares (not the ones it inherits), by field or by getter, in source order. */
export function attributesOf(
  project: Project,
  cls: JavaClass,
  access: 'field' | 'property',
  warn: (message: string) => void
): Attribute[] {
  const attributes: Attribute[] = [];
  const persistence: ReadonlySet<string> = new Set([
    'Column',
    'Id',
    'ManyToOne',
    'OneToMany',
    'OneToOne',
    'ManyToMany',
    'Embedded',
    'ElementCollection',
    'Enumerated',
  ]);
  if (access === 'field') {
    for (const field of cls.fields) {
      const keywords: readonly string[] = field.modifiers;
      if (isStatic(keywords) || keywords.includes('transient')) {
        continue;
      }
      const attribute: Attribute = fieldAttribute(project, cls, field);
      if (attribute.notes.has('Transient')) {
        continue;
      }
      attributes.push(attribute);
    }
    for (const method of cls.methods) {
      if (method.annotations.some((item) => item.name === 'Access')) {
        warn(
          `${cls.name}.${method.name}: an attribute switched to property access with @Access is not read; annotate the field instead.`
        );
      }
    }
    return attributes;
  }
  for (const method of cls.methods) {
    const name: string | undefined = propertyName(method);
    if (name === undefined || isStatic(method.modifiers)) {
      continue;
    }
    const attribute: Attribute = {
      name,
      type: method.returnType,
      notes: new Annotated(method.annotations, project.lookup, cls.imports),
      declaredIn: cls.name,
      imports: cls.imports,
      isProperty: true,
    };
    if (attribute.notes.has('Transient')) {
      continue;
    }
    attributes.push(attribute);
  }
  for (const field of cls.fields) {
    if (
      field.annotations.some((annotation: JavaAnnotation) =>
        persistence.has(annotation.name)
      )
    ) {
      warn(
        `${cls.name}.${field.name}: the annotations on a field are ignored because the class uses property access (the @Id is on a getter or @Access(PROPERTY) is set); put them on the getter.`
      );
    }
  }
  return attributes;
}

const RELATION_ANNOTATIONS: readonly string[] = [
  'ManyToOne',
  'OneToOne',
  'OneToMany',
  'ManyToMany',
];

/** How an attribute is mapped: a column, a relationship, or an element collection; embedded ones are flattened. */
function kindOf(attribute: Attribute): MemberKind | 'embedded' {
  const notes: Annotated = attribute.notes;
  if (RELATION_ANNOTATIONS.some((name: string) => notes.has(name))) {
    return 'relation';
  }
  if (notes.has('ElementCollection')) {
    return 'collection';
  }
  if (notes.has('Embedded') || notes.has('EmbeddedId')) {
    return 'embedded';
  }
  return 'basic';
}

/** `@AttributeOverride(s)` of an attribute or class by the path they name. */
function overridesOf(
  notes: Annotated,
  into: Map<string, Ann>,
  warn: (message: string) => void,
  place: string
): void {
  for (const override of notes.repeated(
    'AttributeOverride',
    'AttributeOverrides'
  )) {
    const name: string | undefined = override.string('name');
    const column: Ann | undefined = override.annotation('column');
    if (name !== undefined && column !== undefined && !into.has(name)) {
      into.set(name, column);
    }
  }
  if (
    notes.repeated('AssociationOverride', 'AssociationOverrides').length > 0
  ) {
    warn(
      `${place}: @AssociationOverride is not applied; the join columns of the embedded relationship keep their default names.`
    );
  }
}

/** Class-level `@AttributeOverride`s (they rename columns inherited from a mapped superclass or embedded id). */
export function classOverrides(
  project: Project,
  cls: JavaClass,
  warn: (message: string) => void
): Map<string, Ann> {
  const overrides: Map<string, Ann> = new Map();
  overridesOf(classNotes(project, cls), overrides, warn, cls.name);
  return overrides;
}

export interface FlattenContext {
  project: Project;
  warn: (message: string) => void;
  /** The entity (or subclass) the members are collected for. */
  declaredIn: string;
  /** Type arguments a subclass gives its generic superclass: `BaseEntity<Long>` makes `T` a `Long`. */
  generics?: ReadonlyMap<string, JavaType>;
}

/** Replaces the type parameters of a generic superclass by the arguments a subclass gave it. */
function substitute(
  type: JavaType,
  generics: ReadonlyMap<string, JavaType> | undefined
): JavaType {
  if (generics === undefined || generics.size === 0) {
    return type;
  }
  const replacement: JavaType | undefined = generics.get(type.name);
  const args: JavaType[] = type.args.map((item: JavaType) =>
    substitute(item, generics)
  );
  if (replacement !== undefined && type.args.length === 0) {
    return {
      ...replacement,
      arrayDepth: replacement.arrayDepth + type.arrayDepth,
    };
  }
  return { ...type, args };
}

/**
 * The members of one class: its attributes with the embedded ones replaced by the attributes of the embeddable
 * (at any depth), each with the column override that applies.
 */
export function membersOf(
  ctx: FlattenContext,
  cls: JavaClass,
  access: 'field' | 'property',
  path: string[],
  overrides: Map<string, Ann>,
  insideId: boolean
): Member[] {
  const members: Member[] = [];
  const attributes: Attribute[] = attributesOf(
    ctx.project,
    cls,
    access,
    ctx.warn
  ).map((attribute: Attribute): Attribute => ({
    ...attribute,
    type: substitute(attribute.type, ctx.generics),
  }));
  for (const attribute of attributes) {
    const place: string = `${ctx.declaredIn}.${[...path, attribute.name].join('.')}`;
    if (attribute.notes.has('Formula', true)) {
      ctx.warn(
        `${place}: @Formula is computed in queries, not stored in a column; the attribute was skipped.`
      );
      continue;
    }
    if (
      attribute.notes.has('ManyToAny') ||
      attribute.notes.has('Any') ||
      attribute.notes.has('Any', true)
    ) {
      ctx.warn(
        `${place}: @Any / @ManyToAny polymorphic associations have no equivalent; the attribute was skipped.`
      );
      continue;
    }
    const kind: MemberKind | 'embedded' = kindOf(attribute);
    const target: JavaClass | undefined = ctx.project.classes.get(
      attribute.type.name
    );
    const isEmbeddedType: boolean =
      kind === 'basic' &&
      attribute.type.arrayDepth === 0 &&
      target !== undefined &&
      isEmbeddableClass(ctx.project, target);
    if (kind === 'embedded' || isEmbeddedType) {
      const idRole: boolean = attribute.notes.has('EmbeddedId');
      if (target === undefined || path.length >= MAX_EMBEDDING_DEPTH) {
        ctx.warn(
          `${place}: the embedded type ${attribute.type.name} is not in the input (or is nested too deeply); its columns were not read.`
        );
        continue;
      }
      const nested: Map<string, Ann> = new Map();
      overridesOf(attribute.notes, nested, ctx.warn, place);
      for (const [name, column] of overrides) {
        if (name.startsWith(`${attribute.name}.`)) {
          nested.set(name.slice(attribute.name.length + 1), column);
        }
      }
      members.push(
        ...membersOf(
          ctx,
          target,
          embeddableAccess(ctx.project, target, access),
          [...path, attribute.name],
          nested,
          insideId || idRole
        )
      );
      continue;
    }
    if (attribute.type.name === 'Optional') {
      ctx.warn(
        `${place}: JPA does not allow Optional on a field or getter (Hibernate rejects it); use a nullable type. The attribute was skipped.`
      );
      continue;
    }
    const memberKind: MemberKind = kind;
    if (
      memberKind === 'basic' &&
      isMapType(attribute.type) &&
      !attribute.notes.has('JdbcTypeCode', true) &&
      !attribute.notes.has('Type', true)
    ) {
      ctx.warn(
        `${place}: a Map attribute without @ElementCollection or a JSON type has no column mapping; the attribute was skipped.`
      );
      continue;
    }
    const own: Ann | undefined = attribute.notes.get('Column');
    const override: Ann | undefined = overrides.get(attribute.name);
    members.push({
      attr: attribute,
      path: [...path, attribute.name],
      kind: memberKind,
      ...(override === undefined && own === undefined
        ? {}
        : { column: override ?? own }),
      isId: attribute.notes.has('Id') || insideId,
      inEmbeddedId: insideId,
      declaredIn: ctx.declaredIn,
    });
  }
  return members;
}

/** An embeddable follows the access type of the entity that embeds it unless it says otherwise. */
function embeddableAccess(
  project: Project,
  cls: JavaClass,
  inherited: 'field' | 'property'
): 'field' | 'property' {
  const notes: Annotated = classNotes(project, cls);
  return notes.has('Access') ? accessOf(project, cls, inherited) : inherited;
}
