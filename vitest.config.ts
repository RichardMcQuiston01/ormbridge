import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      // The addon packages import "ormbridge"; in the tests that is the source of this repository.
      'ormbridge-kotlin': fileURLToPath(
        new URL('./packages/kotlin/src/index.ts', import.meta.url)
      ),
      ormbridge: fileURLToPath(new URL('./src/index.ts', import.meta.url)),
    },
  },
});
