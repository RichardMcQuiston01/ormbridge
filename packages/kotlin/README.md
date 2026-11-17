# ormbridge-kotlin

- Author: [Richard McQuiston](mailto:richard.mcquiston@gmail.com)
- Website: https://richardmcquiston.com/

## Table of Contents

| [Overview](#overview) | [Getting Started](#getting-started) | [More Information](#more-information) | [License](#license) | [Copyright](#copyright) |

## Overview

`ormbridge-kotlin` adds Kotlin support to [ormbridge](https://github.com/RichardMcQuiston01/ormbridge), a tool that converts data models between frameworks. It reads Kotlin entity classes into the shared schema. It also writes Kotlin entities from any format ormbridge reads, such as Django, Prisma, TypeORM, or SQL.

Kotlin entities follow the same rules as Java entities that use the Java Persistence API (JPA) and Hibernate. The package adds one format, named `kotlin`, which claims the `.kt` file extension.

[Back to Top](#table-of-contents)

## Getting Started

### Prerequisites

- Node.js 20 or newer.
- `ormbridge` 0.21 or newer. It is a peer dependency, so the add-on and the command line tool share one copy.

### Installation

```bash
npm install ormbridge ormbridge-kotlin
```

### Usage

1. Read Kotlin entities and write a Prisma schema:

   ```bash
   npx ormbridge convert \
     -i src/main/kotlin \
     -f kotlin -t prisma \
     --plugin ormbridge-kotlin
   ```

2. Write Kotlin entities from a Prisma schema:

   ```bash
   npx ormbridge convert \
     -i schema.prisma \
     -f prisma -t kotlin \
     -o src/main/kotlin \
     --plugin ormbridge-kotlin
   ```

3. Or name the plugin once in `ormbridge.config.json`:

   ```json
   { "plugins": ["ormbridge-kotlin"] }
   ```

### Examples

Use the package from code:

```ts
import { emitKotlin, parseKotlin } from 'ormbridge-kotlin';

const schema = await parseKotlin([{ path: 'Post.kt', text: source }], {
  appLabel: 'blog',
});
```

`parseKotlin` returns the shared schema. `emitKotlin(schema, options)` returns the files to write. It takes the same options as the JPA writer in `ormbridge`.

[Back to Top](#table-of-contents)

## More Information

- [Kotlin guide](https://github.com/RichardMcQuiston01/ormbridge/blob/main/docs/formats/kotlin.md): what is read, what is written, and what is lost.
- [Hibernate and JPA guide](https://github.com/RichardMcQuiston01/ormbridge/blob/main/docs/formats/jpa.md): the rules Kotlin entities share with Java.
- [Add-on packages](https://github.com/RichardMcQuiston01/ormbridge/blob/main/docs/ADDONS.md): how plugins load.
- [ormbridge on GitHub](https://github.com/RichardMcQuiston01/ormbridge).

[Back to Top](#table-of-contents)

## License

MIT

[Back to Top](#table-of-contents)

## Copyright

(c)2026 Richard McQuiston. All rights reserved.

[Back to Top](#table-of-contents)
