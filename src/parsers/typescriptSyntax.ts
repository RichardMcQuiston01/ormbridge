import { createRequire } from 'node:module';
import Parser from 'web-tree-sitter';
import { describeThrown, err, ok, type Result } from '../result.js';

export type SyntaxNode = Parser.SyntaxNode;

/** Statically evaluated subset of TypeScript expressions found in entity definitions. */
export type TsValue =
  | { kind: 'string'; value: string }
  | { kind: 'number'; value: number }
  | { kind: 'bool'; value: boolean }
  | { kind: 'null' }
  | { kind: 'name'; value: string }
  | { kind: 'array'; items: TsValue[] }
  | TsObject
  | TsArrow
  | TsCall
  | { kind: 'other'; text: string };

export interface TsObject {
  kind: 'object';
  properties: Record<string, TsValue>;
}

/** An arrow function or function expression, reduced to the value it returns. */
export interface TsArrow {
  kind: 'arrow';
  /** Parameter names, in order (for example the "u" in `(u) => u.posts`). */
  params: string[];
  /** The returned expression; "other" when the body is a block. */
  body: TsValue;
}

export interface TsCall {
  kind: 'call';
  callee: string;
  args: TsValue[];
}

/** One decorator, for example `@Column('varchar', { length: 20 })`. */
export interface TsDecorator {
  /** Callee name without any namespace prefix, for example "Column". */
  name: string;
  /** Callee name exactly as written, for example "typeorm.Column". */
  rawName: string;
  args: TsValue[];
}

let cachedParser: Parser | undefined;

/** Lazily loads the tree-sitter TypeScript grammar (WebAssembly, no native build step). */
export async function getTypeScriptParser(): Promise<Result<Parser>> {
  if (cachedParser !== undefined) {
    return ok(cachedParser);
  }
  try {
    const requireFromHere: NodeRequire = createRequire(import.meta.url);
    const wasmPath: string = requireFromHere.resolve(
      'tree-sitter-wasms/out/tree-sitter-typescript.wasm'
    );
    await Parser.init();
    const typescriptLanguage: Parser.Language =
      await Parser.Language.load(wasmPath);
    const parser: Parser = new Parser();
    parser.setLanguage(typescriptLanguage);
    cachedParser = parser;
    return ok(parser);
  } catch (thrown) {
    return err(
      'PARSER_INIT_FAILED',
      `Failed to initialize the tree-sitter TypeScript grammar. Check that the "web-tree-sitter" (0.22.x) and ` +
        `"tree-sitter-wasms" packages are installed. Underlying error: ${describeThrown(thrown)}`
    );
  }
}

export function lastSegment(dottedName: string): string {
  const segments: string[] = dottedName.split('.');
  return segments[segments.length - 1] ?? dottedName;
}

