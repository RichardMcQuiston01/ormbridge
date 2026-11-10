import type {
  IrHierarchy,
  IrHierarchyClass,
  IrModel,
  IrSchema,
} from '../ir.js';
import { annotation, type AnnotationNode } from './jpaFormat.js';
import {
  classNameOf,
  javaString,
  RESERVED_TYPE_NAMES,
  uniqueName,
} from './jpaNames.js';
import type { InverseLink } from './jpaRelations.js';
import {
  Imports,
  type Attribute,
  type JpaStyle,
  type ModelPlan,
} from './jpaTypes.js';

/** What writing the hierarchies adds to the plans of the models. */
export interface HierarchyOutput {
  /** The classes that are not models (single-table subclasses, abstract table-per-class classes), in file order. */
  extraPlans: ModelPlan[];
  /** Class annotations to put after `@Entity` and `@Table` of a model's class, by model name. */
  rootAnnotations: Map<string, AnnotationNode[]>;
}

export interface HierarchyContext {
  schema: IrSchema;
  plans: ReadonlyMap<string, ModelPlan>;
  inverses: InverseLink[];
  style: JpaStyle;
  /** The names of the types the output already uses; new classes take theirs from it. */
  typeNames: Set<string>;
  warn: (message: string) => void;
}

function modelOf(schema: IrSchema, name: string): IrModel | undefined {
  return schema.models.find((model: IrModel) => model.name === name);
}

function newPlan(
  context: HierarchyContext,
  name: string,
  model: IrModel
): ModelPlan {
  const raw: string = classNameOf(name);
  const className: string = uniqueName(
    RESERVED_TYPE_NAMES.has(raw) ? `${raw}Entity` : raw,
    context.typeNames
  );
  return {
    model,
    className,
    fieldNames: new Map<string, string>(),
    relationNames: new Map<string, string>(),
    used: new Set<string>(),
    attributes: [],
    classAnnotations: [],
    imports: new Imports(context.style),
    dynamicInsert: false,
  };
}

/** The attribute of a plan that holds a field (or a relation), found through the names the plan gave them. */
function attributeFor(
  plan: ModelPlan,
  kind: 'field' | 'relation',
  name: string
): Attribute | undefined {
  const attribute: string | undefined = (
    kind === 'field' ? plan.fieldNames : plan.relationNames
  ).get(name);
  return plan.attributes.find((item: Attribute) => item.name === attribute);
}

/** True when every field a hierarchy names is a field of the model (a renamed schema no longer matches). */
function matches(hierarchy: IrHierarchy, schema: IrSchema): boolean {
  const models: IrModel[] = schema.models;
  return hierarchy.classes.every((item: IrHierarchyClass) => {
    const holders: IrModel[] =
      hierarchy.strategy === 'singleTable'
        ? models.filter(
            (model: IrModel) => model.name === hierarchy.classes[0]?.name
          )
        : models.filter((model: IrModel) =>
            hierarchy.classes.some(
              (other: IrHierarchyClass) => other.name === model.name
            )
          );
    return (
      holders.length > 0 &&
      holders.some((model: IrModel) =>
        item.fields.every((field: string) =>
          model.fields.some((candidate) => candidate.name === field)
        )
      )
    );
  });
}

/**
 * Writes the hierarchies the JPA reader recorded (`--jpa-inheritance all`): in a single-table hierarchy the root and a
 * subclass for every other class, each with the attributes it declares and the discriminator in the annotations; in a
 * table-per-class hierarchy a class for every class (an abstract one for a class without a table), each table keeping
 * only what the class declares. A hierarchy the models no longer match is skipped with a warning.
 */
export function applyHierarchies(context: HierarchyContext): HierarchyOutput {
  const output: HierarchyOutput = {
    extraPlans: [],
    rootAnnotations: new Map<string, AnnotationNode[]>(),
  };
  for (const hierarchy of context.schema.hierarchies ?? []) {
    const root: string = hierarchy.classes[0]?.name ?? '';
    if (!matches(hierarchy, context.schema)) {
      context.warn(
        `${root}: the inheritance hierarchy no longer matches the models (the names were changed), so the classes were written flat.`
      );
      continue;
    }
    if (hierarchy.strategy === 'singleTable') {
      singleTable(context, hierarchy, output);
    } else {
      tablePerClass(context, hierarchy, output);
    }
  }
  return output;
}

