import type { IrDefault, IrEnumValue, IrScalarType } from '../ir.js';
import type { SyntaxNode } from './typescriptSyntax.js';
import {
  functionResult,
  isFunctionNode,
  literalOf,
  objectMembers,
  stripWrappers,
  unwindChain,
  type ChainStep,
  type LiteralValue,
  type ZodChain,
  type ZodFileInfo,
} from './zodSyntax.js';

/**
 * Turns the Zod expression of one object property (`z.string().max(50).optional()`) into what the shared
 * model stores about a column. It has no notion of models, only of the names it may meet: the host
 * (src/parsers/zod.ts) answers what a declared name is.
 */

/** The values of an enum-like declaration: a const object, a const array or a TypeScript enum. */
export interface EnumValues {
  values: IrEnumValue[];
  /** True when the members are numbers (a numeric TypeScript enum), which the shared model cannot store as an enum. */
  numeric: boolean;
}

/** What a declared name is, as far as a property can use it. */
export type DeclaredKind = 'model' | 'enum' | 'alias' | 'values';

export interface FieldHost {
  kindOf(name: string): DeclaredKind | undefined;
  /** The model name of a declared object schema. */
  modelNameOf(name: string): string | undefined;
  /** The enum name of a declared enum schema. */
  enumNameOf(name: string): string | undefined;
  /** The member name an enum gives to a stored value (for `.default('draft')`). */
  enumMemberName(enumName: string, value: string): string | undefined;
  /** The file and expression of a declared alias such as `const Email = z.string().email()`. */
  aliasOf(name: string): { file: ZodFileInfo; node: SyntaxNode } | undefined;
  /** The values of a const object, const array or TypeScript enum. */
  valuesOf(name: string): EnumValues | undefined;
  /** Registers an enum written inline in a property and returns its name. */
  inlineEnum(model: string, key: string, values: IrEnumValue[]): string;
}

export interface FieldScope {
  host: FieldHost;
  file: ZodFileInfo;
  model: string;
  key: string;
}

/** Everything the reader learns about one property. */
export interface ResolvedField {
  type: IrScalarType;
  maxLength?: number;
  maxDigits?: number;
  decimalPlaces?: number;
  enumName?: string;
  arrayDepth: number;
  optional: boolean;
  nullable: boolean;
  hasDefault: boolean;
  default?: IrDefault;
  /** Set when the property holds another declared object schema. */
  relation?: { model: string; many: boolean };
  /** Rules and modifiers with no equivalent in the shared model, as written (`.min(3)`). */
  dropped: string[];
  /** Reasons the property fell back to json or could not be resolved; each becomes a warning. */
  problems: string[];
  /** Set for `z.null()` and `z.undefined()`, which only matter inside a union. */
  onlyNull?: boolean;
  onlyUndefined?: boolean;
  /** Set for a single string literal, which a union of literals turns into an enum. */
  literalString?: string;
}

const MAX_DEPTH: number = 24;

const STRING_FORMAT_BASES: Readonly<Record<string, IrScalarType | 'plain'>> = {
  uuid: 'uuid',
  guid: 'plain',
  uuidv4: 'uuid',
  uuidv6: 'uuid',
  uuidv7: 'uuid',
  email: 'plain',
  url: 'plain',
  httpUrl: 'plain',
  emoji: 'plain',
  nanoid: 'plain',
  cuid: 'plain',
  cuid2: 'plain',
  ulid: 'plain',
  xid: 'plain',
  ksuid: 'plain',
  jwt: 'plain',
  hostname: 'plain',
  e164: 'plain',
  cidrv4: 'plain',
  cidrv6: 'plain',
  ipv4: 'ipAddress',
  ipv6: 'ipAddress',
  base64: 'bytes',
  base64url: 'plain',
  hex: 'plain',
  'iso.datetime': 'dateTime',
  'iso.date': 'date',
  'iso.time': 'time',
  'iso.duration': 'duration',
};

