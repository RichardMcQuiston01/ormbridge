import type {
  IrCompositeForeignKey,
  IrEnum,
  IrField,
  IrIndex,
  IrIndexFieldOptions,
  IrModel,
  IrOnDelete,
  IrRelation,
  IrSchema,
} from '../ir.js';
import { toCamelCase, toSnakeCase } from '../naming.js';
import { scalarsOf } from './efcoreEntities.js';
import {
  buildField,
  columnNameOf,
  irFieldName,
  type BuiltField,
} from './efcoreFields.js';
import type { ConfigStore } from './efcoreFluent.js';
import type {
  ConfigIndex,
  EntityConfig,
  EntityInfo,
  JoinConfig,
  Member,
  NavMember,
  Project,
  ScalarMember,
} from './efcoreModel.js';
import {
  findScalar,
  isNullableMember,
  keyOf,
  type Link,
  type ManyToManyLink,
  type Relationships,
} from './efcoreRelations.js';
import { deleteBehavior } from './efcoreTypes.js';

export interface BuildOptions {
  appLabel: string;
}

export const INDEX_METHODS: Readonly<Record<string, string>> = {
  btree: 'BTree',
  hash: 'Hash',
  gin: 'Gin',
  gist: 'Gist',
  spgist: 'SpGist',
  brin: 'BRIN',
};

/** Merges the derived entities of a table-per-hierarchy into their root, making their columns nullable. */
export function mergeHierarchies(
  infos: readonly EntityInfo[],
  warn: (message: string) => void
): EntityInfo[] {
  const byName: Map<string, EntityInfo> = new Map(
    infos.map((info: EntityInfo): [string, EntityInfo] => [info.name, info])
  );
  const roots: EntityInfo[] = [];
  for (const info of infos) {
    if (info.root !== info.name) {
      continue;
    }
    if (info.derived.length === 0) {
      roots.push(info);
      continue;
    }
    const members: Member[] = [...info.members];
    for (const name of info.derived) {
      const derived: EntityInfo | undefined = byName.get(name);
      if (derived === undefined) {
        continue;
      }
      for (const member of derived.members) {
        if (member.kind === 'scalar') {
          if (
            !members.some(
              (item) => item.kind === 'scalar' && item.path === member.path
            )
          ) {
            members.push({ ...member, forceNullable: true });
          }
        } else if (
          !members.some(
            (item) => item.kind === 'nav' && item.name === member.name
          )
        ) {
          members.push(member);
        }
      }
    }
    warn(
      `${info.name}: ${info.derived.join(', ')} derive${info.derived.length === 1 ? 's' : ''} from ${info.name} in one table (table per hierarchy). The hierarchy was read as a single model with the columns of every type (those of the derived types nullable) and a discriminator column; derived types are not separate models.`
    );
    roots.push({ ...info, members });
  }
  return roots;
}

function stripKeySuffix(name: string): string {
  const stripped: string = name.replace(/(?:Id|ID|_id)$/, '');
  return stripped === '' ? name : stripped;
}

/** Default join table and column names EF Core uses for a skip navigation, to compare with the IR convention. */
function joinNames(link: ManyToManyLink): {
  table: string;
  left: string;
  right: string;
} {
  const join: JoinConfig | undefined = link.join;
  const leftKey: string = keyOf(link.left)[0] ?? 'Id';
  const rightKey: string = keyOf(link.right)[0] ?? 'Id';
  const sorted: [string, string] =
    link.left.name <= link.right.name
      ? [link.left.name, link.right.name]
      : [link.right.name, link.left.name];
  return {
    table: join?.table ?? join?.entityName ?? `${sorted[0]}${sorted[1]}`,
    left:
      join?.leftColumn ?? `${link.rightNav?.name ?? link.left.name}${leftKey}`,
    right:
      join?.rightColumn ??
      `${link.leftNav?.name ?? link.right.name}${rightKey}`,
  };
}

