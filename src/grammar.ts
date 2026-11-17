import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import Parser from 'web-tree-sitter';
import { describeThrown, err, ok, type Result } from './result.js';

/**
 * Finds and loads the tree-sitter grammars (WebAssembly files). A package ships only the grammars it reads, in a
 * `grammars` folder beside its compiled code (`dist/grammars`), so an install does not carry the 50 MB of every
 * grammar that `tree-sitter-wasms` holds. In a checkout, where nothing was copied yet, the grammar is taken from
 * `tree-sitter-wasms`, a development dependency.
 */

const loaded: Map<string, Parser> = new Map<string, Parser>();

/** The file name of a grammar: `java` is `tree-sitter-java.wasm`. */
function fileNameOf(name: string): string {
  return `tree-sitter-${name}.wasm`;
}

/**
 * The path of a grammar file, looked for in this order: the `grammars` folder next to the folder of the calling
 * module (`dist/parsers/x.js` finds `dist/grammars`), the `grammars` folder next to the calling module itself
 * (`dist/index.js` of an addon), then `tree-sitter-wasms`. `from` is the caller's `import.meta.url`. Returns undefined
 * when none has it.
 */
export function locateGrammar(name: string, from: string): string | undefined {
  const file: string = fileNameOf(name);
  for (const relative of [`../grammars/${file}`, `./grammars/${file}`]) {
    const candidate: string = fileURLToPath(new URL(relative, from));
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  try {
    return createRequire(from).resolve(`tree-sitter-wasms/out/${file}`);
  } catch {
    return undefined;
  }
}

/**
 * Loads a grammar once and returns its parser. `label` is the language as people write it (`C#`), used in the error
 * message. A grammar that is missing or cannot be loaded gives a `PARSER_INIT_FAILED` error that names the file.
 */
export async function loadGrammarParser(
  name: string,
  label: string,
  from: string
): Promise<Result<Parser>> {
  try {
    const path: string | undefined = locateGrammar(name, from);
    if (path === undefined) {
      return err(
        'PARSER_INIT_FAILED',
        `Failed to initialize the tree-sitter ${label} grammar: ${fileNameOf(name)} was not found in the "grammars" ` +
          `folder of the package or in "tree-sitter-wasms". Reinstall the package that needs it.`
      );
    }
    const cached: Parser | undefined = loaded.get(path);
    if (cached !== undefined) {
      return ok(cached);
    }
    await Parser.init();
    const language: Parser.Language = await Parser.Language.load(path);
    const parser: Parser = new Parser();
    parser.setLanguage(language);
    loaded.set(path, parser);
    return ok(parser);
  } catch (thrown) {
    return err(
      'PARSER_INIT_FAILED',
      `Failed to initialize the tree-sitter ${label} grammar. Check that the "web-tree-sitter" (0.22.x) package is ` +
        `installed and that ${fileNameOf(name)} is not damaged. Underlying error: ${describeThrown(thrown)}`
    );
  }
}
