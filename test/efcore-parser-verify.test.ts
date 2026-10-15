import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { IrSchema } from '../src/ir.js';
import { parseEfcore } from '../src/parsers/efcore.js';
import { CANONICAL_FIXTURES } from './fixtures/canonical.js';
import { toDbSchema, type EfcoreToolOutput } from './efcoreSupport.js';
import { expectOk } from './helpers.js';
import { titleWithReason, type ToolProbe } from './realToolSupport.js';
import { compareWithDatabase } from './sequelizeSupport.js';

/**
 * Loads the C# fixtures with the real Entity Framework Core: `test/tools/efcore-verify` is built with the .NET
 * SDK, creates every DbContext in an in-memory SQLite database (`EnsureCreated`) and prints what SQLite reports
 * (tables, columns, nullability, primary and unique keys, indexes, foreign keys and their actions). That is
 * compared with what the parser read from the same source.
 *
 * Set EFCORE_DIR to a scratch directory (the NuGet cache and the home of the dotnet CLI go there; see
 * test/tools/setup-verification-tools.sh) and, when `dotnet` is not on the PATH, DOTNET to the dotnet executable.
 * The tests are skipped, with the reason in their title, when the .NET SDK is missing.
 */

const FIXTURES: string = fileURLToPath(new URL('./fixtures', import.meta.url));
const TOOL: string = fileURLToPath(
  new URL('./tools/efcore-verify', import.meta.url)
);

interface VerifyGroup {
  label: string;
  /** The DbContext type the tool creates. */
  context: string;
  /** The C# files the parser reads (absolute paths). */
  sources: readonly string[];
}

function csharpFiles(directory: string): string[] {
  return readdirSync(directory)
    .sort()
    .flatMap((entry: string): string[] => {
      const path: string = join(directory, entry);
      if (statSync(path).isDirectory()) {
        return csharpFiles(path);
      }
      return path.endsWith('.cs') ? [path] : [];
    });
}

const GROUPS: readonly VerifyGroup[] = [
  {
    label: 'canonical blog schema',
    context: 'BlogContext',
    sources:
      CANONICAL_FIXTURES.find((fixture) => fixture.format === 'efcore')
        ?.paths ?? [],
  },
  {
    label: 'shop (fluent API, owned types, conventions, composite key)',
    context: 'ShopContext',
    sources: csharpFiles(join(FIXTURES, 'efcore-extras', 'shop')),
  },
  {
    label: 'fleet (table per hierarchy)',
    context: 'FleetContext',
    sources: csharpFiles(join(FIXTURES, 'efcore-extras', 'inheritance')),
  },
  {
    label: 'library (data annotations, delete behaviors)',
    context: 'LibraryContext',
    sources: csharpFiles(join(FIXTURES, 'efcore-extras', 'library')),
  },
];

function probeDotnet(): ToolProbe & { dotnet: string; directory: string } {
  const directory: string = process.env.EFCORE_DIR ?? '';
  const dotnet: string = process.env.DOTNET ?? 'dotnet';
  if (directory === '') {
    return {
      available: false,
      reason:
        'set EFCORE_DIR to a scratch directory and have the .NET 8 SDK installed (DOTNET names the dotnet executable; see test/README.md)',
      dotnet,
      directory,
    };
  }
  const version: SpawnSyncReturns<string> = spawnSync(dotnet, ['--version'], {
    encoding: 'utf8',
  });
  if (version.error !== undefined || version.status !== 0) {
    return {
      available: false,
      reason: `the .NET SDK was not found (${dotnet} --version failed); install .NET 8 or set DOTNET (see test/README.md)`,
      dotnet,
      directory,
    };
  }
  return { available: true, reason: '', dotnet, directory };
}

const probe: ReturnType<typeof probeDotnet> = probeDotnet();
const directories: string[] = [];
let output: EfcoreToolOutput = {};

beforeAll(() => {
  if (!probe.available) {
    return;
  }
  const work: string = mkdtempSync(join(tmpdir(), 'ormbridge-efcore-'));
  directories.push(work);
  for (const file of ['EfcoreVerify.csproj', 'Program.cs']) {
    copyFileSync(join(TOOL, file), join(work, file));
  }
  mkdirSync(join(probe.directory, 'nuget'), { recursive: true });
  const run: SpawnSyncReturns<string> = spawnSync(
    probe.dotnet,
    [
      'run',
      '--configuration',
      'Release',
      `-p:FixturesDir=${FIXTURES}`,
      '--',
      ...GROUPS.map((group: VerifyGroup) => group.context),
    ],
    {
      cwd: work,
      encoding: 'utf8',
      timeout: 600_000,
      env: {
        ...process.env,
        NUGET_PACKAGES: join(probe.directory, 'nuget'),
        DOTNET_CLI_HOME: join(probe.directory, 'home'),
        DOTNET_CLI_TELEMETRY_OPTOUT: '1',
        DOTNET_NOLOGO: '1',
        DOTNET_SKIP_FIRST_TIME_EXPERIENCE: '1',
      },
    }
  );
  if (run.status !== 0) {
    throw new Error(
      `dotnet run failed (${run.status}):\n${run.stdout}\n${run.stderr}`
    );
  }
  output = JSON.parse(run.stdout) as EfcoreToolOutput;
}, 660_000);

afterAll(() => {
  for (const directory of directories) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe(titleWithReason('efcore parser: real EF Core', probe), () => {
  it.skipIf(!probe.available).each(GROUPS)(
    'agrees with the SQLite database EF Core creates for the $label',
    async (group: VerifyGroup) => {
      const ir: IrSchema = expectOk(
        await parseEfcore(
          group.sources.map((path: string) => ({
            path,
            text: readFileSync(path, 'utf8'),
          })),
          { appLabel: 'blog' }
        )
      );
      const database = output[group.context];
      expect(database, `no output for ${group.context}`).toBeDefined();
      expect(compareWithDatabase(ir, toDbSchema(database ?? {}, ir))).toEqual(
        []
      );
    }
  );
});
