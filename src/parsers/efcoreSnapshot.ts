import type { IrOnDelete } from '../ir.js';
import {
  bodyStatements,
  flattenChain,
  readLambda,
  type CsCall,
  type CsChain,
  type CsLambda,
} from './csharpChains.js';
import {
  evaluate,
  parseTypeText,
  type ConstLookup,
  type CsClass,
  type CsMethod,
  type CsType,
  type CsValue,
  type SyntaxNode,
} from './csharpSyntax.js';
import {
  identityOf,
  indexAnnotations,
  type IndexAnnotations,
} from './efcoreMigrationReplay.js';
import {
  conventionalName,
  tableKey,
  type MigrationColumn,
  type MigrationForeignKey,
  type MigrationIndex,
  type MigrationKey,
  type MigrationSchema,
  type MigrationTable,
} from './efcoreMigrationState.js';
import { deleteBehavior, isValueType } from './efcoreTypes.js';

/**
 * Reads a `*ModelSnapshot.cs`: the model EF Core wrote when it added the last migration. The snapshot is C# that
 * rebuilds the model with string names (`modelBuilder.Entity("App.Blog", b => { b.Property<int>("Id") ... })`), so
 * it is read here without the entity classes, into the same state the replay of the migrations fills.
 */

const NO_CONSTANTS: ConstLookup = (): CsValue | undefined => undefined;

interface SnapProperty {
  name: string;
  clrType: CsType | undefined;
  isRequired: boolean;
  isIdentity: boolean;
  generatedOnAdd: boolean;
  isRowVersion: boolean;
  column?: string;
  storeType?: string;
  maxLength?: number;
  precision?: number;
  scale?: number;
  isUnicode?: boolean;
  defaultValue?: CsValue;
  defaultSql?: string;
  computedSql?: string;
  isStored?: boolean;
}

interface SnapIndex {
  properties: string[];
  isUnique: boolean;
  name?: string;
  filter?: string;
  descending: boolean[];
  method?: string;
  includes: string[];
}

interface SnapRelation {
  target: string;
  navigation?: string;
  inverse?: string;
  foreignKey: string[];
  principalKey: string[];
  onDelete?: IrOnDelete;
  isRequired: boolean;
  constraintName?: string;
}

interface SnapOwned {
  navigation: string;
  many: boolean;
  entity: SnapEntity;
}

export interface SnapEntity {
  name: string;
  properties: Map<string, SnapProperty>;
  key?: string[];
  keyName?: string;
  alternateKeys: { properties: string[]; name?: string }[];
  indexes: SnapIndex[];
  table?: string;
  /** `undefined` when ToTable gave no schema; `null` for the explicit `(string)null`. */
  schema?: string | null;
  isView: boolean;
  baseType?: string;
  owned: SnapOwned[];
  requiredNavigations: Set<string>;
  relations: SnapRelation[];
  /** The foreign key properties from `WithOwner().HasForeignKey(...)` on an owned type. */
  ownerKey: string[];
  checks: string[];
  /** The column of `ToJson("column")` on an owned type; `''` for `ToJson()`. */
  jsonColumn?: string;
  /** True for ComplexProperty, whose columns share the table of the owner. */
  isComplex: boolean;
  /** True when `IsRequired()` was called on the complex property or the owned navigation builder. */
  isRequired: boolean;
}

function newEntity(name: string): SnapEntity {
  return {
    name,
    properties: new Map(),
    alternateKeys: [],
    indexes: [],
    isView: false,
    owned: [],
    requiredNavigations: new Set(),
    relations: [],
    ownerKey: [],
    checks: [],
    isComplex: false,
    isRequired: false,
  };
}

/** `App.Models.Blog` is `Blog`; `PostTag` stays; `App.Post.Address#Address` is `Address`. */
export function shortEntityName(name: string): string {
  const afterHash: string = name.split('#').pop() ?? name;
  return afterHash.split('.').pop() ?? afterHash;
}

function text(node: SyntaxNode | undefined): string | undefined {
  if (node === undefined) {
    return undefined;
  }
  const value: CsValue = evaluate(node, NO_CONSTANTS);
  return value.kind === 'string' ? value.value : undefined;
}

