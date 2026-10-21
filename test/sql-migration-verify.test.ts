import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { IrSchema } from '../src/ir.js';
import { parseSqlDdl } from '../src/parsers/sqlDdl.js';
import { expectOk } from './helpers.js';
import { titleWithReason } from './realToolSupport.js';
import { SQL_TEST_TIMEOUT_MS } from './sqlDdlSupport.js';
import {
  canonicalSchema,
  MIGRATION_ENGINES,
  names,
  readDump,
  replayDirectory,
  scenarioDirectory,
  type MigrationEngine,
  type MigrationEngineName,
  type MigrationRun,
} from './sqlMigrationSupport.js';

/**
 * Runs sets of migration files in real databases (PostgreSQL, MySQL, SQLite), dumps the schema each one ends
 * with (`pg_dump --schema-only`, `SHOW CREATE TABLE`, `sqlite_master`) and checks that replaying the same
 * files with the SQL reader gives the same schema as reading that dump. The comparison is exact, down to the
 * order of the columns, except for the documented differences listed at `canonicalSchema`: names the database
 * invents, and the type cast PostgreSQL adds to a default expression. PostgreSQL runs when `SQL_POSTGRES_URL`
 * is set and MySQL when `SQL_MYSQL_URL` is set (with `psql`, `pg_dump` and `mysql` on the PATH); SQLite runs
 * wherever a SQLite binding is available. See test/README.md.
 */

interface Scenario {
  engine: MigrationEngineName;
  name: string;
  /** The files in the order they have to run. */
  order: string[];
  /** A file that changes the schema; a replay without it has to differ from the server, which proves the comparison can fail. */
  control: string;
  /** Constraint and index names the migrations chose, which the replay has to carry through renames. */
  checks(schema: IrSchema): void;
}

function relationNamed(schema: IrSchema, table: string, relation: string) {
  const model = schema.models.find(
    (candidate) => candidate.tableName === table
  );
  return model?.relations.find((candidate) => candidate.name === relation);
}

function indexNames(schema: IrSchema, table: string): string[] {
  const model = schema.models.find(
    (candidate) => candidate.tableName === table
  );
  return (model?.indexes ?? []).map((index) => index.name ?? '').sort();
}

