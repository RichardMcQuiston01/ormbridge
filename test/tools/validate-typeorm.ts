/**
 * Loads generated TypeORM entities with the real TypeORM and compares them with the IR.
 *
 * Usage (from the scratch project, after `tsc` compiled it to ./dist):
 *   node dist/validate-typeorm.js <spec.json> <provider> [<provider> ...]
 *
 * Providers are `sqlite`, `postgres`, `mysql` and `mssql`. For each one the script loads
 * `./entities-<provider>` and builds the TypeORM metadata (`DataSource.buildMetadatas`, which
 * runs TypeORM's own entity validation, including the check that the driver supports every
 * column type), then compares `dataSource.entityMetadatas` with the spec: tables, columns,
 * primary keys, unique constraints, indexes, relations, referential actions and junction tables.
 * With `sqlite` the script also synchronizes an in-memory database and compares the created
 * tables, columns, foreign keys, unique constraints and indexes.
 *
 * Every difference is printed to stderr and the exit code is 1; success prints
 * "typeorm entities verified". Exit code 2 means a driver package is not installed.
 *
 * This file is compiled inside the scratch project (it imports `typeorm`, which is not a
 * dependency of ormbridge), so it only uses the public TypeORM API.
 */
import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import {
  DataSource,
  type ColumnType,
  type DataSourceOptions,
  type EntityMetadata,
  type Table,
  type TableColumn,
  type TableForeignKey,
  type TableIndex,
  type TableUnique,
} from 'typeorm';

interface SpecColumn {
  name: string;
  column: string;
  type: string;
  nullable: boolean;
  unique: boolean;
  primaryKey: boolean;
  maxLength?: number;
  maxDigits?: number;
  decimalPlaces?: number;
  enumValues?: string[];
}

interface SpecRelation {
  name: string;
  column: string;
  kind: 'foreignKey' | 'oneToOne';
  target: string;
  targetTable: string;
  nullable: boolean;
  onDelete: string;
  primaryKey: boolean;
}

interface SpecManyToMany {
  name: string;
  target: string;
}

interface SpecIndex {
  columns: string[];
  unique: boolean;
  name?: string;
}

interface SpecModel {
  name: string;
  table: string;
  columns: SpecColumn[];
  relations: SpecRelation[];
  manyToMany: SpecManyToMany[];
  indexes: SpecIndex[];
  primaryKey: string[];
}

interface Spec {
  models: SpecModel[];
}

type EntityClass = new (...args: never[]) => object;

type Provider = 'sqlite' | 'postgres' | 'mysql' | 'mssql';

const DRIVER_TYPES: Readonly<Record<Provider, DataSourceOptions['type']>> = {
  sqlite: 'better-sqlite3',
  postgres: 'postgres',
  mysql: 'mysql',
  mssql: 'mssql',
};

const ON_DELETE_NAMES: Readonly<Record<string, string>> = {
  cascade: 'CASCADE',
  setNull: 'SET NULL',
  restrict: 'RESTRICT',
  noAction: 'NO ACTION',
  setDefault: 'SET DEFAULT',
};

/** IR scalar type to the SQLite column types TypeORM may report for it. */
const SQLITE_TYPES: Readonly<Record<string, readonly string[]>> = {
  string: ['varchar', 'text', 'character', 'nvarchar'],
  text: ['text', 'clob'],
  int: ['integer', 'int', 'smallint', 'tinyint', 'mediumint'],
  bigInt: ['bigint', 'integer', 'int8'],
  float: ['float', 'real', 'double', 'double precision'],
  decimal: ['decimal', 'numeric'],
  boolean: ['boolean', 'integer'],
  dateTime: ['datetime', 'timestamp'],
  date: ['date'],
  time: ['time'],
  uuid: ['varchar', 'uuid', 'text'],
  json: ['json', 'text', 'simple-json'],
  bytes: ['blob'],
};

