import { randomBytes } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { columnNameOf, emitSqlDdl } from '../src/emitters/sqlDdl.js';
import type { IrEnum, IrField, IrIndex, IrModel, IrSchema } from '../src/ir.js';
import {
  expandManyToMany,
  normalizeSchema,
  type NamingMode,
} from '../src/transforms.js';
import { constructsSchema } from './drizzleFixtures.js';
import { clickhouseTypesSchema } from './clickhouseFixtures.js';
import {
  clickhouseExecute,
  clickhouseRows,
  openClickhouseServer,
  snapshotClickhouse,
  splitStatements,
  type ChTableInfo,
  type ClickhouseAccess,
  type ClickhouseServer,
} from './clickhouseSupport.js';
import { kitchenSinkSchema, stressSchema } from './gormFixtures.js';
import {
  parseSource,
  titleWithReason,
  VERIFY_SOURCES,
  type VerifySource,
} from './realToolSupport.js';

/**
 * Runs the ClickHouse output of the SQL DDL writer in a real ClickHouse server (HTTP interface) and
 * compares what `system.tables`, `system.columns` and `system.data_skipping_indices` report (table
 * and column names, types including Nullable, sorting and primary key, comments, skipping indexes)
 * with the IR. Needs `CLICKHOUSE_URL` or `CLICKHOUSE_DOCKER=1` (see test/README.md); skipped with a
 * reason in the title otherwise.
 */

const access: ClickhouseAccess = await openClickhouseServer();
const enabled: boolean = access.probe.available;
const server: ClickhouseServer | undefined = access.server;

afterAll(() => {
  server?.stop();
});

const NAMING_MODES: readonly NamingMode[] = ['preserve', 'normalize'];

interface SchemaCase {
  label: string;
  load: () => Promise<IrSchema>;
}

const SCHEMAS: readonly SchemaCase[] = [
  ...VERIFY_SOURCES.map((source: VerifySource): SchemaCase => ({
    label: source.label,
    load: () => parseSource(source),
  })),
  { label: 'kitchen-sink', load: () => Promise.resolve(kitchenSinkSchema()) },
  { label: 'stress', load: () => Promise.resolve(stressSchema()) },
  { label: 'constructs', load: () => Promise.resolve(constructsSchema()) },
  {
    label: 'clickhouse-types',
    load: () => Promise.resolve(clickhouseTypesSchema()),
  },
];

// ---------------------------------------------------------------------------
// What the IR says the catalog must hold
// ---------------------------------------------------------------------------

const BASE_TYPES: Readonly<Record<string, RegExp>> = {
  string: /^(String|FixedString\(\d+\))$/,
  text: /^String$/,
  int: /^U?Int(8|16|32)$/,
  bigInt: /^U?Int64$/,
  float: /^Float(32|64)$/,
  decimal: /^Decimal\(\d+, \d+\)$/,
  boolean: /^Bool$/,
  dateTime: /^DateTime64\(\d\)$/,
  date: /^Date32$/,
  time: /^String$/,
  uuid: /^UUID$/,
  json: /^String$/,
  bytes: /^String$/,
  duration: /^Int64$/,
  ipAddress: /^IPv6$/,
  hstore: /^Map\(String, String\)$/,
  range: /^String$/,
};

