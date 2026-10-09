import {
  registerFormat,
  unregisterFormat,
  type FormatAdapter,
} from '../src/formats.js';
import type { IrSchema } from '../src/ir.js';
import { ok, type Result } from '../src/result.js';
import type { FormatEmitOutput } from '../src/formats.js';

/**
 * A test-only output format that returns a file map instead of one text: an
 * `index.txt` listing the models plus one `models/<Name>.txt` per model. It
 * stands in for the multi-file emitters the Laravel and Doctrine tracks will
 * add, and proves the multi-file path in io.ts and the CLI.
 */
export const MULTI_FILE_FORMAT: string = 'multifile';

export const multiFileAdapter: FormatAdapter = {
  name: MULTI_FILE_FORMAT,
  extensions: [],
  description: 'Test-only format that writes one file per model',
  emit: (schema: IrSchema): Result<FormatEmitOutput> => {
    const files: Record<string, string> = {
      'index.txt': `${schema.models.map((model) => model.name).join('\n')}\n`,
    };
    for (const model of schema.models) {
      files[`models/${model.name}.txt`] = `model ${model.name}\n`;
    }
    return ok({ files, warnings: ['multifile test warning'] });
  },
};

export function registerMultiFileFormat(): void {
  unregisterFormat(MULTI_FILE_FORMAT);
  registerFormat(multiFileAdapter);
}

export function unregisterMultiFileFormat(): void {
  unregisterFormat(MULTI_FILE_FORMAT);
}
