import { basename } from 'node:path';
import type { SyntaxNode } from './typescriptSyntax.js';

/**
 * Syntax helpers of the Zod reader: which names are Zod, how a `z.string().min(1).optional()` chain
 * is split into its base and steps, and how object literals, const objects and TypeScript enums are read.
 * Nothing here runs the code; everything is read from the tree-sitter syntax tree.
 */

export interface ZodFileInfo {
  path: string;
  /** Short name used in warnings. */
  label: string;
  /** Local names that stand for the Zod namespace (`z`, `zod`, `* as z`). */
  namespaces: Set<string>;
  /** Local name -> exported name for named imports other than `z` (`import { object, string } from 'zod'`). */
  direct: Map<string, string>;
}

/** One call chained on a schema, for example `.min(3)` in `z.string().min(3)`. */
export interface ChainStep {
  name: string;
  args: SyntaxNode[];
}

/**
 * A Zod expression split into where it starts and the calls chained on it. It starts either at a Zod
 * constructor (`base`, such as `string`, `coerce.number` or `iso.date`) or at a name declared elsewhere (`ref`).
 */
export interface ZodChain {
  base?: { name: string; args: SyntaxNode[] };
  ref?: string;
  steps: ChainStep[];
}

const TRANSPARENT_NODES: ReadonlySet<string> = new Set([
  'parenthesized_expression',
  'as_expression',
  'satisfies_expression',
  'non_null_expression',
  'type_assertion',
]);

/** Prefixes of Zod 4 sub-namespaces (`z.coerce.number()`, `z.iso.date()`). */
const SUB_NAMESPACES: readonly string[] = ['coerce', 'iso'];

export function stripWrappers(node: SyntaxNode): SyntaxNode {
  let current: SyntaxNode = node;
  while (TRANSPARENT_NODES.has(current.type)) {
    const inner: SyntaxNode | undefined = current.namedChildren[0];
    if (inner === undefined) {
      break;
    }
    current = inner;
  }
  return current;
}

function isZodModule(source: string): boolean {
  return /(^|[/@-])zod($|[/-])/.test(source);
}

/** Reads the imports of a file to find the names Zod is bound to. */
export function describeZodFile(path: string, root: SyntaxNode): ZodFileInfo {
  const namespaces: Set<string> = new Set<string>();
  const direct: Map<string, string> = new Map<string, string>();
  let importsZod: boolean = false;
  for (const statement of root.namedChildren) {
    if (statement.type !== 'import_statement') {
      continue;
    }
    const sourceNode: SyntaxNode | null = statement.childForFieldName('source');
    const source: string = sourceNode?.text.slice(1, -1) ?? '';
    if (!isZodModule(source)) {
      continue;
    }
    importsZod = true;
    const stack: SyntaxNode[] = [...statement.namedChildren];
    while (stack.length > 0) {
      const node: SyntaxNode | undefined = stack.pop();
      if (node === undefined) {
        break;
      }
      if (node.type === 'import_specifier') {
        const nameNode: SyntaxNode | null = node.childForFieldName('name');
        const aliasNode: SyntaxNode | null = node.childForFieldName('alias');
        const exported: string = nameNode?.text ?? '';
        const local: string = aliasNode?.text ?? exported;
        if (exported === 'z') {
          namespaces.add(local);
        } else if (exported !== '') {
          direct.set(local, exported);
        }
      } else if (node.type === 'namespace_import') {
        const nameNode: SyntaxNode | undefined = node.namedChildren[0];
        if (nameNode !== undefined) {
          namespaces.add(nameNode.text);
        }
      } else if (node.type === 'import_clause') {
        // A default import (`import z from 'zod'`) is a direct child identifier of the clause.
        for (const child of node.namedChildren) {
          if (child.type === 'identifier') {
            namespaces.add(child.text);
          } else {
            stack.push(child);
          }
        }
      } else {
        stack.push(...node.namedChildren);
      }
    }
  }
  if (!importsZod) {
    // Snippets without imports are common in tests and docs: assume the usual `z`.
    namespaces.add('z');
  }
  return { path, label: basename(path), namespaces, direct };
}

function callArguments(call: SyntaxNode): SyntaxNode[] {
  const argumentsNode: SyntaxNode | null = call.childForFieldName('arguments');
  if (argumentsNode === null || argumentsNode.type === 'template_string') {
    return [];
  }
  return argumentsNode.namedChildren.filter(
    (child: SyntaxNode) => child.type !== 'comment'
  );
}

