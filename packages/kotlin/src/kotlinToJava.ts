import type Parser from 'web-tree-sitter';

/**
 * Turns a Kotlin file into the Java text of the same entities, so the JPA reader of ormbridge reads them with the
 * rules it already has. Only what the mapping needs is written: package, imports, class headers with their
 * annotations, fields (properties with their annotations, type and initializer) and enum constants. Function bodies,
 * companion objects, objects and interfaces are left out.
 */

type SyntaxNode = Parser.SyntaxNode;

/** Kotlin types that are Java primitives when not nullable, and their boxed names. */
const PRIMITIVES: ReadonlyMap<string, [string, string]> = new Map<
  string,
  [string, string]
>([
  ['Int', ['int', 'Integer']],
  ['Long', ['long', 'Long']],
  ['Short', ['short', 'Short']],
  ['Byte', ['byte', 'Byte']],
  ['Boolean', ['boolean', 'Boolean']],
  ['Double', ['double', 'Double']],
  ['Float', ['float', 'Float']],
  ['Char', ['char', 'Character']],
]);

const ARRAYS: ReadonlyMap<string, string> = new Map<string, string>([
  ['ByteArray', 'byte[]'],
  ['IntArray', 'int[]'],
  ['LongArray', 'long[]'],
  ['ShortArray', 'short[]'],
  ['BooleanArray', 'boolean[]'],
  ['DoubleArray', 'double[]'],
  ['FloatArray', 'float[]'],
  ['CharArray', 'char[]'],
]);

const RENAMED: ReadonlyMap<string, string> = new Map<string, string>([
  ['Any', 'Object'],
  ['MutableList', 'List'],
  ['ArrayList', 'ArrayList'],
  ['MutableSet', 'Set'],
  ['MutableMap', 'Map'],
  ['MutableCollection', 'Collection'],
  ['Iterable', 'Collection'],
  ['MutableIterable', 'Collection'],
]);

/** The Java collection an initializer such as `mutableListOf()` stands for. */
const COLLECTION_BUILDERS: ReadonlyMap<string, string> = new Map<
  string,
  string
>([
  ['mutableListOf', 'new ArrayList<>()'],
  ['arrayListOf', 'new ArrayList<>()'],
  ['emptyList', 'new ArrayList<>()'],
  ['listOf', 'new ArrayList<>()'],
  ['mutableSetOf', 'new HashSet<>()'],
  ['hashSetOf', 'new HashSet<>()'],
  ['linkedSetOf', 'new LinkedHashSet<>()'],
  ['emptySet', 'new HashSet<>()'],
  ['setOf', 'new HashSet<>()'],
  ['mutableMapOf', 'new HashMap<>()'],
  ['hashMapOf', 'new HashMap<>()'],
  ['emptyMap', 'new HashMap<>()'],
  ['mapOf', 'new HashMap<>()'],
]);

function childOfType(node: SyntaxNode, type: string): SyntaxNode | undefined {
  return node.children.find((child: SyntaxNode) => child.type === type);
}

function childrenOfType(node: SyntaxNode, type: string): SyntaxNode[] {
  return node.children.filter((child: SyntaxNode) => child.type === type);
}

/** The text of a string literal as a Java string; undefined when it interpolates. */
function stringLiteral(node: SyntaxNode): string | undefined {
  const text: string = node.text;
  if (text.startsWith('"""')) {
    const body: string = text.slice(3, -3);
    if (body.includes('$')) {
      return undefined;
    }
    return `"${body.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, '\\n')}"`;
  }
  const interpolated: boolean = node.children.some((child: SyntaxNode) =>
    child.type.startsWith('interpolat')
  );
  return interpolated ? undefined : text;
}

