import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { EXIT_OK, runCli } from '../src/cliRunner.js';
import { FORMAT_NAMES } from '../src/convert.js';

const EXAMPLES_DIRECTORY: string = fileURLToPath(
  new URL('../examples', import.meta.url)
);

describe('example projects', () => {
  it('has one example per registered format, each with a config and README', async () => {
    const entries: string[] = (await readdir(EXAMPLES_DIRECTORY)).filter(
      (name: string): boolean => name !== 'schema' && !name.endsWith('.md')
    );
    expect(entries.sort()).toEqual([...FORMAT_NAMES].sort());
    for (const name of entries) {
      expect(
        existsSync(join(EXAMPLES_DIRECTORY, name, 'ormbridge.config.json')),
        `examples/${name}/ormbridge.config.json`
      ).toBe(true);
      expect(
        existsSync(join(EXAMPLES_DIRECTORY, name, 'README.md')),
        `examples/${name}/README.md`
      ).toBe(true);
    }
  });

  const formats: readonly string[] = FORMAT_NAMES;
  it.each(formats)(
    'the %s example is up to date (ormbridge convert --check)',
    async (format: string) => {
      let output: string = '';
      const code: number = await runCli(['convert', '--check'], {
        cwd: join(EXAMPLES_DIRECTORY, format),
        stdout: (text: string): void => {
          output += text;
        },
        stderr: (text: string): void => {
          output += text;
        },
      });
      expect(code, `${output}\nRun "npm run examples" to regenerate.`).toBe(
        EXIT_OK
      );
    }
  );
});