/** Assembles the IR from the entities and their relationships. */
export function buildSchema(
  infos: readonly EntityInfo[],
  relationships: Relationships,
  store: ConfigStore,
  project: Project,
  options: BuildOptions
): IrSchema {
  const warnings: string[] = project.warnings;
  const warn = (message: string): void => {
    warnings.push(message);
  };
  const usedEnums: Map<string, IrEnum> = new Map();
  const models: IrModel[] = [];
  /** The IR names of the key properties of each built entity, by entity name and property path. */
  const keyIrNames: Map<string, Map<string, string>> = new Map();

  for (const info of infos) {
    const config: EntityConfig = info.config;
    const place: string = info.name;
    const keyNames: string[] = keyOf(info);
    const scalars: ScalarMember[] = scalarsOf(info);
    const fieldContext = {
      project,
      info,
      keyNames,
      warn,
    };

    // Columns ------------------------------------------------------------------------
    const built: BuiltField[] = scalars.map((member: ScalarMember) =>
      buildField(member, fieldContext, project.enums)
    );
    for (const item of built) {
      const definition: IrEnum | undefined = item.enumDefinition;
      if (definition === undefined) {
        continue;
      }
      const known: IrEnum | undefined = usedEnums.get(definition.name);
      if (known === undefined) {
        usedEnums.set(definition.name, definition);
      } else if (
        known.values.some(
          (value, position) =>
            value.dbValue !== definition.values[position]?.dbValue
        )
      ) {
        // One C# enum stored as text in one column and as a number in another: the IR has one enum per name.
        warn(
          `${place}.${item.member.name}: the enum ${definition.name} is stored differently in different columns (text and integer); the IR keeps one definition, with the text values.`
        );
        if (definition.values.every((value) => value.dbValue === value.name)) {
          usedEnums.set(definition.name, definition);
        }
      }
    }

    // Table-per-hierarchy discriminator ----------------------------------------------------
    if (info.derived.length > 0) {
      const discriminator = config.discriminator;
      const column: string = discriminator?.column ?? 'Discriminator';
      const exists: boolean = built.some(
        (item: BuiltField) =>
          item.member.path.toLowerCase() === column.toLowerCase()
      );
      if (!exists) {
        const isInteger: boolean = /^(int|Int32|long|byte|short)$/.test(
          discriminator?.type ?? ''
        );
        built.push({
          member: {
            kind: 'scalar',
            path: column,
            name: column,
            type: {
              name: 'string',
              text: 'string',
              args: [],
              nullable: false,
              arrayDepth: 0,
            },
            config: {},
            declaredIn: info.name,
            prefix: '',
            forceNullable: false,
          },
          field: {
            name: toCamelCase(column),
            columnName: column,
            type: isInteger ? 'int' : 'text',
            isPrimaryKey: false,
            isUnique: false,
            isNullable: false,
            isAutoUpdated: false,
          },
        });
      }
    }

    // Relationships ---------------------------------------------------------------------
    const irNames: Map<string, string> = new Map(
      built.map((item: BuiltField): [string, string] => [
        item.member.path,
        item.field.name,
      ])
    );
    interface Ordered<T> {
      order: number;
      value: T;
    }
    const orderedRelations: Ordered<IrRelation>[] = [];
    const compositeKeys: IrCompositeForeignKey[] = [];
    const consumed: Set<string> = new Set();
    const relationNameOf: Map<string, string> = new Map();
    const takenNames: Set<string> = new Set(
      built.map((item: BuiltField) => item.field.name)
    );
    const memberOrder = (nav: NavMember | undefined): number =>
      nav === undefined
        ? info.members.length + orderedRelations.length
        : info.members.findIndex((member) => member === nav);
    const unique: Set<string> = uniqueColumns(config);

    for (const link of relationships.links) {
      if (link.dependent !== info) {
        continue;
      }
      const principal: EntityInfo = link.principal;
      const members: (ScalarMember | undefined)[] = link.foreignKey.map(
        (name: string) => findScalar(info, name)
      );
      const location: string = `${info.name}.${link.dependentNav?.name ?? link.foreignKey.join('+')}`;
      const baseName: string =
        link.dependentNav !== undefined
          ? toCamelCase(link.dependentNav.name)
          : toCamelCase(
              link.isShadow || members[0] === undefined
                ? principal.name
                : stripKeySuffix(members[0].name)
            );
      let relationName: string = baseName;
      while (
        takenNames.has(relationName) &&
        !(
          members.length === 1 &&
          irNames.get(members[0]?.path ?? '') === relationName
        )
      ) {
        relationName = `${relationName}Ref`;
      }
      const principalKeyMembers: (ScalarMember | undefined)[] =
        link.principalKey.map((name: string) => findScalar(principal, name));
      const required: boolean = isRequiredLink(link, members, info, project);
      const requestedAction: string | undefined = link.onDelete;
      // EF Core's default is Cascade for a required relationship and ClientSetNull for an optional one.
      let onDelete: IrOnDelete = required ? 'cascade' : 'noAction';
      if (requestedAction !== undefined) {
        const mapped: IrOnDelete | undefined = deleteBehavior(requestedAction);
        if (mapped === undefined) {
          warn(
            `${location}: the delete behavior ${requestedAction} is not known; the default for ${required ? 'a required' : 'an optional'} relationship was used.`
          );
        } else {
          onDelete = mapped;
        }
      }
      const relatedName: string | undefined =
        link.principalNav === undefined
          ? undefined
          : toCamelCase(link.principalNav.name);
      const firstKey: ScalarMember | undefined = members[0];
      const fkIsKey: boolean =
        members.length === 1 &&
        firstKey !== undefined &&
        keyNames.length === 1 &&
        keyNames[0] === firstKey.path;
      const isUnique: boolean =
        link.isOneToOne ||
        fkIsKey ||
        (members.length === 1 &&
          firstKey !== undefined &&
          unique.has(firstKey.path));
      const kind: 'foreignKey' | 'oneToOne' = isUnique
        ? 'oneToOne'
        : 'foreignKey';
      const constraintName: string | undefined = link.constraintName;

      if (members.length > 1) {
        const missing: boolean =
          members.some((member) => member === undefined) || link.isShadow;
        if (missing) {
          warn(
            `${location}: a composite foreign key made of shadow properties cannot be represented; the relationship was skipped.`
          );
          continue;
        }
        compositeKeys.push({
          name: relationName,
          targetModel: principal.name,
          fields: members.map(
            (member) => irNames.get(member?.path ?? '') ?? ''
          ),
          references: principalKeyMembers.map(
            (member, index) =>
              // A key column that is a foreign key in the principal is named by its relation there.
              keyIrNames
                .get(principal.name)
                ?.get(link.principalKey[index] ?? '') ??
              (member === undefined
                ? toCamelCase(link.principalKey[index] ?? '')
                : irFieldName(member))
          ),
          kind,
          isNullable: !required,
          onDelete,
          ...(relatedName === undefined ? {} : { relatedName }),
          ...(constraintName === undefined ? {} : { constraintName }),
        });
        takenNames.add(relationName);
        continue;
      }

      const columnName: string =
        firstKey === undefined
          ? (link.foreignKey[0] ?? relationName)
          : columnNameOf(firstKey);
      const principalIsKey: boolean =
        link.principalKey.length === keyOf(principal).length &&
        link.principalKey.every(
          (name: string, index: number) => keyOf(principal)[index] === name
        );
      const referenced: ScalarMember | undefined = principalKeyMembers[0];
      const relation: IrRelation = {
        name: relationName,
        kind,
        targetModel: principal.name,
        columnName,
        isNullable: fkIsKey ? false : !required,
        onDelete,
        ...(relatedName === undefined ? {} : { relatedName }),
        ...(principalIsKey || referenced === undefined
          ? {}
          : { toField: columnNameOf(referenced) }),
        ...(fkIsKey ? { isPrimaryKey: true } : {}),
        ...(constraintName === undefined ? {} : { constraintName }),
      };
      orderedRelations.push({
        order: memberOrder(link.dependentNav),
        value: relation,
      });
      takenNames.add(relationName);
      if (firstKey !== undefined) {
        consumed.add(firstKey.path);
        relationNameOf.set(firstKey.path, relationName);
      } else if (link.foreignKey[0] !== undefined) {
        relationNameOf.set(link.foreignKey[0], relationName);
      }
    }

    // Many-to-many ---------------------------------------------------------------------------
    for (const link of relationships.manyToMany) {
      if (link.left !== info) {
        continue;
      }
      const nav: NavMember | undefined = link.leftNav;
      if (link.join?.entityClass !== undefined) {
        warn(
          `${info.name}.${nav?.name ?? '?'}: the skip navigation through the join entity ${link.join.entityClass} is read as that entity and its relationships; no separate many-to-many relation was added.`
        );
        continue;
      }
      const relationName: string = toCamelCase(
        nav?.name ?? `${link.right.name}s`
      );
      const relation: IrRelation = {
        name: relationName,
        kind: 'manyToMany',
        targetModel: link.right.name,
        columnName: `${toSnakeCase(relationName)}_id`,
        isNullable: false,
        onDelete: 'cascade',
        ...(link.rightNav === undefined
          ? {}
          : { relatedName: toCamelCase(link.rightNav.name) }),
      };
      orderedRelations.push({ order: memberOrder(nav), value: relation });
      takenNames.add(relationName);
      const actual = joinNames(link);
      const isSelf: boolean = link.left === link.right;
      const expectedTable: string = `${tableNameOf(info, store)}_${relationName}`;
      const expectedLeft: string = `${isSelf ? 'from_' : ''}${toSnakeCase(link.left.name)}_id`;
      const expectedRight: string = `${isSelf ? 'to_' : ''}${toSnakeCase(link.right.name)}_id`;
      if (
        actual.table !== expectedTable ||
        actual.left !== expectedLeft ||
        actual.right !== expectedRight
      ) {
        warn(
          `${info.name}.${nav?.name ?? '?'}: the join table "${actual.table}" (columns ${actual.left}, ${actual.right}) is not preserved by name; ` +
            `formats that derive join tables will use "${expectedTable}" (columns ${expectedLeft}, ${expectedRight}).`
        );
      }
    }

    // Fields ---------------------------------------------------------------------------------
    const fields: IrField[] = built
      .filter((item: BuiltField) => !consumed.has(item.member.path))
      .map((item: BuiltField) => item.field);
    const fieldOf = (path: string): IrField | undefined => {
      const item: BuiltField | undefined = built.find(
        (candidate: BuiltField) => candidate.member.path === path
      );
      return item === undefined
        ? undefined
        : fields.find((field: IrField) => field === item.field);
    };
    const irNameFor = (path: string): string | undefined => {
      const relationName: string | undefined = relationNameOf.get(path);
      if (relationName !== undefined) {
        return relationName;
      }
      return irNames.get(path);
    };

    // Primary key ------------------------------------------------------------------------------
    let compositePrimaryKey: string[] | undefined;
    if (keyNames.length === 0) {
      if (config.keyless || config.viewName !== undefined) {
        if (config.viewName === undefined) {
          warn(
            `${place}: the entity has no key (HasNoKey); other formats expect every model to have a primary key.`
          );
        }
      } else {
        warn(
          `${place}: the entity has no primary key (EF Core looks for a property called Id or ${info.name}Id, or a [Key] / HasKey); other formats expect every model to have one.`
        );
      }
    } else {
      for (const name of keyNames) {
        if (findScalar(info, name) === undefined) {
          warn(
            `${place}: the key property "${name}" is not a mapped property of the entity.`
          );
        }
      }
      if (keyNames.length > 1) {
        compositePrimaryKey = keyNames
          .map((name: string) => irNameFor(name) ?? toCamelCase(name))
          .filter((name: string) => name !== '');
        for (const name of keyNames) {
          const field: IrField | undefined = fieldOf(name);
          if (field !== undefined) {
            field.isPrimaryKey = false;
            field.isUnique = false;
          }
        }
        for (const relation of orderedRelations) {
          delete relation.value.isPrimaryKey;
        }
      }
    }

    keyIrNames.set(
      info.name,
      new Map(
        keyNames.map((name: string): [string, string] => [
          name,
          irNameFor(name) ?? toCamelCase(name),
        ])
      )
    );

    // Indexes ---------------------------------------------------------------------------------
    const irIndexes: IrIndex[] = [];
    const seen: Set<string> = new Set();
    for (const index of allIndexes(info, store)) {
      const names: string[] = [];
      let skip: boolean = false;
      for (const member of index.members) {
        const name: string | undefined = irNameFor(member);
        if (name === undefined) {
          warn(
            `${place}: the index${index.name === undefined ? '' : ` "${index.name}"`} refers to "${member}", which is not a mapped property; it was skipped.`
          );
          skip = true;
          break;
        }
        names.push(name);
      }
      if (skip || names.length === 0) {
        continue;
      }
      const signature: string = `${index.unique ? 'u' : 'i'}|${names.join(',')}|${index.name ?? ''}`;
      if (seen.has(signature)) {
        continue;
      }
      seen.add(signature);
      const label: string = index.name === undefined ? '' : ` "${index.name}"`;
      if (index.hasFilter) {
        warn(
          `${place}: the index${label} has a filter (a partial index), which is not preserved; it was read as a full index.`
        );
      }
      if (index.hasInclude) {
        warn(
          `${place}: the index${label} includes extra columns (IncludeProperties), which are not preserved.`
        );
      }
      const method: string | undefined =
        index.method === undefined
          ? undefined
          : INDEX_METHODS[index.method.toLowerCase()];
      if (index.method !== undefined && method === undefined) {
        warn(
          `${place}: the index method "${index.method}" has no equivalent and was ignored.`
        );
      }
      const fieldOptions: Record<string, IrIndexFieldOptions> = {};
      index.descending.forEach((flag: boolean, position: number) => {
        const name: string | undefined = names[position];
        if (flag && name !== undefined) {
          fieldOptions[name] = { sort: 'desc' };
        }
      });
      const only: string | undefined = names[0];
      if (
        names.length === 1 &&
        only !== undefined &&
        index.unique &&
        index.name === undefined &&
        method === undefined &&
        Object.keys(fieldOptions).length === 0
      ) {
        const member: string | undefined = index.members[0];
        const field: IrField | undefined =
          member === undefined ? undefined : fieldOf(member);
        if (field !== undefined) {
          if (!field.isPrimaryKey) {
            field.isUnique = true;
          }
          continue;
        }
        if (member !== undefined && consumed.has(member)) {
          // The unique key is a foreign key: the relation is one-to-one.
          continue;
        }
      }
      irIndexes.push({
        fields: names,
        isUnique: index.unique,
        ...(index.name === undefined ? {} : { name: index.name }),
        ...(method === undefined ? {} : { method }),
        ...(Object.keys(fieldOptions).length === 0 ? {} : { fieldOptions }),
      });
    }

    // Settings that have no equivalent ---------------------------------------------------------
    const comments: string[] = [];
    if (config.comment !== undefined) {
      comments.push('the table');
    }
    const nonUnicode: string[] = [];
    for (const item of built) {
      if (item.member.config.isUnicode === false) {
        nonUnicode.push(item.member.name);
      }
      if (item.member.config.comment !== undefined) {
        comments.push(item.member.name);
      }
      if (
        item.member.config.isRowVersion === true ||
        item.member.config.isConcurrencyToken === true
      ) {
        warn(
          `${place}.${item.member.name}: the ${item.member.config.isRowVersion === true ? 'row version ([Timestamp] / IsRowVersion)' : 'concurrency token'} has no equivalent in the shared model; it was read as an ordinary column.`
        );
      }
    }
    if (nonUnicode.length > 0) {
      warn(
        `${place}: the columns ${nonUnicode.join(', ')} are not Unicode (varchar instead of nvarchar); the shared model does not tell the two apart.`
      );
    }
    if (comments.length > 0) {
      warn(`${place}: comments (${comments.join(', ')}) are not preserved.`);
    }
    for (const constraint of config.checkConstraints) {
      warn(
        `${place}: the check constraint "${constraint}" has no equivalent in the shared model and was dropped.`
      );
    }
    if (config.hasData) {
      warn(`${place}: seed data (HasData) is not preserved.`);
    }
    if (config.hasQueryFilter) {
      warn(
        `${place}: the global query filter (HasQueryFilter) is not schema and was ignored.`
      );
    }
    for (const derived of info.derived) {
      const derivedConfig: EntityConfig | undefined = store.entity(derived);
      if (derivedConfig?.hasData === true) {
        warn(`${derived}: seed data (HasData) is not preserved.`);
      }
    }

    const relations: IrRelation[] = [...orderedRelations]
      .sort((first, second) => first.order - second.order)
      .map((entry) => entry.value);
    const isView: boolean = config.viewName !== undefined;
    const schema: string | undefined = config.schema ?? store.defaultSchema;
    models.push({
      name: info.name,
      tableName: tableNameOf(info, store),
      appLabel: options.appLabel,
      fields,
      relations,
      indexes: irIndexes,
      ...(compositePrimaryKey === undefined ? {} : { compositePrimaryKey }),
      ...(compositeKeys.length === 0
        ? {}
        : { compositeForeignKeys: compositeKeys }),
      ...(isView ? { isView: true } : {}),
      ...(schema === undefined ? {} : { schema }),
      ...(config.keyName === undefined
        ? {}
        : { primaryKeyName: config.keyName }),
    });
  }
  return { models, enums: [...usedEnums.values()], warnings };
}

