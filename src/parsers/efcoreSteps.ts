import {
  evaluate,
  parseTypeText,
  type ConstLookup,
  type CsClass,
  type CsType,
  type CsValue,
  type SyntaxNode,
} from './csharpSyntax.js';
import {
  readLambda,
  selectedMembers,
  type CsCall,
  type CsLambda,
} from './csharpChains.js';
import { newOwnedConfig, propConfig } from './efcoreAnnotations.js';
import type {
  ConfigIndex,
  DiscriminatorConfig,
  EntityConfig,
  FluentRelation,
  JoinConfig,
  OwnedConfig,
  PropConfig,
  Project,
  Scope,
} from './efcoreModel.js';

/** What a builder variable stands for while the fluent calls are read. */
export type Target =
  | { kind: 'model' }
  | {
      kind: 'entity';
      entity: string;
      config: EntityConfig;
      scope: Scope;
      /** Dotted prefix of the owned navigation path, '' for the entity itself. */
      prefix: string;
      owned?: OwnedConfig;
    }
  | { kind: 'property'; cfg: PropConfig; name: string }
  | { kind: 'index'; index: ConfigIndex }
  | { kind: 'key'; config: EntityConfig }
  | { kind: 'relation'; rel: FluentRelation }
  | { kind: 'table'; config: EntityConfig }
  | { kind: 'discriminator'; config: EntityConfig }
  | { kind: 'join'; join: JoinConfig }
  | {
      kind: 'joinSide';
      join: JoinConfig;
      owner: string;
      target: string;
      side?: 'left' | 'right';
    }
  | { kind: 'none' };

export const NONE: Target = { kind: 'none' };
/**
 * The interpretation of fluent calls: what each builder method does to the configuration of an entity, a
 * property, an index or a relationship. `ConfigStore` adds the registry of entities and the code that walks
 * statements and finds the calls.
 */
export abstract class FluentSteps {
  abstract readonly project: Project;
  abstract readonly consts: ConstLookup;
  readonly ownedTypes: Set<string> = new Set();
  readonly ignoredEntities: Set<string> = new Set();
  defaultSchema: string | undefined;

  abstract warn(message: string): void;
  abstract unknownCall(name: string, place: string, detail?: string): void;
  abstract entity(name: string): EntityConfig | undefined;
  abstract runConfiguration(cls: CsClass, entityName: string): void;
  abstract applyAllConfigurations(): void;
  protected abstract entityTarget(config: EntityConfig): Target;
  protected abstract runLambda(
    lambda: CsLambda,
    target: Target,
    bindings: Map<string, Target>,
    place: string,
    owner: CsClass
  ): void;

  protected step(
    target: Target,
    call: CsCall,
    bindings: Map<string, Target>,
    place: string,
    owner: CsClass
  ): Target {
    switch (target.kind) {
      case 'model':
        return this.stepModel(call, bindings, place, owner);
      case 'entity':
        return this.stepEntity(target, call, bindings, place, owner);
      case 'property':
        return this.stepProperty(target, call, place);
      case 'index':
        return this.stepIndex(target, call, place);
      case 'key':
        return this.stepKey(target, call, place);
      case 'relation':
        return this.stepRelation(target, call, bindings, place, owner);
      case 'table':
        return this.stepTable(target, call, place);
      case 'discriminator':
        return this.stepDiscriminator(target, call, place);
      case 'join':
        return this.stepJoin(target, call, place);
      case 'joinSide':
        return this.stepJoinSide(target, call, place);
      case 'none':
        return target;
    }
  }

  /** The first argument from `from` on that is a lambda. */
  private lambdaArg(call: CsCall, from: number = 0): CsLambda | undefined {
    for (const argument of call.args.slice(from)) {
      const lambda: CsLambda | undefined = readLambda(argument);
      if (lambda !== undefined) {
        return lambda;
      }
    }
    return undefined;
  }

  private stringAt(call: CsCall, index: number): string | undefined {
    const node: SyntaxNode | undefined = call.args[index];
    if (node === undefined) {
      return undefined;
    }
    const value: CsValue = evaluate(node, this.consts);
    return value.kind === 'string' ? value.value : undefined;
  }

