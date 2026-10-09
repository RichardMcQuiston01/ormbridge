import { fileURLToPath } from 'node:url';
import type { IrField, IrModel, IrSchema } from '../src/ir.js';
import type { EmitOnlyCell, MatrixCell } from './conversionMatrix.js';
import { formatDifference, type IrDifference } from './irCompare.js';

/** Where the generated document is committed. */
export const MATRIX_DOC_PATH: string = fileURLToPath(
  new URL('../docs/CONVERSION_MATRIX.md', import.meta.url)
);

/**
 * Reasons a conversion loses information. Every difference the matrix finds
 * must be explained by one of these; the matrix test fails otherwise, so a new
 * loss cannot slip in without being documented.
 */
export interface LossReason {
  id: string;
  title: string;
  explanation: string;
}

export const LOSS_REASONS: readonly LossReason[] = [
  {
    id: 'enum-length',
    title: 'Enum column length',
    explanation:
      'Django stores an enum-backed field as `CharField(max_length=N, choices=...)`, so the IR keeps `N`. A Prisma `enum` and a TypeORM `enum` column have no length, so it is dropped when writing them. Writing the enum back to Django invents a new length (the longest member value, but at least 32: `src/emitters/django.ts`), which is why the original 20 does not return.',
  },
  {
    id: 'enum-label',
    title: 'Enum member labels',
    explanation:
      'Django `TextChoices` members carry a human-readable label (`DRAFT = "draft", "Draft"`). Prisma enum members and TypeORM string-enum members have no label, so it is dropped. Django output derives a label from the member name, so the label may look the same but was not preserved.',
  },
  {
    id: 'join-table',
    title: 'Many-to-many becomes an explicit join model in Prisma',
    explanation:
      "In `preserve` naming mode the Prisma writer expands every many-to-many field with `expandManyToMany` (`src/transforms.ts`) into an explicit join model (`PostTags`) with a surrogate `id`, two cascading foreign keys and a unique pair. This mirrors the table Django creates, so existing Django databases stay compatible, and it avoids Prisma's implicit `_AToB` table. Prisma reads that model back as an ordinary model, so the relation `Post.tags` is not restored as a many-to-many. For TypeORM and GORM sources the join table is the ORM's own, whose primary key is the composite of the two foreign keys, so the Prisma join model also gains a surrogate `id` column that the source table does not have.",
  },
  {
    id: 'php-empty-array-default',
    title: 'Empty JSON defaults come back as a PHP array',
    explanation:
      'The Doctrine writer sets a JSON or array default as a property initializer (`private array $metadata = [];`). PHP has a single empty array literal, so an empty JSON object default (`{}`, Django `default=dict`) and an empty JSON list default (`[]`) both become `[]`, and the Doctrine reader returns `[]`.',
  },
  {
    id: 'gorm-empty-string-default',
    title: 'GORM cannot keep an empty string default',
    explanation:
      "The GORM writer puts a string default into the tag unquoted (`default:abc`), so an empty string default becomes a bare `default:`. GORM and the GORM reader treat that as no default, so a Doctrine property initializer such as `private string $body = '';` is lost on the way through GORM.",
  },
  {
    id: 'gorm-reverse-name',
    title: 'GORM names reverse relations in Go',
    explanation:
      'GORM has no related name: the reverse side of a relation is a field on the other struct, named after the plural of the model (`Posts`). A Django `related_name` or an ORM-specific default such as `postset` is therefore replaced by the GORM field name, and the GORM reader recovers that name rather than the original.',
  },
  {
    id: 'gorm-auto-timestamps',
    title: 'GORM refreshes `updated_at` columns itself',
    explanation:
      'A column named `updated_at` (or `UpdatedAt`) is maintained by GORM through `autoUpdateTime`, which the GORM writer adds and the reader reports as "updated automatically". A source format that cannot express the flag therefore gains it after a pass through GORM.',
  },
  {
    id: 'drizzle-join-tables',
    title: 'Many-to-many becomes an explicit join table in Drizzle',
    explanation:
      'Drizzle has no many-to-many field: a join table is an ordinary table with two foreign keys, and `relations()` describes each side of the pair. The Drizzle writer therefore writes an explicit join table (`PostTag`, named after the two models in the singular) in both naming modes, and the Drizzle reader reads it back as an ordinary model, the way the Prisma reader does, so the relation `Post.tags` is not restored as a many-to-many. A Prisma source that already has an explicit join model under another name (`PostTags`) is replaced by the one the writer derives.',
  },
  {
    id: 'drizzle-reverse-name',
    title: 'Drizzle names reverse relations in `relations()`',
    explanation:
      'Drizzle has no related name: each side of a relation is a key in `relations()`, named after the plural of the model (`posts`). A Django `related_name` or an ORM-specific default such as `postset` is therefore replaced by the Drizzle key, and the Drizzle reader recovers that name rather than the original.',
  },
  {
    id: 'django-enum-length-floor',
    title: 'Django enum columns are at least 32 characters',
    explanation:
      'The Django writer ignores the stored length of an enum-backed field and writes `max_length` as the longer of 32 and the longest enum value (`src/emitters/django.ts`). A length kept by another format (for example 20 in a Doctrine `length: 20` column) therefore becomes 32 once the schema passes through Django, which is why a second trip through Django is not stable for that field.',
  },
  {
    id: 'laravel-big-integer-keys',
    title: 'Laravel keys are big integers',
    explanation:
      'The Laravel writer spells an auto-increment key as `$table->id()`, which is an unsigned big integer, and writes the foreign keys that point at it as `foreignId()`. An `int` key therefore comes back as `bigInt` when the migrations are read again. Reading Laravel migrations written with `increments()` (the canonical Laravel fixture does) keeps `int`, so this only appears when the schema passes through the Laravel writer.',
  },
  {
    id: 'laravel-timestamps',
    title: 'Laravel timestamps are nullable and maintained by Eloquent',
    explanation:
      'The Laravel writer uses `$table->timestamps()` for `created_at` / `updated_at`, which creates nullable columns without a database default, because Eloquent fills them in. The Laravel reader reports them as nullable, treats `updated_at` of a model with `$timestamps` as auto-updated and `created_at` as defaulting to now. A source that has these columns as required, with a different default or without the auto-update flag (Doctrine keeps the default and sets the value in a lifecycle callback), therefore changes when it passes through Laravel; TypeORM only treats a column as `@UpdateDateColumn` while it is required, so the flag is lost on the way back from there.',
  },
  {
    id: 'laravel-reverse-name',
    title: 'Laravel names unnamed reverse relations in the plural',
    explanation:
      'A Django foreign key without `related_name` has the implicit reverse accessor `<model>_set`, which the IR records as no name. The Laravel writer needs a method name for the `hasMany` side and uses the plural of the model (`posts`), which the Laravel reader then reports as an explicit reverse name.',
  },
];