/** A Kotlin expression as Java, or undefined when it has no Java form the reader could use. */
function expression(
  node: SyntaxNode,
  inAnnotation: boolean = false
): string | undefined {
  switch (node.type) {
    case 'string_literal':
      return stringLiteral(node);
    case 'integer_literal':
    case 'long_literal':
    case 'real_literal':
    case 'hex_literal':
    case 'bin_literal':
    case 'boolean_literal':
    case 'simple_identifier':
      return node.text;
    case 'character_literal':
      return node.text;
    case 'null_literal':
      return 'null';
    case 'parenthesized_expression':
    case 'prefix_expression':
      return node.text;
    case 'navigation_expression': {
      // `GenerationType.IDENTITY`, and `Foo::class.java` (the same class as `Foo::class` here).
      const reference: RegExpMatchArray | null = node.text.match(
        /^([\w.]+)::class(?:\.java)?$/
      );
      if (reference !== null) {
        return `${reference[1] ?? ''}.class`;
      }
      return /^[\w.]+$/.test(node.text) ? node.text : undefined;
    }
    case 'callable_reference':
      return callableReference(node);
    case 'collection_literal':
      return `{${listOf(node.namedChildren, inAnnotation)}}`;
    case 'additive_expression': {
      const parts: (string | undefined)[] = node.namedChildren.map(
        (child: SyntaxNode) => expression(child, inAnnotation)
      );
      return parts.every((part: string | undefined) => part !== undefined)
        ? parts.join(' + ')
        : undefined;
    }
    case 'call_expression':
      return call(node, inAnnotation);
    default:
      return node.type === 'null' ? 'null' : undefined;
  }
}

/** `Foo::class` (and `Foo::class.java`) as `Foo.class`. */
function callableReference(node: SyntaxNode): string | undefined {
  const type: SyntaxNode | undefined = node.namedChildren[0];
  return type === undefined ? undefined : `${type.text}.class`;
}

function listOf(nodes: readonly SyntaxNode[], inAnnotation: boolean): string {
  return nodes
    .map((node: SyntaxNode) => expression(node, inAnnotation))
    .filter((item: string | undefined): item is string => item !== undefined)
    .join(', ');
}

/** `Index(name = "x")` inside an annotation is a nested annotation; `arrayOf(...)` an array. */
function call(node: SyntaxNode, inAnnotation: boolean): string | undefined {
  const callee: SyntaxNode | undefined = node.namedChildren[0];
  const suffix: SyntaxNode | undefined = childOfType(node, 'call_suffix');
  const args: SyntaxNode | undefined =
    suffix === undefined ? undefined : childOfType(suffix, 'value_arguments');
  if (callee === undefined) {
    return undefined;
  }
  const name: string = callee.text;
  const builder: string | undefined = COLLECTION_BUILDERS.get(name);
  if (builder !== undefined) {
    return builder;
  }
  if (args === undefined) {
    return undefined;
  }
  const values: SyntaxNode[] = childrenOfType(args, 'value_argument');
  if (name === 'arrayOf' || /^(?:int|long|string)ArrayOf$/.test(name)) {
    return `{${listOf(values.map(argumentValue).filter(isNode), inAnnotation)}}`;
  }
  if (inAnnotation && /^[A-Z]/.test(name) && /^[\w.]+$/.test(name)) {
    return `@${name}(${argumentList(values)})`;
  }
  if (values.length === 0 && /^[\w.]+$/.test(callee.text)) {
    return `${name}()`;
  }
  return undefined;
}

function isNode(value: SyntaxNode | undefined): value is SyntaxNode {
  return value !== undefined;
}

/** The expression of a `name = value` or positional argument. */
function argumentValue(argument: SyntaxNode): SyntaxNode | undefined {
  return argument.namedChildren.find(
    (child: SyntaxNode) =>
      child.type !== 'simple_identifier' || argument.namedChildren.length === 1
  );
}

function argumentName(argument: SyntaxNode): string | undefined {
  const first: SyntaxNode | undefined = argument.namedChildren[0];
  return first?.type === 'simple_identifier' &&
    argument.namedChildren.length > 1
    ? first.text
    : undefined;
}

