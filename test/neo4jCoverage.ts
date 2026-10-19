import type {
  IrEnum,
  IrField,
  IrModel,
  IrRelation,
  IrSchema,
} from '../src/ir.js';
import { relationshipTypeOf } from '../src/emitters/neo4jNames.js';

function escapePattern(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The text of the node section of a model (sections are separated by a blank line), if it has one. */
function nodeSection(text: string, model: IrModel): string | undefined {
  const opening: RegExp = new RegExp(
    `^// :\\S+ \\(model ${escapePattern(model.name)}, table `,
    'm'
  );
  const match: RegExpExecArray | null = opening.exec(text);
  if (match === null) {
    return undefined;
  }
  const end: number = text.indexOf('\n\n', match.index);
  return text.slice(match.index, end === -1 ? text.length : end);
}

function hasProperty(section: string, key: string): boolean {
  return (
    section.includes(`\n//   ${key}: `) ||
    section.includes('\n//   `' + key + '`: ')
  );
}

function checkRelation(
  text: string,
  model: IrModel,
  relation: IrRelation,
  section: string
): string[] {
  if (relation.kind === 'manyToMany') {
    // The pair is written once, from either side.
    const types: string[] = [
      relation.name,
      relation.relatedName ?? relation.name,
    ].map(relationshipTypeOf);
    return types.some((type: string) => text.includes(`-[:${type}]->`))
      ? []
      : [`${model.name}.${relation.name}: no ${types[0]} relationship`];
  }
  const problems: string[] = [];
  if (!hasProperty(section, relation.columnName)) {
    problems.push(
      `${model.name}.${relation.name}: no ${relation.columnName} property`
    );
  }
  if (!text.includes(`-[:${relationshipTypeOf(relation.name)}]->`)) {
    problems.push(
      `${model.name}.${relation.name}: no ${relationshipTypeOf(relation.name)} relationship`
    );
  }
  return problems;
}

/**
 * A structural check of Neo4j output against the IR it came from. Neo4j has no reader, so the
 * conversion matrix cannot compare IRs; this lists what is missing instead: a model without a node
 * section (or, for a join table, without its relationship), a column or foreign key without a
 * property line, a relation without its relationship comment, a model with a primary key and no
 * uniqueness constraint, and an enum value missing from the property comments. An empty result means
 * the output covers the IR. It assumes the "preserve" naming mode.
 */
export function checkNeo4jOutput(
  schema: IrSchema,
  files: Record<string, string>
): string[] {
  const text: string = Object.values(files).join('\n');
  const missing: string[] = [];
  for (const model of schema.models) {
    const section: string | undefined = nodeSection(text, model);
    if (section === undefined) {
      if (!text.includes(`(model ${model.name})`)) {
        missing.push(`${model.name}: no node label and no join relationship`);
      }
      continue;
    }
    for (const field of model.fields) {
      if (!hasProperty(section, field.columnName)) {
        missing.push(
          `${model.name}.${field.name}: no ${field.columnName} property`
        );
      }
    }
    for (const relation of model.relations) {
      missing.push(...checkRelation(text, model, relation, section));
    }
    const keyed: boolean =
      model.fields.some((field: IrField) => field.isPrimaryKey) ||
      (model.compositePrimaryKey ?? []).length > 0;
    if (
      keyed &&
      !/\bCREATE CONSTRAINT \S+ IF NOT EXISTS FOR \(n:\S+\) REQUIRE/.test(
        section
      )
    ) {
      missing.push(`${model.name}: no constraint for the primary key`);
    }
  }
  for (const enumDefinition of schema.enums) {
    const used: boolean = schema.models.some((model: IrModel) =>
      model.fields.some(
        (field: IrField) => field.enumName === enumDefinition.name
      )
    );
    if (!used) {
      continue;
    }
    for (const value of (enumDefinition as IrEnum).values) {
      if (!text.includes(`"${value.dbValue}"`)) {
        missing.push(
          `enum ${enumDefinition.name}: the value ${value.dbValue} is not in a property comment`
        );
      }
    }
  }
  return missing;
}
