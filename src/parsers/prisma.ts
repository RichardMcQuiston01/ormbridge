import type {
  IrCompositeForeignKey,
  IrDefault,
  IrEnum,
  IrField,
  IrIndex,
  IrIndexFieldOptions,
  IrModel,
  IrNativeType,
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
  /** Raw database type of an Unsupported("...") field. */
  unsupportedType?: string;
}

interface PrismaModel {
  name: string;
  fields: PrismaField[];
  blockAttributes: Attribute[];
  isView: boolean;
}

/** Postgres range types that Prisma can only express as Unsupported("..."), mapped to the IR range subtype. */
const RANGE_TYPES: Readonly<
  Record<string, 'int' | 'bigInt' | 'decimal' | 'date' | 'dateTime'>
> = {
  int4range: 'int',
  int8range: 'bigInt',
  numrange: 'decimal',
  daterange: 'date',
  tstzrange: 'dateTime',
  tsrange: 'dateTime',
};

/** Native types whose single argument is a character length rather than a bit or byte count. */
const LENGTH_TYPES: ReadonlySet<string> = new Set([
  'VarChar',
  'Char',
  'NVarChar',
  'NChar',
  'String',
]);

const TEXT_TYPES: ReadonlySet<string> = new Set([
  'Text',
  'TinyText',
  'MediumText',
  'LongText',
  'NText',
]);

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
export function parsePrisma(
  sources: PrismaSourceFile[],
  options: PrismaParseOptions
): Result<IrSchema> {
  const warnings: string[] = [];
  const combinedText: string = sources
    .map((source: PrismaSourceFile) => source.text)
    .join('\n');
  const strippedText: string = stripComments(combinedText);

  const { models, enums, provider } = readBlocks(strippedText, warnings);
  if (models.length === 0) {
    const checkedPaths: string = sources
      .map((source: PrismaSourceFile) => source.path)
      .join(', ');
    return err(
      'NO_MODELS_FOUND',
      `No "model" blocks were found in: ${checkedPaths}.`
    );
  }

  const enumNames: Set<string> = new Set(
    enums.map((enumDefinition: IrEnum) => enumDefinition.name)
  );
  const modelByName: Map<string, PrismaModel> = new Map(
    models.map((model: PrismaModel) => [model.name, model])
  );
  const manyToManyOwners: Map<
    string,
    Map<string, PrismaField>
  > = findManyToMany(models, modelByName);

  const irModels: IrModel[] = models.map((model: PrismaModel) =>
    buildModel(
      model,
      modelByName,
      enumNames,
      enums,
      manyToManyOwners,
      provider,
      options,
      warnings
    )
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

function readBlocks(
  text: string,
  warnings: string[]
): { models: PrismaModel[]; enums: IrEnum[]; provider: string | undefined } {
  const models: PrismaModel[] = [];
  const enums: IrEnum[] = [];
  let provider: string | undefined;
  const lines: string[] = text.split('\n');
  const blockStart: RegExp =
    /^\s*(model|enum|type|view|generator|datasource)\s+(\w+)\s*\{\s*(.*)$/;

  for (let lineIndex: number = 0; lineIndex < lines.length; lineIndex += 1) {
    const match: RegExpExecArray | null = blockStart.exec(
      lines[lineIndex] ?? ''
    );
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
      warnings.push(
        `The ${kind} block "${name}" is missing its closing brace; parsing continued with what was found.`
      );
    }
    if (kind === 'datasource') {
      for (const bodyLine of body) {
        const providerMatch: RegExpExecArray | null =
          /^provider\s*=\s*"([^"]*)"/.exec(bodyLine);
        if (providerMatch !== null) {
          provider = providerMatch[1];
        }
      }
    } else if (kind === 'model' || kind === 'view') {
      models.push(parseModelBlock(name, body, kind === 'view', warnings));
    } else if (kind === 'enum') {
      enums.push(parseEnumBlock(name, body, warnings));
    } else if (kind === 'type') {
      warnings.push(
        `The composite type "${name}" is not supported and was skipped; fields that use it are skipped too.`
      );
    }
  }
  return { models, enums, provider };
}