function lowerType(type: ColumnType | string | undefined): string {
  if (type === undefined) {
    return '';
  }
  if (typeof type === 'string') {
    return type.toLowerCase().replace(/\(.*\)/u, '');
  }
  return type.name.toLowerCase();
}

function sorted(values: Iterable<string>): string[] {
  return [...values].sort();
}

function joined(columns: readonly string[]): string {
  return columns.join(', ');
}

/** Compares the TypeORM metadata of the entities with the spec. */
function compareMetadata(
  spec: Spec,
  metadatas: readonly EntityMetadata[],
  label: string,
  problems: string[]
): void {
  const regular: EntityMetadata[] = metadatas.filter(
    (metadata: EntityMetadata) => metadata.tableType !== 'junction'
  );
  const junctions: EntityMetadata[] = metadatas.filter(
    (metadata: EntityMetadata) => metadata.tableType === 'junction'
  );
  const known: Set<string> = new Set(
    spec.models.map((model: SpecModel) => model.name)
  );
  for (const metadata of regular) {
    if (!known.has(metadata.targetName)) {
      problems.push(`${label}: unexpected entity ${metadata.targetName}`);
    }
  }

  for (const model of spec.models) {
    const where: string = `${label}: ${model.name}`;
    const metadata: EntityMetadata | undefined = regular.find(
      (candidate: EntityMetadata) => candidate.targetName === model.name
    );
    if (metadata === undefined) {
      problems.push(`${where} is missing`);
      continue;
    }
    if (metadata.tableName !== model.table) {
      problems.push(
        `${where}: table is ${metadata.tableName}, expected ${model.table}`
      );
    }

    const expectedColumns: Set<string> = new Set([
      ...model.columns.map((column: SpecColumn) => column.column),
      ...model.relations.map((relation: SpecRelation) => relation.column),
    ]);
    const actualColumns: Set<string> = new Set(
      metadata.columns.map((column) => column.databaseName)
    );
    if (joined(sorted(actualColumns)) !== joined(sorted(expectedColumns))) {
      problems.push(
        `${where}: columns are [${joined(sorted(actualColumns))}], expected [${joined(sorted(expectedColumns))}]`
      );
    }

    const primary: string[] = metadata.primaryColumns.map(
      (column) => column.databaseName
    );
    if (joined(sorted(primary)) !== joined(sorted(model.primaryKey))) {
      problems.push(
        `${where}: primary key is [${joined(primary)}], expected [${joined(model.primaryKey)}]`
      );
    }

    for (const column of model.columns) {
      const found = metadata.columns.find(
        (candidate) => candidate.databaseName === column.column
      );
      if (found === undefined) {
        continue;
      }
      if (!column.primaryKey && found.isNullable !== column.nullable) {
        problems.push(
          `${where}.${column.column}: nullable is ${String(found.isNullable)}, expected ${String(column.nullable)}`
        );
      }
      const isEnum: boolean = column.enumValues !== undefined;
      if (
        column.maxLength !== undefined &&
        column.type === 'string' &&
        !isEnum
      ) {
        if (found.length !== String(column.maxLength)) {
          problems.push(
            `${where}.${column.column}: length is ${found.length}, expected ${column.maxLength}`
          );
        }
      }
      if (
        column.maxDigits !== undefined &&
        found.precision !== column.maxDigits
      ) {
        problems.push(
          `${where}.${column.column}: precision is ${String(found.precision)}, expected ${column.maxDigits}`
        );
      }
      if (
        column.decimalPlaces !== undefined &&
        found.scale !== column.decimalPlaces
      ) {
        problems.push(
          `${where}.${column.column}: scale is ${String(found.scale)}, expected ${column.decimalPlaces}`
        );
      }
      // SQL Server has no enum type, so the emitter writes the column without the values.
      const hasEnumType: boolean =
        found.type === 'enum' || found.type === 'simple-enum';
      if (column.enumValues !== undefined && hasEnumType) {
        const values: string[] = (found.enum ?? []).map(String);
        if (joined(values) !== joined(column.enumValues)) {
          problems.push(
            `${where}.${column.column}: enum values are [${joined(values)}], expected [${joined(column.enumValues)}]`
          );
        }
      }
    }

    for (const relation of model.relations) {
      const found = metadata.relations.find((candidate) =>
        candidate.joinColumns.some(
          (joinColumn) => joinColumn.databaseName === relation.column
        )
      );
      const relationWhere: string = `${where}.${relation.name}`;
      if (found === undefined) {
        problems.push(
          `${relationWhere}: no relation uses column ${relation.column}`
        );
        continue;
      }
      const expectedType: string =
        relation.kind === 'oneToOne' ? 'one-to-one' : 'many-to-one';
      if (found.relationType !== expectedType) {
        problems.push(
          `${relationWhere}: relation type is ${found.relationType}, expected ${expectedType}`
        );
      }
      if (found.inverseEntityMetadata.tableName !== relation.targetTable) {
        problems.push(
          `${relationWhere}: points at ${found.inverseEntityMetadata.tableName}, expected ${relation.targetTable}`
        );
      }
      if (found.onDelete !== ON_DELETE_NAMES[relation.onDelete]) {
        problems.push(
          `${relationWhere}: onDelete is ${String(found.onDelete)}, expected ${String(ON_DELETE_NAMES[relation.onDelete])}`
        );
      }
      if (!relation.primaryKey && found.isNullable !== relation.nullable) {
        problems.push(
          `${relationWhere}: nullable is ${String(found.isNullable)}, expected ${String(relation.nullable)}`
        );
      }
    }

    const uniqueSets: string[] = [
      ...metadata.uniques.map((unique) =>
        joined(unique.columns.map((column) => column.databaseName))
      ),
      ...metadata.indices
        .filter((index) => index.isUnique)
        .map((index) =>
          joined(index.columns.map((column) => column.databaseName))
        ),
    ];
    const indexSets: string[] = metadata.indices
      .filter((index) => !index.isUnique)
      .map((index) =>
        joined(index.columns.map((column) => column.databaseName))
      );
    for (const column of model.columns) {
      if (
        column.unique &&
        !column.primaryKey &&
        !uniqueSets.includes(column.column)
      ) {
        problems.push(`${where}: no unique constraint on ${column.column}`);
      }
    }
    for (const index of model.indexes) {
      const key: string = joined(index.columns);
      const sets: string[] = index.unique ? uniqueSets : indexSets;
      if (!sets.includes(key)) {
        problems.push(
          `${where}: no ${index.unique ? 'unique ' : ''}index on [${key}]`
        );
      }
      if (index.name !== undefined) {
        const names: string[] = [
          ...metadata.uniques.map((unique) => unique.name ?? ''),
          ...metadata.indices.map((candidate) => candidate.name ?? ''),
        ];
        if (!names.includes(index.name)) {
          problems.push(`${where}: no index or constraint named ${index.name}`);
        }
      }
    }

    for (const relation of model.manyToMany) {
      const targetTable: string =
        spec.models.find((candidate) => candidate.name === relation.target)
          ?.table ?? '';
      const hasJunction: boolean = junctions.some((junction) => {
        const referenced: string[] = junction.foreignKeys.map(
          (key) => key.referencedEntityMetadata.tableName
        );
        return (
          referenced.includes(model.table) && referenced.includes(targetTable)
        );
      });
      if (!hasJunction) {
        problems.push(
          `${where}.${relation.name}: no junction table between ${model.table} and ${targetTable}`
        );
      }
    }
  }
}

