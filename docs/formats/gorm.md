# GORM

GORM is the Go ORM; its schema is a set of Go structs with `gorm:"..."` tags. ormbridge reads and writes it (`ormbridge formats` lists it as `read + write`). It claims no file extension, so pass `--from gorm` when reading and `--to gorm` when writing. GORM output is a directory, so `-o` must be a directory.

## Try it

```bash
cd examples/gorm
npx ormbridge convert           # runs both conversions in ormbridge.config.json
npx ormbridge convert --check   # exit code 3 if the output is stale
# inside this repository, after npm run build: node ../../dist/cli.js convert
```

- `to-gorm`: `../schema/schema.prisma` becomes `models/models/{user,category,post,profile,tag,post_tags}.go` plus `models/models/post_status.go` for the enum.
- `from-gorm`: `models/` is read back into `prisma/schema.prisma`. This step prints seven warnings about `constraint:` tags (see below).

The runnable example is in [examples/gorm](../../examples/gorm/).

## Reading

`--from gorm` parses Go with the tree-sitter Go grammar. No Go toolchain or database is needed and no Go code runs. Pass the directory with the models or individual files. Every `.go` file is read except `*_test.go` and anything below `vendor/`, `testdata/`, `node_modules/` and `.git/`.

A struct is read as a model when it embeds `gorm.Model`, has a `gorm:"..."` tag, has an `ID` field, has a `TableName()` method, or is the target of an association. Unexported fields and `gorm:"-"` fields are skipped.

Names follow GORM's own rules: tables are the pluralised snake_case struct name unless `TableName()` returns a literal or constant, columns are the snake_case field name unless `column:` says otherwise, `ID` is the primary key, and a foreign key is `<Field>ID`.

Understood: `string`, `bool`, `int*`, `uint*`, `float*`, `[]byte`, `time.Time`, `uuid.UUID`, `decimal.Decimal`, `datatypes.JSON`, pointers and `sql.Null*` (nullable); tags `type`, `size`, `precision`, `scale`, `column`, `primaryKey`, `autoIncrement`, `unique`, `not null`, `default`, `index`, `uniqueIndex` (named, composite, `priority`), `autoCreateTime`, `autoUpdateTime`, `embedded`, `serializer:json`; `gorm.Model`; `gorm.DeletedAt`; belongs-to, has-one, has-many with `foreignKey`, `references` and `constraint:OnDelete/OnUpdate`; `many2many` (one or both sides); typed string constants as enums. The full table is in the README section "GORM (`--from gorm`)".

## Writing

Output is multi-file: one Go file per model (`models/post.go`, snake_case), one per enum (`models/post_status.go`), all in one package and formatted as `gofmt` would.

- Types: `string` with `size:n` or `type:text`, `int32`, `int64`, `float64`, `bool`, `time.Time`, `uuid.UUID`, `decimal.Decimal`, `datatypes.JSON`, `[]byte`. Nullable columns are pointers.
- A `TableName()` method is written only when the table is not what GORM would derive from the type name (the example's `blog_post` gets one).
- `now` defaults are `autoCreateTime`, auto-updated columns are `autoUpdateTime`. A model that matches `gorm.Model` exactly embeds it.
- Relations are written on both sides: `AuthorID` plus `Author User`, tagged `foreignKey:AuthorID;constraint:OnDelete:CASCADE`; reverse sides are `[]Post` (named from `related_name` or the plural). Many-to-many is `[]Tag` with `many2many:<table>_<relation>`.
- Enums are typed strings (`type PostStatus string`) with a `const` block. Indexes are tags (`index`, `uniqueIndex`, `priority:n`).
- The output needs `gorm.io/gorm`, and `github.com/google/uuid`, `github.com/shopspring/decimal`, `gorm.io/datatypes` for the types that use them (`go get` them).

| Option                | Effect                                                                                                                                       |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `--naming preserve`   | Default. Keeps source table and column names (explicit `TableName()` / `column:` where GORM's convention would differ).                      |
| `--naming normalize`  | GORM conventions: plural snake_case tables, snake_case columns, `created_at` / `updated_at` added where missing. Primary key types are kept. |
| `--go-package <name>` | Package name and output sub-directory (default `models`; must be a Go identifier, not a keyword). Config key: `goPackage`.                   |
| `--provider <name>`   | Affects UUID defaults (`gen_random_uuid()` on PostgreSQL, a `BeforeCreate` hook elsewhere) and the `uuid` column type. `mongodb` only warns. |

## Limitations and warnings

- Integers are signed `int32` / `int64` (the IR has no unsigned types). Arrays become `datatypes.JSONSlice[T]` with a warning (`Doc.tags: GORM has no portable array column type; the array was written as a JSON column (datatypes.JSONSlice).`). Unsupported types become `string` with `type:<name>` (`Doc.body: the database type "tsvector" has no Go type here; ...`).
- A nullable `deleted_at` on a model that is not `gorm.Model` becomes `gorm.DeletedAt` with a warning, because GORM then hides rows where it is set.
- Composite foreign keys, views, generated columns, full-text indexes, index options and `@@schema` are written as plain tables and columns, each with a warning. There are no `check:`, `comment:` or `polymorphic:` tags.
- Reading never executes code: a computed `TableName()`, a custom `NamingStrategy`, `Scanner`/`Valuer` types, polymorphic associations, `check:` constraints, partial or expression indexes and custom join table names are not seen or are reported.
- `from-gorm` warns `Post.Author: GORM ignores the constraint:... tag of a belongs-to field when User.Posts describes the same foreign key; set the constraint on that field instead.` for ormbridge's own output; the schema is still read correctly.
- Round trips: an empty string default is lost (reason 5), reverse relation names become Go field names (reason 6), and `updated_at` gains `autoUpdateTime` (reason 7).

See [prisma → gorm](../CONVERSION_MATRIX.md#prisma--gorm), [gorm → prisma](../CONVERSION_MATRIX.md#gorm--prisma) and [why information is lost](../CONVERSION_MATRIX.md#why-information-is-lost) in the conversion matrix.

## Programmatic API

All functions return `Result<T>` and do not throw.

```ts
import { readFile } from 'node:fs/promises';
import { convertText } from 'ormbridge';
import type { ConvertResult, Result } from 'ormbridge';

const text: string = await readFile('schema.prisma', 'utf8');
const result: Result<ConvertResult> = await convertText(
  [{ path: 'schema.prisma', text }],
  {
    from: 'prisma',
    to: 'gorm',
    naming: 'preserve',
    provider: 'postgresql',
    header: true,
    autoField: 'int',
    goPackage: 'store',
  }
);
if (!result.ok) {
  console.error(result.error.code, result.error.message);
} else {
  // files: path -> Go source, e.g. "store/post.go"
  for (const path of Object.keys(result.value.files ?? {})) {
    console.log(path);
  }
  console.log(result.value.warnings);
}
```

To read, pass the `.go` files as `SourceText[]` with `from: 'gorm'`. Lower-level: `parseGorm(sources, { appLabel })` returns `Result<IrSchema>` and `emitGorm(schema, { provider, naming, goPackage })` returns `{ files, warnings }`.
