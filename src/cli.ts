#!/usr/bin/env node
import { createRequire } from 'node:module';
import { extname } from 'node:path';
import { Command } from 'commander';
import { PRISMA_PROVIDERS, type PrismaProvider } from './emitters/prisma.js';
import {
  getFormat,
  describeFormats,
  getFormatByExtension,
  listFormatNames,
  listFormats,
  type FormatAdapter,
  type FormatName,
} from './formats.js';
import { runConversion, type RunOptions, type RunSummary } from './io.js';
import type { Result } from './result.js';
import type { NamingMode } from './transforms.js';

interface ConvertFlags {
  from?: string;
  to?: string;
  input: string[];
  output?: string;
  naming: string;
  provider: string;
  header: boolean;
  appLabel?: string;
  autoField: string;
}

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

/** Validates the raw CLI flags and builds the options for the conversion. Returns a message on failure. */
function buildRunOptions(flags: ConvertFlags): Result<RunOptions> {
  const failure = (message: string): Result<RunOptions> => ({
    ok: false,
    error: { code: 'INVALID_OPTION', message },
  });

  const inferredFrom: FormatName | undefined = inferFormatFromPath(
    flags.input[0]
  );
  const fromValue: string | undefined = flags.from ?? inferredFrom ?? 'django';
  if (!getFormat(fromValue).ok) {
    return failure(
      `Invalid --from value "${fromValue}". Expected one of: ${listFormatNames().join(', ')}.`
    );
  }

  const inferredTo: FormatName | undefined = inferFormatFromPath(flags.output);
  const toValue: string =
    flags.to ?? inferredTo ?? (fromValue === 'django' ? 'prisma' : 'django');
  if (!getFormat(toValue).ok) {
    return failure(
      `Invalid --to value "${toValue}". Expected one of: ${listFormatNames().join(', ')}.`
    );
  }

  if (flags.naming !== 'preserve' && flags.naming !== 'normalize') {
    return failure(
      `Invalid --naming value "${flags.naming}". Expected "preserve" or "normalize".`
    );
  }
  const naming: NamingMode = flags.naming;

  if (!(PRISMA_PROVIDERS as readonly string[]).includes(flags.provider)) {
    return failure(
      `Invalid --provider value "${flags.provider}". Expected one of: ${PRISMA_PROVIDERS.join(', ')}.`
    );
  }
  const provider: PrismaProvider = flags.provider as PrismaProvider;

  const autoFieldValue: string = flags.autoField.toLowerCase();
  if (autoFieldValue !== 'int' && autoFieldValue !== 'bigint') {
    return failure(
      `Invalid --auto-field value "${flags.autoField}". Expected "int" or "bigint".`
    );
  }

  return {
    ok: true,
    value: {
      from: fromValue,
      to: toValue,
      naming,
      provider,
      header: flags.header,
      autoField: autoFieldValue === 'bigint' ? 'bigInt' : 'int',
      inputs: flags.input,
      ...(flags.output === undefined ? {} : { output: flags.output }),
      ...(flags.appLabel === undefined ? {} : { appLabel: flags.appLabel }),
    },
  };
}

async function handleConvert(flags: ConvertFlags): Promise<number> {
  const options: Result<RunOptions> = buildRunOptions(flags);
  if (!options.ok) {
    process.stderr.write(
      `error [${options.error.code}]: ${options.error.message}\n`
    );
    return 1;
  }

  const summary: Result<RunSummary> = await runConversion(options.value);
  if (!summary.ok) {
    process.stderr.write(
      `error [${summary.error.code}]: ${summary.error.message}\n`
    );
    return 1;
  }

  for (const warning of summary.value.warnings) {
    process.stderr.write(`warning: ${warning}\n`);
  }
  if (summary.value.outputPath === undefined) {
    process.stdout.write(summary.value.output);
  } else {
    process.stderr.write(
      `Converted ${summary.value.modelCount} model(s) from ${summary.value.inputFiles.length} file(s) ` +
        `(${options.value.from} -> ${options.value.to}): ${summary.value.outputPath}\n`
    );
  }
  return 0;
}

async function main(): Promise<number> {
  const program: Command = new Command();
  program
    .name('ormbridge')
    .description('Convert ORM schemas between Django models and Prisma.')
    .version(readPackageVersion());

  let exitCode: number = 0;
  program
    .command('convert')
    .description('Convert models from one ORM format to another')
    .requiredOption(
      '-i, --input <paths...>',
      'file(s) or directories to read (models.py, models/ package, or .prisma)'
    )
    .option(
      '-o, --output <path>',
      'file to write; prints to stdout when omitted'
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
      'preserve existing database names, or normalize to singular snake_case + UUID ids',
      'preserve'
    )
    .option(
      '--provider <name>',
      `Prisma datasource provider (${PRISMA_PROVIDERS.join(' | ')})`,
      'postgresql'
    )
    .option('--no-header', 'omit the Prisma generator and datasource blocks')
    .option(
      '--app-label <name>',
      'Django app label used for default table names (default: derived from the directory)'
    )
    .option(
      '--auto-field <type>',
      'primary key type for Django models without one (int | bigint)',
      'int'
    )
    .action(async (flags: ConvertFlags): Promise<void> => {
      exitCode = await handleConvert(flags);
    });

  program
    .command('formats')
    .description(
      'List the supported formats, their file extensions, and whether each can be read and/or written'
    )
    .action((): void => {
      process.stdout.write(describeFormats(listFormats()));
    });

  await program.parseAsync(process.argv);
  return exitCode;
}

main()
  .then((exitCode: number) => {
    process.exitCode = exitCode;
  })
  .catch((thrown: unknown) => {
    const message: string =
      thrown instanceof Error ? thrown.message : String(thrown);
    process.stderr.write(`error: ${message}\n`);
    process.exitCode = 1;
  });