  private boolAt(call: CsCall, index: number, fallback: boolean): boolean {
    const node: SyntaxNode | undefined = call.args[index];
    if (node === undefined) {
      return fallback;
    }
    const value: CsValue = evaluate(node, this.consts);
    return value.kind === 'bool' ? value.value : fallback;
  }

  private numberAt(call: CsCall, index: number): number | undefined {
    const node: SyntaxNode | undefined = call.args[index];
    if (node === undefined) {
      return undefined;
    }
    const value: CsValue = evaluate(node, this.consts);
    return value.kind === 'number' ? value.value : undefined;
  }

  /** The property names selected by every argument of a call (lambdas, strings, nameof, arrays). */
  private members(call: CsCall, skip: number = 0): string[] {
    const names: string[] = [];
    for (const argument of call.args.slice(skip)) {
      names.push(...(selectedMembers(argument, this.consts) ?? []));
    }
    return names;
  }

  private memberAt(call: CsCall, index: number): string | undefined {
    const node: SyntaxNode | undefined = call.args[index];
    return node === undefined
      ? undefined
      : selectedMembers(node, this.consts)?.[0];
  }

  private entityNameOf(call: CsCall): string | undefined {
    const typeArg: string | undefined = call.typeArgs[0]?.name;
    if (typeArg !== undefined) {
      return typeArg;
    }
    const first: SyntaxNode | undefined = call.args[0];
    if (first !== undefined) {
      const value: CsValue = evaluate(first, this.consts);
      if (value.kind === 'typeof') {
        return value.type;
      }
    }
    return undefined;
  }

  private stepModel(
    call: CsCall,
    bindings: Map<string, Target>,
    place: string,
    owner: CsClass
  ): Target {
    switch (call.name) {
      case 'Entity': {
        const name: string | undefined = this.entityNameOf(call);
        const config: EntityConfig | undefined =
          name === undefined ? undefined : this.entity(name);
        if (config === undefined) {
          this.warn(
            `${place}: Entity(${call.node.text.replace(/^.*?\(/s, '').slice(0, 40)}...) names a type that is not a class in the input; its configuration was ignored.`
          );
          return NONE;
        }
        const entityTarget: Target = this.entityTarget(config);
        const lambda: CsLambda | undefined = this.lambdaArg(call);
        if (lambda !== undefined) {
          this.runLambda(lambda, entityTarget, bindings, place, owner);
          return { kind: 'model' };
        }
        return entityTarget;
      }
      case 'ApplyConfiguration': {
        const argument: SyntaxNode | undefined = call.args[0];
        const className: string | undefined =
          argument?.type === 'object_creation_expression'
            ? parseTypeText(argument.childForFieldName('type')?.text ?? '').name
            : undefined;
        const found: { cls: CsClass; entity: string } | undefined =
          this.project.configurations.find(
            (item) => item.cls.name === className
          );
        if (found === undefined) {
          this.warn(
            `${place}: ApplyConfiguration(${argument?.text ?? ''}) does not name a configuration class in the input and was ignored.`
          );
        } else {
          this.runConfiguration(found.cls, found.entity);
        }
        return { kind: 'model' };
      }
      case 'ApplyConfigurationsFromAssembly':
        this.applyAllConfigurations();
        return { kind: 'model' };
      case 'HasDefaultSchema': {
        const schema: string | undefined = this.stringAt(call, 0);
        if (schema !== undefined) {
          this.defaultSchema = schema;
        }
        return { kind: 'model' };
      }
      case 'Owned': {
        const name: string | undefined = call.typeArgs[0]?.name;
        if (name !== undefined) {
          this.ownedTypes.add(name);
        }
        return { kind: 'model' };
      }
      case 'Ignore': {
        const name: string | undefined = this.entityNameOf(call);
        if (name !== undefined) {
          this.ignoredEntities.add(name);
        }
        return { kind: 'model' };
      }
      default:
        this.unknownCall(call.name, place);
        return { kind: 'model' };
    }
  }

