# ormbridge-kotlin

Kotlin entities (Hibernate / JPA, Spring Data JPA) for [ormbridge](https://github.com/RichardMcQuiston01/ormbridge): read Kotlin classes into the shared schema, and write them from any format ormbridge reads (Django, Prisma, TypeORM, SQL, ...).

```bash
npm install ormbridge ormbridge-kotlin
npx ormbridge convert -i schema.prisma -f prisma -t kotlin -o src/main/kotlin --plugin ormbridge-kotlin
npx ormbridge convert -i src/main/kotlin -f kotlin -t prisma --plugin ormbridge-kotlin
```

Or name the plugin in `ormbridge.config.json`: `{ "plugins": ["ormbridge-kotlin"] }`. The package adds one format, `kotlin` (it claims `.kt`).

Kotlin entities follow the same rules as Java ones: see the [Kotlin guide](https://github.com/RichardMcQuiston01/ormbridge/blob/main/docs/formats/kotlin.md) and the [Hibernate / JPA guide](https://github.com/RichardMcQuiston01/ormbridge/blob/main/docs/formats/jpa.md).

## Requirements

- Node.js 20 or newer and `ormbridge` 0.21 or newer (a peer dependency, so the addon and the CLI share one registry).

## Programmatic use

```ts
import { emitKotlin, parseKotlin } from 'ormbridge-kotlin';
```

`parseKotlin(sources, { appLabel })` returns the shared schema, and `emitKotlin(schema, options)` returns the files (it takes the options of `emitJpa`).

## License

MIT
