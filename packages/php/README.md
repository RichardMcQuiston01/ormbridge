# ormbridge-php

- Author: [Richard McQuiston](mailto:richard.mcquiston01@gmail.com)
- Website: https://richardmcquiston.com/

## Table of Contents

| [Overview](#overview) | [Getting Started](#getting-started) | [More Information](#more-information) | [License](#license) | [Copyright](#copyright) |

## Overview

`ormbridge-php` adds the PHP ORMs to [ormbridge](https://github.com/RichardMcQuiston01/ormbridge), a tool that converts data models between frameworks. It reads Doctrine entities and Laravel migrations and Eloquent models into the shared schema. It also writes them from any format ormbridge reads, such as Django, Prisma, TypeORM, or SQL.

The package adds two formats: `doctrine` and `laravel`. Both used to be part of the core package and moved here in ormbridge 0.22. Reading uses a WebAssembly PHP grammar that ships inside the package.

[Back to Top](#table-of-contents)

## Getting Started

### Prerequisites

- Node.js 20 or newer.
- `ormbridge` 0.22 or newer. It is a peer dependency.
- PHP and Composer are not needed. ormbridge reads PHP files without running them.

### Installation

```bash
npm install ormbridge ormbridge-php
```

### Usage

1. Read Doctrine entities and write a Prisma schema:

   ```bash
   npx ormbridge convert \
     -i ./src/Entity \
     -f doctrine -t prisma \
     -o ./prisma/schema.prisma \
     --plugin ormbridge-php
   ```

2. Read a Laravel project (migrations and models) and write a Prisma schema:

   ```bash
   npx ormbridge convert \
     -i ./my-laravel-app \
     -f laravel -t prisma \
     -o ./prisma/schema.prisma \
     --plugin ormbridge-php
   ```

3. Write Doctrine entities from a Prisma schema:

   ```bash
   npx ormbridge convert \
     -i schema.prisma \
     -f prisma -t doctrine \
     -o ./src/Entity \
     --namespace 'App\Entity' \
     --plugin ormbridge-php
   ```

4. Or name the plugin once in `ormbridge.config.json`:

   ```json
   { "plugins": ["ormbridge-php"] }
   ```

### Examples

Use the package from code:

```ts
import { emitDoctrine, parseDoctrine } from 'ormbridge-php';

const schema = await parseDoctrine([{ path: 'Post.php', text: source }], {
  appLabel: 'blog',
});
```

`parseDoctrine` and `parseLaravel` return the shared schema. `emitDoctrine` and `emitLaravel` return one file for each model and each enum.

[Back to Top](#table-of-contents)

## More Information

- [Doctrine guide](https://github.com/RichardMcQuiston01/ormbridge/blob/main/docs/formats/doctrine.md) and [Laravel guide](https://github.com/RichardMcQuiston01/ormbridge/blob/main/docs/formats/laravel.md): what is read, what is written, and what is lost.
- [Add-on packages](https://github.com/RichardMcQuiston01/ormbridge/blob/main/docs/ADDONS.md): how plugins load.
- [ormbridge on GitHub](https://github.com/RichardMcQuiston01/ormbridge).

[Back to Top](#table-of-contents)

## License

MIT

[Back to Top](#table-of-contents)

## Copyright

(c)2026 Richard McQuiston. All rights reserved.

[Back to Top](#table-of-contents)
