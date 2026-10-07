import type {
  IrDefault,
  IrEnum,
  IrField,
  IrIndex,
  IrModel,
  IrOnDelete,
  IrRelation,
  IrScalarType,
  IrSchema,
} from '../ir.js';
import { err, ok, type Result } from '../result.js';

export interface PrismaSourceFile {
  path: string;
  text: string;
}

export interface PrismaParseOptions {
  /** Django app label assigned to every parsed model. */
  appLabel: string;
}

interface Attribute {
  name: string;
  args: string | undefined;
}

interface PrismaField {
  name: string;
  typeName: string;
  isList: boolean;
  isOptional: boolean;
  attributes: Attribute[];
}

interface PrismaModel {
  name: string;
  fields: PrismaField[];
  blockAttributes: Attribute[];
}

const SCALAR_TYPES: ReadonlySet<string> = new Set([
  'String',
  'Int',
  'BigInt',
  'Float',
  'Decimal',
  'Boolean',
  'DateTime',
  'Json',
  'Bytes',
]);

const ON_DELETE_VALUES: Readonly<Record<string, IrOnDelete>> = {
  Cascade: 'cascade',
  SetNull: 'setNull',
  Restrict: 'restrict',
  NoAction: 'noAction',
  SetDefault: 'setDefault',
};

/** Parses a Prisma schema (hand-written tokenizer, no Prisma engine required) into the shared IR. */
export function parsePrisma(sources: PrismaSourceFile[], options: PrismaParseOptions): Result<IrSchema> {
  const warnings: string[] = [];
  const combinedText: string = sources.map((source: PrismaSourceFile) => source.text).join('\n');
  const strippedText: string = stripComments(combinedText);

  const { models, enums } = readBlocks(strippedText, warnings);
  if (models.length === 0) {
    const checkedPaths: string = sources.map((source: PrismaSourceFile) => source.path).join(', ');
    return err('NO_MODELS_FOUND', `No "model" blocks were found in: ${checkedPaths}.`);
  }

  const enumNames: Set<string> = new Set(enums.map((enumDefinition: IrEnum) => enumDefinition.name));
  const modelByName: Map<string, PrismaModel> = new Map(models.map((model: PrismaModel) => [model.name, model]));
  const manyToManyOwners: Map<string, Map<string, PrismaField>> = findManyToMany(models, modelByName);

  const irModels: IrModel[] = models.map((model: PrismaModel) =>
    buildModel(model, modelByName, enumNames, enums, manyToManyOwners, options, warnings),
  );
  return ok({ models: irModels, enums, warnings });
}

// ---------------------------------------------------------------------------
// Tokenizing
// ---------------------------------------------------------------------------

