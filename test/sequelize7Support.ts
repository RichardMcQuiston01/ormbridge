import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { IrDefault, IrEnum, IrField, IrSchema } from '../src/ir.js';
import type { ToolProbe } from './realToolSupport.js';
import type { DbColumn, DbSchema, DbTable } from './sequelizeSupport.js';
import { probeMysql, probePostgres } from './sqlDdlSupport.js';

/**
 * What the Sequelize 7 verification tests share: finding the install (`SEQUELIZE7_DIR`), setting up a scratch
 * project, compiling decorated TypeScript with the real `tsc`, and running `tools/validate-sequelize7.mjs`.
 */

export const SEQUELIZE7_PACKAGES: readonly string[] = [
  '@sequelize/core',
  '@sequelize/sqlite3',
  'typescript',
  '@types/node',
];

export type Sequelize7Probe = ToolProbe & { directory: string };

/** Looks for `npm install @sequelize/core @sequelize/sqlite3 typescript @types/node` in SEQUELIZE7_DIR. */
export function probeSequelize7(): Sequelize7Probe {
  const directory: string = process.env.SEQUELIZE7_DIR ?? '';
  if (directory === '') {
    return {
      available: false,
      reason:
        'set SEQUELIZE7_DIR to a directory with @sequelize/core 7 and @sequelize/sqlite3 installed (see test/README.md)',
      directory,
    };
  }
  const missing: string[] = SEQUELIZE7_PACKAGES.filter(
    (name: string) =>
      !existsSync(join(directory, 'node_modules', name, 'package.json'))
  );
  if (missing.length > 0) {
    return {
      available: false,
      reason: `SEQUELIZE7_DIR is missing ${missing.join(', ')} (see test/README.md)`,
      directory,
    };
  }
  return { available: true, reason: '', directory };
}

/** A scratch project holding `files`, with `node_modules` linked in from the Sequelize 7 install. */
export function scratchProject7(
  probe: Sequelize7Probe,
  files: Readonly<Record<string, string>>
): string {
  const directory: string = mkdtempSync(
    join(tmpdir(), 'ormbridge-sequelize7-')
  );
  symlinkSync(
    join(probe.directory, 'node_modules'),
    join(directory, 'node_modules'),
    'dir'
  );
  writeFileSync(
    join(directory, 'package.json'),
    JSON.stringify({ private: true, type: 'commonjs' })
  );
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(directory, path)), { recursive: true });
    writeFileSync(join(directory, path), text);
  }
  return directory;
}

/** The flags that compile Sequelize 7 models: legacy decorators, strict types, CommonJS output. */
const COMPILER_FLAGS: readonly string[] = [
  '--module',
  'commonjs',
  '--target',
  'es2022',
  '--experimentalDecorators',
  '--useDefineForClassFields',
  'false',
  '--esModuleInterop',
  '--skipLibCheck',
  '--strict',
  '--types',
  'node',
];

/**
 * Compiles TypeScript files to `<directory>/out` with the installed `tsc` (which also type-checks them against
 * the types of `@sequelize/core`). Returns what `tsc` printed: empty when the files compile.
 */
export function compile7(
  probe: Sequelize7Probe,
  directory: string,
  files: readonly string[]
): string {
  const compiled: SpawnSyncReturns<string> = spawnSync(
    join(probe.directory, 'node_modules', '.bin', 'tsc'),
    [...COMPILER_FLAGS, '--rootDir', '.', '--outDir', 'out', ...files],
    { cwd: directory, encoding: 'utf8', timeout: 240_000 }
  );
  return compiled.stdout + compiled.stderr;
}

/** What `tools/validate-sequelize7.mjs` prints. */
export interface Run7 extends DbSchema {
  associations: { model: string; as: string; type: string }[];
}

/** Loads the compiled entry module (it exports `models`), syncs it into SQLite and reads the result back. */
export function run7(
  probe: Sequelize7Probe,
  directory: string,
  entry: string
): { run: SpawnSyncReturns<string>; result: Run7 | undefined } {
  const run: SpawnSyncReturns<string> = spawnSync(
    process.execPath,
    [
      fileURLToPath(
        new URL('./tools/validate-sequelize7.mjs', import.meta.url)
      ),
      probe.directory,
      join(directory, entry),
    ],
    { cwd: directory, encoding: 'utf8', timeout: 240_000 }
  );
  return {
    run,
    result: run.status === 0 ? (JSON.parse(run.stdout) as Run7) : undefined,
  };
}

