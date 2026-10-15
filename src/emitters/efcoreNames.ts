import { toPascalCase } from '../naming.js';

/** Name and literal helpers of the Entity Framework Core emitter. */

/** The namespace of the generated classes when none is given. */
export const DEFAULT_EFCORE_NAMESPACE: string = 'App.Models';

const IDENTIFIER_PATTERN: RegExp = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** C# keywords: an identifier with one of these names needs the `@` prefix. */
const KEYWORDS: ReadonlySet<string> = new Set([
  'abstract',
  'as',
  'base',
  'bool',
  'break',
  'byte',
  'case',
  'catch',
  'char',
  'checked',
  'class',
  'const',
  'continue',
  'decimal',
  'default',
  'delegate',
  'do',
  'double',
  'else',
  'enum',
  'event',
  'explicit',
  'extern',
  'false',
  'finally',
  'fixed',
  'float',
  'for',
  'foreach',
  'goto',
  'if',
  'implicit',
  'in',
  'int',
  'interface',
  'internal',
  'is',
  'lock',
  'long',
  'namespace',
  'new',
  'null',
  'object',
  'operator',
  'out',
  'override',
  'params',
  'private',
  'protected',
  'public',
  'readonly',
  'ref',
  'return',
  'sbyte',
  'sealed',
  'short',
  'sizeof',
  'stackalloc',
  'static',
  'string',
  'struct',
  'switch',
  'this',
  'throw',
  'true',
  'try',
  'typeof',
  'uint',
  'ulong',
  'unchecked',
  'unsafe',
  'ushort',
  'using',
  'virtual',
  'void',
  'volatile',
  'while',
]);

/** Type names the generated code refers to, which a model of the same name would hide. */
export const RESERVED_TYPE_NAMES: ReadonlySet<string> = new Set([
  'Array',
  'Attribute',
  'Boolean',
  'Byte',
  'ChangeTracker',
  'DateOnly',
  'DateTime',
  'Decimal',
  'DeleteBehavior',
  'Dictionary',
  'Double',
  'DbContext',
  'DbContextOptions',
  'DbSet',
  'ICollection',
  'IEntityTypeConfiguration',
  'Int32',
  'Int64',
  'IPAddress',
  'Guid',
  'List',
  'ModelBuilder',
  'Nullable',
  'NpgsqlRange',
  'Object',
  'String',
  'Task',
  'TimeOnly',
  'TimeSpan',
  'Type',
  'ValueConverter',
]);

/** Members every object has, or that `DbContext` has; a property of the same name would hide them. */
export const RESERVED_MEMBER_NAMES: ReadonlySet<string> = new Set([
  'Equals',
  'Finalize',
  'GetHashCode',
  'GetType',
  'MemberwiseClone',
  'ReferenceEquals',
  'ToString',
]);

/** Members of `DbContext` that a `DbSet` property must not take the name of. */
export const DBCONTEXT_MEMBER_NAMES: ReadonlySet<string> = new Set([
  'ChangeTracker',
  'ContextId',
  'Database',
  'Dispose',
  'Entry',
  'Model',
  'SaveChanges',
  'Set',
]);

/** True for a valid C# identifier that is not a keyword. */
export function isCsharpIdentifier(value: string): boolean {
  return IDENTIFIER_PATTERN.test(value) && !KEYWORDS.has(value);
}

/** True for a dotted C# namespace such as `App.Models`. */
export function isValidCsharpNamespace(value: string): boolean {
  return (
    value.length > 0 &&
    value.split('.').every((part: string) => isCsharpIdentifier(part))
  );
}

/** Writes a name as an identifier: a keyword gets the `@` prefix. */
export function verbatim(name: string): string {
  return KEYWORDS.has(name) ? `@${name}` : name;
}

/**
 * Turns any text into a valid PascalCase identifier. Returns undefined when nothing usable is left
 * (a name made only of characters an identifier cannot hold).
 */
export function pascalIdentifier(raw: string): string | undefined {
  const pascal: string = toPascalCase(raw);
  if (pascal === '') {
    return undefined;
  }
  return /^[0-9]/.test(pascal) ? `_${pascal}` : pascal;
}

/** Keeps a name that is already a valid identifier and repairs one that is not. */
export function repairedIdentifier(raw: string): string {
  if (IDENTIFIER_PATTERN.test(raw)) {
    return raw;
  }
  const replaced: string = raw.replace(/[^A-Za-z0-9_]/g, '_');
  const prefixed: string = /^[0-9]/.test(replaced) ? `_${replaced}` : replaced;
  return prefixed === '' || /^_+$/.test(prefixed) ? 'Value' : prefixed;
}

/** Reserves `base` in `used`, appending a number when the name is taken. */
export function uniqueName(base: string, used: Set<string>): string {
  let candidate: string = base;
  let suffix: number = 2;
  while (used.has(candidate)) {
    candidate = `${base}${suffix}`;
    suffix += 1;
  }
  used.add(candidate);
  return candidate;
}

/** Reserves a navigation name: a name that is taken gets the suffix `Ref` before a number is tried. */
export function navigationName(base: string, used: Set<string>): string {
  return uniqueName(used.has(base) ? `${base}Ref` : base, used);
}

/** A C# string literal. */
export function csString(value: string): string {
  let escaped: string = '';
  for (const character of value) {
    const code: number = character.codePointAt(0) ?? 0;
    switch (character) {
      case '\\':
        escaped += '\\\\';
        break;
      case '"':
        escaped += '\\"';
        break;
      case '\n':
        escaped += '\\n';
        break;
      case '\r':
        escaped += '\\r';
        break;
      case '\t':
        escaped += '\\t';
        break;
      default:
        escaped +=
          code < 0x20 || code === 0x7f
            ? `\\u${code.toString(16).padStart(4, '0')}`
            : character;
    }
  }
  return `"${escaped}"`;
}

const UNCOUNTABLE: ReadonlySet<string> = new Set([
  'series',
  'news',
  'species',
  'sheep',
  'fish',
  'equipment',
  'information',
  'metadata',
  'data',
  'media',
]);

const IRREGULAR: Readonly<Record<string, string>> = {
  person: 'people',
  child: 'children',
  man: 'men',
  woman: 'women',
};

function pluralizeWord(word: string): string {
  const lower: string = word.toLowerCase();
  if (UNCOUNTABLE.has(lower)) {
    return word;
  }
  const irregular: string | undefined = IRREGULAR[lower];
  if (irregular !== undefined) {
    return word.charAt(0) === word.charAt(0).toUpperCase()
      ? irregular.charAt(0).toUpperCase() + irregular.slice(1)
      : irregular;
  }
  if (/[^s]s$/.test(lower) && !/(us|is|ous)$/.test(lower)) {
    // Already plural (`PostTags`).
    return word;
  }
  if (/(s|x|z|ch|sh)$/.test(lower)) {
    return `${word}es`;
  }
  if (/[^aeiou]y$/.test(lower)) {
    return `${word.slice(0, -1)}ies`;
  }
  return `${word}s`;
}

/** Pluralizes the last word of a PascalCase name: `BlogPost` is `BlogPosts`, `Category` `Categories`. */
export function pluralize(name: string): string {
  const match: RegExpMatchArray | null = name.match(
    /^(.*?)([A-Z][a-z0-9]*|[a-z0-9]+)$/
  );
  if (match === null) {
    return `${name}s`;
  }
  return `${match[1] ?? ''}${pluralizeWord(match[2] ?? '')}`;
}
