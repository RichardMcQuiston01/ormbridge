import { basename, dirname, sep } from 'node:path';

/**
 * The order in which the SQL files of a migration directory run. A directory is read as one schema, so the
 * order matters: a later `ALTER TABLE` must see the table an earlier file creates. Three conventions are
 * understood:
 *
 * - Flyway: `V<version>__name.sql` run by version number (`V2` before `V10`, `V1.2` before `V1.10`), then the
 *   repeatable `R__name.sql` files by name. Undo scripts (`U<version>__name.sql`) are never read. Files that
 *   follow neither pattern (a baseline dump, for example) come first.
 * - drizzle-kit: `NNNN_name.sql` in the order of `meta/_journal.json` when that file lists them.
 * - Anything else: natural file-name order, so `2_x.sql` comes before `10_x.sql`, directory by directory.
 */

const FLYWAY_VERSIONED: RegExp = /^V(\d+(?:[._]\d+)*)__.*\.sql$/;
const FLYWAY_REPEATABLE: RegExp = /^R__.*\.sql$/;
const FLYWAY_UNDO: RegExp = /^U(?:\d+(?:[._]\d+)*)?__.*\.sql$/;
/** Flyway callbacks (`beforeMigrate.sql`, `afterEachMigrate__log.sql`) run around the migrations, not as one. */
const FLYWAY_CALLBACK: RegExp =
  /^(?:before|after)(?:Each)?(?:Migrate|Undo|Clean|Info|Validate|Baseline|Repair|Connect|Versioned|Repeatable|Version)[A-Za-z]*(?:__.*)?\.sql$/;

/** True for a Flyway undo script or callback, which is not part of the schema history. */
export function isSqlMigrationSideFile(fileName: string): boolean {
  return FLYWAY_UNDO.test(fileName) || FLYWAY_CALLBACK.test(fileName);
}

const COLLATOR: Intl.Collator = new Intl.Collator('en', { numeric: true });

function compareNatural(left: string, right: string): number {
  const result: number = COLLATOR.compare(left, right);
  if (result !== 0) {
    return result;
  }
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Version parts of `V1_2__x.sql` as numbers: [1, 2]. */
function versionOf(fileName: string): number[] | undefined {
  const match: RegExpExecArray | null = FLYWAY_VERSIONED.exec(fileName);
  if (match === null) {
    return undefined;
  }
  return (match[1] ?? '').split(/[._]/).map((part: string) => Number(part));
}

function compareVersions(left: number[], right: number[]): number {
  const length: number = Math.max(left.length, right.length);
  for (let at: number = 0; at < length; at += 1) {
    const difference: number = (left[at] ?? 0) - (right[at] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
}

/** Compares two paths directory by directory, each name in natural order. */
function comparePaths(
  left: string,
  right: string,
  journalRank: (path: string) => number | undefined
): number {
  const leftDirectory: string = dirname(left);
  if (leftDirectory === dirname(right)) {
    const leftRank: number | undefined = journalRank(left);
    const rightRank: number | undefined = journalRank(right);
    if (leftRank !== undefined && rightRank !== undefined) {
      return leftRank - rightRank;
    }
  }
  const leftParts: string[] = left.split(sep);
  const rightParts: string[] = right.split(sep);
  const length: number = Math.min(leftParts.length, rightParts.length);
  for (let at: number = 0; at < length; at += 1) {
    const result: number = compareNatural(
      leftParts[at] ?? '',
      rightParts[at] ?? ''
    );
    if (result !== 0) {
      return result;
    }
  }
  return leftParts.length - rightParts.length;
}

/**
 * Puts the SQL files found under one input directory in the order their migrations run. `journals` maps a
 * directory to the migration names (`0000_init` for `0000_init.sql`) its drizzle-kit `meta/_journal.json`
 * lists, in order.
 */
export function orderSqlMigrationFiles(
  files: readonly string[],
  journals: ReadonlyMap<string, readonly string[]> = new Map()
): string[] {
  const journalRank = (path: string): number | undefined => {
    const tags: readonly string[] | undefined = journals.get(dirname(path));
    if (tags === undefined) {
      return undefined;
    }
    const name: string = basename(path).replace(/\.sql$/i, '');
    const at: number = tags.indexOf(name);
    return at === -1 ? undefined : at;
  };
  const usable: string[] = files.filter(
    (path: string) => !isSqlMigrationSideFile(basename(path))
  );
  const versioned: string[] = [];
  const repeatable: string[] = [];
  const others: string[] = [];
  for (const path of usable) {
    const name: string = basename(path);
    if (FLYWAY_VERSIONED.test(name)) {
      versioned.push(path);
    } else if (FLYWAY_REPEATABLE.test(name)) {
      repeatable.push(path);
    } else {
      others.push(path);
    }
  }
  versioned.sort((left: string, right: string): number => {
    const byVersion: number = compareVersions(
      versionOf(basename(left)) ?? [],
      versionOf(basename(right)) ?? []
    );
    return byVersion !== 0
      ? byVersion
      : compareNatural(basename(left), basename(right));
  });
  repeatable.sort((left: string, right: string) =>
    compareNatural(basename(left), basename(right))
  );
  others.sort((left: string, right: string) =>
    comparePaths(left, right, journalRank)
  );
  return [...others, ...versioned, ...repeatable];
}
