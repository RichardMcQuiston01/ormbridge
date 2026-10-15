import {
  parseTypeText,
  type CsAttribute,
  type CsClass,
  type CsProperty,
  type CsType,
} from './csharpSyntax.js';
import {
  annotateProperty,
  isOwnedByAttribute,
  newOwnedConfig,
} from './efcoreAnnotations.js';
import type { ConfigStore } from './efcoreFluent.js';
import type {
  EntityConfig,
  EntityInfo,
  Member,
  NavMember,
  OwnedConfig,
  PropConfig,
  Project,
  Scope,
  ScalarMember,
} from './efcoreModel.js';
import {
  elementType,
  isCollectionType,
  isKnownScalar,
  isKnownUnsupported,
} from './efcoreTypes.js';

const MAX_OWNED_DEPTH: number = 4;
const MAX_HIERARCHY_DEPTH: number = 32;

/** The class a class derives from, when that class is in the input. */
function parentOf(cls: CsClass, project: Project): CsClass | undefined {
  for (const base of cls.bases) {
    const candidate: CsClass | undefined = project.classes.get(base.name);
    if (
      candidate !== undefined &&
      candidate.kind !== 'interface' &&
      candidate !== cls
    ) {
      return candidate;
    }
  }
  return undefined;
}

/** A class and its ancestors in the input, base first. */
export function classChain(cls: CsClass, project: Project): CsClass[] {
  const chain: CsClass[] = [cls];
  let current: CsClass = cls;
  for (let depth: number = 0; depth < MAX_HIERARCHY_DEPTH; depth += 1) {
    const parent: CsClass | undefined = parentOf(current, project);
    if (parent === undefined || chain.includes(parent)) {
      break;
    }
    chain.unshift(parent);
    current = parent;
  }
  return chain;
}

/** Maps the type parameters of generic base classes to the arguments the derived class gave them. */
function substitutions(chain: CsClass[]): Map<CsClass, Map<string, CsType>> {
  const result: Map<CsClass, Map<string, CsType>> = new Map();
  for (const cls of chain) {
    result.set(cls, new Map());
  }
  for (let index: number = chain.length - 1; index > 0; index -= 1) {
    const child: CsClass | undefined = chain[index];
    const parent: CsClass | undefined = chain[index - 1];
    if (child === undefined || parent === undefined) {
      continue;
    }
    const base: CsType | undefined = child.bases.find(
      (candidate: CsType) => candidate.name === parent.name
    );
    const own: Map<string, CsType> = result.get(child) ?? new Map();
    const target: Map<string, CsType> = result.get(parent) ?? new Map();
    parent.typeParameters.forEach((parameter: string, position: number) => {
      const argument: CsType | undefined = base?.args[position];
      if (argument !== undefined) {
        target.set(parameter, own.get(argument.name) ?? argument);
      }
    });
  }
  return result;
}

function substitute(
  type: CsType,
  map: Map<string, CsType> | undefined
): CsType {
  const replacement: CsType | undefined = map?.get(type.name);
  if (replacement !== undefined) {
    return {
      ...replacement,
      nullable: type.nullable || replacement.nullable,
      arrayDepth: replacement.arrayDepth + type.arrayDepth,
    };
  }
  if (type.args.length === 0) {
    return type;
  }
  return {
    ...type,
    args: type.args.map((argument: CsType) => substitute(argument, map)),
  };
}

/**
 * True for a get-only navigation that the fluent API configures by name, as in
 * `public IReadOnlyCollection<Review> Reviews => _reviews;` with `HasMany(p => p.Reviews)`: EF Core
 * reaches it through its backing field.
 */
function isConfiguredNavigation(
  property: CsProperty,
  navNames: ReadonlySet<string>,
  project: Project
): boolean {
  if (
    property.isField ||
    property.modifiers.includes('static') ||
    !navNames.has(property.name)
  ) {
    return false;
  }
  const inner: CsType = isCollectionType(property.type)
    ? (property.type.args[0] ?? property.type)
    : property.type;
  return project.classes.has(inner.name);
}

