# ormbridge-gorm

- Author: [Richard McQuiston](mailto:richard.mcquiston01@gmail.com)
- Website: https://richardmcquiston.com/

## Table of Contents

| [Overview](#overview) | [Getting Started](#getting-started) | [More Information](#more-information) | [License](#license) | [Copyright](#copyright) |

## Overview

`ormbridge-gorm` adds GORM, the Go ORM, to [ormbridge](https://github.com/RichardMcQuiston01/ormbridge), a tool that converts data models between frameworks. It reads Go structs with `gorm` tags into the shared schema. It also writes GORM structs from any format ormbridge reads, such as Django, Prisma, TypeORM, or SQL.

The package adds one format, named `gorm`. It used to be part of the core package and moved here in ormbridge 0.22. Reading uses a small WebAssembly Go grammar (0.2 MB) that ships inside the package.

[Back to Top](#table-of-contents)

## Getting Started

### Prerequisites

- Node.js 20 or newer.
- `ormbridge` 0.22 or newer. It is a peer dependency.
- Go is not needed. ormbridge reads Go files without running them.

### Installation

```bash
npm install ormbridge ormbridge-gorm
```

### Usage

1. Read GORM structs and write a Prisma schema:

   ```bash
   npx ormbridge convert \
     -i ./internal/models \
     -f gorm -t prisma \
     -o ./prisma/schema.prisma \
     --plugin ormbridge-gorm
   ```

2. Write GORM structs from a Prisma schema:

   ```bash
   npx ormbridge convert \
     -i schema.prisma \
     -f prisma -t gorm \
     -o ./internal \
     --go-package models \
     --plugin ormbridge-gorm
   ```

3. Or name the plugin once in `ormbridge.config.json`:

   ```json
   { "plugins": ["ormbridge-gorm"] }
   ```

### Examples

Use the package from code:

```ts
import { emitGorm, parseGorm } from 'ormbridge-gorm';

const schema = await parseGorm([{ path: 'post.go', text: source }], {
  appLabel: 'blog',
});
```

`parseGorm` returns the shared schema. `emitGorm(schema, options)` returns one file for each model and each enum.

[Back to Top](#table-of-contents)

## More Information

- [GORM guide](https://github.com/RichardMcQuiston01/ormbridge/blob/main/docs/formats/gorm.md): what is read, what is written, and what is lost.
- [Add-on packages](https://github.com/RichardMcQuiston01/ormbridge/blob/main/docs/ADDONS.md): how plugins load.
- [ormbridge on GitHub](https://github.com/RichardMcQuiston01/ormbridge).

[Back to Top](#table-of-contents)

## License

MIT

[Back to Top](#table-of-contents)

## Copyright

(c)2026 Richard McQuiston. All rights reserved.

[Back to Top](#table-of-contents)
