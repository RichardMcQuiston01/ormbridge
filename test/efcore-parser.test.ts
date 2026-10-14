import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { convertText, type ConvertResult } from '../src/convert.js';
import { getFormat, getFormatByExtension } from '../src/formats.js';
import type {
  IrField,
  IrIndex,
  IrModel,
  IrRelation,
  IrSchema,
} from '../src/ir.js';
import { runConversion } from '../src/io.js';
import {
  isSkippedEfcorePath,
  parseEfcore,
  type EfcoreSourceFile,
} from '../src/parsers/efcore.js';
import type { Result } from '../src/result.js';
import { DEFAULT_OPTIONS, expectOk } from './helpers.js';

const HEADER: string = `#nullable enable
using System.ComponentModel.DataAnnotations;
using System.ComponentModel.DataAnnotations.Schema;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

`;

/** Parses C# declarations; the usings are added to every file. */
async function parse(...texts: string[]): Promise<IrSchema> {
  return expectOk(await parseResult(...texts));
}

function parseResult(...texts: string[]): Promise<Result<IrSchema>> {
  const sources: EfcoreSourceFile[] = texts.map(
    (text: string, index: number): EfcoreSourceFile => ({
      path: `File${index}.cs`,
      text: HEADER + text,
    })
  );
  return parseEfcore(sources, { appLabel: 'app' });
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
  it('registers efcore as a read-only format without a file extension', () => {
    const adapter = expectOk(getFormat('efcore'));
    expect(adapter.extensions).toEqual([]);
    expect(adapter.parse).toBeDefined();
    expect(adapter.emit).toBeUndefined();
    expect(getFormatByExtension('.cs')).toBeUndefined();
  });

  it('converts through the adapter', async () => {
    const result: Result<ConvertResult> = await convertText(
      [
        {
          path: 'Thing.cs',
          text: `${HEADER}public class Thing { public int Id { get; set; } public string Name { get; set; } = null!; }\npublic class Ctx : DbContext { public DbSet<Thing> Things { get; set; } = null!; }`,
        },
      ],
      { ...DEFAULT_OPTIONS, from: 'efcore', to: 'prisma' }
    );
    const converted: ConvertResult = expectOk(result);
    expect(converted.output).toContain('model Thing {');
    expect(converted.output).toContain('@@map("Things")');
  });

  it('refuses to write EF Core models', async () => {
    const result: Result<ConvertResult> = await convertText(
      [{ path: 'a.prisma', text: 'model A { id Int @id }' }],
      { ...DEFAULT_OPTIONS, from: 'prisma', to: 'efcore' }
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain(
        'The format "efcore" can only be used as an input'
      );
    }
  });
});

describe('finding entities', () => {
  it('reads the types of DbSet<T> properties of a DbContext, with the property name as table', async () => {
    const schema: IrSchema = await parse(`
public class Blog { public int Id { get; set; } public string Title { get; set; } = null!; }
public class Unrelated { public int Id { get; set; } }
public class AppDbContext : DbContext {
  public DbSet<Blog> Blogs { get; set; } = null!;
}`);
    expect(schema.models.map((item: IrModel) => item.name)).toEqual(['Blog']);
    expect(model(schema, 'Blog').tableName).toBe('Blogs');
  });

  it('reads contexts that derive from another context or from IdentityDbContext', async () => {
    const schema: IrSchema = await parse(`
public class Item { public int Id { get; set; } }
public abstract class BaseContext : IdentityDbContext<AppUser> { }
public class AppContext : BaseContext { public DbSet<Item> Items => Set<Item>(); }`);
    expect(model(schema, 'Item').tableName).toBe('Items');
  });

  it('reads entities named by modelBuilder.Entity<T>() and uses the type name as table', async () => {
    const schema: IrSchema = await parse(`
public class Gadget { public int Id { get; set; } }
public class Ctx : DbContext {
  protected override void OnModelCreating(ModelBuilder modelBuilder) {
    modelBuilder.Entity<Gadget>();
  }
}`);
    expect(model(schema, 'Gadget').tableName).toBe('Gadget');
  });

  it('reads classes that implement IEntityTypeConfiguration<T>, applied or not', async () => {
    const schema: IrSchema = await parse(`
public class Gizmo { public int Id { get; set; } public string Name { get; set; } = null!; }
public class GizmoConfig : IEntityTypeConfiguration<Gizmo> {
  public void Configure(EntityTypeBuilder<Gizmo> builder) {
    builder.ToTable("gizmos");
    builder.Property(g => g.Name).HasMaxLength(30);
  }
}`);
    expect(model(schema, 'Gizmo').tableName).toBe('gizmos');
    expect(field(schema, 'Gizmo', 'name').maxLength).toBe(30);
  });

  it('warns about a configuration class that no context applies, and reads it anyway', async () => {
    const schema: IrSchema = await parse(`
public class Gizmo { public int Id { get; set; } }
public class Ctx : DbContext { public DbSet<Gizmo> Gizmos => Set<Gizmo>(); }
public class GizmoConfig : IEntityTypeConfiguration<Gizmo> {
  public void Configure(EntityTypeBuilder<Gizmo> builder) { builder.ToTable("g"); }
}`);
    expect(model(schema, 'Gizmo').tableName).toBe('g');
    expect(warningsMatching(schema, /GizmoConfig .*not applied/)).toHaveLength(
      1
    );
  });

  it('applies configuration classes through ApplyConfiguration and ApplyConfigurationsFromAssembly', async () => {
    const schema: IrSchema = await parse(`
public class A { public int Id { get; set; } }
public class B { public int Id { get; set; } }
public class AConfig : IEntityTypeConfiguration<A> { public void Configure(EntityTypeBuilder<A> b) { b.ToTable("a_table"); } }
public class BConfig : IEntityTypeConfiguration<B> { public void Configure(EntityTypeBuilder<B> b) { b.ToTable("b_table"); } }
public class Ctx : DbContext {
  public DbSet<A> As => Set<A>();
  public DbSet<B> Bs => Set<B>();
  protected override void OnModelCreating(ModelBuilder modelBuilder) {
    modelBuilder.ApplyConfiguration(new AConfig());
    modelBuilder.ApplyConfigurationsFromAssembly(typeof(Ctx).Assembly);
  }
}`);
    expect(model(schema, 'A').tableName).toBe('a_table');
    expect(model(schema, 'B').tableName).toBe('b_table');
    expect(warningsMatching(schema, /not applied/)).toEqual([]);
  });

  it('reads classes that carry data annotations of the model, without any context', async () => {
    const schema: IrSchema = await parse(`
[Table("t_one")] public class One { public int Id { get; set; } }
public class Two { [Key] public int Code { get; set; } }
public class Three { [Required] [MaxLength(10)] public string Name { get; set; } = null!; }`);
    expect(schema.models.map((item: IrModel) => item.name)).toEqual([
      'One',
      'Two',
    ]);
  });

  it('adds entities that are reached through navigation properties', async () => {
    const schema: IrSchema = await parse(`
public class Owner { public int Id { get; set; } public List<Pet> Pets { get; set; } = new(); }
public class Pet { public int Id { get; set; } public int OwnerId { get; set; } public Owner Owner { get; set; } = null!; public Toy? Toy { get; set; } }
public class Toy { public int Id { get; set; } public int PetId { get; set; } }
public class Ctx : DbContext { public DbSet<Owner> Owners => Set<Owner>(); }`);
    expect(schema.models.map((item: IrModel) => item.name).sort()).toEqual([
      'Owner',
      'Pet',
      'Toy',
    ]);
  });

  it('does not treat abstract or base classes without a DbSet as entities', async () => {
    const schema: IrSchema = await parse(`
public abstract class Entity { [Key] public int Id { get; set; } public DateTime Created { get; set; } }
public class Real : Entity { [MaxLength(5)] public string Name { get; set; } = null!; }`);
    expect(schema.models.map((item: IrModel) => item.name)).toEqual(['Real']);
    expect(names(schema, 'Real')).toEqual(['id', 'created', 'name']);
  });

  it('skips classes marked [NotMapped], [Owned] and [Keyless] views without a table', async () => {
    const schema: IrSchema = await parse(`
[NotMapped] [Table("x")] public class Hidden { public int Id { get; set; } }
[Owned] public class Money { public decimal Amount { get; set; } public string Currency { get; set; } = null!; }
public class Invoice { public int Id { get; set; } public Money Total { get; set; } = null!; }
public class Ctx : DbContext { public DbSet<Invoice> Invoices => Set<Invoice>(); }`);
    expect(schema.models.map((item: IrModel) => item.name)).toEqual([
      'Invoice',
    ]);
    expect(names(schema, 'Invoice')).toEqual([
      'id',
      'totalAmount',
      'totalCurrency',
    ]);
    expect(field(schema, 'Invoice', 'totalAmount').columnName).toBe(
      'Total_Amount'
    );
  });

  it('fails with a descriptive error when no entity is found', async () => {
    const result: Result<IrSchema> = await parseResult(
      'public class Plain { public int Id { get; set; } }'
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('NO_MODELS_FOUND');
      expect(result.error.message).toContain('DbSet<T>');
      expect(result.error.message).toContain('File0.cs');
    }
  });

  it('merges partial classes and keeps the first of duplicate type names', async () => {
    const schema: IrSchema = await parse(
      `public partial class Part { public int Id { get; set; } }
public class Ctx : DbContext { public DbSet<Part> Parts => Set<Part>(); }`,
      `public partial class Part { public string Name { get; set; } = null!; }`,
      `public class Ctx2 : DbContext { public DbSet<Dup> Dups => Set<Dup>(); }
public class Dup { public int Id { get; set; } }`,
      `public class Dup { public int Id { get; set; } public int Extra { get; set; } }`
    );
    expect(names(schema, 'Part')).toEqual(['id', 'name']);
    expect(names(schema, 'Dup')).toEqual(['id']);
    expect(warningsMatching(schema, /Duplicate type name "Dup"/)).toHaveLength(
      1
    );
  });
});

describe('skipped files', () => {
  it('recognizes migrations, build output and generated files', () => {
    expect(isSkippedEfcorePath('src/Data/Migrations/20240101_Init.cs')).toBe(
      true
    );
    expect(isSkippedEfcorePath('src\\Data\\Migrations\\Init.cs')).toBe(true);
    expect(isSkippedEfcorePath('obj/Debug/net8.0/Foo.cs')).toBe(true);
    expect(isSkippedEfcorePath('bin/Release/Foo.cs')).toBe(true);
    expect(isSkippedEfcorePath('Migrations/Init.Designer.cs')).toBe(true);
    expect(isSkippedEfcorePath('Data/AppDbContextModelSnapshot.cs')).toBe(true);
    expect(isSkippedEfcorePath('Models/Post.cs')).toBe(false);
    expect(isSkippedEfcorePath('Models/Migrationsy.cs')).toBe(false);
  });

  it('ignores such files given to the parser, with a warning', async () => {
    const schema: IrSchema = expectOk(
      await parseEfcore(
        [
          {
            path: 'Models/Thing.cs',
            text: `${HEADER}public class Thing { public int Id { get; set; } }\npublic class C : DbContext { public DbSet<Thing> Things => Set<Thing>(); }`,
          },
          {
            path: 'Migrations/AppContextModelSnapshot.cs',
            text: `${HEADER}public class Snapshot : ModelSnapshot { }`,
          },
        ],
        { appLabel: 'app' }
      )
    );
    expect(schema.models).toHaveLength(1);
    expect(warningsMatching(schema, /Snapshot.*skipped/)).toHaveLength(1);
  });
});

