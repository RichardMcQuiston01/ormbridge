import {
  camelize,
  pluralize,
  singularize,
  underscore,
} from './sequelizeInflection.js';
import type {
  AssociationKey,
  AttributeLink,
  ModelOptions,
  Project,
  RawAssociation,
  RawAttribute,
  RawModel,
} from './sequelizeModel.js';

/** A model with the options and names that the association rules need. */
export interface Prepared {
  raw: RawModel;
  options: ModelOptions;
  /** The model name used in the IR. */
  irName: string;
  /** The table Sequelize creates for the model. */
  tableName: string;
}

/** What an association says about the foreign key attribute it is attached to. */
export interface ReverseSide {
  /** The accessor on the model that owns the key (`User.hasMany(Post, { as: 'posts' })`). */
  name: string;
  kind: 'hasMany' | 'hasOne';
  label: string;
}

/** A many-to-many relation whose join table Sequelize creates itself (`through: 'table'`). */
export interface ManyToManyLink {
  owner: Prepared;
  target: Prepared;
  /** The accessor on the owner. */
  name: string;
  /** The accessor on the target, when the target declares the other half. */
  relatedName: string | undefined;
  table: string;
  ownerColumn: string;
  targetColumn: string;
  label: string;
}

export interface LinkResult {
  /** The accessor a `belongsTo` gives the foreign key attribute it owns. */
  aliases: Map<RawAttribute, string>;
  /** The reverse accessors (`hasMany` / `hasOne`) that share a foreign key attribute. */
  reverses: Map<RawAttribute, ReverseSide>;
  manyToMany: ManyToManyLink[];
}

interface Lookup {
  byName: Map<string, Prepared>;
  /** Variable and class names, per file, then across files. */
  byAlias: Map<string, Prepared[]>;
}

function aliasKey(path: string, alias: string): string {
  return `${path}\u0000${alias}`;
}

function buildLookup(prepared: Prepared[]): Lookup {
  const byName: Map<string, Prepared> = new Map();
  const byAlias: Map<string, Prepared[]> = new Map();
  const add = (key: string, model: Prepared): void => {
    const list: Prepared[] = byAlias.get(key) ?? [];
    list.push(model);
    byAlias.set(key, list);
  };
  for (const model of prepared) {
    byName.set(model.raw.modelName, model);
    for (const alias of model.raw.aliases) {
      add(aliasKey(model.raw.file.path, alias), model);
      add(alias, model);
    }
  }
  return { byName, byAlias };
}

function resolveModel(
  reference: string,
  path: string,
  lookup: Lookup
): Prepared | undefined {
  const local: Prepared[] | undefined = lookup.byAlias.get(
    aliasKey(path, reference)
  );
  if (local !== undefined && local.length === 1) {
    return local[0];
  }
  const byName: Prepared | undefined = lookup.byName.get(reference);
  if (byName !== undefined) {
    return byName;
  }
  const shared: Prepared[] | undefined = lookup.byAlias.get(reference);
  return shared !== undefined && shared.length === 1 ? shared[0] : undefined;
}

// ---------------------------------------------------------------------------
// Names the way Sequelize derives them
// ---------------------------------------------------------------------------

function singularName(model: Prepared): string {
  return model.options.nameSingular ?? singularize(model.raw.modelName);
}

function pluralName(model: Prepared): string {
  return model.options.namePlural ?? pluralize(model.raw.modelName);
}

function attributeOf(model: Prepared, name: string): RawAttribute | undefined {
  return model.raw.attributes.find(
    (attribute: RawAttribute) => attribute.name === name
  );
}

/** The first primary key attribute, which Sequelize calls `primaryKeyAttribute`. */
function primaryKeyName(model: Prepared): string {
  return (
    model.raw.attributes.find(
      (attribute: RawAttribute) => attribute.primaryKey === true
    )?.name ?? 'id'
  );
}

function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

/** The column of an attribute: its `field`, else the name (snake_case when the model is `underscored`). */
export function columnOf(model: Prepared, attribute: RawAttribute): string {
  return (
    attribute.field ??
    (model.options.underscored ? underscore(attribute.name) : attribute.name)
  );
}

// ---------------------------------------------------------------------------
// Foreign keys
// ---------------------------------------------------------------------------

interface KeySpec {
  holder: Prepared;
  name: string;
  /** The option object of `foreignKey` / `otherKey`, which can carry `allowNull`, `field`, ... */
  key: AssociationKey | undefined;
  keyOwner: Prepared | undefined;
  keyOwnerName: string;
  keyAttribute: string | undefined;
  onDelete: string | undefined;
  onUpdate: string | undefined;
  constraints: boolean | undefined;
  /** Sequelize's default `ON DELETE`, chosen by whether the column allows null. */
  defaultOnDelete: (allowNull: boolean) => string;
}