/** Format methods of a Zod 3 / Zod 4 string (`z.string().uuid()`). */
const STRING_FORMAT_STEPS: Readonly<Record<string, IrScalarType | 'plain'>> = {
  uuid: 'uuid',
  guid: 'plain',
  email: 'plain',
  url: 'plain',
  emoji: 'plain',
  nanoid: 'plain',
  cuid: 'plain',
  cuid2: 'plain',
  ulid: 'plain',
  xid: 'plain',
  ksuid: 'plain',
  jwt: 'plain',
  e164: 'plain',
  cidr: 'plain',
  ip: 'ipAddress',
  ipv4: 'ipAddress',
  ipv6: 'ipAddress',
  base64: 'bytes',
  base64url: 'plain',
  datetime: 'dateTime',
  date: 'date',
  time: 'time',
  duration: 'duration',
};

const JSON_BASES: ReadonlySet<string> = new Set([
  'any',
  'unknown',
  'json',
  'record',
  'partialRecord',
  'looseRecord',
  'map',
]);

/** Constructors that describe no stored value: they become json, with a warning. */
const NO_COLUMN_BASES: ReadonlySet<string> = new Set([
  'custom',
  'instanceof',
  'function',
  'promise',
  'symbol',
  'void',
  'never',
  'nan',
  'codec',
]);

export const OBJECT_BASES: ReadonlySet<string> = new Set([
  'object',
  'strictObject',
  'looseObject',
  'interface',
  'strictInterface',
]);

/** Wrappers written as functions (`z.optional(inner)`): the schema is the first argument. */
const WRAPPER_BASES: ReadonlySet<string> = new Set([
  'optional',
  'nullable',
  'nullish',
  'readonly',
  'lazy',
  'nonoptional',
  'brand',
  'catch',
  'default',
  'prefault',
]);

/** Modifiers that change nothing the shared model stores and are not worth mentioning. */
const SILENT_STEPS: ReadonlySet<string> = new Set(['describe', 'meta']);

const DECIMAL_UNSIZED: string = '/^-?\\d+(\\.\\d+)?$/';
const BIGINT_PATTERN: string = '/^-?\\d+$/';
const DECIMAL_SIZED: RegExp =
  /^\/\^-\?\\d\{1,(\d+)\}(?:\(\\\.\\d\{1,(\d+)\}\)\?)?\$\/$/;

function emptyField(type: IrScalarType): ResolvedField {
  return {
    type,
    arrayDepth: 0,
    optional: false,
    nullable: false,
    hasDefault: false,
    dropped: [],
    problems: [],
  };
}

function jsonField(problem?: string): ResolvedField {
  const field: ResolvedField = emptyField('json');
  if (problem !== undefined) {
    field.problems.push(problem);
  }
  return field;
}

function stepText(step: ChainStep): string {
  const first: SyntaxNode | undefined = step.args[0];
  const text: string =
    first === undefined || isFunctionNode(stripWrappers(first))
      ? ''
      : first.text;
  return `.${step.name}(${text.length > 24 || text.includes('\n') ? '' : text})`;
}

function isTextual(field: ResolvedField): boolean {
  return (
    (field.type === 'string' || field.type === 'text') &&
    field.enumName === undefined &&
    field.arrayDepth === 0 &&
    field.relation === undefined
  );
}

const TYPE_LABELS: Readonly<Partial<Record<IrScalarType, string>>> = {
  text: 'string',
  string: 'string',
  uuid: 'string',
  int: 'number',
  float: 'number',
  bigInt: 'bigint',
  boolean: 'boolean',
  date: 'Date',
  dateTime: 'Date',
  json: 'unknown',
};

/** A short name for a resolved type, used when a union of unlike types falls back to json. */
function describeField(field: ResolvedField): string {
  const base: string =
    field.relation !== undefined
      ? field.relation.model
      : (field.enumName ?? TYPE_LABELS[field.type] ?? field.type);
  return `${base}${'[]'.repeat(field.arrayDepth)}`;
}

