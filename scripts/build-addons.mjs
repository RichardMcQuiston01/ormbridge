// Builds every addon package in packages/: compiles its TypeScript and copies the tree-sitter grammars its package.json
// lists in "ormbridgeGrammars" into its dist/grammars folder. Packages build in alphabetical order, which puts
// ormbridge-kotlin (packages/kotlin) before ormbridge-spring-data (packages/spring-data), which needs its types.
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { URL, fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const packagesDirectory = join(root, 'packages');

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit' });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

/**
 * Links `ormbridge` (this checkout) and the other addons a package imports into its node_modules, so the built addon can
 * be loaded from this repository (the examples and the tests of the built CLI do). npm links nothing here, because the
 * packages are not workspaces. The folders are ignored by Git.
 */
function linkDependencies(name, manifest, directories) {
  const modules = join(packagesDirectory, name, 'node_modules');
  mkdirSync(modules, { recursive: true });
  const wanted = { ormbridge: root };
  for (const other of Object.keys(manifest.dependencies ?? {})) {
    if (directories[other] !== undefined) {
      wanted[other] = directories[other];
    }
  }
  for (const [linkName, target] of Object.entries(wanted)) {
    const link = join(modules, linkName);
    rmSync(link, { recursive: true, force: true });
    symlinkSync(target, link, 'dir');
  }
}

const directories = {};
for (const name of readdirSync(packagesDirectory)) {
  const manifestPath = join(packagesDirectory, name, 'package.json');
  if (existsSync(manifestPath)) {
    directories[JSON.parse(readFileSync(manifestPath, 'utf8')).name] = join(
      packagesDirectory,
      name
    );
  }
}

for (const name of readdirSync(packagesDirectory).sort()) {
  const directory = join(packagesDirectory, name);
  const manifestPath = join(directory, 'package.json');
  if (!existsSync(manifestPath)) {
    continue;
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  process.stdout.write(`building ${manifest.name}\n`);
  linkDependencies(name, manifest, directories);
  run('npx', ['tsc', '-p', join('packages', name, 'tsconfig.json')]);
  const grammars = manifest.ormbridgeGrammars ?? [];
  if (grammars.length > 0) {
    run('node', [
      'scripts/copy-grammars.mjs',
      join('packages', name, 'dist', 'grammars'),
      ...grammars,
    ]);
  }
}