function number(node: SyntaxNode | undefined): number | undefined {
  if (node === undefined) {
    return undefined;
  }
  const value: CsValue = evaluate(node, NO_CONSTANTS);
  return value.kind === 'number' ? value.value : undefined;
}

function flag(node: SyntaxNode | undefined): boolean | undefined {
  if (node === undefined) {
    return undefined;
  }
  const value: CsValue = evaluate(node, NO_CONSTANTS);
  return value.kind === 'bool' ? value.value : undefined;
}

function texts(nodes: readonly SyntaxNode[]): string[] {
  return nodes.flatMap((node: SyntaxNode): string[] => {
    const value: CsValue = evaluate(node, NO_CONSTANTS);
    if (value.kind === 'string') {
      return [value.value];
    }
    if (value.kind === 'array') {
      return value.items.flatMap((item: CsValue): string[] =>
        item.kind === 'string' ? [item.value] : []
      );
    }
    return [];
  });
}

function readProperty(chain: CsChain, first: CsCall): SnapProperty | undefined {
  const name: string | undefined = text(first.args[0]);
  if (name === undefined) {
    return undefined;
  }
  const property: SnapProperty = {
    name,
    clrType: first.typeArgs[0],
    isRequired: false,
    isIdentity: false,
    generatedOnAdd: false,
    isRowVersion: false,
  };
  const annotations: Map<string, CsValue> = new Map();
  for (const call of chain.calls.slice(1)) {
    const argument: SyntaxNode | undefined = call.args[0];
    switch (call.name) {
      case 'IsRequired':
        property.isRequired = flag(argument) !== false;
        break;
      case 'ValueGeneratedOnAdd':
        property.generatedOnAdd = true;
        break;
      case 'HasColumnType': {
        const value: string | undefined = text(argument);
        if (value !== undefined) {
          property.storeType = value;
        }
        break;
      }
      case 'HasColumnName': {
        const value: string | undefined = text(argument);
        if (value !== undefined) {
          property.column = value;
        }
        break;
      }
      case 'HasMaxLength': {
        const value: number | undefined = number(argument);
        if (value !== undefined) {
          property.maxLength = value;
        }
        break;
      }
      case 'HasPrecision': {
        const value: number | undefined = number(argument);
        if (value !== undefined) {
          property.precision = value;
        }
        const scale: number | undefined = number(call.args[1]);
        if (scale !== undefined) {
          property.scale = scale;
        }
        break;
      }
      case 'IsUnicode': {
        property.isUnicode = flag(argument) !== false;
        break;
      }
      case 'IsRowVersion':
        property.isRowVersion = true;
        break;
      case 'HasDefaultValue':
        if (argument !== undefined) {
          const value: CsValue = evaluate(argument, NO_CONSTANTS);
          if (value.kind !== 'null') {
            property.defaultValue = value;
          }
        }
        break;
      case 'HasDefaultValueSql': {
        const value: string | undefined = text(argument);
        if (value !== undefined) {
          property.defaultSql = value;
        }
        break;
      }
      case 'HasComputedColumnSql': {
        const value: string | undefined = text(argument);
        if (value !== undefined) {
          property.computedSql = value;
          const stored: boolean | undefined = flag(call.args[1]);
          if (stored !== undefined) {
            property.isStored = stored;
          }
        }
        break;
      }
      case 'HasAnnotation': {
        const key: string | undefined = text(argument);
        const second: SyntaxNode | undefined = call.args[1];
        if (key !== undefined && second !== undefined) {
          annotations.set(key, evaluate(second, NO_CONSTANTS));
        }
        break;
      }
      default:
        break;
    }
  }
  property.isIdentity = identityOf(annotations);
  return property;
}

