import { describe, expect, it } from 'vitest';
import { getFormat, listFormats, type FormatAdapter } from '../src/formats.js';
import type { IrField, IrModel, IrRelation, IrSchema } from '../src/ir.js';
import { emitWith, parseEmitted, parseWith } from './conversionMatrix.js';
import { loadCanonicalSources } from './harness.js';
import { compareIr, normalizeName, type IrDifference } from './irCompare.js';
import { expectOk } from './helpers.js';

/**
 * Every canonical fixture is written with `--to zod` and read back with `--from zod`. The result has to
 * match the original except for the losses in the table below. Each loss says why the Zod writer or reader
 * cannot keep the information; the same text is the "Zod" section of docs/formats/zod.md. A difference that
 * no loss explains fails the test, and so does a loss that never happens (a stale table entry).
 */

interface Context {
  before: IrSchema;
  after: IrSchema;
}

interface Loss {
  id: string;
  /** Why the information is lost. */
  reason: string;
  matches: (difference: IrDifference, context: Context) => boolean;
}

function sourceModel(
  context: Context,
  difference: IrDifference
): IrModel | undefined {
  return context.before.models.find(
    (model: IrModel) => model.name === difference.model
  );
}

function sourceField(
  context: Context,
  difference: IrDifference
): IrField | undefined {
  return sourceModel(context, difference)?.fields.find(
    (field: IrField) => field.columnName === difference.field
  );
}

const LOSSES: readonly Loss[] = [
  {
    id: 'table-names',
    reason:
      'Zod has no table names. The reader names the table after the schema.',
    matches: (difference) => difference.kind === 'tableName',
  },
  {
    id: 'defaults',
    reason:
      'The row schema has no defaults. A column with a default is only optional in the create schema, and that schema is not read back.',
    matches: (difference) =>
      difference.kind === 'fieldDefault' && difference.after === '(none)',
  },
  {
    id: 'auto-updated',
    reason:
      'Zod cannot say that the database refreshes a column on every save.',
    matches: (difference) => difference.kind === 'fieldAutoUpdated',
  },
  {
    id: 'unique',
    reason:
      'Zod has no unique constraints. A schema cannot know about other rows.',
    matches: (difference) => difference.kind === 'fieldUnique',
  },
  {
    id: 'indexes',
    reason: 'Zod has no indexes or composite unique constraints.',
    matches: (difference) => difference.kind === 'indexRemoved',
  },
  {
    id: 'relations',
    reason:
      'The row schema holds no relations. The writer keeps the foreign-key column as a plain property and puts the related rows in the with-relations schema, which the reader skips. The delete rule and the reverse name go with the relation.',
    matches: (difference) => difference.kind === 'relationRemoved',
  },
  {
    id: 'foreign-key-columns',
    reason:
      'A foreign key that had no property of its own (Django, Doctrine) becomes a plain integer or key property, because the relation is gone.',
    matches: (difference, context) =>
      difference.kind === 'fieldAdded' &&
      (sourceModel(context, difference)?.relations ?? []).some(
        (relation: IrRelation) =>
          normalizeName(relation.columnName) ===
          normalizeName(difference.field ?? '')
      ),
  },
  {
    id: 'column-names',
    reason:
      'Zod has no column names. The property name (the field name of the source) is read back as the column name.',
    matches: (difference, context) => {
      if (difference.kind === 'fieldRemoved') {
        const field: IrField | undefined = sourceField(context, difference);
        return (
          field !== undefined &&
          field.columnName !== field.name &&
          (context.after.models
            .find((model: IrModel) => model.name === difference.model)
            ?.fields.some(
              (candidate: IrField) => candidate.columnName === field.name
            ) ??
            false)
        );
      }
      if (difference.kind === 'fieldAdded') {
        return (
          sourceModel(context, difference)?.fields.some(
            (field: IrField) =>
              field.columnName !== field.name && field.name === difference.field
          ) ?? false
        );
      }
      return false;
    },
  },
  {
    id: 'enum-column-length',
    reason:
      'Django and Entity Framework store an enum in a string column with a length. Zod validates the members, not the column width.',
    matches: (difference, context) =>
      difference.kind === 'fieldMaxLength' &&
      difference.after === '(none)' &&
      sourceField(context, difference)?.enumName !== undefined,
  },
  {
    id: 'enum-labels',
    reason: 'Zod enums have no display labels.',
    matches: (difference) => difference.kind === 'enumValueLabel',
  },
  {
    id: 'composite-keys',
    reason:
      'A schema has no composite primary key. The columns stay as properties.',
    matches: (difference) => difference.kind === 'compositePrimaryKey',
  },
];

