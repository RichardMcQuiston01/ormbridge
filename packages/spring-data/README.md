# ormbridge-spring-data

Spring Data JPA entities for [ormbridge](https://github.com/RichardMcQuiston01/ormbridge), in Java and in Kotlin: the Hibernate / JPA mapping, Spring auditing annotations (`@CreatedDate`, `@LastModifiedDate`, `@EntityListeners(AuditingEntityListener)`), a `JpaRepository` per entity and the `@EnableJpaAuditing` configuration.

```bash
npm install ormbridge ormbridge-spring-data
npx ormbridge convert -i schema.prisma -f prisma -t spring-data -o src/main/java --plugin ormbridge-spring-data
npx ormbridge convert -i src/main/kotlin -f spring-data-kotlin -t prisma --plugin ormbridge-spring-data
```

Or name the plugin in `ormbridge.config.json`: `{ "plugins": ["ormbridge-spring-data"] }`. The package adds two formats, `spring-data` (Java) and `spring-data-kotlin`, and installs [`ormbridge-kotlin`](https://www.npmjs.com/package/ormbridge-kotlin) for the Kotlin one.

See the [Spring Data guide](https://github.com/RichardMcQuiston01/ormbridge/blob/main/docs/formats/spring-data.md).

## Requirements

- Node.js 20 or newer and `ormbridge` 0.21 or newer (a peer dependency).

## License

MIT
