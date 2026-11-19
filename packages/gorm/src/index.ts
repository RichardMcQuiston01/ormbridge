import {
  err,
  ok,
  type FormatAdapter,
  type FormatEmitOutput,
  type FormatOptions,
  type IrSchema,
  type OrmbridgePlugin,
  type Result,
  type SourceText,
} from 'ormbridge';
import {
  DEFAULT_GO_PACKAGE,
  emitGorm,
  isValidGoPackageName,
} from './gormEmitter.js';
import { parseGorm } from './gormParser.js';

export { emitGorm, isValidGoPackageName } from './gormEmitter.js';
export type { GormEmitOptions } from './gormEmitter.js';
export { parseGorm } from './gormParser.js';
export type { GormParseOptions, GormSourceFile } from './gormParser.js';

/** Go files that are tests are not part of the model; vendored and generated folders are never searched. */
function isGoTestFile(path: string): boolean {
  return /_test\.go$/.test(path);
}

export const gormAdapter: FormatAdapter = {
  name: 'gorm',
  // No extension is claimed: ".go" is too generic to infer, so pass --from/--to gorm.
  extensions: [],
  description: 'GORM models (Go structs with gorm tags)',
  input: {
    extensions: ['.go'],
    description: 'Go (.go) model files',
    skippedDirectories: ['vendor', 'node_modules', 'testdata', '.git'],
    isSkippedFile: isGoTestFile,
  },
  parse: (
    sources: SourceText[],
    options: FormatOptions
  ): Promise<Result<IrSchema>> =>
    parseGorm(
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
    if (
      options.goPackage !== undefined &&
      !isValidGoPackageName(options.goPackage)
    ) {
      return err(
        'INVALID_OPTION',
        `Invalid Go package name "${options.goPackage}". Expected a Go identifier such as ${DEFAULT_GO_PACKAGE}.`
      );
    }
    return ok(
      emitGorm(schema, {
        provider: options.provider,
        naming: options.naming,
        ...(options.goPackage === undefined
          ? {}
          : { goPackage: options.goPackage }),
      })
    );
  },
};

const plugin: OrmbridgePlugin = {
  name: 'ormbridge-gorm',
  formats: [gormAdapter],
};

export default plugin;
