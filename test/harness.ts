import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
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
 * stable after one pass), which is how lossy mappings are detected.
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
    await convertText([{ path: `roundtrip.${via}`, text: forward.output }], {
      ...options,
      from: via,
      to: from,
    })
  );
  const forwardAgain: ConvertResult = expectOk(
    await convertText(
      [{ path: `roundtrip.${from}`, text: back.output }],
      options
    )
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
