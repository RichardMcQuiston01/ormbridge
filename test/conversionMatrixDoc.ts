import { fileURLToPath } from 'node:url';
import type { IrField, IrModel, IrSchema } from '../src/ir.js';
import type { MatrixCell } from './conversionMatrix.js';
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
      "In `preserve` naming mode the Prisma writer expands every many-to-many field with `expandManyToMany` (`src/transforms.ts`) into an explicit join model (`PostTags`) with a surrogate `id`, two cascading foreign keys and a unique pair. This mirrors the table Django creates, so existing Django databases stay compatible, and it avoids Prisma's implicit `_AToB` table. Prisma reads that model back as an ordinary model, so the relation `Post.tags` is not restored as a many-to-many. For TypeORM sources the join table is TypeORM's own, whose primary key is the composite of the two foreign keys, so the Prisma join model also gains a surrogate `id` column that the source table does not have.",
  },
  {
    id: 'doctrine-lifecycle-callback',
    title: 'Auto-updated timestamps become Doctrine lifecycle callbacks',
    explanation:
      'Doctrine has no attribute that refreshes a column on update (Django `auto_now`, Prisma `@updatedAt`, TypeORM `@UpdateDateColumn`). The Doctrine writer therefore adds `#[ORM\\HasLifecycleCallbacks]` and a `#[ORM\\PreUpdate]` method that sets the property. The Doctrine reader ignores lifecycle callbacks (it reads mapping attributes only), so the "updated automatically" flag is not recovered when the output is read back.',
  },
  {
    id: 'doctrine-constructor-default',
    title: 'UUID and JSON defaults are set in the Doctrine constructor',
    explanation:
      'Doctrine ORM 3 has no built-in UUID generator, and a column default for JSON or array columns is not portable, so the Doctrine writer assigns these defaults in the entity constructor (for example `$this->publicId = self::generateUuid();`). The Doctrine reader only sees the mapping attributes, not constructor statements, so these defaults are not recovered when the output is read back. Scalar defaults that can be written as a column option or property initializer survive.',
  },
  {
    id: 'django-enum-length-floor',
    title: 'Django enum columns are at least 32 characters',
    explanation:
      'The Django writer ignores the stored length of an enum-backed field and writes `max_length` as the longer of 32 and the longest enum value (`src/emitters/django.ts`). A length kept by another format (for example 20 in a Doctrine `length: 20` column) therefore becomes 32 once the schema passes through Django, which is why a second trip through Django is not stable for that field.',
  },
];

/** True when either end of the pair is the given format. */
function involves(cell: MatrixCell, format: string): boolean {
  return cell.source === format || cell.target === format;
}

/** Returns the id of the reason that explains a difference, or undefined when it is unexplained. */
export function explainDifference(
  difference: IrDifference,
  cell: MatrixCell
): string | undefined {
  const schema: IrSchema = cell.sourceSchema;
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
      return involves(cell, 'doctrine') &&
        difference.before === 'true' &&
        difference.after === 'false'
        ? 'doctrine-lifecycle-callback'
        : undefined;
    case 'fieldDefault':
      return involves(cell, 'doctrine') &&
        difference.after === '(none)' &&
        (difference.before === 'uuid' ||
          difference.before.startsWith('literal'))
        ? 'doctrine-constructor-default'
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

function summaryMatrix(cells: MatrixCell[], formats: string[]): string[] {
  const lines: string[] = [
    `| from \\ to | ${formats.join(' | ')} |`,
    `| --- | ${formats.map(() => '---').join(' | ')} |`,
  ];
  for (const source of formats) {
    const row: string[] = formats.map((target: string) =>
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
      `| ${pairLabel(cell)} | ${summaryCell(cell)} | ${cell.emitWarnings.length} | ${cell.reparseWarnings.length} | ${cell.idempotenceDifferences.length === 0 ? 'yes' : 'no'} |`
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

/** Renders the committed conversion matrix document. */
export function renderMatrixMarkdown(cells: MatrixCell[]): string {
  const formats: string[] = [];
  for (const cell of cells) {
    for (const name of [cell.source, cell.target]) {
      if (!formats.includes(name)) {
        formats.push(name);
      }
    }
  }
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
    `This page shows what survives a round trip between the formats ormbridge can both read and write (${formats.join(', ')}). It is generated from the canonical "blog" schema in \`test/fixtures/\`, so it describes the constructs that schema uses; the README's "Limitations and warnings" section lists constructs it does not cover.`,
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
    'Text goldens in `test/golden/` pin the exact output and the `roundtrip-*.drift.txt` files pin the textual drift; this page is the semantic view of the same conversions.',
    '',
    '## Summary',
    '',
    'Rows are the source format, columns the target. ✔ means the canonical schema comes back unchanged; ⚠ gives the number of structural differences.',
    '',
    ...summaryMatrix(cells, formats),
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
