import { accessorLines, attributeLines } from './jpaRender.js';
import {
  Imports,
  type Attribute,
  type IdPart,
  type JpaStyle,
} from './jpaTypes.js';

/** Writes the key class of a composite primary key: the `@IdClass` class or the `@Embeddable` class of an `@EmbeddedId`. */

export interface KeyClassOptions {
  /** True for the `@Embeddable` class of an `@EmbeddedId`; false for the plain class of an `@IdClass`. */
  embeddable: boolean;
  /** Write Lombok annotations in place of the constructors, accessors, `equals` and `hashCode`. */
  lombok: boolean;
}

const INDENT: string = '  ';

function equalsAndHashCode(name: string, parts: readonly IdPart[]): string[] {
  return [
    '  @Override',
    '  public boolean equals(Object other) {',
    '    if (this == other) {',
    '      return true;',
    '    }',
    `    if (!(other instanceof ${name})) {`,
    '      return false;',
    '    }',
    `    ${name} that = (${name}) other;`,
    `    return ${parts
      .map((part: IdPart) => `Objects.equals(${part.name}, that.${part.name})`)
      .join(' && ')};`,
    '  }',
    '',
    '  @Override',
    '  public int hashCode() {',
    `    return Objects.hash(${parts.map((part: IdPart) => part.name).join(', ')});`,
    '  }',
  ];
}

/**
 * The text of a key class file body: fields, constructors, `equals` and `hashCode`. The `@IdClass` class has
 * plain fields; the `@Embeddable` class of an `@EmbeddedId` also carries the column annotations and the accessors.
 * With Lombok the annotations `@NoArgsConstructor`, `@AllArgsConstructor` and `@EqualsAndHashCode` (and, for the
 * embeddable, `@Getter` and `@Setter`) replace the methods.
 */
export function renderKeyClass(
  name: string,
  parts: readonly IdPart[],
  style: JpaStyle,
  options: KeyClassOptions = { embeddable: false, lombok: false }
): { imports: Imports; lines: string[] } {
  const imports: Imports = new Imports(style);
  imports.use('java.io.Serializable');
  for (const part of parts) {
    imports.merge(part.imports);
  }
  const header: string[] = [];
  if (options.embeddable) {
    header.push(`@${imports.persistence('Embeddable')}`);
  }
  if (options.lombok) {
    const names: string[] = options.embeddable
      ? ['Getter', 'Setter', 'NoArgsConstructor', 'AllArgsConstructor']
      : ['NoArgsConstructor', 'AllArgsConstructor'];
    for (const lombokName of [...names, 'EqualsAndHashCode']) {
      header.push(`@${imports.use(`lombok.${lombokName}`)}`);
    }
  } else {
    imports.use('java.util.Objects');
  }
  const attributes: Attribute[] = parts.map((part: IdPart): Attribute => ({
    name: part.name,
    type: part.type,
    annotations: part.annotations ?? [],
    imports: part.imports,
  }));
  const fields: string[] = options.embeddable
    ? attributes.flatMap((attribute: Attribute, position: number): string[] => [
        ...(position > 0 ? [''] : []),
        ...attributeLines(attribute),
      ])
    : parts.map(
        (part: IdPart) => `${INDENT}private ${part.type} ${part.name};`
      );
  const lines: string[] = [
    ...header,
    `public class ${name} implements Serializable {`,
    '  private static final long serialVersionUID = 1L;',
    '',
    ...fields,
  ];
  if (!options.lombok) {
    lines.push(
      '',
      `  public ${name}() {}`,
      '',
      `  public ${name}(${parts.map((part: IdPart) => `${part.type} ${part.name}`).join(', ')}) {`,
      ...parts.map((part: IdPart) => `    this.${part.name} = ${part.name};`),
      '  }'
    );
    if (options.embeddable) {
      for (const attribute of attributes) {
        lines.push('', ...accessorLines(attribute));
      }
    }
    lines.push('', ...equalsAndHashCode(name, parts));
  }
  lines.push('}');
  if (options.embeddable) {
    // The attributes were built for the entity and brought imports (@Id, generators) that this class does not use.
    imports.prune(lines.join('\n'));
  }
  return { imports, lines };
}
