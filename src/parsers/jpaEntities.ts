import type { Ann } from './jpaAnnotations.js';
import type {
  JavaAnnotation,
  JavaClass,
  JavaField,
  JavaType,
} from './javaSyntax.js';
import {
  accessOf,
  classNotes,
  classOverrides,
  isEntityClass,
  isMappedSuperclass,
  membersOf,
} from './jpaClasses.js';
import type {
  EntityInfo,
  InheritanceKind,
  Member,
  Project,
} from './jpaModel.js';
import type { Annotated } from './jpaAnnotations.js';

// ---------------------------------------------------------------------------
// Entities and hierarchies
// ---------------------------------------------------------------------------

const IGNORED_SUPERCLASSES: ReadonlySet<string> = new Set([
  'Object',
  'Serializable',
]);

function strategyOf(project: Project, root: JavaClass): InheritanceKind {
  const strategy: string | undefined = classNotes(project, root)
    .get('Inheritance')
    ?.member('strategy');
  switch (strategy) {
    case 'JOINED':
      return 'joined';
    case 'TABLE_PER_CLASS':
      return 'tablePerClass';
    default:
      return 'singleTable';
  }
}

/** The superclasses of a class that are in the input, root first. */
function superclassChain(
  project: Project,
  cls: JavaClass,
  warn: (message: string) => void
): JavaClass[] {
  const chain: JavaClass[] = [];
  const seen: Set<string> = new Set([cls.name]);
  let current: JavaClass = cls;
  while (current.superclass !== undefined) {
    const name: string = current.superclass.name;
    const parent: JavaClass | undefined = project.classes.get(name);
    if (parent === undefined) {
      if (!IGNORED_SUPERCLASSES.has(name)) {
        warn(
          `${cls.name}: the superclass ${name} is not in the input, so the attributes it declares are not read.`
        );
      }
      break;
    }
    if (seen.has(name)) {
      break;
    }
    seen.add(name);
    chain.unshift(parent);
    current = parent;
  }
  return chain;
}

/** Finds the entity classes of the input and arranges them into hierarchies. */
export function discoverEntities(
  project: Project,
  warn: (message: string) => void
): EntityInfo[] {
  const infos: Map<string, EntityInfo> = new Map();
  for (const cls of project.classes.values()) {
    if (!isEntityClass(project, cls)) {
      continue;
    }
    const notes: Annotated = classNotes(project, cls);
    const chain: JavaClass[] = [...superclassChain(project, cls, warn), cls];
    infos.set(cls.name, {
      cls,
      name: cls.name,
      entityName: notes.get('Entity')?.string('name') || cls.name,
      notes,
      chain,
      children: [],
      // Set to the first entity of the hierarchy below, once every entity is known.
      root: undefined as unknown as EntityInfo,
      inheritance: 'none',
      accesses: [],
      isAbstract: cls.modifiers.includes('abstract'),
      members: [],
    });
  }
  for (const info of infos.values()) {
    const ancestors: EntityInfo[] = info.chain
      .slice(0, -1)
      .flatMap((cls: JavaClass): EntityInfo[] => {
        const found: EntityInfo | undefined = infos.get(cls.name);
        return found === undefined ? [] : [found];
      });
    const parent: EntityInfo | undefined = ancestors[ancestors.length - 1];
    if (parent !== undefined) {
      info.parent = parent;
      parent.children.push(info);
    }
    info.root = ancestors[0] ?? info;
  }
  for (const info of infos.values()) {
    if (info.root === info && info.children.length === 0) {
      info.inheritance = 'none';
    } else {
      info.inheritance = strategyOf(project, info.root.cls);
    }
    let access: 'field' | 'property' = 'field';
    for (const cls of info.chain) {
      access = accessOf(project, cls, access);
      info.accesses.push(access);
    }
  }
  return [...infos.values()];
}

/**
 * The type arguments the classes below `position` of a chain gave to its generic class:
 * `class User extends BaseEntity<Long>` makes the parameter `T` of `BaseEntity` a `Long`.
 */
function genericsAt(
  chain: readonly JavaClass[],
  position: number
): Map<string, JavaType> {
  const generics: Map<string, JavaType> = new Map();
  for (let index = chain.length - 2; index >= position; index -= 1) {
    const parent: JavaClass | undefined = chain[index];
    const child: JavaClass | undefined = chain[index + 1];
    const given: JavaType[] = child?.superclass?.args ?? [];
    const next: Map<string, JavaType> = new Map();
    parent?.typeParameters.forEach((name: string, argument: number) => {
      const type: JavaType | undefined = given[argument];
      if (type !== undefined) {
        next.set(name, generics.get(type.name) ?? type);
      }
    });
    generics.clear();
    for (const [name, type] of next) {
      generics.set(name, type);
    }
  }
  return generics;
}

/** True for a class whose attributes JPA maps into the tables of its subclasses or itself. */
function isPersistentClass(project: Project, cls: JavaClass): boolean {
  return isEntityClass(project, cls) || isMappedSuperclass(project, cls);
}

/** The persistence annotations that only make sense on a mapped class. */
const MAPPING_ANNOTATIONS: ReadonlySet<string> = new Set([
  'Id',
  'Column',
  'ManyToOne',
  'OneToOne',
  'OneToMany',
  'ManyToMany',
  'Embedded',
  'EmbeddedId',
  'Basic',
]);

/**
 * The members that make up an entity's table. Mapped superclasses come first. With single-table inheritance the
 * root also takes the members of every subclass (they must allow null); with joined inheritance a subclass takes
 * only what it declares itself; with table-per-class every class of the chain contributes.
 */
export function entityMembers(
  project: Project,
  info: EntityInfo,
  warn: (message: string) => void
): Member[] {
  const members: Member[] = [];
  const add = (entity: EntityInfo, from: number): void => {
    const overrides: Map<string, Ann> = classOverrides(
      project,
      entity.cls,
      warn
    );
    entity.chain.forEach((cls: JavaClass, position: number) => {
      if (position < from) {
        return;
      }
      if (!isPersistentClass(project, cls)) {
        if (
          cls.fields.some((field: JavaField) =>
            field.annotations.some((item: JavaAnnotation) =>
              MAPPING_ANNOTATIONS.has(item.name)
            )
          )
        ) {
          warn(
            `${entity.name}: the superclass ${cls.name} has mapping annotations but no @MappedSuperclass or @Entity, so JPA does not persist its attributes.`
          );
        }
        return;
      }
      members.push(
        ...membersOf(
          {
            project,
            warn,
            declaredIn: entity.name,
            generics: genericsAt(entity.chain, position),
          },
          cls,
          entity.accesses[position] ?? 'field',
          [],
          overrides,
          false
        )
      );
    });
  };
  let first: number = 0;
  if (info.inheritance === 'joined' && info.parent !== undefined) {
    first = info.chain.indexOf(info.parent.cls) + 1;
  }
  add(info, first);
  if (info.inheritance === 'singleTable' && info.root === info) {
    const visit = (entity: EntityInfo): void => {
      for (const child of entity.children) {
        add(child, child.chain.indexOf(entity.cls) + 1);
        visit(child);
      }
    };
    visit(info);
  }
  return members;
}
