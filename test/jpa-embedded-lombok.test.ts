import { describe, expect, it } from 'vitest';
import {
  emitJpa,
  isJpaKeyMode,
  JPA_KEY_MODES,
  JPA_STYLES,
  type JpaEmitOptions,
} from '../src/emitters/jpa.js';
import { getFormat, type MultiFileEmitOutput } from '../src/formats.js';
import type { IrSchema } from '../src/ir.js';
import { parseJpa } from '../src/parsers/jpa.js';
import {
  field,
  idField,
  model,
  relation,
  schemaOf,
  STATUS,
} from './gormFixtures.js';
import { expectOk } from './helpers.js';
import { compareIr } from './irCompare.js';
import { parseJpaExtra } from './jpaSupport.js';

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

function fileText(
  output: MultiFileEmitOutput,
  name: string,
  directory: string = 'app/models'
): string {
  const text: string | undefined = output.files[`${directory}/${name}.java`];
  if (text === undefined) {
    throw new Error(
      `No file ${name}; the output has ${Object.keys(output.files).join(', ')}.`
    );
  }
  return text;
}

/** An order line: its key is a relationship (order) and a number (no); it also has an enum and a plain column. */
function lines(): IrSchema {
  return schemaOf(
    [
      model('Order', { tableName: 'orders' }),
      model('Line', {
        tableName: 'lines',
        fields: [
          field('no', { type: 'int' }),
          field('kind', { enumName: 'Status', maxLength: 10 }),
          field('note', { isNullable: true, maxLength: 40 }),
        ],
        relations: [relation('order', 'Order')],
        compositePrimaryKey: ['order', 'kind', 'no'],
      }),
    ],
    [STATUS]
  );
}

async function reread(
  output: MultiFileEmitOutput
): Promise<{ schema: IrSchema; warnings: string[] }> {
  const schema: IrSchema = expectOk(
    await parseJpa(
      Object.entries(output.files).map(([path, text]) => ({ path, text })),
      { appLabel: 'app' }
    )
  );
  return { schema, warnings: schema.warnings };
}

