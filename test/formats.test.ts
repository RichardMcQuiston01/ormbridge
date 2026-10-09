import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  convertText,
  FORMAT_NAMES,
  type ConvertOptions,
  type ConvertResult,
} from '../src/convert.js';
import {
  describeFormats,
  getFormat,
  getFormatByExtension,
  listFormatNames,
  listFormats,
  registerFormat,
  unregisterFormat,
  type FormatAdapter,
  type SourceText,
} from '../src/formats.js';
import type { Result } from '../src/result.js';
import { DEFAULT_OPTIONS, expectOk } from './helpers.js';

const OUTPUT_ONLY: FormatAdapter = {
  name: 'outonly',
  extensions: ['.outonly'],
  description: 'Output-only test format',
  emit: () => ({ ok: true, value: { text: 'x', warnings: [] } }),
};

const INPUT_ONLY: FormatAdapter = {
  name: 'inonly',
  extensions: ['.inonly'],
  description: 'Input-only test format',
  parse: () =>
    Promise.resolve({
      ok: true,
      value: { models: [], enums: [], warnings: [] },
    }),
};

const SOURCES: SourceText[] = [{ path: 'models.py', text: 'x = 1' }];

afterEach(() => {
  unregisterFormat('outonly');
  unregisterFormat('inonly');
});

describe('format registry lookup', () => {
  it('registers Django, Prisma and TypeORM by default', () => {
    expect(listFormatNames()).toEqual(
      expect.arrayContaining(['django', 'prisma', 'typeorm'])
    );
    expect(FORMAT_NAMES).toEqual(
      expect.arrayContaining(['django', 'prisma', 'typeorm'])
    );
    expect(expectOk(getFormat('django')).parse).toBeDefined();
    expect(expectOk(getFormat('prisma')).emit).toBeDefined();
  });

  it('returns a descriptive error for an unknown name', () => {
    const result: Result<FormatAdapter> = getFormat('nope');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain(
        'Unknown format "nope". Expected one of: django, prisma'
      );
    }
  });

  it('rejects duplicate names and extensions', () => {
    expectOk(registerFormat(OUTPUT_ONLY));
    expect(registerFormat(OUTPUT_ONLY).ok).toBe(false);
    const clash: Result<FormatAdapter> = registerFormat({
      ...INPUT_ONLY,
      extensions: ['.outonly'],
    });
    expect(clash.ok).toBe(false);
    expect(listFormatNames()).not.toContain('inonly');
  });
});

describe('extension inference', () => {
  it('maps extensions to adapters', () => {
    expect(getFormatByExtension('.py')?.name).toBe('django');
    expect(getFormatByExtension('.prisma')?.name).toBe('prisma');
    expect(getFormatByExtension('.txt')).toBeUndefined();
  });

  it('includes extensions of newly registered formats', () => {
    expectOk(registerFormat(OUTPUT_ONLY));
    expect(getFormatByExtension('.outonly')?.name).toBe('outonly');
  });
});

describe('convertText with the registry', () => {
  it('reports an unknown source format', async () => {
    const options: ConvertOptions = { ...DEFAULT_OPTIONS, from: 'nope' };
    const result: Result<ConvertResult> = await convertText(SOURCES, options);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain('Unknown format "nope"');
    }
  });

  it('reports an unknown target format', async () => {
    const options: ConvertOptions = { ...DEFAULT_OPTIONS, to: 'nope' };
    const result: Result<ConvertResult> = await convertText(SOURCES, options);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain('Unknown format "nope"');
    }
  });

  it('rejects an output-only format used as input', async () => {
    expectOk(registerFormat(OUTPUT_ONLY));
    const options: ConvertOptions = { ...DEFAULT_OPTIONS, from: 'outonly' };
    const result: Result<ConvertResult> = await convertText(SOURCES, options);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain(
        'The format "outonly" can only be used as an output'
      );
    }
  });

  it('rejects an input-only format used as output', async () => {
    expectOk(registerFormat(INPUT_ONLY));
    const options: ConvertOptions = { ...DEFAULT_OPTIONS, to: 'inonly' };
    const result: Result<ConvertResult> = await convertText(
      [{ path: 'm.py', text: 'from django.db import models\n' }],
      options
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain(
        'The format "inonly" can only be used as an input'
      );
    }
  });
});

describe('formats command output', () => {
  it('describes each format with extensions and abilities', () => {
    const text: string = describeFormats(listFormats());
    expect(text).toContain(
      'extensions: .py  read + write  Django models (models.py or a models/ package)\n'
    );
    expect(text).toContain(
      'extensions: .prisma  read + write  Prisma schema (schema.prisma)\n'
    );
    expect(text).toMatch(
      /typeorm\s+extensions: \(none\) {2}read \+ write {2}TypeORM entity classes \(TypeScript\)\n/
    );
    expect(text).toMatch(
      /graphene\s+extensions: \(none\) {2}write {2}Graphene \(graphene-django\) GraphQL schema\n/
    );
    expect(text).toMatch(
      /typescript\s+extensions: \(none\) {2}write {2}Plain TypeScript interfaces and enums\n/
    );
    expect(text).toMatch(
      /zod\s+extensions: \(none\) {2}write {2}Zod schemas \(TypeScript, Zod 4\)\n/
    );
  });

  it('marks one-way formats', () => {
    const text: string = describeFormats([OUTPUT_ONLY, INPUT_ONLY]);
    expect(text).toContain('write  Output-only test format');
    expect(text).toContain('read  Input-only test format');
  });

  const cliPath: string = fileURLToPath(
    new URL('../dist/cli.js', import.meta.url)
  );
  it.skipIf(!existsSync(cliPath))('is printed by the built CLI', () => {
    const output: string = execFileSync('node', [cliPath, 'formats'], {
      encoding: 'utf8',
    });
    expect(output).toBe(describeFormats(listFormats()));
  });
});
