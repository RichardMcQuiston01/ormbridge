import type {
  IrCompositeForeignKey,
  IrEnum,
  IrIndex,
  IrModel,
  IrRelation,
  IrSchema,
} from '../src/ir.js';
import { toSnakeCase } from '../src/naming.js';

function escapePattern(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The top-level blocks of the generated module (classes, tables), split on the blank lines between them. */
function blocksOf(text: string): string[] {
  return text.split(/\n\n\n(?=\S)/);
}

function quoted(value: string): string {
  return JSON.stringify(value);
}

/** True when the class block writes the column, as an attribute named like it or with its name as the first argument. */
function hasColumn(block: string, column: string): boolean {
  const attribute: string = toSnakeCase(column);
  return (
    new RegExp(`^ {4}${escapePattern(attribute)}_?: `, 'm').test(block) ||
    block.includes(`("${column}"`) ||
    block.includes(`    "name": ${quoted(column)}`) ||
    block.includes(`"name": ${quoted(column)}`)
  );
}

/**
 * A structural check of generated SQLAlchemy code (the default `sqlalchemy` style, "preserve"
 * naming) against the IR it came from. The conversion matrix cannot compare IRs of a format it
 * cannot read; this lists what is missing instead: a model without a class and `__tablename__`,
 * a column, foreign key or relationship that was not written, a many-to-many relation without its
 * association table, a missing index or constraint, and an enum without its class or values. An
 * empty result means the output covers the IR.
 */
export function checkSqlAlchemyOutput(
  schema: IrSchema,
  files: Record<string, string>
): string[] {
  const text: string = Object.values(files).join('\n');
  if (text === '') {
    return ['no output'];
  }
  const missing: string[] = [];
  if (!/^class Base\(DeclarativeBase\):/m.test(text)) {
    missing.push('no Base(DeclarativeBase) class');
  }
  const blocks: string[] = blocksOf(text);
  for (const model of schema.models) {
    if (model.isView === true) {
      if (!text.includes(`# View ${model.name} (`)) {
        missing.push(`${model.name}: no view placeholder`);
      }
      continue;
    }
    missing.push(...checkModel(text, blocks, schema, model));
  }
  for (const enumDefinition of schema.enums) {
    missing.push(...checkEnum(text, enumDefinition));
  }
  return missing;
}

function checkModel(
  text: string,
  blocks: string[],
  schema: IrSchema,
  model: IrModel
): string[] {
  const block: string | undefined = blocks.find((candidate: string) =>
    candidate.includes(`__tablename__ = ${quoted(model.tableName)}`)
  );
  if (block === undefined) {
    return [`${model.name}: no class for table ${model.tableName}`];
  }
  const missing: string[] = [];
  for (const field of model.fields) {
    if (!hasColumn(block, field.columnName)) {
      missing.push(`${model.name}: no column ${field.columnName}`);
    }
  }
  for (const relation of model.relations) {
    missing.push(...checkRelation(text, schema, model, block, relation));
  }
  for (const key of model.compositeForeignKeys ?? []) {
    missing.push(...checkCompositeKey(model, block, key));
  }
  if (
    model.compositePrimaryKey !== undefined &&
    !block.includes('PrimaryKeyConstraint(')
  ) {
    missing.push(`${model.name}: no PrimaryKeyConstraint`);
  }
  for (const index of model.indexes) {
    missing.push(...checkIndex(model, block, index));
  }
  return missing;
}

function checkRelation(
  text: string,
  schema: IrSchema,
  model: IrModel,
  block: string,
  relation: IrRelation
): string[] {
  const label: string = `${model.name}.${relation.name}`;
  if (relation.kind === 'manyToMany') {
    const table: string = `${model.tableName}_${relation.name}`;
    const missing: string[] = [];
    if (
      !new RegExp(`= Table\\(\\s*${escapePattern(quoted(table))},`).test(text)
    ) {
      missing.push(`${label}: no association table ${table}`);
    }
    if (!/secondary=/.test(block)) {
      missing.push(`${label}: no relationship with secondary=`);
    }
    return missing;
  }
  const target: IrModel | undefined = schema.models.find(
    (candidate: IrModel) => candidate.name === relation.targetModel
  );
  if (target === undefined || target.isView === true) {
    // Nothing to point at: the column is written without a ForeignKey.
    return hasColumn(block, relation.columnName)
      ? []
      : [`${label}: no column ${relation.columnName}`];
  }
  const missing: string[] = [];
  if (!hasColumn(block, relation.columnName)) {
    missing.push(`${label}: no column ${relation.columnName}`);
  }
  if (
    !new RegExp(`ForeignKey\\(\\s*"${escapePattern(target.tableName)}\\.`).test(
      block
    )
  ) {
    missing.push(`${label}: no ForeignKey to ${target.tableName}`);
  }
  if (!new RegExp(`relationship\\(`).test(block)) {
    missing.push(`${label}: no relationship()`);
  }
  if (!/back_populates=/.test(block)) {
    missing.push(`${label}: no back_populates`);
  }
  return missing;
}

function checkCompositeKey(
  model: IrModel,
  block: string,
  key: IrCompositeForeignKey
): string[] {
  const missing: string[] = [];
  if (!block.includes('ForeignKeyConstraint(')) {
    missing.push(`${model.name}.${key.name}: no ForeignKeyConstraint`);
  }
  return missing;
}

function checkIndex(model: IrModel, block: string, index: IrIndex): string[] {
  const label: string = `${model.name} index (${index.fields.join(', ')})`;
  const opener: string = index.isUnique ? 'UniqueConstraint(' : 'Index(';
  if (!block.includes(opener)) {
    return [`${label}: no ${opener.slice(0, -1)}`];
  }
  return [];
}

function checkEnum(text: string, enumDefinition: IrEnum): string[] {
  const name: string = escapePattern(enumDefinition.name);
  const match: RegExpExecArray | null = new RegExp(
    `^class ${name}\\(enum\\.Enum\\):\\n((?: {4}.*\\n?)*)`,
    'm'
  ).exec(text);
  if (match === null) {
    return [`enum ${enumDefinition.name}: no enum.Enum class`];
  }
  const body: string = match[1] ?? '';
  const missing: string[] = [];
  for (const value of enumDefinition.values) {
    if (!body.includes(` = ${quoted(value.dbValue)}`)) {
      missing.push(
        `enum ${enumDefinition.name}: no member for ${value.dbValue}`
      );
    }
  }
  return missing;
}
