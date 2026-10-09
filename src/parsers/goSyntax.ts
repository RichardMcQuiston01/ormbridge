import { createRequire } from 'node:module';
import Parser from 'web-tree-sitter';
import { describeThrown, err, ok, type Result } from '../result.js';

export type SyntaxNode = Parser.SyntaxNode;

/** A Go type expression, reduced to the shapes that matter for column and association mapping. */
export type GoType =
  /** `string`, `Post`, `uuid.UUID`, `sql.Null[string]`. `args` holds generic type arguments. */
  | {
      kind: 'name';
      name: string;
      /** Package qualifier exactly as written (`uuid` in `uuid.UUID`). */
      qualifier?: string;
      /** Import path the qualifier resolves to in the declaring file, when it could be found. */
      importPath?: string;
      args: GoType[];
    }
  | { kind: 'pointer'; elem: GoType }
  | { kind: 'slice'; elem: GoType }
  | { kind: 'array'; elem: GoType }
  | { kind: 'map'; key: GoType; value: GoType }
  | { kind: 'struct' }
  | { kind: 'other'; text: string };

/** One field of a struct. An embedded (anonymous) field has no `name`. */
export interface GoField {
  name?: string;
  type: GoType;
  /** The struct tag with its quoting removed, for example `gorm:"size:20" json:"name"`. */
  tag?: string;
}

export interface GoStruct {
  name: string;
  fields: GoField[];
  /** Path of the file that declares the struct, for messages. */
  path: string;
}

/** `type Status string` or `type Money int64`: a named type with a non-struct underlying type. */
export interface GoNamedType {
  name: string;
  underlying: GoType;
}

/** Statically evaluated constant value. */
export type GoConstValue =
  { kind: 'string'; value: string } | { kind: 'int'; value: number };

export interface GoConst {
  name: string;
  /** Declared (or, for implicit repetition, inherited) type name, when it is a plain identifier. */
  typeName?: string;
  /** Absent when the initializer cannot be evaluated statically. */
  value?: GoConstValue;
}

/** What a method with a single `return` of a string literal or constant name returns. */
export type GoStringReturn =
  { kind: 'string'; value: string } | { kind: 'identifier'; name: string };

export interface GoMethod {
  /** Receiver type name without the pointer, for example "User". */
  receiver: string;
  name: string;
  /** Set when the body is exactly `return <string literal or identifier>`. */
  returns?: GoStringReturn;
}

export interface GoFile {
  path: string;
  structs: GoStruct[];
  namedTypes: GoNamedType[];
  consts: GoConst[];
  methods: GoMethod[];
  /** True when the grammar reported syntax errors in the file. */
  hasErrors: boolean;
}

let cachedParser: Parser | undefined;

/** Lazily loads the tree-sitter Go grammar (WebAssembly, no native build step). */
export async function getGoParser(): Promise<Result<Parser>> {
  if (cachedParser !== undefined) {
    return ok(cachedParser);
  }
  try {
    const requireFromHere: NodeRequire = createRequire(import.meta.url);
    const wasmPath: string = requireFromHere.resolve(
      'tree-sitter-wasms/out/tree-sitter-go.wasm'
    );
    await Parser.init();
    const goLanguage: Parser.Language = await Parser.Language.load(wasmPath);
    const parser: Parser = new Parser();
    parser.setLanguage(goLanguage);
    cachedParser = parser;
    return ok(parser);
  } catch (thrown) {
    return err(
      'PARSER_INIT_FAILED',
      `Failed to initialize the tree-sitter Go grammar. Check that the "web-tree-sitter" (0.22.x) and ` +
        `"tree-sitter-wasms" packages are installed. Underlying error: ${describeThrown(thrown)}`
    );
  }
}

// ---------------------------------------------------------------------------
// Literals and struct tags
// ---------------------------------------------------------------------------

/** Decodes a Go string literal (raw or interpreted) into its value. */
export function unquoteGoString(literalText: string): string {
  if (literalText.startsWith('`')) {
    return literalText.slice(1, -1);
  }
  return literalText
    .slice(1, -1)
    .replace(/\\(n|t|r|\\|"|')/g, (_whole: string, escaped: string): string => {
      switch (escaped) {
        case 'n':
          return '\n';
        case 't':
          return '\t';
        case 'r':
          return '\r';
        default:
          return escaped;
      }
    });
}

/**
 * Reads the value of one key from a struct tag the way `reflect.StructTag.Lookup`
 * does: the tag is a space-separated list of `key:"quoted value"` pairs.
 */