function columnSet(column: TableColumn): string {
  return column.name;
}

/** Compares a synchronized SQLite database with the spec. */
async function compareDatabase(
  spec: Spec,
  dataSource: DataSource,
  problems: string[]
): Promise<void> {
  const runner = dataSource.createQueryRunner();
  try {
    for (const model of spec.models) {
      const where: string = `sqlite: ${model.name}`;
      const table: Table | undefined = await runner.getTable(model.table);
      if (table === undefined) {
        problems.push(`${where}: the table ${model.table} was not created`);
        continue;
      }
      const expected: Map<string, SpecColumn | SpecRelation> = new Map();
      for (const column of model.columns) {
        expected.set(column.column, column);
      }
      for (const relation of model.relations) {
        expected.set(relation.column, relation);
      }
      const actual: string[] = table.columns.map(columnSet);
      if (joined(sorted(actual)) !== joined(sorted(expected.keys()))) {
        problems.push(
          `${where}: database columns are [${joined(sorted(actual))}], expected [${joined(sorted(expected.keys()))}]`
        );
      }
      const primary: string[] = table.columns
        .filter((column: TableColumn) => column.isPrimary)
        .map(columnSet);
      if (joined(sorted(primary)) !== joined(sorted(model.primaryKey))) {
        problems.push(
          `${where}: database primary key is [${joined(primary)}], expected [${joined(model.primaryKey)}]`
        );
      }
      for (const column of table.columns) {
        const spot: SpecColumn | SpecRelation | undefined = expected.get(
          column.name
        );
        if (spot === undefined) {
          continue;
        }
        if (!column.isPrimary && column.isNullable !== spot.nullable) {
          problems.push(
            `${where}.${column.name}: database nullable is ${String(column.isNullable)}, expected ${String(spot.nullable)}`
          );
        }
        if ('type' in spot) {
          const accepted: readonly string[] | undefined =
            SQLITE_TYPES[spot.type];
          if (
            accepted !== undefined &&
            !accepted.includes(lowerType(column.type))
          ) {
            problems.push(
              `${where}.${column.name}: database type is ${column.type}, expected one of ${accepted.join(', ')}`
            );
          }
          if (
            spot.type === 'string' &&
            spot.maxLength !== undefined &&
            spot.enumValues === undefined
          ) {
            if (column.length !== String(spot.maxLength)) {
              problems.push(
                `${where}.${column.name}: database length is ${column.length}, expected ${spot.maxLength}`
              );
            }
          }
        }
      }

      const uniqueSets: string[] = [
        ...table.uniques.map((unique: TableUnique) =>
          joined(unique.columnNames)
        ),
        ...table.indices
          .filter((index: TableIndex) => index.isUnique)
          .map((index: TableIndex) => joined(index.columnNames)),
        ...table.columns
          .filter((column: TableColumn) => column.isUnique)
          .map(columnSet),
      ];
      const indexSets: string[] = table.indices
        .filter((index: TableIndex) => !index.isUnique)
        .map((index: TableIndex) => joined(index.columnNames));
      for (const column of model.columns) {
        if (
          column.unique &&
          !column.primaryKey &&
          !uniqueSets.includes(column.column)
        ) {
          problems.push(
            `${where}: database has no unique constraint on ${column.column}`
          );
        }
      }
      for (const index of model.indexes) {
        const key: string = joined(index.columns);
        if (!(index.unique ? uniqueSets : indexSets).includes(key)) {
          problems.push(
            `${where}: database has no ${index.unique ? 'unique ' : ''}index on [${key}]`
          );
        }
        if (index.name !== undefined) {
          const names: string[] = [
            ...table.uniques.map((unique: TableUnique) => unique.name ?? ''),
            ...table.indices.map(
              (candidate: TableIndex) => candidate.name ?? ''
            ),
          ];
          if (!names.includes(index.name)) {
            problems.push(
              `${where}: database has no index or constraint named ${index.name}`
            );
          }
        }
      }

      for (const relation of model.relations) {
        const key: TableForeignKey | undefined = table.foreignKeys.find(
          (candidate: TableForeignKey) =>
            candidate.columnNames.includes(relation.column)
        );
        if (key === undefined) {
          problems.push(`${where}: no foreign key on ${relation.column}`);
          continue;
        }
        if (key.referencedTableName !== relation.targetTable) {
          problems.push(
            `${where}.${relation.column}: foreign key points at ${key.referencedTableName}, expected ${relation.targetTable}`
          );
        }
        const expectedAction: string | undefined =
          ON_DELETE_NAMES[relation.onDelete];
        if (key.onDelete !== expectedAction) {
          problems.push(
            `${where}.${relation.column}: database onDelete is ${String(key.onDelete)}, expected ${String(expectedAction)}`
          );
        }
      }
    }
    const tables: string[] = (await runner.getTables()).map(
      (table: Table) => table.name
    );
    for (const model of spec.models) {
      for (const relation of model.manyToMany) {
        const target: string =
          spec.models.find((candidate) => candidate.name === relation.target)
            ?.table ?? '';
        const junction: Table | undefined = (await runner.getTables()).find(
          (table: Table) => {
            const referenced: string[] = table.foreignKeys.map(
              (key: TableForeignKey) => key.referencedTableName
            );
            return (
              referenced.length === 2 &&
              referenced.includes(model.table) &&
              referenced.includes(target)
            );
          }
        );
        if (junction === undefined) {
          problems.push(
            `sqlite: no junction table between ${model.table} and ${target} among [${tables.join(', ')}]`
          );
        }
      }
    }
  } finally {
    await runner.release();
  }
}

