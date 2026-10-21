import { describe, expect, it } from 'vitest';
import { convertText, type ConvertResult } from '../src/convert.js';
import { getFormat, getFormatByExtension } from '../src/formats.js';
import type {
  IrField,
  IrIndex,
  IrModel,
  IrRelation,
  IrSchema,
} from '../src/ir.js';
import {
  isSkippedJpaPath,
  parseJpa,
  type JpaSourceFile,
} from '../src/parsers/jpa.js';
import type { Result } from '../src/result.js';
import { DEFAULT_OPTIONS, expectOk } from './helpers.js';

const HEADER: string = `package demo;

import jakarta.persistence.*;
import jakarta.validation.constraints.*;
import java.math.BigDecimal;
import java.math.BigInteger;
import java.time.*;
import java.util.*;
import org.hibernate.annotations.ColumnDefault;
import org.hibernate.annotations.CreationTimestamp;
import org.hibernate.annotations.JdbcTypeCode;
import org.hibernate.annotations.OnDelete;
import org.hibernate.annotations.OnDeleteAction;
import org.hibernate.annotations.UpdateTimestamp;
import org.hibernate.type.SqlTypes;

`;

/** Parses Java declarations; the imports are added to every file. */
async function parse(...texts: string[]): Promise<IrSchema> {
  return expectOk(await parseResult(...texts));
}

function parseResult(...texts: string[]): Promise<Result<IrSchema>> {
  const sources: JpaSourceFile[] = texts.map(
    (text: string, index: number): JpaSourceFile => ({
      path: `File${index}.java`,
      text: HEADER + text,
    })
  );
  return parseJpa(sources, { appLabel: 'app' });
}

/** An entity called `Thing` with a Long id and the given members. */
function thing(members: string, annotations: string = ''): string {
  return `@Entity ${annotations} class Thing { @Id Long id; ${members} }`;
}

function model(schema: IrSchema, name: string): IrModel {
  const found: IrModel | undefined = schema.models.find(
    (candidate: IrModel) => candidate.name === name
  );
  if (found === undefined) {
    throw new Error(
      `Model ${name} was not parsed (found: ${schema.models.map((item: IrModel) => item.name).join(', ')})`
    );
  }
  return found;
}

function field(schema: IrSchema, modelName: string, name: string): IrField {
  const found: IrField | undefined = model(schema, modelName).fields.find(
    (candidate: IrField) => candidate.name === name
  );
  if (found === undefined) {
    throw new Error(
      `Field ${modelName}.${name} was not parsed (found: ${model(
        schema,
        modelName
      )
        .fields.map((item: IrField) => item.name)
        .join(', ')})`
    );
  }
  return found;
}

function relation(
  schema: IrSchema,
  modelName: string,
  name: string
): IrRelation {
  const found: IrRelation | undefined = model(schema, modelName).relations.find(
    (candidate: IrRelation) => candidate.name === name
  );
  if (found === undefined) {
    throw new Error(`Relation ${modelName}.${name} was not parsed`);
  }
  return found;
}

function names(schema: IrSchema, modelName: string): string[] {
  return model(schema, modelName).fields.map((item: IrField) => item.name);
}

function warningsMatching(schema: IrSchema, pattern: RegExp): string[] {
  return schema.warnings.filter((warning: string) => pattern.test(warning));
}

describe('format registration', () => {
  it('registers jpa as a read and write format without a file extension', () => {
    const adapter = expectOk(getFormat('jpa'));
    expect(adapter.extensions).toEqual([]);
    expect(adapter.parse).toBeDefined();
    expect(adapter.emit).toBeDefined();
    expect(getFormatByExtension('.java')).toBeUndefined();
  });

  it('converts through the adapter', async () => {
    const result: Result<ConvertResult> = await convertText(
      [
        {
          path: 'Thing.java',
          text: `${HEADER}@Entity public class Thing { @Id Long id; @Column(nullable = false) String name; }`,
        },
      ],
      { ...DEFAULT_OPTIONS, from: 'jpa', to: 'prisma' }
    );
    const converted: ConvertResult = expectOk(result);
    expect(converted.output).toContain('model Thing {');
    expect(converted.output).toContain('name');
  });
});

describe('which classes are entities', () => {
  it('reads classes marked @Entity and nothing else', async () => {
    const schema: IrSchema = await parse(
      `@Entity class Real { @Id Long id; }
       class Plain { Long id; String name; }
       @Embeddable class Part { String x; }
       @MappedSuperclass abstract class Base { String y; }
       interface Api {}
       enum Kind { A }
       @Entity record AsRecord(Long id) {}`
    );
    expect(schema.models.map((item: IrModel) => item.name)).toEqual(['Real']);
  });

  it('reads nested classes and files with several classes', async () => {
    const schema: IrSchema = await parse(
      `public class Outer { @Entity public static class Inner { @Id Long id; } }
       @Entity class Second { @Id Long id; }`
    );
    expect(schema.models.map((item: IrModel) => item.name)).toEqual([
      'Inner',
      'Second',
    ]);
  });

  it('names the table after the class, the entity name or @Table', async () => {
    const schema: IrSchema = await parse(
      `@Entity class A { @Id Long id; }
       @Entity(name = "Renamed") class B { @Id Long id; }
       @Entity @Table(name = "tbl", schema = "sales") class C { @Id Long id; }
       @Entity @Table(name = "\`quoted\`") class D { @Id Long id; }`
    );
    expect(model(schema, 'A').tableName).toBe('A');
    expect(model(schema, 'B').tableName).toBe('Renamed');
    expect(model(schema, 'C').tableName).toBe('tbl');
    expect(model(schema, 'C').schema).toBe('sales');
    expect(model(schema, 'D').tableName).toBe('quoted');
    expect(model(schema, 'A').schema).toBeUndefined();
  });

  it('reads the legacy javax.persistence package and fully qualified names', async () => {
    const schema: IrSchema = expectOk(
      await parseJpa(
        [
          {
            path: 'Old.java',
            text: `package old;
import javax.persistence.Entity;
import javax.persistence.Id;
import javax.persistence.Column;
@Entity public class Old { @Id Long id; @Column(length = 20) String name; }
@javax.persistence.Entity class Qualified { @javax.persistence.Id Long id; }`,
          },
        ],
        { appLabel: 'app' }
      )
    );
    expect(field(schema, 'Old', 'name').maxLength).toBe(20);
    expect(model(schema, 'Qualified').fields).toHaveLength(1);
  });

  it('reports a project without entities with the code NO_MODELS_FOUND', async () => {
    const result: Result<IrSchema> = await parseResult('class Plain {}');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('NO_MODELS_FOUND');
      expect(result.error.message).toContain('@Entity');
      expect(result.error.message).toContain('orm.xml');
    }
  });

  it('skips @Subselect entities, which have no table', async () => {
    const schema: IrSchema = await parse(
      `${thing('')}
       @Entity @org.hibernate.annotations.Subselect("select 1") class View { @Id Long id; }`
    );
    expect(schema.models.map((item: IrModel) => item.name)).toEqual(['Thing']);
    expect(warningsMatching(schema, /View: @Subselect/)).toHaveLength(1);
  });
});

