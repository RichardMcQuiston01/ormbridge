// Copies the tree-sitter grammars a package needs into its own `grammars` folder, so the package ships a few
// megabytes instead of the 50 MB of `tree-sitter-wasms`.
//
// Usage: node scripts/copy-grammars.mjs <output directory> <grammar name>...
// Example: node scripts/copy-grammars.mjs dist/grammars java python typescript
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';

const [outputArgument, ...names] = process.argv.slice(2);
if (outputArgument === undefined || names.length === 0) {
  console.error(
    'Usage: node scripts/copy-grammars.mjs <output directory> <grammar name>...'
  );
  process.exit(2);
}

const requireFromHere = createRequire(import.meta.url);
const output = resolve(outputArgument);
mkdirSync(output, { recursive: true });
for (const name of names) {
  const file = `tree-sitter-${name}.wasm`;
  let source;
  try {
    source = requireFromHere.resolve(`tree-sitter-wasms/out/${file}`);
  } catch {
    source = undefined;
  }
  if (source === undefined || !existsSync(source)) {
    console.error(`The grammar ${file} was not found in tree-sitter-wasms.`);
    process.exit(1);
  }
  copyFileSync(source, join(output, file));
  console.log(`copied ${file} to ${outputArgument}`);
}
