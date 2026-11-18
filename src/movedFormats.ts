import type { FormatAdapter } from './formats.js';
import { err, type Result } from './result.js';

/**
 * Formats that moved out of the core package into addon packages. Core keeps a stub for each, so `--from` and `--to`
 * still accept the name and fail with a message that names the package to install; loading the package (see
 * `registerFormat`) replaces the stub with the real format.
 */
export interface MovedFormat {
  /** The format name used by `--from` and `--to`. */
  name: string;
  /** The npm package that has the format now. */
  packageName: string;
  /** What the format is, as `ormbridge formats` shows it. */
  description: string;
  /** True when the format reads source files. */
  read: boolean;
  /** True when the format writes files. */
  write: boolean;
}

export const MOVED_FORMATS: readonly MovedFormat[] = [
  {
    name: 'graphene',
    packageName: 'ormbridge-graphene',
    description: 'Graphene (graphene-django) GraphQL schema',
    read: false,
    write: true,
  },
];

/** The message of a stub: what moved, what to install, and how to load it. */
export function movedMessage(moved: MovedFormat): string {
  return (
    `The "${moved.name}" format moved out of the core package into ${moved.packageName}. ` +
    `Install it (npm install ${moved.packageName}) and load it with --plugin ${moved.packageName}, ` +
    `or add "plugins": ["${moved.packageName}"] to the config file.`
  );
}

/** The stub adapter of a moved format. */
export function movedStub(name: string): FormatAdapter {
  const moved: MovedFormat | undefined = MOVED_FORMATS.find(
    (candidate: MovedFormat) => candidate.name === name
  );
  if (moved === undefined) {
    throw new Error(`"${name}" is not in the list of moved formats.`);
  }
  const fail = (): Result<never> =>
    err('UNSUPPORTED_CONVERSION', movedMessage(moved));
  return {
    name: moved.name,
    extensions: [],
    description: `${moved.description} (moved to ${moved.packageName})`,
    movedTo: { packageName: moved.packageName },
    ...(moved.read ? { parse: () => Promise.resolve(fail()) } : {}),
    ...(moved.write ? { emit: fail } : {}),
  };
}
