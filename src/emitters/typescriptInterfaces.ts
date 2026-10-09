import { prismaOnlyWarnings } from '../prismaOnlyConstructs.js';
import type {
  IrEnum,
  IrEnumValue,
  IrField,
  IrModel,
  IrRelation,
  IrSchema,
} from '../ir.js';
import { findModel } from '../ir.js';
import { toCamelCase, toSnakeCase } from '../naming.js';
import type { EmitOutput } from './prisma.js';

/**
 * How date and date-time columns are typed. `string` (the default) matches JSON
 * sent over the wire (ISO 8601 text); `date` types them as `Date` for code that
 * revives the values after parsing.
 */
export type TypescriptDateMode = 'string' | 'date';

export interface TypescriptInterfacesOptions {
  /** Use camelCase property names (the `normalize` naming mode). */
  camelFields: boolean;
  /** Type used for DateTime and Date columns. Defaults to "string". */
  dates?: TypescriptDateMode;
}

interface ModelNames {
  fields: Map<string, string>;
  relations: Map<string, string>;
  /** Foreign-key scalar property per relation (absent when a field already provides it). */
  scalars: Map<string, string>;
  used: Set<string>;
}

interface Member {
  name: string;
  type: string;
  optional: boolean;
}

interface EmitContext {
  schema: IrSchema;
  options: TypescriptInterfacesOptions;
  dates: TypescriptDateMode;
  warnings: string[];
  names: Map<string, ModelNames>;
  /** "Model.relation" -> property name of the reverse side on the target model. */
  inverseNames: Map<string, string>;
  /** Interface and enum names that were actually written (after sanitizing). */
  typeNames: Map<string, string>;
}

const IDENTIFIER_PATTERN: RegExp = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const MAX_KEY_DEPTH: number = 5;

export function emitTypescriptInterfaces(
  schema: IrSchema,
  options: TypescriptInterfacesOptions
): EmitOutput {
  const context: EmitContext = {
    schema,
    options,
    dates: options.dates ?? 'string',
    warnings: prismaOnlyWarnings(schema),
    names: new Map<string, ModelNames>(),
    inverseNames: new Map<string, string>(),
    typeNames: new Map<string, string>(),
  };

  allocateTypeNames(context);
  allocateMemberNames(context);

  const reverseMembers: Map<string, Member[]> = new Map<string, Member[]>();
  const forwardMembers: Map<string, Member[]> = new Map<string, Member[]>();
  for (const model of schema.models) {
    forwardMembers.set(
      model.name,
      buildForwardMembers(context, model, reverseMembers)
    );
  }

  const blocks: string[] = [];
  for (const enumDefinition of schema.enums) {
    blocks.push(emitEnum(context, enumDefinition));
  }
  for (const model of schema.models) {
    const members: Member[] = [
      ...(forwardMembers.get(model.name) ?? []),
      ...(reverseMembers.get(model.name) ?? []),
    ];
    blocks.push(emitInterface(context, model, members));
  }

  if (blocks.length === 0) {
    return { text: '', warnings: context.warnings };
  }
  return { text: `${blocks.join('\n\n')}\n`, warnings: context.warnings };
}

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

function quote(value: string): string {
  const escaped: string = value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n');
  return `'${escaped.replace(/'/g, "\\'")}'`;
}

/** Writes a property or enum member name, quoting it when it is not a valid identifier. */
function memberKey(name: string): string {
  return IDENTIFIER_PATTERN.test(name) ? name : quote(name);
}

function typeIdentifier(
  context: EmitContext,
  description: string,
  raw: string
): string {
  if (IDENTIFIER_PATTERN.test(raw)) {
    return raw;
  }
  const replaced: string = raw.replace(/[^A-Za-z0-9_$]/g, '_');
  const safe: string = /^[0-9]/.test(replaced) ? `_${replaced}` : replaced;
  const result: string = safe === '' ? '_' : safe;
  context.warnings.push(
    `${description}: "${raw}" is not a valid TypeScript identifier; it was written as "${result}".`
  );
  return result;
}

