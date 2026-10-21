import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  IrCompositeForeignKey,
  IrField,
  IrModel,
  IrOnDelete,
  IrRelation,
  IrSchema,
} from '../src/ir.js';
import { parseJpa } from '../src/parsers/jpa.js';
import type { ToolProbe } from './realToolSupport.js';
import type {
  DbForeignKey,
  DbIndex,
  DbSchema,
  DbTable,
} from './sequelizeSupport.js';

/**
 * What `test/tools/jpa-verify` prints for one group of fixtures: the tables of the H2 database that Hibernate
 * creates (`hbm2ddl.auto=create`), straight from JDBC metadata.
 */
export interface JpaColumn {
  name: string;
  type: string;
  allowNull: boolean;
  size: number;
  default: string | null;
}

export interface JpaForeignKey {
  name: string;
  table: string;
  from: string[];
  to: string[];
  onDelete: string;
  onUpdate: string;
}

export interface JpaTable {
  columns: JpaColumn[];
  primaryKey: string[];
  indexes: { name: string; unique: boolean; columns: string[] }[];
  foreignKeys: JpaForeignKey[];
}

/** What `Exercise.java` saw when it added a row to every table through the entity classes. */
export interface JpaExercise {
  /** The row read back with SQL, by table. */
  rows: Record<string, Record<string, unknown> | null>;
  /** The columns Hibernate refreshed on update (`@UpdateTimestamp`): [before, after] by table and column. */
  updates: Record<string, Record<string, [unknown, unknown]>>;
  errors: string[];
}

export interface JpaDatabase {
  tables: Record<string, JpaTable>;
  /** Present when the tool ran with `exercise`. */
  exercise?: JpaExercise;
}

/** What the tool prints for a group that Hibernate (or the compiler) rejected. */
export interface JpaToolError {
  __error: string;
}

export type JpaToolOutput = Record<string, JpaDatabase | JpaToolError>;

export function isToolError(
  value: JpaDatabase | JpaToolError | undefined
): value is JpaToolError {
  return (
    value !== undefined && typeof (value as JpaToolError).__error === 'string'
  );
}

const TOOL: string = fileURLToPath(
  new URL('./tools/jpa-verify', import.meta.url)
);

export interface JpaProbe extends ToolProbe {
  mvn: string;
  java: string;
  directory: string;
}

function runs(command: string, args: string[]): boolean {
  const result: SpawnSyncReturns<string> = spawnSync(command, args, {
    encoding: 'utf8',
  });
  return result.error === undefined && result.status === 0;
}

/**
 * Looks for Java 17 and Maven: JPA_DIR names a scratch directory (the Maven repository goes there), MVN and JAVA
 * the executables when they are not on the PATH.
 */
export function probeJava(): JpaProbe {
  const directory: string = process.env.JPA_DIR ?? '';
  const mvn: string = process.env.MVN ?? 'mvn';
  const java: string = process.env.JAVA ?? 'java';
  if (directory === '') {
    return {
      available: false,
      reason:
        'set JPA_DIR to a scratch directory and have Java 17 and Maven installed (MVN and JAVA name the executables; see test/README.md)',
      mvn,
      java,
      directory,
    };
  }
  if (!runs(java, ['-version'])) {
    return {
      available: false,
      reason: `Java was not found (${java} -version failed); install JDK 17 or set JAVA (see test/README.md)`,
      mvn,
      java,
      directory,
    };
  }
  if (!runs(mvn, ['-version'])) {
    return {
      available: false,
      reason: `Maven was not found (${mvn} -version failed); install Maven or set MVN (see test/README.md)`,
      mvn,
      java,
      directory,
    };
  }
  return { available: true, reason: '', mvn, java, directory };
}

export interface ToolGroup {
  /** The key of the group in the output. */
  name: string;
  /** The directory with the Java files. */
  directory: string;
}

/**
 * Copies a fixture directory. Hibernate 6 reads `jakarta.persistence`, so the `javax` imports of the reader's
 * fixtures are rewritten, unless the files are kept as they are (the writer's output, which has to compile as written).
 */
function stage(source: string, target: string, rewrite: boolean): void {
  mkdirSync(target, { recursive: true });
  for (const entry of readdirSync(source).sort()) {
    const from: string = join(source, entry);
    const to: string = join(target, entry);
    if (statSync(from).isDirectory()) {
      stage(from, to, rewrite);
    } else if (entry.endsWith('.java')) {
      const text: string = readFileSync(from, 'utf8');
      writeFileSync(
        to,
        rewrite
          ? text.replace(/\bjavax\.(persistence|validation)\b/g, 'jakarta.$1')
          : text
      );
    }
  }
}

