import { describe, expect, it } from 'vitest';
import { emitJpa, type JpaEmitOptions } from '../../../src/emitters/jpa.js';
import type { IrSchema } from '../../../src/ir.js';
import { parseJpa } from '../../../src/parsers/jpa.js';
import { expectOk } from '../../../test/helpers.js';
import { compareIr, formatDifference } from '../../../test/irCompare.js';
import { emitKotlin, parseKotlin } from '../src/index.js';
import { SUBJECTS } from './subjects.js';

/**
 * Kotlin and Java entities follow the same rules: whatever schema the Java writer writes, the Kotlin writer writes
 * as classes that read back as the same schema.
 */

function sortedFiles(
  files: Record<string, string>
): { path: string; text: string }[] {
  return Object.entries(files)
    .sort(([first], [second]) => (first < second ? -1 : 1))
    .map(([path, text]) => ({ path, text }));
}

describe('Kotlin round trip', () => {
  describe.each(SUBJECTS)('$label', ({ build, options }) => {
    for (const style of ['jakarta', 'javax'] as const) {
      for (const naming of ['preserve', 'normalize'] as const) {
        it(`reads back the schema of the Java output (${style}, ${naming})`, async () => {
          const schema: IrSchema = await build();
          const emitOptions: JpaEmitOptions = {
            provider: 'postgresql',
            naming,
            style,
            header: false,
            ...options,
          };
          const java: IrSchema = expectOk(
            await parseJpa(
              sortedFiles(emitJpa(structuredClone(schema), emitOptions).files),
              { appLabel: 'app' }
            )
          );
          const written = emitKotlin(structuredClone(schema), emitOptions);
          expect(
            Object.keys(written.files).every((path) => path.endsWith('.kt'))
          ).toBe(true);
          const kotlin: IrSchema = expectOk(
            await parseKotlin(sortedFiles(written.files), { appLabel: 'app' })
          );
          const differences: string[] = compareIr(java, kotlin).map(
            formatDifference
          );
          expect(differences).toEqual([]);
          expect(
            kotlin.warnings.filter((warning) =>
              warning.includes('syntax errors')
            )
          ).toEqual([]);
        });
      }
    }
  });
});
