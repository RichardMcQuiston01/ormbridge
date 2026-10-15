import { navsOf, scalarsOf } from './efcoreEntities.js';
import type { ConfigStore } from './efcoreFluent.js';
import type {
  EntityConfig,
  EntityInfo,
  FluentRelation,
  JoinConfig,
  NavMember,
  ScalarMember,
} from './efcoreModel.js';
import { isValueType } from './efcoreTypes.js';

/** A one-to-many or one-to-one relationship: the dependent entity holds the foreign key. */
export interface Link {
  dependent: EntityInfo;
  principal: EntityInfo;
  /** The navigation on the dependent entity (a single reference), when it exists. */
  dependentNav?: NavMember;
  /** The navigation on the principal entity (a collection or a single reference), when it exists. */
  principalNav?: NavMember;
  /** Foreign key property names on the dependent. */
  foreignKey: string[];
  /** True when the foreign key properties are not in the class (EF creates shadow properties). */
  isShadow: boolean;
  /** Referenced property names on the principal; its primary key by default. */
  principalKey: string[];
  /** True for a one-to-one relationship. */
  isOneToOne: boolean;
  /** Required or optional, when the source decides it. */
  required: boolean | undefined;
  onDelete: string | undefined;
  constraintName: string | undefined;
}

/** A many-to-many relationship through skip navigations. */
export interface ManyToManyLink {
  left: EntityInfo;
  right: EntityInfo;
  leftNav: NavMember | undefined;
  rightNav: NavMember | undefined;
  join: JoinConfig | undefined;
}

export interface Relationships {
  links: Link[];
  manyToMany: ManyToManyLink[];
}

/** Finds a scalar member of an entity by property name, ignoring case. */
export function findScalar(
  info: EntityInfo,
  name: string
): ScalarMember | undefined {
  const scalars: ScalarMember[] = scalarsOf(info).filter(
    (member: ScalarMember) => member.prefix === ''
  );
  return (
    scalars.find((member: ScalarMember) => member.name === name) ??
    scalars.find(
      (member: ScalarMember) => member.name.toLowerCase() === name.toLowerCase()
    )
  );
}

/** The primary key property names of an entity: explicit, or `Id` / `<Type>Id` by convention. */
export function keyOf(info: EntityInfo): string[] {
  if (info.config.key !== undefined) {
    return info.config.key;
  }
  if (info.config.keyless) {
    return [];
  }
  const byId: ScalarMember | undefined = findScalar(info, 'Id');
  if (byId !== undefined) {
    return [byId.name];
  }
  const byTypeId: ScalarMember | undefined = findScalar(info, `${info.name}Id`);
  return byTypeId === undefined ? [] : [byTypeId.name];
}

/** Whether the property can hold null, before the key and relationship rules adjust it. */
export function isNullableMember(
  member: ScalarMember,
  nullableRefs: boolean,
  enumNames: ReadonlySet<string>
): boolean {
  if (member.config.required !== undefined) {
    return !member.config.required;
  }
  if (member.type.nullable) {
    return true;
  }
  if (isValueType(member.type, enumNames)) {
    return false;
  }
  return !nullableRefs;
}

/** Resolves entity names that were merged into a hierarchy root to the root. */
type Resolver = (name: string) => EntityInfo | undefined;

function splitNames(text: string | undefined): string[] {
  return (text ?? '')
    .split(',')
    .map((part: string) => part.trim())
    .filter((part: string) => part !== '');
}

/** Foreign key property names the conventions would pick, or undefined when none match. */
function conventionKey(
  dependent: EntityInfo,
  navigation: string | undefined,
  principal: EntityInfo,
  keyNames: readonly string[],
  allowKeyName: boolean
): string[] | undefined {
  const prefixes: string[] = [];
  if (navigation !== undefined) {
    prefixes.push(navigation);
  }
  prefixes.push(principal.name);
  const patterns: ((key: string) => string)[] = [];
  for (const prefix of prefixes) {
    patterns.push((key: string): string => `${prefix}${key}`);
    patterns.push((): string => `${prefix}Id`);
  }
  if (allowKeyName) {
    patterns.push((key: string): string => key);
  }
  for (const pattern of patterns) {
    const names: string[] = keyNames.map(pattern);
    if (keyNames.length > 1 && new Set(names).size !== names.length) {
      continue;
    }
    const found: ScalarMember[] = [];
    for (const name of names) {
      const member: ScalarMember | undefined = findScalar(dependent, name);
      if (member !== undefined) {
        found.push(member);
      }
    }
    if (found.length === names.length && found.length > 0) {
      return found.map((member: ScalarMember) => member.name);
    }
  }
  return undefined;
}

