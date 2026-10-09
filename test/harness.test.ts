import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { ConvertResult } from '../src/convert.js';
import {
  registerFormat,
  unregisterFormat,
  type FormatAdapter,
  type FormatEmitOutput,
  type SourceText,
} from '../src/formats.js';
import type { IrModel, IrSchema } from '../src/ir.js';
import { ok, type Result } from '../src/result.js';
import { computeCell } from './conversionMatrix.js';
import {
  convertCanonical,
  describeDrift,
  describeResultDrift,
  expectConversionMatchesGolden,
  expectFilesMatchGolden,
  listGoldenEntries,
  resultToSources,
  roundTrip,
  type RoundTripResult,
} from './harness.js';
import { listFormats } from '../src/formats.js';

/**
 * A test-only format that can be read and written and produces several files
 * (`models/<Name>.json`, one per model). It stands in for a multi-file format
 * with a parser, so the harness paths for file maps are exercised before the
 * Doctrine parser exists.
 */
const FILE_MAP_FORMAT: string = 'filemap';

const fileMapAdapter: FormatAdapter = {
  name: FILE_MAP_FORMAT,
  extensions: [],
  description: 'Test-only readable multi-file format',
  parse: (sources: SourceText[]): Promise<Result<IrSchema>> => {
    const models: IrModel[] = sources
      .filter((source: SourceText) => source.path.endsWith('.json'))
      .map((source: SourceText): IrModel => {
        const data = JSON.parse(source.text) as {
          name: string;
          tableName: string;
        };
        return {
          name: data.name,
          tableName: data.tableName,
          appLabel: 'blog',
          fields: [
            {
              name: 'id',
              columnName: 'id',
              type: 'int',
              isPrimaryKey: true,
              isUnique: false,
              isNullable: false,
              isAutoUpdated: false,
              default: { kind: 'autoIncrement' },
            },
          ],
          relations: [],
          indexes: [],
        };
      });
    return Promise.resolve(ok({ models, enums: [], warnings: [] }));
  },
  emit: (schema: IrSchema): Result<FormatEmitOutput> => {
    const files: Record<string, string> = {};
    for (const model of schema.models) {
      files[`models/${model.name}.json`] = `${JSON.stringify({
        name: model.name,
        tableName: model.tableName,
      })}\n`;
    }
    return ok({ files, warnings: [] });
  },
};

beforeAll(() => {
  unregisterFormat(FILE_MAP_FORMAT);
  registerFormat(fileMapAdapter);
});

afterAll(() => {
  unregisterFormat(FILE_MAP_FORMAT);
});

const directories: string[] = [];

function tempDirectory(): string {
  const directory: string = mkdtempSync(join(tmpdir(), 'ormbridge-harness-'));
  directories.push(directory);
  return directory;
}

function writeGolden(root: string, path: string, text: string): void {
  const target: string = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, text);
}

const previousUpdate: string | undefined = process.env.UPDATE_GOLDEN;

afterEach(() => {
  if (previousUpdate === undefined) {
    delete process.env.UPDATE_GOLDEN;
  } else {
    process.env.UPDATE_GOLDEN = previousUpdate;
  }
});

afterAll(() => {
  for (const directory of directories) {
    rmSync(directory, { recursive: true, force: true });
  }
});

/** Runs a check that must fail even when the suite itself runs with UPDATE_GOLDEN=1. */
function withoutUpdate(action: () => void): void {
  delete process.env.UPDATE_GOLDEN;
  action();
}

describe('expectFilesMatchGolden', () => {
  it('passes when every file matches its golden', () => {
    const root: string = tempDirectory();
    writeGolden(root, 'pair.preserve/src/A.php', 'a\n');
    writeGolden(root, 'pair.preserve/src/Enum/B.php', 'b\n');
    withoutUpdate(() => {
      expect(() =>
        expectFilesMatchGolden(
          'pair.preserve',
          { 'src/A.php': 'a\n', 'src/Enum/B.php': 'b\n' },
          root
        )
      ).not.toThrow();
    });
  });

  it('names a generated file that has no golden', () => {
    const root: string = tempDirectory();
    writeGolden(root, 'pair/src/A.php', 'a\n');
    withoutUpdate(() => {
      expect(() =>
        expectFilesMatchGolden(
          'pair',
          { 'src/A.php': 'a\n', 'src/New.php': 'n\n' },
          root
        )
      ).toThrow(/Added \(no golden file\): src\/New\.php\. Removed .*: none/);
    });
  });

  it('names a golden file that is no longer generated', () => {
    const root: string = tempDirectory();
    writeGolden(root, 'pair/src/A.php', 'a\n');
    writeGolden(root, 'pair/src/Gone.php', 'g\n');
    withoutUpdate(() => {
      expect(() =>
        expectFilesMatchGolden('pair', { 'src/A.php': 'a\n' }, root)
      ).toThrow(/Added \(no golden file\): none\. Removed .*: src\/Gone\.php/);
    });
  });

  it('fails when a file differs from its golden', () => {
    const root: string = tempDirectory();
    writeGolden(root, 'pair/src/A.php', 'a\n');
    withoutUpdate(() => {
      expect(() =>
        expectFilesMatchGolden('pair', { 'src/A.php': 'changed\n' }, root)
      ).toThrow();
    });
  });

  it('fails when the golden directory does not exist', () => {
    const root: string = tempDirectory();
    withoutUpdate(() => {
      expect(() =>
        expectFilesMatchGolden('missing', { 'src/A.php': 'a\n' }, root)
      ).toThrow(/Added \(no golden file\): src\/A\.php/);
    });
  });

  it('rewrites the directory with UPDATE_GOLDEN=1 and drops goldens of removed files', () => {
    const root: string = tempDirectory();
    writeGolden(root, 'pair/src/Gone.php', 'g\n');
    process.env.UPDATE_GOLDEN = '1';
    expectFilesMatchGolden(
      'pair',
      { 'src/A.php': 'a\n', 'src/Enum/B.php': 'b\n' },
      root
    );
    expect(readFileSync(join(root, 'pair/src/A.php'), 'utf8')).toBe('a\n');
    expect(readFileSync(join(root, 'pair/src/Enum/B.php'), 'utf8')).toBe('b\n');
    expect(existsSync(join(root, 'pair/src/Gone.php'))).toBe(false);
  });

  it('refuses paths that escape the golden directory', () => {
    const root: string = tempDirectory();
    expect(() =>
      expectFilesMatchGolden('pair', { '../outside.php': 'x' }, root)
    ).toThrow(/not relative/);
    expect(() => expectFilesMatchGolden('../pair', {}, root)).toThrow(
      /Invalid golden directory name/
    );
  });
});