describe('data annotations', () => {
  it('reads [Table] with a schema, [Column] with a name and type, [Key] and [Required]', async () => {
    const schema: IrSchema = await parse(`
[Table("people", Schema = "hr")]
public class Person {
  [Key] [Column("person_no")] public int No { get; set; }
  [Column("full_name", TypeName = "varchar(80)")] [Required] public string? Name { get; set; }
  [Column(TypeName = "decimal(10, 3)")] public decimal Score { get; set; }
}`);
    const person: IrModel = model(schema, 'Person');
    expect(person.tableName).toBe('people');
    expect(person.schema).toBe('hr');
    expect(field(schema, 'Person', 'no')).toMatchObject({
      columnName: 'person_no',
      isPrimaryKey: true,
      default: { kind: 'autoIncrement' },
    });
    expect(field(schema, 'Person', 'name')).toMatchObject({
      columnName: 'full_name',
      type: 'string',
      maxLength: 80,
      isNullable: false,
    });
    expect(field(schema, 'Person', 'score')).toMatchObject({
      type: 'decimal',
      maxDigits: 10,
      decimalPlaces: 3,
    });
  });

  it('reads [MaxLength] and [StringLength], and gives unbounded strings the text type', async () => {
    const schema: IrSchema = await parse(`
[Table("t")] public class T {
  public int Id { get; set; }
  [MaxLength(30)] public string A { get; set; } = null!;
  [StringLength(40, MinimumLength = 2)] public string B { get; set; } = null!;
  public string C { get; set; } = null!;
  [Column(TypeName = "nvarchar(max)")] public string D { get; set; } = null!;
  [MaxLength(16)] public byte[] E { get; set; } = null!;
}`);
    expect(field(schema, 'T', 'a')).toMatchObject({
      type: 'string',
      maxLength: 30,
    });
    expect(field(schema, 'T', 'b')).toMatchObject({
      type: 'string',
      maxLength: 40,
    });
    expect(field(schema, 'T', 'c').type).toBe('text');
    expect(field(schema, 'T', 'd').type).toBe('text');
    expect(field(schema, 'T', 'e').type).toBe('bytes');
  });

  it('reads class-level [Index] attributes: unique, named, composite and descending', async () => {
    const schema: IrSchema = await parse(`
[Index(nameof(Email), IsUnique = true)]
[Index(nameof(Last), nameof(First), Name = "ix_name")]
[Index("City", IsDescending = new[] { true })]
[Index(nameof(Code), IsUnique = true, Name = "ux_code")]
public class P {
  public int Id { get; set; }
  public string Email { get; set; } = null!;
  public string First { get; set; } = null!;
  public string Last { get; set; } = null!;
  public string City { get; set; } = null!;
  public string Code { get; set; } = null!;
}`);
    expect(field(schema, 'P', 'email').isUnique).toBe(true);
    const indexes: IrIndex[] = model(schema, 'P').indexes;
    expect(indexes).toContainEqual({
      fields: ['last', 'first'],
      isUnique: false,
      name: 'ix_name',
    });
    expect(indexes).toContainEqual({
      fields: ['city'],
      isUnique: false,
      fieldOptions: { city: { sort: 'desc' } },
    });
    expect(indexes).toContainEqual({
      fields: ['code'],
      isUnique: true,
      name: 'ux_code',
    });
    expect(field(schema, 'P', 'code').isUnique).toBe(false);
  });

  it('reads [PrimaryKey] on the class and several [Key] properties through HasKey', async () => {
    const schema: IrSchema = await parse(`
[PrimaryKey(nameof(A), nameof(B))]
public class Pair { public int A { get; set; } public int B { get; set; } public string V { get; set; } = null!; }
public class Ctx : DbContext { public DbSet<Pair> Pairs => Set<Pair>(); }`);
    expect(model(schema, 'Pair').compositePrimaryKey).toEqual(['a', 'b']);
    expect(field(schema, 'Pair', 'a').isPrimaryKey).toBe(false);
    expect(field(schema, 'Pair', 'a').default).toBeUndefined();
  });

  it('reads [DatabaseGenerated], [Timestamp], [Precision], [ConcurrencyCheck] and [Comment]', async () => {
    const schema: IrSchema = await parse(`
[Table("g")] public class G {
  [Key] [DatabaseGenerated(DatabaseGeneratedOption.None)] public int Id { get; set; }
  [DatabaseGenerated(DatabaseGeneratedOption.Identity)] public int Seq { get; set; }
  [Timestamp] public byte[]? Stamp { get; set; }
  [Precision(12, 4)] public decimal Money { get; set; }
  [ConcurrencyCheck] public int Rev { get; set; }
  [Comment("Shown to users")] public string Label { get; set; } = null!;
  [NotMapped] public int Skipped { get; set; }
}`);
    expect(field(schema, 'G', 'id').default).toBeUndefined();
    expect(field(schema, 'G', 'seq').default).toEqual({
      kind: 'autoIncrement',
    });
    expect(field(schema, 'G', 'stamp').type).toBe('bytes');
    expect(field(schema, 'G', 'money')).toMatchObject({
      maxDigits: 12,
      decimalPlaces: 4,
    });
    expect(names(schema, 'G')).not.toContain('skipped');
    expect(warningsMatching(schema, /G\.Stamp: the row version/)).toHaveLength(
      1
    );
    expect(
      warningsMatching(schema, /G\.Rev: the concurrency token/)
    ).toHaveLength(1);
    expect(warningsMatching(schema, /G: comments \(Label\)/)).toHaveLength(1);
  });

  it('reads [ForeignKey] on the navigation, on the key property, and on the collection', async () => {
    const schema: IrSchema = await parse(`
public class Dept { public int Id { get; set; }
  [ForeignKey("DeptRef")] public List<Emp> Staff { get; set; } = new(); }
public class Emp { public int Id { get; set; } public int DeptRef { get; set; } }
public class Home { public int Id { get; set; } public List<Tenant> Tenants { get; set; } = new(); }
public class Tenant { public int Id { get; set; } public int Place { get; set; } [ForeignKey(nameof(Place))] public Home Residence { get; set; } = null!; }
public class Shop { public int Id { get; set; } public List<Sale> Sales { get; set; } = new(); }
public class Sale { public int Id { get; set; } [ForeignKey(nameof(Outlet))] public int Where { get; set; } public Shop Outlet { get; set; } = null!; }
public class Ctx : DbContext { public DbSet<Dept> Depts => Set<Dept>(); public DbSet<Home> Homes => Set<Home>(); public DbSet<Shop> Shops => Set<Shop>(); }`);
    // [ForeignKey] on the collection names the key column on the other entity.
    expect(
      model(schema, 'Emp').relations.map((item) => item.columnName)
    ).toEqual(['DeptRef']);
    // [ForeignKey] on the navigation names the key property of the same class.
    expect(relation(schema, 'Tenant', 'residence')).toMatchObject({
      columnName: 'Place',
      relatedName: 'tenants',
    });
    // [ForeignKey] on the key property names the navigation.
    expect(relation(schema, 'Sale', 'outlet')).toMatchObject({
      columnName: 'Where',
      relatedName: 'sales',
    });
    expect(names(schema, 'Sale')).toEqual(['id']);
  });

  it('pairs navigations with [InverseProperty]', async () => {
    const schema: IrSchema = await parse(`
public class User { public int Id { get; set; }
  [InverseProperty(nameof(Post.Author))] public List<Post> Written { get; set; } = new();
  [InverseProperty(nameof(Post.Editor))] public List<Post> Edited { get; set; } = new(); }
public class Post { public int Id { get; set; } public int AuthorId { get; set; } public User Author { get; set; } = null!;
  public int? EditorId { get; set; } public User? Editor { get; set; } }
public class Ctx : DbContext { public DbSet<User> Users => Set<User>(); }`);
    expect(relation(schema, 'Post', 'author').relatedName).toBe('written');
    expect(relation(schema, 'Post', 'editor').relatedName).toBe('edited');
  });
});

