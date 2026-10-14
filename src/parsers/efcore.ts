import type Parser from 'web-tree-sitter';
import type { IrSchema } from '../ir.js';
import { describeThrown, err, ok, type Result } from '../result.js';
import {
  getCSharpParser,
  type ConstLookup,
  type CsClass,
  type CsEnum,
  type CsFile,
  type CsType,
  type CsValue,
} from './csharpSyntax.js';
import { readCSharpFile } from './csharpDeclarations.js';
import {
  hasEntityAnnotations,
  isOwnedByAttribute,
} from './efcoreAnnotations.js';
import { buildSchema, mergeHierarchies } from './efcoreBuild.js';
import { buildEntities, classChain, expandEntities } from './efcoreEntities.js';
import { ConfigStore } from './efcoreFluent.js';
import type { EntityInfo, Project } from './efcoreModel.js';
import { keyOf, resolveRelationships } from './efcoreRelations.js';
import { isKnownScalar, isValueType } from './efcoreTypes.js';

export interface EfcoreSourceFile {
  path: string;
  text: string;
}

export interface EfcoreParseOptions {
  /** App label stored on each model (EF Core has no equivalent). */
  appLabel: string;
}

/** Paths of files EF Core generates or that hold migrations; they describe history, not the model. */
const SKIPPED_PATH: RegExp =
  /(?:^|[\\/])(?:Migrations|bin|obj)[\\/]|\.Designer\.cs$|ModelSnapshot\.cs$/i;

/** True for the migrations folder, build output and the generated Designer and ModelSnapshot files. */
export function isSkippedEfcorePath(path: string): boolean {
  return SKIPPED_PATH.test(path);
}

const CONTEXT_BASE: RegExp = /DbContext$/;

/**
 * Parses Entity Framework Core models (C#) into the shared IR using tree-sitter. The source is only read:
 * nothing is compiled or run, so models built with reflection, loops or computed values are not seen.
 */
export async function parseEfcore(
  sources: EfcoreSourceFile[],
  options: EfcoreParseOptions
): Promise<Result<IrSchema>> {
  const parserResult: Result<Parser> = await getCSharpParser();
  if (!parserResult.ok) {
    return parserResult;
  }
  const trees: Parser.Tree[] = [];
  try {
    return readEfcore(parserResult.value, sources, options, trees);
  } catch (thrown) {
    return err(
      'PARSE_FAILED',
      `Failed to read Entity Framework Core models from ${sources.map((source: EfcoreSourceFile) => source.path).join(', ')}. ` +
        `Underlying error: ${describeThrown(thrown)}`
    );
  } finally {
    for (const tree of trees) {
      tree.delete();
    }
  }
}