/** The servers the Sequelize 7 output is run against besides SQLite. */
export type ServerKind = 'postgres' | 'mysql';

/** What a server run needs: the dialect package, the server URL variable and how the SQL tests probe it. */
interface ServerSetup {
  package: string;
  urlVariable: string;
  probe: () => ToolProbe;
}

const SERVERS: Readonly<Record<ServerKind, ServerSetup>> = {
  postgres: {
    package: '@sequelize/postgres',
    urlVariable: 'SQL_POSTGRES_URL',
    probe: probePostgres,
  },
  mysql: {
    package: '@sequelize/mysql',
    urlVariable: 'SQL_MYSQL_URL',
    probe: probeMysql,
  },
};

/** Looks for the dialect package in SEQUELIZE7_DIR and for a server that answers at SQL_POSTGRES_URL / SQL_MYSQL_URL. */
export function probeSequelize7Server(
  kind: ServerKind,
  probe: Sequelize7Probe
): ToolProbe {
  if (!probe.available) {
    return probe;
  }
  const setup: ServerSetup = SERVERS[kind];
  if (
    !existsSync(
      join(probe.directory, 'node_modules', setup.package, 'package.json')
    )
  ) {
    return {
      available: false,
      reason: `SEQUELIZE7_DIR is missing ${setup.package} (see test/README.md)`,
    };
  }
  return setup.probe();
}

/**
 * Loads the compiled entry module, syncs it into a scratch database of the PostgreSQL or MySQL server and reads
 * the result back from the catalogs (`tools/validate-sequelize7-server.mjs`).
 */
export function run7Server(
  kind: ServerKind,
  probe: Sequelize7Probe,
  directory: string,
  entry: string
): { run: SpawnSyncReturns<string>; result: Run7 | undefined } {
  const run: SpawnSyncReturns<string> = spawnSync(
    process.execPath,
    [
      fileURLToPath(
        new URL('./tools/validate-sequelize7-server.mjs', import.meta.url)
      ),
      probe.directory,
      join(directory, entry),
      kind,
      process.env[SERVERS[kind].urlVariable] ?? '',
    ],
    { cwd: directory, encoding: 'utf8', timeout: 240_000 }
  );
  return {
    run,
    result: run.status === 0 ? (JSON.parse(run.stdout) as Run7) : undefined,
  };
}

/** The types a server reports for the column of a field (lower case, as `format_type` / COLUMN_TYPE print them). */
function expectedServerType(
  kind: ServerKind,
  field: IrField
): RegExp | undefined {
  const postgres: boolean = kind === 'postgres';
  switch (field.type) {
    case 'string':
      if (field.enumName !== undefined) {
        return undefined;
      }
      // A string without a length is TEXT, or VARCHAR(255) when it is a key or an index column.
      return field.maxLength === undefined
        ? postgres
          ? /^(?:text|character varying\(255\))$/
          : /^(?:text|varchar\(255\))$/
        : new RegExp(`^(?:character varying|varchar)\\(${field.maxLength}\\)$`);
    case 'text':
      return postgres ? /^text$/ : /^(?:tiny|medium|long)?text$/;
    case 'int':
      return postgres
        ? /^(?:integer|smallint)$/
        : /^(?:tinyint|smallint|mediumint|int)(?:\(\d+\))?$/;
    case 'bigInt':
      return postgres ? /^bigint$/ : /^bigint(?:\(\d+\))?$/;
    case 'float':
      return postgres ? /^(?:real|double precision)$/ : /^(?:float|double)/;
    case 'decimal':
      return field.maxDigits === undefined
        ? /^(?:numeric|decimal)/
        : new RegExp(
            `^(?:numeric|decimal)\\(${field.maxDigits},${field.decimalPlaces ?? 0}\\)$`
          );
    case 'boolean':
      return postgres ? /^boolean$/ : /^tinyint\(1\)$/;
    case 'dateTime':
      return postgres
        ? /^timestamp(?:\(\d+\))? with time zone$/
        : /^datetime(?:\(\d+\))?$/;
    case 'date':
      return postgres ? /^date$/ : /^date$/;
    case 'time':
      return postgres ? /^time(?:\(\d+\))? without time zone$/ : /^time/;
    case 'uuid':
      return postgres ? /^uuid$/ : /^char\(36\)$/;
    case 'json':
      return postgres ? /^jsonb?$/ : /^json$/;
    case 'bytes':
      return postgres ? /^bytea$/ : /blob$/;
    default:
      return undefined;
  }
}