describe('keys and conventions', () => {
  it('finds Id and <Type>Id keys ignoring case, and numbers integer keys', async () => {
    const schema: IrSchema = await parse(`
public class A { public int ID { get; set; } }
public class B { public long BId { get; set; } }
public class C { public short Id { get; set; } public int CId { get; set; } }
public class Ctx : DbContext { public DbSet<A> As => Set<A>(); public DbSet<B> Bs => Set<B>(); public DbSet<C> Cs => Set<C>(); }`);
    expect(field(schema, 'A', 'id')).toMatchObject({
      isPrimaryKey: true,
      default: { kind: 'autoIncrement' },
    });
    expect(field(schema, 'B', 'bId')).toMatchObject({
      isPrimaryKey: true,
      type: 'bigInt',
    });
    expect(field(schema, 'C', 'id').isPrimaryKey).toBe(true);
    expect(field(schema, 'C', 'cId').isPrimaryKey).toBe(false);
  });

  it('maps Guid keys to uuid and leaves string keys without a default', async () => {
    const schema: IrSchema = await parse(`
public class G { public Guid Id { get; set; } }
public class S { public string Id { get; set; } = null!; }
public class Ctx : DbContext { public DbSet<G> Gs => Set<G>(); public DbSet<S> Ss => Set<S>(); }`);
    expect(field(schema, 'G', 'id')).toMatchObject({
      type: 'uuid',
      isPrimaryKey: true,
      default: { kind: 'uuid' },
    });
    expect(field(schema, 'S', 'id')).toMatchObject({
      type: 'text',
      isPrimaryKey: true,
    });
    expect(field(schema, 'S', 'id').default).toBeUndefined();
  });

  it('does not number a key that the fluent API marks ValueGeneratedNever', async () => {
    const schema: IrSchema = await parse(`
public class K { public int Id { get; set; } }
public class Ctx : DbContext { public DbSet<K> Ks => Set<K>();
  protected override void OnModelCreating(ModelBuilder modelBuilder) {
    modelBuilder.Entity<K>().Property(k => k.Id).ValueGeneratedNever();
  } }`);
    expect(field(schema, 'K', 'id').default).toBeUndefined();
  });

  it('warns about an entity without a key and about a keyless entity', async () => {
    const schema: IrSchema = await parse(`
public class NoKey { public string Name { get; set; } = null!; }
[Keyless] public class Report { public string Name { get; set; } = null!; }
public class Ctx : DbContext { public DbSet<NoKey> Nk => Set<NoKey>(); public DbSet<Report> Rs => Set<Report>(); }`);
    expect(
      warningsMatching(schema, /NoKey: the entity has no primary key/)
    ).toHaveLength(1);
    expect(
      warningsMatching(schema, /Report: the entity has no key \(HasNoKey\)/)
    ).toHaveLength(1);
  });

  it('makes reference types nullable without nullable reference types, and not null with them', async () => {
    const oblivious: IrSchema = expectOk(
      await parseEfcore(
        [
          {
            path: 'a.cs',
            text: `public class A { public int Id { get; set; } public string Name { get; set; } [System.ComponentModel.DataAnnotations.Required] public string Req { get; set; } public int? N { get; set; } }
public class C : Microsoft.EntityFrameworkCore.DbContext { public DbSet<A> As => Set<A>(); }`,
          },
        ],
        { appLabel: 'app' }
      )
    );
    expect(field(oblivious, 'A', 'name').isNullable).toBe(true);
    expect(field(oblivious, 'A', 'req').isNullable).toBe(false);
    expect(field(oblivious, 'A', 'n').isNullable).toBe(true);
    const enabled: IrSchema = await parse(`
public class A { public int Id { get; set; } public string Name { get; set; } = null!; public string? Opt { get; set; } }
public class C : DbContext { public DbSet<A> As => Set<A>(); }`);
    expect(field(enabled, 'A', 'name').isNullable).toBe(false);
    expect(field(enabled, 'A', 'opt').isNullable).toBe(true);
  });

  it('treats a file as nullable-aware when reference types are written with ?', async () => {
    const schema: IrSchema = expectOk(
      await parseEfcore(
        [
          {
            path: 'a.cs',
            text: `public class A { public int Id { get; set; } public string Name { get; set; } = ""; public string? Opt { get; set; } }
public class C : DbContext { public DbSet<A> As => Set<A>(); }`,
          },
        ],
        { appLabel: 'app' }
      )
    );
    expect(field(schema, 'A', 'name').isNullable).toBe(false);
  });

  it('honours #nullable disable', async () => {
    const schema: IrSchema = expectOk(
      await parseEfcore(
        [
          {
            path: 'a.cs',
            text: `#nullable disable
public class A { public int Id { get; set; } public string Name { get; set; } }
public class C : DbContext { public DbSet<A> As => Set<A>(); }`,
          },
        ],
        { appLabel: 'app' }
      )
    );
    expect(field(schema, 'A', 'name').isNullable).toBe(true);
  });
});

describe('column types', () => {
  it('maps CLR types', async () => {
    const schema: IrSchema = await parse(`
public class T {
  public int Id { get; set; }
  public int I { get; set; } public uint U { get; set; } public short S { get; set; } public byte By { get; set; } public sbyte Sb { get; set; }
  public long L { get; set; } public bool Flag { get; set; } public char Ch { get; set; }
  public decimal Dec { get; set; } public double Dbl { get; set; } public float Flt { get; set; }
  public DateTime Dt { get; set; } public DateTimeOffset Dto { get; set; } public DateOnly Do { get; set; } public TimeOnly To { get; set; }
  public TimeSpan Ts { get; set; } public Guid G { get; set; } public byte[] Bytes { get; set; } = null!;
  public System.Text.Json.JsonDocument Doc { get; set; } = null!; public System.Net.IPAddress Ip { get; set; } = null!;
  public Uri Link { get; set; } = null!;
}
public class Ctx : DbContext { public DbSet<T> Ts => Set<T>(); }`);
    const types: Record<string, string> = {};
    for (const item of model(schema, 'T').fields) {
      types[item.name] = item.type;
    }
    expect(types).toEqual({
      id: 'int',
      i: 'int',
      u: 'int',
      s: 'int',
      by: 'int',
      sb: 'int',
      l: 'bigInt',
      flag: 'boolean',
      ch: 'string',
      dec: 'decimal',
      dbl: 'float',
      flt: 'float',
      dt: 'dateTime',
      dto: 'dateTime',
      do: 'date',
      to: 'time',
      ts: 'duration',
      g: 'uuid',
      bytes: 'bytes',
      doc: 'json',
      ip: 'ipAddress',
      link: 'text',
    });
    expect(field(schema, 'T', 'ch').maxLength).toBe(1);
  });

  it('reads Nullable<T>, T? and arrays of scalars', async () => {
    const schema: IrSchema = await parse(`
public class T {
  public int Id { get; set; }
  public Nullable<int> A { get; set; } public int? B { get; set; } public Guid? C { get; set; }
  public string[] Tags { get; set; } = null!; public List<int> Numbers { get; set; } = null!; public int[][] Grid { get; set; } = null!;
}
public class Ctx : DbContext { public DbSet<T> Ts => Set<T>(); }`);
    expect(field(schema, 'T', 'a')).toMatchObject({
      type: 'int',
      isNullable: true,
    });
    expect(field(schema, 'T', 'b').isNullable).toBe(true);
    expect(field(schema, 'T', 'c')).toMatchObject({
      type: 'uuid',
      isNullable: true,
    });
    expect(field(schema, 'T', 'tags')).toMatchObject({
      type: 'text',
      arrayDepth: 1,
    });
    expect(field(schema, 'T', 'numbers')).toMatchObject({
      type: 'int',
      arrayDepth: 1,
    });
    expect(field(schema, 'T', 'grid').arrayDepth).toBe(2);
  });

  it('maps database column types given with HasColumnType and [Column(TypeName)]', async () => {
    const schema: IrSchema = await parse(`
public class T {
  public int Id { get; set; }
  [Column(TypeName = "timestamp with time zone")] public DateTime A { get; set; }
  [Column(TypeName = "jsonb")] public string B { get; set; } = null!;
  [Column(TypeName = "numeric(9,2)")] public double C { get; set; }
  [Column(TypeName = "citext")] public string D { get; set; } = null!;
  [Column(TypeName = "character varying(5)")] public string E { get; set; } = null!;
  [Column(TypeName = "geography")] public string F { get; set; } = null!;
}
public class Ctx : DbContext { public DbSet<T> Ts => Set<T>();
  protected override void OnModelCreating(ModelBuilder b) { b.Entity<T>().Property(t => t.D).HasColumnType("text"); } }`);
    expect(field(schema, 'T', 'a').type).toBe('dateTime');
    expect(field(schema, 'T', 'b').type).toBe('json');
    expect(field(schema, 'T', 'c')).toMatchObject({
      type: 'decimal',
      maxDigits: 9,
      decimalPlaces: 2,
    });
    expect(field(schema, 'T', 'e')).toMatchObject({
      type: 'string',
      maxLength: 5,
    });
    // An unknown column type keeps the CLR type and says so.
    expect(field(schema, 'T', 'f').type).toBe('text');
    expect(
      warningsMatching(schema, /column type "geography" is not recognised/)
    ).toHaveLength(1);
  });

  it('reads types the model cannot name as unsupported columns with a warning', async () => {
    const schema: IrSchema = await parse(`
public class T { public int Id { get; set; } public NetTopologySuite.Geometries.Point Where { get; set; } = null!; public object Any { get; set; } = null!; }
public class Ctx : DbContext { public DbSet<T> Ts => Set<T>(); }`);
    expect(field(schema, 'T', 'where')).toMatchObject({
      type: 'unsupported',
      unsupportedType: 'NetTopologySuite.Geometries.Point',
    });
    expect(field(schema, 'T', 'any').type).toBe('unsupported');
    expect(warningsMatching(schema, /T.Where: the type/)).toHaveLength(1);
  });

  it('skips navigations to types that are not in the input, with a warning', async () => {
    const schema: IrSchema = await parse(`
public class T { public int Id { get; set; } public int OwnerId { get; set; } public AppUser Owner { get; set; } = null!; public List<Audit> Audits { get; set; } = new(); }
public class Ctx : DbContext { public DbSet<T> Ts => Set<T>(); }`);
    expect(names(schema, 'T')).toEqual(['id', 'ownerId']);
    expect(warningsMatching(schema, /not a model in the input/)).toHaveLength(
      2
    );
  });

  it('reads enums as IR enums: integers by default, names with HasConversion<string>()', async () => {
    const schema: IrSchema = await parse(`
public enum Level { Low = 1, High = 5 }
public enum Kind { A, B, C }
public class T { public int Id { get; set; } public Level Level { get; set; } public Kind Kind { get; set; } public Kind? Maybe { get; set; } }
public class Ctx : DbContext { public DbSet<T> Ts => Set<T>();
  protected override void OnModelCreating(ModelBuilder b) {
    b.Entity<T>().Property(t => t.Kind).HasConversion<string>().HasMaxLength(8);
    b.Entity<T>().Property(t => t.Maybe).HasConversion<string>();
  } }`);
    expect(schema.enums).toEqual([
      {
        name: 'Level',
        values: [
          { name: 'Low', dbValue: '1' },
          { name: 'High', dbValue: '5' },
        ],
      },
      {
        name: 'Kind',
        values: [
          { name: 'A', dbValue: 'A' },
          { name: 'B', dbValue: 'B' },
          { name: 'C', dbValue: 'C' },
        ],
      },
    ]);
    expect(field(schema, 'T', 'level')).toMatchObject({
      type: 'int',
      enumName: 'Level',
    });
    expect(field(schema, 'T', 'kind')).toMatchObject({
      type: 'string',
      enumName: 'Kind',
      maxLength: 8,
    });
    expect(field(schema, 'T', 'maybe')).toMatchObject({
      enumName: 'Kind',
      isNullable: true,
    });
    expect(
      warningsMatching(schema, /enum Level is stored as an integer/)
    ).toHaveLength(1);
  });

  it('keeps one enum definition when a C# enum is stored as text in one column and as a number in another', async () => {
    const schema: IrSchema = await parse(`
public enum Kind { A, B }
public class T { public int Id { get; set; } public Kind One { get; set; } public Kind Two { get; set; } }
public class Ctx : DbContext { public DbSet<T> Ts => Set<T>();
  protected override void OnModelCreating(ModelBuilder b) { b.Entity<T>().Property(t => t.One).HasConversion<string>(); } }`);
    expect(schema.enums).toEqual([
      {
        name: 'Kind',
        values: [
          { name: 'A', dbValue: 'A' },
          { name: 'B', dbValue: 'B' },
        ],
      },
    ]);
    expect(
      warningsMatching(schema, /stored differently in different columns/)
    ).toHaveLength(1);
  });

  it('omits enums that no entity uses', async () => {
    const schema: IrSchema = await parse(`
public enum Unused { A }
public class T { public int Id { get; set; } }
public class Ctx : DbContext { public DbSet<T> Ts => Set<T>(); }`);
    expect(schema.enums).toEqual([]);
  });

  it('substitutes the type arguments of generic base classes', async () => {
    const schema: IrSchema = await parse(`
public abstract class Entity<TKey> { public TKey Id { get; set; } = default!; public DateTime Created { get; set; } }
public class Doc : Entity<Guid> { public string Title { get; set; } = null!; }
public class Note : Entity<long> { }
public class Ctx : DbContext { public DbSet<Doc> Docs => Set<Doc>(); public DbSet<Note> Notes => Set<Note>(); }`);
    expect(field(schema, 'Doc', 'id').type).toBe('uuid');
    expect(field(schema, 'Note', 'id').type).toBe('bigInt');
  });

  it('reads records with positional parameters and properties', async () => {
    const schema: IrSchema = await parse(`
public record Point(int Id, string Label) { public int X { get; init; } }
public class Ctx : DbContext { public DbSet<Point> Points => Set<Point>(); }`);
    expect(names(schema, 'Point')).toEqual(['id', 'label', 'x']);
  });

  it('ignores static, computed, get-only and field members', async () => {
    const schema: IrSchema = await parse(`
public class T {
  public int Id { get; set; }
  public static int Counter { get; set; }
  public string Full => First + "!";
  public string First { get; set; } = "";
  public int Ro { get; }
  public int Field;
  public int Calc { get { return 1; } }
  private string Secret { get; set; } = "";
}
public class Ctx : DbContext { public DbSet<T> Ts => Set<T>(); }`);
    expect(names(schema, 'T')).toEqual(['id', 'first', 'secret']);
  });

  it('resolves constants used as attribute arguments', async () => {
    const schema: IrSchema = await parse(`
public static class Names { public const string People = "people_tbl"; public const int Len = 12; }
[Table(Names.People)] public class P { public int Id { get; set; } [MaxLength(Names.Len)] public string N { get; set; } = null!; }`);
    expect(model(schema, 'P').tableName).toBe('people_tbl');
    expect(field(schema, 'P', 'n').maxLength).toBe(12);
  });
});

