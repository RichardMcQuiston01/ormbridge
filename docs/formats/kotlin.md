# Kotlin entities (addon)

The `ormbridge-kotlin` addon reads and writes Hibernate / JPA entities written in Kotlin (`ormbridge formats --plugin ormbridge-kotlin` lists `kotlin` as `read + write` and claims `.kt`). It is not part of the core package; see [Addons](../ADDONS.md).

```bash
npm install ormbridge ormbridge-kotlin
npx ormbridge convert -i src/main/kotlin -f kotlin -t prisma --plugin ormbridge-kotlin
npx ormbridge convert -i schema.prisma -f prisma -t kotlin -o src/main/kotlin --plugin ormbridge-kotlin
```

Kotlin and Java entities follow the same rules, so everything in the [Hibernate / JPA guide](./jpa.md) applies (annotations read and written, naming, types, `--style`, `--jpa-key`, `--jpa-inheritance`, warnings). Only the language differs. `--lombok` has no use in Kotlin and only adds a warning.

## Reading

Each `.kt` file is parsed with the tree-sitter Kotlin grammar and rewritten as the Java text of the same entities, which the JPA reader then reads. Nothing is compiled.

- **Classes.** `class`, `data class`, `open` and `abstract` classes, nested classes and enums (`enum class Status(val code: String) { NEW("new") }`) are read; interfaces, objects, companion objects, annotation classes and functions are not. `@Entity`, `@MappedSuperclass` and `@Embeddable` classes work as in Java, and a class that extends another with `: Base()` inherits its mapped properties.
- **Properties.** Constructor `val` and `var` parameters and properties in the class body are the attributes. `@Transient` ones and `const val` are skipped. Annotations with a use-site target (`@field:Column`, `@get:Id`, `@property:`, `@param:`) are read like the plain annotation.
- **Nullability.** Hibernate does not read Kotlin nullability, and neither does ormbridge, with one exception that Hibernate shares: a non-null `Int`, `Long`, `Boolean`, `Double`, ... is a primitive on the JVM, so its column is `NOT NULL`, while `Int?` is nullable. A non-null `String` or entity is nullable unless an annotation says otherwise (`@Column(nullable = false)`, `@ManyToOne(optional = false)`).
- **Types.** `Int`, `Long`, `Short`, `Byte`, `Boolean`, `Double`, `Float`, `Char`, `String`, `ByteArray` and the other primitive arrays, `Array<T>`, `List` / `MutableList`, `Set` / `MutableSet`, `Map` / `MutableMap`, `Collection`, and every Java class a Java entity uses (`java.time`, `UUID`, `BigDecimal`, ...), also written fully qualified.
- **Annotation arguments.** Arrays in brackets (`indexes = [Index(columnList = "title")]`), `arrayOf(...)`, `Foo::class` and `Foo::class.java`, nested annotations and raw strings. An argument that is not a literal, a constant or a class reference is left out.
- **Skipped files.** `src/test` and `src/androidTest`, `build`, `out`, `.gradle`, `*.kts` and `*Test.kt` / `*Tests.kt`.
- **Initializers.** `mutableListOf()`, `mutableSetOf()` and `mutableMapOf()` (and their `empty` / `hash` forms) are read as the empty collections; other expressions are kept only when they are literals or simple calls such as `Instant.now()`.

Not read: `orm.xml`, Kotlin script files, and Kotlin that does not parse (the file is read as far as it goes, with a warning). The tree-sitter Kotlin grammar fails on a class body written on one line with a property in it (`class Inner { var note: String? = null }`); put the properties on their own lines.

## Writing

`--to kotlin` writes the same classes as `--to jpa`: one `@Entity` class per model, an `enum class` per enum (with an `AttributeConverter` when the stored values differ from the names), and a key class for a composite key (`data class ... : Serializable`, with `@Embeddable` for `--jpa-key embedded`). The output uses nothing newer than Kotlin 1.9 and is checked with the Kotlin 2.0 compiler; it is written for `jakarta.persistence` (or `javax.persistence` with `--style javax`).

- Properties are `var`s with an initial value, so every class has the no-argument constructor JPA needs: `Int?` and entity references start as `null`, a NOT NULL reference is `lateinit var`, a primitive starts at its default, collections at `mutableSetOf()`, `mutableListOf()` or `mutableMapOf()`, and a column default is kept as the initializer.
- Classes are final unless another entity extends them (then `open`; an abstract table-per-class root is `abstract`). For lazy proxies, apply the Kotlin all-open and JPA plugins, as Spring Initializr does: `kotlin("plugin.allopen")` with `allOpen { annotation("jakarta.persistence.Entity") ... }` and `kotlin("plugin.jpa")`.
- Annotation arrays are written in brackets, class references as `Foo::class`, and a Java-only `@SuppressWarnings` is left out.
- A property named like a Kotlin keyword (`in`, `object`, ...) is written in backticks.

The output is compiled with the Kotlin 2.0 compiler (with the all-open plugin) and mapped by Hibernate 6.4 in the repository's tests: every schema of the JPA tests (canonical, composite keys, `@EmbeddedId`, joined, single-table and table-per-class inheritance, embeddables, many to many, every column type) creates the same tables and saves the same rows as the Java output. The Kotlin output also reads back as the same schema as the Java output.

## Programmatic API

```ts
import { emitKotlin, parseKotlin } from 'ormbridge-kotlin';

const schema = await parseKotlin([{ path: 'Post.kt', text: source }], {
  appLabel: 'blog',
});
const written = emitKotlin(schemaValue, {
  provider: 'postgresql',
  naming: 'preserve',
  header: true,
});
```

`emitKotlin` takes the options of `emitJpa` and returns the same `{ files, warnings }`.

[Back to the format guides](./README.md)
