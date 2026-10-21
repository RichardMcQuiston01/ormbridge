import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import type { IrSchema } from '../src/ir.js';
import { parseEfcore } from '../src/parsers/efcore.js';
import { CANONICAL_FIXTURES } from './fixtures/canonical.js';
import {
  csharpFiles,
  isToolError,
  probeDotnet,
  runEfcoreTool,
  toDbSchema,
  type EfcoreDatabase,
  type EfcoreToolOutput,
} from './efcoreSupport.js';
import { expectOk } from './helpers.js';
import { titleWithReason } from './realToolSupport.js';
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

interface VerifyGroup {
  label: string;
  /** The DbContext type the tool creates. */
  context: string;
  /** The C# files the parser reads (absolute paths). */
  sources: readonly string[];
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
    label: 'orders (owned collections, OwnsMany)',
    context: 'OrdersContext',
    sources: csharpFiles(join(FIXTURES, 'efcore-extras', 'orders')),
  },
  {
    label: 'library (data annotations, delete behaviors)',
    context: 'LibraryContext',
    sources: csharpFiles(join(FIXTURES, 'efcore-extras', 'library')),
  },
];

const probe: ReturnType<typeof probeDotnet> = probeDotnet();
let output: EfcoreToolOutput = {};

beforeAll(() => {
  if (!probe.available) {
    return;
  }
  output = runEfcoreTool(probe, {
    fixturesDir: FIXTURES,
    contexts: GROUPS.map((group: VerifyGroup) => group.context),
  });
}, 960_000);

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
      if (isToolError(database)) {
        throw new Error(
          `EF Core rejected ${group.context}: ${database.__error}`
        );
      }
      expect(
        compareWithDatabase(
          ir,
          toDbSchema((database ?? {}) as EfcoreDatabase, ir),
          { compositeForeignKeys: true }
        )
      ).toEqual([]);
    }
  );
});
