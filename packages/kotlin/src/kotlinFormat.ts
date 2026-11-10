import {
  jpaEmitOptionsFor,
  ok,
  type FormatAdapter,
  type FormatEmitOutput,
  type FormatOptions,
  type IrSchema,
  type JpaEmitOptions,
  type Result,
  type SourceText,
} from 'ormbridge';
import { isSkippedKotlinPath, parseKotlin } from './kotlinReader.js';
import { emitKotlin } from './kotlinWriter.js';

export const kotlinAdapter: FormatAdapter = {
  name: 'kotlin',
  // ".kt" is claimed: nothing else in ormbridge reads Kotlin.
  extensions: ['.kt'],
  description:
    'Kotlin entities (Hibernate / JPA and Spring Data JPA; jakarta.persistence and javax.persistence annotations; --style javax writes Hibernate 5 entities)',
  input: {
    extensions: ['.kt'],
    description: 'Kotlin (.kt) files with Hibernate / JPA entities',
    skippedDirectories: ['build', 'out', '.gradle'],
    isSkippedFile: isSkippedKotlinPath,
  },
  parse: (
    sources: SourceText[],
    options: FormatOptions
  ): Promise<Result<IrSchema>> =>
    parseKotlin(
      sources.map((source: SourceText) => ({
        path: source.path,
        text: source.text,
      })),
      { appLabel: options.appLabel ?? 'app' }
    ),
  emit: (
    schema: IrSchema,
    options: FormatOptions
  ): Result<FormatEmitOutput> => {
    const emitOptions: Result<JpaEmitOptions> = jpaEmitOptionsFor(options);
    if (!emitOptions.ok) {
      return emitOptions;
    }
    return ok(emitKotlin(schema, withoutExtension(emitOptions.value)));
  },
};

function withoutExtension(options: JpaEmitOptions): JpaEmitOptions {
  const copy: JpaEmitOptions = { ...options };
  delete copy.extension;
  return copy;
}
