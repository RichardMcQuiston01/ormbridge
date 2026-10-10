import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  resolve,
} from 'node:path';
import {
  convertText,
  type ConvertOptions,
  type ConvertResult,
  type FormatName,
  type SourceText,
} from './convert.js';
import { describeThrown, err, ok, type Result } from './result.js';

/** Directories skipped only when reading PHP projects: Composer packages and Symfony's cache/log directory. */
const PHP_SKIPPED_DIRECTORIES: ReadonlySet<string> = new Set(['vendor', 'var']);

/** Directories skipped when reading Go projects: vendored modules and Go's conventional test data. */
const GO_SKIPPED_DIRECTORIES: ReadonlySet<string> = new Set([
  'vendor',
  'node_modules',
  'testdata',
  '.git',
]);

/**
 * Directories skipped when reading a Laravel project. The Django list does not
 * apply: `migrations` is where Laravel keeps its schema, and `build` / `env` /
 * `dist` are ordinary names there.
 */
const LARAVEL_SKIPPED_DIRECTORIES: ReadonlySet<string> = new Set([
  'vendor',
  'storage',
  'node_modules',
  'tests',
  '.git',
]);

/** Directories skipped when reading JSON Schema documents. */
const JSON_SCHEMA_SKIPPED_DIRECTORIES: ReadonlySet<string> = new Set([
  'vendor',
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.git',
]);

/** JSON files that are tool configuration and never hold a schema. */
const NON_SCHEMA_JSON_FILES: RegExp =
  /^(package(-lock)?|npm-shrinkwrap|composer(\.lock)?|tsconfig(\..+)?|jsconfig|\.eslintrc|\.prettierrc|deno)\.json$/;

/**
 * Directories skipped when reading SQL files. `migrations` is deliberately not on the list: plain SQL
 * migrations are a legitimate source and are read in file-name order.
 */
const SQL_SKIPPED_DIRECTORIES: ReadonlySet<string> = new Set([
  'node_modules',
  'vendor',
  'venv',
  '.venv',
  'dist',
  'build',
  'coverage',
  '__pycache__',
  '.git',
]);

/** Rollback scripts (`001_init.down.sql`, `down.sql`, `V2__x.undo.sql`) undo a schema instead of describing it. */
const SQL_ROLLBACK_FILES: RegExp =
  /(?:^|[._-])(?:down|rollback|revert|undo)\.sql$/i;

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
  /**
   * Destination. A file path for single-text formats; a directory for formats
   * that yield several files. When omitted the converted text is only returned.
   */
  output?: string;
  /** Run the whole conversion and report what would be written, without touching the filesystem. */
  dryRun?: boolean;
  /** Compare the result with the existing output and report differences, without writing. */
  check?: boolean;
}

/** How a planned output file relates to what is on disk. */
export type OutputState = 'created' | 'changed' | 'unchanged';

/** One file the conversion produces, with its relation to the existing file. */
export interface PlannedFile {
  /** Absolute destination path. */
  path: string;
  text: string;
  bytes: number;
  lines: number;
  state: OutputState;
  /** Short description of the differences for a changed file, such as "+3 -1 lines (first difference at line 12)". */
  diff?: string;
}

export interface RunSummary extends ConvertResult {
  inputFiles: string[];
  /** The output path as written: the file for single-text formats, the directory for multi-file formats. */
  outputPath?: string;
  /** Every file planned for the output path. Empty when no output path was given. */
  plannedFiles: PlannedFile[];
  /** True when files were written (never in dry-run or check mode). */
  written: boolean;
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
    plannedFiles: [],
    written: false,
  };
  if (options.output === undefined) {
    if (converted.value.files !== undefined) {
      return err(
        'INVALID_OPTION',
        `The "${options.to}" format produces ${Object.keys(converted.value.files).length} files, so it needs an output directory. Pass -o <directory>.`
      );
    }
    return ok(summary);
  }

  const planned: Result<PlannedFile[]> = await planOutput(
    resolve(options.output),
    converted.value,
    options.to
  );
  if (!planned.ok) {
    return planned;
  }
  const outputPath: string = resolve(options.output);
  const withPlan: RunSummary = {
    ...summary,
    outputPath,
    plannedFiles: planned.value,
  };
  if (options.dryRun === true || options.check === true) {
    return ok(withPlan);
  }
  for (const file of planned.value) {
    if (file.state === 'unchanged') {
      continue;
    }
    const written: Result<string> = await writeTextFile(file.path, file.text);
    if (!written.ok) {
      return written;
    }
  }
  return ok({ ...withPlan, written: true });
}