describe('column types', () => {
  const cases: [string, string, Partial<IrField>][] = [
    ['String', 'text', { type: 'string', maxLength: 255 }],
    ['int', 'n', { type: 'int', isNullable: false }],
    ['Integer', 'n', { type: 'int', isNullable: true }],
    ['short', 'n', { type: 'int', isNullable: false }],
    ['Byte', 'n', { type: 'int' }],
    ['long', 'n', { type: 'bigInt', isNullable: false }],
    ['Long', 'n', { type: 'bigInt', isNullable: true }],
    ['boolean', 'n', { type: 'boolean', isNullable: false }],
    ['Boolean', 'n', { type: 'boolean', isNullable: true }],
    ['float', 'n', { type: 'float' }],
    ['Double', 'n', { type: 'float' }],
    ['BigDecimal', 'n', { type: 'decimal', maxDigits: 38, decimalPlaces: 2 }],
    ['BigInteger', 'n', { type: 'decimal', maxDigits: 38, decimalPlaces: 0 }],
    ['char', 'n', { type: 'string', maxLength: 1, isNullable: false }],
    ['LocalDate', 'n', { type: 'date' }],
    ['LocalTime', 'n', { type: 'time' }],
    ['LocalDateTime', 'n', { type: 'dateTime' }],
    ['Instant', 'n', { type: 'dateTime' }],
    ['OffsetDateTime', 'n', { type: 'dateTime' }],
    ['ZonedDateTime', 'n', { type: 'dateTime' }],
    ['java.sql.Timestamp', 'n', { type: 'dateTime' }],
    ['java.sql.Date', 'n', { type: 'date' }],
    ['java.util.Date', 'n', { type: 'dateTime' }],
    ['Calendar', 'n', { type: 'dateTime' }],
    ['Duration', 'n', { type: 'duration' }],
    ['UUID', 'n', { type: 'uuid' }],
    ['byte[]', 'n', { type: 'bytes' }],
    ['Byte[]', 'n', { type: 'bytes' }],
    ['java.sql.Blob', 'n', { type: 'bytes' }],
    ['java.sql.Clob', 'n', { type: 'text' }],
    ['char[]', 'n', { type: 'string' }],
    ['Locale', 'n', { type: 'string' }],
    ['List<String>', 'n', { type: 'string', arrayDepth: 1 }],
    ['int[]', 'n', { type: 'int', arrayDepth: 1 }],
  ];

  it.each(cases)('maps %s', async (javaType, _name, expected) => {
    const schema: IrSchema = await parse(thing(`${javaType} value;`));
    expect(field(schema, 'Thing', 'value')).toMatchObject(expected);
  });

  it('applies @Temporal to dates', async () => {
    const schema: IrSchema = await parse(
      thing(`@Temporal(TemporalType.DATE) Date a;
        @Temporal(TemporalType.TIME) Date b;
        @Temporal(TemporalType.TIMESTAMP) Calendar c;`)
    );
    expect(field(schema, 'Thing', 'a').type).toBe('date');
    expect(field(schema, 'Thing', 'b').type).toBe('time');
    expect(field(schema, 'Thing', 'c').type).toBe('dateTime');
  });

  it('reads @Lob as text for strings and bytes for the rest', async () => {
    const schema: IrSchema = await parse(
      thing(`@Lob String text; @Lob byte[] data; @Lob char[] chars;`)
    );
    expect(field(schema, 'Thing', 'text').type).toBe('text');
    expect(field(schema, 'Thing', 'data').type).toBe('bytes');
    expect(field(schema, 'Thing', 'chars').type).toBe('text');
  });

  it('reads JSON columns from @JdbcTypeCode and @Type', async () => {
    const schema: IrSchema = await parse(
      thing(`@JdbcTypeCode(SqlTypes.JSON) Map<String, Object> a;
        @JdbcTypeCode(SqlTypes.JSON) String b;
        @org.hibernate.annotations.Type(io.hypersistence.utils.hibernate.type.json.JsonType.class) Object c;
        com.fasterxml.jackson.databind.JsonNode d;
        @JdbcTypeCode(SqlTypes.UUID) String e;`)
    );
    expect(field(schema, 'Thing', 'a').type).toBe('json');
    expect(field(schema, 'Thing', 'b').type).toBe('json');
    expect(field(schema, 'Thing', 'c').type).toBe('json');
    expect(field(schema, 'Thing', 'd').type).toBe('json');
    expect(field(schema, 'Thing', 'e').type).toBe('uuid');
  });

  it('warns about types with no column and keeps going', async () => {
    const schema: IrSchema = await parse(thing(`Thread bad; String fine;`));
    expect(field(schema, 'Thing', 'bad')).toMatchObject({
      type: 'unsupported',
      unsupportedType: 'Thread',
    });
    expect(field(schema, 'Thing', 'fine').type).toBe('string');
    expect(
      warningsMatching(schema, /Thing\.bad: the type Thread/)
    ).toHaveLength(1);
  });

  it('skips Map attributes without a JSON type and Optional attributes, with warnings', async () => {
    const schema: IrSchema = await parse(
      thing(`Map<String, String> labels; Optional<String> note;`)
    );
    expect(names(schema, 'Thing')).toEqual(['id']);
    expect(warningsMatching(schema, /Thing\.labels/)).toHaveLength(1);
    expect(
      warningsMatching(schema, /Thing\.note: JPA does not allow Optional/)
    ).toHaveLength(1);
  });
});

describe('which attributes are columns', () => {
  it('skips static, transient, @Transient and @Formula attributes', async () => {
    const schema: IrSchema = await parse(
      thing(`static String CONSTANT = "x";
        transient String cache;
        @Transient String scratch;
        @org.hibernate.annotations.Formula("1 + 1") int derived;
        String kept;`)
    );
    expect(names(schema, 'Thing')).toEqual(['id', 'kept']);
    expect(warningsMatching(schema, /Thing\.derived: @Formula/)).toHaveLength(
      1
    );
  });

  it('reads every variable of a declaration with several', async () => {
    const schema: IrSchema = await parse(thing(`String first, second = "x";`));
    expect(names(schema, 'Thing')).toEqual(['id', 'first', 'second']);
  });

  it('ignores Lombok annotations: the fields carry the mapping', async () => {
    const schema: IrSchema = await parse(
      `@Entity @lombok.Data @lombok.Builder class Thing { @Id Long id; @Column(length = 5) String code; }`
    );
    expect(field(schema, 'Thing', 'code').maxLength).toBe(5);
  });

  it('reads getters under property access', async () => {
    const schema: IrSchema = await parse(
      `@Entity class Thing {
        private Long id; private String name; private boolean active; private String hidden;
        @Id public Long getId() { return id; }
        @Column(nullable = false, length = 9) public String getName() { return name; }
        public boolean isActive() { return active; }
        @Transient public String getHidden() { return hidden; }
        public String getValueOf(int x) { return ""; }
        public static String getStatic() { return ""; }
      }`
    );
    expect(names(schema, 'Thing')).toEqual(['id', 'name', 'active']);
    expect(field(schema, 'Thing', 'id').isPrimaryKey).toBe(true);
    expect(field(schema, 'Thing', 'name')).toMatchObject({
      isNullable: false,
      maxLength: 9,
    });
    expect(field(schema, 'Thing', 'active').isNullable).toBe(false);
  });

  it('honours @Access(PROPERTY) and warns about field annotations it ignores', async () => {
    const schema: IrSchema = await parse(
      `@Entity @Access(AccessType.PROPERTY) class Thing {
        @Column(name = "ignored_field") private String name;
        @Id public Long getId() { return null; }
        @Column(name = "real_name") public String getName() { return name; }
      }`
    );
    expect(field(schema, 'Thing', 'name').columnName).toBe('real_name');
    expect(
      warningsMatching(
        schema,
        /Thing\.name: the annotations on a field are ignored/
      )
    ).toHaveLength(1);
  });
});