function stripParentheses(key: string): string {
  const bare: string = key.replace(/`/g, '');
  return /^\(.*\)$/.test(bare) ? bare.slice(1, -1) : bare;
}

function unwrap(type: string): { inner: string; nullable: boolean } {
  const match: RegExpExecArray | null = /^Nullable\((.*)\)$/.exec(type);
  return match === null
    ? { inner: type, nullable: false }
    : { inner: match[1] ?? type, nullable: true };
}

function keyColumns(model: IrModel): string[] {
  const names: string[] =
    (model.compositePrimaryKey ?? []).length > 0
      ? (model.compositePrimaryKey ?? [])
      : [
          ...model.fields
            .filter((candidate: IrField) => candidate.isPrimaryKey)
            .map((candidate: IrField) => candidate.name),
          ...model.relations
            .filter((relation) => relation.isPrimaryKey === true)
            .map((relation) => relation.name),
        ];
  return names.map(
    (name: string) =>
      model.fields.find((candidate: IrField) => candidate.name === name)
        ?.columnName ??
      model.relations.find((relation) => relation.name === name)?.columnName ??
      name
  );
}

function compareTable(
  schema: IrSchema,
  model: IrModel,
  actual: ChTableInfo | undefined
): string[] {
  const problems: string[] = [];
  const label: string = model.tableName;
  if (actual === undefined) {
    return [`${label}: the table does not exist`];
  }
  const key: string[] = keyColumns(model);
  if (!/^MergeTree/.test(actual.engine)) {
    problems.push(`${label}: engine ${actual.engine} is not MergeTree`);
  }
  const wantedKey: string = key.join(', ');
  const sortingKey: string = stripParentheses(actual.sortingKey);
  if (sortingKey !== wantedKey) {
    problems.push(`${label}: sorting key "${sortingKey}" != "${wantedKey}"`);
  }
  const primaryKey: string = stripParentheses(actual.primaryKey);
  if (primaryKey !== wantedKey) {
    problems.push(`${label}: primary key "${primaryKey}" != "${wantedKey}"`);
  }
  if (model.isJoinTable === true && actual.comment === '') {
    problems.push(`${label}: the join table has no comment`);
  }

  const wanted: Map<string, { field?: IrField; nullable: boolean }> = new Map();
  for (const field of model.fields) {
    wanted.set(field.columnName, {
      field,
      nullable: field.isNullable && !key.includes(field.columnName),
    });
  }
  for (const relation of model.relations) {
    if (relation.kind !== 'manyToMany' && !wanted.has(relation.columnName)) {
      wanted.set(relation.columnName, {
        nullable: relation.isNullable && !key.includes(relation.columnName),
      });
    }
  }
  expect(Object.keys(actual.columns).sort(), label).toEqual(
    [...wanted.keys()].sort()
  );
  for (const [name, expected] of wanted) {
    const column = actual.columns[name];
    if (column === undefined) {
      continue;
    }
    const { inner, nullable } = unwrap(column.type);
    const field: IrField | undefined = expected.field;
    const isContainer: boolean = /^(Array|Map)\(/.test(inner);
    const where: string = `${label}.${name} (${column.type})`;
    const canBeNullable: boolean =
      !isContainer && !(field !== undefined && (field.arrayDepth ?? 0) > 0);
    if (nullable !== (expected.nullable && canBeNullable)) {
      problems.push(`${where}: nullability should be ${expected.nullable}`);
    }
    if (field === undefined) {
      continue;
    }
    if ((field.arrayDepth ?? 0) > 0) {
      if (!inner.startsWith('Array(')) {
        problems.push(`${where}: an array field must be an Array`);
      }
    } else if (field.enumName !== undefined) {
      const definition: IrEnum | undefined = schema.enums.find(
        (candidate: IrEnum) => candidate.name === field.enumName
      );
      if (definition !== undefined && !/^Enum(8|16)\(/.test(inner)) {
        problems.push(`${where}: an enum field must be an Enum`);
      }
      for (const value of definition?.values ?? []) {
        if (!inner.includes(value.dbValue.replace(/'/g, "\\'"))) {
          problems.push(
            `${where}: the enum member ${value.dbValue} is missing`
          );
        }
      }
    } else if (field.type !== 'unsupported') {
      const pattern: RegExp | undefined = BASE_TYPES[field.type];
      if (pattern !== undefined && !pattern.test(inner)) {
        problems.push(`${where}: unexpected type for ${field.type}`);
      }
    }
    if (field.type === 'decimal' && field.maxDigits !== undefined) {
      const wantedDecimal: string = `Decimal(${Math.min(field.maxDigits, 76)}, ${field.decimalPlaces ?? 0})`;
      if (inner !== wantedDecimal) {
        problems.push(`${where}: expected ${wantedDecimal}`);
      }
    }
    if (field.type === 'json' && column.comment !== 'JSON document') {
      problems.push(`${where}: the JSON note is missing`);
    }
    if (column.inSortingKey !== key.includes(name)) {
      problems.push(`${where}: is_in_sorting_key is ${column.inSortingKey}`);
    }
  }

  // Skipping indexes: one per index of the model that could be written, on the same columns.
  const columnsOf = (index: IrIndex): string[] =>
    index.fields.map((name: string) => columnNameOf(model, name) ?? name);
  const expectedIndexes: string[] = model.indexes
    .filter((index: IrIndex) =>
      columnsOf(index).every(
        (column: string) => !/^Map\(/.test(actual.columns[column]?.type ?? '')
      )
    )
    .map((index: IrIndex) => columnsOf(index).join(','))
    .sort();
  const actualIndexes: string[] = actual.indexes
    .map((index) =>
      index.expression
        .replace(/[`()]/g, '')
        .split(',')
        .map((part: string) => part.trim())
        .join(',')
    )
    .sort();
  if (JSON.stringify(actualIndexes) !== JSON.stringify(expectedIndexes)) {
    problems.push(
      `${label}: skipping indexes ${JSON.stringify(actualIndexes)} != ${JSON.stringify(expectedIndexes)}`
    );
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

function scratchName(): string {
  return `ormbridge_ch_${randomBytes(5).toString('hex')}`;
}

describe('ClickHouse DDL in a real server', () => {
  describe.each(SCHEMAS)('$label', (schemaCase) => {
    it.skipIf(!enabled)(
      titleWithReason(
        'creates the tables and matches the schema (both naming modes)',
        access.probe
      ),
      async () => {
        const running: ClickhouseServer = server as ClickhouseServer;
        const schema: IrSchema = await schemaCase.load();
        for (const naming of NAMING_MODES) {
          const output = emitSqlDdl(schema, {
            provider: 'clickhouse',
            naming,
          });
          const expanded: IrSchema = expandManyToMany(schema);
          const prepared: IrSchema =
            naming === 'normalize' ? normalizeSchema(expanded) : expanded;
          const database: string = scratchName();
          const extra: string[] = [
            ...new Set(
              prepared.models
                .map((model: IrModel) => model.schema)
                .filter(
                  (name: string | undefined): name is string =>
                    name !== undefined
                )
            ),
          ].map((name: string) => `${database}_${name}`);
          // A model with a database prefix is written as `db.table`; give each prefix a scratch database.
          const renamed: string = output.text.replace(
            /(?<=CREATE (?:TABLE|DATABASE IF NOT EXISTS) )`?(\w+)`?(?=[.;])/g,
            (_match: string, name: string) => `${database}_${name}`
          );
          await clickhouseExecute(running, `CREATE DATABASE ${database}`);
          try {
            for (const name of extra) {
              await clickhouseExecute(running, `CREATE DATABASE ${name}`);
            }
            for (const statement of splitStatements(renamed)) {
              try {
                await clickhouseExecute(running, statement, database);
              } catch (error: unknown) {
                throw new Error(
                  `${schemaCase.label} (${naming}) failed in ClickHouse: ${error instanceof Error ? error.message : String(error)}\n${statement}`,
                  { cause: error }
                );
              }
            }
            const home = await snapshotClickhouse(running, database);
            const problems: string[] = [];
            for (const model of prepared.models.filter(
              (candidate: IrModel) => candidate.isView !== true
            )) {
              const actual: ChTableInfo | undefined =
                model.schema === undefined
                  ? home[model.tableName]
                  : (
                      await snapshotClickhouse(
                        running,
                        `${database}_${model.schema}`
                      )
                    )[model.tableName];
              problems.push(...compareTable(prepared, model, actual));
            }
            const written: string[] = prepared.models
              .filter(
                (candidate: IrModel) =>
                  candidate.isView !== true && candidate.schema === undefined
              )
              .map((candidate: IrModel) => candidate.tableName)
              .sort();
            expect(
              Object.keys(home).sort(),
              `${schemaCase.label} tables`
            ).toEqual(written);
            expect(problems, `${schemaCase.label} (${naming})`).toEqual([]);
          } finally {
            for (const name of [database, ...extra]) {
              await clickhouseExecute(
                running,
                `DROP DATABASE IF EXISTS ${name}`
              );
            }
          }
        }
      },
      120_000
    );
  });

  it.skipIf(!enabled)(
    titleWithReason(
      'applies defaults, keeps Nullable, enums and generated columns working',
      access.probe
    ),
    async () => {
      const running: ClickhouseServer = server as ClickhouseServer;
      const database: string = scratchName();
      const output = emitSqlDdl(clickhouseTypesSchema(), {
        provider: 'clickhouse',
        naming: 'preserve',
      });
      await clickhouseExecute(running, `CREATE DATABASE ${database}`);
      try {
        await clickhouseExecute(
          running,
          `CREATE DATABASE ${database}_analytics`
        );
        const renamed: string = output.text.replace(
          /(?<=CREATE (?:TABLE|DATABASE IF NOT EXISTS) )`?(\w+)`?(?=[.;])/g,
          (_match: string, name: string) => `${database}_${name}`
        );
        for (const statement of splitStatements(renamed)) {
          await clickhouseExecute(running, statement, database);
        }
        await clickhouseExecute(
          running,
          'INSERT INTO defaults (count) VALUES (1)',
          database
        );
        const [row] = await clickhouseRows(
          running,
          'SELECT toString(id) AS id, count, toString(price) AS price, label, active, role, ' +
            'toString(seen) AS seen, list, payload, total, day = today() AS today_ok, ' +
            'created_at > now() - INTERVAL 1 DAY AS now_ok FROM defaults',
          database
        );
        expect(row?.id).toMatch(/^[0-9a-f-]{36}$/);
        expect(row).toMatchObject({
          count: 1,
          price: '9.99',
          label: "O'Brien \\ co",
          active: true,
          role: "it's a member",
          seen: '2024-01-02 03:04:05.000',
          list: ['a', 'b'],
          payload: '{}',
          total: 3,
          today_ok: 1,
          now_ok: 1,
        });

        // A nullable column accepts NULL and an enum rejects a stranger.
        await clickhouseExecute(
          running,
          "INSERT INTO keyed (tenant, seq, value) VALUES ('a', 1, NULL)",
          database
        );
        const [keyed] = await clickhouseRows(
          running,
          "SELECT value IS NULL AS missing FROM keyed WHERE tenant = 'a'",
          database
        );
        expect(keyed?.missing).toBe(1);
        await expect(
          clickhouseExecute(
            running,
            "INSERT INTO everything (id, role) VALUES (1, 'nobody')",
            database
          )
        ).rejects.toThrow();

        // MATERIALIZED and ALIAS columns compute from the others.
        await clickhouseExecute(
          running,
          'INSERT INTO generated (id, a, b) VALUES (1, 2, 3)',
          database
        );
        const [computed] = await clickhouseRows(
          running,
          'SELECT total, `double` AS doubled FROM generated',
          database
        );
        expect(computed).toMatchObject({ total: 8, doubled: 4 });
      } finally {
        await clickhouseExecute(running, `DROP DATABASE IF EXISTS ${database}`);
        await clickhouseExecute(
          running,
          `DROP DATABASE IF EXISTS ${database}_analytics`
        );
      }
    },
    120_000
  );
});