function readIndex(chain: CsChain, first: CsCall): SnapIndex {
  const index: SnapIndex = {
    properties: texts(first.args),
    isUnique: false,
    descending: [],
    includes: [],
  };
  const annotations: Map<string, CsValue> = new Map();
  for (const call of chain.calls.slice(1)) {
    const argument: SyntaxNode | undefined = call.args[0];
    switch (call.name) {
      case 'IsUnique':
        index.isUnique = flag(argument) !== false;
        break;
      case 'HasDatabaseName': {
        const value: string | undefined = text(argument);
        if (value !== undefined) {
          index.name = value;
        }
        break;
      }
      case 'HasFilter': {
        const value: string | undefined = text(argument);
        if (value !== undefined) {
          index.filter = value;
        }
        break;
      }
      case 'IsDescending':
        index.descending = call.args.map(
          (item: SyntaxNode) => flag(item) !== false
        );
        if (call.args.length === 0) {
          index.descending = index.properties.map(() => true);
        }
        break;
      case 'HasMethod': {
        const value: string | undefined = text(argument);
        if (value !== undefined) {
          index.method = value;
        }
        break;
      }
      case 'IncludeProperties':
        index.includes = texts(call.args);
        break;
      case 'HasAnnotation': {
        const key: string | undefined = text(argument);
        const second: SyntaxNode | undefined = call.args[1];
        if (key !== undefined && second !== undefined) {
          annotations.set(key, evaluate(second, NO_CONSTANTS));
        }
        break;
      }
      default:
        break;
    }
  }
  const extra: IndexAnnotations = indexAnnotations(annotations);
  if (index.method === undefined && extra.method !== undefined) {
    index.method = extra.method;
  }
  if (index.includes.length === 0) {
    index.includes = extra.includes;
  }
  return index;
}

function readRelation(chain: CsChain, first: CsCall): SnapRelation | undefined {
  const target: string | undefined = text(first.args[0]);
  if (target === undefined) {
    return undefined;
  }
  const navigation: string | undefined = text(first.args[1]);
  const relation: SnapRelation = {
    target,
    foreignKey: [],
    principalKey: [],
    isRequired: false,
    ...(navigation === undefined ? {} : { navigation }),
  };
  for (const call of chain.calls.slice(1)) {
    switch (call.name) {
      case 'WithMany':
      case 'WithOne': {
        const inverse: string | undefined = text(call.args[0]);
        if (inverse !== undefined) {
          relation.inverse = inverse;
        }
        break;
      }
      case 'HasForeignKey':
        relation.foreignKey = texts(call.args);
        break;
      case 'HasPrincipalKey':
        relation.principalKey = texts(call.args);
        break;
      case 'OnDelete': {
        const value: CsValue | undefined =
          call.args[0] === undefined
            ? undefined
            : evaluate(call.args[0], NO_CONSTANTS);
        if (value?.kind === 'member') {
          const action: IrOnDelete | undefined = deleteBehavior(
            value.path[value.path.length - 1] ?? ''
          );
          if (action !== undefined) {
            relation.onDelete = action;
          }
        }
        break;
      }
      case 'IsRequired':
        relation.isRequired = flag(call.args[0]) !== false;
        break;
      case 'HasConstraintName': {
        const value: string | undefined = text(call.args[0]);
        if (value !== undefined) {
          relation.constraintName = value;
        }
        break;
      }
      default:
        break;
    }
  }
  return relation;
}

