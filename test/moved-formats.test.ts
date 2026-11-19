import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  getFormat,
  listFormatNames,
  registerFormat,
  unregisterFormat,
  type FormatAdapter,
} from '../src/formats.js';
import {
  MOVED_FORMATS,
  movedMessage,
  movedStub,
  type MovedFormat,
} from '../src/movedFormats.js';
import { BLOG_FIXTURE_PATH } from './helpers.js';

afterEach(() => {
  unregisterFormat('fakemoved');
});

describe('movedStub', () => {
  it.each(MOVED_FORMATS.map((moved: MovedFormat) => [moved.name, moved]))(
    '%s: a stub names the package and keeps what the format could do',
    async (_name: string, moved: MovedFormat) => {
      const stub: FormatAdapter = movedStub(moved.name);
      expect(stub.movedTo).toEqual({ packageName: moved.packageName });
      expect(stub.parse !== undefined).toBe(moved.read);
      expect(stub.emit !== undefined).toBe(moved.write);
      const failed =
        stub.emit?.(
          { models: [], enums: [], warnings: [] },
          {
            naming: 'preserve',
            provider: 'postgresql',
            header: true,
            autoField: 'int',
          }
        ) ?? (await stub.parse?.([], {} as never));
      expect(failed?.ok).toBe(false);
      if (failed !== undefined && !failed.ok) {
        expect(failed.error.code).toBe('UNSUPPORTED_CONVERSION');
        expect(failed.error.message).toBe(movedMessage(moved));
        expect(failed.error.message).toContain(
          `npm install ${moved.packageName}`
        );
        expect(failed.error.message).toContain(`--plugin ${moved.packageName}`);
      }
    }
  );

  it('refuses a name that did not move', () => {
    expect(() => movedStub('prisma')).toThrow('not in the list');
  });
});

describe('registering the real format of a moved one', () => {
  it('replaces the stub in the same place of the list and keeps the other formats', () => {
    registerFormat({
      name: 'fakemoved',
      extensions: [],
      description: 'stub',
      movedTo: { packageName: 'ormbridge-fake' },
    });
    registerFormat({ name: 'after', extensions: [], description: 'after' });
    const before: string[] = listFormatNames();
    const real: FormatAdapter = {
      name: 'fakemoved',
      extensions: [],
      description: 'real',
    };
    expect(registerFormat(real).ok).toBe(true);
    expect(getFormat('fakemoved')).toEqual({ ok: true, value: real });
    expect(listFormatNames()).toEqual(before);
    unregisterFormat('after');
  });

  it('still refuses a second real format with the same name', () => {
    const first: FormatAdapter = {
      name: 'fakemoved',
      extensions: [],
      description: 'real',
    };
    registerFormat(first);
    const second = registerFormat({ ...first, description: 'other' });
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.error.message).toContain('already registered');
    }
  });
});

describe('the built CLI without the addon', () => {
  const cliPath: string = fileURLToPath(
    new URL('../dist/cli.js', import.meta.url)
  );

  it
    .skipIf(!existsSync(cliPath))
    .each(
      MOVED_FORMATS.filter((moved: MovedFormat) => moved.write).map(
        (moved: MovedFormat) => [moved.name, moved]
      )
    )(
    '--to %s fails with a message that names the package',
    (_name: string, moved: MovedFormat) => {
      const run = spawnSync(
        'node',
        [
          cliPath,
          'convert',
          '-i',
          BLOG_FIXTURE_PATH,
          '-f',
          'django',
          '-t',
          moved.name,
          '--no-config',
        ],
        { encoding: 'utf8' }
      );
      expect(run.status).not.toBe(0);
      expect(run.stderr).toContain(moved.packageName);
      expect(run.stderr).toContain(`--plugin ${moved.packageName}`);
    }
  );

  it
    .skipIf(!existsSync(cliPath))
    .each(
      MOVED_FORMATS.filter((moved: MovedFormat) => moved.read).map(
        (moved: MovedFormat) => [moved.name, moved]
      )
    )(
    '--from %s on a folder fails with the package message, not with "no files found"',
    (_name: string, moved: MovedFormat) => {
      const run = spawnSync(
        'node',
        [
          cliPath,
          'convert',
          '-i',
          fileURLToPath(new URL('./fixtures', import.meta.url)),
          '-f',
          moved.name,
          '-t',
          'prisma',
          '--no-config',
        ],
        { encoding: 'utf8' }
      );
      expect(run.status).not.toBe(0);
      expect(run.stderr).toContain(moved.packageName);
      expect(run.stderr).not.toContain('were found in');
    }
  );
});
