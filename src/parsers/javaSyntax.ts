import { createRequire } from 'node:module';
import Parser from 'web-tree-sitter';
import { describeThrown, err, ok, type Result } from '../result.js';

export type SyntaxNode = Parser.SyntaxNode;

/** A Java type reduced to what mapping needs: a name, generic arguments and the array depth. */
export interface JavaType {
  /** The last identifier, without package qualifiers or arguments: `List`, `Post`, `int`. */
  name: string;
  /** The type as written without generic arguments and array markers (`java.util.List`). */
  text: string;
  args: JavaType[];
  /** Number of array dimensions: `byte[]` is 1. */
  arrayDepth: number;
}

/** A statically evaluated expression. Anything that cannot be evaluated is `other` with its source text. */
export type JavaValue =
  | { kind: 'string'; value: string }
  | { kind: 'number'; value: number; text: string }
  | { kind: 'bool'; value: boolean }
  | { kind: 'null' }
  /** `GenerationType.IDENTITY`, or a bare identifier that is not a known constant. */
  | { kind: 'member'; path: string[] }
  /** `Post.class`. */
  | { kind: 'class'; type: string }
  | { kind: 'array'; items: JavaValue[] }
  | { kind: 'annotation'; annotation: JavaAnnotation }
  | { kind: 'other'; text: string };

/** Looks a constant up by simple or `Class.NAME` form; used while evaluating expressions. */
export type ConstLookup = (path: string[]) => SyntaxNode | undefined;

export interface JavaAnnotation {
  /** The simple name: `Entity` for `@Entity` and for `@jakarta.persistence.Entity`. */
  name: string;
  /** The qualifier when the annotation is written fully qualified (`jakarta.persistence`). */
  qualifier?: string;
  /** Argument expressions by name; a single unnamed argument is stored as `value`. */
  args: Map<string, SyntaxNode>;
  node: SyntaxNode;
}

export interface JavaField {
  name: string;
  type: JavaType;
  modifiers: string[];
  annotations: JavaAnnotation[];
  initializer?: SyntaxNode;
  node: SyntaxNode;
}

export interface JavaParameter {
  name: string;
  type: JavaType;
}

export interface JavaMethod {
  name: string;
  returnType: JavaType;
  parameters: JavaParameter[];
  modifiers: string[];
  annotations: JavaAnnotation[];
  node: SyntaxNode;
}

export type JavaClassKind =
  'class' | 'interface' | 'enum' | 'record' | 'annotation';

export interface JavaEnumConstant {
  name: string;
}

export interface JavaClass {
  name: string;
  kind: JavaClassKind;
  modifiers: string[];
  annotations: JavaAnnotation[];
  typeParameters: string[];
  superclass?: JavaType;
  interfaces: JavaType[];
  fields: JavaField[];
  methods: JavaMethod[];
  enumConstants: JavaEnumConstant[];
  /** Name of the enclosing type for nested types. */
  outer?: string;
  /** Imports of the file: simple name to the full name, or `pkg.*` for wildcards. */
  imports: string[];
  packageName: string;
  path: string;
}

export interface JavaFile {
  path: string;
  packageName: string;
  imports: string[];
  /** Every type of the file, nested ones included. */
  classes: JavaClass[];
  /** True when the grammar reported syntax errors. */
  hasErrors: boolean;
}

let cachedParser: Parser | undefined;