  private stepEntity(
    target: Extract<Target, { kind: 'entity' }>,
    call: CsCall,
    bindings: Map<string, Target>,
    place: string,
    owner: CsClass
  ): Target {
    const { config, scope } = target;
    const isRoot: boolean = target.owned === undefined;
    switch (call.name) {
      case 'Property':
      case 'IndexerProperty': {
        const path: string | undefined = this.memberAt(call, 0);
        if (path === undefined) {
          this.unknownCall(call.name, place, 'the property could not be read');
          return NONE;
        }
        const resolved = this.resolveScope(scope, path);
        const settings: PropConfig = propConfig(resolved.scope, resolved.name);
        settings.declared = true;
        // Property<int>("TenantId") declares a shadow property of that type.
        const first: SyntaxNode | undefined = call.args[0];
        if (
          first !== undefined &&
          call.typeArgs[0] !== undefined &&
          evaluate(first, this.consts).kind === 'string'
        ) {
          const shadow: CsType = call.typeArgs[0];
          settings.shadowType = `${shadow.name}${shadow.args.length > 0 ? `<${shadow.args.map((argument: CsType) => argument.name).join(', ')}>` : ''}${shadow.nullable ? '?' : ''}${'[]'.repeat(shadow.arrayDepth)}`;
        }
        return { kind: 'property', cfg: settings, name: resolved.name };
      }
      case 'HasKey':
        if (isRoot) {
          config.key = this.members(call);
          return { kind: 'key', config };
        }
        return target;
      case 'HasNoKey':
        config.keyless = true;
        return target;
      case 'HasAlternateKey': {
        const index: ConfigIndex = {
          members: this.members(call),
          unique: true,
          hasFilter: false,
          hasInclude: false,
          descending: [],
          isAlternateKey: true,
        };
        config.indexes.push(this.prefixed(index, target.prefix));
        return { kind: 'index', index };
      }
      case 'HasIndex': {
        const first: SyntaxNode | undefined = call.args[0];
        const lambdaFirst: boolean =
          first !== undefined && readLambda(first) !== undefined;
        // HasIndex(e => e.A, "name") names the index; HasIndex("A", "B") lists properties.
        const name: string | undefined = lambdaFirst
          ? this.stringAt(call, 1)
          : undefined;
        const index: ConfigIndex = {
          members:
            lambdaFirst && first !== undefined
              ? (selectedMembers(first, this.consts) ?? [])
              : this.members(call),
          unique: false,
          ...(name === undefined ? {} : { name }),
          hasFilter: false,
          hasInclude: false,
          descending: [],
        };
        config.indexes.push(this.prefixed(index, target.prefix));
        return { kind: 'index', index };
      }
      case 'Ignore': {
        for (const name of this.members(call)) {
          scope.ignored.add(name);
        }
        return target;
      }
      case 'ToTable': {
        const lambda: CsLambda | undefined = this.lambdaArg(call);
        const name: string | undefined = this.stringAt(call, 0);
        const schema: string | undefined = this.stringAt(call, 1);
        if (target.owned !== undefined) {
          target.owned.table = name ?? target.owned.nav;
          this.warn(
            `${place}: the owned type ${target.owned.nav} is stored in its own table "${name ?? target.owned.nav}", which is not represented; its columns were flattened into the owner.`
          );
          return target;
        }
        if (name !== undefined) {
          config.table = name;
        }
        if (schema !== undefined) {
          config.schema = schema;
        }
        if (lambda !== undefined) {
          this.runLambda(
            lambda,
            { kind: 'table', config },
            bindings,
            place,
            owner
          );
        }
        return target;
      }
      case 'ToView': {
        const name: string | undefined = this.stringAt(call, 0);
        if (name !== undefined) {
          config.viewName = name;
        }
        const schema: string | undefined = this.stringAt(call, 1);
        if (schema !== undefined) {
          config.schema = schema;
        }
        return target;
      }
      case 'ToSqlQuery':
        config.keyless = true;
        this.warn(
          `${place}: ${config.name} is mapped to a SQL query (ToSqlQuery), which is not a table; it was read as a table.`
        );
        return target;
      case 'HasOne':
      case 'HasMany': {
        if (!isRoot) {
          this.warn(
            `${place}: ${call.name}(...) inside the owned type ${target.owned?.nav ?? ''} is not interpreted.`
          );
          return NONE;
        }
        const navigation: string | undefined = this.memberAt(call, 0);
        const rel: FluentRelation = {
          owner: config.name,
          ...(navigation === undefined ? {} : { ownerNav: navigation }),
          ownerMany: call.name === 'HasMany',
          ...(call.typeArgs[0] === undefined
            ? {}
            : { target: call.typeArgs[0].name }),
          inverseMany: false,
          complete: false,
        };
        config.relations.push(rel);
        return { kind: 'relation', rel };
      }
      case 'OwnsOne':
      case 'OwnsMany':
      case 'ComplexProperty': {
        const nav: string | undefined = this.memberAt(call, 0);
        if (nav === undefined) {
          this.unknownCall(
            call.name,
            place,
            'the navigation could not be read'
          );
          return target;
        }
        const existing: OwnedConfig | undefined = scope.owned.get(nav);
        const ownedConfig: OwnedConfig =
          existing ?? newOwnedConfig(nav, call.name === 'OwnsMany');
        scope.owned.set(nav, ownedConfig);
        const ownedTarget: Target = {
          kind: 'entity',
          entity: target.entity,
          config,
          scope: ownedConfig,
          prefix: `${target.prefix}${nav}.`,
          owned: ownedConfig,
        };
        // The first argument selects the navigation; a second lambda configures the owned type.
        const lambda: CsLambda | undefined = this.lambdaArg(call, 1);
        if (lambda !== undefined) {
          this.runLambda(lambda, ownedTarget, bindings, place, owner);
          return target;
        }
        return ownedTarget;
      }
      case 'WithOwner':
        return target;
      case 'ToJson':
        if (target.owned !== undefined) {
          target.owned.toJson = true;
        } else {
          this.unknownCall(call.name, place, 'only owned types can be JSON');
        }
        return target;
      case 'HasDiscriminator':
      case 'HasNoDiscriminator': {
        if (call.name === 'HasNoDiscriminator') {
          return target;
        }
        const discriminator: DiscriminatorConfig = config.discriminator ?? {
          values: new Map(),
        };
        const column: string | undefined = this.memberAt(call, 0);
        if (column !== undefined) {
          discriminator.column = column;
        }
        const type: string | undefined = call.typeArgs[0]?.name;
        if (type !== undefined) {
          discriminator.type = type;
        }
        config.discriminator = discriminator;
        return { kind: 'discriminator', config };
      }
      case 'HasBaseType': {
        const name: string | undefined = this.entityNameOf(call);
        config.baseType = name ?? '';
        return target;
      }
      case 'UseTphMappingStrategy':
        config.mapping = 'tph';
        return target;
      case 'UseTptMappingStrategy':
        config.mapping = 'tpt';
        return target;
      case 'UseTpcMappingStrategy':
        config.mapping = 'tpc';
        return target;
      case 'HasComment': {
        const comment: string | undefined = this.stringAt(call, 0);
        if (comment !== undefined) {
          config.comment = comment;
        }
        return target;
      }
      case 'HasData':
        config.hasData = true;
        return target;
      case 'HasQueryFilter':
        config.hasQueryFilter = true;
        return target;
      case 'Navigation': {
        this.unknownCall(
          'Navigation',
          place,
          'navigation settings do not affect the schema'
        );
        return NONE;
      }
      default:
        this.unknownCall(call.name, place);
        return target;
    }
  }

