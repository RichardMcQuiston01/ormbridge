import type {
  IrEnum,
  IrField,
  IrIndex,
  IrModel,
  IrRelation,
  IrSchema,
} from '../ir.js';
import { buildCollection } from './jpaCollections.js';
import { entityMembers } from './jpaEntities.js';
import {
  buildField,
  cleanIdentifier,
  columnNameOf,
  irFieldName,
  type BuiltField,
} from './jpaColumns.js';
import { buildIndexes, type IndexResult } from './jpaIndexes.js';
import type { EntityInfo, Member, Project } from './jpaModel.js';
import {
  joinPairs,
  modelOwner,
  tableNameOf,
  type KeyColumn,
  type PlacedRelation,
  type RelationOutput,
  type Resolver,
} from './jpaJoins.js';
import { resolveRelations } from './jpaRelations.js';
import { inheritanceNotes, tableNotes } from './jpaNotes.js';

/** True when an entity has a table of its own (single-table subclasses and abstract table-per-class roots do not). */
function hasTable(entity: EntityInfo): boolean {
  if (entity.inheritance === 'singleTable' && entity.root !== entity) {
    return false;
  }
  return !(entity.inheritance === 'tablePerClass' && entity.isAbstract);
}

/** Assembles the IR from the entities of the input. */
export function buildSchema(
  project: Project,
  entities: readonly EntityInfo[]
): IrSchema {
  const warn = (message: string): void => {
    project.warnings.push(message);
  };
  for (const entity of entities) {
    entity.members = entityMembers(project, entity, warn);
  }
  const byName: Map<string, EntityInfo> = new Map(
    entities.map((entity: EntityInfo): [string, EntityInfo] => [
      entity.name,
      entity,
    ])
  );
  const tables: EntityInfo[] = entities.filter(hasTable);
  const built: Map<EntityInfo, BuiltField[]> = new Map();

  const resolver: Resolver = {
    project,
    entities: byName,
    warn,
    fieldsOf: (entity: EntityInfo): readonly BuiltField[] =>
      built.get(modelOwner(entity)) ?? [],
    keyOf: (entity: EntityInfo): KeyColumn[] => keyColumns(entity, resolver, 0),
  };

  // Columns ------------------------------------------------------------------------------------
  for (const entity of tables) {
    const keyCount: number = entity.members.filter(
      (member: Member) => member.isId
    ).length;
    built.set(
      entity,
      entity.members
        .filter((member: Member) => member.kind === 'basic')
        .map((member: Member) =>
          buildField(member, { project, entity, warn }, keyCount === 1)
        )
    );
  }

  // Models --------------------------------------------------------------------------------------
  const models: Map<EntityInfo, IrModel> = new Map();
  const outputs: Map<EntityInfo, RelationOutput> = new Map();
  const enums: Map<string, IrEnum> = new Map();
  const relationOf: Map<string, IrRelation> = new Map();
  const inverse: RelationOutput['inverse'] = [];
  const foreign: RelationOutput['foreign'] = [];
  for (const entity of tables) {
    const output: RelationOutput = resolveRelations(
      entity,
      entity.members,
      resolver
    );
    outputs.set(entity, output);
    inverse.push(...output.inverse);
    foreign.push(...output.foreign);
  }
  const taken: Set<string> = new Set(entities.map((entity) => entity.name));
  const extraModels: IrModel[] = [];
  for (const entity of tables) {
    const output: RelationOutput | undefined = outputs.get(entity);
    const fieldsBuilt: BuiltField[] = built.get(entity) ?? [];
    if (output === undefined) {
      continue;
    }
    const model: IrModel = assemble(
      entity,
      fieldsBuilt,
      output,
      resolver,
      enums
    );
    models.set(entity, model);
    for (const placed of output.relations) {
      relationOf.set(`${entity.name}.${placed.relation.name}`, placed.relation);
    }
    for (const member of entity.members) {
      if (member.kind !== 'collection') {
        continue;
      }
      const collection = buildCollection(
        entity,
        member,
        project,
        resolver,
        taken
      );
      if (collection !== undefined) {
        taken.add(collection.model.name);
        extraModels.push(collection.model);
        if (collection.enumDefinition !== undefined) {
          enums.set(collection.enumDefinition.name, collection.enumDefinition);
        }
      }
    }
  }
  for (const { model: owner, relation } of foreign) {
    const model: IrModel | undefined = models.get(owner);
    if (model === undefined) {
      continue;
    }
    let name: string = relation.name;
    while (
      model.fields.some((field: IrField) => field.name === name) ||
      model.relations.some((item: IrRelation) => item.name === name)
    ) {
      name = `${name}Ref`;
    }
    const placed: IrRelation = { ...relation, name };
    model.relations.push(placed);
    relationOf.set(`${owner.name}.${name}`, placed);
  }
  for (const link of inverse) {
    const owning: IrRelation | undefined = relationOf.get(
      `${link.model.name}.${link.attribute}`
    );
    if (owning === undefined) {
      project.warnings.push(
        `${link.model.name}: mappedBy = "${link.attribute}" (declared as ${link.relatedName}) names no relationship of ${link.model.name} in the input; the inverse side was not linked.`
      );
    } else if (owning.relatedName === undefined) {
      owning.relatedName = link.relatedName;
    }
  }
  return {
    models: [...models.values(), ...extraModels],
    enums: [...enums.values()],
    warnings: project.warnings,
  };
}

