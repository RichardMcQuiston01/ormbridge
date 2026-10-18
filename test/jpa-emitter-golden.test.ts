import { fileURLToPath } from 'node:url';
import { describe, it } from 'vitest';
import type { ConvertResult } from '../src/convert.js';
import {
  emitJpa,
  JPA_STYLES,
  type JpaEmitOptions,
} from '../src/emitters/jpa.js';
import type { MultiFileEmitOutput } from '../src/formats.js';
import type { IrSchema } from '../src/ir.js';
import { parseJpa } from '../src/parsers/jpa.js';
import { constructsSchema } from './drizzleFixtures.js';
import { edgesSchema } from './efcoreFixtures.js';
import { CANONICAL_FIXTURES } from './fixtures/canonical.js';
import { kitchenSinkSchema, stressSchema } from './gormFixtures.js';
import { convertCanonical, expectFilesMatchGolden } from './harness.js';
import { expectOk } from './helpers.js';
import { compareIr, formatDifference } from './irCompare.js';
import { jpaEdgesSchema } from './jpaFixtures.js';
import { JPA_EXTRAS, parseJpaExtra } from './jpaSupport.js';
import { EXTRA_SOURCES, parseSource } from './realToolSupport.js';

function emit(
  schema: IrSchema,
  overrides: Partial<JpaEmitOptions> = {}
): MultiFileEmitOutput {
  return emitJpa(structuredClone(schema), {
    provider: 'postgresql',
    naming: 'preserve',
    ...overrides,
  });
}

describe('jpa emitter: golden files', () => {
  const goldenRoot: string = fileURLToPath(
    new URL('./golden-extras/', import.meta.url)
  );

  // The default (jakarta style) conversions live in test/golden/<format>-to-jpa.<naming>/ (conversion.test.ts).
  // The javax style output of every canonical schema is checked here.
  describe.each(
    CANONICAL_FIXTURES.map((fixture) => fixture.format).filter(
      (format: string) => format !== 'jpa'
    )
  )('%s source in the javax style', (format) => {
    it('matches the golden output', async () => {
      const files: Record<string, string> = {};
      for (const naming of ['preserve', 'normalize'] as const) {
        const result: ConvertResult = await convertCanonical(format, 'jpa', {
          naming,
          style: 'javax',
        });
        for (const [path, text] of Object.entries(result.files ?? {})) {
          files[`${naming}/${path}`] = text;
        }
        files[`${naming}.warnings.txt`] = `${result.warnings.join('\n')}\n`;
      }
      expectFilesMatchGolden(`jpa-javax/${format}-to-jpa`, files, goldenRoot);
    });
  });

  const fixtures: [string, () => Promise<IrSchema>][] = [
    ['kitchen-sink', () => Promise.resolve(kitchenSinkSchema())],
    ['stress', () => Promise.resolve(stressSchema())],
    ['constructs', () => Promise.resolve(constructsSchema())],
    ['edges', () => Promise.resolve(edgesSchema())],
    ['jpa-edges', () => Promise.resolve(jpaEdgesSchema())],
    ...EXTRA_SOURCES.map((source): [string, () => Promise<IrSchema>] => [
      source.label,
      () => parseSource(source),
    ]),
    ...JPA_EXTRAS.map((name: string): [string, () => Promise<IrSchema>] => [
      `jpa-${name}`,
      () => parseJpaExtra(name),
    ]),
  ];

  describe.each(fixtures)('%s fixture', (label, build) => {
    it('matches the golden output in both styles and naming modes, with the warnings and what reading it back changes', async () => {
      const schema: IrSchema = await build();
      const files: Record<string, string> = {};
      for (const style of JPA_STYLES) {
        for (const naming of ['preserve', 'normalize'] as const) {
          const output: MultiFileEmitOutput = emit(schema, { style, naming });
          for (const [path, text] of Object.entries(output.files)) {
            files[`${style}.${naming}/${path}`] = text;
          }
          files[`${style}.${naming}.warnings.txt`] =
            `${output.warnings.join('\n')}\n`;
        }
        // What the JPA reader makes of the preserve output: the drift of the format.
        const reread: IrSchema = expectOk(
          await parseJpa(
            Object.entries(emit(schema, { style }).files)
              .sort(([first], [second]) => (first < second ? -1 : 1))
              .map(([path, text]) => ({ path, text })),
            { appLabel: 'app' }
          )
        );
        files[`${style}.preserve.drift.txt`] = `${compareIr(schema, reread)
          .map(formatDifference)
          .join('\n')}\n`;
      }
      expectFilesMatchGolden(`jpa-fixtures/${label}`, files, goldenRoot);
    });
  });
});