/** Reads the calls inside `modelBuilder.Entity("X", b => { ... })` or an `OwnsOne` / `OwnsMany` lambda. */
function readBlock(
  entity: SnapEntity,
  lambda: CsLambda,
  warn: (message: string) => void,
  path: string
): void {
  const builder: string = lambda.parameter ?? 'b';
  for (const statement of bodyStatements(lambda.body)) {
    const expression: SyntaxNode | null =
      statement.type === 'expression_statement'
        ? statement.namedChild(0)
        : statement;
    const chain: CsChain | undefined =
      expression === null ? undefined : flattenChain(expression);
    const first: CsCall | undefined = chain?.calls[0];
    if (chain === undefined || first === undefined) {
      continue;
    }
    if (chain.root.text !== builder) {
      continue;
    }
    switch (first.name) {
      case 'Property': {
        const property: SnapProperty | undefined = readProperty(chain, first);
        if (property !== undefined) {
          entity.properties.set(property.name, property);
        }
        break;
      }
      case 'HasKey':
        entity.key = texts(first.args);
        for (const call of chain.calls.slice(1)) {
          if (call.name === 'HasName') {
            const value: string | undefined = text(call.args[0]);
            if (value !== undefined) {
              entity.keyName = value;
            }
          }
        }
        break;
      case 'HasAlternateKey': {
        const name: string | undefined = chain.calls
          .filter((call: CsCall) => call.name === 'HasName')
          .map((call: CsCall) => text(call.args[0]))[0];
        entity.alternateKeys.push({
          properties: texts(first.args),
          ...(name === undefined ? {} : { name }),
        });
        break;
      }
      case 'HasIndex':
        entity.indexes.push(readIndex(chain, first));
        break;
      case 'ToTable':
      case 'ToView': {
        const name: string | undefined = text(first.args[0]);
        if (first.name === 'ToView') {
          entity.isView = true;
        }
        if (name !== undefined) {
          entity.table = name;
        }
        const schemaNode: SyntaxNode | undefined = first.args[1];
        if (schemaNode !== undefined) {
          const schema: CsValue = evaluate(schemaNode, NO_CONSTANTS);
          if (schema.kind === 'string') {
            entity.schema = schema.value;
          } else if (schema.kind === 'null') {
            entity.schema = null;
          } else {
            const nested: CsLambda | undefined = readLambda(schemaNode);
            for (const item of nested === undefined
              ? []
              : bodyStatements(nested.body)) {
              const inner: SyntaxNode | null =
                item.type === 'expression_statement'
                  ? item.namedChild(0)
                  : item;
              const innerChain: CsChain | undefined =
                inner === null ? undefined : flattenChain(inner);
              const check: CsCall | undefined = innerChain?.calls[0];
              if (check?.name === 'HasCheckConstraint') {
                entity.checks.push(text(check.args[0]) ?? 'check');
              }
            }
          }
        }
        break;
      }
      case 'HasBaseType': {
        const base: string | undefined = text(first.args[0]);
        if (base !== undefined) {
          entity.baseType = base;
        }
        break;
      }
      case 'HasOne': {
        const relation: SnapRelation | undefined = readRelation(chain, first);
        if (relation !== undefined) {
          entity.relations.push(relation);
        }
        break;
      }
      case 'WithOwner':
        for (const call of chain.calls.slice(1)) {
          if (call.name === 'HasForeignKey') {
            entity.ownerKey = texts(call.args);
          }
        }
        break;
      case 'Navigation':
        if (chain.calls.some((call: CsCall) => call.name === 'IsRequired')) {
          const nav: string | undefined = text(first.args[0]);
          if (nav !== undefined) {
            entity.requiredNavigations.add(nav);
          }
        }
        break;
      case 'OwnsOne':
      case 'OwnsMany':
      case 'ComplexProperty': {
        // OwnsOne("Type", "Nav", b1 => ...); ComplexProperty<T>("Nav", "Type", b1 => ...).
        const isComplex: boolean = first.name === 'ComplexProperty';
        const typeName: string | undefined = text(
          first.args[isComplex ? 1 : 0]
        );
        const navigation: string | undefined = text(
          first.args[isComplex ? 0 : 1]
        );
        const block: SyntaxNode | undefined = first.args[2];
        const nestedLambda: CsLambda | undefined =
          block === undefined ? undefined : readLambda(block);
        if (typeName === undefined || navigation === undefined) {
          warn(
            `${path}: ${first.name} in the model snapshot names no owned type or navigation, so it was skipped.`
          );
          break;
        }
        const owned: SnapEntity = newEntity(typeName);
        owned.isComplex = isComplex;
        if (nestedLambda !== undefined) {
          readBlock(owned, nestedLambda, warn, path);
        }
        entity.owned.push({
          navigation,
          many: first.name === 'OwnsMany',
          entity: owned,
        });
        break;
      }
      case 'ToJson': {
        entity.jsonColumn = text(first.args[0]) ?? '';
        break;
      }
      case 'IsRequired':
        entity.isRequired = true;
        break;
      default:
        break;
    }
  }
}

/** The entities of a snapshot, by entity name, and its default schema. */
export interface SnapshotRead {
  entities: Map<string, SnapEntity>;
  defaultSchema?: string;
}

