import type Parser from 'web-tree-sitter';
import type {
  IrEnum,
  IrEnumValue,
  IrField,
  IrModel,
  IrRelation,
  IrSchema,
} from '../ir.js';
import { toPascalCase, toSnakeCase } from '../naming.js';
import { err, ok, type Result } from '../result.js';
import { getTypeScriptParser, type SyntaxNode } from './typescriptSyntax.js';
import {
  OBJECT_BASES,
  objectEnumValues,
  resolveFieldNode,
  type DeclaredKind,
  type EnumValues,
  type FieldHost,
  type FieldScope,
  type ResolvedField,
} from './zodFields.js';
import {
  describeZodFile,
  enumMembers,
  literalOf,
  objectMembers,
  shapeReference,
  stripWrappers,
  unwindChain,
  type ChainStep,
  type LiteralValue,
  type ZodChain,
  type ZodFileInfo,
} from './zodSyntax.js';

export interface ZodSourceFile {
  path: string;
  text: string;
}

export interface ZodParseOptions {
  /** App label stored on each model (Zod itself has no equivalent). */
  appLabel: string;
}

// ---------------------------------------------------------------------------
// Static tables
// ---------------------------------------------------------------------------

/** Methods that reshape an object schema; the reader applies them to the property list. */
const SHAPE_STEPS: ReadonlySet<string> = new Set([
  'extend',
  'safeExtend',
  'merge',
  'pick',
  'omit',
  'partial',
  'required',
  'deepPartial',
]);

/** Methods on an object schema that change nothing the shared model stores. */
const QUIET_OBJECT_STEPS: ReadonlySet<string> = new Set([
  'strict',
  'strip',
  'passthrough',
  'loose',
  'nonstrict',
  'catchall',
  'describe',
  'meta',
]);

/** Methods on an object schema that add rules the shared model cannot store. */
const RULE_OBJECT_STEPS: ReadonlySet<string> = new Set([
  'refine',
  'superRefine',
  'transform',
  'pipe',
  'brand',
  'check',
  'overwrite',
  'readonly',
]);

/** The suffixes the Zod writer adds to the schemas it derives from a model's row schema. */
const VARIANT_PATTERN: RegExp = /^(.+?)(Create|Update|WithRelations)(Schema)?$/;

const ENUM_BASES: ReadonlySet<string> = new Set(['enum', 'nativeEnum']);

/** Steps that leave a declared enum an enum (anything else makes it a property type to reuse). */
const ENUM_QUIET_STEPS: ReadonlySet<string> = new Set([
  'describe',
  'meta',
  'brand',
  'readonly',
]);

// ---------------------------------------------------------------------------
// Intermediate structures
// ---------------------------------------------------------------------------

type DeclKind =
  | 'object'
  | 'derived'
  | 'variant'
  | 'enum'
  | 'alias'
  | 'values'
  | 'shape'
  | 'other';

interface Declaration {
  file: ZodFileInfo;
  name: string;
  node: SyntaxNode;
}

/** One property of an object schema, before it is turned into a field. */
interface ShapeEntry {
  key: string;
  file: ZodFileInfo;
  node: SyntaxNode;
  partial: boolean;
  required: boolean;
}

interface Shape {
  entries: ShapeEntry[];
  /** Rules on the schema itself that the shared model cannot store. */
  dropped: string[];
  problems: string[];
}

interface PendingRelation {
  key: string;
  target: string;
  many: boolean;
  nullable: boolean;
}

