import {
  evaluate,
  type ConstLookup,
  type CsAttribute,
  type CsClass,
  type CsProperty,
  type CsValue,
  type SyntaxNode,
} from './csharpSyntax.js';
import { selectedMembers } from './csharpChains.js';
import type {
  ConfigIndex,
  EntityConfig,
  OwnedConfig,
  PropConfig,
  Scope,
} from './efcoreModel.js';

/** Attributes that only matter to EF Core and tell that a class is an entity when present. */
const CLASS_ENTITY_ATTRIBUTES: ReadonlySet<string> = new Set([
  'Table',
  'Index',
  'PrimaryKey',
  'Keyless',
  'EntityTypeConfiguration',
]);

const PROPERTY_ENTITY_ATTRIBUTES: ReadonlySet<string> = new Set([
  'Key',
  'ForeignKey',
  'InverseProperty',
  'DatabaseGenerated',
  'Column',
  'Timestamp',
]);

export function newScope(): Scope {
  return { props: new Map(), ignored: new Set(), owned: new Map() };
}

export function newOwnedConfig(nav: string, many: boolean): OwnedConfig {
  return { ...newScope(), nav, many, toJson: false };
}

export function newEntityConfig(name: string): EntityConfig {
  return {
    ...newScope(),
    name,
    keyless: false,
    indexes: [],
    relations: [],
    hasData: false,
    hasQueryFilter: false,
    checkConstraints: [],
    notMapped: false,
  };
}

export function propConfig(scope: Scope, name: string): PropConfig {
  const existing: PropConfig | undefined = scope.props.get(name);
  if (existing !== undefined) {
    return existing;
  }
  const created: PropConfig = {};
  scope.props.set(name, created);
  return created;
}

/**
 * True when a class, or a class it derives from, carries an attribute that only EF Core reads (a data
 * annotation of the model). `chain` is the class and its ancestors in the input.
 */
export function hasEntityAnnotations(chain: readonly CsClass[]): boolean {
  const last: CsClass | undefined = chain[chain.length - 1];
  return chain.some(
    (cls: CsClass) =>
      (cls === last &&
        cls.attributes.some((attribute: CsAttribute) =>
          CLASS_ENTITY_ATTRIBUTES.has(attribute.name)
        )) ||
      cls.properties.some((property: CsProperty) =>
        property.attributes.some((attribute: CsAttribute) =>
          PROPERTY_ENTITY_ATTRIBUTES.has(attribute.name)
        )
      )
  );
}

function stringArg(
  node: SyntaxNode | undefined,
  consts: ConstLookup
): string | undefined {
  if (node === undefined) {
    return undefined;
  }
  const value: CsValue = evaluate(node, consts);
  return value.kind === 'string' ? value.value : undefined;
}

function numberArg(
  node: SyntaxNode | undefined,
  consts: ConstLookup
): number | undefined {
  if (node === undefined) {
    return undefined;
  }
  const value: CsValue = evaluate(node, consts);
  return value.kind === 'number' ? value.value : undefined;
}

function boolArg(
  node: SyntaxNode | undefined,
  consts: ConstLookup
): boolean | undefined {
  if (node === undefined) {
    return undefined;
  }
  const value: CsValue = evaluate(node, consts);
  return value.kind === 'bool' ? value.value : undefined;
}

/** The last segment of a member path argument, e.g. `Identity` of `DatabaseGeneratedOption.Identity`. */
function enumMemberArg(
  node: SyntaxNode | undefined,
  consts: ConstLookup
): string | undefined {
  if (node === undefined) {
    return undefined;
  }
  const value: CsValue = evaluate(node, consts);
  return value.kind === 'member'
    ? value.path[value.path.length - 1]
    : undefined;
}

/** Applies the data annotations of one property to its settings. */
export function annotateProperty(
  property: CsProperty,
  config: PropConfig,
  consts: ConstLookup
): void {
  for (const item of property.attributes) {
    switch (item.name) {
      case 'Key':
        config.isKey = true;
        break;
      case 'Column': {
        const name: string | undefined = stringArg(item.args[0], consts);
        if (name !== undefined) {
          config.column = name;
        }
        const typeName: string | undefined = stringArg(
          item.named.get('TypeName'),
          consts
        );
        if (typeName !== undefined) {
          config.columnType = typeName;
        }
        break;
      }
      case 'Required':
        config.required = true;
        break;
      case 'MaxLength':
      case 'StringLength': {
        const length: number | undefined = numberArg(item.args[0], consts);
        if (length !== undefined && length > 0 && length < 2 ** 31 - 1) {
          config.maxLength = length;
        }
        break;
      }
      case 'DatabaseGenerated': {
        const option: string | undefined = enumMemberArg(item.args[0], consts);
        if (option === 'Identity') {
          config.generated = 'onAdd';
        } else if (option === 'Computed') {
          config.generated = 'onAddOrUpdate';
        } else if (option === 'None') {
          config.generated = 'never';
        }
        break;
      }
      case 'Timestamp':
        config.isRowVersion = true;
        config.isConcurrencyToken = true;
        break;
      case 'ConcurrencyCheck':
        config.isConcurrencyToken = true;
        break;
      case 'Precision': {
        const precision: number | undefined = numberArg(item.args[0], consts);
        const scale: number | undefined = numberArg(item.args[1], consts);
        if (precision !== undefined) {
          config.precision = precision;
          config.scale = scale ?? 0;
        }
        break;
      }
      case 'Comment': {
        const comment: string | undefined = stringArg(item.args[0], consts);
        if (comment !== undefined) {
          config.comment = comment;
        }
        break;
      }
      case 'NotMapped':
        config.ignored = true;
        break;
      case 'Unicode': {
        config.isUnicode = boolArg(item.args[0], consts) ?? true;
        break;
      }
      default:
        break;
    }
  }
}

