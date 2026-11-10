import { emitKotlin, parseKotlin } from 'ormbridge-kotlin';
import {
  emitJpa,
  isSkippedJpaPath,
  jpaEmitOptionsFor,
  ok,
  parseJpa,
  type FormatAdapter,
  type FormatEmitOutput,
  type FormatInput,
  type FormatOptions,
  type IrSchema,
  type JpaEmitOptions,
  type JpaPlanned,
  type Result,
  type SourceText,
} from 'ormbridge';
import { applyAuditing } from './springAuditing.js';
import { repositoryFiles } from './springRepositories.js';

/** Options of the Spring Data writers: those of the JPA writer. */
export type SpringDataEmitOptions = Omit<JpaEmitOptions, 'extension'>;

/** Builds the `adjust` step: Spring auditing annotations, the repositories and the auditing configuration. */
function adjustFor(
  language: 'java' | 'kotlin',
  warnings: string[]
): (planned: JpaPlanned) => Record<string, string> {
  return (planned: JpaPlanned): Record<string, string> => {
    const audited: boolean = applyAuditing(planned);
    return repositoryFiles(planned, language, audited, (message: string) => {
      warnings.push(message);
    });
  };
}

/** Writes Spring Data JPA entities in Java: the JPA output with Spring auditing and one repository per entity. */
export function emitSpringData(
  schema: IrSchema,
  options: SpringDataEmitOptions
): ReturnType<typeof emitJpa> {
  const warnings: string[] = [];
  const result: ReturnType<typeof emitJpa> = emitJpa(schema, {
    ...options,
    extension: { adjust: adjustFor('java', warnings) },
  });
  return { files: result.files, warnings: [...result.warnings, ...warnings] };
}

/** Writes Spring Data JPA entities in Kotlin. */
export function emitSpringDataKotlin(
  schema: IrSchema,
  options: SpringDataEmitOptions
): ReturnType<typeof emitJpa> {
  const warnings: string[] = [];
  const result: ReturnType<typeof emitJpa> = emitKotlin(schema, {
    ...options,
    adjust: adjustFor('kotlin', warnings),
  });
  return { files: result.files, warnings: [...result.warnings, ...warnings] };
}

const JAVA_INPUT: FormatInput = {
  extensions: ['.java'],
  description: 'Java (.java) files with Spring Data JPA / Hibernate entities',
  skippedDirectories: ['target', 'build', 'out', '.gradle'],
  isSkippedFile: isSkippedJpaPath,
};

const KOTLIN_INPUT: FormatInput = {
  extensions: ['.kt'],
  description: 'Kotlin (.kt) files with Spring Data JPA / Hibernate entities',
  skippedDirectories: ['build', 'out', '.gradle'],
  isSkippedFile: (path: string): boolean =>
    /(?:^|[\\/])src[\\/](?:test|androidTest)[\\/]|\.kts$|Tests?\.kt$/.test(
      path
    ),
};

function emitterOptions(options: FormatOptions): Result<SpringDataEmitOptions> {
  const converted: Result<JpaEmitOptions> = jpaEmitOptionsFor(options);
  if (!converted.ok) {
    return converted;
  }
  const copy: JpaEmitOptions = { ...converted.value };
  delete copy.extension;
  return ok(copy);
}

function sourcesOf(sources: SourceText[]): { path: string; text: string }[] {
  return sources.map((source: SourceText) => ({
    path: source.path,
    text: source.text,
  }));
}

export const springDataAdapter: FormatAdapter = {
  name: 'spring-data',
  extensions: [],
  description:
    'Spring Data JPA entities (Java; Hibernate / JPA with @CreatedDate, @LastModifiedDate and @EntityListeners(AuditingEntityListener), a JpaRepository per entity)',
  input: JAVA_INPUT,
  parse: (
    sources: SourceText[],
    options: FormatOptions
  ): Promise<Result<IrSchema>> =>
    parseJpa(sourcesOf(sources), { appLabel: options.appLabel ?? 'app' }),
  emit: (
    schema: IrSchema,
    options: FormatOptions
  ): Result<FormatEmitOutput> => {
    const converted: Result<SpringDataEmitOptions> = emitterOptions(options);
    return converted.ok
      ? ok(emitSpringData(schema, converted.value))
      : converted;
  },
};

export const springDataKotlinAdapter: FormatAdapter = {
  name: 'spring-data-kotlin',
  extensions: [],
  description:
    'Spring Data JPA entities (Kotlin; the same mapping as spring-data, with kotlin-jpa style classes)',
  input: KOTLIN_INPUT,
  parse: (
    sources: SourceText[],
    options: FormatOptions
  ): Promise<Result<IrSchema>> =>
    parseKotlin(sourcesOf(sources), { appLabel: options.appLabel ?? 'app' }),
  emit: (
    schema: IrSchema,
    options: FormatOptions
  ): Result<FormatEmitOutput> => {
    const converted: Result<SpringDataEmitOptions> = emitterOptions(options);
    return converted.ok
      ? ok(emitSpringDataKotlin(schema, converted.value))
      : converted;
  },
};
