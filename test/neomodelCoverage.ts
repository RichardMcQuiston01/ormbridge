import type { IrEnum, IrField, IrSchema } from '../src/ir.js';
import { collectEdges } from '../src/emitters/neo4jEdges.js';
import {
  buildGraph,
  primaryKeyNamesOf,
  type Graph,
  type GraphNode,
  type GraphProperty,
} from '../src/emitters/neo4jGraph.js';
import { labelOf } from '../src/emitters/neo4jNames.js';
import { attributeNameOf, classNameOf } from '../src/emitters/neomodelNames.js';

function escapePattern(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The module split into class bodies, by class name. */
function classBlocks(text: string): Map<string, string> {
  const blocks: Map<string, string> = new Map<string, string>();
  const heads: RegExpMatchArray[] = [
    ...text.matchAll(/^class (\w+)\(\w+\):$/gm),
  ];
  heads.forEach((head: RegExpMatchArray, position: number): void => {
    const start: number = head.index ?? 0;
    const end: number = heads[position + 1]?.index ?? text.length;
    blocks.set(head[1] ?? '', text.slice(start, end));
  });
  return blocks;
}

function hasProperty(block: string, key: string): boolean {
  const attribute: string = attributeNameOf(key);
  return (
    block.includes(`db_property=${JSON.stringify(key)}`) ||
    new RegExp(`^ {4}${escapePattern(attribute)}(?:_\\d+)? = `, 'm').test(block)
  );
}

function nodeBlock(
  blocks: Map<string, string>,
  node: GraphNode
): string | undefined {
  const named: string | undefined = blocks.get(classNameOf(node.label));
  if (named !== undefined && !named.includes('__label__')) {
    return named;
  }
  return [...blocks.values()].find((block: string) =>
    block.includes(`__label__ = ${JSON.stringify(node.label)}`)
  );
}

/**
 * A structural check of neomodel output against the IR it came from. neomodel has no reader, so the
 * conversion matrix cannot compare IRs; this lists what is missing instead: a model without a node class (or,
 * for a join table, without its relationship), a column or foreign key without a property line, a relation
 * without its `RelationshipTo` and `RelationshipFrom`, a join table's extra columns without a relationship
 * class, a primary key without a unique (or, for a composite key, an index) flag, and an enum value missing
 * from the choices. An empty result means the output covers the IR. It assumes the "preserve" naming mode.
 */
export function checkNeomodelOutput(
  schema: IrSchema,
  files: Record<string, string>
): string[] {
  const text: string = Object.values(files).join('\n');
  const blocks: Map<string, string> = classBlocks(text);
  const graph: Graph = buildGraph(schema, { camelFields: false }, []);
  const missing: string[] = [];
  for (const node of graph.nodes) {
    const block: string | undefined = nodeBlock(blocks, node);
    if (block === undefined) {
      missing.push(`${node.model.name}: no class for the label ${node.label}`);
      continue;
    }
    for (const property of node.properties) {
      if (!hasProperty(block, property.key)) {
        missing.push(
          `${node.model.name}.${property.irName}: no ${property.key} property`
        );
      }
    }
    const keyNames: string[] = primaryKeyNamesOf(node.model);
    if (
      keyNames.length === 1 &&
      !/unique_index=True|UniqueIdProperty/.test(block)
    ) {
      missing.push(`${node.model.name}: the primary key is not unique`);
    } else if (keyNames.length > 1 && !block.includes('index=True')) {
      missing.push(
        `${node.model.name}: the composite primary key has no index`
      );
    }
  }
  const edges = collectEdges(schema, graph, []);
  for (const edge of edges) {
    const source: string | undefined = nodeBlock(blocks, edge.source);
    const target: string | undefined = nodeBlock(blocks, edge.target);
    const to = new RegExp(
      `RelationshipTo\\(\\s*"\\w+",\\s*${escapePattern(JSON.stringify(edge.type))}`
    );
    const from = new RegExp(
      `RelationshipFrom\\(\\s*"\\w+",\\s*${escapePattern(JSON.stringify(edge.type))}`
    );
    if (source === undefined || !to.test(source)) {
      missing.push(
        `${edge.source.model.name}.${edge.name}: no RelationshipTo for ${edge.type}`
      );
    }
    if (target === undefined || !from.test(target)) {
      missing.push(
        `${edge.target.model.name}: no RelationshipFrom for ${edge.type}`
      );
    }
    if (edge.join !== undefined && edge.properties.length > 0) {
      const base: string = `${classNameOf(labelOf(edge.join.model.name))}Rel`;
      const block: string | undefined = [...blocks.entries()].find(([name]) =>
        new RegExp(`^${escapePattern(base)}\\d*$`).test(name)
      )?.[1];
      for (const property of edge.properties as GraphProperty[]) {
        if (block === undefined || !hasProperty(block, property.key)) {
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
      if (!text.includes(JSON.stringify(value.dbValue))) {
        missing.push(
          `enum ${enumDefinition.name}: the value ${value.dbValue} is not in the choices`
        );
      }
    }
  }
  return missing;
}
