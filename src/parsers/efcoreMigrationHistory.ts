import type Parser from 'web-tree-sitter';
import type { IrSchema } from '../ir.js';
import { err, ok, type Result } from '../result.js';
import {
  type ConstLookup,
  type CsClass,
  type CsFile,
  type CsType,
  type CsValue,
} from './csharpSyntax.js';
import { readCSharpFile } from './csharpDeclarations.js';
import {
  findMigrations,
  replayMigration,
  type MigrationClassInfo,
} from './efcoreMigrationReplay.js';
import {
  applySnapshotNames,
  buildMigrationSchema,
  describeDifferences,
} from './efcoreMigrationSchema.js';
import type { MigrationSchema } from './efcoreMigrationState.js';
import {
  readSnapshotClass,
  snapshotSchema,
  type SnapshotRead,
} from './efcoreSnapshot.js';

export interface MigrationSourceFile {
  path: string;
  text: string;
}

/** Build output and the generated `.Designer.cs` files carry no `Up` method or model. */
const NOT_HISTORY: RegExp = /(?:^|[\\/])(?:bin|obj)[\\/]|\.Designer\.cs$/i;
const TIMESTAMP_ID: RegExp = /^\d{14}_/;
/** The number of differences between snapshot and migrations a warning lists. */
const LISTED_DIFFERENCES: number = 5;

const NO_CONSTANTS: ConstLookup = (): CsValue | undefined => undefined;

function isSnapshotBase(base: CsType): boolean {
  return base.name === 'ModelSnapshot';
}

/** True when the C# text declares something that looks like a migration or a model snapshot. */
export function mentionsMigrationHistory(text: string): boolean {
  return /\b(?:Migration|ModelSnapshot)\b/.test(text);
}

/**
 * Builds the schema that EF Core migrations leave behind. The `Up` methods are replayed in migration order
 * (the timestamp in the file name); a `*ModelSnapshot.cs` is read as well, and when it agrees with the replay its
 * entity, property and navigation names are used. Returns NO_MODELS_FOUND when the input has neither.
 */
export function readMigrationHistory(
  parser: Parser,
  sources: readonly MigrationSourceFile[],
  options: { appLabel: string },
  trees: Parser.Tree[]
): Result<IrSchema> {
  const warnings: string[] = [];
  const warn = (message: string): void => {
    warnings.push(message);
  };
  const migrations: MigrationClassInfo[] = [];
  const snapshots: { cls: CsClass; path: string }[] = [];
  for (const source of sources) {
    if (NOT_HISTORY.test(source.path) || !/\.cs$/i.test(source.path)) {
      continue;
    }
    if (!mentionsMigrationHistory(source.text)) {
      continue;
    }
    const tree: Parser.Tree = parser.parse(source.text);
    trees.push(tree);
    const file: CsFile = readCSharpFile(
      tree.rootNode,
      source.path,
      NO_CONSTANTS
    );
    if (file.hasErrors) {
      warn(
        `${source.path}: the file contains C# syntax errors; some statements may be missing from the result.`
      );
    }
    migrations.push(...findMigrations(file.classes, source.path));
    for (const cls of file.classes) {
      if (cls.bases.some(isSnapshotBase)) {
        snapshots.push({ cls, path: source.path });
      }
    }
  }
  if (migrations.length === 0 && snapshots.length === 0) {
    return err(
      'NO_MODELS_FOUND',
      `No Entity Framework Core entities or migrations were found in: ${sources.map((source: MigrationSourceFile) => source.path).join(', ')}. ` +
        `An entity is a class used in a DbSet<T> property of a DbContext, named by modelBuilder.Entity<T>() or an IEntityTypeConfiguration<T> class, ` +
        `reached through a navigation property, or marked with an EF Core data annotation such as [Table], [Key], [Index] or [ForeignKey]. ` +
        `A migration is a class that derives from Migration and has an Up method; pass the Migrations folder, with its ModelSnapshot, to replay them.`
    );
  }

  const ordered: MigrationClassInfo[] = [...migrations].sort(
    (first: MigrationClassInfo, second: MigrationClassInfo) =>
      first.id < second.id ? -1 : first.id > second.id ? 1 : 0
  );
  if (ordered.length > 1) {
    for (const migration of ordered) {
      if (!TIMESTAMP_ID.test(migration.id)) {
        warn(
          `${migration.path}: the migration id "${migration.id}" has no timestamp prefix (YYYYMMDDHHMMSS_); migrations were ordered by name.`
        );
      }
    }
  }
  const replayed: MigrationSchema = new Map();
  for (const migration of ordered) {
    replayMigration(migration, replayed, warn);
  }

  let snapshot: MigrationSchema | undefined;
  for (const { cls, path } of snapshots) {
    const read: SnapshotRead | undefined = readSnapshotClass(cls, path, warn);
    if (read === undefined) {
      warn(
        `${path}: the snapshot class ${cls.name} has no BuildModel method, so it was not read.`
      );
      continue;
    }
    snapshot ??= new Map();
    snapshotSchema(read.entities, read.defaultSchema, snapshot, path, warn);
  }

  let chosen: MigrationSchema = replayed;
  if (snapshot !== undefined) {
    if (ordered.length === 0) {
      warn(
        `The input has a model snapshot but no migrations, so the schema was read from the snapshot alone.`
      );
      chosen = snapshot;
    } else {
      const differences: string[] = describeDifferences(replayed, snapshot);
      if (differences.length === 0) {
        applySnapshotNames(replayed, snapshot);
      } else {
        const shown: string = differences
          .slice(0, LISTED_DIFFERENCES)
          .join('; ');
        const more: number = differences.length - LISTED_DIFFERENCES;
        warn(
          `The model snapshot does not agree with the migrations (${shown}${more > 0 ? `; and ${more} more` : ''}), so the schema was rebuilt from the migrations alone and the names in the snapshot were not used.`
        );
      }
    }
  }
  if (chosen.size === 0) {
    return err(
      'NO_MODELS_FOUND',
      `The Entity Framework Core migrations in ${sources.map((source: MigrationSourceFile) => source.path).join(', ')} leave no tables behind ` +
        `(every table is dropped again, or only altered without being created).`
    );
  }
  return ok(buildMigrationSchema(chosen, options, warnings));
}
