import type { EmitOutput } from './emitters/prisma.js';
import {
  BUILT_IN_FORMAT_NAMES,
  DEFAULT_APP_LABEL,
  getFormat,
  type FormatAdapter,
  type FormatName,
  type FormatOptions,
  type SourceText,
} from './formats.js';
import type { IrSchema } from './ir.js';
import { err, ok, type Result } from './result.js';

export { DEFAULT_APP_LABEL };
export type { FormatName, SourceText };

/** Names of the built-in formats. Use listFormatNames() for the live registry contents. */
export const FORMAT_NAMES: readonly FormatName[] = BUILT_IN_FORMAT_NAMES;

export interface ConvertOptions extends FormatOptions {
  from: FormatName;
  to: FormatName;
}

export interface ConvertResult {
  output: string;
  warnings: string[];
  modelCount: number;
}

/** Converts in-memory source text from one ORM format to another. */
export async function convertText(
  sources: SourceText[],
  options: ConvertOptions
): Promise<Result<ConvertResult>> {
  if (options.from === options.to) {
    return err(
      'UNSUPPORTED_CONVERSION',
      `The source and target formats are both "${options.from}". Choose different values for --from and --to.`
    );
  }
  if (sources.length === 0) {
    return err('NO_INPUT_FILES', 'No input sources were provided to convert.');
  }

  // Resolve both adapters first so a bad format fails before any parsing work.
  const parser: Result<ParseFunction> = resolveParser(options.from);
  if (!parser.ok) {
    return parser;
  }
  const emitter: Result<EmitFunction> = resolveEmitter(options.to);
  if (!emitter.ok) {
    return emitter;
  }

  const parsed: Result<IrSchema> = await parser.value(sources, options);
  if (!parsed.ok) {
    return parsed;
  }

  const emitted: Result<EmitOutput> = emitter.value(parsed.value, options);
  if (!emitted.ok) {
    return emitted;
  }

  return ok({
    output: emitted.value.text,
    warnings: [...parsed.value.warnings, ...emitted.value.warnings],
    modelCount: parsed.value.models.length,
  });
}

type ParseFunction = NonNullable<FormatAdapter['parse']>;
type EmitFunction = NonNullable<FormatAdapter['emit']>;

function resolveParser(name: FormatName): Result<ParseFunction> {
  const adapter: Result<FormatAdapter> = getFormat(name);
  if (!adapter.ok) {
    return adapter;
  }
  if (adapter.value.parse === undefined) {
    return err(
      'UNSUPPORTED_CONVERSION',
      `The format "${name}" can only be used as an output; it cannot be read as input.`
    );
  }
  return ok(adapter.value.parse);
}

function resolveEmitter(name: FormatName): Result<EmitFunction> {
  const adapter: Result<FormatAdapter> = getFormat(name);
  if (!adapter.ok) {
    return adapter;
  }
  if (adapter.value.emit === undefined) {
    return err(
      'UNSUPPORTED_CONVERSION',
      `The format "${name}" can only be used as an input; it cannot be written as output.`
    );
  }
  return ok(adapter.value.emit);
}
