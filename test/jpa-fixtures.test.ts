import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { convertText, type ConvertResult } from '../src/convert.js';
import type { IrModel, IrSchema } from '../src/ir.js';
import { runConversion } from '../src/io.js';
import { CANONICAL_FIXTURES } from './fixtures/canonical.js';
import { DEFAULT_OPTIONS, expectOk } from './helpers.js';
import { javaFiles, parseJpaDirectory } from './jpaSupport.js';

const FIXTURES: string = fileURLToPath(new URL('./fixtures', import.meta.url));
const GOLDEN_DIRECTORY: string = fileURLToPath(
  new URL('./golden-extras/', import.meta.url)
);

/** Compares text with test/golden-extras/<name>; run with UPDATE_GOLDEN=1 to rewrite it. */
function expectMatchesExtrasGolden(name: string, actual: string): void {
  const goldenPath: string = `${GOLDEN_DIRECTORY}${name}`;
  if (process.env.UPDATE_GOLDEN === '1') {
    mkdirSync(dirname(goldenPath), { recursive: true });
    writeFileSync(goldenPath, actual);
    return;
  }
  if (!existsSync(goldenPath)) {
    throw new Error(
      `Golden file test/golden-extras/${name} does not exist. Run the tests with UPDATE_GOLDEN=1 to create it.`
    );
  }
  expect(actual).toBe(readFileSync(goldenPath, 'utf8'));
}

function model(schema: IrSchema, name: string): IrModel {
  const found: IrModel | undefined = schema.models.find(
    (candidate: IrModel) => candidate.name === name
  );
  if (found === undefined) {
    throw new Error(`Model ${name} was not parsed`);
  }
  return found;
}

describe('canonical fixture', () => {
  it('reads the blog schema without a warning', async () => {
    const paths: string[] =
      CANONICAL_FIXTURES.find((fixture) => fixture.format === 'jpa')?.paths ??
      [];
    const schema: IrSchema = await parseJpaDirectory(join(FIXTURES, 'jpa'));
    expect(paths.length).toBe(javaFiles(join(FIXTURES, 'jpa')).length);
    expect(schema.models.map((item: IrModel) => item.name).sort()).toEqual([
      'Category',
      'Post',
      'Profile',
      'Tag',
      'User',
    ]);
    expect(schema.warnings).toEqual([]);
    expect(model(schema, 'Post').indexes).toContainEqual({
      fields: ['author', 'title'],
      isUnique: true,
      name: 'uniq_post_author_title',
    });
    const post: IrModel = model(schema, 'Post');
    const kinds: Record<string, string> = Object.fromEntries(
      post.relations.map((item) => [item.name, item.kind])
    );
    expect(kinds).toEqual({
      author: 'foreignKey',
      editor: 'foreignKey',
      category: 'foreignKey',
      tags: 'manyToMany',
    });
    expect(post.relations.map((item) => item.onDelete)).toEqual([
      'cascade',
      'setNull',
      'restrict',
      'cascade',
    ]);
    expect(model(schema, 'Profile').relations[0]?.kind).toBe('oneToOne');
  });
});

describe('extras fixtures', () => {
  const GROUPS: readonly string[] = [
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
    'unsupported',
  ];

  async function convertExtras(group: string): Promise<ConvertResult> {
    return expectOk(
      await convertText(
        javaFiles(join(FIXTURES, 'jpa-extras', group)).map((path: string) => ({
          path,
          text: readFileSync(path, 'utf8'),
        })),
        { ...DEFAULT_OPTIONS, appLabel: group, from: 'jpa', to: 'prisma' }
      )
    );
  }

  it.each(GROUPS)('matches the Prisma golden for %s', async (group: string) => {
    const result: ConvertResult = await convertExtras(group);
    expectMatchesExtrasGolden(`jpa-${group}-to-prisma.txt`, result.output);
  });

  it.each(GROUPS)(
    'matches the warnings golden for %s',
    async (group: string) => {
      const result: ConvertResult = await convertExtras(group);
      expectMatchesExtrasGolden(
        `jpa-${group}-warnings.txt`,
        result.warnings
          .map(
            (warning: string) =>
              `${warning.replaceAll(FIXTURES, 'test/fixtures')}\n`
          )
          .join('')
      );
    }
  );

  it('reads the javax variant like the jakarta one', async () => {
    const schema: IrSchema = await parseJpaDirectory(
      join(FIXTURES, 'jpa-extras', 'javax')
    );
    expect(model(schema, 'Account').tableName).toBe('accounts');
    expect(model(schema, 'Invoice').relations[0]).toMatchObject({
      targetModel: 'Account',
      columnName: 'account_id',
      isNullable: false,
    });
  });

  it('reads the property access variant from the getters', async () => {
    const schema: IrSchema = await parseJpaDirectory(
      join(FIXTURES, 'jpa-extras', 'property-access')
    );
    expect(model(schema, 'Customer').fields.map((item) => item.name)).toEqual([
      'id',
      'name',
      'active',
    ]);
    expect(model(schema, 'Region').fields[1]).toMatchObject({
      name: 'code',
      isUnique: true,
      maxLength: 5,
    });
  });

  it('reads the Spring Data auditing variant', async () => {
    const schema: IrSchema = await parseJpaDirectory(
      join(FIXTURES, 'jpa-extras', 'spring-auditing')
    );
    const fields = Object.fromEntries(
      model(schema, 'Article').fields.map((item) => [item.name, item])
    );
    expect(fields['createdDate']?.default).toEqual({ kind: 'now' });
    expect(fields['lastModifiedDate']?.isAutoUpdated).toBe(true);
    expect(fields['createdBy']?.type).toBe('string');
  });
});

