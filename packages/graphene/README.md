# ormbridge-graphene

- Author: [Richard McQuiston](mailto:richard.mcquiston01@gmail.com)
- Website: https://richardmcquiston.com/

## Table of Contents

| [Overview](#overview) | [Getting Started](#getting-started) | [More Information](#more-information) | [License](#license) | [Copyright](#copyright) |

## Overview

`ormbridge-graphene` writes a Graphene (graphene-django) GraphQL schema for [ormbridge](https://github.com/RichardMcQuiston01/ormbridge), a tool that converts data models between frameworks. It reads any format ormbridge reads, such as Django, Prisma, TypeORM, or SQL, and writes one Python file.

The file has a type for each model, query fields, and create, update, and delete mutations. It pairs with Django models. The format is write only, so there is no conversion back.

The package adds one format, named `graphene`. It used to be part of the core package and moved here in ormbridge 0.22.

[Back to Top](#table-of-contents)

## Getting Started

### Prerequisites

- Node.js 20 or newer.
- `ormbridge` 0.22 or newer. It is a peer dependency.

### Installation

```bash
npm install ormbridge ormbridge-graphene
```

### Usage

1. Write a Graphene schema from a Prisma schema:

   ```bash
   npx ormbridge convert \
     -i schema.prisma \
     -f prisma -t graphene \
     -o generated/schema.py \
     --plugin ormbridge-graphene
   ```

2. Or name the plugin once in `ormbridge.config.json`:

   ```json
   { "plugins": ["ormbridge-graphene"] }
   ```

The generated file imports the models from `.models`. Put it next to a Django `models.py`. ormbridge can write one with `--to django`.

### Examples

Use the package from code:

```ts
import { emitGraphene } from 'ormbridge-graphene';

const output = emitGraphene(schema);
```

`output.text` is the Python file, and `output.warnings` lists what could not be converted.

[Back to Top](#table-of-contents)

## More Information

- [Graphene guide](https://github.com/RichardMcQuiston01/ormbridge/blob/main/docs/formats/graphene.md): what is written, and the warnings you can expect.
- [Add-on packages](https://github.com/RichardMcQuiston01/ormbridge/blob/main/docs/ADDONS.md): how plugins load.
- [ormbridge on GitHub](https://github.com/RichardMcQuiston01/ormbridge).

[Back to Top](#table-of-contents)

## License

MIT

[Back to Top](#table-of-contents)

## Copyright

(c)2026 Richard McQuiston. All rights reserved.

[Back to Top](#table-of-contents)
