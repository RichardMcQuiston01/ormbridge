/**
 * A small static SQL tokenizer and token cursor for the DDL parser.
 *
 * `tree-sitter-wasms` ships no SQL grammar, so DDL is read with this scanner and the recursive-descent
 * statement parser in `sqlDdl.ts`. Nothing here executes or evaluates SQL, nothing recurses (so deeply
 * nested input cannot overflow the stack) and every loop advances, so any input is scanned in linear time.
 */

export type SqlDialect = 'postgresql' | 'mysql' | 'sqlite' | 'sqlserver';

export const SQL_DIALECTS: readonly SqlDialect[] = [
  'postgresql',
  'mysql',
  'sqlite',
  'sqlserver',
];

export type TokenKind =
  'word' | 'ident' | 'string' | 'number' | 'punct' | 'semi';

export interface Token {
  kind: TokenKind;
  /** The token as written (quotes included). */
  text: string;
  /** Identifier or string content without quotes or escapes; the word itself otherwise. */
  value: string;
  /** Upper-case form of a `word`; empty for every other kind. */
  up: string;
  /** Offset of the first character in the source text. */
  start: number;
  /** Offset just after the last character. */
  end: number;
  line: number;
}

/** Returned by the cursor when it reads past the end, so callers never see `undefined`. */
export const END_TOKEN: Token = {
  kind: 'punct',
  text: '',
  value: '',
  up: '',
  start: 0,
  end: 0,
  line: 0,
};

/** Hard limits that keep hostile input from exhausting memory. */
export const MAX_SOURCE_CHARACTERS: number = 32_000_000;
export const MAX_TOKENS: number = 6_000_000;

export interface TokenizeResult {
  tokens: Token[];
  /** True when the token limit was reached and the rest of the text was ignored. */
  truncated: boolean;
}

/**
 * Every unclosed dollar tag costs one scan to the end of the text, so after this many distinct ones the
 * remaining `$tag$` openers are read as punctuation (a real script has a handful of tags at most).
 */
const MAX_FAILED_DOLLAR_TAGS: number = 16;

const BACKSLASH_ESCAPES: Readonly<Record<string, string>> = {
  n: '\n',
  t: '\t',
  r: '\r',
  '0': '\0',
  b: '\b',
  Z: '\x1a',
};

function isWordStart(code: number): boolean {
  return (
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    code === 95 ||
    code > 127
  );
}

function isWordPart(code: number): boolean {
  return isWordStart(code) || (code >= 48 && code <= 57) || code === 36;
}

function isDigit(code: number): boolean {
  return code >= 48 && code <= 57;
}

/**
 * Splits SQL text into tokens. Comments are dropped. Statement terminators become `semi` tokens: `;`, the
 * custom `DELIMITER` of a MySQL dump, and the `GO` batch separator of SQL Server. Quoting follows the dialect:
 * `"x"` and `[x]` are identifiers in SQL Server, `"x"` is a string in MySQL, `$tag$ ... $tag$` is a string in
 * PostgreSQL. Row data of `COPY ... FROM stdin` blocks is skipped.
 */
