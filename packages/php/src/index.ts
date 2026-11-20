import { stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import {
  err,
  normalizeSchema,
  ok,
  type FormatAdapter,
  type FormatEmitOutput,
  type FormatInput,
  type FormatOptions,
  type IrSchema,
  type OrmbridgePlugin,
  type Result,
  type SourceText,
} from 'ormbridge';
import { emitDoctrine, isValidPhpNamespace } from './emitters/doctrine.js';
import { emitLaravel } from './emitters/laravel.js';
import { parseDoctrine } from './parsers/doctrine.js';
import { parseLaravel } from './parsers/laravel.js';

export {
  DEFAULT_DOCTRINE_NAMESPACE,
  emitDoctrine,
  isValidPhpNamespace,
} from './emitters/doctrine.js';
export type { DoctrineEmitOptions } from './emitters/doctrine.js';
export { emitLaravel } from './emitters/laravel.js';
export type { LaravelEmitOptions } from './emitters/laravel.js';
export { parseDoctrine } from './parsers/doctrine.js';
export type {
  DoctrineParseOptions,
  DoctrineSourceFile,
} from './parsers/doctrine.js';
export { parseLaravel } from './parsers/laravel.js';
export type {
  LaravelParseOptions,
  LaravelSourceFile,
} from './parsers/laravel.js';

/** PHP test files are not part of the model. */
function isPhpTestFile(path: string): boolean {
  return /Test\.php$/.test(basename(path));
}

/** Composer packages and Symfony's cache and log directory. */
const DOCTRINE_INPUT: FormatInput = {
  extensions: ['.php'],
  description: 'PHP (.php) entity files',
  skippedDirectories: ['vendor', 'var'],
  isSkippedFile: isPhpTestFile,
};

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * For a Laravel project root (it has `database/migrations` or `app`), only those two directories are read. Any other
 * directory, such as `app/Models` or `database/migrations` passed on its own, is read as given.
 */
async function laravelRoots(directory: string): Promise<string[]> {
  const roots: string[] = [];
  for (const candidate of [
    join(directory, 'database', 'migrations'),
    join(directory, 'app'),
  ]) {
    if (await isDirectory(candidate)) {
      roots.push(candidate);
    }
  }
  return roots.length > 0 ? roots : [directory];
}

/**
 * The folders of a Laravel project that are skipped. The folder walk's usual list does not apply: `migrations` is
 * where Laravel keeps its schema, and `build`, `env` and `dist` are ordinary names there.
 */
const LARAVEL_INPUT: FormatInput = {
  extensions: ['.php'],
  description:
    'PHP (.php) migration and model files (database/migrations and app/)',
  skippedDirectories: ['vendor', 'storage', 'node_modules', 'tests', '.git'],
  inheritSkippedDirectories: false,
  // bootstrap/cache holds generated files; the rest of bootstrap/ is ordinary code.
  isSkippedDirectory: (name: string, parent: string): boolean =>
    name === 'cache' && basename(parent) === 'bootstrap',
  isSkippedFile: isPhpTestFile,
  roots: laravelRoots,
};

export const doctrineAdapter: FormatAdapter = {
  name: 'doctrine',
  // No extension is claimed: ".php" is too generic to infer, so pass --from/--to doctrine.
  extensions: [],
  description: 'Doctrine ORM entities (PHP 8 attributes)',
  input: DOCTRINE_INPUT,
  parse: (
    sources: SourceText[],
    options: FormatOptions
  ): Promise<Result<IrSchema>> =>
    parseDoctrine(
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
    const namespace: string | undefined = options.namespace?.replace(
      /^\\+|\\+$/g,
      ''
    );
    if (namespace !== undefined && !isValidPhpNamespace(namespace)) {
      return err(
        'INVALID_OPTION',
        `Invalid namespace "${options.namespace ?? ''}". Expected a PHP namespace such as App\\Entity.`
      );
    }
    const prepared: IrSchema =
      options.naming === 'normalize' ? normalizeSchema(schema) : schema;
    return ok(
      emitDoctrine(prepared, {
        provider: options.provider,
        camelFields: options.naming === 'normalize',
        ...(namespace === undefined ? {} : { namespace }),
      })
    );
  },
};

export const laravelAdapter: FormatAdapter = {
  name: 'laravel',
  // No extension is claimed: ".php" is too generic to infer, so pass --from/--to laravel.
  extensions: [],
  description: 'Laravel migrations and Eloquent models',
  input: LARAVEL_INPUT,
  parse: (
    sources: SourceText[],
    options: FormatOptions
  ): Promise<Result<IrSchema>> =>
    parseLaravel(
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
    const namespace: string | undefined = options.namespace?.replace(
      /^\\+|\\+$/g,
      ''
    );
    if (namespace !== undefined && !isValidPhpNamespace(namespace)) {
      return err(
        'INVALID_OPTION',
        `Invalid namespace "${options.namespace ?? ''}". Expected a PHP namespace such as App\\Models.`
      );
    }
    return ok(
      emitLaravel(schema, {
        provider: options.provider,
        naming: options.naming,
        ...(namespace === undefined ? {} : { namespace }),
      })
    );
  },
};

const plugin: OrmbridgePlugin = {
  name: 'ormbridge-php',
  formats: [doctrineAdapter, laravelAdapter],
};

export default plugin;