export function lookupStructTag(tag: string, key: string): string | undefined {
  let rest: string = tag;
  for (;;) {
    rest = rest.replace(/^\s+/, '');
    if (rest === '') {
      return undefined;
    }
    const keyMatch: RegExpMatchArray | null = rest.match(/^([^\s:"]+):"/);
    if (keyMatch === null) {
      return undefined;
    }
    const name: string = keyMatch[1] ?? '';
    // Find the closing quote, skipping escaped characters.
    let index: number = keyMatch[0].length;
    while (index < rest.length && rest.charAt(index) !== '"') {
      index += rest.charAt(index) === '\\' ? 2 : 1;
    }
    if (index >= rest.length) {
      return undefined;
    }
    const quoted: string = rest.slice(name.length + 1, index + 1);
    if (name === key) {
      return unquoteGoString(quoted);
    }
    rest = rest.slice(index + 1);
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The name a Go import gets when it has no alias: the last path element, minus version markers. */
export function defaultImportName(importPath: string): string {
  const segments: string[] = importPath.split('/');
  let last: string = segments[segments.length - 1] ?? importPath;
  if (/^v\d+$/.test(last) && segments.length > 1) {
    last = segments[segments.length - 2] ?? last;
  }
  return last.replace(/\.v\d+$/, '').replace(/^go[.-]/, '');
}

function readImports(root: SyntaxNode): Map<string, string> {
  const imports: Map<string, string> = new Map();
  for (const spec of root.descendantsOfType('import_spec')) {
    const pathNode: SyntaxNode | null = spec.childForFieldName('path');
    if (pathNode === null) {
      continue;
    }
    const importPath: string = unquoteGoString(pathNode.text);
    const aliasNode: SyntaxNode | null = spec.childForFieldName('name');
    const alias: string =
      aliasNode === null ? defaultImportName(importPath) : aliasNode.text;
    if (alias !== '.' && alias !== '_') {
      imports.set(alias, importPath);
    }
  }
  return imports;
}

function readType(node: SyntaxNode, imports: Map<string, string>): GoType {
  switch (node.type) {
    case 'type_identifier':
      return { kind: 'name', name: node.text, args: [] };
    case 'qualified_type': {
      const qualifier: string = node.childForFieldName('package')?.text ?? '';
      const importPath: string | undefined = imports.get(qualifier);
      return {
        kind: 'name',
        name: node.childForFieldName('name')?.text ?? node.text,
        qualifier,
        ...(importPath === undefined ? {} : { importPath }),
        args: [],
      };
    }
    case 'generic_type': {
      const base: SyntaxNode | null = node.childForFieldName('type');
      const argumentsNode: SyntaxNode | null =
        node.childForFieldName('type_arguments');
      if (base === null) {
        return { kind: 'other', text: node.text };
      }
      const baseType: GoType = readType(base, imports);
      if (baseType.kind !== 'name') {
        return { kind: 'other', text: node.text };
      }
      const args: GoType[] =
        argumentsNode === null
          ? []
          : argumentsNode.namedChildren.map((argument: SyntaxNode): GoType =>
              readType(argument, imports)
            );
      return { ...baseType, args };
    }
    case 'type_elem': {
      const inner: SyntaxNode | undefined = node.namedChildren[0];
      return inner === undefined
        ? { kind: 'other', text: node.text }
        : readType(inner, imports);
    }
    case 'pointer_type': {
      const inner: SyntaxNode | undefined = node.namedChildren[0];
      return inner === undefined
        ? { kind: 'other', text: node.text }
        : { kind: 'pointer', elem: readType(inner, imports) };
    }
    case 'parenthesized_type': {
      const inner: SyntaxNode | undefined = node.namedChildren[0];
      return inner === undefined
        ? { kind: 'other', text: node.text }
        : readType(inner, imports);
    }
    case 'slice_type':
    case 'array_type':
    case 'implicit_length_array_type': {
      const element: SyntaxNode | null = node.childForFieldName('element');
      return element === null
        ? { kind: 'other', text: node.text }
        : {
            kind: node.type === 'slice_type' ? 'slice' : 'array',
            elem: readType(element, imports),
          };
    }
    case 'map_type': {
      const key: SyntaxNode | null = node.childForFieldName('key');
      const value: SyntaxNode | null = node.childForFieldName('value');
      return key === null || value === null
        ? { kind: 'other', text: node.text }
        : {
            kind: 'map',
            key: readType(key, imports),
            value: readType(value, imports),
          };
    }
    case 'struct_type':
      return { kind: 'struct' };
    default:
      return { kind: 'other', text: node.text };
  }
}

/** The type as written in source, for messages. */
export function describeGoType(type: GoType): string {
  switch (type.kind) {
    case 'name': {
      const qualified: string =
        type.qualifier === undefined || type.qualifier === ''
          ? type.name
          : `${type.qualifier}.${type.name}`;
      return type.args.length === 0
        ? qualified
        : `${qualified}[${type.args.map(describeGoType).join(', ')}]`;
    }
    case 'pointer':
      return `*${describeGoType(type.elem)}`;
    case 'slice':
      return `[]${describeGoType(type.elem)}`;
    case 'array':
      return `[...]${describeGoType(type.elem)}`;
    case 'map':
      return `map[${describeGoType(type.key)}]${describeGoType(type.value)}`;
    case 'struct':
      return 'struct{...}';
    default:
      return type.text;
  }
}

// ---------------------------------------------------------------------------
// Declarations
// ---------------------------------------------------------------------------

function readStructFields(
  body: SyntaxNode,
  imports: Map<string, string>
): GoField[] {
  const fields: GoField[] = [];
  const list: SyntaxNode | undefined = body.namedChildren.find(
    (child: SyntaxNode) => child.type === 'field_declaration_list'
  );
  for (const declaration of list?.namedChildren ?? []) {
    if (declaration.type !== 'field_declaration') {
      continue;
    }
    const typeNode: SyntaxNode | null = declaration.childForFieldName('type');
    if (typeNode === null) {
      continue;
    }
    let type: GoType = readType(typeNode, imports);
    const tagNode: SyntaxNode | null = declaration.childForFieldName('tag');
    const tag: string | undefined =
      tagNode === null ? undefined : unquoteGoString(tagNode.text);
    const names: SyntaxNode[] = declaration.childrenForFieldName('name');
    if (names.length === 0) {
      // Embedded field: `Base`, `*Base` or `gorm.Model`. The pointer is a token, not part of the type node.
      if (declaration.children[0]?.type === '*') {
        type = { kind: 'pointer', elem: type };
      }
      fields.push({ type, ...(tag === undefined ? {} : { tag }) });
      continue;
    }
    for (const name of names) {
      fields.push({
        name: name.text,
        type,
        ...(tag === undefined ? {} : { tag }),
      });
    }
  }
  return fields;
}

/** The type name of a method receiver: `u *User` and `User` both give "User". */
function receiverName(
  method: SyntaxNode,
  imports: Map<string, string>
): string | undefined {
  const receiver: SyntaxNode | null = method.childForFieldName('receiver');
  const typeNode: SyntaxNode | null | undefined =
    receiver?.namedChildren[0]?.childForFieldName('type');
  if (typeNode === null || typeNode === undefined) {
    return undefined;
  }
  let type: GoType = readType(typeNode, imports);
  if (type.kind === 'pointer') {
    type = type.elem;
  }
  return type.kind === 'name' ? type.name : undefined;
}

function readMethod(
  node: SyntaxNode,
  imports: Map<string, string>
): GoMethod | undefined {
  const name: string | undefined = node.childForFieldName('name')?.text;
  const receiver: string | undefined = receiverName(node, imports);
  if (name === undefined || receiver === undefined) {
    return undefined;
  }
  const method: GoMethod = { receiver, name };
  const statements: SyntaxNode[] =
    node.childForFieldName('body')?.namedChildren ?? [];
  const only: SyntaxNode | undefined = statements[0];
  if (statements.length === 1 && only?.type === 'return_statement') {
    const values: SyntaxNode[] = only.namedChildren[0]?.namedChildren ?? [];
    const value: SyntaxNode | undefined = values[0];
    if (values.length === 1 && value !== undefined) {
      if (
        value.type === 'interpreted_string_literal' ||
        value.type === 'raw_string_literal'
      ) {
        method.returns = { kind: 'string', value: unquoteGoString(value.text) };
      } else if (value.type === 'identifier') {
        method.returns = { kind: 'identifier', name: value.text };
      }
    }
  }
  return method;
}

/** Evaluates the small subset of constant expressions that enum definitions use. */
function evaluateConst(
  node: SyntaxNode,
  iota: number
): GoConstValue | undefined {
  switch (node.type) {
    case 'interpreted_string_literal':
    case 'raw_string_literal':
      return { kind: 'string', value: unquoteGoString(node.text) };
    case 'int_literal': {
      const text: string = node.text.replace(/_/g, '');
      const parsed: number = /^0[0-7]+$/.test(text)
        ? parseInt(text, 8)
        : Number(text);
      return Number.isNaN(parsed) ? undefined : { kind: 'int', value: parsed };
    }
    case 'iota':
      return { kind: 'int', value: iota };
    case 'parenthesized_expression': {
      const inner: SyntaxNode | undefined = node.namedChildren[0];
      return inner === undefined ? undefined : evaluateConst(inner, iota);
    }
    case 'unary_expression': {
      const operand: SyntaxNode | null = node.childForFieldName('operand');
      const value: GoConstValue | undefined =
        operand === null ? undefined : evaluateConst(operand, iota);
      if (value?.kind !== 'int') {
        return value;
      }
      return node.text.startsWith('-')
        ? { kind: 'int', value: -value.value }
        : value;
    }
    case 'call_expression': {
      // A conversion such as `Status("draft")`: the value is the argument.
      const argument: SyntaxNode | undefined =
        node.childForFieldName('arguments')?.namedChildren[0];
      return argument === undefined ? undefined : evaluateConst(argument, iota);
    }
    case 'binary_expression': {
      const left: SyntaxNode | null = node.childForFieldName('left');
      const right: SyntaxNode | null = node.childForFieldName('right');
      const operator: string | undefined =
        node.childForFieldName('operator')?.text;
      const leftValue: GoConstValue | undefined =
        left === null ? undefined : evaluateConst(left, iota);
      const rightValue: GoConstValue | undefined =
        right === null ? undefined : evaluateConst(right, iota);
      if (leftValue?.kind === 'int' && rightValue?.kind === 'int') {
        const a: number = leftValue.value;
        const b: number = rightValue.value;
        switch (operator) {
          case '+':
            return { kind: 'int', value: a + b };
          case '-':
            return { kind: 'int', value: a - b };
          case '*':
            return { kind: 'int', value: a * b };
          case '<<':
            return { kind: 'int', value: a * 2 ** b };
          case '>>':
            return { kind: 'int', value: Math.floor(a / 2 ** b) };
          default:
            return undefined;
        }
      }
      if (
        operator === '+' &&
        leftValue?.kind === 'string' &&
        rightValue?.kind === 'string'
      ) {
        return { kind: 'string', value: leftValue.value + rightValue.value };
      }
      return undefined;
    }
    default:
      return undefined;
  }
}

/** Reads one `const (...)` block, repeating the previous initializer and type for bare names like Go does. */
function readConstDeclaration(node: SyntaxNode): GoConst[] {
  const consts: GoConst[] = [];
  let inheritedType: string | undefined;
  let inheritedValues: SyntaxNode[] = [];
  let iota: number = 0;
  for (const spec of node.namedChildren) {
    if (spec.type !== 'const_spec') {
      continue;
    }
    const names: SyntaxNode[] = spec.childrenForFieldName('name');
    const typeNode: SyntaxNode | null = spec.childForFieldName('type');
    const valueList: SyntaxNode | null = spec.childForFieldName('value');
    if (valueList !== null) {
      inheritedValues = valueList.namedChildren;
      inheritedType = typeNode?.text;
    } else if (typeNode !== null) {
      inheritedType = typeNode.text;
    }
    names.forEach((nameNode: SyntaxNode, index: number): void => {
      const valueNode: SyntaxNode | undefined = inheritedValues[index];
      const value: GoConstValue | undefined =
        valueNode === undefined ? undefined : evaluateConst(valueNode, iota);
      consts.push({
        name: nameNode.text,
        ...(inheritedType === undefined ? {} : { typeName: inheritedType }),
        ...(value === undefined ? {} : { value }),
      });
    });
    iota += 1;
  }
  return consts;
}

/** Reads the declarations of one Go file that are relevant to GORM: structs, named types, constants and methods. */
export function readGoFile(root: SyntaxNode, path: string): GoFile {
  const imports: Map<string, string> = readImports(root);
  const file: GoFile = {
    path,
    structs: [],
    namedTypes: [],
    consts: [],
    methods: [],
    hasErrors: root.hasError,
  };
  for (const node of root.namedChildren) {
    if (node.type === 'type_declaration') {
      for (const spec of node.namedChildren) {
        if (spec.type !== 'type_spec' && spec.type !== 'type_alias') {
          continue;
        }
        const name: string | undefined = spec.childForFieldName('name')?.text;
        const typeNode: SyntaxNode | null = spec.childForFieldName('type');
        // Generic type declarations cannot be mapped to a single table.
        if (
          name === undefined ||
          typeNode === null ||
          spec.childForFieldName('type_parameters') !== null
        ) {
          continue;
        }
        if (typeNode.type === 'struct_type') {
          file.structs.push({
            name,
            fields: readStructFields(typeNode, imports),
            path,
          });
        } else {
          file.namedTypes.push({
            name,
            underlying: readType(typeNode, imports),
          });
        }
      }
    } else if (node.type === 'const_declaration') {
      file.consts.push(...readConstDeclaration(node));
    } else if (node.type === 'method_declaration') {
      const method: GoMethod | undefined = readMethod(node, imports);
      if (method !== undefined) {
        file.methods.push(method);
      }
    }
  }
  return file;
}