export function tokenize(text: string, dialect: SqlDialect): TokenizeResult {
  const tokens: Token[] = [];
  const length: number = text.length;
  const failedDollarTags: Set<string> = new Set<string>();
  let delimiter: string = ';';
  let index: number = 0;
  let line: number = 1;
  let atLineStart: boolean = true;
  let statementStart: number = 0;
  let truncated: boolean = false;

  const push = (
    kind: TokenKind,
    start: number,
    end: number,
    startLine: number,
    value: string
  ): void => {
    const sourceText: string = text.slice(start, end);
    tokens.push({
      kind,
      text: sourceText,
      value,
      up: kind === 'word' ? value.toUpperCase() : '',
      start,
      end,
      line: startLine,
    });
    atLineStart = false;
  };

  /** Scans a quoted run that ends at `quote`, where a doubled quote is an escaped quote. */
  const scanQuoted = (
    from: number,
    quote: string,
    backslash: boolean
  ): { end: number; value: string; lines: number } => {
    let position: number = from + 1;
    let value: string = '';
    let chunkStart: number = position;
    let lines: number = 0;
    while (position < length) {
      const character: string = text.charAt(position);
      if (character === '\n') {
        lines += 1;
      }
      if (backslash && character === '\\' && position + 1 < length) {
        value += text.slice(chunkStart, position);
        const escaped: string = text.charAt(position + 1);
        if (escaped === '\n') {
          lines += 1;
        }
        value += BACKSLASH_ESCAPES[escaped] ?? escaped;
        position += 2;
        chunkStart = position;
        continue;
      }
      if (character === quote) {
        if (text.charAt(position + 1) === quote) {
          value += text.slice(chunkStart, position + 1);
          position += 2;
          chunkStart = position;
          continue;
        }
        value += text.slice(chunkStart, position);
        return { end: position + 1, value, lines };
      }
      position += 1;
    }
    value += text.slice(chunkStart, length);
    return { end: length, value, lines };
  };

  while (index < length) {
    if (tokens.length >= MAX_TOKENS) {
      truncated = true;
      break;
    }
    const code: number = text.charCodeAt(index);

    if (code === 10) {
      line += 1;
      index += 1;
      atLineStart = true;
      continue;
    }
    if (
      code === 32 ||
      code === 9 ||
      code === 13 ||
      code === 12 ||
      code === 0xfeff ||
      code === 0xa0
    ) {
      index += 1;
      continue;
    }

    // Comments.
    if (code === 45 && text.charCodeAt(index + 1) === 45) {
      const newline: number = text.indexOf('\n', index);
      index = newline === -1 ? length : newline;
      continue;
    }
    if (code === 35 && dialect === 'mysql') {
      const newline: number = text.indexOf('\n', index);
      index = newline === -1 ? length : newline;
      continue;
    }
    if (code === 47 && text.charCodeAt(index + 1) === 42) {
      const nested: boolean =
        dialect === 'postgresql' || dialect === 'sqlserver';
      let depth: number = 1;
      let position: number = index + 2;
      while (position < length && depth > 0) {
        const current: number = text.charCodeAt(position);
        if (current === 10) {
          line += 1;
        } else if (current === 42 && text.charCodeAt(position + 1) === 47) {
          depth -= 1;
          position += 1;
        } else if (
          nested &&
          current === 47 &&
          text.charCodeAt(position + 1) === 42
        ) {
          depth += 1;
          position += 1;
        }
        position += 1;
      }
      index = position;
      continue;
    }

    // psql meta commands (`\connect db`) occupy a whole line.
    if (code === 92 && atLineStart && dialect === 'postgresql') {
      const newline: number = text.indexOf('\n', index);
      index = newline === -1 ? length : newline;
      continue;
    }

    // A custom statement delimiter (MySQL `DELIMITER //`).
    if (
      delimiter !== ';' &&
      text.startsWith(delimiter, index) &&
      delimiter.length > 0
    ) {
      push('semi', index, index + delimiter.length, line, delimiter);
      index += delimiter.length;
      statementStart = tokens.length;
      continue;
    }

    const startLine: number = line;

    // Strings.
    if (code === 39) {
      const scanned = scanQuoted(index, "'", dialect === 'mysql');
      push('string', index, scanned.end, startLine, scanned.value);
      line += scanned.lines;
      index = scanned.end;
      continue;
    }

    // Quoted identifiers.
    if (code === 34) {
      const scanned = scanQuoted(index, '"', dialect === 'mysql');
      push(
        dialect === 'mysql' ? 'string' : 'ident',
        index,
        scanned.end,
        startLine,
        scanned.value
      );
      line += scanned.lines;
      index = scanned.end;
      continue;
    }
    if (code === 96) {
      const scanned = scanQuoted(index, '`', false);
      push('ident', index, scanned.end, startLine, scanned.value);
      line += scanned.lines;
      index = scanned.end;
      continue;
    }
    if (code === 91 && (dialect === 'sqlserver' || dialect === 'sqlite')) {
      let position: number = index + 1;
      let value: string = '';
      let closed: boolean = false;
      const limit: number = Math.min(length, index + 258);
      while (position < limit) {
        const character: string = text.charAt(position);
        if (character === ']') {
          if (text.charAt(position + 1) === ']') {
            value += ']';
            position += 2;
            continue;
          }
          closed = true;
          break;
        }
        if (character === '\n') {
          break;
        }
        value += character;
        position += 1;
      }
      if (closed && value.length > 0) {
        push('ident', index, position + 1, startLine, value);
        index = position + 1;
        continue;
      }
    }

    // Dollar quoting and positional parameters (PostgreSQL).
    if (code === 36 && dialect === 'postgresql') {
      let position: number = index + 1;
      while (
        position < length &&
        text.charCodeAt(position) !== 36 &&
        isWordPart(text.charCodeAt(position))
      ) {
        position += 1;
      }
      if (position > index + 1 && isDigit(text.charCodeAt(index + 1))) {
        push('word', index, position, startLine, text.slice(index, position));
        index = position;
        continue;
      }
      if (text.charCodeAt(position) === 36) {
        const tag: string = text.slice(index, position + 1);
        if (
          !tag.slice(1, -1).includes('$') &&
          !failedDollarTags.has(tag) &&
          failedDollarTags.size < MAX_FAILED_DOLLAR_TAGS
        ) {
          const close: number = text.indexOf(tag, position + 1);
          if (close === -1) {
            failedDollarTags.add(tag);
          } else {
            const body: string = text.slice(position + 1, close);
            push('string', index, close + tag.length, startLine, body);
            for (let at: number = 0; at < body.length; at += 1) {
              if (body.charCodeAt(at) === 10) {
                line += 1;
              }
            }
            index = close + tag.length;
            continue;
          }
        }
      }
    }

    // Numbers.
    if (isDigit(code) || (code === 46 && isDigit(text.charCodeAt(index + 1)))) {
      let position: number = index;
      if (
        code === 48 &&
        (text.charCodeAt(index + 1) | 32) === 120 &&
        index + 2 < length
      ) {
        position = index + 2;
        while (position < length && /[0-9a-fA-F]/.test(text.charAt(position))) {
          position += 1;
        }
      } else {
        while (position < length && isDigit(text.charCodeAt(position))) {
          position += 1;
        }
        if (text.charCodeAt(position) === 46) {
          position += 1;
          while (position < length && isDigit(text.charCodeAt(position))) {
            position += 1;
          }
        }
        if ((text.charCodeAt(position) | 32) === 101) {
          let exponent: number = position + 1;
          const sign: number = text.charCodeAt(exponent);
          if (sign === 43 || sign === 45) {
            exponent += 1;
          }
          if (isDigit(text.charCodeAt(exponent))) {
            while (exponent < length && isDigit(text.charCodeAt(exponent))) {
              exponent += 1;
            }
            position = exponent;
          }
        }
      }
      push('number', index, position, startLine, text.slice(index, position));
      index = position;
      continue;
    }

    // Words (keywords and unquoted identifiers).
    if (
      isWordStart(code) ||
      (code === 64 && (dialect === 'sqlserver' || dialect === 'mysql')) ||
      (code === 35 && dialect === 'sqlserver')
    ) {
      let position: number = index + 1;
      while (position < length) {
        const current: number = text.charCodeAt(position);
        if (isWordPart(current) || current === 64 || current === 35) {
          position += 1;
        } else {
          break;
        }
      }
      const word: string = text.slice(index, position);
      const next: number = text.charCodeAt(position);

      // Prefixed strings: E'..' (backslash escapes), N'..', B'..', X'..'.
      if (next === 39 && word.length === 1 && /[EeNnBbXx]/.test(word)) {
        const scanned = scanQuoted(
          position,
          "'",
          dialect === 'mysql' || word === 'E' || word === 'e'
        );
        push('string', index, scanned.end, startLine, scanned.value);
        line += scanned.lines;
        index = scanned.end;
        continue;
      }

      // SQL Server batch separator: GO on a line of its own.
      if (
        dialect === 'sqlserver' &&
        atLineStart &&
        word.toUpperCase() === 'GO'
      ) {
        let rest: number = position;
        while (
          rest < length &&
          text.charCodeAt(rest) !== 10 &&
          /[ \t\r0-9]/.test(text.charAt(rest))
        ) {
          rest += 1;
        }
        if (rest >= length || text.charCodeAt(rest) === 10) {
          push('semi', index, position, startLine, 'GO');
          index = rest;
          statementStart = tokens.length;
          continue;
        }
      }

      // MySQL DELIMITER command.
      if (
        dialect === 'mysql' &&
        atLineStart &&
        word.toUpperCase() === 'DELIMITER'
      ) {
        const newline: number = text.indexOf('\n', position);
        const lineEnd: number = newline === -1 ? length : newline;
        const argument: string = text.slice(position, lineEnd).trim();
        const firstSpace: number = argument.search(/\s/);
        delimiter =
          argument === ''
            ? ';'
            : firstSpace === -1
              ? argument
              : argument.slice(0, firstSpace);
        index = lineEnd;
        continue;
      }

      push('word', index, position, startLine, word);
      index = position;
      continue;
    }

    // Statement terminator.
    if (code === 59) {
      push('semi', index, index + 1, startLine, ';');
      index += 1;
      const first: Token | undefined = tokens[statementStart];
      if (
        dialect === 'postgresql' &&
        first !== undefined &&
        first.up === 'COPY'
      ) {
        let readsStdin: boolean = false;
        for (let at: number = statementStart; at < tokens.length; at += 1) {
          if (tokens[at]?.up === 'STDIN') {
            readsStdin = true;
            break;
          }
        }
        if (readsStdin) {
          // Skip the data rows, up to the line that holds only `\.`.
          let position: number = index;
          let found: boolean = false;
          while (position < length) {
            const newline: number = text.indexOf('\n', position);
            const lineEnd: number = newline === -1 ? length : newline;
            if (text.slice(position, lineEnd).trim() === '\\.') {
              index = Math.min(length, lineEnd + 1);
              line += 1;
              found = true;
              break;
            }
            line += 1;
            position = lineEnd + 1;
          }
          if (!found) {
            index = length;
          }
          atLineStart = true;
        }
      }
      statementStart = tokens.length;
      continue;
    }

    // Everything else is punctuation; `::` is one token.
    if (code === 58 && text.charCodeAt(index + 1) === 58) {
      push('punct', index, index + 2, startLine, '::');
      index += 2;
      continue;
    }
    push('punct', index, index + 1, startLine, text.charAt(index));
    index += 1;
  }

  return { tokens, truncated };
}

