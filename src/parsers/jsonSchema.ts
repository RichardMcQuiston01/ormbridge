/**
 * JSON Schema parser. Reads JSON Schema (draft 2020-12, 2019-09 and 7) and OpenAPI 3.x documents
 * (`components.schemas`) into the shared IR. The input is plain JSON, so no tree-sitter grammar is
 * needed; YAML is not read because no YAML parser is a dependency of this package.
 *
 * Each object schema under `$defs`, `definitions` or `components.schemas` (or a root object schema)
 * is a model. A property whose schema is a `$ref` to another model is a relation. See the README
 * section "JSON Schema (`--from json-schema`)" for the complete mapping.
 */

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type {
  IrDefault,
  IrEnum,
  IrEnumValue,
  IrField,
  IrIndex,
  IrModel,
  IrOnDelete,
  IrRelation,
  IrScalarType,
  IrSchema,
} from '../ir.js';
import { splitWords, toPascalCase, toSnakeCase } from '../naming.js';
import { describeThrown, err, ok, type Result } from '../result.js';

export interface JsonSchemaSourceFile {
  path: string;
  text: string;
}

export interface JsonSchemaParseOptions {
  /** App label stored on every model (JSON Schema has no equivalent). */
  appLabel: string;
}

type Json = Record<string, unknown>;

/** Maximum depth of `$ref` chains, `allOf` nesting and array nesting that is followed. */
const MAX_DEPTH: number = 32;

/** Schema collections that hold named schemas, as JSON pointer segments. */
const DEFINITION_COLLECTIONS: readonly (readonly string[])[] = [
  ['$defs'],
  ['definitions'],
  ['components', 'schemas'],
];

interface Doc {
  path: string;
  /** `file:` URI of the path; always a valid base. */
  fileUri: string;
  /** Base URI for relative references: the resolved `$id` when there is one, otherwise `fileUri`. */
  baseUri: string;
  root: Json;
  isOpenApi: boolean;
}

interface Located {
  doc: Doc;
  /** Canonical JSON pointer in the form `#/a/b` (`#` for the document root). */
  pointer: string;
  schema: Json;
}

type RefResolution =
  { ok: true; located: Located } | { ok: false; reason: string };

interface Member {
  schema: unknown;
  doc: Doc;
}

/** The properties of an object schema after `allOf` composition has been merged. */
interface ObjectShape {
  properties: Map<string, Member>;
  required: Set<string>;
  /** Names of the schemas whose properties were copied in through `allOf` or a sibling `$ref`. */
  inherited: string[];
  hasUnion: boolean;
  hasPatternProperties: boolean;
  hasAdditionalSchema: boolean;
  hasConditional: boolean;
}

interface ModelInfo {
  name: string;
  key: string;
  doc: Doc;
  schema: Json;
  shape: ObjectShape;
}

/** What a property schema turns out to be once references and wrappers are followed. */
interface Described {
  /** Set when the schema resolves to one of the models. */
  model?: ModelInfo;
  schema: Json;
  doc: Doc;
  /** Key of the last non-model `$defs` entry that was followed (names enums). */
  defName?: string;
  defKey?: string;
  nullable: boolean;
  /** Reason the schema could not be followed (unresolved or cyclic reference). */
  failure?: string;
}

interface ScalarInfo {
  type: IrScalarType;
  maxLength?: number;
  maxDigits?: number;
  decimalPlaces?: number;
  enumName?: string;
  arrayDepth?: number;
}

interface ToOneProp {
  name: string;
  target: ModelInfo;
  nullable: boolean;
  required: boolean;
  onDelete?: IrOnDelete;
  relatedName?: string;
  fkColumn?: string;
  paired: boolean;
}

interface ToManyProp {
  name: string;
  target: ModelInfo;
  paired: boolean;
}

interface BuiltModel {
  info: ModelInfo;
  fields: IrField[];
  toOne: ToOneProp[];
  toMany: ToManyProp[];
  relations: IrRelation[];
  indexes: IrIndex[];
  compositePrimaryKey?: string[];
}

interface Ctx {
  options: JsonSchemaParseOptions;
  warnings: string[];
  registry: Map<string, Doc>;
  modelsByKey: Map<string, ModelInfo>;
  enums: Map<string, IrEnum>;
  enumNameByKey: Map<string, string>;
}

function asRecord(value: unknown): Json | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Json)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

function asRecordOrEmpty(value: unknown): Json {
  return asRecord(value) ?? {};
}

function omitKey(record: Json, key: string): Json {
  const copy: Json = { ...record };
  delete copy[key];
  return copy;
}