function sameShape(first: ResolvedField, second: ResolvedField): boolean {
  return (
    first.type === second.type &&
    first.enumName === second.enumName &&
    first.arrayDepth === second.arrayDepth &&
    first.relation?.model === second.relation?.model &&
    first.relation?.many === second.relation?.many
  );
}

function mergeNotes(target: ResolvedField, source: ResolvedField): void {
  target.dropped.push(...source.dropped);
  target.problems.push(...source.problems);
}

/** Resolves the Zod expression at `node` (a property value). */
export function resolveFieldNode(
  scope: FieldScope,
  node: SyntaxNode
): ResolvedField {
  return resolveNode(scope, node, 0);
}

function resolveNode(
  scope: FieldScope,
  node: SyntaxNode,
  depth: number
): ResolvedField {
  const chain: ZodChain | undefined = unwindChain(scope.file, node);
  if (chain === undefined) {
    return jsonField(
      `the value \`${truncate(node.text)}\` is not a Zod schema this reader understands; it was kept as json.`
    );
  }
  return resolveChain(scope, chain, depth);
}

function truncate(text: string): string {
  const flat: string = text.replace(/\s+/g, ' ');
  return flat.length > 60 ? `${flat.slice(0, 57)}...` : flat;
}

export function resolveChain(
  scope: FieldScope,
  chain: ZodChain,
  depth: number
): ResolvedField {
  if (depth > MAX_DEPTH) {
    return jsonField('the schema is nested too deeply; it was kept as json.');
  }
  let field: ResolvedField =
    chain.base === undefined
      ? resolveReference(scope, chain.ref ?? '', depth)
      : resolveBase(scope, chain.base.name, chain.base.args, depth);
  for (const step of chain.steps) {
    field = applyStep(scope, field, step, depth);
  }
  return field;
}

function resolveReference(
  scope: FieldScope,
  name: string,
  depth: number
): ResolvedField {
  const { host } = scope;
  switch (host.kindOf(name)) {
    case 'model': {
      const field: ResolvedField = emptyField('json');
      field.relation = { model: host.modelNameOf(name) ?? name, many: false };
      return field;
    }
    case 'enum': {
      const field: ResolvedField = emptyField('string');
      const enumName: string | undefined = host.enumNameOf(name);
      if (enumName === undefined) {
        return jsonField(`the enum "${name}" could not be read; kept as json.`);
      }
      field.enumName = enumName;
      return field;
    }
    case 'alias': {
      const alias: { file: ZodFileInfo; node: SyntaxNode } | undefined =
        host.aliasOf(name);
      if (alias === undefined) {
        return jsonField(`"${name}" could not be read; it was kept as json.`);
      }
      return resolveNode({ ...scope, file: alias.file }, alias.node, depth + 1);
    }
    case 'values':
      return jsonField(
        `"${name}" is a list of values, not a Zod schema; it was kept as json.`
      );
    default:
      return jsonField(
        `"${name}" is not declared in the input files, so its type is unknown; it was kept as json. Pass the file that declares it too.`
      );
  }
}

// ---------------------------------------------------------------------------
// Constructors
// ---------------------------------------------------------------------------