  /** Finds the scope and property name for a possibly dotted member path. */
  private resolveScope(
    scope: Scope,
    path: string
  ): { scope: Scope; name: string } {
    const parts: string[] = path.split('.');
    let current: Scope = scope;
    for (const part of parts.slice(0, -1)) {
      const next: OwnedConfig =
        current.owned.get(part) ?? newOwnedConfig(part, false);
      current.owned.set(part, next);
      current = next;
    }
    return { scope: current, name: parts[parts.length - 1] ?? path };
  }

  private prefixed(index: ConfigIndex, prefix: string): ConfigIndex {
    if (prefix !== '') {
      index.members = index.members.map((member: string) => prefix + member);
    }
    return index;
  }

  private stepProperty(
    target: Extract<Target, { kind: 'property' }>,
    call: CsCall,
    place: string
  ): Target {
    const cfg: PropConfig = target.cfg;
    switch (call.name) {
      case 'HasColumnName': {
        const name: string | undefined = this.stringAt(call, 0);
        if (name !== undefined) {
          cfg.column = name;
        }
        return target;
      }
      case 'HasColumnType': {
        const typeName: string | undefined = this.stringAt(call, 0);
        if (typeName !== undefined) {
          cfg.columnType = typeName;
        }
        return target;
      }
      case 'HasMaxLength': {
        const length: number | undefined = this.numberAt(call, 0);
        if (length !== undefined && length > 0) {
          cfg.maxLength = length;
        }
        return target;
      }
      case 'IsRequired':
        cfg.required = this.boolAt(call, 0, true);
        return target;
      case 'HasPrecision': {
        const precision: number | undefined = this.numberAt(call, 0);
        if (precision !== undefined) {
          cfg.precision = precision;
          cfg.scale = this.numberAt(call, 1) ?? 0;
        }
        return target;
      }
      case 'HasDefaultValue': {
        const node: SyntaxNode | undefined = call.args[0];
        if (node !== undefined) {
          cfg.defaultValue = evaluate(node, this.consts);
        }
        return target;
      }
      case 'HasDefaultValueSql': {
        const sql: string | undefined = this.stringAt(call, 0);
        if (sql !== undefined && sql.trim() !== '') {
          cfg.defaultSql = sql;
        }
        return target;
      }
      case 'HasComputedColumnSql': {
        const sql: string | undefined = this.stringAt(call, 0);
        cfg.generated = 'onAddOrUpdate';
        if (sql !== undefined) {
          cfg.computedSql = sql;
          cfg.computedStored = this.boolAt(call, 1, false);
        }
        return target;
      }
      case 'ValueGeneratedOnAdd':
      case 'UseIdentityColumn':
      case 'UseIdentityAlwaysColumn':
      case 'UseSerialColumn':
      case 'UseAutoincrement':
        cfg.generated = 'onAdd';
        return target;
      case 'ValueGeneratedOnAddOrUpdate':
      case 'ValueGeneratedOnUpdate':
        cfg.generated = 'onAddOrUpdate';
        return target;
      case 'ValueGeneratedNever':
        cfg.generated = 'never';
        return target;
      case 'HasValueGenerator':
        // EF Core creates the Guids itself (what ormbridge writes for a UUID default on SQLite).
        if (/GuidValueGenerator/.test(call.typeArgs[0]?.name ?? '')) {
          cfg.defaultSql ??= 'uuid()';
        }
        return target;
      case 'HasConversion': {
        const typeArg: string | undefined = call.typeArgs[0]?.name;
        const argument: SyntaxNode | undefined = call.args[0];
        if (typeArg !== undefined && call.args.length === 0) {
          cfg.conversion = /EnumToString/.test(typeArg)
            ? 'string'
            : /EnumToNumber|EnumToBytes/.test(typeArg)
              ? 'int'
              : typeArg;
          if (/Converter$/.test(typeArg) && !/^Enum/.test(typeArg)) {
            cfg.customConversion = true;
            cfg.converterClass = typeArg;
            delete cfg.conversion;
          }
        } else if (argument !== undefined) {
          const value: CsValue = evaluate(argument, this.consts);
          if (value.kind === 'typeof') {
            cfg.conversion = value.type;
          } else {
            cfg.customConversion = true;
            // `new PostStatusConverter()`: remembered so an enum converter written in the input can be read.
            const created: RegExpMatchArray | null = argument.text.match(
              /^new\s+(?:\w+\.)*([A-Za-z_]\w*)\s*\(\s*\)$/
            );
            if (created?.[1] !== undefined) {
              cfg.converterClass = created[1];
            }
          }
        }
        return target;
      }
      case 'IsRowVersion':
        cfg.isRowVersion = true;
        cfg.isConcurrencyToken = true;
        return target;
      case 'IsConcurrencyToken':
        cfg.isConcurrencyToken = this.boolAt(call, 0, true);
        return target;
      case 'IsUnicode':
        cfg.isUnicode = this.boolAt(call, 0, true);
        return target;
      case 'HasComment': {
        const comment: string | undefined = this.stringAt(call, 0);
        if (comment !== undefined) {
          cfg.comment = comment;
        }
        return target;
      }
      default:
        this.unknownCall(call.name, place, `on ${target.name}`);
        return target;
    }
  }

