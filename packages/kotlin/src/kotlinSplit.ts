/**
 * Splits Kotlin source into its top-level declarations. The tree-sitter Kotlin grammar is ambiguous for a file of
 * several declarations: an annotated class that follows a `}` can be read as an annotated expression and a lambda,
 * depending on what comes later in the file, and the class is then lost without an error. Each declaration parsed
 * alone is read correctly, so the reader parses the header (package and imports) and every declaration separately.
 */

const DECLARATION_WORDS: RegExp =
  /\b(?:class|interface|object|fun|val|var|typealias)\b/;

type Mode =
  'code' | 'line-comment' | 'block-comment' | 'string' | 'raw-string' | 'char';

/** The statement without its strings and comments, for deciding what it is. */
function cleaned(statement: string): string {
  return statement
    .replace(/"""[\s\S]*?"""/g, '""')
    .replace(/"(?:\\.|[^"\\\n])*"/g, '""')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
    .trim();
}

/**
 * The text of the header (package, imports) and then of each top-level declaration. A declaration ends at a line end
 * where no bracket, string or comment is open, unless what has been read since the last one is only annotations,
 * which belong to the declaration that follows.
 */
export function splitTopLevel(text: string): string[] {
  const chunks: string[] = [];
  let mode: Mode = 'code';
  let depth: number = 0;
  let chunkStart: number = 0;
  let statementStart: number = 0;
  let inHeader: boolean = true;
  let position: number = 0;
  while (position < text.length) {
    const character: string = text.charAt(position);
    const next: string = text.charAt(position + 1);
    if (mode === 'line-comment') {
      if (character === '\n') {
        mode = 'code';
      }
    } else if (mode === 'block-comment') {
      if (character === '*' && next === '/') {
        mode = 'code';
        position += 1;
      }
    } else if (mode === 'raw-string') {
      if (text.startsWith('"""', position)) {
        mode = 'code';
        position += 2;
      }
    } else if (mode === 'string' || mode === 'char') {
      if (character === '\\') {
        position += 1;
      } else if (
        character === (mode === 'string' ? '"' : "'") ||
        character === '\n'
      ) {
        mode = 'code';
      }
    } else if (character === '/' && next === '/') {
      mode = 'line-comment';
    } else if (character === '/' && next === '*') {
      mode = 'block-comment';
      position += 1;
    } else if (text.startsWith('"""', position)) {
      mode = 'raw-string';
      position += 2;
    } else if (character === '"') {
      mode = 'string';
    } else if (character === "'") {
      mode = 'char';
    } else if (character === '{' || character === '(' || character === '[') {
      depth += 1;
    } else if (character === '}' || character === ')' || character === ']') {
      depth = Math.max(0, depth - 1);
    }
    if (character === '\n' && depth === 0 && mode === 'code') {
      const statement: string = cleaned(text.slice(statementStart, position));
      if (statement === '') {
        // Blank lines and comments between declarations.
        statementStart = position + 1;
      } else if (inHeader && /^(?:package|import)\b/.test(statement)) {
        statementStart = position + 1;
      } else {
        if (inHeader) {
          chunks.push(text.slice(chunkStart, statementStart));
          chunkStart = statementStart;
          inHeader = false;
        }
        const onlyAnnotations: boolean =
          statement.startsWith('@') && !DECLARATION_WORDS.test(statement);
        if (!onlyAnnotations) {
          chunks.push(text.slice(chunkStart, position + 1));
          chunkStart = position + 1;
          statementStart = position + 1;
        }
      }
    }
    position += 1;
  }
  chunks.push(text.slice(chunkStart));
  return chunks.filter((chunk: string) => chunk.trim() !== '');
}
