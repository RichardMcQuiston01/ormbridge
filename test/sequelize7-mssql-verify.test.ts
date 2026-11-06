import { rmSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { emitSequelize } from '../src/emitters/sequelize.js';
import type { MultiFileEmitOutput } from '../src/formats.js';
import type { IrSchema } from '../src/ir.js';
import type { NamingMode } from '../src/transforms.js';
import { compareIr } from './irCompare.js';
import { titleWithReason, type ToolProbe } from './realToolSupport.js';
import {
  compile7,
  probeSequelize7,
  scratchProject7,
  type Sequelize7Probe,
} from './sequelize7Support.js';
import {
  asSqlServerHolds,
  compareMssqlTypes,
  namedLike,
  probeSequelize7Mssql,
  readBack,
  readTables,
  runMssql7,
  sqlServerProblems,
  unannounced,
  withoutRelatedNames,
  type Mssql7Run,
  type MssqlTable,
} from './sequelize7MssqlSupport.js';
import { SUBJECTS, type Subject } from './sequelize7Subjects.js';
import { expectedAssociations, expectedSchema } from './sequelizeSupport.js';

/**
 * Checks the Sequelize 7 output for SQL Server (`--style v7 --provider sqlserver`) without a SQL Server. Its
 * container image cannot be used (it needs a license to be accepted), so nothing here runs against a server and
 * the DDL has not been executed by one. What is checked is everything a server is not needed for.
 *
 * The writer's output for the canonical blog schema of every format, the extras and two IR fixtures, in both
 * naming modes (the subjects of `sequelize7-server-verify.test.ts`), is compiled with `tsc --strict` against the
 * types of `@sequelize/core`; `new Sequelize({ dialect: MsSqlDialect, models })` from `@sequelize/mssql` defines and
 * associates the models (the instance is built and never connects), and the associations are compared with the
 * relations of the IR. The statements that `sequelize.sync()` would send are collected from the dialect's own query
 * generator (`test/tools/generate-sequelize7-mssql.mjs`); they are read back with the SQL DDL reader (`parseSqlDdl`,
 * which reads SQL Server) and compared with the IR: tables, columns, types, nullability, defaults, primary, unique
 * and foreign keys with their actions, and indexes. The type spellings (`BIGINT`, `DECIMAL(p, s)`, `NVARCHAR(n)`,
 * `BIT`, `DATETIMEOFFSET`, `UNIQUEIDENTIFIER`) and the rules of SQL Server that the dialect does not enforce when it
 * writes the DDL (no `RESTRICT`, no index over `NVARCHAR(MAX)`, cascade paths, identifier length) are checked on the
 * statements.
 *
 * Set SEQUELIZE7_DIR to a directory where `npm install @sequelize/core @sequelize/mssql typescript @types/node` has
 * been run (see test/README.md and test/tools/setup-verification-tools.sh). The tests are skipped with a reason
 * without it.
 */

const base: Sequelize7Probe = probeSequelize7();
const probe: ToolProbe = probeSequelize7Mssql(base);
const directories: string[] = [];

afterAll(() => {
  for (const directory of directories) {
    rmSync(directory, { recursive: true, force: true });
  }
});

const NAMINGS: readonly NamingMode[] = ['preserve', 'normalize'];

describe('sequelize 7: SQL Server dialect without a server', () => {
  it
    .skipIf(!probe.available)
    .each(
      SUBJECTS.map((subject: Subject): [string, Subject] => [
        subject.label,
        subject,
      ])
    )(
    titleWithReason(
      'defines the models of %s and writes DDL that reads back as the schema (both naming modes)',
      probe
    ),
    async (_label: string, subject: Subject) => {
      const schema: IrSchema = await subject.build();
      // Both naming modes share one scratch project, so `tsc` starts once.
      const outputs: Map<NamingMode, MultiFileEmitOutput> = new Map();
      const files: Record<string, string> = {};
      for (const naming of NAMINGS) {
        const output: MultiFileEmitOutput = emitSequelize(
          structuredClone(schema),
          { provider: 'sqlserver', naming, style: 'v7' }
        );
        outputs.set(naming, output);
        for (const [path, text] of Object.entries(output.files)) {
          files[`${naming}/${path}`] = text;
        }
      }
      const directory: string = scratchProject7(base, files);
      directories.push(directory);
      expect(compile7(base, directory, Object.keys(files)), 'tsc').toBe('');

      for (const naming of NAMINGS) {
        const output: MultiFileEmitOutput = outputs.get(
          naming
        ) as MultiFileEmitOutput;
        const { run, result } = runMssql7(
          base,
          directory,
          `out/${naming}/index.js`
        );
        expect(run.status, `${naming} naming: ${run.stderr}`).toBe(0);
        const { statements, associations } = result as Mssql7Run;

        // The models load and declare the associations of the IR.
        const ir: IrSchema = expectedSchema(schema, naming);
        const declared: string[] = associations.map(
          (association: { model: string; as: string }) =>
            `${association.model}.${association.as}`
        );
        for (const name of expectedAssociations(ir, naming)) {
          expect(declared, `${naming} naming: ${name}`).toContain(name);
        }

        // The DDL is valid for SQL Server and spells the types the way the dialect should.
        expect(sqlServerProblems(statements), `${naming} naming`).toEqual([]);
        const tables: MssqlTable[] = readTables(statements);
        expect(tables.length, `${naming} naming`).toBeGreaterThan(0);
        expect(compareMssqlTypes(ir, tables), `${naming} naming`).toEqual([]);

        // Read back with the SQL reader, it is the IR, except for what the writer announced with a warning.
        const expected: IrSchema = withoutRelatedNames(
          asSqlServerHolds(ir, tables)
        );
        const read: IrSchema = namedLike(readBack(statements), expected);
        expect(
          unannounced(expected, compareIr(expected, read), output.warnings),
          `${naming} naming`
        ).toEqual([]);
      }
    },
    300_000
  );
});