function stripComments(text: string): string {
  let result: string = '';
  let inString: boolean = false;
  for (let index: number = 0; index < text.length; index += 1) {
    const character: string = text[index] ?? '';
    const next: string = text[index + 1] ?? '';
    if (inString) {
      result += character;
      if (character === '\\') {
        result += next;
        index += 1;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }
    if (character === '"') {
      inString = true;
      result += character;
    } else if (character === '/' && next === '/') {
      while (index < text.length && text[index] !== '\n') {
        index += 1;
      }
      result += '\n';
    } else {
      result += character;
    }
  }
  return result;
}

function readBlocks(text: string, warnings: string[]): { models: PrismaModel[]; enums: IrEnum[] } {
  const models: PrismaModel[] = [];
  const enums: IrEnum[] = [];
  const lines: string[] = text.split('\n');
  const blockStart: RegExp = /^\s*(model|enum|type|view|generator|datasource)\s+(\w+)\s*\{\s*(.*)$/;

  for (let lineIndex: number = 0; lineIndex < lines.length; lineIndex += 1) {
    const match: RegExpExecArray | null = blockStart.exec(lines[lineIndex] ?? '');
    if (match === null) {
      continue;
    }
    const kind: string = match[1] ?? '';
    const name: string = match[2] ?? '';
    const body: string[] = [];
    const remainder: string = (match[3] ?? '').trim();
    let closed: boolean = false;
    if (remainder.endsWith('}')) {
      const inner: string = remainder.slice(0, -1).trim();
      if (inner.length > 0) {
        body.push(inner);
      }
      closed = true;
    } else if (remainder.length > 0) {
      body.push(remainder);
    }
    while (!closed && lineIndex + 1 < lines.length) {
      lineIndex += 1;
      const bodyLine: string = (lines[lineIndex] ?? '').trim();
      if (bodyLine === '}') {
        closed = true;
        break;
      }
      if (bodyLine.length > 0) {
        body.push(bodyLine);
      }
    }
    if (!closed) {
      warnings.push(`The ${kind} block "${name}" is missing its closing brace; parsing continued with what was found.`);
    }
    if (kind === 'model') {
      models.push(parseModelBlock(name, body, warnings));
    } else if (kind === 'enum') {
      enums.push(parseEnumBlock(name, body));
    } else if (kind === 'type' || kind === 'view') {
      warnings.push(`The ${kind} "${name}" (composite type / view) is not supported and was skipped.`);
    }
  }
  return { models, enums };
}

function parseEnumBlock(name: string, body: string[]): IrEnum {
  const values: IrEnum['values'] = [];
  for (const line of body) {
    const memberMatch: RegExpExecArray | null = /^(\w+)\s*(.*)$/.exec(line);
    if (memberMatch === null) {
      continue;
    }
    const memberName: string = memberMatch[1] ?? '';
    const mapAttribute: Attribute | undefined = parseAttributes(memberMatch[2] ?? '').find(
      (attribute: Attribute) => attribute.name === 'map',
    );
    const mappedValue: string | undefined = mapAttribute === undefined ? undefined : firstStringArgument(mapAttribute);
    values.push({ name: memberName, dbValue: mappedValue ?? memberName });
  }
  return { name, values };
}

function parseModelBlock(name: string, body: string[], warnings: string[]): PrismaModel {
  const fields: PrismaField[] = [];
  const blockAttributes: Attribute[] = [];
  for (const line of body) {
    if (line.startsWith('@@')) {
      blockAttributes.push(...parseAttributes(line));
      continue;
    }
    const fieldMatch: RegExpExecArray | null = /^(\w+)\s+(\w+)(\[\])?(\?)?\s*(.*)$/.exec(line);
    if (fieldMatch === null) {
      warnings.push(`Model ${name}: the line "${line}" could not be understood and was skipped.`);
      continue;
    }
    fields.push({
      name: fieldMatch[1] ?? '',
      typeName: fieldMatch[2] ?? '',
      isList: fieldMatch[3] !== undefined,
      isOptional: fieldMatch[4] !== undefined,
      attributes: parseAttributes(fieldMatch[5] ?? ''),
    });
  }
  return { name, fields, blockAttributes };
}

function findClosingParenthesis(text: string, openIndex: number): number {
  let depth: number = 0;
  let inString: boolean = false;
  for (let index: number = openIndex; index < text.length; index += 1) {
    const character: string = text[index] ?? '';
    if (inString) {
      if (character === '\\') {
        index += 1;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }
    if (character === '"') {
      inString = true;
    } else if (character === '(') {
      depth += 1;
    } else if (character === ')') {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  return text.length;
}

function parseAttributes(text: string): Attribute[] {
  const attributes: Attribute[] = [];
  let index: number = 0;
  while (index < text.length) {
    const atIndex: number = text.indexOf('@', index);
    if (atIndex === -1) {
      break;
    }
    let cursor: number = atIndex + 1;
    if (text[cursor] === '@') {
      cursor += 1;
    }
    const nameStart: number = cursor;
    while (cursor < text.length && /[\w.]/.test(text[cursor] ?? '')) {
      cursor += 1;
    }
    const name: string = text.slice(nameStart, cursor);
    let args: string | undefined;
    if (text[cursor] === '(') {
      const closeIndex: number = findClosingParenthesis(text, cursor);
      args = text.slice(cursor + 1, closeIndex);
      cursor = closeIndex + 1;
    }
    attributes.push({ name, args });
    index = Math.max(cursor, atIndex + 1);
  }
  return attributes;
}

function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth: number = 0;
  let inString: boolean = false;
  let current: string = '';
  for (let index: number = 0; index < text.length; index += 1) {
    const character: string = text[index] ?? '';
    if (inString) {
      current += character;
      if (character === '\\') {
        current += text[index + 1] ?? '';
        index += 1;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }
    if (character === '"') {
      inString = true;
      current += character;
    } else if (character === '(' || character === '[' || character === '{') {
      depth += 1;
      current += character;
    } else if (character === ')' || character === ']' || character === '}') {
      depth -= 1;
      current += character;
    } else if (character === ',' && depth === 0) {
      parts.push(current.trim());
      current = '';
    } else {
      current += character;
    }
  }
  if (current.trim().length > 0) {
    parts.push(current.trim());
  }
  return parts;
}

function unquote(value: string): string {
  const trimmed: string = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (typeof parsed === 'string') {
        return parsed;
      }
    } catch {
      return trimmed.slice(1, -1);
    }
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/** Returns the argument supplied under a keyword (e.g. fields: [a, b]) as raw text. */
function namedArgument(attribute: Attribute | undefined, key: string): string | undefined {
  if (attribute === undefined || attribute.args === undefined) {
    return undefined;
  }
  for (const part of splitTopLevel(attribute.args)) {
    const match: RegExpExecArray | null = /^(\w+)\s*:\s*([\s\S]*)$/.exec(part);
    if (match !== null && match[1] === key) {
      return (match[2] ?? '').trim();
    }
  }
  return undefined;
}

/** Returns the first argument when it is positional (not key: value). */
function positionalArgument(attribute: Attribute | undefined): string | undefined {
  if (attribute === undefined || attribute.args === undefined) {
    return undefined;
  }
  const first: string | undefined = splitTopLevel(attribute.args)[0];
  if (first === undefined || /^\w+\s*:/.test(first)) {
    return undefined;
  }
  return first;
}

function firstStringArgument(attribute: Attribute): string | undefined {
  const positional: string | undefined = positionalArgument(attribute);
  return positional === undefined ? undefined : unquote(positional);
}

function parseNameList(rawList: string | undefined): string[] {
  if (rawList === undefined) {
    return [];
  }
  const inner: string = rawList.trim().replace(/^\[/, '').replace(/\]$/, '');
  return splitTopLevel(inner).map((item: string) => item.replace(/\(.*\)$/, '').trim());
}

function attributeNamed(attributes: Attribute[], name: string): Attribute | undefined {
  return attributes.find((attribute: Attribute) => attribute.name === name);
}

/** Name given to a relation through @relation("Name") or @relation(name: "Name"). */
function relationLabel(field: PrismaField): string | undefined {
  const relationAttribute: Attribute | undefined = attributeNamed(field.attributes, 'relation');
  if (relationAttribute === undefined) {
    return undefined;
  }
  const named: string | undefined = namedArgument(relationAttribute, 'name');
  if (named !== undefined) {
    return unquote(named);
  }
  const positional: string | undefined = positionalArgument(relationAttribute);
  return positional === undefined ? undefined : unquote(positional);
}

function ownsForeignKey(field: PrismaField): boolean {
  const relationAttribute: Attribute | undefined = attributeNamed(field.attributes, 'relation');
  return namedArgument(relationAttribute, 'fields') !== undefined;
}

// ---------------------------------------------------------------------------
// Relations
// ---------------------------------------------------------------------------

/**
 * Finds implicit many-to-many pairs (a list field on both models, neither owning a foreign key).
 * Returns, per owning model, the list fields that should become ManyToManyField definitions.
 */
function findManyToMany(
  models: PrismaModel[],
  modelByName: Map<string, PrismaModel>,
): Map<string, Map<string, PrismaField>> {
  const owners: Map<string, Map<string, PrismaField>> = new Map();
  for (const model of models) {
    for (const field of model.fields) {
      if (!field.isList || !modelByName.has(field.typeName) || ownsForeignKey(field)) {
        continue;
      }
      const target: PrismaModel | undefined = modelByName.get(field.typeName);
      const counterpart: PrismaField | undefined = target?.fields.find(
        (candidate: PrismaField) =>
          candidate !== field &&
          candidate.isList &&
          candidate.typeName === model.name &&
          !ownsForeignKey(candidate) &&
          relationLabel(candidate) === relationLabel(field),
      );
      if (counterpart === undefined || target === undefined) {
        continue;
      }
      const isOwner: boolean = `${model.name}.${field.name}` < `${target.name}.${counterpart.name}`;
      if (isOwner) {
        const ownerFields: Map<string, PrismaField> = owners.get(model.name) ?? new Map();
        ownerFields.set(field.name, counterpart);
        owners.set(model.name, ownerFields);
      }
    }
  }
  return owners;
}

function findInverseField(owner: PrismaModel, field: PrismaField, target: PrismaModel): PrismaField | undefined {
  const label: string | undefined = relationLabel(field);
  return target.fields.find(
    (candidate: PrismaField) =>
      candidate.typeName === owner.name && !ownsForeignKey(candidate) && relationLabel(candidate) === label,
  );
}

// ---------------------------------------------------------------------------
// Model building
// ---------------------------------------------------------------------------

function buildModel(
  model: PrismaModel,
  modelByName: Map<string, PrismaModel>,
  enumNames: Set<string>,
  enums: IrEnum[],
  manyToManyOwners: Map<string, Map<string, PrismaField>>,
  options: PrismaParseOptions,
  warnings: string[],
): IrModel {
  const consumedScalars: Map<string, string> = new Map();
  const relations: IrRelation[] = [];

  for (const field of model.fields) {
    if (!modelByName.has(field.typeName)) {
      continue;
    }
    const target: PrismaModel | undefined = modelByName.get(field.typeName);
    if (target === undefined) {
      continue;
    }
    if (field.isList) {
      const counterpart: PrismaField | undefined = manyToManyOwners.get(model.name)?.get(field.name);
      if (counterpart !== undefined) {
        relations.push({
          name: field.name,
          kind: 'manyToMany',
          targetModel: target.name,
          columnName: '',
          isNullable: false,
          onDelete: 'cascade',
          relatedName: counterpart.name,
        });
        warnings.push(
          `${model.name}.${field.name}: Prisma's implicit many-to-many table ("_${model.name}To${target.name}" with columns A and B) ` +
            `differs from the join table Django will create; migrate data or define an explicit through model.`,
        );
      }
      continue;
    }
    if (!ownsForeignKey(field)) {
      continue;
    }
    const relation: IrRelation | undefined = buildForeignKey(model, field, target, consumedScalars, warnings);
    if (relation !== undefined) {
      relations.push(relation);
    }
  }

  const fields: IrField[] = [];
  for (const field of model.fields) {
    if (modelByName.has(field.typeName) || consumedScalars.has(field.name)) {
      continue;
    }
    const scalarField: IrField | undefined = buildScalarField(model, field, enumNames, enums, warnings);
    if (scalarField !== undefined) {
      fields.push(scalarField);
    }
  }

  const resolveName = (name: string): string => consumedScalars.get(name) ?? name;
  const indexes: IrIndex[] = [];
  let compositePrimaryKey: string[] | undefined;

  for (const attribute of model.blockAttributes) {
    if (attribute.name === 'id') {
      const keyFields: string[] = parseNameList(positionalArgument(attribute) ?? namedArgument(attribute, 'fields'));
      compositePrimaryKey = keyFields.map(resolveName);
    } else if (attribute.name === 'unique' || attribute.name === 'index') {
      const indexFields: string[] = parseNameList(positionalArgument(attribute) ?? namedArgument(attribute, 'fields')).map(
        resolveName,
      );
      const mapArgument: string | undefined = namedArgument(attribute, 'map');
      if (indexFields.length > 0) {
        indexes.push({
          fields: indexFields,
          isUnique: attribute.name === 'unique',
          ...(mapArgument === undefined ? {} : { name: unquote(mapArgument) }),
        });
      }
    } else if (attribute.name === 'fulltext' || attribute.name === 'ignore' || attribute.name === 'schema') {
      warnings.push(`${model.name}: @@${attribute.name} has no Django equivalent and was ignored.`);
    }
  }

  const mapAttribute: Attribute | undefined = attributeNamed(model.blockAttributes, 'map');
  const tableName: string = (mapAttribute === undefined ? undefined : firstStringArgument(mapAttribute)) ?? model.name;

  return {
    name: model.name,
    tableName,
    appLabel: options.appLabel,
    fields,
    relations,
    indexes,
    ...(compositePrimaryKey === undefined ? {} : { compositePrimaryKey }),
  };
}

function scalarColumnName(field: PrismaField): string {
  const mapAttribute: Attribute | undefined = attributeNamed(field.attributes, 'map');
  return (mapAttribute === undefined ? undefined : firstStringArgument(mapAttribute)) ?? field.name;
}

function buildForeignKey(
  model: PrismaModel,
  field: PrismaField,
  target: PrismaModel,
  consumedScalars: Map<string, string>,
  warnings: string[],
): IrRelation | undefined {
  const relationAttribute: Attribute | undefined = attributeNamed(field.attributes, 'relation');
  const foreignKeyNames: string[] = parseNameList(namedArgument(relationAttribute, 'fields'));
  const referenceNames: string[] = parseNameList(namedArgument(relationAttribute, 'references'));
  const location: string = `${model.name}.${field.name}`;

  if (foreignKeyNames.length !== 1) {
    warnings.push(
      `${location}: composite foreign keys (${foreignKeyNames.join(', ')}) have no Django equivalent; the relation was skipped.`,
    );
    return undefined;
  }
  const scalarName: string = foreignKeyNames[0] ?? '';
  const scalarField: PrismaField | undefined = model.fields.find((candidate: PrismaField) => candidate.name === scalarName);
  if (scalarField === undefined) {
    warnings.push(`${location}: the foreign key field "${scalarName}" does not exist on ${model.name}; the relation was skipped.`);
    return undefined;
  }
  consumedScalars.set(scalarName, field.name);

  const isPrimaryKey: boolean = attributeNamed(scalarField.attributes, 'id') !== undefined;
  const isUnique: boolean =
    attributeNamed(scalarField.attributes, 'unique') !== undefined ||
    model.blockAttributes.some(
      (attribute: Attribute) =>
        attribute.name === 'unique' && parseNameList(positionalArgument(attribute) ?? namedArgument(attribute, 'fields')).join() === scalarName,
    );

  const onDeleteRaw: string | undefined = namedArgument(relationAttribute, 'onDelete');
  const onDelete: IrOnDelete = (onDeleteRaw === undefined ? undefined : ON_DELETE_VALUES[onDeleteRaw]) ?? (field.isOptional ? 'setNull' : 'restrict');

  const inverse: PrismaField | undefined = findInverseField(model, field, target);
  const referencedField: string | undefined = referenceNames[0];
  const targetKeyField: PrismaField | undefined = target.fields.find((candidate: PrismaField) => attributeNamed(candidate.attributes, 'id') !== undefined);
  const needsToField: boolean = referencedField !== undefined && targetKeyField !== undefined && referencedField !== targetKeyField.name;

  return {
    name: field.name,
    kind: isPrimaryKey || isUnique ? 'oneToOne' : 'foreignKey',
    targetModel: target.name,
    columnName: scalarColumnName(scalarField),
    isNullable: field.isOptional,
    onDelete,
    ...(inverse === undefined ? {} : { relatedName: inverse.name }),
    ...(needsToField && referencedField !== undefined ? { toField: referencedField } : {}),
    ...(isPrimaryKey ? { isPrimaryKey: true } : {}),
  };
}

function buildScalarField(
  model: PrismaModel,
  field: PrismaField,
  enumNames: Set<string>,
  enums: IrEnum[],
  warnings: string[],
): IrField | undefined {
  const location: string = `${model.name}.${field.name}`;
  const isEnum: boolean = enumNames.has(field.typeName);

  if (field.typeName === 'Unsupported') {
    warnings.push(`${location}: Unsupported(...) database types cannot be converted; the field was skipped.`);
    return undefined;
  }
  if (!isEnum && !SCALAR_TYPES.has(field.typeName)) {
    warnings.push(`${location}: the type "${field.typeName}" is not a known scalar, enum or model; the field was skipped.`);
    return undefined;
  }

  const nativeAttribute: Attribute | undefined = field.attributes.find((attribute: Attribute) => attribute.name.startsWith('db.'));
  const nativeName: string = nativeAttribute === undefined ? '' : nativeAttribute.name.slice(3);
  const nativeArguments: string[] = nativeAttribute?.args === undefined ? [] : splitTopLevel(nativeAttribute.args);

  let type: IrScalarType = 'string';
  let maxLength: number | undefined;
  let maxDigits: number | undefined;
  let decimalPlaces: number | undefined;

  if (field.isList) {
    warnings.push(`${location}: scalar lists have no direct Django equivalent; the field was converted to a JSONField.`);
    type = 'json';
  } else if (isEnum) {
    type = 'string';
  } else {
    switch (field.typeName) {
      case 'String':
        if (nativeName === 'Text' || nativeName === 'MediumText' || nativeName === 'LongText') {
          type = 'text';
        } else if (nativeName === 'Uuid') {
          type = 'uuid';
        } else {
          type = 'string';
          const lengthArgument: string | undefined = nativeArguments[0];
          if (lengthArgument !== undefined && /^\d+$/.test(lengthArgument)) {
            maxLength = Number(lengthArgument);
          }
        }
        break;
      case 'Int':
        type = 'int';
        break;
      case 'BigInt':
        type = 'bigInt';
        break;
      case 'Float':
        type = 'float';
        break;
      case 'Decimal':
        type = 'decimal';
        maxDigits = nativeArguments[0] !== undefined && /^\d+$/.test(nativeArguments[0]) ? Number(nativeArguments[0]) : 65;
        decimalPlaces = nativeArguments[1] !== undefined && /^\d+$/.test(nativeArguments[1]) ? Number(nativeArguments[1]) : 30;
        break;
      case 'Boolean':
        type = 'boolean';
        break;
      case 'DateTime':
        type = nativeName === 'Date' ? 'date' : nativeName.startsWith('Time') && !nativeName.startsWith('Timestamp') ? 'time' : 'dateTime';
        break;
      case 'Json':
        type = 'json';
        break;
      case 'Bytes':
        type = 'bytes';
        break;
      default:
        type = 'string';
    }
  }

  const irField: IrField = {
    name: field.name,
    columnName: scalarColumnName(field),
    type,
    isPrimaryKey: attributeNamed(field.attributes, 'id') !== undefined,
    isUnique: attributeNamed(field.attributes, 'unique') !== undefined,
    isNullable: field.isOptional,
    isAutoUpdated: attributeNamed(field.attributes, 'updatedAt') !== undefined,
  };
  if (isEnum && !field.isList) {
    irField.enumName = field.typeName;
  }
  if (maxLength !== undefined) {
    irField.maxLength = maxLength;
  }
  if (maxDigits !== undefined) {
    irField.maxDigits = maxDigits;
  }
  if (decimalPlaces !== undefined) {
    irField.decimalPlaces = decimalPlaces;
  }

  const defaultAttribute: Attribute | undefined = attributeNamed(field.attributes, 'default');
  if (defaultAttribute !== undefined && !field.isList) {
    const parsedDefault: IrDefault | undefined = parseDefault(location, defaultAttribute, isEnum ? enums.find((candidate: IrEnum) => candidate.name === field.typeName) : undefined, warnings);
    if (parsedDefault !== undefined) {
      irField.default = parsedDefault;
    }
  }
  return irField;
}

function parseDefault(
  location: string,
  attribute: Attribute,
  enumDefinition: IrEnum | undefined,
  warnings: string[],
): IrDefault | undefined {
  const raw: string | undefined = positionalArgument(attribute) ?? namedArgument(attribute, 'value');
  if (raw === undefined) {
    return undefined;
  }
  const value: string = raw.trim();
  if (/^autoincrement\(\s*\)$/.test(value)) {
    return { kind: 'autoIncrement' };
  }
  if (/^now\(\s*\)$/.test(value)) {
    return { kind: 'now' };
  }
  if (/^uuid\(.*\)$/.test(value)) {
    return { kind: 'uuid' };
  }
  if (/^(cuid|nanoid|ulid)\(.*\)$/.test(value)) {
    warnings.push(`${location}: @default(${value}) is generated by the Prisma client and has no database or Django equivalent; the default was dropped.`);
    return undefined;
  }
  if (/^dbgenerated\(.*\)$/.test(value) || /^auto\(.*\)$/.test(value) || /^sequence\(.*\)$/.test(value)) {
    warnings.push(`${location}: @default(${value}) is a database-generated default and was dropped.`);
    return undefined;
  }
  if (value === 'true' || value === 'false') {
    return { kind: 'literal', value: value === 'true' };
  }
  if (/^-?\d+(\.\d+)?$/.test(value)) {
    return { kind: 'literal', value: Number(value) };
  }
  if (value.startsWith('"')) {
    return { kind: 'literal', value: unquote(value) };
  }
  if (enumDefinition !== undefined && enumDefinition.values.some((member) => member.name === value)) {
    return { kind: 'enumValue', value };
  }
  warnings.push(`${location}: @default(${value}) could not be converted and was dropped.`);
  return undefined;
}
