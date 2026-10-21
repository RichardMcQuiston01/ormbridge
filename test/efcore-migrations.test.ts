import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { convertText, type ConvertResult } from '../src/convert.js';
import type {
  IrCompositeForeignKey,
  IrField,
  IrModel,
  IrRelation,
  IrSchema,
} from '../src/ir.js';
import { parseEfcore, type EfcoreSourceFile } from '../src/parsers/efcore.js';
import type { Result } from '../src/result.js';
import { compareWithModel } from './efcoreMigrationsSupport.js';
import { DEFAULT_OPTIONS, expectOk } from './helpers.js';

/**
 * Replays EF Core migrations. Most fixtures in test/fixtures/efcore-migrations/<scenario>/Migrations are written by
 * the real EF Core 8 (test/efcore-migrations-verify.test.ts regenerates them and checks the replay against EF Core's
 * own model); the rest are written here to reach what EF Core does not write for SQLite and PostgreSQL (SQL
 * Server column types, `Sql(...)`, conditionals) and to exercise the warnings.
 */

const FIXTURES: string = fileURLToPath(
  new URL('./fixtures/efcore-migrations', import.meta.url)
);
const GOLDENS: string = fileURLToPath(
  new URL('./golden-extras/', import.meta.url)
);

/** Compares text with test/golden-extras/<name>; run with UPDATE_GOLDEN=1 to rewrite it. */
function expectMatchesGolden(name: string, actual: string): void {
  const path: string = `${GOLDENS}${name}`;
  if (process.env.UPDATE_GOLDEN === '1') {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, actual);
    return;
  }
  if (!existsSync(path)) {
    throw new Error(
      `Golden file test/golden-extras/${name} does not exist. Run the tests with UPDATE_GOLDEN=1 to create it.`
    );
  }
  expect(actual).toBe(readFileSync(path, 'utf8'));
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

/** The files of a scenario directory, optionally without the model snapshot. */
function scenarioFiles(
  name: string,
  withSnapshot: boolean = true
): EfcoreSourceFile[] {
  return csharpFiles(join(FIXTURES, name))
    .filter((path: string) => withSnapshot || !path.endsWith('Snapshot.cs'))
    .map((path: string) => ({
      path: path.slice(FIXTURES.length + 1),
      text: readFileSync(path, 'utf8'),
    }));
}

async function parse(files: EfcoreSourceFile[]): Promise<IrSchema> {
  return expectOk(await parseEfcore(files, { appLabel: 'app' }));
}

function model(schema: IrSchema, name: string): IrModel {
  const found: IrModel | undefined = schema.models.find(
    (candidate: IrModel) => candidate.name === name
  );
  if (found === undefined) {
    throw new Error(
      `Model ${name} was not read (found: ${schema.models.map((item: IrModel) => item.name).join(', ')})`
    );
  }
  return found;
}

function field(schema: IrSchema, modelName: string, name: string): IrField {
  const found: IrField | undefined = model(schema, modelName).fields.find(
    (candidate: IrField) => candidate.name === name
  );
  if (found === undefined) {
    throw new Error(`Field ${modelName}.${name} was not read`);
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
    throw new Error(`Relation ${modelName}.${name} was not read`);
  }
  return found;
}

function warningsMatching(schema: IrSchema, pattern: RegExp): string[] {
  return schema.warnings.filter((warning: string) => pattern.test(warning));
}

/** A migration file in the format EF Core writes it, with the body of `Up` given. */
function migration(id: string, up: string): EfcoreSourceFile {
  return {
    path: `Migrations/${id}.cs`,
    text: `using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace App.Migrations
{
    /// <inheritdoc />
    public partial class ${id.replace(/^\d+_/, '')} : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
${up}
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
        }
    }
}
`,
  };
}

const SCENARIOS: readonly string[] = [
  'blog',
  'keys',
  'owned',
  'postgres',
  'rekey',
  'rename',
  'fleet',
];