/** The Zod constructor a callee names (`z.string` gives "string", `z.coerce.number` gives "coerce.number"). */
function constructorName(
  file: ZodFileInfo,
  callee: SyntaxNode
): string | undefined {
  if (callee.type === 'identifier') {
    return file.direct.get(callee.text);
  }
  if (callee.type !== 'member_expression') {
    return undefined;
  }
  const objectNode: SyntaxNode | null = callee.childForFieldName('object');
  const propertyNode: SyntaxNode | null = callee.childForFieldName('property');
  if (objectNode === null || propertyNode === null) {
    return undefined;
  }
  const objectText: string = objectNode.text.replace(/\s+/g, '');
  if (file.namespaces.has(objectText)) {
    return propertyNode.text;
  }
  for (const namespace of file.namespaces) {
    for (const sub of SUB_NAMESPACES) {
      if (objectText === `${namespace}.${sub}`) {
        return `${sub}.${propertyNode.text}`;
      }
    }
  }
  return undefined;
}

/**
 * Splits `z.string().min(3).optional()` or `UserSchema.omit({ id: true })` into its base and steps.
 * Returns undefined when the expression is neither (a number, a plain object, an unknown call).
 */
export function unwindChain(
  file: ZodFileInfo,
  node: SyntaxNode
): ZodChain | undefined {
  const current: SyntaxNode = stripWrappers(node);
  if (current.type === 'identifier') {
    if (file.namespaces.has(current.text)) {
      return undefined;
    }
    return { ref: current.text, steps: [] };
  }
  if (current.type !== 'call_expression') {
    return undefined;
  }
  const callee: SyntaxNode | null = current.childForFieldName('function');
  if (callee === null) {
    return undefined;
  }
  const args: SyntaxNode[] = callArguments(current);
  const name: string | undefined = constructorName(file, callee);
  if (name !== undefined) {
    return { base: { name, args }, steps: [] };
  }
  if (callee.type !== 'member_expression') {
    return undefined;
  }
  const objectNode: SyntaxNode | null = callee.childForFieldName('object');
  const propertyNode: SyntaxNode | null = callee.childForFieldName('property');
  if (objectNode === null || propertyNode === null) {
    return undefined;
  }
  const inner: ZodChain | undefined = unwindChain(file, objectNode);
  if (inner === undefined) {
    return undefined;
  }
  return {
    ...inner,
    steps: [...inner.steps, { name: propertyNode.text, args }],
  };
}

/** The expression a function returns (an arrow's expression body, or the `return` of a block body). */
export function functionResult(fn: SyntaxNode): SyntaxNode | undefined {
  const body: SyntaxNode | null = fn.childForFieldName('body');
  if (body === null) {
    return undefined;
  }
  if (body.type === 'statement_block') {
    const returned: SyntaxNode | undefined = body.namedChildren.find(
      (statement: SyntaxNode) => statement.type === 'return_statement'
    );
    const value: SyntaxNode | undefined = returned?.namedChildren.find(
      (child: SyntaxNode) => child.type !== 'comment'
    );
    return value === undefined ? undefined : stripWrappers(value);
  }
  return stripWrappers(body);
}

export function isFunctionNode(node: SyntaxNode): boolean {
  return (
    node.type === 'arrow_function' ||
    node.type === 'function_expression' ||
    node.type === 'function'
  );
}

