import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import type { IrSchema } from '../src/ir.js';
import {
  buildSpec,
  convertSource,
  djangoPython,
  parseSource,
  probePython,
  titleWithReason,
  VERIFY_SOURCES,
  writeProjectFile,
  type ToolProbe,
  type VerifySource,
} from './realToolSupport.js';

/**
 * Loads the generated Django models with the real Django: `check`, `makemigrations --dry-run`,
 * `makemigrations`, `sqlmigrate` and `migrate` on in-memory SQLite, then compares the model
 * metadata (`_meta`) and the introspected database (tables, columns, keys, indexes) with the IR
 * of every readable canonical fixture.
 *
 * Set DJANGO_PYTHON to a Python with Django installed (see test/README.md and
 * test/tools/setup-verification-tools.sh); the tests are skipped when `python3` has no Django.
 */

const SCRIPT: string = fileURLToPath(
  new URL('./tools/validate-django.py', import.meta.url)
);

const probe: ToolProbe = probePython(
  djangoPython(),
  ['django'],
  'DJANGO_PYTHON'
);

const directories: string[] = [];

afterAll(() => {
  for (const directory of directories) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function validate(models: string, schema: IrSchema): SpawnSyncReturns<string> {
  const directory: string = mkdtempSync(join(tmpdir(), 'ormbridge-django-'));
  directories.push(directory);
  writeProjectFile(directory, 'blog/__init__.py', '');
  writeProjectFile(directory, 'blog/models.py', models);
  writeProjectFile(
    directory,
    'spec.json',
    JSON.stringify(buildSpec(schema, { snakeCaseNames: true }))
  );
  return spawnSync(
    djangoPython(),
    ['-I', SCRIPT, directory, join(directory, 'spec.json')],
    { encoding: 'utf8', timeout: 120_000 }
  );
}

describe(titleWithReason('django emitter: real Django', probe), () => {
  const sources: VerifySource[] = VERIFY_SOURCES.filter(
    (source: VerifySource) => source.format !== 'django'
  );

  it.skipIf(!probe.available).each(sources)(
    'loads the models generated from the $label schema',
    async (source: VerifySource) => {
      const schema: IrSchema = await parseSource(source);
      const outputs: string[] = [];
      // The Django emitter does not depend on the naming mode, so both modes give one result.
      for (const naming of ['preserve', 'normalize'] as const) {
        outputs.push(
          (await convertSource(source, 'django', { naming })).output
        );
      }
      expect(outputs[1]).toBe(outputs[0]);

      const run: SpawnSyncReturns<string> = validate(outputs[0] ?? '', schema);
      expect(run.stderr, `${source.label}: ${run.stdout}`).toBe('');
      expect(run.stdout).toContain('django models verified');
      expect(run.status).toBe(0);
    },
    180_000
  );
});
