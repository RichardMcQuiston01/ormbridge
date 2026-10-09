import { createRequire } from 'node:module';
import Parser from 'web-tree-sitter';
import { describeThrown, err, ok, type Result } from '../result.js';

export type SyntaxNode = Parser.SyntaxNode;

/** One element of a PHP array literal; `key` is absent for list-style elements. */
export interface PhpArrayItem {
  key?: PhpValue;
  value: PhpValue;
}

/** A `new Foo(...)` expression, as used for nested attributes such as `new ORM\Index(...)`. */
export interface PhpNew {
  kind: 'new';
  /** Class name exactly as written, for example "ORM\Index". */
  className: string;
  args: PhpValue[];
  named: Record<string, PhpValue>;
}

/** Statically evaluated subset of PHP expressions found in attribute arguments. */
export type PhpValue =
  | { kind: 'string'; value: string }
  | { kind: 'number'; value: number }
  | { kind: 'bool'; value: boolean }
  | { kind: 'null' }
  /** `Foo::class`; `name` is as written (`Foo`, `\App\Foo`, `self`). */
  | { kind: 'classRef'; name: string }
  /** `Types::STRING` or `ClassMetadata::GENERATOR_TYPE_AUTO`. */
  | { kind: 'constant'; owner: string; name: string }
  /** A bare constant or identifier. */
  | { kind: 'name'; value: string }
  | { kind: 'array'; items: PhpArrayItem[] }
  | PhpNew
  | { kind: 'other'; text: string };

/** One attribute, for example `#[ORM\Column(type: 'string', length: 20)]`. */
export interface PhpAttribute {
  /** Attribute name exactly as written, for example "ORM\Column". */
  rawName: string;
  /** Positional arguments, in order. */
  args: PhpValue[];
  /** Named arguments, keyed by name. */
  named: Record<string, PhpValue>;
}

/** The type declared on a property or promoted constructor parameter. */
export interface PhpTypeInfo {
  /** Type names as written, without the nullability marker or `null`, for example ["Status"]. */
  names: string[];
  /** True for `?T`, `T|null` and `null|T`. */
  nullable: boolean;
  /** The type as written, for messages. */
  text: string;
}

let cachedParser: Parser | undefined;

/** Lazily loads the tree-sitter PHP grammar (WebAssembly, no native build step). */
export async function getPhpParser(): Promise<Result<Parser>> {
  if (cachedParser !== undefined) {
    return ok(cachedParser);
  }
  try {
    const requireFromHere: NodeRequire = createRequire(import.meta.url);
    const wasmPath: string = requireFromHere.resolve(
      'tree-sitter-wasms/out/tree-sitter-php.wasm'
    );
    await Parser.init();
    const phpLanguage: Parser.Language = await Parser.Language.load(wasmPath);
    const parser: Parser = new Parser();
    parser.setLanguage(phpLanguage);
    cachedParser = parser;
    return ok(parser);
  } catch (thrown) {
    return err(
      'PARSER_INIT_FAILED',
      `Failed to initialize the tree-sitter PHP grammar. Check that the "web-tree-sitter" (0.22.x) and ` +
        `"tree-sitter-wasms" packages are installed. Underlying error: ${describeThrown(thrown)}`
    );
  }
}

/** The last segment of a backslash-separated PHP name: `App\Entity\Post` becomes `Post`. */
export function lastNameSegment(phpName: string): string {
  const segments: string[] = phpName.split('\\');
  return segments[segments.length - 1] ?? phpName;
}

/** Removes whitespace inside a name node, for example a name split over several lines. */
function compactName(text: string): string {
  return text.replace(/\s+/g, '');
}