/** The default a server reports for a literal or enum default of the IR, or undefined when it spells it differently. */
function expectedServerDefault(
  kind: ServerKind,
  ir: IrSchema,
  field: IrField
): string | undefined {
  const value: IrDefault | undefined = field.default;
  if (value === undefined) {
    return undefined;
  }
  let text: string | undefined;
  if (value.kind === 'literal') {
    text = String(value.value);
    if (typeof value.value === 'boolean') {
      text = kind === 'postgres' ? text : value.value ? '1' : '0';
    }
  } else if (value.kind === 'enumValue') {
    text = ir.enums
      .find((candidate: IrEnum) => candidate.name === field.enumName)
      ?.values.find((member) => member.name === value.value)?.dbValue;
  }
  return text;
}

/** A PostgreSQL default expression without its quotes and casts: `'draft'::enum_post_status` becomes `draft`. */
function plainDefault(text: string): string {
  return text
    .replace(/::[\w ".[\]]+$/, '')
    .replace(/^'(.*)'$/, '$1')
    .replace(/''/g, "'");
}

/**
 * Lists the columns whose type or default a PostgreSQL or MySQL server reports differently from the IR. Only the
 * fields are checked: a foreign key column takes its type from the key it points at.
 */
export function compareServerColumns(
  kind: ServerKind,
  ir: IrSchema,
  db: DbSchema
): string[] {
  const problems: string[] = [];
  for (const model of ir.models) {
    const table: DbTable | undefined = db.tables[model.tableName];
    if (table === undefined) {
      continue;
    }
    for (const field of model.fields) {
      const column: DbColumn | undefined = table.columns.find(
        (candidate: DbColumn) => candidate.name === field.columnName
      );
      if (column === undefined || column.type === undefined) {
        continue;
      }
      const label: string = `${model.tableName}.${field.columnName}`;
      const checked: boolean =
        field.arrayDepth === undefined &&
        field.generated === undefined &&
        field.nativeType === undefined;
      const expected: RegExp | undefined = checked
        ? expectedServerType(kind, field)
        : undefined;
      if (expected !== undefined && !expected.test(column.type)) {
        problems.push(
          `${label}: type ${column.type} in the database, ${field.type}${field.maxLength === undefined ? '' : `(${field.maxLength})`} in the IR`
        );
      }
      if (checked && field.enumName !== undefined) {
        const values: string[] =
          ir.enums
            .find((candidate: IrEnum) => candidate.name === field.enumName)
            ?.values.map((member) => `'${member.dbValue}'`) ?? [];
        if (column.type !== `enum(${values.join(',')})`) {
          problems.push(
            `${label}: type ${column.type} in the database, enum(${values.join(',')}) in the IR`
          );
        }
      }
      // Sequelize sets the default of a JSON or array column in JavaScript, and MySQL allows none on TEXT, BLOB
      // and JSON columns, so those tables have no default.
      if (
        field.default?.kind === 'autoIncrement' ||
        field.type === 'json' ||
        field.type === 'bytes' ||
        field.type === 'hstore' ||
        field.arrayDepth !== undefined ||
        (kind === 'mysql' && /(?:text|blob|json)$/.test(column.type))
      ) {
        continue;
      }
      const wanted: string | undefined = expectedServerDefault(kind, ir, field);
      const given: string | null =
        column.defaultValue === null || column.defaultValue === undefined
          ? null
          : String(column.defaultValue);
      if (wanted !== undefined) {
        const found: string | null =
          given !== null && kind === 'postgres' ? plainDefault(given) : given;
        // MySQL reports a DECIMAL(10,2) default of 0 as 0.00.
        const same: boolean =
          field.type === 'decimal' && found !== null
            ? Number(found) === Number(wanted)
            : found === wanted;
        if (!same) {
          problems.push(
            `${label}: default ${String(given)} in the database, ${wanted} in the IR`
          );
        }
      } else if (
        field.default === undefined &&
        given !== null &&
        !/^(?:nextval|identity$|auto_increment$)/.test(given)
      ) {
        problems.push(
          `${label}: default ${given} in the database, none in the IR`
        );
      }
    }
  }
  return problems;
}
