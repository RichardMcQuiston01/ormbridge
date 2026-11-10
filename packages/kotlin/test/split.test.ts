import { describe, expect, it } from 'vitest';
import { splitTopLevel } from '../src/kotlinSplit.js';

describe('splitTopLevel', () => {
  it('puts the package and imports in a header of their own', () => {
    const chunks: string[] = splitTopLevel(
      'package a\n\nimport b.C\nimport d.*\n\nclass One {\n  var x = 1\n}\n\nclass Two\n'
    );
    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toContain('import d.*');
    expect(chunks[1]).toContain('class One');
    expect(chunks[2]).toContain('class Two');
  });

  it('keeps the annotations, even over several lines, with their class', () => {
    const chunks: string[] = splitTopLevel(
      [
        'package a',
        '@Entity',
        '@Table(',
        '    name = "t",',
        '    indexes = [Index(columnList = "c")],',
        ')',
        'class One {',
        '}',
        '@Entity class Two',
        '',
      ].join('\n')
    );
    expect(chunks).toHaveLength(3);
    expect(chunks[1]).toContain('@Entity');
    expect(chunks[1]).toContain('class One');
    expect(chunks[2]).toBe('@Entity class Two\n');
  });

  it('is not misled by braces, keywords and comments inside strings and comments', () => {
    const chunks: string[] = splitTopLevel(
      [
        'package a',
        '/** The `class` doc { */',
        '@Table(name = "class {")',
        'class One {',
        '    // a } in a comment',
        '    var raw = """ } class """',
        "    var c = '}'",
        '}',
        'class Two',
      ].join('\n')
    );
    expect(chunks).toHaveLength(3);
    expect(chunks[1]).toContain('var c');
    expect(chunks[2]).toContain('class Two');
  });

  it('returns the one chunk of a file without declarations', () => {
    expect(splitTopLevel('package a\nimport b.C\n')).toEqual([
      'package a\nimport b.C\n',
    ]);
  });
});