function isMapped(
  property: CsProperty,
  navNames: ReadonlySet<string>,
  project: Project
): boolean {
  if (isConfiguredNavigation(property, navNames, project)) {
    return true;
  }
  if (property.isField || property.isComputed) {
    return false;
  }
  if (
    property.modifiers.includes('static') ||
    property.modifiers.includes('abstract') ||
    property.name === 'this'
  ) {
    return false;
  }
  return property.hasGetter && property.hasSetter;
}

function attributeArg(property: CsProperty, name: string): string | undefined {
  const found: CsAttribute | undefined = property.attributes.find(
    (item: CsAttribute) => item.name === name
  );
  const node = found?.args[0];
  if (node === undefined) {
    return undefined;
  }
  // [ForeignKey("AuthorId")] and [ForeignKey(nameof(AuthorId))]
  const text: string = node.text;
  const quoted: RegExpMatchArray | null = text.match(/^"(.*)"$/);
  if (quoted !== null) {
    return quoted[1];
  }
  const named: RegExpMatchArray | null = text.match(
    /^nameof\((?:[\w.]*\.)?(\w+)\)$/
  );
  return named === null ? text : named[1];
}

function foreignKeyNav(property: CsProperty): { foreignKeyNav?: string } {
  const named: string | undefined = attributeArg(property, 'ForeignKey');
  return named === undefined ? {} : { foreignKeyNav: named };
}

interface ClassifyContext {
  project: Project;
  store: ConfigStore;
  enumNames: ReadonlySet<string>;
  entityNames: ReadonlySet<string>;
  subst: Map<CsClass, Map<string, CsType>>;
  declaredIn: string;
  nullableRefs: boolean;
  warn: (message: string) => void;
  place: string;
}

function isOwnedProperty(
  type: CsType,
  property: CsProperty,
  scope: Scope,
  ctx: ClassifyContext
): boolean {
  const inner: CsType = elementType(type) ?? type;
  const cls: CsClass | undefined = ctx.project.classes.get(inner.name);
  return (
    scope.owned.has(property.name) ||
    ctx.store.ownedTypes.has(inner.name) ||
    (cls !== undefined && isOwnedByAttribute(cls))
  );
}

/** True for a property whose type is a class from the input that is not a scalar, enum or owned type. */
function isNavigation(type: CsType, ctx: ClassifyContext): boolean {
  const inner: CsType = isCollectionType(type) ? (type.args[0] ?? type) : type;
  const cls: CsClass | undefined = ctx.project.classes.get(inner.name);
  return (
    cls !== undefined &&
    (cls.kind === 'class' || cls.kind === 'record') &&
    !ctx.enumNames.has(inner.name) &&
    type.arrayDepth === 0
  );
}