describe('nullability, length and precision', () => {
  it('lets @Column win over @Basic and Bean Validation, in that order', async () => {
    const schema: IrSchema = await parse(
      thing(`String plain;
        @Column(nullable = false) String column;
        @Basic(optional = false) String basic;
        @NotNull String validated;
        @NotBlank String blank;
        @NotEmpty String empty;
        @NotNull @Column(nullable = true) String overridden;
        int primitive;
        Integer boxed;`)
    );
    const nullable = (name: string): boolean =>
      field(schema, 'Thing', name).isNullable;
    expect(nullable('plain')).toBe(true);
    expect(nullable('column')).toBe(false);
    expect(nullable('basic')).toBe(false);
    expect(nullable('validated')).toBe(false);
    // Hibernate adds NOT NULL for @NotNull only (checked against Hibernate 6.4).
    expect(nullable('blank')).toBe(true);
    expect(nullable('empty')).toBe(true);
    expect(nullable('overridden')).toBe(true);
    expect(nullable('primitive')).toBe(false);
    expect(nullable('boxed')).toBe(true);
  });

  it('reads the length from @Column, then @Size and @Length, then the default of 255', async () => {
    const schema: IrSchema = await parse(
      thing(`String plain;
        @Column(length = 20) String column;
        @Size(max = 30) String size;
        @org.hibernate.validator.constraints.Length(max = 40) String length;
        @Size(min = 2) String minimum;
        @Column(length = 10) @Size(max = 99) String both;`)
    );
    const length = (name: string): number | undefined =>
      field(schema, 'Thing', name).maxLength;
    expect(length('plain')).toBe(255);
    expect(length('column')).toBe(20);
    expect(length('size')).toBe(30);
    expect(length('length')).toBe(40);
    expect(length('minimum')).toBe(255);
    expect(length('both')).toBe(10);
  });

  it('reads precision and scale from @Column and @Digits', async () => {
    const schema: IrSchema = await parse(
      thing(`@Column(precision = 10, scale = 3) BigDecimal a;
        @Column(precision = 8) BigDecimal b;
        @Digits(integer = 5, fraction = 1) BigDecimal c;
        BigDecimal d;`)
    );
    expect(field(schema, 'Thing', 'a')).toMatchObject({
      maxDigits: 10,
      decimalPlaces: 3,
    });
    expect(field(schema, 'Thing', 'b')).toMatchObject({
      maxDigits: 8,
      decimalPlaces: 0,
    });
    expect(field(schema, 'Thing', 'c')).toMatchObject({
      maxDigits: 6,
      decimalPlaces: 1,
    });
    expect(field(schema, 'Thing', 'd')).toMatchObject({
      maxDigits: 38,
      decimalPlaces: 2,
    });
  });

  it('reads @Column(unique), @NaturalId and column names', async () => {
    const schema: IrSchema = await parse(
      thing(`@Column(unique = true) String code;
        @org.hibernate.annotations.NaturalId String slug;
        @Column(name = "full_name") String fullName;
        String camelCase;`)
    );
    expect(field(schema, 'Thing', 'code').isUnique).toBe(true);
    expect(field(schema, 'Thing', 'slug').isUnique).toBe(true);
    expect(field(schema, 'Thing', 'fullName').columnName).toBe('full_name');
    // JPA keeps the attribute name as the column name; --naming normalize makes it snake_case.
    expect(field(schema, 'Thing', 'camelCase').columnName).toBe('camelCase');
  });

  it('makes a natural id of several attributes one unique index', async () => {
    const schema: IrSchema = await parse(
      thing(`@org.hibernate.annotations.NaturalId String a;
        @org.hibernate.annotations.NaturalId String b;`)
    );
    expect(model(schema, 'Thing').indexes).toContainEqual({
      fields: ['a', 'b'],
      isUnique: true,
    });
  });

  it('reads types, defaults and constraints out of columnDefinition', async () => {
    const schema: IrSchema = await parse(
      thing(`@Column(columnDefinition = "varchar(12) not null default 'x'") String a;
        @Column(columnDefinition = "text") String b;
        @Column(columnDefinition = "jsonb") String c;
        @Column(columnDefinition = "numeric(9,4)") BigDecimal d;
        @Column(columnDefinition = "geometry(Point)") String e;`)
    );
    expect(field(schema, 'Thing', 'a')).toMatchObject({
      type: 'string',
      maxLength: 12,
      isNullable: false,
      default: { kind: 'literal', value: 'x' },
    });
    expect(field(schema, 'Thing', 'b').type).toBe('text');
    expect(field(schema, 'Thing', 'c').type).toBe('json');
    expect(field(schema, 'Thing', 'd')).toMatchObject({
      maxDigits: 9,
      decimalPlaces: 4,
    });
    expect(field(schema, 'Thing', 'e').type).toBe('string');
    expect(
      warningsMatching(schema, /Thing\.e: the columnDefinition/)
    ).toHaveLength(1);
  });

  it('skips the second mapping of a column that is read only', async () => {
    const schema: IrSchema = await parse(
      thing(`@Column(name = "owner_id", insertable = false, updatable = false) Long ownerId;
        @ManyToOne @JoinColumn(name = "owner_id") Thing owner;`)
    );
    expect(names(schema, 'Thing')).toEqual(['id']);
    expect(relation(schema, 'Thing', 'owner').columnName).toBe('owner_id');
  });
});

describe('defaults and generated values', () => {
  it('reads @GeneratedValue on integer keys and UUID keys', async () => {
    const schema: IrSchema = await parse(
      `@Entity class A { @Id @GeneratedValue(strategy = GenerationType.IDENTITY) Long id; }
       @Entity class B { @Id @GeneratedValue Integer id; }
       @Entity class C { @Id @GeneratedValue(strategy = GenerationType.UUID) UUID id; }
       @Entity class D { @Id @GeneratedValue(strategy = GenerationType.SEQUENCE, generator = "s") Long id; }
       @Entity class E { @Id Long id; }`
    );
    expect(field(schema, 'A', 'id').default).toEqual({ kind: 'autoIncrement' });
    expect(field(schema, 'B', 'id').default).toEqual({ kind: 'autoIncrement' });
    expect(field(schema, 'C', 'id').default).toEqual({ kind: 'uuid' });
    expect(field(schema, 'D', 'id').default).toEqual({ kind: 'autoIncrement' });
    expect(field(schema, 'E', 'id').default).toBeUndefined();
    expect(
      warningsMatching(schema, /D\.id: the key is generated from a sequence/)
    ).toHaveLength(1);
  });

  it('reads @ColumnDefault as SQL', async () => {
    const schema: IrSchema = await parse(
      thing(`@ColumnDefault("0") int a;
        @ColumnDefault("true") boolean b;
        @ColumnDefault("'draft'") String c;
        @ColumnDefault("CURRENT_TIMESTAMP") LocalDateTime d;
        @ColumnDefault("random_uuid()") UUID e;
        @ColumnDefault("lower('X')") String f;`)
    );
    expect(field(schema, 'Thing', 'a').default).toEqual({
      kind: 'literal',
      value: 0,
    });
    expect(field(schema, 'Thing', 'b').default).toEqual({
      kind: 'literal',
      value: true,
    });
    expect(field(schema, 'Thing', 'c').default).toEqual({
      kind: 'literal',
      value: 'draft',
    });
    expect(field(schema, 'Thing', 'd').default).toEqual({ kind: 'now' });
    expect(field(schema, 'Thing', 'f').default).toEqual({
      kind: 'dbExpression',
      expression: "lower('X')",
    });
  });

  it('does not take an initializer for a database default', async () => {
    const schema: IrSchema = await parse(
      thing(`int count = 5; String name = "x";`)
    );
    expect(field(schema, 'Thing', 'count').default).toBeUndefined();
    expect(field(schema, 'Thing', 'name').default).toBeUndefined();
  });

  it('reads creation and update timestamps from Hibernate and Spring Data', async () => {
    const schema: IrSchema = await parse(
      thing(`@CreationTimestamp LocalDateTime hibernateCreated;
        @UpdateTimestamp LocalDateTime hibernateUpdated;
        @org.springframework.data.annotation.CreatedDate Instant springCreated;
        @org.springframework.data.annotation.LastModifiedDate Instant springUpdated;
        @org.springframework.data.annotation.CreatedBy String by;`)
    );
    expect(field(schema, 'Thing', 'hibernateCreated').default).toEqual({
      kind: 'now',
    });
    expect(field(schema, 'Thing', 'springCreated').default).toEqual({
      kind: 'now',
    });
    expect(field(schema, 'Thing', 'hibernateUpdated').isAutoUpdated).toBe(true);
    expect(field(schema, 'Thing', 'springUpdated').isAutoUpdated).toBe(true);
    expect(field(schema, 'Thing', 'by').default).toBeUndefined();
  });

  it('reads @UuidGenerator as a client generated UUID', async () => {
    const schema: IrSchema = await parse(
      thing(`@org.hibernate.annotations.UuidGenerator UUID token;`)
    );
    expect(field(schema, 'Thing', 'token').default).toEqual({ kind: 'uuid' });
  });

  it('warns about @Version, @Convert and comments once each', async () => {
    const schema: IrSchema = await parse(
      thing(`@Version long version;
        @org.hibernate.annotations.Comment("note") String commented;
        @org.hibernate.annotations.Check(constraints = "a > 0") int checked;`)
    );
    expect(
      warningsMatching(schema, /Thing\.version: the @Version/)
    ).toHaveLength(1);
    expect(warningsMatching(schema, /comments \(commented\)/)).toHaveLength(1);
    expect(
      warningsMatching(schema, /@Check constraints on checked/)
    ).toHaveLength(1);
  });
});

