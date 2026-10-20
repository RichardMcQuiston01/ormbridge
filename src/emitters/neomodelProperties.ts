import type { IrEnum, IrEnumValue, IrField, IrSchema } from '../ir.js';
import type { GraphProperty } from './neo4jGraph.js';
import { oneLine } from './neo4jNames.js';
import { mapFieldType, type Neo4jType } from './neo4jTypes.js';
import { pyString } from './neomodelNames.js';

/** Turns one graph property into a neomodel property class call such as `StringProperty(required=True)`. */

/** The imports the generated module needs, collected while the classes are planned. */
export class ModuleImports {
  /** Names imported from `neomodel`. */
  readonly neomodel: Set<string> = new Set<string>();
  /** `from datetime import date` (the default of a date column). */
  usesDate: boolean = false;
  /** Names imported from `datetime` for the default of a date and time column. */
  readonly datetime: Set<string> = new Set<string>();
  /** `from uuid import uuid4` (the default of a UUID column). */
  usesUuid: boolean = false;

  /** Records a name of `neomodel` and returns it. */
  use(name: string): string {
    this.neomodel.add(name);
    return name;
  }
}

/** Which indexes and constraints a property takes part in. */
export interface PropertyRole {
  unique: boolean;
  index: boolean;
  fulltext: boolean;
}

/** A property class and its arguments, ready to be laid out. */
export interface PropertyCall {
  className: string;
  args: string[];
}

export interface PropertyContext {
  schema: IrSchema;
  imports: ModuleImports;
  warnings: string[];
}

export interface PropertyInput {
  /** `Model.field`, for warnings. */
  label: string;
  property: GraphProperty;
  /** The IR field behind the property; undefined for a foreign key column. */
  field: IrField | undefined;
  role: PropertyRole;
  /** The attribute name in the class; `db_property` is written when it differs from the key. */
  attribute: string;
  /** True for the single UUID key of a node, which `UniqueIdProperty` can generate. */
  uniqueId: boolean;
}

/** The property class for a Neo4j type, plus the note about what neomodel stores instead. */
function classFor(
  type: Neo4jType,
  context: PropertyContext,
  label: string
): string {
  const { imports } = context;
  switch (type.name) {
    case 'INTEGER':
      return imports.use('IntegerProperty');
    case 'FLOAT':
      return imports.use('FloatProperty');
    case 'BOOLEAN':
      return imports.use('BooleanProperty');
    case 'DATE':
      return imports.use('DateProperty');
    case 'ZONED DATETIME':
    case 'LOCAL DATETIME':
      return imports.use('DateTimeNeo4jFormatProperty');
    case 'LOCAL TIME':
    case 'ZONED TIME':
      context.warnings.push(
        `${label}: neomodel has no time property; the value is stored as an ISO 8601 text in a StringProperty.`
      );
      return imports.use('StringProperty');
    case 'DURATION':
      context.warnings.push(
        `${label}: neomodel has no duration property; the value is stored as an ISO 8601 text in a StringProperty.`
      );
      return imports.use('StringProperty');
    case 'BYTE ARRAY':
      context.warnings.push(
        `${label}: neomodel has no binary property; the value is stored as base64 text in a StringProperty.`
      );
      return imports.use('StringProperty');
    default:
      return imports.use('StringProperty');
  }
}

function enumOf(field: IrField, schema: IrSchema): IrEnum | undefined {
  return field.enumName === undefined
    ? undefined
    : schema.enums.find(
        (candidate: IrEnum) => candidate.name === field.enumName
      );
}

/** `{"draft": "DRAFT", ...}`: the stored value and the name of the member. */
function choices(definition: IrEnum): string {
  const items: string[] = definition.values.map(
    (value: IrEnumValue) =>
      `${pyString(value.dbValue)}: ${pyString(value.name)}`
  );
  return `{${items.join(', ')}}`;
}

/** The text of a call, `Name(arg, arg)`. */
export function callText(call: PropertyCall): string {
  return `${call.className}(${call.args.join(', ')})`;
}

/** The base property of a field (the element property for an array). */
function baseCall(
  context: PropertyContext,
  label: string,
  field: IrField | undefined,
  type: Neo4jType
): PropertyCall {
  if (field !== undefined && field.type === 'json') {
    return { className: context.imports.use('JSONProperty'), args: [] };
  }
  const className: string = classFor(type, context, label);
  const args: string[] = [];
  if (className === 'StringProperty' && field !== undefined) {
    const definition: IrEnum | undefined = enumOf(field, context.schema);
    if (definition !== undefined && type.name === 'STRING') {
      args.push(`choices=${choices(definition)}`);
    } else if (field.maxLength !== undefined && field.type === 'string') {
      args.push(`max_length=${field.maxLength}`);
    }
  }
  if (
    field !== undefined &&
    enumOf(field, context.schema) !== undefined &&
    type.name !== 'STRING'
  ) {
    context.warnings.push(
      `${label}: neomodel cannot restrict ${className} to the values of enum ${field.enumName ?? ''}; the values are not checked.`
    );
  }
  return { className, args };
}

