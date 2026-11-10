import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { IrField, IrModel, IrSchema } from '../../../src/ir.js';
import { expectOk } from '../../../test/helpers.js';
import { parseKotlin, isSkippedKotlinPath } from '../src/index.js';

const FIXTURE: string = fileURLToPath(
  new URL('./fixtures/spring/', import.meta.url)
);

function ktFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((name: string): string[] => {
    const path: string = join(directory, name);
    return statSync(path).isDirectory()
      ? ktFiles(path)
      : path.endsWith('.kt')
        ? [path]
        : [];
  });
}

async function read(
  sources: { path: string; text: string }[]
): Promise<IrSchema> {
  return expectOk(await parseKotlin(sources, { appLabel: 'shop' }));
}

async function readFixture(): Promise<IrSchema> {
  return read(
    ktFiles(FIXTURE).map((path: string) => ({
      path,
      text: readFileSync(path, 'utf8'),
    }))
  );
}

function modelOf(schema: IrSchema, name: string): IrModel {
  const found: IrModel | undefined = schema.models.find(
    (item: IrModel) => item.name === name
  );
  if (found === undefined) {
    throw new Error(
      `No model ${name} in ${schema.models.map((m) => m.name).join(', ')}`
    );
  }
  return found;
}

function fieldOf(model: IrModel, name: string): IrField {
  const found: IrField | undefined = model.fields.find(
    (item: IrField) => item.name === name
  );
  if (found === undefined) {
    throw new Error(`No field ${name} in ${model.name}`);
  }
  return found;
}

describe('parseKotlin: a Spring Boot style project', () => {
  it('finds the entities and leaves the mapped superclass, embeddable and converter out', async () => {
    const schema: IrSchema = await readFixture();
    expect(schema.models.map((model: IrModel) => model.name).sort()).toEqual([
      'Customer',
      'CustomerNicknames',
      'PurchaseOrder',
      'Tag',
    ]);
  });

  it('gives an entity the properties of its @MappedSuperclass, with @Version', async () => {
    const customer: IrModel = modelOf(await readFixture(), 'Customer');
    expect(fieldOf(customer, 'id').isPrimaryKey).toBe(true);
    expect(fieldOf(customer, 'id').type).toBe('bigInt');
    expect(fieldOf(customer, 'version').isVersion).toBe(true);
    expect(fieldOf(customer, 'createdAt').columnName).toBe('created_at');
  });

  it('reads nullability from the type, the way Hibernate does', async () => {
    const customer: IrModel = modelOf(await readFixture(), 'Customer');
    // A Kotlin Int is a primitive int: Hibernate makes the column NOT NULL. A String is only NOT NULL when told.
    expect(fieldOf(customer, 'loyaltyPoints').isNullable).toBe(false);
    expect(fieldOf(customer, 'name').isNullable).toBe(false);
    expect(fieldOf(customer, 'name').maxLength).toBe(120);
    expect(fieldOf(customer, 'email').isNullable).toBe(true);
    expect(fieldOf(customer, 'email').isUnique).toBe(true);
  });

  it('reads annotations of constructor parameters, with and without a use-site target', async () => {
    const customer: IrModel = modelOf(await readFixture(), 'Customer');
    expect(fieldOf(customer, 'name').maxLength).toBe(120);
    expect(fieldOf(customer, 'tier').enumName).toBe('Tier');
  });

  it('skips @Transient and companion objects, and flattens the embedded value', async () => {
    const schema: IrSchema = await readFixture();
    const customer: IrModel = modelOf(schema, 'Customer');
    expect(customer.fields.map((field: IrField) => field.name)).not.toContain(
      'cached'
    );
    expect(customer.fields.map((field: IrField) => field.name)).not.toContain(
      'MAX_NAME'
    );
    expect(fieldOf(customer, 'addressStreet').columnName).toBe('street_line');
  });

  it('reads relations, collections, indexes and unique constraints', async () => {
    const order: IrModel = modelOf(await readFixture(), 'PurchaseOrder');
    expect(order.relations.map((relation) => relation.name).sort()).toEqual([
      'customer',
      'tags',
    ]);
    expect(order.indexes.map((index) => index.name)).toContain(
      'idx_order_status'
    );
    expect(
      order.indexes
        .filter((index) => index.isUnique)
        .map((index) => index.fields)
    ).toEqual([['customer', 'number']]);
    expect(
      order.relations.find((relation) => relation.name === 'customer')
        ?.isNullable
    ).toBe(false);
  });

  it('reads an enum, and the converter of a column', async () => {
    const schema: IrSchema = await readFixture();
    const status = schema.enums.find((item) => item.name === 'OrderStatus');
    expect(status?.values).toEqual([
      { name: 'NEW', dbValue: 'new' },
      { name: 'PAID', dbValue: 'paid' },
    ]);
    expect(fieldOf(modelOf(schema, 'PurchaseOrder'), 'status').enumName).toBe(
      'OrderStatus'
    );
  });

  it('maps Kotlin types: BigDecimal, ByteArray and a String key', async () => {
    const schema: IrSchema = await readFixture();
    const order: IrModel = modelOf(schema, 'PurchaseOrder');
    expect(fieldOf(order, 'total').type).toBe('decimal');
    expect(fieldOf(order, 'notes').type).toBe('bytes');
    expect(fieldOf(modelOf(schema, 'Tag'), 'code').type).toBe('string');
  });
});