function uniqueName(baseName: string, used: Set<string>): string {
  let candidate: string = baseName;
  let suffix: number = 2;
  while (used.has(candidate)) {
    candidate = `${baseName}${suffix}`;
    suffix += 1;
  }
  used.add(candidate);
  return candidate;
}

function propertyName(context: EmitContext, rawName: string): string {
  return context.options.camelFields ? toCamelCase(rawName) : rawName;
}

function allocateTypeNames(context: EmitContext): void {
  const used: Set<string> = new Set<string>();
  for (const enumDefinition of context.schema.enums) {
    const safe: string = typeIdentifier(
      context,
      `enum ${enumDefinition.name}`,
      enumDefinition.name
    );
    const unique: string = uniqueName(safe, used);
    if (unique !== safe) {
      context.warnings.push(
        `enum ${enumDefinition.name}: the name is already used by another type; it was written as "${unique}".`
      );
    }
    context.typeNames.set(`enum:${enumDefinition.name}`, unique);
  }
  for (const model of context.schema.models) {
    const safe: string = typeIdentifier(context, model.name, model.name);
    const unique: string = uniqueName(safe, used);
    if (unique !== safe) {
      context.warnings.push(
        `${model.name}: the name is already used by an enum or another model; the interface was written as "${unique}".`
      );
    }
    context.typeNames.set(`model:${model.name}`, unique);
  }
  if (context.dates === 'date' && used.has('Date')) {
    context.warnings.push(
      'A model or enum named "Date" shadows the built-in Date type, so date properties will not type-check; rename it or use string dates.'
    );
  }
}

function modelTypeName(context: EmitContext, model: IrModel): string {
  return context.typeNames.get(`model:${model.name}`) ?? model.name;
}

function enumTypeName(context: EmitContext, enumDefinition: IrEnum): string {
  return (
    context.typeNames.get(`enum:${enumDefinition.name}`) ?? enumDefinition.name
  );
}

function namesOf(context: EmitContext, model: IrModel): ModelNames {
  return (
    context.names.get(model.name) ?? {
      fields: new Map<string, string>(),
      relations: new Map<string, string>(),
      scalars: new Map<string, string>(),
      used: new Set<string>(),
    }
  );
}

