import { spawn, spawnSync, type SpawnSyncReturns } from 'node:child_process';
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
import type { PrismaProvider } from '../src/emitters/prisma.js';
import { getFormat, type FormatEmitOutput } from '../src/formats.js';
import type { IrSchema } from '../src/ir.js';
import {
  expandManyToMany,
  normalizeSchema,
  type NamingMode,
} from '../src/transforms.js';
import { DRIZZLE_IR_FIXTURES } from './drizzleFixtures.js';
import { DEFAULT_OPTIONS, expectOk } from './helpers.js';
import {
  buildSpec,
  parseSource,
  titleWithReason,
  VERIFY_SOURCES,
  writeProjectFile,
  type ToolProbe,
  type VerifySource,
} from './realToolSupport.js';

/**
 * Compiles the generated Drizzle schemas with `tsc --strict`, runs `drizzle-kit generate` for the
 * PostgreSQL, MySQL and SQLite output (no database server is needed for that), `drizzle-kit push`
 * into a SQLite file, and compares what drizzle-kit and SQLite report (tables, columns,
 * nullability, primary keys, unique constraints, indexes, foreign keys and referential actions)
 * with the IR of every readable canonical fixture, the larger "extras" fixtures and the IR
 * fixtures in `drizzleFixtures.ts`. The script `tools/validate-drizzle.ts` also builds Drizzle's
 * relational configuration for each schema (so both sides of every relation must pair up) and runs
 * a relational query over every relation through `drizzle-orm/better-sqlite3`.
 *
 * Set DRIZZLE_DIR to a directory where `npm install drizzle-orm drizzle-kit typescript @types/node
 * better-sqlite3 @types/better-sqlite3` has been run; see test/README.md and
 * test/tools/setup-verification-tools.sh. The tests are skipped when it is not set.
 */

/** Directory name inside the scratch project, the ormbridge provider and the drizzle-kit dialect. */
interface DialectCase {
  directory: string;
  provider: PrismaProvider;
}

const DIALECTS: readonly DialectCase[] = [
  { directory: 'pg', provider: 'postgresql' },
  { directory: 'mysql', provider: 'mysql' },
  { directory: 'sqlite', provider: 'sqlite' },
];

const REQUIRED_PACKAGES: readonly string[] = [
  'drizzle-orm',
  'drizzle-kit',
  'typescript',
  '@types/node',
  'better-sqlite3',
  '@types/better-sqlite3',
];

/** drizzle-kit and tsc start slowly on a busy machine; every child process gets a generous limit. */
const TOOL_TIMEOUT_MS: number = 240_000;
const TEST_TIMEOUT_MS: number = 600_000;

const BLOG_VALIDATOR_SOURCE: string = readFileSync(
  fileURLToPath(new URL('./tools/validate-drizzle-blog.ts', import.meta.url)),
  'utf8'
);

const VALIDATOR_SOURCE: string = readFileSync(
  fileURLToPath(new URL('./tools/validate-drizzle.ts', import.meta.url)),
  'utf8'
);

const TSCONFIG: string = JSON.stringify(
  {
    compilerOptions: {
      target: 'ES2022',
      module: 'nodenext',
      moduleResolution: 'nodenext',
      strict: true,
      esModuleInterop: true,
      skipLibCheck: true,
      outDir: 'dist',
      rootDir: '.',
      types: ['node'],
    },
    include: ['*.ts', '*/schema.ts', '*/drizzle.config.ts'],
  },
  null,
  2
);

const PUSH_CONFIG: string = [
  `import { defineConfig } from 'drizzle-kit';`,
  '',
  'export default defineConfig({',
  `  dialect: 'sqlite',`,
  `  schema: './schema.ts',`,
  `  dbCredentials: { url: './push.db' },`,
  '});',
  '',
].join('\n');

function probeDrizzle(): ToolProbe & { directory: string } {
  const directory: string = process.env.DRIZZLE_DIR ?? '';
  if (directory === '') {
    return {
      available: false,
      reason:
        'set DRIZZLE_DIR to a directory with drizzle-orm, drizzle-kit, typescript and better-sqlite3 installed (see test/README.md)',
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
      reason: `DRIZZLE_DIR is missing ${missing.join(', ')} (see test/README.md)`,
      directory,
    };
  }
  return { available: true, reason: '', directory };
}

const probe: ReturnType<typeof probeDrizzle> = probeDrizzle();
const toolDirectory: string = probe.directory;
const directories: string[] = [];

