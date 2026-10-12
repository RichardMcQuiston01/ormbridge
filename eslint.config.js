import eslint from '@eslint/js';
import prettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'dist',
      'node_modules',
      'test/fixtures',
      'test/golden/**/*.js',
      'test/golden-extras/**/*.js',
      'examples/*/models',
      'examples/*/generated',
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  prettier
);