function argumentList(values: readonly SyntaxNode[]): string {
  const parts: string[] = [];
  for (const argument of values) {
    const value: SyntaxNode | undefined = argumentValue(argument);
    const text: string | undefined =
      value === undefined ? undefined : expression(value, true);
    if (text === undefined) {
      continue;
    }
    const name: string | undefined = argumentName(argument);
    parts.push(name === undefined ? text : `${name} = ${text}`);
  }
  return parts.join(', ');
}

/** One annotation as Java; the use-site target (`field:`, `get:`) is dropped. */
function annotation(node: SyntaxNode): string | undefined {
  const invocation: SyntaxNode | undefined = childOfType(
    node,
    'constructor_invocation'
  );
  if (invocation !== undefined) {
    const type: SyntaxNode | undefined = childOfType(invocation, 'user_type');
    const args: SyntaxNode | undefined = childOfType(
      invocation,
      'value_arguments'
    );
    if (type === undefined) {
      return undefined;
    }
    const list: string =
      args === undefined
        ? ''
        : argumentList(childrenOfType(args, 'value_argument'));
    return `@${type.text}(${list})`;
  }
  const type: SyntaxNode | undefined = childOfType(node, 'user_type');
  return type === undefined ? undefined : `@${type.text}`;
}

function annotationsOf(modifiers: SyntaxNode | undefined): string[] {
  if (modifiers === undefined) {
    return [];
  }
  return childrenOfType(modifiers, 'annotation')
    .map(annotation)
    .filter((text: string | undefined): text is string => text !== undefined);
}

/**
 * The annotations of a `prefix_expression`. After a `}` the grammar can read the annotations of the next declaration
 * as an annotated expression of their own (when an argument has brackets: `@Table(indexes = [...])`), and the
 * declaration then follows without them; they belong to it.
 */
function strayAnnotations(node: SyntaxNode): string[] {
  const found: string[] = [];
  for (const child of node.namedChildren) {
    if (child.type === 'annotation') {
      const text: string | undefined = annotation(child);
      if (text !== undefined) {
        found.push(text);
      }
    } else if (child.type === 'prefix_expression') {
      found.push(...strayAnnotations(child));
    }
  }
  return found;
}