/**
 * What a write-only target cannot keep or has to approximate. They are listed
 * in the matrix document next to the structural check, because the matrix
 * cannot re-read the output to measure them. Keyed by format name.
 */
export const EMIT_ONLY_NOTES: Readonly<Record<string, readonly LossReason[]>> =
  {
    'json-schema': [
      {
        id: 'json-schema-no-constraints',
        title: 'Database constraints are not validation rules',
        explanation:
          'Unique, primary-key, index and foreign-key constraints, referential actions and table names have no JSON Schema keyword and are not written; the document only describes the shape of one row. Column comments do not exist in the IR, so `description` carries only enum labels and generated-column expressions.',
      },
      {
        id: 'json-schema-types',
        title: 'Types follow what travels as JSON',
        explanation:
          '`bigInt` and `decimal` are strings (with a `pattern`, narrowed by the precision when the IR has `maxDigits` and `decimalPlaces`) so no precision is lost, binary columns are base64 strings, `json` accepts any value, and integers carry `minimum` / `maximum` only when a Prisma native type such as `@db.SmallInt` names the width. IP addresses and ranges have no JSON Schema format and are plain strings and `{ lower, upper, bounds }` objects.',
      },
      {
        id: 'json-schema-required',
        title: 'Required and read-only are inferred',
        explanation:
          'A property is `required` when its column is not nullable and has no default and is not generated. Auto-increment, UUID, `now`, client-generated and database-expression defaults, auto-updated columns and generated columns are `readOnly`. Relations and reverse relations are optional properties; the foreign-key scalar is required when the relation is.',
      },
      {
        id: 'json-schema-enums',
        title: 'Enums are string enumerations',
        explanation:
          'An enum is `{ "type": "string", "enum": [...] }` with the stored values; member names and Django labels survive only as the `description` text, because the `enum` keyword has no place for them.',
      },
    ],
    gorm: [
      {
        id: 'gorm-integers',
        title: 'Integer widths and signs',
        explanation:
          '`int` is written as `int32` and `bigInt` as `int64`, both signed. The IR has no unsigned or 16-bit integers (Django positive integer fields become plain `int`). A model that has exactly the `gorm.Model` columns embeds `gorm.Model`, whose `ID` is an unsigned `uint`.',
      },
      {
        id: 'gorm-defaults',
        title: 'Where defaults live',
        explanation:
          'A `now` default on a date-time column becomes `autoCreateTime` (GORM fills it in Go, so a raw SQL insert gets no default) and an auto-updated column becomes `autoUpdateTime`. UUID defaults are `default:gen_random_uuid()` on PostgreSQL and a generated `BeforeCreate` hook on every other provider; client-generated defaults (`cuid()`, `ulid()`) are dropped with a warning. Literal and enum defaults are written as `default:` tags.',
      },
      {
        id: 'gorm-join-tables',
        title: 'Many-to-many join tables',
        explanation:
          'GORM creates the join table itself, with a composite primary key of the two foreign keys and no surrogate `id`. The table and column names are written explicitly (`many2many:`, `joinForeignKey`, `joinReferences`) when they differ from what GORM would pick, so the table matches the one other formats create. An explicit join model (Prisma) stays an ordinary model.',
      },
      {
        id: 'gorm-soft-delete',
        title: 'Soft delete is inferred from a column name',
        explanation:
          'The IR has no soft-delete flag. A nullable date-time column named `deleted_at` is written as `gorm.DeletedAt`, which also changes how GORM queries the model (rows with a value are hidden), so the writer warns.',
      },
      {
        id: 'gorm-enums',
        title: 'Enums are Go constants',
        explanation:
          'An enum is a typed string with a `const` block, stored as text. GORM has no database enum type and no check constraint is written, so the database does not enforce the values. Member labels are kept as comments.',
      },
      {
        id: 'gorm-unrepresentable',
        title: 'Constructs without a GORM tag',
        explanation:
          'Arrays and hstore become JSON columns (`datatypes.JSONSlice`, `datatypes.JSON`), durations become `time.Duration` (nanoseconds in a bigint), ranges become strings, generated columns become regular columns, and composite foreign keys, index types and operator classes, full-text indexes, views and `@@schema` are written as plain tables and columns, each with a warning. The IR has no check constraints, column comments or polymorphic relations, so none are written.',
      },
      {
        id: 'gorm-inverse-names',
        title: 'Reverse relations get Go names',
        explanation:
          'An unnamed reverse relation is named after the plural of the model (`Posts`), and a one-to-one after the model (`Profile`). Has-one and belongs-to fields are pointers unless a required parent can be held by value without making the struct type recursive.',
      },
    ],
    drizzle: [
      {
        id: 'drizzle-dialects',
        title: 'One dialect per output',
        explanation:
          "`--provider` picks `pg-core` (PostgreSQL, CockroachDB), `mysql-core` or `sqlite-core`. Drizzle has no SQL Server or MongoDB dialect, so those providers are written as PostgreSQL tables with a warning. The column builders follow the dialect: `timestamp({ withTimezone: true })` and `jsonb` on PostgreSQL, `datetime` and `json` on MySQL, and on SQLite `integer({ mode: 'timestamp' })`, `integer({ mode: 'boolean' })` and `text({ mode: 'json' })`.",
      },
      {
        id: 'drizzle-keys',
        title: 'Auto-increment keys and integer widths',
        explanation:
          'An auto-increment `int` key is `serial` (PostgreSQL), `int().autoincrement()` (MySQL) or `integer().primaryKey({ autoIncrement: true })` (SQLite); `bigInt` is `bigserial` or `bigint` in `number` mode, which loses precision above 2^53. SQLite integers are always 64 bits wide. A UUID key is `uuid().defaultRandom()`, `char(36)` with a `(UUID())` default or text.',
      },
      {
        id: 'drizzle-defaults',
        title: 'Where defaults live',
        explanation:
          'A `now` default is `.defaultNow()` (PostgreSQL), `CURRENT_TIMESTAMP` (MySQL) or `(unixepoch())` (SQLite), all evaluated by the database. Drizzle has no database default for a UUID on SQLite, so the writer uses `$defaultFn(() => crypto.randomUUID())`, which only runs for rows inserted through Drizzle, and warns. An auto-updated column gets `$onUpdate(() => new Date())`, which Drizzle applies in the client, not with a database trigger. Client-generated defaults (`cuid()`, `ulid()`) and database expressions are dropped with a warning.',
      },
      {
        id: 'drizzle-join-tables',
        title: 'Many-to-many join tables are explicit tables',
        explanation:
          'Drizzle has no many-to-many field. The writer expands every many-to-many relation into the join table Django creates (a surrogate `id`, two cascading foreign keys and a unique pair), in `preserve` and `normalize` naming alike, and both tables get a `many()` relation to it. The relation is therefore a one-to-many pair, not a many-to-many, when read back.',
      },
      {
        id: 'drizzle-enums',
        title: 'Enums by dialect',
        explanation:
          'PostgreSQL gets a `pgEnum` (a real database type). MySQL gets an inline `mysqlEnum` column. SQLite has no enum type, so the column is `text` with `{ enum: [...] }`, which narrows the TypeScript type but adds no check constraint. Every enum also exports its values as an `as const` array and a union type.',
      },
      {
        id: 'drizzle-unrepresentable',
        title: 'Constructs without a Drizzle builder',
        explanation:
          'Arrays, hstore and ranges outside PostgreSQL become JSON, text or varchar columns and durations become integers (microseconds), each with a warning. PostgreSQL columns without a builder (`bytea`, `hstore`, ranges) use small `customType` declarations at the top of the file. Generated columns (Python expressions), composite foreign keys, index types, sort orders and operator classes, full-text indexes, views and `@@schema` are written as plain tables and columns with a warning. Unique indexes are `uniqueIndex`, not unique constraints.',
      },
      {
        id: 'drizzle-relations',
        title: 'Both sides of every relation',
        explanation:
          'Every foreign key gets a `one()` relation on its table and the matching `many()` (or `one()` for a one-to-one) on the target. Two tables joined more than once, and self references, carry a `relationName` on both sides because Drizzle cannot pair them otherwise. An unnamed reverse relation is named after the plural of the model (`posts`). Tables are ordered so a table follows the tables it references; a reference to a table declared later (a cycle or a self reference) is annotated with `AnyPgColumn` (`AnyMySqlColumn`, `AnySQLiteColumn`).',
      },
    ],
    zod: [
      {
        id: 'zod-wire-types',
        title: 'Types that JSON cannot carry',
        explanation:
          'Big integers and decimals are validated as strings of digits (a decimal with `max_digits` and `decimal_places` gets a pattern sized to them), UUIDs with `z.uuid()` (which only accepts RFC 9562 versions and variants), binary data as base64 text, durations and times as plain strings, and JSON columns as `z.unknown()`. Date columns use `z.coerce.date()`, which also accepts `null` and numbers, so a null in a required date column is not rejected; the `dates: "string"` option validates ISO text strictly instead.',
      },
      {
        id: 'zod-create-update',
        title: 'Create and update schemas are inferred',
        explanation:
          'The IR has no notion of an API payload. `<Model>CreateSchema` leaves out auto-increment keys, generated columns and auto-updated timestamps, and makes columns with a default (or a database default) and nullable columns optional. `<Model>UpdateSchema` is the create schema made partial, so it cannot change a generated column. Views get neither.',
      },
      {
        id: 'zod-relations',
        title: 'Relations are a separate schema',
        explanation:
          'Relation fields are not part of `<Model>Schema`; the foreign-key scalar is. A model that takes part in a relation also gets `<Model>WithRelationsSchema`, where every related row is optional and resolved lazily. Referential actions (`onDelete`), `related_name` collisions and composite foreign keys are not validation rules, so they are dropped (a composite key stays as its scalar columns).',
      },
      {
        id: 'zod-database-rules',
        title: 'Database-only rules are not checked',
        explanation:
          'Unique constraints, indexes, check constraints, string lengths below the database limit, integer ranges, enum value order and column names are not validated or kept; only string `max_length`, enum membership, nullability and the types above are. Enum labels are kept as comments. Ranges become an object with `lower`, `upper` and `bounds`, and hstore a record of nullable strings.',
      },
    ],
  };