/** The Python text of a default, or undefined (with a warning) when neomodel cannot hold it. */
function defaultArgs(
  context: PropertyContext,
  label: string,
  field: IrField,
  base: PropertyCall,
  isArray: boolean
): string[] | undefined {
  const value: IrField['default'] =
    field.default ??
    // A timestamp refreshed on every save starts as the time of the first save.
    (field.isAutoUpdated &&
    (base.className === 'DateTimeNeo4jFormatProperty' ||
      base.className === 'DateProperty')
      ? { kind: 'now' }
      : undefined);
  if (value === undefined || value.kind === 'autoIncrement') {
    if (value !== undefined) {
      context.warnings.push(
        `${label}: auto-increment has no neomodel equivalent; supply the value yourself (a UUID key with UniqueIdProperty needs none).`
      );
    }
    return undefined;
  }
  const drop = (what: string): undefined => {
    context.warnings.push(
      `${label}: ${what} has no neomodel equivalent and was dropped; set the value when you create the node.`
    );
    return undefined;
  };
  if (isArray) {
    return drop('the default of an array');
  }
  switch (value.kind) {
    case 'literal':
      return literalArgs(value.value, base.className, drop);
    case 'now':
      if (base.className === 'DateTimeNeo4jFormatProperty') {
        // DateTimeNeo4jFormatProperty(default_now=True) would fix the time when the module is imported.
        if (mapFieldType(field).type.name === 'LOCAL DATETIME') {
          context.imports.datetime.add('datetime');
          return ['default=datetime.now'];
        }
        context.imports.datetime.add('datetime').add('timezone');
        return ['default=lambda: datetime.now(timezone.utc)'];
      }
      if (base.className === 'DateProperty') {
        context.imports.usesDate = true;
        return ['default=date.today'];
      }
      return drop('the default of the current time');
    case 'uuid':
      if (base.className === 'StringProperty') {
        context.imports.usesUuid = true;
        return ['default=lambda: str(uuid4())'];
      }
      return drop('the default of a generated UUID');
    case 'enumValue': {
      const definition: IrEnum | undefined = enumOf(field, context.schema);
      const member: IrEnumValue | undefined = definition?.values.find(
        (candidate: IrEnumValue) => candidate.name === value.value
      );
      return base.className === 'StringProperty'
        ? [`default=${pyString(member?.dbValue ?? value.value)}`]
        : drop(`the default "${value.value}"`);
    }
    case 'clientGenerated':
      return drop(`the ${value.generator}() default`);
    case 'dbExpression':
      return drop(`the database default ${oneLine(value.expression)}`);
  }
}

function literalArgs(
  value: string | number | boolean,
  className: string,
  drop: (what: string) => undefined
): string[] | undefined {
  const fits: boolean =
    (className === 'StringProperty' && typeof value !== 'boolean') ||
    (className === 'IntegerProperty' &&
      typeof value === 'number' &&
      Number.isInteger(value)) ||
    (className === 'FloatProperty' &&
      typeof value === 'number' &&
      Number.isFinite(value)) ||
    (className === 'BooleanProperty' && typeof value === 'boolean');
  if (!fits) {
    return drop(`the default ${JSON.stringify(value)}`);
  }
  if (typeof value === 'boolean') {
    return [`default=${value ? 'True' : 'False'}`];
  }
  if (className === 'StringProperty') {
    return [`default=${pyString(String(value))}`];
  }
  const text: string = String(value);
  return [
    `default=${className === 'FloatProperty' && /^-?\d+$/.test(text) ? `${text}.0` : text}`,
  ];
}

/** Plans the property class and arguments of one graph property. */
export function planProperty(
  context: PropertyContext,
  input: PropertyInput
): PropertyCall {
  const { label, property, field, role, attribute } = input;
  const dbProperty: string[] =
    attribute === property.key ? [] : [`db_property=${pyString(property.key)}`];
  if (input.uniqueId) {
    return {
      className: context.imports.use('UniqueIdProperty'),
      args: dbProperty,
    };
  }
  const isArray: boolean = property.type.name.startsWith('LIST<');
  let call: PropertyCall;
  if (isArray && field !== undefined) {
    const element: Neo4jType = mapFieldType({
      ...field,
      arrayDepth: undefined,
    }).type;
    const base: PropertyCall = baseCall(context, label, field, element);
    call = {
      className: context.imports.use('ArrayProperty'),
      args: [callText(base)],
    };
  } else {
    call = baseCall(context, label, field, property.type);
  }
  const flags: string[] = [];
  if (role.unique) {
    flags.push('unique_index=True');
  } else if (role.index) {
    flags.push('index=True');
  }
  if (role.fulltext) {
    if (call.className === 'StringProperty') {
      flags.push(`fulltext_index=${context.imports.use('FulltextIndex')}()`);
    } else {
      context.warnings.push(
        `${label}: a full-text index needs a string property, so it was dropped.`
      );
    }
  }
  const defaults: string[] =
    field === undefined
      ? []
      : (defaultArgs(context, label, field, call, isArray) ?? []);
  const hasDefault: boolean = defaults.length > 0;
  const required: string[] =
    property.required && !hasDefault ? ['required=True'] : [];
  return {
    className: call.className,
    args: [...call.args, ...flags, ...required, ...defaults, ...dbProperty],
  };
}