function readEfcore(
  parser: Parser,
  sources: EfcoreSourceFile[],
  options: EfcoreParseOptions,
  trees: Parser.Tree[]
): Result<IrSchema> {
  const warnings: string[] = [];
  const files: CsFile[] = [];
  const classes: Map<string, CsClass> = new Map();
  const classOrder: Map<string, number> = new Map();
  const enums: Map<string, CsEnum> = new Map();

  const lookup: ConstLookup = (path: string[]): CsValue | undefined => {
    const name: string | undefined = path[path.length - 1];
    if (name === undefined) {
      return undefined;
    }
    const owner: string | undefined = path[path.length - 2];
    if (owner !== undefined) {
      return classes.get(owner)?.consts.get(name);
    }
    for (const cls of classes.values()) {
      const value: CsValue | undefined = cls.consts.get(name);
      if (value !== undefined) {
        return value;
      }
    }
    return undefined;
  };

  for (const source of sources) {
    if (isSkippedEfcorePath(source.path)) {
      warnings.push(
        `${source.path}: skipped (EF Core migrations, snapshots and build output describe history, not the model).`
      );
      continue;
    }
    const tree: Parser.Tree = parser.parse(source.text);
    trees.push(tree);
    const file: CsFile = readCSharpFile(tree.rootNode, source.path, lookup);
    files.push(file);
    if (file.hasErrors) {
      warnings.push(
        `${source.path}: the file contains C# syntax errors; some classes or properties may be missing from the output.`
      );
    }
    for (const cls of file.classes) {
      const existing: CsClass | undefined = classes.get(cls.name);
      if (existing === undefined) {
        classes.set(cls.name, cls);
        classOrder.set(cls.name, classOrder.size);
      } else if (
        existing.modifiers.includes('partial') &&
        cls.modifiers.includes('partial')
      ) {
        existing.properties.push(...cls.properties);
        existing.methods.push(...cls.methods);
        existing.attributes.push(...cls.attributes);
        existing.bases.push(...cls.bases);
        for (const [name, value] of cls.consts) {
          existing.consts.set(name, value);
        }
      } else {
        warnings.push(
          `Duplicate type name "${cls.name}" (${cls.path}); only the first definition (${existing.path}) was read.`
        );
      }
    }
    for (const declared of file.enums) {
      if (!enums.has(declared.name)) {
        enums.set(declared.name, declared);
      }
    }
  }

  const project: Project = {
    classes,
    enums,
    contexts: [],
    configurations: [],
    dbSets: new Map(),
    nullableReferences: false,
    nullableByPath: new Map(
      files.map((file: CsFile): [string, 'enable' | 'disable' | undefined] => [
        file.path,
        file.nullableDirective,
      ])
    ),
    classOrder,
    warnings,
  };
  const enumNames: ReadonlySet<string> = new Set(enums.keys());
  project.nullableReferences = detectNullableReferences(project, enumNames);
  findContextsAndConfigurations(project);

  const store: ConfigStore = new ConfigStore(
    project,
    lookup,
    (cls: CsClass): CsClass[] => classChain(cls, project)
  );

  // Entities named by DbSet<T> properties come first, in declaration order.
  for (const context of project.contexts) {
    for (const property of context.properties) {
      const set: CsType = property.type;
      if (set.name !== 'DbSet' || set.args.length !== 1) {
        continue;
      }
      const entity: string | undefined = set.args[0]?.name;
      if (entity === undefined) {
        continue;
      }
      if (store.addEntity(entity) === undefined) {
        warnings.push(
          `${context.name}.${property.name}: DbSet<${entity}> refers to a type that is not a class in the input; it was skipped.`
        );
        continue;
      }
      if (!project.dbSets.has(entity)) {
        project.dbSets.set(entity, property.name);
      }
    }
  }
  for (const context of project.contexts) {
    store.runContext(context);
  }
  const unapplied: CsClass[] = store.unappliedConfigurations();
  if (project.contexts.length > 0 && unapplied.length > 0) {
    warnings.push(
      `${unapplied.map((cls: CsClass) => cls.name).join(', ')} implement${unapplied.length === 1 ? 's' : ''} IEntityTypeConfiguration but ${unapplied.length === 1 ? 'is' : 'are'} not applied by an ApplyConfiguration call in the input; ${unapplied.length === 1 ? 'it was' : 'they were'} read anyway.`
    );
  }
  store.applyAllConfigurations();
  for (const { entity } of project.configurations) {
    store.addEntity(entity);
  }
  addAnnotatedEntities(store, project);
  // HasOne<T>() and UsingEntity<T> name entities that no property mentions.
  for (const config of [...store.entities.values()]) {
    for (const rel of config.relations) {
      if (rel.target !== undefined) {
        store.addEntity(rel.target);
      }
    }
  }
  expandEntities(store, project, enumNames);

  const entityInfos: EntityInfo[] = buildEntities(store, project, enumNames);
  if (entityInfos.length === 0) {
    const checkedPaths: string = sources
      .map((source: EfcoreSourceFile) => source.path)
      .join(', ');
    return err(
      'NO_MODELS_FOUND',
      `No Entity Framework Core entities were found in: ${checkedPaths}. An entity is a class used in a DbSet<T> property of a DbContext, ` +
        `named by modelBuilder.Entity<T>() or an IEntityTypeConfiguration<T> class, reached through a navigation property, or ` +
        `marked with an EF Core data annotation such as [Table], [Key], [Index] or [ForeignKey].`
    );
  }
  const roots: EntityInfo[] = mergeHierarchies(entityInfos, (message: string) =>
    warnings.push(message)
  );
  const byName: Map<string, EntityInfo> = new Map();
  for (const info of roots) {
    byName.set(info.name, info);
    for (const derived of info.derived) {
      byName.set(derived, info);
    }
  }
  const relationships = resolveRelationships(
    roots,
    store,
    (name: string): EntityInfo | undefined => byName.get(name),
    (message: string) => warnings.push(message)
  );
  // The join entity of UsingEntity<T> gets the two foreign keys as its composite key unless it names one.
  for (const info of roots) {
    if (info.config.joinEntity === true && keyOf(info).length === 0) {
      const position = (name: string): number =>
        info.members.findIndex(
          (member) => member.kind === 'scalar' && member.name === name
        );
      info.config.key = relationships.links
        .filter((link) => link.dependent === info)
        .flatMap((link) => link.foreignKey)
        .sort((first, second) => position(first) - position(second));
    }
  }
  return ok(buildSchema(roots, relationships, store, project, options));
}

