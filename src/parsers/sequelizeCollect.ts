import { basename } from 'node:path';
import {
  evaluateNode,
  lastSegment,
  type SyntaxNode,
  type TsValue,
} from './typescriptSyntax.js';
import type {
  AssociationKey,
  AssociationKind,
  AssociationOptions,
  FileInfo,
  Located,
  ModelOptionDefaults,
  ModelOptions,
  Project,
  RawAttribute,
  RawIndex,
  RawIndexField,
  RawModel,
  TimestampKind,
} from './sequelizeModel.js';

/** What the walk needs to resolve names: the file being read and the project it belongs to. */
export interface Ctx {
  file: FileInfo;
  project: Project;
}

const ASSOCIATION_METHODS: ReadonlySet<string> = new Set([
  'hasMany',
  'hasOne',
  'belongsTo',
  'belongsToMany',
]);

/**
 * Decorators that make a property a column: sequelize-typescript's, and Sequelize 7's (`@Attribute` is the
 * v7 name of `@Column`, `@ColumnName` names the column, `@Version` the version attribute).
 */
const COLUMN_DECORATORS: ReadonlySet<string> = new Set([
  'Column',
  'Attribute',
  'ColumnName',
  'Version',
  'PrimaryKey',
  'AutoIncrement',
  'AllowNull',
  'NotNull',
  'Unique',
  'Default',
  'CreatedAt',
  'UpdatedAt',
  'DeletedAt',
  'ForeignKey',
  'Comment',
  'Index',
]);

/** Decorators that only name an attribute Sequelize adds itself; with `@Attribute` or `@Column` it is declared. */
const TIMESTAMP_DECORATORS: ReadonlySet<string> = new Set([
  'CreatedAt',
  'UpdatedAt',
  'DeletedAt',
  'Version',
]);

/** Generic wrappers that do not change the column type (`CreationOptional<number>`). */
const TRANSPARENT_TYPES: ReadonlySet<string> = new Set([
  'CreationOptional',
  'NonAttribute',
  'ForeignKey',
  'Promise',
  'Awaited',
  'Relation',
  'Readonly',
  'Required',
]);

const ASSOCIATION_DECORATORS: Readonly<Record<string, AssociationKind>> = {
  HasMany: 'hasMany',
  HasOne: 'hasOne',
  BelongsTo: 'belongsTo',
  BelongsToMany: 'belongsToMany',
};

/** Model options that describe behaviour the IR cannot hold, mapped to the name used in the warning. */
const UNSUPPORTED_MODEL_OPTIONS: Readonly<Record<string, string>> = {
  hooks: 'hooks',
  scopes: 'scopes',
  defaultScope: 'a default scope',
  getterMethods: 'getterMethods',
  setterMethods: 'setterMethods',
};

/** Decorators of sequelize-typescript for model behaviour. */
const UNSUPPORTED_CLASS_DECORATORS: Readonly<Record<string, string>> = {
  Scopes: 'scopes',
  DefaultScope: 'a default scope',
};

const HOOK_DECORATORS: ReadonlySet<string> = new Set([
  'BeforeCreate',
  'AfterCreate',
  'BeforeUpdate',
  'AfterUpdate',
  'BeforeDestroy',
  'AfterDestroy',
  'BeforeSave',
  'AfterSave',
  'BeforeBulkCreate',
  'AfterBulkCreate',
  'BeforeValidate',
  'AfterValidate',
  'BeforeUpsert',
  'AfterUpsert',
  'BeforeFind',
  'AfterFind',
  'BeforeSync',
  'AfterSync',
  'BeforeDefine',
  'AfterDefine',
]);

// ---------------------------------------------------------------------------
// Syntax helpers
// ---------------------------------------------------------------------------

const TRANSPARENT_NODES: ReadonlySet<string> = new Set([
  'parenthesized_expression',
  'as_expression',
  'satisfies_expression',
  'non_null_expression',
  'type_assertion',
  'await_expression',
]);

export function stripWrappers(node: SyntaxNode): SyntaxNode {
  let current: SyntaxNode = node;
  while (TRANSPARENT_NODES.has(current.type)) {
    const inner: SyntaxNode | undefined = current.namedChildren[0];
    if (inner === undefined) {
      break;
    }
    current = inner;
  }
  return current;
}

