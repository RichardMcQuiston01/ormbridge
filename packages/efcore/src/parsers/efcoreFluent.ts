import {
  type ConstLookup,
  type CsClass,
  type CsMethod,
  type SyntaxNode,
} from './csharpSyntax.js';
import {
  bodyStatements,
  flattenChain,
  type CsCall,
  type CsChain,
  type CsLambda,
} from './csharpChains.js';
import { annotateEntity, newEntityConfig } from './efcoreAnnotations.js';
import type { EntityConfig, Project } from './efcoreModel.js';
import { FluentSteps, NONE, type Target } from './efcoreSteps.js';

const MAX_CALL_DEPTH: number = 8;

/** The entity configurations of a project, built from data annotations and then the fluent API. */
export class ConfigStore extends FluentSteps {
  readonly entities: Map<string, EntityConfig> = new Map();
  /** Entity names in the order they were discovered. */
  readonly entityOrder: string[] = [];
  /** Set by a loop that assigns `DeleteBehavior` to every foreign key. */
  globalDeleteBehavior: string | undefined;
  private readonly applied: Set<CsClass> = new Set();
  private readonly unknown: Set<string> = new Set();
  private callDepth: number = 0;
  private navigationNameCache: ReadonlySet<string> | undefined;

  constructor(
    readonly project: Project,
    readonly consts: ConstLookup,
    readonly chainOf: (cls: CsClass) => CsClass[]
  ) {
    super();
  }

  warn(message: string): void {
    this.project.warnings.push(message);
  }

  /** Reports a fluent call that is not interpreted, once per call name and place. */
  unknownCall(name: string, place: string, detail: string = ''): void {
    const key: string = `${place}|${name}`;
    if (this.unknown.has(key)) {
      return;
    }
    this.unknown.add(key);
    this.warn(
      `${place}: the call ${name}(...) is not interpreted and was ignored${detail === '' ? '' : ` (${detail})`}.`
    );
  }

  /** The configuration of an entity, created from its data annotations on first use. */
  entity(name: string): EntityConfig | undefined {
    const existing: EntityConfig | undefined = this.entities.get(name);
    if (existing !== undefined) {
      return existing;
    }
    const cls: CsClass | undefined = this.project.classes.get(name);
    if (cls === undefined || cls.kind === 'interface') {
      return undefined;
    }
    const config: EntityConfig = newEntityConfig(name);
    annotateEntity(this.chainOf(cls), config, this.consts, (message: string) =>
      this.warn(message)
    );
    this.entities.set(name, config);
    this.entityOrder.push(name);
    return config;
  }

  /** Adds an entity that was found by a convention (a DbSet, an annotation or a navigation). */
  addEntity(name: string): EntityConfig | undefined {
    return this.entity(name);
  }

  has(name: string): boolean {
    return this.entities.has(name);
  }

  // -------------------------------------------------------------------------
  // Running configuration code
  // -------------------------------------------------------------------------

  /** Reads `OnModelCreating` of a context. */
  runContext(context: CsClass): void {
    for (const method of context.methods) {
      const place: string = `${context.name}.${method.name}`;
      if (method.name === 'ConfigureConventions') {
        this.warn(
          `${place}: convention configuration (ConfigureConventions) is not interpreted; settings made there, such as a default string length or enum conversion, are not applied.`
        );
      }
      if (
        method.name !== 'OnModelCreating' ||
        method.body === undefined ||
        method.parameters.length === 0
      ) {
        continue;
      }
      const parameter: string | undefined = method.parameters[0]?.name;
      if (parameter === undefined) {
        continue;
      }
      const bindings: Map<string, Target> = new Map([
        [parameter, { kind: 'model' }],
      ]);
      this.runStatements(method.body, bindings, place, context);
    }
  }

  /** Reads the `Configure` method of an IEntityTypeConfiguration<T> class. */
  runConfiguration(cls: CsClass, entityName: string): void {
    if (this.applied.has(cls)) {
      return;
    }
    this.applied.add(cls);
    const config: EntityConfig | undefined = this.entity(entityName);
    const method: CsMethod | undefined = cls.methods.find(
      (candidate: CsMethod) =>
        candidate.name === 'Configure' && candidate.parameters.length === 1
    );
    const parameter: string | undefined = method?.parameters[0]?.name;
    if (
      config === undefined ||
      method?.body === undefined ||
      parameter === undefined
    ) {
      return;
    }
    const bindings: Map<string, Target> = new Map([
      [parameter, this.entityTarget(config)],
    ]);
    this.runStatements(method.body, bindings, `${cls.name}.Configure`, cls);
  }

  /** Applies the configuration classes that no context applied explicitly (ApplyConfigurationsFromAssembly). */
  applyAllConfigurations(): void {
    for (const { cls, entity } of this.project.configurations) {
      this.runConfiguration(cls, entity);
    }
  }