async function verify(
  spec: Spec,
  provider: Provider,
  problems: string[]
): Promise<void> {
  const loaded: Record<string, unknown> = (await import(
    `./entities-${provider}.js`
  )) as Record<string, unknown>;
  const entities: EntityClass[] = Object.values(loaded).filter(
    (value: unknown): value is EntityClass => typeof value === 'function'
  );
  const options: DataSourceOptions =
    provider === 'sqlite'
      ? {
          type: 'better-sqlite3',
          database: ':memory:',
          entities,
          synchronize: true,
        }
      : ({
          type: DRIVER_TYPES[provider],
          database: 'ormbridge',
          entities,
        } as DataSourceOptions);
  const dataSource: DataSource = new DataSource(options);
  if (provider === 'sqlite') {
    await dataSource.initialize();
    compareMetadata(spec, dataSource.entityMetadatas, provider, problems);
    await compareDatabase(spec, dataSource, problems);
    await dataSource.destroy();
    return;
  }
  // No server is available, so only TypeORM's metadata building and validation run.
  await (
    dataSource as unknown as { buildMetadatas(): Promise<void> }
  ).buildMetadatas();
  compareMetadata(spec, dataSource.entityMetadatas, provider, problems);
}

async function main(argv: string[]): Promise<number> {
  const [specPath, ...providers] = argv.slice(2);
  if (specPath === undefined || providers.length === 0) {
    console.error('Usage: node validate-typeorm.js <spec.json> <provider>...');
    return 2;
  }
  const spec: Spec = JSON.parse(readFileSync(specPath, 'utf8')) as Spec;
  const problems: string[] = [];
  for (const provider of providers) {
    if (!(provider in DRIVER_TYPES)) {
      console.error(`Unknown provider ${provider}`);
      return 2;
    }
    try {
      await verify(spec, provider as Provider, problems);
    } catch (error: unknown) {
      const message: string =
        error instanceof Error ? error.message : String(error);
      problems.push(`${provider}: ${message}`);
    }
  }
  if (problems.length > 0) {
    for (const problem of problems) {
      console.error(`- ${problem}`);
    }
    return 1;
  }
  console.log(
    `typeorm entities verified: ${spec.models.length} models, providers ${providers.join(', ')}`
  );
  return 0;
}

main(process.argv).then(
  (code: number) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  }
);