function allocateMemberNames(context: EmitContext): void {
  for (const model of context.schema.models) {
    const names: ModelNames = {
      fields: new Map<string, string>(),
      relations: new Map<string, string>(),
      scalars: new Map<string, string>(),
      used: new Set<string>(),
    };
    for (const field of model.fields) {
      names.fields.set(
        field.name,
        uniqueName(propertyName(context, field.name), names.used)
      );
    }
    for (const relation of model.relations) {
      if (relation.kind !== 'manyToMany') {
        // The foreign-key scalar is written first; skip it when a field already provides it.
        const scalarName: string = propertyName(context, relation.columnName);
        if (!names.used.has(scalarName)) {
          names.used.add(scalarName);
          names.scalars.set(relation.name, scalarName);
        }
      }
      names.relations.set(
        relation.name,
        uniqueName(propertyName(context, relation.name), names.used)
      );
    }
    context.names.set(model.name, names);
  }

  for (const model of context.schema.models) {
    for (const relation of model.relations) {
      const targetNames: ModelNames | undefined = context.names.get(
        relation.targetModel
      );
      if (targetNames === undefined) {
        continue;
      }
      const defaultName: string =
        relation.kind === 'oneToOne'
          ? toSnakeCase(model.name)
          : `${toSnakeCase(model.name)}_set`;
      context.inverseNames.set(
        `${model.name}.${relation.name}`,
        uniqueName(
          propertyName(context, relation.relatedName ?? defaultName),
          targetNames.used
        )
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

function emitEnum(context: EmitContext, enumDefinition: IrEnum): string {
  const lines: string[] = [
    `export enum ${enumTypeName(context, enumDefinition)} {`,
  ];
  const usedMembers: Set<string> = new Set<string>();
  for (const value of enumDefinition.values) {
    const memberName: string = enumMemberName(
      context,
      enumDefinition,
      value,
      usedMembers
    );
    if (value.label !== undefined && value.label !== '') {
      lines.push(`  /** ${escapeComment(value.label)} */`);
    }
    lines.push(`  ${memberKey(memberName)} = ${quote(value.dbValue)},`);
  }
  lines.push('}');
  return lines.join('\n');
}

function enumMemberName(
  context: EmitContext,
  enumDefinition: IrEnum,
  value: IrEnumValue,
  used: Set<string>
): string {
  const unique: string = uniqueName(value.name, used);
  if (unique !== value.name) {
    context.warnings.push(
      `enum ${enumDefinition.name}: the member "${value.name}" is declared more than once; the repeat was written as "${unique}".`
    );
  }
  return unique;
}

function escapeComment(text: string): string {
  return text.replace(/\*\//g, '*\\/').replace(/\s*\n\s*/g, ' ');
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Returns the TypeScript type of a scalar field. Problems are only reported when
 * `report` is true, so a type that is looked up twice produces one warning.
 */
function fieldType(
  context: EmitContext,
  label: string,
  field: IrField,
  report: boolean
): string {
  const element: string = elementType(context, label, field, report);
  const depth: number = field.arrayDepth ?? 0;
  if (depth === 0) {
    return element;
  }
  const wrapped: string = /[|&]/.test(element) ? `(${element})` : element;
  return `${wrapped}${'[]'.repeat(depth)}`;
}

function rangeBoundType(context: EmitContext, field: IrField): string {
  switch (field.rangeOf) {
    case 'int':
      return 'number';
    case 'dateTime':
    case 'date':
      return context.dates === 'date' ? 'Date' : 'string';
    default:
      return 'string';
  }
}

function elementType(
  context: EmitContext,
  label: string,
  field: IrField,
  report: boolean
): string {
  if (field.enumName !== undefined) {
    const enumDefinition: IrEnum | undefined = context.schema.enums.find(
      (candidate: IrEnum) => candidate.name === field.enumName
    );
    if (enumDefinition !== undefined) {
      return enumTypeName(context, enumDefinition);
    }
    if (report) {
      context.warnings.push(
        `${label}: enum "${field.enumName}" does not exist in the schema; the property is typed as string.`
      );
    }
    return 'string';
  }

  switch (field.type) {
    case 'string':
    case 'text':
    case 'uuid':
    case 'time':
    case 'bigInt':
    case 'decimal':
    case 'bytes':
      // BigInt and Decimal do not fit a JSON number without losing precision,
      // and binary data travels as base64 text.
      return 'string';
    case 'int':
    case 'float':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'dateTime':
    case 'date':
      return context.dates === 'date' ? 'Date' : 'string';
    case 'json':
      return 'unknown';
    case 'duration':
    case 'ipAddress':
      return 'string';
    case 'hstore':
      return 'Record<string, string | null>';
    case 'range': {
      const bound: string = rangeBoundType(context, field);
      return `{ lower: ${bound} | null; upper: ${bound} | null; bounds?: string }`;
    }
    default:
      if (report) {
        context.warnings.push(
          `${label}: unknown field type "${String(field.type)}"; the property is typed as unknown.`
        );
      }
      return 'unknown';
  }
}

/** Resolves the type of the column a relation points at (an explicit to_field, else the primary key). */
function referencedType(
  context: EmitContext,
  target: IrModel,
  toField: string | undefined,
  depth: number = 0
): string | undefined {
  if (depth > MAX_KEY_DEPTH) {
    return undefined;
  }
  const explicit: IrField | undefined =
    toField === undefined
      ? undefined
      : target.fields.find((field: IrField) => field.name === toField);
  const column: IrField | undefined =
    explicit ?? target.fields.find((field: IrField) => field.isPrimaryKey);
  if (column !== undefined) {
    return fieldType(context, `${target.name}.${column.name}`, column, false);
  }
  const primaryRelation: IrRelation | undefined = target.relations.find(
    (relation: IrRelation) => relation.isPrimaryKey === true
  );
  if (primaryRelation === undefined) {
    return undefined;
  }
  const chained: IrModel | undefined = findModel(
    context.schema,
    primaryRelation.targetModel
  );
  return chained === undefined
    ? undefined
    : referencedType(context, chained, primaryRelation.toField, depth + 1);
}

// ---------------------------------------------------------------------------
// Members
// ---------------------------------------------------------------------------

function buildForwardMembers(
  context: EmitContext,
  model: IrModel,
  reverseMembers: Map<string, Member[]>
): Member[] {
  const members: Member[] = [];
  const names: ModelNames = namesOf(context, model);

  for (const field of model.fields) {
    const label: string = `${model.name}.${field.name}`;
    members.push({
      name: names.fields.get(field.name) ?? field.name,
      type: `${fieldType(context, label, field, true)}${field.isNullable ? ' | null' : ''}`,
      optional: false,
    });
  }

  for (const relation of model.relations) {
    const label: string = `${model.name}.${relation.name}`;
    const target: IrModel | undefined = findModel(
      context.schema,
      relation.targetModel
    );
    if (target === undefined) {
      context.warnings.push(
        `${label}: target model "${relation.targetModel}" does not exist in the schema; the relation was skipped.`
      );
      continue;
    }
    const targetName: string = modelTypeName(context, target);
    const relationProp: string =
      names.relations.get(relation.name) ?? relation.name;
    const inverseProp: string =
      context.inverseNames.get(label) ?? toSnakeCase(model.name);

    if (relation.kind === 'manyToMany') {
      members.push({
        name: relationProp,
        type: `${targetName}[]`,
        optional: true,
      });
      addReverse(reverseMembers, target.name, {
        name: inverseProp,
        type: `${modelTypeName(context, model)}[]`,
        optional: true,
      });
      continue;
    }

    const scalarProp: string | undefined = names.scalars.get(relation.name);
    if (scalarProp !== undefined) {
      let keyType: string | undefined = referencedType(
        context,
        target,
        relation.toField
      );
      if (keyType === undefined) {
        context.warnings.push(
          `${label}: target model "${target.name}" has no single-column primary key to reference; the foreign key "${scalarProp}" is typed as unknown.`
        );
        keyType = 'unknown';
      }
      members.push({
        name: scalarProp,
        type: `${keyType}${relation.isNullable && keyType !== 'unknown' ? ' | null' : ''}`,
        optional: false,
      });
    }
    members.push({
      name: relationProp,
      type: `${targetName}${relation.isNullable ? ' | null' : ''}`,
      optional: true,
    });
    addReverse(reverseMembers, target.name, {
      name: inverseProp,
      type:
        relation.kind === 'oneToOne'
          ? `${modelTypeName(context, model)} | null`
          : `${modelTypeName(context, model)}[]`,
      optional: true,
    });
  }
  return members;
}

function addReverse(
  reverseMembers: Map<string, Member[]>,
  targetName: string,
  member: Member
): void {
  const existing: Member[] = reverseMembers.get(targetName) ?? [];
  existing.push(member);
  reverseMembers.set(targetName, existing);
}

function emitInterface(
  context: EmitContext,
  model: IrModel,
  members: Member[]
): string {
  const lines: string[] = [
    `export interface ${modelTypeName(context, model)} {`,
  ];
  for (const member of members) {
    lines.push(
      `  ${memberKey(member.name)}${member.optional ? '?' : ''}: ${member.type};`
    );
  }
  lines.push('}');
  return lines.join('\n');
}