interface Project {
  options: ZodParseOptions;
  files: ZodFileInfo[];
  declarations: Declaration[];
  byFile: Map<ZodFileInfo, Map<string, Declaration>>;
  global: Map<string, Declaration>;
  tsEnums: Map<string, { file: ZodFileInfo; node: SyntaxNode }>;
  kinds: Map<Declaration, DeclKind>;
  modelNames: Map<Declaration, string>;
  enumNames: Map<Declaration, string>;
  enums: IrEnum[];
  shapes: Map<Declaration, Shape | undefined>;
  hosts: Map<ZodFileInfo, FieldHost>;
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function parseZod(
  sources: ZodSourceFile[],
  options: ZodParseOptions
): Promise<Result<IrSchema>> {
  const parserResult: Result<Parser> = await getTypeScriptParser();
  if (!parserResult.ok) {
    return parserResult;
  }
  const parser: Parser = parserResult.value;

  const project: Project = {
    options,
    files: [],
    declarations: [],
    byFile: new Map(),
    global: new Map(),
    tsEnums: new Map(),
    kinds: new Map(),
    modelNames: new Map(),
    enumNames: new Map(),
    enums: [],
    shapes: new Map(),
    hosts: new Map(),
    warnings: [],
  };

  // The trees stay alive until the schema is built: the syntax nodes point into them.
  const trees: Parser.Tree[] = [];
  for (const source of sources) {
    const tree: Parser.Tree = parser.parse(source.text);
    trees.push(tree);
    const file: ZodFileInfo = describeZodFile(source.path, tree.rootNode);
    project.files.push(file);
    if (tree.rootNode.hasError) {
      project.warnings.push(
        `${file.label}: the file contains TypeScript syntax errors; some schemas or properties may be missing from the output.`
      );
    }
    collectDeclarations(project, file, tree.rootNode);
  }

  const schema: IrSchema = buildSchema(project);
  if (schema.models.length === 0) {
    const checkedPaths: string = sources
      .map((source: ZodSourceFile) => source.path)
      .join(', ');
    return err(
      'NO_MODELS_FOUND',
      `No Zod object schemas were found in: ${checkedPaths}. A model is a top-level \`export const UserSchema = z.object({ ... })\`; ` +
        `schemas written inline, inside functions or only as TypeScript types do not make a model.`
    );
  }
  return ok(schema);
}

// ---------------------------------------------------------------------------
// Declarations
// ---------------------------------------------------------------------------

function collectDeclarations(
  project: Project,
  file: ZodFileInfo,
  root: SyntaxNode
): void {
  const local: Map<string, Declaration> = new Map();
  project.byFile.set(file, local);
  for (const statement of root.namedChildren) {
    const declaration: SyntaxNode =
      statement.type === 'export_statement'
        ? (statement.childForFieldName('declaration') ?? statement)
        : statement;
    if (declaration.type === 'enum_declaration') {
      const nameNode: SyntaxNode | null = declaration.childForFieldName('name');
      if (nameNode !== null) {
        project.tsEnums.set(nameNode.text, { file, node: declaration });
      }
      continue;
    }
    if (
      declaration.type !== 'lexical_declaration' &&
      declaration.type !== 'variable_declaration'
    ) {
      continue;
    }
    for (const declarator of declaration.namedChildren) {
      if (declarator.type !== 'variable_declarator') {
        continue;
      }
      const nameNode: SyntaxNode | null = declarator.childForFieldName('name');
      const valueNode: SyntaxNode | null =
        declarator.childForFieldName('value');
      if (nameNode === null || valueNode === null) {
        continue;
      }
      const entry: Declaration = {
        file,
        name: nameNode.text,
        node: valueNode,
      };
      project.declarations.push(entry);
      local.set(entry.name, entry);
      if (!project.global.has(entry.name)) {
        project.global.set(entry.name, entry);
      }
    }
  }
}

/** Finds a declared name, preferring the file that uses it over the other input files. */
function lookup(
  project: Project,
  file: ZodFileInfo,
  name: string
): Declaration | undefined {
  return project.byFile.get(file)?.get(name) ?? project.global.get(name);
}

function chainOf(declaration: Declaration): ZodChain | undefined {
  return unwindChain(declaration.file, declaration.node);
}

function isStringLiteralUnion(file: ZodFileInfo, chain: ZodChain): boolean {
  if (chain.base?.name !== 'union') {
    return false;
  }
  const list: SyntaxNode | undefined = chain.base.args[0];
  const items: SyntaxNode[] =
    list !== undefined && stripWrappers(list).type === 'array'
      ? stripWrappers(list).namedChildren.filter(
          (child: SyntaxNode) => child.type !== 'comment'
        )
      : [];
  return (
    items.length > 1 &&
    items.every((item: SyntaxNode): boolean => {
      const inner: ZodChain | undefined = unwindChain(file, item);
      const argument: SyntaxNode | undefined = inner?.base?.args[0];
      return (
        inner?.base?.name === 'literal' &&
        inner.steps.length === 0 &&
        argument !== undefined &&
        typeof literalOf(argument) === 'string'
      );
    })
  );
}

/** Decides what a top-level declaration is. */
function classify(project: Project, declaration: Declaration): DeclKind {
  const known: DeclKind | undefined = project.kinds.get(declaration);
  if (known !== undefined) {
    return known;
  }
  // Guards against a schema defined in terms of itself.
  project.kinds.set(declaration, 'other');
  const result: DeclKind = classifyUncached(project, declaration);
  project.kinds.set(declaration, result);
  return result;
}

function classifyUncached(
  project: Project,
  declaration: Declaration
): DeclKind {
  const value: SyntaxNode = stripWrappers(declaration.node);
  if (value.type === 'array') {
    return value.namedChildren.length > 0 &&
      value.namedChildren.every(
        (item: SyntaxNode) => typeof literalOf(item) === 'string'
      )
      ? 'values'
      : 'other';
  }
  if (value.type === 'object') {
    const { members } = objectMembers(value);
    if (members.length === 0) {
      return 'other';
    }
    if (
      members.every(
        (member) =>
          member.kind === 'property' &&
          ['string', 'number'].includes(typeof literalOf(member.node))
      )
    ) {
      return 'values';
    }
    return 'shape';
  }
  const chain: ZodChain | undefined = chainOf(declaration);
  if (chain === undefined) {
    return 'other';
  }
  if (chain.base !== undefined) {
    if (OBJECT_BASES.has(chain.base.name)) {
      return 'object';
    }
    const enumLike: boolean =
      ENUM_BASES.has(chain.base.name) ||
      isStringLiteralUnion(declaration.file, chain);
    if (
      enumLike &&
      chain.steps.every((step: ChainStep) => ENUM_QUIET_STEPS.has(step.name))
    ) {
      return 'enum';
    }
    return 'alias';
  }
  const target: Declaration | undefined = lookup(
    project,
    declaration.file,
    chain.ref ?? ''
  );
  const targetKind: DeclKind | undefined =
    target === undefined ? undefined : classify(project, target);
  if (
    (targetKind === 'object' || targetKind === 'derived') &&
    chain.steps.length > 0 &&
    chain.steps.every(
      (step: ChainStep) =>
        SHAPE_STEPS.has(step.name) ||
        QUIET_OBJECT_STEPS.has(step.name) ||
        RULE_OBJECT_STEPS.has(step.name)
    )
  ) {
    return isVariantName(project, declaration) ? 'variant' : 'derived';
  }
  if (targetKind === 'enum' && chain.steps.length === 0) {
    return 'enum';
  }
  if (targetKind === 'object' || targetKind === 'derived') {
    // `const Account = UserSchema` is another name for the same schema, not a second model.
    return 'alias';
  }
  if (targetKind === 'alias' || targetKind === 'enum') {
    return 'alias';
  }
  if (target === undefined && chain.steps.some(looksLikeShapeStep)) {
    project.warnings.push(
      `${schemaName(declaration.name)}: the schema is built from "${chain.ref ?? ''}", which is not in the input files, so it could not be resolved and was skipped. Pass the file that declares it too.`
    );
  }
  return 'other';
}

function looksLikeShapeStep(step: ChainStep): boolean {
  return (
    step.name === 'extend' ||
    step.name === 'merge' ||
    step.name === 'pick' ||
    step.name === 'omit'
  );
}

/** True for the schemas the Zod writer derives from a row schema (`PostCreateSchema`, `PostUpdateSchema`, ...). */
function isVariantName(project: Project, declaration: Declaration): boolean {
  const match: RegExpExecArray | null = VARIANT_PATTERN.exec(declaration.name);
  const base: string | undefined = match?.[1];
  if (base === undefined) {
    return false;
  }
  for (const candidate of [`${base}Schema`, base]) {
    const target: Declaration | undefined = lookup(
      project,
      declaration.file,
      candidate
    );
    if (target !== undefined && target !== declaration) {
      const kind: DeclKind = classify(project, target);
      if (kind === 'object' || kind === 'derived') {
        return true;
      }
    }
  }
  return false;
}

/** `UserSchema` -> `User`, `userProfileSchema` -> `UserProfile`. */
function schemaName(variableName: string): string {
  const stripped: string = variableName.replace(/Schema$/, '');
  const base: string = stripped === '' ? variableName : stripped;
  return base.charAt(0).toUpperCase() + base.slice(1);
}

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

function pushEntry(entries: ShapeEntry[], entry: ShapeEntry): void {
  const index: number = entries.findIndex(
    (existing: ShapeEntry) => existing.key === entry.key
  );
  if (index >= 0) {
    entries[index] = entry;
  } else {
    entries.push(entry);
  }
}

/** The properties named by `{ a: true, b: true }` (the mask of pick, omit, partial and required). */
function maskKeys(node: SyntaxNode | undefined): string[] | undefined {
  if (node === undefined) {
    return undefined;
  }
  const current: SyntaxNode = stripWrappers(node);
  if (current.type !== 'object') {
    return undefined;
  }
  return objectMembers(current)
    .members.filter((member) => member.kind === 'property')
    .filter((member) => literalOf(member.node) !== false)
    .map((member) => member.key);
}

/**
 * The properties an expression stands for: an object literal, another schema's `.shape` or a const object
 * of schemas. Returns undefined (and records a problem) when it cannot be read.
 */
function entriesOfNode(
  project: Project,
  file: ZodFileInfo,
  node: SyntaxNode,
  shape: Shape,
  stack: Set<Declaration>
): ShapeEntry[] | undefined {
  const current: SyntaxNode = stripWrappers(node);
  if (current.type === 'object') {
    const entries: ShapeEntry[] = [];
    const { members, skipped } = objectMembers(current);
    for (const member of members) {
      if (member.kind === 'property') {
        pushEntry(entries, {
          key: member.key,
          file,
          node: member.node,
          partial: false,
          required: false,
        });
        continue;
      }
      const spread: ShapeEntry[] | undefined = entriesOfNode(
        project,
        file,
        member.node,
        shape,
        stack
      );
      for (const entry of spread ?? []) {
        pushEntry(entries, entry);
      }
    }
    for (const text of skipped) {
      shape.problems.push(
        `\`${text.replace(/\s+/g, ' ').slice(0, 40)}\` is not a property this reader understands and was skipped.`
      );
    }
    return entries;
  }
  if (current.type === 'call_expression') {
    // An object schema written in place: `.merge(z.object({ ... }))`.
    const chain: ZodChain | undefined = unwindChain(file, current);
    const argument: SyntaxNode | undefined = chain?.base?.args[0];
    if (
      chain?.base !== undefined &&
      OBJECT_BASES.has(chain.base.name) &&
      argument !== undefined
    ) {
      return entriesOfNode(project, file, argument, shape, stack);
    }
  }
  const name: string | undefined = shapeReference(current);
  const target: Declaration | undefined =
    name === undefined ? undefined : lookup(project, file, name);
  if (target === undefined) {
    shape.problems.push(
      `\`${current.text.replace(/\s+/g, ' ').slice(0, 40)}\` is not declared in the input files, so its properties could not be added.`
    );
    return undefined;
  }
  const kind: DeclKind = classify(project, target);
  if (kind === 'shape' || kind === 'object' || kind === 'derived') {
    return shapeOf(project, target, stack)?.entries.map(
      (entry: ShapeEntry): ShapeEntry => ({ ...entry })
    );
  }
  shape.problems.push(
    `"${target.name}" is not an object schema, so its properties could not be added.`
  );
  return undefined;
}

/** The properties of an object schema with its extend, pick, omit, partial and required calls applied. */
function shapeOf(
  project: Project,
  declaration: Declaration,
  stack: Set<Declaration> = new Set()
): Shape | undefined {
  if (project.shapes.has(declaration)) {
    return project.shapes.get(declaration);
  }
  if (stack.has(declaration)) {
    return undefined;
  }
  stack.add(declaration);
  const shape: Shape = { entries: [], dropped: [], problems: [] };
  const kind: DeclKind = classify(project, declaration);
  let steps: ChainStep[] = [];
  if (kind === 'shape') {
    shape.entries =
      entriesOfNode(
        project,
        declaration.file,
        declaration.node,
        shape,
        stack
      ) ?? [];
  } else {
    const chain: ZodChain | undefined = chainOf(declaration);
    if (chain === undefined) {
      stack.delete(declaration);
      return undefined;
    }
    steps = chain.steps;
    if (chain.base !== undefined) {
      const argument: SyntaxNode | undefined = chain.base.args[0];
      shape.entries =
        argument === undefined
          ? []
          : (entriesOfNode(project, declaration.file, argument, shape, stack) ??
            []);
    } else {
      const target: Declaration | undefined = lookup(
        project,
        declaration.file,
        chain.ref ?? ''
      );
      const inherited: Shape | undefined =
        target === undefined ? undefined : shapeOf(project, target, stack);
      shape.entries = (inherited?.entries ?? []).map(
        (entry: ShapeEntry): ShapeEntry => ({ ...entry })
      );
    }
  }
  for (const step of steps) {
    applyShapeStep(project, declaration, shape, step, stack);
  }
  stack.delete(declaration);
  project.shapes.set(declaration, shape);
  return shape;
}

function applyShapeStep(
  project: Project,
  declaration: Declaration,
  shape: Shape,
  step: ChainStep,
  stack: Set<Declaration>
): void {
  const argument: SyntaxNode | undefined = step.args[0];
  switch (step.name) {
    case 'extend':
    case 'safeExtend':
    case 'merge': {
      const added: ShapeEntry[] | undefined =
        argument === undefined
          ? undefined
          : entriesOfNode(project, declaration.file, argument, shape, stack);
      for (const entry of added ?? []) {
        pushEntry(shape.entries, entry);
      }
      return;
    }
    case 'pick':
    case 'omit': {
      const keys: string[] | undefined = maskKeys(argument);
      if (keys === undefined) {
        shape.problems.push(
          `.${step.name}() needs an object literal of property names; it was ignored.`
        );
        return;
      }
      shape.entries = shape.entries.filter((entry: ShapeEntry) =>
        step.name === 'pick'
          ? keys.includes(entry.key)
          : !keys.includes(entry.key)
      );
      return;
    }
    case 'partial':
    case 'deepPartial':
    case 'required': {
      const keys: string[] | undefined = maskKeys(argument);
      if (argument !== undefined && keys === undefined) {
        shape.problems.push(
          `.${step.name}() needs an object literal of property names; it was ignored.`
        );
        return;
      }
      for (const entry of shape.entries) {
        if (keys === undefined || keys.includes(entry.key)) {
          entry.partial = step.name !== 'required';
          entry.required = step.name === 'required';
        }
      }
      if (step.name === 'deepPartial') {
        shape.dropped.push(
          '.deepPartial() (only the top level was made optional)'
        );
      }
      return;
    }
    default:
      break;
  }
  if (RULE_OBJECT_STEPS.has(step.name)) {
    shape.dropped.push(`.${step.name}()`);
  }
}

// ---------------------------------------------------------------------------
// Field host: what a name means to the property resolver
// ---------------------------------------------------------------------------

function enumValuesOf(project: Project, name: string): EnumValues | undefined {
  const tsEnum: { file: ZodFileInfo; node: SyntaxNode } | undefined =
    project.tsEnums.get(name);
  if (tsEnum !== undefined) {
    const members: { name: string; value: string | number }[] = enumMembers(
      tsEnum.node
    );
    const numeric: boolean = members.some(
      (member) => typeof member.value === 'number'
    );
    return {
      numeric,
      values: numeric
        ? []
        : members.map((member): IrEnumValue => ({
            name: member.name,
            dbValue: String(member.value),
          })),
    };
  }
  const declaration: Declaration | undefined = project.global.get(name);
  if (declaration === undefined) {
    return undefined;
  }
  const value: SyntaxNode = stripWrappers(declaration.node);
  if (value.type === 'object') {
    return objectEnumValues(value);
  }
  if (value.type === 'array') {
    const values: IrEnumValue[] = [];
    for (const item of value.namedChildren) {
      const literal: LiteralValue | undefined = literalOf(item);
      if (typeof literal === 'string') {
        values.push({ name: literal, dbValue: literal });
      }
    }
    return { values, numeric: false };
  }
  return undefined;
}

function sameValues(first: IrEnumValue[], second: IrEnumValue[]): boolean {
  return (
    first.length === second.length &&
    first.every(
      (value: IrEnumValue, index: number) =>
        value.name === second[index]?.name &&
        value.dbValue === second[index]?.dbValue
    )
  );
}

function addEnum(
  project: Project,
  wanted: string,
  values: IrEnumValue[]
): string {
  let name: string = wanted;
  let counter: number = 2;
  for (;;) {
    const existing: IrEnum | undefined = project.enums.find(
      (candidate: IrEnum) => candidate.name === name
    );
    if (existing === undefined) {
      project.enums.push({ name, values });
      return name;
    }
    if (sameValues(existing.values, values)) {
      return name;
    }
    name = `${wanted}${counter}`;
    counter += 1;
  }
}

function hostFor(project: Project, file: ZodFileInfo): FieldHost {
  const cached: FieldHost | undefined = project.hosts.get(file);
  if (cached !== undefined) {
    return cached;
  }
  const host: FieldHost = {
    kindOf(name: string): DeclaredKind | undefined {
      const declaration: Declaration | undefined = lookup(project, file, name);
      if (declaration === undefined) {
        return project.tsEnums.has(name) ? 'values' : undefined;
      }
      switch (classify(project, declaration)) {
        case 'object':
        case 'derived':
          return 'model';
        case 'enum':
          return project.enumNames.has(declaration) ? 'enum' : 'alias';
        case 'alias':
          return 'alias';
        case 'values':
          return 'values';
        default:
          return undefined;
      }
    },
    modelNameOf(name: string): string | undefined {
      const declaration: Declaration | undefined = lookup(project, file, name);
      return declaration === undefined
        ? undefined
        : project.modelNames.get(declaration);
    },
    enumNameOf(name: string): string | undefined {
      const declaration: Declaration | undefined = lookup(project, file, name);
      return declaration === undefined
        ? undefined
        : project.enumNames.get(declaration);
    },
    enumMemberName(enumName: string, value: string): string | undefined {
      return project.enums
        .find((candidate: IrEnum) => candidate.name === enumName)
        ?.values.find((member: IrEnumValue) => member.dbValue === value)?.name;
    },
    aliasOf(name: string): { file: ZodFileInfo; node: SyntaxNode } | undefined {
      const declaration: Declaration | undefined = lookup(project, file, name);
      return declaration === undefined
        ? undefined
        : { file: declaration.file, node: declaration.node };
    },
    valuesOf(name: string): EnumValues | undefined {
      return enumValuesOf(project, name);
    },
    inlineEnum(model: string, key: string, values: IrEnumValue[]): string {
      return addEnum(project, `${model}${toPascalCase(key)}`, values);
    },
  };
  project.hosts.set(file, host);
  return host;
}

// ---------------------------------------------------------------------------
// Building the schema
// ---------------------------------------------------------------------------

function uniqueName(
  wanted: string,
  used: Set<string>,
  what: string,
  warnings: string[]
): string {
  let name: string = wanted;
  let counter: number = 2;
  while (used.has(name)) {
    name = `${wanted}${counter}`;
    counter += 1;
  }
  if (name !== wanted) {
    warnings.push(
      `${wanted}: another ${what} already has this name; this one was named "${name}".`
    );
  }
  used.add(name);
  return name;
}

/** Registers the declared enums (`const RoleSchema = z.enum([...])`) in declaration order. */
function registerEnums(project: Project): void {
  const used: Set<string> = new Set();
  for (const declaration of project.declarations) {
    if (classify(project, declaration) !== 'enum') {
      continue;
    }
    let captured: IrEnumValue[] | undefined;
    const base: FieldHost = hostFor(project, declaration.file);
    const capturing: FieldHost = {
      ...base,
      inlineEnum(_model: string, _key: string, values: IrEnumValue[]): string {
        captured = values;
        return '';
      },
    };
    const scope: FieldScope = {
      host: capturing,
      file: declaration.file,
      model: '',
      key: '',
    };
    resolveFieldNode(scope, declaration.node);
    if (captured === undefined) {
      project.kinds.set(declaration, 'alias');
      continue;
    }
    const wanted: string = schemaName(declaration.name);
    const name: string = uniqueName(wanted, used, 'enum', project.warnings);
    project.enums.push({ name, values: captured });
    project.enumNames.set(declaration, name);
  }
}

function buildSchema(project: Project): IrSchema {
  const declarations: Declaration[] = project.declarations;
  // Classify everything first: a declaration can depend on one that comes later in the file.
  for (const declaration of declarations) {
    classify(project, declaration);
  }
  registerEnums(project);

  const usedModelNames: Set<string> = new Set();
  const modelDeclarations: Declaration[] = [];
  for (const declaration of declarations) {
    const kind: DeclKind = classify(project, declaration);
    if (kind === 'object' || kind === 'derived') {
      project.modelNames.set(
        declaration,
        uniqueName(
          schemaName(declaration.name),
          usedModelNames,
          'schema',
          project.warnings
        )
      );
      modelDeclarations.push(declaration);
    }
  }

  const models: IrModel[] = [];
  const pending: Map<IrModel, PendingRelation[]> = new Map();
  for (const declaration of modelDeclarations) {
    const built: { model: IrModel; relations: PendingRelation[] } | undefined =
      buildModel(project, declaration);
    if (built !== undefined) {
      models.push(built.model);
      pending.set(built.model, built.relations);
    }
  }
  linkRelations(project, models, pending);

  return {
    models,
    enums: project.enums,
    warnings: project.warnings,
  };
}

function buildModel(
  project: Project,
  declaration: Declaration
): { model: IrModel; relations: PendingRelation[] } | undefined {
  const name: string = project.modelNames.get(declaration) ?? declaration.name;
  const shape: Shape | undefined = shapeOf(project, declaration);
  if (shape === undefined) {
    project.warnings.push(
      `${name}: the schema refers to itself through its own properties and could not be read; it was skipped.`
    );
    return undefined;
  }
  for (const problem of shape.problems) {
    project.warnings.push(`${name}: ${problem}`);
  }
  const dropped: string[] = [];
  if (shape.dropped.length > 0) {
    dropped.push(`the schema itself (${shape.dropped.join(', ')})`);
  }

  const fields: IrField[] = [];
  const relations: PendingRelation[] = [];
  for (const entry of shape.entries) {
    const scope: FieldScope = {
      host: hostFor(project, entry.file),
      file: entry.file,
      model: name,
      key: entry.key,
    };
    const resolved: ResolvedField = resolveFieldNode(scope, entry.node);
    if (entry.partial) {
      resolved.optional = true;
    }
    if (entry.required) {
      resolved.optional = false;
    }
    for (const problem of resolved.problems) {
      project.warnings.push(`${name}.${entry.key}: ${problem}`);
    }
    if (resolved.dropped.length > 0) {
      dropped.push(
        `${entry.key} (${[...new Set(resolved.dropped)].join(', ')})`
      );
    }
    const nullable: boolean =
      resolved.nullable || (resolved.optional && !resolved.hasDefault);
    if (resolved.relation !== undefined) {
      relations.push({
        key: entry.key,
        target: resolved.relation.model,
        many: resolved.relation.many,
        nullable,
      });
      continue;
    }
    fields.push(toField(entry.key, resolved, nullable));
  }
  if (dropped.length > 0) {
    project.warnings.push(
      `${name}: Zod rules the shared model has no place for were ignored: ${dropped.join('; ')}.`
    );
  }

  const model: IrModel = {
    name,
    tableName: name,
    appLabel: project.options.appLabel,
    fields,
    relations: [],
    indexes: [],
  };
  markPrimaryKey(project, model);
  return { model, relations };
}

function toField(
  key: string,
  resolved: ResolvedField,
  nullable: boolean
): IrField {
  const type: IrField['type'] =
    resolved.type === 'text' && resolved.maxLength !== undefined
      ? 'string'
      : resolved.type;
  const field: IrField = {
    name: key,
    columnName: key,
    type,
    isPrimaryKey: false,
    isUnique: false,
    isNullable: nullable,
    isAutoUpdated: false,
  };
  if (resolved.default !== undefined) {
    field.default = resolved.default;
  }
  if (resolved.maxLength !== undefined) {
    field.maxLength = resolved.maxLength;
  }
  if (resolved.maxDigits !== undefined) {
    field.maxDigits = resolved.maxDigits;
  }
  if (resolved.decimalPlaces !== undefined) {
    field.decimalPlaces = resolved.decimalPlaces;
  }
  if (resolved.enumName !== undefined) {
    field.enumName = resolved.enumName;
  }
  if (resolved.arrayDepth > 0) {
    field.arrayDepth = resolved.arrayDepth;
  }
  return field;
}

/** Zod has no keys: the property named `id` (in any case) is the primary key. */
function markPrimaryKey(project: Project, model: IrModel): void {
  const key: IrField | undefined = model.fields.find(
    (field: IrField) => field.name.toLowerCase() === 'id'
  );
  if (key === undefined) {
    project.warnings.push(
      `${model.name}: Zod has no primary keys and no property is named "id", so the model has no primary key. Add an "id" property.`
    );
    return;
  }
  key.isPrimaryKey = true;
  key.isNullable = false;
}

/**
 * Turns the properties that hold another object schema into relations. A single schema is a foreign key
 * (the closest thing in the shared model to an embedded object). A list of schemas is the reverse side of a
 * foreign key when the other model points back, and a many-to-many otherwise.
 */
function linkRelations(
  project: Project,
  models: IrModel[],
  pending: Map<IrModel, PendingRelation[]>
): void {
  const byName: Map<string, IrModel> = new Map(
    models.map((model: IrModel): [string, IrModel] => [model.name, model])
  );
  for (const model of models) {
    for (const relation of pending.get(model) ?? []) {
      if (relation.many || !byName.has(relation.target)) {
        continue;
      }
      model.relations.push({
        name: relation.key,
        kind: 'foreignKey',
        targetModel: relation.target,
        columnName: `${toSnakeCase(relation.key)}_id`,
        isNullable: relation.nullable,
        onDelete: 'noAction',
      });
      project.warnings.push(
        `${model.name}.${relation.key}: the property holds the schema of "${relation.target}", which was read as a foreign key to that model (column "${toSnakeCase(relation.key)}_id", no delete rule).`
      );
    }
  }
  for (const model of models) {
    for (const relation of pending.get(model) ?? []) {
      if (!relation.many) {
        continue;
      }
      const target: IrModel | undefined = byName.get(relation.target);
      if (target === undefined) {
        continue;
      }
      const pointsBack: IrRelation | undefined = target.relations.find(
        (candidate: IrRelation) =>
          candidate.kind === 'foreignKey' &&
          candidate.targetModel === model.name &&
          candidate.relatedName === undefined
      );
      if (pointsBack !== undefined) {
        pointsBack.relatedName = relation.key;
        continue;
      }
      model.relations.push({
        name: relation.key,
        kind: 'manyToMany',
        targetModel: relation.target,
        columnName: `${toSnakeCase(relation.key)}_id`,
        isNullable: false,
        onDelete: 'cascade',
      });
      project.warnings.push(
        `${model.name}.${relation.key}: the property holds a list of "${relation.target}" schemas and "${relation.target}" has no property that points back, so it was read as a many-to-many relation.`
      );
    }
  }
}