function escapePointerSegment(segment: string): string {
  return segment.replace(/~/g, '~0').replace(/\//g, '~1');
}

function pointerOf(segments: readonly string[]): string {
  return `#${segments.map((segment: string) => `/${escapePointerSegment(segment)}`).join('')}`;
}

function lastSegment(pointer: string): string {
  const parts: string[] = pointer.split('/');
  const last: string = parts[parts.length - 1] ?? '';
  return last.replace(/~1/g, '/').replace(/~0/g, '~');
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/** Reads JSON Schema / OpenAPI documents into the IR. Never throws. */
export function parseJsonSchema(
  sources: JsonSchemaSourceFile[],
  options: JsonSchemaParseOptions
): Result<IrSchema> {
  try {
    return parseDocuments(sources, options);
  } catch (thrown) {
    return err(
      'PARSE_FAILED',
      `The JSON Schema input could not be converted: ${describeThrown(thrown)}`
    );
  }
}

function parseDocuments(
  sources: JsonSchemaSourceFile[],
  options: JsonSchemaParseOptions
): Result<IrSchema> {
  const ctx: Ctx = {
    options,
    warnings: [],
    registry: new Map<string, Doc>(),
    modelsByKey: new Map<string, ModelInfo>(),
    enums: new Map<string, IrEnum>(),
    enumNameByKey: new Map<string, string>(),
  };

  const docs: Doc[] = [];
  for (const source of sources) {
    const doc: Result<Doc> = readDocument(source, ctx);
    if (!doc.ok) {
      return doc;
    }
    docs.push(doc.value);
  }

  const infos: ModelInfo[] = discoverModels(docs, ctx);
  for (const doc of docs) {
    registerEnumDefinitions(doc, ctx);
  }
  if (infos.length === 0) {
    return err(
      'NO_MODELS_FOUND',
      `No object schemas with properties were found in: ${sources.map((source) => source.path).join(', ')}. ` +
        'A model is an object schema with properties under $defs, definitions or components.schemas, or a root object schema.'
    );
  }

  const built: BuiltModel[] = infos.map((info: ModelInfo): BuiltModel =>
    buildModel(info, ctx)
  );
  pairRelations(built, ctx);
  const models: IrModel[] = built.map((model: BuiltModel): IrModel =>
    finishModel(model, ctx)
  );
  return ok({
    models,
    enums: [...ctx.enums.values()],
    warnings: ctx.warnings,
  });
}

// ---------------------------------------------------------------------------
// Documents and references
// ---------------------------------------------------------------------------

function readDocument(source: JsonSchemaSourceFile, ctx: Ctx): Result<Doc> {
  const text: string =
    source.text.charCodeAt(0) === 0xfeff ? source.text.slice(1) : source.text;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (thrown) {
    const isYaml: boolean = /\.ya?ml$/i.test(source.path);
    return err(
      'PARSE_FAILED',
      `${source.path}: not valid JSON (${describeThrown(thrown)}).` +
        (isYaml
          ? ' YAML is not supported because the package has no YAML parser; convert the document to JSON first.'
          : '')
    );
  }
  const root: Json | undefined = asRecord(parsed);
  if (root === undefined) {
    return err(
      'PARSE_FAILED',
      `${source.path}: expected a JSON object at the top level (a JSON Schema or OpenAPI document), found ${
        Array.isArray(parsed) ? 'an array' : typeof parsed
      }.`
    );
  }
  const fileUri: string = pathToFileURL(resolve(source.path)).href;
  let baseUri: string = fileUri;
  const id: string | undefined = asString(root.$id);
  if (id !== undefined) {
    try {
      baseUri = new URL(id, fileUri).href.split('#')[0] ?? fileUri;
    } catch {
      ctx.warnings.push(
        `${source.path}: the $id "${id}" is not a valid URI reference and was ignored.`
      );
    }
  }
  const doc: Doc = {
    path: source.path,
    fileUri,
    baseUri,
    root,
    isOpenApi:
      typeof root.openapi === 'string' || typeof root.swagger === 'string',
  };
  for (const uri of new Set([fileUri, baseUri])) {
    const existing: Doc | undefined = ctx.registry.get(uri);
    if (existing !== undefined && existing !== doc) {
      ctx.warnings.push(
        `${source.path}: the identifier ${uri} is also used by ${existing.path}; references to it resolve to the first file.`
      );
      continue;
    }
    ctx.registry.set(uri, doc);
  }
  return ok(doc);
}

function navigate(
  doc: Doc,
  segments: string[]
): { found: true; value: unknown } | { found: false } {
  let current: unknown = doc.root;
  for (const segment of segments) {
    if (Array.isArray(current)) {
      const index: number = Number(segment);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) {
        return { found: false };
      }
      current = current[index];
    } else {
      const record: Json | undefined = asRecord(current);
      if (record === undefined || !Object.hasOwn(record, segment)) {
        return { found: false };
      }
      current = record[segment];
    }
  }
  return { found: true, value: current };
}

function resolveRef(ctx: Ctx, ref: string, from: Doc): RefResolution {
  let target: Doc | undefined;
  let hash: string = '';
  let attempted: string = '';
  for (const base of new Set([from.baseUri, from.fileUri])) {
    let url: URL;
    try {
      url = new URL(ref, base);
    } catch {
      continue;
    }
    const withoutHash: string = url.href.split('#')[0] ?? '';
    attempted = attempted === '' ? withoutHash : attempted;
    const found: Doc | undefined = ctx.registry.get(withoutHash);
    if (found !== undefined) {
      target = found;
      hash = url.hash;
      break;
    }
  }
  if (target === undefined) {
    return {
      ok: false,
      reason:
        attempted === ''
          ? `the reference "${ref}" is not a valid URI reference`
          : `the reference "${ref}" points to ${attempted}, which is not one of the input files (remote references are not fetched)`,
    };
  }
  let fragment: string = hash.startsWith('#') ? hash.slice(1) : hash;
  try {
    fragment = decodeURIComponent(fragment);
  } catch {
    return {
      ok: false,
      reason: `the reference "${ref}" has an invalid escape sequence in its fragment`,
    };
  }
  if (fragment !== '' && !fragment.startsWith('/')) {
    return {
      ok: false,
      reason: `the reference "${ref}" uses a named anchor, which is not supported (use a JSON pointer such as #/$defs/Name)`,
    };
  }
  const segments: string[] =
    fragment === ''
      ? []
      : fragment
          .slice(1)
          .split('/')
          .map((segment: string) =>
            segment.replace(/~1/g, '/').replace(/~0/g, '~')
          );
  const navigated: { found: true; value: unknown } | { found: false } =
    navigate(target, segments);
  if (!navigated.found) {
    return {
      ok: false,
      reason: `the reference "${ref}" does not resolve to anything in ${target.path}`,
    };
  }
  const schema: Json | undefined =
    typeof navigated.value === 'boolean' ? {} : asRecord(navigated.value);
  if (schema === undefined) {
    return {
      ok: false,
      reason: `the reference "${ref}" does not point to a schema`,
    };
  }
  return {
    ok: true,
    located: { doc: target, pointer: pointerOf(segments), schema },
  };
}

function locationKey(located: Located): string {
  return `${located.doc.fileUri}${located.pointer}`;
}

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

/** Merges `allOf` members and sibling `$ref`s into one object shape. */
function collectShape(
  schema: Json,
  doc: Doc,
  ctx: Ctx,
  seen: Set<Json>,
  depth: number
): ObjectShape {
  const shape: ObjectShape = {
    properties: new Map<string, Member>(),
    required: new Set<string>(),
    inherited: [],
    hasUnion: false,
    hasPatternProperties: false,
    hasAdditionalSchema: false,
    hasConditional: false,
  };
  if (seen.has(schema) || depth > MAX_DEPTH) {
    return shape;
  }
  seen.add(schema);

  const parents: unknown[] = [];
  const ref: string | undefined = asString(schema.$ref);
  if (ref !== undefined) {
    parents.push({ $ref: ref });
  }
  if (Array.isArray(schema.allOf)) {
    parents.push(...(schema.allOf as unknown[]));
  }
  for (const parent of parents) {
    const member: Json | undefined = asRecord(parent);
    if (member === undefined) {
      continue;
    }
    let memberSchema: Json = member;
    let memberDoc: Doc = doc;
    const memberRef: string | undefined = asString(member.$ref);
    if (memberRef !== undefined) {
      const resolved: RefResolution = resolveRef(ctx, memberRef, doc);
      if (!resolved.ok) {
        ctx.warnings.push(
          `${doc.path}: allOf member skipped because ${resolved.reason}.`
        );
        continue;
      }
      memberSchema = resolved.located.schema;
      memberDoc = resolved.located.doc;
      const inheritedFrom: ModelInfo | undefined = ctx.modelsByKey.get(
        locationKey(resolved.located)
      );
      shape.inherited.push(
        inheritedFrom?.name ?? lastSegment(resolved.located.pointer)
      );
    }
    const inner: ObjectShape = collectShape(
      memberSchema,
      memberDoc,
      ctx,
      seen,
      depth + 1
    );
    for (const [name, value] of inner.properties) {
      shape.properties.set(name, value);
    }
    for (const name of inner.required) {
      shape.required.add(name);
    }
    shape.inherited.push(...inner.inherited);
    shape.hasUnion ||= inner.hasUnion;
    shape.hasPatternProperties ||= inner.hasPatternProperties;
    shape.hasAdditionalSchema ||= inner.hasAdditionalSchema;
    shape.hasConditional ||= inner.hasConditional;
  }

  const properties: Json | undefined = asRecord(schema.properties);
  if (properties !== undefined) {
    for (const [name, value] of Object.entries(properties)) {
      shape.properties.set(name, { schema: value, doc });
    }
  }
  if (Array.isArray(schema.required)) {
    for (const name of schema.required) {
      if (typeof name === 'string') {
        shape.required.add(name);
      }
    }
  }
  shape.hasUnion ||=
    (Array.isArray(schema.oneOf) || Array.isArray(schema.anyOf)) &&
    properties === undefined;
  shape.hasPatternProperties ||=
    asRecord(schema.patternProperties) !== undefined;
  shape.hasAdditionalSchema ||=
    asRecord(schema.additionalProperties) !== undefined;
  shape.hasConditional ||=
    schema.if !== undefined ||
    schema.then !== undefined ||
    schema.else !== undefined;
  return shape;
}

function sanitizeModelName(raw: string): string {
  const cleaned: string = raw
    .replace(/[^A-Za-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '');
  const name: string = cleaned === '' ? 'Model' : cleaned;
  return /^[0-9]/.test(name) ? `_${name}` : name;
}

function rootModelName(doc: Doc): string {
  const title: string | undefined = asString(doc.root.title);
  if (title !== undefined && title.trim() !== '') {
    const pascal: string = toPascalCase(title);
    return pascal === '' ? sanitizeModelName(title) : pascal;
  }
  const idSource: string = asString(doc.root.$id) ?? doc.path;
  const segments: string[] = idSource.split(/[\\/]/).filter((s) => s !== '');
  const file: string = (segments[segments.length - 1] ?? 'Root')
    .replace(/#.*$/, '')
    .replace(/(\.schema)?\.json$/i, '');
  const pascal: string = toPascalCase(file);
  return pascal === '' ? 'Root' : pascal;
}

function isEnumLike(schema: Json): boolean {
  return Array.isArray(schema.enum) || allConstMembers(schema) !== undefined;
}

/** The `{const, title}` members of a `oneOf`/`anyOf` that only lists constants (an enum spelled with labels). */
function allConstMembers(schema: Json): Json[] | undefined {
  for (const keyword of ['oneOf', 'anyOf']) {
    const members: unknown = schema[keyword];
    if (
      Array.isArray(members) &&
      members.length > 0 &&
      members.every(
        (member: unknown) =>
          asRecord(member) !== undefined &&
          Object.hasOwn(member as Json, 'const')
      )
    ) {
      return members as Json[];
    }
  }
  return undefined;
}

interface PendingModel {
  located: Located;
  name: string;
  shape: ObjectShape;
}

/** The schemas of a document that may be models: the root and every named schema. */
function candidateSchemas(doc: Doc): Located[] {
  const candidates: Located[] = [];
  if (!doc.isOpenApi) {
    candidates.push({ doc, pointer: '#', schema: doc.root });
  }
  for (const collection of DEFINITION_COLLECTIONS) {
    const navigated: { found: true; value: unknown } | { found: false } =
      navigate(doc, [...collection]);
    const entries: Json | undefined = navigated.found
      ? asRecord(navigated.value)
      : undefined;
    if (entries === undefined) {
      continue;
    }
    for (const [key, value] of Object.entries(entries)) {
      const schema: Json | undefined = asRecord(value);
      if (schema !== undefined) {
        candidates.push({
          doc,
          pointer: pointerOf([...collection, key]),
          schema,
        });
      }
    }
  }
  return candidates;
}

/** A oneOf/anyOf whose alternatives are references (a polymorphic type), apart from a null alternative. */
function isUnionOfReferences(schema: Json): boolean {
  for (const keyword of ['oneOf', 'anyOf']) {
    const members: unknown = schema[keyword];
    if (Array.isArray(members)) {
      const references: number = members.filter(
        (member: unknown) => asString(asRecord(member)?.$ref) !== undefined
      ).length;
      if (references >= 2) {
        return true;
      }
    }
  }
  return false;
}

function looksLikeObject(schema: Json): boolean {
  return (
    schema.type === 'object' ||
    (Array.isArray(schema.type) && schema.type.includes('object')) ||
    schema.properties !== undefined ||
    Array.isArray(schema.allOf)
  );
}

function discoverModels(docs: Doc[], ctx: Ctx): ModelInfo[] {
  const pending: PendingModel[] = [];
  // Pass 1 registers every candidate, so that allOf parents (in any file) are recognised as models.
  for (const doc of docs) {
    for (const located of candidateSchemas(doc)) {
      if (isEnumLike(located.schema)) {
        continue;
      }
      const name: string =
        located.pointer === '#'
          ? rootModelName(doc)
          : sanitizeModelName(lastSegment(located.pointer));
      if (!looksLikeObject(located.schema)) {
        if (located.pointer !== '#' && isUnionOfReferences(located.schema)) {
          ctx.warnings.push(
            `${name}: a oneOf/anyOf schema has no database meaning, so it was not converted to a model.`
          );
        }
        continue;
      }
      const shape: ObjectShape = collectShape(
        located.schema,
        doc,
        ctx,
        new Set<Json>(),
        0
      );
      if (shape.properties.size === 0) {
        if (
          located.pointer !== '#' &&
          (shape.hasUnion || located.schema.discriminator !== undefined)
        ) {
          ctx.warnings.push(
            `${name}: a oneOf/anyOf schema has no database meaning, so it was not converted to a model.`
          );
        }
        continue;
      }
      pending.push({ located, name, shape });
      ctx.modelsByKey.set(locationKey(located), {
        name,
        key: locationKey(located),
        doc,
        schema: located.schema,
        shape,
      });
    }
  }

  // Pass 2 settles the names and re-reads the shapes now that the parents are known.
  const found: ModelInfo[] = [];
  const takenNames: Set<string> = new Set<string>();
  for (const entry of pending) {
    let name: string = entry.name;
    if (takenNames.has(name)) {
      let counter: number = 2;
      while (takenNames.has(`${entry.name}${counter}`)) {
        counter += 1;
      }
      name = `${entry.name}${counter}`;
      ctx.warnings.push(
        `${name}: the model name "${entry.name}" is already used by another schema, so this one (${entry.located.doc.path}${entry.located.pointer}) was renamed.`
      );
    }
    takenNames.add(name);
    const key: string = locationKey(entry.located);
    const info: ModelInfo = {
      name,
      key,
      doc: entry.located.doc,
      schema: entry.located.schema,
      shape: entry.shape,
    };
    ctx.modelsByKey.set(key, info);
    found.push(info);
  }
  for (const info of found) {
    info.shape = collectShape(info.schema, info.doc, ctx, new Set<Json>(), 0);
  }
  return found;
}

function registerEnumDefinitions(doc: Doc, ctx: Ctx): void {
  for (const collection of DEFINITION_COLLECTIONS) {
    const navigated: { found: true; value: unknown } | { found: false } =
      navigate(doc, [...collection]);
    const entries: Json | undefined = navigated.found
      ? asRecord(navigated.value)
      : undefined;
    if (entries === undefined) {
      continue;
    }
    for (const [key, value] of Object.entries(entries)) {
      const schema: Json | undefined = asRecord(value);
      if (schema === undefined || !isEnumLike(schema)) {
        continue;
      }
      const pointer: string = pointerOf([...collection, key]);
      const described: Described = {
        schema,
        doc,
        defName: key,
        defKey: `${doc.fileUri}${pointer}`,
        nullable: false,
      };
      enumFor(ctx, described, `${sanitizeModelName(key)}`, key, undefined);
    }
  }
}

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

function enumMemberName(value: string, index: number): string {
  const words: string[] = splitWords(value);
  if (words.length === 0) {
    return value === '' ? 'EMPTY' : `VALUE_${index + 1}`;
  }
  const name: string = words
    .map((word: string) => word.toUpperCase())
    .join('_');
  return /^[0-9]/.test(name) ? `_${name}` : name;
}

/** Reads the string members of an enum schema, or undefined when it is not a string enum. */
function readEnumValues(
  schema: Json
): { values: IrEnumValue[]; hasNull: boolean } | undefined {
  const constMembers: Json[] | undefined = allConstMembers(schema);
  let raw: unknown[];
  let labels: (string | undefined)[] = [];
  if (Array.isArray(schema.enum)) {
    raw = schema.enum as unknown[];
  } else if (constMembers !== undefined) {
    raw = constMembers.map((member: Json) => member.const);
    labels = constMembers.map((member: Json) => asString(member.title));
  } else {
    return undefined;
  }
  const hasNull: boolean = raw.includes(null);
  const strings: unknown[] = raw.filter((value: unknown) => value !== null);
  if (
    strings.length === 0 ||
    !strings.every((value: unknown) => typeof value === 'string')
  ) {
    return undefined;
  }
  const varNames: unknown =
    schema['x-enum-varnames'] ??
    schema['x-enumNames'] ??
    schema['x-enum-names'];
  const seen: Set<string> = new Set<string>();
  const values: IrEnumValue[] = [];
  (strings as string[]).forEach((value: string, index: number): void => {
    if (values.some((existing: IrEnumValue) => existing.dbValue === value)) {
      return;
    }
    const given: unknown = Array.isArray(varNames)
      ? varNames[index]
      : undefined;
    let name: string =
      typeof given === 'string' && given !== ''
        ? given
        : enumMemberName(value, index);
    while (seen.has(name)) {
      name = `${name}_${index + 1}`;
    }
    seen.add(name);
    const label: string | undefined = labels[index];
    values.push({
      name,
      dbValue: value,
      ...(label === undefined ? {} : { label }),
    });
  });
  return { values, hasNull };
}

/**
 * Returns the IR enum for an enum schema, creating it on first use. `preferred` is the name to try first
 * (the `$defs` entry or the property); `modelName` disambiguates a clash.
 */
function enumFor(
  ctx: Ctx,
  described: Described,
  preferred: string,
  location: string,
  modelName: string | undefined
): string | undefined {
  const read: { values: IrEnumValue[]; hasNull: boolean } | undefined =
    readEnumValues(described.schema);
  if (read === undefined) {
    return undefined;
  }
  if (described.defKey !== undefined) {
    const known: string | undefined = ctx.enumNameByKey.get(described.defKey);
    if (known !== undefined) {
      return known;
    }
  }
  const sameValues = (other: IrEnum): boolean =>
    other.values.length === read.values.length &&
    other.values.every(
      (value: IrEnumValue, index: number) =>
        value.dbValue === read.values[index]?.dbValue
    );
  const base: string = sanitizeModelName(
    described.defName === undefined
      ? toPascalCase(preferred) || preferred
      : preferred
  );
  const candidates: string[] = [
    base,
    ...(modelName === undefined ? [] : [`${modelName}${toPascalCase(base)}`]),
  ];
  let chosen: string | undefined;
  for (const candidate of candidates) {
    const existing: IrEnum | undefined = ctx.enums.get(candidate);
    if (
      existing === undefined ||
      (described.defKey === undefined && sameValues(existing))
    ) {
      chosen = candidate;
      break;
    }
  }
  if (chosen === undefined) {
    let counter: number = 2;
    const stem: string = candidates[candidates.length - 1] ?? base;
    while (ctx.enums.has(`${stem}${counter}`)) {
      counter += 1;
    }
    chosen = `${stem}${counter}`;
    ctx.warnings.push(
      `${location}: the enum name "${base}" is already used with different values, so this enum was named "${chosen}".`
    );
  }
  if (!ctx.enums.has(chosen)) {
    ctx.enums.set(chosen, { name: chosen, values: read.values });
  }
  if (described.defKey !== undefined) {
    ctx.enumNameByKey.set(described.defKey, chosen);
  }
  return chosen;
}

// ---------------------------------------------------------------------------
// Describing a property schema
// ---------------------------------------------------------------------------

/** Merges `allOf` members of a schema that is not a model into one schema (first `$ref` wins). */
function flattenAllOf(schema: Json, depth: number): Json {
  if (!Array.isArray(schema.allOf) || depth > MAX_DEPTH) {
    return schema;
  }
  const { allOf, ...rest } = schema;
  let merged: Json = {};
  for (const member of allOf as unknown[]) {
    const record: Json | undefined = asRecord(member);
    if (record === undefined) {
      continue;
    }
    const flat: Json = flattenAllOf(record, depth + 1);
    const others: Json = omitKey(flat, '$ref');
    merged = {
      ...merged,
      ...others,
      ...(merged.$ref === undefined && flat.$ref !== undefined
        ? { $ref: flat.$ref }
        : {}),
    };
  }
  return { ...merged, ...rest };
}

function describeSchema(
  ctx: Ctx,
  schemaValue: unknown,
  startDoc: Doc,
  location: string
): Described {
  let current: Json = asRecordOrEmpty(schemaValue);
  let doc: Doc = startDoc;
  let nullable: boolean = false;
  let defName: string | undefined;
  let defKey: string | undefined;
  const visited: Set<string> = new Set<string>();
  for (let step: number = 0; step <= MAX_DEPTH; step += 1) {
    current = flattenAllOf(current, 0);
    if (current.nullable === true) {
      nullable = true;
    }
    // `anyOf`/`oneOf` of one schema and null is how nullable references are written.
    for (const keyword of ['anyOf', 'oneOf']) {
      const members: unknown = current[keyword];
      if (!Array.isArray(members)) {
        continue;
      }
      const nonNull: unknown[] = members.filter(
        (member: unknown) => asRecord(member)?.type !== 'null'
      );
      if (nonNull.length === 1 && nonNull.length < members.length) {
        current = {
          ...omitKey(current, keyword),
          ...asRecordOrEmpty(nonNull[0]),
        };
        nullable = true;
      }
    }
    const ref: string | undefined = asString(current.$ref);
    if (ref === undefined) {
      return { schema: current, doc, defName, defKey, nullable };
    }
    const resolved: RefResolution = resolveRef(ctx, ref, doc);
    if (!resolved.ok) {
      return {
        schema: {},
        doc,
        nullable,
        failure: `${location}: ${resolved.reason}; the property was kept as a json column.`,
      };
    }
    const key: string = locationKey(resolved.located);
    const model: ModelInfo | undefined = ctx.modelsByKey.get(key);
    if (model !== undefined) {
      return { model, schema: current, doc, nullable };
    }
    if (visited.has(key)) {
      return {
        schema: {},
        doc,
        nullable,
        failure: `${location}: the reference "${ref}" is part of a reference cycle that never reaches an object schema; the property was kept as a json column.`,
      };
    }
    visited.add(key);
    current = { ...resolved.located.schema, ...omitKey(current, '$ref') };
    doc = resolved.located.doc;
    defName = lastSegment(resolved.located.pointer);
    defKey = key;
  }
  return {
    schema: {},
    doc,
    nullable,
    failure: `${location}: references are nested more than ${MAX_DEPTH} levels deep; the property was kept as a json column.`,
  };
}

/**
 * Integers and decimals travel as strings in JSON so no precision is lost; the pattern says which.
 * Reads `^-?[0-9]+$` (bigInt), `^-?[0-9]+(\.[0-9]+)?$` (decimal) and the same with a digit limit
 * (`^-?[0-9]{1,6}(\.[0-9]{1,2})?$` is decimal(8, 2)), which is how ormbridge's own JSON Schema
 * emitter writes them.
 */
function numericPattern(
  pattern: string | undefined
):
  | { type: IrScalarType; maxDigits?: number; decimalPlaces?: number }
  | undefined {
  if (pattern === undefined) {
    return undefined;
  }
  if (pattern === '^-?[0-9]+$') {
    return { type: 'bigInt' };
  }
  if (pattern === '^-?[0-9]+(\\.[0-9]+)?$') {
    return { type: 'decimal' };
  }
  const limited: RegExpExecArray | null =
    /^\^-\?(?:\[0-9\]\{1,(\d+)\}|0\?)(?:\(\\\.\[0-9\]\{1,(\d+)\}\)\?)?\$$/.exec(
      pattern
    );
  if (limited === null) {
    return undefined;
  }
  const whole: number = Number(limited[1] ?? '0');
  const places: number = Number(limited[2] ?? '0');
  return { type: 'decimal', maxDigits: whole + places, decimalPlaces: places };
}

/** Maps a scalar `type`/`format` pair to an IR type. */
function scalarType(
  type: string,
  schema: Json
): { type: IrScalarType; maxDigits?: number; decimalPlaces?: number } {
  const format: string = asString(schema.format) ?? '';
  if (
    type === 'string' &&
    (schema.contentEncoding === 'base64' ||
      format === 'byte' ||
      format === 'binary')
  ) {
    return { type: 'bytes' };
  }
  if (type === 'string' && schema.contentMediaType === 'application/json') {
    return { type: 'json' };
  }
  const patterned: ReturnType<typeof scalarType> | undefined =
    type === 'string' ? numericPattern(asString(schema.pattern)) : undefined;
  if (patterned !== undefined && format === '') {
    return patterned;
  }
  if (format === 'decimal' || format === 'money') {
    const precision: number | undefined = asNumber(schema['x-precision']);
    const scale: number | undefined = asNumber(schema['x-scale']);
    const multiple: number | undefined = asNumber(schema.multipleOf);
    const derivedScale: number | undefined =
      multiple !== undefined && multiple > 0 && multiple < 1
        ? Math.max(0, Math.round(-Math.log10(multiple)))
        : undefined;
    return {
      type: 'decimal',
      ...(precision === undefined ? {} : { maxDigits: precision }),
      ...(scale !== undefined
        ? { decimalPlaces: scale }
        : derivedScale === undefined
          ? {}
          : { decimalPlaces: derivedScale }),
    };
  }
  switch (type) {
    case 'string':
      switch (format) {
        case 'date-time':
          return { type: 'dateTime' };
        case 'date':
          return { type: 'date' };
        case 'time':
          return { type: 'time' };
        case 'uuid':
          return { type: 'uuid' };
        case 'duration':
          return { type: 'duration' };
        case 'ipv4':
        case 'ipv6':
          return { type: 'ipAddress' };
        case '':
          // A string with no length limit is unbounded text.
          return { type: schema.maxLength === undefined ? 'text' : 'string' };
        default:
          return { type: 'string' };
      }
    case 'integer':
      return {
        type:
          format === 'int64' || format === 'uint64' || format === 'unix-time'
            ? 'bigInt'
            : 'int',
      };
    case 'number':
      return {
        type:
          format === 'int32' ? 'int' : format === 'int64' ? 'bigInt' : 'float',
      };
    case 'boolean':
      return { type: 'boolean' };
    default:
      return { type: 'json' };
  }
}

/** Works out the column type of a described schema (never a model). */
function scalarOf(
  ctx: Ctx,
  described: Described,
  location: string,
  modelName: string,
  propertyName: string,
  depth: number
): ScalarInfo {
  const schema: Json = described.schema;
  if (described.failure !== undefined) {
    ctx.warnings.push(described.failure);
    return { type: 'json' };
  }

  const read: { values: IrEnumValue[]; hasNull: boolean } | undefined =
    readEnumValues(schema);
  if (read !== undefined) {
    const name: string | undefined = enumFor(
      ctx,
      described,
      described.defName ?? propertyName,
      location,
      modelName
    );
    if (name !== undefined) {
      const maxLength: number | undefined = asNumber(schema.maxLength);
      return {
        type: 'string',
        enumName: name,
        ...(maxLength === undefined ? {} : { maxLength }),
      };
    }
  }
  if (Array.isArray(schema.enum) || allConstMembers(schema) !== undefined) {
    ctx.warnings.push(
      `${location}: only enums of strings are supported, so the allowed values were dropped and the column keeps its plain type.`
    );
  }

  const oneOf: unknown = schema.oneOf ?? schema.anyOf;
  if (Array.isArray(oneOf) && allConstMembers(schema) === undefined) {
    ctx.warnings.push(
      `${location}: a oneOf/anyOf union has no database meaning, so the property was kept as a json column.`
    );
    return { type: 'json' };
  }

  const rawType: unknown = schema.type;
  let type: string | undefined;
  if (Array.isArray(rawType)) {
    const kinds: string[] = rawType.filter(
      (kind: unknown): kind is string =>
        typeof kind === 'string' && kind !== 'null'
    );
    if (kinds.length === 1) {
      type = kinds[0];
    } else if (kinds.length > 1) {
      ctx.warnings.push(
        `${location}: the type union ${JSON.stringify(rawType)} has no database meaning, so the property was kept as a json column.`
      );
      return { type: 'json' };
    }
  } else if (typeof rawType === 'string') {
    type = rawType;
  }
  if (type === undefined) {
    if (schema.properties !== undefined) {
      type = 'object';
    } else if (schema.items !== undefined || schema.prefixItems !== undefined) {
      type = 'array';
    } else if (Object.hasOwn(schema, 'const')) {
      const constant: unknown = schema.const;
      type =
        typeof constant === 'string'
          ? 'string'
          : typeof constant === 'number'
            ? Number.isInteger(constant)
              ? 'integer'
              : 'number'
            : typeof constant === 'boolean'
              ? 'boolean'
              : undefined;
    }
  }

  if (type === 'array') {
    return arrayOf(
      ctx,
      schema,
      described,
      location,
      modelName,
      propertyName,
      depth
    );
  }
  if (type === 'object') {
    if (asRecord(schema.patternProperties) !== undefined) {
      ctx.warnings.push(
        `${location}: patternProperties has no database meaning; the object was stored as a json column.`
      );
    } else if (asRecord(schema.additionalProperties) !== undefined) {
      ctx.warnings.push(
        `${location}: an object used as a map (additionalProperties) has no database meaning; it was stored as a json column.`
      );
    } else if (schema.properties !== undefined) {
      ctx.warnings.push(
        `${location}: a nested inline object was stored as a json column; its properties are not modelled. Define it under $defs to make it a model.`
      );
    }
    return { type: 'json' };
  }
  if (type === undefined) {
    return { type: 'json' };
  }
  const mapped: {
    type: IrScalarType;
    maxDigits?: number;
    decimalPlaces?: number;
  } = scalarType(type, schema);
  const maxLength: number | undefined = asNumber(schema.maxLength);
  return {
    ...mapped,
    ...(maxLength !== undefined && mapped.type === 'string'
      ? { maxLength }
      : {}),
  };
}

function arrayOf(
  ctx: Ctx,
  schema: Json,
  described: Described,
  location: string,
  modelName: string,
  propertyName: string,
  depth: number
): ScalarInfo {
  if (depth >= MAX_DEPTH || asRecord(schema.items) === undefined) {
    ctx.warnings.push(
      `${location}: an array without a single item schema was stored as a json column.`
    );
    return { type: 'json' };
  }
  const element: Described = describeSchema(
    ctx,
    schema.items,
    described.doc,
    location
  );
  if (element.model !== undefined) {
    ctx.warnings.push(
      `${location}: arrays of models are only supported as a relation property; here the array was stored as a json column.`
    );
    return { type: 'json' };
  }
  const inner: ScalarInfo = scalarOf(
    ctx,
    element,
    location,
    modelName,
    propertyName,
    depth + 1
  );
  if (inner.type === 'json' && inner.arrayDepth === undefined) {
    return { type: 'json' };
  }
  return { ...inner, arrayDepth: (inner.arrayDepth ?? 0) + 1 };
}

// ---------------------------------------------------------------------------
// Building models
// ---------------------------------------------------------------------------

function toOnDelete(value: unknown): IrOnDelete | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  switch (value.toLowerCase().replace(/[\s_-]+/g, '')) {
    case 'cascade':
      return 'cascade';
    case 'setnull':
      return 'setNull';
    case 'restrict':
      return 'restrict';
    case 'noaction':
      return 'noAction';
    case 'setdefault':
      return 'setDefault';
    default:
      return undefined;
  }
}

function buildDefault(
  field: ScalarInfo,
  schema: Json,
  location: string,
  ctx: Ctx
): IrDefault | undefined {
  if (!Object.hasOwn(schema, 'default')) {
    return undefined;
  }
  const value: unknown = schema.default;
  if (value === null) {
    return undefined;
  }
  if (field.arrayDepth !== undefined) {
    ctx.warnings.push(
      `${location}: the default of an array column was ignored.`
    );
    return undefined;
  }
  if (field.enumName !== undefined && typeof value === 'string') {
    const member: IrEnumValue | undefined = ctx.enums
      .get(field.enumName)
      ?.values.find((candidate: IrEnumValue) => candidate.dbValue === value);
    if (member === undefined) {
      ctx.warnings.push(
        `${location}: the default "${value}" is not a member of the enum "${field.enumName}" and was ignored.`
      );
      return undefined;
    }
    return { kind: 'enumValue', value: member.name };
  }
  if (field.type === 'json') {
    return { kind: 'literal', value: JSON.stringify(value) };
  }
  if (
    field.type === 'dateTime' &&
    typeof value === 'string' &&
    /^(now|now\(\)|current_timestamp(\(\))?)$/i.test(value)
  ) {
    return { kind: 'now' };
  }
  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return { kind: 'literal', value };
  }
  ctx.warnings.push(
    `${location}: the default ${JSON.stringify(value)} cannot be stored as a column default and was ignored.`
  );
  return undefined;
}

function isIdLike(name: string, modelName: string): boolean {
  const normalized: string = name.toLowerCase().replace(/_/g, '');
  return (
    name === 'id' ||
    normalized === `${modelName.toLowerCase().replace(/_/g, '')}id`
  );
}

function buildModel(info: ModelInfo, ctx: Ctx): BuiltModel {
  const shape: ObjectShape = info.shape;
  const built: BuiltModel = {
    info,
    fields: [],
    toOne: [],
    toMany: [],
    relations: [],
    indexes: [],
  };
  if (shape.inherited.length > 0) {
    ctx.warnings.push(
      `${info.name}: allOf composition was flattened; the properties of ${shape.inherited.join(', ')} were copied into the model and the inheritance is not represented.`
    );
  }
  if (shape.hasUnion) {
    ctx.warnings.push(
      `${info.name}: oneOf/anyOf has no database meaning and was ignored.`
    );
  }
  if (shape.hasPatternProperties) {
    ctx.warnings.push(
      `${info.name}: patternProperties has no database meaning and was ignored.`
    );
  }
  if (shape.hasAdditionalSchema) {
    ctx.warnings.push(
      `${info.name}: additionalProperties with a schema (a map) has no database meaning and was ignored.`
    );
  }
  if (shape.hasConditional) {
    ctx.warnings.push(
      `${info.name}: if/then/else has no database meaning and was ignored.`
    );
  }

  const primaryMarked: string[] = [];
  const readOnlyNames: Set<string> = new Set<string>();

  for (const [name, member] of shape.properties) {
    const location: string = `${info.name}.${name}`;
    const propertySchema: Json = asRecordOrEmpty(member.schema);
    const required: boolean = shape.required.has(name);
    const described: Described = describeSchema(
      ctx,
      member.schema,
      member.doc,
      location
    );

    if (described.model !== undefined) {
      const nullable: boolean = described.nullable || !required;
      const relatedName: string | undefined =
        asString(propertySchema['x-related-name']) ??
        asString(described.schema['x-related-name']);
      const onDelete: IrOnDelete | undefined = toOnDelete(
        propertySchema['x-on-delete'] ?? described.schema['x-on-delete']
      );
      built.toOne.push({
        name,
        target: described.model,
        nullable,
        required,
        paired: false,
        ...(onDelete === undefined ? {} : { onDelete }),
        ...(relatedName === undefined ? {} : { relatedName }),
      });
      continue;
    }

    // An array of models is the to-many side of a relation.
    if (
      described.failure === undefined &&
      described.schema.type === 'array' &&
      asRecord(described.schema.items) !== undefined
    ) {
      const element: Described = describeSchema(
        ctx,
        described.schema.items,
        described.doc,
        location
      );
      if (element.model !== undefined) {
        built.toMany.push({ name, target: element.model, paired: false });
        continue;
      }
    }

    const scalar: ScalarInfo = scalarOf(
      ctx,
      described,
      location,
      info.name,
      name,
      0
    );
    const merged: Json = { ...described.schema, ...propertySchema };
    // Null is allowed by the type; an optional property without a default or a generated value is
    // nullable too (the column may stay empty).
    const allowsNull: boolean =
      described.nullable ||
      (Array.isArray(merged.type) && merged.type.includes('null')) ||
      (Array.isArray(merged.enum) && merged.enum.includes(null));
    const field: IrField = {
      name,
      columnName: name,
      type: scalar.type,
      isPrimaryKey: false,
      isUnique: merged['x-unique'] === true,
      isNullable: allowsNull,
      isAutoUpdated: false,
      ...(scalar.maxLength === undefined
        ? {}
        : { maxLength: scalar.maxLength }),
      ...(scalar.maxDigits === undefined
        ? {}
        : { maxDigits: scalar.maxDigits }),
      ...(scalar.decimalPlaces === undefined
        ? {}
        : { decimalPlaces: scalar.decimalPlaces }),
      ...(scalar.enumName === undefined ? {} : { enumName: scalar.enumName }),
      ...(scalar.arrayDepth === undefined
        ? {}
        : { arrayDepth: scalar.arrayDepth }),
    };
    const defaultValue: IrDefault | undefined = buildDefault(
      scalar,
      merged,
      location,
      ctx
    );
    if (defaultValue !== undefined) {
      field.default = defaultValue;
    }
    if (merged.readOnly === true && field.default === undefined) {
      applyReadOnlyHint(field);
    }
    if (
      !required &&
      merged.readOnly !== true &&
      field.default === undefined &&
      !Object.hasOwn(merged, 'default')
    ) {
      field.isNullable = true;
    }
    if (merged['x-primary-key'] === true) {
      primaryMarked.push(name);
    }
    if (merged['x-index'] === true) {
      built.indexes.push({ fields: [name], isUnique: false });
    }
    if (merged.readOnly === true) {
      readOnlyNames.add(name);
    }
    built.fields.push(field);
  }

  // Foreign key columns declared next to the relation (authorId, author_id) become the relation's column.
  for (const relation of built.toOne) {
    const wanted: string = relation.name.toLowerCase().replace(/_/g, '');
    const column: IrField | undefined = built.fields.find(
      (field: IrField) =>
        field.name.toLowerCase().replace(/_/g, '') === `${wanted}id` &&
        ['int', 'bigInt', 'uuid', 'string', 'text'].includes(field.type) &&
        field.arrayDepth === undefined &&
        !primaryMarked.includes(field.name)
    );
    if (column !== undefined) {
      relation.fkColumn = column.name;
      // The column holds the key, so its nullability is the relation's (the property that expands
      // the reference is usually optional whatever the column says).
      relation.nullable = column.isNullable;
      relation.required = !column.isNullable;
      built.fields.splice(built.fields.indexOf(column), 1);
    }
  }

  assignPrimaryKey(built, primaryMarked, readOnlyNames, info, ctx);

  const modelIndexes: unknown = info.schema['x-indexes'];
  if (Array.isArray(modelIndexes)) {
    for (const entry of modelIndexes) {
      const record: Json | undefined = asRecord(entry);
      const fields: unknown = record?.fields;
      if (
        record === undefined ||
        !Array.isArray(fields) ||
        fields.length === 0 ||
        !fields.every((item: unknown) => typeof item === 'string')
      ) {
        ctx.warnings.push(
          `${info.name}: an x-indexes entry without a "fields" array of property names was ignored.`
        );
        continue;
      }
      const name: string | undefined = asString(record.name);
      built.indexes.push({
        fields: fields as string[],
        isUnique: record.unique === true,
        ...(name === undefined ? {} : { name }),
      });
    }
  }
  return built;
}

/** `readOnly` marks a value the database produces: keys count up, uuids are generated, timestamps are set. */
function applyReadOnlyHint(field: IrField): void {
  if (field.type === 'uuid') {
    field.default = { kind: 'uuid' };
  } else if (field.type === 'dateTime') {
    if (/^updated/i.test(field.name.replace(/_/g, ''))) {
      field.isAutoUpdated = true;
    } else {
      field.default = { kind: 'now' };
    }
  }
}

function assignPrimaryKey(
  built: BuiltModel,
  marked: string[],
  readOnlyNames: Set<string>,
  info: ModelInfo,
  ctx: Ctx
): void {
  const fieldNamed = (name: string): IrField | undefined =>
    built.fields.find((field: IrField) => field.name === name);
  let keyNames: string[] = marked;
  const modelLevel: unknown = info.schema['x-primary-key'];
  if (keyNames.length === 0 && Array.isArray(modelLevel)) {
    keyNames = modelLevel.filter(
      (name: unknown): name is string =>
        typeof name === 'string' && fieldNamed(name) !== undefined
    );
  }
  if (keyNames.length === 0) {
    const candidate: IrField | undefined =
      fieldNamed('id') ??
      built.fields.find((field: IrField) => isIdLike(field.name, info.name));
    const usable: string[] = [
      'int',
      'bigInt',
      'string',
      'text',
      'uuid',
      'decimal',
    ];
    if (
      candidate !== undefined &&
      usable.includes(candidate.type) &&
      candidate.arrayDepth === undefined
    ) {
      keyNames = [candidate.name];
    }
  }

  if (keyNames.length === 0) {
    const takenId: boolean = built.fields.some(
      (field: IrField) => field.name === 'id'
    );
    const name: string = takenId ? 'ormbridge_id' : 'id';
    ctx.warnings.push(
      `${info.name}: no primary key property was found (an id, ${info.name.charAt(0).toLowerCase()}${info.name.slice(1)}Id or x-primary-key property), so an integer "${name}" column was added.`
    );
    built.fields.unshift({
      name,
      columnName: name,
      type: 'int',
      isPrimaryKey: true,
      isUnique: false,
      isNullable: false,
      isAutoUpdated: false,
      default: { kind: 'autoIncrement' },
    });
    return;
  }

  if (keyNames.length > 1) {
    built.compositePrimaryKey = keyNames;
    for (const name of keyNames) {
      const field: IrField | undefined = fieldNamed(name);
      if (field !== undefined) {
        field.isNullable = false;
      }
    }
    return;
  }
  const keyField: IrField | undefined = fieldNamed(keyNames[0] ?? '');
  if (keyField === undefined) {
    return;
  }
  keyField.isPrimaryKey = true;
  keyField.isNullable = false;
  keyField.isUnique = false;
  if (keyField.default === undefined && readOnlyNames.has(keyField.name)) {
    if (keyField.type === 'int' || keyField.type === 'bigInt') {
      keyField.default = { kind: 'autoIncrement' };
    } else if (keyField.type === 'uuid') {
      keyField.default = { kind: 'uuid' };
    }
  }
}

// ---------------------------------------------------------------------------
// Relations
// ---------------------------------------------------------------------------

function relationColumn(name: string, fk: string | undefined): string {
  if (fk !== undefined) {
    return fk;
  }
  return `${toSnakeCase(name)}_id`;
}

function defaultOnDelete(prop: ToOneProp): IrOnDelete {
  return prop.onDelete ?? (prop.nullable ? 'setNull' : 'restrict');
}

function pairRelations(built: BuiltModel[], ctx: Ctx): void {
  const byInfo: Map<ModelInfo, BuiltModel> = new Map<ModelInfo, BuiltModel>(
    built.map((model: BuiltModel) => [model.info, model])
  );

  // To-one properties that point at each other are the two sides of a one-to-one relation.
  for (const model of built) {
    for (const prop of model.toOne) {
      if (prop.paired) {
        continue;
      }
      const other: BuiltModel | undefined = byInfo.get(prop.target);
      if (other !== undefined && hasArrayBack(model, prop, other)) {
        continue;
      }
      const reverse: ToOneProp[] =
        other?.toOne.filter(
          (candidate: ToOneProp) =>
            !candidate.paired &&
            candidate !== prop &&
            candidate.target === model.info &&
            !hasArrayBack(other, candidate, model) &&
            (candidate.relatedName === prop.name ||
              candidate.relatedName === undefined) &&
            (prop.relatedName === candidate.name ||
              prop.relatedName === undefined)
        ) ?? [];
      const sameFirst: ToOneProp[] = reverse.filter(
        (candidate: ToOneProp) =>
          prop.relatedName === candidate.name ||
          candidate.relatedName === prop.name
      );
      const chosen: ToOneProp[] = sameFirst.length > 0 ? sameFirst : reverse;
      const sibling: ToOneProp | undefined = chosen[0];
      if (other === undefined || sibling === undefined || chosen.length !== 1) {
        continue;
      }
      // The required side holds the foreign key; otherwise the model defined later does.
      const siblingOwns: boolean =
        sibling.required !== prop.required
          ? sibling.required
          : built.indexOf(other) > built.indexOf(model);
      if (sibling.required === prop.required) {
        ctx.warnings.push(
          `${model.info.name}.${prop.name} and ${other.info.name}.${sibling.name} reference each other and are read as one one-to-one relation owned by ${siblingOwns ? other.info.name : model.info.name}; mark the owning side as required to choose the direction.`
        );
      }
      const owner: ToOneProp = siblingOwns ? sibling : prop;
      const inverse: ToOneProp = siblingOwns ? prop : sibling;
      prop.paired = true;
      sibling.paired = true;
      const ownerModel: BuiltModel = siblingOwns ? other : model;
      ownerModel.relations.push({
        name: owner.name,
        kind: 'oneToOne',
        targetModel: owner.target.name,
        columnName: relationColumn(owner.name, owner.fkColumn),
        isNullable: owner.nullable,
        onDelete: defaultOnDelete(owner),
        relatedName: inverse.name,
      });
    }
  }

  // An array of models is the reverse of the foreign key on the other model, or a many-to-many when both sides are arrays.
  for (const model of built) {
    for (const many of model.toMany) {
      if (many.paired) {
        continue;
      }
      const other: BuiltModel | undefined = byInfo.get(many.target);
      if (other === undefined) {
        continue;
      }
      const foreignKeys: ToOneProp[] = other.toOne.filter(
        (candidate: ToOneProp) =>
          !candidate.paired && candidate.target === model.info
      );
      const named: ToOneProp[] = foreignKeys.filter(
        (candidate: ToOneProp) => candidate.relatedName === many.name
      );
      const foreignKey: ToOneProp | undefined =
        named[0] ?? (foreignKeys.length === 1 ? foreignKeys[0] : undefined);
      if (foreignKey !== undefined) {
        many.paired = true;
        foreignKey.paired = true;
        other.relations.push({
          name: foreignKey.name,
          kind: 'foreignKey',
          targetModel: model.info.name,
          columnName: relationColumn(foreignKey.name, foreignKey.fkColumn),
          isNullable: foreignKey.nullable,
          onDelete: defaultOnDelete(foreignKey),
          relatedName: many.name,
        });
        continue;
      }
      const unnamed: ToOneProp[] = foreignKeys.filter(
        (candidate: ToOneProp) => candidate.relatedName === undefined
      );
      const arrays: ToManyProp[] = model.toMany.filter(
        (candidate: ToManyProp) =>
          !candidate.paired && candidate.target === many.target
      );
      const byPosition: ToOneProp | undefined =
        arrays.length === unnamed.length
          ? unnamed[arrays.indexOf(many)]
          : undefined;
      if (byPosition !== undefined) {
        many.paired = true;
        byPosition.paired = true;
        ctx.warnings.push(
          `${model.info.name}.${many.name}: ${other.info.name} has ${unnamed.length} properties that reference ${model.info.name} (${unnamed.map((candidate: ToOneProp) => candidate.name).join(', ')}) and ${model.info.name} has as many arrays of ${other.info.name}, so they were matched in order of appearance and this array is the reverse of ${other.info.name}.${byPosition.name}. Set "x-related-name": "${many.name}" on the right property to say so explicitly.`
        );
        other.relations.push({
          name: byPosition.name,
          kind: 'foreignKey',
          targetModel: model.info.name,
          columnName: relationColumn(byPosition.name, byPosition.fkColumn),
          isNullable: byPosition.nullable,
          onDelete: defaultOnDelete(byPosition),
          relatedName: many.name,
        });
        continue;
      }
      if (foreignKeys.length > 1) {
        ctx.warnings.push(
          `${model.info.name}.${many.name}: ${other.info.name} has several properties that reference ${model.info.name} (${foreignKeys.map((candidate: ToOneProp) => candidate.name).join(', ')}), so it is unclear which one this array is the reverse of. Set "x-related-name": "${many.name}" on the right one. The array was ignored.`
        );
        many.paired = true;
        continue;
      }
      const mirrors: ToManyProp[] = other.toMany.filter(
        (candidate: ToManyProp) =>
          !candidate.paired &&
          candidate !== many &&
          candidate.target === model.info
      );
      if (mirrors.length === 1 && mirrors[0] !== undefined) {
        const mirror: ToManyProp = mirrors[0];
        many.paired = true;
        mirror.paired = true;
        // The model defined first owns the many-to-many field.
        const manyOwns: boolean = built.indexOf(model) <= built.indexOf(other);
        const owner: ToManyProp = manyOwns ? many : mirror;
        const inverse: ToManyProp = manyOwns ? mirror : many;
        (manyOwns ? model : other).relations.push({
          name: owner.name,
          kind: 'manyToMany',
          targetModel: owner.target.name,
          columnName: `${toSnakeCase(owner.name)}_id`,
          isNullable: false,
          onDelete: 'cascade',
          relatedName: inverse.name,
        });
        continue;
      }
      if (mirrors.length > 1) {
        ctx.warnings.push(
          `${model.info.name}.${many.name}: ${other.info.name} has several arrays of ${model.info.name}, so the many-to-many pairing is ambiguous and the array was ignored.`
        );
        many.paired = true;
        continue;
      }
      // Only one side is written down: the foreign key lives on the other model.
      many.paired = true;
      const reverseName: string = uniqueName(
        other,
        model.info.name.charAt(0).toLowerCase() + model.info.name.slice(1)
      );
      ctx.warnings.push(
        `${model.info.name}.${many.name}: ${other.info.name} does not reference ${model.info.name} back, so a nullable foreign key "${reverseName}" was added to ${other.info.name} to hold the relation (many-to-many needs an array on both sides).`
      );
      other.relations.push({
        name: reverseName,
        kind: 'foreignKey',
        targetModel: model.info.name,
        columnName: relationColumn(reverseName, undefined),
        isNullable: true,
        onDelete: 'setNull',
        relatedName: many.name,
      });
    }
  }

  // Remaining to-one properties are plain many-to-one foreign keys.
  for (const model of built) {
    for (const prop of model.toOne) {
      if (prop.paired) {
        continue;
      }
      prop.paired = true;
      model.relations.push({
        name: prop.name,
        kind: 'foreignKey',
        targetModel: prop.target.name,
        columnName: relationColumn(prop.name, prop.fkColumn),
        isNullable: prop.nullable,
        onDelete: defaultOnDelete(prop),
        ...(prop.relatedName === undefined
          ? {}
          : { relatedName: prop.relatedName }),
      });
    }
  }
}

/** True when `target` lists an array of `owner`'s model that is the reverse of the to-one `prop` of `owner`. */
function hasArrayBack(
  owner: BuiltModel,
  prop: ToOneProp,
  target: BuiltModel
): boolean {
  return target.toMany.some(
    (many: ToManyProp) =>
      many.target === owner.info &&
      (prop.relatedName === undefined || many.name === prop.relatedName)
  );
}

function uniqueName(model: BuiltModel, wanted: string): string {
  const taken = (name: string): boolean =>
    model.fields.some((field: IrField) => field.name === name) ||
    model.relations.some((relation: IrRelation) => relation.name === name) ||
    model.toOne.some((prop: ToOneProp) => prop.name === name) ||
    model.toMany.some((prop: ToManyProp) => prop.name === name);
  let name: string = wanted;
  let counter: number = 2;
  while (taken(name)) {
    name = `${wanted}${counter}`;
    counter += 1;
  }
  return name;
}

/** Relations in the order of the properties they came from (synthesized ones last). */
function sortRelations(built: BuiltModel): IrRelation[] {
  const order: string[] = [...built.info.shape.properties.keys()];
  const position = (relation: IrRelation): number => {
    const index: number = order.indexOf(relation.name);
    return index === -1 ? order.length : index;
  };
  return [...built.relations].sort(
    (first: IrRelation, second: IrRelation) =>
      position(first) - position(second)
  );
}

function finishModel(built: BuiltModel, ctx: Ctx): IrModel {
  const info: ModelInfo = built.info;
  const tableName: string = asString(info.schema['x-table-name']) ?? info.name;
  const names: Set<string> = new Set<string>([
    ...built.fields.map((field: IrField) => field.name),
    ...built.relations.map((relation: IrRelation) => relation.name),
  ]);
  const indexes: IrIndex[] = [];
  for (const index of built.indexes) {
    const unknown: string[] = index.fields.filter(
      (name: string) => !names.has(name)
    );
    if (unknown.length > 0) {
      ctx.warnings.push(
        `${info.name}: an index refers to ${unknown.join(', ')}, which ${unknown.length === 1 ? 'is' : 'are'} not ${unknown.length === 1 ? 'a property' : 'properties'} of the model, so it was ignored.`
      );
      continue;
    }
    indexes.push(index);
  }
  return {
    name: info.name,
    tableName,
    appLabel: ctx.options.appLabel,
    fields: built.fields,
    relations: sortRelations(built),
    indexes,
    ...(built.compositePrimaryKey === undefined
      ? {}
      : { compositePrimaryKey: built.compositePrimaryKey }),
  };
}