/** Classifies the properties of one class (and its owned types) into scalar columns and navigations. */
function classifyProperties(
  properties: readonly CsProperty[],
  cls: CsClass,
  scope: Scope,
  prefix: string,
  forceNullable: boolean,
  depth: number,
  ctx: ClassifyContext,
  members: Member[]
): void {
  const map: Map<string, CsType> | undefined = ctx.subst.get(cls);
  const siblings: Set<string> = new Set(
    properties.map((property: CsProperty) => property.name.toLowerCase())
  );
  for (const property of properties) {
    if (
      !isMapped(property, ctx.store.navigationNames(), ctx.project) ||
      scope.ignored.has(property.name)
    ) {
      continue;
    }
    const type: CsType = substitute(property.type, map);
    const place: string = `${cls.name}.${property.name}`;
    const settings: PropConfig = {
      ...(scope.props.get(property.name) ?? {}),
    };
    if (settings.ignored === true) {
      continue;
    }
    if (isOwnedProperty(type, property, scope, ctx)) {
      const inner: CsType = elementType(type) ?? type;
      const nested: CsClass | undefined = ctx.project.classes.get(inner.name);
      const ownedScope: OwnedConfig =
        scope.owned.get(property.name) ??
        newOwnedConfig(property.name, isCollectionType(type));
      if (ownedScope.many || isCollectionType(type)) {
        ctx.warn(
          `${place}: the owned collection of ${inner.name} is stored in a separate table, which is not represented; the property was skipped.`
        );
        continue;
      }
      if (ownedScope.toJson) {
        members.push({
          kind: 'scalar',
          path: `${prefix}${property.name}`,
          name: property.name,
          type: {
            ...type,
            name: 'JsonDocument',
            text: 'JsonDocument',
            args: [],
          },
          config: { ...settings },
          declaredIn: cls.name,
          prefix,
          forceNullable: forceNullable || type.nullable,
          isJson: true,
        });
        continue;
      }
      if (nested === undefined || depth >= MAX_OWNED_DEPTH) {
        ctx.warn(
          `${place}: the owned type ${inner.name} is not in the input or is nested too deeply; the property was skipped.`
        );
        continue;
      }
      const ownedChain: CsClass[] = classChain(nested, ctx.project);
      const ownedProperties: CsProperty[] = ownedChain.flatMap(
        (item: CsClass) => item.properties
      );
      // Annotations on the owned type's properties apply unless the fluent API said otherwise.
      for (const ownedProperty of ownedProperties) {
        const fluent: PropConfig | undefined = ownedScope.props.get(
          ownedProperty.name
        );
        const annotated: PropConfig = {};
        annotateProperty(ownedProperty, annotated, ctx.store.consts);
        ownedScope.props.set(ownedProperty.name, { ...annotated, ...fluent });
        if (annotated.ignored === true) {
          ownedScope.ignored.add(ownedProperty.name);
        }
      }
      const ownedMembers: Member[] = [];
      const ownedSubst: Map<CsClass, Map<string, CsType>> = substitutions(
        ownedChain
      );
      for (const ownedClass of ownedChain) {
        classifyProperties(
          ownedClass.properties,
          ownedClass,
          ownedScope,
          `${prefix}${property.name}.`,
          forceNullable || type.nullable,
          depth + 1,
          { ...ctx, subst: ownedSubst, declaredIn: ownedClass.name },
          ownedMembers
        );
      }
      members.push(...ownedMembers);
      continue;
    }
    if (isKnownScalar(type, ctx.enumNames) || isKnownUnsupported(type)) {
      members.push({
        kind: 'scalar',
        path: `${prefix}${property.name}`,
        name: property.name,
        type,
        config: settings,
        declaredIn: cls.name,
        prefix,
        forceNullable,
        ...foreignKeyNav(property),
      });
      continue;
    }
    if (isNavigation(type, ctx)) {
      if (prefix !== '') {
        ctx.warn(
          `${place}: a navigation inside an owned type is not interpreted and was skipped.`
        );
        continue;
      }
      const many: boolean = isCollectionType(type);
      const inner: CsType = many ? (type.args[0] ?? type) : type;
      const foreignKeyAttr: string | undefined = attributeArg(
        property,
        'ForeignKey'
      );
      const inverseAttr: string | undefined = attributeArg(
        property,
        'InverseProperty'
      );
      const nav: NavMember = {
        kind: 'nav',
        name: property.name,
        target: inner.name,
        many,
        nullable: type.nullable,
        declaredIn: cls.name,
        requiredAttr: property.attributes.some(
          (item: CsAttribute) => item.name === 'Required'
        ),
        ...(foreignKeyAttr === undefined ? {} : { foreignKeyAttr }),
        ...(inverseAttr === undefined ? {} : { inverseAttr }),
      };
      members.push(nav);
      continue;
    }
    // A type that is neither a known column type nor a class from the input.
    const inner: CsType = isCollectionType(type)
      ? (type.args[0] ?? type)
      : type;
    const looksLikeNavigation: boolean =
      isCollectionType(type) ||
      siblings.has(`${property.name}id`.toLowerCase()) ||
      siblings.has(`${property.name}_id`.toLowerCase());
    if (looksLikeNavigation && !isKnownScalar(inner, ctx.enumNames)) {
      ctx.warn(
        `${place}: the type ${type.text}${type.args.length > 0 ? '<...>' : ''} is not a model in the input, so the ${isCollectionType(type) ? 'collection ' : ''}navigation was skipped.`
      );
      continue;
    }
    members.push({
      kind: 'scalar',
      path: `${prefix}${property.name}`,
      name: property.name,
      type,
      config: settings,
      declaredIn: cls.name,
      prefix,
      forceNullable,
      ...foreignKeyNav(property),
    });
  }
}

