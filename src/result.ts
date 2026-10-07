/**
 * Result type used across the package. Every fallible function returns a
 * Result so that callers are forced to check for failure explicitly.
 */

export type ErrorCode =
  | 'INPUT_NOT_FOUND'
  | 'INPUT_READ_FAILED'
  | 'NO_INPUT_FILES'
  | 'PARSER_INIT_FAILED'
  | 'PARSE_FAILED'
  | 'NO_MODELS_FOUND'
  | 'UNSUPPORTED_CONVERSION'
  | 'INVALID_OPTION'
  | 'EMIT_FAILED'
  | 'OUTPUT_WRITE_FAILED';

export interface ConversionError {
  code: ErrorCode;
  message: string;
}

export type Result<T> =
  | { ok: true; value: T }
  | { ok: false; error: ConversionError };

export function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

export function err(code: ErrorCode, message: string): Result<never> {
  return { ok: false, error: { code, message } };
}

/** Converts an unknown thrown value into a readable message. */
export function describeThrown(thrown: unknown): string {
  if (thrown instanceof Error) {
    return thrown.message;
  }
  return String(thrown);
}