/** Foreign key names from [ForeignKey] attributes on either navigation or on a scalar property. */
function attributeKey(
  dependent: EntityInfo,
  dependentNav: NavMember | undefined,
  principalNav: NavMember | undefined
): string[] | undefined {
  const fromNav: string[] = splitNames(
    dependentNav?.foreignKeyAttr ?? principalNav?.foreignKeyAttr
  );
  if (fromNav.length > 0) {
    return fromNav;
  }
  if (dependentNav !== undefined) {
    const marked: ScalarMember[] = scalarsOf(dependent).filter(
      (member: ScalarMember) => member.foreignKeyNav === dependentNav.name
    );
    if (marked.length > 0) {
      return marked.map((member: ScalarMember) => member.name);
    }
  }
  return undefined;
}

/** Reads the relationships of the entities from the fluent API, [ForeignKey], [InverseProperty] and conventions. */
export function resolveRelationships(
  infos: readonly EntityInfo[],
  store: ConfigStore,
  resolve: Resolver,
  warn: (message: string) => void
): Relationships {
  const links: Link[] = [];
  const manyToMany: ManyToManyLink[] = [];
  const consumed: Set<NavMember> = new Set();

  const navNamed = (
    info: EntityInfo | undefined,
    name: string | undefined
  ): NavMember | undefined =>
    info === undefined || name === undefined
      ? undefined
      : navsOf(info).find((member: NavMember) => member.name === name);

  const addLink = (
    dependent: EntityInfo,
    principal: EntityInfo,
    dependentNav: NavMember | undefined,
    principalNav: NavMember | undefined,
    isOneToOne: boolean,
    fluent: FluentRelation | undefined
  ): void => {
    const keyNames: string[] =
      fluent?.principalKey !== undefined && fluent.principalKey.length > 0
        ? fluent.principalKey
        : keyOf(principal);
    if (keyNames.length === 0) {
      warn(
        `${dependent.name}${dependentNav === undefined ? '' : `.${dependentNav.name}`}: the relationship to ${principal.name} was skipped because ${principal.name} has no primary key to reference.`
      );
      return;
    }
    const explicit: string[] | undefined =
      fluent?.foreignKey !== undefined && fluent.foreignKey.length > 0
        ? fluent.foreignKey
        : attributeKey(dependent, dependentNav, principalNav);
    const foreignKey: string[] | undefined =
      explicit ??
      conventionKey(
        dependent,
        dependentNav?.name,
        principal,
        keyNames,
        isOneToOne
      );
    const shadow: string[] = keyNames.map(
      (key: string) => `${dependentNav?.name ?? principal.name}${key}`
    );
    const names: string[] = foreignKey ?? shadow;
    const isShadow: boolean = names.some(
      (name: string) => findScalar(dependent, name) === undefined
    );
    links.push({
      dependent,
      principal,
      ...(dependentNav === undefined ? {} : { dependentNav }),
      ...(principalNav === undefined ? {} : { principalNav }),
      foreignKey: names.map(
        (name: string) => findScalar(dependent, name)?.name ?? name
      ),
      isShadow,
      principalKey: keyNames,
      isOneToOne,
      required: fluent?.required,
      onDelete: fluent?.onDelete ?? store.globalDeleteBehavior,
      constraintName: fluent?.constraintName,
    });
    if (dependentNav !== undefined) {
      consumed.add(dependentNav);
    }
    if (principalNav !== undefined) {
      consumed.add(principalNav);
    }
  };

  // Relationships configured with the fluent API ---------------------------------------------
  const configs: EntityConfig[] = [...store.entities.values()];
  for (const config of configs) {
    for (const rel of config.relations) {
      const owner: EntityInfo | undefined = resolve(rel.owner);
      const ownerNav: NavMember | undefined = navNamed(owner, rel.ownerNav);
      const targetName: string | undefined = ownerNav?.target ?? rel.target;
      const target: EntityInfo | undefined =
        targetName === undefined ? undefined : resolve(targetName);
      const place: string = `${rel.owner}.${rel.ownerNav ?? `${rel.ownerMany ? 'HasMany' : 'HasOne'}<${rel.target ?? '?'}>`}`;
      if (!rel.complete) {
        warn(
          `${place}: the relationship has no WithOne / WithMany call and was ignored.`
        );
        continue;
      }
      if (owner === undefined || target === undefined) {
        warn(
          `${place}: the relationship points to ${targetName ?? 'an unknown type'}, which is not an entity in the input; it was skipped.`
        );
        continue;
      }
      const inverseNav: NavMember | undefined = navNamed(
        target,
        rel.inverseNav
      );
      if (rel.ownerMany && rel.inverseMany) {
        manyToMany.push({
          left: owner,
          right: target,
          leftNav: ownerNav,
          rightNav: inverseNav,
          join: rel.join,
        });
        if (ownerNav !== undefined) {
          consumed.add(ownerNav);
        }
        if (inverseNav !== undefined) {
          consumed.add(inverseNav);
        }
        continue;
      }
      if (!rel.ownerMany && rel.inverseMany) {
        addLink(owner, target, ownerNav, inverseNav, false, rel);
      } else if (rel.ownerMany) {
        addLink(target, owner, inverseNav, ownerNav, false, rel);
      } else {
        // One to one: the entity that holds the foreign key is the dependent.
        const named: EntityInfo | undefined =
          rel.foreignKeyEntity === undefined
            ? undefined
            : resolve(rel.foreignKeyEntity);
        const keyed: string[] = rel.foreignKey ?? [];
        const holds = (
          side: EntityInfo,
          sideNav: NavMember | undefined,
          other: EntityInfo,
          allowKeyName: boolean
        ): boolean =>
          named !== undefined
            ? named === side
            : keyed.length > 0
              ? keyed.every(
                  (name: string) => findScalar(side, name) !== undefined
                )
              : conventionKey(
                  side,
                  sideNav?.name,
                  other,
                  keyOf(other),
                  allowKeyName
                ) !== undefined;
        let ownerHolds: boolean = holds(owner, ownerNav, target, false);
        let targetHolds: boolean = holds(target, inverseNav, owner, false);
        if (!ownerHolds && !targetHolds) {
          ownerHolds = holds(owner, ownerNav, target, true);
          targetHolds = holds(target, inverseNav, owner, true);
        }
        if (ownerHolds || !targetHolds) {
          if (!ownerHolds && !targetHolds) {
            warn(
              `${place}: the dependent side of the one-to-one relationship is not named (HasForeignKey) and no foreign key property was found; ${owner.name} was assumed.`
            );
          }
          addLink(owner, target, ownerNav, inverseNav, true, rel);
        } else {
          addLink(target, owner, inverseNav, ownerNav, true, rel);
        }
      }
    }
  }

  // Relationships found by convention, [ForeignKey] and [InverseProperty] --------------------
  for (const info of infos) {
    for (const nav of navsOf(info)) {
      if (consumed.has(nav)) {
        continue;
      }
      const place: string = `${info.name}.${nav.name}`;
      const target: EntityInfo | undefined = resolve(nav.target);
      if (target === undefined) {
        warn(
          `${place}: ${nav.target} is not an entity in the input; the navigation was skipped.`
        );
        consumed.add(nav);
        continue;
      }
      const candidates: NavMember[] = navsOf(target).filter(
        (other: NavMember) =>
          other !== nav &&
          !consumed.has(other) &&
          resolve(other.target) === info
      );
      let inverse: NavMember | undefined;
      if (nav.inverseAttr !== undefined) {
        inverse = candidates.find(
          (other: NavMember) => other.name === nav.inverseAttr
        );
      } else {
        const pointing: NavMember[] = candidates.filter(
          (other: NavMember) => other.inverseAttr === nav.name
        );
        const free: NavMember[] =
          pointing.length > 0
            ? pointing
            : candidates.filter(
                (other: NavMember) => other.inverseAttr === undefined
              );
        if (free.length === 1) {
          inverse = free[0];
        } else if (free.length > 1) {
          warn(
            `${place}: ${target.name} has several navigations back to ${info.name} (${free
              .map((other: NavMember) => other.name)
              .join(
                ', '
              )}); add [InverseProperty] or WithMany(...) to pair them. The navigation was skipped.`
          );
          consumed.add(nav);
          continue;
        }
      }
      if (inverse !== undefined && nav.inverseAttr === undefined) {
        // Another navigation of this entity that also points to the target competes for the same inverse.
        const competitors: NavMember[] = navsOf(info).filter(
          (other: NavMember) =>
            other !== nav &&
            other !== inverse &&
            !consumed.has(other) &&
            other.inverseAttr === undefined &&
            resolve(other.target) === target
        );
        if (competitors.length > 0) {
          warn(
            `${place}: ${info.name} has several navigations to ${target.name} (${[
              nav,
              ...competitors,
            ]
              .map((other: NavMember) => other.name)
              .join(
                ', '
              )}) and ${target.name}.${inverse.name} could belong to any of them; add [InverseProperty] or WithMany(...) to pair them. The navigations were skipped.`
          );
          consumed.add(nav);
          for (const other of competitors) {
            consumed.add(other);
          }
          continue;
        }
      }
      if (nav.many && inverse?.many === true) {
        manyToMany.push({
          left: info,
          right: target,
          leftNav: nav,
          rightNav: inverse,
          join: undefined,
        });
        consumed.add(nav);
        consumed.add(inverse);
        continue;
      }
      if (nav.many) {
        addLink(target, info, inverse, nav, false, undefined);
        consumed.add(nav);
        continue;
      }
      if (inverse?.many === true) {
        addLink(info, target, nav, inverse, false, undefined);
        consumed.add(nav);
        continue;
      }
      if (inverse === undefined) {
        addLink(info, target, nav, undefined, false, undefined);
        consumed.add(nav);
        continue;
      }
      // Single to single: a one-to-one. The dependent is the side that has the foreign key.
      const keyOn = (
        side: EntityInfo,
        sideNav: NavMember,
        other: EntityInfo,
        otherNav: NavMember,
        allowKeyName: boolean
      ): boolean => {
        // A [ForeignKey] on either navigation names the key, but only the side that has those properties holds it.
        const named: string[] | undefined = attributeKey(
          side,
          sideNav,
          otherNav
        );
        if (named !== undefined) {
          return named.every(
            (name: string) => findScalar(side, name) !== undefined
          );
        }
        return (
          conventionKey(
            side,
            sideNav.name,
            other,
            keyOf(other),
            allowKeyName
          ) !== undefined
        );
      };
      let keyOnInfo: boolean = keyOn(info, nav, target, inverse, false);
      let keyOnTarget: boolean = keyOn(target, inverse, info, nav, false);
      if (!keyOnInfo && !keyOnTarget) {
        keyOnInfo = keyOn(info, nav, target, inverse, true);
        keyOnTarget = keyOn(target, inverse, info, nav, true);
      }
      if (keyOnInfo || !keyOnTarget) {
        if (!keyOnInfo && !keyOnTarget) {
          warn(
            `${place}: neither side of the one-to-one relationship with ${target.name} has a foreign key property; EF Core needs HasForeignKey. ${info.name} was assumed to be the dependent.`
          );
        }
        addLink(info, target, nav, inverse, true, undefined);
      } else {
        addLink(target, info, inverse, nav, true, undefined);
      }
      consumed.add(nav);
      consumed.add(inverse);
    }
  }
  return { links, manyToMany };
}