describe('enums', () => {
  const enums: string = `enum Level { LOW, MEDIUM, HIGH }`;

  it('stores @Enumerated(STRING) by name', async () => {
    const schema: IrSchema = await parse(
      enums,
      thing(`@Enumerated(EnumType.STRING) @Column(length = 10) Level level;`)
    );
    expect(field(schema, 'Thing', 'level')).toMatchObject({
      type: 'string',
      maxLength: 10,
      enumName: 'Level',
    });
    expect(schema.enums).toEqual([
      {
        name: 'Level',
        values: [
          { name: 'LOW', dbValue: 'LOW' },
          { name: 'MEDIUM', dbValue: 'MEDIUM' },
          { name: 'HIGH', dbValue: 'HIGH' },
        ],
      },
    ]);
    expect(schema.warnings).toEqual([]);
  });

  it('stores the default as the ordinal number, with a warning', async () => {
    const schema: IrSchema = await parse(enums, thing(`Level level;`));
    expect(field(schema, 'Thing', 'level')).toMatchObject({
      type: 'int',
      enumName: 'Level',
    });
    expect(schema.enums[0]?.values.map((value) => value.dbValue)).toEqual([
      '0',
      '1',
      '2',
    ]);
    expect(
      warningsMatching(
        schema,
        /Thing\.level: the enum Level is stored as its ordinal/
      )
    ).toHaveLength(1);
  });

  it('turns an enum default into an enum value', async () => {
    const schema: IrSchema = await parse(
      enums,
      thing(
        `@Enumerated(EnumType.STRING) @ColumnDefault("'MEDIUM'") Level level;`
      )
    );
    expect(field(schema, 'Thing', 'level').default).toEqual({
      kind: 'enumValue',
      value: 'MEDIUM',
    });
  });

  it('finds enums nested in an entity or in other files', async () => {
    const schema: IrSchema = await parse(
      `@Entity class Holder { @Id Long id; @Enumerated(EnumType.STRING) Inner inner; enum Inner { A, B } }`
    );
    expect(schema.enums.map((item) => item.name)).toEqual(['Inner']);
  });
});

describe('converters', () => {
  const converter: string = `
    class Money { }
    @Converter class MoneyConverter implements AttributeConverter<Money, String> {
      public String convertToDatabaseColumn(Money m) { return null; }
      public Money convertToEntityAttribute(String s) { return null; }
    }
    @Converter(autoApply = true) class FlagConverter implements AttributeConverter<Flag, Integer> {
      public Integer convertToDatabaseColumn(Flag m) { return null; }
      public Flag convertToEntityAttribute(Integer s) { return null; }
    }
    class Flag { }`;

  it('takes the column type from the converter and warns', async () => {
    const schema: IrSchema = await parse(
      converter,
      thing(`@Convert(converter = MoneyConverter.class) Money price; Flag flag;
        @Convert(disableConversion = true) String plain;`)
    );
    expect(field(schema, 'Thing', 'price').type).toBe('string');
    // autoApply converters apply to every attribute of their type.
    expect(field(schema, 'Thing', 'flag').type).toBe('int');
    expect(warningsMatching(schema, /MoneyConverter is not run/)).toHaveLength(
      1
    );
    expect(warningsMatching(schema, /FlagConverter is not run/)).toHaveLength(
      1
    );
  });
});

