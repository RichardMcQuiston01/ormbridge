import type {
  IrCompositeForeignKey,
  IrDefault,
  IrField,
  IrIndex,
  IrModel,
  IrRelation,
  IrSchema,
} from '../src/ir.js';

/**
 * A readable, stable summary of a schema (tables, columns, keys, indexes, enums and warnings) for the golden
 * files of the tests that replay migrations.
 */

function describeDefault(value: IrDefault): string {
  switch (value.kind) {
    case 'literal':
      return JSON.stringify(value.value);
    case 'enumValue':
      return `enum ${value.value}`;
    case 'dbExpression':
      return `expr ${value.expression}`;
    case 'clientGenerated':
      return `client ${value.generator}`;
    default:
      return value.kind;
  }
}

function describeField(field: IrField): string {
  const size: string =
    field.maxLength !== undefined
      ? `(${field.maxLength})`
      : field.maxDigits !== undefined
        ? `(${field.maxDigits},${field.decimalPlaces ?? 0})`
        : '';
  const parts: string[] = [
    `${field.columnName} ${field.type}${size}${field.arrayDepth === undefined ? '' : '[]'}`,
    field.isNullable ? 'null' : 'not null',
  ];
  if (field.isPrimaryKey) {
    parts.push('pk');
  }
  if (field.isUnique) {
    parts.push(
      field.uniqueName === undefined ? 'unique' : `unique ${field.uniqueName}`
    );
  }
  if (field.default !== undefined) {
    parts.push(`default ${describeDefault(field.default)}`);
  }
  if (field.enumName !== undefined) {
    parts.push(`enum ${field.enumName}`);
  }
  if (field.generated !== undefined) {
    parts.push(`generated ${field.generated.expression}`);
  }
  if (field.unsupportedType !== undefined) {
    parts.push(`type ${field.unsupportedType}`);
  }
  return parts.join(', ');
}

function describeRelation(relation: IrRelation): string {
  return [
    `${relation.kind} ${relation.name} (${relation.columnName}) -> ${relation.targetModel}${relation.toField === undefined ? '' : `.${relation.toField}`}`,
    `on delete ${relation.onDelete}`,
    ...(relation.constraintName === undefined
      ? []
      : [`constraint ${relation.constraintName}`]),
  ].join(', ');
}

function describeComposite(key: IrCompositeForeignKey): string {
  return `composite ${key.name} (${key.fields.join(', ')}) -> ${key.targetModel} (${key.references.join(', ')}), on delete ${key.onDelete}${key.constraintName === undefined ? '' : `, constraint ${key.constraintName}`}`;
}

function describeIndex(index: IrIndex): string {
  const options: string[] = Object.entries(index.fieldOptions ?? {}).map(
    ([name, value]) => `${name} ${JSON.stringify(value)}`
  );
  return `index ${index.name ?? '(unnamed)'} (${index.fields.join(', ')})${index.isUnique ? ' unique' : ''}${index.kind === undefined ? '' : ` ${index.kind}`}${index.method === undefined ? '' : ` using ${index.method}`}${options.length === 0 ? '' : ` [${options.join('; ')}]`}`;
}

export function summarizeSchema(schema: IrSchema): string {
  const lines: string[] = [];
  const models: IrModel[] = [...schema.models].sort(
    (left: IrModel, right: IrModel) =>
      left.tableName.localeCompare(right.tableName)
  );
  for (const model of models) {
    lines.push(
      `table ${model.tableName}${model.primaryKeyName === undefined ? '' : ` (pk ${model.primaryKeyName})`}`
    );
    for (const field of model.fields) {
      lines.push(`  column ${describeField(field)}`);
    }
    if (model.compositePrimaryKey !== undefined) {
      lines.push(`  primary key (${model.compositePrimaryKey.join(', ')})`);
    }
    for (const relation of model.relations) {
      lines.push(`  ${describeRelation(relation)}`);
    }
    for (const key of model.compositeForeignKeys ?? []) {
      lines.push(`  ${describeComposite(key)}`);
    }
    for (const index of model.indexes) {
      lines.push(`  ${describeIndex(index)}`);
    }
  }
  for (const enumType of schema.enums) {
    lines.push(
      `enum ${enumType.name}: ${enumType.values.map((value) => value.dbValue).join(', ')}`
    );
  }
  for (const warning of schema.warnings) {
    lines.push(`warning: ${warning}`);
  }
  return lines.join('\n');
}
