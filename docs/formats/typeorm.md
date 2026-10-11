# TypeORM

ormbridge reads and writes TypeORM entity classes written with decorators (`ormbridge formats` lists `typeorm` as `read + write`). It claims no file extension, because `.ts` is too generic: always pass `--from typeorm` when reading and `--to typeorm` when writing. Without them a `.ts` input is treated as Django and fails with `No concrete Django models were found in: ...`, and an output of `entities.ts` does not select TypeORM.

## Try it

The example in [`examples/typeorm`](../../examples/typeorm/) has two conversions in `ormbridge.config.json`:

```bash
cd examples/typeorm
npx ormbridge convert            # runs both conversions
npx ormbridge convert --check
```

| Conversion     | Input                     | Output                 |
| -------------- | ------------------------- | ---------------------- |
| `to-typeorm`   | `../schema/schema.prisma` | `models/entities.ts`   |
| `from-typeorm` | `models` (the folder)     | `prisma/schema.prisma` |

Inside this repository run `node ../../dist/cli.js convert` after `npm run build`. Without the config file: `ormbridge convert -i ../schema/schema.prisma -t typeorm -o models/entities.ts` and `ormbridge convert -i models -f typeorm -t prisma -o prisma/schema.prisma`.

## Reading

- **Input.** A `.ts` file or a directory. In a directory every `.ts` file is read except `*.d.ts`, `*.test.ts` and `*.spec.ts`, and entities are picked out of them; other classes are ignored. Directory walks skip `node_modules`, `venv`, `.venv`, `env`, `.git`, `__pycache__`, `migrations`, `site-packages`, `dist` and `build`. Several files are merged, so abstract base classes and enums may live in other files.
- **Entities.** `@Entity('table')` and `@ViewEntity` (read as a view with its `@ViewColumn` columns; the view `expression` is not converted).
- **Columns.** `@PrimaryGeneratedColumn` (`increment`, `uuid`; `rowid` is read as auto-increment with a warning), `@PrimaryColumn`, `@Column` with `type`, `length`, `precision`, `scale`, `nullable`, `unique`, `default` and `enum`, `@CreateDateColumn`, `@UpdateDateColumn`, `@DeleteDateColumn`, `@VersionColumn`, and embedded entities (`@Column(() => Type)`). With no explicit `type`, the TypeScript property type decides the column.
- **Enums.** TypeScript string enums, referenced through `enum:`. Numeric enums become integers with a warning.
- **Relations.** `@ManyToOne`, `@OneToMany`, `@OneToOne` and `@ManyToMany` with `@JoinColumn`, `@JoinTable` and `onDelete`. The target must be an arrow function (`() => User`).
- **Constraints.** `@Index` and `@Unique` on the class or on properties.

Decorators are read statically; nothing is executed, and `EntitySchema` definitions are not supported.

## Writing

The emitter returns a single TypeScript text (`entities.ts`) with one `import { ... } from 'typeorm'` line, `export enum` declarations for enums, and one exported class per model.

- Properties use definite assignment (`id!: number`). Relation properties are typed `Relation<Target>` (and `| null` when optional).
- `@Entity('blog_post')` keeps the table name; class-level `@Index` and `@Unique` carry indexes and unique constraints, with names where the source had one (`@Index('post_pub_status_idx', [...])`).
- `decimal` and `bigint` columns are typed `string`; JSON columns are `unknown`. Auto-updated and created timestamps become `@UpdateDateColumn` / `@CreateDateColumn`.
- A many-to-many field becomes `@ManyToMany` plus `@JoinTable({ name, joinColumn, inverseJoinColumn })` so the join table matches the one Django creates. A Prisma view is written as `@ViewEntity` with a placeholder `expression` and a warning.

| Option                        | Effect                                                                                                                                                                                                       |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `--provider`                  | Chooses column types. `postgresql` (default) writes `timestamptz` and `jsonb`; `mysql` writes `datetime`; `sqlite` writes `simple-enum` for enums. SQL Server has no enum column, so enums become `varchar`. |
| `--naming preserve` (default) | Keeps property and table names.                                                                                                                                                                              |
| `--naming normalize`          | Singular snake_case tables, UUID primary keys (`@PrimaryGeneratedColumn('uuid')`), camelCase properties mapped back with `name: 'created_at'`, and `created_at` / `updated_at` added where missing.          |

Other writer flags (`--namespace`, `--no-header`, `--prisma-version`, ...) do not affect TypeORM output.

## Limitations and warnings

Warnings appear on stderr as `warning: <Entity>.<column>: ...`. Real examples:

- `A.tags: array columns have no equivalent in the shared model and were converted to json.`
- `A.n: unsigned integers (option "unsigned") has no equivalent and was ignored.`
- `Post.tags: custom @JoinTable settings (name, joinColumn, inverseJoinColumn) are not preserved; the join table name and columns are derived from the models.` This also fires on ormbridge's own output and is harmless there.
- Not supported, each with a warning: `@ChildEntity` / `@TableInheritance`, `@Tree*`, `@Check` / `@Exclusion`, `@ObjectIdColumn`, `@VirtualColumn`, composite foreign keys (several `@JoinColumn` entries), relations inside embedded entities, partial and spatial indexes, and column options such as `collation` and `transformer`.
- Writer: `SQLite has no database-side UUID default; the default was dropped.`, `mysql has no interval type; the duration was written as bigint (microseconds).`, `onDelete SET NULL on a required relation will fail at the database level; review the relation.`, and the Prisma-only construct warnings (views, `Unsupported(...)`, `@@fulltext`, composite foreign keys).
- A relation without `onDelete` is read as `NoAction`. MongoDB entities are not supported.

See the [conversion matrix](../CONVERSION_MATRIX.md): [typeorm to prisma](../CONVERSION_MATRIX.md#typeorm--prisma), [typeorm to django](../CONVERSION_MATRIX.md#typeorm--django), [typeorm to doctrine](../CONVERSION_MATRIX.md#typeorm--doctrine), [prisma to typeorm](../CONVERSION_MATRIX.md#prisma--typeorm), and [why information is lost](../CONVERSION_MATRIX.md#why-information-is-lost). The [known issues](../CONVERSION_MATRIX.md#known-issues) section explains the `@JoinTable` warning.

## Programmatic API

```ts
import {
  convertText,
  parseTypeorm,
  emitTypeorm,
  type ConvertResult,
  type EmitOutput,
  type IrSchema,
  type Result,
} from 'ormbridge';

declare const prismaText: string;
declare const entitiesTs: string;

// Prisma -> TypeORM, in memory.
const converted: Result<ConvertResult> = await convertText(
  [{ path: 'schema.prisma', text: prismaText }],
  {
    from: 'prisma',
    to: 'typeorm',
    naming: 'preserve',
    provider: 'mysql',
    header: true,
    autoField: 'int',
  }
);
if (converted.ok) {
  console.log(converted.value.output); // entities.ts text
} else {
  console.error(`${converted.error.code}: ${converted.error.message}`);
}

// Lower level.
const parsed: Result<IrSchema> = await parseTypeorm(
  [{ path: 'src/entities.ts', text: entitiesTs }],
  { appLabel: 'app' }
);
if (parsed.ok) {
  const emitted: EmitOutput = emitTypeorm(parsed.value, {
    provider: 'postgresql',
    camelFields: false,
  });
  console.log(emitted.text, emitted.warnings);
}
```

`emitTypeorm` returns `{ text, warnings }` directly; `convertText` applies `--naming` first.