describe('migrations written by EF Core', () => {
  it.each(SCENARIOS)(
    'replays %s without a warning and matches the Prisma golden',
    async (name: string) => {
      const result: ConvertResult = expectOk(
        await convertText(scenarioFiles(name), {
          ...DEFAULT_OPTIONS,
          appLabel: name,
          from: 'efcore',
          to: 'prisma',
        })
      );
      expectMatchesGolden(
        `efcore-migrations-${name}-to-prisma.txt`,
        result.output
      );
      expectMatchesGolden(
        `efcore-migrations-${name}-warnings.txt`,
        result.warnings.map((warning: string) => `${warning}\n`).join('')
      );
    }
  );

  it.each(SCENARIOS)(
    'reads %s the same whatever order the files are given in',
    async (name: string) => {
      const files: EfcoreSourceFile[] = scenarioFiles(name);
      const forward: IrSchema = await parse(files);
      const reversed: IrSchema = await parse([...files].reverse());
      expect(reversed).toEqual(forward);
    }
  );

  it('replays blog: add, drop, rename and alter columns, indexes, a dropped join table and a new foreign key', async () => {
    const schema: IrSchema = await parse(scenarioFiles('blog'));
    expect(schema.models.map((item: IrModel) => item.name)).toEqual([
      'Blog',
      'Post',
      'Author',
    ]);
    expect(schema.warnings).toEqual([]);
    // Url was renamed to Slug and got a unique index; Title was dropped and Name added.
    expect(model(schema, 'Blog').fields.map((item) => item.columnName)).toEqual(
      ['Id', 'Slug', 'Name']
    );
    expect(field(schema, 'Blog', 'slug')).toMatchObject({
      isUnique: true,
      isNullable: true,
    });
    expect(field(schema, 'Blog', 'name')).toMatchObject({
      type: 'string',
      maxLength: 100,
      isNullable: false,
    });
    // The index on Post.Title was dropped; the decimal column has its precision and default.
    expect(model(schema, 'Post').indexes).toEqual([]);
    expect(field(schema, 'Post', 'rating')).toMatchObject({
      type: 'decimal',
      maxDigits: 5,
      decimalPlaces: 2,
      default: { kind: 'literal', value: 3 },
    });
    expect(relation(schema, 'Post', 'author')).toMatchObject({
      isNullable: true,
      onDelete: 'setNull',
      relatedName: 'posts',
    });
    expect(relation(schema, 'Post', 'blog')).toMatchObject({
      kind: 'foreignKey',
      onDelete: 'cascade',
    });
    // The backfill defaults EF Core writes with AddColumn ("" and 0) are not defaults of the model.
    expect(field(schema, 'Blog', 'name').default).toBeUndefined();
  });

  it('uses the names of the model snapshot when it agrees, and the table names when there is none', async () => {
    const withSnapshot: IrSchema = await parse(scenarioFiles('keys'));
    expect(withSnapshot.models.map((item: IrModel) => item.name)).toContain(
      'EmployeeProfile'
    );
    expect(relation(withSnapshot, 'Stock', 'product').relatedName).toBe(
      'stocks'
    );
    const without: IrSchema = await parse(scenarioFiles('keys', false));
    expect(without.models.map((item: IrModel) => item.name)).toContain(
      'Profile'
    );
    expect(without.models.map((item: IrModel) => item.name)).not.toContain(
      'EmployeeProfile'
    );
    expect(relation(without, 'Stock', 'productSku')).toMatchObject({
      toField: 'Sku',
    });
    expect(without.warnings).toEqual([]);
  });

  it('reads keys: a composite key, an alternate key, a self reference, a shared key, defaults and a computed column', async () => {
    const schema: IrSchema = await parse(scenarioFiles('keys'));
    expect(model(schema, 'OrderItem').compositePrimaryKey).toEqual([
      'order',
      'lineNo',
    ]);
    expect(field(schema, 'Product', 'sku').isUnique).toBe(true);
    expect(relation(schema, 'Stock', 'product')).toMatchObject({
      toField: 'Sku',
    });
    expect(relation(schema, 'Employee', 'manager')).toMatchObject({
      isNullable: true,
      onDelete: 'cascade',
    });
    expect(relation(schema, 'EmployeeProfile', 'employee')).toMatchObject({
      kind: 'oneToOne',
      isPrimaryKey: true,
    });
    expect(field(schema, 'Order', 'paid').default).toEqual({
      kind: 'literal',
      value: false,
    });
    expect(field(schema, 'OrderItem', 'doubled').generated).toEqual({
      expression: '"Quantity" * 2',
      isStored: true,
    });
    expect(field(schema, 'Order', 'status')).toMatchObject({
      type: 'string',
      maxLength: 20,
    });
    expect(field(schema, 'Product', 'price')).toMatchObject({
      type: 'decimal',
      maxDigits: 10,
      decimalPlaces: 4,
    });
  });

  it('reads owned types: flattened columns and tables of owned collections with composite foreign keys', async () => {
    const schema: IrSchema = await parse(scenarioFiles('owned'));
    expect(schema.models.map((item: IrModel) => item.name)).toEqual([
      'Customer',
      'Order',
      'OrderLine',
    ]);
    expect(
      model(schema, 'Customer').fields.map((item: IrField) => item.columnName)
    ).toContain('Home_Geo_Lat');
    expect(field(schema, 'Customer', 'workGeoLat').isNullable).toBe(true);
    expect(field(schema, 'Customer', 'homeGeoLat').isNullable).toBe(false);
    expect(model(schema, 'Order').compositePrimaryKey).toEqual([
      'customer',
      'id',
    ]);
    const key: IrCompositeForeignKey | undefined = model(schema, 'OrderLine')
      .compositeForeignKeys?.[0];
    expect(key).toMatchObject({
      targetModel: 'Order',
      fields: ['orderCustomerId', 'orderId'],
      onDelete: 'cascade',
    });
  });

  it('reads PostgreSQL columns: identity, schema, jsonb, arrays, inet and the GIN index', async () => {
    const schema: IrSchema = await parse(scenarioFiles('postgres'));
    expect(model(schema, 'Account').schema).toBe('sales');
    expect(model(schema, 'Invoice').schema).toBe('billing');
    expect(field(schema, 'Account', 'id').default).toEqual({
      kind: 'autoIncrement',
    });
    expect(field(schema, 'Account', 'settings').type).toBe('json');
    expect(field(schema, 'Account', 'scores')).toMatchObject({
      type: 'int',
      arrayDepth: 1,
    });
    expect(field(schema, 'Account', 'lastAddress').type).toBe('ipAddress');
    expect(field(schema, 'Account', 'publicId').default).toEqual({
      kind: 'uuid',
    });
    expect(field(schema, 'Account', 'createdAt').default).toEqual({
      kind: 'now',
    });
    expect(model(schema, 'Account').indexes).toEqual([
      { fields: ['settings'], isUnique: false, method: 'Gin' },
    ]);
    expect(field(schema, 'Account', 'email')).toMatchObject({
      type: 'string',
      maxLength: 200,
      isUnique: true,
    });
  });

  it('replays renamed tables, indexes and columns', async () => {
    const schema: IrSchema = await parse(scenarioFiles('rename'));
    expect(model(schema, 'Writer').tableName).toBe('People');
    expect(field(schema, 'Book', 'title').columnName).toBe('Headline');
    expect(model(schema, 'Book').indexes).toEqual([
      { fields: ['title'], isUnique: false, name: 'IX_Books_ByTitle' },
    ]);
    expect(relation(schema, 'Book', 'writer').targetModel).toBe('Writer');
  });

  it('reads a table per hierarchy as one table with a discriminator', async () => {
    const schema: IrSchema = await parse(scenarioFiles('fleet'));
    expect(schema.models.map((item: IrModel) => item.name)).toEqual([
      'Vehicle',
    ]);
    expect(field(schema, 'Vehicle', 'discriminator')).toMatchObject({
      isNullable: false,
    });
    expect(field(schema, 'Vehicle', 'axles').isNullable).toBe(true);
  });

  it('moves the primary key: DropPrimaryKey, AddPrimaryKey, AddUniqueConstraint and a changed delete action', async () => {
    const schema: IrSchema = await parse(scenarioFiles('rekey'));
    expect(field(schema, 'Product', 'code').isPrimaryKey).toBe(true);
    expect(field(schema, 'Product', 'id')).toMatchObject({
      isPrimaryKey: false,
      isUnique: true,
    });
    expect(relation(schema, 'Item', 'product')).toMatchObject({
      onDelete: 'restrict',
      toField: 'Id',
    });
    expect(field(schema, 'Product', 'name')).toMatchObject({
      isNullable: true,
      maxLength: 80,
    });
    expect(field(schema, 'Product', 'note').isNullable).toBe(false);
  });

  it('agrees with the description of the model that EF Core gives (the comparison the real-tool test uses)', async () => {
    const schema: IrSchema = await parse(scenarioFiles('blog'));
    const description = {
      tables: [
        {
          schema: null,
          name: 'Authors',
          columns: [
            {
              name: 'Id',
              storeType: 'INTEGER',
              clrType: 'System.Int32',
              nullable: false,
            },
            {
              name: 'Email',
              storeType: 'TEXT',
              clrType: 'System.String',
              nullable: false,
            },
          ],
          primaryKey: ['Id'],
          uniqueConstraints: [],
          indexes: [
            {
              name: 'IX_Authors_Email',
              unique: true,
              columns: ['Email'],
              filter: null,
            },
          ],
          foreignKeys: [],
        },
      ],
    };
    // The comparison reports tables that EF Core does not list and the columns that differ.
    const differences: string[] = compareWithModel(schema, description.tables);
    expect(differences).toContain(
      'table Blogs: read, but EF Core has no such table'
    );
    expect(differences.some((item) => /Authors/.test(item))).toBe(false);
  });
});

