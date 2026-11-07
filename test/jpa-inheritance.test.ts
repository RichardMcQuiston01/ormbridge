import { describe, expect, it } from 'vitest';
import {
  emitJpa,
  isJpaInheritanceMode,
  JPA_INHERITANCE_MODES,
  type JpaEmitOptions,
} from '../src/emitters/jpa.js';
import { getFormat, type MultiFileEmitOutput } from '../src/formats.js';
import type { IrField, IrModel, IrRelation, IrSchema } from '../src/ir.js';
import { parseJpa } from '../src/parsers/jpa.js';
import { field, idField, model, relation, schemaOf } from './gormFixtures.js';
import { DEFAULT_OPTIONS, expectOk } from './helpers.js';

/**
 * `--jpa-inheritance joined` writes a model whose primary key is its one-to-one relation to another model as a
 * subclass of it (the tables are the same). The Hibernate check of these schemas is in jpa-emitter-verify.test.ts.
 */

function emit(
  schema: IrSchema,
  overrides: Partial<JpaEmitOptions> = {}
): MultiFileEmitOutput {
  return emitJpa(structuredClone(schema), {
    provider: 'postgresql',
    naming: 'preserve',
    ...overrides,
  });
}

function fileText(output: MultiFileEmitOutput, name: string): string {
  const text: string | undefined = output.files[`app/models/${name}.java`];
  if (text === undefined) {
    throw new Error(
      `No file ${name}; the output has ${Object.keys(output.files).join(', ')}.`
    );
  }
  return text;
}

/** A key that is the relation to another model (the shape the EF Core, Django and JPA readers give a subclass). */
function keyRelation(
  name: string,
  target: string,
  overrides: Partial<IrRelation> = {}
): IrRelation {
  return relation(name, target, {
    kind: 'oneToOne',
    columnName: 'id',
    isPrimaryKey: true,
    ...overrides,
  });
}

/** Animal, Cat and Kitten (three levels), the subclasses listed before their superclasses. */
function zoo(): IrSchema {
  return schemaOf([
    model('Kitten', {
      tableName: 'kittens',
      fields: [field('mother', { isNullable: true, maxLength: 40 })],
      relations: [keyRelation('cat', 'Cat')],
    }),
    model('Cat', {
      tableName: 'cats',
      fields: [field('lives', { type: 'int' })],
      relations: [keyRelation('animal', 'Animal', { relatedName: 'cat' })],
    }),
    model('Animal', {
      tableName: 'animals',
      fields: [idField(), field('name', { maxLength: 40 })],
    }),
  ]);
}

const JOINED: Partial<JpaEmitOptions> = { inheritance: 'joined' };

