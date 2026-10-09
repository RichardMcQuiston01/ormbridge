import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  findConfigFile,
  loadConfigFile,
  parseConfig,
  type ConfigFile,
} from '../src/config.js';
import type { Result } from '../src/result.js';
import { expectOk } from './helpers.js';

let workDirectory: string;

beforeEach(async () => {
  workDirectory = await mkdtemp(join(tmpdir(), 'ormbridge-config-'));
});

afterEach(async () => {
  await rm(workDirectory, { recursive: true, force: true });
});

const CONFIG_PATH: string = resolve('/project/ormbridge.config.json');

function expectInvalid(raw: unknown): string {
  const result: Result<ConfigFile> = parseConfig(raw, CONFIG_PATH);
  if (result.ok) {
    throw new Error('Expected the config to be rejected.');
  }
  expect(result.error.code).toBe('INVALID_CONFIG');
  expect(result.error.message).toContain(CONFIG_PATH);
  return result.error.message;
}

describe('findConfigFile', () => {
  it('finds a config in the starting directory', async () => {
    const path: string = join(workDirectory, 'ormbridge.config.json');
    await writeFile(path, '{}');
    expect(await findConfigFile(workDirectory)).toBe(path);
  });

  it('accepts .ormbridgerc.json and prefers ormbridge.config.json', async () => {
    const rc: string = join(workDirectory, '.ormbridgerc.json');
    await writeFile(rc, '{}');
    expect(await findConfigFile(workDirectory)).toBe(rc);
    const main: string = join(workDirectory, 'ormbridge.config.json');
    await writeFile(main, '{}');
    expect(await findConfigFile(workDirectory)).toBe(main);
  });

  it('searches parent directories', async () => {
    const nested: string = join(workDirectory, 'a', 'b');
    await mkdir(nested, { recursive: true });
    const path: string = join(workDirectory, 'ormbridge.config.json');
    await writeFile(path, '{}');
    expect(await findConfigFile(nested)).toBe(path);
  });

  it('stops at a package.json boundary', async () => {
    const project: string = join(workDirectory, 'project');
    await mkdir(project, { recursive: true });
    await writeFile(join(workDirectory, 'ormbridge.config.json'), '{}');
    await writeFile(join(project, 'package.json'), '{}');
    expect(await findConfigFile(project)).toBeUndefined();
  });

  it('still finds a config next to the package.json', async () => {
    await writeFile(join(workDirectory, 'package.json'), '{}');
    const path: string = join(workDirectory, 'ormbridge.config.json');
    await writeFile(path, '{}');
    expect(await findConfigFile(workDirectory)).toBe(path);
  });

  it('returns undefined when there is no config', async () => {
    await writeFile(join(workDirectory, 'package.json'), '{}');
    expect(await findConfigFile(workDirectory)).toBeUndefined();
  });
});

describe('loadConfigFile', () => {
  it('reads a config and resolves paths against its directory', async () => {
    const path: string = join(workDirectory, 'ormbridge.config.json');
    await writeFile(
      path,
      JSON.stringify({
        input: ['backend', 'extra/models.py'],
        output: 'prisma/schema.prisma',
        naming: 'normalize',
        provider: 'mysql',
        header: false,
        appLabel: 'shop',
        autoField: 'BigInt',
        from: 'django',
        to: 'prisma',
      })
    );
    const config: ConfigFile = expectOk(await loadConfigFile(path));
    expect(config.path).toBe(path);
    expect(config.conversions).toEqual([]);
    expect(config.defaults).toEqual({
      input: [
        join(workDirectory, 'backend'),
        join(workDirectory, 'extra', 'models.py'),
      ],
      output: join(workDirectory, 'prisma', 'schema.prisma'),
      naming: 'normalize',
      provider: 'mysql',
      header: false,
      appLabel: 'shop',
      autoField: 'bigint',
      from: 'django',
      to: 'prisma',
    });
  });

  it('accepts a single input string and a $schema key', async () => {
    const path: string = join(workDirectory, '.ormbridgerc.json');
    await writeFile(path, '{"$schema":"x","input":"models.py"}');
    const config: ConfigFile = expectOk(await loadConfigFile(path));
    expect(config.defaults.input).toEqual([join(workDirectory, 'models.py')]);
  });

  it('reads named conversions that inherit top-level settings', async () => {
    const path: string = join(workDirectory, 'ormbridge.config.json');
    await writeFile(
      path,
      JSON.stringify({
        naming: 'normalize',
        conversions: [
          { name: 'prisma', input: 'a', output: 'out/schema.prisma' },
          { name: 'ts', input: 'a', output: 'out/types.ts', to: 'typescript' },
        ],
      })
    );
    const config: ConfigFile = expectOk(await loadConfigFile(path));
    expect(config.defaults).toEqual({ naming: 'normalize' });
    expect(config.conversions.map((entry) => entry.name)).toEqual([
      'prisma',
      'ts',
    ]);
    expect(config.conversions[1]?.to).toBe('typescript');
  });

  it('reports a missing file', async () => {
    const result: Result<ConfigFile> = await loadConfigFile(
      join(workDirectory, 'missing.json')
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('INVALID_CONFIG');
      expect(result.error.message).toContain('missing.json');
    }
  });

  it('reports invalid JSON with the file name', async () => {
    const path: string = join(workDirectory, 'ormbridge.config.json');
    await writeFile(path, '{ nope');
    const result: Result<ConfigFile> = await loadConfigFile(path);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain('not valid JSON');
      expect(result.error.message).toContain(path);
    }
  });
});