describe('the fluent API', () => {
  const context = (body: string, extra: string = ''): string => `
${extra}
public class Ctx : DbContext {
  public DbSet<T> Ts => Set<T>();
  protected override void OnModelCreating(ModelBuilder modelBuilder) {
    ${body}
  }
}`;

  it('reads ToTable with a schema, HasKey, HasColumnName and HasMaxLength', async () => {
    const schema: IrSchema = await parse(
      context(
        `modelBuilder.Entity<T>(e => {
          e.ToTable("things", "inv");
          e.HasKey(t => t.Code);
          e.Property(t => t.Code).HasColumnName("code").HasMaxLength(8).ValueGeneratedNever();
          e.Property("Note").HasMaxLength(40);
        });`,
        `public class T { public string Code { get; set; } = null!; public string? Note { get; set; } }`
      )
    );
    expect(model(schema, 'T')).toMatchObject({
      tableName: 'things',
      schema: 'inv',
    });
    expect(field(schema, 'T', 'code')).toMatchObject({
      columnName: 'code',
      isPrimaryKey: true,
      maxLength: 8,
    });
    expect(field(schema, 'T', 'note').maxLength).toBe(40);
  });

  it('reads chained statements on Entity<T>() and the default schema', async () => {
    const schema: IrSchema = await parse(
      context(
        `modelBuilder.HasDefaultSchema("app");
        modelBuilder.Entity<T>().ToTable("x").HasKey(t => t.Id);`,
        `public class T { public int Id { get; set; } }`
      )
    );
    expect(model(schema, 'T')).toMatchObject({
      tableName: 'x',
      schema: 'app',
    });
  });

  it('reads defaults: values, SQL, generated values and computed columns', async () => {
    const schema: IrSchema = await parse(
      context(
        `modelBuilder.Entity<T>(e => {
          e.Property(t => t.A).HasDefaultValue(7);
          e.Property(t => t.B).HasDefaultValue("hi");
          e.Property(t => t.C).HasDefaultValue(true);
          e.Property(t => t.D).HasDefaultValueSql("GETUTCDATE()");
          e.Property(t => t.E).HasDefaultValueSql("newid()");
          e.Property(t => t.F).HasDefaultValueSql("lower(Name)");
          e.Property(t => t.G).HasComputedColumnSql("A * 2", stored: true);
          e.Property(t => t.H).ValueGeneratedOnAddOrUpdate();
          e.Property(t => t.I).HasDefaultValue(Level.High);
          e.Property(t => t.J).HasDefaultValueSql("42");
          e.Property(t => t.K).HasDefaultValue(DateTime.UtcNow);
          e.Property(t => t.L).HasDefaultValue(compute());
        });`,
        `public enum Level { Low, High }
public class T { public int Id { get; set; } public int A { get; set; } public string B { get; set; } = null!; public bool C { get; set; }
  public DateTime D { get; set; } public Guid E { get; set; } public string F { get; set; } = null!; public int G { get; set; } public DateTime H { get; set; }
  public Level I { get; set; } public int J { get; set; } public DateTime K { get; set; } public int L { get; set; } public string Name { get; set; } = null!; }`
      )
    );
    expect(field(schema, 'T', 'a').default).toEqual({
      kind: 'literal',
      value: 7,
    });
    expect(field(schema, 'T', 'b').default).toEqual({
      kind: 'literal',
      value: 'hi',
    });
    expect(field(schema, 'T', 'c').default).toEqual({
      kind: 'literal',
      value: true,
    });
    expect(field(schema, 'T', 'd').default).toEqual({ kind: 'now' });
    expect(field(schema, 'T', 'e').default).toEqual({ kind: 'uuid' });
    expect(field(schema, 'T', 'f').default).toEqual({
      kind: 'dbExpression',
      expression: 'lower(Name)',
    });
    expect(field(schema, 'T', 'g').generated).toEqual({
      expression: 'A * 2',
      isStored: true,
    });
    expect(field(schema, 'T', 'h').isAutoUpdated).toBe(true);
    expect(field(schema, 'T', 'i').default).toEqual({
      kind: 'enumValue',
      value: 'High',
    });
    expect(field(schema, 'T', 'j').default).toEqual({
      kind: 'literal',
      value: 42,
    });
    expect(field(schema, 'T', 'k').default).toEqual({ kind: 'now' });
    expect(field(schema, 'T', 'l').default).toBeUndefined();
    expect(
      warningsMatching(schema, /default value expression "compute\(\)"/)
    ).toHaveLength(1);
  });

  it('reads IsRequired, IsRequired(false), IsUnicode and HasPrecision', async () => {
    const schema: IrSchema = await parse(
      context(
        `modelBuilder.Entity<T>(e => {
          e.Property(t => t.A).IsRequired();
          e.Property(t => t.B).IsRequired(false);
          e.Property(t => t.C).HasPrecision(10, 4);
          e.Property(t => t.D).IsFixedLength();
        });`,
        `public class T { public int Id { get; set; } public string? A { get; set; } public string B { get; set; } = null!; public decimal C { get; set; } public string D { get; set; } = null!; }`
      )
    );
    expect(field(schema, 'T', 'a').isNullable).toBe(false);
    expect(field(schema, 'T', 'b').isNullable).toBe(true);
    expect(field(schema, 'T', 'c')).toMatchObject({
      maxDigits: 10,
      decimalPlaces: 4,
    });
    expect(
      warningsMatching(schema, /IsFixedLength\(\.\.\.\) is not interpreted/)
    ).toHaveLength(1);
  });

  it('reads HasIndex: unique, named, composite, filtered and with the name argument', async () => {
    const schema: IrSchema = await parse(
      context(
        `modelBuilder.Entity<T>(e => {
          e.HasIndex(t => t.A).IsUnique();
          e.HasIndex(t => new { t.B, t.C }).HasDatabaseName("ix_bc");
          e.HasIndex(t => t.D, "ix_d").HasFilter("[D] > 0");
          e.HasIndex("B", "A").IsUnique().HasDatabaseName("ux_ba");
          e.HasIndex(t => t.E).IncludeProperties(t => t.A).IsDescending();
          e.HasIndex(t => t.A).HasMethod("gin");
        });`,
        `public class T { public int Id { get; set; } public int A { get; set; } public int B { get; set; } public int C { get; set; } public int D { get; set; } public int E { get; set; } }`
      )
    );
    expect(field(schema, 'T', 'a').isUnique).toBe(true);
    const indexes: IrIndex[] = model(schema, 'T').indexes;
    expect(indexes).toContainEqual({
      fields: ['b', 'c'],
      isUnique: false,
      name: 'ix_bc',
    });
    expect(indexes).toContainEqual({
      fields: ['d'],
      isUnique: false,
      name: 'ix_d',
    });
    expect(indexes).toContainEqual({
      fields: ['b', 'a'],
      isUnique: true,
      name: 'ux_ba',
    });
    expect(indexes).toContainEqual({
      fields: ['e'],
      isUnique: false,
      fieldOptions: { e: { sort: 'desc' } },
    });
    expect(indexes).toContainEqual({
      fields: ['a'],
      isUnique: false,
      method: 'Gin',
    });
    expect(warningsMatching(schema, /ix_d. has a filter/)).toHaveLength(1);
    expect(warningsMatching(schema, /includes extra columns/)).toHaveLength(1);
  });

  it('reads HasAlternateKey as a unique constraint', async () => {
    const schema: IrSchema = await parse(
      context(
        `modelBuilder.Entity<T>().HasAlternateKey(t => t.Slug);
         modelBuilder.Entity<T>().HasAlternateKey(t => new { t.A, t.B });`,
        `public class T { public int Id { get; set; } public string Slug { get; set; } = null!; public int A { get; set; } public int B { get; set; } }`
      )
    );
    expect(field(schema, 'T', 'slug').isUnique).toBe(true);
    expect(model(schema, 'T').indexes).toContainEqual({
      fields: ['a', 'b'],
      isUnique: true,
    });
  });

  it('reads Ignore() and does not map the ignored property', async () => {
    const schema: IrSchema = await parse(
      context(
        `modelBuilder.Entity<T>().Ignore(t => t.Temp).Ignore("Other");`,
        `public class T { public int Id { get; set; } public int Temp { get; set; } public int Other { get; set; } public int Kept { get; set; } }`
      )
    );
    expect(names(schema, 'T')).toEqual(['id', 'kept']);
  });

  it('reads HasConversion<string>() on enums and warns about other converters', async () => {
    const schema: IrSchema = await parse(
      context(
        `modelBuilder.Entity<T>(e => {
          e.Property(t => t.Kind).HasConversion<string>();
          e.Property(t => t.Other).HasConversion<EnumToStringConverter<Kind>>();
          e.Property(t => t.Id2).HasConversion<string>();
          e.Property(t => t.Money).HasConversion(new MoneyConverter());
          e.Property(t => t.Level).HasConversion(v => v.ToString(), v => Enum.Parse<Kind>(v));
        });`,
        `public enum Kind { A, B }
public class T { public int Id { get; set; } public Kind Kind { get; set; } public Kind Other { get; set; } public Guid Id2 { get; set; } public decimal Money { get; set; } public Kind Level { get; set; } }`
      )
    );
    expect(field(schema, 'T', 'kind').type).toBe('string');
    expect(field(schema, 'T', 'other').type).toBe('string');
    expect(field(schema, 'T', 'id2').type).toBe('text');
    expect(field(schema, 'T', 'money').type).toBe('decimal');
    expect(
      warningsMatching(schema, /custom value converter is not evaluated/)
    ).toHaveLength(2);
    expect(warningsMatching(schema, /stores Guid as string/)).toHaveLength(1);
  });

  it('flattens OwnsOne with a column prefix, nested owned types, renamed columns and optional owners', async () => {
    const schema: IrSchema = await parse(
      context(
        `modelBuilder.Entity<T>(e => {
          e.OwnsOne(t => t.Home, a => {
            a.Property(x => x.Street).HasColumnName("home_street").HasMaxLength(50);
            a.OwnsOne(x => x.Geo);
          });
          e.OwnsOne(t => t.Work, a => a.OwnsOne(x => x.Geo));
        });`,
        `public class Geo { public double Lat { get; set; } public double Lng { get; set; } }
public class Addr { public string Street { get; set; } = null!; public string? City { get; set; } public Geo Geo { get; set; } = null!; }
public class T { public int Id { get; set; } public Addr Home { get; set; } = null!; public Addr? Work { get; set; } }`
      )
    );
    expect(names(schema, 'T')).toEqual([
      'id',
      'homeStreet',
      'homeCity',
      'homeGeoLat',
      'homeGeoLng',
      'workStreet',
      'workCity',
      'workGeoLat',
      'workGeoLng',
    ]);
    expect(field(schema, 'T', 'homeStreet')).toMatchObject({
      columnName: 'home_street',
      maxLength: 50,
      isNullable: false,
    });
    expect(field(schema, 'T', 'homeGeoLat').columnName).toBe('Home_Geo_Lat');
    expect(field(schema, 'T', 'workStreet').isNullable).toBe(true);
  });

  it('reads an owned type stored as JSON as a json column', async () => {
    const schema: IrSchema = await parse(
      context(
        `modelBuilder.Entity<T>().OwnsOne(t => t.Prefs, p => p.ToJson());`,
        `public class Prefs { public string Theme { get; set; } = null!; }
public class T { public int Id { get; set; } public Prefs Prefs { get; set; } = null!; }`
      )
    );
    expect(field(schema, 'T', 'prefs')).toMatchObject({
      type: 'json',
      isNullable: false,
    });
  });

  it('warns about OwnsMany and skips the property', async () => {
    const schema: IrSchema = await parse(
      context(
        `modelBuilder.Entity<T>().OwnsMany(t => t.Lines);`,
        `public class Line { public string Text { get; set; } = null!; }
public class T { public int Id { get; set; } public List<Line> Lines { get; set; } = new(); }`
      )
    );
    expect(names(schema, 'T')).toEqual(['id']);
    expect(warningsMatching(schema, /owned collection of Line/)).toHaveLength(
      1
    );
  });

  it('reads views and warns about ToSqlQuery', async () => {
    const schema: IrSchema = await parse(
      context(
        `modelBuilder.Entity<T>().HasNoKey().ToView("v_things");
         modelBuilder.Entity<Q>().HasNoKey().ToSqlQuery("select 1 as X");`,
        `public class T { public string Name { get; set; } = null!; }
public class Q { public int X { get; set; } }
public class Ctx2 : DbContext { public DbSet<Q> Qs => Set<Q>(); }`
      )
    );
    expect(model(schema, 'T')).toMatchObject({
      tableName: 'v_things',
      isView: true,
    });
    expect(warningsMatching(schema, /mapped to a SQL query/)).toHaveLength(1);
  });

  it('warns once about fluent calls it does not interpret, and about HasData and HasQueryFilter', async () => {
    const schema: IrSchema = await parse(
      context(
        `modelBuilder.HasPostgresExtension("uuid-ossp");
         modelBuilder.Entity<T>(e => {
           e.HasData(new T { Id = 1 });
           e.HasQueryFilter(t => t.Id > 0);
           e.Property(t => t.Id).UseHiLo("seq");
           e.Property(t => t.Name).HasColumnOrder(2).HasColumnOrder(3);
         });`,
        `public class T { public int Id { get; set; } public string Name { get; set; } = null!; }`
      )
    );
    expect(
      warningsMatching(
        schema,
        /HasPostgresExtension\(\.\.\.\) is not interpreted/
      )
    ).toHaveLength(1);
    expect(
      warningsMatching(schema, /UseHiLo\(\.\.\.\) is not interpreted/)
    ).toHaveLength(1);
    expect(
      warningsMatching(schema, /HasColumnOrder\(\.\.\.\) is not interpreted/)
    ).toHaveLength(1);
    expect(warningsMatching(schema, /seed data \(HasData\)/)).toHaveLength(1);
    expect(warningsMatching(schema, /global query filter/)).toHaveLength(1);
  });

  it('warns about conditionals, loops and ConfigureConventions', async () => {
    const schema: IrSchema = await parse(`
public class T { public int Id { get; set; } }
public class Ctx : DbContext {
  public DbSet<T> Ts => Set<T>();
  protected override void ConfigureConventions(ModelConfigurationBuilder b) { b.Properties<string>().HaveMaxLength(100); }
  protected override void OnModelCreating(ModelBuilder modelBuilder) {
    if (Database.IsSqlite()) { modelBuilder.Entity<T>().ToTable("sqlite_t"); }
    foreach (var type in modelBuilder.Model.GetEntityTypes()) { type.SetTableName(type.ClrType.Name.ToLower()); }
    while (false) { }
  }
}`);
    expect(model(schema, 'T').tableName).toBe('sqlite_t');
    expect(warningsMatching(schema, /conditional \(if\)/)).toHaveLength(1);
    expect(warningsMatching(schema, /a loop over the model/)).toHaveLength(2);
    expect(
      warningsMatching(schema, /ConfigureConventions\) is not interpreted/)
    ).toHaveLength(1);
  });

  it('applies a delete behavior assigned to every foreign key in a loop', async () => {
    const schema: IrSchema = await parse(`
public class P { public int Id { get; set; } public List<C> Cs { get; set; } = new(); }
public class C { public int Id { get; set; } public int PId { get; set; } public P P { get; set; } = null!; }
public class Ctx : DbContext {
  public DbSet<P> Ps => Set<P>();
  protected override void OnModelCreating(ModelBuilder modelBuilder) {
    foreach (var fk in modelBuilder.Model.GetEntityTypes().SelectMany(e => e.GetForeignKeys())) { fk.DeleteBehavior = DeleteBehavior.Restrict; }
  }
}`);
    expect(relation(schema, 'C', 'p').onDelete).toBe('restrict');
    expect(
      warningsMatching(
        schema,
        /assigns DeleteBehavior.Restrict to every foreign key/
      )
    ).toHaveLength(1);
  });

  it('follows configuration split into helper methods and extension methods', async () => {
    const schema: IrSchema = await parse(`
public class T { public int Id { get; set; } public string Name { get; set; } = null!; }
public static class Ext { public static void ConfigureThings(this ModelBuilder modelBuilder) { modelBuilder.Entity<T>().ToTable("ext_things"); }
  public static EntityTypeBuilder<T> Slim(this EntityTypeBuilder<T> b) { b.Property(t => t.Name).HasMaxLength(9); return b; } }
public class Ctx : DbContext {
  public DbSet<T> Ts => Set<T>();
  void Helper(ModelBuilder mb) { mb.Entity<T>().HasIndex(t => t.Name).HasDatabaseName("ix_helper"); }
  protected override void OnModelCreating(ModelBuilder modelBuilder) {
    base.OnModelCreating(modelBuilder);
    modelBuilder.ConfigureThings();
    Helper(modelBuilder);
    modelBuilder.Entity<T>().Slim();
    var entity = modelBuilder.Entity<T>();
    entity.Property(t => t.Name).IsRequired();
  }
}`);
    expect(model(schema, 'T').tableName).toBe('ext_things');
    expect(field(schema, 'T', 'name').maxLength).toBe(9);
    expect(model(schema, 'T').indexes).toContainEqual({
      fields: ['name'],
      isUnique: false,
      name: 'ix_helper',
    });
  });
});

