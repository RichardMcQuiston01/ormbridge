# ormbridge-efcore

- Author: [Richard McQuiston](mailto:richard.mcquiston01@gmail.com)
- Website: https://richardmcquiston.com/

## Table of Contents

| [Overview](#overview) | [Getting Started](#getting-started) | [More Information](#more-information) | [License](#license) | [Copyright](#copyright) |

## Overview

`ormbridge-efcore` adds Entity Framework Core, the .NET ORM, to [ormbridge](https://github.com/RichardMcQuiston01/ormbridge), a tool that converts data models between frameworks. It reads C# entity classes, the `DbContext`, fluent configuration, and migrations into the shared schema. It also writes EF Core 8 models from any format ormbridge reads, such as Django, Prisma, TypeORM, or SQL.

The package adds one format, named `efcore`. It used to be part of the core package and moved here in ormbridge 0.22. Reading uses a WebAssembly C# grammar (3.8 MB) that ships inside the package.

[Back to Top](#table-of-contents)

## Getting Started

### Prerequisites

- Node.js 20 or newer.
- `ormbridge` 0.22 or newer. It is a peer dependency.
- The .NET SDK is not needed. ormbridge reads C# files without compiling them.

### Installation

```bash
npm install ormbridge ormbridge-efcore
```

### Usage

1. Read EF Core models and write a Prisma schema:

   ```bash
   npx ormbridge convert \
     -i ./Models \
     -f efcore -t prisma \
     -o ./prisma/schema.prisma \
     --plugin ormbridge-efcore
   ```

2. Write EF Core models from a Prisma schema:

   ```bash
   npx ormbridge convert \
     -i schema.prisma \
     -f prisma -t efcore \
     -o ./Data \
     --style fluent \
     --namespace Shop.Data \
     --plugin ormbridge-efcore
   ```

3. Or name the plugin once in `ormbridge.config.json`:

   ```json
   { "plugins": ["ormbridge-efcore"] }
   ```

### Examples

Use the package from code:

```ts
import { emitEfcore, parseEfcore } from 'ormbridge-efcore';

const schema = await parseEfcore([{ path: 'Post.cs', text: source }], {
  appLabel: 'blog',
});
```

`parseEfcore` returns the shared schema. `emitEfcore(schema, options)` returns one file for each entity, enum, and the `DbContext`.

[Back to Top](#table-of-contents)

## More Information

- [EF Core guide](https://github.com/RichardMcQuiston01/ormbridge/blob/main/docs/formats/efcore.md): what is read, what is written, and what is lost.
- [Add-on packages](https://github.com/RichardMcQuiston01/ormbridge/blob/main/docs/ADDONS.md): how plugins load.
- [ormbridge on GitHub](https://github.com/RichardMcQuiston01/ormbridge).

[Back to Top](#table-of-contents)

## License

MIT

[Back to Top](#table-of-contents)

## Copyright

(c)2026 Richard McQuiston. All rights reserved.

[Back to Top](#table-of-contents)
