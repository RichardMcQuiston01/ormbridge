import { emitDjango } from './emitters/django.js';
import {
  emitPrisma,
  type EmitOutput,
  type PrismaProvider,
} from './emitters/prisma.js';
import { emitTypeorm } from './emitters/typeorm.js';
import type { IrSchema } from './ir.js';
import { parseDjango, type DjangoSourceFile } from './parsers/django.js';
import { parsePrisma, type PrismaSourceFile } from './parsers/prisma.js';
import { parseTypeorm } from './parsers/typeorm.js';
import { err, ok, type Result } from './result.js';
import {
  expandManyToMany,
  normalizeSchema,
  type NamingMode,
} from './transforms.js';

/** The name of a registered format. Valid names are whatever the registry currently holds. */
export type FormatName = string;

export const DEFAULT_APP_LABEL: string = 'app';

export interface SourceText {
  path: string;
  text: string;
  /** App label derived from the file location (Django input only). */
  appLabel?: string;
}

/** Options handed to every adapter. Each adapter reads only the fields that apply to it. */
export interface FormatOptions {
  /** "preserve" keeps existing database names; "normalize" applies a fresh-schema style. */
  naming: NamingMode;
  /** Prisma datasource provider; controls native column types such as @db.VarChar. */
  provider: PrismaProvider;
  /** Emit Prisma generator and datasource blocks. */
  header: boolean;
  /** Overrides the Django app label (otherwise derived from the models.py directory). */
  appLabel?: string;
  /** Primary key type used for Django models without an explicit key. */
  autoField: 'int' | 'bigInt';
}

/**
 * One ORM format. An adapter that omits `parse` can only be written (output
 * only); one that omits `emit` can only be read (input only).
 */
export interface FormatAdapter {
  /** Unique identifier used by --from / --to and the programmatic API. */
  name: string;
  /** File extensions (with the leading dot) used to infer this format from a path. */
  extensions: string[];
  /** One-line, human-readable summary shown by `ormbridge formats`. */
  description: string;
  /** Reads source text into the shared intermediate representation. */
  parse?: (
    sources: SourceText[],
    options: FormatOptions
  ) => Promise<Result<IrSchema>>;
  /** Writes the intermediate representation as source text. */
  emit?: (schema: IrSchema, options: FormatOptions) => Result<EmitOutput>;
}

const adapters: Map<string, FormatAdapter> = new Map<string, FormatAdapter>();

/** Adds an adapter to the registry. Fails when the name or an extension is already taken. */
export function registerFormat(adapter: FormatAdapter): Result<FormatAdapter> {
  if (adapter.name.trim() === '') {
    return err(
      'INVALID_OPTION',
      'A format adapter must have a non-empty name.'
    );
  }
  if (adapters.has(adapter.name)) {
    return err(
      'INVALID_OPTION',
      `The format "${adapter.name}" is already registered.`
    );
  }
  for (const extension of adapter.extensions) {
    const owner: FormatAdapter | undefined = getFormatByExtension(extension);
    if (owner !== undefined) {
      return err(
        'INVALID_OPTION',
        `The extension "${extension}" cannot be used by the format "${adapter.name}" because it is already used by "${owner.name}".`
      );
    }
  }
  adapters.set(adapter.name, adapter);
  return ok(adapter);
}

/** Removes an adapter from the registry. Returns false when the name was not registered. */
export function unregisterFormat(name: string): boolean {
  return adapters.delete(name);
}

/** Looks up a format by name. Returns a descriptive error that lists the valid names. */
export function getFormat(name: string): Result<FormatAdapter> {
  const adapter: FormatAdapter | undefined = adapters.get(name);
  if (adapter === undefined) {
    return err(
      'UNSUPPORTED_CONVERSION',
      `Unknown format "${name}". Expected one of: ${listFormatNames().join(', ')}.`
    );
  }
  return ok(adapter);
}

/** Returns the adapter that owns a file extension (for example ".py"), or undefined. */
export function getFormatByExtension(
  extension: string
): FormatAdapter | undefined {
  for (const adapter of adapters.values()) {
    if (adapter.extensions.includes(extension)) {
      return adapter;
    }
  }
  return undefined;
}

