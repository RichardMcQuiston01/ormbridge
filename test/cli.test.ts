import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { existsSync } from 'node:fs';
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  EXIT_CHECK_FAILED,
  EXIT_CONVERSION_ERROR,
  EXIT_OK,
  EXIT_USAGE_ERROR,
  runCli,
} from '../src/cliRunner.js';
import {
  MULTI_FILE_FORMAT,
  registerMultiFileFormat,
  unregisterMultiFileFormat,
} from './multiFileAdapter.js';
import { BLOG_FIXTURE_PATH } from './helpers.js';

let workDirectory: string;

beforeEach(async () => {
  registerMultiFileFormat();
  workDirectory = await mkdtemp(join(tmpdir(), 'ormbridge-cli-'));
  // A package.json keeps config discovery from walking above the temp directory.
  await writeFile(join(workDirectory, 'package.json'), '{}');
});

afterEach(async () => {
  unregisterMultiFileFormat();
  await rm(workDirectory, { recursive: true, force: true });
});

interface CliRun {
  code: number;
  stdout: string;
  stderr: string;
}

async function cli(
  args: string[],
  cwd: string = workDirectory
): Promise<CliRun> {
  let stdout: string = '';
  let stderr: string = '';
  const code: number = await runCli(args, {
    cwd,
    stdout: (text: string): void => {
      stdout += text;
    },
    stderr: (text: string): void => {
      stderr += text;
    },
  });
  return { code, stdout, stderr };
}

async function writeConfig(
  config: unknown,
  name: string = 'ormbridge.config.json'
): Promise<string> {
  const path: string = join(workDirectory, name);
  await writeFile(path, JSON.stringify(config));
  return path;
}

async function listWorkDirectory(): Promise<string[]> {
  return (await readdir(workDirectory)).sort();
}