/** Finds the snapshot class and reads its `BuildModel` method into entities. */
export function readSnapshotClass(
  cls: CsClass,
  path: string,
  warn: (message: string) => void
): SnapshotRead | undefined {
  const method: CsMethod | undefined = cls.methods.find(
    (item: CsMethod) => item.name === 'BuildModel'
  );
  if (method?.body === undefined) {
    return undefined;
  }
  const builder: string = method.parameters[0]?.name ?? 'modelBuilder';
  const entities: Map<string, SnapEntity> = new Map();
  let defaultSchema: string | undefined;
  for (const statement of bodyStatements(method.body)) {
    const expression: SyntaxNode | null =
      statement.type === 'expression_statement'
        ? statement.namedChild(0)
        : null;
    const chain: CsChain | undefined =
      expression === null ? undefined : flattenChain(expression);
    if (chain === undefined || chain.root.text !== builder) {
      continue;
    }
    for (const call of chain.calls) {
      if (call.name === 'HasDefaultSchema') {
        defaultSchema = text(call.args[0]) ?? defaultSchema;
      }
    }
    const first: CsCall | undefined = chain.calls[0];
    if (first === undefined || first.name !== 'Entity') {
      continue;
    }
    const name: string | undefined =
      text(first.args[0]) ?? first.typeArgs[0]?.text;
    const lambda: CsLambda | undefined =
      first.args[1] === undefined ? undefined : readLambda(first.args[1]);
    if (name === undefined || lambda === undefined) {
      continue;
    }
    const entity: SnapEntity = entities.get(name) ?? newEntity(name);
    entities.set(name, entity);
    readBlock(entity, lambda, warn, path);
  }
  return {
    entities,
    ...(defaultSchema === undefined ? {} : { defaultSchema }),
  };
}

// ---------------------------------------------------------------------------
// Entities to tables
// ---------------------------------------------------------------------------

interface BuildState {
  schema: MigrationSchema;
  entities: ReadonlyMap<string, SnapEntity>;
  defaultSchema: string | undefined;
  warn: (message: string) => void;
  path: string;
  /** The table each entity is stored in, by entity name. */
  tableOf: Map<string, MigrationTable>;
  /** The primary key columns of each entity, in key order. */
  keyColumns: Map<SnapEntity, string[]>;
}

function schemaOf(
  entity: SnapEntity,
  defaultSchema: string | undefined
): string | undefined {
  if (entity.schema === null) {
    return undefined;
  }
  return entity.schema ?? defaultSchema;
}

/** True when the CLR type is a reference type, which allows null unless the property says `IsRequired()`. */
function isReferenceType(type: CsType | undefined): boolean {
  if (type === undefined) {
    return false;
  }
  return (
    type.arrayDepth > 0 ||
    type.name === 'Dictionary' ||
    (!isValueType(type, new Set()) &&
      /^(?:string|String|JsonDocument|JsonNode|JsonObject|JsonArray|Uri|IPAddress|PhysicalAddress|Version|CultureInfo)$/.test(
        type.name
      ))
  );
}

function isIntegerType(type: CsType | undefined): boolean {
  return (
    type !== undefined &&
    type.arrayDepth === 0 &&
    /^(?:int|Int32|long|Int64|short|Int16|byte|Byte|sbyte|SByte)$/.test(
      type.name
    )
  );
}

function columnOfProperty(
  property: SnapProperty,
  columnName: string,
  propertyName: string,
  forceNullable: boolean,
  isKey: boolean
): MigrationColumn {
  const type: CsType | undefined = property.clrType;
  // The snapshot does not repeat IsRequired() for the properties of a key; a key never allows null.
  const isNullable: boolean =
    !isKey &&
    (forceNullable ||
      type?.nullable === true ||
      (isReferenceType(type) && !property.isRequired));
  const hasDefault: boolean =
    property.defaultValue !== undefined || property.defaultSql !== undefined;
  return {
    name: columnName,
    clrType: type,
    isNullable,
    isRowVersion: property.isRowVersion,
    isIdentity:
      property.isIdentity ||
      (property.generatedOnAdd &&
        isIntegerType(type) &&
        !hasDefault &&
        property.computedSql === undefined),
    propertyName,
    ...(property.storeType === undefined
      ? {}
      : { storeType: property.storeType }),
    ...(property.maxLength === undefined
      ? {}
      : { maxLength: property.maxLength }),
    ...(property.precision === undefined
      ? {}
      : { precision: property.precision }),
    ...(property.scale === undefined ? {} : { scale: property.scale }),
    ...(property.isUnicode === undefined
      ? {}
      : { isUnicode: property.isUnicode }),
    ...(property.defaultValue === undefined
      ? {}
      : { defaultValue: property.defaultValue }),
    ...(property.defaultSql === undefined
      ? {}
      : { defaultSql: property.defaultSql }),
    ...(property.computedSql === undefined
      ? {}
      : { computedSql: property.computedSql }),
    ...(property.isStored === undefined ? {} : { isStored: property.isStored }),
  };
}

