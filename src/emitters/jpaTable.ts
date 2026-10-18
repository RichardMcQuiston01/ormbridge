import type {
  IrCompositeForeignKey,
  IrField,
  IrIndex,
  IrModel,
  IrRelation,
} from '../ir.js';
import {
  annotation,
  type AnnotationNode,
  type AnnotationValue,
} from './jpaFormat.js';
import { javaString } from './jpaNames.js';
import type { Imports } from './jpaTypes.js';

/** Writes `@Table`: the table name and schema, the unique constraints and the indexes. */

/** The column names an index entry stands for: a field, a relation (its foreign key column) or a composite foreign key. */
function columnsOf(model: IrModel, name: string): string[] | undefined {
  const field: IrField | undefined =
    model.fields.find((item: IrField) => item.name === name) ??
    model.fields.find((item: IrField) => item.columnName === name);
  if (field !== undefined) {
    return [field.columnName];
  }
  const relation: IrRelation | undefined =
    model.relations.find((item: IrRelation) => item.name === name) ??
    model.relations.find((item: IrRelation) => item.columnName === name);
  if (relation !== undefined && relation.kind !== 'manyToMany') {
    return [relation.columnName];
  }
  const composite: IrCompositeForeignKey | undefined =
    model.compositeForeignKeys?.find(
      (item: IrCompositeForeignKey) => item.name === name
    );
  if (composite !== undefined) {
    const columns: string[] = composite.fields.flatMap(
      (fieldName: string): string[] =>
        columnsOf(model, fieldName) ?? [fieldName]
    );
    return columns;
  }
  return undefined;
}

function strings(values: readonly string[]): AnnotationValue {
  return values.map((value: string) => javaString(value));
}

export interface TableOptions {
  model: IrModel;
  imports: Imports;
  warn: (message: string) => void;
}

/** Builds the `@Table` annotation of a model. */
export function tableAnnotation(options: TableOptions): AnnotationNode {
  const { model, imports, warn } = options;
  const unique: AnnotationNode[] = [];
  const plain: AnnotationNode[] = [];
  for (const field of model.fields) {
    if (field.uniqueName !== undefined && field.isUnique) {
      unique.push(
        annotation(imports.persistence('UniqueConstraint'), [
          ['name', javaString(field.uniqueName)],
          ['columnNames', strings([field.columnName])],
        ])
      );
    }
  }
  for (const index of model.indexes) {
    const label: string = `${model.name} index (${index.fields.join(', ')})`;
    const columns: string[] = [];
    let known: boolean = true;
    for (const name of index.fields) {
      const found: string[] | undefined = columnsOf(model, name);
      if (found === undefined) {
        warn(
          `${label}: "${name}" is not a field or relation of the model, so the index was dropped.`
        );
        known = false;
        break;
      }
      columns.push(...found);
    }
    if (!known || columns.length === 0) {
      continue;
    }
    const ignored: string[] = [];
    if (index.method !== undefined) {
      ignored.push(`the index type ${index.method}`);
    }
    if (index.clustered !== undefined) {
      ignored.push('clustering');
    }
    if (index.kind === 'fulltext') {
      ignored.push('the full-text kind');
    }
    const options_: IrIndex['fieldOptions'] = index.fieldOptions;
    if (
      options_ !== undefined &&
      Object.values(options_).some(
        (item) => item.length !== undefined || item.ops !== undefined
      )
    ) {
      ignored.push('prefix lengths and operator classes');
    }
    if (ignored.length > 0) {
      warn(
        `${label}: JPA cannot express ${ignored.join(', ')}; the index was written as an ordinary index.`
      );
    }
    if (index.isUnique) {
      unique.push(
        annotation(imports.persistence('UniqueConstraint'), [
          ...(index.name === undefined
            ? []
            : ([['name', javaString(index.name)]] as [string, string][])),
          ['columnNames', strings(columns)],
        ])
      );
      continue;
    }
    const descending: Set<string> = new Set<string>(
      Object.entries(options_ ?? {})
        .filter(([, item]) => item.sort === 'desc')
        .flatMap(
          ([name]: [string, unknown]): string[] => columnsOf(model, name) ?? []
        )
    );
    const list: string = columns
      .map((column: string) =>
        descending.has(column) ? `${column} DESC` : column
      )
      .join(', ');
    plain.push(
      annotation(imports.persistence('Index'), [
        ...(index.name === undefined
          ? []
          : ([['name', javaString(index.name)]] as [string, string][])),
        ['columnList', javaString(list)],
      ])
    );
  }
  const args: [string, AnnotationValue][] = [
    ['name', javaString(model.tableName)],
  ];
  if (model.schema !== undefined) {
    args.push(['schema', javaString(model.schema)]);
  }
  if (unique.length > 0) {
    args.push(['uniqueConstraints', unique]);
  }
  if (plain.length > 0) {
    args.push(['indexes', plain]);
  }
  return annotation(imports.persistence('Table'), args);
}