describe('SQL Server style columns and the other things a migration says', () => {
  const sqlServer: string = `
            migrationBuilder.CreateTable(
                name: "Customers",
                columns: table => new
                {
                    Id = table.Column<int>(type: "int", nullable: false)
                        .Annotation("SqlServer:Identity", "1, 1"),
                    PublicId = table.Column<Guid>(type: "uniqueidentifier", nullable: false, defaultValueSql: "NEWID()"),
                    Email = table.Column<string>(type: "nvarchar(450)", maxLength: 450, nullable: false),
                    Bio = table.Column<string>(type: "nvarchar(max)", nullable: true),
                    Code = table.Column<string>(type: "varchar(20)", unicode: false, maxLength: 20, nullable: true),
                    IsActive = table.Column<bool>(type: "bit", nullable: false, defaultValue: true),
                    CreatedAt = table.Column<DateTime>(type: "datetime2", nullable: false, defaultValueSql: "GETUTCDATE()"),
                    Balance = table.Column<decimal>(type: "decimal(18,2)", precision: 18, scale: 2, nullable: false),
                    Photo = table.Column<byte[]>(type: "varbinary(max)", nullable: true),
                    Version = table.Column<byte[]>(type: "rowversion", rowVersion: true, nullable: true),
                    Total = table.Column<int>(type: "int", nullable: false, computedColumnSql: "[A] + [B]", stored: true),
                    Level = table.Column<int>(type: "int", nullable: false, defaultValue: 2)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_Customers", x => x.Id);
                    table.CheckConstraint("CK_Customers_Level", "[Level] > 0");
                });

            migrationBuilder.CreateIndex(
                name: "IX_Customers_Email",
                table: "Customers",
                column: "Email",
                unique: true,
                filter: "[Email] IS NOT NULL");`;

  it('reads SQL Server column types, identity, defaults, a computed column, a row version and a filtered index', async () => {
    const schema: IrSchema = await parse([
      migration('20240101000000_Initial', sqlServer),
    ]);
    expect(field(schema, 'Customer', 'id')).toMatchObject({
      type: 'int',
      isPrimaryKey: true,
      default: { kind: 'autoIncrement' },
    });
    expect(field(schema, 'Customer', 'publicId')).toMatchObject({
      type: 'uuid',
      default: { kind: 'uuid' },
    });
    expect(field(schema, 'Customer', 'email')).toMatchObject({
      type: 'string',
      maxLength: 450,
      isUnique: true,
    });
    expect(field(schema, 'Customer', 'bio')).toMatchObject({
      type: 'text',
      isNullable: true,
    });
    expect(field(schema, 'Customer', 'isActive')).toMatchObject({
      type: 'boolean',
      default: { kind: 'literal', value: true },
    });
    expect(field(schema, 'Customer', 'createdAt')).toMatchObject({
      type: 'dateTime',
      default: { kind: 'now' },
    });
    expect(field(schema, 'Customer', 'balance')).toMatchObject({
      type: 'decimal',
      maxDigits: 18,
      decimalPlaces: 2,
    });
    expect(field(schema, 'Customer', 'photo').type).toBe('bytes');
    expect(field(schema, 'Customer', 'total').generated).toEqual({
      expression: '[A] + [B]',
      isStored: true,
    });
    expect(field(schema, 'Customer', 'level').default).toEqual({
      kind: 'literal',
      value: 2,
    });
    // A filtered unique index is read as a plain unique index, with a warning.
    expect(model(schema, 'Customer').indexes).toEqual([]);
    expect(warningsMatching(schema, /has a filter/)).toHaveLength(1);
    expect(warningsMatching(schema, /row version/)).toHaveLength(1);
    expect(warningsMatching(schema, /not Unicode/)).toHaveLength(1);
    expect(warningsMatching(schema, /CK_Customers_Level/)).toHaveLength(1);
  });

  it('warns once per raw SQL statement with the file, the line and the table, and for seed data and sequences', async () => {
    const schema: IrSchema = await parse([
      migration(
        '20240101000000_Initial',
        `
            migrationBuilder.CreateTable(
                name: "Things",
                columns: table => new { Id = table.Column<int>(type: "int", nullable: false) },
                constraints: table => { table.PrimaryKey("PK_Things", x => x.Id); });
            migrationBuilder.Sql("UPDATE Things SET Id = Id + 1");
            migrationBuilder.InsertData(table: "Things", column: "Id", value: 1);
            migrationBuilder.CreateSequence<int>(name: "Seq", startValue: 10L);`
      ),
    ]);
    expect(schema.warnings).toHaveLength(3);
    expect(schema.warnings[0]).toMatch(
      /^Migrations\/20240101000000_Initial\.cs:\d+: the raw SQL "UPDATE Things SET Id = Id \+ 1" on the table "Things" \(migrationBuilder\.Sql\) is not interpreted/
    );
    expect(schema.warnings[1]).toMatch(
      /Initial\.cs:\d+: InsertData on the table "Things" changes rows, not the schema/
    );
    expect(schema.warnings[2]).toMatch(
      /Initial\.cs:\d+: CreateSequence "Seq" changes a sequence/
    );
  });

  it('warns about changes to a table no earlier migration creates and about foreign keys to missing tables', async () => {
    const schema: IrSchema = await parse([
      migration(
        '20240101000000_Initial',
        `
            migrationBuilder.CreateTable(
                name: "Things",
                columns: table => new { Id = table.Column<int>(type: "int", nullable: false), OtherId = table.Column<int>(type: "int", nullable: false) },
                constraints: table =>
                {
                    table.PrimaryKey("PK_Things", x => x.Id);
                    table.ForeignKey(name: "FK_Things_Others_OtherId", column: x => x.OtherId, principalTable: "Others", principalColumn: "Id");
                });
            migrationBuilder.AddColumn<int>(name: "X", table: "Missing", type: "int", nullable: false);
            migrationBuilder.DropColumn(name: "Nope", table: "Things");
            migrationBuilder.RenameColumn(name: "Nope", table: "Things", newName: "Other");
            migrationBuilder.DropIndex(name: "IX_Nope", table: "Things");
            migrationBuilder.Frobnicate("x");`
      ),
    ]);
    expect(schema.warnings).toEqual([
      'Migrations/20240101000000_Initial.cs:22: AddColumn "X" refers to the table "Missing", which no earlier migration creates; the change was skipped.',
      'Migrations/20240101000000_Initial.cs:23: DropColumn removes "Things"."Nope", which no earlier migration adds.',
      'Migrations/20240101000000_Initial.cs:24: RenameColumn renames "Things"."Nope", which no earlier migration adds.',
      'Migrations/20240101000000_Initial.cs:25: DropIndex "IX_Nope" refers to an index that no earlier migration creates.',
      'Migrations/20240101000000_Initial.cs:26: migrationBuilder.Frobnicate(...) is not known and was skipped.',
      'Things: the foreign key "FK_Things_Others_OtherId" refers to the table "Others", which the migrations do not create; it was skipped.',
    ]);
    expect(model(schema, 'Thing').fields.map((item) => item.name)).toEqual([
      'id',
      'otherId',
    ]);
  });

  it('applies a conditional block as if it always ran, with a warning, and skips the else branch', async () => {
    const schema: IrSchema = await parse([
      migration(
        '20240101000000_Initial',
        `
            migrationBuilder.CreateTable(
                name: "Things",
                columns: table => new { Id = table.Column<int>(type: "int", nullable: false) },
                constraints: table => { table.PrimaryKey("PK_Things", x => x.Id); });
            if (migrationBuilder.ActiveProvider == "Npgsql")
            {
                migrationBuilder.AddColumn<string>(name: "Pg", table: "Things", type: "text", nullable: true);
            }
            else
            {
                migrationBuilder.AddColumn<string>(name: "Other", table: "Things", type: "nvarchar(max)", nullable: true);
            }`
      ),
    ]);
    expect(model(schema, 'Thing').fields.map((item) => item.name)).toEqual([
      'id',
      'pg',
    ]);
    expect(schema.warnings).toHaveLength(1);
    expect(schema.warnings[0]).toMatch(
      /Initial\.cs:\d+: if contains schema changes; the first block was applied as if it always ran and the other blocks were skipped/
    );
  });

  it('replays in the order of the migration ids, not the order of the files, and warns about ids without a timestamp', async () => {
    const create: string = `
            migrationBuilder.CreateTable(
                name: "Things",
                columns: table => new { Id = table.Column<int>(type: "int", nullable: false) },
                constraints: table => { table.PrimaryKey("PK_Things", x => x.Id); });`;
    const alter: string = `
            migrationBuilder.AddColumn<string>(name: "Name", table: "Things", type: "text", nullable: true);`;
    const ordered: IrSchema = await parse([
      migration('20240202000000_Second', alter),
      migration('20240101000000_First', create),
    ]);
    expect(model(ordered, 'Thing').fields.map((item) => item.name)).toEqual([
      'id',
      'name',
    ]);
    const unordered: IrSchema = await parse([
      migration('Second', alter),
      migration('First', create),
    ]);
    expect(warningsMatching(unordered, /has no timestamp prefix/)).toHaveLength(
      2
    );
  });

  it('takes the id of the Migration attribute over the file name', async () => {
    const withAttribute: EfcoreSourceFile = {
      path: 'Migrations/Later.cs',
      text: `using Microsoft.EntityFrameworkCore.Migrations;
[Migration("20240303000000_Later")]
public partial class Later : Migration {
  protected override void Up(MigrationBuilder migrationBuilder) {
    migrationBuilder.AddColumn<string>(name: "Name", table: "Things", type: "text", nullable: true);
  }
}`,
    };
    const schema: IrSchema = await parse([
      withAttribute,
      migration(
        '20240101000000_Initial',
        `
            migrationBuilder.CreateTable(
                name: "Things",
                columns: table => new { Id = table.Column<int>(type: "int", nullable: false) },
                constraints: table => { table.PrimaryKey("PK_Things", x => x.Id); });`
      ),
    ]);
    expect(model(schema, 'Thing').fields.map((item) => item.name)).toEqual([
      'id',
      'name',
    ]);
    expect(schema.warnings).toEqual([]);
  });

  it('reads arguments passed by position, a column named by name:, DropTable and a table moved to another schema', async () => {
    const schema: IrSchema = await parse([
      migration(
        '20240101000000_Initial',
        `
            migrationBuilder.CreateTable(
                name: "Old",
                columns: table => new { Id = table.Column<int>(type: "int", nullable: false) },
                constraints: table => { table.PrimaryKey("PK_Old", x => x.Id); });
            migrationBuilder.CreateTable(
                name: "Things",
                columns: table => new
                {
                    Id = table.Column<int>(type: "int", nullable: false),
                    FooBar = table.Column<string>(name: "Foo-Bar", type: "text", nullable: true)
                },
                constraints: table => { table.PrimaryKey("PK_Things", x => x.Id); });
            migrationBuilder.DropTable("Old");
            migrationBuilder.RenameTable("Things", null, "Stuff", "inventory");
            migrationBuilder.CreateIndex("IX_Stuff_Foo", "Stuff", "Foo-Bar", "inventory");`
      ),
    ]);
    expect(schema.models.map((item: IrModel) => item.name)).toEqual(['Stuff']);
    expect(model(schema, 'Stuff')).toMatchObject({
      tableName: 'Stuff',
      schema: 'inventory',
    });
    expect(field(schema, 'Stuff', 'fooBar').columnName).toBe('Foo-Bar');
    expect(model(schema, 'Stuff').indexes).toEqual([
      { fields: ['fooBar'], isUnique: false, name: 'IX_Stuff_Foo' },
    ]);
  });

  it('keeps an explicit default and drops the backfill default of AddColumn and AlterColumn', async () => {
    const schema: IrSchema = await parse([
      migration(
        '20240101000000_Initial',
        `
            migrationBuilder.CreateTable(
                name: "Things",
                columns: table => new { Id = table.Column<int>(type: "int", nullable: false), Note = table.Column<string>(type: "text", nullable: true) },
                constraints: table => { table.PrimaryKey("PK_Things", x => x.Id); });
            migrationBuilder.AddColumn<string>(name: "A", table: "Things", type: "text", nullable: false, defaultValue: "");
            migrationBuilder.AddColumn<string>(name: "B", table: "Things", type: "text", nullable: false, defaultValue: "x");
            migrationBuilder.AddColumn<int>(name: "C", table: "Things", type: "int", nullable: false, defaultValue: 0);
            migrationBuilder.AddColumn<bool>(name: "D", table: "Things", type: "bit", nullable: false, defaultValue: false);
            migrationBuilder.AddColumn<Guid>(name: "E", table: "Things", type: "uniqueidentifier", nullable: false, defaultValue: new Guid("00000000-0000-0000-0000-000000000000"));
            migrationBuilder.AddColumn<DateTime>(name: "F", table: "Things", type: "datetime2", nullable: false, defaultValue: new DateTime(2020, 1, 2, 3, 4, 5, 0, DateTimeKind.Unspecified));
            migrationBuilder.AlterColumn<string>(name: "Note", table: "Things", type: "text", nullable: false, defaultValue: "", oldClrType: typeof(string), oldType: "text", oldNullable: true);`
      ),
    ]);
    const defaults: Record<string, unknown> = Object.fromEntries(
      model(schema, 'Thing').fields.map((item: IrField) => [
        item.name,
        item.default,
      ])
    );
    expect(defaults['a']).toBeUndefined();
    expect(defaults['b']).toEqual({ kind: 'literal', value: 'x' });
    expect(defaults['c']).toBeUndefined();
    expect(defaults['d']).toBeUndefined();
    expect(defaults['e']).toBeUndefined();
    expect(defaults['f']).toEqual({
      kind: 'literal',
      value: '2020-01-02T03:04:05',
    });
    expect(defaults['note']).toBeUndefined();
    expect(field(schema, 'Thing', 'note').isNullable).toBe(false);
  });

  it('drops a table and the foreign keys that point at it, and reports a table that is created twice', async () => {
    const schema: IrSchema = await parse([
      migration(
        '20240101000000_Initial',
        `
            migrationBuilder.CreateTable(
                name: "Parents",
                columns: table => new { Id = table.Column<int>(type: "int", nullable: false) },
                constraints: table => { table.PrimaryKey("PK_Parents", x => x.Id); });
            migrationBuilder.CreateTable(
                name: "Children",
                columns: table => new { Id = table.Column<int>(type: "int", nullable: false), ParentId = table.Column<int>(type: "int", nullable: false) },
                constraints: table =>
                {
                    table.PrimaryKey("PK_Children", x => x.Id);
                    table.ForeignKey(name: "FK_Children_Parents_ParentId", column: x => x.ParentId, principalTable: "Parents", principalColumn: "Id", onDelete: ReferentialAction.Cascade);
                });
            migrationBuilder.DropTable(name: "Parents");
            migrationBuilder.CreateTable(
                name: "Children",
                columns: table => new { Id = table.Column<int>(type: "int", nullable: false) },
                constraints: table => { table.PrimaryKey("PK_Children", x => x.Id); });`
      ),
    ]);
    expect(schema.models.map((item: IrModel) => item.name)).toEqual(['Child']);
    expect(schema.warnings).toEqual([
      'Migrations/20240101000000_Initial.cs:26: DropTable "Parents" also removed the foreign keys of "Children" that referenced it; the migration did not drop them first.',
      'Migrations/20240101000000_Initial.cs:27: CreateTable creates the table "Children" again; the earlier definition was replaced.',
    ]);
  });
});