function parseEnumBlock(
  name: string,
  body: string[],
  warnings: string[]
): IrEnum {
  const values: IrEnum['values'] = [];
  let dbName: string | undefined;
  let schemaName: string | undefined;
  for (const line of body) {
    if (line.startsWith('@@')) {
      for (const attribute of parseAttributes(line)) {
        if (attribute.name === 'map') {
          dbName = firstStringArgument(attribute);
        } else if (attribute.name === 'schema') {
          schemaName = firstStringArgument(attribute);
        } else {
          warnings.push(
            `enum ${name}: @@${attribute.name} is not supported and was ignored.`
          );
        }
      }
      continue;
    }
    const memberMatch: RegExpExecArray | null = /^(\w+)\s*(.*)$/.exec(line);
    if (memberMatch === null) {
      continue;
    }
    const memberName: string = memberMatch[1] ?? '';
    const mapAttribute: Attribute | undefined = parseAttributes(
      memberMatch[2] ?? ''
    ).find((attribute: Attribute) => attribute.name === 'map');
    const mappedValue: string | undefined =
      mapAttribute === undefined
        ? undefined
        : firstStringArgument(mapAttribute);
    values.push({ name: memberName, dbValue: mappedValue ?? memberName });
  }
  return {
    name,
    values,
    ...(dbName === undefined ? {} : { dbName }),
    ...(schemaName === undefined ? {} : { schema: schemaName }),
  };
}

