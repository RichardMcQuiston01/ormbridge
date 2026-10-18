/**
 * A small model of Java annotations and a printer that lays them out the way google-java-format does: on one line
 * when they fit, otherwise one argument per line (indented by 4), with arrays of nested annotations one item per
 * line (indented by 2 inside the braces).
 */

export type AnnotationValue = string | AnnotationNode | AnnotationValue[];

export interface AnnotationNode {
  /** The simple name, without the `@`. */
  name: string;
  /** Arguments as `[name, value]`; a name of `undefined` is the single `value` argument (`@Id`, `@Lob`). */
  args: [string | undefined, AnnotationValue][];
}

const LINE_LIMIT: number = 100;

/** Builds an annotation node. */
export function annotation(
  name: string,
  args: [string | undefined, AnnotationValue][] = []
): AnnotationNode {
  return { name, args };
}

function isNode(value: AnnotationValue): value is AnnotationNode {
  return typeof value === 'object' && !Array.isArray(value);
}

function inline(value: AnnotationValue): string {
  if (typeof value === 'string') {
    return value;
  }
  if (Array.isArray(value)) {
    const items: string[] = value.map(inline);
    return items.length === 1 ? (items[0] ?? '') : `{${items.join(', ')}}`;
  }
  if (value.args.length === 0) {
    return `@${value.name}`;
  }
  const args: string[] = value.args.map(
    ([key, item]: [string | undefined, AnnotationValue]) =>
      key === undefined ? inline(item) : `${key} = ${inline(item)}`
  );
  return `@${value.name}(${args.join(', ')})`;
}

/**
 * Lays out `lead + value + tail` starting at `indent` spaces: `lead` is what precedes the value on its first line
 * (`indexes = `) and `tail` what follows it on its last (`,` or `)`).
 */
function layout(
  value: AnnotationValue,
  indent: number,
  lead: string,
  tail: string
): string[] {
  const pad: string = ' '.repeat(indent);
  const single: string = `${pad}${lead}${inline(value)}${tail}`;
  const forceBreak: boolean =
    Array.isArray(value) && value.length > 1 && value.some(isNode);
  if (
    typeof value === 'string' ||
    (single.length <= LINE_LIMIT && !forceBreak)
  ) {
    return [single];
  }
  if (Array.isArray(value)) {
    if (value.length === 1 && value[0] !== undefined) {
      return layout(value[0], indent, lead, tail);
    }
    const lines: string[] = [`${pad}${lead}{`];
    value.forEach((item: AnnotationValue, position: number) => {
      lines.push(
        ...layout(
          item,
          indent + 2,
          '',
          position === value.length - 1 ? '' : ','
        )
      );
    });
    lines.push(`${pad}}${tail}`);
    return lines;
  }
  const only: [string | undefined, AnnotationValue] | undefined =
    value.args.length === 1 ? value.args[0] : undefined;
  if (only?.[0] === undefined && Array.isArray(only?.[1])) {
    // A lone array argument hugs the parentheses: @JoinColumns({ ... })
    const items: AnnotationValue[] = only?.[1] ?? [];
    const lines: string[] = [`${pad}${lead}@${value.name}({`];
    items.forEach((item: AnnotationValue, position: number) => {
      lines.push(
        ...layout(
          item,
          indent + 2,
          '',
          position === items.length - 1 ? '' : ','
        )
      );
    });
    lines.push(`${pad}})${tail}`);
    return lines;
  }
  const lines: string[] = [`${pad}${lead}@${value.name}(`];
  value.args.forEach(
    ([key, item]: [string | undefined, AnnotationValue], position: number) => {
      const last: boolean = position === value.args.length - 1;
      lines.push(
        ...layout(
          item,
          indent + 4,
          key === undefined ? '' : `${key} = `,
          last ? `)${tail}` : ','
        )
      );
    }
  );
  return lines;
}

/** The lines of one annotation placed at `indent` spaces. */
export function formatAnnotation(
  node: AnnotationNode,
  indent: number
): string[] {
  return layout(node, indent, '', '');
}
