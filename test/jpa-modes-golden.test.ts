import { fileURLToPath } from 'node:url';
import { describe, it } from 'vitest';
import {
  emitJpa,
  JPA_STYLES,
  type JpaEmitOptions,
} from '../src/emitters/jpa.js';
import type { MultiFileEmitOutput } from '../src/formats.js';
import type { IrSchema } from '../src/ir.js';
import { parseJpa } from '../src/parsers/jpa.js';
import { kitchenSinkSchema } from './gormFixtures.js';
import { expectFilesMatchGolden } from './harness.js';
import { expectOk } from './helpers.js';
import { compareIr, formatDifference } from './irCompare.js';
import { jpaEdgesSchema } from './jpaFixtures.js';
import { parseJpaExtra } from './jpaSupport.js';

/**
 * Golden files of the two JPA options that change the Java: `jpaKey` (an `@Embeddable` key class with `@EmbeddedId`)
 * and `lombok` (annotations in place of accessors). The default output has its goldens in `jpa-emitter-golden.test.ts`
 * and `conversion.test.ts`; they do not change.
 */

function emit(
  schema: IrSchema,
  overrides: Partial<JpaEmitOptions>
): MultiFileEmitOutput {
  return emitJpa(structuredClone(schema), {
    provider: 'postgresql',
    naming: 'preserve',
    ...overrides,
  });
}

const FIXTURES: [string, () => Promise<IrSchema>][] = [
  ['kitchen-sink', () => Promise.resolve(kitchenSinkSchema())],
  ['jpa-edges', () => Promise.resolve(jpaEdgesSchema())],
  ['jpa-composite-keys', () => parseJpaExtra('composite-keys')],
  ['jpa-embedded-keys', () => parseJpaExtra('embedded-keys')],
];

/** Each option alone, and both together. */
const MODES: [string, Partial<JpaEmitOptions>][] = [
  ['embedded', { keyMode: 'embedded' }],
  ['lombok', { lombok: true }],
  ['embedded-lombok', { keyMode: 'embedded', lombok: true }],
];

describe('jpa emitter: golden files of the key and Lombok options', () => {
  const goldenRoot: string = fileURLToPath(
    new URL('./golden-extras/', import.meta.url)
  );

  describe.each(FIXTURES)('%s fixture', (label, build) => {
    it('matches the golden output of every mode, with the warnings and what reading it back changes', async () => {
      const schema: IrSchema = await build();
      const files: Record<string, string> = {};
      const add = (name: string, output: MultiFileEmitOutput): void => {
        for (const [path, text] of Object.entries(output.files)) {
          files[`${name}/${path}`] = text;
        }
        files[`${name}.warnings.txt`] = `${output.warnings.join('\n')}\n`;
      };
      // Both options in both styles and both naming modes.
      for (const style of JPA_STYLES) {
        for (const naming of ['preserve', 'normalize'] as const) {
          add(
            `${style}.${naming}.embedded-lombok`,
            emit(schema, { style, naming, keyMode: 'embedded', lombok: true })
          );
        }
      }
      // Each option alone, for the default style and naming.
      for (const [mode, options] of MODES.slice(0, 2)) {
        add(`jakarta.preserve.${mode}`, emit(schema, options));
      }
      // What the JPA reader makes of the output of every mode: the drift of the format.
      for (const [mode, options] of MODES) {
        for (const style of JPA_STYLES) {
          const reread: IrSchema = expectOk(
            await parseJpa(
              Object.entries(emit(schema, { style, ...options }).files)
                .sort(([first], [second]) => (first < second ? -1 : 1))
                .map(([path, text]) => ({ path, text })),
              { appLabel: 'app' }
            )
          );
          files[`${style}.preserve.${mode}.drift.txt`] = `${compareIr(
            schema,
            reread
          )
            .map(formatDifference)
            .join('\n')}\n`;
        }
      }
      expectFilesMatchGolden(`jpa-modes/${label}`, files, goldenRoot);
    });
  });
});