/** True when either end of the pair is the given format. */
function involves(cell: MatrixCell, format: string): boolean {
  return cell.source === format || cell.target === format;
}

/** The column names Eloquent maintains itself. */
const LARAVEL_TIMESTAMP_COLUMNS: ReadonlySet<string> = new Set([
  'created_at',
  'updated_at',
]);

/** Differences that come from how the Laravel writer and reader treat keys, timestamps and reverse names. */
function explainLaravelDifference(
  difference: IrDifference,
  cell: MatrixCell
): string | undefined {
  const field: string = difference.field ?? '';
  switch (difference.kind) {
    case 'fieldType': {
      const model: IrModel | undefined = cell.sourceSchema.models.find(
        (candidate: IrModel) => candidate.name === difference.model
      );
      const source: IrField | undefined = model?.fields.find(
        (candidate: IrField) => candidate.columnName === field
      );
      // A join model synthesized for Prisma is not in the source schema; its key is called id.
      return (source?.isPrimaryKey === true || field === 'id') &&
        difference.before === 'int' &&
        difference.after === 'bigInt'
        ? 'laravel-big-integer-keys'
        : undefined;
    }
    case 'fieldNullability':
      return LARAVEL_TIMESTAMP_COLUMNS.has(field) &&
        difference.before === 'required' &&
        difference.after === 'nullable'
        ? 'laravel-timestamps'
        : undefined;
    case 'fieldDefault':
      return field === 'updated_at' && difference.after === '(none)'
        ? 'laravel-timestamps'
        : undefined;
    case 'fieldAutoUpdated':
      return field === 'updated_at' ? 'laravel-timestamps' : undefined;
    case 'relationRelatedName':
      return cell.target === 'laravel' ? 'laravel-reverse-name' : undefined;
    default:
      return undefined;
  }
}