function resolveBase(
  scope: FieldScope,
  name: string,
  args: SyntaxNode[],
  depth: number
): ResolvedField {
  const first: SyntaxNode | undefined = args[0];
  switch (name) {
    case 'string':
    case 'coerce.string':
    case 'templateLiteral':
      return emptyField('text');
    case 'number':
    case 'coerce.number':
    case 'float32':
    case 'float64':
      return emptyField('float');
    case 'int':
    case 'int32':
    case 'uint32':
      return emptyField('int');
    case 'bigint':
    case 'coerce.bigint':
    case 'int64':
    case 'uint64':
      return emptyField('bigInt');
    case 'boolean':
    case 'coerce.boolean':
    case 'stringbool':
      return emptyField('boolean');
    case 'date':
    case 'coerce.date':
      return emptyField('dateTime');
    case 'file':
      return emptyField('bytes');
    case 'null': {
      const field: ResolvedField = jsonField();
      field.onlyNull = true;
      field.nullable = true;
      return field;
    }
    case 'undefined': {
      const field: ResolvedField = jsonField();
      field.onlyUndefined = true;
      field.optional = true;
      return field;
    }
    case 'enum':
    case 'nativeEnum':
      return resolveEnum(scope, name, first);
    case 'literal':
      return resolveLiteral(scope, first);
    case 'array':
    case 'set':
      return wrapArray(
        first === undefined
          ? jsonField(`z.${name}() has no element schema; kept as json.`)
          : resolveNode(scope, first, depth + 1)
      );
    case 'union':
    case 'xor':
      return resolveUnion(scope, first, depth);
    case 'preprocess':
      return withDropped(
        args[1] === undefined
          ? jsonField('z.preprocess() has no schema; kept as json.')
          : resolveNode(scope, args[1], depth + 1),
        '.preprocess()'
      );
    case 'pipe':
      return withDropped(
        first === undefined
          ? jsonField('z.pipe() has no schema; kept as json.')
          : resolveNode(scope, first, depth + 1),
        '.pipe()'
      );
    default:
      break;
  }
  if (name in STRING_FORMAT_BASES) {
    return stringFormat(name, STRING_FORMAT_BASES[name] ?? 'plain', true);
  }
  if (WRAPPER_BASES.has(name)) {
    return resolveWrapper(scope, name, args, depth);
  }
  if (JSON_BASES.has(name)) {
    return emptyField('json');
  }
  if (OBJECT_BASES.has(name)) {
    return jsonField(
      'a nested z.object() is kept as one json column (no model is made for an unnamed object).'
    );
  }
  if (name === 'tuple') {
    return jsonField('a z.tuple() is kept as one json column.');
  }
  if (name === 'intersection') {
    return jsonField('a z.intersection() is kept as one json column.');
  }
  if (name === 'discriminatedUnion') {
    return jsonField('a z.discriminatedUnion() is kept as one json column.');
  }
  if (NO_COLUMN_BASES.has(name)) {
    return jsonField(`z.${name}() has no column type; it was kept as json.`);
  }
  return jsonField(
    `z.${name}() is not a Zod constructor this reader knows; it was kept as json.`
  );
}

function withDropped(field: ResolvedField, text: string): ResolvedField {
  field.dropped.push(text);
  return field;
}

function stringFormat(
  name: string,
  target: IrScalarType | 'plain',
  asConstructor: boolean
): ResolvedField {
  const field: ResolvedField = emptyField(target === 'plain' ? 'text' : target);
  if (target === 'plain') {
    field.dropped.push(asConstructor ? `z.${name}()` : `.${name}()`);
  }
  return field;
}

function resolveWrapper(
  scope: FieldScope,
  name: string,
  args: SyntaxNode[],
  depth: number
): ResolvedField {
  const first: SyntaxNode | undefined = args[0];
  if (first === undefined) {
    return jsonField(`z.${name}() has no schema; kept as json.`);
  }
  if (name === 'lazy' && isFunctionNode(first)) {
    const inner: SyntaxNode | undefined = functionResult(first);
    return inner === undefined
      ? jsonField(
          'z.lazy() returns something other than one schema; kept as json.'
        )
      : resolveNode(scope, inner, depth + 1);
  }
  return applyStep(
    scope,
    resolveNode(scope, first, depth + 1),
    { name, args: args.slice(1) },
    depth
  );
}