describe('relationships', () => {
  const target: string = `@Entity class User { @Id Long id; }`;

  it('names the foreign key after the attribute and the key of the target', async () => {
    const schema: IrSchema = await parse(
      target,
      thing(`@ManyToOne User author; @ManyToOne User editor;`)
    );
    expect(relation(schema, 'Thing', 'author')).toMatchObject({
      kind: 'foreignKey',
      targetModel: 'User',
      columnName: 'author_id',
      isNullable: true,
      onDelete: 'noAction',
    });
    expect(relation(schema, 'Thing', 'editor').columnName).toBe('editor_id');
  });

  it('reads optional, nullable, @NotNull and the join column name', async () => {
    const schema: IrSchema = await parse(
      target,
      thing(`@ManyToOne(optional = false) User a;
        @ManyToOne @JoinColumn(name = "b_fk", nullable = false) User b;
        @NotNull @ManyToOne User c;
        @ManyToOne @JoinColumn(name = "d_fk") User d;`)
    );
    expect(relation(schema, 'Thing', 'a').isNullable).toBe(false);
    expect(relation(schema, 'Thing', 'b')).toMatchObject({
      isNullable: false,
      columnName: 'b_fk',
    });
    expect(relation(schema, 'Thing', 'c').isNullable).toBe(false);
    expect(relation(schema, 'Thing', 'd')).toMatchObject({
      isNullable: true,
      columnName: 'd_fk',
    });
  });

  it('reads @OnDelete, constraint names and a referenced column', async () => {
    const schema: IrSchema = await parse(
      `@Entity class User { @Id Long id; @Column(unique = true) String email; }`,
      thing(`@ManyToOne @OnDelete(action = OnDeleteAction.CASCADE) User a;
        @ManyToOne @OnDelete(action = OnDeleteAction.SET_NULL) User b;
        @ManyToOne @OnDelete(action = OnDeleteAction.RESTRICT) User c;
        @ManyToOne @JoinColumn(name = "d_id", foreignKey = @ForeignKey(name = "fk_thing_d")) User d;
        @ManyToOne @JoinColumn(name = "e_email", referencedColumnName = "email") User e;`)
    );
    expect(relation(schema, 'Thing', 'a').onDelete).toBe('cascade');
    expect(relation(schema, 'Thing', 'b').onDelete).toBe('setNull');
    expect(relation(schema, 'Thing', 'c').onDelete).toBe('restrict');
    expect(relation(schema, 'Thing', 'd').constraintName).toBe('fk_thing_d');
    expect(relation(schema, 'Thing', 'e')).toMatchObject({
      columnName: 'e_email',
      toField: 'email',
    });
  });

  it('reads the legacy Hibernate @ForeignKey and warns about NO_CONSTRAINT', async () => {
    const schema: IrSchema = expectOk(
      await parseJpa(
        [
          {
            path: 'T.java',
            text: `package demo;
import jakarta.persistence.*;
import org.hibernate.annotations.ForeignKey;
@Entity class Owner { @Id Long id; }
@Entity class T { @Id Long id;
  @ManyToOne @ForeignKey(name = "fk_legacy") Owner legacy;
  @ManyToOne @JoinColumn(name = "free_id", foreignKey = @jakarta.persistence.ForeignKey(value = ConstraintMode.NO_CONSTRAINT)) Owner free; }`,
          },
        ],
        { appLabel: 'app' }
      )
    );
    expect(relation(schema, 'T', 'legacy').constraintName).toBe('fk_legacy');
    expect(
      warningsMatching(schema, /T\.free: ConstraintMode\.NO_CONSTRAINT/)
    ).toHaveLength(1);
  });

  it('reads @PrimaryKeyJoinColumn on a one-to-one as a shared key, with a warning', async () => {
    const schema: IrSchema = await parse(
      `@Entity class Person { @Id Long id; }
       @Entity class Wallet { @Id Long id; @OneToOne @PrimaryKeyJoinColumn Person owner; }`
    );
    expect(names(schema, 'Wallet')).toEqual([]);
    expect(relation(schema, 'Wallet', 'owner')).toMatchObject({
      isPrimaryKey: true,
      columnName: 'id',
      kind: 'oneToOne',
    });
    expect(
      warningsMatching(schema, /Wallet\.owner: @PrimaryKeyJoinColumn/)
    ).toHaveLength(1);
  });

  it('reads a one-to-one as unique and an inverse side through mappedBy', async () => {
    const schema: IrSchema = await parse(
      `@Entity class Owner { @Id Long id; @OneToOne(mappedBy = "owner") Thing thing; }`,
      thing(
        `@OneToOne(optional = false) @JoinColumn(name = "owner_id") Owner owner;`
      )
    );
    expect(relation(schema, 'Thing', 'owner')).toMatchObject({
      kind: 'oneToOne',
      isNullable: false,
      relatedName: 'thing',
    });
    expect(model(schema, 'Owner').relations).toEqual([]);
  });

  it('pairs collections with the owning side by mappedBy', async () => {
    const schema: IrSchema = await parse(
      `@Entity class Parent { @Id Long id;
         @OneToMany(mappedBy = "primary") List<Thing> first = new ArrayList<>();
         @OneToMany(mappedBy = "secondary") Set<Thing> second; }`,
      thing(`@ManyToOne Parent primary; @ManyToOne Parent secondary;`)
    );
    expect(relation(schema, 'Thing', 'primary').relatedName).toBe('first');
    expect(relation(schema, 'Thing', 'secondary').relatedName).toBe('second');
  });

  it('warns when mappedBy names no relationship', async () => {
    const schema: IrSchema = await parse(
      `@Entity class Parent { @Id Long id; @OneToMany(mappedBy = "nothing") List<Thing> items; }`,
      thing(`@ManyToOne Parent parent;`)
    );
    expect(warningsMatching(schema, /mappedBy = "nothing"/)).toHaveLength(1);
  });

  it('reads the target from targetEntity and generics, and warns about unknown targets', async () => {
    const schema: IrSchema = await parse(
      target,
      thing(`@ManyToOne(targetEntity = User.class) Object a;
        @OneToMany Set<Missing> b;`)
    );
    expect(relation(schema, 'Thing', 'a').targetModel).toBe('User');
    expect(
      warningsMatching(schema, /Thing\.b: the target type Missing/)
    ).toHaveLength(1);
  });

  it('reads a relationship to the same entity', async () => {
    const schema: IrSchema = await parse(
      thing(`@ManyToOne @JoinColumn(name = "parent_id") Thing parent;
        @OneToMany(mappedBy = "parent") List<Thing> children;`)
    );
    expect(relation(schema, 'Thing', 'parent')).toMatchObject({
      targetModel: 'Thing',
      relatedName: 'children',
    });
  });

  it('notes cascade REMOVE and orphanRemoval, which only the ORM performs', async () => {
    const schema: IrSchema = await parse(
      `@Entity class Parent { @Id Long id;
         @OneToMany(mappedBy = "parent", cascade = CascadeType.ALL, orphanRemoval = true) List<Thing> items; }`,
      thing(`@ManyToOne Parent parent;`)
    );
    expect(warningsMatching(schema, /Parent\.items: cascade ALL/)).toHaveLength(
      1
    );
    expect(relation(schema, 'Thing', 'parent').onDelete).toBe('noAction');
  });

  it('does not note cascade when the owning side deletes in the database', async () => {
    const schema: IrSchema = await parse(
      `@Entity class Parent { @Id Long id;
         @OneToMany(mappedBy = "parent", cascade = CascadeType.PERSIST) List<Thing> items; }`,
      thing(`@ManyToOne Parent parent;`)
    );
    expect(schema.warnings).toEqual([]);
  });
});

describe('many-to-many and join tables', () => {
  const books: string = `
    @Entity class Author { @Id Long id; @ManyToMany(mappedBy = "authors") Set<Book> books; }
    @Entity class Book { @Id Long id; %JOIN% @ManyToMany Set<Author> authors; }`;

  it('reads the owning side as a many-to-many and links the inverse side', async () => {
    const schema: IrSchema = await parse(books.replace('%JOIN%', ''));
    expect(relation(schema, 'Book', 'authors')).toMatchObject({
      kind: 'manyToMany',
      targetModel: 'Author',
      relatedName: 'books',
    });
    expect(model(schema, 'Author').relations).toEqual([]);
  });

  it('warns that the default join table is not what other formats derive', async () => {
    const schema: IrSchema = await parse(books.replace('%JOIN%', ''));
    expect(
      warningsMatching(
        schema,
        /join table "Book_Author" \(columns Book_id, authors_id\)/
      )
    ).toHaveLength(1);
  });

  it('is silent when @JoinTable matches the names other formats derive', async () => {
    const schema: IrSchema = await parse(
      books.replace(
        '%JOIN%',
        '@JoinTable(name = "Book_authors", joinColumns = @JoinColumn(name = "book_id"), inverseJoinColumns = @JoinColumn(name = "author_id"))'
      )
    );
    expect(schema.warnings).toEqual([]);
  });

  it('reads a one-to-many without mappedBy as a join table, and with @JoinColumn as a key on the target', async () => {
    const schema: IrSchema = await parse(
      `@Entity class Child { @Id Long id; }
       @Entity class Other { @Id Long id; }
       @Entity class Parent { @Id Long id;
         @OneToMany List<Child> viaTable;
         @OneToMany @JoinColumn(name = "parent_fk") List<Other> viaColumn; }`
    );
    expect(relation(schema, 'Parent', 'viaTable').kind).toBe('manyToMany');
    expect(relation(schema, 'Other', 'parent')).toMatchObject({
      kind: 'foreignKey',
      targetModel: 'Parent',
      columnName: 'parent_fk',
      relatedName: 'viaColumn',
    });
    expect(
      warningsMatching(schema, /Parent\.viaTable: a unidirectional @OneToMany/)
    ).toHaveLength(1);
  });
});