function unquoteSingle(body: string): string {
  return body.replace(/\\([\\'])/g, '$1');
}

function unquoteDouble(body: string): string {
  return body.replace(
    /\\(n|t|r|\\|"|\$)/g,
    (_whole: string, escaped: string): string => {
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
    }
  );
}

/** Evaluates a tree-sitter expression node into the supported PhpValue subset. */
export function evaluateNode(node: SyntaxNode): PhpValue {
  switch (node.type) {
    case 'string':
      return { kind: 'string', value: unquoteSingle(node.text.slice(1, -1)) };
    case 'encapsed_string': {
      // Interpolated strings (variables, expressions) cannot be evaluated statically.
      const isPlain: boolean = node.namedChildren.every(
        (child: SyntaxNode) =>
          child.type === 'string_content' || child.type === 'escape_sequence'
      );
      return isPlain
        ? { kind: 'string', value: unquoteDouble(node.text.slice(1, -1)) }
        : { kind: 'other', text: node.text };
    }
    case 'integer': {
      const parsed: number = Number(node.text.replace(/_/g, ''));
      return Number.isNaN(parsed)
        ? { kind: 'other', text: node.text }
        : { kind: 'number', value: parsed };
    }
    case 'float': {
      const parsed: number = Number(node.text.replace(/_/g, ''));
      return Number.isNaN(parsed)
        ? { kind: 'other', text: node.text }
        : { kind: 'number', value: parsed };
    }
    case 'boolean':
      return { kind: 'bool', value: node.text.toLowerCase() === 'true' };
    case 'null':
      return { kind: 'null' };
    case 'name':
    case 'qualified_name':
    case 'relative_name': {
      const text: string = compactName(node.text);
      const lowered: string = text.toLowerCase();
      if (lowered === 'true' || lowered === 'false') {
        return { kind: 'bool', value: lowered === 'true' };
      }
      if (lowered === 'null') {
        return { kind: 'null' };
      }
      return { kind: 'name', value: text };
    }
    case 'array_creation_expression':
      return evaluateArray(node);
    case 'class_constant_access_expression':
      return evaluateConstantAccess(node);
    case 'parenthesized_expression': {
      const inner: SyntaxNode | undefined = node.namedChildren[0];
      return inner === undefined
        ? { kind: 'other', text: node.text }
        : evaluateNode(inner);
    }
    case 'unary_op_expression': {
      const operand: SyntaxNode | null = node.childForFieldName('argument');
      const operator: string = node.text.trim().charAt(0);
      if (operand !== null && (operator === '-' || operator === '+')) {
        const value: PhpValue = evaluateNode(operand);
        if (value.kind === 'number') {
          return {
            kind: 'number',
            value: operator === '-' ? -value.value : value.value,
          };
        }
      }
      return { kind: 'other', text: node.text };
    }
    case 'object_creation_expression':
      return evaluateNew(node);
    default:
      return { kind: 'other', text: node.text };
  }
}

function evaluateArray(node: SyntaxNode): PhpValue {
  const items: PhpArrayItem[] = [];
  for (const element of node.namedChildren) {
    if (element.type !== 'array_element_initializer') {
      continue;
    }
    const parts: SyntaxNode[] = element.namedChildren.filter(
      (child: SyntaxNode) => child.type !== 'comment'
    );
    const first: SyntaxNode | undefined = parts[0];
    const second: SyntaxNode | undefined = parts[1];
    if (first === undefined) {
      continue;
    }
    if (first.type === 'variadic_unpacking') {
      items.push({ value: { kind: 'other', text: element.text } });
    } else if (second === undefined) {
      items.push({ value: evaluateNode(first) });
    } else {
      items.push({ key: evaluateNode(first), value: evaluateNode(second) });
    }
  }
  return { kind: 'array', items };
}

function evaluateConstantAccess(node: SyntaxNode): PhpValue {
  const children: SyntaxNode[] = node.namedChildren;
  const owner: SyntaxNode | undefined = children[0];
  const member: SyntaxNode | undefined = children[children.length - 1];
  if (owner === undefined || member === undefined || owner === member) {
    return { kind: 'other', text: node.text };
  }
  const ownerName: string = compactName(owner.text);
  const memberName: string = compactName(member.text);
  if (memberName.toLowerCase() === 'class') {
    return { kind: 'classRef', name: ownerName };
  }
  return { kind: 'constant', owner: ownerName, name: memberName };
}

/** Reads the arguments of a call-like node into positional and named values. */
function evaluateArguments(argumentsNode: SyntaxNode | null): {
  args: PhpValue[];
  named: Record<string, PhpValue>;
} {
  const args: PhpValue[] = [];
  const named: Record<string, PhpValue> = {};
  if (argumentsNode === null) {
    return { args, named };
  }
  for (const argument of argumentsNode.namedChildren) {
    if (argument.type !== 'argument') {
      continue;
    }
    const nameNode: SyntaxNode | null = argument.childForFieldName('name');
    const valueNode: SyntaxNode | undefined = argument.namedChildren.find(
      (child: SyntaxNode) =>
        child.id !== nameNode?.id && child.type !== 'comment'
    );
    if (valueNode === undefined) {
      continue;
    }
    const value: PhpValue = evaluateNode(valueNode);
    if (nameNode === null) {
      args.push(value);
    } else {
      named[nameNode.text] = value;
    }
  }
  return { args, named };
}

function evaluateNew(node: SyntaxNode): PhpValue {
  const nameNode: SyntaxNode | undefined = node.namedChildren.find(
    (child: SyntaxNode) =>
      child.type === 'name' ||
      child.type === 'qualified_name' ||
      child.type === 'relative_name'
  );
  const argumentsNode: SyntaxNode | undefined = node.namedChildren.find(
    (child: SyntaxNode) => child.type === 'arguments'
  );
  if (nameNode === undefined) {
    return { kind: 'other', text: node.text };
  }
  const { args, named } = evaluateArguments(argumentsNode ?? null);
  return { kind: 'new', className: compactName(nameNode.text), args, named };
}

/** Reads every attribute that applies to a class, class member or promoted constructor parameter. */
export function attributesOf(node: SyntaxNode): PhpAttribute[] {
  const attributes: PhpAttribute[] = [];
  const list: SyntaxNode | null = node.childForFieldName('attributes');
  if (list === null) {
    return attributes;
  }
  for (const group of list.namedChildren) {
    if (group.type !== 'attribute_group') {
      continue;
    }
    for (const attribute of group.namedChildren) {
      if (attribute.type !== 'attribute') {
        continue;
      }
      const nameNode: SyntaxNode | undefined = attribute.namedChildren.find(
        (child: SyntaxNode) =>
          child.type === 'name' ||
          child.type === 'qualified_name' ||
          child.type === 'relative_name'
      );
      if (nameNode === undefined) {
        continue;
      }
      const { args, named } = evaluateArguments(
        attribute.childForFieldName('parameters')
      );
      attributes.push({ rawName: compactName(nameNode.text), args, named });
    }
  }
  return attributes;
}

/** Reads the declared type of a property or promoted parameter, or undefined when untyped. */
export function typeOf(node: SyntaxNode): PhpTypeInfo | undefined {
  const typeNode: SyntaxNode | null = node.childForFieldName('type');
  if (typeNode === null) {
    return undefined;
  }
  const text: string = compactName(typeNode.text);
  let body: string = text;
  let nullable: boolean = false;
  if (body.startsWith('?')) {
    nullable = true;
    body = body.slice(1);
  }
  const names: string[] = [];
  for (const part of body.split('|')) {
    const stripped: string = part.replace(/^\(|\)$/g, '');
    if (stripped.toLowerCase() === 'null') {
      nullable = true;
    } else if (stripped !== '') {
      names.push(stripped);
    }
  }
  return { names, nullable, text };
}
