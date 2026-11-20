import efcoreAddon from '../../packages/efcore/src/index.js';
import neo4jAddon from '../../packages/neo4j/src/index.js';
import phpAddon from '../../packages/php/src/index.js';
import gormAddon from '../../packages/gorm/src/index.js';
import grapheneAddon from '../../packages/graphene/src/index.js';
import { registerPlugin } from '../../src/plugins.js';

/**
 * Formats that moved into addon packages are still part of the product, so the core tests load them from the source
 * of the packages in this repository: the conversion goldens, the matrix and every test that converts through the
 * registry keep covering them. A test file that needs the format to be missing (the stub of core) unregisters it.
 */
for (const addon of [
  efcoreAddon,
  gormAddon,
  grapheneAddon,
  neo4jAddon,
  phpAddon,
]) {
  const registered = registerPlugin(addon);
  if (!registered.ok) {
    throw new Error(registered.error.message);
  }
}
