import { tableNameOf } from './efcoreBuild.js';
import type { ConfigStore } from './efcoreFluent.js';
import type {
  EntityInfo,
  NavMember,
  PropConfig,
  ScalarMember,
} from './efcoreModel.js';
import { findScalar, keyOf, type Link } from './efcoreRelations.js';

const INTEGER_KEYS: ReadonlySet<string> = new Set([
  'int',
  'Int32',
  'long',
  'Int64',
  'short',
  'Int16',
]);

/**
 * Gives the child entity of every owned collection (`OwnsMany`) the key and foreign key EF Core adds: a foreign key
 * to the owner named after the owner and its key (`CustomerId`, for a composite key `OrderCustomerId` and
 * `OrderId`), and a key made of those columns plus an `Id` (the property of that name, else a generated integer).
 * The table is named after the owned class, or after the owner's table and the collection (`Customers_Lines`) when
 * several owners own the same class. Returns the foreign keys as relationships; a collection whose owner has no
 * key cannot be keyed and is removed from `entities` with a warning.
 */
export function completeOwnedCollections(
  entities: EntityInfo[],
  resolve: (name: string) => EntityInfo | undefined,
  store: ConfigStore,
  warn: (message: string) => void
): Link[] {
  const links: Link[] = [];
  const children: EntityInfo[] = entities.filter(
    (info: EntityInfo) => info.ownedBy !== undefined
  );
  const owners: Map<string, number> = new Map();
  for (const child of children) {
    owners.set(child.cls.name, (owners.get(child.cls.name) ?? 0) + 1);
  }
  for (const child of children) {
    const ownedBy: EntityInfo['ownedBy'] = child.ownedBy;
    const owner: EntityInfo | undefined =
      ownedBy === undefined ? undefined : resolve(ownedBy.owner);
    if (ownedBy === undefined || owner === undefined) {
      continue;
    }
    const place: string = `${owner.name}.${ownedBy.navigation}`;
    const ownerKey: string[] = keyOf(owner);
    if (ownerKey.length === 0) {
      warn(
        `${place}: the owned collection of ${child.cls.name} needs ${owner.name} to have a primary key to reference; the collection was skipped.`
      );
      entities.splice(entities.indexOf(child), 1);
      continue;
    }
    const foreignKey: ScalarMember[] = ownerKey.map(
      (path: string): ScalarMember => {
        const member: ScalarMember | undefined = findScalar(owner, path);
        const name: string = `${owner.cls.name}${path}`;
        return {
          kind: 'scalar',
          path: name,
          name,
          type: {
            name: member?.type.name ?? 'int',
            text: member?.type.text ?? 'int',
            args: member?.type.args ?? [],
            nullable: false,
            arrayDepth: member?.type.arrayDepth ?? 0,
          },
          config: { required: true },
          declaredIn: child.name,
          prefix: '',
          forceNullable: false,
        };
      }
    );
    const declared: ScalarMember | undefined = findScalar(child, 'Id');
    let id: ScalarMember;
    if (declared === undefined) {
      id = {
        kind: 'scalar',
        path: 'Id',
        name: 'Id',
        type: {
          name: 'int',
          text: 'int',
          args: [],
          nullable: false,
          arrayDepth: 0,
        },
        config: { generated: 'onAdd' },
        declaredIn: child.name,
        prefix: '',
        forceNullable: false,
      };
    } else {
      id = declared;
      const settings: PropConfig = id.config;
      if (settings.generated === undefined && INTEGER_KEYS.has(id.type.name)) {
        settings.generated = 'onAdd';
      }
    }
    child.members = [
      ...foreignKey,
      id,
      ...child.members.filter((member) => member !== declared),
    ];
    const foreignNames: string[] = foreignKey.map(
      (member: ScalarMember) => member.name
    );
    child.config.key = [...foreignNames, 'Id'];
    if (child.config.table === undefined) {
      child.config.table =
        (owners.get(child.cls.name) ?? 0) > 1
          ? `${tableNameOf(owner, store)}_${ownedBy.navigation}`
          : child.cls.name;
    }
    if (child.config.schema === undefined) {
      const ownerSchema: string | undefined = owner.config.schema;
      if (ownerSchema !== undefined) {
        child.config.schema = ownerSchema;
      }
    }
    const dependentNav: NavMember = {
      kind: 'nav',
      name: owner.cls.name,
      target: owner.name,
      many: false,
      nullable: false,
      declaredIn: child.name,
      requiredAttr: true,
    };
    const principalNav: NavMember = {
      kind: 'nav',
      name: ownedBy.navigation,
      target: child.name,
      many: true,
      nullable: false,
      declaredIn: owner.name,
      requiredAttr: false,
    };
    links.push({
      dependent: child,
      principal: owner,
      dependentNav,
      principalNav,
      foreignKey: foreignNames,
      isShadow: false,
      principalKey: ownerKey,
      isOneToOne: false,
      required: true,
      onDelete: 'Cascade',
      constraintName: undefined,
    });
  }
  return links;
}
