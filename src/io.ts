import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';
import {
  convertText,
  type ConvertOptions,
  type ConvertResult,
  type FormatName,
  type SourceText,
} from './convert.js';
import { describeThrown, err, ok, type Result } from './result.js';

const SKIPPED_DIRECTORIES: ReadonlySet<string> = new Set([
  'node_modules',
  'venv',
  '.venv',
  'env',
  '.git',
  '__pycache__',
  'migrations',
  'site-packages',
  'dist',
  'build',
]);

export interface RunOptions extends ConvertOptions {
  /** Files or directories to read. */
  inputs: string[];
  /** Destination file. When omitted the converted text is only returned. */
  output?: string;
}

export interface RunSummary extends ConvertResult {
  inputFiles: string[];
  outputPath?: string;
}

/** Reads the inputs, converts them, and writes the result to the output path when one is given. */
export async function runConversion(
  options: RunOptions
): Promise<Result<RunSummary>> {
  const discovered: Result<string[]> = await discoverInputFiles(
    options.inputs,
    options.from
  );
  if (!discovered.ok) {
    return discovered;
  }

  const sources: SourceText[] = [];
  for (const filePath of discovered.value) {
    const read: Result<string> = await readTextFile(filePath);
    if (!read.ok) {
      return read;
    }
    sources.push({
      path: filePath,
      text: read.value,
      appLabel: deriveAppLabel(filePath),
    });
  }

  const converted: Result<ConvertResult> = await convertText(sources, options);
  if (!converted.ok) {
    return converted;
  }

  const summary: RunSummary = {
    ...converted.value,
    inputFiles: discovered.value,
  };
  if (options.output === undefined) {
    return ok(summary);
  }
  const written: Result<string> = await writeTextFile(
    options.output,
    converted.value.output
  );
  if (!written.ok) {
    return written;
  }
  return ok({ ...summary, outputPath: written.value });
}

async function readTextFile(filePath: string): Promise<Result<string>> {
  try {
    return ok(await readFile(filePath, 'utf8'));
  } catch (thrown) {
    return err(
      'INPUT_READ_FAILED',
      `Could not read "${filePath}": ${describeThrown(thrown)}`
    );
  }
}

async function writeTextFile(
  outputPath: string,
  text: string
): Promise<Result<string>> {
  const absolutePath: string = resolve(outputPath);
  try {
    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, text, 'utf8');
    return ok(absolutePath);
  } catch (thrown) {
    return err(
      'OUTPUT_WRITE_FAILED',
      `Could not write the output file "${absolutePath}": ${describeThrown(thrown)}`
    );
  }
}

/** Derives a Django app label from the location of a models.py file or models/ package. */
export function deriveAppLabel(filePath: string): string {
  const absolutePath: string = resolve(filePath);
  const directory: string = dirname(absolutePath);
  if (basename(directory) === 'models') {
    return basename(dirname(directory));
  }
  return basename(directory);
}

async function discoverInputFiles(
  inputs: string[],
  format: FormatName
): Promise<Result<string[]>> {
  const files: string[] = [];
  for (const input of inputs) {
    let inputStat: Awaited<ReturnType<typeof stat>>;
    try {
      inputStat = await stat(input);
    } catch {
      return err(
        'INPUT_NOT_FOUND',
        `The input path "${input}" does not exist or is not readable.`
      );
    }
    if (inputStat.isDirectory()) {
      files.push(...(await walkDirectory(input, format)));
    } else {
      files.push(input);
    }
  }
  if (files.length === 0) {
    const expected: string =
      format === 'django'
        ? 'models.py files (or a models/ package)'
        : '.prisma files';
    return err(
      'NO_INPUT_FILES',
      `No ${expected} were found in: ${inputs.join(', ')}.`
    );
  }
  return ok(files);
}

function isRelevantFile(filePath: string, format: FormatName): boolean {
  if (format === 'prisma') {
    return extname(filePath) === '.prisma';
  }
  const parentName: string = basename(dirname(filePath));
  const fileName: string = basename(filePath);
  if (fileName === 'models.py') {
    return true;
  }
  return (
    parentName === 'models' &&
    extname(fileName) === '.py' &&
    fileName !== '__init__.py'
  );
}

async function walkDirectory(
  directory: string,
  format: FormatName
): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const found: string[] = [];
  for (const entry of entries.sort((first, second) =>
    first.name.localeCompare(second.name)
  )) {
    const entryPath: string = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRECTORIES.has(entry.name)) {
        found.push(...(await walkDirectory(entryPath, format)));
      }
    } else if (isRelevantFile(entryPath, format)) {
      found.push(entryPath);
    }
  }
  return found;
}
