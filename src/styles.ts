import { EFCORE_STYLES, type EfcoreStyle } from './emitters/efcore.js';
import { JPA_STYLES, type JpaStyle } from './emitters/jpa.js';
import { SEQUELIZE_STYLES, type SequelizeStyle } from './emitters/sequelize.js';
import {
  SQLALCHEMY_STYLES,
  type SqlAlchemyStyle,
} from './emitters/sqlalchemy.js';
import { err, ok, type Result } from './result.js';

/** Every value `--style` accepts; which ones apply depends on the target format. */
export type OutputStyle =
  SqlAlchemyStyle | SequelizeStyle | EfcoreStyle | JpaStyle;

/** The output styles of the formats that have any, by format name. */
const STYLES_BY_FORMAT: Readonly<Record<string, readonly OutputStyle[]>> = {
  sqlalchemy: SQLALCHEMY_STYLES,
  sequelize: SEQUELIZE_STYLES,
  efcore: EFCORE_STYLES,
  jpa: JPA_STYLES,
};

/** Every style of every format, in the order the help lists them. */
export const OUTPUT_STYLES: readonly OutputStyle[] = [
  ...SQLALCHEMY_STYLES,
  ...SEQUELIZE_STYLES,
  ...EFCORE_STYLES,
  ...JPA_STYLES,
];

/** True when a value is a style of some format. */
export function isOutputStyle(value: string): value is OutputStyle {
  return (OUTPUT_STYLES as readonly string[]).includes(value);
}

/** The styles a target format accepts, or undefined when the format has none. */
export function stylesOf(format: string): readonly OutputStyle[] | undefined {
  return STYLES_BY_FORMAT[format];
}

/**
 * Checks a `--style` value against the target format. A format with styles accepts only its own
 * (`sqlalchemy`, `sqlmodel` for SQLAlchemy; `init`, `define` for Sequelize; `annotations`, `fluent` for EF Core; `jakarta`, `javax` for JPA). Any other format
 * ignores the option, so it accepts every known style but still rejects values nobody knows.
 */
export function checkStyle(
  format: string,
  value: string,
  label: string = '--style value'
): Result<OutputStyle> {
  const own: readonly OutputStyle[] | undefined = stylesOf(format);
  if (own !== undefined) {
    return own.includes(value as OutputStyle)
      ? ok(value as OutputStyle)
      : err(
          'INVALID_OPTION',
          `Invalid ${label} "${value}" for the ${format} format. Expected one of: ${own.join(', ')}.`
        );
  }
  return isOutputStyle(value)
    ? ok(value)
    : err(
        'INVALID_OPTION',
        `Invalid ${label} "${value}". Expected one of: ${OUTPUT_STYLES.join(', ')} (${Object.entries(
          STYLES_BY_FORMAT
        )
          .map(
            ([name, styles]: [string, readonly OutputStyle[]]) =>
              `${styles.join(', ')} for ${name}`
          )
          .join('; ')}).`
      );
}
