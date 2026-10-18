import {
  parseTypeText,
  readAnnotation,
  type ConstLookup,
  type JavaAnnotation,
  type JavaValue,
  type SyntaxNode,
} from './javaSyntax.js';

// ---------------------------------------------------------------------------
// Literals and expressions
// ---------------------------------------------------------------------------

function unescapeJava(body: string): string {
  return body.replace(
    /\\(?:u+([0-9a-fA-F]{4})|([0-7]{1,3})|([\s\S]))/g,
    (
      _whole: string,
      unicode: string | undefined,
      octal: string | undefined,
      single: string | undefined
    ): string => {
      if (unicode !== undefined) {
        return String.fromCharCode(parseInt(unicode, 16));
      }
      if (octal !== undefined) {
        return String.fromCharCode(parseInt(octal, 8));
      }
      switch (single) {
        case 'n':
          return '\n';
        case 't':
          return '\t';
        case 'r':
          return '\r';
        case 'b':
          return '\b';
        case 'f':
          return '\f';
        case 's':
          return ' ';
        default:
          return single ?? '';
      }
    }
  );
}

/** Decodes the text of a regular string literal or text block. */
export function unquoteJavaString(literal: string): string {
  if (literal.startsWith('"""')) {
    return unescapeJava(
      literal
        .replace(/^"""[ \t]*\r?\n?/, '')
        .replace(/[ \t]*"""$/, '')
        .replace(/^[ \t]+/gm, '')
    );
  }
  if (literal.startsWith('"') && literal.endsWith('"') && literal.length >= 2) {
    return unescapeJava(literal.slice(1, -1));
  }
  return literal;
}

function parseNumber(text: string): number | undefined {
  const cleaned: string = text.replace(/_/g, '');
  if (/^0[xX][0-9a-fA-F]+[lL]?$/.test(cleaned)) {
    return parseInt(cleaned.replace(/[lL]$/, ''), 16);
  }
  if (/^0[bB][01]+[lL]?$/.test(cleaned)) {
    return parseInt(cleaned.slice(2).replace(/[lL]$/, ''), 2);
  }
  const plain: string = cleaned.replace(/[lLfFdD]$/, '');
  const value: number = Number(plain);
  return Number.isNaN(value) ? undefined : value;
}

const MAX_EVAL_DEPTH: number = 12;

/** The dotted path of a name or field access (`GenerationType.IDENTITY`), or undefined for other expressions. */
function memberPath(node: SyntaxNode): string[] | undefined {
  if (node.type === 'identifier' || node.type === 'type_identifier') {
    return [node.text];
  }
  if (node.type === 'field_access' || node.type === 'scoped_identifier') {
    const owner: SyntaxNode | null =
      node.childForFieldName('object') ?? node.childForFieldName('scope');
    const name: SyntaxNode | null =
      node.childForFieldName('field') ?? node.childForFieldName('name');
    if (owner === null || name === null) {
      return undefined;
    }
    const prefix: string[] | undefined = memberPath(owner);
    return prefix === undefined ? undefined : [...prefix, name.text];
  }
  return undefined;
}

/** Evaluates an annotation argument or field initializer without running any code. */
export function evaluate(
  node: SyntaxNode,
  lookup: ConstLookup,
  depth: number = 0
): JavaValue {
  if (depth > MAX_EVAL_DEPTH) {
    return { kind: 'other', text: node.text };
  }
  switch (node.type) {
    case 'string_literal':
      return { kind: 'string', value: unquoteJavaString(node.text) };
    case 'character_literal':
      return { kind: 'string', value: unescapeJava(node.text.slice(1, -1)) };
    case 'decimal_integer_literal':
    case 'hex_integer_literal':
    case 'octal_integer_literal':
    case 'binary_integer_literal':
    case 'decimal_floating_point_literal':
    case 'hex_floating_point_literal': {
      const value: number | undefined = parseNumber(node.text);
      return value === undefined
        ? { kind: 'other', text: node.text }
        : { kind: 'number', value, text: node.text };
    }
    case 'true':
      return { kind: 'bool', value: true };
    case 'false':
      return { kind: 'bool', value: false };
    case 'null_literal':
      return { kind: 'null' };
    case 'parenthesized_expression': {
      const inner: SyntaxNode | null = node.namedChild(0);
      return inner === null
        ? { kind: 'other', text: node.text }
        : evaluate(inner, lookup, depth + 1);
    }
    case 'unary_expression': {
      const operand: SyntaxNode | null = node.childForFieldName('operand');
      const value: JavaValue | undefined =
        operand === null ? undefined : evaluate(operand, lookup, depth + 1);
      if (value?.kind === 'number' && node.text.startsWith('-')) {
        return { kind: 'number', value: -value.value, text: node.text };
      }
      return { kind: 'other', text: node.text };
    }
    case 'binary_expression': {
      const left: SyntaxNode | null = node.childForFieldName('left');
      const right: SyntaxNode | null = node.childForFieldName('right');
      if (left === null || right === null) {
        return { kind: 'other', text: node.text };
      }
      const first: JavaValue = evaluate(left, lookup, depth + 1);
      const second: JavaValue = evaluate(right, lookup, depth + 1);
      const operator: string = node.text.slice(
        left.endIndex - node.startIndex,
        right.startIndex - node.startIndex
      );
      if (operator.trim() === '+') {
        if (first.kind === 'number' && second.kind === 'number') {
          return {
            kind: 'number',
            value: first.value + second.value,
            text: node.text,
          };
        }
        const a: string | undefined = scalarText(first);
        const b: string | undefined = scalarText(second);
        if (a !== undefined && b !== undefined) {
          return { kind: 'string', value: a + b };
        }
      }
      return { kind: 'other', text: node.text };
    }
    case 'element_value_array_initializer':
    case 'array_initializer':
      return {
        kind: 'array',
        items: node.namedChildren
          .filter((child: SyntaxNode) => !child.type.includes('comment'))
          .map((child: SyntaxNode) => evaluate(child, lookup, depth + 1)),
      };
    case 'annotation':
    case 'marker_annotation': {
      const annotation: JavaAnnotation = readAnnotation(node);
      return { kind: 'annotation', annotation };
    }
    case 'class_literal': {
      const target: SyntaxNode | null = node.namedChild(0);
      return {
        kind: 'class',
        type: target === null ? node.text : parseTypeText(target.text).name,
      };
    }
    case 'identifier':
    case 'field_access': {
      const path: string[] | undefined = memberPath(node);
      if (path === undefined) {
        return { kind: 'other', text: node.text };
      }
      const constant: SyntaxNode | undefined = lookup(path);
      if (constant !== undefined) {
        return evaluate(constant, lookup, depth + 1);
      }
      return { kind: 'member', path };
    }
    default:
      return { kind: 'other', text: node.text };
  }
}

function scalarText(value: JavaValue): string | undefined {
  switch (value.kind) {
    case 'string':
      return value.value;
    case 'number':
      return String(value.value);
    case 'bool':
      return String(value.value);
    default:
      return undefined;
  }
}