describe('jpa emitter: @EmbeddedId keys', () => {
  it('writes an @Embeddable key class, an @EmbeddedId and @MapsId on the relationship', () => {
    const output: MultiFileEmitOutput = emit(lines(), { keyMode: 'embedded' });
    const line: string = fileText(output, 'Line');
    expect(line).toContain('@EmbeddedId\n  private LineId id;');
    expect(line).toContain(
      '@MapsId("order")\n  @ManyToOne(optional = false)\n  @JoinColumn(name = "order_id", referencedColumnName = "id", nullable = false)\n  @OnDelete(action = OnDeleteAction.CASCADE)\n  private Order order;'
    );
    expect(line).not.toContain('@Id');
    expect(line).not.toContain('@IdClass');
    expect(line).toContain('import jakarta.persistence.EmbeddedId;');
    expect(line).toContain('import jakarta.persistence.MapsId;');
    // The key columns live in the key class, not in the entity.
    expect(line).not.toContain('private Integer no;');
    expect(line).toContain('@Column(name = "note", length = 40)');
    expect(output.files['app/models/Line.java']).toBeDefined();

    const key: string = fileText(output, 'LineId');
    expect(key).toContain(
      '@Embeddable\npublic class LineId implements Serializable'
    );
    expect(key).toContain(
      '@Column(name = "order_id")\n  private Integer order;'
    );
    expect(key).toContain('@Column(name = "no")\n  private Integer no;');
    expect(key).toContain(
      '@Convert(converter = StatusConverter.class)\n  @Column(name = "kind", length = 10)\n  private Status kind;'
    );
    expect(key).toContain('public Integer getNo() {');
    expect(key).toContain('public void setNo(Integer no) {');
    expect(key).toContain(
      'Objects.equals(order, that.order) && Objects.equals(kind, that.kind) && Objects.equals(no, that.no)'
    );
    expect(key).toContain('return Objects.hash(order, kind, no);');
    // The key class has no entity annotations and no unused imports.
    expect(key).not.toContain('@Id');
    expect(key).not.toContain('import jakarta.persistence.Id;');
    expect(key).not.toContain('GeneratedValue');
    expect(output.warnings).toEqual([]);
  });

  it('keeps @IdClass as the default and the same output when the default is named', () => {
    const plain: MultiFileEmitOutput = emit(lines());
    const named: MultiFileEmitOutput = emit(lines(), {
      keyMode: 'idclass',
      lombok: false,
    });
    expect(named).toEqual(plain);
    expect(fileText(plain, 'Line')).toContain('@IdClass(LineId.class)');
    expect(fileText(plain, 'LineId')).not.toContain('@Embeddable');
  });

  it('writes a single-column key as @Id in both modes', () => {
    const schema: IrSchema = schemaOf([
      model('Order', { tableName: 'orders' }),
      model('Detail', {
        tableName: 'details',
        fields: [],
        relations: [
          relation('order', 'Order', { kind: 'oneToOne', isPrimaryKey: true }),
        ],
      }),
    ]);
    expect(emit(schema, { keyMode: 'embedded' })).toEqual(emit(schema));
    const detail: string = fileText(
      emit(schema, { keyMode: 'embedded' }),
      'Detail'
    );
    expect(detail).toContain('@Id\n  @OneToOne');
    expect(detail).not.toContain('EmbeddedId');
  });

  it.each(JPA_STYLES)('imports from the %s packages', (style) => {
    const output: MultiFileEmitOutput = emit(lines(), {
      keyMode: 'embedded',
      style,
    });
    expect(fileText(output, 'LineId')).toContain(
      `import ${style}.persistence.Embeddable;`
    );
    expect(fileText(output, 'Line')).toContain(
      `import ${style}.persistence.EmbeddedId;`
    );
    expect(fileText(output, 'Line')).toContain(
      `import ${style}.persistence.MapsId;`
    );
    const other: string = style === 'jakarta' ? 'javax' : 'jakarta';
    for (const text of Object.values(output.files)) {
      expect(text).not.toContain(`${other}.persistence`);
    }
  });

  it('writes the key class of the normalize naming mode in the chosen package', () => {
    const output: MultiFileEmitOutput = emit(lines(), {
      keyMode: 'embedded',
      naming: 'normalize',
      packageName: 'com.shop.data',
    });
    const key: string = fileText(output, 'LineId', 'com/shop/data');
    expect(key.startsWith('// <auto-generated>')).toBe(true);
    expect(key).toContain('package com.shop.data;');
    expect(key).toContain('@Column(name = "order_id")');
    const line: string = fileText(output, 'Line', 'com/shop/data');
    expect(line).toContain('@Table(name = "line")');
    expect(line).toContain('@EmbeddedId');
    // Normalizing gives every model a UUID key: the entities that were keyed by `id` keep one @Id.
    expect(fileText(output, 'Order', 'com/shop/data')).toContain('@Id');
  });

  it('names the key attribute so that it does not clash with a column called id', () => {
    const schema: IrSchema = schemaOf([
      model('Pair', {
        tableName: 'pairs',
        fields: [
          field('id', { type: 'int' }),
          field('other', { type: 'int' }),
          field('value', { isNullable: true }),
        ],
        compositePrimaryKey: ['id', 'other'],
      }),
    ]);
    const output: MultiFileEmitOutput = emit(schema, { keyMode: 'embedded' });
    expect(fileText(output, 'Pair')).toContain('private PairId id2;');
    expect(fileText(output, 'PairId')).toContain('private Integer id;');
  });

  it('warns about a key relation it cannot write, in both modes', () => {
    const schema: IrSchema = schemaOf([
      model('Line', {
        tableName: 'lines',
        fields: [field('no', { type: 'int' })],
        relations: [relation('order', 'Missing')],
        compositePrimaryKey: ['order', 'no'],
      }),
    ]);
    for (const keyMode of JPA_KEY_MODES) {
      const output: MultiFileEmitOutput = emit(schema, { keyMode });
      expect(output.warnings.join('\n')).toContain(
        'Line.order: the relation is part of the composite primary key but could not be written'
      );
    }
  });

  it('is read back as the same key as the @IdClass output, in both styles and naming modes', async () => {
    for (const style of JPA_STYLES) {
      for (const naming of ['preserve', 'normalize'] as const) {
        for (const lombok of [false, true]) {
          const asIdClass = await reread(
            emit(lines(), { style, naming, lombok })
          );
          const asEmbedded = await reread(
            emit(lines(), { style, naming, lombok, keyMode: 'embedded' })
          );
          const label: string = `${style}/${naming}/${lombok ? 'lombok' : 'plain'}`;
          expect(asEmbedded.warnings, label).toEqual([]);
          const line = asEmbedded.schema.models.find(
            (item) => item.name === 'Line'
          );
          expect(line?.compositePrimaryKey, label).toEqual([
            'order',
            'kind',
            'no',
          ]);
          expect(compareIr(asIdClass.schema, asEmbedded.schema), label).toEqual(
            []
          );
        }
      }
    }
  });

  it('reads back what the IR said: the same key columns as the schema it was written from', async () => {
    const schema: IrSchema = lines();
    const { schema: again } = await reread(
      emit(schema, { keyMode: 'embedded', lombok: true })
    );
    const line = again.models.find((item) => item.name === 'Line');
    expect(line?.compositePrimaryKey).toEqual(['order', 'kind', 'no']);
    expect(line?.relations.map((item) => item.columnName)).toEqual([
      'order_id',
    ]);
    expect(line?.fields.map((item) => item.columnName).sort()).toEqual([
      'kind',
      'no',
      'note',
    ]);
  });

  it('round-trips an embedded key with a relationship, an override and Lombok classes (the embedded-keys fixture)', async () => {
    const original: IrSchema = await parseJpaExtra('embedded-keys');
    const stock = original.models.find((item) => item.name === 'Stock');
    expect(stock?.compositePrimaryKey).toEqual(['sku', 'warehouse']);
    const reading = original.models.find((item) => item.name === 'Reading');
    expect(reading?.compositePrimaryKey).toEqual(['sensor', 'takenOn']);
    for (const style of JPA_STYLES) {
      for (const keyMode of JPA_KEY_MODES) {
        for (const lombok of [false, true]) {
          const { schema, warnings } = await reread(
            emit(original, { style, keyMode, lombok })
          );
          const label: string = `${style}/${keyMode}/${lombok ? 'lombok' : 'plain'}`;
          expect(warnings, label).toEqual([]);
          expect(compareIr(original, schema), label).toEqual([]);
        }
      }
    }
  });

  it('accepts the key mode names and rejects others', () => {
    expect(JPA_KEY_MODES).toEqual(['idclass', 'embedded']);
    expect(isJpaKeyMode('embedded')).toBe(true);
    expect(isJpaKeyMode('idclass')).toBe(true);
    expect(isJpaKeyMode('EmbeddedId')).toBe(false);
    const adapter = expectOk(getFormat('jpa'));
    const result = adapter.emit?.(lines(), {
      naming: 'preserve',
      provider: 'postgresql',
      header: true,
      autoField: 'int',
      jpaKey: 'composite' as 'embedded',
    });
    expect(result?.ok).toBe(false);
    expect(result?.ok === false ? result.error.message : '').toBe(
      'Invalid jpaKey "composite" for the jpa format. Expected one of: idclass, embedded.'
    );
  });
});

