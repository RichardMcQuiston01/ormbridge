import type { AnnotationNode, AnnotationValue } from 'ormbridge';
import { kotlinExpression } from './kotlinAnnotations.js';

/** Java types, as the JPA emitter writes them, as Kotlin types. */

const SCALARS: ReadonlyMap<string, string> = new Map<string, string>([
  ['int', 'Int'],
  ['long', 'Long'],
  ['short', 'Short'],
  ['byte', 'Byte'],
  ['boolean', 'Boolean'],
  ['double', 'Double'],
  ['float', 'Float'],
  ['char', 'Char'],
  ['Integer', 'Int'],
  ['Long', 'Long'],
  ['Short', 'Short'],
  ['Byte', 'Byte'],
  ['Boolean', 'Boolean'],
  ['Double', 'Double'],
  ['Float', 'Float'],
  ['Character', 'Char'],
  ['Object', 'Any'],
  ['String', 'String'],
  ['List', 'MutableList'],
  ['Set', 'MutableSet'],
  ['Map', 'MutableMap'],
  ['Collection', 'MutableCollection'],
  ['ArrayList', 'ArrayList'],
  ['HashSet', 'HashSet'],
  ['HashMap', 'HashMap'],
]);

const PRIMITIVE_JAVA: ReadonlySet<string> = new Set<string>([
  'int',
  'long',
  'short',
  'byte',
  'boolean',
  'double',
  'float',
  'char',
]);

/** Java imports Kotlin does not need: the collection classes are Kotlin types. */
export const KOTLIN_BUILT_IN_IMPORTS: ReadonlySet<string> = new Set<string>([
  'java.util.List',
  'java.util.Set',
  'java.util.Map',
  'java.util.Collection',
  'java.util.ArrayList',
  'java.util.HashSet',
  'java.util.HashMap',
  'java.util.LinkedHashSet',
  'java.util.LinkedHashMap',
]);

function splitArguments(text: string): string[] {
  const parts: string[] = [];
  let depth: number = 0;
  let start: number = 0;
  for (let position: number = 0; position < text.length; position += 1) {
    const character: string = text.charAt(position);
    if (character === '<') {
      depth += 1;
    } else if (character === '>') {
      depth -= 1;
    } else if (character === ',' && depth === 0) {
      parts.push(text.slice(start, position).trim());
      start = position + 1;
    }
  }
  parts.push(text.slice(start).trim());
  return parts;
}

/** A Java type as a non-null Kotlin type: `Map<String, Object>` is `MutableMap<String, Any>`. */
export function kotlinType(javaType: string): string {
  const text: string = javaType.trim();
  if (text.endsWith('[]')) {
    const element: string = text.slice(0, -2);
    const primitive: string | undefined = PRIMITIVE_JAVA.has(element)
      ? `${SCALARS.get(element) ?? element}Array`
      : undefined;
    return primitive ?? `Array<${kotlinType(element)}>`;
  }
  if (text === '?') {
    return '*';
  }
  const open: number = text.indexOf('<');
  if (open < 0) {
    return SCALARS.get(text) ?? text;
  }
  const name: string = text.slice(0, open);
  const args: string[] = splitArguments(text.slice(open + 1, -1)).map(
    kotlinType
  );
  return `${SCALARS.get(name) ?? name}<${args.join(', ')}>`;
}

export function isPrimitive(javaType: string): boolean {
  return PRIMITIVE_JAVA.has(javaType.trim());
}

/** True for the types the Kotlin standard library has mutable collections for. */
export function isCollection(javaType: string): boolean {
  return /^(?:List|Set|Map|Collection|ArrayList|HashSet|HashMap)</.test(
    javaType.trim()
  );
}

function argument(
  node: AnnotationNode,
  key: string
): AnnotationValue | undefined {
  return node.args.find(
    ([name]: [string | undefined, AnnotationValue]) => name === key
  )?.[1];
}

/** True when an annotation says the value cannot be null: `nullable = false` or `optional = false`. */
export function declaresNotNull(
  annotations: readonly AnnotationNode[]
): boolean {
  return annotations.some((node: AnnotationNode): boolean => {
    return (
      argument(node, 'nullable') === 'false' ||
      argument(node, 'optional') === 'false'
    );
  });
}

/** The default value of a primitive Kotlin type, which a property without an initializer gets. */
export function primitiveDefault(javaType: string): string {
  switch (javaType.trim()) {
    case 'boolean':
      return 'false';
    case 'long':
      return '0L';
    case 'float':
      return '0f';
    case 'double':
      return '0.0';
    case 'char':
      return "'\\u0000'";
    default:
      return '0';
  }
}

/** A Java initializer as Kotlin: `new HashSet<>()` is `mutableSetOf()`, `new Foo(x)` is `Foo(x)`. */
export function kotlinInitializer(initializer: string): string {
  const text: string = initializer.trim();
  const collections: ReadonlyMap<string, string> = new Map<string, string>([
    ['new ArrayList<>()', 'mutableListOf()'],
    ['new LinkedList<>()', 'mutableListOf()'],
    ['new HashSet<>()', 'mutableSetOf()'],
    ['new LinkedHashSet<>()', 'linkedSetOf()'],
    ['new HashMap<>()', 'mutableMapOf()'],
    ['new LinkedHashMap<>()', 'linkedMapOf()'],
  ]);
  const collection: string | undefined = collections.get(text);
  if (collection !== undefined) {
    return collection;
  }
  const array: RegExpMatchArray | null = text.match(/^new byte\[(\d+)\]$/);
  if (array !== null) {
    return `ByteArray(${array[1] ?? '0'})`;
  }
  return kotlinExpression(text.replace(/^new\s+/, ''));
}