  private stepKey(
    target: Extract<Target, { kind: 'key' }>,
    call: CsCall,
    place: string
  ): Target {
    if (call.name === 'HasName') {
      const name: string | undefined = this.stringAt(call, 0);
      if (name !== undefined) {
        target.config.keyName = name;
      }
      return target;
    }
    this.unknownCall(call.name, place, 'on a key');
    return target;
  }

  private stepIndex(
    target: Extract<Target, { kind: 'index' }>,
    call: CsCall,
    place: string
  ): Target {
    const index: ConfigIndex = target.index;
    switch (call.name) {
      case 'IsUnique':
        index.unique = this.boolAt(call, 0, true);
        return target;
      case 'HasDatabaseName':
      case 'HasName': {
        const name: string | undefined = this.stringAt(call, 0);
        if (name !== undefined) {
          index.name = name;
        }
        return target;
      }
      case 'HasFilter':
        index.hasFilter = true;
        return target;
      case 'IncludeProperties':
        index.hasInclude = true;
        return target;
      case 'IsDescending': {
        if (call.args.length === 0) {
          index.descending = index.members.map(() => true);
        } else {
          index.descending = call.args.map((argument: SyntaxNode) => {
            const value: CsValue = evaluate(argument, this.consts);
            return value.kind === 'bool' && value.value;
          });
        }
        return target;
      }
      case 'HasMethod': {
        const method: string | undefined = this.stringAt(call, 0);
        if (method !== undefined) {
          index.method = method;
        }
        return target;
      }
      default:
        this.unknownCall(call.name, place, 'on an index');
        return target;
    }
  }

