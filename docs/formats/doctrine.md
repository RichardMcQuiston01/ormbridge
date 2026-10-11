# Doctrine

ormbridge reads and writes Doctrine ORM entities written with PHP 8 attributes (`ormbridge formats` lists `doctrine` as `read + write`). It claims no file extension, because `.php` is too generic: always pass `--from doctrine` when reading and `--to doctrine` when writing. Reading is static (tree-sitter), so PHP and Composer are not needed. Writing produces several files, so `-o` must be a directory.

## Try it

The example in [`examples/doctrine`](../../examples/doctrine/) has two conversions in `ormbridge.config.json`:

```bash
cd examples/doctrine
npx ormbridge convert            # runs both conversions
npx ormbridge convert --check
```

| Conversion      | Input                     | Output                                                                                              |
| --------------- | ------------------------- | --------------------------------------------------------------------------------------------------- |
| `to-doctrine`   | `../schema/schema.prisma` | `models/src/Entity/{Category,Post,PostTags,Profile,Tag,User}.php`, `models/src/Enum/PostStatus.php` |
| `from-doctrine` | `models` (the folder)     | `prisma/schema.prisma`                                                                              |

Inside this repository run `node ../../dist/cli.js convert` after `npm run build`. Without the config file: `ormbridge convert -i ../schema/schema.prisma -t doctrine -o models` and `ormbridge convert -i models -f doctrine -t prisma -o prisma/schema.prisma`.

## Reading

- **Input.** `.php` files or directories. In a directory every `.php` file is read except `*Test.php`; `vendor`, `var`, `node_modules`, `venv`, `.venv`, `env`, `.git`, `__pycache__`, `migrations`, `site-packages`, `dist` and `build` are skipped. Several files are merged, so mapped superclasses, traits, embeddables and enums may live in other files (a missing one warns and says to add it to `--input`).
- **Classes.** `#[ORM\Entity]`, `#[ORM\MappedSuperclass]` and `#[ORM\Embeddable]` / `#[ORM\Embedded]`, with `#[ORM\Table]`, `#[ORM\Index]` and `#[ORM\UniqueConstraint]`. Inheritance: `SINGLE_TABLE` is flattened into one table with nullable columns, `JOINED` becomes a one-to-one primary key.
- **Properties.** `#[ORM\Id]`, `#[ORM\GeneratedValue]` (`AUTO`, `IDENTITY`, `SEQUENCE`, `UUID`, `NONE`), `#[ORM\Column]` with DBAL `type`, `length`, `precision`, `scale`, `nullable`, `unique`, `name`, `enumType` (string-backed PHP enums), and `#[ORM\Version]`.
- **Relations.** `#[ORM\OneToOne]`, `ManyToOne`, `OneToMany` and `ManyToMany` with `#[ORM\JoinColumn]` (`onDelete`), `#[ORM\JoinTable]`, `mappedBy` and `inversedBy`. The target is taken from `targetEntity: Foo::class` or the property type.
- **Defaults.** Property initializers and constructor values that are literals or enum cases; lifecycle callbacks that only assign a timestamp (`$this->updated_at = new \DateTimeImmutable();`) mark the column as auto-updated.
- **Nullability** follows the attribute (`nullable: true`), never the PHP type. `?string` with a plain `#[ORM\Column]` is `NOT NULL`, as in Doctrine itself.

Docblock annotations (`@ORM\Entity`) and XML/YAML mappings are not read. When nothing else is found the run fails: `No Doctrine entities were found in: ... Docblock annotations (@ORM\Entity) were found in ...; annotation mapping is not supported yet, so convert them to PHP 8 attributes.`

## Writing

One PSR-4 file per entity and per backed enum, so the result is multi-file. With the defaults: `src/Entity/<Name>.php` in namespace `App\Entity` and `src/Enum/<Name>.php` in `App\Enum`. Each entity has `declare(strict_types=1)`, `#[ORM\Entity]`, `#[ORM\Table(name: ...)]`, typed private properties, a constructor that initialises collections and defaults (UUIDs, timestamps), getters and setters, `add*` / `remove*` methods for collections, and, for auto-updated columns, `#[ORM\HasLifecycleCallbacks]` with a `#[ORM\PrePersist]` / `#[ORM\PreUpdate]` method.

- Dates are `DateTimeImmutable`, written as `datetimetz_immutable` on PostgreSQL and `datetime_immutable` elsewhere. `uuid` columns use `guid`, JSON uses `json` (with `options: ['jsonb' => true]` on PostgreSQL), decimals and bigints are PHP `string`.
- An empty JSON default (`{}` or `[]`) becomes `[]`, because PHP has one empty array literal.
- Prisma `@@map` names become `#[ORM\Table(name: ...)]`; indexes use `#[ORM\Index]` / `#[ORM\UniqueConstraint]`; `onDelete` goes on `#[ORM\JoinColumn]`.