/** Returns the id of the reason that explains a difference, or undefined when it is unexplained. */
export function explainDifference(
  difference: IrDifference,
  cell: MatrixCell
): string | undefined {
  const schema: IrSchema = cell.sourceSchema;
  if (involves(cell, 'laravel')) {
    const laravelReason: string | undefined = explainLaravelDifference(
      difference,
      cell
    );
    if (laravelReason !== undefined) {
      return laravelReason;
    }
  }
  switch (difference.kind) {
    case 'fieldMaxLength': {
      const model: IrModel | undefined = schema.models.find(
        (candidate: IrModel) => candidate.name === difference.model
      );
      const field: IrField | undefined = model?.fields.find(
        (candidate: IrField) => candidate.columnName === difference.field
      );
      if (field?.enumName === undefined) {
        return undefined;
      }
      if (difference.after === '(none)') {
        return 'enum-length';
      }
      return Number(difference.after) === 32 && Number(difference.before) < 32
        ? 'django-enum-length-floor'
        : undefined;
    }
    case 'fieldAutoUpdated':
      if (
        involves(cell, 'gorm') &&
        difference.field === 'updated_at' &&
        difference.before === 'false' &&
        difference.after === 'true'
      ) {
        return 'gorm-auto-timestamps';
      }
      return undefined;
    case 'relationRelatedName':
      if (involves(cell, 'drizzle')) {
        return 'drizzle-reverse-name';
      }
      return involves(cell, 'gorm') ? 'gorm-reverse-name' : undefined;
    case 'fieldDefault':
      if (
        cell.target === 'gorm' &&
        difference.before === 'literal ""' &&
        difference.after === '(none)'
      ) {
        return 'gorm-empty-string-default';
      }
      return involves(cell, 'doctrine') &&
        difference.before === 'literal "{}"' &&
        difference.after === 'literal "[]"'
        ? 'php-empty-array-default'
        : undefined;
    case 'enumValueLabel':
      return difference.after === '(none)' ? 'enum-label' : undefined;
    case 'relationRemoved':
      if (
        cell.target === 'drizzle' &&
        difference.before.startsWith('manyToMany')
      ) {
        return 'drizzle-join-tables';
      }
      return cell.target === 'prisma' &&
        difference.before.startsWith('manyToMany')
        ? 'join-table'
        : undefined;
    case 'modelRemoved':
      // The explicit join model of a Prisma source (`PostTags`) is replaced by the one Drizzle derives.
      return cell.target === 'drizzle' && cell.source === 'prisma'
        ? 'drizzle-join-tables'
        : undefined;
    case 'modelAdded':
      if (
        cell.target === 'drizzle' &&
        cell.differences.some(
          (other: IrDifference) =>
            (other.kind === 'relationRemoved' &&
              other.before.startsWith('manyToMany')) ||
            other.kind === 'modelRemoved'
        )
      ) {
        return 'drizzle-join-tables';
      }
      return cell.target === 'prisma' &&
        cell.differences.some(
          (other: IrDifference) =>
            other.kind === 'relationRemoved' &&
            other.before.startsWith('manyToMany')
        )
        ? 'join-table'
        : undefined;
    default:
      return undefined;
  }
}

