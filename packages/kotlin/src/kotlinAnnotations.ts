import type { AnnotationNode, AnnotationValue } from 'ormbridge';

/** Writes the annotation model of the JPA emitter as Kotlin: arrays in brackets, `X::class`, nested annotations without `@`. */

const LINE_LIMIT: number = 100;
const INDENT: string = '    ';

/** Parameters of the JPA and Hibernate annotations that take an array; Kotlin needs `[x]` for a single element. */
const ARRAY_PARAMETERS: ReadonlyMap<string, readonly string[]> = new Map<
  string,
  readonly string[]
>([
  ['Table', ['indexes', 'uniqueConstraints']],
  ['SecondaryTable', ['indexes', 'uniqueConstraints', 'pkJoinColumns']],
  ['UniqueConstraint', ['columnNames']],
  ['OneToOne', ['cascade']],
  ['OneToMany', ['cascade']],
  ['ManyToOne', ['cascade']],
  ['ManyToMany', ['cascade']],
  [
    'JoinTable',
    ['joinColumns', 'inverseJoinColumns', 'uniqueConstraints', 'indexes'],
  ],
  ['CollectionTable', ['joinColumns', 'uniqueConstraints', 'indexes']],
  ['JoinColumns', ['value']],
  ['PrimaryKeyJoinColumns', ['value']],
  ['AttributeOverrides', ['value']],
  ['AssociationOverrides', ['value']],
  ['AssociationOverride', ['joinColumns']],
  ['Checks', ['value']],
]);

/** Annotations that exist only for Java and have no Kotlin meaning. */
const DROPPED: ReadonlySet<string> = new Set<string>(['SuppressWarnings']);

/** Java expression text as Kotlin: `Foo.class` is `Foo::class`, and `$` in a string is escaped. */
export function kotlinExpression(text: string): string {
  let result: string = '';
  let position: number = 0;
  while (position < text.length) {
    const character: string = text.charAt(position);
    if (character === '"') {
      let end: number = position + 1;
      while (end < text.length && text.charAt(end) !== '"') {
        end += text.charAt(end) === '\\' ? 2 : 1;
      }
      result += text.slice(position, end + 1).replace(/\$/g, '\\$');
      position = end + 1;
    } else {
      result += character;
      position += 1;
    }
  }
  return result.replace(/\b([A-Za-z_][\w.]*)\.class\b/g, '$1::class');
}

function inline(value: AnnotationValue, asArray: boolean): string {
  if (typeof value === 'string') {
    const text: string = kotlinExpression(value);
    return asArray ? `[${text}]` : text;
  }
  if (Array.isArray(value)) {
    return `[${value.map((item: AnnotationValue) => inline(item, false)).join(', ')}]`;
  }
  const nested: string = inlineNode(value, false);
  return asArray ? `[${nested}]` : nested;
}

function arrayParameter(
  node: AnnotationNode,
  key: string | undefined
): boolean {
  return ARRAY_PARAMETERS.get(node.name)?.includes(key ?? 'value') === true;
}

/**
 * What precedes an argument: its name, or `value = ` for an array written without a name (Kotlin reads a positional array
 * of a Java annotation as one element of its `value`).
 */
function leadOf(
  node: AnnotationNode,
  key: string | undefined,
  value: AnnotationValue
): string {
  if (key !== undefined) {
    return `${key} = `;
  }
  return Array.isArray(value) || arrayParameter(node, key) ? 'value = ' : '';
}

function inlineNode(node: AnnotationNode, prefix: boolean): string {
  const lead: string = prefix ? '@' : '';
  if (node.args.length === 0) {
    return `${lead}${node.name}`;
  }
  const args: string[] = node.args.map(
    ([key, value]: [string | undefined, AnnotationValue]): string => {
      const written: string = inline(value, arrayParameter(node, key));
      return `${leadOf(node, key, value)}${written}`;
    }
  );
  return `${lead}${node.name}(${args.join(', ')})`;
}

/** The lines of an array, one item per line; the last item has no comma (the Kotlin grammar of tree-sitter rejects it). */
function formatArray(
  items: readonly AnnotationValue[],
  indent: number
): string[] {
  const pad: string = ' '.repeat(indent);
  return [
    `${pad}[`,
    ...items.map(
      (item: AnnotationValue, position: number): string =>
        `${pad}${INDENT}${inline(item, false)}${position === items.length - 1 ? '' : ','}`
    ),
    `${pad}]`,
  ];
}

/** The lines of an annotation: on one line when it fits, otherwise one argument per line. */
export function formatKotlinAnnotation(
  node: AnnotationNode,
  indent: number
): string[] {
  if (DROPPED.has(node.name)) {
    return [];
  }
  const pad: string = ' '.repeat(indent);
  const single: string = `${pad}${inlineNode(node, true)}`;
  if (single.length <= LINE_LIMIT) {
    return [single];
  }
  const lines: string[] = [`${pad}@${node.name}(`];
  for (const [key, value] of node.args) {
    const lead: string = leadOf(node, key, value);
    const written: string = inline(value, arrayParameter(node, key));
    const oneLine: string = `${pad}${INDENT}${lead}${written},`;
    if (oneLine.length <= LINE_LIMIT || !Array.isArray(value)) {
      lines.push(oneLine);
    } else {
      const items: string[] = formatArray(value, indent + INDENT.length);
      lines.push(`${pad}${INDENT}${lead}${items[0]?.trimStart() ?? '['}`);
      lines.push(...items.slice(1));
      lines[lines.length - 1] = `${lines[lines.length - 1] ?? ''},`;
    }
  }
  lines.push(`${pad})`);
  return lines;
}