/** Lazily loads the tree-sitter Java grammar (WebAssembly, no native build step). */
export async function getJavaParser(): Promise<Result<Parser>> {
  if (cachedParser !== undefined) {
    return ok(cachedParser);
  }
  try {
    const requireFromHere: NodeRequire = createRequire(import.meta.url);
    const wasmPath: string = requireFromHere.resolve(
      'tree-sitter-wasms/out/tree-sitter-java.wasm'
    );
    await Parser.init();
    const language: Parser.Language = await Parser.Language.load(wasmPath);
    const parser: Parser = new Parser();
    parser.setLanguage(language);
    cachedParser = parser;
    return ok(parser);
  } catch (thrown) {
    return err(
      'PARSER_INIT_FAILED',
      `Failed to initialize the tree-sitter Java grammar. Check that the "web-tree-sitter" (0.22.x) and ` +
        `"tree-sitter-wasms" packages are installed. Underlying error: ${describeThrown(thrown)}`
    );
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Splits at commas that are not inside `<...>`, `(...)` or `[...]`. */
export function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth: number = 0;
  let current: string = '';
  for (const character of text) {
    if (character === '<' || character === '(' || character === '[') {
      depth += 1;
    } else if (character === '>' || character === ')' || character === ']') {
      depth -= 1;
    }
    if (character === ',' && depth === 0) {
      parts.push(current);
      current = '';
    } else {
      current += character;
    }
  }
  if (current.trim() !== '') {
    parts.push(current);
  }
  return parts.map((part: string) => part.trim());
}

const MAX_TYPE_DEPTH: number = 16;

/** Reads a type from its source text. Never fails: unreadable text becomes a type named after the text. */
export function parseTypeText(text: string, depth: number = 0): JavaType {
  let rest: string = text
    .replace(/@[\w.]+(?:\([^)]*\))?/g, ' ')
    .replace(/\bfinal\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  let arrayDepth: number = 0;
  while (/\[\s*\]$/.test(rest)) {
    arrayDepth += 1;
    rest = rest.replace(/\[\s*\]$/, '').trim();
  }
  if (rest.endsWith('...')) {
    arrayDepth += 1;
    rest = rest.slice(0, -3).trim();
  }
  // `? extends Foo` and `? super Foo` are read as Foo; a bare `?` is Object.
  const wildcard: RegExpMatchArray | null = rest.match(
    /^\?\s*(?:extends|super)\s+(.+)$/
  );
  if (wildcard !== null) {
    return parseTypeText(wildcard[1] ?? 'Object', depth + 1);
  }
  if (rest === '?') {
    return { name: 'Object', text: 'Object', args: [], arrayDepth };
  }
  const open: number = rest.indexOf('<');
  const head: string = open === -1 ? rest : rest.slice(0, open).trim();
  const name: string = head.split('.').pop()?.trim() ?? head;
  let args: JavaType[] = [];
  if (open !== -1 && rest.endsWith('>') && depth < MAX_TYPE_DEPTH) {
    args = splitTopLevel(rest.slice(open + 1, -1)).map((part: string) =>
      parseTypeText(part, depth + 1)
    );
  }
  return { name, text: head, args, arrayDepth };
}

// ---------------------------------------------------------------------------
// Declarations
// ---------------------------------------------------------------------------

/** Reads `@Name`, `@Name(value)` and `@Name(a = 1, b = 2)`. */
export function readAnnotation(node: SyntaxNode): JavaAnnotation {
  const nameNode: SyntaxNode | null = node.childForFieldName('name');
  const full: string[] = (nameNode?.text ?? '').split('.');
  const name: string = full.pop() ?? '';
  const args: Map<string, SyntaxNode> = new Map();
  const list: SyntaxNode | null = node.childForFieldName('arguments');
  if (list !== null) {
    for (const child of list.namedChildren) {
      if (child.type === 'element_value_pair') {
        const key: SyntaxNode | null = child.childForFieldName('key');
        const value: SyntaxNode | null = child.childForFieldName('value');
        if (key !== null && value !== null) {
          args.set(key.text, value);
        }
      } else if (!child.type.includes('comment')) {
        args.set('value', child);
      }
    }
  }
  return {
    name,
    ...(full.length === 0 ? {} : { qualifier: full.join('.') }),
    args,
    node,
  };
}

interface Modifiers {
  keywords: string[];
  annotations: JavaAnnotation[];
}

function readModifiers(node: SyntaxNode): Modifiers {
  const modifiers: SyntaxNode | undefined = node.namedChildren.find(
    (child: SyntaxNode) => child.type === 'modifiers'
  );
  const result: Modifiers = { keywords: [], annotations: [] };
  if (modifiers === undefined) {
    return result;
  }
  for (const child of modifiers.children) {
    if (child.type === 'annotation' || child.type === 'marker_annotation') {
      result.annotations.push(readAnnotation(child));
    } else if (!child.type.includes('comment')) {
      result.keywords.push(child.type);
    }
  }
  return result;
}

function readFields(
  node: SyntaxNode,
  fields: JavaField[],
  modifiers: Modifiers
): void {
  const typeNode: SyntaxNode | null = node.childForFieldName('type');
  if (typeNode === null) {
    return;
  }
  const base: JavaType = parseTypeText(typeNode.text);
  for (const declarator of node.namedChildren) {
    if (declarator.type !== 'variable_declarator') {
      continue;
    }
    const name: SyntaxNode | null = declarator.childForFieldName('name');
    if (name === null) {
      continue;
    }
    const dimensions: SyntaxNode | null =
      declarator.childForFieldName('dimensions');
    const extra: number =
      dimensions === null ? 0 : (dimensions.text.match(/\[/g) ?? []).length;
    const value: SyntaxNode | null = declarator.childForFieldName('value');
    fields.push({
      name: name.text,
      type: { ...base, arrayDepth: base.arrayDepth + extra },
      modifiers: modifiers.keywords,
      annotations: modifiers.annotations,
      ...(value === null ? {} : { initializer: value }),
      node,
    });
  }
}

function readMethod(node: SyntaxNode): JavaMethod | undefined {
  const name: SyntaxNode | null = node.childForFieldName('name');
  const type: SyntaxNode | null = node.childForFieldName('type');
  if (name === null || type === null) {
    return undefined;
  }
  const modifiers: Modifiers = readModifiers(node);
  const parameters: JavaParameter[] = [];
  const list: SyntaxNode | null = node.childForFieldName('parameters');
  for (const parameter of list?.namedChildren ?? []) {
    const parameterType: SyntaxNode | null =
      parameter.childForFieldName('type');
    const parameterName: SyntaxNode | null =
      parameter.childForFieldName('name');
    if (parameterType !== null && parameterName !== null) {
      parameters.push({
        name: parameterName.text,
        type: parseTypeText(parameterType.text),
      });
    }
  }
  return {
    name: name.text,
    returnType: parseTypeText(type.text),
    parameters,
    modifiers: modifiers.keywords,
    annotations: modifiers.annotations,
    node,
  };
}

const TYPE_DECLARATIONS: Readonly<Record<string, JavaClassKind>> = {
  class_declaration: 'class',
  interface_declaration: 'interface',
  enum_declaration: 'enum',
  record_declaration: 'record',
  annotation_type_declaration: 'annotation',
};

function readTypeParameters(node: SyntaxNode): string[] {
  const list: SyntaxNode | null = node.childForFieldName('type_parameters');
  return (list?.namedChildren ?? [])
    .filter((child: SyntaxNode) => child.type === 'type_parameter')
    .map((child: SyntaxNode) => child.namedChild(0)?.text ?? child.text);
}

function readTypeList(node: SyntaxNode | null): JavaType[] {
  if (node === null) {
    return [];
  }
  const list: SyntaxNode | undefined = node.namedChildren.find(
    (child: SyntaxNode) => child.type === 'type_list'
  );
  return (list ?? node).namedChildren
    .filter((child: SyntaxNode) => !child.type.includes('comment'))
    .map((child: SyntaxNode) => parseTypeText(child.text));
}

function readType(
  node: SyntaxNode,
  file: { path: string; packageName: string; imports: string[] },
  outer: string | undefined,
  into: JavaClass[]
): void {
  const kind: JavaClassKind | undefined = TYPE_DECLARATIONS[node.type];
  const nameNode: SyntaxNode | null = node.childForFieldName('name');
  if (kind === undefined || nameNode === null) {
    return;
  }
  const modifiers: Modifiers = readModifiers(node);
  const superNode: SyntaxNode | undefined = node.namedChildren.find(
    (child: SyntaxNode) => child.type === 'superclass'
  );
  const superType: SyntaxNode | undefined = superNode?.namedChildren.find(
    (child: SyntaxNode) => !child.type.includes('comment')
  );
  const interfaces: SyntaxNode | undefined = node.namedChildren.find(
    (child: SyntaxNode) =>
      child.type === 'super_interfaces' || child.type === 'extends_interfaces'
  );
  const cls: JavaClass = {
    name: nameNode.text,
    kind,
    modifiers: modifiers.keywords,
    annotations: modifiers.annotations,
    typeParameters: readTypeParameters(node),
    ...(superType === undefined
      ? {}
      : { superclass: parseTypeText(superType.text) }),
    interfaces: readTypeList(interfaces ?? null),
    fields: [],
    methods: [],
    enumConstants: [],
    ...(outer === undefined ? {} : { outer }),
    imports: file.imports,
    packageName: file.packageName,
    path: file.path,
  };
  into.push(cls);
  const body: SyntaxNode | null = node.childForFieldName('body');
  const members: SyntaxNode[] = [];
  for (const child of body?.namedChildren ?? []) {
    if (child.type === 'enum_body_declarations') {
      members.push(...child.namedChildren);
    } else {
      members.push(child);
    }
  }
  if (kind === 'record') {
    // Record components are not mapped by JPA, so they are not read as fields.
    return;
  }
  for (const member of members) {
    if (member.type === 'enum_constant') {
      const constant: SyntaxNode | null = member.childForFieldName('name');
      if (constant !== null) {
        cls.enumConstants.push({ name: constant.text });
      }
    } else if (member.type === 'field_declaration') {
      readFields(member, cls.fields, readModifiers(member));
    } else if (member.type === 'method_declaration') {
      const method: JavaMethod | undefined = readMethod(member);
      if (method !== undefined) {
        cls.methods.push(method);
      }
    } else if (member.type in TYPE_DECLARATIONS) {
      readType(member, file, cls.name, into);
    }
  }
}

/** Reads the types, fields and methods of one Java file. */
export function readJavaFile(root: SyntaxNode, path: string): JavaFile {
  let packageName: string = '';
  const imports: string[] = [];
  const classes: JavaClass[] = [];
  const file = { path, packageName, imports };
  for (const child of root.namedChildren) {
    if (child.type === 'package_declaration') {
      packageName =
        child.namedChildren.find(
          (item: SyntaxNode) => !item.type.includes('comment')
        )?.text ?? '';
      file.packageName = packageName;
    } else if (child.type === 'import_declaration') {
      const text: string = child.text
        .replace(/^import\s+(?:static\s+)?/, '')
        .replace(/;\s*$/, '')
        .trim();
      imports.push(text);
    } else if (child.type in TYPE_DECLARATIONS) {
      readType(child, file, undefined, classes);
    }
  }
  return { path, packageName, imports, classes, hasErrors: root.hasError };
}