describe('the model snapshot', () => {
  const create: string = `
            migrationBuilder.CreateTable(
                name: "Things",
                columns: table => new
                {
                    Id = table.Column<int>(type: "INTEGER", nullable: false),
                    Name = table.Column<string>(type: "TEXT", nullable: false)
                },
                constraints: table => { table.PrimaryKey("PK_Things", x => x.Id); });`;

  const snapshot = (properties: string): EfcoreSourceFile => ({
    path: 'Migrations/AppContextModelSnapshot.cs',
    text: `using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Infrastructure;
namespace App.Migrations
{
    [DbContext(typeof(AppContext))]
    partial class AppContextModelSnapshot : ModelSnapshot
    {
        protected override void BuildModel(ModelBuilder modelBuilder)
        {
            modelBuilder.Entity("App.Gadget", b =>
                {
                    b.Property<int>("Id")
                        .ValueGeneratedOnAdd()
                        .HasColumnType("INTEGER");
${properties}
                    b.HasKey("Id");

                    b.ToTable("Things");
                });
        }
    }
}
`,
  });

  it('gives the entity and property names of an agreeing snapshot to the schema', async () => {
    const schema: IrSchema = await parse([
      migration('20240101000000_Initial', create),
      snapshot(`
                    b.Property<string>("Name")
                        .IsRequired()
                        .HasColumnType("TEXT");
`),
    ]);
    expect(schema.models.map((item: IrModel) => item.name)).toEqual(['Gadget']);
    expect(schema.warnings).toEqual([]);
  });

  it('warns and replays the migrations alone when the snapshot does not agree', async () => {
    const schema: IrSchema = await parse([
      migration('20240101000000_Initial', create),
      snapshot(`
                    b.Property<string>("Name")
                        .HasColumnType("TEXT");

                    b.Property<string>("Extra")
                        .HasColumnType("TEXT");
`),
    ]);
    expect(schema.models.map((item: IrModel) => item.name)).toEqual(['Thing']);
    expect(schema.warnings).toEqual([
      'The model snapshot does not agree with the migrations ("Things": column Name is not null in the migrations and nullable in the model snapshot; "Things": column Extra is only in the model snapshot), so the schema was rebuilt from the migrations alone and the names in the snapshot were not used.',
    ]);
  });

  it('reads a snapshot alone, with a warning that there are no migrations', async () => {
    const schema: IrSchema = await parse([
      snapshot(`
                    b.Property<string>("Name")
                        .IsRequired()
                        .HasColumnType("TEXT");
`),
    ]);
    expect(schema.models.map((item: IrModel) => item.name)).toEqual(['Gadget']);
    expect(schema.warnings).toEqual([
      'The input has a model snapshot but no migrations, so the schema was read from the snapshot alone.',
    ]);
  });
});

