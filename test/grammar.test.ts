import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadGrammarParser, locateGrammar } from '../src/grammar.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ormbridge-grammar-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function caller(...segments: string[]): string {
  return pathToFileURL(join(root, ...segments)).href;
}

describe('locateGrammar', () => {
  it('prefers the grammars folder next to the folder of the caller (dist/parsers -> dist/grammars)', () => {
    mkdirSync(join(root, 'grammars'));
    writeFileSync(join(root, 'grammars', 'tree-sitter-fake.wasm'), '');
    expect(locateGrammar('fake', caller('parsers', 'x.js'))).toBe(
      join(root, 'grammars', 'tree-sitter-fake.wasm')
    );
  });

  it('finds the grammars folder next to the caller itself (an addon: dist/index.js -> dist/grammars)', () => {
    mkdirSync(join(root, 'dist', 'grammars'), { recursive: true });
    writeFileSync(join(root, 'dist', 'grammars', 'tree-sitter-fake.wasm'), '');
    expect(locateGrammar('fake', caller('dist', 'index.js'))).toBe(
      join(root, 'dist', 'grammars', 'tree-sitter-fake.wasm')
    );
  });

  it('falls back to tree-sitter-wasms, as in a checkout where nothing was copied', () => {
    const found: string | undefined = locateGrammar(
      'java',
      new URL('../src/parsers/javaSyntax.ts', import.meta.url).href
    );
    expect(found?.endsWith('tree-sitter-java.wasm')).toBe(true);
  });

  it('returns undefined for a grammar nobody has', () => {
    expect(locateGrammar('no-such-language', caller('x.js'))).toBeUndefined();
  });
});

describe('loadGrammarParser', () => {
  it('loads a grammar and gives the same parser again', async () => {
    const from: string = new URL(
      '../src/parsers/javaSyntax.ts',
      import.meta.url
    ).href;
    const first = await loadGrammarParser('java', 'Java', from);
    const second = await loadGrammarParser('java', 'Java', from);
    expect(first.ok && second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(second.value).toBe(first.value);
      expect(first.value.parse('class A {}').rootNode.type).toBe('program');
    }
  });

  it('names the missing file in the error', async () => {
    const result = await loadGrammarParser(
      'no-such-language',
      'Nowhere',
      caller('x.js')
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('PARSER_INIT_FAILED');
      expect(result.error.message).toContain(
        'tree-sitter-no-such-language.wasm'
      );
      expect(result.error.message).toContain('Nowhere grammar');
    }
  });

  it('reports a damaged grammar file with the underlying error', async () => {
    mkdirSync(join(root, 'grammars'));
    writeFileSync(
      join(root, 'grammars', 'tree-sitter-broken.wasm'),
      'not wasm'
    );
    const result = await loadGrammarParser(
      'broken',
      'Broken',
      caller('parsers', 'x.js')
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain('Underlying error');
    }
  });
});