/** Differences that no documented reason explains. */
export function unexplainedDifferences(cell: MatrixCell): IrDifference[] {
  return cell.differences.filter(
    (difference: IrDifference) =>
      explainDifference(difference, cell) === undefined
  );
}

/** Second-trip differences that no documented reason explains. */
export function unexplainedIdempotenceDifferences(
  cell: MatrixCell
): IrDifference[] {
  return cell.idempotenceDifferences.filter(
    (difference: IrDifference) =>
      explainDifference(difference, cell) === undefined
  );
}

function pairLabel(cell: MatrixCell): string {
  return `${cell.source} → ${cell.target}`;
}

function summaryCell(cell: MatrixCell | undefined): string {
  if (cell === undefined) {
    return '—';
  }
  const count: number = cell.differences.length;
  return count === 0
    ? '✔ lossless'
    : `⚠ ${count} difference${count === 1 ? '' : 's'}`;
}

function summaryMatrix(
  cells: MatrixCell[],
  sources: string[],
  targets: string[]
): string[] {
  const lines: string[] = [
    `| from \\ to | ${targets.join(' | ')} |`,
    `| --- | ${targets.map(() => '---').join(' | ')} |`,
  ];
  for (const source of sources) {
    const row: string[] = targets.map((target: string) =>
      summaryCell(
        cells.find(
          (cell: MatrixCell) => cell.source === source && cell.target === target
        )
      )
    );
    lines.push(`| **${source}** | ${row.join(' | ')} |`);
  }
  return lines;
}

