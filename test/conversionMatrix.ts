import {
  listFormats,
  type FormatAdapter,
  type FormatOptions,
  type SourceText,
} from '../src/formats.js';
import type { IrSchema } from '../src/ir.js';
import { loadCanonicalSources } from './harness.js';
import { DEFAULT_OPTIONS } from './helpers.js';
import { compareIr, type IrDifference } from './irCompare.js';

/** Naming mode and options used for every matrix cell: the default "preserve" conversion. */
export const MATRIX_OPTIONS: FormatOptions = DEFAULT_OPTIONS;

/** Formats that can be both read and written, in registration order. */
export function matrixFormats(): FormatAdapter[] {
  return listFormats().filter(
    (format: FormatAdapter) =>
      format.parse !== undefined && format.emit !== undefined
  );
}

/** Every ordered pair (A, B) of distinct readable+writable formats. */
export function matrixPairs(): [FormatAdapter, FormatAdapter][] {
  const formats: FormatAdapter[] = matrixFormats();
  const pairs: [FormatAdapter, FormatAdapter][] = [];
  for (const source of formats) {
    for (const target of formats) {
      if (source !== target) {
        pairs.push([source, target]);
      }
    }
  }
  return pairs;
}

function unwrap<T>(
  result: { ok: true; value: T } | { ok: false; error: { message: string } },
  what: string
): T {
  if (!result.ok) {
    throw new Error(`${what} failed: ${result.error.message}`);
  }
  return result.value;
}

/** Parses source text with a format's reader, failing loudly on errors. */
export async function parseWith(
  format: FormatAdapter,
  sources: SourceText[]
): Promise<IrSchema> {
  if (format.parse === undefined) {
    throw new Error(`The format "${format.name}" cannot be read.`);
  }
  return unwrap(
    await format.parse(sources, MATRIX_OPTIONS),
    `Parsing ${format.name}`
  );
}

export interface EmittedText {
  text: string;
  warnings: string[];
}

/** Writes an IR with a format's writer, failing loudly on errors. */
export function emitWith(format: FormatAdapter, schema: IrSchema): EmittedText {
  if (format.emit === undefined) {
    throw new Error(`The format "${format.name}" cannot be written.`);
  }
  return unwrap(format.emit(schema, MATRIX_OPTIONS), `Emitting ${format.name}`);
}

/** Re-parses text that `format` emitted, as a user would feed it back in. */
export function parseEmitted(
  format: FormatAdapter,
  text: string
): Promise<IrSchema> {
  return parseWith(format, [{ path: `roundtrip.${format.name}`, text }]);
}

export interface MatrixCell {
  source: string;
  target: string;
  /** Differences between the source IR and the IR re-read from the emitted target text. */
  differences: IrDifference[];
  /** Warnings produced while writing the target. */
  emitWarnings: string[];
  /** Warnings produced while re-reading the emitted target text. */
  reparseWarnings: string[];
  /** The emitted target text. */
  emitted: string;
  /** The IR parsed from the source's canonical fixture. */
  sourceSchema: IrSchema;
  /** Differences between the target IR after one and after two trips (A->B->A->B). */
  idempotenceDifferences: IrDifference[];
}

/** Runs one cell: parse A's canonical fixture, emit B, re-parse B, compare. */
export async function computeCell(
  source: FormatAdapter,
  target: FormatAdapter
): Promise<MatrixCell> {
  const sourceIr: IrSchema = await parseWith(
    source,
    loadCanonicalSources(source.name)
  );
  const emitted: EmittedText = emitWith(target, sourceIr);
  const targetIr: IrSchema = await parseEmitted(target, emitted.text);

  // Second trip: B -> A -> B, starting from the IR that B read back.
  const backEmitted: EmittedText = emitWith(source, targetIr);
  const sourceAgain: IrSchema = await parseEmitted(source, backEmitted.text);
  const emittedAgain: EmittedText = emitWith(target, sourceAgain);
  const targetAgain: IrSchema = await parseEmitted(target, emittedAgain.text);

  return {
    source: source.name,
    target: target.name,
    differences: compareIr(sourceIr, targetIr),
    emitWarnings: emitted.warnings,
    reparseWarnings: targetIr.warnings,
    emitted: emitted.text,
    sourceSchema: sourceIr,
    idempotenceDifferences: compareIr(targetIr, targetAgain),
  };
}

/** Computes every cell of the matrix. */
export async function computeMatrix(): Promise<MatrixCell[]> {
  const cells: MatrixCell[] = [];
  for (const [source, target] of matrixPairs()) {
    cells.push(await computeCell(source, target));
  }
  return cells;
}
