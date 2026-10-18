import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import type { IrSchema } from '../src/ir.js';
import {
  isToolError,
  JPA_EXTRAS,
  parseJpaDirectory,
  probeJava,
  runJpaTool,
  toDbSchema,
  type JpaDatabase,
  type JpaToolOutput,
  type ToolGroup,
} from './jpaSupport.js';
import { titleWithReason } from './realToolSupport.js';
import { compareWithDatabase } from './sequelizeSupport.js';

/**
 * Loads the Java fixtures with the real Hibernate ORM: `test/tools/jpa-verify` is built with Maven, compiles every
 * fixture directory, lets Hibernate 6 create the schema in an in-memory H2 database (`hbm2ddl.auto=create`, with
 * quoted identifiers so that names keep their case) and prints what JDBC metadata reports (tables, columns,
 * nullability, primary keys, unique keys, indexes, foreign keys and their actions). That is compared with what the
 * parser read from the same source.
 *
 * Set JPA_DIR to a scratch directory (the Maven repository goes there; see test/tools/setup-verification-tools.sh)
 * and, when `java` or `mvn` are not on the PATH, JAVA and MVN to the executables. The tests are skipped, with the
 * reason in their title, when Java 17 or Maven is missing.
 */

const FIXTURES: string = fileURLToPath(new URL('./fixtures', import.meta.url));

interface VerifyGroup extends ToolGroup {
  label: string;
}

const GROUPS: readonly VerifyGroup[] = [
  {
    name: 'blog',
    label: 'canonical blog schema',
    directory: join(FIXTURES, 'jpa'),
  },
  ...JPA_EXTRAS.map((name: string): VerifyGroup => ({
    name: name.replace(/-/g, '_'),
    label: `jpa-extras/${name}`,
    directory: join(FIXTURES, 'jpa-extras', name),
  })),
];

const probe: ReturnType<typeof probeJava> = probeJava();
let output: JpaToolOutput = {};

beforeAll(() => {
  if (!probe.available) {
    return;
  }
  output = runJpaTool(probe, GROUPS);
}, 1_200_000);

describe(titleWithReason('jpa parser: real Hibernate ORM', probe), () => {
  it.skipIf(!probe.available).each(GROUPS)(
    'agrees with the H2 database Hibernate creates for $label',
    async (group: VerifyGroup) => {
      const ir: IrSchema = await parseJpaDirectory(group.directory);
      const database = output[group.name];
      expect(database, `no output for ${group.name}`).toBeDefined();
      if (isToolError(database)) {
        throw new Error(
          `Hibernate rejected ${group.label}: ${database.__error}`
        );
      }
      expect(
        compareWithDatabase(ir, toDbSchema(database as JpaDatabase, ir), {
          compositeForeignKeys: true,
        })
      ).toEqual([]);
    }
  );
});
