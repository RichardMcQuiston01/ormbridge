# Spring Data JPA (addon)

The `ormbridge-spring-data` addon reads and writes Spring Data JPA entities in Java and in Kotlin. It adds two formats (`ormbridge formats --plugin ormbridge-spring-data` lists them as `read + write`): `spring-data` (Java) and `spring-data-kotlin`. It is not part of the core package; see [Addons](../ADDONS.md).

```bash
npm install ormbridge ormbridge-spring-data
npx ormbridge convert -i schema.prisma -f prisma -t spring-data -o src/main/java --plugin ormbridge-spring-data
npx ormbridge convert -i src/main/kotlin -f spring-data-kotlin -t prisma --plugin ormbridge-spring-data
```

The package depends on [`ormbridge-kotlin`](./kotlin.md), which it installs. The entities follow the [Hibernate / JPA guide](./jpa.md); this page lists what Spring Data adds.

## Writing

Compared with `--to jpa` (or `--to kotlin`):

- **Auditing.** A `created_at` column that Hibernate fills in (`@CreationTimestamp`) is written with `@CreatedDate`, and an updated-at column (`@UpdateTimestamp`) with `@LastModifiedDate`. Each entity that has one gets `@EntityListeners(AuditingEntityListener.class)` (`AuditingEntityListener::class` in Kotlin). Any `@ColumnDefault` stays, so the database default and the audited value agree.
- **Auditing configuration.** When an entity is audited, a `JpaAuditingConfig` class (`@Configuration @EnableJpaAuditing`) is written next to the entities, because Spring does not fill in the dates without it.
- **Repositories.** One `interface PostRepository extends JpaRepository<Post, Long>` per concrete entity, in the `repository` package below the entities. The identifier type is the key class of a composite key, the `@Id` attribute's type, the identifier of the entity a derived identity points at, or the identifier of the class an entity extends. An entity without an identifier gets a warning and no repository.
- Everything else is the JPA output: tables, columns, keys, indexes and foreign keys are written explicitly, and `--style`, `--jpa-key`, `--jpa-inheritance`, `--namespace` and `--no-header` apply.

The Java and Kotlin output compiles against Spring Data JPA 3.2 and Spring Framework 6.1 in the repository's tests, and Hibernate 6.4 creates the same tables from it as from the plain JPA output. The repositories and the configuration class are compiled but not started in a Spring context.

## Reading

`--from spring-data` reads Java files and `--from spring-data-kotlin` Kotlin files, with the rules of the [JPA](./jpa.md) and [Kotlin](./kotlin.md) readers. `@CreatedDate` and `@CreationTimestamp` both give a `now` default, and `@LastModifiedDate` and `@UpdateTimestamp` both mark an auto-updated column. `@CreatedBy` and `@LastModifiedBy` (the audited user) have no equivalent in the shared schema and are read as plain nullable columns. Repository interfaces and configuration classes are ignored.

Not read or written: Spring Data repositories' query methods, `@Query`, specifications, projections, Spring Data REST, and Spring Data Neo4j (use the core `sdn` format for that).

[Back to the format guides](./README.md)