function newTable(entity: SnapEntity, state: BuildState): MigrationTable {
  const name: string = entity.table ?? shortEntityName(entity.name);
  const schema: string | undefined = schemaOf(entity, state.defaultSchema);
  return {
    name,
    columns: [],
    uniqueKeys: [],
    indexes: [],
    foreignKeys: [],
    checkConstraints: [...entity.checks],
    entityName: shortEntityName(entity.name),
    ...(schema === undefined ? {} : { schema }),
  };
}

/** Adds the columns of an entity (or of an owned type sharing its table) to a table. */
function addColumns(
  table: MigrationTable,
  entity: SnapEntity,
  prefix: string,
  pathPrefix: string,
  forceNullable: boolean,
  skip: ReadonlySet<string>,
  state: BuildState
): Map<string, string> {
  const columns: Map<string, string> = new Map();
  for (const property of entity.properties.values()) {
    if (skip.has(property.name)) {
      continue;
    }
    const columnName: string = property.column ?? `${prefix}${property.name}`;
    columns.set(property.name, columnName);
    if (
      table.columns.some((item: MigrationColumn) => item.name === columnName)
    ) {
      continue;
    }
    table.columns.push(
      columnOfProperty(
        property,
        columnName,
        `${pathPrefix}${property.name}`,
        forceNullable,
        (entity.key ?? []).includes(property.name) ||
          entity.alternateKeys.some((key) =>
            key.properties.includes(property.name)
          )
      )
    );
  }
  for (const owned of entity.owned) {
    addOwned(table, entity, owned, prefix, pathPrefix, forceNullable, state);
  }
  return columns;
}

/** Table-splitting owned types and complex properties become columns with the navigation as a prefix. */
function addOwned(
  table: MigrationTable,
  owner: SnapEntity,
  owned: SnapOwned,
  prefix: string,
  pathPrefix: string,
  forceNullable: boolean,
  state: BuildState
): void {
  const entity: SnapEntity = owned.entity;
  const ownedTable: string | undefined = entity.table;
  const isSeparate: boolean =
    owned.many ||
    (ownedTable !== undefined &&
      !entity.isComplex &&
      (ownedTable !== table.name ||
        schemaOf(entity, state.defaultSchema) !== table.schema));
  if (isSeparate) {
    addOwnedTable(table, owner, owned, state);
    return;
  }
  const required: boolean = entity.isComplex
    ? entity.isRequired
    : owner.requiredNavigations.has(owned.navigation);
  const nullable: boolean = forceNullable || !required;
  if (entity.jsonColumn !== undefined) {
    const column: string =
      entity.jsonColumn === '' ? owned.navigation : entity.jsonColumn;
    table.columns.push({
      name: column,
      clrType: parseTypeText('JsonDocument'),
      isNullable: nullable,
      isRowVersion: false,
      isIdentity: false,
      propertyName: `${pathPrefix}${owned.navigation}`,
    });
    return;
  }
  const skip: Set<string> = new Set([
    ...entity.ownerKey,
    ...(entity.key ?? []),
  ]);
  // A complex property has no key; an owned type's key is the foreign key to the owner, which is the owner's key.
  if (entity.isComplex) {
    skip.clear();
  }
  addColumns(
    table,
    entity,
    `${prefix}${owned.navigation}_`,
    `${pathPrefix}${owned.navigation}.`,
    nullable,
    skip,
    state
  );
}