/** How `runJpaTool` builds and runs the tool. */
export interface JpaToolOptions {
  /** `javax` builds the tool against Hibernate 5 (`pom-javax.xml`); `jakarta` (default) against Hibernate 6. */
  variant?: 'jakarta' | 'javax';
  /** Also add a row to every table through the entity classes (`--exercise`). */
  exercise?: boolean;
  /** Only compile the sources (`--compile-only`); no schema is created. */
  compileOnly?: boolean;
  /** Keep `javax.persistence` imports as written (default: rewrite them for Hibernate 6, as the reader's fixtures need). */
  keepImports?: boolean;
  /** Compile with every lint warning as an error (`--strict`). */
  strict?: boolean;
}

function fail(what: string, result: SpawnSyncReturns<string>): never {
  throw new Error(
    `${what} failed (${result.status}):\n${result.stdout}\n${result.stderr}`
  );
}

/** Builds `test/tools/jpa-verify` with Maven and runs it over the groups; throws with the output on failure. */
export function runJpaTool(
  probe: JpaProbe,
  groups: readonly ToolGroup[],
  options: JpaToolOptions = {}
): JpaToolOutput {
  const work: string = mkdtempSync(join(tmpdir(), 'ormbridge-jpa-'));
  const javax: boolean = options.variant === 'javax';
  try {
    cpSync(
      join(TOOL, javax ? 'pom-javax.xml' : 'pom.xml'),
      join(work, 'pom.xml')
    );
    cpSync(join(TOOL, 'src'), join(work, 'src'), { recursive: true });
    mkdirSync(join(probe.directory, 'm2'), { recursive: true });
    const javaHome: string = dirname(dirname(realJava(probe.java)));
    const env: NodeJS.ProcessEnv = { ...process.env, JAVA_HOME: javaHome };
    const build: SpawnSyncReturns<string> = spawnSync(
      probe.mvn,
      [
        '-B',
        '-q',
        `-Dmaven.repo.local=${join(probe.directory, 'm2')}`,
        'package',
        'dependency:build-classpath',
        `-Dmdep.outputFile=${join(work, 'cp.txt')}`,
      ],
      { cwd: work, encoding: 'utf8', timeout: 900_000, env }
    );
    if (build.status !== 0) {
      fail('mvn package', build);
    }
    const classPath: string = `${join(work, javax ? 'target-javax' : 'target', 'classes')}:${readFileSync(join(work, 'cp.txt'), 'utf8').trim()}`;
    const arguments_: string[] = groups.map((group: ToolGroup): string => {
      const staged: string = join(work, 'fixtures', group.name);
      stage(group.directory, staged, options.keepImports !== true);
      return `${group.name}=${staged}`;
    });
    const run: SpawnSyncReturns<string> = spawnSync(
      probe.java,
      [
        '-cp',
        classPath,
        'dev.ormbridge.jpaverify.Main',
        ...(options.exercise === true ? ['--exercise'] : []),
        ...(options.compileOnly === true ? ['--compile-only'] : []),
        ...(options.strict === true ? ['--strict'] : []),
        ...arguments_,
      ],
      {
        cwd: work,
        encoding: 'utf8',
        timeout: 600_000,
        maxBuffer: 256 * 1024 * 1024,
        env,
      }
    );
    if (run.status !== 0) {
      fail('the jpa-verify tool', run);
    }
    const lines: string[] = run.stdout
      .split('\n')
      .filter((line: string) => line.startsWith('{'));
    const last: string | undefined = lines[lines.length - 1];
    if (last === undefined) {
      fail('the jpa-verify tool (no JSON output)', run);
    }
    return JSON.parse(last) as JpaToolOutput;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** The path of the java executable behind a command name (the symlinks of `/usr/bin/java` resolved). */
function realJava(java: string): string {
  const located: SpawnSyncReturns<string> = spawnSync(
    'sh',
    ['-c', `readlink -f "$(command -v ${JSON.stringify(java)})"`],
    { encoding: 'utf8' }
  );
  const path: string = located.stdout.trim();
  return path === '' ? java : path;
}

/** The column names behind field names of a model. */
function columnsOf(model: IrModel, names: readonly string[]): string[] {
  return names.map(
    (name: string) =>
      model.fields.find((field: IrField) => field.name === name)?.columnName ??
      name
  );
}

/**
 * Turns the tool output into the shape the shared comparison reads. Three things are left out because the model
 * never asked for them: the primary key index, the index H2 adds on every foreign key (`FK..._INDEX_n`) and the
 * difference between `NO ACTION` and `RESTRICT`, which H2 reports as one (`RESTRICT`).
 */
export function toDbSchema(database: JpaDatabase, ir: IrSchema): DbSchema {
  const tables: Record<string, DbTable> = {};
  for (const [name, table] of Object.entries(database.tables)) {
    const model: IrModel | undefined = ir.models.find(
      (candidate: IrModel) => candidate.tableName === name
    );
    const indexes: DbIndex[] = table.indexes
      .filter(
        (index) =>
          index.unique || !/^[0-9A-Za-z_]+_INDEX_[0-9A-F]+$/.test(index.name)
      )
      .map((index): DbIndex => ({
        name: index.name,
        unique: index.unique,
        origin: index.name.startsWith('PRIMARY_KEY') ? 'pk' : 'c',
        columns: index.columns,
      }));
    const foreignKeys: DbForeignKey[] = table.foreignKeys.map(
      (foreign: JpaForeignKey): DbForeignKey => {
        let from: string[] = foreign.from;
        let to: string[] = foreign.to;
        let expected: IrOnDelete | undefined = model?.relations.find(
          (relation: IrRelation) => relation.columnName === from.join(',')
        )?.onDelete;
        // A key of several columns: list them in the order of the IR, which is the order of the join columns.
        const composite: IrCompositeForeignKey | undefined =
          model?.compositeForeignKeys?.find(
            (candidate: IrCompositeForeignKey) =>
              [...columnsOf(model, candidate.fields)].sort().join(',') ===
              [...from].sort().join(',')
          );
        if (model !== undefined && composite !== undefined) {
          const wanted: string[] = columnsOf(model, composite.fields);
          const order: number[] = wanted.map((column: string) =>
            from.indexOf(column)
          );
          to = order.map((position: number) => foreign.to[position] ?? '');
          from = wanted;
          expected = composite.onDelete;
        }
        const asNoAction: boolean =
          foreign.onDelete === 'RESTRICT' && expected === 'noAction';
        return {
          column: from.join(','),
          table: foreign.table,
          to: to.join(','),
          onDelete: asNoAction ? 'NO ACTION' : foreign.onDelete,
          onUpdate: foreign.onUpdate,
        };
      }
    );
    tables[name] = {
      columns: table.columns.map((column: JpaColumn) => ({
        name: column.name,
        allowNull: column.allowNull,
      })),
      primaryKey: table.primaryKey,
      indexes,
      foreignKeys,
    };
  }
  return { tables };
}

// ---------------------------------------------------------------------------
// Reading the Java fixtures
// ---------------------------------------------------------------------------

/** Every `.java` file below a directory, sorted. */
export function javaFiles(directory: string): string[] {
  return readdirSync(directory)
    .sort()
    .flatMap((entry: string): string[] => {
      const path: string = join(directory, entry);
      if (statSync(path).isDirectory()) {
        return javaFiles(path);
      }
      return path.endsWith('.java') ? [path] : [];
    });
}

const FIXTURES: string = fileURLToPath(new URL('./fixtures', import.meta.url));

/** The directories of `test/fixtures/jpa-extras` that Hibernate can create a schema from, one per scenario. */
export const JPA_EXTRAS: readonly string[] = [
  'types',
  'inheritance-single',
  'inheritance-joined',
  'inheritance-table-per-class',
  'composite-keys',
  'embedded-keys',
  'embeddables',
  'many-to-many',
  'javax',
  'property-access',
  'lombok',
  'spring-auditing',
];

/** Reads a directory of Java fixtures into the IR. */
export async function parseJpaDirectory(directory: string): Promise<IrSchema> {
  const result = await parseJpa(
    javaFiles(directory).map((path: string) => ({
      path,
      text: readFileSync(path, 'utf8'),
    })),
    { appLabel: 'blog' }
  );
  if (!result.ok) {
    throw new Error(`${result.error.code}: ${result.error.message}`);
  }
  return result.value;
}

/** Reads one of the `jpa-extras` fixtures into the IR. */
export function parseJpaExtra(name: string): Promise<IrSchema> {
  return parseJpaDirectory(join(FIXTURES, 'jpa-extras', name));
}
