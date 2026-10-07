import { emitDjango } from './emitters/django.js';
import { emitPrisma, type EmitOutput, type PrismaProvider } from './emitters/prisma.js';
import type { IrSchema } from './ir.js';
import { parseDjango, type DjangoSourceFile } from './parsers/django.js';
import { parsePrisma, type PrismaSourceFile } from './parsers/prisma.js';
import { err, ok, type Result } from './result.js';
import { expandManyToMany, normalizeSchema, type NamingMode } from './transforms.js';

export type FormatName = 'django' | 'prisma';

export const FORMAT_NAMES: readonly FormatName[] = ['django', 'prisma'];

export interface ConvertOptions {
  from: FormatName;
  to: FormatName;
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

export interface SourceText {
  path: string;
  text: string;
  /** App label derived from the file location (Django input only). */
  appLabel?: string;
}

export interface ConvertResult {
  output: string;
  warnings: string[];
  modelCount: number;
}

export const DEFAULT_APP_LABEL: string = 'app';

/** Converts in-memory source text from one ORM format to another. */
export async function convertText(sources: SourceText[], options: ConvertOptions): Promise<Result<ConvertResult>> {
  if (options.from === options.to) {
    return err(
      'UNSUPPORTED_CONVERSION',
      `The source and target formats are both "${options.from}". Choose different values for --from and --to.`,
    );
  }
  if (sources.length === 0) {
    return err('NO_INPUT_FILES', 'No input sources were provided to convert.');
  }

  const parsed: Result<IrSchema> = await parseSources(sources, options);
  if (!parsed.ok) {
    return parsed;
  }

  const emitted: Result<EmitOutput> = emitSchema(parsed.value, options);
  if (!emitted.ok) {
    return emitted;
  }

  return ok({
    output: emitted.value.text,
    warnings: [...parsed.value.warnings, ...emitted.value.warnings],
    modelCount: parsed.value.models.length,
  });
}

async function parseSources(sources: SourceText[], options: ConvertOptions): Promise<Result<IrSchema>> {
  const fallbackLabel: string = options.appLabel ?? DEFAULT_APP_LABEL;
  if (options.from === 'django') {
    const djangoSources: DjangoSourceFile[] = sources.map((source: SourceText) => ({
      path: source.path,
      text: source.text,
      appLabel: options.appLabel ?? source.appLabel ?? DEFAULT_APP_LABEL,
    }));
    return parseDjango(djangoSources, { autoField: options.autoField });
  }
  const prismaSources: PrismaSourceFile[] = sources.map((source: SourceText) => ({
    path: source.path,
    text: source.text,
  }));
  return parsePrisma(prismaSources, { appLabel: fallbackLabel });
}

function emitSchema(schema: IrSchema, options: ConvertOptions): Result<EmitOutput> {
  if (options.to === 'prisma') {
    const prepared: IrSchema = options.naming === 'normalize' ? normalizeSchema(schema) : expandManyToMany(schema);
    return ok(
      emitPrisma(prepared, {
        provider: options.provider,
        header: options.header,
        camelFields: options.naming === 'normalize',
      }),
    );
  }
  if (options.to === 'django') {
    return ok(emitDjango(schema));
  }
  return err('UNSUPPORTED_CONVERSION', `Unsupported target format "${String(options.to)}".`);
}