function pairTable(cells: MatrixCell[]): string[] {
  const lines: string[] = [
    '| Pair | Result | Emit warnings | Re-read warnings | Stable after a second trip |',
    '| --- | --- | --- | --- | --- |',
  ];
  for (const cell of cells) {
    lines.push(
      `| ${pairLabel(cell)} | ${summaryCell(cell)} | ${cell.emitWarnings.length} | ${cell.reparseWarnings.length} | ${cell.readOnlySource === true ? 'n/a (read only)' : cell.idempotenceDifferences.length === 0 ? 'yes' : 'no'} |`
    );
  }
  return lines;
}

function pairDetails(
  cell: MatrixCell,
  reasonNumbers: Map<string, number>
): string[] {
  const lines: string[] = [`### ${pairLabel(cell)}`, ''];
  if (cell.differences.length === 0) {
    lines.push('Lossless for the canonical schema.');
  } else {
    lines.push('Differences found:', '');
    for (const difference of cell.differences) {
      const reason: string | undefined = explainDifference(difference, cell);
      const number: number | undefined =
        reason === undefined ? undefined : reasonNumbers.get(reason);
      lines.push(
        `- \`${formatDifference(difference)}\`${number === undefined ? ' (unexplained)' : ` — see reason ${number}`}`
      );
    }
  }
  lines.push('');
  if (cell.emitWarnings.length === 0) {
    lines.push('Emit warnings: none.');
  } else {
    lines.push('Emit warnings:', '');
    for (const warning of cell.emitWarnings) {
      lines.push(`- ${warning}`);
    }
  }
  lines.push('');
  if (cell.reparseWarnings.length === 0) {
    lines.push('Warnings when the output is read back: none.');
  } else {
    lines.push('Warnings when the output is read back:', '');
    for (const warning of cell.reparseWarnings) {
      lines.push(`- ${warning}`);
    }
  }
  if (cell.readOnlySource === true) {
    lines.push(
      '',
      `Second trip not checked: ${cell.source} can only be read, so ${cell.target} → ${cell.source} → ${cell.target} cannot be run.`,
      ''
    );
    return lines;
  }
  const unexplainedSecondTrip: IrDifference[] =
    unexplainedIdempotenceDifferences(cell);
  lines.push(
    '',
    cell.idempotenceDifferences.length === 0
      ? `Stable: converting ${cell.target} → ${cell.source} → ${cell.target} again changes nothing further.`
      : unexplainedSecondTrip.length === 0
        ? `Not stable, but only for documented reasons: a second ${cell.target} → ${cell.source} → ${cell.target} trip changes:`
        : `Not stable: a second ${cell.target} → ${cell.source} → ${cell.target} trip changes:`
  );
  for (const difference of cell.idempotenceDifferences) {
    const reason: string | undefined = explainDifference(difference, cell);
    const number: number | undefined =
      reason === undefined ? undefined : reasonNumbers.get(reason);
    lines.push(
      `- \`${formatDifference(difference)}\`${number === undefined ? ' (unexplained)' : ` — see reason ${number}`}`
    );
  }
  lines.push('');
  return lines;
}