  /** The configuration classes that were never applied. */
  unappliedConfigurations(): CsClass[] {
    return this.project.configurations
      .map(({ cls }: { cls: CsClass }) => cls)
      .filter((cls: CsClass) => !this.applied.has(cls));
  }

  /** The navigation names the fluent API configures (HasOne / HasMany / WithOne / WithMany arguments). */
  navigationNames(): ReadonlySet<string> {
    // Called once the fluent code has been read, so the set no longer changes.
    if (this.navigationNameCache !== undefined) {
      return this.navigationNameCache;
    }
    const names: Set<string> = new Set();
    for (const config of this.entities.values()) {
      for (const rel of config.relations) {
        for (const name of [rel.ownerNav, rel.inverseNav]) {
          if (name !== undefined) {
            names.add(name);
          }
        }
      }
    }
    this.navigationNameCache = names;
    return names;
  }

  protected entityTarget(config: EntityConfig): Target {
    return {
      kind: 'entity',
      entity: config.name,
      config,
      scope: config,
      prefix: '',
    };
  }

  // -------------------------------------------------------------------------
  // Statements
  // -------------------------------------------------------------------------

  private runStatements(
    body: SyntaxNode,
    bindings: Map<string, Target>,
    place: string,
    owner: CsClass
  ): void {
    for (const statement of bodyStatements(body)) {
      this.runStatement(statement, bindings, place, owner);
    }
  }

  private runStatement(
    statement: SyntaxNode,
    bindings: Map<string, Target>,
    place: string,
    owner: CsClass
  ): void {
    switch (statement.type) {
      case 'expression_statement': {
        const expression: SyntaxNode | null = statement.namedChild(0);
        if (expression !== null) {
          this.runExpression(expression, bindings, place, owner);
        }
        return;
      }
      case 'invocation_expression':
        this.runExpression(statement, bindings, place, owner);
        return;
      case 'local_declaration_statement': {
        const declaration: SyntaxNode | undefined =
          statement.namedChildren.find(
            (child: SyntaxNode) => child.type === 'variable_declaration'
          );
        for (const declarator of declaration?.namedChildren ?? []) {
          if (declarator.type !== 'variable_declarator') {
            continue;
          }
          const name: string | undefined = declarator.namedChild(0)?.text;
          const clause: SyntaxNode | undefined = declarator.namedChildren.find(
            (child: SyntaxNode) => child.type === 'equals_value_clause'
          );
          const initializer: SyntaxNode | null = clause?.namedChild(0) ?? null;
          if (name === undefined || initializer === null) {
            continue;
          }
          const target: Target = this.runExpression(
            initializer,
            bindings,
            place,
            owner
          );
          if (target.kind !== 'none') {
            bindings.set(name, target);
          }
        }
        return;
      }
      case 'block':
        this.runStatements(statement, bindings, place, owner);
        return;
      case 'if_statement': {
        this.warn(
          `${place}: a conditional (if) around configuration code is not evaluated; the calls in all of its branches were read.`
        );
        for (const field of ['consequence', 'alternative']) {
          const branch: SyntaxNode | null = statement.childForFieldName(field);
          if (branch !== null) {
            this.runStatement(branch, bindings, place, owner);
          }
        }
        return;
      }
      case 'using_statement':
      case 'try_statement':
      case 'lock_statement':
      case 'checked_statement':
      case 'catch_clause':
      case 'finally_clause':
        for (const child of statement.namedChildren) {
          if (
            child.type === 'block' ||
            child.type === 'catch_clause' ||
            child.type === 'finally_clause' ||
            child.type.endsWith('_statement')
          ) {
            this.runStatement(child, bindings, place, owner);
          }
        }
        return;
      case 'for_each_statement':
      case 'for_statement':
      case 'while_statement':
      case 'do_statement':
        this.readLoop(statement, place);
        return;
      case 'return_statement':
      case 'comment':
      case 'empty_statement':
        return;
      default:
        this.unknownCall(
          statement.type.replace(/_statement$/, ''),
          place,
          'statement kind'
        );
    }
  }

  private readLoop(statement: SyntaxNode, place: string): void {
    // The usual loop disables cascade delete for every foreign key.
    const assignment: RegExpMatchArray | null = statement.text.match(
      /\.DeleteBehavior\s*=\s*(?:\w+\.)*DeleteBehavior\.(\w+)/
    );
    if (assignment !== null && assignment[1] !== undefined) {
      this.globalDeleteBehavior = assignment[1];
      this.warn(
        `${place}: a loop assigns DeleteBehavior.${assignment[1]} to every foreign key; it was applied to all relationships.`
      );
      return;
    }
    this.warn(
      `${place}: a loop over the model (${statement.text
        .split('\n')[0]
        ?.trim()
        .slice(
          0,
          60
        )}...) is not interpreted; whatever it configures is not applied.`
    );
  }