/** Words that open a routine whose body can contain `;` before the closing `END`. */
const ROUTINE_KINDS: ReadonlySet<string> = new Set([
  'TRIGGER',
  'PROCEDURE',
  'FUNCTION',
  'EVENT',
]);

/** Splits a token list into statements at `semi` tokens, keeping `BEGIN ... END` routine bodies whole. */
export function splitStatements(tokens: readonly Token[]): Token[][] {
  const statements: Token[][] = [];
  let current: Token[] = [];
  let isRoutine: boolean = false;
  let depth: number = 0;
  for (let at: number = 0; at < tokens.length; at += 1) {
    const token: Token | undefined = tokens[at];
    if (token === undefined) {
      break;
    }
    if (token.kind === 'semi') {
      if (isRoutine && depth > 0) {
        current.push({ ...token, kind: 'punct' });
        continue;
      }
      if (current.length > 0) {
        statements.push(current);
      }
      current = [];
      isRoutine = false;
      depth = 0;
      continue;
    }
    current.push(token);
    if (
      current.length <= 12 &&
      token.up !== '' &&
      ROUTINE_KINDS.has(token.up)
    ) {
      if ((current[0]?.up ?? '') === 'CREATE') {
        isRoutine = true;
      }
    }
    if (isRoutine && token.kind === 'word') {
      if (token.up === 'BEGIN' || token.up === 'CASE') {
        depth += 1;
      } else if (token.up === 'END') {
        const following: string = tokens[at + 1]?.up ?? '';
        if (
          following === 'IF' ||
          following === 'LOOP' ||
          following === 'WHILE' ||
          following === 'REPEAT' ||
          following === 'FOR'
        ) {
          at += 1;
          current.push(tokens[at] ?? END_TOKEN);
        } else if (depth > 0) {
          depth -= 1;
          if (following === 'CASE') {
            at += 1;
            current.push(tokens[at] ?? END_TOKEN);
          }
        }
      }
    }
  }
  if (current.length > 0) {
    statements.push(current);
  }
  return statements;
}

