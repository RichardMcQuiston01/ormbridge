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
  };

/**
 * What a format that can only be read cannot express, or has to guess, when it is read. The matrix
 * compares IRs, so these losses (which happen before the IR exists) never show up as differences;
 * they are listed in the matrix document next to the read-only rows instead. Keyed by format name.
 */
export const READ_ONLY_NOTES: Readonly<Record<string, readonly LossReason[]>> =
  {
    'json-schema': [
      {
        id: 'json-schema-annotations',
        title: 'Descriptions and validation keywords',
        explanation:
          'The IR has no comment slot, so `description`, `title` and `examples` are dropped. Validation keywords with no column meaning (`minimum`, `maximum`, `minLength`, `pattern`, `minItems`, `uniqueItems`, `writeOnly`, `deprecated`, `format` values such as `email` or `uri`) are not stored either; only `maxLength` becomes a column length.',
      },
      {
        id: 'json-schema-no-database-meaning',
        title: 'Constructs without a database meaning',
        explanation:
          '`oneOf` / `anyOf` unions (other than "a schema or null" and a list of constants, which are read as a nullable property and an enum), `patternProperties`, maps (`additionalProperties` with a schema), `if` / `then` / `else`, tuple arrays and a union of `type`s are reported as warnings. A property that uses one becomes a `json` column; a model-level one is ignored. A nested inline object is also a `json` column, and a `oneOf` of models is not a model.',
      },
      {
        id: 'json-schema-inheritance',
        title: 'Inheritance is flattened',
        explanation:
          'A model built with `allOf` (or a `$ref` next to `properties`) gets copies of the properties of every parent, with a warning. The IR has no inheritance, so the parent link is lost; the parent stays a model of its own when it is an object schema with properties.',
      },
      {
        id: 'json-schema-relations',
        title: 'Relations are inferred from `$ref` properties',
        explanation:
          'JSON Schema has no foreign keys. A property that references another model is a foreign key (required means not null, `x-on-delete` sets the action and `x-related-name` names the reverse side); an array of models on one model and a reference back on the other is one relation seen from both sides; arrays on both sides are a many-to-many; two single references that point at each other are a one-to-one (the required side holds the key, with a warning when that is a guess). An array with no counterpart gets a nullable foreign key added to the other model, with a warning. A foreign key column keeps its name (`<relation>_id`) unless a scalar property such as `authorId` is declared next to the relation.',
      },
      {
        id: 'json-schema-types',
        title: 'Column types are guessed from `type` and `format`',
        explanation:
          'A string without `maxLength` and without a `format` is `text`; with `maxLength` it is a length-limited `string`. Integers are `int` unless `format` is `int64`; numbers are `float` unless `format` is `decimal` (precision and scale come from `x-precision` / `x-scale` or `multipleOf`). A column type the IR has no name for (unsigned, 16-bit, native database types) cannot be stated. Only string enums become enums; the other enums keep their plain type with a warning.',
      },
      {
        id: 'json-schema-keys',
        title: 'Keys, generated values and names',
        explanation:
          'The primary key is the `x-primary-key` property (several make a composite key), else `id`, else `<model>Id`; a model with none gets an integer `id` and a warning. `readOnly` marks a value the database generates: an integer key counts up, a uuid is generated, a date-time is set on insert (or on every save when the name starts with `updated`). A date-time `default` of `now` or `CURRENT_TIMESTAMP` is the current time. Table names are the model names unless `x-table-name` says otherwise.',
      },
      {
        id: 'json-schema-input',
        title: 'Input limits',
        explanation:
          'Only JSON is read (the package has no YAML parser, so a YAML OpenAPI document must be converted first). References are followed between the files that are given: `#/...` pointers, `#`, and `$id`- or path-relative references; remote references are never fetched and named anchors (`$anchor`, `$dynamicRef`) are not resolved. An unresolved reference keeps its property as a `json` column.',
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
      return cell.target === 'prisma' &&
        difference.before.startsWith('manyToMany')
        ? 'join-table'
        : undefined;
    case 'modelAdded':
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
    `Some formats can be written but not read (${targets.join(', ')}), so the matrix cannot re-read their output and compare IRs. For these it checks the written files against the IR instead: every model has a struct for its table, every column has a field, every many-to-many relation has its join table and every enum has its type. "Missing" lists what the check could not find; it is empty when the output covers the schema. What the format approximates or cannot express is listed below the table.`,
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

  for (const name of readOnly) {
    const readNotes: readonly LossReason[] = READ_ONLY_NOTES[name] ?? [];
    if (readNotes.length === 0) {
      continue;
    }
    lines.push(
      `## What ${name} cannot express`,
      '',
      `The cells above compare IRs, so they cannot show what is lost before the IR exists, when ${name} is read. These are the constructs the ${name} reader drops, approximates or has to guess; each case also produces a warning that names the model and property.`,
      ''
    );
    readNotes.forEach((note: LossReason, position: number): void => {
      lines.push(`${position + 1}. **${note.title}.** ${note.explanation}`);
    });
    lines.push('');
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