describe('expectConversionMatchesGolden', () => {
  // These read the real goldens; with UPDATE_GOLDEN=1 they would rewrite them
  // while conversion.test.ts does the same, so they only run in check mode.
  const checking: boolean = process.env.UPDATE_GOLDEN !== '1';

  it.skipIf(!checking)(
    'compares single-text results with <pair>.<naming>.txt',
    async () => {
      const result: ConvertResult = await convertCanonical('django', 'prisma');
      expect(result.files).toBeUndefined();
      expect(() =>
        expectConversionMatchesGolden('django-to-prisma', 'preserve', result)
      ).not.toThrow();
      expect(listGoldenEntries()).toContain('django-to-prisma.preserve.txt');
    }
  );

  it.skipIf(!checking)(
    'compares multi-file results with the <pair>.<naming>/ directory',
    async () => {
      const result: ConvertResult = await convertCanonical(
        'django',
        'doctrine'
      );
      expect(result.files).toBeDefined();
      expect(() =>
        expectConversionMatchesGolden('django-to-doctrine', 'preserve', result)
      ).not.toThrow();
      expect(listGoldenEntries()).toContain('django-to-doctrine.preserve');
    }
  );
});

describe('resultToSources and round trips with a multi-file format', () => {
  it('turns a file map into one source per file in path order', () => {
    const result: ConvertResult = {
      output: '',
      files: { 'b/two.txt': '2', 'a/one.txt': '1' },
      warnings: [],
      modelCount: 2,
    };
    expect(resultToSources(result, 'x')).toEqual([
      { path: 'a/one.txt', text: '1' },
      { path: 'b/two.txt', text: '2' },
    ]);
  });

  it('turns single text into one roundtrip source', () => {
    expect(
      resultToSources({ output: 'abc', warnings: [], modelCount: 1 }, 'prisma')
    ).toEqual([{ path: 'roundtrip.prisma', text: 'abc' }]);
  });

  it('feeds every emitted file back into the parser', async () => {
    const trip: RoundTripResult = await roundTrip('django', FILE_MAP_FORMAT);
    const forwardFiles: string[] = Object.keys(trip.forward.files ?? {});
    expect(forwardFiles.length).toBeGreaterThan(1);
    expect(forwardFiles).toContain('models/Post.json');
    // The way back read all of the files: every model reached the Django text.
    expect(trip.back.output).toContain('class Post(');
    expect(trip.back.output).toContain('class Category(');
    expect(Object.keys(trip.forwardAgain.files ?? {}).sort()).toEqual(
      forwardFiles.sort()
    );
  });

  it('runs a conversion matrix cell for a multi-file target', async () => {
    const django = listFormats().find((format) => format.name === 'django');
    const target = listFormats().find(
      (format) => format.name === FILE_MAP_FORMAT
    );
    if (django === undefined || target === undefined) {
      throw new Error('formats missing');
    }
    const cell = await computeCell(django, target);
    expect(cell.emitted).toContain('"name":"Post"');
    expect(cell.sourceSchema.models.length).toBeGreaterThan(1);
  });
});

describe('describeResultDrift', () => {
  it('equals describeDrift for single-text results', () => {
    const before: ConvertResult = {
      output: 'a\nb\n',
      warnings: [],
      modelCount: 1,
    };
    const after: ConvertResult = {
      output: 'a\nc\n',
      warnings: [],
      modelCount: 1,
    };
    expect(describeResultDrift(before, after)).toBe(
      describeDrift('a\nb\n', 'a\nc\n')
    );
  });

  it('lists changed, added and removed files', () => {
    const before: ConvertResult = {
      output: '',
      files: { 'same.php': 'x\n', 'changed.php': 'a\nb\n', 'gone.php': 'g\n' },
      warnings: [],
      modelCount: 3,
    };
    const after: ConvertResult = {
      output: '',
      files: { 'same.php': 'x\n', 'changed.php': 'a\nc\n', 'new.php': 'n\n' },
      warnings: [],
      modelCount: 3,
    };
    expect(describeResultDrift(before, after)).toBe(
      '@@ changed.php\n+ c\n- b\n- file gone.php\n+ file new.php\n'
    );
  });

  it('is empty for identical file maps', () => {
    const result: ConvertResult = {
      output: '',
      files: { 'a.php': 'a\n' },
      warnings: [],
      modelCount: 1,
    };
    expect(describeResultDrift(result, { ...result })).toBe('');
  });
});