/**
 * Guesses the dialect of a file from characteristic syntax. Every pattern is a simple linear regular
 * expression. Ties and files without any hint are read as PostgreSQL.
 */
export function detectDialect(text: string): SqlDialect {
  const score = (patterns: RegExp[]): number =>
    patterns.reduce(
      (total: number, pattern: RegExp): number =>
        total + (pattern.test(text) ? 1 : 0),
      0
    );
  const scores: Record<SqlDialect, number> = {
    sqlserver: score([
      /\bIDENTITY\s*\(\s*\d+\s*,\s*\d+\s*\)/i,
      /^\s*GO\s*$/im,
      /\bn?varchar\s*\(\s*max\s*\)/i,
      /\bNVARCHAR\b/i,
      /\bUNIQUEIDENTIFIER\b/i,
      /\bDATETIME2\b/i,
      /\bNONCLUSTERED\b/i,
      /\bCLUSTERED\b/i,
      /\bSET\s+ANSI_NULLS\b/i,
      /\[dbo\]/i,
      /\bGETDATE\s*\(/i,
      /\bNEWID\s*\(/i,
    ]),
    mysql: score([
      /`/,
      /\bENGINE\s*=/i,
      /\bAUTO_INCREMENT\b/i,
      /\bUNSIGNED\b/i,
      /\bDEFAULT\s+CHARSET\b/i,
      /\bCHARACTER\s+SET\b/i,
      /\bLOCK\s+TABLES\b/i,
      /\bON\s+UPDATE\s+CURRENT_TIMESTAMP\b/i,
      /\bTINYINT\b/i,
      /\bDELIMITER\b/i,
      /\bUNLOCK\s+TABLES\b/i,
      /\bMEDIUMTEXT\b|\bLONGTEXT\b/i,
    ]),
    sqlite: score([
      /\bAUTOINCREMENT\b/i,
      /\bWITHOUT\s+ROWID\b/i,
      /\bPRAGMA\b/i,
      /\bsqlite_/i,
      /\bdatetime\s*\(\s*'now'/i,
      /\bSTRICT\s*;/i,
    ]),
    postgresql: score([
      /\bBIGSERIAL\b|\bSERIAL\b|\bSMALLSERIAL\b/i,
      /::\s*[a-z_]/i,
      /\bAS\s+ENUM\b/i,
      /\bgen_random_uuid\s*\(/i,
      /\$\$/,
      /\bTIMESTAMPTZ\b/i,
      /\bJSONB\b/i,
      /\bGENERATED\s+(ALWAYS|BY\s+DEFAULT)\s+AS\s+IDENTITY\b/i,
      /\bCOMMENT\s+ON\b/i,
      /\bnextval\s*\(/i,
      /\bSET\s+search_path\b/i,
      /\bCREATE\s+EXTENSION\b/i,
      /\bBYTEA\b/i,
    ]),
  };
  let best: SqlDialect = 'postgresql';
  for (const dialect of ['sqlserver', 'mysql', 'sqlite'] as SqlDialect[]) {
    if (scores[dialect] > scores[best]) {
      best = dialect;
    }
  }
  return best;
}

/**
 * Reads a token list without ever failing: reading past the end gives the end token, so the statement
 * parser needs no bounds checks.
 */
export class Cursor {
  position: number;

  constructor(
    readonly tokens: readonly Token[],
    start: number = 0,
    readonly end: number = tokens.length
  ) {
    this.position = start;
  }

  get atEnd(): boolean {
    return this.position >= this.end;
  }

  peek(offset: number = 0): Token {
    const at: number = this.position + offset;
    if (at >= this.end) {
      return END_TOKEN;
    }
    return this.tokens[at] ?? END_TOKEN;
  }

  next(): Token {
    const token: Token = this.peek();
    if (this.position < this.end) {
      this.position += 1;
    }
    return token;
  }

  /** True when the token at `offset` is the keyword (a plain word, never a quoted identifier). */
  isKeyword(keyword: string, offset: number = 0): boolean {
    const token: Token = this.peek(offset);
    return token.kind === 'word' && token.up === keyword;
  }

  acceptKeyword(keyword: string): boolean {
    if (this.isKeyword(keyword)) {
      this.position += 1;
      return true;
    }
    return false;
  }

  /** Consumes the keywords in order, or nothing when they do not all match. */
  acceptKeywords(...keywords: string[]): boolean {
    for (let at: number = 0; at < keywords.length; at += 1) {
      if (!this.isKeyword(keywords[at] ?? '', at)) {
        return false;
      }
    }
    this.position += keywords.length;
    return true;
  }

  isPunct(character: string, offset: number = 0): boolean {
    const token: Token = this.peek(offset);
    return token.kind === 'punct' && token.text === character;
  }

  acceptPunct(character: string): boolean {
    if (this.isPunct(character)) {
      this.position += 1;
      return true;
    }
    return false;
  }

  /**
   * When the next token is `(`, returns the tokens inside the matching `)` and moves past it. An unclosed
   * group runs to the end. Returns undefined (and moves nowhere) when the next token is not `(`.
   */
  readGroup(): Token[] | undefined {
    if (!this.isPunct('(')) {
      return undefined;
    }
    this.position += 1;
    const inner: Token[] = [];
    let depth: number = 1;
    while (this.position < this.end) {
      const token: Token = this.tokens[this.position] ?? END_TOKEN;
      this.position += 1;
      if (token.kind === 'punct') {
        if (token.text === '(') {
          depth += 1;
        } else if (token.text === ')') {
          depth -= 1;
          if (depth === 0) {
            return inner;
          }
        }
      }
      inner.push(token);
    }
    return inner;
  }

  /** Skips every remaining token of the current element. */
  skipToEnd(): void {
    this.position = this.end;
  }
}

/** Splits tokens at commas that are not inside parentheses. Empty parts are dropped. */
export function splitTopLevel(tokens: readonly Token[]): Token[][] {
  const parts: Token[][] = [];
  let current: Token[] = [];
  let depth: number = 0;
  for (const token of tokens) {
    if (token.kind === 'punct') {
      if (token.text === '(') {
        depth += 1;
      } else if (token.text === ')') {
        depth = Math.max(0, depth - 1);
      } else if (token.text === ',' && depth === 0) {
        if (current.length > 0) {
          parts.push(current);
        }
        current = [];
        continue;
      }
    }
    current.push(token);
  }
  if (current.length > 0) {
    parts.push(current);
  }
  return parts;
}

/** The source text covered by a token list, with line breaks collapsed. */
export function sourceOf(text: string, tokens: readonly Token[]): string {
  const first: Token | undefined = tokens[0];
  const last: Token | undefined = tokens[tokens.length - 1];
  if (first === undefined || last === undefined) {
    return '';
  }
  return text.slice(first.start, last.end).replace(/\s+/g, ' ').trim();
}