/** Adds the navigation targets of every entity to the store until no new entity appears. */
export function expandEntities(
  store: ConfigStore,
  project: Project,
  enumNames: ReadonlySet<string>
): void {
  for (let index: number = 0; index < store.entityOrder.length; index += 1) {
    const name: string | undefined = store.entityOrder[index];
    const cls: CsClass | undefined =
      name === undefined ? undefined : project.classes.get(name);
    const config: EntityConfig | undefined =
      name === undefined ? undefined : store.entity(name);
    if (cls === undefined || config === undefined) {
      continue;
    }
    const chain: CsClass[] = classChain(cls, project);
    const ctx: ClassifyContext = {
      project,
      store,
      enumNames,
      entityNames: new Set(store.entityOrder),
      subst: substitutions(chain),
      declaredIn: cls.name,
      nullableRefs: false,
      warn: () => undefined,
      place: cls.name,
    };
    for (const item of chain) {
      for (const property of item.properties) {
        if (
          !isMapped(property, store.navigationNames(), project) ||
          config.ignored.has(property.name)
        ) {
          continue;
        }
        const type: CsType = substitute(property.type, ctx.subst.get(item));
        if (
          isOwnedProperty(type, property, config, ctx) ||
          isKnownScalar(type, enumNames) ||
          !isNavigation(type, ctx)
        ) {
          continue;
        }
        const inner: CsType = isCollectionType(type)
          ? (type.args[0] ?? type)
          : type;
        const target: CsClass | undefined = project.classes.get(inner.name);
        if (
          target !== undefined &&
          !store.ignoredEntities.has(inner.name) &&
          !target.attributes.some(
            (attribute: CsAttribute) => attribute.name === 'NotMapped'
          )
        ) {
          store.addEntity(inner.name);
        }
      }
    }
  }
}

function nullableRefsFor(cls: CsClass, project: Project): boolean {
  const directive: 'enable' | 'disable' | undefined =
    project.nullableByPath.get(cls.path);
  if (directive === 'enable') {
    return true;
  }
  if (directive === 'disable') {
    return false;
  }
  return project.nullableReferences;
}