function parseModelBlock(
  name: string,
  body: string[],
  isView: boolean,
  warnings: string[]
): PrismaModel {
  const fields: PrismaField[] = [];
  const blockAttributes: Attribute[] = [];
  for (const line of body) {
    if (line.startsWith('@@')) {
      blockAttributes.push(...parseAttributes(line));
      continue;
    }
    const fieldMatch: RegExpExecArray | null =
      /^(\w+)\s+(Unsupported\(\s*"(?:[^"\\]|\\.)*"\s*\)|\w+)(\[\])?(\?)?\s*(.*)$/.exec(
        line
      );
    if (fieldMatch === null) {
      warnings.push(
        `${isView ? 'View' : 'Model'} ${name}: the line "${line}" could not be understood and was skipped.`
      );
      continue;
    }
    const rawType: string = fieldMatch[2] ?? '';
    const isUnsupported: boolean = rawType.startsWith('Unsupported(');
    const unsupportedText: string = rawType.slice(
      rawType.indexOf('(') + 1,
      rawType.lastIndexOf(')')
    );
    fields.push({
      name: fieldMatch[1] ?? '',
      typeName: isUnsupported ? 'Unsupported' : rawType,
      isList: fieldMatch[3] !== undefined,
      isOptional: fieldMatch[4] !== undefined,
      attributes: parseAttributes(fieldMatch[5] ?? ''),
      ...(isUnsupported ? { unsupportedType: unquote(unsupportedText) } : {}),
    });
  }
  return { name, fields, blockAttributes, isView };
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
function namedArgument(
  attribute: Attribute | undefined,
  key: string
): string | undefined {
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
function positionalArgument(
  attribute: Attribute | undefined
): string | undefined {
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
  return splitTopLevel(inner).map((item: string) =>
    item.replace(/\(.*\)$/, '').trim()
  );
}

function attributeNamed(
  attributes: Attribute[],
  name: string
): Attribute | undefined {
  return attributes.find((attribute: Attribute) => attribute.name === name);
}

/** Name given to a relation through @relation("Name") or @relation(name: "Name"). */
function relationLabel(field: PrismaField): string | undefined {
  const relationAttribute: Attribute | undefined = attributeNamed(
    field.attributes,
    'relation'
  );
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
  const relationAttribute: Attribute | undefined = attributeNamed(
    field.attributes,
    'relation'
  );
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
  modelByName: Map<string, PrismaModel>
): Map<string, Map<string, PrismaField>> {
  const owners: Map<string, Map<string, PrismaField>> = new Map();
  for (const model of models) {
    for (const field of model.fields) {
      if (
        !field.isList ||
        !modelByName.has(field.typeName) ||
        ownsForeignKey(field)
      ) {
        continue;
      }
      const target: PrismaModel | undefined = modelByName.get(field.typeName);
      const counterpart: PrismaField | undefined = target?.fields.find(
        (candidate: PrismaField) =>
          candidate !== field &&
          candidate.isList &&
          candidate.typeName === model.name &&
          !ownsForeignKey(candidate) &&
          relationLabel(candidate) === relationLabel(field)
      );
      if (counterpart === undefined || target === undefined) {
        continue;
      }
      const isOwner: boolean =
        `${model.name}.${field.name}` < `${target.name}.${counterpart.name}`;
      if (isOwner) {
        const ownerFields: Map<string, PrismaField> =
          owners.get(model.name) ?? new Map();
        ownerFields.set(field.name, counterpart);
        owners.set(model.name, ownerFields);
      }
    }
  }
  return owners;
}

function findInverseField(
  owner: PrismaModel,
  field: PrismaField,
  target: PrismaModel
): PrismaField | undefined {
  const label: string | undefined = relationLabel(field);
  return target.fields.find(
    (candidate: PrismaField) =>
      candidate.typeName === owner.name &&
      !ownsForeignKey(candidate) &&
      relationLabel(candidate) === label
  );
}

// ---------------------------------------------------------------------------
// Model building
// ---------------------------------------------------------------------------

interface IndexEntry {
  name: string;
  options: IrIndexFieldOptions;
}

/** Reads `[a, b(sort: Desc, length: 10)]` into field names plus per-field options. */
function parseIndexEntries(
  location: string,
  rawList: string | undefined,
  warnings: string[]
): IndexEntry[] {
  if (rawList === undefined) {
    return [];
  }
  const inner: string = rawList.trim().replace(/^\[/, '').replace(/\]$/, '');
  const entries: IndexEntry[] = [];
  for (const item of splitTopLevel(inner)) {
    const match: RegExpExecArray | null = /^(\w+)\s*(?:\(([\s\S]*)\))?$/.exec(
      item
    );
    if (match === null) {
      warnings.push(
        `${location}: the index entry "${item}" could not be understood and was skipped.`
      );
      continue;
    }
    const entryName: string = match[1] ?? '';
    const options: IrIndexFieldOptions = {};
    for (const part of splitTopLevel(match[2] ?? '')) {
      const optionMatch: RegExpExecArray | null =
        /^(\w+)\s*:\s*([\s\S]*)$/.exec(part);
      const key: string = optionMatch?.[1] ?? '';
      const value: string = (optionMatch?.[2] ?? '').trim();
      if (key === 'sort' && (value === 'Asc' || value === 'Desc')) {
        options.sort = value === 'Asc' ? 'asc' : 'desc';
      } else if (key === 'length' && /^\d+$/.test(value)) {
        options.length = Number(value);
      } else if (key === 'ops' && value.length > 0) {
        options.ops = value;
      } else {
        warnings.push(
          `${location}: the option "${part}" on index entry "${entryName}" is not supported and was dropped.`
        );
      }
    }
    entries.push({ name: entryName, options });
  }
  return entries;
}

function booleanArgument(
  attribute: Attribute,
  key: string
): boolean | undefined {
  const raw: string | undefined = namedArgument(attribute, key);
  if (raw === 'true') {
    return true;
  }
  return raw === 'false' ? false : undefined;
}

function buildModel(
  model: PrismaModel,
  modelByName: Map<string, PrismaModel>,
  enumNames: Set<string>,
  enums: IrEnum[],
  manyToManyOwners: Map<string, Map<string, PrismaField>>,
  provider: string | undefined,
  options: PrismaParseOptions,
  warnings: string[]
): IrModel {
  const consumedScalars: Map<string, string> = new Map();
  const relations: IrRelation[] = [];
  const compositeForeignKeys: IrCompositeForeignKey[] = [];

  for (const field of model.fields) {
    if (!modelByName.has(field.typeName)) {
      continue;
    }
    const target: PrismaModel | undefined = modelByName.get(field.typeName);
    if (target === undefined) {
      continue;
    }
    if (field.isList) {
      const counterpart: PrismaField | undefined = manyToManyOwners
        .get(model.name)
        ?.get(field.name);
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
            `differs from the join table Django will create; migrate data or define an explicit through model.`
        );
      }
      continue;
    }
    if (!ownsForeignKey(field)) {
      continue;
    }
    const keyColumns: string[] = parseNameList(
      namedArgument(attributeNamed(field.attributes, 'relation'), 'fields')
    );
    if (keyColumns.length > 1) {
      const compositeKey: IrCompositeForeignKey | undefined =
        buildCompositeForeignKey(model, field, target, keyColumns, warnings);
      if (compositeKey !== undefined) {
        compositeForeignKeys.push(compositeKey);
      }
      continue;
    }
    const relation: IrRelation | undefined = buildForeignKey(
      model,
      field,
      target,
      consumedScalars,
      warnings
    );
    if (relation !== undefined) {
      relations.push(relation);
    }
  }

  const fields: IrField[] = [];
  for (const field of model.fields) {
    if (modelByName.has(field.typeName) || consumedScalars.has(field.name)) {
      continue;
    }
    const scalarField: IrField | undefined = buildScalarField(
      model,
      field,
      enumNames,
      enums,
      provider,
      warnings
    );
    if (scalarField !== undefined) {
      fields.push(scalarField);
    }
  }

  const resolveName = (name: string): string =>
    consumedScalars.get(name) ?? name;
  const indexes: IrIndex[] = [];
  let compositePrimaryKey: string[] | undefined;
  let primaryKeyName: string | undefined;
  let isIgnored: boolean = false;
  let schemaName: string | undefined;

  for (const attribute of model.blockAttributes) {
    const location: string = `${model.name} @@${attribute.name}`;
    const rawFields: string | undefined =
      positionalArgument(attribute) ?? namedArgument(attribute, 'fields');
    if (attribute.name === 'id') {
      const entries: IndexEntry[] = parseIndexEntries(
        location,
        rawFields,
        warnings
      );
      compositePrimaryKey = entries.map((entry: IndexEntry) =>
        resolveName(entry.name)
      );
      if (
        entries.some(
          (entry: IndexEntry) => Object.keys(entry.options).length > 0
        )
      ) {
        warnings.push(
          `${location}: sort and length options on primary key fields are not kept.`
        );
      }
      const mapArgument: string | undefined = namedArgument(attribute, 'map');
      if (mapArgument !== undefined) {
        primaryKeyName = unquote(mapArgument);
      }
      if (namedArgument(attribute, 'name') !== undefined) {
        warnings.push(
          `${location}: the client-side key name (name: ...) is not kept; Prisma Client will use the default compound key name.`
        );
      }
    } else if (
      attribute.name === 'unique' ||
      attribute.name === 'index' ||
      attribute.name === 'fulltext'
    ) {
      const entries: IndexEntry[] = parseIndexEntries(
        location,
        rawFields,
        warnings
      ).map((entry: IndexEntry) => ({
        ...entry,
        name: resolveName(entry.name),
      }));
      if (entries.length === 0) {
        continue;
      }
      indexes.push(buildIndex(location, attribute, entries, warnings));
    } else if (attribute.name === 'ignore') {
      isIgnored = true;
    } else if (attribute.name === 'schema') {
      schemaName = firstStringArgument(attribute);
    } else if (attribute.name !== 'map') {
      warnings.push(`${location} is not supported and was ignored.`);
    }
  }

  for (const field of model.fields) {
    const idAttribute: Attribute | undefined = attributeNamed(
      field.attributes,
      'id'
    );
    const idMap: string | undefined = namedArgument(idAttribute, 'map');
    if (idMap !== undefined) {
      primaryKeyName = unquote(idMap);
    }
  }

  const mapAttribute: Attribute | undefined = attributeNamed(
    model.blockAttributes,
    'map'
  );
  const tableName: string =
    (mapAttribute === undefined
      ? undefined
      : firstStringArgument(mapAttribute)) ?? model.name;

  return {
    name: model.name,
    tableName,
    appLabel: options.appLabel,
    fields,
    relations,
    indexes,
    ...(compositePrimaryKey === undefined ? {} : { compositePrimaryKey }),
    ...(model.isView ? { isView: true } : {}),
    ...(isIgnored ? { isIgnored: true } : {}),
    ...(schemaName === undefined ? {} : { schema: schemaName }),
    ...(primaryKeyName === undefined ? {} : { primaryKeyName }),
    ...(compositeForeignKeys.length === 0 ? {} : { compositeForeignKeys }),
  };
}

