import type { IrHierarchy, IrHierarchyClass, IrModel, IrField } from '../ir.js';
import type { Ann } from './jpaAnnotations.js';
import type { BuiltField } from './jpaColumns.js';
import type { RelationOutput } from './jpaJoins.js';
import type { EntityInfo } from './jpaModel.js';

function descendants(
  entity: EntityInfo,
  seen: Set<EntityInfo> = new Set([entity])
): EntityInfo[] {
  return entity.children.flatMap((child: EntityInfo): EntityInfo[] => {
    if (seen.has(child)) {
      return [];
    }
    seen.add(child);
    return [child, ...descendants(child, seen)];
  });
}

/** The discriminator value of an entity: `@DiscriminatorValue`, else the entity name. */
function discriminatorValue(entity: EntityInfo): string {
  return (
    entity.notes.get('DiscriminatorValue')?.string('value') ?? entity.entityName
  );
}

/** The names of the fields and relations an entity declares, read from the members of a table that contains it. */
function declaredBy(
  entity: EntityInfo,
  table: EntityInfo,
  built: ReadonlyMap<EntityInfo, BuiltField[]>,
  outputs: ReadonlyMap<EntityInfo, RelationOutput>
): { fields: string[]; relations: string[] } {
  return {
    fields: (built.get(table) ?? [])
      .filter((item: BuiltField) => item.member.ownedBy === entity.name)
      .map((item: BuiltField) => item.field.name),
    relations: (outputs.get(table)?.relations ?? [])
      .filter((placed) => placed.ownedBy === entity.name)
      .map((placed) => placed.relation.name),
  };
}

/**
 * Records the hierarchies that the models flatten: single table (one model holding the columns of every class) and
 * table per class (one model per concrete class, each with the inherited columns). The models are unchanged; this says
 * which class declares which field and relation, for a writer that has inheritance.
 */
export function buildHierarchies(
  entities: readonly EntityInfo[],
  models: ReadonlyMap<EntityInfo, IrModel>,
  built: ReadonlyMap<EntityInfo, BuiltField[]>,
  outputs: ReadonlyMap<EntityInfo, RelationOutput>
): IrHierarchy[] {
  const hierarchies: IrHierarchy[] = [];
  for (const root of entities) {
    if (root.root !== root || root.children.length === 0) {
      continue;
    }
    const members: EntityInfo[] = [root, ...descendants(root)];
    if (root.inheritance === 'singleTable') {
      const model: IrModel | undefined = models.get(root);
      if (model === undefined) {
        continue;
      }
      const classes: IrHierarchyClass[] = members.map(
        (entity: EntityInfo): IrHierarchyClass => ({
          name: entity.name,
          ...(entity.parent === undefined
            ? {}
            : { parent: entity.parent.name }),
          ...(entity.isAbstract ? { isAbstract: true } : {}),
          discriminatorValue: discriminatorValue(entity),
          ...declaredBy(entity, root, built, outputs),
        })
      );
      const column: Ann | undefined = root.notes.get('DiscriminatorColumn');
      const columnName: string = column?.string('name') || 'DTYPE';
      const kind: string = column?.member('discriminatorType') ?? 'STRING';
      const field: IrField | undefined = model.fields.find(
        (item: IrField) => item.columnName === columnName
      );
      hierarchies.push({
        strategy: 'singleTable',
        classes,
        ...(field === undefined
          ? {}
          : {
              discriminator: {
                field: field.name,
                column: columnName,
                type:
                  kind === 'INTEGER'
                    ? ('int' as const)
                    : kind === 'CHAR'
                      ? ('char' as const)
                      : ('string' as const),
                ...(kind === 'STRING'
                  ? { length: column?.number('length') ?? 31 }
                  : {}),
              },
            }),
      });
    } else if (root.inheritance === 'tablePerClass') {
      const classes: IrHierarchyClass[] = members.map(
        (entity: EntityInfo): IrHierarchyClass => {
          // Every concrete class at or below this one has a table with the columns this class declares.
          const table: EntityInfo | undefined = [
            entity,
            ...descendants(entity),
          ].find((candidate: EntityInfo) => models.has(candidate));
          return {
            name: entity.name,
            ...(entity.parent === undefined
              ? {}
              : { parent: entity.parent.name }),
            ...(entity.isAbstract ? { isAbstract: true } : {}),
            ...(table === undefined
              ? { fields: [], relations: [] }
              : declaredBy(entity, table, built, outputs)),
          };
        }
      );
      hierarchies.push({ strategy: 'tablePerClass', classes });
    }
  }
  return hierarchies;
}
