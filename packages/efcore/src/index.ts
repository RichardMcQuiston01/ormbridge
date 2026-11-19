import {
  err,
  ok,
  checkStyle,
  type FormatAdapter,
  type FormatEmitOutput,
  type FormatOptions,
  type IrSchema,
  type OrmbridgePlugin,
  type OutputStyle,
  type Result,
  type SourceText,
} from 'ormbridge';
import {
  emitEfcore,
  isEfcoreStyle,
  isValidCsharpNamespace,
} from './emitters/efcore.js';
import { parseEfcore } from './parsers/efcore.js';

export {
  DEFAULT_EFCORE_NAMESPACE,
  EFCORE_STYLES,
  emitEfcore,
  isEfcoreStyle,
  isValidCsharpNamespace,
} from './emitters/efcore.js';
export type { EfcoreEmitOptions, EfcoreStyle } from './emitters/efcore.js';
export { isSkippedEfcorePath, parseEfcore } from './parsers/efcore.js';
export type { EfcoreParseOptions, EfcoreSourceFile } from './parsers/efcore.js';

/** Generated C# files: migration designers and compiler output. */
const NON_MODEL_FILE: RegExp = /\.(?:Designer|g|generated)\.cs$/i;

export const efcoreAdapter: FormatAdapter = {
  name: 'efcore',
  // No extension is claimed: ".cs" is too generic to infer, so pass --from/--to efcore.
  extensions: [],
  description:
    'Entity Framework Core 8 models (C#; DbContext, data annotations and the fluent API; --style fluent writes plain classes and configuration classes)',
  // The Migrations folder is read: it is replayed when the input has no entity classes and skipped otherwise.
  input: {
    extensions: ['.cs'],
    description: 'C# (.cs) files with Entity Framework Core models',
    skippedDirectories: [
      'bin',
      'obj',
      'packages',
      'node_modules',
      '.vs',
      '.git',
    ],
    skippedDirectoriesIgnoreCase: true,
    isSkippedFile: (path: string): boolean => NON_MODEL_FILE.test(path),
  },
  parse: (
    sources: SourceText[],
    options: FormatOptions
  ): Promise<Result<IrSchema>> =>
    parseEfcore(
      sources.map((source: SourceText) => ({
        path: source.path,
        text: source.text,
      })),
      { appLabel: options.appLabel ?? 'app' }
    ),
  emit: (
    schema: IrSchema,
    options: FormatOptions
  ): Result<FormatEmitOutput> => {
    if (options.style !== undefined) {
      const checked: Result<OutputStyle> = checkStyle(
        'efcore',
        String(options.style),
        'style'
      );
      if (!checked.ok) {
        return checked;
      }
    }
    const namespace: string | undefined = options.namespace?.replace(
      /^\.+|\.+$/g,
      ''
    );
    if (namespace !== undefined && !isValidCsharpNamespace(namespace)) {
      return err(
        'INVALID_OPTION',
        `Invalid namespace "${options.namespace ?? ''}". Expected a C# namespace such as App.Models.`
      );
    }
    return ok(
      emitEfcore(schema, {
        provider: options.provider,
        naming: options.naming,
        header: options.header,
        ...(namespace === undefined ? {} : { namespace }),
        ...(options.style === undefined || !isEfcoreStyle(options.style)
          ? {}
          : { style: options.style }),
      })
    );
  },
};

const plugin: OrmbridgePlugin = {
  name: 'ormbridge-efcore',
  formats: [efcoreAdapter],
};

export default plugin;
