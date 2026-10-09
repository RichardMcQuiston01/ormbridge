import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { IrModel, IrOnDelete, IrRelation, IrSchema } from '../src/ir.js';
import { parseGorm, type GormSourceFile } from '../src/parsers/gorm.js';
import { expectOk } from './helpers.js';

/**
 * Checks the parser against Go itself, when Go is installed: the fixtures must pass `go vet`, and
 * GORM's own schema parser (gorm.io/gorm/schema) must agree with the parser on table names,
 * column names, keys, named indexes, foreign-key actions and join tables.
 *
 * The check needs the Go modules gorm.io/gorm, gorm.io/datatypes, github.com/google/uuid and
 * github.com/shopspring/decimal. It uses the module cache and the network; it is skipped when Go
 * is missing or the modules cannot be fetched (for example offline).
 */

interface DumpedColumn {
  dbName: string;
}
interface DumpedIndex {
  name: string;
  unique: boolean;
  fields: string[];
}
interface DumpedConstraint {
  table: string;
  foreignKeys: string[];
  onDelete: string;
  onUpdate: string;
}
interface DumpedJoinTable {
  table: string;
  columns: string[];
}
interface DumpedModel {
  table: string;
  columns: DumpedColumn[];
  primaryKeys: string[];
  indexes: DumpedIndex[] | null;
  constraints: DumpedConstraint[] | null;
  joinTables: DumpedJoinTable[] | null;
}

const GO_MOD: string = `module fixture

go 1.22

require (
	github.com/google/uuid v1.6.0
	github.com/shopspring/decimal v1.5.0
	gorm.io/datatypes v1.2.7
	gorm.io/gorm v1.31.2
)
`;

/** Output that means the Go modules could not be fetched rather than that the fixtures are wrong. */
const MODULE_ERROR: RegExp =
  /dial tcp|lookup |no such host|connection refused|i\/o timeout|proxy|cannot find module|no matching versions|unrecognized import path|reading https?:|module lookup disabled|TLS handshake/i;

const probe: SpawnSyncReturns<string> = spawnSync('go', ['version'], {
  encoding: 'utf8',
});
const hasGo: boolean = probe.status === 0;

const FIXTURES: string = fileURLToPath(new URL('./fixtures/', import.meta.url));
const DUMP_SOURCE: string = fileURLToPath(
  new URL('./tools/dump-gorm-schema.go', import.meta.url)
);

function goFiles(directory: string): string[] {
  return readdirSync(directory)
    .filter((name: string) => name.endsWith('.go'))
    .sort()
    .map((name: string) => join(directory, name));
}

function run(directory: string, args: string[]): SpawnSyncReturns<string> {
  return spawnSync('go', args, {
    cwd: directory,
    encoding: 'utf8',
    env: { ...process.env, GOFLAGS: '-mod=mod', GOSUMDB: 'off' },
    timeout: 240_000,
  });
}

