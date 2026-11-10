import {
  Imports,
  type AnnotationNode,
  type JpaAttribute,
  type JpaModelPlan,
  type JpaPlanned,
} from 'ormbridge';

/**
 * Spring Data auditing: the timestamps Hibernate fills in (`@CreationTimestamp`, `@UpdateTimestamp`) become the ones
 * Spring fills in (`@CreatedDate`, `@LastModifiedDate`), and each entity that has one gets
 * `@EntityListeners(AuditingEntityListener.class)`.
 */

const REPLACEMENTS: ReadonlyMap<string, string> = new Map<string, string>([
  ['CreationTimestamp', 'org.springframework.data.annotation.CreatedDate'],
  ['UpdateTimestamp', 'org.springframework.data.annotation.LastModifiedDate'],
]);

const LISTENER: string =
  'org.springframework.data.jpa.domain.support.AuditingEntityListener';

/** Changes the plans in place. Returns true when at least one entity is audited (the application then needs `@EnableJpaAuditing`). */
export function applyAuditing(planned: JpaPlanned): boolean {
  let audited: boolean = false;
  for (const plan of planned.plans) {
    if (auditAttributes(plan)) {
      addListener(plan);
      audited = true;
    }
  }
  return audited;
}

function auditAttributes(plan: JpaModelPlan): boolean {
  let changed: boolean = false;
  for (const attribute of plan.attributes) {
    attribute.annotations = attribute.annotations.map(
      (node: AnnotationNode): AnnotationNode => {
        const replacement: string | undefined = REPLACEMENTS.get(node.name);
        if (replacement === undefined) {
          return node;
        }
        changed = true;
        attribute.imports.remove(node.name);
        return { name: simpleName(replacement), args: [] };
      }
    );
    useImports(attribute);
  }
  return changed;
}

function simpleName(fullName: string): string {
  return fullName.slice(fullName.lastIndexOf('.') + 1);
}

/** Imports what the replaced annotations of an attribute need, and drops the Hibernate ones that are no longer used. */
function useImports(attribute: JpaAttribute): void {
  const imports: Imports = attribute.imports;
  for (const [, fullName] of REPLACEMENTS) {
    if (
      attribute.annotations.some(
        (node: AnnotationNode) => node.name === simpleName(fullName)
      )
    ) {
      imports.use(fullName);
    }
  }
}

function addListener(plan: JpaModelPlan): void {
  if (plan.classAnnotations.some((node) => node.name === 'EntityListeners')) {
    return;
  }
  const listener: string = plan.imports.use(LISTENER);
  const annotation: string = plan.imports.persistence('EntityListeners');
  plan.classAnnotations.push({
    name: annotation,
    args: [[undefined, `${listener}.class`]],
  });
}