describe('relationships', () => {
  it('finds foreign keys by convention and orders the pair by convention', async () => {
    const schema: IrSchema = await parse(`
public class Author { public int Id { get; set; } public List<Book> Books { get; set; } = new(); }
public class Book { public int Id { get; set; } public int AuthorId { get; set; } public Author Author { get; set; } = null!; }
public class Ctx : DbContext { public DbSet<Author> Authors => Set<Author>(); public DbSet<Book> Books => Set<Book>(); }`);
    expect(names(schema, 'Book')).toEqual(['id']);
    expect(relation(schema, 'Book', 'author')).toEqual({
      name: 'author',
      kind: 'foreignKey',
      targetModel: 'Author',
      columnName: 'AuthorId',
      isNullable: false,
      onDelete: 'cascade',
      relatedName: 'books',
    });
  });

  it('accepts the foreign key spellings <Nav>Id, <Nav><Key>, <Type>Id and <Type><Key>', async () => {
    const schema: IrSchema = await parse(`
public class Person { public int PersonId { get; set; } }
public class Doc { public int Id { get; set; }
  public int OwnerId { get; set; } public Person Owner { get; set; } = null!;
  public int ReviewerPersonId { get; set; } public Person Reviewer { get; set; } = null!;
  public int PersonId { get; set; } public Person Subject { get; set; } = null!; }
public class Ctx : DbContext { public DbSet<Doc> Docs => Set<Doc>(); }`);
    expect(relation(schema, 'Doc', 'owner').columnName).toBe('OwnerId');
    expect(relation(schema, 'Doc', 'reviewer').columnName).toBe(
      'ReviewerPersonId'
    );
    expect(relation(schema, 'Doc', 'subject').columnName).toBe('PersonId');
  });

  it('uses a shadow foreign key when the class has no key property', async () => {
    const schema: IrSchema = await parse(`
public class Blog { public int Id { get; set; } public List<Post> Posts { get; set; } = new(); }
public class Post { public int Id { get; set; } public Blog Blog { get; set; } = null!; public Topic? Topic { get; set; } }
public class Topic { public int Id { get; set; } }
public class Ctx : DbContext { public DbSet<Blog> Blogs => Set<Blog>(); }`);
    expect(relation(schema, 'Post', 'blog')).toMatchObject({
      columnName: 'BlogId',
      isNullable: false,
      onDelete: 'cascade',
      relatedName: 'posts',
    });
    expect(relation(schema, 'Post', 'topic')).toMatchObject({
      columnName: 'TopicId',
      isNullable: true,
      onDelete: 'noAction',
    });
  });

  it('decides required and optional from the key, the navigation and the fluent API', async () => {
    const schema: IrSchema = await parse(`
public class P { public int Id { get; set; } }
public class C {
  public int Id { get; set; }
  public int ReqId { get; set; } public P Req { get; set; } = null!;
  public int? OptId { get; set; } public P? Opt { get; set; }
  public P? ShadowOpt { get; set; }
  [Required] public P? ShadowReq { get; set; }
  public P ForcedOptional { get; set; } = null!;
  public P? ForcedRequired { get; set; }
}
public class Ctx : DbContext { public DbSet<C> Cs => Set<C>();
  protected override void OnModelCreating(ModelBuilder b) {
    b.Entity<C>().HasOne(c => c.ForcedOptional).WithMany().IsRequired(false);
    b.Entity<C>().HasOne(c => c.ForcedRequired).WithMany().IsRequired();
  } }`);
    expect(relation(schema, 'C', 'req').isNullable).toBe(false);
    expect(relation(schema, 'C', 'opt').isNullable).toBe(true);
    expect(relation(schema, 'C', 'shadowOpt').isNullable).toBe(true);
    expect(relation(schema, 'C', 'shadowReq').isNullable).toBe(false);
    expect(relation(schema, 'C', 'forcedOptional').isNullable).toBe(true);
    expect(relation(schema, 'C', 'forcedRequired').isNullable).toBe(false);
  });

  it('maps every DeleteBehavior to the action in the database', async () => {
    const behaviors: string[] = [
      'Cascade',
      'SetNull',
      'Restrict',
      'NoAction',
      'ClientSetNull',
      'ClientCascade',
      'ClientNoAction',
    ];
    const members: string = behaviors
      .map(
        (behavior: string) =>
          `public int? ${behavior}Id { get; set; } public P? ${behavior} { get; set; }`
      )
      .join('\n');
    const rules: string = behaviors
      .map(
        (behavior: string) =>
          `b.Entity<C>().HasOne(c => c.${behavior}).WithMany().HasForeignKey(c => c.${behavior}Id).OnDelete(DeleteBehavior.${behavior});`
      )
      .join('\n');
    const schema: IrSchema = await parse(`
public class P { public int Id { get; set; } }
public class C { public int Id { get; set; } ${members} }
public class Ctx : DbContext { public DbSet<C> Cs => Set<C>();
  protected override void OnModelCreating(ModelBuilder b) { ${rules} } }`);
    const actual: Record<string, string> = {};
    for (const item of model(schema, 'C').relations) {
      actual[item.name] = item.onDelete;
    }
    expect(actual).toEqual({
      cascade: 'cascade',
      setNull: 'setNull',
      restrict: 'restrict',
      noAction: 'noAction',
      clientSetNull: 'noAction',
      clientCascade: 'noAction',
      clientNoAction: 'noAction',
    });
  });

  it('reads a self-reference and pairs Parent with Children', async () => {
    const schema: IrSchema = await parse(`
public class Node { public int Id { get; set; } public int? ParentId { get; set; } public Node? Parent { get; set; } public ICollection<Node> Children { get; set; } = new List<Node>(); }
public class Ctx : DbContext { public DbSet<Node> Nodes => Set<Node>(); }`);
    expect(relation(schema, 'Node', 'parent')).toMatchObject({
      targetModel: 'Node',
      columnName: 'ParentId',
      isNullable: true,
      relatedName: 'children',
    });
  });

  it('accepts every collection type for the many side', async () => {
    const schema: IrSchema = await parse(`
public class P { public int Id { get; set; }
  public ICollection<A> A1 { get; set; } = new List<A>(); public IList<B> B1 { get; set; } = new List<B>();
  public List<C> C1 { get; set; } = new(); public HashSet<D> D1 { get; set; } = new(); public IEnumerable<E> E1 { get; set; } = new List<E>();
  public ISet<F> F1 { get; set; } = new HashSet<F>(); public IReadOnlyCollection<G> G1 { get; set; } = new List<G>(); }
public class A { public int Id { get; set; } public int PId { get; set; } }
public class B { public int Id { get; set; } public int PId { get; set; } }
public class C { public int Id { get; set; } public int PId { get; set; } }
public class D { public int Id { get; set; } public int PId { get; set; } }
public class E { public int Id { get; set; } public int PId { get; set; } }
public class F { public int Id { get; set; } public int PId { get; set; } }
public class G { public int Id { get; set; } public int PId { get; set; } }
public class Ctx : DbContext { public DbSet<P> Ps => Set<P>(); }`);
    for (const dependent of ['A', 'B', 'C', 'D', 'E', 'F', 'G']) {
      expect(model(schema, dependent).relations).toHaveLength(1);
      expect(relation(schema, dependent, 'p').columnName).toBe('PId');
    }
  });

  it('reads one-to-one relationships and picks the side that has the foreign key', async () => {
    const schema: IrSchema = await parse(`
public class User { public int Id { get; set; } public Profile? Profile { get; set; } }
public class Profile { public int Id { get; set; } public int UserId { get; set; } public User User { get; set; } = null!; }
public class Ctx : DbContext { public DbSet<User> Users => Set<User>(); }`);
    expect(relation(schema, 'Profile', 'user')).toMatchObject({
      kind: 'oneToOne',
      columnName: 'UserId',
      relatedName: 'profile',
    });
    expect(model(schema, 'User').relations).toEqual([]);
  });

  it('reads HasOne().WithOne().HasForeignKey<T>() and a primary key that is the foreign key', async () => {
    const schema: IrSchema = await parse(`
public class Order { public int Id { get; set; } public Invoice? Invoice { get; set; } }
public class Invoice { public int OrderId { get; set; } public Order Order { get; set; } = null!; public decimal Total { get; set; } }
public class Ctx : DbContext { public DbSet<Order> Orders => Set<Order>();
  protected override void OnModelCreating(ModelBuilder b) {
    b.Entity<Order>().HasOne(o => o.Invoice).WithOne(i => i.Order).HasForeignKey<Invoice>(i => i.OrderId);
    b.Entity<Invoice>().HasKey(i => i.OrderId);
  } }`);
    expect(relation(schema, 'Invoice', 'order')).toMatchObject({
      kind: 'oneToOne',
      isPrimaryKey: true,
      isNullable: false,
      relatedName: 'invoice',
    });
    expect(names(schema, 'Invoice')).toEqual(['total']);
  });

  it('keeps composite foreign keys as composite foreign keys', async () => {
    const schema: IrSchema = await parse(`
public class Parent { public int A { get; set; } public int B { get; set; } public List<Child> Children { get; set; } = new(); }
public class Child { public int Id { get; set; } public int PA { get; set; } public int PB { get; set; } public Parent Parent { get; set; } = null!; }
public class Ctx : DbContext { public DbSet<Parent> Parents => Set<Parent>();
  protected override void OnModelCreating(ModelBuilder b) {
    b.Entity<Parent>().HasKey(p => new { p.A, p.B });
    b.Entity<Child>().HasOne(c => c.Parent).WithMany(p => p.Children).HasForeignKey(c => new { c.PA, c.PB }).OnDelete(DeleteBehavior.Cascade);
  } }`);
    expect(model(schema, 'Child').compositeForeignKeys).toEqual([
      {
        name: 'parent',
        targetModel: 'Parent',
        fields: ['pa', 'pb'],
        references: ['a', 'b'],
        kind: 'foreignKey',
        isNullable: false,
        onDelete: 'cascade',
        relatedName: 'children',
      },
    ]);
    expect(names(schema, 'Child')).toEqual(['id', 'pa', 'pb']);
  });

  it('reads HasPrincipalKey as a reference to a non-key column', async () => {
    const schema: IrSchema = await parse(`
public class Country { public int Id { get; set; } public string Code { get; set; } = null!; }
public class City { public int Id { get; set; } public string CountryCode { get; set; } = null!; public Country Country { get; set; } = null!; }
public class Ctx : DbContext { public DbSet<City> Cities => Set<City>();
  protected override void OnModelCreating(ModelBuilder b) {
    b.Entity<Country>().HasAlternateKey(c => c.Code);
    b.Entity<City>().HasOne(c => c.Country).WithMany().HasForeignKey(c => c.CountryCode).HasPrincipalKey(c => c.Code);
  } }`);
    expect(relation(schema, 'City', 'country')).toMatchObject({
      columnName: 'CountryCode',
      toField: 'Code',
    });
  });

  it('reads HasConstraintName and HasOne<T>() without a navigation', async () => {
    const schema: IrSchema = await parse(`
public class P { public int Id { get; set; } }
public class C { public int Id { get; set; } public int PId { get; set; } }
public class Ctx : DbContext { public DbSet<C> Cs => Set<C>();
  protected override void OnModelCreating(ModelBuilder b) {
    b.Entity<C>().HasOne<P>().WithMany().HasForeignKey(c => c.PId).HasConstraintName("fk_c_p");
  } }`);
    expect(relation(schema, 'C', 'p')).toMatchObject({
      columnName: 'PId',
      constraintName: 'fk_c_p',
    });
  });

  it('warns when a navigation has several candidates and skips it', async () => {
    const schema: IrSchema = await parse(`
public class U { public int Id { get; set; } public List<Post> A { get; set; } = new(); public List<Post> B { get; set; } = new(); }
public class Post { public int Id { get; set; } public int UId { get; set; } public U Author { get; set; } = null!; }
public class Ctx : DbContext { public DbSet<U> Us => Set<U>(); }`);
    expect(
      warningsMatching(schema, /U has several navigations to Post/)
    ).toHaveLength(1);
  });

  it('warns about a half-built relationship and about a target that is not an entity', async () => {
    const schema: IrSchema = await parse(`
public class P { public int Id { get; set; } }
public class C { public int Id { get; set; } public P? Link { get; set; } }
public class Ctx : DbContext { public DbSet<C> Cs => Set<C>();
  protected override void OnModelCreating(ModelBuilder b) { b.Entity<C>().HasOne(c => c.Link); } }`);
    expect(
      warningsMatching(schema, /no WithOne \/ WithMany call/)
    ).toHaveLength(1);
  });

  it('reads a many-to-many through skip navigations', async () => {
    const schema: IrSchema = await parse(`
public class Post { public int Id { get; set; } public List<Tag> Tags { get; set; } = new(); }
public class Tag { public int Id { get; set; } public List<Post> Posts { get; set; } = new(); }
public class Ctx : DbContext { public DbSet<Post> Posts => Set<Post>(); public DbSet<Tag> Tags => Set<Tag>(); }`);
    expect(relation(schema, 'Post', 'tags')).toMatchObject({
      kind: 'manyToMany',
      targetModel: 'Tag',
      relatedName: 'posts',
    });
    expect(model(schema, 'Tag').relations).toEqual([]);
    expect(warningsMatching(schema, /join table "PostTag"/)).toHaveLength(1);
  });

  it('reads UsingEntity with a named shared join entity, table and columns', async () => {
    const schema: IrSchema = await parse(`
public class Post { public int Id { get; set; } public List<Tag> Tags { get; set; } = new(); }
public class Tag { public int Id { get; set; } public List<Post> Posts { get; set; } = new(); }
public class Ctx : DbContext { public DbSet<Post> Posts => Set<Post>();
  protected override void OnModelCreating(ModelBuilder b) {
    b.Entity<Post>().HasMany(p => p.Tags).WithMany(t => t.Posts).UsingEntity<Dictionary<string, object>>(
      "post_tag",
      r => r.HasOne<Tag>().WithMany().HasForeignKey("tag_id"),
      l => l.HasOne<Post>().WithMany().HasForeignKey("post_id"),
      j => j.ToTable("post_tag"));
  } }`);
    expect(relation(schema, 'Post', 'tags').kind).toBe('manyToMany');
    expect(
      warningsMatching(
        schema,
        /join table "post_tag" \(columns post_id, tag_id\) is not preserved by name/
      )
    ).toHaveLength(1);
  });

  it('reads UsingEntity(j => j.ToTable(...)) and unidirectional skip navigations', async () => {
    const schema: IrSchema = await parse(`
public class Student { public int Id { get; set; } public List<Course> Courses { get; set; } = new(); }
public class Course { public int Id { get; set; } public List<Student> Students { get; set; } = new(); }
public class Ctx : DbContext { public DbSet<Student> Students => Set<Student>();
  protected override void OnModelCreating(ModelBuilder b) {
    b.Entity<Student>().HasMany(s => s.Courses).WithMany(c => c.Students).UsingEntity(j => j.ToTable("enrollments"));
  } }`);
    expect(warningsMatching(schema, /join table "enrollments"/)).toHaveLength(
      1
    );
  });

  it('reads UsingEntity<JoinClass> as an ordinary entity', async () => {
    const schema: IrSchema = await parse(`
public class Post { public int Id { get; set; } public List<Tag> Tags { get; set; } = new(); public List<PostTag> PostTags { get; set; } = new(); }
public class Tag { public int Id { get; set; } public List<Post> Posts { get; set; } = new(); public List<PostTag> PostTags { get; set; } = new(); }
public class PostTag { public int PostId { get; set; } public int TagId { get; set; } public Post Post { get; set; } = null!; public Tag Tag { get; set; } = null!; public DateTime At { get; set; } }
public class Ctx : DbContext { public DbSet<Post> Posts => Set<Post>();
  protected override void OnModelCreating(ModelBuilder b) {
    b.Entity<Post>().HasMany(p => p.Tags).WithMany(t => t.Posts).UsingEntity<PostTag>(
      l => l.HasOne(pt => pt.Tag).WithMany(t => t.PostTags),
      r => r.HasOne(pt => pt.Post).WithMany(p => p.PostTags));
  } }`);
    expect(model(schema, 'PostTag').compositePrimaryKey).toEqual([
      'post',
      'tag',
    ]);
    expect(
      model(schema, 'Post').relations.filter(
        (item) => item.kind === 'manyToMany'
      )
    ).toEqual([]);
    expect(relation(schema, 'PostTag', 'post').relatedName).toBe('postTags');
    expect(
      warningsMatching(schema, /through the join entity PostTag/)
    ).toHaveLength(1);
  });

  it('reads an explicit join entity declared with two one-to-many relationships', async () => {
    const schema: IrSchema = await parse(`
public class Student { public int Id { get; set; } public List<Enrollment> Enrollments { get; set; } = new(); }
public class Course { public int Id { get; set; } public List<Enrollment> Enrollments { get; set; } = new(); }
public class Enrollment { public int StudentId { get; set; } public int CourseId { get; set; } public Student Student { get; set; } = null!; public Course Course { get; set; } = null!; }
public class Ctx : DbContext { public DbSet<Enrollment> Enrollments => Set<Enrollment>();
  protected override void OnModelCreating(ModelBuilder b) { b.Entity<Enrollment>().HasKey(e => new { e.StudentId, e.CourseId }); } }`);
    expect(model(schema, 'Enrollment').compositePrimaryKey).toEqual([
      'student',
      'course',
    ]);
    expect(relation(schema, 'Enrollment', 'student').relatedName).toBe(
      'enrollments'
    );
  });
});

