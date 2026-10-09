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
  SOURCES_WITHOUT_VIEWS,
  withProjectUserModel,
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
    // django-extras uses django.contrib.postgres fields, which need psycopg and a PostgreSQL
    // server to load.
    const sources: VerifySource[] = SOURCES_WITHOUT_VIEWS.filter(
      (source: VerifySource) => source.label !== 'django-extras'
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

        // The schema pairs with the Django models generated from the same source. A Django
        // source already is its models file: it is used as written, with the project's user
        // model made importable as `User` (see withProjectUserModel).
        const models: string =
          source.format === 'django'
            ? withProjectUserModel(source.sources[0]?.text ?? '', schema)
            : (await convertSource(source, 'django')).output;
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

    it.skipIf(!probe.available)(
      'runs the whole round trip on the Django fixture, relations included',
      async () => {
        const source: VerifySource | undefined = SOURCES_WITHOUT_VIEWS.find(
          (candidate: VerifySource) => candidate.label === 'django'
        );
        expect(source).toBeDefined();
        if (source === undefined) {
          return;
        }
        const models: string = source.sources[0]?.text ?? '';
        // The fixture is verified as written: its foreign keys use the project's user model.
        expect(models).toContain('settings.AUTH_USER_MODEL');
        const schema: IrSchema = await parseSource(source);
        const graphene: string = (await convertSource(source, 'graphene'))
          .output;
        const run: SpawnSyncReturns<string> = validate(
          withProjectUserModel(models, schema),
          graphene,
          schema
        );
        expect(run.stderr).toBe('');
        expect(run.status).toBe(0);
        // Post needs a User and a Category, Profile a User: the round trip creates the rows
        // they point at first, then fetches, updates and deletes every row.
        for (const model of ['Category', 'Tag', 'User', 'Post', 'Profile']) {
          expect(run.stdout).toMatch(
            new RegExp(`round trip:.*\\b${model}\\b`, 'u')
          );
        }
      },
      180_000
    );
  }
);
