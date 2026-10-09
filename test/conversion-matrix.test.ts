import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { describe, expect, it } from 'vitest';
import { listFormats, type FormatAdapter } from '../src/formats.js';
import {
  computeEmitOnlyMatrix,
  computeMatrix,
  emitOnlyFormats,
  emitWith,
  matrixFormats,
  matrixPairs,
  parseEmitted,
  parseWith,
  type EmitOnlyCell,
  type MatrixCell,
} from './conversionMatrix.js';
import {
  MATRIX_DOC_PATH,
  describeDifferences,
  renderMatrixMarkdown,
  unexplainedDifferences,
  unexplainedIdempotenceDifferences,
} from './conversionMatrixDoc.js';
import { loadCanonicalSources } from './harness.js';

// Computed once; every pair below reads from it.
const cells: MatrixCell[] = await computeMatrix();
const emitOnlyCells: EmitOnlyCell[] = await computeEmitOnlyMatrix();

function cellFor(source: FormatAdapter, target: FormatAdapter): MatrixCell {
  const cell: MatrixCell | undefined = cells.find(
    (candidate: MatrixCell) =>
      candidate.source === source.name && candidate.target === target.name
  );
  if (cell === undefined) {
    throw new Error(`No matrix cell for ${source.name} -> ${target.name}.`);
  }
  return cell;
}

describe('conversion matrix coverage', () => {
  it('has one cell per ordered pair of readable and writable formats', () => {
    const formats: FormatAdapter[] = matrixFormats();
    expect(formats.length).toBeGreaterThanOrEqual(3);
    expect(cells).toHaveLength(formats.length * (formats.length - 1));
    expect(matrixPairs()).toHaveLength(cells.length);
  });
});

describe.each(
  matrixPairs().map(
    ([source, target]) => [source.name, target.name, source, target] as const
  )
)('matrix %s -> %s', (_sourceName, _targetName, source, target) => {
  it('writes text that reads back without errors', () => {
    // computeMatrix throws on a parse or emit error, so reaching a cell proves it.
    expect(cellFor(source, target).emitted.trim()).not.toBe('');
  });

  it('only loses information that is documented', () => {
    const unexplained = unexplainedDifferences(cellFor(source, target));
    expect(describeDifferences(unexplained)).toBe('');
  });

  it('is stable after a second trip (A -> B -> A -> B), apart from documented reasons', () => {
    expect(
      describeDifferences(
        unexplainedIdempotenceDifferences(cellFor(source, target))
      )
    ).toBe('');
  });
});

describe('write-only targets', () => {
  it('has one cell per readable format for every checkable write-only target', () => {
    expect(emitOnlyFormats().map((format) => format.name)).toContain('gorm');
    expect(emitOnlyCells).toHaveLength(
      emitOnlyFormats().length * matrixFormats().length
    );
  });

  it.each(
    emitOnlyCells.map((cell: EmitOnlyCell): [string, EmitOnlyCell] => [
      `${cell.source} -> ${cell.target}`,
      cell,
    ])
  )('%s writes files that cover the canonical schema', (_name, cell) => {
    expect(cell.files.length).toBeGreaterThan(0);
    expect(cell.missing).toEqual([]);
  });
});

describe('writable formats', () => {
  const writable: FormatAdapter[] = listFormats().filter(
    (format: FormatAdapter) => format.emit !== undefined
  );

  it.each(writable.map((format: FormatAdapter) => format.name))(
    '%s writes non-empty text for every readable canonical fixture',
    async (targetName: string) => {
      const target: FormatAdapter | undefined = writable.find(
        (format: FormatAdapter) => format.name === targetName
      );
      if (target === undefined) {
        throw new Error(`Unknown format ${targetName}.`);
      }
      for (const source of matrixFormats()) {
        const schema = await parseWith(
          source,
          loadCanonicalSources(source.name)
        );
        const emitted = emitWith(target, schema);
        expect(
          emitted.text.trim(),
          `${source.name} -> ${target.name}`
        ).not.toBe('');
        // A readable target must also be able to read its own output.
        if (target.parse !== undefined) {
          const reread = await parseEmitted(target, emitted);
          expect(reread.models.length).toBeGreaterThanOrEqual(
            schema.models.length
          );
        }
      }
    }
  );
});

describe('docs/CONVERSION_MATRIX.md', () => {
  it('is up to date with the generated matrix', () => {
    const generated: string = renderMatrixMarkdown(cells, emitOnlyCells);
    if (process.env.UPDATE_GOLDEN === '1') {
      mkdirSync(dirname(MATRIX_DOC_PATH), { recursive: true });
      writeFileSync(MATRIX_DOC_PATH, generated);
      return;
    }
    if (!existsSync(MATRIX_DOC_PATH)) {
      throw new Error(
        'docs/CONVERSION_MATRIX.md does not exist. Run `npm run docs:matrix` or the tests with UPDATE_GOLDEN=1.'
      );
    }
    expect(
      readFileSync(MATRIX_DOC_PATH, 'utf8'),
      'docs/CONVERSION_MATRIX.md is stale. Run `npm run docs:matrix` (or UPDATE_GOLDEN=1 npm test) and commit the result.'
    ).toBe(generated);
  });
});