describe('jpa emitter: Lombok', () => {
  function simple(): IrSchema {
    return schemaOf([
      model('Post', {
        tableName: 'posts',
        fields: [
          idField(),
          field('title', { maxLength: 80 }),
          field('featured', { type: 'boolean' }),
          field('isPublic', { type: 'boolean' }),
        ],
        relations: [relation('author', 'User', { relatedName: 'posts' })],
      }),
      model('User', { tableName: 'users' }),
    ]);
  }

  it.each(JPA_STYLES)(
    'writes @Getter, @Setter and @NoArgsConstructor in place of accessors (%s)',
    (style) => {
      const output: MultiFileEmitOutput = emit(simple(), {
        lombok: true,
        style,
      });
      const post: string = fileText(output, 'Post');
      expect(post).toContain('import lombok.Getter;');
      expect(post).toContain('import lombok.NoArgsConstructor;');
      expect(post).toContain('import lombok.Setter;');
      expect(post).toContain(
        '@Entity\n@Table(name = "posts")\n@Getter\n@Setter\n@NoArgsConstructor\npublic class Post {'
      );
      expect(post).not.toMatch(/public \w+(<\w+>)? (get|is|set)\w+\(/);
      expect(post).toContain('private boolean featured;');
      expect(post).toContain('private boolean isPublic;');
      // The inverse side too.
      expect(fileText(output, 'User')).toContain(
        'private List<Post> posts = new ArrayList<>();'
      );
      expect(fileText(output, 'User')).not.toContain('getPosts');
    }
  );

  it('writes the same fields and annotations as the default output', () => {
    const plain: string = fileText(emit(simple()), 'Post');
    const lombok: string = fileText(emit(simple(), { lombok: true }), 'Post');
    const strip = (text: string): string =>
      text
        .split('\n')
        .filter(
          (line: string) =>
            !line.startsWith('import lombok.') &&
            !/^@(Getter|Setter|NoArgsConstructor)$/.test(line)
        )
        .join('\n')
        .split('\n\n  public ')[0] ?? '';
    expect(strip(lombok).replace(/\n}\n$/, '')).toBe(strip(plain));
  });

  it('writes @EqualsAndHashCode on a key class and drops its methods, for @IdClass and @EmbeddedId', () => {
    const idClass: string = fileText(emit(lines(), { lombok: true }), 'LineId');
    expect(idClass).toContain(
      '@NoArgsConstructor\n@AllArgsConstructor\n@EqualsAndHashCode\npublic class LineId implements Serializable {'
    );
    expect(idClass).not.toContain('@Embeddable');
    expect(idClass).not.toContain('@Getter');
    expect(idClass).not.toContain('equals(');
    expect(idClass).not.toContain('java.util.Objects');
    expect(idClass).toContain('private Integer order;');

    const embeddable: string = fileText(
      emit(lines(), { lombok: true, keyMode: 'embedded' }),
      'LineId'
    );
    expect(embeddable).toContain(
      '@Embeddable\n@Getter\n@Setter\n@NoArgsConstructor\n@AllArgsConstructor\n@EqualsAndHashCode\npublic class LineId implements Serializable {'
    );
    expect(embeddable).not.toContain('public Integer getNo');
    expect(embeddable).not.toContain('hashCode');
    for (const name of [
      'AllArgsConstructor',
      'EqualsAndHashCode',
      'Getter',
      'NoArgsConstructor',
      'Setter',
    ]) {
      expect(embeddable).toContain(`import lombok.${name};`);
    }
    // Every import is used.
    for (const match of embeddable.matchAll(/^import [\w.]+\.(\w+);$/gm)) {
      expect(
        embeddable.split(new RegExp(`\\b${match[1] ?? ''}\\b`)).length
      ).toBeGreaterThan(2);
    }
  });

  it('leaves enums and converters without Lombok annotations', () => {
    const schema: IrSchema = schemaOf(
      [
        model('Thing', {
          tableName: 'things',
          fields: [
            idField(),
            field('status', { enumName: 'Status', maxLength: 10 }),
          ],
        }),
      ],
      [STATUS]
    );
    const output: MultiFileEmitOutput = emit(schema, { lombok: true });
    for (const [path, text] of Object.entries(output.files)) {
      if (!path.endsWith('/Thing.java')) {
        expect(text, path).not.toContain('lombok');
      }
    }
  });

  it('is read back without warnings and as the same schema as the default output', async () => {
    for (const style of JPA_STYLES) {
      const plain = await reread(emit(simple(), { style }));
      const lombok = await reread(emit(simple(), { style, lombok: true }));
      expect(lombok.warnings, style).toEqual([]);
      expect(compareIr(plain.schema, lombok.schema), style).toEqual([]);
    }
  });
});