/** The table (or view) name: ToTable / [Table], else the DbSet property name, else the type name. */
export function tableNameOf(info: EntityInfo, store: ConfigStore): string {
  return (
    info.config.viewName ??
    info.config.table ??
    store.project.dbSets.get(info.name) ??
    info.name
  );
}

/** The paths of single properties that carry a unique index or alternate key without a name. */
function uniqueColumns(config: EntityConfig): Set<string> {
  const paths: Set<string> = new Set();
  for (const index of config.indexes) {
    const only: string | undefined = index.members[0];
    if (index.unique && index.members.length === 1 && only !== undefined) {
      paths.add(only);
    }
  }
  return paths;
}

/** The indexes of an entity and of the entities merged into it. */
function allIndexes(info: EntityInfo, store: ConfigStore): ConfigIndex[] {
  const configs: (EntityConfig | undefined)[] = [
    info.config,
    ...info.derived.map((name: string) => store.entity(name)),
  ];
  return configs.flatMap((config) => config?.indexes ?? []);
}

/** Whether the relationship is required: configured, or implied by the foreign key and navigation nullability. */
function isRequiredLink(
  link: Link,
  members: readonly (ScalarMember | undefined)[],
  info: EntityInfo,
  project: Project
): boolean {
  if (link.required !== undefined) {
    return link.required;
  }
  const enumNames: ReadonlySet<string> = new Set(project.enums.keys());
  if (!link.isShadow) {
    return members.every(
      (member) =>
        member !== undefined &&
        !isNullableMember(member, info.nullableRefs, enumNames)
    );
  }
  const nav: NavMember | undefined = link.dependentNav;
  if (nav === undefined) {
    return false;
  }
  return nav.requiredAttr || (info.nullableRefs && !nav.nullable);
}