export function describeFile(path: string, root: SyntaxNode): FileInfo {
  const consts: Map<string, SyntaxNode> = new Map();
  const stack: SyntaxNode[] = [root];
  while (stack.length > 0) {
    const node: SyntaxNode | undefined = stack.pop();
    if (node === undefined) {
      break;
    }
    if (node.type === 'variable_declarator') {
      const nameNode: SyntaxNode | null = node.childForFieldName('name');
      const valueNode: SyntaxNode | null = node.childForFieldName('value');
      if (
        nameNode !== null &&
        valueNode !== null &&
        nameNode.type === 'identifier' &&
        !consts.has(nameNode.text)
      ) {
        consts.set(nameNode.text, valueNode);
      }
    }
    stack.push(...node.namedChildren);
  }
  // Sequelize 7 lives in the @sequelize scope; its associations and defaults differ from version 6.
  const generation: 6 | 7 = /['"]@sequelize\//.test(root.text) ? 7 : 6;
  return { path, label: basename(path), root, consts, generation };
}

/** Follows `const x = ...` references (also across files) until a node that is not a plain name. */
export function resolveNode(node: SyntaxNode, ctx: Ctx): SyntaxNode {
  let current: SyntaxNode = stripWrappers(node);
  for (let depth: number = 0; depth < 8; depth += 1) {
    if (current.type !== 'identifier') {
      break;
    }
    const local: SyntaxNode | undefined = ctx.file.consts.get(current.text);
    if (local !== undefined) {
      current = stripWrappers(local);
      continue;
    }
    const shared: Located[] | undefined = ctx.project.sharedConsts.get(
      current.text
    );
    const only: Located | undefined =
      shared?.length === 1 ? shared[0] : undefined;
    if (only === undefined) {
      break;
    }
    current = stripWrappers(only.node);
  }
  return current;
}

interface ObjectEntries {
  entries: Map<string, SyntaxNode>;
  /** True when a spread or computed key could not be followed. */
  incomplete: boolean;
}

function keyText(node: SyntaxNode): string | undefined {
  switch (node.type) {
    case 'property_identifier':
    case 'identifier':
      return node.text;
    case 'string': {
      const value: TsValue = evaluateNode(node);
      return value.kind === 'string' ? value.value : undefined;
    }
    case 'number':
      return node.text;
    default:
      return undefined;
  }
}

/** The `key: value` entries of an object literal, following identifiers and spreads of known objects. */
export function objectEntries(node: SyntaxNode, ctx: Ctx): ObjectEntries {
  const entries: Map<string, SyntaxNode> = new Map();
  let incomplete: boolean = false;
  const resolved: SyntaxNode = resolveNode(node, ctx);
  if (resolved.type !== 'object') {
    return { entries, incomplete: true };
  }
  for (const child of resolved.namedChildren) {
    if (child.type === 'pair') {
      const keyNode: SyntaxNode | null = child.childForFieldName('key');
      const valueNode: SyntaxNode | null = child.childForFieldName('value');
      const key: string | undefined =
        keyNode === null ? undefined : keyText(keyNode);
      if (key === undefined || valueNode === null) {
        incomplete = true;
      } else {
        entries.set(key, valueNode);
      }
    } else if (child.type === 'shorthand_property_identifier') {
      entries.set(child.text, child);
    } else if (child.type === 'method_definition') {
      const nameNode: SyntaxNode | null = child.childForFieldName('name');
      const key: string | undefined =
        nameNode === null ? undefined : keyText(nameNode);
      if (key !== undefined) {
        entries.set(key, child);
      }
    } else if (child.type === 'spread_element') {
      const inner: SyntaxNode | undefined = child.namedChildren[0];
      const spread: ObjectEntries | undefined =
        inner === undefined ? undefined : objectEntries(inner, ctx);
      if (spread === undefined || spread.incomplete) {
        incomplete = true;
      }
      for (const [key, value] of spread?.entries ?? []) {
        entries.set(key, value);
      }
    }
  }
  return { entries, incomplete };
}

export function argsOf(call: SyntaxNode): SyntaxNode[] {
  const argumentsNode: SyntaxNode | null = call.childForFieldName('arguments');
  return argumentsNode === null
    ? []
    : argumentsNode.namedChildren.filter(
        (child: SyntaxNode) => child.type !== 'comment'
      );
}

export function valueOf(node: SyntaxNode, ctx: Ctx): TsValue {
  return evaluateNode(resolveNode(node, ctx));
}

export function stringOf(
  node: SyntaxNode | undefined,
  ctx: Ctx
): string | undefined {
  if (node === undefined) {
    return undefined;
  }
  const value: TsValue = valueOf(node, ctx);
  return value.kind === 'string' ? value.value : undefined;
}

export function boolOf(
  node: SyntaxNode | undefined,
  ctx: Ctx
): boolean | undefined {
  if (node === undefined) {
    return undefined;
  }
  const value: TsValue = valueOf(node, ctx);
  return value.kind === 'bool' ? value.value : undefined;
}

export function numberOf(
  node: SyntaxNode | undefined,
  ctx: Ctx
): number | undefined {
  if (node === undefined) {
    return undefined;
  }
  const value: TsValue = valueOf(node, ctx);
  return value.kind === 'number' ? value.value : undefined;
}

/** The text of a reference to a model: `User`, `models.User`, `sequelize.models.User`, `sequelize.model('User')`. */
function modelReference(node: SyntaxNode, ctx: Ctx): string | undefined {
  const stripped: SyntaxNode = stripWrappers(node);
  switch (stripped.type) {
    case 'identifier':
    case 'member_expression':
      return lastSegment(stripped.text.replace(/\s+/g, ''));
    case 'string':
      return stringOf(stripped, ctx);
    case 'call_expression': {
      const callee: SyntaxNode | null = stripped.childForFieldName('function');
      const first: SyntaxNode | undefined = argsOf(stripped)[0];
      return callee !== null && /\.model$/.test(callee.text)
        ? stringOf(first, ctx)
        : undefined;
    }
    case 'arrow_function':
    case 'function_expression': {
      // sequelize-typescript: `() => User`
      const body: SyntaxNode | null = stripped.childForFieldName('body');
      return body === null ? undefined : modelReference(body, ctx);
    }
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// Attributes
// ---------------------------------------------------------------------------

function describeThrough(
  node: SyntaxNode | undefined,
  ctx: Ctx
): AssociationOptions['through'] {
  if (node === undefined) {
    return undefined;
  }
  const stripped: SyntaxNode = stripWrappers(node);
  if (stripped.type === 'object') {
    const { entries } = objectEntries(stripped, ctx);
    const unique: boolean | undefined = boolOf(entries.get('unique'), ctx);
    const described: AssociationOptions['through'] = describeThrough(
      entries.get('model'),
      ctx
    );
    return unique === undefined ? described : { ...(described ?? {}), unique };
  }
  // A name that points at `sequelize.define(...)` is a model; only a string constant is a table name.
  const table: string | undefined = stringOf(stripped, ctx);
  if (table !== undefined) {
    return { table };
  }
  const model: string | undefined = modelReference(stripped, ctx);
  return model === undefined ? undefined : { model };
}

/**
 * The value of `references.model`: a table name (also from a string constant), or the name of a model
 * variable, which must not be followed to the `sequelize.define(...)` call it holds.
 */
function modelOrTableName(node: SyntaxNode, ctx: Ctx): TsValue {
  const stripped: SyntaxNode = stripWrappers(node);
  const resolved: TsValue = valueOf(stripped, ctx);
  return resolved.kind === 'string' ? resolved : evaluateNode(stripped);
}

/** Reads one attribute definition: `{ type, allowNull, ... }` or a bare `DataTypes.X`. */
export function readAttribute(
  name: string,
  node: SyntaxNode,
  ctx: Ctx
): RawAttribute {
  const attribute: RawAttribute = { name, origin: 'declared' };
  const resolved: SyntaxNode = resolveNode(node, ctx);
  if (resolved.type === 'object') {
    applyAttributeEntries(attribute, objectEntries(resolved, ctx).entries, ctx);
  } else if (resolved.type === 'method_definition') {
    attribute.hasAccessor = true;
  } else {
    attribute.type = evaluateNode(resolved);
  }
  return attribute;
}

/** Applies the options of an attribute object (`allowNull`, `unique`, ...) to an attribute. */
export function applyAttributeEntries(
  attribute: RawAttribute,
  entries: Map<string, SyntaxNode>,
  ctx: Ctx
): void {
  for (const [key, node] of entries) {
    switch (key) {
      case 'type':
        attribute.type = valueOf(node, ctx);
        break;
      case 'allowNull':
        attribute.allowNull = boolOf(node, ctx) ?? attribute.allowNull;
        break;
      case 'primaryKey':
        attribute.primaryKey = boolOf(node, ctx) ?? attribute.primaryKey;
        break;
      case 'autoIncrement':
        attribute.autoIncrement = boolOf(node, ctx) ?? attribute.autoIncrement;
        break;
      case 'unique': {
        const value: TsValue = valueOf(node, ctx);
        if (value.kind === 'bool') {
          if (value.value) {
            attribute.unique = {};
          } else {
            delete attribute.unique;
          }
        } else if (value.kind === 'string') {
          attribute.unique = { name: value.value };
        } else if (value.kind === 'object') {
          const unique: TsValue | undefined = value.properties['name'];
          attribute.unique =
            unique !== undefined && unique.kind === 'string'
              ? { name: unique.value }
              : {};
        }
        break;
      }
      case 'defaultValue':
        attribute.defaultValue = valueOf(node, ctx);
        break;
      case 'references': {
        const resolved: SyntaxNode = resolveNode(node, ctx);
        if (resolved.type === 'object') {
          const reference: Map<string, SyntaxNode> = objectEntries(
            resolved,
            ctx
          ).entries;
          const model: SyntaxNode | undefined = reference.get('model');
          const referenceKey: string | undefined = stringOf(
            reference.get('key'),
            ctx
          );
          attribute.references = {
            ...(model === undefined
              ? {}
              : { model: modelOrTableName(model, ctx) }),
            ...(referenceKey === undefined ? {} : { key: referenceKey }),
          };
        }
        break;
      }
      case 'onDelete':
        attribute.onDelete = stringOf(node, ctx) ?? attribute.onDelete;
        break;
      case 'onUpdate':
        attribute.onUpdate = stringOf(node, ctx) ?? attribute.onUpdate;
        break;
      case 'field':
      case 'columnName':
        attribute.field = stringOf(node, ctx) ?? attribute.field;
        break;
      case 'comment':
        attribute.comment = stringOf(node, ctx) ?? attribute.comment;
        break;
      case 'values': {
        const value: TsValue = valueOf(node, ctx);
        if (value.kind === 'array') {
          attribute.enumValues = value.items.flatMap((item: TsValue) =>
            item.kind === 'string' ? [item.value] : []
          );
        }
        break;
      }
      case 'get':
      case 'set':
        attribute.hasAccessor = true;
        break;
      default:
        break;
    }
  }
}

function readKey(
  node: SyntaxNode | undefined,
  ctx: Ctx
): AssociationKey | undefined {
  if (node === undefined) {
    return undefined;
  }
  const resolved: SyntaxNode = resolveNode(node, ctx);
  if (resolved.type === 'object') {
    const { entries } = objectEntries(resolved, ctx);
    const name: string | undefined =
      stringOf(entries.get('name'), ctx) ??
      stringOf(entries.get('fieldName'), ctx);
    const attribute: RawAttribute = {
      name: name ?? '',
      origin: 'foreignKey',
    };
    applyAttributeEntries(attribute, entries, ctx);
    return { ...(name === undefined ? {} : { name }), attribute };
  }
  const name: string | undefined = stringOf(resolved, ctx);
  return name === undefined
    ? undefined
    : { name, attribute: { name, origin: 'foreignKey' } };
}

export function readAssociationOptions(
  node: SyntaxNode | undefined,
  ctx: Ctx
): AssociationOptions {
  const options: AssociationOptions = { unsupported: [] };
  if (node === undefined) {
    return options;
  }
  const resolved: SyntaxNode = resolveNode(node, ctx);
  if (resolved.type !== 'object') {
    // `@BelongsTo(() => User, 'authorId')`
    const foreignKey: AssociationKey | undefined = readKey(resolved, ctx);
    if (foreignKey !== undefined) {
      options.foreignKey = foreignKey;
    }
    return options;
  }
  const { entries } = objectEntries(resolved, ctx);
  for (const [key, value] of entries) {
    switch (key) {
      case 'as': {
        const alias: string | undefined = stringOf(value, ctx);
        if (alias !== undefined) {
          options.as = alias;
        } else {
          const object: TsValue = valueOf(value, ctx);
          const plural: TsValue | undefined =
            object.kind === 'object' ? object.properties['plural'] : undefined;
          if (plural !== undefined && plural.kind === 'string') {
            options.as = plural.value;
          }
        }
        break;
      }
      case 'foreignKey': {
        const foreignKey: AssociationKey | undefined = readKey(value, ctx);
        if (foreignKey !== undefined) {
          options.foreignKey = foreignKey;
        }
        break;
      }
      case 'otherKey': {
        const otherKey: AssociationKey | undefined = readKey(value, ctx);
        if (otherKey !== undefined) {
          options.otherKey = otherKey;
        }
        break;
      }
      case 'sourceKey':
        options.sourceKey = stringOf(value, ctx);
        break;
      case 'targetKey':
        options.targetKey = stringOf(value, ctx);
        break;
      case 'onDelete':
        options.onDelete = stringOf(value, ctx);
        break;
      case 'onUpdate':
        options.onUpdate = stringOf(value, ctx);
        break;
      case 'constraints':
      case 'foreignKeyConstraints':
        options.constraints = boolOf(value, ctx);
        break;
      case 'inverse': {
        // Sequelize 7: `inverse: 'author'`, or `{ as: 'author' }`, or `{ type: 'hasMany', as: 'posts' }` on a belongsTo.
        const text: string | undefined = stringOf(value, ctx);
        if (text !== undefined) {
          options.inverse = { as: text };
        } else {
          const object: SyntaxNode = resolveNode(value, ctx);
          if (object.type === 'object') {
            const inverse: Map<string, SyntaxNode> = objectEntries(
              object,
              ctx
            ).entries;
            const type: string | undefined = stringOf(inverse.get('type'), ctx);
            const as: string | undefined = stringOf(inverse.get('as'), ctx);
            options.inverse = {
              ...(as === undefined ? {} : { as }),
              ...(type === 'hasMany' || type === 'hasOne' ? { type } : {}),
            };
          }
        }
        break;
      }
      case 'through': {
        const through: AssociationOptions['through'] = describeThrough(
          value,
          ctx
        );
        if (through !== undefined) {
          options.through = through;
        }
        break;
      }
      case 'scope':
        options.unsupported.push('scope (a polymorphic or scoped association)');
        break;
      default:
        break;
    }
  }
  return options;
}

// ---------------------------------------------------------------------------
// Models: sequelize.define, Model.init
// ---------------------------------------------------------------------------

function newModel(
  ctx: Ctx,
  style: RawModel['style'],
  modelName: string,
  aliases: string[]
): RawModel {
  return {
    file: ctx.file,
    style,
    modelName,
    aliases,
    attributes: [],
    optionEntries: new Map(),
    decoratorOptions: {},
    indexes: [],
    foreignKeyHints: new Map(),
    accessors: [],
    unsupported: [],
    location: `${ctx.file.label}: model "${modelName}"`,
  };
}

function addAttributes(
  model: RawModel,
  node: SyntaxNode | undefined,
  ctx: Ctx
): boolean {
  if (node === undefined) {
    return false;
  }
  const { entries, incomplete } = objectEntries(node, ctx);
  if (!incomplete || entries.size > 0) {
    for (const [name, value] of entries) {
      model.attributes.push(readAttribute(name, value, ctx));
    }
  }
  if (incomplete && entries.size > 0) {
    ctx.project.warnings.push(
      `${model.location}: the attributes are not a plain object literal (a spread, a computed key or a value that could not be followed), so some columns may be missing.`
    );
  }
  return entries.size > 0 || !incomplete;
}

/** The name a call expression's result is stored under: `const User = ...`, `db.User = ...`. */
function boundName(call: SyntaxNode): string | undefined {
  let current: SyntaxNode | null = call.parent;
  while (current !== null && TRANSPARENT_NODES.has(current.type)) {
    current = current.parent;
  }
  if (current === null) {
    return undefined;
  }
  if (current.type === 'variable_declarator') {
    const nameNode: SyntaxNode | null = current.childForFieldName('name');
    return nameNode !== null && nameNode.type === 'identifier'
      ? nameNode.text
      : undefined;
  }
  if (current.type === 'assignment_expression') {
    const left: SyntaxNode | null = current.childForFieldName('left');
    return left === null
      ? undefined
      : lastSegment(left.text.replace(/\s+/g, ''));
  }
  return undefined;
}

function collectDefine(call: SyntaxNode, ctx: Ctx): void {
  const args: SyntaxNode[] = argsOf(call);
  const nameNode: SyntaxNode | undefined = args[0];
  const attributesNode: SyntaxNode | undefined = args[1];
  const modelName: string | undefined = stringOf(nameNode, ctx);
  if (nameNode === undefined || attributesNode === undefined) {
    return;
  }
  if (modelName === undefined) {
    ctx.project.warnings.push(
      `${ctx.file.label}: sequelize.define(${nameNode.text.slice(0, 40)}, ...) has a model name that is not a string literal, so the model was skipped.`
    );
    return;
  }
  const bound: string | undefined = boundName(call);
  const model: RawModel = newModel(
    ctx,
    'define',
    modelName,
    bound === undefined ? [] : [bound]
  );
  if (!addAttributes(model, attributesNode, ctx)) {
    ctx.project.warnings.push(
      `${model.location}: the attributes of sequelize.define could not be read statically, so the model was skipped.`
    );
    return;
  }
  const optionsNode: SyntaxNode | undefined = args[2];
  if (optionsNode !== undefined) {
    model.optionEntries = objectEntries(optionsNode, ctx).entries;
  }
  ctx.project.models.push(model);
}

/** The name of the class a node is inside, or of the object `X.associate = ...` is assigned to. */
function enclosingModelName(node: SyntaxNode): string | undefined {
  let current: SyntaxNode | null = node.parent;
  while (current !== null) {
    if (
      current.type === 'class_declaration' ||
      current.type === 'abstract_class_declaration' ||
      current.type === 'class'
    ) {
      return current.childForFieldName('name')?.text;
    }
    if (current.type === 'assignment_expression') {
      const left: SyntaxNode | null = current.childForFieldName('left');
      if (left !== null && left.type === 'member_expression') {
        const objectNode: SyntaxNode | null = left.childForFieldName('object');
        if (objectNode !== null) {
          return lastSegment(objectNode.text.replace(/\s+/g, ''));
        }
      }
    }
    current = current.parent;
  }
  return undefined;
}

function collectInit(call: SyntaxNode, ctx: Ctx): void {
  const args: SyntaxNode[] = argsOf(call);
  const attributesNode: SyntaxNode | undefined = args[0];
  const optionsNode: SyntaxNode | undefined = args[1];
  if (attributesNode === undefined || optionsNode === undefined) {
    return;
  }
  const options: ObjectEntries = objectEntries(optionsNode, ctx);
  // `Model.init(attributes, { sequelize })` is the only shape that defines a model.
  if (!options.entries.has('sequelize')) {
    return;
  }
  const functionNode: SyntaxNode | null = call.childForFieldName('function');
  const receiver: SyntaxNode | null =
    functionNode === null ? null : functionNode.childForFieldName('object');
  if (receiver === null) {
    return;
  }
  const className: string | undefined =
    receiver.type === 'identifier'
      ? receiver.text
      : receiver.type === 'this' || receiver.type === 'super'
        ? enclosingModelName(call)
        : undefined;
  const modelName: string | undefined =
    stringOf(options.entries.get('modelName'), ctx) ?? className;
  if (modelName === undefined) {
    ctx.project.warnings.push(
      `${ctx.file.label}: a Model.init call has no modelName and no class name, so the model was skipped.`
    );
    return;
  }
  const model: RawModel = newModel(
    ctx,
    'init',
    modelName,
    className === undefined ? [] : [className]
  );
  if (!addAttributes(model, attributesNode, ctx)) {
    ctx.project.warnings.push(
      `${model.location}: the attributes of Model.init could not be read statically, so the model was skipped.`
    );
    return;
  }
  model.optionEntries = options.entries;
  ctx.project.models.push(model);
}

// ---------------------------------------------------------------------------
// Association calls
// ---------------------------------------------------------------------------

function collectAssociationCall(
  call: SyntaxNode,
  method: string,
  receiver: SyntaxNode,
  ctx: Ctx
): void {
  const args: SyntaxNode[] = argsOf(call);
  const targetNode: SyntaxNode | undefined = args[0];
  if (targetNode === undefined) {
    return;
  }
  const target: string | undefined = modelReference(targetNode, ctx);
  const source: string =
    receiver.type === 'this'
      ? 'this'
      : (modelReference(receiver, ctx) ??
        lastSegment(receiver.text.replace(/\s+/g, '')));
  if (target === undefined) {
    ctx.project.warnings.push(
      `${ctx.file.label}: ${source}.${method}(${targetNode.text.slice(0, 40)}) names its target in a way that cannot be resolved statically; the association was skipped.`
    );
    return;
  }
  ctx.project.associations.push({
    kind: method as AssociationKind,
    file: ctx.file,
    source,
    enclosing: receiver.type === 'this' ? enclosingModelName(call) : undefined,
    target,
    options: readAssociationOptions(args[1], ctx),
    label: `${source === 'this' ? (enclosingModelName(call) ?? 'this') : source}.${method}(${target})`,
  });
}

// ---------------------------------------------------------------------------
// Model options and indexes
// ---------------------------------------------------------------------------

function timestampOption(
  entries: Map<string, SyntaxNode>,
  key: string,
  fallback: string | false | undefined,
  ctx: Ctx
): string | false {
  const node: SyntaxNode | undefined = entries.get(key);
  if (node !== undefined) {
    const value: TsValue = valueOf(node, ctx);
    if (value.kind === 'string' && value.value !== '') {
      return value.value;
    }
    if (value.kind === 'bool' && !value.value) {
      return false;
    }
  }
  return fallback ?? key;
}

/** Reads the options of a model, with the project defaults and the decorators' contributions below them. */
export function readModelOptions(
  model: RawModel,
  project: Project
): ModelOptions {
  const ctx: Ctx = { file: model.file, project };
  const entries: Map<string, SyntaxNode> = model.optionEntries;
  const defaults: ModelOptionDefaults = project.defaults;
  const flag = (key: keyof ModelOptionDefaults, fallback: boolean): boolean => {
    const value: boolean | undefined = boolOf(entries.get(key), ctx);
    const inherited: unknown = defaults[key];
    return value ?? (typeof inherited === 'boolean' ? inherited : fallback);
  };
  const decorated: Partial<ModelOptions> = model.decoratorOptions;
  const schema: string | undefined =
    stringOf(entries.get('schema'), ctx) ?? defaults.schema;
  const version: SyntaxNode | undefined = entries.get('version');
  const versionValue: TsValue | undefined =
    version === undefined ? undefined : valueOf(version, ctx);
  const nameNode: SyntaxNode | undefined = entries.get('name');
  const nameValue: TsValue | undefined =
    nameNode === undefined ? undefined : valueOf(nameNode, ctx);
  const nameProperties: Record<string, TsValue> =
    nameValue !== undefined && nameValue.kind === 'object'
      ? nameValue.properties
      : {};
  const singular: TsValue | undefined = nameProperties['singular'];
  const plural: TsValue | undefined = nameProperties['plural'];
  const tableName: string | undefined =
    stringOf(entries.get('tableName'), ctx) ?? decorated.tableName;
  return {
    ...(tableName === undefined ? {} : { tableName }),
    freezeTableName: flag('freezeTableName', false),
    timestamps: flag('timestamps', true),
    paranoid: flag('paranoid', false),
    underscored: flag('underscored', false),
    ...(schema === undefined ? {} : { schema }),
    createdAt: timestampOption(
      entries,
      'createdAt',
      decorated.createdAt ?? defaults.createdAt,
      ctx
    ),
    updatedAt: timestampOption(
      entries,
      'updatedAt',
      decorated.updatedAt ?? defaults.updatedAt,
      ctx
    ),
    deletedAt: timestampOption(
      entries,
      'deletedAt',
      decorated.deletedAt ?? defaults.deletedAt,
      ctx
    ),
    ...(versionValue !== undefined &&
    versionValue.kind === 'bool' &&
    versionValue.value
      ? { version: 'version' }
      : versionValue !== undefined && versionValue.kind === 'string'
        ? { version: versionValue.value }
        : decorated.version === undefined
          ? {}
          : { version: decorated.version }),
    ...(boolOf(entries.get('noPrimaryKey'), ctx) === true
      ? { noPrimaryKey: true }
      : {}),
    ...(singular !== undefined && singular.kind === 'string'
      ? { nameSingular: singular.value }
      : {}),
    ...(plural !== undefined && plural.kind === 'string'
      ? { namePlural: plural.value }
      : {}),
  };
}

export function indexFieldOf(
  node: SyntaxNode,
  ctx: Ctx
): RawIndexField | 'expression' {
  const resolved: SyntaxNode = resolveNode(node, ctx);
  const text: string | undefined = stringOf(resolved, ctx);
  if (text !== undefined) {
    return { name: text };
  }
  if (resolved.type === 'object') {
    const { entries } = objectEntries(resolved, ctx);
    const name: string | undefined =
      stringOf(entries.get('name'), ctx) ??
      stringOf(entries.get('attribute'), ctx);
    if (name !== undefined) {
      const order: string | undefined = stringOf(entries.get('order'), ctx);
      const length: number | undefined = numberOf(entries.get('length'), ctx);
      const operator: string | undefined = stringOf(
        entries.get('operator'),
        ctx
      );
      return {
        name,
        ...(order === undefined
          ? {}
          : { order: order.toUpperCase() === 'DESC' ? 'desc' : 'asc' }),
        ...(length === undefined ? {} : { length }),
        ...(operator === undefined ? {} : { operator }),
      };
    }
  }
  return 'expression';
}

/** Reads the `indexes` option (and the `uniqueKeys` option) of a model. */
export function readIndexes(model: RawModel, project: Project): RawIndex[] {
  const ctx: Ctx = { file: model.file, project };
  // sequelize-typescript lets the indexes option of @Table replace the ones its @Index decorators collect.
  const replaced: boolean =
    model.indexes.length > 0 && model.optionEntries.has('indexes');
  if (replaced) {
    project.warnings.push(
      `${model.location}: the indexes option of @Table replaces the indexes declared with @Index, so sequelize-typescript ignores the latter; they were ignored.`
    );
  }
  const indexes: RawIndex[] = replaced ? [] : [...model.indexes];
  const listNode: SyntaxNode | undefined = model.optionEntries.get('indexes');
  const list: SyntaxNode | undefined =
    listNode === undefined ? undefined : resolveNode(listNode, ctx);
  if (list !== undefined && list.type === 'array') {
    for (const item of list.namedChildren) {
      const raw: RawIndex | undefined = readIndex(item, ctx);
      if (raw !== undefined) {
        indexes.push(raw);
      }
    }
  }
  const keysNode: SyntaxNode | undefined =
    model.optionEntries.get('uniqueKeys');
  const keys: SyntaxNode | undefined =
    keysNode === undefined ? undefined : resolveNode(keysNode, ctx);
  if (keys !== undefined && keys.type === 'object') {
    for (const [name, value] of objectEntries(keys, ctx).entries) {
      const raw: RawIndex | undefined = readIndex(value, ctx);
      if (raw !== undefined) {
        indexes.push({ ...raw, unique: true, name: raw.name ?? name });
      }
    }
  }
  return indexes;
}

function readIndex(node: SyntaxNode, ctx: Ctx): RawIndex | undefined {
  const { entries } = objectEntries(node, ctx);
  const fieldsNode: SyntaxNode | undefined = entries.get('fields');
  const fields: SyntaxNode | undefined =
    fieldsNode === undefined ? undefined : resolveNode(fieldsNode, ctx);
  if (fields === undefined || fields.type !== 'array') {
    return undefined;
  }
  const readFields: RawIndexField[] = [];
  let hasExpression: boolean = false;
  for (const item of fields.namedChildren) {
    const field: RawIndexField | 'expression' = indexFieldOf(item, ctx);
    if (field === 'expression') {
      hasExpression = true;
    } else {
      readFields.push(field);
    }
  }
  const type: string | undefined = stringOf(entries.get('type'), ctx);
  const upperType: string | undefined = type?.toUpperCase();
  const name: string | undefined = stringOf(entries.get('name'), ctx);
  const using: string | undefined = stringOf(entries.get('using'), ctx);
  return {
    fields: readFields,
    unique:
      boolOf(entries.get('unique'), ctx) === true || upperType === 'UNIQUE',
    ...(name === undefined ? {} : { name }),
    ...(using === undefined ? {} : { using }),
    ...(upperType === 'FULLTEXT' || upperType === 'SPATIAL'
      ? { type: upperType }
      : {}),
    isPartial: entries.has('where'),
    hasExpression,
  };
}

/** Unsupported model options (hooks, scopes, getters, ...), as written in the options object. */
function noteUnsupportedOptions(model: RawModel): void {
  for (const [key, label] of Object.entries(UNSUPPORTED_MODEL_OPTIONS)) {
    if (model.optionEntries.has(key) && !model.unsupported.includes(label)) {
      model.unsupported.push(label);
    }
  }
}

// ---------------------------------------------------------------------------
// sequelize-typescript
// ---------------------------------------------------------------------------

interface DecoratorNode {
  name: string;
  args: SyntaxNode[];
}

function decoratorOf(node: SyntaxNode): DecoratorNode | undefined {
  const expression: SyntaxNode | undefined = node.namedChildren[0];
  if (expression === undefined) {
    return undefined;
  }
  if (expression.type === 'call_expression') {
    const callee: SyntaxNode | null = expression.childForFieldName('function');
    return callee === null
      ? undefined
      : {
          name: lastSegment(callee.text.replace(/\s+/g, '')),
          args: argsOf(expression),
        };
  }
  return {
    name: lastSegment(expression.text.replace(/\s+/g, '')),
    args: [],
  };
}

/** The decorators written on a node (a class, an export statement or a property). */
function decoratorNodes(node: SyntaxNode): DecoratorNode[] {
  const decorators: DecoratorNode[] = [];
  for (const child of node.namedChildren) {
    const decorator: DecoratorNode | undefined =
      child.type === 'decorator' ? decoratorOf(child) : undefined;
    if (decorator !== undefined) {
      decorators.push(decorator);
    }
  }
  return decorators;
}

/** The TypeScript type of a property, reduced to a name and whether null is allowed. */
function describeTsType(property: SyntaxNode): {
  name: string | undefined;
  nullable: boolean;
} {
  const annotation: SyntaxNode | null = property.childForFieldName('type');
  const typeNode: SyntaxNode | undefined = annotation?.namedChildren[0];
  let nullable: boolean = property.children.some(
    (child: SyntaxNode) => child.type === '?'
  );
  let name: string | undefined;
  const visit = (node: SyntaxNode): void => {
    switch (node.type) {
      case 'union_type':
      case 'parenthesized_type':
        node.namedChildren.forEach(visit);
        return;
      case 'literal_type':
        if (node.text === 'null' || node.text === 'undefined') {
          nullable = true;
        }
        return;
      case 'predefined_type':
      case 'type_identifier':
        if (node.text === 'null' || node.text === 'undefined') {
          nullable = true;
        } else if (name === undefined) {
          name = node.text;
        }
        return;
      case 'generic_type': {
        // `CreationOptional<number>`, `Promise<User>`, `Array<string>`
        const base: string = node.namedChildren[0]?.text ?? '';
        const inner: SyntaxNode | undefined =
          node.namedChildren[1]?.namedChildren[0];
        if (inner !== undefined && TRANSPARENT_TYPES.has(base)) {
          visit(inner);
        } else if (name === undefined) {
          name = base;
        }
        return;
      }
      default:
        if (name === undefined) {
          name = node.text;
        }
    }
  };
  if (typeNode !== undefined) {
    visit(typeNode);
  }
  return { name, nullable };
}

function applyDecorators(
  attribute: RawAttribute,
  decorators: DecoratorNode[],
  model: RawModel,
  ctx: Ctx
): void {
  for (const decorator of decorators) {
    const first: SyntaxNode | undefined = decorator.args[0];
    switch (decorator.name) {
      case 'Column':
      case 'Attribute': {
        if (first === undefined) {
          break;
        }
        const resolved: SyntaxNode = resolveNode(first, ctx);
        if (resolved.type === 'object') {
          applyAttributeEntries(
            attribute,
            objectEntries(resolved, ctx).entries,
            ctx
          );
        } else {
          attribute.type = evaluateNode(resolved);
        }
        break;
      }
      case 'ColumnName':
        attribute.field = stringOf(first, ctx) ?? attribute.field;
        break;
      case 'Version':
        model.decoratorOptions.version = attribute.name;
        break;
      case 'PrimaryKey':
        attribute.primaryKey = true;
        break;
      case 'AutoIncrement':
        attribute.autoIncrement = true;
        break;
      case 'AllowNull':
        attribute.allowNull = boolOf(first, ctx) ?? true;
        break;
      case 'NotNull':
        attribute.allowNull = false;
        break;
      case 'Unique': {
        const value: TsValue | undefined =
          first === undefined ? undefined : valueOf(first, ctx);
        if (value !== undefined && value.kind === 'bool' && !value.value) {
          delete attribute.unique;
        } else if (value !== undefined && value.kind === 'string') {
          attribute.unique = { name: value.value };
        } else if (value !== undefined && value.kind === 'object') {
          const name: TsValue | undefined = value.properties['name'];
          attribute.unique =
            name !== undefined && name.kind === 'string'
              ? { name: name.value }
              : {};
        } else {
          attribute.unique = {};
        }
        break;
      }
      case 'Default':
        if (first !== undefined) {
          attribute.defaultValue = valueOf(first, ctx);
        }
        break;
      case 'Comment':
        attribute.comment = stringOf(first, ctx) ?? attribute.comment;
        break;
      case 'CreatedAt':
      case 'UpdatedAt':
      case 'DeletedAt': {
        const kind: TimestampKind =
          decorator.name === 'CreatedAt'
            ? 'createdAt'
            : decorator.name === 'UpdatedAt'
              ? 'updatedAt'
              : 'deletedAt';
        attribute.timestamp = kind;
        model.decoratorOptions[kind] = attribute.name;
        break;
      }
      case 'ForeignKey': {
        const target: string | undefined =
          first === undefined ? undefined : modelReference(first, ctx);
        if (target !== undefined) {
          model.foreignKeyHints.set(attribute.name, target);
        }
        break;
      }
      case 'Index': {
        model.indexes.push(
          ...indexFromDecorator(attribute.name, decorator, ctx)
        );
        break;
      }
      default:
        break;
    }
  }
}

/** `@Index`, `@Index('name')` and `@Index({ name, unique, using })` on a property. */
function indexFromDecorator(
  attributeName: string,
  decorator: DecoratorNode,
  ctx: Ctx
): RawIndex[] {
  const first: SyntaxNode | undefined = decorator.args[0];
  let name: string | undefined;
  let unique: boolean = false;
  let using: string | undefined;
  let type: string | undefined;
  if (first !== undefined) {
    const resolved: SyntaxNode = resolveNode(first, ctx);
    if (resolved.type === 'object') {
      const { entries } = objectEntries(resolved, ctx);
      name = stringOf(entries.get('name'), ctx);
      unique = boolOf(entries.get('unique'), ctx) === true;
      using = stringOf(entries.get('using'), ctx);
      type = stringOf(entries.get('type'), ctx)?.toUpperCase();
    } else {
      name = stringOf(resolved, ctx);
    }
  }
  return [
    {
      fields: [{ name: attributeName }],
      unique: unique || type === 'UNIQUE',
      ...(name === undefined ? {} : { name }),
      ...(using === undefined ? {} : { using }),
      ...(type === 'FULLTEXT' || type === 'SPATIAL' ? { type } : {}),
      isPartial: false,
      hasExpression: false,
    },
  ];
}

/** Merges indexes that several properties contributed under one name into a composite index. */
export function mergeNamedIndexes(indexes: RawIndex[]): RawIndex[] {
  const merged: RawIndex[] = [];
  const byName: Map<string, RawIndex> = new Map();
  for (const index of indexes) {
    const existing: RawIndex | undefined =
      index.name === undefined ? undefined : byName.get(index.name);
    if (existing === undefined) {
      const copy: RawIndex = { ...index, fields: [...index.fields] };
      merged.push(copy);
      if (index.name !== undefined) {
        byName.set(index.name, copy);
      }
    } else if (index.fields.length === 1 && existing.fields.length > 0) {
      const only: RawIndexField | undefined = index.fields[0];
      if (only !== undefined) {
        existing.fields.push(only);
      }
      existing.unique = existing.unique || index.unique;
    } else {
      merged.push(index);
    }
  }
  return merged;
}

function collectDecoratedClass(
  classNode: SyntaxNode,
  outerDecorators: DecoratorNode[],
  ctx: Ctx
): void {
  const nameNode: SyntaxNode | null = classNode.childForFieldName('name');
  const bodyNode: SyntaxNode | null = classNode.childForFieldName('body');
  if (nameNode === null || bodyNode === null) {
    return;
  }
  const decorators: DecoratorNode[] = [
    ...outerDecorators,
    ...decoratorNodes(classNode),
  ];
  const table: DecoratorNode | undefined = decorators.find(
    (decorator: DecoratorNode) => decorator.name === 'Table'
  );
  if (table === undefined) {
    return;
  }
  const className: string = nameNode.text;
  const optionsNode: SyntaxNode | undefined = table.args[0];
  const optionEntries: ObjectEntries | undefined =
    optionsNode === undefined ? undefined : objectEntries(optionsNode, ctx);
  const modelName: string =
    stringOf(optionEntries?.entries.get('modelName'), ctx) ?? className;
  const model: RawModel = newModel(ctx, 'decorators', modelName, [className]);
  model.optionEntries = optionEntries?.entries ?? new Map();

  for (const decorator of decorators) {
    const unsupported: string | undefined =
      UNSUPPORTED_CLASS_DECORATORS[decorator.name];
    if (unsupported !== undefined && !model.unsupported.includes(unsupported)) {
      model.unsupported.push(unsupported);
    }
  }

  // Properties carry their decorators; for methods (accessors, hooks) they are separate siblings before it.
  let pending: DecoratorNode[] = [];
  for (const member of bodyNode.namedChildren) {
    if (member.type === 'decorator') {
      const decorator: DecoratorNode | undefined = decoratorOf(member);
      if (decorator !== undefined) {
        pending.push(decorator);
      }
      continue;
    }
    const carried: DecoratorNode[] = pending;
    pending = [];
    if (
      member.type !== 'public_field_definition' &&
      member.type !== 'method_definition' &&
      member.type !== 'abstract_method_signature'
    ) {
      continue;
    }
    const memberName: SyntaxNode | null = member.childForFieldName('name');
    if (memberName === null) {
      continue;
    }
    const memberDecorators: DecoratorNode[] = [
      ...carried,
      ...decoratorNodes(member),
    ];
    if (memberDecorators.length === 0) {
      continue;
    }
    if (
      member.type === 'method_definition' &&
      memberDecorators.some((decorator: DecoratorNode) =>
        HOOK_DECORATORS.has(decorator.name)
      )
    ) {
      if (!model.unsupported.includes('hooks')) {
        model.unsupported.push('hooks');
      }
      continue;
    }
    const association: DecoratorNode | undefined = memberDecorators.find(
      (decorator: DecoratorNode) =>
        ASSOCIATION_DECORATORS[decorator.name] !== undefined
    );
    if (association !== undefined) {
      collectDecoratedAssociation(
        association,
        memberName.text,
        model,
        className,
        ctx
      );
      continue;
    }
    if (
      !memberDecorators.some((decorator: DecoratorNode) =>
        COLUMN_DECORATORS.has(decorator.name)
      )
    ) {
      continue;
    }
    const attribute: RawAttribute = {
      name: memberName.text,
      origin: 'declared',
    };
    if (member.type === 'public_field_definition') {
      const tsType = describeTsType(member);
      if (tsType.name !== undefined) {
        attribute.tsType = tsType.name;
      }
      attribute.tsNullable = tsType.nullable;
    }
    applyDecorators(attribute, memberDecorators, model, ctx);
    // `@CreatedAt` alone only names the timestamp column; Sequelize creates it. With `@Column` it is declared.
    if (
      memberDecorators.some(
        (decorator: DecoratorNode) =>
          COLUMN_DECORATORS.has(decorator.name) &&
          !TIMESTAMP_DECORATORS.has(decorator.name)
      )
    ) {
      model.attributes.push(attribute);
    }
  }
  ctx.project.models.push(model);
}

function collectDecoratedAssociation(
  decorator: DecoratorNode,
  propertyName: string,
  model: RawModel,
  className: string,
  ctx: Ctx
): void {
  const kind: AssociationKind | undefined =
    ASSOCIATION_DECORATORS[decorator.name];
  const targetNode: SyntaxNode | undefined = decorator.args[0];
  if (kind === undefined || targetNode === undefined) {
    return;
  }
  const target: string | undefined = modelReference(targetNode, ctx);
  if (target === undefined) {
    ctx.project.warnings.push(
      `${model.location}: @${decorator.name} on "${propertyName}" names its target in a way that cannot be resolved statically; the association was skipped.`
    );
    return;
  }
  const second: SyntaxNode | undefined = decorator.args[1];
  let options: AssociationOptions;
  if (kind === 'belongsToMany') {
    // @BelongsToMany(() => Tag, () => PostTag, 'postId', 'tagId') or (() => Tag, { through })
    const secondResolved: SyntaxNode | undefined =
      second === undefined ? undefined : resolveNode(second, ctx);
    if (secondResolved !== undefined && secondResolved.type === 'object') {
      options = readAssociationOptions(secondResolved, ctx);
    } else {
      options = { unsupported: [] };
      const through: AssociationOptions['through'] = describeThrough(
        second,
        ctx
      );
      if (through !== undefined) {
        options.through = through;
      }
      const foreignKey: AssociationKey | undefined = readKey(
        decorator.args[2],
        ctx
      );
      const otherKey: AssociationKey | undefined = readKey(
        decorator.args[3],
        ctx
      );
      if (foreignKey !== undefined) {
        options.foreignKey = foreignKey;
      }
      if (otherKey !== undefined) {
        options.otherKey = otherKey;
      }
    }
  } else {
    options = readAssociationOptions(second, ctx);
  }
  if (options.as === undefined) {
    options.as = propertyName;
  }
  ctx.project.associations.push({
    kind,
    file: ctx.file,
    source: className,
    enclosing: className,
    target,
    options,
    propertyName,
    owner: model,
    label: `${className}.${propertyName} (@${decorator.name})`,
  });
  addInverseAssociation(kind, className, target, options, ctx);
}

/**
 * Sequelize 7 `inverse`: `@BelongsTo(() => User, { foreignKey: 'authorId', inverse: { type: 'hasMany', as: 'posts' } })`
 * also defines `User.posts`, and the other kinds define the `belongsTo` on the target. The inverse is read as
 * the association call it stands for, made on the target model with the same foreign key.
 */
function addInverseAssociation(
  kind: AssociationKind,
  className: string,
  target: string,
  options: AssociationOptions,
  ctx: Ctx
): void {
  const inverse: AssociationOptions['inverse'] = options.inverse;
  if (inverse === undefined) {
    return;
  }
  if (kind === 'belongsToMany') {
    // The other half of a many-to-many: the same join table with the two keys swapped.
    ctx.project.associations.push({
      kind,
      file: ctx.file,
      source: target,
      enclosing: undefined,
      target: className,
      options: {
        unsupported: [],
        ...(inverse.as === undefined ? {} : { as: inverse.as }),
        ...(options.through === undefined ? {} : { through: options.through }),
        ...(options.otherKey === undefined
          ? {}
          : { foreignKey: options.otherKey }),
        ...(options.foreignKey === undefined
          ? {}
          : { otherKey: options.foreignKey }),
        ...(options.sourceKey === undefined
          ? {}
          : { targetKey: options.sourceKey }),
        ...(options.targetKey === undefined
          ? {}
          : { sourceKey: options.targetKey }),
      },
      label: `${className} (inverse of ${className}.${options.as ?? ''})`,
    });
    return;
  }
  const inverseKind: AssociationKind =
    kind === 'belongsTo' ? (inverse.type ?? 'hasMany') : 'belongsTo';
  const inverseOptions: AssociationOptions = {
    unsupported: [],
    ...(inverse.as === undefined ? {} : { as: inverse.as }),
    ...(options.foreignKey === undefined
      ? {}
      : { foreignKey: options.foreignKey }),
    ...(options.constraints === undefined
      ? {}
      : { constraints: options.constraints }),
    ...(kind === 'belongsTo' && options.targetKey !== undefined
      ? { sourceKey: options.targetKey }
      : {}),
    ...(kind !== 'belongsTo' && options.sourceKey !== undefined
      ? { targetKey: options.sourceKey }
      : {}),
  };
  ctx.project.associations.push({
    kind: inverseKind,
    file: ctx.file,
    source: target,
    enclosing: undefined,
    target: className,
    options: inverseOptions,
    label: `${className} (inverse of ${className}.${options.as ?? ''})`,
  });
}

// ---------------------------------------------------------------------------
// Entry point of the walk
// ---------------------------------------------------------------------------

function isSequelizeConstructor(node: SyntaxNode): boolean {
  const constructor: SyntaxNode | null = node.childForFieldName('constructor');
  return constructor !== null && /(^|\.)Sequelize$/.test(constructor.text);
}

function readGlobalDefaults(node: SyntaxNode, ctx: Ctx): void {
  const args: SyntaxNode[] = argsOf(node);
  for (const arg of args) {
    const resolved: SyntaxNode = resolveNode(arg, ctx);
    if (resolved.type !== 'object') {
      continue;
    }
    const define: SyntaxNode | undefined = objectEntries(
      resolved,
      ctx
    ).entries.get('define');
    if (define === undefined) {
      continue;
    }
    const entries: Map<string, SyntaxNode> = objectEntries(define, ctx).entries;
    const defaults: ModelOptionDefaults = {};
    for (const key of [
      'freezeTableName',
      'timestamps',
      'paranoid',
      'underscored',
    ] as const) {
      const value: boolean | undefined = boolOf(entries.get(key), ctx);
      if (value !== undefined) {
        defaults[key] = value;
      }
    }
    for (const key of ['createdAt', 'updatedAt', 'deletedAt'] as const) {
      const entry: SyntaxNode | undefined = entries.get(key);
      const value: TsValue | undefined =
        entry === undefined ? undefined : valueOf(entry, ctx);
      if (value !== undefined && value.kind === 'string') {
        defaults[key] = value.value;
      } else if (value !== undefined && value.kind === 'bool' && !value.value) {
        defaults[key] = false;
      }
    }
    const schema: string | undefined = stringOf(entries.get('schema'), ctx);
    if (schema !== undefined) {
      defaults.schema = schema;
    }
    if (Object.keys(ctx.project.defaults).length === 0) {
      Object.assign(ctx.project.defaults, defaults);
    }
  }
}

/** Walks one file and records its models, association calls and the shared `define` defaults. */
export function collectFile(file: FileInfo, project: Project): void {
  const ctx: Ctx = { file, project };
  const stack: SyntaxNode[] = [file.root];
  while (stack.length > 0) {
    const node: SyntaxNode | undefined = stack.pop();
    if (node === undefined) {
      break;
    }
    const children: SyntaxNode[] = node.namedChildren;
    for (let index: number = children.length - 1; index >= 0; index -= 1) {
      const child: SyntaxNode | undefined = children[index];
      if (child !== undefined) {
        stack.push(child);
      }
    }
    switch (node.type) {
      case 'call_expression': {
        const callee: SyntaxNode | null = node.childForFieldName('function');
        if (callee === null || callee.type !== 'member_expression') {
          break;
        }
        const property: SyntaxNode | null =
          callee.childForFieldName('property');
        const receiver: SyntaxNode | null = callee.childForFieldName('object');
        if (property === null || receiver === null) {
          break;
        }
        if (property.text === 'define') {
          collectDefine(node, ctx);
        } else if (property.text === 'init') {
          collectInit(node, ctx);
        } else if (ASSOCIATION_METHODS.has(property.text)) {
          collectAssociationCall(node, property.text, receiver, ctx);
        }
        break;
      }
      case 'new_expression':
        if (isSequelizeConstructor(node)) {
          readGlobalDefaults(node, ctx);
        }
        break;
      case 'export_statement': {
        // `@Table(...) export class X` keeps the decorators on the export statement.
        const decorators: DecoratorNode[] = decoratorNodes(node);
        const classNode: SyntaxNode | undefined = node.namedChildren.find(
          (child: SyntaxNode) =>
            child.type === 'class_declaration' ||
            child.type === 'abstract_class_declaration' ||
            child.type === 'class'
        );
        if (classNode !== undefined && decorators.length > 0) {
          collectDecoratedClass(classNode, decorators, ctx);
        }
        break;
      }
      case 'class_declaration':
      case 'abstract_class_declaration':
        collectDecoratedClass(node, [], ctx);
        break;
      default:
        break;
    }
  }
  for (const model of project.models) {
    if (model.file === file && model.optionEntries.size > 0) {
      noteUnsupportedOptions(model);
    }
  }
}