function unquote(literalText: string): string {
  const quote: string = literalText.charAt(0);
  const body: string = literalText.slice(1, -1);
  if (quote !== '"' && quote !== "'" && quote !== '`') {
    return literalText;
  }
  return body.replace(
    /\\(n|t|r|\\|"|'|`)/g,
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

/** Evaluates a tree-sitter expression node into the supported TsValue subset. */
export function evaluateNode(node: SyntaxNode): TsValue {
  switch (node.type) {
    case 'string':
      return { kind: 'string', value: unquote(node.text) };
    case 'template_string':
      // Only substitution-free templates can be evaluated statically.
      return node.namedChildren.some(
        (child: SyntaxNode) => child.type === 'template_substitution'
      )
        ? { kind: 'other', text: node.text }
        : { kind: 'string', value: unquote(node.text) };
    case 'number': {
      const parsedNumber: number = Number(node.text.replace(/_/g, ''));
      return Number.isNaN(parsedNumber)
        ? { kind: 'other', text: node.text }
        : { kind: 'number', value: parsedNumber };
    }
    case 'true':
      return { kind: 'bool', value: true };
    case 'false':
      return { kind: 'bool', value: false };
    case 'null':
    case 'undefined':
      return { kind: 'null' };
    case 'identifier':
    case 'member_expression':
    case 'nested_identifier':
    case 'type_identifier':
      return { kind: 'name', value: node.text.replace(/\s+/g, '') };
    case 'array':
      return { kind: 'array', items: node.namedChildren.map(evaluateNode) };
    case 'object':
      return evaluateObject(node);
    case 'parenthesized_expression':
    case 'as_expression':
    case 'satisfies_expression':
    case 'non_null_expression': {
      const inner: SyntaxNode | undefined = node.namedChildren[0];
      return inner === undefined
        ? { kind: 'other', text: node.text }
        : evaluateNode(inner);
    }
    case 'unary_expression': {
      const operand: SyntaxNode | undefined = node.namedChildren[0];
      if (operand !== undefined && node.text.startsWith('-')) {
        const operandValue: TsValue = evaluateNode(operand);
        if (operandValue.kind === 'number') {
          return { kind: 'number', value: -operandValue.value };
        }
      }
      return { kind: 'other', text: node.text };
    }
    case 'arrow_function':
    case 'function_expression':
      return evaluateFunction(node);
    case 'call_expression':
      return evaluateCall(node);
    default:
      return { kind: 'other', text: node.text };
  }
}

function evaluateObject(node: SyntaxNode): TsObject {
  const properties: Record<string, TsValue> = {};
  for (const child of node.namedChildren) {
    if (child.type === 'pair') {
      const keyNode: SyntaxNode | null = child.childForFieldName('key');
      const valueNode: SyntaxNode | null = child.childForFieldName('value');
      if (keyNode !== null && valueNode !== null) {
        const key: string =
          keyNode.type === 'string' ? unquote(keyNode.text) : keyNode.text;
        properties[key] = evaluateNode(valueNode);
      }
    } else if (child.type === 'shorthand_property_identifier') {
      properties[child.text] = { kind: 'name', value: child.text };
    } else if (child.type === 'spread_element') {
      properties[`...${child.text}`] = { kind: 'other', text: child.text };
    }
  }
  return { kind: 'object', properties };
}

function evaluateFunction(node: SyntaxNode): TsArrow {
  const parametersNode: SyntaxNode | null =
    node.childForFieldName('parameters') ?? node.childForFieldName('parameter');
  const params: string[] = [];
  if (parametersNode !== null) {
    if (parametersNode.type === 'identifier') {
      params.push(parametersNode.text);
    } else {
      for (const parameter of parametersNode.namedChildren) {
        const patternNode: SyntaxNode | null =
          parameter.childForFieldName('pattern');
        params.push((patternNode ?? parameter).text);
      }
    }
  }
  const bodyNode: SyntaxNode | null = node.childForFieldName('body');
  let body: TsValue = { kind: 'other', text: node.text };
  if (bodyNode !== null) {
    if (bodyNode.type === 'statement_block') {
      const returned: SyntaxNode | undefined = bodyNode.namedChildren.find(
        (statement: SyntaxNode) => statement.type === 'return_statement'
      );
      const returnedValue: SyntaxNode | undefined = returned?.namedChildren[0];
      if (returnedValue !== undefined && bodyNode.namedChildCount === 1) {
        body = evaluateNode(returnedValue);
      }
    } else {
      body = evaluateNode(bodyNode);
    }
  }
  return { kind: 'arrow', params, body };
}

function evaluateCall(node: SyntaxNode): TsValue {
  const functionNode: SyntaxNode | null = node.childForFieldName('function');
  const argumentsNode: SyntaxNode | null = node.childForFieldName('arguments');
  const callee: string =
    functionNode === null ? '' : functionNode.text.replace(/\s+/g, '');
  const args: TsValue[] = [];
  if (argumentsNode !== null) {
    for (const argumentNode of argumentsNode.namedChildren) {
      if (argumentNode.type !== 'comment') {
        args.push(evaluateNode(argumentNode));
      }
    }
  }
  return { kind: 'call', callee, args };
}

/** Reads the decorators that apply to a class or class member. */
export function decoratorsOf(node: SyntaxNode): TsDecorator[] {
  const decorators: TsDecorator[] = [];
  for (const child of node.namedChildren) {
    if (child.type !== 'decorator') {
      continue;
    }
    const expression: SyntaxNode | undefined = child.namedChildren[0];
    if (expression === undefined) {
      continue;
    }
    if (expression.type === 'call_expression') {
      const evaluated: TsValue = evaluateNode(expression);
      if (evaluated.kind === 'call') {
        decorators.push({
          name: lastSegment(evaluated.callee),
          rawName: evaluated.callee,
          args: evaluated.args,
        });
      }
    } else {
      const rawName: string = expression.text.replace(/\s+/g, '');
      decorators.push({ name: lastSegment(rawName), rawName, args: [] });
    }
  }
  return decorators;
}
