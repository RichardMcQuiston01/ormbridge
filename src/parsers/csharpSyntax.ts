import { createRequire } from 'node:module';
import Parser from 'web-tree-sitter';
import { describeThrown, err, ok, type Result } from '../result.js';

export type SyntaxNode = Parser.SyntaxNode;

/** A C# type expression reduced to what mapping needs: a name, generic arguments and `?` / `[]` markers. */
export interface CsType {
  /** The last identifier, without qualifiers or arguments: `ICollection`, `Post`, `int`. */
  name: string;
  /** The type as written, without nullable and array markers. */
  text: string;
  args: CsType[];
  /** True for `T?` and `Nullable<T>` (the wrapper is removed from `name` and `args`). */
  nullable: boolean;
  /** Number of array dimensions: `byte[]` is 1 and `int[][]` is 2. */
  arrayDepth: number;
}

/** A statically evaluated expression. Anything that cannot be evaluated is `other` with its source text. */
export type CsValue =
  | { kind: 'string'; value: string }
  | { kind: 'number'; value: number; text: string }
  | { kind: 'bool'; value: boolean }
  | { kind: 'null' }
  /** `DeleteBehavior.Cascade`, or a bare identifier that is not a known constant. */
  | { kind: 'member'; path: string[] }
  | { kind: 'nameof'; name: string }
  | { kind: 'typeof'; type: string }
  | { kind: 'array'; items: CsValue[] }
  | { kind: 'other'; text: string };

/** Looks a constant up by simple or `Class.Name` form; used while evaluating expressions. */
export type ConstLookup = (path: string[]) => CsValue | undefined;

export interface CsAttribute {
  /** The attribute name without the `Attribute` suffix and any qualifier: `Key`, `Table`. */
  name: string;
  /** Positional argument expressions. */
  args: SyntaxNode[];
  /** Named arguments (`Schema = "x"`, `name: "x"`) by name. */
  named: Map<string, SyntaxNode>;
  node: SyntaxNode;
}

export interface CsProperty {
  name: string;
  type: CsType;
  modifiers: string[];
  attributes: CsAttribute[];
  hasGetter: boolean;
  hasSetter: boolean;
  /** True for `=> expression` properties and for properties with a getter body only. */
  isComputed: boolean;
  /** True for fields (`public int X;`), which EF Core does not map by convention. */
  isField: boolean;
  initializer?: SyntaxNode;
  node: SyntaxNode;
}

export interface CsParameter {
  name: string;
  type: CsType;
}

export interface CsMethod {
  name: string;
  parameters: CsParameter[];
  /** The body block, or the expression of an expression-bodied method. */
  body?: SyntaxNode;
  node: SyntaxNode;
}

export type CsClassKind = 'class' | 'record' | 'struct' | 'interface';

export interface CsClass {
  name: string;
  kind: CsClassKind;
  modifiers: string[];
  typeParameters: string[];
  bases: CsType[];
  attributes: CsAttribute[];
  properties: CsProperty[];
  methods: CsMethod[];
  consts: Map<string, CsValue>;
  /** Name of the enclosing type for nested types. */
  outer?: string;
  path: string;
}

export interface CsEnumMember {
  name: string;
  /** The numeric value, or undefined when it could not be evaluated. */
  value: number | undefined;
}

export interface CsEnum {
  name: string;
  members: CsEnumMember[];
  path: string;
}

export interface CsFile {
  path: string;
  classes: CsClass[];
  enums: CsEnum[];
  /** True when the grammar reported syntax errors. */
  hasErrors: boolean;
  /** True when the file switches nullable reference types on or off with a `#nullable` directive. */
  nullableDirective: 'enable' | 'disable' | undefined;
}

let cachedParser: Parser | undefined;