  private stepRelation(
    target: Extract<Target, { kind: 'relation' }>,
    call: CsCall,
    bindings: Map<string, Target>,
    place: string,
    owner: CsClass
  ): Target {
    const rel: FluentRelation = target.rel;
    switch (call.name) {
      case 'WithOne':
      case 'WithMany': {
        rel.inverseMany = call.name === 'WithMany';
        const navigation: string | undefined = this.memberAt(call, 0);
        if (navigation !== undefined) {
          rel.inverseNav = navigation;
        }
        rel.complete = true;
        return target;
      }
      case 'HasForeignKey': {
        rel.foreignKey = this.members(call);
        const entity: string | undefined = call.typeArgs[0]?.name;
        if (entity !== undefined) {
          rel.foreignKeyEntity = entity;
        }
        return target;
      }
      case 'HasPrincipalKey':
        rel.principalKey = this.members(call);
        return target;
      case 'OnDelete': {
        const value: SyntaxNode | undefined = call.args[0];
        const evaluated: CsValue | undefined =
          value === undefined ? undefined : evaluate(value, this.consts);
        if (evaluated?.kind === 'member') {
          rel.onDelete = evaluated.path[evaluated.path.length - 1];
        }
        return target;
      }
      case 'IsRequired':
        rel.required = this.boolAt(call, 0, true);
        return target;
      case 'HasConstraintName': {
        const name: string | undefined = this.stringAt(call, 0);
        if (name !== undefined) {
          rel.constraintName = name;
        }
        return target;
      }
      case 'UsingEntity':
        this.readUsingEntity(rel, call, bindings, place, owner);
        return target;
      default:
        this.unknownCall(call.name, place, 'on a relationship');
        return target;
    }
  }

