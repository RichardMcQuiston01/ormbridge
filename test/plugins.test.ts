import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EXIT_OK, EXIT_USAGE_ERROR, runCli } from '../src/cliRunner.js';
import { getFormat, unregisterFormat } from '../src/formats.js';
import {
  isOrmbridgePlugin,
  loadPlugin,
  registerPlugin,
  type OrmbridgePlugin,
} from '../src/plugins.js';
import type { Result } from '../src/result.js';

let workDirectory: string;

const PLUGIN_SOURCE: string = `
export default {
  name: 'demo-plugin',
  formats: [
    {
      name: 'demo',
      extensions: ['.demo'],
      description: 'A format from a plugin',
      emit: (schema) => ({ ok: true, value: { text: schema.models.map((m) => m.name).join(',') + '\\n', warnings: [] } }),
    },
  ],
};
`;

beforeEach(async () => {
  workDirectory = await mkdtemp(join(tmpdir(), 'ormbridge-plugins-'));
  await writeFile(join(workDirectory, 'package.json'), '{}');
  await writeFile(join(workDirectory, 'demo-plugin.mjs'), PLUGIN_SOURCE);
});

afterEach(async () => {
  unregisterFormat('demo');
  unregisterFormat('other');
  await rm(workDirectory, { recursive: true, force: true });
});

async function cli(
  args: string[]
): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout: string = '';
  let stderr: string = '';
  const code: number = await runCli(args, {
    cwd: workDirectory,
    stdout: (text: string): void => {
      stdout += text;
    },
    stderr: (text: string): void => {
      stderr += text;
    },
  });
  return { code, stdout, stderr };
}

describe('isOrmbridgePlugin', () => {
  it('accepts an object with a name and formats', () => {
    expect(isOrmbridgePlugin({ name: 'x', formats: [] })).toBe(true);
  });

  it.each([null, 3, {}, { name: '', formats: [] }, { name: 'x' }])(
    'rejects %j',
    (value: unknown) => {
      expect(isOrmbridgePlugin(value)).toBe(false);
    }
  );
});

describe('loadPlugin', () => {
  it('loads a file relative to the base directory and registers its formats', async () => {
    const loaded: Result<OrmbridgePlugin> = await loadPlugin(
      './demo-plugin.mjs',
      workDirectory
    );
    expect(loaded.ok).toBe(true);
    expect(getFormat('demo').ok).toBe(true);
  });

  it('loading the same plugin again does nothing', async () => {
    await loadPlugin('./demo-plugin.mjs', workDirectory);
    const again: Result<OrmbridgePlugin> = await loadPlugin(
      './demo-plugin.mjs',
      workDirectory
    );
    expect(again.ok).toBe(true);
  });

  it('loads a package from node_modules of the base directory', async () => {
    const packageDirectory: string = join(
      workDirectory,
      'node_modules',
      'ormbridge-demo-addon'
    );
    await mkdir(packageDirectory, { recursive: true });
    await writeFile(
      join(packageDirectory, 'package.json'),
      JSON.stringify({
        name: 'ormbridge-demo-addon',
        type: 'module',
        exports: { '.': { import: './index.js', default: './index.js' } },
      })
    );
    await writeFile(
      join(packageDirectory, 'index.js'),
      PLUGIN_SOURCE.replace("'demo-plugin'", "'ormbridge-demo-addon'")
    );
    const loaded: Result<OrmbridgePlugin> = await loadPlugin(
      'ormbridge-demo-addon',
      workDirectory
    );
    expect(loaded.ok).toBe(true);
    expect(getFormat('demo').ok).toBe(true);
  });

  it('names the missing package and how to install it', async () => {
    const loaded: Result<OrmbridgePlugin> = await loadPlugin(
      '@ormbridge/missing-addon',
      workDirectory
    );
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) {
      expect(loaded.error.code).toBe('PLUGIN_NOT_FOUND');
      expect(loaded.error.message).toContain(
        'npm install @ormbridge/missing-addon'
      );
    }
  });

  it('rejects a module that exports no plugin', async () => {
    await writeFile(join(workDirectory, 'bad.mjs'), 'export default 3;\n');
    const loaded: Result<OrmbridgePlugin> = await loadPlugin(
      './bad.mjs',
      workDirectory
    );
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) {
      expect(loaded.error.message).toContain('"name" and a "formats" array');
    }
  });

  it('reports a module that throws while loading', async () => {
    await writeFile(
      join(workDirectory, 'throws.mjs'),
      "throw new Error('boom');\n"
    );
    const loaded: Result<OrmbridgePlugin> = await loadPlugin(
      './throws.mjs',
      workDirectory
    );
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) {
      expect(loaded.error.message).toContain('boom');
    }
  });
});

describe('registerPlugin', () => {
  it('removes the formats it added when a later one cannot be registered', () => {
    const result: Result<OrmbridgePlugin> = registerPlugin({
      name: 'half-plugin',
      formats: [
        { name: 'other', extensions: ['.other'], description: 'ok' },
        { name: 'prisma', extensions: [], description: 'name is taken' },
      ],
    });
    expect(result.ok).toBe(false);
    expect(getFormat('other').ok).toBe(false);
  });
});

describe('the CLI', () => {
  const model: string = 'model Post {\n  id Int @id\n}\n';

  it('--plugin adds a format to convert', async () => {
    await writeFile(join(workDirectory, 'schema.prisma'), model);
    const run = await cli([
      'convert',
      '-i',
      'schema.prisma',
      '--to',
      'demo',
      '--plugin',
      './demo-plugin.mjs',
    ]);
    expect(run.stderr).toBe('');
    expect(run.code).toBe(EXIT_OK);
    expect(run.stdout).toBe('Post\n');
  });

  it('the "plugins" key of the config file loads relative to the file', async () => {
    await writeFile(join(workDirectory, 'schema.prisma'), model);
    await writeFile(
      join(workDirectory, 'ormbridge.config.json'),
      JSON.stringify({
        plugins: ['./demo-plugin.mjs'],
        input: ['schema.prisma'],
        to: 'demo',
      })
    );
    const run = await cli(['convert']);
    expect(run.stderr).toBe('');
    expect(run.stdout).toBe('Post\n');
  });

  it('formats lists the formats of a plugin', async () => {
    const run = await cli(['formats', '--plugin', './demo-plugin.mjs']);
    expect(run.code).toBe(EXIT_OK);
    expect(run.stdout).toContain('demo');
    expect(run.stdout).toContain('A format from a plugin');
  });

  it('a plugin that cannot be loaded is a usage error that names it', async () => {
    await writeFile(join(workDirectory, 'schema.prisma'), model);
    const run = await cli([
      'convert',
      '-i',
      'schema.prisma',
      '--to',
      'django',
      '--plugin',
      './absent.mjs',
    ]);
    expect(run.code).toBe(EXIT_USAGE_ERROR);
    expect(run.stderr).toContain('absent.mjs');
  });

  it('an unknown format without the plugin still lists the valid names', async () => {
    await writeFile(join(workDirectory, 'schema.prisma'), model);
    const run = await cli(['convert', '-i', 'schema.prisma', '--to', 'demo']);
    expect(run.code).toBe(EXIT_USAGE_ERROR);
    expect(run.stderr).toContain('Expected one of');
  });
});