function copyColumnType(
  target: RawAttribute,
  source: RawAttribute | undefined
): void {
  if (source === undefined) {
    return;
  }
  if (source.type !== undefined) {
    target.type = source.type;
  }
  if (source.tsType !== undefined) {
    target.tsType = source.tsType;
  }
  if (source.enumValues !== undefined) {
    target.enumValues = source.enumValues;
  }
}

/** The column settings of an attribute definition, without its identity and without unset values. */
function columnSettings(
  attribute: RawAttribute | undefined
): Partial<RawAttribute> {
  const settings: Partial<RawAttribute> = {};
  if (attribute === undefined) {
    return settings;
  }
  for (const [key, value] of Object.entries(attribute)) {
    if (key !== 'name' && key !== 'origin' && value !== undefined) {
      Object.assign(settings, { [key]: value });
    }
  }
  return settings;
}

/** Adds the foreign key column an association needs, or completes the one the model already declares. */
function injectKey(spec: KeySpec, project: Project): RawAttribute {
  const existing: RawAttribute | undefined = attributeOf(
    spec.holder,
    spec.name
  );
  const template: RawAttribute | undefined = spec.key?.attribute;
  const keyAttribute: RawAttribute | undefined =
    spec.keyOwner === undefined || spec.keyAttribute === undefined
      ? undefined
      : attributeOf(spec.keyOwner, spec.keyAttribute);

  let attribute: RawAttribute;
  let allowNullForDefault: boolean;
  if (existing === undefined) {
    attribute = { name: spec.name, origin: 'foreignKey', allowNull: true };
    copyColumnType(attribute, keyAttribute);
    Object.assign(attribute, columnSettings(template));
    spec.holder.raw.attributes.push(attribute);
    allowNullForDefault = attribute.allowNull === true;
  } else {
    attribute = existing;
    // Sequelize decides the default action before it completes the column.
    allowNullForDefault = existing.allowNull === true;
    if (attribute.type === undefined) {
      copyColumnType(attribute, keyAttribute);
    }
    if (attribute.allowNull === undefined) {
      attribute.allowNull = template?.allowNull ?? true;
    }
    // What the model declares wins over what the foreignKey option adds.
    Object.assign(attribute, {
      ...columnSettings(template),
      ...columnSettings(attribute),
    });
  }

  const constrained: boolean =
    spec.constraints !== false ||
    spec.onDelete !== undefined ||
    spec.onUpdate !== undefined;
  const keyIsComposite: boolean =
    spec.keyOwner !== undefined &&
    spec.keyOwner.raw.attributes.filter(
      (candidate: RawAttribute) => candidate.primaryKey === true
    ).length > 1 &&
    keyAttribute?.primaryKey === true;
  if (
    constrained &&
    !keyIsComposite &&
    attribute.link === undefined &&
    attribute.references === undefined
  ) {
    const onDelete: string | undefined =
      attribute.onDelete ??
      spec.onDelete ??
      (spec.constraints === false
        ? undefined
        : spec.defaultOnDelete(allowNullForDefault));
    const onUpdate: string | undefined =
      attribute.onUpdate ??
      spec.onUpdate ??
      (spec.constraints === false ? undefined : 'CASCADE');
    const link: AttributeLink = {
      target: spec.keyOwner?.raw,
      targetName: spec.keyOwnerName,
      keyAttribute: spec.keyAttribute,
      constraint: true,
      ...(onDelete === undefined ? {} : { onDelete }),
      ...(onUpdate === undefined ? {} : { onUpdate }),
    };
    attribute.link = link;
  } else if (spec.constraints === false && attribute.link === undefined) {
    project.warnings.push(
      `${spec.holder.raw.location}, field "${attribute.name}": the association uses constraints: false, so there is no foreign key in the database; the column is read as a plain column.`
    );
  }
  return attribute;
}

// ---------------------------------------------------------------------------
// belongsToMany
// ---------------------------------------------------------------------------

interface ManyToManyPlan {
  assoc: RawAssociation;
  source: Prepared;
  target: Prepared;
  as: string;
  foreignKey: string;
  otherKey: string;
  otherKeyIsDefault: boolean;
  /** Join table name when `through` is a string that names no model. */
  table: string | undefined;
  /** The join model when `through` names one. */
  throughModel: Prepared | undefined;
  paired: ManyToManyPlan | undefined;
  /** True when the other half of a pair already produced the relation. */
  consumed: boolean;
}