const SCENARIOS: readonly Scenario[] = [
  {
    engine: 'postgresql',
    name: 'blog',
    control: 'V6__drops.sql',
    order: [
      'V1__create_tables.sql',
      'V2__add_columns.sql',
      'V3__renames.sql',
      'V4__change_columns.sql',
      'V5__indexes_and_keys.sql',
      'V6__drops.sql',
      'R__refresh_tags.sql',
    ],
    checks: (schema: IrSchema): void => {
      // The foreign key keeps the name it was given by RENAME CONSTRAINT, and follows the renamed table.
      expect(relationNamed(schema, 'post', 'author')).toMatchObject({
        targetModel: 'Writer',
        constraintName: 'post_writer_fk',
      });
      expect(indexNames(schema, 'post')).toEqual(['post_writer_status_idx']);
      expect(schema.models.some((model) => model.tableName === 'scratch')).toBe(
        false
      );
    },
  },
  {
    engine: 'postgresql',
    name: 'shop',
    control: '10_cleanup.sql',
    order: ['1_init.sql', '2_rename_and_types.sql', '10_cleanup.sql'],
    checks: (schema: IrSchema): void => {
      // order_line points at the renamed table and the renamed key column.
      expect(relationNamed(schema, 'order_line', 'purchase')).toMatchObject({
        targetModel: 'Purchase',
      });
      expect(indexNames(schema, 'order_line')).toEqual(['order_line_sku_idx']);
    },
  },
  {
    engine: 'mysql',
    name: 'blog',
    control: 'V6__drops.sql',
    order: [
      'V1__create_tables.sql',
      'V2__add_columns.sql',
      'V3__renames.sql',
      'V4__change_columns.sql',
      'V5__indexes_and_keys.sql',
      'V6__drops.sql',
      'R__refresh_tags.sql',
    ],
    checks: (schema: IrSchema): void => {
      expect(relationNamed(schema, 'post', 'author')).toMatchObject({
        targetModel: 'Writer',
        constraintName: 'post_author_fk',
      });
      expect(indexNames(schema, 'post')).toEqual(['post_writer_status_idx']);
    },
  },
  {
    engine: 'mysql',
    name: 'shop',
    control: '10_cleanup.sql',
    order: ['1_init.sql', '2_rename_and_types.sql', '10_cleanup.sql'],
    checks: (schema: IrSchema): void => {
      expect(relationNamed(schema, 'customer', 'referred_by')).toMatchObject({
        constraintName: 'customer_referred_fk',
        onDelete: 'cascade',
      });
      expect(indexNames(schema, 'order_line')).toEqual([
        'order_line_sku_qty_idx',
      ]);
    },
  },
  {
    engine: 'postgresql',
    name: 'edge',
    control: '03_types_columns_tables.sql',
    order: [
      '01_names_the_database_gives.sql',
      '02_use_those_names.sql',
      '03_types_columns_tables.sql',
    ],
    checks: (schema: IrSchema): void => {
      // The enum was renamed and extended; the column that uses it follows.
      expect(schema.enums.map((item) => item.name)).toEqual(['Tier']);
      expect(schema.enums[0]?.values.map((value) => value.dbValue)).toEqual([
        'minimal',
        'mid',
        'high',
      ]);
      expect(relationNamed(schema, 'audit', 'reviewer')).toMatchObject({
        constraintName: 'audit_reviewer_fk',
        onDelete: 'setNull',
      });
    },
  },
  {
    engine: 'mysql',
    name: 'edge',
    control: '02_use_those_names.sql',
    order: ['01_names_the_database_gives.sql', '02_use_those_names.sql'],
    checks: (schema: IrSchema): void => {
      expect(relationNamed(schema, 'member', 'reviewer')).toMatchObject({
        constraintName: 'member_reviewer_fk',
      });
      expect(indexNames(schema, 'member')).toEqual(['member_email_idx']);
    },
  },
  {
    engine: 'cockroachdb',
    name: 'shop',
    control: '2_changes.sql',
    order: ['1_init.sql', '2_changes.sql'],
    checks: (schema: IrSchema): void => {
      expect(relationNamed(schema, 'purchase', 'buyer')).toMatchObject({
        targetModel: 'Customer',
      });
      expect(indexNames(schema, 'purchase')).toEqual([
        'purchase_buyer_idx',
        'purchase_status_idx',
      ]);
    },
  },
  {
    engine: 'sqlite',
    name: 'drizzle',
    control: '0002_recreate_articles.sql',
    order: [
      '0000_init.sql',
      '0001_rename_and_drop.sql',
      '0002_recreate_articles.sql',
    ],
    checks: (schema: IrSchema): void => {
      // The articles table was dropped and created again under the same name; its index was created last.
      expect(indexNames(schema, 'articles')).toEqual(['articles_author_idx']);
      expect(relationNamed(schema, 'articles', 'author')).toMatchObject({
        onDelete: 'setNull',
      });
    },
  },
];

describe.each(MIGRATION_ENGINES)(
  'migration replay against $name',
  (engine: MigrationEngine) => {
    const enabled: boolean = engine.probe.available;
    const scenarios: Scenario[] = SCENARIOS.filter(
      (scenario: Scenario) => scenario.engine === engine.name
    );

    describe.each(scenarios)('$name', (scenario: Scenario) => {
      it.skipIf(!enabled)(
        titleWithReason(
          'replaying the migrations gives the schema the server ends with',
          engine.probe
        ),
        async () => {
          const directory: string = scenarioDirectory(
            engine.name,
            scenario.name
          );
          const replayed = await replayDirectory(directory);
          expect(names(replayed.files)).toEqual(scenario.order);

          const live: MigrationRun = engine.run(replayed.files);
          try {
            const dumped: IrSchema = readDump(live.dump);
            expect(canonicalSchema(replayed.schema)).toEqual(
              canonicalSchema(dumped)
            );
            scenario.checks(replayed.schema);

            // The replay says what it skipped: row data, once, and nothing else.
            expect(
              replayed.schema.warnings.filter(
                (warning: string) =>
                  !/^Skipped \d+ data statements? \(first at .+\): row data is not part of the schema\.$/.test(
                    warning
                  )
              )
            ).toEqual([]);

            // A replay that stops one migration early has to differ, so the comparison is not vacuous.
            const early: IrSchema = expectOk(
              parseSqlDdl(
                replayed.files
                  .filter((path: string) => basename(path) !== scenario.control)
                  .map((path: string) => ({
                    path,
                    text: readFileSync(path, 'utf8'),
                  })),
                { appLabel: 'app' }
              )
            );
            expect(canonicalSchema(early)).not.toEqual(canonicalSchema(dumped));
          } finally {
            live.dispose();
          }
        },
        SQL_TEST_TIMEOUT_MS
      );
    });
  }
);