  private runExpression(
    expression: SyntaxNode,
    bindings: Map<string, Target>,
    place: string,
    owner: CsClass
  ): Target {
    if (expression.type === 'assignment_expression') {
      return NONE;
    }
    const chain: CsChain | undefined = flattenChain(expression);
    if (chain === undefined) {
      return NONE;
    }
    // A call to a helper method of the same class or an extension method.
    const first: CsCall | undefined = chain.calls[0];
    if (first !== undefined && chain.root.type === 'identifier') {
      const rootTarget: Target | undefined = bindings.get(chain.root.text);
      if (rootTarget === undefined) {
        return this.callUserMethod(chain, undefined, bindings, place, owner);
      }
      let target: Target = rootTarget;
      for (const call of chain.calls) {
        const helper: CsMethod | undefined = KNOWN_CALLS.has(call.name)
          ? undefined
          : this.findExtension(call.name);
        if (helper !== undefined) {
          // Extension methods that configure a builder are followed into their body.
          this.invoke(helper, target, call, bindings, place, owner);
          continue;
        }
        target = this.step(target, call, bindings, place, owner);
      }
      return target;
    }
    if (
      chain.root.type === 'this_expression' ||
      chain.root.type === 'base_expression'
    ) {
      return this.callUserMethod(chain, undefined, bindings, place, owner);
    }
    return NONE;
  }

  private findExtension(name: string): CsMethod | undefined {
    for (const cls of this.project.classes.values()) {
      if (!cls.modifiers.includes('static')) {
        continue;
      }
      const method: CsMethod | undefined = cls.methods.find(
        (candidate: CsMethod) =>
          candidate.name === name &&
          candidate.node.text.includes('this ') &&
          candidate.body !== undefined
      );
      if (method !== undefined) {
        return method;
      }
    }
    return undefined;
  }

  private callUserMethod(
    chain: CsChain,
    receiver: Target | undefined,
    bindings: Map<string, Target>,
    place: string,
    owner: CsClass
  ): Target {
    const call: CsCall | undefined = chain.calls[0];
    if (call === undefined) {
      return NONE;
    }
    if (call.name === 'OnModelCreating' || chain.root.text === 'base') {
      return NONE;
    }
    const method: CsMethod | undefined =
      owner.methods.find(
        (candidate: CsMethod) =>
          candidate.name === call.name && candidate.body !== undefined
      ) ?? this.findExtension(call.name);
    if (method === undefined) {
      return NONE;
    }
    this.invoke(method, receiver, call, bindings, place, owner);
    return NONE;
  }

  private invoke(
    method: CsMethod,
    receiver: Target | undefined,
    call: CsCall,
    bindings: Map<string, Target>,
    place: string,
    owner: CsClass
  ): void {
    if (method.body === undefined || this.callDepth >= MAX_CALL_DEPTH) {
      return;
    }
    const inner: Map<string, Target> = new Map();
    const isExtension: boolean = method.node.text.includes('this ');
    const names: string[] = method.parameters.map((p) => p.name);
    let index: number = 0;
    if (isExtension && receiver !== undefined && names[0] !== undefined) {
      inner.set(names[0], receiver);
      index = 1;
    }
    for (const argument of call.args) {
      const name: string | undefined = names[index];
      index += 1;
      if (name === undefined) {
        break;
      }
      if (argument.type === 'identifier') {
        const bound: Target | undefined = bindings.get(argument.text);
        if (bound !== undefined) {
          inner.set(name, bound);
        }
      }
    }
    this.callDepth += 1;
    try {
      this.runStatements(
        method.body,
        inner,
        `${place} > ${method.name}`,
        owner
      );
    } finally {
      this.callDepth -= 1;
    }
  }

  // -------------------------------------------------------------------------
  // Builder steps
  // -------------------------------------------------------------------------

  protected runLambda(
    lambda: CsLambda,
    target: Target,
    bindings: Map<string, Target>,
    place: string,
    owner: CsClass
  ): void {
    const inner: Map<string, Target> = new Map(bindings);
    if (lambda.parameter !== undefined) {
      inner.set(lambda.parameter, target);
    }
    this.runStatements(lambda.body, inner, place, owner);
  }
}

/** Builder method names that are never read as user-defined extension methods. */
const KNOWN_CALLS: ReadonlySet<string> = new Set([
  'Entity',
  'Property',
  'HasKey',
  'HasNoKey',
  'HasIndex',
  'HasAlternateKey',
  'Ignore',
  'ToTable',
  'ToView',
  'HasOne',
  'HasMany',
  'OwnsOne',
  'OwnsMany',
  'ComplexProperty',
  'HasDiscriminator',
  'HasBaseType',
  'HasComment',
  'HasData',
  'HasQueryFilter',
  'Navigation',
  'ToJson',
  'WithOwner',
  'ApplyConfiguration',
  'ApplyConfigurationsFromAssembly',
  'HasDefaultSchema',
  'Owned',
]);