describe('parseConfig prismaVersion', () => {
  it.each([6, 7] as const)('accepts %i, also per conversion', (version) => {
    const result: Result<ConfigFile> = parseConfig(
      { prismaVersion: version, conversions: [{ prismaVersion: 7 }] },
      CONFIG_PATH
    );
    const config: ConfigFile = expectOk(result);
    expect(config.defaults.prismaVersion).toBe(version);
    expect(config.conversions[0]?.prismaVersion).toBe(7);
  });
});

describe('parseConfig validation', () => {
  it('rejects a non-object', () => {
    expect(expectInvalid([])).toContain('must be a JSON object');
    expect(expectInvalid('x')).toContain('must be a JSON object');
  });

  it('names unknown keys and lists the valid ones', () => {
    const message: string = expectInvalid({ inputs: 'x' });
    expect(message).toContain('unknown key "inputs"');
    expect(message).toContain('autoField');
    expect(expectInvalid({ conversions: [{ outptu: 'x' }] })).toContain(
      'unknown key "conversions[0].outptu"'
    );
  });

  it.each([
    [{ naming: 'weird' }, '"naming" must be "preserve" or "normalize"'],
    [{ provider: 'oracle' }, '"provider" must be one of postgresql'],
    [{ header: 'yes' }, '"header" must be true or false'],
    [{ autoField: 'small' }, '"autoField" must be "int" or "bigint"'],
    [{ input: [] }, '"input" must be a path string or a non-empty array'],
    [{ input: [1] }, '"input" must be a path string or a non-empty array'],
    [{ output: 3 }, '"output" must be a non-empty path string'],
    [{ from: '' }, '"from" must be a non-empty string'],
    [{ appLabel: 4 }, '"appLabel" must be a non-empty string'],
    [{ goPackage: '' }, '"goPackage" must be a non-empty string'],
    [{ prismaVersion: 8 }, '"prismaVersion" must be the number 6 or 7 (got 8)'],
    [
      { prismaVersion: '7' },
      '"prismaVersion" must be the number 6 or 7 (got "7")',
    ],
    [{ conversions: {} }, '"conversions" must be a non-empty array'],
    [{ conversions: [] }, '"conversions" must be a non-empty array'],
    [{ conversions: ['x'] }, '"conversions[0]" must be an object'],
    [
      { conversions: [{ naming: 'bad' }] },
      '"conversions[0].naming" must be "preserve" or "normalize"',
    ],
    [{ name: 'top' }, '"name" is only valid inside an entry of "conversions"'],
  ])('rejects %j', (raw: unknown, expected: string) => {
    expect(expectInvalid(raw)).toContain(expected);
  });

  it('rejects duplicate conversion names', () => {
    const message: string = expectInvalid({
      conversions: [
        { name: 'a', input: 'x' },
        { name: 'a', input: 'y' },
      ],
    });
    expect(message).toContain('"conversions[1].name" duplicates the name "a"');
  });
});