function sameThrough(first: ManyToManyPlan, second: ManyToManyPlan): boolean {
  if (first.throughModel !== undefined || second.throughModel !== undefined) {
    return first.throughModel === second.throughModel;
  }
  return first.table === second.table;
}

function planManyToMany(
  assoc: RawAssociation,
  source: Prepared,
  target: Prepared,
  lookup: Lookup,
  project: Project
): ManyToManyPlan | undefined {
  const through = assoc.options.through;
  if (through === undefined) {
    project.warnings.push(
      `${assoc.label}: belongsToMany needs a through option (a table name or a model); the association was skipped.`
    );
    return undefined;
  }
  const isSelf: boolean = source === target;
  const as: string | undefined = assoc.options.as;
  if (isSelf && as === undefined) {
    project.warnings.push(
      `${assoc.label}: a many-to-many association to the same model needs an "as"; the association was skipped.`
    );
    return undefined;
  }
  const alias: string = as ?? pluralName(target);
  let throughModel: Prepared | undefined;
  if (through.model !== undefined) {
    throughModel = resolveModel(through.model, assoc.file.path, lookup);
    if (throughModel === undefined) {
      project.warnings.push(
        `${assoc.label}: the through model "${through.model}" is not in the input; the association was skipped.`
      );
      return undefined;
    }
  } else if (through.table !== undefined) {
    // A string that names a defined model uses that model.
    throughModel = lookup.byName.get(through.table);
  }
  // sequelize-typescript finds the keys through @ForeignKey on the join model.
  const hints: [string | undefined, string | undefined] =
    assoc.owner !== undefined && throughModel !== undefined
      ? hintedKeys(throughModel, source, target)
      : [undefined, undefined];
  const sourceKey: string = assoc.options.sourceKey ?? primaryKeyName(source);
  const targetKey: string = assoc.options.targetKey ?? primaryKeyName(target);
  const foreignKey: string =
    assoc.options.foreignKey?.name ??
    hints[0] ??
    camelize(`${singularName(source)}_${sourceKey}`);
  const otherKey: string =
    assoc.options.otherKey?.name ??
    hints[1] ??
    camelize(
      `${isSelf ? singularize(alias) : singularName(target)}_${targetKey}`
    );
  return {
    assoc,
    source,
    target,
    as: alias,
    foreignKey,
    otherKey,
    otherKeyIsDefault:
      assoc.options.otherKey?.name === undefined && hints[1] === undefined,
    table: throughModel === undefined ? through.table : undefined,
    throughModel,
    paired: undefined,
    consumed: false,
  };
}

/** The join model's attributes marked `@ForeignKey` for the source and for the target model. */
function hintedKeys(
  join: Prepared,
  source: Prepared,
  target: Prepared
): [string | undefined, string | undefined] {
  const pointsAt = (model: Prepared, hint: string): boolean =>
    model.raw.aliases.includes(hint) || model.raw.modelName === hint;
  const hints: [string, string][] = [...join.raw.foreignKeyHints.entries()];
  const fromSource: [string, string] | undefined = hints.find(
    ([, hint]: [string, string]) => pointsAt(source, hint)
  );
  const fromTarget: [string, string] | undefined = hints.find(
    ([name, hint]: [string, string]) =>
      pointsAt(target, hint) && name !== fromSource?.[0]
  );
  return [fromSource?.[0], fromTarget?.[0]];
}

