import { toSnakeCase } from '../naming.js';

/** Name and literal helpers of the neomodel writer. */

/** Python keywords: an identifier with one of these names does not parse. */
const PYTHON_KEYWORDS: ReadonlySet<string> = new Set([
  'False',
  'None',
  'True',
  'and',
  'as',
  'assert',
  'async',
  'await',
  'break',
  'class',
  'continue',
  'def',
  'del',
  'elif',
  'else',
  'except',
  'finally',
  'for',
  'from',
  'global',
  'if',
  'import',
  'in',
  'is',
  'lambda',
  'nonlocal',
  'not',
  'or',
  'pass',
  'raise',
  'return',
  'try',
  'while',
  'with',
  'yield',
]);

/**
 * Attribute names that neomodel itself uses on a node or relationship class. A property with one of these
 * names is refused (`id`, `element_id`, `deleted`, `source`, `target`) or hides a method (`save`, `delete`).
 */
export const RESERVED_ATTRIBUTES: ReadonlySet<string> = new Set([
  'DoesNotExist',
  'bulk_save',
  'create',
  'create_or_update',
  'cypher',
  'defined_properties',
  'deflate',
  'delete',
  'deleted',
  'element_id',
  'element_id_property',
  'end_node',
  'get_or_create',
  'id',
  'inflate',
  'inherited_labels',
  'inherited_optional_labels',
  'labels',
  'nodes',
  'refresh',
  'save',
  'source',
  'start_node',
  'target',
  'was_saved',
]);

/**
 * Names the generated module imports or defines at the top level. A node class with one of these names
 * would hide the import, so its class is renamed and the label is kept with `__label__`.
 */
export const RESERVED_TYPES: ReadonlySet<string> = new Set([
  'AliasProperty',
  'ArrayProperty',
  'BooleanProperty',
  'DateProperty',
  'DateTimeNeo4jFormatProperty',
  'datetime',
  'timezone',
  'DateTimeProperty',
  'EmailProperty',
  'FloatProperty',
  'FulltextIndex',
  'IntegerProperty',
  'JSONProperty',
  'One',
  'OneOrMore',
  'Q',
  'Relationship',
  'RelationshipFrom',
  'RelationshipTo',
  'StringProperty',
  'StructuredNode',
  'StructuredRel',
  'UniqueIdProperty',
  'ZeroOrMore',
  'ZeroOrOne',
  'date',
  'uuid4',
]);

const IDENTIFIER: RegExp = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** True when the text is a plain Python identifier that is not a keyword. */
export function isPythonIdentifier(text: string): boolean {
  return IDENTIFIER.test(text) && !PYTHON_KEYWORDS.has(text);
}

/**
 * The Python attribute name for a graph property key or relation name: snake_case, a leading underscore
 * before a digit, a trailing underscore when the word is a keyword or one neomodel uses (`id` is `id_`).
 */
export function attributeNameOf(raw: string): string {
  let name: string = toSnakeCase(raw);
  if (name === '') {
    name = 'value';
  }
  if (/^[0-9]/.test(name)) {
    name = `_${name}`;
  }
  return PYTHON_KEYWORDS.has(name) || RESERVED_ATTRIBUTES.has(name)
    ? `${name}_`
    : name;
}

/** Reserves `base` in `used`, appending `_2`, `_3`, ... when the name is taken. */
export function uniqueAttribute(base: string, used: Set<string>): string {
  let candidate: string = base;
  let suffix: number = 2;
  while (used.has(candidate)) {
    candidate = `${base}_${suffix}`;
    suffix += 1;
  }
  used.add(candidate);
  return candidate;
}

/** Reserves a class name in `used`, appending 2, 3, ... when it is taken. */
export function uniqueClassName(base: string, used: Set<string>): string {
  let candidate: string = base;
  let suffix: number = 2;
  while (used.has(candidate)) {
    candidate = `${base}${suffix}`;
    suffix += 1;
  }
  used.add(candidate);
  return candidate;
}

/** A class name for a node label: the label when it is a valid identifier, otherwise a repaired form. */
export function classNameOf(label: string): string {
  const cleaned: string = label.replace(/[^A-Za-z0-9_]/g, '_');
  const prefixed: string = /^[0-9]/.test(cleaned) ? `_${cleaned}` : cleaned;
  const named: string = prefixed === '' ? 'Node' : prefixed;
  return PYTHON_KEYWORDS.has(named) ? `${named}_` : named;
}

/** A Python string literal in double quotes (the JSON escapes are valid Python escapes). */
export function pyString(value: string): string {
  return JSON.stringify(value);
}