/** Reads one `[Index(...)]` attribute into an index definition. */
function readIndexAttribute(
  item: CsAttribute,
  consts: ConstLookup
): ConfigIndex | undefined {
  const members: string[] = [];
  for (const argument of item.args) {
    const names: string[] | undefined = selectedMembers(argument, consts);
    if (names === undefined) {
      return undefined;
    }
    members.push(...names);
  }
  if (members.length === 0) {
    return undefined;
  }
  const descending: boolean[] = [];
  const all: boolean | undefined = boolArg(
    item.named.get('AllDescending'),
    consts
  );
  const perColumn: SyntaxNode | undefined = item.named.get('IsDescending');
  if (all === true) {
    members.forEach(() => descending.push(true));
  } else if (perColumn !== undefined) {
    const value: CsValue = evaluate(perColumn, consts);
    if (value.kind === 'array') {
      for (const flag of value.items) {
        descending.push(flag.kind === 'bool' && flag.value);
      }
    }
  }
  const name: string | undefined = stringArg(item.named.get('Name'), consts);
  return {
    members,
    unique: boolArg(item.named.get('IsUnique'), consts) ?? false,
    ...(name === undefined ? {} : { name }),
    hasFilter: false,
    hasInclude: false,
    descending,
  };
}

/** Applies the class-level data annotations and the property annotations of a class chain (base first). */
export function annotateEntity(
  chain: CsClass[],
  config: EntityConfig,
  consts: ConstLookup,
  warn: (message: string) => void
): void {
  const keyed: string[] = [];
  for (const cls of chain) {
    for (const item of cls.attributes) {
      switch (item.name) {
        case 'Table': {
          const name: string | undefined = stringArg(item.args[0], consts);
          if (name !== undefined) {
            config.table = name;
          }
          const schema: string | undefined = stringArg(
            item.named.get('Schema'),
            consts
          );
          if (schema !== undefined) {
            config.schema = schema;
          }
          break;
        }
        case 'Index': {
          const index: ConfigIndex | undefined = readIndexAttribute(
            item,
            consts
          );
          if (index === undefined) {
            warn(
              `${cls.name}: the [Index] attribute (${item.node.text}) could not be read and was skipped.`
            );
          } else {
            config.indexes.push(index);
          }
          break;
        }
        case 'PrimaryKey': {
          const members: string[] = [];
          for (const argument of item.args) {
            members.push(...(selectedMembers(argument, consts) ?? []));
          }
          if (members.length > 0) {
            config.key = members;
          }
          break;
        }
        case 'Keyless':
          config.keyless = true;
          break;
        case 'NotMapped':
          config.notMapped = true;
          break;
        case 'Comment': {
          const comment: string | undefined = stringArg(item.args[0], consts);
          if (comment !== undefined) {
            config.comment = comment;
          }
          break;
        }
        default:
          break;
      }
    }
    for (const property of cls.properties) {
      if (property.isField) {
        continue;
      }
      const settings: PropConfig = propConfig(config, property.name);
      annotateProperty(property, settings, consts);
      if (settings.ignored === true) {
        config.ignored.add(property.name);
      }
      if (settings.isKey === true && !keyed.includes(property.name)) {
        keyed.push(property.name);
      }
    }
  }
  if (config.key === undefined && keyed.length > 0) {
    config.key = keyed;
  }
}

/** True when a class is marked [Owned] or [ComplexType]. */
export function isOwnedByAttribute(cls: CsClass): boolean {
  return cls.attributes.some(
    (item: CsAttribute) => item.name === 'Owned' || item.name === 'ComplexType'
  );
}

/** Applies the property annotations of an owned type to the scope of its owner navigation. */
export function annotateScope(
  chain: CsClass[],
  scope: Scope,
  consts: ConstLookup
): void {
  for (const cls of chain) {
    for (const property of cls.properties) {
      if (property.isField) {
        continue;
      }
      const settings: PropConfig = propConfig(scope, property.name);
      annotateProperty(property, settings, consts);
      if (settings.ignored === true) {
        scope.ignored.add(property.name);
      }
    }
  }
}
