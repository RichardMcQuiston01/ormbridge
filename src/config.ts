import { readFile, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { PRISMA_PROVIDERS } from './emitters/prisma.js';
import { describeThrown, err, ok, type Result } from './result.js';

/** File names searched for in each directory, in priority order. */
export const CONFIG_FILE_NAMES: readonly string[] = [
  'ormbridge.config.json',
  '.ormbridgerc.json',
];

/** The settings of one conversion. Every key is optional; missing keys fall back to defaults. */
export interface ConversionConfig {
  /** Label used in messages. Only meaningful inside `conversions`. */
  name?: string;
  /** Input files or directories (absolute: relative paths resolve against the config file). */
  input?: string[];
  /** Output file or directory (absolute). */
  output?: string;
  from?: string;
  to?: string;
  naming?: 'preserve' | 'normalize';
  provider?: string;
  header?: boolean;
  appLabel?: string;
  autoField?: 'int' | 'bigint';
  /** PHP namespace of the Doctrine entities. */
  namespace?: string;
}

/** A parsed config file. Top-level settings are defaults shared by every entry in `conversions`. */
export interface ConfigFile {
  /** Absolute path of the file the config was read from. */
  path: string;
  /** Top-level settings, used as defaults for each conversion. */
  defaults: ConversionConfig;
  /** Named conversions. Empty when the file describes a single conversion at the top level. */
  conversions: ConversionConfig[];
}

const CONVERSION_KEYS: readonly string[] = [
  'name',
  'input',
  'output',
  'from',
  'to',
  'naming',
  'provider',
  'header',
  'appLabel',
  'autoField',
  'namespace',
];

/**
 * Looks for a config file in `startDirectory` and each parent directory. The
 * search stops after the first directory that contains a package.json (the
 * project root) and at the filesystem root. Returns undefined when none exists.
 */
export async function findConfigFile(
  startDirectory: string
): Promise<string | undefined> {
  let directory: string = resolve(startDirectory);
  for (;;) {
    for (const name of CONFIG_FILE_NAMES) {
      const candidate: string = join(directory, name);
      if (await isFile(candidate)) {
        return candidate;
      }
    }
    if (await isFile(join(directory, 'package.json'))) {
      return undefined;
    }
    const parent: string = dirname(directory);
    if (parent === directory) {
      return undefined;
    }
    directory = parent;
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/** Reads and validates a JSON config file. Relative paths inside it resolve against its directory. */
export async function loadConfigFile(
  path: string
): Promise<Result<ConfigFile>> {
  const absolutePath: string = resolve(path);
  let text: string;
  try {
    text = await readFile(absolutePath, 'utf8');
  } catch (thrown) {
    return err(
      'INVALID_CONFIG',
      `Could not read the config file "${absolutePath}": ${describeThrown(thrown)}`
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (thrown) {
    return err(
      'INVALID_CONFIG',
      `The config file "${absolutePath}" is not valid JSON: ${describeThrown(thrown)}`
    );
  }
  return parseConfig(raw, absolutePath);
}

/** Validates already-parsed JSON. Every message names the config file and the offending key. */
export function parseConfig(raw: unknown, path: string): Result<ConfigFile> {
  const fail = (message: string): Result<ConfigFile> =>
    err('INVALID_CONFIG', `${path}: ${message}`);

  if (!isRecord(raw)) {
    return fail('the config must be a JSON object.');
  }
  const baseDirectory: string = dirname(path);
  const topLevel: Record<string, unknown> = {};
  let rawConversions: unknown;
  for (const [key, value] of Object.entries(raw)) {
    if (key === '$schema') {
      continue;
    }
    if (key === 'conversions') {
      rawConversions = value;
    } else if (key === 'name') {
      return fail(
        '"name" is only valid inside an entry of "conversions", not at the top level.'
      );
    } else {
      topLevel[key] = value;
    }
  }

  const defaults: Result<ConversionConfig> = parseConversion(
    topLevel,
    '',
    baseDirectory
  );
  if (!defaults.ok) {
    return fail(defaults.error.message);
  }

  const conversions: ConversionConfig[] = [];
  if (rawConversions !== undefined) {
    if (!Array.isArray(rawConversions) || rawConversions.length === 0) {
      return fail('"conversions" must be a non-empty array of objects.');
    }
    const names: Set<string> = new Set<string>();
    for (const [index, entry] of (rawConversions as unknown[]).entries()) {
      if (!isRecord(entry)) {
        return fail(`"conversions[${index}]" must be an object.`);
      }
      const parsed: Result<ConversionConfig> = parseConversion(
        entry,
        `conversions[${index}].`,
        baseDirectory
      );
      if (!parsed.ok) {
        return fail(parsed.error.message);
      }
      const name: string | undefined = parsed.value.name;
      if (name !== undefined) {
        if (names.has(name)) {
          return fail(
            `"conversions[${index}].name" duplicates the name "${name}" used by another conversion.`
          );
        }
        names.add(name);
      }
      conversions.push(parsed.value);
    }
  }
  return ok({ path, defaults: defaults.value, conversions });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function describeValue(value: unknown): string {
  return JSON.stringify(value) ?? String(value);
}

/** Validates one conversion object. Error messages name the key (with its prefix) and the problem. */
function parseConversion(
  raw: Record<string, unknown>,
  prefix: string,
  baseDirectory: string
): Result<ConversionConfig> {
  const fail = (key: string, problem: string): Result<ConversionConfig> =>
    err('INVALID_CONFIG', `"${prefix}${key}" ${problem}`);
  const config: ConversionConfig = {};

  for (const key of Object.keys(raw)) {
    if (!CONVERSION_KEYS.includes(key)) {
      const valid: string[] = CONVERSION_KEYS.filter(
        (candidate: string) => prefix !== '' || candidate !== 'name'
      );
      if (prefix === '') {
        valid.push('conversions');
      }
      return err(
        'INVALID_CONFIG',
        `unknown key "${prefix}${key}". Valid keys: ${valid.join(', ')}.`
      );
    }
  }

  for (const key of ['name', 'from', 'to', 'appLabel', 'namespace'] as const) {
    const value: unknown = raw[key];
    if (value === undefined) {
      continue;
    }
    if (typeof value !== 'string' || value.trim() === '') {
      return fail(
        key,
        `must be a non-empty string (got ${describeValue(value)}).`
      );
    }
    config[key] = value;
  }

  const output: unknown = raw['output'];
  if (output !== undefined) {
    if (typeof output !== 'string' || output.trim() === '') {
      return fail(
        'output',
        `must be a non-empty path string (got ${describeValue(output)}).`
      );
    }
    config.output = resolve(baseDirectory, output);
  }

  const input: unknown = raw['input'];
  if (input !== undefined) {
    const entries: unknown[] = Array.isArray(input) ? input : [input];
    if (
      entries.length === 0 ||
      entries.some(
        (entry: unknown) => typeof entry !== 'string' || entry === ''
      )
    ) {
      return fail(
        'input',
        `must be a path string or a non-empty array of path strings (got ${describeValue(input)}).`
      );
    }
    config.input = (entries as string[]).map((entry: string) =>
      resolve(baseDirectory, entry)
    );
  }

  const naming: unknown = raw['naming'];
  if (naming !== undefined) {
    if (naming !== 'preserve' && naming !== 'normalize') {
      return fail(
        'naming',
        `must be "preserve" or "normalize" (got ${describeValue(naming)}).`
      );
    }
    config.naming = naming;
  }

  const provider: unknown = raw['provider'];
  if (provider !== undefined) {
    if (
      typeof provider !== 'string' ||
      !(PRISMA_PROVIDERS as readonly string[]).includes(provider)
    ) {
      return fail(
        'provider',
        `must be one of ${PRISMA_PROVIDERS.join(', ')} (got ${describeValue(provider)}).`
      );
    }
    config.provider = provider;
  }

  const header: unknown = raw['header'];
  if (header !== undefined) {
    if (typeof header !== 'boolean') {
      return fail(
        'header',
        `must be true or false (got ${describeValue(header)}).`
      );
    }
    config.header = header;
  }

  const autoField: unknown = raw['autoField'];
  if (autoField !== undefined) {
    const lowered: string | undefined =
      typeof autoField === 'string' ? autoField.toLowerCase() : undefined;
    if (lowered !== 'int' && lowered !== 'bigint') {
      return fail(
        'autoField',
        `must be "int" or "bigint" (got ${describeValue(autoField)}).`
      );
    }
    config.autoField = lowered;
  }
  return ok(config);
}
