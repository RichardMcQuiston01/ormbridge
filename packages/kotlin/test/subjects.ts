import type { JpaEmitOptions } from '../../../src/emitters/jpa.js';
import type { IrSchema } from '../../../src/ir.js';
import { kitchenSinkSchema } from '../../../test/gormFixtures.js';
import { jpaEdgesSchema } from '../../../test/jpaFixtures.js';
import { parseJpaExtra } from '../../../test/jpaSupport.js';

/** The schemas the Kotlin writer is checked with, and the JPA options each one is written with. */
export interface Subject {
  label: string;
  build: () => Promise<IrSchema>;
  options: Partial<JpaEmitOptions>;
  /** True when rows cannot be saved (a subclass column NOT NULL), so only the schema is compared. */
  schemaOnly?: boolean;
}

export const SUBJECTS: Subject[] = [
  {
    label: 'kitchen sink',
    build: () => Promise.resolve(kitchenSinkSchema()),
    options: {},
  },
  {
    label: 'jpa edges',
    build: () => Promise.resolve(jpaEdgesSchema()),
    options: {},
  },
  {
    label: 'composite keys (@IdClass)',
    build: () => parseJpaExtra('composite-keys'),
    options: {},
  },
  {
    label: 'composite keys (@EmbeddedId)',
    build: () => parseJpaExtra('composite-keys'),
    options: { keyMode: 'embedded' },
  },
  {
    label: 'embedded keys',
    build: () => parseJpaExtra('embedded-keys'),
    options: { keyMode: 'embedded' },
  },
  {
    label: 'joined inheritance',
    build: () => parseJpaExtra('inheritance-joined'),
    options: { inheritance: 'joined' },
  },
  {
    label: 'single-table inheritance',
    build: () => parseJpaExtra('inheritance-single'),
    options: { inheritance: 'all' },
    schemaOnly: true,
  },
  {
    label: 'table-per-class inheritance',
    build: () => parseJpaExtra('inheritance-table-per-class'),
    options: { inheritance: 'all' },
  },
  {
    label: 'embeddables',
    build: () => parseJpaExtra('embeddables'),
    options: {},
  },
  {
    label: 'many to many',
    build: () => parseJpaExtra('many-to-many'),
    options: {},
  },
  { label: 'types', build: () => parseJpaExtra('types'), options: {} },
];