describe('convert basics', () => {
  it('prints the conversion to stdout without an output path', async () => {
    const run: CliRun = await cli(['convert', '-i', BLOG_FIXTURE_PATH]);
    expect(run.code).toBe(EXIT_OK);
    expect(run.stdout).toContain('model Post {');
  });

  it('writes the output file and summarises it', async () => {
    const run: CliRun = await cli([
      'convert',
      '-i',
      BLOG_FIXTURE_PATH,
      '-o',
      'out/schema.prisma',
    ]);
    expect(run.code).toBe(EXIT_OK);
    expect(run.stderr).toContain('Converted');
    expect(run.stderr).toMatch(
      /created out[\\/]schema\.prisma \(\d+ line\(s\)/
    );
    expect(
      await readFile(join(workDirectory, 'out', 'schema.prisma'), 'utf8')
    ).toContain('model Post {');
  });

  it('exits 2 for an invalid option value', async () => {
    const run: CliRun = await cli([
      'convert',
      '-i',
      BLOG_FIXTURE_PATH,
      '--naming',
      'weird',
    ]);
    expect(run.code).toBe(EXIT_USAGE_ERROR);
    expect(run.stderr).toContain('Invalid --naming value "weird"');
  });

  it('exits 2 when there is no input anywhere', async () => {
    const run: CliRun = await cli(['convert']);
    expect(run.code).toBe(EXIT_USAGE_ERROR);
    expect(run.stderr).toContain('No input was given');
  });

  it('exits 2 for an unknown flag and 0 for --help', async () => {
    expect((await cli(['convert', '--bogus'])).code).toBe(EXIT_USAGE_ERROR);
    const help: CliRun = await cli(['convert', '--help']);
    expect(help.code).toBe(EXIT_OK);
    expect(help.stdout).toContain('--dry-run');
    expect(help.stdout).toContain('--check');
    expect(help.stdout).toContain('--no-config');
  });

  it('exits 1 for a missing input file', async () => {
    const run: CliRun = await cli([
      'convert',
      '-i',
      'nope.py',
      '-o',
      'x.prisma',
    ]);
    expect(run.code).toBe(EXIT_CONVERSION_ERROR);
    expect(run.stderr).toContain('INPUT_NOT_FOUND');
  });

  it('lists formats in-process', async () => {
    const run: CliRun = await cli(['formats']);
    expect(run.code).toBe(EXIT_OK);
    expect(run.stdout).toContain('django');
  });
});

describe('--dry-run', () => {
  it('reports what would be written and touches nothing', async () => {
    const run: CliRun = await cli([
      'convert',
      '-i',
      BLOG_FIXTURE_PATH,
      '-o',
      'out/schema.prisma',
      '--dry-run',
    ]);
    expect(run.code).toBe(EXIT_OK);
    expect(run.stderr).toContain('Dry run, nothing written');
    expect(run.stderr).toMatch(
      /would create out[\\/]schema\.prisma \(\d+ line\(s\), [\d.]+ (B|KB)\)/
    );
    expect(await listWorkDirectory()).toEqual(['package.json']);
  });

  it('describes an update with a diff summary', async () => {
    await writeFile(join(workDirectory, 'schema.prisma'), 'old\n');
    const run: CliRun = await cli([
      'convert',
      '-i',
      BLOG_FIXTURE_PATH,
      '-o',
      'schema.prisma',
      '--dry-run',
    ]);
    expect(run.stderr).toContain('would update schema.prisma');
    expect(run.stderr).toContain('first difference at line');
    expect(await readFile(join(workDirectory, 'schema.prisma'), 'utf8')).toBe(
      'old\n'
    );
  });

  it('prints neither output nor files without -o', async () => {
    const run: CliRun = await cli([
      'convert',
      '-i',
      BLOG_FIXTURE_PATH,
      '--dry-run',
    ]);
    expect(run.code).toBe(EXIT_OK);
    expect(run.stdout).toBe('');
    expect(run.stderr).toContain('would be printed to stdout');
  });

  it('still prints warnings', async () => {
    const run: CliRun = await cli([
      'convert',
      '-i',
      BLOG_FIXTURE_PATH,
      '--to',
      MULTI_FILE_FORMAT,
      '-o',
      'gen',
      '--dry-run',
    ]);
    expect(run.stderr).toContain('warning: multifile test warning');
    expect(await listWorkDirectory()).toEqual(['package.json']);
  });

  it('cannot be combined with --check', async () => {
    const run: CliRun = await cli([
      'convert',
      '-i',
      BLOG_FIXTURE_PATH,
      '-o',
      'x.prisma',
      '--dry-run',
      '--check',
    ]);
    expect(run.code).toBe(EXIT_USAGE_ERROR);
  });
});

describe('--check', () => {
  const baseArgs: string[] = [
    'convert',
    '-i',
    BLOG_FIXTURE_PATH,
    '-o',
    'schema.prisma',
  ];

  it('exits 0 when the output is up to date', async () => {
    await cli(baseArgs);
    const run: CliRun = await cli([...baseArgs, '--check']);
    expect(run.code).toBe(EXIT_OK);
    expect(run.stderr).toContain('up to date: schema.prisma');
  });

  it('exits 3 and names a missing file', async () => {
    const run: CliRun = await cli([...baseArgs, '--check']);
    expect(run.code).toBe(EXIT_CHECK_FAILED);
    expect(run.stderr).toContain('schema.prisma is missing');
    expect(run.stderr).toContain('Generated output is stale');
    expect(await listWorkDirectory()).toEqual(['package.json']);
  });

  it('exits 3 and names a stale file with a diff summary', async () => {
    await cli(baseArgs);
    const path: string = join(workDirectory, 'schema.prisma');
    const current: string = await readFile(path, 'utf8');
    await writeFile(path, current.replace('model Post', 'model Posts'));
    const run: CliRun = await cli([...baseArgs, '--check']);
    expect(run.code).toBe(EXIT_CHECK_FAILED);
    expect(run.stderr).toMatch(
      /error: schema\.prisma is out of date: \+1 -1 lines \(first difference at line \d+\)/
    );
    expect(await readFile(path, 'utf8')).toContain('model Posts');
  });

  it('requires an output path', async () => {
    const run: CliRun = await cli([
      'convert',
      '-i',
      BLOG_FIXTURE_PATH,
      '--check',
    ]);
    expect(run.code).toBe(EXIT_USAGE_ERROR);
    expect(run.stderr).toContain('output path is required');
  });

  it('checks every file of a multi-file output', async () => {
    const args: string[] = [
      'convert',
      '-i',
      BLOG_FIXTURE_PATH,
      '--to',
      MULTI_FILE_FORMAT,
      '-o',
      'gen',
    ];
    expect((await cli([...args, '--check'])).code).toBe(EXIT_CHECK_FAILED);
    expect((await cli(args)).code).toBe(EXIT_OK);
    expect((await cli([...args, '--check'])).code).toBe(EXIT_OK);
    await writeFile(join(workDirectory, 'gen', 'models', 'Tag.txt'), 'old\n');
    const stale: CliRun = await cli([...args, '--check']);
    expect(stale.code).toBe(EXIT_CHECK_FAILED);
    expect(stale.stderr).toMatch(/gen[\\/]models[\\/]Tag\.txt is out of date/);
  });
});

describe('multi-file output', () => {
  it('writes a directory of files', async () => {
    const run: CliRun = await cli([
      'convert',
      '-i',
      BLOG_FIXTURE_PATH,
      '--to',
      MULTI_FILE_FORMAT,
      '-o',
      'gen',
    ]);
    expect(run.code).toBe(EXIT_OK);
    expect(
      await readFile(join(workDirectory, 'gen', 'models', 'Post.txt'), 'utf8')
    ).toBe('model Post\n');
    expect(run.stderr).toMatch(/created gen[\\/]index\.txt/);
  });

  it('exits 1 when -o is a single file path', async () => {
    const run: CliRun = await cli([
      'convert',
      '-i',
      BLOG_FIXTURE_PATH,
      '--to',
      MULTI_FILE_FORMAT,
      '-o',
      'out.txt',
    ]);
    expect(run.code).toBe(EXIT_CONVERSION_ERROR);
    expect(run.stderr).toContain('so -o must be a directory');
  });
});

describe('config files', () => {
  it('discovers ormbridge.config.json from a subdirectory', async () => {
    await writeConfig({
      input: BLOG_FIXTURE_PATH,
      output: 'out/schema.prisma',
    });
    const nested: string = join(workDirectory, 'a', 'b');
    await mkdir(nested, { recursive: true });
    const run: CliRun = await cli(['convert'], nested);
    expect(run.code).toBe(EXIT_OK);
    // Config paths resolve against the config file, not the working directory.
    expect(
      await readFile(join(workDirectory, 'out', 'schema.prisma'), 'utf8')
    ).toContain('model Post {');
  });

  it('reads .ormbridgerc.json', async () => {
    await writeConfig(
      { input: BLOG_FIXTURE_PATH, naming: 'normalize' },
      '.ormbridgerc.json'
    );
    const run: CliRun = await cli(['convert']);
    expect(run.code).toBe(EXIT_OK);
    expect(run.stdout).toContain('@@map("post")');
  });

  it('lets flags override config values', async () => {
    await writeConfig({
      input: BLOG_FIXTURE_PATH,
      naming: 'normalize',
      header: false,
    });
    const fromConfig: CliRun = await cli(['convert']);
    expect(fromConfig.stdout).not.toContain('datasource');
    expect(fromConfig.stdout).toContain('@@map("post")');
    const overridden: CliRun = await cli(['convert', '--naming', 'preserve']);
    expect(overridden.stdout).toContain('@@map("blog_post")');
    expect(overridden.stdout).not.toContain('datasource');
  });

  it('applies --no-header only when the flag is given', async () => {
    await writeConfig({ input: BLOG_FIXTURE_PATH, header: true });
    expect((await cli(['convert'])).stdout).toContain('datasource');
    expect((await cli(['convert', '--no-header'])).stdout).not.toContain(
      'datasource'
    );
  });

  it('honours --no-config', async () => {
    await writeConfig({ input: BLOG_FIXTURE_PATH });
    const run: CliRun = await cli(['convert', '--no-config']);
    expect(run.code).toBe(EXIT_USAGE_ERROR);
    expect(run.stderr).toContain('No input was given');
  });

  it('honours --config <path>', async () => {
    const path: string = join(workDirectory, 'custom.json');
    await writeFile(path, JSON.stringify({ input: BLOG_FIXTURE_PATH }));
    const run: CliRun = await cli(['convert', '--config', 'custom.json']);
    expect(run.code).toBe(EXIT_OK);
    expect(run.stdout).toContain('model Post {');
  });

  it('rejects --config together with --no-config', async () => {
    const run: CliRun = await cli([
      'convert',
      '--config',
      'x.json',
      '--no-config',
    ]);
    expect(run.code).toBe(EXIT_USAGE_ERROR);
    expect(run.stderr).toContain('cannot be combined');
  });

  it('exits 2 with the key name for an invalid config', async () => {
    await writeConfig({ input: BLOG_FIXTURE_PATH, naming: 'weird' });
    const run: CliRun = await cli(['convert']);
    expect(run.code).toBe(EXIT_USAGE_ERROR);
    expect(run.stderr).toContain('"naming" must be "preserve" or "normalize"');
  });

  it('exits 2 for an explicit config that does not exist', async () => {
    const run: CliRun = await cli(['convert', '--config', 'missing.json']);
    expect(run.code).toBe(EXIT_USAGE_ERROR);
    expect(run.stderr).toContain('missing.json');
  });

  it('exits 2 for an unknown format in the config', async () => {
    await writeConfig({ input: BLOG_FIXTURE_PATH, to: 'nonsense' });
    const run: CliRun = await cli(['convert']);
    expect(run.code).toBe(EXIT_USAGE_ERROR);
    expect(run.stderr).toContain('Invalid --to value "nonsense"');
  });
});

describe('multiple conversions', () => {
  const conversions: unknown = {
    input: BLOG_FIXTURE_PATH,
    conversions: [
      { name: 'prisma', output: 'out/schema.prisma' },
      { name: 'files', to: MULTI_FILE_FORMAT, output: 'out/files' },
    ],
  };

  it('runs every conversion with one command', async () => {
    await writeConfig(conversions);
    const run: CliRun = await cli(['convert']);
    expect(run.code).toBe(EXIT_OK);
    expect(run.stderr).toContain('Using ormbridge.config.json: 2 conversions');
    expect(run.stderr).toContain('[prisma] Converted');
    expect(run.stderr).toContain('[files] Converted');
    expect(await readdir(join(workDirectory, 'out'))).toEqual([
      'files',
      'schema.prisma',
    ]);
  });

  it('checks every conversion and fails if any is stale', async () => {
    await writeConfig(conversions);
    await cli(['convert']);
    expect((await cli(['convert', '--check'])).code).toBe(EXIT_OK);
    await writeFile(join(workDirectory, 'out', 'schema.prisma'), 'stale\n');
    const run: CliRun = await cli(['convert', '--check']);
    expect(run.code).toBe(EXIT_CHECK_FAILED);
    expect(run.stderr).toContain('[prisma] error: out');
    expect(run.stderr).toContain('[files] up to date');
  });

  it('keeps going after a failure and exits 1', async () => {
    await writeConfig({
      conversions: [
        { name: 'bad', input: 'missing.py', output: 'out/a.prisma' },
        { name: 'good', input: BLOG_FIXTURE_PATH, output: 'out/b.prisma' },
      ],
    });
    const run: CliRun = await cli(['convert']);
    expect(run.code).toBe(EXIT_CONVERSION_ERROR);
    expect(run.stderr).toContain('[bad] error [INPUT_NOT_FOUND]');
    expect(await readdir(join(workDirectory, 'out'))).toEqual(['b.prisma']);
  });

  it('rejects -o with several conversions', async () => {
    await writeConfig(conversions);
    const run: CliRun = await cli(['convert', '-o', 'x.prisma']);
    expect(run.code).toBe(EXIT_USAGE_ERROR);
    expect(run.stderr).toContain('cannot be combined');
  });

  it('runs one conversion when -i is given, using the top-level defaults', async () => {
    await writeConfig({ ...(conversions as object), naming: 'normalize' });
    const run: CliRun = await cli(['convert', '-i', BLOG_FIXTURE_PATH]);
    expect(run.code).toBe(EXIT_OK);
    expect(run.stdout).toContain('@@map("post")');
  });

  it('names the conversion in validation errors', async () => {
    await writeConfig({
      conversions: [
        { name: 'broken', input: BLOG_FIXTURE_PATH },
        { name: 'second', to: 'nonsense', input: BLOG_FIXTURE_PATH },
      ],
    });
    const run: CliRun = await cli(['convert']);
    expect(run.code).toBe(EXIT_USAGE_ERROR);
    expect(run.stderr).toContain('conversion second:');
    // Nothing runs when any conversion is invalid.
    expect(await listWorkDirectory()).toEqual([
      'ormbridge.config.json',
      'package.json',
    ]);
  });
});

describe('built CLI', () => {
  const cliPath: string = fileURLToPath(
    new URL('../dist/cli.js', import.meta.url)
  );
  const built: boolean = existsSync(cliPath);

  function spawnCli(args: string[]): SpawnSyncReturns<string> {
    return spawnSync('node', [cliPath, ...args], {
      cwd: workDirectory,
      encoding: 'utf8',
    });
  }

  it.skipIf(!built)('exits 0, 3, 2 and 1 for the documented cases', () => {
    const args: string[] = [
      'convert',
      '-i',
      BLOG_FIXTURE_PATH,
      '-o',
      'schema.prisma',
    ];
    expect(spawnCli(args).status).toBe(0);
    expect(spawnCli([...args, '--check']).status).toBe(0);
    expect(spawnCli([...args, '--naming', 'x']).status).toBe(2);
    expect(spawnCli(['convert', '--bogus']).status).toBe(2);
    expect(
      spawnCli(['convert', '-i', 'nope.py', '-o', 'x.prisma']).status
    ).toBe(1);
  });

  it.skipIf(!built)('exits 3 for a stale output', async () => {
    await writeFile(join(workDirectory, 'schema.prisma'), 'stale\n');
    const run: SpawnSyncReturns<string> = spawnCli([
      'convert',
      '-i',
      BLOG_FIXTURE_PATH,
      '-o',
      'schema.prisma',
      '--check',
    ]);
    expect(run.status).toBe(3);
    expect(run.stderr).toContain('schema.prisma is out of date');
  });
});