function unquote(text: string): string {
  const quote: string = text.charAt(0);
  if (quote !== '"' && quote !== "'" && quote !== '`') {
    return text;
  }
  return text
    .slice(1, -1)
    .replace(
      /\\(n|t|r|\\|"|'|`)/g,
      (_whole: string, escaped: string): string =>
        escaped === 'n'
          ? '\n'
          : escaped === 't'
            ? '\t'
            : escaped === 'r'
              ? '\r'
              : escaped
    );
}

/** A literal read from the syntax tree. */
export type LiteralValue = string | number | boolean | null;

/** Reads a string, number, boolean or null literal (also `-1`); undefined for anything else. */
export function literalOf(node: SyntaxNode): LiteralValue | undefined {
  const current: SyntaxNode = stripWrappers(node);
  switch (current.type) {
    case 'string':
      return unquote(current.text);
    case 'template_string':
      return current.namedChildren.some(
        (child: SyntaxNode) => child.type === 'template_substitution'
      )
        ? undefined
        : unquote(current.text);
    case 'number': {
      const value: number = Number(current.text.replace(/_/g, ''));
      return Number.isNaN(value) ? undefined : value;
    }
    case 'true':
      return true;
    case 'false':
      return false;
    case 'null':
      return null;
    case 'unary_expression': {
      const operand: SyntaxNode | undefined = current.namedChildren[0];
      const value: LiteralValue | undefined =
        operand === undefined ? undefined : literalOf(operand);
      return current.text.startsWith('-') && typeof value === 'number'
        ? -value
        : undefined;
    }
    default:
      return undefined;
  }
}

/** The key of an object property: an identifier, a string or a number. */
export function propertyKey(keyNode: SyntaxNode): string | undefined {
  switch (keyNode.type) {
    case 'property_identifier':
    case 'identifier':
      return keyNode.text;
    case 'string':
      return unquote(keyNode.text);
    case 'number':
      return keyNode.text;
    default:
      return undefined;
  }
}

/** One member of an object literal that holds a value expression. */
export interface ObjectMember {
  kind: 'property' | 'spread';
  key: string;
  /** The value expression (the argument of a spread). */
  node: SyntaxNode;
}

/**
 * The members of an object literal, in order: `key: value` pairs, shorthand properties (`{ name }`),
 * getters (`get parent() { return CategorySchema; }`, the Zod 4 way to write a recursive schema) and spreads.
 * Anything else (computed keys, methods) is returned in `skipped`.
 */
export function objectMembers(objectNode: SyntaxNode): {
  members: ObjectMember[];
  skipped: string[];
} {
  const members: ObjectMember[] = [];
  const skipped: string[] = [];
  for (const child of objectNode.namedChildren) {
    switch (child.type) {
      case 'pair': {
        const keyNode: SyntaxNode | null = child.childForFieldName('key');
        const valueNode: SyntaxNode | null = child.childForFieldName('value');
        const key: string | undefined =
          keyNode === null ? undefined : propertyKey(keyNode);
        if (key === undefined || valueNode === null) {
          skipped.push(child.text);
        } else {
          members.push({ kind: 'property', key, node: valueNode });
        }
        break;
      }
      case 'shorthand_property_identifier':
        members.push({ kind: 'property', key: child.text, node: child });
        break;
      case 'method_definition': {
        const nameNode: SyntaxNode | null = child.childForFieldName('name');
        const isGetter: boolean = child.children.some(
          (part: SyntaxNode) => part.type === 'get'
        );
        const result: SyntaxNode | undefined = isFunctionNode(child)
          ? undefined
          : functionResult(child);
        const key: string | undefined =
          nameNode === null ? undefined : propertyKey(nameNode);
        if (isGetter && key !== undefined && result !== undefined) {
          members.push({ kind: 'property', key, node: result });
        } else {
          skipped.push(child.text);
        }
        break;
      }
      case 'spread_element': {
        const target: SyntaxNode | undefined = child.namedChildren[0];
        if (target === undefined) {
          skipped.push(child.text);
        } else {
          members.push({ kind: 'spread', key: '', node: target });
        }
        break;
      }
      case 'comment':
        break;
      default:
        skipped.push(child.text);
    }
  }
  return { members, skipped };
}

/** The name `X` of an expression `X` or `X.shape`, the two ways to point at another schema's shape. */
export function shapeReference(node: SyntaxNode): string | undefined {
  const current: SyntaxNode = stripWrappers(node);
  if (current.type === 'identifier') {
    return current.text;
  }
  if (current.type === 'member_expression') {
    const objectNode: SyntaxNode | null = current.childForFieldName('object');
    const propertyNode: SyntaxNode | null =
      current.childForFieldName('property');
    if (
      objectNode !== null &&
      propertyNode?.text === 'shape' &&
      objectNode.type === 'identifier'
    ) {
      return objectNode.text;
    }
  }
  return undefined;
}

/** The members of a TypeScript `enum` declaration: member name and its string or number value. */
export function enumMembers(
  enumNode: SyntaxNode
): { name: string; value: string | number }[] {
  const members: { name: string; value: string | number }[] = [];
  const body: SyntaxNode | null = enumNode.childForFieldName('body');
  let nextNumber: number = 0;
  for (const member of body?.namedChildren ?? []) {
    let name: string | undefined;
    let valueNode: SyntaxNode | null = null;
    if (member.type === 'property_identifier' || member.type === 'string') {
      name = propertyKey(member);
    } else if (member.type === 'enum_assignment') {
      const nameNode: SyntaxNode | null = member.childForFieldName('name');
      name = nameNode === null ? undefined : propertyKey(nameNode);
      valueNode = member.childForFieldName('value');
    }
    if (name === undefined) {
      continue;
    }
    const literal: LiteralValue | undefined =
      valueNode === null ? undefined : literalOf(valueNode);
    if (typeof literal === 'string') {
      members.push({ name, value: literal });
    } else if (typeof literal === 'number') {
      members.push({ name, value: literal });
      nextNumber = literal + 1;
    } else if (valueNode === null) {
      members.push({ name, value: nextNumber });
      nextNumber += 1;
    }
  }
  return members;
}