function singleTable(
  context: HierarchyContext,
  hierarchy: IrHierarchy,
  output: HierarchyOutput
): void {
  const rootClass: IrHierarchyClass | undefined = hierarchy.classes[0];
  const model: IrModel | undefined =
    rootClass === undefined
      ? undefined
      : modelOf(context.schema, rootClass.name);
  const plan: ModelPlan | undefined =
    model === undefined ? undefined : context.plans.get(model.name);
  const discriminator = hierarchy.discriminator;
  if (
    rootClass === undefined ||
    model === undefined ||
    plan === undefined ||
    discriminator === undefined
  ) {
    return;
  }
  const rootImports: Imports = plan.imports;
  const discriminatorType: string =
    rootImports.persistence('DiscriminatorType');
  output.rootAnnotations.set(model.name, [
    annotation(rootImports.persistence('Inheritance'), [
      [
        'strategy',
        `${rootImports.persistence('InheritanceType')}.SINGLE_TABLE`,
      ],
    ]),
    annotation(rootImports.persistence('DiscriminatorColumn'), [
      ['name', javaString(discriminator.column)],
      [
        'discriminatorType',
        `${discriminatorType}.${discriminator.type === 'int' ? 'INTEGER' : discriminator.type === 'char' ? 'CHAR' : 'STRING'}`,
      ],
      ...(discriminator.length === undefined
        ? []
        : ([['length', String(discriminator.length)]] as [string, string][])),
    ]),
    annotation(rootImports.persistence('DiscriminatorValue'), [
      [undefined, javaString(rootClass.discriminatorValue ?? rootClass.name)],
    ]),
  ]);
  // The discriminator column is written by @DiscriminatorColumn; an attribute for it would map the column twice.
  const discriminatorAttribute: Attribute | undefined = attributeFor(
    plan,
    'field',
    discriminator.field
  );
  plan.attributes = plan.attributes.filter(
    (item: Attribute) => item !== discriminatorAttribute
  );
  const classPlans: Map<string, ModelPlan> = new Map([[rootClass.name, plan]]);
  for (const item of hierarchy.classes.slice(1)) {
    const sub: ModelPlan = newPlan(context, item.name, model);
    const parent: ModelPlan | undefined =
      item.parent === undefined ? plan : classPlans.get(item.parent);
    sub.extendsClass = (parent ?? plan).className;
    if (item.isAbstract === true) {
      sub.isAbstract = true;
    }
    sub.classAnnotations.push(
      annotation(sub.imports.persistence('Entity')),
      annotation(sub.imports.persistence('DiscriminatorValue'), [
        [undefined, javaString(item.discriminatorValue ?? item.name)],
      ])
    );
    for (const field of item.fields) {
      const found: Attribute | undefined = attributeFor(plan, 'field', field);
      if (found !== undefined) {
        sub.attributes.push(found);
      }
    }
    for (const relation of item.relations) {
      const found: Attribute | undefined = attributeFor(
        plan,
        'relation',
        relation
      );
      if (found !== undefined) {
        sub.attributes.push(found);
        for (const link of context.inverses) {
          if (link.owner === plan && link.mappedBy === found.name) {
            link.owner = sub;
          }
        }
      }
    }
    plan.attributes = plan.attributes.filter(
      (candidate: Attribute) => !sub.attributes.includes(candidate)
    );
    classPlans.set(item.name, sub);
    output.extraPlans.push(sub);
  }
}