/** The primary key columns of an entity's table. */
function keyColumns(
  entity: EntityInfo,
  resolver: Resolver,
  depth: number
): KeyColumn[] {
  const table: EntityInfo = modelOwner(entity);
  if (
    table.inheritance === 'joined' &&
    table.parent !== undefined &&
    depth < 8
  ) {
    const parentKeys: KeyColumn[] = keyColumns(
      table.parent,
      resolver,
      depth + 1
    );
    const joinColumn: string | undefined = table.notes
      .get('PrimaryKeyJoinColumn')
      ?.string('name');
    return parentKeys.map((key: KeyColumn): KeyColumn =>
      parentKeys.length === 1 && joinColumn
        ? { ...key, columnName: cleanIdentifier(joinColumn) }
        : key
    );
  }
  const keys: KeyColumn[] = [];
  for (const member of table.members) {
    if (!member.isId) {
      continue;
    }
    if (member.kind === 'relation' && depth < 8) {
      const target = resolver.entities.get(member.attr.type.name);
      const pairs =
        target === undefined
          ? undefined
          : joinPairs(
              member,
              target,
              resolver,
              `${table.name}.${member.attr.name}`
            );
      if (pairs !== undefined) {
        keys.push(
          ...pairs.map((pair) => ({
            name: irFieldName(member),
            columnName: pair.columnName,
          }))
        );
      }
    } else if (member.kind === 'basic') {
      keys.push({
        name: irFieldName(member),
        columnName: columnNameOf(member),
      });
    }
  }
  return keys;
}

function recordEnum(
  enums: Map<string, IrEnum>,
  item: BuiltField,
  place: string,
  warn: (message: string) => void
): void {
  const definition: IrEnum | undefined = item.enumDefinition;
  if (definition === undefined) {
    return;
  }
  const known: IrEnum | undefined = enums.get(definition.name);
  if (known === undefined) {
    enums.set(definition.name, definition);
    return;
  }
  if (
    known.values.some(
      (value, index) => value.dbValue !== definition.values[index]?.dbValue
    )
  ) {
    warn(
      `${place}: the enum ${definition.name} is stored differently in different columns (name and ordinal); the IR keeps one definition, with the names.`
    );
    if (definition.values.every((value) => value.dbValue === value.name)) {
      enums.set(definition.name, definition);
    }
  }
}

