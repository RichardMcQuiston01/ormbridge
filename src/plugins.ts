import { createRequire } from 'node:module';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  getFormat,
  registerFormat,
  unregisterFormat,
  type FormatAdapter,
} from './formats.js';
import { describeThrown, err, ok, type Result } from './result.js';

/**
 * What an addon package exports (as its default export, or as a named export `plugin`): a name and the formats it
 * adds to the registry. An addon lists `ormbridge` as a peer dependency and uses only what the package exports.
 */
export interface OrmbridgePlugin {
  /** The package name, used in messages. */
  name: string;
  /** The formats the plugin registers. */
  formats: FormatAdapter[];
}

/** True when a value has the shape of an `OrmbridgePlugin`. */
export function isOrmbridgePlugin(value: unknown): value is OrmbridgePlugin {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate: Partial<OrmbridgePlugin> = value as Partial<OrmbridgePlugin>;
  return (
    typeof candidate.name === 'string' &&
    candidate.name.trim() !== '' &&
    Array.isArray(candidate.formats)
  );
}

/**
 * Adds the formats of a plugin to the registry. A format that is already registered from the same plugin is skipped. When a
 * format cannot be registered (its name or an extension is taken) the formats added so far are removed again, so a
 * plugin is registered completely or not at all.
 */
export function registerPlugin(
  plugin: OrmbridgePlugin
): Result<OrmbridgePlugin> {
  const added: string[] = [];
  for (const adapter of plugin.formats) {
    // Loading a plugin twice (the CLI flag and the config file) hands back the same adapter objects.
    const existing: Result<FormatAdapter> = getFormat(adapter.name);
    if (existing.ok && existing.value === adapter) {
      continue;
    }
    const result: Result<FormatAdapter> = registerFormat(adapter);
    if (!result.ok) {
      for (const name of added) {
        unregisterFormat(name);
      }
      return err(
        'PLUGIN_FAILED',
        `The plugin "${plugin.name}" could not register the format "${adapter.name}": ${result.error.message}`
      );
    }
    added.push(adapter.name);
  }
  return ok(plugin);
}

/** Resolves a plugin specifier to something `import()` accepts: a file URL for paths, a resolved file for packages. */
function resolveSpecifier(
  specifier: string,
  baseDirectory: string
): Result<string> {
  if (specifier.startsWith('.') || isAbsolute(specifier)) {
    return ok(pathToFileURL(resolve(baseDirectory, specifier)).href);
  }
  try {
    const requireFromBase: NodeRequire = createRequire(
      join(baseDirectory, 'ormbridge-plugin-resolver.js')
    );
    return ok(pathToFileURL(requireFromBase.resolve(specifier)).href);
  } catch (thrown) {
    return err(
      'PLUGIN_NOT_FOUND',
      `The plugin "${specifier}" was not found from "${baseDirectory}". Install it (for example "npm install ${specifier}") ` +
        `in that project, or give a path that starts with "./". The package must export a "default" condition. ` +
        `Underlying error: ${describeThrown(thrown)}`
    );
  }
}

/**
 * Loads a plugin and registers its formats. `specifier` is a package name or a path (relative paths resolve against
 * `baseDirectory`, which is the directory of the config file or the working directory).
 */
export async function loadPlugin(
  specifier: string,
  baseDirectory: string
): Promise<Result<OrmbridgePlugin>> {
  const resolved: Result<string> = resolveSpecifier(specifier, baseDirectory);
  if (!resolved.ok) {
    return resolved;
  }
  let loaded: Record<string, unknown>;
  try {
    loaded = (await import(resolved.value)) as Record<string, unknown>;
  } catch (thrown) {
    return err(
      'PLUGIN_FAILED',
      `The plugin "${specifier}" could not be loaded: ${describeThrown(thrown)}`
    );
  }
  const exported: unknown = loaded['default'] ?? loaded['plugin'];
  if (!isOrmbridgePlugin(exported)) {
    return err(
      'PLUGIN_FAILED',
      `The plugin "${specifier}" must export, as its default export or as "plugin", an object with a "name" and a "formats" array.`
    );
  }
  return registerPlugin(exported);
}

/** Loads several plugins in order and stops at the first failure. */
export async function loadPlugins(
  specifiers: readonly string[],
  baseDirectory: string
): Promise<Result<OrmbridgePlugin[]>> {
  const plugins: OrmbridgePlugin[] = [];
  for (const specifier of specifiers) {
    const result: Result<OrmbridgePlugin> = await loadPlugin(
      specifier,
      baseDirectory
    );
    if (!result.ok) {
      return result;
    }
    plugins.push(result.value);
  }
  return ok(plugins);
}