describe('jpa emitter: joined inheritance', () => {
  it('writes a model whose key is a relation as a subclass of its target, down several levels', () => {
    const output: MultiFileEmitOutput = emit(zoo(), JOINED);
    const animal: string = fileText(output, 'Animal');
    const cat: string = fileText(output, 'Cat');
    const kitten: string = fileText(output, 'Kitten');
    expect(animal).toContain('@Inheritance(strategy = InheritanceType.JOINED)');
    expect(animal).toContain('public class Animal {');
    expect(cat).toContain('public class Cat extends Animal {');
    expect(cat).toContain(
      '@PrimaryKeyJoinColumn(name = "id", referencedColumnName = "id")'
    );
    expect(cat).toContain('@OnDelete(action = OnDeleteAction.CASCADE)');
    expect(kitten).toContain('public class Kitten extends Cat {');
    // Only the root names the strategy, and a subclass has no key attribute of its own.
    expect(cat).not.toContain('@Inheritance');
    expect(kitten).not.toContain('@Inheritance');
    expect(cat).not.toContain('@Id');
    expect(cat).not.toContain('private Animal animal');
    // The relationship back to the subclass (relatedName) is gone: the subclass is not a separate association.
    expect(animal).not.toContain('private Cat cat');
    expect(output.warnings).toEqual([]);
  });

  it('keeps the derived identity by default', () => {
    const output: MultiFileEmitOutput = emit(zoo());
    const cat: string = fileText(output, 'Cat');
    expect(cat).not.toContain('extends');
    expect(cat).toContain('private Animal animal;');
    expect(fileText(output, 'Animal')).not.toContain('@Inheritance');
  });

  it('writes the javax imports for Hibernate 5', () => {
    const cat: string = fileText(
      emit(zoo(), { ...JOINED, style: 'javax' }),
      'Cat'
    );
    expect(cat).toContain('import javax.persistence.PrimaryKeyJoinColumn;');
    expect(cat).toContain('@OnDelete(action = OnDeleteAction.CASCADE)');
  });

  it('reads back as the same tables, keys and relations', async () => {
    const original: IrSchema = zoo();
    const files = Object.entries(emit(original, JOINED).files).map(
      ([path, text]) => ({ path, text })
    );
    const reread: IrSchema = expectOk(
      await parseJpa(files, { appLabel: 'app' })
    );
    for (const name of ['Animal', 'Cat', 'Kitten']) {
      const before: IrModel | undefined = original.models.find(
        (item: IrModel) => item.name === name
      );
      const after: IrModel | undefined = reread.models.find(
        (item: IrModel) => item.name === name
      );
      expect(after?.tableName, name).toBe(before?.tableName);
      expect(
        after?.fields.map((item: IrField) => item.columnName).sort(),
        name
      ).toEqual(before?.fields.map((item: IrField) => item.columnName).sort());
    }
    const cat: IrModel | undefined = reread.models.find(
      (item: IrModel) => item.name === 'Cat'
    );
    expect(cat?.relations).toHaveLength(1);
    expect(cat?.relations[0]).toMatchObject({
      targetModel: 'Animal',
      columnName: 'id',
      isPrimaryKey: true,
    });
    const kitten: IrModel | undefined = reread.models.find(
      (item: IrModel) => item.name === 'Kitten'
    );
    expect(kitten?.relations[0]).toMatchObject({
      targetModel: 'Cat',
      isPrimaryKey: true,
    });
  });

  it('renames a subclass attribute that a superclass already has', () => {
    const schema: IrSchema = schemaOf([
      model('Animal', {
        tableName: 'animals',
        fields: [idField(), field('name', { maxLength: 40 })],
      }),
      model('Dog', {
        tableName: 'dogs',
        fields: [field('name', { columnName: 'dog_name', maxLength: 40 })],
        relations: [keyRelation('animal', 'Animal')],
      }),
    ]);
    const output: MultiFileEmitOutput = emit(schema, JOINED);
    const dog: string = fileText(output, 'Dog');
    expect(dog).toContain('@Column(name = "dog_name"');
    expect(dog).toContain('private String name2;');
    expect(output.warnings.join('\n')).toContain('Dog.name');
  });

  it('keeps the derived identity, with a warning, when the superclass has no single-column key', () => {
    const schema: IrSchema = schemaOf([
      model('Vehicle', {
        tableName: 'vehicles',
        fields: [
          field('region', { isPrimaryKey: false }),
          field('number', { type: 'int' }),
        ],
        compositePrimaryKey: ['region', 'number'],
      }),
      model('Truck', {
        tableName: 'trucks',
        fields: [field('payload', { type: 'int' })],
        relations: [keyRelation('vehicle', 'Vehicle')],
      }),
    ]);
    const output: MultiFileEmitOutput = emit(schema, JOINED);
    expect(fileText(output, 'Truck')).not.toContain('extends');
    expect(output.warnings.join('\n')).toContain(
      'Truck: the primary key is a relationship, but Vehicle has no single-column primary key to extend'
    );
  });

  it('keeps the derived identity when the key references a column that is not the primary key', () => {
    const schema: IrSchema = schemaOf([
      model('Animal', {
        tableName: 'animals',
        fields: [idField(), field('tag', { isUnique: true })],
      }),
      model('Cat', {
        tableName: 'cats',
        fields: [field('lives', { type: 'int' })],
        relations: [keyRelation('animal', 'Animal', { toField: 'tag' })],
      }),
    ]);
    const output: MultiFileEmitOutput = emit(schema, JOINED);
    expect(fileText(output, 'Cat')).not.toContain('extends');
    expect(output.warnings.join('\n')).toContain(
      'which is not its primary key'
    );
  });

  it('writes only ON DELETE CASCADE for a subclass and warns about another action', () => {
    const schema: IrSchema = zoo();
    const cat: IrModel | undefined = schema.models.find(
      (item: IrModel) => item.name === 'Cat'
    );
    const link: IrRelation | undefined = cat?.relations[0];
    if (link === undefined) {
      throw new Error('The fixture has no Cat relation.');
    }
    link.onDelete = 'restrict';
    const output: MultiFileEmitOutput = emit(schema, JOINED);
    expect(fileText(output, 'Cat')).not.toContain('@OnDelete');
    expect(output.warnings.join('\n')).toContain(
      'a subclass table can only be written with ON DELETE CASCADE'
    );
  });

  it('is validated through the adapter and exposes its modes', () => {
    expect(JPA_INHERITANCE_MODES).toEqual(['none', 'joined']);
    expect(isJpaInheritanceMode('joined')).toBe(true);
    expect(isJpaInheritanceMode('single')).toBe(false);
    const adapter = expectOk(getFormat('jpa'));
    const bad = adapter.emit?.(zoo(), {
      ...DEFAULT_OPTIONS,
      jpaInheritance: 'single' as 'joined',
    });
    expect(bad?.ok).toBe(false);
    expect(!bad?.ok && bad?.error.message).toContain(
      'Invalid jpaInheritance "single" for the jpa format. Expected one of: none, joined.'
    );
    const good = adapter.emit?.(zoo(), {
      ...DEFAULT_OPTIONS,
      jpaInheritance: 'joined',
    });
    expect(good?.ok).toBe(true);
  });
});
