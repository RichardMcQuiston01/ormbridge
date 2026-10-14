import {
  evaluate,
  parseTypeText,
  readAttributes,
  splitTopLevel,
  type ConstLookup,
  type CsClass,
  type CsClassKind,
  type CsEnum,
  type CsEnumMember,
  type CsFile,
  type CsMethod,
  type CsParameter,
  type CsProperty,
  type CsType,
  type CsValue,
  type SyntaxNode,
} from './csharpSyntax.js';

// ---------------------------------------------------------------------------
// Declarations
// ---------------------------------------------------------------------------

const CLASS_LIKE: ReadonlyMap<string, CsClassKind> = new Map([
  ['class_declaration', 'class'],
  ['record_declaration', 'record'],
  ['record_struct_declaration', 'record'],
  ['struct_declaration', 'struct'],
  ['interface_declaration', 'interface'],
]);

function modifiersOf(node: SyntaxNode): string[] {
  return node.namedChildren
    .filter((child: SyntaxNode) => child.type === 'modifier')
    .map((child: SyntaxNode) => child.text);
}

function readBases(node: SyntaxNode): CsType[] {
  const list: SyntaxNode | undefined = node.namedChildren.find(
    (child: SyntaxNode) => child.type === 'base_list'
  );
  if (list === undefined) {
    return [];
  }
  // The text is split instead of walking the children: a record with primary constructor and generic base
  // produces error nodes in the grammar.
  const text: string = list.text.replace(/^\s*:/, '');
  return splitTopLevel(text)
    .filter((part: string) => part !== '')
    .map((part: string) => parseTypeText(part.replace(/\(.*$/s, '')));
}

function readTypeParameters(node: SyntaxNode): string[] {
  const list: SyntaxNode | undefined = node.namedChildren.find(
    (child: SyntaxNode) => child.type === 'type_parameter_list'
  );
  return (
    list?.namedChildren.map(
      (child: SyntaxNode) => child.namedChild(0)?.text ?? child.text
    ) ?? []
  );
}

function readAccessors(node: SyntaxNode): {
  hasGetter: boolean;
  hasSetter: boolean;
  isAuto: boolean;
} {
  const list: SyntaxNode | null = node.childForFieldName('accessors');
  let hasGetter: boolean = false;
  let hasSetter: boolean = false;
  let isAuto: boolean = true;
  for (const accessor of list?.namedChildren ?? []) {
    if (accessor.type !== 'accessor_declaration') {
      continue;
    }
    const keyword: string =
      accessor.children.find((child: SyntaxNode) =>
        ['get', 'set', 'init'].includes(child.type)
      )?.type ?? '';
    if (keyword === 'get') {
      hasGetter = true;
    } else if (keyword === 'set' || keyword === 'init') {
      hasSetter = true;
    }
    if (accessor.childForFieldName('body') !== null) {
      isAuto = false;
    }
  }
  return { hasGetter, hasSetter, isAuto };
}

function readProperty(node: SyntaxNode): CsProperty | undefined {
  const nameNode: SyntaxNode | null = node.childForFieldName('name');
  const typeNode: SyntaxNode | null = node.childForFieldName('type');
  if (nameNode === null || typeNode === null) {
    return undefined;
  }
  const value: SyntaxNode | null = node.childForFieldName('value');
  const isArrow: boolean = value?.type === 'arrow_expression_clause';
  const accessors = readAccessors(node);
  const initializer: SyntaxNode | null =
    value === null || isArrow
      ? null
      : value.type === 'equals_value_clause'
        ? value.namedChild(0)
        : value;
  return {
    name: nameNode.text,
    type: parseTypeText(typeNode.text),
    modifiers: modifiersOf(node),
    attributes: readAttributes(node),
    hasGetter: accessors.hasGetter || isArrow,
    hasSetter: accessors.hasSetter,
    isComputed: isArrow || (accessors.hasGetter && !accessors.hasSetter),
    isField: false,
    ...(initializer === null ? {} : { initializer }),
    node,
  };
}

function readFieldProperties(
  node: SyntaxNode,
  cls: CsClass,
  consts: ConstLookup
): void {
  const declaration: SyntaxNode | undefined = node.namedChildren.find(
    (child: SyntaxNode) => child.type === 'variable_declaration'
  );
  const typeNode: SyntaxNode | null =
    declaration?.childForFieldName('type') ?? null;
  if (declaration === undefined || typeNode === null) {
    return;
  }
  const modifiers: string[] = modifiersOf(node);
  for (const declarator of declaration.namedChildren) {
    if (declarator.type !== 'variable_declarator') {
      continue;
    }
    const nameNode: SyntaxNode | null =
      declarator.childForFieldName('name') ?? declarator.namedChild(0);
    const clause: SyntaxNode | undefined = declarator.namedChildren.find(
      (child: SyntaxNode) => child.type === 'equals_value_clause'
    );
    const initializer: SyntaxNode | null = clause?.namedChild(0) ?? null;
    if (nameNode === null) {
      continue;
    }
    if (modifiers.includes('const') && initializer !== null) {
      cls.consts.set(nameNode.text, evaluate(initializer, consts));
      continue;
    }
    if (
      modifiers.includes('static') &&
      modifiers.includes('readonly') &&
      initializer !== null
    ) {
      const value: CsValue = evaluate(initializer, consts);
      if (value.kind === 'string' || value.kind === 'number') {
        cls.consts.set(nameNode.text, value);
      }
    }
    cls.properties.push({
      name: nameNode.text,
      type: parseTypeText(typeNode.text),
      modifiers,
      attributes: readAttributes(node),
      hasGetter: true,
      hasSetter: !modifiers.includes('readonly'),
      isComputed: false,
      isField: true,
      ...(initializer === null ? {} : { initializer }),
      node,
    });
  }
}

function readMethod(node: SyntaxNode): CsMethod | undefined {
  const nameNode: SyntaxNode | null = node.childForFieldName('name');
  if (nameNode === null) {
    return undefined;
  }
  const parameters: CsParameter[] = [];
  const list: SyntaxNode | null = node.childForFieldName('parameters');
  for (const parameter of list?.namedChildren ?? []) {
    const parameterName: SyntaxNode | null =
      parameter.childForFieldName('name');
    const parameterType: SyntaxNode | null =
      parameter.childForFieldName('type');
    if (parameterName !== null && parameterType !== null) {
      parameters.push({
        name: parameterName.text,
        type: parseTypeText(parameterType.text),
      });
    }
  }
  const body: SyntaxNode | null = node.childForFieldName('body');
  return {
    name: nameNode.text,
    parameters,
    ...(body === null ? {} : { body }),
    node,
  };
}

function readClassLike(
  node: SyntaxNode,
  kind: CsClassKind,
  path: string,
  outer: string | undefined,
  file: CsFile,
  consts: ConstLookup,
  depth: number
): void {
  const nameNode: SyntaxNode | null = node.childForFieldName('name');
  if (nameNode === null) {
    return;
  }
  const cls: CsClass = {
    name: nameNode.text,
    kind,
    modifiers: modifiersOf(node),
    typeParameters: readTypeParameters(node),
    bases: readBases(node),
    attributes: readAttributes(node),
    properties: [],
    methods: [],
    consts: new Map(),
    ...(outer === undefined ? {} : { outer }),
    path,
  };
  file.classes.push(cls);
  // Positional records: `record Person(int Id, string Name)` declares the properties Id and Name.
  const parameters: SyntaxNode | null = node.childForFieldName('parameters');
  if (kind === 'record') {
    for (const parameter of parameters?.namedChildren ?? []) {
      const parameterName: SyntaxNode | null =
        parameter.childForFieldName('name');
      const parameterType: SyntaxNode | null =
        parameter.childForFieldName('type');
      if (parameterName !== null && parameterType !== null) {
        cls.properties.push({
          name: parameterName.text,
          type: parseTypeText(parameterType.text),
          modifiers: ['public'],
          attributes: readAttributes(parameter),
          hasGetter: true,
          hasSetter: true,
          isComputed: false,
          isField: false,
          node: parameter,
        });
      }
    }
  }
  const body: SyntaxNode | null = node.childForFieldName('body');
  for (const member of body?.namedChildren ?? []) {
    if (member.type === 'property_declaration') {
      const property: CsProperty | undefined = readProperty(member);
      if (property !== undefined) {
        cls.properties.push(property);
      }
    } else if (member.type === 'field_declaration') {
      readFieldProperties(
        member,
        cls,
        (names: string[]): CsValue | undefined =>
          cls.consts.get(names.join('.')) ?? consts(names)
      );
    } else if (member.type === 'method_declaration') {
      const method: CsMethod | undefined = readMethod(member);
      if (method !== undefined) {
        cls.methods.push(method);
      }
    } else if (depth < 8) {
      readDeclaration(member, path, cls.name, file, consts, depth + 1);
    }
  }
}

function readEnum(node: SyntaxNode, path: string): CsEnum | undefined {
  const nameNode: SyntaxNode | null = node.childForFieldName('name');
  if (nameNode === null) {
    return undefined;
  }
  const members: CsEnumMember[] = [];
  let next: number | undefined = 0;
  const values: Map<string, number> = new Map();
  const lookup: ConstLookup = (names: string[]): CsValue | undefined => {
    const known: number | undefined = values.get(names[names.length - 1] ?? '');
    return known === undefined
      ? undefined
      : { kind: 'number', value: known, text: String(known) };
  };
  const body: SyntaxNode | null = node.childForFieldName('body');
  for (const member of body?.namedChildren ?? []) {
    if (member.type !== 'enum_member_declaration') {
      continue;
    }
    const memberName: SyntaxNode | null = member.childForFieldName('name');
    if (memberName === null) {
      continue;
    }
    const valueNode: SyntaxNode | null = member.childForFieldName('value');
    let value: number | undefined = next;
    if (valueNode !== null) {
      const evaluated: CsValue = evaluate(valueNode, lookup);
      value = evaluated.kind === 'number' ? evaluated.value : undefined;
    }
    members.push({ name: memberName.text, value });
    if (value !== undefined) {
      values.set(memberName.text, value);
    }
    next = value === undefined ? undefined : value + 1;
  }
  return { name: nameNode.text, members, path };
}

function readDeclaration(
  node: SyntaxNode,
  path: string,
  outer: string | undefined,
  file: CsFile,
  consts: ConstLookup,
  depth: number
): void {
  const kind: CsClassKind | undefined = CLASS_LIKE.get(node.type);
  if (kind !== undefined) {
    readClassLike(node, kind, path, outer, file, consts, depth);
    return;
  }
  if (node.type === 'enum_declaration') {
    const declared: CsEnum | undefined = readEnum(node, path);
    if (declared !== undefined) {
      file.enums.push(declared);
    }
    return;
  }
  if (
    (node.type === 'namespace_declaration' ||
      node.type === 'file_scoped_namespace_declaration') &&
    depth < 16
  ) {
    const container: SyntaxNode = node.childForFieldName('body') ?? node;
    for (const child of container.namedChildren) {
      readDeclaration(child, path, outer, file, consts, depth + 1);
    }
  }
}

/** Reads the types of one parsed file. Constants are looked up through `consts` (from other files). */
export function readCSharpFile(
  root: SyntaxNode,
  path: string,
  consts: ConstLookup
): CsFile {
  const file: CsFile = {
    path,
    classes: [],
    enums: [],
    hasErrors: root.hasError,
    nullableDirective: undefined,
  };
  for (const directive of root.descendantsOfType('nullable_directive')) {
    if (/\bdisable\b/.test(directive.text)) {
      file.nullableDirective = file.nullableDirective ?? 'disable';
    } else if (/\benable\b/.test(directive.text)) {
      file.nullableDirective = file.nullableDirective ?? 'enable';
    }
  }
  for (const child of root.namedChildren) {
    readDeclaration(child, path, undefined, file, consts, 0);
  }
  return file;
}
