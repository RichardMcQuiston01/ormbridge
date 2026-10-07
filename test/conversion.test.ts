import { describe, expect, it } from 'vitest';
import { listFormats, type FormatAdapter } from '../src/formats.js';
import { CANONICAL_FIXTURES } from './fixtures/canonical.js';
import {
  convertCanonical,
  describeDrift,
  expectMatchesGolden,
  roundTrip,
  type RoundTripResult,
} from './harness.js';

const NAMING_MODES: readonly ('preserve' | 'normalize')[] = [
  'preserve',
  'normalize',
];

/** Every ordered pair of registered formats where the source is readable and the target writable. */
function conversionPairs(): [FormatAdapter, FormatAdapter][] {
  const formats: FormatAdapter[] = listFormats();
  const pairs: [FormatAdapter, FormatAdapter][] = [];
  for (const source of formats) {
    for (const target of formats) {
      if (
        source !== target &&
        source.parse !== undefined &&
        target.emit !== undefined
      ) {
        pairs.push([source, target]);
      }
    }
  }
  return pairs;
}

describe('canonical fixtures', () => {
  it('exist for every format that can be read', () => {
    const readable: string[] = listFormats()
      .filter((format: FormatAdapter) => format.parse !== undefined)
      .map((format: FormatAdapter) => format.name)
      .sort();
    const covered: string[] = CANONICAL_FIXTURES.map(
      (fixture) => fixture.format
    ).sort();
    expect(covered).toEqual(readable);
  });
});

describe.each(
  conversionPairs().map(
    ([source, target]) => [source.name, target.name, source, target] as const
  )
)('%s -> %s', (_sourceName, _targetName, source, target) => {
  describe.each(NAMING_MODES)('%s naming', (naming) => {
    it('matches the golden output', async () => {
      const result = await convertCanonical(source.name, target.name, {
        naming,
      });
      expectMatchesGolden(
        `${source.name}-to-${target.name}.${naming}.txt`,
        result.output
      );
    });
  });
});

/** A round trip also needs the source to be writable and the target readable. */
function roundTripPairs(): [FormatAdapter, FormatAdapter][] {
  return conversionPairs().filter(
    ([source, target]) =>
      source.emit !== undefined && target.parse !== undefined
  );
}

describe.each(
  roundTripPairs().map(
    ([source, target]) => [source.name, target.name, source, target] as const
  )
)('round trip %s -> %s', (_sourceName, _targetName, source, target) => {
  it('has only the documented drift after one pass', async () => {
    const trip: RoundTripResult = await roundTrip(source.name, target.name);
    // An empty golden file means the pair is lossless for the fixture; any
    // other content lists exactly what the trip changes.
    expectMatchesGolden(
      `roundtrip-${source.name}-${target.name}.drift.txt`,
      describeDrift(trip.forward.output, trip.forwardAgain.output)
    );
  });
});
