import {
  evaluate,
  memberPath,
  parseTypeText,
  type ConstLookup,
  type CsType,
  type CsValue,
  type SyntaxNode,
} from './csharpSyntax.js';

// ---------------------------------------------------------------------------
// Lambdas and call chains
// ---------------------------------------------------------------------------

export interface CsLambda {
  /** The first parameter name, when the lambda has one. */
  parameter: string | undefined;
  /** The body: a block, or the expression of an expression-bodied lambda. */
  body: SyntaxNode;
}

/** Splits a lambda (`x => ...`, `(x) => ...`, `delegate (x) { }`) into its first parameter and body. */
export function readLambda(node: SyntaxNode): CsLambda | undefined {
  if (node.type === 'parenthesized_expression') {
    const inner: SyntaxNode | null = node.namedChild(0);
    return inner === null ? undefined : readLambda(inner);
  }
  if (
    node.type !== 'lambda_expression' &&
    node.type !== 'anonymous_method_expression'
  ) {
    return undefined;
  }
  const body: SyntaxNode | null = node.childForFieldName('body');
  if (body === null) {
    return undefined;
  }
  const list: SyntaxNode | undefined = node.namedChildren.find(
    (child: SyntaxNode) =>
      child.type === 'parameter_list' ||
      child.type === 'implicit_parameter_list'
  );
  if (list !== undefined) {
    const first: SyntaxNode | undefined = list.namedChildren[0];
    const nameNode: SyntaxNode | null | undefined =
      first?.childForFieldName('name');
    return { parameter: nameNode?.text ?? first?.text, body };
  }
  const identifier: SyntaxNode | undefined = node.namedChildren.find(
    (child: SyntaxNode) => child.type === 'identifier'
  );
  return { parameter: identifier?.text, body };
}

/** The statements of a lambda body or method body; an expression body counts as one statement. */
export function bodyStatements(body: SyntaxNode): SyntaxNode[] {
  if (body.type === 'block') {
    return body.namedChildren.filter(
      (child: SyntaxNode) => child.type !== 'comment'
    );
  }
  if (body.type === 'arrow_expression_clause') {
    const inner: SyntaxNode | null = body.namedChild(0);
    return inner === null ? [] : [inner];
  }
  return [body];
}

export interface CsCall {
  name: string;
  typeArgs: CsType[];
  /** The argument expressions, in order (names such as `keyName:` are dropped). */
  args: SyntaxNode[];
  node: SyntaxNode;
}

export interface CsChain {
  /** The expression the chain starts from: usually an identifier such as `modelBuilder`. */
  root: SyntaxNode;
  calls: CsCall[];
}

/** The expressions of an `argument_list`. */
export function argumentExpressions(list: SyntaxNode | null): SyntaxNode[] {
  if (list === null) {
    return [];
  }
  const expressions: SyntaxNode[] = [];
  for (const argument of list.namedChildren) {
    if (argument.type !== 'argument') {
      continue;
    }
    const inner: SyntaxNode | undefined = [...argument.namedChildren]
      .reverse()
      .find((child: SyntaxNode) => child.type !== 'name_colon');
    if (inner !== undefined) {
      expressions.push(inner);
    }
  }
  return expressions;
}

/**
 * Flattens `a.B(x).C<T>(y)` into the root `a` and the calls [B(x), C<T>(y)]. Returns undefined
 * for an expression that is not a call.
 */
export function flattenChain(expression: SyntaxNode): CsChain | undefined {
  const calls: CsCall[] = [];
  let current: SyntaxNode = expression;
  let finished: boolean = false;
  for (let guard: number = 0; guard < 4096; guard += 1) {
    if (current.type === 'parenthesized_expression') {
      const inner: SyntaxNode | null = current.namedChild(0);
      if (inner === null) {
        return undefined;
      }
      current = inner;
      continue;
    }
    if (current.type !== 'invocation_expression') {
      finished = true;
      break;
    }
    const fn: SyntaxNode | null = current.childForFieldName('function');
    if (fn === null) {
      return undefined;
    }
    const args: SyntaxNode[] = argumentExpressions(
      current.childForFieldName('arguments')
    );
    let nameNode: SyntaxNode | null = fn;
    let receiver: SyntaxNode | null = null;
    if (fn.type === 'member_access_expression') {
      nameNode = fn.childForFieldName('name');
      receiver = fn.childForFieldName('expression');
    }
    if (nameNode === null) {
      return undefined;
    }
    const typeArgs: CsType[] =
      nameNode.type === 'generic_name'
        ? (nameNode.namedChildren
            .find((child: SyntaxNode) => child.type === 'type_argument_list')
            ?.namedChildren.map((child: SyntaxNode) =>
              parseTypeText(child.text)
            ) ?? [])
        : [];
    const name: string =
      nameNode.type === 'generic_name'
        ? (nameNode.namedChild(0)?.text ?? nameNode.text)
        : nameNode.text;
    calls.unshift({ name, typeArgs, args, node: current });
    if (receiver === null) {
      return calls.length === 0 ? undefined : { root: fn, calls };
    }
    current = receiver;
  }
  // A chain longer than any real configuration is not read.
  return finished && calls.length > 0 ? { root: current, calls } : undefined;
}

/**
 * The property names a lambda or string selects, relative to the lambda parameter: `e => e.A` is ['A'],
 * `e => new { e.A, e.B }` is ['A', 'B'], `"A"` is ['A'], `nameof(Post.Title)` is ['Title']. Nested access
 * (`e => e.Address.Street`) gives the dotted path 'Address.Street'.
 */
export function selectedMembers(
  node: SyntaxNode,
  consts: ConstLookup
): string[] | undefined {
  const lambda: CsLambda | undefined = readLambda(node);
  if (lambda !== undefined) {
    const body: SyntaxNode = lambda.body;
    const parts: SyntaxNode[] =
      body.type === 'anonymous_object_creation_expression' ||
      body.type === 'tuple_expression'
        ? body.namedChildren.map((child: SyntaxNode) =>
            child.type === 'argument' ? (child.namedChild(0) ?? child) : child
          )
        : [body];
    const names: string[] = [];
    for (const part of parts) {
      const inner: SyntaxNode =
        part.type === 'name_equals' || part.type === 'assignment_expression'
          ? (part.namedChildren[part.namedChildren.length - 1] ?? part)
          : part;
      const path: string[] | undefined = memberPath(inner);
      if (path === undefined || path.length < 2) {
        return undefined;
      }
      names.push(path.slice(1).join('.'));
    }
    return names;
  }
  const value: CsValue = evaluate(node, consts);
  const flatten = (item: CsValue): string[] | undefined => {
    if (item.kind === 'string') {
      return [item.value];
    }
    if (item.kind === 'nameof') {
      return [item.name];
    }
    if (item.kind === 'array') {
      const all: string[] = [];
      for (const inner of item.items) {
        const names: string[] | undefined = flatten(inner);
        if (names === undefined) {
          return undefined;
        }
        all.push(...names);
      }
      return all;
    }
    return undefined;
  };
  return flatten(value);
}
