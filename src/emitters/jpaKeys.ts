import type { IrField, IrModel, IrRelation } from '../ir.js';
import { Imports, type IdPart, type JpaStyle } from './jpaTypes.js';

/** Finds the primary key of a model and writes the `@IdClass` class of a composite one. */

export type KeyPart =
  | { kind: 'field'; field: IrField }
  | { kind: 'relation'; relation: IrRelation };

export interface KeyInfo {
  /** The columns of the primary key, in key order. */
  parts: KeyPart[];
  /** True when the model has no key and one column was chosen to be the identifier. */
  synthesized: boolean;
}

function findField(model: IrModel, name: string): IrField | undefined {
  return (
    model.fields.find((field: IrField) => field.name === name) ??
    model.fields.find((field: IrField) => field.columnName === name)
  );
}

function findRelation(model: IrModel, name: string): IrRelation | undefined {
  return model.relations.find(
    (relation: IrRelation) =>
      relation.kind !== 'manyToMany' &&
      (relation.name === name || relation.columnName === name)
  );
}

/** Column types that make a poor identifier: large or approximate values. */
const POOR_KEYS: ReadonlySet<string> = new Set([
  'text',
  'json',
  'bytes',
  'float',
  'boolean',
  'hstore',
  'range',
  'unsupported',
]);

/** The column to use as the identifier of a model that has no key: the first required column of a sensible type. */
export function identifierCandidate(model: IrModel): IrField | undefined {
  const required: IrField[] = model.fields.filter(
    (field: IrField) => !field.isNullable && field.arrayDepth === undefined
  );
  return (
    required.find((field: IrField) => !POOR_KEYS.has(field.type)) ??
    required[0] ??
    model.fields[0]
  );
}

/** The primary key of a model; `warn` is told about names it cannot resolve and about a missing key. */
export function keyOf(
  model: IrModel,
  warn: (message: string) => void
): KeyInfo {
  const parts: KeyPart[] = [];
  if (model.compositePrimaryKey !== undefined) {
    for (const name of model.compositePrimaryKey) {
      const field: IrField | undefined = findField(model, name);
      const relation: IrRelation | undefined =
        field === undefined ? findRelation(model, name) : undefined;
      if (field !== undefined) {
        parts.push({ kind: 'field', field });
      } else if (relation !== undefined) {
        parts.push({ kind: 'relation', relation });
      } else {
        warn(
          `${model.name}: the primary key column "${name}" is neither a field nor a relation of the model, so it was left out of the key.`
        );
      }
    }
  } else {
    for (const field of model.fields) {
      if (field.isPrimaryKey) {
        parts.push({ kind: 'field', field });
      }
    }
    for (const relation of model.relations) {
      if (relation.kind !== 'manyToMany' && relation.isPrimaryKey === true) {
        parts.push({ kind: 'relation', relation });
      }
    }
  }
  if (parts.length > 0) {
    return { parts, synthesized: false };
  }
  const chosen: IrField | undefined = identifierCandidate(model);
  if (chosen === undefined) {
    return { parts, synthesized: false };
  }
  warn(
    `${model.name}: ${model.isView === true ? 'a database view' : 'the table'} has no primary key, but a JPA entity needs an identifier; the column "${chosen.columnName}" was written as the @Id (Hibernate would create a primary key on it).`
  );
  return { parts: [{ kind: 'field', field: chosen }], synthesized: true };
}

/** The text of an `@IdClass` file body: fields, constructors, `equals` and `hashCode`. */
export function renderIdClass(
  name: string,
  parts: readonly IdPart[],
  style: JpaStyle
): { imports: Imports; lines: string[] } {
  const imports: Imports = new Imports(style);
  imports.use('java.io.Serializable');
  imports.use('java.util.Objects');
  for (const part of parts) {
    imports.merge(part.imports);
  }
  const lines: string[] = [
    `public class ${name} implements Serializable {`,
    '  private static final long serialVersionUID = 1L;',
    '',
    ...parts.map((part: IdPart) => `  private ${part.type} ${part.name};`),
    '',
    `  public ${name}() {}`,
    '',
    `  public ${name}(${parts.map((part: IdPart) => `${part.type} ${part.name}`).join(', ')}) {`,
    ...parts.map((part: IdPart) => `    this.${part.name} = ${part.name};`),
    '  }',
    '',
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
    '}',
  ];
  return { imports, lines };
}
