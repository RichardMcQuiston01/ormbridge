import {
  singularize,
  toCamelCase,
  toPascalCase,
  toSnakeCase,
} from '../naming.js';

const PLAIN_IDENTIFIER: RegExp = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Writes a label, relationship type, property key or constraint name. Names that are not plain
 * identifiers are wrapped in backticks, and a backtick inside the name is doubled.
 */
export function quoteIdentifier(name: string): string {
  return PLAIN_IDENTIFIER.test(name) ? name : `\`${name.replace(/`/g, '``')}\``;
}

/** Collapses line breaks and runs of whitespace so text can sit safely inside a one-line `//` comment. */
export function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Node label of a model: PascalCase and singular (`blog_posts` and `BlogPosts` both give `BlogPost`). */
export function labelOf(modelName: string): string {
  const label: string = toPascalCase(singularize(toSnakeCase(modelName)));
  return label === '' ? modelName : label;
}

/** Relationship type of a relation field: UPPER_SNAKE_CASE (`edited_by` and `editedBy` give `EDITED_BY`). */
export function relationshipTypeOf(relationName: string): string {
  const type: string = toSnakeCase(relationName).toUpperCase();
  return type === '' ? 'RELATED_TO' : type;
}

/**
 * Property key of a column. The `preserve` naming mode keeps the column name; `normalize` uses
 * camelCase, the Neo4j convention. A name with no letters or digits is kept as it is.
 */
export function propertyKeyOf(columnName: string, camelCase: boolean): string {
  if (!camelCase) {
    return columnName;
  }
  const camel: string = toCamelCase(columnName);
  return camel === '' ? columnName : camel;
}

/** Hands out names that are unique within one namespace (labels, or constraint and index names). */
export class NameRegistry {
  private readonly used: Set<string> = new Set<string>();

  /** Reserves `base`, or `base2`, `base3`, ... when it is taken, and returns the name reserved. */
  claim(base: string): string {
    let candidate: string = base;
    let suffix: number = 2;
    while (this.used.has(candidate)) {
      candidate = `${base}${suffix}`;
      suffix += 1;
    }
    this.used.add(candidate);
    return candidate;
  }

  has(name: string): boolean {
    return this.used.has(name);
  }
}

/** snake_case words for a constraint or index name (`x` when the text has no letters or digits). */
export function nameWords(text: string): string {
  const words: string = toSnakeCase(text);
  return words === '' ? 'x' : words;
}