function assemble(
  entity: EntityInfo,
  built: readonly BuiltField[],
  output: RelationOutput,
  resolver: Resolver,
  enums: Map<string, IrEnum>
): IrModel {
  const warn = resolver.warn;
  const placed: PlacedRelation[] = [...output.relations];

  // A read-only copy of a column (insertable = false, updatable = false) is the relationship's column.
  const columnsTaken: Set<string> = new Set(
    placed.map((item: PlacedRelation) => item.relation.columnName.toLowerCase())
  );
  const kept: BuiltField[] = [];
  for (const item of built) {
    const path: string = item.member.path.join('.');
    const consumedBy: string | undefined = output.consumed.get(path);
    if (consumedBy !== undefined) {
      continue;
    }
    const column: string = item.field.columnName.toLowerCase();
    if (item.readOnly && columnsTaken.has(column)) {
      continue;
    }
    if (kept.some((other) => other.field.columnName.toLowerCase() === column)) {
      warn(
        `${entity.name}.${path}: another attribute already maps the column "${item.field.columnName}"; this one was skipped.`
      );
      continue;
    }
    kept.push(item);
    columnsTaken.add(column);
    recordEnum(enums, item, `${entity.name}.${path}`, warn);
  }
  const fields: IrField[] = [
    ...kept.map((item: BuiltField) => item.field),
    ...output.extraFields,
  ];
  // Inheritance --------------------------------------------------------------------------------------
  const extra = inheritanceNotes(entity, fields, resolver);

  // Primary key --------------------------------------------------------------------------------------
  const keyMembers: Member[] = entity.members.filter(
    (member: Member) => member.isId
  );
  const names: string[] = keyMembers.flatMap((member: Member): string[] => {
    const via: string | undefined = output.consumed.get(member.path.join('.'));
    return [via ?? irFieldName(member)];
  });
  const keyNames: string[] = [...new Set(names)];
  let compositePrimaryKey: string[] | undefined;
  if (extra.primaryKeyRelation !== undefined) {
    // Joined inheritance: the key is the foreign key to the parent table.
  } else if (keyNames.length === 0) {
    warn(
      `${entity.name}: the entity has no @Id (or @EmbeddedId); other formats expect every model to have a primary key.`
    );
  } else if (keyNames.length > 1) {
    compositePrimaryKey = keyNames;
    for (const item of kept) {
      if (keyNames.includes(item.field.name)) {
        item.field.isPrimaryKey = false;
      }
    }
  }
  const relationItems: PlacedRelation[] = placed;
  for (const item of relationItems) {
    if (compositePrimaryKey !== undefined) {
      delete item.relation.isPrimaryKey;
    } else if (keyNames.length === 1 && keyNames[0] === item.relation.name) {
      item.relation.isPrimaryKey = true;
    }
  }
  for (const item of kept) {
    if (keyNames.length === 1 && keyNames[0] === item.field.name) {
      item.field.isPrimaryKey = true;
    }
  }

  // Indexes ------------------------------------------------------------------------------------------
  const nameOf: Map<string, string> = new Map();
  for (const field of fields) {
    nameOf.set(field.columnName.toLowerCase(), field.name);
    nameOf.set(field.name, field.name);
  }
  for (const item of relationItems) {
    nameOf.set(item.relation.columnName.toLowerCase(), item.relation.name);
    nameOf.set(item.relation.name, item.relation.name);
  }
  const naturalIds: string[] = kept
    .filter((item: BuiltField) => item.naturalId)
    .map((item: BuiltField) => item.field.name);
  const indexResult: IndexResult = buildIndexes(
    entity,
    nameOf,
    naturalIds,
    warn
  );
  for (const field of fields) {
    if (indexResult.uniqueFields.has(field.name) && !field.isPrimaryKey) {
      field.isUnique = true;
    }
  }
  const indexes: IrIndex[] = indexResult.indexes;

  tableNotes(entity, kept, warn);
  const schema: string | undefined = entity.notes
    .get('Table')
    ?.string('schema');
  const model: IrModel = {
    name: entity.name,
    tableName: tableNameOf(entity),
    appLabel: resolver.project.appLabel,
    fields: [...extra.leadingFields, ...fields, ...extra.trailingFields],
    relations: [
      ...extra.relations,
      ...relationItems
        .sort((first, second) => first.order - second.order)
        .map((item: PlacedRelation) => item.relation),
    ],
    indexes,
    ...(compositePrimaryKey === undefined ? {} : { compositePrimaryKey }),
    ...(output.composite.length === 0
      ? {}
      : { compositeForeignKeys: output.composite }),
    ...(schema === undefined || schema === '' ? {} : { schema }),
  };
  return model;
}