/** Works out the destination files and compares each with what is already on disk. */
async function planOutput(
  outputPath: string,
  converted: ConvertResult,
  format: FormatName
): Promise<Result<PlannedFile[]>> {
  const existing: 'file' | 'directory' | 'missing' | 'other' =
    await classifyPath(outputPath);
  const entries: Array<[string, string]> = [];
  if (converted.files === undefined) {
    if (existing === 'directory') {
      return err(
        'INVALID_OPTION',
        `The output path "${outputPath}" is a directory, but the "${format}" format produces a single file. Pass a file path to -o.`
      );
    }
    entries.push([outputPath, converted.output]);
  } else {
    const names: string[] = Object.keys(converted.files).sort();
    if (
      existing === 'file' ||
      (existing === 'missing' && extname(outputPath) !== '')
    ) {
      return err(
        'INVALID_OPTION',
        `The "${format}" format produces ${names.length} files (${names.join(', ')}), so -o must be a directory, but "${outputPath}" is a file path. Pass a directory such as "${join(dirname(outputPath), basename(outputPath, extname(outputPath)))}".`
      );
    }
    for (const name of names) {
      const target: Result<string> = resolveInside(outputPath, name);
      if (!target.ok) {
        return target;
      }
      entries.push([target.value, converted.files[name] ?? '']);
    }
  }

  const planned: PlannedFile[] = [];
  for (const [path, text] of entries) {
    const current: string | undefined = await readIfExists(path);
    const file: PlannedFile = {
      path,
      text,
      bytes: Buffer.byteLength(text, 'utf8'),
      lines: countLines(text),
      state:
        current === undefined
          ? 'created'
          : current === text
            ? 'unchanged'
            : 'changed',
    };
    if (current !== undefined && current !== text) {
      file.diff = summarizeDiff(current, text);
    }
    planned.push(file);
  }
  return ok(planned);
}

async function classifyPath(
  path: string
): Promise<'file' | 'directory' | 'missing' | 'other'> {
  try {
    const info = await stat(path);
    if (info.isDirectory()) {
      return 'directory';
    }
    return info.isFile() ? 'file' : 'other';
  } catch {
    return 'missing';
  }
}

async function readIfExists(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return undefined;
  }
}

/** Resolves an emitter-provided relative path under the output directory, rejecting escapes. */
function resolveInside(
  directory: string,
  relativePath: string
): Result<string> {
  if (
    relativePath === '' ||
    isAbsolute(relativePath) ||
    relativePath.split(/[\\/]/).includes('..')
  ) {
    return err(
      'EMIT_FAILED',
      `The emitter returned the file path "${relativePath}", which is not a relative path inside the output directory.`
    );
  }
  return ok(resolve(directory, relativePath));
}

/** Counts lines the way an editor does: a trailing newline does not add a line. */
export function countLines(text: string): number {
  if (text === '') {
    return 0;
  }
  const newlines: number = text.split('\n').length - 1;
  return text.endsWith('\n') ? newlines : newlines + 1;
}

/**
 * Describes how two texts differ in a short line, for example
 * "+3 -1 lines (first difference at line 12)".
 */