  private readUsingEntity(
    rel: FluentRelation,
    call: CsCall,
    bindings: Map<string, Target>,
    place: string,
    owner: CsClass
  ): void {
    const join: JoinConfig = rel.join ?? {};
    rel.join = join;
    const typeArg: string | undefined = call.typeArgs[0]?.name;
    const isShared: boolean = typeArg === undefined || typeArg === 'Dictionary';
    const stringName: string | undefined = this.stringAt(call, 0);
    if (stringName !== undefined) {
      join.entityName = stringName;
    }
    if (!isShared && typeArg !== undefined) {
      join.entityClass = typeArg;
    }
    const lambdas: CsLambda[] = call.args
      .map((argument: SyntaxNode) => readLambda(argument))
      .filter(
        (lambda: CsLambda | undefined): lambda is CsLambda =>
          lambda !== undefined
      );
    const targetName: string = rel.target ?? '';
    if (join.entityClass !== undefined) {
      // An explicit join class: its relationships are ordinary configuration of that entity.
      const config: EntityConfig | undefined = this.entity(join.entityClass);
      if (config === undefined) {
        return;
      }
      config.joinEntity = true;
      for (const lambda of lambdas) {
        this.runLambda(
          lambda,
          this.entityTarget(config),
          bindings,
          place,
          owner
        );
      }
      return;
    }
    // Lambdas that return a relationship configure the foreign key columns (right side first, then left);
    // an Action lambda configures the join table.
    const sides: ('right' | 'left')[] = ['right', 'left'];
    let relationLambdas: number = 0;
    for (const lambda of lambdas) {
      const isRelationLambda: boolean =
        lambda.body.type !== 'block' &&
        /\.With(One|Many)\(/.test(lambda.body.text);
      if (isRelationLambda) {
        const side: 'right' | 'left' = sides[relationLambdas] ?? 'left';
        relationLambdas += 1;
        this.runLambda(
          lambda,
          {
            kind: 'joinSide',
            join,
            owner: rel.owner,
            target: targetName,
            side,
          },
          bindings,
          place,
          owner
        );
      } else {
        this.runLambda(lambda, { kind: 'join', join }, bindings, place, owner);
      }
    }
  }

  private stepJoin(
    target: Extract<Target, { kind: 'join' }>,
    call: CsCall,
    place: string
  ): Target {
    const join: JoinConfig = target.join;
    switch (call.name) {
      case 'ToTable': {
        const name: string | undefined = this.stringAt(call, 0);
        if (name !== undefined) {
          join.table = name;
        }
        const schema: string | undefined = this.stringAt(call, 1);
        if (schema !== undefined) {
          join.schema = schema;
        }
        return target;
      }
      case 'HasKey':
      case 'HasNoKey':
        return target;
      default:
        this.unknownCall(call.name, place, 'on the join entity');
        return target;
    }
  }

  private stepJoinSide(
    target: Extract<Target, { kind: 'joinSide' }>,
    call: CsCall,
    place: string
  ): Target {
    const join: JoinConfig = target.join;
    switch (call.name) {
      case 'HasOne': {
        const typeName: string | undefined = call.typeArgs[0]?.name;
        // HasOne<Tag>() names the entity on the other end of this foreign key.
        const side: 'left' | 'right' | undefined =
          typeName === undefined
            ? target.side
            : typeName === target.target && typeName !== target.owner
              ? 'right'
              : typeName === target.owner && typeName !== target.target
                ? 'left'
                : target.side;
        return { ...target, ...(side === undefined ? {} : { side }) };
      }
      case 'WithMany':
      case 'WithOne':
        return target;
      case 'HasForeignKey': {
        const column: string | undefined = this.members(call)[0];
        if (column !== undefined) {
          if (target.side === 'right') {
            join.rightColumn = column;
          } else {
            join.leftColumn = column;
          }
        }
        return target;
      }
      case 'OnDelete': {
        const value: SyntaxNode | undefined = call.args[0];
        const evaluated: CsValue | undefined =
          value === undefined ? undefined : evaluate(value, this.consts);
        if (evaluated?.kind === 'member') {
          const action: string | undefined =
            evaluated.path[evaluated.path.length - 1];
          if (target.side === 'right') {
            join.rightOnDelete = action;
          } else {
            join.leftOnDelete = action;
          }
        }
        return target;
      }
      default:
        this.unknownCall(call.name, place, 'on the join entity');
        return target;
    }
  }

  private stepTable(
    target: Extract<Target, { kind: 'table' }>,
    call: CsCall,
    place: string
  ): Target {
    switch (call.name) {
      case 'HasComment': {
        const comment: string | undefined = this.stringAt(call, 0);
        if (comment !== undefined) {
          target.config.comment = comment;
        }
        return target;
      }
      case 'HasCheckConstraint': {
        target.config.checkConstraints.push(
          this.stringAt(call, 1) ?? this.stringAt(call, 0) ?? ''
        );
        return target;
      }
      default:
        this.unknownCall(call.name, place, 'on the table');
        return target;
    }
  }

  private stepDiscriminator(
    target: Extract<Target, { kind: 'discriminator' }>,
    call: CsCall,
    place: string
  ): Target {
    const discriminator: DiscriminatorConfig | undefined =
      target.config.discriminator;
    switch (call.name) {
      case 'HasValue': {
        const node: SyntaxNode | undefined = call.args[0];
        if (node !== undefined && discriminator !== undefined) {
          discriminator.values.set(
            call.typeArgs[0]?.name ?? '',
            evaluate(node, this.consts)
          );
        }
        return target;
      }
      case 'IsComplete':
      case 'HasMaxLength':
      case 'IsRequired':
        return target;
      default:
        this.unknownCall(call.name, place, 'on the discriminator');
        return target;
    }
  }
}