describe('code as scaffolded by EF Core and other real-world patterns', () => {
  it('reads Scaffold-DbContext output: partial context, HasName, HasConstraintName and ClientSetNull', async () => {
    const schema: IrSchema = await parse(
      `
public partial class Blog {
  public Blog() { Posts = new HashSet<Post>(); }
  public int BlogId { get; set; }
  public string Url { get; set; } = null!;
  public virtual ICollection<Post> Posts { get; set; }
}
public partial class Post {
  public int PostId { get; set; }
  public int BlogId { get; set; }
  public string? Title { get; set; }
  public virtual Blog Blog { get; set; } = null!;
}
public partial class BloggingContext : DbContext {
  public BloggingContext() { }
  public virtual DbSet<Blog> Blogs { get; set; } = null!;
  public virtual DbSet<Post> Posts { get; set; } = null!;
  protected override void OnModelCreating(ModelBuilder modelBuilder) {
    modelBuilder.Entity<Blog>(entity => {
      entity.ToTable("Blog");
      entity.HasKey(e => e.BlogId).HasName("PK_Blog");
      entity.Property(e => e.Url).HasMaxLength(500).IsUnicode(false).HasColumnName("url");
    });
    modelBuilder.Entity<Post>(entity => {
      entity.HasIndex(e => e.BlogId, "IX_Post_BlogId");
      entity.Property(e => e.Title).HasMaxLength(100);
      entity.HasOne(d => d.Blog).WithMany(p => p.Posts).HasForeignKey(d => d.BlogId).OnDelete(DeleteBehavior.ClientSetNull).HasConstraintName("FK_Post_Blog");
    });
    OnModelCreatingPartial(modelBuilder);
  }
  partial void OnModelCreatingPartial(ModelBuilder modelBuilder);
}`
    );
    expect(model(schema, 'Blog')).toMatchObject({
      tableName: 'Blog',
      primaryKeyName: 'PK_Blog',
    });
    expect(field(schema, 'Blog', 'url')).toMatchObject({
      columnName: 'url',
      maxLength: 500,
    });
    expect(relation(schema, 'Post', 'blog')).toMatchObject({
      constraintName: 'FK_Post_Blog',
      onDelete: 'noAction',
      isNullable: false,
      relatedName: 'posts',
    });
    expect(model(schema, 'Post').indexes).toContainEqual({
      fields: ['blog'],
      isUnique: false,
      name: 'IX_Post_BlogId',
    });
    expect(
      warningsMatching(schema, /Blog: the columns Url are not Unicode/)
    ).toHaveLength(1);
  });

  it('recognises a context by its DbSet properties when the base class is not in the input', async () => {
    const schema: IrSchema = await parse(`
public class Item : EntityBase { public string Name { get; set; } = null!; }
public class AppContext : MyCompany.Data.BaseContext { public DbSet<Item> Items { get; set; } = null!; }`);
    expect(model(schema, 'Item').tableName).toBe('Items');
    expect(
      warningsMatching(schema, /base class EntityBase is not in the input/)
    ).toHaveLength(1);
    expect(
      warningsMatching(schema, /Item: the entity has no primary key/)
    ).toHaveLength(1);
  });

  it('reads a get-only collection navigation that the fluent API configures (domain-driven style)', async () => {
    const schema: IrSchema = await parse(`
public abstract class Entity<TId> { public TId Id { get; protected set; } = default!; }
public sealed class Product : Entity<Guid> {
  private Product() { }
  private readonly List<Review> _reviews = new();
  public string Name { get; private set; } = null!;
  public IReadOnlyCollection<Review> Reviews => _reviews.AsReadOnly();
  public int Count => _reviews.Count;
}
public class Review : Entity<int> { public string Text { get; private set; } = null!; }
public class Ctx : DbContext {
  public DbSet<Product> Products => Set<Product>();
  protected override void OnModelCreating(ModelBuilder b) {
    b.Entity<Product>().HasMany(p => p.Reviews).WithOne().HasForeignKey("ProductId");
  } }`);
    expect(names(schema, 'Product')).toEqual(['id', 'name']);
    expect(relation(schema, 'Review', 'product')).toMatchObject({
      columnName: 'ProductId',
      isNullable: true,
      relatedName: 'reviews',
    });
  });

  it('reads shadow properties declared with Property<T>("Name") and warns about unknown ones', async () => {
    const schema: IrSchema = await parse(`
public class T { public int Id { get; set; } }
public class Ctx : DbContext { public DbSet<T> Ts => Set<T>();
  protected override void OnModelCreating(ModelBuilder b) {
    b.Entity<T>().Property<int>("TenantId").HasColumnName("tenant");
    b.Entity<T>().Property<DateTime?>("Touched");
    b.Entity<T>().Property("Typo").HasMaxLength(3);
  } }`);
    expect(field(schema, 'T', 'tenantId')).toMatchObject({
      type: 'int',
      columnName: 'tenant',
      isNullable: false,
    });
    expect(field(schema, 'T', 'touched')).toMatchObject({
      type: 'dateTime',
      isNullable: true,
    });
    expect(
      warningsMatching(schema, /configures the property "Typo"/)
    ).toHaveLength(1);
  });
});