function buildIndex(
  location: string,
  attribute: Attribute,
  entries: IndexEntry[],
  warnings: string[]
): IrIndex {
  const mapArgument: string | undefined = namedArgument(attribute, 'map');
  const typeArgument: string | undefined = namedArgument(attribute, 'type');
  const fieldOptions: Record<string, IrIndexFieldOptions> = {};
  for (const entry of entries) {
    if (Object.keys(entry.options).length > 0) {
      fieldOptions[entry.name] = entry.options;
    }
  }
  const clustered: boolean | undefined = booleanArgument(
    attribute,
    'clustered'
  );
  if (
    attribute.name === 'unique' &&
    namedArgument(attribute, 'name') !== undefined
  ) {
    warnings.push(
      `${location}: the client-side key name (name: ...) is not kept; Prisma Client will use the default compound key name.`
    );
  }
  if (namedArgument(attribute, 'where') !== undefined) {
    warnings.push(
      `${location}: the partial index condition (where: ...) is not supported and was dropped.`
    );
  }
  return {
    fields: entries.map((entry: IndexEntry) => entry.name),
    isUnique: attribute.name === 'unique',
    ...(mapArgument === undefined ? {} : { name: unquote(mapArgument) }),
    ...(attribute.name === 'fulltext' ? { kind: 'fulltext' as const } : {}),
    ...(typeArgument === undefined ? {} : { method: typeArgument }),
    ...(clustered === undefined ? {} : { clustered }),
    ...(Object.keys(fieldOptions).length === 0 ? {} : { fieldOptions }),
  };
}

