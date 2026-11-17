# ormbridge-spring-data

- Author: [Richard McQuiston](mailto:richard.mcquiston@gmail.com)
- Website: https://richardmcquiston.com/

## Table of Contents

| [Overview](#overview) | [Getting Started](#getting-started) | [More Information](#more-information) | [License](#license) | [Copyright](#copyright) |

## Overview

`ormbridge-spring-data` adds Spring Data JPA support to [ormbridge](https://github.com/RichardMcQuiston01/ormbridge), a tool that converts data models between frameworks. It reads and writes Spring Data entities in Java and in Kotlin.

The output uses the Hibernate mapping with Spring auditing annotations. It writes `@CreatedDate`, `@LastModifiedDate`, and `@EntityListeners(AuditingEntityListener)`. It also writes one `JpaRepository` for each entity, and a configuration class that turns on auditing with `@EnableJpaAuditing`.

The package adds two formats: `spring-data` for Java and `spring-data-kotlin` for Kotlin.

[Back to Top](#table-of-contents)

## Getting Started

### Prerequisites

- Node.js 20 or newer.
- `ormbridge` 0.21 or newer. It is a peer dependency.

### Installation

```bash
npm install ormbridge ormbridge-spring-data
```

The package installs [`ormbridge-kotlin`](https://www.npmjs.com/package/ormbridge-kotlin) for the Kotlin format.

### Usage

1. Write Spring Data entities in Java from a Prisma schema:

   ```bash
   npx ormbridge convert \
     -i schema.prisma \
     -f prisma -t spring-data \
     -o src/main/java \
     --plugin ormbridge-spring-data
   ```

2. Read Spring Data entities in Kotlin and write a Prisma schema:

   ```bash
   npx ormbridge convert \
     -i src/main/kotlin \
     -f spring-data-kotlin -t prisma \
     --plugin ormbridge-spring-data
   ```

3. Or name the plugin once in `ormbridge.config.json`:

   ```json
   { "plugins": ["ormbridge-spring-data"] }
   ```

### Examples

Use the package from code:

```ts
import { emitSpringData } from 'ormbridge-spring-data';

const output = emitSpringData(schema, {
  provider: 'postgresql',
  naming: 'preserve',
  header: true,
});
```

`output.files` maps each file path to its text, and `output.warnings` lists what could not be converted. `emitSpringDataKotlin` writes the same files in Kotlin.

[Back to Top](#table-of-contents)

## More Information

- [Spring Data guide](https://github.com/RichardMcQuiston01/ormbridge/blob/main/docs/formats/spring-data.md): what is read, what is written, and what is left out.
- [Kotlin guide](https://github.com/RichardMcQuiston01/ormbridge/blob/main/docs/formats/kotlin.md): the Kotlin rules.
- [Hibernate and JPA guide](https://github.com/RichardMcQuiston01/ormbridge/blob/main/docs/formats/jpa.md): the rules all of these formats share.
- [Add-on packages](https://github.com/RichardMcQuiston01/ormbridge/blob/main/docs/ADDONS.md): how plugins load.
- [ormbridge on GitHub](https://github.com/RichardMcQuiston01/ormbridge).

[Back to Top](#table-of-contents)

## License

MIT

[Back to Top](#table-of-contents)

## Copyright

(c)2026 Richard McQuiston. All rights reserved.

[Back to Top](#table-of-contents)