describe('keys', () => {
  it('reads @IdClass as a composite key of the @Id attributes', async () => {
    const schema: IrSchema = await parse(
      `class LineId { Long order; Integer line; }
       @Entity @IdClass(LineId.class) class Line { @Id Long order; @Id Integer line; String sku; }`
    );
    expect(model(schema, 'Line').compositePrimaryKey).toEqual([
      'order',
      'line',
    ]);
    expect(field(schema, 'Line', 'order').isPrimaryKey).toBe(false);
    expect(field(schema, 'Line', 'order').isNullable).toBe(false);
  });

  it('reads @EmbeddedId with @MapsId, folding the id columns into the foreign keys', async () => {
    const schema: IrSchema = await parse(
      `@Embeddable class PairId { Long leftId; Long rightId; }
       @Entity class Left { @Id Long id; }
       @Entity class Right { @Id Long id; }
       @Entity class Pair {
         @EmbeddedId PairId id;
         @MapsId("leftId") @ManyToOne(optional = false) Left left;
         @MapsId("rightId") @ManyToOne(optional = false) Right right;
         String note; }`
    );
    expect(model(schema, 'Pair').compositePrimaryKey).toEqual([
      'left',
      'right',
    ]);
    expect(names(schema, 'Pair')).toEqual(['note']);
    expect(relation(schema, 'Pair', 'left').columnName).toBe('left_id');
  });

  it('reads @IdClass and @EmbeddedId as the same key, with the same attribute names', async () => {
    const asIdClass: IrSchema = await parse(
      `class LineId { String sku; Integer no; }
       @Entity @IdClass(LineId.class) class Line { @Id @Column(name = "sku_code", length = 8) String sku; @Id Integer no; String note; }`
    );
    const asEmbedded: IrSchema = await parse(
      `@Embeddable class LineId { @Column(name = "sku_code", length = 8) String sku; Integer no; }
       @Entity class Line { @EmbeddedId LineId id; String note; }`
    );
    expect(model(asEmbedded, 'Line').compositePrimaryKey).toEqual([
      'sku',
      'no',
    ]);
    expect(model(asIdClass, 'Line').compositePrimaryKey).toEqual(['sku', 'no']);
    expect(model(asEmbedded, 'Line')).toEqual(model(asIdClass, 'Line'));
    expect(asEmbedded.warnings).toEqual([]);
  });

  it('keeps the @EmbeddedId name as a prefix when a key attribute would clash with another attribute', async () => {
    const schema: IrSchema = await parse(
      `@Embeddable class PairId { Integer left; Integer right; }
       @Entity class Pair { @EmbeddedId PairId id; @Column(name = "left_copy") Integer left; }`
    );
    expect(model(schema, 'Pair').compositePrimaryKey).toEqual([
      'idLeft',
      'right',
    ]);
    expect(names(schema, 'Pair')).toContain('left');
  });

  it('reads an @EmbeddedId whose key class has a relationship, nested embeddables and Lombok annotations', async () => {
    const schema: IrSchema = await parse(
      `@Entity class Owner { @Id Long id; }
       @Embeddable class Range { Integer from; Integer to; }
       @Embeddable @lombok.Getter @lombok.Setter @lombok.EqualsAndHashCode class SlotId {
         @ManyToOne(optional = false) @JoinColumn(name = "owner_ref") Owner owner;
         @Embedded Range span; }
       @Entity @lombok.Getter class Slot { @EmbeddedId SlotId id; String label; }`
    );
    const slot: IrModel = model(schema, 'Slot');
    expect(slot.compositePrimaryKey).toEqual(['owner', 'spanFrom', 'spanTo']);
    expect(relation(schema, 'Slot', 'owner')).toMatchObject({
      columnName: 'owner_ref',
      targetModel: 'Owner',
    });
    expect(names(schema, 'Slot')).toEqual(['spanFrom', 'spanTo', 'label']);
  });

  it('warns that an @Embedded value object was flattened into plain columns, and not for the key', async () => {
    const schema: IrSchema = await parse(
      `@Embeddable class Address { String street; String city; }
       @Embeddable class PairId { Integer a; Integer b; }
       @Entity class Home { @EmbeddedId PairId id; @Embedded Address address; }`
    );
    expect(names(schema, 'Home')).toEqual([
      'a',
      'b',
      'addressStreet',
      'addressCity',
    ]);
    expect(
      warningsMatching(schema, /the embedded Address was flattened/)
    ).toEqual([
      'Home.address: the embedded Address was flattened into the columns address.street, address.city; the shared model has no embedded type, so other formats get plain columns and the value object itself is lost.',
    ]);
    expect(warningsMatching(schema, /PairId/)).toEqual([]);
  });

  it('warns once when a mapped superclass or a single-table hierarchy reads an embedded attribute again', async () => {
    const schema: IrSchema = await parse(
      `@Embeddable class Geo { Double lat; Double lon; }
       @Entity @Inheritance class Base { @Id Long id; }
       @Entity class Sub extends Base { @Embedded Geo geo; }`
    );
    expect(warningsMatching(schema, /Sub\.geo: the embedded Geo/)).toHaveLength(
      1
    );
  });

  it('reads a shared key (@MapsId) and a derived identity (@Id on a relationship)', async () => {
    const schema: IrSchema = await parse(
      `@Entity class Person { @Id Long id; }
       @Entity class Detail { @Id Long id; @MapsId @OneToOne @JoinColumn(name = "id") Person person; }
       @Entity class Passport { @Id @OneToOne @JoinColumn(name = "person_id") Person holder; }`
    );
    expect(names(schema, 'Detail')).toEqual([]);
    expect(relation(schema, 'Detail', 'person')).toMatchObject({
      isPrimaryKey: true,
      columnName: 'id',
      isNullable: false,
    });
    expect(relation(schema, 'Passport', 'holder')).toMatchObject({
      isPrimaryKey: true,
      columnName: 'person_id',
    });
  });

  it('reads @JoinColumns as a composite foreign key with its columns', async () => {
    const schema: IrSchema = await parse(
      `class LineId { Long order; Integer line; }
       @Entity @IdClass(LineId.class) class Line { @Id Long order; @Id Integer line; }
       @Entity class Ship { @Id Long id;
         @ManyToOne @JoinColumns({
           @JoinColumn(name = "line_order", referencedColumnName = "order"),
           @JoinColumn(name = "line_no", referencedColumnName = "line") }) Line line; }`
    );
    const ship: IrModel = model(schema, 'Ship');
    expect(ship.compositeForeignKeys).toEqual([
      {
        name: 'line',
        targetModel: 'Line',
        fields: ['lineOrder', 'lineNo'],
        references: ['order', 'line'],
        kind: 'foreignKey',
        isNullable: true,
        onDelete: 'noAction',
      },
    ]);
    expect(field(schema, 'Ship', 'lineOrder')).toMatchObject({
      type: 'bigInt',
      columnName: 'line_order',
    });
  });

  it('warns about an entity without a key', async () => {
    const schema: IrSchema = await parse(
      `@Entity class Keyless { String name; }`
    );
    expect(
      warningsMatching(schema, /Keyless: the entity has no @Id/)
    ).toHaveLength(1);
  });
});

describe('embeddables', () => {
  const embeddables: string = `
    @Embeddable class Geo { Double lat; Double lon; }
    @Embeddable class Address { @Column(length = 40) String street; @Column(nullable = false) String city; @Embedded Geo geo; }`;

  it('flattens an embedded object into the owner with the JPA column names', async () => {
    const schema: IrSchema = await parse(
      embeddables,
      `@Embeddable class Note { String label; }`,
      thing(`@Embedded Address home; Note note;`)
    );
    expect(names(schema, 'Thing')).toEqual([
      'id',
      'homeStreet',
      'homeCity',
      'homeGeoLat',
      'homeGeoLon',
      'noteLabel',
    ]);
    // The columns keep the plain attribute names, without a prefix.
    expect(field(schema, 'Thing', 'homeStreet')).toMatchObject({
      columnName: 'street',
      maxLength: 40,
    });
    expect(field(schema, 'Thing', 'homeGeoLat').columnName).toBe('lat');
    expect(field(schema, 'Thing', 'noteLabel').columnName).toBe('label');
  });

  it('warns when an embeddable is used twice without @AttributeOverride, as Hibernate refuses it', async () => {
    const schema: IrSchema = await parse(
      embeddables,
      thing(`@Embedded Address home; Address work;`)
    );
    expect(names(schema, 'Thing')).not.toContain('workStreet');
    expect(
      warningsMatching(
        schema,
        /Thing\.work\.street: another attribute already maps the column "street"/
      )
    ).toHaveLength(1);
  });

  it('applies @AttributeOverride at any depth', async () => {
    const schema: IrSchema = await parse(
      embeddables,
      thing(`@Embedded @AttributeOverrides({
          @AttributeOverride(name = "street", column = @Column(name = "b_street", length = 60)),
          @AttributeOverride(name = "geo.lat", column = @Column(name = "b_lat")) }) Address branch;`)
    );
    expect(field(schema, 'Thing', 'branchStreet')).toMatchObject({
      columnName: 'b_street',
      maxLength: 60,
    });
    expect(field(schema, 'Thing', 'branchGeoLat').columnName).toBe('b_lat');
    expect(field(schema, 'Thing', 'branchCity').columnName).toBe('city');
  });

  it('applies class level overrides to inherited attributes', async () => {
    const schema: IrSchema = await parse(
      `@MappedSuperclass abstract class Base { @Id Long id; String label; }
       @Entity @AttributeOverride(name = "label", column = @Column(name = "title")) class Titled extends Base { }`
    );
    expect(field(schema, 'Titled', 'label').columnName).toBe('title');
  });

  it('warns about an embedded type that is not in the input', async () => {
    const schema: IrSchema = await parse(thing(`@Embedded Missing m;`));
    expect(
      warningsMatching(schema, /Thing\.m: the embedded type Missing/)
    ).toHaveLength(1);
  });
});

