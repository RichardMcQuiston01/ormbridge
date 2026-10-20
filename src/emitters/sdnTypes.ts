import type { IrField, IrScalarType } from '../ir.js';
import { mapFieldType, type Neo4jType } from './neo4jTypes.js';
import type { Imports } from './jpaTypes.js';

/** The Java types of the Spring Data Neo4j writer, chosen from the Neo4j type the Cypher writer documents. */

const RESERVED_SDN_TYPES: readonly string[] = [
  'ArrayList',
  'Boolean',
  'ConvertWith',
  'Double',
  'Duration',
  'GeneratedValue',
  'Id',
  'Integer',
  'List',
  'LocalDate',
  'LocalDateTime',
  'LocalTime',
  'Long',
  'Neo4jPersistentPropertyConverter',
  'Node',
  'OffsetTime',
  'Override',
  'Property',
  'Relationship',
  'RelationshipId',
  'RelationshipProperties',
  'String',
  'TargetNode',
  'UUID',
  'UUIDStringGenerator',
  'Value',
  'Values',
  'ZonedDateTime',
];

export { RESERVED_SDN_TYPES };

/** The Java type of one Neo4j scalar, as written in the source (imports are recorded). */
function scalarJavaType(
  type: Neo4jType,
  field: IrField,
  imports: Imports
): string {
  const scalar: IrScalarType = field.type;
  switch (type.name) {
    case 'INTEGER':
      return scalar === 'bigInt' ? 'Long' : 'Integer';
    case 'FLOAT':
      return 'Double';
    case 'BOOLEAN':
      return 'Boolean';
    case 'DATE':
      return imports.use('java.time.LocalDate');
    case 'ZONED DATETIME':
      return imports.use('java.time.ZonedDateTime');
    case 'LOCAL DATETIME':
      return imports.use('java.time.LocalDateTime');
    case 'LOCAL TIME':
      return imports.use('java.time.LocalTime');
    case 'ZONED TIME':
      return imports.use('java.time.OffsetTime');
    case 'DURATION':
      return imports.use('java.time.Duration');
    case 'BYTE ARRAY':
      return 'byte[]';
    default:
      // STRING: text, UUID (converted by Spring Data Neo4j), decimal (BigDecimal is stored as a string), the rest.
      if (scalar === 'uuid') {
        return imports.use('java.util.UUID');
      }
      if (scalar === 'decimal') {
        return imports.use('java.math.BigDecimal');
      }
      return 'String';
  }
}

/** The Java type of a field: the scalar, or `List<scalar>` for a one-dimensional array. */
export function javaTypeOf(field: IrField, imports: Imports): string {
  const mapped: Neo4jType = mapFieldType(field).type;
  if (!mapped.name.startsWith('LIST<')) {
    return scalarJavaType(mapped, field, imports);
  }
  const element: Neo4jType = mapFieldType({
    ...field,
    arrayDepth: undefined,
  }).type;
  return `${imports.use('java.util.List')}<${scalarJavaType(element, field, imports)}>`;
}
