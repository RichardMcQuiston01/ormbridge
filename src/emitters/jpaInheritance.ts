import type { IrModel, IrRelation } from '../ir.js';
import type { KeyInfo, KeyPart } from './jpaKeys.js';

/**
 * How inheritance is written: `none` (the default) keeps a model whose primary key is its one-to-one relation to
 * another model as a derived identity (`@Id @OneToOne`) and a hierarchy the JPA reader flattened as flat classes;
 * `joined` writes that model as a subclass of the other one (`@Inheritance(strategy = JOINED)` on the root,
 * `@PrimaryKeyJoinColumn` on the subclass); `all` does that and also writes the single-table and table-per-class
 * hierarchies the JPA reader recorded (see jpaHierarchy.ts). The tables are the same in every mode.
 */
export type JpaInheritanceMode = 'none' | 'joined' | 'all';

export const JPA_INHERITANCE_MODES: readonly JpaInheritanceMode[] = [
  'none',
  'joined',
  'all',
];

/** True when a value is one of the `--jpa-inheritance` modes. */
export function isJpaInheritanceMode(
  value: string
): value is JpaInheritanceMode {
  return (JPA_INHERITANCE_MODES as readonly string[]).includes(value);
}

/** A model that is written as a subclass of the model its primary key points at. */
export interface JoinedChild {
  /** The relation that is the primary key of the subclass. */
  relation: IrRelation;
  /** The superclass model. */
  parent: IrModel;
  /** The key column of the subclass table. */
  column: string;
  /** The key column of the superclass table that it references. */
  parentColumn: string;
}

export interface JoinedPlan {
  /** The subclasses, by model name. */
  children: ReadonlyMap<string, JoinedChild>;
  /** The models at the top of a hierarchy that has at least one subclass. */
  roots: ReadonlySet<string>;
  /** The models with every superclass before its subclasses. */
  order: readonly IrModel[];
}

export const NO_JOINED: JoinedPlan = {
  children: new Map<string, JoinedChild>(),
  roots: new Set<string>(),
  order: [],
};

function singleKey(info: KeyInfo | undefined): KeyPart | undefined {
  return info !== undefined && info.parts.length === 1 && !info.synthesized
    ? info.parts[0]
    : undefined;
}

/**
 * Finds the models that can be subclasses: the whole primary key is one relation to another model's key, and the
 * chain of such models ends at a model with an ordinary single-column key. A model that is not one of them, but
 * whose key is a relation, is reported and keeps its derived identity.
 */
export function planJoined(
  models: readonly IrModel[],
  keys: ReadonlyMap<string, KeyInfo>,
  warn: (message: string) => void
): JoinedPlan {
  const byName: Map<string, IrModel> = new Map(
    models.map((model: IrModel): [string, IrModel] => [model.name, model])
  );
  const reasons: Map<string, string> = new Map();
  const candidates: Map<string, JoinedChild> = new Map();
  for (const model of models) {
    const part: KeyPart | undefined = singleKey(keys.get(model.name));
    if (part === undefined || part.kind !== 'relation') {
      continue;
    }
    const relation: IrRelation = part.relation;
    const parent: IrModel | undefined = byName.get(relation.targetModel);
    if (relation.kind === 'manyToMany' || parent === undefined) {
      reasons.set(model.name, `${relation.targetModel} is not in the input`);
    } else if (parent === model) {
      reasons.set(model.name, 'the key points at the model itself');
    } else if (parent.isView === true || model.isView === true) {
      reasons.set(model.name, 'a database view cannot be part of a hierarchy');
    } else if (relation.toField !== undefined) {
      reasons.set(
        model.name,
        `the key references ${relation.targetModel}.${relation.toField}, which is not its primary key`
      );
    } else {
      candidates.set(model.name, {
        relation,
        parent,
        column: relation.columnName,
        parentColumn: '',
      });
    }
  }
  // The parent's key column: an ordinary key field, or (for a deeper level) the key column of the parent's own table.
  const valid: Map<string, JoinedChild> = new Map();
  const resolve = (
    name: string,
    trail: ReadonlySet<string>
  ): string | undefined => {
    const own: JoinedChild | undefined = candidates.get(name);
    if (own === undefined) {
      const part: KeyPart | undefined = singleKey(keys.get(name));
      return part?.kind === 'field' ? part.field.columnName : undefined;
    }
    if (trail.has(name)) {
      return undefined;
    }
    return resolve(own.parent.name, new Set([...trail, name])) === undefined
      ? undefined
      : own.column;
  };
  for (const [name, child] of candidates) {
    const parentColumn: string | undefined = resolve(
      child.parent.name,
      new Set([name])
    );
    if (parentColumn === undefined) {
      reasons.set(
        name,
        `${child.parent.name} has no single-column primary key to extend`
      );
    } else {
      valid.set(name, { ...child, parentColumn });
    }
  }
  // A subclass whose superclass was rejected has no hierarchy to join.
  let changed: boolean = true;
  while (changed) {
    changed = false;
    for (const [name, child] of valid) {
      if (candidates.has(child.parent.name) && !valid.has(child.parent.name)) {
        valid.delete(name);
        reasons.set(
          name,
          `${child.parent.name} is not written as a subclass either`
        );
        changed = true;
      }
    }
  }
  for (const [name, reason] of reasons) {
    warn(
      `${name}: the primary key is a relationship, but ${reason}, so the model keeps its derived identity (@Id @OneToOne) instead of extending its target.`
    );
  }
  const roots: Set<string> = new Set();
  for (const child of valid.values()) {
    let top: IrModel = child.parent;
    while (valid.has(top.name)) {
      top = valid.get(top.name)?.parent ?? top;
    }
    roots.add(top.name);
  }
  const order: IrModel[] = [];
  const placed: Set<string> = new Set();
  const place = (model: IrModel): void => {
    if (placed.has(model.name)) {
      return;
    }
    placed.add(model.name);
    const child: JoinedChild | undefined = valid.get(model.name);
    if (child !== undefined) {
      place(child.parent);
    }
    order.push(model);
  };
  models.forEach(place);
  return { children: valid, roots, order };
}