describe('inheritance', () => {
  it('reads table-per-hierarchy as one model with nullable derived columns and a discriminator', async () => {
    const schema: IrSchema = await parse(`
public abstract class Animal { public int Id { get; set; } public string Name { get; set; } = null!; }
public class Dog : Animal { public int Tricks { get; set; } }
public class Cat : Animal { public string? Fur { get; set; } public bool Indoor { get; set; } }
public class Ctx : DbContext { public DbSet<Animal> Animals => Set<Animal>(); public DbSet<Dog> Dogs => Set<Dog>();
  protected override void OnModelCreating(ModelBuilder b) {
    b.Entity<Animal>().HasDiscriminator<string>("Kind").HasValue<Dog>("dog").HasValue<Cat>("cat");
    b.Entity<Cat>();
  } }`);
    expect(schema.models.map((item: IrModel) => item.name)).toEqual(['Animal']);
    expect(names(schema, 'Animal')).toEqual([
      'id',
      'name',
      'tricks',
      'fur',
      'indoor',
      'kind',
    ]);
    expect(field(schema, 'Animal', 'tricks').isNullable).toBe(true);
    expect(field(schema, 'Animal', 'indoor').isNullable).toBe(true);
    expect(field(schema, 'Animal', 'kind')).toMatchObject({
      isNullable: false,
      columnName: 'Kind',
    });
    expect(
      warningsMatching(schema, /Dog, Cat derive from Animal in one table/)
    ).toHaveLength(1);
  });

  it('uses Discriminator as the default discriminator column and maps relations to the root', async () => {
    const schema: IrSchema = await parse(`
public class Shape { public int Id { get; set; } }
public class Circle : Shape { public double R { get; set; } }
public class Drawing { public int Id { get; set; } public List<Circle> Circles { get; set; } = new(); }
public class Ctx : DbContext { public DbSet<Shape> Shapes => Set<Shape>(); public DbSet<Drawing> Drawings => Set<Drawing>(); public DbSet<Circle> Cs => Set<Circle>(); }`);
    expect(field(schema, 'Shape', 'discriminator').columnName).toBe(
      'Discriminator'
    );
    expect(model(schema, 'Shape').relations[0]).toMatchObject({
      targetModel: 'Drawing',
    });
  });

  it('reads table-per-type as independent tables and says so', async () => {
    const schema: IrSchema = await parse(`
public class Base { public int Id { get; set; } public string A { get; set; } = null!; }
public class Child : Base { public string B { get; set; } = null!; }
public class Ctx : DbContext { public DbSet<Base> Bases => Set<Base>(); public DbSet<Child> Children => Set<Child>();
  protected override void OnModelCreating(ModelBuilder b) { b.Entity<Child>().ToTable("children"); } }`);
    expect(schema.models.map((item: IrModel) => item.name)).toEqual([
      'Base',
      'Child',
    ]);
    expect(names(schema, 'Child')).toEqual(['id', 'a', 'b']);
    expect(warningsMatching(schema, /table-per-type/)).toHaveLength(1);
  });

  it('flattens a mapped base class that has no DbSet', async () => {
    const schema: IrSchema = await parse(`
public class Audited { public DateTime CreatedAt { get; set; } public string? CreatedBy { get; set; } }
public class Item : Audited { public int Id { get; set; } }
public class Ctx : DbContext { public DbSet<Item> Items => Set<Item>(); }`);
    expect(names(schema, 'Item')).toEqual(['createdAt', 'createdBy', 'id']);
  });
});

