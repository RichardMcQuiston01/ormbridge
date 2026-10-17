import type { ConstLookup, JavaAnnotation, JavaValue } from './javaSyntax.js';
import { evaluate } from './javaValues.js';

/**
 * Annotation names that exist both in JPA and in Hibernate (`org.hibernate.annotations.Table`, `Check`, ...). A
 * lookup for the JPA one skips an annotation that is written, or imported, from the Hibernate package.
 */
const CLASHING_NAMES: ReadonlySet<string> = new Set([
  'Table',
  'Index',
  'Check',
  'ForeignKey',
  'Type',
  'Filter',
  'Cache',
  'Cascade',
]);

/** The full name of an annotation written as a simple name, from the imports of its file. */
function resolveName(
  annotation: JavaAnnotation,
  imports: readonly string[]
): string | undefined {
  if (annotation.qualifier !== undefined) {
    return `${annotation.qualifier}.${annotation.name}`;
  }
  const exact: string | undefined = imports.find((item: string) =>
    item.endsWith(`.${annotation.name}`)
  );
  return exact;
}

/** Reads the arguments of one annotation as typed values, evaluating constants on demand. */
export class Ann {
  constructor(
    readonly raw: JavaAnnotation,
    private readonly lookup: ConstLookup
  ) {}

  get name(): string {
    return this.raw.name;
  }

  has(key: string): boolean {
    return this.raw.args.has(key);
  }

  value(key: string): JavaValue | undefined {
    const node = this.raw.args.get(key);
    return node === undefined ? undefined : evaluate(node, this.lookup);
  }

  /** The text of a string argument, or undefined when it is absent or not a constant string. */
  string(key: string): string | undefined {
    const value: JavaValue | undefined = this.value(key);
    return value?.kind === 'string' ? value.value : undefined;
  }

  boolean(key: string): boolean | undefined {
    const value: JavaValue | undefined = this.value(key);
    return value?.kind === 'bool' ? value.value : undefined;
  }

  number(key: string): number | undefined {
    const value: JavaValue | undefined = this.value(key);
    return value?.kind === 'number' ? value.value : undefined;
  }

  /** The last segment of an enum constant argument: `GenerationType.IDENTITY` is `IDENTITY`. */
  member(key: string): string | undefined {
    const value: JavaValue | undefined = this.value(key);
    return value?.kind === 'member'
      ? value.path[value.path.length - 1]
      : undefined;
  }

  /** The enum constants of an array (or single) argument, by last segment. */
  members(key: string): string[] {
    return this.items(key).flatMap((item: JavaValue): string[] =>
      item.kind === 'member' ? [item.path[item.path.length - 1] ?? ''] : []
    );
  }

  strings(key: string): string[] {
    return this.items(key).flatMap((item: JavaValue): string[] =>
      item.kind === 'string' ? [item.value] : []
    );
  }

  /** The class named by `Foo.class`. */
  className(key: string): string | undefined {
    const value: JavaValue | undefined = this.value(key);
    return value?.kind === 'class' ? value.type : undefined;
  }

  classNames(key: string): string[] {
    return this.items(key).flatMap((item: JavaValue): string[] =>
      item.kind === 'class' ? [item.type] : []
    );
  }

  /** Nested annotations of an array (or single) argument, such as `uniqueConstraints`. */
  annotations(key: string): Ann[] {
    return this.items(key).flatMap((item: JavaValue): Ann[] =>
      item.kind === 'annotation' ? [new Ann(item.annotation, this.lookup)] : []
    );
  }

  /** The first nested annotation of an argument (`foreignKey = @ForeignKey(...)`). */
  annotation(key: string): Ann | undefined {
    return this.annotations(key)[0];
  }

  private items(key: string): JavaValue[] {
    const value: JavaValue | undefined = this.value(key);
    if (value === undefined) {
      return [];
    }
    return value.kind === 'array' ? value.items : [value];
  }
}

/** The annotations of one class, field or method, looked up by simple name. */
export class Annotated {
  constructor(
    private readonly list: readonly JavaAnnotation[],
    private readonly lookup: ConstLookup,
    private readonly imports: readonly string[] = []
  ) {}

  private matches(annotation: JavaAnnotation, hibernate: boolean): boolean {
    if (!CLASHING_NAMES.has(annotation.name)) {
      return true;
    }
    const full: string | undefined = resolveName(annotation, this.imports);
    const isHibernate: boolean =
      full !== undefined && full.startsWith('org.hibernate.');
    return isHibernate === hibernate;
  }

  /** The first annotation with this simple name. `hibernate` selects the Hibernate one of a clashing name. */
  get(name: string, hibernate: boolean = false): Ann | undefined {
    const found: JavaAnnotation | undefined = this.list.find(
      (annotation: JavaAnnotation) =>
        annotation.name === name && this.matches(annotation, hibernate)
    );
    return found === undefined ? undefined : new Ann(found, this.lookup);
  }

  has(name: string, hibernate: boolean = false): boolean {
    return this.get(name, hibernate) !== undefined;
  }

  /**
   * Every use of a repeatable annotation: written several times, or inside its container
   * (`@JoinColumns({@JoinColumn(...)})`).
   */
  repeated(name: string, container: string): Ann[] {
    const direct: Ann[] = this.list
      .filter((annotation: JavaAnnotation) => annotation.name === name)
      .map((annotation: JavaAnnotation) => new Ann(annotation, this.lookup));
    const nested: Ann[] = this.list
      .filter((annotation: JavaAnnotation) => annotation.name === container)
      .flatMap((annotation: JavaAnnotation) =>
        new Ann(annotation, this.lookup).annotations('value')
      );
    return [...direct, ...nested];
  }

  names(): string[] {
    return this.list.map((annotation: JavaAnnotation) => annotation.name);
  }
}
