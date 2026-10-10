import { describe, expect, it } from 'vitest';
import type { EmitOutput } from '../src/emitters/prisma.js';
import { emitTypeorm } from '../src/emitters/typeorm.js';
import type { IrField, IrModel, IrSchema } from '../src/ir.js';
import {
  parseTypeorm,
  type TypeormSourceFile,
} from '../src/parsers/typeorm.js';
import { expectOk } from './helpers.js';

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

const VIEW: IrModel = {
  name: 'Summary',
  tableName: 'summary_view',
  appLabel: 'app',
  isView: true,
  fields: [
    field('id', { isUnique: true }),
    field('note', { columnName: 'note_text', isNullable: true }),
  ],
  relations: [],
  indexes: [],
};

function emit(): EmitOutput {
  const schema: IrSchema = { models: [VIEW], enums: [], warnings: [] };
  return emitTypeorm(schema, { provider: 'postgresql', camelFields: false });
}

async function parse(text: string): Promise<IrSchema> {
  const sources: TypeormSourceFile[] = [{ path: 'views.ts', text }];
  return expectOk(await parseTypeorm(sources, { appLabel: 'app' }));
}

describe('typeorm emitter: views', () => {
  it('writes a view as a @ViewEntity with @ViewColumn columns', () => {
    const output: EmitOutput = emit();
    expect(output.text).toContain(
      "import { ViewColumn, ViewEntity } from 'typeorm';"
    );
    expect(output.text).toContain('// TODO: Summary is a database view.');
    expect(output.text).toContain(
      "@ViewEntity({ name: 'summary_view', expression: 'SELECT * FROM summary_view' })"
    );
    expect(output.text).toContain('  @ViewColumn()\n  id!: string;');
    expect(output.text).toContain("@ViewColumn({ name: 'note_text' })");
    expect(output.text).not.toContain('@Entity');
    expect(output.text).not.toContain('@Column');
  });

  it('warns that the expression must be completed and drops the unique constraint', () => {
    const warnings: string = emit().warnings.join('\n');
    expect(warnings).toContain('expression is a placeholder');
    expect(warnings).toContain('Summary.id: a view column cannot carry');
    expect(warnings).not.toContain('no primary key');
    expect(warnings).not.toContain('regular table');
  });
});

describe('typeorm parser: views', () => {
  it('reads @ViewEntity classes as views with their @ViewColumn columns', async () => {
    const schema: IrSchema = await parse(`
      import { ViewColumn, ViewEntity } from 'typeorm';
      @ViewEntity({ name: 'post_summary', expression: 'SELECT 1 AS id' })
      export class PostSummary {
        @ViewColumn() id!: number;
        @ViewColumn({ name: 'post_title' }) title!: string;
      }
      @ViewEntity('other_view')
      export class OtherView { @ViewColumn() name!: string; }
    `);
    const summary: IrModel | undefined = schema.models.find(
      (item: IrModel) => item.name === 'PostSummary'
    );
    expect(summary?.isView).toBe(true);
    expect(summary?.tableName).toBe('post_summary');
    expect(summary?.fields.map((item: IrField) => item.columnName)).toEqual([
      'id',
      'post_title',
    ]);
    expect(
      schema.models.find((item: IrModel) => item.name === 'OtherView')
        ?.tableName
    ).toBe('other_view');
    expect(schema.warnings.join('\n')).not.toContain('no primary key');
    expect(schema.warnings.join('\n')).toContain('expression is not converted');
  });

  it('round-trips the emitted view', async () => {
    const schema: IrSchema = await parse(emit().text);
    const view: IrModel | undefined = schema.models[0];
    expect(view?.isView).toBe(true);
    expect(view?.tableName).toBe('summary_view');
    expect(view?.fields.map((item: IrField) => item.columnName)).toEqual([
      'id',
      'note_text',
    ]);
    expect(view?.fields[1]?.isNullable).toBe(true);
  });
});
