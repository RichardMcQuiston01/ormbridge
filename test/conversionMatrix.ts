import {
  listFormats,
  type FormatAdapter,
  type FormatEmitOutput,
  type FormatOptions,
  type SourceText,
} from '../src/formats.js';
import type { IrSchema } from '../src/ir.js';
import { checkDrizzleOutput } from './drizzleCoverage.js';
import { checkGormOutput } from './gormCoverage.js';
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

/**
 * Formats that can only be read (no writer yet, for example GORM). They join the
 * matrix as sources: each is written to every readable and writable format and
 * read back, but the second trip back through the source is not possible.
 */
export function readOnlyFormats(): FormatAdapter[] {
  return listFormats().filter(
    (format: FormatAdapter) =>
      format.parse !== undefined && format.emit === undefined
  );
}

/** Every pair (A, B) where A can only be read and B can be read and written. */
export function readOnlyPairs(): [FormatAdapter, FormatAdapter][] {
  const pairs: [FormatAdapter, FormatAdapter][] = [];
  for (const source of readOnlyFormats()) {
    for (const target of matrixFormats()) {
      pairs.push([source, target]);
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
  /**
   * The emitted text. For a multi-file emitter this is every file joined in
   * path order (useful for emptiness checks); the files themselves are in `files`.
   */
  text: string;
  /** The emitted files (relative path to text), present only for multi-file emitters. */
  files?: Record<string, string>;
  warnings: string[];
}

/** Writes an IR with a format's writer, failing loudly on errors. */
export function emitWith(format: FormatAdapter, schema: IrSchema): EmittedText {
  if (format.emit === undefined) {
    throw new Error(`The format "${format.name}" cannot be written.`);
  }
  const emitted: FormatEmitOutput = unwrap(
    format.emit(schema, MATRIX_OPTIONS),
    `Emitting ${format.name}`
  );
  if (emitted.text === undefined) {
    const files: Record<string, string> = emitted.files;
    return {
      text: Object.keys(files)
        .sort()
        .map((path: string) => files[path] ?? '')
        .join('\n'),
      files,
      warnings: emitted.warnings,
    };
  }
  return { text: emitted.text, warnings: emitted.warnings };
}

/**
 * Re-parses what `format` emitted, as a user would feed it back in: the text
 * as one source, or every emitted file as its own source.
 */
export function parseEmitted(
  format: FormatAdapter,
  emitted: EmittedText
): Promise<IrSchema> {
  if (emitted.files !== undefined) {
    const files: Record<string, string> = emitted.files;
    return parseWith(
      format,
      Object.keys(files)
        .sort()
        .map((path: string): SourceText => ({ path, text: files[path] ?? '' }))
    );
  }
  return parseWith(format, [
    { path: `roundtrip.${format.name}`, text: emitted.text },
  ]);
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
  /** True when the source can only be read, so the second trip was not run. */
  readOnlySource?: boolean;
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
  const targetIr: IrSchema = await parseEmitted(target, emitted);

  // Second trip: B -> A -> B, starting from the IR that B read back.
  const backEmitted: EmittedText = emitWith(source, targetIr);
  const sourceAgain: IrSchema = await parseEmitted(source, backEmitted);
  const emittedAgain: EmittedText = emitWith(target, sourceAgain);
  const targetAgain: IrSchema = await parseEmitted(target, emittedAgain);

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

/** Runs one cell for a source that can only be read: parse A, emit B, re-parse B, compare. */
export async function computeReadOnlyCell(
  source: FormatAdapter,
  target: FormatAdapter
): Promise<MatrixCell> {
  const sourceIr: IrSchema = await parseWith(
    source,
    loadCanonicalSources(source.name)
  );
  const emitted: EmittedText = emitWith(target, sourceIr);
  const targetIr: IrSchema = await parseEmitted(target, emitted);
  return {
    source: source.name,
    target: target.name,
    differences: compareIr(sourceIr, targetIr),
    emitWarnings: emitted.warnings,
    reparseWarnings: targetIr.warnings,
    emitted: emitted.text,
    sourceSchema: sourceIr,
    idempotenceDifferences: [],
    readOnlySource: true,
  };
}

/** Computes every cell of the matrix: the read-write pairs first, then the read-only sources. */
export async function computeMatrix(): Promise<MatrixCell[]> {
  const cells: MatrixCell[] = [];
  for (const [source, target] of matrixPairs()) {
    cells.push(await computeCell(source, target));
  }
  for (const [source, target] of readOnlyPairs()) {
    cells.push(await computeReadOnlyCell(source, target));
  }
  return cells;
}

/**
 * Structural checks for formats that can be written but not read. The matrix
 * cannot re-read their output, so each check compares the written files with
 * the IR and lists what is missing.
 */
const EMIT_ONLY_CHECKS: Readonly<
  Record<string, (schema: IrSchema, files: Record<string, string>) => string[]>
> = {
  gorm: checkGormOutput,
  drizzle: checkDrizzleOutput,
};

/** Write-only formats the matrix can check structurally, in registration order. */
export function emitOnlyFormats(): FormatAdapter[] {
  return listFormats().filter(
    (format: FormatAdapter) =>
      format.parse === undefined &&
      format.emit !== undefined &&
      EMIT_ONLY_CHECKS[format.name] !== undefined
  );
}

/** One source format written to a write-only target. */
export interface EmitOnlyCell {
  source: string;
  target: string;
  /** Relative paths of the files written. */
  files: string[];
  emitWarnings: string[];
  /** What the structural check could not find in the output; empty when the output covers the IR. */
  missing: string[];
}

/** Writes one readable format's canonical schema to a write-only target and checks the files. */
export async function computeEmitOnlyCell(
  source: FormatAdapter,
  target: FormatAdapter
): Promise<EmitOnlyCell> {
  const sourceIr: IrSchema = await parseWith(
    source,
    loadCanonicalSources(source.name)
  );
  const emitted: EmittedText = emitWith(target, sourceIr);
  const check:
    | ((schema: IrSchema, files: Record<string, string>) => string[])
    | undefined = EMIT_ONLY_CHECKS[target.name];
  return {
    source: source.name,
    target: target.name,
    files: Object.keys(emitted.files ?? {}).sort(),
    emitWarnings: emitted.warnings,
    missing: check === undefined ? [] : check(sourceIr, emitted.files ?? {}),
  };
}

/** Every readable+writable source written to every checkable write-only target. */
export async function computeEmitOnlyMatrix(): Promise<EmitOnlyCell[]> {
  const cells: EmitOnlyCell[] = [];
  for (const target of emitOnlyFormats()) {
    for (const source of matrixFormats()) {
      cells.push(await computeEmitOnlyCell(source, target));
    }
  }
  return cells;
}