describe('malformed input', () => {
  it('reports syntax errors with a warning and keeps what it can read', async () => {
    const schema: IrSchema = await parse(`
public class Good { public int Id { get; set; } public string Name { get; set; } = null!; }
public class Ctx : DbContext { public DbSet<Good> Goods => Set<Good>(); }
public class Broken { public int Id { get; set; ;;; public string
`);
    expect(model(schema, 'Good').fields).toHaveLength(2);
    expect(warningsMatching(schema, /C# syntax errors/)).toHaveLength(1);
  });

  it('never throws on text that is not C#', async () => {
    for (const text of [
      '',
      '\u0000\u0001\u0002',
      '{{{{{{',
      'class',
      '[[[[',
      '<<<<>>>>',
      'model A { id Int }',
    ]) {
      const result: Result<IrSchema> = await parseEfcore(
        [{ path: 'x.cs', text }],
        { appLabel: 'app' }
      );
      expect(typeof result.ok).toBe('boolean');
      if (!result.ok) {
        expect(result.error.message.length).toBeGreaterThan(10);
      }
    }
  });

  it('survives deep nesting and a very long chain', async () => {
    const chain: string = '.HasMaxLength(5)'.repeat(300);
    const nested: string = '{'.repeat(300) + '}'.repeat(300);
    const schema: IrSchema = await parse(`
public class T { public int Id { get; set; } public string Name { get; set; } = null!; }
public class Ctx : DbContext { public DbSet<T> Ts => Set<T>();
  protected override void OnModelCreating(ModelBuilder b) {
    b.Entity<T>().Property(t => t.Name)${chain};
    ${nested}
  } }`);
    expect(field(schema, 'T', 'name').maxLength).toBe(5);
  });

  it('survives cyclic navigation and inheritance', async () => {
    const schema: IrSchema = await parse(`
public class A : B { public int Id { get; set; } public B? Other { get; set; } }
public class B : A { public int Key { get; set; } }
public class Ctx : DbContext { public DbSet<A> As => Set<A>(); }`);
    expect(schema.models.length).toBeGreaterThan(0);
  });
});

describe('directory input', () => {
  const directories: string[] = [];

  afterEach(() => {
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  function project(files: Record<string, string>): string {
    const directory: string = mkdtempSync(join(tmpdir(), 'ormbridge-efcore-'));
    directories.push(directory);
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(directory, path)), { recursive: true });
      writeFileSync(join(directory, path), text);
    }
    return directory;
  }

  it('reads every .cs file and skips Migrations, bin, obj and generated files', async () => {
    const directory: string = project({
      'Models/Thing.cs': `${HEADER}public class Thing { public int Id { get; set; } }`,
      'Data/AppDbContext.cs': `${HEADER}public class AppDbContext : DbContext { public DbSet<Thing> Things => Set<Thing>(); }`,
      'Migrations/20240101_Init.cs': `${HEADER}public class Init : Migration { }`,
      'Migrations/20240101_Init.Designer.cs': `${HEADER}public class InitD { }`,
      'Migrations/AppDbContextModelSnapshot.cs': `${HEADER}public class AppDbContextModelSnapshot : ModelSnapshot { }`,
      'bin/Debug/Gen.cs': `${HEADER}public class Gen { [Key] public int Id { get; set; } }`,
      'obj/Debug/Gen2.cs': `${HEADER}public class Gen2 { [Key] public int Id { get; set; } }`,
      'Models/readme.txt': 'not code',
    });
    const output: string = join(directory, 'out.prisma');
    const result = await runConversion({
      inputs: [directory],
      output,
      from: 'efcore',
      to: 'prisma',
      naming: 'preserve',
      provider: 'postgresql',
      header: false,
      appLabel: 'app',
      autoField: 'int',
    });
    expect(result.ok).toBe(true);
    const text: string = readFileSync(output, 'utf8');
    expect(text).toContain('model Thing');
    expect(text).not.toContain('Gen');
    expect(text).not.toContain('Init');
  });

  it('explains what it expected when a directory has no .cs files', async () => {
    const directory: string = project({ 'a.txt': 'x' });
    const result = await runConversion({
      inputs: [directory],
      from: 'efcore',
      to: 'prisma',
      naming: 'preserve',
      provider: 'postgresql',
      header: false,
      appLabel: 'app',
      autoField: 'int',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('NO_INPUT_FILES');
      expect(result.error.message).toContain('.cs');
    }
  });
});

describe('canonical fixture', () => {
  const directory: string = fileURLToPath(
    new URL('./fixtures/efcore', import.meta.url)
  );

  it('reads the blog schema', async () => {
    const files: string[] = readdirSync(directory)
      .filter((name: string) => name.endsWith('.cs'))
      .map((name: string) => join(directory, name));
    const schema: IrSchema = expectOk(
      await parseEfcore(
        files.map((path: string) => ({
          path,
          text: readFileSync(path, 'utf8'),
        })),
        { appLabel: 'blog' }
      )
    );
    expect(schema.models.map((item: IrModel) => item.name).sort()).toEqual([
      'Category',
      'Post',
      'Profile',
      'Tag',
      'User',
    ]);
    expect(schema.warnings).toEqual([]);
    expect(model(schema, 'Post').indexes).toContainEqual({
      fields: ['author', 'title'],
      isUnique: true,
      name: 'uniq_post_author_title',
    });
    expect(relation(schema, 'Post', 'category').onDelete).toBe('restrict');
    expect(relation(schema, 'Post', 'tags').kind).toBe('manyToMany');
    expect(relation(schema, 'Profile', 'user').kind).toBe('oneToOne');
  });
});

describe('extras fixture', () => {
  const root: string = fileURLToPath(
    new URL('./fixtures/efcore-extras', import.meta.url)
  );
  const goldenDirectory: string = fileURLToPath(
    new URL('./golden-extras/', import.meta.url)
  );

  /** Compares text with test/golden-extras/<name>; run with UPDATE_GOLDEN=1 to rewrite it. */
  function expectMatchesExtrasGolden(name: string, actual: string): void {
    const goldenPath: string = `${goldenDirectory}${name}`;
    if (process.env.UPDATE_GOLDEN === '1') {
      mkdirSync(dirname(goldenPath), { recursive: true });
      writeFileSync(goldenPath, actual);
      return;
    }
    if (!existsSync(goldenPath)) {
      throw new Error(
        `Golden file test/golden-extras/${name} does not exist. Run the tests with UPDATE_GOLDEN=1 to create it.`
      );
    }
    expect(actual).toBe(readFileSync(goldenPath, 'utf8'));
  }

  function csharpFiles(directory: string): string[] {
    return readdirSync(directory)
      .sort()
      .flatMap((entry: string): string[] => {
        const path: string = join(directory, entry);
        if (statSync(path).isDirectory()) {
          return csharpFiles(path);
        }
        return path.endsWith('.cs') ? [path] : [];
      });
  }

  async function convertExtras(group: string): Promise<ConvertResult> {
    return expectOk(
      await convertText(
        csharpFiles(join(root, group)).map((path: string) => ({
          path,
          text: readFileSync(path, 'utf8'),
        })),
        { ...DEFAULT_OPTIONS, appLabel: group, from: 'efcore', to: 'prisma' }
      )
    );
  }

  it('reads shop: conventions, owned types, composite keys, skip navigations', async () => {
    const schema: IrSchema = expectOk(
      await parseEfcore(
        csharpFiles(join(root, 'shop')).map((path: string) => ({
          path,
          text: readFileSync(path, 'utf8'),
        })),
        { appLabel: 'shop' }
      )
    );
    expect(schema.models.map((item: IrModel) => item.name)).toEqual([
      'Customer',
      'Coupon',
      'Order',
      'OrderLine',
      'Product',
      'Category',
    ]);
    expect(model(schema, 'OrderLine').compositePrimaryKey).toEqual([
      'order',
      'lineNo',
    ]);
    expect(model(schema, 'Order').tableName).toBe('orders');
    expect(field(schema, 'Customer', 'shippingAddressZip')).toMatchObject({
      columnName: 'ship_zip',
      maxLength: 10,
    });
    expect(field(schema, 'Order', 'id').type).toBe('uuid');
    expect(relation(schema, 'Order', 'coupon').onDelete).toBe('noAction');
    expect(schema.enums.map((item) => item.name)).toEqual([
      'Tier',
      'OrderState',
    ]);
  });

  it.each(['shop', 'inheritance', 'library'])(
    'matches the Prisma golden for %s',
    async (group: string) => {
      const result: ConvertResult = await convertExtras(group);
      expectMatchesExtrasGolden(`efcore-${group}-to-prisma.txt`, result.output);
    }
  );

  it.each(['shop', 'inheritance', 'library'])(
    'matches the warnings golden for %s',
    async (group: string) => {
      const result: ConvertResult = await convertExtras(group);
      expectMatchesExtrasGolden(
        `efcore-${group}-warnings.txt`,
        result.warnings.map((warning: string) => `${warning}\n`).join('')
      );
    }
  );
});