/** Lazily loads the tree-sitter C# grammar (WebAssembly, no native build step). */
export async function getCSharpParser(): Promise<Result<Parser>> {
  if (cachedParser !== undefined) {
    return ok(cachedParser);
  }
  try {
    const requireFromHere: NodeRequire = createRequire(import.meta.url);
    const wasmPath: string = requireFromHere.resolve(
      'tree-sitter-wasms/out/tree-sitter-c_sharp.wasm'
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
      `Failed to initialize the tree-sitter C# grammar. Check that the "web-tree-sitter" (0.22.x) and ` +
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
export function parseTypeText(text: string, depth: number = 0): CsType {
  let rest: string = text.replace(/\s+/g, ' ').trim();
  let nullable: boolean = false;
  let arrayDepth: number = 0;
  // Trailing markers, in any order: `string?[]`, `int[]?`, `Order?`.
  for (;;) {
    if (rest.endsWith('?')) {
      nullable = true;
      rest = rest.slice(0, -1).trim();
    } else if (/\[\s*,*\s*\]$/.test(rest)) {
      arrayDepth += 1;
      rest = rest.replace(/\[\s*,*\s*\]$/, '').trim();
    } else {
      break;
    }
  }
  rest = rest.replace(/^global::/, '');
  const open: number = rest.indexOf('<');
  const head: string = open === -1 ? rest : rest.slice(0, open);
  const name: string = head.split('.').pop()?.trim() ?? head;
  let args: CsType[] = [];
  if (open !== -1 && rest.endsWith('>') && depth < MAX_TYPE_DEPTH) {
    args = splitTopLevel(rest.slice(open + 1, -1)).map((part: string) =>
      parseTypeText(part, depth + 1)
    );
  }
  const first: CsType | undefined = args[0];
  if (name === 'Nullable' && args.length === 1 && first !== undefined) {
    return { ...first, nullable: true, arrayDepth: first.arrayDepth };
  }
  return { name, text: head.trim(), args, nullable, arrayDepth };
}

// ---------------------------------------------------------------------------
// Literals and expressions
// ---------------------------------------------------------------------------

function unescapeRegular(body: string): string {
  return body.replace(
    /\\(?:u([0-9a-fA-F]{4})|x([0-9a-fA-F]{1,4})|([\s\S]))/g,
    (
      _whole: string,
      unicode: string | undefined,
      hex: string | undefined,
      single: string | undefined
    ): string => {
      if (unicode !== undefined) {
        return String.fromCharCode(parseInt(unicode, 16));
      }
      if (hex !== undefined) {
        return String.fromCharCode(parseInt(hex, 16));
      }
      switch (single) {
        case 'n':
          return '\n';
        case 't':
          return '\t';
        case 'r':
          return '\r';
        case '0':
          return '\0';
        default:
          return single ?? '';
      }
    }
  );
}

/** Decodes the text of a regular, verbatim (`@"..."`) or raw (`"""..."""`) string literal. */
export function unquoteCSharpString(literal: string): string {
  if (literal.startsWith('@"')) {
    return literal.slice(2, -1).replace(/""/g, '"');
  }
  if (literal.startsWith('"""')) {
    return literal.replace(/^"{3,}\s*/, '').replace(/\s*"{3,}$/, '');
  }
  if (literal.startsWith('"') && literal.endsWith('"') && literal.length >= 2) {
    return unescapeRegular(literal.slice(1, -1));
  }
  return literal;
}

function parseNumber(text: string): number | undefined {
  const cleaned: string = text.replace(/_/g, '');
  if (/^0[xX][0-9a-fA-F]+[uUlL]*$/.test(cleaned)) {
    return parseInt(cleaned.replace(/[uUlL]+$/, ''), 16);
  }
  if (/^0[bB][01]+[uUlL]*$/.test(cleaned)) {
    return parseInt(cleaned.slice(2).replace(/[uUlL]+$/, ''), 2);
  }
  const stripped: string = cleaned.replace(/[uUlLfFdDmM]+$/, '');
  const value: number = Number(stripped);
  return Number.isNaN(value) ? undefined : value;
}

const MAX_EXPRESSION_DEPTH: number = 64;

/** Evaluates literals, constants, `nameof`, `typeof`, enum-like member paths, unary minus and `+`. */
export function evaluate(
  node: SyntaxNode,
  consts: ConstLookup,
  depth: number = 0
): CsValue {
  const other: CsValue = { kind: 'other', text: node.text };
  if (depth > MAX_EXPRESSION_DEPTH) {
    return other;
  }
  const recurse = (child: SyntaxNode | null): CsValue =>
    child === null ? other : evaluate(child, consts, depth + 1);
  switch (node.type) {
    case 'string_literal':
    case 'verbatim_string_literal':
    case 'raw_string_literal':
      return { kind: 'string', value: unquoteCSharpString(node.text) };
    case 'character_literal':
      return { kind: 'string', value: unescapeRegular(node.text.slice(1, -1)) };
    case 'integer_literal':
    case 'real_literal': {
      const value: number | undefined = parseNumber(node.text);
      return value === undefined
        ? other
        : { kind: 'number', value, text: node.text };
    }
    case 'boolean_literal':
      return { kind: 'bool', value: node.text === 'true' };
    case 'null_literal':
      return { kind: 'null' };
    case 'parenthesized_expression':
      return recurse(node.namedChild(0));
    case 'cast_expression':
      return recurse(node.childForFieldName('value'));
    case 'postfix_unary_expression':
      return recurse(node.namedChild(0));
    case 'prefix_unary_expression': {
      const operand: CsValue = recurse(node.namedChild(0));
      if (node.text.startsWith('-') && operand.kind === 'number') {
        return {
          kind: 'number',
          value: -operand.value,
          text: `-${operand.text}`,
        };
      }
      return operand.kind === 'number' && node.text.startsWith('+')
        ? operand
        : other;
    }
    case 'identifier': {
      const known: CsValue | undefined = consts([node.text]);
      return known ?? { kind: 'member', path: [node.text] };
    }
    case 'member_access_expression': {
      const path: string[] | undefined = memberPath(node);
      if (path === undefined) {
        return other;
      }
      return consts(path) ?? { kind: 'member', path };
    }
    case 'invocation_expression': {
      const fn: SyntaxNode | null = node.childForFieldName('function');
      const args: SyntaxNode | null = node.childForFieldName('arguments');
      if (fn?.text === 'nameof' && args !== null) {
        const inner: SyntaxNode | null = args.namedChild(0);
        const text: string = inner?.text ?? '';
        return { kind: 'nameof', name: text.split('.').pop() ?? text };
      }
      return other;
    }
    case 'typeof_expression': {
      const inner: SyntaxNode | null = node.namedChild(0);
      return { kind: 'typeof', type: parseTypeText(inner?.text ?? '').name };
    }
    case 'binary_expression': {
      const left: CsValue = recurse(node.childForFieldName('left'));
      const right: CsValue = recurse(node.childForFieldName('right'));
      const operator: string =
        node.childForFieldName('operator')?.text ??
        node.text.replace(left.kind === 'other' ? '' : /\s*$/, '');
      return foldBinary(operator, left, right, node, other);
    }
    case 'array_creation_expression':
    case 'implicit_array_creation_expression':
    case 'initializer_expression':
    case 'collection_expression':
      return {
        kind: 'array',
        items: itemsOf(node).map((item: SyntaxNode) => recurse(item)),
      };
    default:
      return other;
  }
}

function foldBinary(
  operator: string,
  left: CsValue,
  right: CsValue,
  node: SyntaxNode,
  other: CsValue
): CsValue {
  if (left.kind === 'string' && right.kind === 'string') {
    return { kind: 'string', value: left.value + right.value };
  }
  if (left.kind === 'number' && right.kind === 'number') {
    const text: string = node.text;
    if (operator === '<<' || /<</.test(text)) {
      return {
        kind: 'number',
        value: left.value * 2 ** right.value,
        text,
      };
    }
    if (operator === '|' || /\|/.test(text)) {
      return { kind: 'number', value: left.value | right.value, text };
    }
    if (operator === '+' || /\+/.test(text)) {
      return { kind: 'number', value: left.value + right.value, text };
    }
  }
  return other;
}

/** The expressions inside an array or collection initializer. */
function itemsOf(node: SyntaxNode): SyntaxNode[] {
  const container: SyntaxNode =
    node.type === 'array_creation_expression' ||
    node.type === 'implicit_array_creation_expression'
      ? (node.namedChildren.find(
          (child: SyntaxNode) => child.type === 'initializer_expression'
        ) ?? node)
      : node;
  if (container === node && node.type !== 'initializer_expression') {
    return node.namedChildren.filter(
      (child: SyntaxNode) => child.type !== 'array_type'
    );
  }
  return container.namedChildren;
}

/** `A.B.C` as ['A', 'B', 'C'], or undefined when a part is not a plain name. */
export function memberPath(node: SyntaxNode): string[] | undefined {
  if (node.type === 'identifier') {
    return [node.text];
  }
  if (node.type === 'generic_name') {
    return [node.namedChild(0)?.text ?? node.text];
  }
  if (node.type !== 'member_access_expression') {
    return undefined;
  }
  const target: SyntaxNode | null = node.childForFieldName('expression');
  const name: SyntaxNode | null = node.childForFieldName('name');
  if (target === null || name === null) {
    return undefined;
  }
  const prefix: string[] | undefined = memberPath(target);
  const last: string[] | undefined = memberPath(name);
  return prefix === undefined || last === undefined
    ? undefined
    : [...prefix, ...last];
}

// ---------------------------------------------------------------------------
// Attributes
// ---------------------------------------------------------------------------

function attributeName(node: SyntaxNode): string {
  const text: string = node.text.split('<')[0] ?? node.text;
  const last: string = text.split('.').pop() ?? text;
  return last.replace(/Attribute$/, '');
}

function readAttribute(node: SyntaxNode): CsAttribute {
  const nameNode: SyntaxNode | null = node.childForFieldName('name');
  const args: SyntaxNode[] = [];
  const named: Map<string, SyntaxNode> = new Map();
  const list: SyntaxNode | undefined = node.namedChildren.find(
    (child: SyntaxNode) => child.type === 'attribute_argument_list'
  );
  for (const argument of list?.namedChildren ?? []) {
    if (argument.type !== 'attribute_argument') {
      continue;
    }
    const label: SyntaxNode | undefined = argument.namedChildren.find(
      (child: SyntaxNode) =>
        child.type === 'name_equals' || child.type === 'name_colon'
    );
    const valueNode: SyntaxNode | undefined = argument.namedChildren.find(
      (child: SyntaxNode) =>
        child.type !== 'name_equals' && child.type !== 'name_colon'
    );
    if (valueNode === undefined) {
      continue;
    }
    if (label === undefined) {
      args.push(valueNode);
    } else {
      named.set(label.namedChild(0)?.text ?? label.text, valueNode);
    }
  }
  return {
    name: attributeName(nameNode ?? node),
    args,
    named,
    node,
  };
}

/** The attributes of a declaration, skipping those aimed at the field, return value or parameters. */
export function readAttributes(declaration: SyntaxNode): CsAttribute[] {
  const attributes: CsAttribute[] = [];
  for (const list of declaration.namedChildren) {
    if (list.type !== 'attribute_list') {
      continue;
    }
    const target: SyntaxNode | undefined = list.namedChildren.find(
      (child: SyntaxNode) => child.type === 'attribute_target_specifier'
    );
    const targetName: string = target?.text.replace(/:$/, '').trim() ?? '';
    if (
      targetName !== '' &&
      targetName !== 'property' &&
      targetName !== 'type'
    ) {
      continue;
    }
    for (const child of list.namedChildren) {
      if (child.type === 'attribute') {
        attributes.push(readAttribute(child));
      }
    }
  }
  return attributes;
}