describe('parseKotlin: edge cases', () => {
  const ENTITY: string = `package a
import jakarta.persistence.*
@Entity
class Item(@Id var id: Int? = null)
`;

  it('skips tests, build output and Gradle scripts, and says so', async () => {
    const result = expectOk(
      await parseKotlin(
        [
          { path: 'src/main/kotlin/Item.kt', text: ENTITY },
          {
            path: 'src/test/kotlin/ItemTest.kt',
            text: ENTITY.replace('Item', 'Other'),
          },
          { path: 'build.gradle.kts', text: 'plugins {}' },
        ],
        { appLabel: 'a' }
      )
    );
    expect(result.models.map((model) => model.name)).toEqual(['Item']);
    expect(
      result.warnings.filter((warning) => warning.includes('skipped'))
    ).toHaveLength(2);
    expect(isSkippedKotlinPath('app/build/generated/Foo.kt')).toBe(true);
    expect(isSkippedKotlinPath('app/src/main/kotlin/Foo.kt')).toBe(false);
  });

  it('warns about Kotlin that does not parse, and still reads what it can', async () => {
    const result = expectOk(
      await parseKotlin(
        [{ path: 'Item.kt', text: `${ENTITY}\nclass Broken(` }],
        { appLabel: 'a' }
      )
    );
    expect(result.models.map((model) => model.name)).toEqual(['Item']);
    expect(
      result.warnings.some((warning) =>
        warning.includes('Kotlin syntax errors')
      )
    ).toBe(true);
  });

  it('says what an entity is when none is found', async () => {
    const result = await parseKotlin(
      [{ path: 'Plain.kt', text: 'package a\nclass Plain' }],
      { appLabel: 'a' }
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('NO_MODELS_FOUND');
      expect(result.error.message).toContain(
        'Kotlin class annotated with @Entity'
      );
    }
  });

  it('reads a data class, qualified types and a Kotlin initializer', async () => {
    const schema: IrSchema = await read([
      {
        path: 'Item.kt',
        text: `package a
import jakarta.persistence.*
@Entity
data class Item(
    @Id @GeneratedValue val id: java.util.UUID? = null,
    var label: String = "none",
    var count: Long = 5L,
    var ratio: Double = 1.5,
    @Column(columnDefinition = """text""") var body: String? = null,
)
`,
      },
    ]);
    const item: IrModel = modelOf(schema, 'Item');
    expect(fieldOf(item, 'id').type).toBe('uuid');
    expect(fieldOf(item, 'label').type).toBe('string');
    expect(fieldOf(item, 'count').type).toBe('bigInt');
    expect(fieldOf(item, 'ratio').type).toBe('float');
  });

  it('reads class references, arrayOf, raw use-site targets and nested annotations', async () => {
    const schema: IrSchema = await read([
      {
        path: 'Item.kt',
        text: `package a
import jakarta.persistence.*
interface Marker
object Registry {
    const val NAME = "registry"
}
@Entity
@Table(name = "item", uniqueConstraints = [UniqueConstraint(columnNames = arrayOf("a", "b"))])
class Item {
    @Id var id: Int? = null
    @property:Column(name = "a_col") var a: String? = null
    var b: String? = null
    @get:Convert(converter = ItemConverter::class.java) var c: Kind? = null
    @Embedded var inner: Inner? = null

    @Embeddable
    class Inner {
        var note: String? = null
    }
}
enum class Kind { ONE, TWO }
@Converter
class ItemConverter : AttributeConverter<Kind, String> {
    override fun convertToDatabaseColumn(attribute: Kind?): String? = attribute?.name
    override fun convertToEntityAttribute(dbData: String?): Kind? = null
}
`,
      },
    ]);
    const item: IrModel = modelOf(schema, 'Item');
    expect(fieldOf(item, 'a').columnName).toBe('a_col');
    expect(item.indexes.filter((index) => index.isUnique)).toHaveLength(1);
    expect(item.fields.map((field) => field.name)).toContain('innerNote');
    expect(schema.models.map((model) => model.name)).toEqual(['Item']);
  });
});
