import type { IrField, IrModel, IrRelation, IrSchema } from './ir.js';
import { singularize, toPascalCase, toSnakeCase } from './naming.js';

export type NamingMode = 'preserve' | 'normalize';

const CREATED_FIELD_NAMES: ReadonlySet<string> = new Set(['created_at', 'created', 'createdat', 'date_created']);
const UPDATED_FIELD_NAMES: ReadonlySet<string> = new Set([
  'updated_at',
  'updated',
  'updatedat',
  'modified',
  'modified_at',
  'date_updated',
]);

/**
 * Replaces every many-to-many relation with an explicit join model that mirrors the
 * table Django creates (app_post_tags with id, post_id, tag_id and a unique pair).
 * Keeps converted schemas compatible with existing Django databases.
 */
export function expandManyToMany(schema: IrSchema): IrSchema {
  const joinModels: IrModel[] = [];
  const models: IrModel[] = schema.models.map((model: IrModel): IrModel => {
    const keptRelations: IrRelation[] = [];
    for (const relation of model.relations) {
      if (relation.kind !== 'manyToMany') {
        keptRelations.push(relation);
        continue;
      }
      joinModels.push(buildJoinModel(model, relation));
    }
    return { ...model, relations: keptRelations };
  });
  return { ...schema, models: [...models, ...joinModels] };
}

function buildJoinModel(owner: IrModel, relation: IrRelation): IrModel {
  const ownerSnake: string = toSnakeCase(owner.name);
  const targetSnake: string = toSnakeCase(relation.targetModel);
  const isSelfReference: boolean = owner.name === relation.targetModel;
  const fromName: string = isSelfReference ? `from_${ownerSnake}` : ownerSnake;
  const toName: string = isSelfReference ? `to_${targetSnake}` : targetSnake;

  return {
    name: `${owner.name}${toPascalCase(relation.name)}`,
    tableName: `${owner.tableName}_${relation.name}`,
    appLabel: owner.appLabel,
    isJoinTable: true,
    fields: [
      {
        name: 'id',
        columnName: 'id',
        type: 'int',
        isPrimaryKey: true,
        isUnique: false,
        isNullable: false,
        isAutoUpdated: false,
        default: { kind: 'autoIncrement' },
      },
    ],
    relations: [
      {
        name: fromName,
        kind: 'foreignKey',
        targetModel: owner.name,
        columnName: `${fromName}_id`,
        isNullable: false,
        onDelete: 'cascade',
        relatedName: relation.name,
      },
      {
        name: toName,
        kind: 'foreignKey',
        targetModel: relation.targetModel,
        columnName: `${toName}_id`,
        isNullable: false,
        onDelete: 'cascade',
        relatedName: relation.relatedName ?? `${ownerSnake}_${relation.name}`,
      },
    ],
    indexes: [{ fields: [fromName, toName], isUnique: true }],
  };
}

/**
 * Applies a fresh-schema style: singular snake_case table names, UUID primary keys in place of
 * auto-increment ids, snake_case columns, and created_at / updated_at timestamps where missing.
 */
export function normalizeSchema(schema: IrSchema): IrSchema {
  return { ...schema, models: schema.models.map(normalizeModel) };
}

function normalizeModel(model: IrModel): IrModel {
  const fields: IrField[] = model.fields.map(normalizeField);

  if (model.isJoinTable !== true) {
    const hasCreated: boolean = fields.some((field: IrField) => CREATED_FIELD_NAMES.has(field.name.toLowerCase()));
    const hasUpdated: boolean = fields.some(
      (field: IrField) => field.isAutoUpdated || UPDATED_FIELD_NAMES.has(field.name.toLowerCase()),
    );
    if (!hasCreated) {
      fields.push({
        name: 'created_at',
        columnName: 'created_at',
        type: 'dateTime',
        isPrimaryKey: false,
        isUnique: false,
        isNullable: false,
        isAutoUpdated: false,
        default: { kind: 'now' },
      });
    }
    if (!hasUpdated) {
      fields.push({
        name: 'updated_at',
        columnName: 'updated_at',
        type: 'dateTime',
        isPrimaryKey: false,
        isUnique: false,
        isNullable: false,
        isAutoUpdated: true,
      });
    }
  }

  return {
    ...model,
    tableName: singularize(toSnakeCase(model.name)),
    fields,
    relations: model.relations.map((relation: IrRelation) => ({
      ...relation,
      columnName: toSnakeCase(relation.columnName),
    })),
  };
}

function normalizeField(field: IrField): IrField {
  const normalized: IrField = { ...field, columnName: toSnakeCase(field.columnName) };
  const isAutoIncrementKey: boolean =
    field.isPrimaryKey &&
    field.default !== undefined &&
    field.default.kind === 'autoIncrement' &&
    (field.type === 'int' || field.type === 'bigInt');
  if (isAutoIncrementKey) {
    return { ...normalized, type: 'uuid', default: { kind: 'uuid' } };
  }
  return normalized;
}
