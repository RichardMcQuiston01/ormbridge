import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from 'vitest';
import {
  convertText,
  type ConvertOptions,
  type ConvertResult,
} from '../src/convert.js';
import type { SourceText } from '../src/formats.js';
import type { Result } from '../src/result.js';
import {
  CANONICAL_FIXTURES,
  type CanonicalFixture,
} from './fixtures/canonical.js';
import { DEFAULT_OPTIONS, expectOk } from './helpers.js';

const GOLDEN_DIRECTORY: string = fileURLToPath(
  new URL('./golden/', import.meta.url)
);

/** Returns the canonical fixture for a format, or throws a descriptive error. */
export function getCanonicalFixture(format: string): CanonicalFixture {
  const fixture: CanonicalFixture | undefined = CANONICAL_FIXTURES.find(
    (candidate: CanonicalFixture) => candidate.format === format
  );
  if (fixture === undefined) {
    const known: string = CANONICAL_FIXTURES.map(
      (candidate: CanonicalFixture) => candidate.format
    ).join(', ');
    throw new Error(
      `No canonical fixture is registered for the format "${format}". Add one to test/fixtures/canonical.ts. Known: ${known}.`
    );
  }
  return fixture;
}

/** Reads the canonical fixture files for a format as converter input. */
export function loadCanonicalSources(format: string): SourceText[] {
  return getCanonicalFixture(format).paths.map((path: string): SourceText => ({
    path,
    text: readFileSync(path, 'utf8'),
  }));
}

/** Converts the canonical fixture of one format into another. */
export async function convertCanonical(
  from: string,
  to: string,
  overrides: Partial<ConvertOptions> = {}
): Promise<ConvertResult> {
  const result: Result<ConvertResult> = await convertText(
    loadCanonicalSources(from),
    { ...DEFAULT_OPTIONS, ...overrides, from, to }
  );
  return expectOk(result);
}

/**
 * Compares text with a stored golden file in test/golden/. Run the tests with
 * UPDATE_GOLDEN=1 to create or refresh a golden file; review the diff before
 * committing it.
 */
export function expectMatchesGolden(name: string, actual: string): void {
  const goldenPath: string = `${GOLDEN_DIRECTORY}${name}`;
  if (process.env.UPDATE_GOLDEN === '1') {
    mkdirSync(dirname(goldenPath), { recursive: true });
    writeFileSync(goldenPath, actual);
    return;
  }
  if (!existsSync(goldenPath)) {
    throw new Error(
      `Golden file test/golden/${name} does not exist. Run the tests with UPDATE_GOLDEN=1 to create it.`
    );
  }
  expect(actual).toBe(readFileSync(goldenPath, 'utf8'));
}

/** All relative file paths below a directory, with forward slashes, sorted. */
function listFilesRecursively(directory: string): string[] {
  const found: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current).sort()) {
      const full: string = join(current, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
      } else {
        found.push(relative(directory, full).split(sep).join('/'));
      }
    }
  };
  if (existsSync(directory)) {
    walk(directory);
  }
  return found.sort();
}

/**
 * Compares a file map (the output of a multi-file emitter) with the golden
 * directory test/golden/<name>/, which holds one golden file per generated
 * file at the same relative path. Files that were added or removed are
 * reported by name. With UPDATE_GOLDEN=1 the directory is rewritten from
 * scratch, so goldens of files that are no longer generated disappear.
 * `goldenRoot` exists so the harness itself can be tested in a temp directory.
 */
export function expectFilesMatchGolden(
  name: string,
  files: Record<string, string>,
  goldenRoot: string = GOLDEN_DIRECTORY
): void {
  const goldenDirectory: string = join(goldenRoot, name);
  if (name === '' || name.includes('..') || name.startsWith('/')) {
    throw new Error(`Invalid golden directory name "${name}".`);
  }
  for (const path of Object.keys(files)) {
    if (path.startsWith('/') || path.split('/').includes('..')) {
      throw new Error(`The generated file path "${path}" is not relative.`);
    }
  }
  if (process.env.UPDATE_GOLDEN === '1') {
    rmSync(goldenDirectory, { recursive: true, force: true });
    for (const [path, text] of Object.entries(files)) {
      const target: string = join(goldenDirectory, path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, text);
    }
    return;
  }
  const expectedPaths: string[] = listFilesRecursively(goldenDirectory);
  const actualPaths: string[] = Object.keys(files).sort();
  const added: string[] = actualPaths.filter(
    (path: string) => !expectedPaths.includes(path)
  );
  const removed: string[] = expectedPaths.filter(
    (path: string) => !actualPaths.includes(path)
  );
  if (added.length > 0 || removed.length > 0) {
    throw new Error(
      `The generated files differ from test/golden/${name}/. ` +
        `Added (no golden file): ${added.join(', ') || 'none'}. ` +
        `Removed (golden file no longer generated): ${removed.join(', ') || 'none'}. ` +
        `Run the tests with UPDATE_GOLDEN=1 to refresh the directory.`
    );
  }
  for (const path of actualPaths) {
    expect(files[path], `${name}/${path}`).toBe(
      readFileSync(join(goldenDirectory, path), 'utf8')
    );
  }
}

