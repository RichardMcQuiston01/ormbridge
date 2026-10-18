import { singularize, toCamelCase, toPascalCase } from '../naming.js';

/** Name and literal helpers of the Hibernate / JPA emitter. */

/** The Java package of the generated classes when none is given. */
export const DEFAULT_JPA_PACKAGE: string = 'app.models';

const IDENTIFIER_PATTERN: RegExp = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Java keywords and literals: an identifier with one of these names does not compile. */
const KEYWORDS: ReadonlySet<string> = new Set([
  'abstract',
  'assert',
  'boolean',
  'break',
  'byte',
  'case',
  'catch',
  'char',
  'class',
  'const',
  'continue',
  'default',
  'do',
  'double',
  'else',
  'enum',
  'extends',
  'false',
  'final',
  'finally',
  'float',
  'for',
  'goto',
  'if',
  'implements',
  'import',
  'instanceof',
  'int',
  'interface',
  'long',
  'native',
  'new',
  'non-sealed',
  'null',
  'package',
  'private',
  'protected',
  'public',
  'return',
  'short',
  'static',
  'strictfp',
  'super',
  'switch',
  'synchronized',
  'this',
  'throw',
  'throws',
  'transient',
  'true',
  'try',
  'void',
  'volatile',
  'while',
  '_',
]);

/**
 * Simple names of the types the generated code imports or refers to. A class of the same name in the package
 * would be hidden by the import (or collide with `java.lang`), so a model or enum with one of these names is renamed.
 */
export const RESERVED_TYPE_NAMES: ReadonlySet<string> = new Set([
  'ArrayList',
  'Arrays',
  'AttributeConverter',
  'BigDecimal',
  'BigInteger',
  'Boolean',
  'Byte',
  'Character',
  'Class',
  'Collection',
  'Column',
  'ColumnDefault',
  'ConstraintMode',
  'Convert',
  'Converter',
  'CreationTimestamp',
  'Double',
  'Duration',
  'DynamicInsert',
  'Entity',
  'Enum',
  'EnumType',
  'Enumerated',
  'FetchType',
  'Float',
  'ForeignKey',
  'GeneratedColumn',
  'GeneratedValue',
  'GenerationType',
  'GenericGenerator',
  'HashSet',
  'Id',
  'IdClass',
  'Immutable',
  'Index',
  'InetAddress',
  'Instant',
  'Integer',
  'Iterable',
  'JdbcTypeCode',
  'JoinColumn',
  'JoinColumns',
  'JoinTable',
  'List',
  'LocalDate',
  'LocalDateTime',
  'LocalTime',
  'Lob',
  'Long',
  'ManyToMany',
  'ManyToOne',
  'Map',
  'Math',
  'Number',
  'Object',
  'OffsetDateTime',
  'OnDelete',
  'OnDeleteAction',
  'OneToMany',
  'OneToOne',
  'Objects',
  'Override',
  'Record',
  'Serializable',
  'Set',
  'Short',
  'SqlTypes',
  'String',
  'System',
  'Table',
  'Thread',
  'UUID',
  'UniqueConstraint',
  'UpdateTimestamp',
  'UuidGenerator',
  'Void',
]);

/** True for a valid Java identifier that is not a keyword. */
export function isJavaIdentifier(value: string): boolean {
  return IDENTIFIER_PATTERN.test(value) && !KEYWORDS.has(value);
}

/** True for a dotted Java package name such as `app.models`. */
export function isValidJavaPackage(value: string): boolean {
  return (
    value.length > 0 &&
    value.split('.').every((part: string) => isJavaIdentifier(part))
  );
}

/** Keeps a name that is already a valid identifier and repairs one that is not. */
export function repairedIdentifier(raw: string): string {
  const replaced: string = raw.replace(/[^A-Za-z0-9_]/g, '_');
  const prefixed: string = /^[0-9]/.test(replaced) ? `_${replaced}` : replaced;
  const named: string =
    prefixed === '' || /^_+$/.test(prefixed) ? 'value' : prefixed;
  return KEYWORDS.has(named) ? `${named}_` : named;
}

/** A class name: PascalCase, singular when the model was named after a table (`blog_posts`). */
export function classNameOf(modelName: string): string {
  if (/^[A-Z][A-Za-z0-9]*$/.test(modelName)) {
    return modelName;
  }
  const words: string = /[_\s-]/.test(modelName)
    ? singularize(modelName.toLowerCase().replace(/[\s-]+/g, '_'))
    : modelName;
  const pascal: string = toPascalCase(words);
  if (pascal === '') {
    return 'Entity';
  }
  return /^[0-9]/.test(pascal) ? `_${pascal}` : pascal;
}

/** An attribute name: camelCase, with a trailing underscore when the word is reserved in Java. */
export function attributeNameOf(raw: string): string {
  const camel: string = toCamelCase(raw);
  if (camel === '') {
    return 'value';
  }
  const named: string = /^[0-9]/.test(camel) ? `_${camel}` : camel;
  return KEYWORDS.has(named) || named === 'class' ? `${named}_` : named;
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

/** Upper-cases the first letter: `viewCount` is `ViewCount`. */
export function capitalize(name: string): string {
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/** A Java string literal. */
export function javaString(value: string): string {
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

/** A SQL string literal (single quotes doubled), for `@ColumnDefault` and `columnDefinition`. */
export function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}