describe('inheritance', () => {
  it('flattens a mapped superclass into every subclass, superclass first', async () => {
    const schema: IrSchema = await parse(
      `@MappedSuperclass abstract class Base { @Id Long id; @CreationTimestamp LocalDateTime created; }
       @Entity class A extends Base { String a; }
       @Entity class B extends Base { String b; }`
    );
    expect(names(schema, 'A')).toEqual(['id', 'created', 'a']);
    expect(names(schema, 'B')).toEqual(['id', 'created', 'b']);
    expect(schema.models.map((item) => item.name)).toEqual(['A', 'B']);
  });

  it('reads generic superclasses with the type their subclass gave', async () => {
    const schema: IrSchema = await parse(
      `@MappedSuperclass abstract class Base<I, V> { @Id I id; V value; List<V> values; }
       @Entity class A extends Base<Long, String> { }
       @Entity class B extends Base<UUID, Integer> { }`
    );
    expect(field(schema, 'A', 'id').type).toBe('bigInt');
    expect(field(schema, 'A', 'value').type).toBe('string');
    expect(field(schema, 'B', 'id').type).toBe('uuid');
    expect(field(schema, 'B', 'values')).toMatchObject({
      type: 'int',
      arrayDepth: 1,
    });
  });

  it('warns about a superclass that is not in the input', async () => {
    const schema: IrSchema = await parse(
      `@Entity class A extends AbstractPersistable<Long> { }`
    );
    expect(
      warningsMatching(
        schema,
        /A: the superclass AbstractPersistable is not in the input/
      )
    ).toHaveLength(1);
  });

  it('warns about a plain superclass with mapping annotations', async () => {
    const schema: IrSchema = await parse(
      `abstract class Plain { @Column(name = "x") String x; }
       @Entity class A extends Plain { @Id Long id; }`
    );
    expect(names(schema, 'A')).toEqual(['id']);
    expect(
      warningsMatching(
        schema,
        /Plain has mapping annotations but no @MappedSuperclass/
      )
    ).toHaveLength(1);
  });

  it('merges single table inheritance into the root, with a discriminator and a warning', async () => {
    const schema: IrSchema = await parse(
      `@Entity @DiscriminatorColumn(name = "kind", length = 8) @DiscriminatorValue("V") class Vehicle { @Id Long id; String name; }
       @Entity @DiscriminatorValue("C") class Car extends Vehicle { @Column(nullable = false) int doors; }
       @Entity class Truck extends Vehicle { Integer axles; }`
    );
    expect(schema.models.map((item) => item.name)).toEqual(['Vehicle']);
    expect(names(schema, 'Vehicle')).toEqual([
      'id',
      'name',
      'doors',
      'axles',
      'kind',
    ]);
    expect(field(schema, 'Vehicle', 'kind')).toMatchObject({
      type: 'string',
      maxLength: 8,
      isNullable: false,
    });
    // Hibernate writes NOT NULL for a subclass column that says so.
    expect(field(schema, 'Vehicle', 'doors').isNullable).toBe(false);
    expect(
      warningsMatching(
        schema,
        /Car, Truck extend Vehicle in one table.*V = Vehicle, C = Car, Truck = Truck/
      )
    ).toHaveLength(1);
  });

  it('points a relationship to a subclass at the table of the root', async () => {
    const schema: IrSchema = await parse(
      `@Entity class Vehicle { @Id Long id; }
       @Entity class Car extends Vehicle { }
       @Entity class Owner { @Id Long id; @ManyToOne Car car; }`
    );
    expect(relation(schema, 'Owner', 'car').targetModel).toBe('Vehicle');
  });

  it('reads joined inheritance as a primary key that is also a foreign key', async () => {
    const schema: IrSchema = await parse(
      `@Entity @Inheritance(strategy = InheritanceType.JOINED) abstract class Payment { @Id Long id; BigDecimal amount; }
       @Entity class Card extends Payment { String number; }
       @Entity @PrimaryKeyJoinColumn(name = "payment_id") class Bank extends Payment { String iban; }`
    );
    expect(names(schema, 'Card')).toEqual(['number']);
    expect(relation(schema, 'Card', 'payment')).toMatchObject({
      kind: 'oneToOne',
      targetModel: 'Payment',
      columnName: 'id',
      isPrimaryKey: true,
      isNullable: false,
    });
    expect(relation(schema, 'Bank', 'payment').columnName).toBe('payment_id');
    expect(warningsMatching(schema, /joined table inheritance/)).toHaveLength(
      2
    );
  });

  it('reads table per class inheritance as independent tables with the inherited columns', async () => {
    const schema: IrSchema = await parse(
      `@Entity @Inheritance(strategy = InheritanceType.TABLE_PER_CLASS) abstract class Animal { @Id Long id; String name; }
       @Entity class Dog extends Animal { boolean trained; }
       @Entity class Cat extends Animal { Integer lives; }`
    );
    expect(schema.models.map((item) => item.name)).toEqual(['Dog', 'Cat']);
    expect(names(schema, 'Dog')).toEqual(['id', 'name', 'trained']);
    expect(
      warningsMatching(schema, /table per class inheritance/)
    ).toHaveLength(2);
  });

  it('drops a relationship to an abstract table per class root, which has no table', async () => {
    const schema: IrSchema = await parse(
      `@Entity @Inheritance(strategy = InheritanceType.TABLE_PER_CLASS) abstract class Animal { @Id Long id; }
       @Entity class Dog extends Animal { }
       @Entity class Owner { @Id Long id; @ManyToOne Animal pet; }`
    );
    expect(model(schema, 'Owner').relations).toEqual([]);
    expect(
      warningsMatching(schema, /Owner\.pet: the target Animal has no table/)
    ).toHaveLength(1);
  });
});

describe('element collections', () => {
  it('reads a collection of basic values as a child table', async () => {
    const schema: IrSchema = await parse(
      thing(`@ElementCollection List<String> tags;
        @ElementCollection @Column(name = "role", nullable = false) Set<String> roles;
        @ElementCollection @OrderColumn List<String> steps;
        @ElementCollection @CollectionTable(name = "t_notes", joinColumns = @JoinColumn(name = "t_id")) List<String> notes;`)
    );
    const tags: IrModel = model(schema, 'ThingTags');
    expect(tags.tableName).toBe('Thing_tags');
    expect(tags.relations[0]).toMatchObject({
      targetModel: 'Thing',
      columnName: 'Thing_id',
      isNullable: false,
    });
    expect(tags.compositePrimaryKey).toBeUndefined();
    expect(model(schema, 'ThingRoles').compositePrimaryKey).toEqual([
      'thing',
      'roles',
    ]);
    expect(model(schema, 'ThingSteps').compositePrimaryKey).toEqual([
      'thing',
      'stepsOrder',
    ]);
    expect(model(schema, 'ThingNotes')).toMatchObject({ tableName: 't_notes' });
    expect(model(schema, 'ThingNotes').relations[0]?.columnName).toBe('t_id');
    expect(
      warningsMatching(
        schema,
        /Thing\.tags: the @ElementCollection is stored in the child table "Thing_tags"/
      )
    ).toHaveLength(1);
  });

  it('skips collections of embeddables and maps with a warning', async () => {
    const schema: IrSchema = await parse(
      `@Embeddable class Part { String x; }`,
      thing(
        `@ElementCollection List<Part> parts; @ElementCollection Map<String, String> labels;`
      )
    );
    expect(schema.models.map((item) => item.name)).toEqual(['Thing']);
    expect(
      warningsMatching(
        schema,
        /Thing\.parts: an @ElementCollection of the embeddable Part/
      )
    ).toHaveLength(1);
    expect(
      warningsMatching(
        schema,
        /Thing\.labels: an @ElementCollection that is not a List/
      )
    ).toHaveLength(1);
  });
});

