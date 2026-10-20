import type { IrEnum, IrField, IrSchema } from '../src/ir.js';
import { collectEdges } from '../src/emitters/neo4jEdges.js';
import {
  buildGraph,
  primaryKeyNamesOf,
  type Graph,
  type GraphNode,
} from '../src/emitters/neo4jGraph.js';
import { attributeNameOf } from '../src/emitters/jpaNames.js';

function escapePattern(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The Java file that declares `@Node("label")`. */
function nodeFile(
  files: Record<string, string>,
  node: GraphNode
): string | undefined {
  return Object.values(files).find((text: string) =>
    text.includes(`@Node(${JSON.stringify(node.label)})`)
  );
}

function hasProperty(text: string, key: string): boolean {
  const name: string = attributeNameOf(key);
  return (
    text.includes(`@Property(${JSON.stringify(key)})`) ||
    new RegExp(
      `^ {2}private [^;=]+ ${escapePattern(name)}\\d*(?: =[^;]*)?;$`,
      'm'
    ).test(text)
  );
}

/**
 * A structural check of Spring Data Neo4j output against the IR it came from. The format has no reader, so the
 * conversion matrix cannot compare IRs; this lists what is missing instead: a model without an `@Node` class, a
 * column or foreign key without a field, a class without an `@Id`, a relation without its `@Relationship` on both
 * classes (type and direction), the columns of a join table without a `@RelationshipProperties` class, and an enum
 * constant that is missing. An empty result means the output covers the IR. It assumes the "preserve" naming mode.
 */
export function checkSdnOutput(
  schema: IrSchema,
  files: Record<string, string>
): string[] {
  const all: string = Object.values(files).join('\n');
  const graph: Graph = buildGraph(schema, { camelFields: false }, []);
  const missing: string[] = [];
  for (const node of graph.nodes) {
    const text: string | undefined = nodeFile(files, node);
    if (text === undefined) {
      missing.push(
        `${node.model.name}: no @Node class for the label ${node.label}`
      );
      continue;
    }
    if (!/^ {2}@Id$/m.test(text)) {
      missing.push(`${node.model.name}: no @Id`);
    }
    const keyNames: string[] = primaryKeyNamesOf(node.model);
    for (const property of node.properties) {
      const generated: boolean =
        keyNames.length === 1 &&
        node.keys.get(keyNames[0] ?? '') === property.key &&
        text.includes('@GeneratedValue') &&
        /@Id\n\s+@GeneratedValue\n\s+private Long /.test(text);
      if (!generated && !hasProperty(text, property.key)) {
        missing.push(
          `${node.model.name}.${property.irName}: no ${property.key} field`
        );
      }
    }
  }
  for (const edge of collectEdges(schema, graph, [])) {
    const source: string | undefined = nodeFile(files, edge.source);
    const target: string | undefined = nodeFile(files, edge.target);
    const pattern = (direction: string): RegExp =>
      new RegExp(
        `@Relationship\\(type = ${escapePattern(JSON.stringify(edge.type))}, direction = Relationship\\.Direction\\.${direction}\\)`
      );
    if (source === undefined || !pattern('OUTGOING').test(source)) {
      missing.push(
        `${edge.source.model.name}.${edge.name}: no OUTGOING ${edge.type} relationship`
      );
    }
    if (target === undefined || !pattern('INCOMING').test(target)) {
      missing.push(
        `${edge.target.model.name}: no INCOMING ${edge.type} relationship`
      );
    }
    if (edge.join !== undefined && edge.properties.length > 0) {
      const classes: string[] = Object.values(files).filter((text: string) =>
        text.includes('@RelationshipProperties')
      );
      for (const property of edge.properties) {
        if (!classes.some((text: string) => hasProperty(text, property.key))) {
          missing.push(
            `${edge.join.model.name}.${property.irName}: no ${property.key} relationship property`
          );
        }
      }
    }
  }
  for (const enumDefinition of schema.enums) {
    const used: boolean = schema.models.some((model) =>
      model.fields.some(
        (field: IrField) => field.enumName === enumDefinition.name
      )
    );
    if (!used) {
      continue;
    }
    for (const value of (enumDefinition as IrEnum).values) {
      const stored: boolean = all.includes(JSON.stringify(value.dbValue));
      const constant: boolean = new RegExp(
        `^ {2}${escapePattern(value.name)}\\b`,
        'm'
      ).test(all);
      if (!stored && !constant) {
        missing.push(
          `enum ${enumDefinition.name}: the value ${value.dbValue} is not in an enum file`
        );
      }
    }
  }
  return missing;
}
