import { createRequire } from 'node:module';
import { extname, isAbsolute, relative, resolve } from 'node:path';
import { Command, CommanderError } from 'commander';
import {
  findConfigFile,
  loadConfigFile,
  type ConfigFile,
  type ConversionConfig,
} from './config.js';
import {
  PRISMA_PROVIDERS,
  type PrismaProvider,
  type PrismaVersion,
} from './emitters/prisma.js';
import {
  describeFormats,
  getFormat,
  getFormatByExtension,
  listFormatNames,
  listFormats,
  type FormatAdapter,
  type FormatName,
} from './formats.js';
import {
  countLines,
  runConversion,
  type PlannedFile,
  type RunOptions,
  type RunSummary,
} from './io.js';
import type { Result } from './result.js';
import type { NamingMode } from './transforms.js';

/** Exit codes of the `ormbridge` command. */
export const EXIT_OK: number = 0;
/** A conversion failed: unreadable input, parse error, unwritable output. */
export const EXIT_CONVERSION_ERROR: number = 1;
/** The command line or the config file is invalid. */
export const EXIT_USAGE_ERROR: number = 2;
/** `--check` found an output file that is stale or missing. */
export const EXIT_CHECK_FAILED: number = 3;

/** Where the CLI reads its working directory from and writes its output to. */
export interface CliEnvironment {
  cwd: string;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

interface ConvertFlags {
  input?: string[];
  output?: string;
  from?: string;
  to?: string;
  naming?: string;
  provider?: string;
  header: boolean;
  appLabel?: string;
  autoField?: string;
  namespace?: string;
  goPackage?: string;
  prismaVersion?: string;
  /** A path, or false when --no-config was given. */
  config?: string | boolean;
  dryRun?: boolean;
  check?: boolean;
}

/** One conversion after the config file and the flags have been merged. */
interface PlannedRun {
  /** Name shown in messages; undefined when there is only one unnamed conversion. */
  label: string | undefined;
  options: RunOptions;
}

type RunMode = 'write' | 'dry-run' | 'check';

function readPackageVersion(): string {
  const requireFromHere: NodeRequire = createRequire(import.meta.url);
  const packageJson: { version?: string } = requireFromHere(
    '../package.json'
  ) as { version?: string };
  return packageJson.version ?? '0.0.0';
}

function inferFormatFromPath(
  filePath: string | undefined
): FormatName | undefined {
  if (filePath === undefined) {
    return undefined;
  }
  const adapter: FormatAdapter | undefined = getFormatByExtension(
    extname(filePath)
  );
  return adapter?.name;
}

function failure<T>(code: 'INVALID_OPTION', message: string): Result<T> {
  return { ok: false, error: { code, message } };
}

/** The settings of one conversion before defaults and inference are applied. */
interface MergedSettings {
  input?: string[];
  output?: string;
  from?: string;
  to?: string;
  naming?: string;
  provider?: string;
  header?: boolean;
  appLabel?: string;
  autoField?: string;
  namespace?: string;
  goPackage?: string;
  /** A number from the config file or the raw text of the flag. */
  prismaVersion?: number | string;
}

/** Validates merged settings and builds the options for one conversion. */
function buildRunOptions(
  settings: MergedSettings,
  mode: RunMode
): Result<RunOptions> {
  const inputs: string[] = settings.input ?? [];
  if (inputs.length === 0) {
    return failure(
      'INVALID_OPTION',
      'No input was given. Pass -i/--input, or set "input" in the config file.'
    );
  }
  if (mode === 'check' && settings.output === undefined) {
    return failure(
      'INVALID_OPTION',
      '--check compares the conversion with an existing output, so an output path is required. Pass -o/--output, or set "output" in the config file.'
    );
  }

  const fromValue: string =
    settings.from ?? inferFormatFromPath(inputs[0]) ?? 'django';
  if (!getFormat(fromValue).ok) {
    return failure(
      'INVALID_OPTION',
      `Invalid --from value "${fromValue}". Expected one of: ${listFormatNames().join(', ')}.`
    );
  }

  const toValue: string =
    settings.to ??
    inferFormatFromPath(settings.output) ??
    (fromValue === 'django' ? 'prisma' : 'django');
  if (!getFormat(toValue).ok) {
    return failure(
      'INVALID_OPTION',
      `Invalid --to value "${toValue}". Expected one of: ${listFormatNames().join(', ')}.`
    );
  }

  const namingValue: string = settings.naming ?? 'preserve';
  if (namingValue !== 'preserve' && namingValue !== 'normalize') {
    return failure(
      'INVALID_OPTION',
      `Invalid --naming value "${namingValue}". Expected "preserve" or "normalize".`
    );
  }
  const naming: NamingMode = namingValue;

  const providerValue: string = settings.provider ?? 'postgresql';
  if (!(PRISMA_PROVIDERS as readonly string[]).includes(providerValue)) {
    return failure(
      'INVALID_OPTION',
      `Invalid --provider value "${providerValue}". Expected one of: ${PRISMA_PROVIDERS.join(', ')}.`
    );
  }
  const provider: PrismaProvider = providerValue as PrismaProvider;

  const autoFieldValue: string = (settings.autoField ?? 'int').toLowerCase();
  if (autoFieldValue !== 'int' && autoFieldValue !== 'bigint') {
    return failure(
      'INVALID_OPTION',
      `Invalid --auto-field value "${settings.autoField ?? ''}". Expected "int" or "bigint".`
    );
  }

  let prismaVersion: PrismaVersion | undefined;
  if (settings.prismaVersion !== undefined) {
    const versionText: string = String(settings.prismaVersion).trim();
    if (versionText !== '6' && versionText !== '7') {
      return failure(
        'INVALID_OPTION',
        `Invalid --prisma-version value "${String(settings.prismaVersion)}". Expected 6 or 7.`
      );
    }
    prismaVersion = versionText === '7' ? 7 : 6;
  }

  return {
    ok: true,
    value: {
      from: fromValue,
      to: toValue,
      naming,
      provider,
      header: settings.header ?? true,
      autoField: autoFieldValue === 'bigint' ? 'bigInt' : 'int',
      inputs,
      dryRun: mode === 'dry-run',
      check: mode === 'check',
      ...(settings.output === undefined ? {} : { output: settings.output }),
      ...(settings.appLabel === undefined
        ? {}
        : { appLabel: settings.appLabel }),
      ...(settings.namespace === undefined
        ? {}
        : { namespace: settings.namespace }),
      ...(settings.goPackage === undefined
        ? {}
        : { goPackage: settings.goPackage }),
      ...(prismaVersion === undefined ? {} : { prismaVersion }),
    },
  };
}

/** Finds and loads the config file according to --config / --no-config. */
async function resolveConfig(
  flags: ConvertFlags,
  env: CliEnvironment
): Promise<Result<ConfigFile | undefined>> {
  if (flags.config === false) {
    return { ok: true, value: undefined };
  }
  if (typeof flags.config === 'string') {
    return loadConfigFile(resolve(env.cwd, flags.config));
  }
  const found: string | undefined = await findConfigFile(env.cwd);
  if (found === undefined) {
    return { ok: true, value: undefined };
  }
  return loadConfigFile(found);
}

/**
 * Merges the config file and the flags into the conversions to run. Flags
 * override config values. With no -i and a config that lists `conversions`,
 * every listed conversion runs.
 */
function planRuns(
  flags: ConvertFlags,
  headerFromFlag: boolean | undefined,
  config: ConfigFile | undefined,
  env: CliEnvironment,
  mode: RunMode
): Result<PlannedRun[]> {
  const useConversionList: boolean =
    config !== undefined &&
    config.conversions.length > 0 &&
    flags.input === undefined;
  const entries: ConversionConfig[] =
    config === undefined
      ? [{}]
      : useConversionList
        ? config.conversions.map(
            (conversion: ConversionConfig): ConversionConfig => ({
              ...config.defaults,
              ...conversion,
            })
          )
        : [config.defaults];

  if (entries.length > 1 && flags.output !== undefined) {
    return failure(
      'INVALID_OPTION',
      `--output cannot be combined with the ${entries.length} conversions in the config file, because they would all write to the same path. Remove -o, or pass -i to run a single conversion.`
    );
  }

  const runs: PlannedRun[] = [];
  for (const [index, entry] of entries.entries()) {
    const label: string | undefined =
      entries.length === 1 ? undefined : (entry.name ?? `#${index + 1}`);
    const settings: MergedSettings = { ...entry };
    if (flags.input !== undefined) {
      settings.input = flags.input.map((path: string) =>
        resolve(env.cwd, path)
      );
    }
    if (flags.output !== undefined) {
      settings.output = resolve(env.cwd, flags.output);
    }
    if (flags.from !== undefined) {
      settings.from = flags.from;
    }
    if (flags.to !== undefined) {
      settings.to = flags.to;
    }
    if (flags.naming !== undefined) {
      settings.naming = flags.naming;
    }
    if (flags.provider !== undefined) {
      settings.provider = flags.provider;
    }
    if (headerFromFlag !== undefined) {
      settings.header = headerFromFlag;
    }
    if (flags.appLabel !== undefined) {
      settings.appLabel = flags.appLabel;
    }
    if (flags.autoField !== undefined) {
      settings.autoField = flags.autoField;
    }
    if (flags.namespace !== undefined) {
      settings.namespace = flags.namespace;
    }
    if (flags.goPackage !== undefined) {
      settings.goPackage = flags.goPackage;
    }
    if (flags.prismaVersion !== undefined) {
      settings.prismaVersion = flags.prismaVersion;
    }
    const options: Result<RunOptions> = buildRunOptions(settings, mode);
    if (!options.ok) {
      const where: string = label === undefined ? '' : `conversion ${label}: `;
      return failure('INVALID_OPTION', `${where}${options.error.message}`);
    }
    runs.push({ label, options: options.value });
  }
  return { ok: true, value: runs };
}

function formatBytes(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}

function describeFile(file: PlannedFile): string {
  return `${file.lines} line(s), ${formatBytes(file.bytes)}`;
}

/** Shows a path relative to the working directory when it is inside it. */
function displayPath(path: string, cwd: string): string {
  const relativePath: string = relative(cwd, path);
  return relativePath !== '' &&
    !relativePath.startsWith('..') &&
    !isAbsolute(relativePath)
    ? relativePath
    : path;
}

/** Prints the result of one conversion. Returns true when --check found it stale. */
function report(
  run: PlannedRun,
  summary: RunSummary,
  mode: RunMode,
  env: CliEnvironment
): boolean {
  const prefix: string = run.label === undefined ? '' : `[${run.label}] `;
  const options: RunOptions = run.options;
  for (const warning of summary.warnings) {
    env.stderr(`${prefix}warning: ${warning}\n`);
  }
  const description: string =
    `${summary.modelCount} model(s) from ${summary.inputFiles.length} file(s) ` +
    `(${options.from} -> ${options.to})`;

  if (summary.outputPath === undefined) {
    if (mode === 'dry-run') {
      env.stderr(
        `${prefix}Dry run: converted ${description}; the result would be printed to stdout (${countLines(summary.output)} line(s)).\n`
      );
    } else {
      env.stdout(summary.output);
    }
    return false;
  }

  let stale: boolean = false;
  if (mode === 'check') {
    for (const file of summary.plannedFiles) {
      const path: string = displayPath(file.path, env.cwd);
      if (file.state === 'unchanged') {
        env.stderr(`${prefix}up to date: ${path}\n`);
      } else {
        stale = true;
        env.stderr(
          file.state === 'created'
            ? `${prefix}error: ${path} is missing; the conversion would create it (${describeFile(file)}).\n`
            : `${prefix}error: ${path} is out of date: ${file.diff ?? 'contents differ'}.\n`
        );
      }
    }
    return stale;
  }

  const heading: string =
    mode === 'dry-run'
      ? `Dry run, nothing written: ${description}`
      : `Converted ${description}`;
  env.stderr(`${prefix}${heading}\n`);
  for (const file of summary.plannedFiles) {
    const path: string = displayPath(file.path, env.cwd);
    const verb: string =
      file.state === 'unchanged'
        ? 'unchanged'
        : mode === 'dry-run'
          ? file.state === 'created'
            ? 'would create'
            : 'would update'
          : file.state === 'created'
            ? 'created'
            : 'updated';
    const detail: string =
      file.diff === undefined
        ? describeFile(file)
        : `${describeFile(file)}; ${file.diff}`;
    env.stderr(`${prefix}  ${verb} ${path} (${detail})\n`);
  }
  return false;
}

async function handleConvert(
  flags: ConvertFlags,
  headerFromFlag: boolean | undefined,
  env: CliEnvironment
): Promise<number> {
  const usageError = (message: string): number => {
    env.stderr(`error [USAGE]: ${message}\n`);
    return EXIT_USAGE_ERROR;
  };
  if (flags.check === true && flags.dryRun === true) {
    return usageError(
      '--check and --dry-run cannot be combined: --check already writes nothing.'
    );
  }
  const mode: RunMode =
    flags.check === true
      ? 'check'
      : flags.dryRun === true
        ? 'dry-run'
        : 'write';

  const config: Result<ConfigFile | undefined> = await resolveConfig(
    flags,
    env
  );
  if (!config.ok) {
    return usageError(config.error.message);
  }
  const runs: Result<PlannedRun[]> = planRuns(
    flags,
    headerFromFlag,
    config.value,
    env,
    mode
  );
  if (!runs.ok) {
    return usageError(runs.error.message);
  }
  if (config.value !== undefined && runs.value.length > 1) {
    env.stderr(
      `Using ${displayPath(config.value.path, env.cwd)}: ${runs.value.length} conversions\n`
    );
  }

  let failedConversions: number = 0;
  let staleOutputs: number = 0;
  for (const run of runs.value) {
    const prefix: string = run.label === undefined ? '' : `[${run.label}] `;
    const summary: Result<RunSummary> = await runConversion(run.options);
    if (!summary.ok) {
      env.stderr(
        `${prefix}error [${summary.error.code}]: ${summary.error.message}\n`
      );
      failedConversions += 1;
      continue;
    }
    if (report(run, summary.value, mode, env)) {
      staleOutputs += 1;
    }
  }

  if (failedConversions > 0) {
    return EXIT_CONVERSION_ERROR;
  }
  if (staleOutputs > 0) {
    env.stderr(
      'Generated output is stale. Run "ormbridge convert" without --check to regenerate it.\n'
    );
    return EXIT_CHECK_FAILED;
  }
  return EXIT_OK;
}

/**
 * Runs the CLI with the given arguments (without the node and script
 * entries) and returns the exit code. Nothing is written to the real
 * process streams, so tests can call this in-process.
 */
export async function runCli(
  argv: string[],
  env: CliEnvironment
): Promise<number> {
  const program: Command = new Command();
  program
    .name('ormbridge')
    .description(
      'Convert ORM schemas between Django, Prisma, TypeORM and more.'
    )
    .version(readPackageVersion())
    .exitOverride()
    .configureOutput({ writeOut: env.stdout, writeErr: env.stderr });

  let exitCode: number = EXIT_OK;
  program
    .command('convert')
    .description('Convert models from one ORM format to another')
    .option(
      '-i, --input <paths...>',
      'file(s) or directories to read (models.py, models/ package, or .prisma); optional when a config file supplies them'
    )
    .option(
      '-o, --output <path>',
      'file to write (a directory for formats that produce several files); prints to stdout when omitted'
    )
    .option(
      '-f, --from <format>',
      `source format (${listFormatNames().join(' | ')}); inferred from the input when omitted`
    )
    .option(
      '-t, --to <format>',
      `target format (${listFormatNames().join(' | ')}); inferred from the output when omitted`
    )
    .option(
      '--naming <mode>',
      'preserve existing database names, or normalize to singular snake_case + UUID ids (default: preserve)'
    )
    .option(
      '--provider <name>',
      `Prisma datasource provider (${PRISMA_PROVIDERS.join(' | ')}) (default: postgresql)`
    )
    .option('--no-header', 'omit the Prisma generator and datasource blocks')
    .option(
      '--app-label <name>',
      'Django app label used for default table names (default: derived from the directory)'
    )
    .option(
      '--auto-field <type>',
      'primary key type for Django models without one (int | bigint) (default: int)'
    )
    .option(
      '--namespace <name>',
      'PHP namespace of the Doctrine entities (default: App\\Entity) or Laravel models (default: App\\Models)'
    )
    .option(
      '--go-package <name>',
      'Go package name of the GORM models (default: models)'
    )
    .option(
      '--prisma-version <version>',
      'Prisma major version of the generator and datasource blocks (6 | 7) (default: 6; 7 writes the prisma-client generator and no datasource url)'
    )
    .option(
      '--dry-run',
      'run the conversion and report what would be written, without touching any file'
    )
    .option(
      '--check',
      'exit with code 3 if an output file is missing or differs from the conversion; writes nothing'
    )
    .option(
      '--config <path>',
      'read settings from this JSON config file instead of searching for ormbridge.config.json'
    )
    .option('--no-config', 'ignore any config file')
    .action(async (flags: ConvertFlags, command: Command): Promise<void> => {
      const conflict: boolean =
        argv.includes('--no-config') &&
        argv.some(
          (arg: string) => arg === '--config' || arg.startsWith('--config=')
        );
      if (conflict) {
        env.stderr(
          'error [USAGE]: --config and --no-config cannot be combined.\n'
        );
        exitCode = EXIT_USAGE_ERROR;
        return;
      }
      const headerFromFlag: boolean | undefined =
        command.getOptionValueSource('header') === 'cli'
          ? flags.header
          : undefined;
      exitCode = await handleConvert(flags, headerFromFlag, env);
    });

  program
    .command('formats')
    .description(
      'List the supported formats, their file extensions, and whether each can be read and/or written'
    )
    .action((): void => {
      env.stdout(describeFormats(listFormats()));
    });

  try {
    await program.parseAsync(argv, { from: 'user' });
  } catch (thrown) {
    if (thrown instanceof CommanderError) {
      // Commander already printed the message; help and version are not failures.
      return thrown.exitCode === 0 ? EXIT_OK : EXIT_USAGE_ERROR;
    }
    throw thrown;
  }
  return exitCode;
}