function resolveEnum(
  scope: FieldScope,
  name: string,
  argument: SyntaxNode | undefined
): ResolvedField {
  if (argument === undefined) {
    return jsonField(`z.${name}() has no values; kept as json.`);
  }
  const source: SyntaxNode = stripWrappers(argument);
  let enumValues: EnumValues | undefined;
  if (source.type === 'array') {
    const values: IrEnumValue[] = [];
    for (const item of source.namedChildren) {
      const literal: LiteralValue | undefined = literalOf(item);
      if (typeof literal === 'string') {
        values.push({ name: literal, dbValue: literal });
      } else if (item.type !== 'comment') {
        return jsonField(
          `z.${name}() lists a value that is not a string literal; kept as json.`
        );
      }
    }
    enumValues = { values, numeric: false };
  } else if (source.type === 'object') {
    enumValues = objectEnumValues(source);
  } else if (source.type === 'identifier') {
    enumValues = scope.host.valuesOf(source.text);
    if (enumValues === undefined) {
      return jsonField(
        `z.${name}(${source.text}) refers to a list of values that is not declared in the input files; kept as json.`
      );
    }
  }
  if (enumValues?.numeric === true) {
    const field: ResolvedField = emptyField('int');
    field.dropped.push(`numeric enum z.${name}(${truncate(argument.text)})`);
    return field;
  }
  if (enumValues === undefined || enumValues.values.length === 0) {
    return jsonField(
      `z.${name}(${truncate(argument.text)}) has values that could not be read statically; kept as json.`
    );
  }
  const field: ResolvedField = emptyField('string');
  field.enumName = scope.host.inlineEnum(
    scope.model,
    scope.key,
    enumValues.values
  );
  return field;
}

/** Reads `{ A: 'a', B: 'b' }` as enum members (name -> stored value). */
export function objectEnumValues(objectNode: SyntaxNode): EnumValues {
  const values: IrEnumValue[] = [];
  let numeric: boolean = false;
  for (const member of objectMembers(objectNode).members) {
    if (member.kind !== 'property') {
      continue;
    }
    const literal: LiteralValue | undefined = literalOf(member.node);
    if (typeof literal === 'string') {
      values.push({ name: member.key, dbValue: literal });
    } else if (typeof literal === 'number') {
      numeric = true;
    }
  }
  return { values: numeric ? [] : values, numeric };
}

function resolveLiteral(
  scope: FieldScope,
  argument: SyntaxNode | undefined
): ResolvedField {
  const text: string = argument === undefined ? '' : truncate(argument.text);
  if (argument === undefined) {
    return jsonField('z.literal() has no value; kept as json.');
  }
  if (stripWrappers(argument).type === 'array') {
    // Zod 4: z.literal(['a', 'b']) is a union of literals.
    const items: SyntaxNode[] = stripWrappers(argument).namedChildren.filter(
      (child: SyntaxNode) => child.type !== 'comment'
    );
    return combineOptions(
      scope,
      items.map((item: SyntaxNode): ResolvedField =>
        resolveLiteral(scope, item)
      )
    );
  }
  const literal: LiteralValue | undefined = literalOf(argument);
  let field: ResolvedField;
  if (typeof literal === 'string') {
    field = emptyField('text');
    field.literalString = literal;
  } else if (typeof literal === 'number') {
    field = emptyField(Number.isInteger(literal) ? 'int' : 'float');
  } else if (typeof literal === 'boolean') {
    field = emptyField('boolean');
  } else if (literal === null) {
    field = jsonField();
    field.onlyNull = true;
    return field;
  } else {
    return jsonField(
      `z.literal(${text}) is not a plain literal; kept as json.`
    );
  }
  field.dropped.push(`z.literal(${text})`);
  return field;
}

function wrapArray(inner: ResolvedField): ResolvedField {
  const field: ResolvedField = inner;
  if (inner.optional || inner.nullable) {
    field.dropped.push('nullable array elements');
    field.optional = false;
    field.nullable = false;
  }
  field.hasDefault = false;
  delete field.default;
  if (field.relation !== undefined) {
    field.relation = { ...field.relation, many: true };
  } else {
    field.arrayDepth += 1;
  }
  return field;
}

function resolveUnion(
  scope: FieldScope,
  options: SyntaxNode | undefined,
  depth: number
): ResolvedField {
  const list: SyntaxNode | undefined =
    options === undefined ? undefined : stripWrappers(options);
  if (list === undefined || list.type !== 'array') {
    return jsonField(
      'a z.union() without an inline list of schemas is kept as json.'
    );
  }
  const resolved: ResolvedField[] = list.namedChildren
    .filter((child: SyntaxNode) => child.type !== 'comment')
    .map((child: SyntaxNode): ResolvedField =>
      resolveNode(scope, child, depth + 1)
    );
  return combineOptions(scope, resolved);
}