/** Returns every registered adapter in registration order. */
export function listFormats(): FormatAdapter[] {
  return [...adapters.values()];
}

/** Returns every registered format name in registration order. */
export function listFormatNames(): string[] {
  return [...adapters.keys()];
}

/** Builds the text printed by the `formats` command: one line per registered format. */
export function describeFormats(adapters: FormatAdapter[]): string {
  const nameWidth: number = Math.max(
    ...adapters.map((adapter: FormatAdapter) => adapter.name.length)
  );
  const lines: string[] = adapters.map((adapter: FormatAdapter): string => {
    const abilities: string[] = [];
    if (adapter.parse !== undefined) {
      abilities.push('read');
    }
    if (adapter.emit !== undefined) {
      abilities.push('write');
    }
    return (
      `${adapter.name.padEnd(nameWidth)}  ` +
      `extensions: ${adapter.extensions.join(', ') || '(none)'}  ` +
      `${abilities.join(' + ') || 'no read/write support'}  ` +
      adapter.description
    );
  });
  return `${lines.join('\n')}\n`;
}

const djangoAdapter: FormatAdapter = {
  name: 'django',
  extensions: ['.py'],
  description: 'Django models (models.py or a models/ package)',
  parse: (
    sources: SourceText[],
    options: FormatOptions
  ): Promise<Result<IrSchema>> => {
    const djangoSources: DjangoSourceFile[] = sources.map(
      (source: SourceText) => ({
        path: source.path,
        text: source.text,
        appLabel: options.appLabel ?? source.appLabel ?? DEFAULT_APP_LABEL,
      })
    );
    return parseDjango(djangoSources, { autoField: options.autoField });
  },
  emit: (schema: IrSchema): Result<EmitOutput> => ok(emitDjango(schema)),
};

const prismaAdapter: FormatAdapter = {
  name: 'prisma',
  extensions: ['.prisma'],
  description: 'Prisma schema (schema.prisma)',
  parse: (
    sources: SourceText[],
    options: FormatOptions
  ): Promise<Result<IrSchema>> => {
    const prismaSources: PrismaSourceFile[] = sources.map(
      (source: SourceText) => ({
        path: source.path,
        text: source.text,
      })
    );
    return Promise.resolve(
      parsePrisma(prismaSources, {
        appLabel: options.appLabel ?? DEFAULT_APP_LABEL,
      })
    );
  },
  emit: (schema: IrSchema, options: FormatOptions): Result<EmitOutput> => {
    const prepared: IrSchema =
      options.naming === 'normalize'
        ? normalizeSchema(schema)
        : expandManyToMany(schema);
    return ok(
      emitPrisma(prepared, {
        provider: options.provider,
        header: options.header,
        camelFields: options.naming === 'normalize',
      })
    );
  },
};

const typeormAdapter: FormatAdapter = {
  name: 'typeorm',
  // No extension is claimed: ".ts" is too generic to infer, so pass --from/--to typeorm.
  extensions: [],
  description: 'TypeORM entity classes (TypeScript)',
  parse: (
    sources: SourceText[],
    options: FormatOptions
  ): Promise<Result<IrSchema>> =>
    parseTypeorm(
      sources.map((source: SourceText) => ({
        path: source.path,
        text: source.text,
      })),
      { appLabel: options.appLabel ?? DEFAULT_APP_LABEL }
    ),
  emit: (schema: IrSchema, options: FormatOptions): Result<EmitOutput> => {
    const prepared: IrSchema =
      options.naming === 'normalize' ? normalizeSchema(schema) : schema;
    return ok(
      emitTypeorm(prepared, {
        provider: options.provider,
        camelFields: options.naming === 'normalize',
      })
    );
  },
};

// The built-in names and extensions are distinct, so these registrations cannot fail.
const builtIns: Result<FormatAdapter>[] = [
  registerFormat(djangoAdapter),
  registerFormat(prismaAdapter),
  registerFormat(typeormAdapter),
];
export const BUILT_IN_FORMAT_NAMES: readonly string[] = builtIns.flatMap(
  (registered: Result<FormatAdapter>) =>
    registered.ok ? [registered.value.name] : []
);