/** An owned collection (or an owned type with its own table) is a table with a foreign key to the owner. */
function addOwnedTable(
  ownerTable: MigrationTable,
  owner: SnapEntity,
  owned: SnapOwned,
  state: BuildState
): void {
  const entity: SnapEntity = owned.entity;
  const table: MigrationTable = newTable(entity, state);
  state.keyColumns.set(
    entity,
    (entity.key ?? []).map(
      (name: string) => entity.properties.get(name)?.column ?? name
    )
  );
  const columns: Map<string, string> = addColumns(
    table,
    entity,
    '',
    '',
    false,
    new Set(),
    state
  );
  const key: string[] = (entity.key ?? []).map(
    (name: string) => columns.get(name) ?? name
  );
  if (key.length > 0) {
    table.primaryKey = {
      columns: key,
      ...(entity.keyName === undefined ? {} : { name: entity.keyName }),
    };
  }
  addIndexes(table, entity, columns);
  const foreignColumns: string[] = entity.ownerKey.map(
    (name: string) => columns.get(name) ?? name
  );
  const principalColumns: string[] = state.keyColumns.get(owner) ?? [];
  if (foreignColumns.length > 0) {
    table.foreignKeys.push({
      name: conventionalName('FK', table.name, foreignColumns, ownerTable.name),
      columns: foreignColumns,
      principalTable: ownerTable.name,
      principalColumns,
      onDelete: 'cascade',
      onUpdate: 'noAction',
      ...(ownerTable.schema === undefined
        ? {}
        : { principalSchema: ownerTable.schema }),
    });
  }
  state.schema.set(tableKey(table.schema, table.name), table);
}

function addIndexes(
  table: MigrationTable,
  entity: SnapEntity,
  columns: ReadonlyMap<string, string>
): void {
  const toColumns = (names: readonly string[]): string[] =>
    names.map((name: string) => columns.get(name) ?? name);
  for (const index of entity.indexes) {
    const names: string[] = toColumns(index.properties);
    const entry: MigrationIndex = {
      name: index.name ?? conventionalName('IX', table.name, names),
      columns: names,
      isUnique: index.isUnique,
      includes: toColumns(index.includes),
      descending: index.descending,
      ...(index.filter === undefined ? {} : { filter: index.filter }),
      ...(index.method === undefined ? {} : { method: index.method }),
    };
    table.indexes.push(entry);
  }
  for (const alternate of entity.alternateKeys) {
    const names: string[] = toColumns(alternate.properties);
    const key: MigrationKey = {
      columns: names,
      name: alternate.name ?? conventionalName('AK', table.name, names),
    };
    table.uniqueKeys.push(key);
  }
}

/** The root entity of a table-per-hierarchy chain, or the entity itself. */
function rootOf(
  entity: SnapEntity,
  entities: ReadonlyMap<string, SnapEntity>
): SnapEntity {
  let current: SnapEntity = entity;
  for (let guard: number = 0; guard < 32; guard += 1) {
    const base: SnapEntity | undefined =
      current.baseType === undefined
        ? undefined
        : entities.get(current.baseType);
    if (base === undefined || current.table !== undefined) {
      return current;
    }
    current = base;
  }
  return current;
}

