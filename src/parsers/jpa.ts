import type Parser from 'web-tree-sitter';
import type { IrSchema } from '../ir.js';
import { describeThrown, err, ok, type Result } from '../result.js';
import {
  getJavaParser,
  readJavaFile,
  type ConstLookup,
  type JavaClass,
  type JavaFile,
  type JavaType,
  type SyntaxNode,
} from './javaSyntax.js';
import { Annotated } from './jpaAnnotations.js';
import { buildSchema } from './jpaBuild.js';
import { discoverEntities } from './jpaEntities.js';
import type { ConverterInfo, EntityInfo, Project } from './jpaModel.js';

export interface JpaSourceFile {
  path: string;
  text: string;
}

export interface JpaParseOptions {
  /** App label stored on each model (JPA has no equivalent). */
  appLabel: string;
}

/**
 * Paths of files that are not the model: build output, test sources, generated metamodels, module descriptors and
 * database migrations.
 */
const SKIPPED_PATH: RegExp =
  /(?:^|[\\/])(?:target|build|out|\.gradle|node_modules|\.git)[\\/]|(?:^|[\\/])src[\\/]test[\\/]|(?:^|[\\/])db[\\/]migrations?[\\/]|(?:Tests?|_)\.java$|(?:^|[\\/])(?:module|package)-info\.java$/;

/** True for build output, tests, generated metamodel classes, `module-info.java`, `package-info.java` and migrations. */
export function isSkippedJpaPath(path: string): boolean {
  return SKIPPED_PATH.test(path);
}

/**
 * Parses Hibernate / JPA entities (Java) into the shared IR using tree-sitter. The source is only read: nothing is
 * compiled or run, and `persistence.xml` and `orm.xml` are not read.
 */
export async function parseJpa(
  sources: JpaSourceFile[],
  options: JpaParseOptions
): Promise<Result<IrSchema>> {
  const parserResult: Result<Parser> = await getJavaParser();
  if (!parserResult.ok) {
    return parserResult;
  }
  const trees: Parser.Tree[] = [];
  try {
    return readJpa(parserResult.value, sources, options, trees);
  } catch (thrown) {
    return err(
      'PARSE_FAILED',
      `Failed to read Hibernate / JPA entities from ${sources.map((source: JpaSourceFile) => source.path).join(', ')}. ` +
        `Underlying error: ${describeThrown(thrown)}`
    );
  } finally {
    for (const tree of trees) {
      tree.delete();
    }
  }
}

function readJpa(
  parser: Parser,
  sources: JpaSourceFile[],
  options: JpaParseOptions,
  trees: Parser.Tree[]
): Result<IrSchema> {
  const warnings: string[] = [];
  const classes: Map<string, JavaClass> = new Map();
  const enums: Map<string, JavaClass> = new Map();
  const files: JavaFile[] = [];
  for (const source of sources) {
    if (isSkippedJpaPath(source.path)) {
      warnings.push(
        `${source.path}: skipped (build output, tests, generated metamodels, module descriptors and migrations are not the model).`
      );
      continue;
    }
    const tree: Parser.Tree = parser.parse(source.text);
    trees.push(tree);
    const file: JavaFile = readJavaFile(tree.rootNode, source.path);
    files.push(file);
    if (file.hasErrors) {
      warnings.push(
        `${source.path}: the file contains Java syntax errors; some classes or fields may be missing from the output.`
      );
    }
    for (const cls of file.classes) {
      const target: Map<string, JavaClass> =
        cls.kind === 'enum' ? enums : classes;
      const existing: JavaClass | undefined = target.get(cls.name);
      if (existing === undefined) {
        target.set(cls.name, cls);
      } else if (existing.path !== cls.path || existing.outer !== cls.outer) {
        warnings.push(
          `Duplicate type name "${cls.name}" (${cls.path}); only the first definition (${existing.path}) was read.`
        );
      }
    }
  }

  const lookup: ConstLookup = (path: string[]): SyntaxNode | undefined => {
    const name: string | undefined = path[path.length - 1];
    if (name === undefined) {
      return undefined;
    }
    const owner: string | undefined = path[path.length - 2];
    const candidates: JavaClass[] =
      owner === undefined
        ? [...classes.values(), ...enums.values()]
        : [classes.get(owner), enums.get(owner)].flatMap(
            (item: JavaClass | undefined): JavaClass[] =>
              item === undefined ? [] : [item]
          );
    for (const cls of candidates) {
      const field = cls.fields.find(
        (item) =>
          item.name === name &&
          item.modifiers.includes('static') &&
          item.modifiers.includes('final')
      );
      if (field?.initializer !== undefined) {
        return field.initializer;
      }
    }
    return undefined;
  };

  const project: Project = {
    classes,
    enums,
    converters: new Map(),
    lookup,
    warnings,
    appLabel: options.appLabel,
  };
  findConverters(project);
  const warn = (message: string): void => {
    warnings.push(message);
  };
  const entities: EntityInfo[] = discoverEntities(project, warn).filter(
    (entity: EntityInfo): boolean => {
      if (entity.notes.has('Subselect', true)) {
        warn(
          `${entity.name}: @Subselect maps a SQL query, not a table; the entity was skipped.`
        );
        return false;
      }
      return true;
    }
  );
  if (entities.length === 0) {
    return err(
      'NO_MODELS_FOUND',
      `No JPA entities were found in: ${sources.map((source: JpaSourceFile) => source.path).join(', ')}. ` +
        `An entity is a class annotated with @Entity (jakarta.persistence or javax.persistence). ` +
        `Mapping in orm.xml or persistence.xml is not read.`
    );
  }
  return ok(buildSchema(project, entities));
}

/** Finds `AttributeConverter<X, Y>` classes so `@Convert` can say which column type they produce. */
function findConverters(project: Project): void {
  for (const cls of project.classes.values()) {
    const base: JavaType | undefined = cls.interfaces.find(
      (item: JavaType) => item.name === 'AttributeConverter'
    );
    const attributeType: JavaType | undefined = base?.args[0];
    const columnType: JavaType | undefined = base?.args[1];
    if (attributeType === undefined || columnType === undefined) {
      continue;
    }
    const info: ConverterInfo = {
      name: cls.name,
      attributeType,
      columnType,
      autoApply:
        new Annotated(cls.annotations, project.lookup, cls.imports)
          .get('Converter')
          ?.boolean('autoApply') === true,
    };
    project.converters.set(cls.name, info);
  }
}
