import {
  checkStyle,
  err,
  normalizeSchema,
  ok,
  type EmitOutput,
  type FormatAdapter,
  type FormatEmitOutput,
  type FormatOptions,
  type IrSchema,
  type OrmbridgePlugin,
  type OutputStyle,
  type Result,
} from 'ormbridge';
import { emitNeo4j } from './emitters/neo4j.js';
import { emitNeomodel } from './emitters/neomodel.js';
import { emitSdn, isValidJavaPackage } from './emitters/sdn.js';
import { isNeo4jStyle } from './emitters/neo4jTypes.js';

export { emitNeo4j } from './emitters/neo4j.js';
export type { Neo4jEmitOptions } from './emitters/neo4j.js';
export { isNeo4jStyle, NEO4J_STYLES } from './emitters/neo4jTypes.js';
export type { Neo4jStyle } from './emitters/neo4jTypes.js';
export { emitNeomodel } from './emitters/neomodel.js';
export type { NeomodelEmitOptions } from './emitters/neomodel.js';
export { emitSdn } from './emitters/sdn.js';
export type { SdnEmitOptions } from './emitters/sdn.js';

export const neo4jAdapter: FormatAdapter = {
  name: 'neo4j',
  // Output only, and no extension is claimed: ".cypher" is not read by anything here, so pass --to neo4j.
  extensions: [],
  description:
    'Neo4j Cypher schema: node constraints and indexes, relationships as comments (--style enterprise adds Enterprise Edition constraints)',
  emit: (schema: IrSchema, options: FormatOptions): Result<EmitOutput> => {
    if (options.style !== undefined) {
      const checked: Result<OutputStyle> = checkStyle(
        'neo4j',
        String(options.style),
        'style'
      );
      if (!checked.ok) {
        return checked;
      }
    }
    const prepared: IrSchema =
      options.naming === 'normalize' ? normalizeSchema(schema) : schema;
    return ok(
      emitNeo4j(prepared, {
        camelFields: options.naming === 'normalize',
        header: options.header,
        ...(options.style === undefined || !isNeo4jStyle(options.style)
          ? {}
          : { style: options.style }),
      })
    );
  },
};

export const neomodelAdapter: FormatAdapter = {
  name: 'neomodel',
  // Output only, and no extension is claimed: ".py" is too generic to infer, so pass --to neomodel.
  extensions: [],
  description:
    'neomodel classes for Neo4j (Python: StructuredNode, RelationshipTo and RelationshipFrom)',
  emit: (schema: IrSchema, options: FormatOptions): Result<EmitOutput> => {
    const prepared: IrSchema =
      options.naming === 'normalize' ? normalizeSchema(schema) : schema;
    return ok(
      emitNeomodel(prepared, {
        camelFields: options.naming === 'normalize',
        header: options.header,
      })
    );
  },
};

export const sdnAdapter: FormatAdapter = {
  name: 'sdn',
  // Output only, and no extension is claimed: ".java" is too generic to infer, so pass --to sdn.
  extensions: [],
  description:
    'Spring Data Neo4j entities (Java: @Node, @Relationship and @RelationshipProperties, SDN 7 for Spring Boot 3)',
  emit: (
    schema: IrSchema,
    options: FormatOptions
  ): Result<FormatEmitOutput> => {
    const packageName: string | undefined = options.namespace?.replace(
      /^\.+|\.+$/g,
      ''
    );
    if (packageName !== undefined && !isValidJavaPackage(packageName)) {
      return err(
        'INVALID_OPTION',
        `Invalid namespace "${options.namespace ?? ''}" for the sdn format. Expected a Java package name such as app.models (letters, digits and underscores in dot-separated parts, none of them a Java keyword).`
      );
    }
    const prepared: IrSchema =
      options.naming === 'normalize' ? normalizeSchema(schema) : schema;
    return ok(
      emitSdn(prepared, {
        camelFields: options.naming === 'normalize',
        header: options.header,
        ...(packageName === undefined ? {} : { packageName }),
      })
    );
  },
};

const plugin: OrmbridgePlugin = {
  name: 'ormbridge-neo4j',
  formats: [neo4jAdapter, neomodelAdapter, sdnAdapter],
};

export default plugin;