afterAll(() => {
  for (const directory of directories) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function binary(name: string): string {
  return join(toolDirectory, 'node_modules', '.bin', name);
}

function runSync(
  directory: string,
  command: string,
  args: string[]
): SpawnSyncReturns<string> {
  return spawnSync(command, args, {
    cwd: directory,
    encoding: 'utf8',
    timeout: TOOL_TIMEOUT_MS,
  });
}

interface ToolRun {
  status: number | null;
  output: string;
}

/** Runs a command without blocking, so the three dialects can be processed side by side. */
function run(
  directory: string,
  command: string,
  args: string[]
): Promise<ToolRun> {
  return new Promise<ToolRun>((resolve) => {
    const child = spawn(command, args, { cwd: directory });
    let output: string = '';
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    const timer: NodeJS.Timeout = setTimeout(() => {
      child.kill('SIGKILL');
      output += `\ntimed out after ${TOOL_TIMEOUT_MS} ms`;
    }, TOOL_TIMEOUT_MS);
    child.on('close', (status: number | null) => {
      clearTimeout(timer);
      resolve({ status, output });
    });
  });
}

interface VerifyCase {
  label: string;
  load: () => Promise<IrSchema>;
}

const CASES: VerifyCase[] = [
  ...VERIFY_SOURCES.map((source: VerifySource): VerifyCase => ({
    label: source.label,
    load: () => parseSource(source),
  })),
  ...DRIZZLE_IR_FIXTURES.map(([label, make]): VerifyCase => ({
    label,
    load: () => Promise.resolve(make()),
  })),
];

/** The IR the emitter works from: many-to-many fields become join tables, then the naming mode applies. */
function preparedSchema(schema: IrSchema, naming: NamingMode): IrSchema {
  const expanded: IrSchema = expandManyToMany(schema);
  return naming === 'normalize' ? normalizeSchema(expanded) : expanded;
}

describe(titleWithReason('drizzle emitter: real Drizzle ORM', probe), () => {
  const cases: (readonly [string, NamingMode, VerifyCase])[] = CASES.flatMap(
    (verifyCase: VerifyCase): (readonly [string, NamingMode, VerifyCase])[] => [
      [verifyCase.label, 'preserve', verifyCase],
      [verifyCase.label, 'normalize', verifyCase],
    ]
  );

  it.skipIf(!probe.available).each(cases)(
    'compiles, generates SQL and pushes the schema generated from %s (%s naming)',
    async (label: string, naming: NamingMode, verifyCase: VerifyCase) => {
      const schema: IrSchema = await verifyCase.load();
      const directory: string = mkdtempSync(
        join(tmpdir(), 'ormbridge-drizzle-')
      );
      directories.push(directory);
      symlinkSync(
        join(toolDirectory, 'node_modules'),
        join(directory, 'node_modules'),
        'dir'
      );
      const adapter = expectOk(getFormat('drizzle'));
      for (const dialect of DIALECTS) {
        const emitted: FormatEmitOutput = expectOk(
          adapter.emit?.(schema, {
            ...DEFAULT_OPTIONS,
            naming,
            provider: dialect.provider,
          }) ?? {
            ok: false,
            error: { code: 'EMIT_FAILED', message: 'no emit' },
          }
        );
        expect(emitted.text, `${label} emits files`).toBeUndefined();
        for (const [path, text] of Object.entries(emitted.files ?? {})) {
          writeProjectFile(directory, join(dialect.directory, path), text);
        }
      }
      writeProjectFile(
        directory,
        join('sqlite', 'push.config.ts'),
        PUSH_CONFIG
      );
      writeProjectFile(directory, 'tsconfig.json', TSCONFIG);
      writeProjectFile(directory, 'validate-drizzle.ts', VALIDATOR_SOURCE);
      // The Django blog schema is also run against a real SQLite database.
      const runsBlog: boolean = label === 'django' && naming === 'preserve';
      if (runsBlog) {
        writeProjectFile(
          directory,
          'validate-drizzle-blog.ts',
          BLOG_VALIDATOR_SOURCE
        );
      }
      writeProjectFile(
        directory,
        'spec.json',
        JSON.stringify(buildSpec(preparedSchema(schema, naming)))
      );

      const compiled: SpawnSyncReturns<string> = runSync(
        directory,
        binary('tsc'),
        ['-p', 'tsconfig.json']
      );
      expect(compiled.stdout + compiled.stderr, `${label} tsc`).toBe('');
      expect(compiled.status).toBe(0);

      const generated: ToolRun[] = await Promise.all(
        DIALECTS.map((dialect: DialectCase) =>
          run(join(directory, dialect.directory), binary('drizzle-kit'), [
            'generate',
          ])
        )
      );
      generated.forEach((result: ToolRun, position: number) => {
        expect(
          result.status,
          `${label} drizzle-kit generate (${DIALECTS[position]?.directory}): ${result.output}`
        ).toBe(0);
      });
      const pushed: ToolRun = await run(
        join(directory, 'sqlite'),
        binary('drizzle-kit'),
        ['push', '--config=push.config.ts', '--force']
      );
      expect(pushed.status, `${label} drizzle-kit push: ${pushed.output}`).toBe(
        0
      );

      const verified: SpawnSyncReturns<string> = runSync(directory, 'node', [
        'dist/validate-drizzle.js',
        'spec.json',
        ...DIALECTS.map((dialect: DialectCase) => dialect.directory),
      ]);
      expect(verified.stderr, `${label}: ${verified.stdout}`).toBe('');
      expect(verified.stdout).toContain('drizzle schema verified');
      expect(verified.status).toBe(0);

      if (runsBlog) {
        const blog: SpawnSyncReturns<string> = runSync(directory, 'node', [
          'dist/validate-drizzle-blog.js',
        ]);
        expect(blog.stderr, `${label}: ${blog.stdout}`).toBe('');
        expect(blog.stdout).toContain('drizzle blog verified');
        expect(blog.status).toBe(0);
      }
    },
    TEST_TIMEOUT_MS
  );
});