function tablePerClass(
  context: HierarchyContext,
  hierarchy: IrHierarchy,
  output: HierarchyOutput
): void {
  const classPlans: Map<string, ModelPlan> = new Map();
  const children = (name: string): IrHierarchyClass[] =>
    hierarchy.classes.filter((item: IrHierarchyClass) => item.parent === name);
  /** The first concrete class at or below a class: the plan whose attributes carry what the class declares. */
  const holder = (item: IrHierarchyClass): ModelPlan | undefined => {
    const own: ModelPlan | undefined = context.plans.get(item.name);
    if (own !== undefined && modelOf(context.schema, item.name) !== undefined) {
      return own;
    }
    for (const child of children(item.name)) {
      const found: ModelPlan | undefined = holder(child);
      if (found !== undefined) {
        return found;
      }
    }
    return undefined;
  };
  // What each class declares, taken before any plan is changed.
  const declared: Map<string, Attribute[]> = new Map();
  for (const item of hierarchy.classes) {
    const source: ModelPlan | undefined = holder(item);
    const attributes: Attribute[] = [];
    if (source !== undefined) {
      for (const field of item.fields) {
        const found: Attribute | undefined = attributeFor(
          source,
          'field',
          field
        );
        if (found !== undefined) {
          attributes.push(found);
        }
      }
      for (const relation of item.relations) {
        const found: Attribute | undefined = attributeFor(
          source,
          'relation',
          relation
        );
        if (found !== undefined) {
          attributes.push(found);
        }
      }
    }
    declared.set(item.name, attributes);
  }
  for (const item of hierarchy.classes) {
    const isRoot: boolean = item.parent === undefined;
    const existing: ModelPlan | undefined = context.plans.get(item.name);
    const concrete: boolean =
      existing !== undefined &&
      modelOf(context.schema, item.name) !== undefined;
    let plan: ModelPlan;
    if (existing !== undefined && concrete) {
      plan = existing;
      // A table keeps what the class declares and what no class declares (the columns of a normalized schema); the
      // columns of its superclasses are inherited.
      const inherited: Set<string> = new Set();
      for (
        let up: IrHierarchyClass | undefined = hierarchy.classes.find(
          (candidate: IrHierarchyClass) => candidate.name === item.parent
        );
        up !== undefined;
        up = hierarchy.classes.find(
          (candidate: IrHierarchyClass) => candidate.name === up?.parent
        )
      ) {
        for (const field of up.fields) {
          inherited.add(existing.fieldNames.get(field) ?? '');
        }
        for (const relation of up.relations) {
          inherited.add(existing.relationNames.get(relation) ?? '');
        }
      }
      plan.attributes = plan.attributes.filter(
        (attribute: Attribute) => !inherited.has(attribute.name)
      );
    } else {
      // A class without a table holds what it declares, taken from a table that contains it.
      const source: ModelPlan | undefined = holder(item);
      if (source === undefined) {
        continue;
      }
      plan = newPlan(context, item.name, source.model);
      plan.isAbstract = true;
      plan.classAnnotations.push(
        annotation(plan.imports.persistence('Entity'))
      );
      plan.attributes = declared.get(item.name) ?? [];
      output.extraPlans.push(plan);
    }
    classPlans.set(item.name, plan);
    if (isRoot) {
      const imports: Imports = plan.imports;
      const inheritance: AnnotationNode = annotation(
        imports.persistence('Inheritance'),
        [
          [
            'strategy',
            `${imports.persistence('InheritanceType')}.TABLE_PER_CLASS`,
          ],
        ]
      );
      if (concrete) {
        output.rootAnnotations.set(item.name, [inheritance]);
      } else {
        plan.classAnnotations.push(inheritance);
      }
      useSequenceKey(plan, context.warn, item.name);
    }
  }
  for (const item of hierarchy.classes) {
    const plan: ModelPlan | undefined = classPlans.get(item.name);
    const parent: ModelPlan | undefined =
      item.parent === undefined ? undefined : classPlans.get(item.parent);
    if (plan !== undefined && parent !== undefined) {
      plan.extendsClass = parent.className;
    }
  }
}

/** Hibernate cannot generate keys with an identity column in a table-per-class hierarchy (the root's key is shared). */
function useSequenceKey(
  plan: ModelPlan,
  warn: (message: string) => void,
  name: string
): void {
  for (const attribute of plan.attributes) {
    for (const node of attribute.annotations) {
      if (node.name !== 'GeneratedValue') {
        continue;
      }
      node.args = node.args.map(
        ([key, value]): [string | undefined, typeof value] =>
          key === 'strategy' &&
          typeof value === 'string' &&
          value.endsWith('.IDENTITY')
            ? [key, value.replace(/\.IDENTITY$/, '.SEQUENCE')]
            : [key, value]
      );
      warn(
        `${name}: an identity column cannot generate the key of a table-per-class hierarchy, so the key of ${attribute.name} uses GenerationType.SEQUENCE.`
      );
    }
  }
}
