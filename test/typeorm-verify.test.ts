import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import type { IrSchema } from '../src/ir.js';
import { normalizeSchema, type NamingMode } from '../src/transforms.js';
import type { PrismaProvider } from '../src/emitters/prisma.js';
import {
  buildSpec,
  convertSource,
  parseSource,
  titleWithReason,
  VERIFY_SOURCES,
  writeProjectFile,
  type ToolProbe,
  type VerifySource,
} from './realToolSupport.js';

/**
 * Compiles the generated TypeORM entities with `tsc` (experimentalDecorators and
 * emitDecoratorMetadata), builds TypeORM's metadata for them and compares it with the IR of every
 * readable canonical fixture. SQLite entities are also synchronized into an in-memory database
 * (`synchronize: true`, better-sqlite3) and the created tables, columns, foreign keys, unique
 * constraints and indexes are compared. PostgreSQL, MySQL and SQL Server entities cannot create a
 * database here, so TypeORM's own metadata validation (which rejects column types the driver
 * does not support) and the metadata comparison stand in for it.
 *
 * Set TYPEORM_DIR to a directory where `npm install typeorm reflect-metadata better-sqlite3
 * typescript @types/node` has been run (optionally also `pg mysql2 mssql` for the other
 * providers); see test/README.md and test/tools/setup-verification-tools.sh. The tests are
 * skipped when it is not set.
 */

interface ProviderCase {
  /** The ormbridge provider option. */
  provider: PrismaProvider;
  /** The TypeORM driver name the validator uses. */
  driver: string;
  /** The npm package that must be installed for the driver. */
  package: string;
}

const PROVIDERS: readonly ProviderCase[] = [
  { provider: 'sqlite', driver: 'sqlite', package: 'better-sqlite3' },
  { provider: 'postgresql', driver: 'postgres', package: 'pg' },
  { provider: 'mysql', driver: 'mysql', package: 'mysql2' },
  { provider: 'sqlserver', driver: 'mssql', package: 'mssql' },
];

const REQUIRED_PACKAGES: readonly string[] = [
  'typeorm',
  'reflect-metadata',
  'typescript',
  '@types/node',
  'better-sqlite3',
];

const VALIDATOR_SOURCE: string = readFileSync(
  fileURLToPath(new URL('./tools/validate-typeorm.ts', import.meta.url)),
  'utf8'
);

const TSCONFIG: string = JSON.stringify(
  {
    compilerOptions: {
      target: 'ES2022',
      module: 'nodenext',
      moduleResolution: 'nodenext',
      strict: true,
      experimentalDecorators: true,
      emitDecoratorMetadata: true,
      esModuleInterop: true,
      skipLibCheck: true,
      outDir: 'dist',
      types: ['node'],
    },
    include: ['*.ts'],
  },
  null,
  2
);

function probeTypeorm(): ToolProbe & { directory: string } {
  const directory: string = process.env.TYPEORM_DIR ?? '';
  if (directory === '') {
    return {
      available: false,
      reason:
        'set TYPEORM_DIR to a directory with typeorm, reflect-metadata, better-sqlite3 and typescript installed (see test/README.md)',
      directory,
    };
  }
  const missing: string[] = REQUIRED_PACKAGES.filter(
    (name: string) =>
      !existsSync(join(directory, 'node_modules', name, 'package.json'))
  );
  if (missing.length > 0) {
    return {
      available: false,
      reason: `TYPEORM_DIR is missing ${missing.join(', ')} (see test/README.md)`,
      directory,
    };
  }
  return { available: true, reason: '', directory };
}

const probe: ReturnType<typeof probeTypeorm> = probeTypeorm();
const toolDirectory: string = probe.directory;

/** Providers whose driver package is installed, so TypeORM can construct a DataSource. */
const installedProviders: ProviderCase[] = probe.available
  ? PROVIDERS.filter((entry: ProviderCase) =>
      existsSync(join(toolDirectory, 'node_modules', entry.package))
    )
  : [];

const directories: string[] = [];

afterAll(() => {
  for (const directory of directories) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function run(
  directory: string,
  command: string,
  args: string[]
): SpawnSyncReturns<string> {
  return spawnSync(command, args, {
    cwd: directory,
    encoding: 'utf8',
    timeout: 240_000,
  });
}

describe(titleWithReason('typeorm emitter: real TypeORM', probe), () => {
  const cases: (readonly [VerifySource, NamingMode])[] = VERIFY_SOURCES.filter(
    (source: VerifySource) => source.format !== 'typeorm'
  ).flatMap((source: VerifySource): (readonly [VerifySource, NamingMode])[] => [
    [source, 'preserve'],
    [source, 'normalize'],
  ]);

  it.skipIf(!probe.available).each(cases)(
    'compiles, loads and synchronizes the entities generated from %o (%s naming)',
    async (source: VerifySource, naming: NamingMode) => {
      const from: string = source.label;
      const parsed: IrSchema = await parseSource(source);
      const prepared: IrSchema =
        naming === 'normalize' ? normalizeSchema(parsed) : parsed;

      const directory: string = mkdtempSync(
        join(tmpdir(), 'ormbridge-typeorm-')
      );
      directories.push(directory);
      symlinkSync(
        join(toolDirectory, 'node_modules'),
        join(directory, 'node_modules'),
        'dir'
      );
      for (const entry of installedProviders) {
        const result = await convertSource(source, 'typeorm', {
          naming,
          provider: entry.provider,
        });
        writeProjectFile(
          directory,
          `entities-${entry.driver}.ts`,
          `import 'reflect-metadata';\n${result.output}`
        );
      }
      writeProjectFile(directory, 'tsconfig.json', TSCONFIG);
      writeProjectFile(directory, 'validate-typeorm.ts', VALIDATOR_SOURCE);
      writeProjectFile(
        directory,
        'spec.json',
        JSON.stringify(buildSpec(prepared))
      );

      const compiled: SpawnSyncReturns<string> = run(
        directory,
        join(toolDirectory, 'node_modules', '.bin', 'tsc'),
        ['-p', 'tsconfig.json']
      );
      expect(compiled.stdout + compiled.stderr, `${from} tsc`).toBe('');
      expect(compiled.status).toBe(0);

      const verified: SpawnSyncReturns<string> = run(directory, 'node', [
        'dist/validate-typeorm.js',
        'spec.json',
        ...installedProviders.map((entry: ProviderCase) => entry.driver),
      ]);
      expect(verified.stderr, `${from}: ${verified.stdout}`).toBe('');
      expect(verified.stdout).toContain('typeorm entities verified');
      expect(verified.status).toBe(0);
    },
    300_000
  );
});