| Option                        | Effect                                                                                                                                                                                                                                                               |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `-o <dir>`                    | Required for file output. Passing a file path fails with a message asking for a directory.                                                                                                                                                                           |
| `--namespace <ns>`            | Entity namespace (default `App\Entity`). The first segment maps to `src/`, the rest to folders; `--namespace 'Acme\Model'` writes `src/Model/*.php`, with enums in `Acme\Model\Enum`. An invalid name fails with `Invalid namespace "..."`. Config key: `namespace`. |
| `--provider`                  | Picks date, JSON and UUID column types. `mongodb` warns that Doctrine ORM is relational.                                                                                                                                                                             |
| `--naming preserve` (default) | Properties and table names as in the source.                                                                                                                                                                                                                         |
| `--naming normalize`          | Singular snake_case tables, UUID keys, camelCase properties mapped back to column names, `created_at` / `updated_at` added.                                                                                                                                          |

## Limitations and warnings

- Not supported, each with a warning naming the entity and property: attribute and association overrides, composite foreign keys (several `#[ORM\JoinColumn]`), `columnDefinition`, other column `options` (`unsigned`, `comment`, `collation`), partial and spatial indexes, table `schema` and `options`, custom id generators and `#[ORM\SequenceGenerator]`, `array` / `object` / `simple_array` and custom DBAL types, int-backed or non-backed enums, relations inside embeddables, and `#[ORM\DiscriminatorMap]` values (the discriminator column is kept).
- ORM-level `cascade` / `orphanRemoval` are not part of the schema: `... ORM-level cascade remove / orphanRemoval is not represented; use onDelete: 'CASCADE' on the join column for a database-level cascade.` Custom join table names are not kept either.
- A class with mapping attributes but no `#[ORM\Entity]` is skipped with a warning. Constructor values that need PHP to run are ignored with a warning.
- Writer: `DurationField` becomes a `dateinterval` column with `Doctrine has no database interval type; ...`, arrays become `json`, hstore becomes `json`, ranges become strings, and `the model has no primary key; Doctrine requires at least one #[ORM\Id] property.` Prisma-only constructs (views, `Unsupported(...)`, `@@fulltext`, composite foreign keys) warn as for every non-Prisma target.

See the [conversion matrix](../CONVERSION_MATRIX.md): [doctrine to prisma](../CONVERSION_MATRIX.md#doctrine--prisma), [doctrine to django](../CONVERSION_MATRIX.md#doctrine--django), [doctrine to typeorm](../CONVERSION_MATRIX.md#doctrine--typeorm), [prisma to doctrine](../CONVERSION_MATRIX.md#prisma--doctrine), and [why information is lost](../CONVERSION_MATRIX.md#why-information-is-lost) (the empty JSON default is reason 4, which is why the example's `metadata` default reads back as `"[]"`).

## Programmatic API

```ts
import {
  convertText,
  parseDoctrine,
  emitDoctrine,
  type ConvertResult,
  type IrSchema,
  type MultiFileEmitOutput,
  type Result,
} from 'ormbridge';

declare const prismaText: string;
declare const entityPhp: string;

// Prisma -> Doctrine. A multi-file result leaves `output` empty and fills `files`.
const converted: Result<ConvertResult> = await convertText(
  [{ path: 'schema.prisma', text: prismaText }],
  {
    from: 'prisma',
    to: 'doctrine',
    naming: 'preserve',
    provider: 'postgresql',
    header: true,
    autoField: 'int',
    namespace: 'Acme\\Model',
  }
);
if (converted.ok) {
  for (const [path, text] of Object.entries(converted.value.files ?? {})) {
    console.log(path, text.length); // src/Model/Post.php, ...
  }
} else {
  console.error(`${converted.error.code}: ${converted.error.message}`);
}

// Lower level.
const parsed: Result<IrSchema> = await parseDoctrine(
  [{ path: 'src/Entity/Post.php', text: entityPhp }],
  { appLabel: 'app' }
);
if (parsed.ok) {
  const emitted: MultiFileEmitOutput = emitDoctrine(parsed.value, {
    provider: 'postgresql',
    camelFields: false,
  });
  console.log(Object.keys(emitted.files), emitted.warnings);
}
```

`emitDoctrine` returns `{ files, warnings }` directly (not a `Result`); `convertText` validates `namespace` and applies `--naming` first.
