import type { KeyClassOptions } from './jpaKeyClass.js';
import type { FileLayout } from './jpaRender.js';
import type { EnumPlan, IdPart, JpaStyle, ModelPlan } from './jpaTypes.js';

/**
 * How the JPA emitter can be extended by an addon. A `JpaRenderer` writes the planned classes in another language
 * (the Kotlin addon), and `adjust` changes the plans before they are written and may add files of its own (the
 * Spring Data addon). Neither is reachable from the command line; both are options of `emitJpa`.
 */

/** Writes the files of the plan. Every method returns the whole text of one file, header and package included. */
export interface JpaRenderer {
  /** The extension of the files, with the dot (the Java renderer uses `.java`). */
  extension: string;
  /** An `@Entity` class (or one of the single-table and table-per-class subclasses). */
  entity: (plan: ModelPlan, layout: FileLayout) => string;
  /** An enum, with the stored value when the enum is written through a converter. */
  enumeration: (plan: EnumPlan, layout: FileLayout) => string;
  /** The `AttributeConverter` of an enum whose stored values differ from the constant names. */
  converter: (plan: EnumPlan, layout: FileLayout, style: JpaStyle) => string;
  /** The `@IdClass` or `@Embeddable` class of a composite primary key. */
  keyClass: (
    name: string,
    parts: readonly IdPart[],
    layout: FileLayout,
    options: KeyClassOptions & { style: JpaStyle }
  ) => string;
}

/** What `adjust` sees: every class the emitter is about to write. */
export interface JpaPlanned {
  /** The entity classes, the subclasses of single-table and table-per-class hierarchies included. */
  plans: readonly ModelPlan[];
  enums: readonly EnumPlan[];
  style: JpaStyle;
  layout: FileLayout;
  /** The extension of the files the renderer writes, with the dot, for the files `adjust` adds. */
  extension: string;
}

export interface JpaExtension {
  /** Replaces the Java renderer. */
  renderer?: JpaRenderer;
  /**
   * Called once after planning and before rendering. It may change the annotations, attributes and imports of the
   * plans; the files it returns (path relative to the output directory, to text) are added to the output.
   */
  adjust?: (planned: JpaPlanned) => Record<string, string>;
}
