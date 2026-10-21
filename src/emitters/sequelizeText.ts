/**
 * Text helpers the Sequelize writers share: the indentation, the line width the generated files keep to, and the
 * JavaScript string and object-literal spelling.
 */

export const INDENT: string = '  ';
export const MAX_LINE_WIDTH: number = 80;
export const IDENTIFIER_PATTERN: RegExp = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** A single-quoted JavaScript string (double-quoted when the text holds a single quote and no double quote). */
export function quote(value: string): string {
  const escaped: string = value
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r');
  if (value.includes("'") && !value.includes('"')) {
    return `"${escaped}"`;
  }
  return `'${escaped.replace(/'/g, "\\'")}'`;
}

export function compact(entries: (string | undefined)[]): string[] {
  return entries.filter((entry): entry is string => entry !== undefined);
}

/** `{ a, b }` on one line when it fits after `prefix`, otherwise one entry per line. */
export function objectLines(
  prefix: string,
  entries: string[],
  indent: string,
  suffix: string
): string[] {
  const inline: string = `${indent}${prefix}{ ${entries.join(', ')} }${suffix}`;
  if (entries.length === 0) {
    return [`${indent}${prefix}{}${suffix}`];
  }
  if (inline.length <= MAX_LINE_WIDTH) {
    return [inline];
  }
  return [
    `${indent}${prefix}{`,
    ...entries.map((entry: string) => `${indent}${INDENT}${entry},`),
    `${indent}}${suffix}`,
  ];
}