export function summarizeDiff(before: string, after: string): string {
  const oldLines: string[] = before.split('\n');
  const newLines: string[] = after.split('\n');
  const counts: Map<string, number> = new Map<string, number>();
  for (const line of oldLines) {
    counts.set(line, (counts.get(line) ?? 0) + 1);
  }
  let added: number = 0;
  for (const line of newLines) {
    const remaining: number = counts.get(line) ?? 0;
    if (remaining > 0) {
      counts.set(line, remaining - 1);
    } else {
      added += 1;
    }
  }
  let removed: number = 0;
  for (const remaining of counts.values()) {
    removed += remaining;
  }
  let first: number = 0;
  while (
    first < oldLines.length &&
    first < newLines.length &&
    oldLines[first] === newLines[first]
  ) {
    first += 1;
  }
  return `+${added} -${removed} lines (first difference at line ${first + 1})`;
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
      const roots: string[] =
        format === 'laravel' ? await laravelRoots(input) : [input];
      for (const root of roots) {
        files.push(...(await walkDirectory(root, format)));
      }
    } else {
      files.push(input);
    }
  }
  if (files.length === 0) {
    const expected: string =
      format === 'django'
        ? 'models.py files (or a models/ package)'
        : format === 'typeorm'
          ? 'TypeScript (.ts) entity files'
          : format === 'drizzle'
            ? 'TypeScript (.ts) Drizzle schema files'
            : format === 'doctrine'
              ? 'PHP (.php) entity files'
              : format === 'laravel'
                ? 'PHP (.php) migration and model files (database/migrations and app/)'
                : format === 'gorm'
                  ? 'Go (.go) model files'
                  : format === 'json-schema'
                    ? 'JSON (.json) schema or OpenAPI files'
                    : format === 'sql'
                      ? 'SQL (.sql) files'
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
  if (format === 'typeorm' || format === 'drizzle') {
    return (
      extname(filePath) === '.ts' &&
      !/\.(d|test|spec)\.ts$/.test(basename(filePath))
    );
  }
  if (format === 'gorm') {
    return (
      extname(filePath) === '.go' && !/_test\.go$/.test(basename(filePath))
    );
  }
  if (format === 'json-schema') {
    return (
      extname(filePath).toLowerCase() === '.json' &&
      !NON_SCHEMA_JSON_FILES.test(basename(filePath))
    );
  }
  if (format === 'sql') {
    return (
      extname(filePath).toLowerCase() === '.sql' &&
      !SQL_ROLLBACK_FILES.test(basename(filePath))
    );
  }
  if (format === 'doctrine' || format === 'laravel') {
    return (
      extname(filePath) === '.php' && !/Test\.php$/.test(basename(filePath))
    );
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

function isSkippedDirectory(
  name: string,
  parent: string,
  format: FormatName
): boolean {
  if (format === 'laravel') {
    // bootstrap/cache holds generated files; the rest of bootstrap/ is ordinary code.
    return (
      LARAVEL_SKIPPED_DIRECTORIES.has(name) ||
      (name === 'cache' && basename(parent) === 'bootstrap')
    );
  }
  if (format === 'gorm') {
    return GO_SKIPPED_DIRECTORIES.has(name);
  }
  if (format === 'json-schema') {
    return JSON_SCHEMA_SKIPPED_DIRECTORIES.has(name);
  }
  if (format === 'sql') {
    return SQL_SKIPPED_DIRECTORIES.has(name);
  }
  return (
    SKIPPED_DIRECTORIES.has(name) ||
    (format === 'doctrine' && PHP_SKIPPED_DIRECTORIES.has(name))
  );
}

/**
 * For a Laravel project root (it has `database/migrations` or `app`), only those
 * two directories are read. Any other directory, such as `app/Models` or
 * `database/migrations` passed on its own, is read as given.
 */
async function laravelRoots(directory: string): Promise<string[]> {
  const roots: string[] = [];
  for (const candidate of [
    join(directory, 'database', 'migrations'),
    join(directory, 'app'),
  ]) {
    if ((await classifyPath(candidate)) === 'directory') {
      roots.push(candidate);
    }
  }
  return roots.length > 0 ? roots : [directory];
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
      if (!isSkippedDirectory(entry.name, directory, format)) {
        found.push(...(await walkDirectory(entryPath, format)));
      }
    } else if (isRelevantFile(entryPath, format)) {
      found.push(entryPath);
    }
  }
  return found;
}