describe('indexes and constraints', () => {
  it('reads unique constraints and indexes of @Table', async () => {
    const schema: IrSchema = await parse(
      `@Entity @Table(name = "t",
          uniqueConstraints = { @UniqueConstraint(name = "uq_ab", columnNames = {"a", "b"}), @UniqueConstraint(columnNames = "c") },
          indexes = { @Index(name = "ix_a", columnList = "a"), @Index(columnList = "b DESC, c asc", unique = true) })
       class T { @Id Long id; String a; String b; String c; }`
    );
    expect(model(schema, 'T').indexes).toEqual<IrIndex[]>([
      { fields: ['a', 'b'], isUnique: true, name: 'uq_ab' },
      { fields: ['a'], isUnique: false, name: 'ix_a' },
      {
        fields: ['b', 'c'],
        isUnique: true,
        fieldOptions: { b: { sort: 'desc' } },
      },
    ]);
    // A single column unique constraint without a name is the unique flag of the column.
    expect(field(schema, 'T', 'c').isUnique).toBe(true);
  });

  it('names relationships and attributes by column and warns about unknown columns', async () => {
    const schema: IrSchema = await parse(
      `@Entity @Table(indexes = { @Index(columnList = "owner_id, full_name"), @Index(columnList = "nothing") })
       class T { @Id Long id; @Column(name = "full_name") String fullName; @ManyToOne T owner; }`
    );
    expect(model(schema, 'T').indexes).toEqual([
      { fields: ['owner', 'fullName'], isUnique: false },
    ]);
    expect(
      warningsMatching(schema, /T: the index refers to "nothing"/)
    ).toHaveLength(1);
  });

  it('reads the hibernate and JPA @Table apart', async () => {
    const schema: IrSchema = expectOk(
      await parseJpa(
        [
          {
            path: 'T.java',
            text: `package demo;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
@Entity @jakarta.persistence.Table(name = "real") @org.hibernate.annotations.Table(appliesTo = "other", comment = "c")
class T { @Id Long id; }`,
          },
        ],
        { appLabel: 'app' }
      )
    );
    expect(model(schema, 'T').tableName).toBe('real');
  });
});

describe('constructs without an equivalent', () => {
  it('reports each by class, never silently', async () => {
    const schema: IrSchema = await parse(
      `@Entity @SecondaryTable(name = "x") @SqlResultSetMapping(name = "m")
         @org.hibernate.envers.Audited @org.hibernate.annotations.Check(constraints = "a > 0")
         @NamedQuery(name = "q", query = "select t from T t") class T { @Id Long id; }`
    );
    expect(warningsMatching(schema, /T: @SecondaryTable/)).toHaveLength(1);
    expect(warningsMatching(schema, /T: @SqlResultSetMapping/)).toHaveLength(1);
    expect(warningsMatching(schema, /T: @Audited/)).toHaveLength(1);
    expect(warningsMatching(schema, /T: the @Check constraint/)).toHaveLength(
      1
    );
    // Named queries are not schema and do not warn.
    expect(warningsMatching(schema, /NamedQuery/)).toHaveLength(0);
    expect(schema.warnings).toHaveLength(4);
  });
});

describe('robustness', () => {
  it('reads what it can from a file with syntax errors, with a warning', async () => {
    const result: Result<IrSchema> = await parseResult(
      `@Entity class Ok { @Id Long id; String name }`
    );
    const schema: IrSchema = expectOk(result);
    expect(model(schema, 'Ok').fields.length).toBeGreaterThan(0);
    expect(warningsMatching(schema, /syntax errors/)).toHaveLength(1);
  });

  it('never throws on odd input', async () => {
    const inputs: string[] = [
      '',
      '@',
      '@Entity',
      '@Entity class',
      '@Entity class A {',
      '@Entity class A { @Id }',
      '@Entity class A<T extends B<C>> extends A<T> { @Id T id; }',
      '@Entity class A { @Id Long id; @ManyToOne(targetEntity = ) A a; }',
      '@Entity class A extends B { } @Entity class B extends A { @Id Long id; }',
      '@Entity class A { @Id Long id; @Column(name = A.X + B.Y) String s; static final String X = Y; static final String Y = X; }',
      '@Entity class A { @Id Long id; @Embedded B b; } @Embeddable class B { @Embedded B b; }',
      '\u0000\u0001 binary ÿ',
    ];
    for (const input of inputs) {
      const result: Result<IrSchema> = await parseResult(input);
      expect(typeof result.ok).toBe('boolean');
    }
  });

  it('evaluates string constants and concatenations in annotations', async () => {
    const schema: IrSchema = await parse(
      `class Names { static final String TABLE = "t_" + "constants"; static final int SIZE = 4 * 1; }
       @Entity @Table(name = Names.TABLE) class A { static final String COL = "c"; @Id Long id; @Column(name = COL + "_x", length = 12) String s; }`
    );
    expect(model(schema, 'A').tableName).toBe('t_constants');
    expect(field(schema, 'A', 's').columnName).toBe('c_x');
    expect(field(schema, 'A', 's').maxLength).toBe(12);
  });

  it('reads duplicate class names once, with a warning', async () => {
    const result: Result<IrSchema> = await parseJpa(
      [
        { path: 'a/A.java', text: `${HEADER}@Entity class A { @Id Long id; }` },
        {
          path: 'b/A.java',
          text: `${HEADER}@Entity class A { @Id Long id; String other; }`,
        },
      ],
      { appLabel: 'app' }
    );
    const schema: IrSchema = expectOk(result);
    expect(schema.models).toHaveLength(1);
    expect(warningsMatching(schema, /Duplicate type name "A"/)).toHaveLength(1);
  });

  it('skips build output, tests and generated files with a warning', async () => {
    const schema: IrSchema = expectOk(
      await parseJpa(
        [
          {
            path: 'src/main/java/A.java',
            text: `${HEADER}@Entity class A { @Id Long id; }`,
          },
          {
            path: 'target/classes/B.java',
            text: `${HEADER}@Entity class B { @Id Long id; }`,
          },
          {
            path: 'src/test/java/C.java',
            text: `${HEADER}@Entity class C { @Id Long id; }`,
          },
          {
            path: 'src/main/java/DTest.java',
            text: `${HEADER}@Entity class D { @Id Long id; }`,
          },
          {
            path: 'src/main/java/E_.java',
            text: `${HEADER}@Entity class E { @Id Long id; }`,
          },
        ],
        { appLabel: 'app' }
      )
    );
    expect(schema.models.map((item) => item.name)).toEqual(['A']);
    expect(warningsMatching(schema, /skipped/)).toHaveLength(4);
  });

  it('knows which paths are not the model', () => {
    const skipped: string[] = [
      'target/classes/A.java',
      'build/generated/A.java',
      'out/production/A.java',
      '.gradle/x/A.java',
      'node_modules/x/A.java',
      'src/test/java/A.java',
      'src/main/java/AccountTest.java',
      'src/main/java/AccountTests.java',
      'src/main/java/module-info.java',
      'src/main/java/pkg/package-info.java',
      'src/main/java/Account_.java',
      'src/main/resources/db/migration/V1__x.java',
    ];
    for (const path of skipped) {
      expect(isSkippedJpaPath(path), path).toBe(true);
    }
    for (const path of [
      'src/main/java/Account.java',
      'src/main/java/Contest.java',
      'src/main/java/pkg/Order.java',
      'Test.java.txt',
    ]) {
      expect(isSkippedJpaPath(path), path).toBe(false);
    }
  });
});