/** Merges the options of a union: nulls make it nullable, string literals make an enum, equal types collapse. */
function combineOptions(
  scope: FieldScope,
  options: ResolvedField[]
): ResolvedField {
  const nullable: boolean = options.some(
    (option: ResolvedField) => option.onlyNull === true
  );
  const optional: boolean = options.some(
    (option: ResolvedField) => option.onlyUndefined === true
  );
  const rest: ResolvedField[] = options.filter(
    (option: ResolvedField) =>
      option.onlyNull !== true && option.onlyUndefined !== true
  );
  let result: ResolvedField;
  const first: ResolvedField | undefined = rest[0];
  if (first === undefined) {
    result = jsonField();
  } else if (rest.length === 1) {
    result = first;
  } else if (
    rest.every((option: ResolvedField) => option.literalString !== undefined)
  ) {
    result = emptyField('string');
    result.enumName = scope.host.inlineEnum(
      scope.model,
      scope.key,
      rest.map((option: ResolvedField): IrEnumValue => ({
        name: option.literalString ?? '',
        dbValue: option.literalString ?? '',
      }))
    );
  } else if (rest.every((option: ResolvedField) => sameShape(first, option))) {
    result = first;
    for (const option of rest.slice(1)) {
      mergeNotes(result, option);
      if (option.maxLength !== result.maxLength) {
        delete result.maxLength;
      }
    }
  } else {
    result = jsonField(
      `a union of unlike types (${rest.map(describeField).join(' | ')}) is kept as one json column.`
    );
    for (const option of rest) {
      result.dropped.push(...option.dropped);
    }
  }
  if (nullable) {
    result.nullable = true;
  }
  if (optional) {
    result.optional = true;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

function numberArgument(step: ChainStep): number | undefined {
  const first: SyntaxNode | undefined = step.args[0];
  const literal: LiteralValue | undefined =
    first === undefined ? undefined : literalOf(first);
  return typeof literal === 'number' ? literal : undefined;
}

function applyStep(
  scope: FieldScope,
  field: ResolvedField,
  step: ChainStep,
  depth: number
): ResolvedField {
  switch (step.name) {
    case 'optional':
      field.optional = true;
      return field;
    case 'nullable':
      field.nullable = true;
      return field;
    case 'nullish':
      field.optional = true;
      field.nullable = true;
      return field;
    case 'nonoptional':
    case 'required':
      field.optional = false;
      return field;
    case 'default':
    case 'prefault':
    case 'catch':
      applyDefault(scope, field, step);
      return field;
    case 'array':
      return wrapArray(field);
    case 'or':
      return applyUnion(scope, field, step, depth);
    case 'and':
      field.problems.push('a .and() intersection is kept as one json column.');
      field.type = 'json';
      delete field.maxLength;
      delete field.enumName;
      delete field.relation;
      field.arrayDepth = 0;
      return field;
    case 'int':
      if (field.type === 'float' && field.arrayDepth === 0) {
        field.type = 'int';
      }
      return field;
    case 'max':
    case 'length': {
      const limit: number | undefined = numberArgument(step);
      if (isTextual(field) && limit !== undefined) {
        field.maxLength = limit;
        if (step.name === 'length') {
          field.dropped.push(`${stepText(step)} (kept as the maximum length)`);
        }
        return field;
      }
      field.dropped.push(stepText(step));
      return field;
    }
    case 'regex':
      applyRegex(field, step);
      return field;
    default:
      break;
  }
  if (isTextual(field) && step.name in STRING_FORMAT_STEPS) {
    const target: IrScalarType | 'plain' =
      STRING_FORMAT_STEPS[step.name] ?? 'plain';
    if (target === 'plain') {
      field.dropped.push(stepText(step));
    } else {
      field.type = target;
      delete field.maxLength;
    }
    return field;
  }
  if (!SILENT_STEPS.has(step.name)) {
    field.dropped.push(stepText(step));
  }
  return field;
}

function applyRegex(field: ResolvedField, step: ChainStep): void {
  const pattern: string = step.args[0]?.text ?? '';
  if (isTextual(field) && field.maxLength === undefined) {
    if (pattern === BIGINT_PATTERN) {
      field.type = 'bigInt';
      return;
    }
    if (pattern === DECIMAL_UNSIZED) {
      field.type = 'decimal';
      return;
    }
    const sized: RegExpExecArray | null = DECIMAL_SIZED.exec(pattern);
    if (sized !== null) {
      const integerDigits: number = Number(sized[1]);
      const places: number = sized[2] === undefined ? 0 : Number(sized[2]);
      field.type = 'decimal';
      field.maxDigits = integerDigits + places;
      field.decimalPlaces = places;
      return;
    }
  }
  field.dropped.push('.regex()');
}

function applyUnion(
  scope: FieldScope,
  field: ResolvedField,
  step: ChainStep,
  depth: number
): ResolvedField {
  const other: SyntaxNode | undefined = step.args[0];
  return other === undefined
    ? field
    : combineOptions(scope, [field, resolveNode(scope, other, depth + 1)]);
}

function applyDefault(
  scope: FieldScope,
  field: ResolvedField,
  step: ChainStep
): void {
  field.hasDefault = true;
  if (step.name === 'catch') {
    field.dropped.push('.catch() (read as the default)');
  }
  const argument: SyntaxNode | undefined = step.args[0];
  if (argument === undefined) {
    return;
  }
  const value: IrDefault | undefined | 'none' = defaultOf(
    scope,
    field,
    argument
  );
  if (value === 'none') {
    return;
  }
  if (value === undefined) {
    field.dropped.push(stepText({ name: 'default', args: step.args }));
    return;
  }
  field.default = value;
}

/** Reads a default value; undefined when it is not a value the shared model can store, "none" for a null default. */
function defaultOf(
  scope: FieldScope,
  field: ResolvedField,
  argument: SyntaxNode
): IrDefault | undefined | 'none' {
  const current: SyntaxNode = stripWrappers(argument);
  if (isFunctionNode(current)) {
    const result: SyntaxNode | undefined = functionResult(current);
    const text: string = result?.text.replace(/\s+/g, '') ?? '';
    if (
      (field.type === 'dateTime' || field.type === 'date') &&
      /^(newDate\(\)|Date\.now\(\))$/.test(text)
    ) {
      return { kind: 'now' };
    }
    if (field.type === 'uuid' && /randomUUID\(\)$/.test(text)) {
      return { kind: 'uuid' };
    }
    return result !== undefined && field.arrayDepth === 0
      ? structuredDefault(field, result)
      : undefined;
  }
  const literal: LiteralValue | undefined = literalOf(current);
  if (literal === null) {
    return 'none';
  }
  if (typeof literal === 'string' && field.enumName !== undefined) {
    const member: string | undefined = scope.host.enumMemberName(
      field.enumName,
      literal
    );
    return member === undefined
      ? undefined
      : { kind: 'enumValue', value: member };
  }
  if (literal !== undefined) {
    return field.arrayDepth === 0
      ? { kind: 'literal', value: literal }
      : undefined;
  }
  return field.arrayDepth === 0 ? structuredDefault(field, current) : undefined;
}

/** `{}` and `[]` as the default of a json column are stored as their text. */
function structuredDefault(
  field: ResolvedField,
  node: SyntaxNode
): IrDefault | undefined {
  const current: SyntaxNode = stripWrappers(node);
  if (field.type !== 'json') {
    return undefined;
  }
  if (current.type === 'object' && current.namedChildCount === 0) {
    return { kind: 'literal', value: '{}' };
  }
  if (current.type === 'array' && current.namedChildCount === 0) {
    return { kind: 'literal', value: '[]' };
  }
  return undefined;
}