/** Injects the two key columns into an explicit join model. */
function injectJoinModel(plan: ManyToManyPlan, project: Project): void {
  const join: Prepared | undefined = plan.throughModel;
  if (join === undefined) {
    return;
  }
  const options = plan.assoc.options;
  // A join model without a key of its own loses the generated `id`; the two keys become its primary key.
  const generated: RawAttribute | undefined = join.raw.attributes.find(
    (attribute: RawAttribute) =>
      attribute.origin === 'id' && attribute.primaryKey === true
  );
  if (generated !== undefined) {
    join.raw.attributes.splice(join.raw.attributes.indexOf(generated), 1);
  }
  const sourceKey: string = options.sourceKey ?? primaryKeyName(plan.source);
  const targetKey: string = options.targetKey ?? primaryKeyName(plan.target);
  const hasOwnKey: boolean = join.raw.attributes.some(
    (attribute: RawAttribute) =>
      attribute.primaryKey === true &&
      attribute.name !== plan.foreignKey &&
      attribute.name !== plan.otherKey
  );
  const uniqueName: string = `${join.tableName}_${plan.foreignKey}_${plan.otherKey}_unique`;
  const keys: [string, Prepared, string, AssociationKey | undefined][] = [
    [plan.foreignKey, plan.source, sourceKey, options.foreignKey],
    [plan.otherKey, plan.target, targetKey, options.otherKey],
  ];
  for (const [name, owner, keyAttribute, key] of keys) {
    const attribute: RawAttribute = injectKey(
      {
        holder: join,
        name,
        key,
        keyOwner: owner,
        keyOwnerName: owner.irName,
        keyAttribute,
        onDelete: options.onDelete,
        onUpdate: options.onUpdate,
        constraints: options.constraints,
        defaultOnDelete: () => 'CASCADE',
      },
      project
    );
    if (!hasOwnKey) {
      attribute.primaryKey = true;
    } else if (
      options.through?.unique !== false &&
      attribute.unique === undefined
    ) {
      attribute.unique = { name: uniqueName };
    }
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Applies the associations the way Sequelize does when `associate` runs: foreign key columns are added to
 * the model that holds them (or completed when the model declares them), and the accessor names are
 * recorded so the relations can be named and paired.
 */
export function linkAssociations(
  prepared: Prepared[],
  project: Project
): LinkResult {
  const lookup: Lookup = buildLookup(prepared);
  const result: LinkResult = {
    aliases: new Map(),
    reverses: new Map(),
    manyToMany: [],
  };
  const plans: ManyToManyPlan[] = [];

  for (const assoc of project.associations) {
    for (const unsupported of assoc.options.unsupported) {
      project.warnings.push(
        `${assoc.label}: the ${unsupported} option has no equivalent and was ignored.`
      );
    }
    const sourceName: string | undefined =
      assoc.owner !== undefined
        ? undefined
        : assoc.source === 'this'
          ? assoc.enclosing
          : assoc.source;
    const source: Prepared | undefined =
      assoc.owner !== undefined
        ? prepared.find((model: Prepared) => model.raw === assoc.owner)
        : sourceName === undefined
          ? undefined
          : resolveModel(sourceName, assoc.file.path, lookup);
    if (source === undefined) {
      project.warnings.push(
        `${assoc.file.label}: ${assoc.label} is called on "${sourceName ?? assoc.source}", which is not a model in the input; the association was skipped.`
      );
      continue;
    }
    const target: Prepared | undefined = resolveModel(
      assoc.target,
      assoc.file.path,
      lookup
    );
    resolveFromHints(assoc, source, target);
    switch (assoc.kind) {
      case 'belongsTo':
        linkBelongsTo(assoc, source, target, result, project);
        break;
      case 'hasMany':
      case 'hasOne':
        linkHasOneOrMany(assoc, source, target, result, project);
        break;
      case 'belongsToMany': {
        if (target === undefined) {
          project.warnings.push(
            `${assoc.label}: "${assoc.target}" is not a model in the input; the many-to-many association was skipped.`
          );
          break;
        }
        const plan: ManyToManyPlan | undefined = planManyToMany(
          assoc,
          source,
          target,
          lookup,
          project
        );
        if (plan !== undefined) {
          plans.push(plan);
        }
        break;
      }
    }
  }
  linkManyToMany(plans, result, project);
  return result;
}

/** sequelize-typescript finds a foreign key through `@ForeignKey(() => Model)` when none is named. */
function resolveFromHints(
  assoc: RawAssociation,
  source: Prepared,
  target: Prepared | undefined
): void {
  if (
    assoc.owner === undefined ||
    assoc.options.foreignKey !== undefined ||
    target === undefined
  ) {
    return;
  }
  const holder: RawModel | undefined =
    assoc.kind === 'belongsTo' ? source.raw : target.raw;
  const pointsAt: RawModel =
    assoc.kind === 'belongsTo' ? target.raw : source.raw;
  if (assoc.kind === 'belongsToMany') {
    return;
  }
  const names: string[] = [...holder.foreignKeyHints.entries()]
    .filter(
      ([, model]: [string, string]) =>
        pointsAt.aliases.includes(model) || pointsAt.modelName === model
    )
    .map(([name]: [string, string]) => name);
  const only: string | undefined = names[0];
  if (only !== undefined) {
    assoc.options.foreignKey = {
      name: only,
      attribute: { name: only, origin: 'foreignKey' },
    };
  }
}

function linkBelongsTo(
  assoc: RawAssociation,
  source: Prepared,
  target: Prepared | undefined,
  result: LinkResult,
  project: Project
): void {
  const targetName: string = target?.irName ?? assoc.target;
  const as: string =
    assoc.options.as ??
    (target === undefined ? singularize(assoc.target) : singularName(target));
  const targetPrimaryKey: string =
    target === undefined ? 'id' : primaryKeyName(target);
  const name: string =
    assoc.options.foreignKey?.name ?? camelize(`${as}_${targetPrimaryKey}`);
  const attribute: RawAttribute = injectKey(
    {
      holder: source,
      name,
      key: assoc.options.foreignKey,
      keyOwner: target,
      keyOwnerName: targetName,
      keyAttribute: assoc.options.targetKey ?? targetPrimaryKey,
      onDelete: assoc.options.onDelete,
      onUpdate: assoc.options.onUpdate,
      constraints: assoc.options.constraints,
      defaultOnDelete: (allowNull: boolean) =>
        allowNull ? 'SET NULL' : 'NO ACTION',
    },
    project
  );
  if (!result.aliases.has(attribute)) {
    result.aliases.set(attribute, lowerFirst(as));
  }
}

function linkHasOneOrMany(
  assoc: RawAssociation,
  source: Prepared,
  target: Prepared | undefined,
  result: LinkResult,
  project: Project
): void {
  if (target === undefined) {
    project.warnings.push(
      `${assoc.label}: "${assoc.target}" is not a model in the input, so the foreign key it needs could not be added; the association was skipped.`
    );
    return;
  }
  const isMany: boolean = assoc.kind === 'hasMany';
  const as: string =
    assoc.options.as ?? (isMany ? pluralName(target) : singularName(target));
  const sourceKey: string = assoc.options.sourceKey ?? primaryKeyName(source);
  // hasOne names the key after its alias when it has one; hasMany always uses the model.
  const keyBase: string = isMany
    ? singularName(source)
    : singularize(assoc.options.as ?? source.raw.modelName);
  const name: string =
    assoc.options.foreignKey?.name ??
    camelize(`${keyBase}_${primaryKeyName(source)}`);
  const attribute: RawAttribute = injectKey(
    {
      holder: target,
      name,
      key: assoc.options.foreignKey,
      keyOwner: source,
      keyOwnerName: source.irName,
      keyAttribute: sourceKey,
      onDelete: assoc.options.onDelete,
      onUpdate: assoc.options.onUpdate,
      constraints: assoc.options.constraints,
      defaultOnDelete: (allowNull: boolean) =>
        allowNull ? 'SET NULL' : 'CASCADE',
    },
    project
  );
  if (!result.reverses.has(attribute)) {
    result.reverses.set(attribute, {
      name: lowerFirst(as),
      kind: isMany ? 'hasMany' : 'hasOne',
      label: assoc.label,
    });
  }
}

function linkManyToMany(
  plans: ManyToManyPlan[],
  result: LinkResult,
  project: Project
): void {
  // Two declarations over the same join table are the two halves of one relation.
  for (const [index, plan] of plans.entries()) {
    if (plan.paired !== undefined) {
      continue;
    }
    const other: ManyToManyPlan | undefined = plans
      .slice(index + 1)
      .find(
        (candidate: ManyToManyPlan) =>
          candidate.paired === undefined &&
          candidate.source === plan.target &&
          candidate.target === plan.source &&
          sameThrough(plan, candidate)
      );
    if (other !== undefined) {
      plan.paired = other;
      other.paired = plan;
    }
  }
  for (const plan of plans) {
    const paired: ManyToManyPlan | undefined = plan.paired;
    if (paired !== undefined && plan.otherKeyIsDefault) {
      plan.otherKey = paired.foreignKey;
    }
  }
  for (const plan of plans) {
    if (plan.throughModel !== undefined) {
      injectJoinModel(plan, project);
      continue;
    }
    const paired: ManyToManyPlan | undefined = plan.paired;
    if (plan.consumed) {
      continue;
    }
    if (paired !== undefined) {
      paired.consumed = true;
    }
    const table: string = plan.table ?? '';
    // The join model is defined with the options of the model the association is called on.
    const underscored: boolean = plan.source.options.underscored;
    const column = (name: string, key: AssociationKey | undefined): string =>
      key?.attribute.field ?? (underscored ? underscore(name) : name);
    result.manyToMany.push({
      owner: plan.source,
      target: plan.target,
      name: lowerFirst(plan.as),
      relatedName: paired === undefined ? undefined : lowerFirst(paired.as),
      table,
      ownerColumn: column(plan.foreignKey, plan.assoc.options.foreignKey),
      targetColumn: column(plan.otherKey, plan.assoc.options.otherKey),
      label: plan.assoc.label,
    });
  }
}
