import {
  loadGrammarParser,
  parseJpa,
  type IrSchema,
  type JpaParseOptions,
  type JpaSourceFile,
  type Result,
} from 'ormbridge';
import Parser from 'web-tree-sitter';
import { splitTopLevel } from './kotlinSplit.js';
import { kotlinToJava } from './kotlinToJava.js';

function getKotlinParser(): Promise<Result<Parser>> {
  return loadGrammarParser('kotlin', 'Kotlin', import.meta.url);
}

/** Kotlin test sources, build output and scripts are not the model. */
const SKIPPED_PATH: RegExp =
  /(?:^|[\\/])(?:build|out|\.gradle|node_modules|\.git)[\\/]|(?:^|[\\/])src[\\/](?:test|androidTest)[\\/]|\.kts$|(?:Tests?)\.kt$/;

/** True for Kotlin files that are not the model: build output, tests and Gradle scripts. */
export function isSkippedKotlinPath(path: string): boolean {
  return SKIPPED_PATH.test(path);
}

/**
 * Reads Kotlin entities (Hibernate / JPA, Spring Data JPA) into the shared IR. Each file is parsed with the
 * tree-sitter Kotlin grammar and rewritten as the Java text of the same entities, which the JPA reader then reads, so
 * Kotlin and Java entities follow the same rules. Only the source is read: nothing is compiled.
 */
export async function parseKotlin(
  sources: readonly JpaSourceFile[],
  options: JpaParseOptions
): Promise<Result<IrSchema>> {
  const parserResult: Result<Parser> = await getKotlinParser();
  if (!parserResult.ok) {
    return parserResult;
  }
  const warnings: string[] = [];
  const javaSources: JpaSourceFile[] = [];
  for (const source of sources) {
    if (isSkippedKotlinPath(source.path)) {
      warnings.push(
        `${source.path}: skipped (build output, tests and Gradle scripts are not the model).`
      );
      continue;
    }
    const trees: Parser.Tree[] = splitTopLevel(source.text).map(
      (chunk: string): Parser.Tree => parserResult.value.parse(chunk)
    );
    try {
      if (trees.some((tree: Parser.Tree) => tree.rootNode.hasError)) {
        warnings.push(
          `${source.path}: the file contains Kotlin syntax errors; some classes or properties may be missing from the output.`
        );
      }
      javaSources.push({
        path: source.path,
        text: kotlinToJava(trees.map((tree: Parser.Tree) => tree.rootNode)),
      });
    } finally {
      for (const tree of trees) {
        tree.delete();
      }
    }
  }
  const parsed: Result<IrSchema> = await parseJpa(javaSources, options);
  if (!parsed.ok) {
    return parsed.error.code === 'NO_MODELS_FOUND'
      ? {
          ok: false,
          error: {
            code: 'NO_MODELS_FOUND',
            message:
              `No JPA entities were found in: ${sources.map((source: JpaSourceFile) => source.path).join(', ')}. ` +
              `An entity is a Kotlin class annotated with @Entity (jakarta.persistence or javax.persistence). ` +
              `Mapping in orm.xml or persistence.xml is not read.`,
          },
        }
      : parsed;
  }
  return {
    ok: true,
    value: {
      ...parsed.value,
      warnings: [...warnings, ...parsed.value.warnings],
    },
  };
}