/** Turns the entities of the snapshot into tables. */
export function snapshotSchema(
  entities: ReadonlyMap<string, SnapEntity>,
  defaultSchema: string | undefined,
  schema: MigrationSchema,
  path: string,
  warn: (message: string) => void
): void {
  const state: BuildState = {
    schema,
    entities,
    defaultSchema,
    warn,
    path,
    tableOf: new Map(),
    keyColumns: new Map(),
  };
  const columnMaps: Map<string, Map<string, string>> = new Map();
  // Root entities first, so that a table-per-hierarchy table exists before its derived types add columns.
  const ordered: SnapEntity[] = [...entities.values()].sort(
    (first: SnapEntity, second: SnapEntity) =>
      Number(rootOf(first, entities) !== first) -
      Number(rootOf(second, entities) !== second)
  );
  for (const entity of ordered) {
    if (entity.isView) {
      continue;
    }
    const root: SnapEntity = rootOf(entity, entities);
    if (root !== entity) {
      const rootTable: MigrationTable | undefined = state.tableOf.get(
        root.name
      );
      if (rootTable === undefined) {
        continue;
      }
      const columns: Map<string, string> = addColumns(
        rootTable,
        entity,
        '',
        '',
        true,
        new Set(),
        state
      );
      state.tableOf.set(entity.name, rootTable);
      columnMaps.set(entity.name, columns);
      addIndexes(rootTable, entity, columns);
      continue;
    }
    const table: MigrationTable = newTable(entity, state);
    state.tableOf.set(entity.name, table);
    // The key columns are needed by owned collections, so the key is resolved before the columns are added.
    const keyNames: string[] = entity.key ?? [];
    state.keyColumns.set(
      entity,
      keyNames.map(
        (name: string) => entity.properties.get(name)?.column ?? name
      )
    );
    const columns: Map<string, string> = addColumns(
      table,
      entity,
      '',
      '',
      false,
      new Set(),
      state
    );
    columnMaps.set(entity.name, columns);
    if (keyNames.length > 0) {
      table.primaryKey = {
        columns: keyNames.map((name: string) => columns.get(name) ?? name),
        ...(entity.keyName === undefined ? {} : { name: entity.keyName }),
      };
    }
    addIndexes(table, entity, columns);
    schema.set(tableKey(table.schema, table.name), table);
  }
  // Relationships need every table, so they come last.
  for (const entity of entities.values()) {
    const table: MigrationTable | undefined = state.tableOf.get(entity.name);
    const columns: Map<string, string> | undefined = columnMaps.get(
      entity.name
    );
    if (table === undefined || columns === undefined) {
      continue;
    }
    for (const relation of entity.relations) {
      const principal: SnapEntity | undefined = entities.get(relation.target);
      const principalTable: MigrationTable | undefined = state.tableOf.get(
        relation.target
      );
      if (principal === undefined || principalTable === undefined) {
        warn(
          `${path}: the relationship from ${shortEntityName(entity.name)} to ${shortEntityName(relation.target)} points at an entity that is not in the model snapshot, so it was skipped.`
        );
        continue;
      }
      const principalColumns: Map<string, string> =
        columnMaps.get(principal.name) ?? new Map();
      // A one-to-one relationship names the dependent type first: HasForeignKey("App.Profile", "OwnerId").
      const foreignNames: string[] = relation.foreignKey.filter(
        (name: string) => columns.has(name)
      );
      const foreignColumns: string[] = (
        foreignNames.length > 0 ? foreignNames : relation.foreignKey
      ).map((name: string) => columns.get(name) ?? name);
      const principalNames: string[] = relation.principalKey.filter(
        (name: string) => principalColumns.has(name)
      );
      const referenced: string[] =
        relation.principalKey.length > 0
          ? (principalNames.length > 0
              ? principalNames
              : relation.principalKey
            ).map((name: string) => principalColumns.get(name) ?? name)
          : (state.keyColumns.get(principal) ?? []);
      // The snapshot leaves out an alternate key that only a foreign key uses; the migration creates it.
      if (
        relation.principalKey.length > 0 &&
        !principalTable.uniqueKeys.some(
          (key: MigrationKey) => key.columns.join(',') === referenced.join(',')
        )
      ) {
        principalTable.uniqueKeys.push({
          columns: referenced,
          name: conventionalName('AK', principalTable.name, referenced),
        });
      }
      const optionalColumns: boolean = foreignColumns.some(
        (name: string) =>
          table.columns.find((column: MigrationColumn) => column.name === name)
            ?.isNullable === true
      );
      const required: boolean = relation.isRequired || !optionalColumns;
      const foreignKey: MigrationForeignKey = {
        name:
          relation.constraintName ??
          conventionalName(
            'FK',
            table.name,
            foreignColumns,
            principalTable.name
          ),
        columns: foreignColumns,
        principalTable: principalTable.name,
        principalColumns: referenced,
        onDelete: relation.onDelete ?? (required ? 'cascade' : 'noAction'),
        onUpdate: 'noAction',
        ...(principalTable.schema === undefined
          ? {}
          : { principalSchema: principalTable.schema }),
        ...(relation.navigation === undefined
          ? {}
          : { navigation: relation.navigation }),
        ...(relation.inverse === undefined
          ? {}
          : { inverseNavigation: relation.inverse }),
      };
      table.foreignKeys.push(foreignKey);
    }
  }
}
