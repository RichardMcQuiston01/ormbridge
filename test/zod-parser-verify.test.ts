import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { convertText } from '../src/convert.js';
import type {
  IrEnum,
  IrField,
  IrModel,
  IrRelation,
  IrSchema,
} from '../src/ir.js';
import { parseZod } from '../src/parsers/zod.js';
import { expectOk } from './helpers.js';
import { titleWithReason, type ToolProbe } from './realToolSupport.js';

/**
 * Runs the Zod fixtures with the real library (Zod 3.25 and Zod 4, through tsx) and checks that what the
 * ormbridge reader read agrees with what Zod itself reports: the keys of `schema.shape` in order,
 * `isOptional()`, `isNullable()`, the type under the wrappers (`_def.typeName` and `_def.checks` in Zod 3,
 * `_zod.def` in Zod 4), string lengths and formats, enum members and the schemas a property holds.
 * test/tools/inspect-zod.mjs collects the facts; the expectations below turn them into columns
 * independently of the reader. The writer's own output for the canonical Prisma schema is checked too.
 *
 * Set ZOD_DIR to a directory where `npm install zod@4 zod3@npm:zod@3 tsx typescript @types/node` has been run
 * (test/tools/setup-verification-tools.sh does it with pinned versions); see test/README.md. The tests are
 * skipped when it is not set.
 */

const REQUIRED_PACKAGES: readonly string[] = ['zod', 'zod3', 'tsx'];

interface ZodTools extends ToolProbe {
  directory: string;
  /** Versions of the packages `zod` (Zod 4) and `zod3` (Zod 3), when installed. */
  versions: { zod: string; zod3: string };
}

function installedVersion(directory: string, name: string): string {
  try {
    const manifest: { version?: string } = JSON.parse(
      readFileSync(
        join(directory, 'node_modules', name, 'package.json'),
        'utf8'
      )
    );
    return manifest.version ?? '';
  } catch {
    return '';
  }
}

function probeZod(): ZodTools {
  const directory: string = process.env.ZOD_DIR ?? '';
  const versions = { zod: '', zod3: '' };
  if (directory === '') {
    return {
      available: false,
      reason:
        'set ZOD_DIR to a directory with zod, zod3 (an alias of zod 3) and tsx installed (see test/README.md)',
      directory,
      versions,
    };
  }
  const missing: string[] = REQUIRED_PACKAGES.filter(
    (name: string) =>
      !existsSync(join(directory, 'node_modules', name, 'package.json'))
  );
  if (missing.length > 0) {
    return {
      available: false,
      reason: `ZOD_DIR is missing ${missing.join(', ')} (see test/README.md)`,
      directory,
      versions,
    };
  }
  versions.zod = installedVersion(directory, 'zod');
  versions.zod3 = installedVersion(directory, 'zod3');
  if (!versions.zod.startsWith('4.') || !versions.zod3.startsWith('3.')) {
    return {
      available: false,
      reason: `ZOD_DIR has zod ${versions.zod} and zod3 ${versions.zod3}; Zod 4 and Zod 3 are needed (see test/README.md)`,
      directory,
      versions,
    };
  }
  return { available: true, reason: '', directory, versions };
}

const probe: ZodTools = probeZod();
const directories: string[] = [];

