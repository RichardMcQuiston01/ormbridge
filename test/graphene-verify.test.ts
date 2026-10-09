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
 * Imports the generated graphene-django schema next to the Django models generated from the same
 * source, builds it with the real graphene (`graphene.Schema`), prints the SDL, runs the
 * introspection query and queries and mutates an in-memory SQLite database through it.
 *
 * Set DJANGO_PYTHON to a Python with Django and graphene-django installed (see test/README.md
 * and test/tools/setup-verification-tools.sh); the tests are skipped when `python3` has neither.
 */

const SCRIPT: string = fileURLToPath(
  new URL('./tools/validate-graphene.py', import.meta.url)
);

const probe: ToolProbe = probePython(
  djangoPython(),
  ['django', 'graphene', 'graphene_django'],
  'DJANGO_PYTHON'
);

const directories: string[] = [];

afterAll(() => {
  for (const directory of directories) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function validate(
  models: string,
  graphene: string,
  schema: IrSchema
): SpawnSyncReturns<string> {
  const directory: string = mkdtempSync(join(tmpdir(), 'ormbridge-graphene-'));
  directories.push(directory);
  writeProjectFile(directory, 'blog/__init__.py', '');
  writeProjectFile(directory, 'blog/models.py', models);
  writeProjectFile(directory, 'blog/schema.py', graphene);
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

describe(
  titleWithReason('graphene emitter: real graphene-django', probe),
  () => {
    // Django sources are not used: their models import the project's user model, which the
    // schema pairs with only when the models are generated (see the Django tests).
    const sources: VerifySource[] = VERIFY_SOURCES.filter(
      (source: VerifySource) => source.format !== 'django'
    );

    it.skipIf(!probe.available).each(sources)(
      'builds the schema generated from the $label schema',
      async (source: VerifySource) => {
        const schema: IrSchema = await parseSource(source);
        const graphene: string[] = [];
        // The emitter does not depend on the naming mode, so both modes give the same text.
        for (const naming of ['preserve', 'normalize'] as const) {
          graphene.push(
            (await convertSource(source, 'graphene', { naming })).output
          );
        }
        expect(graphene[1]).toBe(graphene[0]);

        // The schema pairs with the Django models generated from the same source.
        const models: string = (await convertSource(source, 'django')).output;
        const run: SpawnSyncReturns<string> = validate(
          models,
          graphene[0] ?? '',
          schema
        );
        expect(run.stderr, `${source.label}: ${run.stdout}`).toBe('');
        expect(run.stdout).toContain('graphene schema verified');
        expect(run.status).toBe(0);
      },
      180_000
    );
  }
);