/**
 * Compares a conversion with its golden output. Single-text conversions use
 * the file test/golden/<pair>.<naming>.txt; multi-file conversions use the
 * directory test/golden/<pair>.<naming>/ with one golden per generated file.
 */
export function expectConversionMatchesGolden(
  pair: string,
  naming: string,
  result: ConvertResult
): void {
  if (result.files !== undefined) {
    expectFilesMatchGolden(`${pair}.${naming}`, result.files);
    return;
  }
  expectMatchesGolden(`${pair}.${naming}.txt`, result.output);
}

/** The top-level entries (files and directories) of test/golden/, sorted. */
export function listGoldenEntries(): string[] {
  return readdirSync(GOLDEN_DIRECTORY).sort();
}

/**
 * Turns a conversion result into converter input: every emitted file for a
 * multi-file result (in path order), otherwise one source holding the text.
 */
export function resultToSources(
  result: ConvertResult,
  format: string
): SourceText[] {
  if (result.files !== undefined) {
    return Object.keys(result.files)
      .sort()
      .map((path: string): SourceText => ({
        path,
        text: result.files?.[path] ?? '',
      }));
  }
  return [{ path: `roundtrip.${format}`, text: result.output }];
}

export interface RoundTripResult {
  /** Output of the first conversion (from -> via). */
  forward: ConvertResult;
  /** Output of converting the forward output back (via -> from). */
  back: ConvertResult;
  /** Output of converting the back output forward again (from -> via). */
  forwardAgain: ConvertResult;
}

/**
 * Converts from -> via -> from -> via. If the pair is lossless for the
 * fixture, `forward.output` equals `forwardAgain.output` (the conversion is
 * stable after one pass), which is how lossy mappings are detected. A
 * multi-file result (`files`) is fed back as all of its files at once.
 */
export async function roundTrip(
  from: string,
  via: string,
  overrides: Partial<ConvertOptions> = {}
): Promise<RoundTripResult> {
  const options: ConvertOptions = {
    ...DEFAULT_OPTIONS,
    ...overrides,
    from,
    to: via,
  };
  const forward: ConvertResult = await convertCanonical(from, via, overrides);
  const back: ConvertResult = expectOk(
    await convertText(resultToSources(forward, via), {
      ...options,
      from: via,
      to: from,
    })
  );
  const forwardAgain: ConvertResult = expectOk(
    await convertText(resultToSources(back, from), options)
  );
  return { forward, back, forwardAgain };
}

/**
 * Lists the lines that differ between two outputs as "- line" (only in
 * `before`) and "+ line" (only in `after`), ignoring line order. An empty
 * result means the conversion is stable.
 */
export function describeDrift(before: string, after: string): string {
  const countLines = (text: string): Map<string, number> => {
    const counts: Map<string, number> = new Map<string, number>();
    for (const line of text.split('\n')) {
      counts.set(line, (counts.get(line) ?? 0) + 1);
    }
    return counts;
  };
  const beforeCounts: Map<string, number> = countLines(before);
  const afterCounts: Map<string, number> = countLines(after);
  const drift: string[] = [];
  for (const [line, count] of beforeCounts) {
    const missing: number = count - (afterCounts.get(line) ?? 0);
    for (let index: number = 0; index < missing; index += 1) {
      drift.push(`- ${line.trim()}`);
    }
  }
  for (const [line, count] of afterCounts) {
    const added: number = count - (beforeCounts.get(line) ?? 0);
    for (let index: number = 0; index < added; index += 1) {
      drift.push(`+ ${line.trim()}`);
    }
  }
  return drift.sort().join('\n') + (drift.length > 0 ? '\n' : '');
}

/**
 * Like `describeDrift`, but for whole conversion results. Single-text results
 * give exactly the `describeDrift` output. For multi-file results each file
 * that changed is listed under an `@@ <path>` line, and added or removed files
 * appear as `+ file <path>` and `- file <path>`.
 */
export function describeResultDrift(
  before: ConvertResult,
  after: ConvertResult
): string {
  if (before.files === undefined && after.files === undefined) {
    return describeDrift(before.output, after.output);
  }
  const beforeFiles: Record<string, string> = before.files ?? {};
  const afterFiles: Record<string, string> = after.files ?? {};
  const sections: string[] = [];
  const paths: string[] = [
    ...new Set([...Object.keys(beforeFiles), ...Object.keys(afterFiles)]),
  ].sort();
  for (const path of paths) {
    const previous: string | undefined = beforeFiles[path];
    const next: string | undefined = afterFiles[path];
    if (previous === undefined) {
      sections.push(`+ file ${path}\n`);
    } else if (next === undefined) {
      sections.push(`- file ${path}\n`);
    } else {
      const drift: string = describeDrift(previous, next);
      if (drift !== '') {
        sections.push(`@@ ${path}\n${drift}`);
      }
    }
  }
  return sections.join('');
}
