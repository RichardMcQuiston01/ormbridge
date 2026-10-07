/** String casing and pluralization helpers. */

const UNCOUNTABLE_WORDS: ReadonlySet<string> = new Set([
  'series',
  'news',
  'species',
  'data',
  'media',
  'metadata',
  'status',
  'address',
  'access',
  'analysis',
]);

const IRREGULAR_PLURALS: Readonly<Record<string, string>> = {
  people: 'person',
  children: 'child',
  men: 'man',
  women: 'woman',
};

export function splitWords(input: string): string[] {
  const spaced: string = input
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
  return spaced.split(/[^A-Za-z0-9]+/).filter((word: string) => word.length > 0);
}

export function toSnakeCase(input: string): string {
  return splitWords(input)
    .map((word: string) => word.toLowerCase())
    .join('_');
}

export function toPascalCase(input: string): string {
  return splitWords(input)
    .map((word: string) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join('');
}

export function toCamelCase(input: string): string {
  const pascal: string = toPascalCase(input);
  return pascal.charAt(0).toLowerCase() + pascal.slice(1);
}

/** Singularizes the last word of a snake_case identifier using simple rules. */
export function singularize(snakeName: string): string {
  const parts: string[] = snakeName.split('_');
  const lastWord: string = parts[parts.length - 1] ?? '';
  parts[parts.length - 1] = singularizeWord(lastWord);
  return parts.join('_');
}

function singularizeWord(word: string): string {
  const lower: string = word.toLowerCase();
  if (UNCOUNTABLE_WORDS.has(lower)) {
    return word;
  }
  const irregular: string | undefined = IRREGULAR_PLURALS[lower];
  if (irregular !== undefined) {
    return irregular;
  }
  if (/ies$/.test(lower) && lower.length > 3) {
    return word.slice(0, -3) + 'y';
  }
  if (/(ss|us|is)$/.test(lower)) {
    return word;
  }
  if (/(x|ch|sh|ss)es$/.test(lower)) {
    return word.slice(0, -2);
  }
  if (/s$/.test(lower) && lower.length > 1) {
    return word.slice(0, -1);
  }
  return word;
}

/** Deterministic short hash used to keep generated database names within length limits. */
export function shortHash(input: string): string {
  let hash: number = 5381;
  for (let index: number = 0; index < input.length; index += 1) {
    hash = ((hash << 5) + hash + input.charCodeAt(index)) >>> 0;
  }
  return hash.toString(16).padStart(8, '0').slice(0, 6);
}

/** Truncates a database identifier to maxLength, appending a hash when shortened. */
export function limitIdentifier(identifier: string, maxLength: number): string {
  if (identifier.length <= maxLength) {
    return identifier;
  }
  const hash: string = shortHash(identifier);
  return `${identifier.slice(0, maxLength - hash.length - 1)}_${hash}`;
}