function modifierTexts(modifiers: SyntaxNode | undefined): string[] {
  return modifiers === undefined
    ? []
    : modifiers.children
        .filter((child: SyntaxNode) => child.type !== 'annotation')
        .map((child: SyntaxNode) => child.text);
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A Kotlin type as Java. Nullable types are boxed; `Int` is `int` and `Int?` is `Integer`. */
function typeOf(node: SyntaxNode, forceBoxed: boolean = false): string {
  if (node.type === 'nullable_type') {
    const inner: SyntaxNode | undefined = node.namedChildren[0];
    return inner === undefined ? 'Object' : typeOf(inner, true);
  }
  if (node.type === 'user_type') {
    return userType(node, forceBoxed);
  }
  if (node.type === 'parenthesized_type') {
    const inner: SyntaxNode | undefined = node.namedChildren[0];
    return inner === undefined ? 'Object' : typeOf(inner, forceBoxed);
  }
  return 'Object';
}

function userType(node: SyntaxNode, forceBoxed: boolean): string {
  const parts: SyntaxNode[] = node.namedChildren;
  const identifiers: string[] = parts
    .filter((part: SyntaxNode) => part.type === 'type_identifier')
    .map((part: SyntaxNode) => part.text);
  const argumentsNode: SyntaxNode | undefined = childOfType(
    node,
    'type_arguments'
  );
  // A qualified name (`java.math.BigDecimal`, `Outer.Inner`) has one type_identifier per part.
  const qualifier: SyntaxNode | undefined =
    identifiers.length > 1 ? node : undefined;
  const name: string = identifiers.join('.');
  if (qualifier === undefined) {
    const primitive: [string, string] | undefined = PRIMITIVES.get(name);
    if (primitive !== undefined) {
      return forceBoxed ? primitive[1] : primitive[0];
    }
    const array: string | undefined = ARRAYS.get(name);
    if (array !== undefined) {
      return array;
    }
    if (name === 'Array' && argumentsNode !== undefined) {
      const element: SyntaxNode | undefined = childOfType(
        argumentsNode,
        'type_projection'
      )?.namedChildren[0];
      return `${element === undefined ? 'Object' : typeOf(element, true)}[]`;
    }
  }
  const javaName: string =
    qualifier === undefined ? (RENAMED.get(name) ?? name) : name;
  if (argumentsNode === undefined) {
    return javaName === 'List' ||
      javaName === 'Set' ||
      javaName === 'Map' ||
      javaName === 'Collection'
      ? javaName
      : javaName;
  }
  const args: string[] = childrenOfType(argumentsNode, 'type_projection').map(
    (projection: SyntaxNode): string => {
      const inner: SyntaxNode | undefined = projection.namedChildren.find(
        (child: SyntaxNode) => child.type !== 'type_modifiers'
      );
      return inner === undefined ? '?' : typeOf(inner, true);
    }
  );
  return `${javaName}<${args.join(', ')}>`;
}

// ---------------------------------------------------------------------------
// Classes
// ---------------------------------------------------------------------------

interface Member {
  annotations: string[];
  type: string;
  name: string;
  initializer?: string;
}

function initializerOf(node: SyntaxNode | undefined): string | undefined {
  return node === undefined ? undefined : expression(node);
}

/** The expression after `=` of a property or parameter. */
function valueAfterEquals(node: SyntaxNode): SyntaxNode | undefined {
  const at: number = node.children.findIndex(
    (child: SyntaxNode) => child.type === '='
  );
  return at < 0 ? undefined : node.children[at + 1];
}

function parameterMember(parameter: SyntaxNode): Member | undefined {
  if (childOfType(parameter, 'binding_pattern_kind') === undefined) {
    return undefined;
  }
  const name: SyntaxNode | undefined = childOfType(
    parameter,
    'simple_identifier'
  );
  const type: SyntaxNode | undefined = parameter.namedChildren.find(
    (child: SyntaxNode) =>
      child.type === 'user_type' || child.type === 'nullable_type'
  );
  if (name === undefined || type === undefined) {
    return undefined;
  }
  const initializer: string | undefined = initializerOf(
    valueAfterEquals(parameter)
  );
  return {
    annotations: annotationsOf(childOfType(parameter, 'modifiers')),
    type: typeOf(type),
    name: name.text,
    ...(initializer === undefined ? {} : { initializer }),
  };
}

function propertyMember(
  property: SyntaxNode,
  stray: readonly string[] = []
): Member | undefined {
  const modifiers: SyntaxNode | undefined = childOfType(property, 'modifiers');
  if (modifierTexts(modifiers).includes('const')) {
    return undefined;
  }
  const declaration: SyntaxNode | undefined = childOfType(
    property,
    'variable_declaration'
  );
  const name: SyntaxNode | undefined =
    declaration === undefined
      ? undefined
      : childOfType(declaration, 'simple_identifier');
  if (declaration === undefined || name === undefined) {
    return undefined;
  }
  const typeNode: SyntaxNode | undefined = declaration.namedChildren.find(
    (child: SyntaxNode) =>
      child.type === 'user_type' || child.type === 'nullable_type'
  );
  const value: SyntaxNode | undefined = valueAfterEquals(property);
  const initializer: string | undefined = initializerOf(value);
  // Without a written type the property takes the type of its initializer; only literals say it.
  const type: string | undefined =
    typeNode !== undefined
      ? typeOf(typeNode)
      : value === undefined
        ? undefined
        : typeOfLiteral(value);
  if (type === undefined) {
    return undefined;
  }
  return {
    annotations: [...stray, ...annotationsOf(modifiers)],
    type,
    name: name.text,
    ...(initializer === undefined ? {} : { initializer }),
  };
}

function typeOfLiteral(node: SyntaxNode): string | undefined {
  switch (node.type) {
    case 'string_literal':
      return 'String';
    case 'long_literal':
      return 'long';
    case 'integer_literal':
      return 'int';
    case 'boolean_literal':
      return 'boolean';
    case 'real_literal':
      return /[fF]$/.test(node.text) ? 'float' : 'double';
    default:
      return undefined;
  }
}

function renderMember(member: Member, indent: string): string[] {
  const lines: string[] = member.annotations.map(
    (text: string) => `${indent}${text}`
  );
  lines.push(
    `${indent}${member.type} ${member.name}${member.initializer === undefined ? '' : ` = ${member.initializer}`};`
  );
  return lines;
}

function classKind(node: SyntaxNode): 'class' | 'interface' | 'enum' | 'skip' {
  if (node.children.some((child: SyntaxNode) => child.type === 'interface')) {
    return 'interface';
  }
  const modifiers: string[] = modifierTexts(childOfType(node, 'modifiers'));
  if (
    modifiers.includes('enum') ||
    node.children.some(
      (child: SyntaxNode) =>
        child.type === 'enum' || child.type === 'enum_class_body'
    )
  ) {
    return 'enum';
  }
  if (modifiers.includes('annotation')) {
    return 'skip';
  }
  return 'class';
}

function supertypes(node: SyntaxNode): {
  extend?: string;
  implement: string[];
} {
  const implement: string[] = [];
  let extend: string | undefined;
  for (const specifier of childrenOfType(node, 'delegation_specifier')) {
    const invocation: SyntaxNode | undefined = childOfType(
      specifier,
      'constructor_invocation'
    );
    const type: SyntaxNode | undefined =
      invocation === undefined
        ? childOfType(specifier, 'user_type')
        : childOfType(invocation, 'user_type');
    if (type === undefined) {
      continue;
    }
    const text: string = typeOf(type, true);
    if (invocation !== undefined) {
      extend = text;
    } else {
      implement.push(text);
    }
  }
  return { ...(extend === undefined ? {} : { extend }), implement };
}

function renderClass(
  node: SyntaxNode,
  indent: string,
  stray: readonly string[] = []
): string[] {
  const kind: ReturnType<typeof classKind> = classKind(node);
  const nameNode: SyntaxNode | undefined = childOfType(node, 'type_identifier');
  if (kind === 'skip' || kind === 'interface' || nameNode === undefined) {
    return [];
  }
  const modifiers: SyntaxNode | undefined = childOfType(node, 'modifiers');
  const lines: string[] = [...stray, ...annotationsOf(modifiers)].map(
    (text: string) => `${indent}${text}`
  );
  const inner: string = `${indent}  `;
  if (kind === 'enum') {
    return [...lines, ...renderEnum(node, nameNode.text, indent, inner)];
  }
  const isAbstract: boolean = modifierTexts(modifiers).includes('abstract');
  const parents = supertypes(node);
  lines.push(
    `${indent}${isAbstract ? 'abstract ' : ''}class ${nameNode.text}` +
      `${parents.extend === undefined ? '' : ` extends ${parents.extend}`}` +
      `${parents.implement.length === 0 ? '' : ` implements ${parents.implement.join(', ')}`} {`
  );
  const members: Member[] = [];
  const constructor: SyntaxNode | undefined = childOfType(
    node,
    'primary_constructor'
  );
  if (constructor !== undefined) {
    for (const parameter of childrenOfType(constructor, 'class_parameter')) {
      const member: Member | undefined = parameterMember(parameter);
      if (member !== undefined) {
        members.push(member);
      }
    }
  }
  const body: SyntaxNode | undefined = childOfType(node, 'class_body');
  const nested: string[] = [];
  if (body !== undefined) {
    let stray: string[] = [];
    for (const child of body.namedChildren) {
      if (child.type === 'prefix_expression') {
        stray.push(...strayAnnotations(child));
        continue;
      }
      if (child.type === 'property_declaration') {
        const member: Member | undefined = propertyMember(child, stray);
        if (member !== undefined) {
          members.push(member);
        }
      } else if (child.type === 'class_declaration') {
        nested.push(...renderClass(child, inner, stray).map(staticNested));
      }
      stray = [];
    }
  }
  for (const member of members) {
    lines.push(...renderMember(member, inner));
  }
  lines.push(...nested, `${indent}}`);
  return lines;
}

/** A nested Kotlin class does not hold a reference to the outer one, so it is a static Java class. */
function staticNested(line: string, position: number, all: string[]): string {
  // Only the declaration line (the first line that is not an annotation) gets `static`.
  const firstDeclaration: number = all.findIndex(
    (item: string) => !item.trimStart().startsWith('@')
  );
  return position === firstDeclaration
    ? line.replace(/^(\s*)/, '$1static ')
    : line;
}

function renderEnum(
  node: SyntaxNode,
  name: string,
  indent: string,
  inner: string
): string[] {
  const body: SyntaxNode | undefined = childOfType(node, 'enum_class_body');
  const constants: string[] = [];
  if (body !== undefined) {
    for (const entry of childrenOfType(body, 'enum_entry')) {
      const constant: SyntaxNode | undefined = childOfType(
        entry,
        'simple_identifier'
      );
      if (constant === undefined) {
        continue;
      }
      const args: SyntaxNode | undefined = childOfType(
        entry,
        'value_arguments'
      );
      const list: string =
        args === undefined
          ? ''
          : `(${childrenOfType(args, 'value_argument')
              .map(argumentValue)
              .filter(isNode)
              .map((item: SyntaxNode) => expression(item, true))
              .filter(
                (item: string | undefined): item is string => item !== undefined
              )
              .join(', ')})`;
      constants.push(`${constant.text}${list}`);
    }
  }
  const lines: string[] = [`${indent}enum ${name} {`];
  lines.push(`${inner}${constants.join(', ')};`);
  const constructor: SyntaxNode | undefined = childOfType(
    node,
    'primary_constructor'
  );
  if (constructor !== undefined) {
    for (const parameter of childrenOfType(constructor, 'class_parameter')) {
      const member: Member | undefined = parameterMember(parameter);
      if (member !== undefined) {
        lines.push(...renderMember({ ...member, annotations: [] }, inner));
      }
    }
  }
  lines.push(`${indent}}`);
  return lines;
}

/** `import a.b.C` and `import a.b.*`; an alias (`as D`) is dropped. */
function renderImport(node: SyntaxNode): string | undefined {
  const name: SyntaxNode | undefined = childOfType(node, 'identifier');
  if (name === undefined) {
    return undefined;
  }
  const wildcard: boolean = node.children.some(
    (child: SyntaxNode) => child.type === 'wildcard_import'
  );
  return `import ${name.text}${wildcard ? '.*' : ''};`;
}

/**
 * The Java text of one Kotlin file, given the syntax trees of its parts (the header and each top-level declaration,
 * see `splitTopLevel`). A single tree of a whole file works as well.
 */
export function kotlinToJava(roots: readonly SyntaxNode[]): string {
  const children: SyntaxNode[] = roots.flatMap(
    (root: SyntaxNode): SyntaxNode[] => root.namedChildren
  );
  const lines: string[] = [];
  const header: SyntaxNode | undefined = children.find(
    (child: SyntaxNode) => child.type === 'package_header'
  );
  const packageName: SyntaxNode | undefined =
    header === undefined ? undefined : childOfType(header, 'identifier');
  if (packageName !== undefined) {
    lines.push(`package ${packageName.text};`, '');
  }
  for (const imports of children.filter(
    (child: SyntaxNode) => child.type === 'import_list'
  )) {
    for (const entry of childrenOfType(imports, 'import_header')) {
      const line: string | undefined = renderImport(entry);
      if (line !== undefined) {
        lines.push(line);
      }
    }
    lines.push('');
  }
  let stray: string[] = [];
  for (const child of children) {
    if (child.type === 'prefix_expression') {
      stray.push(...strayAnnotations(child));
      continue;
    }
    if (child.type === 'class_declaration') {
      lines.push(...renderClass(child, '', stray), '');
    }
    stray = [];
  }
  return `${lines.join('\n')}\n`;
}