describe('directory input', () => {
  const directories: string[] = [];

  afterEach(() => {
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  function project(files: Record<string, string>): string {
    const directory: string = mkdtempSync(join(tmpdir(), 'ormbridge-jpa-'));
    directories.push(directory);
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(directory, path)), { recursive: true });
      writeFileSync(join(directory, path), text);
    }
    return directory;
  }

  const entity = (name: string): string =>
    `package demo;\nimport jakarta.persistence.*;\n@Entity public class ${name} { @Id Long id; }\n`;

  async function convertDirectory(directory: string): Promise<string> {
    const output: string = join(directory, 'out.prisma');
    const result = await runConversion({
      inputs: [directory],
      output,
      from: 'jpa',
      to: 'prisma',
      naming: 'preserve',
      provider: 'postgresql',
      header: false,
      appLabel: 'app',
      autoField: 'int',
    });
    expect(result.ok).toBe(true);
    return readFileSync(output, 'utf8');
  }

  it('reads every .java file and skips build output, tests, generated classes and migrations', async () => {
    const directory: string = project({
      'src/main/java/demo/Thing.java': entity('Thing'),
      'src/main/java/demo/Other.java': entity('Other'),
      'src/main/java/demo/ThingTest.java': entity('FromTest'),
      'src/main/java/demo/ThingTests.java': entity('FromTests'),
      'src/main/java/demo/Thing_.java': entity('Metamodel'),
      'src/main/java/module-info.java': 'module demo { }',
      'src/main/java/demo/package-info.java': 'package demo;',
      'src/test/java/demo/Helper.java': entity('Helper'),
      'src/main/resources/db/migration/V1__init.java': entity('Migration'),
      'target/generated-sources/Gen.java': entity('Generated'),
      'build/classes/Gen2.java': entity('Built'),
      'out/Gen3.java': entity('Out'),
      '.gradle/Gen4.java': entity('Gradle'),
      'node_modules/x/Gen5.java': entity('Modules'),
      'src/main/java/demo/readme.txt': 'not code',
      'src/main/java/demo/notes.kt': 'class Kotlin',
    });
    const text: string = await convertDirectory(directory);
    expect(text).toContain('model Thing');
    expect(text).toContain('model Other');
    for (const skipped of [
      'FromTest',
      'FromTests',
      'Metamodel',
      'Helper',
      'Migration',
      'Generated',
      'Built',
      'Out',
      'Gradle',
      'Modules',
      'Kotlin',
    ]) {
      expect(text, skipped).not.toContain(skipped);
    }
  });

  it('keeps a test or migration directory that is not at the usual place', async () => {
    const directory: string = project({
      'src/main/java/demo/test/Real.java': entity('Real'),
      'src/main/java/demo/migration/Moved.java': entity('Moved'),
    });
    const text: string = await convertDirectory(directory);
    expect(text).toContain('model Real');
    expect(text).toContain('model Moved');
  });

  it('reads a single file given with --from jpa', async () => {
    const directory: string = project({ 'Thing.java': entity('Thing') });
    const result = await runConversion({
      inputs: [join(directory, 'Thing.java')],
      output: join(directory, 'out.prisma'),
      from: 'jpa',
      to: 'prisma',
      naming: 'preserve',
      provider: 'postgresql',
      header: false,
      appLabel: 'app',
      autoField: 'int',
    });
    expect(result.ok).toBe(true);
  });

  it('does not infer the format from .java', async () => {
    const directory: string = project({ 'Thing.java': entity('Thing') });
    const result = await runConversion({
      inputs: [join(directory, 'Thing.java')],
      output: join(directory, 'out.prisma'),
      to: 'prisma',
      naming: 'preserve',
      provider: 'postgresql',
      header: false,
      appLabel: 'app',
      autoField: 'int',
    });
    expect(result.ok).toBe(false);
  });

  it('explains what it expected when a directory has no .java files', async () => {
    const directory: string = project({ 'a.txt': 'x' });
    const result = await runConversion({
      inputs: [directory],
      from: 'jpa',
      to: 'prisma',
      naming: 'preserve',
      provider: 'postgresql',
      header: false,
      appLabel: 'app',
      autoField: 'int',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('NO_INPUT_FILES');
      expect(result.error.message).toContain('.java');
    }
  });

  it('applies the naming mode on top of the JPA names', async () => {
    const directory: string = project({
      'BlogPost.java': `package demo;\nimport jakarta.persistence.*;\n@Entity public class BlogPost { @Id Long id; String createdAt; }\n`,
    });
    const preserved = expectOk(
      await convertText(
        [
          {
            path: join(directory, 'BlogPost.java'),
            text: readFileSync(join(directory, 'BlogPost.java'), 'utf8'),
          },
        ],
        { ...DEFAULT_OPTIONS, from: 'jpa', to: 'sql', naming: 'preserve' }
      )
    );
    const normalized = expectOk(
      await convertText(
        [
          {
            path: join(directory, 'BlogPost.java'),
            text: readFileSync(join(directory, 'BlogPost.java'), 'utf8'),
          },
        ],
        { ...DEFAULT_OPTIONS, from: 'jpa', to: 'sql', naming: 'normalize' }
      )
    );
    // Plain JPA (Hibernate's own strategy) keeps BlogPost and createdAt; normalize writes snake_case.
    expect(preserved.output).toContain('"BlogPost"');
    expect(preserved.output).toContain('"createdAt"');
    expect(normalized.output).toContain('blog_post');
    expect(normalized.output).toContain('created_at');
    expect(normalized.output).not.toContain('BlogPost');
  });
});
