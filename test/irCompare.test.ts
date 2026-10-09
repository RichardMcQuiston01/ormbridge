import { describe, expect, it } from 'vitest';
import type { IrField, IrModel, IrRelation, IrSchema } from '../src/ir.js';
import { compareIr, type IrDifference } from './irCompare.js';

function field(name: string, overrides: Partial<IrField> = {}): IrField {
  return {
    name,
    columnName: name,
    type: 'string',
    isPrimaryKey: false,
    isUnique: false,
    isNullable: false,
    isAutoUpdated: false,
    ...overrides,
  };
}

function relation(
  name: string,
  overrides: Partial<IrRelation> = {}
): IrRelation {
  return {
    name,
    kind: 'foreignKey',
    targetModel: 'User',
    columnName: `${name}_id`,
    isNullable: false,
    onDelete: 'cascade',
    ...overrides,
  };
}

function model(name: string, overrides: Partial<IrModel> = {}): IrModel {
  return {
    name,
    tableName: name.toLowerCase(),
    appLabel: 'app',
    fields: [field('id', { type: 'int', isPrimaryKey: true })],
    relations: [],
    indexes: [],
    ...overrides,
  };
}

function schema(...models: IrModel[]): IrSchema {
  return { models, enums: [], warnings: [] };
}

function kinds(differences: IrDifference[]): string[] {
  return differences.map((difference: IrDifference) => difference.kind);
}

describe('compareIr', () => {
  it('finds no differences between identical schemas', () => {
    const base: IrSchema = schema(model('Post'));
    expect(compareIr(base, structuredClone(base))).toEqual([]);
  });

  it('ignores ordering, identifier spelling, app label and synthesized index names', () => {
    const before: IrSchema = schema(
      model('Post', {
        appLabel: 'blog',
        fields: [field('id'), field('created_at'), field('title')],
        indexes: [{ fields: ['title'], isUnique: false }],
      })
    );
    const after: IrSchema = schema(
      model('Post', {
        appLabel: 'other',
        fields: [
          field('title'),
          field('createdAt', { columnName: 'created_at' }),
          field('id'),
        ],
        indexes: [{ fields: ['title'], isUnique: false, name: 'generated' }],
      })
    );
    expect(compareIr(before, after)).toEqual([]);
  });

  it('treats the framework default reverse accessor as equal to an explicit one', () => {
    const before: IrSchema = schema(
      model('Post', { relations: [relation('category')] })
    );
    const after: IrSchema = schema(
      model('Post', {
        relations: [relation('category', { relatedName: 'post_set' })],
      })
    );
    expect(compareIr(before, after)).toEqual([]);
  });

  it('reports changed types, nullability, defaults and lengths with before and after', () => {
    const before: IrSchema = schema(
      model('Post', {
        fields: [
          field('title', { maxLength: 200 }),
          field('views', {
            type: 'int',
            default: { kind: 'literal', value: 0 },
          }),
        ],
      })
    );
    const after: IrSchema = schema(
      model('Post', {
        fields: [
          field('title', { maxLength: 100, isNullable: true }),
          field('views', { type: 'bigInt' }),
        ],
      })
    );
    const differences: IrDifference[] = compareIr(before, after);
    expect(kinds(differences).sort()).toEqual(
      ['fieldDefault', 'fieldMaxLength', 'fieldNullability', 'fieldType'].sort()
    );
    expect(differences).toContainEqual({
      kind: 'fieldMaxLength',
      model: 'Post',
      field: 'title',
      before: '200',
      after: '100',
    });
  });

  it('reports missing and added models, fields, relations and enums', () => {
    const before: IrSchema = {
      ...schema(
        model('Post', {
          fields: [field('id'), field('gone')],
          relations: [relation('author')],
        }),
        model('Old')
      ),
      enums: [{ name: 'Status', values: [{ name: 'A', dbValue: 'a' }] }],
    };
    const after: IrSchema = schema(
      model('Post', {
        fields: [field('id'), field('extra')],
        relations: [relation('editor')],
      }),
      model('New')
    );
    expect(kinds(compareIr(before, after)).sort()).toEqual(
      [
        'enumRemoved',
        'fieldAdded',
        'fieldRemoved',
        'modelAdded',
        'modelRemoved',
        'relationAdded',
        'relationRemoved',
      ].sort()
    );
  });

  it('reports relation kind, target and onDelete changes', () => {
    const before: IrSchema = schema(
      model('Post', { relations: [relation('author')] })
    );
    const after: IrSchema = schema(
      model('Post', {
        relations: [
          relation('author', {
            kind: 'oneToOne',
            targetModel: 'Account',
            onDelete: 'restrict',
          }),
        ],
      })
    );
    expect(kinds(compareIr(before, after)).sort()).toEqual(
      [
        'relationKind',
        'relationOnDelete',
        'relationRelatedName',
        'relationTarget',
      ].sort()
    );
  });

  it('reports lost uniques, dropped explicit index names and changed enums', () => {
    const before: IrSchema = {
      ...schema(
        model('Post', {
          fields: [field('id'), field('title')],
          indexes: [
            { fields: ['title'], isUnique: true, name: 'explicit_name' },
          ],
        })
      ),
      enums: [
        {
          name: 'Status',
          values: [{ name: 'DRAFT', dbValue: 'draft', label: 'Draft' }],
        },
      ],
    };
    const after: IrSchema = {
      ...schema(
        model('Post', {
          fields: [field('id'), field('title')],
          indexes: [{ fields: ['title'], isUnique: true }],
        })
      ),
      enums: [
        { name: 'Status', values: [{ name: 'DRAFT', dbValue: 'draft' }] },
      ],
    };
    expect(kinds(compareIr(before, after)).sort()).toEqual(
      ['enumValueLabel', 'indexName'].sort()
    );
  });
});