describe.skipIf(!hasGo)('GORM fixtures against Go', () => {
  let directory: string = '';
  let moduleError: string | undefined;
  let dump: Record<string, DumpedModel> = {};
  let parsed: IrSchema = { models: [], enums: [], warnings: [] };

  beforeAll(async () => {
    directory = mkdtempSync(join(tmpdir(), 'ormbridge-gorm-go-'));
    writeFileSync(join(directory, 'go.mod'), GO_MOD);
    mkdirSync(join(directory, 'models'));
    mkdirSync(join(directory, 'shop'));
    mkdirSync(join(directory, 'dump'));
    for (const path of goFiles(join(FIXTURES, 'gorm'))) {
      cpSync(path, join(directory, 'models', path.split('/').pop() ?? ''));
    }
    for (const path of goFiles(join(FIXTURES, 'gorm-extras'))) {
      cpSync(path, join(directory, 'shop', path.split('/').pop() ?? ''));
    }
    writeFileSync(
      join(directory, 'dump', 'main.go'),
      readFileSync(DUMP_SOURCE, 'utf8').replace('//go:build ignore\n', '')
    );

    const vet: SpawnSyncReturns<string> = run(directory, ['vet', './...']);
    if (vet.status !== 0) {
      const output: string = `${vet.stdout}${vet.stderr}`;
      if (MODULE_ERROR.test(output)) {
        moduleError = output;
        return;
      }
      throw new Error(`go vet failed on the GORM fixtures:\n${output}`);
    }
    const dumped: SpawnSyncReturns<string> = run(directory, ['run', './dump']);
    if (dumped.status !== 0) {
      throw new Error(`dump-gorm-schema failed:\n${dumped.stderr}`);
    }
    dump = JSON.parse(dumped.stdout) as Record<string, DumpedModel>;

    const sources: GormSourceFile[] = [
      ...goFiles(join(FIXTURES, 'gorm')),
      ...goFiles(join(FIXTURES, 'gorm-extras')),
    ].map((path: string) => ({ path, text: readFileSync(path, 'utf8') }));
    parsed = expectOk(await parseGorm(sources, { appLabel: 'app' }));
  }, 300_000);

  afterAll(() => {
    if (directory !== '') {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  function expectDump(context: { skip: () => void }): void {
    if (moduleError !== undefined) {
      context.skip();
    }
  }

  it('passes go vet', (context) => {
    expectDump(context);
    expect(moduleError).toBeUndefined();
  });

  it('reads every dumped model', (context) => {
    expectDump(context);
    expect(parsed.models.map((model: IrModel) => model.name).sort()).toEqual(
      Object.keys(dump).sort()
    );
  });

  it("agrees with GORM's table names and column names", (context) => {
    expectDump(context);
    for (const model of parsed.models) {
      const gorm: DumpedModel | undefined = dump[model.name];
      expect(gorm?.table, `${model.name} table`).toBe(model.tableName);
      const columns: string[] = [
        ...model.fields.map((field) => field.columnName),
        ...model.relations
          .filter((relation: IrRelation) => relation.kind !== 'manyToMany')
          .map((relation: IrRelation) => relation.columnName),
      ].sort();
      expect(
        (gorm?.columns ?? [])
          .map((column: DumpedColumn) => column.dbName)
          .sort(),
        `${model.name} columns`
      ).toEqual(columns);
    }
  });

  it("agrees with GORM's primary keys", (context) => {
    expectDump(context);
    for (const model of parsed.models) {
      const columnOf = (name: string): string =>
        model.fields.find((field) => field.name === name)?.columnName ??
        model.relations.find((relation: IrRelation) => relation.name === name)
          ?.columnName ??
        name;
      const keys: string[] =
        model.compositePrimaryKey?.map(columnOf) ??
        [
          ...model.fields.filter((field) => field.isPrimaryKey),
          ...model.relations.filter(
            (relation: IrRelation) => relation.isPrimaryKey === true
          ),
        ].map((item) => item.columnName);
      expect([...(dump[model.name]?.primaryKeys ?? [])].sort()).toEqual(
        keys.sort()
      );
    }
  });

  it("agrees with GORM's named indexes", (context) => {
    expectDump(context);
    for (const model of parsed.models) {
      for (const index of model.indexes) {
        if (index.name === undefined) {
          continue;
        }
        const columnOf = (name: string): string =>
          model.fields.find((field) => field.name === name)?.columnName ??
          model.relations.find((relation: IrRelation) => relation.name === name)
            ?.columnName ??
          name;
        const gorm: DumpedIndex | undefined = (
          dump[model.name]?.indexes ?? []
        ).find((candidate: DumpedIndex) => candidate.name === index.name);
        expect(gorm, `${model.name} index ${index.name}`).toBeDefined();
        expect(gorm?.fields).toEqual(index.fields.map(columnOf));
        expect(gorm?.unique).toBe(index.isUnique);
      }
    }
  });

  it("agrees with GORM's foreign-key actions", (context) => {
    expectDump(context);
    const actions: Record<string, IrOnDelete> = {
      '': 'noAction',
      CASCADE: 'cascade',
      'SET NULL': 'setNull',
      RESTRICT: 'restrict',
      'NO ACTION': 'noAction',
      'SET DEFAULT': 'setDefault',
    };
    for (const model of parsed.models) {
      for (const relation of model.relations) {
        if (relation.kind === 'manyToMany') {
          continue;
        }
        const constraint: DumpedConstraint | undefined = (
          dump[model.name]?.constraints ?? []
        )
          .concat(Object.values(dump).flatMap((item) => item.constraints ?? []))
          .find(
            (candidate: DumpedConstraint) =>
              candidate.table === model.tableName &&
              candidate.foreignKeys.includes(relation.columnName)
          );
        const where: string = `${model.name}.${relation.name}`;
        expect(constraint, where).toBeDefined();
        expect(actions[constraint?.onDelete ?? ''], where).toBe(
          relation.onDelete
        );
        expect(actions[constraint?.onUpdate ?? ''], where).toBe(
          relation.onUpdate ?? 'noAction'
        );
      }
    }
  });

  it("agrees with GORM's join tables", (context) => {
    expectDump(context);
    const post: DumpedModel | undefined = dump['Post'];
    expect(post?.joinTables).toEqual([
      { table: 'blog_post_tags', columns: ['post_id', 'tag_id', ''] },
    ]);
    for (const model of parsed.models) {
      const joinTables: number = model.relations.filter(
        (relation: IrRelation) => relation.kind === 'manyToMany'
      ).length;
      // The owning side reads the association; the mirrored side is folded into it.
      expect(
        (dump[model.name]?.joinTables ?? []).length,
        model.name
      ).toBeGreaterThanOrEqual(joinTables);
    }
    // The non-default join tables are the ones the parser warns about.
    expect(dump['Order']?.joinTables?.[0]?.table).toBe('order_labels');
    expect(
      parsed.warnings.some((warning: string) =>
        warning.includes('"order_labels" (columns order_ref, label_ref)')
      )
    ).toBe(true);
    expect(dump['Product']?.joinTables?.[0]).toEqual({
      table: 'product_similar',
      columns: ['product_sku', 'similar_sku', ''],
    });
  });
});
