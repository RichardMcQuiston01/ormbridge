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
import { SUBJECTS } from '../../kotlin/test/subjects.js';
import { emitSpringData, emitSpringDataKotlin } from '../src/index.js';

/**
 * Compiles the Spring Data output (Java and Kotlin, with the Spring Data JPA and Spring Framework jars on the class
 * path) and lets Hibernate 6 create the database from it. The tables must be those of the plain JPA output: Spring
 * Data changes the timestamp annotations and adds repositories, never the schema. Skipped without Java and Maven
 * (JPA_DIR; see test/README.md).
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
  root = mkdtempSync(join(tmpdir(), 'ormbridge-spring-'));
  const groups: ToolGroup[] = [];
  for (const [position, subject] of SUBJECTS.entries()) {
    const schema: IrSchema = await subject.build();
    const options: JpaEmitOptions = {
      provider: 'postgresql',
      naming: 'preserve',
      header: false,
      ...subject.options,
    };
    for (const [kind, files] of [
      ['plain', emitJpa(structuredClone(schema), options).files],
      ['spring', emitSpringData(structuredClone(schema), options).files],
      [
        'springkt',
        emitSpringDataKotlin(structuredClone(schema), options).files,
      ],
    ] as const) {
      const directory: string = join(root, `${kind}-${position}`);
      write(directory, files);
      groups.push({ name: `${kind}-${position}`, directory });
    }
  }
  output = runJpaTool(probe, groups, { variant: 'kotlin' });
}, 900_000);

afterAll(() => {
  if (root !== undefined) {
    rmSync(root, { recursive: true, force: true });
  }
});

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
  titleWithReason(
    'spring data writer: real Spring Data JPA and Hibernate',
    probe
  ),
  () => {
    it.skipIf(!probe.available).each(
      SUBJECTS.flatMap((subject, position) => [
        { subject, position, kind: 'spring', language: 'Java' },
        { subject, position, kind: 'springkt', language: 'Kotlin' },
      ])
    )(
      '$subject.label compiles as $language and creates the tables of the plain JPA output',
      ({ position, kind }) => {
        expect(databaseOf(`${kind}-${position}`).tables).toEqual(
          databaseOf(`plain-${position}`).tables
        );
      }
    );
  }
);