function scalarColumnName(field: PrismaField): string {
  const mapAttribute: Attribute | undefined = attributeNamed(
    field.attributes,
    'map'
  );
  return (
    (mapAttribute === undefined
      ? undefined
      : firstStringArgument(mapAttribute)) ?? field.name
  );
}

function referentialAction(
  relationAttribute: Attribute | undefined,
  key: string
): IrOnDelete | undefined {
  const raw: string | undefined = namedArgument(relationAttribute, key);
  return raw === undefined ? undefined : ON_DELETE_VALUES[raw];
}

/** True when the listed scalar fields are exactly a unique constraint or the primary key. */
function isUniqueSet(model: PrismaModel, names: string[]): boolean {
  const wanted: string = [...names].sort().join();
  const sameSet = (candidate: string[]): boolean =>
    [...candidate].sort().join() === wanted;
  if (names.length === 1) {
    const only: PrismaField | undefined = model.fields.find(
      (candidate: PrismaField) => candidate.name === names[0]
    );
    if (
      only !== undefined &&
      (attributeNamed(only.attributes, 'id') !== undefined ||
        attributeNamed(only.attributes, 'unique') !== undefined)
    ) {
      return true;
    }
  }
  return model.blockAttributes.some(
    (attribute: Attribute) =>
      (attribute.name === 'unique' || attribute.name === 'id') &&
      sameSet(
        parseNameList(
          positionalArgument(attribute) ?? namedArgument(attribute, 'fields')
        )
      )
  );
}

