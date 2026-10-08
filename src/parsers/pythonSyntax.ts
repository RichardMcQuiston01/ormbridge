import { createRequire } from 'node:module';
import Parser from 'web-tree-sitter';
import { describeThrown, err, ok, type Result } from '../result.js';

export type SyntaxNode = Parser.SyntaxNode;

/** Statically evaluated subset of Python expressions found in model definitions. */
export type PyValue =
  | { kind: 'string'; value: string }
  | { kind: 'number'; value: number }
  | { kind: 'bool'; value: boolean }
  | { kind: 'none' }
  | { kind: 'name'; value: string }
  | { kind: 'list'; items: PyValue[] }
  | PyCall
  | { kind: 'other'; text: string };

export interface PyCall {
  kind: 'call';
  callee: string;
  args: PyValue[];
  kwargs: Record<string, PyValue>;
  /** Source text of the whole call, with line breaks collapsed to single spaces. */
  text: string;
}

let cachedParser: Parser | undefined;

/** Lazily loads the tree-sitter Python grammar (WebAssembly, no native build step). */
export async function getPythonParser(): Promise<Result<Parser>> {
  if (cachedParser !== undefined) {
    return ok(cachedParser);
  }
  try {
    const requireFromHere: NodeRequire = createRequire(import.meta.url);
    const wasmPath: string = requireFromHere.resolve(
      'tree-sitter-wasms/out/tree-sitter-python.wasm'
    );
    await Parser.init();
    const pythonLanguage: Parser.Language =
      await Parser.Language.load(wasmPath);
    const parser: Parser = new Parser();
    parser.setLanguage(pythonLanguage);
    cachedParser = parser;
    return ok(parser);
  } catch (thrown) {
    return err(
      'PARSER_INIT_FAILED',
      `Failed to initialize the tree-sitter Python grammar. Check that the "web-tree-sitter" (0.22.x) and ` +
        `"tree-sitter-wasms" packages are installed. Underlying error: ${describeThrown(thrown)}`
    );
  }
}

export function lastSegment(dottedName: string): string {
  const segments: string[] = dottedName.split('.');
  return segments[segments.length - 1] ?? dottedName;
}

function unquote(literalText: string): string {
  const match: RegExpExecArray | null =
    /^[rRbBuUfF]*("""|'''|"|')([\s\S]*)\1$/.exec(literalText);
  if (match === null) {
    return literalText;
  }
  const body: string = match[2] ?? '';
  return body.replace(/\\(["'\\])/g, '$1').replace(/\\n/g, '\n');
}

/** Evaluates a tree-sitter expression node into the supported PyValue subset. */
export function evaluateNode(node: SyntaxNode): PyValue {
  switch (node.type) {
    case 'string':
      return { kind: 'string', value: unquote(node.text) };
    case 'concatenated_string': {
      const joined: string = node.namedChildren
        .filter((child: SyntaxNode) => child.type === 'string')
        .map((child: SyntaxNode) => unquote(child.text))
        .join('');
      return { kind: 'string', value: joined };
    }
    case 'integer':
    case 'float': {
      const parsedNumber: number = Number(node.text.replace(/_/g, ''));
      return Number.isNaN(parsedNumber)
        ? { kind: 'other', text: node.text }
        : { kind: 'number', value: parsedNumber };
    }
    case 'true':
      return { kind: 'bool', value: true };
    case 'false':
      return { kind: 'bool', value: false };
    case 'none':
      return { kind: 'none' };
    case 'identifier':
    case 'attribute':
      return { kind: 'name', value: node.text.replace(/\s+/g, '') };
    case 'list':
    case 'tuple':
    case 'expression_list':
    case 'set':
      return { kind: 'list', items: node.namedChildren.map(evaluateNode) };
    case 'parenthesized_expression': {
      const inner: SyntaxNode | undefined = node.namedChildren[0];
      return inner === undefined
        ? { kind: 'other', text: node.text }
        : evaluateNode(inner);
    }
    case 'unary_operator': {
      const operand: SyntaxNode | undefined = node.namedChildren[0];
      if (operand !== undefined && node.text.startsWith('-')) {
        const operandValue: PyValue = evaluateNode(operand);
        if (operandValue.kind === 'number') {
          return { kind: 'number', value: -operandValue.value };
        }
      }
      return { kind: 'other', text: node.text };
    }
    case 'call':
      return evaluateCall(node);
    default:
      return { kind: 'other', text: node.text };
  }
}

function evaluateCall(node: SyntaxNode): PyValue {
  const functionNode: SyntaxNode | null = node.childForFieldName('function');
  const argumentsNode: SyntaxNode | null = node.childForFieldName('arguments');
  const callee: string =
    functionNode === null ? '' : functionNode.text.replace(/\s+/g, '');
  const args: PyValue[] = [];
  const kwargs: Record<string, PyValue> = {};
  if (argumentsNode !== null && argumentsNode.type === 'argument_list') {
    for (const argumentNode of argumentsNode.namedChildren) {
      if (argumentNode.type === 'keyword_argument') {
        const keyNode: SyntaxNode | null =
          argumentNode.childForFieldName('name');
        const valueNode: SyntaxNode | null =
          argumentNode.childForFieldName('value');
        if (keyNode !== null && valueNode !== null) {
          kwargs[keyNode.text] = evaluateNode(valueNode);
        }
      } else if (argumentNode.type !== 'comment') {
        args.push(evaluateNode(argumentNode));
      }
    }
  }
  return {
    kind: 'call',
    callee,
    args,
    kwargs,
    text: node.text.replace(/\s*\n\s*/g, ' '),
  };
}