function readableCanonicalFormats(): FormatAdapter[] {
  return listFormats().filter(
    (format: FormatAdapter) =>
      format.parse !== undefined && format.name !== 'zod'
  );
}

async function trip(format: FormatAdapter): Promise<{
  context: Context;
  differences: IrDifference[];
  warnings: string[];
}> {
  const zod: FormatAdapter = expectOk(getFormat('zod'));
  const before: IrSchema = await parseWith(
    format,
    loadCanonicalSources(format.name)
  );
  const emitted = emitWith(zod, before);
  const after: IrSchema = await parseEmitted(zod, emitted);
  return {
    context: { before, after },
    differences: compareIr(before, after),
    warnings: after.warnings,
  };
}

const used: Set<string> = new Set();

describe('canonical fixture through --to zod and back with --from zod', () => {
  it.each(readableCanonicalFormats().map((format) => [format.name, format]))(
    '%s keeps everything except the documented losses',
    async (_name, format) => {
      const { context, differences, warnings } = await trip(format);
      const unexplained: IrDifference[] = [];
      for (const difference of differences) {
        const loss: Loss | undefined = LOSSES.find((candidate: Loss) =>
          candidate.matches(difference, context)
        );
        if (loss === undefined) {
          unexplained.push(difference);
        } else {
          used.add(loss.id);
        }
      }
      expect(
        unexplained,
        'These differences are not in the loss table of test/zod-roundtrip.test.ts.'
      ).toEqual([]);
      // The writer's own output reads back without a warning, except for a model whose primary key is composite:
      // no property is named "id" then, and the reader says so.
      const keyless: string[] = context.before.models
        .filter((model: IrModel) => model.compositePrimaryKey !== undefined)
        .map((model: IrModel) => `${model.name}: Zod has no primary keys`);
      expect(
        warnings.map(
          (warning: string) =>
            /^.+?: Zod has no primary keys/.exec(warning)?.[0] ?? warning
        )
      ).toEqual(keyless);
      expect(context.after.models.length).toBe(context.before.models.length);
      expect(context.after.enums.length).toBe(context.before.enums.length);
    }
  );

  it('keeps names, types, nullability, lengths, decimals and enums of the Prisma fixture', async () => {
    const prisma: FormatAdapter = expectOk(getFormat('prisma'));
    const { context } = await trip(prisma);
    const post: IrModel | undefined = context.after.models.find(
      (model: IrModel) => model.name === 'Post'
    );
    const field = (name: string): IrField | undefined =>
      post?.fields.find((candidate: IrField) => candidate.name === name);
    expect(field('title')).toMatchObject({ type: 'string', maxLength: 200 });
    expect(field('body')).toMatchObject({ type: 'text', isNullable: false });
    expect(field('public_id')).toMatchObject({ type: 'uuid' });
    expect(field('rating')).toMatchObject({
      type: 'decimal',
      maxDigits: 4,
      decimalPlaces: 2,
      isNullable: true,
    });
    expect(field('status')).toMatchObject({ enumName: 'PostStatus' });
    expect(field('metadata')?.type).toBe('json');
    expect(field('editor_id')).toMatchObject({ type: 'int', isNullable: true });
    expect(context.after.enums[0]?.values).toEqual(
      context.before.enums[0]?.values
    );
  });

  it('has no loss in the table that never happens', () => {
    // Runs after the cases above (same file, same order).
    const unused: string[] = LOSSES.filter(
      (loss: Loss) => !used.has(loss.id)
    ).map((loss: Loss) => loss.id);
    expect(unused).toEqual([]);
  });
});
