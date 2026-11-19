import { NameRegistry, nameWords, quoteIdentifier } from './neo4jNames.js';
import type { Neo4jStyle, Neo4jType } from './neo4jTypes.js';

/** What a constraint or index is created on: all nodes of a label, or all relationships of a type. */
export interface SchemaTarget {
  /** The pattern after `FOR`, for example `(n:Post)` or `()-[r:TAGS]-()`. */
  pattern: string;
  /** The variable the pattern binds, so properties are written `n.title` or `r.note`. */
  variable: string;
  /** The label or type as snake_case words, used in constraint and index names. */
  words: string;
}

export function nodeTarget(label: string): SchemaTarget {
  return {
    pattern: `(n:${quoteIdentifier(label)})`,
    variable: 'n',
    words: nameWords(label),
  };
}

export function relationshipTarget(type: string): SchemaTarget {
  return {
    pattern: `()-[r:${quoteIdentifier(type)}]-()`,
    variable: 'r',
    words: nameWords(type),
  };
}

type ConstraintKind = 'unique' | 'key' | 'required' | 'type';

const SUFFIXES: Readonly<Record<string, string>> = {
  unique: 'unique',
  key: 'key',
  required: 'required',
  type: 'type',
  index: 'idx',
  fulltext: 'fulltext',
};

/**
 * Builds `CREATE CONSTRAINT` and `CREATE INDEX` statements. Constraint and index names share one
 * namespace in Neo4j, so one writer hands out every name, `<label_snake>_<properties>_<kind>`, and
 * adds a number when two objects would get the same one. Asking twice for the same object, or for an
 * index that a uniqueness or key constraint already backs, returns nothing.
 */
export class StatementWriter {
  private readonly names: NameRegistry = new NameRegistry();
  private readonly created: Set<string> = new Set<string>();

  constructor(readonly style: Neo4jStyle) {}

  /** `REQUIRE ... IS UNIQUE` on one property or, for several, on their combination. */
  unique(target: SchemaTarget, keys: string[]): string | undefined {
    return this.constraint(
      target,
      keys,
      'unique',
      `${this.properties(target, keys)} IS UNIQUE`
    );
  }

  /** `REQUIRE ... IS NODE KEY`: unique and required together (Enterprise Edition). */
  nodeKey(target: SchemaTarget, keys: string[]): string | undefined {
    return this.constraint(
      target,
      keys,
      'key',
      `${this.properties(target, keys)} IS NODE KEY`
    );
  }

  /** `REQUIRE n.prop IS NOT NULL` (Enterprise Edition). */
  required(target: SchemaTarget, key: string): string | undefined {
    return this.constraint(
      target,
      [key],
      'required',
      `${this.properties(target, [key])} IS NOT NULL`
    );
  }

  /** `REQUIRE n.prop IS :: TYPE`, a property type constraint (Enterprise Edition). */
  typed(
    target: SchemaTarget,
    key: string,
    type: Neo4jType
  ): string | undefined {
    return this.constraint(
      target,
      [key],
      'type',
      `${this.properties(target, [key])} IS :: ${type.name}`
    );
  }

  /** A range index; nothing when a uniqueness or key constraint over the same properties already has one. */
  index(target: SchemaTarget, keys: string[]): string | undefined {
    if (
      this.created.has(this.identity('unique', target, keys)) ||
      this.created.has(this.identity('key', target, keys))
    ) {
      return undefined;
    }
    return this.create(
      target,
      keys,
      'index',
      (name: string): string =>
        `CREATE INDEX ${quoteIdentifier(name)} IF NOT EXISTS FOR ${target.pattern} ON (${this.list(target, keys)});`
    );
  }

  fulltext(target: SchemaTarget, keys: string[]): string | undefined {
    return this.create(
      target,
      keys,
      'fulltext',
      (name: string): string =>
        `CREATE FULLTEXT INDEX ${quoteIdentifier(name)} IF NOT EXISTS FOR ${target.pattern} ON EACH [${this.list(target, keys)}];`
    );
  }

  private properties(target: SchemaTarget, keys: string[]): string {
    return keys.length === 1
      ? this.reference(target, keys[0] ?? '')
      : `(${this.list(target, keys)})`;
  }

  private list(target: SchemaTarget, keys: string[]): string {
    return keys.map((key: string) => this.reference(target, key)).join(', ');
  }

  private reference(target: SchemaTarget, key: string): string {
    return `${target.variable}.${quoteIdentifier(key)}`;
  }

  private identity(kind: string, target: SchemaTarget, keys: string[]): string {
    return `${kind}|${target.pattern}|${keys.join('\u0000')}`;
  }

  private constraint(
    target: SchemaTarget,
    keys: string[],
    kind: ConstraintKind,
    requirement: string
  ): string | undefined {
    return this.create(
      target,
      keys,
      kind,
      (name: string): string =>
        `CREATE CONSTRAINT ${quoteIdentifier(name)} IF NOT EXISTS FOR ${target.pattern} REQUIRE ${requirement};`
    );
  }

  private create(
    target: SchemaTarget,
    keys: string[],
    kind: string,
    render: (name: string) => string
  ): string | undefined {
    const identity: string = this.identity(kind, target, keys);
    if (this.created.has(identity)) {
      return undefined;
    }
    this.created.add(identity);
    const words: string = keys.map(nameWords).join('_');
    const name: string = this.names.claim(
      `${target.words}_${words}_${SUFFIXES[kind] ?? kind}`
    );
    return render(name);
  }
}
