import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { emitJpa, type JpaEmitOptions } from '../../../src/emitters/jpa.js';
import type { IrSchema } from '../../../src/ir.js';
import {
  isToolError,
  probeJava,
  runJpaTool,
  type JpaDatabase,
  type JpaToolError,
  type JpaToolOutput,
  type ToolGroup,
} from '../../../test/jpaSupport.js';
import { titleWithReason } from '../../../test/realToolSupport.js';
import { emitKotlin } from '../src/index.js';
import { SUBJECTS } from './subjects.js';

/**
 * Compiles the Kotlin the writer produces with the real Kotlin compiler (2.0, with the all-open plugin) and lets
 * Hibernate 6 create the database from it, the same way `jpa-emitter-verify` does for Java. Every schema is written
 * as Java and as Kotlin; the tables, columns, keys, indexes and foreign keys Hibernate creates must be the same, and
 * so must the rows saved through the classes. Skipped without Java and Maven (JPA_DIR; see test/README.md).
 */

const probe: ReturnType<typeof probeJava> = probeJava();

let root: string;
let output: JpaToolOutput = {};

function write(directory: string, files: Record<string, string>): void {
  for (const [path, text] of Object.entries(files)) {
    const target: string = join(directory, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, text);
  }
}

beforeAll(async () => {
  if (!probe.available) {
    return;
  }
  root = mkdtempSync(join(tmpdir(), 'ormbridge-kotlin-'));
  const groups: ToolGroup[] = [];
  for (const [position, subject] of SUBJECTS.entries()) {
    const schema: IrSchema = await subject.build();
    const options: JpaEmitOptions = {
      provider: 'postgresql',
      naming: 'preserve',
      header: false,
      ...subject.options,
    };
    for (const [language, files] of [
      ['java', emitJpa(structuredClone(schema), options).files],
      ['kotlin', emitKotlin(structuredClone(schema), options).files],
    ] as const) {
      const directory: string = join(root, `${language}-${position}`);
      write(directory, files);
      groups.push({ name: `${language}-${position}`, directory });
    }
  }
  output = runJpaTool(probe, groups, { variant: 'kotlin', exercise: true });
}, 900_000);

afterAll(() => {
  if (root !== undefined) {
    rmSync(root, { recursive: true, force: true });
  }
});

/** The rows with the time they were saved at and the random UUIDs (they differ between the two runs) replaced by markers. */
function withoutNow(exercise: unknown): unknown {
  const year: string = String(new Date().getFullYear());
  return JSON.parse(
    JSON.stringify(exercise)
      .replace(
        new RegExp(`${year}-\\d\\d-\\d\\d[ T]\\d\\d:\\d\\d:\\d\\d[.\\d]*`, 'g'),
        '<now>'
      )
      .replace(
        /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g,
        '<uuid>'
      )
  );
}

function databaseOf(name: string): JpaDatabase {
  const found: JpaDatabase | JpaToolError | undefined = output[name];
  if (found === undefined) {
    throw new Error(`The tool printed nothing for ${name}`);
  }
  if (isToolError(found)) {
    throw new Error(`${name}: ${found.__error}`);
  }
  return found;
}

describe(
  titleWithReason('kotlin writer: real Kotlin and Hibernate', probe),
  () => {
    it
      .skipIf(!probe.available)
      .each(SUBJECTS.map((subject, position) => ({ subject, position })))(
      '$subject.label compiles and creates the tables the Java output creates',
      ({ position }) => {
        expect(databaseOf(`kotlin-${position}`).tables).toEqual(
          databaseOf(`java-${position}`).tables
        );
      }
    );

    it
      .skipIf(!probe.available)
      .each(
        SUBJECTS.map((subject, position) => ({ subject, position })).filter(
          ({ subject }) => subject.schemaOnly !== true
        )
      )(
      '$subject.label saves the rows the Java output saves',
      ({ position }) => {
        expect(withoutNow(databaseOf(`kotlin-${position}`).exercise)).toEqual(
          withoutNow(databaseOf(`java-${position}`).exercise)
        );
      }
    );
  }
);
