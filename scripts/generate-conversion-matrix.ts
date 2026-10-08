/**
 * Regenerates docs/CONVERSION_MATRIX.md from the canonical fixtures.
 * Run with `npm run docs:matrix`.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { computeMatrix } from '../test/conversionMatrix.js';
import {
  MATRIX_DOC_PATH,
  renderMatrixMarkdown,
} from '../test/conversionMatrixDoc.js';

const markdown: string = renderMatrixMarkdown(await computeMatrix());
mkdirSync(dirname(MATRIX_DOC_PATH), { recursive: true });
writeFileSync(MATRIX_DOC_PATH, markdown);
console.log(`Wrote ${MATRIX_DOC_PATH}`);