afterAll(() => {
  for (const directory of directories) {
    rmSync(directory, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// What Zod reports (the output of test/tools/inspect-zod.mjs)
// ---------------------------------------------------------------------------

interface Leaf {
  kind: string;
  coerce?: boolean;
  formats?: string[];
  maxLength?: number | null;
  patterns?: string[];
  int?: boolean;
  entries?: Record<string, string>;
  numeric?: boolean;
  value?: string | number | boolean;
  element?: Facts;
  options?: Facts[];
  objectRef?: string | null;
}

interface Facts {
  key?: string;
  optional: boolean;
  nullable: boolean;
  hasDefault: boolean;
  piped: boolean;
  leaf: Leaf;
}

type FileFacts = Record<string, Record<string, Facts[]>>;

// ---------------------------------------------------------------------------
// What the reader should have read, worked out from the facts alone
// ---------------------------------------------------------------------------

interface Expected {
  type: string;
  arrayDepth: number;
  maxLength?: number;
  digits?: [number, number];
  enumValues?: string[];
  relation?: { target: string; many: boolean };
  /** Null and undefined options of a union: they only add nullability. */
  onlyNull?: boolean;
  onlyUndefined?: boolean;
}

const FORMAT_TYPES: Readonly<Record<string, string>> = {
  uuid: 'uuid',
  datetime: 'dateTime',
  date: 'date',
  time: 'time',
  duration: 'duration',
  ip: 'ipAddress',
  ipv4: 'ipAddress',
  ipv6: 'ipAddress',
  base64: 'bytes',
};

/** The decimal pattern the Zod writer produces, with its digits before and after the point. */
function decimalOf(pattern: string): [number, number] | undefined {
  if (pattern === '^-?\\d+(\\.\\d+)?$') {
    return [0, 0];
  }
  const match: RegExpExecArray | null =
    /^\^-\?\\d\{1,(\d+)\}(?:\(\\\.\\d\{1,(\d+)\}\)\?)?\$$/.exec(pattern);
  if (match === null) {
    return undefined;
  }
  const places: number = match[2] === undefined ? 0 : Number(match[2]);
  return [Number(match[1]) + places, places];
}

function expectedOf(facts: Facts): Expected {
  const leaf: Leaf = facts.leaf;
  switch (leaf.kind) {
    case 'string': {
      const format: string | undefined = (leaf.formats ?? [])[0];
      if (format !== undefined && FORMAT_TYPES[format] !== undefined) {
        return { type: FORMAT_TYPES[format] ?? 'text', arrayDepth: 0 };
      }
      const pattern: string | undefined = (leaf.patterns ?? [])[0];
      if (pattern === '^-?\\d+$') {
        return { type: 'bigInt', arrayDepth: 0 };
      }
      const decimal: [number, number] | undefined =
        pattern === undefined ? undefined : decimalOf(pattern);
      if (decimal !== undefined) {
        return decimal[0] === 0
          ? { type: 'decimal', arrayDepth: 0 }
          : { type: 'decimal', arrayDepth: 0, digits: decimal };
      }
      return typeof leaf.maxLength === 'number'
        ? { type: 'string', arrayDepth: 0, maxLength: leaf.maxLength }
        : { type: 'text', arrayDepth: 0 };
    }
    case 'number':
      return { type: leaf.int === true ? 'int' : 'float', arrayDepth: 0 };
    case 'bigint':
      return { type: 'bigInt', arrayDepth: 0 };
    case 'boolean':
      return { type: 'boolean', arrayDepth: 0 };
    case 'date':
      return { type: 'dateTime', arrayDepth: 0 };
    case 'enum':
      return leaf.numeric === true
        ? { type: 'int', arrayDepth: 0 }
        : {
            type: 'enum',
            arrayDepth: 0,
            enumValues: Object.values(leaf.entries ?? {}),
          };
    case 'literal':
      return typeof leaf.value === 'string'
        ? { type: 'text', arrayDepth: 0 }
        : typeof leaf.value === 'number'
          ? {
              type: Number.isInteger(leaf.value) ? 'int' : 'float',
              arrayDepth: 0,
            }
          : { type: 'boolean', arrayDepth: 0 };
    case 'array':
    case 'set': {
      const inner: Expected = expectedOf(leaf.element as Facts);
      return inner.relation !== undefined
        ? { ...inner, relation: { ...inner.relation, many: true } }
        : { ...inner, arrayDepth: inner.arrayDepth + 1 };
    }
    case 'object':
      return leaf.objectRef === null || leaf.objectRef === undefined
        ? { type: 'json', arrayDepth: 0 }
        : {
            type: 'json',
            arrayDepth: 0,
            relation: { target: modelName(leaf.objectRef), many: false },
          };
    case 'null':
      return { type: 'json', arrayDepth: 0, onlyNull: true };
    case 'undefined':
      return { type: 'json', arrayDepth: 0, onlyUndefined: true };
    case 'union':
      return unionOf(leaf.options ?? []);
    default:
      return { type: 'json', arrayDepth: 0 };
  }
}

function unionOf(options: Facts[]): Expected {
  const parts: Expected[] = options.map(expectedOf);
  const rest: Expected[] = parts.filter(
    (part: Expected) => part.onlyNull !== true && part.onlyUndefined !== true
  );
  const first: Expected | undefined = rest[0];
  if (first === undefined) {
    return { type: 'json', arrayDepth: 0 };
  }
  if (rest.length === 1) {
    return first;
  }
  const literals: string[] = options
    .filter((option: Facts) => option.leaf.kind === 'literal')
    .map((option: Facts) => String(option.leaf.value));
  if (literals.length === options.length) {
    return { type: 'enum', arrayDepth: 0, enumValues: literals };
  }
  const same: boolean = rest.every(
    (part: Expected) =>
      part.type === first.type &&
      part.arrayDepth === first.arrayDepth &&
      part.relation === undefined &&
      first.relation === undefined
  );
  return same ? first : { type: 'json', arrayDepth: 0 };
}

/** `UserSchema` is read as the model `User`. */
function modelName(exportName: string): string {
  return exportName.replace(/Schema$/, '');
}

/** True when a union option is a null or an undefined (only adds nullability). */
function unionNullable(facts: Facts): boolean {
  return (
    facts.leaf.kind === 'union' &&
    (facts.leaf.options ?? []).some(
      (option: Facts) =>
        option.leaf.kind === 'null' || option.leaf.kind === 'undefined'
    )
  );
}

// ---------------------------------------------------------------------------
// Comparing
// ---------------------------------------------------------------------------

/** Schemas the Zod writer derives from a row schema: the reader skips them. */
const WRITER_VARIANT: RegExp = /(Create|Update|WithRelations)Schema$/;

/**
 * Properties whose value Zod reports differently from the way a column is read, with the reason.
 * `Device.stringy`: z.stringbool() is a string that is transformed into a boolean; the reader takes the output type.
 */
const OUTPUT_TYPE_EXCEPTIONS: ReadonlySet<string> = new Set(['Device.stringy']);

function compareGroup(
  label: string,
  facts: FileFacts,
  schema: IrSchema,
  skipVariants: boolean
): string[] {
  const problems: string[] = [];
  const exported: string[] = [];
  for (const models of Object.values(facts)) {
    for (const [exportName, properties] of Object.entries(models)) {
      if (skipVariants && WRITER_VARIANT.test(exportName)) {
        continue;
      }
      exported.push(modelName(exportName));
      const name: string = modelName(exportName);
      const model: IrModel | undefined = schema.models.find(
        (candidate: IrModel) => candidate.name === name
      );
      if (model === undefined) {
        problems.push(`${label}: ${name} was not read`);
        continue;
      }
      problems.push(...compareModel(label, name, properties, model, schema));
    }
  }
  const read: string[] = schema.models.map((model: IrModel) => model.name);
  if (
    JSON.stringify([...read].sort()) !== JSON.stringify([...exported].sort())
  ) {
    problems.push(
      `${label}: the reader read [${read.join(', ')}] but Zod exports [${exported.join(', ')}]`
    );
  }
  return problems;
}

function compareModel(
  label: string,
  name: string,
  properties: Facts[],
  model: IrModel,
  schema: IrSchema
): string[] {
  const problems: string[] = [];
  const holder = `${label}: ${name}`;
  const scalars: Facts[] = [];
  for (const property of properties) {
    const expected: Expected = expectedOf(property);
    if (expected.relation !== undefined) {
      problems.push(...compareRelation(holder, property, expected, model));
    } else {
      scalars.push(property);
    }
  }
  const keys: string[] = scalars.map((property: Facts) => property.key ?? '');
  const fields: string[] = model.fields.map((field: IrField) => field.name);
  if (JSON.stringify(keys) !== JSON.stringify(fields)) {
    problems.push(
      `${holder}: Zod has the keys [${keys}] but the reader read [${fields}]`
    );
  }
  for (const property of scalars) {
    const key: string = property.key ?? '';
    const field: IrField | undefined = model.fields.find(
      (candidate: IrField) => candidate.name === key
    );
    if (field !== undefined) {
      problems.push(
        ...compareField(`${holder}.${key}`, property, field, schema)
      );
    }
  }
  return problems;
}

function compareRelation(
  holder: string,
  property: Facts,
  expected: Expected,
  model: IrModel
): string[] {
  const relation: IrRelation | undefined = model.relations.find(
    (candidate: IrRelation) => candidate.name === property.key
  );
  const where = `${holder}.${property.key}`;
  if (expected.relation === undefined) {
    return [];
  }
  if (relation === undefined) {
    // The reverse side of a foreign key is not a relation of its own.
    return expected.relation.many
      ? []
      : [
          `${where}: Zod holds the schema ${expected.relation.target} but no relation was read`,
        ];
  }
  const problems: string[] = [];
  const kind: string = expected.relation.many ? 'manyToMany' : 'foreignKey';
  if (
    relation.targetModel !== expected.relation.target ||
    relation.kind !== kind
  ) {
    problems.push(
      `${where}: expected ${kind} to ${expected.relation.target}, read ${relation.kind} to ${relation.targetModel}`
    );
  }
  if (!expected.relation.many) {
    const nullable: boolean =
      property.nullable || (property.optional && !property.hasDefault);
    if (relation.isNullable !== nullable) {
      problems.push(
        `${where}: Zod says nullable ${nullable}, read ${relation.isNullable}`
      );
    }
  }
  return problems;
}

function compareField(
  where: string,
  property: Facts,
  field: IrField,
  schema: IrSchema
): string[] {
  const problems: string[] = [];
  const expected: Expected = expectedOf(property);
  if (!OUTPUT_TYPE_EXCEPTIONS.has(where.replace(/^[^:]*: /, ''))) {
    if (expected.type === 'enum') {
      const enumDefinition: IrEnum | undefined = schema.enums.find(
        (candidate: IrEnum) => candidate.name === field.enumName
      );
      const values: string[] =
        enumDefinition?.values.map((value) => value.dbValue) ?? [];
      if (
        JSON.stringify([...values].sort()) !==
        JSON.stringify([...(expected.enumValues ?? [])].sort())
      ) {
        problems.push(
          `${where}: Zod enum [${expected.enumValues}] but the reader read [${values}]`
        );
      }
    } else if (field.type !== expected.type) {
      problems.push(`${where}: Zod says ${expected.type}, read ${field.type}`);
    }
    if ((field.arrayDepth ?? 0) !== expected.arrayDepth) {
      problems.push(
        `${where}: Zod says ${expected.arrayDepth} array levels, read ${field.arrayDepth ?? 0}`
      );
    }
    if (field.maxLength !== expected.maxLength) {
      problems.push(
        `${where}: Zod says max length ${expected.maxLength}, read ${field.maxLength}`
      );
    }
    if (
      expected.digits !== undefined &&
      (field.maxDigits !== expected.digits[0] ||
        field.decimalPlaces !== expected.digits[1])
    ) {
      problems.push(
        `${where}: Zod says decimal(${expected.digits}), read decimal(${field.maxDigits}, ${field.decimalPlaces})`
      );
    }
  }
  // Nullability. Zod reports a value that its coercion or its json type accepts as optional or nullable
  // (z.coerce.date() accepts null, z.unknown() accepts undefined); the reader does not read that as a column rule.
  const lenient: boolean =
    property.leaf.coerce === true ||
    expected.type === 'json' ||
    OUTPUT_TYPE_EXCEPTIONS.has(where.replace(/^[^:]*: /, ''));
  const isKey: boolean = field.isPrimaryKey;
  if (!lenient) {
    const nullable: boolean =
      property.nullable ||
      (property.optional && !property.hasDefault) ||
      unionNullable(property);
    const wanted: boolean = isKey ? false : nullable;
    if (field.isNullable !== wanted) {
      problems.push(
        `${where}: Zod says optional ${property.optional}, nullable ${property.nullable}, default ${property.hasDefault}; the reader read nullable ${field.isNullable}`
      );
    }
  }
  if (property.hasDefault && field.default === undefined && !lenient) {
    // A default the reader could not store is allowed (it is listed in a warning); one it stored must be real.
    return problems;
  }
  if (!property.hasDefault && field.default !== undefined) {
    problems.push(`${where}: the reader read a default but Zod has none`);
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Running the real tools
// ---------------------------------------------------------------------------

const FIXTURES: string = fileURLToPath(new URL('./fixtures', import.meta.url));
const INSPECTOR: string = fileURLToPath(
  new URL('./tools/inspect-zod.mjs', import.meta.url)
);

/** Fixture modules each version can run: the Zod 4 spellings need Zod 4, the Zod 3 only ones need Zod 3. */
const CANONICAL_FILES: readonly string[] = readdirSync(join(FIXTURES, 'zod'))
  .filter((name: string) => name.endsWith('.ts'))
  .sort();
const SHARED_EXTRAS: readonly string[] = [
  'zod3-style.ts',
  'algebra.ts',
  'relations.ts',
  'json-fallbacks.ts',
];

interface Group {
  label: string;
  /** Paths relative to the project directory. */
  files: string[];
  skipVariants: boolean;
}

interface Project {
  directory: string;
  groups: Group[];
}

/** Copies the fixtures into a project whose node_modules is the tools directory's. */
function buildProject(major: 3 | 4, emitted: string): Project {
  const directory: string = mkdtempSync(
    join(tmpdir(), `ormbridge-zod${major}-`)
  );
  directories.push(directory);
  symlinkSync(
    join(probe.directory, 'node_modules'),
    join(directory, 'node_modules'),
    'dir'
  );
  // Zod 3 runs through the alias package "zod3", so the same source files serve both versions.
  const rewrite = (text: string): string =>
    major === 3 ? text.replace(/from 'zod'/g, "from 'zod3'") : text;
  const copy = (from: string, to: string): void => {
    mkdirSync(join(directory, to, '..'), { recursive: true });
    writeFileSync(join(directory, to), rewrite(readFileSync(from, 'utf8')));
  };
  const groups: Group[] = [];
  const extras: string[] = [...SHARED_EXTRAS];
  extras.push(major === 3 ? 'zod3-only.ts' : 'zod4-style.ts');
  groups.push({
    label: 'extras',
    files: extras.map((name: string) => `extras/${name}`),
    skipVariants: false,
  });
  for (const name of extras) {
    copy(join(FIXTURES, 'zod-extras', name), `extras/${name}`);
  }
  if (major === 4) {
    for (const name of CANONICAL_FILES) {
      copy(join(FIXTURES, 'zod', name), `canonical/${name}`);
    }
    groups.push({
      label: 'canonical',
      files: CANONICAL_FILES.map((name: string) => `canonical/${name}`),
      skipVariants: false,
    });
    writeFileSync(join(directory, 'emitted.ts'), emitted);
    groups.push({
      label: 'writer output',
      files: ['emitted.ts'],
      skipVariants: true,
    });
  }
  return { directory, groups };
}

function inspect(project: Project, major: 3 | 4): FileFacts {
  const files: string[] = project.groups.flatMap((group: Group) => group.files);
  const run = spawnSync(
    join(probe.directory, 'node_modules', '.bin', 'tsx'),
    [INSPECTOR, String(major), ...files],
    { cwd: project.directory, encoding: 'utf8', timeout: 120_000 }
  );
  if (run.status !== 0) {
    throw new Error(
      `inspect-zod.mjs failed for Zod ${major}:\n${run.stderr}\n${run.stdout}`
    );
  }
  return JSON.parse(run.stdout) as FileFacts;
}

async function emittedCanonical(): Promise<string> {
  const text: string = readFileSync(
    join(FIXTURES, 'canonical', 'schema.prisma'),
    'utf8'
  );
  const converted = expectOk(
    await convertText([{ path: 'schema.prisma', text }], {
      from: 'prisma',
      to: 'zod',
      naming: 'preserve',
      provider: 'postgresql',
      header: false,
      autoField: 'int',
    })
  );
  return converted.output;
}

describe(titleWithReason('zod reader: real Zod', probe), () => {
  for (const major of [4, 3] as const) {
    it.skipIf(!probe.available)(
      `agrees with Zod ${major} about every fixture schema`,
      async () => {
        const project: Project = buildProject(major, await emittedCanonical());
        const facts: FileFacts = inspect(project, major);
        const problems: string[] = [];
        let compared: number = 0;
        for (const group of project.groups) {
          const groupFacts: FileFacts = Object.fromEntries(
            group.files.map((file: string) => [file, facts[file] ?? {}])
          );
          const sources = group.files.map((file: string) => ({
            path: file,
            // Read the sources as written (with `from 'zod'`); the version only changes which package runs them.
            text: readFileSync(join(project.directory, file), 'utf8').replace(
              /from 'zod3'/g,
              "from 'zod'"
            ),
          }));
          const schema: IrSchema = expectOk(
            await parseZod(sources, { appLabel: 'app' })
          );
          problems.push(
            ...compareGroup(group.label, groupFacts, schema, group.skipVariants)
          );
          compared += schema.models.length;
        }
        expect(problems).toEqual([]);
        // Guards against a run that compared nothing: 6 canonical, the writer's 6 and 16 of the extras' models.
        expect(compared).toBeGreaterThanOrEqual(major === 4 ? 28 : 16);
      },
      120_000
    );
  }

  it.skipIf(!probe.available)('uses the pinned Zod releases', () => {
    expect(probe.versions.zod).toMatch(/^4\.\d+\.\d+$/);
    expect(probe.versions.zod3).toMatch(/^3\.25\.\d+$/);
  });
});
