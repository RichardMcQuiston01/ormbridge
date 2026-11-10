import type { JpaAttribute, JpaModelPlan, JpaPlanned } from 'ormbridge';

/**
 * One Spring Data repository per entity (`interface PostRepository extends JpaRepository<Post, Long>`), in the
 * `repository` package next to the entities, and the `@EnableJpaAuditing` configuration class when an entity is audited.
 */

const BOXED: ReadonlyMap<string, string> = new Map<string, string>([
  ['int', 'Integer'],
  ['long', 'Long'],
  ['short', 'Short'],
  ['byte', 'Byte'],
  ['boolean', 'Boolean'],
  ['double', 'Double'],
  ['float', 'Float'],
  ['char', 'Character'],
]);

const JAVA_LANG: ReadonlySet<string> = new Set<string>([
  'String',
  'Integer',
  'Long',
  'Short',
  'Byte',
  'Boolean',
  'Double',
  'Float',
  'Character',
]);

type Language = 'java' | 'kotlin';

/** The type of an identifier and the class to import for it (none for `Long`, `String` and the other `java.lang` types). */
export interface IdentifierType {
  type: string;
  importName?: string;
}

/** The type of the identifier of an entity: its key class, its `@Id` attribute, or the one of the class it extends. */
export function identifierType(
  plan: JpaModelPlan,
  plans: ReadonlyMap<string, JpaModelPlan>,
  packageName: string,
  depth: number = 0
): IdentifierType | undefined {
  if (depth > 8) {
    return undefined;
  }
  if (plan.idClass !== undefined) {
    return {
      type: plan.idClass.name,
      importName: `${packageName}.${plan.idClass.name}`,
    };
  }
  const key: JpaAttribute | undefined = plan.attributes.find(
    (attribute: JpaAttribute) =>
      attribute.annotations.some(
        (node) => node.name === 'Id' || node.name === 'EmbeddedId'
      )
  );
  if (key !== undefined) {
    const target: JpaModelPlan | undefined = plans.get(key.type);
    // A derived identity (`@Id @OneToOne`) has the identifier of the entity it points at.
    if (target !== undefined) {
      return identifierType(target, plans, packageName, depth + 1);
    }
    const type: string = BOXED.get(key.type) ?? key.type;
    const imported: string | undefined = key.imports
      .lines()
      .map((line: string): string => line.replace(/^import |;$/g, ''))
      .find((name: string) => name.endsWith(`.${type}`));
    // A type that is neither imported nor from java.lang is a class of the model's package (an enum).
    const importName: string | undefined =
      imported ?? (JAVA_LANG.has(type) ? undefined : `${packageName}.${type}`);
    return {
      type,
      ...(importName === undefined ? {} : { importName }),
    };
  }
  const parent: JpaModelPlan | undefined =
    plan.extendsClass === undefined ? undefined : plans.get(plan.extendsClass);
  return parent === undefined
    ? undefined
    : identifierType(parent, plans, packageName, depth + 1);
}

/** The import lines of a repository: the entity, the identifier's class when it needs one, and `JpaRepository`. */
function importsOf(
  packageName: string,
  entity: string,
  identifier: IdentifierType,
  terminator: string
): string {
  return [
    `${packageName}.${entity}`,
    ...(identifier.importName === undefined ? [] : [identifier.importName]),
    'org.springframework.data.jpa.repository.JpaRepository',
  ]
    .sort()
    .map((name: string) => `import ${name}${terminator}`)
    .join('\n');
}

function javaRepository(
  packageName: string,
  entity: string,
  identifier: IdentifierType,
  header: string
): string {
  return `${header}package ${packageName}.repository;

${importsOf(packageName, entity, identifier, ';')}

public interface ${entity}Repository extends JpaRepository<${entity}, ${identifier.type}> {}
`;
}

/** The Kotlin names of the boxed Java types an identifier can have. */
const KOTLIN_IDENTIFIERS: ReadonlyMap<string, string> = new Map<string, string>(
  [
    ['Integer', 'Int'],
    ['Character', 'Char'],
  ]
);

function kotlinRepository(
  packageName: string,
  entity: string,
  identifier: IdentifierType,
  header: string
): string {
  const kotlinIdentifier: string =
    KOTLIN_IDENTIFIERS.get(identifier.type) ?? identifier.type;
  return `${header}package ${packageName}.repository

${importsOf(packageName, entity, identifier, '')}

interface ${entity}Repository : JpaRepository<${entity}, ${kotlinIdentifier}>
`;
}

function auditingConfiguration(
  packageName: string,
  language: Language,
  header: string
): string {
  return language === 'java'
    ? `${header}package ${packageName};

import org.springframework.context.annotation.Configuration;
import org.springframework.data.jpa.repository.config.EnableJpaAuditing;

@Configuration
@EnableJpaAuditing
public class JpaAuditingConfig {}
`
    : `${header}package ${packageName}

import org.springframework.context.annotation.Configuration
import org.springframework.data.jpa.repository.config.EnableJpaAuditing

@Configuration
@EnableJpaAuditing
class JpaAuditingConfig
`;
}

/** The files to add: a repository for every entity that has an identifier, and the auditing configuration. */
export function repositoryFiles(
  planned: JpaPlanned,
  language: Language,
  audited: boolean,
  warn: (message: string) => void
): Record<string, string> {
  const packageName: string = planned.layout.packageName;
  const folder: string = packageName.replace(/\./g, '/');
  const header: string = planned.layout.header
    ? '// <auto-generated>\n// Generated by ormbridge. Review the output before use.\n// </auto-generated>\n'
    : '';
  const plans: Map<string, JpaModelPlan> = new Map(
    planned.plans.map((plan: JpaModelPlan) => [plan.className, plan])
  );
  const files: Record<string, string> = {};
  for (const plan of planned.plans) {
    if (plan.isAbstract === true) {
      continue;
    }
    const identifier: IdentifierType | undefined = identifierType(
      plan,
      plans,
      packageName
    );
    if (identifier === undefined) {
      warn(
        `${plan.className}: the entity has no identifier, so no repository was written for it.`
      );
      continue;
    }
    const render = language === 'java' ? javaRepository : kotlinRepository;
    files[
      `${folder}/repository/${plan.className}Repository${planned.extension}`
    ] = `${render(packageName, plan.className, identifier, header)}`;
  }
  if (audited) {
    files[`${folder}/JpaAuditingConfig${planned.extension}`] =
      auditingConfiguration(packageName, language, header);
  }
  return files;
}