/** Reads the mapped members of every entity and groups table-per-hierarchy inheritance under its root. */
export function buildEntities(
  store: ConfigStore,
  project: Project,
  enumNames: ReadonlySet<string>
): EntityInfo[] {
  const entityNames: ReadonlySet<string> = new Set(store.entityOrder);
  const infos: Map<string, EntityInfo> = new Map();

  // First the hierarchy: which entity is the base of which.
  const baseOf: Map<string, string> = new Map();
  for (const name of store.entityOrder) {
    const cls: CsClass | undefined = project.classes.get(name);
    const config: EntityConfig | undefined = store.entity(name);
    if (cls === undefined || config === undefined) {
      continue;
    }
    if (config.baseType !== undefined) {
      if (config.baseType !== '' && entityNames.has(config.baseType)) {
        baseOf.set(name, config.baseType);
      }
      continue;
    }
    const chain: CsClass[] = classChain(cls, project);
    for (let index: number = chain.length - 2; index >= 0; index -= 1) {
      const ancestor: CsClass | undefined = chain[index];
      if (ancestor !== undefined && entityNames.has(ancestor.name)) {
        baseOf.set(name, ancestor.name);
        break;
      }
    }
  }

  const isSeparateTable = (name: string): boolean => {
    const base: string | undefined = baseOf.get(name);
    const config: EntityConfig | undefined = store.entity(name);
    if (base === undefined || config === undefined) {
      return true;
    }
    const baseConfig: EntityConfig | undefined = store.entity(base);
    return (
      config.mapping === 'tpt' ||
      config.mapping === 'tpc' ||
      baseConfig?.mapping === 'tpt' ||
      baseConfig?.mapping === 'tpc' ||
      (config.table !== undefined && config.table !== baseConfig?.table) ||
      (config.viewName !== undefined &&
        config.viewName !== baseConfig?.viewName)
    );
  };

  for (const name of store.entityOrder) {
    const cls: CsClass | undefined = project.classes.get(name);
    const config: EntityConfig | undefined = store.entity(name);
    if (cls === undefined || config === undefined) {
      continue;
    }
    const base: string | undefined = baseOf.get(name);
    const separate: boolean = isSeparateTable(name);
    if (base !== undefined && separate) {
      project.warnings.push(
        `${name}: table-per-type or table-per-concrete-type inheritance (the base entity ${base} is stored in another table) is not represented; ${name} was read as an independent table with the columns of its base classes.`
      );
    }
    let chain: CsClass[] = classChain(cls, project);
    if (base !== undefined && !separate) {
      // Table per hierarchy: only the classes below the base entity belong to this entity.
      const baseIndex: number = chain.findIndex(
        (item: CsClass) => item.name === base
      );
      chain = chain.slice(baseIndex + 1);
    }
    const subst = substitutions(classChain(cls, project));
    const members: Member[] = [];
    const nullableRefs: boolean = nullableRefsFor(cls, project);
    for (const item of chain) {
      classifyProperties(
        item.properties,
        item,
        config,
        '',
        false,
        0,
        {
          project,
          store,
          enumNames,
          entityNames,
          subst,
          declaredIn: item.name,
          nullableRefs,
          warn: (message: string) => project.warnings.push(message),
          place: item.name,
        },
        members
      );
    }
    const chainNames: Set<string> = new Set(
      classChain(cls, project).flatMap((item: CsClass) =>
        item.properties.map((property: CsProperty) => property.name)
      )
    );
    for (const [propertyName, settings] of config.props) {
      if (settings.declared !== true || config.ignored.has(propertyName)) {
        continue;
      }
      if (chainNames.has(propertyName)) {
        continue;
      }
      if (settings.shadowType === undefined) {
        project.warnings.push(
          `${name}: the fluent API configures the property "${propertyName}", which the class does not have (a shadow property needs Property<T>("${propertyName}")); the settings were ignored.`
        );
        continue;
      }
      // A shadow property exists only in the model: it is a column like any other.
      members.push({
        kind: 'scalar',
        path: propertyName,
        name: propertyName,
        type: parseTypeText(settings.shadowType),
        config: settings,
        declaredIn: name,
        prefix: '',
        forceNullable: false,
      });
    }
    const baseClass: CsType | undefined = cls.bases.find(
      (base: CsType) =>
        !project.classes.has(base.name) &&
        !/^I[A-Z]/.test(base.name) &&
        base.name !== 'object'
    );
    if (baseClass !== undefined && !project.classes.has(baseClass.name)) {
      project.warnings.push(
        `${name}: the base class ${baseClass.name} is not in the input; the properties it declares (a key, timestamps, ...) were not read.`
      );
    }
    infos.set(name, {
      name,
      cls,
      config,
      root: base !== undefined && !separate ? base : name,
      derived: [],
      members,
      nullableRefs,
      order: project.classOrder.get(name) ?? 0,
    });
  }

  // Resolve roots of chains (A : B : C) and collect derived entities under them.
  const rootOf = (name: string): string => {
    let current: string = name;
    for (let depth: number = 0; depth < MAX_HIERARCHY_DEPTH; depth += 1) {
      const info: EntityInfo | undefined = infos.get(current);
      if (info === undefined || info.root === current) {
        break;
      }
      current = info.root;
    }
    return current;
  };
  for (const info of infos.values()) {
    info.root = rootOf(info.name);
    if (info.root !== info.name) {
      infos.get(info.root)?.derived.push(info.name);
    }
  }
  return [...infos.values()].sort(
    (first: EntityInfo, second: EntityInfo) => first.order - second.order
  );
}

/** Names the mapped scalar members of an entity. */
export function scalarsOf(info: EntityInfo): ScalarMember[] {
  return info.members.filter(
    (member: Member): member is ScalarMember => member.kind === 'scalar'
  );
}

/** Names the navigations of an entity. */
export function navsOf(info: EntityInfo): NavMember[] {
  return info.members.filter(
    (member: Member): member is NavMember => member.kind === 'nav'
  );
}