function emitOnlySection(cells: EmitOnlyCell[]): string[] {
  const targets: string[] = [];
  for (const cell of cells) {
    if (!targets.includes(cell.target)) {
      targets.push(cell.target);
    }
  }
  const lines: string[] = [
    '## Write-only targets',
    '',
    `Some formats can be written but not read (${targets.join(', ')}), so the matrix cannot re-read their output and compare IRs. For these it checks the written files against the IR instead: every model has a declaration for its table (a struct, a table builder call), every column has a field or builder, every many-to-many relation has its join table and every enum has its type or value list. JSON Schema: every model and enum has a \`$defs\` entry and every column and relation has a property. "Missing" lists what the check could not find; it is empty when the output covers the schema. What the format approximates or cannot express is listed below the table.`,
    '',
    '| Pair | Files | Emit warnings | Missing |',
    '| --- | --- | --- | --- |',
  ];
  for (const cell of cells) {
    lines.push(
      `| ${cell.source} → ${cell.target} | ${cell.files.length} | ${cell.emitWarnings.length} | ${cell.missing.length === 0 ? 'none' : cell.missing.length} |`
    );
  }
  lines.push('');
  for (const cell of cells) {
    lines.push(`### ${cell.source} → ${cell.target}`, '');
    lines.push(
      cell.missing.length === 0
        ? 'The output covers the canonical schema.'
        : `Missing from the output: ${cell.missing.join('; ')}.`
    );
    lines.push('');
    if (cell.emitWarnings.length === 0) {
      lines.push('Emit warnings: none.');
    } else {
      lines.push('Emit warnings:', '');
      for (const warning of cell.emitWarnings) {
        lines.push(`- ${warning}`);
      }
    }
    lines.push('');
  }
  for (const target of targets) {
    const notes: readonly LossReason[] = EMIT_ONLY_NOTES[target] ?? [];
    if (notes.length === 0) {
      continue;
    }
    lines.push(`### What ${target} approximates`, '');
    notes.forEach((note: LossReason, position: number): void => {
      lines.push(`${position + 1}. **${note.title}.** ${note.explanation}`);
    });
    lines.push('');
  }
  return lines;
}