describe('migrations next to entity classes, and nothing to read', () => {
  const entity: EfcoreSourceFile = {
    path: 'Models/Thing.cs',
    text: `using Microsoft.EntityFrameworkCore;
public class Thing { public int Id { get; set; } }
public class C : DbContext { public DbSet<Thing> Things => Set<Thing>(); }`,
  };

  it('reads the entity classes and skips the migrations with one warning', async () => {
    const schema: IrSchema = await parse([entity, ...scenarioFiles('blog')]);
    expect(schema.models.map((item: IrModel) => item.name)).toEqual(['Thing']);
    // One warning for the migrations and the snapshot, one for the Designer file.
    expect(schema.warnings).toHaveLength(2);
    expect(schema.warnings[0]).toMatch(
      /^blog\/Migrations\/\S+Designer\.cs: skipped/
    );
    expect(schema.warnings[1]).toMatch(
      /^blog\/Migrations\/\S+ and 3 more migration files: skipped \(the entity classes describe the model/
    );
  });

  it('fails with an explanation when the input has neither entities nor migrations', async () => {
    const result: Result<IrSchema> = await parseEfcore(
      [{ path: 'Other.cs', text: 'public class Other { }' }],
      { appLabel: 'app' }
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('NO_MODELS_FOUND');
      expect(result.error.message).toContain('A migration is a class');
    }
  });

  it('fails when the migrations leave no table behind', async () => {
    const result: Result<IrSchema> = await parseEfcore(
      [
        migration(
          '20240101000000_Initial',
          `
            migrationBuilder.CreateTable(
                name: "Things",
                columns: table => new { Id = table.Column<int>(type: "int", nullable: false) },
                constraints: table => { table.PrimaryKey("PK_Things", x => x.Id); });
            migrationBuilder.DropTable(name: "Things");`
        ),
      ],
      { appLabel: 'app' }
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain('leave no tables behind');
    }
  });
});
