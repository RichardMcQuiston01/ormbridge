# ormbridge-neo4j

- Author: [Richard McQuiston](mailto:richard.mcquiston01@gmail.com)
- Website: https://richardmcquiston.com/

## Table of Contents

| [Overview](#overview) | [Getting Started](#getting-started) | [More Information](#more-information) | [License](#license) | [Copyright](#copyright) |

## Overview

`ormbridge-neo4j` adds the Neo4j writers to [ormbridge](https://github.com/RichardMcQuiston01/ormbridge), a tool that converts data models between frameworks. It writes a graph model from any format ormbridge reads, such as Django, Prisma, TypeORM, or SQL. The three formats only write; none of them reads.

- `neo4j` writes a Cypher schema: node constraints and indexes, with relationships as comments. `--style enterprise` adds the statements that need Neo4j Enterprise Edition.
- `neomodel` writes Python `StructuredNode` classes.
- `sdn` writes Spring Data Neo4j 7 entities in Java.

They used to be part of the core package and moved here in ormbridge 0.22. The package has no WebAssembly grammar, so it is small.

[Back to Top](#table-of-contents)

## Getting Started

### Prerequisites

- Node.js 20 or newer.
- `ormbridge` 0.22 or newer. It is a peer dependency.
- Neo4j, Python, and Java are not needed to write the files.

### Installation

```bash
npm install ormbridge ormbridge-neo4j
```

### Usage

1. Write a Cypher schema from a Prisma schema:

   ```bash
   npx ormbridge convert \
     -i schema.prisma \
     -f prisma -t neo4j \
     -o ./neo4j/schema.cypher \
     --plugin ormbridge-neo4j
   ```

2. Write neomodel classes:

   ```bash
   npx ormbridge convert \
     -i schema.prisma \
     -f prisma -t neomodel \
     -o ./app/models.py \
     --plugin ormbridge-neo4j
   ```

3. Write Spring Data Neo4j entities:

   ```bash
   npx ormbridge convert \
     -i schema.prisma \
     -f prisma -t sdn \
     -o ./src/main/java \
     --namespace app.models \
     --plugin ormbridge-neo4j
   ```

4. Or name the plugin once in `ormbridge.config.json`:

   ```json
   { "plugins": ["ormbridge-neo4j"] }
   ```

### Examples

Use the package from code:

```ts
import { emitNeo4j } from 'ormbridge-neo4j';

const output = emitNeo4j(schema, { style: 'enterprise' });
```

`emitNeo4j` returns the Cypher text and its warnings. `emitNeomodel` returns a Python module. `emitSdn` returns one Java file for each node, enum, and relationship type.

[Back to Top](#table-of-contents)

## More Information

- [Neo4j guide](https://github.com/RichardMcQuiston01/ormbridge/blob/main/docs/formats/neo4j.md), [neomodel guide](https://github.com/RichardMcQuiston01/ormbridge/blob/main/docs/formats/neomodel.md) and [Spring Data Neo4j guide](https://github.com/RichardMcQuiston01/ormbridge/blob/main/docs/formats/sdn.md): what is written and what is lost.
- [Add-on packages](https://github.com/RichardMcQuiston01/ormbridge/blob/main/docs/ADDONS.md): how plugins load.
- [ormbridge on GitHub](https://github.com/RichardMcQuiston01/ormbridge).

[Back to Top](#table-of-contents)

## License

MIT

[Back to Top](#table-of-contents)

## Copyright

(c)2026 Richard McQuiston. All rights reserved.

[Back to Top](#table-of-contents)