/** Renders the committed conversion matrix document. */
export function renderMatrixMarkdown(
  cells: MatrixCell[],
  emitOnly: EmitOnlyCell[] = []
): string {
  const formats: string[] = [];
  for (const cell of cells) {
    for (const name of [cell.source, cell.target]) {
      if (!formats.includes(name)) {
        formats.push(name);
      }
    }
  }
  // Formats that only appear as the source of read-only cells cannot be written.
  const readOnly: string[] = formats.filter((name: string) =>
    cells
      .filter(
        (cell: MatrixCell) => cell.source === name || cell.target === name
      )
      .every(
        (cell: MatrixCell) =>
          cell.readOnlySource === true && cell.source === name
      )
  );
  const readWrite: string[] = formats.filter(
    (name: string) => !readOnly.includes(name)
  );
  const usedReasons: LossReason[] = LOSS_REASONS.filter((reason: LossReason) =>
    cells.some((cell: MatrixCell) =>
      [...cell.differences, ...cell.idempotenceDifferences].some(
        (difference: IrDifference) =>
          explainDifference(difference, cell) === reason.id
      )
    )
  );
  const reasonNumbers: Map<string, number> = new Map<string, number>(
    usedReasons.map((reason: LossReason, index: number) => [
      reason.id,
      index + 1,
    ])
  );

  const lines: string[] = [
    '# Conversion matrix',
    '',
    '<!-- Generated by `npm run docs:matrix` (scripts/generate-conversion-matrix.ts). Do not edit by hand: the tests fail when this file is stale. -->',
    '',
    `This page shows what survives a round trip between the formats ormbridge can both read and write (${readWrite.join(', ')})${readOnly.length === 0 ? '' : `, and what survives when a format that can only be read (${readOnly.join(', ')}) is written to each of them`}. It is generated from the canonical "blog" schema in \`test/fixtures/\`, so it describes the constructs that schema uses; the README's "Limitations and warnings" section lists constructs it does not cover.`,
    '',
    '## How a cell is computed',
    '',
    'For each ordered pair (A, B) the test suite',
    '',
    '1. reads the canonical fixture of A into the intermediate representation (IR),',
    '2. writes B (default `preserve` naming, PostgreSQL provider),',
    '3. reads the written B text back into the IR, and',
    '4. compares the two IRs with `test/irCompare.ts`.',
    '',
    "Each format is read from its own canonical fixture, and the fixtures spell the same blog schema in their native styles (for example the Prisma fixture writes the post/tag join table as an explicit `PostTags` model while Django and TypeORM declare a many-to-many field). A cell therefore compares a source with its own fixture, not with the other formats' fixtures.",
    '',
    "The comparison covers models, table names, fields, types, nullability, defaults, lengths and precision, primary and composite keys, relations (kind, target, nullability, `onDelete`, reverse accessor), enums, indexes and uniques. It ignores differences that mean nothing: ordering, case and underscore spelling of identifiers (`created_at` vs `createdAt`, `DRAFT` vs `Draft`), the Django app label, index and constraint names the target generated itself (an explicit name that is lost is reported), Django's implicit reverse accessor names (`post_set`), the nullability of many-to-many relations (they have no column), and values a target must invent (Django enum labels and the `max_length` Django requires on enum columns).",
    '',
    ...(readOnly.length === 0
      ? []
      : [
          `A format that can only be read (${readOnly.join(', ')}) has no writer yet, so its cells stop after step 4: the schema is read from its fixture, written to the target and read back, but it cannot be written back to the source for a second trip. These rows join the full matrix, with a second trip, once the format gains a writer.`,
          '',
        ]),
    'Text goldens in `test/golden/` pin the exact output and the `roundtrip-*.drift.txt` files pin the textual drift; this page is the semantic view of the same conversions.',
    '',
    '## Summary',
    '',
    'Rows are the source format, columns the target. ✔ means the canonical schema comes back unchanged; ⚠ gives the number of structural differences.',
    '',
    ...summaryMatrix(cells, formats, readWrite),
    '',
    ...pairTable(cells),
    '',
  ];

  if (usedReasons.length > 0) {
    lines.push('## Why information is lost', '');
    for (const reason of usedReasons) {
      lines.push(
        `${reasonNumbers.get(reason.id)}. **${reason.title}.** ${reason.explanation}`
      );
    }
    lines.push('');
  }

  lines.push('## Details per pair', '');
  for (const cell of cells) {
    lines.push(...pairDetails(cell, reasonNumbers));
  }

  if (emitOnly.length > 0) {
    lines.push(...emitOnlySection(emitOnly));
  }

  lines.push(
    '## Known issues',
    '',
    '- Writing a many-to-many to TypeORM emits `@JoinTable({ name, joinColumn, inverseJoinColumn })` so the join table matches the one Django creates. The TypeORM reader then warns that "custom @JoinTable settings (name, joinColumn, inverseJoinColumn) are not preserved" for ormbridge\'s own output. The names it would have read are the same ones it derives, so nothing is lost, but the warning is noise for generated code.',
    '- The matrix only covers the canonical schema. Constructs outside it (composite primary keys, one-to-one primary keys, scalar lists, custom join tables and so on) are not exercised here; see the README for how they convert.',
    ''
  );
  return lines.join('\n');
}

/** Rendering of one cell's differences, used in test failure messages. */
export function describeDifferences(differences: IrDifference[]): string {
  return differences.map(formatDifference).join('\n');
}
