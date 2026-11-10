# Addons

An addon is an npm package that adds formats to ormbridge. Core keeps the intermediate representation and the formats most projects need; formats for a single language or framework can ship as addons, so they are installed only by the people who use them.

## Using an addon

Install it next to ormbridge and name it, either on the command line or in the config file:

```bash
npm install ormbridge @ormbridge/kotlin
npx ormbridge convert -i src/main/kotlin -f kotlin -t prisma --plugin @ormbridge/kotlin
```

```json
{
  "plugins": ["@ormbridge/kotlin"],
  "from": "kotlin",
  "to": "prisma",
  "input": ["src/main/kotlin"]
}
```

- `--plugin` takes one or more package names or paths; the `plugins` key of the config file takes the same. Packages resolve from the config file's directory (or the working directory for the flag); a path starting with `.` resolves against the same directory.
- `ormbridge formats --plugin <name>` lists the formats a plugin adds.
- A plugin is JavaScript that runs in the ormbridge process with your permissions, so install only addons you trust. The config file itself is still plain JSON.
- Naming a plugin twice (flag and config file) loads it once. A plugin whose format name or extension is already taken fails with a message naming it, and registers nothing.

## Available addons

| Package                                                                        | Formats                             | Guide                                       |
| ------------------------------------------------------------------------------ | ----------------------------------- | ------------------------------------------- |
| [`ormbridge-kotlin`](https://www.npmjs.com/package/ormbridge-kotlin)           | `kotlin`                            | [Kotlin entities](./formats/kotlin.md)      |
| [`ormbridge-spring-data`](https://www.npmjs.com/package/ormbridge-spring-data) | `spring-data`, `spring-data-kotlin` | [Spring Data JPA](./formats/spring-data.md) |

The addons live in the [`packages/`](../packages/) folder of this repository, are versioned on their own and are published with each release of ormbridge. They depend on `ormbridge` as a peer dependency, so install both. Addon formats are not in the [conversion matrix](./CONVERSION_MATRIX.md), which covers the formats of the core package.

## Writing an addon

An addon's default export (or a named export `plugin`) is an `OrmbridgePlugin`: a name and the format adapters it adds.

```ts
import type { OrmbridgePlugin } from 'ormbridge';

const plugin: OrmbridgePlugin = {
  name: '@acme/ormbridge-example',
  formats: [
    {
      name: 'example',
      extensions: [],
      description: 'Example format',
      emit: (schema) => ({
        ok: true,
        value: { text: `${schema.models.length} model(s)\n`, warnings: [] },
      }),
    },
  ],
};

export default plugin;
```

- List `ormbridge` as a **peer dependency** so the addon and the CLI share one registry and one IR.
- Export a `default` condition from `package.json` (`"exports": { ".": { "import": "./dist/index.js", "default": "./dist/index.js" } }`), which is how ormbridge resolves the package.
- The adapter interface is described in the [format registry](./API.md#format-registry). Give the adapter an `input` (the extensions of its source files, what the files are called in the "no files found" message, the directories and files to skip) so that a directory input is searched for the right files; without it a directory is searched like Django models.
- The JPA writer can be reused: `emitJpa` takes an `extension` with a `renderer` (writes the planned classes in another language; the Kotlin addon does this) and an `adjust` step (changes the plans and adds files; the Spring Data addon does this), and `jpaEmitOptionsFor(formatOptions)` validates and converts the options of a format the way the `jpa` format does. See the two addons in [`packages/`](../packages/) for working examples.
- Programmatic use: `loadPlugin(specifier, baseDirectory)`, `loadPlugins` and `registerPlugin(plugin)` are exported from `ormbridge`.

[Back to the format guides](./formats/README.md)