function buildCompositeForeignKey(
  model: PrismaModel,
  field: PrismaField,
  target: PrismaModel,
  keyColumns: string[],
  warnings: string[]
): IrCompositeForeignKey | undefined {
  const relationAttribute: Attribute | undefined = attributeNamed(
    field.attributes,
    'relation'
  );
  const references: string[] = parseNameList(
    namedArgument(relationAttribute, 'references')
  );
  const location: string = `${model.name}.${field.name}`;
  if (references.length !== keyColumns.length) {
    warnings.push(
      `${location}: the composite foreign key lists ${keyColumns.length} fields but ${references.length} references; the relation was skipped.`
    );
    return undefined;
  }
  const missingLocal: string | undefined = keyColumns.find(
    (name: string) =>
      !model.fields.some((candidate: PrismaField) => candidate.name === name)
  );
  if (missingLocal !== undefined) {
    warnings.push(
      `${location}: the foreign key field "${missingLocal}" does not exist on ${model.name}; the relation was skipped.`
    );
    return undefined;
  }
  const missingTarget: string | undefined = references.find(
    (name: string) =>
      !target.fields.some((candidate: PrismaField) => candidate.name === name)
  );
  if (missingTarget !== undefined) {
    warnings.push(
      `${location}: the referenced field "${missingTarget}" does not exist on ${target.name}; the relation was skipped.`
    );
    return undefined;
  }
  const onDelete: IrOnDelete =
    referentialAction(relationAttribute, 'onDelete') ??
    (field.isOptional ? 'setNull' : 'restrict');
  const onUpdate: IrOnDelete | undefined = referentialAction(
    relationAttribute,
    'onUpdate'
  );
  const constraint: string | undefined = namedArgument(
    relationAttribute,
    'map'
  );
  const inverse: PrismaField | undefined = findInverseField(
    model,
    field,
    target
  );
  return {
    name: field.name,
    targetModel: target.name,
    fields: keyColumns,
    references,
    kind: isUniqueSet(model, keyColumns) ? 'oneToOne' : 'foreignKey',
    isNullable: field.isOptional,
    onDelete,
    ...(onUpdate === undefined ? {} : { onUpdate }),
    ...(inverse === undefined ? {} : { relatedName: inverse.name }),
    ...(constraint === undefined
      ? {}
      : { constraintName: unquote(constraint) }),
  };
}

function buildForeignKey(
  model: PrismaModel,
  field: PrismaField,
  target: PrismaModel,
  consumedScalars: Map<string, string>,
  warnings: string[]
): IrRelation | undefined {
  const relationAttribute: Attribute | undefined = attributeNamed(
    field.attributes,
    'relation'
  );
  const foreignKeyNames: string[] = parseNameList(
    namedArgument(relationAttribute, 'fields')
  );
  const referenceNames: string[] = parseNameList(
    namedArgument(relationAttribute, 'references')
  );
  const location: string = `${model.name}.${field.name}`;

  const scalarName: string = foreignKeyNames[0] ?? '';
  const scalarField: PrismaField | undefined = model.fields.find(
    (candidate: PrismaField) => candidate.name === scalarName
  );
  if (scalarField === undefined) {
    warnings.push(
      `${location}: the foreign key field "${scalarName}" does not exist on ${model.name}; the relation was skipped.`
    );
    return undefined;
  }
  consumedScalars.set(scalarName, field.name);

  const isPrimaryKey: boolean =
    attributeNamed(scalarField.attributes, 'id') !== undefined;
  const isUnique: boolean = isUniqueSet(model, [scalarName]);

  const onDelete: IrOnDelete =
    referentialAction(relationAttribute, 'onDelete') ??
    (field.isOptional ? 'setNull' : 'restrict');
  const onUpdate: IrOnDelete | undefined = referentialAction(
    relationAttribute,
    'onUpdate'
  );
  const constraint: string | undefined = namedArgument(
    relationAttribute,
    'map'
  );

  const inverse: PrismaField | undefined = findInverseField(
    model,
    field,
    target
  );
  const referencedField: string | undefined = referenceNames[0];
  const targetKeyField: PrismaField | undefined = target.fields.find(
    (candidate: PrismaField) =>
      attributeNamed(candidate.attributes, 'id') !== undefined
  );
  const needsToField: boolean =
    referencedField !== undefined &&
    (targetKeyField === undefined || referencedField !== targetKeyField.name);

  return {
    name: field.name,
    kind: isPrimaryKey || isUnique ? 'oneToOne' : 'foreignKey',
    targetModel: target.name,
    columnName: scalarColumnName(scalarField),
    isNullable: field.isOptional,
    onDelete,
    ...(onUpdate === undefined ? {} : { onUpdate }),
    ...(inverse === undefined ? {} : { relatedName: inverse.name }),
    ...(needsToField && referencedField !== undefined
      ? { toField: referencedField }
      : {}),
    ...(isPrimaryKey ? { isPrimaryKey: true } : {}),
    ...(constraint === undefined
      ? {}
      : { constraintName: unquote(constraint) }),
  };
}