/** Nullable reference types are on when a file says `#nullable enable`, or reference types are written with `?`. */
function detectNullableReferences(
  project: Project,
  enumNames: ReadonlySet<string>
): boolean {
  for (const directive of project.nullableByPath.values()) {
    if (directive === 'enable') {
      return true;
    }
  }
  for (const cls of project.classes.values()) {
    for (const property of cls.properties) {
      const type: CsType = property.type;
      if (
        type.nullable &&
        !isValueType(type, enumNames) &&
        (isKnownScalar({ ...type, nullable: false }, enumNames) ||
          project.classes.has(type.name)) &&
        type.name !== 'Nullable'
      ) {
        return true;
      }
    }
  }
  return false;
}

function findContextsAndConfigurations(project: Project): void {
  const contextNames: Set<string> = new Set();
  let changed: boolean = true;
  while (changed) {
    changed = false;
    for (const cls of project.classes.values()) {
      if (
        !contextNames.has(cls.name) &&
        (cls.bases.some(
          (base: CsType) =>
            CONTEXT_BASE.test(base.name) || contextNames.has(base.name)
        ) ||
          // A context whose base class is not in the input is recognised by its DbSet<T> properties.
          cls.properties.some(
            (property) =>
              property.type.name === 'DbSet' && property.type.args.length === 1
          ))
      ) {
        contextNames.add(cls.name);
        changed = true;
      }
    }
  }
  for (const cls of project.classes.values()) {
    if (contextNames.has(cls.name)) {
      project.contexts.push(cls);
    }
    const configuration: CsType | undefined = cls.bases.find(
      (base: CsType) =>
        base.name === 'IEntityTypeConfiguration' && base.args.length === 1
    );
    const entity: string | undefined = configuration?.args[0]?.name;
    if (entity !== undefined) {
      project.configurations.push({ cls, entity });
    }
  }
}

/** Adds classes that carry EF Core data annotations and are not mapped-superclass or owned types. */
function addAnnotatedEntities(store: ConfigStore, project: Project): void {
  const isBase: Set<string> = new Set();
  for (const cls of project.classes.values()) {
    for (const ancestor of classChain(cls, project).slice(0, -1)) {
      isBase.add(ancestor.name);
    }
  }
  const contextNames: Set<string> = new Set(
    project.contexts.map((cls: CsClass) => cls.name)
  );
  const configNames: Set<string> = new Set(
    project.configurations.map(({ cls }: { cls: CsClass }) => cls.name)
  );
  for (const cls of project.classes.values()) {
    if (
      (cls.kind !== 'class' && cls.kind !== 'record') ||
      cls.modifiers.includes('static') ||
      cls.modifiers.includes('abstract') ||
      contextNames.has(cls.name) ||
      configNames.has(cls.name) ||
      isOwnedByAttribute(cls) ||
      store.ownedTypes.has(cls.name) ||
      cls.attributes.some((item) => item.name === 'NotMapped') ||
      store.ignoredEntities.has(cls.name) ||
      (isBase.has(cls.name) && !store.has(cls.name))
    ) {
      continue;
    }
    if (hasEntityAnnotations(classChain(cls, project))) {
      store.addEntity(cls.name);
    }
  }
}