function numericArgument(value: string | undefined): number | undefined {
  return value !== undefined && /^\d+$/.test(value) ? Number(value) : undefined;
}

/** Prisma's default Decimal precision and scale when no @db.Decimal(p, s) is given. */
function defaultDecimal(provider: string | undefined): [number, number] {
  return provider === 'sqlserver' ? [32, 16] : [65, 30];
}

function buildScalarField(
  model: PrismaModel,
  field: PrismaField,
  enumNames: Set<string>,
  enums: IrEnum[],
  provider: string | undefined,
  warnings: string[]
): IrField | undefined {
  const location: string = `${model.name}.${field.name}`;
  const isEnum: boolean = enumNames.has(field.typeName);
  const isUnsupported: boolean = field.typeName === 'Unsupported';

  if (!isUnsupported && !isEnum && !SCALAR_TYPES.has(field.typeName)) {
    warnings.push(
      `${location}: the type "${field.typeName}" is not a known scalar, enum or model; the field was skipped.`
    );
    return undefined;
  }

  const nativeAttribute: Attribute | undefined = field.attributes.find(
    (attribute: Attribute) => attribute.name.startsWith('db.')
  );
  const nativeName: string =
    nativeAttribute === undefined ? '' : nativeAttribute.name.slice(3);
  const nativeArguments: string[] =
    nativeAttribute?.args === undefined
      ? []
      : splitTopLevel(nativeAttribute.args);

  let type: IrScalarType;
  let maxLength: number | undefined;
  let maxDigits: number | undefined;
  let decimalPlaces: number | undefined;
  let rangeOf: IrField['rangeOf'];
  let unsupportedType: string | undefined;

  if (isUnsupported) {
    const rawType: string = field.unsupportedType ?? '';
    const rangeSubtype: IrField['rangeOf'] = field.isList
      ? undefined
      : RANGE_TYPES[rawType.toLowerCase()];
    if (rangeSubtype !== undefined) {
      type = 'range';
      rangeOf = rangeSubtype;
    } else {
      type = 'unsupported';
      unsupportedType = rawType;
    }
  } else if (isEnum) {
    type = 'string';
  } else {
    switch (field.typeName) {
      case 'String':
        if (TEXT_TYPES.has(nativeName)) {
          type = 'text';
        } else if (nativeName === 'Uuid' || nativeName === 'UniqueIdentifier') {
          type = 'uuid';
        } else if (nativeName === 'Inet') {
          type = 'ipAddress';
        } else {
          type = 'string';
          if (LENGTH_TYPES.has(nativeName)) {
            maxLength = numericArgument(nativeArguments[0]);
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
      case 'Decimal': {
        type = 'decimal';
        if (nativeName !== 'Money' && nativeName !== 'SmallMoney') {
          const [defaultDigits, defaultPlaces]: [number, number] =
            defaultDecimal(provider);
          maxDigits = numericArgument(nativeArguments[0]) ?? defaultDigits;
          decimalPlaces = numericArgument(nativeArguments[1]) ?? defaultPlaces;
        }
        break;
      }
      case 'Boolean':
        type = 'boolean';
        break;
      case 'DateTime':
        type =
          nativeName === 'Date'
            ? 'date'
            : nativeName.startsWith('Time') &&
                !nativeName.startsWith('Timestamp')
              ? 'time'
              : 'dateTime';
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
  if (field.isList) {
    irField.arrayDepth = 1;
  }
  if (isEnum) {
    irField.enumName = field.typeName;
  }
  if (rangeOf !== undefined) {
    irField.rangeOf = rangeOf;
  }
  if (unsupportedType !== undefined) {
    irField.unsupportedType = unsupportedType;
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
  if (nativeAttribute !== undefined) {
    const nativeType: IrNativeType = {
      name: nativeName,
      args: nativeArguments,
    };
    irField.nativeType = nativeType;
  }
  if (attributeNamed(field.attributes, 'ignore') !== undefined) {
    irField.isIgnored = true;
  }
  const uniqueAttribute: Attribute | undefined = attributeNamed(
    field.attributes,
    'unique'
  );
  const uniqueName: string | undefined = namedArgument(uniqueAttribute, 'map');
  if (uniqueName !== undefined) {
    irField.uniqueName = unquote(uniqueName);
  }
  for (const option of ['sort', 'length', 'clustered']) {
    if (namedArgument(uniqueAttribute, option) !== undefined) {
      warnings.push(
        `${location}: the @unique option "${option}" is not supported and was dropped.`
      );
    }
  }

  const defaultAttribute: Attribute | undefined = attributeNamed(
    field.attributes,
    'default'
  );
  if (defaultAttribute !== undefined) {
    const parsedDefault: IrDefault | undefined = parseDefault(
      location,
      defaultAttribute,
      field.isList,
      isEnum
        ? enums.find((candidate: IrEnum) => candidate.name === field.typeName)
        : undefined,
      warnings
    );
    if (parsedDefault !== undefined) {
      irField.default = parsedDefault;
    }
  }
  return irField;
}

function parseDefault(
  location: string,
  attribute: Attribute,
  isList: boolean,
  enumDefinition: IrEnum | undefined,
  warnings: string[]
): IrDefault | undefined {
  const raw: string | undefined =
    positionalArgument(attribute) ?? namedArgument(attribute, 'value');
  if (raw === undefined) {
    return undefined;
  }
  const value: string = raw.trim();
  if (isList) {
    if (/^\[\s*\]$/.test(value)) {
      return { kind: 'literal', value: '[]' };
    }
    warnings.push(
      `${location}: the list default @default(${value}) could not be converted and was dropped.`
    );
    return undefined;
  }
  if (/^autoincrement\(\s*\)$/.test(value)) {
    return { kind: 'autoIncrement' };
  }
  if (/^now\(\s*\)$/.test(value)) {
    return { kind: 'now' };
  }
  const uuidMatch: RegExpExecArray | null = /^uuid\(\s*(\d*)\s*\)$/.exec(value);
  if (uuidMatch !== null) {
    const version: number | undefined = numericArgument(uuidMatch[1]);
    return version === undefined ? { kind: 'uuid' } : { kind: 'uuid', version };
  }
  const generatorMatch: RegExpExecArray | null =
    /^(cuid|nanoid|ulid)\(\s*(\d*)\s*\)$/.exec(value);
  if (generatorMatch !== null) {
    const generatorArgs: string = generatorMatch[2] ?? '';
    return {
      kind: 'clientGenerated',
      generator: generatorMatch[1] ?? '',
      ...(generatorArgs === '' ? {} : { args: generatorArgs }),
    };
  }
  const dbGeneratedMatch: RegExpExecArray | null =
    /^dbgenerated\(\s*("(?:[^"\\]|\\.)*")\s*\)$/.exec(value);
  if (dbGeneratedMatch !== null) {
    return {
      kind: 'dbExpression',
      expression: unquote(dbGeneratedMatch[1] ?? '""'),
    };
  }
  if (/^(auto|sequence)\(.*\)$/.test(value)) {
    return { kind: 'dbExpression', expression: value, isFunction: true };
  }
  if (/^dbgenerated\(.*\)$/.test(value)) {
    warnings.push(
      `${location}: @default(${value}) has no expression to carry over and was dropped.`
    );
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
  if (
    enumDefinition !== undefined &&
    enumDefinition.values.some((member) => member.name === value)
  ) {
    return { kind: 'enumValue', value };
  }
  warnings.push(
    `${location}: @default(${value}) could not be converted and was dropped.`
  );
  return undefined;
}
